/**
 * Measured free-capacity advertisement + capability self-check (WRK-003).
 *
 * `measureCapacity` reports the worker's REAL free CPU/memory/disk (read from
 * `node:os` / `node:fs` via injected probes) MINUS the sum of in-flight lease
 * reservations, plus the per-workload free-slot counts from the concurrency
 * limiter. Free resources are floored at zero and clamped to the server-owned
 * provider resource ceiling so the worker never over-advertises (the frozen
 * matcher rejects a worker whose advertised free resources exceed the ceiling).
 * The result is validated against the frozen `workerCapacitySchema`.
 *
 * The capability self-check (`offerSatisfiesWorker`) is defense-in-depth: the
 * server already ran the authoritative placement match, but the worker re-runs
 * the SAME frozen `workerSatisfiesRequirements` locally over the intersection of
 * its server-assigned registered-target profile + verified provider-constraint
 * ceiling and its own dynamic report + CURRENT capacity. An offer the worker
 * cannot prove it satisfies is never ACKed. `deriveJobRequirements` folds an
 * offered job envelope into the `JobCapabilityRequirementsV1` the matcher wants;
 * a job requiring a capability outside the closed provider-neutral vocabulary
 * fails the schema parse → fail closed (not satisfied).
 */

import {
  jobCapabilityRequirementsSchema,
  workerCapacitySchema,
  workerSatisfiesRequirements,
  type JobCapabilityRequirementsV1,
  type JobEnvelopeV1,
  type LeaseOfferV1,
  type RegisteredTargetProfileV1,
  type VerifiedProviderConstraintProfileV1,
  type WorkerCapacity,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";

import type { WorkloadSlotSnapshot } from "./concurrency.js";

/** A per-lease (or summed) resource reservation subtracted from free capacity. */
export interface CapacityReservation {
  readonly cpuMillis: number;
  readonly memoryMiB: number;
  readonly diskMiB: number;
}

/** Injectable free-resource readers (real impl reads `node:os` / `node:fs`). */
export interface CapacityProbes {
  readonly freeCpuMillis: () => number;
  readonly freeMemoryMiB: () => number;
  readonly freeDiskMiB: () => number;
}

/** The provider resource ceiling free resources are clamped to (never exceed it). */
export interface ResourceCeiling {
  readonly cpuMillis: number;
  readonly memoryMiB: number;
  readonly diskMiB: number;
}

export interface MeasureCapacityInput {
  readonly probes: CapacityProbes;
  readonly reserved: CapacityReservation;
  readonly slots: WorkloadSlotSnapshot;
  /** Optional provider ceiling; when present, free resources are clamped to it. */
  readonly ceiling?: ResourceCeiling;
}

/** Sum a set of in-flight lease reservations into a single reservation total. */
export function sumReservations(reservations: readonly CapacityReservation[]): CapacityReservation {
  const total = { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 };
  for (const r of reservations) {
    total.cpuMillis += r.cpuMillis;
    total.memoryMiB += r.memoryMiB;
    total.diskMiB += r.diskMiB;
  }
  return total;
}

function freeAfter(measured: number, reserved: number, ceiling: number | undefined): number {
  let free = Math.floor(measured) - Math.floor(reserved);
  if (free < 0) free = 0;
  if (ceiling !== undefined && free > ceiling) free = Math.floor(ceiling);
  return free;
}

/**
 * Measure the worker's advertisable free capacity: free resources minus in-flight
 * reservations (floored at zero, clamped to the provider ceiling) plus the free
 * per-workload slot counts. Validated against the frozen `workerCapacitySchema`.
 */
export function measureCapacity(input: MeasureCapacityInput): WorkerCapacity {
  const capacity = {
    batchSlots: input.slots.batch,
    browserSessionSlots: input.slots.browser_session,
    serviceSlots: input.slots.service,
    freeCpuMillis: freeAfter(input.probes.freeCpuMillis(), input.reserved.cpuMillis, input.ceiling?.cpuMillis),
    freeMemoryMiB: freeAfter(input.probes.freeMemoryMiB(), input.reserved.memoryMiB, input.ceiling?.memoryMiB),
    freeDiskMiB: freeAfter(input.probes.freeDiskMiB(), input.reserved.diskMiB, input.ceiling?.diskMiB),
  };
  // A local contract failure surfaces here rather than on the wire.
  return workerCapacitySchema.parse(capacity);
}

// --- Capability self-check ---------------------------------------------------

/**
 * The worker's server-assigned identity for the self-check: its registered target
 * profile (the capability/placement ceiling), the digest-verified provider
 * constraint profile (branded — a raw parsed profile is a compile-time error at
 * the matcher call), and its dynamic report (capabilities/platform/policy/ids).
 * The report's `capacity` is replaced with the CURRENT measurement per offer.
 */
export interface WorkerSelfModel {
  readonly registeredTargetProfile: RegisteredTargetProfileV1;
  readonly verifiedProviderConstraints: VerifiedProviderConstraintProfileV1;
  readonly report: WorkerHelloV1;
}

/**
 * Fold an offered job envelope into the `JobCapabilityRequirementsV1` the frozen
 * matcher consumes. Returns null (fail closed) when the envelope's
 * `requiredCapabilities`/placement cannot form a valid requirements object — e.g.
 * a required capability outside the closed provider-neutral vocabulary.
 */
export function deriveJobRequirements(job: JobEnvelopeV1): JobCapabilityRequirementsV1 | null {
  const candidate = {
    protocol: { min: 1, max: 1 },
    capabilities: job.requiredCapabilities,
    workloadType: job.workloadType,
    targetRequirements: job.placement.targetRequirements,
    policyHash: job.policyHash,
    mustUnderstand: [],
  };
  const parsed = jobCapabilityRequirementsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Defense-in-depth self-check: does THIS worker (with its current measured
 * capacity) satisfy the offered job? Runs the frozen intersection matcher over
 * the worker's server-assigned ceilings + its report. Fail-closed on a
 * un-deriveable requirements object.
 */
export function offerSatisfiesWorker(
  self: WorkerSelfModel,
  currentCapacity: WorkerCapacity,
  offer: LeaseOfferV1,
): boolean {
  const requirements = deriveJobRequirements(offer.job);
  if (requirements === null) return false;
  const report: WorkerHelloV1 = { ...self.report, capacity: currentCapacity };
  return workerSatisfiesRequirements(
    self.registeredTargetProfile,
    self.verifiedProviderConstraints,
    report,
    requirements,
  );
}
