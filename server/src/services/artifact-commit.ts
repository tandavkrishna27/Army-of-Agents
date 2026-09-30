// server/src/services/artifact-commit.ts
//
// DAT-002 — the `artifact_commit` service: the fenced, verified commit of an
// artifact manifest. It mirrors `createJobEventIngestService.ingest`'s one-tx,
// fence-first template. The FROZEN worker-protocol shapes are consumed, never
// extended; the committed response returns `{artifactId, versionNumber, committedAt}`.
//
// Ordering + precedence (D5, the hard invariant):
//   1. headObject(manifest.objectKey) on the control plane's INTERNAL endpoint →
//      the store-observed {ContentLength, ChecksumSHA256}. A missing/incomplete
//      object or a store that cannot supply a checksum fails closed BEFORE the tx.
//   2. ONE `runInTenant` tx: resolve the fence identity, then the guarded
//      `commitArtifactVersion` mutator runs `guardActiveFence` FIRST — so a stale
//      fence surfaces as `stale_fence` BEFORE any hash/size/prefix check — then
//      verifies prefix/tenant/size/sha and idempotently inserts the committed row.
//   3. `JobFenceError.code` → `rejected{stale_fence|attempt_terminal|target_revoked}`;
//      an `ArtifactCommitRejection` → `rejected` mapped onto the frozen closed
//      protocol vocabulary (`hash_mismatch` → `event_hash_mismatch`; wrong-prefix /
//      size / tenant → `malformed`, deliberately coarse + redaction-safe — the
//      frozen `protocolErrorCodeSchema` has no finer artifact-reject codes).
//
// Auth-layer failures (proof/authority/no-lease) throw `JobLeasingError` → the route
// maps them to an HTTP protocol error, exactly like the event-ingest path.

import type { Db } from "@armyofagents/db";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "./artifact-size-ceiling.js";
import {
  JobFenceError as DbJobFenceError,
  ArtifactCommitRejection,
  type ArtifactCommitRejectionReason,
  type JobFenceErrorCode,
} from "@armyofagents/db";
import {
  artifactCommitOperationRequestV1Schema,
  artifactCommitOperationResponseV1Schema,
  expectedAttemptObjectPrefix,
  type ArtifactCommitOperationRequestV1,
  type ArtifactCommitOperationResponseV1,
} from "@armyofagents/worker-protocol";
import { runInTenant } from "../db/tenant-context.js";
import { logger } from "../middleware/logger.js";
import { resolveStoredRetention } from "./artifact-retention-authority.js";
import type { SweepTrigger } from "./artifact-sweep-trigger.js";
import { JobLeasingError, type VerifiedWorkerOperation } from "./job-leasing.js";
import { resolveWorkerFenceContext } from "./worker-fence-context.js";
import { recordSecurityDenial } from "./security-denial-audit.js";
import {
  createRetentionAuditSink,
  recordRetentionDecision,
} from "./artifact-retention-audit.js";
import {
  type ArtifactDenialIntent,
  type ArtifactDenialReason,
  ARTIFACT_COMMIT_DENIAL_SURFACE,
} from "./artifact-denial-audit.js";
import {
  createWorkerDenialSink,
  drainWorkerDenial,
} from "./worker-denial-audit.js";
import type { StorageProvider } from "../storage/types.js";
import type { JobControlMetrics } from "./job-control-metrics.js";

/** A guarded-fence refusal → the frozen protocol reason vocabulary. */
function fenceReason(code: JobFenceErrorCode): "stale_fence" | "attempt_terminal" | "target_revoked" {
  return code;
}

/** An artifact-verification refusal → the frozen closed protocol reason vocabulary.
 * `hash_mismatch` maps to `event_hash_mismatch` (the only content-hash code); the
 * rest are coarse `malformed` (which is also redaction-safe — a tenant mismatch must
 * not disclose a foreign resource). */
function verificationReason(reason: ArtifactCommitRejectionReason): "event_hash_mismatch" | "malformed" {
  return reason === "hash_mismatch" ? "event_hash_mismatch" : "malformed";
}

/** DE-06 — the same verification refusal, as the DURABLE reason code. Total over
 * `ArtifactCommitRejectionReason`, so a new mutator rejection reason fails to
 * compile here rather than silently collapsing into an existing audit code. */
function commitDenialReason(reason: ArtifactCommitRejectionReason): ArtifactDenialReason {
  switch (reason) {
    case "wrong_prefix":
      return "foreign_object_prefix";
    case "tenant_mismatch":
      return "manifest_tenant_mismatch";
    case "size_mismatch":
      return "declared_size_mismatch";
    case "hash_mismatch":
      return "declared_hash_mismatch";
  }
}

export function createArtifactCommitService(input: {
  appDb: Db;
  storage: StorageProvider;
  maxHeartbeatAgeMs?: number;
  /** Server-authoritative absolute per-object ceiling (the grant's maxBytes is
   * advisory + unpersisted, and a presigned PUT imposes no size bound). */
  maxArtifactBytes?: number;
  /** DEP-007 — count-only, id-free artifact-commit telemetry. Defaults to the no-op
   * surface; the composition root threads the shared pino instance when distributed
   * execution is enabled. Emission is best-effort and never alters the commit path. */
  metrics?: JobControlMetrics;
  /** DAT-011 — the orphan-sweep trigger. Same shape and same contract as `metrics`
   * above: defaults to a NO-OP, is best-effort, and NEVER alters the commit path. A
   * commit event is the only moment an orphan sweep can run inside the right tenant
   * context without enumerating organizations, which the tenant boundary forbids. */
  sweepTrigger?: SweepTrigger;
}) {
  // No-op default, so a composition root that has not wired the sweep changes nothing.
  const sweepTrigger: SweepTrigger = input.sweepTrigger ?? { trigger() {}, async triggerAndWait() {} };
  const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300_000);
  const maxArtifactBytes = Math.max(1, input.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES);
  // Optional-chained (no NOOP VALUE import) so this module carries no runtime
  // dependency on job-control-metrics unless a live instance is passed (dormancy gate).
  const metrics = input.metrics;

  return {
    async commit(commitInput: {
      auth: VerifiedWorkerOperation;
      request: ArtifactCommitOperationRequestV1;
    }): Promise<ArtifactCommitOperationResponseV1> {
      const parsed = artifactCommitOperationRequestV1Schema.safeParse(commitInput.request);
      if (!parsed.success) throw new JobLeasingError("malformed");
      const request = parsed.data;
      const payload = request.body;
      const manifest = payload.manifest;
      const auth = commitInput.auth;
      if (payload.workerId !== auth.workerId) throw new JobLeasingError("unauthorized");

      // ★ DE-06 — see artifact-denial-audit.ts. Set by the refusing branch, drained
      // after the tenant transaction closes. The `intent` parameter is REQUIRED, so
      // a future refusal branch that forgets to audit does not compile.
      // ★ That compiler property is about `rejected`, NOT about refusals in
      // general: `resolveWorkerFenceContext` below THROWS out of `runInTenant`,
      // so its refusals never pass through `rejected` and are carried by the
      // SEPARATE sink declared just below (worker-denial-audit.ts).
      // A one-field holder rather than a bare `let`: TypeScript narrows a `let`
      // from its initializer and cannot see the assignment inside `rejected`, so
      // a bare `let` reads back as `null` (and `if (…)` as `never`) at the drain
      // below. Property narrowing is reset by the intervening call, so this reads
      // back at its declared type.
      const denial: { intent: ArtifactDenialIntent | null } = { intent: null };

      // ★ DE-06 — the THROWING refusal's own holder, separate from `denial`
      // because it is filled inside `resolveWorkerFenceContext` and drained even
      // when `runInTenant` rejects. ALL SIX of that function's throw sites now
      // fill it (worker-denial-audit.ts): the tuple-integrity branch with an
      // FK-valid company, the other five with a token-attested organization and
      // a null company, which `E0-F013` Decision 2 (a2) made storable. This
      // comment previously said the other five wrote nothing; that is no longer
      // true and is corrected rather than left to mislead an audit.
      const fenceDenial = createWorkerDenialSink();

      // ★ DE-11 — the RETENTION half of "sensitive-artifact access and retention
      // are audited". Filled at the retention decision below, INSIDE the tenant
      // transaction, and drained after it closes on the pool handle — the same
      // shape and the same reason as `denial` above. A retention record written
      // inside this transaction is rolled back by any later refusal branch, so
      // the one refusal that matters most (a worker whose declaration was
      // overridden AND whose commit then failed verification) would erase its
      // own record.
      const retention = createRetentionAuditSink();

      const rejected = (
        reason: string,
        intent: ArtifactDenialIntent,
      ): ArtifactCommitOperationResponseV1 => {
        denial.intent = intent;
        return artifactCommitOperationResponseV1Schema.parse({
          protocolVersion: 1,
          correlationId: request.correlationId,
          serverTime: new Date().toISOString(),
          outcome: "rejected",
          reason,
        });
      };

      const response = await runInTenant(input.appDb, auth.organizationId, async (repos) => {
        // ★ DAT-011 FIX (found by the live D1 lane, E6F-14). A stale fence is refused HERE,
        // not by `commitArtifactVersion` below: `resolveWorkerFenceContext` looks the lease
        // up BY THE PRESENTED FENCE TOKEN (`lockLeaseAckContext`), so a superseded fence
        // finds no row and throws `JobLeasingError("stale_fence")` — which never reaches the
        // catch further down where the sweep trigger originally sat.
        //
        // The result was that the sweep NEVER fired on a stale-fence refusal: the exact
        // event it was designed around, and the exact moment an orphan is created. Grep
        // verified the trigger had a caller; it could not tell me the caller was
        // unreachable on this path. Only running it could.
        let ctx;
        try {
          ctx = await resolveWorkerFenceContext(repos, auth, {
            leaseId: payload.leaseId,
            jobId: payload.jobId,
            attempt: payload.attempt,
            fenceToken: payload.fenceToken,
          }, maxHeartbeatAgeMs, fenceDenial);
        } catch (error) {
          if (error instanceof JobLeasingError && error.code === "stale_fence") {
            sweepTrigger.trigger(auth.organizationId);
          }
          throw error;
        }

        // DE-06 — the attribution every RETURNING refusal below shares (the
        // throwing ones above never get here). `ctx.companyId` is
        // the LOCKED LEASE's company, never the manifest's self-asserted one.
        const deny = (
          reason: ArtifactDenialIntent["reason"],
          extra: Record<string, unknown> = {},
        ): ArtifactDenialIntent => ({
          reason,
          companyId: ctx.companyId,
          artifactId: manifest.artifactId,
          details: {
            operation: "commit",
            organizationId: auth.organizationId,
            workerId: auth.workerId,
            targetId: auth.targetId,
            jobId: payload.jobId,
            attempt: payload.attempt,
            leaseId: payload.leaseId,
            // The key the manifest CLAIMED, plus the org/company it claimed to be
            // committing for. On a `manifest_tenant_mismatch` these are the whole
            // evidence, and the coarse wire `malformed` carries none of it.
            requestedObjectKey: manifest.objectKey,
            declaredOrganizationId: String(manifest.organizationId),
            declaredCompanyId: String(manifest.companyId),
            ...extra,
          },
        });

        // Object existence + store-observed integrity, run ONLY AFTER the fence
        // IDENTITY is resolved (an unresolvable/foreign fence throws above, before the
        // store is ever touched) — so a caller cannot use object existence/metadata as
        // a cross-tenant oracle. A never-uploaded (incomplete) object, or a store that
        // cannot supply a SHA256 checksum, fails closed — an unverifiable hash must
        // never commit.
        const head = await input.storage.headObject({ objectKey: manifest.objectKey });
        if (!head.exists) return rejected("malformed", deny("object_missing")); // upload_incomplete
        if (typeof head.contentLength !== "number" || !head.checksumSha256) {
          // integrity unverifiable → fail closed
          return rejected("event_hash_mismatch", deny("object_integrity_unverifiable"));
        }
        const actualSizeBytes = head.contentLength;
        const actualSha256 = head.checksumSha256;
        // Server-authoritative absolute size ceiling (the grant's maxBytes is not
        // persisted and a presigned PUT imposes no size bound at the store).
        if (actualSizeBytes > maxArtifactBytes) {
          return rejected(
            "malformed",
            deny("object_size_over_ceiling", {
              actualSizeBytes,
              ceilingBytes: maxArtifactBytes,
            }),
          );
        }

        // Tenant + prefix validity are evaluated with the AUTH org + the LOCKED
        // lease's company (never the manifest's self-asserted org/company) and
        // re-checked inside the mutator AFTER the guard, preserving fence-first.
        const tenantValid =
          String(manifest.organizationId) === String(auth.organizationId)
          && String(manifest.companyId) === String(ctx.companyId);
        const prefix = expectedAttemptObjectPrefix({
          organizationId: auth.organizationId,
          jobId: payload.jobId,
          attempt: payload.attempt,
        });
        const prefixValid = manifest.objectKey.startsWith(prefix);

        // Decided BEFORE the mutator call so the stored value is never the declared one.
        const retentionDecision = resolveStoredRetention({
          kind: manifest.kind,
          declared: manifest.retention,
        });
        if (retentionDecision.declarationIgnored) {
          // ★ DE-11 — THIS IS NOW AN AUDIT RECORD AND NOT ONLY A LOG LINE. The
          // comment that stood here said: "This is a LOG LINE, not an audit record
          // — DE-11 claims retention is audited and nothing audits it; this ticket
          // does not pretend to close that." That deferral is discharged: the
          // intent captured here is drained into `activity_log` after this
          // transaction closes (`artifact-retention-audit.ts`).
          //
          // ★ WHAT THAT DOES *NOT* DO, kept next to the code so it cannot drift
          // into a closure claim: DE-11's clause is a CONJUNCTION — access AND
          // retention — and its ACCESS half is DE-06's still-open successful
          // put/get obligation. And nothing in production uploads
          // browser_cookie_state / browser_storage_state today (BRW-003 unbuilt),
          // so this record is live but has never once been about a
          // credential-bearing kind. DE-11 STAYS `partial`.
          //
          // The `logger.warn` is KEPT rather than replaced: it is the operational
          // signal on the hot path, it survives a database that is refusing
          // writes, and the durable row is a different consumer's answer.
          retention.intent = {
            // The LOCKED LEASE's company, never the manifest's self-asserted one —
            // the same value `deny` above attributes with, and for the same reason.
            companyId: ctx.companyId,
            organizationId: auth.organizationId,
            workerId: auth.workerId,
            artifactId: manifest.artifactId,
            kind: manifest.kind,
            declaredRetention: manifest.retention,
            storedRetention: retentionDecision.retention,
            jobId: payload.jobId,
            attempt: payload.attempt,
            leaseId: payload.leaseId,
          };
          logger.warn(
            {
              artifactId: manifest.artifactId,
              kind: manifest.kind,
              declaredRetention: manifest.retention,
              storedRetention: retentionDecision.retention,
            },
            "artifact retention declaration ignored — retention is control-plane-owned",
          );
        }

        let row;
        try {
          row = await repos.jobControl.commitArtifactVersion({
            ...ctx.fenceIdentity,
            identifier: manifest.artifactId,
            objectKey: manifest.objectKey,
            contentType: manifest.contentType,
            kind: manifest.kind,
            // `sensitivity` stays as declared DELIBERATELY: artifactSensitivitySchema is a
            // single-valued literal, so the frozen schema already makes it unforgeable and
            // deriving it here would compute a constant. If it ever gains a second value it
            // must move to the control plane that day (DAT-010 §4).
            sensitivity: manifest.sensitivity,
            // ★ DAT-010 — retention is CONTROL-PLANE-OWNED, derived from the frozen `kind`,
            // and the manifest's declaration is IGNORED. A worker choosing the retention of
            // a browser_cookie_state / browser_storage_state artifact is a privilege the
            // threat model must not grant: those bytes ARE a live session credential.
            retention: retentionDecision.retention,
            declaredSizeBytes: manifest.sizeBytes,
            declaredSha256: manifest.sha256,
            actualSizeBytes,
            actualSha256,
            prefixValid,
            tenantValid,
          });
        } catch (error) {
          if (error instanceof DbJobFenceError) {
            // ★ DAT-011 — a `stale_fence` refusal is the exact moment an orphan exists: the
            // bytes landed (commit was attempted, so the PUT completed) and the fence that
            // authorised them is gone. Fire-and-forget; it cannot affect this response.
            //
            // It does NOT collect THIS object: the grant stays redeemable until `expiresAt`,
            // so a retry could still re-PUT to the same key. `isSweepEligible` remains the
            // single authority and is unchanged. This sweeps what has ALREADY expired.
            sweepTrigger.trigger(auth.organizationId);
            return rejected(fenceReason(error.code), deny(fenceReason(error.code)));
          }
          if (error instanceof ArtifactCommitRejection) {
            // ★ DE-06 — `verificationReason` collapses wrong_prefix / tenant_mismatch /
            // size_mismatch onto the same coarse wire `malformed` (redaction-safe: a
            // tenant mismatch must not disclose a foreign resource). The durable
            // record keeps them apart, which is the whole clause.
            return rejected(
              verificationReason(error.reason),
              deny(commitDenialReason(error.reason), { verificationBranch: error.reason }),
            );
          }
          throw error;
        }

        // ★ DE-11 — AN IDEMPOTENT REPLAY DECIDED NOTHING, SO IT AUDITS NOTHING
        // (Codex P2 on PR #409, verified at source). `commitArtifactVersion`
        // answers a committed row in TWO cases: it INSERTED it (the
        // `replayed: false` return in `commitArtifactVersion`), or the artifact
        // was ALREADY committed and it returned the existing row unchanged (the
        // `replayed: true` return). Both answer the worker
        // `outcome: "committed"`, and the row alone cannot tell them apart — which
        // is why the mutator now reports `replayed` rather than leaving the caller
        // to guess.
        //
        // On the replay THIS CALL WROTE NOTHING. The stored retention was decided
        // by the earlier transaction under whatever manifest THAT one carried, so
        // recording here would (a) duplicate the record on every ordinary
        // transport retry and (b) — the serious half — let a replay declaring a
        // DIFFERENT retention mint a row asserting a declared/stored pair that was
        // never decided for the persisted artifact. Dropping the intent is
        // deliberate: the `logger.warn` above still fires, because a worker
        // re-declaring a class the control plane does not honour is still worth
        // seeing operationally; it is just not a NEW retention decision.
        if (row.replayed) retention.intent = null;

        // ★ DAT-011 — also on SUCCESS, deliberately. Success is the common event, so it
        // gives far more collection opportunities than refusals alone, and the sweep is a
        // no-op when nothing has expired. This is what keeps the residual to "the org's last
        // orphan" rather than "every orphan after the last refusal".
        sweepTrigger.trigger(auth.organizationId);
        return artifactCommitOperationResponseV1Schema.parse({
          protocolVersion: 1,
          correlationId: request.correlationId,
          serverTime: ctx.authorityNow.toISOString(),
          outcome: "committed",
          artifactId: row.identifier,
          versionNumber: row.versionNumber!,
          committedAt: (row.committedAt ?? new Date()).toISOString(),
        });
      })
        // ★ DE-06 — drain the THROWING refusal's record. `.finally` rather than a
        // trailing statement because `runInTenant` REJECTS on a fence refusal, so
        // the code below never runs on that path; and `.finally` awaits a
        // thenable callback, so the row is written before the caller sees the
        // `JobLeasingError`. `drainWorkerDenial` is a no-op when nothing was
        // recorded and `recordSecurityDenial` never throws, so this cannot alter
        // the outcome or convert a refusal into a 500.
        .finally(async () => {
          await drainWorkerDenial(input.appDb, fenceDenial, {
            control: "server/src/services/worker-fence-context.ts:resolveWorkerFenceContext",
            workerId: auth.workerId,
            operation: "artifact_commit",
          });
        });

      // DEP-007 — count-only artifact-commit telemetry (committed | rejected), emitted
      // AFTER the authoritative response is resolved so it can never alter the commit
      // path. Best-effort: a failing metric surface is swallowed.
      try {
        metrics?.artifactOp({
          operation: "commit",
          outcome: response.outcome === "committed" ? "committed" : "rejected",
          count: 1,
        });
      } catch {
        /* best-effort telemetry */
      }

      // ★ DE-06 — the ATTRIBUTABLE half of the record the metric above cannot be.
      // The metric ticks `{operation, outcome, count}` and is compile-closed
      // against ids by deliberate design, so it answers "how many" and never
      // "whose", "which tenant", "which key" or "why". This writes the row that
      // does, on the POOL handle after the tenant transaction has closed and
      // before the caller sees the response. `recordSecurityDenial` never throws.
      const pending = denial.intent;
      if (pending) {
        await recordSecurityDenial(input.appDb, {
          companyId: pending.companyId,
          crossing: "DE-06",
          surface: ARTIFACT_COMMIT_DENIAL_SURFACE,
          reason: pending.reason,
          // A worker has no `agents` row and no `auth` row; `actor_id` is plain
          // text with no FK, which is what makes `workerId` usable directly.
          actorType: "system",
          actorId: auth.workerId,
          entityType: "job_artifact",
          entityId: pending.artifactId,
          control: "server/src/services/artifact-commit.ts:commit",
          details: pending.details,
        });
      }

      // ★ DE-11 — drain the retention decision, on the POOL handle after the
      // tenant transaction has closed, for the transaction-discipline reason
      // stated on `retention` above and in `artifact-retention-audit.ts`.
      //
      // ★ GATED ON `committed`, DELIBERATELY. `resolveStoredRetention` runs
      // BEFORE the mutator and three refusal branches sit after it, so an intent
      // can survive a commit that was then REFUSED. Nothing was stored on that
      // path: recording it would assert a stored retention that does not exist,
      // and would let a worker flood the audit with manifests it never intended
      // to commit. `recordRetentionDecision` never throws.
      //
      // ★ AND AN IDEMPOTENT REPLAY RECORDS NOTHING EITHER (Codex P2 on PR #409,
      // verified at source). `commitArtifactVersion` answers `committed` in TWO
      // cases: it inserted the row, or the artifact was already committed and it
      // returned the existing row unchanged — `commitArtifactVersion`'s
      // `replayed: false` vs `replayed: true` returns.
      // On the replay this call WROTE NOTHING — the stored retention was decided
      // by the earlier transaction, under whatever manifest THAT one carried. So
      // an outcome check alone would duplicate the record on every ordinary
      // transport retry, and a replay declaring a DIFFERENT retention would mint a
      // row asserting a declared/stored pair that was never decided for the
      // persisted artifact. `replayed` is the mutator's own answer; the caller
      // cannot infer it from the row.
      if (retention.intent && response.outcome === "committed") {
        await recordRetentionDecision(input.appDb, retention.intent);
      }
      return response;
    },
  };
}
