// W1c Task 1 — crew_dispatch approve() side-effect.
//
// Proves the new `crew_dispatch` branch of approvalService.approve():
//   (a) preflight allowed  → flips each `planning` task to `standard` (via
//       db.update(issues)) and calls dispatchCreatedCrewTasks with those tasks.
//   (b) preflight blocked   → approve() THROWS and dispatchCreatedCrewTasks is
//       NOT called (the route runs approve() in a txn, so the throw rolls the
//       status flip back and the approval stays pending).
//   (c) eng-review finding A → a task already `standard` in the payload is NOT
//       re-flipped and NOT re-dispatched (no duplicate wakeup). This approval
//       only owns the tasks it itself flips planning→standard.
//
// Mock style mirrors approvals-service-companyid.test.ts: makeTableProxy +
// drizzleOperatorStubs for the schema/operator ESM cycle, a hand-rolled db
// whose select() is sequence-driven (first read = the approval row, second
// read = the issues rows) and whose update(issues) is observable.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  approvals: makeTableProxy("approvals"),
  approvalComments: makeTableProxy("approval_comments"),
  issues: makeTableProxy("issues"),
  agents: makeTableProxy("agents"),
  companies: makeTableProxy("companies"),
  notifications: makeTableProxy("notifications"),
  agentProjects: makeTableProxy("agent_projects"),
  projects: makeTableProxy("projects"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// approvalService() constructs agentService(db) at build time. We never take
// the hire_agent branch here (type is "crew_dispatch"), so an empty stub is fine.
vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    activatePendingApproval: vi.fn(),
    create: vi.fn(),
    terminate: vi.fn(),
  }),
}));

// The two collaborators under test — hoisted so the mock factories can close
// over them and the test body can assert on them.
const mocks = vi.hoisted(() => ({
  preflightCrewDispatch: vi.fn(),
  dispatchCreatedCrewTasks: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/crew-budget.js", () => ({
  preflightCrewDispatch: mocks.preflightCrewDispatch,
}));
vi.mock("../services/crew-task-service.js", () => ({
  dispatchCreatedCrewTasks: mocks.dispatchCreatedCrewTasks,
}));
// approve()'s crew_dispatch branch logs each planning→standard dispatch (Codex #267 P2).
// Mock it (logActivity imports activityLog from the mocked db, which this test doesn't stub).
vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

import { approvalService } from "../services/approvals.js";

const COMPANY = "company-A";
const THREAD = "thread-1";

/**
 * Build a mock db for a crew_dispatch approve() run.
 *
 * @param updatedApproval  the row returned by the guarded approvals UPDATE.
 * @param taskRows         the issues rows the branch's SELECT returns.
 *
 * select() is sequence-driven: the 1st select is getExistingApproval (returns
 * the pending approval), the 2nd select is the crew_dispatch branch's issues
 * read (returns taskRows). update() is observed via `issueUpdateSets`, which
 * records the .set() payload for every UPDATE targeting the issues table.
 */
function makeDb(
  updatedApproval: unknown,
  taskRows: unknown[],
  opts: { issuesFlipReturnsEmpty?: boolean } = {},
) {
  // When true, the guarded issues UPDATE matches 0 rows — simulates a concurrent founder
  // move between the SELECT and the UPDATE (TOCTOU). The task must then NOT be dispatched.
  const issuesFlipReturnsEmpty = opts.issuesFlipReturnsEmpty ?? false;
  // The pre-update `existing` row carries the SAME payload as the updated row (the
  // status flip does not touch payload). approve() reads threadId/taskIds from
  // `existing` for the pre-flip preflight, so mirror the payload here.
  const existingApproval = {
    id: "ap1",
    companyId: COMPANY,
    status: "pending",
    type: "crew_dispatch",
    payload: (updatedApproval as { payload?: Record<string, unknown> } | undefined)?.payload ?? {},
  };

  // getExistingApproval reads first, then the branch reads issues.
  const selectResults: unknown[][] = [[existingApproval], taskRows];
  let selectIdx = 0;

  const makeSelectChain = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => Promise.resolve(rows);
    chain.then = (resolve: (rows: unknown[]) => unknown) => resolve(rows);
    return chain;
  };

  const issueUpdateSets: Array<Record<string, unknown>> = [];
  const state = { approvalsUpdated: false };

  // approve() pre-filters to planning+todo tasks, then UPDATEs each in order. The guarded
  // UPDATE RETURNs the current { id, assigneeAgentId }, which approve() uses for dispatch —
  // so pop the dispatchable rows in order to mirror the current assignee.
  const dispatchable = (taskRows as Array<{ id: string; assigneeAgentId: string | null; workMode?: string; status?: string }>)
    .filter((t) => t.workMode === "planning" && t.status === "todo");
  let flipIdx = 0;

  return {
    db: {
      select: () => {
        const rows = selectResults[selectIdx] ?? [];
        selectIdx += 1;
        return makeSelectChain(rows);
      },
      update: (table: { _?: { name?: string } }) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            if (table?._?.name === "approvals") state.approvalsUpdated = true;
            // The guarded issues UPDATE returns the flipped row(s); [] means it matched
            // nothing (concurrent move) and the code must skip dispatch for that task.
            const flipRow = dispatchable[flipIdx];
            if (table?._?.name === "issues") flipIdx += 1;
            const rows =
              table?._?.name === "approvals"
                ? [updatedApproval]
                : table?._?.name === "issues"
                  ? issuesFlipReturnsEmpty || !flipRow
                    ? []
                    : [{ id: flipRow.id, assigneeAgentId: flipRow.assigneeAgentId }]
                  : [];
            if (table?._?.name === "issues" && rows.length > 0) issueUpdateSets.push(values);
            return {
              returning: () => ({
                then: (resolve: (r: unknown[]) => unknown) => resolve(rows),
              }),
            };
          },
        }),
      }),
      insert: () => ({
        values: () => ({ returning: () => Promise.resolve([]) }),
      }),
      delete: () => ({ where: () => Promise.resolve() }),
    } as any,
    issueUpdateSets,
    state,
  };
}

const approvedRow = (payload: Record<string, unknown>) => ({
  id: "ap1",
  companyId: COMPANY,
  type: "crew_dispatch",
  status: "approved",
  payload,
});

beforeEach(() => {
  mocks.preflightCrewDispatch.mockReset();
  mocks.dispatchCreatedCrewTasks.mockReset();
  mocks.dispatchCreatedCrewTasks.mockResolvedValue(undefined);
  mocks.logActivity.mockReset();
  mocks.logActivity.mockResolvedValue(undefined);
});

describe("approvalService.approve — crew_dispatch branch", () => {
  it("(a) preflight allowed: flips planning tasks to standard and dispatches them", async () => {
    mocks.preflightCrewDispatch.mockResolvedValue({ allowed: true });

    const taskRows = [
      { id: "t1", assigneeAgentId: "agent-1", workMode: "planning", status: "todo" },
      { id: "t2", assigneeAgentId: "agent-2", workMode: "planning", status: "todo" },
    ];
    const { db, issueUpdateSets } = makeDb(
      approvedRow({ threadId: THREAD, taskIds: ["t1", "t2"] }),
      taskRows,
    );

    const svc = approvalService(db);
    const result = await svc.approve("ap1", COMPANY, "user-A", "go");

    expect(result).not.toBeNull();
    expect(mocks.preflightCrewDispatch).toHaveBeenCalledWith(db, {
      companyId: COMPANY,
      agentId: "",
      threadId: THREAD,
    });

    // both planning tasks flipped to standard
    expect(issueUpdateSets).toHaveLength(2);
    for (const s of issueUpdateSets) {
      expect(s.workMode).toBe("standard");
      expect(s.updatedAt).toBeInstanceOf(Date);
    }

    // dispatched with the flipped tasks (workMode now "standard")
    expect(mocks.dispatchCreatedCrewTasks).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchCreatedCrewTasks).toHaveBeenCalledWith(db, COMPANY, [
      { id: "t1", assigneeAgentId: "agent-1", workMode: "standard" },
      { id: "t2", assigneeAgentId: "agent-2", workMode: "standard" },
    ]);

    // Codex #267 P2: each planning→standard dispatch is activity-logged for audit
    expect(mocks.logActivity).toHaveBeenCalledTimes(2);
    expect(mocks.logActivity.mock.calls[0][1]).toMatchObject({
      action: "crew_dispatch.task_dispatched",
      entityType: "issue",
      entityId: "t1",
    });
  });

  it("(b) preflight blocked: approve() throws and does NOT dispatch", async () => {
    mocks.preflightCrewDispatch.mockResolvedValue({
      allowed: false,
      reason: "Crew budget reached",
      reasonCode: "budget_exhausted",
    });

    const { db, issueUpdateSets, state } = makeDb(
      approvedRow({ threadId: THREAD, taskIds: ["t1"] }),
      [{ id: "t1", assigneeAgentId: "agent-1", workMode: "planning", status: "todo" }],
    );

    const svc = approvalService(db);

    await expect(svc.approve("ap1", COMPANY, "user-A", "go")).rejects.toThrow(
      /Cannot dispatch crew work/,
    );

    // Codex #267 P1: the preflight gates BEFORE the status flip, so a blocked dispatch
    // never closes the approval — it stays pending + retryable for EVERY caller
    // (the MCP approval tool calls approve() without a wrapping transaction).
    expect(state.approvalsUpdated).toBe(false); // status NOT flipped to approved
    expect(issueUpdateSets).toHaveLength(0); // no task flip
    expect(mocks.dispatchCreatedCrewTasks).not.toHaveBeenCalled();
  });

  it("(c) finding A: a task already 'standard' is not re-flipped and not re-dispatched", async () => {
    mocks.preflightCrewDispatch.mockResolvedValue({ allowed: true });

    const taskRows = [
      { id: "t1", assigneeAgentId: "agent-1", workMode: "planning", status: "todo" },
      { id: "t2", assigneeAgentId: "agent-2", workMode: "standard", status: "in_progress" }, // already dispatched
    ];
    const { db, issueUpdateSets } = makeDb(
      approvedRow({ threadId: THREAD, taskIds: ["t1", "t2"] }),
      taskRows,
    );

    const svc = approvalService(db);
    await svc.approve("ap1", COMPANY, "user-A", "go");

    // only the planning task flipped
    expect(issueUpdateSets).toHaveLength(1);
    expect(issueUpdateSets[0].workMode).toBe("standard");

    // only the flipped task dispatched — no duplicate wakeup for t2
    expect(mocks.dispatchCreatedCrewTasks).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchCreatedCrewTasks).toHaveBeenCalledWith(db, COMPANY, [
      { id: "t1", assigneeAgentId: "agent-1", workMode: "standard" },
    ]);
  });

  it("(d) Codex #267 P2: a planning task the founder moved off 'todo' is NOT flipped or dispatched", async () => {
    mocks.preflightCrewDispatch.mockResolvedValue({ allowed: true });

    // t1 still parked (planning+todo) → dispatched. t2 still planning but moved to
    // cancelled → must be skipped (approving a stale approval must not resurrect it).
    const taskRows = [
      { id: "t1", assigneeAgentId: "agent-1", workMode: "planning", status: "todo" },
      { id: "t2", assigneeAgentId: "agent-2", workMode: "planning", status: "cancelled" },
    ];
    const { db, issueUpdateSets } = makeDb(
      approvedRow({ threadId: THREAD, taskIds: ["t1", "t2"] }),
      taskRows,
    );

    const svc = approvalService(db);
    await svc.approve("ap1", COMPANY, "user-A", "go");

    // only t1 flipped + dispatched; the cancelled t2 is left untouched
    expect(issueUpdateSets).toHaveLength(1);
    expect(mocks.dispatchCreatedCrewTasks).toHaveBeenCalledWith(db, COMPANY, [
      { id: "t1", assigneeAgentId: "agent-1", workMode: "standard" },
    ]);
    expect(mocks.logActivity).toHaveBeenCalledTimes(1);
  });

  it("(e) Codex #267 P2 TOCTOU: a task moved concurrently (guarded UPDATE matches 0 rows) is NOT dispatched", async () => {
    mocks.preflightCrewDispatch.mockResolvedValue({ allowed: true });

    // The task passes the in-memory pre-filter (planning+todo in the SELECT), but the
    // guarded UPDATE matches 0 rows (founder moved it between SELECT and UPDATE) →
    // the code must neither log nor dispatch it.
    const { db } = makeDb(
      approvedRow({ threadId: THREAD, taskIds: ["t1"] }),
      [{ id: "t1", assigneeAgentId: "agent-1", workMode: "planning", status: "todo" }],
      { issuesFlipReturnsEmpty: true },
    );

    const svc = approvalService(db);
    await svc.approve("ap1", COMPANY, "user-A", "go");

    // Nothing dispatched, nothing logged — the concurrent move won the race.
    expect(mocks.dispatchCreatedCrewTasks).toHaveBeenCalledWith(db, COMPANY, []);
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("(f) Codex #267 P2: a stale approval (no dispatchable tasks) skips preflight and closes as a no-op", async () => {
    // The preflight WOULD block — but it must not even run, because every payload task
    // was already handled (flipped to standard / moved off todo). Approving the stale
    // approval is a pure no-op close and must succeed even when paused/over budget.
    mocks.preflightCrewDispatch.mockResolvedValue({
      allowed: false,
      reason: "Crew budget reached",
      reasonCode: "budget_exhausted",
    });

    const taskRows = [
      { id: "t1", assigneeAgentId: "agent-1", workMode: "standard", status: "in_progress" },
      { id: "t2", assigneeAgentId: "agent-2", workMode: "planning", status: "cancelled" },
    ];
    const { db, issueUpdateSets, state } = makeDb(
      approvedRow({ threadId: THREAD, taskIds: ["t1", "t2"] }),
      taskRows,
    );

    const svc = approvalService(db);
    const result = await svc.approve("ap1", COMPANY, "user-A", "stale close");

    expect((result as { status?: string } | null)?.status).toBe("approved");
    expect(state.approvalsUpdated).toBe(true); // approval closed
    expect(mocks.preflightCrewDispatch).not.toHaveBeenCalled(); // gate skipped — no-op
    expect(issueUpdateSets).toHaveLength(0); // no task touched
    expect(mocks.dispatchCreatedCrewTasks).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
});

describe("approvalService.reject — crew_dispatch branch", () => {
  it("reject: does NOT flip workMode and does NOT dispatch (tasks stay parked as planning)", async () => {
    const rejectedRow = {
      id: "ap1",
      companyId: COMPANY,
      type: "crew_dispatch",
      status: "rejected",
      payload: { threadId: THREAD, taskIds: ["t1"] },
    };
    const { db, issueUpdateSets } = makeDb(rejectedRow, [
      { id: "t1", assigneeAgentId: "agent-1", workMode: "planning" },
    ]);

    const svc = approvalService(db);
    const result = await svc.reject("ap1", COMPANY, "user-A", "not now");

    expect(result).not.toBeNull();
    expect((result as { status?: string }).status).toBe("rejected");
    // No task mutation and no dispatch — reject only closes the approval; the parked
    // planning tasks are left for the founder to flip/delete later.
    expect(issueUpdateSets).toHaveLength(0);
    expect(mocks.dispatchCreatedCrewTasks).not.toHaveBeenCalled();
    expect(mocks.preflightCrewDispatch).not.toHaveBeenCalled();
  });
});

describe("approvalService.resubmit — crew_dispatch is not resubmittable (Codex #267 P1)", () => {
  it("throws for a crew_dispatch approval and never writes a new payload", async () => {
    // getExistingApproval returns a revision_requested crew_dispatch; the guard throws
    // before any UPDATE, so a caller cannot re-open the caller-controlled-taskIds vector.
    const existing = {
      id: "ap1",
      companyId: COMPANY,
      status: "revision_requested",
      type: "crew_dispatch",
      payload: { taskIds: ["t1"] },
    };
    let approvalsUpdated = false;
    const db = {
      select: () => {
        const chain: Record<string, unknown> = {};
        chain.from = () => chain;
        chain.where = () => chain;
        chain.limit = () => Promise.resolve([existing]);
        chain.then = (resolve: (rows: unknown[]) => unknown) => resolve([existing]);
        return chain;
      },
      update: () => ({
        set: () => ({
          where: () => {
            approvalsUpdated = true;
            return { returning: () => ({ then: (r: (rows: unknown[]) => unknown) => r([existing]) }) };
          },
        }),
      }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      delete: () => ({ where: () => Promise.resolve() }),
    } as any;

    const svc = approvalService(db);
    await expect(
      svc.resubmit("ap1", COMPANY, { taskIds: ["out-of-scope-1"] }),
    ).rejects.toThrow(/cannot be resubmitted/i);
    expect(approvalsUpdated).toBe(false);
  });
});
