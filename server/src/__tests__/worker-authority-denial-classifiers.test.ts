// DE-18/DE-04 worker-authority-currency classifiers — PURE, per-conjunct.
//
// The deny-path recorders derive the CROSSING from the classifier's failed
// conjunct list, never from a composite boolean, so every individual conjunct
// check below is load-bearing: deleting any single guard in
// `pollAuthorityCurrencyIntent`, `classifyPlatformHeartbeatRefusal`,
// `classifyTenantHeartbeatRefusal` or `deriveWorkerSessionCrossing` must kill at
// least one of these tests (the mutation contract of the heartbeat/poll
// authority-denial audit unit, follow-on to PR #448).

import { describe, expect, it } from "vitest";
import type { LeaseWorkerAuthority } from "@armyofagents/db";
import type { PollRequestV1 } from "@armyofagents/worker-protocol";
import { pollAuthorityCurrencyIntent, ackAuthorityCurrencyIntent, type VerifiedWorkerOperation } from "../services/job-leasing.js";
import {
  classifyPlatformHeartbeatRefusal,
  classifyTenantHeartbeatRefusal,
} from "../middleware/worker-session-auth.js";
import {
  deriveWorkerSessionCrossing,
  WORKER_AUTHORITY_CURRENCY_CROSSING,
  WORKER_SESSION_DENIAL_CROSSING,
} from "../services/worker-session-denial-audit.js";
import { WORKER_DENIAL_SURFACE_BY_REASON } from "../services/worker-denial-audit.js";

const ORG = "b7000000-0000-4000-8000-000000000001";
const TARGET = "b7000000-0000-4000-8000-000000000002";
const WORKER = "b7000000-0000-4000-8000-000000000003";
const THUMB = "a".repeat(64);
const PROFILE = "b".repeat(64);
const NOW = new Date("2026-09-13T12:00:00Z");
const FRESH = new Date(NOW.getTime() - 1_000);
const MAX_AGE_MS = 300_000;

function auth(): VerifiedWorkerOperation {
  return {
    organizationId: ORG,
    workerId: WORKER,
    targetId: TARGET,
    targetGeneration: 1,
    deviceThumbprint: THUMB,
    profileHash: PROFILE,
    publicKey: "pk",
    proofId: "proof",
    proofIssuedAt: NOW,
    sessionExpiresAt: new Date(NOW.getTime() + 60_000),
  } as VerifiedWorkerOperation;
}

function authority(overrides: {
  worker?: Partial<LeaseWorkerAuthority["worker"]>;
  target?: Record<string, unknown>;
  ownerMembershipActive?: boolean;
} = {}): LeaseWorkerAuthority {
  return {
    worker: {
      id: WORKER,
      scope: "organization",
      organizationId: ORG,
      ownerUserId: null,
      executionTargetId: TARGET,
      targetAuthorityKey: `organization:${ORG}`,
      devicePublicKey: "pk",
      deviceThumbprint: THUMB,
      deviceGeneration: 1,
      profileHash: PROFILE,
      profileSnapshot: {},
      status: "enrolled",
      revokedAt: null,
      lastSeenAt: FRESH,
      ...(overrides.worker ?? {}),
    },
    target: {
      id: TARGET,
      scope: "organization",
      status: "active",
      deviceGeneration: 1,
      lastSeenAt: FRESH,
      ...(overrides.target ?? {}),
    },
    ownerMembershipActive: overrides.ownerMembershipActive ?? true,
  } as unknown as LeaseWorkerAuthority;
}

function request(overrides: Partial<Record<"workerId" | "targetId" | "deviceGeneration", unknown>> = {}): PollRequestV1 {
  return {
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 1,
    ...overrides,
  } as unknown as PollRequestV1;
}

function classify(input: {
  worker?: Partial<LeaseWorkerAuthority["worker"]>;
  target?: Record<string, unknown>;
  ownerMembershipActive?: boolean;
  request?: Partial<Record<"workerId" | "targetId" | "deviceGeneration", unknown>>;
} = {}) {
  return pollAuthorityCurrencyIntent(auth(), authority(input), request(input.request), NOW, MAX_AGE_MS);
}

describe("pollAuthorityCurrencyIntent — crossing derived per conjunct", () => {
  it("returns null when every conjunct holds (positive control: no guessed row)", () => {
    expect(classify()).toBeNull();
  });

  it("an authoritative WORKER generation drift is DE-18 poll_generation_superseded", () => {
    const intent = classify({ worker: { deviceGeneration: 2 } });
    expect(intent).toMatchObject({ reason: "poll_generation_superseded", crossings: ["DE-18"] });
    expect(intent!.details.failed).toContain("worker_generation_drift");
  });

  it("an authoritative TARGET generation drift is DE-18", () => {
    const intent = classify({ target: { deviceGeneration: 2 } });
    expect(intent).toMatchObject({ reason: "poll_generation_superseded", crossings: ["DE-18"] });
    expect(intent!.details.failed).toContain("target_generation_drift");
  });

  it("the caller's OWN request_generation claim is forgeable and NEVER mints DE-18 — it files under DE-04", () => {
    const intent = classify({ request: { deviceGeneration: 9 } });
    expect(intent).toMatchObject({ reason: "poll_authority_stale", crossings: ["DE-04"] });
    expect(intent!.details.failed).toEqual(["request_generation_drift"]);
  });

  it.each([
    ["worker_id_mismatch", { worker: { id: "b7000000-0000-4000-8000-00000000000f" } }],
    ["worker_target_mismatch", { worker: { executionTargetId: "b7000000-0000-4000-8000-00000000000e" } }],
    ["worker_org_mismatch", { worker: { organizationId: "b7000000-0000-4000-8000-00000000000d" } }],
    ["worker_scope_platform", { worker: { scope: "platform" } }],
    ["worker_thumbprint_mismatch", { worker: { deviceThumbprint: "c".repeat(64) } }],
    ["worker_pubkey_mismatch", { worker: { devicePublicKey: "other-pk" } }],
    ["worker_profile_mismatch", { worker: { profileHash: "d".repeat(64) } }],
    ["worker_revoked", { worker: { revokedAt: NOW } }],
    ["worker_status_invalid", { worker: { status: "revoked" } }],
    ["owner_membership_lost", { ownerMembershipActive: false }],
    ["target_id_mismatch", { target: { id: "b7000000-0000-4000-8000-00000000000c" } }],
    ["target_inactive", { target: { status: "disabled" } }],
    ["request_worker_mismatch", { request: { workerId: "b7000000-0000-4000-8000-00000000000b" } }],
    ["request_target_mismatch", { request: { targetId: "b7000000-0000-4000-8000-00000000000a" } }],
    ["heartbeat_stale", { worker: { lastSeenAt: new Date(NOW.getTime() - MAX_AGE_MS - 1_000) } }],
  ] as const)("a NON-generation authority-currency failure (%s) is DE-04 poll_authority_stale naming the conjunct", (conjunct, overrides) => {
    const intent = classify(overrides as never);
    expect(intent).toMatchObject({ reason: "poll_authority_stale", crossings: ["DE-04"] });
    expect(intent!.details.failed).toContain(conjunct);
    expect(intent!.details.failed).not.toContain("worker_generation_drift");
    expect(intent!.details.failed).not.toContain("target_generation_drift");
  });

  it("a NULL heartbeat (never seen) is heartbeat_stale", () => {
    const intent = classify({ worker: { lastSeenAt: null } });
    expect(intent!.details.failed).toContain("heartbeat_stale");
  });

  it("a MIXED failure (generation + heartbeat) stays DE-18 with every conjunct named", () => {
    const intent = classify({ worker: { deviceGeneration: 2, lastSeenAt: null } });
    expect(intent).toMatchObject({ reason: "poll_generation_superseded", crossings: ["DE-18"] });
    expect(intent!.details.failed).toEqual(
      expect.arrayContaining(["worker_generation_drift", "heartbeat_stale"]));
  });

  it("both poll reasons map to the worker_poll_authority surface", () => {
    expect(WORKER_DENIAL_SURFACE_BY_REASON.poll_generation_superseded).toBe("worker_poll_authority");
    expect(WORKER_DENIAL_SURFACE_BY_REASON.poll_authority_stale).toBe("worker_poll_authority");
  });
});

// The ACK admission arm — the same mutation contract, for `ackAuthorityCurrencyIntent` (the ack
// analogue mirroring `ackAuthorityCurrent`'s predicate). Deleting any single conjunct guard must
// kill at least one test here.
function ackClassify(input: {
  worker?: Partial<LeaseWorkerAuthority["worker"]>;
  target?: Record<string, unknown>;
  ownerMembershipActive?: boolean;
  workerId?: string;
} = {}) {
  return ackAuthorityCurrencyIntent({
    auth: auth(),
    authority: authority(input),
    workerId: input.workerId ?? WORKER,
    databaseNow: NOW,
    maxHeartbeatAgeMs: MAX_AGE_MS,
  });
}

describe("ackAuthorityCurrencyIntent — crossing derived per conjunct (ack admission arm)", () => {
  it("returns null when every conjunct holds (positive control: no guessed row)", () => {
    expect(ackClassify()).toBeNull();
  });

  it("an authoritative WORKER generation drift is DE-18 ack_generation_superseded", () => {
    const intent = ackClassify({ worker: { deviceGeneration: 2 } });
    expect(intent).toMatchObject({ reason: "ack_generation_superseded", crossings: ["DE-18"] });
    expect(intent!.details.failed).toContain("worker_generation_drift");
  });

  it("an authoritative TARGET generation drift is DE-18", () => {
    const intent = ackClassify({ target: { deviceGeneration: 2 } });
    expect(intent).toMatchObject({ reason: "ack_generation_superseded", crossings: ["DE-18"] });
    expect(intent!.details.failed).toContain("target_generation_drift");
  });

  it.each([
    ["worker_id_mismatch", { worker: { id: "b7000000-0000-4000-8000-00000000000f" } }],
    ["worker_target_mismatch", { worker: { executionTargetId: "b7000000-0000-4000-8000-00000000000e" } }],
    ["worker_org_mismatch", { worker: { organizationId: "b7000000-0000-4000-8000-00000000000d" } }],
    ["worker_scope_platform", { worker: { scope: "platform" } }],
    ["worker_thumbprint_mismatch", { worker: { deviceThumbprint: "c".repeat(64) } }],
    ["worker_pubkey_mismatch", { worker: { devicePublicKey: "other-pk" } }],
    ["worker_profile_mismatch", { worker: { profileHash: "d".repeat(64) } }],
    ["worker_revoked", { worker: { revokedAt: NOW } }],
    ["worker_status_invalid", { worker: { status: "revoked" } }],
    ["owner_membership_lost", { ownerMembershipActive: false }],
    ["target_id_mismatch", { target: { id: "b7000000-0000-4000-8000-00000000000c" } }],
    ["target_inactive", { target: { status: "disabled" } }],
    ["request_worker_mismatch", { workerId: "b7000000-0000-4000-8000-00000000000b" }],
    ["heartbeat_stale", { worker: { lastSeenAt: new Date(NOW.getTime() - MAX_AGE_MS - 1_000) } }],
  ] as const)("a NON-generation authority-currency failure (%s) is DE-04 ack_authority_stale naming the conjunct", (conjunct, overrides) => {
    const intent = ackClassify(overrides as never);
    expect(intent).toMatchObject({ reason: "ack_authority_stale", crossings: ["DE-04"] });
    expect(intent!.details.failed).toContain(conjunct);
    expect(intent!.details.failed).not.toContain("worker_generation_drift");
    expect(intent!.details.failed).not.toContain("target_generation_drift");
  });

  it("a NULL heartbeat (never seen) is heartbeat_stale", () => {
    const intent = ackClassify({ worker: { lastSeenAt: null } });
    expect(intent!.details.failed).toContain("heartbeat_stale");
  });

  it("a MIXED failure (generation + heartbeat) stays DE-18 with every conjunct named", () => {
    const intent = ackClassify({ worker: { deviceGeneration: 2, lastSeenAt: null } });
    expect(intent).toMatchObject({ reason: "ack_generation_superseded", crossings: ["DE-18"] });
    expect(intent!.details.failed).toEqual(
      expect.arrayContaining(["worker_generation_drift", "heartbeat_stale"]));
  });

  it("both ack reasons map to the worker_poll_authority surface", () => {
    expect(WORKER_DENIAL_SURFACE_BY_REASON.ack_generation_superseded).toBe("worker_poll_authority");
    expect(WORKER_DENIAL_SURFACE_BY_REASON.ack_authority_stale).toBe("worker_poll_authority");
  });
});

describe("deriveWorkerSessionCrossing — generation ⇒ DE-18, currency ⇒ DE-04, empty ⇒ null", () => {
  it("empty or absent failed list classifies NOTHING (no guessed row)", () => {
    expect(deriveWorkerSessionCrossing([])).toBeNull();
    expect(deriveWorkerSessionCrossing(undefined)).toBeNull();
  });
  it("generation_drift is DE-18 even when other conjuncts fired too", () => {
    expect(deriveWorkerSessionCrossing(["generation_drift"])).toBe(WORKER_SESSION_DENIAL_CROSSING);
    expect(deriveWorkerSessionCrossing(["target_disabled", "generation_drift"])).toBe("DE-18");
  });
  it("any other authority-currency conjunct is DE-04", () => {
    for (const conjunct of ["target_disabled", "worker_revoked", "owner_membership_lost",
      "authority_row_missing", "thumbprint_mismatch", "pubkey_mismatch", "profile_hash_mismatch"]) {
      expect(deriveWorkerSessionCrossing([conjunct])).toBe(WORKER_AUTHORITY_CURRENCY_CROSSING);
    }
  });
});

const PLATFORM_SNAPSHOT = {
  worker: {
    id: WORKER,
    status: "enrolled",
    revokedAt: null as Date | null,
    deviceGeneration: 1,
    deviceThumbprint: THUMB,
    devicePublicKey: "pk",
    profileHash: PROFILE,
  },
  target: { status: "active", deviceGeneration: 1 },
};

function platformClassify(overrides: {
  worker?: Partial<typeof PLATFORM_SNAPSHOT.worker>;
  target?: Partial<typeof PLATFORM_SNAPSHOT.target>;
  missing?: boolean;
  devicePublicKey?: string;
} = {}) {
  return classifyPlatformHeartbeatRefusal({
    physical: overrides.missing ? null : {
      worker: { ...PLATFORM_SNAPSHOT.worker, ...(overrides.worker ?? {}) },
      target: { ...PLATFORM_SNAPSHOT.target, ...(overrides.target ?? {}) },
    },
    expected: {
      generation: 1,
      workerId: WORKER,
      deviceThumbprint: THUMB,
      profileHash: PROFILE,
      ...(overrides.devicePublicKey !== undefined ? { devicePublicKey: overrides.devicePublicKey } : {}),
    },
  });
}

describe("classifyPlatformHeartbeatRefusal — per-branch generation re-read classifier", () => {
  it("a current authority classifies NOTHING (the transient-race documented gap, not a guessed row)", () => {
    expect(platformClassify()).toEqual([]);
  });
  it("a missing physical authority row is the sole conjunct", () => {
    expect(platformClassify({ missing: true })).toEqual(["physical_authority_missing"]);
  });
  it.each([
    ["target_inactive", { target: { status: "disabled" } }],
    ["generation_drift", { target: { deviceGeneration: 2 } }],
    ["generation_drift", { worker: { deviceGeneration: 2 } }],
    ["worker_identity_mismatch", { worker: { id: "b7000000-0000-4000-8000-000000000009" } }],
    ["worker_revoked", { worker: { status: "revoked" } }],
    ["worker_revoked", { worker: { revokedAt: NOW } }],
    ["thumbprint_mismatch", { worker: { deviceThumbprint: "e".repeat(64) } }],
    ["profile_hash_mismatch", { worker: { profileHash: null } }],
  ] as const)("names %s from the authoritative re-read", (conjunct, overrides) => {
    expect(platformClassify(overrides as never)).toEqual([conjunct]);
  });
  it("checks the public key ONLY when the branch's predicate enforces one (shared-platform)", () => {
    // Not enforced (liveness/transition branches): a drifted key is NOT a conjunct.
    expect(platformClassify({ worker: { devicePublicKey: "drifted" } })).toEqual([]);
    // Enforced (shared-platform branch): it is.
    expect(platformClassify({ worker: { devicePublicKey: "drifted" }, devicePublicKey: "pk" }))
      .toEqual(["pubkey_mismatch"]);
  });
});

const TENANT_SNAPSHOT = {
  worker: { status: "enrolled", revokedAt: null as Date | null, deviceGeneration: 1 },
  target: { status: "active", deviceGeneration: 1, organizationId: ORG as string | null },
};

function tenantClassify(
  branch: "tenant_target" | "tenant_status" | "tenant_profile",
  overrides: {
    worker?: Partial<typeof TENANT_SNAPSHOT.worker>;
    target?: Partial<typeof TENANT_SNAPSHOT.target>;
    missing?: boolean;
  } = {},
) {
  return classifyTenantHeartbeatRefusal({
    branch,
    current: overrides.missing ? null : {
      worker: { ...TENANT_SNAPSHOT.worker, ...(overrides.worker ?? {}) },
      target: { ...TENANT_SNAPSHOT.target, ...(overrides.target ?? {}) },
    },
    expected: { generation: 1, organizationId: ORG },
  });
}

describe("classifyTenantHeartbeatRefusal — each branch checks ONLY its own write's conjuncts", () => {
  it("a current authority classifies NOTHING on every branch", () => {
    for (const branch of ["tenant_target", "tenant_status", "tenant_profile"] as const) {
      expect(tenantClassify(branch)).toEqual([]);
    }
  });
  it("a missing authority row is the sole conjunct on every branch", () => {
    for (const branch of ["tenant_target", "tenant_status", "tenant_profile"] as const) {
      expect(tenantClassify(branch, { missing: true })).toEqual(["authority_row_missing"]);
    }
  });
  it("tenant_target: disabled target and target generation drift", () => {
    expect(tenantClassify("tenant_target", { target: { status: "disabled" } })).toEqual(["target_disabled"]);
    expect(tenantClassify("tenant_target", { target: { deviceGeneration: 2 } })).toEqual(["generation_drift"]);
    // The target write does NOT predicate on the worker row — a revoked worker is not its conjunct.
    expect(tenantClassify("tenant_target", { worker: { status: "revoked" } })).toEqual([]);
  });
  it("tenant_status: disabled target and org mismatch — NOT generation (its write has no generation conjunct)", () => {
    expect(tenantClassify("tenant_status", { target: { status: "disabled" } })).toEqual(["target_disabled"]);
    expect(tenantClassify("tenant_status", { target: { organizationId: "b7000000-0000-4000-8000-000000000008" } }))
      .toEqual(["target_org_mismatch"]);
    expect(tenantClassify("tenant_status", { target: { deviceGeneration: 2 } })).toEqual([]);
  });
  it("tenant_profile: worker revoked (status or revokedAt) and worker generation drift", () => {
    expect(tenantClassify("tenant_profile", { worker: { status: "revoked" } })).toEqual(["worker_revoked"]);
    expect(tenantClassify("tenant_profile", { worker: { revokedAt: NOW } })).toEqual(["worker_revoked"]);
    expect(tenantClassify("tenant_profile", { worker: { deviceGeneration: 2 } })).toEqual(["generation_drift"]);
    // The profile touch does NOT predicate on the target row.
    expect(tenantClassify("tenant_profile", { target: { status: "disabled" } })).toEqual([]);
  });
});
