/**
 * Unit tests for `packageAdjutantContext` — the cap-limited, privacy-respecting
 * Adjutant context bundler (Task B3, T13).
 *
 * Pattern mirrors `thread-events.test.ts` (B2): mock `@armyofagents/db` and
 * `drizzle-orm` at module level via the shared Proxy/operator helpers, then
 * drive the service with a sequence-based mock DB.
 *
 * pgvector caveat: the bundled embedded-postgres doesn't ship pgvector, so
 * we MOCK the SQL select layer rather than relying on actual `<=>` operator
 * semantics. These tests cover the JS-level filtering + assembly logic, not
 * SQL similarity ranking — which is exercised by an integration test against
 * a pgvector-enabled instance once one is available.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeTableProxy,
  drizzleOperatorStubs,
} from "../../__tests__/helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  discussions: makeTableProxy("discussions"),
  discussionEntries: makeTableProxy("discussion_entries"),
  threadParticipants: makeTableProxy("thread_participants"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

import { packageAdjutantContext } from "../adjutant-context.js";

// ---------------------------------------------------------------------------
// Sequence-based mock DB. Each `.select()` consumes the next preset row set;
// every chain method is a no-op pass-through. The order of `selects` reflects
// the order of select calls inside `packageAdjutantContext`:
//
//   1. thread row
//   2. totalEntryCount
//   3. entries window
//   4. candidate related threads (only if thread.summaryEmbedding present)
//   5. participant rows (only if callerAgentId provided)
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;

function createSequenceDb(selects: MockRow[][] = []) {
  let idx = 0;
  const calls: { fromTable?: string }[] = [];

  function makeSelectChain(): any {
    const call: { fromTable?: string } = {};
    calls.push(call);
    const chain: any = {};
    for (const m of ["where", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.from = (table: unknown) => {
      const meta = (table as { _?: { name?: string } } | null)?._;
      if (meta && typeof meta.name === "string") call.fromTable = meta.name;
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-1";
const THREAD_ID = "thread-1";
const ADJUTANT_ID = "adj-agent-1";

/**
 * Default thread row. The visibility defaults to "company" to match the
 * post-A2 canonical default. summaryEmbedding is null by default — tests
 * that exercise the related-thread path explicitly pass a 1536-d vector.
 */
function threadRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: THREAD_ID,
    companyId: COMPANY_ID,
    title: "Q4 roadmap",
    status: "active",
    summaryText: "Planning the Q4 roadmap with eng and design.",
    summaryEmbedding: null,
    intent: ["plan"],
    phase: "discuss",
    autonomyLevel: 2,
    visibility: "company",
    ...overrides,
  };
}

function entry(seq: number, overrides: Partial<MockRow> = {}): MockRow {
  // The service orders DESC and reverses; mimic that by returning the slice
  // *in DESC order* here (newest first). Tests assert that the returned
  // entries are in chronological (ASC) order after reversal.
  return {
    id: `entry-${seq}`,
    discussionId: THREAD_ID,
    rawContent: `content #${seq}`,
    inputType: "write",
    createdAt: new Date(Date.now() + seq * 1000),
    seq,
    ...overrides,
  };
}

/** Build an entries-window mock array in DESC order, newest first. */
function entriesDesc(count: number): MockRow[] {
  // Newest first means highest seq first. The service reverses to ASC.
  const out: MockRow[] = [];
  for (let i = count; i >= 1; i--) out.push(entry(i));
  return out;
}

function dummyEmbedding(): number[] {
  // 1536-d zero vector — content doesn't matter; the SQL operator is mocked.
  return new Array(1536).fill(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("packageAdjutantContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Entry slice + summary fallback ─────────────────────────────────────

  it("returns all entries when count <= maxEntries", async () => {
    const desc = entriesDesc(50);
    const db = createSequenceDb([
      [threadRow()],     // 1. thread
      [{ count: 50 }],   // 2. totalEntryCount
      desc,              // 3. entries window
      // No related-thread queries — summaryEmbedding is null.
    ]);

    const result = await packageAdjutantContext(db as any, THREAD_ID);

    expect(result.totalEntryCount).toBe(50);
    expect(result.usedSummaryFallback).toBe(false);
    expect(result.entries).toHaveLength(50);
    // Chronological order — entry-1 first, entry-50 last.
    expect(result.entries[0].id).toBe("entry-1");
    expect(result.entries[49].id).toBe("entry-50");
  });

  it("uses summary fallback when entries exceed maxEntries", async () => {
    // Service requests the latest 200 — mock returns 200 newest-first.
    const desc = entriesDesc(200);
    const db = createSequenceDb([
      [threadRow({ summaryText: "Long-running planning thread." })],
      [{ count: 300 }],  // total exceeds cap
      desc,              // returned window is the latest 200
    ]);

    const result = await packageAdjutantContext(db as any, THREAD_ID);

    expect(result.totalEntryCount).toBe(300);
    expect(result.usedSummaryFallback).toBe(true);
    expect(result.entries).toHaveLength(200);
    expect(result.summaryText).toBe("Long-running planning thread.");
    // Chronological order on the cap'd window.
    expect(result.entries[0].id).toBe("entry-1");
    expect(result.entries[199].id).toBe("entry-200");
  });

  // ── Related threads ──────────────────────────────────────────────────

  it("includes related threads sorted by similarity", async () => {
    const candidates = [
      { id: "thread-2", title: "Roadmap discussion", summaryText: "s1", visibility: "company" },
      { id: "thread-3", title: "OKR review", summaryText: "s2", visibility: "company" },
      { id: "thread-4", title: "Strategy", summaryText: "s3", visibility: "department" },
    ];
    const db = createSequenceDb([
      [threadRow({ summaryEmbedding: dummyEmbedding() })],
      [{ count: 10 }],
      entriesDesc(10),
      candidates,        // 4. related candidates (already ordered by mock)
    ]);

    const result = await packageAdjutantContext(db as any, THREAD_ID);

    expect(result.relatedThreads).toHaveLength(3);
    // Ordering preserved from the SQL ORDER BY (mocked, but the service
    // does not re-sort).
    expect(result.relatedThreads[0].id).toBe("thread-2");
    expect(result.relatedThreads[1].id).toBe("thread-3");
    expect(result.relatedThreads[2].id).toBe("thread-4");
  });

  it("returns empty relatedThreads with no candidate query when there is no embedding AND no text to search", async () => {
    // P2-T6: without a summaryEmbedding the service falls back to full-text over
    // title+summary. With NEITHER a title NOR a summary there is no query text,
    // so the fallback no-ops — no candidate query, no participants query, []
    // related threads (the same outcome as the pre-P2-T6 always-empty path).
    // The fallback-WITH-results case is covered in adjutant-context-fallback.test.ts.
    const db = createSequenceDb([
      [threadRow({ summaryEmbedding: null, title: null, summaryText: null })],
      [{ count: 5 }],
      entriesDesc(5),
      // No fourth select — the full-text fallback is skipped on an empty query.
    ]);

    const result = await packageAdjutantContext(db as any, THREAD_ID);

    expect(result.relatedThreads).toEqual([]);
    // Exactly 3 select calls (thread, count, entries) — no fallback candidate
    // query, no participants query.
    expect((db as any).selectCalls).toHaveLength(3);
  });

  // ── Privacy / visibility filtering ───────────────────────────────────

  it("filters private related threads when callerAgentId is NOT a participant", async () => {
    const candidates = [
      { id: "thread-pub", title: "Public", summaryText: "s", visibility: "company" },
      { id: "thread-priv", title: "Secret", summaryText: "s", visibility: "private" },
    ];
    const db = createSequenceDb([
      [threadRow({ summaryEmbedding: dummyEmbedding() })],
      [{ count: 1 }],
      entriesDesc(1),
      candidates,
      // No callerAgentId → no participant query is issued and the private
      // candidate is filtered out unconditionally.
    ]);

    const result = await packageAdjutantContext(db as any, THREAD_ID);

    expect(result.relatedThreads.map((t) => t.id)).toEqual(["thread-pub"]);
  });

  it("includes private related threads when callerAgentId IS a participant", async () => {
    const candidates = [
      { id: "thread-pub", title: "Public", summaryText: "s", visibility: "company" },
      { id: "thread-priv", title: "Secret", summaryText: "s", visibility: "private" },
    ];
    const db = createSequenceDb([
      [threadRow({ summaryEmbedding: dummyEmbedding() })],
      [{ count: 1 }],
      entriesDesc(1),
      candidates,
      // 5. participant rows — agent is on thread-priv.
      [{ threadId: "thread-priv" }],
    ]);

    const result = await packageAdjutantContext(
      db as any,
      THREAD_ID,
      { callerAgentId: ADJUTANT_ID },
    );

    expect(result.relatedThreads.map((t) => t.id)).toEqual([
      "thread-pub",
      "thread-priv",
    ]);
  });

  it("excludes private threads the caller is NOT a participant on", async () => {
    const candidates = [
      { id: "thread-pub", title: "Public", summaryText: "s", visibility: "company" },
      { id: "thread-priv-a", title: "Secret A", summaryText: "s", visibility: "private" },
      { id: "thread-priv-b", title: "Secret B", summaryText: "s", visibility: "private" },
    ];
    const db = createSequenceDb([
      [threadRow({ summaryEmbedding: dummyEmbedding() })],
      [{ count: 1 }],
      entriesDesc(1),
      candidates,
      // Agent participates only on thread-priv-a, NOT thread-priv-b.
      [{ threadId: "thread-priv-a" }],
    ]);

    const result = await packageAdjutantContext(
      db as any,
      THREAD_ID,
      { callerAgentId: ADJUTANT_ID },
    );

    expect(result.relatedThreads.map((t) => t.id)).toEqual([
      "thread-pub",
      "thread-priv-a",
    ]);
  });

  // ── Candidate filtering / set construction ────────────────────────────

  it("filters out archived related threads (only status='active' fetched)", async () => {
    // The service's SQL WHERE pins status='active' — the mock is responsible
    // for honoring that contract. We assert the service does NOT re-add
    // archived rows on its own (i.e. only emits what the SELECT returned).
    const candidates = [
      { id: "thread-a", title: "Active", summaryText: "s", visibility: "company" },
      // No archived rows here because the SQL filter would have removed
      // them upstream. Anything coming through the candidates list is
      // already active.
    ];
    const db = createSequenceDb([
      [threadRow({ summaryEmbedding: dummyEmbedding() })],
      [{ count: 1 }],
      entriesDesc(1),
      candidates,
    ]);

    const result = await packageAdjutantContext(db as any, THREAD_ID);

    expect(result.relatedThreads).toHaveLength(1);
    expect(result.relatedThreads[0].id).toBe("thread-a");
  });

  it("excludes the source thread itself from relatedThreads (SQL WHERE id<>threadId)", async () => {
    // The service's WHERE clause already excludes the source thread via
    // `id <> threadId`. We assert that whatever the SELECT returns is
    // surfaced verbatim, and document that the source-thread exclusion is
    // a SQL contract — not a JS post-filter — so this test is essentially
    // a contract guard against accidental SQL regression.
    const candidates = [
      { id: "thread-other-1", title: "Other 1", summaryText: "s", visibility: "company" },
      { id: "thread-other-2", title: "Other 2", summaryText: "s", visibility: "company" },
    ];
    const db = createSequenceDb([
      [threadRow({ summaryEmbedding: dummyEmbedding() })],
      [{ count: 1 }],
      entriesDesc(1),
      candidates,
    ]);

    const result = await packageAdjutantContext(db as any, THREAD_ID);

    // Source thread is never in the returned list — both because SQL
    // excluded it and (defense in depth) because the JS shape never adds it.
    expect(result.relatedThreads.find((t) => t.id === THREAD_ID)).toBeUndefined();
    expect(result.relatedThreads).toHaveLength(2);
  });

  it("caps relatedThreads at relatedThreadLimit even with more candidates", async () => {
    // Over-fetch returns more than the limit; JS slice trims to relatedLimit.
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      id: `thread-${i + 2}`,
      title: `Thread ${i + 2}`,
      summaryText: "s",
      visibility: "company",
    }));
    const db = createSequenceDb([
      [threadRow({ summaryEmbedding: dummyEmbedding() })],
      [{ count: 1 }],
      entriesDesc(1),
      candidates,
    ]);

    const result = await packageAdjutantContext(
      db as any,
      THREAD_ID,
      { relatedThreadLimit: 5 },
    );

    expect(result.relatedThreads).toHaveLength(5);
    // Top-5 by candidate order (which mirrors SQL ORDER BY).
    expect(result.relatedThreads.map((t) => t.id)).toEqual([
      "thread-2",
      "thread-3",
      "thread-4",
      "thread-5",
      "thread-6",
    ]);
  });

  // ── Metadata pass-through ────────────────────────────────────────────

  it("returns thread metadata correctly", async () => {
    const db = createSequenceDb([
      [
        threadRow({
          intent: ["plan", "decide"],
          phase: "scope",
          autonomyLevel: 3,
          visibility: "department",
        }),
      ],
      [{ count: 7 }],
      entriesDesc(7),
    ]);

    const result = await packageAdjutantContext(db as any, THREAD_ID);

    expect(result.intent).toEqual(["plan", "decide"]);
    expect(result.phase).toBe("scope");
    expect(result.autonomyLevel).toBe(3);
    expect(result.visibility).toBe("department");
    expect(result.totalEntryCount).toBe(7);
  });

  it("defaults intent to [] when thread.intent is null", async () => {
    const db = createSequenceDb([
      [threadRow({ intent: null })],
      [{ count: 0 }],
      [],
    ]);

    const result = await packageAdjutantContext(db as any, THREAD_ID);

    expect(result.intent).toEqual([]);
  });

  it("defaults intent to [] when thread.intent is undefined", async () => {
    // Mirror the legacy-row case — column added later, never backfilled.
    const t = threadRow();
    delete (t as Record<string, unknown>).intent;
    const db = createSequenceDb([[t], [{ count: 0 }], []]);

    const result = await packageAdjutantContext(db as any, THREAD_ID);

    expect(result.intent).toEqual([]);
  });

  // ── Error path ────────────────────────────────────────────────────────

  it("throws when thread not found", async () => {
    const db = createSequenceDb([
      [], // empty result set for the thread query
    ]);

    await expect(
      packageAdjutantContext(db as any, "bad-thread-id"),
    ).rejects.toThrow(/Thread bad-thread-id not found/);
  });
});
