import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import { applyPendingMigrations } from "../client.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

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
    dataDir = await mkdtemp(join(tmpdir(), "aoa-worker-enrollment-schema-"));
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
    db = postgres(url, { max: 1 });
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
  "JOB-002 worker enrollment authority schema",
  () => {
    it("stores route-only discovery separately from tenant enrollment authority and replay facts", async () => {
      const client = database();
      const columns = await client<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'execution_targets', 'workers', 'worker_enrollment_code_routes',
            'worker_enrollment_codes', 'worker_proof_replays'
          )
      `;
      const names = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
      for (const name of [
        "execution_targets.scope",
        "execution_targets.target_authority_key",
        "execution_targets.device_generation",
        "workers.execution_target_id",
        "workers.target_authority_key",
        "workers.device_public_key",
        "workers.device_thumbprint",
        "workers.device_generation",
        "workers.profile_hash",
        "workers.revoked_at",
        "workers.last_seen_at",
        "worker_enrollment_code_routes.locator_hash",
        "worker_enrollment_code_routes.candidate_organization_id",
        "worker_enrollment_codes.secret_hash",
        "worker_enrollment_codes.semantic_digest",
        "worker_enrollment_codes.semantic_result",
        "worker_proof_replays.proof_id",
        "worker_proof_replays.expires_at",
      ]) expect(names, name).toContain(name);
      expect(names).not.toContain("worker_enrollment_code_routes.secret_hash");
      expect(names).not.toContain("worker_enrollment_code_routes.semantic_result");
    });

    it("replays the applied 0219 and 0220 generated migration chain without duplicate relations or constraints", async () => {
      const client = database();
      await replayMigration(client, "0219_worker_enrollment.sql");
      await replayMigration(client, "0220_worker_enrollment_constraints.sql");
    });

    it("keeps restart progress out of the logical-worker authority row", async () => {
      const client = database();
      const cursorColumns = await client<{ column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'workers'
          AND column_name LIKE 'lease_scan_cursor_%'
        ORDER BY column_name
      `;
      expect(cursorColumns).toEqual([]);
    });

    it("uses text owner identity, exact authority checks, and a composite worker-to-target FK", async () => {
      const client = database();
      const [ownerColumn] = await client<{ data_type: string; is_nullable: string }[]>`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'workers' AND column_name = 'owner_user_id'
      `;
      expect(ownerColumn).toEqual({ data_type: "text", is_nullable: "YES" });

      const constraints = await client<{ table_name: string; constraint_name: string; definition: string }[]>`
        SELECT rel.relname AS table_name, con.conname AS constraint_name,
          pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname IN ('execution_targets', 'workers')
      `;
      expect(constraints).toContainEqual(expect.objectContaining({
        table_name: "execution_targets",
        constraint_name: "execution_targets_authority_id_uq",
        definition: "UNIQUE (target_authority_key, id)",
      }));
      expect(constraints).toContainEqual(expect.objectContaining({
        table_name: "workers",
        constraint_name: "workers_target_authority_fk",
        definition: "FOREIGN KEY (target_authority_key, execution_target_id) REFERENCES execution_targets(target_authority_key, id) ON DELETE RESTRICT",
      }));
      expect(constraints).toContainEqual(expect.objectContaining({
        table_name: "workers",
        constraint_name: "workers_owner_user_fk",
        definition: "FOREIGN KEY (owner_user_id) REFERENCES \"user\"(id) ON DELETE RESTRICT",
      }));
      const targetCheck = constraints.find((row) => row.constraint_name === "execution_targets_authority_scope_check")?.definition ?? "";
      const workerCheck = constraints.find((row) => row.constraint_name === "workers_target_scope_check")?.definition ?? "";
      expect(targetCheck).toContain("organization:");
      expect(targetCheck).toContain("owner:");
      expect(workerCheck).toContain("target_authority_key = 'platform'::text");
      expect(workerCheck).toContain("organization:");
      expect(workerCheck).toContain("owner:");
    });

    it("enforces scope cardinality with partial unique indexes", async () => {
      const client = database();
      const indexes = await client<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'workers'
      `;
      for (const index of [
        "workers_platform_target_uq",
        "workers_organization_target_uq",
        "workers_owner_target_uq",
      ]) expect(indexes.map((row) => row.indexname), index).toContain(index);
      expect(indexes.find((row) => row.indexname === "workers_platform_target_uq")?.indexdef).toContain("WHERE (scope = 'platform'::text)");
      expect(indexes.find((row) => row.indexname === "workers_organization_target_uq")?.indexdef).toContain("WHERE (scope = 'organization'::text)");
      expect(indexes.find((row) => row.indexname === "workers_owner_target_uq")?.indexdef).toContain("WHERE (scope = 'owner'::text)");
    });

    it("rejects foreign and nonexistent targets with the same composite-FK constraint", async () => {
      const client = database();
      const orgA = "11000000-0000-4000-8000-000000000001";
      const orgB = "11000000-0000-4000-8000-000000000002";
      const targetB = "12000000-0000-4000-8000-000000000002";
      const missingTarget = "12000000-0000-4000-8000-000000000099";
      await client`INSERT INTO organizations (id, name, slug) VALUES
        (${orgA}, 'Enroll A', 'enroll-a'), (${orgB}, 'Enroll B', 'enroll-b')`;
      await client`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config,
         scope, target_authority_key, device_generation)
        VALUES (${targetB}, ${orgB}, 'target-b', 'dedicated_worker', 'dedicated_tenant',
          'active', '{}', '{}', 'organization', ${`organization:${orgB}`}, 1)`;

      async function denied(targetId: string): Promise<string | undefined> {
        try {
          await client`INSERT INTO workers
            (scope, organization_id, label, status, execution_target_id,
             target_authority_key, device_generation, device_public_key,
             device_thumbprint, profile_hash, enrolled_at)
            VALUES ('organization', ${orgA}, 'bad', 'enrolled', ${targetId},
              ${`organization:${orgA}`}, 1, 'key', ${"a".repeat(64)}, ${"b".repeat(64)}, now())`;
          throw new Error("expected worker target binding denial");
        } catch (error) {
          return (error as { constraint_name?: string }).constraint_name;
        }
      }
      expect(await denied(targetB)).toBe("workers_target_authority_fk");
      expect(await denied(missingTarget)).toBe("workers_target_authority_fk");
    });

    it("forces RLS and keeps aoa_operator away from tenant code hashes/results", async () => {
      const client = database();
      const rls = await client<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
        WHERE relname IN ('workers', 'execution_targets', 'worker_enrollment_code_routes',
          'worker_enrollment_codes', 'worker_proof_replays')
      `;
      expect(rls).toHaveLength(5);
      expect(rls.every((row) => row.relrowsecurity)).toBe(true);
      expect(rls.filter((row) => row.relname !== "execution_targets").every((row) => row.relforcerowsecurity)).toBe(true);
      expect(rls.find((row) => row.relname === "execution_targets")?.relforcerowsecurity).toBe(false);

      const [operator] = await client<{
        codes_select: boolean;
        routes_select: boolean;
        jobs_select: boolean;
        workers_insert: boolean;
        targets_update: boolean;
      }[]>`
        SELECT
          has_table_privilege('aoa_operator', 'worker_enrollment_codes', 'SELECT') AS codes_select,
          has_table_privilege('aoa_operator', 'worker_enrollment_code_routes', 'SELECT') AS routes_select,
          has_table_privilege('aoa_operator', 'jobs', 'SELECT') AS jobs_select,
          has_table_privilege('aoa_operator', 'workers', 'INSERT') AS workers_insert,
          has_column_privilege('aoa_operator', 'execution_targets', 'worker_token_hash', 'UPDATE') AND
          has_column_privilege('aoa_operator', 'execution_targets', 'device_generation', 'UPDATE') AND
          has_column_privilege('aoa_operator', 'execution_targets', 'status', 'UPDATE') AS targets_update
      `;
      expect(operator).toEqual({
        codes_select: true,
        routes_select: true,
        jobs_select: false,
        workers_insert: true,
        targets_update: true,
      });
    });
  },
);
