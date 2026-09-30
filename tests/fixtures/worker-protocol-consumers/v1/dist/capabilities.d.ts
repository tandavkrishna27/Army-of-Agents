import { z } from "zod";
import { targetRequirementsV1Schema } from "./job.js";
/** The closed V1 provider-neutral worker-capability vocabulary. Unknown names
 * fail closed. Provider identity/region/template/credentials are NOT capabilities
 * — they live in the control-plane registry, never in this enum or on the wire. */
export declare const KNOWN_WORKER_CAPABILITIES: readonly ["workload.batch", "workload.browser_session", "workload.service", "provider.lifecycle_v1", "provider.cleanup_v1", "provider.checkpoint_v1", "provider.health_v1", "artifact.direct_upload", "secret.proxy", "sandbox.filesystem_isolated", "sandbox.process_isolated", "sandbox.filtered_egress"];
export declare const workerCapabilitySchema: z.ZodEnum<["workload.batch", "workload.browser_session", "workload.service", "provider.lifecycle_v1", "provider.cleanup_v1", "provider.checkpoint_v1", "provider.health_v1", "artifact.direct_upload", "secret.proxy", "sandbox.filesystem_isolated", "sandbox.process_isolated", "sandbox.filtered_egress"]>;
export type WorkerCapability = (typeof KNOWN_WORKER_CAPABILITIES)[number];
/** The frozen non-event operation/receipt emission names present in the FND-004
 * golden fixtures but outside the worker-event union (artifact/quarantine/lease
 * OPERATIONS owned by PRT-003/005/007, not worker→control-plane wire events). */
export declare const NON_EVENT_DISTRIBUTED_EMISSIONS: readonly ["artifact_transfer_rejected", "quarantine_grant_issued", "quarantine_receipt_finalized", "replacement_lease_activated"];
/** The reviewed "known distributed-execution emission vocabulary" (E1-D002): the
 * worker-event type union ∪ the frozen non-event operation/receipt names above.
 * `golden-journeys.test.ts` asserts every fixture `steps[].emits` value is a
 * member — vocabulary/enum-membership parity, not a full-object parse. */
export declare const KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS: ReadonlySet<string>;
/** Provider-neutral free-capacity report. Slots and free resources are dynamic
 * worker claims; matching clamps them against the server-owned provider ceiling. */
export declare const workerCapacitySchema: z.ZodObject<{
    batchSlots: z.ZodNumber;
    browserSessionSlots: z.ZodNumber;
    serviceSlots: z.ZodNumber;
    freeCpuMillis: z.ZodNumber;
    freeMemoryMiB: z.ZodNumber;
    freeDiskMiB: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    batchSlots: number;
    browserSessionSlots: number;
    serviceSlots: number;
    freeCpuMillis: number;
    freeMemoryMiB: number;
    freeDiskMiB: number;
}, {
    batchSlots: number;
    browserSessionSlots: number;
    serviceSlots: number;
    freeCpuMillis: number;
    freeMemoryMiB: number;
    freeDiskMiB: number;
}>;
export type WorkerCapacity = z.infer<typeof workerCapacitySchema>;
export declare const WORKER_OS: readonly ["linux", "darwin", "windows"];
export declare const WORKER_ARCH: readonly ["x64", "arm64"];
/** OS/arch + an opaque provider-neutral runtime label (never a provider region or
 * template ID). */
export declare const workerPlatformSchema: z.ZodObject<{
    os: z.ZodEnum<["linux", "darwin", "windows"]>;
    arch: z.ZodEnum<["x64", "arm64"]>;
    runtime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    os: "linux" | "darwin" | "windows";
    arch: "x64" | "arm64";
    runtime: string;
}, {
    os: "linux" | "darwin" | "windows";
    arch: "x64" | "arm64";
    runtime: string;
}>;
export type WorkerPlatform = z.infer<typeof workerPlatformSchema>;
/** A `{ profileId, version, digest }` reference to a stored provider-constraint
 * profile — byte-identical to the PRT-003 job-envelope provider ref (single
 * source of truth). JOB-009 resolves the referenced profile before leasing. */
export declare const providerConstraintProfileRefV1Schema: z.ZodObject<{
    profileId: z.ZodString;
    version: z.ZodNumber;
    digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
}, "strict", z.ZodTypeAny, {
    version: number;
    digest: string & z.BRAND<"Sha256Digest">;
    profileId: string;
}, {
    version: number;
    digest: string;
    profileId: string;
}>;
export type ProviderConstraintProfileRefV1 = z.infer<typeof providerConstraintProfileRefV1Schema>;
/** The complete provider operation vocabulary. `checkpoint`/`restore`/`health`
 * are optional; the rest are core (every profile must support them). */
export declare const PROVIDER_OPERATIONS: readonly ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup", "checkpoint", "restore", "health"];
export declare const providerOperationSchema: z.ZodEnum<["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup", "checkpoint", "restore", "health"]>;
export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number];
/** Operations every profile MUST support. */
export declare const CORE_PROVIDER_OPERATIONS: readonly ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup"];
/** Operations a profile MAY support (paired/gated by the mode fields). */
export declare const OPTIONAL_PROVIDER_OPERATIONS: readonly ["checkpoint", "restore", "health"];
export declare const CHECKPOINT_MODES: readonly ["none", "snapshot", "application"];
export declare const HEALTH_MODES: readonly ["none", "poll", "stream"];
/**
 * A server-owned, versioned, digest-verified ceiling on normalized runtime, idle,
 * resource, concurrency, operation, and locality budgets — expressed WITHOUT
 * provider-specific field names. `digest` is the lowercase SHA-256 of the RFC 8785
 * canonical JSON of the strict profile with `digest` omitted. Checkpoint/restore
 * appear together and require a non-`none` checkpoint mode; health requires a
 * non-`none` health mode; every core operation must be present.
 */
export declare const providerConstraintProfileV1Schema: z.ZodEffects<z.ZodObject<{
    profileId: z.ZodString;
    version: z.ZodNumber;
    digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
    maxContinuousRuntimeSeconds: z.ZodNumber;
    maxIdleSeconds: z.ZodNumber;
    resourceCeiling: z.ZodObject<{
        cpuMillis: z.ZodNumber;
        memoryMiB: z.ZodNumber;
        pids: z.ZodNumber;
        diskMiB: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    }, {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    }>;
    maxConcurrentOperations: z.ZodNumber;
    supportedOperations: z.ZodArray<z.ZodEnum<["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup", "checkpoint", "restore", "health"]>, "many">;
    localityTags: z.ZodArray<z.ZodString, "many">;
    checkpointMode: z.ZodEnum<["none", "snapshot", "application"]>;
    healthMode: z.ZodEnum<["none", "poll", "stream"]>;
}, "strict", z.ZodTypeAny, {
    version: number;
    digest: string & z.BRAND<"Sha256Digest">;
    profileId: string;
    maxContinuousRuntimeSeconds: number;
    maxIdleSeconds: number;
    resourceCeiling: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    maxConcurrentOperations: number;
    supportedOperations: ("checkpoint" | "cancel" | "create" | "execute" | "kill" | "destroy" | "list" | "inspect" | "reconcile_cleanup" | "restore" | "health")[];
    localityTags: string[];
    checkpointMode: "none" | "snapshot" | "application";
    healthMode: "none" | "stream" | "poll";
}, {
    version: number;
    digest: string;
    profileId: string;
    maxContinuousRuntimeSeconds: number;
    maxIdleSeconds: number;
    resourceCeiling: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    maxConcurrentOperations: number;
    supportedOperations: ("checkpoint" | "cancel" | "create" | "execute" | "kill" | "destroy" | "list" | "inspect" | "reconcile_cleanup" | "restore" | "health")[];
    localityTags: string[];
    checkpointMode: "none" | "snapshot" | "application";
    healthMode: "none" | "stream" | "poll";
}>, {
    version: number;
    digest: string & z.BRAND<"Sha256Digest">;
    profileId: string;
    maxContinuousRuntimeSeconds: number;
    maxIdleSeconds: number;
    resourceCeiling: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    maxConcurrentOperations: number;
    supportedOperations: ("checkpoint" | "cancel" | "create" | "execute" | "kill" | "destroy" | "list" | "inspect" | "reconcile_cleanup" | "restore" | "health")[];
    localityTags: string[];
    checkpointMode: "none" | "snapshot" | "application";
    healthMode: "none" | "stream" | "poll";
}, {
    version: number;
    digest: string;
    profileId: string;
    maxContinuousRuntimeSeconds: number;
    maxIdleSeconds: number;
    resourceCeiling: {
        cpuMillis: number;
        memoryMiB: number;
        pids: number;
        diskMiB: number;
    };
    maxConcurrentOperations: number;
    supportedOperations: ("checkpoint" | "cancel" | "create" | "execute" | "kill" | "destroy" | "list" | "inspect" | "reconcile_cleanup" | "restore" | "health")[];
    localityTags: string[];
    checkpointMode: "none" | "snapshot" | "application";
    healthMode: "none" | "stream" | "poll";
}>;
export type ProviderConstraintProfileV1 = z.infer<typeof providerConstraintProfileV1Schema>;
/**
 * The UTF-8 canonical bytes the provider-constraint `digest` is computed over: the
 * complete profile with ONLY `digest` removed, canonicalized via the single shared
 * `canonicalizeJsonV1` (byte-for-byte the frozen E0 authority). Throws on a value
 * with no RFC 8785 canonical form.
 */
export declare function canonicalProviderConstraintProfileDigestInputV1(profile: unknown): Uint8Array;
declare const verifiedProviderConstraintBrand: unique symbol;
/** A provider-constraint profile whose `digest` was recomputed and matched. The
 * brand is type-only (non-serializable): a raw parsed profile can NEVER be one. */
export type VerifiedProviderConstraintProfileV1 = ProviderConstraintProfileV1 & {
    readonly [verifiedProviderConstraintBrand]: true;
};
/**
 * Parse + verify a provider-constraint profile against its own `digest` using an
 * INJECTED SHA-256 (sync or async, lowercase hex). Returns the branded verified
 * type ONLY on a schema-valid profile whose recomputed digest matches; otherwise
 * `null`. A field mutation that reuses the old digest yields `null`. Never throws.
 */
export declare function verifyAndBrandProviderConstraintProfileV1(profile: unknown, sha256Fn: (bytes: Uint8Array) => string | Promise<string>): Promise<VerifiedProviderConstraintProfileV1 | null>;
/**
 * A server-assigned logical target profile. Scope binds Organization/owner
 * strictly (`platform` → null org + null owner; `organization` → org + null
 * owner; `owner` → both). Its (targetClass, trustCeiling, credentialCeiling,
 * dataLocalityCeiling) must be an explicit member of the closed placement matrix,
 * and `scope` must equal the class's matrix scope. Provider identity/region/
 * template/credentials remain registry-side — only a provider ref appears here.
 */
export declare const registeredTargetProfileV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    targetId: z.ZodBranded<z.ZodString, "TargetId">;
    targetClass: z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>;
    scope: z.ZodEnum<["platform", "organization", "owner"]>;
    organizationId: z.ZodNullable<z.ZodBranded<z.ZodString, "OrganizationId">>;
    ownerPrincipalId: z.ZodNullable<z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">>;
    trustCeiling: z.ZodEnum<["shared_isolated", "organization_isolated", "owner_local_trusted"]>;
    credentialCeiling: z.ZodEnum<["none", "platform_brokered", "organization_brokered", "owner_bound"]>;
    dataLocalityCeiling: z.ZodEnum<["transfer_allowed", "organization_target_only", "owner_device_only"]>;
    providerConstraints: z.ZodObject<{
        profileId: z.ZodString;
        version: z.ZodNumber;
        digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
    }, "strict", z.ZodTypeAny, {
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        profileId: string;
    }, {
        version: number;
        digest: string;
        profileId: string;
    }>;
    capabilityCeiling: z.ZodArray<z.ZodEnum<["workload.batch", "workload.browser_session", "workload.service", "provider.lifecycle_v1", "provider.cleanup_v1", "provider.checkpoint_v1", "provider.health_v1", "artifact.direct_upload", "secret.proxy", "sandbox.filesystem_isolated", "sandbox.process_isolated", "sandbox.filtered_egress"]>, "many">;
    deviceGeneration: z.ZodNumber;
    revokedAt: z.ZodNullable<z.ZodString>;
    policyHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
}, "strict", z.ZodTypeAny, {
    providerConstraints: {
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        profileId: string;
    };
    protocolVersion: 1;
    organizationId: (string & z.BRAND<"OrganizationId">) | null;
    policyHash: string & z.BRAND<"Sha256Digest">;
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    targetClass: "managed_cloud" | "organization_dedicated" | "owner_desktop";
    scope: "platform" | "organization" | "owner";
    ownerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
    trustCeiling: "shared_isolated" | "organization_isolated" | "owner_local_trusted";
    credentialCeiling: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
    dataLocalityCeiling: "transfer_allowed" | "organization_target_only" | "owner_device_only";
    capabilityCeiling: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    revokedAt: string | null;
}, {
    providerConstraints: {
        version: number;
        digest: string;
        profileId: string;
    };
    protocolVersion: 1;
    organizationId: string | null;
    policyHash: string;
    targetId: string;
    deviceGeneration: number;
    targetClass: "managed_cloud" | "organization_dedicated" | "owner_desktop";
    scope: "platform" | "organization" | "owner";
    ownerPrincipalId: string | null;
    trustCeiling: "shared_isolated" | "organization_isolated" | "owner_local_trusted";
    credentialCeiling: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
    dataLocalityCeiling: "transfer_allowed" | "organization_target_only" | "owner_device_only";
    capabilityCeiling: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    revokedAt: string | null;
}>, {
    providerConstraints: {
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        profileId: string;
    };
    protocolVersion: 1;
    organizationId: (string & z.BRAND<"OrganizationId">) | null;
    policyHash: string & z.BRAND<"Sha256Digest">;
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    targetClass: "managed_cloud" | "organization_dedicated" | "owner_desktop";
    scope: "platform" | "organization" | "owner";
    ownerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
    trustCeiling: "shared_isolated" | "organization_isolated" | "owner_local_trusted";
    credentialCeiling: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
    dataLocalityCeiling: "transfer_allowed" | "organization_target_only" | "owner_device_only";
    capabilityCeiling: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    revokedAt: string | null;
}, {
    providerConstraints: {
        version: number;
        digest: string;
        profileId: string;
    };
    protocolVersion: 1;
    organizationId: string | null;
    policyHash: string;
    targetId: string;
    deviceGeneration: number;
    targetClass: "managed_cloud" | "organization_dedicated" | "owner_desktop";
    scope: "platform" | "organization" | "owner";
    ownerPrincipalId: string | null;
    trustCeiling: "shared_isolated" | "organization_isolated" | "owner_local_trusted";
    credentialCeiling: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
    dataLocalityCeiling: "transfer_allowed" | "organization_target_only" | "owner_device_only";
    capabilityCeiling: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    revokedAt: string | null;
}>;
export type RegisteredTargetProfileV1 = z.infer<typeof registeredTargetProfileV1Schema>;
/**
 * A worker's DYNAMIC self-report. It carries NO trust/credential/locality/provider
 * ceiling — those are server-owned in the registered target profile, so the worker
 * cannot self-assert a higher class (`.strict()` rejects any such field). Reported
 * capabilities and free capacity are only ever narrowed by matching.
 */
export declare const workerHelloV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    targetId: z.ZodBranded<z.ZodString, "TargetId">;
    deviceGeneration: z.ZodNumber;
    agentVersion: z.ZodString;
    supportedProtocol: z.ZodEffects<z.ZodObject<{
        min: z.ZodNumber;
        max: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        min: number;
        max: number;
    }, {
        min: number;
        max: number;
    }>, {
        min: number;
        max: number;
    }, {
        min: number;
        max: number;
    }>;
    platform: z.ZodObject<{
        os: z.ZodEnum<["linux", "darwin", "windows"]>;
        arch: z.ZodEnum<["x64", "arm64"]>;
        runtime: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        os: "linux" | "darwin" | "windows";
        arch: "x64" | "arm64";
        runtime: string;
    }, {
        os: "linux" | "darwin" | "windows";
        arch: "x64" | "arm64";
        runtime: string;
    }>;
    reportedCapabilities: z.ZodArray<z.ZodEnum<["workload.batch", "workload.browser_session", "workload.service", "provider.lifecycle_v1", "provider.cleanup_v1", "provider.checkpoint_v1", "provider.health_v1", "artifact.direct_upload", "secret.proxy", "sandbox.filesystem_isolated", "sandbox.process_isolated", "sandbox.filtered_egress"]>, "many">;
    capacity: z.ZodObject<{
        batchSlots: z.ZodNumber;
        browserSessionSlots: z.ZodNumber;
        serviceSlots: z.ZodNumber;
        freeCpuMillis: z.ZodNumber;
        freeMemoryMiB: z.ZodNumber;
        freeDiskMiB: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    }, {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    }>;
    policyHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
}, "strict", z.ZodTypeAny, {
    platform: {
        os: "linux" | "darwin" | "windows";
        arch: "x64" | "arm64";
        runtime: string;
    };
    protocolVersion: 1;
    policyHash: string & z.BRAND<"Sha256Digest">;
    workerId: string & z.BRAND<"WorkerId">;
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    agentVersion: string;
    supportedProtocol: {
        min: number;
        max: number;
    };
    reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    capacity: {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    };
}, {
    platform: {
        os: "linux" | "darwin" | "windows";
        arch: "x64" | "arm64";
        runtime: string;
    };
    protocolVersion: 1;
    policyHash: string;
    workerId: string;
    targetId: string;
    deviceGeneration: number;
    agentVersion: string;
    supportedProtocol: {
        min: number;
        max: number;
    };
    reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    capacity: {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    };
}>, {
    platform: {
        os: "linux" | "darwin" | "windows";
        arch: "x64" | "arm64";
        runtime: string;
    };
    protocolVersion: 1;
    policyHash: string & z.BRAND<"Sha256Digest">;
    workerId: string & z.BRAND<"WorkerId">;
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    agentVersion: string;
    supportedProtocol: {
        min: number;
        max: number;
    };
    reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    capacity: {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    };
}, {
    platform: {
        os: "linux" | "darwin" | "windows";
        arch: "x64" | "arm64";
        runtime: string;
    };
    protocolVersion: 1;
    policyHash: string;
    workerId: string;
    targetId: string;
    deviceGeneration: number;
    agentVersion: string;
    supportedProtocol: {
        min: number;
        max: number;
    };
    reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    capacity: {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    };
}>;
export type WorkerHelloV1 = z.infer<typeof workerHelloV1Schema>;
/** The imported canonical PRT-003 target-requirements schema — NOT redefined. */
export { targetRequirementsV1Schema };
export type { TargetRequirementsV1 } from "./job.js";
/**
 * What a job asks of a worker/target: a protocol range, required provider-neutral
 * capabilities, the workload type, the PRT-003 target requirements, a policy hash,
 * and a must-understand set. An unknown must-understand token fails closed at match
 * time (it can never be a member of the closed capability vocabulary).
 */
export declare const jobCapabilityRequirementsSchema: z.ZodEffects<z.ZodObject<{
    protocol: z.ZodEffects<z.ZodObject<{
        min: z.ZodNumber;
        max: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        min: number;
        max: number;
    }, {
        min: number;
        max: number;
    }>, {
        min: number;
        max: number;
    }, {
        min: number;
        max: number;
    }>;
    capabilities: z.ZodArray<z.ZodEnum<["workload.batch", "workload.browser_session", "workload.service", "provider.lifecycle_v1", "provider.cleanup_v1", "provider.checkpoint_v1", "provider.health_v1", "artifact.direct_upload", "secret.proxy", "sandbox.filesystem_isolated", "sandbox.process_isolated", "sandbox.filtered_egress"]>, "many">;
    workloadType: z.ZodEnum<["batch", "browser_session", "service"]>;
    targetRequirements: z.ZodObject<{
        allowedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
        allowedTrustClasses: z.ZodArray<z.ZodEnum<["shared_isolated", "organization_isolated", "owner_local_trusted"]>, "many">;
        requiredOwnerPrincipalId: z.ZodNullable<z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">>;
        credentialKind: z.ZodEnum<["none", "platform_brokered", "organization_brokered", "owner_bound"]>;
        dataLocality: z.ZodEnum<["transfer_allowed", "organization_target_only", "owner_device_only"]>;
        fallback: z.ZodObject<{
            mode: z.ZodEnum<["forbidden", "ordered_explicit"]>;
            orderedTargetClasses: z.ZodArray<z.ZodEnum<["managed_cloud", "organization_dedicated", "owner_desktop"]>, "many">;
        }, "strict", z.ZodTypeAny, {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        }, {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        }>;
        providerConstraints: z.ZodObject<{
            profileId: z.ZodString;
            version: z.ZodNumber;
            digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
        }, "strict", z.ZodTypeAny, {
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            profileId: string;
        }, {
            version: number;
            digest: string;
            profileId: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
        requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
        credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
        dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
        fallback: {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        };
        providerConstraints: {
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            profileId: string;
        };
    }, {
        allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
        requiredOwnerPrincipalId: string | null;
        credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
        dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
        fallback: {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        };
        providerConstraints: {
            version: number;
            digest: string;
            profileId: string;
        };
    }>;
    policyHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
    mustUnderstand: z.ZodArray<z.ZodString, "many">;
}, "strict", z.ZodTypeAny, {
    targetRequirements: {
        allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
        requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
        credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
        dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
        fallback: {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        };
        providerConstraints: {
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            profileId: string;
        };
    };
    policyHash: string & z.BRAND<"Sha256Digest">;
    workloadType: "service" | "batch" | "browser_session";
    protocol: {
        min: number;
        max: number;
    };
    capabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    mustUnderstand: string[];
}, {
    targetRequirements: {
        allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
        requiredOwnerPrincipalId: string | null;
        credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
        dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
        fallback: {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        };
        providerConstraints: {
            version: number;
            digest: string;
            profileId: string;
        };
    };
    policyHash: string;
    workloadType: "service" | "batch" | "browser_session";
    protocol: {
        min: number;
        max: number;
    };
    capabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    mustUnderstand: string[];
}>, {
    targetRequirements: {
        allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
        requiredOwnerPrincipalId: (string & z.BRAND<"PrincipalId">) | null;
        credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
        dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
        fallback: {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        };
        providerConstraints: {
            version: number;
            digest: string & z.BRAND<"Sha256Digest">;
            profileId: string;
        };
    };
    policyHash: string & z.BRAND<"Sha256Digest">;
    workloadType: "service" | "batch" | "browser_session";
    protocol: {
        min: number;
        max: number;
    };
    capabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    mustUnderstand: string[];
}, {
    targetRequirements: {
        allowedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        allowedTrustClasses: ("shared_isolated" | "organization_isolated" | "owner_local_trusted")[];
        requiredOwnerPrincipalId: string | null;
        credentialKind: "none" | "platform_brokered" | "organization_brokered" | "owner_bound";
        dataLocality: "transfer_allowed" | "organization_target_only" | "owner_device_only";
        fallback: {
            mode: "forbidden" | "ordered_explicit";
            orderedTargetClasses: ("managed_cloud" | "organization_dedicated" | "owner_desktop")[];
        };
        providerConstraints: {
            version: number;
            digest: string;
            profileId: string;
        };
    };
    policyHash: string;
    workloadType: "service" | "batch" | "browser_session";
    protocol: {
        min: number;
        max: number;
    };
    capabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
    mustUnderstand: string[];
}>;
export type JobCapabilityRequirementsV1 = z.infer<typeof jobCapabilityRequirementsSchema>;
/**
 * Decide whether a worker on a registered target can run a job, using the
 * INTERSECTION of the SERVER-owned registered target + verified provider profile
 * with the worker's dynamic report. Accepts ONLY a `VerifiedProviderConstraintProfileV1`
 * (a raw parsed profile is a compile-time type error — see the `Expect<>` guard
 * below). Returns false on any: identity/generation/revocation mismatch, provider
 * ref/digest mismatch, protocol/policy mismatch, unknown-or-unavailable
 * must-understand token, missing capability, forbidden placement/credential/
 * locality/owner, over-advertised free resources, or absent workload slot.
 */
export declare function workerSatisfiesRequirements(profile: RegisteredTargetProfileV1, verifiedProviderConstraints: VerifiedProviderConstraintProfileV1, worker: WorkerHelloV1, requirements: JobCapabilityRequirementsV1): boolean;
