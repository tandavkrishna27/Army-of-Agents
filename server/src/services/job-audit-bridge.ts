// server/src/services/job-audit-bridge.ts
//
// JOB-013 — Preserve transactional activity audit (parity bridge).
//
// One ACCEPTED state/control/accounting mutation on a distributed attempt must write the
// EXISTING activity_log (+ an OPTIONAL hub_audit, only when the mutation is a hub lifecycle
// action) AND a JOB-005 projection RECEIPT IN ONE tenant transaction, and PUBLISH the live
// `activity.logged` event ONLY AFTER that transaction commits. This bridge:
//
//   * Persists ONLY the caller-supplied `activity` action (the EXISTING product audit
//     contract). It reads NO field of any worker observation/usage payload — a worker
//     OBSERVATION alone (poll/ack lifecycle) NEVER becomes an accepted product action; only
//     a server-accepted mutation calls this bridge.
//   * Forces `runId: null` on the activity insert: a distributed attemptId is NOT a
//     heartbeat_runs row, so writing it as activity_log.run_id would violate that FK and
//     roll back the whole tx. The job/attempt provenance rides the RECEIPT's composite FK.
//   * Writes a JOB-005 `activity_audit` receipt linking the activity_log row to the
//     distributed attempt, guarded by the active fence, in the SAME tenant transaction.
//   * Defers the live publish to an after-commit drain (never inline, never pre-commit): a
//     mid-tx failure exits runInTenant before the drain, so a rollback publishes NOTHING.
//
// THE load-bearing exactly-once invariant: insertActivityLog has NO native dedup. On a
// replay the JOB-005 receipt identity (org, company, projection_kind,
// source_identity=`activity:{company}:{eventId}`) is the guard, so the bridge does a receipt
// FAST-PATH lookup BEHIND the fence lock BEFORE the (non-idempotent) activity insert. The
// optional hub_audit row self-dedups on its `(company_id, idempotency_key)` partial unique.
//
// Flag gate: when distributed execution is OFF, every entrypoint refuses fail-closed and
// touches NOTHING, so every current activity path stays byte-for-byte unchanged. The
// rollback gate (`assertRollbackSafe`) fails closed while an `activity_audit` receipt is
// pending, so disabling can never lose or skip an accepted mutation's audit.

import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { jobProjectionReceipts, hubAudit } from "@armyofagents/db";
import type { ActiveFenceRequest, Db } from "@armyofagents/db";
import type { SubmitJobSource } from "@armyofagents/shared";
import { runInTenant } from "../db/tenant-context.js";
import { readDistributedExecutionDeploymentFlag } from "../config/distributed-execution.js";
import { resolveCompanyOrganizationId } from "./org-concurrency.js";
import { assertAdmissibleMappedOrganization } from "./tenant-admission.js";
import { insertActivity, publishActivity, type LogActivityInput } from "./activity-log.js";
import type { AuthenticatedJobPrincipal } from "./job-submission.js";

/** The actor a bridge caller presents — the authenticated principal plus the Company
 * scope needed to resolve the immutable Company→Organization ownership edge. */
export type BridgeActor = AuthenticatedJobPrincipal & { companyId: string };

/** The OPTIONAL hub-lifecycle audit an accepted mutation supplies when (and only when) it
 * is a hub-item lifecycle action. Deduped by the `activity_audit:{eventId}` idempotency key
 * on the hub_audit `(company_id, idempotency_key)` partial unique. */
export interface RecordAcceptedActivityHubAudit {
  /** Usually null (the accepted mutation has no owning hub item). NEVER cascade-delete. */
  hubItemId?: string | null;
  actorType: string;
  actorId: string;
  action: string;
  authorityBasis?: string | null;
  autonomyLevel?: string | null;
  priorState?: unknown;
  sourceRevision?: string | null;
  reason?: string | null;
  decisionContext?: unknown;
  undoDeadline?: Date | null;
}

export interface RecordAcceptedActivityInput {
  /** The submission source — the typed, server-owned provenance of the accepted mutation
   * (never a worker payload). Carried for the accepted-action contract; the audit content
   * comes entirely from `activity`. */
  source: SubmitJobSource;
  actor: BridgeActor;
  /** The LIVE distributed attempt to bind the audit to (composite FK + fence). */
  fence: ActiveFenceRequest;
  /** The accepted-mutation id — the stable per-mutation receipt source identity. */
  acceptedEventId: string;
  /** The accepted event's digest (64-hex reused, else sha256-normalized, as receipt digest). */
  eventDigest: string;
  /** The EXISTING activity action the accepted mutation supplies. `runId` is IGNORED
   * (forced null — a distributed attemptId is not a heartbeat_runs row). */
  activity: LogActivityInput;
  /** Present ONLY when the accepted mutation is a hub-item lifecycle action. */
  hubAudit?: RecordAcceptedActivityHubAudit;
}

export interface RecordAcceptedActivityOutcome {
  status: "recorded" | "replayed";
  activityId: string | null;
  receiptId: string | null;
  hubAuditId: string | null;
}

/** Thrown when any bridge entrypoint is called while distributed execution is off.
 * Fail-closed: the bridge does nothing, so the legacy activity path is untouched. */
export class JobAuditBridgeDisabledError extends Error {
  readonly code = "JOB_AUDIT_BRIDGE_DISABLED";
  constructor() {
    super("Job audit bridge is disabled while distributed execution is off");
    this.name = "JobAuditBridgeDisabledError";
  }
}

/** Thrown by the rollback gate while an `activity_audit` receipt is still pending —
 * disabling the bridge must never lose or skip an in-flight accepted-mutation audit. */
export class JobAuditBridgeRollbackPendingError extends Error {
  readonly code = "JOB_AUDIT_BRIDGE_ROLLBACK_PENDING";
  constructor() {
    super("Cannot disable the audit bridge while an activity_audit receipt is pending");
    this.name = "JobAuditBridgeRollbackPendingError";
  }
}

export interface JobAuditBridge {
  isEnabled(): boolean;
  recordAcceptedActivity(input: RecordAcceptedActivityInput): Promise<RecordAcceptedActivityOutcome>;
  assertRollbackSafe(companyId: string): Promise<void>;
}

const ACTIVITY_AUDIT_KIND = "activity_audit" as const;

/** The activity-audit receipt source identity — keyed on the accepted mutation id, since
 * insertActivityLog has NO native dedup and the receipt is the sole replay guard. */
function activitySourceIdentity(companyId: string, acceptedEventId: string): string {
  return `activity:${companyId}:${acceptedEventId}`;
}

/** Normalize the caller's event digest to the 64-hex the receipt CHECK requires. */
function normalizeDigest(eventDigest: string): string {
  return /^[0-9a-f]{64}$/.test(eventDigest)
    ? eventDigest
    : createHash("sha256").update(eventDigest).digest("hex");
}

/** Read the activity-audit receipt for this identity (the replay fast-path). */
async function findAuditReceipt(
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
      eq(jobProjectionReceipts.projectionKind, ACTIVITY_AUDIT_KIND),
      eq(jobProjectionReceipts.sourceIdentity, sourceIdentity),
    ))
    .limit(1);
  return row ?? null;
}

export function jobAuditBridge(
  appDb: Db,
  options?: { env?: Record<string, string | undefined> },
): JobAuditBridge {
  const env = options?.env ?? process.env;

  function assertEnabled(): void {
    if (!readDistributedExecutionDeploymentFlag(env)) {
      throw new JobAuditBridgeDisabledError();
    }
  }

  async function resolveAdmissibleOrganization(companyId: string): Promise<string> {
    const organizationId = await resolveCompanyOrganizationId(appDb, companyId);
    assertAdmissibleMappedOrganization(organizationId);
    return organizationId as string;
  }

  return {
    isEnabled(): boolean {
      return readDistributedExecutionDeploymentFlag(env);
    },

    async recordAcceptedActivity(input) {
      assertEnabled();
      const companyId = input.actor.companyId;
      const organizationId = await resolveAdmissibleOrganization(companyId);
      const afterCommit: Array<() => void> = [];

      const outcome = await runInTenant(appDb, organizationId, async (repos, tx) => {
        // (a) TOCTOU guard — lock the lease+attempt FOR UPDATE (write nothing) so two
        // concurrent same-event calls serialize: the 2nd blocks until the 1st commits its
        // receipt, then observes it and replays. insertActivityLog has NO native dedup, so
        // the lock + receipt fast-path + hub partial-unique are the only dup guards.
        await repos.jobControl.lockActiveFence(input.fence);

        // (b) RECEIPT FAST-PATH — a replay returns the already-linked activity_log row
        // WITHOUT a second insert (and without touching hub_audit).
        const sourceIdentity = activitySourceIdentity(companyId, input.acceptedEventId);
        const existing = await findAuditReceipt(tx, organizationId, companyId, sourceIdentity);
        if (existing) {
          return {
            status: "replayed" as const,
            activityId: existing.targetAggregateId,
            receiptId: existing.id,
            hubAuditId: null,
          };
        }

        // (c) MUTATION — the EXISTING activity_log write, callback-local on tx, publishes
        // NOTHING. runId is FORCED null: a distributed attemptId is not a heartbeat_runs row
        // (activity_log.run_id FK), so a passed-through runId would roll the whole tx back.
        const prepared = await insertActivity(tx, { ...input.activity, runId: null });

        // (d) OPTIONAL hub audit — same tx. NO ON CONFLICT: aoa_app is INSERT-ONLY on
        // hub_audit (no SELECT), and Postgres requires SELECT on the columns in a
        // conflict-target's index predicate — so `ON CONFLICT (…) WHERE idempotency_key
        // IS NOT NULL` would be denied. Idempotency is already guaranteed upstream: a
        // replay SHORT-CIRCUITS at the receipt fast-path (b) BEFORE reaching this insert,
        // and lockActiveFence (a) serializes concurrent same-fence callers so the 2nd sees
        // the committed receipt and replays. The `activity_audit:{eventId}` idempotency key
        // + the (company_id, idempotency_key) partial unique remain a fail-closed DB
        // backstop (a true duplicate key → 23505 → whole-tx rollback). Matches the existing
        // recordLifecycleAction insert, which likewise writes hub_audit without ON CONFLICT.
        // aoa_app cannot read hub_audit back (INSERT-only), so the id is generated
        // client-side for the outcome rather than via RETURNING.
        let hubAuditId: string | null = null;
        if (input.hubAudit) {
          hubAuditId = randomUUID();
          await tx.insert(hubAudit).values({
            id: hubAuditId,
            companyId,
            hubItemId: input.hubAudit.hubItemId ?? null,
            idempotencyKey: `activity_audit:${input.acceptedEventId}`,
            actorType: input.hubAudit.actorType,
            actorId: input.hubAudit.actorId,
            action: input.hubAudit.action,
            authorityBasis: input.hubAudit.authorityBasis ?? null,
            autonomyLevel: input.hubAudit.autonomyLevel ?? null,
            priorState: input.hubAudit.priorState ?? null,
            sourceRevision: input.hubAudit.sourceRevision ?? null,
            reason: input.hubAudit.reason ?? null,
            decisionContext: input.hubAudit.decisionContext ?? null,
            undoDeadline: input.hubAudit.undoDeadline ?? null,
          });
        }

        // (e) RECEIPT applied in the SAME tenant transaction, fence-guarded, linking the
        // activity_log row.
        const recorded = await repos.jobControl.recordGovernedProjection({
          ...input.fence,
          projection: {
            projectionKind: ACTIVITY_AUDIT_KIND,
            aggregateKind: "activity_log",
            sourceIdentity,
            sourceDigest: normalizeDigest(input.eventDigest),
            targetAggregateId: prepared.id,
            status: "applied",
          },
        });

        // (f) DEFER publish to AFTER commit — the load-bearing "publication after commit".
        afterCommit.push(() => publishActivity(prepared));
        return {
          status: "recorded" as const,
          activityId: prepared.id,
          receiptId: recorded.receiptId,
          hubAuditId,
        };
      });

      // Drained ONLY on a successful commit — a pre-commit throw exits runInTenant above
      // and never reaches here, so a rollback publishes nothing. Best-effort per closure.
      for (const publish of afterCommit) { try { publish(); } catch { /* best-effort live poke */ } }
      return outcome;
    },

    async assertRollbackSafe(companyId) {
      // Deliberately NOT flag-gated: the rollback gate is consulted DURING the disable
      // transition (the flag may already be off). It fails closed while any activity_audit
      // receipt is still pending so an accepted mutation's audit can never be lost.
      const organizationId = await resolveAdmissibleOrganization(companyId);
      await runInTenant(appDb, organizationId, async (_repos, tx) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(jobProjectionReceipts)
          .where(and(
            eq(jobProjectionReceipts.organizationId, organizationId),
            eq(jobProjectionReceipts.companyId, companyId),
            eq(jobProjectionReceipts.projectionKind, ACTIVITY_AUDIT_KIND),
            eq(jobProjectionReceipts.status, "pending"),
          ));
        if ((row?.n ?? 0) > 0) throw new JobAuditBridgeRollbackPendingError();
      });
    },
  };
}
