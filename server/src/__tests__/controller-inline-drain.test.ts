/**
 * controller-inline-drain — unit tests.
 *
 * Verifies the inline fire-and-forget drain wired into thread-events.ts (P2 prereq).
 *
 * Tests:
 *   A. useControllerPath=true: triggerOnHumanEntry fires AND runController fires
 *      (fire-and-forget), peer-wake insert does NOT fire.
 *   B. useControllerPath=false: runController is NOT fired, peer-wake insert DOES fire.
 *   C. runController rejection is swallowed (does not propagate to caller).
 *
 * Reuses the Proxy-table-stub + sequence-db + createThreadEventListener harness
 * from strangler-flag.test.ts. The key addition: mocking
 * controller-adjutant-runner.js so no real db queries happen inside the runner,
 * and extending the threadOrchestrationService mock with a runController spy.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  sql: Object.assign(
    vi.fn((_s: unknown) => ({
      as: vi.fn().mockReturnThis(),
      mapWith: vi.fn().mockReturnThis(),
      toString: () => "sql_expr",
    })),
    { raw: vi.fn((s: unknown) => s), placeholder: vi.fn((s: unknown) => s) },
  ),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
  isNotNull: vi.fn((col: unknown) => ({ isNotNull: col })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: [a, b] })),
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

// ── threadOrchestrationService mock (includes runController) ─────────────────
const mockTriggerOnHumanEntry = vi.fn().mockResolvedValue(undefined);
const mockRunController = vi.fn().mockResolvedValue({ ran: true, suppressed: false, startEpoch: 1, cursorAdvancedTo: "entry-1" });

vi.mock("../services/thread-orchestration.js", () => ({
  threadOrchestrationService: vi.fn(() => ({
    triggerOnHumanEntry: mockTriggerOnHumanEntry,
    runController: mockRunController,
  })),
}));

// ── controller-adjutant-runner mock — inject a no-op fake runner ──────────────
const fakeRunner = vi.fn().mockResolvedValue({ output: { status: "succeeded" } });

vi.mock(
  "../services/internal-agent/aoa-agents/controller-adjutant-runner.js",
  () => ({
    makeControllerAdjutantRunner: vi.fn(() => fakeRunner),
  }),
);

// ── Import AFTER mocks ────────────────────────────────────────────────────────
import { createThreadEventListener } from "../services/thread-events.js";

// ── DB builder helper (mirrors strangler-flag.test.ts makeFireDb) ─────────────

type MinimalDb = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
};

function makeFireDb(opts: {
  threadRow: Record<string, unknown>;
  adjutantRow?: Record<string, unknown> | null;
}): { db: MinimalDb; insertMock: ReturnType<typeof vi.fn> } {
  const { threadRow, adjutantRow = { id: "adjutant-agent-1" } } = opts;

  let selectCallCount = 0;
  const selectResults: Array<Array<Record<string, unknown>>> = [
    [threadRow],
    adjutantRow ? [adjutantRow] : [],
  ];

  const insertMock = vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    })),
  }));

  const db: MinimalDb = {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(() => {
        const result = selectResults[selectCallCount] ?? [];
        selectCallCount++;
        return Promise.resolve(result);
      }),
      innerJoin: vi.fn().mockReturnThis(),
    })),
    insert: insertMock,
  };

  return { db, insertMock };
}

// ── Helper: fire the wakeup with debounceMs=0 ─────────────────────────────────

async function fireWithThread(
  db: MinimalDb,
  threadFields: Record<string, unknown>,
): Promise<void> {
  const listener = createThreadEventListener(db as never, { debounceMs: 0 });

  await listener.onEntryCreated({
    id: "entry-1",
    discussionId: (threadFields.id as string) ?? "thread-1",
    authorAgentId: null,
    inputType: "paste",
    createdBy: "user-1",
  });

  // With debounceMs=0, the timer fires via setTimeout(fn, 0).
  // Flush both the macrotask (setTimeout) and any microtasks (Promise.resolve).
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  listener.shutdown();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("controller inline drain — useControllerPath=true", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunController.mockResolvedValue({ ran: true, suppressed: false, startEpoch: 1, cursorAdvancedTo: "entry-1" });
  });

  it("A1: triggerOnHumanEntry fires for a controller-path thread", async () => {
    const thread = {
      id: "thread-ctrl",
      companyId: "company-1",
      crewPaused: false,
      adjutantEnabled: true,
      useControllerPath: true,
      // Task 3.2: proactive wake is Assist+ only; this drain test asserts the
      // controller drive fires, so the dial is Assist (1). autonomyLevel != null
      // ⇒ no internal_agent_config select (sequence stays thread → agents).
      autonomyLevel: 1,
    };
    const { db } = makeFireDb({ threadRow: thread });

    await fireWithThread(db, thread);

    expect(mockTriggerOnHumanEntry).toHaveBeenCalledWith("thread-ctrl");
  });

  it("A2: runController fires (fire-and-forget) for a controller-path thread", async () => {
    const thread = {
      id: "thread-ctrl",
      companyId: "company-1",
      crewPaused: false,
      adjutantEnabled: true,
      useControllerPath: true,
      // Task 3.2: proactive wake is Assist+ only; this drain test asserts the
      // controller drive fires, so the dial is Assist (1). autonomyLevel != null
      // ⇒ no internal_agent_config select (sequence stays thread → agents).
      autonomyLevel: 1,
    };
    const { db } = makeFireDb({ threadRow: thread });

    await fireWithThread(db, thread);

    // Give the void promise time to resolve (debounce fires in macrotask queue)
    await new Promise<void>((r) => setTimeout(r, 30));

    expect(mockRunController).toHaveBeenCalledWith(
      "thread-ctrl",
      expect.objectContaining({ adjutantRunner: fakeRunner }),
    );
  });

  it("A3: peer-wake insert does NOT fire for a controller-path thread", async () => {
    const thread = {
      id: "thread-ctrl",
      companyId: "company-1",
      crewPaused: false,
      adjutantEnabled: true,
      useControllerPath: true,
      // Task 3.2: proactive wake is Assist+ only; this drain test asserts the
      // controller drive fires, so the dial is Assist (1). autonomyLevel != null
      // ⇒ no internal_agent_config select (sequence stays thread → agents).
      autonomyLevel: 1,
    };
    const { db, insertMock } = makeFireDb({ threadRow: thread });

    await fireWithThread(db, thread);

    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("controller inline drain — useControllerPath=false", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("B1: runController is NOT fired for a non-controller-path thread", async () => {
    const thread = {
      id: "thread-legacy",
      companyId: "company-1",
      crewPaused: false,
      adjutantEnabled: true,
      useControllerPath: false,
      // Task 3.2: Assist dial so the proactive wake proceeds (legacy peer-wake path).
      autonomyLevel: 1,
    };
    const { db } = makeFireDb({ threadRow: thread });

    await fireWithThread(db, thread);

    expect(mockRunController).not.toHaveBeenCalled();
  });

  it("B2: peer-wake insert DOES fire for a non-controller-path thread", async () => {
    const thread = {
      id: "thread-legacy",
      companyId: "company-1",
      crewPaused: false,
      adjutantEnabled: true,
      useControllerPath: false,
      // Task 3.2: Assist dial so the proactive wake proceeds (legacy peer-wake path).
      autonomyLevel: 1,
    };
    const { db, insertMock } = makeFireDb({ threadRow: thread });

    await fireWithThread(db, thread);

    expect(insertMock).toHaveBeenCalled();
  });
});

describe("controller inline drain — error resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("C: runController rejection is swallowed (does not propagate)", async () => {
    const thread = {
      id: "thread-ctrl-err",
      companyId: "company-err",
      crewPaused: false,
      adjutantEnabled: true,
      useControllerPath: true,
      // Task 3.2: Assist dial so the controller drive fires (and its rejection is swallowed).
      autonomyLevel: 1,
    };
    const { db } = makeFireDb({ threadRow: thread });

    // Make runController reject
    mockRunController.mockRejectedValueOnce(new Error("db down"));

    // fireWithThread must not throw
    await expect(fireWithThread(db, thread)).resolves.toBeUndefined();
  });
});
