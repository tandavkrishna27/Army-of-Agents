import { describe, expect, it } from "vitest";
import { runAllEvalSuites, summarize } from "../eval/run-all.js";
import type { EvalSuiteResult, EvalCaseResult } from "../eval/types.js";

function makeCaseResult(caseId: string, pass: boolean): EvalCaseResult<unknown> {
  return {
    caseId,
    pass,
    score: pass ? 1 : 0,
    reason: pass ? "ok" : "nope",
    durationMs: 1,
  };
}

function makeSuiteResult(
  name: string,
  cases: Array<{ caseId: string; pass: boolean }>,
): EvalSuiteResult<unknown> {
  const results = cases.map((c) => makeCaseResult(c.caseId, c.pass));
  const passCount = results.filter((r) => r.pass).length;
  return {
    name,
    total: results.length,
    pass: passCount,
    fail: results.length - passCount,
    results,
  };
}

describe("runAllEvalSuites", () => {
  it("skips and returns [] (does NOT throw) when OPENAI_API_KEY is absent", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(runAllEvalSuites()).resolves.toEqual([]);
    } finally {
      if (originalKey !== undefined) {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });
});

describe("summarize", () => {
  it("calculates passRate correctly", () => {
    const result = makeSuiteResult("doubler", [
      { caseId: "a", pass: true },
      { caseId: "b", pass: true },
      { caseId: "c", pass: true },
      { caseId: "d", pass: false },
    ]);
    const summary = summarize(result);
    expect(summary.name).toBe("doubler");
    expect(summary.total).toBe(4);
    expect(summary.pass).toBe(3);
    expect(summary.passRate).toBeCloseTo(0.75, 5);
  });

  it("treats an empty suite as passRate 1 (no division by zero)", () => {
    const result = makeSuiteResult("empty", []);
    const summary = summarize(result);
    expect(summary.total).toBe(0);
    expect(summary.passRate).toBe(1);
    expect(summary.belowThreshold).toBe(false);
    expect(summary.failingCaseIds).toEqual([]);
  });

  it("flags belowThreshold when passRate < 0.8 (at 0.79)", () => {
    // 79/100 — below
    const cases = Array.from({ length: 100 }, (_, i) => ({
      caseId: `c${i}`,
      pass: i < 79,
    }));
    const result = makeSuiteResult("at-0.79", cases);
    const summary = summarize(result);
    expect(summary.passRate).toBeCloseTo(0.79, 5);
    expect(summary.belowThreshold).toBe(true);
  });

  it("does not flag belowThreshold exactly at 0.80", () => {
    // 80/100 — exactly at threshold, must not flag (strict <)
    const cases = Array.from({ length: 100 }, (_, i) => ({
      caseId: `c${i}`,
      pass: i < 80,
    }));
    const result = makeSuiteResult("at-0.80", cases);
    const summary = summarize(result);
    expect(summary.passRate).toBeCloseTo(0.8, 5);
    expect(summary.belowThreshold).toBe(false);
  });

  it("does not flag belowThreshold at 0.81", () => {
    // 81/100 — above threshold
    const cases = Array.from({ length: 100 }, (_, i) => ({
      caseId: `c${i}`,
      pass: i < 81,
    }));
    const result = makeSuiteResult("at-0.81", cases);
    const summary = summarize(result);
    expect(summary.passRate).toBeCloseTo(0.81, 5);
    expect(summary.belowThreshold).toBe(false);
  });

  it("lists failing case ids in order", () => {
    const result = makeSuiteResult("mixed", [
      { caseId: "alpha", pass: true },
      { caseId: "beta", pass: false },
      { caseId: "gamma", pass: true },
      { caseId: "delta", pass: false },
      { caseId: "epsilon", pass: false },
    ]);
    const summary = summarize(result);
    expect(summary.failingCaseIds).toEqual(["beta", "delta", "epsilon"]);
  });

  it("returns an empty failingCaseIds list when all cases pass", () => {
    const result = makeSuiteResult("all-pass", [
      { caseId: "a", pass: true },
      { caseId: "b", pass: true },
    ]);
    const summary = summarize(result);
    expect(summary.failingCaseIds).toEqual([]);
    expect(summary.firstFailure).toBeNull();
    expect(summary.belowThreshold).toBe(false);
  });

  it("reports one sanitized failure reason for actionable CI diagnostics", () => {
    const result = makeSuiteResult("auth-failure", [
      { caseId: "first", pass: false },
      { caseId: "second", pass: false },
    ]);
    result.results[0].reason =
      "threw: 401 Authorization: Bearer secret-token sk-test_1234567890";

    expect(summarize(result).firstFailure).toEqual({
      caseId: "first",
      reason:
        "threw: 401 Authorization: Bearer [redacted] [redacted API key]",
    });
  });
});
