import { describe, expect, it } from "vitest";
import { readableCamera, visibleWorld } from "../viewport-controller";
import { resolveMotionTokens } from "../motion-tokens";

describe("Universe viewport controller", () => {
  it("converts screen bounds once and rejects an unmeasured host", () => {
    expect(visibleWorld({ left: 20, top: 60, width: 900, height: 600 }, { x: 10, y: 20, zoom: .5 }))
      .toEqual({ x: 20, y: 80, width: 1800, height: 1200 });
    expect(visibleWorld({ left: 0, top: 0, width: 0, height: 600 }, { x: 0, y: 0, zoom: 1 })).toBeNull();
  });
  it("centers an offscreen target at a readable bounded zoom", () => {
    const camera = readableCamera({ left: 0, top: 0, width: 800, height: 600 }, { x: 2000, y: 1500, width: 520, height: 360 });
    expect(camera).toEqual({ x: -1860, y: -1380, zoom: 1 });
  });
  it("lets OS reduced motion dominate a saved full preference", () => {
    expect(resolveMotionTokens("full", true)).toMatchObject({ panel: 0, camera: 0, pulse: false });
    expect(resolveMotionTokens("full", false).camera).toBeGreaterThan(0);
  });
});
