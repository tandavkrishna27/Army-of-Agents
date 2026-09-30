// server/src/services/folder-grant.ts
//
// DAT-006 — the local-folder-grant admission service + resolver. It admits an explicit
// `(owner, execution_target, declared base)` grant into the tenant-scoped `folder_grants`
// table (the durable record the FROZEN `snapshotProvenance.folderGrantId` uuid resolves
// to) and resolves a `folderGrantId` at stage/reconcile time to gate that a captured path
// is WITHIN the declared base. It is INERT until a capture/reconcile path reads it (the
// frozen `folderGrantId` points at nothing today) — default-off distributed posture.
//
// It uses the tenant transaction (`runInTenant` sets the `aoa.organization_id` GUC so the
// per-table FORCE RLS + tenant-isolation policy scope every row to the caller's org); it
// touches `folder_grants` directly via the tx (there is no cross-tenant folder-grant read).

import { and, eq, isNull, sql } from "drizzle-orm";
import { folderGrants, type Db } from "@armyofagents/db";
import { runInTenant } from "../db/tenant-context.js";
import { isSafeWorkspacePath, isPathWithinBase, isLikelySecretPath, admitCapturedPaths, type CapturedEntry, type PathAdmissionResult } from "./folder-grant-path.js";
import { bindGrantToDevice, type GrantBindingRejection, type PresentedDeviceIdentity } from "./folder-grant-binding.js";

export type FolderGrantErrorReason = "invalid_base";

export class FolderGrantError extends Error {
  constructor(public readonly reason: FolderGrantErrorReason) {
    super(`Folder grant ${reason}`);
    this.name = "FolderGrantError";
  }
}

export interface AdmitFolderGrantInput {
  organizationId: string;
  ownerUserId: string;
  executionTargetId: string;
  targetAuthorityKey: string;
  deviceGeneration: number;
  declaredBasePath: string;
}

export interface AdmitFolderGrantResult {
  folderGrantId: string;
  /** false on an idempotent replay (an active grant for this base already existed). */
  admitted: boolean;
}

export interface ResolvedFolderGrant {
  folderGrantId: string;
  ownerUserId: string;
  executionTargetId: string;
  deviceGeneration: number;
  declaredBasePath: string;
}

export interface ResolveCapturedPathResult {
  admitted: boolean;
  grant: ResolvedFolderGrant | null;
  /** Present when the grant resolved but did not bind, or was absent. */
  reason?: GrantBindingRejection | "out_of_base" | "likely_secret";
}

export interface AdmitCaptureResult {
  grant: ResolvedFolderGrant | null;
  /** Set when the whole capture is refused before any path is considered. */
  refusal: GrantBindingRejection | null;
  paths: PathAdmissionResult;
}

export function createFolderGrantService(input: { appDb: Db }) {
  return {
    /** Admit an explicit folder grant (idempotent on the active-base natural key). */
    async admit(admitInput: AdmitFolderGrantInput): Promise<AdmitFolderGrantResult> {
      // The declared base must be a safe RELATIVE path — an absolute path, `..` escape,
      // drive letter, or NUL/control is rejected before any row is written.
      if (!isSafeWorkspacePath(admitInput.declaredBasePath)) throw new FolderGrantError("invalid_base");
      return runInTenant(input.appDb, admitInput.organizationId, async (_repos, tx) => {
        const inserted = await tx.insert(folderGrants).values({
          organizationId: admitInput.organizationId,
          ownerUserId: admitInput.ownerUserId,
          executionTargetId: admitInput.executionTargetId,
          targetAuthorityKey: admitInput.targetAuthorityKey,
          deviceGeneration: admitInput.deviceGeneration,
          declaredBasePath: admitInput.declaredBasePath,
        }).onConflictDoNothing({
          target: [
            folderGrants.organizationId,
            folderGrants.executionTargetId,
            folderGrants.ownerUserId,
            folderGrants.declaredBasePath,
          ],
          where: sql`revoked_at IS NULL`,
        }).returning({ folderGrantId: folderGrants.folderGrantId });
        if (inserted[0]) return { folderGrantId: inserted[0].folderGrantId, admitted: true };

        // Conflict → an active grant for this base already exists (idempotent replay).
        const [existing] = await tx.select({ folderGrantId: folderGrants.folderGrantId })
          .from(folderGrants)
          .where(and(
            eq(folderGrants.organizationId, admitInput.organizationId),
            eq(folderGrants.executionTargetId, admitInput.executionTargetId),
            eq(folderGrants.ownerUserId, admitInput.ownerUserId),
            eq(folderGrants.declaredBasePath, admitInput.declaredBasePath),
            isNull(folderGrants.revokedAt),
          ))
          .limit(1);
        if (!existing) throw new FolderGrantError("invalid_base");
        return { folderGrantId: existing.folderGrantId, admitted: false };
      });
    },

    /** Resolve an ACTIVE (non-revoked) folder grant by its frozen `folderGrantId`. */
    async resolve(resolveInput: { organizationId: string; folderGrantId: string }): Promise<ResolvedFolderGrant | null> {
      return runInTenant(input.appDb, resolveInput.organizationId, async (_repos, tx) => {
        const [row] = await tx.select({
          folderGrantId: folderGrants.folderGrantId,
          ownerUserId: folderGrants.ownerUserId,
          executionTargetId: folderGrants.executionTargetId,
          deviceGeneration: folderGrants.deviceGeneration,
          declaredBasePath: folderGrants.declaredBasePath,
        }).from(folderGrants).where(and(
          eq(folderGrants.folderGrantId, resolveInput.folderGrantId),
          isNull(folderGrants.revokedAt),
        )).limit(1);
        return row ?? null;
      });
    },

    /** Resolve a folder grant, BIND it to the presenting device, and gate that a single
     * captured path is WITHIN its declared base. A revoked/absent grant, a grant belonging
     * to another desktop or a superseded device generation, or an out-of-base/unsafe path,
     * is not admitted.
     *
     * `presented` is REQUIRED, deliberately. It was added as a required parameter rather
     * than an optional one so that no caller can omit it and silently fall back to the
     * org-only scoping this method used to do — an organization's RLS scope is not a
     * device scope (see `folder-grant-binding.ts`). There were zero callers when this
     * changed, so the strictness cost nothing. */
    async resolveCapturedPath(pathInput: {
      organizationId: string;
      folderGrantId: string;
      capturedPath: string;
      presented: PresentedDeviceIdentity;
    }): Promise<ResolveCapturedPathResult> {
      const grant = await this.resolve({ organizationId: pathInput.organizationId, folderGrantId: pathInput.folderGrantId });
      const binding = bindGrantToDevice(grant, pathInput.presented);
      if (!binding.bound) return { admitted: false, grant, reason: binding.reason };
      // Enforce the SAME always-on secret floor the batch admitCapturedPaths applies —
      // a grant is permission to stage source, NEVER to exfiltrate a `.env`/`id_rsa`/
      // `*.pem`/credential even when it sits inside the declared base.
      if (!isPathWithinBase(grant!.declaredBasePath, pathInput.capturedPath)) {
        return { admitted: false, grant, reason: "out_of_base" };
      }
      if (isLikelySecretPath(pathInput.capturedPath)) {
        return { admitted: false, grant, reason: "likely_secret" };
      }
      return { admitted: true, grant };
    },

    /** Batch form: bind once, then admit a whole captured entry set against the declared
     * base. A refused BINDING admits nothing at all — it does not degrade into a
     * per-path filter, because the question "may this device use this grant" is prior to
     * "is this path in the base". */
    async admitCapture(captureInput: {
      organizationId: string;
      folderGrantId: string;
      presented: PresentedDeviceIdentity;
      entries: readonly CapturedEntry[];
    }): Promise<AdmitCaptureResult> {
      const grant = await this.resolve({ organizationId: captureInput.organizationId, folderGrantId: captureInput.folderGrantId });
      const binding = bindGrantToDevice(grant, captureInput.presented);
      if (!binding.bound) {
        return { grant, refusal: binding.reason, paths: { admitted: [], rejected: [] } };
      }
      return { grant, refusal: null, paths: admitCapturedPaths(grant!.declaredBasePath, captureInput.entries) };
    },
  };
}
