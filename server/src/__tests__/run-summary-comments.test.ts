import { describe, expect, it } from "vitest";
import { formatRunSummary, type RunSummaryInput } from "../services/run-summary.js";

function buildInput(overrides: Partial<RunSummaryInput> = {}): RunSummaryInput {
  return {
    agentName: "Test Agent",
    outcome: "succeeded",
    durationMs: 154_000, // 2m 34s
    inputTokens: 12450,
    outputTokens: 3200,
    costUsd: 0.08,
    errorMessage: null,
    detectedFiles: [],
    ...overrides,
  };
}

describe("formatRunSummary", () => {
  it("formats a successful run with all data", () => {
    const result = formatRunSummary(buildInput());
    expect(result).toContain("Run Summary");
    expect(result).toContain("Test Agent");
    expect(result).toContain("2m 34s");
    expect(result).toContain("12,450 in");
    expect(result).toContain("3,200 out");
    expect(result).toContain("$0.08");
    expect(result).toContain("Succeeded");
    expect(result).not.toContain("Completed");
    // No files line when empty
    expect(result).not.toContain("Files:");
  });

  it("formats duration correctly for sub-minute runs", () => {
    const result = formatRunSummary(buildInput({ durationMs: 45_000 }));
    expect(result).toContain("45s");
    expect(result).not.toContain("0m");
  });

  it("shows N/A when tokens are null", () => {
    const result = formatRunSummary(
      buildInput({ inputTokens: null, outputTokens: null }),
    );
    expect(result).toContain("N/A in");
    expect(result).toContain("N/A out");
  });

  it("shows N/A when cost is null", () => {
    const result = formatRunSummary(buildInput({ costUsd: null }));
    expect(result).toMatch(/Cost: N\/A/);
  });

  it("formats a failed run with error message", () => {
    const result = formatRunSummary(
      buildInput({
        outcome: "failed",
        errorMessage: "Process exited with code 1",
      }),
    );
    expect(result).toContain("Failed");
    expect(result).toContain("Process exited with code 1");
  });

  it("formats a failed run without error message", () => {
    const result = formatRunSummary(
      buildInput({ outcome: "failed", errorMessage: null }),
    );
    expect(result).toContain("Failed");
    // Outcome line should NOT have the " — <error>" suffix
    const outcomeLine = result.split("\n").find((l) => l.startsWith("Outcome:"));
    expect(outcomeLine).not.toContain("Failed \u2014 ");
  });

  it("formats a timed out run", () => {
    const result = formatRunSummary(buildInput({ outcome: "timed_out" }));
    expect(result).toContain("Timed out");
  });

  it("formats a cancelled run", () => {
    const result = formatRunSummary(buildInput({ outcome: "cancelled" }));
    expect(result).toContain("Cancelled");
  });

  it("includes detected files", () => {
    const result = formatRunSummary(
      buildInput({
        detectedFiles: [
          { path: "src/utils/helper.ts" },
          { path: "src/tests/helper.test.ts", type: "test" },
        ],
      }),
    );
    expect(result).toContain("Files:");
    expect(result).toContain("`src/utils/helper.ts`");
    expect(result).toContain("`src/tests/helper.test.ts`");
  });

  it("truncates file list at 10 items and shows remainder count", () => {
    const files = Array.from({ length: 15 }, (_, i) => ({
      path: `src/file${i}.ts`,
    }));
    const result = formatRunSummary(buildInput({ detectedFiles: files }));
    expect(result).toContain("Files:");
    // Should show first 10
    expect(result).toContain("`src/file0.ts`");
    expect(result).toContain("`src/file9.ts`");
    // Should NOT show 11th+
    expect(result).not.toContain("`src/file10.ts`");
    // Should show remaining count
    expect(result).toContain("+5 more");
  });

  it("does not show +N more when exactly 10 files", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `src/file${i}.ts`,
    }));
    const result = formatRunSummary(buildInput({ detectedFiles: files }));
    expect(result).toContain("`src/file9.ts`");
    expect(result).not.toContain("more");
  });
});
