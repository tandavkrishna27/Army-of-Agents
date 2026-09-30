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
  type ActiveFenceRequest,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import {
  canonicalProviderConstraintProfileDigestInputV1,
  canonicalizeJsonV1,
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type LeaseRenewOperationRequestV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import {
  createJobLeasingService,
  type VerifiedWorkerOperation,
} from "../services/job-leasing.js";
import { createJobLeaseRenewalService } from "../services/job-fencing.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { runInTenant } from "../db/tenant-context.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "a4000000-0000-4000-8000-000000000001";
const COMPANY = "a4000000-0000-4000-8000-000000000002";
const TARGET = "a4000000-0000-4000-8000-000000000003";
const WORKER = "a4000000-0000-4000-8000-000000000005";
const SERVICE = "a4000000-0000-4000-8000-000000000020";
const SERVICE_INSTANCE = "a4000000-0000-4000-8000-000000000021";
const PASSWORD = "job-004-role-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(maxConcurrentOperations = 2): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "job-004-provider",
    version: 1,
    maxContinuousRuntimeSeconds: 3_600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2_000, memoryMiB: 4_096, pids: 512, diskMiB: 8_192 },
    maxConcurrentOperations,
    supportedOperations: [
      "create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup",
    ],
    localityTags: ["organization_target_only"],
    checkpointMode: "none",
    healthMode: "none",
  } as const;
  return {
    ...unsigned,
    digest: sha256(canonicalProviderConstraintProfileDigestInputV1(unsigned)),
  };
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
    providerConstraints: {
      profileId: provider.profileId,
      version: provider.version,
      digest: provider.digest,
    },
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
    agentVersion: "job-004-integration",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux" as const, arch: "x64" as const, runtime: "worker" },
    reportedCapabilities: ["workload.batch" as const, "sandbox.process_isolated" as const],
    capacity: {
      batchSlots: 2,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 2_000,
      freeMemoryMiB: 4_096,
      freeDiskMiB: 8_192,
    },
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
    capacity: {
      batchSlots: 2,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 2_000,
      freeMemoryMiB: 4_096,
      freeDiskMiB: 8_192,
    },
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

function renewRequest(
  offer: LeaseOfferV1,
  idempotencyKey = crypto.randomUUID(),
  body: Partial<LeaseRenewOperationRequestV1["body"]> = {},
): LeaseRenewOperationRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `renew-${crypto.randomUUID()}`,
    audience: "worker_run",
    idempotencyKey,
    body: {
      protocolVersion: 1,
      workerId: offer.workerId,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      observedAt: new Date().toISOString(),
      extensions: [],
      ...body,
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

integration("JOB-004 lease renewal and active-fence enforcement", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let adminUrl = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let operator: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;

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
      publicKey: "job-004-public-key",
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
    await admin`DELETE FROM job_secret_handles`;
    await admin`DELETE FROM job_outbox`;
    await admin`DELETE FROM job_attempts`;
    await admin`DELETE FROM jobs`;
    await admin`DELETE FROM service_instances`;
    await admin`DELETE FROM services`;
    await admin`DELETE FROM worker_proof_replays`;
    const provider = providerProfile();
    const profile = registeredProfile(provider);
    await admin`UPDATE execution_targets SET status = 'active', device_generation = 1,
      registered_profile = ${profile}, registered_profile_hash = ${sha256(canonicalizeJsonV1(profile))},
      provider_constraint_profile = ${provider}, last_seen_at = clock_timestamp()
      WHERE id = ${TARGET}`;
    const hello = workerHello();
    await admin`UPDATE workers SET status = 'enrolled', revoked_at = NULL, device_generation = 1,
      profile_hash = ${sha256(JSON.stringify(hello))}, profile_snapshot = ${hello},
      device_public_key = 'job-004-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  async function seedPlacedJob(ordinal: number): Promise<{ jobId: string; attemptId: string }> {
    const { admin } = guardCtx();
    const suffix = ordinal.toString().padStart(12, "0");
    const jobId = `a4100000-0000-4000-8000-${suffix}`;
    const attemptId = `a4200000-0000-4000-8000-${suffix}`;
    const outboxId = `a4300000-0000-4000-8000-${suffix}`;
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
         'system', 'job-004-test', 'worker', ${WORKER},
         ${workload},
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

  function fenceIdentity(seeded: { jobId: string; attemptId: string }, offer: LeaseOfferV1): ActiveFenceRequest {
    return {
      organizationId: ORG,
      companyId: COMPANY,
      jobId: offer.job.jobId,
      attemptId: seeded.attemptId,
      attemptNumber: offer.job.attempt,
      leaseId: offer.leaseId,
      workerId: WORKER,
      targetId: TARGET,
      targetAuthorityKey: AUTHORITY_KEY,
      targetGeneration: 1,
      profileHash: WORKER_PROFILE_HASH,
      providerConstraintHash: providerProfile().digest,
      fence: offer.fenceToken,
    };
  }

  async function activateLease(ordinal: number): Promise<{
    seeded: { jobId: string; attemptId: string };
    offer: LeaseOfferV1;
    service: ReturnType<typeof createJobLeasingService>;
    renewal: ReturnType<typeof createJobLeaseRenewalService>;
    identity: ActiveFenceRequest;
  }> {
    const { app } = guardCtx();
    await resetRuntimeRows();
    const seeded = await seedPlacedJob(ordinal);
    const service = createJobLeasingService({ appDb: app.db });
    const renewal = createJobLeaseRenewalService({ appDb: app.db });
    const polled = await service.poll({ auth: auth(`fence-poll-${ordinal}`), request: pollRequest(`fence-poll-${ordinal}`) });
    if (polled.outcome !== "offer") throw new Error(`expected offer, got ${polled.outcome}`);
    const offer = polled.body;
    const acked = await service.ack({ auth: auth(`fence-ack-${ordinal}`), request: ackRequest(offer) });
    if (acked.outcome !== "acknowledged") throw new Error("expected ack");
    return { seeded, offer, service, renewal, identity: fenceIdentity(seeded, offer) };
  }

  async function leaseExpiry(leaseId: string): Promise<string> {
    const { admin } = guardCtx();
    const [row] = await admin<{ expiresAt: Date }[]>`
      SELECT expires_at AS "expiresAt" FROM leases WHERE id = ${leaseId}`;
    return new Date(row!.expiresAt).toISOString();
  }

  async function renewReceiptCount(leaseId: string): Promise<number> {
    const { admin } = guardCtx();
    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_operation_receipts
      WHERE lease_id = ${leaseId} AND operation = 'lease_renew'`;
    return Number(row!.count);
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-job-fencing-"));
      const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
        default: EmbeddedPostgresCtor;
      };
      const port = await allocateEmbeddedPgPort();
      embedded = new EmbeddedPostgres({
        databaseDir: join(dataDir, "db"),
        user: "test",
        password: "test",
        port,
        persistent: false,
        initdbFlags: ["--encoding=UTF8", "--locale=C"],
      });
      await embedded.initialise();
      await embedded.start();
      adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
      await applyPendingMigrations(adminUrl);
      admin = postgres(adminUrl, { max: 4 });
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", PASSWORD));
      app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 16 });
      operator = createOperatorDbConnection(
        adminUrl.replace("test:test", `aoa_operator:${PASSWORD}`),
        { max: 8 },
      );
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'JOB-004 org', 'job-004-org')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'JOB-004 company', 'J004')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES
        (${TARGET}, ${ORG}, 'job-004-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES
        (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'job-004-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'JOB-004 worker', 'enrolled')`;
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

  // ---- Renewal matrix ------------------------------------------------------

  it("renews only the active lease, extending expiry with a fresh database clock and no authority change", async () => {
    const { admin } = guardCtx();
    const { offer, renewal } = await activateLease(4_001);
    // Shorten the active lease so the renewal is an unmistakable extension.
    // ack_deadline must stay < expires_at (leases_authority_atomic_check).
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() + interval '1 second',
      expires_at = clock_timestamp() + interval '2 seconds' WHERE id = ${offer.leaseId}`;
    const shortExpiry = await leaseExpiry(offer.leaseId);

    const result = await renewal.renew({ auth: auth("renew-happy"), request: renewRequest(offer) });
    expect(result.outcome).toBe("renewed");
    if (result.outcome !== "renewed") return;
    expect(result.body.leaseId).toBe(offer.leaseId);
    expect(result.body.cancelRequested).toBe(false);
    expect(Date.parse(result.body.expiresAt)).toBeGreaterThan(Date.parse(shortExpiry));

    const [row] = await admin<{
      expiresAt: Date; status: string; fence: string; generation: number; receipts: number;
    }[]>`SELECT expires_at AS "expiresAt", status, fence, target_generation AS generation,
      (SELECT count(*)::int FROM worker_operation_receipts
        WHERE lease_id = ${offer.leaseId} AND operation = 'lease_renew') AS receipts
      FROM leases WHERE id = ${offer.leaseId}`;
    expect(row!.status).toBe("active");
    expect(row!.fence).toBe(offer.fenceToken); // fence unchanged
    expect(row!.generation).toBe(1); // generation unchanged
    expect(row!.receipts).toBe(1);
    expect(new Date(row!.expiresAt).toISOString()).toBe(result.body.expiresAt);
  }, 60_000);

  it("replays a lost renewal without extending twice and rejects a changed digest under the same key", async () => {
    const { offer, renewal } = await activateLease(4_002);
    const key = crypto.randomUUID();
    // A genuine retry resends the IDENTICAL body (same observedAt); only the device
    // proof + envelope (correlationId/nonce) differ — none of which enter the digest.
    const request = renewRequest(offer, key);
    const first = await renewal.renew({ auth: auth("renew-key-first"), request });
    expect(first.outcome).toBe("renewed");
    if (first.outcome !== "renewed") return;
    const firstExpiry = first.body.expiresAt;
    expect(await renewReceiptCount(offer.leaseId)).toBe(1);

    // Fresh proof + nonce, same scope/key/digest → the EXACT original expiry, no second extend.
    const replay = await renewal.renew({
      auth: auth("renew-key-replay"),
      request: { ...request, correlationId: crypto.randomUUID(), nonce: `renew-${crypto.randomUUID()}` },
    });
    expect(replay.outcome).toBe("renewed");
    if (replay.outcome !== "renewed") return;
    expect(replay.body.expiresAt).toBe(firstExpiry);
    expect(await renewReceiptCount(offer.leaseId)).toBe(1);
    expect(await leaseExpiry(offer.leaseId)).toBe(firstExpiry);

    // Same key, changed body (observedAt) → drifted digest → generic malformed.
    await expect(renewal.renew({
      auth: auth("renew-key-changed"),
      request: renewRequest(offer, key, { observedAt: new Date(Date.now() + 5_000).toISOString() }),
    })).rejects.toMatchObject({ code: "malformed" });
    expect(await renewReceiptCount(offer.leaseId)).toBe(1);
  }, 60_000);

  it("requires a NEW idempotency key for a later renewal effect", async () => {
    const { offer, renewal } = await activateLease(4_003);
    const firstKey = crypto.randomUUID();
    const first = await renewal.renew({ auth: auth("renew-first-effect"), request: renewRequest(offer, firstKey) });
    expect(first.outcome).toBe("renewed");
    if (first.outcome !== "renewed") return;
    const firstExpiry = first.body.expiresAt;

    await sleep(20);
    const secondKey = crypto.randomUUID();
    const second = await renewal.renew({ auth: auth("renew-second-effect"), request: renewRequest(offer, secondKey) });
    expect(second.outcome).toBe("renewed");
    if (second.outcome !== "renewed") return;
    expect(Date.parse(second.body.expiresAt)).toBeGreaterThan(Date.parse(firstExpiry));
    expect(await renewReceiptCount(offer.leaseId)).toBe(2);
    expect(await leaseExpiry(offer.leaseId)).toBe(second.body.expiresAt);
  }, 60_000);

  it("rejects an expired, wrong-fence, revoked-target, or terminal-attempt renewal without mutating", async () => {
    const { admin } = guardCtx();

    // Expired lease → stale_fence.
    const expired = await activateLease(4_004);
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() - interval '2 seconds',
      expires_at = clock_timestamp() - interval '1 second' WHERE id = ${expired.offer.leaseId}`;
    await expect(expired.renewal.renew({ auth: auth("renew-expired"), request: renewRequest(expired.offer) }))
      .rejects.toMatchObject({ code: "stale_fence" });
    expect(await renewReceiptCount(expired.offer.leaseId)).toBe(0);

    // Wrong (never-issued) fence → stale_fence.
    const wrong = await activateLease(4_005);
    const strayFence = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    await expect(wrong.renewal.renew({
      auth: auth("renew-wrong-fence"),
      request: renewRequest(wrong.offer, undefined, { fenceToken: strayFence }),
    })).rejects.toMatchObject({ code: "stale_fence" });
    expect(await renewReceiptCount(wrong.offer.leaseId)).toBe(0);

    // Revoked target → target_revoked.
    const revoked = await activateLease(4_006);
    await admin`UPDATE execution_targets SET status = 'revoked' WHERE id = ${TARGET}`;
    await expect(revoked.renewal.renew({ auth: auth("renew-revoked"), request: renewRequest(revoked.offer) }))
      .rejects.toMatchObject({ code: "target_revoked" });
    expect(await renewReceiptCount(revoked.offer.leaseId)).toBe(0);
    await admin`UPDATE execution_targets SET status = 'active' WHERE id = ${TARGET}`;

    // Terminal attempt → attempt_terminal.
    const terminal = await activateLease(4_007);
    await admin`UPDATE job_attempts SET status = 'succeeded' WHERE id = ${terminal.seeded.attemptId}`;
    await expect(terminal.renewal.renew({ auth: auth("renew-terminal"), request: renewRequest(terminal.offer) }))
      .rejects.toMatchObject({ code: "attempt_terminal" });
    expect(await renewReceiptCount(terminal.offer.leaseId)).toBe(0);
  }, 90_000);

  it("uses a fresh SQL clock in the mutation: a lease that expires WHILE the transaction runs cannot renew", async () => {
    const { admin } = guardCtx();
    const crossing = await activateLease(4_008);
    // A trigger delays the transaction at proof recording; by the time the conditional
    // renewal evaluates `expires_at > clock_timestamp()`, the stored expiry is in the past.
    await admin.unsafe(`CREATE OR REPLACE FUNCTION job004_sleep_renew_proof() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.proof_id = 'renew-crossing' THEN PERFORM pg_sleep(0.25); END IF;
        RETURN NEW;
      END $$`);
    await admin.unsafe(`CREATE TRIGGER job004_sleep_renew_proof_trigger BEFORE INSERT ON worker_proof_replays
      FOR EACH ROW EXECUTE FUNCTION job004_sleep_renew_proof()`);
    try {
      await admin`UPDATE leases SET ack_deadline = clock_timestamp() + interval '10 milliseconds',
        expires_at = clock_timestamp() + interval '50 milliseconds'
        WHERE id = ${crossing.offer.leaseId}`;
      await expect(crossing.renewal.renew({ auth: auth("renew-crossing"), request: renewRequest(crossing.offer) }))
        .rejects.toMatchObject({ code: "stale_fence" });
    } finally {
      await admin.unsafe("DROP TRIGGER IF EXISTS job004_sleep_renew_proof_trigger ON worker_proof_replays");
      await admin.unsafe("DROP FUNCTION IF EXISTS job004_sleep_renew_proof()");
    }
    expect(await renewReceiptCount(crossing.offer.leaseId)).toBe(0);
  }, 60_000);

  // ---- Stale-fence-cannot-mutate matrix ------------------------------------

  async function callGuarded(identity: ActiveFenceRequest, name: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const { app } = guardCtx();
    return runInTenant(app.db, ORG, async (repos) => {
      const method = (repos.jobControl as unknown as Record<string, (input: unknown) => Promise<unknown>>)[name]!;
      return method({ ...identity, ...extra });
    });
  }

  it("a stale (expired) fence cannot mutate events, artifacts, secret handles, completion, service health, projection, or control", async () => {
    const { admin } = guardCtx();
    const { seeded, identity } = await activateLease(4_020);
    // Seed the surfaces the tabled mutators touch.
    await admin`INSERT INTO job_secret_handles (organization_id, job_id, handle)
      VALUES (${ORG}, ${seeded.jobId}, 'sh-stale')`;
    await admin`INSERT INTO services (id, organization_id, company_id, desired_state, generation)
      VALUES (${SERVICE}, ${ORG}, ${COMPANY}, 'running', 1)`;
    await admin`INSERT INTO service_instances (id, organization_id, company_id, service_id, generation, status)
      VALUES (${SERVICE_INSTANCE}, ${ORG}, ${COMPANY}, ${SERVICE}, 1, 'pending')`;
    // Make the fence stale by expiring the lease.
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() - interval '2 seconds',
      expires_at = clock_timestamp() - interval '1 second' WHERE id = ${identity.leaseId}`;

    const surfaces: Array<[string, Record<string, unknown>]> = [
      ["acceptEvent", {}],
      ["authorizeArtifactCommit", { identifier: "art-stale" }],
      ["readSecretHandle", { handle: "sh-stale" }],
      ["completeAttempt", { terminalStatus: "succeeded" }],
      ["recordServiceHealth", { serviceInstanceId: SERVICE_INSTANCE, healthStatus: "healthy" }],
      ["applyProjectionReceipt", {}],
      ["ackControlCommand", {}],
    ];
    for (const [name, extra] of surfaces) {
      await expect(callGuarded(identity, name, extra), `${name} must reject a stale fence`)
        .rejects.toMatchObject({ code: "stale_fence" });
    }

    // No governed side effect happened.
    const [state] = await admin<{ artifacts: number; attemptStatus: string; instanceStatus: string }[]>`SELECT
      (SELECT count(*)::int FROM job_artifacts WHERE job_id = ${seeded.jobId}) AS artifacts,
      (SELECT status FROM job_attempts WHERE id = ${seeded.attemptId}) AS "attemptStatus",
      (SELECT status FROM service_instances WHERE id = ${SERVICE_INSTANCE}) AS "instanceStatus"`;
    expect(state).toEqual({ artifacts: 0, attemptStatus: "leased", instanceStatus: "pending" });
  }, 60_000);

  it("the active fence admits each governed mutator and produces its effect", async () => {
    const { admin } = guardCtx();
    const { seeded, offer, identity } = await activateLease(4_021);
    await admin`INSERT INTO job_secret_handles (organization_id, job_id, handle)
      VALUES (${ORG}, ${seeded.jobId}, 'sh-active')`;
    await admin`INSERT INTO services (id, organization_id, company_id, desired_state, generation)
      VALUES (${SERVICE}, ${ORG}, ${COMPANY}, 'running', 1)`;
    await admin`INSERT INTO service_instances (id, organization_id, company_id, service_id, generation, status)
      VALUES (${SERVICE_INSTANCE}, ${ORG}, ${COMPANY}, ${SERVICE}, 1, 'pending')`;

    // Stub-storage surfaces (JOB-005/006/011) admit the active fence.
    for (const name of ["acceptEvent", "applyProjectionReceipt", "ackControlCommand"]) {
      await expect(callGuarded(identity, name)).resolves.toMatchObject({ leaseId: offer.leaseId, guarded: true });
    }

    // Ordinary artifact metadata/commit authorization writes its ownership row.
    const artifact = await callGuarded(identity, "authorizeArtifactCommit", { identifier: "art-active" }) as { identifier: string };
    expect(artifact.identifier).toBe("art-active");

    // Secret-handle read is gated but returns the handle.
    const handle = await callGuarded(identity, "readSecretHandle", { handle: "sh-active" }) as { handle: string } | null;
    expect(handle?.handle).toBe("sh-active");

    // Service-instance health.
    const instance = await callGuarded(identity, "recordServiceHealth", {
      serviceInstanceId: SERVICE_INSTANCE, healthStatus: "healthy",
    }) as { status: string };
    expect(instance.status).toBe("healthy");

    // Terminal completion LAST (it terminates the attempt for any later guard).
    const completed = await callGuarded(identity, "completeAttempt", { terminalStatus: "succeeded" }) as { status: string };
    expect(completed.status).toBe("succeeded");

    const [state] = await admin<{ artifacts: number; attemptStatus: string; instanceStatus: string }[]>`SELECT
      (SELECT count(*)::int FROM job_artifacts WHERE job_id = ${seeded.jobId}) AS artifacts,
      (SELECT status FROM job_attempts WHERE id = ${seeded.attemptId}) AS "attemptStatus",
      (SELECT status FROM service_instances WHERE id = ${SERVICE_INSTANCE}) AS "instanceStatus"`;
    expect(state).toEqual({ artifacts: 1, attemptStatus: "succeeded", instanceStatus: "healthy" });

    // After completion the fence is terminal: a further governed mutator is refused.
    await expect(callGuarded(identity, "acceptEvent")).rejects.toMatchObject({ code: "attempt_terminal" });
  }, 60_000);
});
