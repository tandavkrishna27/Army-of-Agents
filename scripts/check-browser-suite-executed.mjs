#!/usr/bin/env node
// -----------------------------------------------------------------------------
// BRW-002 — prove the real-Chromium browser lane actually EXECUTED.
//
//   node scripts/check-browser-suite-executed.mjs <vitest-json-report>
//
// The browser clauses (a) containment and (c) teardown are only worth anything if
// they ran. `AOA_RUN_BROWSER_TESTS` gates them, so an unset variable, a missing
// Chromium, or a blocked user namespace would skip the entire lane — and a lane
// that runs zero browser tests reports success. That is the exact shape this lane
// was created to eliminate.
//
// It parses vitest's JSON reporter rather than its human output ON PURPOSE. The
// first version of this guard grepped the tee'd log for /Tests +[0-9]+ passed/ and
// failed a run where all 94 tests PASSED, because vitest colourises the count and
// the ANSI escapes sit between "Tests" and the number. Structured counts cannot be
// defeated by formatting.
//
// Non-vacuousness is proven in scripts/check-browser-suite-executed.test.mjs.
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import process from "node:process";

/** Both clause files must be present AND contribute at least one passing test. */
export const REQUIRED_BROWSER_FILES = Object.freeze([
  "browser-containment.browser.test.ts",
  "browser-teardown.browser.test.ts",
]);

/**
 * The ONLY skip this lane tolerates. Clause (c) asserts opposite outcomes per
 * platform — Linux reaps the browser on SIGKILL, Windows orphans it — so exactly
 * one of the two suites is inert on any given runner. Every other skip is drift
 * and must fail the lane by name.
 */
const ALLOWED_SKIP = /on (WINDOWS|LINUX)/;

const SKIPPED = new Set(["pending", "skipped", "todo"]);

/**
 * @param {unknown} report parsed vitest JSON reporter output
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function evaluateBrowserSuite(report) {
  const violations = [];

  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, violations: ["the vitest JSON report is missing or not an object"] };
  }

  const results = Array.isArray(report.testResults) ? report.testResults : [];
  if (results.length === 0) {
    // Fail rather than pass by absence: no report means no evidence, not success.
    return { ok: false, violations: ["the vitest JSON report contains no test files"] };
  }

  const passed = Number(report.numPassedTests ?? 0);
  const failed = Number(report.numFailedTests ?? 0);

  if (!Number.isFinite(passed) || passed <= 0) {
    violations.push(`the browser suite reported no passing tests (numPassedTests=${report.numPassedTests})`);
  }
  if (!Number.isFinite(failed) || failed > 0) {
    violations.push(`the browser suite reported ${report.numFailedTests} failing test(s)`);
  }

  for (const required of REQUIRED_BROWSER_FILES) {
    const files = results.filter((r) => typeof r?.name === "string" && r.name.includes(required));
    if (files.length === 0) {
      violations.push(`${required} did not run`);
      continue;
    }
    // Presence is not execution. A file whose every clause was skipped still
    // appears in the report by name — which is precisely how the grep version
    // could have been fooled in the other direction.
    const anyPassed = files.some((f) =>
      (Array.isArray(f.assertionResults) ? f.assertionResults : []).some((a) => a?.status === "passed"),
    );
    if (!anyPassed) {
      violations.push(`${required} ran but contributed no passing test — every clause in it was skipped`);
    }
  }

  for (const file of results) {
    for (const assertion of Array.isArray(file?.assertionResults) ? file.assertionResults : []) {
      if (!SKIPPED.has(assertion?.status)) continue;
      const name = String(assertion?.fullName ?? "(unnamed)");
      if (ALLOWED_SKIP.test(name)) continue;
      violations.push(`unexpected skipped clause: ${name}`);
    }
  }

  return { ok: violations.length === 0, violations };
}

function main(argv) {
  const target = argv[2];
  if (!target) {
    console.error("usage: node scripts/check-browser-suite-executed.mjs <vitest-json-report>");
    return 2;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    console.error(`::error::cannot read the browser suite report at ${target} — ${error.message}`);
    return 1;
  }

  const { ok, violations } = evaluateBrowserSuite(report);
  if (!ok) {
    for (const violation of violations) console.error(`::error::${violation}`);
    console.error(
      "::error::the browser lane did not prove clauses (a) and (c). A lane that runs zero " +
        "browser tests must never report success.",
    );
    return 1;
  }

  console.log(
    `browser lane executed: ${report.numPassedTests} passing, ${report.numFailedTests ?? 0} failing, ` +
      `${report.numPendingTests ?? 0} platform-skipped across ${report.testResults.length} files`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-browser-suite-executed.mjs")) {
  process.exit(main(process.argv));
}
