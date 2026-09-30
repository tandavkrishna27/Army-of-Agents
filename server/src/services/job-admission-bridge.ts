// server/src/services/job-admission-bridge.ts
//
// JOB-010 — Preserve admission and assignment invariants (parity/shadow bridge).
//
// `admitAndSubmit` bridges EVERY authenticated execution source to its EXISTING
// admission/assignment authority and records ONE immutable distributed submission in
// the SAME authoritative tenant transaction. It is a PARITY bridge, not a cutover:
//
//   * task_run is the ONLY frozen source that carries issue/run identity, so it is the
//     ONLY source whose legacy ASSIGNMENT authority the bridge actively drives — the
//     as-built `issueService.checkout` engine (an atomic conditional UPDATE, run-guarded
//     by `checkoutRunId`/`executionRunId`). Because checkout is run-guarded and
//     idempotent by run id, a legacy heartbeat claim and a bridge claim for the same run
//     converge on ONE winner; a concurrent different-run claim loses the conditional
//     UPDATE. A pre-commit throw (unmet dependency, ownership conflict, stale status)
//     rolls the whole transaction back BEFORE any `jobs` row exists → "rejects before job"
//     and "release on rollback" fall out of the transaction boundary (nothing to release).
//
//   * commander_turn / crew_run / one_shot / browser_request / service_reconcile carry NO
//     issue identity. The bridge NEVER fabricates a task for them (ticket non-goal). It
//     reuses the EXISTING per-source admission authority (`repos.jobControl.*IsAdmitted`,
//     invoked by `submitJobWithinTenant`) and records the submission; their real
//     claim/release/wakeup behaviour is characterized in the source-admission matrix.
//     commander_turn cannot be driven in-tx even in principle: `aoa_app` holds only SELECT
//     on `internal_agent_messages`, so `claimTurn` (an UPDATE) is out of the grant surface
//     — the bridge is inert for Commander and produces NO model/provider effect (shadow rule).
//
// The stable bridge-claim identity that links legacy ↔ distributed is the EXISTING
// `insertJobOnce` composite (authenticatedSourceIdentity = the run/operation/reconcile id);
// for task_run that is `jobs.authenticatedSourceIdentity == issues.executionRunId`. No new
// authoritative assignment/capacity column is introduced, and capacity claim/release stays
// owned by JOB-007 — the bridge never invokes a second capacity engine.
//
// Flag gate: when distributed execution is OFF, `admitAndSubmit` refuses fail-closed and
// touches NOTHING (no admission, no checkout, no submission), so every current path stays
// byte-for-byte unchanged. Rollback = disable the flag.

import type { Db } from "@armyofagents/db";
import type { SubmitJobResponse, SubmitJobSource } from "@armyofagents/shared";
import { runInTenant } from "../db/tenant-context.js";
import { readDistributedExecutionDeploymentFlag } from "../config/distributed-execution.js";
import { resolveCompanyOrganizationId } from "./org-concurrency.js";
// DE-27 (audit clause) — the capacity-refusal sink type (erased at compile time);
// `drainAdmissionDenial` is loaded dynamically at the drain point below.
import type { AdmissionDenialSink } from "./worker-admission-denial-audit.js";
import { assertAdmissibleMappedOrganization } from "./tenant-admission.js";
import { issueService } from "./issues.js";
import {
  findIdempotentReplay,
  submitJobWithinTenant,
  type AuthenticatedJobPrincipal,
  type SubmitJobRequest,
} from "./job-submission.js";

/**
 * The actor a bridge caller presents: the same authenticated principal `job-submission`
 * resolves, plus the Company scope needed to resolve the immutable Company→Organization
 * ownership edge (`resolveCompanyOrganizationId`). `AuthenticatedJobPrincipal` already
 * carries `role`/`commanderClaims`, so the bridge threads the full principal to the
 * frozen admission checks unchanged.
 */
export type BridgeActor = AuthenticatedJobPrincipal & { companyId: string };

// ---------------------------------------------------------------------------
// Per-source admission profile — the pure, testable encoding of the bridge's
// per-source decisions, cross-checked against the FROZEN parity authority
// (docs/architecture/distributed-execution-legacy-parity.json, Decision #121) by
// job-source-admission-matrix.test.ts. It carries no runtime effect; it is the
// characterization the ticket requires ("record each source's current
// claim/release/wakeup behaviour").

export type CheckoutAssignmentDisposition =
  // task_run — the bridge actively drives the legacy issue checkout engine in-tx.
  | "drives_issue_checkout"
  // crew_run — the legacy crew runner checks out its OWN payload issue at execute
  // time; the bridge admits the crew-dispatch source but never reconstructs an issue
  // from the opaque crewRunId (no fabricated task identity).
  | "reuses_checkout_engine_at_execute"
  // commander_turn / one_shot — no issue-locked run exists (frozen not_applicable).
  | "not_applicable"
  // browser_request / service_reconcile — net-new workload class, no issue.
  | "net_new_no_issue";

export type SourceAssignmentAuthority =
  | "issue_checkout"
  | "crew_dispatch_admission"
  | "commander_conversation_inert"
  | "extraction_or_stateless_engine"
  | "browser_session"
  | "service_instance_reconcile";

export type OneShotEngine =
  | "extraction_entry_claim"
  | "compaction_stateless"
  | "readiness_probe_stateless";

export interface SourceAdmissionProfile {
  kind: SubmitJobSource["kind"];
  /** Only task_run carries issue/run identity (frozen requiredFields = [runId, issueId]). */
  carriesTaskIdentity: boolean;
  /** The bridge drives the legacy checkout engine in-transaction — task_run ONLY. */
  drivesLegacyCheckout: boolean;
  checkoutAssignment: CheckoutAssignmentDisposition;
  assignmentAuthority: SourceAssignmentAuthority;
  /** Net-new workload class with no current-main crosswalk (browser/service). */
  netNew: boolean;
  /** The distributed source-identity field feeding the `insertJobOnce` composite. */
  sourceIdentityField:
    | "runId"
    | "internalAgentRunId"
    | "crewRunId"
    | "operationId"
    | "browserRequestId"
    | "reconciliationId";
  /** JOB-010 records capacity behaviour but never drives it — JOB-007 owns the
   * claim/release engine (ticket T4 boundary). */
  capacityAuthority: "job007_characterization_only";
  /** one_shot only: which of the three engines this operation is. */
  oneShotEngine?: OneShotEngine;
}

/**
 * Classify a source's admission/assignment disposition. Pure; consumed by the matrix
 * test to prove the bridge honours the frozen parity contract per source WITHOUT any
 * database or model effect.
 */
export function describeSourceAdmission(source: SubmitJobSource): SourceAdmissionProfile {
  switch (source.kind) {
    case "task_run":
      return {
        kind: "task_run",
        carriesTaskIdentity: true,
        drivesLegacyCheckout: true,
        checkoutAssignment: "drives_issue_checkout",
        assignmentAuthority: "issue_checkout",
        netNew: false,
        sourceIdentityField: "runId",
        capacityAuthority: "job007_characterization_only",
      };
    case "commander_turn":
      return {
        kind: "commander_turn",
        carriesTaskIdentity: false,
        drivesLegacyCheckout: false,
        checkoutAssignment: "not_applicable",
        assignmentAuthority: "commander_conversation_inert",
        netNew: false,
        sourceIdentityField: "internalAgentRunId",
        capacityAuthority: "job007_characterization_only",
      };
    case "crew_run":
      return {
        kind: "crew_run",
        carriesTaskIdentity: false,
        drivesLegacyCheckout: false,
        checkoutAssignment: "reuses_checkout_engine_at_execute",
        assignmentAuthority: "crew_dispatch_admission",
        netNew: false,
        sourceIdentityField: "crewRunId",
        capacityAuthority: "job007_characterization_only",
      };
    case "one_shot":
      return {
        kind: "one_shot",
        carriesTaskIdentity: false,
        drivesLegacyCheckout: false,
        checkoutAssignment: "not_applicable",
        assignmentAuthority: "extraction_or_stateless_engine",
        netNew: false,
        sourceIdentityField: "operationId",
        capacityAuthority: "job007_characterization_only",
        oneShotEngine:
          source.operationKind === "extraction"
            ? "extraction_entry_claim"
            : source.operationKind === "compaction"
              ? "compaction_stateless"
              : "readiness_probe_stateless",
      };
    case "browser_request":
      return {
        kind: "browser_request",
        carriesTaskIdentity: false,
        drivesLegacyCheckout: false,
        checkoutAssignment: "net_new_no_issue",
        assignmentAuthority: "browser_session",
        netNew: true,
        sourceIdentityField: "browserRequestId",
        capacityAuthority: "job007_characterization_only",
      };
    case "service_reconcile":
      return {
        kind: "service_reconcile",
        carriesTaskIdentity: false,
        drivesLegacyCheckout: false,
        checkoutAssignment: "net_new_no_issue",
        assignmentAuthority: "service_instance_reconcile",
        netNew: true,
        sourceIdentityField: "reconciliationId",
        capacityAuthority: "job007_characterization_only",
      };
  }
}

/**
 * The expected-status set the legacy heartbeat engine uses when it checks out a task run
 * (`heartbeat.ts` — `["todo","backlog","blocked","in_progress"]`). Reused verbatim so the
 * bridge's checkout is the SAME assignment move, not a new one.
 */
const TASK_RUN_CHECKOUT_STATUSES = ["todo", "backlog", "blocked", "in_progress"] as const;

/** Thrown when `admitAndSubmit`/`releaseTaskClaim` is called while distributed execution
 * is disabled. Fail-closed: the bridge does nothing, so the legacy path is untouched. */
export class JobAdmissionBridgeDisabledError extends Error {
  readonly code = "JOB_ADMISSION_BRIDGE_DISABLED";
  constructor() {
    super("Job admission bridge is disabled while distributed execution is off");
    this.name = "JobAdmissionBridgeDisabledError";
  }
}

export interface JobAdmissionBridge {
  /** True iff distributed execution is enabled for this deployment. Callers gate on this
   * so a flag-off deployment NEVER invokes `admitAndSubmit`. */
  isEnabled(): boolean;
  admitAndSubmit(
    source: SubmitJobSource,
    actor: BridgeActor,
    idempotencyKey: string,
    input?: Record<string, unknown>,
  ): Promise<SubmitJobResponse>;
  /** Release the ONE legacy assignment claim (task_run only) exactly once through the
   * SAME run-guarded engine (`issueService.release`) the legacy path uses. Only needed
   * for a POST-commit / pre-lease failure — a pre-commit failure rolls the claim back
   * with the transaction. NOT a capacity release (that is JOB-007). */
  releaseTaskClaim(source: SubmitJobSource, actor: BridgeActor): Promise<{ released: boolean }>;
}

export function jobAdmissionBridge(
  appDb: Db,
  options?: { env?: Record<string, string | undefined> },
): JobAdmissionBridge {
  const env = options?.env ?? process.env;

  function assertEnabled(): void {
    if (!readDistributedExecutionDeploymentFlag(env)) {
      throw new JobAdmissionBridgeDisabledError();
    }
  }

  async function resolveAdmissibleOrganization(companyId: string): Promise<string> {
    // Resolve the Company→Organization edge OUTSIDE the transaction (a pure ownership
    // read on the shared pool), then gate on sentinel + unmapped BEFORE opening any tx —
    // an unmapped or sentinel Organization is denied opaquely, before any admission or
    // legacy effect. `assertAdmissibleMappedOrganization` narrows the value to a string.
    const organizationId = await resolveCompanyOrganizationId(appDb, companyId);
    assertAdmissibleMappedOrganization(organizationId);
    return organizationId;
  }

  return {
    isEnabled(): boolean {
      return readDistributedExecutionDeploymentFlag(env);
    },

    async admitAndSubmit(source, actor, idempotencyKey, input = {}) {
      assertEnabled();
      const organizationId = await resolveAdmissibleOrganization(actor.companyId);

      const { companyId, ...principal } = actor;
      const request: SubmitJobRequest = {
        organizationId,
        companyId,
        principal,
        command: { idempotencyKey, source, input },
      };

      // After-commit publication sink. checkout stages its `issue.status_changed`
      // publish here instead of firing it inline; the sink is drained ONLY after the
      // authoritative transaction commits, so a rollback (a throw below) fires NOTHING.
      const afterCommit: Array<() => void> = [];

      // DE-27 (audit clause) — a `capacity` refusal from `admitAttemptCapacity` (reached
      // through `submitJobWithinTenant`) captures its intent here and is drained on the POOL
      // handle (`appDb`) AFTER `runInTenant` closes, in the `finally` below. The refusal
      // throws the 429 and rolls this tenant transaction back, so the row cannot be written
      // inside it. No-op when nothing was captured; never throws.
      const denialSink: AdmissionDenialSink = { intent: null };
      let response: SubmitJobResponse;
      try {
        response = await runInTenant(appDb, organizationId, async (repos, tx) => {
        // (1) Drive the legacy assignment authority for the ONE identity-bearing source.
        // Run-guarded checkout → single legacy/distributed winner; a pre-commit throw
        // (unmet dependency / ownership conflict / stale status) rolls back the whole
        // transaction before any submission row exists.
        if (source.kind === "task_run") {
          // Idempotent-replay fast-path BEFORE the non-idempotent checkout: on a redelivery
          // of the same (principal, runId, idempotencyKey) the submission already committed,
          // so re-driving checkout would re-fire its atomic UPDATE (resetting issues.startedAt
          // to now + re-broadcasting issue.status_changed) even though the job dedupes. Return
          // the already-committed submission WITHOUT re-checking-out. The legacy checkout engine
          // is untouched (parity); this only makes the bridge honor its own idempotencyKey.
          const replay = await findIdempotentReplay(repos, request);
          if (replay) return replay;
          // CLI-006 (D3a): the canary path submits LATE — after the run's context
          // exists, because the immutable envelope carries it as artifacts — by
          // which point the HARNESS has already checked this run out. Re-driving
          // checkout here would reset `issues.startedAt` and re-broadcast
          // `issue.status_changed`, checking the run out twice (Invariant 3, the
          // break CLI-005's review caught for active mode).
          //
          // `taskSourceIsAdmitted` tests exactly the two columns a checkout
          // establishes — `checkoutRunId === runId && executionRunId === runId` —
          // so a passing probe means the checkout this bridge would perform has
          // already been performed, by this same run, and is safe to skip. It is
          // deliberately the SAME predicate `submitJobWithinTenant` admits on, so
          // the bypass can never admit something admission would reject.
          //
          // Active mode (CLI-005) is unaffected: there the harness SUPPRESSES its
          // checkout, so the probe fails and the bridge checks out as before.
          const checkoutAlreadyOwnedByThisRun = await repos.jobControl.taskSourceIsAdmitted({
            companyId,
            issueId: source.issueId,
            assigneeAgentId: source.assigneeAgentId,
            runId: source.runId,
          });
          if (!checkoutAlreadyOwnedByThisRun) {
            await issueService(tx).checkout(
              source.issueId,
              source.assigneeAgentId,
              [...TASK_RUN_CHECKOUT_STATUSES],
              source.runId,
              { deferPublish: (publish) => afterCommit.push(publish) },
            );
          }
        }

        // (2) Admission + per-source authority + immutable submission, in the SAME tx.
        // For task_run, `taskSourceIsAdmitted` now passes because step (1) set
        // checkoutRunId = executionRunId = runId. For every other source this is the
        // unchanged `submit` control flow (reuse-existing `*IsAdmitted`, no fabricated
        // task). All admission denials surface as one opaque `TenantAdmissionDeniedError`.
        return submitJobWithinTenant(repos, request, tx, denialSink);
        });
      } finally {
        if (denialSink.intent) {
          const { drainAdmissionDenial } = await import("./worker-admission-denial-audit.js");
          await drainAdmissionDenial(appDb, denialSink, {
            control: "server/src/services/job-admission-bridge.ts:admitAndSubmit",
          });
        }
      }

      // After commit ONLY. A rollback threw above and never reached here → no publication
      // on rollback. Each publish is best-effort and isolated — a live-event failure never
      // fails the (already-committed) submission.
      for (const publish of afterCommit) {
        try {
          publish();
        } catch {
          // best-effort live publish; the submission is already durable.
        }
      }

      return response;
    },

    async releaseTaskClaim(source, actor) {
      assertEnabled();
      if (source.kind !== "task_run") return { released: false };
      const organizationId = await resolveAdmissibleOrganization(actor.companyId);
      return runInTenant(appDb, organizationId, async (_repos, tx) => {
        // Run-guarded release: only the owning run/assignee may release (a foreign run
        // throws a conflict), so concurrent releases resolve to ONE winner and the claim
        // is released exactly once. NOT a capacity release (JOB-007 owns that).
        const released = await issueService(tx).release(
          source.issueId,
          source.assigneeAgentId,
          source.runId,
        );
        return { released: released != null };
      });
    },
  };
}
