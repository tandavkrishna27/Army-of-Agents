import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const MIGRATION_0227 = new URL("../migrations/0227_job_leasing_authority.sql", import.meta.url);
const BACKFILL_COMMENT =
  "-- C14 permitted idempotent data backfill for E2-valid active leases before leases_activation_check.";

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let migrationsDir = "";
let client: Sql | null = null;
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
  if (!client) throw new Error("database was not initialized");
  return client;
}

async function replay0227(db: Sql): Promise<void> {
  const source = await readFile(MIGRATION_0227, "utf8");
  await db.begin(async (tx) => {
    for (const statement of source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      await tx.unsafe(statement);
    }
  });
}

async function replayMigration(db: Sql, fileName: string): Promise<void> {
  const source = await readFile(new URL(`../migrations/${fileName}`, import.meta.url), "utf8");
  await db.begin(async (tx) => {
    for (const statement of source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      await tx.unsafe(statement);
    }
  });
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-job003-upgrade-"));
    migrationsDir = join(dataDir, "migrations");
    const sourceMigrations = new URL("../migrations", import.meta.url);
    await cp(sourceMigrations, migrationsDir, { recursive: true });
    await unlink(join(migrationsDir, "0227_job_leasing_authority.sql"));
    await unlink(join(migrationsDir, "0228_job_leasing_rls.sql"));
    const journalPath = join(migrationsDir, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ idx: number }>;
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 226);
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

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
    client = postgres(url, { max: 2 });
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  await client?.end().catch(() => {});
  await embedded?.stop().catch(() => {});
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-003 populated E2 to 0227 lease upgrade",
  () => {
    it("pins the permitted replay-safe active-lease backfill immediately before the rich constraint", () => {
      const source = readFileSync(MIGRATION_0227, "utf8");
      const backfill =
        "UPDATE leases SET activated_at = COALESCE(updated_at, created_at) WHERE status = 'active' AND activated_at IS NULL";
      expect(source).toContain(BACKFILL_COMMENT);
      expect(source).toContain(backfill);
      expect(source.indexOf(backfill)).toBeLessThan(source.indexOf('ADD CONSTRAINT "leases_activation_check"'));
    });

    it("upgrades active/offered/terminal legacy rows, accepts rich rows, and directly replays 0227", async () => {
      const db = database();
      const org = "d3000000-0000-4000-8000-000000000001";
      const company = "d3000000-0000-4000-8000-000000000002";
      const target = "d3000000-0000-4000-8000-000000000003";
      const worker = "d3000000-0000-4000-8000-000000000004";
      const job = "d3000000-0000-4000-8000-000000000005";
      const attempts = [
        "d3000000-0000-4000-8000-000000000006",
        "d3000000-0000-4000-8000-000000000007",
        "d3000000-0000-4000-8000-000000000008",
        "d3000000-0000-4000-8000-000000000009",
        "d3000000-0000-4000-8000-000000000010",
        "d3000000-0000-4000-8000-000000000011",
      ];
      const legacyActive = "d3000000-0000-4000-8000-000000000012";
      const updatedAt = new Date("2026-08-09T10:30:00.000Z");

      await db`INSERT INTO organizations (id, name, slug) VALUES (${org}, 'upgrade org', 'job003-upgrade')`;
      await db`INSERT INTO companies (id, organization_id, name, issue_prefix) VALUES (${company}, ${org}, 'upgrade company', 'JUP')`;
      await db`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, scope, target_authority_key, device_generation)
        VALUES (${target}, ${org}, 'upgrade-target', 'dedicated_worker', 'dedicated_tenant', 'active',
          'organization', ${`organization:${org}`}, 1)`;
      await db`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, enrolled_at, label, status)
        VALUES (${worker}, 'organization', ${org}, ${target}, ${`organization:${org}`}, 'upgrade-key',
          ${"1".repeat(64)}, 1, ${"2".repeat(64)}, clock_timestamp(), 'upgrade worker', 'enrolled')`;
      await db`INSERT INTO jobs (id, organization_id, company_id) VALUES (${job}, ${org}, ${company})`;
      for (const [index, attempt] of attempts.entries()) {
        await db`INSERT INTO job_attempts
          (id, organization_id, company_id, job_id, attempt_number)
          VALUES (${attempt}, ${org}, ${company}, ${job}, ${index + 1})`;
      }
      await db`INSERT INTO leases (id, organization_id, attempt_id, status, fence, created_at, updated_at)
        VALUES
          (${legacyActive}, ${org}, ${attempts[0]}, 'active', 'legacy-active',
            '2026-08-09T10:00:00.000Z'::timestamptz, ${updatedAt.toISOString()}),
          ('d3000000-0000-4000-8000-000000000013', ${org}, ${attempts[1]}, 'offered', 'legacy-offered',
            '2026-08-09T10:00:00.000Z'::timestamptz, '2026-08-09T10:10:00.000Z'::timestamptz),
          ('d3000000-0000-4000-8000-000000000014', ${org}, ${attempts[2]}, 'released', 'legacy-released',
            '2026-08-09T10:00:00.000Z'::timestamptz, '2026-08-09T10:20:00.000Z'::timestamptz)`;

      await expect(replay0227(db)).resolves.toBeUndefined();

      const [legacy] = await db<{ activated_at: Date | null }[]>`
        SELECT activated_at FROM leases WHERE id = ${legacyActive}`;
      expect(legacy?.activated_at === null || legacy?.activated_at === undefined
        ? null
        : new Date(legacy.activated_at).toISOString()).toBe(updatedAt.toISOString());
      const legacyNulls = await db<{ status: string; activated_at: Date | null }[]>`
        SELECT status, activated_at FROM leases WHERE attempt_id IN (${attempts[1]}, ${attempts[2]}) ORDER BY status`;
      expect(legacyNulls).toEqual([
        { status: "offered", activated_at: null },
        { status: "released", activated_at: null },
      ]);

      const richBase = {
        organizationId: org,
        companyId: company,
        jobId: job,
        workerId: worker,
        targetId: target,
        targetAuthorityKey: `organization:${org}`,
      };
      await db`INSERT INTO leases
        (id, organization_id, company_id, job_id, attempt_id, attempt_number, worker_id, target_id,
         target_authority_key, target_generation, profile_hash, provider_constraint_hash, status,
         fence, ack_deadline, expires_at, activated_at)
        VALUES
          ('d3000000-0000-4000-8000-000000000015', ${richBase.organizationId}, ${richBase.companyId},
            ${richBase.jobId}, ${attempts[3]}, 4, ${richBase.workerId}, ${richBase.targetId},
            ${richBase.targetAuthorityKey}, 1, ${"2".repeat(64)}, ${"3".repeat(64)}, 'active',
            'rich-active', clock_timestamp() + interval '1 minute', clock_timestamp() + interval '2 minutes', clock_timestamp()),
          ('d3000000-0000-4000-8000-000000000016', ${richBase.organizationId}, ${richBase.companyId},
            ${richBase.jobId}, ${attempts[4]}, 5, ${richBase.workerId}, ${richBase.targetId},
            ${richBase.targetAuthorityKey}, 1, ${"2".repeat(64)}, ${"3".repeat(64)}, 'offered',
            'rich-offered', clock_timestamp() + interval '1 minute', clock_timestamp() + interval '2 minutes', NULL),
          ('d3000000-0000-4000-8000-000000000017', ${richBase.organizationId}, ${richBase.companyId},
            ${richBase.jobId}, ${attempts[5]}, 6, ${richBase.workerId}, ${richBase.targetId},
            ${richBase.targetAuthorityKey}, 1, ${"2".repeat(64)}, ${"3".repeat(64)}, 'released',
            'rich-released', clock_timestamp() + interval '1 minute', clock_timestamp() + interval '2 minutes', clock_timestamp())`;

      await expect(replay0227(db)).resolves.toBeUndefined();
      const [counts] = await db<{ rich: number; missing_active_fact: number }[]>`
        SELECT
          count(*) FILTER (WHERE id IN (
            'd3000000-0000-4000-8000-000000000015',
            'd3000000-0000-4000-8000-000000000016',
            'd3000000-0000-4000-8000-000000000017'
          ))::int AS rich,
          count(*) FILTER (WHERE status = 'active' AND activated_at IS NULL)::int AS missing_active_fact
        FROM leases`;
      expect(counts).toEqual({ rich: 3, missing_active_fact: 0 });

      await replayMigration(db, "0228_job_leasing_rls.sql");
      const migrationNames = readdirSync(new URL("../migrations/", import.meta.url));
      const successors = [229, 230, 231].map((ordinal) => migrationNames.filter(
        (name) => new RegExp(`^0${ordinal}_.*\\.sql$`).test(name),
      ));
      expect.soft(successors.map((matches) => matches.length)).toEqual([1, 1, 1]);
      if (successors.some((matches) => matches.length !== 1)) return;

      await replayMigration(db, successors[0]![0]!);
      const [parentKey] = await db<{ present: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'workers_org_id_authority_target_uq'
        ) AS present`;
      expect.soft(parentKey?.present).toBe(true);
      await replayMigration(db, successors[1]![0]!);
      await replayMigration(db, successors[2]![0]!);
      for (const migration of successors.flat()) await replayMigration(db, migration);

      const [certificateTable] = await db<{ present: boolean }[]>`
        SELECT to_regclass('public.worker_lease_rejections') IS NOT NULL AS present`;
      expect.soft(certificateTable?.present).toBe(true);
      const [claimIndex] = await db<{ definition: string }[]>`
        SELECT indexdef AS definition FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'jobs_claim_idx'`;
      expect.soft(claimIndex?.definition).toContain("priority DESC");
    }, 180_000);
  },
);
