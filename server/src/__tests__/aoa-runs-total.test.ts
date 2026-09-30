// Unit/contract test for GET /companies/:companyId/agents/:id/aoa-runs.
// Follow-up #4: the endpoint must return { runs, total, limit } with `total`
// = count(*) over (companyId, agentId), so the true run total survives the
// page cap (default 50). Mirrors the count+page precedent at
// internal-agent.ts:861-895 and the mock-router harness in aoa-agents-api.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((c: unknown) => ({ desc: c })),
  // The route computes the total with sql<number>`count(*)::int` (mirroring
  // internal-agent.ts:864). The mock DB's select() ignores the field map and
  // returns the pre-queued rows, so this stub just needs to not throw — match
  // the existing agentRoutes tests' Proxy sql stub. NOTE: no `count` export —
  // the route intentionally uses `sql`, not drizzle's `count` helper, because
  // the sibling agentRoutes mocks (agents-keys-routes.test.ts /
  // aoa-budget-autopause.test.ts) export `sql` but not `count`.
  sql: new Proxy(() => ({ sql: true }), {
    get: () => () => ({ sql: true }),
    apply: () => ({ sql: true }),
  }),
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
  return {
    agents: makeTable("agents"),
    companies: makeTable("companies"),
    aoaAgentTriggers: makeTable("aoa_agent_triggers"),
    internalAgentRuns: makeTable("internal_agent_runs"),
  };
});

// The agents route module pulls in a large service graph at import time. Stub the
// service barrel and the adapter/login imports so building the router needs no DB.
vi.mock("../services/index.js", () => ({
  agentService: vi.fn(() => ({})),
  agentInstructionsService: vi.fn(() => ({})),
  accessService: vi.fn(() => ({})),
  approvalService: vi.fn(() => ({})),
  companySkillService: vi.fn(() => ({})),
  heartbeatService: vi.fn(() => ({})),
  issueApprovalService: vi.fn(() => ({})),
  issueService: vi.fn(() => ({})),
  logActivity: vi.fn(),
  secretService: vi.fn(() => ({})),
}));
vi.mock("../adapters/index.js", () => ({
  findActiveServerAdapter: vi.fn(),
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));
vi.mock("@armyofagents/adapter-claude-local/server", () => ({ runClaudeLogin: vi.fn() }));
vi.mock("@armyofagents/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(),
}));

// authz guard is a no-op for this test (company access is asserted elsewhere).
vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn(() => ({ actorType: "user", actorId: "user-1" })),
}));

import { agentRoutes } from "../routes/agents.js";

type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (...args: unknown[]) => unknown }>;
  };
};

// Sequence-based mock DB: each db.select() returns the NEXT pre-queued result.
function createSequenceDb(results: unknown[][]) {
  let call = 0;
  const makeChain = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit", "offset"]) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
    return chain;
  };
  return {
    select: () => makeChain(results[Math.min(call++, results.length - 1)]),
  } as any;
}

function getAoaRunsHandler(db: any) {
  const router = agentRoutes(db) as unknown as { stack: RouteLayer[] };
  const layer = router.stack.find(
    (l) => l.route?.path === "/companies/:companyId/agents/:id/aoa-runs" && l.route?.methods?.get,
  );
  if (!layer?.route) throw new Error("aoa-runs GET route not found");
  // The last handler in the layer stack is the route's async handler.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe("GET /aoa-runs returns { runs, total, limit }", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns total from count(*) even when the page is capped below the total", async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}` }));
    // Call 1 = count query → [{ total: 137 }]; Call 2 = paginated page (50 rows).
    const db = createSequenceDb([[{ total: 137 }], page]);
    const handler = getAoaRunsHandler(db);

    let body: any;
    const req: any = {
      params: { companyId: "c1", id: "a1" },
      query: {},
    };
    const res: any = { json: (v: unknown) => { body = v; } };

    await handler(req, res, () => {});

    expect(body).toBeDefined();
    expect(body.total).toBe(137);
    expect(body.limit).toBe(50);
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs).toHaveLength(50);
    // The whole point of the change: total is NOT clamped to the page length.
    expect(body.total).toBeGreaterThan(body.runs.length);
  });

  it("respects the limit query param (clamped to 200)", async () => {
    const db = createSequenceDb([[{ total: 5 }], [{ id: "r0" }, { id: "r1" }]]);
    const handler = getAoaRunsHandler(db);
    let body: any;
    const req: any = { params: { companyId: "c1", id: "a1" }, query: { limit: "999" } };
    const res: any = { json: (v: unknown) => { body = v; } };
    await handler(req, res, () => {});
    expect(body.total).toBe(5);
    expect(body.limit).toBe(200);
  });

  it("returns { runs: [], total: 0 } when the agent has never run (empty)", async () => {
    // Count query → [{ total: 0 }]; page query → [] (no rows).
    const db = createSequenceDb([[{ total: 0 }], []]);
    const handler = getAoaRunsHandler(db);
    let body: any;
    const req: any = { params: { companyId: "c1", id: "a1" }, query: {} };
    const res: any = { json: (v: unknown) => { body = v; } };
    await handler(req, res, () => {});
    expect(body.total).toBe(0);
    expect(body.limit).toBe(50);
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs).toHaveLength(0);
  });

  it("returns total == runs.length when the total is within the page limit", async () => {
    // total (3) <= default limit (50): the full set fits on one page, so
    // total equals the page length — the count and the list agree.
    const page = [{ id: "r0" }, { id: "r1" }, { id: "r2" }];
    const db = createSequenceDb([[{ total: 3 }], page]);
    const handler = getAoaRunsHandler(db);
    let body: any;
    const req: any = { params: { companyId: "c1", id: "a1" }, query: {} };
    const res: any = { json: (v: unknown) => { body = v; } };
    await handler(req, res, () => {});
    expect(body.total).toBe(3);
    expect(body.runs).toHaveLength(3);
    expect(body.total).toBe(body.runs.length);
  });

  it("defaults total to 0 when the count query returns no row (defensive)", async () => {
    // The handler destructures `[{ total } = { total: 0 }]` — if the count
    // select somehow yields an empty array, total falls back to 0 (never NaN/undefined).
    const db = createSequenceDb([[], []]);
    const handler = getAoaRunsHandler(db);
    let body: any;
    const req: any = { params: { companyId: "c1", id: "a1" }, query: {} };
    const res: any = { json: (v: unknown) => { body = v; } };
    await handler(req, res, () => {});
    expect(body.total).toBe(0);
    expect(body.runs).toHaveLength(0);
  });
});
