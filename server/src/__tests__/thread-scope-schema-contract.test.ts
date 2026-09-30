import { describe, expect, it } from "vitest";
import {
  issues,
  threadScopeArtifactLinks,
  threadScopeItems,
  threadScopeVersions,
} from "@armyofagents/db";

function columnNames(table: Record<string, unknown>) {
  return new Set(Object.keys(table));
}

describe("thread scope schema contract", () => {
  it("exports thread_scope_versions columns", () => {
    const cols = columnNames(threadScopeVersions);
    for (const name of [
      "id",
      "companyId",
      "threadId",
      "versionNumber",
      "status",
      "sourceStartSeq",
      "sourceEndSeq",
      "baseVersionId",
      "proposalEntryId",
      "summary",
      "assumptions",
      "decisions",
      "openQuestions",
      "acceptedAt",
      "completedAt",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("exports thread_scope_items columns", () => {
    const cols = columnNames(threadScopeItems);
    for (const name of [
      "id",
      "companyId",
      "scopeVersionId",
      "kind",
      "status",
      "payload",
      "sourceEntryIds",
      "targetIssueId",
      "resultIssueId",
      "resultMemoryId",
      "artifactId",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
    // W1a: assignee is carried in payload — there is NO dedicated assignee column
    expect(cols.has("assigneeAgentId")).toBe(false);
  });

  it("exports artifact links and issue scopeVersionId", () => {
    expect(columnNames(threadScopeArtifactLinks).has("scopeVersionId")).toBe(true);
    expect(columnNames(issues).has("scopeVersionId")).toBe(true);
  });
});
