import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: any[]) => a),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  inArray: vi.fn((c: any, v: any) => ({ inArray: [c, v] })),
  desc: vi.fn((c: any) => ({ desc: c })),
  asc: vi.fn((c: any) => ({ asc: c })),
  gt: vi.fn((a: any, b: any) => ({ gt: [a, b] })),
  isNull: vi.fn((c: any) => ({ isNull: c })),
  or: vi.fn((...a: any[]) => a),
}));
vi.mock("@armyofagents/db", () => ({
  discussions: { id: "d_id", companyId: "d_co", phase: "d_phase", goalId: "d_goal" },
  threadParticipants: { id: "tp_id", threadId: "tp_thread", principalType: "tp_pt", principalId: "tp_pid", role: "tp_role" },
  threadLinks: { id: "tl_id", fromThreadId: "tl_from", toThreadId: "tl_to" },
  userRoles: { id: "ur_id", companyId: "ur_co", userId: "ur_uid", projectId: "ur_proj" },
  threadPlanSteps: { id: "tps_id", threadId: "tps_thread" },
  discussionEntries: { id: "de_id", discussionId: "de_disc" },
  discussionExtractedItems: {
    id: "dei_id", discussionEntryId: "dei_entry", type: "dei_type", title: "dei_title",
    description: "dei_desc", status: "dei_status", resultTaskId: "dei_result_task",
    assigneeAgentId: "dei_assignee_agent", assigneeUserId: "dei_assignee_user",
    departmentId: "dei_dept", suggestedDepartmentId: "dei_sugg_dept",
    suggestedProjectId: "dei_sugg_proj", suggestedGoalId: "dei_sugg_goal",
    priority: "dei_priority", suggestedPriority: "dei_sugg_priority", updatedAt: "dei_updated",
  },
  issues: { id: "issues_id", companyId: "issues_co", workMode: "issues_work_mode" },
  companies: { id: "companies_id", agentCompletionPolicyDefault: "companies_policy", agentCompletionReviewGuardrail: "companies_guardrail" },
  projects: { id: "projects_id", companyId: "projects_co", type: "projects_type", agentCompletionPolicyDefault: "projects_policy" },
  agents: {}, authUsers: {}, companyMemberships: {}, agentWakeupRequests: {},
  notifications: {}, aoaAgentTriggers: {}, scopeItemDependencies: {}, taskDependencies: {},
}));
vi.mock("../errors.js", () => ({
  badRequest: (m: string) => Object.assign(new Error(m), { status: 400 }),
  notFound: (m: string) => Object.assign(new Error(m), { status: 404 }),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/goals.js", () => ({ goalService: vi.fn(() => ({})) }));

import { threadService } from "../services/threads.js";

function seqDb(queue: any[][]) {
  let i = 0;
  const sel = () => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    for: vi.fn().mockReturnThis(),
    then: vi.fn((f: any) => Promise.resolve(f(queue[i++] ?? []))),
  });
  const db: any = {
    select: vi.fn(sel),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve(queue[i++] ?? [])),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    transaction: vi.fn(async (fn: any) => fn(db)),
  };
  return db;
}

beforeEach(() => vi.clearAllMocks());

describe("threadService.assignScopeItems — scope→task crystallization (D8 planning mode)", () => {
  it("creates a planning-mode issue from an approved task item and links resultTaskId", async () => {
    const db = seqDb([
      [{ id: "t1", companyId: "co1", phase: "scope", goalId: null, ownerUserId: "u1", visibility: "company", scopeType: null, scopeId: null }], // thread row
      [{ id: "e1" }], // entries
      [
        { id: "item1", type: "task", title: "Build API", status: "approved", resultTaskId: null, departmentId: "eng", assigneeAgentId: null, assigneeUserId: null, description: null, suggestedPriority: null, suggestedDepartmentId: null, suggestedProjectId: null, suggestedGoalId: null, priority: null },
        { id: "item2", type: "insight", title: "Note", status: "approved", resultTaskId: null, departmentId: null, assigneeAgentId: null, assigneeUserId: null, description: null, suggestedPriority: null, suggestedDepartmentId: null, suggestedProjectId: null, suggestedGoalId: null, priority: null },
      ], // approved items
      [{ policyDefault: "review_required", reviewGuardrail: false }],
      [{ id: "eng", type: "department", policyDefault: null }],
      [{ id: "new-issue-1" }], // issues insert .returning()
    ]);
    const res = await threadService(db).assignScopeItems("co1", "t1", { userId: "u1", role: "founder", isHuman: true });
    expect(res.created).toBe(1); // only the task item, insight skipped
    const insertValues = (db.insert as any).mock.results
      .map((r: any) => r.value.values.mock.calls[0]?.[0])
      .find((v: any) => v && v.title === "Build API");
    expect(insertValues.workMode).toBe("planning");
  });

  it("is idempotent: items with an existing resultTaskId are skipped", async () => {
    const db = seqDb([
      [{ id: "t1", companyId: "co1", phase: "scope", goalId: null, ownerUserId: "u1", visibility: "company", scopeType: null, scopeId: null }],
      [{ id: "e1" }],
      [{ id: "item1", type: "task", title: "Already", status: "approved", resultTaskId: "existing-task", departmentId: null, assigneeAgentId: null, assigneeUserId: null, description: null, suggestedPriority: null, suggestedDepartmentId: null, suggestedProjectId: null, suggestedGoalId: null, priority: null }],
    ]);
    const res = await threadService(db).assignScopeItems("co1", "t1", { userId: "u1", role: "founder", isHuman: true });
    expect(res.created).toBe(0);
  });

  it("hides-don't-403: non-founder gets notFound", async () => {
    const db = seqDb([]);
    await expect(
      threadService(db).assignScopeItems("co1", "t1", { userId: "u2", role: "team_member", isHuman: true }),
    ).rejects.toThrow(/not found/i);
  });
});
