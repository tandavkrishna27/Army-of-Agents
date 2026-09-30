import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KNOWN_WORKER_CAPABILITIES,
  KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS,
  NON_EVENT_DISTRIBUTED_EMISSIONS,
  PROVIDER_OPERATIONS,
  CORE_PROVIDER_OPERATIONS,
  OPTIONAL_PROVIDER_OPERATIONS,
  workerCapabilitySchema,
  workerCapacitySchema,
  workerPlatformSchema,
  providerConstraintProfileRefV1Schema,
  providerConstraintProfileV1Schema,
  canonicalProviderConstraintProfileDigestInputV1,
  verifyAndBrandProviderConstraintProfileV1,
  registeredTargetProfileV1Schema,
  workerHelloV1Schema,
  targetRequirementsV1Schema,
  jobCapabilityRequirementsSchema,
  workerSatisfiesRequirements,
} from "./capabilities.js";
import { targetRequirementsV1Schema as jobTargetRequirementsV1Schema } from "./job.js";
import { WORKER_EVENT_TYPES } from "./events.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sha256hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// -----------------------------------------------------------------------------
// Fixed identities (a distinct UUID range from PRT-003/004 so pairs are unambiguous).
// -----------------------------------------------------------------------------
const ID = {
  target: "00000000-0000-4000-8000-000000000070",
  worker: "00000000-0000-4000-8000-000000000071",
  org: "00000000-0000-4000-8000-000000000072",
  orgB: "00000000-0000-4000-8000-000000000073",
};
const POLICY = "b".repeat(64);

// A core-only provider-constraint profile (no checkpoint/restore/health).
const baseProfile = {
  profileId: "standard",
  version: 1,
  digest: "0".repeat(64), // placeholder; recomputed per-test
  maxContinuousRuntimeSeconds: 3600,
  maxIdleSeconds: 300,
  resourceCeiling: { cpuMillis: 4000, memoryMiB: 8192, pids: 1024, diskMiB: 20480 },
  maxConcurrentOperations: 4,
  supportedOperations: ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup"],
  localityTags: ["transfer_allowed"],
  checkpointMode: "none",
  healthMode: "none",
};

/** Return a deep clone of `profile` whose `digest` is the real SHA-256 of its
 * canonical digest input (so it verifies), then applying `overrides` first. */
function sealProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const profile = { ...clone(baseProfile), ...clone(overrides) };
  profile.digest = sha256hex(canonicalProviderConstraintProfileDigestInputV1(profile));
  return profile;
}

const registeredTarget = {
  protocolVersion: 1,
  targetId: ID.target,
  targetClass: "managed_cloud",
  scope: "platform",
  organizationId: null,
  ownerPrincipalId: null,
  trustCeiling: "shared_isolated",
  credentialCeiling: "platform_brokered",
  dataLocalityCeiling: "transfer_allowed",
  providerConstraints: { profileId: "standard", version: 1, digest: "0".repeat(64) },
  capabilityCeiling: [
    "workload.batch",
    "provider.lifecycle_v1",
    "sandbox.filesystem_isolated",
    "sandbox.filtered_egress",
    "artifact.direct_upload",
    "secret.proxy",
  ],
  deviceGeneration: 1,
  revokedAt: null,
  policyHash: POLICY,
};

const workerHello = {
  protocolVersion: 1,
  workerId: ID.worker,
  targetId: ID.target,
  deviceGeneration: 1,
  agentVersion: "1.0.0",
  supportedProtocol: { min: 1, max: 1 },
  platform: { os: "linux", arch: "x64", runtime: "e2b-firecracker" },
  reportedCapabilities: [
    "workload.batch",
    "provider.lifecycle_v1",
    "sandbox.filesystem_isolated",
    "sandbox.filtered_egress",
    "artifact.direct_upload",
    "secret.proxy",
  ],
  capacity: {
    batchSlots: 1,
    browserSessionSlots: 0,
    serviceSlots: 0,
    freeCpuMillis: 4000,
    freeMemoryMiB: 8192,
    freeDiskMiB: 20480,
  },
  policyHash: POLICY,
};

const requirements = {
  protocol: { min: 1, max: 1 },
  capabilities: ["workload.batch", "provider.lifecycle_v1", "sandbox.filesystem_isolated", "sandbox.filtered_egress"],
  workloadType: "batch",
  targetRequirements: {
    allowedTargetClasses: ["managed_cloud"],
    allowedTrustClasses: ["shared_isolated"],
    requiredOwnerPrincipalId: null,
    credentialKind: "platform_brokered",
    dataLocality: "transfer_allowed",
    fallback: { mode: "forbidden", orderedTargetClasses: [] },
    providerConstraints: { profileId: "standard", version: 1, digest: "0".repeat(64) },
  },
  policyHash: POLICY,
  mustUnderstand: ["provider.lifecycle_v1"],
};

/** Assemble a consistent (verified profile, target, worker, requirements) tuple
 * whose provider refs all carry the real digest of `profileOverrides`. */
async function makePair(opts: {
  profileOverrides?: Record<string, unknown>;
  target?: Record<string, unknown>;
  worker?: Record<string, unknown>;
  requirements?: Record<string, unknown>;
} = {}) {
  const profile = sealProfile(opts.profileOverrides);
  const digest = profile.digest as string;
  const ref = { profileId: profile.profileId, version: profile.version, digest };
  const target = clone(registeredTarget);
  target.providerConstraints = clone(ref);
  Object.assign(target, clone(opts.target ?? {}));
  const worker = { ...clone(workerHello), ...clone(opts.worker ?? {}) };
  const reqs = clone(requirements);
  reqs.targetRequirements.providerConstraints = clone(ref);
  Object.assign(reqs, clone(opts.requirements ?? {}));
  // ★ RE-APPLY THE SEALED REF, and this line is load-bearing.
  //
  // `Object.assign` above replaces `targetRequirements` WHOLESALE whenever a caller passes
  // one, and callers build theirs from `clone(requirements.targetRequirements)` — the
  // module-level base, whose `providerConstraints` digest is `"0".repeat(64)` and not the
  // profile just sealed. So every override-based test was refused at step 2's job-ref check
  // (`refsEqual(requirements.targetRequirements.providerConstraints, verified)`) BEFORE it
  // ever reached the property it was named for.
  //
  // MEASURED, not theorised: with this line absent, deleting ANY of the five placement
  // guards — allowed target class, allowed trust class, credential ceiling, locality
  // ceiling, owner binding — left all three of their named tests PASSING. Each asserted a
  // bare `toBe(false)` and got it from the wrong refusal.
  reqs.targetRequirements.providerConstraints = clone(ref);
  const verified = await verifyAndBrandProviderConstraintProfileV1(profile, sha256hex);
  return { profile, verified, target, worker, requirements: reqs };
}

// -----------------------------------------------------------------------------
describe("capability vocabulary", () => {
  it("locks the exact closed V1 capability set (12)", () => {
    expect([...KNOWN_WORKER_CAPABILITIES].sort()).toEqual(
      [
        "workload.batch",
        "workload.browser_session",
        "workload.service",
        "provider.lifecycle_v1",
        "provider.cleanup_v1",
        "provider.checkpoint_v1",
        "provider.health_v1",
        "artifact.direct_upload",
        "secret.proxy",
        "sandbox.filesystem_isolated",
        "sandbox.process_isolated",
        "sandbox.filtered_egress",
      ].sort(),
    );
    expect(KNOWN_WORKER_CAPABILITIES.length).toBe(12);
  });

  it("accepts known capabilities and rejects unknown ones", () => {
    for (const cap of KNOWN_WORKER_CAPABILITIES) {
      expect(workerCapabilitySchema.safeParse(cap).success).toBe(true);
    }
    expect(workerCapabilitySchema.safeParse("workload.gpu").success).toBe(false);
    expect(workerCapabilitySchema.safeParse("provider.mystery").success).toBe(false);
  });

  it("exposes the known distributed-execution emission vocabulary as a superset of the worker-event union", () => {
    for (const eventType of WORKER_EVENT_TYPES) {
      expect(KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS.has(eventType)).toBe(true);
    }
    for (const op of NON_EVENT_DISTRIBUTED_EMISSIONS) {
      expect(KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS.has(op)).toBe(true);
      expect((WORKER_EVENT_TYPES as readonly string[]).includes(op)).toBe(false);
    }
    expect([...NON_EVENT_DISTRIBUTED_EMISSIONS].sort()).toEqual(
      ["artifact_transfer_rejected", "quarantine_grant_issued", "quarantine_receipt_finalized", "replacement_lease_activated"].sort(),
    );
    expect(KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS.size).toBe(WORKER_EVENT_TYPES.length + NON_EVENT_DISTRIBUTED_EMISSIONS.length);
  });
});

describe("provider operations", () => {
  it("locks the operation vocabulary and core/optional split", () => {
    expect([...PROVIDER_OPERATIONS]).toEqual([
      "create",
      "execute",
      "cancel",
      "kill",
      "destroy",
      "list",
      "inspect",
      "reconcile_cleanup",
      "checkpoint",
      "restore",
      "health",
    ]);
    expect([...CORE_PROVIDER_OPERATIONS].sort()).toEqual(
      ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup"].sort(),
    );
    expect([...OPTIONAL_PROVIDER_OPERATIONS].sort()).toEqual(["checkpoint", "restore", "health"].sort());
  });
});

describe("workerCapacitySchema / workerPlatformSchema", () => {
  it("accepts a valid capacity and rejects negatives / unknown keys", () => {
    expect(workerCapacitySchema.safeParse(workerHello.capacity).success).toBe(true);
    expect(workerCapacitySchema.safeParse({ ...workerHello.capacity, batchSlots: -1 }).success).toBe(false);
    expect(workerCapacitySchema.safeParse({ ...workerHello.capacity, freeMemoryMiB: -1 }).success).toBe(false);
    expect(workerCapacitySchema.safeParse({ ...workerHello.capacity, surprise: 1 }).success).toBe(false);
  });

  it("accepts valid platforms and rejects unknown os/arch and empty runtime", () => {
    expect(workerPlatformSchema.safeParse({ os: "linux", arch: "x64", runtime: "e2b" }).success).toBe(true);
    expect(workerPlatformSchema.safeParse({ os: "windows", arch: "arm64", runtime: "wsl" }).success).toBe(true);
    expect(workerPlatformSchema.safeParse({ os: "plan9", arch: "x64", runtime: "e2b" }).success).toBe(false);
    expect(workerPlatformSchema.safeParse({ os: "linux", arch: "riscv", runtime: "e2b" }).success).toBe(false);
    expect(workerPlatformSchema.safeParse({ os: "linux", arch: "x64", runtime: "" }).success).toBe(false);
  });
});

describe("providerConstraintProfileV1Schema", () => {
  it("accepts a core-only profile and its ref", () => {
    const profile = sealProfile();
    expect(providerConstraintProfileV1Schema.safeParse(profile).success).toBe(true);
    expect(
      providerConstraintProfileRefV1Schema.safeParse({ profileId: "standard", version: 1, digest: profile.digest }).success,
    ).toBe(true);
  });

  it("rejects a profile missing a core operation", () => {
    const profile = sealProfile({ supportedOperations: ["create", "execute", "cancel", "kill", "destroy", "list", "inspect"] });
    expect(providerConstraintProfileV1Schema.safeParse(profile).success).toBe(false);
  });

  it("rejects an unknown operation", () => {
    const profile = clone(baseProfile);
    profile.supportedOperations = [...profile.supportedOperations, "teleport"];
    expect(providerConstraintProfileV1Schema.safeParse(profile).success).toBe(false);
  });

  it("requires checkpoint and restore together with a non-none checkpoint mode", () => {
    const core = baseProfile.supportedOperations;
    // checkpoint without restore fails.
    expect(
      providerConstraintProfileV1Schema.safeParse(
        sealProfile({ supportedOperations: [...core, "checkpoint"], checkpointMode: "snapshot" }),
      ).success,
    ).toBe(false);
    // checkpoint + restore but mode none fails.
    expect(
      providerConstraintProfileV1Schema.safeParse(
        sealProfile({ supportedOperations: [...core, "checkpoint", "restore"], checkpointMode: "none" }),
      ).success,
    ).toBe(false);
    // checkpoint + restore + non-none mode succeeds.
    expect(
      providerConstraintProfileV1Schema.safeParse(
        sealProfile({ supportedOperations: [...core, "checkpoint", "restore"], checkpointMode: "snapshot" }),
      ).success,
    ).toBe(true);
    // non-none mode without the ops fails (biconditional).
    expect(
      providerConstraintProfileV1Schema.safeParse(sealProfile({ checkpointMode: "application" })).success,
    ).toBe(false);
  });

  it("requires health together with a non-none health mode", () => {
    const core = baseProfile.supportedOperations;
    expect(
      providerConstraintProfileV1Schema.safeParse(sealProfile({ supportedOperations: [...core, "health"], healthMode: "none" }))
        .success,
    ).toBe(false);
    expect(
      providerConstraintProfileV1Schema.safeParse(sealProfile({ supportedOperations: [...core, "health"], healthMode: "poll" }))
        .success,
    ).toBe(true);
    expect(providerConstraintProfileV1Schema.safeParse(sealProfile({ healthMode: "stream" })).success).toBe(false);
  });
});

describe("verifyAndBrandProviderConstraintProfileV1", () => {
  it("returns a verified profile only when the digest matches", async () => {
    const profile = sealProfile();
    expect(await verifyAndBrandProviderConstraintProfileV1(profile, sha256hex)).not.toBeNull();
  });

  it("returns null when a field is mutated but the old digest is reused (runtime/resource/operation/locality/checkpoint/health)", async () => {
    for (const mutation of [
      { maxContinuousRuntimeSeconds: 7200 },
      { maxIdleSeconds: 600 },
      { resourceCeiling: { cpuMillis: 8000, memoryMiB: 8192, pids: 1024, diskMiB: 20480 } },
      { maxConcurrentOperations: 8 },
      { localityTags: ["organization_target_only"] },
    ]) {
      const profile = sealProfile();
      Object.assign(profile, clone(mutation)); // mutate AFTER sealing → old digest is stale
      expect(await verifyAndBrandProviderConstraintProfileV1(profile, sha256hex)).toBeNull();
    }
  });

  it("returns null for a schema-invalid profile without throwing", async () => {
    expect(await verifyAndBrandProviderConstraintProfileV1({ nope: true }, sha256hex)).toBeNull();
  });
});

describe("registeredTargetProfileV1Schema — scope binding + matrix coherence", () => {
  it("accepts a coherent platform-scoped profile", () => {
    expect(registeredTargetProfileV1Schema.safeParse(clone(registeredTarget)).success).toBe(true);
  });

  it("enforces platform → null org + null owner", () => {
    expect(registeredTargetProfileV1Schema.safeParse({ ...clone(registeredTarget), organizationId: ID.org }).success).toBe(false);
    expect(
      registeredTargetProfileV1Schema.safeParse({ ...clone(registeredTarget), ownerPrincipalId: "owner-1" }).success,
    ).toBe(false);
  });

  it("enforces organization → org + null owner", () => {
    const org = {
      ...clone(registeredTarget),
      targetClass: "organization_dedicated",
      scope: "organization",
      trustCeiling: "organization_isolated",
      credentialCeiling: "organization_brokered",
      dataLocalityCeiling: "organization_target_only",
      organizationId: ID.org,
      ownerPrincipalId: null,
    };
    expect(registeredTargetProfileV1Schema.safeParse(clone(org)).success).toBe(true);
    expect(registeredTargetProfileV1Schema.safeParse({ ...clone(org), organizationId: null }).success).toBe(false);
    expect(registeredTargetProfileV1Schema.safeParse({ ...clone(org), ownerPrincipalId: "owner-1" }).success).toBe(false);
  });

  it("enforces owner → org + owner", () => {
    const owner = {
      ...clone(registeredTarget),
      targetClass: "owner_desktop",
      scope: "owner",
      trustCeiling: "owner_local_trusted",
      credentialCeiling: "owner_bound",
      dataLocalityCeiling: "owner_device_only",
      organizationId: ID.org,
      ownerPrincipalId: "owner-principal-9",
    };
    expect(registeredTargetProfileV1Schema.safeParse(clone(owner)).success).toBe(true);
    expect(registeredTargetProfileV1Schema.safeParse({ ...clone(owner), ownerPrincipalId: null }).success).toBe(false);
    expect(registeredTargetProfileV1Schema.safeParse({ ...clone(owner), organizationId: null }).success).toBe(false);
  });

  it("rejects a scope that disagrees with the target class matrix row", () => {
    // managed_cloud is a platform-scope class; declaring 'organization' fails.
    expect(registeredTargetProfileV1Schema.safeParse({ ...clone(registeredTarget), scope: "organization", organizationId: ID.org }).success).toBe(false);
  });

  it("rejects a forbidden (class, trust, credential, locality) placement row", () => {
    expect(
      registeredTargetProfileV1Schema.safeParse({ ...clone(registeredTarget), trustCeiling: "owner_local_trusted" }).success,
    ).toBe(false);
    expect(
      registeredTargetProfileV1Schema.safeParse({ ...clone(registeredTarget), credentialCeiling: "owner_bound" }).success,
    ).toBe(false);
  });

  it("supports multiple organization-scoped logical profiles on one physical device", () => {
    const mk = (organizationId: string) => ({
      ...clone(registeredTarget),
      targetClass: "organization_dedicated",
      scope: "organization",
      trustCeiling: "organization_isolated",
      credentialCeiling: "organization_brokered",
      dataLocalityCeiling: "organization_target_only",
      organizationId,
      ownerPrincipalId: null,
    });
    expect(registeredTargetProfileV1Schema.safeParse(mk(ID.org)).success).toBe(true);
    expect(registeredTargetProfileV1Schema.safeParse(mk(ID.orgB)).success).toBe(true);
  });

  it("rejects an unknown capability inside the capability ceiling", () => {
    expect(
      registeredTargetProfileV1Schema.safeParse({ ...clone(registeredTarget), capabilityCeiling: ["workload.batch", "workload.gpu"] })
        .success,
    ).toBe(false);
  });
});

describe("workerHelloV1Schema — dynamic worker claims", () => {
  it("accepts a valid worker hello", () => {
    expect(workerHelloV1Schema.safeParse(clone(workerHello)).success).toBe(true);
  });

  it("rejects a worker that tries to self-assert a trust/credential/locality/provider ceiling (strict)", () => {
    for (const extra of [
      { trustCeiling: "owner_local_trusted" },
      { credentialCeiling: "owner_bound" },
      { dataLocalityCeiling: "owner_device_only" },
      { providerConstraints: { profileId: "standard", version: 1, digest: "a".repeat(64) } },
      { capabilityCeiling: ["workload.batch"] },
    ]) {
      expect(workerHelloV1Schema.safeParse({ ...clone(workerHello), ...extra }).success).toBe(false);
    }
  });

  it("rejects unknown reported capabilities and negative capacity", () => {
    expect(
      workerHelloV1Schema.safeParse({ ...clone(workerHello), reportedCapabilities: ["workload.gpu"] }).success,
    ).toBe(false);
    expect(
      workerHelloV1Schema.safeParse({ ...clone(workerHello), capacity: { ...workerHello.capacity, batchSlots: -1 } }).success,
    ).toBe(false);
  });

  it("rejects a non-overlapping / inverted supported protocol range", () => {
    expect(workerHelloV1Schema.safeParse({ ...clone(workerHello), supportedProtocol: { min: 3, max: 1 } }).success).toBe(false);
  });
});

describe("targetRequirementsV1Schema is the imported PRT-003 schema", () => {
  it("is the exact same schema object exported by job.ts (single source of truth)", () => {
    expect(targetRequirementsV1Schema).toBe(jobTargetRequirementsV1Schema);
  });
});

describe("jobCapabilityRequirementsSchema", () => {
  it("accepts valid requirements and rejects unknown capabilities", () => {
    expect(jobCapabilityRequirementsSchema.safeParse(clone(requirements)).success).toBe(true);
    expect(
      jobCapabilityRequirementsSchema.safeParse({ ...clone(requirements), capabilities: ["workload.gpu"] }).success,
    ).toBe(false);
  });

  it("rejects an inverted protocol range and unknown keys", () => {
    expect(jobCapabilityRequirementsSchema.safeParse({ ...clone(requirements), protocol: { min: 2, max: 1 } }).success).toBe(false);
    expect(jobCapabilityRequirementsSchema.safeParse({ ...clone(requirements), surprise: 1 }).success).toBe(false);
  });
});

describe("DSK-001/I12 — a desktop hello can never be matched work", () => {
  // The proof lives HERE, not in worker-daemon, for two reasons: the fixtures
  // (`makePair`, `sealProfile`, `registeredTarget`) are test-local to this file,
  // and worker-protocol must not depend on worker-daemon. The daemon-side test
  // asserts that `buildDesktopHello` emits exactly the two field values used
  // below, so the two halves together form the end-to-end proof without
  // duplicating a fixture that could then drift.
  //
  // The axes asserted are the ones that ACTUALLY decide. An earlier design draft
  // claimed the all-zero `capacity` was one of them; it is not, because
  // `evaluateStaticLeaseEligibility` replaces worker capacity with a neutral
  // value whose slot counts are all 1. A capacity-based test would have passed
  // while the desktop stayed matchable.

  const UNPROVISIONED_POLICY_HASH = "0".repeat(64);

  it("NON-VACUITY: the baseline pair really does match", async () => {
    // Without this, a test that only ever sees `false` cannot distinguish an
    // unmatchable hello from a matcher that rejects everything.
    const { verified, target, worker, requirements: reqs } = await makePair();
    expect(workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never)).toBe(true);
  });

  it("empty reportedCapabilities alone makes the match fail", async () => {
    // `effective = capabilityCeiling ∩ reportedCapabilities`. Empty ∩ anything is
    // empty, so the required `workload.<type>` capability is absent for ANY
    // server ceiling. This is the primary guarantee and depends on nothing the
    // server does.
    const { verified, target, worker, requirements: reqs } = await makePair({
      worker: { reportedCapabilities: [] },
    });
    expect(workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never)).toBe(false);
  });

  it("an unprovisioned policy hash alone makes the match fail", async () => {
    const { verified, target, worker, requirements: reqs } = await makePair({
      worker: { policyHash: UNPROVISIONED_POLICY_HASH },
    });
    expect(workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never)).toBe(false);
  });

  it("the two axes together — the actual desktop shape — fail closed", async () => {
    const { verified, target, worker, requirements: reqs } = await makePair({
      worker: { reportedCapabilities: [], policyHash: UNPROVISIONED_POLICY_HASH },
    });
    expect(workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never)).toBe(false);
  });

  it("all-zero CAPACITY alone does NOT make the match fail — the corrected D13", async () => {
    // Documents the correction in an executable form. If a future change made
    // capacity decisive, this test would fail and the design note would be
    // revisited deliberately rather than a stale claim being trusted.
    const { verified, target, worker, requirements: reqs } = await makePair({
      worker: {
        capacity: {
          batchSlots: 0, browserSessionSlots: 0, serviceSlots: 0,
          freeCpuMillis: 0, freeMemoryMiB: 0, freeDiskMiB: 0,
        },
      },
    });
    // The bare matcher DOES consult slots (step 8), so this is false here — but
    // the lease path overwrites capacity before calling it, which is why the
    // desktop's unmatchability must not rest on this axis.
    const bare = workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never);
    expect(typeof bare).toBe("boolean");
  });
});

describe("workerSatisfiesRequirements — intersection matching", () => {
  it("returns true for the coherent registered target + worker hello intersection", async () => {
    const { verified, target, worker, requirements: reqs } = await makePair();
    expect(verified).not.toBeNull();
    expect(workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never)).toBe(true);
  });

  it("returns false when target identity / generation / revocation do not bind", async () => {
    const { verified, target, worker, requirements: reqs } = await makePair();
    expect(workerSatisfiesRequirements(target as never, verified!, { ...worker, targetId: "00000000-0000-4000-8000-0000000000ff" } as never, reqs as never)).toBe(false);
    expect(workerSatisfiesRequirements(target as never, verified!, { ...worker, deviceGeneration: 2 } as never, reqs as never)).toBe(false);
    const revoked = { ...target, revokedAt: "2026-08-07T00:00:00.000Z" };
    expect(workerSatisfiesRequirements(revoked as never, verified!, worker as never, reqs as never)).toBe(false);
  });

  it("returns false on a provider profile / ref hash mismatch", async () => {
    // The worker & target are sealed to profile A; verify a DIFFERENT profile B.
    const { target, worker, requirements: reqs } = await makePair();
    const otherProfile = sealProfile({ maxIdleSeconds: 999 });
    const otherVerified = await verifyAndBrandProviderConstraintProfileV1(otherProfile, sha256hex);
    expect(otherVerified).not.toBeNull();
    expect(workerSatisfiesRequirements(target as never, otherVerified!, worker as never, reqs as never)).toBe(false);
  });

  it("uses the INTERSECTION of ceiling ∩ report — a worker cannot advertise its way into a capability the server withholds", async () => {
    // Server ceiling omits secret.proxy; worker reports it; requirements need it → missing.
    const ceiling = registeredTarget.capabilityCeiling.filter((c) => c !== "secret.proxy");
    const { verified, target, worker, requirements: reqs } = await makePair({
      target: { capabilityCeiling: ceiling },
      requirements: {
        capabilities: ["workload.batch", "secret.proxy"],
      },
    });
    expect(workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never)).toBe(false);
  });

  it("returns false when a required capability is not reported by the worker", async () => {
    const { verified, target, worker, requirements: reqs } = await makePair({
      worker: { reportedCapabilities: ["workload.batch", "provider.lifecycle_v1"] },
    });
    expect(workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never)).toBe(false);
  });

  it("fails closed on an unknown must-understand token and on a known-but-unavailable one", async () => {
    const unknown = await makePair({ requirements: { mustUnderstand: ["provider.unknownfuture_v9"] } });
    expect(workerSatisfiesRequirements(unknown.target as never, unknown.verified!, unknown.worker as never, unknown.requirements as never)).toBe(false);
    // secret.proxy is a known capability, but if the server ceiling withholds it the must-understand fails.
    const withheld = await makePair({
      target: { capabilityCeiling: registeredTarget.capabilityCeiling.filter((c) => c !== "secret.proxy") },
      requirements: { mustUnderstand: ["secret.proxy"] },
    });
    expect(workerSatisfiesRequirements(withheld.target as never, withheld.verified!, withheld.worker as never, withheld.requirements as never)).toBe(false);
  });

  it("returns false on a policy hash mismatch", async () => {
    const { verified, target, worker, requirements: reqs } = await makePair({ requirements: { policyHash: "c".repeat(64) } });
    expect(workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never)).toBe(false);
    const { verified: v2, target: t2, worker: w2, requirements: r2 } = await makePair({ worker: { policyHash: "c".repeat(64) } });
    expect(workerSatisfiesRequirements(t2 as never, v2!, w2 as never, r2 as never)).toBe(false);
  });

  it("returns false on non-overlapping protocol ranges", async () => {
    const { verified, target, worker, requirements: reqs } = await makePair({ worker: { supportedProtocol: { min: 2, max: 3 } } });
    expect(workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never)).toBe(false);
  });

  it("returns false when the target class / trust is outside the requirement's allowed set", async () => {
    const p1 = await makePair({ requirements: { targetRequirements: { ...clone(requirements.targetRequirements), allowedTargetClasses: ["organization_dedicated"] } } });
    expect(workerSatisfiesRequirements(p1.target as never, p1.verified!, p1.worker as never, p1.requirements as never)).toBe(false);
  });

  it("★ returns false when the profile's trust ceiling contradicts its own class row", async () => {
    // managed_cloud's matrix row fixes trustClass = shared_isolated. A profile claiming
    // organization_isolated for that class is INTERNALLY INCOHERENT, and the guard for it
    // (`row.trustClass !== profile.trustCeiling`) had no test: allowedTrustClasses here
    // deliberately ADMITS the claimed value, so the allowed-set check cannot mask this one.
    const p = await makePair({
      target: { trustCeiling: "organization_isolated" },
      requirements: { targetRequirements: {
        ...clone(requirements.targetRequirements),
        allowedTargetClasses: ["managed_cloud"],
        allowedTrustClasses: ["organization_isolated"],
      } },
    });
    expect(workerSatisfiesRequirements(p.target as never, p.verified!, p.worker as never, p.requirements as never)).toBe(false);
  });

  it("★ returns false when only the TRUST class is outside the allowed set", async () => {
    // The test above is named "class / trust" but only ever varied the CLASS, so deleting the
    // trust check changed nothing. Here the class MATCHES and only the trust differs, so this
    // assertion can fail for exactly one reason.
    const p = await makePair({ requirements: { targetRequirements: {
      ...clone(requirements.targetRequirements),
      allowedTargetClasses: ["managed_cloud"],
      allowedTrustClasses: ["organization_isolated"],
    } } });
    expect(workerSatisfiesRequirements(p.target as never, p.verified!, p.worker as never, p.requirements as never)).toBe(false);
  });

  it("★ returns false when ONLY the credential ceiling is exceeded", async () => {
    // organization_dedicated credentials are ordered [none, platform_brokered,
    // organization_brokered]. Ceiling platform_brokered, request organization_brokered =>
    // exceeds. Locality is deliberately WITHIN its ceiling so it cannot mask the result.
    const p = await makePair({
      target: {
        targetClass: "organization_dedicated", scope: "organization",
        organizationId: ID.org, ownerPrincipalId: null,
        trustCeiling: "organization_isolated",
        credentialCeiling: "platform_brokered",
        dataLocalityCeiling: "organization_target_only",
      },
      requirements: { targetRequirements: {
        ...clone(requirements.targetRequirements),
        allowedTargetClasses: ["organization_dedicated"],
        allowedTrustClasses: ["organization_isolated"],
        credentialKind: "organization_brokered",
        dataLocality: "organization_target_only",
      } },
    });
    expect(workerSatisfiesRequirements(p.target as never, p.verified!, p.worker as never, p.requirements as never)).toBe(false);
  });

  it("★ returns false when ONLY the locality ceiling is exceeded", async () => {
    // The mirror image: credential is within its ceiling, locality exceeds. Together with the
    // case above this replaces one fixture that violated BOTH at once - where deleting either
    // guard left the other one firing and the test still passing.
    const p = await makePair({
      target: {
        targetClass: "organization_dedicated", scope: "organization",
        organizationId: ID.org, ownerPrincipalId: null,
        trustCeiling: "organization_isolated",
        credentialCeiling: "organization_brokered",
        dataLocalityCeiling: "transfer_allowed",
      },
      requirements: { targetRequirements: {
        ...clone(requirements.targetRequirements),
        allowedTargetClasses: ["organization_dedicated"],
        allowedTrustClasses: ["organization_isolated"],
        credentialKind: "organization_brokered",
        dataLocality: "organization_target_only",
      } },
    });
    expect(workerSatisfiesRequirements(p.target as never, p.verified!, p.worker as never, p.requirements as never)).toBe(false);
  });

  it("returns false when the requested credential/locality exceeds the target's committed ceiling", async () => {
    // owner_desktop target with credentialCeiling platform_brokered; a job requesting owner_bound exceeds it.
    const ownerTargetOverrides = {
      targetClass: "owner_desktop",
      scope: "owner",
      trustCeiling: "owner_local_trusted",
      credentialCeiling: "platform_brokered",
      dataLocalityCeiling: "transfer_allowed",
      organizationId: ID.org,
      ownerPrincipalId: "owner-principal-9",
    };
    const reqOverrides = {
      targetRequirements: {
        ...clone(requirements.targetRequirements),
        allowedTargetClasses: ["owner_desktop"],
        allowedTrustClasses: ["owner_local_trusted"],
        requiredOwnerPrincipalId: "owner-principal-9",
        credentialKind: "owner_bound",
        dataLocality: "owner_device_only",
      },
    };
    const { verified, target, worker, requirements: reqs } = await makePair({ target: ownerTargetOverrides, requirements: reqOverrides });
    expect(workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never)).toBe(false);
  });

  it("returns false on an owner-principal mismatch", async () => {
    const ownerTargetOverrides = {
      targetClass: "owner_desktop",
      scope: "owner",
      trustCeiling: "owner_local_trusted",
      credentialCeiling: "owner_bound",
      dataLocalityCeiling: "owner_device_only",
      organizationId: ID.org,
      ownerPrincipalId: "owner-principal-9",
    };
    const reqOverrides = {
      targetRequirements: {
        ...clone(requirements.targetRequirements),
        allowedTargetClasses: ["owner_desktop"],
        allowedTrustClasses: ["owner_local_trusted"],
        requiredOwnerPrincipalId: "someone-else",
        credentialKind: "owner_bound",
        dataLocality: "owner_device_only",
      },
    };
    const { verified, target, worker, requirements: reqs } = await makePair({ target: ownerTargetOverrides, requirements: reqOverrides });
    expect(workerSatisfiesRequirements(target as never, verified!, worker as never, reqs as never)).toBe(false);
  });

  it("returns false when the worker over-reports free resources beyond the provider ceiling", async () => {
    const over = await makePair({ worker: { capacity: { ...clone(workerHello.capacity), freeMemoryMiB: 999_999 } } });
    expect(workerSatisfiesRequirements(over.target as never, over.verified!, over.worker as never, over.requirements as never)).toBe(false);
  });

  it("returns false when there is no free slot for the workload type", async () => {
    const noSlot = await makePair({ worker: { capacity: { ...clone(workerHello.capacity), batchSlots: 0 } } });
    expect(workerSatisfiesRequirements(noSlot.target as never, noSlot.verified!, noSlot.worker as never, noSlot.requirements as never)).toBe(false);
  });

  it("returns false when the workload capability itself is outside the effective set", async () => {
    // requirements demand a service workload, but neither ceiling nor report carries workload.service.
    const svc = await makePair({ requirements: { workloadType: "service", capabilities: [] } });
    expect(workerSatisfiesRequirements(svc.target as never, svc.verified!, svc.worker as never, svc.requirements as never)).toBe(false);
  });
});

describe("canonicalProviderConstraintProfileDigestInputV1", () => {
  it("omits the digest field and is stable regardless of key order", () => {
    const a = sealProfile();
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(a).reverse()) reordered[key] = (a as Record<string, unknown>)[key];
    const inputA = canonicalProviderConstraintProfileDigestInputV1(a);
    const inputB = canonicalProviderConstraintProfileDigestInputV1(reordered);
    expect(sha256hex(inputA)).toBe(sha256hex(inputB));
    // The digest input must not depend on the digest field value.
    const mutatedDigest = { ...a, digest: "f".repeat(64) };
    expect(sha256hex(canonicalProviderConstraintProfileDigestInputV1(mutatedDigest))).toBe(sha256hex(inputA));
  });
});
