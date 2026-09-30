// server/src/services/job-events.ts
//
// JOB-005 — the fenced worker-event ingest service.
//
// It commits an ordered batch of worker events ONCE and returns a stable
// CUMULATIVE ACK, applying the legal job/attempt state projection transactionally.
// The full pipeline runs inside ONE `runInTenant` transaction:
//
//   (a) authenticate the delivery identity + revalidate CURRENT worker/target
//       authority under fresh database time (mirrors the ACK/renew dual-auth
//       recheck), then resolve the presented fence identity from the lease row;
//   (b) hand the batch to the guarded `acceptEvent` mutator, which gates on the
//       ACTIVE fence FIRST (throws stale_fence / attempt_terminal), rejects
//       in-batch/hash/gap violations, appends accepted events immutably, and
//       applies the state projection (first attempt_started → attempt
//       leased→running + job queued→running; terminal → attempt completion);
//   (c) return the cumulative ACK — accepted / gap / hash_mismatch from the
//       mutator, or stale_fence / terminal mapped from the thrown JobFenceError.
//
// The digest is recomputed here from the E1 canonical bytes — this service NEVER
// reimplements RFC 8785 canonicalization or the digest (imports the frozen
// worker-protocol helpers). Fence precedence: because the guarded-mutator invariant
// requires the fence check to run before any governed row is touched, a stale fence
// surfaces as `stale_fence` even when a digest would also mismatch (a documented
// deviation from decideEventReceiverV1's hash-first ordering — both are rejections
// with no writes).

import { createHash } from "node:crypto";
import {
  JobFenceError as DbJobFenceError,
  type AcceptEventInput,
  type Db,
} from "@armyofagents/db";
import {
  canonicalEventDigestInputV1,
  eventUploadOperationRequestV1Schema,
  eventUploadOperationResponseV1Schema,
  type EventUploadOperationRequestV1,
  type EventUploadOperationResponseV1,
  type TerminalEventStatus,
  type WorkerEventBatchV1,
} from "@armyofagents/worker-protocol";
import { runInTenant } from "../db/tenant-context.js";
import {
  ackAuthorityCurrent,
  JobLeasingError,
  type VerifiedWorkerOperation,
} from "./job-leasing.js";
import { normalizePlacementRegistryTarget } from "./execution-target-resolver.js";
import {
  createWorkerDenialSink,
  drainWorkerDenial,
  workerProofReplayIntent,
} from "./worker-denial-audit.js";
import {
  createFenceGuardDenialSink,
  captureFenceGuardDenial,
  drainFenceGuardDenialSink,
} from "./fence-denial-audit.js";
import { logger } from "../middleware/logger.js";
import { bindJobTraceLogger } from "./job-trace-log.js";
import { decideServiceProjectionForEvent } from "./service-health-projection.js";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Project each wire event onto the repo's server-validated append shape. The
 * digest is recomputed from the E1 canonical bytes (supplied vs recomputed drives
 * hash_mismatch inside the guarded mutator); `terminalStatus` is set only for a
 * `terminal` event so the projection can complete the attempt. */
function toAcceptInputs(batch: WorkerEventBatchV1): AcceptEventInput[] {
  return batch.events.map((event) => {
    const recomputedDigest = sha256Hex(canonicalEventDigestInputV1(event));
    const terminalStatus = event.eventType === "terminal"
      ? (event.payload.status as TerminalEventStatus)
      : null;
    return {
      eventId: event.eventId,
      sequence: event.seq,
      eventType: event.eventType,
      fenceToken: event.fenceToken,
      suppliedDigest: event.eventDigest,
      recomputedDigest,
      occurredAt: new Date(event.occurredAt),
      payload: event as unknown as Record<string, unknown>,
      terminalStatus,
      // SVC-003 — decided HERE because the frozen `SERVICE_INSTANCE_TRANSITIONS` table lives
      // in worker-protocol and `packages/db` deliberately does not depend on it. The
      // repository applies the decision under the fence; it never re-derives it.
      serviceProjection: decideServiceProjectionForEvent(event),
    };
  });
}

/**
 * CLI-006: identity of an attempt that just reached a durable terminal state.
 * Handed to the after-commit projection hook so a canary-owned heartbeat run can
 * be finalized from the attempt's evidence.
 */
export interface AttemptTerminalSignal {
  readonly organizationId: string;
  readonly companyId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly terminalStatus: TerminalEventStatus;
}

/**
 * CLI-006 — decide whether THIS ingest just terminalized the attempt.
 *
 * Pure, and deliberately narrow. Two distinctions matter:
 *
 *  - A batch carries a terminal event only when one of its accept inputs has a
 *    non-null `terminalStatus` (set in `toAcceptInputs` for `eventType==="terminal"`).
 *  - `status === "terminal"` in the ACK does NOT mean "just became terminal". It is
 *    the fence guard reporting the attempt was ALREADY terminal and refusing the
 *    append BEFORE touching any row. Projecting on that would re-fire the terminal
 *    projection on every late retry of an already-finished attempt.
 *
 * So the signal is: the batch contained a terminal event AND the append was accepted.
 */
export function resolveAttemptTerminalSignal(input: {
  acceptInputs: readonly AcceptEventInput[];
  ackStatus: "accepted" | "gap" | "hash_mismatch" | "stale_fence" | "terminal";
  identity: { organizationId: string; companyId: string; jobId: string; attemptId: string };
}): AttemptTerminalSignal | null {
  if (input.ackStatus !== "accepted") return null;
  const terminal = input.acceptInputs.find((event) => event.terminalStatus != null);
  if (!terminal || terminal.terminalStatus == null) return null;
  return {
    organizationId: input.identity.organizationId,
    companyId: input.identity.companyId,
    jobId: input.identity.jobId,
    attemptId: input.identity.attemptId,
    terminalStatus: terminal.terminalStatus,
  };
}

/**
 * CLI-006 (2b) — the after-commit terminal projection hook. Named so the three
 * composition hops (index.ts -> createApp -> workerControlRoutes) declare ONE
 * type instead of three structural copies that can drift apart silently.
 */
export type JobEventIngestTerminalHook = (signal: AttemptTerminalSignal) => void | Promise<void>;

export function createJobEventIngestService(input: {
  appDb: Db;
  maxHeartbeatAgeMs?: number;
  /**
   * CLI-006 — fired AFTER the tenant transaction commits, when this ingest
   * terminalized the attempt. Optional: an unwired deployment behaves exactly as
   * before. It must never be called inside `runInTenant` — a projection failure
   * cannot be allowed to roll back the committed `acceptEvent` append (the same
   * invariant the trace-logger binding respects below), and its own failure is
   * swallowed so the worker's ACK is never lost to a projection error.
   */
  onAttemptTerminal?: JobEventIngestTerminalHook;
}) {
  const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300_000);
  return {
    async ingest(ingestInput: {
      auth: VerifiedWorkerOperation;
      request: EventUploadOperationRequestV1;
    }): Promise<EventUploadOperationResponseV1> {
      const parsedRequest = eventUploadOperationRequestV1Schema.safeParse(ingestInput.request);
      if (!parsedRequest.success) throw new JobLeasingError("malformed");
      const request = parsedRequest.data;
      const batch = request.body;
      const auth = ingestInput.auth;
      // The batch identity must be the authenticated worker/tenant.
      if (batch.organizationId !== auth.organizationId || batch.workerId !== auth.workerId) {
        throw new JobLeasingError("unauthorized");
      }
      const acceptInputs = toAcceptInputs(batch);

      // CLI-006: captured INSIDE the tx, fired AFTER it commits (see the hook doc).
      let terminalSignal: AttemptTerminalSignal | null = null;

      // ★ DE-03, replay-rejection conjunct — the refusal below THROWS out of
      // `runInTenant`, so its record is collected as an INTENT and drained on the
      // pool handle once the transaction has unwound.
      const proofDenial = createWorkerDenialSink();
      // ★ DE-04 — the acceptEvent fence refusal is caught INSIDE the callback and converted
      // to a cumulative-ACK status (invariant #8: a fence refusal must not roll back the
      // committed append), so it never propagates as a `JobFenceError`. It is captured at
      // the inner catch and drained on the pool handle in the `.finally`.
      const fenceGuardDenial = createFenceGuardDenialSink();

      const response = await runInTenant(input.appDb, auth.organizationId, async (repos) => {
        const databaseNow = await repos.jobControl.currentDatabaseTime();
        await repos.workerEnrollment.cleanupExpiredProofs(databaseNow, 100);
        await repos.jobControl.cleanupExpiredOperationReceipts(databaseNow, 100);
        const proofRecorded = await repos.workerEnrollment.recordProof({
          organizationId: auth.organizationId,
          deviceThumbprint: auth.deviceThumbprint,
          proofId: auth.proofId,
          issuedAt: auth.proofIssuedAt,
          expiresAt: auth.sessionExpiresAt,
        });
        if (!proofRecorded) {
          proofDenial.intent = workerProofReplayIntent(auth);
          throw new JobLeasingError("unauthorized");
        }

        const authority = await repos.jobControl.lockWorkerLeaseAuthority({
          workerId: auth.workerId,
          targetId: auth.targetId,
        });
        const authorityNow = await repos.jobControl.currentDatabaseTime();
        if (!authority || !ackAuthorityCurrent({
          auth,
          authority,
          workerId: batch.workerId,
          databaseNow: authorityNow,
          maxHeartbeatAgeMs,
          platformPhysicalHeartbeatAt: null,
        })) throw new JobLeasingError(authority ? "target_revoked" : "unauthorized");

        const target = await normalizePlacementRegistryTarget(authority.target);
        if (!target || target.status !== "active") throw new JobLeasingError("target_revoked");
        if (!await repos.jobControl.touchWorkerLeaseProfile({
          workerId: auth.workerId,
          targetId: auth.targetId,
          targetGeneration: auth.targetGeneration,
        })) throw new JobLeasingError("target_revoked");

        // Resolve the presented fence identity from the lease row (attemptId +
        // companyId are not on the wire). A superseded/never-issued fence matches
        // no row → stale_fence; the rich JOB-003 lease tuple must be complete and
        // pinned to the CURRENT authority/target.
        const context = await repos.jobControl.lockLeaseAckContext({
          organizationId: auth.organizationId,
          workerId: auth.workerId,
          targetId: auth.targetId,
          targetGeneration: auth.targetGeneration,
          profileHash: auth.profileHash,
          leaseId: batch.leaseId,
          jobId: batch.jobId,
          attemptNumber: batch.attempt,
          fence: batch.fenceToken,
        });
        if (!context) throw new JobLeasingError("stale_fence");
        if (!context.lease.companyId
          || !context.lease.jobId
          || !context.lease.attemptNumber
          || !context.lease.expiresAt
          || context.lease.companyId !== batch.companyId
          || context.lease.jobId !== batch.jobId
          || context.lease.attemptNumber !== batch.attempt
          || context.lease.targetAuthorityKey !== authority.worker.targetAuthorityKey
          || context.lease.targetId !== target.targetId
          || context.lease.targetGeneration !== target.targetGeneration
          || context.lease.profileHash !== auth.profileHash
          || context.lease.providerConstraintHash !== target.providerConstraintHash) {
          throw new JobLeasingError("stale_fence");
        }

        const fenceIdentity = {
          organizationId: auth.organizationId,
          companyId: context.lease.companyId,
          jobId: context.lease.jobId,
          attemptId: context.lease.attemptId,
          attemptNumber: context.lease.attemptNumber,
          leaseId: context.lease.id,
          workerId: auth.workerId,
          targetId: target.targetId,
          targetAuthorityKey: authority.worker.targetAuthorityKey,
          targetGeneration: target.targetGeneration,
          profileHash: auth.profileHash,
          providerConstraintHash: target.providerConstraintHash,
          fence: batch.fenceToken,
        };

        let status: "accepted" | "gap" | "hash_mismatch" | "stale_fence" | "terminal";
        let acceptedThroughSeq: number;
        let rejectedEventId: string | undefined;
        // SVC-003 — projections that were ATTEMPTED and REFUSED. Collected so a refusal is
        // visible in the operator log instead of being an invisible no-write: a stale
        // generation, a worker naming another instance, or a late event trying to resurrect
        // a terminal instance are all security-relevant and all otherwise silent.
        let refusedProjections: { eventId: string; outcome: string }[] = [];
        try {
          const result = await repos.jobControl.acceptEvent({
            ...fenceIdentity,
            batch: { events: acceptInputs },
          });
          const ack = result.ingest;
          if (!ack) throw new JobLeasingError("internal_unavailable");
          status = ack.status;
          acceptedThroughSeq = ack.acceptedThroughSeq;
          rejectedEventId = ack.rejectedEventId;
          refusedProjections = (result.serviceProjections ?? [])
            .filter((entry) => entry.result.outcome !== "applied"
              && entry.result.outcome !== "noop_same_status"
              // A batch job's `attempt_started` is `unattributed` by construction (there is
              // no service instance), which is the correct answer and not a refusal.
              && entry.result.outcome !== "unattributed")
            .map((entry) => ({ eventId: entry.eventId, outcome: entry.result.outcome }));
        } catch (error) {
          if (!(error instanceof DbJobFenceError)) throw error;
          // ★ DE-04 — capture the governed-fence refusal (drained on the pool handle in the
          // `.finally`) before it is folded into the cumulative-ACK status below.
          captureFenceGuardDenial(fenceGuardDenial, fenceIdentity, error);
          // The active-fence guard refused BEFORE any append: report the cumulative
          // ACK with the fence status (stale_fence / terminal) and the current
          // accepted-through sequence. No governed row was touched.
          acceptedThroughSeq = await repos.jobControl.readAcceptedThroughSeq({
            organizationId: auth.organizationId,
            companyId: context.lease.companyId,
            jobId: context.lease.jobId,
            attemptId: context.lease.attemptId,
          });
          status = error.code === "attempt_terminal" ? "terminal" : "stale_fence";
        }

        // DEP-007 — the JOB-005 ingest hop binds the durable trace spine (already
        // assembled as `fenceIdentity`) onto a child logger so this hop's structured
        // line is join-able on `jobId` with the poll/ack hops and the durable
        // `job_events` rows. Ids live only in the operator-only log sink (never a
        // metric label); best-effort, never alters the ack path.
        try {
          bindJobTraceLogger(logger, {
            organizationId: fenceIdentity.organizationId,
            companyId: fenceIdentity.companyId,
            jobId: fenceIdentity.jobId,
            attemptId: fenceIdentity.attemptId,
            attemptNumber: fenceIdentity.attemptNumber,
            leaseId: fenceIdentity.leaseId,
            fence: fenceIdentity.fence,
            sequence: acceptedThroughSeq,
            executionSourceKind: "distributed_worker",
          }).debug(
            refusedProjections.length > 0
              ? { status, refusedServiceProjections: refusedProjections }
              : { status },
            "job_events ingest",
          );
        } catch {
          // Best-effort trace binding INSIDE the tenant tx: a logger throw must NEVER
          // propagate and roll back the committed acceptEvent append (invariant #8).
        }

        terminalSignal = resolveAttemptTerminalSignal({
          acceptInputs,
          ackStatus: status,
          identity: fenceIdentity,
        });

        return eventUploadOperationResponseV1Schema.parse({
          protocolVersion: 1,
          correlationId: request.correlationId,
          serverTime: authorityNow.toISOString(),
          ack: {
            protocolVersion: 1,
            organizationId: batch.organizationId,
            companyId: batch.companyId,
            workerId: batch.workerId,
            jobId: batch.jobId,
            attempt: batch.attempt,
            leaseId: batch.leaseId,
            fenceToken: batch.fenceToken,
            acceptedThroughSeq,
            expectedNextSeq: acceptedThroughSeq + 1,
            status,
            ...(status === "hash_mismatch" && rejectedEventId
              ? { rejectedEventId }
              : {}),
          },
        });
      })
        // ★ DE-03 — drain the THROWING replay refusal on the POOL handle after the
        // tenant transaction has closed. `recordSecurityDenial` never throws, so a
        // broken recorder cannot turn a refusal into a 500.
        .finally(async () => {
          await drainWorkerDenial(input.appDb, proofDenial, {
            control: "server/src/services/job-events.ts:ingest",
            workerId: auth.workerId,
            operation: "event_upload",
          });
          // ★ DE-04 — the governed-fence refusal (stale_fence / attempt_terminal) that
          // acceptEvent's guardActiveFence raised, on the pool handle after tx close.
          await drainFenceGuardDenialSink(input.appDb, fenceGuardDenial, {
            control: "server/src/services/job-events.ts:acceptEvent",
            operation: "event_upload",
          });
        });

      // AFTER COMMIT ONLY. The attempt's durable terminal is already persisted; the
      // heartbeat-side projection is a downstream read of it, so a projection failure
      // must cost neither the append nor the worker's ACK. Swallowed deliberately —
      // the projector is itself best-effort per substep, and a stranded run is
      // recoverable, whereas a lost ACK makes the worker replay a terminal forever.
      if (terminalSignal && input.onAttemptTerminal) {
        try {
          await input.onAttemptTerminal(terminalSignal);
        } catch (err) {
          logger.warn({ err, signal: terminalSignal }, "attempt-terminal projection hook failed");
        }
      }

      return response;
    },
  };
}
