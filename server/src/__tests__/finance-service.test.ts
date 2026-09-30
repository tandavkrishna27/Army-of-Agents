import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB / drizzle stubs ────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
  gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
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
    financeEvents: makeTable("finance_events"),
    costEvents: makeTable("cost_events"),
    agents: makeTable("agents"),
    companies: makeTable("companies"),
    issues: makeTable("issues"),
    projects: makeTable("projects"),
    goals: makeTable("goals"),
    heartbeatRuns: makeTable("heartbeat_runs"),
  };
});

import { financeService } from "../services/finance.js";

// ── Mock DB helpers ──────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;

  function makeChain(getResult: () => MockRow[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = [
      "from", "where", "orderBy", "limit", "offset", "leftJoin", "innerJoin",
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
  };
}

/**
 * DB mock that captures values passed to insert(...).values(...) so tests can
 * assert createEvent derives defaults + passes through caller-provided fields.
 * Sequence of selects supplies rows for ownership lookups (agents, issues...).
 */
function createCaptureDb(opts: {
  selects?: MockRow[][];
}) {
  const captured: { inserts: MockRow[] } = { inserts: [] };
  let selectIdx = 0;

  function makeChain(getResult: () => MockRow[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = [
      "from", "where", "orderBy", "limit", "offset", "leftJoin", "innerJoin",
      "set", "returning", "groupBy",
    ];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  function makeInsertChain() {
    const chain: Record<string, unknown> = {};
    chain.values = (v: MockRow) => {
      captured.inserts.push(v);
      const resultRow = { ...v, id: "finance-event-id" };
      const inner: Record<string, unknown> = {};
      inner.returning = () => inner;
      inner.then = (resolve: (v: MockRow[]) => unknown) =>
        Promise.resolve([resultRow]).then(resolve);
      return inner;
    };
    return chain;
  }

  const db = {
    select: (_fields?: unknown) =>
      makeChain(() => opts.selects?.[selectIdx++] ?? []),
    insert: () => makeInsertChain(),
  };

  return { db, captured };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherCompanyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const costEventId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const baseEventData = {
  biller: "anthropic",
  eventKind: "invoice",
  amountCents: 12345,
  occurredAt: new Date("2026-04-21T00:00:00.000Z"),
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("financeService — createEvent defaults", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults direction to 'debit', currency to 'USD', estimated to false", async () => {
    const { db, captured } = createCaptureDb({});
    const svc = financeService(db as any);
    await svc.createEvent(companyId, { ...baseEventData } as any);

    expect(captured.inserts[0]).toMatchObject({
      companyId,
      biller: "anthropic",
      eventKind: "invoice",
      amountCents: 12345,
      direction: "debit",
      currency: "USD",
      estimated: false,
    });
  });

  it("preserves caller-provided direction / currency / estimated", async () => {
    const { db, captured } = createCaptureDb({});
    const svc = financeService(db as any);
    await svc.createEvent(companyId, {
      ...baseEventData,
      direction: "credit",
      currency: "EUR",
      estimated: true,
    } as any);

    expect(captured.inserts[0]).toMatchObject({
      direction: "credit",
      currency: "EUR",
      estimated: true,
    });
  });

  it("accepts optional costEventId, externalInvoiceId, metadataJson", async () => {
    const { db, captured } = createCaptureDb({
      selects: [[{ id: costEventId, companyId }]],
    });
    const svc = financeService(db as any);
    await svc.createEvent(companyId, {
      ...baseEventData,
      costEventId,
      externalInvoiceId: "inv_abc123",
      metadataJson: { note: "one-off" },
    } as any);

    expect(captured.inserts[0]).toMatchObject({
      costEventId,
      externalInvoiceId: "inv_abc123",
      metadataJson: { note: "one-off" },
    });
  });
});

describe("financeService — createEvent ownership validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws 422 when agentId belongs to different company", async () => {
    const { db } = createCaptureDb({
      selects: [[{ id: agentId, companyId: otherCompanyId }]],
    });
    const svc = financeService(db as any);
    await expect(
      svc.createEvent(companyId, { ...baseEventData, agentId } as any),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("throws 404 when referenced costEvent missing", async () => {
    const { db } = createCaptureDb({ selects: [[]] });
    const svc = financeService(db as any);
    await expect(
      svc.createEvent(companyId, { ...baseEventData, costEventId } as any),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("accepts refs that belong to the same company", async () => {
    const { db, captured } = createCaptureDb({
      selects: [[{ id: costEventId, companyId }]],
    });
    const svc = financeService(db as any);
    await svc.createEvent(companyId, { ...baseEventData, costEventId } as any);
    expect(captured.inserts).toHaveLength(1);
  });
});

describe("financeService — summary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns debit/credit/net/estimated/eventCount normalized to numbers", async () => {
    const db = createSequenceDb({
      selects: [[{
        debitCents: 1000,
        creditCents: 300,
        estimatedDebitCents: 150,
        eventCount: 7,
      }]],
    });
    const svc = financeService(db as any);
    const result = await svc.summary(companyId);

    expect(result).toEqual({
      companyId,
      debitCents: 1000,
      creditCents: 300,
      netCents: 700,
      estimatedDebitCents: 150,
      eventCount: 7,
    });
  });

  it("returns zeros when no finance events", async () => {
    const db = createSequenceDb({ selects: [[]] });
    const svc = financeService(db as any);
    const result = await svc.summary(companyId);

    expect(result).toEqual({
      companyId,
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
  });

  it("accepts optional from/to date range", async () => {
    const db = createSequenceDb({
      selects: [[{ debitCents: 50, creditCents: 0, estimatedDebitCents: 0, eventCount: 1 }]],
    });
    const svc = financeService(db as any);
    const result = await svc.summary(companyId, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-04-30T23:59:59Z"),
    });
    expect(result.debitCents).toBe(50);
  });
});

describe("financeService — aggregation methods", () => {
  beforeEach(() => vi.clearAllMocks());

  it("byBiller returns rows from db", async () => {
    const rows: MockRow[] = [
      { biller: "anthropic", debitCents: 900, creditCents: 0, netCents: 900, eventCount: 3 },
      { biller: "openai", debitCents: 200, creditCents: 50, netCents: 150, eventCount: 2 },
    ];
    const db = createSequenceDb({ selects: [rows] });
    const svc = financeService(db as any);
    const result = await svc.byBiller(companyId);
    expect(result).toEqual(rows);
  });

  it("byKind returns rows from db", async () => {
    const rows: MockRow[] = [
      { eventKind: "invoice", debitCents: 1200, creditCents: 0, netCents: 1200, eventCount: 4 },
      { eventKind: "credit", debitCents: 0, creditCents: 300, netCents: -300, eventCount: 1 },
    ];
    const db = createSequenceDb({ selects: [rows] });
    const svc = financeService(db as any);
    const result = await svc.byKind(companyId);
    expect(result).toEqual(rows);
  });
});

describe("financeService — list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns paginated events from db", async () => {
    const rows: MockRow[] = [
      { id: "e1", biller: "anthropic", amountCents: 500, direction: "debit" },
      { id: "e2", biller: "openai", amountCents: 200, direction: "debit" },
    ];
    const db = createSequenceDb({ selects: [rows] });
    const svc = financeService(db as any);
    const result = await svc.list(companyId, {}, { limit: 100, offset: 0 });
    expect(result).toEqual(rows);
  });

  it("applies date range when provided", async () => {
    const db = createSequenceDb({ selects: [[]] });
    const svc = financeService(db as any);
    const result = await svc.list(companyId, {
      from: new Date("2026-04-01T00:00:00Z"),
      to: new Date("2026-04-30T23:59:59Z"),
    });
    expect(result).toEqual([]);
  });
});

describe("financeService — contract", () => {
  it("factory exposes all expected methods", () => {
    const db = createSequenceDb();
    const svc = financeService(db as any);
    const methods = ["createEvent", "summary", "byBiller", "byKind", "list"];
    for (const m of methods) {
      expect(typeof (svc as any)[m], `missing method: ${m}`).toBe("function");
    }
  });
});
