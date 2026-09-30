/**
 * controller-adjutant-runner — unit tests.
 *
 * Tests:
 *   1. Resolves the Adjutant and calls runAgent with the correct payload.
 *   2. Returns { output: null, error: "thread not found" } when thread select is empty.
 *   3. Returns { output: null, error: "no Adjutant agent …" } when no Adjutant found.
 *   4. Propagates runAgent's errorMessage into the returned `error` field.
 *   5. Passes effectiveAutonomy = thread.autonomyLevel ?? companyLevel to runAgent.
 *
 * Uses the Proxy-table-stub + sequence-db pattern (see strangler-flag.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
}));

// ── @armyofagents/db mock ─────────────────────────────────────────────────────
function tableProxy(name: string) {
  return new Proxy({}, { get(_t, prop) { return `${name}_${String(prop)}`; } });
}

vi.mock("@armyofagents/db", () => ({
  agents: tableProxy("agents"),
  discussions: tableProxy("discussions"),
  internalAgentConfig: tableProxy("internalAgentConfig"),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// ── runner.ts mock — we never want a real CLI spawn ──────────────────────────
vi.mock(
  "../services/internal-agent/aoa-agents/runner.js",
  () => ({ runAoaAgent: vi.fn() }),
);

// ── Import AFTER mocks ────────────────────────────────────────────────────────
import { makeControllerAdjutantRunner } from "../services/internal-agent/aoa-agents/controller-adjutant-runner.js";

// ── DB builder helpers ────────────────────────────────────────────────────────

/**
 * Build a minimal stub db.
 * The runner does:
 *   select 1: discussions (returns threadRow or [])
 *   select 2: agents (returns adjutantRow or [])
 *   select 3: internalAgentConfig (returns companyCfgRow or [] — only reached when thread + adjutant found)
 */
function makeDb(opts: {
  threadRow?: Record<string, unknown> | null;
  adjutantRow?: Record<string, unknown> | null;
  companyCfgRow?: Record<string, unknown> | null;
}) {
  const { threadRow = null, adjutantRow = null, companyCfgRow = null } = opts;

  const results: Array<Array<Record<string, unknown>>> = [
    threadRow ? [threadRow] : [],
    adjutantRow ? [adjutantRow] : [],
    companyCfgRow ? [companyCfgRow] : [],
  ];
  let callIdx = 0;

  const db = {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(() => {
        const row = results[callIdx] ?? [];
        callIdx++;
        return Promise.resolve(row);
      }),
    })),
  };

  return db;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("makeControllerAdjutantRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1: resolves Adjutant and calls runAgent with correct payload", async () => {
    const fakeRunAgent = vi.fn().mockResolvedValue({ status: "succeeded" });

    const db = makeDb({
      // Assist (1) so the proactive run is NOT suppressed by the Finding #6 gate.
      threadRow: { companyId: "company-abc", autonomyLevel: 1 },
      adjutantRow: { id: "adjutant-agent-1" },
      companyCfgRow: { autonomyLevel: 0 },
    });

    const runner = makeControllerAdjutantRunner(db as any, { runAgent: fakeRunAgent });
    const result = await runner({
      threadId: "thread-42",
      entries: [],
      startEpoch: 1,
    });

    expect(fakeRunAgent).toHaveBeenCalledOnce();
    expect(fakeRunAgent).toHaveBeenCalledWith(
      db,
      "adjutant-agent-1",
      {
        companyId: "company-abc",
        source: "thread.controller",
        threadId: "thread-42",
        effectiveAutonomy: 1,
      },
    );
    expect(result).toEqual({ output: { status: "succeeded" }, error: undefined });
  });

  it("2: returns { output: null, error: 'thread not found' } when thread select is empty", async () => {
    const fakeRunAgent = vi.fn();

    const db = makeDb({ threadRow: null });

    const runner = makeControllerAdjutantRunner(db as any, { runAgent: fakeRunAgent });
    const result = await runner({ threadId: "thread-missing", entries: [], startEpoch: 1 });

    expect(fakeRunAgent).not.toHaveBeenCalled();
    expect(result).toEqual({ output: null, error: "thread not found" });
  });

  it("3: returns error when no Adjutant agent found for company", async () => {
    const fakeRunAgent = vi.fn();

    const db = makeDb({
      threadRow: { companyId: "company-xyz" },
      adjutantRow: null,
    });

    const runner = makeControllerAdjutantRunner(db as any, { runAgent: fakeRunAgent });
    const result = await runner({ threadId: "thread-no-adj", entries: [], startEpoch: 1 });

    expect(fakeRunAgent).not.toHaveBeenCalled();
    expect(result).toEqual({ output: null, error: "no Adjutant agent for company" });
  });

  it("4: propagates runAgent errorMessage into the returned error field", async () => {
    const fakeRunAgent = vi.fn().mockResolvedValue({
      status: "failed",
      errorMessage: "cli exited with code 1",
    });

    const db = makeDb({
      // Assist (1) so the run actually executes and we can observe the failure
      // propagation (the Finding #6 gate only suppresses at < 1).
      threadRow: { companyId: "company-fail", autonomyLevel: 1 },
      adjutantRow: { id: "adjutant-fail" },
      companyCfgRow: { autonomyLevel: 0 },
    });

    const runner = makeControllerAdjutantRunner(db as any, { runAgent: fakeRunAgent });
    const result = await runner({ threadId: "thread-fail", entries: [], startEpoch: 1 });

    expect(result).toEqual({
      output: { status: "failed" },
      error: "cli exited with code 1",
    });
  });

  it("5: passes effectiveAutonomy resolved as thread.autonomyLevel ?? companyLevel", async () => {
    // Thread autonomy level 2 should win over company level 0.
    const fakeRunAgent = vi.fn().mockResolvedValue({ status: "succeeded" });

    const db = makeDb({
      threadRow: { companyId: "company-l2", autonomyLevel: 2 },
      adjutantRow: { id: "adjutant-l2" },
      companyCfgRow: { autonomyLevel: 0 },
    });

    const runner = makeControllerAdjutantRunner(db as any, { runAgent: fakeRunAgent });
    await runner({ threadId: "thread-l2", entries: [], startEpoch: 1 });

    expect(fakeRunAgent).toHaveBeenCalledOnce();
    const payload = fakeRunAgent.mock.calls[0][2];
    expect(payload.effectiveAutonomy).toBe(2);
  });

  it("5b: falls back to company autonomyLevel when thread.autonomyLevel is null", async () => {
    // Thread has null autonomy → falls back to company level 1.
    const fakeRunAgent = vi.fn().mockResolvedValue({ status: "succeeded" });

    const db = makeDb({
      threadRow: { companyId: "company-l1", autonomyLevel: null },
      adjutantRow: { id: "adjutant-l1" },
      companyCfgRow: { autonomyLevel: 1 },
    });

    const runner = makeControllerAdjutantRunner(db as any, { runAgent: fakeRunAgent });
    await runner({ threadId: "thread-l1", entries: [], startEpoch: 1 });

    expect(fakeRunAgent).toHaveBeenCalledOnce();
    const payload = fakeRunAgent.mock.calls[0][2];
    expect(payload.effectiveAutonomy).toBe(1);
  });

  // ── Finding #6: dial-as-experience belt-and-suspenders ──────────────────────
  // The runner is the `adjutantRunner` seam runController drives. Even if a
  // pendingRun were set and runController reached this runner for a Manual thread,
  // the runner must NOT produce a proactive Adjutant post: it returns a no-op
  // {status:"no-pending"} and never calls runAgent. This is independent from
  // fireAdjutantWakeup's primary gate (proactive-wake-dial.test.ts).

  it("6: Manual via thread-level dial (autonomyLevel=0) → no-op, runAgent NOT called", async () => {
    const fakeRunAgent = vi.fn();

    const db = makeDb({
      threadRow: { companyId: "company-manual", autonomyLevel: 0 },
      adjutantRow: { id: "adjutant-manual" },
      // companyCfg is still resolved (the runner reads it before the gate), but
      // thread.autonomyLevel=0 wins → effectiveAutonomy=0 → suppress.
      companyCfgRow: { autonomyLevel: 2 },
    });

    const runner = makeControllerAdjutantRunner(db as any, { runAgent: fakeRunAgent });
    const result = await runner({ threadId: "thread-manual", entries: [], startEpoch: 1 });

    expect(fakeRunAgent).not.toHaveBeenCalled();
    expect(result).toEqual({ output: { status: "no-pending" }, error: undefined });
  });

  it("6b: Manual via company fallback (thread null, company=0) → no-op, runAgent NOT called", async () => {
    const fakeRunAgent = vi.fn();

    const db = makeDb({
      threadRow: { companyId: "company-manual-fb", autonomyLevel: null },
      adjutantRow: { id: "adjutant-manual-fb" },
      companyCfgRow: { autonomyLevel: 0 },
    });

    const runner = makeControllerAdjutantRunner(db as any, { runAgent: fakeRunAgent });
    const result = await runner({ threadId: "thread-manual-fb", entries: [], startEpoch: 1 });

    expect(fakeRunAgent).not.toHaveBeenCalled();
    expect(result).toEqual({ output: { status: "no-pending" }, error: undefined });
  });
});
