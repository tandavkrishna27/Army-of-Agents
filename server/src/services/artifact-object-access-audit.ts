/**
 * artifact-object-access-audit.ts — DE-06's `audit` clause, PUT/GET HALF.
 *
 * ★ THE DEFECT THIS CLOSES, AND ITS EXACT SIZE.
 * `docs/architecture/distributed-execution-threat-controls.json` DE-06 asserts
 * "object put/get **and** rejected-key attempts are audited". The clause is a
 * CONJUNCTION and until this module only the second conjunct was delivered:
 * every REFUSED transfer grant and every REFUSED commit wrote an attributable
 * `security.denied.*` row (`artifact-denial-audit.ts`, `worker-denial-audit.ts`),
 * while a SUCCESSFUL grant wrote nothing at all. `artifact-transfer-grant.ts`
 * holds the tree's ONLY production `presignGet` call site, so the
 * disclosure-relevant event for a cross-tenant object-key threat — the
 * successful GET, not the refusal — was the one event with no durable trace.
 * A worker that was HANDED a download URL for an object left the same record as
 * a worker that asked for nothing.
 *
 * ★ WHAT IS RECORDED — stated first and precisely, because a record whose scope
 * is overclaimed is worse than no record.
 *   RECORDED: the control plane AUTHORIZED an object operation. One row per
 *     SUCCESSFUL grant, saying WHO (the authenticated worker), in WHICH tenant
 *     (the LOCKED LEASE's company, resolved from the database under the worker's
 *     own organization GUC — never the request's), on WHICH resource (the
 *     artifact identity and the object key that was actually signed), and WHICH
 *     OPERATION (`upload` → PUT, `download` → GET), plus the grant's own expiry.
 *   NOT RECORDED, AND STRUCTURALLY UNRECORDABLE: the REDEMPTION. The bytes move
 *     directly between the worker and object storage and never traverse the
 *     control-plane API body path — that is the entire purpose of the presigned
 *     design (`artifact-transfer-grant.ts` header). The control plane therefore
 *     has exactly one observation point for an object operation, and it is
 *     ISSUANCE. There is no second place to put this record and no amount of
 *     wiring creates one; only the object store's own access log could, and this
 *     tree's `StorageProvider` port has no such operation.
 *   THE CONSEQUENCE, SAID PLAINLY: this audit OVER-reports. An issued grant that
 *     is never redeemed still writes a row, and a grant redeemed twice inside
 *     its TTL writes one. Over-reporting is the correct direction for a
 *     disclosure audit — a missed disclosure is unrecoverable and a spurious one
 *     is noise — but "there is a row" means "a capability was handed out", NOT
 *     "bytes moved". A reader that needs proof of transfer must join to the
 *     COMMIT record for an upload (`job_artifacts`), and for a download has
 *     nothing better than this row.
 *   NOT CLAIMED: DE-06's `authentication` clause, which is separately absent and
 *     is carried by `E0-F012`. This module delivers the AUDIT clause's remaining
 *     conjunct and nothing else.
 *
 * ★ IT ALSO CARRIES DE-11's ACCESS HALF, AND DE-11 STILL DOES NOT CLOSE.
 * `artifact-retention-audit.ts` states that DE-11's clause — "sensitive-artifact
 * ACCESS and RETENTION are audited" — had its retention half delivered and that
 * "its access half is DE-06's still-open successful put/get obligation". That
 * obligation is discharged here, and the download row carries `kind` and
 * `sensitivity` so it answers "was a sensitive artifact reached" rather than
 * merely "a transfer happened". DE-11 nevertheless stays `partial`, on the
 * SECOND and INDEPENDENT ground its own entry gives: nothing in production
 * uploads `browser_cookie_state` / `browser_storage_state` because BRW-003 is
 * unbuilt, so on today's traffic this record can only ever be about a `log`, a
 * `workspace_patch` or a `screenshot`, and never once about a credential-bearing
 * kind. That coverage caveat applies to BOTH halves and is not this module's to
 * clear. Half a conjunction is not the conjunction, and a mechanism that has
 * never been exercised on its subject is not coverage.
 *
 * ★ WHY BOTH ARMS AND NOT JUST THE GET. The clause names put AND get. A record
 * that covered only the download would be exactly the half-a-conjunction error
 * this crossing has already been corrected for twice. The upload arm is also not
 * redundant with `recordArtifactGrantIntent`: that writes an operational
 * `job_artifacts` row so the sweeper can find an orphan, it is keyed on the
 * artifact rather than on the actor, and it is not in the audit namespace — it
 * answers "does this object have an owner", never "who was authorized to write
 * here, and when".
 *
 * ★ TRANSACTION DISCIPLINE — the same rule the denial and retention recorders
 * state, and for the same measured reason. `db` MUST be a pool-level handle,
 * never the tenant transaction the grant is minted in. Calling a pool-level
 * recorder from INSIDE an open tenant transaction borrows a second pool
 * connection while the first is still held, which on a small pool is a
 * self-deadlock (see `artifact-denial-audit.ts`). So `artifact-transfer-grant.ts`
 * captures an INTENT inside `runInTenant` and drains it AFTER the transaction
 * closes and BEFORE the caller sees the response.
 *
 * ★ THE INTENT IS SET ONLY AT THE TWO SUCCESS RETURNS, AND THAT IS THE GATE.
 * There is deliberately no second `outcome === "…_granted"` check at the drain.
 * A redundant guard would make the "a refused grant writes no access row" arm
 * pass for the wrong reason — it would still pass with the capture moved above a
 * refusal branch. With a single mechanism, moving the capture reds that arm.
 * Nothing between the capture and the return can turn a granted response into a
 * refusal: the capture is the last statement before the response is built, and a
 * throw after it (a schema parse failure, or a failed COMMIT) rejects
 * `runInTenant`, so the drain is never reached and no row is written.
 *
 * ★ WHY `activity_log`. The same three properties that put the denial and
 * retention recorders there: it is the live product audit store with an existing
 * redaction pass, it is deliberately outside the tenant RLS kernel
 * (`0245:15-18`), and `action`/`entityType` are free text with a jsonb `details`,
 * so this needs no schema change and no DDL.
 *
 * ★ IT NEVER THROWS. A failure to record must not convert a legitimate transfer
 * grant into a 500, and must not hand a caller a way to fail grants by making
 * the audit write fail. A failed insert is logged at error level carrying the
 * attribution the row would have carried. The cost of a swallow is that a
 * silently-broken writer looks like a quiet system, so
 * `de-06-object-access-audit.integration.test.ts` is written to go RED when the
 * write is removed, and it was observed doing so.
 *
 * ★ HOT-PATH COST, BOUNDED RATHER THAN ASSERTED — because this is new behaviour
 * on a success path and the previous three units deferred it for that reason.
 *   (i) REACH. The only caller is the `artifact_transfer_grant` worker-control
 *       operation, and the entire worker-control route graph is registered only
 *       when `distributedExecutionEnabled` is true (`server/src/app.ts`, the
 *       `if (opts.distributedExecutionEnabled)` block, which DYNAMICALLY imports
 *       `./routes/worker-control.js` so a flag-off startup never even loads the
 *       module). That flag is `AOA_DISTRIBUTED_EXECUTION_ENABLED`, default FALSE
 *       (`config/distributed-execution.ts` `readDistributedExecutionDeploymentFlag`).
 *       So on every deployment that has not opted in, this code cannot execute.
 *   (ii) COST WHEN IT DOES. One INSERT, on the pool handle, after the tenant
 *       transaction has closed, awaited before the response. The UPLOAD arm was
 *       already doing one durable write per grant (`recordArtifactGrantIntent`),
 *       so it goes from one write to two — the same order. The DOWNLOAD arm is
 *       the real change: it becomes a WRITER where it was a reader. Said plainly
 *       rather than buried, because it is the one property a future reviewer
 *       should re-weigh if the download path ever serves interactive traffic.
 *   (iii) VOLUME. One row per grant, i.e. per ARTIFACT TRANSFER — bounded by
 *       artifact count, not by request rate, and of the same order as the
 *       `job_artifacts` rows the same path already creates.
 */
import type { Db } from "@armyofagents/db";
import { activityLog } from "@armyofagents/db";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import { SECURITY_OBJECT_ACCESS_ACTION_PREFIX } from "./activity-namespace.js";

/**
 * The surface slugs. TWO of them, one per conjunct, rather than one slug with
 * the operation in `details`: "how many download URLs were issued for this
 * tenant" is the disclosure question, and it should be answerable by an `action`
 * predicate — the same shape the denial reader already pages on — rather than by
 * a jsonb extraction.
 */
export const ARTIFACT_UPLOAD_GRANT_ACCESS_SURFACE = "artifact_upload_grant";
export const ARTIFACT_DOWNLOAD_GRANT_ACCESS_SURFACE = "artifact_download_grant";

export type ObjectAccessOperation = "upload" | "download";

/** The `action` an object-access row of this operation carries. Total over the type. */
export function objectAccessAction(operation: ObjectAccessOperation): string {
  const surface =
    operation === "upload"
      ? ARTIFACT_UPLOAD_GRANT_ACCESS_SURFACE
      : ARTIFACT_DOWNLOAD_GRANT_ACCESS_SURFACE;
  return `${SECURITY_OBJECT_ACCESS_ACTION_PREFIX}${surface}`;
}

/**
 * What `artifact-transfer-grant.ts` captures INSIDE the tenant transaction and
 * drains AFTER it. A one-field holder rather than a bare `let`, for the same
 * narrowing reason the DE-06 denial sink is one: TypeScript narrows a `let` from
 * its initializer and cannot see an assignment made inside a closure.
 */
export interface ObjectAccessIntent {
  readonly operation: ObjectAccessOperation;
  /** The LOCKED LEASE's company, resolved under the worker's own org GUC. */
  readonly companyId: string;
  /** Token-attested, off the verified worker operation. Never off the wire. */
  readonly organizationId: string;
  /** The worker the capability was handed to. */
  readonly workerId: string;
  readonly targetId: string;
  readonly artifactId: string;
  /** The key that was actually SIGNED — not merely the key that was asked for. */
  readonly objectKey: string;
  /**
   * ★ THE FIELD THAT MAKES THIS ROW ANSWER DE-11's ACCESS HALF, AND IT IS
   * ASYMMETRIC BY CONSTRUCTION — stated here rather than discovered later.
   *
   * DE-11's clause is "SENSITIVE-artifact access and retention are audited", so
   * "which kind was reached" is the difference between a disclosure record and a
   * transfer counter. On the DOWNLOAD arm both values are free: the service has
   * already loaded the committed `job_artifacts` row to prove the key is this
   * tenant's, and that row carries `kind` and `sensitivity`.
   *
   * On the UPLOAD arm they are `null`, and NOT because nobody looked. At grant
   * time the artifact DOES NOT EXIST YET: the frozen upload-grant request
   * (`artifactTransferGrantOperationRequestV1Schema`) carries no `kind` and no
   * `sensitivity` — they are first declared in the COMMIT manifest, after the
   * bytes are already in the store. So a `null` here is a true answer about an
   * upload, and a reader wanting an upload's kind must join to the commit.
   * Guessing one would be a fabricated attribution.
   */
  readonly kind: string | null;
  readonly sensitivity: string | null;
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseId: string;
  /** When the issued capability stops working. The window of exposure. */
  readonly expiresAt: Date;
  /** The size bound the grant carried. Declared intent on upload; a hint on download. */
  readonly maxBytes: number;
}

export function createObjectAccessSink(): { intent: ObjectAccessIntent | null } {
  return { intent: null };
}

/**
 * Record one authorized object operation durably and attributably.
 * Returns the row id, or `null` when nothing could be written (logged at error).
 *
 * Deliberately does NOT publish a live event, for the reason the denial recorder
 * gives: `logActivity`'s publish is company-scoped, and an audit record that
 * broadcasts is an audit record that can be used as a channel.
 *
 * ★ NO FK FALLBACK, and that is a measured difference from `recordSecurityDenial`
 * rather than an oversight — the same difference `artifact-retention-audit.ts`
 * documents. That recorder retries with a null organization on a 23503 because
 * its subject is a REPLAYED CREDENTIAL FROM A TORN-DOWN TENANT, where the
 * attested organization may legitimately no longer have a row. This recorder's
 * subject is the opposite: it runs only after a live lease for that organization
 * was LOCKED and a company was resolved through `job_attempts` in the
 * transaction that just closed, so both FKs were satisfiable moments earlier.
 * The only way to a 23503 here is a tenant torn down inside that window, and the
 * honest handling of that is the swallow below with full attribution in the log
 * — not a fallback into the tenantless sink, whose partial CHECK this namespace
 * does not satisfy anyway (see `activity-namespace.ts`).
 */
export async function recordObjectAccessGrant(
  db: Db,
  intent: ObjectAccessIntent,
): Promise<string | null> {
  const action = objectAccessAction(intent.operation);
  const details = sanitizeRecord({
    crossing: "DE-06",
    control: "server/src/services/artifact-transfer-grant.ts:grant",
    operation: intent.operation,
    /**
     * The wire method the issued URL carries. Recorded literally so an operator
     * reading the row does not have to know the operation→verb mapping, and so a
     * future third operation cannot silently inherit "download" semantics.
     */
    method: intent.operation === "upload" ? "PUT" : "GET",
    /**
     * ★ THE ONE FIELD THIS RECORD EXISTS FOR. The key that was SIGNED. On the
     * download arm it equals the committed object's key (the service refuses any
     * mismatch), so it names precisely which bytes became reachable.
     */
    objectKey: intent.objectKey,
    /**
     * DE-11's access half rides on these two. Null on an upload for the reason
     * `ObjectAccessIntent.kind` gives — the artifact does not exist yet — which
     * is a real answer, not a missing one.
     */
    kind: intent.kind,
    sensitivity: intent.sensitivity,
    /**
     * ISSUANCE, NOT REDEMPTION — see the module header. `expiresAt` is the
     * window in which the issued capability works, and it is the closest thing
     * to an exposure bound this record can carry.
     */
    grantExpiresAt: intent.expiresAt.toISOString(),
    maxBytes: intent.maxBytes,
    organizationId: intent.organizationId,
    workerId: intent.workerId,
    targetId: intent.targetId,
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
        // A worker is a machine identity in the execution plane: it has no row
        // in `agents` and no row in `auth`, so neither the `agent` nor the
        // `user` actor kind is truthful. `actor_id` is plain text with no FK,
        // which is what makes `workerId` usable as the identity directly. Same
        // choice, for the same reason, as the DE-06 denial and DE-11 retention
        // call sites.
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
    // ★ THE FAILURE PATH LOGS THE ALREADY-SANITIZED `details`, NOT THE RAW
    // INTENT — and that is structural, not stylistic. (Codex P2 on PR #411,
    // verified at source and fixed rather than noted.)
    //
    // THE DEFECT, NAMED. The first draft re-listed the intent's fields here,
    // including `objectKey` VERBATIM, while the persisted row's copy of the same
    // value goes through `sanitizeRecord`. The object key's suffix is
    // CALLER-CONTROLLED — the frozen grant schema bounds it only by length and
    // by this org's attempt prefix — so a worker may legally name a file
    // `whsec_<24 chars>.bin` or `sk-ant-…`, and `sanitizeRecord` really does
    // redact exactly those (MEASURED: three secret-shaped suffixes come back
    // `***REDACTED***`, an ordinary `out.bin` comes back intact). A transient
    // FK or connection failure would then have written to the server log the one
    // value the durable row deliberately refuses to keep — i.e. the audit's own
    // redaction pass would have been defeated by its own error handler.
    //
    // WHY THIS SHAPE AND NOT A SECOND `sanitizeRecord` CALL: two sanitized
    // copies can drift, and the next field added to one would not reach the
    // other. There is exactly ONE sanitized `objectKey` in this module and both
    // sinks read it, so the two cannot disagree. `details` already carries every
    // diagnostic the old payload had (`workerId`, `organizationId`, `targetId`,
    // `jobId`, `attempt`, `leaseId`, `operation`), so nothing is lost.
    //
    // `err` is passed OUTSIDE `details` deliberately: pino serializes an Error
    // specially, and `sanitizeRecord` would leave a non-plain object untouched
    // anyway — routing it through would gain nothing and lose the serializer.
    // The sibling `security-denial-audit.ts` reaches the same place by a
    // different route: it logs only scalars and never its `details` at all.
    logger.error(
      {
        service: "artifact-object-access-audit",
        event: "security.object_access_audit_write_failed",
        crossing: "DE-06",
        action,
        companyId: intent.companyId,
        artifactId: intent.artifactId,
        details,
        err,
      },
      "failed to record an authorized object operation — the grant still stands, but it is now unattributable",
    );
    return null;
  }
}
