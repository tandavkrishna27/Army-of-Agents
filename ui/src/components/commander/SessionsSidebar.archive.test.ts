import { expect, describe, it } from "vitest";
import { applyArchiveOptimistic } from "./SessionsSidebar";

describe("applyArchiveOptimistic", () => {
  it("removes the archived conversation from the list", () => {
    const input = {
      conversations: [
        { id: "A", title: "Chat A" },
        { id: "B", title: "Chat B" },
      ],
    };
    const result = applyArchiveOptimistic(input as any, "A");
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].id).toBe("B");
  });

  it("returns empty list when the only conversation is archived", () => {
    const input = { conversations: [{ id: "A", title: "Chat A" }] };
    const result = applyArchiveOptimistic(input as any, "A");
    expect(result.conversations).toHaveLength(0);
  });

  it("returns unchanged list when id is not found", () => {
    const input = { conversations: [{ id: "A", title: "Chat A" }] };
    const result = applyArchiveOptimistic(input as any, "X");
    expect(result.conversations).toHaveLength(1);
  });

  it("handles undefined data gracefully", () => {
    const result = applyArchiveOptimistic(undefined, "A");
    expect(result.conversations).toEqual([]);
  });
});
