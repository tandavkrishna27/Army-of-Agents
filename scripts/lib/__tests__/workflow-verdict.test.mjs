// -----------------------------------------------------------------------------
// DEP-013 — the pure core, and the positive controls that prove it can fire.
//
// A guard that has never been made to fail is not reported as passing. Every decision in
// `scripts/lib/workflow-verdict.mjs` therefore gets a MUTANT here — and each mutant is a
// re-implementation of a SINGLE OR-ARM, not of the whole clause, because a clause-level
// mutant is killed by the first case that touches any arm and the survivor hides in the arms
// it never reached.
// -----------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_COMPLETED_CONCLUSIONS,
  SUCCESS_CONCLUSION,
  commitMatchesPaths,
  cronIntervalHours,
  describeWorkflow,
  evaluateCadenceStream,
  evaluateConsumerFreshness,
  evaluateCoverageStream,
  evaluateManifestCompleteness,
  evaluateStreams,
  isReportableRun,
  matchesPathFilter,
  parseMarker,
  renderIssueBody,
} from "../workflow-verdict.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WF = (name) => readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
const REPLAY = JSON.parse(readFileSync(path.join(ROOT, "scripts", "workflow-verdict-replay-d1.json"), "utf8"));
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, "scripts", "workflow-verdict-manifest.json"), "utf8"));

const hoursAgo = (h, from = "2026-09-04T12:00:00Z") => new Date(Date.parse(from) - h * 3_600_000).toISOString();
const NOW = "2026-09-04T12:00:00Z";

const completed = (conclusion, extra = {}) => ({
  status: "completed",
  conclusion,
  completedAt: hoursAgo(1),
  url: "https://example.invalid/run",
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.1 — SUCCESS-ONLY, never an enumeration of bad conclusions
// ─────────────────────────────────────────────────────────────────────────────

test("§5.1 every completed conclusion other than success is reportable — the full vocabulary", () => {
  for (const conclusion of ALL_COMPLETED_CONCLUSIONS) {
    const expected = conclusion !== SUCCESS_CONCLUSION;
    assert.equal(
      isReportableRun({ status: "completed", conclusion }),
      expected,
      `conclusion ${conclusion} should be ${expected ? "" : "NOT "}reportable`,
    );
  }
  // The five this repository has NEVER produced — measured 2026-09-04 across the last 300
  // runs, which show exactly success/cancelled/failure. These are the ones no future reader
  // would think to add to an enumeration, which is exactly why they are asserted.
  for (const never of ["timed_out", "neutral", "skipped", "stale", "startup_failure", "action_required"]) {
    assert.equal(isReportableRun({ status: "completed", conclusion: never }), true, never);
  }
  // A completed run with a NULL conclusion is reportable: the predicate may never decide that
  // something it does not recognise is fine.
  assert.equal(isReportableRun({ status: "completed", conclusion: null }), true);
  // In-progress is not a verdict.
  assert.equal(isReportableRun({ status: "in_progress", conclusion: null }), false);
  assert.equal(isReportableRun({ status: "queued", conclusion: null }), false);
});

test("★ MUTANT (§5.1): reverting the predicate to an ENUMERATION is killed by this suite", () => {
  // The exact shape of the design's own rejected first draft.
  const mutant = (run) =>
    run.status === "completed" && ["failure", "cancelled", "timed_out"].includes(run.conclusion);
  const survivors = ALL_COMPLETED_CONCLUSIONS.filter((c) => mutant({ status: "completed", conclusion: c }) !== isReportableRun({ status: "completed", conclusion: c }));
  assert.deepEqual(
    survivors.sort(),
    ["action_required", "neutral", "skipped", "stale", "startup_failure"].sort(),
    "the enumeration mutant must differ on exactly the five conclusions this repo has never produced",
  );
  assert.ok(survivors.length > 0, "an enumeration mutant that this suite cannot tell apart would be a survivor");
});

// ─────────────────────────────────────────────────────────────────────────────
// Path-filter matching
// ─────────────────────────────────────────────────────────────────────────────

test("paths: matching — ** crosses /, * does not, literals are literal", () => {
  assert.equal(matchesPathFilter("docker/d1/x.yml", ["docker/**"]), true);
  assert.equal(matchesPathFilter("docker/d1/deep/x.yml", ["docker/**"]), true);
  assert.equal(matchesPathFilter("dockerfile", ["docker/**"]), false);
  assert.equal(matchesPathFilter(".dockerignore", [".dockerignore"]), true);
  assert.equal(matchesPathFilter("a/.dockerignore", [".dockerignore"]), false);
  assert.equal(matchesPathFilter("scripts/lib/x.mjs", ["scripts/*.mjs"]), false, "* must not cross /");
  assert.equal(matchesPathFilter("scripts/x.mjs", ["scripts/*.mjs"]), true);
  // Regex metacharacters in a literal pattern must not be interpreted.
  assert.equal(matchesPathFilter("dockerXcompose.d1.yml", ["docker-compose.d1.yml"]), false);
  // Negation, last match wins (GitHub's own rule).
  assert.equal(matchesPathFilter("docs/x.md", ["docs/**", "!docs/x.md"]), false);
  assert.equal(matchesPathFilter("docs/y.md", ["docs/**", "!docs/x.md"]), true);
  // No filter means every file matches — an unfiltered lane owes a run for every commit.
  assert.equal(matchesPathFilter("anything", []), true);
  assert.equal(commitMatchesPaths({ files: ["a", "b"] }, ["b"]), true);
  assert.equal(commitMatchesPaths({ files: ["a"] }, ["b"]), false);
});

test("★ MUTANT: treating ** as * (not crossing /) stops matching d1-merge-train's real docker/** commits", () => {
  const real = REPLAY.commits.find((c) => c.sha.startsWith("c3d26657d"));
  const paths = describeWorkflow(WF("d1-merge-train.yml")).pushPaths;
  assert.equal(commitMatchesPaths(real, paths), true, "the recorded commit really does match the real filter");
  const mutantMatch = (file) => new RegExp(`^${"docker/[^/]*"}$`).test(file);
  assert.equal(real.files.some(mutantMatch), false, "the mutant would see no match and report a false incident");
});

// ─────────────────────────────────────────────────────────────────────────────
// Workflow-file reading (the declaration is READ, never re-declared)
// ─────────────────────────────────────────────────────────────────────────────

test("describeWorkflow reads the REAL workflow files' own triggers", () => {
  const d1 = describeWorkflow(WF("d1-merge-train.yml"));
  assert.equal(d1.hasPush, true);
  assert.deepEqual(d1.pushBranches, ["main", "docs/replatform-program"]);
  assert.ok(d1.pushPaths.includes("docker/**"), "the 18-entry filter is read from the file");
  assert.ok(d1.pushPaths.length >= 15);
  assert.equal(d1.hasSchedule, false);

  const weekly = describeWorkflow(WF("cross-platform-weekly.yml"));
  assert.equal(weekly.hasSchedule, true);
  assert.deepEqual(weekly.crons, ["0 6 * * 0"]);
  assert.equal(cronIntervalHours(weekly.crons), 168);

  const reconcile = describeWorkflow(WF("verdict-reconcile.yml"));
  assert.equal(reconcile.hasSchedule, true);
  assert.equal(cronIntervalHours(reconcile.crons), 6);
  assert.deepEqual(reconcile.pushBranches, ["main", "docs/replatform-program"]);
  assert.deepEqual(reconcile.pushPaths, [], "the reconciler must have NO paths filter — the marker is a heartbeat");

  assert.equal(cronIntervalHours(describeWorkflow(WF("catalog-audit.yml")).crons), 24);
  assert.throws(() => describeWorkflow("name: x\njobs: {}\n"), /on:/);
});

test("cronIntervalHours REFUSES what it cannot read rather than defaulting", () => {
  assert.throws(() => cronIntervalHours(["0 6 * *"]), /unreadable cron expression/);
  assert.throws(() => cronIntervalHours(["0 6 1 * 0"]), /ambiguous/);
  assert.throws(() => cronIntervalHours(["0 6 * JAN *"]), /unreadable cron field/);
  assert.throws(() => cronIntervalHours([]), /no cron expressions/);
  assert.equal(cronIntervalHours(["0 */6 * * *", "0 6 * * 0"]), 6, "the SHORTEST interval wins");
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.2 — the two modes, and the silent half that stops an incident nobody can close
// ─────────────────────────────────────────────────────────────────────────────

const coverageStream = { workflow: "d1-merge-train.yml", branch: "docs/replatform-program", watch: "coverage" };

test("§5.2 coverage — a paths-matching commit with no run is REPORTED", () => {
  const f = evaluateCoverageStream({
    stream: coverageStream,
    commits: [{ sha: "aaaaaaaaa1", files: ["docker/x/Dockerfile"] }],
    runs: [],
    paths: ["docker/**"],
  });
  assert.equal(f?.code, "uncovered_commit");
});

test("★★ §5.2 coverage — a QUIET branch reports NOTHING (the half that stops an incident nobody can close)", () => {
  const f = evaluateCoverageStream({
    stream: coverageStream,
    commits: [
      { sha: "bbbbbbbb1", files: ["docs/replatform/GO-BOOK.md"] },
      { sha: "bbbbbbbb2", files: ["server/src/x.ts"] },
    ],
    runs: [],
    paths: ["docker/**"],
  });
  assert.equal(f, null, "no matching commit means nothing was owed — reporting it would be unclosable");
});

test("§5.2 coverage — a branch that does not exist is silent", () => {
  assert.equal(evaluateCoverageStream({ stream: coverageStream, commits: null, runs: [], paths: ["docker/**"] }), null);
});

test("★★★ coverage — a workflow that is NOT ON THE BRANCH owes nothing (found by the live dry-run)", () => {
  // The first real sweep reported `d1-merge-train.yml@main uncovered_commit 185deeaba`. True
  // as stated — that commit touches `.dockerignore` and `docker/research/**`, both in the
  // lane's filter, and the lane has ZERO runs on main — but `d1-merge-train.yml` exists only
  // on `docs/replatform-program`, so no run was ever owed. The only repair for that finding
  // would be landing the workflow on main: an incident nobody can close.
  const commits = [{ sha: "185deeaba", files: [".dockerignore", "docker/research/Dockerfile"] }];
  const withoutPresence = evaluateCoverageStream({ stream: coverageStream, commits, runs: [], paths: ["docker/**", ".dockerignore"] });
  assert.equal(withoutPresence?.code, "uncovered_commit", "…which is what the evaluator says when the file IS there");
  const absent = evaluateCoverageStream({
    stream: coverageStream,
    commits,
    runs: [],
    paths: ["docker/**", ".dockerignore"],
    workflowPresentOnBranch: false,
  });
  assert.equal(absent, null, "a workflow that cannot run on this branch owes it nothing");
});

test("★ MUTANT (presence): dropping the presence arm restores the false incident", () => {
  const mutant = ({ commits, runs, paths }) => evaluateCoverageStream({ stream: coverageStream, commits, runs, paths });
  const input = { commits: [{ sha: "185deeaba", files: [".dockerignore"] }], runs: [], paths: [".dockerignore"] };
  assert.equal(mutant(input)?.code, "uncovered_commit", "the mutant reports…");
  assert.equal(
    evaluateCoverageStream({ ...input, stream: coverageStream, workflowPresentOnBranch: false }),
    null,
    "…and the real evaluator is silent. This case is the difference.",
  );
});

test("§5.2 coverage — an in-progress run is not yet a verdict", () => {
  const f = evaluateCoverageStream({
    stream: coverageStream,
    commits: [{ sha: "cccccccc1", files: ["docker/x"] }],
    runs: [{ headSha: "cccccccc1", status: "in_progress", conclusion: null }],
    paths: ["docker/**"],
  });
  assert.equal(f, null);
});

test("★★ coverage — a run at a DESCENDANT covers the matching commit (the real 50380b6f7 shape)", () => {
  // Recorded reality: 50380b6f7 produced a green run while touching only two docs files.
  // GitHub matches paths: against every commit in a push and starts ONE run at the tip.
  const tip = REPLAY.commits.find((c) => c.sha.startsWith("50380b6f7"));
  const paths = describeWorkflow(WF("d1-merge-train.yml")).pushPaths;
  assert.equal(commitMatchesPaths(tip, paths), false, "the recorded tip really does NOT match the filter");

  const f = evaluateCoverageStream({
    stream: coverageStream,
    commits: [
      { sha: tip.sha, files: tip.files },
      { sha: "olderolder", files: ["docker/worker/Dockerfile"] },
    ],
    runs: [{ headSha: tip.sha, status: "completed", conclusion: "success" }],
    paths,
  });
  assert.equal(f, null, "a rule requiring a run ON the matching commit would report a false incident here");
});

test("★ MUTANT (coverage): requiring the run to be ON the matching commit reports a FALSE incident", () => {
  const tip = REPLAY.commits.find((c) => c.sha.startsWith("50380b6f7"));
  const commits = [
    { sha: tip.sha, files: tip.files },
    { sha: "olderolder", files: ["docker/worker/Dockerfile"] },
  ];
  const runs = [{ headSha: tip.sha, status: "completed", conclusion: "success" }];
  const target = commits.find((c) => commitMatchesPaths(c, ["docker/**"]));
  const mutantForSha = runs.filter((r) => r.headSha === target.sha);
  assert.equal(mutantForSha.length, 0, "the mutant sees no covering run…");
  assert.equal(
    evaluateCoverageStream({ stream: coverageStream, commits, runs, paths: ["docker/**"] }),
    null,
    "…while the real evaluator is correctly silent",
  );
});

const cadenceStream = { workflow: "cross-platform-weekly.yml", branch: "main", watch: "cadence", toleranceMultiplier: 2 };

test("§5.2 cadence — a non-success conclusion is reported regardless of age", () => {
  const f = evaluateCadenceStream({
    stream: cadenceStream,
    runs: [completed("cancelled", { completedAt: hoursAgo(2) })],
    intervalHours: 168,
    now: NOW,
  });
  assert.equal(f?.code, "not_success");
  assert.match(f.detail, /cancelled/);
});

test("§5.2 cadence — past interval × tolerance is reported; inside it is not", () => {
  const stale = evaluateCadenceStream({
    stream: cadenceStream,
    runs: [completed("success", { completedAt: hoursAgo(400) })],
    intervalHours: 168,
    now: NOW,
  });
  assert.equal(stale?.code, "cadence_stale");
  const fresh = evaluateCadenceStream({
    stream: cadenceStream,
    runs: [completed("success", { completedAt: hoursAgo(300) })],
    intervalHours: 168,
    now: NOW,
  });
  assert.equal(fresh, null, "168h × 2 = 336h of budget");
  const never = evaluateCadenceStream({ stream: cadenceStream, runs: [], intervalHours: 168, now: NOW });
  assert.equal(never?.code, "no_completed_run");
  const noTolerance = evaluateCadenceStream({
    stream: { ...cadenceStream, toleranceMultiplier: undefined },
    runs: [completed("success")],
    intervalHours: 168,
    now: NOW,
  });
  assert.equal(noTolerance?.code, "manifest_tolerance_unreadable", "an unreadable bound must not read as healthy");
});

test("★★ §5.2 the modes are NOT interchangeable — coverage cannot see a dead schedule", () => {
  // cross-platform-weekly's real shape: three consecutive cancelled scheduled runs on main,
  // and no commits owing anything (a schedule owes a run to the clock, not to a commit).
  const runs = [
    completed("cancelled", { headSha: "e097d2f93", completedAt: "2026-08-30T06:05:10Z" }),
    completed("cancelled", { headSha: "e097d2f93", completedAt: "2026-08-23T06:05:44Z" }),
    completed("cancelled", { headSha: "e097d2f93", completedAt: "2026-08-16T06:05:14Z" }),
  ];
  const cadence = evaluateCadenceStream({ stream: cadenceStream, runs, intervalHours: 168, now: NOW });
  assert.equal(cadence?.code, "not_success", "cadence SEES the three blank weeks");

  const coverage = evaluateCoverageStream({
    stream: { ...coverageStream, workflow: "cross-platform-weekly.yml" },
    commits: [{ sha: "e097d2f93", files: ["server/src/x.ts"] }],
    runs: runs.map((r) => ({ ...r, headSha: "e097d2f93" })),
    paths: [],
  });
  assert.equal(coverage?.code, "not_success");
  // …but with NO new commit on the branch, coverage has nothing to ask about at all, while
  // cadence still reports. That is the asymmetry that makes both modes necessary.
  const coverageQuiet = evaluateCoverageStream({
    stream: { ...coverageStream, workflow: "cross-platform-weekly.yml" },
    commits: [],
    runs,
    paths: [],
  });
  assert.equal(coverageQuiet, null, "coverage is blind to a schedule that stopped firing");
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.4 — the unit is a (workflow, branch) STREAM
// ─────────────────────────────────────────────────────────────────────────────

test("★ §5.4 a green on one branch does NOT mask a red on the other", () => {
  const manifest = {
    consumer: { issueTitle: "t", issueLabel: "l", reconcilerWorkflow: "verdict-reconcile.yml", toleratedSilenceHours: 72, toleratedSilenceReason: "r" },
    streams: {
      "d1-merge-train.yml@main": { workflow: "d1-merge-train.yml", branch: "main", watch: "coverage" },
      "d1-merge-train.yml@docs/replatform-program": {
        workflow: "d1-merge-train.yml",
        branch: "docs/replatform-program",
        watch: "coverage",
      },
    },
  };
  const workflows = { "d1-merge-train.yml": describeWorkflow(WF("d1-merge-train.yml")) };
  const findings = evaluateStreams({
    manifest,
    workflows,
    now: NOW,
    data: {
      "d1-merge-train.yml@main": {
        commits: [{ sha: "greengreen", files: ["docker/a"] }],
        runs: [{ headSha: "greengreen", status: "completed", conclusion: "success" }],
      },
      "d1-merge-train.yml@docs/replatform-program": {
        commits: [{ sha: "redredred1", files: ["docker/a"] }],
        runs: [{ headSha: "redredred1", status: "completed", conclusion: "failure", url: "u" }],
      },
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].stream, "d1-merge-train.yml@docs/replatform-program");
  assert.equal(findings[0].code, "not_success");
});

test("★ ANTI-VACUITY: a sweep with zero WATCHED streams THROWS", () => {
  assert.throws(
    () =>
      evaluateStreams({
        manifest: { streams: { "a.yml@*": { workflow: "a.yml", branch: null, watch: "not-watched", reason: "r", wouldTakeToWatch: "w" } } },
        workflows: {},
        data: {},
        now: NOW,
      }),
    /zero WATCHED streams/,
  );
});

test("a declared workflow with no file on disk is REPORTED, not skipped", () => {
  const findings = evaluateStreams({
    manifest: { streams: { "gone.yml@main": { workflow: "gone.yml", branch: "main", watch: "coverage" } } },
    workflows: {},
    data: {},
    now: NOW,
  });
  assert.equal(findings[0].code, "workflow_file_missing");
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-2 — the REPLAY against recorded reality
// ─────────────────────────────────────────────────────────────────────────────

test("★★ PC-2 REPLAY: the recorded 08-25 → 09-03 history reports from 08-29 and stops at ee74f9c8c", () => {
  const paths = describeWorkflow(WF("d1-merge-train.yml")).pushPaths;
  const byNewest = [...REPLAY.runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const commitBySha = new Map(REPLAY.commits.map((c) => [c.sha, c]));

  /** What the consumer would have reported had it existed at instant `at`. */
  const replayAt = (at) => {
    const runs = byNewest.filter((r) => Date.parse(r.createdAt) <= Date.parse(at));
    const commits = runs.map((r) => {
      const c = commitBySha.get(r.headSha);
      return { sha: r.headSha, files: c ? c.files : [] };
    });
    return evaluateCoverageStream({ stream: coverageStream, commits, runs, paths });
  };

  assert.equal(replayAt("2026-08-25T12:00:00Z"), null, "08-25 was green — silent");
  const at0829 = replayAt("2026-08-29T23:00:00Z");
  assert.equal(at0829?.code, "not_success", "08-29: the first red of the window is REPORTED");
  assert.match(at0829.detail, /c3d26657d/);
  assert.equal(replayAt("2026-08-30T23:00:00Z")?.code, "not_success", "08-30: still reporting");
  assert.equal(replayAt("2026-09-01T00:00:00Z")?.code, "not_success", "08-31: still reporting");
  assert.equal(replayAt("2026-09-03T23:00:00Z"), null, "ee74f9c8c fixed it — the report stops");

  // The five recorded days it would have been shouting: 08-29 through 09-03.
  const reportingDays = ["2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"].filter(
    (d) => replayAt(`${d}T23:00:00Z`) !== null,
  );
  assert.equal(reportingDays.length, 5, "the whole five-day unread window is covered");
});

test("PC-2 the replay fixture is RECORDED, not invented", () => {
  assert.equal(REPLAY.workflow, "d1-merge-train.yml");
  assert.equal(REPLAY.branch, "docs/replatform-program");
  assert.equal(REPLAY.runs.length, 5);
  for (const r of REPLAY.runs) {
    assert.match(r.headSha, /^[0-9a-f]{40}$/, "a real 40-char sha, not a placeholder");
    assert.match(r.url, /^https:\/\/github\.com\/MeteoriteLabs\/AoA\/actions\/runs\/\d+$/);
    assert.equal(r.status, "completed");
  }
  assert.deepEqual(
    REPLAY.runs.map((r) => r.conclusion),
    ["success", "failure", "failure", "failure", "success"],
    "the recorded verdicts are the ones the design's §1 table names",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 clause 3 — manifest completeness
// ─────────────────────────────────────────────────────────────────────────────

const goodConsumer = {
  issueTitle: "t",
  issueLabel: "l",
  reconcilerWorkflow: "verdict-reconcile.yml",
  toleratedSilenceHours: 72,
  toleratedSilenceReason: "because",
};
const pushInfo = { hasPush: true, hasSchedule: false, pushBranches: ["main"], pushPaths: [], crons: [], triggers: {} };
const cronInfo = { hasPush: false, hasSchedule: true, pushBranches: [], pushPaths: [], crons: ["0 6 * * *"], triggers: {} };

const codes = (input) => evaluateManifestCompleteness(input).violations.map((v) => v.code);

test("manifest completeness — a workflow file with no entry FAILS", () => {
  assert.ok(
    codes({
      workflowFiles: ["a.yml", "b.yml"],
      workflowInfo: { "a.yml": pushInfo, "b.yml": pushInfo },
      manifest: { consumer: goodConsumer, streams: { "a.yml@main": { workflow: "a.yml", branch: "main", watch: "coverage" } } },
    }).includes("workflow_undeclared"),
  );
});

test("★ manifest completeness — a push workflow with an entry for only ONE of its branches FAILS", () => {
  const twoBranch = { ...pushInfo, pushBranches: ["main", "docs/replatform-program"] };
  const got = codes({
    workflowFiles: ["a.yml"],
    workflowInfo: { "a.yml": twoBranch },
    manifest: { consumer: goodConsumer, streams: { "a.yml@main": { workflow: "a.yml", branch: "main", watch: "coverage" } } },
  });
  assert.ok(got.includes("branch_undeclared"), got.join(","));
});

test("manifest completeness — a reason is not optional, and neither is what would have to change", () => {
  const base = (entry) => ({
    workflowFiles: ["a.yml"],
    workflowInfo: { "a.yml": pushInfo },
    manifest: { consumer: goodConsumer, streams: { "a.yml@main": { workflow: "a.yml", branch: "main", ...entry } }, },
  });
  assert.ok(codes(base({ watch: "not-watched", reason: "", wouldTakeToWatch: "x" })).includes("reason_missing"));
  assert.ok(codes(base({ watch: "not-watched", reason: "x" })).includes("reason_missing"), "wouldTakeToWatch is required too");
  // A well-formed not-watched entry still fails on ANTI-VACUITY, because nothing is watched.
  assert.deepEqual(codes(base({ watch: "not-watched", reason: "x", wouldTakeToWatch: "y" })), ["no_watched_streams"]);
});

test("★ ANTI-VACUITY at the manifest layer: zero workflows, zero entries, zero watched all FAIL", () => {
  assert.ok(codes({ workflowFiles: [], workflowInfo: {}, manifest: { consumer: goodConsumer, streams: {} } }).includes("no_workflows_discovered"));
  assert.ok(codes({ workflowFiles: ["a.yml"], workflowInfo: { "a.yml": pushInfo }, manifest: { consumer: goodConsumer, streams: {} } }).includes("no_manifest_entries"));
});

test("manifest completeness — mode must match the trigger, and a cadence bound must be readable", () => {
  const got = codes({
    workflowFiles: ["a.yml", "b.yml"],
    workflowInfo: { "a.yml": pushInfo, "b.yml": cronInfo },
    manifest: {
      consumer: goodConsumer,
      streams: {
        "a.yml@main": { workflow: "a.yml", branch: "main", watch: "cadence", toleranceMultiplier: 2 },
        "b.yml@main": { workflow: "b.yml", branch: "main", watch: "coverage" },
      },
    },
  });
  assert.equal(got.filter((c) => c === "mode_mismatch").length, 2);

  const noTolerance = codes({
    workflowFiles: ["b.yml"],
    workflowInfo: { "b.yml": cronInfo },
    manifest: { consumer: goodConsumer, streams: { "b.yml@main": { workflow: "b.yml", branch: "main", watch: "cadence" } } },
  });
  assert.ok(noTolerance.includes("stream_shape"));
});

test("manifest completeness — the consumer block must be complete, and its bound must carry a REASON", () => {
  const withConsumer = (consumer) =>
    codes({
      workflowFiles: ["a.yml"],
      workflowInfo: { "a.yml": pushInfo },
      manifest: { consumer, streams: { "a.yml@main": { workflow: "a.yml", branch: "main", watch: "coverage" } } },
    });
  assert.ok(withConsumer(undefined).includes("consumer_missing"));
  assert.ok(withConsumer({ ...goodConsumer, toleratedSilenceReason: "" }).includes("consumer_missing"), "a bound is a committed number, not a habit");
  assert.ok(withConsumer({ ...goodConsumer, toleratedSilenceHours: 0 }).includes("consumer_missing"));
  assert.deepEqual(withConsumer(goodConsumer), []);
});

test("manifest completeness — the key must equal <workflow>@<branch|*>", () => {
  const got = codes({
    workflowFiles: ["a.yml"],
    workflowInfo: { "a.yml": pushInfo },
    manifest: { consumer: goodConsumer, streams: { "wrong-key": { workflow: "a.yml", branch: "main", watch: "coverage" } } },
  });
  assert.ok(got.includes("stream_key_mismatch"));
});

test("THE REAL MANIFEST passes its own completeness contract", () => {
  const wfDir = path.join(ROOT, ".github", "workflows");
  const files = readdirSync(wfDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
  const workflowInfo = {};
  for (const f of files) workflowInfo[f] = describeWorkflow(WF(f));
  assert.deepEqual(evaluateManifestCompleteness({ workflowFiles: files, workflowInfo, manifest: MANIFEST }).violations, []);
  // and it really is watching something
  const watched = Object.values(MANIFEST.streams).filter((s) => s.watch !== "not-watched");
  assert.ok(watched.length >= 8, `only ${watched.length} watched streams`);
  assert.ok(watched.some((s) => s.workflow === "cross-platform-weekly.yml"), "the free positive control must be watched");
  assert.ok(
    watched.some((s) => s.workflow === "d1-merge-train.yml" && s.branch === "docs/replatform-program"),
    "the chartered stream must be watched",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.3 — the published artifact and the heartbeat
// ─────────────────────────────────────────────────────────────────────────────

test("★ GREEN IS SILENT BUT STILL PUBLISHES — quiet-and-healthy stays distinguishable from dead", () => {
  const marker = { lastReconciledAt: NOW, runUrl: "u", runId: "1", findingCount: 0 };
  const body = renderIssueBody({ findings: [], marker, streamsWatched: 11 });
  assert.match(body, /No findings/);
  const parsed = parseMarker(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.marker.lastReconciledAt, NOW);
});

test("the published body names every finding, its code and its run", () => {
  const body = renderIssueBody({
    findings: [{ stream: "cross-platform-weekly.yml@main", code: "not_success", detail: "concluded `cancelled`", runUrl: "https://x/1" }],
    marker: { lastReconciledAt: NOW, findingCount: 1 },
    streamsWatched: 11,
  });
  assert.match(body, /cross-platform-weekly\.yml@main/);
  assert.match(body, /not_success/);
  assert.match(body, /https:\/\/x\/1/);
});

test("parseMarker refuses every unreadable marker rather than defaulting", () => {
  assert.equal(parseMarker("no marker here").code, "marker_absent");
  assert.equal(parseMarker("<!-- verdict-consumer:v1 {\"a\":1}").code, "marker_unterminated");
  assert.equal(parseMarker("<!-- verdict-consumer:v1 {nope} -->").code, "marker_unparseable");
  assert.equal(parseMarker('<!-- verdict-consumer:v1 {"lastReconciledAt":"not a date"} -->').code, "marker_no_timestamp");
  assert.equal(parseMarker('<!-- verdict-consumer:v1 {"x":1} -->').code, "marker_no_timestamp");
});

const freshness = (over) =>
  evaluateConsumerFreshness({ reconcilerCompletedRuns: 0, now: NOW, toleratedSilenceHours: 72, ...over });
const issueAged = (h) => ({
  body: renderIssueBody({ findings: [], marker: { lastReconciledAt: hoursAgo(h), findingCount: 0 }, streamsWatched: 11 }),
});

test("★★★ §5.3 THE HEARTBEAT MEASURES THE PUBLISH — a reconciler that RAN, COMPLETED and never published FAILS", () => {
  // The control that would have caught this design's own first draft. The run record is
  // recent and plentiful; the marker does not exist.
  const v = freshness({ issue: null, reconcilerCompletedRuns: 42 });
  assert.equal(v.ok, false);
  assert.equal(v.code, "ran_but_never_published");
});

test("★ MUTANT (§5.3): a heartbeat that measures the RUN instead of the publish stays green while nothing was read", () => {
  const mutant = ({ reconcilerCompletedRuns }) => ({ ok: reconcilerCompletedRuns > 0 });
  const input = { issue: null, reconcilerCompletedRuns: 42 };
  assert.equal(mutant(input).ok, true, "the mutant passes…");
  assert.equal(freshness(input).ok, false, "…and the real reader fails. This case is the difference.");
});

test("§5.3 stale → fail; fresh → pass; the boundary is the declared number", () => {
  assert.equal(freshness({ issue: issueAged(100) }).code, "stale");
  assert.equal(freshness({ issue: issueAged(1) }).code, "fresh");
  assert.equal(freshness({ issue: issueAged(71.9) }).ok, true);
  assert.equal(freshness({ issue: issueAged(72.1) }).ok, false);
});

test("★ the reader is NARROW — a published sweep full of RED findings is still fresh", () => {
  const body = renderIssueBody({
    findings: [
      { stream: "cross-platform-weekly.yml@main", code: "not_success", detail: "cancelled" },
      { stream: "d1-merge-train.yml@docs/replatform-program", code: "not_success", detail: "failure" },
    ],
    marker: { lastReconciledAt: hoursAgo(2), findingCount: 2 },
    streamsWatched: 11,
  });
  const v = freshness({ issue: { body } });
  assert.equal(v.ok, true, "a red watched lane must never fail the reader — that would block the branch");
});

test("★ the bootstrap tolerance is EXACTLY ONE CONDITION and is self-terminating", () => {
  assert.equal(freshness({ issue: null, reconcilerCompletedRuns: 0 }).ok, true, "never run → tolerated");
  assert.equal(freshness({ issue: null, reconcilerCompletedRuns: 1 }).ok, false, "one run removes the tolerance for good");
  // It cannot mask anything else: with the issue present, every other failure still fails.
  assert.equal(freshness({ issue: { body: "someone wiped it" }, reconcilerCompletedRuns: 0 }).code, "marker_absent");
  assert.equal(freshness({ issue: issueAged(999), reconcilerCompletedRuns: 0 }).code, "stale");
});

test("an unreadable tolerance is a FAILURE, never a pass", () => {
  assert.equal(evaluateConsumerFreshness({ issue: issueAged(1), reconcilerCompletedRuns: 1, now: NOW, toleratedSilenceHours: undefined }).code, "tolerance_unreadable");
  assert.equal(evaluateConsumerFreshness({ issue: issueAged(1), reconcilerCompletedRuns: 1, now: NOW, toleratedSilenceHours: 0 }).ok, false);
});
