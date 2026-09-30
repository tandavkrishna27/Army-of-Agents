// server/src/services/service-reconciler.ts
//
// SVC-002 — the service reconciler.
//
// ONE SERVICE, ONE RUNNING INSTANCE, CONVERGED FROM DESIRED STATE, WITHOUT DUPLICATE
// PLACEMENT. That is the whole ticket, and the four words that bound it are in §2 of
// docs/replatform/epics/E9-service-agents/tickets/SVC-002-design.md.
//
// ── WHICH SOURCE IS OBSERVED AND WHICH IS INTENDED ───────────────────────────────────────
//
//   INTENDED  `services.desired_state` + `services.generation` (pinned under a row lock),
//             and the immutable `service_generations.definition` for that generation.
//   OBSERVED  the count of `service_instances` rows for the service that are NOT in one of
//             the three frozen terminal states.
//
// The reconciler creates an instance only when the intent is `running`, the intent is fully
// READABLE, and the observation is zero. Every other combination returns `{action:"none"}`
// with a reason naming which side stopped it.
//
// ★ WHAT HAPPENS WHEN THE INTENT IS UNKNOWN RATHER THAN ABSENT. `service_generations` has
// zero writers in the tree and SVC-002 adds none (SVC-007 owns the create/update controls),
// so `findServiceGenerationDefinition` answers `null` for every service on a real deployment
// today. That `null` is treated as "cannot decide" — `{action:"none", reason:"no_generation"}`
// — and NOT as "start it with a default command". A default branch that returns a definite
// answer for an unreadable intent is the fail-open SVC-008b's stop-verdict work exists to
// refuse; an honest stall is better than a confident wrong verdict that acts.
//
// ── WHAT THIS DOES NOT DO, so a green suite is not over-read ─────────────────────────────
//
//   * It converges ZERO instances → ONE instance and then goes quiescent. It has no way to
//     observe that an instance has STOPPED being one: `recordServiceHealth` is the only
//     writer of `service_instances.status` and it has no consumer. Nothing here drives an
//     instance to a terminal status. That seam is SVC-003's.
//   * It refuses a DRAINING target only in the sense that placement will not select one for
//     a NEW instance. It does not move, stop or replace an instance already running on a
//     target that has begun draining — that needs a fence and a stop channel over a live
//     lease (SVC-003/SVC-005).
//   * It adds NO routes. There is still no way for a human to create a service, so on a real
//     deployment `listReconcilableServices` returns an empty page and this loop is a no-op.
//     Said plainly because "the first ticket in E9 with a producer" is easy to over-read.
//   * A service job it submits is placed `queued` / `no_eligible_target` unless a daemon in
//     the fleet advertises `workload.service` with a free service slot. SVC-008b widened the
//     daemon constant so that is now possible rather than structurally impossible, but
//     E9-F002 stays open on its other conjunct and a supervised service is bounded at 240 s.

import { createHash, randomUUID } from "node:crypto";
import type {
  Db,
  ServiceInstanceLivenessSweepResult,
  TenantRepositories,
} from "@armyofagents/db";
import { HttpError } from "../errors.js";
import { runInTenant } from "../db/tenant-context.js";
import { assertAdmissibleOrganization } from "./tenant-admission.js";
import { submitJobWithinTenant } from "./job-submission.js";
// DE-27 (audit clause) — the capacity-refusal sink type (erased at compile time);
// `drainAdmissionDenial` is loaded dynamically at the drain point in `reconcileService`.
import type { AdmissionDenialSink } from "./worker-admission-denial-audit.js";
import {
  classifyServiceInstanceLiveness,
  livenessDeadlineAllowedFromStatuses,
  livenessVerdictTerminalizes,
  SERVICE_ADMISSION_DEADLINE_MS_DEFAULT,
  SERVICE_LIVENESS_DEADLINE_MS_DEFAULT,
  SERVICE_LIVENESS_DEADLINE_TO_STATUS,
  type ServiceLivenessPolicy,
} from "./service-liveness-deadline.js";
// SVC-005a — the cross-generation placement fence's pure classifier. The reconciler consults
// it; the rollout writer that makes a second generation possible lives in the same module.
import { findBlockingPredecessor } from "./service-generation-rollout.js";

/**
 * Fixed, never-rotate namespace UUID for deriving a service reconciliation's identity
 * (RFC 4122 v5). Generated once as a random UUID and hardcoded as a protocol constant.
 *
 * ★ DO NOT CHANGE IT. `reconciliationId` is one of the seven columns of
 * `jobs_submission_idempotency_uq`, so rotating this namespace would make every already
 * submitted service job un-replayable: a resubmission for the same instance would mint a
 * different identity, miss the composite, and insert a SECOND job.
 *
 * Self-contained rather than a dependency for the same reason
 * `derivePlatformDefaultEnvironmentId` is: no `uuid` package is a resolvable direct
 * dependency of `server/`.
 */
const SERVICE_RECONCILE_NAMESPACE = "6b1f0c74-0f2a-4d51-9a3c-7c5f2e18b4d0";

function uuidV5(name: string, namespaceUuid: string): string {
  const namespaceBytes = Buffer.from(namespaceUuid.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1").update(Buffer.concat([namespaceBytes, nameBytes])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * ★★★ THE TRAP THIS EXISTS FOR, and it is the single most important fact in this file.
 *
 * `jobs_submission_idempotency_uq` is a SEVEN-column composite that includes
 * `authenticated_source_identity` — and for a `service_reconcile` source that field IS
 * `source.reconciliationId` (packages/shared/src/job-control-source.ts). So pinning
 * `idempotencyKey` while leaving `reconciliationId` a fresh `randomUUID()` pins six of seven
 * columns and ADMITS A DUPLICATE: an identical resubmission does not collide and a second
 * job is created. A green idempotency test over a pinned key would not see it.
 *
 * Both halves are therefore derived from the one id the partial unique index
 * `service_instances_live_service_uq` already guarantees is unique. Every remaining column of
 * the composite is also a function of the instance (org and company from its own row,
 * principal kind/id and source kind constant), so the whole seven-column key reduces to
 * `serviceInstanceId`, which is a primary key.
 *
 * ★ REACHABILITY, STATED HONESTLY. No path in SVC-002 submits twice for one instance id —
 * the loser of the index race returns before the submission, and the observed-state check
 * short-circuits before a later tick can. So this property is UNREACHABLE from the
 * reconciler, and a test that drives the reconciler cannot kill a "revert to randomUUID()"
 * mutant. It is pinned by a test that performs the second submission ITSELF (T1c in
 * service-reconciler.integration.test.ts); SVC-004's replacement path is its first real
 * consumer.
 */
export function deriveReconciliationId(serviceInstanceId: string): string {
  return uuidV5(`service-reconcile:${serviceInstanceId}`, SERVICE_RECONCILE_NAMESPACE);
}

/** The submission idempotency key for one service instance. See {@link deriveReconciliationId}. */
export function deriveServiceIdempotencyKey(serviceInstanceId: string): string {
  return `svc-instance:${serviceInstanceId}`;
}

export type ServiceReconcileNoneReason =
  /** The service row is not visible in this tenant (deleted, or a stale sweep window). */
  | "service_absent"
  /** INTENDED state is not `running`. Covers `paused`, `stopped` and `deleted` alike. */
  | "desired_state_not_running"
  /** INTENDED state is unreadable: no `service_generations` row for this generation. */
  | "no_generation"
  /** The frozen service workload cannot be built from the stored definition. */
  | "invalid_definition"
  /** OBSERVED state already has a non-terminal instance — the sequential and the raced path
   *  return this SAME value, which is what "idempotent" means here. */
  | "instance_present"
  /** Organization budget hard-stop or concurrency cap; the transaction rolled back whole. */
  | "quota_denied"
  /**
   * ★★★ SVC-005a — THE GENERATION ROLLOUT FENCE REFUSED THIS PLACEMENT. An instance of a
   * PREVIOUS generation ended without a witness — a clock condemned it, or its author is
   * unknown — and its attempt has not reached a terminal status, so the old worker's fence is
   * still open and it may still be performing external effects (E9-F007). Placing the new
   * generation beside it is the overlap E9's acceptance for SVC-005 forbids.
   *
   * ★ IT IS A STALL, NOT A WEDGE, and the difference is the recovery condition: it clears the
   * moment that attempt reaches a terminal status, which lease expiry plus `reapExpiredLeases`
   * reaches without any cooperation from the worker. See
   * `service-generation-rollout.ts`'s header, §5.
   */
  | "predecessor_generation_unwitnessed";

export type ServiceReconcileOutcome =
  | {
      action: "created";
      serviceInstanceId: string;
      jobId: string;
      attemptId: string;
      replayed: boolean;
    }
  | { action: "none"; reason: ServiceReconcileNoneReason };

export interface ReconcileServiceInput {
  organizationId: string;
  companyId: string;
  serviceId: string;
}

/**
 * The service workload's non-identity half, as frozen `serviceWorkloadV1Schema` names it.
 * Read out of the immutable `service_generations.definition` rather than invented here.
 */
function readDefinition(definition: Record<string, unknown>): {
  command: unknown;
  args: unknown;
  gracefulStopSeconds: unknown;
} {
  return {
    command: definition.command,
    args: definition.args,
    gracefulStopSeconds: definition.gracefulStopSeconds,
  };
}

/**
 * ONE reconcile pass for one `(organization, service)`, entirely inside ONE already-open
 * tenant transaction.
 *
 * ★ THE SINGLE TRANSACTION IS LOAD-BEARING, NOT TIDINESS. `submitJobWithinTenant` composes
 * `admitAttemptCapacity`, which raises a 429 on a budget hard-stop or a full concurrency cap.
 * Because the instance insert shares this transaction, that 429 unwinds the instance row too:
 * quota exhaustion creates NO instance and NO job. Written in a separate transaction, quota
 * exhaustion would leave an orphan `pending` instance that the observed-state check then
 * reads as "instance present" — and the service would never start again. A silent permanent
 * wedge.
 *
 * Errors are NOT caught here, deliberately: a caught 429 that returned normally would COMMIT
 * the orphan this composition exists to prevent. The mapping to `quota_denied` happens in
 * {@link reconcileService}, strictly outside the transaction, after the rollback.
 */
export async function reconcileServiceWithinTenant(
  repos: TenantRepositories,
  tx: Db,
  input: ReconcileServiceInput,
  // DE-27 (audit clause) — forwarded into `submitJobWithinTenant` -> `admitAttemptCapacity`
  // so a `capacity` refusal captures its intent for {@link reconcileService} to drain on a
  // pool handle after this transaction rolls back. Optional so a direct caller is unchanged.
  denialSink?: AdmissionDenialSink,
): Promise<ServiceReconcileOutcome> {
  // 1 + 2: serialize concurrent passes into a wait, then PIN desired_state AND generation
  // for the whole transaction so a concurrent SVC-005 generation bump cannot land between
  // this read and the insert.
  const service = await repos.jobControl.lockServiceForReconcile({
    organizationId: input.organizationId,
    companyId: input.companyId,
    serviceId: input.serviceId,
  });
  if (!service) return { action: "none", reason: "service_absent" };

  // 3: INTENDED state. An allow-list, matching the predicate now carried by
  // `serviceSourceIsAdmitted` — the authority every submission passes through.
  if (service.desiredState !== "running") {
    return { action: "none", reason: "desired_state_not_running" };
  }

  // 3b: the rest of the INTENDED state. `null` is "the read answered and there is no
  // definition", which is a stall, never a default.
  const generation = await repos.jobControl.findServiceGenerationDefinition({
    organizationId: input.organizationId,
    companyId: input.companyId,
    serviceId: input.serviceId,
    generation: service.generation,
  });
  if (!generation) return { action: "none", reason: "no_generation" };

  // 4: OBSERVED state. NON-TERMINAL, not `healthy` — see the repository docstring.
  const live = await repos.jobControl.countNonTerminalInstances({
    organizationId: input.organizationId,
    serviceId: input.serviceId,
  });
  if (live >= 1) return { action: "none", reason: "instance_present" };

  // ★★★ 4b: SVC-005a — THE GENERATION ROLLOUT FENCE. This is where E9's SVC-005 acceptance
  // clause is actually enforced, and it is here rather than at the bump because the bump
  // performs no external effect: the dangerous moment is a generation N+1 instance STARTING
  // beside a generation-N worker that never stopped.
  //
  // WHY STEP 4 IS NOT ALREADY ENOUGH. `countNonTerminalInstances` proves no instance is LIVE.
  // It does not prove the previous generation's WORKER is gone, and E9-F007 is exactly that
  // gap: SVC-003b's liveness deadline drives an instance `lost` BY A CLOCK when its worker has
  // gone silent, the row leaves `service_instances_live_service_uq` — so step 4 reads zero —
  // while "its supervised PROCESS may still be running and still performing external effects"
  // (E9-F007 §1). Before SVC-005a that produced only a same-generation replacement, which
  // E9-F007 §3 ruled the smaller harm and which is NOT re-litigated here. Once a rollout can
  // move `services.generation`, the SAME hole produces a CROSS-generation overlap, and that is
  // the one the acceptance clause names.
  //
  // ★ ONLY CROSS-GENERATION. The repository read filters `generation <> service.generation`,
  // so a replacement at the SAME generation is unaffected and SVC-003b's behaviour is
  // byte-for-byte unchanged. `R-T6` is the pin that this fence does not slow a same-generation
  // replacement down.
  //
  // ★ IT COSTS ONE QUERY ON A PATH THAT IS ABOUT TO INSERT A ROW AND SUBMIT A JOB, and it runs
  // ONLY after step 4 has already established there is nothing live — i.e. only on the passes
  // that are about to place something. A service that has never rolled has no instance at any
  // other generation, so the read returns empty and the fence is invisible.
  const unwitnessed = await repos.jobControl.listUnwitnessedGenerationPredecessors({
    organizationId: input.organizationId,
    serviceId: input.serviceId,
    currentGeneration: service.generation,
    limit: 8,
  });
  // The pure classifier re-derives the WITNESS condition the SQL already applied — belt to
  // that braces, so a future widening of the query cannot admit a witnessed row by accident.
  if (findBlockingPredecessor(unwitnessed) !== null) {
    return { action: "none", reason: "predecessor_generation_unwitnessed" };
  }

  // 5: mint the instance FIRST, because the frozen workload carries `serviceInstanceId` and
  // the derived idempotency identity is a function of it. RANDOM, not derived: a
  // deterministic id keyed on (service, generation) would make SVC-004's replacement
  // impossible, because a second instance for the same service and generation would collide
  // with the corpse of the first.
  const serviceInstanceId = randomUUID();
  const inserted = await repos.jobControl.insertServiceInstance({
    id: serviceInstanceId,
    organizationId: input.organizationId,
    companyId: input.companyId,
    serviceId: input.serviceId,
    generation: service.generation,
    status: "pending",
  });
  // ★ The loser of a race against the partial unique index returns the SAME value the
  // sequential path returns at step 4, with no error raised and no extra field. The two
  // outcomes are indistinguishable to the caller, which is what "idempotent" means. The
  // submission is not run by the loser at all.
  if (inserted.outcome === "conflict") return { action: "none", reason: "instance_present" };

  const { command, args, gracefulStopSeconds } = readDefinition(generation.definition);

  // 6: the submission, on the SAME repos and the SAME tx.
  const submitted = await submitJobWithinTenant(
    repos,
    {
      organizationId: input.organizationId,
      companyId: input.companyId,
      // The FIRST real `system`-principal submitter this repository has ever had:
      // SOURCE_REQUESTER_KINDS.service_reconcile is `["system"]` and the only prior
      // `{kind:"system"}` producer feeds the read-only shadow recorder, not a submission.
      principal: { kind: "system", id: input.companyId },
      command: {
        idempotencyKey: deriveServiceIdempotencyKey(serviceInstanceId),
        source: {
          kind: "service_reconcile",
          serviceId: input.serviceId,
          generation: service.generation,
          reconciliationId: deriveReconciliationId(serviceInstanceId),
        },
        input: {
          // `serviceId` and `generation` are re-stamped from the AUTHORIZED source by
          // `stampServiceIdentity`, so these two are tautologically consistent for this
          // caller. `serviceInstanceId` is NOT stamped: SVC-002 closes it BY CONSTRUCTION
          // (it is the primary key of a row inserted in this same transaction), which is
          // airtight for this caller and proves nothing about the submission path. Adding
          // the field to the frozen source schema is a Protocol Custodian STOP and is still
          // open (SVC-002-design.md §10.2).
          serviceId: input.serviceId,
          serviceInstanceId,
          generation: service.generation,
          command,
          args,
          checkpointArtifactId: generation.checkpointArtifactId,
          gracefulStopSeconds,
        },
      },
    },
    tx,
    denialSink,
  );

  // 6b: attribute the instance to the job serving it, still inside this transaction. Without
  // this the instance row is unattributable and SVC-003 has nothing to fence against.
  await repos.jobControl.attributeServiceInstance({
    organizationId: input.organizationId,
    serviceInstanceId,
    jobId: submitted.jobId,
    attemptId: submitted.attemptId,
  });

  return {
    action: "created",
    serviceInstanceId,
    jobId: submitted.jobId,
    attemptId: submitted.attemptId,
    replayed: submitted.replayed,
  };
}

/**
 * A 429 from the composed org-capacity admission, unwrapped through the cause chain.
 *
 * Narrow on purpose: only budget/capacity denial becomes a `none` outcome. Any other failure
 * propagates and the sweeper counts a failed pass, because a reconciler that swallowed
 * everything would report "nothing to do" for a tenant whose database is unreachable.
 */
function quotaDenied(error: unknown): boolean {
  return error instanceof HttpError && error.status === 429;
}

/** A 400 from the frozen service-workload validator: the stored definition is unusable. */
function invalidDefinition(error: unknown): boolean {
  return error instanceof HttpError && error.status === 400;
}

/**
 * One reconcile pass, opening (and on failure ROLLING BACK) its own tenant transaction.
 *
 * The catches live HERE rather than inside the transaction for the reason
 * {@link reconcileServiceWithinTenant} states: catching a 429 inside would commit the orphan
 * instance the single-transaction composition exists to prevent.
 */
export async function reconcileService(
  appDb: Db,
  input: ReconcileServiceInput,
): Promise<ServiceReconcileOutcome> {
  // Parity with `jobSubmissionService.submit`, which asserts this before opening its own
  // transaction. `listAdmittedOrganizationIds` already excludes the sentinel org, but this
  // function is exported and a future caller need not come through the sweeper — and a
  // forbidden sentinel must never reach the distributed path by an unguarded route (FND-007,
  // Decision #121). It THROWS rather than returning a `none` reason: a sentinel org is a
  // programming error, not a state the reconciler converges.
  assertAdmissibleOrganization(input.organizationId);
  // DE-27 (audit clause) — a `capacity` refusal from the composed `admitAttemptCapacity`
  // captures its intent here and is drained on the POOL handle (`appDb`) AFTER `runInTenant`
  // has rolled back (the 429 is what the catch maps to `quota_denied`). The row cannot be
  // written inside the transaction the single-transaction composition exists to roll back.
  // No-op when nothing was captured; never throws.
  const denialSink: AdmissionDenialSink = { intent: null };
  try {
    return await runInTenant(appDb, input.organizationId, (repos, tx) =>
      reconcileServiceWithinTenant(repos, tx, input, denialSink));
  } catch (error) {
    if (quotaDenied(error)) return { action: "none", reason: "quota_denied" };
    if (invalidDefinition(error)) return { action: "none", reason: "invalid_definition" };
    throw error;
  } finally {
    if (denialSink.intent) {
      const { drainAdmissionDenial } = await import("./worker-admission-denial-audit.js");
      await drainAdmissionDenial(appDb, denialSink, {
        control: "server/src/services/service-reconciler.ts:reconcileService",
      });
    }
  }
}

/**
 * ★★★ SVC-003b — ONE ORGANIZATION'S LIVENESS SWEEP, and the answer to "where does the
 * deadline live" is this function's location.
 *
 * THREE PLACES WERE AVAILABLE AND TWO OF THEM CANNOT WORK.
 *
 *   * NOT IN THE PROJECTION (SVC-003a). `applyServiceProjectionForFence` is edge-triggered by
 *     an accepted worker event. The entire failure is the ABSENCE of events, and a consumer
 *     that only runs when an event arrives is structurally unable to notice that none did.
 *   * NOT BESIDE THE LEASE REAPER. Two reasons, and the first alone settles it. (a) The
 *     dangerous case is invisible to a lease: `lease-renewal.ts` renews on its own driver,
 *     separate from the supervise loop, so a worker whose supervision has gone silent while
 *     renewal continues holds a lease that never expires and `reapExpiredLeases` never sees
 *     it. (b) `reapExpiredLeases` is a `packages/db` repository method, and the legality
 *     authority `SERVICE_INSTANCE_TRANSITIONS` lives in `@armyofagents/worker-protocol`, which
 *     `packages/db` deliberately does not depend on — putting the terminalization there means
 *     a fourth hand-written copy of a frozen list, which is precisely what SVC-003a refused.
 *   * HERE, BESIDE THE RECONCILER AND INSIDE ITS TICK. The deadline is the OBSERVED side of
 *     the same convergence loop this file already drives on the INTENDED side, and it needs
 *     exactly what a server-side sweeper has: a clock, the frozen table, and the admitted-org
 *     enumeration this tick already performs. ★ And running it AHEAD of the convergence pages
 *     in the SAME tick is what makes the loop provable in one pass: the sweep drives a silent
 *     instance to `lost`, the row leaves `service_instances_live_service_uq`, and
 *     `listReconcilableServices` — which filters on exactly that index's predicate — returns
 *     its service in the very next statement. Terminalize-then-replace is one tick, not two
 *     timers with an unbounded gap between them.
 *
 * ★ WHAT IT DOES NOT DECIDE. Whether a terminalized instance SHOULD be replaced, and with what
 * backoff, is SVC-004's crash-loop clause. This function terminalizes; replacement is whatever
 * SVC-002's unchanged reconciler already does with a service that has no live instance.
 */
export async function sweepOrganizationServiceLiveness(
  appDb: Db,
  input: { organizationId: string; limit: number; policy: ServiceLivenessPolicy },
): Promise<ServiceInstanceLivenessSweepResult> {
  assertAdmissibleOrganization(input.organizationId);
  const allowedFromStatuses = livenessDeadlineAllowedFromStatuses();
  return runInTenant(appDb, input.organizationId, (repos) =>
    repos.jobControl.sweepServiceInstanceLiveness({
      organizationId: input.organizationId,
      limit: input.limit,
      toStatus: SERVICE_LIVENESS_DEADLINE_TO_STATUS,
      allowedFromStatuses,
      // The pure policy, injected. The repository holds the row lock and the write; it holds
      // no opinion about what "silent" means, and this file holds no SQL.
      decide: (row) =>
        livenessVerdictTerminalizes(classifyServiceInstanceLiveness(row, input.policy)),
    }));
}

export interface ServiceReconcilerTickResult {
  organizations: number;
  services: number;
  created: number;
  unchanged: number;
  failed: number;
  /** SVC-003b — live instances inspected by the liveness sweep across this tick. */
  livenessScanned: number;
  /** SVC-003b — instances the deadline drove terminal this tick. Each one leaves the live
   *  index, so each one is a service the convergence pass below can now replace. */
  livenessTerminalized: number;
  /** SVC-003b — sweeps that threw. Counted separately from `failed` (a convergence pass
   *  failure) so a broken deadline cannot hide inside a reconciler-pass statistic. */
  livenessFailed: number;
}

const ZERO_TICK: ServiceReconcilerTickResult = {
  organizations: 0, services: 0, created: 0, unchanged: 0, failed: 0,
  livenessScanned: 0, livenessTerminalized: 0, livenessFailed: 0,
};

export interface ServiceReconciler {
  tick(): Promise<ServiceReconcilerTickResult>;
  nextDelayMs(result: ServiceReconcilerTickResult): number;
}

/**
 * The polling sweeper that drives {@link reconcileService}.
 *
 * Shape copied from MIG-002's convergence sweeper deliberately: one in-flight tick, bounded
 * batches, a fair rotating org cursor, a wall-clock tick budget, and a `nextDelayMs` backoff
 * the composition root must actually USE (half the MIG-002 sweeper's interface sat
 * unexercised until someone did, and using it is what made its backoff real).
 *
 * POLLING, not events, and that is honest rather than lazy: there is no event source for a
 * desired-state change, because the routes that would change it are SVC-007's and do not
 * exist. The convergence latency is therefore bounded by the tick interval, stated as a
 * bound rather than as "promptly".
 */
export function createServiceReconciler(input: {
  appDb: Db;
  listAdmittedOrganizationIds: (page: {
    afterOrganizationId: string | null;
    limit: number;
  }) => Promise<string[]>;
  enabled?: boolean;
  maxOrganizationShards?: number;
  serviceBatchLimit?: number;
  tickBudgetMs?: number;
  idleDelayMs?: number;
  activeDelayMs?: number;
  monotonicNow?: () => number;
  onPassFailure?: (error: unknown, context: { organizationId: string; serviceId: string }) => void;
  /** SVC-003b — the two deadline windows. Injected whole, never half: a caller that could
   *  supply one and inherit the other could silently pair a short admission window with a long
   *  liveness one, which is the collapse the two-window split exists to prevent. */
  livenessPolicy?: ServiceLivenessPolicy;
  livenessBatchLimit?: number;
  onLivenessFailure?: (error: unknown, context: { organizationId: string }) => void;
  /**
   * ★ SVC-003b — one call PER TERMINALIZED INSTANCE, not per tick.
   *
   * Review of PR #413 asked why an operator cannot tell a deadline kill from a worker-reported
   * one, and the observation was right: a `lost` row records the STATUS and not the AUTHOR, and
   * an aggregate per-tick count names no instance. This hook is the instance-specific half. It
   * is NOT the durable half — a log line is not a record — and that residual is filed as
   * E9-F009 with the `job_projection_receipts` route named, rather than closed here by
   * inventing an `activity_log` convention no neighbouring writer in this layer has.
   */
  onTerminalized?: (entry: {
    organizationId: string;
    serviceInstanceId: string;
    serviceId: string;
    fromStatus: string;
  }) => void;
}): ServiceReconciler {
  const enabled = input.enabled ?? true;
  const livenessPolicy: ServiceLivenessPolicy = input.livenessPolicy ?? {
    livenessDeadlineMs: SERVICE_LIVENESS_DEADLINE_MS_DEFAULT,
    admissionDeadlineMs: SERVICE_ADMISSION_DEADLINE_MS_DEFAULT,
  };
  const livenessBatchLimit = Math.max(1, Math.min(256, Math.floor(input.livenessBatchLimit ?? 64)));
  const maxOrganizations = Math.max(1, Math.min(64, Math.floor(input.maxOrganizationShards ?? 32)));
  const serviceBatchLimit = Math.max(1, Math.min(256, Math.floor(input.serviceBatchLimit ?? 32)));
  const tickBudgetMs = Math.max(1, Math.min(5_000, Math.floor(input.tickBudgetMs ?? 1_000)));
  const idleDelayMs = Math.max(1, Math.floor(input.idleDelayMs ?? 30_000));
  const activeDelayMs = Math.max(1, Math.floor(input.activeDelayMs ?? 2_000));
  const monotonicNow = input.monotonicNow ?? (() => performance.now());

  let cursor: string | null = null;
  /**
   * ★ PER-ORGANIZATION SERVICE CURSOR — half of the fix for a starvation bug this reconciler
   * had. Both halves came out of review on PR #406.
   *
   * The first version always asked for the FIRST page (`afterServiceId: null`). A converged
   * service stays `desired_state = 'running'` forever, so for a tenant with more than
   * `serviceBatchLimit` running services the same lowest-id rows filled every page on every
   * tick and every later service was NEVER reconciled — silently.
   *
   * ★★★ THE CURSOR IS NOT THE LOAD-BEARING HALF, and saying which is which matters. This map
   * is PROCESS-LOCAL: a control-plane restart or a second replica starts each tenant at the
   * head again. If the cursor were the only fix, a tenant whose service set exceeds one tick
   * budget could still starve its tail across repeated restarts, because progress would
   * depend on a full pass completing before the process was replaced. The load-bearing half
   * is therefore in the QUERY: `listReconcilableServices` excludes services that already have
   * a non-terminal instance, so the window IS the remaining work and every tick shortens it
   * whether or not anything was remembered. Losing this map then costs a re-read of a window
   * that no longer contains converged services.
   *
   * What the cursor still buys: fair rotation among a large set of genuinely UNCONVERGED
   * services inside one tick budget, so the first page cannot be re-attempted every tick
   * while the rest wait.
   *
   * Bounded: entries are only ever added for organizations the admitted-org enumerator
   * returned, and an organization that stops being admitted simply stops being visited (the
   * map dies with the process, like the org cursor).
   */
  const serviceCursors = new Map<string, string | null>();
  let inFlight: Promise<ServiceReconcilerTickResult> | null = null;

  function remaining(deadline: number): number {
    return Math.max(0, Math.floor(deadline - monotonicNow()));
  }

  async function admittedWindow(): Promise<string[]> {
    // Rotate from the cursor; wrap once from the head to fill the window fairly.
    const tail = [...new Set(await input.listAdmittedOrganizationIds({
      afterOrganizationId: cursor,
      limit: maxOrganizations,
    }))].sort().filter((id) => cursor === null || id > cursor).slice(0, maxOrganizations);
    if (cursor === null || tail.length >= maxOrganizations) return tail;
    const head = [...new Set(await input.listAdmittedOrganizationIds({
      afterOrganizationId: null,
      limit: maxOrganizations - tail.length,
    }))].sort();
    const seen = new Set(tail);
    return [...tail, ...head.filter((id) => !seen.has(id))].slice(0, maxOrganizations);
  }

  async function runTick(): Promise<ServiceReconcilerTickResult> {
    if (!enabled) return { ...ZERO_TICK };
    const deadline = monotonicNow() + tickBudgetMs;
    const organizationIds = await admittedWindow();
    const result: ServiceReconcilerTickResult = { ...ZERO_TICK };
    for (const organizationId of organizationIds) {
      if (remaining(deadline) < 1) break;
      // Advance on admission, not completion, so a slow tenant cannot pin the rotation.
      cursor = organizationId;
      result.organizations += 1;
      // ★★★ SVC-003b — THE LIVENESS SWEEP, AND IT RUNS FIRST. An instance the deadline drives
      // `lost` leaves `service_instances_live_service_uq` inside this transaction, so the
      // convergence pages below — whose window predicate IS that index's — see its service as
      // divergent on this very tick. Ordering it after the pages would make every replacement
      // one whole tick late for no reason.
      //
      // Best-effort and counted, exactly like a convergence pass: a tenant whose sweep throws
      // must not cost the rest of the tick, and must not be reported as a reconcile failure.
      try {
        const swept = await sweepOrganizationServiceLiveness(input.appDb, {
          organizationId,
          limit: livenessBatchLimit,
          policy: livenessPolicy,
        });
        result.livenessScanned += swept.scanned;
        result.livenessTerminalized += swept.terminalized.length;
        // Per INSTANCE, so the operator record names the row and the status it was driven out
        // of — see `onTerminalized`'s docstring for what this is and is not.
        for (const entry of swept.terminalized) {
          input.onTerminalized?.({ organizationId, ...entry });
        }
        // A non-empty `refusedIllegal` means the server's derived predecessor set and the
        // frozen table disagree — a defect, not a state — so it is surfaced rather than
        // folded into a count. `livenessDeadlineAllowedFromStatuses`'s load-time assertion
        // should make it unreachable; this is what would say so if it were not.
        for (const refused of swept.refusedIllegal) {
          input.onLivenessFailure?.(
            new Error(
              `SVC-003b: liveness deadline refused as illegal from '${refused.fromStatus}' ` +
                `for instance ${refused.serviceInstanceId}`,
            ),
            { organizationId },
          );
        }
      } catch (error) {
        result.livenessFailed += 1;
        input.onLivenessFailure?.(error, { organizationId });
      }
      // Page through this tenant's running services from its own cursor until the budget is
      // out or the tenant is exhausted. Each window is read in its own short tenant
      // transaction; each PASS then opens its own, so one service's failure cannot roll back
      // another's convergence.
      let serviceCursor = serviceCursors.get(organizationId) ?? null;
      while (remaining(deadline) >= 1) {
        const after: string | null = serviceCursor;
        const window = await runInTenant(input.appDb, organizationId, (repos) =>
          repos.jobControl.listReconcilableServices({
            afterServiceId: after,
            limit: serviceBatchLimit,
          }));
        if (window.length === 0) {
          // End of this tenant's services. Wrap so the next tick starts at the head.
          serviceCursor = null;
          break;
        }
        // ★ Whether the WHOLE page was admitted, not just whether it was short. Wrapping on
        // `window.length < serviceBatchLimit` alone is wrong when the tick budget expires
        // part-way through a short final page: the unprocessed tail would be dropped, the
        // next tick would restart at the head, and under a repeatable timing pattern that
        // tail could starve indefinitely. Caught in review on PR #406.
        let pageFullyProcessed = true;
        for (const row of window) {
          if (remaining(deadline) < 1) {
            pageFullyProcessed = false;
            break;
          }
          // Advance on admission, not on completion, so one wedged service cannot pin the
          // rotation and starve the rest of the tenant on every subsequent tick.
          serviceCursor = row.serviceId;
          result.services += 1;
          try {
            const outcome = await reconcileService(input.appDb, {
              organizationId,
              companyId: row.companyId,
              serviceId: row.serviceId,
            });
            if (outcome.action === "created") result.created += 1;
            else result.unchanged += 1;
          } catch (error) {
            // Per-service and best-effort: one tenant's broken service must not cost the rest
            // of the sweep, and must never fail the tick.
            result.failed += 1;
            input.onPassFailure?.(error, { organizationId, serviceId: row.serviceId });
          }
        }
        // A FULLY PROCESSED short page is the end of the tenant; wrap rather than re-request
        // it next tick. A short page that was cut off mid-way keeps its cursor, so the next
        // tick resumes at the first row this one did not admit.
        if (window.length < serviceBatchLimit && pageFullyProcessed) {
          serviceCursor = null;
          break;
        }
      }
      serviceCursors.set(organizationId, serviceCursor);
    }
    return result;
  }

  return {
    tick() {
      if (inFlight) return inFlight;
      const current = runTick();
      inFlight = current;
      current.finally(() => {
        if (inFlight === current) inFlight = null;
      }).catch(() => {
        // The caller observes the original rejection; this only handles the promise the
        // `finally` returns so it cannot become an unhandled branch.
      });
      return current;
    },
    nextDelayMs(result) {
      // ★ SVC-003b — a TERMINALIZATION is convergence work too, and it must shorten the delay
      // for a reason review measured rather than guessed: if the liveness sweep consumes the
      // tick budget, the convergence pages below it are skipped ENTIRELY on that tick, so the
      // replacement for a just-terminalized instance has not been created yet — and a
      // `created === 0` result would back the loop off to the IDLE delay (30 s by default)
      // exactly when there is known work waiting. It cannot busy-loop: a terminalized row has
      // left the live set, so the next tick's sweep terminalizes it again never, and a tick
      // that condemns nothing and creates nothing returns to the idle delay.
      return result.created > 0 || result.livenessTerminalized > 0 ? activeDelayMs : idleDelayMs;
    },
  };
}
