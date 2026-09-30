import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  configurePlatformTargetAuthorityLockTimeout,
  operatorJobLeasingRepository,
  operatorWorkerEnrollmentRepository,
  workerEnrollmentCodeRoutes,
  type Db,
} from "@armyofagents/db";
import {
  enrollmentRequestV1Schema,
  enrollmentResponseV1Schema,
  type EnrollmentRequestV1,
  type EnrollmentResponseV1,
} from "@armyofagents/worker-protocol";
import { runInTenant } from "../db/tenant-context.js";
import { verifyDeviceProof, type DeviceProofHeaders } from "./worker-device-proof.js";
import { createWorkerSessionToken } from "../middleware/worker-session-auth.js";
import { logger } from "../middleware/logger.js";
import { isUniqueViolation } from "./db-errors.js";

const CODE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 15 * 60_000;

export class WorkerEnrollmentError extends Error {
  constructor(
    public readonly code: "unauthorized" | "malformed" | "target_revoked",
    public readonly auditReasonCode = `worker_enrollment_${code}`,
    public readonly auditIdentifiers?: { workerId: string; executionTargetId: string },
  ) {
    super(code === "malformed" ? "Enrollment request is malformed" : "Enrollment is unauthorized");
    this.name = "WorkerEnrollmentError";
  }
}

interface IssueTenantCodeInput {
  organizationId: string;
  executionTargetId: string;
  scope: "organization" | "owner";
  ownerUserId: string | null;
  createdByPrincipalKind: string;
  createdByPrincipalId: string;
}

interface IssuePlatformCodeInput {
  executionTargetId: string;
  createdByPrincipalKind: string;
  createdByPrincipalId: string;
}

interface EnrollInput {
  code: string;
  request: unknown;
  rawBody: Buffer;
  proof: DeviceProofHeaders;
  method: string;
  path: string;
}

interface StoredEnrollmentResult {
  response: EnrollmentResponseV1;
  session: string;
  auditAction: "consume" | "rotate" | "replay";
}

interface StoredEnrollmentReceipt {
  response: EnrollmentResponseV1;
  auditAction: "consume" | "rotate";
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalDigest(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseCode(rawCode: string): { locatorHash: string; secretHash: string } {
  const match = /^aoa_enr_([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{32,128})$/.exec(rawCode);
  if (!match) throw new WorkerEnrollmentError("unauthorized");
  return { locatorHash: sha256(match[1]!), secretHash: sha256(match[2]!) };
}

function parseRequest(rawBody: Buffer, supplied: unknown): EnrollmentRequestV1 {
  try {
    const parsedJson = JSON.parse(rawBody.toString("utf8")) as unknown;
    const parsed = enrollmentRequestV1Schema.parse(parsedJson);
    if (JSON.stringify(parsedJson) !== JSON.stringify(supplied)) {
      throw new WorkerEnrollmentError("malformed");
    }
    return parsed;
  } catch (error) {
    if (error instanceof WorkerEnrollmentError) throw error;
    throw new WorkerEnrollmentError("malformed");
  }
}

function providerConstraints(capabilities: Record<string, unknown>): unknown {
  return capabilities.providerConstraints;
}

function storedReceipt(value: Record<string, unknown> | null): StoredEnrollmentReceipt {
  if (!value || (value.auditAction !== "consume" && value.auditAction !== "rotate")) {
    throw new WorkerEnrollmentError("unauthorized");
  }
  return {
    response: enrollmentResponseV1Schema.parse(value.response),
    auditAction: value.auditAction,
  };
}

function enrollmentSemanticDigest(input: {
  request: EnrollmentRequestV1;
  deviceThumbprint: string;
  scope: string;
  authoritativeOrganizationId: string | null;
  executionTargetId: string;
}): string {
  return sha256(JSON.stringify({
    protocolVersion: input.request.protocolVersion,
    audience: input.request.audience,
    idempotencyKey: input.request.idempotencyKey,
    hello: input.request.hello,
    deviceThumbprint: input.deviceThumbprint,
    scope: input.scope,
    authoritativeOrganizationId: input.authoritativeOrganizationId,
    executionTargetId: input.executionTargetId,
  }));
}

function sessionScope(value: string): "platform" | "organization" | "owner" {
  if (value !== "platform" && value !== "organization" && value !== "owner") {
    throw new WorkerEnrollmentError("unauthorized");
  }
  return value;
}

export function createWorkerEnrollmentService(input: {
  appDb: Db;
  operatorDb: Db;
  sessionSigningKey: string;
  now?: () => Date;
}) {
  if (Buffer.byteLength(input.sessionSigningKey) < 32) {
    throw new Error("Worker session signing key must be at least 32 bytes");
  }
  const now = input.now ?? (() => new Date());

  const requireCurrentPlatformPhysicalAuthority = async (authorityInput: {
    executionTargetId: string;
    deviceGeneration: number;
    devicePublicKey: string;
    deviceThumbprint: string;
    tenantAuthority?: ReturnType<typeof operatorWorkerEnrollmentRepository>;
  }): Promise<void> => {
    const physical = await input.operatorDb.transaction(async (tx) => {
      await configurePlatformTargetAuthorityLockTimeout(tx as unknown as Db);
      const locked = await operatorJobLeasingRepository(tx as unknown as Db)
        .lockPlatformPhysicalAuthority(authorityInput.executionTargetId, "share");
      if (locked && authorityInput.tenantAuthority) {
        await authorityInput.tenantAuthority.acquirePlatformTargetAuthorityShared(
          authorityInput.executionTargetId,
        );
        const current = await authorityInput.tenantAuthority.findTargetByAuthority({
          executionTargetId: authorityInput.executionTargetId,
          targetAuthorityKey: "platform",
        });
        if (!current || current.deviceGeneration !== authorityInput.deviceGeneration) return null;
      }
      return locked;
    });
    if (!physical || physical.target.status !== "active" ||
        physical.target.scope !== "platform" || physical.target.organizationId !== null ||
        physical.target.deviceGeneration !== authorityInput.deviceGeneration ||
        physical.worker.status === "revoked" || physical.worker.revokedAt !== null ||
        physical.worker.deviceGeneration !== authorityInput.deviceGeneration ||
        physical.worker.devicePublicKey !== authorityInput.devicePublicKey ||
        physical.worker.deviceThumbprint !== authorityInput.deviceThumbprint) {
      throw new WorkerEnrollmentError("unauthorized");
    }
  };

  const acquirePlatformTargetAuthorityExclusive = async (
    authority: ReturnType<typeof operatorWorkerEnrollmentRepository>,
    executionTargetId: string,
  ): Promise<void> => {
    if (!await authority.lockPlatformAuthorityForMutation(executionTargetId)) {
      throw new WorkerEnrollmentError("target_revoked");
    }
  };

  return {
    async issueTenantCode(issue: IssueTenantCodeInput): Promise<{ code: string; expiresAt: string }> {
      if ((issue.scope === "owner") !== Boolean(issue.ownerUserId)) {
        throw new WorkerEnrollmentError("unauthorized");
      }
      const locator = randomBytes(18).toString("base64url");
      const secret = randomBytes(32).toString("base64url");
      const locatorHash = sha256(locator);
      const secretHash = sha256(secret);
      const expiresAt = new Date(now().getTime() + CODE_TTL_MS);
      await runInTenant(input.appDb, issue.organizationId, async (repos) => {
        const target = await repos.workerEnrollment.findActiveTarget({
          executionTargetId: issue.executionTargetId,
          scope: issue.scope,
          ownerUserId: issue.ownerUserId,
        });
        if (!target) throw new WorkerEnrollmentError("unauthorized");
        await repos.workerEnrollment.insertCodeRoute({
          locatorHash,
          candidateOrganizationId: issue.organizationId,
          expiresAt,
        });
        await repos.workerEnrollment.insertCode({
          organizationId: issue.organizationId,
          scope: issue.scope,
          ownerUserId: issue.ownerUserId,
          executionTargetId: target.id,
          targetAuthorityKey: target.targetAuthorityKey,
          locatorHash,
          secretHash,
          expiresAt,
          createdByPrincipalKind: issue.createdByPrincipalKind,
          createdByPrincipalId: issue.createdByPrincipalId,
        });
      });
      return { code: `aoa_enr_${locator}.${secret}`, expiresAt: expiresAt.toISOString() };
    },

    async issuePlatformCode(issue: IssuePlatformCodeInput): Promise<{ code: string; expiresAt: string }> {
      const locator = randomBytes(18).toString("base64url");
      const secret = randomBytes(32).toString("base64url");
      const locatorHash = sha256(locator);
      const secretHash = sha256(secret);
      const expiresAt = new Date(now().getTime() + CODE_TTL_MS);
      await input.operatorDb.transaction(async (tx) => {
        const authority = operatorWorkerEnrollmentRepository(tx as unknown as Db);
        const target = await authority.findActiveTarget({
          executionTargetId: issue.executionTargetId,
          scope: "platform",
          ownerUserId: null,
        });
        if (!target) throw new WorkerEnrollmentError("unauthorized");
        await authority.insertCodeRoute({ locatorHash, candidateOrganizationId: null, expiresAt });
        await authority.insertCode({
          organizationId: null,
          scope: "platform",
          ownerUserId: null,
          executionTargetId: target.id,
          targetAuthorityKey: target.targetAuthorityKey,
          locatorHash,
          secretHash,
          expiresAt,
          createdByPrincipalKind: issue.createdByPrincipalKind,
          createdByPrincipalId: issue.createdByPrincipalId,
        });
      });
      logger.info({
        action: "worker.enrollment_code.issued",
        executionTargetId: issue.executionTargetId,
        scope: "platform",
        principalKind: issue.createdByPrincipalKind,
        principalId: issue.createdByPrincipalId,
        reasonCode: "enrollment_code_issued",
      }, "platform worker enrollment code issued");
      return { code: `aoa_enr_${locator}.${secret}`, expiresAt: expiresAt.toISOString() };
    },

    async enroll(enrollInput: EnrollInput): Promise<StoredEnrollmentResult> {
      const code = parseCode(enrollInput.code);
      const request = parseRequest(enrollInput.rawBody, enrollInput.request);
      const transportBodyDigest = sha256(enrollInput.rawBody);
      let verified;
      try {
        verified = verifyDeviceProof({
          method: enrollInput.method,
          path: enrollInput.path,
          bodyDigest: transportBodyDigest,
          correlationId: request.correlationId,
          proof: enrollInput.proof,
          now: now(),
        });
      } catch {
        throw new WorkerEnrollmentError("unauthorized");
      }

      const [route] = await input.operatorDb.select({
        candidateOrganizationId: workerEnrollmentCodeRoutes.candidateOrganizationId,
        expiresAt: workerEnrollmentCodeRoutes.expiresAt,
      }).from(workerEnrollmentCodeRoutes)
        .where(eq(workerEnrollmentCodeRoutes.locatorHash, code.locatorHash))
        .limit(1);
      if (!route || route.expiresAt.getTime() < now().getTime()) {
        throw new WorkerEnrollmentError("unauthorized");
      }

      const completeEnrollment = async (
        authority: ReturnType<typeof operatorWorkerEnrollmentRepository>,
        authoritativeOrganizationId: string | null,
      ): Promise<StoredEnrollmentResult> => {
        const stored = await authority.lockCode(code.locatorHash);
        if (!stored || !equalDigest(stored.secretHash, code.secretHash)) {
          throw new WorkerEnrollmentError("unauthorized");
        }
        const semanticDigest = enrollmentSemanticDigest({
          request,
          deviceThumbprint: verified.deviceThumbprint,
          scope: stored.scope,
          authoritativeOrganizationId,
          executionTargetId: stored.executionTargetId,
        });
        await authority.cleanupExpiredProofs(now(), 100);
        const proofRecorded = await authority.recordProof({
          organizationId: authoritativeOrganizationId,
          deviceThumbprint: verified.deviceThumbprint,
          proofId: verified.proofId,
          issuedAt: verified.issuedAt,
          expiresAt: new Date(now().getTime() + SESSION_TTL_MS),
        });
        if (!proofRecorded) throw new WorkerEnrollmentError("unauthorized");

        if (stored.consumedAt) {
          if (stored.semanticIdempotencyKey !== request.idempotencyKey) {
            throw new WorkerEnrollmentError("malformed");
          }
          if (!stored.deviceThumbprint || !equalDigest(stored.deviceThumbprint, verified.deviceThumbprint)) {
            throw new WorkerEnrollmentError("unauthorized");
          }
          if (stored.semanticDigest !== semanticDigest) {
            throw new WorkerEnrollmentError("malformed");
          }
          const receipt = storedReceipt(stored.semanticResult);
          if (receipt.response.outcome !== "enrolled") throw new WorkerEnrollmentError("unauthorized");
          const current = await authority.findSessionAuthority({
            workerId: receipt.response.workerId,
            executionTargetId: receipt.response.targetId,
          });
          const requestedProfileHash = sha256(JSON.stringify(request.hello));
          if (!current || current.target.status === "disabled" || current.worker.status === "revoked" ||
              current.worker.revokedAt !== null || !current.ownerMembershipActive ||
              current.worker.organizationId !== authoritativeOrganizationId ||
              current.worker.scope !== stored.scope ||
              current.worker.deviceThumbprint !== verified.deviceThumbprint ||
              current.worker.devicePublicKey !== verified.publicKey ||
              current.worker.profileHash !== requestedProfileHash ||
              current.target.deviceGeneration !== current.worker.deviceGeneration ||
              current.target.deviceGeneration !== receipt.response.deviceGeneration ||
              receipt.response.workerId !== request.hello.workerId ||
              receipt.response.targetId !== request.hello.targetId) {
            throw new WorkerEnrollmentError("target_revoked");
          }
          if (authoritativeOrganizationId !== null && current.target.scope === "platform") {
            await requireCurrentPlatformPhysicalAuthority({
              executionTargetId: current.target.id,
              deviceGeneration: current.target.deviceGeneration,
              devicePublicKey: current.worker.devicePublicKey!,
              deviceThumbprint: current.worker.deviceThumbprint!,
              tenantAuthority: authority,
            });
          }
          const replayedAt = now();
          const replayResponse = enrollmentResponseV1Schema.parse({
            ...receipt.response,
            correlationId: request.correlationId,
            serverTime: replayedAt.toISOString(),
          });
          const replaySession = createWorkerSessionToken(input.sessionSigningKey, {
            aud: "device_session",
            sub: current.worker.id,
            organizationId: authoritativeOrganizationId,
            targetId: current.target.id,
            generation: current.target.deviceGeneration,
            scope: sessionScope(current.worker.scope),
            deviceThumbprint: current.worker.deviceThumbprint,
            profileHash: current.worker.profileHash,
            iat: Math.floor(replayedAt.getTime() / 1000),
            exp: Math.floor((replayedAt.getTime() + SESSION_TTL_MS) / 1000),
          });
          return { response: replayResponse, session: replaySession, auditAction: "replay" };
        }
        if (stored.expiresAt.getTime() < now().getTime()) throw new WorkerEnrollmentError("unauthorized");

        let target = await authority.findTargetByAuthority({
          executionTargetId: stored.executionTargetId,
          targetAuthorityKey: stored.targetAuthorityKey,
        });
        if (!target || request.hello.targetId !== target.id) {
          throw new WorkerEnrollmentError("unauthorized");
        }
        const sharedPlatformProfile = authoritativeOrganizationId !== null && target.scope === "platform";
        if (sharedPlatformProfile) {
          await requireCurrentPlatformPhysicalAuthority({
            executionTargetId: target.id,
            deviceGeneration: target.deviceGeneration,
            devicePublicKey: verified.publicKey,
            deviceThumbprint: verified.deviceThumbprint,
            tenantAuthority: authority,
          });
        } else if (authoritativeOrganizationId === null && target.scope === "platform") {
          await acquirePlatformTargetAuthorityExclusive(authority, target.id);
          target = await authority.findTargetByAuthority({
            executionTargetId: stored.executionTargetId,
            targetAuthorityKey: stored.targetAuthorityKey,
          });
          if (!target) throw new WorkerEnrollmentError("target_revoked");
        }
        const profileHash = sha256(JSON.stringify(request.hello));
        const boundWorker = await authority.findWorkerForBinding({
          scope: stored.scope,
          organizationId: stored.organizationId,
          ownerUserId: stored.ownerUserId,
          executionTargetId: target.id,
        });
        let effectiveGeneration = target.deviceGeneration;
        if (boundWorker) {
          if (boundWorker.id !== request.hello.workerId) {
            throw new WorkerEnrollmentError("unauthorized", "worker_transfer_denied", {
              workerId: request.hello.workerId,
              executionTargetId: target.id,
            });
          }
          if (request.hello.deviceGeneration !== (sharedPlatformProfile
            ? target.deviceGeneration
            : target.deviceGeneration + 1)) throw new WorkerEnrollmentError("unauthorized");
          const advanced = sharedPlatformProfile
            ? target.deviceGeneration
            : await authority.advanceTargetGeneration({
                executionTargetId: target.id,
                expectedGeneration: target.deviceGeneration,
                now: now(),
              });
          if (advanced === null || (!sharedPlatformProfile && advanced !== target.deviceGeneration + 1)) {
            throw new WorkerEnrollmentError("target_revoked");
          }
          const rotated = await authority.rotateWorker({
            id: boundWorker.id,
            expectedGeneration: boundWorker.deviceGeneration,
            nextGeneration: advanced,
            devicePublicKey: verified.publicKey,
            deviceThumbprint: verified.deviceThumbprint,
            profileHash,
            profileSnapshot: request.hello,
            enrolledAt: now(),
          });
          if (!rotated) throw new WorkerEnrollmentError("target_revoked");
          effectiveGeneration = advanced;
        } else {
          if (request.hello.deviceGeneration !== target.deviceGeneration) {
            throw new WorkerEnrollmentError("unauthorized");
          }
          if (await authority.findWorker(request.hello.workerId)) {
            throw new WorkerEnrollmentError("unauthorized", "worker_transfer_denied", {
              workerId: request.hello.workerId,
              executionTargetId: target.id,
            });
          }
          await authority.insertWorker({
            id: request.hello.workerId,
            scope: stored.scope,
            organizationId: stored.organizationId,
            ownerUserId: stored.ownerUserId,
            executionTargetId: target.id,
            targetAuthorityKey: target.targetAuthorityKey,
            devicePublicKey: verified.publicKey,
            deviceThumbprint: verified.deviceThumbprint,
            deviceGeneration: effectiveGeneration,
            profileHash,
            profileSnapshot: request.hello,
            enrolledAt: now(),
            label: `Worker ${request.hello.workerId.slice(0, 8)}`,
            status: "enrolled",
          });
        }

        const response = enrollmentResponseV1Schema.parse({
          protocolVersion: 1,
          correlationId: request.correlationId,
          serverTime: now().toISOString(),
          outcome: "enrolled",
          workerId: request.hello.workerId,
          targetId: target.id,
          deviceGeneration: effectiveGeneration,
          providerConstraints: providerConstraints(target.capabilities),
        });
        const effectiveSessionScope = sessionScope(stored.scope);
        const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
        const session = createWorkerSessionToken(input.sessionSigningKey, {
          aud: "device_session",
          sub: request.hello.workerId,
          organizationId: stored.organizationId,
          targetId: target.id,
          generation: effectiveGeneration,
          scope: effectiveSessionScope,
          deviceThumbprint: verified.deviceThumbprint,
          profileHash,
          iat: Math.floor(now().getTime() / 1000),
          exp: Math.floor(expiresAt.getTime() / 1000),
        });
        const result: StoredEnrollmentResult = {
          response,
          session,
          auditAction: boundWorker ? "rotate" : "consume",
        };
        if (!sharedPlatformProfile) await authority.retireBootstrapCredential(target.id);
        await authority.consumeCode({
          id: stored.id,
          consumedAt: now(),
          semanticIdempotencyKey: request.idempotencyKey,
          semanticDigest,
          deviceThumbprint: verified.deviceThumbprint,
          semanticResult: {
            response: result.response,
            auditAction: result.auditAction,
          },
        });
        return result;
      };
      try {
        if (route.candidateOrganizationId === null) {
          return await input.operatorDb.transaction((tx) =>
            completeEnrollment(operatorWorkerEnrollmentRepository(tx as unknown as Db), null));
        }
        return await runInTenant(input.appDb, route.candidateOrganizationId, (repos) =>
          completeEnrollment(repos.workerEnrollment, route.candidateOrganizationId));
      } catch (error) {
        if (isUniqueViolation(error, "workers_pkey")) {
          throw new WorkerEnrollmentError("unauthorized");
        }
        throw error;
      }
    },
  };
}
