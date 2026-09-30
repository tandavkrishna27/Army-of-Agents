// -----------------------------------------------------------------------------
// DEP-012 Slice 1 · Unit B1 — the owned-labels capability schema + canonical + signer.
//
// The capability is a SIGNED ORDERED TUPLE (never a hash — a hash gate is a
// canonicalization bypass, R2). This suite pins:
//   - a sign -> verify round-trip over the UNAMBIGUOUS canonical of ALL signed
//     fields (v, audience, ownedLabels, expiresAt);
//   - tamper-evidence: mutating ANY signed field (incl. any ownedLabels sub-field)
//     breaks verify — proving the canonical covers every field, field-wise.
//
// The verify here is node:crypto `verify(null, ...)` over the SHARED canonical
// builder, so the schema's tamper-evidence is proven without the adapter-manager
// policy verify (that is a separate, adapter-manager concern).
// -----------------------------------------------------------------------------

import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ResourceLabels } from "@armyofagents/worker-daemon";

import {
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  buildOwnedLabelsCapabilityCanonical,
  signOwnedLabelsCapability,
  type OwnedLabelsCapability,
} from "../capability.js";

const OWNED: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 7,
};

const FIXED_NOW = 1_700_000_000_000;

function mint(overrides: Partial<Omit<OwnedLabelsCapability, "sig">> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const cap = signOwnedLabelsCapability(
    {
      v: OWNED_LABELS_CAPABILITY_VERSION,
      audience: OWNED_LABELS_CAPABILITY_AUDIENCE,
      ownedLabels: OWNED,
      expiresAt: FIXED_NOW + 60_000,
      ...overrides,
    },
    privateKey,
  );
  return { cap, publicKey };
}

/** Low-level signature check over the shared canonical — the primitive the
 * adapter-manager verify is built on. Proves the canonical + sig are sound. */
function signatureValid(cap: OwnedLabelsCapability, publicKey: import("node:crypto").KeyObject): boolean {
  const canonical = buildOwnedLabelsCapabilityCanonical(cap);
  return cryptoVerify(null, canonical, publicKey, Buffer.from(cap.sig, "base64url"));
}

describe("owned-labels capability — sign/verify round-trip", () => {
  it("a freshly-minted capability verifies against its keypair", () => {
    const { cap, publicKey } = mint();
    expect(cap.v).toBe(1);
    expect(cap.audience).toBe("adapter-manager");
    expect(cap.ownedLabels).toEqual(OWNED);
    expect(typeof cap.sig).toBe("string");
    expect(signatureValid(cap, publicKey)).toBe(true);
  });

  it("a capability minted by ONE key does NOT verify against a DIFFERENT key", () => {
    const { cap } = mint();
    const { publicKey: otherPublicKey } = generateKeyPairSync("ed25519");
    expect(signatureValid(cap, otherPublicKey)).toBe(false);
  });
});

describe("owned-labels capability — tamper-evidence over EVERY signed field", () => {
  it("tampering the version breaks verify", () => {
    const { cap, publicKey } = mint();
    const tampered: OwnedLabelsCapability = { ...cap, v: 2 as 1 };
    expect(signatureValid(tampered, publicKey)).toBe(false);
  });

  it("tampering the audience breaks verify", () => {
    const { cap, publicKey } = mint();
    const tampered: OwnedLabelsCapability = { ...cap, audience: "not-adapter-manager" as "adapter-manager" };
    expect(signatureValid(tampered, publicKey)).toBe(false);
  });

  it("tampering the expiresAt breaks verify", () => {
    const { cap, publicKey } = mint();
    const tampered: OwnedLabelsCapability = { ...cap, expiresAt: cap.expiresAt + 1 };
    expect(signatureValid(tampered, publicKey)).toBe(false);
  });

  // Field-wise: EACH ownedLabels sub-field must be covered by the canonical.
  const labelFields: ReadonlyArray<[keyof ResourceLabels, ResourceLabels[keyof ResourceLabels]]> = [
    ["organizationId", "org-EVIL"],
    ["targetId", "tgt-EVIL"],
    ["workerId", "wkr-EVIL"],
    ["jobId", "job-EVIL"],
    ["attempt", 999],
    ["leaseId", "lease-EVIL"],
    ["deviceGeneration", 999],
  ];
  for (const [field, evil] of labelFields) {
    it(`tampering ownedLabels.${String(field)} breaks verify`, () => {
      const { cap, publicKey } = mint();
      const tampered: OwnedLabelsCapability = {
        ...cap,
        ownedLabels: { ...cap.ownedLabels, [field]: evil } as ResourceLabels,
      };
      expect(signatureValid(tampered, publicKey)).toBe(false);
    });
  }

  it("the mint REFUSES a non-finite / non-integer expiresAt (never emit an immortal / ambiguous token)", () => {
    // JSON.stringify(Infinity|NaN) === "null", so a non-finite expiresAt canonicalizes
    // ambiguously AND `!(Infinity > now)` never expires. The mint must refuse to produce one.
    const { privateKey } = generateKeyPairSync("ed25519");
    for (const bad of [Infinity, -Infinity, NaN, 1.5]) {
      expect(() =>
        signOwnedLabelsCapability(
          { v: OWNED_LABELS_CAPABILITY_VERSION, audience: OWNED_LABELS_CAPABILITY_AUDIENCE, ownedLabels: OWNED, expiresAt: bad },
          privateKey,
        ),
      ).toThrow();
    }
  });

  it("a space-collision in ownedLabels does NOT collide (ordered-tuple canonical, not a space-join)", () => {
    // Two DISTINCT label tuples that a space-join would canonicalize identically:
    //   {workerId:"a b", leaseId:"c"} vs {workerId:"a", leaseId:"b c"}
    // The ordered-tuple canonical keeps field boundaries, so their signatures differ.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const base = { v: OWNED_LABELS_CAPABILITY_VERSION, audience: OWNED_LABELS_CAPABILITY_AUDIENCE, expiresAt: FIXED_NOW };
    const a = signOwnedLabelsCapability(
      { ...base, ownedLabels: { ...OWNED, workerId: "a b", leaseId: "c" } },
      privateKey,
    );
    const bLabels: ResourceLabels = { ...OWNED, workerId: "a", leaseId: "b c" };
    // a's signature must NOT validate for b's canonical.
    const bCanonical = buildOwnedLabelsCapabilityCanonical({ ...a, ownedLabels: bLabels });
    expect(cryptoVerify(null, bCanonical, publicKey, Buffer.from(a.sig, "base64url"))).toBe(false);
  });
});
