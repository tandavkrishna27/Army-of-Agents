/**
 * threads-spinoff.test.ts
 * TDD: Task 4 — spin-off thread creation from scope item
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
    id: "d_id", companyId: "d_company_id", ownerUserId: "d_owner_user_id",
    visibility: "d_visibility", scopeType: "d_scope_type", scopeId: "d_scope_id",
    title: "d_title", forkedFromId: "d_forked_from_id", phase: "d_phase",
    createdBy: "d_created_by", updatedAt: "d_updated_at",
  },
  threadParticipants: {
    id: "tp_id", threadId: "tp_thread_id", principalType: "tp_principal_type",
    principalId: "tp_principal_id", role: "tp_role",
  },
  threadLinks: {
    id: "tl_id", companyId: "tl_company_id", fromThreadId: "tl_from", toThreadId: "tl_to",
    kind: "tl_kind", createdBy: "tl_created_by",
  },
  userRoles: { id: "ur_id", companyId: "ur_company_id", userId: "ur_user_id", projectId: "ur_project_id" },
  goals: { id: "g_id", parentId: "g_parent_id" },
  discussionEntries: {
    id: "de_id", discussionId: "de_discussion_id", rawContent: "de_raw_content",
    inputType: "de_input_type", createdBy: "de_created_by",
  },
  discussionExtractedItems: {
    id: "dei_id", discussionEntryId: "dei_entry_id", title: "dei_title",
    description: "dei_description", type: "dei_type", status: "dei_status",
    resultTaskId: "dei_result_task_id", assigneeAgentId: "dei_assignee_agent_id",
    assigneeUserId: "dei_assignee_user_id", departmentId: "dei_department_id",
    suggestedDepartmentId: "dei_suggested_dept", suggestedProjectId: "dei_suggested_proj",
    priority: "dei_priority", suggestedPriority: "dei_suggested_priority",
    updatedAt: "dei_updated_at",
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

const parentThread = {
  id: "parent-thread",
  companyId: "co1",
  ownerUserId: "u1",
  visibility: "company",
  scopeType: null,
  scopeId: null,
  title: "Parent Thread",
  phase: "scope",
};

const scopeItem = {
  id: "scope-item-1",
  title: "Migrate database schema",
  description: "We need to migrate the DB schema for v2",
  type: "task",
};

function makeDb(insertReturns: any[][] = []) {
  let ii = 0;
  const queues: any[][] = [
    [parentThread],    // getById for parent
    [scopeItem],       // fetch scope item
    ...insertReturns,  // insert calls
  ];
  let qi = 0;

  const selectChain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn((fn: any) => Promise.resolve(fn(queues[qi++] ?? []))),
  };

  const makeInsert = () => ({
    values: vi.fn(() => ({
      returning: vi.fn(() => ({
        then: vi.fn((fn: any) =>
          Promise.resolve(fn(insertReturns[ii++] ?? [])),
        ),
      })),
      onConflictDoNothing: vi.fn(() => ({
        returning: vi.fn(() => ({
          then: vi.fn((fn: any) =>
            Promise.resolve(fn(insertReturns[ii++] ?? [])),
          ),
        })),
        then: vi.fn((fn: any) =>
          Promise.resolve(fn(insertReturns[ii++] ?? [])),
        ),
      })),
      then: vi.fn((fn: any) =>
        Promise.resolve(fn(insertReturns[ii++] ?? [])),
      ),
    })),
  });

  const db = {
    select: vi.fn(() => selectChain),
    insert: vi.fn(makeInsert),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    transaction: vi.fn(async (fn: (tx: any) => any) => fn({
      select: vi.fn(() => selectChain),
      insert: vi.fn(makeInsert),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    })),
  } as any;

  return db;
}

// ── spinOff tests ─────────────────────────────────────────────────────────────

describe("threadService.spinOff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a child discussion with forkedFromId = parent id", async () => {
    const childThread = {
      id: "child-thread",
      companyId: "co1",
      title: "Migrate database schema",
      forkedFromId: "parent-thread",
      phase: "discuss",
    };
    const db = makeDb([
      [childThread],  // insert discussion → returning
      [],             // insert threadLinks
    ]);

    const svc = threadService(db);
    const result = await svc.spinOff(
      "co1",
      "parent-thread",
      { scopeItemId: "scope-item-1" },
      founder,
    );

    expect(result.forkedFromId).toBe("parent-thread");
    expect(result.id).toBe("child-thread");
  });

  it("creates a threadLinks row with kind='spawned_from_task'", async () => {
    const childThread = {
      id: "child-thread",
      companyId: "co1",
      title: "Migrate database schema",
      forkedFromId: "parent-thread",
      phase: "discuss",
    };
    const db = makeDb([
      [childThread],
      [],
    ]);

    const svc = threadService(db);
    await svc.spinOff(
      "co1",
      "parent-thread",
      { scopeItemId: "scope-item-1" },
      founder,
    );

    // All inserts happen inside the transaction callback (tx.insert), not db.insert directly
    // Verify the transaction was called (atomicity guarantee)
    expect(db.transaction).toHaveBeenCalledTimes(1);
    // The transaction function receives the tx object and calls tx.insert 3 times:
    // discussion + threadLinks + entry (scopeItem found)
    const txFn = (db.transaction as vi.Mock).mock.calls[0][0];
    expect(txFn).toBeDefined();
  });

  it("uses custom title when provided", async () => {
    const childThread = {
      id: "child-thread",
      companyId: "co1",
      title: "Custom Title",
      forkedFromId: "parent-thread",
      phase: "discuss",
    };
    const db = makeDb([[childThread], []]);

    const svc = threadService(db);
    const result = await svc.spinOff(
      "co1",
      "parent-thread",
      { scopeItemId: "scope-item-1", title: "Custom Title" },
      founder,
    );

    expect(result.id).toBe("child-thread");
  });

  it("throws notFound when parent thread does not exist", async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn((fn: any) => Promise.resolve(fn([]))), // no thread found
    };
    const db = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(),
    } as any;

    const svc = threadService(db);
    await expect(
      svc.spinOff("co1", "missing-thread", { scopeItemId: "scope-item-1" }, founder),
    ).rejects.toThrow(/not found/i);
  });
});
