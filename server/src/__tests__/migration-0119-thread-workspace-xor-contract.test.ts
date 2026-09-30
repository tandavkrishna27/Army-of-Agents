import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Lock-in contract for Task A4 — the final Phase A schema task. Two coordinated
// additions that downstream services (thread-events Adjutant debounce in Phase B,
// Engineer per-thread workspaces in Phase B) depend on landing together:
//
//   1. agent_wakeup_requests.dedup_key + partial unique index gated on
//      status = 'queued' AND dedup_key IS NOT NULL.
//   2. execution_workspaces.thread_id (nullable FK → discussions ON DELETE SET NULL)
//      + companion index + active-thread-workspace partial unique index
//      + XOR CHECK constraint (thread_id IS NULL) <> (source_issue_id IS NULL).
//
// If any of these regress, the dispatcher dedup story or the per-thread
// Engineer workspace flow silently breaks — hence the contract test.

const MIGRATION_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/0119_chilly_tempest.sql",
);

const SNAPSHOT_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/meta/0119_snapshot.json",
);

describe("Migration 0119 — Task A4 dedupKey + thread workspace XOR", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("adds the dedup_key column to agent_wakeup_requests", () => {
    expect(sql).toMatch(
      /ALTER TABLE "agent_wakeup_requests" ADD COLUMN "dedup_key" text/i,
    );
  });

  it("creates the partial unique index on dedup_key gated on queued + NOT NULL", () => {
    // CREATE … (UNIQUE )?INDEX (IF NOT EXISTS )? — the IF NOT EXISTS is required
    // by migration-idempotency.test.ts (C14 closure).
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_dedup_key_queued_uq"[\s\S]+USING btree \("dedup_key"\)/i,
    );
    // WHERE clause must include both filters — queued AND dedup_key IS NOT NULL.
    // Without status='queued', historical rows would block new dedup keys.
    // Without IS NOT NULL, rows with NULL dedupKey would collide under unique
    // index semantics on Postgres (NULL ≠ NULL but uniqueness still applies).
    expect(sql).toMatch(/WHERE status = 'queued' AND dedup_key IS NOT NULL/i);
  });

  it("adds the thread_id column to execution_workspaces", () => {
    expect(sql).toMatch(
      /ALTER TABLE "execution_workspaces" ADD COLUMN "thread_id" uuid/i,
    );
  });

  it("adds an FK from execution_workspaces.thread_id to discussions.id with ON DELETE set null", () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "execution_workspaces_thread_id_discussions_id_fk"[\s\S]+FOREIGN KEY \("thread_id"\)[\s\S]+REFERENCES "public"\."discussions"\("id"\)[\s\S]+ON DELETE set null/i,
    );
  });

  it("adds the active-thread-workspace partial unique index mirroring the per-task pattern", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "execution_workspaces_active_thread_workspace_uq"[\s\S]+USING btree \("company_id","thread_id"\)/i,
    );
    expect(sql).toMatch(/WHERE thread_id IS NOT NULL AND status <> 'archived'/i);
  });

  it("adds the (company_id, thread_id) lookup index", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "execution_workspaces_company_thread_idx"[\s\S]+USING btree \("company_id","thread_id"\)/i,
    );
  });

  it("enforces the XOR invariant via CHECK constraint", () => {
    // The constraint must reference both columns and use the SQL XOR operator
    // <> (true-not-equal-true / false-not-equal-false → false; true-not-equal-false → true).
    // Equivalent forms like `BOOL_XOR(...)` or `NOT (thread_id IS NULL AND source_issue_id IS NULL) AND NOT (...)`
    // would also work, but the spec calls out this specific shape.
    expect(sql).toMatch(
      /ADD CONSTRAINT "execution_workspaces_thread_or_issue_xor"[\s\S]+CHECK\s*\(\(thread_id IS NULL\)\s*<>\s*\(source_issue_id IS NULL\)\)/i,
    );
  });

  it("runs the XOR CHECK after the thread_id column is added", () => {
    const colAdd = sql.search(/ADD COLUMN "thread_id" uuid/i);
    // Anchor to the ADD CONSTRAINT statement rather than the bare name —
    // the constraint name appears in the leading comment block too, which
    // would produce a false-positive "before column" location.
    const xorCheck = sql.search(/ADD CONSTRAINT "execution_workspaces_thread_or_issue_xor"/i);
    expect(colAdd).toBeGreaterThanOrEqual(0);
    expect(xorCheck).toBeGreaterThanOrEqual(0);
    expect(colAdd).toBeLessThan(xorCheck);
  });
});

describe("Migration 0119 snapshot — Drizzle metadata captures the new schema", () => {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));

  function wakeupColumns(): Record<string, unknown> {
    const table =
      snapshot?.tables?.["public.agent_wakeup_requests"] ??
      snapshot?.tables?.["agent_wakeup_requests"];
    if (!table) throw new Error("agent_wakeup_requests table not present in 0119 snapshot");
    return table.columns ?? {};
  }

  function wakeupIndexes(): Record<string, unknown> {
    const table =
      snapshot?.tables?.["public.agent_wakeup_requests"] ??
      snapshot?.tables?.["agent_wakeup_requests"];
    return (table?.indexes as Record<string, unknown>) ?? {};
  }

  function executionWorkspacesColumns(): Record<string, unknown> {
    const table =
      snapshot?.tables?.["public.execution_workspaces"] ??
      snapshot?.tables?.["execution_workspaces"];
    if (!table) throw new Error("execution_workspaces table not present in 0119 snapshot");
    return table.columns ?? {};
  }

  function executionWorkspacesIndexes(): Record<string, unknown> {
    const table =
      snapshot?.tables?.["public.execution_workspaces"] ??
      snapshot?.tables?.["execution_workspaces"];
    return (table?.indexes as Record<string, unknown>) ?? {};
  }

  it("records the dedup_key column on agent_wakeup_requests", () => {
    const columns = wakeupColumns();
    expect(columns).toHaveProperty("dedup_key");
    const col = columns["dedup_key"] as { type?: string; notNull?: boolean } | undefined;
    expect(col?.type).toBe("text");
    expect(col?.notNull).not.toBe(true); // nullable
  });

  it("records the partial unique index on dedup_key", () => {
    const indexes = wakeupIndexes();
    expect(indexes).toHaveProperty("agent_wakeup_requests_dedup_key_queued_uq");
  });

  it("records the thread_id column on execution_workspaces", () => {
    const columns = executionWorkspacesColumns();
    expect(columns).toHaveProperty("thread_id");
    const col = columns["thread_id"] as { type?: string; notNull?: boolean } | undefined;
    expect(col?.type).toBe("uuid");
    expect(col?.notNull).not.toBe(true); // nullable, gated by XOR with source_issue_id
  });

  it("records both new execution_workspaces indexes", () => {
    const indexes = executionWorkspacesIndexes();
    expect(indexes).toHaveProperty("execution_workspaces_company_thread_idx");
    expect(indexes).toHaveProperty("execution_workspaces_active_thread_workspace_uq");
  });

  it("links 0119 snapshot to 0118", () => {
    const snapshot0118 = JSON.parse(
      readFileSync(
        resolve(__dirname, "../../../packages/db/src/migrations/meta/0118_snapshot.json"),
        "utf8",
      ),
    );
    expect(snapshot.prevId).toBe(snapshot0118.id);
  });
});
