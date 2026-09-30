/**
 * DSK-004 Lane A / I1 + I2 + I3 — only a signed, non-revoked, correctly-targeted update
 * installs.
 *
 * The interesting cases are not "a good update is admitted" but the ways one can look
 * almost right:
 *
 *   I2 — A SIGNATURE IS FOR ONE TRANSITION, not for a build. Binding `fromVersion` as well
 *   as `toVersion` is what stops a signature authorizing 0.1.0→0.1.1 from being replayed
 *   to authorize 0.1.0→0.9.9, or from being used to push a device BACKWARD onto a version
 *   whose bugs are known.
 *
 *   I3 — REVOCATION IS SEPARATE FROM SIGNING. A build that was correctly signed and later
 *   found to be broken must stop installing without anyone re-keying anything. That is a
 *   deny-list at admission, and it is deliberately not JOB-007's target revocation: those
 *   answer different questions, and conflating them would mean revoking a bad build
 *   required revoking every device running it.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, it } from "node:test";

import {
  canonicalUpdatePayload,
  evaluateUpdateAdmission,
} from "../update-admission.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const trustRoot = publicKey.export({ type: "spki", format: "pem" }).toString();

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;

const TRANSITION = {
  digest: DIGEST,
  fromVersion: "0.1.0",
  toVersion: "0.1.1",
  platform: "win32",
};

function signFor(t) {
  return cryptoSign("sha256", Buffer.from(canonicalUpdatePayload(t), "utf8"), privateKey)
    .toString("base64");
}

const good = () => ({
  ...TRANSITION,
  signature: signFor(TRANSITION),
  trustRoot,
  revokedVersions: [],
});

describe("DSK-004/I1 — a correct update is admitted", () => {
  it("admits a signed, compatible, non-revoked transition", () => {
    // Non-vacuity for every refusal below.
    assert.deepEqual(evaluateUpdateAdmission(good()), { admitted: true });
  });
});

describe("DSK-004/I1 — signature failures", () => {
  it("refuses a missing signature", () => {
    assert.equal(evaluateUpdateAdmission({ ...good(), signature: "" }).reason, "missing_signature");
  });

  it("refuses a signature from the wrong key", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const forged = cryptoSign("sha256", Buffer.from(canonicalUpdatePayload(TRANSITION), "utf8"),
      other.privateKey).toString("base64");
    assert.equal(evaluateUpdateAdmission({ ...good(), signature: forged }).reason, "signature_invalid");
  });

  it("refuses a missing trust root rather than skipping verification", () => {
    assert.equal(evaluateUpdateAdmission({ ...good(), trustRoot: undefined }).reason, "missing_trust_root");
  });

  it("refuses a malformed digest", () => {
    assert.equal(evaluateUpdateAdmission({ ...good(), digest: "nope" }).reason, "malformed_digest");
  });
});

describe("DSK-004/I2 — a signature authorizes ONE transition", () => {
  it("refuses a signature made for a different toVersion", () => {
    // The replay this binding exists to stop: 0.1.0→0.1.1 must not authorize 0.1.0→0.9.9.
    const result = evaluateUpdateAdmission({
      ...good(), toVersion: "0.9.9", signature: signFor({ ...TRANSITION, toVersion: "0.1.1" }),
    });
    assert.equal(result.reason, "signature_invalid");
  });

  it("refuses a signature made for a different fromVersion", () => {
    // Binding the SOURCE matters as much: without it, an update signed for one starting
    // point could be applied from any other, including pushing a device backward onto a
    // version whose bugs are known.
    const result = evaluateUpdateAdmission({
      ...good(), fromVersion: "0.0.9", signature: signFor(TRANSITION),
    });
    assert.equal(result.reason, "signature_invalid");
  });

  it("refuses a signature made for a different platform", () => {
    const result = evaluateUpdateAdmission({
      ...good(), platform: "darwin", signature: signFor(TRANSITION),
    });
    assert.equal(result.reason, "signature_invalid");
  });

  it("refuses a signature made over different bytes", () => {
    const result = evaluateUpdateAdmission({ ...good(), digest: OTHER_DIGEST });
    assert.equal(result.reason, "signature_invalid");
  });

  it("refuses a no-op transition", () => {
    // from == to is not an update. Admitting it would let a signature be replayed
    // indefinitely against a device already on that version.
    const t = { ...TRANSITION, fromVersion: "0.1.1", toVersion: "0.1.1" };
    const result = evaluateUpdateAdmission({
      ...good(), ...t, signature: signFor(t),
    });
    assert.equal(result.reason, "no_op_transition");
  });
});

describe("DSK-004/I3 — a revoked version never installs", () => {
  it("refuses a correctly-signed update TO a revoked version", () => {
    // The whole point: a build found broken after signing must stop installing without
    // anyone re-keying anything.
    const result = evaluateUpdateAdmission({ ...good(), revokedVersions: ["0.1.1"] });
    assert.deepEqual(result, { admitted: false, reason: "version_revoked" });
  });

  it("refuses even when the revoked version is one of several", () => {
    const result = evaluateUpdateAdmission({
      ...good(), revokedVersions: ["0.0.1", "0.1.1", "0.2.0"],
    });
    assert.equal(result.reason, "version_revoked");
  });

  it("does NOT refuse for an unrelated revoked version — non-vacuity", () => {
    assert.deepEqual(
      evaluateUpdateAdmission({ ...good(), revokedVersions: ["0.0.1", "0.2.0"] }),
      { admitted: true },
    );
  });

  it("refuses when the deny-list is absent rather than assuming none", () => {
    // A caller that could not fetch the deny-list has not proven the build is allowed.
    // Treating "unknown" as "not revoked" is how a revoked build installs during an
    // outage of whatever serves the list.
    assert.equal(
      evaluateUpdateAdmission({ ...good(), revokedVersions: undefined }).reason,
      "missing_revocation_list",
    );
  });

  it("checks revocation BEFORE the signature", () => {
    // A revoked build is refused whether or not its signature checks out, and the
    // refusal names revocation — an operator chasing "signature_invalid" on a build that
    // was simply withdrawn would be looking in the wrong place entirely.
    const result = evaluateUpdateAdmission({
      ...good(), signature: "garbage", revokedVersions: ["0.1.1"],
    });
    assert.equal(result.reason, "version_revoked");
  });
});

describe("DSK-004 — the canonical payload is the contract", () => {
  it("binds digest, fromVersion, toVersion and platform", () => {
    const payload = canonicalUpdatePayload(TRANSITION);
    for (const part of [DIGEST, "0.1.0", "0.1.1", "win32"]) {
      assert.ok(payload.includes(part), part);
    }
  });

  it("changes when ANY of the four changes", () => {
    const base = canonicalUpdatePayload(TRANSITION);
    const variants = [
      canonicalUpdatePayload({ ...TRANSITION, digest: OTHER_DIGEST }),
      canonicalUpdatePayload({ ...TRANSITION, fromVersion: "0.0.9" }),
      canonicalUpdatePayload({ ...TRANSITION, toVersion: "0.9.9" }),
      canonicalUpdatePayload({ ...TRANSITION, platform: "darwin" }),
    ];
    assert.equal(new Set([base, ...variants]).size, 5);
  });

  it("is byte-stable", () => {
    assert.equal(canonicalUpdatePayload(TRANSITION), canonicalUpdatePayload(TRANSITION));
  });

  it("is DISTINCT from the installer payload for the same digest", () => {
    // An installer signature must not double as an update signature: installing a build
    // fresh and transitioning onto it from a specific version are different
    // authorizations.
    assert.ok(!canonicalUpdatePayload(TRANSITION).includes("aoa desktop installer signature"));
  });
});
