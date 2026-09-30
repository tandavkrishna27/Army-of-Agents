/**
 * P1-T11 — Per-thread strangler flag.
 *
 * Verifies that `useControllerPath = true` gates the peer-wake pipeline while
 * keeping the controller-path trigger active, and that old threads
 * (`useControllerPath = false`) remain on the peer-wake path unchanged.
 *
 * Tests:
 *   A. controller-path thread: triggerOnHumanEntry fires, peer-wake insert does NOT fire
 *   B. non-controller-path thread: peer-wake insert DOES fire
 *   C. discussions.create source contract: useControllerPath=true is in the insert payload
 *   D. no double-drive: triggerOnHumanEntry called exactly once for a controller-path thread
 *
 * Uses the Proxy-table-stub + sequence-db mock pattern.
 * Reference: thread-orchestration-trigger.test.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  sql: Object.assign(
    vi.fn((_s: unknown) => {
      const tag: { as: ReturnType<typeof vi.fn>; mapWith: ReturnType<typeof vi.fn>; toString: () => string } = {
        as: vi.fn().mockReturnThis(),
        mapWith: vi.fn().mockReturnThis(),
        toString: () => "sql_expr",
      };
      return tag;
    }),
    {
      raw: vi.fn((s: unknown) => s),
      placeholder: vi.fn((s: unknown) => s),
    },
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
  return new Proxy(
    {},
    {
      get(_t, prop) {
        return `${name}_${String(prop)}`;
      },
    },
  );
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

// ── threadOrchestrationService mock ──────────────────────────────────────────
// We need a stable reference that tests can inspect.
const mockTriggerOnHumanEntry = vi.fn().mockResolvedValue(undefined);
const mockEnsureController = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/thread-orchestration.js", () => ({
  threadOrchestrationService: vi.fn(() => ({
    triggerOnHumanEntry: mockTriggerOnHumanEntry,
    ensureController: mockEnsureController,
  })),
}));

// ── controller-adjutant-runner mock ──────────────────────────────────────────
// Thread-events.ts now imports makeControllerAdjutantRunner. Mock it to prevent
// the transitive chain (runner → embeddings → memoryItems) from being resolved
// against the partial @armyofagents/db mock above. The factory is never called
// in any of these tests (useControllerPath branches are verified via insertMock).
vi.mock("../services/internal-agent/aoa-agents/controller-adjutant-runner.js", () => ({
  makeControllerAdjutantRunner: vi.fn(() =>
    vi.fn().mockResolvedValue({ output: null }),
  ),
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────────
import { createThreadEventListener } from "../services/thread-events.js";

// ─────────────────────────────────────────────────────────────────────────────
// DB builder helpers
// ─────────────────────────────────────────────────────────────────────────────

type MinimalDb = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
};

/**
 * Build a stub db for thread-events.ts tests.
 *
 * The fireAdjutantWakeup function does two selects:
 *   1. discussions select — returns `threadRow`
 *   2. agents select — returns `adjutantRow`
 * Then conditionally does an insert into agentWakeupRequests.
 */
function makeFireDb(opts: {
  threadRow: Record<string, unknown>;
  adjutantRow?: Record<string, unknown> | null;
}): { db: MinimalDb; insertMock: ReturnType<typeof vi.fn> } {
  const { threadRow, adjutantRow = { id: "adjutant-agent-1" } } = opts;

  // Each select call returns the next item in the sequence.
  let selectCallCount = 0;
  const selectResults: Array<Array<Record<string, unknown>>> = [
    [threadRow],                                // first select → discussions
    adjutantRow ? [adjutantRow] : [],           // second select → agents
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

// ─────────────────────────────────────────────────────────────────────────────
// Helper: create a listener with debounceMs=0 and flush immediately
// ─────────────────────────────────────────────────────────────────────────────

async function fireWithThread(
  db: MinimalDb,
  threadFields: Record<string, unknown>,
): Promise<void> {
  const listener = createThreadEventListener(db as never, { debounceMs: 0 });

  await listener.onEntryCreated({
    id: "entry-1",
    discussionId: threadFields.id as string ?? "thread-1",
    authorAgentId: null,
    inputType: "paste",
    createdBy: "user-1",
  });

  // With debounceMs=0, the timer fires via setTimeout(fn, 0).
  // We use a small promise flush to let the macrotask queue drain.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  listener.shutdown();
}

// ─────────────────────────────────────────────────────────────────────────────
// Test A — controller-path thread: triggerOnHumanEntry fires, peer-wake does NOT
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-T11: strangler flag — controller-path thread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("A: triggerOnHumanEntry fires for a controller-path thread", async () => {
    const thread = {
      id: "thread-ctrl",
      companyId: "company-1",
      crewPaused: false,
      adjutantEnabled: true,
      useControllerPath: true,
      // Task 3.2: proactive wake is Assist+ only. This strangler test asserts the
      // controller drive fires, so the thread dial is Assist (1). autonomyLevel != null
      // ⇒ no internal_agent_config select (sequence stays thread → agents).
      autonomyLevel: 1,
    };

    const { db } = makeFireDb({ threadRow: thread });

    await fireWithThread(db, thread);

    expect(mockTriggerOnHumanEntry).toHaveBeenCalledWith("thread-ctrl");
  });

  it("A: peer-wake insert does NOT fire for a controller-path thread", async () => {
    const thread = {
      id: "thread-ctrl",
      companyId: "company-1",
      crewPaused: false,
      adjutantEnabled: true,
      useControllerPath: true,
      // Task 3.2: proactive wake is Assist+ only. This strangler test asserts the
      // controller drive fires, so the thread dial is Assist (1). autonomyLevel != null
      // ⇒ no internal_agent_config select (sequence stays thread → agents).
      autonomyLevel: 1,
    };

    const { db, insertMock } = makeFireDb({ threadRow: thread });

    await fireWithThread(db, thread);

    // The only insert allowed is if somehow triggerOnHumanEntry internally inserts —
    // but agentWakeupRequests insert (peer-wake) must NOT be called from fireAdjutantWakeup.
    // triggerOnHumanEntry is mocked to a no-op, so any remaining insert is the peer-wake one.
    // With useControllerPath=true, fireAdjutantWakeup returns before the insert.
    expect(insertMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test B — non-controller-path thread: peer-wake insert DOES fire
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-T11: strangler flag — non-controller-path thread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("B: peer-wake insert fires for a non-controller-path thread", async () => {
    const thread = {
      id: "thread-legacy",
      companyId: "company-1",
      crewPaused: false,
      adjutantEnabled: true,
      useControllerPath: false,
      // Task 3.2: Assist dial so the proactive wake proceeds to the peer-wake insert.
      autonomyLevel: 1,
    };

    const { db, insertMock } = makeFireDb({ threadRow: thread });

    await fireWithThread(db, thread);

    // For a legacy (non-controller-path) thread, the peer-wake insert must fire.
    expect(insertMock).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test C — discussions.create source contract: useControllerPath=true on insert
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-T11: strangler flag — discussions.create source contract", () => {
  const src = readFileSync(
    resolve(import.meta.dirname ?? __dirname, "../services/discussions.ts"),
    "utf8",
  );

  it("C: discussions.ts insert payload contains useControllerPath: true", () => {
    expect(src).toMatch(/useControllerPath\s*:\s*true/);
  });

  it("C: the useControllerPath assignment is in the create (insert) path", () => {
    // The insert into discussions must precede useControllerPath assignment —
    // check that the word "insert" appears before "useControllerPath" in source.
    const insertIdx = src.indexOf(".insert(discussions)");
    const flagIdx = src.indexOf("useControllerPath: true");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeGreaterThan(-1);
    // The flag assignment must appear after the insert call in the source file.
    expect(flagIdx).toBeGreaterThan(insertIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test D — no double-drive: triggerOnHumanEntry called exactly once
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-T11: strangler flag — no double-drive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("D: triggerOnHumanEntry is called exactly once (not zero, not twice) for a controller-path thread", async () => {
    const thread = {
      id: "thread-ctrl-once",
      companyId: "company-1",
      crewPaused: false,
      adjutantEnabled: true,
      useControllerPath: true,
      // Task 3.2: Assist dial so the proactive controller drive fires.
      autonomyLevel: 1,
    };

    const { db } = makeFireDb({ threadRow: thread });

    await fireWithThread(db, thread);

    expect(mockTriggerOnHumanEntry).toHaveBeenCalledTimes(1);
    expect(mockTriggerOnHumanEntry).toHaveBeenCalledWith("thread-ctrl-once");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bonus source contract: thread-events.ts has the useControllerPath gate
// ─────────────────────────────────────────────────────────────────────────────

describe("P1-T11: strangler flag — thread-events.ts source contract", () => {
  const src = readFileSync(
    resolve(import.meta.dirname ?? __dirname, "../services/thread-events.ts"),
    "utf8",
  );

  it("thread-events.ts has the useControllerPath guard before peer-wake insert", () => {
    expect(src).toMatch(/useControllerPath/);
    // Guard returns before agentWakeupRequests insert
    const guardIdx = src.indexOf("thread.useControllerPath");
    const insertIdx = src.indexOf(".insert(agentWakeupRequests)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    // Guard must appear before the peer-wake insert in source
    expect(guardIdx).toBeLessThan(insertIdx);
  });

  it("peer-wake insert is NOT deleted — still present for legacy threads", () => {
    expect(src).toMatch(/\.insert\(agentWakeupRequests\)/);
  });
});
