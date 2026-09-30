/**
 * REL-003 (E11) Lane B — restored state does not accept a stale fence (DR06, I9);
 * plus the fence half of I13 (a fence pinned to the pre-restore generation is stale
 * after a re-enrollment generation bump).
 *
 * Drives the REAL wired admission gate `guardActiveFence` (job-control.ts) — which
 * calls the real `classifyFence` (job-fence.ts) — via a governed mutator
 * (`acceptEvent`) through `runInTenant`. NOT a re-implementation (D7): this is the
 * exact gate every distributed governed mutation passes.
 *
 * The restore is modelled two ways, both authentic to "the restored DB is an OLDER
 * snapshot":
 *   * the fence's lease is EXPIRED against a fresh DB clock (post-snapshot staleness);
 *   * the fence's lease ROW is ABSENT in the restored DB (a lease minted after the
 *     snapshot point) — the guard's locking read finds no row → stale_fence.
 * The POSITIVE CONTROL (a genuinely-active restored fence is ADMITTED) proves the
 * scenario reaches the gate rather than refusing at an earlier check (E1-F008).
 *
 * The leasing scaffold (poll→offer→ack producing a real active lease) is adapted
 * from job-fencing.integration.test.ts. Windows CI can't start embedded-postgres on
 * the runneradmin runner (Issue #114) — gated; opt in with AOA_RUN_WIN_INTEGRATION=1.
 */
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
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { createJobLeasingService, type VerifiedWorkerOperation } from "../services/job-leasing.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { runInTenant } from "../db/tenant-context.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "b3300000-0000-4000-8000-000000000001";
const COMPANY = "b3300000-0000-4000-8000-000000000002";
const TARGET = "b3300000-0000-4000-8000-000000000003";
const WORKER = "b3300000-0000-4000-8000-000000000005";
const PASSWORD = "rel-003-lane-b-password";
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
    profileId: "rel-003-provider",
    version: 1,
    maxContinuousRuntimeSeconds: 3_600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2_000, memoryMiB: 4_096, pids: 512, diskMiB: 8_192 },
    maxConcurrentOperations,
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
    agentVersion: "rel-003-integration",
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

integration("REL-003 Lane B — restored state rejects a stale fence (real guardActiveFence gate)", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let operator: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;

  function ctx() {
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
      publicKey: "rel-003-public-key",
      proofId,
      proofIssuedAt: new Date(),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
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
      device_public_key = 'rel-003-public-key', device_thumbprint = ${THUMBPRINT},
      enrolled_at = clock_timestamp(), last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  async function seedPlacedJob(ordinal: number): Promise<{ jobId: string; attemptId: string }> {
    const { admin } = ctx();
    const suffix = ordinal.toString().padStart(12, "0");
    const jobId = `b3310000-0000-4000-8000-${suffix}`;
    const attemptId = `b3320000-0000-4000-8000-${suffix}`;
    const outboxId = `b3330000-0000-4000-8000-${suffix}`;
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
         'system', 'rel-003-test', 'worker', ${WORKER}, ${workload},
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

  /** poll → offer → ack, producing a real ACTIVE lease + its fence identity. */
  async function activateLease(ordinal: number): Promise<{ offer: LeaseOfferV1; identity: ActiveFenceRequest }> {
    const { app } = ctx();
    await resetRuntimeRows();
    const seeded = await seedPlacedJob(ordinal);
    const service = createJobLeasingService({ appDb: app.db });
    const polled = await service.poll({ auth: auth(`poll-${ordinal}`), request: pollRequest(`poll-${ordinal}`) });
    if (polled.outcome !== "offer") throw new Error(`expected offer, got ${polled.outcome}`);
    const offer = polled.body;
    const acked = await service.ack({ auth: auth(`ack-${ordinal}`), request: ackRequest(offer) });
    if (acked.outcome !== "acknowledged") throw new Error("expected ack");
    return { offer, identity: fenceIdentity(seeded, offer) };
  }

  async function callGuarded(identity: ActiveFenceRequest, name: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const { app } = ctx();
    return runInTenant(app.db, ORG, async (repos) => {
      const method = (repos.jobControl as unknown as Record<string, (input: unknown) => Promise<unknown>>)[name]!;
      return method({ ...identity, ...extra });
    });
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-dr-lane-b-"));
      const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
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
      const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
      await applyPendingMigrations(adminUrl);
      admin = postgres(adminUrl, { max: 4 });
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", PASSWORD));
      app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 16 });
      operator = createOperatorDbConnection(adminUrl.replace("test:test", `aoa_operator:${PASSWORD}`), { max: 8 });
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'REL-003 Lane B org', 'rel-003-lane-b')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'REL-003 Lane B company', 'RLB')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'rel-003-lane-b-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at, last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'rel-003-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'REL-003 Lane B worker', 'enrolled')`;
    } catch (error) {
      setupError = error;
      // eslint-disable-next-line no-console
      console.error("[dr-stale-fence] embedded-postgres setup failed:", error);
    }
  }, 180_000);

  afterAll(async () => {
    await operator?.close({ timeoutSeconds: 5 }).catch(() => {});
    await app?.close({ timeoutSeconds: 5 }).catch(() => {});
    await admin?.end().catch(() => {});
    await embedded?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  it("I9 (positive control): a genuinely-active restored fence is ADMITTED by the real gate", async () => {
    const { offer, identity } = await activateLease(9_001);
    // acceptEvent reaches PAST guardActiveFence and returns the guarded receipt —
    // proving the scenario reaches the gate (not refusing at an earlier check).
    await expect(callGuarded(identity, "acceptEvent")).resolves.toMatchObject({ leaseId: offer.leaseId, guarded: true });
  }, 90_000);

  it("I9: after restore, a fence whose lease is EXPIRED against a fresh DB clock is rejected as stale_fence", async () => {
    const { admin } = ctx();
    const { identity } = await activateLease(9_002);
    // The restored snapshot is older: the lease's stored expiry is in the past.
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() - interval '2 seconds',
      expires_at = clock_timestamp() - interval '1 second' WHERE id = ${identity.leaseId}`;
    await expect(callGuarded(identity, "acceptEvent")).rejects.toMatchObject({ code: "stale_fence" });
  }, 90_000);

  it("I9: after restore, a fence whose lease ROW is ABSENT (minted after the snapshot) is rejected as stale_fence", async () => {
    const { admin } = ctx();
    const { identity } = await activateLease(9_003);
    // The restored older snapshot never had this lease — delete the row.
    await admin`DELETE FROM leases WHERE id = ${identity.leaseId}`;
    await expect(callGuarded(identity, "acceptEvent")).rejects.toMatchObject({ code: "stale_fence" });
  }, 90_000);

  it("I13 (fence tail): a fence pinned to the pre-restore generation is stale after a re-enrollment gen bump (target_revoked)", async () => {
    const { admin } = ctx();
    const { identity } = await activateLease(9_004);
    // Re-enrollment after restore bumps the device generation past the one the fence
    // was pinned to; the guard reads the live generation and refuses.
    await admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET}`;
    await expect(callGuarded(identity, "acceptEvent")).rejects.toMatchObject({ code: "target_revoked" });
  }, 90_000);
});
