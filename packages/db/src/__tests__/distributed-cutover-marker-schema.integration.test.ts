/**
 * DEP-003 (E6 deployment harness) — embedded-PG proof of the operator-gated 0188
 * cutover marker table + its RLS matrix:
 *   - the table exists with FORCE ROW LEVEL SECURITY;
 *   - `aoa_operator` can WRITE (INSERT) + read-back;
 *   - `aoa_app` is READ-ONLY (SELECT works outside a tenant tx; INSERT/UPDATE denied);
 *   - tenants see NONE — an aoa_app query WITH the tenant GUC set returns zero rows;
 *   - the candidate-SHA uniqueness / idempotency key holds.
 *
 * Windows runs this only under the integration harness (AOA_RUN_WIN_INTEGRATION=1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import { applyPendingMigrations } from "../client.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "84000000-0000-4000-8000-000000000001";
const PASSWORD = "dep-003-marker-rls";
const SHA = "c".repeat(40);

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let admin: Sql | null = null;
let app: Sql | null = null;
let operator: Sql | null = null;
let setupError: unknown = null;

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) =>
        error
          ? reject(error)
          : !address || typeof address === "string"
            ? reject(new Error("port allocation failed"))
            : resolve(address.port));
    });
    server.on("error", reject);
  });
}

function clients() {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
  if (!admin || !app || !operator) throw new Error("database clients unavailable");
  return { admin, app, operator };
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-cutover-marker-rls-"));
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
    admin = postgres(url, { max: 1 });
    await admin.unsafe(`ALTER ROLE aoa_app LOGIN PASSWORD '${PASSWORD}'`);
    await admin.unsafe(`ALTER ROLE aoa_operator LOGIN PASSWORD '${PASSWORD}'`);
    app = postgres(url.replace("test:test", `aoa_app:${PASSWORD}`), { max: 1 });
    operator = postgres(url.replace("test:test", `aoa_operator:${PASSWORD}`), { max: 1 });
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await operator?.end(); } catch { /* ignore */ }
  try { await app?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "DEP-003 distributed_cutover_markers table + RLS matrix",
  () => {
    it("exists with FORCE ROW LEVEL SECURITY enabled", async () => {
      const { admin } = clients();
      const rows = await admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relname = 'distributed_cutover_markers'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.relrowsecurity).toBe(true);
      expect(rows[0]?.relforcerowsecurity).toBe(true);
    });

    it("lets aoa_operator WRITE the marker and read it back", async () => {
      const { operator } = clients();
      await operator`
        INSERT INTO distributed_cutover_markers
          (candidate_sha, snapshot_ref, snapshot_checksum, verified_at)
        VALUES (${SHA}, 's3://snap/ref', 'deadbeef', now())
      `;
      const rows = await operator<{ candidate_sha: string }[]>`
        SELECT candidate_sha FROM distributed_cutover_markers WHERE candidate_sha = ${SHA}
      `;
      expect(rows).toEqual([{ candidate_sha: SHA }]);
    });

    it("lets aoa_app READ the marker OUTSIDE a tenant transaction", async () => {
      const { app } = clients();
      const rows = await app<{ candidate_sha: string }[]>`
        SELECT candidate_sha FROM distributed_cutover_markers WHERE candidate_sha = ${SHA}
      `;
      expect(rows).toEqual([{ candidate_sha: SHA }]);
    });

    it("denies aoa_app writes (read-only)", async () => {
      const { app } = clients();
      await expect(
        app`INSERT INTO distributed_cutover_markers
          (candidate_sha, snapshot_ref, snapshot_checksum, verified_at)
          VALUES (${"d".repeat(40)}, 'x', 'y', now())`,
      ).rejects.toThrow(/permission denied/i);
      await expect(
        app`UPDATE distributed_cutover_markers SET snapshot_ref = 'tampered' WHERE candidate_sha = ${SHA}`,
      ).rejects.toThrow(/permission denied/i);
    });

    it("makes the marker INVISIBLE to a tenant (aoa_app WITH the org GUC set sees zero rows)", async () => {
      const { app } = clients();
      const visible = await app.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('aoa.organization_id', $1, true)", [ORG]);
        return tx.unsafe("SELECT candidate_sha FROM distributed_cutover_markers");
      });
      expect(visible).toHaveLength(0);
    });

    it("enforces candidate-SHA uniqueness (the idempotency key)", async () => {
      const { operator } = clients();
      await expect(
        operator`INSERT INTO distributed_cutover_markers
          (candidate_sha, snapshot_ref, snapshot_checksum, verified_at)
          VALUES (${SHA}, 's3://dup', 'dupsum', now())`,
      ).rejects.toThrow(/duplicate key|unique/i);
    });
  },
);
