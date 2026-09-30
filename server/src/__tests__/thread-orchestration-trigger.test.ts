/**
 * P1-T3 — Thread orchestration controller: create + human-entry trigger.
 *
 * Tests:
 *   1. ensureController is idempotent (onConflictDoNothing → exactly one row).
 *   2. triggerOnHumanEntry sets pendingRun=true, increments runEpoch, resets hopCount=0.
 *   3. Burst of N calls → runEpoch advances each time, pendingRun stays true.
 *   4. Agent/system entries do NOT trigger the controller — the isHumanEntry
 *      filter in thread-events.ts excludes them.
 *
 * Uses the Proxy-table-stub + sequence-db mock pattern (no live DB).
 * See issues-source-discussion-persist.test.ts for the mock pattern reference.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
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

// ── controller-adjutant-runner mock ──────────────────────────────────────────
// thread-events.ts now imports makeControllerAdjutantRunner. Mock it to prevent
// the transitive chain (runner → embeddings → memoryItems) from being resolved
// against the partial @armyofagents/db mock above.
vi.mock("../services/internal-agent/aoa-agents/controller-adjutant-runner.js", () => ({
  makeControllerAdjutantRunner: vi.fn(() =>
    vi.fn().mockResolvedValue({ output: null }),
  ),
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { threadOrchestrationService } from "../services/thread-orchestration.js";
import {
  isHumanEntry,
  type EntryCreatedEvent,
} from "../services/thread-events.js";

// ─────────────────────────────────────────────────────────────────────────────
// DB builder helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal stub db that:
 *  - tracks whether onConflictDoNothing was called (idempotency check)
 *  - captures the last set() payload sent to update()
 *  - allows configuring the row returned from update().returning()
 */
function makeOrchestrationDb(opts: {
  /** Rows returned from insert().returning() — default [] to simulate conflict */
  insertReturns?: Record<string, unknown>[];
  /** Row returned from update().returning() */
  updateReturns?: Record<string, unknown>[];
} = {}) {
  const {
    insertReturns = [],
    updateReturns = [{ threadId: "t1", pendingRun: true, runEpoch: 1, hopCount: 0, updatedAt: new Date() }],
  } = opts;

  const calls = {
    insertCount: 0,
    onConflictDoNothingCount: 0,
    updateCount: 0,
    lastSetPayload: null as Record<string, unknown> | null,
  };

  const onConflictDoNothingMock = vi.fn(() => ({
    returning: vi.fn().mockResolvedValue(insertReturns),
  }));
  calls.onConflictDoNothingCount; // reference to avoid unused warning

  const db: Record<string, ReturnType<typeof vi.fn>> = {
    insert: vi.fn(() => ({
      values: vi.fn(() => {
        calls.insertCount++;
        return {
          onConflictDoNothing: () => {
            calls.onConflictDoNothingCount++;
            return {
              returning: vi.fn().mockResolvedValue(insertReturns),
            };
          },
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        calls.lastSetPayload = payload;
        calls.updateCount++;
        return {
          where: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue(updateReturns),
        };
      }),
    })),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;

  return { db: db as unknown as Parameters<typeof threadOrchestrationService>[0], calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: ensureController
// ─────────────────────────────────────────────────────────────────────────────

describe("threadOrchestrationService.ensureController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a new row and returns it on first call", async () => {
    const fakeRow = { id: "ctl-1", threadId: "t1", runEpoch: 0, pendingRun: false, hopCount: 0 };
    const { db } = makeOrchestrationDb({ insertReturns: [fakeRow] });
    const svc = threadOrchestrationService(db);

    const result = await svc.ensureController("t1");

    expect(result).toMatchObject({ id: "ctl-1", threadId: "t1" });
  });

  it("is idempotent — second call with existing row returns null (no duplicate insert)", async () => {
    // Simulate conflict: insert returns [] (onConflictDoNothing suppressed)
    const { db, calls } = makeOrchestrationDb({ insertReturns: [] });
    const svc = threadOrchestrationService(db);

    // First call — row "exists" already (returns empty meaning conflict)
    const first = await svc.ensureController("t1");
    // Second call — same result
    const second = await svc.ensureController("t1");

    // Both calls went through onConflictDoNothing — no error, no duplicate
    expect(first).toBeNull();
    expect(second).toBeNull();
    // insert was called twice (once each call), but with conflict suppression
    expect(calls.insertCount).toBe(2);
    // onConflictDoNothingCount is also 2 — the conflict path was exercised
    expect(calls.onConflictDoNothingCount).toBe(2);
  });

  it("calls insert with the correct threadId", async () => {
    const { db } = makeOrchestrationDb({ insertReturns: [] });
    const insertMock = db.insert as ReturnType<typeof vi.fn>;
    const svc = threadOrchestrationService(db);

    await svc.ensureController("thread-abc");

    // insert was called with the threadOrchestrationState table proxy
    expect(insertMock).toHaveBeenCalledTimes(1);
    // The values() call receives { threadId: "thread-abc" }
    const valuesFn = insertMock.mock.results[0].value.values as ReturnType<typeof vi.fn>;
    expect(valuesFn).toHaveBeenCalledWith({ threadId: "thread-abc" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: triggerOnHumanEntry
// ─────────────────────────────────────────────────────────────────────────────

describe("threadOrchestrationService.triggerOnHumanEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets pendingRun=true in the update payload", async () => {
    const { db, calls } = makeOrchestrationDb({
      insertReturns: [],
      updateReturns: [{ threadId: "t1", pendingRun: true, runEpoch: 1, hopCount: 0 }],
    });
    const svc = threadOrchestrationService(db);

    await svc.triggerOnHumanEntry("t1");

    expect(calls.lastSetPayload).toMatchObject({ pendingRun: true });
  });

  it("resets hopCount to 0 in the update payload", async () => {
    const { db, calls } = makeOrchestrationDb({
      insertReturns: [],
      updateReturns: [{ threadId: "t1", pendingRun: true, runEpoch: 1, hopCount: 0 }],
    });
    const svc = threadOrchestrationService(db);

    await svc.triggerOnHumanEntry("t1");

    expect(calls.lastSetPayload).toMatchObject({ hopCount: 0 });
  });

  it("includes a runEpoch SQL increment expression in the update payload", async () => {
    const { db, calls } = makeOrchestrationDb({
      insertReturns: [],
      updateReturns: [{ threadId: "t1", pendingRun: true, runEpoch: 3, hopCount: 0 }],
    });
    const svc = threadOrchestrationService(db);

    await svc.triggerOnHumanEntry("t1");

    // The runEpoch field must be present and must be an sql() expression (not a plain number)
    // We check it is not a primitive integer — it should be the mocked sql tag object
    const runEpochVal = calls.lastSetPayload?.runEpoch;
    expect(runEpochVal).toBeDefined();
    // The drizzle-orm sql mock returns an object with toString = "sql_expr"
    expect(typeof runEpochVal).not.toBe("number");
    expect(String(runEpochVal)).toBe("sql_expr");
  });

  it("includes an updatedAt Date in the update payload", async () => {
    const { db, calls } = makeOrchestrationDb({ insertReturns: [] });
    const svc = threadOrchestrationService(db);

    const before = Date.now();
    await svc.triggerOnHumanEntry("t1");
    const after = Date.now();

    const updatedAt = calls.lastSetPayload?.updatedAt as Date | undefined;
    expect(updatedAt).toBeInstanceOf(Date);
    expect(updatedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(updatedAt!.getTime()).toBeLessThanOrEqual(after);
  });

  it("calls ensureController (insert) first so the row is guaranteed to exist", async () => {
    const { db, calls } = makeOrchestrationDb({ insertReturns: [] });
    const svc = threadOrchestrationService(db);

    await svc.triggerOnHumanEntry("t1");

    // ensureController fires an insert; updateCount only counts the update
    expect(calls.insertCount).toBeGreaterThanOrEqual(1);
    expect(calls.updateCount).toBeGreaterThanOrEqual(1);
  });

  it("returns the updated row", async () => {
    const fakeRow = { threadId: "t1", pendingRun: true, runEpoch: 5, hopCount: 0 };
    const { db } = makeOrchestrationDb({ insertReturns: [], updateReturns: [fakeRow] });
    const svc = threadOrchestrationService(db);

    const result = await svc.triggerOnHumanEntry("t1");

    expect(result).toMatchObject({ threadId: "t1", pendingRun: true, runEpoch: 5, hopCount: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: burst of N calls → runEpoch advances each time
// ─────────────────────────────────────────────────────────────────────────────

describe("triggerOnHumanEntry — burst", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls update N times for N burst triggers (each increments runEpoch via SQL)", async () => {
    const N = 5;
    const { db, calls } = makeOrchestrationDb({ insertReturns: [] });
    const svc = threadOrchestrationService(db);

    for (let i = 0; i < N; i++) {
      await svc.triggerOnHumanEntry("t-burst");
    }

    // Each call issues one update (plus its own ensureController insert)
    expect(calls.updateCount).toBe(N);
    // Every update includes pendingRun: true (stays true through the burst)
    expect(calls.lastSetPayload).toMatchObject({ pendingRun: true });
  });

  it("pendingRun is true on every trigger in a burst", async () => {
    const { db } = makeOrchestrationDb({ insertReturns: [] });
    const svc = threadOrchestrationService(db);
    const updateMock = db.update as ReturnType<typeof vi.fn>;

    await svc.triggerOnHumanEntry("t-burst");
    await svc.triggerOnHumanEntry("t-burst");
    await svc.triggerOnHumanEntry("t-burst");

    // Collect all set() payloads
    const setPayloads = updateMock.mock.results.map(
      (r) => (r.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0]?.[0] as Record<string, unknown>,
    ).filter(Boolean);

    for (const p of setPayloads) {
      expect(p).toMatchObject({ pendingRun: true, hopCount: 0 });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: isHumanEntry filter — agent/system entries must NOT trigger controller
//
// These tests directly exercise the exported `isHumanEntry` function from
// thread-events.ts to verify the filter is correctly applied. Because
// triggerOnHumanEntry is called INSIDE fireAdjutantWakeup (which only runs
// when isHumanEntry passed), agent/system entries are double-gated:
//   1. isHumanEntry returns false → onEntryCreated returns early.
//   2. If somehow the debounce fired, the check in fireAdjutantWakeup gates it.
// ─────────────────────────────────────────────────────────────────────────────

describe("isHumanEntry filter — agent and system entries are excluded", () => {
  const base: Omit<EntryCreatedEvent, "inputType" | "authorAgentId"> = {
    id: "entry-1",
    discussionId: "thread-1",
    createdBy: "user-1",
  };

  // Human entries that SHOULD trigger
  const humanInputTypes = ["paste", "write", "voice", "mcp", "transcript", "webhook"];
  for (const inputType of humanInputTypes) {
    it(`returns true for human inputType '${inputType}'`, () => {
      const event: EntryCreatedEvent = { ...base, inputType, authorAgentId: null };
      expect(isHumanEntry(event)).toBe(true);
    });
  }

  // Non-human entries that must NOT trigger
  it("returns false when authorAgentId is non-null (agent-authored)", () => {
    const event: EntryCreatedEvent = {
      ...base,
      inputType: "agent",
      authorAgentId: "agent-uuid-1",
    };
    expect(isHumanEntry(event)).toBe(false);
  });

  it("returns false for inputType 'agent' even when authorAgentId is null", () => {
    const event: EntryCreatedEvent = { ...base, inputType: "agent", authorAgentId: null };
    expect(isHumanEntry(event)).toBe(false);
  });

  it("returns false for inputType 'system'", () => {
    const event: EntryCreatedEvent = { ...base, inputType: "system", authorAgentId: null };
    expect(isHumanEntry(event)).toBe(false);
  });

  it("returns false for inputType 'scope_proposal'", () => {
    const event: EntryCreatedEvent = {
      ...base,
      inputType: "scope_proposal",
      authorAgentId: null,
    };
    expect(isHumanEntry(event)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: thread-events wiring contract (source-level check)
//
// Verify that thread-events.ts calls triggerOnHumanEntry in its fire path and
// still preserves the peer-wake insert.
// ─────────────────────────────────────────────────────────────────────────────

describe("thread-events.ts source contract — triggerOnHumanEntry is wired alongside peer-wake", () => {
  const src = readFileSync(
    resolve(import.meta.dirname ?? __dirname, "../services/thread-events.ts"),
    "utf8",
  );

  it("imports threadOrchestrationService", () => {
    expect(src).toMatch(/threadOrchestrationService/);
  });

  it("calls triggerOnHumanEntry in the fire path", () => {
    expect(src).toMatch(/triggerOnHumanEntry\(/);
  });

  it("still inserts agentWakeupRequests (peer-wake not removed)", () => {
    expect(src).toMatch(/agentWakeupRequests/);
    expect(src).toMatch(/\.insert\(agentWakeupRequests\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: discussions.ts wiring contract (source-level check)
//
// Verify ensureController is called from the discussion CREATE path.
// ─────────────────────────────────────────────────────────────────────────────

describe("discussions.ts source contract — ensureController called on thread create", () => {
  const src = readFileSync(
    resolve(import.meta.dirname ?? __dirname, "../services/discussions.ts"),
    "utf8",
  );

  it("imports threadOrchestrationService", () => {
    expect(src).toMatch(/threadOrchestrationService/);
  });

  it("calls ensureController in the create path", () => {
    expect(src).toMatch(/ensureController\(/);
  });
});
