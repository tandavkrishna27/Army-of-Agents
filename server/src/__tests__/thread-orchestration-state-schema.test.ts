import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Contract test for P1-T2 — the per-thread orchestration controller table.
//
// This test reads the generated migration SQL and snapshot JSON directly so
// it passes without a live database (embedded-postgres is flaky on Windows).
// It locks the structural invariants that downstream Phase 1 work depends on:
//
//   1. The table itself is created.
//   2. thread_id has a UNIQUE constraint (one controller per thread).
//   3. FK: thread_id → discussions.id ON DELETE cascade.
//   4. FK: last_processed_entry_id → discussion_entries.id ON DELETE set null.

const MIGRATION_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/0124_pale_vapor.sql",
);

const SNAPSHOT_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/meta/0124_snapshot.json",
);

describe("Migration 0124 — P1-T2 thread_orchestration_state controller table", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("creates the thread_orchestration_state table", () => {
    // `IF NOT EXISTS` is the repo's idempotent-migration convention (enforced by
    // migration-idempotency.test.ts); the table name match tolerates it.
    expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?"thread_orchestration_state"/i);
  });

  it("defines thread_id as NOT NULL uuid", () => {
    expect(sql).toMatch(/"thread_id" uuid NOT NULL/i);
  });

  it("adds a UNIQUE constraint on thread_id (one controller per thread)", () => {
    expect(sql).toMatch(
      /CONSTRAINT "thread_orchestration_state_thread_id_unique" UNIQUE\("thread_id"\)/i,
    );
  });

  it("adds FK from thread_id to discussions.id with ON DELETE cascade", () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "thread_orchestration_state_thread_id_discussions_id_fk"[\s\S]+FOREIGN KEY \("thread_id"\)[\s\S]+REFERENCES "public"\."discussions"\("id"\)[\s\S]+ON DELETE cascade/i,
    );
  });

  it("adds FK from last_processed_entry_id to discussion_entries.id with ON DELETE set null", () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "thread_orchestration_state_last_processed_entry_id_discussion_entries_id_fk"[\s\S]+FOREIGN KEY \("last_processed_entry_id"\)[\s\S]+REFERENCES "public"\."discussion_entries"\("id"\)[\s\S]+ON DELETE set null/i,
    );
  });

  it("last_processed_entry_id is nullable (the read cursor may be unset)", () => {
    // A nullable column has NO "NOT NULL" qualifier after the column definition.
    // We check the column appears without NOT NULL.
    expect(sql).toMatch(/"last_processed_entry_id" uuid[^,\n]*,/i);
    // The substring "last_processed_entry_id" uuid NOT NULL must not appear.
    expect(sql).not.toMatch(/"last_processed_entry_id" uuid NOT NULL/i);
  });

  it("run_epoch has integer type with default 0 and NOT NULL", () => {
    expect(sql).toMatch(/"run_epoch" integer DEFAULT 0 NOT NULL/i);
  });

  it("pending_run is boolean NOT NULL defaulting to false", () => {
    expect(sql).toMatch(/"pending_run" boolean DEFAULT false NOT NULL/i);
  });

  it("hop_count is integer NOT NULL defaulting to 0", () => {
    expect(sql).toMatch(/"hop_count" integer DEFAULT 0 NOT NULL/i);
  });

  it("status is text NOT NULL defaulting to active", () => {
    expect(sql).toMatch(/"status" text DEFAULT 'active' NOT NULL/i);
  });

  it("includes created_at and updated_at timestamps with timezone and default now()", () => {
    expect(sql).toMatch(/"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/i);
    expect(sql).toMatch(/"updated_at" timestamp with time zone DEFAULT now\(\) NOT NULL/i);
  });
});

describe("Migration 0124 snapshot — Drizzle metadata captures thread_orchestration_state", () => {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));

  function tableData(): { columns?: Record<string, unknown>; indexes?: Record<string, unknown>; uniqueConstraints?: Record<string, unknown> } {
    const tbl =
      snapshot?.tables?.["public.thread_orchestration_state"] ??
      snapshot?.tables?.["thread_orchestration_state"];
    if (!tbl) throw new Error("thread_orchestration_state table not present in 0124 snapshot");
    return tbl as { columns?: Record<string, unknown>; indexes?: Record<string, unknown>; uniqueConstraints?: Record<string, unknown> };
  }

  it("records all required columns in the snapshot", () => {
    const columns = tableData().columns ?? {};
    for (const col of [
      "id",
      "thread_id",
      "last_processed_entry_id",
      "run_epoch",
      "pending_run",
      "hop_count",
      "last_error",
      "status",
      "created_at",
      "updated_at",
    ]) {
      expect(columns, `column '${col}' missing from snapshot`).toHaveProperty(col);
    }
  });

  it("records thread_id as uuid and NOT NULL", () => {
    const col = (tableData().columns ?? {})["thread_id"] as
      | { type?: string; notNull?: boolean }
      | undefined;
    expect(col?.type).toBe("uuid");
    expect(col?.notNull).toBe(true);
  });

  it("records last_processed_entry_id as uuid and nullable", () => {
    const col = (tableData().columns ?? {})["last_processed_entry_id"] as
      | { type?: string; notNull?: boolean }
      | undefined;
    expect(col?.type).toBe("uuid");
    expect(col?.notNull).not.toBe(true);
  });

  it("records the unique constraint on thread_id", () => {
    const constraints = tableData().uniqueConstraints ?? {};
    // Drizzle snapshots store unique constraints keyed by constraint name
    expect(constraints).toHaveProperty(
      "thread_orchestration_state_thread_id_unique",
    );
  });

  it("links snapshot 0124 to predecessor snapshot 0122", () => {
    // Validate the Drizzle snapshot chain is intact. 0123 was a SQL-only stub
    // migration (no schema model changes) so Drizzle did not generate a
    // 0123_snapshot.json — it skipped straight to 0122 as the prevId base.
    const snapshot0122 = JSON.parse(
      readFileSync(
        resolve(
          __dirname,
          "../../../packages/db/src/migrations/meta/0122_snapshot.json",
        ),
        "utf8",
      ),
    );
    expect(snapshot.prevId).toBe(snapshot0122.id);
  });
});
