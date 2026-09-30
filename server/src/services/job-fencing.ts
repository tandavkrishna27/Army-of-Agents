// server/src/services/job-fencing.ts
//
// JOB-004 — the SHARED active-fence guard (server-side seam) + the conditional
// lease-renewal service that shares it.
//
// The distributed-execution path exposes a CLOSED set of governed worker
// operations (event acceptance, ordinary artifact metadata/commit authorization,
// secret-handle read, attempt/job terminal completion, service-instance health,
// projection-receipt apply, control-command ACK). Each of them may proceed ONLY
// while the presenting worker still holds the ACTIVE lease fence.
//
// The ONE common active-fence predicate (`isActiveFence`), its refusal classifier
// (`classifyFence`), the fence identity shape (`ActiveFenceRequest`), the closed
// governed-mutator name list (`GUARDED_JOB_MUTATORS`), and the typed `JobFenceError`
// all live in `@armyofagents/db` (`repositories/tenant/job-fence.ts`) so the tenant
// repository's guarded mutators and any server-side caller reference the EXACT same
// seam — there is no second, drifting copy. This module re-exports that surface and
// hosts the renewal service that also gates on the same fence.

import { createHash } from "node:crypto";
import {
  JobFenceError as DbJobFenceError,
  type Db,
} from "@armyofagents/db";
import {
  canonicalizeJsonV1,
  leaseRenewOperationRequestV1Schema,
  leaseRenewOperationResponseV1Schema,
  type LeaseRenewOperationRequestV1,
  type LeaseRenewOperationResponseV1,
  type WireExtension,
} from "@armyofagents/worker-protocol";
import { runInTenant } from "../db/tenant-context.js";
import { projectControlCommandExtensions } from "./control-command-projection.js";
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

export {
  isActiveFence,
  classifyFence,
  JobFenceError,
  GUARDED_JOB_MUTATORS,
  TERMINAL_ATTEMPT_STATUSES,
  type ActiveFenceRequest,
  type ActiveFenceSnapshot,
  type GuardedJobMutator,
  type JobFenceErrorCode,
} from "@armyofagents/db";

/**
 * The closed governed-mutator surface, as the server understands it. Every name is
 * a method on the tenant `JobControlRepository` that MUST gate on the common
 * active-fence predicate. Kept here (mirroring `GUARDED_JOB_MUTATORS`) as the
 * server-side authoritative list the contract test and future guarded callers read.
 */
export const GOVERNED_FENCE_SURFACE = [
  "acceptEvent",
  "authorizeArtifactCommit",
  // DAT-009 slice 2 — the fenced grant-INTENT write at upload-grant mint (see
  // GUARDED_JOB_MUTATORS). Records the object key so an orphaned upload is
  // discoverable by its own record; the storage port cannot list.
  "recordArtifactGrantIntent",
  // DAT-002 — fenced verified artifact-manifest commit (see GUARDED_JOB_MUTATORS).
  "commitArtifactVersion",
  // DAT-003 — fenced workspace-patch apply/review disposition (see GUARDED_JOB_MUTATORS).
  "recordPatchApplyState",
  "readSecretHandle",
  // DAT-004 — fenced lease-scoped secret-handle resolve authorization (see GUARDED_JOB_MUTATORS).
  "resolveExecutionSecret",
  "completeAttempt",
  "recordServiceHealth",
  "applyProjectionReceipt",
  "ackControlCommand",
] as const;
export type GovernedFenceSurface = (typeof GOVERNED_FENCE_SURFACE)[number];

/** The renew semantic digest — same shape as the ACK digest, over the renew body.
 * Any change to the presented identity, fence, or observed time changes the digest
 * → a lost-response replay with a drifted body is `malformed`, never a second
 * extension. `observedAt` (E1) is part of the digest but NEVER authorizes expiry:
 * expiry is decided by the server's fresh `clock_timestamp()` in the mutation. */
function semanticRenewDigest(
  auth: VerifiedWorkerOperation,
  request: LeaseRenewOperationRequestV1,
): string {
  return createHash("sha256").update(canonicalizeJsonV1({
    audience: request.audience,
    workerId: auth.workerId,
    targetId: auth.targetId,
    targetGeneration: auth.targetGeneration,
    profileHash: auth.profileHash,
    body: request.body,
  })).digest("hex");
}

/**
 * The conditional lease-renewal service. Mirrors the ACK path's dual-auth recheck
 * under fresh database time and durable same-key/same-digest replay, then delegates
 * the atomic renewal to the tenant repository's `renewLease` (which gates on the
 * shared active-fence guard and extends expiry with a FRESH SQL `clock_timestamp()`
 * in the mutation). Server policy supplies the lease duration; the worker cannot
 * extend arbitrarily and E1 `observedAt` never authorizes expiry.
 *
 * Renewal serves only proof-bound org/owner authority (the worker-run device proof
 * rejects platform scope). A platform-scoped target has no physical heartbeat on
 * this path, so `ackAuthorityCurrent` fails closed → `target_revoked`; platform-
 * target renewal is out of JOB-004 scope and is deliberately fail-closed.
 */
export function createJobLeaseRenewalService(input: {
  appDb: Db;
  leaseDurationMs?: number;
  maxHeartbeatAgeMs?: number;
}) {
  const leaseDurationMs = Math.max(1000, input.leaseDurationMs ?? 300_000);
  const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300_000);
  return {
    async renew(renewInput: {
      auth: VerifiedWorkerOperation;
      request: LeaseRenewOperationRequestV1;
    }): Promise<LeaseRenewOperationResponseV1> {
      const parsedRequest = leaseRenewOperationRequestV1Schema.safeParse(renewInput.request);
      if (!parsedRequest.success) throw new JobLeasingError("malformed");
      const request = parsedRequest.data;
      const digest = semanticRenewDigest(renewInput.auth, request);
      // ★ DE-03, replay-rejection conjunct — the refusal below THROWS out of
      // `runInTenant`, so its record is collected as an INTENT and drained on the
      // pool handle once the transaction has unwound.
      const proofDenial = createWorkerDenialSink();
      // ★ DE-04 / DE-18 — the renewLease fence refusal is caught INSIDE the callback and
      // REMAPPED to a `JobLeasingError` below, so it never propagates as a `JobFenceError`.
      // Captured at the inner catch (stale_fence / target_revoked / attempt_terminal) and
      // drained on the pool handle in the `.finally`.
      const fenceGuardDenial = createFenceGuardDenialSink();

      return runInTenant(input.appDb, renewInput.auth.organizationId, async (repos) => {
        const databaseNow = await repos.jobControl.currentDatabaseTime();
        await repos.workerEnrollment.cleanupExpiredProofs(databaseNow, 100);
        await repos.jobControl.cleanupExpiredOperationReceipts(databaseNow, 100);
        const proofRecorded = await repos.workerEnrollment.recordProof({
          organizationId: renewInput.auth.organizationId,
          deviceThumbprint: renewInput.auth.deviceThumbprint,
          proofId: renewInput.auth.proofId,
          issuedAt: renewInput.auth.proofIssuedAt,
          expiresAt: renewInput.auth.sessionExpiresAt,
        });
        if (!proofRecorded) {
          proofDenial.intent = workerProofReplayIntent(renewInput.auth);
          throw new JobLeasingError("unauthorized");
        }

        const authority = await repos.jobControl.lockWorkerLeaseAuthority({
          workerId: renewInput.auth.workerId,
          targetId: renewInput.auth.targetId,
        });
        const authorityNow = await repos.jobControl.currentDatabaseTime();
        if (!authority || !ackAuthorityCurrent({
          auth: renewInput.auth,
          authority,
          workerId: request.body.workerId,
          databaseNow: authorityNow,
          maxHeartbeatAgeMs,
          platformPhysicalHeartbeatAt: null,
        })) throw new JobLeasingError(authority ? "target_revoked" : "unauthorized");

        const target = await normalizePlacementRegistryTarget(authority.target);
        if (!target || target.status !== "active") throw new JobLeasingError("target_revoked");
        if (!await repos.jobControl.touchWorkerLeaseProfile({
          workerId: renewInput.auth.workerId,
          targetId: renewInput.auth.targetId,
          targetGeneration: renewInput.auth.targetGeneration,
        })) throw new JobLeasingError("target_revoked");

        const prior = await repos.jobControl.findOperationReceipt({
          organizationId: renewInput.auth.organizationId,
          workerId: renewInput.auth.workerId,
          targetId: renewInput.auth.targetId,
          targetGeneration: renewInput.auth.targetGeneration,
          profileHash: renewInput.auth.profileHash,
          operation: "lease_renew",
          idempotencyKey: request.idempotencyKey,
        });
        if (prior) {
          // Lost-response replay: a changed digest is generic `malformed`; an
          // identical scope/key/digest replays the EXACT stored renewal (the same
          // expiry) and CANNOT extend a second time. A later renewal effect requires
          // a NEW idempotency key.
          if (prior.semanticDigest !== digest) throw new JobLeasingError("malformed");
          return leaseRenewOperationResponseV1Schema.parse({
            protocolVersion: 1,
            correlationId: request.correlationId,
            serverTime: authorityNow.toISOString(),
            outcome: "renewed",
            body: prior.outcome,
          });
        }

        // Lock the lease + attempt by the presented fence identity; a superseded or
        // never-issued fence matches no row (→ stale_fence). The rich JOB-003 lease
        // tuple must be complete and pinned to the CURRENT authority/target.
        const context = await repos.jobControl.lockLeaseAckContext({
          organizationId: renewInput.auth.organizationId,
          workerId: renewInput.auth.workerId,
          targetId: renewInput.auth.targetId,
          targetGeneration: renewInput.auth.targetGeneration,
          profileHash: renewInput.auth.profileHash,
          leaseId: request.body.leaseId,
          jobId: request.body.jobId,
          attemptNumber: request.body.attempt,
          fence: request.body.fenceToken,
        });
        if (!context) throw new JobLeasingError("stale_fence");
        if (!context.lease.companyId
          || !context.lease.jobId
          || !context.lease.attemptNumber
          || !context.lease.expiresAt
          || context.lease.targetAuthorityKey !== authority.worker.targetAuthorityKey
          || context.lease.targetId !== target.targetId
          || context.lease.targetGeneration !== target.targetGeneration
          || context.lease.profileHash !== renewInput.auth.profileHash
          || context.lease.providerConstraintHash !== target.providerConstraintHash) {
          throw new JobLeasingError("stale_fence");
        }

        const renewFence = {
          organizationId: renewInput.auth.organizationId,
          companyId: context.lease.companyId,
          jobId: context.lease.jobId,
          attemptId: context.lease.attemptId,
          attemptNumber: context.lease.attemptNumber,
          leaseId: context.lease.id,
          workerId: renewInput.auth.workerId,
          targetId: target.targetId,
          targetAuthorityKey: authority.worker.targetAuthorityKey,
          targetGeneration: target.targetGeneration,
          profileHash: renewInput.auth.profileHash,
          providerConstraintHash: target.providerConstraintHash,
          fence: request.body.fenceToken,
        };
        try {
          const { body } = await repos.jobControl.renewLease({
            ...renewFence,
            leaseDurationMs,
            idempotencyKey: request.idempotencyKey,
            semanticDigest: digest,
            // JOB-015 — the ONE production wiring of the control-command projection.
            // `packages/db` cannot build the frozen extension itself (it has no
            // worker-protocol dependency), so the server supplies the projector and the
            // mutator supplies the un-ACKed commands it already reads for
            // `cancelRequested`. A throw here (the overflow marker itself does not fit)
            // is a protocol error on the renew, deliberately NOT a 200 whose body reads
            // as "no commands pending".
            projectControlExtensions: (existing, pending) =>
              projectControlCommandExtensions(
                existing as readonly WireExtension[],
                pending.map((command) => ({
                  commandId: command.commandId,
                  commandSeq: command.commandSeq,
                  commandKind: command.commandKind,
                  command: command.command,
                })),
              ),
          });
          return leaseRenewOperationResponseV1Schema.parse({
            protocolVersion: 1,
            correlationId: request.correlationId,
            serverTime: authorityNow.toISOString(),
            outcome: "renewed",
            body,
          });
        } catch (error) {
          // Capture the governed-fence refusal before it is remapped away (no-op unless a
          // `JobFenceError`); the row is written in the `.finally` on the pool handle.
          captureFenceGuardDenial(fenceGuardDenial, renewFence, error);
          // The shared fence guard classifies the refusal; surface it uniformly.
          if (error instanceof DbJobFenceError) throw new JobLeasingError(error.code);
          throw error;
        }
      })
        // ★ DE-03 — drain the THROWING replay refusal on the POOL handle after the
        // tenant transaction has closed. `recordSecurityDenial` never throws, so a
        // broken recorder cannot turn a refusal into a 500.
        .finally(async () => {
          await drainWorkerDenial(input.appDb, proofDenial, {
            control: "server/src/services/job-fencing.ts:renew",
            workerId: renewInput.auth.workerId,
            operation: "lease_renew",
          });
          // ★ DE-04 / DE-18 — the governed-fence refusal (stale_fence / target_revoked /
          // attempt_terminal from renewLease's guardActiveFence), on the pool handle.
          await drainFenceGuardDenialSink(input.appDb, fenceGuardDenial, {
            control: "server/src/services/job-fencing.ts:renewLease",
            operation: "lease_renew",
          });
        });
    },
  };
}
