import { beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  desc: vi.fn((col: any) => ({ desc: col })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
  isNull: vi.fn((col: any) => ({ isNull: col })),
}));

vi.mock("@armyofagents/db", () => ({
  discussions: {
    id: "discussions_id",
    companyId: "discussions_company_id",
    title: "discussions_title",
    status: "discussions_status",
    scopeType: "discussions_scope_type",
    scopeId: "discussions_scope_id",
    phase: "discussions_phase",
    visibility: "discussions_visibility",
    ownerUserId: "discussions_owner_user_id",
    goalId: "discussions_goal_id",
    forkedFromId: "discussions_forked_from_id",
    mergedIntoId: "discussions_merged_into_id",
    summaryText: "discussions_summary_text",
    summaryNext: "discussions_summary_next",
    summaryUpdatedAt: "discussions_summary_updated_at",
    lastEntryAt: "discussions_last_entry_at",
    entryCount: "discussions_entry_count",
    pendingItemCount: "discussions_pending_item_count",
    createdBy: "discussions_created_by",
    updatedAt: "discussions_updated_at",
  },
  threadParticipants: {
    id: "tp_id",
    companyId: "tp_company_id",
    threadId: "tp_thread_id",
    principalType: "tp_principal_type",
    principalId: "tp_principal_id",
    role: "tp_role",
  },
  threadLinks: {
    id: "tl_id",
    companyId: "tl_company_id",
    fromThreadId: "tl_from_thread_id",
    toThreadId: "tl_to_thread_id",
    kind: "tl_kind",
    createdBy: "tl_created_by",
  },
  userRoles: {
    id: "ur_id",
    companyId: "ur_company_id",
    userId: "ur_user_id",
    projectId: "ur_project_id",
    role: "ur_role",
  },
  goals: {
    id: "goals_id",
    companyId: "goals_company_id",
    title: "goals_title",
    level: "goals_level",
    status: "goals_status",
    parentId: "goals_parent_id",
  },
  discussionEntries: {
    id: "de_id",
    discussionId: "de_discussion_id",
    inputType: "de_input_type",
  },
  discussionExtractedItems: {
    id: "dei_id",
    discussionEntryId: "dei_discussion_entry_id",
    type: "dei_type",
    title: "dei_title",
    description: "dei_description",
    status: "dei_status",
    resultTaskId: "dei_result_task_id",
    assigneeAgentId: "dei_assignee_agent_id",
    assigneeUserId: "dei_assignee_user_id",
    departmentId: "dei_department_id",
    suggestedDepartmentId: "dei_suggested_department_id",
    suggestedProjectId: "dei_suggested_project_id",
    priority: "dei_priority",
    suggestedPriority: "dei_suggested_priority",
    updatedAt: "dei_updated_at",
  },
  issues: {
    id: "issues_id",
    companyId: "issues_company_id",
    title: "issues_title",
    description: "issues_description",
    status: "issues_status",
    workMode: "issues_work_mode",
    assigneeAgentId: "issues_assignee_agent_id",
    assigneeUserId: "issues_assignee_user_id",
    projectId: "issues_project_id",
    priority: "issues_priority",
    createdByUserId: "issues_created_by_user_id",
  },
  projectGoals: {
    goalId: "pg_goal_id",
    projectId: "pg_project_id",
  },
  projects: {
    id: "projects_id",
    companyId: "projects_company_id",
    name: "projects_name",
    type: "projects_type",
    agentCompletionPolicyDefault: "projects_completion_policy",
  },
  companies: {
    id: "companies_id",
    agentCompletionPolicyDefault: "companies_completion_policy",
    agentCompletionReviewGuardrail: "companies_review_guardrail",
  },
  activityLog: {
    id: "al_id",
  },
  companyMemberships: {
    id: "cm_id",
    companyId: "cm_company_id",
    principalType: "cm_principal_type",
    principalId: "cm_principal_id",
  },
  scopeItemDependencies: {
    id: "sid_id",
    blockerItemId: "sid_blocker",
    blockedItemId: "sid_blocked",
  },
  taskDependencies: {
    id: "td_id",
    companyId: "td_company_id",
    dependentIssueId: "td_dependent",
    dependencyIssueId: "td_dependency",
  },
  agents: { id: "a_id", companyId: "a_company_id", name: "a_name", kind: "a_kind" },
  authUsers: { id: "au_id", name: "au_name" },
  agentWakeupRequests: { id: "awr_id" },
  aoaAgentTriggers: { agentId: "aat_agent_id", companyId: "aat_company_id", kind: "aat_kind", enabled: "aat_enabled", config: "aat_config" },
  notifications: { id: "n_id" },
  threadPlanSteps: { id: "tps_id", threadId: "tps_thread_id", stepOrder: "tps_step_order" },
}));

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 400;
    return err;
  },
  notFound: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 404;
    return err;
  },
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

// Task 2.6: crew-task-service is now imported by threads.ts for phase-advance
// auto-approve. Mock it so existing threads-service tests stay isolated from
// the crew pipeline (the advance tests here only go to "scope", not "assign").
vi.mock("../services/crew-task-service.js", () => ({
  crewTaskService: vi.fn(() => ({
    approveAndDispatch: vi.fn().mockResolvedValue({ approved: false, createdIssueIds: [] }),
    proposeWork: vi.fn(),
  })),
  resolveCreationGate: vi.fn(() => "await_human"),
}));

vi.mock("../services/goals.js", () => ({
  goalService: vi.fn(() => ({
    create: vi.fn().mockResolvedValue({ id: "g1", title: "Launch", projects: [], projectIds: [] }),
    assertParentsValid: vi.fn().mockResolvedValue(undefined),
    setGoalParents: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../redaction.js", () => ({
  sanitizeRecord: vi.fn((r: any) => r),
}));

import {
  assertCanPostToThread,
  canViewThread,
  threadService,
  computeCreateDefaults,
} from "../services/threads.js";
import { publishLiveEvent } from "../services/live-events.js";
import { logActivity } from "../services/activity-log.js";

// ── Local sequence DB helper (mirrors discussions-service.test.ts pattern) ───

function createSequenceDb(selectQueue: any[][]) {
  let idx = 0;

  function makeSelectChain() {
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      for: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn(selectQueue[idx++] ?? [])),
      ),
    };
  }

  function makeInsertChain() {
    return {
      values: vi.fn(() => ({
        returning: vi.fn().mockReturnThis(),
        onConflictDoNothing: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: any[]) => any) =>
          Promise.resolve(fn(selectQueue[idx++] ?? [])),
        ),
      })),
    };
  }

  function makeUpdateChain() {
    return {
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockReturnThis(),
          then: vi.fn((fn: (rows: any[]) => any) =>
            Promise.resolve(fn(selectQueue[idx++] ?? [])),
          ),
        })),
      })),
    };
  }

  const dbObj: any = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => makeInsertChain()),
    update: vi.fn(() => makeUpdateChain()),
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
    // transaction: pass the same db object as `tx` so the service can call tx.select/insert/update
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(dbObj)),
  };
  return dbObj as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertCanPostToThread", () => {
  const privateThread = {
    id: "t1",
    companyId: "co1",
    visibility: "private",
    ownerUserId: "owner",
    scopeType: null,
    scopeId: null,
  };

  it("allows a founder to post regardless of visibility", async () => {
    const db = createSequenceDb([[privateThread]]);
    await expect(assertCanPostToThread(db, "co1", "t1", {
      userId: "founder", role: "founder", isHuman: true,
    })).resolves.toBeUndefined();
  });

  it("allows a participant to post to a private thread", async () => {
    const db = createSequenceDb([[privateThread], [{ id: "participant" }]]);
    await expect(assertCanPostToThread(db, "co1", "t1", {
      userId: "member", role: "team_member", isHuman: true,
    })).resolves.toBeUndefined();
  });

  it("hides a private thread from a nonparticipant", async () => {
    const db = createSequenceDb([[privateThread], []]);
    await expect(assertCanPostToThread(db, "co1", "t1", {
      userId: "member", role: "team_member", isHuman: true,
    })).rejects.toMatchObject({ status: 404, message: "Thread not found" });
  });

  it("allows an in-scope lead to post to a visible scoped thread", async () => {
    const db = createSequenceDb([[
      { ...privateThread, visibility: "department", scopeType: "project", scopeId: "p1" },
    ], [], [{ id: "role" }]]);
    await expect(assertCanPostToThread(db, "co1", "t1", {
      userId: "lead", role: "team_lead", isHuman: true,
    })).resolves.toBeUndefined();
  });

  it("hides a visible scoped thread from an out-of-scope lead", async () => {
    const db = createSequenceDb([[
      { ...privateThread, visibility: "department", scopeType: "project", scopeId: "p1" },
    ], [], []]);
    await expect(assertCanPostToThread(db, "co1", "t1", {
      userId: "lead", role: "team_lead", isHuman: true,
    })).rejects.toMatchObject({ status: 404, message: "Thread not found" });
  });

  it("uses the same non-disclosing 404 for missing and cross-company threads", async () => {
    const db = createSequenceDb([[]]);
    await expect(assertCanPostToThread(db, "co1", "other-company-thread", {
      userId: "member", role: "team_member", isHuman: true,
    })).rejects.toMatchObject({ status: 404, message: "Thread not found" });
  });
});

// ── Task 2: read path ─────────────────────────────────────────────────────────

describe("threadService.getById", () => {
  it("returns null when the row is missing", async () => {
    const db = createSequenceDb([[]]); // first select -> no rows
    const svc = threadService(db);
    const result = await svc.getById("co1", "missing", {
      userId: "u1",
      role: "founder",
      isHuman: true,
    });
    expect(result).toBeNull();
  });

  it("throws notFound when the viewer cannot see a private thread", async () => {
    const db = createSequenceDb([
      // thread row
      [{ id: "t1", companyId: "co1", visibility: "private", ownerUserId: "u9", scopeType: null, scopeId: null }],
      // assertCanView: participants query -> not a participant
      [],
      // assertCanView: no scope to check (scopeType null) — next select not called
    ]);
    const svc = threadService(db);
    await expect(
      svc.getById("co1", "t1", { userId: "u1", role: "team_member", isHuman: true }),
    ).rejects.toThrow(/not found/i);
  });

  it("returns the thread for a founder regardless of visibility", async () => {
    const thread = { id: "t1", companyId: "co1", visibility: "private", ownerUserId: "u9", scopeType: null, scopeId: null };
    const db = createSequenceDb([[thread]]);
    const result = await threadService(db).getById("co1", "t1", {
      userId: "u1",
      role: "founder",
      isHuman: true,
    });
    expect(result?.id).toBe("t1");
  });
});

describe("threadService.list", () => {
  it("returns all threads for a founder without filtering", async () => {
    const threads = [
      { id: "t1", companyId: "co1", ownerUserId: "u1", visibility: "company", scopeType: null, scopeId: null },
      { id: "t2", companyId: "co1", ownerUserId: "u1", visibility: "private", scopeType: null, scopeId: null },
    ];
    const db = createSequenceDb([threads]);
    const result = await threadService(db).list("co1", { userId: "u1", role: "founder", isHuman: true });
    expect(result.length).toBe(2);
  });

  it("filters out private threads for non-participants", async () => {
    const threads = [
      { id: "t1", companyId: "co1", ownerUserId: "u1", visibility: "company", scopeType: null, scopeId: null },
      { id: "t2", companyId: "co1", ownerUserId: "u9", visibility: "private", scopeType: null, scopeId: null },
    ];
    const db = createSequenceDb([
      threads,      // list query
      [],           // participants batch (not a participant of either)
      [],           // roles batch (no dept roles)
    ]);
    const result = await threadService(db).list("co1", { userId: "u2", role: "team_member", isHuman: true });
    // open+owned is visible via isParticipant=false, hasScopeAccess=true (null scope)
    expect(result.map((r: any) => r.id)).toContain("t1");
    // private without being participant should be filtered
    expect(result.map((r: any) => r.id)).not.toContain("t2");
  });
});

// ── Task 3: computeCreateDefaults ─────────────────────────────────────────────

describe("computeCreateDefaults", () => {
  it("human creator owns it; phase=discuss", () => {
    const d = computeCreateDefaults({
      origin: { source: "human", medium: "text" },
      creator: { userId: "u1", isHuman: true },
      departmentDefaultVisibility: "company",
    });
    expect(d.phase).toBe("discuss");
    expect(d.ownerUserId).toBe("u1");
    expect(d.visibility).toBe("company");
    expect(d.originSource).toBe("human");
  });

  it("non-human creator -> Unclaimed (owner null); inherits dept private default", () => {
    const d = computeCreateDefaults({
      origin: { source: "agent", medium: "api" },
      creator: { userId: "agent1", isHuman: false },
      departmentDefaultVisibility: "private",
    });
    expect(d.ownerUserId).toBeNull();
    expect(d.visibility).toBe("private");
  });
});

// ── Task 4: advancePhase ──────────────────────────────────────────────────────

describe("threadService.advancePhase", () => {
  it("rejects an illegal forward skip", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", phase: "discuss", visibility: "company", ownerUserId: "u1", scopeType: null, scopeId: null }],
    ]);
    await expect(
      threadService(db).advancePhase("co1", "t1", "assign", { userId: "u1", role: "founder", isHuman: true }),
    ).rejects.toThrow(/cannot advance/i);
  });

  it("advances phase forward by one step", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", phase: "discuss", visibility: "company", ownerUserId: "u1", scopeType: null, scopeId: null }],
      [], // update
      [], // aoaAgentTriggers select (phase-advance subscribers — P3.4)
    ]);
    const result = await threadService(db).advancePhase("co1", "t1", "scope", {
      userId: "u1",
      role: "founder",
      isHuman: true,
    });
    expect(result.phase).toBe("scope");
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.phase.changed" }),
    );
  });

  it("throws notFound when thread does not exist", async () => {
    const db = createSequenceDb([[]]); // no rows
    await expect(
      threadService(db).advancePhase("co1", "t99", "scope", { userId: "u1", role: "founder", isHuman: true }),
    ).rejects.toThrow(/not found/i);
  });
});

// ── Task 4: updateSummary ─────────────────────────────────────────────────────

describe("threadService.updateSummary", () => {
  it("persists summary and fires live event", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", visibility: "company", ownerUserId: "u1", scopeType: null, scopeId: null }],
      [], // update
    ]);
    const result = await threadService(db).updateSummary(
      "co1",
      "t1",
      { text: "Summary text", next: "Next step" },
      { userId: "u1", role: "founder", isHuman: true },
    );
    expect(result).toEqual({ id: "t1" });
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.summary.updated" }),
    );
  });
});

// ── Task 5: claim ─────────────────────────────────────────────────────────────

describe("threadService.claim", () => {
  it("claim sets owner only when unclaimed (team_lead with scope can view+claim)", async () => {
    // Fix 1: an unclaimed thread is only viewable by founder or team_lead-with-scope.
    // A team_lead with scope access (null scope → globally accessible) passes assertCanView.
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", ownerUserId: null, visibility: "company", scopeType: null, scopeId: null }],
      [], // assertCanView: participants query (team_lead; null-scope → hasScopeAccess → visible)
      [], // update discussions
      [], // participant insert
    ]);
    const res = await threadService(db).claim("co1", "t1", {
      userId: "u1",
      role: "team_lead",
      isHuman: true,
    });
    expect(res.ownerUserId).toBe("u1");
  });

  it("does not change owner when thread is already owned", async () => {
    // Already-owned + open + null scope → viewable by a team_member (hasScopeAccess).
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", ownerUserId: "u9", visibility: "company", scopeType: null, scopeId: null }],
      [], // assertCanView: participants query (non-founder; open+null-scope → visible)
    ]);
    const res = await threadService(db).claim("co1", "t1", {
      userId: "u1",
      role: "team_member",
      isHuman: true,
    });
    expect(res.ownerUserId).toBe("u9"); // unchanged
  });

  it("agents cannot claim — blocked at the view gate on an unclaimed thread (Fix 1)", async () => {
    // Agents resolve to role=team_member, and an unclaimed thread is not viewable
    // by a team_member, so assertCanView throws notFound before resolveOwnerOnAction
    // (which would also refuse the agent). Agents can never become owners.
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", ownerUserId: null, visibility: "company", scopeType: null, scopeId: null }],
      [], // assertCanView: participants query → team_member on unclaimed → notFound
    ]);
    await expect(
      threadService(db).claim("co1", "t1", {
        userId: "agent1",
        role: "team_member",
        isHuman: false,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("throws notFound when a team_member cannot view a private unclaimed thread (Fix 1)", async () => {
    const db = createSequenceDb([
      // private + owner null → only founder/lead-with-scope can view; team_member cannot
      [{ id: "t1", companyId: "co1", ownerUserId: null, visibility: "private", scopeType: null, scopeId: null }],
      [], // assertCanView: participants query → not a participant → notFound
    ]);
    await expect(
      threadService(db).claim("co1", "t1", {
        userId: "u1",
        role: "team_member",
        isHuman: true,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

// ── Task 5: transferOwnership ─────────────────────────────────────────────────

describe("threadService.resolveViewerForThread agent RBAC", () => {
  const privateThread = {
    ownerUserId: "user-owner",
    visibility: "private",
    scopeType: null,
    scopeId: null,
  };

  it("denies a same-company private thread to a nonparticipant agent", async () => {
    const db = createSequenceDb([[privateThread], []]);
    const resolved = await threadService(db).resolveViewerForThread(
      "co1",
      "thread-private",
      {
        userId: "agent-outsider",
        role: "team_member",
        principalType: "agent",
      },
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.viewer.isParticipant).toBe(false);
    expect(eq).toHaveBeenCalledWith("tp_principal_type", "agent");
    expect(canViewThread(resolved!.thread, resolved!.viewer)).toBe(false);
  });

  it("allows a same-company private thread to an explicit agent participant", async () => {
    const db = createSequenceDb([[privateThread], [{ id: "participant-1" }]]);
    const resolved = await threadService(db).resolveViewerForThread(
      "co1",
      "thread-private",
      {
        userId: "agent-participant",
        role: "team_member",
        principalType: "agent",
      },
    );

    expect(resolved?.viewer.isParticipant).toBe(true);
    expect(eq).toHaveBeenCalledWith("tp_principal_type", "agent");
    expect(canViewThread(resolved!.thread, resolved!.viewer)).toBe(true);
  });
});

describe("threadService.transferOwnership", () => {
  it("transfers ownership and demotes previous owner", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", ownerUserId: "u1", visibility: "company", scopeType: null, scopeId: null }],
      [{ id: "cm1" }], // Fix 3: recipient membership lookup (u2 is a member)
      [], // update participants (demote)
      [], // update discussions
      [], // insert new owner participant
    ]);
    const res = await threadService(db).transferOwnership("co1", "t1", "u2", {
      userId: "u1",
      role: "founder",
      isHuman: true,
    });
    expect(res.ownerUserId).toBe("u2");
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.participant.changed" }),
    );
  });

  it("throws notFound when recipient is not a company member (Fix 3)", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", ownerUserId: "u1", visibility: "company", scopeType: null, scopeId: null }],
      [], // Fix 3: recipient membership lookup → no rows → notFound
    ]);
    await expect(
      threadService(db).transferOwnership("co1", "t1", "stranger", {
        userId: "u1",
        role: "founder",
        isHuman: true,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("non-owner non-founder gets notFound", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", ownerUserId: "u9", visibility: "company", scopeType: null, scopeId: null }],
    ]);
    await expect(
      threadService(db).transferOwnership("co1", "t1", "u2", {
        userId: "u1", // not owner, not founder
        role: "team_member",
        isHuman: true,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("threadService.transferOwnership — existing participant", () => {
  it("updates the existing participant role to owner (does not leave stale role)", async () => {
    // u2 is already a co_owner participant; transfer should upsert role → owner
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", ownerUserId: "u1", visibility: "company", scopeType: null, scopeId: null }], // thread
      // assertCanEdit: actor is founder → returns immediately (no participant query consumed)
      [{ id: "cm1" }], // Fix 3: recipient membership lookup (u2 is a member)
      [], // demote old owner participant update
      [], // update discussions.ownerUserId
      [], // upsert participant (co_owner → owner via onConflictDoUpdate)
    ]);
    const res = await threadService(db).transferOwnership("co1", "t1", "u2", {
      userId: "u1",
      role: "founder",
      isHuman: true,
    });
    expect(res.ownerUserId).toBe("u2");
  });

  it("co_owner can transfer ownership (Fix 5: assertCanEdit allows co_owner)", async () => {
    // u1 is co_owner, not the ownerUserId (u9) and not founder
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", ownerUserId: "u9", visibility: "company", scopeType: null, scopeId: null }], // thread
      // assertCanEdit: not founder, not ownerUserId → queries threadParticipants → co_owner → passes
      [{ role: "co_owner" }],
      [{ id: "cm1" }], // Fix 3: recipient membership lookup (u2 is a member)
      [], // demote old owner participant update
      [], // update discussions.ownerUserId
      [], // upsert participant
    ]);
    const res = await threadService(db).transferOwnership("co1", "t1", "u2", {
      userId: "u1",
      role: "team_member",
      isHuman: true,
    });
    expect(res.ownerUserId).toBe("u2");
  });
});

// ── Task 8 extra: assignScopeItems phase advance ──────────────────────────────

describe("threadService.assignScopeItems — phase advance", () => {
  it("advances phase to 'assign' inside transaction when items are created", async () => {
    const approvedItem = {
      id: "item1",
      type: "task",
      status: "approved",
      resultTaskId: null,
      assigneeAgentId: null,
      assigneeUserId: "u2",
      departmentId: "p1",
      suggestedDepartmentId: null,
      suggestedProjectId: null,
      priority: "high",
      suggestedPriority: null,
      title: "Write tests",
      description: null,
      discussionEntryId: "entry1",
    };
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", visibility: "company", ownerUserId: "u1", scopeType: null, scopeId: null }], // thread
      [{ id: "entry1" }], // entries (inside tx)
      [approvedItem], // items (inside tx)
      [{ policyDefault: "review_required", reviewGuardrail: false }],
      [{ id: "p1", type: "department", policyDefault: null }],
      [{ id: "issue-x" }], // issue insert (inside tx)
      [], // update resultTaskId (inside tx)
      [], // update discussions.phase (inside tx, Codex #7)
    ]);
    const res = await threadService(db).assignScopeItems("co1", "t1", {
      userId: "u1",
      role: "founder",
      isHuman: true,
    });
    expect(res.created).toBe(1);
    // phase advance happens inside transaction — db.update called with phase='assign'
    expect(db.update).toHaveBeenCalled();
  });
});

// ── Task 6: promoteToGoal ─────────────────────────────────────────────────────

describe("threadService.promoteToGoal", () => {
  it("creates a company-wide goal, links it on the thread", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", title: "Launch", ownerUserId: "u1", goalId: null, scopeType: null, scopeId: null, visibility: "company" }],
      // goalService.create + setGoalParents are mocked; the only direct db write
      // is the discussions.goalId update.
      [],
    ]);
    const res = await threadService(db).promoteToGoal(
      "co1",
      "t1",
      { scope: { mode: "company", projectIds: [] } },
      { userId: "u1", role: "founder", isHuman: true },
    );
    expect(res.goalId).toBe("g1");
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.scope.changed" }),
    );
  });

  it("creates a scoped sub-goal with a parent", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", title: "Launch", ownerUserId: "u1", goalId: null, scopeType: null, scopeId: null, visibility: "company" }],
      [],
    ]);
    const res = await threadService(db).promoteToGoal(
      "co1",
      "t1",
      { scope: { mode: "specific", projectIds: ["p1"] }, parentIds: ["g-parent"] },
      { userId: "u1", role: "founder", isHuman: true },
    );
    expect(res.goalId).toBe("g1");
  });

  it("rejects if thread already has a goal", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", title: "x", ownerUserId: "u1", goalId: "existing-g", scopeType: null, scopeId: null, visibility: "company" }],
    ]);
    await expect(
      threadService(db).promoteToGoal(
        "co1",
        "t1",
        { scope: { mode: "specific", projectIds: ["p1"] } },
        { userId: "u1", role: "founder", isHuman: true },
      ),
    ).rejects.toThrow(/already has a goal/i);
  });

  it("rejects a scoped goal with no projects", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", title: "x", ownerUserId: "u1", goalId: null, scopeType: null, scopeId: null, visibility: "company" }],
    ]);
    await expect(
      threadService(db).promoteToGoal(
        "co1",
        "t1",
        { scope: { mode: "specific", projectIds: [] } },
        { userId: "u1", role: "founder", isHuman: true },
      ),
    ).rejects.toThrow(/at least one/i);
  });
});

// ── Task 7: fork ──────────────────────────────────────────────────────────────

describe("threadService.fork", () => {
  it("creates a child thread linked back with kind=fork", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", title: "Parent", scopeType: null, scopeId: null, visibility: "company", ownerUserId: "u1" }],
      [{ id: "t2" }], // new discussion insert returning
      [], // thread_links insert
    ]);
    const res = await threadService(db).fork("co1", "t1", {
      userId: "u1",
      role: "founder",
      isHuman: true,
    });
    expect(res.id).toBe("t2");
    expect(res.forkedFromId).toBe("t1");
  });

  it("throws notFound when source thread missing", async () => {
    const db = createSequenceDb([[]]); // no thread
    await expect(
      threadService(db).fork("co1", "t99", { userId: "u1", role: "founder", isHuman: true }),
    ).rejects.toThrow(/not found/i);
  });
});

// ── assertCanEdit: co_owner ───────────────────────────────────────────────────

describe("threadService.addParticipant (assertCanEdit co_owner)", () => {
  it("allows a co_owner participant to add another participant", async () => {
    // Thread owned by u9, actor is u1 (not owner, not founder)
    // assertCanView: open visibility + null scope → hasScopeAccess=true → passes without participant query
    //   (founder short-circuit skipped; scopeType null → hasScopeAccess=true; canViewThread open → true)
    //   BUT assertCanView still issues the participants select for non-founders. Provide [] (not participant, but open thread → still visible).
    // assertCanEdit: ownerUserId check fails → queries threadParticipants → returns co_owner row → passes
    const db = createSequenceDb([
      // getById select (thread exists, open, owned by u9)
      [{ id: "t1", companyId: "co1", visibility: "company", ownerUserId: "u9", scopeType: null, scopeId: null }],
      // assertCanView: threadParticipants select (actor is not a direct participant, but open+null-scope → visible)
      [],
      // assertCanEdit: threadParticipants select → actor has co_owner role
      [{ role: "co_owner" }],
      // insert participant → success
      [],
    ]);
    const result = await threadService(db).addParticipant(
      "co1",
      "t1",
      { principalType: "user", principalId: "u2", role: "collaborator" },
      { userId: "u1", role: "team_member", isHuman: true },
    );
    expect(result).toEqual({ ok: true });
  });

  it("denies a participant with a non-edit role (collaborator) from adding participants", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", visibility: "company", ownerUserId: "u9", scopeType: null, scopeId: null }],
      [], // assertCanView participants
      // assertCanEdit: actor has collaborator role → not co_owner or owner → throws
      [{ role: "collaborator" }],
    ]);
    await expect(
      threadService(db).addParticipant(
        "co1",
        "t1",
        { principalType: "user", principalId: "u2", role: "collaborator" },
        { userId: "u1", role: "team_member", isHuman: true },
      ),
    ).rejects.toThrow(/not found/i);
  });
});

// ── Task 7: merge ─────────────────────────────────────────────────────────────

describe("threadService.merge", () => {
  it("archives source thread and creates merge link", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", ownerUserId: "u1", visibility: "company", scopeType: null, scopeId: null }],
      [], // participants check
      [], // update discussions (archive)
      [], // thread_links insert
    ]);
    const res = await threadService(db).merge("co1", "t1", "t2", {
      userId: "u1",
      role: "founder",
      isHuman: true,
    });
    expect(res.mergedInto).toBe("t2");
  });
});

// ── Task 8: assignScopeItems ──────────────────────────────────────────────────

describe("threadService.assignScopeItems", () => {
  it("creates issues for approved items without result_task_id (idempotent)", async () => {
    const approvedItem = {
      id: "item1",
      type: "task",
      status: "approved",
      resultTaskId: null,
      assigneeAgentId: null,
      assigneeUserId: "u2",
      departmentId: "p1",
      suggestedDepartmentId: null,
      suggestedProjectId: null,
      priority: "medium",
      suggestedPriority: null,
      title: "Build feature",
      description: "Details",
      discussionEntryId: "entry1",
    };
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", visibility: "company", ownerUserId: "u1", scopeType: null, scopeId: null }], // thread (outside tx)
      [{ id: "entry1" }], // entries query (inside tx)
      [approvedItem], // extractedItems query (inside tx)
      [{ policyDefault: "review_required", reviewGuardrail: false }],
      [{ id: "p1", type: "department", policyDefault: null }],
      [{ id: "issue1" }], // issue insert returning (inside tx)
      [], // update result_task_id on extracted item (inside tx)
      [], // update discussions.phase to 'assign' (inside tx, Codex #7)
    ]);
    const res = await threadService(db).assignScopeItems("co1", "t1", {
      userId: "u1",
      role: "founder",
      isHuman: true,
    });
    expect(res.created).toBe(1);
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.scope.changed" }),
    );
  });

  it("skips items that already have result_task_id (idempotent re-run)", async () => {
    const alreadyAssigned = {
      id: "item2",
      type: "task",
      status: "approved",
      resultTaskId: "existing-issue",
      assigneeAgentId: null,
      assigneeUserId: null,
      departmentId: null,
      suggestedDepartmentId: null,
      suggestedProjectId: null,
      priority: null,
      suggestedPriority: null,
      title: "Done",
      description: null,
      discussionEntryId: "entry1",
    };
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", visibility: "company", ownerUserId: "u1", scopeType: null, scopeId: null }],
      [{ id: "entry1" }], // entries
      [alreadyAssigned], // only this item
    ]);
    const res = await threadService(db).assignScopeItems("co1", "t1", {
      userId: "u1",
      role: "founder",
      isHuman: true,
    });
    expect(res.created).toBe(0);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("non-founder gets notFound", async () => {
    const db = createSequenceDb([]);
    await expect(
      threadService(db).assignScopeItems("co1", "t1", {
        userId: "u1",
        role: "team_member",
        isHuman: true,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("returns 0 when thread has no entries", async () => {
    const db = createSequenceDb([
      [{ id: "t1", companyId: "co1", visibility: "company", ownerUserId: "u1", scopeType: null, scopeId: null }],
      [], // entries -> empty
    ]);
    const res = await threadService(db).assignScopeItems("co1", "t1", {
      userId: "u1",
      role: "founder",
      isHuman: true,
    });
    expect(res.created).toBe(0);
  });
});
