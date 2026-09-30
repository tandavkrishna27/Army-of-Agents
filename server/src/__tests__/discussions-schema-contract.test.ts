import { describe, it, expect } from "vitest";
import {
  discussions,
  discussionEntries,
  discussionExtractedItems,
  discussionAnnotations,
} from "@armyofagents/db";

/**
 * Discussion Schema Contract Tests
 *
 * Verifies all 4 discussion tables have the required columns,
 * extraction tracking fields, conflict detection fields, and
 * annotation positioning fields per the discussion schema.
 */

// Helper: get column names from a Drizzle table
function getColumnNames(table: Record<string, unknown>): string[] {
  return Object.keys(table).filter(
    (key) =>
      typeof table[key] === "object" &&
      table[key] !== null &&
      "name" in (table[key] as Record<string, unknown>),
  );
}

describe("discussions table", () => {
  const cols = getColumnNames(discussions);

  it("has all required columns", () => {
    const required = [
      "id",
      "companyId",
      "title",
      "status",
      "scopeType",
      "scopeId",
      "tags",
      "entryCount",
      "pendingItemCount",
      "lastEntryAt",
      "createdBy",
      "createdAt",
      "updatedAt",
    ];
    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });

  it("has polymorphic scope fields", () => {
    expect(cols).toContain("scopeType");
    expect(cols).toContain("scopeId");
  });

  it("has denormalized count fields", () => {
    expect(cols).toContain("entryCount");
    expect(cols).toContain("pendingItemCount");
  });

  // Phase 1 (Task A2): thread-native coordination columns
  it("has Phase 1 thread coordination columns (shareToken, slackChannelId, allowMemoryExtraction, adjutantEnabled, summaryEmbedding)", () => {
    expect(cols).toContain("shareToken");
    expect(cols).toContain("slackChannelId");
    expect(cols).toContain("allowMemoryExtraction");
    expect(cols).toContain("adjutantEnabled");
    expect(cols).toContain("summaryEmbedding");
  });
});

describe("discussionEntries table", () => {
  const cols = getColumnNames(discussionEntries);

  it("has all required columns", () => {
    const required = [
      "id",
      "discussionId",
      "inputType",
      "rawContent",
      "title",
      "sourceInfo",
      "departmentId",
      "projectId",
      "goalId",
      "extractionStatus",
      "extractionRunId",
      "createdBy",
      "createdAt",
    ];
    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });

  it("has extraction tracking fields", () => {
    expect(cols).toContain("extractionStatus");
    expect(cols).toContain("extractionRunId");
  });

  it("has scope override fields (entry-level > discussion-level)", () => {
    expect(cols).toContain("departmentId");
    expect(cols).toContain("projectId");
    expect(cols).toContain("goalId");
  });
});

describe("discussionExtractedItems table", () => {
  const cols = getColumnNames(discussionExtractedItems);

  it("has all required columns", () => {
    const required = [
      "id",
      "discussionEntryId",
      "type",
      "title",
      "description",
      "suggestedPriority",
      "suggestedAssigneeId",
      "suggestedDepartmentId",
      "suggestedProjectId",
      "suggestedLayer",
      "suggestedGoalId",
      "layer",
      "priority",
      "dedupAction",
      "selectedMemoryId",
      "mergedContent",
      "status",
      "resultTaskId",
      "resultMemoryId",
      "conflictsWith",
      "createdAt",
      "updatedAt",
    ];
    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });

  it("has conflict detection fields", () => {
    expect(cols).toContain("conflictsWith");
  });

  it("has suggested goal field", () => {
    expect(cols).toContain("suggestedGoalId");
  });

  it("has memory dedup fields", () => {
    expect(cols).toContain("dedupAction");
    expect(cols).toContain("selectedMemoryId");
    expect(cols).toContain("mergedContent");
  });

  it("has founder override fields", () => {
    expect(cols).toContain("layer");
    expect(cols).toContain("priority");
  });

  it("has result link fields", () => {
    expect(cols).toContain("resultTaskId");
    expect(cols).toContain("resultMemoryId");
  });
});

describe("discussionAnnotations table", () => {
  const cols = getColumnNames(discussionAnnotations);

  it("has all required columns", () => {
    const required = [
      "id",
      "discussionEntryId",
      "content",
      "anchorStart",
      "anchorEnd",
      "createdBy",
      "createdAt",
      "updatedAt",
    ];
    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });

  it("has annotation positioning fields", () => {
    expect(cols).toContain("anchorStart");
    expect(cols).toContain("anchorEnd");
  });
});
