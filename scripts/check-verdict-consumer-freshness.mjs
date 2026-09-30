#!/usr/bin/env node
// -----------------------------------------------------------------------------
// DEP-013 Slice C — THE TERMINATING READER. The only thing in this ticket that BLOCKS.
//
//   node scripts/check-verdict-consumer-freshness.mjs
//
// Runs inside `pr.yml`'s `policy` job — the ONE check branch protection requires, and the
// one that runs on every non-draft PR by construction.
//
// ★★ IT GATES ON THE VERDICT HAVING BEEN READ, NEVER ON THE VERDICT ITSELF. A red
// `d1-merge-train` does NOT fail this check and must not: making my PR red because somebody
// else's merge broke a lane is "blocking the branch" one level down, and during the
// 2026-08-29 → 08-31 window it would have reddened every unrelated PR in the repo. A SILENT
// consumer — no published reconciliation within the tolerated window — is what fails.
//
// ★★★ IT MEASURES THE PUBLISH, NOT THE RUN (§5.3). The obvious phrasing — "fail when the
// reconciler has not COMPLETED recently" — is wrong and reproduces this design's own bug. A
// reconciler that starts and dies (bad token, rate limit, throwing evaluator, API outage)
// still records a recent COMPLETED run. `completed` is not `succeeded`, and `succeeded` is
// not `consumed`. Under that phrasing this check would stay green while nothing was read.
//
// ★ IT FAILS THE JOB, IT DOES NOT PRINT A WARNING. A step that echoes and exits 0 is the
// 2026-09-03 incident verbatim: a verdict computed, and the next thing running anyway. The
// exit code is the contract; `scripts/check-verdict-consumer-freshness.test.mjs` asserts on
// the exit code and not on stdout.
//
// ★ THE BOOTSTRAP TOLERANCE IS SELF-TERMINATING AND IS NOT A DIAL. The issue cannot exist
// before the reconciler has ever run, and a blocking reader wired ahead of its own artifact
// is a gate nobody can pass — a shape this programme has already had to delete once. So one
// condition, and exactly one, is tolerated: the reconciler has NEVER produced a completed
// run. The run count is consulted only to REFUSE that excuse, so it can turn a pass into a
// fail and never a fail into a pass, and the tolerance disappears permanently the first time
// the consumer runs — with no human flip to forget.
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateConsumerFreshness, renderIssueBody } from "./lib/workflow-verdict.mjs";
import { countCompletedRuns, createClient, findLabelledIssue, resolveRepo } from "./lib/github-rest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "scripts", "workflow-verdict-manifest.json");

/**
 * ★ THE SELF-TEST VECTORS, and why they live in the CLI rather than only in the unit suite.
 *
 * The clause being bought is *"the reader FAILS, it does not warn"* — an assertion about this
 * process's EXIT CODE, which a unit test importing the pure function cannot make. So
 * `scripts/check-verdict-consumer-freshness.test.mjs` SPAWNS this file once per vector and
 * asserts the real exit status.
 *
 * This flag cannot be used to fake a pass of the real check: the real check is the no-flag
 * invocation, it always performs the live query, and the unit suite additionally asserts that
 * `pr.yml`'s invocation carries no flag at all.
 */
const SELF_TEST_CASES = {
  // The §5.3 control — the one that would have caught this design's own first draft.
  ran_but_never_published: {
    issue: null,
    reconcilerCompletedRuns: 7,
    toleratedSilenceHours: 72,
    expectExit: 1,
  },
  not_bootstrapped: { issue: null, reconcilerCompletedRuns: 0, toleratedSilenceHours: 72, expectExit: 0 },
  stale: { markerAgeHours: 100, reconcilerCompletedRuns: 40, toleratedSilenceHours: 72, expectExit: 1 },
  fresh: { markerAgeHours: 1, reconcilerCompletedRuns: 40, toleratedSilenceHours: 72, expectExit: 0 },
  // ★ NARROW: the published sweep is FULL of red findings and the reader still passes.
  fresh_with_red_findings: {
    markerAgeHours: 1,
    findings: [
      { stream: "cross-platform-weekly.yml@main", code: "not_success", detail: "latest completed run concluded `cancelled`" },
      { stream: "d1-merge-train.yml@docs/replatform-program", code: "not_success", detail: "concluded `failure`" },
    ],
    reconcilerCompletedRuns: 40,
    toleratedSilenceHours: 72,
    expectExit: 0,
  },
  marker_absent: { rawBody: "someone replaced the body", reconcilerCompletedRuns: 40, toleratedSilenceHours: 72, expectExit: 1 },
};

function buildSelfTestIssue(spec) {
  if (spec.issue === null && spec.rawBody === undefined) return null;
  if (spec.rawBody !== undefined) return { number: 1, body: spec.rawBody };
  const at = new Date(Date.now() - spec.markerAgeHours * 3_600_000).toISOString();
  const findings = spec.findings ?? [];
  return {
    number: 1,
    body: renderIssueBody({
      findings,
      marker: { lastReconciledAt: at, runUrl: null, runId: null, findingCount: findings.length },
      streamsWatched: 11,
    }),
  };
}

function runSelfTest(name) {
  const spec = SELF_TEST_CASES[name];
  if (!spec) {
    console.error(`verdict-consumer-freshness: unknown --self-test-case ${JSON.stringify(name)}`);
    process.exit(2);
  }
  const verdict = evaluateConsumerFreshness({
    issue: buildSelfTestIssue(spec),
    reconcilerCompletedRuns: spec.reconcilerCompletedRuns,
    now: new Date().toISOString(),
    toleratedSilenceHours: spec.toleratedSilenceHours,
  });
  console.log(`verdict-consumer-freshness: SELF-TEST ${name} → ok=${verdict.ok} code=${verdict.code}`);
  console.log(`  ${verdict.detail}`);
  process.exit(verdict.ok ? 0 : 1);
}

const selfTestArg = process.argv.find((a) => a.startsWith("--self-test-case="));
if (selfTestArg) runSelfTest(selfTestArg.slice("--self-test-case=".length));

const REMEDY = {
  ran_but_never_published:
    "The reconciler RAN and published NOTHING. Read `verdict-reconcile.yml`'s most recent run:\n" +
    "  gh run list --workflow=verdict-reconcile.yml --limit 5\n" +
    "This is the failure the check exists for — a run record is ADJACENT to consumption; the\n" +
    "published artifact is CHAINED to it.",
  stale:
    "The consumer has not published within its tolerated silence. Either the schedule stopped\n" +
    "firing or the reconciler is failing before its publish. Re-run it:\n" +
    "  gh workflow run verdict-reconcile.yml\n" +
    "and read that run — the sweep it prints IS the verdict nobody was reading.",
  marker_absent: "The tracking issue exists but carries no marker — something overwrote the body the reconciler owns.",
  marker_unterminated: "The tracking issue's marker comment is truncated — re-run the reconciler to rewrite it.",
  marker_unparseable: "The tracking issue's marker is not readable JSON — re-run the reconciler to rewrite it.",
  marker_no_timestamp: "The marker has no readable `lastReconciledAt` — re-run the reconciler to rewrite it.",
  tolerance_unreadable: "scripts/workflow-verdict-manifest.json declares no usable `consumer.toleratedSilenceHours`.",
};

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const consumer = manifest.consumer ?? {};

  // No soft path. Running this without a token would be a check that cannot see, and a check
  // that cannot see must not report health — that is the whole subject of this ticket.
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";
  if (!token) {
    console.error("verdict-consumer-freshness: no GITHUB_TOKEN/GH_TOKEN — REFUSING to report health while blind.");
    process.exit(1);
  }
  const { owner, repo, slug } = resolveRepo();
  const request = createClient({ token });

  const issue = await findLabelledIssue(request, { owner, repo, label: consumer.issueLabel });
  const reconcilerCompletedRuns = issue
    ? 0 // not consulted when the artifact exists — see the header
    : await countCompletedRuns(request, { owner, repo, workflowFile: consumer.reconcilerWorkflow });

  const verdict = evaluateConsumerFreshness({
    issue,
    reconcilerCompletedRuns,
    now: new Date().toISOString(),
    toleratedSilenceHours: consumer.toleratedSilenceHours,
  });

  const where = issue ? `#${issue.number}` : "no published issue";
  if (verdict.ok) {
    console.log(`verdict-consumer-freshness: OK (${verdict.code}) — ${slug} ${where}: ${verdict.detail}`);
    if (verdict.code === "not_bootstrapped") {
      console.log(
        "\n  NOTE: this is the ONE tolerated condition, and it removes itself. The first completed\n" +
          `  run of ${consumer.reconcilerWorkflow} makes the absence of a published issue a FAILURE\n` +
          "  from that moment on, with no manifest edit and nobody to remember it.",
      );
    }
    return;
  }

  console.error(`verdict-consumer-freshness: FAILED (${verdict.code}) — ${slug} ${where}`);
  console.error(`  ${verdict.detail}`);
  console.error("");
  console.error(REMEDY[verdict.code] ?? "See docs/replatform/epics/E6-deployment-test-harness/tickets/DEP-013-design.md.");
  console.error("");
  console.error(
    "This check does NOT fail because a watched lane is red. It fails because the verdict was\n" +
      "not READ. A red lane updates the tracking issue and blocks nothing.",
  );
  process.exit(1);
}

main().catch((error) => {
  console.error(`verdict-consumer-freshness: ERROR — ${error instanceof Error ? error.stack : String(error)}`);
  console.error("\nA reader that cannot reach the API reports FAILURE, never health.");
  process.exit(1);
});
