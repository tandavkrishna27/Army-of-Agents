import { describe, expect, it } from "vitest";
import {
  classifyCockpitRelationship,
  cockpitPresentationSchema,
  createCockpitAttentionSignal,
  matchesCockpitAttentionFilter,
} from "../cockpit-presentation.js";

function relationship(overrides: Partial<Parameters<typeof classifyCockpitRelationship>[0]> = {}) {
  return classifyCockpitRelationship({
    assignedToCurrentUser: false,
    responsibleForTask: false,
    executedByAnother: false,
    inReportingScope: false,
    explicitlyFollowed: false,
    hasRequiredAction: false,
    ...overrides,
  });
}

describe("Cockpit presentation relationship contract", () => {
  it("keeps personal work in To do", () => {
    expect(relationship({ assignedToCurrentUser: true })).toBe("to_do");
    expect(relationship({ responsibleForTask: true })).toBe("to_do");
  });

  it("keeps accountable delegated and reporting work in Managing", () => {
    expect(relationship({ responsibleForTask: true, executedByAnother: true })).toBe("managing");
    expect(relationship({ inReportingScope: true })).toBe("managing");
  });

  it("does not move Managing or Following work when it needs attention", () => {
    expect(relationship({ inReportingScope: true, hasRequiredAction: true })).toBe("managing");
    expect(relationship({ explicitlyFollowed: true, hasRequiredAction: true })).toBe("following");
  });

  it("uses To do only as the fallback home for an otherwise unrelated required action", () => {
    expect(relationship({ hasRequiredAction: true })).toBe("to_do");
    expect(relationship()).toBeNull();
  });
});

describe("Cockpit attention contract", () => {
  it("classifies required actions, risks, execution, and change independently", () => {
    const question = createCockpitAttentionSignal("question", "Needs your answer");
    const overdue = createCockpitAttentionSignal("overdue", "Overdue");
    const running = createCockpitAttentionSignal("running", "Running");

    expect(question).toMatchObject({ category: "required_action", needsMe: true, atRisk: false });
    expect(overdue).toMatchObject({ category: "risk", needsMe: false, atRisk: true });
    expect(running).toMatchObject({ category: "execution", needsMe: false, atRisk: false });
    expect(matchesCockpitAttentionFilter([question], "needs_me")).toBe(true);
    expect(matchesCockpitAttentionFilter([overdue], "at_risk")).toBe(true);
    expect(matchesCockpitAttentionFilter([running], "needs_me")).toBe(false);
  });
});

describe("Cockpit v3 schema", () => {
  it("accepts a typed Workspace action and linked question", () => {
    const attention = createCockpitAttentionSignal("question", "Question - Needs you");
    const target = {
      surface: "workspace" as const,
      issueId: "task-1",
      anchor: { kind: "question" as const, id: "question-1" },
    };
    const result = cockpitPresentationSchema.safeParse({
      version: 3,
      activeFilter: "all",
      filterCounts: { all: 1, needsMe: 1, atRisk: 0 },
      sections: [{
        id: "my_work",
        groups: [{
          id: "managing",
          title: "Managing",
          total: 1,
          nextCursor: null,
          items: [{
            key: "task:task-1",
            primaryRef: { kind: "task", id: "task-1" },
            title: "Validate the first customer segment",
            subtitle: "Maya Product Analyst",
            relationship: "managing",
            groupId: "managing",
            attention: [attention],
            actions: [{
              id: "question-1",
              kind: "question",
              workflowRef: { kind: "work_question", id: "question-1" },
              relatedRefs: [{ kind: "task", id: "task-1" }],
              label: "Answer",
              attention,
              openTarget: target,
            }],
            primaryActionId: "question-1",
            openTarget: target,
            updatedAt: "2026-07-12T12:00:00.000Z",
          }],
        }],
      }],
      meta: { generatedAt: "2026-07-12T12:00:00.000Z", partial: false, slices: {} },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an invalid primary action reference", () => {
    const parsed = cockpitPresentationSchema.safeParse({
      version: 3,
      activeFilter: "all",
      filterCounts: { all: 1, needsMe: 0, atRisk: 0 },
      sections: [{
        id: "context",
        groups: [{
          id: "notes",
          title: "Notes",
          total: 1,
          nextCursor: null,
          items: [{
            key: "note:1",
            primaryRef: { kind: "note", id: "1" },
            title: "Follow up",
            subtitle: null,
            relationship: null,
            groupId: null,
            attention: [],
            actions: [],
            primaryActionId: "missing",
            openTarget: { surface: "note", noteId: "1" },
            updatedAt: "2026-07-12T12:00:00.000Z",
          }],
        }],
      }],
      meta: { generatedAt: "2026-07-12T12:00:00.000Z", partial: false, slices: {} },
    });

    expect(parsed.success).toBe(false);
  });
});
