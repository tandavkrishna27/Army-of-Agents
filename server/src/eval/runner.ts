/**
 * Eval framework — suite runner (Phase F1, T10 foundation).
 *
 * This is the small, opinionated executor that the Phase F LLM eval suites
 * sit on top of. A "suite" pairs a list of fixture cases with a `runOne`
 * (the system under test) and a `grade` function; this runner takes the
 * suite, executes every case (subject to a concurrency cap), captures
 * wall-clock duration, and aggregates pass/fail counts for CI reporting.
 *
 * Errors are swallowed into pass:false results on purpose: a single broken
 * fixture or flaky grader should never tank the whole run, because the
 * suite results are the signal CI uses to decide whether prompt edits
 * regressed agent behavior. The error reason is always prefixed with
 * `threw: ` so CI scripts can distinguish thrown failures from
 * grader-judged failures.
 *
 * Concurrency defaults to 5 — chosen to stay under OpenAI's default RPM
 * tiers while still parallelising enough to keep wall-clock tolerable for
 * 10–15 case suites. Suites that hit cheaper/local backends can override
 * via `suite.concurrency`. Result order always mirrors `suite.cases` so
 * CI summaries are deterministic.
 *
 * F2–F4 build concrete suites (Adjutant, Memory Keeper, Planner) using
 * this runner — see `./types.ts` for the suite contract itself.
 */

import type { EvalSuite, EvalSuiteResult, EvalCaseResult } from "./types.js";

const DEFAULT_CONCURRENCY = 5;

/**
 * Run all cases in a suite. Cases execute concurrently up to
 * `suite.concurrency` (default 5) — the suite chooses the right cap for
 * its backend's rate limits. Results preserve input order regardless of
 * which cases finish first.
 *
 * Errors thrown by runOne or grade become pass:false with the error
 * message (prefixed `threw: …`) as the reason, so one bad fixture can't
 * tank the whole run. When grade throws, the runOne output is still
 * captured on the result so flaky graders can be debugged after the fact.
 */
export async function runEvalSuite<TInput, TActual, TExpected>(
  suite: EvalSuite<TInput, TActual, TExpected>,
): Promise<EvalSuiteResult<TActual>> {
  const cases = suite.cases;
  const limit = Math.max(1, suite.concurrency ?? DEFAULT_CONCURRENCY);
  const results: Array<EvalCaseResult<TActual>> = new Array(cases.length);

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= cases.length) return;
      results[index] = await runCase(suite, cases[index]);
    }
  }

  const workerCount = Math.min(limit, cases.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const passCount = results.filter((r) => r.pass).length;
  return {
    name: suite.name,
    total: results.length,
    pass: passCount,
    fail: results.length - passCount,
    results,
  };
}

async function runCase<TInput, TActual, TExpected>(
  suite: EvalSuite<TInput, TActual, TExpected>,
  c: EvalSuite<TInput, TActual, TExpected>["cases"][number],
): Promise<EvalCaseResult<TActual>> {
  const startedAt = Date.now();
  let actual: TActual | undefined;
  try {
    actual = await suite.runOne(c.input);
    const grade = await suite.grade(actual, c.expected);
    return {
      caseId: c.id,
      pass: grade.pass,
      score: grade.score,
      reason: grade.reason,
      actual,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      caseId: c.id,
      pass: false,
      score: 0,
      reason: `threw: ${message}`,
      // Capture actual when runOne succeeded but grade threw — surfaces
      // grader-bug evidence without needing a re-run.
      actual,
      durationMs: Date.now() - startedAt,
    };
  }
}
