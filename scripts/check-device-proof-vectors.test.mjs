import assert from "node:assert/strict";
import test from "node:test";

import {
  DeviceProofReferenceError,
  loadFixture,
  referenceCanonical,
  verifyFixture,
} from "./check-device-proof-vectors.mjs";

/** A minimal structurally-valid fixture built from the reference canonicalizer. */
function validFixture() {
  const input = {
    method: "post",
    path: "/api/worker-control/../worker-control/enroll?x=1",
    bodyDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    correlationId: "00000000-0000-4000-8000-000000000101",
    issuedAt: "2026-08-10T00:00:00.000Z",
    proofId: "proof-0000000000000001",
  };
  return {
    version: "1",
    prefix: "AOA-DEVICE-PROOF-V1",
    canonicalVectors: [{ name: "v1", input, canonical: referenceCanonical(input) }],
    rejectInputs: [
      {
        name: "bad-digest",
        input: { ...input, bodyDigest: "nope" },
      },
    ],
  };
}

test("the checked-in fixture passes the reference checker", () => {
  const fixture = loadFixture();
  const count = verifyFixture(fixture);
  assert.ok(count >= 1);
});

test("a structurally-valid synthetic fixture passes", () => {
  assert.equal(verifyFixture(validFixture()), 1);
});

test("rejects a positive vector whose stored canonical is wrong", () => {
  const f = validFixture();
  f.canonicalVectors[0].canonical = f.canonicalVectors[0].canonical.replace("POST", "PUT");
  assert.throws(() => verifyFixture(f), /does not match the reference derivation/);
});

test("rejects a canonical that is missing the prefix line", () => {
  const f = validFixture();
  f.canonicalVectors[0].canonical = f.canonicalVectors[0].canonical.split("\n").slice(1).join("\n");
  assert.throws(() => verifyFixture(f), DeviceProofReferenceError);
});

test("rejects a canonical with the wrong field count", () => {
  const f = validFixture();
  f.canonicalVectors[0].canonical += "\nextra-field";
  assert.throws(() => verifyFixture(f), /exactly 7/);
});

test("rejects a positive vector whose input the reference canonicalizer refuses", () => {
  const f = validFixture();
  f.canonicalVectors[0].input = { ...f.canonicalVectors[0].input, bodyDigest: "not-hex" };
  assert.throws(() => verifyFixture(f), /rejected a positive input/);
});

test("rejects a rejectInputs entry that the reference actually ACCEPTS", () => {
  const f = validFixture();
  // Replace the bad-digest reject with a fully valid input — must be caught.
  f.rejectInputs[0].input = { ...f.canonicalVectors[0].input };
  assert.throws(() => verifyFixture(f), /ACCEPTED an input that must be rejected/);
});

test("rejects a wrong version or prefix", () => {
  const f1 = validFixture();
  f1.version = "2";
  assert.throws(() => verifyFixture(f1), /version must be/);
  const f2 = validFixture();
  f2.prefix = "WRONG";
  assert.throws(() => verifyFixture(f2), /prefix must be/);
});

test("rejects duplicate vector names", () => {
  const f = validFixture();
  f.rejectInputs[0].name = "v1";
  assert.throws(() => verifyFixture(f), /duplicate name/);
});

test("reference canonicalizer resolves . and .. segments and strips the query", () => {
  const canonical = referenceCanonical({
    method: "GET",
    path: "/api/a/b/../../worker-control/poll?ignored=1#frag",
    bodyDigest: "f".repeat(64),
    correlationId: "c",
    issuedAt: "2026-08-10T00:00:00.000Z",
    proofId: "proof-poll-0000000000003",
  });
  assert.equal(canonical.split("\n")[2], "/api/worker-control/poll");
});

test("reference canonicalizer rejects a protocol-relative foreign origin", () => {
  assert.throws(
    () =>
      referenceCanonical({
        method: "POST",
        path: "//evil.example/x",
        bodyDigest: "0".repeat(63) + "1",
        correlationId: "c",
        issuedAt: "2026-08-10T00:00:00.000Z",
        proofId: "proof-000000000000001",
      }),
    /foreign origin/,
  );
});
