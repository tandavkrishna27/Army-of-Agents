import { describe, it, expect } from "vitest";
import { decideCheapFallback } from "../services/cheap-fallback.js";

describe("decideCheapFallback", () => {
  it("returns inactive when budget is 0", () => {
    const result = decideCheapFallback(0, 500, "claude-haiku-4-5");
    expect(result).toEqual({ active: false, effectiveModel: null });
  });

  it("returns inactive when cheapModel is null", () => {
    const result = decideCheapFallback(1000, 900, null);
    expect(result).toEqual({ active: false, effectiveModel: null });
  });

  it("returns inactive when cheapModel is undefined", () => {
    const result = decideCheapFallback(1000, 900, undefined);
    expect(result).toEqual({ active: false, effectiveModel: null });
  });

  it("returns inactive when spend is below 80% threshold", () => {
    // 799/1000 = 79.9% — just below threshold
    const result = decideCheapFallback(1000, 799, "claude-haiku-4-5");
    expect(result).toEqual({ active: false, effectiveModel: null });
  });

  it("returns active exactly at 80% threshold", () => {
    // 800/1000 = 80.0% — exactly at threshold
    const result = decideCheapFallback(1000, 800, "claude-haiku-4-5");
    expect(result).toEqual({ active: true, effectiveModel: "claude-haiku-4-5" });
  });

  it("returns active when spend exceeds 80%", () => {
    // 950/1000 = 95%
    const result = decideCheapFallback(1000, 950, "claude-haiku-4-5");
    expect(result).toEqual({ active: true, effectiveModel: "claude-haiku-4-5" });
  });

  it("returns active when fully spent (100%)", () => {
    const result = decideCheapFallback(1000, 1000, "claude-haiku-4-5");
    expect(result).toEqual({ active: true, effectiveModel: "claude-haiku-4-5" });
  });

  it("returns active when overspent (>100%)", () => {
    const result = decideCheapFallback(1000, 1100, "claude-haiku-4-5");
    expect(result).toEqual({ active: true, effectiveModel: "claude-haiku-4-5" });
  });

  it("uses the exact cheapModel string passed in", () => {
    const result = decideCheapFallback(500, 450, "claude-opus-4-5");
    expect(result.effectiveModel).toBe("claude-opus-4-5");
  });
});
