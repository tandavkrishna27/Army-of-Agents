#!/usr/bin/env node
// -----------------------------------------------------------------------------
// DEP-013 Slice B — THE CONSUMER. It reads verdicts nobody reads and publishes what it read.
//
//   node scripts/reconcile-workflow-verdicts.mjs            # evaluate, then publish
//   node scripts/reconcile-workflow-verdicts.mjs --dry-run  # evaluate, print, publish NOTHING
//
// ★★ CHAINED, NEVER ADJACENT (§4.1). Evaluation and publication are ONE PROCESS, and the
// publish is the LAST thing it does. That is not a stylistic preference — it is the whole
// difference between this and the 2026-09-03 incident where a validation ran, FAILED, and the
// `git add` beside it ran anyway because nothing made the next step depend on the verdict. As
// two YAML steps without an explicit success condition, a throwing evaluator would still let
// an empty or stale issue be posted, and the consumer would read as healthy while consuming
// nothing. In a single process that exits non-zero on a throw, that cannot happen.
//
// ★★★ THE PUBLISH IS THE HEARTBEAT (§5.3). The last write carries a machine-readable
// `last-reconciled` marker. `scripts/check-verdict-consumer-freshness.mjs` reads THAT and
// never this workflow's run list — because a reconciler that starts and dies still records a
// recent COMPLETED run, and a reader that trusted the run list would stay green while nothing
// was read at all.
//
// IT PUBLISHES EVEN WHEN EVERYTHING IS GREEN. A reporter that goes quiet when healthy is
// indistinguishable from a dead one.
//
// SCOPE: it REPORTS. It does not fix a lane, does not fail on a red watched lane, and does
// not block a merge. Conflating "report it" with "fix it" is how a reporting ticket becomes
// unlandable (§8).
// -----------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeWorkflow,
  evaluateStreams,
  manifestStreams,
  matchesPathFilter,
  renderIssueBody,
  streamKey,
} from "./lib/workflow-verdict.mjs";
import {
  countCompletedRuns,
  createClient,
  ensureLabel,
  findLabelledIssue,
  getCommitFiles,
  listBranchCommits,
  listStreamRuns,
  requireEnv,
  resolveRepo,
  workflowFileExistsOnBranch,
} from "./lib/github-rest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
/** `--manifest <path>` exists so the §4.1 CHAINED-NEVER-ADJACENT clause can be proven by a
 *  real subprocess: point this at a manifest whose evaluation THROWS and assert that the
 *  process exits non-zero having published nothing. It changes no behaviour of the default
 *  invocation, which the workflow uses with no arguments. */
const manifestFlag = process.argv.indexOf("--manifest");
const MANIFEST =
  manifestFlag !== -1 && process.argv[manifestFlag + 1]
    ? path.resolve(process.argv[manifestFlag + 1])
    : path.join(ROOT, "scripts", "workflow-verdict-manifest.json");

/** How far back a coverage sweep will walk a branch looking for a commit that matches the
 *  lane's `paths:` filter. Bounded because each commit costs one API call. Exhausting the
 *  window is reported in the LOG, never as a finding: "I did not look far enough" is not the
 *  same claim as "a run is owed", and inventing the second from the first is how a reporter
 *  starts crying wolf. */
const COVERAGE_WINDOW = 40;

const DRY_RUN = process.argv.includes("--dry-run");

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

function loadWorkflowInfo() {
  const info = {};
  for (const file of readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
    info[file] = describeWorkflow(readFileSync(path.join(WORKFLOW_DIR, file), "utf8"));
  }
  return info;
}

/** Fetch exactly what the evaluator needs for one stream. */
async function collectStreamData(request, { owner, repo }, stream, info, log) {
  const runs = await listStreamRuns(request, {
    owner,
    repo,
    workflowFile: stream.workflow,
    branch: stream.branch ?? undefined,
  });
  if (stream.watch !== "coverage") return { runs };

  // A workflow that is not ON this branch cannot run there. Asked FIRST, because everything
  // after it would otherwise manufacture an incident nobody can close.
  const present = await workflowFileExistsOnBranch(request, {
    owner,
    repo,
    workflowFile: stream.workflow,
    branch: stream.branch,
  });
  if (!present) {
    log(`  ${streamKey(stream)}: the workflow file is not on this branch — nothing is owed`);
    return { runs, commits: null, workflowPresentOnBranch: false };
  }

  const heads = await listBranchCommits(request, { owner, repo, branch: stream.branch, perPage: COVERAGE_WINDOW });
  if (heads == null) {
    log(`  ${streamKey(stream)}: branch does not exist — nothing is owed`);
    return { runs, commits: null, workflowPresentOnBranch: true };
  }
  // An unfiltered lane owes a run for the newest commit, so its file list is never needed.
  if (info.pushPaths.length === 0) {
    return { runs, commits: heads.slice(0, 1).map((c) => ({ ...c, files: [] })), workflowPresentOnBranch: true };
  }
  // Walk newest-first and stop at the first MATCH: the evaluator only ever asks about the
  // newest matching commit, so fetching past it would buy nothing and cost a call each.
  const commits = [];
  for (const head of heads) {
    const files = await getCommitFiles(request, { owner, repo, sha: head.sha });
    commits.push({ ...head, files: files ?? [] });
    if ((files ?? []).some((f) => matchesPathFilter(f, info.pushPaths))) {
      return { runs, commits, workflowPresentOnBranch: true };
    }
  }
  log(`  ${streamKey(stream)}: no paths-matching commit in the last ${heads.length} — silent (window exhausted)`);
  return { runs, commits, workflowPresentOnBranch: true };
}

async function main() {
  const manifest = loadManifest();
  const workflows = loadWorkflowInfo();
  const streams = manifestStreams(manifest).filter((s) => s.watch !== "not-watched");
  const consumer = manifest.consumer;

  const token = DRY_RUN ? (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "") : requireEnv("GITHUB_TOKEN");
  if (DRY_RUN && !token) throw new Error("--dry-run still reads the live API; set GITHUB_TOKEN or GH_TOKEN");
  const { owner, repo, slug } = resolveRepo();
  const request = createClient({ token });

  const log = (line) => console.log(line);
  log(`verdict-reconcile: ${slug} — ${streams.length} watched stream(s)${DRY_RUN ? " [DRY RUN — nothing is published]" : ""}`);

  const data = {};
  for (const stream of streams) {
    const info = workflows[stream.workflow];
    if (!info) continue; // evaluateStreams reports this as workflow_file_missing
    data[streamKey(stream)] = await collectStreamData(request, { owner, repo }, stream, info, log);
  }

  // ── The evaluation. A throw here reaches the top level and exits non-zero BEFORE any
  //    write happens — that ordering is the §4.1 clause, expressed as control flow.
  const now = new Date().toISOString();
  const findings = evaluateStreams({ manifest, workflows, data, now });

  for (const f of findings) log(`  FINDING ${f.stream}: ${f.code} — ${f.detail}`);
  if (findings.length === 0) log("  no findings — every watched stream's latest verdict is success");

  const runUrl =
    process.env.GITHUB_RUN_ID && process.env.GITHUB_SERVER_URL
      ? `${process.env.GITHUB_SERVER_URL}/${slug}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const marker = {
    lastReconciledAt: now,
    runUrl,
    runId: process.env.GITHUB_RUN_ID ?? null,
    findingCount: findings.length,
    streamsWatched: streams.length,
  };
  const body = renderIssueBody({ findings, marker, streamsWatched: streams.length });

  if (DRY_RUN) {
    log("\n───────── issue body that WOULD be published ─────────\n");
    log(body);
    log("\n───────── end (nothing was published) ─────────");
    return;
  }

  // ── The publish. LAST, and only reached because the evaluation returned.
  await ensureLabel(request, {
    owner,
    repo,
    label: consumer.issueLabel,
    description: "DEP-013 workflow-verdict consumer",
  });
  const existing = await findLabelledIssue(request, { owner, repo, label: consumer.issueLabel });
  if (existing) {
    await request("PATCH", `/repos/${owner}/${repo}/issues/${existing.number}`, {
      body: { title: consumer.issueTitle, body, state: "open" },
    });
    log(`verdict-reconcile: published to #${existing.number} (${findings.length} finding(s))`);
  } else {
    const created = await request("POST", `/repos/${owner}/${repo}/issues`, {
      body: { title: consumer.issueTitle, body, labels: [consumer.issueLabel] },
    });
    log(`verdict-reconcile: opened #${created.number} (${findings.length} finding(s))`);
  }

  // Read-back, so "published" is an observation rather than an assumption.
  const published = await findLabelledIssue(request, { owner, repo, label: consumer.issueLabel });
  if (!published || !published.body.includes(marker.lastReconciledAt)) {
    throw new Error("verdict-reconcile: the marker is not readable back from the published issue");
  }
  const total = await countCompletedRuns(request, { owner, repo, workflowFile: consumer.reconcilerWorkflow });
  log(`verdict-reconcile: marker verified on #${published.number} (reconciler completed runs so far: ${total})`);
}

main().catch((error) => {
  console.error(`verdict-reconcile: FAILED — ${error instanceof Error ? error.stack : String(error)}`);
  console.error(
    "\nNothing was published. That is the intended shape: the publish is CHAINED to the\n" +
      "evaluation, so a broken sweep leaves the marker stale and the `policy` reader red,\n" +
      "rather than posting an empty issue that reads as a healthy consumer.",
  );
  process.exit(1);
});
