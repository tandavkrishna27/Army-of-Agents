/**
 * Unit tests for assertAgentInReviewReviewPath — the guard that prevents
 * agents from self-marking tasks as `in_review` with no human review path.
 *
 * Ports the severable middleware slice from Paperclip commit 68f69975.
 * AoA-adapted: dropped executionState/monitor predicates (columns don't exist).
 *
 * Tested as unit tests (not integration) because the guard logic is
 * self-contained and the only DB operation is a single approval lookup.
 * See CLAUDE.md test patterns for rationale on mock-DB unit test style.
 */

import { describe, expect, it, vi } from "vitest";

// ── DB / drizzle mocks ─────────────────────────────────────────────────────

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "$inferSelect" || prop === "$inferInsert" ? {} : Symbol(String(prop)),
      },
    );
  return {
    issueApprovals: makeTable(),
    approvals: makeTable(),
    issues: makeTable(),
    agents: makeTable(),
    companies: makeTable(),
    projects: makeTable(),
    goals: makeTable(),
    labels: makeTable(),
    issueLabels: makeTable(),
    issueComments: makeTable(),
    issueReadStates: makeTable(),
    issueAttachments: makeTable(),
    issueDocuments: makeTable(),
    assets: makeTable(),
    heartbeatRuns: makeTable(),
    activityLog: makeTable(),
    documents: makeTable(),
    documentRevisions: makeTable(),
    artifacts: makeTable(),
    artifactVersions: makeTable(),
    agentWakeupRequests: makeTable(),
    agentRuntimeState: makeTable(),
    agentTaskSessions: makeTable(),
    agentApiKeys: makeTable(),
    agentConfigRevisions: makeTable(),
    agentProjects: makeTable(),
    companyMemberships: makeTable(),
    companySkills: makeTable(),
    companySecrets: makeTable(),
    companySecretVersions: makeTable(),
    memoryItems: makeTable(),
    routines: makeTable(),
    principalPermissionGrants: makeTable(),
    taskDependencies: makeTable(),
    projectWorkspaces: makeTable(),
    approvalComments: makeTable(),
    feedbackVotes: makeTable(),
    suggestions: makeTable(),
    workflowTemplates: makeTable(),
    executionWorkspaces: makeTable(),
    workspaceOperations: makeTable(),
    workspaceRuntimeServices: makeTable(),
    notifications: makeTable(),
    inboxDismissals: makeTable(),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  asc: (..._args: unknown[]) => "asc",
  desc: (..._args: unknown[]) => "desc",
  eq: (..._args: unknown[]) => "eq",
  gt: (..._args: unknown[]) => "gt",
  lt: (..._args: unknown[]) => "lt",
  gte: (..._args: unknown[]) => "gte",
  lte: (..._args: unknown[]) => "lte",
  ne: (..._args: unknown[]) => "ne",
  inArray: (..._args: unknown[]) => "inArray",
  isNull: (..._args: unknown[]) => "isNull",
  isNotNull: (..._args: unknown[]) => "isNotNull",
  or: (..._args: unknown[]) => "or",
  not: (..._args: unknown[]) => "not",
  count: (..._args: unknown[]) => "count",
  sum: (..._args: unknown[]) => "sum",
  max: (..._args: unknown[]) => "max",
  min: (..._args: unknown[]) => "min",
  avg: (..._args: unknown[]) => "avg",
  ilike: (..._args: unknown[]) => "ilike",
  like: (..._args: unknown[]) => "like",
  notInArray: (..._args: unknown[]) => "notInArray",
  between: (..._args: unknown[]) => "between",
  exists: (..._args: unknown[]) => "exists",
  notExists: (..._args: unknown[]) => "notExists",
  getTableColumns: (..._args: unknown[]) => ({}),
  getTableName: (..._args: unknown[]) => "mock_table",
  sql: new Proxy(
    Object.assign(() => ({ as: () => "sql" }), { raw: () => ({ as: () => "sql" }) }),
    {
      get: (_t: unknown, prop: string | symbol) =>
        prop === "apply" ? () => ({ as: () => "sql" }) : () => ({ as: () => "sql" }),
      apply: () => ({ as: () => "sql" }),
    },
  ),
}));

// ── Import the module under test (after mocks are set up) ─────────────────

import { assertAgentInReviewReviewPath } from "../services/issue-agent-status-guard.js";
import { HttpError } from "../errors.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock DB for the approval lookup.
 * approvalRows: what the inner join SELECT returns.
 */
function buildMockDb(approvalRows: Array<{ status: string }>) {
  // The guard calls:
  //   db.select({ status: approvalsTable.status })
  //     .from(issueApprovalsTable)
  //     .innerJoin(approvalsTable, eq(...))
  //     .where(eq(...))
  // We mock this fluent chain to return approvalRows.
  const chain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(approvalRows),
    select: vi.fn().mockReturnThis(),
  };
  return {
    select: vi.fn(() => chain),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("assertAgentInReviewReviewPath", () => {
  // ── Test 1: Agent transitions to in_review with no review path → 422 ──

  it("throws 422 when agent marks in_review with no assignee and no pending approval", async () => {
    const db = buildMockDb([]); // no approvals at all

    await expect(
      assertAgentInReviewReviewPath(
        {
          existing: { id: "issue-1", status: "in_progress" },
          updateFields: { status: "in_review" },
          actorType: "agent",
        },
        db as never,
      ),
    ).rejects.toThrow(HttpError);

    await expect(
      assertAgentInReviewReviewPath(
        {
          existing: { id: "issue-1", status: "in_progress" },
          updateFields: { status: "in_review" },
          actorType: "agent",
        },
        db as never,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "invalid_issue_disposition",
        validReviewPaths: expect.arrayContaining(["linked_pending_approval", "human_assignee_user_id"]),
      }),
    });
  });

  // ── Test 2: Agent sets in_review WITH a human assigneeUserId → 200 OK ──

  it("passes when agent sets in_review with assigneeUserId", async () => {
    const db = buildMockDb([]); // no approvals needed — assignee is the path

    await expect(
      assertAgentInReviewReviewPath(
        {
          existing: { id: "issue-1", status: "in_progress" },
          updateFields: { status: "in_review", assigneeUserId: "user-123" },
          actorType: "agent",
        },
        db as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── Test 3: Agent sets in_review WITH active pending approval → 200 OK ──

  it("passes when agent sets in_review with a linked pending approval", async () => {
    const db = buildMockDb([{ status: "pending" }]);

    await expect(
      assertAgentInReviewReviewPath(
        {
          existing: { id: "issue-1", status: "in_progress" },
          updateFields: { status: "in_review" },
          actorType: "agent",
        },
        db as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── Test 4: Non-agent (board) actor → guard bypassed unconditionally ──

  it("passes for board actors even with no review path", async () => {
    const db = buildMockDb([]);

    await expect(
      assertAgentInReviewReviewPath(
        {
          existing: { id: "issue-1", status: "in_progress" },
          updateFields: { status: "in_review" },
          actorType: "board",
        },
        db as never,
      ),
    ).resolves.toBeUndefined();
  });

  it("passes for user actors even with no review path", async () => {
    const db = buildMockDb([]);

    await expect(
      assertAgentInReviewReviewPath(
        {
          existing: { id: "issue-1", status: "in_progress" },
          updateFields: { status: "in_review" },
          actorType: "user",
        },
        db as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── Test 5: Agent PATCH that doesn't change status → guard not fired ──

  it("passes for agent PATCH that does not change status to in_review", async () => {
    const db = buildMockDb([]);

    // Status staying at in_progress (no status field in updateFields)
    await expect(
      assertAgentInReviewReviewPath(
        {
          existing: { id: "issue-1", status: "in_progress" },
          updateFields: { assigneeAgentId: "agent-2" },
          actorType: "agent",
        },
        db as never,
      ),
    ).resolves.toBeUndefined();
  });

  it("passes for agent PATCH that changes status to something other than in_review", async () => {
    const db = buildMockDb([]);

    await expect(
      assertAgentInReviewReviewPath(
        {
          existing: { id: "issue-1", status: "in_progress" },
          updateFields: { status: "done" },
          actorType: "agent",
        },
        db as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── Test 6: Guard not refired if already in_review ──

  it("passes when issue is already in_review status (no double-guard)", async () => {
    const db = buildMockDb([]);

    await expect(
      assertAgentInReviewReviewPath(
        {
          existing: { id: "issue-1", status: "in_review" },
          updateFields: { priority: "high" },
          actorType: "agent",
        },
        db as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── Test 7: Non-pending approval does NOT satisfy the condition ──

  it("throws 422 when all linked approvals are approved (not pending)", async () => {
    const db = buildMockDb([{ status: "approved" }]);

    await expect(
      assertAgentInReviewReviewPath(
        {
          existing: { id: "issue-1", status: "in_progress" },
          updateFields: { status: "in_review" },
          actorType: "agent",
        },
        db as never,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "invalid_issue_disposition" }),
    });
  });
});
