import { createHash } from "node:crypto";
import {
  canonicalizeJsonV1,
  workerHelloV1Schema,
  workerSatisfiesRequirements,
  type JobCapabilityRequirementsV1,
  type RegisteredTargetProfileV1,
  type VerifiedProviderConstraintProfileV1,
  type WorkerCapacity,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";

export const LEASE_STATIC_ELIGIBILITY_VERSION = 1;
export const LEASE_CANONICALIZER_VERSION = 1;
export const LEASE_ALGORITHM_VERSION = 1;
export const LEASE_MATCHER_VERSION = 1;
export const LEASE_PLACEMENT_NORMALIZER_VERSION = 1;
export const LEASE_WORKLOAD_VOCABULARY_VERSION = 1;

export const NEUTRAL_LEASE_MATCHER_CAPACITY: WorkerCapacity = Object.freeze({
  batchSlots: 1,
  browserSessionSlots: 1,
  serviceSlots: 1,
  freeCpuMillis: 0,
  freeMemoryMiB: 0,
  freeDiskMiB: 0,
});

type LogicalWorkerSource = {
  id: string;
  scope: "organization" | "owner";
  ownerUserId: string | null;
  targetAuthorityKey: string;
  deviceGeneration: number;
  deviceThumbprint: string;
  profileHash: string;
};

type TargetSource = {
  id: string;
  ownerUserId: string | null;
  targetAuthorityKey: string;
  deviceGeneration: number;
  registeredProfileHash: string;
  providerConstraintHash: string;
};

type CommonLeaseStaticContextSources = {
  organizationId: string;
  parsedWorkerHello: WorkerHelloV1;
  logicalWorker: LogicalWorkerSource;
};

export type LeaseStaticContextSources = CommonLeaseStaticContextSources & (
  | {
      currentTarget: TargetSource & { scope: "platform" };
      physicalAuthorityWorker: {
        id: string;
        deviceGeneration: number;
        profileHash: string;
      };
    }
  | {
      currentTarget: TargetSource & { scope: "organization" | "owner" };
      physicalAuthorityWorker: null;
    }
);

export type LeaseStaticContextInput = {
  organizationId: string;
  logicalWorkerId: string;
  logicalWorkerScope: string;
  logicalWorkerOwnerUserId: string | null;
  logicalWorkerTargetAuthorityKey: string;
  logicalWorkerDeviceGeneration: number;
  logicalWorkerDeviceThumbprint: string;
  logicalWorkerProfileHash: string;
  logicalWorkerStaticMatcherProfileHash: string;
  physicalAuthorityWorkerId: string | null;
  physicalAuthorityWorkerDeviceGeneration: number | null;
  physicalAuthorityWorkerProfileHash: string | null;
  targetId: string;
  targetScope: string;
  targetOwnerUserId: string | null;
  targetAuthorityKey: string;
  targetDeviceGeneration: number;
  targetRegisteredProfileHash: string;
  targetProviderConstraintHash: string;
};

function internalUnavailable(): Error & { code: "internal_unavailable" } {
  return Object.assign(new Error("Lease static context is unavailable"), {
    code: "internal_unavailable" as const,
  });
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requiredGeneration(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export function logicalWorkerStaticMatcherProfileHash(hello: WorkerHelloV1): string {
  return createHash("sha256").update(canonicalizeJsonV1({
    ...hello,
    capacity: NEUTRAL_LEASE_MATCHER_CAPACITY,
  })).digest("hex");
}

export function buildLeaseStaticContextInput(
  sources: LeaseStaticContextSources,
): LeaseStaticContextInput {
  if (!sources || typeof sources !== "object") throw internalUnavailable();
  const hello = workerHelloV1Schema.safeParse(sources.parsedWorkerHello);
  const worker = sources.logicalWorker;
  const target = sources.currentTarget;
  const physical = sources.physicalAuthorityWorker;
  if (!hello.success ||
      !requiredString(sources.organizationId) ||
      !worker || !target ||
      !requiredString(worker.id) ||
      (worker.scope !== "organization" && worker.scope !== "owner") ||
      !(worker.ownerUserId === null || requiredString(worker.ownerUserId)) ||
      !requiredString(worker.targetAuthorityKey) ||
      !requiredGeneration(worker.deviceGeneration) ||
      !requiredString(worker.deviceThumbprint) ||
      !requiredString(worker.profileHash) ||
      !requiredString(target.id) ||
      !["platform", "organization", "owner"].includes(target.scope) ||
      !(target.ownerUserId === null || requiredString(target.ownerUserId)) ||
      !requiredString(target.targetAuthorityKey) ||
      !requiredGeneration(target.deviceGeneration) ||
      !requiredString(target.registeredProfileHash) ||
      !requiredString(target.providerConstraintHash) ||
      (target.scope === "owner" && !requiredString(target.ownerUserId))) {
    throw internalUnavailable();
  }
  if (target.scope === "platform") {
    if (!physical ||
        !requiredString(physical.id) ||
        !requiredGeneration(physical.deviceGeneration) ||
        !requiredString(physical.profileHash)) {
      throw internalUnavailable();
    }
  } else if (physical !== null) {
    throw internalUnavailable();
  }

  return {
    organizationId: sources.organizationId,
    logicalWorkerId: worker.id,
    logicalWorkerScope: worker.scope,
    logicalWorkerOwnerUserId: worker.ownerUserId,
    logicalWorkerTargetAuthorityKey: worker.targetAuthorityKey,
    logicalWorkerDeviceGeneration: worker.deviceGeneration,
    logicalWorkerDeviceThumbprint: worker.deviceThumbprint,
    logicalWorkerProfileHash: worker.profileHash,
    logicalWorkerStaticMatcherProfileHash: logicalWorkerStaticMatcherProfileHash(hello.data),
    physicalAuthorityWorkerId: physical?.id ?? null,
    physicalAuthorityWorkerDeviceGeneration: physical?.deviceGeneration ?? null,
    physicalAuthorityWorkerProfileHash: physical?.profileHash ?? null,
    targetId: target.id,
    targetScope: target.scope,
    targetOwnerUserId: target.ownerUserId,
    targetAuthorityKey: target.targetAuthorityKey,
    targetDeviceGeneration: target.deviceGeneration,
    targetRegisteredProfileHash: target.registeredProfileHash,
    targetProviderConstraintHash: target.providerConstraintHash,
  };
}

export function leaseStaticContextHash(input: LeaseStaticContextInput): string {
  return createHash("sha256").update(canonicalizeJsonV1({
    certificateVersion: LEASE_STATIC_ELIGIBILITY_VERSION,
    canonicalizerVersion: LEASE_CANONICALIZER_VERSION,
    leasingAlgorithmVersion: LEASE_ALGORITHM_VERSION,
    matcherVersion: LEASE_MATCHER_VERSION,
    placementNormalizerVersion: LEASE_PLACEMENT_NORMALIZER_VERSION,
    workloadVocabularyVersion: LEASE_WORKLOAD_VOCABULARY_VERSION,
    organizationId: input.organizationId,
    logicalWorkerId: input.logicalWorkerId,
    logicalWorkerScope: input.logicalWorkerScope,
    logicalWorkerOwnerUserId: input.logicalWorkerOwnerUserId,
    logicalWorkerTargetAuthorityKey: input.logicalWorkerTargetAuthorityKey,
    logicalWorkerDeviceGeneration: input.logicalWorkerDeviceGeneration,
    logicalWorkerDeviceThumbprint: input.logicalWorkerDeviceThumbprint,
    logicalWorkerProfileHash: input.logicalWorkerProfileHash,
    logicalWorkerStaticMatcherProfileHash: input.logicalWorkerStaticMatcherProfileHash,
    physicalAuthorityWorkerId: input.physicalAuthorityWorkerId,
    physicalAuthorityWorkerDeviceGeneration: input.physicalAuthorityWorkerDeviceGeneration,
    physicalAuthorityWorkerProfileHash: input.physicalAuthorityWorkerProfileHash,
    targetId: input.targetId,
    targetScope: input.targetScope,
    targetOwnerUserId: input.targetOwnerUserId,
    targetAuthorityKey: input.targetAuthorityKey,
    targetDeviceGeneration: input.targetDeviceGeneration,
    targetRegisteredProfileHash: input.targetRegisteredProfileHash,
    targetProviderConstraintHash: input.targetProviderConstraintHash,
  })).digest("hex");
}

export function evaluateStaticLeaseEligibility(input: {
  target: RegisteredTargetProfileV1;
  verifiedProviderConstraints: VerifiedProviderConstraintProfileV1;
  worker: WorkerHelloV1;
  requirements: JobCapabilityRequirementsV1;
}): { eligible: boolean; reasonCode: "static_requirements_mismatch" | null } {
  const eligible = workerSatisfiesRequirements(
    input.target,
    input.verifiedProviderConstraints,
    { ...input.worker, capacity: NEUTRAL_LEASE_MATCHER_CAPACITY },
    input.requirements,
  );
  return {
    eligible,
    reasonCode: eligible ? null : "static_requirements_mismatch",
  };
}
