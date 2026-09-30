/**
 * sweep-controller — unit tests.
 *
 * Tests:
 *   1. Pending controller-path threads → runController called once per thread.
 *   2. No pending threads → runController NOT called.
 *   3. A runController rejection for one thread does NOT abort the others.
 *
 * Uses Proxy-table-stub + sequence-db pattern + module mocks for
 * thread-orchestration.js and controller-adjutant-runner.js.
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
  discussions: tableProxy("discussions"),
  threadOrchestrationState: tableProxy("tos"),
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

// ── thread-orchestration mock ─────────────────────────────────────────────────
const mockRunController = vi.fn().mockResolvedValue({ ran: false, reason: "no-pending" });

vi.mock("../services/thread-orchestration.js", () => ({
  threadOrchestrationService: vi.fn(() => ({
    runController: mockRunController,
  })),
}));

// ── controller-adjutant-runner mock — we inject a fake runner in tests ────────
const fakeAdjutantRunner = vi.fn().mockResolvedValue({ output: { status: "succeeded" } });

vi.mock(
  "../services/internal-agent/aoa-agents/controller-adjutant-runner.js",
  () => ({
    makeControllerAdjutantRunner: vi.fn(() => fakeAdjutantRunner),
  }),
);

// ── stale-action reaper mock — assert the sweep invokes it ────────────────────
// vi.hoisted so the spy exists before vi.mock's hoisted factory references it.
const {
  mockReapStaleThreadAgentActions,
  mockCommitThreadAgentActions,
  mockGcOrphanedProposedActions,
} = vi.hoisted(() => ({
  mockReapStaleThreadAgentActions: vi.fn().mockResolvedValue({ reaped: 0 }),
  mockCommitThreadAgentActions: vi.fn().mockResolvedValue({
    committed: 0,
    suppressed: 0,
    blocked: 0,
    failed: 0,
    lostRace: 0,
  }),
  mockGcOrphanedProposedActions: vi.fn().mockResolvedValue({ reaped: 0, runsTerminalized: 0, resealed: 0 }),
}));

vi.mock("../services/thread-agent-actions.js", () => ({
  reapStaleThreadAgentActions: mockReapStaleThreadAgentActions,
  gcOrphanedProposedActions: mockGcOrphanedProposedActions,
  threadAgentActionService: vi.fn(() => ({
    commitThreadAgentActions: mockCommitThreadAgentActions,
  })),
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────────
import { runControllerSweep } from "../services/internal-agent/aoa-agents/sweep-controller.js";

// ── DB builder helper ─────────────────────────────────────────────────────────

/**
 * Build a minimal stub db.
 * The sweep does ONE select (with innerJoin) returning pending thread rows.
 */
function makeDb(pendingThreadIds: string[]) {
  const rows = pendingThreadIds.map((id) => ({ threadId: id, companyId: "company-1" }));

  const db = {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn(() => Promise.resolve(rows)),
    })),
    // The pendingRun re-arm path (drain left retryable work) issues update().set().where().
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(undefined)),
      })),
    })),
  };

  return db;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runControllerSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunController.mockResolvedValue({ ran: false, reason: "no-pending" });
    mockReapStaleThreadAgentActions.mockResolvedValue({ reaped: 0 });
    mockCommitThreadAgentActions.mockResolvedValue({
      committed: 0,
      suppressed: 0,
      blocked: 0,
      failed: 0,
      lostRace: 0,
    });
    mockGcOrphanedProposedActions.mockResolvedValue({ reaped: 0, runsTerminalized: 0, resealed: 0 });
  });

  it("4: reaps stale committing rows once at the start of the sweep", async () => {
    const db = makeDb(["thread-A"]);

    await runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner });

    expect(mockReapStaleThreadAgentActions).toHaveBeenCalledTimes(1);
    expect(mockReapStaleThreadAgentActions).toHaveBeenCalledWith(db);
  });

  it("4b: GCs orphaned unsealed `proposed` rows once at the start of the sweep", async () => {
    const db = makeDb(["thread-A"]);

    await runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner });

    expect(mockGcOrphanedProposedActions).toHaveBeenCalledTimes(1);
    expect(mockGcOrphanedProposedActions).toHaveBeenCalledWith(db);
  });

  it("4c: a GC failure does not abort the sweep — pending threads still drain", async () => {
    const db = makeDb(["thread-A"]);
    mockGcOrphanedProposedActions.mockRejectedValueOnce(new Error("gc db error"));

    await expect(
      runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner }),
    ).resolves.toBeUndefined();

    expect(mockRunController).toHaveBeenCalledTimes(1);
  });

  it("5: a reaper failure does not abort the sweep — pending threads still drain", async () => {
    const db = makeDb(["thread-A"]);
    mockReapStaleThreadAgentActions.mockRejectedValueOnce(new Error("reaper db error"));

    await expect(
      runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner }),
    ).resolves.toBeUndefined();

    // The reaper threw but the sweep continued and still drove the pending thread.
    expect(mockRunController).toHaveBeenCalledTimes(1);
    expect(mockRunController).toHaveBeenCalledWith("thread-A", { adjutantRunner: fakeAdjutantRunner });
  });

  it("6: reaps even when there are no pending threads", async () => {
    const db = makeDb([]);

    await runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner });

    expect(mockReapStaleThreadAgentActions).toHaveBeenCalledTimes(1);
    expect(mockRunController).not.toHaveBeenCalled();
  });

  it("1: calls runController once per pending thread with the injected adjutantRunner", async () => {
    const db = makeDb(["thread-A", "thread-B"]);

    await runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner });

    expect(mockRunController).toHaveBeenCalledTimes(2);
    expect(mockRunController).toHaveBeenCalledWith("thread-A", { adjutantRunner: fakeAdjutantRunner });
    expect(mockRunController).toHaveBeenCalledWith("thread-B", { adjutantRunner: fakeAdjutantRunner });
  });

  it("2: no pending threads → runController NOT called", async () => {
    const db = makeDb([]);

    await runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner });

    expect(mockRunController).not.toHaveBeenCalled();
  });

  it("3: a runController rejection for one thread does not abort the others", async () => {
    const db = makeDb(["thread-bad", "thread-good"]);

    mockRunController
      .mockRejectedValueOnce(new Error("db connection lost"))
      .mockResolvedValueOnce({ ran: true, suppressed: false, startEpoch: 1, cursorAdvancedTo: "entry-9" });

    // Must not throw
    await expect(
      runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner }),
    ).resolves.toBeUndefined();

    // Both threads were attempted
    expect(mockRunController).toHaveBeenCalledTimes(2);
    expect(mockRunController).toHaveBeenCalledWith("thread-bad", { adjutantRunner: fakeAdjutantRunner });
    expect(mockRunController).toHaveBeenCalledWith("thread-good", { adjutantRunner: fakeAdjutantRunner });
  });

  // ── Codex P2 #B + P1: gated backstop action drain ───────────────────────────
  it("7: drains pending thread actions per thread when runController reports no-entries (claim owned)", async () => {
    mockRunController.mockResolvedValue({ ran: false, reason: "no-entries" });
    const db = makeDb(["thread-A", "thread-B"]);

    await runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner });

    // The action commit is invoked once per pending thread that this sweep CLAIMED and
    // found no entries for (the runController commit was short-circuited).
    expect(mockCommitThreadAgentActions).toHaveBeenCalledTimes(2);
    expect(mockCommitThreadAgentActions).toHaveBeenCalledWith({ companyId: "company-1", threadId: "thread-A" });
    expect(mockCommitThreadAgentActions).toHaveBeenCalledWith({ companyId: "company-1", threadId: "thread-B" });
  });

  it("8: re-arms pendingRun (update) when the drain leaves retryable work", async () => {
    mockRunController.mockResolvedValue({ ran: false, reason: "no-entries" });
    const db = makeDb(["thread-A"]);
    mockCommitThreadAgentActions.mockResolvedValueOnce({ committed: 1, suppressed: 0, blocked: 0, failed: 1, lostRace: 0 });

    await runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner });

    expect(db.update).toHaveBeenCalledTimes(1); // pendingRun re-armed so the next sweep retries
  });

  it("9: does NOT re-arm pendingRun when the drain leaves nothing retryable", async () => {
    mockRunController.mockResolvedValue({ ran: false, reason: "no-entries" });
    const db = makeDb(["thread-A"]);
    // default commit mock: all-zero result → no leftover.

    await runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner });

    expect(db.update).not.toHaveBeenCalled();
  });

  it("10: a drain failure for one thread does not abort the others", async () => {
    mockRunController.mockResolvedValue({ ran: false, reason: "no-entries" });
    const db = makeDb(["thread-bad", "thread-good"]);
    mockCommitThreadAgentActions
      .mockRejectedValueOnce(new Error("drain db error"))
      .mockResolvedValueOnce({ committed: 0, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });

    await expect(
      runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner }),
    ).resolves.toBeUndefined();

    expect(mockCommitThreadAgentActions).toHaveBeenCalledTimes(2);
  });

  it("11 (P1): does NOT drain when the claim was lost (reason no-pending) — avoids racing the owning inline run", async () => {
    // runController returns "no-pending" when another executor won the atomic claim and is
    // actively running this thread. The sweep must NOT commit that owner's queued-but-
    // uncommitted actions thread-scoped — that would race its freshness/epoch gate.
    mockRunController.mockResolvedValue({ ran: false, reason: "no-pending" });
    const db = makeDb(["thread-A"]);

    await runControllerSweep(db as any, { adjutantRunner: fakeAdjutantRunner });

    expect(mockCommitThreadAgentActions).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});
