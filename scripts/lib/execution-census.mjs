/**
 * execution-census.mjs — pure, dependency-free logic for TRACK-002.
 *
 * WHY. Nine `*.test.mjs` files carrying 222 tests are invoked by NOTHING, and
 * `check-test-inventory.mjs` counts all nine toward its pins. Existence is credited;
 * execution is never asked. One of the nine (141 tests) is RED, on a mutation test whose
 * mutation is a no-op — a check that correctly detected it could not evaluate what it
 * guards, firing into a void because nothing runs the file.
 *
 * ★ THIS IS DECLARATION-BASED, NOT OBSERVATION-BASED, and that is a measured choice:
 * CI jobs are separate runners, `d1-merge-train.yml` is a DIFFERENT WORKFLOW that a
 * `pr.yml` census could never see, and the heavy jobs SKIP on docs-only PRs — so an
 * artifact-consuming census would either fail every docs PR or pass having collected
 * nothing, which is the exact failure this exists to stop.
 *
 * ★★ THE LIMIT OF THE `runs` DIRECTION, NAMED RATHER THAN CLAIMED AS ENFORCEMENT.
 * Verifying `runs` means asking "does the declared step's `run:` block name this file?".
 * That is INFERENCE, and inference has failed six times in this programme. The sixth was
 * during this ticket's own terrain: a basename grep counted this population as 8 instead
 * of 9, because `image-startup-smoke.test.mjs` is named in a COMMENT explaining why it is
 * NOT wired. Comment-stripping plus scoping to a human-declared step narrows the surface
 * a great deal; it does not close it. A comment INSIDE the declared step naming the path
 * would still satisfy this check.
 *
 * The sound completion is to invoke FROM the manifest so `runs` is true by construction
 * (TRACK-003). Until then, treat a `runs` verdict as "declared, and the declaration is
 * still consistent with the tree" — not as proof of execution.
 */

/** Manifest statuses. `unrun` REQUIRES a reason; a status with no reason is not a declaration. */
export const CENSUS_STATUSES = Object.freeze(["runs", "unrun"]);

/**
 * Strip YAML/shell comment lines from a `run:` block.
 *
 * ★ Load-bearing. Without it, the check credits a file as executed because prose mentions
 * it — the precise defect that produced the wrong baseline for this ticket.
 */
export function stripCommentLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * @param {object} input
 * @param {string[]} input.mjsTestFiles        repo-relative `*.test.mjs` paths found on disk
 * @param {object}   input.manifest            { files: { <path>: { status, workflow?, step?, reason? } } }
 * @param {Map<string,string>} input.stepRunText  "<workflow>::<step name>" -> that step's run: block
 * @param {string[]} input.vitestProjects      the hand-maintained projects[] from vitest.config.ts
 * @param {string[]} input.packagesWithSpecs   packages containing at least one *.test.ts(x)
 * @param {string[]} input.vitestConfigPackages packages owning their own vitest.config.ts
 */
export function evaluateExecutionCensus({
  mjsTestFiles = [],
  manifest = {},
  stepRunText = new Map(),
  vitestProjects = [],
  packagesWithSpecs = [],
  vitestConfigPackages = [],
}) {
  const problems = [];
  const files = (manifest && manifest.files) || {};
  const onDisk = new Set(mjsTestFiles.map(normalize));
  const declared = new Set(Object.keys(files).map(normalize));

  // ── Anti-vacuity. A census that found nothing to census is a broken checker, not a
  // clean tree. Checked FIRST so a broken discovery layer can never read as success.
  if (onDisk.size === 0) problems.push({ kind: "vacuous", detail: "discovered ZERO *.test.mjs files on disk" });
  if (declared.size === 0) problems.push({ kind: "vacuous", detail: "the manifest declares ZERO files" });
  if (vitestProjects.length === 0) problems.push({ kind: "vacuous", detail: "parsed ZERO vitest projects" });
  if (packagesWithSpecs.length === 0) problems.push({ kind: "vacuous", detail: "found ZERO packages containing vitest specs" });

  for (const file of [...onDisk].sort()) {
    if (!declared.has(file)) {
      problems.push({ kind: "undeclared", file, detail: `no entry in the census manifest — declare it 'runs' (with workflow+step) or 'unrun' (with a reason)` });
    }
  }

  for (const raw of Object.keys(files).sort()) {
    const file = normalize(raw);
    const entry = files[raw] || {};
    if (!onDisk.has(file)) {
      problems.push({ kind: "stale", file, detail: "declared in the manifest but no longer on disk" });
      continue;
    }
    if (!CENSUS_STATUSES.includes(entry.status)) {
      problems.push({ kind: "malformed", file, detail: `status must be one of ${CENSUS_STATUSES.join(" | ")}` });
      continue;
    }
    if (entry.status === "unrun") {
      // A reason is not an excuse: it must say what would have to change.
      if (!entry.reason || String(entry.reason).trim().length === 0) {
        problems.push({ kind: "missing_reason", file, detail: "'unrun' requires a reason — an empty reason is not a declaration" });
      }
      continue;
    }
    // status === "runs"
    if (!entry.workflow || !entry.step) {
      problems.push({ kind: "malformed", file, detail: "'runs' requires both 'workflow' and 'step'" });
      continue;
    }
    const key = `${entry.workflow}::${entry.step}`;
    const runText = stepRunText.get(key);
    if (runText === undefined) {
      problems.push({ kind: "unknown_step", file, detail: `declared to run in '${key}', but no such step exists (renamed or deleted?)` });
      continue;
    }
    if (!stripCommentLines(runText).includes(file)) {
      problems.push({ kind: "not_named_in_step", file, detail: `step '${key}' exists but its run: block does not name this path (comments stripped)` });
    }
  }

  const projects = new Set(vitestProjects.map(normalize));
  for (const pkg of [...new Set(packagesWithSpecs.map(normalize))].sort()) {
    if (!projects.has(pkg)) {
      problems.push({ kind: "vitest_project_missing", file: pkg, detail: "contains vitest specs but is absent from vitest.config.ts projects[] — its tests run nowhere" });
    }
  }

  // ★ THE SECOND SPEC NAMING CONVENTION — added because the first version of this guard
  // was BLIND to a live instance. `packagesWithSpecs` matches `*.test.ts(x)`, and
  // `packages/plugins/examples/plugin-authoring-smoke-example` names its suite
  // `tests/plugin.spec.ts` (its own vitest config sets `include: ["tests/**/*.spec.ts"]`).
  // It is a pnpm workspace member, it is in no root project, nothing invokes it, and it
  // passes — a whole suite that has never run, invisible to the very census written to
  // find such things.
  //
  // Keyed on OWNING A vitest.config.ts rather than on the `.spec.ts` suffix, deliberately:
  // `tests/e2e/**` and `tests/release-smoke/**` are full of `.spec.ts` files that belong to
  // PLAYWRIGHT (they carry playwright.config.ts and no vitest config). Matching the suffix
  // would flag those as unrun vitest suites — a false positive, which is how a guard earns
  // its own deletion.
  for (const pkg of [...new Set(vitestConfigPackages.map(normalize))].sort()) {
    if (!projects.has(pkg)) {
      problems.push({ kind: "vitest_config_not_in_projects", file: pkg, detail: "owns a vitest.config.ts but is absent from the root projects[] — the root run never reaches it" });
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    counts: {
      onDisk: onDisk.size,
      declared: declared.size,
      runs: Object.values(files).filter((e) => e && e.status === "runs").length,
      unrun: Object.values(files).filter((e) => e && e.status === "unrun").length,
      vitestProjects: projects.size,
      packagesWithSpecs: new Set(packagesWithSpecs.map(normalize)).size,
      vitestConfigPackages: new Set(vitestConfigPackages.map(normalize)).size,
    },
  };
}

function normalize(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "");
}
