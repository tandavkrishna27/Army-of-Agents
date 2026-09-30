import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, createHash, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import express from "express";
import request from "supertest";
import {
  applyPendingMigrations,
  createDb,
  createOperatorDbConnection,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import { WORKER_CONTROL_HEADERS } from "@armyofagents/shared";
import {
  OPERATION_DESCRIPTORS,
  canonicalProviderConstraintProfileDigestInputV1,
  canonicalizeJsonV1,
  protocolErrorV1Schema,
  type LeaseOfferV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { workerControlRoutes } from "../routes/worker-control.js";
import { executionTargetRoutes } from "../routes/execution-targets.js";
import { rotateExecutionTargetWorkerToken } from "../services/execution-targets.js";
import { logger } from "../middleware/logger.js";
import { errorHandler } from "../middleware/error-handler.js";
import * as executionTargetService from "../services/execution-targets.js";
import { createJobPlacementService } from "../services/job-placement.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG_A = "71000000-0000-4000-8000-000000000001";
const ORG_B = "71000000-0000-4000-8000-000000000002";
const TARGET_A = "72000000-0000-4000-8000-000000000001";
const TARGET_B = "72000000-0000-4000-8000-000000000002";
const TARGET_PLATFORM = "72000000-0000-4000-8000-000000000003";
const TARGET_OWNER = "72000000-0000-4000-8000-000000000004";
const WORKER_A = "73000000-0000-4000-8000-000000000001";
const WORKER_REPLAY = "73000000-0000-4000-8000-000000000002";
const WORKER_UNIFORM = "73000000-0000-4000-8000-000000000003";
const WORKER_PLATFORM = "73000000-0000-4000-8000-000000000004";
const WORKER_OWNER = "73000000-0000-4000-8000-000000000006";
const OWNER_USER = "job-002-owner-user";
const COMPANY_A = "76000000-0000-4000-8000-000000000001";
const COMPANY_B = "76000000-0000-4000-8000-000000000002";
const PASSWORD = "job-002-role-test";
const NOW = new Date(Math.floor(Date.now() / 1_000) * 1_000);

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let admin: Sql | null = null;
let app: NonOwnerDbConnection | null = null;
let operator: NonOwnerDbConnection | null = null;
let ownerDb: ReturnType<typeof createDb> | null = null;
let setupError: unknown = null;
let enrollmentModule: Awaited<ReturnType<typeof loadEnrollmentModule>> = null;
let sessionModule: Awaited<ReturnType<typeof loadSessionModule>> = null;

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) :
        !address || typeof address === "string" ? reject(new Error("port allocation failed")) : resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function loadEnrollmentModule() {
  return import("../services/worker-enrollment.js").catch(() => null);
}

async function loadSessionModule() {
  return import("../middleware/worker-session-auth.js").catch(() => null);
}

function guard() {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
  expect(enrollmentModule, "worker-enrollment module is not implemented").not.toBeNull();
  if (!admin || !app || !operator || !enrollmentModule) throw new Error("test setup incomplete");
  return { admin, appDb: app.db, operatorDb: operator.db, mod: enrollmentModule };
}

function enrollmentBody(workerId = WORKER_A, targetId = TARGET_A, deviceGeneration = 1) {
  return {
    protocolVersion: 1,
    correlationId: "74000000-0000-4000-8000-000000000001",
    issuedAt: NOW.toISOString(),
    nonce: "enrollment-nonce-1",
    audience: "target_enrollment",
    idempotencyKey: "75000000-0000-4000-8000-000000000001",
    hello: {
      protocolVersion: 1,
      workerId,
      targetId,
      deviceGeneration,
      agentVersion: "job-002-test",
      supportedProtocol: { min: 1, max: 1 },
      platform: { os: "windows", arch: "x64", runtime: "desktop" },
      reportedCapabilities: ["workload.batch"],
      capacity: {
        batchSlots: 1, browserSessionSlots: 0, serviceSlots: 0,
        freeCpuMillis: 1000, freeMemoryMiB: 1024, freeDiskMiB: 1024,
      },
      policyHash: "a".repeat(64),
    },
  };
}

function rawBody(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body));
}

function placementProviderProfile(overrides: Partial<ProviderConstraintProfileV1> = {}): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "job-009-tenant",
    version: 1,
    maxContinuousRuntimeSeconds: 3_600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2_000, memoryMiB: 4_096, pids: 512, diskMiB: 8_192 },
    maxConcurrentOperations: 8,
    supportedOperations: [
      "create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup",
    ],
    localityTags: ["transfer_allowed"],
    checkpointMode: "none",
    healthMode: "none",
    ...overrides,
  } as Omit<ProviderConstraintProfileV1, "digest">;
  return {
    ...unsigned,
    digest: createHash("sha256").update(canonicalProviderConstraintProfileDigestInputV1(unsigned)).digest("hex"),
  } as ProviderConstraintProfileV1;
}

function placementRegisteredProfile(input: {
  targetId: string;
  scope: "platform" | "organization";
  provider: ProviderConstraintProfileV1;
}): RegisteredTargetProfileV1 {
  const platform = input.scope === "platform";
  return {
    protocolVersion: 1,
    targetId: input.targetId,
    targetClass: platform ? "managed_cloud" : "organization_dedicated",
    scope: input.scope,
    organizationId: platform ? null : ORG_A,
    ownerPrincipalId: null,
    trustCeiling: platform ? "shared_isolated" : "organization_isolated",
    credentialCeiling: platform ? "platform_brokered" : "organization_brokered",
    dataLocalityCeiling: platform ? "transfer_allowed" : "organization_target_only",
    providerConstraints: {
      profileId: input.provider.profileId,
      version: input.provider.version,
      digest: input.provider.digest,
    },
    capabilityCeiling: ["workload.batch"],
    deviceGeneration: 1,
    revokedAt: null,
    policyHash: "a".repeat(64),
  };
}

function deviceProof(
  body: ReturnType<typeof enrollmentBody>,
  privateKey: KeyObject,
  publicKey: KeyObject,
  proofId: string,
  proofNow: Date = NOW,
) {
  const bytes = rawBody(body);
  const issuedAt = proofNow.toISOString();
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const canonical = [
    "AOA-DEVICE-PROOF-V1", "POST", "/api/worker-control/enroll",
    createHash("sha256").update(bytes).digest("hex"), body.correlationId, issuedAt, proofId,
  ].join("\n");
  return {
    rawBody: bytes,
    proof: {
      version: "1", publicKey: publicKeyDer,
      signature: sign(null, Buffer.from(canonical), privateKey).toString("base64url"),
      issuedAt, proofId,
    },
  };
}

beforeAll(async () => {
  enrollmentModule = await loadEnrollmentModule();
  sessionModule = await loadSessionModule();
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-worker-enrollment-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    const port = await allocatePort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"), user: "test", password: "test", port,
      persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(adminUrl);
    admin = postgres(adminUrl, { max: 1 });
    ownerDb = createDb(adminUrl);
    await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
    await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", PASSWORD));
    app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`));
    operator = createOperatorDbConnection(adminUrl.replace("test:test", `aoa_operator:${PASSWORD}`));
    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${ORG_A}, 'Enrollment A', 'worker-enrollment-a'), (${ORG_B}, 'Enrollment B', 'worker-enrollment-b')`;
    await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
      VALUES
        (${COMPANY_A}, ${ORG_A}, 'Enrollment Placement Company A', 'EPA'),
        (${COMPANY_B}, ${ORG_B}, 'Enrollment Placement Company B', 'EPB')`;
    await admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${OWNER_USER}, 'Owner', 'job-002-owner@example.invalid', true, now(), now())`;
    await admin`INSERT INTO organization_memberships
      (organization_id, user_id, role, status, joined_at)
      VALUES (${ORG_A}, ${OWNER_USER}, 'owner', 'active', now())`;
    await admin`INSERT INTO execution_targets
      (id, organization_id, owner_user_id, slug, kind, trust_class, status, capabilities, config, scope, target_authority_key)
      VALUES
      (${TARGET_A}, ${ORG_A}, NULL, 'target-a', 'dedicated_worker', 'dedicated_tenant', 'active',
        ${{ providerConstraints: { profileId: "desktop-v1", version: 1, digest: "b".repeat(64) } }}, '{}',
        'organization', ${`organization:${ORG_A}`}),
      (${TARGET_B}, ${ORG_B}, NULL, 'target-b', 'dedicated_worker', 'dedicated_tenant', 'active',
        ${{ providerConstraints: { profileId: "desktop-v1", version: 1, digest: "b".repeat(64) } }}, '{}',
        'organization', ${`organization:${ORG_B}`}),
      (${TARGET_PLATFORM}, NULL, NULL, 'target-platform', 'pooled_gvisor', 'shared_multitenant', 'active',
        ${{ providerConstraints: { profileId: "platform-v1", version: 1, digest: "c".repeat(64) } }}, '{}',
        'platform', 'platform'),
      (${TARGET_OWNER}, ${ORG_A}, ${OWNER_USER}, 'target-owner', 'desktop', 'dedicated_tenant', 'active',
        ${{ providerConstraints: { profileId: "owner-v1", version: 1, digest: "d".repeat(64) } }}, '{}',
        'owner', ${`owner:${ORG_A}:${OWNER_USER}`})`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await ownerDb?.$client.end(); } catch { /* ignore */ }
  try { await operator?.close({ timeoutSeconds: 5 }); } catch { /* ignore */ }
  try { await app?.close({ timeoutSeconds: 5 }); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

beforeEach(async () => {
  if (!admin) return;
  await admin.unsafe(`DROP TRIGGER IF EXISTS job002_fail_worker_insert ON workers`);
  await admin.unsafe(`DROP TRIGGER IF EXISTS job002_fail_code_insert ON worker_enrollment_codes`);
  await admin.unsafe(`DROP TRIGGER IF EXISTS job002_fail_code_update ON worker_enrollment_codes`);
  await admin.unsafe(`DROP TRIGGER IF EXISTS job002_fail_proof_insert ON worker_proof_replays`);
  await admin.unsafe(`DROP TRIGGER IF EXISTS job002_hold_platform_heartbeat ON execution_targets`);
  await admin.unsafe(`DROP FUNCTION IF EXISTS job002_fail_insert()`);
  await admin.unsafe(`DROP FUNCTION IF EXISTS job002_hold_platform_heartbeat()`);
  await admin`DELETE FROM worker_operation_receipts`;
  await admin`DELETE FROM leases`;
  await admin`DELETE FROM job_outbox`;
  await admin`DELETE FROM job_attempts`;
  await admin`DELETE FROM jobs`;
  await admin`DELETE FROM worker_proof_replays`;
  await admin`DELETE FROM worker_enrollment_codes`;
  await admin`DELETE FROM worker_enrollment_code_routes`;
  await admin`DELETE FROM workers`;
  await admin`UPDATE execution_targets
    SET device_generation = 1, status = 'active', last_seen_at = NULL,
        registered_profile = NULL, registered_profile_hash = NULL,
        provider_constraint_profile = NULL
    WHERE id IN (${TARGET_A}, ${TARGET_B}, ${TARGET_PLATFORM}, ${TARGET_OWNER})`;
  await admin`UPDATE organization_memberships SET status = 'active' WHERE organization_id = ${ORG_A} AND user_id = ${OWNER_USER}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-002 tenant enrollment transaction",
  () => {
    it("[I-02] ratifies tenant and platform profiles through bounded production authority before enrollment", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      const infoSpy = vi.spyOn(logger, "info");
      const tenantRatify = (executionTargetService as unknown as Record<string, unknown>)
        .ratifyTenantExecutionTargetPlacementProfile;
      const platformRatify = (executionTargetService as unknown as Record<string, unknown>)
        .ratifyPlatformExecutionTargetPlacementProfile;
      expect(typeof tenantRatify, "tenant registry profile writer must exist").toBe("function");
      expect(typeof platformRatify, "platform registry profile writer must exist").toBe("function");
      if (typeof tenantRatify !== "function" || typeof platformRatify !== "function") return;

      const provider = placementProviderProfile();
      const tenantProfile = placementRegisteredProfile({ targetId: TARGET_A, scope: "organization", provider });
      const platformProfile = placementRegisteredProfile({ targetId: TARGET_PLATFORM, scope: "platform", provider });
      const tenant = await (tenantRatify as (input: unknown) => Promise<Record<string, unknown>>)({
        appDb,
        organizationId: ORG_A,
        executionTargetId: TARGET_A,
        registeredProfile: tenantProfile,
        providerConstraintProfile: provider,
      });
      expect(tenant).toMatchObject({
        id: TARGET_A,
        registeredProfileHash: createHash("sha256").update(canonicalizeJsonV1(tenantProfile)).digest("hex"),
      });
      const platform = await (platformRatify as (input: unknown) => Promise<Record<string, unknown>>)({
        operatorDb,
        executionTargetId: TARGET_PLATFORM,
        registeredProfile: platformProfile,
        providerConstraintProfile: provider,
      });
      expect(platform).toMatchObject({ id: TARGET_PLATFORM });

      await expect((tenantRatify as (input: unknown) => Promise<unknown>)({
        appDb, organizationId: ORG_A, executionTargetId: TARGET_B,
        registeredProfile: tenantProfile, providerConstraintProfile: provider,
      })).rejects.toThrow();
      await expect((platformRatify as (input: unknown) => Promise<unknown>)({
        operatorDb, executionTargetId: TARGET_A,
        registeredProfile: tenantProfile, providerConstraintProfile: provider,
      })).rejects.toThrow();
      await expect((tenantRatify as (input: unknown) => Promise<unknown>)({
        appDb, organizationId: ORG_A, executionTargetId: TARGET_A,
        registeredProfile: tenantProfile,
        providerConstraintProfile: { ...provider, digest: "f".repeat(64) },
      })).rejects.toThrow();
      await expect((tenantRatify as (input: unknown) => Promise<unknown>)({
        appDb, organizationId: ORG_A, executionTargetId: TARGET_A,
        registeredProfile: { ...tenantProfile, revokedAt: NOW.toISOString() },
        providerConstraintProfile: provider,
      })).rejects.toThrow();

      const httpApp = express();
      httpApp.use(express.json());
      httpApp.use((req, _res, next) => {
        const authority = req.header("x-job009-test-authority");
        req.actor = authority === "tenant-admin"
          ? {
              type: "board",
              source: "session",
              userId: OWNER_USER,
              organizationIds: [ORG_A],
              companyIds: [COMPANY_A],
            }
          : authority === "platform-operator"
            ? {
                type: "board",
                source: "session",
                userId: OWNER_USER,
                operator: true,
              }
            : {
                type: "agent",
                source: "agent_api_key",
                companyId: COMPANY_A,
              };
        next();
      });
      httpApp.use("/api", executionTargetRoutes({
        db: ownerDb!,
        workerSession: {
          appDb, operatorDb,
          sessionSigningKey: "test-signing-key-at-least-32-bytes",
          now: () => NOW,
        },
      }));
      httpApp.use(errorHandler);
      await request(httpApp)
        .put(`/api/organizations/${ORG_A}/execution-targets/${TARGET_A}/placement-profile`)
        .send({ registeredProfile: tenantProfile, providerConstraintProfile: provider })
        .expect(403);
      await request(httpApp)
        .put(`/api/operator/execution-targets/${TARGET_PLATFORM}/placement-profile`)
        .send({ registeredProfile: platformProfile, providerConstraintProfile: provider })
        .expect(403);
      const tenantHttp = await request(httpApp)
        .put(`/api/organizations/${ORG_A}/execution-targets/${TARGET_A}/placement-profile`)
        .set("x-job009-test-authority", "tenant-admin")
        .send({ registeredProfile: tenantProfile, providerConstraintProfile: provider })
        .expect(200);
      expect(tenantHttp.body).toMatchObject({
        id: TARGET_A,
        registeredProfileHash: createHash("sha256").update(canonicalizeJsonV1(tenantProfile)).digest("hex"),
      });
      const platformHttp = await request(httpApp)
        .put(`/api/operator/execution-targets/${TARGET_PLATFORM}/placement-profile`)
        .set("x-job009-test-authority", "platform-operator")
        .send({ registeredProfile: platformProfile, providerConstraintProfile: provider })
        .expect(200);
      expect(platformHttp.body).toMatchObject({ id: TARGET_PLATFORM });
      expect(JSON.stringify([tenantHttp.body, platformHttp.body])).not.toMatch(/secret|token|private/i);

      const enrollment = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const issued = await enrollment.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: OWNER_USER,
      });
      const keys = generateKeyPairSync("ed25519");
      const body = enrollmentBody(WORKER_A);
      const enrolled = await enrollment.enroll({
        code: issued.code, request: body,
        ...deviceProof(body, keys.privateKey, keys.publicKey, "proof-profile-authority"),
        method: "POST", path: "/api/worker-control/enroll",
      });
      expect(enrolled.response).toMatchObject({ outcome: "enrolled", targetId: TARGET_A });
      const platformIssued = await enrollment.issuePlatformCode({
        executionTargetId: TARGET_PLATFORM,
        createdByPrincipalKind: "operator",
        createdByPrincipalId: "platform-operator",
      });
      const platformKeys = generateKeyPairSync("ed25519");
      const platformBody = {
        ...enrollmentBody(WORKER_PLATFORM, TARGET_PLATFORM),
        correlationId: "74000000-0000-4000-8000-000000000009",
        nonce: "platform-placement-enrollment",
        idempotencyKey: "75000000-0000-4000-8000-000000000009",
      };
      const platformEnrolled = await enrollment.enroll({
        code: platformIssued.code,
        request: platformBody,
        ...deviceProof(
          platformBody,
          platformKeys.privateKey,
          platformKeys.publicKey,
          "proof-platform-profile-authority",
        ),
        method: "POST",
        path: "/api/worker-control/enroll",
      });
      expect(platformEnrolled.response).toMatchObject({ outcome: "enrolled", targetId: TARGET_PLATFORM });

      if (!sessionModule) throw new Error("worker-session-auth module unavailable");
      const authenticator = sessionModule.createWorkerSessionAuthenticator({
        appDb, operatorDb,
        sessionSigningKey: "test-signing-key-at-least-32-bytes",
        now: () => NOW,
      });
      const heartbeat = async (input: {
        session: string;
        keys: ReturnType<typeof generateKeyPairSync>;
        correlationId: string;
        proofId: string;
      }) => {
        const body = Buffer.from(JSON.stringify({ status: "active" }));
        const principal = await authenticator.authenticate({
          authorization: `Bearer ${input.session}`,
          rawBody: body,
          proof: deviceProofFor(
            body,
            input.correlationId,
            input.keys.privateKey,
            input.keys.publicKey,
            input.proofId,
            "/api/execution-targets/heartbeat",
          ),
          method: "POST",
          path: "/api/execution-targets/heartbeat",
          correlationId: input.correlationId,
        });
        await expect(sessionModule!.registerProofBoundHeartbeat({
          appDb, operatorDb, principal, status: "active", now: NOW,
        })).resolves.toBe(true);
      };
      await heartbeat({
        session: enrolled.session,
        keys,
        correlationId: "74000000-0000-4000-8000-000000000010",
        proofId: "proof-tenant-profile-heartbeat",
      });
      await heartbeat({
        session: platformEnrolled.session,
        keys: platformKeys,
        correlationId: "74000000-0000-4000-8000-000000000011",
        proofId: "proof-platform-profile-heartbeat",
      });

      const placementJobs = [
        {
          jobId: "78000000-0000-4000-8000-000000000001",
          attemptId: "79000000-0000-4000-8000-000000000001",
          targetId: TARGET_A,
          expectedClass: "organization_dedicated",
        },
        {
          jobId: "78000000-0000-4000-8000-000000000002",
          attemptId: "79000000-0000-4000-8000-000000000002",
          targetId: null,
          expectedClass: "managed_cloud",
        },
      ] as const;
      for (const row of placementJobs) {
        await admin`INSERT INTO jobs
          (id, organization_id, company_id, workload_type, input_hash, policy_hash,
           requirements, placement_request, status)
          VALUES (${row.jobId}, ${ORG_A}, ${COMPANY_A}, 'batch', ${"b".repeat(64)}, ${"a".repeat(64)},
            ${{ workloadType: "batch", requiredCapabilities: [] }},
            ${{ policyId: "job-submission-default", policyVersion: 1, requestedTarget: null }},
            'queued')`;
        await admin`INSERT INTO job_attempts
          (id, organization_id, company_id, job_id, attempt_number, status)
          VALUES (${row.attemptId}, ${ORG_A}, ${COMPANY_A}, ${row.jobId}, 1, 'pending')`;
        const placement = createJobPlacementService({
          appDb, operatorDb,
          deploymentMode: "local_trusted",
          deploymentEnabled: true,
          resolveOrganizationPolicy: () => ({ enabled: true, mode: "active" }),
          resolveWorkloadPolicy: () => true,
          resolveCredentialBinding: () => ({
            credentialId: "credential-profile-authority",
            credentialKind: "company_api_key",
            executionTargetSlug: null,
            pinnedTargetId: row.targetId,
          }),
        });
        const placementResult = await placement.place({
          organizationId: ORG_A,
          companyId: COMPANY_A,
          jobId: row.jobId,
          attemptId: row.attemptId,
          now: NOW,
          maxHeartbeatAgeMs: 30_000,
        });
        expect(placementResult, JSON.stringify(placementResult)).toMatchObject({
          disposition: "selected",
          targetClass: row.expectedClass,
          leaseEligible: true,
        });
      }
      const [stored] = await admin<{
        registered_profile_hash: string;
        provider_constraint_profile: Record<string, unknown>;
      }[]>`SELECT registered_profile_hash, provider_constraint_profile
          FROM execution_targets WHERE id = ${TARGET_A}`;
      expect(stored?.registered_profile_hash).toBe(
        createHash("sha256").update(canonicalizeJsonV1(tenantProfile)).digest("hex"),
      );
      expect(stored?.provider_constraint_profile).toEqual(provider);
      expect(JSON.stringify(stored)).not.toMatch(/secret|token|private/i);
      expect(platformIssued.code).not.toBe(JSON.stringify(stored));
      expect(platformEnrolled.session).not.toBe(JSON.stringify(stored));
      const logged = JSON.stringify(infoSpy.mock.calls);
      for (const secret of [issued.code, enrolled.session, platformIssued.code, platformEnrolled.session]) {
        expect(logged).not.toContain(secret);
      }
    });

    it("issues a raw code once and atomically enrolls a device-bound logical profile", async () => {
      const { appDb, operatorDb, mod } = guard();
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const issued = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      expect(issued.code).toMatch(/^aoa_enr_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const body = enrollmentBody(WORKER_A);
      const proof = deviceProof(body, privateKey, publicKey, "proof-enroll-1");
      const result = await service.enroll({
        code: issued.code, request: body, ...proof, method: "POST", path: "/api/worker-control/enroll",
      });
      expect(result.response).toMatchObject({ outcome: "enrolled", workerId: WORKER_A, targetId: TARGET_A, deviceGeneration: 1 });
      expect(result.session).toEqual(expect.any(String));
    });

    it("replays the semantic result only for same key/digest with a fresh proof and rejects proof replay", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const issued = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const keys = generateKeyPairSync("ed25519");
      const body = enrollmentBody(WORKER_REPLAY);
      const firstProof = deviceProof(body, keys.privateKey, keys.publicKey, "proof-replay-1");
      const first = await service.enroll({ code: issued.code, request: body, ...firstProof, method: "POST", path: "/api/worker-control/enroll" });
      const transportRetry = {
        ...body,
        correlationId: "74000000-0000-4000-8000-000000000002",
        issuedAt: "2026-08-10T00:00:01.000Z",
        nonce: "enrollment-nonce-retry",
      };
      const freshProof = deviceProof(transportRetry, keys.privateKey, keys.publicKey, "proof-replay-2");
      const replay = await service.enroll({ code: issued.code, request: transportRetry, ...freshProof, method: "POST", path: "/api/worker-control/enroll" });
      expect(replay.response).toEqual({
        ...first.response,
        correlationId: transportRetry.correlationId,
      });
      expect(replay.auditAction).toBe("replay");
      const [receipt] = await admin`SELECT semantic_result FROM worker_enrollment_codes`;
      expect(receipt.semantic_result).not.toHaveProperty("session");
      await expect(service.enroll({ code: issued.code, request: transportRetry, ...freshProof, method: "POST", path: "/api/worker-control/enroll" }))
        .rejects.toMatchObject({ code: "unauthorized" });
      await admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET_A}`;
      const revokedRetry = {
        ...transportRetry,
        correlationId: "74000000-0000-4000-8000-000000000003",
        issuedAt: "2026-08-10T00:00:02.000Z",
        nonce: "enrollment-nonce-revoked-retry",
      };
      await expect(service.enroll({
        code: issued.code,
        request: revokedRetry,
        ...deviceProof(revokedRetry, keys.privateKey, keys.publicKey, "proof-replay-revoked"),
        method: "POST",
        path: "/api/worker-control/enroll",
      })).rejects.toMatchObject({ code: "target_revoked" });
    });

    it("fails uniformly for expired, wrong-shard, unrelated-key, and changed-digest attempts", async () => {
      const { appDb, operatorDb, mod } = guard();
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const issued = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const keys = generateKeyPairSync("ed25519");
      const body = enrollmentBody(WORKER_UNIFORM);
      await service.enroll({ code: issued.code, request: body, ...deviceProof(body, keys.privateKey, keys.publicKey, "proof-uniform-1"), method: "POST", path: "/api/worker-control/enroll" });
      const changed = {
        ...body,
        hello: { ...body.hello, agentVersion: "job-002-test-changed" },
      };
      await expect(service.enroll({ code: issued.code, request: changed, ...deviceProof(changed, keys.privateKey, keys.publicKey, "proof-uniform-2"), method: "POST", path: "/api/worker-control/enroll" }))
        .rejects.toMatchObject({ code: "malformed" });
      const unrelated = generateKeyPairSync("ed25519");
      await expect(service.enroll({ code: issued.code, request: body, ...deviceProof(body, unrelated.privateKey, unrelated.publicKey, "proof-uniform-3"), method: "POST", path: "/api/worker-control/enroll" }))
        .rejects.toMatchObject({ code: "unauthorized" });
    });

    it("normalizes a foreign global worker UUID collision to the same closed denial as an absent authority", async () => {
      const { appDb, operatorDb, mod } = guard();
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const foreignId = "73000000-0000-4000-8000-000000000097";
      const foreignKeys = generateKeyPairSync("ed25519");
      const foreignBody = {
        ...enrollmentBody(foreignId, TARGET_B),
        idempotencyKey: "75000000-0000-4000-8000-000000000097",
      };
      const foreignCode = await service.issueTenantCode({
        organizationId: ORG_B, executionTargetId: TARGET_B, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-b",
      });
      await service.enroll({
        code: foreignCode.code, request: foreignBody,
        ...deviceProof(foreignBody, foreignKeys.privateKey, foreignKeys.publicKey, "proof-foreign-owner"),
        method: "POST", path: "/api/worker-control/enroll",
      });

      const localKeys = generateKeyPairSync("ed25519");
      const localBody = {
        ...enrollmentBody(foreignId, TARGET_A),
        idempotencyKey: "75000000-0000-4000-8000-000000000098",
      };
      const localCode = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const attempt = (code: string, proofId: string) => service.enroll({
        code, request: localBody,
        ...deviceProof(localBody, localKeys.privateKey, localKeys.publicKey, proofId),
        method: "POST", path: "/api/worker-control/enroll",
      });
      const collision = await attempt(localCode.code, "proof-foreign-collision").catch((error) => error as unknown);
      const absent = await attempt(
        `aoa_enr_${"z".repeat(18)}.${"y".repeat(43)}`,
        "proof-absent-worker-authority",
      ).catch((error) => error as unknown);
      const platformCode = await service.issuePlatformCode({
        executionTargetId: TARGET_PLATFORM,
        createdByPrincipalKind: "operator",
        createdByPrincipalId: "platform-operator",
      });
      const platformBody = {
        ...enrollmentBody(foreignId, TARGET_PLATFORM),
        idempotencyKey: "75000000-0000-4000-8000-000000000099",
      };
      const platformCollision = await service.enroll({
        code: platformCode.code,
        request: platformBody,
        ...deviceProof(platformBody, localKeys.privateKey, localKeys.publicKey, "proof-platform-foreign-collision"),
        method: "POST",
        path: "/api/worker-control/enroll",
      }).catch((error) => error as unknown);
      for (const denied of [collision, absent, platformCollision]) {
        expect(denied).toMatchObject({ name: "WorkerEnrollmentError", code: "unauthorized" });
        expect(JSON.stringify(denied)).not.toMatch(/23505|insert into|query|parameters/i);
      }
    });

    it.each([1, 100, 101, 301])(
      "replaces an expired enrollment-proof collision at cleanup position %i without exceeding the bounded maintenance batch",
      async (collisionPosition) => {
      const { admin, appDb, operatorDb, mod } = guard();
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const keys = generateKeyPairSync("ed25519");
      const body = enrollmentBody(WORKER_A);
      const signed = deviceProof(body, keys.privateKey, keys.publicKey, "proof-enrollment-expired");
      const thumbprint = createHash("sha256")
        .update(keys.publicKey.export({ format: "der", type: "spki" }))
        .digest("hex");
      const expiredRows = Array.from({ length: 320 }, (_, index) => ({
        thumbprint: index === collisionPosition - 1
          ? thumbprint
          : createHash("sha256").update(`expired-${collisionPosition}-${index}`).digest("hex"),
        proofId: index === collisionPosition - 1
          ? signed.proof.proofId
          : `proof-expired-${collisionPosition}-${index}`,
        expiresAt: new Date(NOW.getTime() - 120_000 + index),
      }));
      for (const row of expiredRows) {
        await admin`INSERT INTO worker_proof_replays
          (organization_id, device_thumbprint, proof_id, issued_at, expires_at)
          VALUES (${ORG_A}, ${row.thumbprint}, ${row.proofId}, ${new Date(NOW.getTime() - 180_000)}, ${row.expiresAt})`;
      }
      const issued = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const restartedService = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      await expect(restartedService.enroll({
        code: issued.code, request: body, ...signed,
        method: "POST", path: "/api/worker-control/enroll",
      })).resolves.toMatchObject({ response: { workerId: WORKER_A } });
      const [counts] = await admin`SELECT
        count(*) FILTER (WHERE expires_at <= ${NOW})::int AS expired_count,
        count(*) FILTER (WHERE expires_at > ${NOW})::int AS unexpired_count
        FROM worker_proof_replays`;
      expect(counts).toEqual({
        expired_count: collisionPosition <= 100 ? 220 : 219,
        unexpired_count: 1,
      });

      const unexpiredCode = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const unexpiredBody = {
        ...enrollmentBody(WORKER_A),
        correlationId: "74000000-0000-4000-8000-000000000077",
        idempotencyKey: "75000000-0000-4000-8000-000000000077",
      };
      const unexpiredProof = deviceProof(unexpiredBody, keys.privateKey, keys.publicKey, "proof-enrollment-unexpired");
      await admin`INSERT INTO worker_proof_replays
        (organization_id, device_thumbprint, proof_id, issued_at, expires_at)
        VALUES (${ORG_A}, ${thumbprint}, ${unexpiredProof.proof.proofId}, ${NOW}, ${new Date(NOW.getTime() + 600_000)})`;
      await expect(service.enroll({
        code: unexpiredCode.code, request: unexpiredBody, ...unexpiredProof,
        method: "POST", path: "/api/worker-control/enroll",
      })).rejects.toMatchObject({ code: "unauthorized" });
      expect(await admin`SELECT id FROM worker_proof_replays
        WHERE proof_id = ${unexpiredProof.proof.proofId}`).toHaveLength(1);
      },
      60_000,
    );

    it("lets exactly one replica replace an expired proof collision beyond the cleanup limit", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      const firstService = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const secondService = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const keys = generateKeyPairSync("ed25519");
      const body = enrollmentBody(WORKER_A);
      const signed = deviceProof(body, keys.privateKey, keys.publicKey, "proof-enrollment-concurrent-expired");
      const thumbprint = createHash("sha256")
        .update(keys.publicKey.export({ format: "der", type: "spki" }))
        .digest("hex");
      for (let index = 0; index < 160; index += 1) {
        await admin`INSERT INTO worker_proof_replays
          (organization_id, device_thumbprint, proof_id, issued_at, expires_at)
          VALUES (
            ${ORG_A},
            ${index === 120 ? thumbprint : createHash("sha256").update(`concurrent-expired-${index}`).digest("hex")},
            ${index === 120 ? signed.proof.proofId : `proof-concurrent-expired-${index}`},
            ${new Date(NOW.getTime() - 180_000)},
            ${new Date(NOW.getTime() - 120_000 + index)}
          )`;
      }
      const [firstCode, secondCode] = await Promise.all([
        firstService.issueTenantCode({
          organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
          ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
        }),
        secondService.issueTenantCode({
          organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
          ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
        }),
      ]);
      const results = await Promise.allSettled([
        firstService.enroll({
          code: firstCode.code, request: body, ...signed,
          method: "POST", path: "/api/worker-control/enroll",
        }),
        secondService.enroll({
          code: secondCode.code, request: body, ...signed,
          method: "POST", path: "/api/worker-control/enroll",
        }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await admin`SELECT id FROM worker_proof_replays
        WHERE device_thumbprint = ${thumbprint} AND proof_id = ${signed.proof.proofId}`).toHaveLength(1);
      expect(await admin`SELECT id FROM workers WHERE id = ${WORKER_A}`).toHaveLength(1);
    }, 60_000);

    it("emits only frozen enrollment ProtocolErrorV1 envelopes for malformed, absent, foreign, revoked, and internal failures", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      if (!ownerDb) throw new Error("owner DB unavailable");
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const httpApp = express();
      httpApp.use(express.json({ verify: (req, _res, bytes) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
      } }));
      httpApp.use("/api", workerControlRoutes({
        db: ownerDb,
        appDb,
        operatorDb,
        sessionSigningKey: "test-signing-key-at-least-32-bytes",
        now: () => NOW,
      }));
      httpApp.use(errorHandler);

      const keys = generateKeyPairSync("ed25519");
      const body = enrollmentBody("73000000-0000-4000-8000-000000000094");
      const send = async (code: string, requestBody: ReturnType<typeof enrollmentBody>, proofId: string) => {
        const signed = deviceProof(requestBody, keys.privateKey, keys.publicKey, proofId);
        return request(httpApp)
          .post("/api/worker-control/enroll")
          .set(WORKER_CONTROL_HEADERS.enrollmentCode, code)
          .set(WORKER_CONTROL_HEADERS.proofVersion, signed.proof.version)
          .set(WORKER_CONTROL_HEADERS.publicKey, signed.proof.publicKey)
          .set(WORKER_CONTROL_HEADERS.signature, signed.proof.signature)
          .set(WORKER_CONTROL_HEADERS.issuedAt, signed.proof.issuedAt)
          .set(WORKER_CONTROL_HEADERS.proofId, signed.proof.proofId)
          .send(requestBody);
      };
      const expectProtocolError = (response: request.Response, code: string) => {
        expect(protocolErrorV1Schema.safeParse(response.body)).toMatchObject({ success: true });
        expect(OPERATION_DESCRIPTORS.enrollment.errors).toContain(code);
        expect(response.body).toMatchObject({
          protocolVersion: 1,
          code,
          correlationId: code === "unauthorized" || code === "malformed" ? body.correlationId : expect.anything(),
          serverTime: NOW.toISOString(),
          redaction: "secret",
        });
      };

      const missingProof = await request(httpApp).post("/api/worker-control/enroll").send(body);
      expectProtocolError(missingProof, "unauthorized");

      const malformedCode = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const malformedBody = { ...body, hello: { ...body.hello, workerId: "not-a-worker-uuid" } };
      const malformed = await send(
        malformedCode.code,
        malformedBody as unknown as ReturnType<typeof enrollmentBody>,
        "proof-http-malformed",
      );
      expectProtocolError(malformed, "malformed");

      const absent = await send(
        `aoa_enr_${"z".repeat(18)}.${"y".repeat(43)}`,
        body,
        "proof-http-absent",
      );
      expectProtocolError(absent, "unauthorized");

      const foreignId = body.hello.workerId;
      const foreignBody = {
        ...enrollmentBody(foreignId, TARGET_B),
        idempotencyKey: "75000000-0000-4000-8000-000000000094",
      };
      const foreignCode = await service.issueTenantCode({
        organizationId: ORG_B, executionTargetId: TARGET_B, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-b",
      });
      await service.enroll({
        code: foreignCode.code, request: foreignBody,
        ...deviceProof(foreignBody, keys.privateKey, keys.publicKey, "proof-http-foreign-owner"),
        method: "POST", path: "/api/worker-control/enroll",
      });
      const collisionCode = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const collision = await send(collisionCode.code, body, "proof-http-foreign-collision");
      expectProtocolError(collision, "unauthorized");
      expect(collision.status).toBe(absent.status);
      expect(collision.body).toEqual(absent.body);

      const revokedBody = enrollmentBody("73000000-0000-4000-8000-000000000095");
      const revokedCode = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      await admin`UPDATE execution_targets SET status = 'disabled' WHERE id = ${TARGET_A}`;
      const revoked = await send(revokedCode.code, revokedBody, "proof-http-revoked");
      expectProtocolError(revoked, "unauthorized");

      await admin`UPDATE execution_targets SET status = 'active' WHERE id = ${TARGET_A}`;
      await admin.unsafe(`CREATE FUNCTION job002_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'INSERT INTO workers secret-query-params'; END $$`);
      await admin.unsafe(`CREATE TRIGGER job002_fail_worker_insert BEFORE INSERT ON workers
        FOR EACH ROW EXECUTE FUNCTION job002_fail_insert()`);
      const internalBody = enrollmentBody("73000000-0000-4000-8000-000000000096");
      const internalCode = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const internal = await send(internalCode.code, internalBody, "proof-http-internal");
      expectProtocolError(internal, "internal_unavailable");
      expect(JSON.stringify(internal.body)).not.toMatch(/insert into|secret-query-params|23505|query|parameters/i);
    });

    it("rolls back route issuance and every enrollment fact when a later statement fails", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      await admin.unsafe(`CREATE FUNCTION job002_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'job002 forced insert failure'; END $$`);
      await admin.unsafe(`CREATE TRIGGER job002_fail_code_insert BEFORE INSERT ON worker_enrollment_codes
        FOR EACH ROW EXECUTE FUNCTION job002_fail_insert()`);
      await expect(service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      })).rejects.toBeDefined();
      expect((await admin`SELECT locator_hash FROM worker_enrollment_code_routes`)).toHaveLength(0);
      await admin.unsafe(`DROP TRIGGER job002_fail_code_insert ON worker_enrollment_codes`);

      const issued = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      await admin.unsafe(`CREATE TRIGGER job002_fail_worker_insert BEFORE INSERT ON workers
        FOR EACH ROW EXECUTE FUNCTION job002_fail_insert()`);
      const keys = generateKeyPairSync("ed25519");
      const body = enrollmentBody(WORKER_A);
      const signed = deviceProof(body, keys.privateKey, keys.publicKey, "proof-rollback-1");
      await expect(service.enroll({
        code: issued.code, request: body, ...signed,
        method: "POST", path: "/api/worker-control/enroll",
      })).rejects.toBeDefined();
      const [rolledBack] = await admin`SELECT consumed_at FROM worker_enrollment_codes`;
      expect(rolledBack.consumed_at).toBeNull();
      expect(await admin`SELECT id FROM worker_proof_replays`).toHaveLength(0);
      expect(await admin`SELECT id FROM workers`).toHaveLength(0);
      await admin.unsafe(`DROP TRIGGER job002_fail_worker_insert ON workers`);
      await admin`UPDATE execution_targets SET worker_token_hash = 'job002-bootstrap-hash' WHERE id = ${TARGET_A}`;
      await admin.unsafe(`CREATE TRIGGER job002_fail_code_update BEFORE UPDATE ON worker_enrollment_codes
        FOR EACH ROW EXECUTE FUNCTION job002_fail_insert()`);
      await expect(service.enroll({
        code: issued.code, request: body, ...signed,
        method: "POST", path: "/api/worker-control/enroll",
      })).rejects.toBeDefined();
      expect(await admin`SELECT id FROM worker_proof_replays`).toHaveLength(0);
      expect(await admin`SELECT id FROM workers`).toHaveLength(0);
      const [finalStatementRollback] = await admin`
        SELECT worker_token_hash FROM execution_targets WHERE id = ${TARGET_A}`;
      expect(finalStatementRollback.worker_token_hash).toBe("job002-bootstrap-hash");
      await admin.unsafe(`DROP TRIGGER job002_fail_code_update ON worker_enrollment_codes`);
      await expect(service.enroll({
        code: issued.code, request: body, ...signed,
        method: "POST", path: "/api/worker-control/enroll",
      })).resolves.toMatchObject({ response: { workerId: WORKER_A } });
      const [committed] = await admin`
        SELECT worker_token_hash FROM execution_targets WHERE id = ${TARGET_A}`;
      expect(committed.worker_token_hash).toBeNull();
    });

    it("denies expired and stale-shard routes without consuming authoritative tenant code", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      let clock = NOW;
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => clock,
      });
      const issue = () => service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization" as const,
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const keys = generateKeyPairSync("ed25519");
      const expired = await issue();
      clock = new Date(NOW.getTime() + 11 * 60_000);
      const expiredBody = enrollmentBody(WORKER_A);
      await expect(service.enroll({
        code: expired.code, request: expiredBody,
        ...deviceProof(expiredBody, keys.privateKey, keys.publicKey, "proof-expired-code", clock),
        method: "POST", path: "/api/worker-control/enroll",
      })).rejects.toMatchObject({ code: "unauthorized" });
      let rows = await admin`SELECT consumed_at FROM worker_enrollment_codes`;
      expect(rows[0].consumed_at).toBeNull();

      clock = NOW;
      const stale = await issue();
      const locator = /^aoa_enr_([^.]+)\./.exec(stale.code)![1]!;
      const staleLocatorHash = createHash("sha256").update(locator).digest("hex");
      await admin`UPDATE worker_enrollment_code_routes SET candidate_organization_id = ${ORG_B}
        WHERE locator_hash = ${staleLocatorHash}`;
      const staleBody = { ...enrollmentBody(WORKER_REPLAY), idempotencyKey: "75000000-0000-4000-8000-000000000088" };
      await expect(service.enroll({
        code: stale.code, request: staleBody,
        ...deviceProof(staleBody, keys.privateKey, keys.publicKey, "proof-stale-route"),
        method: "POST", path: "/api/worker-control/enroll",
      })).rejects.toMatchObject({ code: "unauthorized" });
      rows = await admin`SELECT consumed_at FROM worker_enrollment_codes`;
      expect(rows.every((row) => row.consumed_at === null)).toBe(true);
    });

    it("requires fresh device possession and current target generation for a copied session", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      expect(sessionModule, "worker-session-auth module is not implemented").not.toBeNull();
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const issued = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const keys = generateKeyPairSync("ed25519");
      const enrollment = enrollmentBody(WORKER_A);
      const enrolled = await service.enroll({
        code: issued.code, request: enrollment,
        ...deviceProof(enrollment, keys.privateKey, keys.publicKey, "proof-session-enroll"),
        method: "POST", path: "/api/worker-control/enroll",
      });
      const authenticator = sessionModule!.createWorkerSessionAuthenticator({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const heartbeatBytes = Buffer.from(JSON.stringify({ status: "active" }));
      const correlationId = "74000000-0000-4000-8000-000000000099";
      const sessionProof = deviceProofFor(
        heartbeatBytes, correlationId, keys.privateKey, keys.publicKey, "proof-session-1",
        "/api/execution-targets/heartbeat",
      );
      const thumbprint = createHash("sha256")
        .update(keys.publicKey.export({ format: "der", type: "spki" }))
        .digest("hex");
      await admin`INSERT INTO worker_proof_replays
        (organization_id, device_thumbprint, proof_id, issued_at, expires_at)
        VALUES (${ORG_A}, ${thumbprint}, ${sessionProof.proofId}, ${new Date(NOW.getTime() - 60_000)}, ${NOW})`;
      await expect(authenticator.authenticate({
        authorization: `Bearer ${enrolled.session}`,
        rawBody: heartbeatBytes, proof: sessionProof, method: "POST",
        path: "/api/execution-targets/heartbeat", correlationId,
      })).resolves.toMatchObject({ workerId: WORKER_A, targetId: TARGET_A, targetGeneration: 1 });
      const replicaAuthenticator = sessionModule!.createWorkerSessionAuthenticator({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      await expect(replicaAuthenticator.authenticate({
        authorization: `Bearer ${enrolled.session}`,
        rawBody: heartbeatBytes, proof: sessionProof, method: "POST",
        path: "/api/execution-targets/heartbeat", correlationId,
      })).rejects.toMatchObject({ code: "unauthorized" });
      const copied = generateKeyPairSync("ed25519");
      await expect(authenticator.authenticate({
        authorization: `Bearer ${enrolled.session}`,
        rawBody: heartbeatBytes,
        proof: deviceProofFor(heartbeatBytes, correlationId, copied.privateKey, copied.publicKey, "proof-session-2", "/api/execution-targets/heartbeat"),
        method: "POST", path: "/api/execution-targets/heartbeat", correlationId,
      })).rejects.toMatchObject({ code: "unauthorized" });
      const currentClaims = sessionModule!.verifyWorkerSessionToken(
        "test-signing-key-at-least-32-bytes",
        enrolled.session,
        NOW,
      );
      const wrongTargetSession = sessionModule!.createWorkerSessionToken(
        "test-signing-key-at-least-32-bytes",
        { ...currentClaims, targetId: TARGET_B },
      );
      await expect(authenticator.authenticate({
        authorization: `Bearer ${wrongTargetSession}`,
        rawBody: heartbeatBytes,
        proof: deviceProofFor(
          heartbeatBytes,
          correlationId,
          keys.privateKey,
          keys.publicKey,
          "proof-session-wrong-target",
          "/api/execution-targets/heartbeat",
        ),
        method: "POST",
        path: "/api/execution-targets/heartbeat",
        correlationId,
      })).rejects.toMatchObject({ code: "target_revoked" });
      await admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET_A}`;
      await expect(authenticator.authenticate({
        authorization: `Bearer ${enrolled.session}`,
        rawBody: heartbeatBytes,
        proof: deviceProofFor(heartbeatBytes, correlationId, keys.privateKey, keys.publicKey, "proof-session-3", "/api/execution-targets/heartbeat"),
        method: "POST", path: "/api/execution-targets/heartbeat", correlationId,
      })).rejects.toMatchObject({ code: "target_revoked" });
    });

    it("rotates one durable logical profile by incrementing generation and denies transfer/revival", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      expect(sessionModule, "worker-session-auth module is not implemented").not.toBeNull();
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const issue = () => service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization" as const,
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const firstKeys = generateKeyPairSync("ed25519");
      const firstBody = enrollmentBody(WORKER_A);
      const first = await service.enroll({
        code: (await issue()).code, request: firstBody,
        ...deviceProof(firstBody, firstKeys.privateKey, firstKeys.publicKey, "proof-rotate-1"),
        method: "POST", path: "/api/worker-control/enroll",
      });
      expect(first.auditAction).toBe("consume");
      const replacementKeys = generateKeyPairSync("ed25519");
      const replacementBody = {
        ...enrollmentBody(WORKER_A),
        idempotencyKey: "75000000-0000-4000-8000-000000000002",
        hello: { ...enrollmentBody(WORKER_A).hello, deviceGeneration: 2 },
      };
      const replacement = await service.enroll({
        code: (await issue()).code, request: replacementBody,
        ...deviceProof(replacementBody, replacementKeys.privateKey, replacementKeys.publicKey, "proof-rotate-2"),
        method: "POST", path: "/api/worker-control/enroll",
      });
      expect(replacement.auditAction).toBe("rotate");
      expect(replacement.response).toMatchObject({ deviceGeneration: 2, workerId: WORKER_A });
      const [worker] = await admin`SELECT device_generation, device_public_key FROM workers WHERE id = ${WORKER_A}`;
      expect(worker.device_generation).toBe(2);
      expect(worker.device_public_key).toBe(replacementKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"));

      const authenticator = sessionModule!.createWorkerSessionAuthenticator({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const bytes = Buffer.from("{}");
      const correlationId = "74000000-0000-4000-8000-000000000199";
      await expect(authenticator.authenticate({
        authorization: `Bearer ${first.session}`, rawBody: bytes,
        proof: deviceProofFor(bytes, correlationId, firstKeys.privateKey, firstKeys.publicKey, "proof-old-session", "/api/execution-targets/heartbeat"),
        method: "POST", path: "/api/execution-targets/heartbeat", correlationId,
      })).rejects.toMatchObject({ code: "target_revoked" });

      const transferBody = {
        ...enrollmentBody(WORKER_UNIFORM),
        idempotencyKey: "75000000-0000-4000-8000-000000000003",
        hello: { ...enrollmentBody(WORKER_UNIFORM).hello, deviceGeneration: 3 },
      };
      const transferKeys = generateKeyPairSync("ed25519");
      await expect(service.enroll({
        code: (await issue()).code, request: transferBody,
        ...deviceProof(transferBody, transferKeys.privateKey, transferKeys.publicKey, "proof-transfer-denied"),
        method: "POST", path: "/api/worker-control/enroll",
      })).rejects.toMatchObject({
        code: "unauthorized",
        auditReasonCode: "worker_transfer_denied",
        auditIdentifiers: { workerId: WORKER_UNIFORM, executionTargetId: TARGET_A },
      });

      const httpTransfer = await issue();
      const httpTransferProof = deviceProof(
        transferBody,
        transferKeys.privateKey,
        transferKeys.publicKey,
        "proof-transfer-denied-http",
      );
      const httpApp = express();
      httpApp.use(express.json({ verify: (req, _res, bytes) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
      } }));
      httpApp.use("/api", workerControlRoutes({
        db: ownerDb!,
        appDb,
        operatorDb,
        sessionSigningKey: "test-signing-key-at-least-32-bytes",
        now: () => NOW,
      }));
      const warnSpy = vi.spyOn(logger, "warn");
      try {
        const denied = await request(httpApp)
          .post("/api/worker-control/enroll")
          .set(WORKER_CONTROL_HEADERS.enrollmentCode, httpTransfer.code)
          .set(WORKER_CONTROL_HEADERS.proofVersion, httpTransferProof.proof.version)
          .set(WORKER_CONTROL_HEADERS.publicKey, httpTransferProof.proof.publicKey)
          .set(WORKER_CONTROL_HEADERS.signature, httpTransferProof.proof.signature)
          .set(WORKER_CONTROL_HEADERS.issuedAt, httpTransferProof.proof.issuedAt)
          .set(WORKER_CONTROL_HEADERS.proofId, httpTransferProof.proof.proofId)
          .send(transferBody);
        expect(denied.status).toBe(401);
        expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
          action: "worker.enrollment.denied",
          workerId: WORKER_UNIFORM,
          executionTargetId: TARGET_A,
          reasonCode: "worker_transfer_denied",
        }), "worker enrollment denied");
        const auditBytes = JSON.stringify(warnSpy.mock.calls);
        expect(auditBytes).not.toContain(httpTransfer.code);
        expect(auditBytes).not.toContain(httpTransferProof.proof.publicKey);
        expect(auditBytes).not.toContain(httpTransferProof.proof.signature);
      } finally {
        warnSpy.mockRestore();
      }
      const [target] = await admin`SELECT device_generation FROM execution_targets WHERE id = ${TARGET_A}`;
      expect(target.device_generation).toBe(2);
      if (!ownerDb) throw new Error("owner DB unavailable");
      await expect(rotateExecutionTargetWorkerToken(ownerDb, {
        organizationId: ORG_A,
        targetId: TARGET_A,
      })).resolves.toBeNull();
      const revokedGeneration = await sessionModule!.revokeTenantWorkerAuthority({
        appDb,
        organizationId: ORG_A,
        executionTargetId: TARGET_A,
        now: NOW,
      });
      expect(revokedGeneration).toBe(3);
      const [revoked] = await admin`SELECT status, worker_token_hash FROM execution_targets WHERE id = ${TARGET_A}`;
      expect(revoked).toMatchObject({ status: "disabled", worker_token_hash: null });
      const [revokedWorker] = await admin`SELECT status, revoked_at FROM workers WHERE id = ${WORKER_A}`;
      expect(revokedWorker.status).toBe("revoked");
      expect(revokedWorker.revoked_at).not.toBeNull();
    });

    it("uses one operator transaction for platform identity and allows the same key as distinct tenant profiles", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      expect(sessionModule, "worker-session-auth module is not implemented").not.toBeNull();
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const keys = generateKeyPairSync("ed25519");
      const orgWorker = "73000000-0000-4000-8000-000000000005";
      const orgBody = {
        ...enrollmentBody(orgWorker, TARGET_PLATFORM),
        idempotencyKey: "75000000-0000-4000-8000-000000000005",
      };
      await admin`UPDATE execution_targets
        SET worker_token_hash = 'platform-bootstrap-must-be-retired', last_seen_at = NULL
        WHERE id = ${TARGET_PLATFORM}`;
      const orgCode = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_PLATFORM, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      await expect(service.enroll({
        code: orgCode.code, request: orgBody,
        ...deviceProof(orgBody, keys.privateKey, keys.publicKey, "proof-platform-org-unbound"),
        method: "POST", path: "/api/worker-control/enroll",
      })).rejects.toMatchObject({ code: "unauthorized" });
      const [unboundTarget] = await admin`SELECT worker_token_hash FROM execution_targets WHERE id = ${TARGET_PLATFORM}`;
      expect(unboundTarget.worker_token_hash).toBe("platform-bootstrap-must-be-retired");

      const platformBody = enrollmentBody(WORKER_PLATFORM, TARGET_PLATFORM);
      await admin.unsafe(`CREATE FUNCTION job002_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'job002 forced insert failure'; END $$`);
      await admin.unsafe(`CREATE TRIGGER job002_fail_code_insert BEFORE INSERT ON worker_enrollment_codes
        FOR EACH ROW EXECUTE FUNCTION job002_fail_insert()`);
      await expect(service.issuePlatformCode({
        executionTargetId: TARGET_PLATFORM,
        createdByPrincipalKind: "operator",
        createdByPrincipalId: "platform-operator",
      })).rejects.toBeDefined();
      expect(await admin`SELECT locator_hash FROM worker_enrollment_code_routes
        WHERE candidate_organization_id IS NULL`).toHaveLength(0);
      await admin.unsafe(`DROP TRIGGER job002_fail_code_insert ON worker_enrollment_codes`);
      const platformCode = await service.issuePlatformCode({
        executionTargetId: TARGET_PLATFORM,
        createdByPrincipalKind: "operator",
        createdByPrincipalId: "platform-operator",
      });
      await admin.unsafe(`CREATE TRIGGER job002_fail_code_update BEFORE UPDATE ON worker_enrollment_codes
        FOR EACH ROW EXECUTE FUNCTION job002_fail_insert()`);
      await expect(service.enroll({
        code: platformCode.code, request: platformBody,
        ...deviceProof(platformBody, keys.privateKey, keys.publicKey, "proof-platform-1"),
        method: "POST", path: "/api/worker-control/enroll",
      })).rejects.toBeDefined();
      expect(await admin`SELECT id FROM workers WHERE organization_id IS NULL`).toHaveLength(0);
      expect(await admin`SELECT id FROM worker_proof_replays WHERE organization_id IS NULL`).toHaveLength(0);
      const [unconsumedPlatform] = await admin`
        SELECT consumed_at FROM worker_enrollment_codes WHERE organization_id IS NULL`;
      expect(unconsumedPlatform.consumed_at).toBeNull();
      await admin.unsafe(`DROP TRIGGER job002_fail_code_update ON worker_enrollment_codes`);
      const platform = await service.enroll({
        code: platformCode.code, request: platformBody,
        ...deviceProof(platformBody, keys.privateKey, keys.publicKey, "proof-platform-1"),
        method: "POST", path: "/api/worker-control/enroll",
      });
      expect(platform.response).toMatchObject({ workerId: WORKER_PLATFORM, targetId: TARGET_PLATFORM });
      const [boundTarget] = await admin`SELECT worker_token_hash FROM execution_targets WHERE id = ${TARGET_PLATFORM}`;
      expect(boundTarget.worker_token_hash).toBeNull();
      const platformBytes = Buffer.from("{}");
      const platformCorrelation = "74000000-0000-4000-8000-000000000498";
      const platformAuthenticator = sessionModule!.createWorkerSessionAuthenticator({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      await expect(platformAuthenticator.authenticate({
        authorization: `Bearer ${platform.session}`,
        rawBody: platformBytes,
        proof: deviceProofFor(
          platformBytes, platformCorrelation, keys.privateKey, keys.publicKey,
          "proof-platform-session", "/api/execution-targets/heartbeat",
        ),
        method: "POST",
        path: "/api/execution-targets/heartbeat",
        correlationId: platformCorrelation,
      })).resolves.toMatchObject({
        workerId: WORKER_PLATFORM,
        targetId: TARGET_PLATFORM,
        organizationId: null,
        scope: "platform",
      });

      const orgEnrollment = await service.enroll({
        code: orgCode.code, request: orgBody,
        ...deviceProof(orgBody, keys.privateKey, keys.publicKey, "proof-platform-org-bound"),
        method: "POST", path: "/api/worker-control/enroll",
      });
      expect(orgEnrollment).toMatchObject({ response: { workerId: orgWorker, targetId: TARGET_PLATFORM } });

      const [counts] = await admin`SELECT
        count(*) FILTER (WHERE organization_id IS NULL)::int AS platform_count,
        count(*) FILTER (WHERE organization_id = ${ORG_A})::int AS org_count
        FROM workers WHERE execution_target_id = ${TARGET_PLATFORM}`;
      expect(counts).toMatchObject({ platform_count: 1, org_count: 1 });

      const heartbeatBytes = Buffer.from(JSON.stringify({ status: "draining" }));
      const heartbeatCorrelation = "74000000-0000-4000-8000-000000000497";
      const orgPrincipal = await platformAuthenticator.authenticate({
        authorization: `Bearer ${orgEnrollment.session}`,
        rawBody: heartbeatBytes,
        proof: deviceProofFor(
          heartbeatBytes, heartbeatCorrelation, keys.privateKey, keys.publicKey,
          "proof-platform-org-heartbeat", "/api/execution-targets/heartbeat",
        ),
        method: "POST",
        path: "/api/execution-targets/heartbeat",
        correlationId: heartbeatCorrelation,
      });
      const initialHeartbeat = await sessionModule!.registerProofBoundHeartbeat({
        appDb,
        operatorDb,
        principal: orgPrincipal,
        status: "active",
        now: NOW,
      });
      const [initialProfileLiveness] = await admin`SELECT last_seen_at FROM workers WHERE id = ${orgWorker}`;
      const [initialPhysicalLiveness] = await admin`
        SELECT status, last_seen_at FROM execution_targets WHERE id = ${TARGET_PLATFORM}`;

      const waitForOperatorLockOrSettlement = async (operation: Promise<unknown>) => {
        let settled = false;
        void operation.then(() => { settled = true; }, () => { settled = true; });
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const locks = await ownerDb!.$client`SELECT 1
            FROM pg_stat_activity
            WHERE usename = 'aoa_operator' AND wait_event_type = 'Lock'
            LIMIT 1`;
          if (locks.length > 0) return "operator_lock" as const;
          if (settled) return "settled" as const;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return "timeout" as const;
      };

      await admin`UPDATE workers SET last_seen_at = NULL, status = 'active' WHERE id = ${orgWorker}`;
      await admin`UPDATE execution_targets SET last_seen_at = NULL WHERE id = ${TARGET_PLATFORM}`;
      let releaseRevocation!: () => void;
      let markRevocationLocked!: () => void;
      const revocationRelease = new Promise<void>((resolve) => { releaseRevocation = resolve; });
      const revocationLocked = new Promise<void>((resolve) => { markRevocationLocked = resolve; });
      const leadingRevocation = admin.begin(async (tx) => {
        await tx`UPDATE execution_targets
          SET status = 'disabled', device_generation = device_generation + 1
          WHERE id = ${TARGET_PLATFORM}`;
        markRevocationLocked();
        await revocationRelease;
      });
      await revocationLocked;
      const revokeWinsHeartbeat = sessionModule!.registerProofBoundHeartbeat({
        appDb,
        operatorDb,
        principal: orgPrincipal,
        status: "active",
        now: NOW,
      });
      const revokeWinsObservation = await waitForOperatorLockOrSettlement(revokeWinsHeartbeat);
      releaseRevocation();
      await leadingRevocation;
      const revokeWinsResult = await revokeWinsHeartbeat;
      const [revokeWinsProfile] = await admin`SELECT last_seen_at FROM workers WHERE id = ${orgWorker}`;

      await admin`UPDATE execution_targets
        SET status = 'active', device_generation = 1, last_seen_at = NULL
        WHERE id = ${TARGET_PLATFORM}`;
      await admin`UPDATE workers
        SET status = 'active', device_generation = 1, last_seen_at = NULL
        WHERE execution_target_id = ${TARGET_PLATFORM}`;
      await admin.unsafe(`CREATE FUNCTION job002_hold_platform_heartbeat() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(2200202); RETURN NEW; END $$`);
      await admin.unsafe(`CREATE TRIGGER job002_hold_platform_heartbeat
        BEFORE UPDATE OF last_seen_at ON execution_targets
        FOR EACH ROW WHEN (NEW.id = '${TARGET_PLATFORM}'::uuid)
        EXECUTE FUNCTION job002_hold_platform_heartbeat()`);
      let releaseHeartbeatGate!: () => void;
      let markHeartbeatGateLocked!: () => void;
      const heartbeatGateRelease = new Promise<void>((resolve) => { releaseHeartbeatGate = resolve; });
      const heartbeatGateLocked = new Promise<void>((resolve) => { markHeartbeatGateLocked = resolve; });
      const heartbeatGate = ownerDb!.$client.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(2200202)`;
        markHeartbeatGateLocked();
        await heartbeatGateRelease;
      });
      await heartbeatGateLocked;
      const heartbeatWinsHeartbeat = sessionModule!.registerProofBoundHeartbeat({
        appDb,
        operatorDb,
        principal: orgPrincipal,
        status: "active",
        now: NOW,
      });
      const heartbeatWinsObservation = await waitForOperatorLockOrSettlement(heartbeatWinsHeartbeat);
      const trailingRevocation = Promise.resolve(admin`UPDATE execution_targets
        SET status = 'disabled', device_generation = device_generation + 1
        WHERE id = ${TARGET_PLATFORM}`);
      releaseHeartbeatGate();
      await heartbeatGate;
      const heartbeatWinsResult = await heartbeatWinsHeartbeat;
      await trailingRevocation;
      await admin.unsafe(`DROP TRIGGER job002_hold_platform_heartbeat ON execution_targets`);
      await admin.unsafe(`DROP FUNCTION job002_hold_platform_heartbeat()`);
      const [heartbeatWinsProfile] = await admin`SELECT last_seen_at FROM workers WHERE id = ${orgWorker}`;
      const [heartbeatWinsPhysical] = await admin`SELECT status, device_generation, last_seen_at
        FROM execution_targets WHERE id = ${TARGET_PLATFORM}`;
      const oldPrincipalAfterRevocation = await sessionModule!.registerProofBoundHeartbeat({
        appDb,
        operatorDb,
        principal: orgPrincipal,
        status: "active",
        now: NOW,
      });

      expect.soft(initialHeartbeat).toBe(true);
      expect.soft(initialProfileLiveness.last_seen_at).toBeNull();
      expect.soft(initialPhysicalLiveness.status).toBe("active");
      expect.soft(initialPhysicalLiveness.last_seen_at?.toISOString()).toBe(NOW.toISOString());
      expect.soft(revokeWinsObservation).toBe("operator_lock");
      expect.soft(revokeWinsResult).toBe(false);
      expect.soft(revokeWinsProfile.last_seen_at).toBeNull();
      expect.soft(heartbeatWinsObservation).toBe("operator_lock");
      expect.soft(heartbeatWinsResult).toBe(true);
      expect.soft(heartbeatWinsProfile.last_seen_at).toBeNull();
      expect.soft(heartbeatWinsPhysical).toMatchObject({ status: "disabled", device_generation: 2 });
      expect.soft(heartbeatWinsPhysical.last_seen_at?.toISOString()).toBe(NOW.toISOString());
      expect.soft(oldPrincipalAfterRevocation).toBe(false);

      const revokedProof = deviceProofFor(
        heartbeatBytes, heartbeatCorrelation, keys.privateKey, keys.publicKey,
        "proof-platform-org-revoked", "/api/execution-targets/heartbeat",
      );
      await expect(platformAuthenticator.authenticate({
        authorization: `Bearer ${orgEnrollment.session}`,
        rawBody: heartbeatBytes,
        proof: revokedProof,
        method: "POST",
        path: "/api/execution-targets/heartbeat",
        correlationId: heartbeatCorrelation,
      })).rejects.toMatchObject({ code: "target_revoked" });
    });

    it("cannot use a pre-enrollment platform bearer resolution after physical enrollment retires it", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      if (!ownerDb) throw new Error("owner DB unavailable");
      const legacyToken = "aoa_wtk_job003_platform_cutoff";
      const baselineCapabilities = {
        providerConstraints: { profileId: "platform-v1", version: 1, digest: "c".repeat(64) },
      };
      await admin`UPDATE execution_targets SET
        worker_token_hash = ${executionTargetService.hashWorkerToken(legacyToken)},
        status = 'active', capabilities = ${baselineCapabilities}
        WHERE id = ${TARGET_PLATFORM}`;

      try {
        // Model the route's two phases: bearer resolution completes, then the
        // request is paused while enrollment retires the bootstrap token.
        const resolvedBeforeCutoff = await executionTargetService.resolveWorkerTargetId(
          ownerDb,
          legacyToken,
        );
        const enrollment = mod.createWorkerEnrollmentService({
          appDb,
          operatorDb,
          sessionSigningKey: "test-signing-key-at-least-32-bytes",
          now: () => NOW,
        });
        const keys = generateKeyPairSync("ed25519");
        const body = enrollmentBody(WORKER_PLATFORM, TARGET_PLATFORM);
        const code = await enrollment.issuePlatformCode({
          executionTargetId: TARGET_PLATFORM,
          createdByPrincipalKind: "operator",
          createdByPrincipalId: "platform-cutoff-operator",
        });
        await enrollment.enroll({
          code: code.code,
          request: body,
          ...deviceProof(body, keys.privateKey, keys.publicKey, "proof-platform-cutoff-enroll"),
          method: "POST",
          path: "/api/worker-control/enroll",
        });

        const lateHeartbeat = resolvedBeforeCutoff
          ? await executionTargetService.registerWorkerHeartbeat(ownerDb, {
              targetId: resolvedBeforeCutoff,
              status: "draining",
              capabilities: {
                providerConstraints: {
                  profileId: "stale-platform-token",
                  version: 1,
                  digest: "e".repeat(64),
                },
              },
            })
          : { updated: 0 };
        const [target] = await admin<{
          worker_token_hash: string | null;
          status: string;
          capabilities: unknown;
        }[]>`SELECT worker_token_hash, status, capabilities
          FROM execution_targets WHERE id = ${TARGET_PLATFORM}`;
        expect.soft(resolvedBeforeCutoff).toBeNull();
        expect.soft(lateHeartbeat.updated).toBe(0);
        expect.soft(target).toEqual({
          worker_token_hash: null,
          status: "active",
          capabilities: baselineCapabilities,
        });
      } finally {
        await admin`UPDATE execution_targets SET
          worker_token_hash = NULL, status = 'active', capabilities = ${baselineCapabilities}
          WHERE id = ${TARGET_PLATFORM}`;
      }
    });

    it("carries real platform enrollment and physical heartbeat into logical poll and ACK liveness", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      expect(sessionModule, "worker-session-auth module is not implemented").not.toBeNull();
      if (!ownerDb) throw new Error("owner DB unavailable");

      const provider = placementProviderProfile();
      const profile = placementRegisteredProfile({
        targetId: TARGET_PLATFORM,
        scope: "platform",
        provider,
      });
      await executionTargetService.ratifyPlatformExecutionTargetPlacementProfile({
        operatorDb,
        executionTargetId: TARGET_PLATFORM,
        registeredProfile: profile,
        providerConstraintProfile: provider,
      });

      const service = mod.createWorkerEnrollmentService({
        appDb,
        operatorDb,
        sessionSigningKey: "test-signing-key-at-least-32-bytes",
        now: () => NOW,
      });
      const keys = generateKeyPairSync("ed25519");
      const physicalBody = enrollmentBody(WORKER_PLATFORM, TARGET_PLATFORM);
      const physicalCode = await service.issuePlatformCode({
        executionTargetId: TARGET_PLATFORM,
        createdByPrincipalKind: "operator",
        createdByPrincipalId: "platform-liveness-operator",
      });
      const physical = await service.enroll({
        code: physicalCode.code,
        request: physicalBody,
        ...deviceProof(physicalBody, keys.privateKey, keys.publicKey, "proof-platform-liveness-enroll"),
        method: "POST",
        path: "/api/worker-control/enroll",
      });

      const authenticator = sessionModule!.createWorkerSessionAuthenticator({
        appDb,
        operatorDb,
        sessionSigningKey: "test-signing-key-at-least-32-bytes",
        now: () => NOW,
      });
      const heartbeatBody = Buffer.from(JSON.stringify({ status: "active" }));
      const heartbeatCorrelation = "74000000-0000-4000-8000-000000000601";
      const physicalPrincipal = await authenticator.authenticate({
        authorization: `Bearer ${physical.session}`,
        rawBody: heartbeatBody,
        proof: deviceProofFor(
          heartbeatBody,
          heartbeatCorrelation,
          keys.privateKey,
          keys.publicKey,
          "proof-platform-liveness-heartbeat",
          "/api/execution-targets/heartbeat",
        ),
        method: "POST",
        path: "/api/execution-targets/heartbeat",
        correlationId: heartbeatCorrelation,
      });
      await expect(sessionModule!.registerProofBoundHeartbeat({
        appDb,
        operatorDb,
        principal: physicalPrincipal,
        status: "active",
        now: NOW,
      })).resolves.toBe(true);

      const logicalWorker = "73000000-0000-4000-8000-000000000007";
      const logicalBody = {
        ...enrollmentBody(logicalWorker, TARGET_PLATFORM),
        idempotencyKey: "75000000-0000-4000-8000-000000000607",
      };
      const logicalCode = await service.issueTenantCode({
        organizationId: ORG_A,
        executionTargetId: TARGET_PLATFORM,
        scope: "organization",
        ownerUserId: null,
        createdByPrincipalKind: "user",
        createdByPrincipalId: OWNER_USER,
      });
      const logical = await service.enroll({
        code: logicalCode.code,
        request: logicalBody,
        ...deviceProof(logicalBody, keys.privateKey, keys.publicKey, "proof-platform-logical-enroll"),
        method: "POST",
        path: "/api/worker-control/enroll",
      });
      const logicalWorkerB = "73000000-0000-4000-8000-000000000008";
      const logicalBodyB = {
        ...enrollmentBody(logicalWorkerB, TARGET_PLATFORM),
        idempotencyKey: "75000000-0000-4000-8000-000000000608",
      };
      const logicalCodeB = await service.issueTenantCode({
        organizationId: ORG_B,
        executionTargetId: TARGET_PLATFORM,
        scope: "organization",
        ownerUserId: null,
        createdByPrincipalKind: "user",
        createdByPrincipalId: "founder-b",
      });
      const logicalB = await service.enroll({
        code: logicalCodeB.code,
        request: logicalBodyB,
        ...deviceProof(logicalBodyB, keys.privateKey, keys.publicKey, "proof-platform-logical-b-enroll"),
        method: "POST",
        path: "/api/worker-control/enroll",
      });
      const initialLogical = await admin<{ id: string; last_seen_at: Date | null }[]>`
        SELECT id, last_seen_at FROM workers WHERE id IN (${logicalWorker}, ${logicalWorkerB}) ORDER BY id`;
      expect(initialLogical).toEqual([
        { id: logicalWorker, last_seen_at: null },
        { id: logicalWorkerB, last_seen_at: null },
      ]);
      await admin`UPDATE workers SET last_seen_at = ${new Date(NOW.getTime() - 60 * 60_000)}
        WHERE id = ${logicalWorkerB}`;

      const seedPlacedPlatformJob = async (input: {
        ordinal: number;
        organizationId: string;
        companyId: string;
        workerId: string;
      }) => {
        const suffix = input.ordinal.toString().padStart(12, "0");
        const jobId = `77000000-0000-4000-8000-${suffix}`;
        const attemptId = `78000000-0000-4000-8000-${suffix}`;
        await admin`INSERT INTO jobs
          (id, organization_id, company_id, workload_type, source_kind, source_identity,
           source_intent, requester_principal_kind, requester_principal_id,
           executor_principal_kind, executor_principal_id, input, input_hash, policy_snapshot,
           policy_hash, requirements, placement_request, available_at, priority, status)
          VALUES (${jobId}, ${input.organizationId}, ${input.companyId}, 'batch', 'one_shot', ${jobId},
            ${{ kind: "one_shot", operationId: jobId, operationKind: "extraction" }},
            'system', 'platform-liveness-test', 'worker', ${input.workerId},
            ${{ command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds: 600 }},
            ${"8".repeat(64)}, ${{ policyId: "job-submission-default", version: 1 }}, ${"a".repeat(64)},
            ${{ workloadType: "batch", requiredCapabilities: ["workload.batch"] }},
            ${{ policyId: "job-submission-default", policyVersion: 1, requestedTarget: TARGET_PLATFORM }},
            clock_timestamp(), 50, 'queued')`;
        await admin`INSERT INTO job_attempts
          (id, organization_id, company_id, job_id, attempt_number, status,
           placement_disposition, placement_owner, placement_target_id, placement_target_class,
           placement_target_scope, placement_target_generation, placement_profile_hash,
           placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
           placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
           placement_decided_at)
          VALUES (${attemptId}, ${input.organizationId}, ${input.companyId}, ${jobId}, 1, 'pending',
            'selected', 'managed_cloud', ${TARGET_PLATFORM}, 'managed_cloud', 'platform', 1,
            ${createHash("sha256").update(canonicalizeJsonV1(profile)).digest("hex")},
            ${provider.digest}, 'primary', 'target_selected', 'active', true,
            ${"9".repeat(64)}, ${"9".repeat(64)}, clock_timestamp())`;
        return { jobId, attemptId };
      };
      const first = await seedPlacedPlatformJob({
        ordinal: 601,
        organizationId: ORG_A,
        companyId: COMPANY_A,
        workerId: logicalWorker,
      });
      const firstB = await seedPlacedPlatformJob({
        ordinal: 608,
        organizationId: ORG_B,
        companyId: COMPANY_B,
        workerId: logicalWorkerB,
      });

      const httpApp = express();
      httpApp.use(express.json({ verify: (req, _res, bytes) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
      } }));
      httpApp.use("/api", workerControlRoutes({
        db: ownerDb,
        appDb,
        operatorDb,
        sessionSigningKey: "test-signing-key-at-least-32-bytes",
        now: () => NOW,
      }));
      httpApp.use(errorHandler);

      const proofHeaders = (proof: ReturnType<typeof deviceProofFor>) => ({
        [WORKER_CONTROL_HEADERS.proofVersion]: proof.version,
        [WORKER_CONTROL_HEADERS.publicKey]: proof.publicKey,
        [WORKER_CONTROL_HEADERS.signature]: proof.signature,
        [WORKER_CONTROL_HEADERS.issuedAt]: proof.issuedAt,
        [WORKER_CONTROL_HEADERS.proofId]: proof.proofId,
      });
      const poll = {
        protocolVersion: 1,
        correlationId: "74000000-0000-4000-8000-000000000602",
        issuedAt: NOW.toISOString(),
        nonce: "platform-logical-poll-1",
        audience: "worker_poll",
        workerId: logicalWorker,
        targetId: TARGET_PLATFORM,
        deviceGeneration: 1,
        capacity: logicalBody.hello.capacity,
      };
      const pollBytes = Buffer.from(JSON.stringify(poll));
      const pollB = {
        ...poll,
        correlationId: "74000000-0000-4000-8000-000000000608",
        nonce: "platform-logical-b-poll",
        workerId: logicalWorkerB,
        capacity: logicalBodyB.hello.capacity,
      };
      const pollBBytes = Buffer.from(JSON.stringify(pollB));
      const pollBResponse = await request(httpApp)
        .post("/api/worker-control/poll")
        .set("authorization", `Bearer ${logicalB.session}`)
        .set(proofHeaders(deviceProofFor(
          pollBBytes,
          pollB.correlationId,
          keys.privateKey,
          keys.publicKey,
          "proof-platform-logical-b-poll",
          "/api/worker-control/poll",
        )))
        .send(pollB);
      expect(pollBResponse.status, JSON.stringify(pollBResponse.body)).toBe(200);
      expect(pollBResponse.body).toMatchObject({ outcome: "offer" });
      expect((pollBResponse.body.body as LeaseOfferV1).job.jobId).toBe(firstB.jobId);

      const pollResponse = await request(httpApp)
        .post("/api/worker-control/poll")
        .set("authorization", `Bearer ${logical.session}`)
        .set(proofHeaders(deviceProofFor(
          pollBytes,
          poll.correlationId,
          keys.privateKey,
          keys.publicKey,
          "proof-platform-logical-poll",
          "/api/worker-control/poll",
        )))
        .send(poll);
      expect(pollResponse.status, JSON.stringify(pollResponse.body)).toBe(200);
      expect(pollResponse.body).toMatchObject({ outcome: "offer" });
      const offer = pollResponse.body.body as LeaseOfferV1;
      expect(offer.job.jobId).toBe(first.jobId);

      await admin`UPDATE workers SET last_seen_at = ${new Date(NOW.getTime() - 60 * 60_000)}
        WHERE id = ${logicalWorker}`;
      const ack = {
        protocolVersion: 1,
        correlationId: "74000000-0000-4000-8000-000000000603",
        issuedAt: NOW.toISOString(),
        nonce: "platform-logical-ack-1",
        audience: "worker_run",
        idempotencyKey: "79000000-0000-4000-8000-000000000603",
        body: {
          protocolVersion: 1,
          workerId: logicalWorker,
          jobId: offer.job.jobId,
          attempt: offer.job.attempt,
          leaseId: offer.leaseId,
          fenceToken: offer.fenceToken,
          ackedAt: NOW.toISOString(),
          extensions: [],
        },
      };
      const ackBytes = Buffer.from(JSON.stringify(ack));
      const ackResponse = await request(httpApp)
        .post(`/api/worker-control/leases/${offer.leaseId}/ack`)
        .set("authorization", `Bearer ${logical.session}`)
        .set(proofHeaders(deviceProofFor(
          ackBytes,
          ack.correlationId,
          keys.privateKey,
          keys.publicKey,
          "proof-platform-logical-ack",
          `/api/worker-control/leases/${offer.leaseId}/ack`,
        )))
        .send(ack);
      expect(ackResponse.status, JSON.stringify(ackResponse.body)).toBe(200);
      expect(ackResponse.body).toMatchObject({ outcome: "acknowledged", leaseId: offer.leaseId });
      const [afterAck] = await admin<{ status: string; last_seen_at: Date | null }[]>`
        SELECT status, last_seen_at FROM workers WHERE id = ${logicalWorker}`;
      expect(afterAck).toMatchObject({ status: "enrolled" });
      expect(afterAck?.last_seen_at).not.toBeNull();

      await seedPlacedPlatformJob({
        ordinal: 602,
        organizationId: ORG_A,
        companyId: COMPANY_A,
        workerId: logicalWorker,
      });
      const staleAt = new Date(NOW.getTime() - 60 * 60_000);
      await admin`UPDATE execution_targets SET last_seen_at = ${staleAt} WHERE id = ${TARGET_PLATFORM}`;
      await admin`UPDATE workers SET last_seen_at = ${staleAt}
        WHERE id = ${WORKER_PLATFORM} AND organization_id IS NULL`;
      const stalePoll = {
        ...poll,
        correlationId: "74000000-0000-4000-8000-000000000604",
        nonce: "platform-logical-poll-stale-physical",
      };
      const staleBytes = Buffer.from(JSON.stringify(stalePoll));
      const staleResponse = await request(httpApp)
        .post("/api/worker-control/poll")
        .set("authorization", `Bearer ${logical.session}`)
        .set(proofHeaders(deviceProofFor(
          staleBytes,
          stalePoll.correlationId,
          keys.privateKey,
          keys.publicKey,
          "proof-platform-logical-stale-physical",
          "/api/worker-control/poll",
        )))
        .send(stalePoll);
      expect(staleResponse.status).toBe(409);
      expect(staleResponse.body).toMatchObject({ code: "target_revoked", detail: {} });
    });

    it("keeps frozen E1 JSON unchanged at the HTTP boundary and returns the session only in a header", async () => {
      const { appDb, operatorDb, mod } = guard();
      if (!ownerDb) throw new Error("owner DB unavailable");
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const issued = await service.issueTenantCode({
        organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
        ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: "founder-a",
      });
      const keys = generateKeyPairSync("ed25519");
      const body = enrollmentBody(WORKER_A);
      const signed = deviceProof(body, keys.privateKey, keys.publicKey, "proof-http-boundary");
      const httpApp = express();
      httpApp.use(express.json({ verify: (req, _res, bytes) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
      } }));
      httpApp.use("/api", workerControlRoutes({
        db: ownerDb,
        appDb,
        operatorDb,
        sessionSigningKey: "test-signing-key-at-least-32-bytes",
        now: () => NOW,
      }));
      httpApp.use("/api", executionTargetRoutes({
        db: ownerDb,
        workerSession: {
          appDb,
          operatorDb,
          sessionSigningKey: "test-signing-key-at-least-32-bytes",
          now: () => NOW,
        },
      }));
      httpApp.use(errorHandler);
      const response = await request(httpApp)
        .post("/api/worker-control/enroll")
        .set(WORKER_CONTROL_HEADERS.enrollmentCode, issued.code)
        .set(WORKER_CONTROL_HEADERS.proofVersion, signed.proof.version)
        .set(WORKER_CONTROL_HEADERS.publicKey, signed.proof.publicKey)
        .set(WORKER_CONTROL_HEADERS.signature, signed.proof.signature)
        .set(WORKER_CONTROL_HEADERS.issuedAt, signed.proof.issuedAt)
        .set(WORKER_CONTROL_HEADERS.proofId, signed.proof.proofId)
        .send(body);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ outcome: "enrolled", workerId: WORKER_A });
      expect(response.body).not.toHaveProperty("session");
      expect(response.headers[WORKER_CONTROL_HEADERS.session]).toEqual(expect.any(String));

      const heartbeat = Buffer.from(JSON.stringify({
        status: "draining",
        capabilities: { registeredTrustMustNotChange: true },
      }));
      const correlationId = "74000000-0000-4000-8000-000000000299";
      const heartbeatProof = deviceProofFor(
        heartbeat, correlationId, keys.privateKey, keys.publicKey,
        "proof-http-heartbeat", "/api/execution-targets/heartbeat",
      );
      const heartbeatResponse = await request(httpApp)
        .post("/api/execution-targets/heartbeat")
        .set("authorization", `Bearer ${response.headers[WORKER_CONTROL_HEADERS.session]}`)
        .set(WORKER_CONTROL_HEADERS.requestId, correlationId)
        .set(WORKER_CONTROL_HEADERS.proofVersion, heartbeatProof.version)
        .set(WORKER_CONTROL_HEADERS.publicKey, heartbeatProof.publicKey)
        .set(WORKER_CONTROL_HEADERS.signature, heartbeatProof.signature)
        .set(WORKER_CONTROL_HEADERS.issuedAt, heartbeatProof.issuedAt)
        .set(WORKER_CONTROL_HEADERS.proofId, heartbeatProof.proofId)
        .send(JSON.parse(heartbeat.toString("utf8")));
      expect(heartbeatResponse.status).toBe(204);
      const [target] = await admin`SELECT status, capabilities FROM execution_targets WHERE id = ${TARGET_A}`;
      expect(target.status).toBe("draining");
      expect(target.capabilities).not.toHaveProperty("registeredTrustMustNotChange");

      const session = String(response.headers[WORKER_CONTROL_HEADERS.session]);
      const expectHeartbeatProtocolError = (result: request.Response, code: string) => {
        expect(protocolErrorV1Schema.safeParse(result.body)).toMatchObject({ success: true });
        expect(OPERATION_DESCRIPTORS.enrollment.errors).toContain(code);
        expect(result.body).toMatchObject({
          protocolVersion: 1,
          code,
          redaction: "secret",
          serverTime: expect.any(String),
        });
      };
      const missingProof = await request(httpApp)
        .post("/api/execution-targets/heartbeat")
        .set("authorization", `Bearer ${session}`)
        .set(WORKER_CONTROL_HEADERS.requestId, "74000000-0000-4000-8000-000000000290")
        .send({ status: "active" });
      expectHeartbeatProtocolError(missingProof, "unauthorized");

      const sendProofHeartbeat = async (bodyBytes: Buffer, proofId: string, correlation: string) => {
        const proof = deviceProofFor(
          bodyBytes, correlation, keys.privateKey, keys.publicKey,
          proofId, "/api/execution-targets/heartbeat",
        );
        return request(httpApp)
          .post("/api/execution-targets/heartbeat")
          .set("authorization", `Bearer ${session}`)
          .set(WORKER_CONTROL_HEADERS.requestId, correlation)
          .set(WORKER_CONTROL_HEADERS.proofVersion, proof.version)
          .set(WORKER_CONTROL_HEADERS.publicKey, proof.publicKey)
          .set(WORKER_CONTROL_HEADERS.signature, proof.signature)
          .set(WORKER_CONTROL_HEADERS.issuedAt, proof.issuedAt)
          .set(WORKER_CONTROL_HEADERS.proofId, proof.proofId)
          .send(JSON.parse(bodyBytes.toString("utf8")));
      };
      const malformedHeartbeat = await sendProofHeartbeat(
        Buffer.from(JSON.stringify({ status: "not-a-worker-status" })),
        "proof-http-heartbeat-malformed",
        "74000000-0000-4000-8000-000000000291",
      );
      expectHeartbeatProtocolError(malformedHeartbeat, "malformed");

      await admin.unsafe(`CREATE FUNCTION job002_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'proof replay query parameters must not escape'; END $$`);
      await admin.unsafe(`CREATE TRIGGER job002_fail_proof_insert BEFORE INSERT ON worker_proof_replays
        FOR EACH ROW EXECUTE FUNCTION job002_fail_insert()`);
      const internalHeartbeat = await sendProofHeartbeat(
        Buffer.from(JSON.stringify({ status: "active" })),
        "proof-http-heartbeat-internal",
        "74000000-0000-4000-8000-000000000292",
      );
      expectHeartbeatProtocolError(internalHeartbeat, "internal_unavailable");
      await admin.unsafe(`DROP TRIGGER job002_fail_proof_insert ON worker_proof_replays`);
      await admin.unsafe(`DROP FUNCTION job002_fail_insert()`);

      await admin`UPDATE execution_targets SET status = 'disabled' WHERE id = ${TARGET_A}`;
      const revokedHeartbeat = await sendProofHeartbeat(
        Buffer.from(JSON.stringify({ status: "active" })),
        "proof-http-heartbeat-revoked",
        "74000000-0000-4000-8000-000000000293",
      );
      expectHeartbeatProtocolError(revokedHeartbeat, "unauthorized");
    });

    it("revokes owner-scoped session and new issuance when Organization membership is removed", async () => {
      const { admin, appDb, operatorDb, mod } = guard();
      expect(sessionModule, "worker-session-auth module is not implemented").not.toBeNull();
      const service = mod.createWorkerEnrollmentService({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      const issueInput = {
        organizationId: ORG_A,
        executionTargetId: TARGET_OWNER,
        scope: "owner" as const,
        ownerUserId: OWNER_USER,
        createdByPrincipalKind: "user",
        createdByPrincipalId: OWNER_USER,
      };
      const keys = generateKeyPairSync("ed25519");
      const body = enrollmentBody(WORKER_OWNER, TARGET_OWNER);
      const enrolled = await service.enroll({
        code: (await service.issueTenantCode(issueInput)).code,
        request: body,
        ...deviceProof(body, keys.privateKey, keys.publicKey, "proof-owner-enroll"),
        method: "POST",
        path: "/api/worker-control/enroll",
      });
      await admin`UPDATE organization_memberships SET status = 'suspended'
        WHERE organization_id = ${ORG_A} AND user_id = ${OWNER_USER}`;
      await expect(service.issueTenantCode(issueInput)).rejects.toMatchObject({ code: "unauthorized" });
      const bytes = Buffer.from("{}");
      const correlationId = "74000000-0000-4000-8000-000000000399";
      const authenticator = sessionModule!.createWorkerSessionAuthenticator({
        appDb, operatorDb, sessionSigningKey: "test-signing-key-at-least-32-bytes", now: () => NOW,
      });
      await expect(authenticator.authenticate({
        authorization: `Bearer ${enrolled.session}`,
        rawBody: bytes,
        proof: deviceProofFor(bytes, correlationId, keys.privateKey, keys.publicKey, "proof-owner-removed", "/api/execution-targets/heartbeat"),
        method: "POST",
        path: "/api/execution-targets/heartbeat",
        correlationId,
      })).rejects.toMatchObject({ code: "target_revoked" });
    });
  },
);

function deviceProofFor(
  bytes: Buffer,
  correlationId: string,
  privateKey: KeyObject,
  publicKey: KeyObject,
  proofId: string,
  path: string,
) {
  const issuedAt = NOW.toISOString();
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const canonical = [
    "AOA-DEVICE-PROOF-V1", "POST", path,
    createHash("sha256").update(bytes).digest("hex"), correlationId, issuedAt, proofId,
  ].join("\n");
  return {
    version: "1", publicKey: publicKeyDer,
    signature: sign(null, Buffer.from(canonical), privateKey).toString("base64url"),
    issuedAt, proofId,
  };
}
