// packages/db/src/__tests__/tenant-kernel-schema.integration.test.ts
//
// REAL embedded-postgres proof that the TEN-001a new-path tenant kernel tables
// (jobs, job_attempts, leases) exist after the full migration chain applies, and
// that every one of them carries a MANDATORY, NON-DEFAULTED tenant identity:
// organization_id is NOT NULL with NO column default (fail-closed — no sentinel).
//
// Why real embedded-Postgres and not a schema-literal grep: only applying the
// generated migration against a real cluster proves the DDL that `db:generate`
// emitted actually creates the table with `is_nullable = 'NO'` AND
// `column_default IS NULL`. A `.notNull()` in the .ts source without the emitted
// migration, or a stray DB-level DEFAULT (the companies.organization_id sentinel
// trap), would slip past a source assertion but fail here.
//
// RED (before the schema modules + 0207 migration exist): the tables are absent,
// so the `tableExists` assertions fail. GREEN (after): all three exist, each
// organization_id column is NOT NULL with no default.
//
// Gate: E2-D05 env-hatch. Runs automatically on Linux CI
// (process.platform !== "win32") and is Windows-runnable in place via
// AOA_RUN_WIN_INTEGRATION=1 — no source edit-and-restore. It is a `skipIf` (not
// the banned `X ? describe : describe.skip` ternary), so it satisfies the
// integration-test-hygiene meta-test. Boot uses initdbFlags UTF8/C so the cluster
// locale is safe; setupError is captured in beforeAll and re-thrown in the first
// `it` (fail closed).
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
// as the sibling revert-0188 / execution-targets integration suites.
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
    dataDir = await mkdtemp(join(tmpdir(), "aoa-tenant-kernel-schema-integ-"));
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
    // Apply the WHOLE chain (0000..latest) — including the TEN-001a migration that
    // creates jobs/job_attempts/leases.
    await applyPendingMigrations(connectionString);
    client = postgres(connectionString, { max: 1 });
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[tenant-kernel-schema] embedded-postgres setup failed:", err);
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
  "TEN-001a tenant kernel schema (jobs, job_attempts, leases)",
  () => {
    it("creates the three new-path kernel tables", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      expect(await tableExists("jobs")).toBe(true);
      expect(await tableExists("job_attempts")).toBe(true);
      expect(await tableExists("leases")).toBe(true);
    });

    it("makes jobs.organization_id NOT NULL with no default (mandatory, no sentinel)", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      const col = await orgColumn("jobs");
      expect(col).not.toBeNull();
      expect(col!.is_nullable).toBe("NO");
      expect(col!.column_default).toBeNull();
    });

    it("makes job_attempts.organization_id NOT NULL with no default (denormalized, no sentinel)", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      const col = await orgColumn("job_attempts");
      expect(col).not.toBeNull();
      expect(col!.is_nullable).toBe("NO");
      expect(col!.column_default).toBeNull();
    });

    it("makes leases.organization_id NOT NULL with no default (denormalized, no sentinel)", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      const col = await orgColumn("leases");
      expect(col).not.toBeNull();
      expect(col!.is_nullable).toBe("NO");
      expect(col!.column_default).toBeNull();
    });
  },
);
