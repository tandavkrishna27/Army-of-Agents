import { describe, it, expect } from "vitest";
import {
  discussions,
  discussionEntries,
  discussionExtractedItems,
  projects,
  threadParticipants,
  threadLinks,
  scopeItemDependencies,
  threadPlanSteps,
  threadInboxItems,
  discussionEntryAttachments,
} from "@armyofagents/db";

// Helper: get Drizzle column names from a table object.
function getColumnNames(table: Record<string, unknown>): string[] {
  return Object.keys(table).filter(
    (key) =>
      typeof table[key] === "object" &&
      table[key] !== null &&
      "name" in (table[key] as Record<string, unknown>),
  );
}

describe("discussions table — thread-container columns", () => {
  const cols = getColumnNames(discussions);

  it("has the thread origin/intent/phase columns", () => {
    for (const c of ["originSource", "originMedium", "intent", "phase"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });

  it("has goal-as-property + visibility + owner", () => {
    for (const c of ["goalId", "visibility", "ownerUserId"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });

  it("has autonomy + subtype + fork/merge lineage", () => {
    for (const c of ["autonomyLevel", "subtype", "forkedFromId", "mergedIntoId"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });

  it("has the Scribe summary fields", () => {
    for (const c of ["summaryText", "summaryNext", "summaryUpdatedAt"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });

  it("has entrySeq counter (for Plan 7 atomic seq assignment)", () => {
    expect(cols).toContain("entrySeq");
  });

  it("preserves existing discussion columns", () => {
    for (const c of ["id", "companyId", "title", "status", "scopeType", "tags"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });
});

describe("discussion_entries table — thread additions", () => {
  const cols = getColumnNames(discussionEntries);

  it("has nested-reply parent + agent author", () => {
    expect(cols).toContain("parentEntryId");
    expect(cols).toContain("authorAgentId");
  });

  it("preserves existing entry columns", () => {
    for (const c of ["id", "discussionId", "inputType", "rawContent", "extractionStatus"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });
});

describe("discussion_extracted_items table — committed routing", () => {
  const cols = getColumnNames(discussionExtractedItems);

  it("has committed agent|human assignee + department", () => {
    expect(cols).toContain("assigneeAgentId");
    expect(cols).toContain("assigneeUserId");
    expect(cols).toContain("departmentId");
  });

  it("preserves the suggested* fields + result links", () => {
    for (const c of ["suggestedDepartmentId", "suggestedAssigneeId", "resultTaskId", "resultMemoryId", "conflictsWith"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });
});

describe("projects table — per-department thread visibility default", () => {
  const cols = getColumnNames(projects);

  it("has defaultThreadVisibility", () => {
    expect(cols).toContain("defaultThreadVisibility");
  });

  it("preserves the department/project type discriminator", () => {
    expect(cols).toContain("type");
  });
});

describe("threads.ts — new tables", () => {
  it("thread_participants has principal + role + unique constraint", () => {
    const cols = getColumnNames(threadParticipants);
    for (const c of ["id", "companyId", "threadId", "principalType", "principalId", "role", "addedAt"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });

  it("thread_links has from/to + kind", () => {
    const cols = getColumnNames(threadLinks);
    for (const c of ["id", "companyId", "fromThreadId", "toThreadId", "kind", "createdBy"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });

  it("scope_item_dependencies has blocker/blocked", () => {
    const cols = getColumnNames(scopeItemDependencies);
    for (const c of ["id", "blockerItemId", "blockedItemId"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });

  it("thread_plan_steps has ordering + linked item", () => {
    const cols = getColumnNames(threadPlanSteps);
    for (const c of ["id", "threadId", "stepOrder", "title", "collapsed", "linkedItemId"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });

  it("thread_inbox_items has router fields + status", () => {
    const cols = getColumnNames(threadInboxItems);
    for (const c of ["id", "companyId", "rawContent", "routerConfidence", "routerDecision", "suggestedThreadId", "status"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });

  it("discussion_entry_attachments links assets/artifacts to entries", () => {
    const cols = getColumnNames(discussionEntryAttachments);
    for (const c of ["id", "discussionEntryId", "assetId", "artifactId"]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });
});
