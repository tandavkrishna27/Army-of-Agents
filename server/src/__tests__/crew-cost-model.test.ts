import { describe, it, expect } from "vitest";
import { computeCostCents } from "../services/internal-agent/cost-model.js";

describe("computeCostCents", () => {
  it("prices a known model by input/output tokens", () => {
    const c = computeCostCents("anthropic", "claude-sonnet-4-20250514", 1_000_000, 1_000_000);
    expect(c).toBeGreaterThan(0);
  });
  it("returns 0 for zero tokens", () => {
    expect(computeCostCents("anthropic", "claude-sonnet-4-20250514", 0, 0)).toBe(0);
  });
  it("falls back gracefully for an unknown model (never throws)", () => {
    expect(computeCostCents("anthropic", "unknown-model", 1000, 1000)).toBeGreaterThanOrEqual(0);
  });
});
