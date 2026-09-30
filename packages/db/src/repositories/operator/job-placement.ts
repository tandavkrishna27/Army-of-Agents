import { and, eq } from "drizzle-orm";
import type { Db } from "../../client.js";
import { executionTargets, workers } from "../../schema/index.js";
import type { PlacementCandidateSnapshot } from "../tenant/job-control.js";

/**
 * JOB-009 platform-only bounded registry reader. The caller supplies a verified
 * aoa_operator handle; FORCE RLS restricts both joined tables to null-Org rows.
 * This API accepts no job/Company/source identifiers or payloads by design.
 */
export async function listPlatformPlacementCandidateSnapshots(
  operatorDb: Pick<Db, "select">,
): Promise<PlacementCandidateSnapshot[]> {
  const rows = await operatorDb.select({
    target: {
      id: executionTargets.id,
      slug: executionTargets.slug,
      kind: executionTargets.kind,
      trustClass: executionTargets.trustClass,
      status: executionTargets.status,
      organizationId: executionTargets.organizationId,
      ownerUserId: executionTargets.ownerUserId,
      scope: executionTargets.scope,
      targetAuthorityKey: executionTargets.targetAuthorityKey,
      deviceGeneration: executionTargets.deviceGeneration,
      registeredProfile: executionTargets.registeredProfile,
      registeredProfileHash: executionTargets.registeredProfileHash,
      providerConstraintProfile: executionTargets.providerConstraintProfile,
      capabilities: executionTargets.capabilities,
      lastSeenAt: executionTargets.lastSeenAt,
    },
    worker: {
      id: workers.id,
      scope: workers.scope,
      organizationId: workers.organizationId,
      ownerUserId: workers.ownerUserId,
      executionTargetId: workers.executionTargetId,
      targetAuthorityKey: workers.targetAuthorityKey,
      deviceGeneration: workers.deviceGeneration,
      profileHash: workers.profileHash,
      profileSnapshot: workers.profileSnapshot,
      lastSeenAt: workers.lastSeenAt,
      status: workers.status,
    },
  }).from(executionTargets).innerJoin(workers, and(
    eq(workers.executionTargetId, executionTargets.id),
    eq(workers.targetAuthorityKey, executionTargets.targetAuthorityKey),
  )).for("share");
  return rows.map((row) => ({ ...row, ownerMembershipActive: true }));
}
