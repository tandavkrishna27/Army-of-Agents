import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  applyPendingMigrations,
  companyMcpConnectors,
  companySecrets,
  createDb,
  mcpConnectorOauthRefreshLeases,
  type Db,
} from "@armyofagents/db";
import {
  createDbRefreshCommitter,
  createDbRefreshLeaseStore,
  type OAuthRefreshContext,
} from "../mcp-connector-token-refresh.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
}) => EmbeddedPostgresInstance;

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("No test port available"));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

const suite = process.platform === "win32" ? describe.skip : describe;

suite("DB-backed OAuth refresh fencing", () => {
  let pg: EmbeddedPostgresInstance;
  let dataDir: string;
  let dbOne: Db;
  let dbTwo: Db;
  let previousMasterKey: string | undefined;
  const companyId = "10000000-0000-4000-8000-000000000001";
  const secretId = "20000000-0000-4000-8000-000000000001";

  beforeAll(async () => {
    previousMasterKey = process.env.AOA_SECRETS_MASTER_KEY;
    process.env.AOA_SECRETS_MASTER_KEY = "11".repeat(32);
    dataDir = await mkdtemp(join(tmpdir(), "aoa-oauth-refresh-lease-"));
    const port = await allocatePort();
    const { default: EmbeddedPostgres } = (await import(
      "embedded-postgres"
    )) as { default: EmbeddedPostgresCtor };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    const url = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(url);
    dbOne = createDb(url);
    dbTwo = createDb(url);
    await dbOne.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'Refresh Lease Co', 'RLC')
    `);
    await dbOne.execute(sql`
      INSERT INTO company_secrets (
        id, company_id, name, status, managed_mode, provider, latest_version
      ) VALUES (
        ${secretId}, ${companyId}, 'mcp:oauth:test', 'active', 'aoa_managed', 'local_encrypted', 1
      )
    `);
  }, 180_000);

  afterAll(async () => {
    if (previousMasterKey === undefined)
      delete process.env.AOA_SECRETS_MASTER_KEY;
    else process.env.AOA_SECRETS_MASTER_KEY = previousMasterKey;
    await pg?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  it("serializes two connections and fences acquired-vs-request_started expiry", async () => {
    const one = createDbRefreshLeaseStore(dbOne);
    const two = createDbRefreshLeaseStore(dbTwo);
    const base = new Date("2026-08-02T00:00:00.000Z");
    const first = await one.acquire({
      secretId,
      companyId,
      expectedSecretVersion: 1,
      ownerToken: "30000000-0000-4000-8000-000000000001",
      now: base,
      leaseMs: 20_000,
    });
    expect(first.outcome).toBe("acquired");
    const busy = await two.acquire({
      secretId,
      companyId,
      expectedSecretVersion: 1,
      ownerToken: "30000000-0000-4000-8000-000000000002",
      now: new Date(base.getTime() + 1_000),
      leaseMs: 20_000,
    });
    expect(busy.outcome).toBe("busy");

    await dbOne
      .update(mcpConnectorOauthRefreshLeases)
      .set({ leasedUntil: new Date(base.getTime() - 1) })
      .where(eq(mcpConnectorOauthRefreshLeases.secretId, secretId));
    const takeover = await two.acquire({
      secretId,
      companyId,
      expectedSecretVersion: 1,
      ownerToken: "30000000-0000-4000-8000-000000000002",
      now: base,
      leaseMs: 20_000,
    });
    expect(takeover.outcome).toBe("acquired");
    if (takeover.outcome !== "acquired") throw new Error("expected takeover");
    expect(takeover.lease.fencingToken).toBe(2);

    const started = await two.markRequestStarted(takeover.lease, base, 20_000);
    expect(started?.phase).toBe("request_started");
    await dbTwo
      .update(mcpConnectorOauthRefreshLeases)
      .set({ leasedUntil: new Date(base.getTime() - 1) })
      .where(eq(mcpConnectorOauthRefreshLeases.secretId, secretId));
    const indeterminate = await one.acquire({
      secretId,
      companyId,
      expectedSecretVersion: 1,
      ownerToken: "30000000-0000-4000-8000-000000000003",
      now: base,
      leaseMs: 20_000,
    });
    expect(indeterminate.outcome).toBe("indeterminate");
  });

  it("holds the connector row lock through refresh commit so disable serializes after rotation", async () => {
    const connectorId = "40000000-0000-4000-8000-000000000001";
    const refreshSecretId = "50000000-0000-4000-8000-000000000001";
    const ownerToken = "60000000-0000-4000-8000-000000000001";
    const secretName = `mcp:oauth:${connectorId}`;
    const context: OAuthRefreshContext = {
      companyId,
      connectorId,
      catalogEntryId: "notion-hosted",
      oauthPolicyVersion: 1,
      secretName,
      bundleKey: Buffer.alloc(32, 7),
      serverName: "notion",
    };

    await dbOne.insert(companyMcpConnectors).values({
      id: connectorId,
      companyId,
      serverName: "notion",
      displayName: "Notion",
      transport: "http",
      url: "https://mcp.notion.com/mcp",
      source: "catalog",
      catalogEntryId: "notion-hosted",
      oauthPolicyVersion: 1,
      secretRef: secretName,
      requiresSecret: true,
      status: "active",
    });
    await dbOne.insert(companySecrets).values({
      id: refreshSecretId,
      companyId,
      name: secretName,
      status: "active",
      managedMode: "aoa_managed",
      provider: "local_encrypted",
      latestVersion: 1,
      providerMetadata: {
        purpose: "mcp_oauth",
        ownerConnectorId: connectorId,
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
      },
    });
    const lease = await dbOne
      .insert(mcpConnectorOauthRefreshLeases)
      .values({
        secretId: refreshSecretId,
        companyId,
        ownerToken,
        fencingToken: 1,
        expectedSecretVersion: 1,
        phase: "request_started",
        requestStartedAt: new Date(),
        leasedUntil: new Date(Date.now() + 60_000),
      })
      .returning()
      .then((rows) => rows[0]!);

    const triggerLock = 914_317;
    await dbOne.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION block_oauth_refresh_secret_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${triggerLock});
        RETURN NEW;
      END;
      $$;
    `)
    );
    await dbOne.execute(
      sql.raw(`
      CREATE TRIGGER block_oauth_refresh_secret_update_trigger
      BEFORE UPDATE ON company_secrets
      FOR EACH ROW
      WHEN (OLD.id = '${refreshSecretId}'::uuid)
      EXECUTE FUNCTION block_oauth_refresh_secret_update();
    `)
    );

    let releaseHolder!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      holderReady = resolve;
    });
    const holder = dbTwo.transaction(async (tx) => {
      await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${triggerLock})`));
      holderReady();
      await release;
    });

    try {
      await ready;
      const commitPromise = createDbRefreshCommitter(
        dbOne,
        context
      )({
        lease: {
          secretId: lease.secretId,
          companyId: lease.companyId,
          ownerToken: lease.ownerToken,
          fencingToken: lease.fencingToken,
          expectedSecretVersion: lease.expectedSecretVersion,
          phase: "request_started",
          leasedUntil: lease.leasedUntil,
        },
        signedBundle: "signed-refresh-bundle",
        oldSecretVersion: 1,
      });

      const deadline = Date.now() + 5_000;
      while (true) {
        const result = (await dbTwo.execute(sql`
          SELECT count(*)::int AS count
          FROM pg_locks
          WHERE locktype = 'advisory' AND granted = false
        `)) as unknown as
          | { rows?: Array<{ count: number }> }
          | Array<{ count: number }>;
        const rows = Array.isArray(result) ? result : result.rows ?? [];
        if (Number(rows[0]?.count ?? 0) > 0) break;
        if (Date.now() >= deadline)
          throw new Error("refresh did not reach the commit barrier");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      let disableSettled = false;
      const disable = dbTwo
        .update(companyMcpConnectors)
        .set({ status: "disabled" })
        .where(eq(companyMcpConnectors.id, connectorId))
        .then(() => {
          disableSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(disableSettled).toBe(false);

      releaseHolder();
      await holder;
      await expect(commitPromise).resolves.toEqual({
        committed: true,
        newVersion: 2,
      });
      await disable;

      const connector = await dbOne
        .select()
        .from(companyMcpConnectors)
        .where(eq(companyMcpConnectors.id, connectorId))
        .then((rows) => rows[0]);
      expect(connector.status).toBe("disabled");
      const secret = await dbOne
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, refreshSecretId))
        .then((rows) => rows[0]);
      expect(secret.latestVersion).toBe(2);
      const activities = await dbOne
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "mcp_connector.oauth_refreshed")
          )
        );
      expect(activities).toHaveLength(1);
    } finally {
      releaseHolder();
      await holder.catch(() => {});
      await dbOne.execute(
        sql.raw(
          "DROP TRIGGER IF EXISTS block_oauth_refresh_secret_update_trigger ON company_secrets;"
        )
      );
      await dbOne.execute(
        sql.raw("DROP FUNCTION IF EXISTS block_oauth_refresh_secret_update();")
      );
    }
  }, 120_000);
});
