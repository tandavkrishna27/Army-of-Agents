/**
 * Task 3.2 — gate the PROACTIVE Adjutant wake at Assist (Manual = no proactive).
 *
 * The dial IS the chat experience:
 *   - Manual (0) → an agent answers ONLY when directly @mentioned. There is NO
 *     proactive jumping-in. So the ambient-chatter debounce that wakes the
 *     Adjutant must be SUPPRESSED at Manual.
 *   - Assist (1) / Drive (2) → agents proactively converse, so the proactive wake
 *     proceeds exactly as it does today.
 *
 * `fireAdjutantWakeup` resolves the SAME effective dial the dispatcher and the
 * controller-adjutant-runner use: `effectiveAutonomy = thread.autonomyLevel ??
 * company.autonomyLevel` (internal_agent_config). When `effectiveAutonomy < 1`
 * it RETURNS EARLY — no `triggerOnHumanEntry` drive bookkeeping past the gate,
 * no `runController` inline drain, no peer-wake insert. At `>= 1` it proceeds.
 *
 * The DIRECT @mention path is unaffected (it never flows through this proactive
 * wake — see Task 3.1 / mention-always-answers.test.ts).
 *
 * Harness mirrors strangler-flag.test.ts / controller-inline-drain.test.ts:
 * mock thread-orchestration (triggerOnHumanEntry + runController spies), mock
 * controller-adjutant-runner, drive the real `createThreadEventListener` with
 * debounceMs=0.
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
  threadOrchestrationState: tableProxy("tos"),
  discussions: tableProxy("discussions"),
  discussionEntries: tableProxy("de"),
  agents: tableProxy("agents"),
  agentWakeupRequests: tableProxy("awr"),
  internalAgentConfig: tableProxy("iac"),
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

// ── threadOrchestrationService mock (triggerOnHumanEntry + runController) ──────
const mockTriggerOnHumanEntry = vi.fn().mockResolvedValue(undefined);
const mockRunController = vi
  .fn()
  .mockResolvedValue({ ran: true, suppressed: false, startEpoch: 1, cursorAdvancedTo: "entry-1" });

vi.mock("../services/thread-orchestration.js", () => ({
  threadOrchestrationService: vi.fn(() => ({
    triggerOnHumanEntry: mockTriggerOnHumanEntry,
    runController: mockRunController,
  })),
}));

// ── controller-adjutant-runner mock ──────────────────────────────────────────
const fakeRunner = vi.fn().mockResolvedValue({ output: { status: "succeeded" } });
vi.mock("../services/internal-agent/aoa-agents/controller-adjutant-runner.js", () => ({
  makeControllerAdjutantRunner: vi.fn(() => fakeRunner),
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────────
import { createThreadEventListener } from "../services/thread-events.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sequence DB. fireAdjutantWakeup selects, in order:
//   1. discussions (thread row: companyId, crewPaused, adjutantEnabled,
//                   useControllerPath, autonomyLevel)
//   2. internal_agent_config (companyCfg: autonomyLevel)  — ONLY when
//      thread.autonomyLevel is null (mirrors the dispatcher's fallback resolution)
//   3. agents (Adjutant)                                  — ONLY when the dial gate passes
// then conditionally inserts a peer-wake row.
// ─────────────────────────────────────────────────────────────────────────────
function makeFireDb(selectResults: Array<Array<Record<string, unknown>>>): {
  db: any;
  insertMock: ReturnType<typeof vi.fn>;
} {
  let selectCallCount = 0;
  const insertMock = vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    })),
  }));

  const db = {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      limit: vi.fn(() => {
        const result = selectResults[selectCallCount] ?? [];
        selectCallCount++;
        return Promise.resolve(result);
      }),
    })),
    insert: insertMock,
  };

  return { db, insertMock };
}

async function fireWithDebounce0(db: any, discussionId = "thread-1"): Promise<void> {
  const listener = createThreadEventListener(db as never, { debounceMs: 0 });
  await listener.onEntryCreated({
    id: "entry-1",
    discussionId,
    authorAgentId: null,
    inputType: "paste",
    createdBy: "user-1",
    // ambient human chatter (no crew @mention) — this is the proactive signal.
    hasCrewMention: false,
  });
  // debounceMs=0 → timer fires on the macrotask queue. Flush it + microtasks.
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  listener.shutdown();
}

const ADJUTANT_ROW = [{ id: "adjutant-agent-1" }];

function threadRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "thread-1",
    companyId: "company-1",
    crewPaused: false,
    adjutantEnabled: true,
    useControllerPath: true,
    autonomyLevel: null,
    ...overrides,
  };
}

describe("Task 3.2 — proactive Adjutant wake is gated at Assist (>= 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunController.mockResolvedValue({ ran: true, suppressed: false, startEpoch: 1, cursorAdvancedTo: "entry-1" });
  });

  // ── Manual (0) suppresses the proactive wake ────────────────────────────────

  it("Manual via thread-level dial (autonomyLevel=0): RETURNS EARLY — no runController, no peer-wake", async () => {
    const { db, insertMock } = makeFireDb([
      [threadRow({ autonomyLevel: 0 })], // thread row, dial pinned Manual at thread level
      // no companyCfg select (thread.autonomyLevel != null)
      // no agents select (we return before it)
    ]);

    await fireWithDebounce0(db);

    expect(mockRunController).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("Manual via company fallback (thread autonomyLevel=null, company=0): RETURNS EARLY", async () => {
    const { db, insertMock } = makeFireDb([
      [threadRow({ autonomyLevel: null })], // thread row, no thread-level override
      [{ autonomyLevel: 0 }], // companyCfg → Manual
    ]);

    await fireWithDebounce0(db);

    expect(mockRunController).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("Manual on a LEGACY (non-controller) thread also suppresses the peer-wake insert", async () => {
    const { db, insertMock } = makeFireDb([
      [threadRow({ useControllerPath: false, autonomyLevel: 0 })],
    ]);

    await fireWithDebounce0(db);

    // The gate is before BOTH the controller drain and the legacy peer-wake insert.
    expect(insertMock).not.toHaveBeenCalled();
    expect(mockRunController).not.toHaveBeenCalled();
  });

  // ── Assist (1) / Drive (2) proceed exactly as today ─────────────────────────

  it("Assist via thread-level dial (autonomyLevel=1): proceeds — controller drain fires", async () => {
    const { db, insertMock } = makeFireDb([
      [threadRow({ autonomyLevel: 1 })], // thread row, Assist
      ADJUTANT_ROW, // agents (Adjutant)
    ]);

    await fireWithDebounce0(db);
    // give the void runController promise time to resolve
    await new Promise<void>((r) => setTimeout(r, 25));

    expect(mockRunController).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({ adjutantRunner: fakeRunner }),
    );
    // controller-path thread → peer-wake insert stays dormant
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("Assist via company fallback (thread autonomyLevel=null, company=1): proceeds", async () => {
    const { db } = makeFireDb([
      [threadRow({ autonomyLevel: null })], // thread row, no override
      [{ autonomyLevel: 1 }], // companyCfg → Assist
      ADJUTANT_ROW, // agents (Adjutant)
    ]);

    await fireWithDebounce0(db);
    await new Promise<void>((r) => setTimeout(r, 25));

    expect(mockRunController).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({ adjutantRunner: fakeRunner }),
    );
  });

  it("Drive (autonomyLevel=2): proceeds — controller drain fires", async () => {
    const { db } = makeFireDb([
      [threadRow({ autonomyLevel: 2 })], // thread row, Drive
      ADJUTANT_ROW, // agents (Adjutant)
    ]);

    await fireWithDebounce0(db);
    await new Promise<void>((r) => setTimeout(r, 25));

    expect(mockRunController).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({ adjutantRunner: fakeRunner }),
    );
  });

  it("Assist on a LEGACY thread (autonomyLevel=1, useControllerPath=false): peer-wake insert fires", async () => {
    const { db, insertMock } = makeFireDb([
      [threadRow({ useControllerPath: false, autonomyLevel: 1 })],
      ADJUTANT_ROW, // agents (Adjutant)
    ]);

    await fireWithDebounce0(db);
    await new Promise<void>((r) => setTimeout(r, 25));

    expect(insertMock).toHaveBeenCalled();
    expect(mockRunController).not.toHaveBeenCalled();
  });
});
