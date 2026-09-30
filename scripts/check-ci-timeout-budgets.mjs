#!/usr/bin/env node
// -----------------------------------------------------------------------------
// check-ci-timeout-budgets.mjs — the required lane's caps must be DERIVED, not chosen.
//
//   node scripts/check-ci-timeout-budgets.mjs
//   node scripts/check-ci-timeout-budgets.mjs --explain   # print the derivation table
//
// Reads the REAL .github/workflows/pr.yml and .github/ci-timeout-budgets.json and fails
// closed when a required-lane job's `timeout-minutes` is not the sum of a declared work
// budget and a declared infrastructure allowance, when the `Setup pnpm` step has no cap of
// its own, or when EITHER declared number has drifted past the measurement it claims to rest
// on — the work budget past `measuredMaxWorkSeconds`, or the allowance past the manifest's
// `setupAllowance.measuredMaxSetupSeconds`. The allowance ceiling was missing until
// 2026-09-05; it is the dial one edit moves across all eight jobs at once.
//
// Both comparisons are against a measurement DECLARED IN THE SAME COMMIT. Nothing here is
// compared to a previously committed value, so a raise that stays inside a ceiling passes
// silently — `--explain` prints how much room that is, per number. See (c) in the library.
//
// See scripts/lib/ci-timeout-budgets.mjs for why a single job cap is the wrong instrument
// for a step whose duration is a third-party network fetch.
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  MAX_SETUP_ALLOWANCE_FACTOR,
  MAX_WORK_BUDGET_FACTOR,
  evaluateCiTimeoutBudgets,
  parseWorkflowJobs,
  derivedJobCapMinutes,
  derivedStepCapMinutes,
} from "./lib/ci-timeout-budgets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKFLOW_RELATIVE_PATH = ".github/workflows/pr.yml";
export const MANIFEST_RELATIVE_PATH = ".github/ci-timeout-budgets.json";

function main() {
  const workflowPath = path.join(repoRoot, WORKFLOW_RELATIVE_PATH);
  const manifestPath = path.join(repoRoot, MANIFEST_RELATIVE_PATH);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(`FAIL  cannot read ${MANIFEST_RELATIVE_PATH}: ${err.message}`);
    process.exit(1);
  }

  const jobs = parseWorkflowJobs(readFileSync(workflowPath, "utf8"));
  const { ok, findings } = evaluateCiTimeoutBudgets({ jobs, manifest });

  if (process.argv.includes("--explain")) {
    const rows = Object.entries(manifest.jobs || {}).sort(([a], [b]) => a.localeCompare(b));
    console.log("job                    work    setup     cap   (measured worst work)   free work raise");
    for (const [id, e] of rows) {
      const workCeiling = MAX_WORK_BUDGET_FACTOR * e.measuredMaxWorkSeconds;
      console.log(
        id.padEnd(22) +
          String(e.workBudgetSeconds + "s").padStart(6) +
          String(e.setupAllowanceSeconds + "s").padStart(8) +
          String(derivedJobCapMinutes(e) + "m").padStart(7) +
          "   (" +
          e.measuredMaxWorkSeconds +
          "s over n=" +
          e.measuredSampleSize +
          ", step cap " +
          derivedStepCapMinutes(e) +
          "m)" +
          "   +" +
          (workCeiling - e.workBudgetSeconds) +
          "s to the " +
          workCeiling +
          "s ceiling",
      );
    }
    const sa = manifest.setupAllowance || {};
    const setupCeiling = MAX_SETUP_ALLOWANCE_FACTOR * (sa.measuredMaxSetupSeconds || 0);
    // The allowance is one number repeated per job; say so from the data rather than assuming.
    const declared = [...new Set(rows.map(([, e]) => e.setupAllowanceSeconds))].sort((a, b) => a - b);
    console.log(
      "\nsetup allowance ceiling: " +
        MAX_SETUP_ALLOWANCE_FACTOR +
        "x " +
        sa.measuredMaxSetupSeconds +
        "s = " +
        setupCeiling +
        "s (measured " +
        sa.measuredOn +
        " over n=" +
        sa.measuredSampleSize +
        ") — declared " +
        declared.join("/") +
        "s across " +
        rows.length +
        " job(s), so +" +
        (setupCeiling - declared[declared.length - 1]) +
        "s is free" +
        (declared.length === 1 ? " on all " + rows.length + " at once" : " on the highest"),
    );
    console.log(
      "★ the job cap is work + allowance, and the allowance is UNRESERVED: a job whose setup is\n" +
        "  fast may spend the cap on work. workBudgetSeconds is a DECLARED bound, not a runtime one.\n" +
        "★ the `free` figures are what this guard does NOT see: it compares each number to a\n" +
        "  measurement declared in the same commit, never to the value previously committed.",
    );
    console.log("");
  }

  if (!ok) {
    console.error("FAIL  CI timeout budgets are not derived from their declared measurements.\n");
    for (const f of findings) {
      console.error(`  [${f.code}] ${f.job ?? "-"}: ${f.detail}`);
    }
    console.error(
      `\n${findings.length} problem(s). Fix ${MANIFEST_RELATIVE_PATH} or ${WORKFLOW_RELATIVE_PATH}` +
        " so that each required-lane job's cap is the sum of a work budget and an" +
        " infrastructure allowance, and each budget is within reach of a dated measurement.",
    );
    process.exit(1);
  }

  const budgeted = Object.keys(manifest.jobs || {}).length;
  const exempted = Object.keys(manifest.exempt || {}).length;
  console.log(
    `CI timeout budgets OK: ${budgeted} pnpm-exposed job(s) derived from measurement, ` +
      `${exempted} required-lane job(s) exempt with a stated reason.`,
  );
}

main();
