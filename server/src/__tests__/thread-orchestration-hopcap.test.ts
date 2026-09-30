/**
 * P1-T5 — Hop-cap loop guard: incrementHop + atCap signal + human-entry reset.
 *
 * Tests:
 *   1. incrementHop increases hopCount by 1 and returns the new value.
 *   2. atCap is false below HOP_CAP and true at / above HOP_CAP.
 *   3. Reset interaction: increment near the cap → triggerOnHumanEntry resets
 *      hopCount to 0 → subsequent incrementHop returns atCap: false.
 *
 * Uses the Proxy-table-stub + in-memory state pattern from
 * thread-orchestration-kill.test.ts (no live DB, no embedded-postgres).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  and: vi.fn((...args: unknown[]) => ({ _op: "and", args })),
  gt: vi.fn((a: unknown, b: unknown) => ({ _op: "gt", a, b })),
  asc: vi.fn((col: unknown) => ({ _op: "asc", col })),
  isNull: vi.fn((col: unknown) => ({ _op: "isNull", col })),
  or: vi.fn((...args: unknown[]) => ({ _op: "or", args })),
  desc: vi.fn((col: unknown) => ({ _op: "desc", col })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ _op: "inArray", col, vals })),
  isNotNull: vi.fn((col: unknown) => ({ _op: "isNotNull", col })),
  sql: Object.assign(
    vi.fn((_s: unknown) => {
      const tag: {
        as: ReturnType<typeof vi.fn>;
        mapWith: ReturnType<typeof vi.fn>;
        toString: () => string;
      } = {
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
}));

// ── @armyofagents/db mock ─────────────────────────────────────────────────────
function tableProxy(name: string) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        return `${name}.${String(prop)}`;
      },
    },
  );
}

vi.mock("@armyofagents/db", () => ({
  threadOrchestrationState: tableProxy("tos"),
  discussionEntries: tableProxy("de"),
  discussions: tableProxy("discussions"),
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

// ── Imports (after all mocks) ─────────────────────────────────────────────────
import { threadOrchestrationService, HOP_CAP } from "../services/thread-orchestration.js";

// =============================================================================
// In-memory state model
// =============================================================================

interface ControllerState {
  threadId: string;
  runEpoch: number;
  pendingRun: boolean;
  hopCount: number;
  lastProcessedEntryId: string | null;
  lastError: string | null;
}

/**
 * Build an in-memory DB mock that supports the operations used by
 * `incrementHop` and `triggerOnHumanEntry`:
 *
 *   insert()…onConflictDoNothing()…returning()   — ensureController
 *   update()…set(payload)…where()…returning()    — increment / trigger
 *
 * The `set()` payload is applied to the in-memory controller so that
 * hopCount mutations are observable without a real DB.
 *
 * The `sql` mock (used for atomic increment expressions) returns an object
 * whose toString is "sql_expr". We detect it by checking whether the value
 * is an object (not a plain number), and we perform the actual numeric
 * increment in the mock's `set()` handler.
 */
function makeHopDb(controller: ControllerState) {
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => []), // conflict → no row returned
        })),
      })),
    })),

    update: vi.fn(() => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        // Apply primitive fields immediately.
        if ("pendingRun" in payload) {
          controller.pendingRun = payload.pendingRun as boolean;
        }
        if ("hopCount" in payload) {
          const val = payload.hopCount;
          if (typeof val === "number") {
            // Direct assignment (e.g. hopCount: 0 in triggerOnHumanEntry)
            controller.hopCount = val;
          } else {
            // SQL expression object from `sql\`hopCount + 1\`` — perform the
            // actual increment in the mock.
            controller.hopCount += 1;
          }
        }
        if ("updatedAt" in payload) {
          // ignore — not tracked in ControllerState
        }
        if ("runEpoch" in payload) {
          const val = payload.runEpoch;
          if (typeof val === "number") {
            controller.runEpoch = val;
          } else {
            // SQL expression object for epoch increment
            controller.runEpoch += 1;
          }
        }

        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => [{ ...controller }]),
          })),
        };
      }),
    })),
  };

  return db as unknown as Parameters<typeof threadOrchestrationService>[0];
}

// =============================================================================
// Tests
// =============================================================================

describe("HOP_CAP constant", () => {
  it("is exported and equals 5", () => {
    expect(HOP_CAP).toBe(5);
  });
});

describe("threadOrchestrationService.incrementHop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increases hopCount by 1 and returns the new value", async () => {
    const controller: ControllerState = {
      threadId: "t-hop-1",
      runEpoch: 0,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const db = makeHopDb(controller);
    const svc = threadOrchestrationService(db);

    const result = await svc.incrementHop("t-hop-1");

    expect(result.hopCount).toBe(1);
    expect(controller.hopCount).toBe(1);
  });

  it("increments hopCount correctly on multiple sequential calls", async () => {
    const controller: ControllerState = {
      threadId: "t-hop-seq",
      runEpoch: 0,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const db = makeHopDb(controller);
    const svc = threadOrchestrationService(db);

    for (let i = 1; i <= 3; i++) {
      const result = await svc.incrementHop("t-hop-seq");
      expect(result.hopCount).toBe(i);
    }
    expect(controller.hopCount).toBe(3);
  });

  it("atCap is false when hopCount is below HOP_CAP", async () => {
    const controller: ControllerState = {
      threadId: "t-hop-below",
      runEpoch: 0,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const db = makeHopDb(controller);
    const svc = threadOrchestrationService(db);

    for (let i = 1; i < HOP_CAP; i++) {
      const result = await svc.incrementHop("t-hop-below");
      expect(result.atCap).toBe(false);
    }
  });

  it("atCap is true when hopCount reaches HOP_CAP", async () => {
    const controller: ControllerState = {
      threadId: "t-hop-at-cap",
      runEpoch: 0,
      pendingRun: false,
      hopCount: HOP_CAP - 1, // one away from cap
      lastProcessedEntryId: null,
      lastError: null,
    };
    const db = makeHopDb(controller);
    const svc = threadOrchestrationService(db);

    const result = await svc.incrementHop("t-hop-at-cap");

    expect(result.hopCount).toBe(HOP_CAP);
    expect(result.atCap).toBe(true);
  });

  it("atCap is true when hopCount exceeds HOP_CAP", async () => {
    const controller: ControllerState = {
      threadId: "t-hop-over-cap",
      runEpoch: 0,
      pendingRun: false,
      hopCount: HOP_CAP, // already at cap
      lastProcessedEntryId: null,
      lastError: null,
    };
    const db = makeHopDb(controller);
    const svc = threadOrchestrationService(db);

    const result = await svc.incrementHop("t-hop-over-cap");

    expect(result.hopCount).toBe(HOP_CAP + 1);
    expect(result.atCap).toBe(true);
  });
});

// =============================================================================
// Reset interaction: human entry resets the hop budget
// =============================================================================

describe("hop-cap reset interaction — triggerOnHumanEntry renews agent-round budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hopCount resets to 0 after triggerOnHumanEntry, and a subsequent incrementHop returns atCap: false", async () => {
    const controller: ControllerState = {
      threadId: "t-hop-reset",
      runEpoch: 0,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const db = makeHopDb(controller);
    const svc = threadOrchestrationService(db);

    // ── Phase 1: increment up to near the cap ───────────────────────────────
    const callsBeforeReset = HOP_CAP - 1; // e.g. 4 hops → hopCount = 4
    for (let i = 0; i < callsBeforeReset; i++) {
      await svc.incrementHop("t-hop-reset");
    }
    expect(controller.hopCount).toBe(callsBeforeReset);

    // ── Phase 2: human entry resets hopCount ────────────────────────────────
    await svc.triggerOnHumanEntry("t-hop-reset");

    expect(controller.hopCount).toBe(0);

    // ── Phase 3: first hop after reset is well below cap ────────────────────
    const afterReset = await svc.incrementHop("t-hop-reset");

    expect(afterReset.hopCount).toBe(1);
    expect(afterReset.atCap).toBe(false);
  });

  it("the full cap cycle works end-to-end: reach cap → reset → reach cap again", async () => {
    const controller: ControllerState = {
      threadId: "t-hop-full-cycle",
      runEpoch: 0,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const db = makeHopDb(controller);
    const svc = threadOrchestrationService(db);

    // First cycle: advance to cap
    for (let i = 0; i < HOP_CAP; i++) {
      await svc.incrementHop("t-hop-full-cycle");
    }
    expect(controller.hopCount).toBe(HOP_CAP);

    // Human entry resets
    await svc.triggerOnHumanEntry("t-hop-full-cycle");
    expect(controller.hopCount).toBe(0);

    // Second cycle: advance to cap again — proves the budget is truly renewed
    let lastResult: { hopCount: number; atCap: boolean } | undefined;
    for (let i = 0; i < HOP_CAP; i++) {
      lastResult = await svc.incrementHop("t-hop-full-cycle");
    }

    expect(lastResult?.hopCount).toBe(HOP_CAP);
    expect(lastResult?.atCap).toBe(true);
    expect(controller.hopCount).toBe(HOP_CAP);
  });
});
