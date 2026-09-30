/**
 * Long-poll loop: poll → self-check → ACK → hand off, with bounded backoff and
 * drain-before-lease-stop (WRK-003).
 *
 * This module owns the single-operation primitives (`pollOnce`, `ackLease` +
 * their request builders) and the composed `runPollLoop`. It advertises measured
 * capacity, receives AT MOST one lease offer per poll, self-checks capability
 * (defense in depth — see `offerSatisfiesWorker`), ACKs promptly with a
 * `leaseId` that equals the URL param, and hands the lease + fence to the WRK-004
 * supervisor SEAM (a typed interface + handoff; the real supervisor is WRK-004).
 *
 * Terminal vs transient (E4-D11 / E4-F007): a poll/ack **401 unauthorized**
 * means the session is expired/invalid and — because the as-built server offers
 * NO session renewal on poll/ack — the loop attempts a within-window lost-response
 * recovery through the WRK-002 `SessionProvider`; if recovery is impossible (the
 * code route has lapsed) the provider goes terminal (its own
 * `reenrollment_required` metric + warn) and the loop STOPS rather than busy-spin
 * re-polling a dead session. A **409 target_revoked** is likewise terminal.
 * timeout / socket / `throttled` / `internal_unavailable` are TRANSIENT → bounded
 * jittered backoff and continue; a `malformed`/incompatible protocol error is
 * surfaced (backoff + continue) without leaking the offer.
 *
 * Runtime source imports only the frozen protocol, `node:*`, and relative modules
 * (no `require`, no `node:module`) — the E4-D01 boundary.
 */

import { randomBytes, randomUUID } from "node:crypto";

import {
  leaseAckOperationRequestV1Schema,
  leaseAckOperationResponseV1Schema,
  pollRequestV1Schema,
  pollResponseV1Schema,
  protocolErrorV1Schema,
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type PollRequestV1,
  type WorkerCapacity,
} from "@armyofagents/worker-protocol";

import type { DeviceKey } from "../identity/device-key.js";
import { signDeviceProof } from "../identity/device-proof.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import type { SessionStore } from "../identity/session.js";
import type { Logger } from "../logging/logger.js";
import type { Metrics } from "../metrics/metrics.js";
import {
  ControlPlaneTransportError,
  type ControlPlaneClient,
  type WorkerOperationHttpResponse,
} from "../transport/client.js";
import {
  INITIAL_BACKOFF_STATE,
  backoffBucket,
  nextBackoff,
  type BackoffConfig,
  type BackoffState,
} from "./backoff.js";
import { offerSatisfiesWorker, type WorkerSelfModel } from "./capacity.js";
import type { ConcurrencyLimiter, WorkloadClass } from "./concurrency.js";
import { createLeaseLifecycleSteps, type LeasingLifecycle } from "../lifecycle/shutdown.js";

// Re-exported for ergonomic composition (the loop IS the leasing lifecycle the
// shutdown steps drive; the ordered-steps factory itself lives in `shutdown.ts`).
export { createLeaseLifecycleSteps };
export type { LeasingLifecycle };

// --- Observable signal names (bounded labels registered in metrics.ts) --------

export const POLL_OUTCOME_METRIC = "poll_outcome";
export const LEASE_ACK_METRIC = "lease_ack";
export const ACTIVE_LEASES_METRIC = "active_leases";
export const BACKOFF_SLEEP_METRIC = "backoff_sleep_ms";
export const CAPACITY_FREE_SLOTS_METRIC = "capacity_free_slots";

/**
 * The max number of consecutive recover-then-immediately-401 cycles before the
 * loop declares the session TERMINAL and stops (FIX for the recover→poll→recover
 * zero-backoff spin). A session that authenticates on ENROLL but is persistently
 * rejected on poll/ack (clock skew, audience/thumbprint desync) would otherwise
 * loop forever with no backoff and no cap; after this many recoveries with no
 * intervening successful poll we surface `reenrollment_required` and stop. The
 * counter resets on any poll that returns `no_work`/`offer`.
 */
export const MAX_CONSECUTIVE_RECOVERIES = 3;

// --- Request builders --------------------------------------------------------

export interface PollRequestEnvelope {
  readonly request: PollRequestV1;
  /** The exact bytes to POST (and to digest for the device proof). */
  readonly bytes: Buffer;
}

export interface BuildPollRequestInput {
  readonly session: WorkerSession;
  readonly capacity: WorkerCapacity;
  readonly correlationId: string;
  readonly issuedAt: string;
  readonly nonce: string;
}

/** Assemble + validate the poll request (audience `worker_poll`) and freeze its
 * transport bytes; the device proof digests these SAME bytes. */
export function buildPollRequest(input: BuildPollRequestInput): PollRequestEnvelope {
  const request = pollRequestV1Schema.parse({
    protocolVersion: 1,
    correlationId: input.correlationId,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    audience: "worker_poll",
    workerId: input.session.workerId,
    targetId: input.session.targetId,
    deviceGeneration: input.session.deviceGeneration,
    capacity: input.capacity,
  });
  return { request, bytes: Buffer.from(JSON.stringify(request), "utf8") };
}

export interface LeaseAckRequestEnvelope {
  readonly request: LeaseAckOperationRequestV1;
  readonly bytes: Buffer;
}

export interface BuildLeaseAckRequestInput {
  readonly offer: LeaseOfferV1;
  readonly correlationId: string;
  readonly issuedAt: string;
  readonly nonce: string;
  readonly idempotencyKey: string;
  readonly ackedAt: string;
}

/** Assemble + validate the lease-ack operation (audience `worker_run`); the body
 * echoes the offered lease identity and its `leaseId` MUST equal the URL param. */
export function buildLeaseAckRequest(input: BuildLeaseAckRequestInput): LeaseAckRequestEnvelope {
  const request = leaseAckOperationRequestV1Schema.parse({
    protocolVersion: 1,
    correlationId: input.correlationId,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    audience: "worker_run",
    idempotencyKey: input.idempotencyKey,
    body: {
      protocolVersion: 1,
      workerId: input.offer.workerId,
      jobId: input.offer.job.jobId,
      attempt: input.offer.job.attempt,
      leaseId: input.offer.leaseId,
      fenceToken: input.offer.fenceToken,
      ackedAt: input.ackedAt,
    },
  });
  return { request, bytes: Buffer.from(JSON.stringify(request), "utf8") };
}

// --- Single-operation results ------------------------------------------------

export type TransientLabel = "timeout" | "socket_error" | "throttled" | "internal_unavailable";

export type PollAttempt =
  | { readonly kind: "offer"; readonly offer: LeaseOfferV1; readonly correlationId: string }
  | { readonly kind: "no_work"; readonly retryAfterMs: number }
  | { readonly kind: "drain"; readonly retryAfterMs: number | null; readonly reason: string | null }
  | { readonly kind: "terminal"; readonly reason: "unauthorized" | "target_revoked" }
  | { readonly kind: "transient"; readonly label: TransientLabel; readonly retryAfterMs: number | null }
  | { readonly kind: "protocol"; readonly label: "malformed" | "incompatible"; readonly code: string };

export type AckAttempt =
  | { readonly kind: "acknowledged"; readonly leaseId: string }
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "terminal"; readonly reason: "unauthorized" | "target_revoked" }
  | { readonly kind: "transient"; readonly label: TransientLabel; readonly retryAfterMs: number | null }
  | { readonly kind: "protocol"; readonly label: "malformed"; readonly code: string };

/** Injectable per-request nonces/ids so tests pin the wire bytes. */
export interface OperationRandomness {
  readonly now?: () => number;
  readonly newCorrelationId?: () => string;
  readonly newProofId?: () => string;
  readonly newNonce?: () => string;
  readonly newIdempotencyKey?: () => string;
}

function defaultProofId(): string {
  return `prf_${randomBytes(24).toString("base64url")}`;
}
function defaultNonce(): string {
  return randomBytes(18).toString("base64url");
}

export interface PollOnceDeps extends OperationRandomness {
  readonly client: ControlPlaneClient;
  readonly session: WorkerSession;
  readonly capacity: WorkerCapacity;
  readonly key: DeviceKey;
}

/**
 * Perform ONE poll: build + sign (over the poll path + exact bytes) + POST, then
 * classify the response into a single `PollAttempt`. It performs NO self-check
 * and NO ACK — the loop does. A transport failure never throws out of here; it
 * maps to a transient outcome.
 */
export async function pollOnce(deps: PollOnceDeps): Promise<PollAttempt> {
  const now = deps.now ?? (() => Date.now());
  const correlationId = (deps.newCorrelationId ?? randomUUID)();
  const nonce = (deps.newNonce ?? defaultNonce)();
  const envelope = buildPollRequest({
    session: deps.session,
    capacity: deps.capacity,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    nonce,
  });
  const proof = signDeviceProof({
    method: "POST",
    path: deps.client.pollPath,
    rawBody: envelope.bytes,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    proofId: (deps.newProofId ?? defaultProofId)(),
    key: deps.key,
  });

  let response: WorkerOperationHttpResponse;
  try {
    response = await deps.client.poll({
      bytes: envelope.bytes,
      sessionToken: deps.session.token,
      proofHeaders: proof.headers,
      requestId: correlationId,
    });
  } catch (err) {
    return classifyTransportError(err);
  }
  return classifyPollResponse(response);
}

function classifyTransportError(err: unknown): { kind: "transient"; label: TransientLabel; retryAfterMs: null } | { kind: "protocol"; label: "malformed"; code: string } {
  if (err instanceof ControlPlaneTransportError) {
    if (err.kind === "timeout") return { kind: "transient", label: "timeout", retryAfterMs: null };
    if (err.kind === "network") return { kind: "transient", label: "socket_error", retryAfterMs: null };
    // request_too_large — a local guard, not an outage; surface + backoff.
    return { kind: "protocol", label: "malformed", code: "request_too_large" };
  }
  throw err;
}

function classifyPollResponse(response: WorkerOperationHttpResponse): PollAttempt {
  if (response.status === 200) {
    const parsed = pollResponseV1Schema.safeParse(response.body);
    if (!parsed.success) return { kind: "protocol", label: "malformed", code: "malformed" };
    const data = parsed.data;
    if (data.outcome === "offer") return { kind: "offer", offer: data.body, correlationId: data.correlationId };
    if (data.outcome === "no_work") return { kind: "no_work", retryAfterMs: data.retryAfterMs };
    return { kind: "drain", retryAfterMs: data.retryAfterMs, reason: data.reason };
  }
  const err = protocolErrorV1Schema.safeParse(response.body);
  const code = err.success ? err.data.code : null;
  const retryAfterMs = err.success ? err.data.retryAfterMs : null;

  if (response.status === 401) return { kind: "terminal", reason: "unauthorized" };
  if (code === "target_revoked") return { kind: "terminal", reason: "target_revoked" };
  if (code === "throttled" || response.status === 429) return { kind: "transient", label: "throttled", retryAfterMs };
  if (code === "internal_unavailable" || response.status === 503) {
    return { kind: "transient", label: "internal_unavailable", retryAfterMs };
  }
  if (code === "malformed" || response.status === 400) {
    return { kind: "protocol", label: "malformed", code: code ?? "malformed" };
  }
  // Any other non-terminal protocol error (incompatible_protocol/capability/
  // policy, an unexpected status) is surfaced and the loop continues after backoff.
  return { kind: "protocol", label: "incompatible", code: code ?? `http_${response.status}` };
}

export interface AckLeaseDeps extends OperationRandomness {
  readonly client: ControlPlaneClient;
  readonly session: WorkerSession;
  readonly offer: LeaseOfferV1;
  readonly key: DeviceKey;
}

/**
 * ACK an offered lease: build + sign (over `leaseAckPath(leaseId)` + exact bytes)
 * + POST, then classify. `leaseId` in the body equals the URL param by
 * construction. A transport failure maps to a transient outcome (never throws).
 */
export async function ackLease(deps: AckLeaseDeps): Promise<AckAttempt> {
  const now = deps.now ?? (() => Date.now());
  const leaseId = deps.offer.leaseId;
  const correlationId = (deps.newCorrelationId ?? randomUUID)();
  const nonce = (deps.newNonce ?? defaultNonce)();
  const idempotencyKey = (deps.newIdempotencyKey ?? randomUUID)();
  const envelope = buildLeaseAckRequest({
    offer: deps.offer,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    nonce,
    idempotencyKey,
    ackedAt: new Date(now()).toISOString(),
  });
  const proof = signDeviceProof({
    method: "POST",
    path: deps.client.leaseAckPath(leaseId),
    rawBody: envelope.bytes,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    proofId: (deps.newProofId ?? defaultProofId)(),
    key: deps.key,
  });

  let response: WorkerOperationHttpResponse;
  try {
    response = await deps.client.leaseAck(leaseId, {
      bytes: envelope.bytes,
      sessionToken: deps.session.token,
      proofHeaders: proof.headers,
      requestId: correlationId,
    });
  } catch (err) {
    if (err instanceof ControlPlaneTransportError) {
      if (err.kind === "timeout") return { kind: "transient", label: "timeout", retryAfterMs: null };
      if (err.kind === "network") return { kind: "transient", label: "socket_error", retryAfterMs: null };
      return { kind: "protocol", label: "malformed", code: "request_too_large" };
    }
    throw err;
  }
  return classifyAckResponse(response, leaseId);
}

function classifyAckResponse(response: WorkerOperationHttpResponse, leaseId: string): AckAttempt {
  if (response.status === 200) {
    const parsed = leaseAckOperationResponseV1Schema.safeParse(response.body);
    if (!parsed.success) return { kind: "protocol", label: "malformed", code: "malformed" };
    if (parsed.data.outcome === "acknowledged") return { kind: "acknowledged", leaseId };
    return { kind: "rejected", code: parsed.data.reason };
  }
  const err = protocolErrorV1Schema.safeParse(response.body);
  const code = err.success ? err.data.code : null;
  const retryAfterMs = err.success ? err.data.retryAfterMs : null;

  if (response.status === 401) return { kind: "terminal", reason: "unauthorized" };
  if (code === "target_revoked") return { kind: "terminal", reason: "target_revoked" };
  if (code === "throttled" || response.status === 429) return { kind: "transient", label: "throttled", retryAfterMs };
  if (code === "internal_unavailable" || response.status === 503) {
    return { kind: "transient", label: "internal_unavailable", retryAfterMs };
  }
  // malformed / stale_fence / attempt_terminal / other: the offer is dropped
  // (slot released), surfaced, and the loop continues after backoff.
  return { kind: "protocol", label: "malformed", code: code ?? `http_${response.status}` };
}

// --- Session provider (WRK-002 SessionStore adapter) -------------------------

/** Thrown by the session provider when re-enrollment is required (the underlying
 * WRK-002 SessionStore went terminal and already emitted its
 * `reenrollment_required` metric + warn). The loop STOPS on this — it never
 * busy-spins re-polling a dead session. */
export class SessionTerminalError extends Error {
  constructor() {
    super("worker session terminal: operator re-enrollment required");
    this.name = "SessionTerminalError";
  }
}

export interface SessionProvider {
  /** The current live session; a terminal identity throws `SessionTerminalError`. */
  get(): Promise<WorkerSession>;
  /** Force a lost-response recovery after a poll/ack 401; recovers a fresh session
   * within the code-route window or throws `SessionTerminalError` when the route
   * has lapsed. A transient failure rethrows (the loop backs off). */
  recover(): Promise<WorkerSession>;
}

/**
 * Adapt the WRK-002 `SessionStore` to the loop's `SessionProvider`. A store that
 * has gone terminal (revoked/replaced identity or a lapsed code route — all 401
 * on the enroll path per E4-D11) surfaces as `SessionTerminalError`; any other
 * failure rethrows unchanged so the loop treats it as transient.
 */
export function createSessionProvider(store: SessionStore): SessionProvider {
  const wrap = async (op: () => Promise<WorkerSession>): Promise<WorkerSession> => {
    try {
      return await op();
    } catch (err) {
      if (store.isStopped()) throw new SessionTerminalError();
      throw err;
    }
  };
  return {
    get: () => wrap(() => store.ensureFresh()),
    recover: () => wrap(() => store.forceRefresh()),
  };
}

// --- Supervisor seam (WRK-004 handoff) ---------------------------------------

/** An ACKed lease handed to the supervisor for execution. */
export interface LeaseHandoff {
  readonly offer: LeaseOfferV1;
  readonly leaseId: string;
  readonly fenceToken: string;
  readonly workloadClass: WorkloadClass;
}

/**
 * The WRK-004 sandbox-supervisor seam. WRK-003 introduced this typed interface +
 * handoff; the REAL supervisor (`createSupervisor` in `../supervisor/supervisor.ts`)
 * now implements it — the loop hands each ACKed lease to the supervisor, which
 * drives create → execute (inside the sandbox) → terminal → destroy under effect
 * authority, escalating to the distinct monotonic cleanup authority on abnormal
 * paths. `accept` returns a promise the loop treats as the in-flight lifetime — it
 * releases the concurrency slot and clears the active-lease when it settles, and
 * the drain step awaits it. The seam SHAPE is unchanged (WRK-003 stayed green);
 * only the implementation behind it landed.
 */
export interface SupervisorSeam {
  accept(handoff: LeaseHandoff): Promise<void> | void;
}

// --- The composed long-poll loop ---------------------------------------------

export type PollLoopStopReason = "reenrollment_required" | "target_revoked" | "drained" | "stopped";

export interface PollLoopController {
  /** Run until a terminal identity, a drain, or `stopLeasing()`. Always drains
   * in-flight leases before returning. */
  run(): Promise<PollLoopStopReason>;
  /** Shutdown step 1: stop acquiring new leases (idempotent). */
  stopLeasing(): void;
  /** Shutdown step 2: await all in-flight handoffs to settle. */
  drain(): Promise<void>;
  /** In-flight lease count (held concurrency slots). */
  activeLeaseCount(): number;
}

export interface PollLoopDeps {
  readonly client: ControlPlaneClient;
  readonly self: WorkerSelfModel;
  readonly key: DeviceKey;
  readonly session: SessionProvider;
  readonly limiter: ConcurrencyLimiter;
  /** Measures the current advertisable capacity (reflecting live limiter slots). */
  readonly measure: () => WorkerCapacity;
  readonly supervisor: SupervisorSeam;
  readonly backoff: BackoffConfig;
  readonly metrics?: Metrics;
  readonly logger?: Logger;
  /** Injectable sleep; defaults to a real `setTimeout` wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly rng?: () => number;
  readonly randomness?: OperationRandomness;
}

type OfferHandling =
  | { readonly kind: "continue" }
  | { readonly kind: "recover" }
  | { readonly kind: "revoked" }
  | { readonly kind: "backoff"; readonly retryAfterMs: number | null };

/**
 * Compose the long-poll loop. It advertises measured capacity, self-checks each
 * offer (defense in depth), ACKs promptly, hands the lease to the supervisor
 * seam, backs off (bounded, jittered) on transient failures, treats a session/
 * target-terminal signal as a full stop, and — on `stopLeasing()`/`drain` —
 * stops leasing BEFORE draining in-flight work.
 */
export function createPollLoop(deps: PollLoopDeps): PollLoopController {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = deps.rng ?? Math.random;
  const activeHandoffs = new Set<Promise<void>>();
  let backoffState: BackoffState = INITIAL_BACKOFF_STATE;
  let stopLeasingRequested = false;
  let drainRequested = false;
  // Consecutive recover-then-poll cycles with NO intervening successful poll; a
  // bound on this prevents an unbounded recover→poll→recover spin (see
  // MAX_CONSECUTIVE_RECOVERIES). Reset by any poll returning no_work/offer.
  let consecutiveRecoveries = 0;

  const emitPoll = (outcome: string): void => deps.metrics?.inc(POLL_OUTCOME_METRIC, { outcome });
  const emitAck = (outcome: string): void => deps.metrics?.inc(LEASE_ACK_METRIC, { outcome });

  function publishCapacityGauges(capacity: WorkerCapacity): void {
    deps.metrics?.setGauge(CAPACITY_FREE_SLOTS_METRIC, capacity.batchSlots, { workload: "batch" });
    deps.metrics?.setGauge(CAPACITY_FREE_SLOTS_METRIC, capacity.browserSessionSlots, { workload: "browser_session" });
    deps.metrics?.setGauge(CAPACITY_FREE_SLOTS_METRIC, capacity.serviceSlots, { workload: "service" });
  }
  function publishActiveLeases(): void {
    deps.metrics?.setGauge(ACTIVE_LEASES_METRIC, activeHandoffs.size);
  }

  function resetBackoff(): void {
    backoffState = INITIAL_BACKOFF_STATE;
  }
  async function backoffSleep(retryAfterMs: number | null): Promise<void> {
    const result = nextBackoff(backoffState, { config: deps.backoff, retryAfterMs, rng });
    backoffState = result.nextState;
    deps.metrics?.inc(BACKOFF_SLEEP_METRIC, { bucket: backoffBucket(result.delayMs) });
    await sleep(result.delayMs);
  }
  async function cadenceSleep(retryAfterMs: number): Promise<void> {
    // Honor the server's no_work cadence but floor it identically to nextBackoff's
    // explicit branch: a retryAfterMs of 0 (the frozen schema permits it) can never
    // drive an immediate re-poll flood. Every honored delay stays in [floor, maxMs].
    const floor = Math.min(deps.backoff.baseMs, deps.backoff.maxMs);
    const delay = Math.max(Math.min(Math.max(retryAfterMs, 0), deps.backoff.maxMs), floor);
    deps.metrics?.inc(BACKOFF_SLEEP_METRIC, { bucket: backoffBucket(delay) });
    await sleep(delay);
  }

  function trackHandoff(offer: LeaseOfferV1, workloadClass: WorkloadClass): void {
    const settle = Promise.resolve(
      deps.supervisor.accept({ offer, leaseId: offer.leaseId, fenceToken: offer.fenceToken, workloadClass }),
    ).then(
      () => {},
      () => {},
    );
    activeHandoffs.add(settle);
    publishActiveLeases();
    void settle.finally(() => {
      deps.limiter.release(workloadClass);
      activeHandoffs.delete(settle);
      publishActiveLeases();
    });
  }

  async function handleOffer(
    session: WorkerSession,
    capacity: WorkerCapacity,
    offer: LeaseOfferV1,
  ): Promise<OfferHandling> {
    if (offer.workerId !== deps.self.report.workerId) {
      // A misdirected offer is never ACKed (no slot taken).
      emitPoll("incompatible");
      return { kind: "continue" };
    }
    if (!offerSatisfiesWorker(deps.self, capacity, offer)) {
      emitPoll("incompatible");
      return { kind: "continue" };
    }
    const workloadClass = offer.job.workloadType;
    if (!deps.limiter.tryAcquire(workloadClass)) {
      // The class saturated between the poll and the offer → advertise backpressure.
      emitPoll("backpressure");
      return { kind: "continue" };
    }

    const ack = await ackLease({
      client: deps.client,
      session,
      offer,
      key: deps.key,
      ...(deps.randomness ?? {}),
    });

    if (ack.kind === "acknowledged") {
      emitAck("acknowledged");
      trackHandoff(offer, workloadClass);
      emitPoll("handed_off");
      return { kind: "continue" };
    }
    // Every non-ack path releases the slot it just took.
    deps.limiter.release(workloadClass);
    if (ack.kind === "rejected") {
      emitAck("rejected");
      return { kind: "backoff", retryAfterMs: null };
    }
    if (ack.kind === "terminal") {
      if (ack.reason === "target_revoked") {
        emitAck("target_revoked");
        return { kind: "revoked" };
      }
      emitAck("unauthorized");
      return { kind: "recover" };
    }
    if (ack.kind === "transient") {
      emitAck(ack.label);
      return { kind: "backoff", retryAfterMs: ack.retryAfterMs };
    }
    emitAck("malformed");
    return { kind: "backoff", retryAfterMs: null };
  }

  async function drainInFlight(): Promise<void> {
    await Promise.allSettled([...activeHandoffs]);
  }

  async function run(): Promise<PollLoopStopReason> {
    resetBackoff();
    let stopReason: PollLoopStopReason | null = null;

    while (stopReason === null && !stopLeasingRequested) {
      let session: WorkerSession;
      try {
        session = await deps.session.get();
      } catch (err) {
        if (err instanceof SessionTerminalError) {
          emitPoll("reenrollment_required");
          stopReason = "reenrollment_required";
          break;
        }
        // A transient session error → back off and retry the acquisition.
        emitPoll("internal_unavailable");
        await backoffSleep(null);
        continue;
      }
      if (stopLeasingRequested) break;

      const capacity = deps.measure();
      publishCapacityGauges(capacity);

      const attempt = await pollOnce({
        client: deps.client,
        session,
        capacity,
        key: deps.key,
        ...(deps.randomness ?? {}),
      });

      if (attempt.kind === "offer") {
        // Drain-before-lease-stop: if shutdown began WHILE this poll was in flight,
        // DROP the offer un-ACKed. ACKing here would take a slot / add a handoff
        // AFTER drain() snapshotted the in-flight set, abandoning an ACKed lease at
        // exit. No slot taken, no leak — just stop.
        if (stopLeasingRequested || drainRequested) {
          emitPoll("offer_dropped");
          break;
        }
        // A poll that returned an offer is a successful poll → reset the recovery
        // spin counter.
        consecutiveRecoveries = 0;
        emitPoll("offer");
        const handling = await handleOffer(session, capacity, attempt.offer);
        if (handling.kind === "continue") {
          resetBackoff();
        } else if (handling.kind === "revoked") {
          emitPoll("target_revoked");
          stopReason = "target_revoked";
        } else if (handling.kind === "recover") {
          stopReason = await tryRecover();
        } else {
          await backoffSleep(handling.retryAfterMs);
        }
      } else if (attempt.kind === "no_work") {
        emitPoll("no_work");
        // A successful poll → reset the recovery spin counter.
        consecutiveRecoveries = 0;
        resetBackoff();
        await cadenceSleep(attempt.retryAfterMs);
      } else if (attempt.kind === "drain") {
        if (attempt.retryAfterMs === null) {
          // No hint = a TERMINAL drain (an operator drain, a rolling shutdown). Stop leasing and
          // let the loop exit; `run()` reports "drained".
          emitPoll("drain");
          drainRequested = true;
          stopLeasingRequested = true;
        } else {
          // REL-004 clause 3a — a hint makes the drain a REVERSIBLE PAUSE: finish in-flight work,
          // wait the server's cadence, then resume polling. The frozen protocol has always
          // modelled this (`retryAfterMs` is nullable on the drain outcome) and nothing read it,
          // so a kill switch could previously only be un-thrown by restarting every worker.
          //
          // `drainRequested`/`stopLeasingRequested` stay UNSET: this is not a stop, and setting
          // them would both exit the loop and make `run()` report a shutdown that did not happen.
          emitPoll("drain_paused");
          await drainInFlight();
          // A drain is a successful poll — the server answered. Reset the recovery spin counter
          // and the backoff so the resumed loop starts clean rather than inheriting a ladder.
          consecutiveRecoveries = 0;
          resetBackoff();
          await cadenceSleep(attempt.retryAfterMs);
        }
      } else if (attempt.kind === "terminal") {
        if (attempt.reason === "target_revoked") {
          emitPoll("target_revoked");
          stopReason = "target_revoked";
        } else {
          stopReason = await tryRecover();
        }
      } else if (attempt.kind === "transient") {
        emitPoll(attempt.label);
        await backoffSleep(attempt.retryAfterMs);
      } else {
        // protocol error (malformed / incompatible): surfaced, no offer leaked.
        emitPoll(attempt.label);
        await backoffSleep(null);
      }
    }

    await drainInFlight();
    return stopReason ?? (drainRequested ? "drained" : "stopped");
  }

  /** Recover the session after a poll/ack 401. Returns a terminal stop reason when
   * recovery is impossible, or null to continue the loop. */
  async function tryRecover(): Promise<PollLoopStopReason | null> {
    try {
      await deps.session.recover();
      consecutiveRecoveries += 1;
      if (consecutiveRecoveries >= MAX_CONSECUTIVE_RECOVERIES) {
        // The session keeps re-authenticating on enroll but is persistently
        // rejected on poll/ack; stop rather than spin recover→poll→recover with no
        // backoff. Surfaces the same terminal signal as a lapsed code route.
        emitPoll("reenrollment_required");
        return "reenrollment_required";
      }
      emitPoll("recovered");
      resetBackoff();
      return null;
    } catch (err) {
      if (err instanceof SessionTerminalError) {
        emitPoll("reenrollment_required");
        return "reenrollment_required";
      }
      // Transient recovery failure → back off and let the next cycle retry `get()`.
      await backoffSleep(null);
      return null;
    }
  }

  return {
    run,
    stopLeasing(): void {
      stopLeasingRequested = true;
    },
    drain(): Promise<void> {
      return drainInFlight();
    },
    activeLeaseCount(): number {
      return activeHandoffs.size;
    },
  };
}
