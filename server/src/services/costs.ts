import { and, asc, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { activityLog, agents, companies, costEvents, heartbeatRuns, issues, projects } from "@armyofagents/db";
import { notFound, unprocessable } from "../errors.js";
import { budgetService } from "./budgets.js";
import { logger } from "../middleware/logger.js";

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

export type WindowKind = "5h" | "24h" | "7d";

const WINDOW_HOURS: Record<WindowKind, number> = {
  "5h": 5,
  "24h": 24,
  "7d": 24 * 7,
};

// Map adapter/provider identifiers to the billingType stored on cost_events.
// Subscription-based local CLIs report against bundled quota; everything else
// is "unknown" until upstream surfaces a richer billing signal. (API adapter
// cases removed in Sprint 2A — Decision #91.)
export function inferBillingType(provider: string): string {
  switch (provider) {
    case "claude_local":
      return "subscription_claude";
    case "codex_local":
      return "subscription_codex";
    default:
      return "unknown";
  }
}

export function costService(db: Db) {
  return {
    // U13.4: costEvents.agentId is nullable at the schema level (one-shot CLI
    // spawns record with agentId:null via recordOneShotCliCost,
    // one-shot-cli-budget.ts — NOT through this function). createEvent stays
    // the agent-REQUIRED path — it looks up + validates a real agent below
    // and throws `notFound` when absent — so the param type narrows agentId
    // back to a required `string` rather than inheriting the table's
    // nullable insert type.
    createEvent: async (
      companyId: string,
      data: Omit<typeof costEvents.$inferInsert, "companyId" | "agentId"> & { agentId: string },
    ) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, data.agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent) throw notFound("Agent not found");
      if (agent.companyId !== companyId) {
        throw unprocessable("Agent does not belong to company");
      }

      const event = await db.transaction(async (tx) => {
        const event = await tx
          .insert(costEvents)
          .values({
            ...data,
            companyId,
            biller: data.biller ?? data.provider,
            billingType: data.billingType ?? inferBillingType(data.provider),
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agents)
          .set({
            spentMonthlyCents: sql`${agents.spentMonthlyCents} + ${event.costCents}`,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agent.id));

        await tx
          .update(companies)
          .set({
            spentMonthlyCents: sql`${companies.spentMonthlyCents} + ${event.costCents}`,
            updatedAt: new Date(),
          })
          .where(eq(companies.id, companyId));

        const updatedAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, agent.id))
          .then((rows) => rows[0] ?? null);

        if (
          updatedAgent &&
          updatedAgent.budgetMonthlyCents > 0 &&
          updatedAgent.spentMonthlyCents >= updatedAgent.budgetMonthlyCents &&
          updatedAgent.status !== "paused" &&
          updatedAgent.status !== "terminated"
        ) {
          await tx
            .update(agents)
            .set({ status: "paused", updatedAt: new Date() })
            .where(eq(agents.id, updatedAgent.id));
        }

        return event;
      });

      // Fire-and-forget budget evaluation
      budgetService(db).evaluateCostEvent(agent.id, companyId).catch((err) =>
        logger.error({ err }, "budget evaluation failed after cost event")
      );

      return event;
    },

    summary: async (companyId: string, range?: CostDateRange) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const [{ total }] = await db
        .select({
          total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(and(...conditions));

      const spendCents = Number(total);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (spendCents / company.budgetMonthlyCents) * 100
          : 0;

      return {
        companyId,
        spendCents,
        budgetCents: company.budgetMonthlyCents,
        utilizationPercent: Number(utilization.toFixed(2)),
      };
    },

    byAgent: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costRows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(costEvents.agentId, agents.name, agents.status)
        .orderBy(desc(sql`coalesce(sum(${costEvents.costCents}), 0)::int`));

      const runConditions: ReturnType<typeof eq>[] = [eq(heartbeatRuns.companyId, companyId)];
      if (range?.from) runConditions.push(gte(heartbeatRuns.finishedAt, range.from));
      if (range?.to) runConditions.push(lte(heartbeatRuns.finishedAt, range.to));

      // API-billed variants: 'api' (explicit API key) and 'metered_api' (T13 Bedrock + similar per-call adapters).
      // Subscription-billed variants: 'subscription' (generic), 'subscription_included' (included in plan),
      // 'subscription_overage' (overage — treat like subscription for token tracking even though cost accrues).
      // 'credits' and 'fixed' are deferred to costEvents records and excluded from run-count tallies.
      const runRows = await db
        .select({
          agentId: heartbeatRuns.agentId,
          apiRunCount:
            sql<number>`coalesce(sum(case when coalesce((${heartbeatRuns.usageJson} ->> 'billingType'), 'unknown') in ('api', 'metered_api') then 1 else 0 end), 0)::int`,
          subscriptionRunCount:
            sql<number>`coalesce(sum(case when coalesce((${heartbeatRuns.usageJson} ->> 'billingType'), 'unknown') in ('subscription', 'subscription_included', 'subscription_overage') then 1 else 0 end), 0)::int`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when coalesce((${heartbeatRuns.usageJson} ->> 'billingType'), 'unknown') in ('subscription', 'subscription_included', 'subscription_overage') then coalesce((${heartbeatRuns.usageJson} ->> 'inputTokens')::int, 0) else 0 end), 0)::int`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when coalesce((${heartbeatRuns.usageJson} ->> 'billingType'), 'unknown') in ('subscription', 'subscription_included', 'subscription_overage') then coalesce((${heartbeatRuns.usageJson} ->> 'outputTokens')::int, 0) else 0 end), 0)::int`,
        })
        .from(heartbeatRuns)
        .where(and(...runConditions))
        .groupBy(heartbeatRuns.agentId);

      const runRowsByAgent = new Map(runRows.map((row) => [row.agentId, row]));
      return costRows.map((row) => {
        // U13.4: row.agentId is nullable (one-shot CLI cost events have no
        // agent) — heartbeatRuns.agentId is NOT NULL, so a null cost-event
        // agentId can never match a run row; skip the lookup rather than
        // querying the Map<string, ...> with a null key.
        const runRow = row.agentId ? runRowsByAgent.get(row.agentId) : undefined;
        return {
          ...row,
          apiRunCount: runRow?.apiRunCount ?? 0,
          subscriptionRunCount: runRow?.subscriptionRunCount ?? 0,
          subscriptionInputTokens: runRow?.subscriptionInputTokens ?? 0,
          subscriptionOutputTokens: runRow?.subscriptionOutputTokens ?? 0,
        };
      });
    },

    byProject: async (companyId: string, range?: CostDateRange) => {
      const issueIdAsText = sql<string>`${issues.id}::text`;
      const runProjectLinks = db
        .selectDistinctOn([activityLog.runId, issues.projectId], {
          runId: activityLog.runId,
          projectId: issues.projectId,
        })
        .from(activityLog)
        .innerJoin(
          issues,
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(issues.companyId, companyId),
            isNotNull(activityLog.runId),
            isNotNull(issues.projectId),
          ),
        )
        .orderBy(activityLog.runId, issues.projectId, desc(activityLog.createdAt))
        .as("run_project_links");

      const conditions: ReturnType<typeof eq>[] = [eq(heartbeatRuns.companyId, companyId)];
      if (range?.from) conditions.push(gte(heartbeatRuns.finishedAt, range.from));
      if (range?.to) conditions.push(lte(heartbeatRuns.finishedAt, range.to));

      const costCentsExpr = sql<number>`coalesce(sum(round(coalesce((${heartbeatRuns.usageJson} ->> 'costUsd')::numeric, 0) * 100)), 0)::int`;

      return db
        .select({
          projectId: runProjectLinks.projectId,
          projectName: projects.name,
          costCents: costCentsExpr,
          inputTokens: sql<number>`coalesce(sum(coalesce((${heartbeatRuns.usageJson} ->> 'inputTokens')::int, 0)), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(coalesce((${heartbeatRuns.usageJson} ->> 'outputTokens')::int, 0)), 0)::int`,
        })
        .from(runProjectLinks)
        .innerJoin(heartbeatRuns, eq(runProjectLinks.runId, heartbeatRuns.id))
        .innerJoin(projects, eq(runProjectLinks.projectId, projects.id))
        .where(and(...conditions))
        .groupBy(runProjectLinks.projectId, projects.name)
        .orderBy(desc(costCentsExpr));
    },

    byModel: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const totalCostExpr = sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`;

      return db
        .select({
          model: costEvents.model,
          totalCostCents: totalCostExpr,
          totalInputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          totalCachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
          totalOutputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
          eventCount: sql<number>`count(*)::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.model)
        .orderBy(desc(totalCostExpr));
    },

    byProvider: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const totalCostExpr = sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`;

      return db
        .select({
          provider: costEvents.provider,
          totalCostCents: totalCostExpr,
          totalInputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          totalCachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
          totalOutputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
          eventCount: sql<number>`count(*)::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.provider)
        .orderBy(desc(totalCostExpr));
    },

    // Groups by biller with a fallback to provider when biller is unset
    // (NULL or the "unknown" default left by legacy events). Sort is
    // alphabetical by the resolved biller so UI rendering is stable.
    byBiller: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const billerExpr = sql<string>`coalesce(nullif(${costEvents.biller}, 'unknown'), ${costEvents.provider})`;

      return db
        .select({
          biller: billerExpr,
          totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          totalInputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          totalCachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
          totalOutputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
          eventCount: sql<number>`count(*)::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(billerExpr)
        .orderBy(asc(billerExpr));
    },

    // Sum of cost events within a rolling window anchored on occurredAt.
    // AoA-specific shape: a single aggregated row per call. AoA's
    // windowSpend returns per-provider breakdowns across all three windows;
    // AoA surfaces per-window totals and leaves per-provider detail to
    // byProvider + quota-windows snapshots.
    windowSpend: async (companyId: string, windowKind: WindowKind) => {
      const hours = WINDOW_HOURS[windowKind];
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);

      const [row] = await db
        .select({
          totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          totalInputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          totalCachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
          totalOutputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, since),
          ),
        );

      return {
        companyId,
        windowKind,
        totalCostCents: Number(row?.totalCostCents ?? 0),
        totalInputTokens: Number(row?.totalInputTokens ?? 0),
        totalCachedInputTokens: Number(row?.totalCachedInputTokens ?? 0),
        totalOutputTokens: Number(row?.totalOutputTokens ?? 0),
      };
    },
  };
}
