// server/src/services/job-control-ack.ts
//
// JOB-006 — the worker's fence-guarded control-command ACK upload.
//
// The frozen worker protocol declares the ACK payload (`controlCommandAckV1Schema`)
// and the server→worker `control_command` operation, but NOT a worker→server ACK
// request envelope. This service defines that thin HTTP-neutral envelope (the ACK
// plus the delivery identity the worker echoes) and runs the SAME dual-auth recheck
// as event upload / renew before delegating to the already-fence-guarded
// `ackControlCommand` tenant mutator. A stale/superseded fence can never ACK — the
// guard rejects it as stale_fence — so a disconnected worker's late ACK cannot
// disturb the winner.

import {
  JobFenceError as DbJobFenceError,
  type ControlCommandAckStatus,
  type Db,
} from "@armyofagents/db";
import {
  controlCommandAckV1Schema,
} from "@armyofagents/worker-protocol";
import { z } from "zod";
import { runInTenant } from "../db/tenant-context.js";
import {
  ackAuthorityCurrent,
  ackAuthorityCurrencyIntent,
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

/** The worker→server control-ACK envelope (HTTP-neutral): the delivery identity the
 * worker echoes plus the frozen ACK payload. There is no frozen envelope for this
 * direction. `ack` is validated in a SECOND pass against the frozen
 * `controlCommandAckV1Schema` (keeping this schema's inference shallow); the identity
 * fields are matched against the authoritative lease row. */
export const controlAckOperationRequestV1Schema = z.object({
  protocolVersion: z.literal(1),
  correlationId: z.string().uuid(),
  issuedAt: z.string().min(1),
  nonce: z.string().min(1).max(200),
  audience: z.literal("worker_run"),
  body: z.object({
    organizationId: z.string().uuid(),
    companyId: z.string().uuid(),
    workerId: z.string().uuid(),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    leaseId: z.string().uuid(),
    fenceToken: z.string().min(1),
    ack: z.unknown(),
  }),
});
export type ControlAckOperationRequestV1 = z.infer<typeof controlAckOperationRequestV1Schema>;

export interface ControlAckOperationResponseV1 {
  protocolVersion: 1;
  correlationId: string;
  serverTime: string;
  commandId: string;
  commandSeq: number;
  status: ControlCommandAckStatus;
  applied: boolean;
}

export function createJobControlAckService(input: {
  appDb: Db;
  maxHeartbeatAgeMs?: number;
}) {
  const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300_000);
  return {
    async ack(ackInput: {
      auth: VerifiedWorkerOperation;
      request: ControlAckOperationRequestV1;
    }): Promise<ControlAckOperationResponseV1> {
      const parsed = controlAckOperationRequestV1Schema.safeParse(ackInput.request);
      if (!parsed.success) throw new JobLeasingError("malformed");
      const request = parsed.data;
      // Second pass: the frozen ACK payload is validated on its own so this envelope
      // schema stays shallow (avoids deep zod type instantiation).
      const parsedAck = controlCommandAckV1Schema.safeParse(request.body.ack);
      if (!parsedAck.success) throw new JobLeasingError("malformed");
      const ack = parsedAck.data;
      const body = request.body;
      const auth = ackInput.auth;
      if (body.organizationId !== auth.organizationId || body.workerId !== auth.workerId) {
        throw new JobLeasingError("unauthorized");
      }

      // ★ DE-03, replay-rejection conjunct — the refusal below THROWS out of
      // `runInTenant`, so its record is collected as an INTENT and drained on the
      // pool handle once the transaction has unwound.
      const proofDenial = createWorkerDenialSink();
      // ★ DE-04 — the ackControlCommand fence refusal is caught INSIDE the callback and
      // REMAPPED to a `JobLeasingError` below, so the original `JobFenceError` is gone by
      // the time the transaction unwinds; it is captured at the inner catch (code + fence
      // identity both in hand) and drained on the pool handle in the `.finally`.
      const fenceGuardDenial = createFenceGuardDenialSink();
      // ★ DE-04/DE-18 — the ack-path worker-authority-currency refusal (the `ackAuthorityCurrent`
      // recheck, BEFORE the guarded mutator). Its `target_revoked` throw pre-empts the fence guard,
      // so it is the "separate, still-unaudited surface tracked as the follow-on" de-04-18's header
      // names. Captured as an INTENT and drained on the pool handle in the `.finally`.
      const authorityDenial = createWorkerDenialSink();

      // The explicit type argument is load-bearing: chaining `.finally` below drops
      // the contextual typing this call used to get from the method's return
      // annotation, and the response literal's `protocolVersion: 1` would widen to
      // `number`.
      return runInTenant<ControlAckOperationResponseV1>(input.appDb, auth.organizationId, async (repos) => {
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
        // A missing authority row carries no target/generation to classify — the fence-resolution
        // family owns that reason, not this arm — so it throws `unauthorized` unrecorded here.
        if (!authority) throw new JobLeasingError("unauthorized");
        // ★ DE-04/DE-18 — the authority-currency recheck. A reject records its CLASSIFIED intent
        // (crossing derived from the failed conjunct(s) by `ackAuthorityCurrencyIntent`, never the
        // composite boolean) as a single comma-throw, then drains on the pool handle in `.finally`.
        if (!ackAuthorityCurrent({
          auth,
          authority,
          workerId: body.workerId,
          databaseNow: authorityNow,
          maxHeartbeatAgeMs,
          platformPhysicalHeartbeatAt: null,
        })) {
          throw (authorityDenial.intent = ackAuthorityCurrencyIntent({
            auth, authority, workerId: body.workerId, databaseNow: authorityNow,
            maxHeartbeatAgeMs, platformPhysicalHeartbeatAt: null,
          }), new JobLeasingError("target_revoked"));
        }

        const target = await normalizePlacementRegistryTarget(authority.target);
        if (!target || target.status !== "active") throw new JobLeasingError("target_revoked");
        if (!await repos.jobControl.touchWorkerLeaseProfile({
          workerId: auth.workerId,
          targetId: auth.targetId,
          targetGeneration: auth.targetGeneration,
        })) throw new JobLeasingError("target_revoked");

        const context = await repos.jobControl.lockLeaseAckContext({
          organizationId: auth.organizationId,
          workerId: auth.workerId,
          targetId: auth.targetId,
          targetGeneration: auth.targetGeneration,
          profileHash: auth.profileHash,
          leaseId: body.leaseId,
          jobId: body.jobId,
          attemptNumber: body.attempt,
          fence: body.fenceToken,
        });
        if (!context) throw new JobLeasingError("stale_fence");
        if (!context.lease.companyId
          || !context.lease.jobId
          || !context.lease.attemptNumber
          || context.lease.companyId !== body.companyId
          || context.lease.jobId !== body.jobId
          || context.lease.attemptNumber !== body.attempt
          || context.lease.targetAuthorityKey !== authority.worker.targetAuthorityKey
          || context.lease.targetId !== target.targetId
          || context.lease.targetGeneration !== target.targetGeneration
          || context.lease.profileHash !== auth.profileHash
          || context.lease.providerConstraintHash !== target.providerConstraintHash) {
          throw new JobLeasingError("stale_fence");
        }

        const ackFence = {
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
          fence: body.fenceToken,
        };
        try {
          const result = await repos.jobControl.ackControlCommand({
            ...ackFence,
            ack: {
              commandId: ack.commandId,
              // JOB-015 — the frozen ACK schema has always carried this; the mutator
              // now MATCHES on it, so a mismatched echo cannot suppress redelivery.
              commandSeq: ack.commandSeq,
              status: ack.status,
              observedAt: new Date(ack.observedAt),
              detail: ack.detail,
            },
          });
          return {
            protocolVersion: 1,
            correlationId: request.correlationId,
            serverTime: authorityNow.toISOString(),
            commandId: ack.commandId,
            commandSeq: ack.commandSeq,
            status: ack.status,
            applied: result.ackOutcome?.applied ?? false,
          };
        } catch (error) {
          // Capture the governed-fence refusal before it is remapped away (no-op unless it
          // is a `JobFenceError`); the row is written in the `.finally` on the pool handle.
          captureFenceGuardDenial(fenceGuardDenial, ackFence, error);
          if (error instanceof DbJobFenceError) throw new JobLeasingError(error.code);
          throw error;
        }
      })
        // ★ DE-03 — drain the THROWING replay refusal on the POOL handle after the
        // tenant transaction has closed. `recordSecurityDenial` never throws, so a
        // broken recorder cannot turn a refusal into a 500.
        .finally(async () => {
          await drainWorkerDenial(input.appDb, proofDenial, {
            control: "server/src/services/job-control-ack.ts:ack",
            workerId: auth.workerId,
            operation: "control_command_ack",
          });
          // ★ DE-04/DE-18 — the ack-path authority-currency refusal (the `ackAuthorityCurrent`
          // recheck), on the pool handle. `worker_poll_authority` surface, crossing already keyed
          // on the intent by the classifier.
          await drainWorkerDenial(input.appDb, authorityDenial, {
            control: "server/src/services/job-control-ack.ts:ackAuthorityCurrent",
            workerId: auth.workerId,
            operation: "control_command_ack",
          });
          // ★ DE-04 — the governed-fence refusal (stale_fence / attempt_terminal /
          // target_revoked from ackControlCommand's guardActiveFence), on the pool handle.
          await drainFenceGuardDenialSink(input.appDb, fenceGuardDenial, {
            control: "server/src/services/job-control-ack.ts:ackControlCommand",
            operation: "control_command_ack",
          });
        });
    },
  };
}
