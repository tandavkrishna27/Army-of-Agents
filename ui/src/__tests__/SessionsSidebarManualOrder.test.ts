/**
 * Unit tests for the manual drag-order helpers (Batch 2: session reorder).
 * These are the pure functions exported from SessionsSidebar that decide when
 * the list switches to manual mode, how it sorts, and how the cache updates
 * optimistically on drag / reset.
 */
import { describe, it, expect } from "vitest";
import type { ConversationRow } from "../api/internal-agent";
import {
  isManualOrder,
  orderForManual,
  applyReorderOptimistic,
  applyResetOrderOptimistic,
} from "../components/commander/SessionsSidebar";

function makeConv(
  id: string,
  opts: { updatedAt?: string; sortOrder?: number | null } = {},
): ConversationRow {
  return {
    id,
    title: `Session ${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: opts.updatedAt ?? "2026-01-01T00:00:00Z",
    messageCount: 0,
    userId: "user-1",
    pinned: false,
    sortOrder: opts.sortOrder ?? null,
  };
}

describe("isManualOrder", () => {
  it("is false when every conversation has a null sortOrder", () => {
    expect(isManualOrder([makeConv("a"), makeConv("b")])).toBe(false);
  });
  it("is true once any conversation has a non-null sortOrder", () => {
    expect(isManualOrder([makeConv("a"), makeConv("b", { sortOrder: 0 })])).toBe(true);
  });
  it("treats sortOrder 0 as ordered (not falsy)", () => {
    expect(isManualOrder([makeConv("a", { sortOrder: 0 })])).toBe(true);
  });
  it("is false for an empty list", () => {
    expect(isManualOrder([])).toBe(false);
  });
});

describe("orderForManual", () => {
  it("orders by sortOrder ascending", () => {
    const list = [
      makeConv("b", { sortOrder: 1 }),
      makeConv("a", { sortOrder: 0 }),
      makeConv("c", { sortOrder: 2 }),
    ];
    expect(orderForManual(list).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("floats unordered (null) conversations to the top, newest first", () => {
    const list = [
      makeConv("ordered0", { sortOrder: 0 }),
      makeConv("ordered1", { sortOrder: 1 }),
      makeConv("newOld", { updatedAt: "2026-05-01T00:00:00Z" }),
      makeConv("newNew", { updatedAt: "2026-05-02T00:00:00Z" }),
    ];
    expect(orderForManual(list).map((c) => c.id)).toEqual([
      "newNew",
      "newOld",
      "ordered0",
      "ordered1",
    ]);
  });
});

describe("applyReorderOptimistic", () => {
  it("stamps sortOrder by index for the dragged ids", () => {
    const data = {
      conversations: [makeConv("a"), makeConv("b"), makeConv("c")],
    };
    const result = applyReorderOptimistic(data, ["c", "a", "b"]);
    const byId = Object.fromEntries(result.conversations.map((c) => [c.id, c.sortOrder]));
    expect(byId).toEqual({ c: 0, a: 1, b: 2 });
  });

  it("leaves conversations not in the ordered list untouched", () => {
    const data = { conversations: [makeConv("a", { sortOrder: 5 }), makeConv("z")] };
    const result = applyReorderOptimistic(data, ["a"]);
    const z = result.conversations.find((c) => c.id === "z");
    expect(z?.sortOrder).toBeNull();
  });

  it("handles undefined cache data", () => {
    expect(applyReorderOptimistic(undefined, ["a"])).toEqual({ conversations: [] });
  });
});

describe("applyResetOrderOptimistic", () => {
  it("clears sortOrder on every conversation", () => {
    const data = {
      conversations: [
        makeConv("a", { sortOrder: 0 }),
        makeConv("b", { sortOrder: 1 }),
      ],
    };
    const result = applyResetOrderOptimistic(data);
    expect(result.conversations.every((c) => c.sortOrder === null)).toBe(true);
  });

  it("handles undefined cache data", () => {
    expect(applyResetOrderOptimistic(undefined)).toEqual({ conversations: [] });
  });
});
