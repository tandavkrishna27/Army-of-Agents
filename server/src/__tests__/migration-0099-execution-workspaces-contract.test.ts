import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/0099_square_spectrum.sql",
);
const SNAPSHOT_0098_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/meta/0098_snapshot.json",
);
const SNAPSHOT_0099_PATH = resolve(
  __dirname,
  "../../../packages/db/src/migrations/meta/0099_snapshot.json",
);

describe("Migration 0099 - execution workspace active task uniqueness", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("deduplicates active task-owned execution workspaces before index creation", () => {
    expect(sql).toMatch(/ROW_NUMBER\(\)\s+OVER\s*\(/i);
    expect(sql).toMatch(/PARTITION BY\s+ew\.company_id,\s*ew\.source_issue_id/i);
    expect(sql).toMatch(/UPDATE\s+execution_workspaces\s+ew[\s\S]+SET\s+status\s*=\s*'archived'/i);
  });

  it("keeps the row linked from issues.execution_workspace_id first", () => {
    expect(sql).toMatch(/CASE\s+WHEN\s+i\.execution_workspace_id\s*=\s*ew\.id\s+THEN\s+0\s+ELSE\s+1\s+END/i);
  });

  it("runs cleanup before creating the unique index", () => {
    const cleanupIdx = sql.search(/UPDATE\s+execution_workspaces\s+ew[\s\S]+SET\s+status\s*=\s*'archived'/i);
    const indexIdx = sql.search(
      /CREATE\s+UNIQUE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+"execution_workspaces_active_task_workspace_uq"/i,
    );
    expect(cleanupIdx).toBeGreaterThanOrEqual(0);
    expect(indexIdx).toBeGreaterThanOrEqual(0);
    expect(cleanupIdx).toBeLessThan(indexIdx);
  });

  it("creates the expected idempotent partial unique index", () => {
    expect(sql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"execution_workspaces_active_task_workspace_uq"/i,
    );
    expect(sql).toMatch(
      /ON\s+"execution_workspaces"\s+USING\s+btree\s*\("company_id",\s*"source_issue_id"\)/i,
    );
    expect(sql).toMatch(/WHERE\s+source_issue_id\s+IS\s+NOT\s+NULL\s+AND\s+status\s*<>\s*'archived'/i);
  });

  it("carries forward the previous snapshot tables while adding the execution workspace index", () => {
    const snapshot0098 = JSON.parse(readFileSync(SNAPSHOT_0098_PATH, "utf8"));
    const snapshot0099 = JSON.parse(readFileSync(SNAPSHOT_0099_PATH, "utf8"));

    expect(snapshot0099.prevId).toBe(snapshot0098.id);
    expect(snapshot0099.tables["public.issue_context_bundles"]).toBeDefined();
    expect(snapshot0099.tables["public.issue_context_bundle_items"]).toBeDefined();
    expect(
      snapshot0099.tables["public.execution_workspaces"].indexes.execution_workspaces_active_task_workspace_uq,
    ).toBeDefined();
  });
});
