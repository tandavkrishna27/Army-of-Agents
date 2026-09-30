// server/src/services/service-management.ts
//
// SVC-007 (Unit A) — THE TWO SYMBOLS THAT MAKE E9 REAL, and the control that makes shipping
// them safe.
//
// ── WHAT WAS NOT TRUE BEFORE THIS FILE ───────────────────────────────────────────────────
//
// Three shipped documents said the same two sentences, and both were right:
//
//   * "NOTHING CREATES A SERVICE." `repos.services.insert` existed with ZERO production
//     callers and there was no route (SVC-002-result.md §7, SVC-003a-result.md §2, and the
//     `E9-1`/`E9-3` gate-clause reasons).
//   * "NOTHING WRITES A GENERATION", so `findServiceGenerationDefinition` answered `null` for
//     every service on every real deployment and EVERY reconcile pass stalled at
//     `{action:"none", reason:"no_generation"}`.
//
// SVC-002 built the reconciler, SVC-003a built the projection, and neither could run on a
// real deployment because there was no row to reconcile. This file writes those rows.
//
// ── WHY THE STOP CONTROL SHIPS IN THE SAME UNIT, RATHER THAN LATER ───────────────────────
//
// A create path with no stop path is not a smaller version of this ticket; it is a worse
// one. The thing being created is a workload that DOES NOT END, whose replacement the
// reconciler mints automatically whenever its instance goes terminal. Shipping the producer
// without the off switch would leave an operator with a spend loop and no lever — so
// `setServiceDesiredState` is part of Unit A by necessity, not by scope creep.
//
// ★★★ AND THE OFF SWITCH ACTUALLY SWITCHES SOMETHING OFF, which is the part that is easy to
// get wrong. `services.desired_state = 'stopped'` alone only stops the reconciler CREATING a
// replacement — SVC-002's loop has no channel to a running instance, and its own header says
// so. A control that flipped only that column would be a Stop button that provably does not
// stop, which is this programme's signature defect wearing a product label. So the control
// composes the SHIPPED cancellation channel (`requestCancellation`, graceful) against the
// live instance's job, exactly as this router's JOB-008 `drain` route already does.
//
// ★★★ AND ALL OF IT IS ONE TRANSACTION UNDER THE SERVICE'S OWN ROW LOCK. The first revision of
// this file committed the desired-state write, released the lock, and then cancelled in a
// second transaction — with the writes ordered state-first, because a reconciler tick landing
// between them the other way round would have replaced the instance the operator just stopped.
// EXTERNAL REVIEW OF PR #412 FOUND THAT ORDERING WAS NOT ENOUGH (P1): a concurrent
// `stopped → running` landing in the same gap means the older stop still drains a job the
// operator has already resumed. Under one lock that interleaving is unrepresentable. See
// `setServiceDesiredState`'s docstring for the lock order, which is stated rather than assumed
// because `requestCancellation`'s own header warns that getting it wrong deadlocks.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ──────────────────────────────────────────────
//
//   * It does NOT mint generation N+1. A rollout without SVC-005's "no two generations may
//     perform external effects simultaneously" fence is precisely the overlap E9's acceptance
//     forbids, and the fence does not exist. `update` therefore stays SVC-005's, and the only
//     generation this file writes is generation 1, atomically with the service that owns it.
//   * It accepts NO `ttlSeconds` and NO `checkpointArtifactId`. Both columns exist. Nothing
//     enforces a TTL (SVC-005) and nothing restores a checkpoint (SVC-004), so accepting
//     either would store a bound no code keeps — a clause made vacuously true by a column
//     nobody reads, which is the failure this epic has already filed twice.
//   * It does NOT accept `deleted`. That state is terminal in the frozen desired-state table
//     (no outgoing edges) and `service_generations`' RESTRICT FK makes a service with any
//     generation undeletable, so `deleted` is an irreversible tombstone whose semantics
//     SVC-005 owns. `running`/`paused`/`stopped` are the three this control admits.
//   * It is NOT idempotent across retries: `services` has no natural key and no idempotency
//     column, so two POSTs create two services. Bounded rather than prevented — the second
//     service is visible in the list read and stoppable by the control shipped here. Recorded
//     in SVC-007a-result.md §7 rather than hidden.

import { randomUUID } from "node:crypto";
import type { Db, TenantRepositories } from "@armyofagents/db";
import {
  SERVICE_DESIRED_STATES,
  canTransitionServiceDesiredState,
  serviceWorkloadV1Schema,
  type ServiceDesiredState,
} from "@armyofagents/worker-protocol";
import { runInTenant, runInTenantReadOnly } from "../db/tenant-context.js";
import { assertAdmissibleOrganization } from "./tenant-admission.js";
import { SERVICE_INGRESS_DENY_KEYS } from "./service-job-config.js";
import { decideServiceProjection } from "./service-health-projection.js";
import type { PreparedActivityEvent } from "./activity-log.js";
import {
  publishServiceControlActivity,
  recordServiceCreateActivity,
  recordServiceDesiredStateActivity,
  type ServiceControlActor,
} from "./service-control-audit.js";

/**
 * SVC-007 (Unit B) — the audit context every mutating control carries.
 *
 * ★ IT IS REQUIRED, NOT OPTIONAL, AND THAT IS THE ENFORCEMENT. AGENTS.md's "activity logging
 * for all mutating actions" invariant was NOT met by this file at `SVC-007a` — the routes
 * wrote a structured logger line and nothing durable. An optional parameter would leave the
 * invariant exactly as unenforced as a convention: a caller that omitted it would compile,
 * run, mutate and audit nothing. Making it a required argument means the type checker refuses
 * a mutating call site that has nowhere to record the mutation.
 *
 * ★ `tx` IS THE MUTATION'S OWN TRANSACTION HANDLE, and passing it is the whole guarantee. The
 * audit row commits with the mutation or not at all; see `service-control-audit.ts` for why
 * that is the replay guard here and why JOB-013's fenced receipt is not available (and not
 * needed).
 */
export interface ServiceControlAuditContext {
  /** The SAME transaction the mutation runs in. Never a fresh handle. */
  tx: Db;
  actor: ServiceControlActor;
  /**
   * Sink for prepared `activity.logged` events, drained by the transaction's OWNER after it
   * commits — the identical after-commit shape `jobAuditBridge` uses. Publishing inside the
   * transaction would announce a mutation a later rollback un-does.
   */
  published: PreparedActivityEvent[];
}

/**
 * ★★★ THE PROJECTION A CANCELLED ATTEMPT DRIVES, TAKEN FROM THE WORKER PATH'S OWN DECIDER.
 *
 * `requestCancellation` finalizes directly — attempt and job both `cancelled` under its own
 * locks — whenever there is no fenced worker to drain, which is the normal case for a service
 * stopped before its job was ever leased. On that branch NO worker event is ever emitted, so
 * SVC-003a's attempt-terminal backstop (which fires only from an INGESTED `terminal`) cannot
 * run, and the instance would sit non-terminal inside `service_instances_live_service_uq`
 * forever — making a later resume converge nothing, on every tick, silently.
 *
 * The mapping is READ OUT of `decideServiceProjection` for the identical attempt status
 * rather than restated, so the control-plane path and the worker path cannot drift into two
 * ideas of what a cancelled attempt means to an instance.
 *
 * Resolved at module load and asserted: a `null` here would be a backstop that exists and
 * projects nothing, which is this programme's signature defect.
 *
 * ★ EXPORTED BY SVC-005a, and exported rather than re-derived on purpose. The generation
 * rollout's drain (`service-generation-rollout.ts`) issues the SAME graceful stop this
 * operator stop does, so it needs the SAME projection. A second `decideServiceProjection`
 * call in the other file would be a second place for the mapping to drift, and drift between
 * two ideas of what a cancelled attempt means to an instance is precisely what the paragraph
 * above says this constant exists to prevent.
 */
export const CANCELLED_ATTEMPT_PROJECTION = (() => {
  const projection = decideServiceProjection({
    eventType: "terminal",
    payload: { status: "cancelled" },
  });
  if (!projection) {
    throw new Error(
      "decideServiceProjection no longer projects anything for a cancelled attempt terminal. " +
        "The control-plane cancellation path depends on that mapping; re-derive it before shipping.",
    );
  }
  if (projection.allowedFromStatuses.length === 0) {
    throw new Error(
      "the cancelled-attempt projection has an EMPTY predecessor set, so it could never move " +
        "an instance. That is a backstop wired to nothing.",
    );
  }
  return projection;
})();

/**
 * The workload fields the CONTROL PLANE owns, and which a create request therefore may not
 * carry. Each has a different owner, and naming them individually is what makes the refusal
 * legible instead of a bare "unknown field":
 *
 *   `serviceId`           the `services` row's own primary key, minted by the insert.
 *   `serviceInstanceId`   minted per instance by SVC-002's reconciler; a caller-supplied one
 *                         would be an unauthorized value promoted into a persisted principal
 *                         id (E9-F003 is that exact defect through a different door).
 *   `generation`          `services.generation`, moved only by a rollout.
 *   `checkpointArtifactId` a RESTORE-INPUT pointer. SVC-004 owns restore; see the header.
 */
export const SERVICE_CONTROL_PLANE_OWNED_WORKLOAD_FIELDS: readonly string[] = Object.freeze([
  "serviceId",
  "serviceInstanceId",
  "generation",
  "checkpointArtifactId",
]);

/** The fields a stored `service_generations.definition` carries — the frozen workload's
 *  non-identity half, i.e. exactly what SVC-002's `readDefinition` reads back out. */
export const SERVICE_DEFINITION_FIELDS: readonly string[] = Object.freeze([
  "command",
  "args",
  "gracefulStopSeconds",
]);

// ★ THE PARTITION IS ASSERTED AT MODULE LOAD, NOT ASSUMED. `service-job-config.ts` records
// why a derived allow-list alone is not enough: derivation AUTO-WIDENS, so a field added to
// the frozen schema would silently become acceptable in a create body. Requiring that every
// frozen field belongs to EXACTLY ONE of the two lists above turns that drift into an import
// failure with a message naming the field, which is the only outcome that cannot be missed.
{
  const frozen = new Set(Object.keys(serviceWorkloadV1Schema.shape));
  const declared = [...SERVICE_DEFINITION_FIELDS, ...SERVICE_CONTROL_PLANE_OWNED_WORKLOAD_FIELDS];
  const seen = new Set<string>();
  for (const field of declared) {
    if (seen.has(field)) {
      throw new Error(
        `service workload field ${JSON.stringify(field)} is declared twice across ` +
          "SERVICE_DEFINITION_FIELDS and SERVICE_CONTROL_PLANE_OWNED_WORKLOAD_FIELDS.",
      );
    }
    seen.add(field);
    if (!frozen.has(field)) {
      throw new Error(
        `service workload field ${JSON.stringify(field)} is declared here but is not part of ` +
          "the frozen serviceWorkloadV1Schema. The partition is stale.",
      );
    }
  }
  for (const field of frozen) {
    if (!seen.has(field)) {
      throw new Error(
        `frozen serviceWorkloadV1Schema field ${JSON.stringify(field)} is neither a service ` +
          "definition field nor a control-plane-owned field. Decide which it is before " +
          "shipping: leaving it undeclared would silently admit it into a create body.",
      );
    }
  }
}

/** Derived from the frozen schema so the stored definition cannot drift from the wire
 *  contract SVC-002 rebuilds the workload from. `.strict()` is restated rather than
 *  inherited, so the refusal does not depend on `.pick()` preserving an unknown-keys mode. */
const serviceDefinitionSchema = serviceWorkloadV1Schema
  .pick(
    Object.fromEntries(SERVICE_DEFINITION_FIELDS.map((field) => [field, true])) as {
      command: true;
      args: true;
      gracefulStopSeconds: true;
    },
  )
  .strict();

export type ServiceDefinition = {
  command: string;
  args: string[];
  gracefulStopSeconds: number;
};

export type NormalizeServiceDefinitionResult =
  | { readonly ok: true; readonly value: ServiceDefinition }
  | { readonly ok: false; readonly reason: ServiceDefinitionRejection };

export type ServiceDefinitionRejection =
  | "not_an_object"
  /** A key naming public exposure. The SAME deny-set SVC-001's submit-time validator uses —
   *  one authority, so a key added there is refused here too. */
  | "ingress_configuration_rejected"
  /** A field the control plane owns, named individually so the refusal says which. */
  | "control_plane_owned_field"
  | "unknown_field"
  | "frozen_schema_rejected";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one create request's `definition`, purely.
 *
 * ★ CLAUSE (d) INHERITS ITS LIMIT VERBATIM. `service-job-config.ts` states that "no public
 * port/ingress configuration is accepted" governs DECLARATIVE CONFIGURATION and not
 * reachability — E2B serves arbitrary in-sandbox ports publicly at a URL derivable from the
 * sandbox id, so a service that merely LISTENS is reachable with no ingress configuration at
 * all. That is still true here, and `args` is still not scanned for `--port` for the reason
 * that file gives. A green refusal test must not be read as "services cannot be reached".
 */
export function normalizeServiceDefinition(raw: unknown): NormalizeServiceDefinitionResult {
  if (!isPlainObject(raw)) return { ok: false, reason: "not_an_object" };

  // Ingress first, so a body carrying both an ingress key and some other unknown field
  // reports the refusal that names a policy.
  for (const key of SERVICE_INGRESS_DENY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      return { ok: false, reason: "ingress_configuration_rejected" };
    }
  }
  for (const key of SERVICE_CONTROL_PLANE_OWNED_WORKLOAD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      return { ok: false, reason: "control_plane_owned_field" };
    }
  }
  for (const key of Object.keys(raw)) {
    if (!SERVICE_DEFINITION_FIELDS.includes(key)) return { ok: false, reason: "unknown_field" };
  }

  const parsed = serviceDefinitionSchema.safeParse({
    command: raw.command,
    args: raw.args,
    gracefulStopSeconds: raw.gracefulStopSeconds,
  });
  if (!parsed.success) return { ok: false, reason: "frozen_schema_rejected" };
  return { ok: true, value: parsed.data as ServiceDefinition };
}

/** The desired states a create request may ask for. `stopped` is excluded because a service
 *  created stopped is a service that never ran; `deleted` because it is the tombstone. */
export const CREATABLE_DESIRED_STATES: readonly ServiceDesiredState[] = Object.freeze([
  "running",
  "paused",
]);

/** The desired states the control may move a service TO. See the header for `deleted`. */
export const CONTROLLABLE_DESIRED_STATES: readonly ServiceDesiredState[] = Object.freeze([
  "running",
  "paused",
  "stopped",
]);

// Both lists are subsets of the FROZEN authority, asserted rather than assumed: a state
// spelled wrong here would be storable-looking and then refused by
// `services_desired_state_check` at 500 instead of 400.
for (const state of [...CREATABLE_DESIRED_STATES, ...CONTROLLABLE_DESIRED_STATES]) {
  if (!(SERVICE_DESIRED_STATES as readonly string[]).includes(state)) {
    throw new Error(
      `${JSON.stringify(state)} is not a member of the frozen SERVICE_DESIRED_STATES.`,
    );
  }
}

export interface CreateServiceInput {
  organizationId: string;
  companyId: string;
  definition: ServiceDefinition;
  desiredState: ServiceDesiredState;
  createdBy: string | null;
}

export interface CreatedService {
  serviceId: string;
  generation: number;
  desiredState: string;
}

/**
 * Create one service AND the immutable generation that defines it, inside ONE already-open
 * tenant transaction.
 *
 * ★ THE SINGLE TRANSACTION IS THE WHOLE POINT, and it is the same argument SVC-002's
 * reconciler makes for its own composition. A `services` row without a
 * `service_generations` row is not a partial success: it is a service that
 * `findServiceGenerationDefinition` answers `null` for FOREVER, so the reconciler stalls at
 * `no_generation` on every tick for the rest of the row's life, with no route able to repair
 * it (this file mints generation 1 only, and 1 is taken). That is a permanent silent wedge
 * of exactly the shape SVC-003a filed twice. Both writes commit or neither does.
 *
 * Returns `null` when the generation insert lost a race against
 * `service_generations_service_generation_uq` — unreachable for a freshly-minted service id
 * and therefore not swallowed into a fabricated success; the caller turns it into a definite
 * refusal.
 *
 * ★ CORRECTION (SVC-007 Unit B, `E9-F011`). An earlier version of this sentence ended "…and
 * the transaction rolls back". IT DOES NOT. Returning `null` from the `runInTenant` callback
 * COMMITS; `insertServiceGeneration` catches its `23505` on a SAVEPOINT precisely so the outer
 * transaction stays alive, and the route's 409 is thrown after `createService` has already
 * returned. On that path a `services` row commits with NO generation — exactly the permanent
 * `no_generation` wedge the paragraph above says must never happen — and NO audit row, since
 * the audit is written only on success. It is still unreachable by construction (the service
 * id is minted by this insert, so `(service_id, 1)` cannot already exist), so this is a false
 * record rather than a live defect; it is filed OPEN as `E9-F011` rather than fixed here,
 * because a fix changes what this function returns and needs its own red.
 */
export async function createServiceWithinTenant(
  repos: TenantRepositories,
  input: CreateServiceInput,
  audit: ServiceControlAuditContext,
): Promise<CreatedService | null> {
  // The generic repository insert that had ZERO production callers at base. It is used
  // directly rather than re-implemented so the symbol the register tracks is the symbol that
  // runs.
  const service = await repos.services.insert({
    organizationId: input.organizationId,
    companyId: input.companyId,
    desiredState: input.desiredState,
    generation: 1,
  });
  const generation = await repos.jobControl.insertServiceGeneration({
    organizationId: input.organizationId,
    companyId: input.companyId,
    serviceId: service.id,
    generation: 1,
    definition: {
      command: input.definition.command,
      args: input.definition.args,
      gracefulStopSeconds: input.definition.gracefulStopSeconds,
    },
    createdBy: input.createdBy,
  });
  if (!generation) return null;
  // ★ THE DURABLE AUDIT, IN THIS TRANSACTION AND NOT AFTER IT. `activity_log` is an append
  // with no unique index and no other writer on this path, so it adds no edge to the lock
  // order stated on `setServiceDesiredState`; what it adds is the guarantee that a committed
  // `services` row and the record of who created it cannot exist apart.
  audit.published.push(await recordServiceCreateActivity(audit.tx, {
    actor: audit.actor,
    companyId: input.companyId,
    organizationId: input.organizationId,
    serviceId: service.id,
    generation: generation.generation,
    desiredState: service.desiredState,
  }));
  return {
    serviceId: service.id,
    generation: generation.generation,
    desiredState: service.desiredState,
  };
}

/**
 * Create one service in its own tenant transaction, publishing the audit event only once that
 * transaction has committed.
 *
 * ★ A THROW rolls the transaction back — the service row, its generation and the audit row
 * together. A `null` RETURN does NOT; see `createServiceWithinTenant`'s correction note and
 * `E9-F011`. The earlier one-line docstring here said "on failure ROLLING BACK", which
 * conflated the two.
 */
export async function createService(
  appDb: Db,
  input: CreateServiceInput & { actor: ServiceControlActor },
): Promise<CreatedService | null> {
  // Parity with the reconciler and with `jobSubmissionService.submit`: a forbidden sentinel
  // organization must never reach the distributed path by an unguarded route (FND-007,
  // Decision #121). It THROWS rather than returning a refusal, because a sentinel org here
  // is a programming error and not a state a caller can be in.
  assertAdmissibleOrganization(input.organizationId);
  const published: PreparedActivityEvent[] = [];
  const created = await runInTenant(appDb, input.organizationId, (repos, tx) =>
    createServiceWithinTenant(repos, input, { tx, actor: input.actor, published }));
  // Reached ONLY on a commit: a mid-transaction throw exits `runInTenant` above and never
  // arrives here, so a rollback publishes nothing.
  publishServiceControlActivity(published);
  return created;
}

export type SetServiceDesiredStateVerdict =
  | { outcome: "updated"; from: ServiceDesiredState; to: ServiceDesiredState; generation: number }
  /** The service is already in the requested state. Writes nothing — an idempotent re-issue
   *  is not a transition, and the FROZEN table has no self-edges, so asking it would answer
   *  `illegal` for a request that is plainly satisfiable. */
  | { outcome: "unchanged"; state: ServiceDesiredState; generation: number }
  /** The FROZEN `SERVICE_DESIRED_TRANSITIONS` table forbids the move — e.g. `stopped` →
   *  `paused`, or anything out of `deleted`. */
  | { outcome: "illegal"; from: string; to: ServiceDesiredState }
  /** No such service in this tenant. A definite absence, never an existence oracle. */
  | { outcome: "absent" }
  /** The compare-and-set found no row despite the lock. Reported rather than retried: it
   *  means something wrote `desired_state` without taking the row lock, which is a defect
   *  worth surfacing and not a state to converge. */
  | { outcome: "conflict"; from: string; to: ServiceDesiredState };

export interface SetServiceDesiredStateInput {
  organizationId: string;
  companyId: string;
  serviceId: string;
  desiredState: ServiceDesiredState;
}

export interface ServiceControlDependencies {
  appDb: Db;
}

/**
 * Move one service's desired state, inside ONE already-open tenant transaction.
 *
 * ★ IT REUSES `lockServiceForReconcile` DELIBERATELY, AND THE REASON IS NOT THE ONE IT LOOKS
 * LIKE. SVC-002's design names this control by name — but as a CAUTIONARY example, one of "the
 * writers that would forget" the advisory lock, which is precisely why it located the
 * duplicate-placement guarantee in the partial unique index instead. Nothing requires this
 * function to take that lock, and the index remains the authority for duplicate placement.
 *
 * It takes it anyway, for the job SVC-002's design gives step 2's `SELECT … FOR UPDATE`:
 * serializing a read-modify-write on `services`. This function READS `desired_state`, decides
 * legality from it, and then writes — and a concurrent reconcile pass reads the same row. On
 * the SAME key rather than a new one, because a second lock helper would serialize against
 * nothing; two locks are one lock fewer. The compare-and-set on the repository write is the
 * belt to that braces, for a future caller that does forget.
 *
 * The frozen `canTransitionServiceDesiredState` is the legality authority. It had ZERO
 * production callers before this function; its table was a lifecycle nothing enforced.
 */
export async function setServiceDesiredStateWithinTenant(
  repos: TenantRepositories,
  input: SetServiceDesiredStateInput & { reason: string },
  audit: ServiceControlAuditContext,
): Promise<SetServiceDesiredStateResult> {
  const result = await applyServiceDesiredState(repos, input);
  // ★ ONLY THE TWO VERDICTS THAT CAN MUTATE ARE AUDITED, and `unchanged` is one of them —
  // it is not a no-op. The stop still runs on `unchanged` (a reconcile pass that began before
  // an earlier stop can commit an instance after that stop moved the column), so an
  // `unchanged` control action can cancel a job and terminalize an instance. `illegal` and
  // `conflict` write nothing, and `absent` returns a uniform 404 whose whole point is that it
  // is indistinguishable from a cross-tenant miss. AGENTS.md's invariant is over MUTATING
  // actions; a refusal is a denial-audit question and belongs to the reserved
  // `security.denied.` namespace, not to this action.
  if (result.verdict.outcome === "updated" || result.verdict.outcome === "unchanged") {
    audit.published.push(await recordServiceDesiredStateActivity(audit.tx, {
      actor: audit.actor,
      companyId: input.companyId,
      organizationId: input.organizationId,
      serviceId: input.serviceId,
      outcome: result.verdict.outcome,
      from: result.verdict.outcome === "updated" ? result.verdict.from : undefined,
      to: input.desiredState,
      generation: result.verdict.generation,
      reason: input.reason,
      stopStatus: result.stop?.status ?? null,
      stopInstance: result.stop?.status === "requested" ? result.stop.instance : null,
    }));
  }
  return result;
}

/**
 * The control's decision and writes, with no audit of its own.
 *
 * Split out of {@link setServiceDesiredStateWithinTenant} by SVC-007 Unit B for ONE reason:
 * ★ this function has SEVEN `return` statements (counted at head, not remembered) and the
 * audit must fire on exactly two of the five VERDICT values — `updated` and `unchanged` —
 * which between them are reached from four of those seven exits, and only AFTER the
 * cancellation and the terminalization so the row can record what happened to the live
 * instance. Auditing at each exit would be four call sites to keep in step and an eighth exit
 * away from silently writing nothing.
 */
async function applyServiceDesiredState(
  repos: TenantRepositories,
  input: SetServiceDesiredStateInput & { reason: string },
): Promise<SetServiceDesiredStateResult> {
  const service = await repos.jobControl.lockServiceForReconcile({
    organizationId: input.organizationId,
    companyId: input.companyId,
    serviceId: input.serviceId,
  });
  if (!service) return { verdict: { outcome: "absent" }, stop: null };
  const from = service.desiredState;
  let verdict: SetServiceDesiredStateVerdict;
  if (from === input.desiredState) {
    verdict = { outcome: "unchanged", state: input.desiredState, generation: service.generation };
  } else {
    // `from` is read from a column governed by `services_desired_state_check`, but the CHECK is
    // a hand-written copy of the frozen list, so an unrecognised value is treated as "no legal
    // move from here" rather than passed to the frozen predicate as an unchecked cast.
    const known = (SERVICE_DESIRED_STATES as readonly string[]).includes(from);
    if (!known || !canTransitionServiceDesiredState(from as ServiceDesiredState, input.desiredState)) {
      return { verdict: { outcome: "illegal", from, to: input.desiredState }, stop: null };
    }
    const updated = await repos.jobControl.updateServiceDesiredState({
      organizationId: input.organizationId,
      companyId: input.companyId,
      serviceId: input.serviceId,
      expectedDesiredState: from,
      desiredState: input.desiredState,
    });
    if (!updated) return { verdict: { outcome: "conflict", from, to: input.desiredState }, stop: null };
    verdict = {
      outcome: "updated",
      from: from as ServiceDesiredState,
      to: input.desiredState,
      generation: updated.generation,
    };
  }

  // Resuming stops nothing; the reconciler converges on its next tick.
  if (input.desiredState === "running") return { verdict, stop: null };

  // ★ THE STOP RUNS ON `unchanged` TOO, AND THAT IS NOT SLOPPINESS. A reconcile pass that began
  // before this stop can commit an instance AFTER a previous stop already moved the column, so
  // "already stopped" does not imply "nothing is running". `requestCancellation` is idempotent
  // per lease (its command lookup keys on `(organization, lease, 'cancel')`, not on the command
  // id), so re-issuing is free.
  const instance = await repos.jobControl.findLiveServiceInstance({
    organizationId: input.organizationId,
    serviceId: input.serviceId,
  });
  if (!instance) return { verdict, stop: { status: "no_instance" } };
  if (!instance.jobId) {
    return { verdict, stop: { status: "no_job", serviceInstanceId: instance.serviceInstanceId } };
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
  // ★ ALWAYS ATTEMPTED, NEVER GATED ON THE CANCELLATION'S REPORTED STATUS. The precondition
  // that matters — "the attempt this instance is attributed to is terminal and did not
  // succeed" — is a DATABASE fact the repository re-reads under the instance's row lock, so
  // matching on a returned string here would be a second, weaker gate. When a live worker was
  // drained rather than finalized, the attempt is still running and this answers
  // `attempt_not_terminal`: a no-op, with the worker's own event doing the projection.
  const terminalized = await repos.jobControl.terminalizeServiceInstanceForCancelledAttempt({
    organizationId: input.organizationId,
    companyId: input.companyId,
    jobId,
    toStatus: CANCELLED_ATTEMPT_PROJECTION.toStatus,
    allowedFromStatuses: CANCELLED_ATTEMPT_PROJECTION.allowedFromStatuses,
  });
  return {
    verdict,
    stop: {
      status: "requested",
      serviceInstanceId: instance.serviceInstanceId,
      jobId,
      cancellation: cancellation.status,
      instance: terminalized.outcome,
    },
  };
}

export interface SetServiceDesiredStateResult {
  verdict: SetServiceDesiredStateVerdict;
  /**
   * What happened to the LIVE instance, if any. `null` when the target state is `running`
   * (nothing to stop), when the verdict wrote nothing, or when the service has no live
   * instance. `no_job` when an instance exists but carries no `job_id` — reachable only in the
   * window before SVC-002's attribution write commits, and reported rather than silently
   * treated as stopped.
   */
  stop:
    | null
    | { status: "no_instance" }
    | { status: "no_job"; serviceInstanceId: string }
    | {
        status: "requested";
        serviceInstanceId: string;
        jobId: string;
        cancellation: string;
        /** What the control-plane attempt-terminal backstop did to the instance. See
         *  {@link CANCELLED_ATTEMPT_PROJECTION}. `attempt_not_terminal` is the normal answer
         *  when a live worker was drained instead of finalized — that instance will be moved
         *  by the worker's own event through the ingest, not from here. */
        instance: string;
      };
}

/**
 * Move one service's desired state and, when the operator asked for it to stop running, stop
 * the live instance — ALL OF IT IN ONE TRANSACTION, under the service's own row lock.
 *
 * ★★★ THE SINGLE TRANSACTION IS A FIX, NOT TIDINESS, AND EXTERNAL REVIEW FOUND WHAT IT COSTS.
 * The first revision committed the desired-state write, RELEASED the lock, and only then looked
 * up the instance and cancelled its job. Review of PR #412 (P1) named the race exactly: a
 * concurrent `stopped → running` landing in that gap means the older stop still drains a job the
 * operator has already resumed, taking the service down until the reconciler's next tick
 * replaces it. Under one lock that interleaving is unrepresentable — a resume cannot commit
 * between this function's read of `desired_state` and its cancellation, because it cannot
 * acquire the row.
 *
 * It also removes the split-outcome the first revision had to report: a cancellation failure now
 * rolls the desired-state write back with it, so the operator gets ONE definite answer instead of
 * "the column moved but the thing is still running, please retry".
 *
 * ★ LOCK ORDER, stated rather than assumed, because `requestCancellation`'s own header warns
 * that getting it wrong deadlocks. This transaction takes: the per-service advisory lock and the
 * `services` row FIRST, then `requestCancellation`'s own `lease → attempt → job` hierarchy
 * untouched, then `service_instances`. Nothing else in the tree takes a job-side lock and THEN
 * the service advisory lock: SVC-002's reconciler takes the service locks first exactly as this
 * does, and the JOB-005 ingest takes `lease → attempt → service_instances` with no service lock
 * at all — and both it and this reach `service_instances` only while already holding the attempt,
 * so the two agree on direction. No cycle is constructible.
 */
export async function setServiceDesiredState(
  deps: ServiceControlDependencies,
  input: SetServiceDesiredStateInput & { reason: string; actor: ServiceControlActor },
): Promise<SetServiceDesiredStateResult> {
  assertAdmissibleOrganization(input.organizationId);
  const published: PreparedActivityEvent[] = [];
  const result = await runInTenant(deps.appDb, input.organizationId, (repos, tx) =>
    setServiceDesiredStateWithinTenant(repos, input, { tx, actor: input.actor, published }));
  // Reached ONLY on a commit — a cancellation failure rolls the desired-state write, the
  // instance terminalization AND the audit row back together, and never arrives here.
  publishServiceControlActivity(published);
  return result;
}

export interface ServiceView {
  serviceId: string;
  desiredState: string;
  generation: number;
  createdAt: Date;
  updatedAt: Date;
  definition: Record<string, unknown> | null;
  liveInstance: {
    serviceInstanceId: string;
    status: string;
    generation: number;
    jobId: string | null;
    attemptId: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
}

/**
 * The operator's read of one service: desired state, current generation, that generation's
 * immutable definition, and the live instance if there is one.
 *
 * ★ WHAT IT IS NOT. E9's gate names a view of "desired state, generation, active instance,
 * health, checkpoint, budget, and restart history". This delivers the first three, plus
 * health only in the sense that `service_instances.status` IS the projected health SVC-003a
 * writes. Checkpoint, budget and restart history are NOT here: no checkpoint is storable
 * (SVC-004), no per-service budget exists (spend is attributed per job), and no restart has
 * ever happened because SVC-002 converges once and replacement is driven by the projection.
 * Listed so a shipped read surface is not mistaken for a delivered gate item.
 *
 * `definition` is `null` when the current generation has no row — impossible for a service
 * this file created, and possible for one an earlier hand-inserted row left behind. A `null`
 * is the honest answer rather than an invented default, matching the reconciler's own stall.
 */
export async function readService(
  appDb: Db,
  input: { organizationId: string; companyId: string; serviceId: string },
): Promise<ServiceView | null> {
  assertAdmissibleOrganization(input.organizationId);
  return runInTenantReadOnly(appDb, input.organizationId, async (repos) => {
    const service = await repos.jobControl.findServiceForCompany(input);
    if (!service) return null;
    // Sequential, not `Promise.all`: both reads run on the ONE connection this transaction
    // holds, and issuing them concurrently on a single postgres-js handle is not a
    // parallelism win — it is a way to interleave two statements on a connection that can
    // only serve one.
    const generation = await repos.jobControl.findServiceGenerationDefinition({
      organizationId: input.organizationId,
      companyId: input.companyId,
      serviceId: input.serviceId,
      generation: service.generation,
    });
    const liveInstance = await repos.jobControl.findLiveServiceInstance({
      organizationId: input.organizationId,
      serviceId: input.serviceId,
    });
    return {
      ...service,
      definition: generation?.definition ?? null,
      liveInstance,
    };
  });
}

/** One page of a company's services, for the operator list. */
export async function listServices(
  appDb: Db,
  input: {
    organizationId: string;
    companyId: string;
    afterServiceId: string | null;
    limit: number;
  },
): Promise<Array<{
  serviceId: string;
  desiredState: string;
  generation: number;
  createdAt: Date;
  updatedAt: Date;
}>> {
  assertAdmissibleOrganization(input.organizationId);
  return runInTenantReadOnly(appDb, input.organizationId, (repos) =>
    repos.jobControl.listServicesForCompany(input));
}
