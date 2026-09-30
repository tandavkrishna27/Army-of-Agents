// server/src/services/job-budget-cost-bridge.ts
//
// JOB-012 — Preserve budget and authoritative cost policy (parity/shadow bridge).
//
// A distributed attempt's ACCEPTED usage event must be priced by the EXISTING
// budget/cost authority EXACTLY ONCE — never a parallel ledger, never a worker-supplied
// price, never a second capacity-release engine. This bridge:
//
//   * Reads the worker event's BOUNDED USAGE UNITS only (input/output/cached tokens +
//     runtime millis). It NEVER reads a price from the worker.
//   * The SERVER resolves provider/model/biller/billing-type/rate/version/rounding via
//     the versioned, FAIL-CLOSED `resolveAuthoritativeRate` — an unknown model throws
//     BEFORE any write (0 cost_events, 0 receipts).
//   * Charges the EXISTING cost writer ONCE per accepted-event identity (agent-bearing
//     task_run → costService.createEvent w/ agent+company rollup; every other source →
//     the agent-less recordOneShotCliCost w/ company rollup), stamping
//     cost_events.project_id so DEPARTMENT policies observe the spend.
//   * Writes a JOB-005 projection RECEIPT (`authoritative_cost`) linking the cost_events
//     row to the distributed attempt, guarded by the active fence.
//   * Drives the EXISTING budget engine SYNCHRONOUSLY (not the legacy fire-and-forget):
//     warning/incident/pause/emit at agent+company+department scope, and on a NEW
//     hard-stop breach drives the EXISTING `requestCancellation` — which releases the
//     attempt's Organization capacity slot EXACTLY ONCE (JOB-007 owns admit/release; the
//     bridge never runs a second release engine of its own).
//
// THE load-bearing exactly-once invariant: `costService.createEvent` /
// `recordOneShotCliCost` have NO native dedup. On a replay the JOB-005 receipt identity
// (org, company, projection_kind, source_identity=`cost:{company}:{eventId}`) is the
// guard. So the charge moment does a receipt FAST-PATH lookup BEHIND the fence lock
// BEFORE the non-idempotent charge — exactly like JOB-011's product-approval path. The
// new `cost_events (company_id, source_idempotency_key)` partial unique is the DB
// backstop if the lock/fast-path is ever bypassed.
//
// Flag gate: when distributed execution is OFF, every entrypoint refuses fail-closed
// and touches NOTHING, so every current path stays byte-for-byte unchanged. The rollback
// gate (`assertRollbackSafe`) fails closed while an `authoritative_cost` receipt is
// pending, so disabling can never erase or skip an authoritative charge.

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { jobProjectionReceipts } from "@armyofagents/db";
import type { ActiveFenceRequest, Db } from "@armyofagents/db";
import type { SubmitJobSource } from "@armyofagents/shared";
import { runInTenant } from "../db/tenant-context.js";
import { readDistributedExecutionDeploymentFlag } from "../config/distributed-execution.js";
import { resolveCompanyOrganizationId } from "./org-concurrency.js";
import { assertAdmissibleMappedOrganization } from "./tenant-admission.js";
import { budgetService } from "./budgets.js";
import { costService } from "./costs.js";
import { recordOneShotCliCost } from "./one-shot-cli-budget.js";
import { resolveAuthoritativeRate, type AuthoritativeUsageUnits } from "./job-authoritative-rate.js";
import type { AuthenticatedJobPrincipal } from "./job-submission.js";

/** The actor a bridge caller presents — the authenticated principal plus the Company
 * scope needed to resolve the immutable Company→Organization ownership edge. */
export type BridgeActor = AuthenticatedJobPrincipal & { companyId: string };

export interface PriceAcceptedUsageInput {
  /** The submission source — decides agent-bearing vs agent-less charge + rate model. */
  source: SubmitJobSource;
  actor: BridgeActor;
  /** The LIVE distributed attempt to bind the charge to (composite FK + fence). */
  fence: ActiveFenceRequest;
  /** The accepted usage event id — the stable per-charge source identity. */
  acceptedEventId: string;
  /** The accepted event's digest (64-hex reused as the receipt digest). */
  eventDigest: string;
  /** BOUNDED UNITS ONLY. The bridge NEVER reads a price from here. */
  units: AuthoritativeUsageUnits;
  /** Department attribution → cost_events.project_id (department policies observe it). */
  projectId?: string | null;
  /** When set (defaults now) — override only for tests/backfills. */
  occurredAt?: Date;
}

export interface PriceAcceptedUsageOutcome {
  status: "charged" | "replayed";
  costEventId: string | null;
  receiptId: string | null;
  costCents: number | null;
  incidentCreated: boolean;
  cancelled: boolean;
}

/** Thrown when any bridge entrypoint is called while distributed execution is off.
 * Fail-closed: the bridge does nothing, so the legacy path is untouched. */
export class JobBudgetCostBridgeDisabledError extends Error {
  readonly code = "JOB_BUDGET_COST_BRIDGE_DISABLED";
  constructor() {
    super("Job budget/cost bridge is disabled while distributed execution is off");
    this.name = "JobBudgetCostBridgeDisabledError";
  }
}

/** Thrown by the rollback gate while an `authoritative_cost` receipt is still pending —
 * disabling the bridge must never erase or skip an in-flight authoritative charge. */
export class JobBudgetCostBridgeRollbackPendingError extends Error {
  readonly code = "JOB_BUDGET_COST_BRIDGE_ROLLBACK_PENDING";
  constructor() {
    super("Cannot disable the budget/cost bridge while an authoritative-cost receipt is pending");
    this.name = "JobBudgetCostBridgeRollbackPendingError";
  }
}

export interface JobBudgetCostBridge {
  isEnabled(): boolean;
  priceAcceptedUsage(input: PriceAcceptedUsageInput): Promise<PriceAcceptedUsageOutcome>;
  assertRollbackSafe(companyId: string): Promise<void>;
}

const AUTHORITATIVE_COST_KIND = "authoritative_cost" as const;

/** The authoritative-cost receipt source identity — keyed on the accepted event id,
 * since the cost writers have NO native dedup and the receipt is the sole replay guard. */
function costSourceIdentity(companyId: string, acceptedEventId: string): string {
  return `cost:${companyId}:${acceptedEventId}`;
}

/** Normalize the caller's event digest to the 64-hex the receipt CHECK requires. */
function normalizeDigest(eventDigest: string): string {
  return /^[0-9a-f]{64}$/.test(eventDigest)
    ? eventDigest
    : createHash("sha256").update(eventDigest).digest("hex");
}

/** Read the authoritative-cost receipt for this identity (the replay fast-path). */
async function findCostReceipt(
  tx: Db,
  organizationId: string,
  companyId: string,
  sourceIdentity: string,
): Promise<{ id: string; targetAggregateId: string; status: string } | null> {
  const [row] = await tx
    .select({
      id: jobProjectionReceipts.id,
      targetAggregateId: jobProjectionReceipts.targetAggregateId,
      status: jobProjectionReceipts.status,
    })
    .from(jobProjectionReceipts)
    .where(and(
      eq(jobProjectionReceipts.organizationId, organizationId),
      eq(jobProjectionReceipts.companyId, companyId),
      eq(jobProjectionReceipts.projectionKind, AUTHORITATIVE_COST_KIND),
      eq(jobProjectionReceipts.sourceIdentity, sourceIdentity),
    ))
    .limit(1);
  return row ?? null;
}

export function jobBudgetCostBridge(
  appDb: Db,
  options?: { env?: Record<string, string | undefined> },
): JobBudgetCostBridge {
  const env = options?.env ?? process.env;

  function assertEnabled(): void {
    if (!readDistributedExecutionDeploymentFlag(env)) {
      throw new JobBudgetCostBridgeDisabledError();
    }
  }

  async function resolveAdmissibleOrganization(companyId: string): Promise<string> {
    const organizationId = await resolveCompanyOrganizationId(appDb, companyId);
    assertAdmissibleMappedOrganization(organizationId);
    return organizationId as string;
  }

  /** Charge the EXISTING cost writer ONCE. task_run rolls up its owning agent; every
   * other source is agent-less (company rollup only). Both stamp project_id + the
   * server rate/idempotency columns. Budget evaluation is deferred to the caller. */
  async function chargeOnce(
    tx: Db,
    input: PriceAcceptedUsageInput,
    companyId: string,
    priced: Awaited<ReturnType<typeof resolveAuthoritativeRate>>,
    sourceIdentity: string,
  ): Promise<{ id: string }> {
    const occurredAt = input.occurredAt ?? new Date();
    if (input.source.kind === "task_run") {
      const event = await costService(tx).createEvent(
        companyId,
        {
          agentId: input.source.assigneeAgentId,
          provider: priced.provider,
          biller: priced.biller,
          billingType: priced.billingType,
          model: priced.model,
          inputTokens: input.units.inputTokens,
          cachedInputTokens: input.units.cachedInputTokens,
          outputTokens: input.units.outputTokens,
          costCents: priced.costCents,
          occurredAt,
          // Department attribution (department budget policies observe this). Issue-level
          // provenance is a documented follow-up — omitted here to keep the authoritative
          // charge dependent only on the department scope the ticket requires.
          projectId: input.projectId ?? null,
          sourceIdempotencyKey: sourceIdentity,
          rateId: priced.rateId,
          rateVersion: priced.rateVersion,
          roundingMode: priced.roundingMode,
        },
        { deferBudgetEvaluation: true },
      );
      return { id: event.id };
    }
    const event = await recordOneShotCliCost(tx, {
      companyId,
      provider: priced.provider,
      model: priced.model,
      inputTokens: input.units.inputTokens,
      outputTokens: input.units.outputTokens,
      cachedInputTokens: input.units.cachedInputTokens,
      costCents: priced.costCents,
      billingType: priced.billingType,
      biller: priced.biller,
      projectId: input.projectId ?? null,
      sourceIdempotencyKey: sourceIdentity,
      rateId: priced.rateId,
      rateVersion: priced.rateVersion,
      roundingMode: priced.roundingMode,
      occurredAt,
    });
    return { id: event.id };
  }

  return {
    isEnabled(): boolean {
      return readDistributedExecutionDeploymentFlag(env);
    },

    async priceAcceptedUsage(input) {
      assertEnabled();
      const companyId = input.actor.companyId;
      const organizationId = await resolveAdmissibleOrganization(companyId);
      // Only task_run has a concrete agents.id to roll up + evaluate against; every
      // other source is agent-less (company/department scope only).
      const evalAgentId = input.source.kind === "task_run" ? input.source.assigneeAgentId : null;
      const projectId = input.projectId ?? null;

      return runInTenant(appDb, organizationId, async (repos, tx) => {
        // (a) TOCTOU guard — lock the lease+attempt FOR UPDATE (write nothing) so two
        // concurrent same-event charges serialize: the 2nd blocks until the 1st commits
        // its receipt, then observes it and replays. Without this the cost writers'
        // lack of native dedup would let both insert a charge.
        await repos.jobControl.lockActiveFence(input.fence);

        // (b) RECEIPT FAST-PATH — a replay returns the already-linked cost_events row
        // WITHOUT a second charge.
        const sourceIdentity = costSourceIdentity(companyId, input.acceptedEventId);
        const existing = await findCostReceipt(tx, organizationId, companyId, sourceIdentity);
        if (existing) {
          return {
            status: "replayed" as const,
            costEventId: existing.targetAggregateId,
            receiptId: existing.id,
            costCents: null,
            incidentCreated: false,
            cancelled: false,
          };
        }

        // (c) SERVER-SIDE resolution — FAIL CLOSED on an unknown rate BEFORE any write.
        const priced = await resolveAuthoritativeRate(tx, {
          source: input.source,
          companyId,
          units: input.units,
        });

        // (e) CHARGE ONCE via the existing writer.
        const costEvent = await chargeOnce(tx, input, companyId, priced, sourceIdentity);

        // (f) RECEIPT applied in the SAME tenant transaction (fence-guarded).
        const recorded = await repos.jobControl.recordGovernedProjection({
          ...input.fence,
          projection: {
            projectionKind: AUTHORITATIVE_COST_KIND,
            aggregateKind: "cost_events",
            sourceIdentity,
            sourceDigest: normalizeDigest(input.eventDigest),
            targetAggregateId: costEvent.id,
            status: "applied",
          },
        });

        // (g) AFTER-COST — SYNCHRONOUS budget evaluation (not the legacy fire-and-forget),
        // so a newly-created incident is visible in this committed state.
        const evaluated = await budgetService(tx).evaluateCostEvent(evalAgentId, companyId, { projectId });

        // (h) exhaustion → cancel for the distributed attempt via the EXISTING engine
        // (which releases the capacity slot EXACTLY ONCE). Cancel whenever THIS attempt's
        // own charge crosses an applicable hard stop — NOT only when it won the
        // one-incident-per-window insert — so a concurrent sibling that crosses an
        // already-breached cap is still cancelled instead of overspending. commandId is
        // derived from the job so repeated over-budget charges on the same job dedup to
        // ONE cancel control (keyed on (org, lease, commandId)).
        let cancelled = false;
        if (evaluated.hardStopBreached) {
          const cancel = await repos.jobControl.requestCancellation({
            organizationId,
            companyId,
            jobId: input.fence.jobId,
            reason: "budget_exhausted",
            graceful: true,
            commandId: input.fence.jobId,
            now: new Date(),
          });
          cancelled = ["queued", "already_requested", "cancelled"].includes(cancel.status);
        }

        return {
          status: "charged" as const,
          costEventId: costEvent.id,
          receiptId: recorded.receiptId,
          costCents: priced.costCents,
          incidentCreated: evaluated.hardStopIncidentCreated,
          cancelled,
        };
      });
    },

    async assertRollbackSafe(companyId) {
      // Deliberately NOT flag-gated: the rollback gate is consulted DURING the disable
      // transition (the flag may already be off). It fails closed while any
      // authoritative-cost receipt is still pending so a charge can never be erased.
      const organizationId = await resolveAdmissibleOrganization(companyId);
      await runInTenant(appDb, organizationId, async (_repos, tx) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(jobProjectionReceipts)
          .where(and(
            eq(jobProjectionReceipts.organizationId, organizationId),
            eq(jobProjectionReceipts.companyId, companyId),
            eq(jobProjectionReceipts.projectionKind, AUTHORITATIVE_COST_KIND),
            eq(jobProjectionReceipts.status, "pending"),
          ));
        if ((row?.n ?? 0) > 0) throw new JobBudgetCostBridgeRollbackPendingError();
      });
    },
  };
}
