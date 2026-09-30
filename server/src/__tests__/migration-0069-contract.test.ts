import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// I1 (comprehensive-review fixup) regression-prevention. The migration
// at 0069_wide_earthquake.sql adds a partial unique index that will
// abort with 23505 on production clusters that have pre-existing
// duplicate published rows from the pre-Task-1 TOCTOU race. The
// cleanup statement archives all but the most-recent published row
// per team BEFORE the index creation runs.
//
// Full integration testing (apply migration to a real cluster with
// duplicate rows, assert the cleanup actually deduplicates) requires
// new test infrastructure. This structural test catches the bare
// minimum: cleanup statement exists, has the right shape, and
// precedes the unique index creation.
//
// If a future contributor deletes the cleanup or moves it after the
// index, this test fails — the intent was to prevent exactly that
// regression.

const MIGRATION_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/0069_wide_earthquake.sql",
);

describe("Migration 0069 — pre-flight cleanup (I1 backstop)", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("contains a ROW_NUMBER() OVER (PARTITION BY team_id) windowed dedupe", () => {
    expect(sql).toMatch(/ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION BY team_id/i);
  });

  it("archives duplicate published rows (UPDATE ... SET status = 'archived')", () => {
    expect(sql).toMatch(/UPDATE\s+team_coordinations[\s\S]+SET status\s*=\s*'archived'/i);
  });

  it("orders the cleanup by updated_at DESC, created_at DESC", () => {
    // Keeps the most-recent published row, archives the older duplicate(s).
    expect(sql).toMatch(/ORDER BY updated_at DESC, created_at DESC/i);
  });

  it("filters cleanup to status = 'published' rows only", () => {
    // The CTE's source table predicate must scope to published rows;
    // archived rows already abide by the invariant.
    expect(sql).toMatch(/WHERE status\s*=\s*'published'/);
  });

  it("the cleanup runs BEFORE the CREATE UNIQUE INDEX statement", () => {
    // Critical ordering invariant: dedupe → then index. Reversed, the
    // index creation aborts before the cleanup gets a chance to run.
    const cleanupIdx = sql.search(/UPDATE\s+team_coordinations\s+SET status\s*=\s*'archived'/i);
    const indexIdx = sql.search(/CREATE UNIQUE INDEX(?:\s+IF NOT EXISTS)?\s+"team_coordinations_one_published_uq"/);
    expect(cleanupIdx).toBeGreaterThanOrEqual(0);
    expect(indexIdx).toBeGreaterThanOrEqual(0);
    expect(cleanupIdx).toBeLessThan(indexIdx);
  });

  it("preserves the 3 generated statements (idempotent form ok)", () => {
    // Originally these were emitted as plain CREATE UNIQUE INDEX / ALTER TABLE
    // ADD CONSTRAINT statements. We made them idempotent (CREATE UNIQUE INDEX
    // IF NOT EXISTS + DO-block constraint guards) to allow re-running on
    // partial-apply states (where index/constraints exist but the migration
    // wasn't recorded in __drizzle_migrations). The intent — index + 2
    // constraints exist after the migration — is preserved either way.
    expect(sql).toMatch(/CREATE UNIQUE INDEX(?:\s+IF NOT EXISTS)?\s+"team_coordinations_one_published_uq"\s+ON\s+"team_coordinations"\s+USING btree\s*\("team_id"\)\s+WHERE status\s*=\s*'published'/);
    expect(sql).toMatch(/ALTER TABLE\s+"teams"\s+ADD CONSTRAINT\s+"teams_status_check"\s+CHECK \(status IN \('active', 'archived'\)\)/);
    expect(sql).toMatch(/ALTER TABLE\s+"team_coordinations"\s+ADD CONSTRAINT\s+"team_coordinations_status_check"\s+CHECK \(status IN \('draft', 'published', 'archived'\)\)/);
  });
});
