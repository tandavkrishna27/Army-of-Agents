// server/src/__tests__/inbox-similarity.test.ts
//
// Task 1.1 (Inbound Dirty-Data Routing) — findSimilarThreadsScored
//
// Tests the reusable service function that surfaces cosine distances for the
// inbound router (top-1 confidence + top-1-vs-top-2 ambiguity gap, Codex #10).
//
// Mock style mirrors c2-memory-find-similar.test.ts and c2-thread-find-similar.test.ts:
//   - db.select().from().where().orderBy().limit() fluent chain
//   - embed fn passed as dependency (no ctx / ServiceContainer needed)

import { describe, expect, it, vi } from "vitest";
import {
  findSimilarThreadsScored,
} from "../services/internal-agent/tools/thread-find-similar.js";

// ─── DB mock helpers ──────────────────────────────────────────────────────────

/**
 * Build a mock db that resolves the fluent .select().from().where().orderBy().limit()
 * chain and returns `rows` as the resolved value.
 */
function makeDbReturning(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as any, limitMock: limit, selectMock: select };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("findSimilarThreadsScored (Task 1.1)", () => {
  // ── Fail-closed / available:false ──────────────────────────────────────────

  it("returns {available:false, results:[]} when embedText is undefined", async () => {
    const { db } = makeDbReturning([]);
    const result = await findSimilarThreadsScored({
      db,
      embedText: undefined,
      companyId: "co-1",
      text: "auth refactor",
    });
    expect(result.available).toBe(false);
    expect(result.results).toEqual([]);
  });

  it("returns {available:false, results:[]} when embedText is null", async () => {
    const { db } = makeDbReturning([]);
    const result = await findSimilarThreadsScored({
      db,
      embedText: null,
      companyId: "co-1",
      text: "auth refactor",
    });
    expect(result.available).toBe(false);
    expect(result.results).toEqual([]);
  });

  it("returns {available:false, results:[]} when embedText throws", async () => {
    const { db } = makeDbReturning([]);
    const embedText = vi.fn().mockRejectedValue(new Error("OpenAI 429"));
    const result = await findSimilarThreadsScored({
      db,
      embedText,
      companyId: "co-1",
      text: "auth refactor",
    });
    expect(result.available).toBe(false);
    expect(result.results).toEqual([]);
    expect(embedText).toHaveBeenCalledOnce();
  });

  it("does NOT call db when embedText is absent (fail-closed before DB hit)", async () => {
    const { db, selectMock } = makeDbReturning([]);
    await findSimilarThreadsScored({
      db,
      embedText: undefined,
      companyId: "co-1",
      text: "x",
    });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("does NOT call db when embedText throws (fail-closed before DB hit)", async () => {
    const { db, selectMock } = makeDbReturning([]);
    const embedText = vi.fn().mockRejectedValue(new Error("fail"));
    await findSimilarThreadsScored({
      db,
      embedText,
      companyId: "co-1",
      text: "x",
    });
    expect(selectMock).not.toHaveBeenCalled();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("returns {available:true, results} with distance per row, ordered ASC", async () => {
    const rows = [
      { threadId: "t-1", distance: 0.05 },
      { threadId: "t-2", distance: 0.23 },
      { threadId: "t-3", distance: 0.41 },
    ];
    const { db } = makeDbReturning(rows);
    const embedText = vi.fn().mockResolvedValue(new Array(1536).fill(0.001));

    const result = await findSimilarThreadsScored({
      db,
      embedText,
      companyId: "co-1",
      text: "auth flow redesign",
    });

    expect(result.available).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toEqual({ threadId: "t-1", distance: 0.05 });
    expect(result.results[1]).toEqual({ threadId: "t-2", distance: 0.23 });
    expect(result.results[2]).toEqual({ threadId: "t-3", distance: 0.41 });
    expect(embedText).toHaveBeenCalledOnce();
    expect(embedText).toHaveBeenCalledWith("auth flow redesign");
  });

  it("returns {available:true, results:[]} when db returns empty set", async () => {
    const { db } = makeDbReturning([]);
    const embedText = vi.fn().mockResolvedValue(new Array(1536).fill(0));

    const result = await findSimilarThreadsScored({
      db,
      embedText,
      companyId: "co-1",
      text: "obscure topic no threads match",
    });

    expect(result.available).toBe(true);
    expect(result.results).toEqual([]);
  });

  // ── Distance coercion ──────────────────────────────────────────────────────

  it("coerces distance values to Number (handles string-typed db output)", async () => {
    // pgvector sometimes returns distance as a string from the driver layer.
    const rows = [{ threadId: "t-1", distance: "0.123" }];
    const { db } = makeDbReturning(rows);
    const embedText = vi.fn().mockResolvedValue(new Array(1536).fill(0));

    const result = await findSimilarThreadsScored({
      db,
      embedText,
      companyId: "co-1",
      text: "x",
    });

    expect(result.available).toBe(true);
    expect(typeof result.results[0].distance).toBe("number");
    expect(result.results[0].distance).toBeCloseTo(0.123);
  });

  // ── Limit / default ────────────────────────────────────────────────────────

  it("defaults to limit=5 when not specified", async () => {
    const { db, limitMock } = makeDbReturning([]);
    const embedText = vi.fn().mockResolvedValue(new Array(1536).fill(0));

    await findSimilarThreadsScored({
      db,
      embedText,
      companyId: "co-1",
      text: "x",
    });

    expect(limitMock).toHaveBeenCalledWith(5);
  });

  it("respects the limit parameter", async () => {
    const { db, limitMock } = makeDbReturning([]);
    const embedText = vi.fn().mockResolvedValue(new Array(1536).fill(0));

    await findSimilarThreadsScored({
      db,
      embedText,
      companyId: "co-1",
      text: "x",
      limit: 3,
    });

    expect(limitMock).toHaveBeenCalledWith(3);
  });

  it("caps limit at MAX_LIMIT=25", async () => {
    const { db, limitMock } = makeDbReturning([]);
    const embedText = vi.fn().mockResolvedValue(new Array(1536).fill(0));

    await findSimilarThreadsScored({
      db,
      embedText,
      companyId: "co-1",
      text: "x",
      limit: 999,
    });

    expect(limitMock).toHaveBeenCalledWith(25);
  });

  // ── Router usage pattern: top-1 confidence + top-1-vs-top-2 gap ───────────

  it("enables router to compute top-1 distance and ambiguity gap (Codex #10)", async () => {
    const rows = [
      { threadId: "t-1", distance: 0.12 },
      { threadId: "t-2", distance: 0.45 },
    ];
    const { db } = makeDbReturning(rows);
    const embedText = vi.fn().mockResolvedValue(new Array(1536).fill(0));

    const result = await findSimilarThreadsScored({
      db,
      embedText,
      companyId: "co-1",
      text: "some inbound content",
      limit: 2,
    });

    expect(result.available).toBe(true);
    const top1Distance = result.results[0].distance;  // 0.12 — confidence gate input
    const gap = result.results[1].distance - result.results[0].distance; // 0.33 — ambiguity gap
    expect(top1Distance).toBeCloseTo(0.12);
    expect(gap).toBeCloseTo(0.33);
  });
});
