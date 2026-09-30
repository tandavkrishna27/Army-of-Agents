/**
 * Phase F5 entrypoint — runs every LLM eval suite and exits non-zero if
 * any suite falls below the 80% pass threshold.
 *
 * Invoked by `pnpm eval:run` and by the .github/workflows/llm-evals.yml
 * CI job. Requires OPENAI_API_KEY in the environment.
 *
 * The suites covered today are the Phase F crew-agent contracts plus the
 * Commander skill-triggering classifier-proxy (Plan 2, Task 6):
 *   - Adjutant scope readiness (F2)
 *   - Memory Keeper extraction (F3)
 *   - Planner plan completeness (F4)
 *   - Commander skill triggering (Plan 2, Task 6)
 *
 * Each suite builds independently (fixtures loaded in parallel) and then
 * runs sequentially via runEvalSuite so CI logs stream readably one suite
 * at a time. The exit code contract is:
 *   - 0: every suite met PASS_THRESHOLD
 *   - 1: at least one suite fell below PASS_THRESHOLD
 *   - 2: the runner itself threw (missing key, fixtures missing, etc.)
 *
 * Tests for the threshold + summarisation logic live in
 * `server/src/__tests__/eval-run-all.test.ts` — we deliberately don't
 * end-to-end test runAllEvalSuites because mocking three buildXSuite calls
 * is brittle and duplicates the per-suite test signal.
 */
import { runEvalSuite } from "./runner.js";
import { buildAdjutantScopeSuite } from "./adjutant-scope-readiness/suite.js";
import { buildMemoryKeeperSuite } from "./memory-keeper-extraction/suite.js";
import { buildPlannerSuite } from "./planner-plan-completeness/suite.js";
import { buildCommanderSkillTriggeringSuite } from "./commander-skill-triggering/suite.js";
import type { EvalSuite, EvalSuiteResult } from "./types.js";

const PASS_THRESHOLD = 0.8;
const MAX_FAILURE_REASON_LENGTH = 500;

export interface SuiteSummary {
  name: string;
  total: number;
  pass: number;
  passRate: number;
  belowThreshold: boolean;
  failingCaseIds: string[];
  firstFailure: { caseId: string; reason: string } | null;
}

function sanitizeFailureReason(reason: string): string {
  const redacted = reason
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[redacted API key]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (redacted.length <= MAX_FAILURE_REASON_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_FAILURE_REASON_LENGTH - 3)}...`;
}

export function summarize(result: EvalSuiteResult<unknown>): SuiteSummary {
  const passRate = result.total === 0 ? 1 : result.pass / result.total;
  const firstFailure = result.results.find((entry) => !entry.pass);
  return {
    name: result.name,
    total: result.total,
    pass: result.pass,
    passRate,
    belowThreshold: passRate < PASS_THRESHOLD,
    failingCaseIds: result.results.filter((r) => !r.pass).map((r) => r.caseId),
    firstFailure: firstFailure
      ? {
          caseId: firstFailure.caseId,
          reason: sanitizeFailureReason(firstFailure.reason),
        }
      : null,
  };
}

function printSummary(summaries: SuiteSummary[]): void {
  console.log("\nLLM eval summary");
  console.log("================");
  for (const s of summaries) {
    const pct = (s.passRate * 100).toFixed(1);
    const status = s.belowThreshold ? "FAIL" : "PASS";
    console.log(`  ${status}  ${s.name}: ${s.pass}/${s.total} (${pct}%)`);
    if (s.failingCaseIds.length > 0) {
      console.log(`        failing: ${s.failingCaseIds.join(", ")}`);
    }
    if (s.firstFailure) {
      console.log(
        `        first failure (${s.firstFailure.caseId}): ${s.firstFailure.reason}`,
      );
    }
  }
  console.log("");
}

export async function runAllEvalSuites(): Promise<SuiteSummary[]> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn(
      "[skipped] OPENAI_API_KEY not set — skipping LLM eval suites. " +
        "Set it locally to run; CI does not provide this paid-API secret.",
    );
    return [];
  }

  // Each builder returns a strongly-typed EvalSuite with its own TInput /
  // TActual / TExpected — those concrete types don't unify across the three
  // suites. The runner only needs the shape, not the generics, to do its job,
  // so cast to the loosest shape here. Each suite's own tests verify the
  // narrow types end-to-end; run-all.ts is just the aggregator.
  type AnySuite = EvalSuite<unknown, unknown, unknown>;
  const suites: AnySuite[] = await Promise.all([
    buildAdjutantScopeSuite() as Promise<AnySuite>,
    buildMemoryKeeperSuite() as Promise<AnySuite>,
    buildPlannerSuite() as Promise<AnySuite>,
    buildCommanderSkillTriggeringSuite() as Promise<AnySuite>,
  ]);

  const results: EvalSuiteResult<unknown>[] = [];
  for (const suite of suites) {
    console.log(`Running ${suite.name} (${suite.cases.length} cases)…`);
    const result = await runEvalSuite(suite);
    results.push(result);
  }

  const summaries = results.map(summarize);
  printSummary(summaries);
  return summaries;
}

// Entry point — invoked when run directly (e.g. `node run-all.js`).
// Using `import.meta.url` startsWith check so `pnpm eval:run` (which
// resolves via tsx) triggers the run while consumers that `import`
// the module for tests do not.
const isEntry = (() => {
  try {
    const argv1 = process.argv[1] ?? "";
    return import.meta.url.endsWith(argv1.replace(/\\/g, "/")) ||
           argv1.endsWith("run-all.ts") || argv1.endsWith("run-all.js");
  } catch {
    return false;
  }
})();

if (isEntry) {
  runAllEvalSuites()
    .then((summaries) => {
      const failingSuites = summaries.filter((s) => s.belowThreshold);
      if (failingSuites.length > 0) {
        console.error(
          `\n${failingSuites.length} suite(s) below ${PASS_THRESHOLD * 100}% threshold: ` +
            failingSuites.map((s) => s.name).join(", "),
        );
        process.exit(1);
      }
      console.log(`All ${summaries.length} suites passed ${PASS_THRESHOLD * 100}% threshold.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("eval run failed:", err instanceof Error ? err.message : err);
      process.exit(2);
    });
}
