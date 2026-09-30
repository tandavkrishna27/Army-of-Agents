import { and, desc, eq, gte, inArray, not, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, companies, costEvents, heartbeatRuns } from "@armyofagents/db";
import {
  buildBudgetAlertHubEmit,
  buildFailedRunHubEmit,
  emitHubItem,
} from "./hub-source-producers.js";

const FAILED_HEARTBEAT_STATUSES = ["failed", "timed_out"] as const;
const BUDGET_WARNING_PERCENT = 80;

export async function emitLegacyAlertHubItems(db: Db, companyId: string, limit = 50) {
  const cappedLimit = Math.min(Math.max(limit, 1), 50);
  const latestRunByAgent = await db
    .selectDistinctOn([heartbeatRuns.agentId], {
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      updatedAt: heartbeatRuns.updatedAt,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(agents.companyId, companyId),
        not(eq(agents.status, "terminated")),
      ),
    )
    .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt));

  const failedRuns = latestRunByAgent
    .filter((run) => FAILED_HEARTBEAT_STATUSES.includes(run.status as (typeof FAILED_HEARTBEAT_STATUSES)[number]))
    .slice(0, cappedLimit);

  for (const run of failedRuns) {
    await emitHubItem(db, buildFailedRunHubEmit(run));
  }

  const company = await db
    .select({
      id: companies.id,
      budgetMonthlyCents: companies.budgetMonthlyCents,
      updatedAt: companies.updatedAt,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  let budgetAlerts = 0;
  if (company && company.budgetMonthlyCents > 0) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [{ monthSpend }] = await db
      .select({ monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, monthStart)));
    const monthSpendCents = Number(monthSpend ?? 0);
    const monthUtilizationPercent = (monthSpendCents / company.budgetMonthlyCents) * 100;

    if (monthUtilizationPercent >= BUDGET_WARNING_PERCENT) {
      await emitHubItem(
        db,
        buildBudgetAlertHubEmit({
          companyId,
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(monthUtilizationPercent.toFixed(2)),
          updatedAt: company.updatedAt,
        }),
      );
      budgetAlerts = 1;
    }
  }

  return { emitted: failedRuns.length + budgetAlerts, failedRuns: failedRuns.length, budgetAlerts };
}
