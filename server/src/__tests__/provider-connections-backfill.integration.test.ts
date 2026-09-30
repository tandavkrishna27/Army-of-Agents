// server/src/__tests__/provider-connections-backfill.integration.test.ts
//
// Real ON CONFLICT idempotency needs a real DB, so this is an embedded-pg
// integration test: it runs on Linux CI and is SKIPPED on Windows CI per the
// platform matrix (Issue #114). No `withTestDb`/`seedCompany`/… helpers exist in
// this repo, so it boots embedded-postgres inline (mirroring
// provider-readiness-upsert.integration.test.ts) and seeds via SQL.
//
// M4 exclusion — real-schema adaptation: the plan's "seed a NULL executionTargetId
// row" is structurally impossible here, because provider_credentials.owner_user_id
// AND execution_target_id are BOTH declared NOT NULL (provider_credentials.ts:18,21)
// — the DB would reject the insert. The exclusion the backfill WHERE actually
// enforces is the binding gate: a verified subscription whose binding is NOT
// approved is excluded. That is what the "excluded" row below proves (inserted
// does NOT count it, errors stays 0).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { companies, providerAssignments, providerConnections } from "@armyofagents/db";
import { runProviderConnectionsBackfill } from "../services/provider-connections-backfill.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

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
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as { id: string })?.id;
  return (result as { rows?: Array<{ id: string }> }).rows?.[0]?.id ?? "";
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-provider-connections-backfill-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore cleanup failures */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup failures */
  }
}, 60_000);

/** Empty every table these tests touch so each case is independent (there is no
 *  per-test fresh DB helper). CASCADE from companies + "user" clears all the FK
 *  dependents (secrets, agents, credentials, bindings, connections, assignments). */
async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE companies, "user" RESTART IDENTITY CASCADE`);
  // TRUNCATE ... CASCADE on "user" also truncates organizations (it references
  // "user" via created_by_user_id), which wipes the 0188 sentinel default org.
  // seedCompany relies on companies.organization_id defaulting to that sentinel,
  // so re-seed it here — otherwise the next insert hits FK violation 23503.
  await db.execute(sql`
    INSERT INTO organizations (id, name, slug, status, plan)
    VALUES ('00000000-0000-0000-0000-000000000001', 'Default Organization', 'default', 'active', 'beta')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function seedCompany(name: string, prefix: string): Promise<string> {
  return firstId(
    await db.execute<{ id: string }>(sql`
      INSERT INTO companies (organization_id, id, name, issue_prefix)
      VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), ${name}, ${prefix})
      RETURNING id
    `),
  );
}

async function seedUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES (${id}, ${"Owner " + id}, ${id + "@backfill.test"}, now(), now())
  `);
}

async function seedAgent(companyId: string, name: string): Promise<string> {
  return firstId(
    await db.execute<{ id: string }>(sql`
      INSERT INTO agents (id, company_id, name)
      VALUES (gen_random_uuid(), ${companyId}, ${name})
      RETURNING id
    `),
  );
}

async function seedProviderKeySecret(companyId: string, providerId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO company_secrets (id, company_id, name)
    VALUES (gen_random_uuid(), ${companyId}, ${"provider:" + providerId})
  `);
}

/** Seed a verified personal_subscription credential + a binding. `approved`
 *  toggles whether the binding qualifies (approved + unrevoked) or is excluded. */
async function seedVerifiedSubscription(opts: {
  companyId: string;
  provider: string;
  ownerUserId: string;
  executionTargetId: string;
  agentId: string;
  approved: boolean;
}): Promise<void> {
  const credId = firstId(
    await db.execute<{ id: string }>(sql`
      INSERT INTO provider_credentials
        (id, company_id, provider, owner_user_id, execution_target_id, kind, state)
      VALUES
        (gen_random_uuid(), ${opts.companyId}, ${opts.provider}, ${opts.ownerUserId},
         ${opts.executionTargetId}, 'personal_subscription', 'verified')
      RETURNING id
    `),
  );
  await db.execute(sql`
    INSERT INTO agent_provider_credential_bindings
      (id, company_id, agent_id, credential_id, approved_at, revoked_at)
    VALUES
      (gen_random_uuid(), ${opts.companyId}, ${opts.agentId}, ${credId},
       ${opts.approved ? sql`now()` : sql`NULL`}, NULL)
  `);
}

describe.skipIf(process.platform === "win32")("runProviderConnectionsBackfill (DB)", () => {
  it("runs TWICE: first backfills, second inserts 0 with assignments still linked; excludes an unapproved subscription", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    await reset();

    const companyId = await seedCompany("Backfill Co", "BFC");
    await seedUser("u1");
    const ag1 = await seedAgent(companyId, "Scout");
    const ag2 = await seedAgent(companyId, "Ranger");

    await seedProviderKeySecret(companyId, "anthropic"); // provider:anthropic secret
    await seedVerifiedSubscription({
      companyId,
      provider: "anthropic",
      ownerUserId: "u1",
      executionTargetId: "t1",
      agentId: ag1,
      approved: true,
    });
    // Excluded row (M4-spirit): a verified subscription whose binding is NOT
    // approved must be skipped by the backfill query — NOT counted as inserted,
    // and it must NOT raise an error.
    await seedVerifiedSubscription({
      companyId,
      provider: "openai",
      ownerUserId: "u1",
      executionTargetId: "t2",
      agentId: ag2,
      approved: false,
    });

    const first = await runProviderConnectionsBackfill(db);
    expect(first.inserted).toBe(2); // one api_key + one personal_subscription (NOT the unapproved openai sub)
    expect(first.errors).toBe(0);

    // Org-scoping proof (NOT just idempotency): provider_connections_identity_uq
    // is NULLS NOT DISTINCT, so an all-NULL organization_id would ALSO look
    // idempotent — a re-run would still insert 0. Assert the backfill stamped the
    // SAME org the seeded company carries (companies.organization_id), proving the
    // derive-from-owning-company contract rather than a NULL. Derive the expected
    // id from the seeded company row (do not hardcode the sentinel literal).
    const [companyRow] = await db
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    const expectedOrgId = companyRow!.organizationId;
    const firstConns = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.companyId, companyId));
    expect(firstConns).toHaveLength(2);
    for (const c of firstConns) expect(c.organizationId).toBe(expectedOrgId);
    const firstAsns = await db
      .select()
      .from(providerAssignments)
      .where(eq(providerAssignments.companyId, companyId));
    expect(firstAsns.length).toBeGreaterThan(0);
    for (const a of firstAsns) expect(a.organizationId).toBe(expectedOrgId);

    const second = await runProviderConnectionsBackfill(db);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.errors).toBe(0);

    const conns = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.companyId, companyId));
    expect(conns).toHaveLength(2); // no duplicates on the second run
    // The excluded (unapproved) subscription never became a connection.
    expect(conns.some((c) => c.provider === "openai")).toBe(false);

    const asns = await db
      .select()
      .from(providerAssignments)
      .where(eq(providerAssignments.companyId, companyId));
    // Every assignment links a real connection.
    for (const a of asns) expect(conns.some((c) => c.id === a.connectionId)).toBe(true);
  });

  it("a pre-existing connection is skipped, not duplicated, and its assignment still links", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    await reset();

    const companyId = await seedCompany("Backfill Co 2", "BF2");
    await seedProviderKeySecret(companyId, "anthropic");

    // First run mints the api_key connection.
    await runProviderConnectionsBackfill(db);
    const before = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.companyId, companyId));
    expect(before).toHaveLength(1);

    const again = await runProviderConnectionsBackfill(db);
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(1);
    const after = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.companyId, companyId));
    expect(after).toHaveLength(1); // still exactly one
  });
});
