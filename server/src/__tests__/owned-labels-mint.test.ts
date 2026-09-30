// -----------------------------------------------------------------------------
// DEP-011 Slice 1 — the SERVER half of the owned-labels-capability mint (§1.2–§1.6, §1.9).
//
// The control plane mints a signed OwnedLabelsCapability in the sandbox-local
// `resolveExecutionSecret` ALLOW reply. This suite pins the mint's correctness and its
// #104 containment WITHOUT a database — the mint decision is a PURE function of the
// resolved outcome + the resolved fence context + the injected control-plane key:
//
//   parity  — `ownedLabelsFromFenceIdentity` reproduces the WORKER's `labelsFor` tuple
//             field-for-field (anchored to the SAME distinct-valued tuple the worker
//             half captures from a real supervisor create,
//             packages/worker-daemon/.../supervisor-labels-parity.test.ts);
//   gate    — the capability is minted ONLY on `resolved ∧ sandbox_local_only`, and ONLY
//             when a control-plane key is configured; every other path carries NONE;
//   expiry  — clamped to the lease deadline, a finite integer;
//   #104    — the capability bytes carry NEITHER the redeemed value NOR the fence token /
//             targetAuthorityKey / profileHash / providerConstraintHash (the fresh-literal
//             rule — never a `{...fenceIdentity}` spread).
// -----------------------------------------------------------------------------

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ActiveFenceRequest } from "@armyofagents/db";
import { labelsEqual, type ResourceLabels } from "@armyofagents/worker-daemon";
import { verifyOwnedLabelsCapability } from "@armyofagents/adapter-manager";
import { buildOwnedLabelsCapabilityCanonical } from "@armyofagents/provider-capability";

import {
  applyOwnedLabelsCapability,
  ownedLabelsFromFenceIdentity,
  OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS,
  type OwnedLabelsMintContext,
} from "../services/owned-labels-mint.js";
import type { SecretResolveOutcome } from "../services/secret-broker.js";

// The SHARED anchor tuple — byte-identical to `DEP_011_ANCHOR_LABELS` captured from the
// REAL supervisor create in the worker half. org / target / worker / job / lease are all
// distinct uuids; attempt (1) != deviceGeneration (7), both numbers.
const ANCHOR_LABELS: ResourceLabels = {
  organizationId: "00000000-0000-4000-8000-0000000000a2",
  targetId: "00000000-0000-4000-8000-0000000000a0",
  workerId: "00000000-0000-4000-8000-0000000000a1",
  jobId: "00000000-0000-4000-8000-0000000000a3",
  attempt: 1,
  leaseId: "00000000-0000-4000-8000-0000000000a5",
  deviceGeneration: 7,
};

// The four SECRETS in scope at the mint site beyond the 7 labels (Decision #104). A
// `{...fenceIdentity}` spread — or an `as ResourceLabels` cast — would leak these.
const FENCE_TOKEN = "FENCE-TOKEN-secret-do-not-leak";
const TARGET_AUTHORITY_KEY = "targetAuthorityKey-secret-do-not-leak";
const PROFILE_HASH = "profileHash-secret-do-not-leak";
const PROVIDER_CONSTRAINT_HASH = "providerConstraintHash-secret-do-not-leak";
const REDEEMED_VALUE = "REDEEMED-model-provider-key-do-not-leak";

/** A complete `ActiveFenceRequest` mirroring `resolveWorkerFenceContext`'s construction
 * (worker-fence-context.ts:120-134): the 7 label sources use the anchor scalars (note the
 * field-NAME map — `attemptNumber`/`targetGeneration`), and EVERY other field is a
 * distinct secret sentinel that must never reach `ownedLabels`. */
function fenceIdentity(): ActiveFenceRequest {
  return {
    organizationId: ANCHOR_LABELS.organizationId,
    companyId: "company-sentinel",
    jobId: ANCHOR_LABELS.jobId,
    attemptId: "attemptId-sentinel",
    attemptNumber: ANCHOR_LABELS.attempt,
    leaseId: ANCHOR_LABELS.leaseId,
    workerId: ANCHOR_LABELS.workerId,
    targetId: ANCHOR_LABELS.targetId,
    targetAuthorityKey: TARGET_AUTHORITY_KEY,
    targetGeneration: ANCHOR_LABELS.deviceGeneration,
    profileHash: PROFILE_HASH,
    providerConstraintHash: PROVIDER_CONSTRAINT_HASH,
    fence: FENCE_TOKEN,
  };
}

const LEASE_DEADLINE = new Date("2026-08-13T00:10:00.000Z");
const AUTHORITY_NOW = new Date("2026-08-13T00:00:00.000Z");

function mintCtx(overrides: Partial<OwnedLabelsMintContext> = {}): OwnedLabelsMintContext {
  return {
    fenceIdentity: fenceIdentity(),
    authorityNow: AUTHORITY_NOW,
    leaseDeadline: LEASE_DEADLINE,
    ...overrides,
  };
}

/** A resolved sandbox-local outcome carrying the redeemed model key (the mint-eligible arm). */
function resolvedSandboxLocal(): SecretResolveOutcome {
  return {
    outcome: "resolved",
    seam: "sandbox_local_only",
    material: {
      value: REDEEMED_VALUE,
      materialization: "env",
      materializationTarget: "ANTHROPIC_API_KEY",
      destination: null,
    },
  };
}

const controlPlane = generateKeyPairSync("ed25519");

// --------------------------------------------------------------------------------------
// parity — the fresh 7-field literal equals the worker's labelsFor tuple, field-for-field
// --------------------------------------------------------------------------------------

describe("ownedLabelsFromFenceIdentity — parity with the worker's labelsFor", () => {
  it("maps the fence identity to the anchor tuple (labelsEqual, strict)", () => {
    const labels = ownedLabelsFromFenceIdentity(fenceIdentity());
    expect(labelsEqual(labels, ANCHOR_LABELS)).toBe(true);
    expect(labels).toEqual(ANCHOR_LABELS);
  });

  it("emits EXACTLY the 7 label keys — no fence token / hashes / companyId leak", () => {
    const labels = ownedLabelsFromFenceIdentity(fenceIdentity());
    expect(Object.keys(labels).sort()).toEqual(
      ["attempt", "deviceGeneration", "jobId", "leaseId", "organizationId", "targetId", "workerId"],
    );
  });

  it("keeps attempt + deviceGeneration NUMERIC (a strict === compare is number/string-fatal)", () => {
    const labels = ownedLabelsFromFenceIdentity(fenceIdentity());
    expect(typeof labels.attempt).toBe("number");
    expect(typeof labels.deviceGeneration).toBe("number");
    expect(labels.attempt).toBe(1);
    expect(labels.deviceGeneration).toBe(7);
  });
});

// --------------------------------------------------------------------------------------
// the positive mint gate + verify + expiry
// --------------------------------------------------------------------------------------

describe("applyOwnedLabelsCapability — the resolved ∧ sandbox_local_only mint", () => {
  it("mints a capability that VERIFIES and whose labels are labelsEqual to the anchor", () => {
    const out = applyOwnedLabelsCapability(resolvedSandboxLocal(), mintCtx(), {
      controlPlaneSigningKey: controlPlane.privateKey,
      shortTtlMs: OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS,
    });
    expect(out.outcome).toBe("resolved");
    const cap = out.outcome === "resolved" ? out.ownedLabelsCapability : undefined;
    expect(cap).toBeDefined();
    // (a) verifies against the test CP public key (the REAL adapter-manager verifier).
    const verified = verifyOwnedLabelsCapability(cap!, controlPlane.publicKey, AUTHORITY_NOW.getTime());
    expect(labelsEqual(verified, ANCHOR_LABELS)).toBe(true);
    // (b) labels are labelsEqual to the captured worker tuple (verify alone is subset-blind).
    expect(labelsEqual(cap!.ownedLabels, ANCHOR_LABELS)).toBe(true);
    // (c) exactly the 7 label keys (backstops labelsEqual's subset-blindness).
    expect(Object.keys(cap!.ownedLabels).sort()).toEqual(
      ["attempt", "deviceGeneration", "jobId", "leaseId", "organizationId", "targetId", "workerId"],
    );
    expect(cap!.v).toBe(1);
    expect(cap!.audience).toBe("adapter-manager");
  });

  it("(d) clamps expiresAt to the lease deadline — a finite integer <= the deadline", () => {
    // A TTL far past the lease deadline must clamp DOWN to the deadline, never now+TTL.
    const out = applyOwnedLabelsCapability(resolvedSandboxLocal(), mintCtx(), {
      controlPlaneSigningKey: controlPlane.privateKey,
      shortTtlMs: 365 * 24 * 60 * 60 * 1000,
    });
    const cap = out.outcome === "resolved" ? out.ownedLabelsCapability : undefined;
    expect(cap).toBeDefined();
    expect(Number.isInteger(cap!.expiresAt)).toBe(true);
    expect(cap!.expiresAt).toBe(LEASE_DEADLINE.getTime());
    expect(cap!.expiresAt).toBeLessThanOrEqual(LEASE_DEADLINE.getTime());
  });

  it("uses now+TTL when the TTL expires BEFORE the lease deadline (min, not always-deadline)", () => {
    const shortTtlMs = 30_000;
    const out = applyOwnedLabelsCapability(resolvedSandboxLocal(), mintCtx(), {
      controlPlaneSigningKey: controlPlane.privateKey,
      shortTtlMs,
    });
    const cap = out.outcome === "resolved" ? out.ownedLabelsCapability : undefined;
    expect(cap!.expiresAt).toBe(AUTHORITY_NOW.getTime() + shortTtlMs);
    expect(cap!.expiresAt).toBeLessThan(LEASE_DEADLINE.getTime());
  });
});

// --------------------------------------------------------------------------------------
// (e)(f) absence — no key, and every non-(resolved ∧ sandbox_local_only) outcome
// --------------------------------------------------------------------------------------

describe("applyOwnedLabelsCapability — absence (inert / non-mint paths)", () => {
  it("(e) OMITS the capability when no control-plane key is configured (inert)", () => {
    const out = applyOwnedLabelsCapability(resolvedSandboxLocal(), mintCtx(), {
      controlPlaneSigningKey: undefined,
      shortTtlMs: OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS,
    });
    expect(out).toEqual(resolvedSandboxLocal());
    expect(out.outcome === "resolved" && "ownedLabelsCapability" in out).toBe(false);
  });

  it("(f) OMITS on a device_handoff outcome (the desktop keystore path)", () => {
    const deviceHandoff: SecretResolveOutcome = {
      outcome: "device_handoff",
      handoff: {
        refKind: "device_local",
        refId: "ref-1",
        ownerPrincipalKind: null,
        ownerPrincipalId: null,
        materialization: "env",
        usePolicy: "sandbox_local_only",
        companyId: "company-sentinel",
        handleId: "handle-1",
        boundTargetGeneration: null,
        destination: null,
      },
    };
    const out = applyOwnedLabelsCapability(deviceHandoff, mintCtx(), {
      controlPlaneSigningKey: controlPlane.privateKey,
      shortTtlMs: OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS,
    });
    expect(out).toEqual(deviceHandoff);
  });

  it("(f) OMITS on a denied outcome", () => {
    const denied: SecretResolveOutcome = { outcome: "denied", reason: "malformed" };
    const out = applyOwnedLabelsCapability(denied, mintCtx(), {
      controlPlaneSigningKey: controlPlane.privateKey,
      shortTtlMs: OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS,
    });
    expect(out).toEqual(denied);
  });

  it("(f) OMITS on a resolved outcome that is NOT sandbox_local_only (fence_proxy / remote_server_fenced)", () => {
    for (const seam of ["fence_proxy", "remote_server_fenced"] as const) {
      const networked: SecretResolveOutcome = {
        outcome: "resolved",
        seam,
        material: { value: REDEEMED_VALUE, materialization: "proxy", materializationTarget: null, destination: "https://api.example" },
      };
      const out = applyOwnedLabelsCapability(networked, mintCtx(), {
        controlPlaneSigningKey: controlPlane.privateKey,
        shortTtlMs: OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS,
      });
      expect(out).toEqual(networked);
    }
  });
});

// --------------------------------------------------------------------------------------
// #104 — the capability bytes carry NO secret
// --------------------------------------------------------------------------------------

describe("Decision #104 — the minted capability leaks no secret", () => {
  it("neither the JSON nor the signed canonical contains the redeemed value or any fence secret", () => {
    const out = applyOwnedLabelsCapability(resolvedSandboxLocal(), mintCtx(), {
      controlPlaneSigningKey: controlPlane.privateKey,
      shortTtlMs: OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS,
    });
    const cap = out.outcome === "resolved" ? out.ownedLabelsCapability! : undefined;
    const secrets = [REDEEMED_VALUE, FENCE_TOKEN, TARGET_AUTHORITY_KEY, PROFILE_HASH, PROVIDER_CONSTRAINT_HASH];
    const json = JSON.stringify(cap);
    const canonical = buildOwnedLabelsCapabilityCanonical(cap!).toString("utf8");
    for (const secret of secrets) {
      expect(json).not.toContain(secret);
      expect(canonical).not.toContain(secret);
    }
  });
});
