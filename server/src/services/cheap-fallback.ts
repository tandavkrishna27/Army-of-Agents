import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { costEvents, internalAgentConfig } from "@armyofagents/db";

export interface CheapFallbackDecision {
  active: boolean;
  effectiveModel: string | null;
}

/**
 * Pure decision — no DB I/O.
 * Returns active=true and effectiveModel when spend/budget ≥ 0.80 and cheapModel is set.
 */
export function decideCheapFallback(
  budgetMonthlyCents: number,
  currentMonthCents: number,
  cheapModel: string | null | undefined,
): CheapFallbackDecision {
  if (!cheapModel || budgetMonthlyCents <= 0) {
    return { active: false, effectiveModel: null };
  }
  const active = currentMonthCents / budgetMonthlyCents >= 0.8;
  return { active, effectiveModel: active ? cheapModel : null };
}

/**
 * DB-backed resolver called from heartbeat.ts pre-spawn.
 * Returns the cheap model string if the fallback should activate for this agent run,
 * or null if budget is unset, cheapModel is unset, or spend is below 80%.
 *
 * By design (D4), the cheapModel setting is company-wide: it is stored on
 * `internalAgentConfig` (Commander settings) and applies to all regular agents
 * when any individual agent's spend reaches the 80% threshold.
 */
export async function resolveCheapFallbackModel(
  db: Db,
  companyId: string,
  agentId: string,
  budgetMonthlyCents: number,
): Promise<string | null> {
  if (budgetMonthlyCents <= 0) return null;

  const [configRow] = await db
    .select({ cheapModel: internalAgentConfig.cheapModel })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId));

  const cheapModel = configRow?.cheapModel ?? null;
  if (!cheapModel) return null;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [result] = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.agentId, agentId),
        gte(costEvents.occurredAt, monthStart),
      ),
    );

  const { effectiveModel } = decideCheapFallback(
    budgetMonthlyCents,
    Number(result?.total ?? 0),
    cheapModel,
  );
  return effectiveModel;
}
