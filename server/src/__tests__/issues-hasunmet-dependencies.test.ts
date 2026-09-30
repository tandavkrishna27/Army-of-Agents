// server/src/__tests__/issues-hasunmet-dependencies.test.ts
//
// A-H9: hasUnmetDependencies must treat BOTH `done` and `cancelled` upstream
// dependencies as satisfied (terminal). A task whose only remaining upstream
// dependency is `cancelled` is NOT blocked and must be checkout-able; a task
// whose upstream is still `in_progress` IS blocked.
//
// hasUnmetDependencies is a private closure on issueService, reachable through
// the public `checkout` API (it throws conflict("Task has unmet dependencies")
// when the predicate is true). We drive checkout and assert on that gate.

import { describe, expect, it, vi } from "vitest";

// ── Heavy mocks for the drizzle ESM cycle (mirror issue-status-event) ──

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

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
  publishIssueStatusChanged: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/issue-agent-status-guard.js", () => ({
  assertAgentStatusTransition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn(() => ({
    reconcile: vi.fn().mockResolvedValue({ healed: 0, closed: 0, refreshed: 0 }),
  })),
}));

import { issueService } from "../services/issues.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ISSUE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

// checkout() select sequence:
//   #1 {companyId} for the issue
//   #2 assertAssignableAgent → agents lookup (active agent)
//   #3 hasUnmetDependencies → taskDependencies⋈issues (upstream statuses)
//   later: labels ([])
// We feed the upstream statuses via select #3 and let the atomic claim land.
function makeCheckoutDb(upstreamStatuses: { status: string }[]) {
  const claimedRow = {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "in_progress",
    assigneeAgentId: AGENT_ID,
  };
  let selectCall = 0;
  const db: any = {
    select: () => {
      const c: any = {};
      c.from = () => c; c.where = () => c; c.innerJoin = () => c; c.leftJoin = () => c;
      c.orderBy = () => c; c.limit = () => c;
      c.then = (r: (v: unknown[]) => unknown) => {
        selectCall += 1;
        if (selectCall === 1) return Promise.resolve([{ companyId: COMPANY_ID }]).then(r);
        if (selectCall === 2) return Promise.resolve([{ id: AGENT_ID, companyId: COMPANY_ID, status: "idle" }]).then(r);
        if (selectCall === 3) return Promise.resolve(upstreamStatuses).then(r);
        return Promise.resolve([]).then(r); // labels, etc.
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
  db.transaction = async (callback: (tx: any) => unknown) => callback(db);
  return db;
}

describe("A-H9 — hasUnmetDependencies treats cancelled (and done) as satisfied", () => {
  it("checkout proceeds when the only upstream dependency is cancelled", async () => {
    const db = makeCheckoutDb([{ status: "cancelled" }]);
    const svc = issueService(db);

    // Must NOT throw "Task has unmet dependencies" — cancelled is terminal.
    const result = await svc.checkout(ISSUE_ID, AGENT_ID, ["todo", "backlog"], null);
    expect(result).toMatchObject({ id: ISSUE_ID, status: "in_progress" });
  });

  it("checkout proceeds when the only upstream dependency is done", async () => {
    const db = makeCheckoutDb([{ status: "done" }]);
    const svc = issueService(db);

    const result = await svc.checkout(ISSUE_ID, AGENT_ID, ["todo", "backlog"], null);
    expect(result).toMatchObject({ id: ISSUE_ID, status: "in_progress" });
  });

  it("checkout is rejected when an upstream dependency is still in_progress", async () => {
    const db = makeCheckoutDb([{ status: "cancelled" }, { status: "in_progress" }]);
    const svc = issueService(db);

    await expect(
      svc.checkout(ISSUE_ID, AGENT_ID, ["todo", "backlog"], null),
    ).rejects.toThrow(/unmet dependencies/i);
  });
});
