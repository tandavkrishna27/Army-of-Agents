import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import { applyPendingMigrations } from "../client.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const JOB_EVENTS_COLUMNS = [
  "id", "organization_id", "company_id", "job_id", "attempt_id", "attempt_number",
  "lease_id", "event_id", "sequence", "event_type", "fence_token", "event_digest",
  "event", "occurred_at", "created_at",
] as const;
const PROJECTION_COLUMNS = [
  "id", "organization_id", "company_id", "projection_kind", "source_identity",
  "source_digest", "job_id", "attempt_id", "source_fence", "status",
  "target_aggregate_id", "created_at", "applied_at",
  // JOB-011 (migration 0240) appended aggregate_kind (nullable discriminator across
  // approvals / agent_runtime_decisions / cost_events for the governed projection link).
  "aggregate_kind",
] as const;

const ORG = "e5000000-0000-4000-8000-000000000001";
const COMPANY = "e5000000-0000-4000-8000-000000000002";
const TARGET = "e5000000-0000-4000-8000-000000000003";
const WORKER = "e5000000-0000-4000-8000-000000000004";
const JOB = "e5000000-0000-4000-8000-000000000005";
const ATTEMPT = "e5000000-0000-4000-8000-000000000006";
const LEASE = "e5000000-0000-4000-8000-000000000007";
const AUTHORITY_KEY = `organization:${ORG}`;
const HASH = "a".repeat(64);

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Sql | null = null;
let setupError: unknown = null;

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === "string") reject(new Error("port allocation failed"));
        else resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

function database(): Sql {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
  if (!db) throw new Error("database was not initialized");
  return db;
}

async function seedFixtures(client: Sql): Promise<void> {
  await client`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'JOB-005 org', 'job-005-org')`;
  await client`INSERT INTO companies (id, organization_id, name, issue_prefix)
    VALUES (${COMPANY}, ${ORG}, 'JOB-005 company', 'J005')`;
  await client`INSERT INTO execution_targets
    (id, organization_id, slug, kind, trust_class, status, scope, target_authority_key, device_generation)
    VALUES (${TARGET}, ${ORG}, 'job-005-target', 'dedicated_worker', 'dedicated_tenant', 'active',
      'organization', ${AUTHORITY_KEY}, 1)`;
  await client`INSERT INTO workers
    (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
     device_thumbprint, device_generation, profile_hash, enrolled_at, label, status)
    VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'job-005-key',
      ${"1".repeat(64)}, 1, ${HASH}, clock_timestamp(), 'JOB-005 worker', 'enrolled')`;
  await client`INSERT INTO jobs (id, organization_id, company_id) VALUES (${JOB}, ${ORG}, ${COMPANY})`;
  await client`INSERT INTO job_attempts
    (id, organization_id, company_id, job_id, attempt_number, status, placement_disposition,
     placement_owner, placement_target_id, placement_target_class, placement_target_scope,
     placement_target_generation, placement_profile_hash, placement_provider_constraint_hash,
     placement_fallback_disposition, placement_reason_code, placement_mode,
     placement_lease_eligible, placement_input_digest, placement_policy_digest, placement_decided_at)
    VALUES (${ATTEMPT}, ${ORG}, ${COMPANY}, ${JOB}, 1, 'leased', 'selected', 'organization_dedicated',
      ${TARGET}, 'organization_dedicated', 'organization', 1, ${HASH}, ${HASH}, 'primary',
      'target_selected', 'active', true, ${HASH}, ${HASH}, clock_timestamp())`;
  await client`INSERT INTO leases
    (id, organization_id, company_id, job_id, attempt_id, attempt_number, worker_id, target_id,
     target_authority_key, target_generation, profile_hash, provider_constraint_hash, status, fence,
     ack_deadline, expires_at, activated_at)
    VALUES (${LEASE}, ${ORG}, ${COMPANY}, ${JOB}, ${ATTEMPT}, 1, ${WORKER}, ${TARGET},
      ${AUTHORITY_KEY}, 1, ${HASH}, ${HASH}, 'active', 'fence-005',
      clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '10 minutes',
      clock_timestamp())`;
}

async function insertEvent(client: Sql, overrides: { eventId: string; sequence: number; eventType?: string }): Promise<void> {
  await client`INSERT INTO job_events
    (organization_id, company_id, job_id, attempt_id, attempt_number, lease_id, event_id, sequence,
     event_type, fence_token, event_digest, event, occurred_at)
    VALUES (${ORG}, ${COMPANY}, ${JOB}, ${ATTEMPT}, 1, ${LEASE}, ${overrides.eventId},
      ${overrides.sequence}, ${overrides.eventType ?? "log"}, 'fence-005', ${HASH},
      ${client.json({ eventType: overrides.eventType ?? "log" })}, clock_timestamp())`;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-job-events-schema-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    const port = await allocatePort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    const url = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(url);
    db = postgres(url, { max: 2 });
    await seedFixtures(db);
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await db?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-005 event ledger + projection receipt schema",
  () => {
    it("splits generated 0234 tables from custom 0235 RLS with C14 guards", () => {
      const migrationNames = readdirSync(new URL("../migrations/", import.meta.url));
      const generated = migrationNames.filter((name) => /^0234_.*\.sql$/.test(name));
      const rls = migrationNames.filter((name) => /^0235_.*\.sql$/.test(name));
      expect.soft(generated).toHaveLength(1);
      expect.soft(rls).toHaveLength(1);
      if (generated.length !== 1 || rls.length !== 1) return;
      const generatedSql = readFileSync(new URL(`../migrations/${generated[0]}`, import.meta.url), "utf8");
      const rlsSql = readFileSync(new URL(`../migrations/${rls[0]}`, import.meta.url), "utf8");
      expect.soft(generatedSql).toContain('CREATE TABLE IF NOT EXISTS "job_events"');
      expect.soft(generatedSql).toContain('CREATE TABLE IF NOT EXISTS "job_projection_receipts"');
      expect.soft(generatedSql).toContain('CREATE INDEX IF NOT EXISTS "job_events_attempt_idx"');
      expect.soft(generatedSql).not.toContain("FORCE ROW LEVEL SECURITY");
      for (const table of ["job_events", "job_projection_receipts"]) {
        expect.soft(rlsSql).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO "aoa_app"`);
        expect.soft(rlsSql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
        expect.soft(rlsSql).toMatch(new RegExp(`REVOKE ALL ON "${table}" FROM "aoa_operator"`));
        expect.soft(rlsSql).toContain(`CREATE POLICY "${table}_tenant_isolation"`);
      }
      expect.soft(existsSync(new URL("../migrations/meta/0234_snapshot.json", import.meta.url))).toBe(true);
      expect.soft(existsSync(new URL("../migrations/meta/0235_snapshot.json", import.meta.url))).toBe(true);
    });

    it("stores the immutable event ledger columns with composite tenant FKs", async () => {
      const client = database();
      const columns = await client<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'job_events'
        ORDER BY ordinal_position`;
      expect.soft(columns.map((row) => row.column_name)).toEqual([...JOB_EVENTS_COLUMNS]);

      const fks = await client<{ definition: string }[]>`
        SELECT pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'job_events' AND con.contype = 'f'`;
      const defs = fks.map((row) => row.definition);
      expect.soft(defs).toContainEqual(expect.stringContaining(
        "FOREIGN KEY (organization_id, company_id, job_id, attempt_id) REFERENCES job_attempts(organization_id, company_id, job_id, id) ON DELETE CASCADE",
      ));
      expect.soft(defs).toContainEqual(expect.stringContaining(
        "FOREIGN KEY (organization_id, company_id, job_id, attempt_id, lease_id) REFERENCES leases(organization_id, company_id, job_id, attempt_id, id) ON DELETE CASCADE",
      ));
      // No redundant single-column parent FK (cross-tenant existence oracle, E2-F013).
      expect.soft(defs.some((d) => /FOREIGN KEY \((attempt_id|lease_id|company_id|job_id)\)/.test(d))).toBe(false);
    });

    it("stores the projection idempotency columns", async () => {
      const client = database();
      const columns = await client<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'job_projection_receipts'
        ORDER BY ordinal_position`;
      expect.soft(columns.map((row) => row.column_name)).toEqual([...PROJECTION_COLUMNS]);
    });

    it("enforces (org,event_id) and (org,attempt_id,sequence) uniqueness", async () => {
      const client = database();
      await client`DELETE FROM job_events`;
      const eventA = "e5000000-0000-4000-8000-0000000000a1";
      const eventB = "e5000000-0000-4000-8000-0000000000a2";
      await insertEvent(client, { eventId: eventA, sequence: 1 });

      // Same event id again → org/event unique violation.
      await expect(insertEvent(client, { eventId: eventA, sequence: 2 }))
        .rejects.toMatchObject({ code: "23505", constraint_name: "job_events_org_event_uq" });
      // Different event id, same (attempt, sequence) → org/attempt/seq unique violation.
      await expect(insertEvent(client, { eventId: eventB, sequence: 1 }))
        .rejects.toMatchObject({ code: "23505", constraint_name: "job_events_org_attempt_seq_uq" });
    });

    it("rejects an event whose parent attempt does not exist in the tenant", async () => {
      const client = database();
      const missing = "e5000000-0000-4000-8000-0000000000ff";
      await expect(client`INSERT INTO job_events
        (organization_id, company_id, job_id, attempt_id, attempt_number, lease_id, event_id, sequence,
         event_type, fence_token, event_digest, event, occurred_at)
        VALUES (${ORG}, ${COMPANY}, ${JOB}, ${missing}, 1, ${LEASE}, ${missing}, 1,
          'log', 'fence-005', ${HASH}, ${client.json({})}, clock_timestamp())`)
        .rejects.toMatchObject({ code: "23503", constraint_name: "job_events_attempt_fk" });
    });

    it("forces tenant RLS with aoa_app-only DML on both ledgers", async () => {
      const client = database();
      for (const table of ["job_events", "job_projection_receipts"]) {
        const [security] = await client<{
          rls: boolean; forced: boolean;
          app_select: boolean; app_insert: boolean; app_update: boolean; app_delete: boolean;
          operator_select: boolean; public_select: boolean;
        }[]>`
          SELECT rel.relrowsecurity AS rls, rel.relforcerowsecurity AS forced,
            has_table_privilege('aoa_app', ${table}, 'SELECT') AS app_select,
            has_table_privilege('aoa_app', ${table}, 'INSERT') AS app_insert,
            has_table_privilege('aoa_app', ${table}, 'UPDATE') AS app_update,
            has_table_privilege('aoa_app', ${table}, 'DELETE') AS app_delete,
            has_table_privilege('aoa_operator', ${table}, 'SELECT') AS operator_select,
            has_table_privilege('public', ${table}, 'SELECT') AS public_select
          FROM pg_class rel WHERE rel.relname = ${table}`;
        expect.soft(security, `${table} security`).toEqual({
          rls: true, forced: true,
          app_select: true, app_insert: true, app_update: true, app_delete: true,
          operator_select: false, public_select: false,
        });
        const policies = await client<{ roles: string[]; using_expression: string; check_expression: string }[]>`
          SELECT roles::text[] AS roles, qual AS using_expression, with_check AS check_expression
          FROM pg_policies WHERE schemaname = 'public' AND tablename = ${table}`;
        expect.soft(policies, `${table} policy`).toEqual([expect.objectContaining({ roles: ["aoa_app"] })]);
        expect.soft(policies[0]?.using_expression).toContain("aoa.organization_id");
        expect.soft(policies[0]?.check_expression).toContain("aoa.organization_id");
      }
    });

    it("gives aoa_app no-GUC denial and own-tenant visibility on the event ledger", async () => {
      const client = database();
      await client`DELETE FROM job_events`;
      await insertEvent(client, { eventId: "e5000000-0000-4000-8000-0000000000b1", sequence: 1 });

      const visible = await client.begin(async (tx) => {
        const query = tx as unknown as Sql;
        await query`SET LOCAL ROLE aoa_app`;
        const noGuc = await query<{ count: number }[]>`SELECT count(*)::int AS count FROM job_events`;
        await query`SELECT set_config('aoa.organization_id', ${ORG}, true)`;
        const own = await query<{ count: number }[]>`SELECT count(*)::int AS count FROM job_events`;
        return { noGuc: noGuc[0]?.count, own: own[0]?.count };
      });
      expect(visible).toEqual({ noGuc: 0, own: 1 });
    });
  },
);
