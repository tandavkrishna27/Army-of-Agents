// packages/db/src/__tests__/tenant-kernel-schema-b.integration.test.ts
//
// REAL embedded-postgres proof for the TEN-001b half of the new-path tenant
// kernel: the remaining five tables (workers, services, service_instances,
// job_artifacts, job_secret_handles) exist after the full migration chain
// applies, that the Company/service-scoped denormalized `organization_id`
// columns are MANDATORY + NON-DEFAULTED (NOT NULL, no column default —
// fail-closed, no sentinel), that `workers.organization_id` is NULLABLE (only
// platform rows have a null Organization), and that the `workers_scope_org_check`
// constraint enforces the platform/organization scope↔org pairing via direct SQL.
//
// Why real embedded-Postgres and not a schema-literal grep: only applying the
// generated migration against a real cluster proves the emitted DDL creates the
// table with `is_nullable`/`column_default` as intended AND that the CHECK
// constraint actually rejects mixed scope/org rows at write time. A `.notNull()`
// / `check(...)` in the .ts source without the emitted migration, or a stray
// DB-level DEFAULT, would slip past a source assertion but fail here.
//
// RED (before the five schema modules + 0208 migration exist): the tables are
// absent, so the `tableExists` assertions fail. GREEN (after): all five exist,
// each denormalized organization_id column is NOT NULL with no default,
// workers.organization_id is nullable, and the scope/org check fires.
//
// Gate: E2-D05 env-hatch. Runs automatically on Linux CI
// (process.platform !== "win32") and is Windows-runnable in place via
// AOA_RUN_WIN_INTEGRATION=1 — no source edit-and-restore. It is a `skipIf` (not
// the banned `X ? describe : describe.skip` ternary), so it satisfies the
// integration-test-hygiene meta-test. Boot uses initdbFlags UTF8/C so the cluster
// locale is safe; setupError is captured in beforeAll and re-thrown in each `it`
// (fail closed).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { applyPendingMigrations } from "../client.js";

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

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let client: ReturnType<typeof postgres>;
let setupError: unknown = null;

// Replicated locally (the shared server helper is not importable from the db
// package — server depends on db, not the reverse). Same probe-a-free-port shape
// as the sibling tenant-kernel-schema integration suite.
async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) return reject(err);
        if (!address || typeof address === "string") {
          return reject(new Error("Failed to allocate test port"));
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await client<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
    ) AS ok`;
  return rows[0]!.ok === true;
}

type OrgColumnInfo = { is_nullable: string; column_default: string | null };
async function orgColumn(table: string): Promise<OrgColumnInfo | null> {
  const rows = await client<OrgColumnInfo[]>`
    SELECT is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = 'organization_id'`;
  return rows[0] ?? null;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-tenant-kernel-schema-b-integ-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocatePort();
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      // Force UTF-8 so migration SQL with non-Latin1 chars applies; without this
      // initdb inherits the host locale (WIN1252 on Windows) and rejects them.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    // Apply the WHOLE chain (0000..latest) — including the TEN-001b migration
    // that creates workers/services/service_instances/job_artifacts/job_secret_handles.
    await applyPendingMigrations(connectionString);
    client = postgres(connectionString, { max: 1 });
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[tenant-kernel-schema-b] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (client) await client.end();
  } catch {
    /* ignore */
  }
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "TEN-001b tenant kernel schema (workers, services, service_instances, job_artifacts, job_secret_handles)",
  () => {
    it("creates the five remaining new-path kernel tables", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      expect(await tableExists("workers")).toBe(true);
      expect(await tableExists("services")).toBe(true);
      expect(await tableExists("service_instances")).toBe(true);
      expect(await tableExists("job_artifacts")).toBe(true);
      expect(await tableExists("job_secret_handles")).toBe(true);
    });

    it("makes services.organization_id NOT NULL with no default (mandatory, no sentinel)", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      const col = await orgColumn("services");
      expect(col).not.toBeNull();
      expect(col!.is_nullable).toBe("NO");
      expect(col!.column_default).toBeNull();
    });

    it("makes service_instances.organization_id NOT NULL with no default (denormalized, no sentinel)", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      const col = await orgColumn("service_instances");
      expect(col).not.toBeNull();
      expect(col!.is_nullable).toBe("NO");
      expect(col!.column_default).toBeNull();
    });

    it("makes job_artifacts.organization_id NOT NULL with no default (denormalized, no sentinel)", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      const col = await orgColumn("job_artifacts");
      expect(col).not.toBeNull();
      expect(col!.is_nullable).toBe("NO");
      expect(col!.column_default).toBeNull();
    });

    it("makes job_secret_handles.organization_id NOT NULL with no default (denormalized, no sentinel)", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      const col = await orgColumn("job_secret_handles");
      expect(col).not.toBeNull();
      expect(col!.is_nullable).toBe("NO");
      expect(col!.column_default).toBeNull();
    });

    it("makes workers.organization_id NULLABLE (platform rows have a null Organization)", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      const col = await orgColumn("workers");
      expect(col).not.toBeNull();
      expect(col!.is_nullable).toBe("YES");
    });

    it("enforces workers_scope_org_check: platform⇒null org, organization/owner⇒non-null org", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      // Seed a REAL organization so the invalid platform-with-org insert is
      // rejected by the CHECK (FK passes), not by the FK — proving the check.
      const [org] = await client<{ id: string }[]>`
        INSERT INTO organizations (name, slug)
        VALUES ('TEN-001b Test Org', 'ten-001b-test-org')
        RETURNING id`;
      const orgId = org!.id;
      const targetIds = [
        "12000000-0000-4000-8000-0000000000b1",
        "12000000-0000-4000-8000-0000000000b2",
        "12000000-0000-4000-8000-0000000000b3",
      ];
      for (const [index, targetId] of targetIds.entries()) {
        await client`INSERT INTO execution_targets
          (id, organization_id, slug, kind, trust_class, status, capabilities, config,
           scope, target_authority_key, device_generation)
          VALUES (${targetId}, NULL, ${`schema-b-platform-${index}`}, 'pooled_gvisor',
            'shared_multitenant', 'active', '{}', '{}', 'platform', 'platform', 1)`;
      }

      // (1) platform + null org → succeeds.
      await client`
        INSERT INTO workers
          (scope, organization_id, label, execution_target_id, target_authority_key,
           device_generation, device_public_key, device_thumbprint, profile_hash, enrolled_at)
        VALUES ('platform', NULL, 'platform-worker', ${targetIds[0]}, 'platform',
          1, 'schema-b-key', ${"a".repeat(64)}, ${"b".repeat(64)}, now())`;

      // (2) platform + non-null org → rejected by workers_scope_org_check.
      await expect(
        client`
          INSERT INTO workers
            (scope, organization_id, label, execution_target_id, target_authority_key,
             device_generation, device_public_key, device_thumbprint, profile_hash, enrolled_at)
          VALUES ('platform', ${orgId}, 'bad-platform-with-org', ${targetIds[1]}, 'platform',
            1, 'schema-b-key', ${"c".repeat(64)}, ${"d".repeat(64)}, now())`,
      ).rejects.toThrow(/workers_scope_org_check/);

      // (3) organization + null org → rejected by workers_scope_org_check.
      await expect(
        client`
          INSERT INTO workers
            (scope, organization_id, label, execution_target_id, target_authority_key,
             device_generation, device_public_key, device_thumbprint, profile_hash, enrolled_at)
          VALUES ('organization', NULL, 'bad-org-without-org', ${targetIds[2]}, 'platform',
            1, 'schema-b-key', ${"e".repeat(64)}, ${"f".repeat(64)}, now())`,
      ).rejects.toThrow(/workers_scope_org_check/);
    });
  },
);
