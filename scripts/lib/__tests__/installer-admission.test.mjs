/**
 * DSK-003 Lane D / I9 — a tampered or unsigned installer is refused.
 *
 * Signed with a TEST key generated in-test, exactly as DEP-001's image verifier is signed
 * with a test cosign key. REL-004 swaps in release roots; nothing here changes.
 *
 * The interesting cases are not "a good artifact is admitted" but the ways an artifact
 * can look almost right: signed but never released, released but tampered, signed for a
 * different platform, signed at a different version.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, it } from "node:test";

import {
  INSTALLER_PLATFORMS,
  canonicalInstallerPayload,
  evaluateInstallerAdmission,
} from "../installer-admission.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const trustRoot = publicKey.export({ type: "spki", format: "pem" }).toString();

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function signFor({ digest, version, platform }) {
  const payload = canonicalInstallerPayload({ digest, version, platform });
  return cryptoSign("sha256", Buffer.from(payload, "utf8"), privateKey).toString("base64");
}

const RELEASED = { digest: DIGEST_A, version: "1.2.3", platform: "darwin" };
const allowlist = [RELEASED];

const good = () => ({
  ...RELEASED,
  signature: signFor(RELEASED),
  allowlist,
  trustRoot,
});

describe("DSK-003/I9 — a correct artifact is admitted", () => {
  it("admits a released, correctly signed installer", () => {
    // Non-vacuity for every refusal below: without this, a function that always refused
    // would pass the entire rest of this file.
    assert.deepEqual(evaluateInstallerAdmission(good()), { admitted: true });
  });

  it("admits on every supported platform", () => {
    for (const platform of INSTALLER_PLATFORMS) {
      const released = { digest: DIGEST_A, version: "1.2.3", platform };
      const result = evaluateInstallerAdmission({
        ...released,
        signature: signFor(released),
        allowlist: [released],
        trustRoot,
      });
      assert.deepEqual(result, { admitted: true }, platform);
    }
  });
});

describe("DSK-003/I9 — every way an artifact can be wrong is refused", () => {
  const cases = [
    ["malformed_digest", { digest: "not-a-digest" }],
    ["malformed_digest", { digest: "sha256:TOOSHORT" }],
    ["missing_version", { version: "" }],
    ["unsupported_platform", { platform: "linux" }],
    ["unsupported_platform", { platform: "" }],
    ["missing_trust_root", { trustRoot: undefined }],
    ["missing_trust_root", { trustRoot: "not a pem" }],
    ["missing_allowlist", { allowlist: undefined }],
    ["missing_signature", { signature: "" }],
  ];

  for (const [reason, override] of cases) {
    it(`refuses with ${reason} for ${JSON.stringify(override)}`, () => {
      const result = evaluateInstallerAdmission({ ...good(), ...override });
      assert.equal(result.admitted, false);
      assert.equal(result.reason, reason);
    });
  }

  it("refuses a signed build that was never released", () => {
    // The allowlist is the record of what was PROMOTED. A valid signature is not
    // authority to install: an internal or withdrawn build carries one too.
    const unreleased = { digest: DIGEST_B, version: "1.2.3", platform: "darwin" };
    const result = evaluateInstallerAdmission({
      ...unreleased, signature: signFor(unreleased), allowlist, trustRoot,
    });
    assert.deepEqual(result, { admitted: false, reason: "digest_not_allowlisted" });
  });

  it("refuses a TAMPERED artifact — the digest no longer matches what was signed", () => {
    const result = evaluateInstallerAdmission({
      ...good(), digest: DIGEST_B, allowlist: [{ ...RELEASED, digest: DIGEST_B }],
    });
    assert.deepEqual(result, { admitted: false, reason: "signature_invalid" });
  });

  it("refuses a signature made for a DIFFERENT version", () => {
    // Binding the version stops a signature being replayed onto a later release.
    const result = evaluateInstallerAdmission({
      ...good(),
      signature: signFor({ ...RELEASED, version: "9.9.9" }),
    });
    assert.deepEqual(result, { admitted: false, reason: "signature_invalid" });
  });

  it("refuses a signature made for a DIFFERENT platform", () => {
    // The reason platform is in the payload: without it, a signature over a macOS
    // artifact would verify against a Windows entry carrying the same digest.
    const result = evaluateInstallerAdmission({
      ...good(),
      signature: signFor({ ...RELEASED, platform: "win32" }),
    });
    assert.deepEqual(result, { admitted: false, reason: "signature_invalid" });
  });

  it("refuses when the allowlist entry disagrees with the claim", () => {
    assert.equal(
      evaluateInstallerAdmission({ ...good(), version: "1.2.4", allowlist }).reason,
      "version_mismatch",
    );
    assert.equal(
      evaluateInstallerAdmission({
        ...good(), platform: "win32", allowlist,
      }).reason,
      "platform_mismatch",
    );
  });

  it("refuses a signature from the WRONG key", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const payload = canonicalInstallerPayload(RELEASED);
    const forged = cryptoSign("sha256", Buffer.from(payload, "utf8"), other.privateKey)
      .toString("base64");
    assert.deepEqual(evaluateInstallerAdmission({ ...good(), signature: forged }),
      { admitted: false, reason: "signature_invalid" });
  });

  it("rejects the WHOLE allowlist when any entry is malformed", () => {
    // The documented rule, which was undocumented-by-test until a mutant walked through
    // it: a malformed release record is not trustworthy, and skipping the bad row would
    // admit everything else on a list nobody can vouch for. The good entry here is the
    // one that would otherwise be admitted.
    const malformed = [
      [RELEASED, { digest: "not-a-digest", version: "1.0.0", platform: "darwin" }],
      [RELEASED, { digest: DIGEST_B, version: "", platform: "darwin" }],
      [RELEASED, { digest: DIGEST_B, version: "1.0.0", platform: "linux" }],
      [RELEASED, null],
      [RELEASED, "not an object"],
    ];
    for (const entries of malformed) {
      const result = evaluateInstallerAdmission({ ...good(), allowlist: entries });
      assert.deepEqual(result, { admitted: false, reason: "missing_allowlist" },
        JSON.stringify(entries[1]));
    }
  });

  it("still admits when every entry is well formed — non-vacuity", () => {
    // Without this, a normalizer that always returned null would pass the case above.
    const entries = [RELEASED, { digest: DIGEST_B, version: "2.0.0", platform: "win32" }];
    assert.deepEqual(evaluateInstallerAdmission({ ...good(), allowlist: entries }),
      { admitted: true });
  });

  it("accepts the { entries: [...] } wrapper as well as a bare array", () => {
    assert.deepEqual(evaluateInstallerAdmission({ ...good(), allowlist: { entries: allowlist } }),
      { admitted: true });
  });

  it("never throws for caller-supplied garbage", () => {
    for (const bad of [undefined, null, "", 0, [], { digest: 42 }, { allowlist: 7 }]) {
      const result = evaluateInstallerAdmission(bad);
      assert.equal(result.admitted, false, JSON.stringify(bad));
    }
  });
});

describe("DSK-003/I9 — the canonical payload is the contract", () => {
  it("binds digest, version and platform together", () => {
    const payload = canonicalInstallerPayload(RELEASED);
    assert.ok(payload.includes(DIGEST_A));
    assert.ok(payload.includes("1.2.3"));
    assert.ok(payload.includes("darwin"));
  });

  it("changes when ANY of the three changes", () => {
    const base = canonicalInstallerPayload(RELEASED);
    const variants = [
      canonicalInstallerPayload({ ...RELEASED, digest: DIGEST_B }),
      canonicalInstallerPayload({ ...RELEASED, version: "1.2.4" }),
      canonicalInstallerPayload({ ...RELEASED, platform: "win32" }),
    ];
    for (const v of variants) assert.notEqual(v, base);
    assert.equal(new Set([base, ...variants]).size, 4);
  });

  it("is byte-stable for the same input", () => {
    assert.equal(canonicalInstallerPayload(RELEASED), canonicalInstallerPayload(RELEASED));
  });
});
