import { and, asc, count, desc, eq, exists, gt, gte, inArray, isNotNull, isNull, lte, ne, notExists, notInArray, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { JobPlacementOwner } from "@armyofagents/shared";
import type { Db } from "../../client.js";
import {
  acquirePlatformTargetAuthorityShared,
  configurePlatformTargetAuthorityLockTimeout,
} from "../../platform-target-authority-lock.js";
import {
  agents,
  companies,
  companyMemberships,
  heartbeatRuns,
  internalAgentConversations,
  internalAgentMessages,
  internalAgentRuns,
  issues,
  jobAttempts,
  jobOutbox,
  jobs,
  leases,
  mcpApiKeys,
  organizationMemberships,
  organizations,
  executionTargets,
  providerCredentials,
  workers,
  workerOperationReceipts,
  workerLeaseRejections,
  services,
  serviceInstances,
  serviceGenerations,
  jobArtifacts,
  jobSecretHandles,
  jobEvents,
  jobProjectionReceipts,
  jobControlCommands,
  type Job,
  type JobAttempt,
  type JobOutbox,
  type NewJob,
  type NewJobAttempt,
  type NewJobOutbox,
  type Lease,
  type WorkerOperationReceipt,
  type NewWorkerLeaseRejection,
  type JobArtifact,
  type JobSecretHandle,
  type ServiceInstance,
} from "../../schema/index.js";
import {
  isActiveFence,
  classifyFence,
  JobFenceError,
  ArtifactCommitRejection,
  PatchApplyRejection,
  OrphanQuarantineRejection,
  SecretResolveRejection,
  authorizeSecretResolve,
  TERMINAL_ATTEMPT_STATUSES,
  type ActiveFenceRequest,
  type SecretRefKind,
} from "./job-fence.js";
import { classifyLeaseTruthRow, type LeaseTruthVerdict } from "./lease-truth.js";

export interface LeaseRejectionCleanupResult {
  readonly deleted: number;
  readonly cardinalityObserved: number;
  readonly cardinalitySaturated: boolean;
}

// Payload-free certificate telemetry derived by the claim SQL itself, never inferred from the
// returned candidate array. hits/misses count eligible-shaped attempts suppressed vs not-suppressed
// by a correlated rejection certificate; cardinality counts this worker/target's certificate rows.
// Every count is a bounded probe of at most 4097 rows reported as min(count, 4096) plus a saturation
// flag, so an unbounded tenant can never widen the gauge.
export interface LeaseCertificateScanMetrics {
  readonly hitsObserved: number;
  readonly hitsSaturated: boolean;
  readonly missesObserved: number;
  readonly missesSaturated: boolean;
  readonly scanExhausted: boolean;
  readonly cardinalityObserved: number;
  readonly cardinalitySaturated: boolean;
}

export interface LeaseCandidateScanResult {
  readonly candidates: LeaseCandidate[];
  readonly certificateMetrics: LeaseCertificateScanMetrics;
}

export interface TenantAdmissionRecord {
  organizationExists: boolean;
  companyInOrganization: boolean;
  principalAuthorized: boolean;
  requester: { kind: SourceRequesterKind; id: string } | null;
}

export type SourceRequesterKind =
  | "founder"
  | "team_lead"
  | "team_member"
  | "agent"
  | "commander"
  | "system";

export type SourceExecutorKind =
  | "worker"
  | "sandbox"
  | "browser_worker"
  | "service_instance";

export interface SourceExecutorAuthority {
  kind: SourceExecutorKind;
  id: string;
}

/**
 * SVC-002 — the three TERMINAL states of the frozen `serviceInstance` lifecycle, i.e. the
 * states with no outgoing transition in `SERVICE_INSTANCE_TRANSITIONS`
 * (packages/worker-protocol states.ts, mirrored in
 * docs/architecture/distributed-execution-lifecycles.json).
 *
 * Hand-listed here for the same reason the DB CHECK is: `packages/db` does not depend on
 * `@armyofagents/worker-protocol`. That makes this the THIRD copy of a frozen list living
 * outside its authority, so — exactly as SVC-001 did for the CHECK — the reconciliation is
 * asserted server-side against the imported authority, in
 * server/src/__tests__/service-reconciler.integration.test.ts. Both copies must move
 * together with the index predicate in migration 0275; the assertion is what makes that
 * true rather than hoped.
 */
export const TERMINAL_SERVICE_INSTANCE_STATUSES = Object.freeze([
  "stopped",
  "failed",
  "lost",
] as const);

/** The partial unique index that is SVC-002's duplicate-placement authority. */
export const LIVE_SERVICE_INSTANCE_INDEX = "service_instances_live_service_uq";

/**
 * SVC-005a — WHO may be recorded as having driven a service instance terminal, and it is a
 * FENCE INPUT rather than telemetry.
 *
 * ONE of these is a WITNESS and three are ASSUMPTIONS, and the generation rollout fence turns
 * on exactly that split:
 *
 *   `worker_stopped`           the worker's own attributed, generation-fenced observation that
 *                              the PROCESS WAS SEEN GONE. The only witness.
 *   `worker_unconfirmed`       the worker's own attributed, generation-fenced observation that
 *                              it can NO LONGER ACCOUNT FOR the process. See the ★ below.
 *   `liveness_deadline`        SVC-003b's clock condemned it because nothing had been heard.
 *                              The worker may still be running (E9-F007).
 *   `control_plane_backstop`   SVC-007a's cancelled-attempt projection moved a stranded
 *                              instance because its ATTEMPT was terminal.
 *
 * ★★★ WHY THE WORKER'S OWN EVENT IS SPLIT IN TWO, AND WHY COLLAPSING IT IS A FAIL-OPEN. The
 * first revision of this constant had a single `worker_event` author covering every terminal
 * move the ingest applied, on the reasoning that an attributed, fenced event is evidence. It is
 * evidence — but of WHAT depends on the event, and the daemon says so in its own header
 * (`packages/worker-daemon/src/supervisor/service-lifecycle.ts`):
 *
 *     service_instance_stopped  <- an observation of `exited` or `gone`.
 *     service_instance_lost     <- `inspect` could not describe the sandbox, or A FULL STOP
 *                                  LADDER ENDED WITH THE PROCESS STILL OBSERVED `running`.
 *
 * So `service_instance_lost` is the worker reporting that it COULD NOT CONFIRM THE STOP, and in
 * the worst case that the process SURVIVED CANCEL AND KILL — the supervisor's own comment at
 * that site reads "what is not established is that the PROCESS stopped, and this is where that
 * distinction is preserved". Treating it as a witness would let the rollout fence place
 * generation N+1 precisely when the generation-N process is KNOWN to be alive: the exact
 * overlap E9's SVC-005 acceptance forbids, admitted by the mechanism built to refuse it.
 * Raised by external review of PR #415 (P1), verified at that source, and fixed here rather
 * than in the fence, because the fence is right and the AUTHOR was lying.
 *
 * Mirrored by `service_instances_terminalized_by_check` (migration 0279); the reconciliation
 * asserts set EQUALITY server-side, exactly as SVC-001 did for the status CHECK, so an author
 * added on one side and not the other is caught rather than silently storable.
 */
export const SERVICE_INSTANCE_TERMINAL_AUTHORS = Object.freeze([
  "worker_stopped",
  "worker_unconfirmed",
  "liveness_deadline",
  "control_plane_backstop",
] as const);

export type ServiceInstanceTerminalAuthor = (typeof SERVICE_INSTANCE_TERMINAL_AUTHORS)[number];

/**
 * SVC-005a — the SUBSET of {@link SERVICE_INSTANCE_TERMINAL_AUTHORS} that constitutes a
 * WITNESS that the worker stopped.
 *
 * ★ DERIVED BY EXCLUSION, so the fail-closed direction is the default. A new author added to
 * the frozen list above is NOT a witness unless it is named here too — which means the fence
 * STALLS for an author nobody has classified, rather than admitting a placement on the
 * strength of a name it does not recognise.
 */
export const WITNESSED_SERVICE_INSTANCE_TERMINAL_AUTHORS = Object.freeze([
  "worker_stopped",
] as const);

/**
 * SVC-003b — one live instance, as the liveness sweep sees it.
 *
 * Both ages are milliseconds measured by the DATABASE's `clock_timestamp()` at read time, so
 * they are free of app/database clock skew (see `sweepServiceInstanceLiveness`).
 */
export interface ServiceInstanceLivenessRow {
  serviceInstanceId: string;
  serviceId: string;
  status: string;
  /**
   * ★ `null` MEANS THE WORKER HAS NEVER BEEN OBSERVED — not "observed a very long time ago".
   * The deadline may not age a liveness window against an observation that does not exist.
   */
  observedAgeMs: number | null;
  /** Age of the CONTROL PLANE's own row. A fact about when it started waiting, never an
   *  observation of the worker, and used only under the separate admission window. */
  createdAgeMs: number;
}

/** SVC-003b — what one liveness sweep did, per instance and in aggregate. */
export interface ServiceInstanceLivenessSweepResult {
  /** Live instances actually inspected (rows another transaction held locked are skipped). */
  scanned: number;
  /** Instances the decider condemned AND the frozen lifecycle permitted to move. */
  terminalized: Array<{ serviceInstanceId: string; serviceId: string; fromStatus: string }>;
  /**
   * Condemned, but the frozen predecessor set does not contain the observed status — so
   * nothing was written. Distinct from `terminalized` because a non-empty list here means the
   * server's derived set and the frozen table disagree, which is a defect, not a state.
   */
  refusedIllegal: Array<{ serviceInstanceId: string; fromStatus: string }>;
  /**
   * Condemned and legal, but the conditional write matched no row: something else moved the
   * status between the lock and the write. Reported rather than retried — the next tick
   * re-reads the row's real status.
   */
  lostRace: number;
}

/**
 * SVC-007 — the (service, generation) uniqueness that stands in for the deliberately absent
 * `services.current_generation_id` (schema/service_generations.ts header). It is what makes
 * "the current generation resolves by lookup" a constraint rather than a convention, and it
 * is therefore the one constraint the generation writer may resolve into a definite answer.
 */
export const SERVICE_GENERATION_INDEX = "service_generations_service_generation_uq";

// Fail at module load rather than at query time: `nonTerminalServiceInstanceStatus` below
// interpolates these values into SQL text with `sql.raw`, so anything but a bare lowercase
// identifier would be a defect the moment someone edited the frozen list. They come from a
// frozen `as const` in this file and can only change by an edit here, but an assertion costs
// nothing and makes the `sql.raw` provably safe rather than safe-by-inspection.
for (const status of TERMINAL_SERVICE_INSTANCE_STATUSES) {
  if (!/^[a-z_]+$/.test(status)) {
    throw new Error(
      `TERMINAL_SERVICE_INSTANCE_STATUSES contains ${JSON.stringify(status)}, which is not a ` +
        "bare lowercase identifier and therefore cannot be inlined as a SQL literal.",
    );
  }
}

const TERMINAL_STATUS_LITERAL_LIST = TERMINAL_SERVICE_INSTANCE_STATUSES
  .map((status) => `'${status}'`)
  .join(", ");

/**
 * SVC-002 — `status NOT IN (<the three frozen terminals>)`, emitted as SQL **LITERALS**
 * rather than bind parameters.
 *
 * ★★★ THE LITERALS ARE THE POINT, AND THIS WAS MEASURED, NOT GUESSED. `notInArray` emits the
 * statuses as `$n` parameters. postgres-js prepares these statements, and once PostgreSQL
 * switches a prepared statement to a GENERIC plan (after five custom executions) it can no
 * longer prove that a parameterised `status NOT IN ($1,$2,$3)` predicate implies the LITERAL
 * predicate of the partial index `service_instances_live_service_uq` — so the index becomes
 * unusable and the plan falls back to a sequential scan of `service_instances`. Reproduced on
 * PostgreSQL 18 in review of PR #406: the generic plan seq-scanned. For a tenant with
 * substantial instance history that turns the per-tick sweep into a full rescan, which delays
 * or prevents reconciliation under the statement timeout.
 *
 * ONE definition, used by all three readers of "is there a live instance", so the sweep
 * window's predicate, the observed-state count and the lost-race re-read cannot drift from
 * each other OR from the index predicate they are meant to match.
 */
export function nonTerminalServiceInstanceStatus() {
  return sql`${serviceInstances.status} NOT IN (${sql.raw(TERMINAL_STATUS_LITERAL_LIST)})`;
}

/**
 * SVC-002 — is this error a lost race against {@link LIVE_SERVICE_INSTANCE_INDEX}?
 *
 * NARROW ON PURPOSE. Only a 23505 naming that one index is a lost race; every other
 * constraint violation on the same insert (the composite tenant FK, the status CHECK) must
 * propagate, because reporting `conflict` for a service that has no instance at all would be
 * a fabricated definite answer — the exact fail-open shape SVC-008b's stop-verdict work
 * exists to refuse.
 *
 * postgres-js surfaces the PostgreSQL fields as `code` / `constraint_name`, sometimes behind
 * a `cause` chain, so both are unwrapped rather than assumed to be on the top-level object.
 */
function isLiveServiceInstanceConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const record = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (record.code === "23505" && record.constraint_name === LIVE_SERVICE_INSTANCE_INDEX) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/**
 * SVC-007 — is this error a lost race against {@link SERVICE_GENERATION_INDEX}?
 *
 * NARROW FOR THE SAME REASON {@link isLiveServiceInstanceConflict} is narrow: the sibling
 * constraints on this insert are the triple-composite tenant FK
 * (`service_generations_org_company_service_fk`, which is what proves the generation's
 * company matches its SERVICE's company) and the organization FK. Swallowing either of those
 * into "a generation already exists" would report a definite, wrong answer for a tenant
 * mismatch — the fail-open shape this epic keeps refusing.
 */
function isServiceGenerationConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const record = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (record.code === "23505" && record.constraint_name === SERVICE_GENERATION_INDEX) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

export interface JobControlRepository {
  admission(input: {
    organizationId: string;
    companyId: string;
    principalKind: string;
    principalId: string;
    principalRole?: string;
  }): Promise<TenantAdmissionRecord>;
  taskSourceIsAdmitted(input: {
    companyId: string;
    runId: string;
    issueId: string;
    assigneeAgentId: string;
  }): Promise<SourceExecutorAuthority | null>;
  internalRunSourceIsAdmitted(input: {
    companyId: string;
    runId: string;
    requesterKind: SourceRequesterKind;
    requesterId: string;
    triggerSource: "crew_dispatch" | "browser_request";
  }): Promise<SourceExecutorAuthority | null>;
  commanderSourceIsAdmitted(input: {
    companyId: string;
    runId: string;
    conversationId: string;
    userId: string;
  }): Promise<SourceExecutorAuthority | null>;
  serviceSourceIsAdmitted(input: {
    organizationId: string;
    companyId: string;
    serviceId: string;
    generation: number;
  }): Promise<SourceExecutorAuthority | null>;
  /**
   * SVC-002 — the INTENDED-state read for one reconcile pass.
   *
   * Takes the per-service advisory transaction lock, then pins the `services` row with
   * `SELECT ... FOR UPDATE` so `desired_state` AND `generation` cannot move under the pass
   * (SVC-005's generation bump is the concurrent writer this interlocks with). The lock is a
   * WAIT-INSTEAD-OF-RACE convenience; it is deliberately NOT the duplicate-placement
   * authority, which is `service_instances_live_service_uq`.
   *
   * Returns `null` when the service does not exist in this tenant — a definite absence, not
   * an unreadable state.
   */
  lockServiceForReconcile(input: {
    organizationId: string;
    companyId: string;
    serviceId: string;
  }): Promise<{ desiredState: string; generation: number } | null>;
  /**
   * SVC-002 — the OBSERVED-state read: how many instances of this service are NOT in a
   * terminal state. Non-terminal (rather than "healthy") is load-bearing: a reconciler that
   * asked for a HEALTHY instance would answer "none" on every tick under a drained or
   * capability-less fleet and submit forever, since `pending` is where such an instance sits.
   */
  countNonTerminalInstances(input: {
    organizationId: string;
    serviceId: string;
  }): Promise<number>;
  /**
   * SVC-002 — insert one service instance under a SAVEPOINT, resolving a lost race against
   * `service_instances_live_service_uq` into a definite answer instead of an aborted
   * transaction.
   *
   * WHY A SAVEPOINT. A 23505 aborts the whole PostgreSQL transaction; every later statement
   * raises 25P02 until a rollback, so the loser cannot simply "catch and re-read"
   * (server/src/services/companies.ts:391 already wrote this lesson down). `ROLLBACK TO
   * SAVEPOINT` un-aborts it and leaves everything before the savepoint intact, which is the
   * only option that keeps the instance insert and the job submission in ONE transaction --
   * and that single transaction is what makes a quota denial roll the instance back rather
   * than leave an orphan `pending` row that wedges the service forever.
   *
   * THE CATCH IS NARROW ON PURPOSE: only a 23505 naming that one index is a lost race. Any
   * other constraint violation propagates untouched, because swallowing it would report
   * `conflict` for a service that has no instance at all.
   *
   * The re-read is guaranteed to find the winner: `runInTenant` sets no isolation level, so
   * the transaction is READ COMMITTED and each statement takes a fresh snapshot; a 23505 is
   * raised only after the conflicting inserter COMMITTED (a winner that rolls back releases
   * the index entry and this insert then succeeds). Under REPEATABLE READ it would be a
   * serialization failure instead, which is why the level is stated rather than assumed.
   */
  insertServiceInstance(values: {
    id: string;
    organizationId: string;
    companyId: string;
    serviceId: string;
    generation: number;
    status: string;
  }): Promise<
    | { outcome: "inserted"; instance: ServiceInstance }
    | { outcome: "conflict"; instance: ServiceInstance | null }
  >;
  /**
   * SVC-002 — attribute an instance to the job/attempt serving it, inside the SAME
   * transaction that inserted the instance and submitted the job.
   *
   * Two writes rather than one because the ordering is forced: the instance id must exist
   * before the submission (the frozen `serviceWorkloadV1Schema` requires `serviceInstanceId`
   * and the derived idempotency key is a function of it), and the job/attempt ids only exist
   * after it. Doing the insert LAST would mean the loser of a race had already claimed org
   * capacity and written a job before discovering it lost.
   *
   * Deliberately does NOT touch `status`: `recordServiceHealth` remains the only writer of
   * that column, and widening a governed fence mutator's domain is SVC-003's (SVC-001 §3.2
   * CORRECTION 6a).
   */
  attributeServiceInstance(input: {
    organizationId: string;
    serviceInstanceId: string;
    jobId: string;
    attemptId: string;
  }): Promise<ServiceInstance | null>;
  /**
   * ★★★ SVC-003b — THE LIVENESS DEADLINE'S TRANSACTIONAL HALF. Read the tenant's LIVE
   * instances under a row lock, ask the caller's pure decider about each, and terminalize the
   * ones it condemns through the same single writer every other status move goes through.
   *
   * ── WHY THE DECIDER IS INJECTED (and this is not indirection for its own sake) ──────────
   *
   * Two authorities the decision needs live in packages this one cannot import.
   * `SERVICE_INSTANCE_TRANSITIONS` is in `@armyofagents/worker-protocol` (`packages/db`
   * deliberately does not depend on it — the status CHECK and the live-instance index
   * predicate are hand-written copies for exactly that reason), and the deadline windows are
   * operator POLICY, which is not a repository's to hold. Re-deriving either here would be a
   * fourth copy of a frozen list plus a policy constant buried in a data-access layer. So the
   * server computes both and hands them down — the same shape `renewLease` already uses for
   * `projectControlExtensions`, and `applyServiceProjectionForFence` for `allowedFromStatuses`.
   *
   * ── `FOR UPDATE SKIP LOCKED`, AND SKIPPING IS CORRECT RATHER THAN MERELY CONVENIENT ─────
   *
   * A row another transaction holds locked is one an event ingest is projecting onto RIGHT
   * NOW, which is positive evidence that its worker is alive. Skipping it cannot be a false
   * negative in the dangerous direction: the sweep never terminalizes an instance it could not
   * inspect, and a genuinely silent instance is never locked, so it is picked up on this tick
   * or the next one.
   *
   * ── THE AGES ARE COMPUTED IN SQL, NOT IN JAVASCRIPT ─────────────────────────────────────
   *
   * `last_observed_at` is written with `clock_timestamp()`, so ageing it against a JavaScript
   * `Date.now()` would measure the SKEW between the app process and the database on top of the
   * elapsed time. A control plane whose clock ran a few minutes ahead of its database would
   * terminalize healthy services; one running behind would never terminalize anything. Both
   * ages come out of the same `clock_timestamp()` that wrote the column, so neither can happen.
   *
   * ★ `observedAgeMs` IS `null`, NEVER A LARGE NUMBER, when the worker has never been
   * observed. The two cases must stay distinguishable all the way to the decider — collapsing
   * them (a `COALESCE` onto `created_at`, or a sentinel `Infinity`) applies the SHORT liveness
   * window to an instance whose worker has simply not polled yet, and kills services that are
   * merely starting.
   */
  sweepServiceInstanceLiveness(input: {
    organizationId: string;
    /** Batch bound, clamped to 1..256. */
    limit: number;
    /**
     * The status a condemned instance is driven to, and the frozen predecessor set for it,
     * both computed by the server from `SERVICE_INSTANCE_TRANSITIONS`.
     *
     * The legality gate is enforced HERE and not only in the decider, deliberately: it is the
     * same independent check `applyServiceProjectionForFence` applies, so a decider bug can no
     * more drive an illegal move than a worker's payload can. An empty set refuses everything.
     */
    toStatus: string;
    allowedFromStatuses: readonly string[];
    /** The caller's pure liveness policy. Returns `true` to terminalize this instance. */
    decide: (row: ServiceInstanceLivenessRow) => boolean;
  }): Promise<ServiceInstanceLivenessSweepResult>;
  /**
   * SVC-002 — the sweep window: services in this tenant that DIVERGE from their desired
   * state, ordered by id from a rotating cursor.
   *
   * Two predicates, and the second one is a review fix (PR #406):
   *
   * 1. `desired_state = 'running'` — an ALLOW-LIST, never a deny-list. A deny-list would
   *    admit `paused` and `deleted`; an allow-list is fail-closed and gives SVC-005's pause
   *    its enforcement for free.
   * 2. **NO non-terminal instance exists.** ★ THIS IS WHAT MAKES THE SWEEP TERMINATE. Without
   *    it the window is "every running service", and a converged service — which stays
   *    `running` forever — occupies its page slot forever. For a tenant with more services
   *    than a page holds, the same lowest-id rows filled every page on every tick and every
   *    later service STARVED, silently. A cursor alone only narrows that window: it still
   *    depends on a full pass completing, so a control-plane restart or a repeatedly
   *    budget-truncated tick could re-starve the tail. Filtering converged services out
   *    means the window IS the work, so progress does not depend on remembering anything.
   *
   * The `NOT EXISTS` is served by `service_instances_live_service_uq`, whose index predicate
   * is exactly this subquery's — the same partial unique index that is the ticket's
   * duplicate-placement authority.
   *
   * This does NOT make the in-pass observed-state check redundant: the window is read in one
   * transaction and each pass opens its own, so an instance can appear in between. The
   * window is an optimisation of WHICH services to visit; the index remains the authority for
   * how many instances a service may have.
   */
  listReconcilableServices(input: {
    afterServiceId: string | null;
    limit: number;
  }): Promise<Array<{ serviceId: string; companyId: string; generation: number }>>;
  /**
   * SVC-002 — the immutable definition this generation froze (SVC-001's `service_generations`).
   *
   * ★ THE UNKNOWN CASE IS THE POINT. `null` here means the read ANSWERED and there is no row
   * for (service, generation). It does NOT mean "start it with a default command": the
   * service's INTENDED state says `running`, but the definition needed to realize that intent
   * is not there, so the honest verdict is that the reconciler cannot decide and must stall.
   * A default branch that returned a definite answer for an unreadable intent is exactly the
   * fail-open SVC-008b's `deriveStopVerdict` was built to refuse.
   *
   * `service_generations` has ZERO writers in the tree (SVC-002-terrain.md §1) and SVC-002
   * adds none -- the create/update controls that fill it are SVC-007's. So on a real
   * deployment this read answers `null` for every service today, and the reconciler stalls
   * rather than inventing a workload. That is stated here so a green acceptance suite is not
   * read as "services start".
   */
  findServiceGenerationDefinition(input: {
    organizationId: string;
    companyId: string;
    serviceId: string;
    generation: number;
  }): Promise<{ definition: Record<string, unknown>; ttlSeconds: number | null; checkpointArtifactId: string | null } | null>;
  /**
   * SVC-007 — the FIRST writer `service_generations` has ever had.
   *
   * ★ WHY THIS METHOD EXISTS AT ALL. `findServiceGenerationDefinition` above says in its own
   * words that this table "has ZERO writers in the tree", so the reconciler answered
   * `no_generation` for every service on every real deployment and E9 could not start
   * anything. This is the other half of that read.
   *
   * IMMUTABILITY IS A GRANT, NOT A TRIGGER (schema/service_generations.ts header): `aoa_app`
   * holds SELECT and INSERT here and no UPDATE or DELETE. So this repository deliberately
   * exposes ONLY an insert — there is no update method to write, because the role could not
   * execute one. A caller that wants to change a definition mints the NEXT generation.
   *
   * Returns `null` on a 23505 against `service_generations_service_generation_uq`, which is
   * the (service, generation) uniqueness that stands in for the absent
   * `services.current_generation_id`. A definite `null` rather than a throw, because the
   * create path composes this with the `services` insert inside ONE transaction and a raised
   * 23505 would abort the whole transaction (25P02 on every later statement) — the same
   * lesson `insertServiceInstance` records above. The savepoint is the mechanism, for the
   * same reason it is there.
   */
  insertServiceGeneration(values: {
    organizationId: string;
    companyId: string;
    serviceId: string;
    generation: number;
    definition: Record<string, unknown>;
    createdBy: string | null;
  }): Promise<{ id: string; generation: number } | null>;
  /**
   * SVC-007 — the desired-state control's WRITE, as a compare-and-set on `desired_state`.
   *
   * The caller must already hold this service's row lock (`lockServiceForReconcile`), so the
   * `expectedDesiredState` predicate is belt to that braces rather than the authority: it
   * exists so that a future caller which forgets the lock still cannot overwrite a state it
   * did not read. Returns `null` when nothing matched — an absent service and a state that
   * moved are the same answer here, and the locked caller has already distinguished them.
   *
   * Deliberately does NOT touch `generation`: minting a new generation is a rollout, and a
   * rollout without SVC-005's "no two generations perform external effects simultaneously"
   * fence is exactly the overlap E9's acceptance forbids. See SVC-007a-design.md section 4.
   *
   * ★ SVC-005a UPDATE, so this paragraph is not read as a live gap it no longer is: the
   * rollout writer now exists ({@link JobControlRepository.bumpServiceGeneration}) and this
   * method still does not touch `generation` — the two controls stay separate. What SVC-005a
   * does NOT claim is the whole clause; see `listUnwitnessedGenerationPredecessors` for which
   * half is fenced and which residual (E9-F007) stays open.
   */
  updateServiceDesiredState(input: {
    organizationId: string;
    companyId: string;
    serviceId: string;
    expectedDesiredState: string;
    desiredState: string;
  }): Promise<{ desiredState: string; generation: number } | null>;
  /**
   * SVC-007 — the company-scoped read behind the operator view. Company scoping is
   * necessarily app-layer (`aoa.organization_id` is the only GUC), so the company predicate
   * is stated here and not left to RLS.
   */
  findServiceForCompany(input: {
    organizationId: string;
    companyId: string;
    serviceId: string;
  }): Promise<{
    serviceId: string;
    desiredState: string;
    generation: number;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
  /**
   * SVC-007 — ★★★ THE CONTROL-PLANE HALF OF THE ATTEMPT-TERMINAL BACKSTOP, and it closes a
   * PERMANENT WEDGE that the worker-side backstop structurally cannot reach.
   *
   * `requestCancellation` has a branch (`if (!lease || !attempt || …)`) that FINALIZES a
   * cancellation directly — attempt and job both driven to `cancelled` under the locks it
   * already holds — precisely because there is no fenced worker to drain. That is the normal
   * case for a service the operator stops before its job was ever leased, which today is
   * every service, since `E9-F002` keeps `workload.service` unofferable on most fleets.
   *
   * On that branch NO worker event is ever emitted, so SVC-003a's attempt-terminal backstop
   * — which lives in the event decider and fires only from an ingested `terminal` — never
   * runs. The instance stays `pending` inside `service_instances_live_service_uq` forever,
   * and `countNonTerminalInstances` therefore answers 1 for the rest of the service's life:
   * a later `stopped → running` resume converges NOTHING, reporting `instance_present` on
   * every tick. Stop-then-resume would silently never restart. That is E9-F005's wedge
   * reached through the control plane instead of through the daemon.
   *
   * ★ IT IS NOT A NEW SEMANTIC. The caller derives `toStatus`/`allowedFromStatuses` from THE
   * SAME `decideServiceProjection` the worker path uses, for THE SAME attempt status, so the
   * two paths cannot drift into two ideas of what a cancelled attempt means. `packages/db`
   * does not depend on `worker-protocol`, which is why the frozen predecessor set arrives as
   * a parameter here exactly as it does on `ServiceInstanceProjectionInput`.
   *
   * ★ THE DATABASE IS THE AUTHORITY, NOT THE CALLER. The attempt this instance is attributed
   * to must ALREADY be terminal and NOT `succeeded`, read under the instance's row lock. So
   * this method cannot terminalize a live instance even if a future caller asks it to, and a
   * `succeeded` attempt (which emitted its own `_stopped`) is refused rather than overruled —
   * the same two bounds the worker-side backstop states for itself.
   *
   * NO PROJECTION RECEIPT IS WRITTEN, and that is forced rather than chosen:
   * `job_projection_receipts.source_fence` is NOT NULL and this path has no fence, by
   * definition. Idempotency comes from the conditional write plus the already-terminal no-op,
   * which is what makes a repeated stop request free.
   */
  terminalizeServiceInstanceForCancelledAttempt(input: {
    organizationId: string;
    companyId: string;
    jobId: string;
    toStatus: string;
    allowedFromStatuses: readonly string[];
  }): Promise<
    | { outcome: "applied"; serviceInstanceId: string; fromStatus: string; toStatus: string }
    | { outcome: "noop_already_terminal"; serviceInstanceId: string; fromStatus: string }
    | { outcome: "attempt_not_terminal"; serviceInstanceId: string; attemptStatus: string | null }
    | { outcome: "illegal_transition"; serviceInstanceId: string; fromStatus: string }
    | { outcome: "unattributed" }
  >;
  /** SVC-007 — one page of a company's services, ordered by id, for the operator list. */
  listServicesForCompany(input: {
    organizationId: string;
    companyId: string;
    afterServiceId: string | null;
    limit: number;
  }): Promise<Array<{
    serviceId: string;
    desiredState: string;
    generation: number;
    createdAt: Date;
    updatedAt: Date;
  }>>;
  /**
   * SVC-007 — the LIVE instance for a service, i.e. the one row
   * `service_instances_live_service_uq` permits to exist in a non-terminal status. Returns
   * `null` when the service has none, which is the normal state for a `paused`/`stopped`
   * service and for a `running` one the reconciler has not converged yet.
   */
  findLiveServiceInstance(input: {
    organizationId: string;
    serviceId: string;
  }): Promise<{
    serviceInstanceId: string;
    status: string;
    generation: number;
    jobId: string | null;
    attemptId: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
  /**
   * SVC-005a — ★★★ THE WRITER `services.generation` HAS NEVER HAD, as a compare-and-set.
   *
   * Until this method the column was `notNull().default(1)` and was READ as a WHERE predicate
   * in exactly one place (`serviceSourceIsAdmitted`) and pinned under a row lock in another
   * (`lockServiceForReconcile`). `update(services)` for `generation` appeared ZERO times in
   * the tree, which is why DE-12's audit clause was ruled VACUOUS by founder decision
   * E0-F013: "no generation ever changes". This is the writer that makes it changeable, and
   * SVC-002 and SVC-007a each scoped it out to SVC-005 by name.
   *
   * ★ THE CALLER MUST ALREADY HOLD THE SERVICE'S ROW LOCK (`lockServiceForReconcile`). The
   * `expectedGeneration` predicate is belt to that braces, on the same argument
   * `updateServiceDesiredState` makes for its own compare-and-set: a future caller that
   * forgets the lock still cannot overwrite a generation it did not read.
   *
   * ★ IT ONLY EVER GOES FORWARD BY ONE. `expectedGeneration` and `expectedGeneration + 1` are
   * both computed here from the single parameter rather than accepted as two, so no caller can
   * ask for a skip or a rewind. A rewind would be the worse of the two: `service_generations`
   * is immutable and its (service, generation) uniqueness means generation N's definition
   * already exists, so rolling BACK to N would silently re-point the service at a definition
   * whose instances have already run and been reconciled against — and the instance-level
   * generation fence (`applyServiceProjectionForFence` step 3) would then stop refusing events
   * it currently refuses.
   *
   * Returns `null` when nothing matched: the generation moved between the caller's read and
   * this write, which under the row lock means a writer that did not take it.
   */
  bumpServiceGeneration(input: {
    organizationId: string;
    companyId: string;
    serviceId: string;
    expectedGeneration: number;
  }): Promise<{ generation: number } | null>;
  /**
   * SVC-005a — ★★★ THE GENERATION ROLLOUT FENCE'S READ: instances of a PREVIOUS generation
   * that ended WITHOUT A WITNESS and whose worker may therefore still be running.
   *
   * WHAT IT ANSWERS, and it is a claim about the WORLD rather than about a column. E9's
   * acceptance for SVC-005 is "no two generations may perform external effects
   * simultaneously". Placement overlap is already impossible —
   * `service_instances_live_service_uq` permits exactly one non-terminal instance per service,
   * so the reconciler cannot place generation N+1 while N is live. The hole is E9-F007: an
   * instance driven terminal BY A CLOCK has left that index while its worker may still be
   * running and still performing external effects. Placing N+1 on the strength of such a row
   * is precisely the overlap the clause forbids.
   *
   * So this returns the rows for which the control plane does NOT know the old generation
   * stopped, under THREE conjunctive conditions, all of them database facts:
   *
   *   (1) `generation <> currentGeneration` — a DIFFERENT generation. Same-generation
   *       replacement is NOT returned, deliberately: E9-F007 §3 ruled that overlap the smaller
   *       harm against the permanent wedge of never terminalizing, and SVC-005a does not
   *       reopen that ruling. The acceptance clause is about two GENERATIONS.
   *   (2) `terminalized_by` is not one of
   *       {@link WITNESSED_SERVICE_INSTANCE_TERMINAL_AUTHORS} — including NULL, which is a row
   *       terminalized before migration 0279 and is UNKNOWN, hence not a witness. Fail-closed.
   *   (3) the instance's ATTEMPT has not reached a terminal status. This is the RECOVERY
   *       CONDITION, and without it the stall would be a permanent wedge — the failure class
   *       this epic keeps meeting. A terminal attempt closes the fence: `classifyFence`
   *       (packages/db/src/repositories/tenant/job-fence.ts) returns `attempt_terminal` before
   *       any other test, so the old worker can no longer write ANYTHING through the ingest.
   *       An instance with no `attempt_id` at all has no fence to close and is treated as
   *       satisfying (3) — it was never leased, so no worker ever ran for it.
   *
   * ★ WHAT THIS DOES NOT PROVE, stated here because the clause is about external effects and
   * this method cannot see them. A closed fence stops the old worker WRITING; it does not stop
   * its PROCESS. No control-plane fact can, and E9-F007 §3 says so. The residual is real,
   * bounded by the lease TTL and the reaper interval, and is NOT claimed closed.
   *
   * Bounded by `limit`, and a non-empty answer is all the fence needs — the caller stalls on
   * the first row. The rows are returned rather than a boolean so the stall can NAME what
   * blocked it.
   */
  listUnwitnessedGenerationPredecessors(input: {
    organizationId: string;
    serviceId: string;
    currentGeneration: number;
    limit: number;
  }): Promise<Array<{
    serviceInstanceId: string;
    generation: number;
    status: string;
    terminalizedBy: string | null;
    attemptId: string | null;
    attemptStatus: string | null;
  }>>;
  insertJobOnce(values: NewJob): Promise<Job | null>;
  findSubmission(input: {
    organizationId: string;
    companyId: string;
    authenticatedPrincipalKind: string;
    authenticatedPrincipalId: string;
    authenticatedSourceKind: string;
    authenticatedSourceIdentity: string;
    idempotencyKey: string;
  }): Promise<Job | null>;
  insertAttempt(values: NewJobAttempt): Promise<JobAttempt>;
  findInitialAttempt(jobId: string): Promise<JobAttempt | null>;
  insertOutbox(values: NewJobOutbox): Promise<JobOutbox>;
  lockPlacementContext(input: {
    organizationId: string;
    companyId: string;
    jobId: string;
    attemptId: string;
  }): Promise<{ job: Job; attempt: JobAttempt } | null>;
  listPlacementCandidateSnapshots(): Promise<PlacementCandidateSnapshot[]>;
  persistPlacementDecision(input: PlacementDecisionWrite): Promise<JobAttempt | null>;
  /** DAT-008 — the executing agent's adapter binding, for the secret-handle mint.
   * Company-scoped; returns null for an unknown agent (never an existence oracle,
   * since the caller already proved the job's tenancy under the placement lock). */
  loadAgentAdapterBinding(input: {
    companyId: string;
    agentId: string;
  }): Promise<{ adapterType: string; adapterConfig: Record<string, unknown> } | null>;
  /** DAT-008 — mint ONE opaque execution-secret handle for a job. The row carries a
   * REFERENCE only (`ref_kind`/`ref_id`); no secret value ever lands here. Idempotent
   * per (organization, job, ref): a replayed placement must not mint a second handle. */
  insertExecutionSecretHandle(input: {
    organizationId: string;
    companyId: string;
    jobId: string;
    handle: string;
    refKind: "provider_key" | "company_secret" | "run_jwt";
    refId: string;
    materialization: "env";
    usePolicy: "sandbox_local_only";
    envTarget: string;
    /** Pinned version selector for `ref_id`; null = latest. */
    refVersion: string | null;
    boundTargetGeneration: number | null;
    ownerPrincipalKind: string | null;
    ownerPrincipalId: string | null;
  }): Promise<{ handle: string; minted: boolean }>;
  /** DAT-008 — the ACTIVE handles to advertise in a job's lease envelope. Ordered by
   * creation so an envelope is byte-stable across rebuilds of the same job. Revoked
   * or non-active rows are excluded here as well as at resolve time. */
  listActiveExecutionSecretHandles(input: {
    organizationId: string;
    jobId: string;
  }): Promise<Array<{
    handle: string;
    materialization: string | null;
    materializationTarget: string | null;
    usePolicy: string | null;
  }>>;
  lockWorkerLeaseAuthority(input: {
    workerId: string;
    targetId: string;
  }): Promise<LeaseWorkerAuthority | null>;
  lockEligibleLeaseCandidates(input: {
    admissibleWorkloadTypes: string[];
    eligibilityVersion: number;
    limit: 256;
    placementOwner: Exclude<JobPlacementOwner, "legacy">;
    staticContextHash: string;
    targetAuthorityKey: string;
    targetClass: Exclude<JobPlacementOwner, "legacy">;
    targetGeneration: number;
    targetId: string;
    targetProfileHash: string;
    targetProviderConstraintHash: string;
    targetScope: string;
    workerId: string;
  }): Promise<LeaseCandidateScanResult>;
  snapshotLiveLeaseCapacity(input: {
    workerId: string;
    targetId: string;
  }): Promise<{ total: number; batch: number; browserSession: number; service: number }>;
  upsertLeaseRejectionCertificates(
    input: StaticLeaseRejectionInput[] | { certificates: NewWorkerLeaseRejection[] },
  ): Promise<number>;
  cleanupLeaseRejectionCertificates(input: {
    limit: number;
    cardinalityLimit: number;
    beforeStatement(phase: "select" | "delete" | "cardinality"): Promise<void>;
  }): Promise<LeaseRejectionCleanupResult>;
  acquirePlatformTargetAuthorityShared(targetId: string): Promise<void>;
  recheckPlatformTargetAuthority(input: {
    targetId: string;
    targetAuthorityKey: string;
    targetGeneration: number;
  }): Promise<PlacementCandidateSnapshot["target"] | null>;
  touchWorkerLeaseProfile(input: {
    workerId: string;
    targetId: string;
    targetGeneration: number;
  }): Promise<boolean>;
  currentDatabaseTime(): Promise<Date>;
  setLocalStatementTimeout(milliseconds: number): Promise<void>;
  offerLease(input: {
    attemptId: string;
    organizationId: string;
    companyId: string;
    jobId: string;
    attemptNumber: number;
    workerId: string;
    targetId: string;
    targetAuthorityKey: string;
    targetGeneration: number;
    profileHash: string;
    providerConstraintHash: string;
    fence: string;
    ackDeadline: Date;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<Lease | null>;
  cleanupExpiredOperationReceipts(expiresBefore: Date, limit?: number): Promise<number>;
  findOperationReceipt(input: {
    organizationId: string;
    workerId: string;
    targetId: string;
    targetGeneration: number;
    profileHash: string;
    operation: "lease_ack" | "lease_renew";
    idempotencyKey: string;
  }): Promise<WorkerOperationReceipt | null>;
  lockLeaseAckContext(input: {
    organizationId: string;
    workerId: string;
    targetId: string;
    targetGeneration: number;
    profileHash: string;
    leaseId: string;
    jobId: string;
    attemptNumber: number;
    fence: string;
  }): Promise<{ lease: Lease; attempt: JobAttempt } | null>;
  activateLeaseAck(input: {
    organizationId: string;
    companyId: string;
    jobId: string;
    attemptId: string;
    attemptNumber: number;
    leaseId: string;
    workerId: string;
    targetId: string;
    targetAuthorityKey: string;
    targetGeneration: number;
    profileHash: string;
    providerConstraintHash: string;
    placementProfileHash: string;
    fence: string;
    idempotencyKey: string;
    semanticDigest: string;
    receiptExpiresAt: Date;
    outcome: Record<string, unknown>;
  }): Promise<Lease | null>;
  // ---------------------------------------------------------------------------
  // JOB-004 — conditional lease renewal + the CLOSED governed-mutator surface.
  //
  // `renewLease` extends ONLY the active fence's expiry using a fresh SQL
  // `clock_timestamp()` inside the conditional mutation (never a transaction-start
  // or JavaScript time), matches the complete lease identity + fence, increments no
  // authority (fence/generation unchanged), and stores the renewed expiry + cancel
  // response in the operation receipt atomically. Expired/replaced → stale_fence,
  // terminal attempt → attempt_terminal (both raised as `JobFenceError`).
  //
  // The seven guarded mutators below are the CLOSED governed surface; EVERY one
  // gates on the common active-fence guard before mutating (or reading). The four
  // that have a kernel table (`job_artifacts`, `job_secret_handles`, `job_attempts`,
  // `service_instances`) do a thin real mutation; the three whose storage is not yet
  // built (events, projection receipts, control commands) are stubbed BUT STILL
  // gated — JOB-005/006/011 fill the storage behind this already-guarded interface.
  //
  // JOB-015 — `projectControlExtensions` is REQUIRED, not optional, and that is the
  // fail-closed choice. It turns the lease's un-ACKed control commands into the frozen
  // response's bounded `extensions` array. It is injected because `packages/db`
  // deliberately does not depend on `@armyofagents/worker-protocol` (see
  // `schema/services.ts:37-39`), the same topology `commitArtifactVersion` uses for the
  // frozen prefix helper. Making it required means a new caller CANNOT silently
  // reintroduce the hardcoded `extensions: []` this ticket exists to remove: the type
  // checker asks for the projector. `existing` is always `[]` today; it is passed so
  // the projector probes the UNION and is not sibling-blind if a second lease-envelope
  // extension ever lands.
  renewLease(input: ActiveFenceRequest & {
    leaseDurationMs: number;
    idempotencyKey: string;
    semanticDigest: string;
    projectControlExtensions: (
      existing: readonly unknown[],
      pending: readonly QueuedControlCommand[],
    ) => readonly unknown[];
  }): Promise<{ lease: Lease; body: Record<string, unknown> }>;
  acceptEvent(
    input: ActiveFenceRequest & { batch?: AcceptEventBatchInput },
  ): Promise<GuardedFenceResult & {
    ingest?: EventIngestOutcome;
    /** SVC-003 — one entry per event that CARRIED a decided service projection, in
     *  batch order, whether or not it moved a row. Returned so a refusal is observable
     *  (the ingest logs it) instead of being a silent no-write. */
    serviceProjections?: readonly { eventId: string; result: ServiceProjectionOutcome }[];
  }>;
  authorizeArtifactCommit(
    input: ActiveFenceRequest & { identifier: string },
  ): Promise<JobArtifact>;
  /**
   * DAT-009 slice 2 — record a GRANT INTENT at upload-grant mint time.
   *
   * Before this, the mint recorded NOTHING durable: it wrote no row and recorded no
   * operation receipt, so the control plane had no record that an object key had ever
   * been granted. Combined with a storage port that has no list operation, an orphaned
   * upload — the bytes a dead fence's presigned PUT still lands, which commit then
   * refuses as `stale_fence` — was undiscoverable by any means.
   *
   * The `status='granted'` row makes that orphan discoverable BY ITS OWN RECORD.
   * Idempotent on the third disjoint partial-unique natural key (a replayed grant
   * request returns the existing intent), exactly as the committed and quarantined
   * writes above.
   *
   * Fence-guarded like every governed mutator here. The one production caller already
   * holds the fence lock when it calls this, so in that path the guard is
   * defence-in-depth rather than the live check — it is present so the mutator is safe
   * for ANY caller, and because `GUARDED_JOB_MUTATORS` makes that structural rather
   * than a convention someone has to remember.
   */
  recordArtifactGrantIntent(
    input: ActiveFenceRequest & {
      identifier: string;
      objectKey: string;
      expiresAt: Date;
      expectedSha256: string;
      maxBytes: number;
    },
  ): Promise<JobArtifact>;
  /**
   * DAT-002 — the fenced, verified commit of a rich artifact manifest. Runs
   * `guardActiveFence` FIRST (a stale/terminal fence throws `JobFenceError` BEFORE
   * any hash/size check — the documented precedence), then verifies the manifest's
   * object-key prefix, tenant, size, and sha256 against the store-observed actuals
   * (throwing `ArtifactCommitRejection` on mismatch), computes a per-(org,job)
   * `versionNumber` under the fence lock, and inserts the `status='committed'` row
   * idempotently on the partial-unique natural key (a replay returns the existing
   * committed row unchanged). `prefixValid`/`tenantValid` are pre-evaluated by the
   * server (which owns the frozen worker-protocol prefix helper) and re-checked here
   * AFTER the guard to preserve fence-first precedence.
   */
  commitArtifactVersion(
    input: ActiveFenceRequest & {
      identifier: string;
      objectKey: string;
      contentType: string;
      kind: string;
      sensitivity: string;
      retention: string;
      declaredSizeBytes: number;
      declaredSha256: string;
      actualSizeBytes: number;
      actualSha256: string;
      prefixValid: boolean;
      tenantValid: boolean;
    },
    /**
     * ★ `replayed` DISTINGUISHES A GENUINE FIRST COMMIT FROM AN IDEMPOTENT REPLAY,
     * and the caller cannot infer it (Codex P2 on PR #409, verified). Both cases
     * return a committed row and both answer the worker `outcome: "committed"`,
     * but on a replay this call WROTE NOTHING — the returned row was committed by
     * an earlier transaction, under whatever manifest that one carried. A caller
     * that audits per-commit needs to know which happened: DE-11's retention
     * record would otherwise fire again on every ordinary transport retry, and a
     * replay carrying a DIFFERENT declared retention would mint a row asserting a
     * declared/stored pair that was never decided for the persisted artifact.
     */
  ): Promise<JobArtifact & { replayed: boolean }>;
  /**
   * DAT-003 — the fenced apply/review of a COMMITTED `workspace_patch`. Runs
   * `guardActiveFence` FIRST (a stale/terminal/revoked fence throws `JobFenceError`
   * BEFORE any patch-row read — the documented precedence). Then, under the held
   * fence lock:
   *   1. Load the committed `workspace_patch` row for (org, job, attempt, identifier);
   *      throw `PatchApplyRejection('patch_not_committed')` if absent, or
   *      `PatchApplyRejection('object_key_mismatch')` if the presented `patchObjectKey`
   *      does not equal the committed row's object key (so the parsed base/result
   *      digests are bound to the immutable committed object).
   *   2. If it is already `apply_status='applied'`, return `applied` unchanged
   *      (idempotent no-op).
   *   3. Resolve the job's currently-accepted base manifest hash (D3): the
   *      `result_manifest_hash` of the most-recent OTHER `apply_status='applied'`
   *      workspace_patch, else the committed `workspace_snapshot`'s `sha256`
   *      (== manifestHash by the canonical-upload convention), else null.
   *   4. `applied` iff the accepted base is non-null AND equals the patch's declared
   *      `patchBaseManifestHash`; otherwise `conflict_quarantined` (NEVER auto-applies).
   *      Persist `base_manifest_hash` / `result_manifest_hash` / `apply_status` on the
   *      row. On `applied`, the accepted base advances to `result_manifest_hash`.
   * The fence lock serializes concurrent applies against the same lease, so a loser
   * observing an advanced base is quarantined.
   */
  recordPatchApplyState(
    input: ActiveFenceRequest & {
      identifier: string;
      patchObjectKey: string;
      patchBaseManifestHash: string;
      patchResultManifestHash: string;
    },
  ): Promise<PatchApplyStateResult>;
  readSecretHandle(
    input: ActiveFenceRequest & { handle: string },
  ): Promise<JobSecretHandle | null>;
  /**
   * DAT-004 — the fenced, lease-scoped RESOLVE authorization of an opaque execution
   * secret handle. Runs `guardActiveFence` FIRST (a stale/terminal/revoked fence
   * throws `JobFenceError` BEFORE any handle row is read — the documented precedence).
   * Then, under the held fence lock:
   *   1. Load the WIDENED handle row for (org, job, handle); throw
   *      `SecretResolveRejection('unknown_ref_kind')` (coarse, non-disclosing) if absent.
   *   2. Re-derive the dispatching owner from the LOCKED `jobs` row
   *      (`executorPrincipalKind/Id`) — the `ActiveFenceRequest` carries NO owner.
   *   3. For an owner-bound handle, re-check the owner's ACTIVE `company_memberships`
   *      in the SAME tx (membership loss DENIES).
   *   4. `authorizeSecretResolve` re-verifies the materialization×use_policy invariant,
   *      the sandbox-local-vs-network-destination invariant, the `bound_target_generation`
   *      pin (D5) against the LIVE lease generation, and the owner binding.
   *   5. Write the audit-as-columns (last_resolved_at + resolve_count++) in the SAME tx.
   * Returns the AUTHORIZED non-secret binding ONLY — NEVER a secret value (the value is
   * resolved behind the fence by the server broker dispatch). Throws `JobFenceError`
   * (guard) or `SecretResolveRejection` (authorization).
   */
  resolveExecutionSecret(
    input: ActiveFenceRequest & { handle: string; appliedPolicyVersion?: number | null },
  ): Promise<AuthorizedSecretResolution>;
  completeAttempt(
    input: ActiveFenceRequest & { terminalStatus: TerminalCompletionStatus },
  ): Promise<JobAttempt>;
  recordServiceHealth(
    input: ActiveFenceRequest & { serviceInstanceId: string; healthStatus: ServiceHealthStatus },
  ): Promise<ServiceInstance>;
  applyProjectionReceipt(
    input: ActiveFenceRequest & { projection?: ProjectionInput },
  ): Promise<GuardedFenceResult>;
  // JOB-006 — the worker's fence-guarded ACK of a control command. Gates on the
  // active fence FIRST (bare-fence back-compat returns the guarded proof only); when
  // an `ack` is supplied it records the worker's echoed status idempotently.
  ackControlCommand(
    input: ActiveFenceRequest & { ack?: ControlCommandAckInput },
  ): Promise<GuardedFenceResult & { ackOutcome?: ControlCommandAckOutcome }>;
  /** The highest contiguous accepted event sequence for an attempt (0 = none).
   * A read used to build the cumulative ACK on the stale-fence/terminal paths;
   * NOT a governed mutator (no fence gate — it writes nothing). */
  readAcceptedThroughSeq(input: {
    organizationId: string;
    companyId: string;
    jobId: string;
    attemptId: string;
  }): Promise<number>;
  claimReadyOutbox(input: {
    claimToken: string;
    now: Date;
    staleBefore: Date;
    limit?: number;
  }): Promise<Array<{
    id: string;
    organizationId: string;
    targetId: string;
    attemptId: string;
  }>>;
  deliverReadyOutbox(input: { claimToken: string; ids: string[] }): Promise<number>;
  // ---------------------------------------------------------------------------
  // JOB-006 — cancellation + reaper/reconciliation surface. These are SERVER
  // authority (operator/system), not worker-fenced: they lock the authoritative
  // job/attempt/lease rows directly and PERMANENTLY revoke the fence. They never
  // gate on `guardActiveFence` (the reaper acts precisely when a fence is stale),
  // so they are classified UNGUARDED in the fence-surface contract.
  //
  // The cancellation transaction marks the requested state and queues a
  // monotonically-sequenced E1 cancel command bound to the current lease fence
  // (idempotent: one cancel command per lease).
  requestCancellation(input: RequestCancellationInput): Promise<CancellationOutcome>;
  /**
   * Un-ACKed control commands for a lease, in monotonic `command_seq` order — the
   * "return pending controls until ACK" read.
   *
   * ★★★ E3-F035, CLOSED BY JOB-015. This docstring used to assert that "the poll/renew
   * path surfaces" this read. It did not: the renew mutator ran its own inline query
   * with a narrower filter (`command_kind IN ('cancel','graceful_stop')`), collapsed it
   * to `cancelRequested: Boolean(...)`, and hardcoded `extensions: []` — so this method
   * had ZERO production callers and its only non-definition reference was its NAME, as
   * a string, in a contract test's inventory list. A false claim of enforcement written
   * into the docstring of the method that would implement it.
   *
   * The claim is now TRUE, and it was made true by giving the method a caller rather
   * than by editing the prose: `renewLease` sources both the `cancelRequested` boolean
   * AND the `dev.aoa.job/control-v1` response extension from this one read. The poll
   * path still does not surface it, and deliberately so — poll reaches IDLE workers
   * looking for work, while a control command is addressed to a worker already holding
   * the lease.
   */
  listPendingControlCommands(input: {
    organizationId: string;
    leaseId: string;
  }): Promise<QueuedControlCommand[]>;
  /** Allocate attempt N+1 for a reaped attempt under the job lock, guarded so two
   * concurrent creators produce EXACTLY one N+1 attempt + one attempt-ready row
   * (the loser observes it). Creates the uniquely-constrained attempt + its outbox
   * row with an immutable backoff, or observes an already-created successor. */
  allocateRetryAttempt(input: RetryAllocationInput): Promise<RetryAllocationResult>;
  /** The reaper: revoke expired leases' fences and converge each to a new attempt,
   * a terminal result, or a dead-letter. Bounded batch; idempotent per lease. */
  reapExpiredLeases(input: ReapExpiredLeasesInput): Promise<ReapExpiredLeasesResult>;
  /**
   * DAT-006 — record a device-authenticated ORPHAN quarantine row. UNGUARDED by
   * design: an orphan is precisely a DEAD-FENCE output, so calling `guardActiveFence`
   * (or `resolveWorkerFenceContext`) would throw `stale_fence` and defeat the purpose —
   * same species as the reaper methods above, which "act when the fence is stale".
   * Authorization is DEVICE-ONLY: an in-tx recheck of `targetId` + `deviceGeneration`
   * against the CURRENT execution-target authority (a bumped/disabled/absent target →
   * `OrphanQuarantineRejection('target_revoked')`), mirroring `guardActiveFence`'s
   * generation cutoff WITHOUT the lease/fence step. It NEVER raises `stale_fence`.
   *
   * The row carries `status='quarantined'` (excluded from the committed partial-unique,
   * so it STRUCTURALLY cannot collide-update a committed attempt) + the frozen
   * `quarantine/` object key + retained sha256/size/sensitivity/kind + the observed
   * (non-authoritative) lease/fence provenance + the frozen `QUARANTINE_REASONS` reason.
   * Idempotent on the quarantined partial-unique natural key
   * (org, job, attempt, identifier): a replayed finalize is a DO-NOTHING that returns
   * the existing quarantined row (`alreadyQuarantined:true`). `observedLeaseId` /
   * `observedFenceToken` are recorded, NEVER used for authorization.
   */
  recordOrphanQuarantine(input: OrphanQuarantineInput): Promise<OrphanQuarantineResult>;
  // ---------------------------------------------------------------------------
  // JOB-011 — SERVER-authored governance projections (approvals / runtime
  // decisions / completion policy). These gate on `guardActiveFence` FIRST (a
  // stale or old-generation fence throws before any effect), then write ONLY the
  // projection receipt / control-command row — never the aggregate (the existing
  // product/runtime authority owns that, driven by the server-side bridge). The
  // WORKER cannot reach these: they are invoked from the control-plane bridge, not
  // from any worker route, and the E1 control audience stays `control_channel`.
  /** Write ONE governance receipt linking an EXISTING aggregate to this attempt,
   * guarded by the active fence. Idempotent on the (org, company, kind, identity)
   * unique — a replay for the same identity is a DO-NOTHING no-op. */
  recordGovernedProjection(
    input: ActiveFenceRequest & { projection: GovernedProjectionInput },
  ): Promise<GovernedProjectionRecordResult>;
  /** Flip a pending governance receipt to `applied` (idempotent double-resolve safe),
   * guarded by the active fence. */
  markGovernedProjectionApplied(
    input: ActiveFenceRequest & {
      projectionKind: GovernedProjectionKind;
      sourceIdentity: string;
    },
  ): Promise<{ applied: boolean }>;
  /** Queue ONE server-authored E1 governance result control on the active fence.
   * Reuses the JOB-006 monotonic-sequence + (org, lease, command id) idempotency;
   * NEVER drives a status transition (that is the aggregate authority's job). */
  queueGovernedControlCommand(
    input: ActiveFenceRequest & { control: GovernedControlCommandInput },
  ): Promise<GovernedControlQueueResult>;
  /** Acquire the FOR UPDATE lock on the active fence's lease+attempt (via the shared
   * `guardActiveFence`) and validate the fence, WITHOUT writing anything. A guard-only
   * lock: it lets a caller serialize two concurrent same-fence critical sections whose
   * aggregate authority has no native create-dedup (the product-approval bridge uses it
   * to close a create TOCTOU before its receipt fast-path). Throws JobFenceError on a
   * stale/old-generation/terminal fence, exactly like every governed mutator. */
  lockActiveFence(input: ActiveFenceRequest): Promise<{ lease: Lease; attempt: JobAttempt }>;
  /**
   * DEP-011 reaper Slice B (B1) — READ-ONLY per-lease liveness classification for the
   * adapter-manager's orphan reaper PULL. Given a batch of leaseIds, return a
   * {@link LeaseTruthVerdict} per id from `leases ⋈ jobAttempts ⋈ executionTargets`,
   * decided on DURABLE columns only. UNGUARDED by design — like the reaper and
   * quarantine methods it acts precisely WHEN the fence is gone, so a `guardActiveFence`
   * here would refuse every real call. Its safety comes from classifying dead ONLY on
   * monotonic status/generation columns (a strict subset of the authority's death
   * definition), never a renewable deadline. Effect-free; MUST run under
   * `runInTenantReadOnly` per organization (org ids come from the request, never a
   * SELECT DISTINCT — the boundary forbids org enumeration). Every requested id gets a
   * verdict — a leaseId with no row in this tenant is `absent`. Reads only
   * identifiers/enums: the projection NEVER selects `leases.fence` (a live bearer token).
   */
  classifyLeaseTruth(leaseIds: readonly string[]): Promise<Map<string, LeaseTruthVerdict>>;
}

/** JOB-004 terminal attempt statuses a governed completion may drive an attempt to. */
export type TerminalCompletionStatus = "succeeded" | "failed" | "cancelled" | "expired";

/**
 * SVC-003 — the service-instance statuses a WORKER HEALTH OBSERVATION may assert.
 *
 * ★ THIS LIST CLOSES E9-F001, AND BOTH HALVES OF THAT FINDING'S RESOLUTION ARE HERE.
 * It previously read `"healthy" | "stopped" | "lost" | "interrupted"`. `interrupted` was
 * never a member of the frozen `SERVICE_INSTANCE_STATUSES` and migration `0264` narrowed
 * `service_instances_status_check` to the frozen nine, so `recordServiceHealth({
 * healthStatus: "interrupted" })` typechecked and failed at runtime with a `23514`. It is
 * deleted here. The second half — the missing subset assertion against the frozen
 * authority — is the PURE suite `server/src/__tests__/service-health-projection.test.ts`
 * — specifically its describe block, whose name is kept UNWRAPPED here so it greps:
 * "SVC-003 — E9-F001: the health-status domain is reconciled with the frozen authority".
 * It imports BOTH this constant and `SERVICE_INSTANCE_STATUSES` and asserts the subset in
 * both directions. It needs no database: the drift is decidable from the two lists, so
 * the reconciliation is a pure test, not an integration one. `packages/db` cannot import
 * `worker-protocol` (see the schema headers), which is exactly why the reconciliation has
 * to be a server-side test and why the drift happened at all.
 *
 * ★ IT IS FIVE OF THE FROZEN NINE, NOT ALL NINE, AND THE FOUR OMISSIONS ARE THE POINT.
 * `SVC-001-design.md` §3.2 CORRECTION 6a reserved any WIDENING of this governed mutator's
 * input domain for SVC-003; this is that widening, and it is bounded by what an observation
 * can actually witness:
 *   * `pending`  — written by the reconciler's INSERT. A worker cannot observe a row into
 *                  existence, and admitting it would let a worker rewind its own instance.
 *   * `leased`   — the control plane's fact, projected from `attempt_started` (which is the
 *                  worker asserting it holds the attempt), never from a service event.
 *   * `stopping` — a stop REQUEST, not an observation. `service_graceful_stop_observed`
 *                  carries only `{ref, deadline}` and SVC-008b's emitter docstring says in
 *                  terms that it "claims nothing about the process". SVC-005 owns the
 *                  request side.
 *   * `failed`   — no worker event means it. The supervisor emits exactly one of
 *                  `service_instance_stopped` / `_lost` and then the attempt `terminal`;
 *                  attempt failure is the attempt's own projection, not the instance's.
 */
export const SERVICE_HEALTH_ASSERTABLE_STATUSES = [
  "starting",
  "healthy",
  "unhealthy",
  "stopped",
  "lost",
] as const;
export type ServiceHealthStatus = (typeof SERVICE_HEALTH_ASSERTABLE_STATUSES)[number];

/** The result of a governed mutator whose durable storage is not yet built
 * (JOB-005/006/011). It proves ONLY that the active-fence guard admitted the
 * caller; no governed row is written or read. */
export interface GuardedFenceResult {
  leaseId: string;
  attemptId: string;
  guarded: true;
}

/** DAT-003 — the disposition of a fenced `recordPatchApplyState`. `applyStatus` is
 * the control-plane outcome; `resolvedBaseManifestHash` is the job's accepted base
 * the patch was revalidated against (null when the job has no committed base yet);
 * `resultManifestHash` is the base the accepted chain advances to on `applied`;
 * `alreadyApplied` marks an idempotent no-op re-apply. */
export interface PatchApplyStateResult {
  applyStatus: "applied" | "conflict_quarantined";
  resolvedBaseManifestHash: string | null;
  resultManifestHash: string;
  alreadyApplied: boolean;
}

/** DAT-004 — the AUTHORIZED non-secret resolution the guarded mutator returns to the
 * server broker dispatch. It carries the handle's non-secret binding + the LOCKED
 * lease's company (the broker dispatch scope) + the post-increment audit count.
 * There is NO value field — a secret value is NEVER returned by the control plane;
 * the server resolves it behind the fence via the legacy brokers (invariants #1/#3/#4). */
export interface AuthorizedSecretResolution {
  handleId: string;
  refKind: SecretRefKind;
  refId: string;
  /** DAT-008 — the pinned version selector for `refId`; null = latest. A NON-SECRET
   * selector, carried so the broker resolves the version the handle was minted for. */
  refVersion: string | null;
  materialization: "proxy" | "env" | "file";
  /** DAT-008 — the materialization TARGET (an env-var NAME for `env`), so a resolve
   * response is self-describing and a consumer never has to correlate it back to the
   * envelope to learn where the value belongs. A name, never a value. */
  materializationTarget: string | null;
  usePolicy: "fence_proxy" | "remote_server_fenced" | "sandbox_local_only";
  destination: string | null;
  ownerPrincipalKind: string | null;
  ownerPrincipalId: string | null;
  boundTargetGeneration: number | null;
  /** The LOCKED lease's company — the scope the broker dispatch resolves the value in. */
  companyId: string;
  /** Post-increment resolve audit count (control-plane metadata only). */
  resolveCount: number;
}

// ---------------------------------------------------------------------------
// JOB-006 — cancellation, control commands, and reaper/retry types.

/** The control-command kinds JOB-006/JOB-011 queue (a subset of the frozen E1
 * CONTROL_COMMAND_KINDS). JOB-006 issues `cancel`/`drain`/`graceful_stop` from the
 * reaper/cancellation; JOB-011 queues the SERVER-authored `product_approval_result`
 * / `runtime_decision_result` when the existing product/runtime authority resolves. */
export type JobControlCommandKind =
  | "cancel"
  | "drain"
  | "graceful_stop"
  | "product_approval_result"
  | "runtime_decision_result";

/** JOB-011 — the SERVER-authored governance projection kinds. A `product_approval`
 * links an `approvals` row, a `runtime_decision` links an `agent_runtime_decisions`
 * row, and a `completion_policy` links the issue completion-policy snapshot. Distinct
 * from the JOB-005 worker projection kinds (attempt_started/attempt_terminal). */
export type GovernedProjectionKind =
  | "product_approval"
  | "runtime_decision"
  | "completion_policy"
  // JOB-012 — links a `cost_events` row (the authoritative, server-priced charge for
  // one accepted worker usage event) to the distributed attempt. Keyed for idempotency
  // by (projectionKind, sourceIdentity=`cost:{company}:{eventId}`); written `applied` in
  // the SAME tenant transaction as the charge.
  | "authoritative_cost"
  // JOB-013 — links an `activity_log` row (the transactional audit for one accepted
  // state/control/accounting mutation) to the distributed attempt; written `applied`
  // in the SAME tenant tx as the activity insert. sourceIdentity=`activity:{company}:{eventId}`.
  | "activity_audit"
  // JOB-014 — links a `task_outputs` row (the EXISTING task-output projection for one
  // accepted artifact/result event) to the distributed attempt; written `applied` in the
  // SAME tenant tx as the upsert. sourceIdentity=`output:{company}:{acceptedEventId}`.
  | "output_projection"
  // JOB-014 — the terminal-winner-once guard. Links the run-summary `issue_comments` row
  // when a summary is posted (aggregateKind `issue_comments`), else the attempt itself
  // (aggregateKind `job_attempts`, targetAggregateId=attemptId) for a null-issue/opt-out
  // winner. It is the REPLAY guard consulted BEFORE completeAttempt (which makes the
  // attempt terminal, so a legitimate winner-retry can no longer pass the fence).
  // sourceIdentity=`task_terminal:{company}:{terminalEventId}`.
  | "task_terminal";

/** ONE server-authored governance projection linking an EXISTING product/runtime
 * aggregate to a distributed attempt. Keyed for idempotency by (projectionKind,
 * sourceIdentity); `status` is `pending` until the authority resolves (then
 * `markGovernedProjectionApplied` flips it), or `applied` directly for a
 * synchronously-resolved decision. `aggregateKind` names the linked aggregate table. */
export interface GovernedProjectionInput {
  projectionKind: GovernedProjectionKind;
  aggregateKind: string;
  sourceIdentity: string;
  sourceDigest: string;
  targetAggregateId: string;
  status: "pending" | "applied";
}

/** The E1 result a JOB-011 governance control carries. The body is validated with
 * the frozen `controlCommandV1Schema` BEFORE insert (fail-closed) by the caller. */
export interface GovernedControlCommandInput {
  commandId: string;
  commandKind: "product_approval_result" | "runtime_decision_result";
  /** The already-validated, reconstructable E1 control command body. */
  commandBody: Record<string, unknown>;
  now: Date;
}

export type GovernedProjectionRecordResult = { receiptId: string | null; applied: boolean };
export type GovernedControlQueueResult = { command: QueuedControlCommand | null; queued: boolean };

/** The closed worker-ACK statuses (frozen E1 CONTROL_ACK_STATUSES). */
export type ControlCommandAckStatus = "accepted" | "completed" | "rejected" | "stale";

/** A durable control command queued for a fenced run. `command` is the
 * reconstructable frozen wire body; the columns are the authoritative facts. */
export interface QueuedControlCommand {
  id: string;
  organizationId: string;
  companyId: string;
  jobId: string;
  attemptId: string;
  attemptNumber: number;
  leaseId: string;
  commandId: string;
  commandSeq: number;
  commandKind: JobControlCommandKind;
  fenceToken: string;
  reason: string | null;
  graceful: boolean | null;
  command: Record<string, unknown>;
  ackStatus: ControlCommandAckStatus | null;
}

/** The worker's echoed ACK for a control command, applied by `ackControlCommand`.
 *
 * ★★★ JOB-015 (E3-F035's sibling). `commandSeq` is REQUIRED and it is CHECKED. The
 * frozen `controlCommandAckV1Schema` has always carried `commandSeq`, and its own
 * docstring says the worker "echoes the command ID + sequence" — but the mutator
 * matched on `(organizationId, leaseId, commandId)` only and the echoed sequence was
 * accepted, returned in the response, and otherwise discarded. A frozen validation
 * field the server never checked is the same failure class as a docstring naming a
 * consumer that does not exist. It is required rather than optional so a caller cannot
 * quietly opt out of the check; a mismatch leaves the command PENDING (redelivered on
 * the next renewal) rather than suppressing redelivery on a sequence nobody verified. */
export interface ControlCommandAckInput {
  commandId: string;
  commandSeq: number;
  status: ControlCommandAckStatus;
  observedAt: Date;
  detail: string | null;
}

export interface ControlCommandAckOutcome {
  applied: boolean;
  status: ControlCommandAckStatus;
}

export interface RequestCancellationInput {
  organizationId: string;
  companyId: string;
  jobId: string;
  reason: string;
  graceful: boolean;
  /** Caller-supplied command id — a retried cancellation with the SAME id replays
   * the queued command (idempotent), never a second command. */
  commandId: string;
  now: Date;
}

export type CancellationStatus =
  | "queued"
  | "already_requested"
  | "cancelled"
  | "no_active_lease"
  | "job_terminal"
  | "not_found";

export interface CancellationOutcome {
  status: CancellationStatus;
  command: QueuedControlCommand | null;
}

export interface RetryAllocationInput {
  organizationId: string;
  companyId: string;
  jobId: string;
  /** The reaped attempt this retry succeeds. Retry allocation is a no-op unless
   * this is still the LATEST attempt (max == reapedAttemptNumber). */
  reapedAttemptId: string;
  reapedAttemptNumber: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  now: Date;
  /**
   * DEP-009 capacity-claim TRANSFER. When the reaped attempt HELD an Organization
   * capacity slot, the successor attempt N+1 must inherit `capacity_claim_state='held'`
   * so `resolveOrgCapacityUsage` (which counts only 'held' attempts) preserves org
   * occupancy across the reap→retry boundary — otherwise N+1 is minted 'unclaimed'
   * (schema default) and, because offer-time capacity enforcement is DEFERRED, leases
   * and runs UNCOUNTED, exceeding the org cap. Race-safe: the reaper releases attempt N
   * and re-claims on N+1 in ONE txn under `pg_advisory_xact_lock('aoa:org-capacity')`,
   * so a concurrent admit never observes the gap. Omitted/false ⇒ N+1 stays 'unclaimed'
   * (flag-off submits and the public allocateRetryAttempt path preserve prior behavior).
   */
  inheritCapacityHeld?: boolean;
}

export type RetryAllocationStatus = "created" | "observed" | "not_latest" | "job_missing";

export interface RetryAllocationResult {
  status: RetryAllocationStatus;
  attemptNumber: number | null;
  attemptId: string | null;
  backoffUntil: Date | null;
}

export interface ReapExpiredLeasesInput {
  organizationId: string;
  now: Date;
  limit: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

/**
 * MIG-002 convergence: one attempt the reaper drove to a TERMINAL job outcome.
 *
 * `onAttemptTerminal` has exactly one producer (the worker's accepted event batch), so a
 * reaped attempt leaves its heartbeat run pinned at `running`. The sweeper projects a run
 * terminal for each of these through the existing `canary-terminal-projection` handler — one
 * projection, two triggers, so the ownership predicate is never duplicated.
 *
 * Listed ONLY when the JOB reached a terminal state. A reaped lease whose attempt expired but
 * whose job was RETRIED is deliberately absent: that job is about to run again, and projecting
 * a run terminal for it would leave two executors.
 */
export interface ReapedTerminalAttempt {
  readonly companyId: string;
  readonly jobId: string;
  readonly attemptId: string;
  /** Frozen `TerminalEventStatus` vocabulary: succeeded | failed | cancelled | expired. */
  readonly terminalStatus: "succeeded" | "failed" | "cancelled" | "expired";
}

export interface ReapExpiredLeasesResult {
  scanned: number;
  revoked: number;
  retried: number;
  deadLettered: number;
  cancelled: number;
  finalized: number;
  /** ADDITIVE (MIG-002). Existing consumers read only the counts and are unchanged. */
  terminalized: ReapedTerminalAttempt[];
}

/** DAT-006 — the device-authenticated orphan quarantine record input. All identity is
 * device-scoped (targetId + deviceGeneration re-derived from the current authority);
 * `observedLeaseId`/`observedFenceToken` are recorded as observed provenance only. */
export interface OrphanQuarantineInput {
  organizationId: string;
  targetId: string;
  deviceGeneration: number;
  jobId: string;
  attemptNumber: number;
  identifier: string;
  quarantineObjectKey: string;
  sha256: string;
  sizeBytes: number;
  sensitivity: string;
  kind: string;
  /** A member of the frozen `QUARANTINE_REASONS`. */
  reason: string;
  observedLeaseId: string;
  observedFenceToken: string;
}

/** DAT-006 — the outcome of recording an orphan quarantine row. `alreadyQuarantined`
 * marks an idempotent DO-NOTHING replay (the existing row is returned unchanged). */
export interface OrphanQuarantineResult {
  artifact: JobArtifact;
  alreadyQuarantined: boolean;
}

/** Exponential retry backoff (ms) for the Nth reaped attempt, bounded by `maxMs`. */
export function computeRetryBackoffMs(
  reapedAttemptNumber: number,
  baseMs: number,
  maxMs: number,
): number {
  const base = Math.max(0, Math.floor(baseMs));
  const ceiling = Math.max(base, Math.floor(maxMs));
  if (base === 0) return 0;
  const exponent = Math.max(0, reapedAttemptNumber - 1);
  // Cap the shift so 2 ** exponent never overflows before the min() clamp.
  const factor = exponent >= 30 ? 2 ** 30 : 2 ** exponent;
  return Math.min(ceiling, base * factor);
}

// ---------------------------------------------------------------------------
// JOB-005 — fenced event ingest + projection idempotency (behind acceptEvent /
// applyProjectionReceipt, which STILL gate on the active fence first).

/** ONE server-validated worker event, ready for durable append. `recomputedDigest`
 * is the server's SHA-256 of the RFC 8785 canonical bytes (E1) — the repo never
 * recomputes it. `terminalStatus` is set only for a `terminal` event. */
export interface AcceptEventInput {
  eventId: string;
  sequence: number;
  eventType: string;
  fenceToken: string;
  suppliedDigest: string;
  recomputedDigest: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  terminalStatus: TerminalCompletionStatus | null;
  /**
   * SVC-003 — the DECIDED service-instance projection this event drives, or `null` when
   * it drives none. Computed SERVER-SIDE (`server/src/services/job-events.ts`), never here.
   *
   * ★ WHY IT IS DECIDED BY THE CALLER. The legality of a status move is the FROZEN
   * `SERVICE_INSTANCE_TRANSITIONS` table in `packages/worker-protocol`, and `packages/db`
   * deliberately does not depend on that package (see the `services` / `service_instances`
   * schema headers — it is why the CHECK and the partial-index predicate are hand-written
   * copies). Re-deriving the table here would make a FIFTH copy of a frozen list. So the
   * server, which owns the frozen helper, hands down `allowedFromStatuses` and this
   * repository applies it as a predicate. Same shape as `commitArtifactVersion`'s
   * pre-evaluated `prefixValid`/`tenantValid`.
   */
  serviceProjection: ServiceInstanceProjectionInput | null;
}

/**
 * SVC-003 — ONE decided service-instance status projection.
 *
 * `serviceInstanceId` / `serviceId` / `generation` are the values the WORKER put in the
 * event payload. They are claims, not authority: the projection resolves the instance from
 * `service_instances.job_id`/`.attempt_id` (written by SVC-002's reconciler inside its own
 * transaction) and then REQUIRES all three to match. See {@link ServiceProjectionOutcome}.
 */
export interface ServiceInstanceProjectionInput {
  /**
   * What the worker's event payload SAYS this event is about, or `null` when the event
   * makes no service claim at all.
   *
   * ★ `null` IS NOT A BYPASS, AND THE ONE EVENT THAT USES IT IS WHY. Only `attempt_started`
   * maps to a null claim: its frozen payload is `{sandboxId}` and carries no service ref, so
   * there is no assertion to check. The target row is still fixed by (job, attempt)
   * attribution, and the only status a null-claim projection may drive is `leased`, whose
   * sole legal predecessor in the frozen table is `pending`. A worker therefore cannot use
   * it to escape a terminal status, to skip a generation, or to touch a row it was not
   * already leased. What it records is the control plane's OWN fact, read off its own
   * guard: `guardActiveFence` has just proven an ACTIVE lease for this attempt, which is
   * exactly what `leased` means.
   */
  claim: { serviceInstanceId: string; serviceId: string; generation: number } | null;
  /** The status this observation asserts. */
  toStatus: ServiceHealthStatus | "leased";
  /**
   * Every status from which `toStatus` is a LEGAL move, derived by the caller from the
   * frozen `SERVICE_INSTANCE_TRANSITIONS`. An empty array is a caller bug and is treated as
   * "no legal predecessor", which refuses rather than admits.
   */
  allowedFromStatuses: readonly string[];
  /**
   * SVC-003 — what to report when the instance is ALREADY in a frozen terminal status.
   *
   * `"refuse"` (the default, and what EVERY service event uses) reports `illegal_transition`:
   * a late `service_health healthy` on an instance that reached `lost` is the split-brain
   * attempt and must be visible as a refusal.
   *
   * `"noop"` is set by the attempt-terminal backstop ALONE. On the normal path the instance is
   * already `stopped`/`lost` by the time the attempt terminal arrives, and calling that a
   * refusal would put one on the happy path of every service run — drowning the real ones in
   * the operator log. ★ It changes only the REPORTED outcome: no write happens under either
   * value, so it can never admit a transition `"refuse"` would have blocked.
   */
  whenAlreadyTerminal?: "refuse" | "noop";
}

/**
 * SVC-003 — why a service projection did or did not move the row. Every arm is DISTINCT
 * on purpose: a single boolean would collapse "there is no such instance" (an unreadable
 * observation) into "the transition was illegal" (a readable observation refused), and
 * SVC-008b's lesson is that a definite answer for an unreadable observation is a fail-open.
 */
export type ServiceProjectionOutcome =
  /** The row moved. */
  | { outcome: "applied"; fromStatus: string; toStatus: string }
  /** The row already carried `toStatus`. Idempotent replay; no write. */
  | { outcome: "noop_same_status"; fromStatus: string }
  /** The row is already in a frozen terminal status and the caller asked for `"noop"` rather
   *  than a refusal — the attempt-terminal backstop's normal path. No write. */
  | { outcome: "noop_already_terminal"; fromStatus: string }
  /** ★ UNKNOWN, NOT ABSENT. No `service_instances` row is attributed to this (job, attempt),
   *  so nothing here can say what this observation is about. Nothing is written. */
  | { outcome: "unattributed" }
  /** The payload named a different instance/service than the one attributed to this
   *  attempt. E9-F003's mislabel made load-bearing: the worker's claim is refused. */
  | { outcome: "identity_mismatch"; attributedInstanceId: string }
  /** ★ THE FENCE SVC-002 HANDED OVER. The payload's generation is not the instance's. */
  | { outcome: "stale_generation"; instanceGeneration: number }
  /** The frozen lifecycle forbids this move — including every move OUT of a terminal
   *  status, which is the split-brain refusal (see `applyServiceProjectionForFence`). */
  | { outcome: "illegal_transition"; fromStatus: string; toStatus: string };

/** A contiguous, in-order batch (validated + digest-checked by the service). */
export interface AcceptEventBatchInput {
  events: readonly AcceptEventInput[];
}

/** The cumulative-ACK-shaped outcome of a fenced batch append. `stale_fence` and
 * `terminal` are NOT produced here — they surface as a thrown `JobFenceError` from
 * the guard, which the ingest service maps into the cumulative ACK. */
export interface EventIngestOutcome {
  status: "accepted" | "gap" | "hash_mismatch";
  acceptedThroughSeq: number;
  rejectedEventId?: string;
}

/** The job/attempt transition an accepted state-changing event drives. */
export type ProjectionTransition =
  | { kind: "attempt_started" }
  | { kind: "attempt_terminal"; terminalStatus: TerminalCompletionStatus };

/** ONE projection driven by ONE accepted event, keyed for idempotency by
 * (projectionKind, sourceIdentity) with the driving event digest pinned. */
export interface ProjectionInput {
  projectionKind: "attempt_started" | "attempt_terminal";
  sourceIdentity: string;
  sourceDigest: string;
  targetAggregateId: string;
  transition: ProjectionTransition;
}

export interface LeaseWorkerAuthority {
  worker: {
    id: string;
    scope: string;
    organizationId: string | null;
    ownerUserId: string | null;
    executionTargetId: string;
    targetAuthorityKey: string;
    devicePublicKey: string | null;
    deviceThumbprint: string | null;
    deviceGeneration: number;
    profileHash: string | null;
    profileSnapshot: Record<string, unknown> | null;
    status: string;
    revokedAt: Date | null;
    lastSeenAt: Date | null;
  };
  target: PlacementCandidateSnapshot["target"];
  ownerMembershipActive: boolean;
}

export interface LeaseCandidate {
  job: Job;
  attempt: JobAttempt;
  certificateWorkerId: string;
  certificateTargetAuthorityKey: string;
  certificateEligibilityVersion: number;
}

export interface StaticLeaseRejectionInput {
  candidate: LeaseCandidate;
  reasonCode: "static_requirements_mismatch";
  staticContextHash: string;
}

export interface PlacementCandidateSnapshot {
  target: {
    id: string;
    slug: string;
    kind: string;
    trustClass: string;
    status: string;
    organizationId: string | null;
    ownerUserId: string | null;
    scope: string;
    targetAuthorityKey: string;
    deviceGeneration: number;
    registeredProfile: Record<string, unknown> | null;
    registeredProfileHash: string | null;
    providerConstraintProfile: Record<string, unknown> | null;
    capabilities: Record<string, unknown>;
    lastSeenAt: Date | null;
  };
  worker: {
    id: string;
    scope: string;
    organizationId: string | null;
    ownerUserId: string | null;
    executionTargetId: string;
    targetAuthorityKey: string;
    deviceGeneration: number;
    profileHash: string | null;
    profileSnapshot: Record<string, unknown> | null;
    lastSeenAt: Date | null;
    status: string;
  };
  ownerMembershipActive: boolean;
}

export interface PlacementDecisionWrite {
  organizationId: string;
  companyId: string;
  jobId: string;
  attemptId: string;
  placementDisposition: string;
  placementOwner: string | null;
  placementTargetId: string | null;
  placementTargetClass: string | null;
  placementTargetScope: string | null;
  placementTargetGeneration: number | null;
  placementProfileHash: string | null;
  placementProviderConstraintHash: string | null;
  placementFallbackDisposition: string;
  placementReasonCode: string;
  placementMode: string;
  placementLeaseEligible: boolean;
  placementOwnerPrincipalId: string | null;
  placementInputDigest: string;
  placementPolicyDigest: string;
  placementDecidedAt: Date;
}

const placementTargetColumns = {
  id: executionTargets.id,
  slug: executionTargets.slug,
  kind: executionTargets.kind,
  trustClass: executionTargets.trustClass,
  status: executionTargets.status,
  organizationId: executionTargets.organizationId,
  ownerUserId: executionTargets.ownerUserId,
  scope: executionTargets.scope,
  targetAuthorityKey: executionTargets.targetAuthorityKey,
  deviceGeneration: executionTargets.deviceGeneration,
  registeredProfile: executionTargets.registeredProfile,
  registeredProfileHash: executionTargets.registeredProfileHash,
  providerConstraintProfile: executionTargets.providerConstraintProfile,
  capabilities: executionTargets.capabilities,
  lastSeenAt: executionTargets.lastSeenAt,
};

const placementWorkerColumns = {
  id: workers.id,
  scope: workers.scope,
  organizationId: workers.organizationId,
  ownerUserId: workers.ownerUserId,
  executionTargetId: workers.executionTargetId,
  targetAuthorityKey: workers.targetAuthorityKey,
  deviceGeneration: workers.deviceGeneration,
  profileHash: workers.profileHash,
  profileSnapshot: workers.profileSnapshot,
  lastSeenAt: workers.lastSeenAt,
  status: workers.status,
};

export function createJobControlRepository(tx: Db): JobControlRepository {
  function requesterKindForOrganizationRole(role: string): SourceRequesterKind | null {
    if (role === "owner") return "founder";
    if (role === "admin") return "team_lead";
    if (role === "member") return "team_member";
    return null;
  }

  // JOB-004 — THE common active-fence guard every governed mutator gates on.
  //
  // Locks the lease + its attempt by the COMPLETE presented identity + fence and
  // evaluates expiry against a FRESH database `clock_timestamp()` in the SAME locked
  // read (never transaction-start or JavaScript time). A superseded fence, re-homed
  // worker/target, or bumped generation matches no row (→ stale_fence); a terminal
  // attempt is `attempt_terminal`; a non-active or freshly-expired lease is
  // `stale_fence`. The shared pure predicate `isActiveFence` is the final authority
  // on admission; `classifyFence` supplies the closed refusal code.
  async function guardActiveFence(
    request: ActiveFenceRequest,
  ): Promise<{ lease: Lease; attempt: JobAttempt }> {
    // JOB-007 — locked current-generation recheck. The lease+attempt are locked FOR
    // UPDATE; the target is LEFT-joined (read only, NEVER locked here — the revocation
    // authority locks the target, so locking it here would invert the target->lease
    // order and risk a deadlock). A revocation cutoff bumps
    // execution_targets.device_generation, so a lease whose stored target_generation no
    // longer equals the target's LIVE generation (or whose target is disabled/gone) is
    // refused `target_revoked` — the instant the cutoff commits, BEFORE the per-Org
    // fanout marks the lease `revoked`. This is why a crash after the cutoff but before
    // fanout still denies every old-generation governed effect: the recheck is the gate,
    // the fanout is only convergence.
    const [row] = await tx
      .select({
        lease: leases,
        attempt: jobAttempts,
        expiresFresh: sql<boolean>`(${leases.expiresAt} > clock_timestamp())`,
        targetCurrentGeneration: executionTargets.deviceGeneration,
        targetStatus: executionTargets.status,
      })
      .from(leases)
      .innerJoin(jobAttempts, and(
        eq(jobAttempts.organizationId, leases.organizationId),
        eq(jobAttempts.companyId, leases.companyId),
        eq(jobAttempts.jobId, leases.jobId),
        eq(jobAttempts.id, leases.attemptId),
      ))
      .leftJoin(executionTargets, and(
        eq(executionTargets.id, leases.targetId),
        eq(executionTargets.targetAuthorityKey, leases.targetAuthorityKey),
      ))
      .where(and(
        eq(leases.organizationId, request.organizationId),
        eq(leases.companyId, request.companyId),
        eq(leases.jobId, request.jobId),
        eq(leases.attemptId, request.attemptId),
        eq(leases.attemptNumber, request.attemptNumber),
        eq(leases.id, request.leaseId),
        eq(leases.workerId, request.workerId),
        eq(leases.targetId, request.targetId),
        eq(leases.targetAuthorityKey, request.targetAuthorityKey),
        eq(leases.targetGeneration, request.targetGeneration),
        eq(leases.profileHash, request.profileHash),
        eq(leases.providerConstraintHash, request.providerConstraintHash),
        eq(leases.fence, request.fence),
      ))
      .for("update", { of: [leases, jobAttempts] })
      .limit(1);
    if (!row) throw new JobFenceError("stale_fence");
    // The generation cutoff is the dominant fact: a bumped/disabled/absent target
    // revokes the fence immediately, regardless of attempt status. `target_generation`
    // in the lease was matched above, so comparing the target's LIVE generation to the
    // lease's stored one is the cutoff test.
    if (
      row.targetCurrentGeneration === null ||
      row.targetCurrentGeneration !== request.targetGeneration ||
      row.targetStatus === "disabled"
    ) {
      throw new JobFenceError("target_revoked");
    }
    const snapshot = {
      leaseStatus: row.lease.status,
      attemptStatus: row.attempt.status,
      expiresFresh: row.expiresFresh === true,
    };
    const refusal = classifyFence(snapshot);
    if (refusal) throw new JobFenceError(refusal);
    // Defense in depth: the shared predicate must agree with the classification.
    if (!isActiveFence(snapshot)) throw new JobFenceError("stale_fence");
    return { lease: row.lease, attempt: row.attempt };
  }

  // JOB-005 — apply ONE accepted event's job/attempt projection idempotently.
  // The caller has ALREADY passed the active-fence guard (which holds the attempt
  // row lock), so the transitions here are the legal, single-winner moves:
  //   * attempt_started → attempt leased->running + job queued->running.
  //   * attempt_terminal → attempt (any non-terminal) -> the terminal status.
  // Every transition is CONDITIONAL on the current status, so a replay or an
  // in-batch attempt_started→terminal pair is a safe no-op. The projection receipt
  // (unique per (kind, source_identity)) records the applied projection; a replay
  // conflicts DO NOTHING (the ingest also rejects a changed digest upstream as
  // hash_mismatch, so a same-identity/different-digest receipt never reaches here).
  async function applyProjectionForFence(
    fence: ActiveFenceRequest,
    projection: ProjectionInput,
  ): Promise<void> {
    if (projection.transition.kind === "attempt_started") {
      await tx.update(jobAttempts).set({
        status: "running",
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(jobAttempts.organizationId, fence.organizationId),
        eq(jobAttempts.companyId, fence.companyId),
        eq(jobAttempts.jobId, fence.jobId),
        eq(jobAttempts.id, fence.attemptId),
        eq(jobAttempts.status, "leased"),
      ));
      await tx.update(jobs).set({
        status: "running",
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(jobs.organizationId, fence.organizationId),
        eq(jobs.companyId, fence.companyId),
        eq(jobs.id, fence.jobId),
        eq(jobs.status, "queued"),
      ));
    } else {
      await tx.update(jobAttempts).set({
        status: projection.transition.terminalStatus,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(jobAttempts.organizationId, fence.organizationId),
        eq(jobAttempts.companyId, fence.companyId),
        eq(jobAttempts.jobId, fence.jobId),
        eq(jobAttempts.id, fence.attemptId),
        notInArray(jobAttempts.status, [...TERMINAL_ATTEMPT_STATUSES]),
      ));
    }
    await tx.insert(jobProjectionReceipts).values({
      organizationId: fence.organizationId,
      companyId: fence.companyId,
      projectionKind: projection.projectionKind,
      sourceIdentity: projection.sourceIdentity,
      sourceDigest: projection.sourceDigest,
      jobId: fence.jobId,
      attemptId: fence.attemptId,
      sourceFence: fence.fence,
      status: "applied",
      targetAggregateId: projection.targetAggregateId,
      appliedAt: sql`clock_timestamp()`,
      createdAt: sql`clock_timestamp()`,
    }).onConflictDoNothing({
      target: [
        jobProjectionReceipts.organizationId,
        jobProjectionReceipts.companyId,
        jobProjectionReceipts.projectionKind,
        jobProjectionReceipts.sourceIdentity,
      ],
    });
  }

  // ── SVC-003 — the service-instance status projection ──────────────────────────────────
  //
  // ★★★ WHAT THIS IS. Before SVC-003, `service_instance_started` / `service_health` /
  // `service_instance_stopped` / `service_instance_lost` were ingested, digest-verified and
  // durably appended to `job_events` — and PROJECTED NO STATE CHANGE. `recordServiceHealth`
  // was the only writer of `service_instances.status` and it had no consumer, so SVC-002's
  // reconciler converged zero instances to one and then went quiescent forever: nothing
  // could ever drive an instance terminal, so nothing could ever be replaced. This function
  // is that consumer. It runs INSIDE `acceptEvent`, under the fence guard that already
  // admitted, in the SAME transaction as the durable append — so an event is never
  // acknowledged as accepted while its projection is lost, and a projection can never
  // outlive a refused append.
  //
  // ★★★ THE WORKER'S PAYLOAD IS A CLAIM, NEVER AN AUTHORITY, AND THIS IS THE WHOLE FENCE.
  // `serviceReconcileSourceSchema` carries no `serviceInstanceId` (adding it is a Protocol
  // Custodian STOP, SVC-002-design §10.2), so the lease envelope's `executionPrincipal`
  // names the SERVICE under the kind `service_instance` while the workload carries a
  // different instance id — E9-F003. A projection that trusted `payload.serviceInstanceId`
  // would promote that unauthorized value into a status write on any row in the tenant.
  // So the AUTHORITY is `service_instances.job_id`/`.attempt_id`, which SVC-002's reconciler
  // wrote inside its own transaction ("without this the instance row is UNATTRIBUTABLE and
  // SVC-003 has nothing to fence against" — service-reconciler.ts, step 6b). The payload's
  // three identity fields are then REQUIRED TO MATCH that row, and a mismatch refuses.
  //
  // ★★★ EVERY REFUSAL IS A DISTINCT OUTCOME, AND THE UNREADABLE CASE IS DRIVEN EXPLICITLY.
  // `unattributed` is NOT `illegal_transition` and neither is a silent `false`. When no row
  // is attributed to this (job, attempt) the observation is UNREADABLE — nothing here can
  // say what it is about — and the honest answer is to write nothing and say so, exactly as
  // SVC-002's `no_generation` stall does and for the same reason SVC-008b refuses to
  // synthesize `healthy` from a status read that could not answer.
  //
  // ★ WHAT IT DELIBERATELY DOES NOT TOUCH: `leases`. E9's acceptance for SVC-003 opens
  // "health events do not extend ownership without a successful lease renewal", and the
  // mechanism for that clause is that this function writes exactly one table. Ownership is
  // extended by `renewLease` and by nothing else. T5 pins it.
  async function applyServiceProjectionForFence(
    fence: ActiveFenceRequest,
    projection: ServiceInstanceProjectionInput,
    sourceIdentity: string,
    sourceDigest: string,
  ): Promise<ServiceProjectionOutcome> {
    // (1) AUTHORITY: the instance attributed to THIS attempt, locked for the rest of the
    // transaction. `FOR UPDATE` and not a bare read: two events for one instance inside one
    // batch are applied in order, and a concurrent reconciler pass that is about to read the
    // observed state waits rather than racing a half-applied projection.
    const [instance] = await tx.select({
      id: serviceInstances.id,
      serviceId: serviceInstances.serviceId,
      generation: serviceInstances.generation,
      status: serviceInstances.status,
    }).from(serviceInstances).where(and(
      eq(serviceInstances.organizationId, fence.organizationId),
      eq(serviceInstances.companyId, fence.companyId),
      eq(serviceInstances.jobId, fence.jobId),
      eq(serviceInstances.attemptId, fence.attemptId),
    )).for("update").limit(1);
    // ★ The unreadable case. A batch job's `attempt_started` lands here too (the caller
    // cannot know a job is a service job without this very read), and for it this arm is the
    // correct and only answer: there is no instance, so there is nothing to project.
    if (!instance) return { outcome: "unattributed" };

    // (2) IDENTITY: the worker's claim must name the row the control plane attributed.
    const claim = projection.claim;
    if (claim && (instance.id !== claim.serviceInstanceId || instance.serviceId !== claim.serviceId)) {
      return { outcome: "identity_mismatch", attributedInstanceId: instance.id };
    }

    // (3) ★ THE GENERATION FENCE — the piece SVC-002 scoped out in its own words
    // ("SVC-002 reads generation under a row lock and never bumps it; the fence is
    // SVC-003's"). A worker still running generation N whose service has rolled to N+1
    // may not write status onto the instance. Note WHICH generation is authoritative: the
    // INSTANCE's, not `services.generation` — the instance's generation is what it was
    // placed at, and comparing against the service would refuse every event the moment
    // SVC-005 bumps, including events from the instance that is legitimately being drained.
    if (claim && instance.generation !== claim.generation) {
      return { outcome: "stale_generation", instanceGeneration: instance.generation };
    }

    // (3b) ★★★ SVC-003b — THE LIVENESS STAMP, AND ITS POSITION IN THIS FUNCTION IS THE
    // DESIGN, not an implementation detail.
    //
    // WHY HERE, AFTER THE THREE FENCES. Attribution, identity and generation are what make an
    // event EVIDENCE ABOUT THIS ROW. An unattributed event says nothing about any instance; a
    // mismatched claim is an unauthorized assertion (E9-F003); a stale-generation event comes
    // from a worker the control plane has already rolled past. Stamping liveness from any of
    // those would let an event that is refused for every other purpose still hold an instance
    // alive past its deadline — the deadline's own fail-open.
    //
    // WHY BEFORE THE THREE NO-WRITE ARMS BELOW, which is the half that is easy to get wrong.
    // The steady state of a HEALTHY service is `service_health healthy` arriving every ~10 s
    // (SVC-008b's `SERVICE_HEALTH_TICK_MS_DEFAULT`) onto a row that is already `healthy` —
    // i.e. `noop_same_status`, forever. A stamp written only alongside a real status move
    // would therefore go stale on every WORKING service, and the deadline would terminalize
    // exactly the instances it exists to protect. `noop_already_terminal` and
    // `illegal_transition` also stamp: both are readable, authenticated evidence that this
    // worker is alive, whatever the control plane decides to do with what it said.
    //
    // ★ SEPARATE FROM `status`, NOT FOLDED INTO `writeServiceInstanceStatus`. That writer is
    // conditional on the observed status and returns whether a row MOVED; liveness must be
    // recorded on exactly the events that move nothing. Two writes to one row inside one
    // already-held `FOR UPDATE` lock, in a fixed order.
    await tx.update(serviceInstances).set({
      lastObservedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(serviceInstances.organizationId, fence.organizationId),
      eq(serviceInstances.id, instance.id),
    ));

    // (4) Idempotent replay of the SAME event: the row already carries the asserted status.
    // Distinguished from `applied` so a caller can tell a real move from a no-op, and
    // deliberately checked BEFORE legality — `healthy → healthy` is not an edge in the frozen
    // table (no status transitions to itself), so a repeated health tick would otherwise be
    // reported as an illegal transition, which is false and would drown the real signal.
    if (instance.status === projection.toStatus) {
      return { outcome: "noop_same_status", fromStatus: instance.status };
    }

    // (4b) The attempt-terminal backstop landing on an instance that is ALREADY terminal —
    // which is the NORMAL path, since the supervisor emits `_stopped`/`_lost` before the
    // attempt terminal whenever it got that far. Reporting `illegal_transition` here would put
    // a refusal on the happy path of every service run. ★ Reachable only when the CALLER asked
    // for it (`whenAlreadyTerminal: "noop"`), which only the attempt-terminal arm does; every
    // service event keeps the default `"refuse"`, so the split-brain refusal is untouched. No
    // write happens under either value, so this can never admit a move `"refuse"` would block.
    // ★ Reuses SVC-002's frozen list — the SAME `as const` the live-instance index predicate
    // and the observed-state count are derived from — rather than a fifth hand-written copy.
    if (projection.whenAlreadyTerminal === "noop"
      && (TERMINAL_SERVICE_INSTANCE_STATUSES as readonly string[]).includes(instance.status)) {
      return { outcome: "noop_already_terminal", fromStatus: instance.status };
    }

    // (5) ★★★ LEGALITY, AND THE SPLIT-BRAIN REFUSAL IT EXISTS FOR. `allowedFromStatuses` is
    // the frozen table's predecessor set for `toStatus`, computed by the server. The three
    // terminal statuses (`stopped`/`failed`/`lost`) have NO outgoing edges, so they appear
    // in no predecessor set and every move out of them is refused here.
    //
    // That is not tidiness — it is the DE-12 crossing. `service_instances_live_service_uq`
    // is unique on (organization_id, service_id) WHERE status NOT IN the three terminals. An
    // instance that reached `lost` has LEFT that index and SVC-002's reconciler has already
    // created its replacement. A late event from the old worker resurrecting it to `healthy`
    // would put TWO live rows under one partial-unique key: at best a 23505 that fails the
    // whole ingest transaction and makes the worker replay a batch forever, and — if the
    // predicate were ever widened — two live instances for one service, which is the split
    // brain itself. An empty `allowedFromStatuses` refuses, so a caller that computed
    // nothing gets a refusal rather than an unconditional write.
    if (!projection.allowedFromStatuses.includes(instance.status)) {
      return { outcome: "illegal_transition", fromStatus: instance.status, toStatus: projection.toStatus };
    }

    // (6) The write. Conditional on the exact status read under the lock, so even if the
    // lock were lost this cannot overwrite a status some other writer landed first.
    const moved = await writeServiceInstanceStatus({
      organizationId: fence.organizationId,
      serviceInstanceId: instance.id,
      status: projection.toStatus,
      expectedFromStatus: instance.status,
      // ★★★ SVC-005a — THE ONLY WITNESS IN THE TREE, AND IT IS NARROWER THAN "A WORKER EVENT".
      //
      // Attribution, identity and the generation fence above are what make this event evidence
      // about THIS row rather than an unauthorized assertion — but they establish the
      // AUTHORITY of the claim, not its CONTENT. `stopped` is the only terminal status the
      // frozen mapping reaches from an OBSERVATION that the process is gone
      // (`decideServiceProjection`: `service_instance_stopped -> stopped`, "the process was
      // OBSERVED gone"). `lost` is `service_instance_lost`, which the daemon emits when it
      // COULD NOT CONFIRM the stop — including when "a full stop ladder ended with the process
      // still observed `running`" — and `failed` is not reached by a service event at all.
      //
      // So the author is derived from the STATUS BEING WRITTEN, and everything that is not an
      // observed stop is `worker_unconfirmed`. Deriving it the other way — trusting the caller
      // because it is fenced — is the fail-open external review of PR #415 found (P1): it
      // would let the rollout place generation N+1 exactly when generation N's process is
      // KNOWN to have survived cancel and kill. Fail-closed by DEFAULT: a terminal status added
      // to the frozen list later is `worker_unconfirmed` until someone deliberately widens
      // this, which stalls a rollout rather than admitting one.
      author: projection.toStatus === "stopped" ? "worker_stopped" : "worker_unconfirmed",
    });
    if (!moved) return { outcome: "illegal_transition", fromStatus: instance.status, toStatus: projection.toStatus };

    // (7) The receipt, on the SAME (kind, sourceIdentity) uniqueness every other projection
    // uses. `aggregateKind` is what makes `target_aggregate_id` readable: the column is
    // shared with attempt projections, which leave the kind NULL because their target is
    // always the attempt they already name.
    await tx.insert(jobProjectionReceipts).values({
      organizationId: fence.organizationId,
      companyId: fence.companyId,
      projectionKind: "service_instance_status",
      sourceIdentity,
      sourceDigest,
      jobId: fence.jobId,
      attemptId: fence.attemptId,
      sourceFence: fence.fence,
      status: "applied",
      targetAggregateId: instance.id,
      aggregateKind: "service_instance",
      appliedAt: sql`clock_timestamp()`,
      createdAt: sql`clock_timestamp()`,
    }).onConflictDoNothing({
      target: [
        jobProjectionReceipts.organizationId,
        jobProjectionReceipts.companyId,
        jobProjectionReceipts.projectionKind,
        jobProjectionReceipts.sourceIdentity,
      ],
    });
    return { outcome: "applied", fromStatus: instance.status, toStatus: projection.toStatus };
  }

  /**
   * SVC-003 — THE ONE WRITER of `service_instances.status`, and the only place that column
   * is assigned outside the reconciler's INSERT.
   *
   * FOUR entry points funnel here, counted at this merge rather than left at SVC-003a's two:
   * the fenced `recordServiceHealth` mutator, the event projection above,
   * SVC-003b's `sweepServiceInstanceLiveness` (the liveness deadline, which has no fence to
   * hold because it acts precisely when the worker has gone quiet), and SVC-007a's
   * `terminalizeServiceInstanceForCancelledAttempt`. They funnel here so the
   * conditional-on-observed-status shape cannot drift between them, and so a fifth author
   * cannot arrive with a fifth idea of a legal move. Returns whether a row moved.
   *
   * ★★★ SVC-005a — `author` IS REQUIRED, AND THAT IS THE MECHANISM, not a convenience. This
   * is the ONE writer of `status`, so it is the only place that can observe a row becoming
   * terminal, and making the parameter required means a FIFTH author cannot arrive without
   * classifying itself: the omission is a typecheck failure rather than a silently
   * unattributable terminal row. `terminalized_by` is written ONLY when the status being
   * written is one of the frozen terminals — a non-terminal move leaves it NULL, so the
   * column never claims an authorship for a row that has not ended. Both writes are one
   * UPDATE on a row this caller already holds locked.
   *
   * Why the fence needs it, in one sentence: a terminal row authored by `worker_stopped` is the
   * worker SAYING IT SAW THE PROCESS GO, and every other author — a clock, a control-plane
   * backstop, or the worker's own `worker_unconfirmed` report that it could NOT confirm the
   * stop — leaves a process that may still be running (E9-F007). The generation rollout fence
   * must refuse to place a NEW generation on the strength of any of those. See
   * {@link SERVICE_INSTANCE_TERMINAL_AUTHORS}, whose header records why the worker's own event
   * is split in two and why collapsing it was a fail-open.
   */
  async function writeServiceInstanceStatus(input: {
    organizationId: string;
    serviceInstanceId: string;
    status: string;
    expectedFromStatus: string;
    author: ServiceInstanceTerminalAuthor;
  }): Promise<boolean> {
    const terminal = (TERMINAL_SERVICE_INSTANCE_STATUSES as readonly string[])
      .includes(input.status);
    const rows = await tx.update(serviceInstances).set({
      status: input.status,
      // Conditional rather than unconditional: stamping an author onto a `pending → leased`
      // move would make `terminalized_by` a "last writer" column, and the fence reads it as
      // "who ENDED this instance". Those are different questions and only one of them is
      // answerable from a status write.
      ...(terminal ? { terminalizedBy: input.author } : {}),
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(serviceInstances.organizationId, input.organizationId),
      eq(serviceInstances.id, input.serviceInstanceId),
      eq(serviceInstances.status, input.expectedFromStatus),
    )).returning({ id: serviceInstances.id });
    return rows.length > 0;
  }

  // JOB-006 job aggregate terminal states (distinct from attempt terminal states).
  const JOB_TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "dead_letter"] as const;

  // JOB-007 — release the attempt's Organization capacity slot with ONE conditional
  // 'held' -> 'released' transition. Called from every terminal convergence path
  // (worker completion, reaper, cancellation); exactly-once because only the first
  // caller that observes 'held' flips it. A no-op when the attempt never held a slot.
  async function releaseAttemptCapacitySlot(input: {
    organizationId: string;
    attemptId: string;
  }): Promise<void> {
    await tx.update(jobAttempts).set({
      capacityClaimState: "released",
      capacityReleasedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(jobAttempts.organizationId, input.organizationId),
      eq(jobAttempts.id, input.attemptId),
      eq(jobAttempts.capacityClaimState, "held"),
    ));
  }

  function toQueuedControlCommand(
    row: typeof jobControlCommands.$inferSelect,
  ): QueuedControlCommand {
    return {
      id: row.id,
      organizationId: row.organizationId,
      companyId: row.companyId,
      jobId: row.jobId,
      attemptId: row.attemptId,
      attemptNumber: row.attemptNumber,
      leaseId: row.leaseId,
      commandId: row.commandId,
      commandSeq: row.commandSeq,
      commandKind: row.commandKind as JobControlCommandKind,
      fenceToken: row.fenceToken,
      reason: row.reason,
      graceful: row.graceful,
      command: row.command,
      ackStatus: row.ackStatus as ControlCommandAckStatus | null,
    };
  }

  // JOB-006 — allocate attempt N+1 for a reaped attempt UNDER the job lock.
  //
  // ONE-WINNER RACE: the job row is locked FOR UPDATE first, then `max(attempt_number)`
  // is read under that lock. The allocation proceeds ONLY when the reaped attempt is
  // still the latest (max == reapedAttemptNumber) — a concurrent creator that already
  // advanced the chain leaves max > reapedAttemptNumber, so the second caller observes
  // the successor instead of minting a spurious N+2. The unique
  // (organization_id, company_id, job_id, attempt_number) constraint is the backstop:
  // a losing INSERT is a no-op (ON CONFLICT DO NOTHING) and reports `observed`. The
  // attempt-ready outbox row is created in the SAME transaction (unique per attempt),
  // and the backoff is written once (immutable) onto the new attempt.
  async function allocateRetry(input: RetryAllocationInput): Promise<RetryAllocationResult> {
    const [job] = await tx.select({ id: jobs.id }).from(jobs).where(and(
      eq(jobs.organizationId, input.organizationId),
      eq(jobs.companyId, input.companyId),
      eq(jobs.id, input.jobId),
    )).for("update").limit(1);
    if (!job) return { status: "job_missing", attemptNumber: null, attemptId: null, backoffUntil: null };

    const [{ maxNum }] = await tx.select({
      maxNum: sql<number>`COALESCE(MAX(${jobAttempts.attemptNumber}), 0)`,
    }).from(jobAttempts).where(and(
      eq(jobAttempts.organizationId, input.organizationId),
      eq(jobAttempts.companyId, input.companyId),
      eq(jobAttempts.jobId, input.jobId),
    ));
    const latest = Number(maxNum);
    if (latest !== input.reapedAttemptNumber) {
      // A successor already exists (or the reaped attempt is not the head) — observe.
      return { status: "not_latest", attemptNumber: latest, attemptId: null, backoffUntil: null };
    }

    const [reaped] = await tx.select().from(jobAttempts).where(and(
      eq(jobAttempts.organizationId, input.organizationId),
      eq(jobAttempts.companyId, input.companyId),
      eq(jobAttempts.jobId, input.jobId),
      eq(jobAttempts.id, input.reapedAttemptId),
    )).limit(1);
    if (!reaped) return { status: "job_missing", attemptNumber: null, attemptId: null, backoffUntil: null };

    const nextNumber = input.reapedAttemptNumber + 1;
    const backoffMs = computeRetryBackoffMs(
      input.reapedAttemptNumber,
      input.baseBackoffMs,
      input.maxBackoffMs,
    );
    const backoffUntil = new Date(input.now.getTime() + backoffMs);

    // DEP-009 capacity-claim TRANSFER. If the reaped attempt held an Organization
    // capacity slot, mint N+1 already 'held' so org occupancy is conserved across the
    // reap→retry boundary. The `job_attempts_capacity_claim_check` CHECK requires a
    // 'held' row to carry a non-null workload type + claimed_at (and null released_at),
    // so copy the reaped attempt's workload type (guaranteed non-null when it was held —
    // release keeps the workload type) and stamp a fresh claim instant. When the reaped
    // attempt was 'unclaimed' (flag-off submit), leave N+1 at the schema default so a
    // never-counted slot is not over-counted.
    const capacityTransfer = input.inheritCapacityHeld
      ? {
          capacityClaimState: "held" as const,
          capacityWorkloadType: reaped.capacityWorkloadType,
          capacityClaimedAt: input.now,
        }
      : {};

    const [insertedAttempt] = await tx.insert(jobAttempts).values({
      organizationId: input.organizationId,
      companyId: input.companyId,
      jobId: input.jobId,
      attemptNumber: nextNumber,
      status: "pending",
      ...capacityTransfer,
      // Copy the reaped attempt's immutable placement snapshot verbatim so N+1 is
      // dispatchable to the same target (re-placement is JOB-009, out of scope).
      placementDisposition: reaped.placementDisposition,
      placementOwner: reaped.placementOwner,
      placementTargetId: reaped.placementTargetId,
      placementTargetClass: reaped.placementTargetClass,
      placementTargetScope: reaped.placementTargetScope,
      placementTargetGeneration: reaped.placementTargetGeneration,
      placementProfileHash: reaped.placementProfileHash,
      placementProviderConstraintHash: reaped.placementProviderConstraintHash,
      placementFallbackDisposition: reaped.placementFallbackDisposition,
      placementReasonCode: reaped.placementReasonCode,
      placementMode: reaped.placementMode,
      placementLeaseEligible: reaped.placementLeaseEligible,
      placementInputDigest: reaped.placementInputDigest,
      placementPolicyDigest: reaped.placementPolicyDigest,
      placementDecidedAt: reaped.placementDecidedAt,
      backoffUntil,
      createdAt: input.now,
      updatedAt: input.now,
    }).onConflictDoNothing({
      target: [
        jobAttempts.organizationId,
        jobAttempts.companyId,
        jobAttempts.jobId,
        jobAttempts.attemptNumber,
      ],
    }).returning({ id: jobAttempts.id });
    if (!insertedAttempt) {
      return { status: "observed", attemptNumber: nextNumber, attemptId: null, backoffUntil: null };
    }

    // Reset the job to queued at the backoff instant and enqueue the attempt-ready
    // outbox row (unique per attempt) — both idempotent against a terminal job.
    await tx.update(jobs).set({
      status: "queued",
      availableAt: backoffUntil,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(jobs.organizationId, input.organizationId),
      eq(jobs.companyId, input.companyId),
      eq(jobs.id, input.jobId),
      notInArray(jobs.status, [...JOB_TERMINAL_STATUSES]),
    ));
    await tx.insert(jobOutbox).values({
      organizationId: input.organizationId,
      companyId: input.companyId,
      jobId: input.jobId,
      attemptId: insertedAttempt.id,
      kind: "attempt_ready",
      status: "pending",
      payload: {
        organizationId: input.organizationId,
        companyId: input.companyId,
        jobId: input.jobId,
        attemptId: insertedAttempt.id,
        sourceKind: "retry",
      },
      availableAt: backoffUntil,
    }).onConflictDoNothing({
      target: [jobOutbox.organizationId, jobOutbox.attemptId, jobOutbox.kind],
    });

    return { status: "created", attemptNumber: nextNumber, attemptId: insertedAttempt.id, backoffUntil };
  }

  async function admittedUserRequester(input: {
    organizationId: string;
    companyId: string;
    userId: string;
  }): Promise<{ kind: SourceRequesterKind; id: string } | null> {
    const [orgMembership] = await tx
      .select({ role: organizationMemberships.role })
      .from(organizationMemberships)
      .where(and(
        eq(organizationMemberships.organizationId, input.organizationId),
        eq(organizationMemberships.userId, input.userId),
        eq(organizationMemberships.status, "active"),
      ))
      .limit(1);
    const [companyMembership] = await tx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, input.userId),
        eq(companyMemberships.status, "active"),
      ))
      .limit(1);
    const kind = orgMembership ? requesterKindForOrganizationRole(orgMembership.role) : null;
    return companyMembership && kind ? { kind, id: input.userId } : null;
  }

  // JOB-015 — bound to a name so `renewLease` can call `listPendingControlCommands`
  // through the PUBLIC interface method rather than duplicating its query inline. The
  // duplication is precisely what left that method with zero callers while its own
  // docstring claimed the renew path surfaced it (E3-F035); a private helper shared by
  // both would have closed the query duplication and left the finding open.
  const repository: JobControlRepository = {
    async classifyLeaseTruth(leaseIds) {
      // Default EVERY requested id to `absent` first — a leaseId with no row in this
      // tenant (unknown, or wrong-tenant → forced RLS returns zero rows) stays absent;
      // the AM client maps absent → "unknown", never orphan. A found row overwrites it.
      const verdicts = new Map<string, LeaseTruthVerdict>();
      for (const id of leaseIds) verdicts.set(id, "absent");
      const uniqueIds = [...new Set(leaseIds)].filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
      if (uniqueIds.length === 0) return verdicts;

      // <classify-lease-truth-projection> — EXPLICIT column projection ONLY (B1-F3).
      // NEVER `SELECT *` and NEVER `leases.fence` (a live per-attempt bearer token): the
      // reaper decision must STRUCTURALLY never read a secret. This region is pinned by
      // scripts/check-secret-resolve-vectors.mjs (verifyClassifyLeaseTruthProjection) so
      // a future added column / `SELECT *` reds CI. Mirrors guardActiveFence's join:
      // leases ⋈ jobAttempts (org+attemptId) leftJoin executionTargets (authorityKey+id).
      const rows = await tx
        .select({
          leaseId: leases.id,
          leaseStatus: leases.status,
          leaseTargetGeneration: leases.targetGeneration,
          attemptStatus: jobAttempts.status,
          targetDeviceGeneration: executionTargets.deviceGeneration,
          targetStatus: executionTargets.status,
        })
        .from(leases)
        .innerJoin(
          jobAttempts,
          and(
            eq(jobAttempts.organizationId, leases.organizationId),
            eq(jobAttempts.id, leases.attemptId),
          ),
        )
        .leftJoin(
          executionTargets,
          and(
            eq(executionTargets.id, leases.targetId),
            eq(executionTargets.targetAuthorityKey, leases.targetAuthorityKey),
          ),
        )
        .where(inArray(leases.id, uniqueIds));
      // </classify-lease-truth-projection>

      for (const row of rows) {
        verdicts.set(row.leaseId, classifyLeaseTruthRow(row));
      }
      return verdicts;
    },
    async admission(input) {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1);
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(and(
          eq(companies.id, input.companyId),
          eq(companies.organizationId, input.organizationId),
        ))
        .limit(1);

      let requester: { kind: SourceRequesterKind; id: string } | null = null;
      if (input.principalKind === "user") {
        requester = await admittedUserRequester({
          organizationId: input.organizationId,
          companyId: input.companyId,
          userId: input.principalId,
        });
      } else if (input.principalKind === "agent") {
        const [agent] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, input.principalId), eq(agents.companyId, input.companyId)))
          .limit(1);
        requester = agent ? { kind: "agent", id: input.principalId } : null;
      } else if (input.principalKind === "mcp") {
        const [key] = await tx
          .select({ id: mcpApiKeys.id, userId: mcpApiKeys.userId })
          .from(mcpApiKeys)
          .where(and(
            eq(mcpApiKeys.id, input.principalId),
            eq(mcpApiKeys.companyId, input.companyId),
            isNull(mcpApiKeys.revokedAt),
          ))
          .limit(1);
        requester = key
          ? await admittedUserRequester({
              organizationId: input.organizationId,
              companyId: input.companyId,
              userId: key.userId,
            })
          : null;
      } else if (input.principalKind === "commander") {
        // These actors are authenticated by a company-bound run JWT or the
        // explicitly enabled local loopback identity. Re-check the admitted
        // Organization→Company edge in this transaction; neither actor has a
        // durable membership/key row of its own.
        requester = company && ["founder", "team_lead", "team_member"].includes(input.principalRole ?? "")
          ? { kind: "commander", id: input.principalId }
          : null;
      } else if (input.principalKind === "local_board") {
        requester = company ? { kind: "founder", id: input.principalId } : null;
      } else if (input.principalKind === "system") {
        requester = company ? { kind: "system", id: input.principalId } : null;
      }

      return {
        organizationExists: Boolean(organization),
        companyInOrganization: Boolean(company),
        principalAuthorized: Boolean(requester),
        requester,
      };
    },

    async taskSourceIsAdmitted(input) {
      const [row] = await tx
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .innerJoin(
          issues,
          and(
            eq(issues.id, input.issueId),
            eq(issues.companyId, input.companyId),
            eq(issues.assigneeAgentId, input.assigneeAgentId),
            eq(issues.checkoutRunId, input.runId),
            eq(issues.executionRunId, input.runId),
          ),
        )
        .innerJoin(
          agents,
          and(eq(agents.id, input.assigneeAgentId), eq(agents.companyId, input.companyId)),
        )
        .where(and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.assigneeAgentId),
        ))
        .limit(1);
      // The admitted legacy heartbeat engine supplies the domain worker role;
      // JOB-009 may later place that work, but no concrete worker is chosen here.
      return row ? { kind: "worker", id: row.agentId } : null;
    },

    async internalRunSourceIsAdmitted(input) {
      const ownership = input.requesterKind === "agent"
        ? eq(internalAgentRuns.agentId, input.requesterId)
        : eq(internalAgentRuns.userId, input.requesterId);
      const [row] = await tx
        .select({ id: internalAgentRuns.id, agentId: internalAgentRuns.agentId })
        .from(internalAgentRuns)
        .where(and(
          eq(internalAgentRuns.id, input.runId),
          eq(internalAgentRuns.companyId, input.companyId),
          eq(internalAgentRuns.triggerSource, input.triggerSource),
          ownership,
        ))
        .limit(1);
      if (!row) return null;
      if (input.triggerSource === "browser_request") {
        return { kind: "browser_worker", id: row.id };
      }
      // Crew's admitted source engine is worker-class. Its bound agent is the
      // opaque executor identity when present; the run remains the fallback for
      // a user-owned crew source without an assigned agent. This is not placement.
      return { kind: "worker", id: row.agentId ?? row.id };
    },

    async commanderSourceIsAdmitted(input) {
      const [row] = await tx
        .select({ id: internalAgentRuns.id })
        .from(internalAgentRuns)
        .innerJoin(internalAgentMessages, eq(internalAgentMessages.runId, internalAgentRuns.id))
        .innerJoin(
          internalAgentConversations,
          eq(internalAgentConversations.id, internalAgentMessages.conversationId),
        )
        .where(and(
          eq(internalAgentRuns.id, input.runId),
          eq(internalAgentRuns.companyId, input.companyId),
          eq(internalAgentRuns.triggerType, "conversation"),
          eq(internalAgentRuns.userId, input.userId),
          eq(internalAgentConversations.id, input.conversationId),
          eq(internalAgentConversations.companyId, input.companyId),
          eq(internalAgentConversations.userId, input.userId),
        ))
        .limit(1);
      return row ? { kind: "sandbox", id: row.id } : null;
    },

    async serviceSourceIsAdmitted(input) {
      const [row] = await tx
        .select({ id: services.id })
        .from(services)
        .where(and(
          eq(services.id, input.serviceId),
          eq(services.organizationId, input.organizationId),
          eq(services.companyId, input.companyId),
          eq(services.generation, input.generation),
          // ★ SVC-002 — "stopped services create no new instance", located in THE AUTHORITY
          // every submission passes through rather than in one loop's control flow. Before
          // this predicate a `service_reconcile` submission naming a service whose desired
          // state was 'stopped', 'paused' or 'deleted' was admitted; the clause had no
          // enforcement anywhere (SVC-001-terrain.md:200-201 handed it here by name).
          //
          // An ALLOW-LIST, never `ne('stopped')`: a deny-list would admit `paused` and
          // `deleted`. Fail-closed, and it gives SVC-005's pause its enforcement for free
          // without SVC-002 implementing pause.
          //
          // It is redundant with the reconciler's own sweep filter FOR THE RECONCILER, which
          // holds the row lock. Its value is entirely in the OTHER callers: a replayed
          // submission, SVC-007's future controls, a direct call.
          eq(services.desiredState, "running"),
        ))
        .limit(1);
      return row ? { kind: "service_instance", id: row.id } : null;
    },

    async lockServiceForReconcile(input) {
      // WAIT-INSTEAD-OF-RACE, not the authority. Two concurrent passes for one service
      // serialize here into a clean wait; a writer that never calls this takes no lock at
      // all, which is precisely why `service_instances_live_service_uq` exists.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('aoa:service-reconcile'), hashtext(${input.serviceId}))`,
      );
      const [row] = await tx
        .select({ desiredState: services.desiredState, generation: services.generation })
        .from(services)
        .where(and(
          eq(services.id, input.serviceId),
          eq(services.organizationId, input.organizationId),
          eq(services.companyId, input.companyId),
        ))
        .for("update")
        .limit(1);
      return row ?? null;
    },

    async countNonTerminalInstances(input) {
      const [row] = await tx
        .select({ total: count() })
        .from(serviceInstances)
        .where(and(
          eq(serviceInstances.organizationId, input.organizationId),
          eq(serviceInstances.serviceId, input.serviceId),
          nonTerminalServiceInstanceStatus(),
        ));
      return Number(row?.total ?? 0);
    },

    async insertServiceInstance(values) {
      try {
        // postgres-js nests `.transaction()` on a transaction handle as a SAVEPOINT
        // (JOB-010; runInTenant's own docstring says so), so this is the house mechanism
        // rather than an import.
        const instance = await tx.transaction(async (savepoint) => {
          const [row] = await savepoint.insert(serviceInstances).values(values).returning();
          return row!;
        });
        return { outcome: "inserted", instance };
      } catch (error) {
        if (!isLiveServiceInstanceConflict(error)) throw error;
        // The savepoint has been rolled back, so the transaction is usable again and this
        // read sees the COMMITTED winner (READ COMMITTED; see the interface docstring).
        const [existing] = await tx
          .select()
          .from(serviceInstances)
          .where(and(
            eq(serviceInstances.organizationId, values.organizationId),
            eq(serviceInstances.serviceId, values.serviceId),
            nonTerminalServiceInstanceStatus(),
          ))
          .limit(1);
        return { outcome: "conflict", instance: existing ?? null };
      }
    },

    async attributeServiceInstance(input) {
      const [row] = await tx
        .update(serviceInstances)
        .set({ jobId: input.jobId, attemptId: input.attemptId, updatedAt: sql`clock_timestamp()` })
        .where(and(
          eq(serviceInstances.id, input.serviceInstanceId),
          eq(serviceInstances.organizationId, input.organizationId),
        ))
        .returning();
      return row ?? null;
    },

    async sweepServiceInstanceLiveness(input) {
      const bounded = Math.max(1, Math.min(256, Math.floor(input.limit)));
      const result: ServiceInstanceLivenessSweepResult = {
        scanned: 0, terminalized: [], refusedIllegal: [], lostRace: 0,
      };
      // The LIVE set, through the one shared predicate every reader of "is there a live
      // instance" uses — so the sweep population and the partial unique index's population
      // cannot drift.
      //
      // ★★★ ORDERED BY LEAST-RECENTLY-HEARD-FROM, AND THAT ORDERING IS WHAT KEEPS THE BOUNDED
      // BATCH FROM STARVING. The first version of this query ordered by `created_at`, which is
      // the SAME STARVATION BUG review found in `listReconcilableServices` on PR #406, rebuilt
      // one function along: a HEALTHY instance never leaves the live set, so for a tenant with
      // more than `limit` live instances the oldest-created healthy rows fill every batch on
      // every tick and a silent instance created after them is NEVER INSPECTED — a stuck
      // service the deadline cannot see, which is the exact failure this ticket exists to
      // remove. Caught by external review of PR #413; `L-T12` is the regression case.
      //
      // Sorting by the least-recent instant fixes it WITHOUT a cursor and without a second
      // copy of the policy: a healthy instance is refreshed every ~10 s (SVC-008b's tick) and
      // therefore sinks to the BACK of the ordering, while an instance that has gone quiet
      // floats to the FRONT within one tick and stays there until it is terminalized. The
      // window is therefore always the most-likely-condemned rows, and a condemned row leaves
      // the live set, so every batch is real work.
      //
      // ★ THE `COALESCE` HERE IS AN ORDERING, NOT A VERDICT, and the distinction is exactly
      // mutant L15's. L15 collapses the two instants in the SELECT — the value the decider
      // judges — and that kills starting services. This one decides only WHICH ROW IS LOOKED
      // AT FIRST; the two ages are still projected separately below and the verdict still reads
      // them separately, so a never-observed row that sorts first is still judged under the
      // admission window (`L-T3`).
      const rows = await tx.select({
        serviceInstanceId: serviceInstances.id,
        serviceId: serviceInstances.serviceId,
        status: serviceInstances.status,
        // Milliseconds, from the database clock, NULL-preserving. `null` here is the
        // never-observed case and must survive as `null`; a COALESCE onto `created_at` would
        // apply the short liveness window to an instance that is merely still starting.
        observedAgeMs: sql<
          number | null
        >`CASE WHEN ${serviceInstances.lastObservedAt} IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM (clock_timestamp() - ${serviceInstances.lastObservedAt})) * 1000 END`,
        createdAgeMs: sql<
          number
        >`EXTRACT(EPOCH FROM (clock_timestamp() - ${serviceInstances.createdAt})) * 1000`,
      }).from(serviceInstances).where(and(
        eq(serviceInstances.organizationId, input.organizationId),
        nonTerminalServiceInstanceStatus(),
      )).orderBy(
        sql`COALESCE(${serviceInstances.lastObservedAt}, ${serviceInstances.createdAt}) ASC`,
        asc(serviceInstances.id),
      )
        .limit(bounded)
        .for("update", { skipLocked: true });

      for (const row of rows) {
        result.scanned += 1;
        // `EXTRACT` comes back as a numeric string on postgres-js; Number() it once, here,
        // so the injected decider always sees real numbers and `null` only ever means
        // never-observed.
        const candidate: ServiceInstanceLivenessRow = {
          serviceInstanceId: row.serviceInstanceId,
          serviceId: row.serviceId,
          status: row.status,
          observedAgeMs: row.observedAgeMs === null ? null : Number(row.observedAgeMs),
          createdAgeMs: Number(row.createdAgeMs),
        };
        if (!input.decide(candidate)) continue;
        // The SAME independent legality gate `applyServiceProjectionForFence` applies to a
        // worker's claim, applied to the control plane's own verdict. A decider is not more
        // trusted than a payload.
        if (!input.allowedFromStatuses.includes(candidate.status)) {
          result.refusedIllegal.push({
            serviceInstanceId: candidate.serviceInstanceId, fromStatus: candidate.status,
          });
          continue;
        }
        // Through the ONE writer, conditional on the status read under this lock.
        const moved = await writeServiceInstanceStatus({
          organizationId: input.organizationId,
          serviceInstanceId: candidate.serviceInstanceId,
          status: input.toStatus,
          expectedFromStatus: candidate.status,
          // SVC-005a — AN ASSUMPTION, AND THE MOST DANGEROUS OF THE THREE. Nothing witnessed
          // this instance ending; a clock condemned it precisely BECAUSE the worker had gone
          // silent, and E9-F007 records that the deadline terminalizes the INSTANCE without
          // fencing the WORKER — whose process may still be running and still performing
          // external effects. A generation rollout that treated this row as proof the old
          // generation had stopped would be the fail-open E9's acceptance clause forbids, so
          // the author is recorded honestly and the fence reads it as NOT-A-WITNESS.
          author: "liveness_deadline",
        });
        if (!moved) {
          result.lostRace += 1;
          continue;
        }
        result.terminalized.push({
          serviceInstanceId: candidate.serviceInstanceId,
          serviceId: candidate.serviceId,
          fromStatus: candidate.status,
        });
      }
      return result;
    },

    async listReconcilableServices(input) {
      const bounded = Math.max(1, Math.min(256, Math.floor(input.limit)));
      return tx
        .select({
          serviceId: services.id,
          companyId: services.companyId,
          generation: services.generation,
        })
        .from(services)
        .where(and(
          eq(services.desiredState, "running"),
          // The convergence predicate. Served by `service_instances_live_service_uq`, whose
          // index predicate is byte-for-byte this subquery's.
          notExists(
            tx
              .select({ one: sql`1` })
              .from(serviceInstances)
              .where(and(
                eq(serviceInstances.organizationId, services.organizationId),
                eq(serviceInstances.serviceId, services.id),
                nonTerminalServiceInstanceStatus(),
              )),
          ),
          input.afterServiceId ? gt(services.id, input.afterServiceId) : undefined,
        ))
        .orderBy(asc(services.id))
        .limit(bounded);
    },

    async findServiceGenerationDefinition(input) {
      const [row] = await tx
        .select({
          definition: serviceGenerations.definition,
          ttlSeconds: serviceGenerations.ttlSeconds,
          checkpointArtifactId: serviceGenerations.checkpointArtifactId,
        })
        .from(serviceGenerations)
        .where(and(
          eq(serviceGenerations.organizationId, input.organizationId),
          eq(serviceGenerations.companyId, input.companyId),
          eq(serviceGenerations.serviceId, input.serviceId),
          eq(serviceGenerations.generation, input.generation),
        ))
        .limit(1);
      if (!row) return null;
      return {
        definition: (row.definition ?? {}) as Record<string, unknown>,
        ttlSeconds: row.ttlSeconds,
        checkpointArtifactId: row.checkpointArtifactId,
      };
    },

    async insertServiceGeneration(values) {
      try {
        // Same SAVEPOINT mechanism, and for the same reason, as `insertServiceInstance`:
        // this insert shares ONE transaction with the `services` insert that precedes it, so
        // a raised 23505 would abort that transaction whole and the caller could not answer.
        const row = await tx.transaction(async (savepoint) => {
          const [inserted] = await savepoint
            .insert(serviceGenerations)
            .values({
              organizationId: values.organizationId,
              companyId: values.companyId,
              serviceId: values.serviceId,
              generation: values.generation,
              definition: values.definition,
              // ttl_seconds and checkpoint_artifact_id are left NULL on purpose. Nothing
              // enforces a TTL (SVC-005) and nothing restores a checkpoint (SVC-004), so a
              // stored value would be a bound no code keeps. See SVC-007a-design.md §5.
              createdBy: values.createdBy,
            })
            .returning({ id: serviceGenerations.id, generation: serviceGenerations.generation });
          return inserted!;
        });
        return row;
      } catch (error) {
        if (!isServiceGenerationConflict(error)) throw error;
        return null;
      }
    },

    async updateServiceDesiredState(input) {
      const [row] = await tx
        .update(services)
        .set({ desiredState: input.desiredState, updatedAt: sql`clock_timestamp()` })
        .where(and(
          eq(services.id, input.serviceId),
          eq(services.organizationId, input.organizationId),
          eq(services.companyId, input.companyId),
          eq(services.desiredState, input.expectedDesiredState),
        ))
        .returning({ desiredState: services.desiredState, generation: services.generation });
      return row ?? null;
    },

    async findServiceForCompany(input) {
      const [row] = await tx
        .select({
          serviceId: services.id,
          desiredState: services.desiredState,
          generation: services.generation,
          createdAt: services.createdAt,
          updatedAt: services.updatedAt,
        })
        .from(services)
        .where(and(
          eq(services.id, input.serviceId),
          eq(services.organizationId, input.organizationId),
          eq(services.companyId, input.companyId),
        ))
        .limit(1);
      return row ?? null;
    },

    async terminalizeServiceInstanceForCancelledAttempt(input) {
      // (1) AUTHORITY: the instance attributed to THIS job, locked for the rest of the
      // transaction — the same step-(1) shape `applyServiceProjectionForFence` uses, and for
      // the same reason: a concurrent reconciler pass about to read the observed state waits
      // rather than racing a half-applied terminalization.
      const [instance] = await tx.select({
        id: serviceInstances.id,
        status: serviceInstances.status,
        attemptId: serviceInstances.attemptId,
      }).from(serviceInstances).where(and(
        eq(serviceInstances.organizationId, input.organizationId),
        eq(serviceInstances.companyId, input.companyId),
        eq(serviceInstances.jobId, input.jobId),
      )).for("update").limit(1);
      if (!instance) return { outcome: "unattributed" };

      // (2) The attempt must ALREADY be terminal and NOT `succeeded`. Read here rather than
      // trusted from the caller, so this method's precondition is a database fact.
      const [attempt] = instance.attemptId
        ? await tx.select({ status: jobAttempts.status }).from(jobAttempts).where(and(
          eq(jobAttempts.organizationId, input.organizationId),
          eq(jobAttempts.companyId, input.companyId),
          eq(jobAttempts.id, instance.attemptId),
        )).limit(1)
        : [];
      const attemptStatus = attempt?.status ?? null;
      const terminalNonSuccess = attemptStatus !== null
        && attemptStatus !== "succeeded"
        && (TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(attemptStatus);
      if (!terminalNonSuccess) {
        return { outcome: "attempt_not_terminal", serviceInstanceId: instance.id, attemptStatus };
      }

      // (3) Already terminal is the NORMAL path when a worker did emit its own stop before
      // the control plane got here. A no-op, never a refusal on the happy path.
      if ((TERMINAL_SERVICE_INSTANCE_STATUSES as readonly string[]).includes(instance.status)) {
        return { outcome: "noop_already_terminal", serviceInstanceId: instance.id, fromStatus: instance.status };
      }

      // (4) LEGALITY, from the frozen table's predecessor set as the caller computed it. An
      // empty set refuses, so a caller that computed nothing gets a refusal and never an
      // unconditional write — the same failure-closed shape as the projection's step (5).
      if (!input.allowedFromStatuses.includes(instance.status)) {
        return { outcome: "illegal_transition", serviceInstanceId: instance.id, fromStatus: instance.status };
      }

      // (5) THE ONE WRITER, conditional on the exact status read under the lock.
      const moved = await writeServiceInstanceStatus({
        organizationId: input.organizationId,
        serviceInstanceId: instance.id,
        status: input.toStatus,
        expectedFromStatus: instance.status,
        // SVC-005a — AN ASSUMPTION, though a better-founded one than the deadline's. Its
        // precondition, re-read from the database under this row's lock at step (2), is that
        // the ATTEMPT is already terminal and did not succeed — and a terminal attempt closes
        // the fence (`classifyFence` returns `attempt_terminal`, packages/db/src/repositories/
        // tenant/job-fence.ts), so the old worker can no longer write anything. That is a real
        // and verifiable control-plane fact, and it is still NOT a witness that the PROCESS
        // stopped, which is why this author is excluded from
        // `WITNESSED_SERVICE_INSTANCE_TERMINAL_AUTHORS` rather than folded in with the worker's
        // own event.
        author: "control_plane_backstop",
      });
      if (!moved) {
        return { outcome: "illegal_transition", serviceInstanceId: instance.id, fromStatus: instance.status };
      }
      return {
        outcome: "applied",
        serviceInstanceId: instance.id,
        fromStatus: instance.status,
        toStatus: input.toStatus,
      };
    },

    async listServicesForCompany(input) {
      const bounded = Math.max(1, Math.min(200, Math.floor(input.limit)));
      return tx
        .select({
          serviceId: services.id,
          desiredState: services.desiredState,
          generation: services.generation,
          createdAt: services.createdAt,
          updatedAt: services.updatedAt,
        })
        .from(services)
        .where(and(
          eq(services.organizationId, input.organizationId),
          eq(services.companyId, input.companyId),
          input.afterServiceId ? gt(services.id, input.afterServiceId) : undefined,
        ))
        .orderBy(asc(services.id))
        .limit(bounded);
    },

    async bumpServiceGeneration(input) {
      // ONE forward step, derived here from the single `expectedGeneration` parameter rather
      // than accepted as a second one, so no caller can ask for a skip or a rewind. See the
      // interface docstring for why a rewind is the worse of the two.
      const next = input.expectedGeneration + 1;
      const [row] = await tx
        .update(services)
        .set({ generation: next, updatedAt: sql`clock_timestamp()` })
        .where(and(
          eq(services.id, input.serviceId),
          eq(services.organizationId, input.organizationId),
          eq(services.companyId, input.companyId),
          // The compare-and-set. Belt to the caller's row lock, exactly as
          // `updateServiceDesiredState`'s `expectedDesiredState` predicate is.
          eq(services.generation, input.expectedGeneration),
        ))
        .returning({ generation: services.generation });
      return row ?? null;
    },

    async listUnwitnessedGenerationPredecessors(input) {
      const bounded = Math.max(1, Math.min(64, Math.floor(input.limit)));
      return tx
        .select({
          serviceInstanceId: serviceInstances.id,
          generation: serviceInstances.generation,
          status: serviceInstances.status,
          terminalizedBy: serviceInstances.terminalizedBy,
          attemptId: serviceInstances.attemptId,
          attemptStatus: jobAttempts.status,
        })
        .from(serviceInstances)
        // LEFT, not INNER: an instance with no `attempt_id` must still be SEEN by this read.
        // An INNER join would silently drop it, and dropping a row from a fail-closed fence's
        // population is the direction that admits a placement rather than refusing one. Such a
        // row is then classified below as satisfying condition (3) — it was never leased, so
        // no worker ever ran for it and there is no fence to close.
        .leftJoin(jobAttempts, and(
          eq(jobAttempts.organizationId, serviceInstances.organizationId),
          eq(jobAttempts.id, serviceInstances.attemptId),
        ))
        .where(and(
          eq(serviceInstances.organizationId, input.organizationId),
          eq(serviceInstances.serviceId, input.serviceId),
          // (1) A DIFFERENT generation. Same-generation replacement is out of scope by
          // E9-F007 §3's standing ruling, which SVC-005a does not reopen.
          ne(serviceInstances.generation, input.currentGeneration),
          // (2) NOT A WITNESS — including NULL, which `notInArray` would NOT match (SQL
          // three-valued logic: `NULL NOT IN (...)` is UNKNOWN, not TRUE), so the NULL arm is
          // spelled out explicitly. Omitting it is the whole-fence fail-open: every row
          // terminalized before migration 0279 would silently read as witnessed.
          or(
            isNull(serviceInstances.terminalizedBy),
            notInArray(
              serviceInstances.terminalizedBy,
              [...WITNESSED_SERVICE_INSTANCE_TERMINAL_AUTHORS],
            ),
          ),
          // (3) THE RECOVERY CONDITION: the attempt has NOT reached a terminal status, so the
          // old worker's fence is still open. `isNull` is the never-leased arm and is joined
          // by OR so it is EXCLUDED from the blocking population — a row with no attempt has
          // no fence to close, so it can never block a roll, and the stall cannot become a
          // permanent wedge on a row that was never placed.
          and(
            isNotNull(serviceInstances.attemptId),
            isNotNull(jobAttempts.status),
            notInArray(jobAttempts.status, [...TERMINAL_ATTEMPT_STATUSES]),
          ),
        ))
        .orderBy(asc(serviceInstances.createdAt))
        .limit(bounded);
    },

    async findLiveServiceInstance(input) {
      const [row] = await tx
        .select({
          serviceInstanceId: serviceInstances.id,
          status: serviceInstances.status,
          generation: serviceInstances.generation,
          jobId: serviceInstances.jobId,
          attemptId: serviceInstances.attemptId,
          createdAt: serviceInstances.createdAt,
          updatedAt: serviceInstances.updatedAt,
        })
        .from(serviceInstances)
        .where(and(
          eq(serviceInstances.organizationId, input.organizationId),
          eq(serviceInstances.serviceId, input.serviceId),
          // The SAME shared predicate the sweep window, the observed-state count and the
          // lost-race re-read use, so this reader cannot drift from the index it relies on.
          nonTerminalServiceInstanceStatus(),
        ))
        .limit(1);
      return row ?? null;
    },

    async insertJobOnce(values) {
      const [row] = await tx
        .insert(jobs)
        .values(values)
        .onConflictDoNothing({
          target: [
            jobs.organizationId,
            jobs.companyId,
            jobs.authenticatedPrincipalKind,
            jobs.authenticatedPrincipalId,
            jobs.authenticatedSourceKind,
            jobs.authenticatedSourceIdentity,
            jobs.idempotencyKey,
          ],
        })
        .returning();
      return row ?? null;
    },

    async findSubmission(input) {
      const [row] = await tx
        .select()
        .from(jobs)
        .where(and(
          eq(jobs.organizationId, input.organizationId),
          eq(jobs.companyId, input.companyId),
          eq(jobs.authenticatedPrincipalKind, input.authenticatedPrincipalKind),
          eq(jobs.authenticatedPrincipalId, input.authenticatedPrincipalId),
          eq(jobs.authenticatedSourceKind, input.authenticatedSourceKind),
          eq(jobs.authenticatedSourceIdentity, input.authenticatedSourceIdentity),
          eq(jobs.idempotencyKey, input.idempotencyKey),
        ))
        .limit(1);
      return row ?? null;
    },

    async insertAttempt(values) {
      const [row] = await tx.insert(jobAttempts).values(values).returning();
      return row!;
    },

    async findInitialAttempt(jobId) {
      const [row] = await tx
        .select()
        .from(jobAttempts)
        .where(and(eq(jobAttempts.jobId, jobId), eq(jobAttempts.attemptNumber, 1)))
        .limit(1);
      return row ?? null;
    },

    async insertOutbox(values) {
      const [row] = await tx.insert(jobOutbox).values(values).returning();
      return row!;
    },

    async lockPlacementContext(input) {
      const [row] = await tx
        .select({ job: jobs, attempt: jobAttempts })
        .from(jobAttempts)
        .innerJoin(jobs, and(
          eq(jobs.organizationId, jobAttempts.organizationId),
          eq(jobs.companyId, jobAttempts.companyId),
          eq(jobs.id, jobAttempts.jobId),
        ))
        .where(and(
          eq(jobs.organizationId, input.organizationId),
          eq(jobs.companyId, input.companyId),
          eq(jobs.id, input.jobId),
          eq(jobAttempts.id, input.attemptId),
        ))
        .for("update")
        .limit(1);
      return row ?? null;
    },

    async listPlacementCandidateSnapshots() {
      const rows = await tx
        .select({
          target: placementTargetColumns,
          worker: placementWorkerColumns,
        })
        .from(executionTargets)
        .innerJoin(workers, and(
          eq(workers.executionTargetId, executionTargets.id),
          eq(workers.targetAuthorityKey, executionTargets.targetAuthorityKey),
        ))
        .for("share");

      const ownerUserIds = [...new Set(rows.flatMap((row) => (
        row.target.scope === "owner" && row.target.ownerUserId
          ? [row.target.ownerUserId]
          : []
      )))];
      const activeOwnerMemberships = ownerUserIds.length === 0
        ? []
        : await tx
          .select({
            organizationId: organizationMemberships.organizationId,
            userId: organizationMemberships.userId,
          })
          .from(organizationMemberships)
          .where(and(
            eq(organizationMemberships.status, "active"),
            inArray(organizationMemberships.userId, ownerUserIds),
          ));
      const activeOwnerKeys = new Set(activeOwnerMemberships.map(
        (membership) => `${membership.organizationId}:${membership.userId}`,
      ));

      return rows.map((row) => ({
        target: row.target,
        worker: row.worker,
        ownerMembershipActive: row.target.scope !== "owner" || (
          row.target.organizationId !== null
          && row.target.ownerUserId !== null
          && activeOwnerKeys.has(`${row.target.organizationId}:${row.target.ownerUserId}`)
        ),
      }));
    },

    async persistPlacementDecision(input) {
      const currentOwnerAuthority = input.placementDisposition === "selected"
        && input.placementOwner === "owner_desktop"
        ? exists(tx
            .select({ companyId: companies.id })
            .from(companies)
            .innerJoin(organizationMemberships, and(
              eq(organizationMemberships.organizationId, companies.organizationId),
              eq(organizationMemberships.organizationId, input.organizationId),
              eq(organizationMemberships.userId, input.placementOwnerPrincipalId ?? ""),
              eq(organizationMemberships.status, "active"),
            ))
            .where(and(
              eq(companies.id, input.companyId),
              eq(companies.organizationId, input.organizationId),
            )))
        : sql`true`;
      const [row] = await tx.update(jobAttempts).set({
        placementDisposition: input.placementDisposition,
        placementOwner: input.placementOwner,
        placementTargetId: input.placementTargetId,
        placementTargetClass: input.placementTargetClass,
        placementTargetScope: input.placementTargetScope,
        placementTargetGeneration: input.placementTargetGeneration,
        placementProfileHash: input.placementProfileHash,
        placementProviderConstraintHash: input.placementProviderConstraintHash,
        placementFallbackDisposition: input.placementFallbackDisposition,
        placementReasonCode: input.placementReasonCode,
        placementMode: input.placementMode,
        placementLeaseEligible: input.placementLeaseEligible,
        placementInputDigest: input.placementInputDigest,
        placementPolicyDigest: input.placementPolicyDigest,
        placementDecidedAt: input.placementDecidedAt,
        updatedAt: input.placementDecidedAt,
      }).where(and(
        eq(jobAttempts.organizationId, input.organizationId),
        eq(jobAttempts.companyId, input.companyId),
        eq(jobAttempts.jobId, input.jobId),
        eq(jobAttempts.id, input.attemptId),
        isNull(jobAttempts.placementDecidedAt),
        currentOwnerAuthority,
      )).returning();
      return row ?? null;
    },

    async lockWorkerLeaseAuthority(input) {
      // Lock the target BEFORE the worker so an overlapping poll and revoke acquire the two rows in
      // the same target->worker order (revokeTargetAuthority disables the target first, then the
      // workers); an inverted worker->target order here would let the two operations form a lock
      // cycle and deadlock. targetAuthorityKey is immutable for a target, so an unlocked one-column
      // probe is only used to choose the lock mode before the real, ordered lock is taken.
      const [targetProbe] = await tx.select({
        targetAuthorityKey: executionTargets.targetAuthorityKey,
      }).from(executionTargets).where(eq(executionTargets.id, input.targetId)).limit(1);
      if (!targetProbe) return null;

      const targetQuery = tx.select(placementTargetColumns)
        .from(executionTargets)
        .where(and(
          eq(executionTargets.id, input.targetId),
          eq(executionTargets.targetAuthorityKey, targetProbe.targetAuthorityKey),
        ))
        .limit(1);
      // aoa_app deliberately has SELECT-only visibility over null-Org platform
      // targets. The Decision #124 shared advisory handoff supplies the cutoff
      // guard; requesting FOR UPDATE here would require forbidden global DML.
      const [target] = targetProbe.targetAuthorityKey === "platform"
        ? await targetQuery
        : await targetQuery.for("update");
      if (!target) return null;

      // Revalidate the worker against the just-locked target's authority key (and its organization
      // via the row's own columns); a mismatch means the worker was re-homed and is not authorized.
      const [worker] = await tx.select({
        id: workers.id,
        scope: workers.scope,
        organizationId: workers.organizationId,
        ownerUserId: workers.ownerUserId,
        executionTargetId: workers.executionTargetId,
        targetAuthorityKey: workers.targetAuthorityKey,
        devicePublicKey: workers.devicePublicKey,
        deviceThumbprint: workers.deviceThumbprint,
        deviceGeneration: workers.deviceGeneration,
        profileHash: workers.profileHash,
        profileSnapshot: workers.profileSnapshot,
        status: workers.status,
        revokedAt: workers.revokedAt,
        lastSeenAt: workers.lastSeenAt,
      }).from(workers).where(and(
        eq(workers.id, input.workerId),
        eq(workers.executionTargetId, input.targetId),
        eq(workers.targetAuthorityKey, target.targetAuthorityKey),
      )).for("update").limit(1);
      if (!worker) return null;

      let ownerMembershipActive = true;
      if (worker.scope === "owner") {
        const [membership] = await tx.select({ id: organizationMemberships.id })
          .from(organizationMemberships)
          .where(and(
            eq(organizationMemberships.organizationId, worker.organizationId!),
            eq(organizationMemberships.userId, worker.ownerUserId!),
            eq(organizationMemberships.status, "active"),
          ))
          .for("share")
          .limit(1);
        ownerMembershipActive = Boolean(membership);
      }
      return { worker, target, ownerMembershipActive };
    },

    async lockEligibleLeaseCandidates(input) {
      if (input.limit !== 256) throw new Error("Lease candidate limit must be 256");
      const emptyMetrics: LeaseCertificateScanMetrics = {
        hitsObserved: 0,
        hitsSaturated: false,
        missesObserved: 0,
        missesSaturated: false,
        scanExhausted: false,
        cardinalityObserved: 0,
        cardinalitySaturated: false,
      };
      if (input.admissibleWorkloadTypes.length === 0) {
        return { candidates: [], certificateMetrics: emptyMetrics };
      }

      // Global-head candidate claim: exact static-certificate anti-join (notExists), one immutable
      // ordered head, FOR UPDATE SKIP LOCKED. Written inline (no extracted where builder) so the
      // frozen anti-join contract can read the exact conjunct set from this one .where(and(...)).
      const candidates = await tx.select({
        job: jobs,
        attempt: jobAttempts,
        certificateWorkerId: sql<string>`${input.workerId}`,
        certificateTargetAuthorityKey: sql<string>`${input.targetAuthorityKey}`,
        certificateEligibilityVersion: sql<number>`${input.eligibilityVersion}`,
      })
        .from(jobAttempts)
        .innerJoin(jobs, and(
          eq(jobs.organizationId, jobAttempts.organizationId),
          eq(jobs.companyId, jobAttempts.companyId),
          eq(jobs.id, jobAttempts.jobId),
        ))
        .where(and(
          eq(jobAttempts.status, "pending"),
          eq(jobAttempts.placementDisposition, "selected"),
          eq(jobAttempts.placementMode, "active"),
          eq(jobAttempts.placementLeaseEligible, true),
          eq(jobAttempts.placementOwner, input.placementOwner),
          eq(jobAttempts.placementTargetId, input.targetId),
          eq(jobAttempts.placementTargetClass, input.targetClass),
          eq(jobAttempts.placementTargetScope, input.targetScope),
          eq(jobAttempts.placementTargetGeneration, input.targetGeneration),
          eq(jobAttempts.placementProfileHash, input.targetProfileHash),
          eq(jobAttempts.placementProviderConstraintHash, input.targetProviderConstraintHash),
          eq(jobs.status, "queued"),
          inArray(jobs.workloadType, input.admissibleWorkloadTypes),
          lte(jobs.availableAt, sql`statement_timestamp()`),
          notExists(tx.select({ value: sql<number>`1` })
            .from(workerLeaseRejections)
            .where(and(
              eq(workerLeaseRejections.organizationId, jobAttempts.organizationId),
              eq(workerLeaseRejections.companyId, jobAttempts.companyId),
              eq(workerLeaseRejections.jobId, jobAttempts.jobId),
              eq(workerLeaseRejections.attemptId, jobAttempts.id),
              eq(workerLeaseRejections.workerId, input.workerId),
              eq(workerLeaseRejections.targetId, input.targetId),
              eq(workerLeaseRejections.targetAuthorityKey, input.targetAuthorityKey),
              eq(workerLeaseRejections.workloadType, jobs.workloadType),
              eq(workerLeaseRejections.placementOwner, jobAttempts.placementOwner),
              eq(workerLeaseRejections.placementTargetClass, jobAttempts.placementTargetClass),
              eq(workerLeaseRejections.placementTargetScope, jobAttempts.placementTargetScope),
              eq(workerLeaseRejections.placementTargetGeneration, jobAttempts.placementTargetGeneration),
              eq(workerLeaseRejections.placementProfileHash, jobAttempts.placementProfileHash),
              eq(workerLeaseRejections.placementProviderConstraintHash, jobAttempts.placementProviderConstraintHash),
              eq(workerLeaseRejections.placementInputDigest, jobAttempts.placementInputDigest),
              eq(workerLeaseRejections.placementPolicyDigest, jobAttempts.placementPolicyDigest),
              eq(workerLeaseRejections.eligibilityVersion, input.eligibilityVersion),
              eq(workerLeaseRejections.staticContextHash, input.staticContextHash),
            ))),
        ))
        .orderBy(asc(jobs.availableAt), desc(jobs.priority), asc(jobs.createdAt), asc(jobs.id))
        .limit(256)
        .for("update", { of: jobAttempts, skipLocked: true });

      // Payload-free telemetry probe. A separate read (no FOR UPDATE, never contends with the claim)
      // over the same eligibility MINUS the certificate anti-join, tagging each of at most 4097
      // eligible-shaped rows with whether an existing certificate would suppress it. hits + misses
      // are counted in memory and reported as min(count, 4096) plus a saturation flag.
      const probeRows = await tx.select({
        suppressed: sql<boolean>`${exists(tx.select({ value: sql<number>`1` })
          .from(workerLeaseRejections)
          .where(and(
            eq(workerLeaseRejections.organizationId, jobAttempts.organizationId),
            eq(workerLeaseRejections.companyId, jobAttempts.companyId),
            eq(workerLeaseRejections.jobId, jobAttempts.jobId),
            eq(workerLeaseRejections.attemptId, jobAttempts.id),
            eq(workerLeaseRejections.workerId, input.workerId),
            eq(workerLeaseRejections.targetId, input.targetId),
            eq(workerLeaseRejections.targetAuthorityKey, input.targetAuthorityKey),
            eq(workerLeaseRejections.workloadType, jobs.workloadType),
            eq(workerLeaseRejections.placementOwner, jobAttempts.placementOwner),
            eq(workerLeaseRejections.placementTargetClass, jobAttempts.placementTargetClass),
            eq(workerLeaseRejections.placementTargetScope, jobAttempts.placementTargetScope),
            eq(workerLeaseRejections.placementTargetGeneration, jobAttempts.placementTargetGeneration),
            eq(workerLeaseRejections.placementProfileHash, jobAttempts.placementProfileHash),
            eq(workerLeaseRejections.placementProviderConstraintHash, jobAttempts.placementProviderConstraintHash),
            eq(workerLeaseRejections.placementInputDigest, jobAttempts.placementInputDigest),
            eq(workerLeaseRejections.placementPolicyDigest, jobAttempts.placementPolicyDigest),
            eq(workerLeaseRejections.eligibilityVersion, input.eligibilityVersion),
            eq(workerLeaseRejections.staticContextHash, input.staticContextHash),
          )))}`,
      })
        .from(jobAttempts)
        .innerJoin(jobs, and(
          eq(jobs.organizationId, jobAttempts.organizationId),
          eq(jobs.companyId, jobAttempts.companyId),
          eq(jobs.id, jobAttempts.jobId),
        ))
        .where(and(
          eq(jobAttempts.status, "pending"),
          eq(jobAttempts.placementDisposition, "selected"),
          eq(jobAttempts.placementMode, "active"),
          eq(jobAttempts.placementLeaseEligible, true),
          eq(jobAttempts.placementOwner, input.placementOwner),
          eq(jobAttempts.placementTargetId, input.targetId),
          eq(jobAttempts.placementTargetClass, input.targetClass),
          eq(jobAttempts.placementTargetScope, input.targetScope),
          eq(jobAttempts.placementTargetGeneration, input.targetGeneration),
          eq(jobAttempts.placementProfileHash, input.targetProfileHash),
          eq(jobAttempts.placementProviderConstraintHash, input.targetProviderConstraintHash),
          eq(jobs.status, "queued"),
          inArray(jobs.workloadType, input.admissibleWorkloadTypes),
          lte(jobs.availableAt, sql`statement_timestamp()`),
        ))
        .limit(4097);
      const hitsRaw = probeRows.reduce((total, row) => total + (row.suppressed === true ? 1 : 0), 0);
      const missesRaw = probeRows.length - hitsRaw;

      // Bounded cardinality probe: at most 4097 of this worker/target/authority's certificate rows.
      const cardinalityRows = await tx.select({ one: sql<number>`1` })
        .from(workerLeaseRejections)
        .where(and(
          eq(workerLeaseRejections.workerId, input.workerId),
          eq(workerLeaseRejections.targetId, input.targetId),
          eq(workerLeaseRejections.targetAuthorityKey, input.targetAuthorityKey),
          eq(workerLeaseRejections.eligibilityVersion, input.eligibilityVersion),
          eq(workerLeaseRejections.staticContextHash, input.staticContextHash),
        ))
        .limit(4097);

      const certificateMetrics: LeaseCertificateScanMetrics = {
        hitsObserved: Math.min(hitsRaw, 4096),
        hitsSaturated: hitsRaw > 4096,
        missesObserved: Math.min(missesRaw, 4096),
        missesSaturated: missesRaw > 4096,
        scanExhausted: candidates.length === 256,
        cardinalityObserved: Math.min(cardinalityRows.length, 4096),
        cardinalitySaturated: cardinalityRows.length > 4096,
      };
      return { candidates, certificateMetrics };
    },

    async snapshotLiveLeaseCapacity(input) {
      const [row] = await tx.select({
        total: count(),
        batch: sql<number>`COUNT(*) FILTER (WHERE workload_type = 'batch')`,
        browserSession: sql<number>`COUNT(*) FILTER (WHERE workload_type = 'browser_session')`,
        service: sql<number>`COUNT(*) FILTER (WHERE workload_type = 'service')`,
      }).from(leases).innerJoin(jobs, and(
        eq(jobs.organizationId, leases.organizationId),
        eq(jobs.companyId, leases.companyId),
        eq(jobs.id, leases.jobId),
      )).where(and(
        eq(leases.workerId, input.workerId),
        eq(leases.targetId, input.targetId),
        inArray(leases.status, ["offered", "active"]),
      ));
      return {
        total: Number(row?.total ?? 0),
        batch: Number(row?.batch ?? 0),
        browserSession: Number(row?.browserSession ?? 0),
        service: Number(row?.service ?? 0),
      };
    },

    async upsertLeaseRejectionCertificates(input) {
      const certificates: NewWorkerLeaseRejection[] = [];
      if ("certificates" in input) {
        for (let index = 0; index < input.certificates.length; index += 1) {
          certificates[index] = input.certificates[index]!;
        }
      } else {
        for (let index = 0; index < input.length; index += 1) {
            const { candidate, reasonCode, staticContextHash } = input[index]!;
            const { job, attempt } = candidate;
            if (!attempt.placementOwner || !attempt.placementTargetId ||
                !attempt.placementTargetClass || !attempt.placementTargetScope ||
                !attempt.placementTargetGeneration || !attempt.placementProfileHash ||
                !attempt.placementProviderConstraintHash || !attempt.placementInputDigest ||
                !attempt.placementPolicyDigest) {
              throw new Error("Static lease rejection candidate has incomplete placement facts");
            }
            certificates[index] = {
              organizationId: job.organizationId,
              companyId: job.companyId,
              jobId: job.id,
              attemptId: attempt.id,
              workerId: candidate.certificateWorkerId,
              targetId: attempt.placementTargetId,
              targetAuthorityKey: candidate.certificateTargetAuthorityKey,
              eligibilityVersion: candidate.certificateEligibilityVersion,
              staticContextHash,
              workloadType: job.workloadType,
              placementOwner: attempt.placementOwner,
              placementTargetClass: attempt.placementTargetClass,
              placementTargetScope: attempt.placementTargetScope,
              placementTargetGeneration: attempt.placementTargetGeneration,
              placementProfileHash: attempt.placementProfileHash,
              placementProviderConstraintHash: attempt.placementProviderConstraintHash,
              placementInputDigest: attempt.placementInputDigest,
              placementPolicyDigest: attempt.placementPolicyDigest,
              reasonCode,
            };
        }
      }
      if (certificates.length === 0) return 0;
      const rows = await tx.insert(workerLeaseRejections).values(certificates)
        .onConflictDoUpdate({
          target: [
            workerLeaseRejections.organizationId,
            workerLeaseRejections.workerId,
            workerLeaseRejections.attemptId,
          ],
          set: {
            companyId: sql`excluded.company_id`,
            jobId: sql`excluded.job_id`,
            targetId: sql`excluded.target_id`,
            targetAuthorityKey: sql`excluded.target_authority_key`,
            eligibilityVersion: sql`excluded.eligibility_version`,
            staticContextHash: sql`excluded.static_context_hash`,
            workloadType: sql`excluded.workload_type`,
            placementOwner: sql`excluded.placement_owner`,
            placementTargetClass: sql`excluded.placement_target_class`,
            placementTargetScope: sql`excluded.placement_target_scope`,
            placementTargetGeneration: sql`excluded.placement_target_generation`,
            placementProfileHash: sql`excluded.placement_profile_hash`,
            placementProviderConstraintHash: sql`excluded.placement_provider_constraint_hash`,
            placementInputDigest: sql`excluded.placement_input_digest`,
            placementPolicyDigest: sql`excluded.placement_policy_digest`,
            reasonCode: sql`excluded.reason_code`,
            updatedAt: sql`clock_timestamp()`,
          },
        }).returning({ attemptId: workerLeaseRejections.attemptId });
      return rows.length;
    },

    async cleanupLeaseRejectionCertificates(input) {
      // Bounds are validated before any beforeStatement wrapper or SQL runs; an invalid limit or
      // cardinality bound rolls the tenant transaction back before select/delete/cardinality fire.
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0 ||
          !Number.isSafeInteger(input.cardinalityLimit) || input.cardinalityLimit <= 0) {
        throw new Error("lease_rejection_cleanup_bound");
      }
      const boundedLimit = input.limit;
      const cardinalityLimit = input.cardinalityLimit;
      const terminal = ["succeeded", "failed", "cancelled", "dead_letter"];

      await input.beforeStatement("select");
      // LEFT joins so a certificate whose parent job/attempt/worker/target was deleted, cascaded,
      // or drifted still appears in the candidate set. A row is eligible only for a correctness
      // reason (missing/terminal/retired/revoked/offline authority or placement drift), never age;
      // updated_at is ordering only.
      const candidates = await tx.select({
        organizationId: workerLeaseRejections.organizationId,
        workerId: workerLeaseRejections.workerId,
        attemptId: workerLeaseRejections.attemptId,
      }).from(workerLeaseRejections)
        .leftJoin(jobs, and(
          eq(jobs.organizationId, workerLeaseRejections.organizationId),
          eq(jobs.companyId, workerLeaseRejections.companyId),
          eq(jobs.id, workerLeaseRejections.jobId),
        ))
        .leftJoin(jobAttempts, and(
          eq(jobAttempts.organizationId, workerLeaseRejections.organizationId),
          eq(jobAttempts.companyId, workerLeaseRejections.companyId),
          eq(jobAttempts.jobId, workerLeaseRejections.jobId),
          eq(jobAttempts.id, workerLeaseRejections.attemptId),
        ))
        .leftJoin(workers, and(
          eq(workers.organizationId, workerLeaseRejections.organizationId),
          eq(workers.id, workerLeaseRejections.workerId),
        ))
        .leftJoin(executionTargets, eq(executionTargets.id, workerLeaseRejections.targetId))
        .where(or(
          isNull(jobAttempts.id),
          ne(jobAttempts.status, "pending"),
          isNull(jobs.id),
          inArray(jobs.status, terminal),
          isNull(workers.id),
          eq(workers.status, "revoked"),
          ne(workers.targetAuthorityKey, workerLeaseRejections.targetAuthorityKey),
          ne(workers.executionTargetId, workerLeaseRejections.targetId),
          isNull(executionTargets.id),
          inArray(executionTargets.status, ["offline", "disabled"]),
          ne(executionTargets.targetAuthorityKey, workerLeaseRejections.targetAuthorityKey),
          ne(workerLeaseRejections.placementTargetGeneration, executionTargets.deviceGeneration),
          ne(workerLeaseRejections.placementProfileHash, executionTargets.registeredProfileHash),
          ne(
            workerLeaseRejections.placementProviderConstraintHash,
            sql`${executionTargets.providerConstraintProfile} ->> 'digest'`,
          ),
          ne(workerLeaseRejections.workloadType, jobs.workloadType),
          ne(workerLeaseRejections.placementOwner, jobAttempts.placementOwner),
          ne(workerLeaseRejections.placementTargetClass, jobAttempts.placementTargetClass),
          ne(workerLeaseRejections.placementTargetScope, jobAttempts.placementTargetScope),
          ne(workerLeaseRejections.placementTargetGeneration, jobAttempts.placementTargetGeneration),
          ne(workerLeaseRejections.placementProfileHash, jobAttempts.placementProfileHash),
          ne(workerLeaseRejections.placementProviderConstraintHash, jobAttempts.placementProviderConstraintHash),
          ne(workerLeaseRejections.placementInputDigest, jobAttempts.placementInputDigest),
          ne(workerLeaseRejections.placementPolicyDigest, jobAttempts.placementPolicyDigest),
        ))
        .orderBy(
          asc(workerLeaseRejections.updatedAt),
          asc(workerLeaseRejections.workerId),
          asc(workerLeaseRejections.attemptId),
        )
        .limit(boundedLimit)
        .for("update", { of: workerLeaseRejections, skipLocked: true });

      let deleted = 0;
      if (candidates.length > 0) {
        await input.beforeStatement("delete");
        // Delete only the exact selected (organization_id, worker_id, attempt_id) primary-key
        // tuples via an OR-of-AND predicate — never independent IN lists, which would expand a
        // Cartesian set of unselected rows. The exact-tuple RETURNING is the sole affected count;
        // a return beyond the requested bound rolls back rather than clamping with Math.min.
        const removed = await tx.delete(workerLeaseRejections).where(or(
          ...candidates.map((candidate) => and(
            eq(workerLeaseRejections.organizationId, candidate.organizationId),
            eq(workerLeaseRejections.workerId, candidate.workerId),
            eq(workerLeaseRejections.attemptId, candidate.attemptId),
          )),
        )).returning({ attemptId: workerLeaseRejections.attemptId });
        if (removed.length > boundedLimit) throw new Error("lease_rejection_cleanup_bound");
        deleted = removed.length;
      }

      await input.beforeStatement("cardinality");
      // Bounded truthful probe of this tenant's remaining certificates: at most
      // cardinalityLimit + 1 keys, never a global owner scan.
      const remaining = await tx.select({ one: sql<number>`1` })
        .from(workerLeaseRejections)
        .limit(cardinalityLimit + 1);
      return {
        deleted,
        cardinalityObserved: Math.min(remaining.length, cardinalityLimit),
        cardinalitySaturated: remaining.length > cardinalityLimit,
      };
    },

    async acquirePlatformTargetAuthorityShared(targetId) {
      await configurePlatformTargetAuthorityLockTimeout(tx);
      await acquirePlatformTargetAuthorityShared(tx, targetId);
    },

    async recheckPlatformTargetAuthority(input) {
      const [target] = await tx.select(placementTargetColumns)
        .from(executionTargets)
        .where(and(
          eq(executionTargets.id, input.targetId),
          eq(executionTargets.scope, "platform"),
          isNull(executionTargets.organizationId),
          isNull(executionTargets.ownerUserId),
          eq(executionTargets.targetAuthorityKey, input.targetAuthorityKey),
          eq(executionTargets.deviceGeneration, input.targetGeneration),
        ))
        .limit(1);
      return target ?? null;
    },

    async touchWorkerLeaseProfile(input) {
      const rows = await tx.update(workers).set({
        lastSeenAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(workers.id, input.workerId),
        eq(workers.executionTargetId, input.targetId),
        eq(workers.deviceGeneration, input.targetGeneration),
        ne(workers.status, "revoked"),
      )).returning({ id: workers.id });
      return rows.length === 1;
    },

    async currentDatabaseTime() {
      const rows = await tx.execute<{ value: Date | string }>(sql`SELECT clock_timestamp() AS value`);
      const [row] = rows;
      const value = row?.value;
      const parsed = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(parsed.getTime())) {
        throw new Error("Database returned an invalid clock_timestamp() value");
      }
      return parsed;
    },

    async setLocalStatementTimeout(milliseconds) {
      const bounded = Math.max(1, Math.min(30_000, Math.floor(milliseconds)));
      await tx.execute(sql`SELECT set_config('statement_timeout', ${String(bounded)}, true)`);
    },

    async offerLease(input) {
      const [attempt] = await tx.update(jobAttempts).set({
        status: "offered",
        updatedAt: input.createdAt,
      }).where(and(
        eq(jobAttempts.id, input.attemptId),
        eq(jobAttempts.organizationId, input.organizationId),
        eq(jobAttempts.companyId, input.companyId),
        eq(jobAttempts.jobId, input.jobId),
        eq(jobAttempts.attemptNumber, input.attemptNumber),
        eq(jobAttempts.status, "pending"),
        eq(jobAttempts.placementDisposition, "selected"),
        eq(jobAttempts.placementMode, "active"),
        eq(jobAttempts.placementLeaseEligible, true),
        eq(jobAttempts.placementTargetId, input.targetId),
        eq(jobAttempts.placementTargetGeneration, input.targetGeneration),
        eq(jobAttempts.placementProviderConstraintHash, input.providerConstraintHash),
      )).returning({ id: jobAttempts.id });
      if (!attempt) return null;
      try {
        const [lease] = await tx.insert(leases).values({
          organizationId: input.organizationId,
          companyId: input.companyId,
          jobId: input.jobId,
          attemptId: input.attemptId,
          attemptNumber: input.attemptNumber,
          workerId: input.workerId,
          targetId: input.targetId,
          targetAuthorityKey: input.targetAuthorityKey,
          targetGeneration: input.targetGeneration,
          profileHash: input.profileHash,
          providerConstraintHash: input.providerConstraintHash,
          status: "offered",
          fence: input.fence,
          ackDeadline: input.ackDeadline,
          expiresAt: input.expiresAt,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        }).returning();
        return lease ?? null;
      } catch {
        // PostgreSQL marks this transaction failed. Returning null lets the
        // service raise its private head-restart sentinel, guaranteeing outer
        // rollback before a fresh bounded attempt reports internal_unavailable.
        return null;
      }
    },

    async cleanupExpiredOperationReceipts(expiresBefore, limit = 100) {
      const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
      const expired = await tx.select({ id: workerOperationReceipts.id })
        .from(workerOperationReceipts)
        .where(lte(workerOperationReceipts.expiresAt, expiresBefore))
        .orderBy(asc(workerOperationReceipts.expiresAt), asc(workerOperationReceipts.id))
        .limit(boundedLimit)
        .for("update", { skipLocked: true });
      if (expired.length === 0) return 0;
      const removed = await tx.delete(workerOperationReceipts)
        .where(inArray(workerOperationReceipts.id, expired.map((row) => row.id)))
        .returning({ id: workerOperationReceipts.id });
      return removed.length;
    },

    async findOperationReceipt(input) {
      const exactIdentity = and(
        eq(workerOperationReceipts.organizationId, input.organizationId),
        eq(workerOperationReceipts.workerId, input.workerId),
        eq(workerOperationReceipts.targetId, input.targetId),
        eq(workerOperationReceipts.targetGeneration, input.targetGeneration),
        eq(workerOperationReceipts.profileHash, input.profileHash),
        eq(workerOperationReceipts.operation, input.operation),
        eq(workerOperationReceipts.idempotencyKey, input.idempotencyKey),
      );
      // Semantic replay validity is independent of bounded housekeeping. Remove
      // only this exact expired collision using fresh DB time, then read only a
      // still-current receipt. An unexpired receipt is never deleted/replaced.
      await tx.delete(workerOperationReceipts).where(and(
        exactIdentity,
        lte(workerOperationReceipts.expiresAt, sql`clock_timestamp()`),
      ));
      const [receipt] = await tx.select().from(workerOperationReceipts).where(and(
        exactIdentity,
        gt(workerOperationReceipts.expiresAt, sql`clock_timestamp()`),
      )).limit(1);
      return receipt ?? null;
    },

    async lockLeaseAckContext(input) {
      const [context] = await tx.select({ lease: leases, attempt: jobAttempts })
        .from(leases)
        .innerJoin(jobAttempts, and(
          eq(jobAttempts.organizationId, leases.organizationId),
          eq(jobAttempts.companyId, leases.companyId),
          eq(jobAttempts.jobId, leases.jobId),
          eq(jobAttempts.id, leases.attemptId),
        ))
        .where(and(
          eq(leases.organizationId, input.organizationId),
          eq(leases.id, input.leaseId),
          eq(leases.jobId, input.jobId),
          eq(leases.attemptNumber, input.attemptNumber),
          eq(leases.workerId, input.workerId),
          eq(leases.targetId, input.targetId),
          eq(leases.targetGeneration, input.targetGeneration),
          eq(leases.profileHash, input.profileHash),
          eq(leases.fence, input.fence),
        ))
        .for("update")
        .limit(1);
      return context ?? null;
    },

    async activateLeaseAck(input) {
      const [lease] = await tx.update(leases).set({
        status: "active",
        activatedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(leases.organizationId, input.organizationId),
        eq(leases.companyId, input.companyId),
        eq(leases.jobId, input.jobId),
        eq(leases.attemptId, input.attemptId),
        eq(leases.attemptNumber, input.attemptNumber),
        eq(leases.id, input.leaseId),
        eq(leases.workerId, input.workerId),
        eq(leases.targetId, input.targetId),
        eq(leases.targetAuthorityKey, input.targetAuthorityKey),
        eq(leases.targetGeneration, input.targetGeneration),
        eq(leases.profileHash, input.profileHash),
        eq(leases.providerConstraintHash, input.providerConstraintHash),
        eq(leases.fence, input.fence),
        eq(leases.status, "offered"),
        gte(leases.ackDeadline, sql`clock_timestamp()`),
        gte(leases.expiresAt, sql`clock_timestamp()`),
      )).returning();
      if (!lease) return null;

      const [attempt] = await tx.update(jobAttempts).set({
        status: "leased",
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(jobAttempts.organizationId, input.organizationId),
        eq(jobAttempts.companyId, input.companyId),
        eq(jobAttempts.jobId, input.jobId),
        eq(jobAttempts.id, input.attemptId),
        eq(jobAttempts.attemptNumber, input.attemptNumber),
        eq(jobAttempts.status, "offered"),
        eq(jobAttempts.placementDisposition, "selected"),
        eq(jobAttempts.placementMode, "active"),
        eq(jobAttempts.placementLeaseEligible, true),
        eq(jobAttempts.placementTargetId, input.targetId),
        eq(jobAttempts.placementTargetGeneration, input.targetGeneration),
        eq(jobAttempts.placementProfileHash, input.placementProfileHash),
        eq(jobAttempts.placementProviderConstraintHash, input.providerConstraintHash),
      )).returning({ id: jobAttempts.id });
      if (!attempt) throw new Error("Lease ACK attempt authority changed");

      await tx.insert(workerOperationReceipts).values({
        organizationId: input.organizationId,
        companyId: input.companyId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        leaseId: input.leaseId,
        operation: "lease_ack",
        workerId: input.workerId,
        targetId: input.targetId,
        targetAuthorityKey: input.targetAuthorityKey,
        targetGeneration: input.targetGeneration,
        profileHash: input.profileHash,
        idempotencyKey: input.idempotencyKey,
        semanticDigest: input.semanticDigest,
        outcome: input.outcome,
        expiresAt: input.receiptExpiresAt,
        createdAt: sql`clock_timestamp()`,
      });
      return lease;
    },

    // ---- JOB-004 conditional renewal ---------------------------------------
    async renewLease(input) {
      // Gate on the common active-fence guard (locks the lease+attempt, classifies
      // stale_fence/attempt_terminal). Then extend ONLY the expiry using a FRESH SQL
      // clock inside the conditional mutation — never a transaction-start or
      // JavaScript time. The WHERE re-asserts `status = 'active'` and
      // `expires_at > clock_timestamp()` so a lease that expires WHILE the
      // transaction runs (clock advances past a fixed stored expiry) renews zero
      // rows → stale_fence. No authority column (fence/generation/target) is touched.
      await guardActiveFence(input);
      const renewInterval = Math.max(1, Math.floor(input.leaseDurationMs));
      const [lease] = await tx.update(leases).set({
        expiresAt: sql`clock_timestamp() + make_interval(secs => ${renewInterval}::double precision / 1000)`,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(leases.organizationId, input.organizationId),
        eq(leases.companyId, input.companyId),
        eq(leases.jobId, input.jobId),
        eq(leases.attemptId, input.attemptId),
        eq(leases.attemptNumber, input.attemptNumber),
        eq(leases.id, input.leaseId),
        eq(leases.workerId, input.workerId),
        eq(leases.targetId, input.targetId),
        eq(leases.targetAuthorityKey, input.targetAuthorityKey),
        eq(leases.targetGeneration, input.targetGeneration),
        eq(leases.profileHash, input.profileHash),
        eq(leases.providerConstraintHash, input.providerConstraintHash),
        eq(leases.fence, input.fence),
        eq(leases.status, "active"),
        gt(leases.expiresAt, sql`clock_timestamp()`),
      )).returning();
      if (!lease || !lease.expiresAt) throw new JobFenceError("stale_fence");
      // JOB-006 + JOB-015 — surface the lease's queued, un-ACKed control commands to
      // the worker through the frozen renew response. ONE read now serves both halves.
      //
      // JOB-015: this used to be an inline `SELECT reason … WHERE command_kind IN
      // ('cancel','graceful_stop') … LIMIT 1` whose result was collapsed to a boolean,
      // sitting beside a hardcoded `extensions: []`. The complete read already existed
      // as `listPendingControlCommands` — same table, same `ack_status IS NULL` filter,
      // same `ORDER BY command_seq` — with ZERO production callers and a docstring
      // asserting that "the poll/renew path surfaces" it, which it did not (E3-F035).
      // Sourcing the renewal from that method is what closes the finding: the method
      // ACQUIRES A CALLER rather than having its prose corrected.
      //
      // The `cancelRequested` boolean is DERIVED from the same list and is unchanged in
      // value: the first un-ACKed cancel/graceful_stop in sequence order is exactly what
      // the narrower query returned. It stays forever (D2) — it is the only signal a
      // worker predating the extension understands, so an adopting worker receives
      // cancel/graceful_stop TWICE and the extension is authoritative when understood.
      const pendingControls = await repository.listPendingControlCommands({
        organizationId: input.organizationId,
        leaseId: input.leaseId,
      });
      const pendingCancel = pendingControls.find(
        (command) => command.commandKind === "cancel" || command.commandKind === "graceful_stop",
      ) ?? null;
      // The exact renewed response body — stored in the receipt AND returned, so a
      // lost-response replay reproduces this exact renewal and cannot extend twice.
      const body: Record<string, unknown> = {
        protocolVersion: 1,
        workerId: input.workerId,
        jobId: input.jobId,
        attempt: input.attemptNumber,
        leaseId: input.leaseId,
        fenceToken: input.fence,
        expiresAt: lease.expiresAt.toISOString(),
        cancelRequested: Boolean(pendingCancel),
        cancelReason: pendingCancel?.reason ?? null,
        // JOB-015 — was `extensions: []`, hardcoded. The projector NEVER omits the
        // extension when something is pending: an omitted extension is byte-identical
        // to `[]`, so omission cannot be distinguished from "nothing queued" and would
        // re-commit this ticket's own defect. With nothing pending it returns `[]`
        // unchanged, which is the positive control that the change is inert.
        extensions: input.projectControlExtensions([], pendingControls),
      };
      await tx.insert(workerOperationReceipts).values({
        organizationId: input.organizationId,
        companyId: input.companyId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        leaseId: input.leaseId,
        operation: "lease_renew",
        workerId: input.workerId,
        targetId: input.targetId,
        targetAuthorityKey: input.targetAuthorityKey,
        targetGeneration: input.targetGeneration,
        profileHash: input.profileHash,
        idempotencyKey: input.idempotencyKey,
        semanticDigest: input.semanticDigest,
        outcome: body,
        expiresAt: lease.expiresAt,
        createdAt: sql`clock_timestamp()`,
      });
      return { lease, body };
    },

    // ---- JOB-004 closed governed-mutator surface ---------------------------
    // Every method below gates on `guardActiveFence` BEFORE touching (or reading) a
    // governed row. The four with a kernel table do a thin real mutation; the three
    // whose storage is not yet built are stubbed but STILL gated.
    async acceptEvent(input) {
      // Fence FIRST (throws stale_fence / attempt_terminal), then durable append.
      // The ingest service maps a thrown JobFenceError into the cumulative ACK
      // (stale_fence / terminal); this method only returns accepted/gap/hash.
      const { lease, attempt } = await guardActiveFence(input);
      if (!input.batch) return { leaseId: lease.id, attemptId: attempt.id, guarded: true };
      const events = input.batch.events;
      const guarded = { leaseId: lease.id, attemptId: attempt.id, guarded: true as const };
      // SVC-003 — collected across the new tail and returned so a refused projection is
      // OBSERVABLE. A projection that silently declined to write would be indistinguishable
      // from one that was never attempted, which is how a dead arming path stays invisible.
      const serviceProjections: { eventId: string; result: ServiceProjectionOutcome }[] = [];

      // Prior accepted state for THIS attempt, read under the guard's attempt lock
      // (no concurrent appender can interleave: guardActiveFence holds FOR UPDATE).
      // Stored sequences are always a contiguous 1..N (we never leave a gap), so the
      // cumulative acceptedThroughSeq is simply MAX(sequence).
      const priorRows = await tx.select({
        seq: jobEvents.sequence,
        eventId: jobEvents.eventId,
        digest: jobEvents.eventDigest,
      }).from(jobEvents).where(and(
        eq(jobEvents.organizationId, input.organizationId),
        eq(jobEvents.attemptId, input.attemptId),
      ));
      const acceptedThroughSeq = priorRows.reduce((max, row) => Math.max(max, row.seq), 0);
      const storedBySeq = new Map(priorRows.map((row) => [row.seq, row]));

      // (1) Per-event digest integrity: a supplied digest disagreeing with the
      // server recomputation is hash_mismatch, before any persistence.
      for (const event of events) {
        if (event.suppliedDigest !== event.recomputedDigest) {
          return { ...guarded, ingest: { status: "hash_mismatch", acceptedThroughSeq, rejectedEventId: event.eventId } };
        }
      }

      // (2) Gap: the batch head is beyond the next contiguous sequence.
      const firstSeq = events[0]!.sequence;
      if (firstSeq > acceptedThroughSeq + 1) {
        return { ...guarded, ingest: { status: "gap", acceptedThroughSeq } };
      }

      // (3) Replay-region integrity: any event overlapping an already-accepted
      // sequence must match the stored id + digest exactly, else hash_mismatch.
      for (const event of events) {
        if (event.sequence > acceptedThroughSeq) break; // events are contiguous ascending
        const stored = storedBySeq.get(event.sequence);
        if (!stored || stored.eventId !== event.eventId || stored.digest !== event.recomputedDigest) {
          return { ...guarded, ingest: { status: "hash_mismatch", acceptedThroughSeq, rejectedEventId: event.eventId } };
        }
      }

      // (4) New tail (seq > acceptedThroughSeq): contiguous by batch validation and
      // starting exactly at acceptedThroughSeq+1. Append idempotently, then project.
      const newEvents = events.filter((event) => event.sequence > acceptedThroughSeq);
      if (newEvents.length > 0) {
        // Reject a REUSED eventId in the new tail BEFORE any write. The (org,event_id)
        // unique is org-wide, and the guard's FOR UPDATE lock guarantees a genuine new
        // event never pre-exists (a legitimate crash-replay lands in the replay region
        // at seq <= acceptedThroughSeq, handled above) — so any existing id here is
        // reuse. An untargeted ON CONFLICT DO NOTHING would silently drop the row while
        // the projection loop + cumulative ACK still advanced, wedging the stream on a
        // phantom sequence; instead fail the whole batch as hash_mismatch with no write.
        const existingTail = await tx.select({ eventId: jobEvents.eventId }).from(jobEvents).where(and(
          eq(jobEvents.organizationId, input.organizationId),
          inArray(jobEvents.eventId, newEvents.map((event) => event.eventId)),
        ));
        if (existingTail.length > 0) {
          return { ...guarded, ingest: { status: "hash_mismatch", acceptedThroughSeq, rejectedEventId: existingTail[0]!.eventId } };
        }
        await tx.insert(jobEvents).values(newEvents.map((event) => ({
          organizationId: input.organizationId,
          companyId: input.companyId,
          jobId: input.jobId,
          attemptId: input.attemptId,
          attemptNumber: input.attemptNumber,
          leaseId: input.leaseId,
          eventId: event.eventId,
          sequence: event.sequence,
          eventType: event.eventType,
          fenceToken: event.fenceToken,
          eventDigest: event.recomputedDigest,
          event: event.payload,
          occurredAt: event.occurredAt,
        })));
        for (const event of newEvents) {
          if (event.eventType === "attempt_started") {
            await applyProjectionForFence(input, {
              projectionKind: "attempt_started",
              sourceIdentity: event.eventId,
              sourceDigest: event.recomputedDigest,
              targetAggregateId: input.attemptId,
              transition: { kind: "attempt_started" },
            });
          } else if (event.eventType === "terminal" && event.terminalStatus) {
            await applyProjectionForFence(input, {
              projectionKind: "attempt_terminal",
              sourceIdentity: event.eventId,
              sourceDigest: event.recomputedDigest,
              targetAggregateId: input.attemptId,
              transition: { kind: "attempt_terminal", terminalStatus: event.terminalStatus },
            });
          }
          // SVC-003 — the service-instance projection, applied AFTER the attempt projection
          // for the same event. Order is load-bearing for `attempt_started`, which carries
          // BOTH: the attempt must be `running` before the instance is called `leased`,
          // because the instance's status is a claim about a run the attempt row owns.
          if (event.serviceProjection) {
            serviceProjections.push({
              eventId: event.eventId,
              result: await applyServiceProjectionForFence(
                input,
                event.serviceProjection,
                event.eventId,
                event.recomputedDigest,
              ),
            });
          }
        }
      }
      const newAcceptedThroughSeq = newEvents.length > 0
        ? events[events.length - 1]!.sequence
        : acceptedThroughSeq;
      return {
        ...guarded,
        ingest: { status: "accepted", acceptedThroughSeq: newAcceptedThroughSeq },
        serviceProjections,
      };
    },

    async authorizeArtifactCommit(input) {
      await guardActiveFence(input);
      const [row] = await tx.insert(jobArtifacts).values({
        organizationId: input.organizationId,
        jobId: input.jobId,
        identifier: input.identifier,
      }).returning();
      return row!;
    },

    async recordArtifactGrantIntent(input) {
      await guardActiveFence(input);
      // Idempotent on the `status='granted'` partial-unique natural key
      // (organization_id, job_id, attempt, identifier), disjoint from the committed and
      // quarantined keys — so a granted, a committed and a quarantined row for one
      // natural key coexist and none collide-updates another.
      const inserted = await tx.insert(jobArtifacts).values({
        organizationId: input.organizationId,
        jobId: input.jobId,
        identifier: input.identifier,
        objectKey: input.objectKey,
        // The digest and size the grant was minted AGAINST, not observed bytes. Commit
        // re-checks the store-observed values, so a drift between grant and upload
        // fails closed there rather than being trusted from here.
        sha256: input.expectedSha256,
        sizeBytes: input.maxBytes,
        attempt: input.attemptNumber,
        leaseId: input.leaseId,
        fenceToken: input.fence,
        status: "granted",
        expiresAt: input.expiresAt,
      }).onConflictDoNothing({
        target: [jobArtifacts.organizationId, jobArtifacts.jobId, jobArtifacts.attempt, jobArtifacts.identifier],
        where: sql`status = 'granted'`,
      }).returning();
      if (inserted[0]) return inserted[0];

      // Conflict → a grant was already minted for this artifact (replay). Return the
      // existing intent unchanged: re-minting must not extend the sweep deadline, or a
      // caller could keep an orphan alive indefinitely by asking again.
      const [existing] = await tx.select().from(jobArtifacts).where(and(
        eq(jobArtifacts.organizationId, input.organizationId),
        eq(jobArtifacts.jobId, input.jobId),
        eq(jobArtifacts.attempt, input.attemptNumber),
        eq(jobArtifacts.identifier, input.identifier),
        eq(jobArtifacts.status, "granted"),
      )).limit(1);
      return existing!;
    },

    async commitArtifactVersion(input) {
      // Fence FIRST: a stale/terminal/revoked fence throws JobFenceError here,
      // BEFORE any verification — so `stale_fence` always precedes hash/size/prefix.
      await guardActiveFence(input);
      // Verification (fence is active). Order is stable: prefix → tenant → size → sha.
      if (!input.prefixValid) throw new ArtifactCommitRejection("wrong_prefix");
      if (!input.tenantValid) throw new ArtifactCommitRejection("tenant_mismatch");
      if (input.declaredSizeBytes !== input.actualSizeBytes) throw new ArtifactCommitRejection("size_mismatch");
      if (input.declaredSha256 !== input.actualSha256) throw new ArtifactCommitRejection("hash_mismatch");

      // Best-effort per-(org,job) ordinal, computed under the held fence lock. Not a
      // DB uniqueness constraint (concurrent attempts of one job may share a number).
      const [{ next } = { next: 1 }] = await tx
        .select({ next: sql<number>`COALESCE(MAX(${jobArtifacts.versionNumber}), 0) + 1` })
        .from(jobArtifacts)
        .where(and(
          eq(jobArtifacts.organizationId, input.organizationId),
          eq(jobArtifacts.jobId, input.jobId),
          eq(jobArtifacts.status, "committed"),
        ));

      // Idempotent committed insert on the partial-unique natural key
      // (organization_id, job_id, attempt, identifier) WHERE status='committed'.
      const inserted = await tx.insert(jobArtifacts).values({
        organizationId: input.organizationId,
        jobId: input.jobId,
        identifier: input.identifier,
        objectKey: input.objectKey,
        sha256: input.actualSha256,
        sizeBytes: input.actualSizeBytes,
        contentType: input.contentType,
        kind: input.kind,
        sensitivity: input.sensitivity,
        retention: input.retention,
        attempt: input.attemptNumber,
        leaseId: input.leaseId,
        fenceToken: input.fence,
        versionNumber: Number(next),
        status: "committed",
        committedAt: sql`clock_timestamp()`,
      }).onConflictDoNothing({
        target: [jobArtifacts.organizationId, jobArtifacts.jobId, jobArtifacts.attempt, jobArtifacts.identifier],
        where: sql`status = 'committed'`,
      }).returning();
      // `replayed: false` — THIS transaction wrote the row, so its retention,
      // object key and hashes are the ones this call decided. DE-11's retention
      // audit keys on exactly this.
      if (inserted[0]) return { ...inserted[0], replayed: false };

      // Conflict → the artifact was already committed (idempotent replay): return the
      // existing committed row unchanged (same result, no second version).
      const [existing] = await tx.select().from(jobArtifacts).where(and(
        eq(jobArtifacts.organizationId, input.organizationId),
        eq(jobArtifacts.jobId, input.jobId),
        eq(jobArtifacts.attempt, input.attemptNumber),
        eq(jobArtifacts.identifier, input.identifier),
        eq(jobArtifacts.status, "committed"),
      )).limit(1);
      if (!existing) throw new ArtifactCommitRejection("tenant_mismatch");
      // `replayed: true` — the row predates this call. Nothing here decided its
      // retention, so nothing here may audit one.
      return { ...existing, replayed: true };
    },

    async recordPatchApplyState(input) {
      // Fence FIRST: a stale/terminal/revoked fence throws JobFenceError here,
      // BEFORE any patch-row read — so `stale_fence` always precedes the apply
      // decision, and no content is probed against a dead fence.
      await guardActiveFence(input);

      // Load the target committed workspace_patch row under the held fence lock.
      const [target] = await tx.select().from(jobArtifacts).where(and(
        eq(jobArtifacts.organizationId, input.organizationId),
        eq(jobArtifacts.jobId, input.jobId),
        eq(jobArtifacts.attempt, input.attemptNumber),
        eq(jobArtifacts.identifier, input.identifier),
        eq(jobArtifacts.kind, "workspace_patch"),
        eq(jobArtifacts.status, "committed"),
      )).limit(1);
      if (!target) throw new PatchApplyRejection("patch_not_committed");
      // Bind the parsed base/result digests to the immutable committed object: the
      // presented object key MUST equal the committed row's key.
      if (target.objectKey !== input.patchObjectKey) throw new PatchApplyRejection("object_key_mismatch");

      // Idempotent no-op: an already-applied patch returns `applied` unchanged.
      if (target.applyStatus === "applied") {
        return {
          applyStatus: "applied",
          resolvedBaseManifestHash: target.baseManifestHash,
          resultManifestHash: target.resultManifestHash ?? input.patchResultManifestHash,
          alreadyApplied: true,
        };
      }
      // Sticky quarantine: a conflict-quarantined patch NEVER auto-flips to applied
      // on re-invocation — "mismatched base never auto-applies" means it requires an
      // explicit review/re-submission, not a silent re-decision if the accepted base
      // later happens to coincide with its declared base.
      if (target.applyStatus === "conflict_quarantined") {
        return {
          applyStatus: "conflict_quarantined",
          resolvedBaseManifestHash: null,
          resultManifestHash: target.resultManifestHash ?? input.patchResultManifestHash,
          alreadyApplied: false,
        };
      }

      // Resolve the job's currently-accepted base manifest hash (D3): the
      // result_manifest_hash of the most-recent OTHER applied workspace_patch, else
      // the committed workspace_snapshot's sha256 (== manifestHash by the canonical
      // upload convention). Job-scoped (the base chain spans attempts).
      const [appliedBase] = await tx
        .select({ hash: jobArtifacts.resultManifestHash })
        .from(jobArtifacts)
        .where(and(
          eq(jobArtifacts.organizationId, input.organizationId),
          eq(jobArtifacts.jobId, input.jobId),
          eq(jobArtifacts.kind, "workspace_patch"),
          eq(jobArtifacts.applyStatus, "applied"),
          ne(jobArtifacts.identifier, input.identifier),
        ))
        .orderBy(desc(jobArtifacts.committedAt), desc(jobArtifacts.versionNumber))
        .limit(1);

      // `resolvedBaseManifestHash` is the INFORMATIVE current accepted base surfaced on
      // a quarantine (latest applied patch result, else the most-recent committed
      // snapshot). The apply DECISION is computed separately: in the applied-chain it
      // is equality with that head; at bootstrap it is EXISTENCE of the DECLARED base
      // among the job's committed snapshots — a job may commit >1 snapshot (a retry
      // re-captures a base), so a "most-recent snapshot" decision would wrongly
      // over-reject a clean apply whose base is an earlier committed snapshot.
      let resolvedBaseManifestHash: string | null = appliedBase?.hash ?? null;
      let applyMatch = resolvedBaseManifestHash !== null && input.patchBaseManifestHash === resolvedBaseManifestHash;
      if (appliedBase?.hash == null) {
        const [mostRecentSnapshot] = await tx
          .select({ hash: jobArtifacts.sha256 })
          .from(jobArtifacts)
          .where(and(
            eq(jobArtifacts.organizationId, input.organizationId),
            eq(jobArtifacts.jobId, input.jobId),
            eq(jobArtifacts.kind, "workspace_snapshot"),
            eq(jobArtifacts.status, "committed"),
          ))
          .orderBy(desc(jobArtifacts.committedAt), desc(jobArtifacts.versionNumber))
          .limit(1);
        resolvedBaseManifestHash = mostRecentSnapshot?.hash ?? null;
        const [declaredSnapshot] = await tx
          .select({ hash: jobArtifacts.sha256 })
          .from(jobArtifacts)
          .where(and(
            eq(jobArtifacts.organizationId, input.organizationId),
            eq(jobArtifacts.jobId, input.jobId),
            eq(jobArtifacts.kind, "workspace_snapshot"),
            eq(jobArtifacts.status, "committed"),
            eq(jobArtifacts.sha256, input.patchBaseManifestHash),
          ))
          .limit(1);
        applyMatch = declaredSnapshot != null;
      }

      // decideApply: a matched base applies; a mismatched (or absent) base is
      // conflict-quarantined and NEVER auto-applies.
      const applyStatus: "applied" | "conflict_quarantined" = applyMatch ? "applied" : "conflict_quarantined";

      await tx.update(jobArtifacts).set({
        baseManifestHash: input.patchBaseManifestHash,
        resultManifestHash: input.patchResultManifestHash,
        applyStatus,
        updatedAt: sql`clock_timestamp()`,
      }).where(eq(jobArtifacts.id, target.id));

      return {
        applyStatus,
        resolvedBaseManifestHash,
        resultManifestHash: input.patchResultManifestHash,
        alreadyApplied: false,
      };
    },

    async readSecretHandle(input) {
      // A secret-handle READ is a governed surface too: a stale fence must not read.
      await guardActiveFence(input);
      const [row] = await tx.select().from(jobSecretHandles).where(and(
        eq(jobSecretHandles.organizationId, input.organizationId),
        eq(jobSecretHandles.jobId, input.jobId),
        eq(jobSecretHandles.handle, input.handle),
      )).limit(1);
      return row ?? null;
    },

    async loadAgentAdapterBinding(input) {
      const [row] = await tx
        .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .limit(1);
      return row ?? null;
    },

    async insertExecutionSecretHandle(input) {
      // Idempotent per (organization, job, ref_kind, ref_id) over ACTIVE rows. A
      // placement replay must not mint a second handle for the same reference: the
      // envelope would then carry two handles for one env var, and the frozen
      // duplicate-handle check only catches a repeated handle ID, not a repeated ref.
      const [existing] = await tx
        .select({ handle: jobSecretHandles.handle })
        .from(jobSecretHandles)
        .where(and(
          eq(jobSecretHandles.organizationId, input.organizationId),
          eq(jobSecretHandles.jobId, input.jobId),
          eq(jobSecretHandles.refKind, input.refKind),
          eq(jobSecretHandles.refId, input.refId),
          eq(jobSecretHandles.status, "active"),
        ))
        .limit(1);
      if (existing) return { handle: existing.handle, minted: false };

      await tx.insert(jobSecretHandles).values({
        organizationId: input.organizationId,
        jobId: input.jobId,
        handle: input.handle,
        refKind: input.refKind,
        refId: input.refId,
        materialization: input.materialization,
        materializationTarget: input.envTarget,
        refVersion: input.refVersion,
        usePolicy: input.usePolicy,
        // A `sandbox_local_only` handle may NEVER bind a network destination — the
        // resolver re-checks this, and minting one would be the coercion DAT-004's
        // own review already had to fix once.
        destination: null,
        boundTargetGeneration: input.boundTargetGeneration,
        ownerPrincipalKind: input.ownerPrincipalKind,
        ownerPrincipalId: input.ownerPrincipalId,
        status: "active",
        resolveCount: 0,
      });
      return { handle: input.handle, minted: true };
    },

    async listActiveExecutionSecretHandles(input) {
      return tx
        .select({
          handle: jobSecretHandles.handle,
          materialization: jobSecretHandles.materialization,
          materializationTarget: jobSecretHandles.materializationTarget,
          usePolicy: jobSecretHandles.usePolicy,
        })
        .from(jobSecretHandles)
        .where(and(
          eq(jobSecretHandles.organizationId, input.organizationId),
          eq(jobSecretHandles.jobId, input.jobId),
          // `status = 'active'` is the WHOLE liveness predicate, and the same one
          // `authorizeSecretResolve` denies on (job-fence.ts:293). The former
          // `isNull(revokedAt)` conjunct was REMOVED by the DE-07 ruling (2026-09-09):
          // it had no writer tree-wide, so ANDing it here could never subtract a row
          // that `status` had not already admitted. The COLUMN itself is still declared
          // (see packages/db/src/schema/job_secret_handles.ts) — vestigial and unread,
          // held for one release so a binary rollback cannot land on a schema missing
          // it. This removal is the EXPAND step; the DROP is E0-F017.
          eq(jobSecretHandles.status, "active"),
        ))
        .orderBy(asc(jobSecretHandles.createdAt), asc(jobSecretHandles.handle));
    },

    async resolveExecutionSecret(input) {
      // Fence FIRST: a stale/terminal/revoked fence throws JobFenceError here, BEFORE
      // any handle row is read or any owner/membership/broker access — so `stale_fence`/
      // `target_revoked`/`attempt_terminal` always precede the resolve decision (the
      // DAT-002 no-early-probe + fence-first precedence). The guard proves the LIVE
      // target generation (equal to the lease's stored one) and holds the lease lock.
      // Every tenant field (org/company/job/attempt/target-generation) is proven by the
      // guard's locking identity match, so `input.*` are authoritative below.
      await guardActiveFence(input);

      // Load the WIDENED handle row for (org, job, handle). company + attempt are proven
      // solely by the fence guard (matches readSecretHandle — do not loosen).
      const [row] = await tx.select().from(jobSecretHandles).where(and(
        eq(jobSecretHandles.organizationId, input.organizationId),
        eq(jobSecretHandles.jobId, input.jobId),
        eq(jobSecretHandles.handle, input.handle),
      )).limit(1);
      // A missing handle is a coarse, NON-DISCLOSING refusal (never reveals whether a
      // foreign handle exists) — mapped to `malformed` at the wire, like every reject.
      if (!row) throw new SecretResolveRejection("unknown_ref_kind");

      // Re-derive the dispatching owner from the LOCKED `jobs` row — the ActiveFenceRequest
      // carries NO owner. Scoped to the fence's org + the LOCKED lease's company (the
      // company↔org seam: job_secret_handles is org-scoped, provider_credentials is
      // company-scoped; the job binds them, resolved here, never trusted from the wire).
      const [jobRow] = await tx
        .select({
          executorPrincipalKind: jobs.executorPrincipalKind,
          executorPrincipalId: jobs.executorPrincipalId,
        })
        .from(jobs)
        .where(and(
          eq(jobs.organizationId, input.organizationId),
          eq(jobs.companyId, input.companyId),
          eq(jobs.id, input.jobId),
        ))
        .limit(1);
      // The fence guard already proved the lease's (org, company, job) identity, so the
      // job row must exist; a missing row is a non-disclosing refusal, never an oracle.
      if (!jobRow) throw new SecretResolveRejection("unknown_ref_kind");

      // For an owner-bound handle, re-check the owner's ACTIVE company membership in the
      // SAME tx (membership loss DENIES — re-check-at-resolve, invariant #5). `null` when
      // the handle is not owner-bound (no membership query needed).
      const ownerBound = !!(row.ownerPrincipalKind && row.ownerPrincipalId);
      let ownerMembershipActive: boolean | null = null;
      if (ownerBound) {
        const [membership] = await tx
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(and(
            eq(companyMemberships.companyId, input.companyId),
            eq(companyMemberships.principalType, row.ownerPrincipalKind!),
            eq(companyMemberships.principalId, row.ownerPrincipalId!),
            eq(companyMemberships.status, "active"),
          ))
          .limit(1);
        ownerMembershipActive = membership != null;
      }

      // DSK-001 Lane B (D12/3 + D12/4) — the device credential, read in THIS transaction,
      // as a sibling of the owner-membership re-check above.
      //
      // Only for `device_local`: every other ref_kind performs no query at all, so this
      // costs nothing on the paths that do not need it. The lookup is scoped by the
      // LOCKED lease's company — `provider_credentials` is company-scoped while
      // `job_secret_handles` is org-scoped, and the job is what binds them — so a handle
      // can never reach across companies by naming a foreign credential id.
      //
      // The read is NOT locked, deliberately: neither `handle.status` nor
      // `ownerMembershipActive` is either, and for all three revocation takes effect on
      // the NEXT resolve. Taking `FOR SHARE` on a company-scoped credentials table from
      // inside a transaction already holding the lease/attempt locks would add a new
      // lock-ordering surface for a strictly narrower window than the mechanism already
      // tolerates. Recorded as a decision (Lane B design D-B5), not an oversight.
      let deviceCredential: {
        state: string | null;
        ownerUserId: string | null;
        executionTargetId: string | null;
      } | null = null;
      if (row.refKind === "device_local" && row.refId) {
        const [credential] = await tx
          .select({
            state: providerCredentials.state,
            ownerUserId: providerCredentials.ownerUserId,
            executionTargetId: providerCredentials.executionTargetId,
          })
          .from(providerCredentials)
          .where(and(
            eq(providerCredentials.id, row.refId),
            eq(providerCredentials.companyId, input.companyId),
          ))
          .limit(1);
        deviceCredential = credential ?? null;
      }

      // The PURE decision (D6): re-verify the materialization×use_policy invariant, the
      // sandbox-local-vs-network-destination invariant, the bound_target_generation pin
      // (D5) against the LIVE lease generation, revocation, and the owner binding.
      const decision = authorizeSecretResolve({
        handle: {
          status: row.status ?? "",
          refKind: row.refKind,
          refId: row.refId,
          materialization: row.materialization,
          usePolicy: row.usePolicy,
          destination: row.destination,
          boundTargetGeneration: row.boundTargetGeneration,
          ownerPrincipalKind: row.ownerPrincipalKind,
          ownerPrincipalId: row.ownerPrincipalId,
        },
        jobOwner: {
          executorPrincipalKind: jobRow.executorPrincipalKind,
          executorPrincipalId: jobRow.executorPrincipalId,
        },
        // The guard proved lease.targetGeneration === input.targetGeneration === the
        // LIVE execution_targets.device_generation (else target_revoked), so the
        // request's generation IS the live one (and is non-null typed).
        ownerMembershipActive,
        liveTargetGeneration: input.targetGeneration,
        // The device the job is actually placed on. `guardActiveFence` already proved
        // this is the LIVE target under lock, so it is authoritative here.
        liveTargetId: input.targetId,
        deviceCredential,
      });
      if (decision !== "admit") throw new SecretResolveRejection(decision);

      // Audit-as-columns (D4): record the authorized resolution in the SAME tx — NEVER a
      // value. resolve_count is a monotonic control-plane counter (COALESCE for the
      // additive-widen null seam); last_resolved_at is a fresh DB clock. DAT-005-D3:
      // when a governed egress resolve supplies the network-policy version, persist it in
      // the SAME audit UPDATE (`applied_policy_version`) — an unrecordable version fails
      // the tx and DENIES the egress (fail-closed). A non-egress resolve omits it and the
      // column is left unchanged.
      const auditSet: Record<string, unknown> = {
        lastResolvedAt: sql`clock_timestamp()`,
        resolveCount: sql`COALESCE(${jobSecretHandles.resolveCount}, 0) + 1`,
        updatedAt: sql`clock_timestamp()`,
      };
      if (input.appliedPolicyVersion !== undefined && input.appliedPolicyVersion !== null) {
        auditSet.appliedPolicyVersion = input.appliedPolicyVersion;
      }
      const [audited] = await tx.update(jobSecretHandles).set(auditSet)
        .where(eq(jobSecretHandles.id, row.id))
        .returning({ resolveCount: jobSecretHandles.resolveCount });

      // `authorizeSecretResolve` proved these enum/ref fields non-null + in-range.
      return {
        handleId: row.handle,
        refKind: row.refKind as SecretRefKind,
        refId: row.refId ?? "",
        refVersion: row.refVersion,
        materialization: row.materialization as "proxy" | "env" | "file",
        materializationTarget: row.materializationTarget,
        usePolicy: row.usePolicy as "fence_proxy" | "remote_server_fenced" | "sandbox_local_only",
        destination: row.destination,
        ownerPrincipalKind: row.ownerPrincipalKind,
        ownerPrincipalId: row.ownerPrincipalId,
        boundTargetGeneration: row.boundTargetGeneration,
        companyId: input.companyId,
        resolveCount: Number(audited?.resolveCount ?? 0),
      };
    },

    async completeAttempt(input) {
      const { attempt } = await guardActiveFence(input);
      // The guard proved the attempt is non-terminal and holds its row lock, so the
      // conditional update pins the exact locked status (no double-complete race).
      const [row] = await tx.update(jobAttempts).set({
        status: input.terminalStatus,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(jobAttempts.organizationId, input.organizationId),
        eq(jobAttempts.companyId, input.companyId),
        eq(jobAttempts.jobId, input.jobId),
        eq(jobAttempts.id, input.attemptId),
        eq(jobAttempts.status, attempt.status),
      )).returning();
      if (!row) throw new JobFenceError("attempt_terminal");
      // JOB-007: the attempt reached a terminal state — release its capacity slot.
      await releaseAttemptCapacitySlot({ organizationId: input.organizationId, attemptId: input.attemptId });
      return row;
    },

    async recordServiceHealth(input) {
      await guardActiveFence(input);
      // SVC-003 — the read is now UNDER the guard and UNDER a row lock, and the write goes
      // through the one shared writer, because this method and the event projection must not
      // be able to drift into two different ideas of a legal status move.
      const [current] = await tx.select({
        id: serviceInstances.id,
        status: serviceInstances.status,
      }).from(serviceInstances).where(and(
        eq(serviceInstances.organizationId, input.organizationId),
        eq(serviceInstances.id, input.serviceInstanceId),
      )).for("update").limit(1);
      if (!current) throw new Error("service_instance_not_found");
      if (current.status !== input.healthStatus) {
        await writeServiceInstanceStatus({
          organizationId: input.organizationId,
          serviceInstanceId: current.id,
          status: input.healthStatus,
          expectedFromStatus: current.status,
          // SVC-005a — THE FAIL-CLOSED AUTHOR, deliberately, even though this mutator runs
          // UNDER `guardActiveFence` and its caller is therefore the worker that holds the
          // lease and fence. `healthStatus` is a HEALTH status (`healthy`/`unhealthy`), not an
          // observation that a process is gone, so this path can never assert the one thing a
          // witness asserts — and today it writes no terminal status at all, so it stamps
          // nothing in practice. The author is supplied rather than defaulted because a
          // required parameter that some callers may omit is the drift this chokepoint exists
          // to prevent, and it is the UNCONFIRMED value so that if this path ever did reach a
          // terminal status it would stall a rollout rather than admit one.
          author: "worker_unconfirmed",
        });
      }
      const [row] = await tx.select().from(serviceInstances).where(and(
        eq(serviceInstances.organizationId, input.organizationId),
        eq(serviceInstances.id, input.serviceInstanceId),
      )).limit(1);
      if (!row) throw new Error("service_instance_not_found");
      return row;
    },

    async applyProjectionReceipt(input) {
      // Fence FIRST, then (when a projection is supplied) apply it idempotently.
      // A bare fence identity (JOB-004 back-compat) just proves the guarded seam.
      const { lease, attempt } = await guardActiveFence(input);
      if (input.projection) await applyProjectionForFence(input, input.projection);
      return { leaseId: lease.id, attemptId: attempt.id, guarded: true };
    },

    async readAcceptedThroughSeq(input) {
      const [row] = await tx.select({
        maxSeq: sql<number>`COALESCE(MAX(${jobEvents.sequence}), 0)`,
      }).from(jobEvents).where(and(
        eq(jobEvents.organizationId, input.organizationId),
        eq(jobEvents.attemptId, input.attemptId),
      ));
      return Number(row?.maxSeq ?? 0);
    },

    async ackControlCommand(input) {
      // Fence FIRST (throws stale_fence / attempt_terminal). A bare-fence call (no
      // `ack`) is the JOB-004 back-compat proof that the guarded seam admitted.
      const { lease, attempt } = await guardActiveFence(input);
      if (!input.ack) return { leaseId: lease.id, attemptId: attempt.id, guarded: true };
      // Record the worker's echoed ACK idempotently. First terminal ACK wins: an
      // 'accepted' may progress to any status, but a stored terminal
      // (completed/rejected/stale) is never overwritten, and a replay of the same
      // status is a no-op re-write.
      const [row] = await tx.update(jobControlCommands).set({
        ackStatus: input.ack.status,
        ackObservedAt: input.ack.observedAt,
        ackDetail: input.ack.detail,
        ackedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(jobControlCommands.organizationId, input.organizationId),
        eq(jobControlCommands.leaseId, input.leaseId),
        eq(jobControlCommands.commandId, input.ack.commandId),
        // ★★★ JOB-015 — the echoed sequence is now part of the match. An ACK that
        // names a real command id with the WRONG sequence matches zero rows, so
        // `applied` is false and `ack_status` stays NULL: the command remains pending
        // and is redelivered on the next renewal. Before this clause the sequence was
        // read off the frozen schema and thrown away, so a worker could suppress
        // redelivery of a command it had not actually identified.
        eq(jobControlCommands.commandSeq, input.ack.commandSeq),
        or(
          isNull(jobControlCommands.ackStatus),
          eq(jobControlCommands.ackStatus, "accepted"),
          eq(jobControlCommands.ackStatus, input.ack.status),
        ),
      )).returning({ id: jobControlCommands.id });
      return {
        leaseId: lease.id,
        attemptId: attempt.id,
        guarded: true,
        ackOutcome: { applied: Boolean(row), status: input.ack.status },
      };
    },

    async claimReadyOutbox(input) {
      const boundedLimit = Math.max(1, Math.min(128, Math.floor(input.limit ?? 32)));
      const staleRows = await tx.select({ id: jobOutbox.id }).from(jobOutbox)
        .where(and(
          eq(jobOutbox.status, "claimed"),
          lte(jobOutbox.claimedAt, input.staleBefore),
        ))
        .orderBy(asc(jobOutbox.claimedAt), asc(jobOutbox.id))
        .limit(boundedLimit)
        .for("update", { skipLocked: true });
      if (staleRows.length > 0) {
        await tx.update(jobOutbox).set({
          status: "retry",
          claimToken: null,
          claimedAt: null,
          availableAt: input.now,
          lastErrorCode: "claim_visibility_timeout",
          updatedAt: input.now,
        }).where(inArray(jobOutbox.id, staleRows.map((row) => row.id)));
      }

      const ready = await tx.select({
        id: jobOutbox.id,
        organizationId: jobOutbox.organizationId,
        attemptId: jobOutbox.attemptId,
        targetId: jobAttempts.placementTargetId,
      }).from(jobOutbox)
        .innerJoin(jobAttempts, and(
          eq(jobAttempts.organizationId, jobOutbox.organizationId),
          eq(jobAttempts.companyId, jobOutbox.companyId),
          eq(jobAttempts.jobId, jobOutbox.jobId),
          eq(jobAttempts.id, jobOutbox.attemptId),
        ))
        .innerJoin(jobs, and(
          eq(jobs.organizationId, jobAttempts.organizationId),
          eq(jobs.companyId, jobAttempts.companyId),
          eq(jobs.id, jobAttempts.jobId),
        ))
        .where(and(
          eq(jobOutbox.kind, "attempt_ready"),
          or(eq(jobOutbox.status, "pending"), eq(jobOutbox.status, "retry")),
          lte(jobOutbox.availableAt, sql`statement_timestamp()`),
          eq(jobAttempts.status, "pending"),
          eq(jobAttempts.placementDisposition, "selected"),
          eq(jobAttempts.placementMode, "active"),
          eq(jobAttempts.placementLeaseEligible, true),
          isNotNull(jobAttempts.placementTargetId),
          eq(jobs.status, "queued"),
          lte(jobs.availableAt, sql`statement_timestamp()`),
        )).orderBy(asc(jobOutbox.availableAt), asc(jobOutbox.createdAt), asc(jobOutbox.id))
        .limit(boundedLimit)
        .for("update", { of: [jobOutbox, jobAttempts], skipLocked: true });
      if (ready.length === 0) return [];
      const claimed = await tx.update(jobOutbox).set({
        status: "claimed",
        claimToken: input.claimToken,
        claimedAt: input.now,
        attemptCount: sql`${jobOutbox.attemptCount} + 1`,
        lastErrorCode: null,
        updatedAt: input.now,
      }).where(and(
        inArray(jobOutbox.id, ready.map((row) => row.id)),
        or(eq(jobOutbox.status, "pending"), eq(jobOutbox.status, "retry")),
      )).returning({
        id: jobOutbox.id,
        organizationId: jobOutbox.organizationId,
        attemptId: jobOutbox.attemptId,
      });
      const targetByOutboxId = new Map(ready.map((row) => [row.id, row.targetId!]));
      return claimed.map((row) => ({
        ...row,
        targetId: targetByOutboxId.get(row.id)!,
      }));
    },

    async deliverReadyOutbox(input) {
      if (input.ids.length === 0) return 0;
      const delivered = await tx.update(jobOutbox).set({
        status: "delivered",
        claimToken: null,
        claimedAt: null,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        inArray(jobOutbox.id, input.ids),
        eq(jobOutbox.status, "claimed"),
        eq(jobOutbox.claimToken, input.claimToken),
      )).returning({ id: jobOutbox.id });
      return delivered.length;
    },

    // ---- JOB-006 cancellation + reaper/reconciliation ----------------------
    async requestCancellation(input) {
      // GLOBAL lock order lease -> attempt -> job (the job is locked LAST) — identical to
      // the reaper (reapExpiredLeases: lease -> attempt -> job) and the worker
      // event-ingest/projection path (guardActiveFence locks lease+attempt FOR UPDATE;
      // applyProjectionForFence then UPDATEs the job). Locking the job FIRST here would
      // form a wait-for cycle and deadlock (40P01) with a concurrent reap or terminal-event
      // flush on the same job. Lock the one live lease FIRST (at most one offered/active per
      // job — leases_active_per_attempt_idx partial unique).
      const [liveLease] = await tx.select().from(leases).where(and(
        eq(leases.organizationId, input.organizationId),
        eq(leases.companyId, input.companyId),
        eq(leases.jobId, input.jobId),
        inArray(leases.status, ["offered", "active"]),
      )).orderBy(desc(leases.createdAt)).for("update").limit(1);

      // Then the attempt: the live lease's attempt if present, else the latest attempt.
      const [attempt] = liveLease
        ? await tx.select().from(jobAttempts).where(and(
          eq(jobAttempts.organizationId, input.organizationId),
          eq(jobAttempts.companyId, input.companyId),
          eq(jobAttempts.jobId, input.jobId),
          eq(jobAttempts.id, liveLease.attemptId),
        )).for("update").limit(1)
        : await tx.select().from(jobAttempts).where(and(
          eq(jobAttempts.organizationId, input.organizationId),
          eq(jobAttempts.companyId, input.companyId),
          eq(jobAttempts.jobId, input.jobId),
        )).orderBy(desc(jobAttempts.attemptNumber)).for("update").limit(1);

      // Finally the job (LAST).
      const [job] = await tx.select().from(jobs).where(and(
        eq(jobs.organizationId, input.organizationId),
        eq(jobs.companyId, input.companyId),
        eq(jobs.id, input.jobId),
      )).for("update").limit(1);
      if (!job) return { status: "not_found", command: null };
      if ((JOB_TERMINAL_STATUSES as readonly string[]).includes(job.status)) {
        return { status: "job_terminal", command: null };
      }

      const lease = liveLease;
      if (!lease || !attempt || !lease.workerId || !lease.attemptNumber) {
        // No fenced worker to drain: the reaper's expired-lease scan never reaches an
        // unleased attempt (a queued/pending job, or a retry N+1 still in backoff), and
        // claimReadyOutbox will not dispatch a cancel_requested job — so it would hang
        // forever in cancel_requested. Finalize the cancellation DIRECTLY (all-or-nothing,
        // notInArray-terminal so a concurrent winner is never overwritten) under the locks
        // we already hold.
        if (attempt) {
          await tx.update(jobAttempts).set({
            status: "cancelled",
            updatedAt: sql`clock_timestamp()`,
          }).where(and(
            eq(jobAttempts.organizationId, input.organizationId),
            eq(jobAttempts.companyId, input.companyId),
            eq(jobAttempts.jobId, input.jobId),
            eq(jobAttempts.id, attempt.id),
            notInArray(jobAttempts.status, [...TERMINAL_ATTEMPT_STATUSES]),
          ));
        }
        await tx.update(jobs).set({
          status: "cancelled",
          updatedAt: sql`clock_timestamp()`,
        }).where(and(
          eq(jobs.organizationId, input.organizationId),
          eq(jobs.companyId, input.companyId),
          eq(jobs.id, input.jobId),
          notInArray(jobs.status, [...JOB_TERMINAL_STATUSES]),
        ));
        // JOB-007: this directly-finalized attempt is terminal → release its slot.
        if (attempt) {
          await releaseAttemptCapacitySlot({ organizationId: input.organizationId, attemptId: attempt.id });
        }
        return { status: "cancelled", command: null };
      }

      // A fenced worker holds the lease: mark cancel_requested (conditional on non-terminal
      // → idempotent) and queue ONE cancel command; the worker ACKs + the reaper finalizes
      // when the lease expires or completes.
      await tx.update(jobs).set({
        status: "cancel_requested",
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(jobs.organizationId, input.organizationId),
        eq(jobs.companyId, input.companyId),
        eq(jobs.id, input.jobId),
        inArray(jobs.status, ["queued", "running", "cancel_requested"]),
      ));
      await tx.update(jobAttempts).set({
        status: "cancel_requested",
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(jobAttempts.organizationId, input.organizationId),
        eq(jobAttempts.companyId, input.companyId),
        eq(jobAttempts.jobId, input.jobId),
        eq(jobAttempts.id, attempt.id),
        inArray(jobAttempts.status, ["pending", "offered", "leased", "running", "cancel_requested"]),
      ));

      // Idempotent: one cancel command per lease. A prior cancel replays as-is.
      const [existing] = await tx.select().from(jobControlCommands).where(and(
        eq(jobControlCommands.organizationId, input.organizationId),
        eq(jobControlCommands.leaseId, lease.id),
        eq(jobControlCommands.commandKind, "cancel"),
      )).orderBy(asc(jobControlCommands.commandSeq)).limit(1);
      if (existing) return { status: "already_requested", command: toQueuedControlCommand(existing) };

      // Allocate the next monotonic per-lease sequence under the lease lock.
      const [{ maxSeq }] = await tx.select({
        maxSeq: sql<number>`COALESCE(MAX(${jobControlCommands.commandSeq}), 0)`,
      }).from(jobControlCommands).where(and(
        eq(jobControlCommands.organizationId, input.organizationId),
        eq(jobControlCommands.leaseId, lease.id),
      ));
      const commandSeq = Number(maxSeq) + 1;
      const commandBody: Record<string, unknown> = {
        protocolVersion: 1,
        audience: "control_channel",
        commandId: input.commandId,
        commandSeq,
        idempotencyKey: input.commandId,
        issuedAt: input.now.toISOString(),
        nonce: randomUUID(),
        organizationId: input.organizationId,
        companyId: input.companyId,
        workerId: lease.workerId,
        jobId: input.jobId,
        attempt: lease.attemptNumber,
        leaseId: lease.id,
        fenceToken: lease.fence,
        commandKind: "cancel",
        reason: input.reason,
        graceful: input.graceful,
      };
      const [inserted] = await tx.insert(jobControlCommands).values({
        organizationId: input.organizationId,
        companyId: input.companyId,
        jobId: input.jobId,
        attemptId: attempt.id,
        attemptNumber: lease.attemptNumber,
        leaseId: lease.id,
        commandId: input.commandId,
        commandSeq,
        commandKind: "cancel",
        fenceToken: lease.fence,
        reason: input.reason,
        graceful: input.graceful,
        command: commandBody,
      }).onConflictDoNothing({
        target: [
          jobControlCommands.organizationId,
          jobControlCommands.leaseId,
          jobControlCommands.commandId,
        ],
      }).returning();
      if (inserted) return { status: "queued", command: toQueuedControlCommand(inserted) };
      // Lost the (org, lease, command_id) race — re-read the winning row.
      const [row] = await tx.select().from(jobControlCommands).where(and(
        eq(jobControlCommands.organizationId, input.organizationId),
        eq(jobControlCommands.leaseId, lease.id),
        eq(jobControlCommands.commandId, input.commandId),
      )).limit(1);
      return { status: "already_requested", command: row ? toQueuedControlCommand(row) : null };
    },

    async listPendingControlCommands(input) {
      const rows = await tx.select().from(jobControlCommands).where(and(
        eq(jobControlCommands.organizationId, input.organizationId),
        eq(jobControlCommands.leaseId, input.leaseId),
        isNull(jobControlCommands.ackStatus),
      )).orderBy(asc(jobControlCommands.commandSeq));
      return rows.map(toQueuedControlCommand);
    },

    async allocateRetryAttempt(input) {
      return allocateRetry(input);
    },

    async reapExpiredLeases(input) {
      const bounded = Math.max(1, Math.min(128, Math.floor(input.limit)));
      const result: ReapExpiredLeasesResult = {
        scanned: 0, revoked: 0, retried: 0, deadLettered: 0, cancelled: 0, finalized: 0,
        terminalized: [],
      };
      const terminalAttempt = [...TERMINAL_ATTEMPT_STATUSES];

      // Claim a bounded batch of EXPIRED leases (offered past ack deadline, or any
      // offered/active past expiry). SKIP LOCKED so a concurrent tick/worker never
      // double-processes the same lease.
      const expired = await tx.select({
        id: leases.id,
        companyId: leases.companyId,
        jobId: leases.jobId,
        attemptId: leases.attemptId,
        attemptNumber: leases.attemptNumber,
      }).from(leases).where(and(
        eq(leases.organizationId, input.organizationId),
        inArray(leases.status, ["offered", "active"]),
        or(
          lte(leases.expiresAt, sql`clock_timestamp()`),
          and(eq(leases.status, "offered"), lte(leases.ackDeadline, sql`clock_timestamp()`)),
        ),
      )).orderBy(asc(leases.expiresAt), asc(leases.id))
        .limit(bounded)
        .for("update", { skipLocked: true });

      for (const lease of expired) {
        result.scanned += 1;
        if (!lease.companyId || !lease.jobId) continue;

        // Lock attempt THEN job (attempt→job order matches the worker projection
        // path, so the reaper never forms a lock cycle with a governed mutation).
        const [attempt] = await tx.select().from(jobAttempts).where(and(
          eq(jobAttempts.organizationId, input.organizationId),
          eq(jobAttempts.companyId, lease.companyId),
          eq(jobAttempts.jobId, lease.jobId),
          eq(jobAttempts.id, lease.attemptId),
        )).for("update").limit(1);
        if (!attempt) continue;
        const [job] = await tx.select().from(jobs).where(and(
          eq(jobs.organizationId, input.organizationId),
          eq(jobs.companyId, lease.companyId),
          eq(jobs.id, lease.jobId),
        )).for("update").limit(1);
        if (!job) continue;

        const cancelling = job.status === "cancel_requested";
        const succeeded = attempt.status === "succeeded";
        const newLeaseStatus = succeeded ? "released" : cancelling ? "revoked" : "expired";

        // PERMANENTLY revoke the fence (conditional → idempotent if another reaper
        // already converged this lease). A losing update handled the outcome.
        const [revoked] = await tx.update(leases).set({
          status: newLeaseStatus,
          releasedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        }).where(and(
          eq(leases.organizationId, input.organizationId),
          eq(leases.id, lease.id),
          inArray(leases.status, ["offered", "active"]),
        )).returning({ id: leases.id });
        if (!revoked) continue;
        result.revoked += 1;
        // DEP-009: capture whether this attempt HELD an Organization capacity slot
        // BEFORE the release flips it to 'released'. Only a genuinely-held slot is
        // transferred to the retry successor (below) — a never-claimed ('unclaimed')
        // attempt must not mint a counted slot on N+1.
        const reapedHeldCapacity = attempt.capacityClaimState === "held";
        // JOB-007: the reaped lease's attempt is terminal-bound → release its
        // Organization capacity slot (idempotent, exactly-once across reaper/cancel/
        // revocation/cost paths that may all race on the same attempt).
        await releaseAttemptCapacitySlot({ organizationId: input.organizationId, attemptId: attempt.id });

        const finalizeJob = async (status: "succeeded" | "cancelled") => {
          await tx.update(jobs).set({
            status,
            updatedAt: sql`clock_timestamp()`,
          }).where(and(
            eq(jobs.organizationId, input.organizationId),
            eq(jobs.companyId, lease.companyId!),
            eq(jobs.id, lease.jobId!),
            notInArray(jobs.status, [...JOB_TERMINAL_STATUSES]),
          ));
        };

        if (succeeded) {
          // Worker committed a winning terminal then vanished: finalize, never retry.
          await finalizeJob("succeeded");
          result.finalized += 1;
          result.terminalized.push({
            companyId: lease.companyId, jobId: lease.jobId, attemptId: attempt.id,
            terminalStatus: "succeeded",
          });
        } else if (attempt.status === "cancelled" || cancelling) {
          await tx.update(jobAttempts).set({
            status: "cancelled",
            updatedAt: sql`clock_timestamp()`,
          }).where(and(
            eq(jobAttempts.organizationId, input.organizationId),
            eq(jobAttempts.companyId, lease.companyId),
            eq(jobAttempts.jobId, lease.jobId),
            eq(jobAttempts.id, attempt.id),
            notInArray(jobAttempts.status, terminalAttempt),
          ));
          await finalizeJob("cancelled");
          result.cancelled += 1;
          result.terminalized.push({
            companyId: lease.companyId, jobId: lease.jobId, attemptId: attempt.id,
            terminalStatus: "cancelled",
          });
        } else {
          // Abandoned mid-flight (or a worker-reported failure): fail this attempt,
          // then retry under the job lock or dead-letter on exhaustion.
          await tx.update(jobAttempts).set({
            status: "expired",
            updatedAt: sql`clock_timestamp()`,
          }).where(and(
            eq(jobAttempts.organizationId, input.organizationId),
            eq(jobAttempts.companyId, lease.companyId),
            eq(jobAttempts.jobId, lease.jobId),
            eq(jobAttempts.id, attempt.id),
            notInArray(jobAttempts.status, terminalAttempt),
          ));
          if (attempt.attemptNumber < job.maxAttempts) {
            const alloc = await allocateRetry({
              organizationId: input.organizationId,
              companyId: lease.companyId,
              jobId: lease.jobId,
              reapedAttemptId: attempt.id,
              reapedAttemptNumber: attempt.attemptNumber,
              baseBackoffMs: input.baseBackoffMs,
              maxBackoffMs: input.maxBackoffMs,
              now: input.now,
              // DEP-009: transfer the released capacity slot to the successor so the
              // reap→retry boundary conserves org occupancy (release + re-claim commit
              // atomically in this one reaper txn under the org-capacity advisory lock).
              inheritCapacityHeld: reapedHeldCapacity,
            });
            // DELIBERATELY NOT listed in `terminalized`: the job runs again, so its run has no
            // terminal yet. Projecting one here would leave two executors.
            if (alloc.status === "created") result.retried += 1;
          } else {
            await tx.update(jobs).set({
              status: "dead_letter",
              deadLetterReason: "retry_exhausted",
              updatedAt: sql`clock_timestamp()`,
            }).where(and(
              eq(jobs.organizationId, input.organizationId),
              eq(jobs.companyId, lease.companyId),
              eq(jobs.id, lease.jobId),
              notInArray(jobs.status, [...JOB_TERMINAL_STATUSES]),
            ));
            result.deadLettered += 1;
            result.terminalized.push({
              companyId: lease.companyId, jobId: lease.jobId, attemptId: attempt.id,
              terminalStatus: "failed",
            });
          }
        }
      }
      return result;
    },

    async recordOrphanQuarantine(input) {
      // DEVICE-ONLY authority recheck (NO guardActiveFence — an orphan is a dead-fence
      // output; guarding would throw stale_fence and defeat the purpose). Mirror the
      // generation-cutoff test in guardActiveFence, but WITHOUT the lease/fence join:
      // read the CURRENT execution-target authority and refuse if the target is gone,
      // disabled, or its live device_generation no longer equals the presented one.
      // NEVER stale_fence — refusals are target_revoked.
      const [target] = await tx
        .select({
          deviceGeneration: executionTargets.deviceGeneration,
          status: executionTargets.status,
        })
        .from(executionTargets)
        .where(eq(executionTargets.id, input.targetId))
        .limit(1);
      if (
        !target
        || target.deviceGeneration === null
        || target.deviceGeneration !== input.deviceGeneration
        || target.status === "disabled"
      ) {
        throw new OrphanQuarantineRejection("target_revoked");
      }

      // The (org, job) must exist in THIS tenant (RLS-scoped). The composite
      // job_artifacts_org_job_fk would otherwise raise a raw FK error; pre-checking
      // keeps the refusal coarse + non-disclosing (a foreign/absent job reads the same
      // as missing → unknown_job → the service maps it to `malformed`).
      const [job] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(
          eq(jobs.organizationId, input.organizationId),
          eq(jobs.id, input.jobId),
        ))
        .limit(1);
      if (!job) throw new OrphanQuarantineRejection("unknown_job");

      // Bind the orphan to the caller's OWN target: the presented attempt must have been
      // PLACED on this device's target (jobAttempts.placementTargetId === the verified
      // device target). RLS is org-grain, but DAT-006 desktop/dedicated targets are
      // OWNER-scoped, so without this a fully-enrolled worker T_b could fabricate
      // dead-fence "orphan output" against ANOTHER owner's job/attempt in the same org.
      // A missing attempt or a foreign placement reads the SAME as an absent job →
      // coarse, non-disclosing unknown_job (the service maps it to `malformed`), never
      // revealing whether the foreign attempt exists.
      const [attempt] = await tx
        .select({ placementTargetId: jobAttempts.placementTargetId })
        .from(jobAttempts)
        .where(and(
          eq(jobAttempts.organizationId, input.organizationId),
          eq(jobAttempts.jobId, input.jobId),
          eq(jobAttempts.attemptNumber, input.attemptNumber),
        ))
        .limit(1);
      if (!attempt || attempt.placementTargetId !== input.targetId) {
        throw new OrphanQuarantineRejection("unknown_job");
      }

      // Idempotent orphan insert on the quarantined partial-unique natural key
      // (org, job, attempt, identifier) WHERE status='quarantined'. This index is
      // DISJOINT from the committed one, so an orphan NEVER collide-updates a committed
      // attempt row (Rule #7 / immutable-artifact invariant); a replayed finalize is a
      // DO-NOTHING that returns the existing quarantined row. A concurrent same-tenant
      // job delete can race the (org, job) precheck → the composite FK raises 23503;
      // normalize it to the coarse rejection (never a raw 500 / disclosing error).
      let inserted: Array<typeof jobArtifacts.$inferSelect>;
      try {
        inserted = await tx.insert(jobArtifacts).values({
          organizationId: input.organizationId,
          jobId: input.jobId,
          identifier: input.identifier,
          objectKey: input.quarantineObjectKey,
          sha256: input.sha256,
          sizeBytes: input.sizeBytes,
          sensitivity: input.sensitivity,
          kind: input.kind,
          attempt: input.attemptNumber,
          status: "quarantined",
          orphanDisposition: "quarantined",
          quarantineReason: input.reason,
          observedLeaseId: input.observedLeaseId,
          observedFenceToken: input.observedFenceToken,
        }).onConflictDoNothing({
          target: [jobArtifacts.organizationId, jobArtifacts.jobId, jobArtifacts.attempt, jobArtifacts.identifier],
          where: sql`status = 'quarantined'`,
        }).returning();
      } catch (error) {
        if (error && typeof error === "object" && (error as { code?: string }).code === "23503") {
          throw new OrphanQuarantineRejection("unknown_job");
        }
        throw error;
      }
      if (inserted[0]) return { artifact: inserted[0], alreadyQuarantined: false };

      // Conflict → the orphan was already quarantined (idempotent replay): return the
      // existing quarantined row unchanged (no second row, no committed-row mutation).
      const [existing] = await tx.select().from(jobArtifacts).where(and(
        eq(jobArtifacts.organizationId, input.organizationId),
        eq(jobArtifacts.jobId, input.jobId),
        eq(jobArtifacts.attempt, input.attemptNumber),
        eq(jobArtifacts.identifier, input.identifier),
        eq(jobArtifacts.status, "quarantined"),
      )).limit(1);
      if (!existing) throw new OrphanQuarantineRejection("unknown_job");
      return { artifact: existing, alreadyQuarantined: true };
    },

    async recordGovernedProjection(input) {
      // Fence FIRST — a stale/old-generation fence throws before ANY effect, so the
      // server never links a governance aggregate to a dead attempt. Then write ONLY
      // the receipt (never a job/attempt transition — the aggregate authority owns
      // status). The (org, company, kind, source_identity) unique makes a replay a
      // DO-NOTHING no-op: on a redelivery the SAME aggregate is re-linked, never a
      // second one. This is the sole dedup guard for a non-idempotent aggregate
      // create (approvals.create has none), so the bridge reads the receipt BEFORE
      // driving the authority.
      await guardActiveFence(input);
      const { projection } = input;
      const [inserted] = await tx.insert(jobProjectionReceipts).values({
        organizationId: input.organizationId,
        companyId: input.companyId,
        projectionKind: projection.projectionKind,
        sourceIdentity: projection.sourceIdentity,
        sourceDigest: projection.sourceDigest,
        jobId: input.jobId,
        attemptId: input.attemptId,
        sourceFence: input.fence,
        status: projection.status,
        targetAggregateId: projection.targetAggregateId,
        aggregateKind: projection.aggregateKind,
        appliedAt: projection.status === "applied" ? sql`clock_timestamp()` : null,
        createdAt: sql`clock_timestamp()`,
      }).onConflictDoNothing({
        target: [
          jobProjectionReceipts.organizationId,
          jobProjectionReceipts.companyId,
          jobProjectionReceipts.projectionKind,
          jobProjectionReceipts.sourceIdentity,
        ],
      }).returning({ id: jobProjectionReceipts.id });
      if (inserted) return { receiptId: inserted.id, applied: projection.status === "applied" };
      // Conflict — the receipt already exists (idempotent replay). Re-read it so the
      // caller can reconcile to the ALREADY-linked aggregate without a second create.
      const [existing] = await tx.select({
        id: jobProjectionReceipts.id,
        status: jobProjectionReceipts.status,
      }).from(jobProjectionReceipts).where(and(
        eq(jobProjectionReceipts.organizationId, input.organizationId),
        eq(jobProjectionReceipts.companyId, input.companyId),
        eq(jobProjectionReceipts.projectionKind, projection.projectionKind),
        eq(jobProjectionReceipts.sourceIdentity, projection.sourceIdentity),
      )).limit(1);
      return {
        receiptId: existing?.id ?? null,
        applied: existing?.status === "applied",
      };
    },

    async markGovernedProjectionApplied(input) {
      await guardActiveFence(input);
      const [row] = await tx.update(jobProjectionReceipts).set({
        status: "applied",
        appliedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(jobProjectionReceipts.organizationId, input.organizationId),
        eq(jobProjectionReceipts.companyId, input.companyId),
        eq(jobProjectionReceipts.projectionKind, input.projectionKind),
        eq(jobProjectionReceipts.sourceIdentity, input.sourceIdentity),
        eq(jobProjectionReceipts.status, "pending"),
      )).returning({ id: jobProjectionReceipts.id });
      if (row) return { applied: true };
      // Idempotent double-resolve: a receipt already `applied` is still success.
      const [existing] = await tx.select({ status: jobProjectionReceipts.status })
        .from(jobProjectionReceipts).where(and(
          eq(jobProjectionReceipts.organizationId, input.organizationId),
          eq(jobProjectionReceipts.companyId, input.companyId),
          eq(jobProjectionReceipts.projectionKind, input.projectionKind),
          eq(jobProjectionReceipts.sourceIdentity, input.sourceIdentity),
        )).limit(1);
      return { applied: existing?.status === "applied" };
    },

    async queueGovernedControlCommand(input) {
      // Fence FIRST (throws stale_fence / attempt_terminal / target_revoked). The
      // guard returns the LOCKED lease + attempt, so the monotonic sequence below is
      // allocated under the lease lock — identical to `requestCancellation`, minus
      // the cancel status transitions (this control carries a resolved decision, it
      // does not itself change job/attempt state).
      const { lease } = await guardActiveFence(input);
      const { control } = input;
      // Idempotent: at most one command per (org, lease, command id). A retried queue
      // with the SAME command id replays the queued row, never a second command.
      const [existing] = await tx.select().from(jobControlCommands).where(and(
        eq(jobControlCommands.organizationId, input.organizationId),
        eq(jobControlCommands.leaseId, input.leaseId),
        eq(jobControlCommands.commandId, control.commandId),
      )).limit(1);
      if (existing) return { command: toQueuedControlCommand(existing), queued: false };

      const [{ maxSeq }] = await tx.select({
        maxSeq: sql<number>`COALESCE(MAX(${jobControlCommands.commandSeq}), 0)`,
      }).from(jobControlCommands).where(and(
        eq(jobControlCommands.organizationId, input.organizationId),
        eq(jobControlCommands.leaseId, input.leaseId),
      ));
      const commandSeq = Number(maxSeq) + 1;
      // Stamp the lease-allocated sequence into the already-validated E1 body so the
      // stored jsonb agrees with the command_seq column (any positive seq still
      // satisfies the frozen schema the bridge validated against).
      const commandBody = { ...control.commandBody, commandSeq };
      const [inserted] = await tx.insert(jobControlCommands).values({
        organizationId: input.organizationId,
        companyId: input.companyId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        attemptNumber: input.attemptNumber,
        leaseId: input.leaseId,
        commandId: control.commandId,
        commandSeq,
        commandKind: control.commandKind,
        fenceToken: input.fence,
        command: commandBody,
      }).onConflictDoNothing({
        target: [
          jobControlCommands.organizationId,
          jobControlCommands.leaseId,
          jobControlCommands.commandId,
        ],
      }).returning();
      if (inserted) return { command: toQueuedControlCommand(inserted), queued: true };
      // Lost the (org, lease, command id) race — re-read the winning row.
      const [row] = await tx.select().from(jobControlCommands).where(and(
        eq(jobControlCommands.organizationId, input.organizationId),
        eq(jobControlCommands.leaseId, input.leaseId),
        eq(jobControlCommands.commandId, control.commandId),
      )).limit(1);
      return { command: row ? toQueuedControlCommand(row) : null, queued: false };
    },

    async lockActiveFence(input) {
      // Read-only guard: acquire the lease+attempt FOR UPDATE lock and validate the fence
      // (throws JobFenceError on stale/old-generation/terminal), writing NOTHING. Callers
      // use it to serialize concurrent same-fence critical sections (e.g. the
      // product-approval create TOCTOU) before a non-idempotent aggregate authority runs.
      return guardActiveFence(input);
    },
  };
  return repository;
}
