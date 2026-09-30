/**
 * Unit tests for the PINNED group derivation logic added in Task 6.
 *
 * These test pure selector functions extracted from the SessionsSidebar useMemo
 * derivations so they can be verified without a DOM / React render:
 *   - selectPinned(filtered): returns ≤5 pinned convs sorted by updatedAt desc
 *   - excludePinned(filtered, pinnedIds): removes the displayed-pinned set from filtered
 */

import { describe, it, expect } from "vitest";
import type { ConversationRow } from "../api/internal-agent";

// ─── Pure helpers (mirrors the SessionsSidebar useMemo logic) ───────────────

/** Returns top-5 pinned conversations sorted by updatedAt descending. */
function selectPinned(filtered: ConversationRow[]): ConversationRow[] {
  // pinnedAt not tracked; sort by updatedAt as proxy
  return filtered
    .filter((c) => c.pinned)
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .slice(0, 5);
}

/**
 * Returns filtered minus the conversations whose ids are in pinnedIds.
 * Conversations pinned beyond the cap (>5) are NOT in pinnedIds and therefore
 * remain visible in their date groups.
 */
function excludePinned(
  filtered: ConversationRow[],
  pinnedIds: Set<string>,
): ConversationRow[] {
  return filtered.filter((c) => !pinnedIds.has(c.id));
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeConv(
  id: string,
  opts: { pinned?: boolean; updatedAt?: string; title?: string } = {},
): ConversationRow {
  return {
    id,
    title: opts.title ?? `Session ${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: opts.updatedAt ?? "2026-01-01T00:00:00Z",
    messageCount: 0,
    userId: "user-1",
    pinned: opts.pinned ?? false,
  };
}

// ─── selectPinned ─────────────────────────────────────────────────────────────

describe("selectPinned", () => {
  it("returns empty array when no conversations are pinned", () => {
    const filtered = [makeConv("a"), makeConv("b"), makeConv("c")];
    expect(selectPinned(filtered)).toEqual([]);
  });

  it("returns only pinned conversations", () => {
    const filtered = [
      makeConv("a", { pinned: true }),
      makeConv("b", { pinned: false }),
      makeConv("c", { pinned: true }),
    ];
    const result = selectPinned(filtered);
    expect(result.map((c) => c.id).sort()).toEqual(["a", "c"]);
  });

  it("caps result at 5 even when more than 5 are pinned", () => {
    const filtered = Array.from({ length: 8 }, (_, i) =>
      makeConv(`id-${i}`, { pinned: true, updatedAt: `2026-01-0${i + 1}T00:00:00Z` }),
    );
    const result = selectPinned(filtered);
    expect(result).toHaveLength(5);
  });

  it("sorts pinned conversations by updatedAt descending (newest first)", () => {
    const filtered = [
      makeConv("older", { pinned: true, updatedAt: "2026-01-01T00:00:00Z" }),
      makeConv("newest", { pinned: true, updatedAt: "2026-05-01T00:00:00Z" }),
      makeConv("mid", { pinned: true, updatedAt: "2026-03-01T00:00:00Z" }),
    ];
    const result = selectPinned(filtered);
    expect(result.map((c) => c.id)).toEqual(["newest", "mid", "older"]);
  });

  it("returns at most 5 starting with the 5 most recently updated", () => {
    // 7 pinned, ascending dates — only the top 5 newest should be returned
    const filtered = [
      makeConv("p1", { pinned: true, updatedAt: "2026-01-01T00:00:00Z" }),
      makeConv("p2", { pinned: true, updatedAt: "2026-01-02T00:00:00Z" }),
      makeConv("p3", { pinned: true, updatedAt: "2026-01-03T00:00:00Z" }),
      makeConv("p4", { pinned: true, updatedAt: "2026-01-04T00:00:00Z" }),
      makeConv("p5", { pinned: true, updatedAt: "2026-01-05T00:00:00Z" }),
      makeConv("p6", { pinned: true, updatedAt: "2026-01-06T00:00:00Z" }),
      makeConv("p7", { pinned: true, updatedAt: "2026-01-07T00:00:00Z" }),
    ];
    const result = selectPinned(filtered);
    expect(result).toHaveLength(5);
    expect(result.map((c) => c.id)).toEqual(["p7", "p6", "p5", "p4", "p3"]);
  });
});

// ─── excludePinned ────────────────────────────────────────────────────────────

describe("excludePinned", () => {
  it("returns all conversations when pinnedIds is empty", () => {
    const filtered = [makeConv("a"), makeConv("b")];
    expect(excludePinned(filtered, new Set())).toEqual(filtered);
  });

  it("excludes exactly the ids in pinnedIds", () => {
    const filtered = [makeConv("a"), makeConv("b"), makeConv("c"), makeConv("d")];
    const result = excludePinned(filtered, new Set(["a", "c"]));
    expect(result.map((c) => c.id)).toEqual(["b", "d"]);
  });

  it("does not exclude conversations whose pinned flag is true but id is not in pinnedIds (overflow beyond cap)", () => {
    // Simulate >5 pinned: the 6th and 7th pinned are NOT in pinnedIds
    const p6 = makeConv("p6", { pinned: true });
    const p7 = makeConv("p7", { pinned: true });
    const inCap = new Set(["p1", "p2", "p3", "p4", "p5"]);
    const filtered = [
      makeConv("p1", { pinned: true }),
      makeConv("p2", { pinned: true }),
      makeConv("p3", { pinned: true }),
      makeConv("p4", { pinned: true }),
      makeConv("p5", { pinned: true }),
      p6,
      p7,
    ];
    const result = excludePinned(filtered, inCap);
    expect(result.map((c) => c.id)).toEqual(["p6", "p7"]);
  });

  it("pinned conversations in the cap are removed; others remain", () => {
    const filtered = [
      makeConv("pinned-in-cap", { pinned: true }),
      makeConv("unpinned", { pinned: false }),
      makeConv("pinned-overflow", { pinned: true }),
    ];
    const pinnedIds = new Set(["pinned-in-cap"]);
    const result = excludePinned(filtered, pinnedIds);
    expect(result.map((c) => c.id)).toEqual(["unpinned", "pinned-overflow"]);
  });
});
