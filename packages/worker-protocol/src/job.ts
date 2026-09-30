import { z } from "zod";
import {
  artifactIdSchema,
  attemptNumberSchema,
  companyIdSchema,
  fenceTokenSchema,
  jobIdSchema,
  leaseIdSchema,
  organizationIdSchema,
  principalIdSchema,
  serviceIdSchema,
  serviceInstanceIdSchema,
  sha256DigestSchema,
  workerIdSchema,
} from "./ids.js";
import {
  addWireExtensionArrayIssues,
  wireExtensionsArraySchema,
  type WireExtension,
} from "./extensions.js";
import {
  offlinePolicySchema,
  networkPolicyRefSchema,
  resourceLimitsSchema,
  secretHandleRefSchema,
} from "./policy.js";
import { executionSourceV1Schema } from "./source.js";
import { addForbiddenWireKeyIssues } from "./wire-safety.js";

// -----------------------------------------------------------------------------
// V1 workload-specific job and lease wire envelopes.
//
// Security-critical identity/placement/target/secret-handle objects are strict.
// Safe additive data travels only through bounded namespaced extensions. Unknown
// placement enums, non-matrix placement combinations, and unknown critical
// extensions all fail closed.
// -----------------------------------------------------------------------------

// --- Small shared field schemas ----------------------------------------------

/** RFC3339 timestamp accepting a `Z` or numeric UTC offset. */
export const timestampV1Schema = z.string().datetime({ offset: true });

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const capabilitySchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/);

// --- Locked placement vocabulary ---------------------------------------------

export const TARGET_CLASSES = ["managed_cloud", "organization_dedicated", "owner_desktop"] as const;
export const targetClassSchema = z.enum(TARGET_CLASSES);
export type TargetClass = (typeof TARGET_CLASSES)[number];

export const TARGET_SCOPES = ["platform", "organization", "owner"] as const;
export const targetScopeSchema = z.enum(TARGET_SCOPES);
export type TargetScope = (typeof TARGET_SCOPES)[number];

export const TRUST_CLASSES = ["shared_isolated", "organization_isolated", "owner_local_trusted"] as const;
export const trustClassSchema = z.enum(TRUST_CLASSES);
export type TrustClass = (typeof TRUST_CLASSES)[number];

export const CREDENTIAL_KINDS = ["none", "platform_brokered", "organization_brokered", "owner_bound"] as const;
export const credentialKindSchema = z.enum(CREDENTIAL_KINDS);
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const DATA_LOCALITIES = ["transfer_allowed", "organization_target_only", "owner_device_only"] as const;
export const dataLocalitySchema = z.enum(DATA_LOCALITIES);
export type DataLocality = (typeof DATA_LOCALITIES)[number];

export const FALLBACK_MODES = ["forbidden", "ordered_explicit"] as const;
export const fallbackModeSchema = z.enum(FALLBACK_MODES);
export type FallbackMode = (typeof FALLBACK_MODES)[number];

/**
 * The closed V1 placement matrix. Compatibility is decided by explicit row
 * membership, NEVER ordinal string comparison. Every unlisted combination fails
 * closed.
 */
export interface PlacementMatrixRow {
  readonly targetScope: TargetScope;
  readonly trustClass: TrustClass;
  readonly credentials: readonly CredentialKind[];
  readonly localities: readonly DataLocality[];
}

export const PLACEMENT_MATRIX: Readonly<Record<TargetClass, PlacementMatrixRow>> = {
  managed_cloud: {
    targetScope: "platform",
    trustClass: "shared_isolated",
    credentials: ["none", "platform_brokered"],
    localities: ["transfer_allowed"],
  },
  organization_dedicated: {
    targetScope: "organization",
    trustClass: "organization_isolated",
    credentials: ["none", "platform_brokered", "organization_brokered"],
    localities: ["transfer_allowed", "organization_target_only"],
  },
  owner_desktop: {
    targetScope: "owner",
    trustClass: "owner_local_trusted",
    credentials: ["none", "platform_brokered", "owner_bound"],
    localities: ["transfer_allowed", "owner_device_only"],
  },
};

/** True iff `(targetClass, trustClass, credentialKind, dataLocality)` is an
 * explicit member of the placement matrix row for `targetClass`. */
export function isTargetPlacementAllowed(
  targetClass: TargetClass,
  trustClass: TrustClass,
  credentialKind: CredentialKind,
  dataLocality: DataLocality,
): boolean {
  const row = PLACEMENT_MATRIX[targetClass];
  return (
    row.trustClass === trustClass &&
    row.credentials.includes(credentialKind) &&
    row.localities.includes(dataLocality)
  );
}

// The bounded namespaced extension container — its element schema
// (`wireExtensionSchema`), array schema (`wireExtensionsArraySchema`), and the
// full refiner (`addWireExtensionArrayIssues`: count ≤16, unique namespace,
// unknown-critical fail-closed, value structural walk, and byte budgets) — is the
// single source of truth in `./extensions.js`, shared by job, lease, and event
// envelopes (E1-F005). Recursive plaintext-credential rejection stays at the
// envelope level via `addForbiddenWireKeyIssues` below.

function addDuplicateIssues(values: readonly string[], ctx: z.RefinementCtx, path: Array<string | number>, label: string): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `duplicate ${label}` });
  }
}

// --- Common security-critical schemas ----------------------------------------

export const providerConstraintRefV1Schema = z
  .object({ profileId: slugSchema, version: z.number().int().positive(), digest: sha256DigestSchema })
  .strict();
export type ProviderConstraintRefV1 = z.infer<typeof providerConstraintRefV1Schema>;

export const targetRequirementsV1Schema = z
  .object({
    allowedTargetClasses: z.array(targetClassSchema).min(1),
    allowedTrustClasses: z.array(trustClassSchema).min(1),
    requiredOwnerPrincipalId: principalIdSchema.nullable(),
    credentialKind: credentialKindSchema,
    dataLocality: dataLocalitySchema,
    fallback: z
      .object({ mode: fallbackModeSchema, orderedTargetClasses: z.array(targetClassSchema) })
      .strict(),
    providerConstraints: providerConstraintRefV1Schema,
  })
  .strict();
export type TargetRequirementsV1 = z.infer<typeof targetRequirementsV1Schema>;

export const placementV1Schema = z
  .object({
    policyId: slugSchema,
    version: z.number().int().positive(),
    digest: sha256DigestSchema,
    targetRequirements: targetRequirementsV1Schema,
  })
  .strict();
export type PlacementV1 = z.infer<typeof placementV1Schema>;

/** Validate a placement's target requirements against the closed matrix and the
 * owner/organization/fallback coherence rules. */
function addPlacementIssues(placement: PlacementV1, ctx: z.RefinementCtx, base: Array<string | number>): void {
  const requirements = placement.targetRequirements;
  const reqPath = [...base, "targetRequirements"];
  const { allowedTargetClasses, allowedTrustClasses, credentialKind, dataLocality, fallback } = requirements;

  addDuplicateIssues(allowedTargetClasses, ctx, [...reqPath, "allowedTargetClasses"], "target class");
  addDuplicateIssues(allowedTrustClasses, ctx, [...reqPath, "allowedTrustClasses"], "trust class");
  addDuplicateIssues(fallback.orderedTargetClasses, ctx, [...reqPath, "fallback", "orderedTargetClasses"], "fallback target class");

  // Every allowed target class must be satisfied by the offered trust set + the
  // single credential kind + the single locality — pure matrix membership.
  for (const targetClass of allowedTargetClasses) {
    const row = PLACEMENT_MATRIX[targetClass];
    if (!allowedTrustClasses.includes(row.trustClass)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "allowedTrustClasses"], message: `${targetClass} requires trust class ${row.trustClass}` });
    }
    if (!row.credentials.includes(credentialKind)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "credentialKind"], message: `credential ${credentialKind} is not permitted for ${targetClass}` });
    }
    if (!row.localities.includes(dataLocality)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "dataLocality"], message: `locality ${dataLocality} is not permitted for ${targetClass}` });
    }
  }

  // No trust class may be offered that no allowed target class actually requires.
  const requiredTrust = new Set(allowedTargetClasses.map((targetClass) => PLACEMENT_MATRIX[targetClass].trustClass));
  for (const trustClass of allowedTrustClasses) {
    if (!requiredTrust.has(trustClass)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "allowedTrustClasses"], message: `trust class ${trustClass} is not required by any allowed target class` });
    }
  }

  // Owner-bound credentials / owner-device-only locality: same non-null owner,
  // only owner_desktop, and no fallback to any other logical target.
  if (credentialKind === "owner_bound" || dataLocality === "owner_device_only") {
    if (requirements.requiredOwnerPrincipalId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "requiredOwnerPrincipalId"], message: "owner-bound placement requires a non-null owner" });
    }
    const onlyOwnerDesktop = allowedTargetClasses.length === 1 && allowedTargetClasses[0] === "owner_desktop";
    if (!onlyOwnerDesktop) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "allowedTargetClasses"], message: "owner-bound placement may target only owner_desktop" });
    }
  }

  // Organization-brokered credentials / organization-target-only locality: only
  // organization_dedicated.
  if (credentialKind === "organization_brokered" || dataLocality === "organization_target_only") {
    const onlyOrg = allowedTargetClasses.length === 1 && allowedTargetClasses[0] === "organization_dedicated";
    if (!onlyOrg) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "allowedTargetClasses"], message: "organization-brokered placement may target only organization_dedicated" });
    }
  }

  if (fallback.mode === "forbidden") {
    if (fallback.orderedTargetClasses.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "fallback", "orderedTargetClasses"], message: "forbidden fallback must have an empty order" });
    }
  } else {
    if (credentialKind !== "none" && credentialKind !== "platform_brokered") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "fallback"], message: "ordered fallback is allowed only for none or platform_brokered credentials" });
    }
    if (dataLocality !== "transfer_allowed") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "fallback"], message: "ordered fallback requires transfer_allowed locality" });
    }
    fallback.orderedTargetClasses.forEach((targetClass, index) => {
      if (!allowedTargetClasses.includes(targetClass)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "fallback", "orderedTargetClasses", index], message: "ordered fallback class is outside the allowed set" });
      } else if (!isTargetPlacementAllowed(targetClass, PLACEMENT_MATRIX[targetClass].trustClass, credentialKind, dataLocality) || !allowedTrustClasses.includes(PLACEMENT_MATRIX[targetClass].trustClass)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...reqPath, "fallback", "orderedTargetClasses", index], message: "ordered fallback class does not satisfy its matrix row" });
      }
    });
  }
}

export const adapterRefV1Schema = z
  .object({
    type: z.string().min(1).max(100),
    version: z.string().min(1).max(100),
    configArtifactId: artifactIdSchema.nullable(),
  })
  .strict();
export type AdapterRefV1 = z.infer<typeof adapterRefV1Schema>;

const workspaceBaseV1Schema = z
  .object({
    kind: z.enum(["git_commit", "content_manifest"]),
    algorithm: z.enum(["git_sha1", "git_sha256", "sha256"]),
    revision: z.string(),
  })
  .strict()
  .superRefine((base, ctx) => {
    const expected = base.algorithm === "git_sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
    if (!expected.test(base.revision)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: `revision must match ${base.algorithm}` });
    }
  });

export const workspaceV1Schema = z
  .object({
    manifestArtifactId: artifactIdSchema,
    base: workspaceBaseV1Schema,
    manifestHash: sha256DigestSchema,
    mode: z.enum(["read_only", "read_write"]),
  })
  .strict();
export type WorkspaceV1 = z.infer<typeof workspaceV1Schema>;

// `resourceLimitsV1Schema`, `networkPolicyRefV1Schema`, and `offlinePolicySchema`
// were moved to `./policy.js` (PRT-005 Step 6) so the resource/network/offline
// contracts have a single source of truth shared with the policy surface. This
// envelope imports them as `resourceLimitsSchema`, `networkPolicyRefSchema`, and
// `offlinePolicySchema`; `secretHandleIds` (opaque UUIDs) is replaced by
// `secretHandles` (`secretHandleRefSchema[]`), the richer handle reference.

// --- Workload payloads --------------------------------------------------------

export const batchWorkloadV1Schema = z
  .object({
    command: z.string().min(1).max(256),
    args: z.array(z.string().max(8192)).max(256),
    stdinArtifactId: artifactIdSchema.nullable(),
    maxRuntimeSeconds: z.number().int().min(1).max(86_400),
  })
  .strict();
export type BatchWorkloadV1 = z.infer<typeof batchWorkloadV1Schema>;

export const browserWorkloadV1Schema = z
  .object({
    engine: z.literal("chromium"),
    viewport: z.object({ width: z.number().int().min(1).max(16_384), height: z.number().int().min(1).max(16_384) }).strict(),
    locale: z.string().min(1).max(100),
    timezone: z.string().min(1).max(100),
    recordTrace: z.boolean(),
    recordVideo: z.boolean(),
    maxSessionSeconds: z.number().int().min(1).max(43_200),
  })
  .strict();
export type BrowserWorkloadV1 = z.infer<typeof browserWorkloadV1Schema>;

export const serviceWorkloadV1Schema = z
  .object({
    serviceId: serviceIdSchema,
    serviceInstanceId: serviceInstanceIdSchema,
    generation: z.number().int().positive(),
    command: z.string().min(1).max(256),
    args: z.array(z.string().max(8192)).max(256),
    checkpointArtifactId: artifactIdSchema.nullable(),
    gracefulStopSeconds: z.number().int().min(1).max(300),
  })
  .strict();
export type ServiceWorkloadV1 = z.infer<typeof serviceWorkloadV1Schema>;

// --- Job envelope -------------------------------------------------------------

const jobEnvelopeBaseSchema = z.object({
  protocolVersion: z.literal(1),
  jobId: jobIdSchema,
  attempt: attemptNumberSchema,
  organizationId: organizationIdSchema,
  companyId: companyIdSchema,
  source: executionSourceV1Schema,
  createdAt: timestampV1Schema,
  notBefore: timestampV1Schema.nullable(),
  deadline: timestampV1Schema,
  inputHash: sha256DigestSchema,
  policyHash: sha256DigestSchema,
  placement: placementV1Schema,
  adapter: adapterRefV1Schema,
  requiredCapabilities: z.array(capabilitySchema).max(128),
  workspace: workspaceV1Schema.nullable(),
  secretHandles: secretHandleRefSchema.array().max(64),
  resourceLimits: resourceLimitsSchema,
  networkPolicy: networkPolicyRefSchema,
  offlinePolicy: offlinePolicySchema,
  extensions: wireExtensionsArraySchema,
});

const batchJobEnvelopeSchema = jobEnvelopeBaseSchema
  .extend({ workloadType: z.literal("batch"), workload: batchWorkloadV1Schema })
  .strict();
const browserJobEnvelopeSchema = jobEnvelopeBaseSchema
  .extend({ workloadType: z.literal("browser_session"), workload: browserWorkloadV1Schema })
  .strict();
const serviceJobEnvelopeSchema = jobEnvelopeBaseSchema
  .extend({ workloadType: z.literal("service"), workload: serviceWorkloadV1Schema })
  .strict();

/** The strict V1 job envelope union, discriminated by `workloadType`, with all
 * cross-field security invariants applied. */
export const jobEnvelopeV1Schema = z
  .discriminatedUnion("workloadType", [batchJobEnvelopeSchema, browserJobEnvelopeSchema, serviceJobEnvelopeSchema])
  .superRefine((job, ctx) => {
    // Defense in depth: reject any plaintext-credential-bearing key anywhere,
    // including inside arbitrary extension values.
    addForbiddenWireKeyIssues(job, ctx);

    addWireExtensionArrayIssues(job.extensions, ctx, ["extensions"]);

    const created = Date.parse(job.createdAt);
    const deadline = Date.parse(job.deadline);
    if (!(deadline > created)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deadline"], message: "deadline must be strictly after createdAt" });
    }
    if (job.notBefore !== null) {
      const notBefore = Date.parse(job.notBefore);
      if (notBefore > deadline) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notBefore"], message: "notBefore must not be after deadline" });
      }
    }

    addDuplicateIssues(job.requiredCapabilities, ctx, ["requiredCapabilities"], "required capability");
    addDuplicateIssues(job.secretHandles.map((handle) => String(handle.handleId)), ctx, ["secretHandles"], "secret handle ID");

    addPlacementIssues(job.placement, ctx, ["placement"]);
  });
export type JobEnvelopeV1 = z.infer<typeof jobEnvelopeV1Schema>;

// -----------------------------------------------------------------------------
// Lease messages (strict domain payloads). PRT-007 nests these in distinct
// authenticated operation envelopes; the bare payloads are never sent alone.
// -----------------------------------------------------------------------------

const optionalExtensions = wireExtensionsArraySchema.optional();

function refineLeaseSafety(message: { extensions?: readonly WireExtension[] }, ctx: z.RefinementCtx): void {
  addForbiddenWireKeyIssues(message, ctx);
  if (message.extensions) addWireExtensionArrayIssues(message.extensions, ctx, ["extensions"]);
}

export const leaseOfferV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    workerId: workerIdSchema,
    leaseId: leaseIdSchema,
    fenceToken: fenceTokenSchema,
    ackDeadline: timestampV1Schema,
    expiresAt: timestampV1Schema,
    job: jobEnvelopeV1Schema,
    extensions: optionalExtensions,
  })
  .strict()
  .superRefine((offer, ctx) => {
    refineLeaseSafety(offer, ctx);
    if (!(Date.parse(offer.ackDeadline) < Date.parse(offer.expiresAt))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ackDeadline"], message: "ackDeadline must be before expiresAt" });
    }
  });
export type LeaseOfferV1 = z.infer<typeof leaseOfferV1Schema>;

export const leaseAckV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    workerId: workerIdSchema,
    jobId: jobIdSchema,
    attempt: attemptNumberSchema,
    leaseId: leaseIdSchema,
    fenceToken: fenceTokenSchema,
    ackedAt: timestampV1Schema,
    extensions: optionalExtensions,
  })
  .strict()
  .superRefine(refineLeaseSafety);
export type LeaseAckV1 = z.infer<typeof leaseAckV1Schema>;

export const leaseRenewRequestV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    workerId: workerIdSchema,
    jobId: jobIdSchema,
    attempt: attemptNumberSchema,
    leaseId: leaseIdSchema,
    fenceToken: fenceTokenSchema,
    observedAt: timestampV1Schema,
    extensions: optionalExtensions,
  })
  .strict()
  .superRefine(refineLeaseSafety);
export type LeaseRenewRequestV1 = z.infer<typeof leaseRenewRequestV1Schema>;

export const leaseRenewResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    workerId: workerIdSchema,
    jobId: jobIdSchema,
    attempt: attemptNumberSchema,
    leaseId: leaseIdSchema,
    fenceToken: fenceTokenSchema,
    expiresAt: timestampV1Schema,
    cancelRequested: z.boolean(),
    cancelReason: z.string().max(1000).nullable(),
    extensions: optionalExtensions,
  })
  .strict()
  .superRefine(refineLeaseSafety);
export type LeaseRenewResponseV1 = z.infer<typeof leaseRenewResponseV1Schema>;
