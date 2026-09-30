// -----------------------------------------------------------------------------
// DEP-011 Slice 1 · packaging (§1.2.0) — the re-homed owned-labels-capability primitive.
//
// This suite pins that the LEAF extraction is a BYTE-FOR-BYTE re-home of the DEP-012
// Unit B1 primitive (same schema, same canonical, same signer behavior):
//   - a BYTE-PARITY ANCHOR: the canonical bytes for a fixed fixture equal the exact
//     pre-move string (keyless + deterministic — proves the re-home changed no bytes);
//   - a sign -> verify round-trip over the UNAMBIGUOUS canonical of ALL signed fields;
//   - tamper-evidence: mutating ANY signed field (incl. any ownedLabels sub-field)
//     breaks verify — the canonical covers every field, field-wise;
//   - the mint refuses a non-finite / non-integer expiry;
//   - a space-collision does NOT collide (ordered-tuple canonical, not a space-join).
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

describe("owned-labels capability (leaf) — byte-parity anchor with the pre-move primitive", () => {
  it("the canonical bytes for a fixed fixture equal the EXACT ordered-tuple string", () => {
    // Fixed-order JSON array: [v, audience, [7 labels], expiresAt]. This is the pre-move
    // output byte-for-byte; a drift in the leaf's canonicalizer changes this string.
    const canonical = buildOwnedLabelsCapabilityCanonical({
      v: OWNED_LABELS_CAPABILITY_VERSION,
      audience: OWNED_LABELS_CAPABILITY_AUDIENCE,
      ownedLabels: OWNED,
      expiresAt: FIXED_NOW + 60_000,
    });
    expect(canonical.toString("utf8")).toBe(
      '[1,"adapter-manager",["org-1","tgt-1","wkr-1","job-1",1,"lease-1",7],1700000060000]',
    );
  });
});

describe("owned-labels capability (leaf) — sign/verify round-trip", () => {
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

describe("owned-labels capability (leaf) — tamper-evidence over EVERY signed field", () => {
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
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const base = { v: OWNED_LABELS_CAPABILITY_VERSION, audience: OWNED_LABELS_CAPABILITY_AUDIENCE, expiresAt: FIXED_NOW };
    const a = signOwnedLabelsCapability(
      { ...base, ownedLabels: { ...OWNED, workerId: "a b", leaseId: "c" } },
      privateKey,
    );
    const bLabels: ResourceLabels = { ...OWNED, workerId: "a", leaseId: "b c" };
    const bCanonical = buildOwnedLabelsCapabilityCanonical({ ...a, ownedLabels: bLabels });
    expect(cryptoVerify(null, bCanonical, publicKey, Buffer.from(a.sig, "base64url"))).toBe(false);
  });
});
