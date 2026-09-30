import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import {
  activityLog,
  applyPendingMigrations,
  companies,
  companyMcpConnectors,
  companySecrets,
  companySecretVersions,
  createDb,
  type Db,
} from "@armyofagents/db";
import {
  decodeOAuthBundle,
  deriveOAuthBundleKey,
  encodeOAuthBundle,
  type OAuthTokenBundlePayload,
} from "../services/mcp-connector-oauth-bundle.js";
import {
  prepareMcpOAuthSecretVersion,
  secretService,
} from "../services/secrets.js";

/**
 * Spawned-process coverage for the destructive OAuth operator commands. The
 * existing mcp-oauth-operator-cli.test.ts owns offline argument validation;
 * this suite proves the commands' database behavior against real PostgreSQL.
 *
 * Linux is authoritative: the suite boots a throwaway embedded cluster and a
 * boot/migration failure fails closed. Windows skips per Issue #114 because
 * embedded-postgres cannot reliably initialise in the deep runner worktree.
 */
type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

const TSX = fileURLToPath(
  new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)
);
const FORCE_EXPIRY = fileURLToPath(
  new URL("../../../scripts/force-mcp-oauth-expiry.ts", import.meta.url)
);
const ROLLBACK = fileURLToPath(
  new URL("../../../scripts/rollback-mcp-oauth-v2.ts", import.meta.url)
);
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MASTER_KEY = "11".repeat(32);
const CONSENT_SECRET = "operator-cli-integration-consent-secret";

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let databaseUrl = "";
let db: Db;
let previousMasterKey: string | undefined;
let previousConsentSecret: string | undefined;

function runCli(
  script: string,
  args: string[],
  env: Record<string, string> = {}
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [TSX, script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      // A successful command proves DATABASE_URL wins over the embedded fallback.
      AOA_EMBEDDED_POSTGRES_PORT: "1",
      AOA_SECRETS_MASTER_KEY: MASTER_KEY,
      BETTER_AUTH_SECRET: CONSENT_SECRET,
      ...env,
    },
  });
}

function jsonOutput(result: SpawnSyncReturns<string>): Record<string, unknown> {
  expect(result.error).toBeUndefined();
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
}

async function seedCompany(label: string) {
  const id = randomUUID();
  await db.insert(companies).values({
    id,
    name: `OAuth operator ${label}`,
    issuePrefix: `O${randomUUID()
      .replaceAll("-", "")
      .slice(0, 7)
      .toUpperCase()}`,
  });
  return id;
}

async function seedOAuthConnector(input: {
  companyId: string;
  label: string;
  source?: "catalog" | "byo";
  withSecret?: boolean;
}) {
  const connectorId = randomUUID();
  const catalogEntryId = `${input.label}-${randomUUID()}`;
  const secretName = `mcp:oauth:${connectorId}`;
  const source = input.source ?? "catalog";
  const [connector] = await db
    .insert(companyMcpConnectors)
    .values({
      id: connectorId,
      companyId: input.companyId,
      serverName: `${input.label}-${connectorId.slice(0, 8)}`.toLowerCase(),
      displayName: input.label,
      transport: "http",
      url: "https://mcp.notion.com/mcp",
      requiresSecret: true,
      source,
      catalogEntryId,
      oauthPolicyVersion: 1,
      secretRef: input.withSecret === false ? null : secretName,
      status: input.withSecret === false ? "needs_credentials" : "active",
    })
    .returning();

  if (input.withSecret === false)
    return { connector, secret: null, payload: null };

  const payload: OAuthTokenBundlePayload = {
    companyId: input.companyId,
    connectorId,
    catalogEntryId,
    oauthPolicyVersion: 1,
    secretName,
    accessToken: `access-${input.label}`,
    refreshToken: `refresh-${input.label}`,
    expiresAt: Date.now() + 3_600_000,
    issuer: "https://api.notion.com",
    tokenEndpoint: "https://api.notion.com/v1/oauth/token",
    clientId: `client-${input.label}`,
    redirectUri: "http://127.0.0.1:3100/api/mcp/connectors/oauth/callback",
    scopes: ["read_content"],
    resource: "https://mcp.notion.com/mcp",
  };
  const encoded = encodeOAuthBundle(
    payload,
    deriveOAuthBundleKey(CONSENT_SECRET)
  );
  const prepared = await prepareMcpOAuthSecretVersion({
    companyId: input.companyId,
    value: encoded,
    owner: { connectorId, catalogEntryId, oauthPolicyVersion: 1 },
    expectedLatestVersion: 0,
  });
  const secret = await secretService(db).commitPreparedMcpOAuthSecret(
    prepared,
    {
      userId: "operator-integration-seed",
    }
  );
  return { connector, secret, payload };
}

describe.skipIf(process.platform === "win32")(
  "MCP OAuth operator CLI database behavior (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-mcp-oauth-operator-integ-"));
      const port = await allocateEmbeddedPgPort();
      const { default: EmbeddedPostgres } = (await import(
        "embedded-postgres"
      )) as {
        default: EmbeddedPostgresCtor;
      };
      pg = new EmbeddedPostgres({
        databaseDir: join(dataDir, "db"),
        user: "test",
        password: "test",
        port,
        persistent: false,
        initdbFlags: ["--encoding=UTF8", "--locale=C"],
      });
      await pg.initialise();
      await pg.start();
      databaseUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
      await applyPendingMigrations(databaseUrl);
      db = createDb(databaseUrl);

      previousMasterKey = process.env.AOA_SECRETS_MASTER_KEY;
      previousConsentSecret = process.env.BETTER_AUTH_SECRET;
      process.env.AOA_SECRETS_MASTER_KEY = MASTER_KEY;
      process.env.BETTER_AUTH_SECRET = CONSENT_SECRET;
    }, 180_000);

    afterAll(async () => {
      if (previousMasterKey === undefined)
        delete process.env.AOA_SECRETS_MASTER_KEY;
      else process.env.AOA_SECRETS_MASTER_KEY = previousMasterKey;
      if (previousConsentSecret === undefined)
        delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previousConsentSecret;
      await pg?.stop();
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    });

    it("force-expiry dry-runs, fences the expected version, then appends an expired audited version", async () => {
      const companyId = await seedCompany("force expiry");
      const seeded = await seedOAuthConnector({
        companyId,
        label: "force-expiry",
      });
      const connectorId = seeded.connector.id;
      const baseArgs = [
        connectorId,
        `--company-id=${companyId}`,
        "--expected-version=1",
      ];

      const dryRun = runCli(FORCE_EXPIRY, baseArgs);
      expect(dryRun.status).toBe(0);
      expect(jsonOutput(dryRun)).toMatchObject({
        mode: "dry-run",
        connectorId,
        companyId,
        expectedSecretVersion: 1,
        wouldCreateVersion: 2,
      });
      expect(
        (
          await db
            .select()
            .from(companySecretVersions)
            .where(eq(companySecretVersions.secretId, seeded.secret!.id))
        ).length
      ).toBe(1);
      expect(
        (
          await db
            .select()
            .from(activityLog)
            .where(
              and(
                eq(activityLog.companyId, companyId),
                eq(activityLog.action, "mcp_connector.oauth_expiry_forced")
              )
            )
        ).length
      ).toBe(0);

      const wrongVersion = runCli(FORCE_EXPIRY, [
        connectorId,
        `--company-id=${companyId}`,
        "--expected-version=2",
      ]);
      expect(wrongVersion.status).toBe(1);
      expect(wrongVersion.stderr).toContain("Credential version changed");

      const applied = runCli(FORCE_EXPIRY, [
        ...baseArgs,
        "--apply",
        "--confirm=FORCE-OAUTH-EXPIRY",
      ]);
      expect(applied.status).toBe(0);
      expect(jsonOutput(applied)).toMatchObject({
        mode: "apply",
        connectorId,
        companyId,
        previousVersion: 1,
        forcedExpiryVersion: 2,
      });

      const [stored] = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, seeded.secret!.id));
      expect(stored.latestVersion).toBe(2);
      expect(stored.providerMetadata).toEqual(seeded.secret!.providerMetadata);
      const versions = await db
        .select()
        .from(companySecretVersions)
        .where(eq(companySecretVersions.secretId, seeded.secret!.id))
        .orderBy(asc(companySecretVersions.version));
      expect(
        versions.map((version) => [version.version, version.status])
      ).toEqual([
        [1, "previous"],
        [2, "current"],
      ]);
      const raw = await secretService(db).resolveSecretValue(
        companyId,
        seeded.secret!.id,
        "latest",
        {
          consumerType: "system",
          consumerId: "oauth-broker",
          actorType: "system",
          configPath: `mcp.connector.${connectorId}`,
          mcpOAuthOwner: {
            connectorId,
            catalogEntryId: seeded.connector.catalogEntryId!,
            oauthPolicyVersion: seeded.connector.oauthPolicyVersion!,
          },
        }
      );
      const decoded = decodeOAuthBundle(
        raw,
        deriveOAuthBundleKey(CONSENT_SECRET),
        {
          companyId,
          connectorId,
          catalogEntryId: seeded.connector.catalogEntryId!,
          oauthPolicyVersion: seeded.connector.oauthPolicyVersion!,
          secretName: seeded.connector.secretRef!,
        }
      );
      expect(decoded).not.toBeNull();
      expect(decoded).toMatchObject({
        accessToken: seeded.payload!.accessToken,
        refreshToken: seeded.payload!.refreshToken,
        issuer: seeded.payload!.issuer,
        tokenEndpoint: seeded.payload!.tokenEndpoint,
        scopes: seeded.payload!.scopes,
        resource: seeded.payload!.resource,
      });
      expect(decoded!.expiresAt).toBeLessThanOrEqual(Date.now());

      const activities = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "mcp_connector.oauth_expiry_forced")
          )
        );
      expect(activities).toHaveLength(1);
      expect(activities[0]!.details).toEqual({
        previousVersion: 1,
        forcedExpiryVersion: 2,
      });

      const repeated = runCli(FORCE_EXPIRY, [
        ...baseArgs,
        "--apply",
        "--confirm=FORCE-OAUTH-EXPIRY",
      ]);
      expect(repeated.status).toBe(1);
      expect(
        (
          await db
            .select()
            .from(companySecretVersions)
            .where(eq(companySecretVersions.secretId, seeded.secret!.id))
        ).length
      ).toBe(2);
      expect(
        (
          await db
            .select()
            .from(activityLog)
            .where(
              and(
                eq(activityLog.companyId, companyId),
                eq(activityLog.action, "mcp_connector.oauth_expiry_forced")
              )
            )
        ).length
      ).toBe(1);
    }, 90_000);

    it("rollback preserves non-exact collisions and other companies, audits once, verifies, and is idempotent", async () => {
      const companyId = await seedCompany("rollback target");
      const otherCompanyId = await seedCompany("rollback other scope");
      const target = await seedOAuthConnector({
        companyId,
        label: "rollback-target",
      });
      const other = await seedOAuthConnector({
        companyId: otherCompanyId,
        label: "rollback-other",
      });
      const collisionId = randomUUID();
      await db.insert(companySecrets).values({
        id: collisionId,
        companyId,
        name: `mcp:oauth:collision-${randomUUID()}`,
        key: "MCP_OAUTH_COLLISION",
        status: "active",
        managedMode: "aoa_managed",
        provider: "local_encrypted",
        latestVersion: 1,
        providerMetadata: {
          purpose: "mcp_oauth",
          ownerConnectorId: target.connector.id,
          catalogEntryId: target.connector.catalogEntryId,
          oauthPolicyVersion: target.connector.oauthPolicyVersion,
        },
      });

      const scope = `--company-id=${companyId}`;
      const dryRun = runCli(ROLLBACK, [scope]);
      expect(dryRun.status).toBe(0);
      expect(jsonOutput(dryRun)).toMatchObject({
        mode: "dry-run",
        scope: companyId,
        connectorIdsToDisable: [target.connector.id],
        credentialCountToArchive: 1,
        identityMismatchIds: [],
      });

      const verifyBefore = runCli(ROLLBACK, [scope, "--verify"]);
      expect(verifyBefore.status).toBe(2);
      expect(jsonOutput(verifyBefore)).toMatchObject({
        mode: "verify",
        ok: false,
        unsafeConnectorIds: [target.connector.id],
        unarchivedCredentialCount: 1,
      });

      const applied = runCli(
        ROLLBACK,
        [
          scope,
          "--apply",
          "--backup-confirmed",
          "--maintenance-confirmed",
          "--confirm=ROLLBACK-MCP-OAUTH-V2",
        ],
        { AOA_MCP_CONNECTORS_ENABLED: "false" }
      );
      expect(applied.status).toBe(0);
      expect(jsonOutput(applied)).toMatchObject({
        mode: "apply",
        scope: companyId,
        disabledConnectorIds: [target.connector.id],
        archivedCredentialCount: 1,
      });

      const [targetAfter] = await db
        .select()
        .from(companyMcpConnectors)
        .where(eq(companyMcpConnectors.id, target.connector.id));
      expect(targetAfter).toMatchObject({
        status: "disabled",
        secretRef: null,
      });
      const [targetSecretAfter] = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, target.secret!.id));
      expect(targetSecretAfter.status).toBe("deleted");
      expect(targetSecretAfter.deletedAt).toBeInstanceOf(Date);
      const [collisionAfter] = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, collisionId));
      expect(collisionAfter).toMatchObject({
        status: "active",
        deletedAt: null,
      });
      const [otherConnectorAfter] = await db
        .select()
        .from(companyMcpConnectors)
        .where(eq(companyMcpConnectors.id, other.connector.id));
      expect(otherConnectorAfter).toMatchObject({
        status: "active",
        secretRef: other.connector.secretRef,
      });
      const [otherSecretAfter] = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, other.secret!.id));
      expect(otherSecretAfter).toMatchObject({
        status: "active",
        deletedAt: null,
      });

      const rollbackActivities = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "mcp_connector.oauth_v2_rolled_back")
          )
        );
      expect(rollbackActivities).toHaveLength(1);
      expect(rollbackActivities[0]).toMatchObject({
        actorId: "oauth-v2-rollback",
        entityId: target.connector.id,
        details: { archived: true },
      });

      const verifyAfter = runCli(ROLLBACK, [scope, "--verify"]);
      expect(verifyAfter.status).toBe(0);
      expect(jsonOutput(verifyAfter)).toMatchObject({
        mode: "verify",
        ok: true,
        unsafeConnectorIds: [],
        unarchivedCredentialCount: 0,
      });

      const repeated = runCli(
        ROLLBACK,
        [
          scope,
          "--apply",
          "--backup-confirmed",
          "--maintenance-confirmed",
          "--confirm=ROLLBACK-MCP-OAUTH-V2",
        ],
        { AOA_MCP_CONNECTORS_ENABLED: "false" }
      );
      expect(repeated.status).toBe(0);
      expect(jsonOutput(repeated)).toMatchObject({
        disabledConnectorIds: [],
        archivedCredentialCount: 0,
      });
      expect(
        (
          await db
            .select()
            .from(activityLog)
            .where(
              and(
                eq(activityLog.companyId, companyId),
                eq(activityLog.action, "mcp_connector.oauth_v2_rolled_back")
              )
            )
        ).length
      ).toBe(1);
    }, 120_000);

    it("rollback refuses an identity mismatch before mutating any valid connector in the same scope", async () => {
      const companyId = await seedCompany("rollback atomicity");
      const valid = await seedOAuthConnector({
        companyId,
        label: "rollback-valid",
      });
      const malformed = await seedOAuthConnector({
        companyId,
        label: "rollback-malformed",
        source: "byo",
        withSecret: false,
      });
      const result = runCli(
        ROLLBACK,
        [
          `--company-id=${companyId}`,
          "--apply",
          "--backup-confirmed",
          "--maintenance-confirmed",
          "--confirm=ROLLBACK-MCP-OAUTH-V2",
        ],
        { AOA_MCP_CONNECTORS_ENABLED: "false" }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unexpected catalog identity");
      const [validAfter] = await db
        .select()
        .from(companyMcpConnectors)
        .where(eq(companyMcpConnectors.id, valid.connector.id));
      expect(validAfter).toMatchObject({
        status: "active",
        secretRef: valid.connector.secretRef,
      });
      const [secretAfter] = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, valid.secret!.id));
      expect(secretAfter).toMatchObject({ status: "active", deletedAt: null });
      const [malformedAfter] = await db
        .select()
        .from(companyMcpConnectors)
        .where(eq(companyMcpConnectors.id, malformed.connector.id));
      expect(malformedAfter).toMatchObject({
        source: "byo",
        status: "needs_credentials",
      });
      expect(
        (
          await db
            .select()
            .from(activityLog)
            .where(
              and(
                eq(activityLog.companyId, companyId),
                eq(activityLog.action, "mcp_connector.oauth_v2_rolled_back")
              )
            )
        ).length
      ).toBe(0);
    }, 90_000);

    it("rollback atomically restores connector and credential state when its audit insert fails", async () => {
      const companyId = await seedCompany("rollback transaction");
      const target = await seedOAuthConnector({
        companyId,
        label: "rollback-transaction",
      });
      await db.execute(
        sql.raw(`
        CREATE OR REPLACE FUNCTION fail_operator_rollback_activity()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'mcp_connector.oauth_v2_rolled_back' THEN
            RAISE EXCEPTION 'forced operator rollback activity failure';
          END IF;
          RETURN NEW;
        END;
        $$;
      `)
      );
      await db.execute(
        sql.raw(`
        CREATE TRIGGER fail_operator_rollback_activity_trigger
        BEFORE INSERT ON activity_log
        FOR EACH ROW EXECUTE FUNCTION fail_operator_rollback_activity();
      `)
      );

      try {
        const result = runCli(
          ROLLBACK,
          [
            `--company-id=${companyId}`,
            "--apply",
            "--backup-confirmed",
            "--maintenance-confirmed",
            "--confirm=ROLLBACK-MCP-OAUTH-V2",
          ],
          { AOA_MCP_CONNECTORS_ENABLED: "false" }
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "forced operator rollback activity failure"
        );

        const [connectorAfter] = await db
          .select()
          .from(companyMcpConnectors)
          .where(eq(companyMcpConnectors.id, target.connector.id));
        expect(connectorAfter).toMatchObject({
          status: "active",
          secretRef: target.connector.secretRef,
        });
        const [secretAfter] = await db
          .select()
          .from(companySecrets)
          .where(eq(companySecrets.id, target.secret!.id));
        expect(secretAfter).toMatchObject({
          status: "active",
          deletedAt: null,
        });
        expect(
          (
            await db
              .select()
              .from(activityLog)
              .where(
                and(
                  eq(activityLog.companyId, companyId),
                  eq(activityLog.action, "mcp_connector.oauth_v2_rolled_back")
                )
              )
          ).length
        ).toBe(0);
      } finally {
        await db.execute(
          sql.raw(
            "DROP TRIGGER IF EXISTS fail_operator_rollback_activity_trigger ON activity_log;"
          )
        );
        await db.execute(
          sql.raw("DROP FUNCTION IF EXISTS fail_operator_rollback_activity();")
        );
      }
    }, 90_000);
  }
);
