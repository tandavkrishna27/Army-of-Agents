import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkspacePatchVectorError,
  compareUtf8,
  decideApply,
  diffManifests,
  loadFixture,
  operationsEqual,
  verifyFixture,
} from "./check-workspace-patch-vectors.mjs";

function file(path, sha256, sizeBytes = 1) {
  return { path, kind: "file", sha256, sizeBytes };
}

test("the checked-in fixture passes the reference checker", () => {
  const { diffs, applies } = verifyFixture(loadFixture());
  assert.ok(diffs >= 3);
  assert.ok(applies >= 3);
});

test("compareUtf8 orders by byte value (uppercase before lowercase)", () => {
  assert.equal(compareUtf8("A", "a") < 0, true);
  assert.equal(compareUtf8("a", "b") < 0, true);
  assert.equal(compareUtf8("b", "b"), 0);
});

test("diffManifests emits create/modify/delete sorted by destination path", () => {
  const ops = diffManifests(
    [file("keep", "s"), file("mod", "old"), file("gone", "g")],
    [file("keep", "s"), file("mod", "new"), file("new", "n")],
  );
  assert.deepEqual(ops, [
    { op: "delete", path: "gone" },
    { op: "modify", path: "mod", resultSha256: "new", sizeBytes: 1 },
    { op: "create", path: "new", resultSha256: "n", sizeBytes: 1 },
  ]);
});

test("diffManifests folds a 1:1 content-identical move into one rename", () => {
  const ops = diffManifests([file("old", "X", 5)], [file("new", "X", 5)]);
  assert.deepEqual(ops, [{ op: "rename", fromPath: "old", path: "new", resultSha256: "X", sizeBytes: 5 }]);
});

test("diffManifests does NOT fold an ambiguous 2-delete/1-create same-sha group", () => {
  const ops = diffManifests([file("a", "d"), file("b", "d")], [file("c", "d")]);
  const kinds = ops.map((o) => `${o.op}:${o.path}`).sort();
  assert.deepEqual(kinds, ["create:c", "delete:a", "delete:b"]);
  assert.equal(ops.some((o) => o.op === "rename"), false);
});

test("diffManifests ignores directory entries", () => {
  const ops = diffManifests(
    [{ path: "src", kind: "directory", sha256: null, sizeBytes: 0 }],
    [{ path: "src", kind: "directory", sha256: null, sizeBytes: 0 }, file("src/x", "x")],
  );
  assert.deepEqual(ops, [{ op: "create", path: "src/x", resultSha256: "x", sizeBytes: 1 }]);
});

test("diffManifests is deterministic across runs", () => {
  const a = diffManifests([file("z", "z"), file("m", "old")], [file("m", "new"), file("a", "a")]);
  const b = diffManifests([file("z", "z"), file("m", "old")], [file("m", "new"), file("a", "a")]);
  assert.equal(operationsEqual(a, b), true);
});

test("decideApply applies iff a non-null accepted base equals the patch base", () => {
  assert.equal(decideApply("h1", "h1"), "applied");
  assert.equal(decideApply("h1", "h2"), "conflict_quarantined");
  assert.equal(decideApply("h1", null), "conflict_quarantined");
  assert.equal(decideApply("h1", undefined), "conflict_quarantined");
});

test("verifyFixture throws when a diff vector's expected operations are wrong", () => {
  const fixture = loadFixture();
  const mutated = structuredClone(fixture);
  mutated.diffVectors[0].operations.push({ op: "delete", path: "bogus" });
  assert.throws(() => verifyFixture(mutated), WorkspacePatchVectorError);
});

test("verifyFixture throws when an apply vector's expected decision is wrong", () => {
  const fixture = loadFixture();
  const mutated = structuredClone(fixture);
  const match = mutated.applyVectors.find((v) => v.name === "base_matches_applies");
  match.decision = "conflict_quarantined";
  assert.throws(() => verifyFixture(mutated), WorkspacePatchVectorError);
});
