import { describe, expect, it } from "vitest";
import { keyboardRect, resizeLimits } from "../panel-gestures";
const rect = { x: 10, y: 20, width: 500, height: 400 };
describe("header keyboard geometry", () => {
  it.each([0.5, 1, 2])("converts CSS pixels once at zoom %s", (zoom) => {
    const bounds = resizeLimits("task", zoom, { width: 3000, height: 3000 });
    expect(keyboardRect(rect, "ArrowRight", false, zoom, bounds)?.x).toBe(
      10 + 10 / zoom
    );
    expect(
      keyboardRect({ ...rect, height: 600 }, "ArrowDown", true, zoom, bounds)
        ?.height
    ).toBe(600 + 10 / zoom);
  });
  it("caps minimums to narrow usable bounds", () => {
    expect(resizeLimits("task", 0.5, { width: 100, height: 80 })).toEqual({
      minWidth: 200,
      minHeight: 160,
      maxWidth: 200,
      maxHeight: 160,
    });
  });
});
