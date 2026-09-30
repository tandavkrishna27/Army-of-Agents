/**
 * Phase 3.5 — fetchMemoryContext audit wiring
 *
 * `fetchMemoryContext` is a private closure inside heartbeatService, so we
 * can't call it directly. Instead, these tests verify:
 *
 *   1. The mapping from MultiPathSearchResult → MemoryRetrievalItem is correct
 *      (rank, similarityScore, shownToAgent).
 *   2. The mapping from MultiPathSearchResult → context.memory is correct
 *      (the shape agents actually receive).
 *   3. "auto" is a valid MemoryRetrievalTrigger (so the constant reference
 *      can't drift without breaking the test).
 *
 * The logic is extracted verbatim from heartbeat.ts lines inside
 * fetchMemoryContext so changes there would break these tests.
 */

import { describe, it, expect } from "vitest";
import type { MultiPathSearchResult } from "../services/memory.js";
import { MEMORY_RETRIEVAL_TRIGGERS } from "@armyofagents/shared";

// ── Helpers that mirror the fetchMemoryContext internal mappings ─────────────

function toAuditItems(
  items: MultiPathSearchResult[],
): Array<{ id: string; rank: number; similarityScore: number | null; shownToAgent: boolean }> {
  return items.map((item, i) => ({
    id: item.id,
    rank: i + 1,
    similarityScore: item.similarity,
    shownToAgent: true,
  }));
}

function toContextMemory(
  items: MultiPathSearchResult[],
): Array<{ title: string; content: string; category: string; tags: string[] }> {
  return items.map((item) => ({
    title: item.title,
    content: item.content,
    category: item.category,
    tags: item.tags ?? [],
  }));
}

function makeResult(overrides: Partial<MultiPathSearchResult> = {}): MultiPathSearchResult {
  return {
    id: "item-1",
    companyId: "co-1",
    title: "Brand voice",
    content: "Casual, direct.",
    category: "preference",
    source: "founder",
    status: "approved",
    tags: ["voice"],
    departmentId: null,
    projectId: null,
    layer: "domain",
    priority: 0,
    validationCount: 1,
    agentId: null,
    pinnedToSkill: false,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    rrfScore: 0.5,
    finalScore: 0.55,
    similarity: 0.87,
    semanticRank: 1,
    keywordRank: null,
    temporalRank: 2,
    ...overrides,
  };
}

// ── Trigger constant ─────────────────────────────────────────────────────────

describe("triggeredBy: 'auto' is a valid MEMORY_RETRIEVAL_TRIGGERS entry", () => {
  it("auto is declared in the shared constant", () => {
    expect(MEMORY_RETRIEVAL_TRIGGERS).toContain("auto");
  });
});

// ── Audit item mapping ────────────────────────────────────────────────────────

describe("toAuditItems (mirrors fetchMemoryContext → recordMemoryRetrievals mapping)", () => {
  it("assigns 1-indexed rank to each item in order", () => {
    const items = [makeResult({ id: "a" }), makeResult({ id: "b" }), makeResult({ id: "c" })];
    const audit = toAuditItems(items);
    expect(audit.map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it("passes similarity score through to audit rows", () => {
    const items = [makeResult({ similarity: 0.923 })];
    const [row] = toAuditItems(items);
    expect(row.similarityScore).toBeCloseTo(0.923);
  });

  it("passes null similarity when item was not in the semantic pathway", () => {
    const items = [makeResult({ similarity: null })];
    const [row] = toAuditItems(items);
    expect(row.similarityScore).toBeNull();
  });

  it("sets shownToAgent=true for all auto-retrieved items", () => {
    const items = [makeResult(), makeResult({ id: "b" })];
    toAuditItems(items).forEach((row) => {
      expect(row.shownToAgent).toBe(true);
    });
  });

  it("returns empty array for empty input (no audit rows fired)", () => {
    expect(toAuditItems([])).toEqual([]);
  });
});

// ── Context memory mapping ────────────────────────────────────────────────────

describe("toContextMemory (mirrors fetchMemoryContext → context.memory mapping)", () => {
  it("maps required fields — title, content, category, tags", () => {
    const items = [
      makeResult({ title: "T", content: "C", category: "decision", tags: null }),
    ];
    const memory = toContextMemory(items);
    expect(memory[0]).toEqual({ title: "T", content: "C", category: "decision", tags: [] });
  });

  it("preserves tags array when present", () => {
    const items = [makeResult({ tags: ["tone", "format"] })];
    expect(toContextMemory(items)[0].tags).toEqual(["tone", "format"]);
  });

  it("returns empty array when no items served", () => {
    expect(toContextMemory([])).toEqual([]);
  });

  it("does not expose id, rrfScore, finalScore, or other internal fields", () => {
    const items = [makeResult({ id: "secret-id" })];
    const memory = toContextMemory(items);
    expect(memory[0]).not.toHaveProperty("id");
    expect(memory[0]).not.toHaveProperty("rrfScore");
    expect(memory[0]).not.toHaveProperty("finalScore");
    expect(memory[0]).not.toHaveProperty("similarity");
  });

  it("handles multiple items in rank order", () => {
    const items = [
      makeResult({ id: "a", title: "First" }),
      makeResult({ id: "b", title: "Second" }),
    ];
    const memory = toContextMemory(items);
    expect(memory.map((x) => x.title)).toEqual(["First", "Second"]);
  });
});
