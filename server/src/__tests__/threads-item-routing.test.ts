/**
 * threads-item-routing.test.ts
 * TDD: Task 5 — per-item department + assignee routing (founder-gated)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  or: vi.fn((...args: any[]) => ({ or: args })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
  isNull: vi.fn((col: any) => ({ isNull: col })),
  desc: vi.fn((col: any) => ({ desc: col })),
}));

vi.mock("@armyofagents/db", () => ({
  discussions: {
    id: "d_id", companyId: "d_company_id", ownerUserId: "d_owner",
    visibility: "d_visibility", scopeType: "d_scope_type", scopeId: "d_scope_id",
  },
  threadParticipants: {
    id: "tp_id", threadId: "tp_thread_id", principalType: "tp_principal_type",
    principalId: "tp_principal_id", role: "tp_role",
  },
  userRoles: { id: "ur_id", companyId: "ur_company_id", userId: "ur_user_id", projectId: "ur_project_id" },
  threadLinks: { id: "tl_id", companyId: "tl_co", fromThreadId: "tl_from", toThreadId: "tl_to", kind: "tl_kind", createdBy: "tl_created_by" },
  goals: { id: "g_id", parentId: "g_parent_id" },
  discussionEntries: { id: "de_id", discussionId: "de_discussion_id" },
  discussionExtractedItems: {
    id: "dei_id", discussionEntryId: "dei_entry_id", type: "dei_type", title: "dei_title",
    description: "dei_description", status: "dei_status", resultTaskId: "dei_result_task_id",
    assigneeAgentId: "dei_assignee_agent_id", assigneeUserId: "dei_assignee_user_id",
    departmentId: "dei_department_id", suggestedDepartmentId: "dei_suggested_dept",
    suggestedProjectId: "dei_suggested_proj", priority: "dei_priority",
    suggestedPriority: "dei_suggested_priority", updatedAt: "dei_updated_at",
  },
  scopeItemDependencies: { id: "sid_id", blockerItemId: "sid_blocker", blockedItemId: "sid_blocked" },
  taskDependencies: {
    id: "td_id", companyId: "td_company_id",
    dependentIssueId: "td_dependent", dependencyIssueId: "td_dependency",
  },
  issues: { id: "i_id" },
  agents: { id: "a_id", companyId: "a_company_id", name: "a_name", kind: "a_kind" },
  authUsers: { id: "au_id", name: "au_name" },
  companyMemberships: { id: "cm_id", companyId: "cm_company_id", userId: "cm_user_id", principalId: "cm_principal_id", principalType: "cm_principal_type" },
  agentWakeupRequests: {
    id: "awr_id", companyId: "awr_company_id", agentId: "awr_agent_id",
    source: "awr_source", triggerDetail: "awr_trigger_detail",
    reason: "awr_reason", payload: "awr_payload",
    requestedByActorType: "awr_requested_by_actor_type",
    requestedByActorId: "awr_requested_by_actor_id",
  },
  notifications: { id: "n_id" },
}));

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => { const e = new Error(msg); (e as any).status = 400; return e; },
  notFound: (msg: string) => { const e = new Error(msg); (e as any).status = 404; return e; },
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/goals.js", () => ({ goalService: vi.fn() }));

import { threadService } from "../services/threads.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const founder = { userId: "u1", role: "founder" as const, isHuman: true };
const teamMember = { userId: "u2", role: "team_member" as const, isHuman: true };

const thread = {
  id: "t1", companyId: "co1", ownerUserId: "u1",
  visibility: "company", scopeType: null, scopeId: null,
};
const existingItem = {
  id: "item-1", type: "task", title: "My Task",
  assigneeAgentId: null, assigneeUserId: null, departmentId: null,
  discussionEntryId: "entry-1",
};

function makeDb({
  updateSetter,
  agentRow,
}: { updateSetter?: vi.Mock; agentRow?: any } = {}) {
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  // item lookup now returns { item: existingItem } shape due to companyId join guard
  // routeItem no longer does a discussion lookup first — goes straight to item with join
  const queues: any[][] = [
    [{ item: existingItem }],         // fetch item (with companyId join) — now first select
    agentRow ? [agentRow] : [],       // agent lookup (if needed)
  ];
  let qi = 0;
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn((fn: any) => Promise.resolve(fn(queues[qi++] ?? []))),
  };

  return {
    db: {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => ({
        values: vi.fn().mockResolvedValue(undefined),
      })),
      update: vi.fn(() => ({ set: updateSet })),
    } as any,
    updateSet,
    updateWhere,
  };
}

// ── routeItem ─────────────────────────────────────────────────────────────────

describe("threadService.routeItem", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates departmentId and assigneeAgentId on the item", async () => {
    const { db, updateSet, updateWhere } = makeDb({ agentRow: { id: "agent-1", name: "Bot" } });
    const svc = threadService(db);

    await svc.routeItem(
      "co1",
      "item-1",
      { departmentId: "dept-1", assigneeAgentId: "agent-1" },
      founder,
    );

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ departmentId: "dept-1", assigneeAgentId: "agent-1" }),
    );
  });

  it("throws notFound for non-founder (founder-gated)", async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn((fn: any) => Promise.resolve(fn([]))),
    };
    const db = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(),
      update: vi.fn(),
    } as any;

    const svc = threadService(db);
    await expect(
      svc.routeItem("co1", "item-1", { departmentId: "dept-1" }, teamMember),
    ).rejects.toThrow(/not found/i);
  });

  it("creates an agentWakeupRequests row when assigneeAgentId is set", async () => {
    const { db } = makeDb({ agentRow: { id: "agent-1", name: "Bot" } });
    const svc = threadService(db);

    await svc.routeItem(
      "co1",
      "item-1",
      { assigneeAgentId: "agent-1" },
      founder,
    );

    expect(db.insert).toHaveBeenCalledTimes(1);
    const insertCall = (db.insert as vi.Mock).mock.calls[0];
    // first arg to insert is the table
    expect(insertCall).toBeDefined();
  });

  it("updates assigneeUserId without creating wakeup when no agentId", async () => {
    const { db } = makeDb();
    const svc = threadService(db);

    await svc.routeItem(
      "co1",
      "item-1",
      { assigneeUserId: "user-2" },
      founder,
    );

    // No insert (no agent wakeup needed for human assignee)
    expect(db.insert).not.toHaveBeenCalled();
  });
});
