/**
 * Shared builders for the WRK-006 durable-event-outbox tests. Boundary-clean
 * (Node builtins + frozen worker-protocol + the worker's own relative modules),
 * so the `check:worker-daemon-boundary` scan of `src` passes.
 *
 * `stampEvent` mirrors the production `EventSequencer` digest computation
 * (`canonicalEventDigestInputV1` + SHA-256) so a test can mint a genuinely valid,
 * digest-stamped `WorkerEventV1` for ANY of the 19 kinds — including kinds with no
 * live producer yet — to prove the outbox persists/replays them VERBATIM.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  canonicalEventDigestInputV1,
  workerEventV1Schema,
  type WorkerEventType,
  type WorkerEventV1,
} from "@armyofagents/worker-protocol";

import type { EventDeliveryIdentity } from "../../supervisor/events.js";
import { FENCE_TOKEN, POLL_FIXTURE_IDS } from "./poll-fixtures.js";

/** The canonical delivery identity used across the outbox tests. */
export function eventIdentity(overrides: Partial<EventDeliveryIdentity> = {}): EventDeliveryIdentity {
  return {
    organizationId: POLL_FIXTURE_IDS.org,
    companyId: POLL_FIXTURE_IDS.company,
    workerId: POLL_FIXTURE_IDS.worker,
    jobId: POLL_FIXTURE_IDS.job,
    attempt: 1,
    leaseId: POLL_FIXTURE_IDS.lease,
    fenceToken: FENCE_TOKEN,
    ...overrides,
  };
}

export interface StampEventOptions {
  readonly eventId?: string;
  readonly occurredAt?: string;
}

/** Mint a digest-stamped, schema-valid `WorkerEventV1` (the sequencer's own
 * canonicalization) so seq/digest are REAL — a re-stamp bug in the outbox would
 * make the fake plane's independent digest recomputation reject it. */
export function stampEvent(
  identity: EventDeliveryIdentity,
  seq: number,
  eventType: WorkerEventType,
  payload: unknown,
  options: StampEventOptions = {},
): WorkerEventV1 {
  const withoutDigest = {
    protocolVersion: 1 as const,
    eventId: options.eventId ?? randomUUID(),
    organizationId: identity.organizationId,
    companyId: identity.companyId,
    workerId: identity.workerId,
    jobId: identity.jobId,
    attempt: identity.attempt,
    leaseId: identity.leaseId,
    fenceToken: identity.fenceToken,
    seq,
    occurredAt: options.occurredAt ?? new Date(seq * 1000).toISOString(),
    extensions: [] as const,
    eventType,
    payload,
  };
  const eventDigest = createHash("sha256").update(canonicalEventDigestInputV1(withoutDigest)).digest("hex");
  return workerEventV1Schema.parse({ ...withoutDigest, eventDigest });
}

/** A small representative payload for a kind (enough to pass its strict schema). */
export function samplePayloadFor(eventType: WorkerEventType): unknown {
  switch (eventType) {
    case "attempt_started":
      return { sandboxId: POLL_FIXTURE_IDS.runId };
    case "log":
      return { stream: "stdout", level: "info", message: "hello" };
    case "progress":
      return { message: "working", percent: 50 };
    case "network_denied":
      return { destinationClass: "control_plane", reason: "fence closed" };
    case "terminal":
      return { status: "succeeded", exitCode: 0, errorCode: null, errorMessage: null };
    default:
      return null;
  }
}

/** A stamped attempt_started + terminal pair over one identity (the produced kinds). */
export function producedEventPair(identity: EventDeliveryIdentity): WorkerEventV1[] {
  return [
    stampEvent(identity, 1, "attempt_started", samplePayloadFor("attempt_started")),
    stampEvent(identity, 2, "terminal", samplePayloadFor("terminal")),
  ];
}
