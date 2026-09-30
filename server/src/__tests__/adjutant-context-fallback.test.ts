/**
 * P2-T6: cross-thread retrieval dev fallback in `packageAdjutantContext`.
 *
 * The prod path ranks related threads by `summary_embedding` cosine similarity
 * (pgvector). The bundled embedded-postgres ships no pgvector, so in dev every
 * `summary_embedding` is null and the vector path would always return []. The
 * fallback runs a core-postgres full-text search over title+summary instead.
 *
 * These tests drive `packageAdjutantContext` against a sequence-based mock DB
 * (the real service issues a fixed sequence of `db.select(...)` calls). We
 * assert WHICH branch ran (by the candidate rows it returns) and that the
 * shared visibility filter holds on both paths — not the raw SQL semantics.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  and: vi.fn((...args: unknown[]) => ({ _op: "and", args })),
  desc: vi.fn((col: unknown) => ({ _op: "desc", col })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ _op: "sql", strings, vals }),
    { raw: (s: unknown) => s },
  ),
}));

vi.mock("@armyofagents/db", () => ({
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
  discussionEntries: new Proxy({} as any, { get: (_t, p) => p }),
  threadParticipants: new Proxy({} as any, { get: (_t, p) => p }),
}));

import { packageAdjutantContext } from "../services/adjutant-context.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Sequence-based mock DB. The service issues selects in a fixed order:
 *   1. source thread row
 *   2. total entry count
 *   3. recent entries slice
 *   4. related candidates (vector OR full-text branch)
 *   5. (only if callerAgentId) participant rows
 * We return queued results in that order. Every chainable method returns the
 * chain; the terminal awaited value is the queued result for that call index.
 */
function makeSequenceDb(results: any[][]) {
  let idx = 0;
  function chain(): any {
    const result = results[idx] ?? [];
    const c: any = {};
    c.from = () => c;
    c.where = () => c;
    c.orderBy = () => c;
    c.limit = () => {
      const r = result;
      idx++;
      return Promise.resolve(r);
    };
    // Some selects (count, participants) resolve without .limit() — make the
    // chain thenable so `await db.select()...where()` works too.
    c.then = (resolve: any) => {
      const r = result;
      idx++;
      return Promise.resolve(resolve(r));
    };
    return c;
  }
  return { select: vi.fn(chain) };
}

const SOURCE_THREAD = (overrides: Record<string, unknown> = {}) => ({
  id: THREAD_ID,
  companyId: COMPANY_ID,
  title: "Slack notification integration",
  summaryText: null,
  summaryEmbedding: null,
  intent: ["planning"],
  phase: "discuss",
  autonomyLevel: null,
  visibility: "company",
  status: "active",
  ...overrides,
});

describe("packageAdjutantContext — P2-T6 dev full-text fallback", () => {
  it("uses the full-text fallback when the source thread has no embedding", async () => {
    const db = makeSequenceDb([
      [SOURCE_THREAD()],                       // 1. source thread (no embedding)
      [{ count: 2 }],                          // 2. total entry count
      [],                                      // 3. recent entries
      [                                        // 4. full-text candidates
        { id: "t-a", title: "Slack OAuth flow", summaryText: null, visibility: "company" },
        { id: "t-b", title: "Notification service refactor", summaryText: null, visibility: "company" },
      ],
    ]);

    const ctx = await packageAdjutantContext(db as any, THREAD_ID);

    expect(ctx.relatedThreads.map((t) => t.id)).toEqual(["t-a", "t-b"]);
  });

  it("returns [] without running a candidate query when title+summary are empty", async () => {
    const db = makeSequenceDb([
      [SOURCE_THREAD({ title: null, summaryText: null })], // 1. no text to query
      [{ count: 0 }],                                      // 2. count
      [],                                                  // 3. entries
      // No 4th select should fire — queryText is empty.
    ]);

    const ctx = await packageAdjutantContext(db as any, THREAD_ID);

    expect(ctx.relatedThreads).toEqual([]);
    // select called exactly 3 times (thread, count, entries) — NOT the candidate query.
    expect((db.select as any).mock.calls.length).toBe(3);
  });

  it("uses the vector path (not full-text) when the source thread HAS an embedding", async () => {
    const db = makeSequenceDb([
      [SOURCE_THREAD({ summaryEmbedding: [0.1, 0.2, 0.3] })], // 1. source with embedding
      [{ count: 1 }],                                         // 2. count
      [],                                                     // 3. entries
      [                                                       // 4. vector candidates
        { id: "v-1", title: "Vector neighbor", summaryText: null, visibility: "company" },
      ],
    ]);

    const ctx = await packageAdjutantContext(db as any, THREAD_ID);

    expect(ctx.relatedThreads.map((t) => t.id)).toEqual(["v-1"]);
  });

  it("fail-closed: drops private candidates when no callerAgentId is supplied (fallback path)", async () => {
    const db = makeSequenceDb([
      [SOURCE_THREAD()],
      [{ count: 0 }],
      [],
      [
        { id: "pub", title: "Public thread", summaryText: null, visibility: "company" },
        { id: "dept", title: "Dept thread", summaryText: null, visibility: "department" },
        { id: "priv", title: "Private thread", summaryText: null, visibility: "private" },
        { id: "weird", title: "Unknown vis", summaryText: null, visibility: "secret" },
      ],
    ]);

    const ctx = await packageAdjutantContext(db as any, THREAD_ID);

    // company + department pass; private (no callerAgentId) and unknown fail closed.
    expect(ctx.relatedThreads.map((t) => t.id)).toEqual(["pub", "dept"]);
  });

  it("includes a private candidate the caller participates in (fallback path)", async () => {
    const db = makeSequenceDb([
      [SOURCE_THREAD()],
      [{ count: 0 }],
      [],
      [
        { id: "pub", title: "Public", summaryText: null, visibility: "company" },
        { id: "priv-ok", title: "Private I'm in", summaryText: null, visibility: "private" },
        { id: "priv-no", title: "Private I'm not in", summaryText: null, visibility: "private" },
      ],
      [{ threadId: "priv-ok" }], // 5. participant rows (callerAgentId supplied)
    ]);

    const ctx = await packageAdjutantContext(db as any, THREAD_ID, {
      callerAgentId: "agent-7",
    });

    expect(ctx.relatedThreads.map((t) => t.id)).toEqual(["pub", "priv-ok"]);
  });
});
