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
  expectedQuarantineObjectPrefix,
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { createJobLeasingService, type VerifiedWorkerOperation } from "../services/job-leasing.js";
import { createQuarantineGrantService } from "../services/quarantine-grant.js";
import { createQuarantineFinalizeService } from "../services/quarantine-finalize.js";
import type { StorageProvider, HeadObjectResult } from "../storage/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

const ORG = "a6000000-0000-4000-8000-000000000001";
const COMPANY = "a6000000-0000-4000-8000-000000000002";
const TARGET = "a6000000-0000-4000-8000-000000000003";
const WORKER = "a6000000-0000-4000-8000-000000000005";
const OTHER_ORG = "a6000000-0000-4000-8000-0000000000aa";
const OTHER_COMPANY = "a6000000-0000-4000-8000-0000000000bb";
const PASSWORD = "dat-006-role-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;

const integration = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "dat-006-provider",
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
    agentVersion: "dat-006-integration",
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

interface StoredObject { contentLength: number; checksumSha256: string }

/** A per-key in-memory object store: head reads from a seedable map; presign records. */
function makeMapStorage(): StorageProvider & {
  put(key: string, size: number, sha: string): void;
  setHead(key: string, head: HeadObjectResult): void;
  presignCalls: string[];
  headCalls: string[];
} {
  const objects = new Map<string, StoredObject>();
  const overrides = new Map<string, HeadObjectResult>();
  const presignCalls: string[] = [];
  const headCalls: string[] = [];
  return {
    id: "s3",
    put(key, size, sha) { objects.set(key, { contentLength: size, checksumSha256: sha }); },
    setHead(key, head) { overrides.set(key, head); },
    get presignCalls() { return presignCalls; },
    get headCalls() { return headCalls; },
    async putObject() {},
    async getObject() { throw new Error("not used"); },
    async headObject(inputArg): Promise<HeadObjectResult> {
      headCalls.push(inputArg.objectKey);
      if (overrides.has(inputArg.objectKey)) return overrides.get(inputArg.objectKey)!;
      const obj = objects.get(inputArg.objectKey);
      if (!obj) return { exists: false };
      return { exists: true, contentLength: obj.contentLength, checksumSha256: obj.checksumSha256 };
    },
    async deleteObject() {},
    async presignPut(inputArg) {
      presignCalls.push(`PUT ${inputArg.objectKey}`);
      return { method: "PUT", url: `https://worker.example/put/${encodeURIComponent(inputArg.objectKey)}?sig=1`, headers: {} };
    },
  };
}

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

integration("DAT-006 quarantine (device-authed orphan)", () => {
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
      publicKey: "dat-006-public-key",
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
      device_public_key = 'dat-006-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  async function seedPlacedJob(ordinal: number): Promise<{ jobId: string; attemptId: string }> {
    const { admin } = guardCtx();
    const suffix = ordinal.toString().padStart(12, "0");
    const jobId = `a6100000-0000-4000-8000-${suffix}`;
    const attemptId = `a6200000-0000-4000-8000-${suffix}`;
    const outboxId = `a6300000-0000-4000-8000-${suffix}`;
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
         'system', 'dat-006-test', 'worker', ${WORKER}, ${workload},
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

  const ARTIFACT = "a6400000-0000-4000-8000-000000000abc";

  function grantReq(offer: LeaseOfferV1, over: { sha: string; size: number; keySuffix?: string; reason?: string } ) {
    const key = `${expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}${over.keySuffix ?? "output.bin"}`;
    return {
      protocolVersion: 1 as const,
      correlationId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: `qg-${crypto.randomUUID()}`,
      audience: "device_session" as const,
      idempotencyKey: crypto.randomUUID(),
      body: {
        protocolVersion: 1 as const,
        workerId: WORKER,
        targetId: TARGET,
        deviceGeneration: 1,
        organizationId: ORG,
        companyId: COMPANY,
        jobId: offer.job.jobId,
        attempt: offer.job.attempt,
        observedLeaseId: offer.leaseId,
        observedFenceToken: offer.fenceToken,
        reason: over.reason ?? "late_output",
        artifactId: ARTIFACT,
        expectedObjectKey: key,
        expectedSha256: over.sha,
        sizeBytes: over.size,
      },
    };
  }

  function finalizeReq(offer: LeaseOfferV1, over: { sha: string; size: number; keySuffix?: string; reason?: string }) {
    const quarantineKey = `${expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}${over.keySuffix ?? "output.bin"}`;
    const ordinaryKey = `${expectedAttemptObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}${over.keySuffix ?? "output.bin"}`;
    return {
      protocolVersion: 1 as const,
      correlationId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: `qf-${crypto.randomUUID()}`,
      audience: "device_session" as const,
      idempotencyKey: crypto.randomUUID(),
      body: {
        protocolVersion: 1 as const,
        workerId: WORKER,
        targetId: TARGET,
        deviceGeneration: 1,
        organizationId: ORG,
        companyId: COMPANY,
        jobId: offer.job.jobId,
        attempt: offer.job.attempt,
        observedLeaseId: offer.leaseId,
        observedFenceToken: offer.fenceToken,
        reason: over.reason ?? "late_output",
        artifactId: ARTIFACT,
        quarantineObjectKey: quarantineKey,
        expectedSha256: over.sha,
        sizeBytes: over.size,
        manifest: {
          protocolVersion: 1 as const,
          organizationId: ORG,
          companyId: COMPANY,
          jobId: offer.job.jobId,
          attempt: offer.job.attempt,
          artifactId: ARTIFACT,
          kind: "other" as const,
          sensitivity: "restricted" as const,
          retention: "run" as const,
          objectKey: ordinaryKey,
          sizeBytes: over.size,
          sha256: over.sha,
          contentType: "application/octet-stream",
          createdAt: new Date().toISOString(),
        },
      },
    };
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-dat006-"));
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
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DAT-006 org', 'dat-006-org')`;
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${OTHER_ORG}, 'DAT-006 other', 'dat-006-other')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'DAT-006 company', 'D006')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${OTHER_COMPANY}, ${OTHER_ORG}, 'DAT-006 other company', 'D006O')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'dat-006-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'dat-006-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'DAT-006 worker', 'enrolled')`;
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

  it("grants a scoped presigned PUT under the DISTINCT quarantine/ prefix (≤5-min expiry)", async () => {
    const { app } = guardCtx();
    const { offer } = await activateLease();
    const storage = makeMapStorage();
    const svc = createQuarantineGrantService({ appDb: app.db, storage });
    const sha = "a".repeat(64);
    const res = await svc.grant({ auth: auth(`qg-${crypto.randomUUID()}`), request: grantReq(offer, { sha, size: 128 }) });
    expect(res.outcome).toBe("quarantine_upload_granted");
    if (res.outcome !== "quarantine_upload_granted") return;
    expect(res.grant.quarantineObjectKey.startsWith("quarantine/organizations/")).toBe(true);
    expect(res.grant.url.startsWith("https://")).toBe(true);
    const ttlMs = Date.parse(res.grant.expiresAt) - Date.parse(res.grant.issuedAt);
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(storage.presignCalls.some((c) => c.startsWith("PUT quarantine/"))).toBe(true);
  }, 60_000);

  it("refuses a grant whose body binds a FOREIGN org (non-disclosing, no presign)", async () => {
    const { app } = guardCtx();
    const { offer } = await activateLease();
    const storage = makeMapStorage();
    const svc = createQuarantineGrantService({ appDb: app.db, storage });
    // A schema-valid body whose organizationId + key point at a FOREIGN org (the frozen
    // schema binds the key to body.organizationId, so this parses). The authenticated
    // worker is ORG; the org-binding guard refuses BEFORE any presign, non-disclosingly.
    const req = grantReq(offer, { sha: "a".repeat(64), size: 10 });
    req.body.organizationId = OTHER_ORG;
    req.body.companyId = OTHER_COMPANY;
    req.body.expectedObjectKey = `quarantine/organizations/${OTHER_ORG}/jobs/${offer.job.jobId}/attempts/${offer.job.attempt}/x.bin`;
    await expect(svc.grant({ auth: auth(`qg-${crypto.randomUUID()}`), request: req }))
      .rejects.toThrow(/unauthorized/);
    expect(storage.presignCalls).toEqual([]);
  }, 60_000);

  it("(18) finalizes an orphan → distinct quarantine/ prefix, retains sha/size/provenance, disposition=quarantined", async () => {
    const { app, admin } = guardCtx();
    const { offer, seeded } = await activateLease();
    const storage = makeMapStorage();
    const sha = "b".repeat(64);
    const key = `${expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}output.bin`;
    storage.put(key, 256, sha);
    const svc = createQuarantineFinalizeService({ appDb: app.db, storage });
    const res = await svc.finalize({ auth: auth(`qf-${crypto.randomUUID()}`), request: finalizeReq(offer, { sha, size: 256 }) });
    expect(res.outcome).toBe("quarantined");
    if (res.outcome !== "quarantined") return;
    expect(res.receipt.disposition).toBe("quarantined");
    expect(res.receipt.artifact.provenance).toBe("generated");
    const [row] = await admin<{ status: string; ok: string; sha: string; size: string; disp: string; reason: string; lease: string; fence: string }[]>`
      SELECT status, object_key AS ok, sha256 AS sha, size_bytes AS size, orphan_disposition AS disp,
             quarantine_reason AS reason, observed_lease_id AS lease, observed_fence_token AS fence
      FROM job_artifacts WHERE job_id = ${seeded.jobId} AND identifier = ${ARTIFACT} AND status = 'quarantined'`;
    expect(row.status).toBe("quarantined");
    expect(row.ok.startsWith("quarantine/organizations/")).toBe(true);
    expect(row.sha).toBe(sha);
    expect(Number(row.size)).toBe(256);
    expect(row.disp).toBe("quarantined");
    expect(row.reason).toBe("late_output");
    expect(row.lease).toBe(offer.leaseId);
    expect(row.fence).toBe(offer.fenceToken);
  }, 60_000);

  it("(10) an EXPIRED/dead fence still quarantines the orphan (never stale_fence) and leaves the source untouched", async () => {
    const { app, admin } = guardCtx();
    const { offer, seeded } = await activateLease();
    await expireLease(offer.leaseId); // dead fence — this is precisely why it's an orphan
    const storage = makeMapStorage();
    const sha = "c".repeat(64);
    const key = `${expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}output.bin`;
    storage.put(key, 64, sha);
    const svc = createQuarantineFinalizeService({ appDb: app.db, storage });
    const res = await svc.finalize({ auth: auth(`qf-${crypto.randomUUID()}`), request: finalizeReq(offer, { sha, size: 64, reason: "stale_fence" }) });
    expect(res.outcome).toBe("quarantined"); // NOT rejected(stale_fence)
    const [{ n }] = await admin<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM job_artifacts WHERE job_id = ${seeded.jobId} AND status = 'committed'`;
    expect(n).toBe(0); // no committed source row was created/mutated
  }, 60_000);

  it("(19) an orphan CANNOT collide-update a committed attempt (disjoint partial-unique)", async () => {
    const { app, admin } = guardCtx();
    const { offer, seeded } = await activateLease();
    // A pre-existing committed artifact for the SAME (job, attempt, identifier).
    const committedKey = `${expectedAttemptObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}output.bin`;
    await admin`INSERT INTO job_artifacts
      (organization_id, job_id, identifier, object_key, sha256, size_bytes, kind, sensitivity, retention,
       attempt, status, version_number, committed_at)
      VALUES (${ORG}, ${seeded.jobId}, ${ARTIFACT}, ${committedKey}, ${"d".repeat(64)}, 999, 'other',
        'restricted', 'run', ${offer.job.attempt}, 'committed', 1, clock_timestamp())`;
    const storage = makeMapStorage();
    const sha = "e".repeat(64);
    const key = `${expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}output.bin`;
    storage.put(key, 32, sha);
    const svc = createQuarantineFinalizeService({ appDb: app.db, storage });
    const res = await svc.finalize({ auth: auth(`qf-${crypto.randomUUID()}`), request: finalizeReq(offer, { sha, size: 32 }) });
    expect(res.outcome).toBe("quarantined");
    // The committed row is UNTOUCHED; a separate quarantined row now coexists.
    const [committed] = await admin<{ sha: string; size: string; ok: string }[]>`
      SELECT sha256 AS sha, size_bytes AS size, object_key AS ok FROM job_artifacts
      WHERE job_id = ${seeded.jobId} AND identifier = ${ARTIFACT} AND status = 'committed'`;
    expect(committed.sha).toBe("d".repeat(64));
    expect(Number(committed.size)).toBe(999);
    expect(committed.ok).toBe(committedKey);
    const [{ n }] = await admin<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM job_artifacts WHERE job_id = ${seeded.jobId} AND identifier = ${ARTIFACT}`;
    expect(n).toBe(2); // committed + quarantined coexist
  }, 60_000);

  it("(20) a duplicate finalize is an idempotent DO-NOTHING (one row, same receiptId)", async () => {
    const { app, admin } = guardCtx();
    const { offer, seeded } = await activateLease();
    const storage = makeMapStorage();
    const sha = "f".repeat(64);
    const key = `${expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}output.bin`;
    storage.put(key, 16, sha);
    const svc = createQuarantineFinalizeService({ appDb: app.db, storage });
    const first = await svc.finalize({ auth: auth(`qf-${crypto.randomUUID()}`), request: finalizeReq(offer, { sha, size: 16 }) });
    const second = await svc.finalize({ auth: auth(`qf-${crypto.randomUUID()}`), request: finalizeReq(offer, { sha, size: 16 }) });
    expect(first.outcome).toBe("quarantined");
    expect(second.outcome).toBe("quarantined");
    if (first.outcome !== "quarantined" || second.outcome !== "quarantined") return;
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    const [{ n }] = await admin<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM job_artifacts WHERE job_id = ${seeded.jobId} AND status = 'quarantined'`;
    expect(n).toBe(1);
  }, 60_000);

  it("(21) a partial write / size mismatch FAILS CLOSED (malformed) with no orphan row", async () => {
    const { app, admin } = guardCtx();
    const { offer, seeded } = await activateLease();
    const storage = makeMapStorage();
    const sha = "1".repeat(64);
    const key = `${expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}output.bin`;
    // Object exists but is SHORTER than declared (a partial write).
    storage.setHead(key, { exists: true, contentLength: 5, checksumSha256: sha });
    const svc = createQuarantineFinalizeService({ appDb: app.db, storage });
    const res = await svc.finalize({ auth: auth(`qf-${crypto.randomUUID()}`), request: finalizeReq(offer, { sha, size: 100 }) });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("malformed");
    const [{ n }] = await admin<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM job_artifacts WHERE job_id = ${seeded.jobId} AND status = 'quarantined'`;
    expect(n).toBe(0);
  }, 60_000);

  it("a hash mismatch fails closed as event_hash_mismatch with no orphan row", async () => {
    const { app, admin } = guardCtx();
    const { offer, seeded } = await activateLease();
    const storage = makeMapStorage();
    const key = `${expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}output.bin`;
    storage.setHead(key, { exists: true, contentLength: 40, checksumSha256: "9".repeat(64) });
    const svc = createQuarantineFinalizeService({ appDb: app.db, storage });
    const res = await svc.finalize({ auth: auth(`qf-${crypto.randomUUID()}`), request: finalizeReq(offer, { sha: "2".repeat(64), size: 40 }) });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("event_hash_mismatch");
    const [{ n }] = await admin<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM job_artifacts WHERE job_id = ${seeded.jobId} AND status = 'quarantined'`;
    expect(n).toBe(0);
  }, 60_000);

  it("(12b) rejects an orphan whose attempt was placed on a DIFFERENT target (cross-owner forge) → malformed, no row", async () => {
    const { app, admin } = guardCtx();
    const { offer, seeded } = await activateLease();
    // Re-home the attempt's placement to a FOREIGN target: the enrolled worker (TARGET)
    // never ran this attempt, so it must not be able to fabricate orphan output for it.
    await admin`UPDATE job_attempts SET placement_target_id = 'a6000000-0000-4000-8000-000000000099'
      WHERE job_id = ${seeded.jobId} AND attempt_number = ${offer.job.attempt}`;
    const storage = makeMapStorage();
    const sha = "7".repeat(64);
    const key = `${expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}output.bin`;
    storage.put(key, 20, sha);
    const svc = createQuarantineFinalizeService({ appDb: app.db, storage });
    const res = await svc.finalize({ auth: auth(`qf-${crypto.randomUUID()}`), request: finalizeReq(offer, { sha, size: 20 }) });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("malformed"); // coarse, non-disclosing (unknown_job → malformed)
    const [{ n }] = await admin<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM job_artifacts WHERE job_id = ${seeded.jobId} AND status = 'quarantined'`;
    expect(n).toBe(0);
  }, 60_000);

  it("(2) a DIVERGENT idempotent replay returns a receipt matching the STORED row, not the new body", async () => {
    const { app } = guardCtx();
    const { offer } = await activateLease();
    const storage = makeMapStorage();
    const shaA = "a".repeat(64);
    const shaB = "b".repeat(64);
    const prefix = expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt });
    storage.put(`${prefix}first.bin`, 100, shaA);
    storage.put(`${prefix}second.bin`, 200, shaB);
    const svc = createQuarantineFinalizeService({ appDb: app.db, storage });
    const first = await svc.finalize({ auth: auth(`qf-${crypto.randomUUID()}`), request: finalizeReq(offer, { sha: shaA, size: 100, keySuffix: "first.bin" }) });
    // A second finalize for the SAME (job, attempt, identifier) but a DIFFERENT object.
    const second = await svc.finalize({ auth: auth(`qf-${crypto.randomUUID()}`), request: finalizeReq(offer, { sha: shaB, size: 200, keySuffix: "second.bin" }) });
    expect(first.outcome).toBe("quarantined");
    expect(second.outcome).toBe("quarantined");
    if (first.outcome !== "quarantined" || second.outcome !== "quarantined") return;
    // The replay is a DO-NOTHING; its receipt must reflect the FIRST (stored) row, never the
    // second body — else the acknowledged receipt would lie about what is durably quarantined.
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(second.receipt.quarantineObjectKey).toBe(`${prefix}first.bin`);
    expect(second.receipt.artifact.sha256).toBe(shaA);
    expect(second.receipt.artifact.sizeBytes).toBe(100);
  }, 60_000);

  it("(12) a device-generation bump denies the orphan with target_revoked (never stale_fence) and no row", async () => {
    const { app, admin } = guardCtx();
    const { offer, seeded } = await activateLease();
    await admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET}`;
    const storage = makeMapStorage();
    const sha = "3".repeat(64);
    const key = `${expectedQuarantineObjectPrefix({ organizationId: ORG, jobId: offer.job.jobId, attempt: offer.job.attempt })}output.bin`;
    storage.put(key, 8, sha);
    const svc = createQuarantineFinalizeService({ appDb: app.db, storage });
    await expect(svc.finalize({ auth: auth(`qf-${crypto.randomUUID()}`), request: finalizeReq(offer, { sha, size: 8 }) }))
      .rejects.toThrow(/target_revoked/);
    const [{ n }] = await admin<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM job_artifacts WHERE job_id = ${seeded.jobId} AND status = 'quarantined'`;
    expect(n).toBe(0);
    await admin`UPDATE execution_targets SET device_generation = 1 WHERE id = ${TARGET}`;
  }, 60_000);
});
