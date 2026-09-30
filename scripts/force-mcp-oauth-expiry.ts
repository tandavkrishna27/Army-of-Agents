import { and, eq, sql } from "drizzle-orm";
import { companyMcpConnectors, createDb, type Db } from "../packages/db/src/index.js";
import {
  decodeOAuthBundle,
  deriveOAuthBundleKey,
  encodeOAuthBundle,
} from "../server/src/services/mcp-connector-oauth-bundle.js";
import { resolveConsentSecret } from "../server/src/services/mcp-connector-consent.js";
import {
  prepareMcpOAuthSecretVersion,
  secretService,
} from "../server/src/services/secrets.js";
import { insertActivity, publishActivity } from "../server/src/services/activity-log.js";
import {
  hasFlag,
  readRequiredFlag,
  resolveActiveDatabaseUrl,
} from "./mcp-oauth-operator-db.js";

async function main() {
  if (hasFlag("help")) {
    console.log(
      "Usage: pnpm oauth:force-expiry <connectorId> --company-id=<uuid> --expected-version=<n> [--apply --confirm=FORCE-OAUTH-EXPIRY] [--confirm-production]",
    );
    return;
  }
  const databaseUrl = resolveActiveDatabaseUrl();
  const connectorId = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (!connectorId) {
    throw new Error(
      "Usage: pnpm oauth:force-expiry <connectorId> --company-id=<uuid> --expected-version=<n> [--apply --confirm=FORCE-OAUTH-EXPIRY]",
    );
  }
  const companyId = readRequiredFlag("company-id");
  const expectedVersion = Number(readRequiredFlag("expected-version"));
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error("--expected-version must be a positive integer");
  }
  const apply = hasFlag("apply");
  if (apply && readRequiredFlag("confirm") !== "FORCE-OAUTH-EXPIRY") {
    throw new Error("Apply mode requires --confirm=FORCE-OAUTH-EXPIRY");
  }
  if (apply && process.env.NODE_ENV === "production" && !hasFlag("confirm-production")) {
    throw new Error("Production apply requires --confirm-production");
  }

  const db = createDb(databaseUrl);
  const connector = await db
    .select()
    .from(companyMcpConnectors)
    .where(
      and(
        eq(companyMcpConnectors.id, connectorId),
        eq(companyMcpConnectors.companyId, companyId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!connector?.catalogEntryId || !connector.oauthPolicyVersion) {
    throw new Error("Connector is not an identity-bound OAuth connector");
  }

  const secretName = `mcp:oauth:${connector.id}`;
  if (connector.secretRef !== secretName) {
    throw new Error("Connector secret binding does not match its immutable OAuth identity");
  }
  const secrets = secretService(db);
  const secret = await secrets.getByName(connector.companyId, secretName);
  if (!secret || secret.status !== "active") throw new Error("Active OAuth credential not found");
  const metadata = secret.providerMetadata && typeof secret.providerMetadata === "object"
    && !Array.isArray(secret.providerMetadata)
    ? secret.providerMetadata as Record<string, unknown>
    : null;
  if (
    secret.provider !== "local_encrypted" ||
    secret.managedMode !== "aoa_managed" ||
    metadata?.purpose !== "mcp_oauth" ||
    metadata.ownerConnectorId !== connector.id ||
    metadata.catalogEntryId !== connector.catalogEntryId ||
    metadata.oauthPolicyVersion !== connector.oauthPolicyVersion
  ) {
    throw new Error("OAuth credential ownership does not exactly match the connector");
  }
  if (secret.latestVersion !== expectedVersion) {
    throw new Error("Credential version changed; inspect the connector and retry with the current version");
  }
  if (!apply) {
    console.log(JSON.stringify({
      mode: "dry-run",
      connectorId: connector.id,
      companyId: connector.companyId,
      expectedSecretVersion: expectedVersion,
      wouldCreateVersion: expectedVersion + 1,
    }));
    return;
  }

  const context = {
    companyId: connector.companyId,
    connectorId: connector.id,
    catalogEntryId: connector.catalogEntryId,
    oauthPolicyVersion: connector.oauthPolicyVersion,
    secretName,
  };
  const raw = await secrets.resolveSecretValue(connector.companyId, secret.id, "latest", {
    consumerType: "system",
    consumerId: "oauth-broker",
    actorType: "system",
    configPath: `mcp.connector.${connector.id}`,
    mcpOAuthOwner: {
      connectorId: connector.id,
      catalogEntryId: connector.catalogEntryId,
      oauthPolicyVersion: connector.oauthPolicyVersion,
    },
  });
  const bundleKey = deriveOAuthBundleKey(resolveConsentSecret());
  const bundle = decodeOAuthBundle(raw, bundleKey, context);
  if (!bundle) throw new Error("Credential is not a valid context-bound OAuth v2 bundle");

  const expiredBundle = encodeOAuthBundle({ ...bundle, expiresAt: Date.now() - 1 }, bundleKey);
  const prepared = await prepareMcpOAuthSecretVersion({
    companyId: connector.companyId,
    value: expiredBundle,
    owner: {
      connectorId: connector.id,
      catalogEntryId: connector.catalogEntryId,
      oauthPolicyVersion: connector.oauthPolicyVersion,
    },
    expectedLatestVersion: secret.latestVersion,
  });

  const committed = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtext('aoa:mcp-oauth-v2-maintenance'))`,
    );
    const current = await tx
      .select({
        id: companyMcpConnectors.id,
        secretRef: companyMcpConnectors.secretRef,
        catalogEntryId: companyMcpConnectors.catalogEntryId,
        oauthPolicyVersion: companyMcpConnectors.oauthPolicyVersion,
      })
      .from(companyMcpConnectors)
      .where(
        and(
          eq(companyMcpConnectors.id, connector.id),
          eq(companyMcpConnectors.companyId, connector.companyId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!current || current.secretRef !== secretName) {
      throw new Error("Connector changed while forced expiry was being prepared");
    }
    if (
      current.catalogEntryId !== connector.catalogEntryId ||
      current.oauthPolicyVersion !== connector.oauthPolicyVersion
    ) {
      throw new Error("Connector OAuth identity changed while forced expiry was being prepared");
    }
    const updated = await secretService(txDb).commitPreparedMcpOAuthSecret(prepared, {
      userId: "oauth-force-expiry",
    });
    const activity = await insertActivity(txDb, {
      companyId: connector.companyId,
      actorType: "system",
      actorId: "oauth-force-expiry",
      action: "mcp_connector.oauth_expiry_forced",
      entityType: "mcp_connector",
      entityId: connector.id,
      details: {
        previousVersion: expectedVersion,
        forcedExpiryVersion: updated.latestVersion,
      },
    });
    return { updated, activity };
  });

  try {
    publishActivity(committed.activity);
  } catch {
    // The durable operator action succeeded; live-event delivery is best effort.
  }

  console.log(JSON.stringify({
    mode: "apply",
    connectorId: connector.id,
    companyId: connector.companyId,
    previousVersion: expectedVersion,
    forcedExpiryVersion: committed.updated.latestVersion,
  }));
}

void main().then(() => process.exit(0)).catch((error: unknown) => {
  // Surface the underlying DB/pg error (drizzle wraps it as `.cause`) so an
  // operator sees the real failure, not the generic "Failed query: insert ...".
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
  console.error((error instanceof Error ? error.message : "Forced expiry failed") + cause);
  process.exit(1);
});
