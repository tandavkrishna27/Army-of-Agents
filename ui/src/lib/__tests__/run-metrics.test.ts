import { describe, it, expect } from "vitest";
import { asRecord, usageNumber, runMetrics } from "../run-metrics";

describe("asRecord", () => {
  it("returns the object for plain records, null otherwise", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toBeNull();
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord("x")).toBeNull();
  });
});

describe("usageNumber", () => {
  it("returns the first finite numeric key", () => {
    expect(usageNumber({ a: 5, b: 9 }, "a", "b")).toBe(5);
    expect(usageNumber({ a: "no", b: 9 }, "a", "b")).toBe(9);
    expect(usageNumber({ a: Infinity }, "a")).toBe(0);
    expect(usageNumber(null, "a")).toBe(0);
  });
});

describe("runMetrics", () => {
  it("reads camel and snake token keys and sums totalTokens", () => {
    const m = runMetrics({ usageJson: { inputTokens: 10, output_tokens: 5 }, resultJson: null });
    expect(m.input).toBe(10);
    expect(m.output).toBe(5);
    expect(m.totalTokens).toBe(15);
  });
  it("falls back to resultJson for cost when usage has none", () => {
    const m = runMetrics({ usageJson: { inputTokens: 1 }, resultJson: { total_cost_usd: 0.42 } });
    expect(m.cost).toBeCloseTo(0.42);
  });
});
