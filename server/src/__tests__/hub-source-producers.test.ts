import { describe, expect, it } from "vitest";
import {
  buildApprovalHubEmit,
  buildDiscussionPendingHubEmit,
  buildExtractionFailedHubEmit,
  buildJoinRequestHubEmit,
  buildRoutineFailedHubEmit,
  buildStaleIssueHubEmit,
  buildSuggestionHubEmit,
  formatExtractionFailureGuidance,
} from "../services/hub-source-producers.js";

describe("hub source producers", () => {
  it("maps pending approvals to approval_request in Waiting on you", () => {
    const emit = buildApprovalHubEmit({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      payload: { name: "Scout" },
      createdAt: new Date("2026-06-29T00:00:00Z"),
      updatedAt: new Date("2026-06-29T00:00:00Z"),
    });

    expect(emit).toMatchObject({
      companyId: "company-1",
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: "approval-1",
      ownerPool: "board",
      sourceActorType: "agent",
      sourceActorId: "agent-1",
      summary: "Agent: Scout",
    });
    expect(emit.title).toContain("hire agent");
  });

  it("maps join requests to founder-gated join_request items", () => {
    const emit = buildJoinRequestHubEmit({
      id: "join-1",
      companyId: "company-1",
      requestType: "agent",
      status: "pending_approval",
      agentName: "OpenClaw Worker",
      requestEmailSnapshot: null,
      adapterType: "openclaw",
      createdAt: new Date("2026-06-29T00:00:00Z"),
      updatedAt: new Date("2026-06-29T00:00:00Z"),
    });

    expect(emit).toMatchObject({
      semanticType: "join_request",
      sourceType: "join_request",
      sourceId: "join-1",
      ownerPool: "board",
    });
    expect(emit.title).toContain("OpenClaw Worker");
  });

  it("maps pending discussions to discussion_pending items with owner and scope", () => {
    const emit = buildDiscussionPendingHubEmit({
      id: "discussion-1",
      companyId: "company-1",
      title: "Q3 planning",
      ownerUserId: "user-1",
      scopeType: "project",
      scopeId: "project-1",
      lastPendingActorType: "agent",
      lastPendingActorId: "agent-1",
      pendingItemCount: 3,
      updatedAt: new Date("2026-06-29T00:00:00Z"),
    });

    expect(emit).toMatchObject({
      semanticType: "discussion_pending",
      sourceType: "discussion",
      sourceId: "discussion-1",
      ownerUserId: "user-1",
      scopeKey: "project-1",
      sourceActorType: "agent",
      sourceActorId: "agent-1",
      title: "Review 3 pending items in Q3 planning",
    });
  });

  it("maps pending suggestions to suggestions lane items", () => {
    const emit = buildSuggestionHubEmit({
      id: "suggestion-1",
      companyId: "company-1",
      category: "risk_flag",
      title: "Goal is at risk",
      evidence: "No activity for 14 days.",
      status: "pending",
      createdAt: new Date("2026-06-29T00:00:00Z"),
      updatedAt: new Date("2026-06-29T00:00:00Z"),
    });

    expect(emit).toMatchObject({
      semanticType: "suggestion",
      sourceType: "suggestion",
      sourceId: "suggestion-1",
      title: "Goal is at risk",
      summary: "No activity for 14 days.",
    });
  });

  it("maps stale issues to stale_work without going through suggestions", () => {
    const emit = buildStaleIssueHubEmit({
      id: "issue-1",
      companyId: "company-1",
      title: "Draft launch copy",
      assigneeUserId: "user-1",
      assigneeAgentId: null,
      status: "todo",
      updatedAt: new Date("2026-06-20T00:00:00Z"),
    });

    expect(emit).toMatchObject({
      semanticType: "stale_work",
      sourceType: "issue",
      sourceId: "issue-1",
      ownerUserId: "user-1",
      title: "Stale task: Draft launch copy",
    });
  });

  it("keeps agent-assigned stale issues in stale_work parity with old Inbox", () => {
    const emit = buildStaleIssueHubEmit({
      id: "issue-1",
      companyId: "company-1",
      title: "Draft launch copy",
      assigneeUserId: null,
      assigneeAgentId: "agent-1",
      status: "in_progress",
      updatedAt: new Date("2026-06-20T00:00:00Z"),
    });

    expect(emit).toMatchObject({
      semanticType: "stale_work",
      sourceType: "issue",
      sourceId: "issue-1",
      sourceActorType: "agent",
      sourceActorId: "agent-1",
      title: "Stale task: Draft launch copy",
    });
  });

  it("accepts DB timestamp strings for source permission revisions", () => {
    const updatedAt = "2026-06-29T00:00:00.000Z";

    const emit = buildApprovalHubEmit({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "user-1",
      payload: {},
      updatedAt,
    } as never);

    expect(emit.sourcePermissionRevision).toBe(updatedAt);
  });

  it("maps a failed extraction to extraction_failed keyed on the entry id", () => {
    const emit = buildExtractionFailedHubEmit({
      entryId: "entry-1",
      discussionId: "discussion-1",
      companyId: "company-1",
      discussionTitle: "Q3 planning",
      ownerUserId: "user-1",
      failureKind: "not_installed",
      failureMessage: "codex CLI not found",
      updatedAt: new Date("2026-07-04T00:00:00Z"),
    });

    expect(emit).toMatchObject({
      companyId: "company-1",
      semanticType: "extraction_failed",
      // NOT "discussion" — avoids the discussion_pending-scoped reconciler.
      sourceType: "discussion_entry",
      sourceId: "entry-1",
      ownerUserId: "user-1",
      relatedEntityType: "discussion",
      relatedEntityId: "discussion-1",
      priority: "high",
      title: "Extraction failed in Q3 planning",
    });
    // Summary carries the classified failure-type guidance, not the raw error.
    expect(emit.summary).toBe("codex CLI not found");
  });

  it("falls back to a generic title and guidance when the discussion has no title", () => {
    const emit = buildExtractionFailedHubEmit({
      entryId: "entry-2",
      discussionId: "discussion-2",
      companyId: "company-1",
      discussionTitle: null,
      ownerUserId: null,
      failureKind: null,
      failureMessage: null,
      updatedAt: "2026-07-04T00:00:00.000Z",
    });

    expect(emit.title).toBe("Extraction failed in Discussion");
    expect(emit.summary).toBe("Extraction failed.");
    expect(emit.sourcePermissionRevision).toBe("2026-07-04T00:00:00.000Z");
  });

  it("classifies extraction failure guidance by kind", () => {
    expect(formatExtractionFailureGuidance("not_authed", null)).toContain("logged in");
    expect(formatExtractionFailureGuidance("timeout", null)).toContain("timed out");
    expect(formatExtractionFailureGuidance("nonzero_exit", "boom")).toContain("Reprocess");
    // never points at a hosted key / Settings (Decision #104).
    expect(formatExtractionFailureGuidance("not_installed", null)).not.toMatch(/settings|api key/i);
  });

  it("maps a failed routine run to routine_outcome keyed on the run id", () => {
    const emit = buildRoutineFailedHubEmit({
      runId: "run-1",
      routineId: "routine-1",
      companyId: "company-1",
      routineName: "Weekly report",
      failureReason: "Execution issue moved to blocked",
      createdByUserId: "user-1",
      updatedAt: new Date("2026-07-04T00:00:00Z"),
    });

    expect(emit).toMatchObject({
      companyId: "company-1",
      semanticType: "routine_outcome",
      sourceType: "routine_run",
      sourceId: "run-1",
      relatedEntityType: "routine",
      relatedEntityId: "routine-1",
      ownerUserId: "user-1",
      priority: "high",
      title: "Routine failed: Weekly report",
      summary: "Execution issue moved to blocked",
    });
  });

  it("routes a failed routine with no creator to the board pool", () => {
    const emit = buildRoutineFailedHubEmit({
      runId: "run-2",
      routineId: "routine-2",
      companyId: "company-1",
      routineName: "Nightly sweep",
      failureReason: null,
      createdByUserId: null,
      updatedAt: new Date("2026-07-04T00:00:00Z"),
    });

    expect(emit.ownerPool).toBe("board");
    expect(emit.ownerUserId).toBeUndefined();
    expect(emit.summary).toBe("Routine run failed.");
  });
});
