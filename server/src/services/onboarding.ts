import type { Db } from "@armyofagents/db";
import { onboardingProgress } from "@armyofagents/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  orderedStatesFor,
  FIRST_RUN_PERSONAS,
  normalizeLegacyOnboardingState,
  type OnboardingJourney,
  type OnboardingState,
  type FirstRunPersona,
} from "@armyofagents/shared";

export type ProgressRow = {
  id: string;
  userId: string;
  companyId: string | null;
  journey: OnboardingJourney;
  currentState: OnboardingState;
  completedStates: OnboardingState[];
  version: number;
  // Optional so existing test fixtures (predating WS0b) that build a
  // ProgressRow literal without these two fields keep typechecking; mapRow
  // always populates them (null when absent) for real rows.
  firstRunCompletedAt?: Date | null;
  firstRunPersona?: FirstRunPersona | null;
};

export type AdvanceDecision =
  | { kind: "noop" }
  | { kind: "advance"; newCurrent: OnboardingState; newCompleted: OnboardingState[] }
  | { kind: "illegal"; reason: string };

/**
 * Pure advance decision (revC RC1). Given the journey's ordered sequence, the
 * current row state, and a requested state:
 * - a state already completed OR at/behind the current index → success no-op
 *   (idempotent / concurrent-safe — do NOT reject);
 * - a genuinely-forward request is legal only if every prior state in the
 *   sequence is already completed (dependency); else illegal (skip);
 * - never regress `currentState`; union `completedStates`.
 */
export function computeAdvance(
  order: OnboardingState[],
  current: OnboardingState,
  completed: OnboardingState[],
  requested: OnboardingState,
): AdvanceDecision {
  const reqIdx = order.indexOf(requested);
  if (reqIdx === -1) return { kind: "illegal", reason: `state ${requested} not in journey` };
  const curIdx = order.indexOf(current);

  if (completed.includes(requested) || (curIdx !== -1 && reqIdx <= curIdx)) {
    return { kind: "noop" };
  }

  const priorSatisfied = order.slice(0, reqIdx).every((s) => completed.includes(s));
  if (!priorSatisfied) return { kind: "illegal", reason: `out-of-order advance to ${requested}` };

  const newCurrent = order[Math.max(curIdx, reqIdx)];
  const newCompleted = completed.includes(requested) ? completed : [...completed, requested];
  return { kind: "advance", newCurrent, newCompleted };
}

/**
 * Phase 2 Task 2 (naming-collision fix): normalizes the retired
 * "ORGANIZATION_CREATED" state name (legacy rows written before the rename)
 * to its replacement "COMPANY_CREATED" on `currentState` and within
 * `completedStates` (deduped, since a legacy row could in principle carry
 * both names post-migration). Every other state passes through unchanged.
 * Exported standalone (pure, no db) so it can be unit-tested directly and
 * reused by every read path that returns a `ProgressRow`-shaped value.
 */
export function normalizeProgressRow<T extends { currentState: any; completedStates: any[] }>(row: T): T {
  return {
    ...row,
    currentState: normalizeLegacyOnboardingState(row.currentState),
    completedStates: Array.from(
      new Set((row.completedStates ?? []).map((s: any) => normalizeLegacyOnboardingState(s))),
    ),
  };
}

function mapRow(row: any): ProgressRow {
  // Normalize at the single chokepoint every read path (getProgress,
  // ensureProgress, advanceState, setFirstRunProgress) funnels through, so
  // legacy ORGANIZATION_CREATED rows are corrected before they ever reach
  // computeAdvance's ordered-sequence comparisons.
  return normalizeProgressRow({
    id: row.id,
    userId: row.userId,
    companyId: row.companyId ?? null,
    journey: row.journey,
    currentState: row.currentState,
    completedStates: Array.isArray(row.completedStates) ? row.completedStates : [],
    version: row.version ?? 0,
    firstRunCompletedAt: row.firstRunCompletedAt ?? null,
    firstRunPersona: row.firstRunPersona ?? null,
  });
}

export async function getProgress(
  db: Db,
  userId: string,
  companyId: string | null,
): Promise<ProgressRow | null> {
  const where =
    companyId == null
      ? and(eq(onboardingProgress.userId, userId), isNull(onboardingProgress.companyId))
      : and(eq(onboardingProgress.userId, userId), eq(onboardingProgress.companyId, companyId));
  const rows = await db.select().from(onboardingProgress).where(where).limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Create-if-absent the progress row. The user-layer row seeds
 * `completedStates: ["AUTHENTICATED"]`. An ORG-layer row (companyId != null)
 * INHERITS the user-layer row's completed states (e.g. PROFILE_SET) so the
 * founder journey's dependency checks span both layers — otherwise advancing
 * ORGANIZATION_CREATED would fail its PROFILE_SET dependency.
 */
export async function ensureProgress(
  db: Db,
  args: { userId: string; companyId: string | null; journey: OnboardingJourney },
): Promise<ProgressRow> {
  const existing = await getProgress(db, args.userId, args.companyId);
  if (existing) return existing;

  let seedCompleted: OnboardingState[] = ["AUTHENTICATED"];
  let seedCurrent: OnboardingState = "AUTHENTICATED";
  if (args.companyId != null) {
    const userLayer = await getProgress(db, args.userId, null);
    if (userLayer && userLayer.completedStates.length > 0) {
      seedCompleted = [...userLayer.completedStates];
      seedCurrent = userLayer.currentState;
    }
  }

  await db
    .insert(onboardingProgress)
    .values({
      userId: args.userId,
      companyId: args.companyId,
      journey: args.journey,
      currentState: seedCurrent,
      completedStates: seedCompleted,
      version: 0,
    })
    .onConflictDoNothing();
  const created = await getProgress(db, args.userId, args.companyId);
  if (!created) throw new Error("failed to ensure onboarding progress");
  return created;
}

export type AdvanceResult =
  | { status: "ok"; row: ProgressRow }
  | { status: "illegal"; reason: string }
  | { status: "conflict" };

/**
 * Advance progress forward-only + union, with an optimistic version guard and a
 * bounded retry (revC RC1). Idempotent replays succeed as no-ops. Concurrent
 * writers race on the `version` predicate; the loser re-reads and re-merges.
 */
export async function advanceState(
  db: Db,
  args: {
    userId: string;
    companyId: string | null;
    journey: OnboardingJourney;
    requestedState: OnboardingState;
  },
): Promise<AdvanceResult> {
  // Accept the retired wire value as a compatibility alias. Read-time
  // normalization alone is insufficient because older clients still PATCH it.
  const requestedState = normalizeLegacyOnboardingState(args.requestedState);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await ensureProgress(db, {
      userId: args.userId,
      companyId: args.companyId,
      journey: args.journey,
    });
    const order = orderedStatesFor(row.journey);
    const decision = computeAdvance(order, row.currentState, row.completedStates, requestedState);
    if (decision.kind === "noop") return { status: "ok", row };
    if (decision.kind === "illegal") return { status: "illegal", reason: decision.reason };

    const updated = await db
      .update(onboardingProgress)
      .set({
        currentState: decision.newCurrent,
        completedStates: decision.newCompleted,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(onboardingProgress.id, row.id), eq(onboardingProgress.version, row.version)))
      .returning();

    if (updated.length === 1) return { status: "ok", row: mapRow(updated[0]) };
    // else: a concurrent writer bumped the version — re-read and retry.
  }
  return { status: "conflict" };
}

export type SetFirstRunResult =
  | { status: "ok"; row: ProgressRow }
  | { status: "not_found" }
  | { status: "conflict" };

/**
 * WS0b write path. `userId` MUST be the board actor (never the client body —
 * enforced by the route, not here) so this can only ever touch the caller's
 * own `(userId, companyId)` row. Optimistic-concurrency retry, mirroring
 * `advanceState`. `persona` and `completed` are independently optional so the
 * door-band write (persona only) and the "reached Home" write (completion
 * only) can share one endpoint.
 */
export async function setFirstRunProgress(
  db: Db,
  args: {
    userId: string;
    companyId: string | null;
    persona?: FirstRunPersona;
    completed?: boolean;
  },
): Promise<SetFirstRunResult> {
  if (args.persona !== undefined && !FIRST_RUN_PERSONAS.includes(args.persona)) {
    throw new Error(`invalid firstRunPersona: ${args.persona}`);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getProgress(db, args.userId, args.companyId);
    if (!row) return { status: "not_found" };

    // True no-op short-circuit: the row is already completed and the
    // requested change asks for nothing new (completed:true again, with no
    // persona change). Mirrors computeAdvance/advanceState's no-op handling —
    // skip the write entirely so `version`/`updatedAt` don't churn. This
    // matters once WS9's door-band write calls this endpoint repeatedly
    // across tabs/reloads for a founder who already finished onboarding.
    const personaUnchanged = args.persona === undefined || args.persona === row.firstRunPersona;
    if (row.firstRunCompletedAt != null && args.completed && personaUnchanged) {
      return { status: "ok", row };
    }

    const patch: Record<string, unknown> = {
      version: row.version + 1,
      updatedAt: new Date(),
    };
    if (args.persona !== undefined) patch.firstRunPersona = args.persona;
    // Idempotent: never clobber an already-set completion timestamp.
    if (args.completed && !row.firstRunCompletedAt) patch.firstRunCompletedAt = new Date();

    const updated = await db
      .update(onboardingProgress)
      .set(patch)
      .where(and(eq(onboardingProgress.id, row.id), eq(onboardingProgress.version, row.version)))
      .returning();

    if (updated.length === 1) return { status: "ok", row: mapRow(updated[0]) };
    // else: a concurrent writer bumped the version — re-read and retry.
  }
  return { status: "conflict" };
}
