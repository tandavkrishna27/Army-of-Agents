import assert from "node:assert/strict";
import test from "node:test";

import {
  SnapshotVectorError,
  deriveContentRevision,
  deriveManifestHash,
  isSafeWorkspacePath,
  loadFixture,
  referenceCanonicalize,
  sha256Hex,
  validateManifestStructure,
  verifyFixture,
} from "./check-workspace-snapshot-vectors.mjs";

test("the checked-in fixture passes the reference checker", () => {
  const fixture = loadFixture();
  const count = verifyFixture(fixture);
  assert.ok(count >= 2);
});

test("reference canonicalization sorts keys by UTF-16 code units and preserves array order", () => {
  assert.equal(referenceCanonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(referenceCanonicalize([3, 1, 2]), "[3,1,2]");
});

test("reference canonicalization rejects floats and unsafe integers", () => {
  assert.throws(() => referenceCanonicalize(1.5), SnapshotVectorError);
  assert.throws(() => referenceCanonicalize(Number.MAX_SAFE_INTEGER + 1), SnapshotVectorError);
});

test("isSafeWorkspacePath rejects traversal, absolute, backslash, colon, control", () => {
  assert.equal(isSafeWorkspacePath("a/b.txt"), true);
  assert.equal(isSafeWorkspacePath("../x"), false);
  assert.equal(isSafeWorkspacePath("/abs"), false);
  assert.equal(isSafeWorkspacePath("a\\b"), false);
  assert.equal(isSafeWorkspacePath("c:/x"), false);
  assert.equal(isSafeWorkspacePath("a\u0000b"), false);
});

test("deriveContentRevision matches the stored value for each positive vector", () => {
  const fixture = loadFixture();
  for (const v of fixture.positiveVectors) {
    assert.equal(deriveContentRevision(v.manifest), v.contentRevision, v.name);
    assert.equal(deriveManifestHash(v.manifest), v.manifestHash, v.name);
  }
});

test("mutating a single entry byte changes the manifestHash", () => {
  const fixture = loadFixture();
  const clone = structuredClone(fixture.positiveVectors[0].manifest);
  clone.entries[0].sizeBytes += 1;
  assert.notEqual(deriveManifestHash(clone), fixture.positiveVectors[0].manifestHash);
});

test("verifyFixture rejects a positive vector whose stored manifestHash is wrong", () => {
  const fixture = structuredClone(loadFixture());
  fixture.positiveVectors[0].manifestHash = sha256Hex("nope");
  assert.throws(() => verifyFixture(fixture), /manifestHash != reference derivation/);
});

test("verifyFixture rejects a positive vector whose stored contentRevision is wrong", () => {
  const fixture = structuredClone(loadFixture());
  fixture.positiveVectors[0].contentRevision = sha256Hex("nope");
  assert.throws(() => verifyFixture(fixture), /contentRevision != reference derivation/);
});

test("verifyFixture rejects a reject-input that the validator actually ACCEPTS", () => {
  const fixture = structuredClone(loadFixture());
  fixture.rejectInputs[0].manifest = structuredClone(fixture.positiveVectors[0].manifest);
  assert.throws(() => verifyFixture(fixture), /ACCEPTED a manifest that must be rejected/);
});

test("each stored reject input is independently rejected by the validator", () => {
  const fixture = loadFixture();
  for (const r of fixture.rejectInputs) {
    assert.throws(() => validateManifestStructure(r.manifest), SnapshotVectorError, r.name);
  }
});

test("validateManifestStructure rejects an unsorted entry list", () => {
  const fixture = loadFixture();
  const clone = structuredClone(fixture.positiveVectors[0].manifest);
  clone.entries.reverse();
  assert.throws(() => validateManifestStructure(clone), /not sorted/);
});
