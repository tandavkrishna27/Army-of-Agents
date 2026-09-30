// -----------------------------------------------------------------------------
// BRW-002 browser-lane execution guard (node:test).
//
//   node --test scripts/check-browser-suite-executed.test.mjs
//
// WHY THIS EXISTS, and why it replaced a grep.
//
// The first version of this guard lived inline in pr.yml and grepped the tee'd
// vitest log for /Tests +[0-9]+ passed/. That log still carries ANSI colour codes,
// so vitest's "Tests  \e[1m\e[32m94 passed" never matched and the guard failed a
// run in which all 94 browser tests had PASSED. A guard written to prevent a false
// green produced a false red — the same "the check could not evaluate anything"
// class this programme keeps hitting, just pointing the other way.
//
// The fix is to stop parsing human-readable output at all: vitest's JSON reporter
// emits structured counts, and this module asserts against those. The tests below
// are the non-vacuousness proof — each one breaks a real property and requires the
// evaluator to notice.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBrowserSuite, REQUIRED_BROWSER_FILES } from "./check-browser-suite-executed.mjs";

/** A report shaped like vitest's JSON reporter, green on Linux. */
function greenReport() {
  return {
    numTotalTests: 95,
    numPassedTests: 94,
    numFailedTests: 0,
    numPendingTests: 1,
    testResults: [
      {
        name: "/w/packages/browser-runtime/src/__tests__/browser-containment.browser.test.ts",
        assertionResults: [
          { fullName: "BRW-002 (a) — launches with Chromium's OS sandbox ENABLED", status: "passed" },
          { fullName: "BRW-002 (a) — opens no TCP port that was not already there", status: "passed" },
        ],
      },
      {
        name: "/w/packages/browser-runtime/src/__tests__/browser-teardown.browser.test.ts",
        assertionResults: [
          { fullName: "BRW-002 (c) — closes the browser when the runner receives SIGTERM", status: "passed" },
          { fullName: "BRW-002 (c) — on LINUX, the target platform, SIGKILL reaps the browser", status: "passed" },
          { fullName: "BRW-002 (c) — on WINDOWS, SIGKILL ORPHANS the browser", status: "skipped" },
        ],
      },
      {
        name: "/w/packages/browser-runtime/src/__tests__/launch-guard.test.ts",
        assertionResults: [{ fullName: "refuses a debugging switch", status: "passed" }],
      },
    ],
  };
}

test("the real green shape passes — the guard is not simply always-red", () => {
  const verdict = evaluateBrowserSuite(greenReport());
  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.ok, true);
});

test("REGRESSION: a passing count that a grep would miss is still seen as passing", () => {
  // The exact run the inline grep failed on: 94 passed, 1 skipped. Structured
  // counts cannot be defeated by colour codes, which is the whole point.
  const verdict = evaluateBrowserSuite(greenReport());
  assert.equal(verdict.ok, true, "the guard must accept the run it previously failed");
});

test("zero passing tests is refused — the false-green this guard exists to stop", () => {
  const report = greenReport();
  report.numPassedTests = 0;
  const verdict = evaluateBrowserSuite(report);
  assert.equal(verdict.ok, false);
  assert.match(verdict.violations.join("\n"), /no passing tests/i);
});

test("a failing test is refused even when many others passed", () => {
  const report = greenReport();
  report.numFailedTests = 1;
  const verdict = evaluateBrowserSuite(report);
  assert.equal(verdict.ok, false);
  assert.match(verdict.violations.join("\n"), /failing/i);
});

for (const missing of REQUIRED_BROWSER_FILES) {
  test(`a run without ${missing} is refused`, () => {
    const report = greenReport();
    report.testResults = report.testResults.filter((r) => !r.name.includes(missing));
    const verdict = evaluateBrowserSuite(report);
    assert.equal(verdict.ok, false);
    assert.match(verdict.violations.join("\n"), new RegExp(missing.replace(/\./g, "\\.")));
  });

  test(`${missing} present but entirely skipped is refused`, () => {
    // The subtle false green: the file is NAMED in the report (so a grep for the
    // filename succeeds) while every clause inside it was skipped. Presence is not
    // execution — this is the distinction the grep version could not make.
    const report = greenReport();
    for (const result of report.testResults) {
      if (!result.name.includes(missing)) continue;
      for (const a of result.assertionResults) a.status = "skipped";
    }
    const verdict = evaluateBrowserSuite(report);
    assert.equal(verdict.ok, false);
    assert.match(verdict.violations.join("\n"), /no passing test/i);
  });
}

test("the Windows-only clause may be skipped on Linux — the one legitimate skip", () => {
  const verdict = evaluateBrowserSuite(greenReport());
  assert.equal(verdict.ok, true, "the deliberate cross-platform skip must not fail the lane");
});

test("ANY OTHER skipped clause is refused, named so it cannot be shrugged off", () => {
  // Guards against the real drift risk: someone adds `.skip` to a containment
  // clause and the lane stays green because "some tests passed".
  const report = greenReport();
  report.testResults[0].assertionResults[1].status = "skipped";
  const verdict = evaluateBrowserSuite(report);
  assert.equal(verdict.ok, false);
  assert.match(verdict.violations.join("\n"), /opens no TCP port/);
});

test("a malformed or empty report is refused rather than treated as green", () => {
  // If the JSON never got written, the guard must fail — not pass by absence.
  for (const bad of [null, undefined, {}, { testResults: [] }, "not json"]) {
    const verdict = evaluateBrowserSuite(bad);
    assert.equal(verdict.ok, false, `a ${JSON.stringify(bad)} report must not pass`);
  }
});

test("every spelling vitest may use for a skip is understood", () => {
  // MEASURED, not assumed: `vitest --reporter=json` emits "skipped" for a
  // describe.skipIf'd suite, verified against a real report while building this
  // guard. The first fixture guessed "pending" and was wrong. "pending" and
  // "todo" are accepted too, so a reporter change cannot silently make the
  // unexpected-skip check vacuous.
  for (const spelling of ["skipped", "pending", "todo"]) {
    const report = greenReport();
    report.testResults[0].assertionResults[1].status = spelling;
    const verdict = evaluateBrowserSuite(report);
    assert.equal(verdict.ok, false, `a ${spelling} clause must be caught`);
    assert.match(verdict.violations.join("\n"), /opens no TCP port/);
  }
});
