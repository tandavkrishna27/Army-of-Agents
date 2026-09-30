/**
 * Crew dispatch budget guard (Task B4, T14).
 *
 * `preflightCrewDispatch()` is called by the Adjutant runtime wrapper before
 * spawning any crew agent (Adjutant, Scout, Engineer, etc.). It enforces two
 * gates, in order:
 *
 *   1. Per-thread opt-out — `discussions.adjutantEnabled = false` silences the
 *      Adjutant + downstream crew for this thread only. This check fires first
 *      because it's the founder's explicit "leave this thread alone" signal —
 *      a thread-level toggle shouldn't be overridden by a global budget pass.
 *
 *   2. Company-scope budget hard stop — if a company has an active budget
 *      policy with `hardStopEnabled = true` whose current-month observed spend
 *      meets or exceeds `amountCents`, we soft-fail by inserting a `system`
 *      entry into the thread (so the founder sees the explanation inline,
 *      with retry guidance) and return `allowed: false` with reasonCode
 *      `budget_exhausted`.
 *
 * Why a soft-fail with a thread entry and not just a return value?
 *   - The crew caller doesn't surface failures back to the founder; the thread
 *     is the user-facing surface where they're waiting for an answer.
 *   - The same code path could be reached repeatedly as new entries land
 *     during a budget breach. The `system` entry is what they SEE; the return
 *     value is what the runtime acts on. Repeated entries are tolerated for
 *     now (each new dispatch attempt = one entry) — future dedup can compare
 *     against the last system entry timestamp if this gets noisy.
 *
 * Budget semantics — must match `server/src/services/budgets.ts`:
 *   - Policy scope: only `scopeType = 'company'` + `scopeId = companyId` rows
 *     gate the crew. Per-agent caps are enforced separately by the existing
 *     heartbeat path (`budgetService.getInvocationBlock`) and are not the
 *     concern of the thread/crew layer.
 *   - `windowKind = 'calendar_month_utc'` is the only supported window today;
 *     the same `calendarMonthWindow()` helper-equivalent is inlined below to
 *     avoid a cross-file circular import on `budgets.ts`.
 *   - `hardStopEnabled = false` means warn-only, not a block. We respect this.
 *   - `isActive = false` policies are ignored (founder paused enforcement).
 *
 * Cost-event sum: `cost_events.cost_cents` over `[monthStart, monthEnd)`
 * filtered by `cost_events.company_id`. Matches `getObservedCents` semantics.
 *
 * No production caller wires this in yet — that's wired by the future Adjutant
 * runtime wrapper. This file is the standalone, unit-tested gate.
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { budgetPolicies, costEvents, discussionEntries, discussions } from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import { publishLiveEvent } from "./live-events.js";

export interface PreflightParams {
  companyId: string;
  agentId: string;
  threadId: string;
}

export type PreflightReasonCode =
  | "thread_disabled"
  | "thread_paused"
  | "budget_exhausted";

export type PreflightResult =
  | { allowed: true }
  | { allowed: false; reason: string; reasonCode: PreflightReasonCode };

/**
 * Returns the [start, end) range for the current calendar month in UTC.
 *
 * Mirrors `calendarMonthWindow()` in `server/src/services/budgets.ts` — kept
 * inline to avoid a service↔service import cycle on the budget hook layer.
 * If the budget window contract ever changes, update both call-sites.
 */
function calendarMonthWindowUtc(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * Formats a cent amount as a USD dollar string with two decimal places
 * (e.g. 12345 → "$123.45"). Used in the thread-visible system entry so the
 * founder reads dollars, not cents.
 */
function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Returns the system-entry message body shown when the budget gate blocks
 * dispatch. Kept as a named helper so tests can assert against the exact
 * shape without duplicating the format string.
 */
export function formatBudgetExhaustedMessage(
  observedCents: number,
  capCents: number,
): string {
  return (
    `Crew budget reached for this period (spend: ${formatUsd(observedCents)} ` +
    `/ cap: ${formatUsd(capCents)}). Adjutant is paused for this thread until ` +
    `budget resets or you increase the cap in Settings → Budget.`
  );
}

/**
 * Pre-flight gate run before dispatching any crew agent for a thread.
 *
 * Order of checks (stable contract — tests rely on this):
 *   1. Thread existence + `adjutantEnabled` flag → `thread_disabled` if either trips.
 *   1b. Thread-wide `crewPaused` kill-switch → `thread_paused` if true.
 *   2. Company budget cap → `budget_exhausted` if observed >= cap on the
 *      active company-scoped, hardStopEnabled policy.
 *
 * Pause beats budget — an explicit founder action (`crewPaused = true`)
 * surfaces as `thread_paused` even if the budget would have blocked anyway.
 *
 * On budget exhaustion, a `system` entry is inserted into the thread. On any
 * other outcome (allowed, thread_disabled, thread_paused), no entry is inserted.
 */
export async function preflightCrewDispatch(
  db: Db,
  params: PreflightParams,
): Promise<PreflightResult> {
  // ── 1. Per-thread opt-out (founder explicitly silenced Adjutant for this thread)
  //
  // We pull both `adjutantEnabled` and `crewPaused` here so a single read
  // covers two distinct founder gates:
  //   - `adjutantEnabled = false` → Adjutant-specific opt-out (most narrow)
  //   - `crewPaused = true` → broader thread-wide crew kill-switch
  //
  // The listener boundary at `thread-events.ts:146` already honors
  // `crewPaused`. Checking it here too is defense-in-depth for any future
  // call site that invokes `preflightCrewDispatch` outside the listener
  // (tools, crons, admin endpoints).
  const [thread] = await db
    .select({
      id: discussions.id,
      adjutantEnabled: discussions.adjutantEnabled,
      crewPaused: discussions.crewPaused,
      companyId: discussions.companyId,
    })
    .from(discussions)
    .where(eq(discussions.id, params.threadId))
    .limit(1);

  if (!thread) {
    return {
      allowed: false,
      reason: `Thread ${params.threadId} not found`,
      reasonCode: "thread_disabled",
    };
  }

  if (thread.adjutantEnabled === false) {
    return {
      allowed: false,
      reason: "Adjutant disabled for this thread",
      reasonCode: "thread_disabled",
    };
  }

  // ── 1b. Thread-wide crew pause (founder hit kill-switch).
  //
  // Fires BEFORE the budget probe so an explicit pause is always the
  // surfaced reason — a paused thread that's also over-budget reports
  // `thread_paused` (the founder action) rather than `budget_exhausted`
  // (an indirect symptom). No system entry is written: the founder
  // already knows they paused it.
  if (thread.crewPaused === true) {
    return {
      allowed: false,
      reason: "Crew paused for this thread",
      reasonCode: "thread_paused",
    };
  }

  // ── 2. Company budget gate — load the active, hard-stop company-scoped policy
  //
  // The unique index on (companyId, scopeType, scopeId, metric, windowKind)
  // guarantees at most one row per (company, "company", companyId, "cost_cents",
  // "calendar_month_utc") tuple, so `.limit(1)` is a tight fit. If no policy
  // exists, the company has no cap and dispatch is unlimited.
  const [policy] = await db
    .select()
    .from(budgetPolicies)
    .where(
      and(
        eq(budgetPolicies.companyId, params.companyId),
        eq(budgetPolicies.scopeType, "company"),
        eq(budgetPolicies.scopeId, params.companyId),
        eq(budgetPolicies.isActive, true),
        eq(budgetPolicies.hardStopEnabled, true),
        eq(budgetPolicies.metric, "cost_cents"),
        eq(budgetPolicies.windowKind, "calendar_month_utc"),
      ),
    )
    .limit(1);

  if (!policy) {
    // No active company-scoped hard-stop policy. Treat as unlimited; per-agent
    // policies are the existing heartbeat path's responsibility.
    return { allowed: true };
  }

  // ── 3. Current-month observed spend (matches budgets.ts getObservedCents)
  const { start, end } = calendarMonthWindowUtc();
  const [spendRow] = await db
    .select({
      total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
    })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, params.companyId),
        gte(costEvents.occurredAt, start),
        lt(costEvents.occurredAt, end),
      ),
    );

  const observedCents = Number(spendRow?.total ?? 0);

  if (observedCents >= policy.amountCents) {
    // Soft-fail: surface the block inside the thread so the founder sees
    // exactly why nothing happened, with retry guidance. The entry is
    // created by `system` (NOT a real user id) — `discussion_entries.createdBy`
    // is plain text and the 'system' input type was added to the enum in A3.
    //
    // Atomic pattern (mirrors crew-result-relay.ts): bump entrySeq + entryCount
    // in the same transaction as the INSERT so:
    //   - the entry gets the correct monotonic seq (live views use seq ordering)
    //   - the counter is never out-of-sync with the actual row count
    // After the transaction, publish the same live-event pair that all other
    // entry writers publish so the thread renders in real time without a refresh.
    const rawContent = formatBudgetExhaustedMessage(observedCents, policy.amountCents);
    const now = new Date();

    const { entry, companyId } = await db.transaction(async (tx) => {
      const [{ entrySeq, companyId: cid }] = await tx
        .update(discussions)
        .set({
          entrySeq: sql`${discussions.entrySeq} + 1`,
          entryCount: sql`${discussions.entryCount} + 1`,
          updatedAt: now,
        })
        .where(eq(discussions.id, params.threadId))
        .returning({ entrySeq: discussions.entrySeq, companyId: discussions.companyId });

      const [inserted] = await tx
        .insert(discussionEntries)
        .values({
          discussionId: params.threadId,
          inputType: "system",
          rawContent,
          authorAgentId: null,
          createdBy: "system",
          extractionStatus: "skipped",
          seq: entrySeq,
        })
        .returning();

      return { entry: inserted, companyId: cid };
    });

    publishLiveEvent({
      companyId,
      type: "discussion.entry.created",
      payload: { discussionId: params.threadId, entryId: entry.id, inputType: "system" },
    });
    publishLiveEvent({
      companyId,
      type: "thread.entry.created",
      payload: { threadId: params.threadId, entryId: entry.id, seq: entry.seq ?? 0 },
    });

    return {
      allowed: false,
      reason:
        `Crew budget reached for company ${params.companyId} ` +
        `(spend: ${observedCents}, cap: ${policy.amountCents})`,
      reasonCode: "budget_exhausted",
    };
  }

  return { allowed: true };
}
