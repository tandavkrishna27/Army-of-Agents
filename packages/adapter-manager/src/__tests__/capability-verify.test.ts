// -----------------------------------------------------------------------------
// DEP-012 Slice 1 · Unit B1 — the adapter-manager capability VERIFY (DB-free).
//
// Load the pinned control-plane PUBLIC key; rebuild the canonical over ALL signed
// fields; verify(null,·); check audience + expiry (+ version). Fail-CLOSED: a bad
// signature / expired / wrong-audience / wrong-version / foreign-key capability is
// REFUSED — a valid one returns the caller's owned labels.
// -----------------------------------------------------------------------------

import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ResourceLabels } from "@armyofagents/worker-daemon";
import {
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  buildOwnedLabelsCapabilityCanonical,
  signOwnedLabelsCapability,
  type OwnedLabelsCapability,
  type OwnedLabelsCapabilitySignedFields,
} from "@armyofagents/provider-wire";

// DEP-011 §1.2.0 — the LEAF the mint (control plane) signs through. Importing the
// signer from the leaf DIRECTLY (not the provider-wire barrel) pins that a
// leaf-minted capability verifies here byte-for-byte: mint and verify share the ONE
// leaf `buildOwnedLabelsCapabilityCanonical`, so the re-home introduced no drift.
import { signOwnedLabelsCapability as signFromLeaf } from "@armyofagents/provider-capability";

import { CapabilityVerificationError, verifyOwnedLabelsCapability } from "../capability-verify.js";

const OWNED: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 7,
};

const NOW = 1_700_000_000_000;

const controlPlane = generateKeyPairSync("ed25519");

function mint(
  overrides: Partial<OwnedLabelsCapabilitySignedFields> = {},
  privateKey: KeyObject = controlPlane.privateKey,
): OwnedLabelsCapability {
  return signOwnedLabelsCapability(
    {
      v: OWNED_LABELS_CAPABILITY_VERSION,
      audience: OWNED_LABELS_CAPABILITY_AUDIENCE,
      ownedLabels: OWNED,
      expiresAt: NOW + 60_000,
      ...overrides,
    },
    privateKey,
  );
}

describe("verifyOwnedLabelsCapability — valid path", () => {
  it("returns the caller's owned labels for a well-formed, in-date, correctly-signed capability", () => {
    const labels = verifyOwnedLabelsCapability(mint(), controlPlane.publicKey, NOW);
    expect(labels).toEqual(OWNED);
  });

  it("accepts a capability minted through the provider-capability LEAF directly (re-home byte-parity)", () => {
    const leafMinted = signFromLeaf(
      {
        v: OWNED_LABELS_CAPABILITY_VERSION,
        audience: OWNED_LABELS_CAPABILITY_AUDIENCE,
        ownedLabels: OWNED,
        expiresAt: NOW + 60_000,
      },
      controlPlane.privateKey,
    );
    expect(verifyOwnedLabelsCapability(leafMinted, controlPlane.publicKey, NOW)).toEqual(OWNED);
  });
});

describe("verifyOwnedLabelsCapability — fail-closed", () => {
  it("refuses a capability signed by a FOREIGN key", () => {
    const foreign = generateKeyPairSync("ed25519");
    expect(() => verifyOwnedLabelsCapability(mint({}, foreign.privateKey), controlPlane.publicKey, NOW)).toThrow(
      CapabilityVerificationError,
    );
  });

  it("refuses a capability whose signed field was TAMPERED after minting (bad sig)", () => {
    const cap = mint();
    const tampered: OwnedLabelsCapability = { ...cap, ownedLabels: { ...cap.ownedLabels, workerId: "wkr-EVIL" } };
    expect(() => verifyOwnedLabelsCapability(tampered, controlPlane.publicKey, NOW)).toThrow(CapabilityVerificationError);
  });

  it("refuses an EXPIRED capability (expiresAt <= now)", () => {
    const cap = mint({ expiresAt: NOW - 1 });
    expect(() => verifyOwnedLabelsCapability(cap, controlPlane.publicKey, NOW)).toThrow(CapabilityVerificationError);
  });

  it("refuses a capability with the WRONG audience (correctly signed for another service)", () => {
    const cap = mint({ audience: "some-other-service" as typeof OWNED_LABELS_CAPABILITY_AUDIENCE });
    expect(() => verifyOwnedLabelsCapability(cap, controlPlane.publicKey, NOW)).toThrow(CapabilityVerificationError);
  });

  it("refuses an UNKNOWN version (a v:2 token at a v:1 verifier)", () => {
    const cap = mint({ v: 2 as typeof OWNED_LABELS_CAPABILITY_VERSION });
    expect(() => verifyOwnedLabelsCapability(cap, controlPlane.publicKey, NOW)).toThrow(CapabilityVerificationError);
  });

  it("refuses a non-Ed25519 public key (fail closed, never mis-verify)", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => verifyOwnedLabelsCapability(mint(), rsa.publicKey, NOW)).toThrow(CapabilityVerificationError);
  });

  it("refuses a NON-FINITE / NON-INTEGER expiresAt (fail-closed, not type-trusting)", () => {
    // A non-finite expiresAt canonicalizes to `null` via JSON.stringify and `!(Infinity > now)`
    // is always false — an immortal token. verify must reject it BEFORE trusting the compare,
    // even when correctly signed (a future mint must never be able to emit one). We hand-build
    // the signed token (the mint guard would otherwise refuse to produce it).
    for (const bad of [Infinity, -Infinity, NaN, 1.5]) {
      const signedFields = { v: OWNED_LABELS_CAPABILITY_VERSION, audience: OWNED_LABELS_CAPABILITY_AUDIENCE, ownedLabels: OWNED, expiresAt: bad };
      const canonical = buildOwnedLabelsCapabilityCanonical(signedFields);
      const sig = nodeSign(null, canonical, controlPlane.privateKey).toString("base64url");
      const cap = { ...signedFields, sig } as OwnedLabelsCapability;
      expect(() => verifyOwnedLabelsCapability(cap, controlPlane.publicKey, NOW)).toThrow(CapabilityVerificationError);
    }
  });

  it("accepts a capability that expires EXACTLY in the future and refuses one at the boundary", () => {
    expect(verifyOwnedLabelsCapability(mint({ expiresAt: NOW + 1 }), controlPlane.publicKey, NOW)).toEqual(OWNED);
    // expiresAt === now is expired (strict >): refuse.
    expect(() => verifyOwnedLabelsCapability(mint({ expiresAt: NOW }), controlPlane.publicKey, NOW)).toThrow(
      CapabilityVerificationError,
    );
  });
});
