import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres, { type Sql } from "postgres";
import {
  applyPendingMigrations,
  createOperatorDbConnection,
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
import { runInTenant } from "../db/tenant-context.js";
import { createJobLeasingService, type VerifiedWorkerOperation } from "../services/job-leasing.js";
import { createArtifactTransferGrantService } from "../services/artifact-transfer-grant.js";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "../services/artifact-size-ceiling.js";
import { createArtifactCommitService } from "../services/artifact-commit.js";
import type { StorageProvider, HeadObjectResult, PresignResult } from "../storage/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

// DAT-002 slices 4 + 5 — the artifact transfer-grant + fenced-commit services
// against embedded-PG with a STUBBED object store. Every fail-closed acceptance
// (prefix / hash / size / tenant / fence / idempotency) is proven in-process; the
// live presigned-PUT round-trip is the separate MinIO tier.

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "a5000000-0000-4000-8000-000000000001";
const COMPANY = "a5000000-0000-4000-8000-000000000002";
const TARGET = "a5000000-0000-4000-8000-000000000003";
const WORKER = "a5000000-0000-4000-8000-000000000005";
const OTHER_ORG = "a5000000-0000-4000-8000-0000000000aa";
const OTHER_COMPANY = "a5000000-0000-4000-8000-0000000000bb";
const PASSWORD = "dat-002-role-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;

const integration = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "dat-002-provider",
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
    agentVersion: "dat-002-integration",
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

/** A configurable in-memory object store. Each test sets its head/presign behavior. */
function makeStubStorage(): StorageProvider & {
  headResult: HeadObjectResult;
  presignCalls: string[];
  headCalls: string[];
} {
  const state = {
    headResult: { exists: true, contentLength: 0, checksumSha256: "0".repeat(64) } as HeadObjectResult,
    presignCalls: [] as string[],
    headCalls: [] as string[],
  };
  return {
    id: "s3",
    get headResult() { return state.headResult; },
    set headResult(v: HeadObjectResult) { state.headResult = v; },
    get presignCalls() { return state.presignCalls; },
    get headCalls() { return state.headCalls; },
    async putObject() {},
    async getObject() { throw new Error("not used"); },
    async headObject(input) { state.headCalls.push(input.objectKey); return state.headResult; },
    async deleteObject() {},
    async presignPut(input): Promise<PresignResult> {
      state.presignCalls.push(`PUT ${input.objectKey}`);
      return { method: "PUT", url: `https://worker.example/put/${encodeURIComponent(input.objectKey)}?sig=1`, headers: {} };
    },
    async presignGet(input): Promise<PresignResult> {
      state.presignCalls.push(`GET ${input.objectKey}`);
      return { method: "GET", url: `https://worker.example/get/${encodeURIComponent(input.objectKey)}?sig=1`, headers: {} };
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

integration("DAT-002 artifact transfer-grant + fenced commit", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let operator: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;
  let ordinalCounter = 6_000;

  function guardCtx() {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!admin || !app || !operator) throw new Error("test setup incomplete");
    return { admin, app, operator };
  }

  function auth(proofId: string): VerifiedWorkerOperation {
    return {
      organizationId: ORG,
      workerId: WORKER,
      targetId: TARGET,
      targetGeneration: 1,
      deviceThumbprint: THUMBPRINT,
      profileHash: WORKER_PROFILE_HASH,
      publicKey: "dat-002-public-key",
      proofId,
      proofIssuedAt: new Date(),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  async function resetRuntimeRows(): Promise<void> {
    const { admin } = guardCtx();
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
      device_public_key = 'dat-002-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  async function seedPlacedJob(ordinal: number): Promise<{ jobId: string; attemptId: string }> {
    const { admin } = guardCtx();
    const suffix = ordinal.toString().padStart(12, "0");
    const jobId = `a5100000-0000-4000-8000-${suffix}`;
    const attemptId = `a5200000-0000-4000-8000-${suffix}`;
    const outboxId = `a5300000-0000-4000-8000-${suffix}`;
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
         'system', 'dat-002-test', 'worker', ${WORKER}, ${workload},
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
    return { jobId, attemptId };
  }

  async function activateLease(): Promise<{ seeded: { jobId: string; attemptId: string }; offer: LeaseOfferV1 }> {
    const { app } = guardCtx();
    const ordinal = ordinalCounter++;
    await resetRuntimeRows();
    const seeded = await seedPlacedJob(ordinal);
    const service = createJobLeasingService({ appDb: app.db });
    const polled = await service.poll({ auth: auth(`p-${ordinal}`), request: pollRequest(`p-${ordinal}`) });
    if (polled.outcome !== "offer") throw new Error(`expected offer, got ${polled.outcome}`);
    const offer = polled.body;
    const acked = await service.ack({ auth: auth(`a-${ordinal}`), request: ackRequest(offer) });
    if (acked.outcome !== "acknowledged") throw new Error("expected ack");
    return { seeded, offer };
  }

  async function expireLease(leaseId: string): Promise<void> {
    const { admin } = guardCtx();
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() - interval '2 seconds',
      expires_at = clock_timestamp() - interval '1 second' WHERE id = ${leaseId}`;
  }

  function objectKey(jobId: string, name = "out.bin"): string {
    return `${expectedAttemptObjectPrefix({ organizationId: ORG, jobId, attempt: 1 })}${name}`;
  }

  function grantRequest(offer: LeaseOfferV1, operation: "upload" | "download", overrides: Record<string, unknown> = {}) {
    const artifactId = crypto.randomUUID();
    return {
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
          expectedObjectKey: objectKey(offer.job.jobId),
          expectedSha256: "a".repeat(64),
          maxBytes: 4096,
          ...overrides,
        },
      },
      artifactId,
    };
  }

  function commitRequest(
    offer: LeaseOfferV1,
    manifest: Partial<Record<string, unknown>> = {},
  ) {
    const artifactId = (manifest.artifactId as string) ?? crypto.randomUUID();
    const key = (manifest.objectKey as string) ?? objectKey(offer.job.jobId);
    return {
      artifactId,
      objectKey: key,
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
            objectKey: key,
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

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-dat002-"));
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
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", PASSWORD));
      app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 16 });
      operator = createOperatorDbConnection(adminUrl.replace("test:test", `aoa_operator:${PASSWORD}`), { max: 8 });
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DAT-002 org', 'dat-002-org')`;
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${OTHER_ORG}, 'DAT-002 other', 'dat-002-other')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'DAT-002 company', 'D002')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${OTHER_COMPANY}, ${OTHER_ORG}, 'DAT-002 other company', 'D002O')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'dat-002-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'dat-002-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'DAT-002 worker', 'enrolled')`;
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await operator?.close({ timeoutSeconds: 5 }).catch(() => {});
    await app?.close({ timeoutSeconds: 5 }).catch(() => {});
    await admin?.end().catch(() => {});
    await embedded?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  // ---- transfer grant ------------------------------------------------------

  it("issues an upload grant on a live fence (direct-to-store bypass)", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { request } = grantRequest(offer, "upload");
    const res = await svc.grant({ auth: auth(`gu-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("upload_granted");
    if (res.outcome !== "upload_granted") return;
    expect(res.grant.method).toBe("PUT");
    expect(res.grant.url.startsWith("https://")).toBe(true);
    expect(res.grant.objectKey).toBe(objectKey(offer.job.jobId));
    expect(res.grant.redaction).toBe("secret");
    expect(storage.presignCalls).toContain(`PUT ${objectKey(offer.job.jobId)}`);
  }, 60_000);

  it("★ BRW-003d-5 refuses a grant whose DECLARED size exceeds the ceiling, before a byte moves", async () => {
    // The frozen request bounds maxBytes only by Number.MAX_SAFE_INTEGER, and a
    // presigned PUT imposes no size bound at the store — so before this the ONLY
    // ceiling was at commit, i.e. AFTER the object had been written. That refusal
    // leaves an orphan the sweeper has to find, and spends the egress to get there.
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { request } = grantRequest(offer, "upload", {
      maxBytes: DEFAULT_MAX_ARTIFACT_BYTES + 1,
    });
    const res = await svc.grant({ auth: auth(`gmax-${crypto.randomUUID()}`), request });
    expect(res.outcome).not.toBe("upload_granted");
    // ★ AND NO PRESIGN HAPPENED. Refusing after minting the URL would defeat the
    // point: the grant is the capability, so the test asserts the capability was
    // never created rather than merely that the response said no.
    expect(storage.presignCalls).toHaveLength(0);
  }, 60_000);

  it("still grants at exactly the ceiling", async () => {
    // The boundary is inclusive; an off-by-one here would refuse a legal artifact.
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { request } = grantRequest(offer, "upload", { maxBytes: DEFAULT_MAX_ARTIFACT_BYTES });
    const res = await svc.grant({ auth: auth(`gceil-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("upload_granted");
  }, 60_000);

  it("rejects an upload grant on a stale fence", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    await expireLease(offer.leaseId);
    const { request } = grantRequest(offer, "upload");
    const res = await svc.grant({ auth: auth(`gs-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("stale_fence");
    expect(storage.presignCalls).toHaveLength(0); // no grant minted
  }, 60_000);

  it("issues a download grant for a committed artifact even after the fence is lost", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const grantSvc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const commitSvc = createArtifactCommitService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    // Commit first (fence active) so a committed row exists.
    const { artifactId, objectKey: key } = commitRequest(offer);
    storage.headResult = { exists: true, contentLength: 128, checksumSha256: "b".repeat(64) };
    const committed = await commitSvc.commit({ auth: auth(`dc-${crypto.randomUUID()}`),
      request: commitRequest(offer, { artifactId, objectKey: key }).request });
    expect(committed.outcome).toBe("committed");
    // Lose the fence, then request a download grant — must still succeed.
    await expireLease(offer.leaseId);
    const { request } = grantRequest(offer, "download", { artifactId, expectedObjectKey: key });
    const res = await grantSvc.grant({ auth: auth(`dg-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("download_granted");
    if (res.outcome !== "download_granted") return;
    expect(res.grant.method).toBe("GET");
    expect(res.grant.url.startsWith("https://")).toBe(true);
  }, 60_000);

  it("rejects a download grant when no committed artifact exists", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { request } = grantRequest(offer, "download");
    const res = await svc.grant({ auth: auth(`dn-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(storage.presignCalls).toHaveLength(0);
  }, 60_000);

  // ---- BRW-003a: findCommitted answers two OPPOSITE questions ---------------
  //
  // `findCommitted` filters status='committed' and is called from two places that want
  // opposite answers:
  //   :111 the Rule #7 immutability guard  -> "did this identity EVER commit?"  (expired COUNTS)
  //   :149 the download branch             -> "is it still READABLE?"           (expired does NOT)
  // No status value satisfies both, so the function splits. See BRW-003a-design.md.
  //
  // These tests write status='expired' directly. Nothing writes it in production until
  // BRW-003c — that is exactly why 003a lands first, on the clean shape, before the write
  // that would otherwise turn this into a regression to chase. `job_artifacts.status` has
  // no CHECK constraint (verified in schema AND the applied snapshot), so the state is
  // constructible today.

  /** Commit an artifact, then force it to the state BRW-003c will produce. */
  async function commitThenExpire(offer: LeaseOfferV1, storage: ReturnType<typeof makeStubStorage>) {
    const { admin, app } = guardCtx();
    const commitSvc = createArtifactCommitService({ appDb: app.db, storage });
    const { artifactId, objectKey: key } = commitRequest(offer);
    storage.headResult = { exists: true, contentLength: 128, checksumSha256: "b".repeat(64) };
    const committed = await commitSvc.commit({
      auth: auth(`ce-${crypto.randomUUID()}`),
      request: commitRequest(offer, { artifactId, objectKey: key }).request,
    });
    expect(committed.outcome).toBe("committed");
    await admin`UPDATE job_artifacts SET status = 'expired' WHERE identifier = ${artifactId}`;
    return { artifactId, key };
  }

  it("BRW-003a: an EXPIRED identity is REFUSED a new upload grant (Rule #7)", async () => {
    // The immutability guard must count expired. If it does not, retention deletes the
    // bytes, the identity drops out of the committed partial-unique, and the same key
    // becomes re-grantable and re-committable — bytes a reader still trusts, overwritten.
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { artifactId, key } = await commitThenExpire(offer, storage);

    const { request } = grantRequest(offer, "upload", { artifactId, expectedObjectKey: key });
    const res = await svc.grant({ auth: auth(`eu-${crypto.randomUUID()}`), request });

    expect(res.outcome).toBe("rejected");
    expect(storage.presignCalls).toHaveLength(0);
  }, 60_000);

  it("BRW-003a: an EXPIRED identity is REFUSED a download grant (bytes are gone)", async () => {
    // The opposite half. Expiry deleted the object, so a download grant would hand out a
    // URL for bytes that no longer exist.
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { artifactId, key } = await commitThenExpire(offer, storage);

    const { request } = grantRequest(offer, "download", { artifactId, expectedObjectKey: key });
    const res = await svc.grant({ auth: auth(`ed-${crypto.randomUUID()}`), request });

    expect(res.outcome).toBe("rejected");
    expect(storage.presignCalls).toHaveLength(0);
  }, 60_000);

  it("BRW-003a: with NO expired rows, behaviour is unchanged — upload refused, download granted", async () => {
    // The test that makes this landable first. It pins that the refactor alters nothing
    // observable while 'expired' does not exist, so it cannot quietly change a grant or
    // download decision before BRW-003c arrives.
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const grantSvc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const commitSvc = createArtifactCommitService({ appDb: app.db, storage });
    const { offer } = await activateLease();

    const { artifactId, objectKey: key } = commitRequest(offer);
    storage.headResult = { exists: true, contentLength: 128, checksumSha256: "b".repeat(64) };
    const committed = await commitSvc.commit({
      auth: auth(`uc-${crypto.randomUUID()}`),
      request: commitRequest(offer, { artifactId, objectKey: key }).request,
    });
    expect(committed.outcome).toBe("committed");

    // Committed (not expired): upload still refused by the guard...
    const up = await grantSvc.grant({
      auth: auth(`uu-${crypto.randomUUID()}`),
      request: grantRequest(offer, "upload", { artifactId, expectedObjectKey: key }).request,
    });
    expect(up.outcome).toBe("rejected");

    // ...and download still granted.
    const down = await grantSvc.grant({
      auth: auth(`ud-${crypto.randomUUID()}`),
      request: grantRequest(offer, "download", { artifactId, expectedObjectKey: key }).request,
    });
    expect(down.outcome).toBe("download_granted");
  }, 60_000);

  it("BRW-003a: findEverCommitted SHORT-CIRCUITS — one query on a hit, two only on a miss", async () => {
    // ★ Closes the coverage gap the review found: the two-lookup shape is a PERFORMANCE
    // claim, and a claim with no assertion is the shape this programme keeps shipping.
    //
    // `job_artifacts_committed_identity_uidx` is PARTIAL (`WHERE status = 'committed'`), so
    // a `status IN ('committed','expired')` predicate CANNOT use it — the planner falls back
    // to the jobId-only index plus a filter, on the hot path. Without this test, someone
    // later "simplifies" the two lookups into one IN query, every other test still passes,
    // and the index is silently lost. Counting the queries is the only thing that fails.
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const commitSvc = createArtifactCommitService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { artifactId, objectKey: key } = commitRequest(offer);
    storage.headResult = { exists: true, contentLength: 128, checksumSha256: "b".repeat(64) };
    const committed = await commitSvc.commit({
      auth: auth(`sc-${crypto.randomUUID()}`),
      request: commitRequest(offer, { artifactId, objectKey: key }).request,
    });
    expect(committed.outcome).toBe("committed");

    await runInTenant(app.db, ORG, async (repos) => {
      const seen: string[] = [];
      const real = repos.jobArtifacts.findByIdentityWithStatus.bind(repos.jobArtifacts);
      // `findEverCommitted` delegates through `this.`, so wrapping the property here is
      // observed by it. That dispatch choice is what makes this assertion possible at all.
      repos.jobArtifacts.findByIdentityWithStatus = async (input, status) => {
        seen.push(status);
        return real(input, status);
      };

      // HIT: the identity is committed -> exactly ONE lookup, on the partial index.
      const hit = await repos.jobArtifacts.findEverCommitted({
        jobId: offer.job.jobId, attempt: offer.job.attempt, identifier: artifactId,
      });
      expect(hit).not.toBeNull();
      expect(seen).toEqual(["committed"]);

      // MISS: unknown identity -> TWO lookups, committed then expired.
      seen.length = 0;
      const miss = await repos.jobArtifacts.findEverCommitted({
        jobId: offer.job.jobId, attempt: offer.job.attempt, identifier: crypto.randomUUID(),
      });
      expect(miss).toBeNull();
      expect(seen).toEqual(["committed", "expired"]);
    });
  }, 60_000);

  // ---- fenced commit -------------------------------------------------------

  it("commits a verified manifest and returns {artifactId, versionNumber, committedAt}", async () => {
    const { app, admin } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { seeded, offer } = await activateLease();
    const { artifactId, request } = commitRequest(offer, { sha256: "c".repeat(64), sizeBytes: 256 });
    storage.headResult = { exists: true, contentLength: 256, checksumSha256: "c".repeat(64) };
    const res = await svc.commit({ auth: auth(`ok-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("committed");
    if (res.outcome !== "committed") return;
    expect(res.artifactId).toBe(artifactId);
    expect(res.versionNumber).toBeGreaterThanOrEqual(1);
    expect(typeof res.committedAt).toBe("string");
    // The rich committed row round-trips the persisted columns.
    const [row] = await admin<{ status: string; sha256: string; size: string; version: number; objectKey: string }[]>`
      SELECT status, sha256, size_bytes::text AS size, version_number AS version, object_key AS "objectKey"
      FROM job_artifacts WHERE job_id = ${seeded.jobId} AND identifier = ${artifactId}`;
    expect(row).toMatchObject({ status: "committed", sha256: "c".repeat(64), size: "256", version: res.versionNumber });
  }, 60_000);

  it("is idempotent: replaying the same commit returns the same version, one row", async () => {
    const { app, admin } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { seeded, offer } = await activateLease();
    const base = commitRequest(offer, { sha256: "d".repeat(64), sizeBytes: 64 });
    storage.headResult = { exists: true, contentLength: 64, checksumSha256: "d".repeat(64) };
    const first = await svc.commit({ auth: auth(`id1-${crypto.randomUUID()}`), request: base.request });
    expect(first.outcome).toBe("committed");
    // Replay with a fresh envelope (new correlationId/nonce/idempotencyKey) but the
    // SAME artifact identity + object → same committed row.
    const replay = commitRequest(offer, { artifactId: base.artifactId, objectKey: base.objectKey, sha256: "d".repeat(64), sizeBytes: 64 });
    const second = await svc.commit({ auth: auth(`id2-${crypto.randomUUID()}`), request: replay.request });
    expect(second.outcome).toBe("committed");
    if (first.outcome !== "committed" || second.outcome !== "committed") return;
    expect(second.versionNumber).toBe(first.versionNumber);
    const [{ count }] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM job_artifacts
      WHERE job_id = ${seeded.jobId} AND identifier = ${base.artifactId} AND status = 'committed'`;
    expect(count).toBe(1);
  }, 60_000);

  it("decides fence staleness BEFORE hash: a stale fence with a wrong hash rejects stale_fence", async () => {
    const { app, admin } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { seeded, offer } = await activateLease();
    const { artifactId, request } = commitRequest(offer, { sha256: "1".repeat(64), sizeBytes: 10 });
    // Object exists but its hash disagrees with the manifest AND the fence is stale.
    storage.headResult = { exists: true, contentLength: 10, checksumSha256: "9".repeat(64) };
    await expireLease(offer.leaseId);
    const res = await svc.commit({ auth: auth(`pf-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("stale_fence"); // fence precedence, NOT event_hash_mismatch
    const [{ count }] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM job_artifacts WHERE job_id = ${seeded.jobId} AND identifier = ${artifactId}`;
    expect(count).toBe(0); // no write
  }, 60_000);

  it("rejects a sha256 mismatch", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { request } = commitRequest(offer, { sha256: "2".repeat(64), sizeBytes: 20 });
    storage.headResult = { exists: true, contentLength: 20, checksumSha256: "8".repeat(64) };
    const res = await svc.commit({ auth: auth(`hm-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("event_hash_mismatch");
  }, 60_000);

  it("rejects a size mismatch", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { request } = commitRequest(offer, { sha256: "3".repeat(64), sizeBytes: 30 });
    storage.headResult = { exists: true, contentLength: 31, checksumSha256: "3".repeat(64) };
    const res = await svc.commit({ auth: auth(`sm-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("malformed");
  }, 60_000);

  it("rejects a wrong-prefix (foreign-org key) manifest", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    // A manifest whose org + objectKey are a DIFFERENT org (schema-valid, but the
    // AUTH-org prefix check fails).
    const foreignKey = `${expectedAttemptObjectPrefix({ organizationId: OTHER_ORG, jobId: offer.job.jobId, attempt: 1 })}x.bin`;
    const { request } = commitRequest(offer, {
      organizationId: OTHER_ORG, objectKey: foreignKey, sha256: "4".repeat(64), sizeBytes: 40,
    });
    storage.headResult = { exists: true, contentLength: 40, checksumSha256: "4".repeat(64) };
    const res = await svc.commit({ auth: auth(`wp-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("malformed");
  }, 60_000);

  it("rejects a foreign-company (tenant) manifest", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { request } = commitRequest(offer, { companyId: OTHER_COMPANY, sha256: "5".repeat(64), sizeBytes: 50 });
    storage.headResult = { exists: true, contentLength: 50, checksumSha256: "5".repeat(64) };
    const res = await svc.commit({ auth: auth(`tn-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("malformed");
  }, 60_000);

  it("rejects a commit when the object is missing/incomplete", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { request } = commitRequest(offer);
    storage.headResult = { exists: false };
    const res = await svc.commit({ auth: auth(`mo-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("malformed");
  }, 60_000);

  it("rejects a commit against a terminal attempt", async () => {
    const { app, admin } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { seeded, offer } = await activateLease();
    await admin`UPDATE job_attempts SET status = 'succeeded' WHERE id = ${seeded.attemptId}`;
    const { request } = commitRequest(offer, { sha256: "6".repeat(64), sizeBytes: 60 });
    storage.headResult = { exists: true, contentLength: 60, checksumSha256: "6".repeat(64) };
    const res = await svc.commit({ auth: auth(`tm-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("attempt_terminal");
  }, 60_000);

  // ---- adversarial-review regressions --------------------------------------

  // Review finding B/#2 (HIGH) — the upload grant must bind expectedObjectKey to the
  // AUTH org prefix (never mint a presigned PUT into a foreign org's namespace).
  it("rejects an upload grant whose expectedObjectKey is a foreign-org key", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const foreignKey = `${expectedAttemptObjectPrefix({ organizationId: OTHER_ORG, jobId: offer.job.jobId, attempt: 1 })}evil.bin`;
    const { request } = grantRequest(offer, "upload", { expectedObjectKey: foreignKey });
    const res = await svc.grant({ auth: auth(`ufp-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("malformed");
    expect(storage.presignCalls).toHaveLength(0); // no foreign-namespace PUT minted
  }, 60_000);

  // Review finding C/#3 (MED) — an already-committed artifact is IMMUTABLE; a
  // re-upload grant for its key must be refused (no post-commit overwrite TOCTOU).
  it("rejects a re-upload grant for an already-committed artifact (immutable)", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const grantSvc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const commitSvc = createArtifactCommitService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const { artifactId, objectKey: key } = commitRequest(offer);
    storage.headResult = { exists: true, contentLength: 128, checksumSha256: "b".repeat(64) };
    const committed = await commitSvc.commit({
      auth: auth(`cc-${crypto.randomUUID()}`),
      request: commitRequest(offer, { artifactId, objectKey: key }).request,
    });
    expect(committed.outcome).toBe("committed");
    const { request } = grantRequest(offer, "upload", { artifactId, expectedObjectKey: key });
    const res = await grantSvc.grant({ auth: auth(`cu-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("malformed");
  }, 60_000);

  // Review finding D/#1 (MED) — a server-authoritative absolute size cap; an object
  // larger than the cap must not commit even when declared == actual.
  it("rejects a commit whose actual object size exceeds the server artifact cap", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage, maxArtifactBytes: 1024 });
    const { offer } = await activateLease();
    const { request } = commitRequest(offer, { sha256: "7".repeat(64), sizeBytes: 4096 });
    storage.headResult = { exists: true, contentLength: 4096, checksumSha256: "7".repeat(64) };
    const res = await svc.commit({ auth: auth(`cap-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("malformed");
  }, 60_000);

  // Review finding A/#5 (HIGH) — the object store must NOT be probed before the fence
  // identity is resolved (an unresolvable fence must reject BEFORE any headObject, so
  // a caller cannot use object-existence as a cross-tenant oracle).
  it("does not probe object storage before the fence identity is resolved", async () => {
    const { app } = guardCtx();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { offer } = await activateLease();
    const built = commitRequest(offer, { sha256: "a".repeat(64), sizeBytes: 8 });
    // A syntactically valid but unresolvable lease → resolveWorkerFenceContext throws
    // BEFORE the object is touched.
    built.request.body.leaseId = crypto.randomUUID();
    storage.headResult = { exists: true, contentLength: 8, checksumSha256: "a".repeat(64) };
    await expect(svc.commit({ auth: auth(`orc-${crypto.randomUUID()}`), request: built.request })).rejects.toThrow();
    expect(storage.headCalls).toHaveLength(0);
  }, 60_000);
});
