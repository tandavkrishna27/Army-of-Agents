/**
 * Unit tests for `createThreadEventListener` — the 30s human-entries-only
 * debounce listener that wakes Adjutant after humans pause posting (Task B2).
 *
 * Pattern mirrors `embeddings.test.ts` (B1): mock `@armyofagents/db` and
 * `drizzle-orm` at module level via the shared Proxy/operator helpers, then
 * drive the listener with a sequence-based mock DB. We use `vi.useFakeTimers()`
 * to advance the 30s debounce deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeTableProxy,
  drizzleOperatorStubs,
} from "../../__tests__/helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  agentWakeupRequests: makeTableProxy("agent_wakeup_requests"),
  discussions: makeTableProxy("discussions"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("../../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// thread-events now imports threadOrchestrationService and makeControllerAdjutantRunner.
// Mock both to prevent transitive import chains that touch @armyofagents/db exports
// not present in this test's partial mock (e.g. memoryItems via embeddings.ts).
vi.mock("../thread-orchestration.js", () => ({
  threadOrchestrationService: vi.fn(() => ({
    triggerOnHumanEntry: vi.fn().mockResolvedValue(undefined),
    runController: vi.fn().mockResolvedValue({ ran: false, reason: "no-pending" }),
  })),
}));

vi.mock("../internal-agent/aoa-agents/controller-adjutant-runner.js", () => ({
  makeControllerAdjutantRunner: vi.fn(() =>
    vi.fn().mockResolvedValue({ output: null }),
  ),
}));

import {
  createThreadEventListener,
  MAX_HOP_COUNT,
  type ThreadEventListener,
} from "../thread-events.js";

// ---------------------------------------------------------------------------
// Sequence-based mock DB. Each `select`/`insert` consumes the next preset row.
// Captures insert values + tracks .onConflictDoNothing() use so tests can
// inspect both shape and dedup-path activation.
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;

interface SequenceDbConfig {
  selects?: MockRow[][];
  inserts?: MockRow[][];
}

interface InsertCall {
  values: Record<string, unknown>;
  tableName?: string;
  onConflictDoNothing: boolean;
  returning: boolean;
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
  let selectIdx = 0;
  let insertIdx = 0;
  const selects = config.selects ?? [];
  const inserts = config.inserts ?? [];
  const insertCalls: InsertCall[] = [];

  function makeSelectChain(): any {
    const chain: any = {};
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    // Both then() and bare array-promise resolution paths.
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(selects[selectIdx++] ?? []));
    return chain;
  }

  function makeInsertChain(tableName?: string): any {
    const idx = insertIdx++;
    const call: InsertCall = {
      values: {},
      tableName,
      onConflictDoNothing: false,
      returning: false,
    };
    insertCalls.push(call);

    const chain: any = {
      values: (v: Record<string, unknown>) => {
        call.values = v;
        return chain;
      },
      onConflictDoNothing: () => {
        call.onConflictDoNothing = true;
        return chain;
      },
      returning: (..._args: unknown[]) => {
        call.returning = true;
        return chain;
      },
      then: (resolve: (v: MockRow[]) => unknown) =>
        Promise.resolve(resolve(inserts[idx] ?? [])),
    };
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeSelectChain(),
    insert: (table: unknown) => makeInsertChain(tableNameOf(table)),
    insertCalls,
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-1";
const THREAD_ID = "thread-1";
const ADJUTANT_ID = "adj-1";

function activeThreadRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: THREAD_ID,
    companyId: COMPANY_ID,
    crewPaused: false,
    adjutantEnabled: true,
    // Task 3.2 — proactive wake is Assist+ only. These debounce/dedup mechanics
    // tests assert the proactive wake PROCEEDS, so the thread dial is Assist (1):
    // thread.autonomyLevel != null ⇒ fireAdjutantWakeup uses it directly and never
    // fetches internal_agent_config, so the 2-select sequence (thread → agents)
    // is unchanged. Manual-suppression is covered by proactive-wake-dial.test.ts.
    autonomyLevel: 1,
    ...overrides,
  };
}

function adjutantRow(): MockRow {
  return { id: ADJUTANT_ID };
}

/** Build the standard "thread + adjutant" select sequence for a successful wakeup. */
function happyPathSelects(threadOverrides: Partial<MockRow> = {}): MockRow[][] {
  return [
    [activeThreadRow(threadOverrides)], // select discussions
    [adjutantRow()],                    // select agents (Adjutant)
  ];
}

function humanEntry(overrides: Partial<{
  id: string;
  discussionId: string;
  authorAgentId: string | null;
  inputType: string;
  createdBy: string;
}> = {}) {
  return {
    id: "entry-1",
    discussionId: THREAD_ID,
    authorAgentId: null,
    inputType: "write",
    createdBy: "user-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createThreadEventListener", () => {
  let listener: ThreadEventListener | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (listener) {
      listener.shutdown();
      listener = null;
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── Trigger gate: which entry types fire the debounce? ────────────────────

  describe("isHumanEntry gate", () => {
    it("does NOT trigger wakeup for agent-authored entries", async () => {
      const db = createSequenceDb({ selects: happyPathSelects() });
      listener = createThreadEventListener(db as any);

      await listener.onEntryCreated(
        humanEntry({ authorAgentId: "agent-x", inputType: "agent" }),
      );

      // Advance well past the debounce window.
      await vi.advanceTimersByTimeAsync(40_000);

      expect(db.insertCalls).toHaveLength(0);
    });

    it("does NOT trigger wakeup for system entries", async () => {
      const db = createSequenceDb({ selects: happyPathSelects() });
      listener = createThreadEventListener(db as any);

      await listener.onEntryCreated(
        humanEntry({ inputType: "system" }),
      );
      await vi.advanceTimersByTimeAsync(40_000);

      expect(db.insertCalls).toHaveLength(0);
    });

    it("does NOT trigger wakeup for scope_proposal entries", async () => {
      const db = createSequenceDb({ selects: happyPathSelects() });
      listener = createThreadEventListener(db as any);

      // Belt-and-suspenders: even with authorAgentId=null (the entry inserted
      // by Adjutant uses scope_proposal as the inputType signal), the listener
      // must not refire on its own output.
      await listener.onEntryCreated(
        humanEntry({ inputType: "scope_proposal" }),
      );
      await vi.advanceTimersByTimeAsync(40_000);

      expect(db.insertCalls).toHaveLength(0);
    });

    it("triggers wakeup for paste/write/voice/mcp human entries", async () => {
      // Run the four inputTypes through the same listener so we exercise both
      // the trigger gate and the debounce coalesce together.
      const inputTypes = ["paste", "write", "voice", "mcp"];
      for (const inputType of inputTypes) {
        const db = createSequenceDb({
          selects: happyPathSelects(),
          inserts: [[{ id: "wakeup-x" }]],
        });
        const l = createThreadEventListener(db as any);
        await l.onEntryCreated(humanEntry({ inputType }));
        await vi.advanceTimersByTimeAsync(30_000);

        // Flush microtasks — the timer callback chains a promise.
        await Promise.resolve();
        await Promise.resolve();

        expect(db.insertCalls).toHaveLength(1);
        expect(db.insertCalls[0].tableName).toBe("agent_wakeup_requests");
        l.shutdown();
      }
    });
  });

  // ── Debounce semantics ────────────────────────────────────────────────────

  describe("debounce", () => {
    it("inserts ONE wakeup with correct dedupKey + payload after 30s", async () => {
      const db = createSequenceDb({
        selects: happyPathSelects(),
        inserts: [[{ id: "wakeup-1" }]],
      });
      listener = createThreadEventListener(db as any);

      await listener.onEntryCreated(humanEntry());
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(db.insertCalls).toHaveLength(1);
      const call = db.insertCalls[0];
      expect(call.tableName).toBe("agent_wakeup_requests");
      expect(call.onConflictDoNothing).toBe(true);
      expect(call.values).toMatchObject({
        companyId: COMPANY_ID,
        agentId: ADJUTANT_ID,
        source: "thread.event",
        reason: "human_entry_debounce",
        status: "queued",
        dedupKey: `${ADJUTANT_ID}:${THREAD_ID}:queued`,
      });
      expect(call.values.payload).toEqual({
        threadId: THREAD_ID,
        hopCount: 0,
      });
    });

    it("coalesces 3 humans posting within 30s into ONE wakeup", async () => {
      const db = createSequenceDb({
        selects: happyPathSelects(),
        inserts: [[{ id: "wakeup-coalesced" }]],
      });
      listener = createThreadEventListener(db as any);

      // Three posts, each 5s apart. After the third we wait the full 30s.
      await listener.onEntryCreated(humanEntry({ id: "e1" }));
      await vi.advanceTimersByTimeAsync(5_000);
      await listener.onEntryCreated(humanEntry({ id: "e2" }));
      await vi.advanceTimersByTimeAsync(5_000);
      await listener.onEntryCreated(humanEntry({ id: "e3" }));

      // 20s after e3 — still inside the window, no fire yet.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(db.insertCalls).toHaveLength(0);

      // Cross the 30s boundary.
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(db.insertCalls).toHaveLength(1);
    });

    it("does NOT fire until 30s elapses without further activity", async () => {
      const db = createSequenceDb({
        selects: happyPathSelects(),
        inserts: [[{ id: "wakeup-1" }]],
      });
      listener = createThreadEventListener(db as any);

      await listener.onEntryCreated(humanEntry());
      await vi.advanceTimersByTimeAsync(29_999);
      // Just shy of the boundary — must not have fired.
      expect(db.insertCalls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(db.insertCalls).toHaveLength(1);
    });
  });

  // ── Per-thread opt-outs (re-checked at fire time) ─────────────────────────

  describe("per-thread opt-outs", () => {
    it("skips wakeup when thread.crewPaused = true (re-checked at fire)", async () => {
      const db = createSequenceDb({
        selects: [[activeThreadRow({ crewPaused: true })]],
        // No second select for Adjutant — we should bail before that.
        inserts: [],
      });
      listener = createThreadEventListener(db as any);

      await listener.onEntryCreated(humanEntry());
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(db.insertCalls).toHaveLength(0);
    });

    it("skips wakeup when thread.adjutantEnabled = false", async () => {
      const db = createSequenceDb({
        selects: [[activeThreadRow({ adjutantEnabled: false })]],
        inserts: [],
      });
      listener = createThreadEventListener(db as any);

      await listener.onEntryCreated(humanEntry());
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(db.insertCalls).toHaveLength(0);
    });

    it("skips wakeup when thread row no longer exists at fire time", async () => {
      const db = createSequenceDb({
        // Thread deleted between debounce start and fire.
        selects: [[]],
        inserts: [],
      });
      listener = createThreadEventListener(db as any);

      await listener.onEntryCreated(humanEntry());
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(db.insertCalls).toHaveLength(0);
    });

    it("skips wakeup gracefully when company has no Adjutant", async () => {
      const db = createSequenceDb({
        selects: [
          [activeThreadRow()], // discussion exists
          [],                  // ...but no Adjutant agent row
        ],
        inserts: [],
      });
      listener = createThreadEventListener(db as any);

      await listener.onEntryCreated(humanEntry());

      // Must not throw even though Adjutant is missing.
      await expect(
        (async () => {
          await vi.advanceTimersByTimeAsync(30_000);
          await Promise.resolve();
          await Promise.resolve();
        })(),
      ).resolves.toBeUndefined();

      expect(db.insertCalls).toHaveLength(0);
    });
  });

  // ── shutdown() ────────────────────────────────────────────────────────────

  describe("shutdown", () => {
    it("clears pending timers — no wakeup fires after shutdown", async () => {
      const db = createSequenceDb({
        selects: happyPathSelects(),
        inserts: [[{ id: "wakeup-1" }]],
      });
      listener = createThreadEventListener(db as any);

      await listener.onEntryCreated(humanEntry());

      // Tear down before the 30s window completes.
      listener.shutdown();
      listener = null;

      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(db.insertCalls).toHaveLength(0);
    });
  });

  // ── dispatchMention ───────────────────────────────────────────────────────

  describe("dispatchMention", () => {
    it("blocks dispatch when currentHopCount >= MAX_HOP_COUNT (3)", async () => {
      // No selects/inserts staged — they shouldn't be touched.
      const db = createSequenceDb({});
      listener = createThreadEventListener(db as any);

      const result = await listener.dispatchMention({
        agentId: "agent-2",
        threadId: THREAD_ID,
        entryId: "entry-1",
        currentHopCount: MAX_HOP_COUNT,
      });

      expect(result).toEqual({ wakeupId: null, blocked: true });
      expect(db.insertCalls).toHaveLength(0);
    });

    it("inserts a wakeup with hopCount incremented when below cap", async () => {
      const db = createSequenceDb({
        selects: [
          [{ companyId: COMPANY_ID }], // agent lookup
        ],
        inserts: [[{ id: "wakeup-mention-1" }]],
      });
      listener = createThreadEventListener(db as any);

      const result = await listener.dispatchMention({
        agentId: "agent-2",
        threadId: THREAD_ID,
        entryId: "entry-mention",
        currentHopCount: 1,
      });

      expect(result).toEqual({ wakeupId: "wakeup-mention-1", blocked: false });
      expect(db.insertCalls).toHaveLength(1);
      const call = db.insertCalls[0];
      expect(call.tableName).toBe("agent_wakeup_requests");
      expect(call.onConflictDoNothing).toBe(true);
      expect(call.returning).toBe(true);
      expect(call.values).toMatchObject({
        companyId: COMPANY_ID,
        agentId: "agent-2",
        source: "thread.mention",
        reason: "agent_mentioned",
        status: "queued",
        // hopCount=2 because incoming was 1, we store currentHopCount+1.
        dedupKey: `agent-2:${THREAD_ID}:queued`,
      });
      expect(call.values.payload).toEqual({
        threadId: THREAD_ID,
        mentionEntryId: "entry-mention",
        hopCount: 2,
      });
    });

    it("uses dedupKey format `${agentId}:${threadId}:queued`", async () => {
      const db = createSequenceDb({
        selects: [[{ companyId: COMPANY_ID }]],
        inserts: [[{ id: "wakeup-x" }]],
      });
      listener = createThreadEventListener(db as any);

      await listener.dispatchMention({
        agentId: "agent-99",
        threadId: "thread-abc",
        entryId: "e-1",
        currentHopCount: 0,
      });

      expect(db.insertCalls[0].values.dedupKey).toBe(
        "agent-99:thread-abc:queued",
      );
    });

    it("returns null wakeupId (not blocked) when dedup collision swallows the row", async () => {
      // .onConflictDoNothing() + .returning() returns [] when the conflict
      // suppressed the insert — the listener must not crash and must report
      // blocked=false (the dedup case is distinct from hop-cap blocked).
      const db = createSequenceDb({
        selects: [[{ companyId: COMPANY_ID }]],
        inserts: [[]],
      });
      listener = createThreadEventListener(db as any);

      const result = await listener.dispatchMention({
        agentId: "agent-2",
        threadId: THREAD_ID,
        entryId: "entry-1",
        currentHopCount: 0,
      });

      expect(result).toEqual({ wakeupId: null, blocked: false });
    });

    it("no-ops gracefully when agentId does not resolve", async () => {
      const db = createSequenceDb({
        selects: [[]], // agent not found
        inserts: [],
      });
      listener = createThreadEventListener(db as any);

      const result = await listener.dispatchMention({
        agentId: "ghost-agent",
        threadId: THREAD_ID,
        entryId: "entry-1",
        currentHopCount: 0,
      });

      expect(result).toEqual({ wakeupId: null, blocked: false });
      expect(db.insertCalls).toHaveLength(0);
    });
  });
});
