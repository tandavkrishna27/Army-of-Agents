import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { threadAgentActions, discussionEntries, artifacts, threadScopeItems } from "@armyofagents/db";

function columnNames(table: Record<string, unknown>) {
  return new Set(Object.keys(table));
}

describe("thread agent actions schema contract", () => {
  it("exports action gate columns", () => {
    const cols = columnNames(threadAgentActions as unknown as Record<string, unknown>);

    for (const name of [
      "id",
      "companyId",
      "threadId",
      "runId",
      "agentId",
      "actionType",
      "status",
      "payload",
      "idempotencyKey",
      "freshness",
      "attemptCount",
      "maxAttempts",
      "blockedReason",
      "committedEntryId",
      "committedScopeVersionId",
      "committedScopeItemId",
      "createdAt",
      "committedAt",
      "updatedAt",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
  });
});

describe("sourceActionId idempotency schema (#197)", () => {
  it("discussion_entries and artifacts expose a sourceActionId column", () => {
    expect(
      columnNames(discussionEntries as unknown as Record<string, unknown>).has("sourceActionId"),
    ).toBe(true);
    expect(
      columnNames(artifacts as unknown as Record<string, unknown>).has("sourceActionId"),
    ).toBe(true);
  });

  it("thread_scope_items exposes a sourceActionId column (#198 PR-A)", () => {
    expect(
      columnNames(threadScopeItems as unknown as Record<string, unknown>).has("sourceActionId"),
    ).toBe(true);
  });

  it("the generated migration creates the two idempotent partial unique indexes", () => {
    // Three '../' from server/src/__tests__ reaches the worktree root.
    const migDir = join(__dirname, "../../../packages/db/src/migrations");
    // Scan the migration that introduces source_action_id (the newest one that
    // mentions it) rather than hard-coding a generated filename.
    const sql = readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(migDir, f), "utf8"))
      .filter((s) => s.includes("source_action_id"))
      .join("\n");
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS[^;]*discussion_entries[^;]*source_action_id/s,
    );
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS[^;]*artifacts[^;]*source_action_id/s);
    expect(sql).toMatch(/WHERE[^;]*source_action_id[^;]*IS NOT NULL/s);
  });

  it("the generated migration creates the thread_scope_items idempotent partial unique index (#198 PR-A)", () => {
    const migDir = join(__dirname, "../../../packages/db/src/migrations");
    const sql = readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(migDir, f), "utf8"))
      .filter((s) => s.includes("source_action_id"))
      .join("\n");
    expect(sql).toContain("thread_scope_items_source_action_uq");
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS[^;]*thread_scope_items[^;]*source_action_id/s,
    );
    expect(sql).toMatch(/WHERE[^;]*source_action_id[^;]*IS NOT NULL/s);
  });
});
