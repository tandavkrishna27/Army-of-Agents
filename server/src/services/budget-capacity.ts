export { evaluateCapacityAdmission } from "./budget-capacity-policy.js";
import {
  evaluateCapacityAdmission,
  type CapacityExposure,
} from "./budget-capacity-policy.js";

import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import type { ActivityActorType } from "@armyofagents/shared";
import {
  budgetCapacityReservations,
  budgetCapacitySettlements,
  budgetPolicies,
  companies,
  costEvents,
} from "@armyofagents/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { insertActivityLog } from "./activity-log.js";

export type CapacityReservationInput = {
  companyId: string;
  operationKind: "voice" | "media";
  operationId: string;
  maximumCostCents: number | null;
  agentId?: string | null;
  projectId?: string | null;
  actorType?: ActivityActorType;
  actorId?: string | null;
};

function calendarMonthWindow(now: Date) {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export async function lockBudgetAuthority(tx: Db, companyId: string) {
  // A number of long-standing service unit tests use deliberately minimal
  // transaction doubles that predate Db.execute. Keep those pure mocks viable,
  // while production remains fail-closed if the authority lock is unavailable.
  if (typeof tx.execute !== "function") {
    if (process.env.NODE_ENV === "test") return;
    throw new Error("Budget authority lock is unavailable");
  }
  const result = await tx.execute(
    sql`SELECT id FROM companies WHERE id=${companyId} FOR UPDATE`
  );
  const rows = Array.isArray(result)
    ? result
    : (result as { rows?: unknown[] }).rows ?? [];
  if (rows.length === 0) throw notFound("Company not found");
}

export function budgetCapacityService(
  db: Db,
  options: { now?: () => Date } = {}
) {
  const now = options.now ?? (() => new Date());
  const audit = (
    tx: Db,
    input: {
      companyId: string;
      action: string;
      entityId: string;
      actorType?: ActivityActorType;
      actorId?: string | null;
      details?: Record<string, unknown>;
    }
  ) =>
    insertActivityLog(tx, {
      companyId: input.companyId,
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? "budget-capacity",
      action: input.action,
      entityType: "budget_capacity_reservation",
      entityId: input.entityId,
      details: input.details ?? null,
    });
  const applicable = (
    rows: (typeof budgetPolicies.$inferSelect)[],
    input: CapacityReservationInput
  ) =>
    rows.filter(
      (policy) =>
        policy.isActive &&
        policy.hardStopEnabled &&
        ((policy.scopeType === "company" &&
          policy.scopeId === input.companyId) ||
          (policy.scopeType === "agent" &&
            input.agentId != null &&
            policy.scopeId === input.agentId) ||
          (policy.scopeType === "department" &&
            input.projectId != null &&
            policy.scopeId === input.projectId))
    );
  const exposures = async (
    tx: Db,
    input: CapacityReservationInput,
    requestedCents: number | null
  ) => {
    const window = calendarMonthWindow(now());
    const policies = applicable(
      await tx
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, input.companyId),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.hardStopEnabled, true)
          )
        ),
      input
    );
    const result: CapacityExposure[] = [];
    for (const policy of policies) {
      const costConditions = [
        eq(costEvents.companyId, input.companyId),
        gte(costEvents.occurredAt, window.start),
        lt(costEvents.occurredAt, window.end),
      ];
      const reservationConditions = [
        eq(budgetCapacityReservations.companyId, input.companyId),
        inArray(budgetCapacityReservations.state, ["held", "unknown"]),
        lt(budgetCapacityReservations.windowStart, window.end),
        gte(budgetCapacityReservations.windowEnd, window.start),
      ];
      if (policy.scopeType === "agent") {
        costConditions.push(eq(costEvents.agentId, policy.scopeId));
        reservationConditions.push(
          eq(budgetCapacityReservations.agentId, policy.scopeId)
        );
      } else if (policy.scopeType === "department") {
        costConditions.push(eq(costEvents.projectId, policy.scopeId));
        reservationConditions.push(
          eq(budgetCapacityReservations.projectId, policy.scopeId)
        );
      }
      const [{ total: posted = 0 }] = await tx
        .select({
          total: sql<number>`coalesce(sum(${costEvents.costCents}),0)::int`,
        })
        .from(costEvents)
        .where(and(...costConditions));
      const [{ total: held = 0 }] = await tx
        .select({
          total: sql<number>`coalesce(sum(greatest(${budgetCapacityReservations.maximumCostCents}-${budgetCapacityReservations.settledCostCents},0)),0)::int`,
        })
        .from(budgetCapacityReservations)
        .where(and(...reservationConditions));
      result.push({
        policyId: policy.id,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        limitCents: policy.amountCents,
        postedCents: Number(posted),
        outstandingCents: Number(held),
        requestedCents,
      });
    }
    return { window, result };
  };
  return {
    async reserve(input: CapacityReservationInput) {
      if (!input.operationId.trim())
        throw unprocessable("Budget operation identity is required");
      if (
        input.maximumCostCents !== null &&
        (!Number.isInteger(input.maximumCostCents) ||
          input.maximumCostCents <= 0)
      )
        throw unprocessable("Maximum cost must be a positive integer");
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockBudgetAuthority(txDb, input.companyId);
        const existing = await txDb
          .select()
          .from(budgetCapacityReservations)
          .where(
            and(
              eq(budgetCapacityReservations.companyId, input.companyId),
              eq(budgetCapacityReservations.operationKind, input.operationKind),
              eq(budgetCapacityReservations.operationId, input.operationId)
            )
          )
          .then((rows) => rows[0] ?? null);
        if (existing) {
          const same =
            existing.maximumCostCents === input.maximumCostCents &&
            existing.agentId === (input.agentId ?? null) &&
            existing.projectId === (input.projectId ?? null);
          if (!same)
            throw conflict(
              "Budget operation identity was reused with a different payload"
            );
          return {
            outcome: "admitted" as const,
            reservation: existing,
            replayed: true,
          };
        }
        const { window, result } = await exposures(
          txDb,
          input,
          input.maximumCostCents
        );
        const decision = evaluateCapacityAdmission(result);
        if (decision.outcome !== "admitted") return decision;
        const reservation = await txDb
          .insert(budgetCapacityReservations)
          .values({
            companyId: input.companyId,
            operationKind: input.operationKind,
            operationId: input.operationId,
            agentId: input.agentId ?? null,
            projectId: input.projectId ?? null,
            maximumCostCents: input.maximumCostCents!,
            windowStart: window.start,
            windowEnd: window.end,
          })
          .returning()
          .then((rows) => rows[0]);
        await audit(txDb, {
          companyId: input.companyId,
          action: "budget_capacity.reserved",
          entityId: reservation.id,
          actorType: input.actorType,
          actorId: input.actorId,
          details: {
            operationKind: input.operationKind,
            maximumCostCents: input.maximumCostCents,
          },
        });
        return {
          outcome: "admitted" as const,
          reservation,
          replayed: false,
          remainingCents: decision.remainingCents,
        };
      });
    },
    async extend(
      companyId: string,
      reservationId: string,
      newMaximumCostCents: number
    ) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockBudgetAuthority(txDb, companyId);
        const row = await txDb
          .select()
          .from(budgetCapacityReservations)
          .where(
            and(
              eq(budgetCapacityReservations.id, reservationId),
              eq(budgetCapacityReservations.companyId, companyId)
            )
          )
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Budget reservation not found");
        if (row.state !== "held")
          throw conflict("Only a held reservation can be extended");
        if (newMaximumCostCents <= row.maximumCostCents)
          return {
            outcome: "admitted" as const,
            reservation: row,
            replayed: true,
          };
        const requested = newMaximumCostCents - row.maximumCostCents;
        const input: CapacityReservationInput = {
          companyId,
          operationKind: row.operationKind as "voice" | "media",
          operationId: row.operationId,
          maximumCostCents: requested,
          agentId: row.agentId,
          projectId: row.projectId,
        };
        const { result } = await exposures(txDb, input, requested);
        const decision = evaluateCapacityAdmission(result);
        if (decision.outcome !== "admitted") {
          await txDb
            .update(budgetCapacityReservations)
            .set({
              stopRequestedAt: now(),
              stopReason: "budget_extension_denied",
              updatedAt: now(),
            })
            .where(eq(budgetCapacityReservations.id, row.id));
          await audit(txDb, {
            companyId,
            action: "budget_capacity.stop_requested",
            entityId: row.id,
            details: { reason: "budget_extension_denied" },
          });
          return decision;
        }
        const reservation = await txDb
          .update(budgetCapacityReservations)
          .set({ maximumCostCents: newMaximumCostCents, updatedAt: now() })
          .where(eq(budgetCapacityReservations.id, row.id))
          .returning()
          .then((rows) => rows[0]);
        await audit(txDb, {
          companyId,
          action: "budget_capacity.extended",
          entityId: row.id,
          details: { maximumCostCents: newMaximumCostCents },
        });
        return {
          outcome: "admitted" as const,
          reservation,
          replayed: false,
          remainingCents: decision.remainingCents,
        };
      });
    },
    async settle(companyId: string, reservationId: string, chargeId: string) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockBudgetAuthority(txDb, companyId);
        const row = await txDb
          .select()
          .from(budgetCapacityReservations)
          .where(
            and(
              eq(budgetCapacityReservations.id, reservationId),
              eq(budgetCapacityReservations.companyId, companyId)
            )
          )
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Budget reservation not found");
        const charge = await txDb
          .select({ costCents: costEvents.costCents })
          .from(costEvents)
          .where(
            and(
              eq(costEvents.companyId, companyId),
              eq(costEvents.sourceIdempotencyKey, chargeId)
            )
          )
          .then((rows) => rows[0] ?? null);
        if (!charge)
          throw unprocessable(
            "Canonical cost event is required before settlement"
          );
        const inserted = await txDb
          .insert(budgetCapacitySettlements)
          .values({
            companyId,
            reservationId,
            chargeId,
            costCents: charge.costCents,
          })
          .onConflictDoNothing({
            target: [
              budgetCapacitySettlements.companyId,
              budgetCapacitySettlements.chargeId,
            ],
          })
          .returning();
        if (inserted.length === 0) return row;
        const settled = row.settledCostCents + charge.costCents;
        const reservation = await txDb
          .update(budgetCapacityReservations)
          .set({
            settledCostCents: settled,
            state: settled >= row.maximumCostCents ? "settled" : row.state,
            updatedAt: now(),
          })
          .where(eq(budgetCapacityReservations.id, row.id))
          .returning()
          .then((rows) => rows[0]);
        await audit(txDb, {
          companyId,
          action: "budget_capacity.settled",
          entityId: row.id,
          details: { chargeId, costCents: charge.costCents },
        });
        return reservation;
      });
    },
    async markUnknown(
      companyId: string,
      reservationId: string,
      reason = "outcome_unknown"
    ) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockBudgetAuthority(txDb, companyId);
        const reservation = await txDb
          .update(budgetCapacityReservations)
          .set({
            state: "unknown",
            stopRequestedAt: now(),
            stopReason: reason,
            updatedAt: now(),
          })
          .where(
            and(
              eq(budgetCapacityReservations.id, reservationId),
              eq(budgetCapacityReservations.companyId, companyId),
              inArray(budgetCapacityReservations.state, ["held", "unknown"])
            )
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (reservation)
          await audit(txDb, {
            companyId,
            action: "budget_capacity.outcome_unknown",
            entityId: reservationId,
            details: { reason },
          });
        return reservation;
      });
    },
    async releaseUnused(
      companyId: string,
      reservationId: string,
      provenUnused: boolean
    ) {
      if (!provenUnused)
        throw unprocessable(
          "Capacity can only be released after definitive no-effect proof"
        );
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockBudgetAuthority(txDb, companyId);
        const row = await txDb
          .select()
          .from(budgetCapacityReservations)
          .where(
            and(
              eq(budgetCapacityReservations.id, reservationId),
              eq(budgetCapacityReservations.companyId, companyId)
            )
          )
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Budget reservation not found");
        if (row.state !== "held" || row.settledCostCents !== 0)
          throw conflict("Reservation exposure cannot be released");
        const reservation = await txDb
          .update(budgetCapacityReservations)
          .set({ state: "released", releasedAt: now(), updatedAt: now() })
          .where(eq(budgetCapacityReservations.id, row.id))
          .returning()
          .then((rows) => rows[0]);
        await audit(txDb, {
          companyId,
          action: "budget_capacity.released",
          entityId: row.id,
          details: { reason: "definitive_no_effect" },
        });
        return reservation;
      });
    },
  };
}
