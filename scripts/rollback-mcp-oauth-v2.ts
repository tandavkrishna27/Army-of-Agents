import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  companyMcpConnectors,
  companySecrets,
  createDb,
  type Db,
} from "../packages/db/src/index.js";
import {
  insertActivity,
  publishActivity,
  type PreparedActivityEvent,
} from "../server/src/services/activity-log.js";
import { resolveAoaInstanceId } from "../server/src/home-paths.js";
import {
  hasFlag,
  readRequiredFlag,
  resolveActiveDatabaseUrl,
} from "./mcp-oauth-operator-db.js";

type Connector = typeof companyMcpConnectors.$inferSelect;
type Secret = typeof companySecrets.$inferSelect;

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isExactBrokerSecret(secret: Secret, connector: Connector): boolean {
  const metadata = metadataRecord(secret.providerMetadata);
  return (
    connector.source === "catalog" &&
    connector.catalogEntryId !== null &&
    connector.oauthPolicyVersion !== null &&
    connector.secretRef === `mcp:oauth:${connector.id}` &&
    secret.companyId === connector.companyId &&
    secret.name === connector.secretRef &&
    secret.provider === "local_encrypted" &&
    secret.managedMode === "aoa_managed" &&
    secret.providerConfigId === null &&
    secret.deletedAt === null &&
    metadata?.purpose === "mcp_oauth" &&
    metadata.ownerConnectorId === connector.id &&
    metadata.catalogEntryId === connector.catalogEntryId &&
    metadata.oauthPolicyVersion === connector.oauthPolicyVersion
  );
}

function parseScope(): { allCompanies: boolean; companyId: string | null } {
  const allCompanies = hasFlag("all-companies");
  const companyArg = process.argv.find((arg) => arg.startsWith("--company-id="));
  const companyId = companyArg?.slice("--company-id=".length).trim() || null;
  if (allCompanies === Boolean(companyId)) {
    throw new Error("Choose exactly one scope: --company-id=<uuid> or --all-companies");
  }
  return { allCompanies, companyId };
}

function emergencyPolicyCovers(connectors: Connector[]): boolean {
  if (process.env.AOA_MCP_CONNECTORS_ENABLED?.trim().toLowerCase() === "false") return true;
  const denied = new Set(
    (process.env.AOA_MCP_CONNECTOR_DENYLIST ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return connectors.every((connector) => denied.has(connector.serverName.toLowerCase()));
}

async function loadRollbackState(db: Db, companyId: string | null) {
  const scopedOAuthRows = await db
    .select()
    .from(companyMcpConnectors)
    .where(isNotNull(companyMcpConnectors.oauthPolicyVersion))
    .then((rows) => companyId ? rows.filter((row) => row.companyId === companyId) : rows);
  const identityMismatchIds = scopedOAuthRows
    .filter((connector) => connector.source !== "catalog" || !connector.catalogEntryId)
    .map((connector) => connector.id);
  const candidates = scopedOAuthRows.filter(
    (connector) => connector.source === "catalog" && connector.catalogEntryId !== null,
  );
  const candidateIds = new Set(candidates.map((connector) => connector.id));
  const secrets = await db.select().from(companySecrets).where(isNull(companySecrets.deletedAt));
  const exactSecrets = secrets.filter((secret) => {
    const ownerId = metadataRecord(secret.providerMetadata)?.ownerConnectorId;
    if (typeof ownerId !== "string" || !candidateIds.has(ownerId)) return false;
    const connector = candidates.find((item) => item.id === ownerId);
    return connector ? isExactBrokerSecret(secret, connector) : false;
  });
  const exactSecretOwners = new Set(
    exactSecrets.map((secret) => metadataRecord(secret.providerMetadata)?.ownerConnectorId),
  );
  const connectorsToChange = candidates.filter(
    (connector) =>
      connector.status !== "disabled" ||
      connector.secretRef !== null ||
      exactSecretOwners.has(connector.id),
  );
  return { candidates, identityMismatchIds, exactSecrets, exactSecretOwners, connectorsToChange };
}

async function main() {
  if (hasFlag("help")) {
    console.log(
      "Usage: pnpm oauth:rollback-v2 (--company-id=<uuid>|--all-companies --instance-id=<id>) [--apply --backup-confirmed --maintenance-confirmed --confirm=<phrase-or-instance-id>] [--verify] [--confirm-production]",
    );
    return;
  }
  const { allCompanies, companyId } = parseScope();
  const apply = hasFlag("apply");
  const verifyOnly = hasFlag("verify");
  if (apply && verifyOnly) throw new Error("Choose --apply or --verify, not both");
  const instanceId = resolveAoaInstanceId();
  if (allCompanies && readRequiredFlag("instance-id") !== instanceId) {
    throw new Error("--instance-id must exactly match the active AOA instance");
  }
  const expectedConfirmation = allCompanies ? instanceId : "ROLLBACK-MCP-OAUTH-V2";
  if (apply && readRequiredFlag("confirm") !== expectedConfirmation) {
    throw new Error(allCompanies
      ? "Fleet apply requires --confirm=<active-instance-id>"
      : "Apply mode requires --confirm=ROLLBACK-MCP-OAUTH-V2");
  }
  if (apply && !hasFlag("backup-confirmed")) {
    throw new Error("Apply mode requires a verified backup and --backup-confirmed");
  }
  if (apply && !hasFlag("maintenance-confirmed")) {
    throw new Error(
      "Apply mode requires --maintenance-confirmed after every server is drained or restarted fail-closed",
    );
  }
  if (apply && process.env.NODE_ENV === "production" && !hasFlag("confirm-production")) {
    throw new Error("Production apply requires --confirm-production");
  }

  const db = createDb(resolveActiveDatabaseUrl());
  const preview = await loadRollbackState(db, companyId);
  const { candidates, identityMismatchIds, exactSecrets, connectorsToChange } = preview;

  if (verifyOnly) {
    const unsafe = candidates.filter(
      (connector) => connector.status !== "disabled" || connector.secretRef !== null,
    );
    const result = {
      mode: "verify",
      scope: companyId ?? "all-companies",
      unsafeConnectorIds: unsafe.map((connector) => connector.id),
      unarchivedCredentialCount: exactSecrets.length,
      identityMismatchIds,
      ok: unsafe.length === 0 && exactSecrets.length === 0 && identityMismatchIds.length === 0,
    };
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (!apply) {
    console.log(JSON.stringify({
      mode: "dry-run",
      scope: companyId ?? "all-companies",
      connectorIdsToDisable: connectorsToChange.map((connector) => connector.id),
      credentialCountToArchive: exactSecrets.length,
      identityMismatchIds,
      emergencyPolicyReady: emergencyPolicyCovers(connectorsToChange),
    }));
    return;
  }

  if (!emergencyPolicyCovers(connectorsToChange)) {
    throw new Error(
      "Fail-closed preflight failed: set AOA_MCP_CONNECTORS_ENABLED=false or denylist every affected server name before rollback",
    );
  }
  if (identityMismatchIds.length > 0) {
    throw new Error("Refusing rollback because OAuth rows have an unexpected catalog identity");
  }

  const committed = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    // Normal OAuth start/callback/refresh transactions take the shared form of
    // this lock. Rollback takes it exclusively so no credential can be created
    // or refreshed across the destructive snapshot and commit.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('aoa:mcp-oauth-v2-maintenance'))`,
    );
    const live = await loadRollbackState(txDb, companyId);
    if (!emergencyPolicyCovers(live.connectorsToChange)) {
      throw new Error("Fail-closed policy changed while rollback was waiting for maintenance lock");
    }
    if (live.identityMismatchIds.length > 0) {
      throw new Error("OAuth connector identity changed while rollback was waiting for maintenance lock");
    }
    const now = new Date();
    const preparedEvents: PreparedActivityEvent[] = [];
    for (const connector of live.connectorsToChange) {
      const bindingPredicate = connector.secretRef === null
        ? isNull(companyMcpConnectors.secretRef)
        : eq(companyMcpConnectors.secretRef, connector.secretRef);
      const updated = await tx
        .update(companyMcpConnectors)
        .set({ status: "disabled", secretRef: null, updatedAt: now })
        .where(
          and(
            eq(companyMcpConnectors.id, connector.id),
            eq(companyMcpConnectors.companyId, connector.companyId),
            eq(companyMcpConnectors.source, "catalog"),
            eq(companyMcpConnectors.catalogEntryId, connector.catalogEntryId!),
            eq(companyMcpConnectors.oauthPolicyVersion, connector.oauthPolicyVersion!),
            bindingPredicate,
          ),
        )
        .returning({ id: companyMcpConnectors.id });
      if (updated.length !== 1) throw new Error("Connector identity changed during rollback");
      preparedEvents.push(await insertActivity(txDb, {
        companyId: connector.companyId,
        actorType: "system",
        actorId: "oauth-v2-rollback",
        action: "mcp_connector.oauth_v2_rolled_back",
        entityType: "mcp_connector",
        entityId: connector.id,
        details: { archived: live.exactSecretOwners.has(connector.id) },
      }));
    }
    for (const secret of live.exactSecrets) {
      const ownerId = metadataRecord(secret.providerMetadata)?.ownerConnectorId;
      const lockedSecret = await tx
        .select()
        .from(companySecrets)
        .where(and(eq(companySecrets.id, secret.id), eq(companySecrets.companyId, secret.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const owner = typeof ownerId === "string"
        ? live.connectorsToChange.find((connector) => connector.id === ownerId) ?? null
        : null;
      if (!lockedSecret || !owner || !isExactBrokerSecret(lockedSecret, owner)) {
        throw new Error("Credential ownership changed during rollback");
      }
      const archived = await tx
        .update(companySecrets)
        .set({ status: "deleted", deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(companySecrets.id, secret.id),
            eq(companySecrets.companyId, secret.companyId),
            eq(companySecrets.name, secret.name),
            eq(companySecrets.provider, "local_encrypted"),
            eq(companySecrets.managedMode, "aoa_managed"),
            isNull(companySecrets.providerConfigId),
            isNull(companySecrets.deletedAt),
          ),
        )
        .returning({ id: companySecrets.id });
      if (archived.length !== 1) throw new Error("Credential ownership changed during rollback");
    }
    return {
      events: preparedEvents,
      disabledConnectorIds: live.connectorsToChange.map((connector) => connector.id),
      archivedCredentialCount: live.exactSecrets.length,
    };
  });

  for (const event of committed.events) {
    try {
      publishActivity(event);
    } catch {
      // Durable rollback succeeded; live-event delivery is best effort.
    }
  }

  console.log(JSON.stringify({
    mode: "apply",
    scope: companyId ?? "all-companies",
    disabledConnectorIds: committed.disabledConnectorIds,
    archivedCredentialCount: committed.archivedCredentialCount,
  }));
}

void main().then(() => process.exit(process.exitCode ?? 0)).catch((error: unknown) => {
  // Surface the underlying DB/pg error (drizzle wraps it as `.cause`) so an
  // operator sees the real failure, not the generic "Failed query: insert ...".
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
  console.error((error instanceof Error ? error.message : "OAuth v2 rollback failed") + cause);
  process.exit(1);
});
