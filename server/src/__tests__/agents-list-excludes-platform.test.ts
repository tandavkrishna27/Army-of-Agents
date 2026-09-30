// Contract test (repo-standard createSequenceDb / proxy-table harness, per
// budget-hooks.test.ts). Windows-runnable — verifies agentService.list()
// constructs a `kind = 'org'` predicate so platform agents are excluded.
// The authoritative behavioural proof is the Linux-CI integration test
// (agents-list-excludes-platform.integration.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above top-level consts, so mock fns we also assert on
// must be created via vi.hoisted (vitest-sanctioned pattern).
const { eqMock, andMock, neMock } = vi.hoisted(() => ({
  eqMock: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  andMock: vi.fn((...args: unknown[]) => ({ and: args })),
  neMock: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
}));

vi.mock("drizzle-orm", () => ({
  and: andMock,
  eq: eqMock,
  ne: neMock,
  desc: vi.fn((c: unknown) => ({ desc: c })),
  inArray: vi.fn((c: unknown, v: unknown) => ({ inArray: [c, v] })),
  isNull: vi.fn((c: unknown) => ({ isNull: c })),
  isNotNull: vi.fn((c: unknown) => ({ isNotNull: c })),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") return Symbol(`${name}.${prop}`);
        return undefined;
      },
    });
  // Explicit named exports (vitest validates named imports exist on the mock).
  // Exactly the tables agents.ts imports (verified import block, lines 4-17).
  return {
    agents: makeTable("agents"),
    agentConfigRevisions: makeTable("agent_config_revisions"),
    agentApiKeys: makeTable("agent_api_keys"),
    agentRuntimeState: makeTable("agent_runtime_state"),
    agentTaskSessions: makeTable("agent_task_sessions"),
    agentWakeupRequests: makeTable("agent_wakeup_requests"),
    heartbeatRunEvents: makeTable("heartbeat_run_events"),
    heartbeatRuns: makeTable("heartbeat_runs"),
    authUsers: makeTable("auth_users"),
    companyMemberships: makeTable("company_memberships"),
    userRoles: makeTable("user_roles"),
    projects: makeTable("projects"),
  };
});

vi.mock("@armyofagents/shared", () => ({
  isUuidLike: vi.fn(() => true),
  normalizeAgentUrlKey: vi.fn((n: string) => n),
}));

vi.mock("../services/agent-permissions.js", () => ({
  normalizeAgentPermissions: vi.fn((p: unknown) => p ?? {}),
}));
vi.mock("../services/agent-shortnames.js", () => ({
  deduplicateAgentName: vi.fn((n: string) => n),
  hasAgentShortnameCollision: vi.fn(() => false),
}));
vi.mock("../redaction.js", () => ({
  REDACTED_EVENT_VALUE: "***",
  sanitizeRecord: vi.fn((r: unknown) => r),
}));
vi.mock("../services/org-hierarchy.js", () => ({
  orgHierarchyService: vi.fn(() => ({})),
}));
vi.mock("../errors.js", () => ({
  conflict: (m: string) => new Error(m),
  notFound: (m: string) => new Error(m),
  unprocessable: (m: string) => new Error(m),
}));

import { agentService } from "../services/agents.js";

function makeChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) {
    chain[m] = (..._a: unknown[]) => chain;
  }
  chain.then = (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

describe("agentService.list() excludes platform agents (contract)", () => {
  beforeEach(() => {
    eqMock.mockClear();
    andMock.mockClear();
    neMock.mockClear();
  });

  it("constructs a kind='org' predicate (so platform rows are filtered in SQL)", async () => {
    const db: any = {
      select: () => makeChain([{ id: "o1", name: "Org", role: "general", permissions: {}, kind: "org" }]),
    };
    const svc = agentService(db);
    const rows = await svc.list("11111111-1111-4111-8111-111111111111");

    // The kind filter must have been built: an eq() call with literal "org".
    const builtKindFilter = eqMock.mock.calls.some((c) => c[1] === "org");
    expect(builtKindFilter).toBe(true);

    // Sanity: returned rows are normalized and carry kind through.
    expect(rows[0].kind).toBe("org");
  });
});
