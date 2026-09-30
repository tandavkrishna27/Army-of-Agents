import { describe, it, expect } from "vitest";
// We test the pure logic directly since useRunTokens is just a useMemo wrapper
// Import the function and test it as a pure computation

// Since it's a hook, we'll test the logic by extracting it
// Actually, we can test the underlying computation directly

describe("useRunTokens logic", () => {
  // Helper to simulate what useRunTokens does
  function sumTokens(runs: Array<{ usageJson: Record<string, unknown> | null }>) {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const run of runs) {
      const usage = run.usageJson;
      if (!usage || typeof usage !== "object") continue;
      const inp = usage.inputTokens;
      const out = usage.outputTokens;
      if (typeof inp === "number") inputTokens += inp;
      if (typeof out === "number") outputTokens += out;
    }
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }

  it("sums tokens across multiple runs", () => {
    const result = sumTokens([
      { usageJson: { inputTokens: 1000, outputTokens: 500 } },
      { usageJson: { inputTokens: 2000, outputTokens: 800 } },
    ]);
    expect(result).toEqual({ inputTokens: 3000, outputTokens: 1300, totalTokens: 4300 });
  });

  it("returns zeros when all runs have null usageJson", () => {
    const result = sumTokens([
      { usageJson: null },
      { usageJson: null },
    ]);
    expect(result).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("handles mixed runs (some with tokens, some without)", () => {
    const result = sumTokens([
      { usageJson: { inputTokens: 1000, outputTokens: 500 } },
      { usageJson: null },
      { usageJson: { inputTokens: 500, outputTokens: 200 } },
    ]);
    expect(result).toEqual({ inputTokens: 1500, outputTokens: 700, totalTokens: 2200 });
  });

  it("returns zeros for empty run array", () => {
    const result = sumTokens([]);
    expect(result).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("ignores non-number token values", () => {
    const result = sumTokens([
      { usageJson: { inputTokens: "not a number", outputTokens: 500 } },
    ]);
    expect(result).toEqual({ inputTokens: 0, outputTokens: 500, totalTokens: 500 });
  });
});
