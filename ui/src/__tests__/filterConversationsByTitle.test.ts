import { describe, it, expect } from "vitest";
import { filterConversationsByTitle } from "../components/commander/SessionsSidebar";
import type { ConversationRow } from "../api/internal-agent";

// ── Minimal factory ──────────────────────────────────────────────────────────
function makeConv(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "conv-1",
    title: "Test conversation",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 0,
    userId: "user-1",
    pinned: false,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("filterConversationsByTitle", () => {
  it("returns all conversations when query is empty", () => {
    const convs = [makeConv({ id: "a" }), makeConv({ id: "b" })];
    expect(filterConversationsByTitle(convs, "")).toEqual(convs);
  });

  it("returns all conversations when query is whitespace-only", () => {
    const convs = [makeConv({ id: "a" }), makeConv({ id: "b" })];
    expect(filterConversationsByTitle(convs, "   ")).toEqual(convs);
  });

  it("matches a substring case-insensitively", () => {
    const convs = [
      makeConv({ id: "1", title: "Deploy to production" }),
      makeConv({ id: "2", title: "Review pull request" }),
      makeConv({ id: "3", title: "DEPLOY staging env" }),
    ];
    const result = filterConversationsByTitle(convs, "deploy");
    expect(result.map((c) => c.id)).toEqual(["1", "3"]);
  });

  it("is case-insensitive — uppercase query matches lowercase title", () => {
    const convs = [makeConv({ title: "fix the bug" }), makeConv({ title: "add feature" })];
    const result = filterConversationsByTitle(convs, "BUG");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("fix the bug");
  });

  it("does not crash when title is null — null title excluded unless query empty", () => {
    const convs = [
      makeConv({ id: "1", title: null }),
      makeConv({ id: "2", title: "planning session" }),
    ];
    // null title → treated as "" → does not match "planning"
    const result = filterConversationsByTitle(convs, "planning");
    expect(result.map((c) => c.id)).toEqual(["2"]);
  });

  it("returns conversation with null title when query is empty (null-safe pass-through)", () => {
    const convs = [makeConv({ id: "1", title: null }), makeConv({ id: "2", title: "something" })];
    const result = filterConversationsByTitle(convs, "");
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no titles match", () => {
    const convs = [
      makeConv({ title: "alpha" }),
      makeConv({ title: "beta" }),
    ];
    expect(filterConversationsByTitle(convs, "gamma")).toHaveLength(0);
  });

  it("matches substring anywhere in the title", () => {
    const convs = [
      makeConv({ id: "1", title: "Start the review" }),
      makeConv({ id: "2", title: "Do the review session" }),
      makeConv({ id: "3", title: "unrelated" }),
    ];
    const result = filterConversationsByTitle(convs, "review");
    expect(result.map((c) => c.id)).toEqual(["1", "2"]);
  });
});
