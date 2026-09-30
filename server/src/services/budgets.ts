import { and, eq, gte, lt, not, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, approvals, budgetIncidents, budgetPolicies, costEvents } from "@armyofagents/db";
import { logActivity } from "./activity-log.js";
import { publishLiveEvent } from "./live-events.js";
import { emitBudgetExhausted, type BudgetEnforcementScope } from "./budget-hooks.js";
import { logger } from "../middleware/logger.js";
import type { UpsertBudgetPolicy, ResolveBudgetIncident } from "@armyofagents/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calendarMonthWindow(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

async function getObservedCents(
  db: Db,
  scopeType: string,
  scopeId: string,
  companyId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  const conditions = [
    eq(costEvents.companyId, companyId),
    gte(costEvents.occurredAt, windowStart),
    lt(costEvents.occurredAt, windowEnd),
  ];

  if (scopeType === "agent") {
    conditions.push(eq(costEvents.agentId, scopeId));
  }

  const [{ total }] = await db
    .select({
      total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
    })
    .from(costEvents)
    .where(and(...conditions));

  return Number(total);
}

async function createIncidentIfNeeded(
  db: Db,
  policy: typeof budgetPolicies.$inferSelect,
  thresholdType: "warning" | "hard_stop",
  observedCents: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<typeof budgetIncidents.$inferSelect | null> {
  // Dedup: check for existing incident with same policyId + windowStart + thresholdType
  // where status <> 'dismissed' (the unique index enforces this)
  const existing = await db
    .select()
    .from(budgetIncidents)
    .where(
      and(
        eq(budgetIncidents.policyId, policy.id),
        eq(budgetIncidents.windowStart, windowStart),
        eq(budgetIncidents.thresholdType, thresholdType),
        not(eq(budgetIncidents.status, "dismissed")),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (existing) return null;

  const limitCents =
    thresholdType === "warning"
      ? Math.round((policy.amountCents * policy.warnPercent) / 100)
      : policy.amountCents;

  const [incident] = await db
    .insert(budgetIncidents)
    .values({
      companyId: policy.companyId,
      policyId: policy.id,
      scopeType: policy.scopeType,
      scopeId: policy.scopeId,
      windowStart,
      windowEnd,
      thresholdType,
      amountLimitCents: limitCents,
      amountObservedCents: observedCents,
      status: "open",
    })
    .returning();

  // For hard stops, create an approval and pause the agent
  if (thresholdType === "hard_stop" && policy.scopeType === "agent") {
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId: policy.companyId,
        type: "budget_override_required",
        requestedByAgentId: policy.scopeId,
        status: "pending",
        payload: {
          policyId: policy.id,
          incidentId: incident.id,
          scopeType: policy.scopeType,
          scopeId: policy.scopeId,
          amountCents: policy.amountCents,
          observedCents,
        },
      })
      .returning();

    await db
      .update(budgetIncidents)
      .set({ approvalId: approval.id, updatedAt: new Date() })
      .where(eq(budgetIncidents.id, incident.id));

    // Pause the agent
    await db
      .update(agents)
      .set({ status: "paused", updatedAt: new Date() })
      .where(eq(agents.id, policy.scopeId));

    logger.info(
      { agentId: policy.scopeId, policyId: policy.id, observedCents },
      "Agent paused due to budget hard-stop",
    );
  }

  publishLiveEvent({
    companyId: policy.companyId,
    type: "budget.incident_created",
    payload: {
      incidentId: incident.id,
      policyId: policy.id,
      thresholdType,
      observedCents,
    },
  });

  return incident;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function budgetService(db: Db) {
  return {
    // ----- upsertPolicy -----
    async upsertPolicy(companyId: string, input: UpsertBudgetPolicy) {
      const existing = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, input.scopeType),
            eq(budgetPolicies.scopeId, input.scopeId),
            eq(budgetPolicies.metric, "cost_cents"),
            eq(budgetPolicies.windowKind, "calendar_month_utc"),
          ),
        )
        .then((rows) => rows[0] ?? null);

      const now = new Date();

      if (existing) {
        const [updated] = await db
          .update(budgetPolicies)
          .set({
            amountCents: input.amountCents,
            warnPercent: input.warnPercent ?? 80,
            hardStopEnabled: input.hardStopEnabled ?? true,
            isActive: true,
            updatedAt: now,
          })
          .where(eq(budgetPolicies.id, existing.id))
          .returning();

        return updated;
      }

      const [created] = await db
        .insert(budgetPolicies)
        .values({
          companyId,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          metric: "cost_cents",
          windowKind: "calendar_month_utc",
          amountCents: input.amountCents,
          warnPercent: input.warnPercent ?? 80,
          hardStopEnabled: input.hardStopEnabled ?? true,
          isActive: true,
        })
        .returning();

      return created;
    },

    // ----- listPolicies -----
    async listPolicies(companyId: string) {
      const policies = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.isActive, true),
          ),
        );

      const { start, end } = calendarMonthWindow();

      const summaries = await Promise.all(
        policies.map(async (policy) => {
          const observedCents = await getObservedCents(
            db,
            policy.scopeType,
            policy.scopeId,
            companyId,
            start,
            end,
          );

          const utilizationPercent =
            policy.amountCents > 0
              ? Number(((observedCents / policy.amountCents) * 100).toFixed(2))
              : 0;

          let status: "ok" | "warning" | "hard_stop" = "ok";
          if (policy.hardStopEnabled && observedCents >= policy.amountCents) {
            status = "hard_stop";
          } else if (observedCents >= (policy.amountCents * policy.warnPercent) / 100) {
            status = "warning";
          }

          // Resolve scope name
          let scopeName = policy.scopeId;
          if (policy.scopeType === "agent") {
            const agent = await db
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, policy.scopeId))
              .then((rows) => rows[0] ?? null);
            if (agent) scopeName = agent.name;
          } else {
            scopeName = "Company";
          }

          return {
            ...policy,
            scopeName,
            observedCents,
            utilizationPercent,
            status,
          };
        }),
      );

      return summaries;
    },

    // ----- deletePolicy -----
    async deletePolicy(companyId: string, policyId: string): Promise<boolean> {
      const deleted = await db
        .delete(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.id, policyId),
            eq(budgetPolicies.companyId, companyId),
          ),
        )
        .returning({ id: budgetPolicies.id });
      return deleted.length > 0;
    },

    // ----- listOpenIncidents -----
    async listOpenIncidents(companyId: string) {
      const incidents = await db
        .select()
        .from(budgetIncidents)
        .where(
          and(
            eq(budgetIncidents.companyId, companyId),
            eq(budgetIncidents.status, "open"),
          ),
        );

      // Enrich with scope name
      const enriched = await Promise.all(
        incidents.map(async (incident) => {
          let scopeName = incident.scopeId;
          if (incident.scopeType === "agent") {
            const agent = await db
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, incident.scopeId))
              .then((rows) => rows[0] ?? null);
            if (agent) scopeName = agent.name;
          } else {
            scopeName = "Company";
          }
          return { ...incident, scopeName };
        }),
      );

      return enriched;
    },

    // ----- getInvocationBlock -----
    async getInvocationBlock(
      agentId: string,
      companyId: string,
    ): Promise<string | null> {
      const { start, end } = calendarMonthWindow();

      // Check agent-scoped policies
      const agentPolicies = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "agent"),
            eq(budgetPolicies.scopeId, agentId),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.hardStopEnabled, true),
          ),
        );

      for (const policy of agentPolicies) {
        const observed = await getObservedCents(db, "agent", agentId, companyId, start, end);
        if (observed >= policy.amountCents) {
          return `Agent budget exceeded: ${observed} of ${policy.amountCents} cents used this month`;
        }
      }

      // Check company-scoped policies
      const companyPolicies = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "company"),
            eq(budgetPolicies.scopeId, companyId),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.hardStopEnabled, true),
          ),
        );

      for (const policy of companyPolicies) {
        const observed = await getObservedCents(db, "company", companyId, companyId, start, end);
        if (observed >= policy.amountCents) {
          return `Company budget exceeded: ${observed} of ${policy.amountCents} cents used this month`;
        }
      }

      return null;
    },

    // ----- evaluateCostEvent -----
    async evaluateCostEvent(agentId: string, companyId: string) {
      const { start, end } = calendarMonthWindow();

      // Gather all active policies that apply (agent-scoped + company-scoped)
      const policies = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.isActive, true),
          ),
        );

      const relevantPolicies = policies.filter(
        (p) =>
          (p.scopeType === "agent" && p.scopeId === agentId) ||
          (p.scopeType === "company" && p.scopeId === companyId),
      );

      for (const policy of relevantPolicies) {
        const observed = await getObservedCents(
          db,
          policy.scopeType,
          policy.scopeId,
          companyId,
          start,
          end,
        );

        // Check hard stop first
        if (policy.hardStopEnabled && observed >= policy.amountCents) {
          const incident = await createIncidentIfNeeded(db, policy, "hard_stop", observed, start, end);
          // Emit cancellation signal only on a newly-created incident so the
          // signal fires once per breach, not on every subsequent cost event.
          if (incident) {
            const scope: BudgetEnforcementScope = {
              companyId: policy.companyId,
              scopeType: policy.scopeType as "company" | "agent",
              scopeId: policy.scopeId,
            };
            emitBudgetExhausted(scope);
          }
        }
        // Check warning threshold
        else if (observed >= (policy.amountCents * policy.warnPercent) / 100) {
          await createIncidentIfNeeded(db, policy, "warning", observed, start, end);
        }
      }
    },

    // ----- resolveIncident -----
    async resolveIncident(
      incidentId: string,
      companyId: string,
      input: ResolveBudgetIncident,
    ) {
      const incident = await db
        .select()
        .from(budgetIncidents)
        .where(
          and(
            eq(budgetIncidents.id, incidentId),
            eq(budgetIncidents.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!incident) {
        throw new Error("Incident not found");
      }

      if (incident.status !== "open") {
        throw new Error("Incident is not open");
      }

      const now = new Date();

      if (input.action === "raise_and_resume") {
        // Raise the policy limit
        if (input.newAmountCents !== undefined) {
          await db
            .update(budgetPolicies)
            .set({ amountCents: input.newAmountCents, updatedAt: now })
            .where(eq(budgetPolicies.id, incident.policyId));
        }

        // Resolve the incident
        await db
          .update(budgetIncidents)
          .set({ status: "resolved", resolvedAt: now, updatedAt: now })
          .where(eq(budgetIncidents.id, incidentId));

        // If the agent was paused by a hard stop, resume it
        if (incident.thresholdType === "hard_stop" && incident.scopeType === "agent") {
          await db
            .update(agents)
            .set({ status: "idle", updatedAt: now })
            .where(and(eq(agents.id, incident.scopeId), eq(agents.status, "paused")));

          logger.info(
            { agentId: incident.scopeId, incidentId },
            "Agent resumed after budget raise",
          );
        }

        // Resolve the associated approval if any
        if (incident.approvalId) {
          await db
            .update(approvals)
            .set({ status: "approved", decidedAt: now, updatedAt: now })
            .where(eq(approvals.id, incident.approvalId));
        }

      } else {
        // Dismiss
        await db
          .update(budgetIncidents)
          .set({ status: "dismissed", resolvedAt: now, updatedAt: now })
          .where(eq(budgetIncidents.id, incidentId));

        if (incident.approvalId) {
          await db
            .update(approvals)
            .set({ status: "rejected", decidedAt: now, updatedAt: now })
            .where(eq(approvals.id, incident.approvalId));
        }
      }

      return { ok: true };
    },
  };
}
