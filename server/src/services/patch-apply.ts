// server/src/services/patch-apply.ts
//
// DAT-003 — the explicit apply/review service for a committed `workspace_patch`.
// It rides the FROZEN DAT-002 commit path (no new wire op — the frozen protocol
// deliberately has NO apply/promote op) and mirrors `artifact-commit.ts`'s one-tx,
// fence-first template.
//
// Ordering + precedence (the hard invariant, mirroring DAT-002 finding A):
//   1. ONE `runInTenant` tx: `resolveWorkerFenceContext` resolves the fence IDENTITY
//      first — a foreign/unresolvable fence throws `JobLeasingError` BEFORE the object
//      store is ever touched, so object existence/metadata is never a cross-tenant
//      oracle.
//   2. The presented `objectKey` is prefix-bound to the AUTH org + this job/attempt
//      (never trusted blind); only then is the committed patch object fetched +
//      parsed with the frozen `workspacePatchManifestV1Schema` to recover its
//      declared base→result manifest digests (fail-closed on any parse/identity drift).
//   3. The guarded `recordPatchApplyState` mutator runs `guardActiveFence` FIRST — so
//      a stale/terminal/revoked fence surfaces as `stale_fence`/`attempt_terminal`/
//      `target_revoked` BEFORE the apply decision — then revalidates the patch's
//      declared base against the job's currently-accepted base: a MATCH applies (the
//      accepted base advances to `resultManifestHash`); a MISMATCH is
//      `conflict_quarantined` and NEVER auto-applies. Idempotent: re-applying an
//      already-applied patch is a no-op returning `applied`.
//
// A base mismatch is NOT a wire rejection — it is an `outcome:'conflict_quarantined'`
// disposition, surfaced for review. Fence refusals map to the frozen closed protocol
// fence vocabulary; every other refusal is coarse, non-disclosing `malformed`.

import type { Db } from "@armyofagents/db";
import {
  JobFenceError as DbJobFenceError,
  PatchApplyRejection,
  type JobFenceErrorCode,
} from "@armyofagents/db";
import {
  expectedAttemptObjectPrefix,
  workspacePatchManifestV1Schema,
} from "@armyofagents/worker-protocol";
import type { Readable } from "node:stream";
import { runInTenant } from "../db/tenant-context.js";
import { JobLeasingError, type VerifiedWorkerOperation } from "./job-leasing.js";
import { resolveWorkerFenceContext } from "./worker-fence-context.js";
import {
  createWorkerDenialSink,
  drainWorkerDenial,
} from "./worker-denial-audit.js";
import {
  captureFenceGuardDenial,
  createFenceGuardDenialSink,
  drainFenceGuardDenialSink,
} from "./fence-denial-audit.js";
import type { StorageProvider } from "../storage/types.js";

/** A guarded-fence refusal → the frozen protocol reason vocabulary. */
function fenceReason(code: JobFenceErrorCode): "stale_fence" | "attempt_terminal" | "target_revoked" {
  return code;
}

/** The apply/review request. Not a frozen wire op (the frozen protocol forbids an
 * apply/promote op); the caller presents the same complete active fence as a commit
 * plus the committed patch's identity + object key. */
export interface PatchApplyRequestV1 {
  workerId: string;
  jobId: string;
  attempt: number;
  leaseId: string;
  fenceToken: string;
  /** The committed `workspace_patch` artifact id to apply. */
  artifactId: string;
  /** The committed patch's object key (bound to the committed row inside the mutator). */
  objectKey: string;
}

export type PatchApplyResultV1 =
  | { outcome: "applied"; artifactId: string; baseManifestHash: string; resultManifestHash: string; alreadyApplied: boolean }
  | { outcome: "conflict_quarantined"; artifactId: string; expectedBaseManifestHash: string; currentBaseManifestHash: string | null }
  | { outcome: "rejected"; reason: "stale_fence" | "attempt_terminal" | "target_revoked" | "malformed" };

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export function createPatchApplyService(input: {
  appDb: Db;
  storage: StorageProvider;
  maxHeartbeatAgeMs?: number;
}) {
  const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300_000);

  return {
    async apply(applyInput: {
      auth: VerifiedWorkerOperation;
      request: PatchApplyRequestV1;
    }): Promise<PatchApplyResultV1> {
      const request = applyInput.request;
      const auth = applyInput.auth;
      if (request.workerId !== auth.workerId) throw new JobLeasingError("unauthorized");

      const rejected = (reason: "stale_fence" | "attempt_terminal" | "target_revoked" | "malformed"): PatchApplyResultV1 =>
        ({ outcome: "rejected", reason });

      // ★ DE-06 — THE FIRST DENIAL RECORD ON THIS SERVICE. Before this, patch-apply
      // recorded NOTHING on any refusal: `rejected()` builds a wire object and the
      // fence throws left no trace at all. This holder now covers ALL SIX throw
      // sites inside `resolveWorkerFenceContext` — the tuple-integrity branch with
      // an FK-valid company, the other five with a token-attested organization and
      // a null company (`worker-denial-audit.ts`; `E0-F013` Decision 2 (a2) made
      // the latter storable). An earlier version of this comment said the other
      // five were still unaudited; that is no longer true.
      // STILL UNAUDITED, and NOT covered by this holder: the `rejected("malformed")`
      // returns below (this service's own shape/binding refusals, with no closed
      // machine-reason vocabulary to key a row to). The GOVERNED-FENCE refusal is no
      // longer among them — the sink under this one records it.
      const fenceDenial = createWorkerDenialSink();
      // ★ DE-04 / DE-18 — the guardActiveFence refusal inside recordPatchApplyState,
      // captured at the inner catch (the refusal is converted to a wire `rejected`
      // outcome there, so the transaction COMMITS and an outer catch never sees it)
      // and drained on the pool handle in the `.finally` below.
      // `resolveWorkerFenceContext` deliberately does NOT gate on the fence being
      // ACTIVE, so this refusal genuinely fires in production — an expired lease
      // applying late is a `stale_fence` HERE, not at the pre-check.
      const fenceGuardDenial = createFenceGuardDenialSink();

      // The callback's return type is annotated because the `.finally` below breaks
      // the contextual-type flow from `apply`'s own signature, and without it the
      // literal `outcome` fields widen to `string`.
      return runInTenant(input.appDb, auth.organizationId, async (repos): Promise<PatchApplyResultV1> => {
        // Resolve the fence IDENTITY first (throws for a foreign/unresolvable fence),
        // BEFORE any object-store probe — no cross-tenant existence oracle.
        const ctx = await resolveWorkerFenceContext(repos, auth, {
          leaseId: request.leaseId,
          jobId: request.jobId,
          attempt: request.attempt,
          fenceToken: request.fenceToken,
        }, maxHeartbeatAgeMs, fenceDenial);

        // The presented object key MUST bind the auth org + this job/attempt. This
        // gate precedes any storage read, so a caller cannot point the fetch at a
        // foreign namespace.
        const prefix = expectedAttemptObjectPrefix({
          organizationId: auth.organizationId,
          jobId: request.jobId,
          attempt: request.attempt,
        });
        if (!request.objectKey.startsWith(prefix)) return rejected("malformed");

        // Fetch + parse the committed patch object → its declared base/result digests.
        // The object is content-addressed + immutable (committed), and the mutator
        // re-binds objectKey to the committed row, so the parsed digests are trusted.
        let parsed;
        try {
          const object = await input.storage.getObject({ objectKey: request.objectKey });
          const bytes = await streamToBuffer(object.stream);
          const candidate: unknown = JSON.parse(bytes.toString("utf8"));
          const result = workspacePatchManifestV1Schema.safeParse(candidate);
          if (!result.success) return rejected("malformed");
          parsed = result.data;
        } catch {
          return rejected("malformed");
        }

        // Defense in depth: the parsed manifest must self-identify with this fence's
        // org/job/attempt and the target artifact.
        if (
          String(parsed.organizationId) !== String(auth.organizationId)
          || String(parsed.jobId) !== String(request.jobId)
          || parsed.attempt !== request.attempt
          || String(parsed.artifactId) !== String(request.artifactId)
        ) {
          return rejected("malformed");
        }

        try {
          const outcome = await repos.jobControl.recordPatchApplyState({
            ...ctx.fenceIdentity,
            identifier: request.artifactId,
            patchObjectKey: request.objectKey,
            patchBaseManifestHash: parsed.baseManifestHash,
            patchResultManifestHash: parsed.resultManifestHash,
          });
          if (outcome.applyStatus === "applied") {
            return {
              outcome: "applied",
              artifactId: request.artifactId,
              baseManifestHash: parsed.baseManifestHash,
              resultManifestHash: outcome.resultManifestHash,
              alreadyApplied: outcome.alreadyApplied,
            };
          }
          return {
            outcome: "conflict_quarantined",
            artifactId: request.artifactId,
            expectedBaseManifestHash: parsed.baseManifestHash,
            currentBaseManifestHash: outcome.resolvedBaseManifestHash,
          };
        } catch (error) {
          if (error instanceof DbJobFenceError) {
            captureFenceGuardDenial(fenceGuardDenial, ctx.fenceIdentity, error);
            return rejected(fenceReason(error.code));
          }
          if (error instanceof PatchApplyRejection) return rejected("malformed");
          throw error;
        }
      })
        // Drain on the POOL handle once the tenant transaction has unwound — a
        // fence refusal REJECTS `runInTenant`, so this has to be `.finally` (whose
        // thenable callback IS awaited) rather than a trailing statement.
        .finally(async () => {
          await drainWorkerDenial(input.appDb, fenceDenial, {
            control: "server/src/services/worker-fence-context.ts:resolveWorkerFenceContext",
            workerId: auth.workerId,
            operation: "patch_apply",
          });
          // ★ DE-04 / DE-18 — the governed-fence refusal (stale_fence / target_revoked /
          // attempt_terminal from recordPatchApplyState's guardActiveFence), on the
          // pool handle.
          await drainFenceGuardDenialSink(input.appDb, fenceGuardDenial, {
            control: "server/src/services/patch-apply.ts:apply",
            operation: "patch_apply",
          });
        });
    },
  };
}
