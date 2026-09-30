import { describe, it, expect } from "vitest";
import { AUTONOMY_LEVELS, autonomyLabel, isValidAutonomy } from "../autonomy-levels.js";

describe("canonical autonomy", () => {
  it("has exactly three levels 0,1,2 named Manual/Assist/Drive", () => {
    expect(AUTONOMY_LEVELS.map(l => l.value)).toEqual([0, 1, 2]);
    expect(AUTONOMY_LEVELS.map(l => l.name)).toEqual(["Manual", "Assist", "Drive"]);
  });

  it("autonomyLabel(2)==='Drive'; autonomyLabel(null)==='Off'", () => {
    expect(autonomyLabel(2)).toBe("Drive");
    expect(autonomyLabel(null)).toBe("Off");
  });

  it("rejects 3 and negatives (L3 reserved)", () => {
    expect(isValidAutonomy(3)).toBe(false);
    expect(isValidAutonomy(2)).toBe(true);
    expect(isValidAutonomy(-1)).toBe(false);
  });
});
