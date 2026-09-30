// packages/db/src/__tests__/dr-marker-rollback.integration.test.ts
//
// REL-003 (E11) Lane C (embedded-PG) — "marker deletion alone is never accepted as
// rollback" (DE-20) proven at the database level, plus the REAL rollback path's
// refusal.
//
//   * MARKER-NEGATIVE: deleting a `distributed_cutover_markers` row removes ONLY the
//     gate marker keyed by candidate_sha — the 0188 tenant schema (organizations,
//     the companies.organization_id column + its FK) is UNTOUCHED. So a marker
//     delete is not a rollback: the tenant state it was supposed to undo is all
//     still there.
//   * REAL-ROLLBACK-REFUSES: `revert0188` (the single-org escape hatch) REFUSES on a
//     multi-org instance, pointing the operator to "restore the pre-0188 snapshot
//     instead". The accepted rollback path is the snapshot restore (or single-org
//     revert0188), never a marker delete.
//
// Raw `postgres` client + the full applied migration chain (Template A, mirroring
// revert-0188.integration.test.ts). Windows CI can't start embedded-postgres on the
// runneradmin runner (Issue #114) — gated; opt in locally with
// AOA_RUN_WIN_INTEGRATION=1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { applyPendingMigrations } from "../client.js";
import { revert0188 } from "../revert-0188.js";

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

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) return reject(err);
        if (!address || typeof address === "string") return reject(new Error("Failed to allocate test port"));
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
async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await client<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    ) AS ok`;
  return rows[0]!.ok === true;
}
async function constraintExists(name: string): Promise<boolean> {
  const rows = await client<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ${name}) AS ok`;
  return rows[0]!.ok === true;
}
async function orgCount(): Promise<number> {
  const rows = await client<{ count: number }[]>`SELECT count(*)::int AS count FROM organizations`;
  return rows[0]!.count;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-dr-marker-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    const port = await allocatePort();
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
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    client = postgres(connectionString, { max: 1 });
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[dr-marker-rollback] embedded-postgres setup failed:", err);
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
  "REL-003 Lane C — marker deletion is not a rollback",
  () => {
    it("I10 (DB): deleting a distributed_cutover_markers row leaves the 0188 tenant schema fully intact", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);

      // Seed a cutover marker (the gate marker keyed by candidate_sha).
      const candidateSha = "c".repeat(40);
      await client`
        INSERT INTO distributed_cutover_markers (candidate_sha, snapshot_ref, snapshot_checksum, verified_at)
        VALUES (${candidateSha}, 'snap-ref-1', ${"d".repeat(64)}, clock_timestamp())`;
      const [{ count: before }] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM distributed_cutover_markers WHERE candidate_sha = ${candidateSha}`;
      expect(before).toBe(1);

      // Preconditions: the 0188 tenant schema is present.
      expect(await tableExists("organizations")).toBe(true);
      expect(await columnExists("companies", "organization_id")).toBe(true);
      expect(await constraintExists("companies_organization_id_organizations_id_fk")).toBe(true);

      // THE ROLLBACK-BY-MARKER-DELETE ATTEMPT: delete the marker row.
      await client`DELETE FROM distributed_cutover_markers WHERE candidate_sha = ${candidateSha}`;
      const [{ count: after }] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM distributed_cutover_markers WHERE candidate_sha = ${candidateSha}`;
      expect(after).toBe(0);

      // The marker is gone, but NOTHING tenant-side changed — the cutover is NOT
      // rolled back. This is exactly why marker deletion is never accepted as
      // rollback (DE-20): the state it was supposed to undo is all still here.
      expect(await tableExists("organizations")).toBe(true);
      expect(await tableExists("organization_memberships")).toBe(true);
      expect(await columnExists("companies", "organization_id")).toBe(true);
      expect(await constraintExists("companies_organization_id_organizations_id_fk")).toBe(true);
    });

    it("I11: the REAL rollback path (revert0188) refuses on a multi-org instance, pointing to snapshot restore", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      // The instance has the sentinel org (from 0188) — add a second so the
      // one-way-door guard fires.
      expect(await orgCount()).toBe(1);
      const [{ id: secondOrgId }] = await client<{ id: string }[]>`
        INSERT INTO organizations (id, name, slug, status, plan)
        VALUES (gen_random_uuid(), 'DR Second Tenant', 'dr-second-tenant', 'active', 'beta')
        RETURNING id`;
      try {
        await expect(revert0188(client)).rejects.toThrow(/expected exactly 1 organization/i);
        // Non-destructive: the guard fires before any schema change — the tenant
        // schema is untouched (the accepted rollback is the pre-0188 snapshot restore).
        expect(await tableExists("organizations")).toBe(true);
        expect(await columnExists("companies", "organization_id")).toBe(true);
      } finally {
        await client`DELETE FROM organizations WHERE id = ${secondOrgId}`;
      }
      expect(await orgCount()).toBe(1);
    });
  },
);
