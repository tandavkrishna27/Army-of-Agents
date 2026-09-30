import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  canonicalProviderConstraintProfileDigestInputV1,
  canonicalizeJsonV1,
  type JobCapabilityRequirementsV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";

type Decide = (input: Record<string, unknown>) => Record<string, unknown>;

const ORG = "93000000-0000-4000-8000-000000000001";
const OWNER = "job-009-owner";
const POLICY_HASH = "a".repeat(64);
const INPUT_DIGEST = "b".repeat(64);
const POLICY_DIGEST = "c".repeat(64);
const NOW = new Date("2026-08-10T10:00:00.000Z");

let decide: Decide | null = null;
let placementModule: Record<string, unknown> | null = null;
let resolverModule: Record<string, unknown> | null = null;

beforeAll(async () => {
  const module = await import("../services/job-placement.js").catch(() => null);
  const resolver = await import("../services/execution-target-resolver.js").catch(() => null);
  placementModule = module as Record<string, unknown> | null;
  resolverModule = resolver as Record<string, unknown> | null;
  decide = module && typeof module.decideJobPlacement === "function"
    ? module.decideJobPlacement as Decide
    : null;
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(overrides: Partial<ProviderConstraintProfileV1> = {}): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "provider-v1",
    version: 1,
    maxContinuousRuntimeSeconds: 3_600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 4_000, memoryMiB: 8_192, pids: 1_024, diskMiB: 16_384 },
    maxConcurrentOperations: 8,
    supportedOperations: [
      "create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup",
    ],
    localityTags: ["transfer_allowed"],
    checkpointMode: "none",
    healthMode: "none",
    ...overrides,
  } as Omit<ProviderConstraintProfileV1, "digest">;
  return {
    ...unsigned,
    digest: sha256(canonicalProviderConstraintProfileDigestInputV1(unsigned)),
  };
}

function targetProfile(input: {
  targetId: string;
  targetClass: "managed_cloud" | "organization_dedicated" | "owner_desktop";
  provider: ProviderConstraintProfileV1;
}): RegisteredTargetProfileV1 {
  const rows = {
    managed_cloud: {
      scope: "platform", organizationId: null, ownerPrincipalId: null,
      trustCeiling: "shared_isolated", credentialCeiling: "platform_brokered",
      dataLocalityCeiling: "transfer_allowed",
    },
    organization_dedicated: {
      scope: "organization", organizationId: ORG, ownerPrincipalId: null,
      trustCeiling: "organization_isolated", credentialCeiling: "organization_brokered",
      dataLocalityCeiling: "organization_target_only",
    },
    owner_desktop: {
      scope: "owner", organizationId: ORG, ownerPrincipalId: OWNER,
      trustCeiling: "owner_local_trusted", credentialCeiling: "owner_bound",
      dataLocalityCeiling: "owner_device_only",
    },
  } as const;
  return {
    protocolVersion: 1,
    targetId: input.targetId,
    targetClass: input.targetClass,
    ...rows[input.targetClass],
    providerConstraints: {
      profileId: input.provider.profileId,
      version: input.provider.version,
      digest: input.provider.digest,
    },
    capabilityCeiling: ["workload.batch", "sandbox.process_isolated", "provider.lifecycle_v1"],
    deviceGeneration: 1,
    revokedAt: null,
    policyHash: POLICY_HASH,
  };
}

function candidate(
  targetClass: "managed_cloud" | "organization_dedicated" | "owner_desktop",
  suffix: number,
  overrides: Record<string, unknown> = {},
) {
  const targetId = `94000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
  const provider = providerProfile();
  const profile = targetProfile({ targetId, targetClass, provider });
  const worker: WorkerHelloV1 = {
    protocolVersion: 1,
    workerId: `95000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`,
    targetId,
    deviceGeneration: 1,
    agentVersion: "job-009-test",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "worker" },
    reportedCapabilities: ["workload.batch", "sandbox.process_isolated", "provider.lifecycle_v1"],
    capacity: {
      batchSlots: 2, browserSessionSlots: 0, serviceSlots: 0,
      freeCpuMillis: 2_000, freeMemoryMiB: 4_096, freeDiskMiB: 8_192,
    },
    policyHash: POLICY_HASH,
  };
  return {
    registry: {
      targetId,
      targetSlug: `target-${suffix}`,
      targetClass,
      targetScope: profile.scope,
      targetGeneration: 1,
      profileHash: sha256(canonicalizeJsonV1(profile)),
      providerConstraintHash: provider.digest,
      status: "active",
      lastSeenAt: new Date(NOW.getTime() - 1_000),
      registeredProfile: profile,
      providerConstraintProfile: provider,
    },
    worker,
    workerProfileHash: sha256(JSON.stringify(worker)),
    workerStatus: "active",
    ownerMembershipActive: true,
    currentOperations: 0,
    ...overrides,
  };
}

function requirements(
  classes: Array<"managed_cloud" | "organization_dedicated" | "owner_desktop"> = ["managed_cloud"],
  overrides: Record<string, unknown> = {},
): JobCapabilityRequirementsV1 {
  const trust = {
    managed_cloud: "shared_isolated",
    organization_dedicated: "organization_isolated",
    owner_desktop: "owner_local_trusted",
  } as const;
  return {
    protocol: { min: 1, max: 1 },
    capabilities: ["sandbox.process_isolated"],
    workloadType: "batch",
    targetRequirements: {
      allowedTargetClasses: classes,
      allowedTrustClasses: classes.map((value) => trust[value]),
      requiredOwnerPrincipalId: null,
      credentialKind: "platform_brokered",
      dataLocality: "transfer_allowed",
      fallback: { mode: "ordered_explicit", orderedTargetClasses: classes },
      providerConstraints: {
        profileId: "provider-v1", version: 1, digest: providerProfile().digest,
      },
    },
    policyHash: POLICY_HASH,
    mustUnderstand: [],
    ...overrides,
  } as JobCapabilityRequirementsV1;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    sourceKind: "task_run",
    rollout: { enabled: true, mode: "active", reason: "enabled" },
    requirements: requirements(),
    providerDemand: {
      maxRuntimeSeconds: 600,
      maxIdleSeconds: 60,
      resources: { cpuMillis: 1_000, memoryMiB: 1_024, pids: 128, diskMiB: 1_024 },
      concurrentOperations: 1,
      operations: ["create", "execute"],
      localityTags: ["transfer_allowed"],
    },
    credentialOwnerPrincipalId: null,
    now: NOW,
    maxHeartbeatAgeMs: 30_000,
    inputDigest: INPUT_DIGEST,
    policyDigest: POLICY_DIGEST,
    candidates: [candidate("managed_cloud", 1)],
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  expect(decide, "JOB-009 pure policy must load without DB/worker/provider side effects").not.toBeNull();
  return decide!(input(overrides));
}

function seededShuffle<T>(values: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const next = state % (index + 1);
    [result[index], result[next]] = [result[next]!, result[index]!];
  }
  return result;
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((rest) => [value, ...rest]));
}

function resolverRow(input: {
  suffix: number;
  slug: string;
  targetClass: "managed_cloud" | "organization_dedicated" | "owner_desktop";
}) {
  const targetId = `94100000-0000-4000-8000-${input.suffix.toString().padStart(12, "0")}`;
  const provider = providerProfile();
  const profile = targetProfile({ targetId, targetClass: input.targetClass, provider });
  const legacy = {
    managed_cloud: { kind: "pooled_gvisor", trustClass: "shared_multitenant" },
    organization_dedicated: { kind: "dedicated_worker", trustClass: "dedicated_tenant" },
    owner_desktop: { kind: "local_host", trustClass: "local_trusted" },
  } as const;
  return {
    id: targetId,
    slug: input.slug,
    ...legacy[input.targetClass],
    status: "active",
    organizationId: profile.organizationId,
    ownerUserId: profile.ownerPrincipalId,
    scope: profile.scope,
    targetAuthorityKey: profile.scope === "platform"
      ? "platform"
      : profile.scope === "organization"
        ? `organization:${ORG}`
        : `owner:${ORG}:${OWNER}`,
    deviceGeneration: 1,
    registeredProfile: profile,
  };
}

describe("JOB-009 slice B deterministic placement policy", () => {
  it("[I-07] gives every Decision #117 candidate permutation one registered-authority order", () => {
    const order = resolverModule?.sortExecutionTargetRowsForPlacement;
    const choose = resolverModule?.chooseExecutionTargetRow;
    expect(typeof order, "placement must total-order candidates before Decision #117 resolution").toBe("function");
    expect(typeof choose).toBe("function");
    if (typeof order !== "function" || typeof choose !== "function") return;

    const rows = [
      resolverRow({ suffix: 2, slug: "pool-b", targetClass: "managed_cloud" }),
      resolverRow({ suffix: 1, slug: "pool-a", targetClass: "managed_cloud" }),
      resolverRow({ suffix: 4, slug: "dedicated-b", targetClass: "organization_dedicated" }),
      resolverRow({ suffix: 3, slug: "dedicated-a", targetClass: "organization_dedicated" }),
      resolverRow({ suffix: 6, slug: "owner-b", targetClass: "owner_desktop" }),
      resolverRow({ suffix: 5, slug: "owner-a", targetClass: "owner_desktop" }),
    ];
    const expectedOrder = [rows[1]!.id, rows[0]!.id, rows[3]!.id, rows[2]!.id, rows[5]!.id, rows[4]!.id];
    const expectedShared = rows[1]!.id;
    const expectedBoundOwner = rows[4]!.id;
    const expectedPin = rows[2]!.id;

    for (const candidateOrder of permutations(rows)) {
      const sorted = (order as (targets: unknown[]) => typeof rows)(candidateOrder);
      expect(sorted.map((target) => target.id)).toEqual(expectedOrder);
      expect((choose as (input: unknown) => { id: string } | null)({
        credentialKind: "company_api_key",
        pinnedTargetId: null,
        executionTargetSlug: null,
        targets: sorted,
      })?.id).toBe(expectedShared);
      expect((choose as (input: unknown) => { id: string } | null)({
        credentialKind: "personal_subscription",
        pinnedTargetId: null,
        executionTargetSlug: "owner-b",
        targets: sorted,
      })?.id).toBe(expectedBoundOwner);
      expect((choose as (input: unknown) => { id: string } | null)({
        credentialKind: "company_api_key",
        pinnedTargetId: expectedPin,
        executionTargetSlug: null,
        targets: sorted,
      })?.id).toBe(expectedPin);
    }

    const sameSlug = [
      resolverRow({ suffix: 8, slug: "same-pool", targetClass: "managed_cloud" }),
      resolverRow({ suffix: 7, slug: "same-pool", targetClass: "managed_cloud" }),
    ];
    for (const candidateOrder of permutations(sameSlug)) {
      const sorted = (order as (targets: unknown[]) => typeof sameSlug)(candidateOrder);
      expect(sorted.map((target) => target.id)).toEqual([sameSlug[1]!.id, sameSlug[0]!.id]);
    }
  });

  it("[I-01] normalizes the exact JOB-001 persisted shapes without caller-authored provider authority", async () => {
    const normalize = placementModule?.normalizeSubmittedJobPlacementFacts;
    expect(typeof normalize, "JOB-001 persisted facts need a production JOB-009 normalizer").toBe("function");
    if (typeof normalize !== "function") return;
    const normalized = await (normalize as (input: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>)({
      sourceKind: "browser_request",
      inputHash: INPUT_DIGEST,
      policyHash: POLICY_HASH,
      requirements: {
        workloadType: "browser_session",
        requiredCapabilities: ["browser.chromium"],
      },
      placementRequest: {
        policyId: "job-submission-default",
        policyVersion: 1,
        requestedTarget: null,
      },
      rollout: { enabled: true, mode: "active", reason: "enabled" },
      credentialBinding: {
        credentialId: null,
        credentialKind: null,
        executionTargetSlug: null,
        pinnedTargetId: null,
      },
      resolvedTarget: candidate("managed_cloud", 1).registry,
    });
    expect(normalized).toMatchObject({ success: true });
    expect(JSON.stringify(normalized)).not.toContain("credentialOwnerPrincipalId");
  });

  it("[I-03] honors exact Decision #117 target identity instead of re-routing lexicographically", () => {
    const first = candidate("owner_desktop", 1);
    const bound = candidate("owner_desktop", 2);
    const ownerRequirements = requirements(["owner_desktop"], {
      targetRequirements: {
        ...requirements(["owner_desktop"]).targetRequirements,
        requiredOwnerPrincipalId: OWNER,
        credentialKind: "owner_bound",
        dataLocality: "owner_device_only",
        fallback: { mode: "forbidden", orderedTargetClasses: [] },
      },
    });
    expect(run({
      requirements: ownerRequirements,
      credentialOwnerPrincipalId: OWNER,
      resolvedTargetId: bound.registry.targetId,
      targetIdentityPolicy: {
        disposition: "required",
        targetId: bound.registry.targetId,
        targetSlug: "owner-bound",
        unavailableDisposition: "queue",
      },
      candidates: [first, bound],
    })).toMatchObject({ disposition: "selected", targetId: bound.registry.targetId });

    expect(run({
      requirements: ownerRequirements,
      credentialOwnerPrincipalId: OWNER,
      resolvedTargetId: bound.registry.targetId,
      targetIdentityPolicy: {
        disposition: "forbidden",
        targetId: bound.registry.targetId,
        targetSlug: "owner-bound",
        unavailableDisposition: "fail",
      },
      candidates: [bound],
    })).toMatchObject({ disposition: "failed", targetId: null, leaseEligible: false });

    const unavailablePreferred = {
      ...bound,
      workerStatus: "draining",
    };
    expect(run({
      requirements: ownerRequirements,
      credentialOwnerPrincipalId: OWNER,
      targetIdentityPolicy: {
        disposition: "preferred",
        targetId: bound.registry.targetId,
        targetSlug: "owner-bound",
        unavailableDisposition: "queue",
      },
      candidates: [first, unavailablePreferred],
    })).toMatchObject({
      disposition: "queued",
      targetId: null,
      fallbackDisposition: "forbidden",
      leaseEligible: false,
    });

    const explicitFallback = {
      ...ownerRequirements,
      targetRequirements: {
        ...ownerRequirements.targetRequirements,
        fallback: { mode: "ordered_explicit" as const, orderedTargetClasses: ["owner_desktop" as const] },
      },
    };
    expect(run({
      requirements: explicitFallback,
      credentialOwnerPrincipalId: OWNER,
      targetIdentityPolicy: {
        disposition: "preferred",
        targetId: bound.registry.targetId,
        targetSlug: "owner-bound",
        unavailableDisposition: "queue",
      },
      candidates: [first, unavailablePreferred],
    })).toMatchObject({
      disposition: "selected",
      targetId: first.registry.targetId,
      fallbackDisposition: "ordered_explicit",
    });
  });

  it("keeps legacy authoritative when any rollout gate is off", () => {
    expect(run({ rollout: { enabled: false, mode: "legacy", reason: "organization_disabled" } })).toMatchObject({
      disposition: "legacy", owner: "legacy", leaseEligible: false, reasonCode: "organization_disabled",
    });
  });

  it("selects a server-compatible target and makes shadow ineligible", () => {
    expect(run()).toMatchObject({
      disposition: "selected", owner: "managed_cloud", targetClass: "managed_cloud",
      fallbackDisposition: "primary", reasonCode: "target_selected", leaseEligible: true,
    });
    expect(run({ rollout: { enabled: true, mode: "shadow", reason: "enabled" } })).toMatchObject({
      disposition: "selected", mode: "shadow", leaseEligible: false, reasonCode: "shadow_selected",
    });
  });

  it("never widens a false privileged hello or provider/runtime/resource/operation ceiling", () => {
    const base = candidate("managed_cloud", 1);
    const reducedWorker = { ...base.worker, reportedCapabilities: ["workload.batch"] as const };
    const falseHello = {
      ...base,
      worker: reducedWorker,
      workerProfileHash: sha256(JSON.stringify(reducedWorker)),
    };
    expect(run({ candidates: [falseHello] })).toMatchObject({ disposition: "queued", reasonCode: "no_eligible_target" });

    for (const providerDemand of [
      { ...input().providerDemand, maxRuntimeSeconds: 3_601 },
      { ...input().providerDemand, resources: { cpuMillis: 4_001, memoryMiB: 1_024, pids: 128, diskMiB: 1_024 } },
      { ...input().providerDemand, operations: ["create", "checkpoint"] },
      { ...input().providerDemand, concurrentOperations: 9 },
      { ...input().providerDemand, localityTags: ["owner_device_only"] },
    ]) {
      expect(run({ providerDemand })).toMatchObject({ disposition: "queued", reasonCode: "no_eligible_target" });
    }
  });

  it("fails owner membership/credential binding and local-only to cloud closed", () => {
    const ownerRequirements = requirements(["owner_desktop"], {
      targetRequirements: {
        ...requirements(["owner_desktop"]).targetRequirements,
        requiredOwnerPrincipalId: OWNER,
        credentialKind: "owner_bound",
        dataLocality: "owner_device_only",
        fallback: { mode: "forbidden", orderedTargetClasses: [] },
      },
    });
    expect(run({
      requirements: ownerRequirements,
      credentialOwnerPrincipalId: OWNER,
      candidates: [candidate("owner_desktop", 3, { ownerMembershipActive: false })],
    })).toMatchObject({ disposition: "queued", reasonCode: "required_target_unavailable" });
    expect(run({ requirements: ownerRequirements, candidates: [candidate("managed_cloud", 1)] }))
      .toMatchObject({ disposition: "queued", reasonCode: "required_target_unavailable" });
    expect(run({
      requirements: ownerRequirements,
      credentialOwnerPrincipalId: "different-owner",
      candidates: [candidate("owner_desktop", 3)],
    })).toMatchObject({ disposition: "queued", reasonCode: "required_target_unavailable" });
    const sharedRequirements = requirements(["owner_desktop"], {
      targetRequirements: {
        ...requirements(["owner_desktop"]).targetRequirements,
        credentialKind: "organization_brokered",
        fallback: { mode: "forbidden", orderedTargetClasses: [] },
      },
    });
    expect(run({ requirements: sharedRequirements, candidates: [candidate("owner_desktop", 3)] }))
      .toMatchObject({ disposition: "queued", reasonCode: "required_target_unavailable" });
  });

  it("respects required/ordered fallback and status, generation, health and capacity as read-only inputs", () => {
    const classes = ["managed_cloud", "organization_dedicated"] as const;
    const req = requirements([...classes]);
    const primary = candidate("managed_cloud", 1, { workerStatus: "draining" });
    const fallback = candidate("organization_dedicated", 2);
    const before = JSON.stringify([primary, fallback]);
    expect(run({ requirements: req, candidates: [primary, fallback] })).toMatchObject({
      disposition: "selected", targetClass: "organization_dedicated", fallbackDisposition: "ordered_explicit",
    });
    expect(JSON.stringify([primary, fallback])).toBe(before);

    const stale = candidate("managed_cloud", 1, {
      registry: { ...candidate("managed_cloud", 1).registry, lastSeenAt: new Date(NOW.getTime() - 60_000) },
    });
    expect(run({ candidates: [stale] })).toMatchObject({ disposition: "queued" });

    const revokedBase = candidate("managed_cloud", 1);
    const revoked = {
      ...revokedBase,
      registry: {
        ...revokedBase.registry,
        registeredProfile: { ...revokedBase.registry.registeredProfile, revokedAt: "2026-08-10T09:00:00.000Z" },
      },
    };
    expect(run({ candidates: [revoked] })).toMatchObject({ disposition: "queued" });
    expect(run({ candidates: [candidate("managed_cloud", 1, { currentOperations: 8 })] }))
      .toMatchObject({ disposition: "queued" });
    const wrongGenerationBase = candidate("managed_cloud", 1);
    expect(run({
      candidates: [{
        ...wrongGenerationBase,
        worker: { ...wrongGenerationBase.worker, deviceGeneration: 2 },
        workerProfileHash: sha256(JSON.stringify({ ...wrongGenerationBase.worker, deviceGeneration: 2 })),
      }],
    })).toMatchObject({ disposition: "queued" });

    const noCapacity = candidate("managed_cloud", 1, {
      currentCapacity: {
        batchSlots: 0, browserSessionSlots: 0, serviceSlots: 0,
        freeCpuMillis: 2_000, freeMemoryMiB: 4_096, freeDiskMiB: 8_192,
      },
    });
    const capacityBefore = JSON.stringify(noCapacity);
    expect(run({ candidates: [noCapacity] })).toMatchObject({ disposition: "queued" });
    expect(JSON.stringify(noCapacity)).toBe(capacityBefore);
  });

  it.each(["task_run", "commander_turn", "crew_run", "one_shot", "browser_request", "service_reconcile"])(
    "does not let source kind %s change the same authorized decision",
    (sourceKind) => expect(run({ sourceKind })).toMatchObject({ disposition: "selected", targetClass: "managed_cloud" }),
  );

  it("is byte-equivalent across candidate order for 20 fixed seeds", () => {
    const classes = ["managed_cloud", "organization_dedicated"] as const;
    const candidates = [
      candidate("organization_dedicated", 20), candidate("managed_cloud", 11),
      candidate("managed_cloud", 10), candidate("organization_dedicated", 21),
    ];
    const expected = JSON.stringify(run({ requirements: requirements([...classes]), candidates }));
    for (let seed = 1; seed <= 20; seed += 1) {
      expect(JSON.stringify(run({ requirements: requirements([...classes]), candidates: seededShuffle(candidates, seed) })),
        `seed ${seed}`).toBe(expected);
    }
  });
});

describe("JOB-009 candidateFits — guards with no counterpart in the frozen matcher", () => {
  // ★ WHY THIS BLOCK EXISTS. A mutation sweep of `candidateFits` (10 guards, run against ten
  // server suites with a LIVE positive control) killed only 3. Most survivors are genuine
  // EQUIVALENTS — `workerSatisfiesRequirements` re-checks target id, device generation and
  // revocation itself, so deleting the outer copy changes no outcome and no test can kill it.
  //
  // These three are different: the frozen matcher never sees `workerProfileHash`,
  // `credentialOwnerPrincipalId` or `ownerMembershipActive`. Deleting any of them changed
  // real behaviour and nothing failed. Each fixture below violates EXACTLY ONE rule, because
  // a fixture that trips two guards proves neither (the lesson from E1-F008 on the same day).

  it("★ rejects a worker snapshot that no longer hashes to its enrolled profile", () => {
    // The comment on this guard says a caller may replace ONLY `worker.capacity` after session
    // auth and every other member must still hash to the stored profile. `agentVersion` is
    // chosen deliberately: neither the generation/target-id guard nor the frozen matcher reads
    // it, so the hash check is the only thing that can refuse this candidate.
    const base = candidate("managed_cloud", 1);
    const tampered = {
      ...base,
      worker: { ...base.worker, agentVersion: "tampered-after-enrolment" },
      // workerProfileHash deliberately NOT recomputed — that is the tampering.
    };
    expect(run({ candidates: [tampered] }).disposition).not.toBe("selected");
  });

  it("★ rejects an owner credential on a placement that is not owner-bound", () => {
    // `credentialOwnerPrincipalId` is carried per JOB; the requirement here is
    // platform_brokered, so no owner may be attached. The frozen matcher never reads this
    // field, so this branch is the only thing standing between an owner-scoped credential and
    // a shared target.
    expect(run({ credentialOwnerPrincipalId: "job-009-owner" }).disposition).not.toBe("selected");
  });

  it("★ rejects an owner-scoped target whose owner membership is not active", () => {
    // Scope `owner` requires a live membership. Requirements stay platform_brokered with a null
    // required owner, so the owner-BOUND branch above is not entered and the matcher's owner
    // block is skipped — leaving membership as the single reason this can be refused.
    const inactive = candidate("owner_desktop", 30, { ownerMembershipActive: false });
    expect(run({
      requirements: requirements(["owner_desktop"]),
      candidates: [inactive],
    }).disposition).not.toBe("selected");
  });

  it("the same three candidates ARE selected once the single violation is removed", () => {
    // The positive control for this block. Without it, all three assertions above could be
    // passing because the fixtures are unplaceable for some unrelated reason.
    expect(run({ candidates: [candidate("managed_cloud", 1)] }).disposition).toBe("selected");
    expect(run({
      requirements: requirements(["owner_desktop"]),
      candidates: [candidate("owner_desktop", 30)],
    }).disposition).toBe("selected");
  });
});
