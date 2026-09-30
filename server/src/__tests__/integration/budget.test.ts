/**
 * Phase G4.5 — Integration tests for crew dispatch budget gating.
 *
 * Verifies the preflightCrewDispatch gate end-to-end with respect to the
 * thread + budget + cost_events tables. As of the G4 wiring-gap close,
 * preflight now consults BOTH `discussions.adjutantEnabled` (the narrow
 * Adjutant-only opt-out → `thread_disabled`) AND `discussions.crewPaused`
 * (the broader thread-wide kill-switch → `thread_paused`). The pause
 * check fires BEFORE the budget probe so an explicit founder pause beats
 * a budget-exhausted message.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeTableProxy,
  drizzleOperatorStubs,
} from "../helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  discussions: makeTableProxy("discussions"),
  discussionEntries: makeTableProxy("discussion_entries"),
  budgetPolicies: makeTableProxy("budget_policies"),
  costEvents: makeTableProxy("cost_events"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// Mock live-events so the transaction-based budget-block path can call
// publishLiveEvent without touching real sockets.
vi.mock("../../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

import {
  preflightCrewDispatch,
  formatBudgetExhaustedMessage,
} from "../../services/crew-budget.js";
import { publishLiveEvent } from "../../services/live-events.js";

// ---------------------------------------------------------------------------
// Sequence DB harness — mirrors crew-budget.test.ts so we capture .select()
// rows (in order: thread → policy → spend) AND .insert() writes against
// discussion_entries (the budget-exhausted system entry).
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;

interface InsertCall {
  tableName?: string;
  values: Record<string, unknown>;
}

interface SequenceDbConfig {
  selects?: MockRow[][];
  /** Rows returned by the UPDATE discussions .returning() inside the transaction */
  txUpdateReturns?: MockRow[];
  /** Rows returned by the INSERT discussion_entries .returning() inside the transaction */
  txInsertReturns?: MockRow[];
}

function tableNameOf(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const meta = (value as Record<string, unknown>)["_"];
    if (meta && typeof meta === "object") {
      const name = (meta as Record<string, unknown>).name;
      if (typeof name === "string") return name;
    }
  }
  return undefined;
}

function createSequenceDb(config: SequenceDbConfig = {}) {
  const selects = config.selects ?? [];
  let selectIdx = 0;
  const selectCalls: { fromTable?: string }[] = [];
  const insertCalls: InsertCall[] = [];

  // Default transaction return values when not overridden by the test.
  const txUpdateReturns: MockRow[] = config.txUpdateReturns ?? [
    { entrySeq: 1, companyId: COMPANY_ID },
  ];
  const txInsertReturns: MockRow[] = config.txInsertReturns ?? [
    { id: "entry-budget-1", seq: 1, discussionId: THREAD_ID, inputType: "system" },
  ];

  function makeSelectChain(): any {
    const call: { fromTable?: string } = {};
    selectCalls.push(call);
    const chain: any = {};
    for (const m of ["where", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.from = (table: unknown) => {
      call.fromTable = tableNameOf(table);
      return chain;
    };
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(selects[selectIdx++] ?? []));
    return chain;
  }

  function makeInsertChain(tableName?: string): any {
    const call: InsertCall = { tableName, values: {} };
    insertCalls.push(call);
    const chain: any = {
      values: (v: Record<string, unknown>) => {
        call.values = v;
        return {
          returning: () => Promise.resolve(txInsertReturns),
          then: (resolve: (v: MockRow[]) => unknown) =>
            Promise.resolve(resolve([])),
        };
      },
      then: (resolve: (v: MockRow[]) => unknown) =>
        Promise.resolve(resolve([])),
    };
    return chain;
  }

  // The transaction mock runs the callback with a proxy `tx` that routes
  // update().returning() to txUpdateReturns and insert() to makeInsertChain.
  function makeTx(): any {
    return {
      update: (_table: unknown) => ({
        set: (_vals: unknown) => ({
          where: (_cond: unknown) => ({
            returning: (_cols: unknown) => Promise.resolve(txUpdateReturns),
          }),
        }),
      }),
      insert: (table: unknown) => makeInsertChain(tableNameOf(table)),
    };
  }

  return {
    select: (..._args: unknown[]) => makeSelectChain(),
    insert: (table: unknown) => makeInsertChain(tableNameOf(table)),
    transaction: (fn: (tx: any) => Promise<unknown>) => fn(makeTx()),
    selectCalls,
    insertCalls,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-budget-1";
const AGENT_ID = "agent-budget-caller";
const THREAD_ID = "thread-budget-1";

function threadRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: THREAD_ID,
    adjutantEnabled: true,
    companyId: COMPANY_ID,
    ...overrides,
  };
}

function policyRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "policy-budget-1",
    companyId: COMPANY_ID,
    scopeType: "company",
    scopeId: COMPANY_ID,
    metric: "cost_cents",
    windowKind: "calendar_month_utc",
    amountCents: 10000, // $100 cap
    warnPercent: 80,
    hardStopEnabled: true,
    isActive: true,
    ...overrides,
  };
}

function spendRow(totalCents: number): MockRow {
  return { total: totalCents };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: preflightCrewDispatch budget gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // publishLiveEvent returns a LiveEvent; the return value is not used by
    // preflightCrewDispatch, so we can safely return a stub object.
    vi.mocked(publishLiveEvent).mockReturnValue({} as ReturnType<typeof publishLiveEvent>);
  });

  // ── 1. Under budget → allowed; no system entry written ──────────────────

  it("returns {allowed:true} when company is under the budget cap", async () => {
    const db = createSequenceDb({
      selects: [
        [threadRow()],          // 1. thread
        [policyRow()],          // 2. policy ($100 cap)
        [spendRow(5000)],       // 3. spend ($50)
      ],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result).toEqual({ allowed: true });
    // Green path → no system entry written into the thread.
    expect(db.insertCalls).toHaveLength(0);
  });

  it("returns {allowed:true} when no budget policy exists (unlimited)", async () => {
    const db = createSequenceDb({
      selects: [
        [threadRow()],
        [],                     // no policy row → unlimited
      ],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result).toEqual({ allowed: true });
    // The cost-event scan is short-circuited when no policy exists. The
    // service only issues 2 selects in this branch.
    expect(db.selectCalls).toHaveLength(2);
    expect(db.insertCalls).toHaveLength(0);
  });

  // ── 2. Budget exhausted → blocked + system entry posted ─────────────────

  it("returns {allowed:false, reasonCode:'budget_exhausted'} AND posts a system entry into the thread", async () => {
    const ENTRY_ID = "entry-budget-test-1";
    const ENTRY_SEQ = 5;

    const db = createSequenceDb({
      selects: [
        [threadRow()],
        [policyRow()],          // $100 cap
        [spendRow(10500)],      // $105 spend — over cap
      ],
      txUpdateReturns: [{ entrySeq: ENTRY_SEQ, companyId: COMPANY_ID }],
      txInsertReturns: [{ id: ENTRY_ID, seq: ENTRY_SEQ, discussionId: THREAD_ID, inputType: "system" }],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reasonCode).toBe("budget_exhausted");

    // The reason must include the company id and the dollar amounts so the
    // founder can reconstruct exactly which scope hit the cap. (Verified
    // via raw cents — the human-readable USD string is asserted separately.)
    expect(result.reason).toContain(COMPANY_ID);
    expect(result.reason).toContain("10500");
    expect(result.reason).toContain("10000");

    // ── The system entry — this is what the founder SEES in the thread ──
    // The entry is now inserted inside a transaction via tx.insert().values().returning().
    expect(db.insertCalls).toHaveLength(1);
    const entry = db.insertCalls[0];
    expect(entry.tableName).toBe("discussion_entries");
    expect(entry.values).toMatchObject({
      discussionId: THREAD_ID,
      inputType: "system",
      authorAgentId: null,
      createdBy: "system",
      extractionStatus: "skipped",
      seq: ENTRY_SEQ,
    });
    // The structured failure message — exact match against the exported
    // formatter so a future format drift is caught.
    expect(entry.values.rawContent).toBe(
      formatBudgetExhaustedMessage(10500, 10000),
    );
    expect(entry.values.rawContent).toMatch(/\$105\.00/);
    expect(entry.values.rawContent).toMatch(/\$100\.00/);

    // ── Live events published after the transaction completes ────────────
    expect(publishLiveEvent).toHaveBeenCalledTimes(2);
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        type: "discussion.entry.created",
        payload: expect.objectContaining({ discussionId: THREAD_ID, entryId: ENTRY_ID, inputType: "system" }),
      }),
    );
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        type: "thread.entry.created",
        payload: expect.objectContaining({ threadId: THREAD_ID, entryId: ENTRY_ID, seq: ENTRY_SEQ }),
      }),
    );
  });

  it("budget exhaustion at exactly the cap (spend === cap) still blocks (>= semantics)", async () => {
    const db = createSequenceDb({
      selects: [
        [threadRow()],
        [policyRow({ amountCents: 10000 })],
        [spendRow(10000)],      // exactly at cap
      ],
      // Use defaults — the transaction mock will return a valid entry row.
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reasonCode).toBe("budget_exhausted");
    // Boundary semantics: >= cap blocks. < cap allows. This is a
    // contract test for that boundary (vs > cap, which would let users
    // overshoot by a cent before blocking).
    expect(db.insertCalls).toHaveLength(1);
    // Live events are published even when spend is exactly at cap.
    expect(publishLiveEvent).toHaveBeenCalledTimes(2);
  });

  // ── 3. Per-thread Adjutant opt-out → blocked WITHOUT budget probe ───────

  it("thread.adjutantEnabled=false → reasonCode='thread_disabled', NO budget query, NO system entry", async () => {
    // `adjutantEnabled=false` is the narrow Adjutant-only opt-out
    // (`thread_disabled`). The broader thread-wide kill-switch is
    // `crewPaused` (`thread_paused`) — see test 4 below.
    const db = createSequenceDb({
      selects: [
        [threadRow({ adjutantEnabled: false })],
      ],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reasonCode).toBe("thread_disabled");
    expect(result.reason).toMatch(/disabled/i);

    // Critical: ONLY one select (the thread row). No budget probe, no
    // cost-event scan. Disabled is the most authoritative signal —
    // anything the budget might say is moot.
    expect(db.selectCalls).toHaveLength(1);
    expect(db.insertCalls).toHaveLength(0);
  });

  it("missing thread row → reasonCode='thread_disabled' (defensive default)", async () => {
    const db = createSequenceDb({
      selects: [[]], // thread row not found
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: "bad-thread-id",
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reasonCode).toBe("thread_disabled");
    expect(result.reason).toMatch(/not found/i);
    expect(db.insertCalls).toHaveLength(0);
  });

  // ── 4. Phase G4 wiring gap closed: crewPaused gates preflight ───────────

  it("thread.crewPaused=true → reasonCode='thread_paused', NO budget query, NO system entry", async () => {
    // Plan: "Per-thread crewPaused=true causes preflight to return
    // {ok:false, reason:'thread_paused'}". The check fires BEFORE the
    // budget probe so an explicit founder pause beats a budget-exhausted
    // message. No system entry is written — the founder already knows
    // they paused it.
    const db = createSequenceDb({
      selects: [
        // crewPaused=true but adjutantEnabled=true — the broader pause wins.
        [threadRow({ crewPaused: true, adjutantEnabled: true })],
      ],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reasonCode).toBe("thread_paused");
    expect(result.reason).toMatch(/paused/i);

    // Critical: only the thread row was read — no budget probe, no
    // cost-event scan, no system entry.
    expect(db.selectCalls).toHaveLength(1);
    expect(db.insertCalls).toHaveLength(0);
  });

  it("thread.crewPaused=false → preflight PROCEEDS to the budget check", async () => {
    // Complementary: explicit `crewPaused=false` doesn't short-circuit;
    // the gate continues to the budget probe and (with a healthy budget)
    // returns allowed.
    const db = createSequenceDb({
      selects: [
        [threadRow({ crewPaused: false, adjutantEnabled: true })],
        [policyRow()],          // $100 cap
        [spendRow(2500)],       // $25 spend — well under cap
      ],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result).toEqual({ allowed: true });
    // Verify the gate actually walked all three select stages — the
    // crewPaused=false branch must NOT short-circuit anywhere.
    expect(db.selectCalls).toHaveLength(3);
    expect(db.insertCalls).toHaveLength(0);
  });

  it("thread.crewPaused=true wins over budget exhaustion (pause beats budget)", async () => {
    // Ordering contract: when a thread is both paused AND over-budget,
    // the surfaced reason is the founder action (thread_paused), not the
    // indirect symptom (budget_exhausted). No budget probe runs at all.
    const db = createSequenceDb({
      selects: [
        [threadRow({ crewPaused: true })],
        // No budget select stages — preflight must not probe them.
      ],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reasonCode).toBe("thread_paused");
    expect(db.selectCalls).toHaveLength(1);
    expect(db.insertCalls).toHaveLength(0);
  });

  // ── 5. Sanity: green path issues no inserts across multiple configs ─────

  it("never writes a system entry on any green-path outcome", async () => {
    const cases: SequenceDbConfig[] = [
      // Under-budget with policy
      { selects: [[threadRow()], [policyRow()], [spendRow(1000)]] },
      // No policy (unlimited)
      { selects: [[threadRow()], []] },
      // Right under the cap by $0.01
      { selects: [[threadRow()], [policyRow({ amountCents: 10000 })], [spendRow(9999)]] },
    ];

    for (const cfg of cases) {
      const db = createSequenceDb(cfg);
      const result = await preflightCrewDispatch(db as any, {
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        threadId: THREAD_ID,
      });
      expect(result.allowed).toBe(true);
      expect(db.insertCalls).toHaveLength(0);
    }
  });
});
