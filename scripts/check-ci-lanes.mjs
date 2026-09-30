#!/usr/bin/env node
// -----------------------------------------------------------------------------
// DEP-004 static CI-lane-routing validator (LOCAL authority; no PG/Docker).
//
//   node scripts/check-ci-lanes.mjs
//
// Parses the REAL .github/workflows/pr.yml + d1-merge-train.yml into the pure
// `evaluateCiLanes` contract (scripts/lib/ci-lanes.mjs) and fails closed when:
//   * a protocol/schema/provider path-class has no MANDATORY consumer folded into
//     the ci-required verdict (an unconsumed contract change would merge unseen);
//   * pr.yml carries ANY trigger-level `paths:`/`paths-ignore:` filter (a skipped
//     required check passes silently — the forbidden footgun); or
//   * d1-merge-train.yml does not upload the evidence bundle on failure.
//
// The `on:` trigger blocks are parsed with the dependency-free yaml-lite parser
// (they sit inside its supported subset). The jobs region is parsed with a
// focused line scanner (yaml-lite does not model GitHub `steps:` sequences-of-
// mappings) that extracts each job's needs/if, the `changes` outputs, and the
// ci-required verdict's consumed jobs + gating path-classes.
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseYaml } from "./lib/yaml-lite.mjs";
import {
  evaluateCiLanes,
  DEFAULT_REQUIRED_NEEDS,
  parseCiRequiredVerdict,
  uploadsEvidenceBundleOnFailure,
} from "./lib/ci-lanes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PR_PATH = path.join(repoRoot, ".github", "workflows", "pr.yml");
const MT_PATH = path.join(repoRoot, ".github", "workflows", "d1-merge-train.yml");

/** Extract the `on:` trigger sub-block text (col-0 `on:` until the next col-0 key). */
function extractOnBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^on:\s*$/.test(l) || /^on:\s+\S/.test(l));
  if (start === -1) return null;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\S/.test(l)) break; // next top-level key ends the on: block
    block.push(l);
  }
  return block.join("\n");
}

/** Parse the `on:` block into a trigger object via yaml-lite. */
function parseTriggers(text, errors, file) {
  const onText = extractOnBlock(text);
  if (onText == null) {
    errors.push(`${file}: no top-level \`on:\` trigger block found`);
    return {};
  }
  try {
    const doc = parseYaml(onText);
    return (doc && typeof doc === "object" && doc.on && typeof doc.on === "object") ? doc.on : {};
  } catch (err) {
    errors.push(`${file}: could not parse the on: block (${err instanceof Error ? err.message : String(err)})`);
    return {};
  }
}

/** Parse a `needs:` value: flow `[a, b]`, scalar `changes`, or a block sequence. */
function parseNeeds(rawAfterColon, body, idx) {
  const v = (rawAfterColon ?? "").trim();
  if (v.startsWith("[")) {
    return v.replace(/^\[/, "").replace(/\]$/, "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (v !== "") return [v];
  // Block sequence: subsequent `- name` lines indented beyond `needs:`.
  const out = [];
  for (let i = idx + 1; i < body.length; i += 1) {
    const m = /^\s+-\s+(\S+)\s*$/.exec(body[i]);
    if (m) out.push(m[1]);
    else if (body[i].trim() !== "") break;
  }
  return out;
}

/** Parse the pr.yml jobs region into { jobs, changesOutputs, ciRequired }. */
function parsePrJobs(text, errors) {
  const lines = text.split(/\r?\n/);
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsIdx === -1) {
    errors.push("pr.yml: no top-level `jobs:` block found");
    return { jobs: {}, changesOutputs: [], ciRequired: undefined };
  }
  // Job headers: indent-2 `  name:` with nothing after the colon.
  const headers = [];
  for (let i = jobsIdx + 1; i < lines.length; i += 1) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (m) headers.push({ name: m[1], idx: i });
  }
  const jobs = {};
  let changesOutputs = [];
  let ciRequired;
  for (let h = 0; h < headers.length; h += 1) {
    const { name, idx } = headers[h];
    const end = h + 1 < headers.length ? headers[h + 1].idx : lines.length;
    const body = lines.slice(idx + 1, end);

    let ifExpr = "";
    let needs = [];
    for (let i = 0; i < body.length; i += 1) {
      const ifM = /^ {4}if:\s*(.+)$/.exec(body[i]);
      if (ifM && ifExpr === "") ifExpr = ifM[1].trim();
      const needsM = /^ {4}needs:\s*(.*)$/.exec(body[i]);
      if (needsM && needs.length === 0) needs = parseNeeds(needsM[1], body, i);
    }
    jobs[name] = { needs, if: ifExpr };

    if (name === "changes") {
      // outputs: block (indent-4) then indent-6 `key:` lines until dedent.
      const outIdx = body.findIndex((l) => /^ {4}outputs:\s*$/.test(l));
      if (outIdx !== -1) {
        for (let i = outIdx + 1; i < body.length; i += 1) {
          const om = /^ {6}([A-Za-z0-9_-]+):/.exec(body[i]);
          if (om) changesOutputs.push(om[1]);
          else if (body[i].trim() !== "" && /^ {0,4}\S/.test(body[i])) break;
        }
      }
    }

    if (name === "ci-required") {
      // The verdict's consumed jobs + gating path-classes are derived by the shared
      // pure helper, which proves the `run:` shell ACTUALLY tests each captured
      // result — an env-only `needs.*.result` capture is NOT enough (see
      // scripts/lib/ci-lanes.mjs::parseCiRequiredVerdict).
      const { verdictConsumes, verdictClassGates } = parseCiRequiredVerdict(body.join("\n"));
      ciRequired = {
        jobName: "ci-required",
        needs,
        verdictConsumes,
        verdictClassGates,
      };
    }
  }
  return { jobs, changesOutputs, ciRequired };
}

function main() {
  const errors = [];
  let prText;
  let mtText;
  try {
    prText = readFileSync(PR_PATH, "utf8");
  } catch (err) {
    console.error(`FAIL: could not read ${PR_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  try {
    mtText = readFileSync(MT_PATH, "utf8");
  } catch (err) {
    console.error(`FAIL: could not read ${MT_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const prTriggers = parseTriggers(prText, errors, "pr.yml");
  const { jobs, changesOutputs, ciRequired } = parsePrJobs(prText, errors);
  const mtTriggers = parseTriggers(mtText, errors, "d1-merge-train.yml");

  const workflows = {
    "pr.yml": { triggers: prTriggers, changesOutputs, jobs, ciRequired },
    "d1-merge-train.yml": {
      triggers: mtTriggers,
      uploadsEvidenceOnFailure: uploadsEvidenceBundleOnFailure(mtText),
    },
  };

  const { violations } = evaluateCiLanes({ workflows, requiredNeeds: DEFAULT_REQUIRED_NEEDS });
  const all = [...errors, ...violations];

  if (all.length > 0) {
    console.error(`FAIL: CI-lane routing violates ${all.length} DEP-004 invariant(s):`);
    for (const v of all) console.error(`  - ${v}`);
    process.exit(1);
  }

  console.log("OK: CI-lane routing satisfies the DEP-004 contract");
  console.log(`    changes emits: ${changesOutputs.join(", ")}`);
  console.log(`    ci-required.needs includes: ${(ciRequired?.needs || []).join(", ")}`);
  console.log(`    verdict folds in: ${(ciRequired?.verdictConsumes || []).join(", ")}`);
  console.log(`    verdict class-gates: ${(ciRequired?.verdictClassGates || []).join(", ")}`);
  console.log("    no trigger-level paths:/paths-ignore: on pr.yml;");
  console.log("    d1-merge-train.yml uploads the evidence bundle on failure.");
}

main();
