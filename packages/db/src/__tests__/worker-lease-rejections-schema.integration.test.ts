import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import { applyPendingMigrations } from "../client.js";
import * as dbClient from "../client.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const EXPECTED_COLUMNS = [
  "organization_id", "company_id", "job_id", "attempt_id", "worker_id", "target_id",
  "target_authority_key", "eligibility_version", "static_context_hash", "workload_type",
  "placement_owner", "placement_target_class", "placement_target_scope",
  "placement_target_generation", "placement_profile_hash",
  "placement_provider_constraint_hash", "placement_input_digest", "placement_policy_digest",
  "reason_code", "created_at", "updated_at",
] as const;

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

async function replayMigration(client: Sql, fileName: string): Promise<void> {
  const source = readFileSync(new URL(`../migrations/${fileName}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    await client.unsafe(statement);
  }
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-worker-lease-rejections-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
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
  "JOB-003 static lease-rejection certificate schema",
  () => {
    it("derives the strict checked-in migration identity in journal order without trusting database serial IDs", async () => {
      // Mutation caught: deleting the owner-produced identity export, sorting by filename/DB id,
      // or hashing a partial ledger must change this hand-derived result.
      const loadRequiredMigrationIdentity = (dbClient as Record<string, unknown>)
        .loadRequiredMigrationIdentity;
      expect(typeof loadRequiredMigrationIdentity).toBe("function");
      if (typeof loadRequiredMigrationIdentity !== "function") return;

      const journal = JSON.parse(
        readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
      ) as { entries?: Array<{ idx?: number; tag?: string }> };
      const orderedPaths = (journal.entries ?? []).map((entry) => `${entry.tag}.sql`);
      const orderedHashes = orderedPaths.map((path) => createHash("sha256")
        .update(readFileSync(new URL(`../migrations/${path}`, import.meta.url)))
        .digest("hex"));
      const ledgerSha256 = createHash("sha256")
        .update(JSON.stringify(orderedHashes))
        .digest("hex");

      const identity = await (loadRequiredMigrationIdentity as () => Promise<{
        orderedHashes: readonly string[];
        ledgerSha256: string;
      }>)();
      expect(identity).toEqual({ orderedHashes, ledgerSha256 });
      expect(new Set(identity.orderedHashes).size).toBe(identity.orderedHashes.length);
      expect(identity.ledgerSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("uses split generated 0229/0230 plus custom 0231 with C14 and mixed-direction index replacement", async () => {
      const migrationNames = readdirSync(new URL("../migrations/", import.meta.url));
      const m0229 = migrationNames.filter((name) => /^0229_.*\.sql$/.test(name));
      const m0230 = migrationNames.filter((name) => /^0230_.*\.sql$/.test(name));
      const m0231 = migrationNames.filter((name) => /^0231_.*\.sql$/.test(name));
      expect.soft(m0229).toHaveLength(1);
      expect.soft(m0230).toHaveLength(1);
      expect.soft(m0231).toHaveLength(1);
      if (m0229.length !== 1 || m0230.length !== 1 || m0231.length !== 1) return;

      const parent = readFileSync(new URL(`../migrations/${m0229[0]}`, import.meta.url), "utf8");
      const generated = readFileSync(new URL(`../migrations/${m0230[0]}`, import.meta.url), "utf8");
      const rls = readFileSync(new URL(`../migrations/${m0231[0]}`, import.meta.url), "utf8");
      expect.soft(parent).toContain("workers_org_id_authority_target_uq");
      expect.soft(parent).toContain("duplicate_object");
      expect.soft(parent).not.toContain("worker_lease_rejections");
      expect.soft(generated).toContain('CREATE TABLE IF NOT EXISTS "worker_lease_rejections"');
      expect.soft(generated).toContain('DROP INDEX IF EXISTS "jobs_claim_idx"');
      expect.soft(generated).toMatch(/CREATE INDEX IF NOT EXISTS "jobs_claim_idx"[\s\S]*"priority" DESC/);
      expect.soft(generated).toContain('CREATE INDEX IF NOT EXISTS "job_attempts_lease_candidate_idx"');
      expect.soft(rls).toMatch(/REVOKE ALL ON(?: TABLE)? "worker_lease_rejections" FROM PUBLIC/);
      expect.soft(rls).toMatch(/REVOKE ALL ON(?: TABLE)? "worker_lease_rejections" FROM "aoa_operator"/);
      expect.soft(rls).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON(?: TABLE)? "worker_lease_rejections" TO "aoa_app"/);
      expect.soft(rls).toContain('ALTER TABLE "worker_lease_rejections" FORCE ROW LEVEL SECURITY');
      const rlsStatements = rls.split("--> statement-breakpoint").map((statement) => statement
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim())
        .filter(Boolean);
      const normalizeStatement = (statement: string): string => statement.replace(/\s+/g, " ").trim();
      const expectedCustomStatements = [
        'REVOKE ALL ON "worker_lease_rejections" FROM PUBLIC;',
        'REVOKE ALL ON "worker_lease_rejections" FROM "aoa_operator";',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON "worker_lease_rejections" TO "aoa_app";',
        'ALTER TABLE "worker_lease_rejections" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "worker_lease_rejections" FORCE ROW LEVEL SECURITY;',
        'DROP POLICY IF EXISTS "worker_lease_rejections_tenant_isolation" ON "worker_lease_rejections";',
        'CREATE POLICY "worker_lease_rejections_tenant_isolation" ON "worker_lease_rejections" TO "aoa_app" USING (organization_id = current_setting(\'aoa.organization_id\', true)::uuid) WITH CHECK (organization_id = current_setting(\'aoa.organization_id\', true)::uuid);',
      ];
      expect.soft(rlsStatements.map(normalizeStatement)).toEqual(expectedCustomStatements);
      const withUnauthorizedTail = [...rlsStatements];
      withUnauthorizedTail[withUnauthorizedTail.length - 1] += " SELECT current_user;";
      expect.soft(withUnauthorizedTail.map(normalizeStatement)).not.toEqual(expectedCustomStatements);

      const snapshotPath = new URL("../migrations/meta/0230_snapshot.json", import.meta.url);
      const parentSnapshotPath = new URL("../migrations/meta/0229_snapshot.json", import.meta.url);
      const rlsSnapshotPath = new URL("../migrations/meta/0231_snapshot.json", import.meta.url);
      expect.soft(existsSync(parentSnapshotPath)).toBe(true);
      expect.soft(existsSync(snapshotPath)).toBe(true);
      expect.soft(existsSync(rlsSnapshotPath)).toBe(true);
      if (existsSync(snapshotPath)) {
        const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
          tables?: Record<string, { indexes?: Record<string, { columns?: Array<{ expression?: string; asc?: boolean }> }> }>;
        };
        expect.soft(snapshot.tables?.["public.jobs"]?.indexes?.jobs_claim_idx?.columns).toEqual([
          { expression: "organization_id", isExpression: false, asc: true, nulls: "last" },
          { expression: "status", isExpression: false, asc: true, nulls: "last" },
          { expression: "available_at", isExpression: false, asc: true, nulls: "last" },
          { expression: "priority", isExpression: false, asc: false, nulls: "last" },
          { expression: "created_at", isExpression: false, asc: true, nulls: "last" },
          { expression: "id", isExpression: false, asc: true, nulls: "last" },
        ]);
        if (existsSync(rlsSnapshotPath)) {
          const rlsSnapshot = JSON.parse(readFileSync(rlsSnapshotPath, "utf8")) as { tables?: unknown };
          expect.soft(rlsSnapshot.tables).toEqual(snapshot.tables);
        }
      }
      const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as {
        entries?: Array<{ idx?: number; tag?: string }>;
      };
      expect.soft(journal.entries?.filter((entry) => [229, 230, 231].includes(entry.idx ?? -1))).toEqual([
        expect.objectContaining({ idx: 229, tag: m0229[0]?.replace(/\.sql$/, "") }),
        expect.objectContaining({ idx: 230, tag: m0230[0]?.replace(/\.sql$/, "") }),
        expect.objectContaining({ idx: 231, tag: m0231[0]?.replace(/\.sql$/, "") }),
      ]);
      await replayMigration(database(), m0229[0]!);
      await replayMigration(database(), m0230[0]!);
      await replayMigration(database(), m0231[0]!);
    });

    it("stores only the exact bounded static certificate facts and composite tenant relationships", async () => {
      const client = database();
      const columns = await client<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'worker_lease_rejections'
        ORDER BY ordinal_position`;
      expect.soft(columns.map((row) => row.column_name)).toEqual(EXPECTED_COLUMNS);

      const constraints = await client<{ name: string; type: string; definition: string }[]>`
        SELECT con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'worker_lease_rejections'`;
      const fks = constraints.filter((row) => row.type === "f");
      expect.soft(fks).toHaveLength(2);
      expect.soft(fks.map((row) => row.definition)).toContainEqual(expect.stringContaining(
        "FOREIGN KEY (organization_id, company_id, job_id, attempt_id) REFERENCES job_attempts(organization_id, company_id, job_id, id) ON DELETE CASCADE",
      ));
      expect.soft(fks.map((row) => row.definition)).toContainEqual(expect.stringContaining(
        "FOREIGN KEY (organization_id, worker_id, target_authority_key, target_id) REFERENCES workers(organization_id, id, target_authority_key, execution_target_id) ON DELETE CASCADE",
      ));
      expect.soft(fks.some((row) => /FOREIGN KEY \((company_id|job_id|attempt_id|worker_id)\)/.test(row.definition))).toBe(false);
      const definitions = constraints.map((row) => row.definition).join("\n");
      const checks = constraints.filter((row) => row.type === "c");
      const closedVocabulary = (column: string): string[] => {
        const matches = checks.filter((row) => new RegExp(`\\b${column}\\b`).test(row.definition));
        expect.soft(matches, `${column} must have one dedicated closed-vocabulary CHECK`).toHaveLength(1);
        return [...(matches[0]?.definition ?? "").matchAll(/'([^']+)'(?:::text)?/g)]
          .map((match) => match[1]!)
          .filter((value) => !value.startsWith("^["))
          .sort();
      };
      expect.soft(closedVocabulary("workload_type")).toEqual(["batch", "browser_session", "service"]);
      expect.soft(closedVocabulary("placement_owner")).toEqual([
        "managed_cloud", "organization_dedicated", "owner_desktop",
      ]);
      expect.soft(closedVocabulary("placement_target_class")).toEqual([
        "managed_cloud", "organization_dedicated", "owner_desktop",
      ]);
      expect.soft(closedVocabulary("placement_target_scope")).toEqual(["organization", "owner", "platform"]);
      expect.soft(closedVocabulary("reason_code")).toEqual(["static_requirements_mismatch"]);
      for (const column of [
        "static_context_hash", "placement_profile_hash", "placement_provider_constraint_hash",
        "placement_input_digest", "placement_policy_digest",
      ]) {
        expect.soft(definitions, `${column} must be lowercase sha256`).toMatch(
          new RegExp(`${column}[^\\n]*\\^\\[0-9a-f\\]\\{64\\}\\$`),
        );
      }
      expect.soft(definitions).toMatch(/eligibility_version\s*>\s*0/i);
      expect.soft(definitions).toMatch(/placement_target_generation\s*>\s*0/i);

      const [primaryKey] = await client<{ columns: string[] }[]>`
        SELECT array_agg(att.attname ORDER BY key.ordinality)::text[] AS columns
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
        JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = key.attnum
        WHERE rel.relname = 'worker_lease_rejections' AND con.contype = 'p'
        GROUP BY con.oid`;
      expect.soft(primaryKey?.columns).toEqual(["organization_id", "worker_id", "attempt_id"]);

      const indexes = await client<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('worker_lease_rejections', 'jobs', 'job_attempts')`;
      expect.soft(indexes.find((row) => row.indexname === "jobs_claim_idx")?.indexdef ?? "").toContain("priority DESC");
      expect.soft(indexes.find((row) => row.indexname === "job_attempts_lease_candidate_idx")?.indexdef ?? "")
        .toMatch(/\(organization_id, placement_target_id, job_id, id\).*WHERE.*status.*pending.*placement_disposition.*selected.*placement_mode.*active.*placement_lease_eligible/is);
      expect.soft(indexes.find((row) => row.indexname === "worker_lease_rejections_attempt_idx")?.indexdef ?? "")
        .toContain("(organization_id, company_id, job_id, attempt_id)");
      expect.soft(indexes.find((row) => row.indexname === "worker_lease_rejections_cleanup_idx")?.indexdef ?? "")
        .toContain("(organization_id, updated_at, worker_id, attempt_id)");
    });

    it("forces tenant RLS, grants only aoa_app DML, and exposes no operator certificate facts", async () => {
      const client = database();
      const [table] = await client<{ name: string | null }[]>`
        SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
      expect.soft(table?.name).toBe("worker_lease_rejections");
      if (table?.name !== "worker_lease_rejections") return;
      const [security] = await client<{
        rls: boolean;
        forced: boolean;
        app_select: boolean;
        app_insert: boolean;
        app_update: boolean;
        app_delete: boolean;
        operator_select: boolean;
        operator_insert: boolean;
        operator_update: boolean;
        operator_delete: boolean;
        public_select: boolean;
        public_insert: boolean;
        public_update: boolean;
        public_delete: boolean;
      }[]>`
        SELECT rel.relrowsecurity AS rls, rel.relforcerowsecurity AS forced,
          has_table_privilege('aoa_app', 'worker_lease_rejections', 'SELECT') AS app_select,
          has_table_privilege('aoa_app', 'worker_lease_rejections', 'INSERT') AS app_insert,
          has_table_privilege('aoa_app', 'worker_lease_rejections', 'UPDATE') AS app_update,
          has_table_privilege('aoa_app', 'worker_lease_rejections', 'DELETE') AS app_delete,
          has_table_privilege('aoa_operator', 'worker_lease_rejections', 'SELECT') AS operator_select,
          has_table_privilege('aoa_operator', 'worker_lease_rejections', 'INSERT') AS operator_insert,
          has_table_privilege('aoa_operator', 'worker_lease_rejections', 'UPDATE') AS operator_update,
          has_table_privilege('aoa_operator', 'worker_lease_rejections', 'DELETE') AS operator_delete,
          has_table_privilege('public', 'worker_lease_rejections', 'SELECT') AS public_select,
          has_table_privilege('public', 'worker_lease_rejections', 'INSERT') AS public_insert,
          has_table_privilege('public', 'worker_lease_rejections', 'UPDATE') AS public_update,
          has_table_privilege('public', 'worker_lease_rejections', 'DELETE') AS public_delete
        FROM pg_class rel WHERE rel.relname = 'worker_lease_rejections'`;
      expect(security).toEqual({
        rls: true,
        forced: true,
        app_select: true,
        app_insert: true,
        app_update: true,
        app_delete: true,
        operator_select: false,
        operator_insert: false,
        operator_update: false,
        operator_delete: false,
        public_select: false,
        public_insert: false,
        public_update: false,
        public_delete: false,
      });

      const policies = await client<{ roles: string[]; using_expression: string; check_expression: string }[]>`
        SELECT roles::text[] AS roles, qual AS using_expression, with_check AS check_expression
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'worker_lease_rejections'`;
      expect.soft(policies).toEqual([expect.objectContaining({ roles: ["aoa_app"] })]);
      expect.soft(policies[0]?.using_expression).toContain("aoa.organization_id");
      expect.soft(policies[0]?.check_expression).toContain("aoa.organization_id");
    });

    it("gives aoa_app no-GUC/cross-tenant denial and identical foreign-versus-missing parent errors", async () => {
      const client = database();
      const [table] = await client<{ name: string | null }[]>`
        SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
      expect.soft(table?.name).toBe("worker_lease_rejections");
      if (table?.name !== "worker_lease_rejections") return;

      const orgA = "e3100000-0000-4000-8000-000000000001";
      const orgB = "e3100000-0000-4000-8000-000000000002";
      const companyA = "e3100000-0000-4000-8000-000000000003";
      const companyB = "e3100000-0000-4000-8000-000000000004";
      const companyA2 = "e3100000-0000-4000-8000-000000000013";
      const targetA = "e3100000-0000-4000-8000-000000000005";
      const targetB = "e3100000-0000-4000-8000-000000000006";
      const workerA = "e3100000-0000-4000-8000-000000000007";
      const workerB = "e3100000-0000-4000-8000-000000000008";
      const jobA = "e3100000-0000-4000-8000-000000000009";
      const jobB = "e3100000-0000-4000-8000-000000000010";
      const attemptA = "e3100000-0000-4000-8000-000000000011";
      const attemptB = "e3100000-0000-4000-8000-000000000012";
      const attemptA2 = "e3100000-0000-4000-8000-000000000014";
      const missing = "e3100000-0000-4000-8000-999999999999";
      const hash = "a".repeat(64);

      await client`INSERT INTO organizations (id, name, slug) VALUES
        (${orgA}, 'certificate org A', 'certificate-org-a'),
        (${orgB}, 'certificate org B', 'certificate-org-b')`;
      await client`INSERT INTO companies (id, organization_id, name, issue_prefix) VALUES
        (${companyA}, ${orgA}, 'certificate company A', 'CFA'),
        (${companyB}, ${orgB}, 'certificate company B', 'CFB'),
        (${companyA2}, ${orgA}, 'certificate company A2', 'CF2')`;
      await client`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, scope, target_authority_key, device_generation)
        VALUES
          (${targetA}, ${orgA}, 'certificate-target-a', 'dedicated_worker', 'dedicated_tenant', 'active',
            'organization', ${`organization:${orgA}`}, 1),
          (${targetB}, ${orgB}, 'certificate-target-b', 'dedicated_worker', 'dedicated_tenant', 'active',
            'organization', ${`organization:${orgB}`}, 1)`;
      await client`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, enrolled_at, label, status)
        VALUES
          (${workerA}, 'organization', ${orgA}, ${targetA}, ${`organization:${orgA}`}, 'cert-key-a',
            ${"1".repeat(64)}, 1, ${"2".repeat(64)}, clock_timestamp(), 'cert worker A', 'enrolled'),
          (${workerB}, 'organization', ${orgB}, ${targetB}, ${`organization:${orgB}`}, 'cert-key-b',
            ${"3".repeat(64)}, 1, ${"4".repeat(64)}, clock_timestamp(), 'cert worker B', 'enrolled')`;
      await client`INSERT INTO jobs (id, organization_id, company_id) VALUES
        (${jobA}, ${orgA}, ${companyA}), (${jobB}, ${orgB}, ${companyB})`;
      await client`INSERT INTO job_attempts
        (id, organization_id, company_id, job_id, attempt_number, placement_disposition,
         placement_owner, placement_target_id, placement_target_class, placement_target_scope,
         placement_target_generation, placement_profile_hash, placement_provider_constraint_hash,
         placement_fallback_disposition, placement_reason_code, placement_mode,
         placement_lease_eligible, placement_input_digest, placement_policy_digest, placement_decided_at)
        VALUES
          (${attemptA}, ${orgA}, ${companyA}, ${jobA}, 1, 'selected', 'organization_dedicated',
            ${targetA}, 'organization_dedicated', 'organization', 1, ${hash}, ${hash}, 'primary',
            'target_selected', 'active', true, ${hash}, ${hash}, clock_timestamp()),
          (${attemptB}, ${orgB}, ${companyB}, ${jobB}, 1, 'selected', 'organization_dedicated',
            ${targetB}, 'organization_dedicated', 'organization', 1, ${hash}, ${hash}, 'primary',
            'target_selected', 'active', true, ${hash}, ${hash}, clock_timestamp()),
          (${attemptA2}, ${orgA}, ${companyA}, ${jobA}, 2, 'selected', 'organization_dedicated',
            ${targetA}, 'organization_dedicated', 'organization', 1, ${hash}, ${hash}, 'primary',
            'target_selected', 'active', true, ${hash}, ${hash}, clock_timestamp())`;
      await client`INSERT INTO worker_lease_rejections
        (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
         target_authority_key, eligibility_version, static_context_hash, workload_type,
         placement_owner, placement_target_class, placement_target_scope,
         placement_target_generation, placement_profile_hash, placement_provider_constraint_hash,
         placement_input_digest, placement_policy_digest, reason_code)
        VALUES
          (${orgA}, ${companyA}, ${jobA}, ${attemptA}, ${workerA}, ${targetA},
            ${`organization:${orgA}`}, 1, ${hash}, 'batch', 'organization_dedicated',
            'organization_dedicated', 'organization', 1, ${hash}, ${hash}, ${hash}, ${hash},
            'static_requirements_mismatch'),
          (${orgB}, ${companyB}, ${jobB}, ${attemptB}, ${workerB}, ${targetB},
            ${`organization:${orgB}`}, 1, ${hash}, 'batch', 'organization_dedicated',
            'organization_dedicated', 'organization', 1, ${hash}, ${hash}, ${hash}, ${hash},
            'static_requirements_mismatch')`;

      let noGucInsert: { code?: string; constraint?: string; message: string };
      try {
        await client.begin(async (tx) => {
          const query = tx as unknown as Sql;
          await query`SET LOCAL ROLE aoa_app`;
          await query`INSERT INTO worker_lease_rejections
            (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
             target_authority_key, eligibility_version, static_context_hash, workload_type,
             placement_owner, placement_target_class, placement_target_scope,
             placement_target_generation, placement_profile_hash,
             placement_provider_constraint_hash, placement_input_digest,
             placement_policy_digest, reason_code)
            VALUES (${orgA}, ${companyA}, ${jobA}, ${attemptA2}, ${workerA}, ${targetA},
              ${`organization:${orgA}`}, 1, ${hash}, 'batch', 'organization_dedicated',
              'organization_dedicated', 'organization', 1, ${hash}, ${hash}, ${hash}, ${hash},
              'static_requirements_mismatch')`;
        });
        throw new Error("expected no-GUC certificate INSERT denial");
      } catch (error) {
        const failure = error as { code?: string; constraint_name?: string; message?: string };
        noGucInsert = {
          code: failure.code,
          constraint: failure.constraint_name,
          message: failure.message ?? String(error),
        };
      }
      expect.soft(noGucInsert.code).toBe("42501");
      expect.soft(noGucInsert.constraint).toBeUndefined();
      expect.soft(noGucInsert.message).toMatch(/row-level security/i);

      const visible = await client.begin(async (tx) => {
        const query = tx as unknown as Sql;
        await query`SET LOCAL ROLE aoa_app`;
        const noGuc = await query<{ count: number }[]>`SELECT count(*)::int AS count FROM worker_lease_rejections`;
        await query`SELECT set_config('aoa.organization_id', ${orgA}, true)`;
        const own = await query<{ count: number }[]>`SELECT count(*)::int AS count FROM worker_lease_rejections WHERE organization_id = ${orgA}`;
        const foreign = await query<{ count: number }[]>`SELECT count(*)::int AS count FROM worker_lease_rejections WHERE organization_id = ${orgB}`;
        return { noGuc: noGuc[0]?.count, own: own[0]?.count, foreign: foreign[0]?.count };
      });
      expect(visible).toEqual({ noGuc: 0, own: 1, foreign: 0 });

      const dml = await client.begin(async (tx) => {
        const query = tx as unknown as Sql;
        await query`SET LOCAL ROLE aoa_app`;
        await query`SELECT set_config('aoa.organization_id', ${orgA}, true)`;
        const ownUpdate = await query<{ attempt_id: string }[]>`
          UPDATE worker_lease_rejections SET updated_at = clock_timestamp()
          WHERE organization_id = ${orgA} AND attempt_id = ${attemptA}
          RETURNING attempt_id`;
        const foreignUpdate = await query<{ attempt_id: string }[]>`
          UPDATE worker_lease_rejections SET updated_at = clock_timestamp()
          WHERE organization_id = ${orgB} AND attempt_id = ${attemptB}
          RETURNING attempt_id`;
        const foreignDelete = await query<{ attempt_id: string }[]>`
          DELETE FROM worker_lease_rejections
          WHERE organization_id = ${orgB} AND attempt_id = ${attemptB}
          RETURNING attempt_id`;
        const ownDelete = await query<{ attempt_id: string }[]>`
          DELETE FROM worker_lease_rejections
          WHERE organization_id = ${orgA} AND attempt_id = ${attemptA}
          RETURNING attempt_id`;
        const ownInsert = await query<{ attempt_id: string }[]>`INSERT INTO worker_lease_rejections
          (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
           target_authority_key, eligibility_version, static_context_hash, workload_type,
           placement_owner, placement_target_class, placement_target_scope,
           placement_target_generation, placement_profile_hash,
           placement_provider_constraint_hash, placement_input_digest,
           placement_policy_digest, reason_code)
          VALUES (${orgA}, ${companyA}, ${jobA}, ${attemptA}, ${workerA}, ${targetA},
            ${`organization:${orgA}`}, 1, ${hash}, 'batch', 'organization_dedicated',
            'organization_dedicated', 'organization', 1, ${hash}, ${hash}, ${hash}, ${hash},
            'static_requirements_mismatch') RETURNING attempt_id`;
        return {
          ownUpdate: ownUpdate.length,
          foreignUpdate: foreignUpdate.length,
          foreignDelete: foreignDelete.length,
          ownDelete: ownDelete.length,
          ownInsert: ownInsert.length,
        };
      });
      expect(dml).toEqual({ ownUpdate: 1, foreignUpdate: 0, foreignDelete: 0, ownDelete: 1, ownInsert: 1 });

      async function deniedInsert(input: {
        organizationId?: string;
        companyId: string;
        jobId: string;
        attemptId: string;
        workerId: string;
        targetId: string;
        authorityKey: string;
      }): Promise<{ code?: string; constraint?: string; message: string }> {
        try {
          await client.begin(async (tx) => {
            const query = tx as unknown as Sql;
            await query`SET LOCAL ROLE aoa_app`;
            await query`SELECT set_config('aoa.organization_id', ${orgA}, true)`;
            await query`INSERT INTO worker_lease_rejections
              (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
               target_authority_key, eligibility_version, static_context_hash, workload_type,
               placement_owner, placement_target_class, placement_target_scope,
               placement_target_generation, placement_profile_hash,
               placement_provider_constraint_hash, placement_input_digest,
               placement_policy_digest, reason_code)
              VALUES (${input.organizationId ?? orgA}, ${input.companyId}, ${input.jobId}, ${input.attemptId},
                ${input.workerId}, ${input.targetId}, ${input.authorityKey}, 1, ${hash}, 'batch',
                'organization_dedicated', 'organization_dedicated', 'organization', 1,
                ${hash}, ${hash}, ${hash}, ${hash}, 'static_requirements_mismatch')`;
          });
          throw new Error("expected certificate parent denial");
        } catch (error) {
          const failure = error as { code?: string; constraint_name?: string; message?: string };
          return {
            code: failure.code,
            constraint: failure.constraint_name,
            message: failure.message ?? String(error),
          };
        }
      }

      // This row is valid against every composite FK. With Org A selected, its
      // only denial reason must therefore be the tenant WITH CHECK policy.
      await client`DELETE FROM worker_lease_rejections
        WHERE organization_id = ${orgB} AND worker_id = ${workerB} AND attempt_id = ${attemptB}`;
      const validCrossOrganization = await deniedInsert({
        organizationId: orgB,
        companyId: companyB,
        jobId: jobB,
        attemptId: attemptB,
        workerId: workerB,
        targetId: targetB,
        authorityKey: `organization:${orgB}`,
      });
      expect.soft(validCrossOrganization.code).toBe("42501");
      expect.soft(validCrossOrganization.constraint).toBeUndefined();
      expect.soft(validCrossOrganization.message).toMatch(/row-level security/i);
      expect.soft(validCrossOrganization.message).not.toContain(orgA);
      expect.soft(validCrossOrganization.message).not.toContain(orgB);

      // Same-Organization cross-Company mixing cannot satisfy the composite
      // attempt FK: company A2 is real and visible, but it does not own job A.
      const sameOrganizationCrossCompany = await deniedInsert({
        companyId: companyA2,
        jobId: jobA,
        attemptId: attemptA2,
        workerId: workerA,
        targetId: targetA,
        authorityKey: `organization:${orgA}`,
      });
      expect.soft(sameOrganizationCrossCompany.code).toBe("23503");
      expect.soft(sameOrganizationCrossCompany.constraint).toBe("worker_lease_rejections_attempt_fk");
      expect.soft(sameOrganizationCrossCompany.message).not.toContain(companyA2);

      const foreignAttempt = await deniedInsert({
        companyId: companyB, jobId: jobB, attemptId: attemptB,
        workerId: workerA, targetId: targetA, authorityKey: `organization:${orgA}`,
      });
      const missingAttempt = await deniedInsert({
        companyId: missing, jobId: missing, attemptId: missing,
        workerId: workerA, targetId: targetA, authorityKey: `organization:${orgA}`,
      });
      expect.soft(foreignAttempt.code).toBe(missingAttempt.code);
      expect.soft(foreignAttempt.constraint).toBe(missingAttempt.constraint);
      expect.soft(foreignAttempt.message).toBe(missingAttempt.message);
      expect.soft(foreignAttempt.code).toBe("23503");
      expect.soft(foreignAttempt.constraint).toBe("worker_lease_rejections_attempt_fk");

      const foreignWorker = await deniedInsert({
        companyId: companyA, jobId: jobA, attemptId: attemptA,
        workerId: workerB, targetId: targetB, authorityKey: `organization:${orgB}`,
      });
      const missingWorker = await deniedInsert({
        companyId: companyA, jobId: jobA, attemptId: attemptA,
        workerId: missing, targetId: missing, authorityKey: `organization:${orgB}`,
      });
      expect.soft(foreignWorker.code).toBe(missingWorker.code);
      expect.soft(foreignWorker.constraint).toBe(missingWorker.constraint);
      expect.soft(foreignWorker.message).toBe(missingWorker.message);
      expect.soft(foreignWorker.code).toBe("23503");
      expect.soft(foreignWorker.constraint).toBe("worker_lease_rejections_worker_target_fk");
    });

    it("exports the Drizzle table and never adds a worker cursor", () => {
      const schemaPath = new URL("../schema/worker_lease_rejections.ts", import.meta.url);
      const indexSource = readFileSync(new URL("../schema/index.ts", import.meta.url), "utf8");
      expect.soft(existsSync(schemaPath)).toBe(true);
      expect.soft(indexSource).toContain('export * from "./worker_lease_rejections.js"');
      expect.soft(indexSource).not.toContain("leaseScanCursor");
    });
  },
);
