// server/src/services/device-verify.ts
//
// E11 M2 — VERIFY ENROLMENT KEY. A read-only re-derivation over an already-enrolled
// device's STORED key material. It changes no state and adds no machine attestation.
//
// ── WHAT IT PROVES, AND WHAT IT DELIBERATELY DOES NOT (E11-F005, open Q2) ──────────────
//
// It answers exactly one question: is the enrolment RECORD internally consistent? That is:
//   • `keyValid`          — the stored `devicePublicKey` decodes as a structurally valid
//                           Ed25519 SPKI public key, and
//   • `thumbprintMatches` — `sha256(SPKI DER)` of that stored key equals the stored
//                           `deviceThumbprint`.
//   • `verified`          — both of the above.
//
// The DB `workers_device_identity_check` only guarantees these columns are NON-NULL for a
// non-revoked row; it does NOT guarantee the key and its thumbprint are mutually consistent.
// So this is a REAL integrity check with a reachable failure mode — a row can satisfy the
// CHECK and still fail here.
//
// It does NOT claim the device is live, reachable right now, authentic-at-this-moment, or a
// distinct physical machine. Machine attestation is E11-F005 / open question Q2 and is NOT
// built. The UI label is "Verify enrolment key" and the reason strings stay within
// "enrolment record" language for exactly this reason.

import { createPublicKey } from "node:crypto";

import { deriveDeviceThumbprint } from "./worker-device-proof.js";

export interface DeviceKeyVerification {
  /** keyValid && thumbprintMatches — the enrolment record's key integrity holds. */
  readonly verified: boolean;
  /** `sha256(SPKI DER)` of the stored key equals the stored thumbprint. */
  readonly thumbprintMatches: boolean;
  /** The stored key decodes as a structurally valid Ed25519 SPKI public key. */
  readonly keyValid: boolean;
  /** Operator-facing, enrolment-record-scoped explanation. Never claims live/authentic. */
  readonly reason: string;
}

/** The stored enrolment key material for one device — read server-side, never emitted. */
export interface StoredDeviceKeyMaterial {
  readonly devicePublicKey: string | null;
  readonly deviceThumbprint: string | null;
}

/** Constant-ish-time hex equality: equal length AND every char equal. Avoids leaking the
 *  position of a first-mismatched byte through early return. Both inputs are lowercase hex
 *  of the same expected length (64), so a plain length + accumulate compare is sufficient. */
function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Re-derive and compare, purely, over already-stored bytes.
 *
 * Pure (no DB, no clock): the route loads the stored material and passes it here, which is
 * what lets the unit test prove the RED cases (mismatched thumbprint, malformed key) without
 * a database.
 */
export function verifyDeviceEnrolmentKey(
  material: StoredDeviceKeyMaterial,
): DeviceKeyVerification {
  if (!material.devicePublicKey || !material.deviceThumbprint) {
    // A revoked device may legitimately have null key material (the CHECK exempts revoked
    // rows). There is nothing to re-derive, so this is an honest "cannot verify", not a pass.
    return {
      verified: false,
      thumbprintMatches: false,
      keyValid: false,
      reason: "The enrolment record has no stored device key to verify (it may be revoked).",
    };
  }

  let keyValid = false;
  try {
    const der = Buffer.from(material.devicePublicKey, "base64url");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    keyValid = key.asymmetricKeyType === "ed25519";
  } catch {
    keyValid = false;
  }
  if (!keyValid) {
    return {
      verified: false,
      thumbprintMatches: false,
      keyValid: false,
      reason: "The stored device key is not a structurally valid Ed25519 public key.",
    };
  }

  const derived = deriveDeviceThumbprint(material.devicePublicKey);
  const thumbprintMatches = hexEquals(derived, material.deviceThumbprint.toLowerCase());
  return {
    verified: thumbprintMatches,
    thumbprintMatches,
    keyValid: true,
    reason: thumbprintMatches
      ? "The enrolment record is consistent: the stored key is a valid Ed25519 SPKI and its thumbprint matches. This checks the enrolment record only — it does not prove the device is live or a distinct machine."
      : "The stored device thumbprint does not match the SHA-256 of the stored public key — the enrolment record is inconsistent.",
  };
}
