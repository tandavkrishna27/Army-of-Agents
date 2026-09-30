// -----------------------------------------------------------------------------
// DEP-013 Slice C — THE READER FAILS, IT DOES NOT WARN. Asserted on the EXIT CODE.
//
// ★ WHY A SUBPROCESS SUITE EXISTS AT ALL. The pure verdicts are already proven in
// `scripts/lib/__tests__/workflow-verdict.test.mjs`. What a unit test importing a pure
// function CANNOT prove is the clause this ticket actually buys: that the `policy` step
// FAILS THE JOB rather than printing a warning and exiting 0. A step that echoes and exits 0
// is the 2026-09-03 incident verbatim — a verdict computed, and the next thing running
// anyway. So each vector here SPAWNS the real CLI and asserts `status`, never stdout.
//
// It also proves the reconciler's §4.1 clause the same way: point it at a manifest whose
// EVALUATION throws and assert that the process exits non-zero having published nothing.
// -----------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const READER = path.join(ROOT, "scripts", "check-verdict-consumer-freshness.mjs");
const RECONCILER = path.join(ROOT, "scripts", "reconcile-workflow-verdicts.mjs");
const REAL_MANIFEST = path.join(ROOT, "scripts", "workflow-verdict-manifest.json");

function run(file, args, env = {}) {
  const r = spawnSync(process.execPath, [file, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// The reader's exit code, one vector at a time
// ─────────────────────────────────────────────────────────────────────────────

const VECTORS = [
  // name, expected exit, why
  ["fresh", 0, "a recently published marker is a consumed verdict"],
  ["stale", 1, "PC-3(2): silence past the tolerated window RED-s policy, and therefore ci-required"],
  [
    "ran_but_never_published",
    1,
    "★★★ PC-3(3): the reconciler RAN and COMPLETED and published nothing. A heartbeat measured on the RUN would be green here.",
  ],
  ["not_bootstrapped", 0, "the one self-terminating tolerance: the consumer has never run"],
  ["marker_absent", 1, "an issue whose body lost the marker is not a consumed verdict"],
  ["fresh_with_red_findings", 0, "★ NARROW: a published sweep full of RED findings must NOT fail the reader"],
];

for (const [name, expected, why] of VECTORS) {
  test(`reader exit code — ${name} → ${expected} (${why})`, () => {
    const { code, out } = run(READER, [`--self-test-case=${name}`]);
    assert.equal(code, expected, `exit ${code}\n${out}`);
    assert.match(out, new RegExp(`SELF-TEST ${name}`));
  });
}

test("★ the reader FAILS, it does not warn — every failing vector exits NON-ZERO", () => {
  const failing = VECTORS.filter(([, expected]) => expected === 1);
  assert.ok(failing.length >= 3, "a suite that never exercises the failing direction proves nothing");
  for (const [name] of failing) {
    assert.notEqual(run(READER, [`--self-test-case=${name}`]).code, 0, name);
  }
});

test("an unknown self-test case is an ERROR, not a pass", () => {
  assert.equal(run(READER, ["--self-test-case=no-such-case"]).code, 2);
});

test("★ WITHOUT A TOKEN THE READER REFUSES — a check that cannot see must not report health", () => {
  const { code, out } = run(READER, [], { GITHUB_REPOSITORY: "MeteoriteLabs/AoA" });
  assert.equal(code, 1, out);
  assert.match(out, /REFUSING to report health while blind/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4.1 — CHAINED, NEVER ADJACENT, proven on the real reconciler process
// ─────────────────────────────────────────────────────────────────────────────

test("★★ §4.1 a reconciler whose EVALUATION throws exits non-zero and publishes NOTHING", () => {
  // A manifest with nothing watched makes `evaluateStreams` throw (anti-vacuity) AFTER the
  // client is built and BEFORE any write — which is exactly where a broken sweep dies. The
  // stream loop makes no API calls because there are no watched streams, so this is a real
  // end-to-end run of the process, not a stub.
  const real = JSON.parse(readFileSync(REAL_MANIFEST, "utf8"));
  for (const key of Object.keys(real.streams)) {
    real.streams[key] = { ...real.streams[key], watch: "not-watched", reason: "x", wouldTakeToWatch: "y" };
  }
  const dir = mkdtempSync(path.join(tmpdir(), "wvr-"));
  const file = path.join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify(real, null, 2), "utf8");

  const { code, out } = run(RECONCILER, ["--manifest", file], {
    GITHUB_TOKEN: "not-a-real-token",
    GITHUB_REPOSITORY: "MeteoriteLabs/AoA",
  });
  assert.equal(code, 1, out);
  assert.match(out, /zero WATCHED streams/);
  assert.match(out, /Nothing was published/);
  // The publish log lines must never appear: as two YAML steps without an explicit success
  // condition, a throwing evaluator would still have let the write run.
  assert.ok(!/verdict-reconcile: (published to|opened) #/.test(out), out);
});

test("★ the reconciler workflow is ONE step — evaluation and publish may not be split", () => {
  const wf = readFileSync(path.join(ROOT, ".github", "workflows", "verdict-reconcile.yml"), "utf8");
  const runSteps = wf.split(/\r?\n/).filter((l) => /^\s+run:\s/.test(l));
  assert.equal(runSteps.length, 1, `expected exactly one run: step, got ${runSteps.length}`);
  assert.match(runSteps[0], /reconcile-workflow-verdicts\.mjs/);
  assert.ok(!/continue-on-error/.test(wf), "a reconciler that cannot fail is not a consumer");
});

// ─────────────────────────────────────────────────────────────────────────────
// The wiring itself — a check nothing runs is not a check
// ─────────────────────────────────────────────────────────────────────────────

test("★ pr.yml's policy job RUNS the reader, with no self-test flag and no `|| true`", () => {
  const pr = readFileSync(path.join(ROOT, ".github", "workflows", "pr.yml"), "utf8");
  const lines = pr.split(/\r?\n/).filter((l) => !l.trim().startsWith("#"));
  const invocations = lines.filter((l) => l.includes("check-verdict-consumer-freshness.mjs"));
  assert.ok(invocations.length >= 1, "the terminating reader must be invoked — otherwise nothing terminates");
  for (const line of invocations) {
    if (line.includes("--test")) continue;
    assert.ok(!line.includes("--self-test-case"), `pr.yml must not pass --self-test-case: ${line.trim()}`);
    assert.ok(!line.includes("|| true"), `pr.yml must not swallow the reader's exit code: ${line.trim()}`);
    assert.ok(!line.includes("continue-on-error"), line.trim());
  }
  // It must live in `policy` — the only job branch protection's `ci-required` aggregator
  // requires that runs on EVERY non-draft PR with no `changes` gate.
  const policyIdx = pr.indexOf("\n  policy:");
  const readerIdx = pr.indexOf("check-verdict-consumer-freshness.mjs");
  const nextJobIdx = pr.indexOf("\n  brand-check:");
  assert.ok(policyIdx !== -1 && readerIdx > policyIdx && readerIdx < nextJobIdx, "the reader must sit inside the policy job");
});
