#!/usr/bin/env node
/**
 * check-ci-timeout-budgets.test.mjs — corpus for the derived-cap gate.
 *
 * Run with:
 *   node --test scripts/check-ci-timeout-budgets.test.mjs
 *
 * Four sections. (C) was added after the first review, (D) after the second.
 *
 * (A) THE REAL FILES. The scanner runs against the actual .github/workflows/pr.yml and the
 *     actual manifest, and asserts both that it FINDS the nine-job exposure it was written
 *     for and that the tree is currently clean. A guard whose scanner silently stops matching
 *     reports a clean workflow forever — the failure mode this programme calls "a check that
 *     nothing runs" — so the scanner's sight is asserted, not assumed.
 *
 * (B) MUTATIONS OF THE REAL FILES. Every clause is proven by taking the real, currently-green
 *     inputs and breaking exactly one thing. In particular `catches the real defect this guard
 *     was built for` reconstructs the pre-fix state — a `Setup pnpm` step with no cap of its
 *     own inside a job whose cap silently absorbs it — and asserts red. That state was the tip
 *     of this branch before this commit, and 17 findings across 9 jobs were the measured red.
 *
 * (C) THE OTHER DIAL, added 2026-09-05. The first version of this guard gave the WORK budget a
 *     ceiling and gave `setupAllowanceSeconds` none — a uniform number that derives eight
 *     job caps and eight step caps, so one measurement-free edit moved all sixteen and the
 *     guard printed OK. Review demonstrated it (480 -> 3000: `policy` 11 m -> 53 m, step cap
 *     8 -> 50). Every test in (C) was run against the pre-correction library and RED: 6 of 6.
 *     "raising the allowance PAST ITS CEILING" opens with a positive control, because an
 *     assertion that a code is ABSENT passes vacuously against a build that never emits it.
 *
 * (D) WHAT THE GUARD DOES NOT SEE, added 2026-09-05 after a SECOND review. (C) closed the case
 *     where a number leaves its ceiling; it did not close the case where a number moves UP TO
 *     its ceiling, nor the case where a required-lane job arrives with no cap at all. These are
 *     DISCLOSURE tests: they assert the guard PASSES those diffs, and that the figures quoted in
 *     the library, the manifest, the GO-BOOK and the finding register are the figures the
 *     shipped manifest implies. Every test here that asserts the guard PASSES something opens
 *     with a positive control first, because asserting `ok: true` proves nothing unless the same
 *     harness can produce a red for the same inputs. If someone later builds the
 *     diff-aware instrument that closes either hole, these go RED and the prose is corrected
 *     with them.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_SETUP_ALLOWANCE_FACTOR,
  MAX_WORK_BUDGET_FACTOR,
  MIN_MEASUREMENT_SAMPLE_SIZE,
  derivedJobCapMinutes,
  derivedStepCapMinutes,
  evaluateCiTimeoutBudgets,
  parseWorkflowJobs,
} from "./lib/ci-timeout-budgets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = path.join(repoRoot, ".github", "workflows", "pr.yml");
const MANIFEST = path.join(repoRoot, ".github", "ci-timeout-budgets.json");

// Normalised to LF. On a Windows checkout with core.autocrlf the working tree is CRLF, and the
// mutation helpers below rewrite lines by anchored regex (`...: 8$`), which then match nothing
// and silently leave the workflow unmutated -- a mutation test that mutates nothing passes or
// fails for reasons unrelated to the clause under test. The guard itself is line-ending
// agnostic (parseWorkflowJobs splits on a CR-optional newline); only these helpers care.
const workflowText = fs.readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n");
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

const clone = (o) => JSON.parse(JSON.stringify(o));
const run = (text, m) => evaluateCiTimeoutBudgets({ jobs: parseWorkflowJobs(text), manifest: m });
const codes = (r) => r.findings.map((f) => f.code);

// ---------------------------------------------------------------------------
// (A) The real files.
// ---------------------------------------------------------------------------

test("the scanner actually sees pr.yml — jobs, caps, needs, and the pnpm step", () => {
  const jobs = parseWorkflowJobs(workflowText);
  assert.ok(jobs.length >= 10, `expected the workflow's jobs, got ${jobs.length}`);

  const withSetup = jobs.filter((j) => j.pnpmSetup);
  assert.ok(
    withSetup.length >= 8,
    `expected the multi-job pnpm exposure this guard exists for, saw ${withSetup.length}`,
  );

  const policy = jobs.find((j) => j.id === "policy");
  assert.ok(policy, "policy job not found");
  assert.equal(typeof policy.timeoutMinutes, "number");
  assert.ok(policy.pnpmSetup, "policy must still run pnpm/action-setup");
  assert.match(policy.pnpmSetup.name, /pnpm/i);

  const required = jobs.find((j) => j.id === "ci-required");
  assert.ok(required, "ci-required aggregator not found");
  assert.ok(required.needs.includes("policy"), "ci-required must consume policy");
  assert.ok(required.needs.length >= 5, "ci-required needs list did not parse");
});

test("the tree is currently green", () => {
  const result = run(workflowText, manifest);
  assert.deepEqual(result.findings, [], "real workflow + real manifest must be clean");
  assert.equal(result.ok, true);
});

test("every budgeted job's two caps are exactly the derived values", () => {
  const jobs = new Map(parseWorkflowJobs(workflowText).map((j) => [j.id, j]));
  for (const [id, entry] of Object.entries(manifest.jobs)) {
    const job = jobs.get(id);
    assert.ok(job, `${id} budgeted but absent from the workflow`);
    assert.equal(job.timeoutMinutes, derivedJobCapMinutes(entry), `${id} job cap`);
    assert.equal(job.pnpmSetup.timeoutMinutes, derivedStepCapMinutes(entry), `${id} step cap`);
  }
});

// ---------------------------------------------------------------------------
// (B) Mutations.
// ---------------------------------------------------------------------------

test("catches the real defect this guard was built for: an uncapped pnpm step", () => {
  // Reconstruct the pre-fix state of every budgeted job: the step cap lines removed, so the
  // job cap alone absorbs a fetch that has been measured at 431s.
  const mutated = workflowText
    .split("\n")
    .filter((l) => !/^ {8}timeout-minutes: 8$/.test(l))
    .join("\n");
  const result = run(mutated, manifest);
  assert.equal(result.ok, false);
  const uncapped = result.findings.filter((f) => f.code === "setup_step_uncapped");
  assert.equal(
    uncapped.length,
    Object.keys(manifest.jobs).length,
    "every budgeted job must be reported, not just the first",
  );
  assert.match(uncapped[0].detail, /blames whichever step is running at the wall/);
});

test("catches a job cap edited on its own", () => {
  const policyCap = derivedJobCapMinutes(manifest.jobs.policy);
  const mutated = workflowText.replace(
    `    timeout-minutes: ${policyCap}\n`,
    `    timeout-minutes: ${policyCap + 4}\n`,
  );
  assert.notEqual(mutated, workflowText, "mutation did not apply");
  const result = run(mutated, manifest);
  assert.ok(codes(result).includes("job_cap_mismatch"));
});

test("catches a step cap edited on its own", () => {
  const mutated = workflowText.replace(
    /^ {8}timeout-minutes: 8$/m,
    "        timeout-minutes: 20",
  );
  assert.notEqual(mutated, workflowText, "mutation did not apply");
  const result = run(mutated, manifest);
  assert.ok(codes(result).includes("setup_step_cap_mismatch"));
});

test("catches instance ten: a NEW job that adds pnpm/action-setup with no budget", () => {
  const mutated = `${workflowText}
  freshly-added-lane:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Setup pnpm
        uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9
`;
  const result = run(mutated, manifest);
  const f = result.findings.find((x) => x.code === "job_missing_budget");
  assert.ok(f, "a new pnpm-exposed job must be refused");
  assert.equal(f.job, "freshly-added-lane");
});

test("catches instance ten's other shape: a required-lane job with a cap and no budget", () => {
  const m = clone(manifest);
  delete m.exempt["worker-protocol-contract-bytes"];
  const result = run(workflowText, m);
  const f = result.findings.find((x) => x.code === "required_lane_unbudgeted");
  assert.ok(f, "an unbudgeted, unexempt required-lane cap must be refused");
  assert.equal(f.job, "worker-protocol-contract-bytes");
});

test("refuses a work budget past 2x the measurement DECLARED BESIDE IT", () => {
  // Note what this does and does not say. The comparison is to `measuredMaxWorkSeconds` in the
  // same file, not to the budget previously committed — see the (D) residue test below.
  const m = clone(manifest);
  const measured = m.jobs.policy.measuredMaxWorkSeconds;
  m.jobs.policy.workBudgetSeconds = MAX_WORK_BUDGET_FACTOR * measured + 1;
  const result = run(workflowText, m);
  const f = result.findings.find((x) => x.code === "work_budget_unjustified");
  assert.ok(f, "a budget past its own measurement must be refused");
  assert.match(f.detail, /Re-measure/);
});

test("refuses a budget below its own measurement", () => {
  const m = clone(manifest);
  m.jobs.lint.workBudgetSeconds = m.jobs.lint.measuredMaxWorkSeconds - 1;
  assert.ok(codes(run(workflowText, m)).includes("work_budget_below_measurement"));
});

test("refuses a measurement that is not one", () => {
  for (const mutate of [
    (e) => {
      e.measuredSampleSize = MIN_MEASUREMENT_SAMPLE_SIZE - 1;
    },
    (e) => {
      e.measuredOn = "yesterday";
    },
    (e) => {
      e.measuredRuns = [];
    },
    (e) => {
      delete e.measuredMaxWorkSeconds;
    },
  ]) {
    const m = clone(manifest);
    mutate(m.jobs.browser);
    assert.ok(
      codes(run(workflowText, m)).includes("measurement_incomplete"),
      "an unattributable measurement must be refused",
    );
  }
});

test("refuses an exemption with no argument in it", () => {
  const m = clone(manifest);
  m.exempt.changes = { reason: "n/a" };
  assert.ok(codes(run(workflowText, m)).includes("exempt_without_reason"));
});

test("refuses a stale budget for a job that no longer fetches pnpm", () => {
  const m = clone(manifest);
  m.jobs["brand-check"] = clone(m.jobs.lint);
  const result = run(workflowText, m);
  const f = result.findings.find((x) => x.code === "budget_orphan");
  assert.ok(f, "brand-check no longer runs pnpm/action-setup; budgeting it must be refused");
  assert.equal(f.job, "brand-check");

  const m2 = clone(manifest);
  m2.jobs["a-job-that-does-not-exist"] = clone(m2.jobs.lint);
  assert.ok(codes(run(workflowText, m2)).includes("budget_orphan"));
});

test("a scanner that matches nothing FAILS rather than reporting clean", () => {
  assert.deepEqual(codes(run("", manifest)), ["scanner_found_no_jobs"]);

  const noPnpm = workflowText.replaceAll("pnpm/action-setup", "some-other/action");
  const result = run(noPnpm, manifest);
  assert.equal(result.ok, false);
  assert.ok(
    codes(result).includes("scanner_found_no_pnpm_setup_steps"),
    "losing sight of every pnpm step must be a failure, not a pass",
  );
});

test("the derivation is the documented arithmetic", () => {
  assert.equal(derivedJobCapMinutes({ workBudgetSeconds: 150, setupAllowanceSeconds: 480 }), 11);
  assert.equal(derivedJobCapMinutes({ workBudgetSeconds: 1, setupAllowanceSeconds: 59 }), 1);
  assert.equal(derivedJobCapMinutes({ workBudgetSeconds: 1, setupAllowanceSeconds: 60 }), 2);
  assert.equal(derivedStepCapMinutes({ setupAllowanceSeconds: 480 }), 8);
  assert.equal(derivedStepCapMinutes({ setupAllowanceSeconds: 481 }), 9);
});

// ---------------------------------------------------------------------------
// (C) The OTHER dial. Added 2026-09-05 after review refuted the claim that the escape hatch
//     was closed: `setupAllowanceSeconds` had no ceiling, no measurement and no clause, and it
//     is UNIFORM, so one edit moved all eight job caps and all eight step caps at once. Every
//     test below fails against the guard as originally shipped.
// ---------------------------------------------------------------------------

/** Rewrite the real workflow's caps to whatever a mutated manifest derives, so the mutation
 * under test is the ONLY thing wrong. This is the shape of the refuting diff: three lines. */
function reDeriveCaps(text, m) {
  const lines = text.split("\n");
  for (const job of parseWorkflowJobs(text)) {
    const entry = m.jobs[job.id];
    if (!entry) continue;
    for (let i = job.line - 1; i < lines.length; i += 1) {
      if (/^ {4}timeout-minutes: \d+\s*$/.test(lines[i])) {
        lines[i] = `    timeout-minutes: ${derivedJobCapMinutes(entry)}`;
        break;
      }
    }
  }
  const step = derivedStepCapMinutes(Object.values(m.jobs)[0]);
  return lines.map((l) => (/^ {8}timeout-minutes: 8$/.test(l) ? `        timeout-minutes: ${step}` : l)).join("\n");
}

test("refuses THE REFUTING DIFF: the uniform allowance raised with its two derived caps", () => {
  // Verbatim the diff review demonstrated against the first version of this guard: allowance
  // 480 -> 3000, job caps re-derived (policy 11 -> 53), step caps re-derived (8 -> 50). It
  // printed OK. It must now red on every budgeted job, not just the first.
  const m = clone(manifest);
  for (const e of Object.values(m.jobs)) e.setupAllowanceSeconds = 3000;
  const result = run(reDeriveCaps(workflowText, m), m);
  assert.equal(result.ok, false, "the measurement-free three-line raise must be refused");
  const bad = result.findings.filter((f) => f.code === "setup_allowance_unjustified");
  assert.equal(
    bad.length,
    Object.keys(m.jobs).length,
    "one edit moves every job's cap, so every job must be reported",
  );
  assert.match(bad[0].detail, /Re-measure `setupAllowance`/);
});

test("the allowance ceiling is exactly MAX_SETUP_ALLOWANCE_FACTOR x its measurement", () => {
  const measured = manifest.setupAllowance.measuredMaxSetupSeconds;
  const ceiling = MAX_SETUP_ALLOWANCE_FACTOR * measured;

  const atCeiling = clone(manifest);
  atCeiling.jobs.policy.setupAllowanceSeconds = Math.floor(ceiling);
  assert.ok(
    !codes(run(reDeriveCaps(workflowText, atCeiling), atCeiling)).includes(
      "setup_allowance_unjustified",
    ),
    "the ceiling itself must be reachable",
  );

  const overCeiling = clone(manifest);
  overCeiling.jobs.policy.setupAllowanceSeconds = Math.floor(ceiling) + 1;
  assert.ok(
    codes(run(reDeriveCaps(workflowText, overCeiling), overCeiling)).includes(
      "setup_allowance_unjustified",
    ),
    "one second past the ceiling must red",
  );
});

test("raising the allowance PAST ITS CEILING costs a dated re-measurement", () => {
  // The point is not that 3000 is forbidden forever. It is that reaching it requires editing
  // measuredMaxSetupSeconds -- a claim about reality, dated and attributed to run ids, sitting
  // in the diff where review can argue with it. Exactly the work dial's bargain.
  //
  // ★ SCOPE, because an earlier version of this file's title claimed more than this test shows:
  // 3000 is past the ceiling. 646 is not, and costs nothing. See the (D) test below.
  const m = clone(manifest);
  for (const e of Object.values(m.jobs)) e.setupAllowanceSeconds = 3000;

  // POSITIVE CONTROL first. Asserting the ABSENCE of a code passes vacuously against a build
  // that never emits it — which is precisely how this guard shipped. So prove the code is
  // present for this exact input before proving the re-measurement clears it.
  assert.ok(
    codes(run(reDeriveCaps(workflowText, m), m)).includes("setup_allowance_unjustified"),
    "control: without a new measurement this allowance must be refused",
  );

  m.setupAllowance.measuredMaxSetupSeconds = 2000;
  const result = run(reDeriveCaps(workflowText, m), m);
  assert.ok(
    !codes(result).includes("setup_allowance_unjustified"),
    "a re-measured allowance must be admissible; the cost is the measurement, not a veto",
  );
});

test("refuses an allowance below the worst setup already measured", () => {
  const m = clone(manifest);
  m.jobs.lint.setupAllowanceSeconds = m.setupAllowance.measuredMaxSetupSeconds - 1;
  const result = run(reDeriveCaps(workflowText, m), m);
  const f = result.findings.find((x) => x.code === "setup_allowance_below_measurement");
  assert.ok(f, "a step cap the measured episode already exceeds must be refused");
  assert.equal(f.job, "lint");
});

test("refuses deleting or gutting the setup measurement itself", () => {
  const gutted = [
    (m) => {
      delete m.setupAllowance;
    },
    (m) => {
      m.setupAllowance.measuredMaxSetupSeconds = 0;
    },
    (m) => {
      m.setupAllowance.measuredSampleSize = MIN_MEASUREMENT_SAMPLE_SIZE - 1;
    },
    (m) => {
      m.setupAllowance.measuredOn = "during the episode";
    },
    (m) => {
      m.setupAllowance.measuredRuns = [];
    },
  ];
  for (const mutate of gutted) {
    const m = clone(manifest);
    mutate(m);
    const result = run(workflowText, m);
    assert.equal(result.ok, false);
    assert.ok(
      codes(result).includes("setup_measurement_incomplete"),
      "deleting the measurement must not delete the ceiling with it",
    );
  }
});

test("★ the residue is stated, not bounded: work may spend the whole cap minus a fast setup", () => {
  // Not a guard clause -- an assertion that the number in the docs is the number in the files,
  // so the honest statement cannot drift away from the manifest it describes. The job cap does
  // NOT bound the work: the allowance is additive and unreserved, and no runtime check compares
  // realized work to workBudgetSeconds.
  const P50_SETUP_SECONDS = 4;
  const worst = Object.entries(manifest.jobs)
    .map(([id, e]) => ({
      id,
      ratio: (derivedJobCapMinutes(e) * 60 - P50_SETUP_SECONDS) / e.measuredMaxWorkSeconds,
    }))
    .sort((a, b) => b.ratio - a.ratio)[0];
  assert.equal(worst.id, "lint");
  assert.ok(worst.ratio > 9 && worst.ratio < 10, `expected ~9.8x, got ${worst.ratio.toFixed(2)}x`);

  const lib = fs.readFileSync(path.join(repoRoot, "scripts", "lib", "ci-timeout-budgets.mjs"), "utf8");
  assert.match(lib, /THE JOB CAP DOES NOT BOUND THE WORK/);
  assert.match(lib, /`lint` 9\.8×/);
});

// ---------------------------------------------------------------------------
// (D) THE RAISE THIS GUARD DOES NOT SEE, added 2026-09-05 after a second review.
//
// (C) closed the case where a number leaves its ceiling. It did not — and an earlier version
// of this file's prose said it did — close the case where a number moves UP TO its ceiling.
// Every clause compares a declared number to a measurement declared in the SAME FILE; none
// compares anything to a previously committed value. So the shipped numbers are not a floor.
//
// A second miss is recorded here too: a required-lane job with NO cap at all is skipped by the
// coverage clause, so it is neither budgeted nor exempt nor reported.
//
// These are DISCLOSURE tests, not guard clauses. They assert that the guard PASSES both of those
// diffs, and that the figures quoted in the library, the manifest, the GO-BOOK and the FINDING
// REGISTER are the figures the shipped manifest actually implies — the register especially,
// because a residue stated in a PR body and left out of the register has not been disclosed.
// If someone later builds the diff-aware instrument that closes either hole, these tests go RED
// and the prose is corrected with them.
// ---------------------------------------------------------------------------

/** Every declared number pushed to its own ceiling, with NO `measured*` field touched. */
function freeRaise(m) {
  const raised = clone(m);
  raised.setupAllowance.measuredMaxSetupSeconds = m.setupAllowance.measuredMaxSetupSeconds;
  const allowance = Math.floor(MAX_SETUP_ALLOWANCE_FACTOR * m.setupAllowance.measuredMaxSetupSeconds);
  for (const e of Object.values(raised.jobs)) {
    e.workBudgetSeconds = Math.floor(MAX_WORK_BUDGET_FACTOR * e.measuredMaxWorkSeconds);
    e.setupAllowanceSeconds = allowance;
  }
  return raised;
}

test("★ (D) a raise to the ceiling edits NO measurement and the guard prints OK", () => {
  const raised = freeRaise(manifest);

  // Not a single measured* field differs from the shipped manifest.
  for (const [id, e] of Object.entries(raised.jobs)) {
    const shipped = manifest.jobs[id];
    for (const k of ["measuredMaxWorkSeconds", "measuredSampleSize", "measuredOn"]) {
      assert.deepEqual(e[k], shipped[k], `${id}.${k} must be untouched by a free raise`);
    }
  }
  assert.deepEqual(raised.setupAllowance, manifest.setupAllowance);

  // POSITIVE CONTROL. Asserting `ok` proves nothing unless this harness can produce a red at
  // all — the same trap (C) records. One second past a ceiling must red on the same inputs.
  const past = clone(raised);
  past.jobs.policy.workBudgetSeconds += 1;
  assert.ok(
    codes(run(reDeriveCaps(workflowText, past), past)).includes("work_budget_unjustified"),
    "control: one second past the ceiling must red, or this test proves nothing",
  );

  const result = run(reDeriveCaps(workflowText, raised), raised);
  assert.equal(result.ok, true, "the free raise is not refused: " + JSON.stringify(result.findings));
});

test("★ (D) the size of the free raise is the size the docs quote", () => {
  const raised = freeRaise(manifest);
  const sum = (m) => Object.values(m.jobs).reduce((a, e) => a + derivedJobCapMinutes(e), 0);

  assert.equal(sum(manifest), 142, "shipped total derived job cap");
  assert.equal(sum(raised), 187, "total after a measurement-free raise to the ceilings");
  assert.equal(derivedJobCapMinutes(manifest.jobs.verify), 37);
  assert.equal(derivedJobCapMinutes(raised.jobs.verify), 48);
  assert.equal(derivedJobCapMinutes(manifest.jobs.e2e), 33);
  assert.equal(derivedJobCapMinutes(raised.jobs.e2e), 46);
  for (const id of Object.keys(manifest.jobs)) {
    assert.equal(derivedStepCapMinutes(manifest.jobs[id]), 8);
    assert.equal(derivedStepCapMinutes(raised.jobs[id]), 11);
  }

  // The three headline pairs quoted in the manifest, the library and the GO-BOOK.
  assert.equal(manifest.jobs.verify.workBudgetSeconds, 1700);
  assert.equal(MAX_WORK_BUDGET_FACTOR * manifest.jobs.verify.measuredMaxWorkSeconds, 2184);
  assert.equal(manifest.jobs.e2e.workBudgetSeconds, 1500);
  assert.equal(MAX_WORK_BUDGET_FACTOR * manifest.jobs.e2e.measuredMaxWorkSeconds, 2092);
  assert.equal(manifest.jobs.policy.setupAllowanceSeconds, 480);
  assert.equal(MAX_SETUP_ALLOWANCE_FACTOR * manifest.setupAllowance.measuredMaxSetupSeconds, 646.5);
});

test("★ (D) the withdrawal is written where the register can be read from", () => {
  // A residue stated in a PR body and omitted from the durable files has not been disclosed.
  const lib = fs.readFileSync(path.join(repoRoot, "scripts", "lib", "ci-timeout-budgets.mjs"), "utf8");
  assert.match(lib, /A RAISE INSIDE THE CEILING IS NOT SEEN/);

  // THE NEGATIVE HALF. Asserting the disclosure is PRESENT cannot catch the withdrawn
  // wording surviving elsewhere - which is how an unqualified "may not be raised without
  // a new dated measurement" sat in the setup_allowance_unjustified stderr string through
  // two correction rounds, contradicting this same file header. The reader who meets that
  // string is mid-edit raising the allowance: the precise reader the withdrawal protects.
  // String matching, not regex: the details are built by concatenating literals, so a
  // phrase spanning the join is invisible to a naive pattern. These fragments each sit
  // inside ONE literal, which is what makes them findable.
  for (const withdrawn of [
    "may not be raised",
    "costs a re-measurement in the same diff",
    "enforced on BOTH dials",
  ]) {
    assert.ok(!lib.includes(withdrawn), `withdrawn claim survives in the library: ${withdrawn}`);
  }
  assert.match(lib, /142 min → 187 min/);

  const manifestText = fs.readFileSync(MANIFEST, "utf8");
  assert.match(manifestText, /WHAT IT DOES NOT SEE: A RAISE INSIDE THE CEILING/);
  assert.match(manifestText, /142 to 187 minutes/);

  const ownership = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "scripts", "finding-ownership.json"), "utf8"),
  );
  for (const id of ["E3-F036", "E6-F014"]) {
    const reason = ownership.findings[id].reason;
    assert.match(reason, /WITHDRAWN/, `${id} must carry the withdrawal, not just the PR body`);
    assert.match(reason, /142 to 187 minutes|E3-F036 item \(4\)/, `${id} must carry or cite the size`);
  }

  const goBook = fs.readFileSync(path.join(repoRoot, "docs", "replatform", "GO-BOOK.md"), "utf8");
  assert.match(goBook, /142 min → 187 min/);
});

test("★ (D) a required-lane job with NO cap is not budgeted, not exempt, and not reported", () => {
  // The coverage clause reads `if (job.timeoutMinutes === null) continue`. So the one shape it
  // was written for — a new required-lane job arriving with a number nobody justified — is
  // missed when the job arrives with NO number at all and inherits GitHub's 360-minute default.
  // Disclosure, not a clause: this asserts the miss so the prose describing it cannot go stale.
  const uncapped = parseWorkflowJobs(workflowText).map((j) =>
    j.id === "brand-check" ? { ...j, timeoutMinutes: null } : j,
  );

  // POSITIVE CONTROL. With its cap present, deleting the exemption MUST red — otherwise this
  // test would be asserting the absence of a code the harness cannot produce for these inputs.
  const m = clone(manifest);
  delete m.exempt["brand-check"];
  const capped = evaluateCiTimeoutBudgets({ jobs: parseWorkflowJobs(workflowText), manifest: m });
  const control = capped.findings.find((f) => f.code === "required_lane_unbudgeted");
  assert.ok(control, "control: an unbudgeted required-lane job WITH a cap must red");
  assert.equal(control.job, "brand-check");

  // Remove the cap as well, and the finding disappears rather than getting worse.
  const result = evaluateCiTimeoutBudgets({ jobs: uncapped, manifest: m });
  assert.equal(result.ok, true, "the miss is real: " + JSON.stringify(result.findings));

  // The shipped tree has no such job — this is a hole in the guard, not a defect in the tree.
  const required = parseWorkflowJobs(workflowText).find((j) => j.id === "ci-required");
  for (const id of required.needs) {
    const job = parseWorkflowJobs(workflowText).find((j) => j.id === id);
    if (job) assert.notEqual(job.timeoutMinutes, null, `${id} must carry a cap`);
  }

  const lib = fs.readFileSync(path.join(repoRoot, "scripts", "lib", "ci-timeout-budgets.mjs"), "utf8");
  assert.match(lib, /A REQUIRED-LANE JOB WITH NO CAP AT ALL IS NOT REPORTED/);
});
