// server/src/services/service-generation-rollout.ts
//
// SVC-005a — THE GENERATION ROLLOUT FENCE.
//
// ── WHAT WAS NOT TRUE BEFORE THIS FILE ───────────────────────────────────────────────────
//
// `services.generation` HAD NO WRITER. The column has been `notNull().default(1)` since
// E2-D06; it is read as a WHERE predicate in exactly one place (`serviceSourceIsAdmitted`,
// packages/db/src/repositories/tenant/job-control.ts) and pinned under a row lock in another
// (`lockServiceForReconcile`), and `update(services)` for `generation` appeared ZERO times in
// the tree. Three shipped records say so in their own words:
//
//   * SVC-002-design.md: "SVC-002 reads generation under a row lock and never bumps it;
//     services.generation still has no writer after this ticket."
//   * SVC-007a: writes the IMMUTABLE generation-1 row via `insertServiceGeneration` and
//     deliberately does not bump — `updateServiceDesiredState`'s own docstring says minting a
//     new generation without SVC-005's fence "is exactly the overlap E9's acceptance forbids".
//   * The DE-12 register row (docs/architecture/distributed-execution-threat-controls.json):
//     the generation deny "cannot fire in production" partly because "services.generation HAS
//     NO WRITER ... so no generation rollover can be performed and the fence has nothing to
//     refuse", and E0-F013's founder ruling dropped the audit conjunct as VACUOUS on that
//     measurement.
//
// This file is that writer, and the fence that makes writing it safe.
//
// ── ★★★ THE PROPERTY IS ABOUT THE WORLD, NOT ABOUT A COLUMN ─────────────────────────────
//
// E9's acceptance for SVC-005 is: "No two generations may perform external effects
// simultaneously." That is a claim about two PROCESSES, not about an integer. Bumping the
// integer performs no external effect at all; the dangerous moment is when an instance of
// generation N+1 STARTS while a worker of generation N is still running. So the fence lives at
// PLACEMENT, and it is built out of two facts:
//
//   (A) PLACEMENT OVERLAP IS ALREADY STRUCTURALLY IMPOSSIBLE, and not by anything here.
//       `service_instances_live_service_uq` is a partial unique index permitting exactly ONE
//       non-terminal instance per (organization, service), and SVC-002's
//       `listReconcilableServices` filters on the byte-identical predicate. So the reconciler
//       CANNOT place generation N+1 while generation N's instance is live — whatever
//       `services.generation` says. Rolling the integer therefore yields REPLACE-AFTER-STOP by
//       construction, and REPLACE-BEFORE-STOP is not reachable at all. E9's Outcome names both
//       policies; only one of them is deliverable under this index, and that is stated in
//       SVC-005a-result.md §7 rather than papered over.
//
//   (B) THE HOLE IS E9-F007, AND IT IS THE WHOLE REASON THIS FILE EXISTS. SVC-003b's liveness
//       deadline drives an instance `lost` BY A CLOCK when its worker has gone silent. The row
//       leaves the live index — so (A) stops protecting anything — while the worker "may still
//       be running and still performing external effects" (E9-F007 §2, filed by SVC-003b in
//       the commit that created the condition). Placing generation N+1 on the strength of such
//       a row is EXACTLY the overlap the acceptance clause forbids, reached by a rollout rather
//       than by a same-generation replacement.
//
// So: a CROSS-GENERATION placement is fenced on whether the previous generation's instance
// ended WITH A WITNESS. That is what `service_instances.terminalized_by` (migration 0279) is
// for, and it is a fence input rather than telemetry.
//
// ── ★★★ WHAT HAPPENS IF THE OLD GENERATION'S WORKER IS UNREACHABLE AT THE BUMP ──────────
//
// The question this ticket must answer out loud, because "a rollout that assumes the old
// generation stopped because we asked it to" is the fail-open SVC-008b already taught E9.
//
//   1. `rollServiceGeneration` mints generation N+1 and bumps the column, and — if an instance
//      is live — issues the SAME graceful stop SVC-007a's operator stop issues
//      (`requestCancellation({graceful:true})` plus the attempt-terminal backstop), in ONE
//      transaction under the service's row lock.
//   2. That stop is a REQUEST. It writes a `job_control_commands` row the worker collects on
//      its next `renewLease`. An unreachable worker never collects it. NOTHING about step 1
//      establishes that the old process stopped, and this file does not pretend otherwise.
//   3. Because the generation-N instance is still LIVE, (A) holds and the reconciler places
//      nothing. The rollout simply does not progress. That is the honest stall, and it is the
//      correct behaviour: an un-drained old generation blocks the new one.
//   4. Eventually SVC-003b's deadline condemns the silent instance by a clock. The row leaves
//      the live index with `terminalized_by = 'liveness_deadline'` — an ASSUMPTION. Now (B)
//      applies: `assertCrossGenerationDrain` refuses the placement, and the reconciler reports
//      `predecessor_generation_unwitnessed` instead of starting generation N+1 beside a worker
//      that may still be running.
//   5. THE STALL CLEARS — it is not a wedge, which is the failure class this epic keeps
//      meeting — when the old instance's ATTEMPT reaches a terminal status. That is a real
//      control-plane fact with a verifiable consequence: `classifyFence` returns
//      `attempt_terminal` BEFORE any other test (packages/db/src/repositories/tenant/
//      job-fence.ts), so from that moment the old worker cannot write ANYTHING through the
//      fenced ingest. Lease expiry plus `reapExpiredLeases` reaches that state without any
//      cooperation from the worker, so the stall is bounded by the lease TTL and the reaper
//      interval rather than by the worker's goodwill.
//
// ★ AND THE RESIDUAL, NOT CLAIMED CLOSED. A closed fence stops the old worker WRITING. It does
// not stop its PROCESS, and no control-plane fact can — E9-F007 §3 says so explicitly and this
// ticket does not overturn it. So SVC-005a delivers "no two generations are PLACED while the
// older one is un-drained or unwitnessed", which is the fenceable half of the acceptance
// clause. It does NOT deliver "no two generations perform external effects simultaneously" in
// full, and **the clause is not claimed**. See SVC-005a-result.md §2 and E9-F012.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT WEAKEN ─────────────────────────────────────────
//
//   * SVC-003a's stale-generation refusal (`applyServiceProjectionForFence` step 3) is
//     UNTOUCHED. It compares the worker's claim against the INSTANCE's generation, never
//     against `services.generation` — which is precisely what lets a generation-N worker keep
//     projecting onto its own generation-N instance WHILE it is being drained past a bump.
//     SVC-003a wrote that sentence in anticipation of this ticket; the bump lands exactly as
//     that design assumed and the refusal still refuses. `R-T8` is the pin.
//   * E9-F007's ruling on SAME-generation replacement stands. A replacement at the SAME
//     generation is NOT fenced here — that overlap was ruled the smaller harm against the
//     permanent wedge of never terminalizing, and SVC-005a does not reopen it. The acceptance
//     clause is about two GENERATIONS.

import { randomUUID } from "node:crypto";
import type { Db, TenantRepositories } from "@armyofagents/db";
import { WITNESSED_SERVICE_INSTANCE_TERMINAL_AUTHORS } from "@armyofagents/db";
import { SERVICE_DESIRED_STATES, type ServiceDesiredState } from "@armyofagents/worker-protocol";
import { runInTenant } from "../db/tenant-context.js";
import { assertAdmissibleOrganization } from "./tenant-admission.js";
import {
  CANCELLED_ATTEMPT_PROJECTION,
  type ServiceControlAuditContext,
  type ServiceDefinition,
} from "./service-management.js";
import type { PreparedActivityEvent } from "./activity-log.js";
import {
  publishServiceControlActivity,
  recordServiceGenerationRollActivity,
  type ServiceControlActor,
} from "./service-control-audit.js";

/**
 * The desired states a generation roll may be issued against.
 *
 * `deleted` is excluded and it is the only exclusion: it is the tombstone and the FROZEN
 * `SERVICE_DESIRED_TRANSITIONS` gives it no outgoing edges, so a service that reached it can
 * never run again and a new immutable definition for it would be a row nothing can ever read.
 *
 * `stopped` and `paused` ARE included, deliberately. Rolling a service that is not running is
 * the SAFEST time to roll it — there is nothing to drain — and refusing it would push
 * operators toward the one ordering the fence has to work hardest on (resume, then roll).
 */
export const ROLLABLE_DESIRED_STATES: readonly ServiceDesiredState[] = Object.freeze([
  "running",
  "paused",
  "stopped",
]);

// Asserted rather than assumed, exactly as SVC-007a asserts its two lists: a state spelled
// wrong here would be indistinguishable from a real one until a live service hit it.
for (const state of ROLLABLE_DESIRED_STATES) {
  if (!(SERVICE_DESIRED_STATES as readonly string[]).includes(state)) {
    throw new Error(
      `${JSON.stringify(state)} is not a member of the frozen SERVICE_DESIRED_STATES.`,
    );
  }
}

/**
 * SVC-005a — ONE terminal instance of a PREVIOUS generation, as the fence sees it.
 *
 * Deliberately structural rather than a boolean: the fence must be able to NAME what blocked
 * a placement, because "the rollout is stuck" with no row cited is the shape of a wedge nobody
 * can diagnose.
 */
export interface GenerationPredecessor {
  serviceInstanceId: string;
  generation: number;
  status: string;
  terminalizedBy: string | null;
  attemptStatus: string | null;
}

/** Is this terminal row a WITNESS that the worker stopped? */
export function isWitnessedTerminalAuthor(author: string | null): boolean {
  // NULL is UNKNOWN — a row terminalized before migration 0279 — and UNKNOWN is not a witness.
  // Written as an explicit early return rather than left to `includes(null as never)` so the
  // fail-closed treatment of NULL is legible at the call site rather than incidental.
  if (author === null) return false;
  return (WITNESSED_SERVICE_INSTANCE_TERMINAL_AUTHORS as readonly string[]).includes(author);
}

/**
 * SVC-005a — ★★★ THE CROSS-GENERATION PLACEMENT FENCE, as a PURE function.
 *
 * Pure because the whole value of this decision is that it can be exercised over every
 * combination of (author, attempt status) without a database, and because the reconciler must
 * be able to consult it inside a transaction it already holds.
 *
 * Returns the blocking predecessor, or `null` when placement may proceed.
 *
 * ★ AN EMPTY INPUT IS A PASS, and that is correct rather than a fail-open: the repository read
 * that feeds this ALREADY applies all three conditions in SQL (different generation, not a
 * witness, attempt not terminal), so an empty list means the database found nothing blocking.
 * This function re-derives the WITNESS condition anyway — belt to that braces — so that a
 * future caller which widens the query cannot accidentally admit a witnessed row, and so that
 * the classification lives in ONE readable place rather than only in a WHERE clause.
 */
export function findBlockingPredecessor(
  candidates: readonly GenerationPredecessor[],
): GenerationPredecessor | null {
  for (const candidate of candidates) {
    if (isWitnessedTerminalAuthor(candidate.terminalizedBy)) continue;
    return candidate;
  }
  return null;
}

export type RollServiceGenerationVerdict =
  /** The immutable generation N+1 row was minted and `services.generation` moved to it. */
  | {
      outcome: "rolled";
      from: number;
      to: number;
      desiredState: string;
    }
  /** No such service in this tenant. A definite absence, never an existence oracle. */
  | { outcome: "absent" }
  /** The service is `deleted`. See {@link ROLLABLE_DESIRED_STATES}. */
  | { outcome: "desired_state_forbids"; desiredState: string }
  /**
   * `service_generations_service_generation_uq` already holds a row for generation N+1. Under
   * the service's row lock this means a concurrent roll won, and it is reported rather than
   * retried — the caller re-reads and decides.
   */
  | { outcome: "generation_exists"; generation: number }
  /**
   * The compare-and-set on `services.generation` matched no row despite the lock: something
   * wrote the column without taking it. Surfaced as a defect, not converged.
   */
  | { outcome: "conflict"; expected: number };

/** What the roll did to the OLD generation's live instance, if it had one. */
export type RollDrainResult =
  | null
  | { status: "no_instance" }
  | { status: "no_job"; serviceInstanceId: string }
  | {
      status: "requested";
      serviceInstanceId: string;
      generation: number;
      jobId: string;
      cancellation: string;
      instance: string;
    };

export interface RollServiceGenerationResult {
  verdict: RollServiceGenerationVerdict;
  /**
   * ★ `drain` IS NOT A SUCCESS SIGNAL. `status:"requested"` means a control command was
   * WRITTEN, not that the old worker obeyed it or even collected it. The rollout's actual
   * progress is gated by the placement fence, not by this field. See the file header, §4.
   */
  drain: RollDrainResult;
}

export interface RollServiceGenerationInput {
  organizationId: string;
  companyId: string;
  serviceId: string;
  definition: ServiceDefinition;
  /** The bounded operator reason, carried into the drain's control command. */
  reason: string;
  createdBy: string | null;
  /**
   * WHO performed the roll — the durable `activity_log` row's attribution (SVC-005a / DE-12
   * conjunct 3c). REQUIRED, not optional, for the same reason `createService`'s actor is: a
   * mutating control action with nowhere to record who took it is the invariant AGENTS.md §3
   * names, and an optional parameter would leave that invariant as unenforced as a convention.
   * `jobControlRoutes.assertOrgAdmin` has already refused any caller without a board user id
   * before a roll can be requested, so this is always a real user id.
   */
  actor: ServiceControlActor;
}

/**
 * Roll one service to its next generation inside ONE already-open tenant transaction.
 *
 * ★ THE SINGLE TRANSACTION UNDER THE SERVICE'S OWN ROW LOCK IS THE SAME FIX SVC-007a TOOK
 * AFTER EXTERNAL REVIEW OF PR #412, and for the same reason. If the generation write committed
 * and the lock were released before the drain, a concurrent `stopped → running` (or a
 * concurrent reconcile pass) could land in the gap and the drain would then take down an
 * instance the operator had just resumed. Under one lock that interleaving is unrepresentable.
 *
 * ★ LOCK ORDER, stated rather than assumed. Identical to `setServiceDesiredStateWithinTenant`'s
 * and therefore introducing no new edge: the per-service advisory lock and the `services` row
 * FIRST, then `requestCancellation`'s own `lease → attempt → job` hierarchy untouched, then
 * `service_instances`. No cycle is constructible that SVC-007a's header did not already rule
 * out.
 *
 * ★ THE MINT PRECEDES THE BUMP, and the order matters. `findServiceGenerationDefinition` reads
 * `service_generations` at `services.generation`, so a committed bump with no matching
 * definition row would make the reconciler answer `no_generation` FOREVER — the permanent
 * silent wedge SVC-007a's create path exists to avoid, reached from the other side. Inside one
 * transaction either order is atomic; the mint is written first so that even a future
 * refactor which splits them fails in the recoverable direction (an orphan definition row is
 * inert; an orphan bump is a wedge).
 */
export async function rollServiceGenerationWithinTenant(
  repos: TenantRepositories,
  input: RollServiceGenerationInput,
  audit: ServiceControlAuditContext,
): Promise<RollServiceGenerationResult> {
  const service = await repos.jobControl.lockServiceForReconcile({
    organizationId: input.organizationId,
    companyId: input.companyId,
    serviceId: input.serviceId,
  });
  if (!service) return { verdict: { outcome: "absent" }, drain: null };

  if (!(ROLLABLE_DESIRED_STATES as readonly string[]).includes(service.desiredState)) {
    return {
      verdict: { outcome: "desired_state_forbids", desiredState: service.desiredState },
      drain: null,
    };
  }

  const from = service.generation;
  const to = from + 1;

  // (1) The IMMUTABLE definition for the new generation. Same repository method SVC-007a uses
  // for generation 1, so there is ONE writer of `service_generations` rather than two ideas of
  // what a generation row is.
  const minted = await repos.jobControl.insertServiceGeneration({
    organizationId: input.organizationId,
    companyId: input.companyId,
    serviceId: input.serviceId,
    generation: to,
    definition: {
      command: input.definition.command,
      args: input.definition.args,
      gracefulStopSeconds: input.definition.gracefulStopSeconds,
    },
    createdBy: input.createdBy,
  });
  // `null` is a 23505 against `service_generations_service_generation_uq`, absorbed by that
  // method's SAVEPOINT so this transaction is still usable. Under the row lock it means a
  // concurrent roll already minted N+1.
  if (!minted) return { verdict: { outcome: "generation_exists", generation: to }, drain: null };

  // (2) THE BUMP. The writer `services.generation` has never had.
  const bumped = await repos.jobControl.bumpServiceGeneration({
    organizationId: input.organizationId,
    companyId: input.companyId,
    serviceId: input.serviceId,
    expectedGeneration: from,
  });
  if (!bumped) return { verdict: { outcome: "conflict", expected: from }, drain: null };

  const verdict: RollServiceGenerationVerdict = {
    outcome: "rolled",
    from,
    to: bumped.generation,
    desiredState: service.desiredState,
  };

  // (3) THE DRAIN. Without it the rollout waits for the old instance to die of old age, which
  // for a healthy service is never: nothing else in the tree asks a running service to stop
  // when its definition changes.
  //
  // ★ IT IS THE SAME COMPOSITION SVC-007a's OPERATOR STOP USES, reached directly rather than
  // through `setServiceDesiredStateWithinTenant`, because a roll must NOT move `desired_state`
  // — a rolled `running` service must stay `running` so the reconciler places N+1 the moment
  // the old instance leaves the live index.
  //
  // ★ COMPUTED INTO A LOCAL RATHER THAN RETURNED AT EACH EXIT, so the audit row below can fire
  // ONCE after it, carrying the drain's outcome, on every `rolled` path. The three drain exits
  // are all the SAME `rolled` verdict; recording the audit at each would be three call sites to
  // keep in step, the shape SVC-007b split `applyServiceDesiredState` out to avoid.
  const drain: RollDrainResult = await (async (): Promise<RollDrainResult> => {
    const instance = await repos.jobControl.findLiveServiceInstance({
      organizationId: input.organizationId,
      serviceId: input.serviceId,
    });
    if (!instance) return { status: "no_instance" };
    if (!instance.jobId) {
      return { status: "no_job", serviceInstanceId: instance.serviceInstanceId };
    }
    const jobId = instance.jobId;
    const now = await repos.jobControl.currentDatabaseTime();
    const cancellation = await repos.jobControl.requestCancellation({
      organizationId: input.organizationId,
      companyId: input.companyId,
      jobId,
      reason: input.reason,
      graceful: true,
      commandId: randomUUID(),
      now,
    });
    // ★ ALWAYS ATTEMPTED, NEVER GATED ON THE CANCELLATION'S REPORTED STATUS — SVC-007a's
    // reasoning, unchanged: the precondition that matters ("the attempt is terminal and did not
    // succeed") is a DATABASE fact the repository re-reads under the instance's row lock, so
    // matching on a returned string here would be a second, weaker gate. E9-F006 is the failure
    // this closes on the roll path too: `requestCancellation` FINALIZES rather than drains when
    // there is no fenced worker, emitting no event, so without this call the instance would stay
    // non-terminal inside `service_instances_live_service_uq` forever and generation N+1 would
    // never be placed. That is the residual E9-F006 §4 warned SVC-005 about BY NAME.
    const terminalized = await repos.jobControl.terminalizeServiceInstanceForCancelledAttempt({
      organizationId: input.organizationId,
      companyId: input.companyId,
      jobId,
      toStatus: CANCELLED_ATTEMPT_PROJECTION.toStatus,
      allowedFromStatuses: CANCELLED_ATTEMPT_PROJECTION.allowedFromStatuses,
    });
    return {
      status: "requested",
      serviceInstanceId: instance.serviceInstanceId,
      generation: instance.generation,
      jobId,
      cancellation: cancellation.status,
      instance: terminalized.outcome,
    };
  })();

  // (4) ★★★ THE DURABLE AUDIT — DE-12 conjunct 3c ("generation changes are audited").
  //
  // Recorded ONLY here, on the `rolled` verdict, and INSIDE this transaction, so it commits with
  // the mint and the bump or not at all — the same transaction-as-replay-guard SVC-007b relies
  // on for create and desired-state (`service-control-audit.ts`). A NO-OP roll never reaches
  // this line: `absent`, `desired_state_forbids`, `generation_exists` and `conflict` all return
  // above the bump, and none of them moves the column, so none is audited — a generation-change
  // record is written exactly when a generation changed. The `logger.info` line the route still
  // emits is process telemetry; THIS row is the record.
  audit.published.push(await recordServiceGenerationRollActivity(audit.tx, {
    actor: audit.actor,
    companyId: input.companyId,
    organizationId: input.organizationId,
    serviceId: input.serviceId,
    from,
    to: bumped.generation,
    reason: input.reason,
    desiredState: service.desiredState,
    drainStatus: drain?.status ?? null,
  }));

  return { verdict, drain };
}

export interface ServiceRolloutDependencies {
  appDb: Db;
}

/** Roll one service's generation, opening (and on failure ROLLING BACK) its own transaction. */
export async function rollServiceGeneration(
  deps: ServiceRolloutDependencies,
  input: RollServiceGenerationInput,
): Promise<RollServiceGenerationResult> {
  // Parity with `createService`, `setServiceDesiredState` and the reconciler: a forbidden
  // sentinel organization must never reach the distributed path by an unguarded route
  // (FND-007, Decision #121). THROWS rather than returning a refusal — a sentinel org here is
  // a programming error, not a state a caller can be in.
  assertAdmissibleOrganization(input.organizationId);
  // ★ THE AUDIT SINK, DRAINED AFTER COMMIT. Identical shape to `createService` and
  // `setServiceDesiredState`: the prepared `activity.logged` event is collected inside the
  // transaction and published only once it has committed. A mid-transaction throw exits
  // `runInTenant` and never reaches the publish, so a rollback announces nothing.
  const published: PreparedActivityEvent[] = [];
  const result = await runInTenant(deps.appDb, input.organizationId, (repos, tx) =>
    rollServiceGenerationWithinTenant(repos, input, { tx, actor: input.actor, published }));
  publishServiceControlActivity(published);
  return result;
}
