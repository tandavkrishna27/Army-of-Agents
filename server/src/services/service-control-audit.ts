// server/src/services/service-control-audit.ts
//
// SVC-007 (Unit B) — THE DURABLE AUDIT FOR A SERVICE CONTROL ACTION, WRITTEN WITHOUT A FENCE.
//
// ── THE CLAIM THIS FILE EXISTS BECAUSE IT WAS WRONG ──────────────────────────────────────
//
// `SVC-007a-result.md` §4a(iii) and §7 declined an `activity_log` row for the service routes
// and gave a mechanical reason rather than a scope preference:
//
//   "the shipped distributed-execution audit path is `jobAuditBridge.recordAcceptedActivity`,
//    and its input contract REQUIRES `fence: ActiveFenceRequest` … A service CREATE has no
//    attempt, and a desired-state change has no fence … So that bridge is structurally
//    unusable here, and writing `activity_log` directly would create a SECOND, unguarded
//    audit path that JOB-013's exactly-once machinery does not cover."
//
// The first half is TRUE and re-verified here: `recordAcceptedActivity`'s input type does
// require `fence` (`job-audit-bridge.ts`, `RecordAcceptedActivityInput.fence`), it uses that
// fence twice — `repos.jobControl.lockActiveFence` for the TOCTOU serialization and
// `recordGovernedProjection` for the receipt — and no service control has one.
//
// ★★★ THE SECOND HALF IS MEASURED FALSE, AND THAT IS WHY THESE ROUTES CAN BE AUDITED.
//
//   1. THE FENCE IS NOT `activity_log`'s ADMISSION REQUIREMENT. `insertActivityLog`
//      (`activity-log.ts`) takes a plain `Db` — a transaction handle is one — and requires no
//      lease, no attempt and no fence. The bridge calls it exactly that way itself, on `tx`.
//
//   2. `aoa_app` MAY WRITE THE TABLE, and does not need a policy exemption to do it. The
//      grant is `GRANT SELECT, INSERT ON "activity_log" TO "aoa_app"` (migration `0213`,
//      re-affirmed by `0214`), and `activity_log` carries no RLS at all — migration `0245`'s
//      own header says so in as many words: "`activity_log` and `hub_audit` are deliberately
//      NOT touched here: both are CAV-005 legacy, non-forced, app-layer-company-scoped tables
//      (table-level grants to aoa_app — activity_log SELECT+INSERT …) — already cover the
//      transactional audit writes."
//
//   3. ★ A FENCELESS TRANSACTIONAL `activity_log` WRITE ALREADY SHIPS ON THE DISTRIBUTED
//      PATH, so this is not a second audit path — it is the SAME one, used a third time.
//      `stageJobInputFiles` (`job-input-staging.ts`) writes one bundle-level audit row with
//      `insertActivity(tx, …)` inside `runInTenant`, with `leaseId` and `fenceToken` NULL and
//      no receipt, and its own comment forbids "tidying" it behind a fence: *"NO LEASE, NO
//      FENCE … do not 'tidy' this behind `guardActiveFence`, which cannot be satisfied here
//      and would remove the capability rather than secure it."* Measured at the base commit
//      of this unit with the register's own `countProductionCallers`: `stageJobInputFiles`
//      has **2** production callers (reached from `server/src/index.ts`), while
//      `jobAuditBridge` has **0**. The fenced bridge is the path with no callers; the
//      fenceless transactional write is the one that runs.
//
// ── WHAT REPLACES THE RECEIPT, AND WHY IT IS NOT A WEAKER GUARD HERE ─────────────────────
//
// JOB-013's receipt exists for a problem these routes do not have. Its header states it:
// "insertActivityLog has NO native dedup. On a replay the JOB-005 receipt identity … is the
// guard". The word doing the work is REPLAY. The bridge audits an accepted mutation on a
// distributed attempt, delivered at-least-once: the SAME `acceptedEventId` can arrive twice,
// the mutation may already have been applied by the earlier delivery, and the audit insert
// would then be the ONLY new write in its transaction — so nothing else in that transaction
// pins it and it needs an identity-keyed receipt of its own.
//
// ★ A SERVICE CONTROL ACTION IS NOT REPLAYED; IT IS RE-REQUESTED, AND THE TWO ARE DIFFERENT
// EVENTS. There is no at-least-once redelivery machinery in front of these routes: an
// operator's POST is a synchronous request, and a retried POST is a SECOND control action,
// not a second copy of the first. `SVC-007a-result.md` §7 says so about the mutation itself —
// "`services` has no natural key and no idempotency column, so two POSTs create two services".
// Two services must produce two audit rows. A receipt keyed on a client-chosen id would make
// the audit UNDER-report exactly where the mutation over-produced, which is the wrong
// direction for an audit surface.
//
// ★★★ SO THE REPLAY GUARD IS THE TRANSACTION, AND IT IS EXACT RATHER THAN APPROXIMATE. The
// audit row is written inside the SAME tenant transaction as the mutation it describes:
//
//     committed transaction  →  exactly one mutation AND exactly one audit row
//     rolled-back transaction →  no mutation AND no audit row
//
// There is no interleaving in which the two disagree, because there is no window in which one
// is durable and the other is not. That is a STRONGER guarantee than the bridge's, not a
// weaker one — the bridge's receipt reconciles two things that can be written apart; here they
// cannot be written apart at all. The property is pinned by the rollback probes in
// `service-management.integration.test.ts` (T1 and T13, extended by this unit to count audit
// rows), and the mutant that must re-red them is "move the audit insert outside the
// transaction".
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ──────────────────────────────────────────────
//
//   * It writes NO `job_projection_receipts` row. It has no fence, and
//     `job_projection_receipts.source_fence` is NOT NULL — the same forced answer SVC-007a's
//     §5 backstop reached for the same reason.
//   * It does NOT touch `jobAuditBridge`. That bridge stays at zero production callers and
//     its gap stays on the register (E0's DE-01 row names it). Nothing here closes DE-01,
//     whose `audit` clause is about "query and policy-denial events" — a different clause
//     from AGENTS.md's "activity logging for all mutating actions", which is the one this
//     file is about.
//   * It does NOT audit the THREE sibling mutations on the same router — job submission
//     (`POST …/jobs`, pre-dating JOB-008) plus JOB-008's `drain` and `revoke`. All three are
//     still silent, which is why `E9-F010` stays OPEN rather than resolving here. That is
//     SVC-007a's observation and it remains true; see `SVC-007b-result.md`.
//   * It does NOT audit a REFUSED control action. An `illegal` or `conflict` verdict mutates
//     nothing, and an `absent` one returns a uniform 404 precisely so an unauthorized reader
//     cannot distinguish "no such service" from "another tenant's service" — auditing it
//     would not leak (the row is company-scoped) but there is no mutation to record. The
//     invariant is over MUTATING actions. Refusals are a denial-audit question and belong to
//     `security-denial-audit.ts`'s reserved namespace, not here.
//
// ── EACH ACTION IS HARD-CODED HERE, AND THAT IS THE RULE BEING FOLLOWED ──────────────────
//
// `activity-namespace.ts` states the rule for anyone adding a writer: "a direct
// `insert(activityLog)` must hard-code its `action`; if the action comes from the caller,
// route through `insertActivityLog` instead." This file does BOTH — one function per action
// with the action as a module constant, AND the write goes through `insertActivity` →
// `insertActivityLog`, so `assertUnreservedActivityNamespace` runs over it anyway. The
// constants are exported so the route's structured log line and the durable row read the same
// string and cannot drift into two names for one act.

import type { Db } from "@armyofagents/db";
import type { ActivityActorType } from "@armyofagents/shared";
import { insertActivity, publishActivity, type PreparedActivityEvent } from "./activity-log.js";

/** The `entity_type` every service-control audit row carries, so
 *  `activity_log_entity_type_id_idx` answers "what happened to this service". */
export const SERVICE_AUDIT_ENTITY_TYPE = "service";

/** The audited action for a service create. Also the route's structured-log `action`. */
export const SERVICE_CREATE_ACTION = "service.create";

/** The audited action for a desired-state control. Also the route's structured-log `action`. */
export const SERVICE_DESIRED_STATE_ACTION = "service.desired_state";

/**
 * The audited action for a generation ROLL. Also the route's structured-log `action`, so the
 * `logger.info` line and the durable row read the same string and cannot drift into two names
 * for one act — exactly the discipline the two constants above enforce for create and stop.
 *
 * ★ A PLAIN OPERATIONAL ACTION, NOT A RESERVED `security.denied.` ONE. A roll is a mutating
 * control action, not a denial, so it carries a company id and a non-reserved namespace — which
 * is precisely what `activity_log_company_or_denial_check` requires of every product row.
 */
export const SERVICE_GENERATION_ROLL_ACTION = "service.generation_roll";

/**
 * WHO performed the control action.
 *
 * ★ `actorId` IS NOT NULLABLE AND DOES NOT NEED A FALLBACK. `activity_log.actor_id` is NOT
 * NULL, and `jobControlRoutes.assertOrgAdmin` already refuses (403) any caller without a
 * board `userId` BEFORE the handler reaches a mutation — so by the time a control action
 * exists there is always a real user id to attribute it to.
 */
export interface ServiceControlActor {
  actorType: ActivityActorType;
  actorId: string;
}

export interface ServiceCreateAuditInput {
  actor: ServiceControlActor;
  companyId: string;
  organizationId: string;
  serviceId: string;
  generation: number;
  desiredState: string;
}

export interface ServiceDesiredStateAuditInput {
  actor: ServiceControlActor;
  companyId: string;
  organizationId: string;
  serviceId: string;
  /** `updated` or `unchanged` — the two verdicts that can mutate. */
  outcome: string;
  /** Absent on `unchanged`: there was no edge to traverse. */
  from?: string;
  to: string;
  generation: number;
  /** The operator's bounded reason, already length-limited by the route body schema. */
  reason: string;
  /** What happened to the live instance, mirroring `SetServiceDesiredStateResult.stop`. */
  stopStatus: string | null;
  stopInstance: string | null;
}

/**
 * ★ `runId` IS FORCED NULL AT THE ONE PLACE BOTH WRITERS PASS THROUGH, for the identical
 * reason the JOB-013 bridge forces it and `stageJobInputFiles` restates: `activity_log.run_id`
 * has an FK to `heartbeat_runs`, a distributed attempt id is not a heartbeat run, and passing
 * one would raise 23503 and roll the MUTATION back with it. There is no run id in scope on
 * either control path today; forcing it here means a future caller cannot introduce one by
 * accident.
 *
 * ★ `agentId` IS LIKEWISE NULL. A service control is an operator act. Attributing it to an
 * agent would make `activity_log.agent_id` answer a question nobody asked.
 */
async function insertServiceControlActivity(
  tx: Db,
  input: {
    actor: ServiceControlActor;
    companyId: string;
    action: string;
    serviceId: string;
    details: Record<string, unknown>;
  },
): Promise<PreparedActivityEvent> {
  return insertActivity(tx, {
    companyId: input.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    action: input.action,
    entityType: SERVICE_AUDIT_ENTITY_TYPE,
    entityId: input.serviceId,
    agentId: null,
    runId: null,
    details: input.details,
  });
}

/**
 * Record that an operator created a service — INSIDE the transaction that created it.
 *
 * Returns the prepared event so the caller can publish it AFTER commit. It is deliberately
 * NOT published here: `publishActivity` pokes a live channel, and a pre-commit poke would
 * announce a service that a later rollback un-creates.
 */
export async function recordServiceCreateActivity(
  tx: Db,
  input: ServiceCreateAuditInput,
): Promise<PreparedActivityEvent> {
  return insertServiceControlActivity(tx, {
    actor: input.actor,
    companyId: input.companyId,
    action: SERVICE_CREATE_ACTION,
    serviceId: input.serviceId,
    details: {
      organizationId: input.organizationId,
      serviceId: input.serviceId,
      generation: input.generation,
      desiredState: input.desiredState,
    },
  });
}

/**
 * Record that an operator moved a service's desired state — INSIDE the transaction that moved
 * it, and that also cancelled the live instance's job when the move was a stop.
 *
 * ★ THE OPERATOR'S `reason` REACHES A DURABLE SINK ON EVERY VERDICT THAT MUTATES, which is the
 * half of external review's P1 that SVC-007a fixed only for the structured log. A stop already
 * carried it into `job_control_commands.body` through `requestCancellation`; a resume carried
 * it nowhere durable. It is on the row now, for both.
 */
export async function recordServiceDesiredStateActivity(
  tx: Db,
  input: ServiceDesiredStateAuditInput,
): Promise<PreparedActivityEvent> {
  return insertServiceControlActivity(tx, {
    actor: input.actor,
    companyId: input.companyId,
    action: SERVICE_DESIRED_STATE_ACTION,
    serviceId: input.serviceId,
    details: {
      organizationId: input.organizationId,
      serviceId: input.serviceId,
      outcome: input.outcome,
      // `from` is absent on `unchanged` — recorded as null rather than omitted, so a reader
      // of the row does not have to know which verdicts carry the key.
      from: input.from ?? null,
      to: input.to,
      generation: input.generation,
      reason: input.reason,
      stopStatus: input.stopStatus,
      stopInstance: input.stopInstance,
    },
  });
}

export interface ServiceGenerationRollAuditInput {
  actor: ServiceControlActor;
  companyId: string;
  organizationId: string;
  serviceId: string;
  /** The generation the service moved OFF. */
  from: number;
  /** The generation the service moved ON to — always `from + 1`. */
  to: number;
  /**
   * The operator's bounded reason, already length-limited by the route body schema. Recorded
   * durably for the SAME reason SVC-007a's P1 fix recorded the desired-state reason: the roll
   * route REQUIRES a `reason` and, before this row, carried it only into a `logger.info` line
   * that does not outlive the process. A field the caller is forced to supply must reach a
   * durable sink.
   */
  reason: string;
  /** The desired state the roll left UNCHANGED (a roll never moves it), mirroring the route's
   *  structured log line so the durable row and the process log carry the same facts. */
  desiredState: string;
  /** What the roll did to the old generation's live instance, if it had one — the same
   *  `RollDrainResult.status` the route logs. `null` when there was no drain to attempt. */
  drainStatus: string | null;
}

/**
 * SVC-005a / DE-12 conjunct 3c — record that an operator ROLLED a service to its next
 * generation, INSIDE the transaction that performed the roll.
 *
 * ★ THIS IS THE DURABLE HALF DE-12's `audit` clause NAMES BY "generation changes are audited".
 * Before this, a roll emitted only a `logger.info` line — ephemeral, and not a record. The
 * register's DE-12 row and the roll route's own comment cited E9-F009 §3 as the standing reason
 * a durable row was not written; that reason is a REPOSITORY-layer measurement (no method under
 * `packages/db/src/repositories/tenant/` writes `activity_log`), and this write is a
 * SERVICE-layer one — the same convention SVC-007b established for create and desired-state,
 * which E9-F010's own partial correction says a reader must not carry the §3 measurement across
 * to. So there is ONE audit path here, used a third time, not a second one.
 *
 * ★ ONLY AN ACTUAL GENERATION CHANGE IS AUDITED. The caller records this ONLY on the `rolled`
 * verdict — never on `absent`, `desired_state_forbids`, `generation_exists` or `conflict`, none
 * of which move the column. A `generation_exists` outcome is a NO-OP roll (a concurrent roll
 * already minted N+1); auditing it would say a generation changed when none did. The invariant
 * is over MUTATING actions, exactly as `recordServiceDesiredStateActivity` audits only the two
 * verdicts that mutate.
 *
 * Returns the prepared event so the transaction's OWNER can publish it AFTER commit — not here,
 * because a pre-commit poke would announce a roll a later rollback un-does.
 */
export async function recordServiceGenerationRollActivity(
  tx: Db,
  input: ServiceGenerationRollAuditInput,
): Promise<PreparedActivityEvent> {
  return insertServiceControlActivity(tx, {
    actor: input.actor,
    companyId: input.companyId,
    action: SERVICE_GENERATION_ROLL_ACTION,
    serviceId: input.serviceId,
    details: {
      organizationId: input.organizationId,
      serviceId: input.serviceId,
      fromGeneration: input.from,
      toGeneration: input.to,
      reason: input.reason,
      desiredState: input.desiredState,
      drainStatus: input.drainStatus,
    },
  });
}

/**
 * Publish the prepared audit events AFTER their transaction has committed.
 *
 * ★ BEST-EFFORT, PER EVENT, exactly as the JOB-013 bridge drains its own: a live-channel poke
 * that throws must never turn a committed control action into a 500. The durable row is the
 * invariant; the poke is the feed catching up.
 */
export function publishServiceControlActivity(events: readonly PreparedActivityEvent[]): void {
  for (const event of events) {
    try {
      publishActivity(event);
    } catch {
      /* best-effort live poke — the row is already durable */
    }
  }
}
