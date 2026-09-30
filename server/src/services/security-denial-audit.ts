import type { Db } from "@armyofagents/db";
import { activityLog } from "@armyofagents/db";
import type { ActivityActorType } from "@armyofagents/shared";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import { SECURITY_DENIAL_ACTION_PREFIX } from "./activity-namespace.js";

/**
 * The durable record a security refusal leaves behind.
 *
 * ★ THE PROBLEM THIS EXISTS FOR. Seventeen crossings in
 * `docs/architecture/distributed-execution-threat-controls.json` assert that
 * denials are audited. On every one of them the deny path returned before
 * anything durable was written, so a refused cross-tenant read, a replayed
 * credential and a shed submission were all INDISTINGUISHABLE FROM TRAFFIC THAT
 * NEVER HAPPENED (`E0-F010`, `E0-F013`). This is the first writer for that
 * class. It closes ONE of the seventeen — DE-19's `memory.get` half. ★ NO COUNT
 * OF THE REST IS STATED HERE, and the figure that used to be ("the remaining
 * sixteen") had already gone stale twice by 2026-09-10, when DE-06 and DE-14
 * closed. The open set is enumerated in `E0-F013`'s Status block
 * (`docs/replatform/epics/E0-foundation/findings.md`), which declares itself the
 * one authoritative count; a second copy of it in source can only drift.
 *
 * ★ ATTRIBUTION IS THE CONTRACT. The crossings do not assert "a denial is
 * counted"; they assert denials are ATTRIBUTABLE. A count-only, id-free metric
 * (the DE-06 and DE-29 shape: `metrics.artifactOp({outcome:"denied"})`,
 * `metrics.secretRead({outcome:"denied"})`) does not satisfy them, because it
 * cannot answer WHO was refused, in WHICH tenant, on WHICH resource, and WHY.
 * Every field below is required for exactly that reason, and the proving test
 * asserts each of the four separately rather than asserting a row exists.
 *
 * ★ WHY `activity_log` AND NOT A NEW TABLE. Three properties decide it:
 *   1. It is the live product audit store with an existing redaction pass
 *      (`sanitizeRecord`), so a denial cannot become the leak it records.
 *   2. It is DELIBERATELY OUTSIDE the tenant RLS kernel — migration
 *      `0245_job_activity_audit_rls.sql:15-18` records `activity_log` and
 *      `hub_audit` as "CAV-005 legacy, non-forced" and grants `aoa_app`
 *      SELECT+INSERT (`0213:98`, `0214:166`). Every RLS-forced table
 *      (`jobs`, `job_events`, `job_projection_receipts`,
 *      `worker_lease_rejections`, …) would refuse a denial write for the same
 *      reason the read was denied — the org GUC is exactly what is wrong in the
 *      cross-tenant case. A denial recorder cannot live behind the policy it
 *      exists to observe.
 *   3. `action`/`entityType` are free text and `details` is jsonb, so the
 *      namespace needs no schema change and no DDL.
 *
 * ★ THE LIMIT, AS IT NOW STANDS — E0-F013 DECISION 2, RULED (a2) 2026-09-09.
 * The paragraph that used to sit here said `activity_log.company_id` is NOT NULL
 * and that a denial with no resolvable company "CANNOT be written here at all".
 * That is no longer true and is replaced rather than footnoted, because a stale
 * limit in a recorder's own contract is how a caller learns the wrong rule.
 *
 * `company_id` is now NULLABLE, a nullable `organization_id` sits beside it, and
 * a partial CHECK (`company_id IS NOT NULL OR action LIKE 'security.denied.%'`)
 * keeps the NOT NULL guarantee for every product writer while admitting a
 * tenantless row inside this recorder's reserved namespace ONLY. Migration
 * `0274_activity_log_denial_sink.sql`; ruling
 * `docs/replatform/DECISION-REQUEST-unattributable-denial-sink.md` §4.
 *
 * ★ WHAT THAT DOES AND DOES NOT BUY, per axis:
 *   - a denial that resolves a company still writes it, unchanged;
 *   - a denial that resolves only an ORGANIZATION (SEVEN of DE-03's nine
 *     `recordProof` refusals, DE-15's drain, five of DE-06's six fence throws)
 *     now writes a row attributed to that organization and to no company. The
 *     seven are `job-control-ack.ts:117`, `job-events.ts:194`,
 *     `job-fencing.ts:153`, `job-leasing.ts:662` and `:1016`,
 *     `worker-fence-context.ts:135` and `:321` — each holds a
 *     `VerifiedWorkerOperation.organizationId` typed `string`, with platform
 *     scope refused ahead of it (`middleware/worker-operation-proof.ts:6,50`).
 *   - the OTHER TWO of the nine stay DOUBLY NULL even under (a2), and this
 *     recorder does not pretend otherwise:
 *     `server/src/services/worker-enrollment.ts:315`, where
 *     `authoritativeOrganizationId` is typed `string | null` and an unrouted
 *     enrollment code yields no organization, and
 *     `server/src/middleware/worker-session-auth.ts:151`, whose
 *     `claims.organizationId === null` branch (`:183-185`) passes an explicit
 *     `null` for a platform-scope worker — the scope/organization invariant is
 *     asserted at `:72`. The separate pre-code refusal at `worker-enrollment.ts:295`
 *     — NOT one of the nine — fires before any organization is resolved at all
 *     and is doubly null for the same reason. Those rows are attributable to
 *     nothing but the device thumbprint and proof id in `details`, and that is
 *     the honest ceiling, not an oversight.
 *     (★ The paragraph above said "eight session-bound refusals" and named
 *     `:315` + `:295` as the doubly-null pair. Both were wrong and both
 *     flattered the ruling; corrected against the nine call sites on 2026-09-09.
 *     A stale count in a recorder's own contract is how a caller learns the
 *     wrong rule — the same failure this header's `★ THE LIMIT` note exists for.)
 *   - `organization_id` is `ON DELETE restrict`, not `cascade`, and a null-company
 *     row does not cascade with any company. Decision 3(b)'s "a suspect deletes
 *     their own denial history" therefore has less surface here, but is NOT
 *     answered by this slice.
 *
 * ★ THE ORGANIZATION MUST BE VERIFIED, NEVER CALLER-SUPPLIED. This is the whole
 * difference between the ruled option (a2) and the rejected option (c). Callers
 * pass `organizationId` ONLY when it came out of a control-plane-minted, HMAC-
 * verified artefact (`verifyWorkerOperationProof` → `verifyWorkerSessionToken`,
 * `worker-operation-proof.ts:47-60`) or out of a row read in this transaction.
 * A value taken off the wire lets a prober CHOOSE THE DESTINATION of the record
 * of its own refusal — dilute it, flood a victim's feed, or omit it to force the
 * row back into the tenantless bucket. A prober that controls the attribution
 * controls the audit. Do not add a caller-supplied path.
 *
 * ★ TRANSACTION DISCIPLINE, and why callers must read this. `db` MUST be a
 * pool-level handle, never the transaction that is about to reject. Many
 * denials in this class are a `throw` INSIDE a tenant transaction (DE-04,
 * DE-12, DE-29), so an in-transaction write of the denial is rolled back with
 * it — DE-29 is the proof, where the audit UPDATE at
 * `job-control.ts:3139` sits after the throw at `:3122` and never runs. DE-19,
 * the crossing wired here, denies OUTSIDE any transaction, which is why it is
 * the first one: it does not force that lifecycle problem on the first slice.
 * The fence denials will.
 *
 * ★ IT NEVER THROWS, AND WHAT THAT COSTS. A failure to record must not convert a
 * security refusal into a 500: that would both hand the caller an oracle (a
 * refused id behaves differently from an absent one) and make the audit path a
 * denial-of-service lever on the refusal path. So a failed insert is logged at
 * error level, carrying the same attribution the row would have carried, and
 * swallowed. The cost is that a silently-broken writer looks like a quiet
 * system — the exact failure class this programme exists to stop — so the
 * proving test (`de-19-memory-denial-audit.integration.test.ts`) is written to
 * go RED when the write is removed, and it was observed doing so.
 */
export interface SecurityDenialInput {
  /**
   * The tenant the refusal happened in, on the COMPANY axis.
   *
   * `null` ONLY where the refusing control genuinely holds no FK-valid company —
   * `organization → company` is 1:N and therefore not a function, so there is no
   * reverse lookup to perform (`companies.ts:20`, and the only unique constraint
   * over `organization_id` is the composite `companies_org_id_uq`, `:87`). Pass
   * `null` because the company is ABSENT, never because it was inconvenient to
   * thread: a null here is a claim that nothing in scope resolves one.
   */
  companyId: string | null;
  /**
   * The tenant the refusal happened in, on the ORGANIZATION axis. Added by
   * E0-F013 Decision 2 (a2) so an organization-only refusal records WHO was
   * refused instead of "someone, somewhere".
   *
   * ★ MUST be token-attested or DB-resolved — see the header. Never a value the
   * caller put on the wire.
   *
   * Optional, and `null` is a real answer: at two DE-03 sites there is no
   * organization either (see the header).
   */
  organizationId?: string | null;
  /**
   * The crossing id from `distributed-execution-threat-controls.json` whose
   * `audit` clause this row exists to satisfy, e.g. "DE-19". Makes a row
   * traceable back to the obligation that required it.
   */
  crossing: string;
  /**
   * What was refused, as a stable slug appended to the reserved action prefix —
   * e.g. "memory_read" becomes `security.denied.memory_read`.
   */
  surface: string;
  /**
   * WHY, as a stable machine code and never free prose (prose cannot be counted,
   * alerted on, or compared across releases). Distinct codes must correspond to
   * distinct BRANCHES in the refusing control, so a reader can tell a
   * cross-tenant probe from an unapproved row.
   */
  reason: string;
  /** WHO — the actor kind, mirroring the `activity_log.actor_type` vocabulary. */
  actorType: ActivityActorType;
  /** WHO — the actor's stable id. `actor_id` is plain text with no FK, so this
   * is safe for identities (agent keys, external MCP principals) that have no
   * row in `agents` or `auth`. */
  actorId: string;
  /** WHICH RESOURCE — the kind of thing that was refused, e.g. "memory_item". */
  entityType: string;
  /** WHICH RESOURCE — its id. */
  entityId: string;
  /**
   * The control that refused, as `path/to/file.ts:line` or a symbol name. This
   * is what lets an operator go from a row to the line, and what makes a stale
   * record visible when the line moves.
   */
  control: string;
  /** Anything else worth keeping. Redacted through `sanitizeRecord` before insert. */
  details?: Record<string, unknown> | null;
}

/**
 * The FK added by `0274_activity_log_denial_sink.sql`. Named here, not matched
 * loosely, because the fallback below must fire for THIS constraint and no other
 * — `company_id`, `agent_id` and `run_id` also carry foreign keys, and dropping
 * the organization would not repair a violation of any of them.
 */
const ORGANIZATION_FK_CONSTRAINT = "activity_log_organization_id_organizations_id_fk";
/** SQLSTATE 23503 = foreign_key_violation. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Drizzle re-throws its own `DrizzleQueryError` with the driver error on
 * `.cause`, so the SQLSTATE is NOT on the outer object. Reading only the outer
 * one yields `undefined` for every failure alike — which would make the fallback
 * below either never fire or fire on everything. Walk the cause chain to the
 * first frame that carries a code.
 */
function pgErrorFrame(err: unknown): { code?: string; constraint?: string } {
  let cursor: unknown = err;
  for (let depth = 0; depth < 5 && cursor; depth += 1) {
    const e = cursor as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (typeof e.code === "string") {
      return { code: e.code, constraint: e.constraint_name ?? e.constraint };
    }
    cursor = e.cause;
  }
  return {};
}

/**
 * Record one security refusal durably and attributably. Returns the row id, or
 * `null` when nothing could be written (which is logged at error level).
 *
 * Deliberately does NOT publish a live event. `logActivity`'s publish is
 * company-scoped, so broadcasting a denial would push a cross-tenant probe into
 * the probed company's own event stream — turning an audit record into a
 * disclosure channel.
 *
 * ★ AN ATTESTED ORGANIZATION IS NOT A LIVE ROW, AND THE FK CANNOT TELL THE
 * DIFFERENCE (Codex P2 on PR #403, verified). `organizationId` is trustworthy
 * ATTRIBUTION — it comes off an HMAC-verified, control-plane-minted artefact —
 * but a signed id does not prove the `organizations` row still EXISTS. Delete an
 * organization, then replay a worker token minted before the delete, and the
 * new FK rejects the insert with 23503. Without the fallback below that error
 * lands in the swallow, so the ONE denial class most worth keeping — a replayed
 * credential from a torn-down tenant — is the one that records nothing, and the
 * doubly-null sink this whole ruling exists to open is never reached.
 *
 * So a 23503 on THAT named constraint, and only that one, retries ONCE with
 * `organization_id` null. The row still satisfies the partial CHECK (the action
 * is in the reserved namespace by construction), and the attested id is not lost
 * — it moves into `details.unresolvedOrganizationId` alongside
 * `details.organizationAttributionDropped`, so a reader can still tell WHICH
 * organization was attested and that the FK, not the caller, is why the column
 * is null. Degrading attribution beats losing the record.
 *
 * ★ WHY THIS IS NOT REACHABLE TODAY, and why it ships anyway. No production
 * caller passes `organizationId` yet — the three live callers
 * (`read-tools.ts:298`, `artifact-commit.ts:349`, `artifact-transfer-grant.ts:332`)
 * all pass a resolved company. This PR is the one that LAYS the trap: it adds
 * the FK the wiring unit's seven organization-attested DE-03 sites will hit. The
 * fallback is proven by arm 7 of
 * `e0-f013-unattributable-denial-sink.integration.test.ts` against real
 * PostgreSQL rather than left as a note for the unit that would trip over it.
 *
 * ★ THE RETRY REQUIRES THE POOL HANDLE THE HEADER ALREADY DEMANDS. On an
 * aborted transaction the second insert fails with 25P02 and is swallowed and
 * logged exactly as before — no worse than today, and one more reason `db` must
 * not be the transaction that is about to reject.
 */
export async function recordSecurityDenial(
  db: Db,
  input: SecurityDenialInput,
): Promise<string | null> {
  const action = `${SECURITY_DENIAL_ACTION_PREFIX}${input.surface}`;
  const baseDetails: Record<string, unknown> = {
    ...(input.details ?? {}),
    crossing: input.crossing,
    reason: input.reason,
    control: input.control,
    actorSource: input.actorType,
  };
  const details = sanitizeRecord(baseDetails);

  const insert = async (
    organizationId: string | null,
    rowDetails: Record<string, unknown>,
  ): Promise<string | null> => {
    const [row] = await db
      .insert(activityLog)
      .values({
        companyId: input.companyId,
        // E0-F013 Decision 2 (a2). Undefined and null are the same row here — the
        // column is nullable and has no default — but `attested` below normalises
        // with an explicit `?? null` before this runs, so the value that reaches
        // the database is identical to the value the caller passed and a test can
        // assert the two doubly-null DE-03 sites really do write a doubly-null row
        // rather than a defaulted one.
        organizationId,
        actorType: input.actorType,
        actorId: input.actorId,
        action,
        entityType: input.entityType,
        entityId: input.entityId,
        // The FK'd `agent_id`/`run_id` columns are deliberately left null: they
        // reference `agents` and `heartbeat_runs`, and a denial's actor is often
        // precisely an identity with no such row (an external key, a stale run,
        // a caller from another tenant). A dangling FK would make the write fail
        // for the same reason the read was denied. Actor identity rides
        // `actor_id` (plain text) and `details` instead.
        agentId: null,
        runId: null,
        details: rowDetails,
      })
      .returning({ id: activityLog.id });
    return row?.id ?? null;
  };

  const attested = input.organizationId ?? null;

  try {
    return await insert(attested, details);
  } catch (firstErr) {
    const frame = pgErrorFrame(firstErr);
    if (
      attested !== null &&
      frame.code === FOREIGN_KEY_VIOLATION &&
      frame.constraint === ORGANIZATION_FK_CONSTRAINT
    ) {
      try {
        const id = await insert(
          null,
          sanitizeRecord({
            ...baseDetails,
            organizationAttributionDropped: true,
            unresolvedOrganizationId: attested,
          }),
        );
        logger.warn(
          {
            service: "security-denial-audit",
            event: "security.denial_audit_organization_unresolvable",
            crossing: input.crossing,
            action,
            companyId: input.companyId,
            organizationId: attested,
            actorType: input.actorType,
            actorId: input.actorId,
            entityType: input.entityType,
            entityId: input.entityId,
            reason: input.reason,
            control: input.control,
          },
          "the attested organization no longer exists — the denial was recorded in the tenantless sink instead",
        );
        return id;
      } catch (retryErr) {
        return recordFailure(input, action, retryErr);
      }
    }
    return recordFailure(input, action, firstErr);
  }
}

/**
 * The swallow. A failure to record must not convert a security refusal into a
 * 500 (see the header's `★ IT NEVER THROWS`), so this logs at error level with
 * the attribution the row would have carried and returns null.
 */
function recordFailure(input: SecurityDenialInput, action: string, err: unknown): null {
  logger.error(
    {
      service: "security-denial-audit",
      event: "security.denial_audit_write_failed",
      crossing: input.crossing,
      action,
      companyId: input.companyId,
      organizationId: input.organizationId ?? null,
      actorType: input.actorType,
      actorId: input.actorId,
      entityType: input.entityType,
      entityId: input.entityId,
      reason: input.reason,
      control: input.control,
      err,
    },
    "failed to record a security denial — the refusal still stands, but it is now unattributable",
  );
  return null;
}
