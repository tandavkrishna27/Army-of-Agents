#!/usr/bin/env node
// -----------------------------------------------------------------------------
// DEP-013 Slice A — the workflow-verdict manifest is COMPLETE BY CONSTRUCTION.
//
//   node scripts/check-workflow-verdict-manifest.mjs
//
// INERT by design: this queries no live verdict and blocks nothing new. It asserts only the
// cheap direction — that the declaration still matches the tree:
//
//   * every file in .github/workflows/ carries at least one manifest entry;
//   * every branch a `push`-triggered workflow declares gets its OWN entry (a green on one
//     branch would otherwise mask a red on the other — §5.4, and the masked branch would be
//     the one the incident happened on);
//   * every not-watched entry says what would have to change (a reason is not an excuse);
//   * every cadence entry's cron is readable and its tolerance is a committed number;
//   * ANTI-VACUITY: zero workflows discovered, zero manifest entries, or zero WATCHED
//     entries all FAIL. A checker that examines nothing and reports nothing is exactly the
//     defect this ticket exists to close.
//
// Same inversion as `check-guard-inventory.mjs` and `check-finding-ownership.mjs`: the hard
// direction (should this lane be watched?) is answered by a human writing it down; the
// machine verifies only that the declaration has not drifted from the tree.
//
// ★ IT REFUSES A MANIFEST IT CANNOT TRUST rather than parsing it and carrying on. On
// 2026-09-03 a `git rerere` replay of a stale resolution produced a JSON file with a
// duplicated key: `JSON.parse` accepts that and silently keeps the LAST copy, so the losing
// copy — which on a rerere replay is often the corrected one — exists only in the raw text.
// The duplicate scan is therefore run over the text, not the parse.
// -----------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findDuplicateJsonKeys } from "./lib/finding-ownership.mjs";
import { describeWorkflow, evaluateManifestCompleteness } from "./lib/workflow-verdict.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
/** `--manifest <path>` exists only so the self-test can point the REAL CLI at a corrupted
 *  fixture and assert the REAL exit code. The workflow invokes it with no arguments. */
const manifestFlag = process.argv.indexOf("--manifest");
const MANIFEST =
  manifestFlag !== -1 && process.argv[manifestFlag + 1]
    ? path.resolve(process.argv[manifestFlag + 1])
    : path.join(ROOT, "scripts", "workflow-verdict-manifest.json");

const EXPLAIN = {
  no_workflows_discovered: "zero workflow files were found — every later check would pass vacuously",
  no_manifest_entries: "the manifest declares no streams — it would pass vacuously",
  no_watched_streams: "nothing is watched — a consumer that consumes nothing is the bug, not the fix",
  consumer_missing: "the `consumer` block is incomplete — the reader has nothing to read",
  workflow_undeclared: "a workflow file with no entry — a verdict nobody declares is a verdict nobody reads",
  branch_undeclared: "a `push` branch with no entry of its own — a green on one branch would mask a red on the other",
  reason_missing: "not-watched without a reason, or without saying what would have to change",
  stream_shape: "the entry is malformed for its mode",
  stream_key_mismatch: "the key must be `<workflow>@<branch|*>`, so a hand edit cannot silently re-point an entry",
  stream_workflow_missing: "names a workflow with no file on disk — a false claim of coverage",
  mode_mismatch: "coverage needs a `push` trigger; cadence needs a `schedule` trigger",
  cron_unreadable: "the cadence entry's cron cannot be read, so its staleness budget is unknowable",
  duplicate_stream: "the same stream is declared twice",
};

function fail(lines) {
  for (const l of lines) console.error(l);
  process.exit(1);
}

if (!existsSync(WORKFLOW_DIR)) {
  fail([`workflow-verdict-manifest: ${path.relative(ROOT, WORKFLOW_DIR)} does not exist.`]);
}
if (!existsSync(MANIFEST)) {
  fail([`workflow-verdict-manifest: scripts/workflow-verdict-manifest.json is missing.`]);
}

const rawManifest = readFileSync(MANIFEST, "utf8");
let manifest;
try {
  manifest = JSON.parse(rawManifest);
} catch (error) {
  fail([
    "workflow-verdict-manifest: the manifest is not valid JSON — REFUSING rather than guessing.",
    `  ${String(error?.message ?? error)}`,
  ]);
}
const duplicates = findDuplicateJsonKeys(rawManifest);
if (duplicates.length > 0) {
  fail([
    "workflow-verdict-manifest: the manifest repeats a key.",
    `  ${duplicates.map((d) => `${d.path} (repeated ${d.count} times)`).join(", ")}`,
    "",
    "  `JSON.parse` accepts a duplicate and silently keeps the LAST copy, so the losing copy",
    "  exists only in the raw text. This is the exact shape a `git rerere` replay of a stale",
    "  conflict resolution produced on 2026-09-03. Re-resolve by hand; check `git rerere status`.",
  ]);
}

const workflowFiles = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort();

const workflowInfo = {};
const parseErrors = [];
for (const file of workflowFiles) {
  try {
    workflowInfo[file] = describeWorkflow(readFileSync(path.join(WORKFLOW_DIR, file), "utf8"));
  } catch (error) {
    parseErrors.push(`${file}: ${String(error?.message ?? error)}`);
  }
}
if (parseErrors.length > 0) {
  fail([
    "workflow-verdict-manifest: a workflow's `on:` block could not be read — REFUSING.",
    ...parseErrors.map((e) => `  - ${e}`),
    "",
    "  The consumer reads each lane's own `paths:` filter and cron from the workflow file so the",
    "  manifest cannot drift from it. A file it cannot read is a lane it cannot watch.",
  ]);
}

const { violations } = evaluateManifestCompleteness({ workflowFiles, workflowInfo, manifest });

if (violations.length > 0) {
  const byCode = new Map();
  for (const v of violations) {
    if (!byCode.has(v.code)) byCode.set(v.code, []);
    byCode.get(v.code).push(v.detail);
  }
  const lines = [`workflow-verdict-manifest: ${violations.length} violation(s).`, ""];
  for (const [code, details] of byCode) {
    lines.push(`  ${code} — ${EXPLAIN[code] ?? "see scripts/lib/workflow-verdict.mjs"}`);
    for (const d of details) lines.push(`    - ${d}`);
    lines.push("");
  }
  lines.push("Fix scripts/workflow-verdict-manifest.json. Watched modes: coverage (push) | cadence (schedule).");
  lines.push("A not-watched entry needs BOTH a `reason` and a `wouldTakeToWatch`.");
  fail(lines);
}

const streams = Object.values(manifest.streams ?? {});
const watched = streams.filter((s) => s.watch !== "not-watched");
console.log(
  `workflow-verdict-manifest: OK — ${workflowFiles.length} workflow file(s), ` +
    `${streams.length} declared stream(s), ${watched.length} watched ` +
    `(${watched.filter((s) => s.watch === "coverage").length} coverage, ` +
    `${watched.filter((s) => s.watch === "cadence").length} cadence).`,
);
