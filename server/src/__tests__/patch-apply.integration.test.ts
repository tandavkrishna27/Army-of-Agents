import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
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
  workspacePatchManifestV1Schema,
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { createJobLeasingService, type VerifiedWorkerOperation } from "../services/job-leasing.js";
import { createArtifactCommitService } from "../services/artifact-commit.js";
import { createPatchApplyService } from "../services/patch-apply.js";
import type { StorageProvider, HeadObjectResult, GetObjectResult } from "../storage/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

// DAT-003 — the workspace-patch apply/review service against embedded-PG with a
// stubbed object store. It proves the base-revalidation decision (match → applied +
// base advance; mismatch → conflict quarantine, NEVER auto-applied), fence-first
// precedence, no-storage-probe-before-fence, and idempotency.

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "a5000000-0000-4000-8000-000000000001";
const COMPANY = "a5000000-0000-4000-8000-000000000002";
const TARGET = "a5000000-0000-4000-8000-000000000003";
const WORKER = "a5000000-0000-4000-8000-000000000005";
const OTHER_ORG = "a5000000-0000-4000-8000-0000000000aa";
const OTHER_COMPANY = "a5000000-0000-4000-8000-0000000000bb";
const PASSWORD = "dat-003-role-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;

const integration = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "dat-003-provider",
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
    agentVersion: "dat-003-integration",
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

interface StoredObject { contentLength: number; checksumSha256: string; bytes: Buffer }

/** A per-key in-memory object store: head/get read from a seedable map. */
function makeMapStorage(): StorageProvider & {
  put(key: string, bytes: Buffer, sha: string): void;
  getCalls: string[];
  headCalls: string[];
} {
  const objects = new Map<string, StoredObject>();
  const getCalls: string[] = [];
  const headCalls: string[] = [];
  return {
    id: "s3",
    put(key, bytes, sha) { objects.set(key, { contentLength: bytes.length, checksumSha256: sha, bytes }); },
    get getCalls() { return getCalls; },
    get headCalls() { return headCalls; },
    async putObject() {},
    async getObject(inputArg): Promise<GetObjectResult> {
      getCalls.push(inputArg.objectKey);
      const obj = objects.get(inputArg.objectKey);
      if (!obj) throw new Error(`missing object: ${inputArg.objectKey}`);
      return { stream: Readable.from(obj.bytes), contentLength: obj.contentLength };
    },
    async headObject(inputArg): Promise<HeadObjectResult> {
      headCalls.push(inputArg.objectKey);
      const obj = objects.get(inputArg.objectKey);
      if (!obj) return { exists: false };
      return { exists: true, contentLength: obj.contentLength, checksumSha256: obj.checksumSha256 };
    },
    async deleteObject() {},
  };
}

/** Build a valid frozen workspace_patch manifest JSON (self-identifying). */
function buildPatchManifest(opts: {
  jobId: string;
  attempt: number;
  artifactId: string;
  baseManifestHash: string;
  resultManifestHash: string;
}): Buffer {
  const manifest = {
    protocolVersion: 1 as const,
    organizationId: ORG,
    companyId: COMPANY,
    jobId: opts.jobId,
    attempt: opts.attempt,
    artifactId: opts.artifactId,
    base: {
      kind: "content_manifest" as const,
      algorithm: "sha256" as const,
      revision: "e".repeat(64),
      dirty: false,
      caseMode: "sensitive" as const,
      ignorePolicy: { kind: "explicit" as const, digest: "f".repeat(64) },
      inclusion: { tracked: true as const, untracked: "include" as const, ignored: false as const },
    },
    baseManifestHash: opts.baseManifestHash,
    resultManifestHash: opts.resultManifestHash,
    operations: [
      { op: "create" as const, path: "out.txt", resultSha256: "1".repeat(64), sizeBytes: 3 },
    ],
  };
  // Self-check: the fixture we upload MUST be a valid frozen patch.
  workspacePatchManifestV1Schema.parse(manifest);
  return Buffer.from(JSON.stringify(manifest), "utf8");
}

integration("DAT-003 workspace-patch apply/review", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let operator: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;
  let ordinalCounter = 9_000;

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
      publicKey: "dat-003-public-key",
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
      device_public_key = 'dat-003-public-key', device_thumbprint = ${THUMBPRINT},
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
         'system', 'dat-003-test', 'worker', ${WORKER}, ${workload},
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

  function objectKey(jobId: string, name: string): string {
    return `${expectedAttemptObjectPrefix({ organizationId: ORG, jobId, attempt: 1 })}${name}`;
  }

  function commitRequest(offer: LeaseOfferV1, manifest: Record<string, unknown>) {
    return {
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
          sensitivity: "restricted" as const,
          contentType: "application/json",
          createdAt: new Date().toISOString(),
          ...manifest,
        },
      },
    };
  }

  /** Commit a snapshot artifact whose committed sha256 IS the base manifestHash. */
  async function commitSnapshot(
    storage: ReturnType<typeof makeMapStorage>,
    offer: LeaseOfferV1,
    baseManifestHash: string,
  ): Promise<{ artifactId: string; key: string }> {
    const { app } = guardCtx();
    const artifactId = crypto.randomUUID();
    const key = objectKey(offer.job.jobId, `snap-${artifactId}.json`);
    storage.put(key, Buffer.from("snapshot-bytes"), baseManifestHash);
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const res = await svc.commit({
      auth: auth(`snap-${crypto.randomUUID()}`),
      request: commitRequest(offer, {
        artifactId, kind: "workspace_snapshot", retention: "checkpoint",
        objectKey: key, sizeBytes: Buffer.byteLength("snapshot-bytes"), sha256: baseManifestHash,
      }),
    });
    if (res.outcome !== "committed") throw new Error(`snapshot commit failed: ${JSON.stringify(res)}`);
    return { artifactId, key };
  }

  /** Commit a workspace_patch artifact; the object content is the patch manifest. */
  async function commitPatch(
    storage: ReturnType<typeof makeMapStorage>,
    offer: LeaseOfferV1,
    opts: { baseManifestHash: string; resultManifestHash: string; artifactId?: string },
  ): Promise<{ artifactId: string; key: string }> {
    const { app } = guardCtx();
    const artifactId = opts.artifactId ?? crypto.randomUUID();
    const key = objectKey(offer.job.jobId, `patch-${artifactId}.json`);
    const bytes = buildPatchManifest({
      jobId: offer.job.jobId, attempt: offer.job.attempt, artifactId,
      baseManifestHash: opts.baseManifestHash, resultManifestHash: opts.resultManifestHash,
    });
    const sha = sha256(bytes);
    storage.put(key, bytes, sha);
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const res = await svc.commit({
      auth: auth(`patch-${crypto.randomUUID()}`),
      request: commitRequest(offer, {
        artifactId, kind: "workspace_patch", retention: "run",
        objectKey: key, sizeBytes: bytes.length, sha256: sha,
      }),
    });
    if (res.outcome !== "committed") throw new Error(`patch commit failed: ${JSON.stringify(res)}`);
    return { artifactId, key };
  }

  function applyReq(offer: LeaseOfferV1, artifactId: string, key: string) {
    return {
      workerId: WORKER,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      artifactId,
      objectKey: key,
    };
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-dat003-"));
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
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DAT-003 org', 'dat-003-org')`;
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${OTHER_ORG}, 'DAT-003 other', 'dat-003-other')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'DAT-003 company', 'D003')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${OTHER_COMPANY}, ${OTHER_ORG}, 'DAT-003 other company', 'D003O')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'dat-003-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'dat-003-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'DAT-003 worker', 'enrolled')`;
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

  // ---- S4: commit a workspace_patch + duplicate-result idempotency ---------

  it("commits a workspace_patch and dedups a replayed commit (one row)", async () => {
    const { app, admin } = guardCtx();
    const storage = makeMapStorage();
    const { offer, seeded } = await activateLease();
    const artifactId = crypto.randomUUID();
    const first = await commitPatch(storage, offer, { baseManifestHash: "a".repeat(64), resultManifestHash: "b".repeat(64), artifactId });
    // Replay the SAME artifact identity + object → idempotent.
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const key = first.key;
    const bytes = buildPatchManifest({ jobId: offer.job.jobId, attempt: 1, artifactId, baseManifestHash: "a".repeat(64), resultManifestHash: "b".repeat(64) });
    const replay = await svc.commit({
      auth: auth(`re-${crypto.randomUUID()}`),
      request: commitRequest(offer, { artifactId, kind: "workspace_patch", retention: "run", objectKey: key, sizeBytes: bytes.length, sha256: sha256(bytes) }),
    });
    expect(replay.outcome).toBe("committed");
    const [{ count }] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM job_artifacts
      WHERE job_id = ${seeded.jobId} AND identifier = ${artifactId} AND status = 'committed'`;
    expect(count).toBe(1);
  }, 60_000);

  // ---- S5: base matches → applied + base advance --------------------------

  it("applies a patch whose base matches the committed snapshot base", async () => {
    const { app, admin } = guardCtx();
    const storage = makeMapStorage();
    const { offer, seeded } = await activateLease();
    const base = "1".repeat(64);
    await commitSnapshot(storage, offer, base);
    const patch = await commitPatch(storage, offer, { baseManifestHash: base, resultManifestHash: "2".repeat(64) });
    const svc = createPatchApplyService({ appDb: app.db, storage });
    const res = await svc.apply({ auth: auth(`ap-${crypto.randomUUID()}`), request: applyReq(offer, patch.artifactId, patch.key) });
    expect(res.outcome).toBe("applied");
    if (res.outcome !== "applied") return;
    expect(res.resultManifestHash).toBe("2".repeat(64));
    const [row] = await admin<{ apply: string; base: string; result: string }[]>`
      SELECT apply_status AS apply, base_manifest_hash AS base, result_manifest_hash AS result
      FROM job_artifacts WHERE job_id = ${seeded.jobId} AND identifier = ${patch.artifactId}`;
    expect(row).toMatchObject({ apply: "applied", base, result: "2".repeat(64) });
  }, 60_000);

  it("advances the accepted base: a second patch chaining from the first result applies", async () => {
    const { app } = guardCtx();
    const storage = makeMapStorage();
    const { offer } = await activateLease();
    await commitSnapshot(storage, offer, "1".repeat(64));
    const p1 = await commitPatch(storage, offer, { baseManifestHash: "1".repeat(64), resultManifestHash: "2".repeat(64) });
    const p2 = await commitPatch(storage, offer, { baseManifestHash: "2".repeat(64), resultManifestHash: "3".repeat(64) });
    const svc = createPatchApplyService({ appDb: app.db, storage });
    const a1 = await svc.apply({ auth: auth(`a1-${crypto.randomUUID()}`), request: applyReq(offer, p1.artifactId, p1.key) });
    expect(a1.outcome).toBe("applied");
    // The accepted base is now p1.result; p2 chains from it → applies.
    const a2 = await svc.apply({ auth: auth(`a2-${crypto.randomUUID()}`), request: applyReq(offer, p2.artifactId, p2.key) });
    expect(a2.outcome).toBe("applied");
  }, 60_000);

  it("decides fence staleness BEFORE applying: a stale fence rejects stale_fence with no write", async () => {
    const { app, admin } = guardCtx();
    const storage = makeMapStorage();
    const { offer, seeded } = await activateLease();
    await commitSnapshot(storage, offer, "1".repeat(64));
    const patch = await commitPatch(storage, offer, { baseManifestHash: "1".repeat(64), resultManifestHash: "2".repeat(64) });
    await expireLease(offer.leaseId);
    const svc = createPatchApplyService({ appDb: app.db, storage });
    const res = await svc.apply({ auth: auth(`sf-${crypto.randomUUID()}`), request: applyReq(offer, patch.artifactId, patch.key) });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("stale_fence");
    const [row] = await admin<{ apply: string | null }[]>`
      SELECT apply_status AS apply FROM job_artifacts WHERE job_id = ${seeded.jobId} AND identifier = ${patch.artifactId}`;
    expect(row.apply).toBeNull(); // no apply write
  }, 60_000);

  it("DE-04 fence arm: the stale-fence apply refusal at recordPatchApplyState's guardActiveFence writes a durable fence_guard row (operation patch_apply)", async () => {
    // Until the audit-wiring unit this refusal left NOTHING durable — the
    // `rejected` wire object was the only trace. Observed RED against the
    // unchanged wiring before the sink landed.
    const { app, admin } = guardCtx();
    const storage = makeMapStorage();
    const { offer } = await activateLease();
    await commitSnapshot(storage, offer, "1".repeat(64));
    const patch = await commitPatch(storage, offer, { baseManifestHash: "1".repeat(64), resultManifestHash: "2".repeat(64) });
    await expireLease(offer.leaseId);
    await admin`DELETE FROM activity_log WHERE action LIKE ${"security.denied.%"}`;
    const svc = createPatchApplyService({ appDb: app.db, storage });
    const res = await svc.apply({ auth: auth(`sfa-${crypto.randomUUID()}`), request: applyReq(offer, patch.artifactId, patch.key) });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("stale_fence");
    const rows = await admin<Array<{
      action: string; actor_type: string; actor_id: string;
      company_id: string | null; organization_id: string | null;
      entity_type: string; entity_id: string; details: Record<string, unknown>;
    }>>`SELECT action, actor_type, actor_id, company_id, organization_id, entity_type, entity_id, details
        FROM activity_log WHERE action LIKE ${"security.denied.%"}`;
    expect(rows).toHaveLength(1);
    const denial = rows[0]!;
    expect(denial.action).toBe("security.denied.fence_guard");
    expect(denial.details.reason).toBe("stale_fence");
    expect(denial.details.crossing).toBe("DE-04");
    expect(denial.details.operation).toBe("patch_apply");
    expect(denial.actor_type).toBe("system");
    expect(denial.actor_id).toBe(WORKER);
    expect(denial.entity_type).toBe("job_lease");
    expect(denial.entity_id).toBe(offer.leaseId);
    expect(denial.company_id).toBe(COMPANY);
    expect(denial.organization_id).toBe(ORG);
  }, 60_000);

  // ---- S6: mismatch → conflict quarantine + idempotency -------------------

  it("conflict-quarantines a patch whose base does NOT match (never auto-applies)", async () => {
    const { app, admin } = guardCtx();
    const storage = makeMapStorage();
    const { offer, seeded } = await activateLease();
    await commitSnapshot(storage, offer, "1".repeat(64));
    const patch = await commitPatch(storage, offer, { baseManifestHash: "9".repeat(64), resultManifestHash: "2".repeat(64) });
    const svc = createPatchApplyService({ appDb: app.db, storage });
    const res = await svc.apply({ auth: auth(`cq-${crypto.randomUUID()}`), request: applyReq(offer, patch.artifactId, patch.key) });
    expect(res.outcome).toBe("conflict_quarantined");
    if (res.outcome !== "conflict_quarantined") return;
    expect(res.expectedBaseManifestHash).toBe("9".repeat(64));
    expect(res.currentBaseManifestHash).toBe("1".repeat(64));
    const [row] = await admin<{ apply: string }[]>`
      SELECT apply_status AS apply FROM job_artifacts WHERE job_id = ${seeded.jobId} AND identifier = ${patch.artifactId}`;
    expect(row.apply).toBe("conflict_quarantined");
  }, 60_000);

  it("quarantines a patch with no committed base at all (currentBase null)", async () => {
    const { app } = guardCtx();
    const storage = makeMapStorage();
    const { offer } = await activateLease();
    // No snapshot committed → no accepted base.
    const patch = await commitPatch(storage, offer, { baseManifestHash: "1".repeat(64), resultManifestHash: "2".repeat(64) });
    const svc = createPatchApplyService({ appDb: app.db, storage });
    const res = await svc.apply({ auth: auth(`nb-${crypto.randomUUID()}`), request: applyReq(offer, patch.artifactId, patch.key) });
    expect(res.outcome).toBe("conflict_quarantined");
    if (res.outcome !== "conflict_quarantined") return;
    expect(res.currentBaseManifestHash).toBeNull();
  }, 60_000);

  it("is idempotent: re-applying an already-applied patch is a no-op returning applied", async () => {
    const { app, admin } = guardCtx();
    const storage = makeMapStorage();
    const { offer, seeded } = await activateLease();
    await commitSnapshot(storage, offer, "1".repeat(64));
    const patch = await commitPatch(storage, offer, { baseManifestHash: "1".repeat(64), resultManifestHash: "2".repeat(64) });
    const svc = createPatchApplyService({ appDb: app.db, storage });
    const first = await svc.apply({ auth: auth(`i1-${crypto.randomUUID()}`), request: applyReq(offer, patch.artifactId, patch.key) });
    expect(first.outcome).toBe("applied");
    const second = await svc.apply({ auth: auth(`i2-${crypto.randomUUID()}`), request: applyReq(offer, patch.artifactId, patch.key) });
    expect(second.outcome).toBe("applied");
    if (second.outcome !== "applied") return;
    expect(second.alreadyApplied).toBe(true);
    const [{ count }] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM job_artifacts
      WHERE job_id = ${seeded.jobId} AND identifier = ${patch.artifactId} AND apply_status = 'applied'`;
    expect(count).toBe(1);
  }, 60_000);

  it("quarantines a STALE patch (old base) after the base has advanced", async () => {
    const { app } = guardCtx();
    const storage = makeMapStorage();
    const { offer } = await activateLease();
    await commitSnapshot(storage, offer, "1".repeat(64));
    const p1 = await commitPatch(storage, offer, { baseManifestHash: "1".repeat(64), resultManifestHash: "2".repeat(64) });
    // A competing patch ALSO built from the original base "1..." (stale once p1 applies).
    const stale = await commitPatch(storage, offer, { baseManifestHash: "1".repeat(64), resultManifestHash: "7".repeat(64) });
    const svc = createPatchApplyService({ appDb: app.db, storage });
    expect((await svc.apply({ auth: auth(`s1-${crypto.randomUUID()}`), request: applyReq(offer, p1.artifactId, p1.key) })).outcome).toBe("applied");
    const res = await svc.apply({ auth: auth(`s2-${crypto.randomUUID()}`), request: applyReq(offer, stale.artifactId, stale.key) });
    expect(res.outcome).toBe("conflict_quarantined"); // base advanced to "2..."; stale still declares "1..."
  }, 60_000);

  // ---- security: no storage probe before fence + prefix binding -----------

  it("does not probe object storage before the fence identity is resolved", async () => {
    const { app } = guardCtx();
    const storage = makeMapStorage();
    const { offer } = await activateLease();
    await commitSnapshot(storage, offer, "1".repeat(64));
    const patch = await commitPatch(storage, offer, { baseManifestHash: "1".repeat(64), resultManifestHash: "2".repeat(64) });
    storage.getCalls.length = 0; // reset after commit-time head/put
    const svc = createPatchApplyService({ appDb: app.db, storage });
    const req = applyReq(offer, patch.artifactId, patch.key);
    req.leaseId = crypto.randomUUID(); // unresolvable fence → throws BEFORE getObject
    await expect(svc.apply({ auth: auth(`orc-${crypto.randomUUID()}`), request: req })).rejects.toThrow();
    expect(storage.getCalls).toHaveLength(0);
  }, 60_000);

  it("rejects (malformed) a foreign-prefix object key without touching storage", async () => {
    const { app } = guardCtx();
    const storage = makeMapStorage();
    const { offer } = await activateLease();
    await commitSnapshot(storage, offer, "1".repeat(64));
    const patch = await commitPatch(storage, offer, { baseManifestHash: "1".repeat(64), resultManifestHash: "2".repeat(64) });
    storage.getCalls.length = 0;
    const svc = createPatchApplyService({ appDb: app.db, storage });
    const req = applyReq(offer, patch.artifactId, `${expectedAttemptObjectPrefix({ organizationId: OTHER_ORG, jobId: offer.job.jobId, attempt: 1 })}evil.json`);
    const res = await svc.apply({ auth: auth(`fp-${crypto.randomUUID()}`), request: req });
    expect(res.outcome).toBe("rejected");
    if (res.outcome !== "rejected") return;
    expect(res.reason).toBe("malformed");
    expect(storage.getCalls).toHaveLength(0);
  }, 60_000);

  // ---- adversarial-review regressions -------------------------------------

  // Review #3 — base bootstrapping must be EXISTENCE-based, not "most-recent
  // snapshot": a job with >1 committed snapshot must still cleanly apply a patch
  // whose declared base is an EARLIER committed snapshot.
  it("applies a patch whose base is an earlier committed snapshot (job has >1 snapshot)", async () => {
    const { app } = guardCtx();
    const storage = makeMapStorage();
    const { offer } = await activateLease();
    await commitSnapshot(storage, offer, "1".repeat(64)); // S0 (the patch's base)
    await commitSnapshot(storage, offer, "2".repeat(64)); // S1 (committed later → "most-recent")
    const patch = await commitPatch(storage, offer, { baseManifestHash: "1".repeat(64), resultManifestHash: "3".repeat(64) });
    const svc = createPatchApplyService({ appDb: app.db, storage });
    const res = await svc.apply({ auth: auth(`ms-${crypto.randomUUID()}`), request: applyReq(offer, patch.artifactId, patch.key) });
    // "most-recent" would resolve base to S1 ("2...") and wrongly quarantine; existence
    // of S0 ("1...") makes this a clean apply.
    expect(res.outcome).toBe("applied");
  }, 60_000);

  // Review #2 — conflict_quarantined is STICKY: a re-invoked quarantined patch must
  // NOT auto-flip to applied even if the accepted base later coincides with its base.
  it("keeps a quarantined patch quarantined on re-apply even after the base advances to match it", async () => {
    const { app } = guardCtx();
    const storage = makeMapStorage();
    const { offer } = await activateLease();
    await commitSnapshot(storage, offer, "1".repeat(64));
    const pq = await commitPatch(storage, offer, { baseManifestHash: "5".repeat(64), resultManifestHash: "6".repeat(64) });
    const svc = createPatchApplyService({ appDb: app.db, storage });
    // First apply: base "5" != accepted "1" → quarantined.
    expect((await svc.apply({ auth: auth(`q1-${crypto.randomUUID()}`), request: applyReq(offer, pq.artifactId, pq.key) })).outcome).toBe("conflict_quarantined");
    // Advance the accepted base to "5" via a legitimate chained patch.
    const p1 = await commitPatch(storage, offer, { baseManifestHash: "1".repeat(64), resultManifestHash: "5".repeat(64) });
    expect((await svc.apply({ auth: auth(`q2-${crypto.randomUUID()}`), request: applyReq(offer, p1.artifactId, p1.key) })).outcome).toBe("applied");
    // Re-apply the quarantined patch: base "5" now coincides with the accepted base,
    // but a quarantined patch must NOT silently auto-apply — it stays quarantined.
    const res = await svc.apply({ auth: auth(`q3-${crypto.randomUUID()}`), request: applyReq(offer, pq.artifactId, pq.key) });
    expect(res.outcome).toBe("conflict_quarantined");
  }, 60_000);
});
