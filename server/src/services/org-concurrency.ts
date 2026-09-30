import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, companies, heartbeatRuns, organizations } from "@armyofagents/db";
import { ORG_MAX_CONCURRENT_RUNS_DEFAULT, ORG_MAX_CONCURRENT_RUNS_MAX } from "@armyofagents/shared";

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
// Organization. See the AoA Divergence Points section (D5) in CLAUDE.md
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
      sql`SELECT pg_advisory_xact_lock(hashtext('aoa:heartbeat-org-start'), hashtext(${input.organizationId}))`,
    );

    // Re-read Organization occupancy only after acquiring the lock. Counting
    // before the lock would preserve the cross-agent check-then-act race.
    const orgCap = await resolveOrgConcurrencyCap(txDb, input.organizationId);
    const orgRunning = await countRunningRunsForOrg(txDb, input.organizationId);
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
