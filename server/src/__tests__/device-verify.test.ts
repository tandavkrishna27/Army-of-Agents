// E11 M2 — the enrolment-key verify is a NON-VACUOUS integrity check: it must go RED on a
// record the DB CHECK still admits. These tests prove all three verdicts, with the two
// failure modes pinned RED first so a change that made verify always-pass would be caught.
//
// The stored formats mirror the enrolment writer exactly: `devicePublicKey` is the SPKI DER
// as base64url; `deviceThumbprint` is lowercase-hex `sha256(SPKI DER)`.

import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyDeviceEnrolmentKey } from "../services/device-verify.js";
import { deriveDeviceThumbprint } from "../services/worker-device-proof.js";

function ed25519Material(): { devicePublicKey: string; deviceThumbprint: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    devicePublicKey: der.toString("base64url"),
    deviceThumbprint: createHash("sha256").update(der).digest("hex"),
  };
}

describe("verifyDeviceEnrolmentKey — RED cases first (a check that can fail)", () => {
  it("FAILS on a mismatched thumbprint: valid key, wrong stored thumbprint", () => {
    const { devicePublicKey } = ed25519Material();
    // A different-but-well-formed hex thumbprint — the DB `deviceIdentityValid` CHECK admits
    // this (both columns non-null), so only THIS re-derivation catches the inconsistency.
    const wrongThumbprint = "0".repeat(64);
    const result = verifyDeviceEnrolmentKey({ devicePublicKey, deviceThumbprint: wrongThumbprint });
    expect(result.verified).toBe(false);
    expect(result.thumbprintMatches).toBe(false);
    expect(result.keyValid).toBe(true);
  });

  it("FAILS on a malformed key: garbage bytes that are not an SPKI at all", () => {
    const result = verifyDeviceEnrolmentKey({
      devicePublicKey: "bm90LWEta2V5", // "not-a-key" — decodes, but not SPKI DER
      deviceThumbprint: "a".repeat(64),
    });
    expect(result.verified).toBe(false);
    expect(result.keyValid).toBe(false);
  });

  it("FAILS on a structurally valid but NON-Ed25519 key (a P-256 EC SPKI)", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const der = publicKey.export({ format: "der", type: "spki" });
    const result = verifyDeviceEnrolmentKey({
      devicePublicKey: der.toString("base64url"),
      // Even a thumbprint that matches the bytes must not pass — the key type is wrong.
      deviceThumbprint: createHash("sha256").update(der).digest("hex"),
    });
    expect(result.keyValid).toBe(false);
    expect(result.verified).toBe(false);
  });

  it("FAILS with an honest reason when key material is null (e.g. a revoked device)", () => {
    const result = verifyDeviceEnrolmentKey({ devicePublicKey: null, deviceThumbprint: null });
    expect(result.verified).toBe(false);
    expect(result.keyValid).toBe(false);
    expect(result.thumbprintMatches).toBe(false);
  });

  it("PASSES on a consistent record: valid Ed25519 SPKI whose thumbprint matches", () => {
    const { devicePublicKey, deviceThumbprint } = ed25519Material();
    const result = verifyDeviceEnrolmentKey({ devicePublicKey, deviceThumbprint });
    expect(result).toMatchObject({ verified: true, thumbprintMatches: true, keyValid: true });
    // The honest label: it scopes the claim to the enrolment record and explicitly
    // disclaims liveness / machine identity (E11-F005 stays open).
    expect(result.reason).toMatch(/enrolment record/i);
    expect(result.reason).toMatch(/does not prove the device is live/i);
  });

  it("accepts an upper-case stored thumbprint (case-insensitive hex compare)", () => {
    const { devicePublicKey, deviceThumbprint } = ed25519Material();
    const result = verifyDeviceEnrolmentKey({
      devicePublicKey,
      deviceThumbprint: deviceThumbprint.toUpperCase(),
    });
    expect(result.verified).toBe(true);
  });
});

describe("deriveDeviceThumbprint — the factored-out primitive", () => {
  it("matches sha256(SPKI DER) of the decoded base64url key", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" });
    expect(deriveDeviceThumbprint(der.toString("base64url")))
      .toBe(createHash("sha256").update(der).digest("hex"));
  });
});
