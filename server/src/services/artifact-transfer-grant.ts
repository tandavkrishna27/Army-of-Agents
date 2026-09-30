// server/src/services/artifact-transfer-grant.ts
//
// DAT-002 — the `artifact_transfer_grant` service. It mints a scoped, expiring,
// credential-scrubbed presigned URL so a worker uploads/downloads an artifact
// DIRECTLY to/from object storage — the bytes never traverse the control-plane API
// body path. The wire shapes are FROZEN (worker-protocol v1); this service issues
// them and self-validates with the frozen schema before sending.
//
// Fence posture (D4):
//   * UPLOAD  requires a LIVE fence — `lockActiveFence` runs the shared guard
//     (a stale/terminal/revoked fence → `rejected{stale_fence|attempt_terminal|
//     target_revoked}`), because writing new bytes for an attempt is a governed act.
//   * DOWNLOAD is tenant-scoped + object-existence, NOT fence-current — a committed
//     artifact must stay readable after lease loss. It proves a committed
//     `job_artifacts` row exists for the tenant (RLS-scoped) instead of guarding.
//
// Auth failures (proof/authority/target) throw `JobLeasingError` → the route maps
// them to an HTTP protocol error; only fence/existence refusals are a 200 `rejected`.

import type { Db } from "@armyofagents/db";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "./artifact-size-ceiling.js";
import { resolveGrantTtlSeconds } from "./artifact-grant-ttl.js";
import { JobFenceError as DbJobFenceError, type JobFenceErrorCode } from "@armyofagents/db";
import {
  artifactTransferGrantOperationRequestV1Schema,
  artifactTransferGrantOperationResponseV1Schema,
  artifactUploadGrantV1Schema,
  artifactDownloadGrantV1Schema,
  expectedAttemptObjectPrefix,
  type ArtifactTransferGrantOperationRequestV1,
  type ArtifactTransferGrantOperationResponseV1,
} from "@armyofagents/worker-protocol";
import { runInTenant } from "../db/tenant-context.js";
import { JobLeasingError, type VerifiedWorkerOperation } from "./job-leasing.js";
import { resolveWorkerFenceContext } from "./worker-fence-context.js";
import { recordSecurityDenial } from "./security-denial-audit.js";
import {
  type ArtifactDenialIntent,
  ARTIFACT_TRANSFER_GRANT_DENIAL_SURFACE,
} from "./artifact-denial-audit.js";
import {
  createWorkerDenialSink,
  drainWorkerDenial,
} from "./worker-denial-audit.js";
import {
  createObjectAccessSink,
  recordObjectAccessGrant,
} from "./artifact-object-access-audit.js";
import type { StorageProvider } from "../storage/types.js";

/** Map the guard's fence-error code onto the frozen protocol reason vocabulary. */
function fenceReason(code: JobFenceErrorCode): "stale_fence" | "attempt_terminal" | "target_revoked" {
  return code;
}

export function createArtifactTransferGrantService(input: {
  appDb: Db;
  storage: StorageProvider;
  grantTtlSeconds?: number;
  maxHeartbeatAgeMs?: number;
  maxArtifactBytes?: number;
}) {
  // Same ceiling the COMMIT path enforces, from the same constant. Enforcing it
  // here is what makes it a refusal instead of an orphan: the commit ceiling can
  // only fire once the bytes are already in the store.
  const maxArtifactBytes = Math.max(1, input.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES);
  // DAT-009 slice 2 §4.1 — CLAMPED, not merely floored. This was
  // `Math.max(30, input.grantTtlSeconds ?? 300)`: a floor, a default, and no ceiling, so
  // the frozen schema (whose only temporal assertion is `expiresAt > issuedAt`) would have
  // accepted a seven-day ordinary upload grant. The TTL is the ONLY revocation mechanism
  // here — the issued grant carries no fence material and no revocation concept exists —
  // so it is exactly the window in which a dead fence's PUT still lands.
  const grantTtlSeconds = resolveGrantTtlSeconds(input.grantTtlSeconds);
  const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300_000);

  return {
    async grant(grantInput: {
      auth: VerifiedWorkerOperation;
      request: ArtifactTransferGrantOperationRequestV1;
    }): Promise<ArtifactTransferGrantOperationResponseV1> {
      const parsed = artifactTransferGrantOperationRequestV1Schema.safeParse(grantInput.request);
      if (!parsed.success) throw new JobLeasingError("malformed");
      const request = parsed.data;
      const body = request.body;
      const auth = grantInput.auth;
      // The grant is bound to the authenticated worker.
      if (body.workerId !== auth.workerId) throw new JobLeasingError("unauthorized");

      // ★ DE-06 — the refusing branch's own account of itself. Set by `rejected`
      // and drained AFTER the tenant transaction closes (see
      // `artifact-denial-audit.ts` for why the write cannot happen inside it).
      // `rejected` is a local closure; its call sites are enumerable in this file
      // and every one of them supplies a `denial`, because the parameter is
      // REQUIRED — a new refusal branch that forgets to audit does not compile.
      // ★ THE COMPILER PROPERTY IS ABOUT `rejected`, NOT ABOUT REFUSALS. A
      // refusal that THROWS instead of returning never reaches this holder:
      // `resolveWorkerFenceContext` below throws `JobLeasingError` out of
      // `runInTenant`, and those refusals are NOT recorded (see
      // `artifact-denial-audit.ts` for why, and the pinned arms in
      // `de-06-artifact-denial-audit.integration.test.ts` for the measurement).
      // A one-field holder rather than a bare `let`: TypeScript narrows a `let`
      // from its initializer and cannot see the assignment inside `rejected`, so
      // a bare `let` reads back as `null` (and `if (…)` as `never`) at the drain
      // below. Property narrowing is reset by the intervening call, so this reads
      // back at its declared type.
      const denial: { intent: ArtifactDenialIntent | null } = { intent: null };

      const rejected = (
        reason: string,
        intent: ArtifactDenialIntent,
      ): ArtifactTransferGrantOperationResponseV1 => {
        denial.intent = intent;
        return artifactTransferGrantOperationResponseV1Schema.parse({
          protocolVersion: 1,
          correlationId: request.correlationId,
          serverTime: new Date().toISOString(),
          outcome: "rejected",
          reason,
        });
      };

      // ★ DE-06 — the THROWING refusal's holder (see `worker-denial-audit.ts`).
      // Filled by ALL SIX of `resolveWorkerFenceContext`'s throw sites: the
      // post-resolution tuple-integrity branch with an FK-valid company, the
      // other five with a token-attested organization and a null company, which
      // `E0-F013` Decision 2 (a2) made storable. This comment previously said the
      // other five wrote nothing — Decision 2's residue — and that residue is
      // gone; the stale sentence is corrected rather than left to mislead an audit.
      const fenceDenial = createWorkerDenialSink();

      // ★ DE-06 — the SUCCESS half of the same clause ("object put/get AND
      // rejected-key attempts are audited"). Filled by the two `*_granted`
      // returns below and drained on the pool handle after this transaction
      // closes. See `artifact-object-access-audit.ts` for why issuance is the
      // only observation point the control plane has, and for the hot-path bound.
      const access = createObjectAccessSink();

      const response = await runInTenant(input.appDb, auth.organizationId, async (repos) => {
        const ctx = await resolveWorkerFenceContext(repos, auth, {
          leaseId: body.leaseId,
          jobId: body.jobId,
          attempt: body.attempt,
          fenceToken: body.fenceToken,
        }, maxHeartbeatAgeMs, fenceDenial);

        const issuedAt = ctx.authorityNow;
        const expiresAt = new Date(issuedAt.getTime() + grantTtlSeconds * 1000);

        // DE-06 — the attribution every RETURNING refusal below shares (the
        // throwing ones never get here; see the header note). `ctx.companyId` is
        // the LOCKED LEASE's company, resolved from the database under this
        // worker's own organization GUC; it is never taken from the request.
        const deny = (
          reason: ArtifactDenialIntent["reason"],
          extra: Record<string, unknown> = {},
        ): ArtifactDenialIntent => ({
          reason,
          companyId: ctx.companyId,
          artifactId: body.artifactId,
          details: {
            operation: body.operation,
            organizationId: auth.organizationId,
            workerId: auth.workerId,
            targetId: auth.targetId,
            jobId: body.jobId,
            attempt: body.attempt,
            leaseId: body.leaseId,
            // The key the caller ASKED for. In the cross-tenant case this is the
            // whole evidence: it carries the foreign organization segment the
            // worker tried to reach, which the coarse wire `malformed` hides.
            requestedObjectKey: body.expectedObjectKey,
            ...extra,
          },
        });

        if (body.operation === "upload") {
          // A live fence is required to write new bytes for this attempt.
          try {
            await repos.jobControl.lockActiveFence(ctx.fenceIdentity);
          } catch (error) {
            if (error instanceof DbJobFenceError) {
              return rejected(fenceReason(error.code), deny(fenceReason(error.code)));
            }
            throw error;
          }
          // Bind the write key to THIS org's prefix. The frozen request schema binds
          // only job/attempt (artifacts.ts:383-391), never the org segment, so without
          // this check a live-fenced worker could mint a presigned PUT into a FOREIGN
          // org's object-key namespace (the download branch already guards this).
          const uploadPrefix = expectedAttemptObjectPrefix({
            organizationId: auth.organizationId,
            jobId: body.jobId,
            attempt: body.attempt,
          });
          if (!body.expectedObjectKey.startsWith(uploadPrefix)) {
            return rejected(
              "malformed",
              deny("foreign_object_prefix", { expectedObjectKeyPrefix: uploadPrefix }),
            );
          }
          // BRW-003d-5 — refuse a grant whose DECLARED size already exceeds the
          // server ceiling, BEFORE a byte moves.
          //
          // The frozen request bounds `maxBytes` only by Number.MAX_SAFE_INTEGER,
          // and a presigned PUT imposes no size bound at the store, so without this
          // the only ceiling was at commit — i.e. after the object was written.
          // That refusal leaves an orphan the sweeper has to find, and it spends
          // the egress to get there. `maxBytes` is used here purely as DECLARED
          // INTENT to refuse on, which is not the same as trusting it as an
          // enforced bound at the store (it is not one).
          if (body.maxBytes > maxArtifactBytes) {
            return rejected(
              "malformed",
              deny("declared_size_over_ceiling", {
                declaredMaxBytes: body.maxBytes,
                ceilingBytes: maxArtifactBytes,
              }),
            );
          }
          // Immutable-artifact guard (Rule #7 / Decisions #43/#45): never re-grant an
          // upload for an ALREADY-committed artifact — a re-PUT to the committed key
          // would silently overwrite immutable bytes a reader still trusts.
          //
          // BRW-003a: this asks "did this identity EVER commit?", so it must count
          // 'expired' too. Once BRW-003c deletes the bytes and tombstones the row, the
          // identity drops out of `job_artifacts_committed_identity_uidx` (partial, WHERE
          // status='committed') — and a `findCommitted` here would return null and hand
          // out a fresh upload grant for a key that was already committed once.
          const alreadyCommitted = await repos.jobArtifacts.findEverCommitted({
            jobId: body.jobId,
            attempt: body.attempt,
            identifier: body.artifactId,
          });
          if (alreadyCommitted) {
            return rejected("malformed", deny("artifact_identity_already_committed"));
          }
          if (!input.storage.presignPut) throw new Error("storage provider cannot presign uploads");
          const signed = await input.storage.presignPut({
            objectKey: body.expectedObjectKey,
            expiresInSeconds: grantTtlSeconds,
            maxBytes: body.maxBytes,
            checksumSha256: body.expectedSha256,
          });
          const grant = artifactUploadGrantV1Schema.parse({
            protocolVersion: 1,
            operation: "upload",
            artifactId: body.artifactId,
            method: "PUT",
            url: signed.url,
            headers: signed.headers,
            issuedAt: issuedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            maxBytes: body.maxBytes,
            expectedSha256: body.expectedSha256,
            objectKey: body.expectedObjectKey,
            redaction: "secret",
          });
          // DAT-009 slice 2 §4.2 — record the grant INTENT before returning it.
          //
          // ★ ORDER IS LOAD-BEARING. This runs INSIDE the same tenant transaction and
          // BEFORE the response, so a failure here rolls the whole mint back and no
          // grant is handed out. A grant returned but unrecorded is precisely the
          // undiscoverable orphan this closes: the storage port has no list operation,
          // so an object nobody recorded can never be found again.
          await repos.jobControl.recordArtifactGrantIntent({
            ...ctx.fenceIdentity,
            identifier: body.artifactId,
            objectKey: body.expectedObjectKey,
            expiresAt,
            expectedSha256: body.expectedSha256,
            maxBytes: body.maxBytes,
          });
          // ★ DE-06 put/get — the PUT was AUTHORIZED. Captured here, as the last
          // statement before the response is built, so nothing between the
          // capture and the return can turn this into a refusal; a throw after
          // it (the parse below, or a failed COMMIT) rejects `runInTenant` and
          // the drain never runs. `objectKey` is the key that was SIGNED, which
          // by this point has been proven to start with THIS org's prefix.
          access.intent = {
            operation: "upload",
            companyId: ctx.companyId,
            organizationId: auth.organizationId,
            workerId: auth.workerId,
            targetId: auth.targetId,
            artifactId: body.artifactId,
            objectKey: body.expectedObjectKey,
            // DE-11's access half: null on an UPLOAD because the artifact does
            // not exist yet and the frozen request carries neither field — they
            // are first declared in the COMMIT manifest. A true answer, not a
            // missing one. See `artifact-object-access-audit.ts`.
            kind: null,
            sensitivity: null,
            jobId: body.jobId,
            attempt: body.attempt,
            leaseId: body.leaseId,
            expiresAt,
            maxBytes: body.maxBytes,
          };
          return artifactTransferGrantOperationResponseV1Schema.parse({
            protocolVersion: 1,
            correlationId: request.correlationId,
            serverTime: issuedAt.toISOString(),
            outcome: "upload_granted",
            grant,
          });
        }

        // operation === "download": fence-independent, but tenant-scoped + object
        // must already be committed under this tenant.
        //
        // Defense-in-depth: the requested key must bind this org/job/attempt prefix
        // AND match the committed key (never grant a download of a foreign key).
        const prefix = expectedAttemptObjectPrefix({
          organizationId: auth.organizationId,
          jobId: body.jobId,
          attempt: body.attempt,
        });
        // ★ DE-06 — these three were ONE `if` with one shared `rejected("malformed")`.
        // They are split so the durable record can tell a cross-tenant key attempt
        // apart from an ordinary miss; the wire answer is the same coarse
        // `malformed` in all three, so nothing the caller can observe changed.
        //
        // The PREFIX test now runs FIRST. It is a pure string test on
        // caller-supplied input, so ordering it ahead of the tenant-scoped lookup
        // is free, skips a database read for a key that is not ours at all, and —
        // the reason it matters here — stops a foreign-prefix probe from being
        // recorded as `artifact_not_committed`, which is what the previous
        // short-circuit order would have called it (the lookup is tenant-scoped,
        // so a foreign key always misses first).
        if (!body.expectedObjectKey.startsWith(prefix)) {
          return rejected(
            "malformed",
            deny("foreign_object_prefix", { expectedObjectKeyPrefix: prefix }),
          );
        }
        const committed = await repos.jobArtifacts.findCommitted({
          jobId: body.jobId,
          attempt: body.attempt,
          identifier: body.artifactId,
        });
        if (!committed) return rejected("malformed", deny("artifact_not_committed"));
        if (committed.objectKey !== body.expectedObjectKey) {
          return rejected("malformed", deny("object_key_mismatch"));
        }
        if (!input.storage.presignGet) throw new Error("storage provider cannot presign downloads");
        const signed = await input.storage.presignGet({
          objectKey: body.expectedObjectKey,
          expiresInSeconds: grantTtlSeconds,
          maxBytes: body.maxBytes,
          checksumSha256: body.expectedSha256,
        });
        const grant = artifactDownloadGrantV1Schema.parse({
          protocolVersion: 1,
          operation: "download",
          artifactId: body.artifactId,
          method: "GET",
          url: signed.url,
          headers: signed.headers,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          maxBytes: body.maxBytes,
          expectedSha256: body.expectedSha256,
          objectKey: body.expectedObjectKey,
          redaction: "secret",
        });
        // ★ DE-06 put/get — THE DISCLOSURE-RELEVANT EVENT. This is the tree's
        // only production `presignGet` call site, so this row is the only record
        // that will ever exist of a worker being handed read access to an
        // object's bytes. `committed.objectKey === body.expectedObjectKey` was
        // enforced above, so the recorded key is the committed artifact's own.
        access.intent = {
          operation: "download",
          companyId: ctx.companyId,
          organizationId: auth.organizationId,
          workerId: auth.workerId,
          targetId: auth.targetId,
          artifactId: body.artifactId,
          objectKey: body.expectedObjectKey,
          // DE-11's access half. Free here: `committed` is the row this branch
          // already loaded to prove the key is this tenant's, so the record can
          // say WHICH KIND became reachable rather than only that something did.
          kind: committed.kind ?? null,
          sensitivity: committed.sensitivity ?? null,
          jobId: body.jobId,
          attempt: body.attempt,
          leaseId: body.leaseId,
          expiresAt,
          maxBytes: body.maxBytes,
        };
        return artifactTransferGrantOperationResponseV1Schema.parse({
          protocolVersion: 1,
          correlationId: request.correlationId,
          serverTime: issuedAt.toISOString(),
          outcome: "download_granted",
          grant,
        });
      })
        // ★ DE-06 — drain the THROWING refusal's record. `.finally` rather than a
        // trailing statement because a fence refusal REJECTS `runInTenant`, so the
        // returning-refusal drain below is never reached on that path; `.finally`
        // awaits a thenable callback, so the row is written before the caller sees
        // the `JobLeasingError`.
        .finally(async () => {
          await drainWorkerDenial(input.appDb, fenceDenial, {
            control: "server/src/services/worker-fence-context.ts:resolveWorkerFenceContext",
            workerId: auth.workerId,
            operation: "artifact_transfer_grant",
          });
        });

      // ★ DE-06 — the durable, attributable record of the refusal, written on the
      // POOL handle after the tenant transaction has closed and BEFORE the caller
      // sees the response. `recordSecurityDenial` never throws (a failed audit
      // must not turn a refusal into a 500, and must not become a DoS lever on
      // the refusal path), so this cannot alter the outcome above.
      const pending = denial.intent;
      if (pending) {
        await recordSecurityDenial(input.appDb, {
          companyId: pending.companyId,
          crossing: "DE-06",
          surface: ARTIFACT_TRANSFER_GRANT_DENIAL_SURFACE,
          reason: pending.reason,
          // A worker is a machine identity in the execution plane: it has no row
          // in `agents` and no row in `auth`, so neither the `agent` nor the
          // `user` actor kind is truthful. `actor_id` is plain text with no FK,
          // which is what makes `workerId` usable as the identity directly.
          actorType: "system",
          actorId: auth.workerId,
          entityType: "job_artifact",
          entityId: pending.artifactId,
          control: "server/src/services/artifact-transfer-grant.ts:grant",
          details: pending.details,
        });
      }

      // ★ DE-06 put/get — the durable, attributable record of the AUTHORIZED
      // object operation, written on the POOL handle after the tenant
      // transaction has closed (so it cannot borrow a second connection while
      // the first is still held) and BEFORE the caller sees the grant.
      // `recordObjectAccessGrant` never throws, so a failed audit cannot turn a
      // legitimate grant into a 500 and cannot be used to fail grants.
      //
      // ★ THERE IS DELIBERATELY NO `response.outcome` CHECK HERE. The intent is
      // set at the two `*_granted` returns and nowhere else, so its presence IS
      // the gate. A redundant second guard would make the "a refused grant
      // writes no access row" arm pass even with the capture moved above a
      // refusal branch — i.e. pass for the wrong reason.
      const granted = access.intent;
      if (granted) await recordObjectAccessGrant(input.appDb, granted);
      return response;
    },
  };
}
