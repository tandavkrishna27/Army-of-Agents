import { describe, it, expect, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Install stubs before the SUT import to prevent the drizzle ESM cycle.

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _type: "and", args }),
  eq: (col: unknown, value: unknown) => ({ _type: "eq", col, value }),
  lt: (col: unknown, value: unknown) => ({ _type: "lt", col, value }),
  isNotNull: (col: unknown) => ({ _type: "isNotNull", col }),
  desc: (col: unknown) => ({ _type: "desc", col }),
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

vi.mock("@armyofagents/db", () => {
  const cols: Record<string, symbol> = {};
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[`${name}.${prop}`]) cols[`${name}.${prop}`] = Symbol(`${name}.${prop}`);
          return cols[`${name}.${prop}`];
        }
        return undefined;
      },
    });

  return {
    heartbeatRuns: makeTable("heartbeat_runs"),
    heartbeatRunWatchdogDecisions: makeTable("heartbeat_run_watchdog_decisions"),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { sweepStaleHeartbeatRuns } from "../services/heartbeat-watchdog.js";

// ── Mock DB helper (sequence-based) ──────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(opts: {
  selects?: MockRow[][];
  inserts?: { capture: MockRow[] };
}) {
  let selectIdx = 0;
  const selects = opts.selects ?? [];
  const insertCapture = opts.inserts?.capture;

  function makeSelectChain(getResult: () => MockRow[]) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => chain;
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  function makeInsertChain(values: MockRow) {
    const chain: Record<string, unknown> = {};
    chain.values = (v: MockRow) => {
      if (insertCapture) insertCapture.push(v);
      return {
        then: (resolve: (v: null) => unknown) => Promise.resolve(resolve(null)),
      };
    };
    void values;
    return chain;
  }

  return {
    select: (_cols?: unknown) => makeSelectChain(() => selects[selectIdx++] ?? []),
    insert: (_table: unknown) => makeInsertChain({}),
  } as never;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const STALE = new Date(Date.now() - 45 * 60 * 1000); // 45 min ago — stale

describe("sweepStaleHeartbeatRuns", () => {
  it("records a decision for a stale run with no prior decision", async () => {
    const fakeRun = { id: "run-1", companyId: "company-1", lastOutputAt: STALE };
    const inserted: MockRow[] = [];

    const db = createSequenceDb({
      selects: [
        [fakeRun],  // stale runs query
        [],         // prior decisions for run-1 = none
      ],
      inserts: { capture: inserted },
    });

    const result = await sweepStaleHeartbeatRuns(db);

    expect(result.checked).toBe(1);
    expect(result.recorded).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      runId: "run-1",
      companyId: "company-1",
      decision: "stale_no_output",
    });
    // snoozedUntil should be ~1hr in the future
    const snoozed = inserted[0]!.snoozedUntil as Date;
    expect(snoozed).toBeInstanceOf(Date);
    expect(snoozed.getTime()).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    // reason includes the ISO timestamp
    expect(inserted[0]!.reason).toContain(STALE.toISOString());
  });

  it("skips when a prior decision is still within the snooze window", async () => {
    const fakeRun = { id: "run-2", companyId: "company-1", lastOutputAt: STALE };
    const futureSnooze = new Date(Date.now() + 30 * 60 * 1000); // 30 min from now
    const inserted: MockRow[] = [];

    const db = createSequenceDb({
      selects: [
        [fakeRun],
        [{ snoozedUntil: futureSnooze }], // still snoozed
      ],
      inserts: { capture: inserted },
    });

    const result = await sweepStaleHeartbeatRuns(db);

    expect(result.checked).toBe(1);
    expect(result.recorded).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("records a new decision when the prior snooze has expired", async () => {
    const fakeRun = { id: "run-3", companyId: "company-1", lastOutputAt: STALE };
    const expiredSnooze = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago — expired
    const inserted: MockRow[] = [];

    const db = createSequenceDb({
      selects: [
        [fakeRun],
        [{ snoozedUntil: expiredSnooze }],
      ],
      inserts: { capture: inserted },
    });

    const result = await sweepStaleHeartbeatRuns(db);

    expect(result.checked).toBe(1);
    expect(result.recorded).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ runId: "run-3", decision: "stale_no_output" });
  });

  it("returns checked=0 recorded=0 when no runs are stale", async () => {
    const db = createSequenceDb({
      selects: [
        [], // no stale runs
      ],
    });

    const result = await sweepStaleHeartbeatRuns(db);

    expect(result).toEqual({ checked: 0, recorded: 0 });
  });

  it("handles multiple stale runs — records for each unsnoozed run", async () => {
    const run1 = { id: "run-a", companyId: "company-1", lastOutputAt: STALE };
    const run2 = { id: "run-b", companyId: "company-1", lastOutputAt: STALE };
    const futureSnooze = new Date(Date.now() + 30 * 60 * 1000);
    const inserted: MockRow[] = [];

    const db = createSequenceDb({
      selects: [
        [run1, run2],           // both stale
        [],                     // run-a: no prior decision
        [{ snoozedUntil: futureSnooze }], // run-b: still snoozed
      ],
      inserts: { capture: inserted },
    });

    const result = await sweepStaleHeartbeatRuns(db);

    expect(result.checked).toBe(2);
    expect(result.recorded).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ runId: "run-a" });
  });

  it("returns correct counts when all stale runs get new decisions recorded", async () => {
    const runs = [
      { id: "r1", companyId: "c1", lastOutputAt: STALE },
      { id: "r2", companyId: "c1", lastOutputAt: STALE },
      { id: "r3", companyId: "c1", lastOutputAt: STALE },
    ];
    const inserted: MockRow[] = [];

    const db = createSequenceDb({
      selects: [
        runs,  // all stale
        [],    // r1: no prior
        [],    // r2: no prior
        [],    // r3: no prior
      ],
      inserts: { capture: inserted },
    });

    const result = await sweepStaleHeartbeatRuns(db);

    expect(result).toEqual({ checked: 3, recorded: 3 });
    expect(inserted).toHaveLength(3);
    const runIds = inserted.map((r) => r.runId);
    expect(runIds).toContain("r1");
    expect(runIds).toContain("r2");
    expect(runIds).toContain("r3");
  });
});
