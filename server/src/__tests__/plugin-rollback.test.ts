import { describe, it, expect } from "vitest";
import { keepLatestN } from "../services/plugin-rollback-utils.js";

describe("keepLatestN", () => {
  it("returns all snapshots when count <= N", () => {
    const snaps = [
      { id: "a", createdAt: new Date("2026-01-01") },
      { id: "b", createdAt: new Date("2026-01-02") },
    ];
    const result = keepLatestN(snaps, 2);
    expect(result.toKeep.map((s) => s.id)).toEqual(["b", "a"]);
    expect(result.toDelete).toEqual([]);
  });

  it("trims to N most recent, marks rest for deletion", () => {
    const snaps = [
      { id: "a", createdAt: new Date("2026-01-01") },
      { id: "b", createdAt: new Date("2026-01-02") },
      { id: "c", createdAt: new Date("2026-01-03") },
    ];
    const result = keepLatestN(snaps, 2);
    expect(result.toKeep.map((s) => s.id)).toEqual(["c", "b"]);
    expect(result.toDelete.map((s) => s.id)).toEqual(["a"]);
  });
});
