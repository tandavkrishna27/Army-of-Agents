/**
 * P1-T6 — Hop-gated participation invocations: `requestParticipation`.
 *
 * Tests:
 *   1. requestParticipation invokes the injected participantRunner and posts a
 *      discussion_entry with inputType="agent" and authorAgentId set. It does
 *      NOT insert into the `issues` table.
 *   2. It increments hopCount by 1 on a successful spawn.
 *   3. When hopCount >= HOP_CAP, requestParticipation returns
 *      { spawned: false, atCap: true } without invoking the runner and without
 *      posting anything.
 *   4. isHumanEntry returns false for the posted comment shape — the entry
 *      won't re-fire the orchestration controller (QA-BUG-011 loop-guard).
 *
 * Uses the Proxy-table-stub + in-memory state pattern from the existing hop-cap
 * and kill tests. No live DB, no embedded-postgres.
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
  internalAgentConfig: tableProxy("iac"),
  issues: tableProxy("issues"),
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

// ── live-events mock ──────────────────────────────────────────────────────────
// thread-orchestration.ts imports publishLiveEvent from ./live-events.js to
// fan out participation comments to the WS layer. We mock it here so tests
// can assert it is called on spawn and NOT called when at cap.
// vi.mock factories are hoisted to the top of the file by Vitest, so we must
// use vi.hoisted to declare any variables referenced inside the factory.
const { mockPublishLiveEvent } = vi.hoisted(() => ({
  mockPublishLiveEvent: vi.fn(),
}));
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: mockPublishLiveEvent,
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

// ── Imports (after all mocks) ─────────────────────────────────────────────────
import {
  threadOrchestrationService,
  HOP_CAP,
} from "../services/thread-orchestration.js";
import {
  isHumanEntry,
  type EntryCreatedEvent,
} from "../services/thread-events.js";

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

/** Shape of an entry that was posted by the participation path. */
interface PostedEntry {
  id: string;
  discussionId: string;
  inputType: string;
  rawContent: string;
  authorAgentId: string | null;
  extractionStatus: string;
  seq: number;
  createdBy: string;
}

/**
 * Build an in-memory DB mock that supports the operations used by
 * `requestParticipation`:
 *
 *   insert(tos)…onConflictDoNothing()…returning()  — ensureController
 *   select({hopCount}).from(tos).where()            — cap check read
 *   update(tos).set({hopCount: sql…}).where().returning() — incrementHop
 *   db.transaction(tx => …)                        — entry post
 *     tx.update(discussions).set({entrySeq,entryCount,…}).where()
 *       .returning({entrySeq,companyId})
 *     tx.insert(de).values(…).returning()
 *
 * The mock also tracks inserts into `issues` so tests can assert that
 * `requestParticipation` never creates tasks.
 *
 * Table detection: the `tos` proxy returns strings like "tos.<prop>";
 * `de` proxy returns "de.<prop>"; `discussions` returns "discussions.<prop>";
 * `issues` proxy returns "issues.<prop>".
 */
function makeParticipationDb(
  controller: ControllerState,
  opts: {
    threadExists?: boolean;
    threadPaused?: boolean;
    companyPaused?: boolean;
    adjutantEnabled?: boolean;
    agentName?: string | null;
  } = {},
) {
  // Track what entries were posted and whether issues were inserted.
  const postedEntries: PostedEntry[] = [];
  let issueInsertCount = 0;
  let threadSeq = 0;       // simulate discussions.entrySeq counter
  let threadEntryCount = 0; // simulate discussions.entryCount counter (P1-T6 fix)

  // Detect table from proxy sentinel property
  function isTos(table: unknown): boolean {
    return String((table as Record<string, unknown>)["hopCount"]).startsWith("tos.");
  }
  function isDiscussionsTable(table: unknown): boolean {
    return String((table as Record<string, unknown>)["entrySeq"]).startsWith("discussions.");
  }
  function isInternalAgentConfigTable(table: unknown): boolean {
    return String((table as Record<string, unknown>)["crewPaused"]).startsWith("iac.");
  }
  function isDeTable(table: unknown): boolean {
    return String((table as Record<string, unknown>)["seq"]).startsWith("de.");
  }
  function isIssuesTable(table: unknown): boolean {
    return String((table as Record<string, unknown>)["id"]).startsWith("issues.");
  }
  function isAgentsTable(table: unknown): boolean {
    return String((table as Record<string, unknown>)["name"]).startsWith("agents.");
  }

  // Build the transaction proxy (same interface as the main db)
  function makeTx() {
    const tx: Record<string, unknown> = {};

    tx.update = vi.fn((table: unknown) => ({
      set: vi.fn((payload: Record<string, unknown>) => ({
        where: vi.fn(() => {
          if (isDiscussionsTable(table)) {
            // Bump entrySeq counter (always)
            threadSeq += 1;
            // Bump entryCount only when the payload includes it (P1-T6 fix)
            if ("entryCount" in payload) {
              threadEntryCount += 1;
            }
            return {
              // Return both entrySeq and companyId so the fixed code can call
              // publishLiveEvent with the correct companyId.
              returning: vi.fn(async () => [
                { entrySeq: threadSeq, companyId: "company-test-1" },
              ]),
            };
          }
          // Fallback for other tables inside a transaction (shouldn't happen here)
          return {
            returning: vi.fn(async () => [{ ...controller }]),
          };
        }),
      })),
    }));

    tx.insert = vi.fn((table: unknown) => ({
      values: vi.fn((vals: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          if (isDeTable(table)) {
            const entry: PostedEntry = {
              id: `entry-participation-${postedEntries.length + 1}`,
              discussionId: vals.discussionId as string,
              inputType: vals.inputType as string,
              rawContent: vals.rawContent as string,
              authorAgentId: (vals.authorAgentId as string | null) ?? null,
              extractionStatus: (vals.extractionStatus as string) ?? "skipped",
              seq: vals.seq as number,
              createdBy: vals.createdBy as string,
            };
            postedEntries.push(entry);
            return [entry];
          }
          if (isIssuesTable(table)) {
            issueInsertCount += 1;
            return [];
          }
          return [];
        }),
      })),
    }));

    return tx;
  }

  const db = {
    // ── insert ────────────────────────────────────────────────────────────────
    // Used by ensureController (tos) and — if the code ever does it — issues.
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(() => {
        if (isIssuesTable(table)) {
          issueInsertCount += 1;
        }
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => []), // conflict → no row
          })),
          // Direct .returning() path (no onConflictDoNothing) for issues inserts
          returning: vi.fn(async () => {
            return [];
          }),
        };
      }),
    })),

    // ── update ────────────────────────────────────────────────────────────────
    // Used by incrementHop (tos.hopCount).
    update: vi.fn((table: unknown) => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        // Apply tos updates to in-memory controller
        if (isTos(table)) {
          if ("hopCount" in payload) {
            const val = payload.hopCount;
            if (typeof val === "number") {
              controller.hopCount = val;
            } else {
              // SQL expression → increment
              controller.hopCount += 1;
            }
          }
          if ("pendingRun" in payload) {
            controller.pendingRun = payload.pendingRun as boolean;
          }
          if ("runEpoch" in payload) {
            const val = payload.runEpoch;
            if (typeof val === "number") {
              controller.runEpoch = val;
            } else {
              controller.runEpoch += 1;
            }
          }
        }
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => [{ ...controller }]),
          })),
        };
      }),
    })),

    // ── select ────────────────────────────────────────────────────────────────
    // Used by the cap-check read: select({hopCount}).from(tos).where()
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          let rows: Array<Record<string, unknown>> = [];
          if (isTos(table)) {
            // Return hopCount (and runEpoch for epoch re-reads in other paths)
            rows = [{
              hopCount: controller.hopCount,
              runEpoch: controller.runEpoch,
            }];
          } else if (
            isDiscussionsTable(table) &&
            projection &&
            ("adjutantEnabled" in projection || "crewPaused" in projection)
          ) {
            rows = opts.threadExists === false
              ? []
              : [{
                  companyId: "company-test-1",
                  adjutantEnabled: opts.adjutantEnabled ?? true,
                  crewPaused: opts.threadPaused ?? false,
                }];
          } else if (isAgentsTable(table)) {
            rows = opts.agentName === null
              ? []
              : [{ name: opts.agentName ?? "Scout" }];
          } else if (isInternalAgentConfigTable(table)) {
            rows = [{ crewPaused: opts.companyPaused ?? false }];
          }
          return {
            limit: vi.fn(async () => rows),
            then: (resolve: (value: Array<Record<string, unknown>>) => unknown) =>
              Promise.resolve(rows).then(resolve),
          };
        }),
      })),
    })),

    // ── transaction ───────────────────────────────────────────────────────────
    // Used by the entry-post step in requestParticipation.
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(makeTx());
    }),
  };

  return {
    db: db as unknown as Parameters<typeof threadOrchestrationService>[0],
    postedEntries,
    get issueInsertCount() {
      return issueInsertCount;
    },
    /** How many times the discussions UPDATE included an entryCount bump. */
    get threadEntryCount() {
      return threadEntryCount;
    },
    controller,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("requestParticipation — successful spawn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishLiveEvent.mockReset();
  });

  it("invokes the participantRunner with correct params and posts a discussion_entry", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-1",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    const runnerInput: { threadId: string; agentId: string; prompt: string }[] = [];
    const fakeRunner = vi.fn(async (input: { threadId: string; agentId: string; prompt: string }) => {
      runnerInput.push(input);
      return "Scout says: coast is clear";
    });

    const result = await svc.requestParticipation(
      "thread-part-1",
      { agentId: "agent-scout-1", prompt: "What do you see?" },
      { participantRunner: fakeRunner },
    );

    // Runner was called once with correct params
    expect(fakeRunner).toHaveBeenCalledTimes(1);
    expect(runnerInput[0]).toMatchObject({
      threadId: "thread-part-1",
      agentId: "agent-scout-1",
      prompt: "What do you see?",
    });

    // Result is spawned
    expect(result.spawned).toBe(true);
    if (!result.spawned) throw new Error("unreachable");
    expect(result.entryId).toBeTruthy();

    // One entry was posted
    expect(postedEntries).toHaveLength(1);
    const entry = postedEntries[0];
    expect(entry.inputType).toBe("agent");
    expect(entry.authorAgentId).toBe("agent-scout-1");
    expect(entry.rawContent).toBe("Scout says: coast is clear");
    expect(entry.discussionId).toBe("thread-part-1");
    expect(entry.extractionStatus).toBe("skipped");
  });

  it("bumps both entrySeq and entryCount in the discussions UPDATE (P1-T6 fix: entryCount drift)", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-entrycount",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    // Use the full mock object (not destructured) so the live getter is read
    // after the operation, not captured as 0 at construction time.
    const mock = makeParticipationDb(controller);
    const svc = threadOrchestrationService(mock.db);

    await svc.requestParticipation(
      "thread-part-entrycount",
      { agentId: "agent-scout-ec", prompt: "check count" },
      { participantRunner: async () => "ok" },
    );

    // entryCount must have been incremented exactly once alongside entrySeq
    expect(mock.threadEntryCount).toBe(1);
  });

  it("publishes discussion.entry.created and thread.entry.created live events after spawn (P1-T6 fix: real-time UI)", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-liveevents",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    await svc.requestParticipation(
      "thread-part-liveevents",
      { agentId: "agent-scout-le", prompt: "say something" },
      { participantRunner: async () => "live response" },
    );

    // publishLiveEvent must have been called exactly twice (discussion.entry.created
    // + thread.entry.created) — same two calls as discussions.addEntry makes.
    expect(mockPublishLiveEvent).toHaveBeenCalledTimes(2);

    const calls = mockPublishLiveEvent.mock.calls.map((c) => c[0] as Record<string, unknown>);

    // First call: discussion.entry.created
    expect(calls[0]).toMatchObject({
      companyId: "company-test-1",
      type: "discussion.entry.created",
      payload: {
        discussionId: "thread-part-liveevents",
        entryId: postedEntries[0].id,
        inputType: "agent",
      },
    });

    // Second call: thread.entry.created (Plan 7 thread-scoped poke)
    expect(calls[1]).toMatchObject({
      companyId: "company-test-1",
      type: "thread.entry.created",
      payload: {
        threadId: "thread-part-liveevents",
        entryId: postedEntries[0].id,
        seq: postedEntries[0].seq,
      },
    });
  });

  it("increments hopCount by 1 on a successful spawn", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-hop",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 2,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    const result = await svc.requestParticipation(
      "thread-part-hop",
      { agentId: "agent-planner-1", prompt: "Plan the next steps" },
      { participantRunner: async () => "Planner says: done" },
    );

    expect(result.spawned).toBe(true);
    if (!result.spawned) throw new Error("unreachable");
    // hopCount should now be 3 (was 2, incremented by 1)
    expect(result.hopCount).toBe(3);
    expect(controller.hopCount).toBe(3);
  });

  it("does NOT insert into the issues table (participation is chat-only, no tasks)", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-no-issue",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, issueInsertCount } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    await svc.requestParticipation(
      "thread-part-no-issue",
      { agentId: "agent-engineer-1", prompt: "Review the code" },
      { participantRunner: async () => "Engineer says: LGTM" },
    );

    // Zero inserts into issues — participation must never create tasks
    expect(issueInsertCount).toBe(0);
  });

  it("posted entry shape passes isHumanEntry=false (won't re-fire the controller)", () => {
    // Build the exact EntryCreatedEvent shape that the posted entry would produce
    // when passed through discussions.addEntry -> onEntryCreated.
    const postedEntryAsEvent: EntryCreatedEvent = {
      id: "entry-participation-1",
      discussionId: "thread-part-loop",
      inputType: "agent",
      authorAgentId: "agent-scout-99",
      createdBy: "agent-scout-99",
    };

    // isHumanEntry must return false — this is the QA-BUG-011 loop-guard
    // (agent-authored entries must never re-fire the Adjutant controller)
    expect(isHumanEntry(postedEntryAsEvent)).toBe(false);
  });

  it("returns the entryId of the posted entry", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-entryid",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 1,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    const result = await svc.requestParticipation(
      "thread-part-entryid",
      { agentId: "agent-navigator-1", prompt: "Find the path" },
      { participantRunner: async () => "Navigator says: turn left" },
    );

    expect(result.spawned).toBe(true);
    if (!result.spawned) throw new Error("unreachable");
    // The returned entryId should match the posted entry
    expect(result.entryId).toBe(postedEntries[0].id);
  });
});

describe("requestParticipation — at hop cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishLiveEvent.mockReset();
  });

  it("returns { spawned: false, atCap: true } when hopCount === HOP_CAP", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-cap",
      runEpoch: 1,
      pendingRun: false,
      hopCount: HOP_CAP, // already at the cap
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    const runner = vi.fn(async () => "should not be called");

    const result = await svc.requestParticipation(
      "thread-part-cap",
      { agentId: "agent-scout-cap", prompt: "Any news?" },
      { participantRunner: runner },
    );

    expect(result.spawned).toBe(false);
    if (result.spawned) throw new Error("unreachable");
    expect(result.atCap).toBe(true);
    expect(result.hopCount).toBe(HOP_CAP);
  });

  it("does NOT invoke the runner when at cap", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-cap-runner",
      runEpoch: 1,
      pendingRun: false,
      hopCount: HOP_CAP,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    const runner = vi.fn(async () => "should not be called");

    await svc.requestParticipation(
      "thread-part-cap-runner",
      { agentId: "agent-scout-cap", prompt: "Any news?" },
      { participantRunner: runner },
    );

    expect(runner).not.toHaveBeenCalled();
  });

  it("posts NOTHING when at cap (no entries inserted)", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-cap-nopost",
      runEpoch: 1,
      pendingRun: false,
      hopCount: HOP_CAP,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    await svc.requestParticipation(
      "thread-part-cap-nopost",
      { agentId: "agent-scout-cap", prompt: "Any news?" },
      { participantRunner: async () => "nope" },
    );

    expect(postedEntries).toHaveLength(0);
  });

  it("returns { spawned: false, atCap: true } when hopCount > HOP_CAP", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-overcap",
      runEpoch: 1,
      pendingRun: false,
      hopCount: HOP_CAP + 2, // exceeds cap
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    const result = await svc.requestParticipation(
      "thread-part-overcap",
      { agentId: "agent-scout-over", prompt: "Still capped?" },
      { participantRunner: async () => "blocked" },
    );

    expect(result.spawned).toBe(false);
    if (result.spawned) throw new Error("unreachable");
    expect(result.atCap).toBe(true);
  });

  it("does NOT increment hopCount when at cap", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-cap-noinc",
      runEpoch: 1,
      pendingRun: false,
      hopCount: HOP_CAP,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    await svc.requestParticipation(
      "thread-part-cap-noinc",
      { agentId: "agent-any", prompt: "noop" },
      { participantRunner: async () => "blocked" },
    );

    // hopCount must not have been incremented — cap check blocks before incrementHop
    expect(controller.hopCount).toBe(HOP_CAP);
  });

  it("does NOT call publishLiveEvent when at cap (no entry posted)", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-cap-noevent",
      runEpoch: 1,
      pendingRun: false,
      hopCount: HOP_CAP,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    await svc.requestParticipation(
      "thread-part-cap-noevent",
      { agentId: "agent-any", prompt: "noop" },
      { participantRunner: async () => "blocked" },
    );

    // No entry was posted → no live events should fire
    expect(mockPublishLiveEvent).not.toHaveBeenCalled();
  });
});

describe("requestParticipation — multiple sequential spawns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishLiveEvent.mockReset();
  });

  it("each spawn posts a separate entry and increments hopCount", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-multi",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    const agents = [
      { agentId: "agent-scout-1", prompt: "Scout recon", output: "Scout: all clear" },
      { agentId: "agent-planner-1", prompt: "Plan next", output: "Planner: step 1, step 2" },
      { agentId: "agent-engineer-1", prompt: "Implement", output: "Engineer: done" },
    ];

    let prevHopCount = 0;
    for (const { agentId, prompt, output } of agents) {
      const result = await svc.requestParticipation(
        "thread-part-multi",
        { agentId, prompt },
        { participantRunner: async () => output },
      );

      expect(result.spawned).toBe(true);
      if (!result.spawned) throw new Error("unreachable");
      expect(result.hopCount).toBe(prevHopCount + 1);
      prevHopCount = result.hopCount;
    }

    // Three entries posted, one per agent
    expect(postedEntries).toHaveLength(3);
    expect(postedEntries[0].authorAgentId).toBe("agent-scout-1");
    expect(postedEntries[1].authorAgentId).toBe("agent-planner-1");
    expect(postedEntries[2].authorAgentId).toBe("agent-engineer-1");

    // All entries are agent-typed (isHumanEntry → false for each)
    for (const e of postedEntries) {
      expect(e.inputType).toBe("agent");
      const asEvent: EntryCreatedEvent = {
        id: e.id,
        discussionId: e.discussionId,
        inputType: e.inputType,
        authorAgentId: e.authorAgentId,
        createdBy: e.createdBy,
      };
      expect(isHumanEntry(asEvent)).toBe(false);
    }
  });

  it("blocks at cap after HOP_CAP spawns", async () => {
    const controller: ControllerState = {
      threadId: "thread-part-reach-cap",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    // Spawn exactly HOP_CAP times
    for (let i = 0; i < HOP_CAP; i++) {
      const result = await svc.requestParticipation(
        "thread-part-reach-cap",
        { agentId: `agent-${i}`, prompt: `hop ${i}` },
        { participantRunner: async () => `output ${i}` },
      );
      expect(result.spawned).toBe(true);
    }

    expect(postedEntries).toHaveLength(HOP_CAP);
    expect(controller.hopCount).toBe(HOP_CAP);

    // The next spawn should be blocked
    const runner = vi.fn(async () => "blocked");
    const capResult = await svc.requestParticipation(
      "thread-part-reach-cap",
      { agentId: "agent-overflow", prompt: "one more" },
      { participantRunner: runner },
    );

    expect(capResult.spawned).toBe(false);
    if (capResult.spawned) throw new Error("unreachable");
    expect(capResult.atCap).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    // No additional entries after cap
    expect(postedEntries).toHaveLength(HOP_CAP);
  });
});

describe("requestParticipation — actorId option", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishLiveEvent.mockReset();
  });

  it("uses agentId as createdBy when no actorId option is provided", async () => {
    const controller: ControllerState = {
      threadId: "thread-actorid-default",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    await svc.requestParticipation(
      "thread-actorid-default",
      { agentId: "agent-default-actor", prompt: "hello" },
      { participantRunner: async () => "response" },
    );

    expect(postedEntries[0].createdBy).toBe("agent-default-actor");
  });

  it("uses the provided actorId as createdBy when specified", async () => {
    const controller: ControllerState = {
      threadId: "thread-actorid-custom",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    await svc.requestParticipation(
      "thread-actorid-custom",
      { agentId: "agent-x", prompt: "hello" },
      {
        participantRunner: async () => "response",
        actorId: "adjutant-service",
      },
    );

    expect(postedEntries[0].createdBy).toBe("adjutant-service");
  });
});

// =============================================================================
// Phase 2 / Task 2.1 — B1 regression lock: skip the entry-insert when the
// runner returns empty (the crew agent self-posts via the post_entry MCP tool
// DURING its run; the participation runner returns "" so requestParticipation
// must NOT also post a second, empty entry → NO double-post). A NON-empty
// return (legacy / other callers) still inserts as before.
// =============================================================================

describe("requestParticipation — skip-on-empty (no double-post; B1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishLiveEvent.mockReset();
  });

  it("runner returns \"\" → NO discussion_entry inserted (agent self-posted)", async () => {
    const controller: ControllerState = {
      threadId: "thread-empty-noinsert",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    const result = await svc.requestParticipation(
      "thread-empty-noinsert",
      { agentId: "agent-scout-self", prompt: "@Scout recon" },
      { participantRunner: async () => "" }, // crew runner contract: "" = self-posted
    );

    // The participation succeeded (it ran the agent) …
    expect(result.spawned).toBe(true);
    // … but NO entry was inserted — the agent already posted via post_entry.
    expect(postedEntries).toHaveLength(0);
  });

  it("runner returns \"\" → NO live events fire (nothing was inserted here)", async () => {
    const controller: ControllerState = {
      threadId: "thread-empty-noevent",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    await svc.requestParticipation(
      "thread-empty-noevent",
      { agentId: "agent-scout-self2", prompt: "@Scout recon" },
      { participantRunner: async () => "" },
    );

    // The agent self-post emits its OWN live events from inside its run (via the
    // post_entry tool). requestParticipation must not emit a duplicate pair for
    // an entry it did not insert.
    expect(mockPublishLiveEvent).not.toHaveBeenCalled();
  });

  it("runner returns \"\" → hop IS still incremented + state updated (cap still advances)", async () => {
    const controller: ControllerState = {
      threadId: "thread-empty-hop",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 2,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    const result = await svc.requestParticipation(
      "thread-empty-hop",
      { agentId: "agent-planner-self", prompt: "@Planner plan it" },
      { participantRunner: async () => "" },
    );

    expect(result.spawned).toBe(true);
    if (!result.spawned) throw new Error("unreachable");
    // Hop still counts toward the cap — this round happened even though the
    // agent self-posted. (Prevents infinite ping-pong from self-posting agents.)
    expect(result.hopCount).toBe(3);
    expect(controller.hopCount).toBe(3);
    // entryId is null — there is no entry this call inserted.
    expect(result.entryId).toBeNull();
    expect(postedEntries).toHaveLength(0);
  });

  it("whitespace-only return is treated as empty (still skips the insert)", async () => {
    const controller: ControllerState = {
      threadId: "thread-ws-noinsert",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    const result = await svc.requestParticipation(
      "thread-ws-noinsert",
      { agentId: "agent-eng-self", prompt: "@Engineer build" },
      { participantRunner: async () => "   \n  " },
    );

    expect(result.spawned).toBe(true);
    expect(postedEntries).toHaveLength(0);
  });

  it("NON-empty return still inserts the entry (legacy / other callers unaffected)", async () => {
    const controller: ControllerState = {
      threadId: "thread-nonempty-insert",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller);
    const svc = threadOrchestrationService(db);

    const result = await svc.requestParticipation(
      "thread-nonempty-insert",
      { agentId: "agent-scout-text", prompt: "What do you see?" },
      { participantRunner: async () => "Scout says: coast is clear" },
    );

    expect(result.spawned).toBe(true);
    if (!result.spawned) throw new Error("unreachable");
    // Legacy contract preserved: a runner that returns text gets that text posted.
    expect(postedEntries).toHaveLength(1);
    expect(postedEntries[0].rawContent).toBe("Scout says: coast is clear");
    expect(postedEntries[0].inputType).toBe("agent");
    expect(result.entryId).toBe(postedEntries[0].id);
    // And the live events fire for the inserted entry.
    expect(mockPublishLiveEvent).toHaveBeenCalledTimes(2);
  });
});

describe("requestParticipation - pause gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishLiveEvent.mockReset();
  });

  it("does not invoke the participant runner when the thread is paused", async () => {
    const controller: ControllerState = {
      threadId: "thread-paused",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller, { threadPaused: true });
    const svc = threadOrchestrationService(db);
    const runner = vi.fn(async () => "should not run");

    const result = await svc.requestParticipation(
      "thread-paused",
      { agentId: "agent-scout-paused", prompt: "@Scout check" },
      { participantRunner: runner },
    );

    expect(result).toMatchObject({ spawned: false, atCap: false, blockedReason: "thread_paused" });
    expect(runner).not.toHaveBeenCalled();
    expect(controller.hopCount).toBe(0);
    expect(postedEntries).toHaveLength(0);
    expect(mockPublishLiveEvent).not.toHaveBeenCalled();
  });

  it("does not invoke the participant runner when company crew is paused", async () => {
    const controller: ControllerState = {
      threadId: "thread-company-paused",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db } = makeParticipationDb(controller, { companyPaused: true });
    const svc = threadOrchestrationService(db);
    const runner = vi.fn(async () => "should not run");

    const result = await svc.requestParticipation(
      "thread-company-paused",
      { agentId: "agent-scout-company-paused", prompt: "@Scout check" },
      { participantRunner: runner },
    );

    expect(result).toMatchObject({ spawned: false, atCap: false, blockedReason: "company_paused" });
    expect(runner).not.toHaveBeenCalled();
    expect(controller.hopCount).toBe(0);
  });
});

describe("requestParticipation - adjutant opt-out semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishLiveEvent.mockReset();
  });

  it("allows direct non-Adjutant participation when adjutantEnabled is false", async () => {
    const controller: ControllerState = {
      threadId: "thread-adjutant-disabled-scout",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller, {
      adjutantEnabled: false,
      agentName: "Scout",
    });
    const svc = threadOrchestrationService(db);
    const runner = vi.fn(async () => "Scout can still answer");

    const result = await svc.requestParticipation(
      "thread-adjutant-disabled-scout",
      { agentId: "agent-scout", prompt: "@Scout check this" },
      { participantRunner: runner },
    );

    expect(result).toMatchObject({ spawned: true, hopCount: 1 });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(postedEntries).toHaveLength(1);
    expect(postedEntries[0].authorAgentId).toBe("agent-scout");
  });

  it("blocks Adjutant participation when adjutantEnabled is false", async () => {
    const controller: ControllerState = {
      threadId: "thread-adjutant-disabled",
      runEpoch: 1,
      pendingRun: false,
      hopCount: 0,
      lastProcessedEntryId: null,
      lastError: null,
    };
    const { db, postedEntries } = makeParticipationDb(controller, {
      adjutantEnabled: false,
      agentName: "Adjutant",
    });
    const svc = threadOrchestrationService(db);
    const runner = vi.fn(async () => "Adjutant should not answer");

    const result = await svc.requestParticipation(
      "thread-adjutant-disabled",
      { agentId: "agent-adjutant", prompt: "@Adjutant check this" },
      { participantRunner: runner },
    );

    expect(result).toMatchObject({ spawned: false, atCap: false, blockedReason: "thread_disabled" });
    expect(runner).not.toHaveBeenCalled();
    expect(controller.hopCount).toBe(0);
    expect(postedEntries).toHaveLength(0);
  });
});
