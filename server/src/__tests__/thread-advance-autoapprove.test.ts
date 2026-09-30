/**
 * thread-advance-autoapprove.test.ts — Task 2.6 (Crew Work-as-Tasks)
 *
 * Tests for phase-advance auto-approve behavior in threadService.advancePhase:
 *
 *   T1. Advancing to "assign" at L2 with a pending proposal →
 *       approveAndDispatch invoked for that proposal + tasks dispatched.
 *   T2. Advancing to "assign" at L0 →
 *       proposal left pending, NO approveAndDispatch call.
 *   T3. Advancing to "assign" at L1 →
 *       proposal left pending, NO approveAndDispatch call.
 *   T4. Advancing to "assign" with no pending proposal →
 *       advance only, no approveAndDispatch call.
 *   T5. (Regression) Advancing to "scope" at L2 →
 *       the old Dispatcher-wakeup is NOT called (it was removed).
 *   T6. Advancing to "assign" at L2 with no pending proposal →
 *       advance succeeds, no error, no approveAndDispatch call.
 *
 * Mock strategy: follows threads-service.test.ts pattern.
 *   - drizzle-orm + @armyofagents/db mocked with field stubs.
 *   - crew-task-service mocked to capture approveAndDispatch calls.
 *   - activity-log, live-events, goals mocked as no-ops.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Drizzle + DB mocks ────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  desc: vi.fn((col: any) => ({ desc: col })),
  asc: vi.fn((col: any) => ({ asc: col })),
  gt: vi.fn((a: any, b: any) => ({ gt: [a, b] })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
  isNull: vi.fn((col: any) => ({ isNull: col })),
  or: vi.fn((...args: any[]) => ({ or: args })),
  sql: vi.fn(),
}));

vi.mock("@armyofagents/db", () => ({
  discussions: {
    id: "discussions_id",
    companyId: "discussions_company_id",
    phase: "discussions_phase",
    visibility: "discussions_visibility",
    ownerUserId: "discussions_owner_user_id",
    scopeType: "discussions_scope_type",
    scopeId: "discussions_scope_id",
    autonomyLevel: "discussions_autonomy_level",
    useControllerPath: "discussions_use_controller_path",
    updatedAt: "discussions_updated_at",
  },
  internalAgentConfig: {
    companyId: "iac_company_id",
    autonomyLevel: "iac_autonomy_level",
  },
  discussionEntries: {
    id: "de_id",
    discussionId: "de_discussion_id",
    inputType: "de_input_type",
    proposalStatus: "de_proposal_status",
    seq: "de_seq",
  },
  threadParticipants: {
    id: "tp_id",
    companyId: "tp_company_id",
    threadId: "tp_thread_id",
    principalType: "tp_principal_type",
    principalId: "tp_principal_id",
    role: "tp_role",
  },
  userRoles: {
    id: "ur_id",
    companyId: "ur_company_id",
    userId: "ur_user_id",
    projectId: "ur_project_id",
    role: "ur_role",
  },
  threadLinks: {
    id: "tl_id",
    companyId: "tl_company_id",
    fromThreadId: "tl_from",
    toThreadId: "tl_to",
    kind: "tl_kind",
    createdBy: "tl_created_by",
  },
  threadPlanSteps: {
    id: "tps_id",
    threadId: "tps_thread_id",
    stepOrder: "tps_step_order",
  },
  scopeItemDependencies: { id: "sid_id", blockerItemId: "sid_blocker", blockedItemId: "sid_blocked" },
  taskDependencies: { id: "td_id", companyId: "td_company_id", dependentIssueId: "td_dependent", dependencyIssueId: "td_dependency" },
  issues: { id: "issues_id", companyId: "issues_company_id", workMode: "issues_work_mode" },
  discussionExtractedItems: { id: "dei_id", discussionEntryId: "dei_discussion_entry_id", status: "dei_status", resultTaskId: "dei_result_task_id" },
  agents: { id: "a_id", companyId: "a_company_id", name: "a_name", kind: "a_kind" },
  authUsers: { id: "au_id", name: "au_name" },
  companyMemberships: { id: "cm_id", companyId: "cm_company_id", principalType: "cm_principal_type", principalId: "cm_principal_id" },
  agentWakeupRequests: { id: "awr_id" },
  aoaAgentTriggers: { agentId: "aat_agent_id", companyId: "aat_company_id", kind: "aat_kind", enabled: "aat_enabled", config: "aat_config" },
  notifications: { id: "n_id" },
  memoryItems: { id: "mi_id" },
  goals: { id: "goals_id" },
  projects: { id: "projects_id" },
  activityLog: { id: "al_id" },
}));

// ── crew-task-service mock ────────────────────────────────────────────────────
vi.mock("../services/crew-task-service.js", () => ({
  crewTaskService: vi.fn(() => ({
    approveAndDispatch: vi.fn(),
    proposeWork: vi.fn(),
  })),
  resolveCreationGate: vi.fn((autonomy: number | null | undefined) =>
    typeof autonomy === "number" && autonomy >= 2 ? "auto_approve" : "await_human",
  ),
}));

// ── Shared service mocks ──────────────────────────────────────────────────────
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

vi.mock("../services/goals.js", () => ({
  goalService: vi.fn(() => ({
    create: vi.fn(),
    assertParentsValid: vi.fn(),
    setGoalParents: vi.fn(),
  })),
}));

vi.mock("../services/notifications.js", () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../redaction.js", () => ({
  sanitizeRecord: vi.fn((r: any) => r),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import { threadService } from "../services/threads.js";
import { crewTaskService, resolveCreationGate } from "../services/crew-task-service.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const CO_ID = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
const THREAD_ID = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";
const PROPOSAL_ID = "cccccccc-0000-4000-8000-cccccccccccc";
const USER_ID = "eeeeeeee-0000-4000-8000-eeeeeeeeeeee";

const FOUNDER = { userId: USER_ID, role: "founder" as const, isHuman: true };

// ─── Mock DB helper ───────────────────────────────────────────────────────────

/**
 * createSequenceDb: each call to .select().from().where().then() or similar
 * consumes the next item in selectQueue. Allows precise per-call control.
 */
function createSequenceDb(selectQueue: any[][]) {
  let idx = 0;

  function makeSelectChain() {
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn(selectQueue[idx++] ?? [])),
      ),
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

  const dbObj: any = {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => makeUpdateChain()),
    insert: vi.fn(() => makeInsertChain()),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(dbObj)),
  };
  return dbObj;
}

// ─── Typed mock accessors ─────────────────────────────────────────────────────

/** Build a thread row that will be returned by the initial select in advancePhase */
function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD_ID,
    companyId: CO_ID,
    phase: "scope",
    visibility: "company",
    ownerUserId: USER_ID,
    scopeType: null,
    scopeId: null,
    autonomyLevel: null,
    useControllerPath: false,
    ...overrides,
  };
}

let mockApproveAndDispatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();

  // Set up stable approveAndDispatch mock returned from the crewTaskService factory
  mockApproveAndDispatch = vi.fn().mockResolvedValue({
    approved: true,
    createdIssueIds: ["task-1", "task-2"],
  });

  vi.mocked(crewTaskService).mockReturnValue({
    approveAndDispatch: mockApproveAndDispatch,
    proposeWork: vi.fn(),
  } as any);
});

// ═══════════════════════════════════════════════════════════════════════════════
// T1. Advancing to "assign" at L2 with a pending proposal
// ═══════════════════════════════════════════════════════════════════════════════

describe("T1. advance to 'assign' at L2 with a pending proposal", () => {
  it("auto-approves the pending scope card and dispatches", async () => {
    const thread = makeThread({ phase: "scope", autonomyLevel: 2 });

    const db = createSequenceDb([
      [thread],                         // fetch thread row
      [],                               // update discussions (phase update)
      [{ autonomyLevel: 0 }],           // company config fetch (thread L2 wins, company value irrelevant)
      [{ id: PROPOSAL_ID }],            // find pending scope_proposal entry
    ]);

    const svc = threadService(db);
    const result = await svc.advancePhase(CO_ID, THREAD_ID, "assign", FOUNDER);

    expect(result.phase).toBe("assign");

    // resolveCreationGate must have been called with effective autonomy = 2
    expect(resolveCreationGate).toHaveBeenCalledWith(2);

    // crewTaskService must have been instantiated and approveAndDispatch called
    expect(crewTaskService).toHaveBeenCalledWith(db);
    expect(mockApproveAndDispatch).toHaveBeenCalledTimes(1);
    expect(mockApproveAndDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        companyId: CO_ID,
        proposalEntryId: PROPOSAL_ID,
        approverUserId: USER_ID,
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T2. Advancing to "assign" at L0 — proposal left pending
// ═══════════════════════════════════════════════════════════════════════════════

describe("T2. advance to 'assign' at L0 (await_human) — proposal NOT approved", () => {
  it("advances phase but does NOT call approveAndDispatch", async () => {
    // Stub resolveCreationGate to return await_human for autonomy=0
    vi.mocked(resolveCreationGate).mockReturnValue("await_human");

    const thread = makeThread({ phase: "scope", autonomyLevel: 0 });

    const db = createSequenceDb([
      [thread],               // fetch thread row
      [],                     // update discussions
      [{ autonomyLevel: 0 }], // company config fetch (thread L0 wins)
      // NO pending-proposal select should happen (gate is await_human)
    ]);

    const svc = threadService(db);
    const result = await svc.advancePhase(CO_ID, THREAD_ID, "assign", FOUNDER);

    expect(result.phase).toBe("assign");
    expect(resolveCreationGate).toHaveBeenCalledWith(0);
    expect(mockApproveAndDispatch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T3. Advancing to "assign" at L1 — proposal left pending
// ═══════════════════════════════════════════════════════════════════════════════

describe("T3. advance to 'assign' at L1 (await_human) — proposal NOT approved", () => {
  it("advances phase but does NOT call approveAndDispatch", async () => {
    vi.mocked(resolveCreationGate).mockReturnValue("await_human");

    const thread = makeThread({ phase: "scope", autonomyLevel: 1 });

    const db = createSequenceDb([
      [thread],               // fetch thread row
      [],                     // update discussions
      [{ autonomyLevel: 0 }], // company config fetch (thread L1 wins)
    ]);

    const svc = threadService(db);
    const result = await svc.advancePhase(CO_ID, THREAD_ID, "assign", FOUNDER);

    expect(result.phase).toBe("assign");
    expect(resolveCreationGate).toHaveBeenCalledWith(1);
    expect(mockApproveAndDispatch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T4. Advancing to "assign" with NO pending proposal — advance only
// ═══════════════════════════════════════════════════════════════════════════════

describe("T4. advance to 'assign' at L2 but NO pending proposal exists", () => {
  it("advances phase, does NOT call approveAndDispatch", async () => {
    // resolveCreationGate returns auto_approve for L2
    vi.mocked(resolveCreationGate).mockReturnValue("auto_approve");

    const thread = makeThread({ phase: "scope", autonomyLevel: 2 });

    const db = createSequenceDb([
      [thread],               // fetch thread row
      [],                     // update discussions
      [{ autonomyLevel: 0 }], // company config fetch (thread L2 wins)
      [],                     // pending-proposal select → empty (no pending proposal)
    ]);

    const svc = threadService(db);
    const result = await svc.advancePhase(CO_ID, THREAD_ID, "assign", FOUNDER);

    expect(result.phase).toBe("assign");
    // No pending proposal → approveAndDispatch NOT called
    expect(mockApproveAndDispatch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T5. (Regression) Advancing to "scope" — old Dispatcher wakeup NOT called
// ═══════════════════════════════════════════════════════════════════════════════

describe("T5. (regression) advancing to 'scope' — old Dispatcher wakeup not called", () => {
  it("does not insert into agentWakeupRequests for phase-advance triggers", async () => {
    const thread = makeThread({ phase: "discuss", autonomyLevel: 2 });

    const db = createSequenceDb([
      [thread],   // fetch thread row
      [],         // update discussions
      // Note: if old Dispatcher coupling existed, there would be an aoaAgentTriggers select here.
      // After Task 2.6 removal, nothing else is queried for "scope" target.
    ]);

    const svc = threadService(db);
    const result = await svc.advancePhase(CO_ID, THREAD_ID, "scope", FOUNDER);

    expect(result.phase).toBe("scope");

    // Verify db.insert was NOT called (no agentWakeupRequests insert)
    expect(db.insert).not.toHaveBeenCalled();

    // approveAndDispatch not called (target is "scope", not "assign")
    expect(mockApproveAndDispatch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T6. thread.autonomyLevel=null, company L0 → still await_human (no auto-approve)
// ═══════════════════════════════════════════════════════════════════════════════

describe("T6. thread autonomyLevel=null + company L0 → resolveCreationGate gets 0 (await_human)", () => {
  it("falls back to company L0, leaves pending proposal, does NOT call approveAndDispatch", async () => {
    vi.mocked(resolveCreationGate).mockReturnValue("await_human");

    const thread = makeThread({ phase: "scope", autonomyLevel: null });

    const db = createSequenceDb([
      [thread],               // fetch thread row
      [],                     // update discussions
      [{ autonomyLevel: 0 }], // company config fetch → L0 (fallback)
    ]);

    const svc = threadService(db);
    const result = await svc.advancePhase(CO_ID, THREAD_ID, "assign", FOUNDER);

    expect(result.phase).toBe("assign");
    // With the company fallback: thread.autonomyLevel=null, company=0 → effective=0
    expect(resolveCreationGate).toHaveBeenCalledWith(0);
    expect(mockApproveAndDispatch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T7. thread.autonomyLevel=null, company L2 → company fallback triggers auto-approve
// ═══════════════════════════════════════════════════════════════════════════════

describe("T7. thread autonomyLevel=null + company L2 → company fallback triggers auto-approve", () => {
  it("uses company L2 as effective autonomy and auto-approves the pending proposal", async () => {
    // resolveCreationGate returns auto_approve for autonomy=2
    vi.mocked(resolveCreationGate).mockReturnValue("auto_approve");

    const thread = makeThread({ phase: "scope", autonomyLevel: null });

    const db = createSequenceDb([
      [thread],               // fetch thread row
      [],                     // update discussions
      [{ autonomyLevel: 2 }], // company config fetch → L2 (fallback used)
      [{ id: PROPOSAL_ID }],  // find pending scope_proposal entry
    ]);

    const svc = threadService(db);
    const result = await svc.advancePhase(CO_ID, THREAD_ID, "assign", FOUNDER);

    expect(result.phase).toBe("assign");
    // effective autonomy = company L2 (thread was null)
    expect(resolveCreationGate).toHaveBeenCalledWith(2);

    // auto-approve triggered by company fallback
    expect(crewTaskService).toHaveBeenCalledWith(db);
    expect(mockApproveAndDispatch).toHaveBeenCalledTimes(1);
    expect(mockApproveAndDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        companyId: CO_ID,
        proposalEntryId: PROPOSAL_ID,
        approverUserId: USER_ID,
      }),
    );
  });

  it("uses company L2 fallback: advance succeeds even with no pending proposal", async () => {
    vi.mocked(resolveCreationGate).mockReturnValue("auto_approve");

    const thread = makeThread({ phase: "scope", autonomyLevel: null });

    const db = createSequenceDb([
      [thread],               // fetch thread row
      [],                     // update discussions
      [{ autonomyLevel: 2 }], // company config fetch → L2 (fallback used)
      [],                     // pending-proposal select → empty
    ]);

    const svc = threadService(db);
    const result = await svc.advancePhase(CO_ID, THREAD_ID, "assign", FOUNDER);

    expect(result.phase).toBe("assign");
    expect(resolveCreationGate).toHaveBeenCalledWith(2);
    // No pending proposal → approveAndDispatch NOT called
    expect(mockApproveAndDispatch).not.toHaveBeenCalled();
  });
});
