import { and, asc, eq, exists, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "../../client.js";
import {
  acquirePlatformTargetAuthorityExclusive,
  acquirePlatformTargetAuthorityShared,
  configurePlatformTargetAuthorityLockTimeout,
} from "../../platform-target-authority-lock.js";
import {
  executionTargets,
  workerEnrollmentCodeRoutes,
  workerEnrollmentCodes,
  workerProofReplays,
  workers,
  organizationMemberships,
  type NewWorker,
  type Worker,
  type WorkerEnrollmentCode,
} from "../../schema/index.js";

type ExecutionTarget = typeof executionTargets.$inferSelect;
type EnrollmentTarget = Pick<ExecutionTarget,
  "id" | "organizationId" | "ownerUserId" | "scope" | "targetAuthorityKey" |
  "status" | "deviceGeneration" | "capabilities"
>;
type PlacementProfileTarget = Pick<ExecutionTarget,
  "id" | "organizationId" | "ownerUserId" | "scope" | "targetAuthorityKey" |
  "deviceGeneration" | "slug" | "kind" | "trustClass" | "status" |
  "registeredProfile" | "registeredProfileHash" | "providerConstraintProfile"
>;

const enrollmentTargetColumns = {
  id: executionTargets.id,
  organizationId: executionTargets.organizationId,
  ownerUserId: executionTargets.ownerUserId,
  scope: executionTargets.scope,
  targetAuthorityKey: executionTargets.targetAuthorityKey,
  status: executionTargets.status,
  deviceGeneration: executionTargets.deviceGeneration,
  capabilities: executionTargets.capabilities,
};

const placementProfileTargetColumns = {
  id: executionTargets.id,
  organizationId: executionTargets.organizationId,
  ownerUserId: executionTargets.ownerUserId,
  scope: executionTargets.scope,
  targetAuthorityKey: executionTargets.targetAuthorityKey,
  deviceGeneration: executionTargets.deviceGeneration,
  slug: executionTargets.slug,
  kind: executionTargets.kind,
  trustClass: executionTargets.trustClass,
  status: executionTargets.status,
  registeredProfile: executionTargets.registeredProfile,
  registeredProfileHash: executionTargets.registeredProfileHash,
  providerConstraintProfile: executionTargets.providerConstraintProfile,
};

export interface WorkerEnrollmentRepository {
  acquirePlatformTargetAuthorityShared(executionTargetId: string): Promise<void>;
  lockPlatformAuthorityForMutation(executionTargetId: string): Promise<boolean>;
  lockPlacementProfileTarget(executionTargetId: string): Promise<PlacementProfileTarget | null>;
  ratifyPlacementProfile(input: {
    executionTargetId: string;
    expectedGeneration: number;
    registeredProfile: Record<string, unknown>;
    registeredProfileHash: string;
    providerConstraintProfile: Record<string, unknown>;
    now: Date;
  }): Promise<PlacementProfileTarget | null>;
  findActiveTarget(input: {
    executionTargetId: string;
    scope: "platform" | "organization" | "owner";
    ownerUserId: string | null;
  }): Promise<EnrollmentTarget | null>;
  insertCodeRoute(values: typeof workerEnrollmentCodeRoutes.$inferInsert): Promise<void>;
  insertCode(values: typeof workerEnrollmentCodes.$inferInsert): Promise<void>;
  lockCode(locatorHash: string): Promise<WorkerEnrollmentCode | null>;
  recordProof(values: typeof workerProofReplays.$inferInsert): Promise<boolean>;
  findTargetByAuthority(input: {
    executionTargetId: string;
    targetAuthorityKey: string;
  }): Promise<EnrollmentTarget | null>;
  findWorker(id: string): Promise<Worker | null>;
  findWorkerForBinding(input: {
    scope: string;
    organizationId: string | null;
    ownerUserId: string | null;
    executionTargetId: string;
  }): Promise<Worker | null>;
  findPlatformPhysicalAuthority(executionTargetId: string): Promise<{
    worker: Worker;
    target: EnrollmentTarget;
  } | null>;
  insertWorker(values: NewWorker): Promise<Worker>;
  rotateWorker(input: {
    id: string;
    expectedGeneration: number;
    nextGeneration: number;
    devicePublicKey: string;
    deviceThumbprint: string;
    profileHash: string;
    profileSnapshot: Record<string, unknown>;
    enrolledAt: Date;
  }): Promise<boolean>;
  /**
   * WRK-011 — replace the enrolled self-model snapshot and its digest TOGETHER, on an
   * already-enrolled worker holding a live session. Unlike `rotateWorker` it does NOT touch
   * `deviceGeneration`, `devicePublicKey`, `deviceThumbprint`, `status`, `revokedAt` or
   * `enrolledAt` — a refresh re-states dynamic claims, it does not re-enrol. `expectedProfileHash`
   * is a compare-and-set so two concurrent refreshes cannot interleave into a snapshot/hash
   * pair from different helloes (§7 Step 2). Returns true iff exactly one row moved.
   */
  refreshWorkerProfile(input: {
    workerId: string;
    executionTargetId: string;
    expectedProfileHash: string;
    profileSnapshot: Record<string, unknown>;
    profileHash: string;
    now: Date;
  }): Promise<boolean>;
  advanceTargetGeneration(input: {
    executionTargetId: string;
    expectedGeneration: number;
    now: Date;
  }): Promise<number | null>;
  consumeCode(input: {
    id: string;
    consumedAt: Date;
    semanticIdempotencyKey: string;
    semanticDigest: string;
    deviceThumbprint: string;
    semanticResult: Record<string, unknown>;
  }): Promise<void>;
  retireBootstrapCredential(executionTargetId: string): Promise<void>;
  findSessionAuthority(input: { workerId: string; executionTargetId: string }): Promise<{
    worker: Worker;
    target: EnrollmentTarget;
    ownerMembershipActive: boolean;
  } | null>;
  cleanupExpiredProofs(expiresBefore: Date, limit?: number): Promise<number>;
  heartbeatSessionTarget(input: {
    executionTargetId: string;
    deviceGeneration: number;
    status: "active" | "draining" | "offline";
    now: Date;
  }): Promise<boolean>;
  heartbeatSessionProfile(input: {
    workerId: string;
    executionTargetId: string;
    deviceGeneration: number;
    now: Date;
  }): Promise<boolean>;
  heartbeatSharedPlatformTarget(input: {
    executionTargetId: string;
    targetAuthorityKey: "platform";
    deviceGeneration: number;
    physicalWorkerId: string;
    physicalProfileHash: string;
    devicePublicKey: string;
    deviceThumbprint: string;
    now: Date;
  }): Promise<boolean>;
  heartbeatPlatformPhysicalLivenessOnly(input: {
    executionTargetId: string;
    deviceGeneration: number;
    physicalWorkerId: string;
    physicalProfileHash: string;
    deviceThumbprint: string;
    now: Date;
  }): Promise<boolean>;
  revokeTargetAuthority(input: { executionTargetId: string; now: Date }): Promise<number | null>;
}

export function createWorkerEnrollmentRepository(tx: Db): WorkerEnrollmentRepository {
  return {
    async acquirePlatformTargetAuthorityShared(executionTargetId) {
      await configurePlatformTargetAuthorityLockTimeout(tx);
      await acquirePlatformTargetAuthorityShared(tx, executionTargetId);
    },
    async lockPlatformAuthorityForMutation(executionTargetId) {
      await configurePlatformTargetAuthorityLockTimeout(tx);
      const [target] = await tx.select({
        id: executionTargets.id,
        targetAuthorityKey: executionTargets.targetAuthorityKey,
      }).from(executionTargets).where(and(
        eq(executionTargets.id, executionTargetId),
        eq(executionTargets.scope, "platform"),
        isNull(executionTargets.organizationId),
        isNull(executionTargets.ownerUserId),
      )).limit(1).for("update");
      if (!target) return false;
      await tx.select({ id: workers.id }).from(workers).where(and(
        eq(workers.executionTargetId, target.id),
        eq(workers.targetAuthorityKey, target.targetAuthorityKey),
        eq(workers.scope, "platform"),
        isNull(workers.organizationId),
        isNull(workers.ownerUserId),
      )).for("update");
      await acquirePlatformTargetAuthorityExclusive(tx, target.id);
      return true;
    },
    async lockPlacementProfileTarget(executionTargetId) {
      const [target] = await tx.select(placementProfileTargetColumns).from(executionTargets).where(and(
        eq(executionTargets.id, executionTargetId),
        ne(executionTargets.status, "disabled"),
      )).limit(1).for("update");
      return target ?? null;
    },
    async ratifyPlacementProfile(input) {
      const [target] = await tx.update(executionTargets).set({
        registeredProfile: input.registeredProfile,
        registeredProfileHash: input.registeredProfileHash,
        providerConstraintProfile: input.providerConstraintProfile,
        updatedAt: input.now,
      }).where(and(
        eq(executionTargets.id, input.executionTargetId),
        eq(executionTargets.deviceGeneration, input.expectedGeneration),
        ne(executionTargets.status, "disabled"),
      )).returning(placementProfileTargetColumns);
      return target ?? null;
    },
    async findActiveTarget(input) {
      const [target] = await tx.select(enrollmentTargetColumns).from(executionTargets).where(and(
        eq(executionTargets.id, input.executionTargetId),
        eq(executionTargets.status, "active"),
        input.scope === "owner"
          ? and(
              eq(executionTargets.scope, "owner"),
              eq(executionTargets.ownerUserId, input.ownerUserId!),
            )
          : input.scope === "organization" ? and(
              or(eq(executionTargets.scope, "organization"), eq(executionTargets.scope, "platform")),
              isNull(executionTargets.ownerUserId),
            ) : and(
              eq(executionTargets.scope, "platform"),
              isNull(executionTargets.organizationId),
              isNull(executionTargets.ownerUserId),
            ),
      )).limit(1);
      if (!target) return null;
      if (input.scope === "owner") {
        const [membership] = await tx.select({ id: organizationMemberships.id })
          .from(organizationMemberships)
          .where(and(
            eq(organizationMemberships.organizationId, target.organizationId!),
            eq(organizationMemberships.userId, input.ownerUserId!),
            eq(organizationMemberships.status, "active"),
          ))
          .limit(1);
        if (!membership) return null;
      }
      return target;
    },
    async insertCodeRoute(values) {
      await tx.insert(workerEnrollmentCodeRoutes).values(values);
    },
    async insertCode(values) {
      await tx.insert(workerEnrollmentCodes).values(values);
    },
    async lockCode(locatorHash) {
      const [code] = await tx.select().from(workerEnrollmentCodes)
        .where(eq(workerEnrollmentCodes.locatorHash, locatorHash))
        .limit(1)
        .for("update");
      return code ?? null;
    },
    async recordProof(values) {
      await tx.delete(workerProofReplays).where(and(
        eq(workerProofReplays.deviceThumbprint, values.deviceThumbprint),
        eq(workerProofReplays.proofId, values.proofId),
        lte(workerProofReplays.expiresAt, sql`clock_timestamp()`),
      ));
      const rows = await tx.insert(workerProofReplays).values(values)
        .onConflictDoNothing()
        .returning({ id: workerProofReplays.id });
      return rows.length === 1;
    },
    async findTargetByAuthority(input) {
      const [target] = await tx.select(enrollmentTargetColumns).from(executionTargets).where(and(
        eq(executionTargets.id, input.executionTargetId),
        eq(executionTargets.targetAuthorityKey, input.targetAuthorityKey),
        eq(executionTargets.status, "active"),
      )).limit(1);
      return target ?? null;
    },
    async findWorker(id) {
      const [worker] = await tx.select().from(workers).where(eq(workers.id, id)).limit(1);
      return worker ?? null;
    },
    async findWorkerForBinding(input) {
      const conditions = [
        eq(workers.scope, input.scope),
        eq(workers.executionTargetId, input.executionTargetId),
        input.organizationId === null
          ? isNull(workers.organizationId)
          : eq(workers.organizationId, input.organizationId),
        input.ownerUserId === null
          ? isNull(workers.ownerUserId)
          : eq(workers.ownerUserId, input.ownerUserId),
      ];
      const [worker] = await tx.select().from(workers).where(and(...conditions)).limit(1).for("update");
      return worker ?? null;
    },
    async findPlatformPhysicalAuthority(executionTargetId) {
      const [row] = await tx.select({
        worker: workers,
        target: enrollmentTargetColumns,
      }).from(workers)
        .innerJoin(executionTargets, and(
          eq(workers.executionTargetId, executionTargets.id),
          eq(workers.targetAuthorityKey, executionTargets.targetAuthorityKey),
        ))
        .where(and(
          eq(executionTargets.id, executionTargetId),
          isNull(executionTargets.organizationId),
          isNull(executionTargets.ownerUserId),
          eq(executionTargets.scope, "platform"),
          eq(workers.scope, "platform"),
          isNull(workers.organizationId),
          isNull(workers.ownerUserId),
        ))
        .limit(1);
      return row ?? null;
    },
    async insertWorker(values) {
      const [worker] = await tx.insert(workers).values(values).returning();
      return worker!;
    },
    async rotateWorker(input) {
      const rows = await tx.update(workers).set({
        devicePublicKey: input.devicePublicKey,
        deviceThumbprint: input.deviceThumbprint,
        deviceGeneration: input.nextGeneration,
        profileHash: input.profileHash,
        profileSnapshot: input.profileSnapshot,
        enrolledAt: input.enrolledAt,
        revokedAt: null,
        status: "enrolled",
        updatedAt: input.enrolledAt,
      }).where(and(
        eq(workers.id, input.id),
        eq(workers.deviceGeneration, input.expectedGeneration),
      )).returning({ id: workers.id });
      return rows.length === 1;
    },
    async refreshWorkerProfile(input) {
      // Serialize with every other target-authority write (rotate/revoke/ratify) BEFORE the
      // mutation, in the same target -> worker -> exclusive order those writers use, so a refresh
      // cannot interleave with a concurrent revocation/rotation. The `expectedProfileHash` CAS
      // below still guards two concurrent refreshes; this lock guards refresh-vs-other-authority.
      await configurePlatformTargetAuthorityLockTimeout(tx);
      await tx.select({ id: executionTargets.id }).from(executionTargets)
        .where(eq(executionTargets.id, input.executionTargetId)).limit(1).for("update");
      await tx.select({ id: workers.id }).from(workers)
        .where(eq(workers.id, input.workerId)).limit(1).for("update");
      await acquirePlatformTargetAuthorityExclusive(tx, input.executionTargetId);
      const rows = await tx.update(workers).set({
        profileSnapshot: input.profileSnapshot,
        profileHash: input.profileHash,
        updatedAt: input.now,
      }).where(and(
        eq(workers.id, input.workerId),
        eq(workers.executionTargetId, input.executionTargetId),
        eq(workers.profileHash, input.expectedProfileHash),
      )).returning({ id: workers.id });
      return rows.length === 1;
    },
    async advanceTargetGeneration(input) {
      const [target] = await tx.update(executionTargets).set({
        deviceGeneration: sql`${executionTargets.deviceGeneration} + 1`,
        updatedAt: input.now,
      }).where(and(
        eq(executionTargets.id, input.executionTargetId),
        eq(executionTargets.deviceGeneration, input.expectedGeneration),
        ne(executionTargets.status, "disabled"),
      )).returning({ deviceGeneration: executionTargets.deviceGeneration });
      return target?.deviceGeneration ?? null;
    },
    async consumeCode(input) {
      await tx.update(workerEnrollmentCodes).set({
        consumedAt: input.consumedAt,
        semanticIdempotencyKey: input.semanticIdempotencyKey,
        semanticDigest: input.semanticDigest,
        deviceThumbprint: input.deviceThumbprint,
        semanticResult: input.semanticResult,
      }).where(eq(workerEnrollmentCodes.id, input.id));
    },
    async retireBootstrapCredential(executionTargetId) {
      await tx.update(executionTargets).set({
        workerTokenHash: null,
        updatedAt: new Date(),
      }).where(eq(executionTargets.id, executionTargetId));
    },
    async findSessionAuthority(input) {
      const [row] = await tx.select({
        worker: workers,
        target: enrollmentTargetColumns,
      }).from(workers)
        .innerJoin(executionTargets, and(
          eq(workers.executionTargetId, executionTargets.id),
          eq(workers.targetAuthorityKey, executionTargets.targetAuthorityKey),
        ))
        .where(and(
          eq(workers.id, input.workerId),
          eq(workers.executionTargetId, input.executionTargetId),
        ))
        .limit(1);
      if (!row) return null;
      let ownerMembershipActive = true;
      if (row.worker.scope === "owner") {
        const [membership] = await tx.select({ id: organizationMemberships.id })
          .from(organizationMemberships)
          .where(and(
            eq(organizationMemberships.organizationId, row.worker.organizationId!),
            eq(organizationMemberships.userId, row.worker.ownerUserId!),
            eq(organizationMemberships.status, "active"),
          ))
          .limit(1);
        ownerMembershipActive = Boolean(membership);
      }
      return { worker: row.worker, target: row.target, ownerMembershipActive };
    },
    async cleanupExpiredProofs(expiresBefore, limit = 100) {
      const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
      const rows = await tx.select({ id: workerProofReplays.id })
        .from(workerProofReplays)
        .where(lte(workerProofReplays.expiresAt, expiresBefore))
        .orderBy(asc(workerProofReplays.expiresAt), asc(workerProofReplays.id))
        .limit(boundedLimit);
      if (rows.length === 0) return 0;
      const deleted = await tx.delete(workerProofReplays)
        .where(inArray(workerProofReplays.id, rows.map((row) => row.id)))
        .returning({ id: workerProofReplays.id });
      return deleted.length;
    },
    async heartbeatSessionTarget(input) {
      const rows = await tx.update(executionTargets).set({
        lastSeenAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(executionTargets.id, input.executionTargetId),
        eq(executionTargets.deviceGeneration, input.deviceGeneration),
        ne(executionTargets.status, "disabled"),
      )).returning({ id: executionTargets.id });
      return rows.length === 1;
    },
    async heartbeatSessionProfile(input) {
      const rows = await tx.update(workers).set({
        lastSeenAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(workers.id, input.workerId),
        eq(workers.executionTargetId, input.executionTargetId),
        eq(workers.deviceGeneration, input.deviceGeneration),
        ne(workers.status, "revoked"),
      )).returning({ id: workers.id });
      return rows.length === 1;
    },
    async heartbeatSharedPlatformTarget(input) {
      const physicalAuthorityExists = tx.select({ id: workers.id })
        .from(workers)
        .where(and(
          eq(workers.id, input.physicalWorkerId),
          eq(workers.executionTargetId, input.executionTargetId),
          eq(workers.targetAuthorityKey, input.targetAuthorityKey),
          eq(workers.scope, "platform"),
          isNull(workers.organizationId),
          isNull(workers.ownerUserId),
          ne(workers.status, "revoked"),
          isNull(workers.revokedAt),
          eq(workers.deviceGeneration, input.deviceGeneration),
          eq(workers.devicePublicKey, input.devicePublicKey),
          eq(workers.deviceThumbprint, input.deviceThumbprint),
          eq(workers.profileHash, input.physicalProfileHash),
        ));
      const rows = await tx.update(executionTargets).set({
        lastSeenAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(executionTargets.id, input.executionTargetId),
        eq(executionTargets.targetAuthorityKey, input.targetAuthorityKey),
        eq(executionTargets.scope, "platform"),
        isNull(executionTargets.organizationId),
        isNull(executionTargets.ownerUserId),
        eq(executionTargets.status, "active"),
        eq(executionTargets.deviceGeneration, input.deviceGeneration),
        exists(physicalAuthorityExists),
      )).returning({ id: executionTargets.id });
      if (rows.length !== 1) return false;
      const workerRows = await tx.update(workers).set({
        lastSeenAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(workers.id, input.physicalWorkerId),
        eq(workers.executionTargetId, input.executionTargetId),
        eq(workers.targetAuthorityKey, input.targetAuthorityKey),
        eq(workers.scope, "platform"),
        isNull(workers.organizationId),
        isNull(workers.ownerUserId),
        ne(workers.status, "revoked"),
        isNull(workers.revokedAt),
        eq(workers.deviceGeneration, input.deviceGeneration),
        eq(workers.devicePublicKey, input.devicePublicKey),
        eq(workers.deviceThumbprint, input.deviceThumbprint),
        eq(workers.profileHash, input.physicalProfileHash),
      )).returning({ id: workers.id });
      if (workerRows.length !== 1) {
        throw new Error("Platform worker heartbeat authority changed");
      }
      return true;
    },
    async heartbeatPlatformPhysicalLivenessOnly(input) {
      const physicalAuthorityExists = tx.select({ id: workers.id })
        .from(workers)
        .where(and(
          eq(workers.id, input.physicalWorkerId),
          eq(workers.executionTargetId, input.executionTargetId),
          eq(workers.scope, "platform"),
          isNull(workers.organizationId),
          isNull(workers.ownerUserId),
          ne(workers.status, "revoked"),
          isNull(workers.revokedAt),
          eq(workers.deviceGeneration, input.deviceGeneration),
          eq(workers.deviceThumbprint, input.deviceThumbprint),
          eq(workers.profileHash, input.physicalProfileHash),
        ));
      const targets = await tx.update(executionTargets).set({
        lastSeenAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(executionTargets.id, input.executionTargetId),
        eq(executionTargets.scope, "platform"),
        isNull(executionTargets.organizationId),
        isNull(executionTargets.ownerUserId),
        eq(executionTargets.status, "active"),
        eq(executionTargets.deviceGeneration, input.deviceGeneration),
        exists(physicalAuthorityExists),
      )).returning({ id: executionTargets.id });
      if (targets.length !== 1) return false;
      const profiles = await tx.update(workers).set({
        lastSeenAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(workers.id, input.physicalWorkerId),
        eq(workers.executionTargetId, input.executionTargetId),
        eq(workers.scope, "platform"),
        isNull(workers.organizationId),
        isNull(workers.ownerUserId),
        ne(workers.status, "revoked"),
        isNull(workers.revokedAt),
        eq(workers.deviceGeneration, input.deviceGeneration),
        eq(workers.deviceThumbprint, input.deviceThumbprint),
        eq(workers.profileHash, input.physicalProfileHash),
      )).returning({ id: workers.id });
      return profiles.length === 1;
    },
    async revokeTargetAuthority(input) {
      await this.lockPlatformAuthorityForMutation(input.executionTargetId);
      const [target] = await tx.update(executionTargets).set({
        status: "disabled",
        workerTokenHash: null,
        deviceGeneration: sql`${executionTargets.deviceGeneration} + 1`,
        updatedAt: input.now,
      }).where(eq(executionTargets.id, input.executionTargetId))
        .returning({ deviceGeneration: executionTargets.deviceGeneration });
      if (!target) return null;
      await tx.update(workers).set({
        status: "revoked",
        revokedAt: input.now,
        updatedAt: input.now,
      }).where(eq(workers.executionTargetId, input.executionTargetId));
      return target.deviceGeneration;
    },
  };
}
