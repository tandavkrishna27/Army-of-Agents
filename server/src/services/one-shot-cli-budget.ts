/**
 * U13.4 — budget preflight before one-shot CLI sandbox spend, and a
 * dedicated agent-less `cost_events` insert path for one-shot CLI spawns
 * (extraction / Commander compaction / readiness probes — U13.1's shared
 * seam, `runOneShotCliInSandbox` — none of which have an owning agent).
 *
 * `preflightOneShotCliSpend` mirrors `preflightCrewDispatch`'s company-scope
 * budget gate (crew-budget.ts §2-3) EXACTLY: same active/hard-stop/company
 * policy lookup, same calendar-month observed-cents sum over `cost_events`
 * filtered ONLY by `company_id` (no per-agent condition — per-agent caps
 * remain the heartbeat path's job, budgets.ts/`budgetService.getInvocationBlock`).
 * It is deliberately headless, unlike `preflightCrewDispatch`: no thread
 * lookup, no `system` entry side-effect, no live-event publish — a one-shot
 * CLI spawn has no thread to write into.
 *
 * `recordOneShotCliCost` is the companion agent-less write path. It exists
 * because `cost_events.agent_id` was NOT NULL before this task (see the
 * nullable-agentId migration alongside this file) and `costService
 * .createEvent` (costs.ts) requires + looks up a real agent row (`notFound`
 * when absent), then rolls up BOTH agent + company `spentMonthlyCents` and
 * auto-pauses an over-budget agent — none of which apply to an agent-less
 * one-shot spawn. `recordOneShotCliCost` bypasses that path entirely: it
 * inserts with `agentId: null` and rolls up ONLY the company's
 * `spentMonthlyCents`.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { budgetPolicies, companies, costEvents } from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import { computeCostCents } from "./internal-agent/cost-model.js";

export interface OneShotBudgetPreflightParams {
  companyId: string;
}

export type OneShotBudgetReasonCode = "budget_exhausted";

export type OneShotBudgetPreflightResult =
  | { allowed: true }
  | { allowed: false; reason: string; reasonCode: OneShotBudgetReasonCode };

/**
 * Returns the [start, end) range for the current calendar month in UTC.
 * Mirrors `calendarMonthWindowUtc()` in crew-budget.ts (itself mirroring
 * `calendarMonthWindow()` in budgets.ts) — kept inline per that file's own
 * documented rationale: avoid a service<->service import cycle on the
 * budget hook layer. If the budget window contract ever changes, update
 * all three call-sites.
 */
function calendarMonthWindowUtc(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * Headless company-scope budget gate for one-shot CLI spawns. Same policy
 * lookup + observed-cents query shape as `preflightCrewDispatch`
 * (crew-budget.ts) — active, company-scoped, hard-stop-enabled,
 * `calendar_month_utc`, `cost_cents` policy, and a `cost_events` sum bounded
 * ONLY by `company_id` + the month window (deliberately NO per-agent
 * condition — a one-shot spawn has no agent) — but with no thread lookup and
 * no side-effect: this gate is meant to run headless, once per one-shot CLI
 * call, before any sandbox is acquired.
 */
export async function preflightOneShotCliSpend(
  db: Db,
  params: OneShotBudgetPreflightParams,
): Promise<OneShotBudgetPreflightResult> {
  // Active, company-scoped, hard-stop policy. The unique index on
  // (companyId, scopeType, scopeId, metric, windowKind) guarantees at most
  // one row per (company, "company", companyId, "cost_cents",
  // "calendar_month_utc") tuple, so `.limit(1)` is a tight fit.
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
    // No active company-scoped hard-stop policy — unlimited for this gate.
    // Matches preflightCrewDispatch: per-agent policies aren't this gate's
    // concern either.
    return { allowed: true };
  }

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
    return {
      allowed: false,
      reason:
        `One-shot CLI budget reached for company ${params.companyId} ` +
        `(spend: ${observedCents}, cap: ${policy.amountCents})`,
      reasonCode: "budget_exhausted",
    };
  }

  return { allowed: true };
}

export type OneShotCliCostSource = "extraction" | "compaction" | "readiness";

export interface RecordOneShotCliCostParams {
  companyId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  source: OneShotCliCostSource;
  /** Defaults to now() — override only for tests/backfills. */
  occurredAt?: Date;
}

/**
 * Insert a `cost_events` row for a one-shot CLI spawn with `agentId: null`
 * and roll up ONLY the company's `spentMonthlyCents` (there is no agent to
 * update, and no agent auto-pause check — that behavior is
 * `costService.createEvent`'s, which this function deliberately bypasses).
 * `billingType` carries the `source` label (`extraction` / `compaction` /
 * `readiness`) so cost breakdowns can distinguish one-shot CLI spend from
 * subscription/heartbeat agent runs.
 */
export async function recordOneShotCliCost(
  db: Db,
  params: RecordOneShotCliCostParams,
): Promise<typeof costEvents.$inferSelect> {
  const costCents = computeCostCents(params.provider, params.model, params.inputTokens, params.outputTokens);
  const occurredAt = params.occurredAt ?? new Date();

  return db.transaction(async (tx) => {
    const [event] = await tx
      .insert(costEvents)
      .values({
        companyId: params.companyId,
        agentId: null,
        provider: params.provider,
        biller: params.provider,
        billingType: params.source,
        model: params.model,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        costCents,
        occurredAt,
      })
      .returning();

    await tx
      .update(companies)
      .set({
        spentMonthlyCents: sql`${companies.spentMonthlyCents} + ${event.costCents}`,
        updatedAt: new Date(),
      })
      .where(eq(companies.id, params.companyId));

    return event;
  });
}
