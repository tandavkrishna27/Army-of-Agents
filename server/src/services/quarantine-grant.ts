// server/src/services/quarantine-grant.ts
//
// DAT-006 — the `quarantine_grant` service. It mints a scoped, expiring,
// credential-scrubbed presigned URL so a worker uploads a DEAD-FENCE orphan artifact
// DIRECTLY to object storage under the DISTINCT `quarantine/` prefix — the bytes never
// traverse the control-plane API body path. The wire shapes are FROZEN (worker-protocol
// v1); this service issues them and self-validates with the frozen schema before sending.
//
// It mirrors `artifact-transfer-grant.ts` with three deliberate differences (design §4.2):
//   * DEVICE-auth only, NO live-fence requirement — an orphan is precisely a dead-fence
//     output, so there is no lease/fence to guard. `resolveWorkerDeviceContext` proves the
//     device authority is CURRENT (proof replay + generation cutoff) WITHOUT a lease.
//   * The presigned key is bound to the `quarantine/` prefix (`expectedQuarantineObjectPrefix`),
//     never the ordinary attempt prefix.
//   * The grant expiry is capped at the frozen ≤5-minute ceiling (`QUARANTINE_MAX_TTL_MS`).
//
// Auth failures (proof/authority/target) throw `JobLeasingError` → the route maps them to
// an HTTP protocol error (`unauthorized`/`target_revoked` — NEVER `stale_fence`, which is
// not even in the frozen quarantine_grant error set). A bad prefix is a coarse,
// non-disclosing `rejected{malformed}`.

import type { Db } from "@armyofagents/db";
import {
  quarantineGrantOperationRequestV1Schema,
  quarantineGrantOperationResponseV1Schema,
  quarantineUploadGrantV1Schema,
  expectedQuarantineObjectPrefix,
  type QuarantineGrantOperationRequestV1,
  type QuarantineGrantOperationResponseV1,
} from "@armyofagents/worker-protocol";
import { runInTenant } from "../db/tenant-context.js";
import { JobLeasingError, type VerifiedWorkerOperation } from "./job-leasing.js";
import { resolveWorkerDeviceContext } from "./worker-fence-context.js";
import {
  createWorkerDenialSink,
  drainWorkerDenial,
} from "./worker-denial-audit.js";
import type { StorageProvider } from "../storage/types.js";

/** Five minutes, in seconds — the frozen quarantine upload-grant expiry ceiling. */
const QUARANTINE_MAX_TTL_SECONDS = 5 * 60;

export function createQuarantineGrantService(input: {
  appDb: Db;
  storage: StorageProvider;
  grantTtlSeconds?: number;
  maxHeartbeatAgeMs?: number;
}) {
  // Never exceed the frozen ≤5-minute ceiling (the frozen grant schema rejects a longer
  // expiry, so this both self-documents and keeps `.parse()` from throwing).
  const grantTtlSeconds = Math.min(
    QUARANTINE_MAX_TTL_SECONDS,
    Math.max(30, input.grantTtlSeconds ?? 300),
  );
  const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300_000);

  return {
    async grant(grantInput: {
      auth: VerifiedWorkerOperation;
      request: QuarantineGrantOperationRequestV1;
    }): Promise<QuarantineGrantOperationResponseV1> {
      const parsed = quarantineGrantOperationRequestV1Schema.safeParse(grantInput.request);
      if (!parsed.success) throw new JobLeasingError("malformed");
      const request = parsed.data;
      const body = request.body;
      const auth = grantInput.auth;
      // The grant is bound to the authenticated worker + its authenticated org/target.
      if (body.workerId !== auth.workerId) throw new JobLeasingError("unauthorized");
      if (String(body.organizationId) !== String(auth.organizationId)) throw new JobLeasingError("unauthorized");
      if (String(body.targetId) !== String(auth.targetId)) throw new JobLeasingError("unauthorized");

      const rejected = (reason: string): QuarantineGrantOperationResponseV1 =>
        quarantineGrantOperationResponseV1Schema.parse({
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

        // Bind the write key to THIS org's DISTINCT quarantine prefix. The frozen request
        // schema binds the prefix to (org, job, attempt), but re-checking against the
        // AUTHENTICATED org (never the payload's) closes any presign into a foreign org
        // namespace — the same defense the ordinary upload branch applies.
        const prefix = expectedQuarantineObjectPrefix({
          organizationId: auth.organizationId,
          jobId: body.jobId,
          attempt: body.attempt,
        });
        if (!body.expectedObjectKey.startsWith(prefix)) return rejected("malformed");
        if (!input.storage.presignPut) throw new Error("storage provider cannot presign uploads");

        const issuedAt = ctx.authorityNow;
        const expiresAt = new Date(issuedAt.getTime() + grantTtlSeconds * 1000);
        // The orphan's exact expected size is its own byte ceiling.
        const maxBytes = body.sizeBytes;
        const signed = await input.storage.presignPut({
          objectKey: body.expectedObjectKey,
          expiresInSeconds: grantTtlSeconds,
          maxBytes,
          checksumSha256: body.expectedSha256,
        });
        const grant = quarantineUploadGrantV1Schema.parse({
          protocolVersion: 1,
          operation: "quarantine_upload",
          artifactId: body.artifactId,
          method: "PUT",
          url: signed.url,
          headers: signed.headers,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          maxBytes,
          expectedSha256: body.expectedSha256,
          quarantineObjectKey: body.expectedObjectKey,
          redaction: "secret",
        });
        return quarantineGrantOperationResponseV1Schema.parse({
          protocolVersion: 1,
          correlationId: request.correlationId,
          serverTime: issuedAt.toISOString(),
          outcome: "quarantine_upload_granted",
          grant,
        });
      })
        // ★ DE-03 — drain the THROWING replay refusal on the POOL handle after the
        // tenant transaction has closed. `.finally` awaits a thenable callback, so the
        // row is written before the caller sees the `JobLeasingError`;
        // `recordSecurityDenial` never throws, so this cannot alter the outcome.
        .finally(async () => {
          await drainWorkerDenial(input.appDb, proofDenial, {
            control: "server/src/services/worker-fence-context.ts:resolveWorkerDeviceContext",
            workerId: auth.workerId,
            operation: "quarantine_grant",
          });
        });
    },
  };
}
