#!/usr/bin/env node
/**
 * Mutation corpus for check-distributed-execution-foundation.mjs.
 *
 * Run with: node --test scripts/check-distributed-execution-foundation.test.mjs
 *
 * Each case builds a minimal temporary document tree by copying the real
 * foundation documents into an isolated `--root`, applies exactly one mutation,
 * and asserts the checker fails with the exact path/cause. The valid baseline
 * (real repo, and an unmutated fixture copy) must pass with zero errors.
 *
 * This corpus is the shared, extensible base for FND-001..008: every later FND
 * ticket extends the checker and appends new mutation cases here rather than
 * relying on string-fragment presence.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runCheck,
  canonicalizeJson,
  computeEventDigest,
  parseJsonStrict,
  checkEvidenceImmutability,
  formatDivergenceCensus,
} from "./check-distributed-execution-foundation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GJ_DIR = "tests/fixtures/distributed-execution";

const REL = {
  json: "docs/architecture/distributed-execution-lifecycles.json",
  md: "docs/architecture/distributed-execution-lifecycles.md",
  decisions: "docs/architecture/decisions.md",
  authority: "docs/architecture/distributed-execution-authority.md",
  threatModel: "docs/architecture/distributed-execution-threat-model.md",
  threatControls: "docs/architecture/distributed-execution-threat-controls.json",
  programDesign: "docs/replatform/program-design.md",
  fixturesDir: GJ_DIR,
  schema: `${GJ_DIR}/schema-v1.json`,
  // FND-005
  app: "server/src/app.ts",
  // FND-006
  cloudPluginExecution: "server/src/services/cloud-plugin-execution.ts",
  // FND-008
  pluginsRoutes: "server/src/routes/plugins.ts",
  pluginUiStatic: "server/src/routes/plugin-ui-static.ts",
  pluginBrokerTools: "server/src/mcp/tools/plugin-broker-tools.ts",
  deliveryPolicy: "docs/architecture/distributed-execution-delivery-policy.md",
  artifactPolicy: "docs/replatform/artifact-policy.md",
  ticketTemplate: "docs/replatform/templates/ticket-result-template.md",
  qaTemplate: "docs/replatform/templates/qa-result-template.md",
  handoffTemplate: "docs/replatform/templates/handoff-template.md",
  // FND-007
  legacyParity: "docs/architecture/distributed-execution-legacy-parity.json",
  crosswalk: "docs/replatform/current-main-crosswalk.md",
  // REL-FOUNDATION-GATE (S9 unit 1): the E11 tickets dir is the existence source
  // and the deferral manifest is the tracked-debt source for the release-test gate.
  relTicketsDir: "docs/replatform/epics/E11-hardening-release/tickets",
  releaseTests: "docs/architecture/distributed-execution-release-tests.json",
  // BRW-004 slice (b): the SHIPPED source-governance authority the fixture
  // control-block parity check binds to. It must be copied into the fixture root
  // or the check reports "missing" and the unmutated baseline breaks — which is
  // the check working, not a reason to make it fail open.
  jobApprovalBridge: "server/src/services/job-approval-bridge.ts",
  // W4U2: the findings register the delivery-status contract resolves against. Copied
  // for the same reason as the release-test inputs — the checker must read the FIXTURE
  // copy, or a mutation to a crossing's deliveryStatus could not be turned red against
  // a mutated register, and the "delivered is refused while a finding names it" clause
  // would be silently evaluated against the real tree.
  findingOwnership: "scripts/finding-ownership.json",
};

function makeFixture(t, mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fnd00x-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archDir = path.join(root, "docs", "architecture");
  fs.mkdirSync(archDir, { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "replatform"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "replatform", "templates"), { recursive: true });
  fs.mkdirSync(path.join(root, "server", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "server", "src", "services"), { recursive: true });
  fs.mkdirSync(path.join(root, "server", "src", "routes"), { recursive: true });
  fs.mkdirSync(path.join(root, "server", "src", "mcp", "tools"), {
    recursive: true,
  });
  const files = {
    root,
    jsonPath: path.join(root, REL.json),
    mdPath: path.join(root, REL.md),
    decisionsPath: path.join(root, REL.decisions),
    authorityPath: path.join(root, REL.authority),
    threatModelPath: path.join(root, REL.threatModel),
    threatControlsPath: path.join(root, REL.threatControls),
    programDesignPath: path.join(root, REL.programDesign),
    fixturesDir: path.join(root, REL.fixturesDir),
    schemaPath: path.join(root, REL.schema),
    fixturePath: (name) => path.join(root, REL.fixturesDir, name),
    // FND-005
    appPath: path.join(root, REL.app),
    // FND-006
    cloudPluginExecutionPath: path.join(root, REL.cloudPluginExecution),
    // FND-008
    pluginsRoutesPath: path.join(root, REL.pluginsRoutes),
    pluginUiStaticPath: path.join(root, REL.pluginUiStatic),
    pluginBrokerToolsPath: path.join(root, REL.pluginBrokerTools),
    deliveryPolicyPath: path.join(root, REL.deliveryPolicy),
    artifactPolicyPath: path.join(root, REL.artifactPolicy),
    ticketTemplatePath: path.join(root, REL.ticketTemplate),
    qaTemplatePath: path.join(root, REL.qaTemplate),
    handoffTemplatePath: path.join(root, REL.handoffTemplate),
    // FND-007
    legacyParityPath: path.join(root, REL.legacyParity),
    crosswalkPath: path.join(root, REL.crosswalk),
    // REL-FOUNDATION-GATE
    relTicketsDir: path.join(root, REL.relTicketsDir),
    releaseTestsPath: path.join(root, REL.releaseTests),
    // BRW-004 slice (b)
    jobApprovalBridgePath: path.join(root, REL.jobApprovalBridge),
    // W4U2
    findingOwnershipPath: path.join(root, REL.findingOwnership),
  };
  fs.copyFileSync(path.join(repoRoot, REL.json), files.jsonPath);
  fs.copyFileSync(path.join(repoRoot, REL.md), files.mdPath);
  fs.copyFileSync(path.join(repoRoot, REL.decisions), files.decisionsPath);
  fs.copyFileSync(path.join(repoRoot, REL.authority), files.authorityPath);
  fs.copyFileSync(path.join(repoRoot, REL.threatModel), files.threatModelPath);
  fs.copyFileSync(path.join(repoRoot, REL.threatControls), files.threatControlsPath);
  fs.copyFileSync(path.join(repoRoot, REL.programDesign), files.programDesignPath);
  // FND-004: copy the whole fixture corpus (schema-v1.json + 9 fixtures + README).
  fs.cpSync(path.join(repoRoot, REL.fixturesDir), files.fixturesDir, { recursive: true });
  // FND-005: copy the app/route registry + delivery policy + artifact policy + templates.
  fs.copyFileSync(path.join(repoRoot, REL.app), files.appPath);
  // FND-006: copy the cloud-plugin execution gate for the process-boundary check.
  fs.copyFileSync(
    path.join(repoRoot, REL.cloudPluginExecution),
    files.cloudPluginExecutionPath,
  );
  // FND-008: copy the plugin HTTP routes, the ui-static browser-code route, and
  // the MCP broker tools for the runtime-surface denial checks.
  fs.copyFileSync(path.join(repoRoot, REL.pluginsRoutes), files.pluginsRoutesPath);
  fs.copyFileSync(
    path.join(repoRoot, REL.pluginUiStatic),
    files.pluginUiStaticPath,
  );
  fs.copyFileSync(
    path.join(repoRoot, REL.pluginBrokerTools),
    files.pluginBrokerToolsPath,
  );
  fs.copyFileSync(path.join(repoRoot, REL.deliveryPolicy), files.deliveryPolicyPath);
  fs.copyFileSync(path.join(repoRoot, REL.artifactPolicy), files.artifactPolicyPath);
  fs.copyFileSync(path.join(repoRoot, REL.ticketTemplate), files.ticketTemplatePath);
  fs.copyFileSync(path.join(repoRoot, REL.qaTemplate), files.qaTemplatePath);
  fs.copyFileSync(path.join(repoRoot, REL.handoffTemplate), files.handoffTemplatePath);
  // FND-007: copy the legacy-parity authority + the current-main crosswalk.
  fs.copyFileSync(path.join(repoRoot, REL.legacyParity), files.legacyParityPath);
  fs.copyFileSync(path.join(repoRoot, REL.crosswalk), files.crosswalkPath);
  // REL-FOUNDATION-GATE: copy the E11 tickets dir (existence source) + the
  // release-test deferral manifest, so the strict release-test gate resolves
  // BOTH new inputs against the fixture root, not the real tree (design §3.4).
  // Skipping this is the trap: the checker would read the real tickets dir/manifest
  // and `valid: an unmutated fixture copy passes` would break — the wrong "fix"
  // (fail-open on missing inputs) silently reintroduces the vacuous green.
  fs.mkdirSync(path.dirname(files.relTicketsDir), { recursive: true });
  fs.cpSync(path.join(repoRoot, REL.relTicketsDir), files.relTicketsDir, {
    recursive: true,
  });
  fs.copyFileSync(path.join(repoRoot, REL.releaseTests), files.releaseTestsPath);
  // BRW-004 slice (b): the shipped describeSourceGovernance authority. Copied for the
  // same reason as the release-test inputs above — the check must resolve it against
  // the FIXTURE root, not the real tree, or a mutation to the authority would be
  // silently ignored and the "authority mutated" cases below could not turn red.
  fs.copyFileSync(path.join(repoRoot, REL.jobApprovalBridge), files.jobApprovalBridgePath);
  // W4U2: the findings register, the external source both delivery-status rules
  // resolve against.
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, REL.findingOwnership), files.findingOwnershipPath);
  if (mutate) mutate(files);
  return root;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}
function hasError(errors, substr) {
  return errors.some((e) => e.includes(substr));
}
function report(errors) {
  return `\nActual errors:\n${errors.map((e) => `  - ${e}`).join("\n") || "  (none)"}`;
}

test("valid: the real repository passes with zero errors", async () => {
  const { errors } = await runCheck(repoRoot);
  assert.deepEqual(errors, [], report(errors));
});

test("valid: an unmutated fixture copy passes with zero errors", async (t) => {
  const root = makeFixture(t);
  const { errors } = await runCheck(root);
  assert.deepEqual(errors, [], report(errors));
});

test("missing file: lifecycles.json removed", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => fs.rmSync(jsonPath));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.json}: missing`), report(errors));
});

test("missing file: lifecycles.md removed", async (t) => {
  const root = makeFixture(t, ({ mdPath }) => fs.rmSync(mdPath));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.md}: missing`), report(errors));
});

test("missing file: decisions.md removed", async (t) => {
  const root = makeFixture(t, ({ decisionsPath }) => fs.rmSync(decisionsPath));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.decisions}: missing`), report(errors));
});

test("malformed JSON: unparseable authority", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => fs.writeFileSync(jsonPath, "{ not valid json", "utf8"));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.json}: invalid JSON`), report(errors));
});

test("filesystem error: json path is a directory (unreadable, not missing)", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    fs.rmSync(jsonPath);
    fs.mkdirSync(jsonPath);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.json}: unreadable`), report(errors));
  assert.ok(!hasError(errors, `${REL.json}: missing`), report(errors));
});

test("missing required field: lifecycle 'job' loses 'allowed'", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    const j = readJson(jsonPath);
    delete j.lifecycles.job.allowed;
    writeJson(jsonPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `lifecycle "job" is missing required field "allowed"`), report(errors));
});

test("semantic mismatch: edge references an unknown state", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    const j = readJson(jsonPath);
    j.lifecycles.job.allowed.push({ from: "queued", to: "bogus" });
    writeJson(jsonPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `references unknown state "bogus"`), report(errors));
});

test("delete an allowed edge (JSON side): parity fails", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    const j = readJson(jsonPath);
    j.lifecycles.job.allowed = j.lifecycles.job.allowed.filter(
      (e) => !(e.from === "queued" && e.to === "running"),
    );
    writeJson(jsonPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `job edge queued->running is present in Markdown but not JSON`), report(errors));
});

test("add a terminal outgoing edge: terminal immutability fails", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    const j = readJson(jsonPath);
    j.lifecycles.job.allowed.push({ from: "succeeded", to: "running" });
    writeJson(jsonPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `job terminal state "succeeded" has an outgoing edge to "running"`), report(errors));
});

test("remove a guard: guarded reason no longer permitted", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    const j = readJson(jsonPath);
    delete j.lifecycles.job.guards.dead_letter;
    writeJson(jsonPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `but "dead_letter" is not a guarded target`), report(errors));
});

test("drift a Markdown table row: parity fails", async (t) => {
  const root = makeFixture(t, ({ mdPath }) => {
    const md = fs.readFileSync(mdPath, "utf8");
    const drifted = md.replace(
      "| `queued` | `running`, `cancel_requested`, `cancelled` |",
      "| `queued` | `running`, `cancelled` |",
    );
    assert.notEqual(drifted, md, "mutation did not change the Markdown");
    fs.writeFileSync(mdPath, drifted, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `job edge queued->cancel_requested is present in JSON but not Markdown`), report(errors));
});

test("forbidden-edge drift: removing a JSON forbidden edge fails Markdown parity", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    const j = readJson(jsonPath);
    j.forbiddenCrossLifecycleEdges = j.forbiddenCrossLifecycleEdges.filter(
      (e) => !(e.from === "attempt:running" && e.to === "serviceInstance:healthy"),
    );
    writeJson(jsonPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `forbidden edge attempt:running->serviceInstance:healthy is present in Markdown but not JSON`),
    report(errors),
  );
});

test("missing Decision #121 heading in decisions.md", async (t) => {
  const root = makeFixture(t, ({ decisionsPath }) => {
    const src = fs.readFileSync(decisionsPath, "utf8");
    const stripped = src.replace(
      "## Decision #121 — Cloud control plane uses a fenced outbound worker protocol with distinct batch, browser-session, and service lifecycles (2026-08-08)",
      "## Decision #121 — (heading removed by mutation test)",
    );
    assert.notEqual(stripped, src, "mutation did not change decisions.md");
    fs.writeFileSync(decisionsPath, stripped, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.decisions}: missing`), report(errors));
});

test("missing required Markdown heading: '## Worked journeys' removed", async (t) => {
  const root = makeFixture(t, ({ mdPath }) => {
    const md = fs.readFileSync(mdPath, "utf8");
    const stripped = md.replace("\n## Worked journeys\n", "\n## Worked adventures\n");
    assert.notEqual(stripped, md, "mutation did not change the Markdown heading");
    fs.writeFileSync(mdPath, stripped, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `missing heading "## Worked journeys"`), report(errors));
});

// --- FND-002: authority contract mutation corpus ----------------------------

/** Replace the first occurrence of `find` in a text fixture file, asserting it changed. */
function patchText(p, find, replace) {
  const src = fs.readFileSync(p, "utf8");
  const out = src.replace(find, replace);
  assert.notEqual(out, src, `mutation did not change ${path.basename(p)} (find not present)`);
  fs.writeFileSync(p, out, "utf8");
}

test("missing file: distributed-execution-authority.md removed", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => fs.rmSync(authorityPath));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.authority}: missing`), report(errors));
});

test("authority: Decision #121 loses the authority-doc back-reference", async (t) => {
  const root = makeFixture(t, ({ decisionsPath }) => {
    patchText(
      decisionsPath,
      "[`distributed-execution-authority.md`](distributed-execution-authority.md)",
      "[`the authority record`](removed-by-mutation.md)",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `${REL.decisions}: missing reference to "distributed-execution-authority.md"`),
    report(errors),
  );
});

test("authority mutation: a missing authority-matrix row fails", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(
      authorityPath,
      "| Source history | Customer-declared Git remote/repository | Stage declared base; return patch or commit metadata |\n",
      "",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `authority matrix is missing the required row for state "Source history"`),
    report(errors),
  );
});

test("authority mutation: a worker-database peer-replica claim fails", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    // Keep the negated invariant (so the requireFile fragment still passes) and
    // add an affirmative peer-replica claim — only the structured negation scan
    // catches this, proving it is not mere substring presence.
    patchText(
      authorityPath,
      "No AoA database is a peer replica. Desktop and cloud workers",
      "No AoA database is a peer replica. The worker SQLite database is a peer replica of the control plane. Desktop and cloud workers",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "peer-replica invariant"), report(errors));
  assert.ok(hasError(errors, "asserted without negation"), report(errors));
});

test("authority mutation: a dual-writer cutover enum fails", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(authorityPath, "ExecutionOwner = legacy | distributed", "ExecutionOwner = legacy & distributed");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `ExecutionOwner must be exactly "legacy | distributed"`), report(errors));
});

test("authority mutation: an ordinary stale commit to authoritative state fails", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(
      authorityPath,
      "Expired or replaced attempts cannot update authoritative state.",
      "Expired or replaced attempts may update authoritative state.",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "must not update authoritative state"), report(errors));
});

test("authority mutation: auto-promoted quarantine output fails", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(
      authorityPath,
      "It is never auto-applied or selected as the service recovery checkpoint.",
      "It is auto-applied or selected as the service recovery checkpoint.",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "must never be auto-applied"), report(errors));
});

// --- E0-F003: same-sentence negation smuggle + matrix reject-unknown ---------
// Item 1. The pre-fix scan tested each SENTENCE for any negation word, so an
// affirmative carve-out appended to an already-negated sentence was missed.
// This is the finding's verbatim probe.

test("E0-F003 item 1: an affirmative carve-out inside an already-negated sentence fails", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(
      authorityPath,
      "No AoA database is a peer replica. Desktop and cloud workers",
      "No AoA database is a peer replica except the worker SQLite which is a peer replica. Desktop and cloud workers",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "peer-replica invariant"), report(errors));
  assert.ok(hasError(errors, "asserted without negation"), report(errors));
});

// The punctuation boundary is a SEPARATE arm of the splitter from the
// contrastive-conjunction boundary, so it needs its own probe: this smuggle
// carries no "except"/"but", only a semicolon.
test("E0-F003 item 1: a semicolon-joined affirmative clause in a negated sentence fails", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(
      authorityPath,
      "Expired or replaced attempts cannot update authoritative state.",
      "Expired or replaced attempts cannot update authoritative state; a replayed attempt may update authoritative state.",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "must not update authoritative state"), report(errors));
  assert.ok(hasError(errors, "asserted without negation"), report(errors));
});

// The `except` probe above is ONE INSTANCE of the finding's general defect:
// "an affirmative clause appended to a sentence that already carries a
// negation is missed". The first fix for it closed that instance only —
// changing one word of the probe from `except` to `and` re-opened the smuggle
// at BOTH scanned invariants. These probes pin the general case.

test("E0-F003 item 1: an `and`-joined affirmative clause fails (peer-replica site)", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(
      authorityPath,
      "No AoA database is a peer replica. Desktop and cloud workers",
      "No AoA database is a peer replica and the worker SQLite is a peer replica. Desktop and cloud workers",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "peer-replica invariant"), report(errors));
});

// The same smuggle at the OTHER scanned invariant, on the real corpus sentence.
test("E0-F003 item 1: an `and`-joined affirmative clause fails (late-output site)", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(
      authorityPath,
      "Expired or replaced attempts cannot update authoritative state.",
      "Expired or replaced attempts cannot update authoritative state and a replayed attempt may update authoritative state.",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "must not update authoritative state"), report(errors));
});

// The vocabulary-free arm, and the reason the boundary list alone is not a fix.
// `whereupon` is on NO boundary list and carries NO punctuation, so the clause
// split leaves the smuggle inside a single clause that DOES contain "cannot".
// Only the per-mention negation budget rejects it: one negation, two mentions.
test("E0-F003 item 1: a smuggle joined by an UNLISTED conjunction fails on the negation budget", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(
      authorityPath,
      "Expired or replaced attempts cannot update authoritative state.",
      "Expired or replaced attempts cannot update authoritative state whereupon a replayed attempt may update authoritative state.",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "must not update authoritative state"), report(errors));
  assert.ok(hasError(errors, "covering 2 mentions"), report(errors));
});

// The weakest possible joiner: none at all, just a space. Nothing lexical marks
// the boundary, so this can only be caught by counting.
test("E0-F003 item 1: a smuggle joined by NO conjunction at all fails on the negation budget", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(
      authorityPath,
      "No AoA database is a peer replica. Desktop and cloud workers",
      "No AoA database is a peer replica the worker SQLite is a peer replica. Desktop and cloud workers",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "peer-replica invariant"), report(errors));
  assert.ok(hasError(errors, "covering 2 mentions"), report(errors));
});

// The boundary arm in isolation, at the authority site. This smuggle MEETS its
// negation budget — two mentions of "peer replica", two negations ("No",
// "not") — so counting alone cannot reject it. Only splitting on `and` exposes
// the trailing affirmative clause. This is the probe that pins the widening
// itself: with `and` off the boundary list the whole sentence is one clause,
// the budget is satisfied, and the smuggle ships.
test("E0-F003 item 1: an affirmative clause that MEETS the negation budget still fails on the clause split", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(
      authorityPath,
      "No AoA database is a peer replica. Desktop and cloud workers",
      "No AoA database is a peer replica and it is not authoritative and the worker SQLite is a peer replica. Desktop and cloud workers",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "peer-replica invariant"), report(errors));
  assert.ok(hasError(errors, "asserted without negation"), report(errors));
});

// Anti-over-fitting: the corpus as written must stay clean under both arms.
// The rationale the previous revision gave for excluding `and`/`or`/`while` was
// that splitting there "would reject correct prose". Measured on this corpus it
// rejects none. This test is what makes that a measurement rather than a claim.
test("E0-F003 item 1: the unmodified corpus is clean under clause split + negation budget", async (t) => {
  const root = makeFixture(t, () => {});
  const { errors } = await runCheck(root);
  assert.equal(
    errors.filter((e) => /asserted without negation|covering \d+ mentions/.test(e)).length,
    0,
    report(errors),
  );
});

// ★ KNOWN LIMIT, held here so it cannot be lost. Both arms count negation
// TOKENS inside a scope; neither binds a negation to the mention it has to
// negate. An appended affirmative clause that itself contains any word from the
// negation vocabulary therefore meets its own budget and passes — and it passes
// whatever the joiner is, INCLUDING the punctuation the pre-fix splitter
// already split on, so this class is orthogonal to the boundary set and cannot
// be reached by widening it.
//
// This test asserts the checker does NOT reject these. That is deliberate: it
// is the measurement the E0-F003 register entry cites, re-run on every commit,
// so the disclosed limit cannot silently drift into an assumed closure. If it
// goes RED, the class was closed — delete this test and amend the register and
// `scripts/finding-ownership.json` to match. Do not "fix" it by loosening the
// checker.
test("E0-F003 item 1 KNOWN LIMIT: a smuggle carrying its OWN negation token meets the budget and is not rejected", async (t) => {
  const cases = [
    [" whereupon ", "the worker SQLite is a peer replica that no operator may disable"],
    [" and ", "the worker SQLite is a peer replica that no operator may disable"],
    [", ", "the worker SQLite is a peer replica that no operator may disable"],
    ["; ", "the worker SQLite is a peer replica which cannot be turned off"],
  ];
  for (const [join, smuggle] of cases) {
    const root = makeFixture(t, ({ authorityPath }) => {
      patchText(
        authorityPath,
        "No AoA database is a peer replica. Desktop and cloud workers",
        `No AoA database is a peer replica${join}${smuggle}. Desktop and cloud workers`,
      );
    });
    const { errors } = await runCheck(root);
    assert.equal(
      errors.filter((e) => /peer-replica invariant/.test(e)).length,
      0,
      `joiner ${JSON.stringify(join)} unexpectedly rejected — see the KNOWN LIMIT note above: ${report(errors)}`,
    );
  }
});

// The same limit at the second scanned site, whose negation vocabulary is much
// wider (deny/reject/fail/zero/without/block/…), so the token a smuggle needs
// in order to meet its budget is correspondingly easier to write by accident.
test("E0-F003 item 1 KNOWN LIMIT: the CM-015 site has the same gap, and a wider vocabulary to satisfy", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    patchText(
      crosswalkPath,
      "and never silently auto-bypasses the gate.",
      "and never silently auto-bypasses the gate whereupon the operator override auto-bypasses the gate without delay.",
    );
  });
  const { errors } = await runCheck(root);
  assert.equal(errors.filter((e) => /auto-bypass/.test(e)).length, 0, report(errors));
});

// Item 2. The pre-fix matrix built a state->row Map and iterated only the
// EXPECTED rows, so an ADDED row was never read, and a DUPLICATE state placed
// BEFORE the authoritative row was laundered by last-write-wins.

test("E0-F003 item 2: an added contradictory authority-matrix row fails", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    patchText(
      authorityPath,
      "| Sandbox filesystem | Ephemeral cache | Never authoritative after lease loss or sandbox termination |",
      "| Sandbox filesystem | Ephemeral cache | Never authoritative after lease loss or sandbox termination |\n| Worker SQLite mirror | Encrypted worker SQLite | Authoritative for job and lease state |",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "unknown row"), report(errors));
});

test("E0-F003 item 2: a malformed authority-matrix row is rejected, not silently skipped", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    // Two cells, not three. The pre-fix collector skipped any row it could not
    // destructure, so an unparseable row vanished from the scan entirely.
    patchText(
      authorityPath,
      "| Sandbox filesystem | Ephemeral cache | Never authoritative after lease loss or sandbox termination |",
      "| Sandbox filesystem | Ephemeral cache | Never authoritative after lease loss or sandbox termination |\n| Worker SQLite mirror | Authoritative for job and lease state |",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "malformed row"), report(errors));
});

test("E0-F003 item 2: a duplicate authority-matrix row ordered before the real one fails", async (t) => {
  const root = makeFixture(t, ({ authorityPath }) => {
    // Last-write-wins on the state Map means this contradictory copy is
    // laundered by ORDER alone: the authoritative row overwrites it.
    patchText(
      authorityPath,
      "| Sandbox filesystem | Ephemeral cache | Never authoritative after lease loss or sandbox termination |",
      "| Sandbox filesystem | Worker-local disk | Authoritative until the operator deletes it |\n| Sandbox filesystem | Ephemeral cache | Never authoritative after lease loss or sandbox termination |",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "duplicate row"), report(errors));
});

// --- E0-F002 item 3: pin the previously unpinned checker branches ------------

test("unreachable state: a state with no incoming edge is flagged", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    const j = readJson(jsonPath);
    j.lifecycles.job.states.push("island");
    j.lifecycles.job.allowed.push({ from: "island", to: "succeeded" });
    writeJson(jsonPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `state "island" is unreachable`), report(errors));
});

test("non-terminal dead-end: a reachable state with no outgoing edge is flagged", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    const j = readJson(jsonPath);
    j.lifecycles.job.states.push("stuck");
    j.lifecycles.job.allowed.push({ from: "queued", to: "stuck" });
    writeJson(jsonPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `non-terminal state "stuck" has no outgoing edge`), report(errors));
});

test("forbidden self-lifecycle edge: same-lifecycle from/to is not cross-lifecycle", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    const j = readJson(jsonPath);
    j.forbiddenCrossLifecycleEdges.push({ from: "job:queued", to: "job:succeeded", reason: "test" });
    writeJson(jsonPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `forbidden edge job:queued->job:succeeded is not cross-lifecycle`), report(errors));
});

test("forbidden edge references an unknown lifecycle", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    const j = readJson(jsonPath);
    j.forbiddenCrossLifecycleEdges.push({ from: "attempt:running", to: "bogus:whatever", reason: "test" });
    writeJson(jsonPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `forbidden edge "bogus:whatever" references unknown lifecycle`), report(errors));
});

test("reason-only guard drift: Markdown guard reason differs from JSON", async (t) => {
  const root = makeFixture(t, ({ mdPath }) => {
    patchText(
      mdPath,
      "`dead_letter` (`policy_exhausted`) |",
      "`dead_letter` (`drifted_reason`) |",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `job edge running->dead_letter reason mismatch`), report(errors));
});

// --- E0-F002 item 2: malformed lifecycle referenced by a forbidden edge -------

test("forbidden edge into a malformed lifecycle pushes a clean error (no TypeError)", async (t) => {
  const root = makeFixture(t, ({ jsonPath }) => {
    const j = readJson(jsonPath);
    // `serviceInstance` is referenced by forbidden edges; drop its state set so
    // the forbidden-edge check would `.includes` on undefined without the guard.
    delete j.lifecycles.serviceInstance.states;
    writeJson(jsonPath, j);
  });
  // runCheck must return a structured error rather than throwing.
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `forbidden edge "serviceInstance:healthy" references lifecycle "serviceInstance" with a missing or malformed state set`),
    report(errors),
  );
});

// --- FND-003: threat model + control ownership mutation corpus ----------------

// E0-F004: `threat`/`control`/`verification` are now required too, so their
// field-deletion mutations are exercised by the loop below (all 30 crossings
// carry them, so the valid corpus stays green).
const THREAT_REQUIRED_FIELDS = [
  "id",
  "threat",
  "trustedSide",
  "lessTrustedSide",
  "authentication",
  "authorization",
  "confidentiality",
  "integrity",
  "revocation",
  "audit",
  "failureMode",
  "severity",
  "control",
  "verification",
  "ownerTickets",
  "verificationLane",
  // W4U2: the delivery-status field. Included here so the deletion loop below proves
  // it is required on a crossing OTHER than DE-08 too (crossings[0] is DE-01).
  "deliveryStatus",
];

test("missing file: distributed-execution-threat-model.md removed", async (t) => {
  const root = makeFixture(t, ({ threatModelPath }) => fs.rmSync(threatModelPath));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.threatModel}: missing`), report(errors));
});

test("missing file: distributed-execution-threat-controls.json removed", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => fs.rmSync(threatControlsPath));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.threatControls}: missing`), report(errors));
});

test("threat model: Decision #121 loses the threat-model back-reference", async (t) => {
  const root = makeFixture(t, ({ decisionsPath }) => {
    patchText(
      decisionsPath,
      "[`distributed-execution-threat-model.md`](distributed-execution-threat-model.md)",
      "[`the threat model`](removed-by-mutation.md)",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `${REL.decisions}: missing reference to "distributed-execution-threat-model.md"`),
    report(errors),
  );
});

// Remove each required field in turn: every one must be independently enforced.
for (const field of THREAT_REQUIRED_FIELDS) {
  test(`threat crossing: removing required field "${field}" fails`, async (t) => {
    const root = makeFixture(t, ({ threatControlsPath }) => {
      const j = readJson(threatControlsPath);
      delete j.crossings[0][field];
      writeJson(threatControlsPath, j);
    });
    const { errors } = await runCheck(root);
    assert.ok(hasError(errors, `is missing required field "${field}"`), report(errors));
  });
}

test("threat crossing: a non-empty required field emptied fails", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    const j = readJson(threatControlsPath);
    j.crossings[0].authentication = "   ";
    writeJson(threatControlsPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `field "authentication" must be a non-empty string`), report(errors));
});

test("threat crossing: a duplicate crossing id fails", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    const j = readJson(threatControlsPath);
    j.crossings[1].id = j.crossings[0].id; // both become "DE-01"
    writeJson(threatControlsPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `duplicate crossing id "DE-01"`), report(errors));
});

test("threat crossing: an invented owner ticket (not in program-design) fails", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    const j = readJson(threatControlsPath);
    j.crossings[0].ownerTickets = ["ZZZ-999"];
    writeJson(threatControlsPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `references unknown owner ticket "ZZZ-999" (not defined in ${REL.programDesign})`),
    report(errors),
  );
});

test("threat crossing: an empty ownerTickets array fails", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    const j = readJson(threatControlsPath);
    j.crossings[0].ownerTickets = [];
    writeJson(threatControlsPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `must have a non-empty "ownerTickets" array`), report(errors));
});

test("threat crossing: an unknown severity value fails", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    const j = readJson(threatControlsPath);
    j.crossings[0].severity = "Catastrophic";
    writeJson(threatControlsPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `has unknown severity "Catastrophic"`), report(errors));
});

test("threat crossing: an unknown verificationLane value fails", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    const j = readJson(threatControlsPath);
    j.crossings[0].verificationLane = "D9";
    writeJson(threatControlsPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `has unknown verificationLane "D9"`), report(errors));
});

test("threat crossing: removing a Critical/High release test fails", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    const j = readJson(threatControlsPath);
    // DE-14 is Critical with owner FND-005 only; its release test is the
    // releaseTest field. Removing it leaves no REL-* owner and no releaseTest.
    const de14 = j.crossings.find((c) => c.id === "DE-14");
    assert.ok(de14, "fixture must contain DE-14");
    delete de14.releaseTest;
    writeJson(threatControlsPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `crossing DE-14 is Critical but names no REL release-test ticket`),
    report(errors),
  );
});

// --- REL-FOUNDATION-GATE (S9 unit 1): trackable-strict release-test gate ------
//
// The bare-string acceptance at crossingHasReleaseTest let a Critical/High crossing
// satisfy the E0 release-test contract by NAMING a REL ticket that was never written.
// These cases prove the strict gate: every named REL ticket must EXIST on disk
// (docs/replatform/epics/E11-hardening-release/tickets/<id>-design.md) OR be declared,
// with a reason, in docs/architecture/distributed-execution-release-tests.json.
// Each guard is mutation-killed by DELETION — see the ticket's §8 mutation table.

test("release-gate: a Critical crossing naming only an unwritten, undeclared REL ticket is refused (positive control / M0)", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath, releaseTestsPath }) => {
    const j = readJson(threatControlsPath);
    // DE-14 is Critical with a non-REL owner (FND-005). Point its releaseTest at
    // REL-001 only, then REMOVE REL-001's deferral so it is neither on disk nor declared.
    const de14 = j.crossings.find((c) => c.id === "DE-14");
    assert.ok(de14, "fixture must contain DE-14");
    de14.releaseTest = "REL-001 adversarial gate";
    writeJson(threatControlsPath, j);
    const m = readJson(releaseTestsPath);
    delete m.deferred["REL-001"];
    writeJson(releaseTestsPath, m);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "names release-test ticket REL-001 which neither exists on disk"),
    report(errors),
  );
});

test("release-gate: removing a deferral reds every crossing naming that unwritten ticket (M2 — the hard-red state option (b) would ship)", async (t) => {
  const root = makeFixture(t, ({ releaseTestsPath }) => {
    const m = readJson(releaseTestsPath);
    // REL-001 is named by 14 Critical/High crossings at tip (design C2). Removing
    // its deferral is exactly option (b)'s hard-red state for those crossings.
    delete m.deferred["REL-001"];
    writeJson(releaseTestsPath, m);
  });
  const { errors } = await runCheck(root);
  // Assert on the substring, not a fragile exact count (the crossing set can grow).
  const reds = errors.filter((e) =>
    e.includes("names release-test ticket REL-001 which neither exists on disk"),
  );
  assert.ok(reds.length >= 1, report(errors));
});

test("release-gate: a Critical crossing whose releaseTest names no REL ticket is refused (M3 — closes the arbitrary-string loophole)", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    const j = readJson(threatControlsPath);
    // DE-14 is Critical with a non-REL owner (FND-005); a non-empty string that
    // names no REL ticket must NOT satisfy the release-test contract.
    const de14 = j.crossings.find((c) => c.id === "DE-14");
    assert.ok(de14, "fixture must contain DE-14");
    de14.releaseTest = "manual smoke";
    writeJson(threatControlsPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "crossing DE-14 is Critical but names no REL release-test ticket"),
    report(errors),
  );
});

test("release-gate: EVERY named REL ticket is checked — a bogus REL-999 alongside a real one is refused", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    const j = readJson(threatControlsPath);
    const de14 = j.crossings.find((c) => c.id === "DE-14");
    assert.ok(de14, "fixture must contain DE-14");
    // REL-001 is deferred (admissible); REL-999 is backed by nothing.
    de14.releaseTest = "REL-001 gate plus REL-999 phantom";
    writeJson(threatControlsPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "names release-test ticket REL-999 which neither exists on disk"),
    report(errors),
  );
  // The real, deferred REL-001 is still admitted — only REL-999 is flagged.
  assert.ok(
    !hasError(errors, "names release-test ticket REL-001 which neither exists"),
    report(errors),
  );
});

test("release-gate: a deferral for a now-written ticket is refused — self-cleaning (M4)", async (t) => {
  const root = makeFixture(t, ({ releaseTestsPath }) => {
    const m = readJson(releaseTestsPath);
    // REL-004 has a design doc on disk, so declaring it deferred is stale.
    m.deferred["REL-004"] = { reason: "should not be here — REL-004 is written" };
    writeJson(releaseTestsPath, m);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "deferral REL-004 is stale"), report(errors));
});

test("release-gate: a deferral without a reason is refused (M5)", async (t) => {
  const root = makeFixture(t, ({ releaseTestsPath }) => {
    const m = readJson(releaseTestsPath);
    m.deferred["REL-001"] = {}; // no reason
    writeJson(releaseTestsPath, m);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `deferral REL-001 must be an object with a non-empty "reason"`),
    report(errors),
  );
});

test("release-gate: a deferral named by no crossing is refused (M6 — no ghost deferrals)", async (t) => {
  const root = makeFixture(t, ({ releaseTestsPath }) => {
    const m = readJson(releaseTestsPath);
    m.deferred["REL-777"] = { reason: "a ghost ticket no crossing names" };
    writeJson(releaseTestsPath, m);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "deferral REL-777 is named by no Critical/High crossing"),
    report(errors),
  );
});

test("release-gate: an absent manifest fails closed, not open (M7)", async (t) => {
  const root = makeFixture(t, ({ releaseTestsPath }) => fs.rmSync(releaseTestsPath));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.releaseTests}: missing`), report(errors));
});

test("release-gate: an absent E11 tickets dir fails closed (existence source missing)", async (t) => {
  const root = makeFixture(t, ({ relTicketsDir }) =>
    fs.rmSync(relTicketsDir, { recursive: true, force: true }),
  );
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.relTicketsDir}: missing`), report(errors));
});

test("release-gate: existence keys on the DESIGN doc, resolved against the fixture root (M8 + C4 root-relative)", async (t) => {
  const root = makeFixture(t, ({ relTicketsDir, threatControlsPath }) => {
    // A REL-006 design doc exists ONLY in this fixture (no result doc; absent from
    // the real tree). If the checker keyed on the result doc, or read the real tree
    // via a cwd-relative readdir, REL-006 would not be seen and the crossing would red.
    fs.writeFileSync(path.join(relTicketsDir, "REL-006-design.md"), "# REL-006 design\n");
    const j = readJson(threatControlsPath);
    const de14 = j.crossings.find((c) => c.id === "DE-14"); // Critical, non-REL owner
    assert.ok(de14, "fixture must contain DE-14");
    de14.releaseTest = "REL-006 fixture-only gate";
    writeJson(threatControlsPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    !hasError(errors, "names release-test ticket REL-006 which neither exists on disk"),
    report(errors),
  );
});

test("release-gate: a manifest that is not valid JSON is refused", async (t) => {
  const root = makeFixture(t, ({ releaseTestsPath }) =>
    fs.writeFileSync(releaseTestsPath, "{ not json", "utf8"),
  );
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.releaseTests}: invalid JSON`), report(errors));
});

test("release-gate: a manifest with a non-numeric version is refused", async (t) => {
  const root = makeFixture(t, ({ releaseTestsPath }) => {
    const m = readJson(releaseTestsPath);
    m.version = "1";
    writeJson(releaseTestsPath, m);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.releaseTests}: missing numeric "version"`), report(errors));
});

test("release-gate: a manifest whose `deferred` is not an object is refused", async (t) => {
  const root = makeFixture(t, ({ releaseTestsPath }) => {
    const m = readJson(releaseTestsPath);
    m.deferred = [];
    writeJson(releaseTestsPath, m);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.releaseTests}: missing object "deferred"`), report(errors));
});

test("threat parity: a JSON crossing id omitted from the Markdown register fails", async (t) => {
  const root = makeFixture(t, ({ threatModelPath }) => {
    const md = fs.readFileSync(threatModelPath, "utf8");
    // Drop the entire DE-30 register row from the Markdown render.
    const stripped = md.replace(/\n\| DE-30 \|[^\n]*\|/, "");
    assert.notEqual(stripped, md, "mutation did not remove the DE-30 register row");
    fs.writeFileSync(threatModelPath, stripped, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `crossing id "DE-30" is present in JSON but not the Markdown register`),
    report(errors),
  );
});

test("threat parity: a drifted Markdown severity fails per-ID parity", async (t) => {
  const root = makeFixture(t, ({ threatModelPath }) => {
    patchText(
      threatModelPath,
      "| DE-01 | Cross-tenant database access | Critical |",
      "| DE-01 | Cross-tenant database access | High |",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `register severity for "DE-01" is "High" but JSON is "Critical"`),
    report(errors),
  );
});

test("threat parity: an extra Markdown register id absent from JSON fails", async (t) => {
  const root = makeFixture(t, ({ threatModelPath }) => {
    const md = fs.readFileSync(threatModelPath, "utf8");
    const injected = md.replace(
      "| DE-30 | Malicious capability claim |",
      "| DE-99 | Fabricated crossing | Critical | none | none | REL-001 |\n| DE-30 | Malicious capability claim |",
    );
    assert.notEqual(injected, md, "mutation did not inject a DE-99 register row");
    fs.writeFileSync(threatModelPath, injected, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `register id "DE-99" is present in the Markdown register but not JSON`),
    report(errors),
  );
});

// --- FND-004: golden-journey + failure fixture mutation corpus ----------------

function fixtureFile(root, name) {
  return path.join(root, GJ_DIR, name);
}
function readFixture(root, name) {
  return JSON.parse(fs.readFileSync(fixtureFile(root, name), "utf8"));
}
function writeFixture(root, name, obj) {
  fs.writeFileSync(fixtureFile(root, name), JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function schemaFile(root) {
  return path.join(root, GJ_DIR, "schema-v1.json");
}
function readSchema(root) {
  return JSON.parse(fs.readFileSync(schemaFile(root), "utf8"));
}
function writeSchema(root, obj) {
  fs.writeFileSync(schemaFile(root), JSON.stringify(obj, null, 2) + "\n", "utf8");
}
// A different-but-valid 26-char ULID body (Crockford base32, no I/L/O/U).
const ULID26 = "0123456789ABCDEFGHJKMNPQRS";

test("valid: the fixture corpus passes with zero errors (real repo)", async () => {
  const { errors } = await runCheck(repoRoot);
  assert.deepEqual(errors, [], report(errors));
});

// (1) The eventDigest binds every one of the 14 immutable event fields: changing
// any single field without recomputing the digest is detected.
const EVENT_FIELD_MUTATIONS = {
  protocolVersion: 2,
  eventId: ULID26,
  eventType: "changed_type",
  organizationId: `org_${ULID26}`,
  companyId: `company_${ULID26}`,
  workerId: `worker_${ULID26}`,
  jobId: `job_${ULID26}`,
  attempt: 7,
  leaseId: `lease_${ULID26}`,
  fenceToken: 555,
  seq: 99,
  occurredAt: "2027-01-01T00:00:00.000Z",
  payload: { detail: "changed-payload" },
  eventDigest: "0".repeat(64),
};
for (const [field, newVal] of Object.entries(EVENT_FIELD_MUTATIONS)) {
  test(`fixture event: mutating "${field}" without re-digesting is rejected`, async (t) => {
    const root = makeFixture(t, ({ root: r }) => {
      const fx = readFixture(r, "batch-success.json");
      fx.expectedEvents[0][field] = newVal;
      writeFixture(r, "batch-success.json", fx);
    });
    const { errors } = await runCheck(root);
    assert.ok(hasError(errors, "batch-success.json: event[0] eventDigest mismatch"), report(errors));
  });
}

test("fixture event: reusing another event's digest fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.expectedEvents[1].eventDigest = fx.expectedEvents[0].eventDigest;
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "batch-success.json: event[1] eventDigest mismatch"), report(errors));
});

test("fixture event: a bad eventId format fails the schema pattern", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.expectedEvents[0].eventId = "not-a-valid-ulid";
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "/expectedEvents/0/eventId does not match pattern"), report(errors));
});

test("fixture event: a duplicate eventId across events fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.expectedEvents[1].eventId = fx.expectedEvents[0].eventId;
    // Re-digest event[1] so ONLY the duplicate-id rule (not the digest) fires.
    delete fx.expectedEvents[1].eventDigest;
    fx.expectedEvents[1].eventDigest = computeEventDigest(fx.expectedEvents[1]);
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "batch-success.json: duplicate eventId"), report(errors));
});

test("fixture event: a foreign leaseId not in identity.attempts fails referential consistency", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.expectedEvents[0].leaseId = `lease_${ULID26}`;
    delete fx.expectedEvents[0].eventDigest;
    fx.expectedEvents[0].eventDigest = computeEventDigest(fx.expectedEvents[0]);
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "does not match any declared identity attempt"), report(errors));
});

test("fixture event: a cross-tenant organizationId fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.expectedEvents[0].organizationId = `org_${ULID26}`;
    delete fx.expectedEvents[0].eventDigest;
    fx.expectedEvents[0].eventDigest = computeEventDigest(fx.expectedEvents[0]);
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "event[0] organizationId"), report(errors));
  assert.ok(hasError(errors, "does not match organization.id"), report(errors));
});

test("fixture event: an unsafe integer fenceToken is not canonicalizable", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.expectedEvents[0].fenceToken = 9007199254740992; // 2^53, not a safe integer
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "batch-success.json: event[0] is not canonicalizable"), report(errors));
});

test("fixture event: a float attempt is not canonicalizable", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.expectedEvents[0].attempt = 1.5;
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "batch-success.json: event[0] is not canonicalizable"), report(errors));
});

test("fixture event: a lone surrogate in a payload string is not canonicalizable", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.expectedEvents[1].payload = { detail: "\uD800" };
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "batch-success.json: event[1] is not canonicalizable"), report(errors));
});

test("fixture: duplicate semantic keys inside an event are rejected at parse", async (t) => {
  const root = makeFixture(t, ({ fixturePath }) => {
    const p = fixturePath("batch-success.json");
    const src = fs.readFileSync(p, "utf8");
    const out = src.replace('"seq": 1,', '"seq": 1,\n      "seq": 1,');
    assert.notEqual(out, src, "mutation did not inject a duplicate key");
    fs.writeFileSync(p, out, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "duplicate object key"), report(errors));
});

test("fixture: an extra top-level property fails the closed schema", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.unexpectedField = true;
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "/unexpectedField is not an allowed property"), report(errors));
});

test("fixture: schemaVersion other than 1 fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.schemaVersion = 2;
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "batch-success.json: schemaVersion must be 1"), report(errors));
});

test("fixture: id not matching the filename fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.id = "batch-different";
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "batch-success.json: id must match filename"), report(errors));
});

test("fixture: an invalid workloadType fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.workloadType = "gpu";
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "batch-success.json: invalid workloadType"), report(errors));
});

test("fixture: empty steps fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.steps = [];
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "batch-success.json: steps must be non-empty"), report(errors));
});

test("fixture: a terminalState outside the allowed set fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.expected.terminalState = "annihilated";
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "is not an allowed terminal state"), report(errors));
});

test("fixture: empty auditActions fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.expected.auditActions = [];
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "batch-success.json: expected.auditActions must be non-empty"), report(errors));
});

test("fixture: empty forbiddenEffects fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.expected.forbiddenEffects = [];
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "batch-success.json: expected.forbiddenEffects must be non-empty"), report(errors));
});

test("fixture: a company that belongs to a different organization fails cross-tenant consistency", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.company.organizationId = `org_${ULID26}`;
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "does not match organization.id"), report(errors));
});

test("fixture: observed cost above the cap fails the usage bound", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.cost.observedTotalCents = fx.cost.maxTotalCents + 1;
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "cost.observedTotalCents exceeds maxTotalCents"), report(errors));
});

test("fixture: startedAt after finishedAt fails the timing bound", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.timing.startedAt = "2027-01-01T00:00:00.000Z";
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "timing.startedAt is after finishedAt"), report(errors));
});

test("fixture: a task_run source missing runId fails the discriminant", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    delete fx.source.runId;
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "/source/runId is required"), report(errors));
});

test("fixture: a non-task_run source carrying runId fails the discriminant", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "browser-approval-download.json");
    fx.source.runId = `run_${ULID26}`;
    writeFixture(r, "browser-approval-download.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "/source must not match the forbidden subschema"), report(errors));
});

test("fixture: a duplicate leaseId across identity attempts fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "service-restart-checkpoint.json");
    fx.identity.attempts[1].leaseId = fx.identity.attempts[0].leaseId;
    writeFixture(r, "service-restart-checkpoint.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "identity.attempts has a duplicate leaseId"), report(errors));
});

test("fixture: a non-monotonic fenceToken across attempts fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "service-restart-checkpoint.json");
    fx.identity.attempts[1].fenceToken = 50; // < attempt 1's 100
    writeFixture(r, "service-restart-checkpoint.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "identity.attempts fenceToken must strictly increase"), report(errors));
});

test("fixture: a registered canary token leaking outside its declaration fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "plaintext-secret-in-argv-rejected.json");
    // Place the secret where it does not affect any event digest, so ONLY the
    // canary-leakage rule fires.
    fx.requester.displayName = `Runner Agent ${fx.canaries[0].token}`;
    writeFixture(r, "plaintext-secret-in-argv-rejected.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "appears 2 time(s)"), report(errors));
});

test("fixture: a missing fixture file is named", async (t) => {
  const root = makeFixture(t, ({ fixturePath }) => {
    fs.rmSync(fixturePath("batch-success.json"));
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${GJ_DIR}/batch-success.json: missing`), report(errors));
});

// --- Schema meta-validator mutations -----------------------------------------

test("schema: an unknown/custom keyword fails E0", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const src = fs.readFileSync(schemaFile(r), "utf8");
    const out = src.replace('"type": "object",', '"type": "object",\n  "bogusKeyword": true,');
    assert.notEqual(out, src, "mutation did not inject a custom keyword");
    fs.writeFileSync(schemaFile(r), out, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, 'unknown/custom schema keyword "bogusKeyword"'), report(errors));
});

test("schema: a non-closed object (missing additionalProperties:false) fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const src = fs.readFileSync(schemaFile(r), "utf8");
    // Remove the FIRST additionalProperties:false (the root object schema).
    const out = src.replace('  "additionalProperties": false,\n', "");
    assert.notEqual(out, src, "mutation did not remove additionalProperties:false");
    fs.writeFileSync(schemaFile(r), out, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "object schema at # must set additionalProperties:false"), report(errors));
});

test("schema: a malformed $comment form fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const src = fs.readFileSync(schemaFile(r), "utf8");
    const out = src.replace('"aoa:utf8-max-bytes=480"', '"aoa:utf8-max-bytes=zero"');
    assert.notEqual(out, src, "mutation did not corrupt a $comment");
    fs.writeFileSync(schemaFile(r), out, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, 'aoa:utf8-max-bytes=<positive integer>'), report(errors));
});

test("schema: a missing required $def fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const schema = readSchema(r);
    delete schema.$defs.Event;
    writeSchema(r, schema);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, 'missing required $def "Event"'), report(errors));
});

// --- Canonicalizer / digest unit contract (imported directly) ----------------

test("canonicalizer: identical objects in different key order produce identical bytes", () => {
  const a = { b: 1, a: 2, nested: { y: [3, 2, 1], x: true } };
  const b = { nested: { x: true, y: [3, 2, 1] }, a: 2, b: 1 };
  assert.equal(canonicalizeJson(a), canonicalizeJson(b));
  assert.equal(canonicalizeJson(a), '{"a":2,"b":1,"nested":{"x":true,"y":[3,2,1]}}');
});

test("canonicalizer: keys sort by UTF-16 code units (uppercase before lowercase)", () => {
  assert.equal(canonicalizeJson({ b: 1, A: 2, a: 3 }), '{"A":2,"a":3,"b":1}');
});

test("canonicalizer: control characters escape per RFC 8785", () => {
  assert.equal(canonicalizeJson("a\tb\nc"), '"a\\tb\\nc"');
});

test("canonicalizer: rejects floats", () => {
  assert.throws(() => canonicalizeJson(1.5), /float is not allowed/);
});

test("canonicalizer: rejects unsafe integers", () => {
  assert.throws(() => canonicalizeJson(9007199254740992), /unsafe integer/);
});

test("canonicalizer: rejects lone surrogates", () => {
  assert.throws(() => canonicalizeJson("\uD800"), /lone (high|low) surrogate/);
});

test("canonicalizer: rejects unsupported values", () => {
  assert.throws(() => canonicalizeJson(undefined), /unsupported value/);
  assert.throws(() => canonicalizeJson(10n), /unsupported value/);
});

test("canonicalizer: -0 normalizes to 0", () => {
  assert.equal(canonicalizeJson(-0), "0");
  assert.equal(canonicalizeJson(0), "0");
});

test("digest: eventDigest is excluded from the digest input", () => {
  const ev = {
    protocolVersion: 1, eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", eventType: "x",
    organizationId: "org", companyId: "co", workerId: null, jobId: "j",
    attempt: 1, leaseId: null, fenceToken: null, seq: 1, occurredAt: "t",
    payload: {}, eventDigest: "",
  };
  const d = computeEventDigest(ev);
  assert.equal(computeEventDigest({ ...ev, eventDigest: "different" }), d);
  assert.notEqual(computeEventDigest({ ...ev, seq: 2 }), d);
});

test("parseJsonStrict: rejects duplicate object keys", () => {
  assert.throws(() => parseJsonStrict('{"a":1,"a":2}'), /duplicate object key/);
  assert.deepEqual(parseJsonStrict('{"a":1,"b":2}'), { a: 1, b: 2 });
});

// --- FND-005: source-boundary + delivery-policy + evidence-integrity corpus ---

test("app source-boundary: forbidden import of a reserved distributed module fails", async (t) => {
  const root = makeFixture(t, ({ appPath }) => {
    const src = fs.readFileSync(appPath, "utf8");
    const out = `import { publicIngress } from "./services/distributed-execution-public-ingress.js";\n${src}`;
    fs.writeFileSync(appPath, out, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "forbidden import of a reserved distributed module"),
    report(errors),
  );
});

test("app source-boundary: registering a reserved distributed path prefix fails", async (t) => {
  const root = makeFixture(t, ({ appPath }) => {
    const src = fs.readFileSync(appPath, "utf8");
    const out = `${src}\napi.use("/distributed-execution/public-services", (_req, res) => res.end());\n`;
    fs.writeFileSync(appPath, out, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "forbidden registration of a reserved distributed path"),
    report(errors),
  );
});

test("app source-boundary: a cloud-plugins reserved registration fails", async (t) => {
  const root = makeFixture(t, ({ appPath }) => {
    const src = fs.readFileSync(appPath, "utf8");
    const out = `${src}\napi.use("/api/distributed-execution/cloud-plugins", (_req, res) => res.end());\n`;
    fs.writeFileSync(appPath, out, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "cloud-plugins"), report(errors));
});

test("missing file: app.ts removed", async (t) => {
  const root = makeFixture(t, ({ appPath }) => fs.rmSync(appPath));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.app}: missing`), report(errors));
});

// --- FND-006: hosted plugin process-composition boundary mutation corpus ------

test("FND-006: restoring the cloud worker-sink allowlist fails", async (t) => {
  const root = makeFixture(t, ({ cloudPluginExecutionPath }) => {
    const src = fs.readFileSync(cloudPluginExecutionPath, "utf8");
    const out = `const CLOUD_SAFE_CONTROL_PLANE_SINKS = new Set(["worker-fork", "worker-manager", "lifecycle", "loader"]);\n${src}`;
    fs.writeFileSync(cloudPluginExecutionPath, out, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "CLOUD_SAFE_CONTROL_PLANE_SINKS"), report(errors));
});

test("FND-006: a parent-marker bypass in the cloud gate fails", async (t) => {
  const root = makeFixture(t, ({ cloudPluginExecutionPath }) => {
    patchText(
      cloudPluginExecutionPath,
      "return tenantIsolationEnforced();",
      'if (process.env.AOA_PLUGIN_WORKER_PROCESS === "1") return false;\n  return tenantIsolationEnforced();',
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "must not consult the worker-child marker"),
    report(errors),
  );
});

test("FND-006: a sink-specific return-false escape in the cloud gate fails", async (t) => {
  const root = makeFixture(t, ({ cloudPluginExecutionPath }) => {
    patchText(
      cloudPluginExecutionPath,
      "return tenantIsolationEnforced();",
      'if (_sink === "loader") return false;\n  return tenantIsolationEnforced();',
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "must fail closed uniformly"), report(errors));
});

test("FND-006: a sink allowlist via set membership in the cloud gate fails", async (t) => {
  const root = makeFixture(t, ({ cloudPluginExecutionPath }) => {
    patchText(
      cloudPluginExecutionPath,
      "return tenantIsolationEnforced();",
      'if (new Set(["loader"]).has(_sink)) { /* allow */ }\n  return tenantIsolationEnforced();',
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "must not allowlist any sink via set membership"),
    report(errors),
  );
});

test("FND-006: removing the app.ts process-disable guard definition fails", async (t) => {
  const root = makeFixture(t, ({ appPath }) => {
    patchText(
      appPath,
      "const hostedPluginProcessDisabled = tenantIsolationEnforced();",
      "const hostedPluginProcessDisabled = false;",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "missing the cloud plugin process-disable guard"),
    report(errors),
  );
});

test("FND-006: an unguarded worker-manager construction in app.ts fails", async (t) => {
  const root = makeFixture(t, ({ appPath }) => {
    patchText(
      appPath,
      "const hostedPluginProcessDisabled = tenantIsolationEnforced();",
      "const __leak = createPluginWorkerManager({});\n  const hostedPluginProcessDisabled = tenantIsolationEnforced();",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "unguarded plugin createPluginWorkerManager construction"),
    report(errors),
  );
});

test("FND-006: missing cloud-plugin-execution.ts is named", async (t) => {
  const root = makeFixture(t, ({ cloudPluginExecutionPath }) =>
    fs.rmSync(cloudPluginExecutionPath),
  );
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.cloudPluginExecution}: missing`), report(errors));
});

// --- FND-008: cloud plugin runtime + browser-surface denial mutation corpus ---

test("FND-008: drifting the Decision #103 docs path fails", async (t) => {
  const root = makeFixture(t, ({ cloudPluginExecutionPath }) => {
    patchText(
      cloudPluginExecutionPath,
      '"/docs/guides/cloud-plugin-execution"',
      '"/docs/guides/plugins-in-cloud"',
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "stable Decision #103 docs path"),
    report(errors),
  );
});

test("FND-008: dropping a field from the 503 envelope fails", async (t) => {
  const root = makeFixture(t, ({ cloudPluginExecutionPath }) => {
    patchText(
      cloudPluginExecutionPath,
      "docs: CLOUD_PLUGIN_EXECUTION_DOC_PATH,",
      "",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'cloudPluginExecutionBlockedEnvelope() must return "docs:"'),
    report(errors),
  );
});

test("FND-008: removing the MCP broker cloud denial fails", async (t) => {
  const root = makeFixture(t, ({ pluginBrokerToolsPath }) => {
    patchText(
      pluginBrokerToolsPath,
      "if (isCloudPluginExecutionBlocked()) {",
      "if (false) {",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "dispatchPluginToolCall must fail closed"),
    report(errors),
  );
});

test("FND-008: removing the ui-static browser-code cloud gate fails", async (t) => {
  const root = makeFixture(t, ({ pluginUiStaticPath }) => {
    patchText(
      pluginUiStaticPath,
      'isCloudPluginExecutionBlocked("ui-static")',
      "false",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'browser-code cloud gate isCloudPluginExecutionBlocked("ui-static")'),
    report(errors),
  );
});

test("FND-008: dropping a cloud-denial facade export from plugins.ts fails", async (t) => {
  const root = makeFixture(t, ({ pluginsRoutesPath }) => {
    patchText(
      pluginsRoutesPath,
      "export function buildCloudPluginDenialLifecycle",
      "function buildCloudPluginDenialLifecycle",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "missing the cloud-denial facade export buildCloudPluginDenialLifecycle"),
    report(errors),
  );
});

test("FND-008: unmounting the plugin routers in cloud (removing the denial mount) fails", async (t) => {
  const root = makeFixture(t, ({ appPath }) => {
    patchText(
      appPath,
      "const cloudDenialLoader = buildCloudPluginDenialLoader();",
      "const cloudDenialLoader = undefined;",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "must MOUNT the plugin routers as registered 503 denial stubs"),
    report(errors),
  );
});

test("FND-008: restoring a cloud background plugin starter (2nd __pluginSubsystem) fails", async (t) => {
  const root = makeFixture(t, ({ appPath }) => {
    patchText(
      appPath,
      "const cloudDenialLoader = buildCloudPluginDenialLoader();",
      "(app).__pluginSubsystem = {};\n    const cloudDenialLoader = buildCloudPluginDenialLoader();",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "__pluginSubsystem must be assigned exactly once"),
    report(errors),
  );
});

test("delivery policy: missing file fails", async (t) => {
  const root = makeFixture(t, ({ deliveryPolicyPath }) => fs.rmSync(deliveryPolicyPath));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.deliveryPolicy}: missing`), report(errors));
});

test("delivery policy: dropping a required custodian role fails", async (t) => {
  const root = makeFixture(t, ({ deliveryPolicyPath }) => {
    const src = fs.readFileSync(deliveryPolicyPath, "utf8");
    const out = src.split("Protocol Custodian").join("Protocol Steward");
    assert.notEqual(out, src, "mutation did not change the delivery policy");
    fs.writeFileSync(deliveryPolicyPath, out, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `missing required fragment "Protocol Custodian"`), report(errors));
});

test("decisions: Decision #121 loses the delivery-policy back-reference", async (t) => {
  const root = makeFixture(t, ({ decisionsPath }) => {
    patchText(
      decisionsPath,
      "[`distributed-execution-delivery-policy.md`](distributed-execution-delivery-policy.md)",
      "[`the delivery policy`](removed-by-mutation.md)",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `missing reference to "distributed-execution-delivery-policy.md"`),
    report(errors),
  );
});

test("artifact policy: dropping the immutable-from-first-commit rule fails", async (t) => {
  const root = makeFixture(t, ({ artifactPolicyPath }) => {
    patchText(artifactPolicyPath, "immutable from first commit", "editable after first commit");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `missing required fragment "immutable from first commit"`), report(errors));
});

test("ticket template: re-backticking the bare Start SHA example fails (E0-F001 guard)", async (t) => {
  const root = makeFixture(t, ({ ticketTemplatePath }) => {
    patchText(
      ticketTemplatePath,
      "**Start SHA:** 0000000000000000000000000000000000000000",
      "**Start SHA:** `0000000000000000000000000000000000000000`",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "Start SHA example must be a bare 40-lowercase-hex placeholder"), report(errors));
});

test("qa template: dropping the D4/D6 schedule-manifest hash field fails", async (t) => {
  const root = makeFixture(t, ({ qaTemplatePath }) => {
    patchText(qaTemplatePath, "Schedule manifest SHA-256", "Schedule manifest checksum");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `missing required fragment "Schedule manifest SHA-256"`), report(errors));
});

test("handoff template: dropping the named gate-owner role fails", async (t) => {
  const root = makeFixture(t, ({ handoffTemplatePath }) => {
    patchText(
      handoffTemplatePath,
      "**Gate owner role:** `Integration Gate Owner`",
      "**Gate owner:** `someone`",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'missing required fragment "**Gate owner role:** `Integration Gate Owner`"'),
    report(errors),
  );
});

// --- Evidence immutability (given a base revision) ---

const QA_REL = "docs/replatform/epics/E0-foundation/qa/2026-08-08-d0-foundation-abcdef012345-a1.md";
const QA_REL_A2 = "docs/replatform/epics/E0-foundation/qa/2026-08-08-d0-foundation-abcdef012345-a2.md";
const HANDOFF_REL = "docs/replatform/epics/E0-foundation/handoffs/2026-08-08-epic-completion-abcdef012345-a1.md";

function makeEvidenceTree(t, records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fnd005-ev-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(records)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

test("evidence immutability: an unchanged candidate passes", async (t) => {
  const base = makeEvidenceTree(t, { [QA_REL]: "campaign one\n", [HANDOFF_REL]: "gate one\n" });
  const cand = makeEvidenceTree(t, { [QA_REL]: "campaign one\n", [HANDOFF_REL]: "gate one\n" });
  const { errors } = await checkEvidenceImmutability(base, cand);
  assert.deepEqual(errors, [], report(errors));
});

test("evidence immutability: modifying an existing record is rejected", async (t) => {
  const base = makeEvidenceTree(t, { [QA_REL]: "campaign one\n" });
  const cand = makeEvidenceTree(t, { [QA_REL]: "campaign one MUTATED\n" });
  const { errors } = await checkEvidenceImmutability(base, cand);
  assert.ok(hasError(errors, "was modified after commit"), report(errors));
});

test("evidence immutability: deleting an existing record is rejected", async (t) => {
  const base = makeEvidenceTree(t, { [QA_REL]: "campaign one\n" });
  const cand = makeEvidenceTree(t, {});
  const { errors } = await checkEvidenceImmutability(base, cand);
  assert.ok(hasError(errors, "was deleted or renamed after commit"), report(errors));
});

test("evidence immutability: renaming an existing record is rejected", async (t) => {
  const base = makeEvidenceTree(t, { [QA_REL]: "campaign one\n" });
  const cand = makeEvidenceTree(t, { [QA_REL_A2]: "campaign one\n" });
  const { errors } = await checkEvidenceImmutability(base, cand);
  assert.ok(hasError(errors, "was deleted or renamed after commit"), report(errors));
});

test("evidence immutability: adding a higher attempt is permitted", async (t) => {
  const base = makeEvidenceTree(t, { [QA_REL]: "campaign one\n" });
  const cand = makeEvidenceTree(t, { [QA_REL]: "campaign one\n", [QA_REL_A2]: "campaign two\n" });
  const { errors } = await checkEvidenceImmutability(base, cand);
  assert.deepEqual(errors, [], report(errors));
});

// --- FND-007: execution-source freeze + legacy parity + crosswalk corpus ------
//
// The two fabricated-provenance discriminant mutations required by the FND-007
// corpus (a non-task_run source carrying runId, and a task_run missing runId)
// are already exercised at the schema layer by the two FND-004 tests
// "a task_run source missing runId fails the discriminant" and "a non-task_run
// source carrying runId fails the discriminant"; the tests below add the
// authority-sourced (legacy-parity) enforcement plus the crosswalk, parity,
// principal, sentinel, ticket-ID, migration-marker, and Markdown/JSON-drift
// mutations. The valid corpus (real repo + unmutated fixture copy) already
// asserts zero errors above, now with legacy-parity.json + the crosswalk copied
// into the fixture tree.

function readLegacyParity(root) {
  return JSON.parse(fs.readFileSync(path.join(root, REL.legacyParity), "utf8"));
}
function writeLegacyParity(root, obj) {
  fs.writeFileSync(path.join(root, REL.legacyParity), JSON.stringify(obj, null, 2) + "\n", "utf8");
}
const SENTINEL_ORG = `org_${"0".repeat(26)}`;

// -- legacy-parity authority --------------------------------------------------

test("legacy-parity: missing file is named", async (t) => {
  const root = makeFixture(t, ({ legacyParityPath }) => fs.rmSync(legacyParityPath));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.legacyParity}: missing`), report(errors));
});

test("legacy-parity: a missing parity dimension fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const j = readLegacyParity(r);
    const task = j.sources.find((s) => s.kind === "task_run");
    delete task.parity.budget;
    writeLegacyParity(r, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `source task_run is missing parity dimension "budget"`), report(errors));
});

test("legacy-parity: a bare unjustified not_applicable fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const j = readLegacyParity(r);
    const task = j.sources.find((s) => s.kind === "task_run");
    task.parity.audit = "not_applicable";
    writeLegacyParity(r, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `parity dimension "audit" is a bare "not_applicable" without justification`), report(errors));
});

test("legacy-parity: a not_applicable object without justification fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const j = readLegacyParity(r);
    const commander = j.sources.find((s) => s.kind === "commander_turn");
    commander.parity.checkout_assignment = { status: "not_applicable", justification: "  " };
    writeLegacyParity(r, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `parity dimension "checkout_assignment" is not_applicable without a non-empty justification`), report(errors));
});

test("legacy-parity: an unknown parity dimension fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const j = readLegacyParity(r);
    const task = j.sources.find((s) => s.kind === "task_run");
    task.parity.telepathy = "reads the founder's mind";
    writeLegacyParity(r, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `has unknown parity dimension "telepathy"`), report(errors));
});

test("legacy-parity: task_run dropping the runId requirement fails (fabricated task provenance)", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const j = readLegacyParity(r);
    const task = j.sources.find((s) => s.kind === "task_run");
    task.requiredFields = task.requiredFields.filter((f) => f !== "runId");
    writeLegacyParity(r, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `source task_run must require "runId"`), report(errors));
});

test("legacy-parity: a non-task_run requiring runId fails (fabricated task provenance)", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const j = readLegacyParity(r);
    const commander = j.sources.find((s) => s.kind === "commander_turn");
    commander.requiredFields = ["runId"];
    writeLegacyParity(r, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `source commander_turn must not require "runId" (only task_run carries run/issue identity)`), report(errors));
});

test("legacy-parity: an unknown source kind fails (exact-set)", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const j = readLegacyParity(r);
    j.sources.find((s) => s.kind === "crew_run").kind = "bogus_kind";
    writeLegacyParity(r, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "has an unknown or missing source kind"), report(errors));
  assert.ok(hasError(errors, `missing required source kind "crew_run"`), report(errors));
});

test("legacy-parity: an extra 7th source fails the count pin (reject unknown)", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const j = readLegacyParity(r);
    j.sources.push({ ...j.sources[0] });
    writeLegacyParity(r, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "expected exactly 6 source kinds, found 7"), report(errors));
});

test("legacy-parity: an unknown executor principal kind fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const j = readLegacyParity(r);
    const task = j.sources.find((s) => s.kind === "task_run");
    task.executorPrincipalKinds = ["quantum_worker"];
    writeLegacyParity(r, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `executor principal kind "quantum_worker" is unknown`), report(errors));
});

test("legacy-parity/crosswalk drift: a source references a non-existent CM row", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const j = readLegacyParity(r);
    const task = j.sources.find((s) => s.kind === "task_run");
    task.crosswalkRows = ["CM-099"];
    writeLegacyParity(r, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `source task_run references crosswalk row "CM-099" not present in ${REL.crosswalk}`),
    report(errors),
  );
});

// -- current-main crosswalk ---------------------------------------------------

test("crosswalk: removing a CM row fails the contiguous set", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    const md = fs.readFileSync(crosswalkPath, "utf8");
    const stripped = md.replace(/\n\| CM-010 \|[^\n]*\|/, "");
    assert.notEqual(stripped, md, "mutation did not remove the CM-010 row");
    fs.writeFileSync(crosswalkPath, stripped, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "CM table is missing required row CM-010"), report(errors));
});

test("crosswalk: removing a CP row fails the contiguous set", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    const md = fs.readFileSync(crosswalkPath, "utf8");
    const stripped = md.replace(/\n\| CP-003 \|[^\n]*\|/, "");
    assert.notEqual(stripped, md, "mutation did not remove the CP-003 row");
    fs.writeFileSync(crosswalkPath, stripped, "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "CP table is missing required row CP-003"), report(errors));
});

test("crosswalk: an extra/unknown CM row is rejected (exact-set)", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    const lines = fs.readFileSync(crosswalkPath, "utf8").split(/\r?\n/);
    const idx = lines.findIndex((l) => /^\| CM-015 \|/.test(l));
    assert.notEqual(idx, -1, "could not find the CM-015 row");
    lines.splice(idx + 1, 0, "| CM-016 | extra | extra authority | extra disposition | JOB-001 | effect-free shadow; active-work drain; rollback; no fallback |");
    fs.writeFileSync(crosswalkPath, lines.join("\n"), "utf8");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "unknown/extra CM row CM-016"), report(errors));
});

test("crosswalk: a missing owner ticket ID fails", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    patchText(crosswalkPath, "| DEP-003, MIG-002 |", "|  |");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "CM-015 has no owner ticket ID"), report(errors));
});

test("crosswalk: an invented owner ticket (not in program-design) fails", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    patchText(crosswalkPath, "| DEP-003, MIG-002 |", "| DEP-003, ZZZ-999 |");
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `CM-015 references unknown owner ticket "ZZZ-999" (not defined in ${REL.programDesign})`),
    report(errors),
  );
});

test("crosswalk: a ticket-ID range (not enumerated) fails", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    patchText(
      crosswalkPath,
      "JOB-010, JOB-011, JOB-012, JOB-013, JOB-014",
      "JOB-010..JOB-014",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "is not an enumerated ticket-ID list (ranges/prose are invalid)"), report(errors));
});

test("crosswalk: a CM row losing its rollback evidence field fails", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    patchText(crosswalkPath, "rollback creates no second attempt", "creates no second attempt");
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `CM-002 evidence is missing the "rollback" field`), report(errors));
});

test("crosswalk: removing the migration-0188 marker evidence fails (CM-015)", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    patchText(crosswalkPath, "record_0188_marker", "record_marker");
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `CM-015 is missing the migration-0188 snapshot/marker evidence "record_0188_marker"`),
    report(errors),
  );
});

test("crosswalk: an auto-bypassed migration-0188 gate fails the per-clause negation", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    patchText(
      crosswalkPath,
      "never silently auto-bypasses the gate",
      "silently auto-bypasses the gate",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "CM-015 auto-bypass clause asserted without negation"), report(errors));
});

// E0-F003 item 1 at FND-007's site. The crosswalk's own splitter was
// punctuation-only, so a contrastive carve-out with no punctuation stayed
// inside the negated clause and rode the "never". Measured live at da1a90597:
// this exact mutation produced ZERO checker errors.
test("crosswalk: a contrastive auto-bypass carve-out with no punctuation fails (CM-015)", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    patchText(
      crosswalkPath,
      "and never silently auto-bypasses the gate.",
      "and never silently auto-bypasses the gate except when the operator sets the override in which case it auto-bypasses the gate.",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "CM-015 auto-bypass clause asserted without negation"), report(errors));
});

// The general case at this site too: one word of the probe above changed from
// `except` to `and` re-opened the smuggle here as well.
test("crosswalk: an `and`-joined auto-bypass carve-out fails (CM-015)", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    patchText(
      crosswalkPath,
      "and never silently auto-bypasses the gate.",
      "and never silently auto-bypasses the gate and the operator override auto-bypasses the gate.",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "CM-015 auto-bypass clause asserted without negation"), report(errors));
});

// The vocabulary-free arm at this site: `whereupon` is on no boundary list, so
// the carve-out stays inside the clause carrying "never". Only the per-mention
// budget rejects it.
test("crosswalk: an UNLISTED-conjunction auto-bypass carve-out fails on the negation budget (CM-015)", async (t) => {
  const root = makeFixture(t, ({ crosswalkPath }) => {
    patchText(
      crosswalkPath,
      "and never silently auto-bypasses the gate.",
      "and never silently auto-bypasses the gate whereupon the operator override auto-bypasses the gate.",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "CM-015 auto-bypass clause"), report(errors));
  assert.ok(hasError(errors, "covering 2 mentions"), report(errors));
});

// -- fixture source/principal binding -----------------------------------------

test("fixture: a requester principal not permitted for the source kind fails (identity mismatch)", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "service-budget-stop.json");
    fx.requester.type = "founder";
    writeFixture(r, "service-budget-stop.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `requester principal "founder" is not permitted for source kind "service_reconcile"`),
    report(errors),
  );
});

test("fixture: an executor principal not permitted for the source kind fails (identity mismatch)", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.executor.type = "browser_worker";
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `executor principal "browser_worker" is not permitted for source kind "task_run"`),
    report(errors),
  );
});

test("fixture: a non-task_run carrying issueId fails the authority forbidden field (fabricated provenance)", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "plaintext-secret-in-argv-rejected.json");
    fx.source.issueId = `issue_${ULID26}`;
    writeFixture(r, "plaintext-secret-in-argv-rejected.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `source kind "one_shot" must not carry forbidden field "issueId" (fabricated provenance)`),
    report(errors),
  );
});

test("fixture: admitting a sentinel Organization fails", async (t) => {
  const root = makeFixture(t, ({ root: r }) => {
    const fx = readFixture(r, "batch-success.json");
    fx.organization.id = SENTINEL_ORG;
    writeFixture(r, "batch-success.json", fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "sentinel Organization admission"), report(errors));
});

// -- Decision #121 back-references --------------------------------------------

test("decisions: Decision #121 loses the legacy-parity back-reference", async (t) => {
  const root = makeFixture(t, ({ decisionsPath }) => {
    patchText(
      decisionsPath,
      "[`distributed-execution-legacy-parity.json`](distributed-execution-legacy-parity.json)",
      "[`the legacy parity`](removed-by-mutation.json)",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `missing reference to "distributed-execution-legacy-parity.json"`),
    report(errors),
  );
});

test("decisions: Decision #121 loses the current-main crosswalk back-reference", async (t) => {
  const root = makeFixture(t, ({ decisionsPath }) => {
    patchText(
      decisionsPath,
      "[`../replatform/current-main-crosswalk.md`](../replatform/current-main-crosswalk.md)",
      "[`the crosswalk`](removed-by-mutation.md)",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, `missing reference to "current-main-crosswalk.md"`),
    report(errors),
  );
});

// ---------------------------------------------------------------------------
// BRW-004 slice (b) — E8-F001: the fixture control-block ↔ shipped-authority binding.
//
// These are the POSITIVE CONTROLS the design makes mandatory. Without them, "green
// because the divergence is pinned" and "green because the check reads nothing" are
// indistinguishable — which is the exact failure mode this slice exists inside.

test("valid: the pinned E8-F001 divergence is reported in the census and fails nothing", async (t) => {
  const root = makeFixture(t);
  const { errors, divergenceCensus } = await runCheck(root);
  assert.deepEqual(errors, [], report(errors));
  const rendered = formatDivergenceCensus(divergenceCensus);
  assert.ok(rendered.includes("E8-F001"), rendered);
  assert.ok(rendered.includes("browser-approval-download.json"), rendered);
  // The census must be a SECOND verdict, not a clause folded into the gate.
  assert.equal(divergenceCensus.pinned.length, 1);
});

test("control parity: a DIFFERENT fixture carrying the same contradiction is RED (the pin is not a blanket exemption)", async (t) => {
  // batch-success is a task_run, whose shipped productApprovalAuthority is "none".
  // Declaring a product approval on it is the same contradiction E8-F001 records, on a
  // fixture that is NOT pinned. If this stays green, the check is reading nothing.
  const root = makeFixture(t, ({ fixturePath }) => {
    const p = fixturePath("batch-success.json");
    const fx = readJson(p);
    fx.control.productApproval = "requested_granted";
    writeJson(p, fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "batch-success.json: control.productApproval \"requested_granted\" asserts a product approval"),
    report(errors),
  );
});

test("control parity: MUTATING the pinned fixture's control block is RED (the pin is a VALUE tuple, not a filename)", async (t) => {
  // This is what mechanically enforces the fixtures README's "no in-place repurposing"
  // rule: the pin records the exact values, so editing them stops matching it.
  const root = makeFixture(t, ({ fixturePath }) => {
    const p = fixturePath("browser-approval-download.json");
    const fx = readJson(p);
    fx.control.productApproval = "requested_denied";
    writeJson(p, fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "browser-approval-download.json: control.productApproval \"requested_denied\" asserts a product approval"),
    report(errors),
  );
  assert.ok(
    hasError(errors, "pinned control divergence for browser-approval-download.json (E8-F001) matched NO fixture"),
    report(errors),
  );
});

test("control parity: a runtimeDecision naming a MODELLED authority the source does not carry is RED", async (t) => {
  // `egress_denied` asserts permission_download_egress. A task_run's shipped authority
  // is ask_human_work_question, so this must fail — and it proves the runtime-decision
  // arm is live and not merely present.
  const root = makeFixture(t, ({ fixturePath }) => {
    const p = fixturePath("batch-success.json");
    const fx = readJson(p);
    fx.control.runtimeDecision = "egress_denied";
    writeJson(p, fx);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "batch-success.json: control.runtimeDecision \"egress_denied\" asserts runtime-decision authority"),
    report(errors),
  );
});

test("control parity: mutating the SHIPPED authority reds the fixture that agreed with it", async (t) => {
  // The binding must be to the CODE, not to a copy of the code's answer. Flipping
  // browser_request's runtime authority to `none` must red browser-denied-egress, which
  // declares `egress_denied`. If this stays green the check is bound to nothing.
  const root = makeFixture(t, ({ jobApprovalBridgePath }) => {
    patchText(
      jobApprovalBridgePath,
      'runtimeDecisionAuthority: "permission_download_egress"',
      'runtimeDecisionAuthority: "budget_stop"',
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "browser-denied-egress.json: control.runtimeDecision \"egress_denied\" asserts runtime-decision authority"),
    report(errors),
  );
  // ...and the pin, which records the expected authority as part of its tuple, stops matching.
  assert.ok(
    hasError(errors, "pinned control divergence for browser-approval-download.json (E8-F001) matched NO fixture"),
    report(errors),
  );
});

test("control parity: an UNPARSEABLE authority is an error, never a silent skip", async (t) => {
  const root = makeFixture(t, ({ jobApprovalBridgePath }) => {
    patchText(
      jobApprovalBridgePath,
      "export function describeSourceGovernance(",
      "export function describeSourceGovernanceRenamedByMutation(",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "cannot locate the describeSourceGovernance function body"),
    report(errors),
  );
});

test("control parity: a schema enum value with NO interpretation entry is RED", async (t) => {
  // Otherwise the interpretation map decays into the blanket exemption the value-tuple
  // pin was designed to prevent: a new control value would simply pass unchecked.
  const root = makeFixture(t, ({ schemaPath }) => {
    const schema = readJson(schemaPath);
    schema.$defs.Control.properties.runtimeDecision.enum.push("invented_by_mutation");
    writeJson(schemaPath, schema);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'control.runtimeDecision value "invented_by_mutation" has no entry in the source-governance interpretation map'),
    report(errors),
  );
});

test("control parity: a missing authority file is an error, and the census says so rather than reporting a clean sheet", async (t) => {
  const root = makeFixture(t, ({ jobApprovalBridgePath }) => fs.rmSync(jobApprovalBridgePath));
  const { errors, divergenceCensus } = await runCheck(root);
  assert.ok(hasError(errors, `${REL.jobApprovalBridge}: missing`), report(errors));
  assert.equal(divergenceCensus.authorityUnavailable, true);
  assert.ok(formatDivergenceCensus(divergenceCensus).includes("AUTHORITY UNAVAILABLE"));
});

// ---------------------------------------------------------------------------
// W4U2 — delivery-status contract (register repair, NOT egress enforcement).
//
// The defect these cases pin: the crossing schema had no field able to
// distinguish "this control is REQUIRED" from "this control is DELIVERED", so
// DE-08 — Critical, whose sole owner ticket DAT-005 is complete, and whose
// enforcement finding E8-F003 measured absence at every layer — read in the
// register exactly like a control that holds.
//
// Every case below asserts TWO things: the mutated crossing reds, and DE-02
// (genuinely delivered: composite tenant constraints, proven by a real-PG
// negative test with same-tenant positive controls) stays GREEN. A mutation
// that reds both would prove only that the harness broke.
// ---------------------------------------------------------------------------

/** POSITIVE CONTROL: no error may name the genuinely-delivered crossing DE-02. */
function assertDe02Unaffected(errors) {
  const de02 = errors.filter((e) => e.includes("DE-02"));
  assert.deepEqual(
    de02,
    [],
    `positive control failed: DE-02 (genuinely delivered) also reported errors${report(errors)}`,
  );
}

function setCrossing(threatControlsPath, id, mutate) {
  const j = readJson(threatControlsPath);
  const c = j.crossings.find((x) => x.id === id);
  assert.ok(c, `fixture is missing crossing ${id}`);
  mutate(c);
  writeJson(threatControlsPath, j);
}

test("W4U2 M1: DE-08 flipped back to \"delivered\" is refused (E8-F003 names it)", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-08", (c) => {
      c.deliveryStatus = "delivered";
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'crossing DE-08 claims deliveryStatus "delivered" but'),
    report(errors),
  );
  assert.ok(hasError(errors, "E8-F003"), report(errors));
  assertDe02Unaffected(errors);
});

test("W4U2 M2: deleting deliveryStatus from DE-08 is refused", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-08", (c) => {
      delete c.deliveryStatus;
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'crossing DE-08 is missing required field "deliveryStatus"'),
    report(errors),
  );
  assertDe02Unaffected(errors);
});

test("W4U2 M3: an unknown deliveryStatus value is refused", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-08", (c) => {
      c.deliveryStatus = "partially-delivered";
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'crossing DE-08 has unknown deliveryStatus "partially-delivered"'),
    report(errors),
  );
  assertDe02Unaffected(errors);
});

test("W4U2 M4: not-delivered without deliveryEvidence is refused", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-08", (c) => {
      c.deliveryEvidence = "   ";
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'crossing DE-08 is deliveryStatus "not-delivered" and must carry a non-empty "deliveryEvidence"'),
    report(errors),
  );
  assertDe02Unaffected(errors);
});

// DE-15 (not DE-01) because W20 audited DE-01 and moved it to `partial`. The test needs a
// crossing that is still genuinely `unaudited`; picking one that has since been audited is
// how a mutation test quietly stops testing the arm it names.
// W20B: this fixture used to borrow whichever crossing happened to be `unaudited` in the
// real register, and DE-15 was one. After W20B recorded the last sixteen audits NO crossing
// is `unaudited` any more, so the fixture must now MINT the state it is testing rather than
// assume the tree still supplies it. The mutation is unchanged and still real — an unaudited
// crossing with no `deliveryEvidence` must be refused — but it is now stated explicitly
// instead of riding on a tree property that has (rightly) gone away.
test("W4U2 M5: an unaudited deferral without a reason is refused (no silent deferral)", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-15", (c) => {
      c.deliveryStatus = "unaudited";
      delete c.deliveryEvidence;
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'crossing DE-15 is deliveryStatus "unaudited" and must carry a non-empty "deliveryEvidence"'),
    report(errors),
  );
  assertDe02Unaffected(errors);
});

// --- W20: the `partial` status carries not-delivered's citation duty ------------------
// `partial` says "some of this control is absent". If it could be written without naming a
// finding, it would be a strictly WEAKER `unaudited` — a place to park absent controls that
// no ownership census can see — which is the opposite of why it was added.

test("W20 M12: partial with no deliveryEvidence is refused", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-01", (c) => {
      delete c.deliveryEvidence;
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'crossing DE-01 is deliveryStatus "partial" and must carry a non-empty "deliveryEvidence"'),
    report(errors),
  );
  assertDe02Unaffected(errors);
});

test("W20 M13: partial whose evidence cites no finding id is refused", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-01", (c) => {
      c.deliveryEvidence = "half of it works, trust me";
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'crossing DE-01 is deliveryStatus "partial" but its "deliveryEvidence" cites no finding id'),
    report(errors),
  );
  assertDe02Unaffected(errors);
});

test("W20 M14: partial citing a finding that is not in the register is refused", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-01", (c) => {
      c.deliveryEvidence = "the audit half is absent, see E9-F999";
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "crossing DE-01 cites finding E9-F999 which is not in"),
    report(errors),
  );
  assertDe02Unaffected(errors);
});

// W20B: the title used to say "twelve", which was true when W20 wrote it and stopped being
// true the moment the remaining sixteen audits landed. The assertion never read a count —
// it checks EVERY partial row — so the number was decoration that could only go stale.
// Named for what it does instead.
test("W20 M15: every partial row in the shipped register satisfies the citation rule (positive control)", async (t) => {
  const root = makeFixture(t, () => {});
  const { errors } = await runCheck(root);
  const offenders = errors.filter((e) => /deliveryStatus "partial"/.test(e) || /cites finding .* which is not in/.test(e));
  assert.deepEqual(offenders, [], report(errors));
});

test("W4U2 M6: not-delivered whose evidence cites no finding id is refused", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-08", (c) => {
      c.deliveryEvidence = "trust me, it is absent";
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'crossing DE-08 is deliveryStatus "not-delivered" but its "deliveryEvidence" cites no finding id'),
    report(errors),
  );
  assertDe02Unaffected(errors);
});

test("W4U2 M7: not-delivered citing a finding that is not in the register is refused", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-08", (c) => {
      c.deliveryEvidence = "measured absent, see E9-F999";
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "crossing DE-08 cites finding E9-F999 which is not in scripts/finding-ownership.json"),
    report(errors),
  );
  assertDe02Unaffected(errors);
});

test("W4U2 M8: the checker reads the FIXTURE findings register, not the real tree", async (t) => {
  // Delete E8-F003 from the fixture register only. If the checker were resolving
  // scripts/finding-ownership.json against the repo root, this would be invisible.
  const root = makeFixture(t, ({ findingOwnershipPath }) => {
    const j = readJson(findingOwnershipPath);
    delete j.findings["E8-F003"];
    writeJson(findingOwnershipPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "crossing DE-08 cites finding E8-F003 which is not in scripts/finding-ownership.json"),
    report(errors),
  );
});

test("W4U2 M9: the delivered rule is not hard-coded to DE-08 — a live finding naming DE-02 refuses ITS claim", async (t) => {
  // The negative counterpart of the positive control: DE-02 is green above only
  // because nothing in the register names it. Give it a namer and it reds too.
  const root = makeFixture(t, ({ findingOwnershipPath }) => {
    const j = readJson(findingOwnershipPath);
    j.findings["E2-F900"] = {
      status: "unowned",
      reason: "synthetic: DE-02's composite constraints were measured absent",
    };
    writeJson(findingOwnershipPath, j);
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'crossing DE-02 claims deliveryStatus "delivered" but'),
    report(errors),
  );
  assert.ok(hasError(errors, "E2-F900"), report(errors));
});

test("W4U2 M10: a missing findings register fails closed", async (t) => {
  const root = makeFixture(t, ({ findingOwnershipPath }) => fs.rmSync(findingOwnershipPath));
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "scripts/finding-ownership.json: missing"), report(errors));
});

// ---------------------------------------------------------------------------
// W4U2-FIX — the review of PR #364 showed "delivered" was gated by NOTHING for
// the 29 crossings no open finding names: DE-05 (Critical) could be flipped to
// "delivered" with deliveryEvidence deleted outright and the checker passed,
// exit 0. M11 pins that path. It is a prose-presence rule, not a proof: it does
// not read a test file or execute the control — see checkCrossingDeliveryStatus.
// ---------------------------------------------------------------------------

test("W4U2 M11: \"delivered\" with no deliveryEvidence is refused, even for a crossing no finding names", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-05", (c) => {
      c.deliveryStatus = "delivered";
      delete c.deliveryEvidence;
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, 'crossing DE-05 is deliveryStatus "delivered" and must carry a non-empty "deliveryEvidence"'),
    report(errors),
  );
  // POSITIVE CONTROL: DE-02 is "delivered" WITH real evidence and must stay green,
  // or this case would prove only that every delivered crossing now reds.
  assertDe02Unaffected(errors);
});

// ---------------------------------------------------------------------------
// W20C — the rendered view must LEAD with the measured state.
//
// The defect this pins: every per-row parity check above compares a register ROW
// to its JSON crossing, so a document whose head asserts more than the register
// delivers passes all of them. The head of this document did exactly that — it
// opened "This record locks the trust boundaries, mandatory controls, verification
// gates ..." over a register in which one crossing of thirty was `delivered`, and
// the honest tally sat 130 lines down. A prose tally also goes stale silently,
// which is how the head got there. These four cases pin both halves.
// ---------------------------------------------------------------------------

const HEAD_TALLY = "1 `delivered`, 25 `partial`, 4 `not-delivered`, 0 `unaudited`";

function readMd(p) {
  return fs.readFileSync(p, "utf8");
}
function writeMd(p, text) {
  fs.writeFileSync(p, text);
}

test("W20C M16: the shipped head states the tally, the count and the severity split (positive control)", async (t) => {
  const root = makeFixture(t, () => {});
  const { errors } = await runCheck(root);
  const offenders = errors.filter((e) => /document head|stale delivery tally/.test(e));
  assert.deepEqual(offenders, [], report(errors));
  // And the fragment this corpus mutates is really the one the shipped head carries,
  // collapsed the same way the checker collapses it — otherwise M17/M18 could pass
  // by deleting text the check never read.
  const head = readMd(path.join(root, REL.threatModel)).split(/\n##\s/)[0];
  assert.ok(head.replace(/\s+/g, " ").includes(HEAD_TALLY), "shipped head does not carry the tally");
});

test("W20C M17: a head with the tally REMOVED is refused (the register's own honest tally does not rescue it)", async (t) => {
  const root = makeFixture(t, ({ threatModelPath }) => {
    const md = readMd(threatModelPath);
    const head = md.split(/\n##\s/)[0];
    // Delete the tally from the head ONLY. The identical sentence in "Required vs
    // delivered" further down is left untouched, so this case proves the check is
    // head-scoped and not a document-wide grep that any copy anywhere satisfies.
    const strippedHead = head.replace(/and the tally is[\s\S]*?came back whole\.\*\*/, "and it is fine.");
    writeMd(threatModelPath, strippedHead + md.slice(head.length));
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "the document head (before the first \"## \" heading) must state the measured delivery tally"),
    report(errors),
  );
});

test("W20C M18: flipping a crossing's deliveryStatus reds the now-stale head tally", async (t) => {
  // DE-05 is `partial`; `not-delivered` carries the same evidence/citation contract,
  // so this mutation changes NOTHING except the counts — which is the point. Every
  // per-row parity check stays green and only the head tally moves.
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-05", (c) => {
      c.deliveryStatus = "not-delivered";
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "1 `delivered`, 24 `partial`, 5 `not-delivered`, 0 `unaudited`"),
    report(errors),
  );
});

test("W20C M19: a SECOND, stale tally further down the document is refused", async (t) => {
  const root = makeFixture(t, ({ threatModelPath }) => {
    const md = readMd(threatModelPath);
    // The head keeps the true tally; the copy in "Required vs delivered" is edited to
    // the pre-audit numbers. This is the drift a head-only check would let through.
    const anchor = `The tally today: ${HEAD_TALLY}`;
    assert.ok(md.includes(anchor), "expected the register's own tally sentence");
    writeMd(
      threatModelPath,
      md.replace(anchor, "The tally today: 1 `delivered`, 1 `partial`, 0 `not-delivered`, 28 `unaudited`"),
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "stale delivery tally \"1 `delivered`, 1 `partial`, 0 `not-delivered`, 28 `unaudited`\""),
    report(errors),
  );
});

test("W20C M21: a stale tally in a SECONDARY rendered view (decisions.md) is refused", async (t) => {
  // decisions.md is copied into the fixture root, so this also proves the secondary
  // scan resolves against `root` rather than silently reading the real tree.
  const root = makeFixture(t, ({ decisionsPath }) => {
    const md = readMd(decisionsPath);
    assert.ok(md.includes(HEAD_TALLY), "expected Decision #121 to quote the tally");
    writeMd(decisionsPath, md.replace(HEAD_TALLY, "9 `delivered`, 21 `partial`, 0 `not-delivered`, 0 `unaudited`"));
  });
  const { errors } = await runCheck(root);
  assert.ok(
    hasError(errors, "docs/architecture/decisions.md: stale delivery tally"),
    report(errors),
  );
});

test("W20C M22: a secondary view the fixture does not otherwise carry is still READ (the skip-if-absent arm is not a hole)", async (t) => {
  // The orchestration handoff is not part of the fixture corpus, so the unmutated
  // baseline skips it. Writing one with a stale tally must turn red — otherwise
  // "skip when absent" would be indistinguishable from "never read at all".
  const rel = "docs/replatform/HANDOFF-orchestration.md";
  const root = makeFixture(t, ({ root: r }) => {
    fs.mkdirSync(path.join(r, "docs", "replatform"), { recursive: true });
    writeMd(
      path.join(r, rel),
      "# handoff\n\nAudited: 0 `delivered`, 0 `partial`, 30 `not-delivered`, 0 `unaudited`.\n",
    );
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, `${rel}: stale delivery tally`), report(errors));
});

test("W20C M20: the severity split is derived, not decoration — a Critical→High flip reds the head", async (t) => {
  const root = makeFixture(t, ({ threatControlsPath }) => {
    setCrossing(threatControlsPath, "DE-05", (c) => {
      c.severity = "High";
    });
  });
  const { errors } = await runCheck(root);
  assert.ok(hasError(errors, "must state the severity split as"), report(errors));
});
