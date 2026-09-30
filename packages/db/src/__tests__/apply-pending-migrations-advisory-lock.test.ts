/**
 * Concurrent-replica migration safety (Finding #4).
 *
 * `applyPendingMigrations(url)` auto-applies on boot in cloud replicas (non-TTY).
 * Two replicas booting together can both observe the same pending set and race
 * non-idempotent DDL (e.g. 0188's ADD COLUMN / ADD CONSTRAINT lack IF NOT
 * EXISTS). A session-level PostgreSQL advisory lock held across the WHOLE
 * inspect+apply serializes the replicas so only one applies at a time; the loser
 * waits on the lock, then re-inspects and finds the schema already up to date.
 *
 * This is a SOURCE-STRUCTURAL test (the same technique migration-idempotency.
 * test.ts uses to pin hard-to-harness migration-runner behavior). The `db`
 * package has no postgres-mock harness, and a real two-replica RACE is not
 * deterministically reproducible in a unit test, so we assert the lock structure
 * directly on the `applyPendingMigrations` source:
 *   - a session-level `pg_advisory_lock(` is acquired BEFORE the migrate call,
 *   - the code RE-INSPECTS under the lock (a peer may have migrated while we
 *     waited), and
 *   - `pg_advisory_unlock(` runs in a `finally` so the lock is always released.
 *
 * Precedent for the advisory-lock pattern: server/src/services/
 * first-user-bootstrap.ts (pg_advisory_xact_lock(hashtext('aoa:first-admin-
 * bootstrap'))). Here we use the SESSION variant because applyPendingMigrations
 * has no surrounding transaction (the migrator opens its own per-file
 * transactions).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLIENT_SRC = join(__dirname, "..", "client.ts");

/**
 * Extract just the `applyPendingMigrations` function body so ordering
 * assertions are scoped to it (client.ts has other functions that also call
 * inspectMigrations / migratePg / postgres()).
 */
function applyPendingMigrationsSource(): string {
  const src = readFileSync(CLIENT_SRC, "utf8");
  const start = src.indexOf("export async function applyPendingMigrations");
  expect(start, "applyPendingMigrations must exist in client.ts").toBeGreaterThan(-1);
  // The next top-level `export ` after the function marks its end.
  const rest = src.slice(start + 1);
  const nextExport = rest.indexOf("\nexport ");
  const end = nextExport === -1 ? src.length : start + 1 + nextExport;
  return src.slice(start, end);
}

describe("applyPendingMigrations advisory lock (concurrent-replica safety)", () => {
  const body = applyPendingMigrationsSource();

  it("acquires a session-level pg_advisory_lock", () => {
    expect(body).toContain("pg_advisory_lock(");
  });

  it("releases the lock with pg_advisory_unlock inside a finally block", () => {
    expect(body).toContain("pg_advisory_unlock(");
    // The unlock must live in a finally so every early return still releases it.
    expect(body).toMatch(/finally\s*\{[\s\S]*pg_advisory_unlock\(/);
  });

  it("acquires the lock BEFORE running the migrator", () => {
    const lockIdx = body.indexOf("pg_advisory_lock(");
    const migrateIdx = body.indexOf("migratePg(");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(migrateIdx);
  });

  it("re-inspects migration state UNDER the lock before applying", () => {
    // A peer replica may have migrated while we waited on the lock, so there
    // must be an inspectMigrations() call between lock acquisition and the
    // migrator run.
    const lockIdx = body.indexOf("pg_advisory_lock(");
    const migrateIdx = body.indexOf("migratePg(");
    const underLock = body.slice(lockIdx, migrateIdx);
    expect(underLock).toContain("inspectMigrations(");
  });

  it("enforces the snapshot gate under the lock before every apply path", () => {
    const lockIdx = body.indexOf("pg_advisory_lock(");
    const reinspectIdx = body.indexOf("const stateUnderLock = await inspectMigrations(");
    const gateIdx = body.indexOf("assertMigrationSnapshotGate(");
    const migrateIdx = body.indexOf("migratePg(");
    const manualIdx = body.indexOf("applyPendingMigrationsManually(");

    expect(lockIdx).toBeGreaterThan(-1);
    expect(reinspectIdx).toBeGreaterThan(lockIdx);
    expect(gateIdx).toBeGreaterThan(reinspectIdx);
    expect(gateIdx).toBeLessThan(migrateIdx);
    expect(gateIdx).toBeLessThan(manualIdx);
  });

  it("reads snapshot markers only from the canonical instance-settings row", () => {
    expect(body).toContain(
      "SELECT general FROM instance_settings WHERE singleton_key = 'default'",
    );
    expect(body).not.toContain("SELECT general FROM instance_settings LIMIT 1");
  });

  it("uses a dedicated single-connection pool for the lock session", () => {
    // The lock must be held on its own connection for the whole inspect+apply.
    const lockIdx = body.indexOf("pg_advisory_lock(");
    const preamble = body.slice(0, lockIdx);
    expect(preamble).toMatch(/postgres\(\s*url\s*,\s*\{\s*max:\s*1\s*\}\s*\)/);
  });
});
