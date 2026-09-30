import { describe, it, expect } from "vitest";
import { groupThreadsForBoard } from "../boardModel";

describe("groupThreadsForBoard", () => {
  it("buckets threads by phase", () => {
    const threads = [
      { id: "1", phase: "discuss" } as never,
      { id: "2", phase: "scope" } as never,
      { id: "3", phase: "discuss" } as never,
    ];
    const g = groupThreadsForBoard(threads);
    expect(g.discuss).toHaveLength(2);
    expect(g.scope).toHaveLength(1);
    expect(g.assign).toHaveLength(0);
    expect(g.done).toHaveLength(0);
  });
  it("ignores unknown phases", () => {
    const threads = [{ id: "1", phase: "unknown" } as never];
    const g = groupThreadsForBoard(threads);
    // all groups empty
    expect(Object.values(g).flat()).toHaveLength(0);
  });
});
