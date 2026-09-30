import {
  canonicalizeJsonV1,
  jobCapabilityRequirementsSchema,
  providerOperationSchema,
  resourceLimitsSchema,
  workerSatisfiesRequirements,
  type ExecutionSourceKind,
  type JobCapabilityRequirementsV1,
  type ProviderOperation,
  type ResourceLimits,
  type WorkerCapacity,
  type WorkerCapability,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";
import { createHash } from "node:crypto";
import type { NormalizedPlacementRegistryTarget } from "./execution-target-resolver.js";
import type { Db } from "@armyofagents/db";
import type {
  DeploymentMode,
  JobPlacementDecision,
  JobPlacementDisposition as PlacementDisposition,
  JobPlacementMode as PlacementMode,
  JobPlacementOwner as PlacementOwner,
} from "@armyofagents/shared";
import {
  readDistributedExecutionDeploymentFlag,
  resolveDistributedExecutionRollout,
} from "../config/distributed-execution.js";

export type { JobPlacementDecision, PlacementDisposition, PlacementMode, PlacementOwner };

export interface PlacementProviderDemand {
  maxRuntimeSeconds: number;
  maxIdleSeconds: number;
  resources: ResourceLimits;
  concurrentOperations: number;
  operations: ProviderOperation[];
  localityTags: string[];
}

interface PlacementRequestSnapshot {
  providerDemand: PlacementProviderDemand;
  credentialOwnerPrincipalId: string | null;
}

export interface JobPlacementCredentialBinding {
  credentialId: string | null;
  credentialKind: "company_api_key" | "personal_subscription" | null;
  executionTargetSlug: string | null;
  pinnedTargetId: string | null;
}

export interface PlacementTargetIdentityPolicy {
  disposition: "required" | "preferred" | "forbidden";
  targetId: string;
  targetSlug: string | null;
  unavailableDisposition: "queue" | "fail";
}

interface SubmittedPlacementRequirements {
  workloadType: "batch" | "browser_session" | "service";
  requiredCapabilities: string[];
}

interface SubmittedPlacementRequest {
  policyId: string;
  policyVersion: number;
  requestedTarget: string | null;
}

export type NormalizedSubmittedJobPlacementFacts =
  | {
      success: true;
      active: true;
      requirements: JobCapabilityRequirementsV1;
      providerDemand: PlacementProviderDemand;
      credentialOwnerId: string | null;
      targetIdentityPolicy: PlacementTargetIdentityPolicy | null;
      authorityFacts: Record<string, unknown>;
    }
  | {
      success: true;
      active: false;
      authorityFacts: Record<string, unknown>;
    }
  | { success: false; reason: "invalid_submitted_placement_facts" | "unmapped_execution_target" };

type ParseResult<T> = { success: true; data: T } | { success: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function parsePlacementProviderDemand(value: unknown): ParseResult<PlacementProviderDemand> {
  const keys = [
    "maxRuntimeSeconds", "maxIdleSeconds", "resources", "concurrentOperations", "operations", "localityTags",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys) ||
      !Number.isInteger(value.maxRuntimeSeconds) || Number(value.maxRuntimeSeconds) < 1 ||
      !Number.isInteger(value.maxIdleSeconds) || Number(value.maxIdleSeconds) < 1 ||
      !Number.isInteger(value.concurrentOperations) || Number(value.concurrentOperations) < 1) {
    return { success: false };
  }
  const resources = resourceLimitsSchema.safeParse(value.resources);
  if (!resources.success || !Array.isArray(value.operations) || value.operations.length === 0 ||
      value.operations.some((operation) => !providerOperationSchema.safeParse(operation).success) ||
      !Array.isArray(value.localityTags) || value.localityTags.length === 0 ||
      value.localityTags.some((tag) => typeof tag !== "string" || tag.length < 1 || tag.length > 64)) {
    return { success: false };
  }
  return {
    success: true,
    data: {
      maxRuntimeSeconds: Number(value.maxRuntimeSeconds),
      maxIdleSeconds: Number(value.maxIdleSeconds),
      resources: resources.data,
      concurrentOperations: Number(value.concurrentOperations),
      operations: value.operations as ProviderOperation[],
      localityTags: value.localityTags as string[],
    },
  };
}

export function parsePlacementRequestSnapshot(value: unknown): ParseResult<PlacementRequestSnapshot> {
  if (!isRecord(value) || !hasExactKeys(value, ["providerDemand", "credentialOwnerPrincipalId"])) {
    return { success: false };
  }
  const providerDemand = parsePlacementProviderDemand(value.providerDemand);
  const owner = value.credentialOwnerPrincipalId;
  if (!providerDemand.success || !(owner === null || (typeof owner === "string" && owner.length > 0))) {
    return { success: false };
  }
  return { success: true, data: { providerDemand: providerDemand.data, credentialOwnerPrincipalId: owner } };
}

function parseSubmittedRequirements(value: unknown): ParseResult<SubmittedPlacementRequirements> {
  if (!isRecord(value) || !hasExactKeys(value, ["workloadType", "requiredCapabilities"]) ||
      !["batch", "browser_session", "service"].includes(String(value.workloadType)) ||
      !Array.isArray(value.requiredCapabilities) ||
      value.requiredCapabilities.some((capability) => typeof capability !== "string" || capability.length < 1) ||
      new Set(value.requiredCapabilities).size !== value.requiredCapabilities.length) {
    return { success: false };
  }
  return {
    success: true,
    data: {
      workloadType: value.workloadType as SubmittedPlacementRequirements["workloadType"],
      requiredCapabilities: value.requiredCapabilities as string[],
    },
  };
}

function parseSubmittedPlacementRequest(value: unknown): ParseResult<SubmittedPlacementRequest> {
  if (!isRecord(value) || !hasExactKeys(value, ["policyId", "policyVersion", "requestedTarget"]) ||
      typeof value.policyId !== "string" || value.policyId.length < 1 ||
      !Number.isInteger(value.policyVersion) || Number(value.policyVersion) < 1 ||
      !(value.requestedTarget === null ||
        (typeof value.requestedTarget === "string" && value.requestedTarget.length > 0))) {
    return { success: false };
  }
  return {
    success: true,
    data: {
      policyId: value.policyId,
      policyVersion: Number(value.policyVersion),
      requestedTarget: value.requestedTarget as string | null,
    },
  };
}

function submittedCapabilities(input: SubmittedPlacementRequirements): WorkerCapability[] | null {
  const workloadCapability = `workload.${input.workloadType}` as WorkerCapability;
  const translated = input.requiredCapabilities.map((capability): WorkerCapability | null => {
    if (capability === "browser.chromium" && input.workloadType === "browser_session") {
      return "workload.browser_session";
    }
    if ([
      "workload.batch", "workload.browser_session", "workload.service", "provider.lifecycle_v1",
      "provider.cleanup_v1", "provider.checkpoint_v1", "provider.health_v1", "artifact.direct_upload",
      "secret.proxy", "sandbox.filesystem_isolated", "sandbox.process_isolated", "sandbox.filtered_egress",
    ].includes(capability)) return capability as WorkerCapability;
    return null;
  });
  if (translated.some((capability) => capability === null)) return null;
  return [...new Set([workloadCapability, ...translated as WorkerCapability[]])];
}

function boundedDemand(target: NormalizedPlacementRegistryTarget): PlacementProviderDemand {
  const provider = target.providerConstraintProfile;
  const supported = new Set(provider.supportedOperations);
  const operations = (["create", "execute"] as ProviderOperation[]).filter((operation) => supported.has(operation));
  return {
    maxRuntimeSeconds: Math.min(600, provider.maxContinuousRuntimeSeconds),
    maxIdleSeconds: Math.min(60, provider.maxIdleSeconds),
    resources: {
      cpuMillis: Math.min(1_000, provider.resourceCeiling.cpuMillis),
      memoryMiB: Math.min(1_024, provider.resourceCeiling.memoryMiB),
      pids: Math.min(128, provider.resourceCeiling.pids),
      diskMiB: Math.min(1_024, provider.resourceCeiling.diskMiB),
    },
    concurrentOperations: Math.min(1, provider.maxConcurrentOperations),
    operations,
    localityTags: provider.localityTags.slice(0, 1),
  };
}

/**
 * Convert JOB-001's frozen persisted source contract into E1 placement facts.
 * Provider, target, credential, and rollout authority are supplied only by the
 * trusted server composition root; none is accepted from the submit command.
 */
export function normalizeSubmittedJobPlacementFacts(input: {
  sourceKind: ExecutionSourceKind;
  inputHash: string;
  policyHash: string;
  requirements: unknown;
  placementRequest: unknown;
  rollout: { enabled: boolean; mode: PlacementMode; reason: string };
  credentialBinding: JobPlacementCredentialBinding;
  resolvedTarget: NormalizedPlacementRegistryTarget | null;
}): NormalizedSubmittedJobPlacementFacts {
  const submitted = parseSubmittedRequirements(input.requirements);
  const request = parseSubmittedPlacementRequest(input.placementRequest);
  if (!submitted.success || !request.success || !SHA256.test(input.inputHash) || !SHA256.test(input.policyHash)) {
    return { success: false, reason: "invalid_submitted_placement_facts" };
  }

  if (!input.rollout.enabled) {
    return {
      success: true,
      active: false,
      authorityFacts: {
        sourceKind: input.sourceKind,
        inputHash: input.inputHash,
        policyHash: input.policyHash,
        submittedRequirements: submitted.data,
        submittedPlacementRequest: request.data,
        rollout: input.rollout,
        credentialBinding: input.credentialBinding,
        resolvedTarget: null,
      },
    };
  }

  if (!input.resolvedTarget) {
    return { success: false, reason: "unmapped_execution_target" };
  }
  const target = input.resolvedTarget;
  if (input.credentialBinding.credentialKind === "personal_subscription" &&
      (!input.credentialBinding.credentialId || !input.credentialBinding.executionTargetSlug ||
       target.targetSlug !== input.credentialBinding.executionTargetSlug ||
       target.targetClass !== "owner_desktop" || !target.registeredProfile.ownerPrincipalId)) {
    return { success: false, reason: "unmapped_execution_target" };
  }
  const capabilities = submittedCapabilities(submitted.data);
  const providerDemand = boundedDemand(target);
  if (!capabilities || providerDemand.operations.length === 0 || providerDemand.localityTags.length === 0 ||
      providerDemand.maxRuntimeSeconds < 1 || providerDemand.maxIdleSeconds < 1 ||
      providerDemand.resources.cpuMillis < 1 || providerDemand.resources.memoryMiB < 1 ||
      providerDemand.resources.pids < 1 || providerDemand.resources.diskMiB < 1) {
    return { success: false, reason: "unmapped_execution_target" };
  }

  const profile = target.registeredProfile;
  const requestedIdentity = request.data.requestedTarget ?? input.credentialBinding.pinnedTargetId;
  const targetIdentityPolicy: PlacementTargetIdentityPolicy | null = requestedIdentity
    ? {
        disposition: "required",
        targetId: requestedIdentity,
        targetSlug: input.credentialBinding.executionTargetSlug,
        unavailableDisposition: request.data.requestedTarget ? "fail" : "queue",
      }
    : null;
  const credentialOwnerId = input.credentialBinding.credentialKind === "personal_subscription"
    ? profile.ownerPrincipalId
    : null;
  const requirements: JobCapabilityRequirementsV1 = {
    protocol: { min: 1, max: 1 },
    capabilities,
    workloadType: submitted.data.workloadType,
    targetRequirements: {
      allowedTargetClasses: [profile.targetClass],
      allowedTrustClasses: [profile.trustCeiling],
      requiredOwnerPrincipalId: profile.targetClass === "owner_desktop" ? profile.ownerPrincipalId : null,
      credentialKind: profile.credentialCeiling,
      dataLocality: profile.dataLocalityCeiling,
      fallback: { mode: "forbidden", orderedTargetClasses: [] },
      providerConstraints: profile.providerConstraints,
    },
    policyHash: profile.policyHash,
    mustUnderstand: [],
  };
  if (!jobCapabilityRequirementsSchema.safeParse(requirements).success) {
    return { success: false, reason: "unmapped_execution_target" };
  }
  return {
    success: true,
    active: true,
    requirements,
    providerDemand,
    credentialOwnerId,
    targetIdentityPolicy,
    authorityFacts: {
      sourceKind: input.sourceKind,
      inputHash: input.inputHash,
      policyHash: input.policyHash,
      submittedRequirements: submitted.data,
      submittedPlacementRequest: request.data,
      rollout: input.rollout,
      credentialBinding: input.credentialBinding,
      resolvedTarget: {
        targetId: target.targetId,
        targetSlug: target.targetSlug,
        targetClass: target.targetClass,
        targetScope: target.targetScope,
        targetGeneration: target.targetGeneration,
        profileHash: target.profileHash,
        providerConstraintHash: target.providerConstraintHash,
      },
      normalizedRequirements: requirements,
      providerDemand,
      credentialOwnerId,
      targetIdentityPolicy,
    },
  };
}

export function canonicalPlacementAuthorityDigest(authorityFacts: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeJsonV1(authorityFacts)).digest("hex");
}

export interface PlacementCandidate {
  registry: NormalizedPlacementRegistryTarget;
  worker: WorkerHelloV1;
  workerProfileHash: string;
  currentCapacity?: WorkerCapacity;
  workerStatus: string;
  ownerMembershipActive: boolean;
  currentOperations: number;
}

export interface DecideJobPlacementInput {
  sourceKind: ExecutionSourceKind;
  rollout: {
    enabled: boolean;
    mode: PlacementMode;
    reason: string;
  };
  requirements: JobCapabilityRequirementsV1;
  providerDemand: PlacementProviderDemand;
  credentialOwnerPrincipalId: string | null;
  now: Date;
  maxHeartbeatAgeMs: number;
  inputDigest: string;
  policyDigest: string;
  candidates: PlacementCandidate[];
  resolvedTargetId?: string | null;
  targetIdentityPolicy?: PlacementTargetIdentityPolicy | null;
}

export interface PlaceJobAttemptInput {
  appDb: Db;
  operatorDb: Db;
  organizationId: string;
  companyId: string;
  jobId: string;
  attemptId: string;
  now: Date;
  maxHeartbeatAgeMs: number;
  /** @deprecated ignored: rollout authority is resolved by the server service. */
  rollout?: DecideJobPlacementInput["rollout"];
  /**
   * CLI-007 (E7-F001) — an out-of-band Company ownership authority for the DAT-008 mint
   * only (the canary path). It is NOT part of the credential binding, so it never enters
   * `authorityFacts` / the placement digest and never affects target routing; it is
   * consumed solely at the mint call, after the decision is persisted. Omitted for every
   * non-canary run → the mint sources `credentialKind` from the binding, unchanged.
   */
  mintCredentialAuthority?: JobPlacementCredentialBinding["credentialKind"];
  /**
   * CLI-008 Unit C — whether this run's distributed TOOL SURFACE is authorized
   * (the AOA_DISTRIBUTED_TOOL_SURFACE_ENABLED gate, computed once at dispatch). It
   * gates the SECOND placement mint — the run_jwt (AOA_API_KEY) bearer — only.
   * Omitted/false (the default until Unit C S4 wires the flag) mints no run_jwt
   * handle, so the tool-surface slice is inert. Independent of the credential
   * binding + the placement digest — read solely at the mint call, like
   * `mintCredentialAuthority`.
   */
  toolSurfaceAuthorized?: boolean;
}

export interface JobPlacementServiceInput extends Omit<PlaceJobAttemptInput, "appDb" | "operatorDb" | "rollout"> {}

export interface JobPlacementOrganizationPolicy {
  enabled: boolean;
  mode: "active" | "shadow";
}

export interface JobPlacementServiceDependencies {
  appDb: Db;
  operatorDb: Db;
  deploymentMode: DeploymentMode;
  deploymentEnabled: boolean;
  resolveOrganizationPolicy(input: { organizationId: string }): Promise<JobPlacementOrganizationPolicy> | JobPlacementOrganizationPolicy;
  resolveWorkloadPolicy(input: {
    organizationId: string;
    companyId: string;
    sourceKind: ExecutionSourceKind;
    workloadType: string;
  }): Promise<boolean> | boolean;
  resolveCredentialBinding(input: {
    organizationId: string;
    companyId: string;
    jobId: string;
    sourceKind: ExecutionSourceKind;
  }): Promise<JobPlacementCredentialBinding> | JobPlacementCredentialBinding;
}

export interface ResolvedJobPlacementAuthority {
  rollout: DecideJobPlacementInput["rollout"];
  credentialBinding: JobPlacementCredentialBinding;
}

export type JobPlacementAuthorityResolver = (input: {
  organizationId: string;
  companyId: string;
  jobId: string;
  sourceKind: ExecutionSourceKind;
  workloadType: string;
}) => Promise<ResolvedJobPlacementAuthority>;

/** Lazy boundary keeps importing this pure policy module free of DB effects. */
export async function placeJobAttempt(input: PlaceJobAttemptInput): Promise<JobPlacementDecision> {
  const service = createJobPlacementService({
    appDb: input.appDb,
    operatorDb: input.operatorDb,
    deploymentMode: "local_trusted",
    deploymentEnabled: readDistributedExecutionDeploymentFlag(process.env),
    resolveOrganizationPolicy: () => ({ enabled: false, mode: "active" }),
    resolveWorkloadPolicy: () => false,
    resolveCredentialBinding: () => ({
      credentialId: null,
      credentialKind: null,
      executionTargetSlug: null,
      pinnedTargetId: null,
    }),
  });
  return service.place(input);
}

/**
 * Trusted composition boundary. HTTP/request callers receive only `place`; all
 * rollout and credential authority is captured once by server-owned resolvers.
 */
export function createJobPlacementService(deps: JobPlacementServiceDependencies) {
  const resolveAuthority: JobPlacementAuthorityResolver = async (input) => {
    const organization = await deps.resolveOrganizationPolicy({ organizationId: input.organizationId });
    const workloadEnabled = await deps.resolveWorkloadPolicy(input);
    const rolloutDecision = resolveDistributedExecutionRollout({
      deploymentMode: deps.deploymentMode,
      deploymentEnabled: deps.deploymentEnabled,
      organizationEnabled: organization.enabled,
      workloadEnabled,
    });
    const rollout: DecideJobPlacementInput["rollout"] = rolloutDecision.enabled
      ? { enabled: true, mode: organization.mode, reason: "enabled" }
      : { enabled: false, mode: "legacy", reason: rolloutDecision.reason };
    const credentialBinding = await deps.resolveCredentialBinding({
      organizationId: input.organizationId,
      companyId: input.companyId,
      jobId: input.jobId,
      sourceKind: input.sourceKind,
    });
    return { rollout, credentialBinding };
  };
  return {
    async place(input: JobPlacementServiceInput): Promise<JobPlacementDecision> {
      const { placeJobAttemptTransaction } = await import("./job-placement-transaction.js");
      return placeJobAttemptTransaction({ ...input, appDb: deps.appDb, operatorDb: deps.operatorDb }, resolveAuthority);
    },
  };
}

const SHA256 = /^[0-9a-f]{64}$/;

function terminalDecision(input: DecideJobPlacementInput, values: {
  disposition: "legacy" | "queued" | "failed";
  owner: "legacy" | null;
  reasonCode: string;
  mode: PlacementMode;
  fallbackDisposition: "not_applicable" | "forbidden" | "ordered_explicit";
}): JobPlacementDecision {
  return {
    ...values,
    targetId: null,
    targetClass: null,
    targetScope: null,
    targetGeneration: null,
    profileHash: null,
    providerConstraintHash: null,
    leaseEligible: false,
    inputDigest: input.inputDigest,
    policyDigest: input.policyDigest,
  };
}

function providerDemandFits(
  candidate: PlacementCandidate,
  worker: WorkerHelloV1,
  demand: PlacementProviderDemand,
): boolean {
  const provider = candidate.registry.providerConstraintProfile;
  if (!Number.isInteger(demand.maxRuntimeSeconds) || demand.maxRuntimeSeconds < 1 ||
      demand.maxRuntimeSeconds > provider.maxContinuousRuntimeSeconds) return false;
  if (!Number.isInteger(demand.maxIdleSeconds) || demand.maxIdleSeconds < 1 ||
      demand.maxIdleSeconds > provider.maxIdleSeconds) return false;
  if (!Number.isInteger(demand.concurrentOperations) || demand.concurrentOperations < 1) return false;
  if (candidate.currentOperations < 0 ||
      candidate.currentOperations + demand.concurrentOperations > provider.maxConcurrentOperations) return false;

  const ceiling = provider.resourceCeiling;
  if (demand.resources.cpuMillis > ceiling.cpuMillis ||
      demand.resources.memoryMiB > ceiling.memoryMiB ||
      demand.resources.pids > ceiling.pids ||
      demand.resources.diskMiB > ceiling.diskMiB) return false;
  const free = worker.capacity;
  if (demand.resources.cpuMillis > free.freeCpuMillis ||
      demand.resources.memoryMiB > free.freeMemoryMiB ||
      demand.resources.diskMiB > free.freeDiskMiB) return false;

  const operations = new Set(provider.supportedOperations);
  if (new Set(demand.operations).size !== demand.operations.length ||
      demand.operations.some((operation) => !operations.has(operation))) return false;
  const locality = new Set(provider.localityTags);
  if (new Set(demand.localityTags).size !== demand.localityTags.length ||
      demand.localityTags.some((tag) => !locality.has(tag))) return false;
  return true;
}

function candidateFits(input: DecideJobPlacementInput, candidate: PlacementCandidate): boolean {
  const { registry, worker } = candidate;
  if (registry.status !== "active" || !["active", "enrolled"].includes(candidate.workerStatus)) return false;
  if (!(registry.lastSeenAt instanceof Date) ||
      input.now.getTime() - registry.lastSeenAt.getTime() > input.maxHeartbeatAgeMs ||
      registry.lastSeenAt.getTime() > input.now.getTime() + 1_000) return false;
  if (worker.deviceGeneration !== registry.targetGeneration || String(worker.targetId) !== registry.targetId) return false;
  if (registry.registeredProfile.revokedAt !== null) return false;
  if (registry.registeredProfile.deviceGeneration !== registry.targetGeneration) return false;
  if (String(registry.registeredProfile.providerConstraints.digest) !== registry.providerConstraintHash) return false;

  // The proof-bound enrolled snapshot is immutable. A caller may supply current
  // capacity only by replacing worker.capacity after session auth; every other
  // member must still hash to the stored profile. Capacity is therefore checked
  // as eligibility only and is never mutated or reserved here.
  if (!SHA256.test(candidate.workerProfileHash) ||
      createHash("sha256").update(JSON.stringify(worker)).digest("hex") !== candidate.workerProfileHash) return false;
  const effectiveWorker = candidate.currentCapacity
    ? { ...worker, capacity: candidate.currentCapacity }
    : worker;

  const targetRequirements = input.requirements.targetRequirements;
  if (targetRequirements.credentialKind === "owner_bound") {
    if (!targetRequirements.requiredOwnerPrincipalId ||
        input.credentialOwnerPrincipalId !== String(targetRequirements.requiredOwnerPrincipalId) ||
        !candidate.ownerMembershipActive) return false;
  } else if (input.credentialOwnerPrincipalId !== null) {
    return false;
  }
  if (registry.targetScope === "owner" && !candidate.ownerMembershipActive) return false;

  return workerSatisfiesRequirements(
    registry.registeredProfile,
    registry.providerConstraintProfile,
    effectiveWorker,
    input.requirements,
  ) && providerDemandFits(candidate, effectiveWorker, input.providerDemand);
}

/**
 * Pure JOB-009 placement authority. This function has no database, lease,
 * capacity-reservation, provider, worker-contact, logging, or clock side effect.
 * All volatile facts enter as bounded snapshots and stable tie-breaks make the
 * same input byte-equivalent regardless of candidate enumeration order.
 */
export function decideJobPlacement(input: DecideJobPlacementInput): JobPlacementDecision {
  if (!input.rollout.enabled) {
    return terminalDecision(input, {
      disposition: "legacy",
      owner: "legacy",
      reasonCode: input.rollout.reason,
      mode: "legacy",
      fallbackDisposition: "not_applicable",
    });
  }

  const parsedRequirements = jobCapabilityRequirementsSchema.safeParse(input.requirements);
  const parsedDemand = parsePlacementProviderDemand(input.providerDemand);
  if (!parsedRequirements.success || !parsedDemand.success ||
      !SHA256.test(input.inputDigest) || !SHA256.test(input.policyDigest) ||
      !(input.now instanceof Date) || !Number.isFinite(input.now.getTime()) ||
      !Number.isInteger(input.maxHeartbeatAgeMs) || input.maxHeartbeatAgeMs < 0 ||
      !["active", "shadow"].includes(input.rollout.mode)) {
    return terminalDecision(input, {
      disposition: "failed",
      owner: null,
      reasonCode: "invalid_placement_input",
      mode: input.rollout.mode === "shadow" ? "shadow" : "active",
      fallbackDisposition: "forbidden",
    });
  }

  const fallback = parsedRequirements.data.targetRequirements.fallback;
  const allowed = parsedRequirements.data.targetRequirements.allowedTargetClasses;
  const order = fallback.mode === "ordered_explicit" && fallback.orderedTargetClasses.length > 0
    ? fallback.orderedTargetClasses
    : [allowed[0]!];
  const rank = new Map(order.map((targetClass, index) => [targetClass, index]));
  const identityPolicy = input.targetIdentityPolicy ?? null;
  if (identityPolicy?.disposition === "forbidden") {
    return terminalDecision(input, {
      disposition: "failed",
      owner: null,
      reasonCode: "target_identity_forbidden",
      mode: input.rollout.mode,
      fallbackDisposition: "forbidden",
    });
  }
  const identityTargetId = identityPolicy?.disposition === "required"
    ? identityPolicy.targetId
    : identityPolicy ? null : input.resolvedTargetId;
  const preferredFallbackForbidden = identityPolicy?.disposition === "preferred" && fallback.mode === "forbidden";
  const eligible = input.candidates
    .filter((candidate) => !identityTargetId || candidate.registry.targetId === identityTargetId)
    .filter((candidate) => !preferredFallbackForbidden ||
      candidate.registry.targetId === identityPolicy.targetId)
    .filter((candidate) => rank.has(candidate.registry.targetClass) && candidateFits(input, candidate))
    .sort((left, right) => {
      if (identityPolicy?.disposition === "preferred") {
        const byPreference = Number(right.registry.targetId === identityPolicy.targetId) -
          Number(left.registry.targetId === identityPolicy.targetId);
        if (byPreference) return byPreference;
      }
      const byRank = rank.get(left.registry.targetClass)! - rank.get(right.registry.targetClass)!;
      return byRank || left.registry.targetId.localeCompare(right.registry.targetId);
    });

  const selected = eligible[0];
  if (!selected) {
    const identityFailure = Boolean(identityTargetId) && identityPolicy?.unavailableDisposition === "fail";
    return terminalDecision(input, {
      disposition: identityFailure ? "failed" : "queued",
      owner: null,
      reasonCode: identityFailure
        ? "required_target_unavailable"
        : fallback.mode === "forbidden" ? "required_target_unavailable" : "no_eligible_target",
      mode: input.rollout.mode,
      fallbackDisposition: fallback.mode === "forbidden" ? "forbidden" : "ordered_explicit",
    });
  }

  const selectedRank = rank.get(selected.registry.targetClass)!;
  const usedIdentityFallback = identityPolicy?.disposition === "preferred" &&
    selected.registry.targetId !== identityPolicy.targetId;
  return {
    disposition: "selected",
    owner: selected.registry.targetClass,
    targetId: selected.registry.targetId,
    targetClass: selected.registry.targetClass,
    targetScope: selected.registry.targetScope,
    targetGeneration: selected.registry.targetGeneration,
    profileHash: selected.registry.profileHash,
    providerConstraintHash: selected.registry.providerConstraintHash,
    fallbackDisposition: selectedRank === 0 && !usedIdentityFallback ? "primary" : "ordered_explicit",
    reasonCode: input.rollout.mode === "shadow" ? "shadow_selected" : "target_selected",
    mode: input.rollout.mode,
    leaseEligible: input.rollout.mode === "active",
    inputDigest: input.inputDigest,
    policyDigest: input.policyDigest,
  };
}
