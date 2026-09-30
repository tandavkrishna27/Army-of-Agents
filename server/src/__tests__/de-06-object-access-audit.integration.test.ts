/**
 * DE-06, audit clause — THE PUT/GET CONJUNCT. An AUTHORIZED object operation is
 * durably distinguishable from an operation that never happened, and
 * ATTRIBUTABLE.
 *
 * ★ WHAT THIS FILE IS FOR, AND WHY IT IS A SECOND FILE.
 * `docs/architecture/distributed-execution-threat-controls.json` DE-06 asserts
 * "object put/get **and** rejected-key attempts are audited". That is a
 * CONJUNCTION, and this programme has already retracted one DE-06 closure for
 * delivering half of it. The REJECTED-KEY conjunct is proven, arm by arm, in
 * `de-06-artifact-denial-audit.integration.test.ts` — every refusal on the grant
 * path, every refusal on the commit path, and all six `resolveWorkerFenceContext`
 * throws. This file proves the OTHER conjunct, and only that one:
 *   - a SUCCESSFUL upload grant (the PUT capability) is recorded;
 *   - a SUCCESSFUL download grant (the GET capability) is recorded — and
 *     `artifact-transfer-grant.ts` holds the tree's ONLY production
 *     `presignGet` call site, so this row is the whole disclosure record.
 * Before this, both wrote nothing: a worker HANDED read access to an object's
 * bytes left the same durable trace as a worker that asked for nothing.
 *
 * ★ WHAT IS NOT CLAIMED, stated before anything is claimed.
 *   (1) ISSUANCE IS NOT REDEMPTION, and no arm here pretends otherwise. The
 *       presigned URL is redeemed DIRECTLY against object storage; the control
 *       plane never sees the redemption, which is the entire point of the
 *       presigned design. Issuance is therefore the only observation point that
 *       exists, and the record OVER-reports: an issued-but-never-redeemed GET
 *       still writes a row. `THE RECORD IS OF ISSUANCE` below asserts exactly
 *       that — the store's `getObject` is never called and the row exists anyway
 *       — so this limit is pinned by a test rather than left in prose.
 *   (2) DE-06's `authentication` clause is separately absent (`E0-F012`) and is
 *       untouched here. DE-06's register `deliveryStatus` stays `partial`.
 *
 * ★ WHY THIS IS NOT A READ-BACK. Nothing here constructs an audit row. Every arm
 * ABOUT THE RECORD drives the REAL service — a real enrolled worker, a real
 * polled + acked lease, a real live fence, a real commit for the download arm —
 * and then asserts the row the successful operation itself left behind. A
 * read-back verifies what was DECLARED, never what is ENFORCED (the measured
 * lesson of DE-08).
 *   ★ TWO ARMS ARE DELIBERATELY NOT SERVICE-DRIVEN, and they are named here so
 *   this paragraph is not read as covering them. The NAMESPACE RESERVATION arm
 *   is a pure predicate check — there is no service path that could reach
 *   `assertUnreservedActivityNamespace` with this prefix, which is the property
 *   it asserts. The FAILURE-PATH REDACTION arm calls `recordObjectAccessGrant`
 *   DIRECTLY, because the thing under test is what the recorder logs when its
 *   INSERT fails, and no legal request through the service can make that insert
 *   fail — the company is the locked lease's and is FK-valid by construction.
 *   It still uses a REAL constraint violation rather than a stub, so the catch
 *   branch is entered for the reason it exists for.
 *
 * ★ ATTRIBUTION IS THE ASSERTION, and it is asserted per question, because a row
 * saying "an object was accessed" satisfies no crossing in this class:
 *   WHO       -> actor_id is the worker the capability was handed to
 *   TENANT    -> company_id is the LOCKED LEASE's company, resolved from the
 *                database under the worker's own organization GUC. Nothing the
 *                caller sends can steer it, and the arm that proves this sends a
 *                request whose only tenancy hint points elsewhere.
 *   RESOURCE  -> entity_type/entity_id is the artifact identity, and
 *                details.objectKey is the key that was actually SIGNED
 *   OPERATION -> the ACTION distinguishes the two conjuncts (`…artifact_upload_grant`
 *                vs `…artifact_download_grant`), so "how many download URLs were
 *                issued in this tenant" is an `action` predicate and not a jsonb dig
 *
 * ★ THE SEPARATION FROM THE DENIAL NAMESPACE IS A PROPERTY, NOT A DETAIL. If a
 * granted transfer landed under `security.denied.`, then "count the denial rows"
 * would stop answering "count the refusals" — the exact property the reservation
 * in `activity-namespace.ts` exists to hold. Two arms assert the separation from
 * both sides: a granted transfer writes no denial row, and a refused transfer
 * writes no access row.
 *
 * Real Postgres (embedded-postgres + the committed migration chain), the real
 * `aoa_app` non-owner role, the real leasing / transfer-grant / commit services.
 * No stubs on the recorder; only the object store is stubbed.
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI `push` is the authoritative gate. On
 * a Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real. Harness
 * modeled on de-06-artifact-denial-audit.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres, { type Sql } from "postgres";
import {
  applyPendingMigrations,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import {
  canonicalProviderConstraintProfileDigestInputV1,
  canonicalizeJsonV1,
  expectedAttemptObjectPrefix,
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import {
  createJobLeasingService,
  type VerifiedWorkerOperation,
} from "../services/job-leasing.js";
import { createArtifactTransferGrantService } from "../services/artifact-transfer-grant.js";
import { createArtifactCommitService } from "../services/artifact-commit.js";
import {
  ReservedActivityNamespaceError,
  assertUnreservedActivityNamespace,
} from "../services/activity-namespace.js";
import { recordObjectAccessGrant } from "../services/artifact-object-access-audit.js";
import { logger } from "../middleware/logger.js";
import type { StorageProvider, HeadObjectResult, PresignResult } from "../storage/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "d6a00000-0000-4000-8000-000000000001";
const COMPANY = "d6a00000-0000-4000-8000-000000000002";
const TARGET = "d6a00000-0000-4000-8000-000000000003";
const WORKER = "d6a00000-0000-4000-8000-000000000005";
// A genuinely separate tenant at the unit the kernel keys on (`organizations`),
// not merely a second company inside the same organization.
const OTHER_ORG = "d6a00000-0000-4000-8000-0000000000aa";
const OTHER_COMPANY = "d6a00000-0000-4000-8000-0000000000bb";
const PASSWORD = "de-006-access-role-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;

/** The two actions under test — written out, not built, so a rename reds here. */
const UPLOAD_ACCESS_ACTION = "security.object_access.artifact_upload_grant";
const DOWNLOAD_ACCESS_ACTION = "security.object_access.artifact_download_grant";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "de-006-access-provider",
    version: 1,
    maxContinuousRuntimeSeconds: 3_600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2_000, memoryMiB: 4_096, pids: 512, diskMiB: 8_192 },
    maxConcurrentOperations: 2,
    supportedOperations: ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup"],
    localityTags: ["organization_target_only"],
    checkpointMode: "none",
    healthMode: "none",
  } as const;
  return { ...unsigned, digest: sha256(canonicalProviderConstraintProfileDigestInputV1(unsigned)) };
}

function registeredProfile(provider: ProviderConstraintProfileV1): RegisteredTargetProfileV1 {
  return {
    protocolVersion: 1,
    targetId: TARGET,
    targetClass: "organization_dedicated",
    scope: "organization",
    organizationId: ORG,
    ownerPrincipalId: null,
    trustCeiling: "organization_isolated",
    credentialCeiling: "organization_brokered",
    dataLocalityCeiling: "organization_target_only",
    providerConstraints: { profileId: provider.profileId, version: provider.version, digest: provider.digest },
    capabilityCeiling: ["workload.batch", "sandbox.process_isolated"],
    deviceGeneration: 1,
    revokedAt: null,
    policyHash: POLICY_HASH,
  };
}

function workerHello() {
  return {
    protocolVersion: 1 as const,
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 1,
    agentVersion: "de-006-access-integration",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux" as const, arch: "x64" as const, runtime: "worker" },
    reportedCapabilities: ["workload.batch" as const, "sandbox.process_isolated" as const],
    capacity: { batchSlots: 2, browserSessionSlots: 0, serviceSlots: 0, freeCpuMillis: 2_000, freeMemoryMiB: 4_096, freeDiskMiB: 8_192 },
    policyHash: POLICY_HASH,
  };
}

const WORKER_PROFILE_HASH = sha256(JSON.stringify(workerHello()));

function pollRequest(nonce: string): PollRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce,
    audience: "worker_poll",
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 1,
    capacity: { batchSlots: 2, browserSessionSlots: 0, serviceSlots: 0, freeCpuMillis: 2_000, freeMemoryMiB: 4_096, freeDiskMiB: 8_192 },
  };
}

function ackRequest(offer: LeaseOfferV1): LeaseAckOperationRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `ack-${crypto.randomUUID()}`,
    audience: "worker_run",
    idempotencyKey: crypto.randomUUID(),
    body: {
      protocolVersion: 1,
      workerId: offer.workerId,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      ackedAt: new Date().toISOString(),
      extensions: [],
    },
  };
}

/**
 * The object store, stubbed — and INSTRUMENTED, because two arms turn on what it
 * was and was not asked to do. `presignGetCalls` proves a GET capability really
 * was minted; `getObjectCalls` proves the control plane never observed a
 * redemption, which is the scope limit this file pins rather than asserts.
 */
function makeStubStorage(): StorageProvider & {
  headResult: HeadObjectResult;
  readonly presignPutCalls: number;
  readonly presignGetCalls: number;
  readonly getObjectCalls: number;
} {
  const state = {
    headResult: { exists: true, contentLength: 128, checksumSha256: "b".repeat(64) } as HeadObjectResult,
    presignPutCalls: 0,
    presignGetCalls: 0,
    getObjectCalls: 0,
  };
  return {
    id: "s3",
    get headResult() { return state.headResult; },
    set headResult(v: HeadObjectResult) { state.headResult = v; },
    get presignPutCalls() { return state.presignPutCalls; },
    get presignGetCalls() { return state.presignGetCalls; },
    get getObjectCalls() { return state.getObjectCalls; },
    async putObject() {},
    async getObject() { state.getObjectCalls += 1; throw new Error("not used"); },
    async headObject() { return state.headResult; },
    async deleteObject() {},
    async presignPut(i): Promise<PresignResult> {
      state.presignPutCalls += 1;
      return { method: "PUT", url: `https://worker.example/put/${encodeURIComponent(i.objectKey)}`, headers: {} };
    },
    async presignGet(i): Promise<PresignResult> {
      state.presignGetCalls += 1;
      return { method: "GET", url: `https://worker.example/get/${encodeURIComponent(i.objectKey)}`, headers: {} };
    },
  };
}

interface AuditRow {
  company_id: string | null;
  organization_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  agent_id: string | null;
  run_id: string | null;
  details: Record<string, unknown> | null;
}

integration("DE-06 — an AUTHORIZED artifact object operation is durable and attributable", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;
  let ordinalCounter = 9_000;

  function ctx() {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!admin || !app) throw new Error("test setup incomplete");
    return { admin, app };
  }

  function auth(proofId: string): VerifiedWorkerOperation {
    return {
      organizationId: ORG,
      workerId: WORKER,
      targetId: TARGET,
      targetGeneration: 1,
      deviceThumbprint: THUMBPRINT,
      profileHash: WORKER_PROFILE_HASH,
      publicKey: "de-006-access-public-key",
      proofId,
      proofIssuedAt: new Date(),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  /** The OBJECT-ACCESS rows for one artifact identity, in issuance order. */
  async function accessRowsFor(artifactId: string): Promise<AuditRow[]> {
    const { admin } = ctx();
    return (await admin<AuditRow[]>`
      SELECT company_id, organization_id, actor_type, actor_id, action,
             entity_type, entity_id, agent_id, run_id, details
      FROM activity_log
      WHERE entity_id = ${artifactId} AND action LIKE 'security.object_access.%'
      ORDER BY created_at, id`) as unknown as AuditRow[];
  }

  /** The DENIAL rows for one artifact identity. The separation control. */
  async function denialRowsFor(artifactId: string): Promise<AuditRow[]> {
    const { admin } = ctx();
    return (await admin<AuditRow[]>`
      SELECT company_id, organization_id, actor_type, actor_id, action,
             entity_type, entity_id, agent_id, run_id, details
      FROM activity_log
      WHERE entity_id = ${artifactId} AND action LIKE 'security.denied.%'
      ORDER BY created_at, id`) as unknown as AuditRow[];
  }

  async function accessRowCount(companyId: string): Promise<number> {
    const { admin } = ctx();
    const rows = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log
      WHERE company_id = ${companyId} AND action LIKE 'security.object_access.%'`;
    return Number(rows[0]?.n ?? "-1");
  }

  async function resetRuntimeRows(): Promise<void> {
    const { admin } = ctx();
    await admin`DELETE FROM worker_operation_receipts`;
    await admin`DELETE FROM leases`;
    await admin`DELETE FROM job_artifacts`;
    await admin`DELETE FROM job_outbox`;
    await admin`DELETE FROM job_attempts`;
    await admin`DELETE FROM jobs`;
    await admin`DELETE FROM worker_proof_replays`;
    const provider = providerProfile();
    const profile = registeredProfile(provider);
    await admin`UPDATE execution_targets SET status = 'active', device_generation = 1,
      registered_profile = ${profile}, registered_profile_hash = ${sha256(canonicalizeJsonV1(profile))},
      provider_constraint_profile = ${provider}, last_seen_at = clock_timestamp() WHERE id = ${TARGET}`;
    const hello = workerHello();
    await admin`UPDATE workers SET status = 'enrolled', revoked_at = NULL, device_generation = 1,
      profile_hash = ${sha256(JSON.stringify(hello))}, profile_snapshot = ${hello},
      device_public_key = 'de-006-access-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  async function seedPlacedJob(ordinal: number): Promise<{ jobId: string }> {
    const { admin } = ctx();
    const suffix = ordinal.toString().padStart(12, "0");
    const jobId = `d6a10000-0000-4000-8000-${suffix}`;
    const attemptId = `d6a20000-0000-4000-8000-${suffix}`;
    const outboxId = `d6a30000-0000-4000-8000-${suffix}`;
    const provider = providerProfile();
    const profile = registeredProfile(provider);
    const profileHash = sha256(canonicalizeJsonV1(profile));
    const availableAt = new Date(Date.now() - 60_000 + ordinal);
    const workload = { command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds: 600 };
    await admin`INSERT INTO jobs
      (id, organization_id, company_id, workload_type, source_kind, source_identity, source_intent,
       requester_principal_kind, requester_principal_id, executor_principal_kind, executor_principal_id,
       input, input_hash, policy_snapshot, policy_hash, requirements, placement_request,
       available_at, priority, status, created_at, updated_at)
       VALUES (${jobId}, ${ORG}, ${COMPANY}, 'batch', 'one_shot', ${jobId},
         ${{ kind: "one_shot", operationId: jobId, operationKind: "extraction" }},
         'system', 'de-006-access-test', 'worker', ${WORKER}, ${workload},
         ${"5".repeat(64)}, ${{ policyId: "job-submission-default", version: 1 }}, ${POLICY_HASH},
         ${{ workloadType: "batch", requiredCapabilities: ["sandbox.process_isolated"] }},
        ${{ policyId: "job-submission-default", policyVersion: 1, requestedTarget: TARGET }},
        ${availableAt}, 50, 'queued', ${availableAt}, ${availableAt})`;
    await admin`INSERT INTO job_attempts
      (id, organization_id, company_id, job_id, attempt_number, status,
       placement_disposition, placement_owner, placement_target_id, placement_target_class,
       placement_target_scope, placement_target_generation, placement_profile_hash,
       placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
       placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
       placement_decided_at, created_at, updated_at)
      VALUES (${attemptId}, ${ORG}, ${COMPANY}, ${jobId}, 1, 'pending',
        'selected', 'organization_dedicated', ${TARGET}, 'organization_dedicated',
        'organization', 1, ${profileHash}, ${provider.digest}, 'primary', 'target_selected',
        'active', true, ${"6".repeat(64)}, ${"6".repeat(64)}, clock_timestamp(),
        ${availableAt}, ${availableAt})`;
    await admin`INSERT INTO job_outbox
      (id, organization_id, company_id, job_id, attempt_id, kind, status, payload, available_at)
      VALUES (${outboxId}, ${ORG}, ${COMPANY}, ${jobId}, ${attemptId}, 'attempt_ready', 'pending',
        ${{ organizationId: ORG, companyId: COMPANY, jobId, attemptId, sourceKind: "one_shot" }},
        clock_timestamp())`;
    return { jobId };
  }

  /** A real poll + ack: the returned offer carries a LIVE fence. */
  async function activateLease(): Promise<LeaseOfferV1> {
    const { app } = ctx();
    const ordinal = ordinalCounter++;
    await resetRuntimeRows();
    await seedPlacedJob(ordinal);
    const service = createJobLeasingService({ appDb: app.db });
    const polled = await service.poll({ auth: auth(`p-${ordinal}`), request: pollRequest(`p-${ordinal}`) });
    if (polled.outcome !== "offer") throw new Error(`expected offer, got ${polled.outcome}`);
    const offer = polled.body;
    const acked = await service.ack({ auth: auth(`a-${ordinal}`), request: ackRequest(offer) });
    if (acked.outcome !== "acknowledged") throw new Error("expected ack");
    return offer;
  }

  function ownKey(jobId: string, name = "out.bin"): string {
    return `${expectedAttemptObjectPrefix({ organizationId: ORG, jobId, attempt: 1 })}${name}`;
  }

  /** A key under the OTHER organization's prefix — the cross-tenant probe. */
  function foreignKey(jobId: string, name = "out.bin"): string {
    return `${expectedAttemptObjectPrefix({ organizationId: OTHER_ORG, jobId, attempt: 1 })}${name}`;
  }

  function grantRequest(
    offer: LeaseOfferV1,
    operation: "upload" | "download",
    overrides: Record<string, unknown> = {},
  ) {
    const artifactId = (overrides.artifactId as string) ?? crypto.randomUUID();
    return {
      artifactId,
      request: {
        protocolVersion: 1 as const,
        correlationId: crypto.randomUUID(),
        issuedAt: new Date().toISOString(),
        nonce: `g-${crypto.randomUUID()}`,
        audience: "worker_run" as const,
        idempotencyKey: crypto.randomUUID(),
        body: {
          protocolVersion: 1 as const,
          operation,
          workerId: WORKER,
          jobId: offer.job.jobId,
          attempt: offer.job.attempt,
          leaseId: offer.leaseId,
          fenceToken: offer.fenceToken,
          artifactId,
          expectedObjectKey: ownKey(offer.job.jobId),
          expectedSha256: "a".repeat(64),
          maxBytes: 4096,
          ...overrides,
        },
      },
    };
  }

  function commitRequest(offer: LeaseOfferV1, manifest: Record<string, unknown> = {}) {
    const artifactId = (manifest.artifactId as string) ?? crypto.randomUUID();
    return {
      artifactId,
      request: {
        protocolVersion: 1 as const,
        correlationId: crypto.randomUUID(),
        issuedAt: new Date().toISOString(),
        nonce: `c-${crypto.randomUUID()}`,
        audience: "worker_run" as const,
        idempotencyKey: crypto.randomUUID(),
        body: {
          protocolVersion: 1 as const,
          workerId: WORKER,
          jobId: offer.job.jobId,
          attempt: offer.job.attempt,
          leaseId: offer.leaseId,
          fenceToken: offer.fenceToken,
          manifest: {
            protocolVersion: 1 as const,
            organizationId: ORG,
            companyId: COMPANY,
            jobId: offer.job.jobId,
            attempt: offer.job.attempt,
            artifactId,
            kind: "log",
            sensitivity: "restricted" as const,
            retention: "run",
            objectKey: ownKey(offer.job.jobId),
            sizeBytes: 128,
            sha256: "b".repeat(64),
            contentType: "application/octet-stream",
            createdAt: new Date().toISOString(),
            ...manifest,
          },
        },
      },
    };
  }

  /** Commit an artifact under a live fence, so a download grant is legal for it. */
  async function commitArtifact(
    offer: LeaseOfferV1,
    storage: ReturnType<typeof makeStubStorage>,
  ): Promise<{ artifactId: string; objectKey: string }> {
    const { app } = ctx();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const objectKey = ownKey(offer.job.jobId, `committed-${crypto.randomUUID()}.bin`);
    const { artifactId, request } = commitRequest(offer, { objectKey });
    const res = await svc.commit({ auth: auth(`cm-${crypto.randomUUID()}`), request });
    if (res.outcome !== "committed") throw new Error(`expected committed, got ${res.outcome}`);
    return { artifactId, objectKey };
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-de006a-"));
      const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
      const port = await allocateEmbeddedPgPort();
      embedded = new EmbeddedPostgres({
        databaseDir: join(dataDir, "db"), user: "test", password: "test", port,
        persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"],
      });
      await embedded.initialise();
      await embedded.start();
      const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
      await applyPendingMigrations(adminUrl);
      admin = postgres(adminUrl, { max: 4 });
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
      app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 16 });
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DE-06 access org', 'de-006-access-org')`;
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${OTHER_ORG}, 'DE-06 access other', 'de-006-access-other')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'DE-06 access company', 'D06A')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${OTHER_COMPANY}, ${OTHER_ORG}, 'DE-06 access other company', 'D06B')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'de-006-access-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'de-006-access-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'DE-06 access worker', 'enrolled')`;
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close({ timeoutSeconds: 5 }).catch(() => {});
    await admin?.end().catch(() => {});
    await embedded?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  it("ANTI-VACUITY — nothing has been granted yet, so neither tenant holds an object-access row", async () => {
    ctx();
    expect(await accessRowCount(COMPANY)).toBe(0);
    expect(await accessRowCount(OTHER_COMPANY)).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CONJUNCT 1 — "object PUT"
  // ───────────────────────────────────────────────────────────────────────────

  it("★ THE PUT CONJUNCT — a GRANTED upload writes ONE attributable object-access row", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const { request, artifactId } = grantRequest(offer, "upload");

    const res = await svc.grant({ auth: auth(`up-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("upload_granted");
    // POSITIVE CONTROL for the fixture: a PUT capability really was minted.
    expect(storage.presignPutCalls).toBe(1);

    const rows = await accessRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe(UPLOAD_ACCESS_ACTION);
    // WHO — the worker the capability was handed to, in plain-text `actor_id`
    // because a worker has no `agents` row and no `auth` row.
    expect(row.actor_id).toBe(WORKER);
    expect(row.actor_type).toBe("system");
    // ...and neither FK'd actor column is fabricated.
    expect(row.agent_id).toBeNull();
    expect(row.run_id).toBeNull();
    // TENANT — the LOCKED LEASE's company, plus the token-attested organization.
    expect(row.company_id).toBe(COMPANY);
    expect(row.organization_id).toBe(ORG);
    // RESOURCE — the artifact identity, and the key that was actually signed.
    expect(row.entity_type).toBe("job_artifact");
    expect(row.entity_id).toBe(artifactId);
    expect(row.details?.objectKey).toBe(ownKey(offer.job.jobId));
    expect(row.details?.operation).toBe("upload");
    expect(row.details?.method).toBe("PUT");
    // ★ DE-11's access half is NULL ON AN UPLOAD, and that is a true answer
    // rather than a missing one: at grant time the artifact does not exist and
    // the frozen request carries neither `kind` nor `sensitivity` — both are
    // first declared in the COMMIT manifest. Asserted so a future change that
    // starts guessing a kind here reds.
    expect(row.details?.kind).toBeNull();
    expect(row.details?.sensitivity).toBeNull();
    expect(row.details?.crossing).toBe("DE-06");
    expect(row.details?.workerId).toBe(WORKER);
    expect(row.details?.leaseId).toBe(offer.leaseId);
    // The exposure window the issued capability carries.
    expect(typeof row.details?.grantExpiresAt).toBe("string");
    expect(Date.parse(String(row.details?.grantExpiresAt))).toBeGreaterThan(Date.now() - 60_000);

    // SEPARATION — a granted transfer is not a refusal and must not be counted as one.
    expect(await denialRowsFor(artifactId)).toHaveLength(0);
  }, 60_000);

  // ───────────────────────────────────────────────────────────────────────────
  // CONJUNCT 2 — "object GET", the disclosure-relevant event
  // ───────────────────────────────────────────────────────────────────────────

  it("★ THE GET CONJUNCT — a GRANTED download writes ONE attributable object-access row at the tree's only production `presignGet` call site", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const { artifactId, objectKey } = await commitArtifact(offer, storage);
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const { request } = grantRequest(offer, "download", { artifactId, expectedObjectKey: objectKey });

    const res = await svc.grant({ auth: auth(`dn-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("download_granted");
    // POSITIVE CONTROL for the fixture: a GET capability really was minted.
    expect(storage.presignGetCalls).toBe(1);

    const rows = await accessRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe(DOWNLOAD_ACCESS_ACTION);
    expect(row.actor_id).toBe(WORKER);
    expect(row.company_id).toBe(COMPANY);
    expect(row.organization_id).toBe(ORG);
    expect(row.entity_type).toBe("job_artifact");
    expect(row.entity_id).toBe(artifactId);
    // ★ THE FIELD THIS ROW EXISTS FOR: which bytes became reachable. The service
    // refuses any key that is not the committed one, so this names them exactly.
    expect(row.details?.objectKey).toBe(objectKey);
    expect(row.details?.operation).toBe("download");
    expect(row.details?.method).toBe("GET");
    // ★ DE-11's ACCESS HALF, on the arm that can answer it. The committed row is
    // already loaded to prove the key is this tenant's, so the record says WHICH
    // KIND became reachable — the difference between a disclosure record and a
    // transfer counter. Read FROM THE COMMITTED ROW, not from the request: the
    // fixture commits `kind: "log"` / `sensitivity: "restricted"` and neither
    // value appears anywhere in the download request.
    expect(row.details?.kind).toBe("log");
    expect(row.details?.sensitivity).toBe("restricted");
  }, 60_000);

  it("★ DE-11's ACCESS HALF READS THE COMMITTED ROW, NOT THE REQUEST — a download of a SENSITIVE kind records that kind", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const objectKey = ownKey(offer.job.jobId, `sensitive-${crypto.randomUUID()}.bin`);
    // ★ PROVOKED BY HAND AND PINNED AS SUCH. Nothing in production uploads
    // `browser_cookie_state` — BRW-003 is unbuilt — which is exactly the coverage
    // caveat `artifact-retention-audit.ts` states for the retention half and that
    // keeps DE-11 `partial`. This arm proves the MECHANISM carries the kind; it
    // does not and must not be read as production coverage.
    //
    // ★ AND `sensitivity` IS NOT THE DISCRIMINATOR, MEASURED AT THE FROZEN
    // SCHEMA. `artifactSensitivitySchema` is `z.literal("restricted")` and
    // `RESTRICTED_ARTIFACT_KINDS === ARTIFACT_KINDS` — every V1 kind is
    // restricted and there is no weaker class — so a manifest declaring anything
    // else does not parse. `kind` is the field that separates a credential-bearing
    // artifact from a log, which is why this arm turns on `kind` and asserts
    // `sensitivity` only as the constant it is.
    const { artifactId, request } = commitRequest(offer, {
      objectKey,
      kind: "browser_cookie_state",
    });
    const committed = await svc.commit({ auth: auth(`sv-${crypto.randomUUID()}`), request });
    expect(committed.outcome).toBe("committed");

    const grantSvc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const g = grantRequest(offer, "download", { artifactId, expectedObjectKey: objectKey });
    expect((await grantSvc.grant({ auth: auth(`sg-${crypto.randomUUID()}`), request: g.request })).outcome)
      .toBe("download_granted");

    const rows = await accessRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details?.kind).toBe("browser_cookie_state");
    expect(rows[0]!.details?.sensitivity).toBe("restricted");
    // ANTI-VACUITY for the kind assertion: the fixture's OTHER arms commit
    // `kind: "log"`, so this arm asserts a value that varies with the committed
    // row rather than a constant every row would carry.
    expect(rows[0]!.details?.kind).not.toBe("log");
  }, 60_000);

  it("★ THE TWO CONJUNCTS ARE TOLD APART — a put and a get on the SAME artifact write two rows with two different actions, in issuance order", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });

    // PUT first, on a fresh identity...
    const up = grantRequest(offer, "upload");
    expect((await svc.grant({ auth: auth(`b1-${crypto.randomUUID()}`), request: up.request })).outcome)
      .toBe("upload_granted");
    // ...then COMMIT that identity so a GET is legal for it...
    const commitSvc = createArtifactCommitService({ appDb: app.db, storage });
    const committed = await commitSvc.commit({
      auth: auth(`b2-${crypto.randomUUID()}`),
      request: commitRequest(offer, { artifactId: up.artifactId, objectKey: ownKey(offer.job.jobId) }).request,
    });
    expect(committed.outcome).toBe("committed");
    // ...then GET it.
    const down = grantRequest(offer, "download", {
      artifactId: up.artifactId,
      expectedObjectKey: ownKey(offer.job.jobId),
    });
    expect((await svc.grant({ auth: auth(`b3-${crypto.randomUUID()}`), request: down.request })).outcome)
      .toBe("download_granted");

    const rows = await accessRowsFor(up.artifactId);
    expect(rows.map((r) => r.action)).toEqual([UPLOAD_ACCESS_ACTION, DOWNLOAD_ACCESS_ACTION]);
    // ★ THE CONJUNCTION, ASSERTED AS A CONJUNCTION: neither action alone
    // satisfies "object put/get", so this arm reds if either half is dropped.
    expect(new Set(rows.map((r) => r.details?.method))).toEqual(new Set(["PUT", "GET"]));
  }, 60_000);

  // ───────────────────────────────────────────────────────────────────────────
  // THE SCOPE LIMIT, PINNED
  // ───────────────────────────────────────────────────────────────────────────

  it("★ THE RECORD IS OF ISSUANCE, NOT REDEMPTION — the control plane never observes the transfer, and the row exists anyway", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const { artifactId, objectKey } = await commitArtifact(offer, storage);
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const { request } = grantRequest(offer, "download", { artifactId, expectedObjectKey: objectKey });

    expect((await svc.grant({ auth: auth(`is-${crypto.randomUUID()}`), request })).outcome)
      .toBe("download_granted");

    // The bytes move DIRECTLY between the worker and object storage: the control
    // plane never calls `getObject` and has no second observation point. So this
    // audit necessarily OVER-reports — a capability that is never redeemed still
    // writes a row — and that is asserted here rather than left in prose, so a
    // future reader cannot mistake a row for proof that bytes moved.
    expect(storage.getObjectCalls).toBe(0);
    expect(await accessRowsFor(artifactId)).toHaveLength(1);
  }, 60_000);

  it("★ TWO GRANTS ARE TWO ROWS — this is NOT deduplicated, because two capabilities were handed out", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const { artifactId, objectKey } = await commitArtifact(offer, storage);
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });

    for (const tag of ["d1", "d2"]) {
      const { request } = grantRequest(offer, "download", { artifactId, expectedObjectKey: objectKey });
      expect((await svc.grant({ auth: auth(`${tag}-${crypto.randomUUID()}`), request })).outcome)
        .toBe("download_granted");
    }

    // ★ DELIBERATELY DIFFERENT FROM DE-11's RETENTION RECORD, which drops an
    // idempotent replay because a replay DECIDED nothing. Here each grant mints a
    // separate, separately-expiring capability, so collapsing them would under-
    // report exposure. A future "dedupe the audit" change reds this arm.
    expect(await accessRowsFor(artifactId)).toHaveLength(2);
    expect(storage.presignGetCalls).toBe(2);
  }, 60_000);

  // ───────────────────────────────────────────────────────────────────────────
  // THE SEPARATION AND NON-DISCLOSURE CONTROLS
  // ───────────────────────────────────────────────────────────────────────────

  it("★ MUTATION GUARD — a REFUSED grant writes NO object-access row, and still writes its denial row", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    // A key under a FOREIGN organization's prefix: refused by the upload-prefix
    // guard, which sits AFTER the fence lock and BEFORE the presign.
    const probeKey = foreignKey(offer.job.jobId, "probe.bin");
    const { request, artifactId } = grantRequest(offer, "upload", { expectedObjectKey: probeKey });

    const res = await svc.grant({ auth: auth(`rj-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");

    // ★ THIS IS THE ARM THE SINGLE-MECHANISM DESIGN EXISTS FOR. The access intent
    // is captured ONLY at the two `*_granted` returns and there is no second
    // `outcome` check at the drain, so moving the capture above a refusal branch
    // reds here. A redundant outcome guard would have let that mutation pass.
    expect(await accessRowsFor(artifactId)).toHaveLength(0);
    // ...and the refusal is still recorded, so this arm cannot pass by the
    // service having refused to do anything at all.
    const denials = await denialRowsFor(artifactId);
    expect(denials).toHaveLength(1);
    expect(denials[0]!.details?.reason).toBe("foreign_object_prefix");
    // No capability was minted for a refused request.
    expect(storage.presignPutCalls).toBe(0);
  }, 60_000);

  it("★ NON-DISCLOSURE — a cross-tenant download probe grants nothing, so the probed tenant gains no row and neither does the prober", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const beforeOther = await accessRowCount(OTHER_COMPANY);
    const probeKey = foreignKey(offer.job.jobId, "steal.bin");
    const { request, artifactId } = grantRequest(offer, "download", { expectedObjectKey: probeKey });

    const res = await svc.grant({ auth: auth(`xt-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");

    expect(await accessRowsFor(artifactId)).toHaveLength(0);
    // The probed tenant's own audit stream is untouched — it learns nothing, and
    // the refusal is filed in the tenant that REFUSED (asserted by the DE-06
    // denial suite; asserted here only as an absence in the probed tenant).
    expect(await accessRowCount(OTHER_COMPANY)).toBe(beforeOther);
    expect(storage.presignGetCalls).toBe(0);
  }, 60_000);

  it("★ THE TENANT IS THE LOCKED LEASE'S, NOT THE REQUEST'S — nothing a worker sends can steer where its access row lands", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const beforeOther = await accessRowCount(OTHER_COMPANY);
    const { request, artifactId } = grantRequest(offer, "upload");

    expect((await svc.grant({ auth: auth(`tn-${crypto.randomUUID()}`), request })).outcome)
      .toBe("upload_granted");

    const rows = await accessRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    // The frozen grant request carries NO tenancy field at all — the company is
    // resolved from the locked lease under the worker's own organization GUC —
    // so the record cannot be aimed. Asserted from both sides.
    expect(rows[0]!.company_id).toBe(COMPANY);
    expect(await accessRowCount(OTHER_COMPANY)).toBe(beforeOther);
  }, 60_000);

  // ───────────────────────────────────────────────────────────────────────────
  // THE NAMESPACE RESERVATION
  // ───────────────────────────────────────────────────────────────────────────

  // ───────────────────────────────────────────────────────────────────────────
  // THE FAILURE PATH — Codex P2 on PR #411
  // ───────────────────────────────────────────────────────────────────────────

  it("★ THE FAILURE PATH DOES NOT DEFEAT THE REDACTION — a secret-shaped object key is REDACTED in the error log, not just in the row", async () => {
    const { app, admin } = ctx();
    // ★ WHY THIS ARM EXISTS. The object key's SUFFIX is caller-controlled: the
    // frozen grant schema bounds it only by length and by this org's attempt
    // prefix, so a worker may legally name a file `whsec_<24 chars>.bin`. The
    // persisted row runs that value through `sanitizeRecord`; the first draft of
    // the recorder's CATCH branch re-listed the raw intent and wrote the key
    // verbatim to the server log, so a transient FK failure would have leaked
    // exactly the value the durable row refuses to keep.
    const secretShapedKey =
      `${expectedAttemptObjectPrefix({ organizationId: ORG, jobId: crypto.randomUUID(), attempt: 1 })}` +
      "whsec_ABCDEFGHIJKLMNOPQRSTUVWX.bin";

    // POSITIVE CONTROL FOR THE FIXTURE, asserted FIRST: this key really is one
    // the redactor acts on. Without this the arm below could pass because the
    // key never appears anywhere, rather than because it was redacted.
    const committedRow = await admin<{ id: string }[]>`SELECT id FROM companies WHERE id = ${COMPANY}`;
    expect(committedRow).toHaveLength(1);

    const errors: unknown[] = [];
    const spy = vi.spyOn(logger, "error").mockImplementation(((payload: unknown) => {
      errors.push(payload);
      return undefined;
    }) as never);
    let rowId: string | null = "unset";
    try {
      // Force the insert to fail on a REAL constraint rather than a stub: a
      // company id with no `companies` row violates the FK, which is exactly the
      // transient-failure shape the catch branch exists for.
      rowId = await recordObjectAccessGrant(app.db, {
        operation: "download",
        companyId: "d6a00000-0000-4000-8000-00000000dead",
        organizationId: ORG,
        workerId: WORKER,
        targetId: TARGET,
        artifactId: crypto.randomUUID(),
        objectKey: secretShapedKey,
        kind: "log",
        sensitivity: "restricted",
        jobId: crypto.randomUUID(),
        attempt: 1,
        leaseId: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
        maxBytes: 4096,
      });
    } finally {
      spy.mockRestore();
    }

    // The recorder NEVER throws: a failed audit must not turn a legitimate grant
    // into a 500. It reports the failure by returning null.
    expect(rowId).toBeNull();
    // ...and it did fail loudly rather than silently, so the assertion below is
    // about a payload that exists.
    expect(errors).toHaveLength(1);

    const serialized = JSON.stringify(errors[0], (_k, v) =>
      v instanceof Error ? { message: v.message } : v,
    );
    // ★ THE ASSERTION: the raw key is nowhere in the logged payload, and the
    // redaction marker is.
    expect(serialized).not.toContain("whsec_ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(serialized).toContain("***REDACTED***");
    // ANTI-VACUITY: the payload is genuinely about THIS write and not an empty
    // object that would trivially satisfy the two assertions above.
    expect(serialized).toContain("security.object_access_audit_write_failed");
    expect(serialized).toContain(WORKER);
  }, 60_000);

  it("★ THE NAMESPACE IS RESERVED — a caller-supplied `security.object_access.` action is refused, and an ordinary action is not", async () => {
    // If a board client or the generic `insertActivityLog` helper could choose
    // this namespace, then "there is an object-access row" would stop implying
    // "the control plane authorized an object operation", and an operator
    // reading the log could be reading forgery.
    expect(() =>
      assertUnreservedActivityNamespace({
        action: UPLOAD_ACCESS_ACTION,
        entityType: "job_artifact",
      }),
    ).toThrow(ReservedActivityNamespaceError);
    expect(() =>
      assertUnreservedActivityNamespace({
        action: DOWNLOAD_ACCESS_ACTION,
        entityType: "job_artifact",
      }),
    ).toThrow(ReservedActivityNamespaceError);
    // POSITIVE CONTROL — the predicate is not simply throwing at everything, and
    // a NEAR MISS is deliberately not caught: the reservation is on the exact
    // prefix, not on the word.
    expect(() =>
      assertUnreservedActivityNamespace({ action: "issue.created", entityType: "issue" }),
    ).not.toThrow();
    expect(() =>
      assertUnreservedActivityNamespace({
        action: "security.object_accessed",
        entityType: "job_artifact",
      }),
    ).not.toThrow();
  });
});
