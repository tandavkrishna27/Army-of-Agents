/**
 * Shared builders for the WRK-004 sandbox-supervisor tests. Boundary-clean (Node
 * builtins + frozen worker-protocol + the worker's own relative modules).
 *
 * Two flavours:
 *  - `sampleLabels` / `makeCtx` for the provider + authority UNIT tests (labels are
 *    opaque strings the fake/authorities treat structurally).
 *  - `makeHandoff` / `SUPERVISOR_IDENTITY` for the supervisor COMPONENT tests,
 *    which emit real `workerEventV1` records and so need schema-valid delivery
 *    identity (the parsed `compatibleOffer` supplies uuids + a valid fence).
 */

import {
  leaseOfferV1Schema,
  type LeaseOfferV1,
  type WorkerEventV1,
} from "@armyofagents/worker-protocol";

import type { LeaseHandoff } from "../../poll/poll-loop.js";
import type { WorkerEventSink } from "../../supervisor/events.js";
import type { ProviderOpContext, ResourceLabels } from "../../supervisor/provider.js";
import type { WorkerSupervisionIdentity } from "../../supervisor/supervisor.js";
import { compatibleOffer, POLL_FIXTURE_IDS } from "./poll-fixtures.js";

let ctxCounter = 0;

/** A fresh op context with a unique idempotency key (stable when `key` given). */
export function makeCtx(key?: string, deadlineMs = 60_000): ProviderOpContext {
  return { deadlineMs, idempotencyKey: key ?? `idem-${++ctxCounter}` };
}

/** Opaque-string labels for provider/authority unit tests. */
export function sampleLabels(overrides: Partial<ResourceLabels> = {}): ResourceLabels {
  return {
    organizationId: "org-1",
    targetId: "target-1",
    workerId: "worker-1",
    jobId: "job-1",
    attempt: 1,
    leaseId: "lease-1",
    deviceGeneration: 1,
    ...overrides,
  };
}

export const SUPERVISOR_IDENTITY: WorkerSupervisionIdentity = {
  targetId: POLL_FIXTURE_IDS.target,
  deviceGeneration: 1,
};

/** Parse the shared compatible offer and wrap it as a `LeaseHandoff`. */
export function makeHandoff(overrides: Record<string, unknown> = {}): LeaseHandoff {
  const offer: LeaseOfferV1 = leaseOfferV1Schema.parse(compatibleOffer(overrides));
  return {
    offer,
    leaseId: String(offer.leaseId),
    fenceToken: String(offer.fenceToken),
    workloadClass: "batch",
  };
}

/**
 * SVC-008b — the SAME offer, re-stamped as a `service` job envelope.
 *
 * ★ It parses through the SAME frozen `leaseOfferV1Schema` as `makeHandoff`, so the
 * discriminated union (`workloadType: "service"` -> `serviceWorkloadV1Schema`) is what
 * validates the workload. A hand-rolled object would let a test assert against a shape
 * the wire would refuse.
 *
 * `workloadClass` is `"service"` because the poll loop's limiter keys on
 * `offer.job.workloadType`; a handoff whose class disagreed with its envelope would
 * make T7's class-separation assertion vacuous.
 */
export function makeServiceHandoff(
  workloadOverrides: Record<string, unknown> = {},
  offerOverrides: Record<string, unknown> = {},
): LeaseHandoff {
  const base = compatibleOffer();
  const job = base.job as Record<string, unknown>;
  const offer: LeaseOfferV1 = leaseOfferV1Schema.parse({
    ...base,
    ...offerOverrides,
    job: {
      ...job,
      workloadType: "service",
      workload: {
        serviceId: SERVICE_FIXTURE_IDS.serviceId,
        serviceInstanceId: SERVICE_FIXTURE_IDS.serviceInstanceId,
        generation: 3,
        command: "codex",
        args: ["serve", "--port", "8080"],
        checkpointArtifactId: null,
        gracefulStopSeconds: 5,
        ...workloadOverrides,
      },
    },
  });
  return {
    offer,
    leaseId: String(offer.leaseId),
    fenceToken: String(offer.fenceToken),
    workloadClass: "service",
  };
}

/** The service identity `makeServiceHandoff` stamps — every service event must repeat it. */
export const SERVICE_FIXTURE_IDS = {
  serviceId: "00000000-0000-4000-8000-0000000000b1",
  serviceInstanceId: "00000000-0000-4000-8000-0000000000b2",
} as const;

/** The exact `ResourceLabels` the supervisor derives from `makeHandoff()` — for
 * building a CleanupAuthority / create spec bound to the same resource. */
export function handoffLabels(): ResourceLabels {
  return {
    organizationId: POLL_FIXTURE_IDS.org,
    targetId: SUPERVISOR_IDENTITY.targetId,
    workerId: POLL_FIXTURE_IDS.worker,
    jobId: POLL_FIXTURE_IDS.job,
    attempt: 1,
    leaseId: POLL_FIXTURE_IDS.lease,
    deviceGeneration: SUPERVISOR_IDENTITY.deviceGeneration,
  };
}

export interface CollectingSink extends WorkerEventSink {
  readonly events: WorkerEventV1[];
}

/** An in-memory event sink (durable upload is WRK-006). */
export function collectingSink(): CollectingSink {
  const events: WorkerEventV1[] = [];
  return {
    events,
    emit(event: WorkerEventV1): void {
      events.push(event);
    },
  };
}

/** A resolvable barrier for holding a run in-flight at `execute`. */
export function makeGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** Poll `cond` until true or `timeoutMs` elapses. */
export async function waitFor(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 2));
  }
}
