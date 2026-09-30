// Self-test for the gate-clause wiring guard.
//
// ★ The test that matters is `claimed_wired_but_no_caller` — that single verdict is what
// the 2026-08-25 exit-gate audit had to find by hand across ~70 clauses, and it is what
// would have stopped four epics reporting `complete` while the capability they name had
// never once run.

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateGateClauseWiring, evaluateProviderCapabilityClaims } from "../gate-clause-wiring.mjs";

const kinds = (r) => r.problems.map((p) => p.kind);

test("★ claiming wired with ZERO callers FAILS — the whole point", () => {
  const r = evaluateGateClauseWiring({
    declared: { "E4-1": { status: "wired", symbol: "createPollLoop", epic: "E4" } },
    callerCounts: { createPollLoop: 0 },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["claimed_wired_but_no_caller"]);
  assert.match(r.problems[0].detail, /createPollLoop has 0 production callers/);
});

test("wired with a real caller passes", () => {
  const r = evaluateGateClauseWiring({
    declared: { "E11-5": { status: "wired", symbol: "evaluateKillSwitches", epic: "E11" } },
    callerCounts: { evaluateKillSwitches: 2 },
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.wiredCount, 1);
});

test("★ unwired is ALLOWED but must say why, and is REPORTED on a green run", () => {
  const ok = evaluateGateClauseWiring({
    declared: { "E4-2": { status: "unwired", symbol: "createSupervisor", reason: "needs DEP-010 provider + WRK-008 2b" } },
    callerCounts: { createSupervisor: 0 },
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.deepEqual(ok.unwired, ["E4-2"]);

  const noReason = evaluateGateClauseWiring({
    declared: { "E4-2": { status: "unwired", symbol: "createSupervisor", reason: "  " } },
    callerCounts: { createSupervisor: 0 },
  });
  assert.equal(noReason.ok, false);
  assert.deepEqual(kinds(noReason), ["malformed_declaration"]);
});

test("★ an unwired clause that GAINED a caller is surfaced, not silently tolerated", () => {
  // A register nobody updates in either direction stops being believed.
  const r = evaluateGateClauseWiring({
    declared: { "E5-3": { status: "unwired", symbol: "runOrphanQuarantine", reason: "no producer" } },
    callerCounts: { runOrphanQuarantine: 1 },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["unwired_but_now_has_caller"]);
});

test("a symbol nobody measured fails rather than being assumed wired", () => {
  const r = evaluateGateClauseWiring({
    declared: { "E3-5": { status: "wired", symbol: "jobApprovalBridge" } },
    callerCounts: {},
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["symbol_not_measured"]);
});

test("a declaration with no symbol, or a bad status, is malformed", () => {
  for (const entry of [{ status: "wired" }, { status: "sortof", symbol: "x" }, null, "nope"]) {
    const r = evaluateGateClauseWiring({ declared: { C: entry }, callerCounts: { x: 1 } });
    assert.equal(r.ok, false, JSON.stringify(entry));
    assert.deepEqual(kinds(r), ["malformed_declaration"]);
  }
});

test("malformed input fails closed rather than reporting OK", () => {
  for (const bad of [null, undefined, 42, "nope", {}, { declared: {}, callerCounts: null }]) {
    assert.equal(evaluateGateClauseWiring(bad).ok, false, JSON.stringify(bad));
  }
});

test("★ POSITIVE CONTROL — a fully-wired manifest is green and counts correctly", () => {
  // Without this, every failure test above could be passing because the evaluator refuses
  // everything. This is the E1-F008 lesson applied to the guard's own suite.
  const r = evaluateGateClauseWiring({
    declared: {
      A: { status: "wired", symbol: "a" },
      B: { status: "wired", symbol: "b" },
      C: { status: "unwired", symbol: "c", reason: "dormant until DEP-010" },
    },
    callerCounts: { a: 1, b: 3, c: 0 },
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.wiredCount, 2);
  assert.deepEqual(r.unwired, ["C"]);
});

test("★ expectedReferences allows a KNOWN-unreachable reference, and still catches a new one", () => {
  // runBrowserSession is referenced once (runner.ts) but nothing invokes runner.ts, because
  // no package depends on browser-runtime. Acknowledging the known count keeps the promote
  // check sharp without forcing a false `wired`.
  const entry = (extra) => ({
    "E8-1": { status: "unwired", symbol: "runBrowserSession", reason: "no importer; runner.ts is unreachable", ...extra },
  });
  const at1 = evaluateGateClauseWiring({ declared: entry({ expectedReferences: 1 }), callerCounts: { runBrowserSession: 1 } });
  assert.equal(at1.ok, true, JSON.stringify(at1.problems));

  // A NEW reference appears -> still caught.
  const at2 = evaluateGateClauseWiring({ declared: entry({ expectedReferences: 1 }), callerCounts: { runBrowserSession: 2 } });
  assert.equal(at2.ok, false);
  assert.deepEqual(at2.problems.map((p) => p.kind), ["unwired_but_now_has_caller"]);

  // And an unacknowledged reference is still caught (default expected is 0).
  const at3 = evaluateGateClauseWiring({ declared: entry({}), callerCounts: { runBrowserSession: 1 } });
  assert.equal(at3.ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// W4U1 — provider-capability claims: the register's prose about source, checked against source.
//
// ★ The test that matters is `capability_claim_source_mismatch` on ONE claim while the OTHER
// claim on the SAME clause stays green. E5-2's reason asserted a value for both shipped
// providers; PR #353 falsified exactly one half. A guard that reddens on both halves proves
// only that it noticed the file changed — not that it can tell a stale claim from a live one.
// ─────────────────────────────────────────────────────────────────────────────────────────

const E2B = "packages/sandbox-e2b-provider/src/e2b-provider.ts";
const WIRE = "packages/provider-wire/src/driver.ts";

/** The register as it stands after W4U1: one provider moved, one did not. */
function e5_2({ e2bExpect = "grant_upload", wireExpect = "none", reason } = {}) {
  return {
    "E5-2": {
      status: "unwired",
      symbol: "createArtifactExportSequencer",
      reason:
        reason ??
        `e2b-provider.ts declares artifactExportMode = grant_upload while ${WIRE} still declares artifactExportMode = none.`,
      providerCapabilityClaims: [
        { file: E2B, property: "artifactExportMode", expect: e2bExpect },
        { file: WIRE, property: "artifactExportMode", expect: wireExpect },
      ],
    },
  };
}

const TRUE_SOURCE = {
  [`${E2B}::artifactExportMode`]: "grant_upload",
  [`${WIRE}::artifactExportMode`]: "none",
};

const claimKinds = (r) => r.problems.map((p) => p.kind);
const mentions = (r, needle) => r.problems.filter((p) => String(p.detail ?? "").includes(needle));

test("the register as corrected matches source and passes", () => {
  const r = evaluateProviderCapabilityClaims({ declared: e5_2(), sourceValues: TRUE_SOURCE });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.claimCount, 2);
});

test("★ THE MUTATION — a stale claim about ONE provider FAILS, and the other provider's claim stays GREEN", () => {
  // This is the pre-W4U1 register state: both halves asserted "none", which PR #353 made
  // false for the E2B provider only.
  const r = evaluateProviderCapabilityClaims({
    declared: e5_2({
      e2bExpect: "none",
      reason: `BOTH shipped providers declare artifactExportMode=none (${E2B}, ${WIRE}).`,
    }),
    sourceValues: TRUE_SOURCE,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(claimKinds(r), ["capability_claim_source_mismatch"]);
  assert.match(r.problems[0].detail, /e2b-provider\.ts declares artifactExportMode = "grant_upload"/);

  // ★ POSITIVE CONTROL, same evaluation: NOTHING is reported against the provider-wire half,
  // whose claim is still true. A mutation that reddens both proves nothing specific.
  assert.equal(mentions(r, WIRE).length, 0, "provider-wire's claim must stay green");
});

test("★ the PROSE is checked too — a correct structured claim beside a stale sentence still FAILS", () => {
  // The half that actually rotted was the sentence, not a field. Checking only the new field
  // would leave the stale-prone string untouched beside a checked one.
  const r = evaluateProviderCapabilityClaims({
    declared: e5_2({ reason: `BOTH shipped providers declare artifactExportMode=none (${E2B}, ${WIRE}).` }),
    sourceValues: TRUE_SOURCE,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(claimKinds(r), ["capability_claim_absent_from_reason"]);
  assert.match(r.problems[0].detail, /never states artifactExportMode = "grant_upload"/);
});

test("prose asserting a value NO claim declares is caught in the other direction", () => {
  const r = evaluateProviderCapabilityClaims({
    declared: e5_2({
      reason: "artifactExportMode = grant_upload here, artifactExportMode = none there, artifactExportMode = grant_download somewhere.",
    }),
    sourceValues: TRUE_SOURCE,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(claimKinds(r), ["capability_claim_unbacked_in_reason"]);
  assert.match(r.problems[0].detail, /grant_download/);
});

test("★ prose that names a watched property with NO claim at all is refused — the front-door loophole", () => {
  const r = evaluateProviderCapabilityClaims({
    declared: {
      "E5-9": { status: "unwired", symbol: "x", reason: "both providers declare artifactExportMode none" },
    },
    sourceValues: {},
  });
  assert.equal(r.ok, false);
  assert.deepEqual(claimKinds(r), ["capability_claim_undeclared"]);
});

test("a clause that says nothing about a watched property is untouched", () => {
  const r = evaluateProviderCapabilityClaims({
    declared: { "E4-2": { status: "unwired", symbol: "createSupervisor", reason: "needs DEP-010" } },
    sourceValues: {},
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.claimCount, 0);
});

test("a file that declares the property nowhere, or declares it twice, is REFUSED rather than guessed", () => {
  const missing = evaluateProviderCapabilityClaims({
    declared: e5_2(),
    sourceValues: { ...TRUE_SOURCE, [`${E2B}::artifactExportMode`]: null },
  });
  assert.deepEqual(claimKinds(missing), ["capability_claim_source_missing"]);

  const ambiguous = evaluateProviderCapabilityClaims({
    declared: e5_2(),
    sourceValues: { ...TRUE_SOURCE, [`${E2B}::artifactExportMode`]: ["grant_upload", "none"] },
  });
  assert.deepEqual(claimKinds(ambiguous), ["capability_claim_source_ambiguous"]);

  // An unmeasured symbol is not evidence of anything — same posture as symbol_not_measured.
  const unmeasured = evaluateProviderCapabilityClaims({ declared: e5_2(), sourceValues: {} });
  assert.deepEqual(claimKinds(unmeasured), ["capability_claim_not_measured", "capability_claim_not_measured"]);
});

test("a malformed claim is reported and does not silently pass as a checked one", () => {
  for (const claim of [null, { property: "artifactExportMode", expect: "none" }, { file: "a.ts", expect: "none" }, { file: "a.ts", property: "checkpointMode", expect: "none" }, { file: "a.ts", property: "artifactExportMode" }]) {
    const r = evaluateProviderCapabilityClaims({
      declared: { C: { reason: "", providerCapabilityClaims: [claim] } },
      sourceValues: {},
    });
    assert.equal(r.ok, false, JSON.stringify(claim));
    assert.deepEqual(claimKinds(r), ["malformed_capability_claim"], JSON.stringify(claim));
  }

  const notArray = evaluateProviderCapabilityClaims({
    declared: { C: { reason: "", providerCapabilityClaims: {} } },
    sourceValues: {},
  });
  assert.deepEqual(claimKinds(notArray), ["malformed_capability_claim"]);
});

test("malformed input is refused, not assumed clean", () => {
  assert.equal(evaluateProviderCapabilityClaims(null).ok, false);
  assert.equal(evaluateProviderCapabilityClaims({ declared: [], sourceValues: {} }).ok, false);
});

// ── The LIVE register, read from disk. The tests above are hermetic; this one is the
// anti-drift half: it asserts the shipped manifest declares the claims at all, so a future
// edit cannot quietly delete `providerCapabilityClaims` and leave every hermetic test green.
test("★ the shipped register declares E5-2's artifactExportMode claims for BOTH providers", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../gate-clause-wiring.json", import.meta.url), "utf8"));
  const entry = manifest.clauses["E5-2-fenced-object-commit-worker-half"];
  assert.ok(entry, "E5-2 clause is missing from the register");
  const claims = entry.providerCapabilityClaims ?? [];
  const byFile = Object.fromEntries(claims.map((c) => [c.file, c]));
  assert.equal(byFile[E2B]?.property, "artifactExportMode");
  assert.equal(byFile[WIRE]?.property, "artifactExportMode");
});
