import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, companies, heartbeatRuns, jobAttempts, organizations } from "@armyofagents/db";
import { ORG_MAX_CONCURRENT_RUNS_DEFAULT, ORG_MAX_CONCURRENT_RUNS_MAX } from "@armyofagents/shared";
import { preflightOneShotCliSpend } from "./one-shot-cli-budget.js";
import { budgetService } from "./budgets.js";
// DE-27 (audit clause) — the capacity refusal is recorded through a sink, drained by the
// caller on a POOL handle after the tenant transaction closes (see below). Type-only import:
// erased at compile time, so it pulls no logger-bearing runtime dependency into any static
// graph. The recorder itself is loaded dynamically by the drain sites.
import type { AdmissionDenialSink } from "./worker-admission-denial-audit.js";

export const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
export const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50;

export function normalizeMaxConcurrentRuns(value: unknown): number {
  const parsed = Math.floor(
    typeof value === "number" ? value : HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT,
  );
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(
    HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT,
    Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function maxConcurrentRunsFromRuntimeConfig(runtimeConfig: unknown): number {
  const heartbeat = asRecord(asRecord(runtimeConfig).heartbeat);
  return normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns);
}

// Phase 5, Task 10 — mirrors heartbeat.ts's normalizeMaxConcurrentRuns /
// countRunningRunsForAgent per-agent clamp, layered one level up at the
// Organization. See the Paperclip Divergence Points section (D5) in CLAUDE.md
// for the sibling per-agent clamp this deliberately mirrors (light default, real max).

export function normalizeOrgConcurrencyCap(value: unknown): number {
  if (value === null || value === undefined) return ORG_MAX_CONCURRENT_RUNS_DEFAULT;
  const parsed = Math.floor(typeof value === "number" ? value : Number(value));
  if (!Number.isFinite(parsed)) return ORG_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(1, Math.min(ORG_MAX_CONCURRENT_RUNS_MAX, parsed));
}

export function orgAvailableSlots(input: { cap: number; running: number }): number {
  return Math.max(0, input.cap - input.running);
}

/**
 * Claim mirrors are post-commit observability/state mirrors, not the execution
 * correctness boundary. Isolate each failure so one event listener or wakeup
 * update cannot prevent already-committed runs from being launched.
 */
export async function runClaimMirrorsBestEffort<T>(
  claims: readonly T[],
  mirror: (claim: T) => Promise<void>,
  onError: (error: unknown, claim: T) => void,
): Promise<void> {
  for (const claim of claims) {
    try {
      await mirror(claim);
    } catch (error) {
      try {
        onError(error, claim);
      } catch {
        // Error reporting must not restore the launch-blocking failure mode.
      }
    }
  }
}

/** Resolve the immutable Company -> Organization ownership edge. */
export async function resolveCompanyOrganizationId(db: Db, companyId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: companies.organizationId })
    .from(companies)
    .where(eq(companies.id, companyId));
  return row?.organizationId ?? null;
}

/** Count running heartbeat runs across every company in the organization. */
export async function countRunningRunsForOrg(db: Db, organizationId: string): Promise<number> {
  const companyRows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.organizationId, organizationId));
  const ids = companyRows.map((r) => r.id);
  if (ids.length === 0) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(and(inArray(heartbeatRuns.companyId, ids), eq(heartbeatRuns.status, "running")));
  return Number(row?.count ?? 0);
}

// ---------------------------------------------------------------------------
// JOB-007 — the ONE shared Organization concurrency/capacity authority.
//
// Legacy heartbeat runs AND distributed job attempts consume ONE Organization cap
// (organizations.concurrency_cap). The distributed side stores its claim ON THE
// ATTEMPT (job_attempts.capacity_claim_state) — NOT a parallel counter — so the
// occupancy is derived by COUNTING both sources. Admission serializes per
// Organization under one advisory xact lock (count-then-claim), so concurrent
// claims can never exceed the cap; the claim is released by ONE conditional
// 'held' -> 'released' transition, so retry/reaper/revocation/cost-exhaustion may
// all race but release EXACTLY once. Unavailable shared admission storage FAILS
// CLOSED (a thrown admission is a denial for the caller, never an implicit admit).

export const CAPACITY_CLAIM_UNCLAIMED = "unclaimed" as const;
export const CAPACITY_CLAIM_HELD = "held" as const;
export const CAPACITY_CLAIM_RELEASED = "released" as const;

/** Count distributed attempts currently HOLDING an Organization capacity slot. */
export async function countHeldAttemptsForOrg(db: Db, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(jobAttempts)
    .where(and(
      eq(jobAttempts.organizationId, organizationId),
      eq(jobAttempts.capacityClaimState, CAPACITY_CLAIM_HELD),
    ));
  return Number(row?.count ?? 0);
}

export interface OrgCapacityUsage {
  legacyRunning: number;
  heldAttempts: number;
  total: number;
}

/**
 * The shared Organization occupancy: legacy running heartbeat runs + distributed
 * attempts holding a capacity slot. This is the single number both the legacy
 * heartbeat claim and the distributed attempt claim compare against the cap.
 */
export async function resolveOrgCapacityUsage(
  db: Db,
  input: { organizationId: string },
): Promise<OrgCapacityUsage> {
  const legacyRunning = await countRunningRunsForOrg(db, input.organizationId);
  const heldAttempts = await countHeldAttemptsForOrg(db, input.organizationId);
  return { legacyRunning, heldAttempts, total: legacyRunning + heldAttempts };
}

/**
 * The budget bridge seam. Admission consults the EXISTING company-scoped budget
 * policy (a hard-stop that has already been reached denies admission) via the
 * shared one-shot preflight. Injectable so tests can drive a hard-stop or an
 * unavailable dependency without seeding budget rows.
 */
export interface CapacityBudgetBridge {
  checkAdmission(
    db: Db,
    // `agentId`/`projectId` are OPTIONAL: the `admitAttemptCapacity` call site knows
    // only the company (it does not carry a resolved agent/project), so at that seam
    // the check is company-scoped. Direct callers that DO know the agent/project pass
    // them for the richer per-scope hard-stop check (JOB-012).
    input: { companyId: string; agentId?: string | null; projectId?: string | null },
  ): Promise<{ allowed: boolean; reason?: string }>;
}

export const defaultCapacityBudgetBridge: CapacityBudgetBridge = {
  async checkAdmission(db, input) {
    const result = await preflightOneShotCliSpend(db, { companyId: input.companyId });
    return result.allowed ? { allowed: true } : { allowed: false, reason: result.reason };
  },
};

/**
 * JOB-012 — the budget-aware admission bridge. Consults the FULL policy set (agent +
 * company + department hard-stops) via `budgetService.getInvocationBlock` before the
 * existing company one-shot preflight. A reached hard-stop at any applicable scope
 * denies admission. At the `admitAttemptCapacity` seam only `companyId` is supplied,
 * so it degrades to the company gate (identical safety to the default bridge); direct
 * callers passing `agentId`/`projectId` get the richer per-scope check. Any thrown
 * dependency propagates so the admit path FAILS CLOSED (never a silent admit).
 */
export const budgetAwareCapacityBridge: CapacityBudgetBridge = {
  async checkAdmission(db, input) {
    const block = await budgetService(db).getInvocationBlock(
      input.agentId ?? null,
      input.companyId,
      { projectId: input.projectId ?? null },
    );
    if (block) return { allowed: false, reason: block };
    return defaultCapacityBudgetBridge.checkAdmission(db, { companyId: input.companyId });
  },
};

export type CapacityAdmission =
  | { admitted: true; alreadyHeld: boolean; usage: number; cap: number }
  | { admitted: false; reason: "capacity" | "budget"; usage: number; cap: number };

export interface AdmitAttemptCapacityInput {
  organizationId: string;
  companyId: string;
  workloadType: string;
  attemptId: string;
  /**
   * DE-27 (audit clause) — WHO. The authenticated submitting principal (the
   * `AuthenticatedJobPrincipal` the submit path already authorized). When a
   * `capacity` refusal is captured into `denialSink`, `principalId` becomes the
   * durable row's `actorId` and `principalKind` its `details.principalKind`, so the
   * refusal names the SUBMITTER, not the tenant organization. Required so the WHO is
   * never silently dropped; `principalRole` is optional (not every principal carries
   * a role).
   */
  principalId: string;
  principalKind: string;
  principalRole?: string;
  /** DE-27 — the request-time owner userId for an `mcp` submitter, so a capacity
   * refusal attributes to the key's owner as a `user` action (task_8a0402bf). Passed
   * straight into the intent; undefined for every other kind. */
  principalOwnerUserId?: string;
  /** Override the Organization cap (defaults to organizations.concurrency_cap). */
  cap?: number;
  budgetBridge?: CapacityBudgetBridge;
  /**
   * DE-27 (audit clause). When present, a `capacity` refusal (the `usage >= cap`
   * branch) records its INTENT here rather than writing a row itself: this authority
   * only ever runs on the caller's tenant transaction (`tx`), and every production
   * caller THROWS on `admitted:false`, rolling that transaction back — so an
   * in-transaction row would be discarded with it. The caller drains this holder on a
   * POOL handle in a `finally` after the transaction closes. Optional, so the direct
   * (non-submission) callers of this authority are unchanged when they do not opt in.
   */
  denialSink?: AdmissionDenialSink;
}

/**
 * Admit ONE distributed attempt into the Organization cap and stamp the claim on
 * the attempt. Serialized per Organization under an advisory xact lock so the
 * count-then-claim is atomic against every concurrent admit. Budget is checked
 * FIRST (a reached hard-stop denies regardless of free capacity). Any thrown error
 * (unavailable admission storage, budget dependency down) propagates so the caller
 * FAILS CLOSED — never a silent admit. Idempotent: re-admitting an already-held
 * attempt returns admitted with alreadyHeld=true and claims no second slot.
 */
export async function admitAttemptCapacity(
  db: Db,
  input: AdmitAttemptCapacityInput,
): Promise<CapacityAdmission> {
  const bridge = input.budgetBridge ?? defaultCapacityBudgetBridge;
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    // One advisory xact lock per Organization: count-then-claim is serialized and
    // the lock is released at commit, so a concurrent admit sees this claim first.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('aoa:org-capacity'), hashtext(${input.organizationId}))`,
    );
    const cap = input.cap ?? await resolveOrgConcurrencyCap(txDb, input.organizationId);

    // If this attempt already holds a slot, admission is an idempotent no-op (a
    // retried admit must never claim a second slot or trip the cap on itself).
    const [existing] = await tx
      .select({ state: jobAttempts.capacityClaimState })
      .from(jobAttempts)
      .where(and(
        eq(jobAttempts.id, input.attemptId),
        eq(jobAttempts.organizationId, input.organizationId),
      ))
      .limit(1);
    const usageForReport = (await resolveOrgCapacityUsage(txDb, input)).total;
    if (existing?.state === CAPACITY_CLAIM_HELD) {
      return { admitted: true, alreadyHeld: true, usage: usageForReport, cap };
    }

    const budget = await bridge.checkAdmission(txDb, { companyId: input.companyId });
    if (!budget.allowed) {
      return { admitted: false, reason: "budget", usage: usageForReport, cap };
    }

    if (usageForReport >= cap) {
      // DE-27 (audit clause, cross-replica-admission conjunct). Capture the refusal
      // INTENT — never a write here: this branch runs on the caller's tenant transaction
      // and the caller throws a 429 on `admitted:false`, rolling the whole submission
      // back, so any row written on `tx` is discarded with it. The caller drains this
      // holder on a pool handle after the transaction closes. The SECOND `reason:"capacity"`
      // return below the claim UPDATE is a DISTINCT branch (a released/terminal/gone
      // attempt, not a fresh cap refusal) and is deliberately NOT captured — recording it
      // under the same `capacity` code would conflate two branches the reason vocabulary
      // keeps apart, and it is not the cross-replica cap refusal DE-27 names.
      if (input.denialSink) {
        input.denialSink.intent = {
          reason: "capacity",
          companyId: input.companyId,
          organizationId: input.organizationId,
          // WHO — the submitting principal, so the drained row names the submitter and
          // not the tenant organization.
          actorId: input.principalId,
          principalKind: input.principalKind,
          ownerUserId: input.principalOwnerUserId,
          attemptId: input.attemptId,
          control: "server/src/services/org-concurrency.ts:admitAttemptCapacity",
          details: { usage: usageForReport, cap, workloadType: input.workloadType },
        };
      }
      return { admitted: false, reason: "capacity", usage: usageForReport, cap };
    }

    const [claimed] = await tx
      .update(jobAttempts)
      .set({
        capacityClaimState: CAPACITY_CLAIM_HELD,
        capacityWorkloadType: input.workloadType,
        capacityClaimedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(
        eq(jobAttempts.id, input.attemptId),
        eq(jobAttempts.organizationId, input.organizationId),
        eq(jobAttempts.capacityClaimState, CAPACITY_CLAIM_UNCLAIMED),
      ))
      .returning({ id: jobAttempts.id });
    if (claimed) return { admitted: true, alreadyHeld: false, usage: usageForReport, cap };
    // The attempt was not 'unclaimed' and not 'held' above → it is 'released' or
    // gone; a released terminal attempt is never re-admitted.
    return { admitted: false, reason: "capacity", usage: usageForReport, cap };
  });
}

/**
 * Fail-closed wrapper: any thrown admission (unavailable admission storage, budget
 * dependency down) becomes an explicit `{ admitted: false, reason: 'unavailable' }`
 * for callers that want a value instead of an exception. A denial is NEVER an
 * admit.
 */
export async function admitAttemptCapacityFailClosed(
  db: Db,
  input: AdmitAttemptCapacityInput,
): Promise<CapacityAdmission | { admitted: false; reason: "unavailable" }> {
  try {
    return await admitAttemptCapacity(db, input);
  } catch {
    return { admitted: false, reason: "unavailable" };
  }
}

/**
 * Release the attempt's Organization capacity slot with ONE conditional transition
 * ('held' -> 'released'). Exactly-once: only the first caller that observes 'held'
 * wins the transition, so retry, reaper, revocation, and cost-exhaustion may all
 * race but release the slot precisely once. Idempotent (returns released=false when
 * the slot was already released or never held).
 */
export async function releaseAttemptCapacity(
  db: Db,
  input: { attemptId: string; organizationId?: string },
): Promise<{ released: boolean }> {
  const conditions = [
    eq(jobAttempts.id, input.attemptId),
    eq(jobAttempts.capacityClaimState, CAPACITY_CLAIM_HELD),
  ];
  if (input.organizationId) conditions.push(eq(jobAttempts.organizationId, input.organizationId));
  const rows = await db
    .update(jobAttempts)
    .set({
      capacityClaimState: CAPACITY_CLAIM_RELEASED,
      capacityReleasedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(and(...conditions))
    .returning({ id: jobAttempts.id });
  return { released: rows.length === 1 };
}

/**
 * Reads the org's real concurrency dial (organizations.concurrency_cap, P1),
 * normalized/clamped via normalizeOrgConcurrencyCap. NULL (unset) defaults to
 * ORG_MAX_CONCURRENT_RUNS_DEFAULT.
 */
export async function resolveOrgConcurrencyCap(db: Db, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ concurrencyCap: organizations.concurrencyCap })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return normalizeOrgConcurrencyCap(row?.concurrencyCap ?? null);
}

/**
 * Atomically claim queued runs without exceeding either the per-agent or
 * per-Organization concurrency ceiling.
 *
 * The transaction-scoped advisory lock is the cross-process correctness
 * boundary. The heartbeat service's in-memory per-agent lock remains a useful
 * local optimization, but cannot serialize two agents in one Organization or
 * callers running on different server replicas.
 */
export async function claimQueuedRunsWithOrgCapacity(
  db: Db,
  input: {
    organizationId: string;
  },
): Promise<Array<typeof heartbeatRuns.$inferSelect>> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('aoa:org-capacity'), hashtext(${input.organizationId}))`,
    );

    // Re-read Organization occupancy only after acquiring the lock. Counting
    // before the lock would preserve the cross-agent check-then-act race. JOB-007:
    // occupancy is the SHARED authority — legacy running runs PLUS distributed
    // attempts holding a capacity slot — so a legacy claim never oversubscribes the
    // cap that distributed attempts are already consuming (and vice versa).
    const orgCap = await resolveOrgConcurrencyCap(txDb, input.organizationId);
    const orgRunning = (await resolveOrgCapacityUsage(txDb, input)).total;
    const organizationSlots = orgAvailableSlots({ cap: orgCap, running: orgRunning });
    if (organizationSlots <= 0) return [];

    // One globally ordered queue is the scheduling source of truth. The prior
    // approach ordered agents by their oldest item and then batch-claimed per
    // agent, letting A:t1 plus A:t3 jump ahead of B:t2 when A had two slots.
    const queuedRuns = await tx
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        startedAt: heartbeatRuns.startedAt,
        runtimeConfig: agents.runtimeConfig,
      })
      .from(heartbeatRuns)
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(eq(companies.organizationId, input.organizationId), eq(heartbeatRuns.status, "queued")))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
    if (queuedRuns.length === 0) return [];

    const runningByAgentRows = await tx
      .select({
        agentId: heartbeatRuns.agentId,
        count: sql<number>`count(*)`,
      })
      .from(heartbeatRuns)
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .where(and(eq(companies.organizationId, input.organizationId), eq(heartbeatRuns.status, "running")))
      .groupBy(heartbeatRuns.agentId);
    const runningByAgent = new Map(
      runningByAgentRows.map((row) => [row.agentId, Number(row.count ?? 0)]),
    );

    const selectedRuns: Array<{ id: string; startedAt: Date | null }> = [];
    for (const run of queuedRuns) {
      const running = runningByAgent.get(run.agentId) ?? 0;
      const cap = maxConcurrentRunsFromRuntimeConfig(run.runtimeConfig);
      if (running >= cap) continue;
      selectedRuns.push({ id: run.id, startedAt: run.startedAt });
      runningByAgent.set(run.agentId, running + 1);
      if (selectedRuns.length >= organizationSlots) break;
    }

    const claimedAt = new Date();
    const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (const run of selectedRuns) {
      const claimed = await tx
        .update(heartbeatRuns)
        .set({
          status: "running",
          startedAt: run.startedAt ?? claimedAt,
          updatedAt: claimedAt,
        })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (claimed) claimedRuns.push(claimed);
    }
    return claimedRuns;
  });
}
