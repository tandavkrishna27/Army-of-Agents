/**
 * artifact-retention-audit.ts — DE-11's `audit` clause, RETENTION HALF.
 *
 * ★ THE DEFECT THIS CLOSES, AND ITS EXACT SIZE.
 * `docs/architecture/distributed-execution-threat-controls.json` DE-11 asserts
 * "sensitive-artifact access and retention are audited". The register's stated
 * blocker was that "the controls themselves are absent; nothing decides, so
 * there is nothing to record". Re-measured at `6b39c77f6`, that premise is
 * STALE for the retention half: `resolveStoredRetention`
 * (`artifact-retention-authority.ts:49`) IS a live control-plane retention
 * decision, called at `artifact-commit.ts:272` and branched on at `:276`, which
 * OVERRIDES a worker's declared class. The code's own comment there said, in
 * as many words, "This is a LOG LINE, not an audit record — DE-11 claims
 * retention is audited and nothing audits it". This module is the record.
 *
 * ★ WHAT IS RECORDED, AND WHAT IS NOT — stated first, because a partial
 * delivery described as a whole one is this programme's own failure class.
 *   RECORDED: the control plane IGNORED a worker's declared retention class on
 *     a COMMITTED artifact. The row says WHO declared it, in WHICH tenant, on
 *     WHICH artifact, WHAT was declared, and WHAT was stored instead.
 *   NOT RECORDED: an AGREEING declaration. Agreement writes nothing, so a reader
 *     must not read "no row" as "no artifact committed". The retention that was
 *     actually stored is on the artifact row itself
 *     (`job_artifacts.retention`, written from the same decision at
 *     `artifact-commit.ts`); what was previously unrecoverable — and is what
 *     this module recovers — is the DISAGREEMENT and the value the worker
 *     wanted.
 *   NOT RECORDED, AND NOT CLAIMED: the ACCESS half of DE-11's clause. The clause
 *     is a CONJUNCTION — "access AND retention" — and its access half is DE-06's
 *     still-open successful put/get obligation. Half a conjunction is not the
 *     conjunction. DE-11 does not close on this module.
 *
 * ★ THE COVERAGE CAVEAT, WHICH MUST TRAVEL WITH EVERY CLAIM MADE ABOUT THIS
 * FILE. DE-11's boundary is "Browser-session workload <-> sensitive artifacts",
 * and NOTHING IN PRODUCTION UPLOADS `browser_cookie_state` or
 * `browser_storage_state` TODAY, because `BRW-003` is unbuilt. The decision at
 * `artifact-commit.ts:272` fires for EVERY artifact kind, so this record is real
 * and live — but on today's traffic it can only ever be about a `log`, a
 * `workspace_patch` or a `screenshot`, and NEVER ONCE about a credential-bearing
 * kind. That is a coverage gap, not an impossibility. DE-11 therefore STAYS
 * `partial` until `BRW-003` ships and the record is provoked on a genuinely
 * sensitive kind through the real upload path. The proving test provokes
 * `browser_cookie_state` by hand and PINS it as test-provoked precisely so that
 * arm cannot be mistaken for production coverage.
 *
 * ★ TRANSACTION DISCIPLINE — the same rule the denial recorder states, and for
 * the same reason. `db` MUST be a pool-level handle, never the tenant
 * transaction the commit runs in. `artifact-commit.ts` therefore captures an
 * INTENT inside `runInTenant` and drains it AFTER the transaction closes,
 * exactly as DE-06's `denial.intent` does. Writing at the decision point would
 * put the record inside a transaction that a later refusal branch rolls back,
 * so a rejected commit would erase its own retention record.
 *
 * ★ AND IT ONLY DRAINS ON A COMMITTED OUTCOME. `resolveStoredRetention` runs
 * BEFORE the mutator, and three refusal branches sit after it. A decision on a
 * commit that was then refused overrode nothing and stored nothing; recording it
 * would assert a stored retention that does not exist, and would hand a worker a
 * cheap way to flood the audit with manifests it never intended to commit.
 *
 * ★ WHY `activity_log`. The same three properties that put the denial recorder
 * there (`security-denial-audit.ts`): it is the live product audit store with an
 * existing redaction pass, it is deliberately outside the tenant RLS kernel, and
 * `action`/`entityType` are free text with a jsonb `details`, so this needs no
 * schema change and no DDL.
 *
 * ★ IT NEVER THROWS. A failure to record must not convert a successful artifact
 * commit into a 500 — the record is evidence about work that already happened,
 * and losing the evidence must not lose the work. A failed insert is logged at
 * error level carrying the attribution the row would have carried. The cost is
 * that a silently-broken writer looks like a quiet system, so the proving test
 * (`de-11-retention-audit.integration.test.ts`) is written to go RED when the
 * write is removed, and it was observed doing so.
 */
import type { Db } from "@armyofagents/db";
import { activityLog } from "@armyofagents/db";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import { SECURITY_RETENTION_ACTION_PREFIX } from "./activity-namespace.js";

/** The surface slug for the artifact-commit retention decision. */
export const ARTIFACT_COMMIT_RETENTION_SURFACE = "artifact_commit";

/**
 * The stable machine reason. Named for the OBSERVED FACT (a declaration was
 * ignored) and not for a hostile interpretation of it, because a worker
 * declaring a shorter class than derived is a bug and not an attack, and a
 * reason code that says "downgrade_attempt" would teach an operator to read
 * every benign one as hostile.
 */
export const RETENTION_DECLARATION_IGNORED_REASON = "declaration_ignored";

/**
 * What `artifact-commit.ts` captures INSIDE the tenant transaction and drains
 * AFTER it. A one-field holder rather than a bare `let`, for the same narrowing
 * reason the DE-06 denial sink is one.
 */
export interface RetentionDecisionIntent {
  /** The LOCKED LEASE's company, never the manifest's self-asserted one. */
  readonly companyId: string;
  /** Token-attested, off the verified worker operation. Never off the wire. */
  readonly organizationId: string;
  /** The worker whose declaration was ignored. */
  readonly workerId: string;
  readonly artifactId: string;
  readonly kind: string;
  /** What the worker declared. `undefined` when the manifest omitted it. */
  readonly declaredRetention: string | undefined;
  /** What the control plane derived and actually stored. */
  readonly storedRetention: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseId: string;
}

export function createRetentionAuditSink(): { intent: RetentionDecisionIntent | null } {
  return { intent: null };
}

/**
 * Record one control-plane retention decision durably and attributably.
 * Returns the row id, or `null` when nothing could be written (logged at error).
 *
 * Deliberately does NOT publish a live event, for the reason the denial recorder
 * gives: `logActivity`'s publish is company-scoped, and an audit record that
 * broadcasts is an audit record that can be used as a channel.
 *
 * ★ NO FK FALLBACK, AND THAT IS A MEASURED DIFFERENCE FROM THE DENIAL RECORDER,
 * NOT AN OVERSIGHT. `recordSecurityDenial` retries with a null organization on a
 * 23503 because its subject is a REPLAYED CREDENTIAL FROM A TORN-DOWN TENANT —
 * an attested organization id that may legitimately no longer have a row. This
 * recorder's subject is the opposite: it only ever runs after a live lease for
 * that organization was LOCKED and an artifact row for that company was
 * COMMITTED in the transaction that just closed, so both FKs were satisfiable
 * moments earlier. The only way to reach a 23503 here is an organization deleted
 * in the window between the commit and this write, and the honest handling of
 * that is the swallow below with full attribution in the log — not a fallback
 * into a tenantless sink whose partial CHECK this namespace does not satisfy
 * anyway (see `activity-namespace.ts`).
 */
export async function recordRetentionDecision(
  db: Db,
  intent: RetentionDecisionIntent,
): Promise<string | null> {
  const action = `${SECURITY_RETENTION_ACTION_PREFIX}${ARTIFACT_COMMIT_RETENTION_SURFACE}`;
  const details = sanitizeRecord({
    crossing: "DE-11",
    reason: RETENTION_DECLARATION_IGNORED_REASON,
    control: "server/src/services/artifact-commit.ts:commit",
    operation: "commit",
    kind: intent.kind,
    // The two values the whole record exists for. `declaredRetention` is null
    // when the manifest omitted the field: the authority counts an ABSENT
    // declaration as a disagreement, so a null here is a real answer and not a
    // missing one.
    declaredRetention: intent.declaredRetention ?? null,
    storedRetention: intent.storedRetention,
    organizationId: intent.organizationId,
    workerId: intent.workerId,
    jobId: intent.jobId,
    attempt: intent.attempt,
    leaseId: intent.leaseId,
  });

  try {
    const [row] = await db
      .insert(activityLog)
      .values({
        companyId: intent.companyId,
        organizationId: intent.organizationId,
        // A worker has no `agents` row and no `auth` row; `actor_id` is plain
        // text with no FK, which is what makes `workerId` usable directly. Same
        // choice, for the same reason, as the DE-06 denial call site.
        actorType: "system",
        actorId: intent.workerId,
        action,
        entityType: "job_artifact",
        entityId: intent.artifactId,
        // Left null for the reason the denial recorder gives: `agent_id` and
        // `run_id` are FK'd to `agents` / `heartbeat_runs` and a worker has a
        // row in neither.
        agentId: null,
        runId: null,
        details,
      })
      .returning({ id: activityLog.id });
    return row?.id ?? null;
  } catch (err) {
    logger.error(
      {
        service: "artifact-retention-audit",
        event: "security.retention_audit_write_failed",
        crossing: "DE-11",
        action,
        companyId: intent.companyId,
        organizationId: intent.organizationId,
        workerId: intent.workerId,
        artifactId: intent.artifactId,
        kind: intent.kind,
        declaredRetention: intent.declaredRetention ?? null,
        storedRetention: intent.storedRetention,
        err,
      },
      "failed to record a retention decision — the override still stands, but it is now unattributable",
    );
    return null;
  }
}
