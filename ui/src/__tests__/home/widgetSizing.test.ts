import { describe, it, expect } from "vitest";
import { rowsForSize } from "../../components/home/widgets/widgetSizing";

describe("rowsForSize", () => {
  it("returns 2 rows for a 1-row-tall tile (h=1)", () => {
    expect(rowsForSize({ w: 2, h: 1 })).toBe(2);
  });

  it("returns 6 rows for a 2-row-tall tile (h=2) — the boundary where the mapping flips", () => {
    expect(rowsForSize({ w: 2, h: 2 })).toBe(6);
  });

  it("is width-independent — a 4-wide tile gets the same row count as a 2-wide tile at the same height", () => {
    expect(rowsForSize({ w: 4, h: 1 })).toBe(rowsForSize({ w: 2, h: 1 }));
    expect(rowsForSize({ w: 4, h: 2 })).toBe(rowsForSize({ w: 2, h: 2 }));
  });

  it("treats any height taller than 2 the same as h=2 (no widget's allowed size currently exceeds h=2)", () => {
    expect(rowsForSize({ w: 2, h: 3 })).toBe(6);
  });

  it("defaults to the more generous h>=2 behavior when size is undefined, so a caller that omits it never crashes", () => {
    expect(rowsForSize(undefined)).toBe(6);
  });
});
