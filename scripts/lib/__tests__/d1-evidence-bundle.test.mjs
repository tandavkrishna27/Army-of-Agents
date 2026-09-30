// -----------------------------------------------------------------------------
// DEP-004 — pure D1 evidence-bundle suite (node --test, LOCAL: no PG/Docker).
//
//   node --test scripts/lib/__tests__/d1-evidence-bundle.test.mjs
//
// Written FIRST (RED). The evidence bundle assembled on a merge-train failure
// MUST carry all four sections — distributed logs, worker events, DB-state dump,
// and object-store (MinIO) manifests — plus a manifest that indexes them. These
// cases are non-vacuous: the complete bundle validates clean, and a bundle with a
// section removed is detected as incomplete.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildEvidenceBundle,
  validateEvidenceBundle,
  REQUIRED_SECTIONS,
} from "../d1-evidence-bundle.mjs";

/** Representative failure inputs (as the collector would gather them). */
function failureInputs() {
  return {
    runId: "d1-merge-train-4211",
    reason: "deliberate-failure-fixture: E6F-07 retained-evidence proof",
    generatedAt: "2026-01-01T00:00:00.000Z",
    logs: [
      { service: "control-plane", content: "boot ok\nplacement race 1\n" },
      { service: "worker-a", content: "lease acquired\njob failed (deliberate)\n" },
    ],
    events: [
      { seq: 1, type: "job.placed", eventDigest: "aaa" },
      { seq: 2, type: "job.failed", eventDigest: "bbb" },
    ],
    dbState: { jobs: 1, leases: 1, dump: "-- pg_dump excerpt --" },
    objectManifests: [
      { bucket: "aoa-artifacts", key: "runs/4211/log.txt", size: 42 },
    ],
  };
}

test("REQUIRED_SECTIONS is exactly logs/events/dbState/objectManifests", () => {
  assert.deepEqual([...REQUIRED_SECTIONS].sort(), ["dbState", "events", "logs", "objectManifests"]);
});

test("buildEvidenceBundle assembles all four sections + a manifest", () => {
  const bundle = buildEvidenceBundle(failureInputs());
  for (const name of REQUIRED_SECTIONS) {
    assert.ok(name in bundle.sections, `bundle.sections is missing "${name}"`);
  }
  assert.ok(bundle.manifest, "bundle is missing its manifest");
  assert.ok(Array.isArray(bundle.manifest.sections), "manifest.sections must be an array");
  const named = new Set(bundle.manifest.sections.map((s) => s.name));
  for (const name of REQUIRED_SECTIONS) {
    assert.ok(named.has(name), `manifest.sections is missing "${name}"`);
  }
  // Provided sections are marked present with a checksum.
  for (const s of bundle.manifest.sections) {
    assert.equal(s.present, true, `section "${s.name}" should be present`);
    assert.match(s.sha256, /^[0-9a-f]{64}$/, `section "${s.name}" must carry a sha256`);
  }
  assert.equal(bundle.manifest.runId, "d1-merge-train-4211");
  assert.ok(bundle.manifest.reason.includes("deliberate-failure"));
});

test("a complete bundle validates with zero violations", () => {
  const bundle = buildEvidenceBundle(failureInputs());
  const violations = validateEvidenceBundle(bundle);
  assert.deepEqual(violations, [], `expected a complete bundle, got:\n${violations.join("\n")}`);
});

test("NEGATIVE: a bundle missing a required section is detected", () => {
  const bundle = buildEvidenceBundle(failureInputs());
  delete bundle.sections.events;
  const violations = validateEvidenceBundle(bundle);
  assert.ok(
    violations.some((v) => /events/.test(v)),
    `expected an 'events section missing' violation, got:\n${violations.join("\n")}`,
  );
});

test("NEGATIVE: a bundle whose manifest omits a required section is detected", () => {
  const bundle = buildEvidenceBundle(failureInputs());
  bundle.manifest.sections = bundle.manifest.sections.filter((s) => s.name !== "objectManifests");
  const violations = validateEvidenceBundle(bundle);
  assert.ok(
    violations.some((v) => /objectManifests/.test(v)),
    `expected an 'objectManifests manifest entry missing' violation, got:\n${violations.join("\n")}`,
  );
});

test("NEGATIVE: a null/garbage bundle is rejected fail-closed", () => {
  assert.ok(validateEvidenceBundle(null).length > 0, "null bundle must be rejected");
  assert.ok(validateEvidenceBundle({}).length > 0, "empty bundle must be rejected");
  assert.ok(validateEvidenceBundle({ sections: {} }).length > 0, "bundle without a manifest must be rejected");
});

test("missing input sections still yield all four keys (present:false), never silently dropped", () => {
  // A failure that produced no object writes must still emit an objectManifests
  // section (empty, present:false) — never omit it.
  const inputs = failureInputs();
  delete inputs.objectManifests;
  const bundle = buildEvidenceBundle(inputs);
  assert.ok("objectManifests" in bundle.sections, "objectManifests key must still exist");
  const entry = bundle.manifest.sections.find((s) => s.name === "objectManifests");
  assert.ok(entry, "manifest must still index objectManifests");
  assert.equal(entry.present, false, "an absent input section must be marked present:false");
  // Structural completeness still holds (all four section keys exist).
  assert.deepEqual(validateEvidenceBundle(bundle), []);
});
