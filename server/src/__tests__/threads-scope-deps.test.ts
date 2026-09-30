/**
 * threads-scope-deps.test.ts
 * TDD: Task 3 — scope-item dependencies + graduation to task_dependencies
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  or: vi.fn((...args: any[]) => ({ or: args })),
  desc: vi.fn((col: any) => ({ desc: col })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
  isNull: vi.fn((col: any) => ({ isNull: col })),
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
    id: "dei_id", discussionEntryId: "dei_entry_id", status: "dei_status",
    resultTaskId: "dei_result_task_id", type: "dei_type", title: "dei_title",
    description: "dei_description", assigneeAgentId: "dei_assignee_agent_id",
    assigneeUserId: "dei_assignee_user_id", departmentId: "dei_department_id",
    suggestedDepartmentId: "dei_suggested_dept", suggestedProjectId: "dei_suggested_proj",
    priority: "dei_priority", suggestedPriority: "dei_suggested_priority",
    updatedAt: "dei_updated_at",
  },
  scopeItemDependencies: {
    id: "sid_id", blockerItemId: "sid_blocker", blockedItemId: "sid_blocked",
    createdAt: "sid_created_at",
  },
  taskDependencies: {
    id: "td_id", companyId: "td_company_id",
    dependentIssueId: "td_dependent", dependencyIssueId: "td_dependency",
  },
  issues: { id: "i_id" },
  agents: { id: "a_id", companyId: "a_company_id", name: "a_name", kind: "a_kind" },
  authUsers: { id: "au_id", name: "au_name" },
  companyMemberships: { id: "cm_id", companyId: "cm_company_id", userId: "cm_user_id", principalId: "cm_principal_id", principalType: "cm_principal_type" },
  agentWakeupRequests: { id: "awr_id" },
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

function makeDb({
  thread,
  sidRows = [],       // scopeItemDependencies rows
  tdRows = [],        // taskDependencies rows (for idempotency check)
  insertReturn,
}: {
  thread: any;
  sidRows?: any[];
  tdRows?: any[];
  insertReturn?: any;
}) {
  const insertValues = vi.fn().mockReturnThis();
  const insertOnConflict = vi.fn().mockReturnThis();

  const queues: any[][] = [
    [thread], // getById
    sidRows,  // list scope deps (for graduate)
    tdRows,   // list existing task deps (for idempotency)
  ];
  let qi = 0;

  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn((fn: (r: any[]) => any) => Promise.resolve(fn(queues[qi++] ?? []))),
  };

  const insertChain = {
    values: insertValues,
    onConflictDoNothing: insertOnConflict,
    then: vi.fn((fn: (r: any[]) => any) => Promise.resolve(fn(insertReturn ? [insertReturn] : []))),
  };

  insertValues.mockReturnValue({
    onConflictDoNothing: insertOnConflict,
    returning: vi.fn(() => ({
      then: vi.fn((fn: (r: any[]) => any) =>
        Promise.resolve(fn(insertReturn ? [insertReturn] : [])),
      ),
    })),
    then: vi.fn((fn: (r: any[]) => any) =>
      Promise.resolve(fn(insertReturn ? [insertReturn] : [])),
    ),
  });

  return {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    transaction: vi.fn(async (fn: any) => fn({
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => ({ values: insertValues })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    })),
  } as any;
}

// ── addScopeItemDependency ─────────────────────────────────────────────────────

describe("threadService.addScopeItemDependency", () => {
  it("inserts a scopeItemDependencies row", async () => {
    const thread = {
      id: "t1", companyId: "co1", ownerUserId: "u1",
      visibility: "company", scopeType: null, scopeId: null,
    };
    const blockerItem = { id: "item-a" };
    const blockedItem = { id: "item-b" };
    // Queue: [thread lookup, blockerItem lookup, blockedItem lookup]
    // Founder bypasses all RBAC DB lookups (assertCanView/assertCanEdit return immediately)
    const queues: any[][] = [
      [thread],       // getById (discussions)
      [blockerItem],  // blocker item validation (with innerJoin guard)
      [blockedItem],  // Fix 4: blocked item validation (with innerJoin guard)
    ];
    let qi = 0;
    const insertValues = vi.fn().mockResolvedValue(undefined);

    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        then: vi.fn((fn: any) => Promise.resolve(fn(queues[qi++] ?? []))),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        })),
      })),
    } as any;

    const svc = threadService(db);
    await svc.addScopeItemDependency(
      "co1", "t1",
      { blockerItemId: "item-a", blockedItemId: "item-b" },
      founder,
    );

    expect(db.insert).toHaveBeenCalledTimes(1);
    // The values call should include the blocker and blocked item IDs
    const insertMock = db.insert as vi.Mock;
    const valuesCall = insertMock.mock.results[0].value.values;
    expect(valuesCall).toHaveBeenCalledWith(
      expect.objectContaining({ blockerItemId: "item-a", blockedItemId: "item-b" }),
    );
  });

  it("throws notFound when blockedItemId is not in this thread (Fix 4)", async () => {
    const thread = {
      id: "t1", companyId: "co1", ownerUserId: "u1",
      visibility: "company", scopeType: null, scopeId: null,
    };
    const blockerItem = { id: "item-a" };
    // blockedItem belongs to a different thread → join returns no rows
    const queues: any[][] = [
      [thread],       // getById (discussions)
      [blockerItem],  // blocker item validation passes
      [],             // Fix 4: blocked item validation → no rows (foreign thread)
    ];
    let qi = 0;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        then: vi.fn((fn: any) => Promise.resolve(fn(queues[qi++] ?? []))),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        })),
      })),
    } as any;

    const svc = threadService(db);
    await expect(
      svc.addScopeItemDependency(
        "co1", "t1",
        { blockerItemId: "item-a", blockedItemId: "item-foreign" },
        founder,
      ),
    ).rejects.toThrow(/not found/i);
    // Must not insert when validation fails
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ── graduateScopeItemDependencies ─────────────────────────────────────────────

describe("threadService.graduateScopeItemDependencies", () => {
  // The service accepts precomputedRows (provided by the route handler which
  // does the two-step DB lookup). Tests inject them directly to avoid
  // complex aliased join mocks.

  it("copies scope deps to task_dependencies when resultTaskIds exist", async () => {
    const thread = {
      id: "t1", companyId: "co1", ownerUserId: "u1",
      visibility: "company", scopeType: null, scopeId: null,
    };
    const precomputedRows = [
      {
        id: "sid-1",
        blockerItemId: "item-a",
        blockedItemId: "item-b",
        blockerResultTaskId: "task-A",
        blockedResultTaskId: "task-B",
      },
    ];

    const insertValues = vi.fn().mockResolvedValue(undefined);
    const queues: any[][] = [
      [thread], // getById
      [],       // existing task_dependencies (none)
    ];
    let qi = 0;
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn((fn: any) => Promise.resolve(fn(queues[qi++] ?? []))),
    };

    const db = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => ({ values: insertValues })),
    } as any;

    const svc = threadService(db);
    const result = await svc.graduateScopeItemDependencies("co1", "t1", founder, precomputedRows);
    expect(result.graduated).toBe(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "co1",
        dependentIssueId: "task-B",
        dependencyIssueId: "task-A",
      }),
    );
  });

  it("is idempotent — skips already-graduated deps", async () => {
    const thread = {
      id: "t1", companyId: "co1", ownerUserId: "u1",
      visibility: "company", scopeType: null, scopeId: null,
    };
    const precomputedRows = [
      {
        id: "sid-1",
        blockerItemId: "item-a",
        blockedItemId: "item-b",
        blockerResultTaskId: "task-A",
        blockedResultTaskId: "task-B",
      },
    ];
    // Existing task_dependency for this pair already in DB
    const existingTdRows = [
      { dependentIssueId: "task-B", dependencyIssueId: "task-A" },
    ];

    const insertValues = vi.fn().mockResolvedValue(undefined);
    const queues: any[][] = [
      [thread],        // getById
      existingTdRows,  // existing task_dependencies
    ];
    let qi = 0;
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn((fn: any) => Promise.resolve(fn(queues[qi++] ?? []))),
    };
    const db = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => ({ values: insertValues })),
    } as any;

    const svc = threadService(db);
    const result = await svc.graduateScopeItemDependencies("co1", "t1", founder, precomputedRows);
    // Already exists → should skip → graduated = 0
    expect(result.graduated).toBe(0);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("skips deps where resultTaskId is missing from scope items", async () => {
    const thread = {
      id: "t1", companyId: "co1", ownerUserId: "u1",
      visibility: "company", scopeType: null, scopeId: null,
    };
    const precomputedRows = [
      {
        id: "sid-1",
        blockerItemId: "item-a",
        blockedItemId: "item-b",
        blockerResultTaskId: null,  // not yet graduated to task
        blockedResultTaskId: "task-B",
      },
    ];

    const insertValues = vi.fn().mockResolvedValue(undefined);
    const queues: any[][] = [
      [thread],
      [], // no existing task deps
    ];
    let qi = 0;
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn((fn: any) => Promise.resolve(fn(queues[qi++] ?? []))),
    };
    const db = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => ({ values: insertValues })),
    } as any;

    const svc = threadService(db);
    const result = await svc.graduateScopeItemDependencies("co1", "t1", founder, precomputedRows);
    expect(result.graduated).toBe(0);
    expect(insertValues).not.toHaveBeenCalled();
  });
});
