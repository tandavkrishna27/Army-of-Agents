import { z } from "zod";
import { canonicalizeJsonV1 } from "./canonical-json.js";
import { WORKER_EVENT_TYPES } from "./events.js";
import {
  organizationIdSchema,
  principalIdSchema,
  sha256DigestSchema,
  targetIdSchema,
  workerIdSchema,
} from "./ids.js";
import {
  PLACEMENT_MATRIX,
  credentialKindSchema,
  dataLocalitySchema,
  providerConstraintRefV1Schema,
  targetClassSchema,
  targetRequirementsV1Schema,
  targetScopeSchema,
  timestampV1Schema,
  trustClassSchema,
} from "./job.js";
import { resourceLimitsSchema } from "./policy.js";
import { workloadTypeSchema } from "./states.js";
import { negotiateProtocolVersion } from "./version.js";

// -----------------------------------------------------------------------------
// Registered target profiles (server authority) + dynamic worker hello (worker
// claims) + normalized provider-constraint profiles, plus intersection matching.
//
// The core security invariant: a worker CANNOT advertise its way into a higher
// trust / provider / credential / locality / capability class. Every ceiling is
// SERVER-owned in the RegisteredTargetProfileV1 / ProviderConstraintProfileV1;
// the WorkerHelloV1 carries only dynamic, provider-neutral claims. Requirement
// matching uses the INTERSECTION of the server profile with the worker report,
// so the worker report can only ever narrow, never widen. Unknown must-understand
// tokens fail closed; provider-native regions/templates never enter the wire.
//
// Runtime source imports only `zod` + relative modules; `TextEncoder` is a
// standard global (never `Buffer`/`node:*`).
// -----------------------------------------------------------------------------

// --- Capability vocabulary ---------------------------------------------------

/** The closed V1 provider-neutral worker-capability vocabulary. Unknown names
 * fail closed. Provider identity/region/template/credentials are NOT capabilities
 * — they live in the control-plane registry, never in this enum or on the wire. */
export const KNOWN_WORKER_CAPABILITIES = [
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
] as const;
export const workerCapabilitySchema = z.enum(KNOWN_WORKER_CAPABILITIES);
export type WorkerCapability = (typeof KNOWN_WORKER_CAPABILITIES)[number];

/** The frozen non-event operation/receipt emission names present in the FND-004
 * golden fixtures but outside the worker-event union (artifact/quarantine/lease
 * OPERATIONS owned by PRT-003/005/007, not worker→control-plane wire events). */
export const NON_EVENT_DISTRIBUTED_EMISSIONS = [
  "artifact_transfer_rejected",
  "quarantine_grant_issued",
  "quarantine_receipt_finalized",
  "replacement_lease_activated",
] as const;

/** The reviewed "known distributed-execution emission vocabulary" (E1-D002): the
 * worker-event type union ∪ the frozen non-event operation/receipt names above.
 * `golden-journeys.test.ts` asserts every fixture `steps[].emits` value is a
 * member — vocabulary/enum-membership parity, not a full-object parse. */
export const KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS: ReadonlySet<string> = new Set<string>([
  ...WORKER_EVENT_TYPES,
  ...NON_EVENT_DISTRIBUTED_EMISSIONS,
]);

// --- Worker capacity + platform ----------------------------------------------

const nonNegativeIntSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Provider-neutral free-capacity report. Slots and free resources are dynamic
 * worker claims; matching clamps them against the server-owned provider ceiling. */
export const workerCapacitySchema = z
  .object({
    batchSlots: nonNegativeIntSchema,
    browserSessionSlots: nonNegativeIntSchema,
    serviceSlots: nonNegativeIntSchema,
    freeCpuMillis: nonNegativeIntSchema,
    freeMemoryMiB: nonNegativeIntSchema,
    freeDiskMiB: nonNegativeIntSchema,
  })
  .strict();
export type WorkerCapacity = z.infer<typeof workerCapacitySchema>;

export const WORKER_OS = ["linux", "darwin", "windows"] as const;
export const WORKER_ARCH = ["x64", "arm64"] as const;

/** OS/arch + an opaque provider-neutral runtime label (never a provider region or
 * template ID). */
export const workerPlatformSchema = z
  .object({
    os: z.enum(WORKER_OS),
    arch: z.enum(WORKER_ARCH),
    runtime: z.string().min(1).max(100),
  })
  .strict();
export type WorkerPlatform = z.infer<typeof workerPlatformSchema>;

// --- Provider-constraint profile (server authority, versioned + digested) -----

/** A `{ profileId, version, digest }` reference to a stored provider-constraint
 * profile — byte-identical to the PRT-003 job-envelope provider ref (single
 * source of truth). JOB-009 resolves the referenced profile before leasing. */
export const providerConstraintProfileRefV1Schema = providerConstraintRefV1Schema;
export type ProviderConstraintProfileRefV1 = z.infer<typeof providerConstraintProfileRefV1Schema>;

/** The complete provider operation vocabulary. `checkpoint`/`restore`/`health`
 * are optional; the rest are core (every profile must support them). */
export const PROVIDER_OPERATIONS = [
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
] as const;
export const providerOperationSchema = z.enum(PROVIDER_OPERATIONS);
export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number];

/** Operations every profile MUST support. */
export const CORE_PROVIDER_OPERATIONS = [
  "create",
  "execute",
  "cancel",
  "kill",
  "destroy",
  "list",
  "inspect",
  "reconcile_cleanup",
] as const;
/** Operations a profile MAY support (paired/gated by the mode fields). */
export const OPTIONAL_PROVIDER_OPERATIONS = ["checkpoint", "restore", "health"] as const;

const providerProfileIdSchema = z.string().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const localityTagSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/);

export const CHECKPOINT_MODES = ["none", "snapshot", "application"] as const;
export const HEALTH_MODES = ["none", "poll", "stream"] as const;

/**
 * A server-owned, versioned, digest-verified ceiling on normalized runtime, idle,
 * resource, concurrency, operation, and locality budgets — expressed WITHOUT
 * provider-specific field names. `digest` is the lowercase SHA-256 of the RFC 8785
 * canonical JSON of the strict profile with `digest` omitted. Checkpoint/restore
 * appear together and require a non-`none` checkpoint mode; health requires a
 * non-`none` health mode; every core operation must be present.
 */
export const providerConstraintProfileV1Schema = z
  .object({
    profileId: providerProfileIdSchema,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    digest: sha256DigestSchema,
    maxContinuousRuntimeSeconds: z.number().int().min(1).max(604_800),
    maxIdleSeconds: z.number().int().min(1).max(86_400),
    resourceCeiling: resourceLimitsSchema,
    maxConcurrentOperations: z.number().int().min(1).max(10_000),
    supportedOperations: z.array(providerOperationSchema).min(CORE_PROVIDER_OPERATIONS.length).max(PROVIDER_OPERATIONS.length),
    localityTags: z.array(localityTagSchema).min(1).max(32),
    checkpointMode: z.enum(CHECKPOINT_MODES),
    healthMode: z.enum(HEALTH_MODES),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const ops = new Set(profile.supportedOperations);
    if (ops.size !== profile.supportedOperations.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supportedOperations"], message: "duplicate provider operation" });
    }
    for (const core of CORE_PROVIDER_OPERATIONS) {
      if (!ops.has(core)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supportedOperations"], message: `missing core provider operation ${core}` });
      }
    }
    const hasCheckpoint = ops.has("checkpoint");
    const hasRestore = ops.has("restore");
    if (hasCheckpoint !== hasRestore) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supportedOperations"], message: "checkpoint and restore must appear together" });
    }
    const checkpointCapable = hasCheckpoint && hasRestore;
    if (checkpointCapable !== (profile.checkpointMode !== "none")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checkpointMode"], message: "checkpoint/restore require a non-none checkpoint mode and vice versa" });
    }
    if (ops.has("health") !== (profile.healthMode !== "none")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["healthMode"], message: "health requires a non-none health mode and vice versa" });
    }
    if (new Set(profile.localityTags).size !== profile.localityTags.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["localityTags"], message: "duplicate locality tag" });
    }
  });
export type ProviderConstraintProfileV1 = z.infer<typeof providerConstraintProfileV1Schema>;

/**
 * The UTF-8 canonical bytes the provider-constraint `digest` is computed over: the
 * complete profile with ONLY `digest` removed, canonicalized via the single shared
 * `canonicalizeJsonV1` (byte-for-byte the frozen E0 authority). Throws on a value
 * with no RFC 8785 canonical form.
 */
export function canonicalProviderConstraintProfileDigestInputV1(profile: unknown): Uint8Array {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("provider-constraint profile must be a plain object");
  }
  const source = profile as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (key === "digest") continue;
    rest[key] = source[key];
  }
  return new TextEncoder().encode(canonicalizeJsonV1(rest));
}

// A phantom brand: the only way to obtain this type is a digest-verified profile.
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
export async function verifyAndBrandProviderConstraintProfileV1(
  profile: unknown,
  sha256Fn: (bytes: Uint8Array) => string | Promise<string>,
): Promise<VerifiedProviderConstraintProfileV1 | null> {
  const parsed = providerConstraintProfileV1Schema.safeParse(profile);
  if (!parsed.success) return null;
  let input: Uint8Array;
  try {
    input = canonicalProviderConstraintProfileDigestInputV1(parsed.data);
  } catch {
    return null;
  }
  let recomputed: string;
  try {
    recomputed = await sha256Fn(input);
  } catch {
    return null;
  }
  if (typeof recomputed !== "string" || recomputed !== String(parsed.data.digest)) return null;
  return parsed.data as unknown as VerifiedProviderConstraintProfileV1;
}

// --- Registered target profile (server authority) ----------------------------

const capabilityCeilingSchema = z.array(workerCapabilitySchema).max(KNOWN_WORKER_CAPABILITIES.length);

/**
 * A server-assigned logical target profile. Scope binds Organization/owner
 * strictly (`platform` → null org + null owner; `organization` → org + null
 * owner; `owner` → both). Its (targetClass, trustCeiling, credentialCeiling,
 * dataLocalityCeiling) must be an explicit member of the closed placement matrix,
 * and `scope` must equal the class's matrix scope. Provider identity/region/
 * template/credentials remain registry-side — only a provider ref appears here.
 */
export const registeredTargetProfileV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    targetId: targetIdSchema,
    targetClass: targetClassSchema,
    scope: targetScopeSchema,
    organizationId: organizationIdSchema.nullable(),
    ownerPrincipalId: principalIdSchema.nullable(),
    trustCeiling: trustClassSchema,
    credentialCeiling: credentialKindSchema,
    dataLocalityCeiling: dataLocalitySchema,
    providerConstraints: providerConstraintProfileRefV1Schema,
    capabilityCeiling: capabilityCeilingSchema,
    deviceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    revokedAt: timestampV1Schema.nullable(),
    policyHash: sha256DigestSchema,
  })
  .strict()
  .superRefine((profile, ctx) => {
    // Conditional Organization/owner binding by scope.
    if (profile.scope === "platform") {
      if (profile.organizationId !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["organizationId"], message: "platform scope requires a null organization" });
      }
      if (profile.ownerPrincipalId !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ownerPrincipalId"], message: "platform scope requires a null owner" });
      }
    } else if (profile.scope === "organization") {
      if (profile.organizationId === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["organizationId"], message: "organization scope requires an organization" });
      }
      if (profile.ownerPrincipalId !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ownerPrincipalId"], message: "organization scope requires a null owner" });
      }
    } else {
      // owner
      if (profile.organizationId === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["organizationId"], message: "owner scope requires an organization" });
      }
      if (profile.ownerPrincipalId === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ownerPrincipalId"], message: "owner scope requires an owner" });
      }
    }

    // The scope must match the class's matrix scope, and the ceilings must be an
    // explicit member of the closed placement matrix row for the class.
    const row = PLACEMENT_MATRIX[profile.targetClass];
    if (row.targetScope !== profile.scope) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: `${profile.targetClass} requires scope ${row.targetScope}` });
    }
    if (row.trustClass !== profile.trustCeiling) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trustCeiling"], message: `${profile.targetClass} requires trust ${row.trustClass}` });
    }
    if (!row.credentials.includes(profile.credentialCeiling)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["credentialCeiling"], message: `credential ${profile.credentialCeiling} is not permitted for ${profile.targetClass}` });
    }
    if (!row.localities.includes(profile.dataLocalityCeiling)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dataLocalityCeiling"], message: `locality ${profile.dataLocalityCeiling} is not permitted for ${profile.targetClass}` });
    }

    if (new Set(profile.capabilityCeiling).size !== profile.capabilityCeiling.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilityCeiling"], message: "duplicate capability in the ceiling" });
    }
  });
export type RegisteredTargetProfileV1 = z.infer<typeof registeredTargetProfileV1Schema>;

// --- Worker hello (dynamic claims) -------------------------------------------

const protocolRangeSchema = z
  .object({
    min: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    max: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((range, ctx) => {
    if (range.min > range.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["min"], message: "protocol range min must be <= max" });
    }
  });

/**
 * A worker's DYNAMIC self-report. It carries NO trust/credential/locality/provider
 * ceiling — those are server-owned in the registered target profile, so the worker
 * cannot self-assert a higher class (`.strict()` rejects any such field). Reported
 * capabilities and free capacity are only ever narrowed by matching.
 */
export const workerHelloV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    workerId: workerIdSchema,
    targetId: targetIdSchema,
    deviceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    agentVersion: z.string().min(1).max(100),
    supportedProtocol: protocolRangeSchema,
    platform: workerPlatformSchema,
    reportedCapabilities: z.array(workerCapabilitySchema).max(KNOWN_WORKER_CAPABILITIES.length),
    capacity: workerCapacitySchema,
    policyHash: sha256DigestSchema,
  })
  .strict()
  .superRefine((hello, ctx) => {
    if (new Set(hello.reportedCapabilities).size !== hello.reportedCapabilities.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reportedCapabilities"], message: "duplicate reported capability" });
    }
  });
export type WorkerHelloV1 = z.infer<typeof workerHelloV1Schema>;

// --- Job capability requirements ---------------------------------------------

/** The imported canonical PRT-003 target-requirements schema — NOT redefined. */
export { targetRequirementsV1Schema };
export type { TargetRequirementsV1 } from "./job.js";

/**
 * What a job asks of a worker/target: a protocol range, required provider-neutral
 * capabilities, the workload type, the PRT-003 target requirements, a policy hash,
 * and a must-understand set. An unknown must-understand token fails closed at match
 * time (it can never be a member of the closed capability vocabulary).
 */
export const jobCapabilityRequirementsSchema = z
  .object({
    protocol: protocolRangeSchema,
    capabilities: z.array(workerCapabilitySchema).max(KNOWN_WORKER_CAPABILITIES.length),
    workloadType: workloadTypeSchema,
    targetRequirements: targetRequirementsV1Schema,
    policyHash: sha256DigestSchema,
    mustUnderstand: z.array(z.string().min(1).max(200)).max(64),
  })
  .strict()
  .superRefine((requirements, ctx) => {
    if (new Set(requirements.capabilities).size !== requirements.capabilities.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "duplicate required capability" });
    }
    if (new Set(requirements.mustUnderstand).size !== requirements.mustUnderstand.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mustUnderstand"], message: "duplicate must-understand token" });
    }
  });
export type JobCapabilityRequirementsV1 = z.infer<typeof jobCapabilityRequirementsSchema>;

// --- Intersection matching ---------------------------------------------------

/** True iff `requested` is at or below `ceiling` in the class's ascending matrix
 * ordering. Credentials/localities are NOT globally ordinal — this containment is
 * only defined within a class's own ordered row, so a job can never request a
 * stronger credential/locality than the target committed to. */
function withinOrderedCeiling(row: readonly string[], requested: string, ceiling: string): boolean {
  const ceilingIndex = row.indexOf(ceiling);
  const requestedIndex = row.indexOf(requested);
  return ceilingIndex >= 0 && requestedIndex >= 0 && requestedIndex <= ceilingIndex;
}

function refsEqual(
  ref: ProviderConstraintProfileRefV1,
  verified: VerifiedProviderConstraintProfileV1,
): boolean {
  return (
    String(ref.profileId) === String(verified.profileId) &&
    ref.version === verified.version &&
    String(ref.digest) === String(verified.digest)
  );
}

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
export function workerSatisfiesRequirements(
  profile: RegisteredTargetProfileV1,
  verifiedProviderConstraints: VerifiedProviderConstraintProfileV1,
  worker: WorkerHelloV1,
  requirements: JobCapabilityRequirementsV1,
): boolean {
  // 1. Target identity / device generation / revocation.
  if (String(worker.targetId) !== String(profile.targetId)) return false;
  if (worker.deviceGeneration !== profile.deviceGeneration) return false;
  if (profile.revokedAt !== null) return false;

  // 2. The verified resolved profile must equal BOTH the registered target's ref
  //    and the job's requested ref (a mutated field with the old digest never
  //    produced a verified profile in the first place).
  if (!refsEqual(profile.providerConstraints, verifiedProviderConstraints)) return false;
  if (!refsEqual(requirements.targetRequirements.providerConstraints, verifiedProviderConstraints)) return false;

  // 3. Protocol range overlap.
  if (negotiateProtocolVersion(requirements.protocol, worker.supportedProtocol) === null) return false;

  // 4. Policy coherence: the job's policy must equal the target's committed policy
  //    AND the worker's synced policy.
  if (String(requirements.policyHash) !== String(profile.policyHash)) return false;
  if (String(worker.policyHash) !== String(profile.policyHash)) return false;

  // 5. Effective capabilities = server ceiling ∩ worker report (worker can only
  //    narrow). The workload's own capability + every required capability must be
  //    in the intersection; every must-understand token must be a KNOWN capability
  //    (unknown → fail closed) that is also in the intersection.
  const ceiling = new Set(profile.capabilityCeiling.map(String));
  const reported = new Set(worker.reportedCapabilities.map(String));
  const effective = new Set([...ceiling].filter((cap) => reported.has(cap)));

  const workloadCapability = `workload.${requirements.workloadType}`;
  if (!effective.has(workloadCapability)) return false;
  for (const required of requirements.capabilities) {
    if (!effective.has(String(required))) return false;
  }
  const knownCapabilities = new Set<string>(KNOWN_WORKER_CAPABILITIES);
  for (const token of requirements.mustUnderstand) {
    if (!knownCapabilities.has(token)) return false; // unknown must-understand fails closed
    if (!effective.has(token)) return false;
  }

  // 6. Placement intersection against the closed matrix (all server-owned; the
  //    worker report carries none of these fields).
  const targetReq = requirements.targetRequirements;
  if (!targetReq.allowedTargetClasses.includes(profile.targetClass)) return false;
  if (!targetReq.allowedTrustClasses.includes(profile.trustCeiling)) return false;
  const row = PLACEMENT_MATRIX[profile.targetClass];
  if (row.trustClass !== profile.trustCeiling) return false;
  if (!row.credentials.includes(targetReq.credentialKind)) return false;
  if (!row.localities.includes(targetReq.dataLocality)) return false;

  // 6a. The requested credential/locality must not exceed the target's committed
  //     ceiling (ordered within the class's matrix row).
  if (!withinOrderedCeiling(row.credentials, targetReq.credentialKind, profile.credentialCeiling)) return false;
  if (!withinOrderedCeiling(row.localities, targetReq.dataLocality, profile.dataLocalityCeiling)) return false;

  // 6b. Owner binding.
  if (targetReq.requiredOwnerPrincipalId !== null) {
    if (profile.ownerPrincipalId === null) return false;
    if (String(profile.ownerPrincipalId) !== String(targetReq.requiredOwnerPrincipalId)) return false;
  }

  // 7. Provider resource ceiling: a worker cannot advertise free resources beyond
  //    the server-imposed provider ceiling (the usable amount is the intersection).
  const ceilingResources = verifiedProviderConstraints.resourceCeiling;
  if (worker.capacity.freeCpuMillis > ceilingResources.cpuMillis) return false;
  if (worker.capacity.freeMemoryMiB > ceilingResources.memoryMiB) return false;
  if (worker.capacity.freeDiskMiB > ceilingResources.diskMiB) return false;

  // 8. A free slot for the workload type.
  const slots: Record<string, number> = {
    batch: worker.capacity.batchSlots,
    browser_session: worker.capacity.browserSessionSlots,
    service: worker.capacity.serviceSlots,
  };
  if ((slots[requirements.workloadType] ?? 0) < 1) return false;

  return true;
}

// Compile-time guarantee (checked by `tsc` on runtime source): a raw parsed
// ProviderConstraintProfileV1 is NOT a VerifiedProviderConstraintProfileV1, so the
// matcher's provider parameter structurally rejects an unverified/raw profile. If
// the brand were dropped, the ternary would become `false` and fail `Expect<true>`.
type Expect<T extends true> = T;
type _RawProfileIsNotVerified = Expect<
  ProviderConstraintProfileV1 extends VerifiedProviderConstraintProfileV1 ? false : true
>;
