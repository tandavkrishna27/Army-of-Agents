import assert from "node:assert/strict";
import test from "node:test";

import {
  ArtifactCommitVectorError,
  attemptPrefix,
  decideCommit,
  isSafeObjectKey,
  isStructurallyValidManifest,
  loadFixture,
  objectKeyHasPrefix,
  verifyFixture,
} from "./check-artifact-commit-vectors.mjs";

const AUTH_ORG = "11111111-1111-4111-8111-111111111111";
const LEASE_COMPANY = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

function validManifest(overrides = {}) {
  return {
    protocolVersion: 1,
    organizationId: AUTH_ORG,
    companyId: LEASE_COMPANY,
    jobId: JOB,
    attempt: 1,
    artifactId: "66666666-6666-4666-8666-666666666666",
    kind: "log",
    sensitivity: "restricted",
    retention: "run",
    objectKey: `${attemptPrefix(AUTH_ORG, JOB, 1)}out.bin`,
    sizeBytes: 256,
    sha256: "a".repeat(64),
    contentType: "application/octet-stream",
    createdAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

function decide(manifest, actualSizeBytes = 256, actualSha256 = "a".repeat(64)) {
  return decideCommit({ manifest, authOrganizationId: AUTH_ORG, leaseCompanyId: LEASE_COMPANY, actualSizeBytes, actualSha256 });
}

test("the checked-in fixture passes the reference checker", () => {
  const { accepts, rejects } = verifyFixture(loadFixture());
  assert.ok(accepts >= 2);
  assert.ok(rejects >= 5);
});

test("isSafeObjectKey rejects traversal, absolute, backslash, colon, control", () => {
  assert.equal(isSafeObjectKey("organizations/o/jobs/j/attempts/1/x"), true);
  assert.equal(isSafeObjectKey("a/../b"), false);
  assert.equal(isSafeObjectKey("/abs"), false);
  assert.equal(isSafeObjectKey("a\\b"), false);
  assert.equal(isSafeObjectKey("c:/x"), false);
  assert.equal(isSafeObjectKey("a\u0000b"), false);
  assert.equal(isSafeObjectKey("trailing/"), false);
});

test("objectKeyHasPrefix requires a non-empty suffix under the exact prefix", () => {
  const p = attemptPrefix(AUTH_ORG, JOB, 1);
  assert.equal(objectKeyHasPrefix(`${p}f.bin`, p), true);
  assert.equal(objectKeyHasPrefix(p, p), false); // bare prefix has no suffix
  assert.equal(objectKeyHasPrefix(`${attemptPrefix(AUTH_ORG, JOB, 2)}f.bin`, p), false);
});

test("a fully valid manifest with matching actuals accepts", () => {
  assert.equal(decide(validManifest()), "accept");
});

test("hash mismatch rejects hash_mismatch", () => {
  assert.equal(decide(validManifest(), 256, "9".repeat(64)), "hash_mismatch");
});

test("size mismatch rejects size_mismatch (before hash)", () => {
  // Both size AND hash wrong → size precedence.
  assert.equal(decide(validManifest(), 255, "9".repeat(64)), "size_mismatch");
});

test("foreign-org objectKey rejects wrong_prefix", () => {
  const foreign = "44444444-4444-4444-8444-444444444444";
  const m = validManifest({ organizationId: foreign, objectKey: `${attemptPrefix(foreign, JOB, 1)}out.bin` });
  assert.equal(decide(m), "wrong_prefix");
});

test("foreign-company manifest rejects tenant_mismatch", () => {
  const m = validManifest({ companyId: "55555555-5555-4555-8555-555555555555" });
  assert.equal(decide(m), "tenant_mismatch");
});

test("wrong_prefix is decided before tenant_mismatch", () => {
  // Foreign org (so objectKey uses the foreign prefix) AND foreign company.
  const foreign = "44444444-4444-4444-8444-444444444444";
  const m = validManifest({
    organizationId: foreign,
    companyId: "55555555-5555-4555-8555-555555555555",
    objectKey: `${attemptPrefix(foreign, JOB, 1)}out.bin`,
  });
  assert.equal(decide(m), "wrong_prefix");
});

test("structural violations are malformed_manifest", () => {
  assert.equal(decide(validManifest({ sensitivity: "normal" })), "malformed_manifest");
  assert.equal(decide(validManifest({ sha256: "nothex" })), "malformed_manifest");
  assert.equal(decide(validManifest({ retention: "forever" })), "malformed_manifest");
  assert.equal(decide(validManifest({ kind: "made_up" })), "malformed_manifest");
  assert.equal(decide(validManifest({ attempt: 0 })), "malformed_manifest");
  // objectKey attempt segment not matching the manifest's own attempt.
  assert.equal(decide(validManifest({ objectKey: `${attemptPrefix(AUTH_ORG, JOB, 9)}out.bin` })), "malformed_manifest");
  // traversal in the key.
  assert.equal(decide(validManifest({ objectKey: `${attemptPrefix(AUTH_ORG, JOB, 1)}../../etc/passwd` })), "malformed_manifest");
});

test("isStructurallyValidManifest accepts the canonical manifest", () => {
  assert.equal(isStructurallyValidManifest(validManifest()), true);
});

test("verifyFixture throws when an accept vector is mutated to fail", () => {
  const fixture = loadFixture();
  const mutated = structuredClone(fixture);
  mutated.acceptVectors[0].actualSha256 = "0".repeat(64);
  assert.throws(() => verifyFixture(mutated), ArtifactCommitVectorError);
});

test("verifyFixture throws when a reject vector is mutated to accept", () => {
  const fixture = loadFixture();
  const mutated = structuredClone(fixture);
  // Repair the hash_mismatch reject so it would ACCEPT — the checker must catch it.
  const hm = mutated.rejectVectors.find((r) => r.name === "hash_mismatch");
  hm.actualSha256 = hm.manifest.sha256;
  assert.throws(() => verifyFixture(mutated), ArtifactCommitVectorError);
});

test("verifyFixture throws when a reject vector's reason label is wrong", () => {
  const fixture = loadFixture();
  const mutated = structuredClone(fixture);
  mutated.rejectVectors.find((r) => r.name === "hash_mismatch").reason = "size_mismatch";
  assert.throws(() => verifyFixture(mutated), ArtifactCommitVectorError);
});
