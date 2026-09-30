import { describe, it, expect } from "vitest";
import {
  sampleSmoothPath,
  pointToSegmentDistance,
  clipPolylineLeft,
} from "../components/workspace/git-arc-draw";

// ---------------------------------------------------------------------------
// sampleSmoothPath — centripetal Catmull-Rom must not hook or overshoot
// ---------------------------------------------------------------------------

describe("sampleSmoothPath (centripetal Catmull-Rom)", () => {
  it("keeps a sparse steep arc monotonic in x (no backward hook)", () => {
    // Asymmetric, steep, sparse — the config that makes uniform Catmull-Rom
    // bulge its control point backward (the grey 'hook').
    const pts: Array<[number, number]> = [
      [0, 200],
      [40, 80],
      [50, 90],
      [400, 200],
    ];
    const sampled = sampleSmoothPath(pts, 24);
    for (let i = 1; i < sampled.length; i++) {
      expect(sampled[i]![0]).toBeGreaterThanOrEqual(sampled[i - 1]![0] - 1);
    }
  });

  it("does not overshoot the points' vertical bounding box", () => {
    const pts: Array<[number, number]> = [
      [0, 200],
      [40, 80],
      [50, 90],
      [400, 200],
    ];
    const ys = pts.map((p) => p[1]);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    for (const [, y] of sampleSmoothPath(pts, 24)) {
      expect(y).toBeGreaterThanOrEqual(minY - 2);
      expect(y).toBeLessThanOrEqual(maxY + 2);
    }
  });

  it("passes through the endpoints", () => {
    const pts: Array<[number, number]> = [[0, 0], [50, 50], [100, 0]];
    const s = sampleSmoothPath(pts, 8);
    expect(s[0]).toEqual([0, 0]);
    expect(s[s.length - 1]).toEqual([100, 0]);
  });

  it("handles < 3 points without throwing", () => {
    expect(sampleSmoothPath([], 8)).toEqual([]);
    expect(sampleSmoothPath([[5, 5]], 8)).toEqual([[5, 5]]);
    const two = sampleSmoothPath([[0, 0], [10, 0]], 4);
    expect(two[0]).toEqual([0, 0]);
    expect(two[two.length - 1]).toEqual([10, 0]);
  });
});

describe("pointToSegmentDistance", () => {
  it("is 0 for a point on the segment", () => {
    expect(pointToSegmentDistance(5, 0, 0, 0, 10, 0)).toBeCloseTo(0, 6);
  });
  it("returns the perpendicular distance when the foot is interior", () => {
    expect(pointToSegmentDistance(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 6);
  });
  it("clamps to the nearest endpoint when the foot is outside", () => {
    // Left of A → distance to A.
    expect(pointToSegmentDistance(-4, 0, 0, 0, 10, 0)).toBeCloseTo(4, 6);
    // Right of B → distance to B.
    expect(pointToSegmentDistance(13, 4, 0, 0, 10, 0)).toBeCloseTo(5, 6);
  });
  it("handles a zero-length segment as distance to the point", () => {
    expect(pointToSegmentDistance(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 6);
  });
});

describe("clipPolylineLeft", () => {
  const path: Array<[number, number]> = [[0, 200], [60, 140], [120, 200]];

  it("inserts an interpolated entry point at x = left and drops off-screen head", () => {
    const clipped = clipPolylineLeft(path, 30)!;
    expect(clipped[0]![0]).toBe(30);
    // Interpolated y between (0,200) and (60,140): t=0.5 → y=170.
    expect(clipped[0]![1]).toBeCloseTo(170, 6);
    expect(clipped[clipped.length - 1]).toEqual([120, 200]);
  });

  it("returns null when fewer than 2 points remain visible", () => {
    expect(clipPolylineLeft(path, 200)).toBeNull();
  });

  it("returns the path unchanged-ish when nothing is left of `left`", () => {
    const clipped = clipPolylineLeft(path, -10)!;
    expect(clipped).toHaveLength(3);
    expect(clipped[0]).toEqual([0, 200]);
  });
});
