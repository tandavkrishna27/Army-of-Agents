/**
 * Live-QA BUG-1 — "I posted a thread and nothing started."
 *
 * THE BUG (proven live): `discussions.create()` — the "open a thread WITH a
 * first message" path — inserts the discussion + first entry but, unlike
 * `addEntry`, NEVER (a) computes `hasCrewMention`, (b) calls
 * `getThreadEventListener().onEntryCreated(...)` (the proactive Adjutant
 * debounce), nor (c) publishes the thread-scoped `thread.entry.created` poke.
 * Net effect: a founder who opens a thread with their first message gets NO
 * proactive crew engagement (until a 2nd message), and an @mention in that
 * first message is dropped.
 *
 * THE FIX: `create()` now runs the SAME post-entry side-effect block as
 * `addEntry` (DRY-extracted into `emitEntryCreatedSideEffects`) when it created
 * a first entry. These tests pin the service-layer contract:
 *
 *   (a) create() WITH a plain (no-mention) first entry → onEntryCreated called
 *       once with { discussionId, inputType, hasCrewMention:false }.
 *   (b) create() WITH a first entry that @mentions a kind='aoa' crew agent →
 *       onEntryCreated called with hasCrewMention:true (so the proactive
 *       debounce SKIPS — the mentioned agent answers directly; no double-drive).
 *   (c) create() WITHOUT an entry → onEntryCreated NOT called.
 *
 * Harness mirrors mention-debounce-dedup.test.ts: a vi.hoisted onEntryCreated
 * spy + a partial mock of thread-events.js stubbing getThreadEventListener, plus
 * a capturing sequence-DB. thread-orchestration is stubbed so ensureController is
 * a cheap no-op and the import graph stays light.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted spy: getThreadEventListener() returns { onEntryCreated: spy } so we can
// assert create()'s emitted event (the proactive arming) directly.
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
    title: "discussions_title",
    scopeType: "discussions_scope_type",
    scopeId: "discussions_scope_id",
    tags: "discussions_tags",
    entryCount: "discussions_entry_count",
    entrySeq: "discussions_entry_seq",
    lastEntryAt: "discussions_last_entry_at",
    createdBy: "discussions_created_by",
    useControllerPath: "discussions_use_controller_path",
  },
  discussionEntries: {
    id: "entries_id",
    discussionId: "entries_discussion_id",
    inputType: "entries_input_type",
    rawContent: "entries_raw_content",
    title: "entries_title",
    departmentId: "entries_department_id",
    projectId: "entries_project_id",
    goalId: "entries_goal_id",
    sourceInfo: "entries_source_info",
    extractionStatus: "entries_extraction_status",
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

// ensureController is best-effort and called post-txn — stub it to a no-op so
// the create() side-effect path is exercised without pulling the real
// orchestration service (and its git/child_process transitive deps) into graph.
vi.mock("../services/thread-orchestration.js", () => ({
  threadOrchestrationService: vi.fn(() => ({
    ensureController: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Partial mock: stub getThreadEventListener so create()'s emit lands on our spy.
// Everything else (createThreadEventListener et al.) stays real but unused here.
vi.mock("../services/thread-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/thread-events.js")>();
  return {
    ...actual,
    getThreadEventListener: vi.fn(() => ({ onEntryCreated: onEntryCreatedSpy })),
  };
});

import { discussionService } from "../services/discussions.js";

// ─────────────────────────────────────────────────────────────────────────────
// Capturing DB for create():
//   tx.insert(discussions) → discussion row
//   tx.insert(discussionEntries) → entry row   (only when data.entry provided)
//   [top-level] db.select(agents) → crew-mention lookup (only when @mention text)
// No top-level db.select runs for the no-mention / no-entry cases.
// ─────────────────────────────────────────────────────────────────────────────
function createDb(config: { selects?: any[][]; txInserts?: any[][] }) {
  let selectIdx = 0;
  let txInsertIdx = 0;

  function makeSelectChain() {
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn(() => Promise.resolve((config.selects ?? [])[selectIdx++] ?? [])),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn((config.selects ?? [])[selectIdx++] ?? [])),
      ),
    };
  }

  function makeTxInsertChain() {
    const idx = txInsertIdx++;
    return {
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve((config.txInserts ?? [])[idx] ?? [])),
      })),
    };
  }

  const db: any = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => makeTxInsertChain()),
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => {
      const tx: any = {
        insert: vi.fn(() => makeTxInsertChain()),
      };
      return fn(tx);
    }),
  };
  return db;
}

describe("BUG-1 — discussions.create() arms the proactive Adjutant on the first entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onEntryCreatedSpy.mockResolvedValue(undefined);
  });

  // (a) plain first entry → onEntryCreated once, hasCrewMention:false
  it("(a) calls onEntryCreated with hasCrewMention=false for a plain first entry", async () => {
    const db = createDb({
      txInserts: [
        // tx.insert discussions → discussion row
        [{ id: "disc-1", companyId: "co", title: "Hi" }],
        // tx.insert entry → first entry row (carries rawContent + seq)
        [
          {
            id: "entry-1",
            discussionId: "disc-1",
            seq: 0,
            authorAgentId: null,
            inputType: "write",
            createdBy: "user:1",
            rawContent: "just opening a thread",
          },
        ],
      ],
    });

    await discussionService(db).create(
      "co",
      {
        title: "Hi",
        entry: { inputType: "write", rawContent: "just opening a thread" },
      },
      "user:1",
    );

    expect(onEntryCreatedSpy).toHaveBeenCalledTimes(1);
    expect(onEntryCreatedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "entry-1",
        discussionId: "disc-1",
        inputType: "write",
        hasCrewMention: false,
      }),
    );
  });

  // (b) first entry @mentions a kind='aoa' crew agent → hasCrewMention:true
  it("(b) calls onEntryCreated with hasCrewMention=true when the first entry @mentions a crew agent", async () => {
    const db = createDb({
      selects: [
        // crew-mention lookup → Scout resolves to a kind='aoa' agent
        [{ id: "agent-scout" }],
      ],
      txInserts: [
        [{ id: "disc-2", companyId: "co", title: "Need help" }],
        [
          {
            id: "entry-2",
            discussionId: "disc-2",
            seq: 0,
            authorAgentId: null,
            inputType: "write",
            createdBy: "user:1",
            rawContent: "@Scout can you look into this?",
          },
        ],
      ],
    });

    await discussionService(db).create(
      "co",
      {
        title: "Need help",
        entry: { inputType: "write", rawContent: "@Scout can you look into this?" },
      },
      "user:1",
    );

    expect(onEntryCreatedSpy).toHaveBeenCalledTimes(1);
    expect(onEntryCreatedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "entry-2",
        discussionId: "disc-2",
        hasCrewMention: true,
      }),
    );
  });

  // (c) no entry → onEntryCreated NOT called
  it("(c) does NOT call onEntryCreated when created without a first entry", async () => {
    const db = createDb({
      txInserts: [
        // only the discussion row is inserted; no entry insert
        [{ id: "disc-3", companyId: "co", title: "Empty" }],
      ],
    });

    await discussionService(db).create("co", { title: "Empty" }, "user:1");

    expect(onEntryCreatedSpy).not.toHaveBeenCalled();
  });
});
