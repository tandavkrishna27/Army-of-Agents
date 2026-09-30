// W19 -- the pin for scripts/ci-local.mjs's "skip pnpm install" guard.
//
// ★★★ WHAT THIS EXISTS TO CATCH, stated as the two defects it was written from. The guard
// read, in source, `if (/^pnpm install<0x08>/.test(cmd)) continue;` -- a literal backspace
// byte where the two characters backslash-b belonged, eaten by a shell heredoc when the file
// was written. It matched nothing, so the deviation its own comment called "the ONE deliberate
// deviation from CI" had never once been in effect: eight `pnpm install` steps executed,
// including `policy`'s LOCKFILE-MUTATING --lockfile-only variant, in the DEFAULT fast gate.
//
// Fixing the byte moved that count 8 -> 7, not 8 -> 0, which is the second defect and the
// reason this file asserts a COUNT rather than a byte. The guard sat only on the multi-line
// `run: |` path; seven of the eight installs are inline `run:` steps the parser pushes and
// returns on, above the guard. A byte-only test would have gone green over a guard that still
// covered one eighth of the cases.
//
// So: assert the CONSEQUENCE (zero installs survive parsing of the real pr.yml), assert the
// MECHANISM (both parser paths), and assert the BYTE (no control characters in the source).
// Each of the three fails independently.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseJobs, IS_INSTALL_STEP, INSTALL_SKIP_REASON } from "../../ci-local.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "pr.yml");
const SOURCE = path.join(ROOT, "scripts", "ci-local.mjs");

/** Every step the runner would actually EXECUTE (strings; objects are recorded skips). */
function executableSteps(jobs) {
  const out = [];
  for (const [job, steps] of jobs) {
    for (const step of steps) if (typeof step === "string") out.push({ job, step });
  }
  return out;
}

test("no `pnpm install` step survives parsing of the real pr.yml", () => {
  const jobs = parseJobs(readFileSync(WORKFLOW, "utf8"));
  const surviving = executableSteps(jobs).filter((s) => /pnpm install/.test(s.step));
  assert.deepEqual(
    surviving,
    [],
    `these \`pnpm install\` steps would run locally:\n${surviving
      .map((s) => `  ${s.job} :: ${s.step}`)
      .join("\n")}`,
  );
});

test("the guard covers BOTH parser paths -- the inline `run:` one is where 7 of 8 lived", () => {
  const jobs = parseJobs(readFileSync(WORKFLOW, "utf8"));
  const deviations = [];
  for (const [job, steps] of jobs) {
    for (const step of steps) {
      if (typeof step === "object" && step.deliberateSkip) deviations.push({ job, step });
    }
  }
  // Seven inline (`run: pnpm install --frozen-lockfile`) plus one block-form
  // (`policy`'s --lockfile-only, inside a `run: |`). If this drops to 1, the guard has
  // slipped back onto the block path only.
  assert.ok(
    deviations.length >= 8,
    `expected >= 8 recorded install deviations, saw ${deviations.length}`,
  );
  assert.ok(
    deviations.some((d) => d.job === "policy" && /--lockfile-only/.test(d.step.deliberateSkip)),
    "the block-form `policy` lockfile-only install must be a recorded deviation",
  );
  assert.ok(
    deviations.some((d) => d.job === "verify" && /--frozen-lockfile/.test(d.step.deliberateSkip)),
    "the inline `verify` install must be a recorded deviation",
  );
  for (const d of deviations) {
    assert.equal(d.step.why, INSTALL_SKIP_REASON, "every deviation carries the stated reason");
  }
});

test("the deviation is REPORTED, never silently dropped", () => {
  // The source comment claims the deviation "is stated in --list". It said that while --list
  // stated nothing, which is the same class of defect as the dead byte: self-description that
  // does not match behaviour. A recorded object is what makes the claim checkable.
  const jobs = parseJobs(readFileSync(WORKFLOW, "utf8"));
  const verify = jobs.get("verify") ?? [];
  const recorded = verify.filter((s) => typeof s === "object" && s.deliberateSkip);
  assert.equal(recorded.length, 1);
  assert.match(INSTALL_SKIP_REASON, /pnpm-lock\.yaml/);
});

test("the regex matches both install forms, and is not anchored to a control byte", () => {
  assert.ok(IS_INSTALL_STEP.test("pnpm install --frozen-lockfile"));
  assert.ok(IS_INSTALL_STEP.test("pnpm install --lockfile-only --ignore-scripts"));
  assert.ok(IS_INSTALL_STEP.test("pnpm install"));
  // Not a blanket `pnpm` skip: a real check that merely starts with the same word must run.
  assert.equal(IS_INSTALL_STEP.test("pnpm installer:verify"), false);
  assert.equal(IS_INSTALL_STEP.test("pnpm run install-check"), false);
  assert.equal(IS_INSTALL_STEP.test("node scripts/check-x.mjs"), false);
});

// ---------------------------------------------------------------- the ENTRY POINT

/**
 * ★★★ THE HOLE THIS PR OPENED, CLOSED IN THE SAME PR.
 *
 * `main()` in scripts/ci-local.mjs used to be UNCONDITIONAL. Exporting `parseJobs` so this file
 * could pin the REAL parser required guarding it behind
 *
 *     if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
 *
 * and that conditional is now a place a regression can hide. An adversarial mutation pass proved
 * it: drop the `fileURLToPath` call (a plausible refactor — the two sides look comparable) and
 * the predicate is false on every platform forever. Measured, the mutant turned the whole runner
 * into a SILENT NO-OP:
 *
 *     $ node scripts/ci-local.mjs --list   ->  exit 0, zero bytes of output
 *     $ node scripts/ci-local.mjs          ->  exit 0, zero bytes of output
 *
 * and all five tests above stayed green, because every one of them imports the module and none
 * of them runs the script. A local runner that exits 0 having executed NOTHING is worse than a
 * missing runner: 0 is the same code a passing gate returns, so it reads as "your tree is clean".
 *
 * ★ WHY `--list`, AND WHY IT IS SUFFICIENT. It is the only invocation that reaches `main()`
 * without executing a single CI job — a real `node scripts/ci-local.mjs` run is the fast gate
 * and takes minutes, which is not a cost this suite may impose. `--list` still exercises the
 * whole entry path: existsSync on the workflow, readFileSync, `parseJobs`, the CANNOT_RUN_HERE
 * table, and the deviation reporting. So the assertions are on OUTPUT, not merely on status 0 —
 * an exit code alone cannot tell "ran and passed" from "never ran", and the mutant returns 0.
 *
 * Cost: two spawns, well under a second.
 */
test("the ENTRY POINT actually runs: `--list` reports the workflow rather than exiting 0 in silence", () => {
  const script = path.join(ROOT, "scripts", "ci-local.mjs");
  const listed = spawnSync(process.execPath, [script, "--list"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.equal(listed.status, 0, `--list must exit 0, saw ${listed.status}\n${listed.stderr}`);

  // ★ THE ANTI-NO-OP ASSERTION. Status 0 is what the mutant returns too; only output separates
  // a runner that ran from one that was never called.
  assert.match(listed.stdout, /^jobs in pr\.yml:/m, "the entry point produced NO output at all");

  // It reached the real workflow: the jobs below are pr.yml's, not this test's invention.
  for (const job of ["policy", "verify", "lint", "e2e", "migrations", "ci-required"]) {
    assert.match(
      listed.stdout,
      new RegExp(`^\\s+(RUN|SKIP|--)\\s+${job}\\s`, "m"),
      `--list must name the \`${job}\` job`,
    );
  }
  const jobLines = listed.stdout.split("\n").filter((l) => /^\s+(RUN|SKIP|--)\s/.test(l));
  assert.ok(jobLines.length >= 10, `expected >= 10 job lines, saw ${jobLines.length}`);

  // And it STATES the deviation. The original comment claimed `--list` did this while `--list`
  // said nothing; the claim is only checkable from outside the process.
  assert.match(listed.stdout, /^deliberate deviation from CI: /m);
  assert.ok(
    listed.stdout.includes(INSTALL_SKIP_REASON),
    "--list must print the stated reason verbatim, not a paraphrase that can drift from it",
  );
});

test("the ENTRY POINT still fails loudly: no workflow means exit 2, not a quiet 0", () => {
  // The other half of the same class. `main()` opens with `process.exit(2)` when pr.yml is
  // missing; deleting that line would make a runner pointed at the wrong directory report
  // success, which is the failure mode of the guard this file was written for.
  const empty = mkdtempSync(path.join(os.tmpdir(), "w19-ci-local-noworkflow-"));
  try {
    const missing = spawnSync(process.execPath, [path.join(ROOT, "scripts", "ci-local.mjs")], {
      cwd: empty,
      encoding: "utf8",
    });
    assert.equal(missing.status, 2, `a missing workflow must exit 2, saw ${missing.status}`);
    assert.match(missing.stderr, /no workflow at /);
    assert.equal(missing.stdout.trim(), "", "nothing may be reported as run");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("scripts/ci-local.mjs carries no invisible control characters", () => {
  // The byte half. A literal 0x08 renders invisibly in every terminal, editor and diff view,
  // which is why the original survived review for its whole life. `cat -A` shows it as ^H.
  const text = readFileSync(SOURCE, "utf8");
  const BANNED = [0x00, 0x07, 0x08, 0x0b, 0x0c, 0x1b];
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const code of BANNED) {
      if (line.includes(String.fromCharCode(code))) {
        hits.push(`line ${i + 1}: U+${code.toString(16).padStart(4, "0")}`);
      }
    }
  });
  assert.deepEqual(hits, [], `control characters in ci-local.mjs:\n${hits.join("\n")}`);
});
