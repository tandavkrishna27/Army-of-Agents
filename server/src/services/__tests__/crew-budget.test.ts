/**
 * Unit tests for `preflightCrewDispatch` — the crew dispatch budget guard
 * (Task B4, T14).
 *
 * Pattern mirrors B2 (`thread-events.test.ts`) and B3 (`adjutant-context.test.ts`):
 * mock `@armyofagents/db` and `drizzle-orm` at module level via the shared
 * Proxy/operator helpers, then drive the service with a sequence-based mock
 * DB that captures both `.select()` reads (in order) AND `.insert()` writes
 * (we need both because the budget-exhaust path inserts a system entry).
 *
 * The order of `.select()` calls inside `preflightCrewDispatch`:
 *   1. discussion row (id + adjutantEnabled + companyId)
 *   2. budgetPolicies row (active, company-scoped, hard-stop) — may be empty
 *   3. costEvents sum (only when a policy row was found)
 *
 * On budget exhaustion the service:
 *   - opens a transaction
 *   - UPDATE discussions ... RETURNING (entrySeq, companyId)
 *   - INSERT discussion_entries ... RETURNING (with extractionStatus:"skipped" + seq)
 *   - publishLiveEvent × 2 (discussion.entry.created + thread.entry.created)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeTableProxy,
  drizzleOperatorStubs,
} from "../../__tests__/helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  discussions: makeTableProxy("discussions"),
  discussionEntries: makeTableProxy("discussion_entries"),
  budgetPolicies: makeTableProxy("budget_policies"),
  costEvents: makeTableProxy("cost_events"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// Mock live-events so we can spy on publishLiveEvent calls.
vi.mock("../live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

import {
  preflightCrewDispatch,
  formatBudgetExhaustedMessage,
} from "../crew-budget.js";
import { publishLiveEvent } from "../live-events.js";

// ---------------------------------------------------------------------------
// Sequence-based mock DB. Each `.select()` consumes the next preset row set
// from `selects`; each `.insert()` records its values + returned rows onto
// `insertCalls`; `update().returning()` returns `txUpdateReturns`.
// Every chain method is a no-op pass-through. The test wires the exact
// number of select stages it expects the service to take.
//
// Codex #7 fix: the budget-exhaust path now uses db.transaction() with an
// UPDATE .returning() (to get entrySeq+companyId) and an INSERT .returning()
// (to get the entry id+seq for live events). The mock supports both.
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
    { entrySeq: 1, companyId: "co-1" },
  ];
  const txInsertReturns: MockRow[] = config.txInsertReturns ?? [
    { id: "entry-budget-1", seq: 1, discussionId: "thread-1", inputType: "system" },
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
// Test fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-1";
const AGENT_ID = "agent-1";
const THREAD_ID = "thread-1";

function threadRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: THREAD_ID,
    adjutantEnabled: true,
    companyId: COMPANY_ID,
    ...overrides,
  };
}

/**
 * Budget policy row matching the shape of `budget_policies.$inferSelect`.
 * Defaults match what `budgetService.upsertPolicy` would write for a
 * company-scoped hard-stop cap of $100/month.
 */
function policyRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "policy-1",
    companyId: COMPANY_ID,
    scopeType: "company",
    scopeId: COMPANY_ID,
    metric: "cost_cents",
    windowKind: "calendar_month_utc",
    amountCents: 10000, // $100
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

describe("preflightCrewDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // publishLiveEvent returns a LiveEvent; the return value is not used by
    // preflightCrewDispatch, so we can safely return a stub object.
    vi.mocked(publishLiveEvent).mockReturnValue({} as ReturnType<typeof publishLiveEvent>);
  });

  // ── 1. Allows dispatch when under budget ────────────────────────────────

  it("allows dispatch when spend is under the cap", async () => {
    const db = createSequenceDb({
      selects: [
        [threadRow()],            // 1. thread
        [policyRow()],            // 2. policy ($100)
        [spendRow(5000)],         // 3. spend ($50)
      ],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result).toEqual({ allowed: true });
    // No system entry or live events on the green path.
    expect(db.insertCalls).toHaveLength(0);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  // ── 2. Allows dispatch when no budget policy exists ─────────────────────

  it("allows dispatch when no budget policy exists (unlimited)", async () => {
    const db = createSequenceDb({
      selects: [
        [threadRow()],            // 1. thread
        [],                       // 2. no policy row
        // No third select — the cost-event sum is skipped entirely.
      ],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result).toEqual({ allowed: true });
    expect(db.insertCalls).toHaveLength(0);
    expect(publishLiveEvent).not.toHaveBeenCalled();
    // Verify the service short-circuited after the no-policy lookup —
    // no cost-event scan when there's nothing to enforce against.
    expect(db.selectCalls).toHaveLength(2);
  });

  // ── 3. Blocks + posts system entry when over budget (Codex #7) ─────────────
  //
  // Verifies the full atomic pattern:
  //   - transaction wraps both the UPDATE discussions (entrySeq+entryCount bump)
  //     and the INSERT discussion_entries (with seq + extractionStatus:"skipped")
  //   - publishLiveEvent is called twice after the transaction completes
  //     (discussion.entry.created + thread.entry.created)

  it("blocks dispatch when spend meets cap and posts system entry atomically", async () => {
    const ENTRY_ID = "entry-budget-test-1";
    const ENTRY_SEQ = 7; // any non-zero seq to verify the plumbing

    const db = createSequenceDb({
      selects: [
        [threadRow()],            // 1. thread
        [policyRow()],            // 2. policy ($100)
        [spendRow(10500)],        // 3. spend ($105) — over cap
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
    expect(result.reason).toMatch(/budget reached/i);
    expect(result.reason).toContain(COMPANY_ID);
    expect(result.reason).toContain("10500"); // observed
    expect(result.reason).toContain("10000"); // cap

    // ── entry was inserted inside the transaction with the right fields ───────
    expect(db.insertCalls).toHaveLength(1);
    const insert = db.insertCalls[0];
    expect(insert.tableName).toBe("discussion_entries");
    expect(insert.values).toMatchObject({
      discussionId: THREAD_ID,
      inputType: "system",
      authorAgentId: null,
      createdBy: "system",
      extractionStatus: "skipped",
      seq: ENTRY_SEQ,
    });
    // rawContent is a string — content asserted in test 9 specifically.
    expect(typeof insert.values.rawContent).toBe("string");

    // ── live events published (Codex #7 fix) ─────────────────────────────────
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

  // ── 4. Per-thread adjutantEnabled=false overrides budget pass ───────────

  it("returns thread_disabled when adjutantEnabled=false (overrides budget pass)", async () => {
    const db = createSequenceDb({
      selects: [
        // Thread row says Adjutant is OFF. We never reach the budget query.
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

    // No budget query, no system entry, no live events.
    expect(db.selectCalls).toHaveLength(1);
    expect(db.insertCalls).toHaveLength(0);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  // ── 5. Thread not found ─────────────────────────────────────────────────

  it("returns thread_disabled when thread not found", async () => {
    const db = createSequenceDb({
      selects: [
        [], // empty thread lookup
      ],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: "bad-thread-id",
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reasonCode).toBe("thread_disabled");
    expect(result.reason).toContain("bad-thread-id");
    expect(result.reason).toMatch(/not found/i);

    // No budget query, no system entry, no live events.
    expect(db.selectCalls).toHaveLength(1);
    expect(db.insertCalls).toHaveLength(0);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  // ── 6. Spend calculation uses sum of cost_events for current month ──────

  it("queries cost_events bounded to current-month window", async () => {
    const db = createSequenceDb({
      selects: [
        [threadRow()],
        [policyRow()],
        [spendRow(0)],
      ],
    });

    await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    // Three select stages — thread, policy, cost-events sum.
    expect(db.selectCalls).toHaveLength(3);
    // The third select must be against cost_events.
    expect(db.selectCalls[2].fromTable).toBe("cost_events");
    // First select against discussions, second against budget_policies.
    expect(db.selectCalls[0].fromTable).toBe("discussions");
    expect(db.selectCalls[1].fromTable).toBe("budget_policies");
  });

  // ── 7. Does NOT post system entry when allowed:true ─────────────────────

  it("does NOT post a system entry on the green path", async () => {
    // Multiple green configurations — none should write to discussion_entries.
    const cases: SequenceDbConfig[] = [
      // Under-budget green path
      {
        selects: [[threadRow()], [policyRow()], [spendRow(1000)]],
      },
      // No policy (unlimited) green path
      {
        selects: [[threadRow()], []],
      },
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
      expect(publishLiveEvent).not.toHaveBeenCalled();
    }
  });

  // ── 8. adjutantEnabled=true + no budget policy → allowed ────────────────

  it("allows dispatch when adjutantEnabled=true AND no policy exists", async () => {
    const db = createSequenceDb({
      selects: [
        [threadRow({ adjutantEnabled: true })],
        [], // no policy
      ],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result).toEqual({ allowed: true });
    expect(db.insertCalls).toHaveLength(0);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  // ── 9. System entry message includes spend + cap as USD ─────────────────

  it("formats system entry with spend + cap as USD dollars", async () => {
    const db = createSequenceDb({
      selects: [
        [threadRow()],
        [policyRow({ amountCents: 50000 })], // $500 cap
        [spendRow(52345)],                    // $523.45 spend
      ],
    });

    await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(db.insertCalls).toHaveLength(1);
    const content = db.insertCalls[0].values.rawContent as string;
    // Both values must appear formatted as dollars (two-decimal currency).
    expect(content).toContain("$523.45");
    expect(content).toContain("$500.00");
    // The message should hint at the founder action — keeps the soft-fail
    // actionable rather than dead-end.
    expect(content).toMatch(/Settings.*Budget/i);
    expect(content).toMatch(/Adjutant.*paused/i);

    // Cross-check against the exported formatter — must be the same string.
    expect(content).toBe(formatBudgetExhaustedMessage(52345, 50000));
  });

  // ── Bonus: exact-at-cap is treated as exhausted (>= semantics) ──────────

  it("blocks dispatch when spend exactly equals the cap (>= semantics)", async () => {
    const db = createSequenceDb({
      selects: [
        [threadRow()],
        [policyRow({ amountCents: 10000 })],
        [spendRow(10000)], // exactly at cap
      ],
    });

    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reasonCode).toBe("budget_exhausted");
    expect(db.insertCalls).toHaveLength(1);
    // Live events are published even when spend is exactly at cap.
    expect(publishLiveEvent).toHaveBeenCalledTimes(2);
  });

  // ── Bonus: thread_disabled check fires BEFORE budget check ──────────────

  it("checks adjutantEnabled BEFORE budget (no policy lookup occurs)", async () => {
    const db = createSequenceDb({
      selects: [
        // Even though the budget would block, the thread is opted out first.
        // We only configure ONE select stage — if the service reached the
        // budget query, it would consume an empty stage and not see a policy,
        // returning allowed:true. The test asserts thread_disabled wins.
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
    // Critical: exactly ONE select call — no budget probe happened.
    expect(db.selectCalls).toHaveLength(1);
  });

  // ── Sanity: result.allowed is a discriminated union ─────────────────────

  it("returns a discriminated union (allowed:true has no reason fields)", async () => {
    const db = createSequenceDb({
      selects: [[threadRow()], [], /* no policy */],
    });
    const result = await preflightCrewDispatch(db as any, {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    });
    expect(result.allowed).toBe(true);
    // TS-level invariant: only the `false` branch carries reason/reasonCode.
    expect((result as Record<string, unknown>).reason).toBeUndefined();
    expect((result as Record<string, unknown>).reasonCode).toBeUndefined();
  });
});
