/**
 * Unit tests for the Task-C1 tool-callable extraction exports:
 *
 *   - extractMemoryCandidates(db, llm, { companyId, threadId, sinceEntryId? })
 *   - extractDecisions(db, llm, { companyId, threadId, sinceEntryId? })
 *   - extractInsights(db, llm, { companyId, threadId, sinceEntryId? })
 *   - extractReferences(db, llm, { companyId, threadId, sinceEntryId? })
 *
 * Phase 1 design: extraction is no longer an autonomous Scribe pull — it is a
 * named function called by Memory Keeper / Adjutant tool wrappers. These
 * tests pin the new export surface:
 *
 *   1. Returns structured candidates from a mock LLM.
 *   2. Respects the `sinceEntryId` cursor — only entries strictly after the
 *      named entry are considered (incremental extraction).
 *   3-5. Filtered helpers (extractDecisions / extractInsights /
 *      extractReferences) return only the matching candidate type.
 *   6. Empty thread (no entries OR all-empty content) returns
 *      `{ candidates: [] }` and does NOT invoke the LLM.
 *   7. LLM error path: function rejects (does not swallow). The Memory
 *      Keeper / Adjutant tool wrapper is responsible for translating the
 *      rejection into a structured tool failure response.
 *
 * Pattern mirrors B2/B3/B4 tests: mock `@armyofagents/db` + `drizzle-orm` at
 * module level via the shared Proxy/operator helpers, drive the service with
 * a sequence-based mock DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeTableProxy,
  drizzleOperatorStubs,
} from "../../__tests__/helpers/drizzle-mock.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@armyofagents/db", () => ({
  // Tables consumed by extractMemoryCandidates.
  discussions: makeTableProxy("discussions"),
  discussionEntries: makeTableProxy("discussion_entries"),
  discussionExtractedItems: makeTableProxy("discussion_extracted_items"),
  projects: makeTableProxy("projects"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
  internalAgentRuns: makeTableProxy("internal_agent_runs"),
  // Legacy schema imports kept so the module under test loads without
  // dangling-symbol errors (extraction.ts still imports the debrief tables
  // for the autonomous flow which lives alongside the new exports).
  debriefs: makeTableProxy("debriefs"),
  briefs: makeTableProxy("briefs"),
  briefItems: makeTableProxy("brief_items"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("../../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// live-events is imported transitively by extraction.ts; stub so the import
// resolves without spinning up any pub/sub state.
vi.mock("../live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

// Provider resolver: legacy import surface kept so extraction.ts loads. These
// are NEVER consulted by the tool-callable extractors anymore — production runs
// the keyless CLI (covered by extraction-memory-candidates-cli.test.ts). Every
// test in THIS file injects a mock LLM (the test/eval seam), so neither the CLI
// nor the resolver is reached.
vi.mock("../internal-agent/providers/index.js", () => ({
  getProviderApiKey: vi.fn().mockRejectedValue(new Error("no key in test")),
  createProvider: vi.fn(),
  resolveAvailableProvider: vi.fn().mockRejectedValue(new Error("no provider in test")),
}));

import {
  extractMemoryCandidates,
  extractDecisions,
  extractInsights,
  extractReferences,
  type ExtractionLlm,
  type MemoryCandidate,
} from "../extraction.js";

// ── Sequence-based mock DB ───────────────────────────────────────────────────
//
// The tool-callable extractors issue selects in a predictable order:
//
//   sinceEntryId is undefined:
//     1. discussions privacy gate (allowMemoryExtraction lookup, G3 wiring)
//     2. entries window (entire thread)
//     3. departments list
//
//   sinceEntryId is provided:
//     1. discussions privacy gate (allowMemoryExtraction lookup, G3 wiring)
//     2. cursor lookup (createdAt of sinceEntryId)
//     3. entries window (strictly after cursor)
//     4. departments list
//
// Each `.select()` consumes the next preset row set. We don't care about
// .from / .where / .orderBy semantics; the mock just records the table name
// (via the `_` meta on `makeTableProxy`) so a test can assert which select
// hit which table, in order.
//
// PRIVACY_ALLOWED is the standard first-row to prepend in tests that should
// flow past the gate. Tests that want to assert the gate short-circuits feed
// `[{ allowMemoryExtraction: false }]` as the first row instead.

const PRIVACY_ALLOWED: MockRow[] = [{ allowMemoryExtraction: true }];

type MockRow = Record<string, unknown>;

interface SelectCall {
  fromTable?: string;
}

function createSequenceDb(selects: MockRow[][] = []) {
  let idx = 0;
  const calls: SelectCall[] = [];

  function tableNameOf(value: unknown): string | undefined {
    if (value && typeof value === "object") {
      const meta = (value as Record<string, unknown>)["_"];
      if (meta && typeof meta === "object") {
        const name = (meta as Record<string, unknown>).name;
        if (typeof name === "string") return name;
      }
    }
    return undefined;
  }

  function makeSelectChain(): any {
    const call: SelectCall = {};
    calls.push(call);
    const chain: any = {};
    for (const m of ["where", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.from = (table: unknown) => {
      call.fromTable = tableNameOf(table);
      return chain;
    };
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(selects[idx++] ?? []));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeSelectChain(),
    selectCalls: calls,
  };
}

// ── Test fixtures ────────────────────────────────────────────────────────────

const COMPANY_ID = "co-1";
const THREAD_ID = "thread-1";

function entryRow(id: string, content: string, createdAt: Date): MockRow {
  return { id, rawContent: content, createdAt };
}

function deptRow(id: string, name: string, type: "department" | "project" = "department"): MockRow {
  return { id, name, type };
}

/**
 * Standard mock LLM that returns a fixed JSON payload covering all five
 * candidate types used by the type-filter tests below. Tests can opt into a
 * custom payload by passing one to `makeLlmReturning`.
 */
const MIXED_LLM_RESPONSE = JSON.stringify([
  {
    type: "decision",
    title: "Use Tailwind for the dashboard",
    description: "Team agreed to drop custom CSS in favour of Tailwind.",
    department: "Engineering",
    layer: "domain",
  },
  {
    type: "task",
    title: "Draft Q4 OKRs",
    description: "Founder to write the first Q4 OKR draft this week.",
    priority: "high",
    department: null,
    layer: "active_context",
  },
  {
    type: "insight",
    title: "Renewal cohort skews enterprise",
    description: "60% of renewals last quarter were enterprise tier.",
    department: null,
    layer: "active_context",
  },
  {
    type: "reference",
    title: "Q4 plan doc",
    description: "https://example.com/q4-plan",
    department: null,
    layer: "domain",
  },
  {
    type: "preference",
    title: "Direct tone in writing",
    description: "Prefer concise direct prose over hedged paragraphs.",
    department: null,
    layer: "identity",
  },
]);

function makeLlmReturning(response: string): ExtractionLlm {
  return { generate: vi.fn().mockResolvedValue(response) };
}

function makeRejectingLlm(error: Error): ExtractionLlm {
  return { generate: vi.fn().mockRejectedValue(error) };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("extractMemoryCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Happy path ────────────────────────────────────────────────────────
  it("returns structured candidates from a mock LLM", async () => {
    const llm = makeLlmReturning(MIXED_LLM_RESPONSE);

    const db = createSequenceDb([
      // 1. discussions privacy gate
      PRIVACY_ALLOWED,
      // 2. entries window: two entries, both with substantive content
      [
        entryRow("e1", "Decided Tailwind. Need to draft Q4 OKRs.", new Date("2026-05-01T00:00:00Z")),
        entryRow("e2", "Renewal cohort skews enterprise. See https://example.com/q4-plan", new Date("2026-05-02T00:00:00Z")),
      ],
      // 3. departments list
      [deptRow("dept-eng", "Engineering")],
    ]);

    const result = await extractMemoryCandidates(db as never, llm, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
    });

    expect(result.candidates).toHaveLength(5);
    expect(result.candidates.map((c) => c.type)).toEqual([
      "decision",
      "task",
      "insight",
      "reference",
      "preference",
    ]);
    // Verify shape: a representative candidate has the schema-aligned field
    // names (suggestedLayer, suggestedPriority, suggestedDepartment), not the
    // legacy `layer` / `priority` / `department` names.
    const decision: MemoryCandidate = result.candidates[0];
    expect(decision.type).toBe("decision");
    expect(decision.title).toBe("Use Tailwind for the dashboard");
    expect(decision.suggestedLayer).toBe("domain");
    expect(decision.suggestedPriority).toBeNull();
    expect(decision.suggestedDepartment).toBe("Engineering");

    // Task candidate carries the suggestedPriority that only `task` items
    // ever get from the legacy parser.
    const task = result.candidates.find((c) => c.type === "task")!;
    expect(task.suggestedPriority).toBe("high");

    // LLM was invoked exactly once with the system prompt + user content.
    expect(llm.generate).toHaveBeenCalledTimes(1);
    const [systemPrompt, userContent] = (llm.generate as any).mock.calls[0];
    expect(systemPrompt).toContain("Available departments and projects");
    expect(systemPrompt).toContain("Engineering");
    expect(userContent).toContain("Decided Tailwind");
    expect(userContent).toContain("Renewal cohort");
    // Multi-entry content is concatenated with the legacy thread separator.
    expect(userContent).toContain("---");
  });

  // ── 2. sinceEntryId cursor ───────────────────────────────────────────────
  it("respects the sinceEntryId cursor (only entries after the named entry are considered)", async () => {
    const llm = makeLlmReturning(JSON.stringify([
      {
        type: "decision",
        title: "Post-cursor decision",
        description: "Only the post-cursor entry produces this.",
        department: null,
        layer: "domain",
      },
    ]));

    const cursorCreatedAt = new Date("2026-05-02T00:00:00Z");
    const db = createSequenceDb([
      // 1. discussions privacy gate
      PRIVACY_ALLOWED,
      // 2. cursor lookup: sinceEntryId='e1' was created at the named time
      [{ createdAt: cursorCreatedAt }],
      // 3. entries window: only the post-cursor entry (e2) is returned by
      //    the gt(createdAt, cursor) predicate. The mock DB doesn't actually
      //    enforce the predicate — but the extractor builds it from
      //    cursorCreatedAt and trusts the query result. We assert this by
      //    feeding ONLY the post-cursor entry into the select result and
      //    confirming the LLM gets only that content.
      [entryRow("e2", "Post-cursor content with a real decision.", new Date("2026-05-03T00:00:00Z"))],
      // 4. departments list (empty for brevity)
      [],
    ]);

    const result = await extractMemoryCandidates(db as never, llm, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
      sinceEntryId: "e1",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].title).toBe("Post-cursor decision");
    // Sequence: discussions gate → cursor select → entries select → departments select (4 calls)
    expect(db.selectCalls).toHaveLength(4);
    expect(db.selectCalls[0].fromTable).toBe("discussions");        // privacy gate
    expect(db.selectCalls[1].fromTable).toBe("discussion_entries"); // cursor lookup
    expect(db.selectCalls[2].fromTable).toBe("discussion_entries"); // entries window
    expect(db.selectCalls[3].fromTable).toBe("projects");           // departments list

    // LLM saw ONLY the post-cursor content (no pre-cursor leak).
    const [, userContent] = (llm.generate as any).mock.calls[0];
    expect(userContent).toContain("Post-cursor content");
  });

  // ── 6. Empty thread / short content ──────────────────────────────────────
  it("returns empty candidates and does NOT invoke the LLM when the thread has no entries", async () => {
    const llm = makeLlmReturning(MIXED_LLM_RESPONSE);

    const db = createSequenceDb([
      // 1. discussions privacy gate
      PRIVACY_ALLOWED,
      // 2. entries window: zero entries (e.g. a brand-new thread)
      [],
    ]);

    const result = await extractMemoryCandidates(db as never, llm, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
    });

    expect(result.candidates).toEqual([]);
    expect(llm.generate).not.toHaveBeenCalled();
    // discussions gate + entries fetch — departments are NOT queried because
    // the empty-entries short-circuit fires after entries fetch.
    expect(db.selectCalls).toHaveLength(2);
  });

  it("returns empty candidates when entries exist but every entry is empty/whitespace-only", async () => {
    const llm = makeLlmReturning(MIXED_LLM_RESPONSE);

    const db = createSequenceDb([
      PRIVACY_ALLOWED,
      // entries exist, but raw content is short (the joined content fails the
      // length check used by the legacy autonomous path)
      [
        entryRow("e1", "", new Date("2026-05-01T00:00:00Z")),
        entryRow("e2", "   ", new Date("2026-05-02T00:00:00Z")),
      ],
    ]);

    const result = await extractMemoryCandidates(db as never, llm, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
    });

    expect(result.candidates).toEqual([]);
    expect(llm.generate).not.toHaveBeenCalled();
  });

  // ── 7. LLM error path ────────────────────────────────────────────────────
  it("rejects when the LLM throws (does not swallow the error)", async () => {
    const llmErr = new Error("provider quota exceeded");
    const llm = makeRejectingLlm(llmErr);

    const db = createSequenceDb([
      PRIVACY_ALLOWED,
      [entryRow("e1", "Some substantive content for the extractor to chew on.", new Date())],
      [deptRow("dept-eng", "Engineering")],
    ]);

    await expect(
      extractMemoryCandidates(db as never, llm, {
        companyId: COMPANY_ID,
        threadId: THREAD_ID,
      }),
    ).rejects.toThrow("provider quota exceeded");

    expect(llm.generate).toHaveBeenCalledTimes(1);
  });

  // ── Cursor-missing fallback ──────────────────────────────────────────────
  it("falls back to full thread when sinceEntryId references a non-existent entry", async () => {
    const llm = makeLlmReturning(JSON.stringify([]));

    const db = createSequenceDb([
      // 1. discussions privacy gate
      PRIVACY_ALLOWED,
      // 2. cursor lookup: sinceEntryId='ghost' returns no rows
      [],
      // 3. entries window: full thread (the extractor's fallback path)
      [entryRow("e1", "Fallback content because cursor was missing.", new Date())],
      // 4. departments list
      [],
    ]);

    const result = await extractMemoryCandidates(db as never, llm, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
      sinceEntryId: "ghost",
    });

    expect(result.candidates).toEqual([]);
    expect(llm.generate).toHaveBeenCalledTimes(1);
    expect(db.selectCalls).toHaveLength(4);
  });
});

// ── 3-5. Filtered helpers ────────────────────────────────────────────────────

describe("extractDecisions / extractInsights / extractReferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Reusable DB factory: every filtered-helper test feeds the same MIXED
   * payload through the LLM and asserts the helper filters down to its type.
   */
  function makeMixedThreadDb() {
    return createSequenceDb([
      PRIVACY_ALLOWED,
      [entryRow("e1", "Mixed thread content covering all five types.", new Date())],
      [deptRow("dept-eng", "Engineering")],
    ]);
  }

  it("extractDecisions returns only type='decision' candidates", async () => {
    const llm = makeLlmReturning(MIXED_LLM_RESPONSE);
    const db = makeMixedThreadDb();

    const decisions = await extractDecisions(db as never, llm, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0].type).toBe("decision");
    expect(decisions[0].title).toBe("Use Tailwind for the dashboard");
    // Non-decision types are excluded.
    expect(decisions.find((c) => c.type === "task")).toBeUndefined();
    expect(decisions.find((c) => c.type === "insight")).toBeUndefined();
  });

  it("extractInsights returns only type='insight' candidates", async () => {
    const llm = makeLlmReturning(MIXED_LLM_RESPONSE);
    const db = makeMixedThreadDb();

    const insights = await extractInsights(db as never, llm, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
    });

    expect(insights).toHaveLength(1);
    expect(insights[0].type).toBe("insight");
    expect(insights[0].title).toBe("Renewal cohort skews enterprise");
  });

  it("extractReferences returns only type='reference' candidates", async () => {
    const llm = makeLlmReturning(MIXED_LLM_RESPONSE);
    const db = makeMixedThreadDb();

    const references = await extractReferences(db as never, llm, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
    });

    expect(references).toHaveLength(1);
    expect(references[0].type).toBe("reference");
    expect(references[0].title).toBe("Q4 plan doc");
  });

  it("filtered helpers return an empty array when the LLM yields no candidates of the requested type", async () => {
    // LLM emits only a task — neither decision/insight/reference should match.
    const llm = makeLlmReturning(JSON.stringify([
      {
        type: "task",
        title: "Some action item",
        description: "Just a task, nothing else.",
        priority: "medium",
        department: null,
        layer: "working",
      },
    ]));
    const db = makeMixedThreadDb();

    const decisions = await extractDecisions(db as never, llm, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
    });
    expect(decisions).toEqual([]);
  });
});
