// server/src/__tests__/helpers/job-control-fixture.ts
//
// Shared embedded-Postgres fixture for the JOB-006 integration suites. Mirrors the
// JOB-004/005 harnesses: real embedded Postgres, provisioned aoa_app / aoa_operator
// login roles, and a seeded org/company/target/worker so a placed job can be polled +
// ACKed into an ACTIVE lease fence. All helpers are bound to the fixture's clients.

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
  canonicalizeJsonV1,
  canonicalProviderConstraintProfileDigestInputV1,
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../../db/rls-tenant.js";
import { createJobLeasingService, type VerifiedWorkerOperation } from "../../services/job-leasing.js";
import { allocateEmbeddedPgPort } from "./embedded-pg-port.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

export const ORG = "a6000000-0000-4000-8000-000000000001";
export const COMPANY = "a6000000-0000-4000-8000-000000000002";
export const TARGET = "a6000000-0000-4000-8000-000000000003";
export const WORKER = "a6000000-0000-4000-8000-000000000005";
const PASSWORD = "job-006-role-password";
const POLICY_HASH = "3".repeat(64);
export const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "job-006-provider",
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

export function workerHello() {
  return {
    protocolVersion: 1 as const,
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 1,
    agentVersion: "job-006-integration",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux" as const, arch: "x64" as const, runtime: "worker" },
    reportedCapabilities: ["workload.batch" as const, "sandbox.process_isolated" as const],
    capacity: { batchSlots: 2, browserSessionSlots: 0, serviceSlots: 0, freeCpuMillis: 2_000, freeMemoryMiB: 4_096, freeDiskMiB: 8_192 },
    policyHash: POLICY_HASH,
  };
}

export const WORKER_PROFILE_HASH = sha256(JSON.stringify(workerHello()));
export const PROVIDER_DIGEST = providerProfile().digest;

export function auth(proofId: string): VerifiedWorkerOperation {
  return {
    organizationId: ORG,
    workerId: WORKER,
    targetId: TARGET,
    targetGeneration: 1,
    deviceThumbprint: THUMBPRINT,
    profileHash: WORKER_PROFILE_HASH,
    publicKey: "job-006-public-key",
    proofId,
    proofIssuedAt: new Date(),
    sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
  };
}

export function pollRequest(nonce: string): PollRequestV1 {
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
  } as PollRequestV1;
}

export function ackRequest(offer: LeaseOfferV1): LeaseAckOperationRequestV1 {
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
  } as LeaseAckOperationRequestV1;
}

export interface JobControlFixture {
  admin: Sql;
  app: NonOwnerDbConnection;
  operator: NonOwnerDbConnection;
  leasing: ReturnType<typeof createJobLeasingService>;
  resetRuntimeRows(): Promise<void>;
  seedPlacedJob(ordinal: number, options?: { maxAttempts?: number }): Promise<{ jobId: string; attemptId: string }>;
  activateLease(ordinal: number, options?: { maxAttempts?: number }): Promise<{
    seeded: { jobId: string; attemptId: string };
    offer: LeaseOfferV1;
    identity: ActiveFenceRequest;
  }>;
  /**
   * A SECOND (retry) attempt on an ALREADY-SEEDED job, leased for real: a fresh
   * `job_attempts` row is placed exactly as `seedPlacedJob` places attempt 1, then polled
   * and ACKed through the real leasing service, so the returned fence is a LIVE control-plane
   * fence and anything projected under it writes a genuine `job_projection_receipts` row
   * bound to THIS attempt. Deliberately does NOT call `resetRuntimeRows` — attempt 1 and its
   * lease/receipts must survive, since a sibling-attempt test is exactly about both existing
   * at once. Safe because `activateLeaseAck` leaves `jobs.status = 'queued'` and the seeded
   * worker carries two batch slots.
   */
  activateSiblingLease(
    seeded: { jobId: string; attemptId: string },
    attemptNumber: number,
    ordinal: number,
  ): Promise<{ attemptId: string; offer: LeaseOfferV1; identity: ActiveFenceRequest }>;
  fenceIdentity(seeded: { jobId: string; attemptId: string }, offer: LeaseOfferV1): ActiveFenceRequest;
  teardown(): Promise<void>;
}

export async function setupJobControlFixture(prefix: string): Promise<JobControlFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), `aoa-${prefix}-`));
  const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
  const port = await allocateEmbeddedPgPort();
  const embedded = new EmbeddedPostgres({
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
  const admin = postgres(adminUrl, { max: 4 });
  await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
  await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", PASSWORD));
  const app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 16 });
  const operator = createOperatorDbConnection(adminUrl.replace("test:test", `aoa_operator:${PASSWORD}`), { max: 8 });

  await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'JOB-006 org', 'job-006-org')`;
  await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
    VALUES (${COMPANY}, ${ORG}, 'JOB-006 company', 'J006')`;
  const provider = providerProfile();
  const profile = registeredProfile(provider);
  await admin`INSERT INTO execution_targets
    (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
     target_authority_key, device_generation, registered_profile, registered_profile_hash,
     provider_constraint_profile, last_seen_at)
    VALUES (${TARGET}, ${ORG}, 'job-006-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
      'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
      ${provider}, clock_timestamp())`;
  const hello = workerHello();
  await admin`INSERT INTO workers
    (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
     device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
     last_seen_at, label, status)
    VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'job-006-public-key',
      ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
      clock_timestamp(), 'JOB-006 worker', 'enrolled')`;

  const leasing = createJobLeasingService({ appDb: app.db });

  async function resetRuntimeRows(): Promise<void> {
    await admin`DELETE FROM job_control_commands`;
    await admin`DELETE FROM job_events`;
    await admin`DELETE FROM job_projection_receipts`;
    await admin`DELETE FROM worker_operation_receipts`;
    await admin`DELETE FROM leases`;
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
      device_public_key = 'job-006-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  /** The placed-`job_attempts` INSERT, shared by attempt 1 and any sibling retry attempt so
   * the two rows are placed identically and a sibling differs ONLY in id + attempt_number. */
  async function insertPlacedAttempt(input: {
    jobId: string;
    attemptId: string;
    attemptNumber: number;
    availableAt: Date;
  }): Promise<void> {
    const provider = providerProfile();
    const profile = registeredProfile(provider);
    const profileHash = sha256(canonicalizeJsonV1(profile));
    await admin`INSERT INTO job_attempts
      (id, organization_id, company_id, job_id, attempt_number, status,
       placement_disposition, placement_owner, placement_target_id, placement_target_class,
       placement_target_scope, placement_target_generation, placement_profile_hash,
       placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
       placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
       placement_decided_at, created_at, updated_at)
      VALUES (${input.attemptId}, ${ORG}, ${COMPANY}, ${input.jobId}, ${input.attemptNumber}, 'pending',
        'selected', 'organization_dedicated', ${TARGET}, 'organization_dedicated',
        'organization', 1, ${profileHash}, ${provider.digest}, 'primary', 'target_selected',
        'active', true, ${"6".repeat(64)}, ${"6".repeat(64)}, clock_timestamp(),
        ${input.availableAt}, ${input.availableAt})`;
  }

  async function seedPlacedJob(ordinal: number, options?: { maxAttempts?: number }): Promise<{ jobId: string; attemptId: string }> {
    const suffix = ordinal.toString().padStart(12, "0");
    const jobId = `a6100000-0000-4000-8000-${suffix}`;
    const attemptId = `a6200000-0000-4000-8000-${suffix}`;
    const outboxId = `a6300000-0000-4000-8000-${suffix}`;
    const availableAt = new Date(Date.now() - 60_000 + ordinal);
    const maxAttempts = options?.maxAttempts ?? 3;
    const workload = { command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds: 600 };
    await admin`INSERT INTO jobs
      (id, organization_id, company_id, workload_type, source_kind, source_identity, source_intent,
       requester_principal_kind, requester_principal_id, executor_principal_kind, executor_principal_id,
       input, input_hash, policy_snapshot, policy_hash, requirements, placement_request,
       available_at, priority, status, max_attempts, created_at, updated_at)
       VALUES (${jobId}, ${ORG}, ${COMPANY}, 'batch', 'one_shot', ${jobId},
         ${{ kind: "one_shot", operationId: jobId, operationKind: "extraction" }},
         'system', 'job-006-test', 'worker', ${WORKER}, ${workload},
         ${"5".repeat(64)}, ${{ policyId: "job-submission-default", version: 1 }}, ${POLICY_HASH},
         ${{ workloadType: "batch", requiredCapabilities: ["sandbox.process_isolated"] }},
        ${{ policyId: "job-submission-default", policyVersion: 1, requestedTarget: TARGET }},
        ${availableAt}, 50, 'queued', ${maxAttempts}, ${availableAt}, ${availableAt})`;
    await insertPlacedAttempt({ jobId, attemptId, attemptNumber: 1, availableAt });
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
      providerConstraintHash: PROVIDER_DIGEST,
      fence: offer.fenceToken,
    };
  }

  async function activateLease(ordinal: number, options?: { maxAttempts?: number }) {
    await resetRuntimeRows();
    const seeded = await seedPlacedJob(ordinal, options);
    const polled = await leasing.poll({ auth: auth(`poll-${ordinal}`), request: pollRequest(`poll-${ordinal}`) });
    if (polled.outcome !== "offer") throw new Error(`expected offer, got ${polled.outcome}`);
    const offer = polled.body;
    const acked = await leasing.ack({ auth: auth(`ack-${ordinal}`), request: ackRequest(offer) });
    if (acked.outcome !== "acknowledged") throw new Error("expected ack");
    return { seeded, offer, identity: fenceIdentity(seeded, offer) };
  }

  async function activateSiblingLease(
    seeded: { jobId: string; attemptId: string },
    attemptNumber: number,
    ordinal: number,
  ) {
    const suffix = `${ordinal}${attemptNumber}`.padStart(12, "0");
    const attemptId = `a6400000-0000-4000-8000-${suffix}`;
    await insertPlacedAttempt({
      jobId: seeded.jobId,
      attemptId,
      attemptNumber,
      availableAt: new Date(Date.now() - 30_000 + ordinal),
    });
    const tag = `sib-${ordinal}-${attemptNumber}`;
    const polled = await leasing.poll({ auth: auth(`poll-${tag}`), request: pollRequest(`poll-${tag}`) });
    if (polled.outcome !== "offer") throw new Error(`expected sibling offer, got ${polled.outcome}`);
    const offer = polled.body;
    // The candidate lock could in principle have re-offered attempt 1; assert we got the
    // sibling, or the test built on this would silently be a same-attempt test.
    if (offer.job.attempt !== attemptNumber) {
      throw new Error(`expected an offer for attempt ${attemptNumber}, got ${offer.job.attempt}`);
    }
    const acked = await leasing.ack({ auth: auth(`ack-${tag}`), request: ackRequest(offer) });
    if (acked.outcome !== "acknowledged") throw new Error("expected sibling ack");
    return { attemptId, offer, identity: fenceIdentity({ jobId: seeded.jobId, attemptId }, offer) };
  }

  async function teardown(): Promise<void> {
    await operator.close({ timeoutSeconds: 5 }).catch(() => {});
    await app.close({ timeoutSeconds: 5 }).catch(() => {});
    await admin.end().catch(() => {});
    await embedded.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    admin,
    app,
    operator,
    leasing,
    resetRuntimeRows,
    seedPlacedJob,
    activateLease,
    activateSiblingLease,
    fenceIdentity,
    teardown,
  };
}
