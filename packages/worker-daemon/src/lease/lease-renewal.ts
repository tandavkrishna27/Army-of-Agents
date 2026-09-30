/**
 * Per-lease renewal driver + local fence-close wiring (WRK-005).
 *
 * The driver DECORATES the WRK-004 supervisor seam: the poll loop hands each ACKed
 * lease to the driver (`accept`), which captures `offer.expiresAt` at handoff
 * (currently discarded after ACK), schedules a renewal at `expiresAt − leadMs`, and
 * delegates to the real supervisor. `poll-loop.ts` is UNTOUCHED — the driver IS a
 * `SupervisorSeam`, so it is composed in place of the bare supervisor and WRK-003/
 * WRK-004 stay green.
 *
 * Each real renewal builds a frozen `lease_renew` operation under a FRESH
 * `idempotencyKey`, signs a device proof over `client.leaseRenewPath(leaseId)`, and
 * POSTs it (audience `worker_run`). A transient timeout retries with the SAME key
 * (idempotent_retry) and never busy-spins; a `401` recovers via `session.recover()`
 * under `MAX_CONSECUTIVE_RECOVERIES`; a `rejected`/`stale_fence`/`target_revoked`/
 * `attempt_terminal`, a renew whose deadline lapses past `expiresAt`, or a
 * clock-skewed `expiresAt` already in the past is a LEASE LOSS. A `renewed` with
 * `cancelRequested` is a server-initiated cooperative cancel.
 *
 * On loss the driver CLOSES the fence-close proxy FIRST (defense-in-depth: every
 * governed effect is then denied locally), then escalates through the existing
 * `Supervisor.onLeaseLost` so cleanup converges through the distinct monotonic
 * `CleanupAuthority`. The worker holds no authority — the server `isActiveFence` is
 * the real gate; renewal only re-asserts a revocable grant and never resurrects a
 * lost one.
 *
 * **Bounded by session (E4-F007):** a lease cannot outlive its session today
 * (10-min code route < 15-min session; poll/ack don't slide it). WRK-005 renewal is
 * therefore session-bounded — a session-terminal condition forces loss (→
 * re-enrollment + orphan-output quarantine), never a session extension. The
 * sustained/long-job fix is E3/JOB-002 (E4-F007).
 *
 * Runtime imports: relative modules + the frozen protocol on the wire — the E4-D01
 * boundary.
 */

import { randomUUID } from "node:crypto";

import {
  leaseRenewOperationRequestV1Schema,
  leaseRenewOperationResponseV1Schema,
  protocolErrorV1Schema,
  type ControlCommandV1,
  type LeaseOfferV1,
  type LeaseRenewOperationRequestV1,
} from "@armyofagents/worker-protocol";

import type { DeviceKey } from "../identity/device-key.js";
import { signDeviceProof } from "../identity/device-proof.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import type { Logger } from "../logging/logger.js";
import {
  CONTROL_COMMAND_METRIC,
  FENCE_CLOSE_METRIC,
  LEASE_LOSS_METRIC,
  LEASE_RENEW_METRIC,
  type Metrics,
} from "../metrics/metrics.js";
import {
  ControlDeliveryMalformedError,
  OVERSIZED_FOR_RENEW_CHANNEL,
  classifyControlDelivery,
  controlCommandIsApplicable,
  createControlReceiverMemory,
  markControlCommandApplied,
  readControlCommandDelivery,
  type ControlCommandDelivery,
  type ControlReceiverMemory,
} from "./control-commands.js";
import { sendControlAck } from "./control-ack.js";
import {
  ControlPlaneTransportError,
  type ControlPlaneClient,
  type WorkerOperationHttpResponse,
} from "../transport/client.js";
import {
  SessionTerminalError,
  type LeaseHandoff,
  type OperationRandomness,
  type SessionProvider,
  type SupervisorSeam,
  type TransientLabel,
} from "../poll/poll-loop.js";
import type { EffectFence } from "../supervisor/effect-authority.js";
import type { EventDeliveryIdentity, WorkerEventSink } from "../supervisor/events.js";
import type { RunCanaryCoordinator } from "../supervisor/run-canaries.js";
import {
  FenceCloseProxy,
  type FenceCloseReason,
  type GovernedEffectAuthority,
} from "./fence-close-proxy.js";

// --- Single-operation renewal ------------------------------------------------

/** The classification of ONE renew round-trip (mirrors `AckAttempt`). */
export type RenewAttempt =
  | {
      readonly kind: "renewed";
      readonly expiresAt: string;
      readonly cancelRequested: boolean;
      readonly cancelReason: string | null;
      // JOB-015 — the parsed `dev.aoa.job/control-v1` delivery, or `null` when the
      // namespace is absent (a pre-JOB-015 server, or nothing queued). A PRESENT but
      // unreadable extension is a `protocol` attempt with code `control_malformed`, NOT
      // a `renewed` carrying `null`: a delivery fault must never wear the same shape as
      // an empty queue, which is the defect this ticket closes (D3).
      readonly control: ControlCommandDelivery | null;
      /**
       * JOB-015 / D3 — the control extension was PRESENT and could not be read.
       *
       * ★ This is `true` with `control: null`, and the pairing is the whole point: an
       * unreadable delivery must never wear the same shape as an empty queue. It is
       * counted `control_command{outcome="malformed"}` and logged, so "the server
       * addressed a command to this run and we could not read it" is observable — which
       * is the property this ticket exists to create.
       *
       * ★★ It is NOT a lease loss, and that is deliberate. The extension is
       * `critical:false`, and the frozen container's entire contract is that failing to
       * understand a non-critical extension must not break the run. Tearing the lease
       * down on an unparseable optional extension would make it effectively critical —
       * one bad server projection would kill every run in the fleet. The run keeps its
       * posture: the boolean floor still governs cancel, the command stays un-ACKed, and
       * the next renewal rebuilds and redelivers it.
       */
      readonly controlFault: boolean;
    }
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "terminal"; readonly reason: "unauthorized" | "target_revoked" }
  | { readonly kind: "transient"; readonly label: TransientLabel; readonly retryAfterMs: number | null }
  | { readonly kind: "protocol"; readonly label: "malformed"; readonly code: string };

export interface LeaseRenewRequestEnvelope {
  readonly request: LeaseRenewOperationRequestV1;
  readonly bytes: Buffer;
}

export interface BuildLeaseRenewRequestInput {
  readonly offer: LeaseOfferV1;
  readonly correlationId: string;
  readonly issuedAt: string;
  readonly nonce: string;
  readonly idempotencyKey: string;
  readonly observedAt: string;
}

/** Assemble + validate the lease-renew operation (audience `worker_run`); the body
 * echoes the leased identity and a fresh worker `observedAt`. The `leaseId` MUST
 * equal the URL param (by construction). */
export function buildLeaseRenewRequest(input: BuildLeaseRenewRequestInput): LeaseRenewRequestEnvelope {
  const request = leaseRenewOperationRequestV1Schema.parse({
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
      observedAt: input.observedAt,
    },
  });
  return { request, bytes: Buffer.from(JSON.stringify(request), "utf8") };
}

function defaultProofId(): string {
  return `prf_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}
function defaultNonce(): string {
  return randomUUID();
}

export interface RenewLeaseOnceDeps {
  readonly client: ControlPlaneClient;
  readonly session: WorkerSession;
  readonly offer: LeaseOfferV1;
  readonly key: DeviceKey;
  /** The idempotency key — CONTROLLED by the caller so a transient retry replays
   * the SAME key (idempotent_retry) and a new interval mints a fresh one. */
  readonly idempotencyKey: string;
  readonly now?: () => number;
  readonly newCorrelationId?: () => string;
  readonly newProofId?: () => string;
  readonly newNonce?: () => string;
}

/**
 * Perform ONE renew: build + sign (over `leaseRenewPath(leaseId)` + exact bytes) +
 * POST, then classify. A transport failure maps to a transient outcome (never
 * throws), exactly like `ackLease`.
 */
export async function renewLeaseOnce(deps: RenewLeaseOnceDeps): Promise<RenewAttempt> {
  const now = deps.now ?? (() => Date.now());
  const leaseId = deps.offer.leaseId;
  const correlationId = (deps.newCorrelationId ?? randomUUID)();
  const nonce = (deps.newNonce ?? defaultNonce)();
  const envelope = buildLeaseRenewRequest({
    offer: deps.offer,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    nonce,
    idempotencyKey: deps.idempotencyKey,
    observedAt: new Date(now()).toISOString(),
  });
  const proof = signDeviceProof({
    method: "POST",
    path: deps.client.leaseRenewPath(leaseId),
    rawBody: envelope.bytes,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    proofId: (deps.newProofId ?? defaultProofId)(),
    key: deps.key,
  });

  let response: WorkerOperationHttpResponse;
  try {
    response = await deps.client.leaseRenew(leaseId, {
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
  return classifyRenewResponse(response);
}

function classifyRenewResponse(response: WorkerOperationHttpResponse): RenewAttempt {
  if (response.status === 200) {
    const parsed = leaseRenewOperationResponseV1Schema.safeParse(response.body);
    if (!parsed.success) return { kind: "protocol", label: "malformed", code: "malformed" };
    if (parsed.data.outcome === "renewed") {
      let control: ControlCommandDelivery | null = null;
      let controlFault = false;
      try {
        control = readControlCommandDelivery(parsed.data.body.extensions);
      } catch (err) {
        // ★ D3 — the fail-closed DIRECTION is "never silently 'no commands'", not "kill
        // the lease". The extension was addressed to this run and could not be read; that
        // is reported as a distinct fault (counted + logged, and the commands are NOT
        // applied), while the renewal itself succeeds. See `controlFault` above for why a
        // `critical:false` extension must not be able to terminate a run.
        if (!(err instanceof ControlDeliveryMalformedError)) throw err;
        controlFault = true;
      }
      return {
        kind: "renewed",
        expiresAt: parsed.data.body.expiresAt,
        cancelRequested: parsed.data.body.cancelRequested,
        cancelReason: parsed.data.body.cancelReason,
        control,
        controlFault,
      };
    }
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
  // malformed / stale_fence / attempt_terminal / other: a terminal lease loss.
  return { kind: "protocol", label: "malformed", code: code ?? `http_${response.status}` };
}

// --- Injectable timer schedule -----------------------------------------------

export interface RenewalTimer {
  readonly id: number;
}

/** The injectable timer surface the driver drives (tests substitute a fake clock).
 * `sleep` is the transient-retry wait; `setTimer`/`clearTimer` schedule renewals. */
export interface RenewalSchedule {
  now(): number;
  setTimer(fn: () => void | Promise<void>, delayMs: number): RenewalTimer;
  clearTimer(timer: RenewalTimer): void;
  sleep(ms: number): Promise<void>;
}

/** The default real-time schedule (node timers + `Date.now`). */
export function createRealRenewalSchedule(): RenewalSchedule {
  let seq = 0;
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    now: () => Date.now(),
    setTimer(fn, delayMs): RenewalTimer {
      const id = (seq += 1);
      handles.set(
        id,
        setTimeout(() => {
          handles.delete(id);
          void fn();
        }, Math.max(0, delayMs)),
      );
      return { id };
    },
    clearTimer(timer): void {
      const h = handles.get(timer.id);
      if (h !== undefined) {
        clearTimeout(h);
        handles.delete(timer.id);
      }
    },
    sleep(ms): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
    },
  };
}

// --- The renewal driver ------------------------------------------------------

/** The supervisor the driver decorates — the real WRK-004 `Supervisor` satisfies
 * this (it extends `SupervisorSeam` and exposes `cancel`/`onLeaseLost`). */
export interface RenewalSupervisor extends SupervisorSeam {
  cancel(leaseId: string, reason?: string): Promise<void> | void;
  onLeaseLost(leaseId: string): Promise<void> | void;
}

/** The worker's stable identity (bound once — not carried per handoff). */
export interface RenewalIdentity {
  readonly targetId: string;
  readonly deviceGeneration: number;
}

/** Renewal-timing tuning. `leadMs` is derived from the offered window unless
 * overridden; the timer fires `leadMs` BEFORE expiry, clamped so the delay stays
 * inside `[skewMargin, window]`. */
export interface RenewalTuning {
  readonly leadMs?: number;
  readonly leadFraction?: number;
  readonly leadMinMs?: number;
  readonly leadMaxMs?: number;
  readonly skewMarginMs?: number;
  readonly retryFloorMs?: number;
}

export interface LeaseRenewalDriverDeps extends OperationRandomness {
  readonly client: ControlPlaneClient;
  readonly session: SessionProvider;
  readonly key: DeviceKey;
  readonly identity: RenewalIdentity;
  readonly supervisor: RenewalSupervisor;
  readonly schedule: RenewalSchedule;
  readonly tuning?: RenewalTuning;
  readonly metrics?: Metrics;
  readonly logger?: Logger;
  readonly maxConsecutiveRecoveries?: number;
  /** The sink a post-close governed-egress denial emits `network_denied` into. */
  readonly eventSink?: WorkerEventSink;
  /** Factory for the per-lease fence-close proxy (tests inject a spy). */
  readonly makeFenceProxy?: (fence: EffectFence, identity: EventDeliveryIdentity) => GovernedEffectAuthority;
  /**
   * DAT-008 slice 5 — the per-lease canary coordinator shared with the supervisor. When present the
   * proxy captures the lease's LIVE canary array, which the supervisor seeds (before create) with
   * the run's redeemed secret values — so the proxy's `network_denied` stream is scrubbed of them
   * too (uniform redaction). Absent = `[]` (the historical state; nothing to redact).
   */
  readonly canaryCoordinator?: RunCanaryCoordinator;
  /**
   * JOB-015 — the appliers for delivered control commands.
   *
   * ★ A THUNK, not a value, and that is the whole point. The poll loop that owns
   * `stopLeasing()` is composed AFTER this driver (the driver IS the loop's supervisor
   * seam), so a handler passed by value at construction would capture `undefined` and
   * every delivered `drain` would silently do nothing — a composition-root port that is
   * a NO-OP for everything built earlier. Resolving lazily, at the moment a command
   * arrives, is what makes the wiring real.
   *
   * ★★ ABSENT = NOT DELIVERED, AND IT IS NOT ACKED. A command with no applier is left
   * `ack_status IS NULL` so the server redelivers it on the next renewal; it is counted
   * `control_command{outcome="unhandled"}` rather than quietly consumed. ACKing an
   * unapplied command would clear it forever and make "was persisted, surfaced, and
   * never acted on" — the exact defect JOB-015 was filed for — invisible one layer up.
   */
  readonly controlHandlers?: () => ControlCommandHandlers | undefined;
}

/** JOB-015 — what a worker can DO with a delivered control command. Inclusion in a
 * payload is not delivery; an entry here is. */
export interface ControlCommandHandlers {
  /** Apply `drain`: stop accepting new leases, finish the in-flight attempt. */
  drain?(reason: string | null): void | Promise<void>;
  /** Apply a resolved governance decision (`product_approval_result` /
   * `runtime_decision_result`). NOT composed by the daemon today — E8/BRW-004 owns the
   * browser-side applier and E9/SVC-001 the service-side one. Until one is composed
   * those kinds are counted `unhandled` and stay pending, which is the honest state. */
  result?(command: ControlCommandV1): void | Promise<void>;
}

export interface LeaseRenewalDriver extends SupervisorSeam {
  accept(handoff: LeaseHandoff): Promise<void>;
  /** Stop all renewal timers (idempotent). Shutdown step `renewal-stop`. */
  stop(): void;
  /** Leases with a live (non-terminated) renewal. */
  activeRenewalCount(): number;
  /** The fence-close proxy bound to `leaseId` (governed effects route through it). */
  proxyFor(leaseId: string): GovernedEffectAuthority | undefined;
}

/** How the driver observed the lease liveness (drives both metrics). */
interface LossClassification {
  readonly loss: string; // `lease_loss{reason}` token
  readonly fence: FenceCloseReason; // `fence_close{reason}` on the proxy
}

interface LeaseState {
  readonly leaseId: string;
  readonly offer: LeaseOfferV1;
  readonly proxy: GovernedEffectAuthority;
  expiresAtMs: number;
  leadMs: number;
  timer: RenewalTimer | null;
  terminated: boolean;
  // The consecutive-401-recovery bound is PER-LEASE: the driver fans out into N
  // concurrent per-lease renewal loops sharing ONE SessionProvider, so a driver-global
  // counter would let a token rotation that 401s several leases at once corrupt each
  // other's cap (a healthy lease prematurely declared lost, or a stuck lease never capped).
  recoveries: number;
  /** JOB-015 — this lease's control-command receiver memory (observed-through
   * sequence, per-id priors for replay/conflict, and what was actually applied). */
  readonly controlMemory: ControlReceiverMemory;
  /** JOB-015 — an apply/ACK pass is in flight for this lease. The next renewal is now
   * armed BEFORE the apply (see `driveRenewalInner`), so a slow ACK cannot strand the
   * lease — but that also means the renewal timer can fire while a pass is still
   * running. Two concurrent passes would share `controlMemory` and could apply the same
   * un-ACKed command twice, so the second pass is skipped: nothing was ACKed, the rows
   * stay pending, and the next renewal redelivers them. */
  controlApplying: boolean;
}

const NOOP_SINK: WorkerEventSink = { emit: () => {} };

export function createLeaseRenewalDriver(deps: LeaseRenewalDriverDeps): LeaseRenewalDriver {
  const schedule = deps.schedule;
  const tuning = deps.tuning ?? {};
  const leadFraction = tuning.leadFraction ?? 0.5;
  const leadMinMs = tuning.leadMinMs ?? 1_000;
  const leadMaxMs = tuning.leadMaxMs ?? 300_000;
  const skewMarginMs = tuning.skewMarginMs ?? 1_000;
  const retryFloorMs = tuning.retryFloorMs ?? 1_000;
  const maxConsecutiveRecoveries = deps.maxConsecutiveRecoveries ?? 3;
  const newIdempotencyKey = deps.newIdempotencyKey ?? randomUUID;

  const makeProxy =
    deps.makeFenceProxy ??
    ((fence: EffectFence, identity: EventDeliveryIdentity): GovernedEffectAuthority =>
      new FenceCloseProxy({
        fence,
        identity,
        eventSink: deps.eventSink ?? NOOP_SINK,
        metrics: deps.metrics,
        // ★ DAT-008 slice 5 — the seam is closed. When a coordinator is present the proxy captures
        // this lease's LIVE canary array; the supervisor `push`es the run's redeemed secret values
        // into that same array BEFORE create (before any emit on either stream), so the proxy's
        // post-close `network_denied` stream is scrubbed of them too — uniform redaction across
        // every sink. Absent (unit/non-driver builds) → `[]`, the honest historical state: nothing
        // redeems a value there, so there is nothing to redact.
        redactionCanaries: deps.canaryCoordinator ? deps.canaryCoordinator.ensure(fence.leaseId) : [],
      }));

  const leases = new Map<string, LeaseState>();
  let stopped = false;

  const emitRenew = (outcome: string): void => deps.metrics?.inc(LEASE_RENEW_METRIC, { outcome });
  const emitLoss = (reason: string): void => deps.metrics?.inc(LEASE_LOSS_METRIC, { reason });

  function computeLeadMs(expiresAtMs: number, nowMs: number): number {
    const window = Math.max(0, expiresAtMs - nowMs);
    let lead = tuning.leadMs ?? Math.round(window * leadFraction);
    // Keep the delay non-negative and at least the skew margin below expiry.
    const maxLead = Math.max(0, window - skewMarginMs);
    if (lead > maxLead) lead = maxLead;
    if (lead > leadMaxMs) lead = leadMaxMs;
    if (lead < leadMinMs && leadMinMs <= maxLead) lead = leadMinMs;
    if (lead < 0) lead = 0;
    return lead;
  }

  function reschedule(state: LeaseState): void {
    if (stopped || state.terminated) return;
    if (state.timer !== null) {
      schedule.clearTimer(state.timer);
      state.timer = null;
    }
    const fireAt = state.expiresAtMs - state.leadMs;
    const delay = Math.max(0, fireAt - schedule.now());
    state.timer = schedule.setTimer(() => driveRenewal(state), delay);
  }

  function clearTimer(state: LeaseState): void {
    if (state.timer !== null) {
      schedule.clearTimer(state.timer);
      state.timer = null;
    }
  }

  async function declareLoss(state: LeaseState, cls: LossClassification): Promise<void> {
    if (state.terminated) return;
    state.terminated = true;
    clearTimer(state);
    // Close the fence FIRST (defense in depth), THEN escalate cleanup.
    state.proxy.close(cls.fence);
    emitLoss(cls.loss);
    deps.logger?.info({ leaseId: state.leaseId, reason: cls.loss }, "lease-renewal: lease loss");
    await Promise.resolve(deps.supervisor.onLeaseLost(state.leaseId));
  }

  const emitControl = (outcome: string): void =>
    deps.metrics?.inc(CONTROL_COMMAND_METRIC, { outcome });

  /** Best-effort ACK. A failure leaves `ack_status IS NULL`, so the command is
   * redelivered on the next renewal and the local `applied` set stops a second
   * application. An ACK that does not land is a DELAY, never a lost command — which is
   * why it must not be allowed to kill a healthy lease. */
  async function ackControl(
    state: LeaseState,
    session: WorkerSession,
    commandId: string,
    commandSeq: number,
    status: "completed" | "rejected",
    detail: string | null,
  ): Promise<void> {
    try {
      const outcome = await sendControlAck({
        client: deps.client,
        session,
        offer: state.offer,
        key: deps.key,
        commandId,
        commandSeq,
        status,
        detail,
        now: deps.now,
        newCorrelationId: deps.newCorrelationId,
        newProofId: deps.newProofId,
        newNonce: deps.newNonce,
      });
      if (outcome.kind !== "sent" || !outcome.applied) {
        deps.logger?.warn(
          { leaseId: state.leaseId, commandSeq, outcome: outcome.kind },
          "lease-renewal: control ACK did not land; command stays pending",
        );
      }
    } catch (err) {
      deps.logger?.warn(
        { leaseId: state.leaseId, commandSeq, error: err instanceof Error ? err.name : "unknown" },
        "lease-renewal: control ACK threw; command stays pending",
      );
    }
  }

  /**
   * JOB-015 — APPLY the delivered control commands, then ACK exactly what was applied.
   *
   * ★ THE ACCEPTANCE BAR IS THE APPLIER, NOT THE PAYLOAD. A command that reaches this
   * function and finds no handler is counted `unhandled` and left un-ACKed. It is NOT
   * consumed, because consuming it would reproduce this ticket's own finding — persisted,
   * surfaced, never acted on — with a green test to hide it.
   *
   * ★★ THE OVERSIZED-LEADING TERMINAL RUNS FIRST. A leading command that cannot ride the
   * channel is ACKed `rejected` / `oversized_for_renew_channel` — a frozen ACK status, no
   * wire change — which clears `ack_status` and lets the command BEHIND it be delivered on
   * the next renewal. Without this the projection would return the same marker forever:
   * nothing to apply, nothing to ACK, no terminal (the E7-F010 shape).
   *
   * Wrapped so a fault in this path can never strand a healthy lease: the run keeps its
   * renewal, the command keeps its pending row, and the next renewal retries.
   *
   * ★★★ THIS RUNS *AFTER* THE NEXT RENEWAL IS ARMED, and it has to. Every applied or
   * oversized command performs a SEQUENTIAL awaited `sendControlAck` at the frozen
   * `control_command` descriptor's 15 s timeout, up to
   * `CONTROL_EXTENSION_MAX_COMMANDS` = 16 per delivery — 240 s of worst-case blocking.
   * Against the 300 s default lease renewing at 50 % lead there are only ~150 s of
   * headroom, so roughly eleven slow (not failed) ACKs awaited BEFORE `reschedule`
   * would push the next renewal past expiry and lose a healthy lease. That directly
   * contradicts `ackControl`'s own contract — "an ACK that does not land is a DELAY,
   * never a lost command, which is why it must not be allowed to kill a healthy lease"
   * — and no test could have caught it, because the fake control plane answered every
   * ACK synchronously. The renewal timer is armed off `expiresAtMs`, not off "now", so
   * arming it first costs nothing and removes the coupling entirely.
   *
   * The cost of that ordering is that the timer CAN fire mid-pass, so a pass is
   * skipped while another is in flight (`state.controlApplying`): two passes share
   * `controlMemory` and the second would see the first's commands still un-marked and
   * apply them twice. Skipping ACKs nothing, so the rows stay pending and the pass
   * after it redelivers them — the same fail-safe direction as every other refusal here.
   */
  async function applyControlDelivery(
    state: LeaseState,
    session: WorkerSession,
    delivery: ControlCommandDelivery,
  ): Promise<void> {
    if (state.controlApplying) {
      emitControl("deferred");
      deps.logger?.warn(
        { leaseId: state.leaseId },
        "lease-renewal: a control-delivery pass is already in flight; commands stay pending",
      );
      return;
    }
    state.controlApplying = true;
    try {
      if (delivery.oversizedLeading) {
        emitControl("oversized");
        deps.logger?.warn(
          { leaseId: state.leaseId, commandSeq: delivery.oversizedLeading.commandSeq },
          "lease-renewal: control command too large for the renew channel; rejecting to unblock the queue",
        );
        await ackControl(
          state,
          session,
          delivery.oversizedLeading.commandId,
          delivery.oversizedLeading.commandSeq,
          "rejected",
          OVERSIZED_FOR_RENEW_CHANNEL,
        );
      }

      const handlers = deps.controlHandlers?.();
      const classified = classifyControlDelivery(
        state.controlMemory,
        delivery,
        String(state.offer.fenceToken),
      );
      for (const entry of classified) {
        if (!controlCommandIsApplicable(entry)) {
          // `gap` / `conflict` / `stale` are REFUSALS with distinct counters; an
          // already-applied `replay` is a no-op. None of them ACK, so a refused command
          // stays pending and a later renewal can reclassify it.
          emitControl(entry.decision === "replay" ? "deferred" : entry.decision);
          continue;
        }
        const command = entry.command;
        const applied = await applyOneControlCommand(handlers, command);
        if (!applied) {
          emitControl("unhandled");
          continue;
        }
        markControlCommandApplied(state.controlMemory, command.commandId);
        emitControl("applied");
        await ackControl(state, session, command.commandId, command.commandSeq, "completed", null);
      }
    } catch (err) {
      emitControl("deferred");
      deps.logger?.warn(
        { leaseId: state.leaseId, error: err instanceof Error ? err.name : "unknown" },
        "lease-renewal: control delivery could not be applied; commands stay pending",
      );
    } finally {
      state.controlApplying = false;
    }
  }

  /** Dispatch ONE command to its applier. Returns false when nothing applied it — an
   * unhandled kind, or a handler that threw. Both leave the command pending. */
  async function applyOneControlCommand(
    handlers: ControlCommandHandlers | undefined,
    command: ControlCommandV1,
  ): Promise<boolean> {
    try {
      if (command.commandKind === "drain") {
        if (!handlers?.drain) return false;
        await Promise.resolve(handlers.drain(command.reason));
        return true;
      }
      if (command.commandKind === "product_approval_result" || command.commandKind === "runtime_decision_result") {
        if (!handlers?.result) return false;
        await Promise.resolve(handlers.result(command));
        return true;
      }
      // `cancel` / `graceful_stop` are owned by the boolean floor above and never reach
      // here on a live cancel; `checkpoint` cannot be persisted at all (the schema CHECK
      // omits it — SVC-004 owns that gap). Neither is applied here, and neither is ACKed.
      return false;
    } catch (err) {
      deps.logger?.warn(
        { commandSeq: command.commandSeq, error: err instanceof Error ? err.name : "unknown" },
        "lease-renewal: control-command handler threw; command stays pending",
      );
      return false;
    }
  }

  async function cooperativeCancel(state: LeaseState, reason: string): Promise<void> {
    if (state.terminated) return;
    state.terminated = true;
    clearTimer(state);
    state.proxy.close("cancel_requested");
    deps.logger?.info({ leaseId: state.leaseId, reason: "cancel_requested" }, "lease-renewal: server-ordered cancel");
    await Promise.resolve(deps.supervisor.cancel(state.leaseId, reason));
  }

  function completeLease(state: LeaseState): void {
    if (!state.terminated) {
      state.terminated = true;
      clearTimer(state);
      // Normal completion: the fence is done — close it terminally.
      state.proxy.close("completed");
    }
    leases.delete(state.leaseId);
    // DAT-008 slice 5 — drop the lease's coordinator entry so the map cannot grow without bound.
    // The proxy still holds its captured array reference, so this never un-seeds a live proxy.
    deps.canaryCoordinator?.release(state.leaseId);
  }

  /** Recover the session after a renew 401. Returns `ok` to retry the SAME key,
   * `capped` when the recover spin bound trips, or `terminal` when re-enrollment
   * is required (or recovery is otherwise impossible). */
  async function tryRecover(state: LeaseState): Promise<"ok" | "capped" | "terminal"> {
    try {
      await deps.session.recover();
    } catch (err) {
      if (err instanceof SessionTerminalError) return "terminal";
      return "terminal"; // an unrecoverable renew — fail closed to loss
    }
    state.recoveries += 1;
    if (state.recoveries >= maxConsecutiveRecoveries) return "capped";
    return "ok";
  }

  async function driveRenewal(state: LeaseState): Promise<void> {
    // The renewal timer is fire-and-forget (`void fn()`), so an UNEXPECTED throw from the
    // renew flow (e.g. a mid-body-stream network error surfaced by `response.text()`, a
    // device-proof signing failure, or a schema parse error) would otherwise become an
    // unhandled rejection: the lease would be neither renewed nor declared lost, leaving the
    // fence-close proxy OPEN (defense-in-depth defeated) and the supervisor un-escalated.
    // Fail closed — any unclassified failure is treated as lease loss.
    try {
      await driveRenewalInner(state);
    } catch (err) {
      deps.logger?.error(
        { leaseId: state.leaseId, err },
        "lease-renewal: unexpected renewal failure; declaring lease loss",
      );
      if (!state.terminated) {
        await declareLoss(state, { loss: "reenrollment_required", fence: "lease_lost" }).catch(
          (lossErr) =>
            deps.logger?.error(
              { leaseId: state.leaseId, err: lossErr },
              "lease-renewal: declareLoss failed after unexpected renewal failure",
            ),
        );
      }
    }
  }

  async function driveRenewalInner(state: LeaseState): Promise<void> {
    if (stopped || state.terminated) return;
    // Pre-POST monotonic expiry check: a late timer (sleep/resume) never trusts a
    // later renew — the worker's `observedAt` cannot authorize expiry.
    if (schedule.now() >= state.expiresAtMs) {
      await declareLoss(state, { loss: "deadline_lapse", fence: "deadline_lapse" });
      return;
    }
    // ONE fresh idempotency key per REAL renewal interval; transient retries reuse
    // it so a replay never double-extends.
    const idempotencyKey = newIdempotencyKey();

    while (!stopped && !state.terminated) {
      let session: WorkerSession;
      try {
        session = await deps.session.get();
      } catch (err) {
        if (err instanceof SessionTerminalError) {
          await declareLoss(state, { loss: "reenrollment_required", fence: "lease_lost" });
          return;
        }
        // A transient session error → fail closed to loss (a lease we cannot
        // renew is lost; the supervisor cleanup path reclaims it).
        await declareLoss(state, { loss: "reenrollment_required", fence: "lease_lost" });
        return;
      }
      if (state.terminated) return;

      const attempt = await renewLeaseOnce({
        client: deps.client,
        session,
        offer: state.offer,
        key: deps.key,
        idempotencyKey,
        now: deps.now,
        newCorrelationId: deps.newCorrelationId,
        newProofId: deps.newProofId,
        newNonce: deps.newNonce,
      });
      if (state.terminated) return;

      if (attempt.kind === "renewed") {
        emitRenew("renewed");
        const newExpiryMs = Date.parse(attempt.expiresAt);
        if (!Number.isFinite(newExpiryMs) || newExpiryMs <= schedule.now()) {
          // Clock skew: the server's fresh expiry is already in the past.
          await declareLoss(state, { loss: "clock_skew", fence: "clock_skew" });
          return;
        }
        state.expiresAtMs = newExpiryMs;
        state.leadMs = computeLeadMs(state.expiresAtMs, schedule.now());
        state.recoveries = 0;
        if (attempt.cancelRequested) {
          // D2 — the boolean FLOOR, unchanged and permanent. It is the only signal a
          // worker that predates the extension understands, so cancel/graceful_stop are
          // delivered TWICE to an adopting worker and the boolean short-circuits first.
          // A pending drain or governance result behind a cancel is moot: the run ends.
          emitRenew("cancel_requested");
          await cooperativeCancel(state, attempt.cancelReason ?? "cancel_requested");
          return;
        }
        if (attempt.controlFault) {
          // Loud, and distinguishable from an empty queue. The commands stay pending.
          emitControl("malformed");
          deps.logger?.warn(
            { leaseId: state.leaseId },
            "lease-renewal: the control-command extension could not be read; commands stay pending",
          );
        }
        if (state.terminated) return;
        // ★★★ ARM THE NEXT RENEWAL FIRST. The apply pass below performs up to 16
        // sequential awaited ACKs at the frozen 15 s `control_command` timeout (240 s)
        // against ~150 s of lease headroom, so awaiting it before this line would let a
        // SLOW control plane strand a healthy lease — the opposite of what
        // `ackControl`'s "best-effort, never a lease loss" contract promises. The timer
        // fires off `expiresAtMs`, so arming it here schedules exactly the same instant.
        reschedule(state);
        if (!attempt.controlFault && attempt.control) {
          await applyControlDelivery(state, session, attempt.control);
        }
        return;
      }
      if (attempt.kind === "rejected" || attempt.kind === "protocol") {
        emitRenew("rejected");
        await declareLoss(state, { loss: "rejected", fence: "lease_lost" });
        return;
      }
      if (attempt.kind === "terminal") {
        if (attempt.reason === "target_revoked") {
          emitRenew("target_revoked");
          await declareLoss(state, { loss: "target_revoked", fence: "lease_lost" });
          return;
        }
        // unauthorized → recover under the cap; retry the SAME key on success.
        emitRenew("unauthorized");
        const recovery = await tryRecover(state);
        if (recovery === "ok") continue;
        await declareLoss(state, { loss: "reenrollment_required", fence: "lease_lost" });
        return;
      }
      // transient — retry the SAME key after a bounded wait; the lease deadline
      // caps the retries (a renew that keeps timing out past expiry is a loss).
      emitRenew(attempt.label);
      if (schedule.now() >= state.expiresAtMs) {
        await declareLoss(state, { loss: "deadline_lapse", fence: "deadline_lapse" });
        return;
      }
      const wait = Math.max(retryFloorMs, attempt.retryAfterMs ?? retryFloorMs);
      await schedule.sleep(wait);
      if (stopped || state.terminated) return;
      if (schedule.now() >= state.expiresAtMs) {
        await declareLoss(state, { loss: "deadline_lapse", fence: "deadline_lapse" });
        return;
      }
    }
  }

  function registerLease(handoff: LeaseHandoff): LeaseState {
    const fence: EffectFence = {
      jobId: String(handoff.offer.job.jobId),
      attempt: handoff.offer.job.attempt,
      leaseId: handoff.leaseId,
      fenceToken: String(handoff.fenceToken),
      deviceGeneration: deps.identity.deviceGeneration,
      observedSeq: 0,
    };
    const eventIdentity: EventDeliveryIdentity = {
      organizationId: String(handoff.offer.job.organizationId),
      companyId: String(handoff.offer.job.companyId),
      workerId: String(handoff.offer.workerId),
      jobId: String(handoff.offer.job.jobId),
      attempt: handoff.offer.job.attempt,
      leaseId: handoff.leaseId,
      fenceToken: String(handoff.fenceToken),
    };
    const proxy = makeProxy(fence, eventIdentity);
    const expiresAtMs = Date.parse(handoff.offer.expiresAt);
    const state: LeaseState = {
      leaseId: handoff.leaseId,
      offer: handoff.offer,
      proxy,
      expiresAtMs,
      leadMs: computeLeadMs(expiresAtMs, schedule.now()),
      timer: null,
      terminated: false,
      recoveries: 0,
      controlMemory: createControlReceiverMemory(),
      controlApplying: false,
    };
    leases.set(handoff.leaseId, state);
    reschedule(state);
    return state;
  }

  return {
    accept(handoff: LeaseHandoff): Promise<void> {
      const state = registerLease(handoff);
      const settle = Promise.resolve<void>(deps.supervisor.accept(handoff) as void | Promise<void>);
      // Stop this lease's renewal when the run settles (success OR failure). A
      // swallowed copy runs the finally regardless; the delegate promise is what
      // the loop treats as the in-flight lifetime.
      void settle.then(
        () => {},
        () => {},
      ).finally(() => completeLease(state));
      return settle;
    },
    stop(): void {
      stopped = true;
      for (const state of leases.values()) clearTimer(state);
    },
    activeRenewalCount(): number {
      // Leases with a LIVE renewal timer (not terminated, not stopped).
      let count = 0;
      for (const state of leases.values()) if (!state.terminated && state.timer !== null) count += 1;
      return count;
    },
    proxyFor(leaseId: string): GovernedEffectAuthority | undefined {
      return leases.get(leaseId)?.proxy;
    },
  };
}
