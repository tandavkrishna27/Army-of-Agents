import { describe, it, expect } from "vitest";
import { placeArcLabels } from "../components/workspace/git-arc-labels";

function arc(branchName: string, dir: "up" | "down", branchPointX: number, mergePointX: number | null, apexY: number, isDone = false) {
  return { branchName, direction: dir, branchPointX, mergePointX, apexY, isOpen: mergePointX == null, color: "#7E8AA8", isDone, points: [] as Array<[number, number]> } as any;
}

describe("placeArcLabels", () => {
  it("de-overlaps two labels that would land on the same spot", () => {
    const arcs = [arc("feat/aaaa", "down", 100, 300, 260), arc("feat/bbbb", "down", 100, 300, 260)];
    const m = placeArcLabels(arcs, new Set(["feat/aaaa", "feat/bbbb"]), new Set());
    expect(Math.abs(m.get("feat/aaaa")!.y - m.get("feat/bbbb")!.y)).toBeGreaterThanOrEqual(10);
  });
  it("skips done arcs and card-labelled arcs", () => {
    const arcs = [arc("feat/done", "up", 100, 300, 140, true), arc("feat/card", "up", 100, 300, 140)];
    const m = placeArcLabels(arcs, new Set(["feat/done", "feat/card"]), new Set(["feat/card"]));
    expect(m.has("feat/done")).toBe(false);
    expect(m.has("feat/card")).toBe(false);
  });
  it("scales past the old 6-label cap — 12 stacked labels all separated", () => {
    const arcs = Array.from({ length: 12 }, (_, i) => arc("feat/b" + i, "down", 100, 300, 260));
    const m = placeArcLabels(arcs, new Set(arcs.map((a) => a.branchName)), new Set());
    const ys = [...m.values()].map((p) => p.y).sort((x, y) => x - y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(10);
  });
});
