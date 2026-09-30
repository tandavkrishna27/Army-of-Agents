/**
 * `Supervisor` — the sandbox lifecycle orchestrator (WRK-004).
 *
 * It is the real implementation behind the WRK-003 `SupervisorSeam`: the poll
 * loop hands it an ACKed lease (`accept`) and it drives the whole run INSIDE a
 * provider sandbox — never in the worker process:
 *
 *   create → attempt_started → execute (in sandbox) → terminal → destroy
 *
 * under the EFFECT authority (the happy path). Abnormal paths — a hung create, a
 * cancel, a lease loss, or shutdown — WITHDRAW effect authority and route through
 * the DISTINCT, monotonic CleanupAuthority, which can only cancel → kill →
 * destroy (escalating on non-compliance) and read a redacted projection. The
 * escalation reclaims the whole process tree.
 *
 * Every sandbox identity + provider op id is attached to the emitted events, the
 * structured logs, and the cleanup records; resource labels are HASHED before
 * they enter any log or metric.
 *
 * Runtime imports: relative modules + the frozen protocol type carried on the
 * handoff — the E4-D01 boundary.
 */

import { randomUUID } from "node:crypto";

import type { LogPayloadV1, ProgressPayloadV1, UsagePayloadV1 } from "@armyofagents/worker-protocol";

import type { LeaseHandoff, SupervisorSeam } from "../poll/poll-loop.js";
import type { Logger } from "../logging/logger.js";
import {
  CLEANUP_ESCALATION_METRIC,
  CLEANUP_OUTCOME_METRIC,
  SANDBOX_OP_METRIC,
  type Metrics,
} from "../metrics/metrics.js";
import { CleanupAuthority, ResourceNotAvailableError } from "./cleanup-authority.js";
import { EffectAuthority, type EffectFence } from "./effect-authority.js";
import { EventSequencer, type EventDeliveryIdentity, type WorkerEventSink } from "./events.js";
import { createNoopProvider } from "./noop-provider.js";
import {
  hashResourceLabels,
  type CreateSandboxSpec,
  type ExecuteResult,
  type ProviderOpContext,
  type ResourceLabels,
  type SandboxProvider,
  type StagedFileRequest,
} from "./provider.js";
import type { RunCanaryCoordinator } from "./run-canaries.js";
import {
  parseServiceWorkload,
  runServiceLifecycle,
  SERVICE_HEALTH_TICK_MS_DEFAULT,
  type ServiceStopHandle,
} from "./service-lifecycle.js";
import { RUN_TEARDOWN_HEADROOM_MS } from "../lifecycle/run-op-deadline.js";
import type { OwnedLabelsCapabilityLike } from "../lease/owned-labels-capability.js";

/** CLI-003/D3 — a captured stdout/stderr/system log line to turn into a `log` event. */
export interface RunObservationLogEntry {
  readonly stream: LogPayloadV1["stream"];
  readonly level?: LogPayloadV1["level"];
  readonly message: string;
}

/** CLI-003/D3 — a progress tick to turn into a `progress` event. */
export interface RunObservationProgressEntry {
  readonly message: string;
  readonly percent: ProgressPayloadV1["percent"];
}

/**
 * CLI-003/D3+D5 — the bounded observation captured from a completed sandbox run:
 * log output (stdout/stderr/system), progress ticks, and EVIDENTIARY-ONLY usage.
 * In the wired world this is populated from the D1 transport streaming callbacks +
 * the adapter's token/runtime accounting; the live population channel is the inert
 * E4-D12 seam, so CLI-003 wires the seam + unit-tests it. Usage never carries a
 * price — JOB-012 prices server-side.
 */
export interface RunObservation {
  readonly logs?: readonly RunObservationLogEntry[];
  readonly progress?: readonly RunObservationProgressEntry[];
  readonly usage?: UsagePayloadV1 | null;
}

/** The max number of captured `log` events a single run may emit, leaving headroom
 * under the frozen 500-event batch cap for attempt_started/progress/usage/terminal.
 * Envelope-level (≤500-event / ≤3.75 MiB) batching itself is the durable sink's job. */
const MAX_LOG_EVENTS = 480;

/** The worker's stable identity (targetId + deviceGeneration) — not carried on a
 * per-lease handoff, so it is bound once at supervisor construction. */
export interface WorkerSupervisionIdentity {
  readonly targetId: string;
  readonly deviceGeneration: number;
}

export interface SupervisorDeps {
  /**
   * The DESKTOP/in-process provider (the `E2bSandboxProvider` on the self-hosted lane).
   * OPTIONAL since DEP-011 Slice 2a: a CONTAINER worker instead injects `makeRunProvider`
   * (a per-run networked driver factory) — exactly ONE of `provider`/`makeRunProvider`
   * may be set, and `!provider && !makeRunProvider` is a `no_provider` refusal upstream
   * (`compose-dispatch.ts`). Fail-fast at construction if both are present.
   */
  readonly provider?: SandboxProvider;
  /**
   * DEP-011 Slice 2a — the PER-RUN networked provider FACTORY (a TYPE here; the impl comes
   * from the OUTSIDE composition root, DEP-011 Slice 2b). The capability does not exist at
   * `buildRun`, so the container branch builds NO-OP null-object authorities there and REBUILDS
   * the real authorities over `makeRunProvider({handoff, capability})` INSIDE `runLifecycle`
   * AFTER redemption. SYNC (no `await` between the two authority reassignments — §2a.3). REQUIRES
   * `materializeRunSecrets` (the rebuild only runs inside its block) — fail-fast pairing them.
   */
  readonly makeRunProvider?: (input: { handoff: LeaseHandoff; capability?: OwnedLabelsCapabilityLike }) => SandboxProvider;
  readonly identity: WorkerSupervisionIdentity;
  readonly eventSink: WorkerEventSink;
  readonly metrics?: Metrics;
  readonly logger?: Logger;
  /** ms clock (default `Date.now`). */
  readonly now?: () => number;
  /** ISO clock for event `occurredAt` (default real time). */
  readonly nowIso?: () => string;
  readonly newEventId?: () => string;
  readonly newIdempotencyKey?: () => string;
  /** Wall-clock budget for a `create` before the deadline fires (default 30s). */
  readonly createDeadlineMs?: number;
  /**
   * Generic per-op deadline stamped on the op context (default 60s).
   *
   * ★ H1 — may be a FUNCTION of the handoff, resolved ONCE per run at acceptance. That is what
   * lets the composition root derive the deadline from the run's own
   * `workload.maxRuntimeSeconds`, which otherwise never reaches the supervisor at all: this
   * number is simultaneously the execute race, the E2B sandbox TTL, and the E2B command
   * timeout, so a fixed 60 s killed every task that needed longer.
   *
   * The per-run value governs `create` (whose ctx sets the sandbox TTL) and `execute`. Cleanup
   * and teardown ops deliberately keep the BASE deadline: a long run budget is not a reason to
   * let a destroy hang, and the capability those ops run under expires on its own schedule.
   */
  readonly opDeadlineMs?: number | ((handoff: LeaseHandoff) => number);
  /** ms after acceptance the cleanup authority's escalation becomes mandatory. */
  readonly cleanupDeadlineMs?: number;
  /**
   * CLI-008 Unit B — wall-clock budget for the WHOLE staging step (default 30s).
   *
   * ★ ONE budget across BOTH halves, subtracted not added — the R6 shape `secretRedeemDeadlineMs`
   * established for redeem+create. The resolve fetches bytes over the network and the write
   * pushes them into the sandbox; two independent 30 s budgets would make the step's real bound
   * 60 s while every knob still read 30. A bound nobody can compute from the config is not a bound.
   */
  readonly stageInputDeadlineMs?: number;
  /**
   * SVC-008b — the service supervise loop's tick interval, in ms
   * (default {@link SERVICE_HEALTH_TICK_MS_DEFAULT}). Ignored by every non-service run.
   *
   * ★ INJECTABLE BECAUSE §9.3 IS OPEN, not because tests want it fast. The interval sets the
   * durable `service_health` volume (a 10 s tick over 72 h is ~26 000 rows per instance) and
   * it interacts with SVC-003's liveness deadline, so whoever rules on §9.3 changes the
   * composition root rather than this module.
   */
  readonly serviceHealthTickMs?: number;
  /** Injectable timer for the create-deadline race (default node timers). */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  /** DAT-005 D4 — per-run secret canaries scrubbed from EVERY event this supervisor's
   * lifecycle sequencer emits (attempt_started / terminal / op stream), BEFORE the
   * digest + durable outbox. The canary-seeding channel that populates this is the
   * inert E4-D12 seam; until then it is `[]` (verbatim emit, no secret-bearing
   * supervisor string exists yet — every terminal errorMessage is hardcoded null). */
  /**
   * ★ REQUIRED, deliberately. This was `redactionCanaries?:` with a `?? []` fallback — an
   * OMISSION-BY-DEFAULT in a REDACTION mechanism: a caller that simply forgot got no
   * redaction at all, silently, and nothing anywhere would say so.
   *
   * A fail-open default in a security control is the worst kind of default, because the
   * failure is invisible in exactly the case it matters. Passing `[]` is still allowed —
   * but it now has to be TYPED OUT, which makes "this run has no canaries" a decision
   * someone made rather than one they omitted.
   */
  readonly redactionCanaries: readonly string[];
  /**
   * CLI-003/D3 — an OPTIONAL run-observation source. When present, the supervisor
   * resolves it AFTER `execute` (with the exec result) and emits the captured
   * log/progress/usage producer events between `attempt_started` and `terminal`.
   * Absent (the default) leaves the lifecycle event stream unchanged. Best-effort:
   * a throw is logged and never fails the run.
   */
  readonly observeRun?: (input: { handoff: LeaseHandoff; exec: ExecuteResult }) => RunObservation | Promise<RunObservation>;
  /**
   * CLI-008 Unit B — resolve the control-plane-staged files for this run, as {path, GRANT}
   * pairs. Absent (the default) ⇒ nothing is staged and the lifecycle is byte-identical to
   * before, which is what keeps staging OPTIONAL for every existing run.
   *
   * ★ GRANTS, NOT BYTES. The composition root reads the staged-input pointer off the frozen
   * envelope and mints a download grant per file over the frozen `artifact_transfer_grant`
   * op; the bytes go store → provider → sandbox and never cross this seam. A bytes-shaped
   * signature would route payloads through a daemon that is dependency-pinned (E4-D01)
   * precisely so it does not handle them.
   *
   * ★ FAIL CLOSED, unlike `observeRun`. `observeRun` is instrumentation and a throw there is
   * swallowed; this is INPUT. A run that was meant to have files and does not is a sandbox
   * whose agent works from the wrong context, terminalizes cleanly, and satisfies every gate
   * downstream while proving nothing. A throw here — resolving OR staging — fails the attempt
   * and escalates cleanup.
   */
  readonly resolveStagedFiles?: (input: { handoff: LeaseHandoff }) => Promise<readonly StagedFileRequest[]>;
  /**
   * DAT-008 slice 5 — PER-RUN secret materialisation. Given a handoff, redeems the envelope's
   * `env`/`sandbox_local_only` handles and returns the sandbox `env` plus the redeemed values (to
   * seed as per-run redaction canaries). Absent (the default) = no secrets, `env` stays `{}` —
   * byte-identical pre-slice-5 behaviour. A THROW or a TIMEOUT fails the attempt CLOSED: a durable
   * terminal is emitted and cleanup escalated, and NO sandbox is created.
   */
  readonly materializeRunSecrets?: (
    handoff: LeaseHandoff,
  ) => Promise<{ env: Record<string, string>; canaries: readonly string[]; capability?: OwnedLabelsCapabilityLike }>;
  /**
   * DAT-008 slice 5 — the per-lease canary coordinator shared with the fence-close proxy, so ONE
   * redemption seeds BOTH event streams. Absent = the supervisor uses its own per-run array
   * (seeded from `redactionCanaries`); the proxy sink is simply not fed (unit/non-driver builds).
   */
  readonly canaryCoordinator?: RunCanaryCoordinator;
  /**
   * DAT-008 slice 5 (R6) — the redemption budget, in ms. CARVED FROM `createDeadlineMs` (clamped to
   * it) and SUBTRACTED from the create budget, so a slow control plane cannot extend the run's wall
   * clock. Default 5000.
   */
  readonly secretRedeemDeadlineMs?: number;
}

export type SupervisorRunStatus = "succeeded" | "failed" | "cancelled" | "create_timeout";

export interface Supervisor extends SupervisorSeam {
  accept(handoff: LeaseHandoff): Promise<void>;
  /** Cancel a live run: withdraw effect authority and escalate cleanup on its
   * process tree (cancel → kill → destroy). Idempotent; a no-op if unknown. */
  cancel(leaseId: string, reason?: string): Promise<void>;
  /** Handle a lost/replaced lease exactly like a cancel (effect withdrawn). */
  onLeaseLost(leaseId: string): Promise<void>;
  /** Cancel every live run and let cleanup converge (shutdown). */
  shutdown(): Promise<void>;
  activeRunCount(): number;
}

interface ActiveRun {
  readonly leaseId: string;
  readonly labels: ResourceLabels;
  readonly fence: EffectFence;
  // MUTABLE (DEP-011 Slice 2a §2a.3): the networked branch builds NO-OP null-object
  // authorities at `buildRun` and REBUILDS the real ones over the per-run driver AFTER
  // redemption. NEVER unset (a `TypeError`-and-map-leak the null-object prevents); the
  // two reassignments are SYNCHRONOUS (no `await` between) so a concurrent cancel sees
  // both-no-op or both-real, never a half-swap.
  effect: EffectAuthority;
  cleanup: CleanupAuthority;
  readonly makeCtx: () => ProviderOpContext;
  sandboxId: string | null;
  cancelled: boolean;
  cleanedUp: boolean;
  /** True on the container/networked branch (`makeRunProvider`) — routes teardown through
   * the HONEST TRUST cleanup (clock-first, orphan-on-expiry, RNA-skew re-check). */
  readonly networked: boolean;
  /** The per-run capability's absolute ms-epoch expiry, set when the networked authorities are
   * rebuilt. The clock-first teardown compares it to the supervisor `now` (§2a.5). */
  capExpiresAt: number | null;
  /** H1 — this run's provider-op budget, resolved ONCE at `buildRun` from the handoff (i.e.
   * from `workload.maxRuntimeSeconds`). Governs `create` (⇒ the sandbox TTL) and `execute`;
   * cleanup/teardown keep the base deadline. */
  readonly opDeadlineMs: number;
  /**
   * SVC-008b — the live service sequencer's stop handle, or null (every batch run, and a
   * service run before its launch / after it settles).
   *
   * ★ It is what makes `gracefulStopSeconds` reachable at all. Without it, a server-ordered
   * cooperative cancel goes straight to `escalateCleanup`, which destroys the sandbox and
   * hard-kills the process tree — the graceful ladder never runs, which is the behaviour
   * SVC-008 §1.3(d) objects to.
   */
  serviceStop: ServiceStopHandle | null;
}

const TIMEOUT = Symbol("create-deadline");

/**
 * SVC-008b — how long past `gracefulStopSeconds` the supervisor waits for a service
 * sequencer to finish its ladder before raising the fence and escalating anyway.
 *
 * It covers the two provider round-trips the ladder still owes after its deadline lapses
 * (`signalProcess("kill")` + the status re-read). It is NOT a second graceful window: when it
 * fires, the run is cancelled and the sandbox is reclaimed on the existing escalation path.
 */
const GRACEFUL_STOP_MARGIN_MS = 5_000;

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  // DEP-011 Slice 2a — FAIL FAST at construction (review F4/F5):
  //  (a) EXACTLY one of `provider`/`makeRunProvider` may be set — both is a misconfig
  //      (which authority does `buildRun` build?).
  //  (b) `makeRunProvider` REQUIRES `materializeRunSecrets`: the post-redemption rebuild
  //      runs ONLY inside the `if (deps.materializeRunSecrets)` block, so pairing them
  //      without it would leave the no-op authorities in place forever (a silent
  //      fail-safe-but-wrong misconfig). Pair them or fail now, loudly.
  if (deps.provider && deps.makeRunProvider) {
    throw new Error("createSupervisor: provider and makeRunProvider are mutually exclusive (set exactly one)");
  }
  if (deps.makeRunProvider && !deps.materializeRunSecrets) {
    throw new Error("createSupervisor: makeRunProvider requires materializeRunSecrets (the per-run authorities rebuild after redemption)");
  }
  const networked = deps.makeRunProvider !== undefined;
  const now = deps.now ?? (() => Date.now());
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const newEventId = deps.newEventId ?? randomUUID;
  const newKey = deps.newIdempotencyKey ?? randomUUID;
  const createDeadlineMs = deps.createDeadlineMs ?? 30_000;
  // The BASE deadline: what cleanup/teardown ops use, and the fallback when no per-run
  // resolver is composed (the desktop root, and every test that passes a plain number).
  const opDeadlineMs = typeof deps.opDeadlineMs === "number" ? deps.opDeadlineMs : 60_000;
  // H1 — the per-run resolver, when the composition root supplies one. Resolved ONCE at
  // `buildRun`, never re-derived, so `create` and `execute` cannot disagree about the budget.
  const resolveRunDeadlineMs =
    typeof deps.opDeadlineMs === "function" ? deps.opDeadlineMs : () => opDeadlineMs;
  const cleanupDeadlineMs = deps.cleanupDeadlineMs ?? 30_000;
  const stageInputDeadlineMs = deps.stageInputDeadlineMs ?? 30_000;
  const serviceHealthTickMs =
    typeof deps.serviceHealthTickMs === "number" &&
    Number.isFinite(deps.serviceHealthTickMs) &&
    deps.serviceHealthTickMs > 0
      ? deps.serviceHealthTickMs
      : SERVICE_HEALTH_TICK_MS_DEFAULT;
  // DAT-008 slice 5 (R6): the redemption budget is CARVED FROM the create budget — never larger —
  // so redeem + create together stay within `createDeadlineMs`.
  const secretRedeemDeadlineMs = Math.min(deps.secretRedeemDeadlineMs ?? 5_000, createDeadlineMs);
  const schedule = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelTimer = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));

  const runs = new Map<string, ActiveRun>();

  const emitOp = (operation: string, outcome: string): void =>
    deps.metrics?.inc(SANDBOX_OP_METRIC, { operation, outcome });

  function ctx(deadlineMs: number = opDeadlineMs): ProviderOpContext {
    return { deadlineMs, idempotencyKey: newKey() };
  }

  function labelsFor(handoff: LeaseHandoff): ResourceLabels {
    return {
      organizationId: String(handoff.offer.job.organizationId),
      targetId: deps.identity.targetId,
      workerId: String(handoff.offer.workerId),
      jobId: String(handoff.offer.job.jobId),
      attempt: handoff.offer.job.attempt,
      leaseId: handoff.leaseId,
      deviceGeneration: deps.identity.deviceGeneration,
    };
  }

  function deliveryIdentity(handoff: LeaseHandoff): EventDeliveryIdentity {
    return {
      organizationId: String(handoff.offer.job.organizationId),
      companyId: String(handoff.offer.job.companyId),
      workerId: String(handoff.offer.workerId),
      jobId: String(handoff.offer.job.jobId),
      attempt: handoff.offer.job.attempt,
      leaseId: handoff.leaseId,
      fenceToken: String(handoff.fenceToken),
    };
  }

  function createSpecFor(handoff: LeaseHandoff, labels: ResourceLabels, env: Readonly<Record<string, string>>): CreateSandboxSpec {
    const workload = handoff.offer.job.workload as Record<string, unknown>;
    const command = typeof workload.command === "string" ? workload.command : handoff.offer.job.workloadType;
    const args = Array.isArray(workload.args) ? (workload.args as unknown[]).map(String) : [];
    // DAT-008 slice 5 — `env` is the redeemed provider-credential map (M2). Empty when no
    // `env`/`sandbox_local_only` handle rides the envelope, preserving pre-slice-5 behaviour.
    return { resourceLabels: labels, command, args, env, workloadType: handoff.offer.job.workloadType };
  }

  async function withDeadline<T>(op: Promise<T>, deadlineMs: number): Promise<T | typeof TIMEOUT> {
    let handle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      handle = schedule(() => resolve(TIMEOUT), deadlineMs);
    });
    try {
      return await Promise.race([op, timeout]);
    } finally {
      if (handle !== null) cancelTimer(handle);
    }
  }

  /** Withdraw effect authority and escalate cleanup on the run's labeled
   * resource(s). Idempotent per run. */
  async function escalateCleanup(run: ActiveRun, reason: string): Promise<void> {
    run.effect.withdraw();
    if (run.cleanedUp) return;

    // Discover the labeled resource(s) even when `create` hung or is still
    // in-flight (no sandboxId yet).
    let targets: string[];
    if (run.sandboxId !== null) {
      targets = [run.sandboxId];
    } else {
      const listed = await run.cleanup.list(ctx());
      // A concurrent pass may have latched, or `create` may have resolved, while
      // we awaited the list — re-check and prefer a now-known sandboxId.
      if (run.cleanedUp) return;
      targets = run.sandboxId !== null ? [run.sandboxId] : listed.map((r) => r.sandboxId);
    }

    // CONTAINMENT MUST NOT FAIL OPEN. An empty pass reclaimed NOTHING: a provider
    // that only registers the sandbox on `create` resolve (the real E2B runtime)
    // is not listable while create is in-flight, so `list()` returns []. Do NOT
    // consume the terminal `cleanedUp` latch on an empty/ineffective pass — leave
    // the run retryable so the post-create `if (run.cancelled)` pass reclaims the
    // now-known live sandbox. Latching here would strand a tenant sandbox past
    // lease loss with zero worker-side teardown — the exact leak WRK-004 prevents.
    if (targets.length === 0) {
      deps.logger?.info(
        {
          leaseId: run.leaseId,
          resourceLabelsHash: hashResourceLabels(run.labels),
          deviceGeneration: run.labels.deviceGeneration,
          reason,
        },
        "supervisor: cleanup pass found no reclaimable resource (create in-flight) — staying retryable",
      );
      return;
    }

    // Only NOW — with a real target to reclaim — consume the terminal latch, so a
    // genuine convergence is never double-run (idempotent-destroy purpose intact).
    run.cleanedUp = true;

    // DEP-011 Slice 2a §2a.5 — the NETWORKED branch is the HONEST TRUST variant: NEVER the
    // gate-masking `converge` (which reads the uniform RNA as "gone → success" and would mask a
    // LIVE, billing sandbox behind a lease-expired cap). `convergeNetworked` is clock-first with an
    // RNA skew re-check and records a DISTINCT `orphaned` outcome, never calling the RNA-means-gone
    // `converge`.
    const status = run.networked
      ? await convergeNetworked(run, targets)
      : await run.cleanup.converge(targets, () => ctx());
    const stage = run.cleanup.escalationStage();
    deps.metrics?.inc(CLEANUP_ESCALATION_METRIC, { escalation_stage: stage });
    deps.metrics?.inc(CLEANUP_OUTCOME_METRIC, { outcome: status });
    deps.logger?.info(
      {
        leaseId: run.leaseId,
        resourceLabelsHash: hashResourceLabels(run.labels),
        deviceGeneration: run.labels.deviceGeneration,
        cleanupEpoch: run.cleanup.cleanupEpoch(),
        escalationStage: stage,
        cleanupStatus: status,
        // §2a.5 F1 — a DISTINCT escalateCleanup log field the deferred reaper's leak-rate signal reads.
        orphaned: status === "orphaned",
        reason,
      },
      "supervisor: cleanup converged",
    );
  }

  /**
   * DEP-011 Slice 2a §2a.5 — the HONEST TRUST teardown for the NETWORKED branch (Option A). The
   * worker holds the cap + its `expiresAt` and its OWN clock, so the decision is the worker's, NOT
   * the gate's ambiguous RNA:
   *  - CLOCK-FIRST: if the cap is expired on the worker clock, a gated teardown is doomed — record
   *    an `orphaned` outcome WITHOUT touching the gate (never a false `success`).
   *  - On a returned uniform RNA from an attempted (valid-at-issue) op, RE-READ the clock (skew-safe):
   *    expired-during-round-trip ⇒ `orphaned`; STILL valid ⇒ a valid cap + RNA means the sandbox is
   *    genuinely GONE ⇒ `success`. RNA is consulted ONLY here, and only after the clock says the cap
   *    should still work.
   * Hard reclamation of a live orphan is the deferred server-side reaper's job (Option A); this is the
   * worker's honest best-effort teardown while the cap is valid.
   */
  async function convergeNetworked(run: ActiveRun, targets: string[]): Promise<"success" | "failed" | "orphaned"> {
    if (run.capExpiresAt === null || !(run.capExpiresAt > now())) return "orphaned";
    let aggregate: "success" | "failed" = "success";
    for (const sandboxId of targets) {
      try {
        const result = await run.cleanup.destroy(sandboxId, ctx());
        if (result.cleanupStatus !== "success") aggregate = "failed";
      } catch (err) {
        if (err instanceof ResourceNotAvailableError) {
          // Skew re-check: expired-in-flight ⇒ orphan (do NOT read RNA as "gone"); still-valid ⇒
          // genuinely gone ⇒ nothing to reclaim (a success for this target).
          if (!(run.capExpiresAt > now())) return "orphaned";
          continue;
        }
        throw err;
      }
    }
    return aggregate;
  }

  /** DEP-011 Slice 2a §2a.5 — record an HONEST orphan without touching the gate: the cap is expired
   * (on the worker clock), so a gated teardown is doomed. A DISTINCT `orphaned` cleanup outcome +
   * log field (never `success`, never `failed`); the deferred server-side reaper reclaims the live
   * sandbox. Consumes the cleanup latch so no later pass double-handles it. */
  function recordOrphan(run: ActiveRun, reason: string): void {
    run.cleanedUp = true;
    deps.metrics?.inc(CLEANUP_OUTCOME_METRIC, { outcome: "orphaned" });
    deps.logger?.warn(
      {
        leaseId: run.leaseId,
        resourceLabelsHash: hashResourceLabels(run.labels),
        deviceGeneration: run.labels.deviceGeneration,
        cleanupStatus: "orphaned",
        orphaned: true,
        reason,
      },
      "supervisor: networked capability expired before teardown — recording an HONEST orphan (server-side reaper owns reclamation)",
    );
  }

  async function runLifecycle(handoff: LeaseHandoff, run: ActiveRun): Promise<void> {
    // DAT-008 slice 5 — the PER-RUN canary array. When a coordinator is present the fence-close
    // proxy captures this SAME array (by leaseId) at construction, so seeding it once — before
    // create, before any emit — scrubs BOTH the lifecycle stream (this sequencer) and the proxy's
    // post-close `network_denied` stream.
    //
    // ★ NOTE ON `deps.redactionCanaries`: it is honoured ONLY on the no-coordinator fallback path
    // (unit/non-driver builds). On the coordinator path it is deliberately NOT merged, because the
    // proxy shares the coordinator's array BY REFERENCE and a merge would need a new array the
    // proxy would not see. This is safe today because the sole production composition passes
    // `redactionCanaries: []` (`dispatch-runtime.ts`). If a construction-time canary is ever needed
    // ALONGSIDE a coordinator, pre-seed the coordinator's per-lease array — do NOT re-add a prefix
    // here, or the proxy stream would silently lose it.
    const runCanaries: string[] = deps.canaryCoordinator
      ? deps.canaryCoordinator.ensure(handoff.leaseId)
      : [...(deps.redactionCanaries ?? [])];
    const events = new EventSequencer({
      identity: deliveryIdentity(handoff),
      sink: deps.eventSink,
      newEventId,
      now: nowIso,
      redactionCanaries: runCanaries,
    });

    // 0. materialize secrets — redeem the envelope's `env`/`sandbox_local_only` handles under a
    // deadline CARVED FROM the create budget (R6). FAIL CLOSED: any denial/timeout/throw emits a
    // durable terminal and escalates cleanup WITHOUT creating a sandbox — a partial/empty env would
    // burn a provider round-trip and surface a misleading auth error much later.
    let env: Readonly<Record<string, string>> = {};
    let secretElapsedMs = 0;
    if (deps.materializeRunSecrets) {
      const t0 = now();
      let mat;
      try {
        mat = await withDeadline(deps.materializeRunSecrets(handoff), secretRedeemDeadlineMs);
      } catch (err) {
        deps.logger?.warn(
          { leaseId: run.leaseId, resourceLabelsHash: hashResourceLabels(run.labels) },
          "supervisor: secret redemption failed — failing the attempt closed",
        );
        await events.terminal({ status: "failed", exitCode: null, errorCode: "secret_redemption_failed", errorMessage: null });
        await escalateCleanup(run, "secret_redemption_error");
        return;
      }
      if (mat === TIMEOUT) {
        deps.logger?.warn(
          { leaseId: run.leaseId, resourceLabelsHash: hashResourceLabels(run.labels) },
          "supervisor: secret redemption deadline exceeded — failing the attempt closed",
        );
        await events.terminal({ status: "failed", exitCode: null, errorCode: "secret_redemption_timeout", errorMessage: null });
        await escalateCleanup(run, "secret_redemption_timeout");
        return;
      }
      // Seed the run's redeemed values BEFORE create and BEFORE any emit that could carry one
      // (M7 ordering). Because `runCanaries` is the array both sinks captured, this one push feeds
      // the lifecycle stream AND the fence-close proxy stream.
      runCanaries.push(...mat.canaries);
      env = mat.env;
      secretElapsedMs = now() - t0;

      // DEP-011 Slice 2a — the NETWORKED branch: the per-run capability now exists, so REBUILD the
      // real per-run authorities over `makeRunProvider({handoff, capability})`, replacing the no-op
      // null-object ones (§2a.3). This is the ONLY place the container worker's real provider is
      // constructed — the capability does not exist at `buildRun`.
      if (networked) {
        const capability = mat.capability;
        if (capability === undefined) {
          // FAIL CLOSED (§2a.6): a networked run that resolves handles but gets NO capability must
          // NEVER build a driver with `capability: undefined` (refused at the gate on every op — a
          // mislabeled `create_failed`). Emit a diagnosable terminal; the no-op authorities handle
          // cleanup safely (nothing created).
          deps.logger?.warn(
            { leaseId: run.leaseId, resourceLabelsHash: hashResourceLabels(run.labels) },
            "supervisor: networked run resolved no owned-labels capability — failing the attempt closed",
          );
          await events.terminal({ status: "failed", exitCode: null, errorCode: "no_run_capability", errorMessage: null });
          await escalateCleanup(run, "no_run_capability");
          return;
        }
        // SYNCHRONOUS SWAP (§2a.3): `makeRunProvider` is sync and NO `await` separates the two
        // reassignments, so a concurrent cancel/onLeaseLost reaching `escalateCleanup` sees EITHER
        // both no-op OR both real — never a half-swap.
        const driver = deps.makeRunProvider!({ handoff, capability });
        const rebuilt = buildAuthorities(driver, run.labels, run.fence);
        run.effect = rebuilt.effect;
        run.cleanup = rebuilt.cleanup;
        run.capExpiresAt = capability.expiresAt;
      }
    }
    const spec = createSpecFor(handoff, run.labels, env);

    // 1. create — raced against its deadline, REDUCED by the redemption time so redeem + create stay
    // within `createDeadlineMs` (R6 "subtracted, not added").
    const createBudget = Math.max(0, createDeadlineMs - secretElapsedMs);
    let created;
    try {
      // H1 — `run.makeCtx()` carries THIS RUN's budget. That ctx becomes the E2B sandbox
      // TTL (`#ttl(ctx)` -> `transport.create({timeoutMs})` + `setTimeout`), so the sandbox
      // must be born with the run's lifetime, not the base 60 s. The create RACE is still
      // `createBudget` (30 s minus redemption) - a slow CREATE is a different failure from a
      // long-running command, and only the latter is what the workload budgets for.
      created = await withDeadline(run.effect.create(spec, run.makeCtx()), createBudget);
    } catch (err) {
      emitOp("create", "failed");
      await events.terminal({ status: "failed", exitCode: null, errorCode: "create_failed", errorMessage: null });
      await escalateCleanup(run, "create_error");
      return;
    }
    if (created === TIMEOUT) {
      emitOp("create", "timed_out");
      deps.logger?.warn(
        { leaseId: run.leaseId, resourceLabelsHash: hashResourceLabels(run.labels) },
        "supervisor: create deadline exceeded",
      );
      await events.terminal({ status: "failed", exitCode: null, errorCode: "create_timeout", errorMessage: null });
      await escalateCleanup(run, "create_timeout");
      return;
    }
    run.sandboxId = created.sandboxId;
    emitOp("create", "success");

    if (run.cancelled) {
      // CLI-003/D3 — a cancel that arrives after create but before the tenant command
      // still reaches a durable cancelled terminal, then escalates cleanup.
      await events.terminal({ status: "cancelled", exitCode: null, errorCode: "cancelled", errorMessage: null });
      await escalateCleanup(run, "cancelled_during_create");
      return;
    }

    // 1b. CLI-008 Unit B — stage the control plane's files INTO the sandbox.
    //
    // Position: after `create` (there is no sandbox to write into before it) and before
    // `attempt_started`/`execute` (the files exist so the tenant command can read them). It is
    // deliberately BEFORE `attempt_started` so a staging failure never emits an event that
    // says the tenant command started when it never did.
    if (deps.resolveStagedFiles) {
      // ★★ BOTH HALVES ARE RACED. Every neighbouring await in this function is bounded — secrets
      // (:494), create (:561), execute (:656) — and staging was the one that was not. A stalled
      // fetch or a sandbox filesystem that never returns meant `accept()` NEVER TERMINALIZED,
      // and an active sandbox was retained for as long as the process lived. That is strictly
      // worse than the failure the fail-closed arms below were written for: a hang produces no
      // terminal at all, so nothing downstream even knows the attempt is stuck.
      const stageStartedAt = now();
      let staged: readonly StagedFileRequest[] = [];
      try {
        const resolved = await withDeadline(deps.resolveStagedFiles({ handoff }), stageInputDeadlineMs);
        if (resolved === TIMEOUT) {
          emitOp("stage_files", "timed_out");
          deps.logger?.warn(
            { leaseId: run.leaseId, resourceLabelsHash: hashResourceLabels(run.labels) },
            "supervisor: staged-input resolve deadline exceeded — failing the attempt closed",
          );
          const cancelled = run.cancelled;
          await events.terminal({
            status: cancelled ? "cancelled" : "failed",
            exitCode: null,
            errorCode: cancelled ? "cancelled" : "stage_input_timeout",
            errorMessage: null,
          });
          await escalateCleanup(run, cancelled ? "cancelled_during_stage_input" : "stage_input_deadline");
          return;
        }
        staged = resolved;
      } catch (err) {
        emitOp("stage_files", "failed");
        deps.logger?.warn(
          { leaseId: run.leaseId, resourceLabelsHash: hashResourceLabels(run.labels), err },
          "supervisor: could not resolve staged input for this run — failing the attempt closed",
        );
        // A cancel arriving mid-resolve withdraws effect authority and surfaces here as a
        // throw. Report it as `cancelled`, exactly as the execute arm below does — labelling a
        // cancel a staging failure would send someone hunting a store problem that never was.
        const cancelled = run.cancelled;
        await events.terminal({
          status: cancelled ? "cancelled" : "failed",
          exitCode: null,
          errorCode: cancelled ? "cancelled" : "stage_input_unavailable",
          errorMessage: null,
        });
        await escalateCleanup(run, cancelled ? "cancelled_during_stage_input" : "stage_input_unresolved");
        return;
      }
      if (staged.length > 0) {
        // What is LEFT of the step budget after the resolve, never a fresh one.
        const writeBudget = Math.max(0, stageInputDeadlineMs - (now() - stageStartedAt));
        try {
          const wrote = await withDeadline(
            // ★ The ctx is passed and the E2B provider IGNORES it — `stageFiles` hands the files
            // to `transport.writeFiles`, whose `writeFiles`/`fetch` accept no abort signal, so
            // there is nothing to honour it with. RECORDED RATHER THAN HALF-BUILT: this race is
            // a supervisor-side backstop that bounds the SUPERVISOR, and a timed-out write may
            // still be in flight inside the transport. That is acceptable here only because the
            // timeout arm escalates cleanup, which destroys the sandbox the write targets.
            // Threading a signal end to end is a transport change and belongs with the work that
            // needs it.
            run.effect.stageFiles(created.sandboxId, staged, run.makeCtx()),
            writeBudget,
          );
          if (wrote === TIMEOUT) {
            emitOp("stage_files", "timed_out");
            deps.logger?.warn(
              { leaseId: run.leaseId, resourceLabelsHash: hashResourceLabels(run.labels), stagedCount: staged.length },
              "supervisor: staging the control plane's input exceeded its deadline — failing the attempt closed",
            );
            const cancelled = run.cancelled;
            await events.terminal({
              status: cancelled ? "cancelled" : "failed",
              exitCode: null,
              errorCode: cancelled ? "cancelled" : "stage_input_timeout",
              errorMessage: null,
            });
            await escalateCleanup(run, cancelled ? "cancelled_during_stage_input" : "stage_input_deadline");
            return;
          }
          emitOp("stage_files", "success");
        } catch (err) {
          // FAIL CLOSED. Running the agent without the files the control plane meant it to
          // have produces a clean terminal for mutilated work — the one outcome nothing
          // downstream can detect.
          emitOp("stage_files", "failed");
          deps.logger?.warn(
            { leaseId: run.leaseId, resourceLabelsHash: hashResourceLabels(run.labels), stagedCount: staged.length, err },
            "supervisor: staging the control plane's input failed — failing the attempt closed",
          );
          // Same reasoning as the resolve arm: a cancel withdraws effect authority and reaches
          // us as a throw from `stageFiles`, and it is a cancel, not a store failure.
          const cancelled = run.cancelled;
          await events.terminal({
            status: cancelled ? "cancelled" : "failed",
            exitCode: null,
            errorCode: cancelled ? "cancelled" : "stage_input_failed",
            errorMessage: null,
          });
          await escalateCleanup(run, cancelled ? "cancelled_during_stage_input" : "stage_input_error");
          return;
        }
      }
    }

    // 2. attempt_started — the tenant command is running INSIDE the sandbox.
    await events.attemptStarted(created.sandboxId);

    // 2b. SVC-008b — THE SERVICE BRANCH.
    //
    // ★ Position: after `attempt_started` (the attempt HAS started — the sandbox exists and
    // the staged input landed) and before `execute`. `execute` is a COMPLETION oracle, and
    // running a service through it is SVC-008 §1.2's mis-supervision: the run ends when the
    // startup script returns, and a service that happens to exit 0 is reported `succeeded`.
    //
    // ★ The service sequencer emits the INSTANCE events and returns an outcome; `terminal`
    // and teardown stay HERE, so the orphan-aware destroy below is written once and cannot
    // drift per workload type.
    if (handoff.offer.job.workloadType === "service") {
      const workload = parseServiceWorkload(handoff.offer.job.workload);
      if (workload === null) {
        // Defensive: the envelope's discriminated union already guarantees this shape, so a
        // failure here is a wire/parse divergence. Fail the attempt with a NAMED code rather
        // than falling through to the batch body, which is the defect this branch exists for.
        await events.terminal({ status: "failed", exitCode: null, errorCode: "service_workload_invalid", errorMessage: null });
        await escalateCleanup(run, "service_workload_invalid");
        return;
      }
      const outcome = await runServiceLifecycle({
        workload,
        sandboxId: created.sandboxId,
        effect: run.effect,
        events,
        makeCtx: run.makeCtx,
        now,
        nowIso,
        schedule,
        tickMs: serviceHealthTickMs,
        deadlineAt: now() + run.opDeadlineMs,
        capExpiresAt: run.capExpiresAt,
        teardownHeadroomMs: RUN_TEARDOWN_HEADROOM_MS,
        // ★ EVERY tick, not once: §4.5. `run.cancelled` is set by `cancel`/`onLeaseLost`/
        // `shutdown`, and the renewal driver closes the fence-close proxy before calling them.
        fenceClosed: () => run.cancelled,
        logger: deps.logger,
        publishStopHandle: (handle) => {
          run.serviceStop = handle;
        },
      });
      run.serviceStop = null;
      await events.terminal({
        status: outcome.status,
        exitCode: outcome.exitCode,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
      });
      if (outcome.escalate !== null) {
        await escalateCleanup(run, outcome.escalate);
        return;
      }
      await finishRun(run, created.sandboxId);
      return;
    }

    // 3. execute (in sandbox) — raced against a supervisor-side op deadline so a
    // provider that hangs (ignoring the opDeadlineMs it also carries on ctx) still
    // reaches a durable terminal within a bound (§2.1 within-policy). A well-behaved
    // provider returns before the race fires (with its own timedOut verdict), so the
    // op wins; the backstop only bites a hung/misbehaving provider.
    let exec;
    try {
      const raced = await withDeadline(
        run.effect.execute(
          { sandboxId: created.sandboxId, command: spec.command, args: spec.args, env: spec.env },
          // H1 - the run's budget on BOTH sides: the ctx is the provider's own command
          // timeout, and the race below is the supervisor-side backstop for a provider that
          // ignores it. They must be the same number, or the backstop fires first and
          // reports `execute_timeout` for a command still inside its budget.
          run.makeCtx(),
        ),
        run.opDeadlineMs,
      );
      if (raced === TIMEOUT) {
        emitOp("execute", "timed_out");
        const cancelled = run.cancelled;
        await events.terminal({
          status: cancelled ? "cancelled" : "failed",
          exitCode: null,
          errorCode: cancelled ? "cancelled" : "execute_timeout",
          errorMessage: null,
        });
        await escalateCleanup(run, "execute_deadline");
        return;
      }
      exec = raced;
    } catch (err) {
      emitOp("execute", "failed");
      // §2.1 — this is the ONLY lifecycle exit and it MUST still reach a durable
      // terminal. The common cancel/lease-loss path tears down the sandbox
      // (escalateCleanup) which makes the in-flight execute REJECT here; without a
      // terminal the attempt is stranded non-terminal until the JOB-006 reaper. A
      // cancelled run reaches `cancelled`; a genuine execute failure reaches `failed`.
      const cancelled = run.cancelled;
      await events.terminal({
        status: cancelled ? "cancelled" : "failed",
        exitCode: null,
        errorCode: cancelled ? "cancelled" : "execute_failed",
        errorMessage: null,
      });
      await escalateCleanup(run, "execute_error");
      return;
    }
    emitOp("execute", "success");

    if (run.cancelled) {
      // Cancelled while executing — emit a durable cancelled terminal (CLI-003/D3),
      // then escalate; no terminal success, no double destroy.
      await events.terminal({ status: "cancelled", exitCode: null, errorCode: "cancelled", errorMessage: null });
      await escalateCleanup(run, "cancelled_during_execute");
      return;
    }

    // 3b. Producers (CLI-003/D3+D5): best-effort log/progress/usage captured from
    // the run, emitted between attempt_started and terminal. Instrumentation must
    // NEVER fail the run — a throw is logged and swallowed. Usage is evidentiary-only
    // (the frozen `.strict()` schema rejects any price field — JOB-012 prices).
    if (deps.observeRun) {
      try {
        const obs = await deps.observeRun({ handoff, exec });
        for (const entry of (obs.logs ?? []).slice(0, MAX_LOG_EVENTS)) {
          await events.log({ stream: entry.stream, level: entry.level ?? "info", message: entry.message });
        }
        for (const tick of obs.progress ?? []) {
          await events.progress({ message: tick.message, percent: tick.percent });
        }
        if (obs.usage) await events.usage(obs.usage);
      } catch (err) {
        deps.logger?.warn({ leaseId: run.leaseId, err }, "supervisor: run observation failed (best-effort)");
      }
    }

    // 4. terminal event — ENRICHED with exec.signal/timedOut (CLI-003/D3). The frozen
    // terminal payload has no signal/timedOut field, so they fold into the free
    // errorCode/errorMessage strings; a timed-out or signalled exec is `failed`.
    const status = exec.exitCode === 0 && !exec.timedOut ? "succeeded" : "failed";
    const errorCode = exec.timedOut ? "exec_timeout" : exec.signal !== null ? "exec_signalled" : null;
    const errorMessage = exec.signal !== null ? `signal:${exec.signal}` : null;
    await events.terminal({ status, exitCode: exec.exitCode, errorCode, errorMessage });

    // 5. destroy UNDER EFFECT AUTHORITY (happy-path reclaim).
    await finishRun(run, created.sandboxId);
  }

  /**
   * The happy-path reclaim, shared by the batch and service arms.
   *
   * DEP-011 Slice 2a §2a.5 — PROACTIVE clock-first check on the networked branch: the cap is
   * lease-clamped + never re-minted, so a run longer than its TTL reaches here with an EXPIRED
   * cap. A gated destroy would be doomed (uniform RNA), and routing that RNA into the `:catch`
   * below would risk the masked-strand. Record an HONEST orphan DIRECTLY and return — the run
   * terminal already emitted above; the orphan is a DISTINCT cleanup outcome.
   *
   * ★ EXTRACTED VERBATIM by SVC-008b, not rewritten. A second copy on the service arm is
   * exactly how the two would drift, and the thing that would drift is the orphan check.
   */
  async function finishRun(run: ActiveRun, sandboxId: string): Promise<void> {
    if (run.networked && run.capExpiresAt !== null && !(run.capExpiresAt > now())) {
      recordOrphan(run, "cap_expired_before_happy_destroy");
      return;
    }
    try {
      const destroyed = await run.effect.destroy(sandboxId, ctx());
      emitOp("destroy", destroyed.cleanupStatus === "success" ? "success" : "failed");
      deps.metrics?.inc(CLEANUP_OUTCOME_METRIC, { outcome: destroyed.cleanupStatus });
      if (destroyed.cleanupStatus === "failed") {
        // A failed happy-path destroy falls back to cleanup escalation.
        await escalateCleanup(run, "happy_destroy_failed");
      }
      deps.logger?.info(
        {
          leaseId: run.leaseId,
          sandboxId,
          providerOpId: destroyed.providerOpId,
          resourceLabelsHash: hashResourceLabels(run.labels),
          cleanupStatus: destroyed.cleanupStatus,
        },
        "supervisor: run complete",
      );
    } catch {
      await escalateCleanup(run, "happy_destroy_error");
    }
  }

  /** Build the effect + cleanup authorities over `provider` for `labels`/`fence`. Used for
   * BOTH the desktop real provider (at `buildRun`, byte-identical) and — on the networked
   * branch — the null-object provider (at `buildRun`) then the real per-run driver (rebuilt
   * in `runLifecycle` after redemption). */
  function buildAuthorities(
    provider: SandboxProvider,
    labels: ResourceLabels,
    fence: EffectFence,
  ): { effect: EffectAuthority; cleanup: CleanupAuthority } {
    return {
      effect: new EffectAuthority(provider, fence),
      cleanup: new CleanupAuthority({
        provider,
        resourceLabels: labels,
        targetGeneration: labels.deviceGeneration,
        fence,
        deadline: now() + cleanupDeadlineMs,
        epoch: 0,
        now,
      }),
    };
  }

  function buildRun(handoff: LeaseHandoff): ActiveRun {
    const labels = labelsFor(handoff);
    const fence: EffectFence = {
      jobId: labels.jobId,
      attempt: labels.attempt,
      leaseId: labels.leaseId,
      fenceToken: String(handoff.fenceToken),
      deviceGeneration: labels.deviceGeneration,
      observedSeq: 0,
    };
    // DESKTOP (`deps.provider`): build the REAL authorities here — byte-identical to
    // pre-DEP-011. NETWORKED (`deps.makeRunProvider`): the capability does not exist yet,
    // so build NO-OP null-object authorities over `createNoopProvider()` (never unset —
    // §2a.3); `runLifecycle` REBUILDS them over the real per-run driver after redemption.
    const initialProvider = deps.provider ?? createNoopProvider();
    const { effect, cleanup } = buildAuthorities(initialProvider, labels, fence);
    // H1 — resolve the run's budget ONCE, here. A resolver that threw or returned a
    // non-positive/NaN value would otherwise reach `setTimeout`, which fires immediately and
    // would kill every run instantly — so an unusable answer falls back to the base deadline
    // rather than becoming an instant-kill.
    let runOpDeadlineMs = opDeadlineMs;
    try {
      const resolved = resolveRunDeadlineMs(handoff);
      if (typeof resolved === "number" && Number.isFinite(resolved) && resolved > 0) {
        runOpDeadlineMs = resolved;
      }
    } catch {
      // Keep the base deadline; a budget-resolution error must never fail a lease.
    }
    return {
      leaseId: handoff.leaseId,
      labels,
      fence,
      effect,
      cleanup,
      makeCtx: () => ctx(runOpDeadlineMs),
      sandboxId: null,
      cancelled: false,
      cleanedUp: false,
      networked,
      capExpiresAt: null,
      opDeadlineMs: runOpDeadlineMs,
      serviceStop: null,
    };
  }

  /**
   * SVC-008b — the single stop path, with ONE new decision: whether the stop is COOPERATIVE.
   *
   * ★★★ WHAT CHANGED AND WHAT DID NOT. For every batch run the behaviour is byte-identical
   * to the pre-SVC-008b `cancel`: `run.serviceStop` is null, so the `graceful` block is
   * skipped entirely and the function is `cancelled = true` then `escalateCleanup`, in that
   * order, as before. The graceful block is reachable ONLY while a service sequencer has
   * published a stop handle.
   *
   * ★ ORDERING IS LOAD-BEARING. `run.cancelled` is set AFTER the graceful window, not before:
   * the service loop treats `run.cancelled` as its fence-closed signal (§4.5) and would abort
   * its own ladder mid-way if the flag were raised first, emitting nothing and leaving the
   * process to the hard destroy — i.e. the graceful path would exist and never run.
   *
   * ★ BOUNDED. The wait is the workload's own `gracefulStopSeconds` plus one teardown-margin,
   * raced by the supervisor's injected timer. A sequencer that wedges cannot hold the renewal
   * driver open: the race fires, `cancelled` is raised, and the escalation reclaims the
   * sandbox exactly as it does today.
   */
  async function stopRun(leaseId: string, reason: string, cooperative: boolean): Promise<void> {
    const run = runs.get(leaseId);
    if (run === undefined) return;
    const stop = run.serviceStop;
    if (cooperative && stop !== null) {
      stop.requestStop(reason);
      await withDeadline(stop.finished, stop.gracefulStopMs + GRACEFUL_STOP_MARGIN_MS);
    }
    run.cancelled = true;
    await escalateCleanup(run, reason);
  }

  const supervisor: Supervisor = {
    async accept(handoff: LeaseHandoff): Promise<void> {
      const run = buildRun(handoff);
      runs.set(run.leaseId, run);
      try {
        await runLifecycle(handoff, run);
      } catch (err) {
        // The lifecycle is best-effort: never reject out of `accept` (the loop
        // treats settle as the in-flight lifetime). Last-resort cleanup.
        deps.logger?.error({ leaseId: run.leaseId, err }, "supervisor: run lifecycle error");
        try {
          await escalateCleanup(run, "lifecycle_error");
        } catch {
          // swallow — never fail the run
        }
      } finally {
        run.effect.withdraw();
        runs.delete(run.leaseId);
      }
    },

    async cancel(leaseId: string, reason = "cancel"): Promise<void> {
      return stopRun(leaseId, reason, true);
    },

    /**
     * ★ SVC-008b SPLIT THIS FROM `cancel`, and the split is the whole difference.
     *
     * It used to delegate: `cancel(leaseId, "lease_lost")`. For a BATCH run that is still
     * byte-identical — `graceful` only reaches a live `run.serviceStop`, which is null on
     * every batch run — so nothing about batch behaviour moved. For a SERVICE run it is the
     * §4.5 rule: a lost lease is NOT a cooperative stop. The fence has closed, the renewal
     * driver has already denied every governed effect locally, and negotiating a graceful
     * shutdown across a dead fence would be the first daemon component to write past one.
     */
    onLeaseLost(leaseId: string): Promise<void> {
      return stopRun(leaseId, "lease_lost", false);
    },

    async shutdown(): Promise<void> {
      const live = [...runs.values()];
      for (const run of live) {
        try {
          // Shutdown is not cooperative either: the process this daemon supervises is going
          // away with it, and waiting out a 300 s graceful window would hold the shutdown.
          await stopRun(run.leaseId, "shutdown", false);
        } catch {
          // best-effort per run
        }
      }
    },

    activeRunCount(): number {
      return runs.size;
    },
  };

  return supervisor;
}
