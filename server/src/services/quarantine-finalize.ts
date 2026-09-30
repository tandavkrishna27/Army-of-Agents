// server/src/services/quarantine-finalize.ts
//
// DAT-006 — the `quarantine_finalize` service. After the daemon has uploaded a DEAD-FENCE
// orphan artifact to the DISTINCT `quarantine/` object key, this verifies the object's
// integrity and records the `status='quarantined'` orphan row. The wire shapes are FROZEN
// (worker-protocol v1); the receipt's only disposition is `quarantined` — there is NO
// apply/promote/select operation, and this path is STRUCTURALLY incapable of touching the
// committed attempt row (it calls only `recordOrphanQuarantine`, which writes a row whose
// `status='quarantined'` is excluded from the committed partial-unique).
//
// Posture (design §4.3):
//   * DEVICE-auth only (`resolveWorkerDeviceContext`) — an orphan is a dead-fence output,
//     so there is no lease/fence to guard. Refusals are `unauthorized`/`target_revoked`,
//     NEVER `stale_fence` (which is not in the frozen quarantine_finalize error set).
//   * `headObject` integrity is FAIL-CLOSED: a missing object, a store that cannot supply
//     a sha/size, a hash mismatch, or a size mismatch (a partial write / full disk) all
//     refuse rather than record an unverifiable orphan.
//   * A hash mismatch maps to the frozen `event_hash_mismatch`; every other refusal is the
//     coarse, non-disclosing `malformed`.

import type { Db } from "@armyofagents/db";
import { OrphanQuarantineRejection } from "@armyofagents/db";
import {
  quarantineFinalizeOperationRequestV1Schema,
  quarantineFinalizeOperationResponseV1Schema,
  quarantineUploadReceiptV1Schema,
  type QuarantineFinalizeOperationRequestV1,
  type QuarantineFinalizeOperationResponseV1,
} from "@armyofagents/worker-protocol";
import { runInTenant } from "../db/tenant-context.js";
import { JobLeasingError, type VerifiedWorkerOperation } from "./job-leasing.js";
import { resolveWorkerDeviceContext } from "./worker-fence-context.js";
import {
  createWorkerDenialSink,
  drainWorkerDenial,
} from "./worker-denial-audit.js";
import type { StorageProvider } from "../storage/types.js";

export function createQuarantineFinalizeService(input: {
  appDb: Db;
  storage: StorageProvider;
  maxHeartbeatAgeMs?: number;
}) {
  const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300_000);

  return {
    async finalize(finalizeInput: {
      auth: VerifiedWorkerOperation;
      request: QuarantineFinalizeOperationRequestV1;
    }): Promise<QuarantineFinalizeOperationResponseV1> {
      const parsed = quarantineFinalizeOperationRequestV1Schema.safeParse(finalizeInput.request);
      if (!parsed.success) throw new JobLeasingError("malformed");
      const request = parsed.data;
      const body = request.body;
      const auth = finalizeInput.auth;
      if (body.workerId !== auth.workerId) throw new JobLeasingError("unauthorized");
      if (String(body.organizationId) !== String(auth.organizationId)) throw new JobLeasingError("unauthorized");
      if (String(body.targetId) !== String(auth.targetId)) throw new JobLeasingError("unauthorized");

      const rejected = (reason: string): QuarantineFinalizeOperationResponseV1 =>
        quarantineFinalizeOperationResponseV1Schema.parse({
          protocolVersion: 1,
          correlationId: request.correlationId,
          serverTime: new Date().toISOString(),
          outcome: "rejected",
          reason,
        });

      // ★ DE-03 — the replay refusal inside `resolveWorkerDeviceContext` THROWS out
      // of `runInTenant`, so its record is collected as an INTENT here and drained on
      // the pool handle after the transaction has unwound. The sink is a no-op when
      // nothing was refused.
      const proofDenial = createWorkerDenialSink();

      return runInTenant(input.appDb, auth.organizationId, async (repos) => {
        // DEVICE-only current-authority recheck (no lease/fence). Throws
        // unauthorized/target_revoked, never stale_fence.
        const ctx = await resolveWorkerDeviceContext(repos, auth, maxHeartbeatAgeMs, proofDenial);

        // Integrity: head the quarantine object and FAIL CLOSED on anything short of a
        // fully-verified sha256 + size match. This precedes the record so no unverifiable
        // orphan is ever persisted (a partial write / full disk fails here).
        const head = await input.storage.headObject({ objectKey: body.quarantineObjectKey });
        if (!head.exists) return rejected("malformed");
        if (head.checksumSha256 === undefined || head.contentLength === undefined) return rejected("malformed");
        if (head.checksumSha256 !== body.expectedSha256) return rejected("event_hash_mismatch");
        if (head.contentLength !== body.sizeBytes) return rejected("malformed");

        try {
          const outcome = await repos.jobControl.recordOrphanQuarantine({
            organizationId: auth.organizationId,
            targetId: ctx.targetId,
            deviceGeneration: ctx.targetGeneration,
            jobId: body.jobId,
            attemptNumber: body.attempt,
            identifier: body.artifactId,
            quarantineObjectKey: body.quarantineObjectKey,
            sha256: body.expectedSha256,
            sizeBytes: body.sizeBytes,
            sensitivity: body.manifest.sensitivity,
            kind: body.manifest.kind,
            reason: body.reason,
            observedLeaseId: body.observedLeaseId,
            observedFenceToken: body.observedFenceToken,
          });

          // Build the receipt STRICTLY from the STORED row, never the request body: the
          // idempotent insert key is (org, job, attempt, identifier) and does NOT include
          // objectKey/sha/size, so a DIVERGENT replay (same job/attempt/identifier, a new
          // object) is a DO-NOTHING — its receipt must reflect the DURABLE record (the
          // first upload), not the second body, or the acknowledged receipt would lie about
          // what is quarantined. `receiptId` is the stored row id; disposition is always
          // `quarantined`; `provenance` is `generated` (an orphan has no frozen provenance).
          const stored = outcome.artifact;
          const receipt = quarantineUploadReceiptV1Schema.parse({
            protocolVersion: 1,
            receiptId: stored.id,
            quarantineObjectKey: stored.objectKey,
            observed: {
              workerId: auth.workerId,
              targetId: ctx.targetId,
              deviceGeneration: ctx.targetGeneration,
              jobId: stored.jobId,
              attempt: stored.attempt,
              leaseId: stored.observedLeaseId,
              fenceToken: stored.observedFenceToken,
            },
            artifact: {
              artifactId: stored.identifier,
              sha256: stored.sha256,
              sizeBytes: stored.sizeBytes,
              sensitivity: stored.sensitivity,
              provenance: "generated",
            },
            reason: stored.quarantineReason,
            receivedAt: (stored.createdAt ?? ctx.authorityNow).toISOString(),
            disposition: "quarantined",
          });
          return quarantineFinalizeOperationResponseV1Schema.parse({
            protocolVersion: 1,
            correlationId: request.correlationId,
            serverTime: ctx.authorityNow.toISOString(),
            outcome: "quarantined",
            receipt,
          });
        } catch (error) {
          if (error instanceof OrphanQuarantineRejection) {
            // target_revoked → the frozen device-auth code; unknown_job → coarse malformed.
            return rejected(error.reason === "target_revoked" ? "target_revoked" : "malformed");
          }
          throw error;
        }
      })
        // ★ DE-03 — drain the THROWING replay refusal on the POOL handle after the
        // tenant transaction has closed. `.finally` awaits a thenable callback, so the
        // row is written before the caller sees the `JobLeasingError`;
        // `recordSecurityDenial` never throws, so this cannot alter the outcome.
        .finally(async () => {
          await drainWorkerDenial(input.appDb, proofDenial, {
            control: "server/src/services/worker-fence-context.ts:resolveWorkerDeviceContext",
            workerId: auth.workerId,
            operation: "quarantine_finalize",
          });
        });
    },
  };
}
