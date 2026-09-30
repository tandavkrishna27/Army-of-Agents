// -----------------------------------------------------------------------------
// ci-lanes — pure DEP-004 CI-lane-routing validator (dependency-free).
//
// `evaluateCiLanes({workflows, requiredNeeds}) -> {violations: string[]}`
//
// This is the structural gate behind the two HARD RULES of the re-platform CI:
//
//   1. NEVER a trigger-level `paths:`/`paths-ignore:` on pr.yml. GitHub treats a
//      skipped REQUIRED check as passing, so a path-filtered trigger silently
//      turns a required job green without running it. All conditional execution
//      must route through the `changes` path-class outputs + the `ci-required`
//      aggregator verdict instead.
//
//   2. NEVER an independently-required conditional job. Only `ci-required` is a
//      branch-protection required check; it computes pass/fail from
//      `needs.*.result` + the changed path-class, so a `skipped` consumer counts
//      as a PASS ONLY when its class did not change (the `code`-gated docs-only
//      pattern).
//
// Therefore every protocol/schema/provider path-class MUST map to a MANDATORY
// consumer job that is (a) emitted by `changes`, (b) if-gated on its class, (c)
// listed in `ci-required.needs`, (d) folded into the `ci-required` verdict, and
// (e) class-gated inside that verdict (required only when its class changed).
// Separately, `d1-merge-train.yml` must upload the failure-evidence bundle.
//
// The lib is pure: the CLI (scripts/check-ci-lanes.mjs) parses the REAL workflow
// files into the `workflows` shape this consumes. The `node --test` fixtures build
// that shape directly, so the invariants are exercised without any YAML parsing.
//
// Two focused, side-effect-free TEXT-SCAN helpers also live here so the CLI parser
// and the `node --test` fixtures share one implementation (and so the scanners are
// directly unit-testable without triggering the CLI's `main()`):
//   * `parseCiRequiredVerdict(bodyText)` — derives the verdict's consumed jobs +
//     gating path-classes from the ci-required job body. It proves the verdict
//     `run:` shell ACTUALLY tests each captured result (not merely captures it in
//     `env:`), so an unconsumed `needs.*.result` env line cannot satisfy the
//     "folded into the verdict" invariant.
//   * `uploadsEvidenceBundleOnFailure(text)` — true only for a failure()/always()-
//     guarded `upload-artifact` step that uploads the EVIDENCE bundle specifically
//     (its `path:` under the evidence dir or its `name:` containing "evidence"),
//     never any other guarded artifact upload.
//
// `workflows` shape:
//   {
//     "pr.yml": {
//       triggers: <parsed `on:` object>,          // e.g. { pull_request:{...}, push:{...} }
//       changesOutputs: string[],                  // outputs declared by the `changes` job
//       jobs: { <name>: { needs: string[], if: string } },
//       ciRequired: {
//         jobName, needs: string[],
//         verdictConsumes: string[],               // jobs whose `.result` the verdict reads
//         verdictClassGates: string[],             // changes.outputs.<class> the verdict reads
//       },
//     },
//     "d1-merge-train.yml": { triggers, uploadsEvidenceOnFailure: boolean },
//   }
// -----------------------------------------------------------------------------

/** The mandatory-consumer contract enforced by default: every protocol/schema/
 *  provider change must trigger the `distributed-contract` consumer. */
export const DEFAULT_REQUIRED_NEEDS = [
  { pathClass: "protocol", consumer: "distributed-contract" },
  { pathClass: "schema", consumer: "distributed-contract" },
  { pathClass: "provider", consumer: "distributed-contract" },
];

const PR_WORKFLOW = "pr.yml";
const MERGE_TRAIN_WORKFLOW = "d1-merge-train.yml";
const FORBIDDEN_TRIGGER_KEYS = ["paths", "paths-ignore"];

/** Recursively collect every forbidden trigger key path found under `on:`. */
function findForbiddenPathKeys(node, trail, out) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) findForbiddenPathKeys(node[i], `${trail}[${i}]`, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN_TRIGGER_KEYS.includes(key)) {
      out.push({ key, at: trail ? `${trail}.${key}` : key });
    }
    findForbiddenPathKeys(value, trail ? `${trail}.${key}` : key, out);
  }
}

/** Does an `if:` expression reference `needs.changes.outputs.<cls>` (dot or bracket)? */
function ifReferencesClass(expr, cls) {
  if (typeof expr !== "string") return false;
  const dot = new RegExp(`needs\\.changes\\.outputs\\.${cls}\\b`);
  const bracket = new RegExp(`needs\\.changes\\.outputs\\[['"]${cls}['"]\\]`);
  return dot.test(expr) || bracket.test(expr);
}

/**
 * Validate CI-lane routing. Returns `{ violations }` (empty ⇒ compliant).
 * @param {{workflows: object, requiredNeeds?: {pathClass:string, consumer:string}[]}} args
 */
export function evaluateCiLanes({ workflows, requiredNeeds } = {}) {
  const violations = [];
  const rn = Array.isArray(requiredNeeds) && requiredNeeds.length > 0 ? requiredNeeds : DEFAULT_REQUIRED_NEEDS;

  if (workflows == null || typeof workflows !== "object") {
    return { violations: ["workflows: no parsed workflow map was provided"] };
  }

  const pr = workflows[PR_WORKFLOW];
  if (pr == null || typeof pr !== "object") {
    violations.push(`${PR_WORKFLOW}: workflow is missing or unparsed`);
  } else {
    // --- HARD RULE 1: no trigger-level paths / paths-ignore ------------------
    const forbidden = [];
    findForbiddenPathKeys(pr.triggers ?? {}, "on", forbidden);
    for (const f of forbidden) {
      violations.push(
        `${PR_WORKFLOW}: forbidden trigger-level "${f.key}" filter at ${f.at} — a skipped REQUIRED check passes silently; route conditional execution through the changes outputs + ci-required verdict instead`,
      );
    }

    const jobs = pr.jobs && typeof pr.jobs === "object" ? pr.jobs : {};
    const changesOutputs = new Set(Array.isArray(pr.changesOutputs) ? pr.changesOutputs : []);
    const ciRequired = pr.ciRequired;

    // --- HARD RULE: `policy` must NOT be code-gated ---------------------------
    //
    // The policy job carries the guards that reason over DOCUMENTS: the ticket graph, the
    // guard inventory, and finding ownership. Their trigger IS a docs change — adding an
    // open finding to `findings.md`, or a ticket file with no node in the plan, is a
    // docs-only diff. Gate this job on `changes.outputs.code` and those guards stop running
    // for precisely the change that is supposed to trip them, while the job still reports
    // green because it was never asked.
    //
    // This is not hypothetical: it is the same shape as the four blockers that reached the
    // top of this programme's critical path unscheduled. The guard that would have caught
    // them lives in this job.
    const policyJob = jobs.policy;
    if (policyJob && typeof policyJob.if === "string" && /changes\.outputs\.code/.test(policyJob.if)) {
      violations.push(
        `${PR_WORKFLOW}: the "policy" job is gated on changes.outputs.code — it carries the document-reasoning guards (ticket graph, guard inventory, finding ownership) whose trigger is a DOCS-only change, so code-gating them means they never run when it matters`,
      );
    }

    // --- ci-required aggregator must exist (the ONLY required check) ---------
    if (ciRequired == null || typeof ciRequired !== "object") {
      violations.push(
        `${PR_WORKFLOW}: no ci-required aggregator facts — the single required branch-protection check is missing or unparsed`,
      );
    } else if (!("ci-required" in jobs)) {
      violations.push(`${PR_WORKFLOW}: ci-required job not found among jobs`);
    }

    const ciNeeds = new Set(ciRequired && Array.isArray(ciRequired.needs) ? ciRequired.needs : []);
    const verdictConsumes = new Set(
      ciRequired && Array.isArray(ciRequired.verdictConsumes) ? ciRequired.verdictConsumes : [],
    );
    const verdictClassGates = new Set(
      ciRequired && Array.isArray(ciRequired.verdictClassGates) ? ciRequired.verdictClassGates : [],
    );

    // --- HARD RULE 2: every path-class maps to a MANDATORY consumer ----------
    for (const { pathClass, consumer } of rn) {
      // (a) the `changes` job must emit the path-class output.
      if (!changesOutputs.has(pathClass)) {
        violations.push(
          `${PR_WORKFLOW}: the changes job does not emit a "${pathClass}" path-class output (consumer "${consumer}" cannot be gated on it)`,
        );
      }
      // consumer job must exist.
      const consumerJob = jobs[consumer];
      if (consumerJob == null) {
        violations.push(`${PR_WORKFLOW}: mandatory consumer job "${consumer}" for path-class "${pathClass}" does not exist`);
      } else {
        // (b) consumer must be if-gated on its path-class output.
        if (!ifReferencesClass(consumerJob.if, pathClass)) {
          violations.push(
            `${PR_WORKFLOW}: consumer "${consumer}" is not if-gated on the "${pathClass}" path-class (its if: must reference needs.changes.outputs.${pathClass})`,
          );
        }
      }
      // (c) consumer must be in ci-required.needs.
      if (!ciNeeds.has(consumer)) {
        violations.push(
          `${PR_WORKFLOW}: consumer "${consumer}" for path-class "${pathClass}" is not in ci-required.needs — it would not be a mandatory consumer`,
        );
      }
      // (d) consumer must be folded into the ci-required verdict.
      if (!verdictConsumes.has(consumer)) {
        violations.push(
          `${PR_WORKFLOW}: consumer "${consumer}" is in ci-required.needs but not folded into the ci-required verdict (its .result is never read)`,
        );
      }
      // (e) the verdict must class-gate the consumer (required only when its
      //     class changed — the docs-only `code`-gated pattern).
      if (!verdictClassGates.has(pathClass)) {
        violations.push(
          `${PR_WORKFLOW}: the ci-required verdict does not class-gate consumer "${consumer}" on "${pathClass}" changes — it would be unconditionally required (or never required), not the code-gated skip pattern`,
        );
      }
    }
  }

  // --- merge-train evidence retention on failure -----------------------------
  const mt = workflows[MERGE_TRAIN_WORKFLOW];
  if (mt == null || typeof mt !== "object") {
    violations.push(`${MERGE_TRAIN_WORKFLOW}: workflow is missing — the D1 merge-train with retained evidence is required`);
  } else if (mt.uploadsEvidenceOnFailure !== true) {
    violations.push(
      `${MERGE_TRAIN_WORKFLOW}: does not upload the evidence bundle on failure (an upload-artifact step guarded by failure()/always() is required)`,
    );
  }

  return { violations };
}

// ---------------------------------------------------------------------------
// TEXT-SCAN helpers (used by the CLI parser + directly unit-tested).
// ---------------------------------------------------------------------------

/** Escape a string for embedding in a RegExp. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a job body into its step's `env:` mapping text and `run:` script text.
 * A block key (`env:` / `run: |`) owns the deeper-indented lines beneath it up to
 * the next line at or below the key's own indent. `run:` keeps blank lines (they
 * are part of the shell script); `env:` skips them.
 */
function extractEnvAndRun(bodyText) {
  const lines = String(bodyText ?? "").split(/\r?\n/);
  const env = [];
  const run = [];
  for (let i = 0; i < lines.length; i += 1) {
    const envM = /^(\s*)env:\s*$/.exec(lines[i]);
    const runM = /^(\s*)run:\s*(?:\|[+-]?|>[+-]?)?\s*$/.exec(lines[i]);
    if (envM) {
      const ind = envM[1].length;
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() === "") continue;
        if (l.match(/^(\s*)/)[1].length > ind) env.push(l);
        else break;
      }
      i = j - 1;
      continue;
    }
    if (runM) {
      const ind = runM[1].length;
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() !== "" && l.match(/^(\s*)/)[1].length <= ind) break;
        run.push(l);
      }
      i = j - 1;
      continue;
    }
  }
  return { envText: env.join("\n"), runText: run.join("\n") };
}

/**
 * From an `env:` mapping, recover which shell var captures which `needs.*.result`
 * job and which `needs.changes.outputs.<class>` path-class.
 * @returns {{consumeVars: Map<string,string>, classVars: Map<string,string>}}
 */
function envCaptureMaps(envText) {
  const consumeVars = new Map(); // shellVar -> consumed job name
  const classVars = new Map(); // shellVar -> gating path-class
  for (const raw of String(envText ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = /^([A-Za-z_][A-Za-z0-9_]*):\s*\$\{\{\s*needs\.([A-Za-z0-9_-]+)\.result\s*\}\}/.exec(line))) {
      consumeVars.set(m[1], m[2]);
    } else if ((m = /^([A-Za-z_][A-Za-z0-9_]*):\s*\$\{\{\s*needs\[['"]([A-Za-z0-9_-]+)['"]\]\.result\s*\}\}/.exec(line))) {
      consumeVars.set(m[1], m[2]);
    } else if ((m = /^([A-Za-z_][A-Za-z0-9_]*):\s*\$\{\{\s*needs\.changes\.outputs\.([A-Za-z0-9_-]+)\s*\}\}/.exec(line))) {
      classVars.set(m[1], m[2]);
    } else if ((m = /^([A-Za-z_][A-Za-z0-9_]*):\s*\$\{\{\s*needs\.changes\.outputs\[['"]([A-Za-z0-9_-]+)['"]\]\s*\}\}/.exec(line))) {
      classVars.set(m[1], m[2]);
    }
  }
  return { consumeVars, classVars };
}

/**
 * Does the verdict `run:` shell TEST `$shellVar` in a way that can set failure?
 * True iff the var appears inside a `[ … ]`/`[[ … ]]` test, OR on a line that
 * also sets `fail=1` / `exit 1`. A bare echo/capture does not count.
 */
function consumerTestedForFailure(runText, shellVar) {
  const v = escapeRe(shellVar);
  const varRe = new RegExp(`\\$\\{?${v}\\b`);
  const bracketRe = new RegExp(`\\[.*\\$\\{?${v}\\b.*\\]`);
  const failRe = /\bfail=1\b|\bexit\s+1\b/;
  for (const line of String(runText ?? "").split(/\r?\n/)) {
    if (!varRe.test(line)) continue;
    if (bracketRe.test(line)) return true;
    if (failRe.test(line)) return true;
  }
  return false;
}

/**
 * Does `$shellVar` participate in the `contract_changed` computation? True iff it
 * appears within the run-block region spanned by the first..last `contract_changed`
 * mention (the loop/if that derives whether a contract path-class changed).
 */
function classUsedInContractComputation(runText, shellVar) {
  const lines = String(runText ?? "").split(/\r?\n/);
  const idxs = [];
  for (let i = 0; i < lines.length; i += 1) if (/contract_changed/.test(lines[i])) idxs.push(i);
  if (idxs.length === 0) return false;
  const region = lines.slice(idxs[0], idxs[idxs.length - 1] + 1).join("\n");
  return new RegExp(`\\$\\{?${escapeRe(shellVar)}\\b`).test(region);
}

/**
 * Derive the ci-required verdict's consumed jobs + gating path-classes from the
 * ci-required job body. A job counts as CONSUMED only when its `needs.*.result` is
 * captured into a shell var AND that var is tested-for-failure in the `run:` block;
 * a path-class counts as GATED only when its captured var participates in the
 * `contract_changed` computation. Env capture alone is NOT enough.
 * @returns {{verdictConsumes: string[], verdictClassGates: string[]}}
 */
export function parseCiRequiredVerdict(bodyText) {
  const { envText, runText } = extractEnvAndRun(bodyText);
  const { consumeVars, classVars } = envCaptureMaps(envText);
  const verdictConsumes = new Set();
  for (const [shellVar, job] of consumeVars) {
    if (consumerTestedForFailure(runText, shellVar)) verdictConsumes.add(job);
  }
  const verdictClassGates = new Set();
  for (const [shellVar, cls] of classVars) {
    if (classUsedInContractComputation(runText, shellVar)) verdictClassGates.add(cls);
  }
  return { verdictConsumes: [...verdictConsumes], verdictClassGates: [...verdictClassGates] };
}

/**
 * Does the workflow upload the EVIDENCE bundle from a failure()/always()-guarded
 * step? True only when a guarded `actions/upload-artifact` step ALSO references the
 * evidence output — its `path:` under the evidence dir (`${{ env.EVIDENCE_DIR }}` /
 * `d1-evidence`) or its `name:` containing "evidence". A guarded upload of some
 * OTHER artifact (e.g. a playwright report) does NOT satisfy the rule.
 */
export function uploadsEvidenceBundleOnFailure(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/uses:\s*actions\/upload-artifact/.test(lines[i])) continue;
    // Walk back to the enclosing step's `- ` marker to bound the step block.
    let start = i;
    while (start >= 0 && !/^\s*-\s/.test(lines[start])) start -= 1;
    if (start < 0) start = i;
    const stepIndent = (lines[start].match(/^(\s*)-/) || [, ""])[1].length;
    let end = start + 1;
    while (end < lines.length) {
      const l = lines[end];
      if (l.trim() !== "" && l.match(/^(\s*)/)[1].length <= stepIndent) break;
      end += 1;
    }
    const block = lines.slice(start, end).join("\n");
    const guarded = /(^|\n)\s*if:[^\n]*(failure\(\)|always\(\))/.test(block);
    if (!guarded) continue;
    // Must upload the EVIDENCE bundle specifically: its `path:` under the evidence
    // dir, or its `name:` containing "evidence". A guarded upload of some OTHER
    // artifact (e.g. a playwright report) does NOT satisfy the rule.
    const evidencePath = /(^|\n)\s*path:[^\n]*(\$\{\{\s*env\.EVIDENCE_DIR\s*\}\}|d1-evidence)/.test(block);
    const evidenceName = /(^|\n)\s*name:[^\n]*evidence/i.test(block);
    if (evidencePath || evidenceName) return true;
  }
  return false;
}
