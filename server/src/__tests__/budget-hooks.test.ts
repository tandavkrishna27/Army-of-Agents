import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB / drizzle stubs ────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  not: vi.fn((v: unknown) => ({ not: v })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
  gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
  lt: vi.fn((a: unknown, b: unknown) => ({ lt: [a, b] })),
  lte: vi.fn((a: unknown, b: unknown) => ({ lte: [a, b] })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
  isNotNull: vi.fn((col: unknown) => ({ isNotNull: col })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
  sql: new Proxy(() => ({ sql: true }), {
    get: () => () => ({ sql: true }),
    apply: () => ({ sql: true }),
  }),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    costEvents: makeTable("cost_events"),
    agents: makeTable("agents"),
    companies: makeTable("companies"),
    budgetPolicies: makeTable("budget_policies"),
    budgetIncidents: makeTable("budget_incidents"),
    approvals: makeTable("approvals"),
  };
});

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  BudgetEnforcementScope,
  clearBudgetHooks,
  emitBudgetExhausted,
  onBudgetExhausted,
} from "../services/budget-hooks.js";
import { budgetService } from "../services/budgets.js";

// ── Mock DB helpers ──────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  updates?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;

  function makeChain(getResult: () => MockRow[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = [
      "from", "where", "orderBy", "limit", "leftJoin", "innerJoin",
      "values", "set", "returning", "groupBy",
    ];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  return {
    select: (_fields?: unknown) =>
      makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (_table: unknown) =>
      makeChain(() => config.inserts?.[insertIdx++] ?? []),
    update: (_table: unknown) =>
      makeChain(() => config.updates?.[updateIdx++] ?? []),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherAgentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function agentHardStopPolicy(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "pol-1",
    companyId,
    scopeType: "agent",
    scopeId: agentId,
    metric: "cost_cents",
    windowKind: "calendar_month_utc",
    amountCents: 1000,
    warnPercent: 80,
    hardStopEnabled: true,
    notifyEnabled: true,
    isActive: true,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("budget-hooks — emitter primitives", () => {
  beforeEach(() => {
    clearBudgetHooks();
  });

  it("onBudgetExhausted subscribers receive the emitted scope", async () => {
    const received: BudgetEnforcementScope[] = [];
    onBudgetExhausted((scope) => {
      received.push(scope);
    });

    emitBudgetExhausted({ companyId, scopeType: "agent", scopeId: agentId });
    // Allow async emit microtask to settle
    await Promise.resolve();
    expect(received).toEqual([
      { companyId, scopeType: "agent", scopeId: agentId },
    ]);
  });

  it("returned unsubscribe removes the listener", async () => {
    const received: BudgetEnforcementScope[] = [];
    const unsubscribe = onBudgetExhausted((scope) => {
      received.push(scope);
    });

    unsubscribe();
    emitBudgetExhausted({ companyId, scopeType: "agent", scopeId: agentId });
    await Promise.resolve();
    expect(received).toHaveLength(0);
  });

  it("clearBudgetHooks removes all listeners", async () => {
    const received: BudgetEnforcementScope[] = [];
    onBudgetExhausted((scope) => { received.push(scope); });
    onBudgetExhausted((scope) => { received.push(scope); });

    clearBudgetHooks();
    emitBudgetExhausted({ companyId, scopeType: "company", scopeId: companyId });
    await Promise.resolve();
    expect(received).toHaveLength(0);
  });

  it("supports multiple independent subscribers", async () => {
    const a: BudgetEnforcementScope[] = [];
    const b: BudgetEnforcementScope[] = [];
    onBudgetExhausted((scope) => { a.push(scope); });
    onBudgetExhausted((scope) => { b.push(scope); });

    emitBudgetExhausted({ companyId, scopeType: "agent", scopeId: agentId });
    await Promise.resolve();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("swallows listener errors so one bad listener doesn't break others", async () => {
    const received: BudgetEnforcementScope[] = [];
    onBudgetExhausted(() => {
      throw new Error("boom");
    });
    onBudgetExhausted((scope) => {
      received.push(scope);
    });

    emitBudgetExhausted({ companyId, scopeType: "agent", scopeId: agentId });
    await Promise.resolve();
    expect(received).toHaveLength(1);
  });
});

describe("budgets.evaluateCostEvent — hard-stop emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBudgetHooks();
  });

  it("emits budget-exhausted signal when hard-stop threshold is first crossed", async () => {
    const policy = agentHardStopPolicy();
    const db = createSequenceDb({
      // first select: list policies
      // second select: sum observed cents
      // third select: dedup check for existing incident (returns none)
      selects: [
        [policy],
        [{ total: 1500 }], // over amountCents=1000
        [], // no existing incident
      ],
      // insert incident, then insert approval (agent-scope hard_stop)
      inserts: [
        [{ id: "inc-1", policyId: policy.id }],
        [{ id: "apr-1" }],
      ],
      // update: set approvalId on incident, update agent status -> paused
      updates: [[], []],
    });

    const received: BudgetEnforcementScope[] = [];
    onBudgetExhausted((scope) => { received.push(scope); });

    const svc = budgetService(db as any);
    await svc.evaluateCostEvent(agentId, companyId);

    // Allow setImmediate / microtasks
    await new Promise((r) => setImmediate(r));

    expect(received).toEqual([
      { companyId, scopeType: "agent", scopeId: agentId },
    ]);
  });

  it("does NOT emit when observed is below hard-stop threshold", async () => {
    const policy = agentHardStopPolicy();
    const db = createSequenceDb({
      selects: [
        [policy],
        [{ total: 500 }], // under amountCents=1000, under warn (80%=800)
      ],
      inserts: [],
      updates: [],
    });

    const received: BudgetEnforcementScope[] = [];
    onBudgetExhausted((scope) => { received.push(scope); });

    const svc = budgetService(db as any);
    await svc.evaluateCostEvent(agentId, companyId);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
  });

  it("does NOT emit for warning-level crossings (soft threshold)", async () => {
    const policy = agentHardStopPolicy();
    const db = createSequenceDb({
      selects: [
        [policy],
        [{ total: 850 }], // over 80% warn, under 100% hard
        [], // dedup
      ],
      inserts: [[{ id: "inc-soft", policyId: policy.id }]],
      updates: [[]],
    });

    const received: BudgetEnforcementScope[] = [];
    onBudgetExhausted((scope) => { received.push(scope); });

    const svc = budgetService(db as any);
    await svc.evaluateCostEvent(agentId, companyId);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
  });

  it("is idempotent — does not emit again if incident already exists (dedup)", async () => {
    const policy = agentHardStopPolicy();
    const db = createSequenceDb({
      selects: [
        [policy],
        [{ total: 1500 }],
        [{ id: "existing-incident" }], // dedup hit
      ],
      inserts: [],
      updates: [],
    });

    const received: BudgetEnforcementScope[] = [];
    onBudgetExhausted((scope) => { received.push(scope); });

    const svc = budgetService(db as any);
    await svc.evaluateCostEvent(agentId, companyId);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
  });

  it("emits company-scope signal when company-scoped policy is breached", async () => {
    const policy = agentHardStopPolicy({
      scopeType: "company",
      scopeId: companyId,
    });
    const db = createSequenceDb({
      selects: [
        [policy],
        [{ total: 1500 }],
        [], // dedup
      ],
      inserts: [[{ id: "inc-co", policyId: policy.id }]],
      updates: [[]],
    });

    const received: BudgetEnforcementScope[] = [];
    onBudgetExhausted((scope) => { received.push(scope); });

    const svc = budgetService(db as any);
    await svc.evaluateCostEvent(agentId, companyId);
    await new Promise((r) => setImmediate(r));

    expect(received).toEqual([
      { companyId, scopeType: "company", scopeId: companyId },
    ]);
  });

  it("scopes signal to the specific agent — does not emit for unrelated agent policies", async () => {
    // Policy is for otherAgentId, but evaluate is for agentId — policy should
    // be filtered out by evaluateCostEvent's relevance check.
    const policy = agentHardStopPolicy({ scopeId: otherAgentId });
    const db = createSequenceDb({
      selects: [
        [policy],
      ],
      inserts: [],
      updates: [],
    });

    const received: BudgetEnforcementScope[] = [];
    onBudgetExhausted((scope) => { received.push(scope); });

    const svc = budgetService(db as any);
    await svc.evaluateCostEvent(agentId, companyId);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
  });

  it("does NOT emit for hard-stop-disabled policies", async () => {
    const policy = agentHardStopPolicy({ hardStopEnabled: false });
    const db = createSequenceDb({
      selects: [
        [policy],
        [{ total: 1500 }],
        [], // dedup for warning incident
      ],
      inserts: [[{ id: "inc-warn" }]],
      updates: [[]],
    });

    const received: BudgetEnforcementScope[] = [];
    onBudgetExhausted((scope) => { received.push(scope); });

    const svc = budgetService(db as any);
    await svc.evaluateCostEvent(agentId, companyId);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
  });
});

describe("budget-hooks — integration mid-run cancellation simulation", () => {
  beforeEach(() => {
    clearBudgetHooks();
  });

  it("scenario: $10 budget with $3 + $4 + $5 runs — third run triggers cancel signal", async () => {
    // Simulate three sequential cost events. The third pushes cumulative
    // spend (12c) over the 10c budget, triggering the hard-stop emit.
    const policy = agentHardStopPolicy({ amountCents: 10 });

    // Run evaluations happen three times. Only the third observes total >= limit.
    const cumulative = [3, 7, 12];
    const cancellations: BudgetEnforcementScope[] = [];

    onBudgetExhausted((scope) => {
      cancellations.push(scope);
    });

    for (const observed of cumulative) {
      const overLimit = observed >= 10;
      const db = createSequenceDb({
        selects: [
          [policy],
          [{ total: observed }],
          ...(observed >= 8 ? [[] as MockRow[]] : []), // dedup check only fires at/above warn
        ],
        inserts: overLimit
          ? [[{ id: `inc-${observed}` }], [{ id: `apr-${observed}` }]]
          : observed >= 8
            ? [[{ id: `inc-warn-${observed}` }]]
            : [],
        updates: overLimit ? [[], []] : [],
      });
      await budgetService(db as any).evaluateCostEvent(agentId, companyId);
      await new Promise((r) => setImmediate(r));
    }

    // Only the third evaluation (observed=12 >= limit=10) should have emitted
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toEqual({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
    });
  });
});
