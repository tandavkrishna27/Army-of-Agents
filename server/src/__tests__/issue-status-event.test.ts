// server/src/__tests__/issue-status-event.test.ts
//
// Thread chat experience Phase 5 — Task 5.6 (server side).
//
// The kanban / Crew Board must move a card LIVE when a task's status changes.
// To do that, every crew status-MOVE chokepoint publishes an
// `issue.status_changed` LiveEvent (company-broadcast — see R3). The crew bypass
// issueService.update at two raw-write sites (checkout's →in_progress and the
// runner's silent-stuck →todo release), so the publish is centralized in the
// `publishIssueStatusChanged(companyId, issueId, status)` helper and called at
// each site.
//
// This suite asserts the TWO chokepoints that live in issues.ts:
//   1. issueService.update — publishes ONLY when `status` actually changes
//      (a non-status update, or a same-status no-op, does NOT publish).
//   2. issueService.checkout — publishes `→in_progress` when the atomic claim
//      lands (a crew/heartbeat checkout move the board must reflect).
//
// `publishIssueStatusChanged` is module-mocked here (it crosses the issues.ts →
// live-events.js boundary, so the spy is observable — unlike publishLiveEvent
// called *within* live-events, see typing-bridge.test.ts's note). The runner's
// silent-stuck site is covered in aoa-runner-task-execution.test.ts.

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Heavy mocks for the drizzle ESM cycle (mirror issues-source-discussion-persist) ──

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => ({ and: args })),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
  isNotNull: vi.fn((col: any) => ({ isNotNull: col })),
  isNull: vi.fn((col: any) => ({ isNull: col })),
  or: vi.fn((...args: any[]) => ({ or: args })),
  desc: vi.fn((col: any) => ({ desc: col })),
  asc: vi.fn((col: any) => ({ asc: col })),
  sql: Object.assign(
    vi.fn((_s: any) => {
      const tag: any = { as: vi.fn().mockReturnThis(), mapWith: vi.fn().mockReturnThis() };
      return tag;
    }),
    { raw: vi.fn((s: any) => s), placeholder: vi.fn((s: any) => s) },
  ),
}));

function tableProxy(name: string) {
  return new Proxy(
    {},
    { get(_t, prop) { return `${name}_${String(prop)}`; } },
  );
}

vi.mock("@armyofagents/db", () => ({
  issues: tableProxy("issues"),
  companies: tableProxy("companies"),
  discussions: tableProxy("discussions"),
  agents: tableProxy("agents"),
  agentWakeupRequests: tableProxy("awr"),
  companyMemberships: tableProxy("cm"),
  activityLog: tableProxy("al"),
  assets: tableProxy("assets"),
  authUsers: tableProxy("au"),
  executionWorkspaces: tableProxy("ew"),
  goals: tableProxy("goals"),
  heartbeatRuns: tableProxy("hr"),
  issueAttachments: tableProxy("ia"),
  issueLabels: tableProxy("il"),
  issueComments: tableProxy("ic"),
  issueMonitors: tableProxy("im"),
  issueReadStates: tableProxy("irs"),
  labels: tableProxy("labels"),
  projectWorkspaces: tableProxy("pw"),
  projects: tableProxy("projects"),
  taskDependencies: tableProxy("td"),
  userRoles: tableProxy("ur"),
  workQuestions: tableProxy("wq"),
  workQuestionContinuationRequests: tableProxy("wqcr"),
  memoryItems: tableProxy("mi"),
  discussionExtractedItems: tableProxy("dei"),
  artifacts: tableProxy("art"),
  artifactVersions: tableProxy("av"),
  instanceSettings: tableProxy("is"),
  instanceExperimentalSettings: tableProxy("ies"),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: false }),
  })),
}));

vi.mock("../services/issue-reviewer.js", () => ({
  resolveIssueReviewer: vi.fn().mockResolvedValue({
    reviewerUserId: "reviewer-user",
    reviewerSource: "founder",
  }),
}));

// The chokepoint under test. Spy on publishIssueStatusChanged (crosses the
// issues.ts → live-events.js boundary → observable). Keep publishLiveEvent as a
// no-op so any other publishing code in issues.ts stays inert.
const { publishIssueStatusChangedMock, hubReconcileMock, hubServiceExecutors, assertAgentStatusTransitionMock } = vi.hoisted(() => ({
  publishIssueStatusChangedMock: vi.fn(),
  hubReconcileMock: vi.fn().mockResolvedValue(undefined),
  hubServiceExecutors: [] as unknown[],
  assertAgentStatusTransitionMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
  publishIssueStatusChanged: publishIssueStatusChangedMock,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn((executor: unknown) => {
    hubServiceExecutors.push(executor);
    return {
      reconcile: hubReconcileMock,
    };
  }),
}));

// The A4 agent status-transition guard reads the db; for these (non-agent /
// system-actor) updates it's a no-op, but stub it so it never hits a real db.
vi.mock("../services/issue-agent-status-guard.js", () => ({
  assertAgentStatusTransition: assertAgentStatusTransitionMock,
}));

import { issueService } from "../services/issues.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ISSUE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// ── update() db harness ───────────────────────────────────────────────────────
//
// update() does: select existing issue → (guards) → db.transaction(tx => update
// .set(patch).where().returning() → withIssueLabels read). We model:
//  - the initial existing-issue select (returns `existing`)
//  - a transaction that runs the callback against a tx whose update().returning()
//    yields the patched row, and whose label select returns []
function makeUpdateDb(existing: Record<string, unknown>, patchedStatus: string) {
  const updatedRow = { ...existing, status: patchedStatus };
  let txSelectCall = 0;
  const labelChain = () => {
    const c: any = {};
    c.from = () => c; c.where = () => c; c.innerJoin = () => c; c.leftJoin = () => c;
    c.orderBy = () => c;
    c.then = (r: (v: unknown[]) => unknown) => Promise.resolve([]).then(r);
    return c;
  };
  const tx: any = {
    update: () => {
      const u: any = {};
      u.set = () => u;
      u.where = () => u;
      u.returning = () => Promise.resolve([updatedRow]);
      return u;
    },
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    select: () => {
      const rows = txSelectCall++ === 0 ? [existing] : [];
      const chain = labelChain();
      chain.for = () => chain;
      chain.then = (r: (v: unknown[]) => unknown) => Promise.resolve(rows).then(r);
      return chain;
    },
    delete: () => ({ where: () => Promise.resolve(undefined) }),
  };
  const db: any = {
    select: () => {
      const c: any = {};
      c.from = () => c; c.where = () => c; c.innerJoin = () => c; c.leftJoin = () => c;
      c.orderBy = () => c; c.limit = () => c; c.for = () => c;
      c.then = (r: (v: unknown[]) => unknown) => Promise.resolve([existing]).then(r);
      return c;
    },
    transaction: async (cb: (t: unknown) => unknown) => cb(tx),
  };
  return db;
}

// ── checkout() db harness ─────────────────────────────────────────────────────
//
// checkout() does: select {companyId} → assertAssignableAgent (reads agents) →
// hasUnmetDependencies (reads taskDependencies) → atomic update().returning()
// (the →in_progress claim) → withIssueLabels read. We make the claim land
// (returning a row) so the publish fires.
function makeCheckoutDb() {
  const claimedRow = { id: ISSUE_ID, companyId: COMPANY_ID, status: "in_progress", assigneeAgentId: "agent-1" };
  let selectCall = 0;
  const db: any = {
    select: () => {
      const c: any = {};
      c.from = () => c; c.where = () => c; c.innerJoin = () => c; c.leftJoin = () => c;
      c.orderBy = () => c; c.limit = () => c;
      c.then = (r: (v: unknown[]) => unknown) => {
        selectCall += 1;
        // 1st select: {companyId} for the issue. 2nd: assignable-agent lookup
        // (an active, approved agent). 3rd: unmet-dependencies (none). Later
        // selects: labels ([]).
        if (selectCall === 1) return Promise.resolve([{ companyId: COMPANY_ID }]).then(r);
        if (selectCall === 2) return Promise.resolve([{ id: "agent-1", companyId: COMPANY_ID, status: "idle" }]).then(r);
        if (selectCall === 3) return Promise.resolve([]).then(r); // no unmet deps
        return Promise.resolve([]).then(r);
      };
      return c;
    },
    update: () => {
      const u: any = {};
      u.set = () => u;
      u.where = () => u;
      u.returning = () => Promise.resolve([claimedRow]);
      return u;
    },
  };
  db.transaction = async (cb: (tx: unknown) => unknown) => cb(db);
  return db;
}

describe("issue.status_changed publish (Task 5.6) — issues.ts chokepoints", () => {
  beforeEach(() => {
    publishIssueStatusChangedMock.mockClear();
    assertAgentStatusTransitionMock.mockReset();
    assertAgentStatusTransitionMock.mockResolvedValue(undefined);
  });

  it("update() that CHANGES status publishes issue.status_changed { companyId, issueId, status }", async () => {
    const existing = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "in_progress",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    };
    const db = makeUpdateDb(existing, "in_review");

    await issueService(db).update(
      ISSUE_ID,
      { status: "in_review" },
      { actorType: "agent", agentId: "agent-1", effectiveDial: 2 },
    );

    expect(publishIssueStatusChangedMock).toHaveBeenCalledTimes(1);
    expect(publishIssueStatusChangedMock).toHaveBeenCalledWith(COMPANY_ID, ISSUE_ID, "in_review");
  });

  it("update() with NO status change (a non-status field) does NOT publish", async () => {
    const existing = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
    };
    const db = makeUpdateDb(existing, "todo");

    await issueService(db).update(ISSUE_ID, { title: "renamed only" });

    expect(publishIssueStatusChangedMock).not.toHaveBeenCalled();
  });

  it("update() rejects agent completion-policy fields at the service boundary", async () => {
    const existing = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "todo",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      agentCompletionPolicyOverride: null,
    };
    const db = makeUpdateDb(existing, "todo");

    await expect(issueService(db).update(
      ISSUE_ID,
      { agentCompletionPolicyOverride: null },
      { actorType: "agent", agentId: "agent-1", effectiveDial: 2 },
    )).rejects.toMatchObject({ status: 403 });
  });

  it("validates agent transitions against the row locked inside the transaction", async () => {
    const lockedExisting = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "in_progress",
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      agentCompletionPolicy: "agent_can_complete",
      acceptanceCriteria: ["Verified"],
    };
    const db = makeUpdateDb(lockedExisting, "done");
    assertAgentStatusTransitionMock.mockImplementationOnce(async (input: any) => {
      if (input.existing.assigneeAgentId !== input.actor.agentId) {
        throw Object.assign(new Error("stale ownership"), { status: 422 });
      }
    });

    await expect(issueService(db).update(
      ISSUE_ID,
      { status: "done" },
      { actorType: "agent", agentId: "agent-1", effectiveDial: 2 },
    )).rejects.toMatchObject({ status: 422 });
    expect(assertAgentStatusTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        existing: expect.objectContaining({ assigneeAgentId: "agent-2" }),
      }),
      expect.anything(),
    );
  });

  it("rejects an update when the row changed after route authorization", async () => {
    const authorizedAt = new Date("2026-07-14T00:00:00.000Z");
    const lockedExisting = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "todo",
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      updatedAt: new Date("2026-07-14T00:00:01.000Z"),
    };
    const db = makeUpdateDb(lockedExisting, "todo");

    await expect(issueService(db).update(
      ISSUE_ID,
      { assigneeAgentId: "agent-1" },
      { actorType: "board", expectedUpdatedAt: authorizedAt },
    )).rejects.toMatchObject({ status: 409 });
  });

  it("checkout() publishes issue.status_changed on the →in_progress claim", async () => {
    const db = makeCheckoutDb();

    await issueService(db).checkout(ISSUE_ID, "agent-1", ["todo", "backlog", "in_progress"], "run-1");

    expect(publishIssueStatusChangedMock).toHaveBeenCalledTimes(1);
    expect(publishIssueStatusChangedMock).toHaveBeenCalledWith(COMPANY_ID, ISSUE_ID, "in_progress");
  });
});

function makeReleaseDb() {
  const existing = {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "in_progress",
    assigneeAgentId: "agent-1",
    checkoutRunId: "run-1",
  };
  const updatedRow = {
    ...existing,
    status: "todo",
    assigneeAgentId: null,
    checkoutRunId: null,
  };
  let outerSelectCall = 0;
  const db: any = {
    select: () => {
      const c: any = {};
      c.from = () => c; c.where = () => c; c.innerJoin = () => c; c.leftJoin = () => c;
      c.orderBy = () => c; c.limit = () => c;
      c.then = (r: (v: unknown[]) => unknown) => {
        outerSelectCall += 1;
        return Promise.resolve(outerSelectCall === 1 ? [existing] : []).then(r);
      };
      return c;
    },
  };
  const tx: any = {
    update: () => {
      const u: any = {};
      u.set = () => u;
      u.where = () => u;
      u.returning = () => Promise.resolve([updatedRow]);
      return u;
    },
  };
  db.transaction = async (cb: (t: unknown) => unknown) => cb(tx);
  return { db, tx };
}

function makeRemoveDb() {
  const removedIssue = { id: ISSUE_ID, companyId: COMPANY_ID, status: "todo" };
  let selectCall = 0;
  let deleteCall = 0;
  const tx: any = {
    select: () => {
      const c: any = {};
      c.from = () => c; c.where = () => c; c.innerJoin = () => c; c.leftJoin = () => c;
      c.orderBy = () => c; c.limit = () => c; c.for = () => c;
      c.then = (r: (v: unknown[]) => unknown) => {
        selectCall += 1;
        if (selectCall === 1) return Promise.resolve([{ companyId: COMPANY_ID }]).then(r);
        return Promise.resolve([]).then(r);
      };
      return c;
    },
    delete: () => {
      deleteCall += 1;
      const d: any = {};
      d.where = () => d;
      d.returning = () => Promise.resolve(deleteCall === 2 ? [removedIssue] : []);
      d.then = (r: (v: unknown[]) => unknown) => Promise.resolve([]).then(r);
      return d;
    },
    update: () => {
      const u: any = {};
      u.set = () => u;
      u.where = () => u;
      u.returning = () => Promise.resolve([]);
      u.then = (r: (v: unknown[]) => unknown) => Promise.resolve([]).then(r);
      return u;
    },
    insert: () => ({ values: () => Promise.resolve(undefined) }),
  };
  const db: any = {
    transaction: async (cb: (t: unknown) => unknown) => cb(tx),
  };
  return { db, tx };
}

describe("issue stale-work hub reconciliation chokepoints", () => {
  beforeEach(() => {
    hubReconcileMock.mockClear();
    hubServiceExecutors.length = 0;
  });

  it("release() reconciles stale-work hub state inside the release transaction", async () => {
    const { db, tx } = makeReleaseDb();

    await issueService(db).release(ISSUE_ID, "agent-1", "run-1");

    expect(hubServiceExecutors).toContain(tx);
    expect(hubReconcileMock).toHaveBeenCalledWith(COMPANY_ID, {
      sourceType: "issue",
      sourceId: ISSUE_ID,
    });
  });

  it("remove() reconciles stale-work hub state inside the delete transaction", async () => {
    const { db, tx } = makeRemoveDb();

    await issueService(db).remove(ISSUE_ID);

    expect(hubServiceExecutors).toContain(tx);
    expect(hubReconcileMock).toHaveBeenCalledWith(COMPANY_ID, {
      sourceType: "issue",
      sourceId: ISSUE_ID,
    });
  });
});
