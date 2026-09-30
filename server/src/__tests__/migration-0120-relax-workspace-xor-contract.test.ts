import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Lock-in contract for the corrective migration 0120 — surfaced by
// /investigate during Phase A → Phase B transition.
//
// Background: 0119 added a STRICT XOR check `(thread_id IS NULL) <> (source_issue_id IS NULL)`
// which inadvertently rejects the previously-valid "project-scoped agent
// workspace" state (both columns NULL — reached via heartbeat.ts:2702 when an
// agent runs without an assigned issue but with a resolved project).
//
// 0120 drops the strict XOR and replaces it with "not both set" — the actual
// invariant we want. See the migration file header for the full reasoning.

const MIGRATION_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/0120_relax_workspace_xor.sql",
);

describe("Migration 0120 — relax workspace XOR to 'not both set'", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("drops the strict XOR constraint added in 0119", () => {
    expect(sql).toMatch(
      /DROP CONSTRAINT IF EXISTS "execution_workspaces_thread_or_issue_xor"/i,
    );
  });

  it("adds the relaxed 'not both set' constraint", () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "execution_workspaces_not_both_thread_and_issue"/i,
    );
    expect(sql).toMatch(
      /CHECK\s*\(NOT\s*\(thread_id IS NOT NULL AND source_issue_id IS NOT NULL\)\)/i,
    );
  });

  it("DROPs the old constraint before adding the new one (apply order)", () => {
    const dropAt = sql.search(/DROP CONSTRAINT IF EXISTS "execution_workspaces_thread_or_issue_xor"/i);
    const addAt = sql.search(/ADD CONSTRAINT "execution_workspaces_not_both_thread_and_issue"/i);
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(addAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeLessThan(addAt);
  });

  it("documents the root cause in the migration header", () => {
    // The migration header should explain WHY this corrective migration exists,
    // pointing to the heartbeat code path and the createTaskOwnedIdempotent
    // null fallback. Future engineers reading the migration history should be
    // able to understand the regression without spelunking through git blame.
    expect(sql).toMatch(/heartbeat\.ts/i);
    expect(sql).toMatch(/createTaskOwnedIdempotent/i);
    expect(sql).toMatch(/project-scoped/i);
  });
});
