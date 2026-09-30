import { describe, expect, it } from "vitest";
import { runEvalSuite } from "../eval/runner.js";
import type { EvalSuite, EvalCase } from "../eval/types.js";

function makeCase<TInput, TExpected>(
  id: string,
  input: TInput,
  expected: EvalCase<TInput, TExpected>["expected"],
): EvalCase<TInput, TExpected> {
  return { id, input, expected };
}

describe("runEvalSuite", () => {
  it("runs all cases and aggregates pass/fail counts", async () => {
    const suite: EvalSuite<number, number, number> = {
      name: "doubler",
      cases: [
        makeCase("a", 1, { type: "exact", value: 2 }),
        makeCase("b", 2, { type: "exact", value: 4 }),
        makeCase("c", 3, { type: "exact", value: 999 }), // will fail
      ],
      async runOne(n) { return n * 2; },
      async grade(actual, expected) {
        const pass = actual === expected.value;
        return { pass, score: pass ? 1 : 0, reason: pass ? "ok" : `got ${actual}` };
      },
    };

    const result = await runEvalSuite(suite);
    expect(result.name).toBe("doubler");
    expect(result.total).toBe(3);
    expect(result.pass).toBe(2);
    expect(result.fail).toBe(1);
    expect(result.results.find((r) => r.caseId === "c")?.pass).toBe(false);
    expect(result.results.find((r) => r.caseId === "c")?.reason).toContain("got 6");
  });

  it("captures durationMs per case", async () => {
    const suite: EvalSuite<void, void, void> = {
      name: "timing",
      cases: [makeCase("only", undefined, { type: "exact", value: undefined })],
      async runOne() { await new Promise((r) => setTimeout(r, 5)); },
      async grade() { return { pass: true, score: 1, reason: "ok" }; },
    };
    const result = await runEvalSuite(suite);
    expect(result.results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("treats thrown errors in runOne as pass:false with the error reason", async () => {
    const suite: EvalSuite<void, void, void> = {
      name: "throwy",
      cases: [makeCase("boom", undefined, { type: "exact", value: undefined })],
      async runOne() { throw new Error("kaboom"); },
      async grade() { return { pass: true, score: 1, reason: "ok" }; },
    };
    const result = await runEvalSuite(suite);
    expect(result.pass).toBe(0);
    expect(result.fail).toBe(1);
    expect(result.results[0].reason).toContain("kaboom");
  });

  it("treats thrown errors in grade as pass:false but still captures actual", async () => {
    const suite: EvalSuite<void, string, void> = {
      name: "throwy-grade",
      cases: [makeCase("boom-grade", undefined, { type: "exact", value: undefined })],
      async runOne() { return "produced-value"; },
      async grade() { throw new Error("grade-failed"); },
    };
    const result = await runEvalSuite(suite);
    expect(result.pass).toBe(0);
    expect(result.results[0].reason).toContain("grade-failed");
    // Grade-throw must preserve runOne output so flaky graders can be debugged.
    expect(result.results[0].actual).toBe("produced-value");
  });

  it("preserves caseId order from suite.cases in result.results", async () => {
    // With concurrent execution, completion order varies — but result order
    // must mirror input order so CI summaries are deterministic.
    const suite: EvalSuite<number, void, void> = {
      name: "ordering",
      cases: [
        makeCase("first", 40, { type: "exact", value: undefined }),
        makeCase("second", 10, { type: "exact", value: undefined }),
        makeCase("third", 30, { type: "exact", value: undefined }),
        makeCase("fourth", 5, { type: "exact", value: undefined }),
      ],
      async runOne(ms) { await new Promise((r) => setTimeout(r, ms)); },
      async grade() { return { pass: true, score: 1, reason: "ok" }; },
    };
    const result = await runEvalSuite(suite);
    expect(result.results.map((r) => r.caseId)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("returns total:0 / pass:0 / fail:0 for an empty case list", async () => {
    const suite: EvalSuite<void, void, void> = {
      name: "empty",
      cases: [],
      async runOne() { /* unreachable */ },
      async grade() { return { pass: true, score: 1, reason: "ok" }; },
    };
    const result = await runEvalSuite(suite);
    expect(result.total).toBe(0);
    expect(result.pass).toBe(0);
    expect(result.fail).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("respects suite.concurrency cap (sequential when concurrency=1)", async () => {
    // Three 30ms cases. With concurrency=1, wall-clock should be ~90ms
    // (3 × 30 + overhead). With unbounded parallelism it would be ~30ms.
    const suite: EvalSuite<number, void, void> = {
      name: "capped",
      concurrency: 1,
      cases: [
        makeCase("a", 30, { type: "exact", value: undefined }),
        makeCase("b", 30, { type: "exact", value: undefined }),
        makeCase("c", 30, { type: "exact", value: undefined }),
      ],
      async runOne(ms) { await new Promise((r) => setTimeout(r, ms)); },
      async grade() { return { pass: true, score: 1, reason: "ok" }; },
    };
    const startedAt = Date.now();
    await runEvalSuite(suite);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it("runs cases in parallel by default (smoke test via timing)", async () => {
    const suite: EvalSuite<number, void, void> = {
      name: "parallel",
      cases: [
        makeCase("a", 50, { type: "exact", value: undefined }),
        makeCase("b", 50, { type: "exact", value: undefined }),
        makeCase("c", 50, { type: "exact", value: undefined }),
      ],
      async runOne(ms) { await new Promise((r) => setTimeout(r, ms)); },
      async grade() { return { pass: true, score: 1, reason: "ok" }; },
    };
    const startedAt = Date.now();
    await runEvalSuite(suite);
    const elapsed = Date.now() - startedAt;
    // Sequential would be ~150ms; parallel (default cap 5 ≥ 3) should be ~50ms.
    expect(elapsed).toBeLessThan(120);
  });
});
