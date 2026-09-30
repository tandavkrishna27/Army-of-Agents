import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull, ne, notExists, sql } from "drizzle-orm";
import {
  acquirePlatformTargetAuthorityExclusive,
  configurePlatformTargetAuthorityLockTimeout,
  executionTargets,
  executionTargetRevocations,
  operatorJobLeasingRepository,
  workers,
  type Db,
} from "@armyofagents/db";
import {
  canonicalizeJsonV1,
  registeredTargetProfileV1Schema,
  verifyAndBrandProviderConstraintProfileV1,
} from "@armyofagents/worker-protocol";
import { runInTenant } from "../db/tenant-context.js";
import { normalizePlacementRegistryTarget, type ExecutionTargetRow } from "./execution-target-resolver.js";
import { projectDesktopDevice } from "./desktop-device-projection.js";
import {
  classifyDeviceLiveness,
  resolveDeviceLivenessDeadlineMs,
} from "./device-liveness.js";
import { verifyDeviceEnrolmentKey, type DeviceKeyVerification } from "./device-verify.js";

// Rotatable worker credential (Finding #3). The row id is NOT a credential;
// this token is. Only its hash is persisted (execution_targets.worker_token_hash);
// the plaintext is shown once at registration.
export function createWorkerToken(): string {
  return `aoa_wtk_${randomBytes(24).toString("hex")}`;
}
export function hashWorkerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export interface LegacyWorkerHeartbeatAuthority {
  targetId: string;
  organizationId: string;
}

export async function resolveWorkerTargetId(db: Db, token: string): Promise<string | null> {
  return (await resolveWorkerHeartbeatAuthority(db, token))?.targetId ?? null;
}

export async function resolveWorkerHeartbeatAuthority(
  db: Db,
  token: string,
): Promise<LegacyWorkerHeartbeatAuthority | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const rows = await db
    .select({
      targetId: executionTargets.id,
      organizationId: executionTargets.organizationId,
    })
    .from(executionTargets)
    .where(
      and(
        eq(executionTargets.workerTokenHash, hashWorkerToken(trimmed)),
        ne(executionTargets.status, "disabled"),
        isNotNull(executionTargets.organizationId),
      ),
    );
  const row = rows[0];
  return row?.organizationId
    ? { targetId: row.targetId, organizationId: row.organizationId }
    : null;
}
export function stripWorkerSecret<T extends { workerTokenHash?: unknown }>(row: T): Omit<T, "workerTokenHash"> {
  const { workerTokenHash: _omit, ...rest } = row;
  return rest;
}

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

async function validatedPlacementProfiles(input: {
  target: ExecutionTargetRow;
  registeredProfile: unknown;
  providerConstraintProfile: unknown;
}) {
  const registered = registeredTargetProfileV1Schema.safeParse(input.registeredProfile);
  const provider = await verifyAndBrandProviderConstraintProfileV1(
    input.providerConstraintProfile,
    (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  if (!registered.success || !provider || registered.data.revokedAt !== null) {
    throw new Error("invalid_execution_target_placement_profile");
  }
  const registeredProfileHash = createHash("sha256")
    .update(canonicalizeJsonV1(registered.data))
    .digest("hex");
  const normalized = await normalizePlacementRegistryTarget({
    ...input.target,
    registeredProfile: registered.data,
    registeredProfileHash,
    providerConstraintProfile: provider,
  });
  if (!normalized) throw new Error("invalid_execution_target_placement_profile");
  return {
    registeredProfile: registered.data as unknown as Record<string, unknown>,
    registeredProfileHash,
    providerConstraintProfile: provider as unknown as Record<string, unknown>,
  };
}

/** Tenant-admin writer: runInTenant + FORCE RLS are the authority boundary. */
export async function ratifyTenantExecutionTargetPlacementProfile(input: {
  appDb: Db;
  organizationId: string;
  executionTargetId: string;
  registeredProfile: unknown;
  providerConstraintProfile: unknown;
  now?: Date;
}) {
  return runInTenant(input.appDb, input.organizationId, async (repos) => {
    const target = await repos.workerEnrollment.lockPlacementProfileTarget(input.executionTargetId);
    if (!target || target.organizationId !== input.organizationId || target.scope === "platform") {
      throw new Error("execution_target_not_found");
    }
    const profiles = await validatedPlacementProfiles({ target, ...input });
    const updated = await repos.workerEnrollment.ratifyPlacementProfile({
      executionTargetId: target.id,
      expectedGeneration: target.deviceGeneration,
      ...profiles,
      now: input.now ?? new Date(),
    });
    if (!updated) throw new Error("execution_target_profile_update_conflict");
    return updated;
  });
}

/** Platform-admin writer: the operator projection can see/update only null-org rows. */
export async function ratifyPlatformExecutionTargetPlacementProfile(input: {
  operatorDb: Db;
  executionTargetId: string;
  registeredProfile: unknown;
  providerConstraintProfile: unknown;
  now?: Date;
}) {
  return input.operatorDb.transaction(async (tx) => {
    await configurePlatformTargetAuthorityLockTimeout(tx as unknown as Db);
    const authority = await operatorJobLeasingRepository(tx as unknown as Db)
      .lockPlatformAuthorityForMutation(input.executionTargetId);
    if (!authority) throw new Error("execution_target_not_found");
    await acquirePlatformTargetAuthorityExclusive(tx as unknown as Db, input.executionTargetId);
    const [target] = await tx.select(placementProfileTargetColumns).from(executionTargets).where(and(
      eq(executionTargets.id, input.executionTargetId),
      isNull(executionTargets.organizationId),
      eq(executionTargets.scope, "platform"),
      ne(executionTargets.status, "disabled"),
    )).limit(1).for("update");
    if (!target) throw new Error("execution_target_not_found");
    const profiles = await validatedPlacementProfiles({ target, ...input });
    const [updated] = await tx.update(executionTargets).set({
      ...profiles,
      updatedAt: input.now ?? new Date(),
    }).where(and(
      eq(executionTargets.id, target.id),
      isNull(executionTargets.organizationId),
      eq(executionTargets.deviceGeneration, target.deviceGeneration),
      ne(executionTargets.status, "disabled"),
    )).returning(placementProfileTargetColumns);
    if (!updated) throw new Error("execution_target_profile_update_conflict");
    return updated;
  });
}

export async function rotateExecutionTargetWorkerToken(
  db: Db,
  input: { organizationId: string; targetId: string },
) {
  const workerToken = createWorkerToken();
  const [row] = await db
    .update(executionTargets)
    .set({
      workerTokenHash: hashWorkerToken(workerToken),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(executionTargets.id, input.targetId),
        eq(executionTargets.organizationId, input.organizationId),
        isNotNull(executionTargets.organizationId),
        ne(executionTargets.status, "disabled"),
        notExists(
          db.select({ id: workers.id }).from(workers).where(and(
            eq(workers.executionTargetId, input.targetId),
            ne(workers.status, "revoked"),
          )),
        ),
      ),
    )
    .returning();

  if (!row) return null;
  return { target: stripWorkerSecret(row), workerToken };
}

// ---------------------------------------------------------------------------
// JOB-007 — worker/target revocation via generation cutoff.
//
// A committed cutoff bumps `execution_targets.device_generation` and disables the
// target. The fence guard's locked current-generation recheck (job-control.ts
// guardActiveFence) then refuses EVERY governed effect on the old generation as
// `target_revoked` — refresh/new leases, event ingest, secret read, artifact
// upload, projection apply, health, control-ACK, and completion — the instant the
// cutoff commits, BEFORE any per-Organization fanout runs. The durable operator
// record (`execution_target_revocations`) drives idempotent, resumable convergence
// of already-stale leases; it is NOT lease authority.

export interface RevokeExecutionTargetInput {
  appDb: Db;
  operatorDb: Db;
  targetId: string;
  /** The owning Organization for an organization/owner-scoped target; NULL for a
   * platform (system/shared) target. */
  organizationId: string | null;
  reason?: string;
}

export interface RevokeExecutionTargetResult {
  revoked: boolean;
  reason?: "not_found" | "already_disabled";
  revokedGeneration?: number;
  targetScope?: string;
  organizationId?: string | null;
}

/**
 * Idempotently COMMIT the generation cutoff: bump `device_generation` to
 * `revokedGeneration + 1` and disable the target, conditional on the target still
 * being at `revokedGeneration`. Reused by the fanout worker for crash recovery
 * (durable record written but the bump not yet committed), so it is safe to call
 * repeatedly. An organization/owner target is bumped under `runInTenant` (the only
 * authority that can write the target's own-Org row); a platform target is bumped
 * on the operator connection (the null-Org platform-operator authority).
 */
/**
 * JOB-007 operator generation-cutoff (narrow service-guarded delegate). DISABLES the
 * target and bumps `deviceGeneration` by one, gated ONLY by `status != 'disabled'`.
 *
 * The `status != 'disabled'` guard (not an exact-generation CAS) is deliberate and makes
 * the cutoff BOTH idempotent AND correct under a concurrent generation advance:
 *   - idempotent: once the target is `disabled`, a re-invocation matches no row and
 *     no-ops (the fanout re-ensures this cutoff on crash recovery, possibly many times);
 *   - race-correct: whatever the live generation is when this runs, the target ends
 *     `disabled` with a strictly-greater generation. An exact-generation CAS
 *     (`WHERE device_generation = revokedGeneration`) would silently match zero rows if a
 *     racing re-enrollment (`advanceTargetGeneration`, which bumps the generation while
 *     leaving status active) advanced the generation in the gap between the revoke's
 *     FOR-UPDATE generation read and this cutoff — leaving the target ACTIVE while the
 *     revoke returned success (lost revocation). See worker-revocation.integration.test.ts
 *     "the cutoff disables the target even when the live generation advanced ...".
 * It serializes against `advanceTargetGeneration` (also `WHERE status != 'disabled'`) on
 * the row lock, so exactly one of {disable, re-enrollment advance} wins per contention and
 * the target always ends disabled.
 *
 * This is NOT a lease transaction and never opens its own transaction/`runInTenant`: its
 * scope is the caller's — `ensureExecutionTargetCutoff` runs the org path inside
 * `runInTenant` (tenant RLS) and the platform (null-Org) path on `operatorDb` (platform
 * authority). Kept a top-level named delegate so the authority-writer allowlist auditor
 * can re-find and lock-order-exempt it (see job-leasing-contract.test.ts).
 */
async function bumpExecutionTargetGeneration(
  tx: Db,
  input: { targetId: string; organizationId: string | null },
): Promise<void> {
  await tx
    .update(executionTargets)
    .set({
      deviceGeneration: sql`${executionTargets.deviceGeneration} + 1`,
      status: "disabled",
      updatedAt: sql`clock_timestamp()`,
    })
    .where(and(
      eq(executionTargets.id, input.targetId),
      ne(executionTargets.status, "disabled"),
      input.organizationId
        ? eq(executionTargets.organizationId, input.organizationId)
        : isNull(executionTargets.organizationId),
    ));
}

export async function ensureExecutionTargetCutoff(input: {
  appDb: Db;
  operatorDb: Db;
  targetId: string;
  organizationId: string | null;
  // Retained as part of the durable record identity + lease-convergence bound. The cutoff
  // itself is generation-AGNOSTIC (disable-if-active), so it is not forwarded to the bump.
  revokedGeneration: number;
}): Promise<void> {
  const cutoff = {
    targetId: input.targetId,
    organizationId: input.organizationId,
  };
  if (input.organizationId) {
    await runInTenant(input.appDb, input.organizationId, async (_repos, tx) => {
      await bumpExecutionTargetGeneration(tx, cutoff);
    });
  } else {
    await input.operatorDb.transaction(async (tx) => {
      await bumpExecutionTargetGeneration(tx as unknown as Db, cutoff);
    });
  }
}

/**
 * Revoke an execution target. Writes the durable operator record FIRST (crash-safe:
 * the fanout re-ensures the cutoff), then commits the generation cutoff. The record
 * is keyed by `(target_id, revoked_generation)`, so a re-invocation for a target
 * already at a disabled/bumped generation is a no-op. This authority NEVER runs a
 * cross-Organization lease transaction — it only touches the target and the durable
 * record; per-Organization lease convergence is the fanout worker's job.
 */
export async function revokeExecutionTarget(
  input: RevokeExecutionTargetInput,
): Promise<RevokeExecutionTargetResult> {
  const targetColumns = {
    scope: executionTargets.scope,
    organizationId: executionTargets.organizationId,
    deviceGeneration: executionTargets.deviceGeneration,
    status: executionTargets.status,
  };
  // Resolve + lock the target to read its current generation/scope/status. An
  // org/owner target is visible only inside its own tenant; a platform target only
  // to the operator (null-Org platform-operator RLS).
  const resolved = input.organizationId
    ? await runInTenant(input.appDb, input.organizationId, async (_repos, tx) => {
        const [row] = await tx
          .select(targetColumns)
          .from(executionTargets)
          .where(and(
            eq(executionTargets.id, input.targetId),
            eq(executionTargets.organizationId, input.organizationId!),
          ))
          .for("update")
          .limit(1);
        return row ?? null;
      })
    : await input.operatorDb.transaction(async (tx) => {
        const [row] = await (tx as unknown as Db)
          .select(targetColumns)
          .from(executionTargets)
          .where(and(
            eq(executionTargets.id, input.targetId),
            isNull(executionTargets.organizationId),
            eq(executionTargets.scope, "platform"),
          ))
          .for("update")
          .limit(1);
        return row ?? null;
      });
  if (!resolved) return { revoked: false, reason: "not_found" };
  if (resolved.status === "disabled") {
    return {
      revoked: false,
      reason: "already_disabled",
      revokedGeneration: resolved.deviceGeneration,
      targetScope: resolved.scope,
      organizationId: resolved.organizationId,
    };
  }
  const revokedGeneration = resolved.deviceGeneration;
  // Durable operator record FIRST. If a crash lands here before the cutoff commits,
  // the fanout worker sees the pending record and re-ensures the cutoff.
  await input.operatorDb
    .insert(executionTargetRevocations)
    .values({
      targetId: input.targetId,
      revokedGeneration,
      targetScope: resolved.scope,
      organizationId: input.organizationId,
      reason: input.reason ?? null,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [executionTargetRevocations.targetId, executionTargetRevocations.revokedGeneration],
    });
  // Commit the cutoff (idempotent).
  await ensureExecutionTargetCutoff({
    appDb: input.appDb,
    operatorDb: input.operatorDb,
    targetId: input.targetId,
    organizationId: input.organizationId,
    revokedGeneration,
  });
  return {
    revoked: true,
    revokedGeneration,
    targetScope: resolved.scope,
    organizationId: input.organizationId,
  };
}

export async function revokeExecutionTargetWorkerToken(
  db: Db,
  input: { organizationId: string; targetId: string },
) {
  const [row] = await db
    .update(executionTargets)
    .set({
      workerTokenHash: null,
      status: "disabled",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(executionTargets.id, input.targetId),
        eq(executionTargets.organizationId, input.organizationId),
      ),
    )
    .returning();

  return row ? stripWorkerSecret(row) : null;
}

/**
 * M5: idempotent only because execution_targets_org_slug_uq is NULLS NOT DISTINCT
 * (Task 4). With default NULLS DISTINCT this onConflict target would never match a
 * system row (organization_id = NULL) and would insert a duplicate every boot.
 */
export async function ensureControlPlaneExecutionTarget(db: Db): Promise<void> {
  await db
    .insert(executionTargets)
    .values({
      organizationId: null,
      scope: "platform",
      targetAuthorityKey: "platform",
      slug: "control-plane",
      kind: "local_host",
      trustClass: "local_trusted",
      status: "active",
      capabilities: { runtimes: ["runc"], adapters: ["claude_local", "codex_local", "process"] },
      config: { transport: "local_host" },
    })
    .onConflictDoNothing({ target: [executionTargets.organizationId, executionTargets.slug] });
}

// M6: heartbeat is scoped to the authenticated worker's TARGET ID, never the
// slug. slug is unique only per (organization_id, slug), so a slug-scoped update
// would let org-1's worker token flip org-2's identically-slugged pool row. The
// worker token resolves to exactly one target id; update by that id only.
//
// A `disabled` target is out of rotation by operator decision. The status guard
// (ne status 'disabled') keeps disabling DURABLE: a disabled worker's own
// heartbeat matches nothing → updated === 0, so the row is never resurrected to
// 'active'. The route returns 404 on updated === 0, telling the worker it was
// deactivated. (The resolver already excludes disabled rows from routing.)
export async function registerWorkerHeartbeat(
  db: Db,
  input: {
    targetId: string;
    organizationId?: string;
    status?: "active" | "draining" | "offline";
    capabilities?: Record<string, unknown>;
    now?: Date;
  },
): Promise<{ updated: number }> {
  const heartbeatAt = input.now ?? new Date();
  const rows = await db
    .update(executionTargets)
    .set({
      lastSeenAt: heartbeatAt,
      status: input.status ?? "active",
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      updatedAt: heartbeatAt,
    })
    .where(and(
      eq(executionTargets.id, input.targetId),
      input.organizationId
        ? eq(executionTargets.organizationId, input.organizationId)
        : isNotNull(executionTargets.organizationId),
      ne(executionTargets.status, "disabled"),
    ))
    .returning({ id: executionTargets.id });
  return { updated: rows.length };
}

/**
 * List execution targets an org ADMIN may see/manage: ONLY the org's own rows.
 *
 * SECURITY (P5 review, finding #1): this list must NOT include system/shared rows
 * (organizationId = NULL — the seeded control-plane target + operator-registered
 * pool targets). The row id is NO LONGER a credential — worker auth is by the
 * SHA-256 worker_token_hash (resolveWorkerTargetId/requireWorkerToken,
 * routes/execution-targets.ts:22-27) — but a system/operator-owned row still must
 * not be returned to a tenant admin: the row id is the sole selector for
 * registerWorkerHeartbeat, so leaking a system row's id lets a tenant admin
 * mutate/offline an operator-owned target they do not own (cross-tenant DoS).
 * The run-routing read path (execution-target-resolver.ts
 * resolveExecutionTargetForRun) reads system rows SEPARATELY and never exposes
 * their ids to a caller, so routing to the shared pool is unaffected.
 */
/**
 * DSK-001 Lane D (D17) — the org's enrolled desktop devices, redacted.
 *
 * Built from the org's OWN targets outward: the WHERE clause pins
 * `execution_targets.organization_id` first, and `workers` is reached only through that
 * join. D17 calls that construction safe where a generic worker join is not, and F31 is
 * why — the redacted `WorkerSummary` allowlist had to drop `executionTargetId`, so a
 * worker-first query has no safe way back to the owning org.
 *
 * DEVIATION FROM D17, recorded rather than taken quietly: the design says "inside
 * `runInTenant`". That is NOT implementable as written. `runInTenant` opens as the
 * non-owner `aoa_app` role, whose grant on `execution_targets` is COLUMN-level and covers
 * only id / organization_id / owner_user_id / scope / target_authority_key / status /
 * device_generation / capabilities (`APP_ENROLLMENT_TARGET_SELECT_COLUMNS`). Neither
 * `kind` nor `slug` is readable there — so the `kind = 'desktop'` filter the design
 * specifies could not run, and `targetSlug` could not be emitted.
 *
 * This uses the owner pool with SQL scoping, exactly like `listExecutionTargets` below,
 * whose own comment defends the pattern: "the no-system/cross-org guarantee is the WHERE
 * clause, not a JS post-filter". Every sibling route in this router already reads that
 * way, so introducing a second access pattern for one listing would be the inconsistency,
 * not the safety.
 *
 * If RLS defence-in-depth is wanted later, the shape is to add `slug` and `kind` to
 * `APP_ENROLLMENT_TARGET_SELECT_COLUMNS` — both are non-sensitive — and move the query.
 * That is a security-manifest change with its own surfaces, so it is a deliberate
 * follow-up rather than something to slip into a listing.
 */
export async function listDesktopDevices(db: Db, organizationId: string | null) {
  // A null org sees nothing, and must not even scan — same rule as the sibling below.
  if (organizationId == null) return [];
  // E11 M2 — `dbNow` is `clock_timestamp()` selected alongside the rows so liveness is
  // classified against the DATABASE clock, never the app's `Date.now()`. `lastSeenAt` is a
  // DB timestamp; comparing it to a DB-sourced `now` keeps the verdict skew-free, the same
  // discipline SVC-003b's sweep uses.
  const deadlineMs = resolveDeviceLivenessDeadlineMs();
  const rows = await db
    .select({
      deviceId: workers.id,
      targetSlug: executionTargets.slug,
      label: workers.label,
      status: workers.status,
      deviceGeneration: workers.deviceGeneration,
      enrolledAt: workers.enrolledAt,
      lastSeenAt: workers.lastSeenAt,
      dbNow: sql<Date>`clock_timestamp()`,
    })
    .from(executionTargets)
    .innerJoin(workers, eq(workers.executionTargetId, executionTargets.id))
    .where(and(
      eq(executionTargets.organizationId, organizationId),
      eq(executionTargets.kind, "desktop"),
    ));
  // The projection is applied even though the SELECT is already narrow. The select list
  // is an implementation detail a future edit can widen; `projectDesktopDevice` is the
  // allowlist, and routing every row through it is what makes the canary test meaningful.
  // `health` is computed here (not a column) and injected into the row before projection.
  return rows.map((row) => {
    const now = row.dbNow instanceof Date ? row.dbNow : new Date(String(row.dbNow));
    const health = classifyDeviceLiveness({
      lastSeenAt: row.lastSeenAt,
      enrolledAt: row.enrolledAt,
      now,
      deadlineMs,
    });
    return projectDesktopDevice({ ...row, health } as never);
  });
}

/**
 * E11 M2 — VERIFY one enrolled desktop device's enrolment key, org-scoped.
 *
 * Built from the org's OWN targets outward, exactly like `listDesktopDevices` above and for
 * the same F31 reason: a worker-first query has no safe way back to the owning org. The
 * WHERE pins `organization_id` AND `kind = 'desktop'` AND the device id, so an admin of one
 * org cannot reach another org's device — a cross-org lookup simply returns no row, and the
 * route turns that into a 404 (never a 403 that would confirm the device exists elsewhere).
 *
 * Returns `null` when no such device exists under this org; otherwise a read-only
 * re-derivation over the STORED key material (`verifyDeviceEnrolmentKey`). Reads no clock,
 * writes nothing, and the raw key material never leaves this function — only the boolean
 * verdict does.
 */
export async function verifyDesktopDeviceEnrolmentKey(
  db: Db,
  organizationId: string | null,
  deviceId: string,
): Promise<DeviceKeyVerification | null> {
  if (organizationId == null) return null;
  const rows = await db
    .select({
      devicePublicKey: workers.devicePublicKey,
      deviceThumbprint: workers.deviceThumbprint,
    })
    .from(executionTargets)
    .innerJoin(workers, eq(workers.executionTargetId, executionTargets.id))
    .where(and(
      eq(executionTargets.organizationId, organizationId),
      eq(executionTargets.kind, "desktop"),
      eq(workers.id, deviceId),
    ));
  const row = rows[0];
  if (!row) return null;
  return verifyDeviceEnrolmentKey({
    devicePublicKey: row.devicePublicKey,
    deviceThumbprint: row.deviceThumbprint,
  });
}

export async function listExecutionTargets(db: Db, organizationId: string | null) {
  // organizationId is required to see any target; a null org sees nothing — and
  // must not even scan the table (system rows must never surface to a tenant admin;
  // the row id is the sole selector for registerWorkerHeartbeat, not a credential).
  if (organizationId == null) return [];
  // Scope in SQL (index execution_targets_org_idx); the no-system/cross-org
  // guarantee is the WHERE clause, not a JS post-filter.
  return (await db.select().from(executionTargets).where(eq(executionTargets.organizationId, organizationId))).map(
    stripWorkerSecret,
  );
}

// --- WRK-008 slice 1: a worker's own self-model -------------------------------

/**
 * The facts `admitSelfModelRead` needs, plus the payload to serve.
 *
 * `revokedAt` comes from INSIDE the registered profile (the frozen
 * `registeredTargetProfileV1` field), not from a column — revocation is expressed in
 * the server-owned profile, and reading it anywhere else would be a second authority.
 */
export interface WorkerSelfModelRead {
  readonly registeredProfile: Record<string, unknown> | null;
  readonly providerConstraintProfile: Record<string, unknown> | null;
  readonly deviceGeneration: number | null;
  readonly targetStatus: string;
  readonly revokedAt: string | null;
  /**
   * A single version token over BOTH halves, so a worker can ask "has my self-model
   * changed?" in one comparison.
   *
   * Both inputs are already hex digests — the stored `registered_profile_hash` column
   * and the constraint profile's own self-describing `digest` — so this composes them
   * rather than re-hashing payloads. Comparing only the registered hash would miss a
   * constraint-profile change written independently of the registered one.
   */
  readonly selfModelHash: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Load one target's self-model facts. Returns null when the target does not exist —
 * the caller maps that to the SAME coarse refusal as every other denial, so this is
 * never an existence oracle. */
export async function loadWorkerSelfModel(
  db: Db,
  targetId: string,
): Promise<WorkerSelfModelRead | null> {
  const rows = await db
    .select({
      registeredProfile: executionTargets.registeredProfile,
      registeredProfileHash: executionTargets.registeredProfileHash,
      providerConstraintProfile: executionTargets.providerConstraintProfile,
      deviceGeneration: executionTargets.deviceGeneration,
      status: executionTargets.status,
    })
    .from(executionTargets)
    .where(eq(executionTargets.id, targetId));
  const row = rows[0];
  if (!row) return null;

  const registeredProfile = asRecord(row.registeredProfile);
  const providerConstraintProfile = asRecord(row.providerConstraintProfile);
  const constraintDigest = typeof providerConstraintProfile?.digest === "string"
    ? providerConstraintProfile.digest
    : null;
  const revoked = registeredProfile?.revokedAt;

  return {
    registeredProfile,
    providerConstraintProfile,
    deviceGeneration: typeof row.deviceGeneration === "number" ? row.deviceGeneration : null,
    targetStatus: row.status,
    revokedAt: typeof revoked === "string" ? revoked : null,
    selfModelHash: row.registeredProfileHash && constraintDigest
      ? createHash("sha256").update(`${row.registeredProfileHash}:${constraintDigest}`).digest("hex")
      : null,
  };
}
