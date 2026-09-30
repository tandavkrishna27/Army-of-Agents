import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// ── Mock DB helper (sequence-based, mirrors existing heartbeat-watchdog.test.ts) ──

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

  function makeInsertChain(_values: MockRow) {
    const chain: Record<string, unknown> = {};
    chain.values = (v: MockRow) => {
      if (insertCapture) insertCapture.push(v);
      return {
        then: (resolve: (v: null) => unknown) => Promise.resolve(resolve(null)),
      };
    };
    return chain;
  }

  return {
    select: (_cols?: unknown) => makeSelectChain(() => selects[selectIdx++] ?? []),
    insert: (_table: unknown) => makeInsertChain({}),
  } as never;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeStaleRunRow(id: string) {
  return {
    id,
    companyId: "company-1",
    lastOutputAt: new Date("2026-04-27T09:00:00Z"), // 1 hr before mockNow — stale
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

/**
 * Snooze de-duplication: sweepStaleHeartbeatRuns must skip recording a new
 * decision when the most recent decision for a run has snoozedUntil > now.
 *
 * Without this guard a regression that bypasses the snoozedUntil check would
 * silently record ~60 decisions per hour for a single stale run (one per
 * SWEEP_INTERVAL_MS = 60s sweep cycle).
 *
 * Fake timers are used so that the `new Date()` inside sweepStaleHeartbeatRuns
 * is pinned to mockNow, making prior-decision comparisons deterministic.
 */
describe("Watchdog snooze de-duplication", () => {
  const mockNow = new Date("2026-04-27T10:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(mockNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records 1 decision when run is stale and no prior decision exists", async () => {
    const inserted: MockRow[] = [];
    const db = createSequenceDb({
      selects: [
        [makeStaleRunRow("run-1")], // stale runs query
        [],                          // prior decisions for run-1 = none
      ],
      inserts: { capture: inserted },
    });

    const result = await sweepStaleHeartbeatRuns(db);

    expect(result).toEqual({ checked: 1, recorded: 1 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      runId: "run-1",
      companyId: "company-1",
      decision: "stale_no_output",
    });
  });

  it("skips when prior decision is still snoozed (1 sweep within snooze window)", async () => {
    const futureSnooze = new Date(mockNow.getTime() + 30 * 60_000); // 30 min in future
    const inserted: MockRow[] = [];
    const db = createSequenceDb({
      selects: [
        [makeStaleRunRow("run-1")],
        [{ snoozedUntil: futureSnooze }], // still snoozed
      ],
      inserts: { capture: inserted },
    });

    const result = await sweepStaleHeartbeatRuns(db);

    expect(result).toEqual({ checked: 1, recorded: 0 });
    expect(inserted).toHaveLength(0);
  });

  it("records new decision after snooze expires", async () => {
    const expiredSnooze = new Date(mockNow.getTime() - 5 * 60_000); // 5 min in past
    const inserted: MockRow[] = [];
    const db = createSequenceDb({
      selects: [
        [makeStaleRunRow("run-1")],
        [{ snoozedUntil: expiredSnooze }],
      ],
      inserts: { capture: inserted },
    });

    const result = await sweepStaleHeartbeatRuns(db);

    expect(result).toEqual({ checked: 1, recorded: 1 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ runId: "run-1", decision: "stale_no_output" });
  });

  it("multi-run mixed: 1 with snooze active + 1 without → 1 recorded", async () => {
    const futureSnooze = new Date(mockNow.getTime() + 30 * 60_000);
    const inserted: MockRow[] = [];
    const db = createSequenceDb({
      selects: [
        [makeStaleRunRow("run-1"), makeStaleRunRow("run-2")], // both stale
        [{ snoozedUntil: futureSnooze }],                     // run-1: still snoozed
        [],                                                    // run-2: no prior decision
      ],
      inserts: { capture: inserted },
    });

    const result = await sweepStaleHeartbeatRuns(db);

    expect(result).toEqual({ checked: 2, recorded: 1 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.runId).toBe("run-2");
  });
});
