/**
 * Task 1.3 — Kill the double-drive.
 *
 * THE PROBLEM (real, can't be fixed at the event layer alone): a human posting
 * `@Scout …` on a controller-path thread triggers TWO independent drives on one
 * entry — (1) `processMentions` → `requestParticipation` runs Scout directly
 * (Task 1.2), AND (2) `addEntry` → `onEntryCreated` arms the 30s debounce →
 * `fireAdjutantWakeup` runs the proactive Adjutant. The Adjutant should NOT also
 * fire when a specific agent was directly addressed. But `onEntryCreated`'s event
 * payload `{id,discussionId,authorAgentId,inputType,createdBy}` carries NO text,
 * so the listener can't tell a mention is present.
 *
 * THE FIX: `discussions.addEntry` parses `rawContent` and resolves whether ANY
 * mentioned name is a kind='aoa' crew agent in this company; it stamps
 * `hasCrewMention: boolean` onto the `EntryCreatedEvent`. `onEntryCreated` then
 * SKIPS arming the proactive Adjutant debounce when `hasCrewMention === true`
 * (the mentioned agent answers directly). When false (ambient human chatter,
 * no crew @mention), the debounce arms as before.
 *
 * Cases:
 *   (d) addEntry on an entry that @mentions a crew agent → emits the event with
 *       hasCrewMention=true AND onEntryCreated does NOT arm the debounce.
 *   (e) addEntry on an entry with no crew mention → hasCrewMention=false AND the
 *       debounce IS armed.
 *
 * Two layers, two harnesses:
 *   - addEntry resolution (discussions.ts): a capturing DB + a captured
 *     getThreadEventListener spy assert the emitted hasCrewMention value.
 *   - onEntryCreated arming (thread-events.ts): the existing sequence-DB +
 *     fake-timer harness asserts the debounce arms iff hasCrewMention is falsy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Shared module mocks. Both layers exercise REAL implementations:
//   Layer 1 = discussions.addEntry (stamps hasCrewMention onto the event)
//   Layer 2 = thread-events.createThreadEventListener.onEntryCreated (arming)
//
// thread-events.js is PARTIALLY mocked: getThreadEventListener is stubbed (so
// addEntry's emit is captured by `onEntryCreatedSpy`) while createThreadEventListener
// stays the real implementation (so Layer 2 tests the genuine arming logic). The
// heavy transitive deps (controller-adjutant-runner → runner) and the
// orchestration service are stubbed below so importOriginal() stays cheap.
// ─────────────────────────────────────────────────────────────────────────────

const { onEntryCreatedSpy } = vi.hoisted(() => ({
  onEntryCreatedSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  desc: vi.fn((col: any) => ({ desc: col })),
  sql: vi.fn((strings: any, ...values: any[]) => ({ sql: true, strings, values })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
  asc: vi.fn((col: any) => ({ asc: col })),
}));

vi.mock("@armyofagents/db", () => ({
  discussions: {
    id: "discussions_id",
    companyId: "discussions_company_id",
    entryCount: "discussions_entry_count",
    entrySeq: "discussions_entry_seq",
    lastEntryAt: "discussions_last_entry_at",
    updatedAt: "discussions_updated_at",
    // thread-events.fireAdjutantWakeup reads `_.name` for table identity in some harnesses.
    _: { name: "discussions" },
  },
  discussionEntries: {
    id: "entries_id",
    discussionId: "entries_discussion_id",
    inputType: "entries_input_type",
    rawContent: "entries_raw_content",
    authorAgentId: "entries_author_agent_id",
    seq: "entries_seq",
    createdBy: "entries_created_by",
  },
  discussionExtractedItems: { id: "items_id" },
  discussionAnnotations: { id: "annotations_id" },
  discussionEntryAttachments: { id: "attachments_id" },
  artifacts: { id: "artifacts_id" },
  agents: {
    id: "agents_id",
    companyId: "agents_company_id",
    name: "agents_name",
    kind: "agents_kind",
  },
  agentWakeupRequests: { id: "awr_id" },
  // PR #291 round-6 #3: addEntry now enqueues an @mention summon into this outbox
  // table inside its tx, so the table object must exist on the mock.
  discussionMentionOutbox: {
    id: "dmo_id",
    companyId: "dmo_company_id",
    discussionId: "dmo_discussion_id",
    entryId: "dmo_entry_id",
    mentions: "dmo_mentions",
    status: "dmo_status",
  },
  projects: { id: "projects_id", type: "projects_type" },
  goals: { id: "goals_id" },
  threadPlanSteps: { id: "tps_id" },
  threadParticipants: { id: "tp_id" },
  authUsers: { id: "auth_id" },
}));

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => Object.assign(new Error(msg), { status: 400 }),
  notFound: (msg: string) => Object.assign(new Error(msg), { status: 404 }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({ create: vi.fn().mockResolvedValue({ id: "task-1" }) })),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: vi.fn(() => ({
    create: vi.fn().mockResolvedValue({ id: "mem-1" }),
    findSimilarItems: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("../services/thread-orchestration.js", () => ({
  threadOrchestrationService: vi.fn(() => ({
    triggerOnHumanEntry: vi.fn().mockResolvedValue(undefined),
    runController: vi.fn().mockResolvedValue({ ran: false, reason: "no-pending" }),
  })),
}));

vi.mock("../services/internal-agent/aoa-agents/controller-adjutant-runner.js", () => ({
  makeControllerAdjutantRunner: vi.fn(() => vi.fn().mockResolvedValue({ output: null })),
}));

// Partial mock: keep the REAL createThreadEventListener (Layer 2 tests it) but
// stub getThreadEventListener so addEntry's emit lands on our spy (Layer 1).
vi.mock("../services/thread-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/thread-events.js")>();
  return {
    ...actual,
    getThreadEventListener: vi.fn(() => ({ onEntryCreated: onEntryCreatedSpy })),
  };
});

import { discussionService } from "../services/discussions.js";
import {
  createThreadEventListener,
  type ThreadEventListener,
} from "../services/thread-events.js";

/** Capturing DB for addEntry: select (discussion) → tx(update seq, insert entry) → [crew lookup]. */
function createAddEntryDb(config: { selects: any[][]; updates?: any[][]; inserts?: any[][] }) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;

  function makeSelectChain() {
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((onF: (rows: any[]) => any, onR?: (e: unknown) => any) => {
        const staged = config.selects[selectIdx++] ?? [];
        // A staged Error simulates a DB failure on that select (e.g. the
        // post-commit crew-mention lookup) so `await chain` rejects.
        if (staged instanceof Error) {
          return onR ? onR(staged) : Promise.reject(staged);
        }
        return Promise.resolve(onF(staged));
      }),
    };
  }
  function makeUpdateChain() {
    return {
      set: vi.fn().mockReturnThis(),
      where: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve((config.updates ?? [])[updateIdx++] ?? []),
        ),
      })),
    };
  }
  function makeInsertChain() {
    const idx = insertIdx++;
    return {
      values: vi.fn(() => {
        const chain: any = {
          onConflictDoNothing: vi.fn(() => chain),
          returning: vi.fn(() =>
            Promise.resolve((config.inserts ?? [])[idx] ?? []),
          ),
        };
        return chain;
      }),
    };
  }
  const db: any = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => makeInsertChain()),
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => {
      const tx: any = {
        update: vi.fn(() => makeUpdateChain()),
        insert: vi.fn(() => makeInsertChain()),
        // Round-13 #2: addEntry's outbox enqueue resolves mentions multi-word-
        // aware (resolveMentionTargets), which reads the agent roster inside the
        // tx. Return an EMPTY roster here (sequence-neutral — does NOT consume the
        // outer `selects` queue) so resolution falls back to the parseMentions
        // token pass, exactly as before this change.
        select: vi.fn(() => {
          const chain: any = {
            from: vi.fn(() => chain),
            where: vi.fn(() => chain),
            innerJoin: vi.fn(() => chain),
            leftJoin: vi.fn(() => chain),
            orderBy: vi.fn(() => chain),
            limit: vi.fn(() => chain),
            then: vi.fn((onF: (rows: any[]) => any) => Promise.resolve(onF([]))),
          };
          return chain;
        }),
      };
      return fn(tx);
    }),
  };
  return db;
}

describe("Task 1.3 — addEntry stamps hasCrewMention on the EntryCreatedEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onEntryCreatedSpy.mockResolvedValue(undefined);
  });

  // (d) crew @mention → hasCrewMention=true
  it("(d) emits hasCrewMention=true when rawContent @mentions a kind='aoa' crew agent", async () => {
    const db = createAddEntryDb({
      selects: [
        [{ id: "disc-1", companyId: "co" }], // 0 discussion exists
        [{ id: "agent-scout" }], // 1 crew-mention lookup → Scout resolves
      ],
      updates: [[{ entrySeq: 5 }]],
      inserts: [
        [
          {
            id: "entry-new",
            discussionId: "disc-1",
            seq: 5,
            authorAgentId: null,
            inputType: "write",
            createdBy: "user:1",
          },
        ],
      ],
    });

    await discussionService(db).addEntry(
      "co",
      "disc-1",
      { rawContent: "@Scout can you look into this?", inputType: "write" },
      "user:1",
    );

    expect(onEntryCreatedSpy).toHaveBeenCalledTimes(1);
    expect(onEntryCreatedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "entry-new",
        discussionId: "disc-1",
        hasCrewMention: true,
      }),
    );
  });

  // (e) no crew mention → hasCrewMention=false
  it("(e) emits hasCrewMention=false when rawContent has no @mention", async () => {
    const db = createAddEntryDb({
      selects: [
        [{ id: "disc-1", companyId: "co" }], // 0 discussion exists
        // No crew lookup expected (no @mention) — but stage one defensively.
        [],
      ],
      updates: [[{ entrySeq: 2 }]],
      inserts: [
        [
          {
            id: "entry-plain",
            discussionId: "disc-1",
            seq: 2,
            authorAgentId: null,
            inputType: "write",
            createdBy: "user:1",
          },
        ],
      ],
    });

    await discussionService(db).addEntry(
      "co",
      "disc-1",
      { rawContent: "just thinking out loud here", inputType: "write" },
      "user:1",
    );

    expect(onEntryCreatedSpy).toHaveBeenCalledTimes(1);
    expect(onEntryCreatedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "entry-plain", hasCrewMention: false }),
    );
  });

  // PR #291 round-5 #3: the crew-mention lookup runs AFTER the entry tx commits.
  // A DB blip there must NOT throw out of addEntry — otherwise the request 500s
  // with a durable entry, and a same-key Retry replays past the route's
  // processMentions summon (the @agent is never summoned). Best-effort: the entry
  // still returns and the event still emits (hasCrewMention defaults to false).
  it("does NOT throw out of addEntry when the crew-mention lookup fails (best-effort)", async () => {
    const db = createAddEntryDb({
      selects: [
        [{ id: "disc-1", companyId: "co" }], // 0 discussion exists
        new Error("db blip during crew-mention lookup") as any, // 1 crew lookup THROWS
      ],
      updates: [[{ entrySeq: 7 }]],
      inserts: [
        [
          {
            id: "entry-resilient",
            discussionId: "disc-1",
            seq: 7,
            authorAgentId: null,
            inputType: "write",
            createdBy: "user:1",
          },
        ],
      ],
    });

    const entry = await discussionService(db).addEntry(
      "co",
      "disc-1",
      { rawContent: "@Scout please look", inputType: "write" },
      "user:1",
    );

    // The durable entry is returned (no throw) so the route reaches processMentions.
    expect(entry.id).toBe("entry-resilient");
    // The side-effect event still emitted; the failed lookup degrades to false.
    expect(onEntryCreatedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "entry-resilient", hasCrewMention: false }),
    );
  });

  // A mention that resolves to NO crew agent (e.g. a human name) → hasCrewMention=false.
  it("emits hasCrewMention=false when the @mention is not a crew agent", async () => {
    const db = createAddEntryDb({
      selects: [
        [{ id: "disc-1", companyId: "co" }], // 0 discussion exists
        [], // 1 crew-mention lookup → no crew agent by that name
      ],
      updates: [[{ entrySeq: 3 }]],
      inserts: [
        [
          {
            id: "entry-human-mention",
            discussionId: "disc-1",
            seq: 3,
            authorAgentId: null,
            inputType: "write",
            createdBy: "user:1",
          },
        ],
      ],
    });

    await discussionService(db).addEntry(
      "co",
      "disc-1",
      { rawContent: "@alice what do you think?", inputType: "write" },
      "user:1",
    );

    expect(onEntryCreatedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ hasCrewMention: false }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: onEntryCreated arms the debounce iff hasCrewMention is falsy
//
// Uses the REAL createThreadEventListener (partial-mocked above) + a fake-timer
// harness mirroring services/__tests__/thread-events.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

describe("Task 1.3 — onEntryCreated skips the proactive debounce on a crew @mention", () => {
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

  /** A select/insert sequence DB that records whether the peer-wake insert fired. */
  function makeFireDb() {
    const insertCalls: unknown[] = [];
    let selectCallCount = 0;
    // happy-path: thread row (legacy, so the peer-wake insert path is taken when armed) + adjutant row.
    // Task 3.2: dial is Assist (1) so the proactive wake PROCEEDS once armed —
    // autonomyLevel != null ⇒ no internal_agent_config select (sequence stays thread → agents).
    const selectResults: Array<Array<Record<string, unknown>>> = [
      [{ id: "thread-1", companyId: "co-1", crewPaused: false, adjutantEnabled: true, useControllerPath: false, autonomyLevel: 1 }],
      [{ id: "adj-1" }],
    ];
    const db: any = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        limit: vi.fn(() => Promise.resolve(selectResults[selectCallCount++] ?? [])),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => {
            insertCalls.push(true);
            return Promise.resolve(undefined);
          }),
        })),
      })),
    };
    return { db, insertCalls };
  }

  function humanEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: "entry-1",
      discussionId: "thread-1",
      authorAgentId: null,
      inputType: "write",
      createdBy: "user-1",
      ...overrides,
    };
  }

  // (d) part 2: hasCrewMention=true → debounce NOT armed → no Adjutant wakeup.
  it("(d) does NOT arm the debounce (no proactive Adjutant wakeup) when hasCrewMention=true", async () => {
    const { db, insertCalls } = makeFireDb();
    listener = createThreadEventListener(db, { debounceMs: 0 });

    await listener.onEntryCreated(humanEntry({ hasCrewMention: true }));
    await vi.advanceTimersByTimeAsync(40_000);
    await Promise.resolve();
    await Promise.resolve();

    // No timer was scheduled → fireAdjutantWakeup never ran → no peer-wake insert,
    // and the thread row was never even fetched.
    expect(insertCalls).toHaveLength(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("cancels an already-armed proactive debounce when a direct crew mention arrives", async () => {
    const { db, insertCalls } = makeFireDb();
    listener = createThreadEventListener(db, { debounceMs: 1_000 });

    await listener.onEntryCreated(humanEntry({ id: "ambient", hasCrewMention: false }));
    await listener.onEntryCreated(humanEntry({ id: "mention", hasCrewMention: true }));
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(insertCalls).toHaveLength(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  // (e) part 2: hasCrewMention=false → debounce armed → Adjutant wakeup fires.
  it("(e) arms the debounce (proactive Adjutant wakeup fires) when hasCrewMention=false", async () => {
    const { db, insertCalls } = makeFireDb();
    listener = createThreadEventListener(db, { debounceMs: 0 });

    await listener.onEntryCreated(humanEntry({ hasCrewMention: false }));
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The debounce armed and fired: the thread row was fetched and the legacy
    // peer-wake insert ran (useControllerPath=false branch).
    expect(db.select).toHaveBeenCalled();
    expect(insertCalls).toHaveLength(1);
  });

  // Back-compat: an event with hasCrewMention ABSENT behaves like false (arms).
  it("treats a missing hasCrewMention as falsy (arms the debounce) — back-compat", async () => {
    const { db, insertCalls } = makeFireDb();
    listener = createThreadEventListener(db, { debounceMs: 0 });

    await listener.onEntryCreated(humanEntry()); // no hasCrewMention field
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(insertCalls).toHaveLength(1);
  });
});
