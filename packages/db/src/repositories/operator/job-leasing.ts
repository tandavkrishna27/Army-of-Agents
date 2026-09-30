import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../client.js";
import {
  acquirePlatformTargetAuthorityExclusive,
  configurePlatformTargetAuthorityLockTimeout,
} from "../../platform-target-authority-lock.js";
import { executionTargets, workers } from "../../schema/index.js";

const targetColumns = {
  id: executionTargets.id,
  scope: executionTargets.scope,
  organizationId: executionTargets.organizationId,
  ownerUserId: executionTargets.ownerUserId,
  targetAuthorityKey: executionTargets.targetAuthorityKey,
  status: executionTargets.status,
  deviceGeneration: executionTargets.deviceGeneration,
  registeredProfileHash: executionTargets.registeredProfileHash,
  lastSeenAt: executionTargets.lastSeenAt,
};

const workerColumns = {
  id: workers.id,
  scope: workers.scope,
  organizationId: workers.organizationId,
  ownerUserId: workers.ownerUserId,
  executionTargetId: workers.executionTargetId,
  targetAuthorityKey: workers.targetAuthorityKey,
  status: workers.status,
  revokedAt: workers.revokedAt,
  deviceGeneration: workers.deviceGeneration,
  devicePublicKey: workers.devicePublicKey,
  deviceThumbprint: workers.deviceThumbprint,
  profileHash: workers.profileHash,
  lastSeenAt: workers.lastSeenAt,
};

export type PlatformPhysicalLeaseAuthority = {
  target: {
    id: string;
    scope: string;
    organizationId: string | null;
    ownerUserId: string | null;
    targetAuthorityKey: string;
    status: string;
    deviceGeneration: number;
    registeredProfileHash: string | null;
    lastSeenAt: Date | null;
  };
  worker: {
    id: string;
    scope: string;
    organizationId: string | null;
    ownerUserId: string | null;
    executionTargetId: string;
    targetAuthorityKey: string;
    status: string;
    revokedAt: Date | null;
    deviceGeneration: number;
    devicePublicKey: string | null;
    deviceThumbprint: string | null;
    profileHash: string | null;
    lastSeenAt: Date | null;
  };
};

/**
 * Metadata-only JOB-003 projection. It accepts only the physical target ID and
 * locks target then physical worker; tenant/job/lease/fence facts never enter
 * the operator transaction.
 */
export function operatorJobLeasingRepository(tx: Db) {
  return {
    async lockPlatformAuthorityForMutation(targetId: string) {
      await configurePlatformTargetAuthorityLockTimeout(tx);
      const [target] = await tx.select(targetColumns).from(executionTargets).where(and(
        eq(executionTargets.id, targetId),
        eq(executionTargets.scope, "platform"),
        isNull(executionTargets.organizationId),
        isNull(executionTargets.ownerUserId),
      )).limit(1).for("update");
      if (!target) return null;
      const [worker] = await tx.select(workerColumns).from(workers).where(and(
        eq(workers.executionTargetId, target.id),
        eq(workers.targetAuthorityKey, target.targetAuthorityKey),
        eq(workers.scope, "platform"),
        isNull(workers.organizationId),
        isNull(workers.ownerUserId),
      )).limit(1).for("update");
      await acquirePlatformTargetAuthorityExclusive(tx, target.id);
      return { target, worker: worker ?? null };
    },
    async lockPlatformPhysicalAuthority(
      targetId: string,
      mode: "share" | "update" = "share",
    ): Promise<PlatformPhysicalLeaseAuthority | null> {
      const targetQuery = tx.select(targetColumns).from(executionTargets).where(and(
        eq(executionTargets.id, targetId),
        eq(executionTargets.scope, "platform"),
        isNull(executionTargets.organizationId),
        isNull(executionTargets.ownerUserId),
      )).limit(1);
      const [target] = mode === "update"
        ? await targetQuery.for("update")
        : await targetQuery.for("share");
      if (!target) return null;

      const workerQuery = tx.select(workerColumns).from(workers).where(and(
        eq(workers.executionTargetId, target.id),
        eq(workers.targetAuthorityKey, target.targetAuthorityKey),
        eq(workers.scope, "platform"),
        isNull(workers.organizationId),
        isNull(workers.ownerUserId),
      )).limit(1);
      const [worker] = mode === "update"
        ? await workerQuery.for("update")
        : await workerQuery.for("share");
      return worker ? { target, worker } : null;
    },
  };
}
