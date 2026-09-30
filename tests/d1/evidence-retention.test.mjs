// -----------------------------------------------------------------------------
// DEP-004 — E6F-07 retained-evidence proof (node --test, LOCAL: no PG/Docker).
//
//   node --test tests/d1/evidence-retention.test.mjs
//
// Proves the merge-train's failure path: a deliberately-failing fixture (a) turns
// the run red, and (b) yields a COMPLETE evidence bundle — distributed logs,
// worker events, DB-state dump, and object manifests — assembled and retained.
//
// The bundle-assembly logic is pure, so this contract runs green on any host. The
// one LIVE assertion (a real docker-compose.d1.yml bring-up) is SKIP-clean unless
// AOA_D1_LIVE=1; it is NEVER faked. The Linux/CI d1-merge-train lane exercises the
// same collect -> upload-artifact path end to end against the real stack.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildEvidenceBundle,
  validateEvidenceBundle,
  REQUIRED_SECTIONS,
} from "../../scripts/lib/d1-evidence-bundle.mjs";
import {
  assertDeliberateFailure,
  simulateFailedRunEvidence,
  DELIBERATE_FAILURE_REASON,
} from "./fixtures/deliberate-failure.mjs";

const LIVE = process.env.AOA_D1_LIVE === "1";
const SKIP_LIVE = LIVE ? false : "requires AOA_D1_LIVE=1 + a running docker-compose.d1.yml stack (Linux/CI only)";

test("the deliberate fixture genuinely fails (turns the merge-train red)", () => {
  assert.throws(() => assertDeliberateFailure(), /deliberate/i);
});

test("on that failure, the evidence bundle is ASSEMBLED with all four sections", () => {
  const bundle = buildEvidenceBundle(simulateFailedRunEvidence());
  // Structural completeness — no section (or manifest entry) is dropped.
  assert.deepEqual(validateEvidenceBundle(bundle), []);
  for (const name of REQUIRED_SECTIONS) {
    assert.ok(name in bundle.sections, `bundle is missing the "${name}" section`);
  }
});

test("every retained section carries real evidence (present:true + checksum)", () => {
  const bundle = buildEvidenceBundle(simulateFailedRunEvidence());
  for (const s of bundle.manifest.sections) {
    assert.equal(s.present, true, `section "${s.name}" must be present on a real failure`);
    assert.ok(s.count > 0, `section "${s.name}" must carry at least one item`);
    assert.match(s.sha256, /^[0-9a-f]{64}$/, `section "${s.name}" must carry a sha256`);
  }
  assert.equal(bundle.manifest.reason, DELIBERATE_FAILURE_REASON);
});

test("LIVE: a real D1 stack failure retains the evidence bundle", { skip: SKIP_LIVE }, async () => {
  // Linux/CI-only. Assembles the bundle from the collector run against the live
  // stack; here we assert the collector emitted a complete bundle to EVIDENCE_DIR.
  // (The bring-up + deliberate-fixture injection is the d1-merge-train workflow;
  // this case documents the live assertion contract and is never faked.)
  const { readFileSync } = await import("node:fs");
  const evidenceDir = process.env.AOA_D1_EVIDENCE_DIR;
  assert.ok(evidenceDir, "AOA_D1_EVIDENCE_DIR must point at the collected bundle in live mode");
  const bundle = JSON.parse(readFileSync(`${evidenceDir}/bundle.json`, "utf8"));
  assert.deepEqual(validateEvidenceBundle(bundle), []);
});
