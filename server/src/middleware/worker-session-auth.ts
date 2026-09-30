import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  acquirePlatformTargetAuthorityExclusive,
  configurePlatformTargetAuthorityLockTimeout,
  operatorJobLeasingRepository,
  operatorWorkerEnrollmentRepository,
  type Db,
} from "@armyofagents/db";
import { runInTenant } from "../db/tenant-context.js";
import { registerWorkerHeartbeat } from "../services/execution-targets.js";
import { recordWorkerSessionDenial } from "../services/worker-session-denial-audit.js";
import { verifyDeviceProof, type DeviceProofHeaders } from "../services/worker-device-proof.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Exported for WRK-010: the renewal service binds its TTL to this constant so "the
// ceiling" and "what renewal issues" cannot drift. `export` is the WHOLE of the
// middleware diff — no behaviour change.
export const SESSION_MAX_MS = 15 * 60_000;

export interface WorkerSessionClaims {
  aud: "device_session";
  sub: string;
  organizationId: string | null;
  targetId: string;
  generation: number;
  scope: "platform" | "organization" | "owner";
  deviceThumbprint: string;
  profileHash: string;
  iat: number;
  exp: number;
}

export interface VerifiedTargetPrincipal {
  workerId: string;
  targetId: string;
  targetGeneration: number;
  deviceThumbprint: string;
  profileHash: string;
  expiresAt: string;
  organizationId: string | null;
  scope: WorkerSessionClaims["scope"];
  targetScope: "platform" | "organization" | "owner";
  sharedPlatformAuthority?: {
    physicalWorkerId: string;
    physicalProfileHash: string;
    devicePublicKey: string;
  };
}

export class WorkerSessionError extends Error {
  constructor(public readonly code: "unauthorized" | "target_revoked") {
    super(code === "target_revoked" ? "Worker session target is revoked" : "Worker session is unauthorized");
    this.name = "WorkerSessionError";
  }
}

function fail(): never {
  throw new WorkerSessionError("unauthorized");
}

function assertClaims(value: unknown): WorkerSessionClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const claims = value as Record<string, unknown>;
  const keys = Object.keys(claims).sort().join(",");
  if (keys !== ["aud", "deviceThumbprint", "exp", "generation", "iat", "organizationId", "profileHash", "scope", "sub", "targetId"].sort().join(",")) fail();
  if (claims.aud !== "device_session" || !UUID.test(String(claims.sub)) || !UUID.test(String(claims.targetId)) ||
      (claims.organizationId !== null && !UUID.test(String(claims.organizationId))) ||
      !["platform", "organization", "owner"].includes(String(claims.scope)) ||
      !SHA256_HEX.test(String(claims.deviceThumbprint)) || !SHA256_HEX.test(String(claims.profileHash)) ||
      !Number.isSafeInteger(claims.generation) || Number(claims.generation) < 1 ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) fail();
  if ((claims.scope === "platform") !== (claims.organizationId === null)) fail();
  return claims as unknown as WorkerSessionClaims;
}

function signingInput(header: string, payload: string): string {
  return `${header}.${payload}`;
}

export function createWorkerSessionToken(key: string, claimsInput: WorkerSessionClaims): string {
  if (Buffer.byteLength(key) < 32) throw new Error("Worker session signing key must be at least 32 bytes");
  const claims = assertClaims(claimsInput);
  if ((claims.exp - claims.iat) * 1000 > SESSION_MAX_MS || claims.exp <= claims.iat) fail();
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "worker-session-v1" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", key).update(signingInput(header, payload)).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifyWorkerSessionToken(key: string, token: string, now: Date = new Date()): WorkerSessionClaims {
  try {
    if (Buffer.byteLength(key) < 32) fail();
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) fail();
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as unknown;
    if (JSON.stringify(header) !== JSON.stringify({ alg: "HS256", typ: "JWT", kid: "worker-session-v1" })) fail();
    const expected = createHmac("sha256", key).update(signingInput(headerPart, payloadPart)).digest();
    const actual = Buffer.from(signaturePart, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail();
    const claims = assertClaims(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")));
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (claims.exp <= nowSeconds || claims.iat > nowSeconds + 300 ||
        (claims.exp - claims.iat) * 1000 > SESSION_MAX_MS || claims.exp <= claims.iat) fail();
    return claims;
  } catch (error) {
    if (error instanceof WorkerSessionError) throw error;
    fail();
  }
}

export function createWorkerSessionAuthenticator(input: {
  appDb: Db;
  operatorDb: Db;
  sessionSigningKey: string;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async authenticate(request: {
      authorization: string;
      rawBody: Buffer;
      proof: DeviceProofHeaders;
      method: string;
      path: string;
      correlationId: string;
    }): Promise<VerifiedTargetPrincipal> {
      const match = /^Bearer\s+([^\s]+)$/i.exec(request.authorization.trim());
      if (!match) fail();
      const claims = verifyWorkerSessionToken(input.sessionSigningKey, match[1]!, now());
      let proof;
      try {
        proof = verifyDeviceProof({
          method: request.method,
          path: request.path,
          bodyDigest: createHash("sha256").update(request.rawBody).digest("hex"),
          correlationId: request.correlationId,
          proof: request.proof,
          now: now(),
        });
      } catch {
        fail();
      }
      if (proof.deviceThumbprint !== claims.deviceThumbprint) fail();

      // ★ DE-18 + DE-04, session arm — the capture-then-drain holder for the
      // refusals below that throw INSIDE a transaction (`verifyCurrent`'s
      // current-authority recheck and its post-authority credential recheck).
      // The failing disjuncts are captured where they are in hand and drained on
      // the POOL `appDb` after the transaction promise rejects (never inside the
      // unwinding tx). `recordWorkerSessionDenial` derives the crossing from the
      // conjunct list: authoritative `generation_drift` ⇒ DE-18; every other
      // authority-currency conjunct (target inactive, worker revoked, lost
      // membership, credential/profile drift) ⇒ DE-04's
      // worker-authority-currency arm (register amendment 2026-09-13). See
      // worker-session-denial-audit.ts.
      const sessionDenial: {
        intent: {
          reason: "session_authority_revoked" | "session_credential_drift";
          organizationId: string | null;
          failed: string[];
        } | null;
      } = { intent: null };
      const drainSessionDenial = async (): Promise<void> => {
        const pending = sessionDenial.intent;
        if (!pending) return;
        sessionDenial.intent = null;
        await recordWorkerSessionDenial(input.appDb, {
          reason: pending.reason,
          organizationId: pending.organizationId,
          workerId: claims.sub,
          targetId: claims.targetId,
          targetGeneration: claims.generation,
          deviceThumbprint: claims.deviceThumbprint,
          failed: pending.failed,
          control: "server/src/middleware/worker-session-auth.ts:verifyCurrent",
        });
      };
      const verifyCurrent = async (
        authority: ReturnType<typeof operatorWorkerEnrollmentRepository>,
        authoritativeOrganizationId: string | null,
      ): Promise<VerifiedTargetPrincipal> => {
        await authority.cleanupExpiredProofs(now(), 100);
        const recorded = await authority.recordProof({
          organizationId: authoritativeOrganizationId,
          deviceThumbprint: proof.deviceThumbprint,
          proofId: proof.proofId,
          issuedAt: proof.issuedAt,
          expiresAt: new Date(claims.exp * 1000),
        });
        if (!recorded) fail();
        const current = await authority.findSessionAuthority({
          workerId: claims.sub,
          executionTargetId: claims.targetId,
        });
        if (!current || current.target.status === "disabled" || current.worker.status === "revoked" ||
            current.worker.revokedAt !== null || !current.ownerMembershipActive ||
            current.target.deviceGeneration !== claims.generation || current.worker.deviceGeneration !== claims.generation) {
          // ★ Which disjunct(s) failed, for the audit row only; the wire answer
          // stays the coarse code. Collected here because only this branch
          // holds `current`. Crossing derived at the recorder: generation ⇒
          // DE-18, else ⇒ DE-04 (authority currency).
          sessionDenial.intent = {
            reason: "session_authority_revoked",
            organizationId: authoritativeOrganizationId,
            failed: [
              !current ? "authority_row_missing" : null,
              current?.target.status === "disabled" ? "target_disabled" : null,
              current && (current.worker.status === "revoked" || current.worker.revokedAt !== null)
                ? "worker_revoked" : null,
              current && !current.ownerMembershipActive ? "owner_membership_lost" : null,
              current && (current.target.deviceGeneration !== claims.generation ||
                current.worker.deviceGeneration !== claims.generation) ? "generation_drift" : null,
            ].filter((d): d is string => d !== null),
          };
          throw new WorkerSessionError("target_revoked");
        }
        if (current.worker.organizationId !== authoritativeOrganizationId || current.worker.scope !== claims.scope ||
            current.worker.deviceThumbprint !== claims.deviceThumbprint ||
            current.worker.devicePublicKey !== proof.publicKey || current.worker.profileHash !== claims.profileHash) {
          // ★ DE-04, worker-authority-currency arm — the post-authority
          // credential recheck. Never a generation conjunct here (the branch
          // above owns generation), so the derived crossing is always DE-04.
          sessionDenial.intent = {
            reason: "session_credential_drift",
            organizationId: authoritativeOrganizationId,
            failed: [
              current.worker.organizationId !== authoritativeOrganizationId ? "worker_org_mismatch" : null,
              current.worker.scope !== claims.scope ? "worker_scope_mismatch" : null,
              current.worker.deviceThumbprint !== claims.deviceThumbprint ? "thumbprint_mismatch" : null,
              current.worker.devicePublicKey !== proof.publicKey ? "pubkey_mismatch" : null,
              current.worker.profileHash !== claims.profileHash ? "profile_hash_mismatch" : null,
            ].filter((d): d is string => d !== null),
          };
          fail();
        }
        return {
          workerId: claims.sub,
          targetId: claims.targetId,
          targetGeneration: claims.generation,
          deviceThumbprint: claims.deviceThumbprint,
          profileHash: claims.profileHash,
          expiresAt: new Date(claims.exp * 1000).toISOString(),
          organizationId: authoritativeOrganizationId,
          scope: claims.scope,
          targetScope: current.target.scope as "platform" | "organization" | "owner",
        };
      };
      if (claims.organizationId === null) {
        try {
          return await input.operatorDb.transaction((tx) =>
            verifyCurrent(operatorWorkerEnrollmentRepository(tx as unknown as Db), null));
        } catch (err) {
          // The operator transaction has unwound; drain on the pool handle and
          // rethrow unchanged (a platform-scope refusal is the DOUBLY-NULL row).
          await drainSessionDenial();
          throw err;
        }
      }
      let principal: VerifiedTargetPrincipal;
      try {
        principal = await runInTenant(input.appDb, claims.organizationId, (repos) =>
          verifyCurrent(repos.workerEnrollment, claims.organizationId));
      } catch (err) {
        await drainSessionDenial();
        throw err;
      }
      if (principal.targetScope === "platform") {
        const physical = await input.operatorDb.transaction((tx) =>
          operatorWorkerEnrollmentRepository(tx as unknown as Db)
            .findPlatformPhysicalAuthority(principal.targetId));
        if (!physical || physical.target.status !== "active" ||
            physical.target.deviceGeneration !== principal.targetGeneration ||
            physical.worker.status === "revoked" || physical.worker.revokedAt !== null ||
            physical.worker.deviceGeneration !== principal.targetGeneration ||
            physical.worker.deviceThumbprint !== principal.deviceThumbprint ||
            physical.worker.devicePublicKey !== proof.publicKey || !physical.worker.profileHash) {
          // ★ Name the enforcing predicate(s) of the physical-recheck failure
          // (Codex P2 on PR #448). The crossing is derived from the conjuncts:
          // a `generation_drift` failure is a DE-18 generation cutoff; every
          // non-generation failure (target inactive, worker revoked,
          // credential/profile drift) is a DE-04 worker-authority-currency row
          // (register amendment 2026-09-13 — the follow-on PR #448 documented).
          const failed: string[] = [
            !physical ? "physical_authority_missing" : null,
            physical && physical.target.status !== "active" ? "target_inactive" : null,
            physical && (physical.target.deviceGeneration !== principal.targetGeneration
              || physical.worker.deviceGeneration !== principal.targetGeneration) ? "generation_drift" : null,
            physical && (physical.worker.status === "revoked" || physical.worker.revokedAt !== null)
              ? "worker_revoked" : null,
            physical && physical.worker.deviceThumbprint !== principal.deviceThumbprint
              ? "thumbprint_mismatch" : null,
            physical && physical.worker.devicePublicKey !== proof.publicKey ? "pubkey_mismatch" : null,
            physical && !physical.worker.profileHash ? "profile_hash_missing" : null,
          ].filter((d): d is string => d !== null);
          // No transaction in flight here (the operator tx above has resolved), so
          // the row is written directly on the pool handle before the throw; the
          // recorder never throws and derives the crossing from `failed`.
          await recordWorkerSessionDenial(input.appDb, {
            reason: "platform_authority_revoked",
            organizationId: claims.organizationId,
            workerId: claims.sub,
            targetId: claims.targetId,
            targetGeneration: claims.generation,
            deviceThumbprint: claims.deviceThumbprint,
            failed,
            control: "server/src/middleware/worker-session-auth.ts:authenticate",
          });
          throw new WorkerSessionError("target_revoked");
        }
        return {
          ...principal,
          sharedPlatformAuthority: {
            physicalWorkerId: physical.worker.id,
            physicalProfileHash: physical.worker.profileHash,
            devicePublicKey: proof.publicKey,
          },
        };
      }
      return principal;
    },
  };
}

async function heartbeatPlatformPhysicalLivenessOnly(input: {
  operatorDb: Db;
  principal: VerifiedTargetPrincipal;
  now: Date;
}): Promise<boolean> {
  return input.operatorDb.transaction((tx) =>
    operatorWorkerEnrollmentRepository(tx as unknown as Db)
      .heartbeatPlatformPhysicalLivenessOnly({
        executionTargetId: input.principal.targetId,
        deviceGeneration: input.principal.targetGeneration,
        physicalWorkerId: input.principal.workerId,
        physicalProfileHash: input.principal.profileHash,
        deviceThumbprint: input.principal.deviceThumbprint,
        now: input.now,
      }));
}

async function transitionPlatformPhysicalStatus(input: {
  operatorDb: Db;
  principal: VerifiedTargetPrincipal;
  status: "draining" | "offline";
  now: Date;
}): Promise<boolean> {
  return input.operatorDb.transaction(async (tx) => {
    await configurePlatformTargetAuthorityLockTimeout(tx as unknown as Db);
    const current = await operatorJobLeasingRepository(tx as unknown as Db)
      .lockPlatformPhysicalAuthority(input.principal.targetId, "update");
    if (!current || current.target.status !== "active" ||
        current.target.deviceGeneration !== input.principal.targetGeneration ||
        current.worker.id !== input.principal.workerId ||
        current.worker.status === "revoked" || current.worker.revokedAt !== null ||
        current.worker.deviceGeneration !== input.principal.targetGeneration ||
        current.worker.deviceThumbprint !== input.principal.deviceThumbprint ||
        current.worker.profileHash !== input.principal.profileHash) return false;
    await acquirePlatformTargetAuthorityExclusive(tx as unknown as Db, input.principal.targetId);
    const authority = operatorWorkerEnrollmentRepository(tx as unknown as Db);
    const targetCurrent = await authority.heartbeatSessionTarget({
      executionTargetId: input.principal.targetId,
      deviceGeneration: input.principal.targetGeneration,
      status: input.status,
      now: input.now,
    });
    if (!targetCurrent) return false;
    return authority.heartbeatSessionProfile({
      workerId: input.principal.workerId,
      executionTargetId: input.principal.targetId,
      deviceGeneration: input.principal.targetGeneration,
      now: input.now,
    });
  });
}

/** The six `registerProofBoundHeartbeat` refusal branches, named in each audit
 * row's `details.branch` so a reader can tell WHICH boolean write refused. */
export type HeartbeatRefusalBranch =
  | "platform_liveness"
  | "platform_status_transition"
  | "shared_platform"
  | "tenant_target"
  | "tenant_status"
  | "tenant_profile";

/** The authority snapshot the platform classifiers compare — structurally what
 * `findPlatformPhysicalAuthority` returns. */
interface PlatformAuthoritySnapshot {
  worker: {
    id: string;
    status: string;
    revokedAt: Date | null;
    deviceGeneration: number;
    deviceThumbprint: string | null;
    devicePublicKey: string | null;
    profileHash: string | null;
  };
  target: { status: string; deviceGeneration: number };
}

/**
 * ★ DE-18/DE-04, heartbeat arm — the PER-BRANCH GENERATION RE-READ the boolean
 * writes cannot provide (the follow-on PR #448 documented). PURE: mirrors the
 * failing write's OWN predicate over a re-read of the SAME authority row
 * (`findPlatformPhysicalAuthority` — the row the platform-branch predicates
 * subquery), collecting the failed conjunct names. An `expected` field left
 * `undefined` is a conjunct that branch's predicate does NOT enforce and is
 * never checked — the classifier must not invent conjuncts the write never
 * tested. `generation_drift` here is ALWAYS an authoritative DB-row
 * `device_generation` comparison, never a caller payload claim.
 */
export function classifyPlatformHeartbeatRefusal(input: {
  physical: PlatformAuthoritySnapshot | null;
  expected: {
    generation: number;
    workerId: string;
    deviceThumbprint: string;
    profileHash: string | null;
    devicePublicKey?: string;
  };
}): string[] {
  const { physical, expected } = input;
  if (!physical) return ["physical_authority_missing"];
  const failed: string[] = [];
  if (physical.target.status !== "active") failed.push("target_inactive");
  if (physical.target.deviceGeneration !== expected.generation
    || physical.worker.deviceGeneration !== expected.generation) failed.push("generation_drift");
  if (physical.worker.id !== expected.workerId) failed.push("worker_identity_mismatch");
  if (physical.worker.status === "revoked" || physical.worker.revokedAt !== null) failed.push("worker_revoked");
  if (physical.worker.deviceThumbprint !== expected.deviceThumbprint) failed.push("thumbprint_mismatch");
  if (expected.devicePublicKey !== undefined
    && physical.worker.devicePublicKey !== expected.devicePublicKey) failed.push("pubkey_mismatch");
  if (physical.worker.profileHash !== expected.profileHash) failed.push("profile_hash_mismatch");
  return failed;
}

/**
 * The tenant-branch classifier — PURE, per-branch, over a re-read of the SAME
 * authority row the failing write predicates on (`findSessionAuthority`, read
 * INSIDE the same tenant transaction so the snapshot is consistent with the
 * refused write). Each branch checks ONLY the conjuncts its write's predicate
 * enforces (`heartbeatSessionTarget`: target generation + not-disabled;
 * `registerWorkerHeartbeat`: target org + not-disabled;
 * `heartbeatSessionProfile`: worker generation + not-revoked). An EMPTY return
 * means the re-read could not explain the refusal (a lost race between the
 * write and the re-read) — the recorder then writes NOTHING rather than a
 * guess; that transient window is the register's documented residual gap.
 */
export function classifyTenantHeartbeatRefusal(input: {
  branch: "tenant_target" | "tenant_status" | "tenant_profile";
  current: {
    worker: { status: string; revokedAt: Date | null; deviceGeneration: number };
    target: { status: string; deviceGeneration: number; organizationId: string | null };
  } | null;
  expected: { generation: number; organizationId: string };
}): string[] {
  if (!input.current) return ["authority_row_missing"];
  const { worker, target } = input.current;
  const failed: string[] = [];
  if (input.branch === "tenant_target") {
    if (target.status === "disabled") failed.push("target_disabled");
    if (target.deviceGeneration !== input.expected.generation) failed.push("generation_drift");
  } else if (input.branch === "tenant_status") {
    if (target.status === "disabled") failed.push("target_disabled");
    if (target.organizationId !== input.expected.organizationId) failed.push("target_org_mismatch");
  } else {
    if (worker.status === "revoked" || worker.revokedAt !== null) failed.push("worker_revoked");
    if (worker.deviceGeneration !== input.expected.generation) failed.push("generation_drift");
  }
  return failed;
}

export async function registerProofBoundHeartbeat(input: {
  appDb: Db;
  operatorDb?: Db;
  principal: VerifiedTargetPrincipal;
  status: "active" | "draining" | "offline";
  now?: Date;
}): Promise<boolean> {
  const heartbeatAt = input.now ?? new Date();
  // ★ AUDITED (DE-18/DE-04 heartbeat arm — the follow-on PR #448 documented).
  // Each of the SIX refusal branches — mostly NON-throwing `return false` paths
  // the route maps to `unauthorized` — re-reads its authoritative row(s) and
  // classifies WHY via the per-branch classifiers above; the recorder derives
  // the crossing from the conjuncts (authoritative generation drift ⇒ DE-18,
  // any other authority-currency conjunct ⇒ DE-04) and writes nothing when the
  // re-read cannot explain the refusal. Best-effort (the refusal is transient
  // and re-presents on the next heartbeat): the recorder never throws, and the
  // wire answer is unchanged in every branch.
  const recordHeartbeatRefusal = async (branch: HeartbeatRefusalBranch, failed: string[]): Promise<void> => {
    await recordWorkerSessionDenial(input.appDb, {
      reason: "heartbeat_authority_revoked",
      organizationId: input.principal.organizationId,
      workerId: input.principal.workerId,
      targetId: input.principal.targetId,
      targetGeneration: input.principal.targetGeneration,
      deviceThumbprint: input.principal.deviceThumbprint,
      failed,
      branch,
      control: "server/src/middleware/worker-session-auth.ts:registerProofBoundHeartbeat",
    });
  };
  const rereadPlatformAuthority = async (operatorDb: Db): Promise<PlatformAuthoritySnapshot | null> =>
    operatorDb.transaction((tx) =>
      operatorWorkerEnrollmentRepository(tx as unknown as Db)
        .findPlatformPhysicalAuthority(input.principal.targetId));
  if (!input.principal.organizationId) {
    if (!input.operatorDb || input.principal.scope !== "platform") fail();
    const operatorDb = input.operatorDb;
    const branch: HeartbeatRefusalBranch =
      input.status === "active" ? "platform_liveness" : "platform_status_transition";
    const ok = input.status === "active"
      ? await heartbeatPlatformPhysicalLivenessOnly({
          operatorDb,
          principal: input.principal,
          now: heartbeatAt,
        })
      : await transitionPlatformPhysicalStatus({
          operatorDb,
          principal: input.principal,
          status: input.status,
          now: heartbeatAt,
        });
    if (!ok) {
      // Re-read AFTER the refusing transaction has resolved; both platform
      // predicates enforce identity, thumbprint and the principal's profile
      // hash, and neither enforces the public key.
      await recordHeartbeatRefusal(branch, classifyPlatformHeartbeatRefusal({
        physical: await rereadPlatformAuthority(operatorDb),
        expected: {
          generation: input.principal.targetGeneration,
          workerId: input.principal.workerId,
          deviceThumbprint: input.principal.deviceThumbprint,
          profileHash: input.principal.profileHash,
        },
      }));
    }
    return ok;
  }
  if (input.principal.targetScope === "platform") {
    if (!input.operatorDb || !input.principal.sharedPlatformAuthority) fail();
    const operatorDb = input.operatorDb;
    const physical = input.principal.sharedPlatformAuthority;
    const classifySharedRefusal = async (): Promise<string[]> =>
      classifyPlatformHeartbeatRefusal({
        physical: await rereadPlatformAuthority(operatorDb),
        expected: {
          generation: input.principal.targetGeneration,
          workerId: physical.physicalWorkerId,
          deviceThumbprint: input.principal.deviceThumbprint,
          profileHash: physical.physicalProfileHash,
          devicePublicKey: physical.devicePublicKey,
        },
      });
    let ok: boolean;
    try {
      ok = await operatorDb.transaction((tx) =>
        operatorWorkerEnrollmentRepository(tx as unknown as Db).heartbeatSharedPlatformTarget({
          executionTargetId: input.principal.targetId,
          targetAuthorityKey: "platform",
          deviceGeneration: input.principal.targetGeneration,
          physicalWorkerId: physical.physicalWorkerId,
          physicalProfileHash: physical.physicalProfileHash,
          devicePublicKey: physical.devicePublicKey,
          deviceThumbprint: input.principal.deviceThumbprint,
          now: heartbeatAt,
        }));
    } catch (err) {
      // The mid-write authority-changed throw: record on the pool handle after
      // the operator transaction has unwound, rethrow unchanged.
      await recordHeartbeatRefusal("shared_platform", await classifySharedRefusal());
      throw err;
    }
    if (!ok) await recordHeartbeatRefusal("shared_platform", await classifySharedRefusal());
    return ok;
  }
  // Tenant branches: the intent is captured INSIDE the tenant body (where the
  // re-read shares the refused write's transaction snapshot) into a holder
  // prebuilt OUTSIDE it, and drained on the POOL `appDb` in `finally` — after
  // the transaction has committed (the `return false` branches) or unwound (the
  // profile-touch throw). Never written inside the tenant transaction.
  const organizationId = input.principal.organizationId;
  const heartbeatDenial: { intent: { branch: HeartbeatRefusalBranch; failed: string[] } | null } =
    { intent: null };
  try {
    return await runInTenant(input.appDb, organizationId, async (repos, tx) => {
      const rereadTenantAuthority = () => repos.workerEnrollment.findSessionAuthority({
        workerId: input.principal.workerId,
        executionTargetId: input.principal.targetId,
      });
      const expected = { generation: input.principal.targetGeneration, organizationId };
      const targetCurrent = await repos.workerEnrollment.heartbeatSessionTarget({
        executionTargetId: input.principal.targetId,
        deviceGeneration: input.principal.targetGeneration,
        status: input.status,
        now: heartbeatAt,
      });
      if (!targetCurrent) {
        heartbeatDenial.intent = {
          branch: "tenant_target",
          failed: classifyTenantHeartbeatRefusal({
            branch: "tenant_target", current: await rereadTenantAuthority(), expected,
          }),
        };
        return false;
      }
      const statusCurrent = await registerWorkerHeartbeat(tx, {
        targetId: input.principal.targetId,
        organizationId,
        status: input.status,
        now: heartbeatAt,
      });
      if (statusCurrent.updated !== 1) {
        heartbeatDenial.intent = {
          branch: "tenant_status",
          failed: classifyTenantHeartbeatRefusal({
            branch: "tenant_status", current: await rereadTenantAuthority(), expected,
          }),
        };
        return false;
      }
      const profileCurrent = await repos.workerEnrollment.heartbeatSessionProfile({
        workerId: input.principal.workerId,
        executionTargetId: input.principal.targetId,
        deviceGeneration: input.principal.targetGeneration,
        now: heartbeatAt,
      });
      if (!profileCurrent) {
        heartbeatDenial.intent = {
          branch: "tenant_profile",
          failed: classifyTenantHeartbeatRefusal({
            branch: "tenant_profile", current: await rereadTenantAuthority(), expected,
          }),
        };
        throw new WorkerSessionError("target_revoked");
      }
      return true;
    });
  } finally {
    const pending = heartbeatDenial.intent;
    if (pending) {
      heartbeatDenial.intent = null;
      await recordHeartbeatRefusal(pending.branch, pending.failed);
    }
  }
}

export async function revokeTenantWorkerAuthority(input: {
  appDb: Db;
  organizationId: string;
  executionTargetId: string;
  now?: Date;
}): Promise<number | null> {
  return runInTenant(input.appDb, input.organizationId, (repos) =>
    repos.workerEnrollment.revokeTargetAuthority({
      executionTargetId: input.executionTargetId,
      now: input.now ?? new Date(),
    }));
}
