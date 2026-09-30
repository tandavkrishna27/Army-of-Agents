#!/usr/bin/env node
/**
 * image-admission.test.mjs — fail-closed image-admission verifier corpus.
 *
 * Run with:
 *   node --test scripts/lib/__tests__/image-admission.test.mjs
 *
 * DEP-001 security core. `evaluateAdmission` admits ONLY an allowlisted image
 * digest whose detached signature (a cosign-style ECDSA-P256-over-SHA256
 * signature of the canonical simple-signing payload) verifies against the TEST
 * trust root AND whose source provenance matches the recorded revision. Every
 * other outcome — unsigned, tampered digest, forged signature, provenance
 * mismatch, non-allowlisted digest, malformed input — is rejected FAIL-CLOSED
 * (`admitted:false`, never a throw).
 *
 * The signer here uses the SAME canonical payload the verifier reconstructs
 * (`canonicalSigningPayload`), exactly as a real cosign signer and a cosign
 * verifier both agree on the simple-signing spec. No Docker, no network, no
 * real key material: each test mints an ephemeral P-256 keypair with node:crypto.
 *
 * Non-vacuousness: the "signature is load-bearing" test admits a valid bundle
 * and then proves the SAME bundle is rejected once the signature is removed or
 * forged — so a verifier that ignored the signature would redden here. The
 * ticket's genuine RED (a stub `evaluateAdmission` that returns
 * `{admitted:true}`) reddens every reject-case below.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import crypto from "node:crypto";

import { evaluateAdmission, canonicalSigningPayload } from "../image-admission.mjs";

// --------------------------------------------------------------------------
// Deterministic-shaped fixtures (values are random per run, structure fixed).
// --------------------------------------------------------------------------

const REVISION = "aff1b11c549c5d38e838b70e481b9d4a9c8908c1";
const CONTROL_DIGEST = `sha256:${"a".repeat(64)}`;
const WORKER_DIGEST = `sha256:${"b".repeat(64)}`;

function makeTrustRoot() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Sign the canonical simple-signing payload for a digest+revision (cosign-style). */
function signDigest(privateKey, { digest, sourceRevision }) {
  const payload = canonicalSigningPayload({ digest, sourceRevision });
  return crypto.sign("sha256", Buffer.from(payload, "utf8"), privateKey).toString("base64");
}

/**
 * A fully-valid admission bundle: a signed, allowlisted digest with matching
 * provenance and the trust root that signed it.
 */
function validBundle(overrides = {}) {
  const root = makeTrustRoot();
  const allowlist = {
    trustRootPem: root.publicKeyPem,
    entries: [
      { image: "control-plane", digest: CONTROL_DIGEST, sourceRevision: REVISION },
      { image: "worker", digest: WORKER_DIGEST, sourceRevision: REVISION },
    ],
  };
  const digest = overrides.digest ?? CONTROL_DIGEST;
  const provenance = overrides.provenance ?? { sourceRevision: REVISION };
  const signature =
    overrides.signature !== undefined
      ? overrides.signature
      : signDigest(root.privateKey, { digest, sourceRevision: provenance.sourceRevision });
  return {
    root,
    input: {
      digest,
      signature,
      provenance,
      allowlist,
      trustRoot: { publicKey: root.publicKeyPem },
      ...overrides.input,
    },
  };
}

// --------------------------------------------------------------------------
// Positive admission — the only path that returns admitted:true.
// --------------------------------------------------------------------------

test("admits a signed, allowlisted control-plane digest with matching provenance", () => {
  const { input } = validBundle();
  const result = evaluateAdmission(input);
  assert.equal(result.admitted, true, result.reason);
});

test("admits the worker image on its own allowlist entry", () => {
  const { root, input } = validBundle({ digest: WORKER_DIGEST });
  // re-sign for the worker digest with the same root
  input.signature = signDigest(root.privateKey, { digest: WORKER_DIGEST, sourceRevision: REVISION });
  const result = evaluateAdmission(input);
  assert.equal(result.admitted, true, result.reason);
});

// --------------------------------------------------------------------------
// Fail-closed rejections (each must be admitted:false, never throw).
// --------------------------------------------------------------------------

test("rejects an UNSIGNED digest (fail-closed)", () => {
  const { input } = validBundle({ signature: null });
  const result = evaluateAdmission(input);
  assert.equal(result.admitted, false);
  assert.match(result.reason, /unsigned/i);
});

test("rejects an empty-string signature (fail-closed)", () => {
  const { input } = validBundle({ signature: "" });
  assert.equal(evaluateAdmission(input).admitted, false);
});

test("rejects a TAMPERED digest that is no longer on the allowlist", () => {
  const { input } = validBundle();
  // flip one hex char so the digest is off-allowlist; signature was for the original
  input.digest = `sha256:c${"a".repeat(63)}`;
  const result = evaluateAdmission(input);
  assert.equal(result.admitted, false);
  assert.match(result.reason, /allowlist/i);
});

test("rejects an allowlisted digest whose signature was minted for a DIFFERENT digest", () => {
  const { root, input } = validBundle();
  // present the (allowlisted) control digest but a signature over the worker digest
  input.signature = signDigest(root.privateKey, { digest: WORKER_DIGEST, sourceRevision: REVISION });
  const result = evaluateAdmission(input);
  assert.equal(result.admitted, false);
  assert.match(result.reason, /signature/i);
});

test("rejects a signature by an UNTRUSTED key (forged, not the trust root)", () => {
  const { input } = validBundle();
  const attacker = makeTrustRoot();
  input.signature = signDigest(attacker.privateKey, {
    digest: CONTROL_DIGEST,
    sourceRevision: REVISION,
  });
  const result = evaluateAdmission(input);
  assert.equal(result.admitted, false);
  assert.match(result.reason, /signature/i);
});

test("rejects a WRONG-provenance digest (source revision mismatch vs allowlist)", () => {
  const { root, input } = validBundle();
  const otherRev = "0000000000000000000000000000000000000000";
  input.provenance = { sourceRevision: otherRev };
  // even a valid signature over the mismatched provenance must not admit
  input.signature = signDigest(root.privateKey, {
    digest: CONTROL_DIGEST,
    sourceRevision: otherRev,
  });
  const result = evaluateAdmission(input);
  assert.equal(result.admitted, false);
  assert.match(result.reason, /provenance/i);
});

test("rejects MISSING provenance (no source revision at all)", () => {
  const { input } = validBundle();
  // A valid signature exists, but no provenance is presented at admission time.
  input.provenance = null;
  const result = evaluateAdmission(input);
  assert.equal(result.admitted, false);
  assert.match(result.reason, /provenance/i);

  const noRev = validBundle();
  noRev.input.provenance = {};
  assert.equal(evaluateAdmission(noRev.input).admitted, false);
});

test("rejects a validly-signed digest that is NOT on the allowlist (admit-only-allowlisted)", () => {
  const root = makeTrustRoot();
  const strayDigest = `sha256:${"d".repeat(64)}`;
  const allowlist = {
    entries: [{ image: "control-plane", digest: CONTROL_DIGEST, sourceRevision: REVISION }],
  };
  const input = {
    digest: strayDigest,
    signature: signDigest(root.privateKey, { digest: strayDigest, sourceRevision: REVISION }),
    provenance: { sourceRevision: REVISION },
    allowlist,
    trustRoot: { publicKey: root.publicKeyPem },
  };
  const result = evaluateAdmission(input);
  assert.equal(result.admitted, false);
  assert.match(result.reason, /allowlist/i);
});

test("rejects a malformed digest (not sha256:<64hex>)", () => {
  const { input } = validBundle();
  input.digest = "not-a-digest";
  assert.equal(evaluateAdmission(input).admitted, false);
});

// --------------------------------------------------------------------------
// Non-vacuousness: the signature is load-bearing on an otherwise-valid bundle.
// A verifier that skipped signature checking would redden here.
// --------------------------------------------------------------------------

test("signature is load-bearing: valid bundle admits, same bundle without/with-forged signature is rejected", () => {
  const { root, input } = validBundle();
  assert.equal(evaluateAdmission(input).admitted, true);

  assert.equal(evaluateAdmission({ ...input, signature: undefined }).admitted, false);
  assert.equal(evaluateAdmission({ ...input, signature: null }).admitted, false);

  const attacker = makeTrustRoot();
  const forged = signDigest(attacker.privateKey, {
    digest: input.digest,
    sourceRevision: REVISION,
  });
  assert.equal(evaluateAdmission({ ...input, signature: forged }).admitted, false);
  // sanity: the ORIGINAL root still admits (we did not corrupt the bundle)
  assert.equal(evaluateAdmission(input).admitted, true);
  assert.ok(root.publicKeyPem.includes("PUBLIC KEY"));
});

// --------------------------------------------------------------------------
// Structural fail-closed: garbage inputs never throw and never admit.
// --------------------------------------------------------------------------

for (const [label, input] of [
  ["null", null],
  ["undefined", undefined],
  ["empty object", {}],
  ["number", 42],
  ["string", "admit please"],
  ["missing allowlist", { digest: CONTROL_DIGEST, signature: "x", provenance: { sourceRevision: REVISION }, trustRoot: {} }],
  ["missing trustRoot", { digest: CONTROL_DIGEST, signature: "x", provenance: { sourceRevision: REVISION }, allowlist: { entries: [] } }],
  ["allowlist not array", { digest: CONTROL_DIGEST, signature: "x", provenance: { sourceRevision: REVISION }, allowlist: { entries: 5 }, trustRoot: { publicKey: "x" } }],
]) {
  test(`fail-closed on garbage input: ${label}`, () => {
    let result;
    assert.doesNotThrow(() => {
      result = evaluateAdmission(input);
    });
    assert.equal(result.admitted, false, `must not admit ${label}`);
    assert.equal(typeof result.reason, "string");
  });
}

test("a corrupt PEM trust root is a rejection, not a crash", () => {
  const { input } = validBundle();
  input.trustRoot = { publicKey: "-----BEGIN PUBLIC KEY-----\nnonsense\n-----END PUBLIC KEY-----\n" };
  let result;
  assert.doesNotThrow(() => {
    result = evaluateAdmission(input);
  });
  assert.equal(result.admitted, false);
});

// --------------------------------------------------------------------------
// canonicalSigningPayload is deterministic and binds digest + revision.
// --------------------------------------------------------------------------

test("canonicalSigningPayload is deterministic and binds digest + revision", () => {
  const a = canonicalSigningPayload({ digest: CONTROL_DIGEST, sourceRevision: REVISION });
  const b = canonicalSigningPayload({ digest: CONTROL_DIGEST, sourceRevision: REVISION });
  assert.equal(a, b);
  assert.notEqual(
    a,
    canonicalSigningPayload({ digest: WORKER_DIGEST, sourceRevision: REVISION }),
  );
  assert.notEqual(
    a,
    canonicalSigningPayload({ digest: CONTROL_DIGEST, sourceRevision: "deadbeef" }),
  );
  assert.ok(a.includes(CONTROL_DIGEST));
});
