// server/src/services/worker-admission-denial-audit.ts
//
// DE-27, audit clause — the durable record a cross-replica WORKER-ADMISSION refusal
// leaves behind, for both of the two admission deny sites the clause names.
//
// ★ WHAT THE CLAUSE ASKS, AS AMENDED. `docs/architecture/distributed-execution-threat-controls.json`
// DE-27 asserted "cross-replica admission AND partition events are audited". The
// clause was AMENDED by E0-F013 Decision 1.2(c) (founder-ruled 2026-09-11) and is
// SPLIT:
//   (1) the "cross-replica admission" conjunct is read WEAKLY and is what this
//       module delivers — each admission REFUSAL is durably recorded. Admission is
//       already DB-serialized across replicas (`pg_advisory_xact_lock` over the
//       organization in `org-concurrency.ts`, and the shared
//       `worker_admission_rate_limits` counter both replicas increment), so the
//       clause does NOT require a record that names WHICH replica decided — the
//       system has no replica identity and this conjunct no longer implies one.
//   (2) the "partition events" conjunct is DROPPED as vacuous: there is no
//       partition detector, so no partition event exists to record.
// So the whole remaining deliverable is: durably record the TWO admission
// refusals. There are exactly two.
//
// ★ THE TWO DENY SITES, and why they need different mechanisms.
//   over_cap  — the shared per-organization worker-poll rate limiter,
//               `worker-admission-rate-limit.ts admit()`. The tenant transaction
//               that increments the shared counter has ALREADY COMMITTED and
//               returned the count by the time the over-cap branch is taken, so
//               `opts.appDb` is a pool-level handle and the record is written
//               DIRECTLY there, before the refusal is returned. No intent/drain is
//               needed: nothing is about to roll back.
//               ★ ONE ROW PER OVER-CAP POLL (per-refusal). The founder-ruled reading of
//               DE-27's audit clause (E0-F013 Decision 1.2c) is "each admission REFUSAL is
//               durably recorded", so the row is written on EVERY over-cap poll, each with
//               its own `actorId` and `details.count` — the same per-refusal shape as the
//               DE-03/DE-06/DE-19 deny paths. A first-crossing / per-window COALESCE was
//               considered and REJECTED: it drops the refusals the ruled clause requires be
//               recorded. Write-amplification from a looping worker is bounded by the poll
//               rate limit and `activity_log` retention — a pattern-wide property of the
//               whole deny-path class, tracked separately, not a DE-27 deviation.
//   capacity  — the shared per-organization concurrency cap,
//               `org-concurrency.ts admitAttemptCapacity()`. Its `admitted:false`
//               return is a plain `return` (Drizzle COMMITS a callback that returns
//               and only rolls back one that throws), so in isolation the row would
//               survive an in-transaction write. But that authority has NO pool
//               handle of its own — every production caller invokes it with `tx`,
//               the SAME tenant transaction opened by `submitJobWithinTenant`'s
//               `runInTenant` — and every one of those callers, on seeing
//               `admitted:false`, THROWS (`HttpError(429)` /
//               `TenantAdmissionDeniedError`), which rolls the whole submission
//               transaction back. So a row written on that transaction is DISCARDED
//               with it. The refusal must therefore be recorded on a POOL handle
//               AFTER the tenant transaction has closed — the intent-record-then-
//               drain pattern `worker-denial-audit.ts` established, for exactly the
//               reason `security-denial-audit.ts`'s header states: "db MUST be a
//               pool-level handle, never the transaction that is about to reject".
//
// ★ WHY A DRAIN AND NOT AN IN-TRANSACTION WRITE ON THE CAPACITY PATH, stated even
// though that path COMMITS in isolation. `recordSecurityDenial` is designed to run
// in its OWN transaction on a pool handle: its FK-violation retry (a replayed token
// from a torn-down organization) re-inserts with a null organization, and a retry
// inside a caller's transaction would fail with 25P02 on the aborted transaction and
// be swallowed. Writing the row inside `admitAttemptCapacity`'s transaction would
// also risk the self-deadlock the sibling recorders document (a second pool
// connection borrowed while the first is held) if it ever reached for the pool. The
// drain sidesteps both: the refusing branch records its INTENT into a caller-owned
// holder, the throw propagates unchanged, and the caller drains the holder on the
// pool handle in a `finally` after the transaction has closed.
//
// ★ ATTRIBUTION: THE ORGANIZATION IS THE TENANT, AND THE WHO IS THE AUTHENTICATED
// PRINCIPAL — NOT THE ORGANIZATION. Both deny sites are ORGANIZATION-SCOPED admission
// authorities — the rate-limit counter is keyed on `(organization_id, window_start)`,
// and the concurrency cap is `organizations.concurrency_cap` serialized under one
// advisory lock per organization — so the organization is the tenant the refusal
// happened in and rides `organizationId` (and, for capacity, `companyId`). But the
// tenant is NOT the WHO: an authenticated principal is in hand at BOTH control points,
// and it is that principal, not the org, that `actorId` names — otherwise two distinct
// refused workers/submitters in one org would collapse into one indistinguishable row
// and the audit contract's WHO question could not be answered.
//   over_cap  — the refused WORKER. `VerifiedWorkerOperation.workerId`
//               (`middleware/worker-operation-proof.ts:7`, sourced from the HMAC-
//               verified `claims.sub`) is in hand as `auth.workerId` at
//               `worker-control.ts` the whole time — it is passed into `admit()`
//               alongside the org, so the refused worker's own id is `actorId`. (The
//               poll limiter being consulted BEFORE `leasing.poll` resolves the frozen
//               LEASE authority does not mean there is no worker identity: the signed
//               `auth` proof carries `workerId` from the first line of the handler.)
//   capacity  — the submitting PRINCIPAL. `input.principal.id` (`job-submission.ts`,
//               the `AuthenticatedJobPrincipal` the admission gate already authorized)
//               is threaded into `admitAttemptCapacity` and captured as the intent's
//               `actorId`, with `principalKind` in `details` so a reader sees a
//               user/agent/mcp/commander submitter, not just an id.
// `actorType` is the TRUTHFUL `ActivityActorType` for each refused principal, DERIVED
// from `principalKind` by `actorTypeForPrincipalKind` and HONEST about the id actually in
// `actorId` (= `principal.id`): `ActivityActorType` is `agent | user | system | autonomy`,
// so an `agent` records as `agent` (principal.id is the agentId), the USER-BACKED kinds whose
// principal.id is a userId (`user`/`commander`/`local_board`, each set from `actor.userId` by
// `principalFor`) record as `user`, and the machine kinds record as `system` — a worker
// (over_cap; no `agents`/`auth` row, the DE-06 convention), a service-reconcile-origin
// `system` submission. `mcp` records as `user` when the request-time owner userId is threaded
// (the common case; task_8a0402bf, 2026-09-13): the submit-path principal.id is the
// authentication KEY id, but `principalFor` also threads the owner `actor.userId`
// (`mcp_api_keys.userId`, notNull) as `ownerUserId`, so the recorder attributes the row to that
// owner as a `user` action — matching `getActorInfo`, which labels mcp `user` from the same
// owner userId at request time — keeping the key id in `details.mcpKeyId`; a defensive mcp
// principal with NO owner userId still records `system`. A real human/board/Commander capacity
// refusal is NOT flattened into `system`. `actor_id` is plain text with NO foreign key, which is
// exactly what makes `workerId`/`principal.id` usable as the identity directly — the same choice,
// for the same reason, as the DE-06 object-access, DE-06 denial, and DE-11 retention call sites
// (`artifact-object-access-audit.ts:277-278`).
// The tenant ids are TOKEN-ATTESTED or DB-CONSISTENT, never off the wire: over_cap's
// org and worker come out of `verifyWorkerOperationProof`, and capacity's org and
// company are the ids the just-inserted `job_attempts` row carries under the
// submission's own organization GUC (an insert RLS accepted moments earlier), the
// same ids that drive `runInTenant`. Actor-attribution is the ratified model
// (E0-F013 Decision 3 Q1): a cross-tenant probe files its refusal under its OWN
// tenant, never the probed one.
//
// ★ THE TWO RESOURCES DIFFER, deliberately. over_cap names the organization's
// worker-poll admission (`entityType: "worker_poll_admission"`, `entityId` = the
// organization) — a per-org bucket, with the window count and limit in `details`.
// capacity names the specific attempt refused admission (`entityType:
// "job_attempt"`, `entityId` = the attempt), with the observed usage and cap in
// `details`. A reader can tell "the org's poll burst was throttled" from "this
// attempt could not claim a slot".
//
// ★ ONE SURFACE, TWO REASONS. Both refusals write the single action
// `security.denied.worker_admission`, and the `reason` code (`over_cap` |
// `capacity`) distinguishes the branch — so "how many admission refusals did this
// organization take" is one `action` predicate and the two mechanisms are still
// told apart in the durable record. `security.denied.` is the reserved namespace
// `activity-namespace.ts` guards, so these rows are excluded from every tenant-facing
// activity feed by `notDenialNamespace()` (Decision 3): an admission refusal is not
// disclosed to the tenant that provoked it.
//
// ★ IT NEVER THROWS, inherited from `recordSecurityDenial`: a failure to record a
// refusal must not convert the refusal into a 500, hand a caller an oracle, or make
// the audit path a denial-of-service lever on the refusal path. A failed insert is
// logged at error level with the attribution the row would have carried and
// swallowed. The cost of a swallow is that a silently-broken writer looks like a
// quiet system, so `de-27-admission-audit.integration.test.ts` is written to go RED
// when either write is removed, and it was observed doing so.
//
// ★ DORMANCY / STATIC-GRAPH NOTE. This module imports `security-denial-audit.ts`,
// which imports the app logger, so it is NOT logger-free. `worker-admission-rate-limit.ts`
// (the over_cap caller) already imports the logger and loads only under the
// distributed-execution flag, so a static import there changes nothing. The capacity
// callers (`job-submission.ts`, `job-admission-bridge.ts`, `service-reconciler.ts`)
// must stay logger-free in their static graph, so they import ONLY the sink TYPE
// (erased at compile time) and load `drainAdmissionDenial` DYNAMICALLY, and only when
// an intent was actually captured.

import type { Db } from "@armyofagents/db";
import type { ActivityActorType } from "@armyofagents/shared";
import { recordSecurityDenial } from "./security-denial-audit.js";

/** The reserved `surface` slug → `security.denied.worker_admission`. */
export const WORKER_ADMISSION_DENIAL_SURFACE = "worker_admission";

/**
 * The truthful `ActivityActorType` for a refused principal's kind — HONEST about the id
 * actually in `actorId` (= the submit path's `principal.id`, built by `principalFor` in
 * `server/src/routes/job-control.ts`):
 *   - `agent`  -> `agent`  (principal.id is the agentId)
 *   - `user`, `commander`, `local_board` -> `user`  (principal.id is a userId: `principalFor`
 *      sets each from `actor.userId`, and commander is additionally validated
 *      `claims.userId === principal.id` at `job-submission.ts:196`)
 *   - `mcp`    -> `user` WHEN the request-time owner userId is threaded (the common case;
 *      task_8a0402bf, 2026-09-13): the submit-path principal.id is the authentication KEY id
 *      (`actor.keyId`, `job-control.ts`), but `principalFor` now also threads the owner
 *      `actor.userId` (`mcp_api_keys.userId`, notNull) as `ownerUserId`, so the recorder
 *      attributes the row to that owner as a `user` action — matching the canonical
 *      `getActorInfo`, which classifies mcp `user` from the same owner userId at request time —
 *      and keeps the key id in `details.mcpKeyId`. This mapping is applied in the recorder (not
 *      here), because `actorTypeForPrincipalKind` sees only the kind; a defensive mcp principal
 *      with NO owner userId still records `system`, the honest label for a bare key credential.
 *   - `worker` (the over_cap execution identity, no truthful `ActivityActorType` per the DE-06
 *      convention), `system` (a service-reconcile-origin submission), and any unknown kind
 *      -> `system`.
 * Pure and total: never throws.
 */
export function actorTypeForPrincipalKind(kind: string): ActivityActorType {
  if (kind === "agent") return "agent";
  if (kind === "user" || kind === "commander" || kind === "local_board") return "user";
  return "system";
}

/**
 * The reason vocabulary. Each code is exactly ONE admission deny BRANCH, so a reader
 * can tell a shared-rate-limit refusal from a shared-concurrency-cap refusal. The
 * worker/caller wire answer is unchanged (`throttled` / 429) in both cases — the
 * discrimination lives only in the audit row.
 *
 * `over_cap`  — the per-organization worker-poll window count exceeded its cap
 *               (`worker-admission-rate-limit.ts admit()`), fail-CLOSED shared-store
 *               errors excluded (those are `unavailable`, an infra fault the caller
 *               already logs, not the cross-replica cap refusal this clause names).
 * `capacity`  — the shared organization concurrency cap was reached
 *               (`org-concurrency.ts admitAttemptCapacity()`, the `usage >= cap`
 *               branch). The `budget` deny just above it is a DIFFERENT crossing's
 *               concern and is not recorded here, and the second `reason:"capacity"`
 *               return below the claim UPDATE (a released/terminal/gone attempt that
 *               is not a fresh cap refusal) is a distinct branch this clause does not
 *               cover — see the note in `org-concurrency.ts`.
 */
export const WORKER_ADMISSION_DENIAL_REASONS = ["over_cap", "capacity"] as const;

export type WorkerAdmissionDenialReason = (typeof WORKER_ADMISSION_DENIAL_REASONS)[number];

/** The crossing whose `audit` clause every row this module writes exists to satisfy. */
const WORKER_ADMISSION_CROSSING = "DE-27";

export interface WorkerAdmissionDenialInput {
  /** WHY, as one of the two stable branch codes. */
  reason: WorkerAdmissionDenialReason;
  /**
   * The COMPANY axis, or `null` where the refusing control holds none. `null` for
   * over_cap (the poll limiter is org-scoped and no company is in scope); the
   * submitting company for capacity. A `null` here is a claim that nothing in scope
   * resolves a company, and it is admissible because the action is in the reserved
   * `security.denied.` namespace (the `activity_log_company_or_denial_check` partial
   * CHECK).
   */
  companyId: string | null;
  /** The ORGANIZATION axis (the TENANT the refusal happened in). Token-attested or
   * DB-resolved; never off the wire. This is NOT the WHO — see `actorId`. */
  organizationId: string;
  /**
   * WHO — the specific authenticated principal refused: the refused worker's id
   * (`auth.workerId`, over_cap) or the submitting principal's id
   * (`input.principal.id`, capacity). NEVER the organization id: the tenant is not
   * the actor, and two principals in one org must stay distinguishable. `actor_id`
   * is plain text with no FK, so a worker/principal id with no `agents`/`auth` row
   * is safe to record directly.
   */
  actorId: string;
  /**
   * The refused principal's KIND — `"worker"` for over_cap, the submission's
   * `input.principal.kind` (user/agent/mcp/commander/local_board/system) for capacity.
   * The recorder derives the truthful `actorType` from it (`actorTypeForPrincipalKind`)
   * and also stamps it into `details` for legibility.
   */
  principalKind: string;
  /**
   * The REQUEST-TIME owner userId, present ONLY for an `mcp` submitter (the
   * `mcp_api_keys.userId`, threaded from `req.actor.userId`). When set for an mcp
   * principal, the recorder attributes the row to that owner as a `user` action —
   * matching the canonical `getActorInfo`, which classifies mcp as `user` because
   * it holds the owner userId at request time — and keeps the authenticating key id
   * (`actorId`) in `details.mcpKeyId` for the trail. Absent for every other kind.
   */
  ownerUserId?: string;
  /** WHICH RESOURCE — the kind of thing refused. */
  entityType: string;
  /** WHICH RESOURCE — its id. */
  entityId: string;
  /** The refusing control, `path/to/file.ts:symbol`. */
  control: string;
  /** Anything else worth keeping; redacted by `recordSecurityDenial`. */
  details?: Record<string, unknown>;
}

/**
 * Record one worker-admission refusal durably and attributably. The shared recorder
 * BOTH deny sites funnel through — the over_cap site calls it directly on its pool
 * handle, and the capacity site reaches it through `drainAdmissionDenial`.
 *
 * `actorType` is DERIVED from `principalKind` (`actorTypeForPrincipalKind`): a `user`
 * submitter records as `user`, an `agent` as `agent`, and a worker (over_cap) or any
 * other machine kind as `system` — so a real human/agent capacity refusal is not
 * misclassified as a system action. `actorId` is the SPECIFIC refused principal (the
 * worker id for over_cap, the submitting principal id for capacity) and NOT the
 * organization — the org is the tenant, carried on `organizationId` (see the module
 * header). Returns the row id, or `null` when nothing could be written (logged at
 * error by `recordSecurityDenial`). Never throws.
 */
export async function recordWorkerAdmissionDenial(
  db: Db,
  input: WorkerAdmissionDenialInput,
): Promise<string | null> {
  // ★ mcp OWNER attribution (task_8a0402bf). The submit-path principal for an mcp
  // caller carries the authenticating KEY id, not the owner userId, so by kind
  // alone the honest label is `system`. But the request-time owner userId IS
  // available (`mcp_api_keys.userId`, notNull) and is threaded here as
  // `ownerUserId`: when present for an mcp principal, attribute the row to that
  // owner as a `user` action — the same classification the canonical `getActorInfo`
  // makes for mcp at request time — and keep the key id in `details.mcpKeyId` so the
  // credential is still on the trail. Every other kind is unchanged (derived purely
  // from `principalKind`); a defensive absent-owner mcp still records `system`.
  const mcpOwnerAttributed = input.principalKind === "mcp" && Boolean(input.ownerUserId);
  const actorType = mcpOwnerAttributed ? "user" : actorTypeForPrincipalKind(input.principalKind);
  const actorId = mcpOwnerAttributed ? input.ownerUserId! : input.actorId;
  return recordSecurityDenial(db, {
    companyId: input.companyId,
    organizationId: input.organizationId,
    crossing: WORKER_ADMISSION_CROSSING,
    surface: WORKER_ADMISSION_DENIAL_SURFACE,
    reason: input.reason,
    // WHO is the specific refused principal — the worker id (over_cap) or the
    // submitting principal id (capacity) — NEVER the org. `actorType` is the TRUTHFUL
    // kind: `user`/`agent` for those, `system` for a worker or bare machine kind, and
    // `user` for an mcp caller whose owner userId is in hand (see the block above).
    // `actor_id` is plain text with no FK, so the id is safe to record directly. The
    // org is the TENANT and rides `organizationId`/`details.organizationId`.
    actorType,
    actorId,
    entityType: input.entityType,
    entityId: input.entityId,
    control: input.control,
    details: {
      ...(input.details ?? {}),
      organizationId: input.organizationId,
      // Kept for legibility beside the derived actorType, always from the first-class field.
      principalKind: input.principalKind,
      // For an owner-attributed mcp row, keep the authenticating key id on the trail
      // (it is the `actorId` the caller passed, now displaced by the owner userId).
      ...(mcpOwnerAttributed ? { mcpKeyId: input.actorId } : {}),
    },
  });
}

/**
 * What the capacity deny branch records for its caller to write once the tenant
 * transaction has closed. A capacity refusal always holds an FK-valid company (the
 * just-inserted attempt carries it), so `companyId` is a `string`, not nullable.
 */
export interface AdmissionDenialIntent {
  reason: "capacity";
  companyId: string;
  organizationId: string;
  /**
   * WHO — the submitting principal's id (`input.principal.id`), carried from the deny
   * site so the drain records the submitter as the actor and not the tenant org.
   */
  actorId: string;
  /**
   * The submitting principal's kind (user/agent/mcp/commander/local_board/system),
   * folded into the drained row's `details` so the WHO is legible beyond a bare id.
   */
  principalKind: string;
  /** The request-time owner userId for an `mcp` submitter (see
   * `WorkerAdmissionDenialInput.ownerUserId`). Undefined for every other kind. */
  ownerUserId?: string;
  /** The attempt that could not claim an organization capacity slot. */
  attemptId: string;
  /**
   * The control that REFUSED — the deny site (`org-concurrency.ts:admitAttemptCapacity`),
   * captured here rather than derived from the drain site, so the row's `control` names
   * where the decision was made and not where the row happened to be written. The drain
   * site is recorded separately in `details.drainedBy`.
   */
  control: string;
  /** The observed usage/cap and workload type, for the durable row's `details`. */
  details: Record<string, unknown>;
}

/**
 * The caller-owned holder. A one-field object rather than a bare `let`: TypeScript
 * narrows a `let` from its initializer and cannot see an assignment made inside the
 * `admitAttemptCapacity` closure, so it would read back as `never` at the drain.
 */
export interface AdmissionDenialSink {
  intent: AdmissionDenialIntent | null;
}

export function createAdmissionDenialSink(): AdmissionDenialSink {
  return { intent: null };
}

/**
 * Write the pending capacity-refusal intent, if any, on a POOL-level handle. A
 * no-op when nothing was captured (so a caller may — and should — drain from a
 * `finally`, on both the success and the throw path), and idempotent per refusal
 * because the sink is cleared as it drains. Never throws.
 */
export async function drainAdmissionDenial(
  db: Db,
  sink: AdmissionDenialSink,
  caller: {
    /** `path/to/file.ts:symbol` — the drain site, what lets an operator go from a row to a line. */
    control: string;
  },
): Promise<string | null> {
  const pending = sink.intent;
  if (!pending) return null;
  sink.intent = null;
  return recordWorkerAdmissionDenial(db, {
    reason: pending.reason,
    companyId: pending.companyId,
    organizationId: pending.organizationId,
    // WHO — the submitting principal (from the intent), not the tenant org. Its KIND is
    // passed first-class so the recorder derives the truthful actorType (user/agent/system)
    // AND stamps it into details for legibility.
    actorId: pending.actorId,
    principalKind: pending.principalKind,
    ownerUserId: pending.ownerUserId,
    entityType: "job_attempt",
    entityId: pending.attemptId,
    // The refusing control is the deny site (from the intent), not this drain site.
    control: pending.control,
    details: {
      ...pending.details,
      attemptId: pending.attemptId,
      // Where the row was actually written (the pool-handle drain, after the tenant
      // transaction closed), kept alongside the deny site for the operator's trail.
      drainedBy: caller.control,
    },
  });
}
