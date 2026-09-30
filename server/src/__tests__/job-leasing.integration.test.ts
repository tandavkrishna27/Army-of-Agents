import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import {
  createJobLeasingService,
  JobLeasingError,
  type VerifiedWorkerOperation,
} from "../services/job-leasing.js";
import { createJobReadyScheduler } from "../services/job-ready-scheduler.js";
import { createJobOutboxWorker } from "../services/job-outbox-worker.js";
import { sql } from "drizzle-orm";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { settleAllClaimers } from "./helpers/settle-all-claimers.js";
import { runInTenant } from "../db/tenant-context.js";
import { createJobControlRepository } from "../../../packages/db/src/repositories/tenant/job-control.js";
import type { Db } from "../../../packages/db/src/client.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "a3000000-0000-4000-8000-000000000001";
const COMPANY = "a3000000-0000-4000-8000-000000000002";
const TARGET = "a3000000-0000-4000-8000-000000000003";
const OTHER_TARGET = "a3000000-0000-4000-8000-000000000004";
const WORKER = "a3000000-0000-4000-8000-000000000005";
const OTHER_WORKER = "a3000000-0000-4000-8000-000000000006";
const ORG_B = "a3000000-0000-4000-8000-000000000007";
const COMPANY_B = "a3000000-0000-4000-8000-000000000008";
const PLATFORM_TARGET = "a3000000-0000-4000-8000-000000000009";
const PLATFORM_PHYSICAL_WORKER = "a3000000-0000-4000-8000-000000000010";
const PLATFORM_LOGICAL_WORKER_A = "a3000000-0000-4000-8000-000000000011";
const PLATFORM_LOGICAL_WORKER_B = "a3000000-0000-4000-8000-000000000012";
const ALT_COMPANY = "a3000000-0000-4000-8000-000000000013";
const PASSWORD = "job-003-role-password";
const POLICY_HASH = "3".repeat(64);

// ★★★ E3-F034 — THE CONTENDED-CLAIMER BUDGET, AND WHY IT IS DERIVED RATHER THAN PICKED.
//
// The single-winner race below fires CONTENDED_CLAIMERS concurrent `poll()`s at ONE
// `execution_targets` row. Each poll takes that row `FOR UPDATE`
// (`repositories/tenant/job-control.ts` `lockWorkerLeaseAuthority`) and holds it to COMMIT,
// with ~8-10 further round trips inside — so the claimers SERIALIZE, by design, and that
// serialization IS the race the test exists to run.
//
// The pool cap is what decides how much of that queue is held on the DATABASE: postgres.js
// admits at most `max` sessions, so at any instant one holds the lock and at most `max - 1`
// are waiting on it CLIENT-SIDE-free, inside Postgres, against the connection's `lock_timeout`.
// The remaining claimers queue in the driver and are not waiting on a lock at all.
//
// On the shared pool that budget was production's 750 ms. So the test silently ALSO asserted
// "23 serialized poll transactions complete in under 750 ms on this runner's storage" — an
// ENVIRONMENT assertion, never written down and never in the test's name. It held at ~9 ms per
// poll (measured locally) and broke at the ~32 ms implied by the observed CI failure, where
// 93 polls succeeded and 7 raised `55P03`. The design converted slow storage into a red gate.
//
// The fix gives THIS test its own connection with a budget sized to the queue it deliberately
// creates. Nothing about the property changes: same claimer count, same single row, same pool
// cap, so the DATABASE-level overlap — the thing that makes it a race — is identical. What is
// dropped is a latency assertion the test never made on purpose.
const CONTENDED_CLAIMERS = 100;
/** Unchanged from the shared pool: the DB-level overlap must not move. */
const CONTENDED_POOL_MAX = 24;
/** Per queued waiter. ~55x the 9 ms measured locally, ~15x the ~32 ms implied by the CI failure. */
const CONTENDED_PER_POLL_ALLOWANCE_MS = 500;
/** The floor the connection's lock budget must clear; raising the pool raises this too. */
const CONTENDED_REQUIRED_LOCK_BUDGET_MS = (CONTENDED_POOL_MAX - 1) * CONTENDED_PER_POLL_ALLOWANCE_MS;
/** What is configured. Must clear the floor, and stay inside the test's own 60 s timeout. */
const CONTENDED_TIMEOUT_MS = 20_000;
const THUMBPRINT = "4".repeat(64);

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(maxConcurrentOperations = 2): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "job-003-provider",
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

function platformProviderProfile(maxConcurrentOperations = 1): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "job-003-platform-provider",
    version: 1,
    maxContinuousRuntimeSeconds: 3_600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2_000, memoryMiB: 4_096, pids: 512, diskMiB: 8_192 },
    maxConcurrentOperations,
    supportedOperations: [
      "create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup",
    ],
    localityTags: ["transfer_allowed"],
    checkpointMode: "none",
    healthMode: "none",
  } as const;
  return {
    ...unsigned,
    digest: sha256(canonicalProviderConstraintProfileDigestInputV1(unsigned)),
  };
}

function registeredProfile(
  provider: ProviderConstraintProfileV1,
  targetId = TARGET,
): RegisteredTargetProfileV1 {
  return {
    protocolVersion: 1,
    targetId,
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

function platformRegisteredProfile(provider: ProviderConstraintProfileV1): RegisteredTargetProfileV1 {
  return {
    protocolVersion: 1,
    targetId: PLATFORM_TARGET,
    targetClass: "managed_cloud",
    scope: "platform",
    organizationId: null,
    ownerPrincipalId: null,
    trustCeiling: "shared_isolated",
    credentialCeiling: "platform_brokered",
    dataLocalityCeiling: "transfer_allowed",
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

function workerHello(workerId = WORKER, targetId = TARGET, batchSlots = 2) {
  return {
    protocolVersion: 1 as const,
    workerId,
    targetId,
    deviceGeneration: 1,
    agentVersion: "job-003-integration",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux" as const, arch: "x64" as const, runtime: "worker" },
    reportedCapabilities: ["workload.batch" as const, "sandbox.process_isolated" as const],
    capacity: {
      batchSlots,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 2_000,
      freeMemoryMiB: 4_096,
      freeDiskMiB: 8_192,
    },
    policyHash: POLICY_HASH,
  };
}

function pollRequest(workerId: string, targetId: string, nonce: string, batchSlots = 2): PollRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce,
    audience: "worker_poll",
    workerId,
    targetId,
    deviceGeneration: 1,
    capacity: {
      batchSlots,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 2_000,
      freeMemoryMiB: 4_096,
      freeDiskMiB: 8_192,
    },
  };
}

function pollRequestWithCapacity(
  workerId: string,
  targetId: string,
  nonce: string,
  capacity: PollRequestV1["capacity"],
): PollRequestV1 {
  return { ...pollRequest(workerId, targetId, nonce), capacity };
}

function ackRequest(
  offer: LeaseOfferV1,
  idempotencyKey = crypto.randomUUID(),
  body: Partial<LeaseAckOperationRequestV1["body"]> = {},
): LeaseAckOperationRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `ack-${crypto.randomUUID()}`,
    audience: "worker_run",
    idempotencyKey,
    body: {
      protocolVersion: 1,
      workerId: offer.workerId,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      ackedAt: new Date().toISOString(),
      extensions: [],
      ...body,
    },
  };
}

integration("JOB-003 atomic poll/offer and ready hints", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let adminUrl = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let operator: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;

  function guard() {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!admin || !app || !operator) throw new Error("test setup incomplete");
    return { admin, app, operator };
  }

  /** A pool used ONLY by the single-winner race: same role, same cap, a lock budget sized to
   * the queue the race deliberately creates. Every other test keeps production's 750 ms. */
  function createContendedAppDb(): NonOwnerDbConnection {
    guard();
    return createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), {
      max: CONTENDED_POOL_MAX,
      lockTimeoutMs: CONTENDED_TIMEOUT_MS,
      // A `FOR UPDATE` that waits also spends that time inside its STATEMENT, and a poll
      // transaction is idle between round trips while the ones ahead of it commit. Raising
      // `lock_timeout` alone would just move the abort to `57014`/`25P03`.
      statementTimeoutMs: CONTENDED_TIMEOUT_MS,
      idleInTransactionSessionTimeoutMs: CONTENDED_TIMEOUT_MS,
    });
  }

  /** ★ THE ANTI-REGRESSION PIN FOR THE BUDGET HALF OF E3-F034.
   *
   * The threshold defect cannot be reproduced on demand — it needs a slow runner — so timing
   * can never be the evidence that it is fixed. This asserts the PROPERTY instead, read back
   * from the live session: the budget this race runs on clears the queue it creates. Drop the
   * options and it reads 750 ms and reds; raise `CONTENDED_POOL_MAX` without raising the
   * budget and it reds too, because the floor is derived from the pool. */
  async function assertContendedLockBudget(connection: NonOwnerDbConnection): Promise<void> {
    const [settings] = await connection.db.execute<{ lock: string; statement: string; idle: string }>(sql`
      SELECT current_setting('lock_timeout') AS "lock",
             current_setting('statement_timeout') AS "statement",
             current_setting('idle_in_transaction_session_timeout') AS "idle"`);
    const budgets = {
      lock: parseGucMillis(settings?.lock),
      statement: parseGucMillis(settings?.statement),
      idle: parseGucMillis(settings?.idle),
    };
    expect.soft(CONTENDED_TIMEOUT_MS).toBeGreaterThanOrEqual(CONTENDED_REQUIRED_LOCK_BUDGET_MS);
    expect.soft(budgets.lock).toBeGreaterThanOrEqual(CONTENDED_REQUIRED_LOCK_BUDGET_MS);
    expect.soft(budgets.statement).toBeGreaterThanOrEqual(CONTENDED_REQUIRED_LOCK_BUDGET_MS);
    expect.soft(budgets.idle).toBeGreaterThanOrEqual(CONTENDED_REQUIRED_LOCK_BUDGET_MS);
  }

  /** Postgres reports a millisecond GUC as `"20s"`, `"750ms"` or a bare `"20000"`. */
  function parseGucMillis(raw: string | undefined): number {
    if (!raw) return Number.NaN;
    const match = /^(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?$/.exec(raw.trim());
    if (!match) return Number.NaN;
    const unit = { us: 0.001, ms: 1, s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? "ms"];
    return Number(match[1]) * (unit ?? 1);
  }

  function auth(
    proofId: string,
    workerId = WORKER,
    targetId = TARGET,
    profileHash = sha256(JSON.stringify(workerHello(workerId, targetId))),
    organizationId = ORG,
    targetGeneration = 1,
  ): VerifiedWorkerOperation {
    return {
      organizationId,
      workerId,
      targetId,
      targetGeneration,
      deviceThumbprint: THUMBPRINT,
      profileHash,
      publicKey: "job-003-public-key",
      proofId,
      proofIssuedAt: new Date(),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  async function resetRuntimeRows(): Promise<void> {
    const { admin } = guard();
    await admin`DELETE FROM worker_operation_receipts`;
    await admin`DELETE FROM leases`;
    await admin`DELETE FROM job_outbox`;
    await admin`DELETE FROM job_attempts`;
    await admin`DELETE FROM jobs`;
    await admin`DELETE FROM worker_proof_replays`;
    const provider = providerProfile();
    const profile = registeredProfile(provider);
    const otherProfile = registeredProfile(provider, OTHER_TARGET);
    await admin`UPDATE execution_targets SET status = 'active', device_generation = 1,
      registered_profile = ${profile}, registered_profile_hash = ${sha256(canonicalizeJsonV1(profile))},
      provider_constraint_profile = ${provider}, last_seen_at = clock_timestamp()
      WHERE id = ${TARGET}`;
    await admin`UPDATE execution_targets SET status = 'active', device_generation = 1,
      registered_profile = ${otherProfile}, registered_profile_hash = ${sha256(canonicalizeJsonV1(otherProfile))},
      provider_constraint_profile = ${provider}, last_seen_at = clock_timestamp()
      WHERE id = ${OTHER_TARGET}`;
    const hello = workerHello();
    const otherHello = workerHello(OTHER_WORKER, OTHER_TARGET);
    await admin`UPDATE workers SET status = 'enrolled', revoked_at = NULL, device_generation = 1,
      profile_hash = ${sha256(JSON.stringify(hello))}, profile_snapshot = ${hello},
      device_public_key = 'job-003-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
    await admin`UPDATE workers SET status = 'enrolled', revoked_at = NULL, device_generation = 1,
      profile_hash = ${sha256(JSON.stringify(otherHello))}, profile_snapshot = ${otherHello},
      device_public_key = 'job-003-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${OTHER_WORKER}`;
  }

  async function configureMixedWorkloadAuthority(): Promise<{
    workerProfileHash: string;
    targetProfileHash: string;
    providerHash: string;
  }> {
    const { admin } = guard();
    const provider = providerProfile(2);
    const profile = {
      ...registeredProfile(provider),
      capabilityCeiling: [
        "workload.batch",
        "workload.browser_session",
        "sandbox.process_isolated",
      ],
    };
    const hello = {
      ...workerHello(WORKER, TARGET, 1),
      reportedCapabilities: [
        "workload.batch",
        "workload.browser_session",
        "sandbox.process_isolated",
      ],
      capacity: {
        batchSlots: 1,
        browserSessionSlots: 1,
        serviceSlots: 0,
        freeCpuMillis: 2_000,
        freeMemoryMiB: 4_096,
        freeDiskMiB: 8_192,
      },
    };
    const workerProfileHash = sha256(JSON.stringify(hello));
    const targetProfileHash = sha256(canonicalizeJsonV1(profile));
    await admin`UPDATE execution_targets SET
      registered_profile = ${profile},
      registered_profile_hash = ${targetProfileHash},
      provider_constraint_profile = ${provider},
      status = 'active', device_generation = 1, last_seen_at = clock_timestamp()
      WHERE id = ${TARGET}`;
    await admin`UPDATE workers SET
      profile_hash = ${workerProfileHash}, profile_snapshot = ${hello}, status = 'enrolled',
      revoked_at = NULL, device_generation = 1, last_seen_at = clock_timestamp()
      WHERE id = ${WORKER}`;
    return { workerProfileHash, targetProfileHash, providerHash: provider.digest };
  }

  async function seedPlacedJob(input: {
    ordinal: number;
    organizationId?: string;
    companyId?: string;
    workerId?: string;
    availableAt?: Date;
    workloadType?: "batch" | "browser_session";
    requiredCapabilities?: string[];
    placement?: Partial<{
      disposition: string;
      mode: string;
      leaseEligible: boolean;
      targetId: string;
      owner: string;
      targetClass: string;
      targetScope: string;
      generation: number;
      profileHash: string;
      providerHash: string;
    }>;
    outbox?: boolean;
  }): Promise<{ jobId: string; attemptId: string; outboxId: string }> {
    const { admin } = guard();
    const suffix = input.ordinal.toString().padStart(12, "0");
    const jobId = `a3100000-0000-4000-8000-${suffix}`;
    const attemptId = `a3200000-0000-4000-8000-${suffix}`;
    const outboxId = `a3300000-0000-4000-8000-${suffix}`;
    const organizationId = input.organizationId ?? ORG;
    const companyId = input.companyId ?? COMPANY;
    const workerId = input.workerId ?? WORKER;
    const provider = providerProfile();
    const profile = registeredProfile(provider);
    const workloadType = input.workloadType ?? "batch";
    const workload = workloadType === "browser_session"
      ? {
          engine: "chromium",
          viewport: { width: 1280, height: 720 },
          locale: "en-US",
          timezone: "UTC",
          recordTrace: false,
          recordVideo: false,
          maxSessionSeconds: 600,
        }
      : { command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds: 600 };
    const requiredCapabilities = input.requiredCapabilities ?? (workloadType === "browser_session"
      ? ["workload.browser_session"]
      : ["sandbox.process_isolated"]);
    const placement = {
      disposition: "selected",
      mode: "active",
      leaseEligible: true,
      targetId: TARGET,
      owner: "organization_dedicated",
      targetClass: "organization_dedicated",
      targetScope: "organization",
      generation: 1,
      profileHash: sha256(canonicalizeJsonV1(profile)),
      providerHash: provider.digest,
      ...input.placement,
    };
    const availableAt = input.availableAt ?? new Date(Date.now() - 60_000 + input.ordinal);
    await admin`INSERT INTO jobs
      (id, organization_id, company_id, workload_type, source_kind, source_identity, source_intent,
       requester_principal_kind, requester_principal_id, executor_principal_kind, executor_principal_id,
       input, input_hash, policy_snapshot, policy_hash, requirements, placement_request,
       available_at, priority, status, created_at, updated_at)
       VALUES (${jobId}, ${organizationId}, ${companyId}, ${workloadType}, 'one_shot', ${jobId},
         ${{ kind: "one_shot", operationId: jobId, operationKind: "extraction" }},
         'system', 'job-003-test', 'worker', ${workerId},
         ${workload},
         ${"5".repeat(64)}, ${{ policyId: "job-submission-default", version: 1 }}, ${POLICY_HASH},
         ${{ workloadType, requiredCapabilities }},
        ${{ policyId: "job-submission-default", policyVersion: 1, requestedTarget: placement.targetId }},
        ${availableAt}, 50, 'queued', ${availableAt}, ${availableAt})`;
    await admin`INSERT INTO job_attempts
      (id, organization_id, company_id, job_id, attempt_number, status,
       placement_disposition, placement_owner, placement_target_id, placement_target_class,
       placement_target_scope, placement_target_generation, placement_profile_hash,
       placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
       placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
       placement_decided_at, created_at, updated_at)
      VALUES (${attemptId}, ${organizationId}, ${companyId}, ${jobId}, 1, 'pending',
        ${placement.disposition}, ${placement.owner}, ${placement.targetId},
        ${placement.targetClass}, ${placement.targetScope}, ${placement.generation}, ${placement.profileHash},
        ${placement.providerHash}, 'primary', 'target_selected', ${placement.mode},
        ${placement.leaseEligible}, ${"6".repeat(64)}, ${"6".repeat(64)}, clock_timestamp(),
        ${availableAt}, ${availableAt})`;
    if (input.outbox !== false) {
      await admin`INSERT INTO job_outbox
        (id, organization_id, company_id, job_id, attempt_id, kind, status, payload, available_at)
        VALUES (${outboxId}, ${organizationId}, ${companyId}, ${jobId}, ${attemptId}, 'attempt_ready', 'pending',
          ${{ organizationId, companyId, jobId, attemptId, sourceKind: "one_shot" }},
          clock_timestamp())`;
    }
    return { jobId, attemptId, outboxId };
  }

  async function seedLeaseRejectionCertificate(input: {
    ordinal: number;
    workerId?: string;
    targetId?: string;
    authorityKey?: string;
    placement?: Parameters<typeof seedPlacedJob>[0]["placement"];
    updatedAt?: Date;
  }): Promise<{ jobId: string; attemptId: string; workerId: string }> {
    const { admin } = guard();
    const workerId = input.workerId ?? WORKER;
    const targetId = input.targetId ?? TARGET;
    const authorityKey = input.authorityKey ?? `organization:${ORG}`;
    const seeded = await seedPlacedJob({
      ordinal: input.ordinal,
      outbox: false,
      workerId,
      placement: input.placement,
    });
    await admin`INSERT INTO worker_lease_rejections
      (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
       target_authority_key, eligibility_version, static_context_hash, workload_type,
       placement_owner, placement_target_class, placement_target_scope,
       placement_target_generation, placement_profile_hash,
       placement_provider_constraint_hash, placement_input_digest,
       placement_policy_digest, reason_code, created_at, updated_at)
      SELECT attempt.organization_id, attempt.company_id, attempt.job_id, attempt.id,
        ${workerId}, ${targetId}, ${authorityKey}, 1, ${"8".repeat(64)}, job.workload_type,
        attempt.placement_owner, attempt.placement_target_class, attempt.placement_target_scope,
        attempt.placement_target_generation, attempt.placement_profile_hash,
        attempt.placement_provider_constraint_hash, attempt.placement_input_digest,
        attempt.placement_policy_digest, 'static_requirements_mismatch',
        ${input.updatedAt ?? new Date("2026-01-01T00:00:00.000Z")},
        ${input.updatedAt ?? new Date("2026-01-01T00:00:00.000Z")}
      FROM job_attempts attempt JOIN jobs job ON job.id = attempt.job_id
      WHERE attempt.id = ${seeded.attemptId}`;
    return { ...seeded, workerId };
  }

  async function seedBulkLeaseRejectionCertificates(count: number, obsolete: boolean): Promise<void> {
    const { admin } = guard();
    await admin.unsafe(`
      WITH seed AS (
        SELECT series AS ordinal,
          ('b3100000-0000-4000-8000-' || lpad(to_hex(series), 12, '0'))::uuid AS job_id,
          ('b3200000-0000-4000-8000-' || lpad(to_hex(series), 12, '0'))::uuid AS attempt_id
        FROM generate_series(1, $1::integer) AS series
      )
      INSERT INTO jobs
        (id, organization_id, company_id, workload_type, source_kind, source_identity, source_intent,
         requester_principal_kind, requester_principal_id, executor_principal_kind, executor_principal_id,
         input, input_hash, policy_snapshot, policy_hash, requirements, placement_request,
         available_at, priority, status, created_at, updated_at)
      SELECT job_id, $2::uuid, $3::uuid, 'batch', 'one_shot', job_id::text,
        jsonb_build_object('kind', 'one_shot', 'operationId', job_id, 'operationKind', 'extraction'),
        'system', 'job-003-bulk', 'worker', $4::uuid, '{}'::jsonb, repeat('5', 64),
        '{"policyId":"job-submission-default","version":1}'::jsonb, repeat('3', 64),
        '{"workloadType":"batch","requiredCapabilities":[]}'::jsonb,
        jsonb_build_object('policyId', 'job-submission-default', 'policyVersion', 1,
          'requestedTarget', $5::uuid),
        clock_timestamp(), 50, 'queued', clock_timestamp(), clock_timestamp()
      FROM seed
    `, [count, ORG, COMPANY, WORKER, TARGET]);
    await admin.unsafe(`
      WITH seed AS (
        SELECT series AS ordinal,
          ('b3100000-0000-4000-8000-' || lpad(to_hex(series), 12, '0'))::uuid AS job_id,
          ('b3200000-0000-4000-8000-' || lpad(to_hex(series), 12, '0'))::uuid AS attempt_id
        FROM generate_series(1, $1::integer) AS series
      ), authority AS (
        SELECT registered_profile_hash, provider_constraint_profile->>'digest' AS provider_hash,
          device_generation
        FROM execution_targets WHERE id = $4::uuid
      )
      INSERT INTO job_attempts
        (id, organization_id, company_id, job_id, attempt_number, status,
         placement_disposition, placement_owner, placement_target_id, placement_target_class,
         placement_target_scope, placement_target_generation, placement_profile_hash,
         placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
         placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
         placement_decided_at, created_at, updated_at)
      SELECT attempt_id, $2::uuid, $3::uuid, job_id, 1,
        CASE WHEN $5::boolean THEN 'leased' ELSE 'pending' END,
        'selected', 'organization_dedicated', $4::uuid, 'organization_dedicated', 'organization',
        authority.device_generation, authority.registered_profile_hash, authority.provider_hash,
        'primary', 'target_selected', 'active', true, repeat('6', 64), repeat('6', 64),
        clock_timestamp(), clock_timestamp(), clock_timestamp()
      FROM seed CROSS JOIN authority
    `, [count, ORG, COMPANY, TARGET, obsolete]);
    await admin.unsafe(`
      INSERT INTO worker_lease_rejections
        (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
         target_authority_key, eligibility_version, static_context_hash, workload_type,
         placement_owner, placement_target_class, placement_target_scope,
         placement_target_generation, placement_profile_hash,
         placement_provider_constraint_hash, placement_input_digest,
         placement_policy_digest, reason_code, created_at, updated_at)
      SELECT attempt.organization_id, attempt.company_id, attempt.job_id, attempt.id,
        $2::uuid, $3::uuid, $4, 1, repeat('8', 64), job.workload_type,
        attempt.placement_owner, attempt.placement_target_class, attempt.placement_target_scope,
        attempt.placement_target_generation, attempt.placement_profile_hash,
        attempt.placement_provider_constraint_hash, attempt.placement_input_digest,
        attempt.placement_policy_digest, 'static_requirements_mismatch',
        clock_timestamp() + (attempt.attempt_number * interval '1 microsecond'),
        clock_timestamp() + (attempt.attempt_number * interval '1 microsecond')
      FROM job_attempts attempt JOIN jobs job ON job.id = attempt.job_id
      WHERE attempt.organization_id = $1::uuid AND attempt.id::text LIKE 'b3200000-%'
    `, [ORG, WORKER, TARGET, `organization:${ORG}`]);
  }

  async function offerPlacedJob(input: {
    ordinal: number;
    service?: ReturnType<typeof createJobLeasingService>;
  }): Promise<{
    seeded: Awaited<ReturnType<typeof seedPlacedJob>>;
    offer: LeaseOfferV1;
    service: ReturnType<typeof createJobLeasingService>;
  }> {
    const { app } = guard();
    const seeded = await seedPlacedJob({ ordinal: input.ordinal });
    const service = input.service ?? createJobLeasingService({ appDb: app.db });
    const result = await service.poll({
      auth: auth(`offer-${input.ordinal}`),
      request: pollRequest(WORKER, TARGET, `offer-${input.ordinal}`),
    });
    if (result.outcome !== "offer") throw new Error("expected lease offer");
    return { seeded, offer: result.body, service };
  }

  async function expectOfferUnchanged(attemptId: string): Promise<void> {
    const { admin } = guard();
    const [state] = await admin<{
      leaseStatus: string;
      attemptStatus: string;
      receipts: number;
    }[]>`SELECT
      (SELECT status FROM leases WHERE attempt_id = ${attemptId}) AS "leaseStatus",
      (SELECT status FROM job_attempts WHERE id = ${attemptId}) AS "attemptStatus",
      (SELECT count(*)::int FROM worker_operation_receipts WHERE attempt_id = ${attemptId}) AS receipts`;
    expect(state).toEqual({ leaseStatus: "offered", attemptStatus: "offered", receipts: 0 });
  }

  async function installOfferRestartGate(input: {
    attemptId: string;
    allowOnPass: 3 | 4;
    stem: "success" | "exhaustion";
  }): Promise<{ readPasses(): Promise<number>; drop(): Promise<void> }> {
    const { admin } = guard();
    const sequenceName = `job003_offer_restart_${input.stem}_seq`;
    const functionName = `job003_offer_restart_${input.stem}_fn`;
    const triggerName = `job003_offer_restart_${input.stem}_trigger`;
    // nextval is deliberately nontransactional: it is the independent oracle
    // for head passes whose tenant transactions must otherwise leave no trace.
    await admin.unsafe(`CREATE SEQUENCE ${sequenceName} START WITH 1`);
    await admin.unsafe(`GRANT USAGE, SELECT ON SEQUENCE ${sequenceName} TO aoa_app`);
    await admin.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE restart_pass bigint;
      BEGIN
        restart_pass := nextval('${sequenceName}'::regclass);
        IF restart_pass < ${input.allowOnPass} THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END $$`);
    await admin.unsafe(`CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF status ON job_attempts
      FOR EACH ROW WHEN (
        OLD.id = '${input.attemptId}'::uuid
        AND OLD.status = 'pending'
        AND NEW.status = 'offered'
      ) EXECUTE FUNCTION ${functionName}()`);
    return {
      async readPasses() {
        const [row] = await admin.unsafe<Array<{ passes: number }>>(
          `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS passes FROM ${sequenceName}`,
        );
        return Number(row?.passes ?? 0);
      },
      async drop() {
        await admin.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON job_attempts`);
        await admin.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
        await admin.unsafe(`DROP SEQUENCE IF EXISTS ${sequenceName}`);
      },
    };
  }

  async function installCertificateWriteCounter(input: {
    attemptId: string;
    stem: "success" | "exhaustion" | "logical_profile" | "physical_profile" | "target_profile";
    workerId?: string;
  }): Promise<{ readWrites(): Promise<number>; drop(): Promise<void> } | null> {
    const { admin } = guard();
    const [table] = await admin<{ name: string | null }[]>`
      SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
    if (table?.name !== "worker_lease_rejections") return null;
    const sequenceName = `job003_certificate_restart_${input.stem}_seq`;
    const functionName = `job003_certificate_restart_${input.stem}_fn`;
    const triggerName = `job003_certificate_restart_${input.stem}_trigger`;
    // Count the real repository insert before rollback erases the certificate.
    await admin.unsafe(`CREATE SEQUENCE ${sequenceName} START WITH 1`);
    await admin.unsafe(`GRANT USAGE, SELECT ON SEQUENCE ${sequenceName} TO aoa_app`);
    await admin.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM nextval('${sequenceName}'::regclass);
        RETURN NEW;
      END $$`);
    await admin.unsafe(`CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON worker_lease_rejections
      FOR EACH ROW WHEN (
        NEW.worker_id = '${input.workerId ?? WORKER}'::uuid
        AND NEW.attempt_id = '${input.attemptId}'::uuid
      ) EXECUTE FUNCTION ${functionName}()`);
    return {
      async readWrites() {
        const [row] = await admin.unsafe<Array<{ writes: number }>>(
          `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS writes FROM ${sequenceName}`,
        );
        return Number(row?.writes ?? 0);
      },
      async drop() {
        await admin.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON worker_lease_rejections`);
        await admin.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
        await admin.unsafe(`DROP SEQUENCE IF EXISTS ${sequenceName}`);
      },
    };
  }

  async function installClaimAttemptCounter(input: {
    attemptId: string;
    stem: "logical_303" | "physical_202" | "target_101";
  }): Promise<{ readAttempts(): Promise<number>; drop(): Promise<void> }> {
    const { admin } = guard();
    const sequenceName = `job003_divergence_claim_${input.stem}_seq`;
    const functionName = `job003_divergence_claim_${input.stem}_fn`;
    const triggerName = `job003_divergence_claim_${input.stem}_trigger`;
    // This sequence survives rollback and proves whether claim was attempted at all.
    await admin.unsafe(`CREATE SEQUENCE ${sequenceName} START WITH 1`);
    await admin.unsafe(`GRANT USAGE, SELECT ON SEQUENCE ${sequenceName} TO aoa_app`);
    await admin.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('${sequenceName}'::regclass); RETURN NEW; END $$`);
    await admin.unsafe(`CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF status ON job_attempts
      FOR EACH ROW WHEN (
        OLD.id = '${input.attemptId}'::uuid
        AND OLD.status = 'pending'
        AND NEW.status = 'offered'
      ) EXECUTE FUNCTION ${functionName}()`);
    return {
      async readAttempts() {
        const [row] = await admin.unsafe<Array<{ attempts: number }>>(
          `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS attempts FROM ${sequenceName}`,
        );
        return Number(row?.attempts ?? 0);
      },
      async drop() {
        await admin.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON job_attempts`);
        await admin.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
        await admin.unsafe(`DROP SEQUENCE IF EXISTS ${sequenceName}`);
      },
    };
  }

  async function cancelActiveBackends(input: { pids?: number[]; roles?: string[] }): Promise<void> {
    const { admin } = guard();
    const pids = input.pids ?? [];
    const roles = input.roles ?? [];
    await admin`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND state <> 'idle'
        AND (${pids.length} = 0 OR pid = ANY(${pids}::int[]))
        AND (${roles.length} = 0 OR usename = ANY(${roles}::text[]))`;
  }

  async function boundedAwait<T>(
    description: string,
    operation: PromiseLike<T>,
    cancel: () => Promise<void>,
    timeoutMs = 15_000,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void cancel().catch(() => {}).finally(() => reject(new Error(`timed out waiting for ${description}`)));
      }, timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve(operation), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function waitUntil(
    description: string,
    predicate: () => Promise<boolean>,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${description}`);
  }

  async function installContextRefreshRestartBarrier(input: {
    attemptId: string;
    stem: "logical_profile" | "physical_profile" | "target_profile";
    advisoryKey: number;
  }): Promise<{
    readPasses(): Promise<number>;
    waitForFirstPass(): Promise<void>;
    drop(): Promise<void>;
  }> {
    const { admin } = guard();
    const sequenceName = `job003_context_restart_${input.stem}_seq`;
    const functionName = `job003_context_restart_${input.stem}_fn`;
    const triggerName = `job003_context_restart_${input.stem}_trigger`;
    await admin.unsafe(`CREATE SEQUENCE ${sequenceName} START WITH 1`);
    await admin.unsafe(`GRANT USAGE, SELECT ON SEQUENCE ${sequenceName} TO aoa_app`);
    await admin.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE restart_pass bigint;
      BEGIN
        restart_pass := nextval('${sequenceName}'::regclass);
        IF restart_pass = 1 THEN
          PERFORM pg_advisory_lock(${input.advisoryKey});
          PERFORM pg_advisory_unlock(${input.advisoryKey});
          RETURN NULL;
        END IF;
        RETURN NEW;
      END $$`);
    await admin.unsafe(`CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF status ON job_attempts
      FOR EACH ROW WHEN (
        OLD.id = '${input.attemptId}'::uuid
        AND OLD.status = 'pending'
        AND NEW.status = 'offered'
      ) EXECUTE FUNCTION ${functionName}()`);
    const readPasses = async (): Promise<number> => {
      const [row] = await admin.unsafe<Array<{ passes: number }>>(
        `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS passes FROM ${sequenceName}`,
      );
      return Number(row?.passes ?? 0);
    };
    return {
      readPasses,
      async waitForFirstPass() {
        await waitUntil(`${input.stem} first restart pass`, async () => await readPasses() >= 1);
      },
      async drop() {
        await admin.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON job_attempts`);
        await admin.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
        await admin.unsafe(`DROP SEQUENCE IF EXISTS ${sequenceName}`);
      },
    };
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-job-leasing-"));
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
      app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 24 });
      operator = createOperatorDbConnection(
        adminUrl.replace("test:test", `aoa_operator:${PASSWORD}`),
        { max: 8 },
      );
      await admin`INSERT INTO organizations (id, name, slug) VALUES
        (${ORG}, 'JOB-003 org', 'job-003-org'),
        (${ORG_B}, 'JOB-003 org B', 'job-003-org-b')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix) VALUES
        (${COMPANY}, ${ORG}, 'JOB-003 company', 'J003'),
        (${COMPANY_B}, ${ORG_B}, 'JOB-003 company B', 'J03B')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      const otherProfile = registeredProfile(provider, OTHER_TARGET);
      const platformProvider = platformProviderProfile();
      const platformProfile = platformRegisteredProfile(platformProvider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES
        (${TARGET}, ${ORG}, 'job-003-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${`organization:${ORG}`}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp()),
        (${OTHER_TARGET}, ${ORG}, 'job-003-other-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${`organization:${ORG}`}, 1, ${otherProfile}, ${sha256(canonicalizeJsonV1(otherProfile))},
          ${provider}, clock_timestamp()),
        (${PLATFORM_TARGET}, NULL, 'job-003-platform-target', 'pooled_gvisor', 'shared_multitenant',
          'active', '{}', '{}', 'platform', 'platform', 1, ${platformProfile},
          ${sha256(canonicalizeJsonV1(platformProfile))}, ${platformProvider}, clock_timestamp())`;
      const hello = workerHello();
      const otherHello = workerHello(OTHER_WORKER, OTHER_TARGET);
      const platformPhysicalHello = workerHello(PLATFORM_PHYSICAL_WORKER, PLATFORM_TARGET, 1);
      const platformLogicalHelloA = workerHello(PLATFORM_LOGICAL_WORKER_A, PLATFORM_TARGET, 1);
      const platformLogicalHelloB = workerHello(PLATFORM_LOGICAL_WORKER_B, PLATFORM_TARGET, 1);
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES
        (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${`organization:${ORG}`}, 'job-003-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'JOB-003 worker', 'enrolled'),
        (${OTHER_WORKER}, 'organization', ${ORG}, ${OTHER_TARGET}, ${`organization:${ORG}`}, 'job-003-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(otherHello))}, ${otherHello}, clock_timestamp(),
          clock_timestamp(), 'JOB-003 other worker', 'enrolled'),
        (${PLATFORM_PHYSICAL_WORKER}, 'platform', NULL, ${PLATFORM_TARGET}, 'platform', 'job-003-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(platformPhysicalHello))}, ${platformPhysicalHello},
          clock_timestamp(), clock_timestamp(), 'JOB-003 platform physical worker', 'active'),
        (${PLATFORM_LOGICAL_WORKER_A}, 'organization', ${ORG}, ${PLATFORM_TARGET}, 'platform',
          'job-003-public-key', ${THUMBPRINT}, 1, ${sha256(JSON.stringify(platformLogicalHelloA))},
          ${platformLogicalHelloA}, clock_timestamp(), NULL, 'JOB-003 platform logical worker A', 'enrolled'),
        (${PLATFORM_LOGICAL_WORKER_B}, 'organization', ${ORG_B}, ${PLATFORM_TARGET}, 'platform',
          'job-003-public-key', ${THUMBPRINT}, 1, ${sha256(JSON.stringify(platformLogicalHelloB))},
          ${platformLogicalHelloB}, clock_timestamp(), NULL, 'JOB-003 platform logical worker B', 'enrolled')`;
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

  it("cleans only exact certificate tuples and reports truthful bounded cardinality in the same tenant transaction", async () => {
    // Mutation caught: independent worker/target/attempt IN lists delete the retained
    // WORKER x attempt-2 cross-tuple when attempt-1 and OTHER_WORKER x attempt-2 are selected.
    const { admin, app } = guard();
    await resetRuntimeRows();
    const first = await seedPlacedJob({ ordinal: 7_001, outbox: false });
    const second = await seedPlacedJob({ ordinal: 7_002, outbox: false });
    const [platformFacts] = await admin<{
      profileHash: string;
      providerHash: string;
    }[]>`SELECT registered_profile_hash AS "profileHash",
        provider_constraint_profile->>'digest' AS "providerHash"
      FROM execution_targets WHERE id = ${PLATFORM_TARGET}`;
    const third = await seedPlacedJob({
      ordinal: 7_003,
      outbox: false,
      workerId: PLATFORM_LOGICAL_WORKER_A,
      placement: {
        targetId: PLATFORM_TARGET,
        owner: "managed_cloud",
        targetClass: "managed_cloud",
        targetScope: "platform",
        profileHash: platformFacts!.profileHash,
        providerHash: platformFacts!.providerHash,
      },
    });

    const certificateHash = "9".repeat(64);
    async function insertCertificate(input: {
      attemptId: string;
      workerId: string;
      targetId: string;
      authorityKey: string;
    }): Promise<void> {
      await admin`INSERT INTO worker_lease_rejections
        (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
         target_authority_key, eligibility_version, static_context_hash, workload_type,
         placement_owner, placement_target_class, placement_target_scope,
         placement_target_generation, placement_profile_hash,
         placement_provider_constraint_hash, placement_input_digest,
         placement_policy_digest, reason_code)
        SELECT attempt.organization_id, attempt.company_id, attempt.job_id, attempt.id,
          ${input.workerId}, ${input.targetId}, ${input.authorityKey}, 1, ${certificateHash},
          job.workload_type, attempt.placement_owner, attempt.placement_target_class,
          attempt.placement_target_scope, attempt.placement_target_generation,
          attempt.placement_profile_hash, attempt.placement_provider_constraint_hash,
          attempt.placement_input_digest, attempt.placement_policy_digest,
          'static_requirements_mismatch'
        FROM job_attempts attempt JOIN jobs job ON job.id = attempt.job_id
        WHERE attempt.id = ${input.attemptId}`;
    }

    await insertCertificate({
      attemptId: first.attemptId,
      workerId: WORKER,
      targetId: TARGET,
      authorityKey: `organization:${ORG}`,
    });
    await insertCertificate({
      attemptId: second.attemptId,
      workerId: OTHER_WORKER,
      targetId: OTHER_TARGET,
      authorityKey: `organization:${ORG}`,
    });
    // This exact cross-tuple must remain: attempt-2 is pending/current for WORKER on TARGET.
    await insertCertificate({
      attemptId: second.attemptId,
      workerId: WORKER,
      targetId: TARGET,
      authorityKey: `organization:${ORG}`,
    });
    await insertCertificate({
      attemptId: third.attemptId,
      workerId: PLATFORM_LOGICAL_WORKER_A,
      targetId: PLATFORM_TARGET,
      authorityKey: "platform",
    });
    await admin`UPDATE job_attempts SET status = 'leased' WHERE id = ${first.attemptId}`;
    await admin`UPDATE workers SET status = 'revoked', revoked_at = clock_timestamp()
      WHERE id = ${OTHER_WORKER}`;

    const phases: string[] = [];
    const result = await runInTenant(app.db, ORG, async (repos) => {
      const cleanup = repos.jobControl.cleanupLeaseRejectionCertificates as unknown as (input: {
        limit: number;
        cardinalityLimit: number;
        beforeStatement(phase: "select" | "delete" | "cardinality"): Promise<void>;
      }) => Promise<{ deleted: number; cardinalityObserved: number; cardinalitySaturated: boolean }>;
      return cleanup({
        limit: 256,
        cardinalityLimit: 4_096,
        beforeStatement: async (phase) => { phases.push(phase); },
      });
    });
    const remaining = await admin<{ workerId: string; attemptId: string }[]>`
      SELECT worker_id AS "workerId", attempt_id AS "attemptId"
      FROM worker_lease_rejections WHERE organization_id = ${ORG}
      ORDER BY worker_id, attempt_id`;
    await admin`UPDATE workers SET status = 'enrolled', revoked_at = NULL WHERE id = ${OTHER_WORKER}`;

    expect(result).toEqual({
      deleted: 2,
      cardinalityObserved: 2,
      cardinalitySaturated: false,
    });
    expect(phases).toEqual(["select", "delete", "cardinality"]);
    expect(remaining).toEqual([
      { workerId: WORKER, attemptId: second.attemptId },
      { workerId: PLATFORM_LOGICAL_WORKER_A, attemptId: third.attemptId },
    ].sort((left, right) => `${left.workerId}:${left.attemptId}`.localeCompare(`${right.workerId}:${right.attemptId}`)));
  }, 60_000);

  it("rejects every non-finite, non-positive, fractional, or unsafe cleanup bound", async () => {
    const { app } = guard();
    const invalid = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    const cases = [
      ...invalid.map((limit) => ({ limit, cardinalityLimit: 4_096 })),
      ...invalid.map((cardinalityLimit) => ({ limit: 256, cardinalityLimit })),
    ];
    const outcomes: Array<{ error: unknown; phases: string[] }> = [];
    for (const bounds of cases) {
      const phases: string[] = [];
      let error: unknown = null;
      try {
        // Each invalid input gets a fresh transaction: PostgreSQL aborting the
        // first transaction cannot make the other eleven assertions vacuous.
        await runInTenant(app.db, ORG, async (repos) => {
          const cleanup = repos.jobControl.cleanupLeaseRejectionCertificates as unknown as (input: {
            limit: number;
            cardinalityLimit: number;
            beforeStatement(phase: "select" | "delete" | "cardinality"): Promise<void>;
          }) => Promise<unknown>;
          return cleanup({
            ...bounds,
            beforeStatement: async (phase) => { phases.push(phase); },
          });
        });
      } catch (caught) {
        error = caught;
      }
      outcomes.push({ error, phases });
    }

    expect(outcomes.map(({ error }) => (
      error instanceof Error ? error.message : null
    ))).toEqual(Array(12).fill("lease_rejection_cleanup_bound"));
    expect(outcomes.map(({ phases }) => phases)).toEqual(Array.from({ length: 12 }, () => []));
  }, 60_000);

  it("executes every cleanup trigger and retains current pending certificates regardless of age", async () => {
    const { admin, app } = guard();
    const outcomes: Array<{ trigger: string; remaining: number }> = [];
    let ordinal = 7_050;
    const exercise = async (
      trigger: string,
      mutate: (seeded: { jobId: string; attemptId: string; workerId: string }) => Promise<void>,
      expectedRemaining = 0,
    ): Promise<void> => {
      await admin`DELETE FROM worker_lease_rejections`;
      await resetRuntimeRows();
      const seeded = await seedLeaseRejectionCertificate({
        ordinal: ordinal++,
        updatedAt: new Date("2000-01-01T00:00:00.000Z"),
      });
      await mutate(seeded);
      await runInTenant(app.db, ORG, async (repos) => {
        const cleanup = repos.jobControl.cleanupLeaseRejectionCertificates as unknown as (input: {
          limit: number;
          cardinalityLimit: number;
          beforeStatement(phase: "select" | "delete" | "cardinality"): Promise<void>;
        }) => Promise<unknown>;
        return cleanup({
          limit: 256,
          cardinalityLimit: 4_096,
          beforeStatement: async () => {},
        });
      });
      const [row] = await admin<{ count: number }[]>`
        SELECT count(*)::int AS count FROM worker_lease_rejections
        WHERE organization_id = ${ORG}`;
      outcomes.push({ trigger, remaining: Number(row?.count ?? -1) });
      expect.soft(row?.count, trigger).toBe(expectedRemaining);
    };

    await exercise("terminal job", async ({ jobId }) => {
      await admin`UPDATE jobs SET status = 'failed' WHERE id = ${jobId}`;
    });
    await exercise("non-pending attempt", async ({ attemptId }) => {
      await admin`UPDATE job_attempts SET status = 'leased' WHERE id = ${attemptId}`;
    });
    await exercise("revoked worker", async ({ workerId }) => {
      await admin`UPDATE workers SET status = 'revoked', revoked_at = clock_timestamp() WHERE id = ${workerId}`;
    });
    for (const status of ["offline", "disabled"] as const) {
      await exercise(`${status} target`, async () => {
        await admin`UPDATE execution_targets SET status = ${status} WHERE id = ${TARGET}`;
      });
    }
    const attemptDrifts = [
      ["workload type", "UPDATE worker_lease_rejections SET workload_type = 'service'"],
      ["placement owner", "UPDATE worker_lease_rejections SET placement_owner = 'managed_cloud'"],
      ["placement class", "UPDATE worker_lease_rejections SET placement_target_class = 'managed_cloud'"],
      ["placement scope", "UPDATE worker_lease_rejections SET placement_target_scope = 'platform'"],
      ["stored placement generation", "UPDATE worker_lease_rejections SET placement_target_generation = 2"],
      ["stored placement profile", `UPDATE worker_lease_rejections SET placement_profile_hash = '${"a".repeat(64)}'`],
      ["stored placement provider", `UPDATE worker_lease_rejections SET placement_provider_constraint_hash = '${"b".repeat(64)}'`],
      ["stored placement input digest", `UPDATE worker_lease_rejections SET placement_input_digest = '${"c".repeat(64)}'`],
      ["stored placement policy digest", `UPDATE worker_lease_rejections SET placement_policy_digest = '${"d".repeat(64)}'`],
    ] as const;
    for (const [trigger, statement] of attemptDrifts) {
      await exercise(trigger, async () => { await admin.unsafe(statement); });
    }
    await exercise("mismatched target id", async () => {
      await admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = 'replica'`;
        await tx`UPDATE worker_lease_rejections SET target_id = ${OTHER_TARGET}`;
      });
    });
    await exercise("mismatched target authority", async () => {
      await admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = 'replica'`;
        await tx`UPDATE worker_lease_rejections SET target_authority_key = 'platform'`;
      });
    });
    await exercise("missing attempt parent", async ({ attemptId }) => {
      await admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = 'replica'`;
        await tx`DELETE FROM job_attempts WHERE id = ${attemptId}`;
      });
    });
    await exercise("missing job parent", async ({ jobId }) => {
      await admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = 'replica'`;
        await tx`DELETE FROM jobs WHERE id = ${jobId}`;
      });
    });
    await exercise("target generation drift", async () => {
      await admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET}`;
    });
    await exercise("target profile drift", async () => {
      await admin`UPDATE execution_targets SET registered_profile_hash = ${"e".repeat(64)} WHERE id = ${TARGET}`;
    });
    await exercise("target provider drift", async () => {
      await admin`UPDATE execution_targets
        SET provider_constraint_profile = jsonb_set(provider_constraint_profile, '{digest}', ${JSON.stringify("f".repeat(64))}::jsonb)
        WHERE id = ${TARGET}`;
    });
    await exercise("current pending certificate has no TTL", async () => {}, 1);

    expect(outcomes.map(({ trigger }) => trigger)).toEqual([
      "terminal job", "non-pending attempt", "revoked worker", "offline target", "disabled target",
      "workload type", "placement owner", "placement class", "placement scope",
      "stored placement generation", "stored placement profile", "stored placement provider",
      "stored placement input digest", "stored placement policy digest", "mismatched target id",
      "mismatched target authority", "missing attempt parent", "missing job parent",
      "target generation drift", "target profile drift", "target provider drift",
      "current pending certificate has no TTL",
    ]);
  }, 120_000);

  it("deletes exactly the first 256 obsolete tuples, leaves tuple 257, and reports bounded cardinality", async () => {
    // Mutation caught: a literal/unbounded limit, clamped DELETE count, or cardinality query
    // outside the tenant transaction makes this exact 256/257 boundary disagree.
    const { admin, app } = guard();
    await resetRuntimeRows();
    const targetRows = await admin<{
      id: string;
      authorityKey: string;
      profileHash: string;
      providerHash: string;
      scope: string;
    }[]>`SELECT id, target_authority_key AS "authorityKey",
        registered_profile_hash AS "profileHash",
        provider_constraint_profile->>'digest' AS "providerHash", scope
      FROM execution_targets
      WHERE id IN (${TARGET}, ${OTHER_TARGET}, ${PLATFORM_TARGET})`;
    const targetById = new Map(targetRows.map((row) => [row.id, row]));
    const placements = [
      { workerId: WORKER, targetId: TARGET },
      { workerId: OTHER_WORKER, targetId: OTHER_TARGET },
      { workerId: PLATFORM_LOGICAL_WORKER_A, targetId: PLATFORM_TARGET },
    ];
    const attemptIds: string[] = [];

    for (let index = 0; index < 257; index += 1) {
      const placement = placements[index % placements.length]!;
      const target = targetById.get(placement.targetId)!;
      const seeded = await seedPlacedJob({
        ordinal: 7_100 + index,
        outbox: false,
        workerId: placement.workerId,
        placement: {
          targetId: placement.targetId,
          owner: target.scope === "platform" ? "managed_cloud" : "organization_dedicated",
          targetClass: target.scope === "platform" ? "managed_cloud" : "organization_dedicated",
          targetScope: target.scope,
          profileHash: target.profileHash,
          providerHash: target.providerHash,
        },
      });
      attemptIds.push(seeded.attemptId);
      const orderedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index));
      await admin`INSERT INTO worker_lease_rejections
        (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
         target_authority_key, eligibility_version, static_context_hash, workload_type,
         placement_owner, placement_target_class, placement_target_scope,
         placement_target_generation, placement_profile_hash,
         placement_provider_constraint_hash, placement_input_digest,
         placement_policy_digest, reason_code, created_at, updated_at)
        SELECT attempt.organization_id, attempt.company_id, attempt.job_id, attempt.id,
          ${placement.workerId}, ${placement.targetId}, ${target.authorityKey}, 1, ${"8".repeat(64)},
          job.workload_type, attempt.placement_owner, attempt.placement_target_class,
          attempt.placement_target_scope, attempt.placement_target_generation,
          attempt.placement_profile_hash, attempt.placement_provider_constraint_hash,
          attempt.placement_input_digest, attempt.placement_policy_digest,
          'static_requirements_mismatch', ${orderedAt}, ${orderedAt}
        FROM job_attempts attempt JOIN jobs job ON job.id = attempt.job_id
        WHERE attempt.id = ${seeded.attemptId}`;
    }
    await admin`UPDATE job_attempts SET status = 'leased'
      WHERE id = ANY(${attemptIds}::uuid[])`;

    const phases: string[] = [];
    const result = await runInTenant(app.db, ORG, async (repos) => {
      const cleanup = repos.jobControl.cleanupLeaseRejectionCertificates as unknown as (input: {
        limit: number;
        cardinalityLimit: number;
        beforeStatement(phase: "select" | "delete" | "cardinality"): Promise<void>;
      }) => Promise<{ deleted: number; cardinalityObserved: number; cardinalitySaturated: boolean }>;
      return cleanup({
        limit: 256,
        cardinalityLimit: 4_096,
        beforeStatement: async (phase) => { phases.push(phase); },
      });
    });
    const remaining = await admin<{ attemptId: string }[]>`
      SELECT attempt_id AS "attemptId" FROM worker_lease_rejections
      WHERE organization_id = ${ORG} ORDER BY updated_at, worker_id, attempt_id`;

    expect(remaining).toEqual([{ attemptId: attemptIds[256] }]);
    expect(result).toEqual({
      deleted: 256,
      cardinalityObserved: 1,
      cardinalitySaturated: false,
    });
    expect(phases).toEqual(["select", "delete", "cardinality"]);
  }, 120_000);

  it("rolls back a real PostgreSQL delete when instrumentation injects a 257-row RETURNING result", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    await seedBulkLeaseRejectionCertificates(256, true);
    let actualDeleted = -1;
    let injectedReturned = -1;
    let failure: unknown;
    try {
      await runInTenant(app.db, ORG, async (_repos, tx) => {
        const instrumented = new Proxy(tx, {
          get(target, property, receiver) {
            if (property !== "delete") return Reflect.get(target, property, receiver);
            return (...args: unknown[]) => {
              const builder = (target.delete as (...input: unknown[]) => object)(...args);
              let proxy: object;
              proxy = new Proxy(builder, {
                get(queryTarget, queryProperty, queryReceiver) {
                  if (queryProperty === "returning") {
                    return async (...returningArgs: unknown[]) => {
                      const rows = await (Reflect.get(queryTarget, queryProperty, queryReceiver) as
                        (...input: unknown[]) => Promise<unknown[]>).apply(queryTarget, returningArgs);
                      actualDeleted = rows.length;
                      const injected = rows.length === 256 ? [...rows, rows[0]] : rows;
                      injectedReturned = injected.length;
                      return injected;
                    };
                  }
                  const value = Reflect.get(queryTarget, queryProperty, queryReceiver);
                  if (typeof value !== "function") return value;
                  return (...methodArgs: unknown[]) => {
                    const result = value.apply(queryTarget, methodArgs);
                    return result === queryTarget ? proxy : result;
                  };
                },
              });
              return proxy;
            };
          },
        }) as Db;
        const cleanup = createJobControlRepository(instrumented)
          .cleanupLeaseRejectionCertificates as unknown as (input: {
            limit: number;
            cardinalityLimit: number;
            beforeStatement(phase: "select" | "delete" | "cardinality"): Promise<void>;
          }) => Promise<unknown>;
        return cleanup({
          limit: 256,
          cardinalityLimit: 4_096,
          beforeStatement: async () => {},
        });
      });
    } catch (error) {
      failure = error;
    }
    const [external] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_lease_rejections WHERE organization_id = ${ORG}`;

    expect({ actualDeleted, injectedReturned }).toEqual({ actualDeleted: 256, injectedReturned: 257 });
    expect(failure).toMatchObject({ message: "lease_rejection_cleanup_bound" });
    expect(external?.count).toBe(256);
  }, 120_000);

  it("bounds a real 4097-row tenant cardinality probe without deleting current certificates", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    await seedBulkLeaseRejectionCertificates(4_097, false);
    const [before] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_lease_rejections WHERE organization_id = ${ORG}`;
    const phases: string[] = [];
    const result = await runInTenant(app.db, ORG, async (repos) => {
      const cleanup = repos.jobControl.cleanupLeaseRejectionCertificates as unknown as (input: {
        limit: number;
        cardinalityLimit: number;
        beforeStatement(phase: "select" | "delete" | "cardinality"): Promise<void>;
      }) => Promise<unknown>;
      return cleanup({
        limit: 256,
        cardinalityLimit: 4_096,
        beforeStatement: async (phase) => { phases.push(phase); },
      });
    });
    const [after] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_lease_rejections WHERE organization_id = ${ORG}`;

    expect(before?.count).toBe(4_097);
    expect(result).toEqual({
      deleted: 0,
      cardinalityObserved: 4_096,
      cardinalitySaturated: true,
    });
    expect(phases).toEqual(["select", "cardinality"]);
    expect(after?.count).toBe(4_097);
  }, 120_000);

  it("partitions overlapping cleaners with SKIP LOCKED instead of double-deleting or stranding tuples", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    for (let index = 0; index < 6; index += 1) {
      const workerId = index % 2 === 0 ? WORKER : OTHER_WORKER;
      const targetId = index % 2 === 0 ? TARGET : OTHER_TARGET;
      const seeded = await seedLeaseRejectionCertificate({
        ordinal: 7_400 + index,
        workerId,
        targetId,
        authorityKey: `organization:${ORG}`,
        placement: { targetId },
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      });
      await admin`UPDATE job_attempts SET status = 'leased' WHERE id = ${seeded.attemptId}`;
    }
    let firstHoldsSelectedLocks!: () => void;
    const selectedLocksHeld = new Promise<void>((resolve) => { firstHoldsSelectedLocks = resolve; });
    let releaseFirst!: () => void;
    const firstMayDelete = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runCleaner = (holdAfterSelect: boolean) => runInTenant(app.db, ORG, async (repos) => {
      const cleanup = repos.jobControl.cleanupLeaseRejectionCertificates as unknown as (input: {
        limit: number;
        cardinalityLimit: number;
        beforeStatement(phase: "select" | "delete" | "cardinality"): Promise<void>;
      }) => Promise<{ deleted: number; cardinalityObserved: number; cardinalitySaturated: boolean }>;
      return cleanup({
        limit: 3,
        cardinalityLimit: 4_096,
        beforeStatement: async (phase) => {
          if (!holdAfterSelect || phase !== "delete") return;
          firstHoldsSelectedLocks();
          await firstMayDelete;
        },
      });
    });
    const first = runCleaner(true);
    const firstOutcome = first.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    );
    const firstBoundary = await Promise.race([
      selectedLocksHeld.then(() => "selected-locks-held" as const),
      firstOutcome.then((outcome) => ({ completed: outcome } as const)),
      new Promise<"select-boundary-timeout">((resolve) =>
        setTimeout(() => resolve("select-boundary-timeout"), 2_000)),
    ]);
    if (firstBoundary !== "selected-locks-held") {
      releaseFirst();
      await firstOutcome;
      expect(firstBoundary).toBe("selected-locks-held");
      return;
    }
    const second = runCleaner(false);
    const secondBeforeRelease = await Promise.race([
      second.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 750)),
    ]);
    releaseFirst();
    const settled = await Promise.allSettled([first, second]);
    const [remaining] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_lease_rejections WHERE organization_id = ${ORG}`;

    expect.soft(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect.soft(settled.map((result) => result.status === "fulfilled" ? result.value.deleted : -1).sort())
      .toEqual([3, 3]);
    expect.soft(secondBeforeRelease).toMatchObject({ settled: true, value: { deleted: 3 } });
    expect.soft(remaining?.count).toBe(0);
  }, 60_000);

  it("retains a current certificate when cleanup overlaps the public poll claim and certificate upsert", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const authority = await configureMixedWorkloadAuthority();
    const seeded = await seedPlacedJob({
      ordinal: 7_500,
      workloadType: "batch",
      requiredCapabilities: ["sandbox.filtered_egress"],
      placement: { profileHash: authority.targetProfileHash, providerHash: authority.providerHash },
    });
    let atSelect!: () => void;
    const selectReached = new Promise<void>((resolve) => { atSelect = resolve; });
    let releaseSelect!: () => void;
    const selectMayRun = new Promise<void>((resolve) => { releaseSelect = resolve; });
    const cleanup = runInTenant(app.db, ORG, async (repos) => {
      const method = repos.jobControl.cleanupLeaseRejectionCertificates as unknown as (input: {
        limit: number;
        cardinalityLimit: number;
        beforeStatement(phase: "select" | "delete" | "cardinality"): Promise<void>;
      }) => Promise<unknown>;
      return method({
        limit: 256,
        cardinalityLimit: 4_096,
        beforeStatement: async (phase) => {
          if (phase !== "select") return;
          atSelect();
          await selectMayRun;
        },
      });
    });
    const selectBoundary = await Promise.race([
      selectReached.then(() => "reached" as const),
      cleanup.then(() => "cleanup-completed-before-select-gate" as const),
    ]);
    const service = createJobLeasingService({ appDb: app.db });
    const poll = await service.poll({
      auth: auth("cleanup-upsert-race", WORKER, TARGET, authority.workerProfileHash),
      request: pollRequestWithCapacity(WORKER, TARGET, "cleanup-upsert-race", {
        batchSlots: 1,
        browserSessionSlots: 1,
        serviceSlots: 0,
        freeCpuMillis: 2_000,
        freeMemoryMiB: 4_096,
        freeDiskMiB: 8_192,
      }),
    });
    releaseSelect();
    await cleanup;
    const [state] = await admin<{ certificates: number; attemptStatus: string }[]>`
      SELECT
        (SELECT count(*)::int FROM worker_lease_rejections WHERE attempt_id = ${seeded.attemptId}) AS certificates,
        (SELECT status FROM job_attempts WHERE id = ${seeded.attemptId}) AS "attemptStatus"`;

    expect.soft(selectBoundary).toBe("reached");
    expect.soft(poll.outcome).toBe("no_work");
    expect.soft(state).toEqual({ certificates: 1, attemptStatus: "pending" });
  }, 60_000);

  // ★ E3-F034. This test deliberately creates the worst lock queue in the file, and it used
  // to run on the SHARED `app` pool, whose `lock_timeout` is production's 750 ms. See
  // CONTENDED_* above for why that made a correctness test assert a storage-speed property.
  it("gives exactly one of 100 concurrent claimers one opaque offer and reveals nothing to losers", async () => {
    const { admin } = guard();
    await resetRuntimeRows();
    const seeded = await seedPlacedJob({ ordinal: 1 });
    const contended = createContendedAppDb();
    try {
      await assertContendedLockBudget(contended);
      const service = createJobLeasingService({ appDb: contended.db });
      // `settleAllClaimers`, not `Promise.all`: a rejected claimer is still a failure, but it
      // is not REPORTED until all 100 have settled, so a failure here cannot leak transactions
      // into the next test's fixture. That leak is what made one flake report as two. E3-F034.
      const results = await settleAllClaimers(
        Array.from({ length: CONTENDED_CLAIMERS }, (_, index) => service.poll({
          auth: auth(`poll-race-${index}`),
          request: pollRequest(WORKER, TARGET, `poll-race-${index}`),
        })),
        `${CONTENDED_CLAIMERS}-claimer single-winner poll race`,
      );
      const offers = results.filter((result) => result.outcome === "offer");
      const noWork = results.filter((result) => result.outcome === "no_work");
      expect(offers).toHaveLength(1);
      expect(noWork).toHaveLength(CONTENDED_CLAIMERS - 1);
      expect(Object.keys(noWork[0] ?? {}).sort()).toEqual([
        "correlationId", "outcome", "protocolVersion", "retryAfterMs", "serverTime",
      ]);
      if (offers[0]?.outcome !== "offer") throw new Error("offer missing");
      expect(offers[0].body.job.jobId).toBe(seeded.jobId);
      expect(offers[0].body.fenceToken).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      const [counts] = await admin<{ leases: number; offered: number; queued: number }[]>`
        SELECT
          (SELECT count(*)::int FROM leases WHERE attempt_id = ${seeded.attemptId}) AS leases,
          (SELECT count(*)::int FROM job_attempts WHERE id = ${seeded.attemptId} AND status = 'offered') AS offered,
          (SELECT count(*)::int FROM jobs WHERE id = ${seeded.jobId} AND status = 'queued') AS queued`;
      expect(counts).toEqual({ leases: 1, offered: 1, queued: 1 });
    } finally {
      await contended.close({ timeoutSeconds: 5 });
    }
  }, 60_000);

  it("chooses the oldest compatible attempt and clamps a widening report to registered slots", async () => {
    const { app } = guard();
    await resetRuntimeRows();
    const oldest = await seedPlacedJob({ ordinal: 10, availableAt: new Date(Date.now() - 30_000) });
    const middle = await seedPlacedJob({ ordinal: 11, availableAt: new Date(Date.now() - 20_000) });
    await seedPlacedJob({ ordinal: 12, availableAt: new Date(Date.now() - 10_000) });
    const service = createJobLeasingService({ appDb: app.db });

    const incompatible = await service.poll({
      auth: auth("poll-incompatible", OTHER_WORKER, OTHER_TARGET),
      request: pollRequest(OTHER_WORKER, OTHER_TARGET, "poll-incompatible", 99),
    });
    expect(incompatible.outcome).toBe("no_work");

    const first = await service.poll({
      auth: auth("poll-oldest-1"),
      request: pollRequest(WORKER, TARGET, "poll-oldest-1", 99),
    });
    const second = await service.poll({
      auth: auth("poll-oldest-2"),
      request: pollRequest(WORKER, TARGET, "poll-oldest-2", 99),
    });
    const third = await service.poll({
      auth: auth("poll-oldest-3"),
      request: pollRequest(WORKER, TARGET, "poll-oldest-3", 99),
    });
    expect(first.outcome === "offer" ? first.body.job.jobId : null).toBe(oldest.jobId);
    expect(second.outcome === "offer" ? second.body.job.jobId : null).toBe(middle.jobId);
    expect(third.outcome).toBe("no_work");
  });

  it("preserves PostgreSQL microseconds and applies available-at, priority, created-at, then id ordering", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const availableFirst = await seedPlacedJob({ ordinal: 1100 });
    const priorityFirst = await seedPlacedJob({ ordinal: 1101 });
    const createdFirst = await seedPlacedJob({ ordinal: 1102 });
    const idFirst = await seedPlacedJob({ ordinal: 1103 });
    const idLast = await seedPlacedJob({ ordinal: 1104 });

    await admin`UPDATE jobs AS job SET
        available_at = ordering.available_at,
        priority = ordering.priority,
        created_at = ordering.created_at,
        updated_at = ordering.created_at
      FROM (VALUES
        (${availableFirst.jobId}::uuid, '2020-01-01 00:00:00.000001+00'::timestamptz,
          1, '2020-01-01 00:00:00.000009+00'::timestamptz),
        (${priorityFirst.jobId}::uuid, '2020-01-01 00:00:00.000002+00'::timestamptz,
          99, '2020-01-01 00:00:00.000009+00'::timestamptz),
        (${createdFirst.jobId}::uuid, '2020-01-01 00:00:00.000002+00'::timestamptz,
          50, '2020-01-01 00:00:00.000003+00'::timestamptz),
        (${idFirst.jobId}::uuid, '2020-01-01 00:00:00.000002+00'::timestamptz,
          50, '2020-01-01 00:00:00.000004+00'::timestamptz),
        (${idLast.jobId}::uuid, '2020-01-01 00:00:00.000002+00'::timestamptz,
          50, '2020-01-01 00:00:00.000004+00'::timestamptz)
      ) AS ordering(id, available_at, priority, created_at)
      WHERE job.id = ordering.id`;

    const seededPrecision = await admin<{
      id: string;
      availableAt: string;
      createdAt: string;
      priority: number;
    }[]>`SELECT id::text AS id,
        to_char(available_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS "availableAt",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS "createdAt",
        priority::int AS priority
      FROM jobs
      WHERE id IN (${availableFirst.jobId}, ${priorityFirst.jobId}, ${createdFirst.jobId},
        ${idFirst.jobId}, ${idLast.jobId})
      ORDER BY id`;
    expect.soft(seededPrecision).toEqual([
      {
        id: "a3100000-0000-4000-8000-000000001100",
        availableAt: "2020-01-01 00:00:00.000001",
        createdAt: "2020-01-01 00:00:00.000009",
        priority: 1,
      },
      {
        id: "a3100000-0000-4000-8000-000000001101",
        availableAt: "2020-01-01 00:00:00.000002",
        createdAt: "2020-01-01 00:00:00.000009",
        priority: 99,
      },
      {
        id: "a3100000-0000-4000-8000-000000001102",
        availableAt: "2020-01-01 00:00:00.000002",
        createdAt: "2020-01-01 00:00:00.000003",
        priority: 50,
      },
      {
        id: "a3100000-0000-4000-8000-000000001103",
        availableAt: "2020-01-01 00:00:00.000002",
        createdAt: "2020-01-01 00:00:00.000004",
        priority: 50,
      },
      {
        id: "a3100000-0000-4000-8000-000000001104",
        availableAt: "2020-01-01 00:00:00.000002",
        createdAt: "2020-01-01 00:00:00.000004",
        priority: 50,
      },
    ]);

    const service = createJobLeasingService({ appDb: app.db });
    const offeredJobIds: string[] = [];
    for (let poll = 1; poll <= 5; poll += 1) {
      const result = await service.poll({
        auth: auth(`native-microsecond-order-${poll}`),
        request: pollRequest(WORKER, TARGET, `native-microsecond-order-${poll}`),
      });
      offeredJobIds.push(result.outcome === "offer" ? result.body.job.jobId : result.outcome);
      if (result.outcome === "offer") {
        await admin`DELETE FROM leases WHERE id = ${result.body.leaseId}`;
      }
    }
    expect(offeredJobIds).toEqual([
      "a3100000-0000-4000-8000-000000001100",
      "a3100000-0000-4000-8000-000000001101",
      "a3100000-0000-4000-8000-000000001102",
      "a3100000-0000-4000-8000-000000001103",
      "a3100000-0000-4000-8000-000000001104",
    ]);
  });

  it("accounts live offers by workload class so a batch lease does not consume a browser slot", async () => {
    const { app } = guard();
    await resetRuntimeRows();
    const authority = await configureMixedWorkloadAuthority();
    const placement = { profileHash: authority.targetProfileHash, providerHash: authority.providerHash };
    await seedPlacedJob({ ordinal: 20, workloadType: "batch", placement });
    const browser = await seedPlacedJob({ ordinal: 21, workloadType: "browser_session", placement });
    const service = createJobLeasingService({ appDb: app.db });
    const mixedCapacity = {
      batchSlots: 1,
      browserSessionSlots: 1,
      serviceSlots: 0,
      freeCpuMillis: 2_000,
      freeMemoryMiB: 4_096,
      freeDiskMiB: 8_192,
    };

    const batchOffer = await service.poll({
      auth: auth("mixed-batch", WORKER, TARGET, authority.workerProfileHash),
      request: pollRequestWithCapacity(WORKER, TARGET, "mixed-batch", mixedCapacity),
    });
    expect(batchOffer.outcome).toBe("offer");
    const browserOffer = await service.poll({
      auth: auth("mixed-browser", WORKER, TARGET, authority.workerProfileHash),
      request: pollRequestWithCapacity(WORKER, TARGET, "mixed-browser", mixedCapacity),
    });
    expect(browserOffer.outcome).toBe("offer");
    if (browserOffer.outcome !== "offer") return;
    expect(browserOffer.body.job.jobId).toBe(browser.jobId);
    expect(browserOffer.body.job.workloadType).toBe("browser_session");
  });

  it("continues past zero-slot and full head candidates to later eligible work", async () => {
    const { app } = guard();
    await resetRuntimeRows();
    const authority = await configureMixedWorkloadAuthority();
    const placement = { profileHash: authority.targetProfileHash, providerHash: authority.providerHash };
    await seedPlacedJob({ ordinal: 30, workloadType: "batch", placement });
    await seedPlacedJob({ ordinal: 31, workloadType: "batch", placement });
    const browser = await seedPlacedJob({ ordinal: 32, workloadType: "browser_session", placement });
    const service = createJobLeasingService({ appDb: app.db });
    const browserOnly = {
      batchSlots: 0,
      browserSessionSlots: 1,
      serviceSlots: 0,
      freeCpuMillis: 2_000,
      freeMemoryMiB: 4_096,
      freeDiskMiB: 8_192,
    };
    const result = await service.poll({
      auth: auth("browser-no-hol", WORKER, TARGET, authority.workerProfileHash),
      request: pollRequestWithCapacity(WORKER, TARGET, "browser-no-hol", browserOnly),
    });
    expect(result.outcome).toBe("offer");
    if (result.outcome !== "offer") return;
    expect(result.body.job.jobId).toBe(browser.jobId);
  });

  it("never turns a dynamic capacity rejection into a durable static certificate", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const authority = await configureMixedWorkloadAuthority();
    const placement = { profileHash: authority.targetProfileHash, providerHash: authority.providerHash };
    const batch = await seedPlacedJob({ ordinal: 33, workloadType: "batch", placement });
    const service = createJobLeasingService({ appDb: app.db });
    const noBatchCapacity = {
      batchSlots: 0,
      browserSessionSlots: 1,
      serviceSlots: 0,
      freeCpuMillis: 2_000,
      freeMemoryMiB: 4_096,
      freeDiskMiB: 8_192,
    };
    const denied = await service.poll({
      auth: auth("dynamic-capacity-denied", WORKER, TARGET, authority.workerProfileHash),
      request: pollRequestWithCapacity(WORKER, TARGET, "dynamic-capacity-denied", noBatchCapacity),
    });
    expect.soft(denied.outcome).toBe("no_work");
    const [table] = await admin<{ name: string | null }[]>`
      SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
    expect.soft(table?.name).toBe("worker_lease_rejections");
    if (table?.name !== "worker_lease_rejections") return;
    const [certificate] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_lease_rejections
      WHERE organization_id = ${ORG} AND worker_id = ${WORKER} AND attempt_id = ${batch.attemptId}`;
    expect.soft(certificate?.count).toBe(0);

    const reenabled = await service.poll({
      auth: auth("dynamic-capacity-reenabled", WORKER, TARGET, authority.workerProfileHash),
      request: pollRequestWithCapacity(WORKER, TARGET, "dynamic-capacity-reenabled", {
        ...noBatchCapacity,
        batchSlots: 1,
      }),
    });
    expect.soft(reenabled.outcome).toBe("offer");
    expect.soft(reenabled.outcome === "offer" ? reenabled.body.job.jobId : null).toBe(batch.jobId);
  });

  it("does not certify a lifecycle-locked head and sees it immediately after rollback", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const older = await seedPlacedJob({ ordinal: 34, availableAt: new Date(Date.now() - 120_000) });
    const newer = await seedPlacedJob({ ordinal: 35, availableAt: new Date(Date.now() - 60_000) });
    let release!: () => void;
    let locked!: () => void;
    const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
    const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
    const blocker = admin.begin(async (tx) => {
      await tx`SELECT id FROM job_attempts WHERE id = ${older.attemptId} FOR UPDATE`;
      locked();
      await releaseSignal;
      throw new Error("rollback lifecycle lock");
    }).catch((error) => {
      expect(String(error)).toContain("rollback lifecycle lock");
    });
    await lockedSignal;
    const service = createJobLeasingService({ appDb: app.db });
    const whileLocked = await service.poll({
      auth: auth("lifecycle-locked"),
      request: pollRequest(WORKER, TARGET, "lifecycle-locked"),
    });
    expect.soft(whileLocked.outcome).toBe("offer");
    expect.soft(whileLocked.outcome === "offer" ? whileLocked.body.job.jobId : null).toBe(newer.jobId);
    release();
    await blocker;

    const afterRollback = await service.poll({
      auth: auth("lifecycle-unlocked"),
      request: pollRequest(WORKER, TARGET, "lifecycle-unlocked"),
    });
    expect.soft(afterRollback.outcome).toBe("offer");
    expect.soft(afterRollback.outcome === "offer" ? afterRollback.body.job.jobId : null).toBe(older.jobId);
  });

  it("persists exact static-negative certificates so restart reaches compatible work after 256 heads", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const authority = await configureMixedWorkloadAuthority();
    const placement = { profileHash: authority.targetProfileHash, providerHash: authority.providerHash };
    const baseTime = Date.now() - 10 * 60_000;
    for (let start = 0; start < 256; start += 32) {
      await Promise.all(Array.from({ length: 32 }, (_, offset) => {
        const index = start + offset;
        return seedPlacedJob({
          ordinal: 700 + index,
          workloadType: "batch",
          requiredCapabilities: ["sandbox.filtered_egress"],
          availableAt: new Date(baseTime + index),
          placement,
        });
      }));
    }
    const browser = await seedPlacedJob({
      ordinal: 956,
      workloadType: "browser_session",
      availableAt: new Date(baseTime + 256),
      placement,
    });
    // Model a delivered hint lost on process restart. Tenant-local pull remains
    // the only authority and must eventually reach the compatible 257th row.
    await admin`UPDATE job_outbox SET status = 'delivered', updated_at = clock_timestamp()`;
    const compatibleCapacity = {
      batchSlots: 1,
      browserSessionSlots: 1,
      serviceSlots: 0,
      freeCpuMillis: 2_000,
      freeMemoryMiB: 4_096,
      freeDiskMiB: 8_192,
    };

    const firstProcess = createJobLeasingService({ appDb: app.db });
    const bounded = await firstProcess.poll({
      auth: auth("restart-safe-window-1", WORKER, TARGET, authority.workerProfileHash),
      request: pollRequestWithCapacity(WORKER, TARGET, "restart-safe-window-1", compatibleCapacity),
    });
    expect.soft(bounded.outcome).toBe("no_work");
    const [certificateTable] = await admin<{ name: string | null }[]>`
      SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
    expect.soft(certificateTable?.name).toBe("worker_lease_rejections");
    if (certificateTable?.name === "worker_lease_rejections") {
      const [certificateCount] = await admin<{ count: number }[]>`
        SELECT count(*)::int AS count FROM worker_lease_rejections
        WHERE organization_id = ${ORG} AND worker_id = ${WORKER}`;
      expect.soft(certificateCount?.count).toBe(256);
    }

    const restartedA = createJobLeasingService({ appDb: app.db });
    const restartedB = createJobLeasingService({ appDb: app.db });
    const concurrent = await Promise.all([
      restartedA.poll({
        auth: auth("restart-safe-window-2a", WORKER, TARGET, authority.workerProfileHash),
        request: pollRequestWithCapacity(WORKER, TARGET, "restart-safe-window-2a", compatibleCapacity),
      }),
      restartedB.poll({
        auth: auth("restart-safe-window-2b", WORKER, TARGET, authority.workerProfileHash),
        request: pollRequestWithCapacity(WORKER, TARGET, "restart-safe-window-2b", compatibleCapacity),
      }),
    ]);
    const offers = concurrent.filter((result) => result.outcome === "offer");
    expect.soft(offers).toHaveLength(1);
    expect.soft(offers[0]?.outcome === "offer" ? offers[0].body.job.jobId : null).toBe(browser.jobId);

    // A newly inserted older row is never hidden by continuation state: every
    // authoritative selection restarts at the database-native global head.
    const newlyOlder = await seedPlacedJob({
      ordinal: 957,
      workloadType: "batch",
      availableAt: new Date(baseTime - 60_000),
      placement,
      outbox: false,
    });
    const batchOnly = { ...compatibleCapacity, browserSessionSlots: 0 };
    const churnFirst = await createJobLeasingService({ appDb: app.db }).poll({
      auth: auth("restart-safe-churn-1", WORKER, TARGET, authority.workerProfileHash),
      request: pollRequestWithCapacity(WORKER, TARGET, "restart-safe-churn-1", batchOnly),
    });
    expect.soft(churnFirst.outcome).toBe("offer");
    expect.soft(churnFirst.outcome === "offer" ? churnFirst.body.job.jobId : null).toBe(newlyOlder.jobId);
  }, 180_000);

  it("emits only SQL-returned certificate facts and one metric per real public-poll mutation or restart", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const authority = await configureMixedWorkloadAuthority();
    const placement = { profileHash: authority.targetProfileHash, providerHash: authority.providerHash };
    await seedPlacedJob({
      ordinal: 958,
      workloadType: "batch",
      requiredCapabilities: ["sandbox.filtered_egress"],
      placement,
    });
    const metrics = {
      certificateScan: vi.fn(), certificateUpsert: vi.fn(), certificateCleanup: vi.fn(),
      headRestart: vi.fn(), schedulerCapacityReject: vi.fn(), schedulerExpiry: vi.fn(),
      schedulerCardinality: vi.fn(), outboxTick: vi.fn(),
    };
    const incompatibleCapacity = {
      batchSlots: 1, browserSessionSlots: 0, serviceSlots: 0,
      freeCpuMillis: 2_000, freeMemoryMiB: 4_096, freeDiskMiB: 8_192,
    };
    const first = createJobLeasingService({ appDb: app.db, metrics } as unknown as
      Parameters<typeof createJobLeasingService>[0]);
    expect.soft((await first.poll({
      auth: auth("metrics-miss", WORKER, TARGET, authority.workerProfileHash),
      request: pollRequestWithCapacity(WORKER, TARGET, "metrics-miss", incompatibleCapacity),
    })).outcome).toBe("no_work");
    const restarted = createJobLeasingService({ appDb: app.db, metrics } as unknown as
      Parameters<typeof createJobLeasingService>[0]);
    expect.soft((await restarted.poll({
      auth: auth("metrics-hit", WORKER, TARGET, authority.workerProfileHash),
      request: pollRequestWithCapacity(WORKER, TARGET, "metrics-hit", incompatibleCapacity),
    })).outcome).toBe("no_work");
    expect.soft(metrics.certificateScan.mock.calls).toEqual([
      [{ hitsObserved: 0, hitsSaturated: false, missesObserved: 1, missesSaturated: false,
        scanExhausted: false, cardinalityObserved: 0, cardinalitySaturated: false }],
      [{ hitsObserved: 1, hitsSaturated: false, missesObserved: 0, missesSaturated: false,
        scanExhausted: false, cardinalityObserved: 1, cardinalitySaturated: false }],
    ]);
    expect.soft(metrics.certificateUpsert.mock.calls).toEqual([[{ count: 1 }]]);
    expect.soft(metrics.headRestart).not.toHaveBeenCalled();

    await resetRuntimeRows();
    const restartAuthority = await configureMixedWorkloadAuthority();
    const offerable = await seedPlacedJob({ ordinal: 959, placement });
    const sequenceName = `job003_metric_restart_${process.pid}`;
    const functionName = `job003_metric_restart_fn_${process.pid}`;
    const triggerName = `job003_metric_restart_trg_${process.pid}`;
    await admin.unsafe(`CREATE SEQUENCE ${sequenceName}`);
    await admin.unsafe(`GRANT USAGE, SELECT ON SEQUENCE ${sequenceName} TO aoa_app`);
    await admin.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${offerable.attemptId}'::uuid AND NEW.status = 'offered'
           AND nextval('${sequenceName}') = 1 THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END $$`);
    await admin.unsafe(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON job_attempts
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      const offered = await createJobLeasingService({ appDb: app.db, metrics } as unknown as
        Parameters<typeof createJobLeasingService>[0]).poll({
        auth: auth("metrics-real-restart", WORKER, TARGET, restartAuthority.workerProfileHash),
        request: pollRequest(WORKER, TARGET, "metrics-real-restart"),
      });
      expect.soft(offered.outcome).toBe("offer");
      expect.soft(metrics.headRestart.mock.calls).toEqual([[]]);
      const [state] = await admin<{ attempts: number; leases: number }[]>`SELECT
        (SELECT count(*)::int FROM job_attempts WHERE id = ${offerable.attemptId} AND status = 'offered') AS attempts,
        (SELECT count(*)::int FROM leases WHERE attempt_id = ${offerable.attemptId}) AS leases`;
      expect.soft(state).toEqual({ attempts: 1, leases: 1 });
    } finally {
      await admin.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON job_attempts`);
      await admin.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await admin.unsafe(`DROP SEQUENCE IF EXISTS ${sequenceName}`);
    }
  }, 60_000);

  it("ignores stale certificate version, context, and candidate facts at the database-native global head", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const [certificateTable] = await admin<{ name: string | null }[]>`
      SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
    expect.soft(certificateTable?.name).toBe("worker_lease_rejections");
    if (certificateTable?.name !== "worker_lease_rejections") return;
    const eligibilityUrl = new URL("../services/job-lease-eligibility.ts", import.meta.url);
    expect.soft(existsSync(eligibilityUrl), "static eligibility implementation must exist").toBe(true);
    if (!existsSync(eligibilityUrl)) return;
    const eligibilitySpecifier = `../services/${"job-lease-eligibility"}.js`;
    const eligibility = await import(eligibilitySpecifier) as {
      logicalWorkerStaticMatcherProfileHash(hello: Record<string, unknown>): string;
      leaseStaticContextHash(input: Record<string, unknown>): string;
    };
    const provider = providerProfile();
    const profile = registeredProfile(provider);
    const hello = workerHello();
    const staticContextHash = eligibility.leaseStaticContextHash({
      organizationId: ORG,
      logicalWorkerId: WORKER,
      logicalWorkerScope: "organization",
      logicalWorkerOwnerUserId: null,
      logicalWorkerTargetAuthorityKey: `organization:${ORG}`,
      logicalWorkerDeviceGeneration: 1,
      logicalWorkerDeviceThumbprint: THUMBPRINT,
      logicalWorkerProfileHash: sha256(JSON.stringify(hello)),
      logicalWorkerStaticMatcherProfileHash: eligibility.logicalWorkerStaticMatcherProfileHash(hello),
      physicalAuthorityWorkerId: null,
      physicalAuthorityWorkerDeviceGeneration: null,
      physicalAuthorityWorkerProfileHash: null,
      targetId: TARGET,
      targetScope: "organization",
      targetOwnerUserId: null,
      targetAuthorityKey: `organization:${ORG}`,
      targetDeviceGeneration: 1,
      targetRegisteredProfileHash: sha256(canonicalizeJsonV1(profile)),
      targetProviderConstraintHash: provider.digest,
    });

    const currentCertificateFacts = {
      eligibilityVersion: 1,
      staticContextHash,
      workloadType: "batch",
      placementOwner: "organization_dedicated",
      placementTargetClass: "organization_dedicated",
      placementTargetScope: "organization",
      placementTargetGeneration: 1,
      placementProfileHash: sha256(canonicalizeJsonV1(profile)),
      placementProviderConstraintHash: provider.digest,
      placementInputDigest: "6".repeat(64),
      placementPolicyDigest: "6".repeat(64),
    };

    // Every ordinary correlation in the certificate anti-join also gets a
    // runtime proof. Composite FKs make some alternate identities travel as a
    // valid tuple; the assertions below name the intended changed component
    // and keep every inserted certificate FK-valid.
    await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
      VALUES (${ALT_COMPANY}, ${ORG}, 'JOB-003 alternate company', 'J03X')
      ON CONFLICT (id) DO NOTHING`;
    type CertificateIdentity = {
      organizationId: string;
      companyId: string;
      jobId: string;
      attemptId: string;
      workerId: string;
      targetId: string;
      targetAuthorityKey: string;
    };
    const insertCertificate = async (identity: CertificateIdentity): Promise<void> => {
      await admin`INSERT INTO worker_lease_rejections
        (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
         target_authority_key, eligibility_version, static_context_hash, workload_type,
         placement_owner, placement_target_class, placement_target_scope,
         placement_target_generation, placement_profile_hash,
         placement_provider_constraint_hash, placement_input_digest, placement_policy_digest,
         reason_code)
        VALUES (${identity.organizationId}, ${identity.companyId}, ${identity.jobId}, ${identity.attemptId},
          ${identity.workerId}, ${identity.targetId}, ${identity.targetAuthorityKey},
          ${currentCertificateFacts.eligibilityVersion}, ${currentCertificateFacts.staticContextHash},
          ${currentCertificateFacts.workloadType}, ${currentCertificateFacts.placementOwner},
          ${currentCertificateFacts.placementTargetClass}, ${currentCertificateFacts.placementTargetScope},
          ${currentCertificateFacts.placementTargetGeneration}, ${currentCertificateFacts.placementProfileHash},
          ${currentCertificateFacts.placementProviderConstraintHash},
          ${currentCertificateFacts.placementInputDigest}, ${currentCertificateFacts.placementPolicyDigest},
          'static_requirements_mismatch')`;
    };
    const identityCases = [
      "organizationId",
      "companyId",
      "jobId",
      "attemptId",
      "workerId",
      "targetId",
      "targetAuthorityKey",
    ] as const;
    for (const [index, changedIdentity] of identityCases.entries()) {
      await resetRuntimeRows();
      const current = await seedPlacedJob({ ordinal: 930 + index });
      const currentIdentity: CertificateIdentity = {
        organizationId: ORG,
        companyId: COMPANY,
        jobId: current.jobId,
        attemptId: current.attemptId,
        workerId: WORKER,
        targetId: TARGET,
        targetAuthorityKey: `organization:${ORG}`,
      };
      let alternate: CertificateIdentity;
      if (changedIdentity === "organizationId") {
        const providerB = platformProviderProfile();
        const profileB = platformRegisteredProfile(providerB);
        const otherOrg = await seedPlacedJob({
          ordinal: 940 + index,
          organizationId: ORG_B,
          companyId: COMPANY_B,
          workerId: PLATFORM_LOGICAL_WORKER_B,
          placement: {
            targetId: PLATFORM_TARGET,
            owner: "managed_cloud",
            targetClass: "managed_cloud",
            targetScope: "platform",
            profileHash: sha256(canonicalizeJsonV1(profileB)),
            providerHash: providerB.digest,
          },
          outbox: false,
        });
        alternate = {
          organizationId: ORG_B,
          companyId: COMPANY_B,
          jobId: otherOrg.jobId,
          attemptId: otherOrg.attemptId,
          workerId: PLATFORM_LOGICAL_WORKER_B,
          targetId: PLATFORM_TARGET,
          targetAuthorityKey: "platform",
        };
      } else if (changedIdentity === "companyId") {
        const otherCompany = await seedPlacedJob({
          ordinal: 940 + index,
          companyId: ALT_COMPANY,
          outbox: false,
        });
        alternate = { ...currentIdentity, companyId: ALT_COMPANY,
          jobId: otherCompany.jobId, attemptId: otherCompany.attemptId };
      } else if (changedIdentity === "jobId") {
        const otherJob = await seedPlacedJob({ ordinal: 940 + index, outbox: false });
        alternate = { ...currentIdentity, jobId: otherJob.jobId, attemptId: otherJob.attemptId };
      } else if (changedIdentity === "attemptId") {
        const alternateAttemptId = `a3210000-0000-4000-8000-${(940 + index).toString().padStart(12, "0")}`;
        await admin`INSERT INTO job_attempts
          (id, organization_id, company_id, job_id, attempt_number, status,
           placement_disposition, placement_owner, placement_target_id, placement_target_class,
           placement_target_scope, placement_target_generation, placement_profile_hash,
           placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
           placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
           placement_decided_at, created_at, updated_at)
          SELECT ${alternateAttemptId}, organization_id, company_id, job_id, 2, 'failed',
            placement_disposition, placement_owner, placement_target_id, placement_target_class,
            placement_target_scope, placement_target_generation, placement_profile_hash,
            placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
            placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
            placement_decided_at, created_at, updated_at
          FROM job_attempts WHERE id = ${current.attemptId}`;
        alternate = { ...currentIdentity, attemptId: alternateAttemptId };
      } else if (changedIdentity === "targetAuthorityKey") {
        alternate = { ...currentIdentity,
          workerId: PLATFORM_LOGICAL_WORKER_A,
          targetId: PLATFORM_TARGET,
          targetAuthorityKey: "platform" };
      } else {
        alternate = { ...currentIdentity,
          workerId: OTHER_WORKER,
          targetId: OTHER_TARGET,
          targetAuthorityKey: `organization:${ORG}` };
      }
      expect.soft(alternate[changedIdentity], `${changedIdentity} fixture must actually differ`)
        .not.toBe(currentIdentity[changedIdentity]);
      await insertCertificate(alternate);
      const result = await createJobLeasingService({ appDb: app.db }).poll({
        auth: auth(`certificate-identity-${changedIdentity}`),
        request: pollRequest(WORKER, TARGET, `certificate-identity-${changedIdentity}`),
      });
      expect.soft(result.outcome, changedIdentity).toBe("offer");
      expect.soft(result.outcome === "offer" ? result.body.job.jobId : null, changedIdentity)
        .toBe(current.jobId);
    }

    const cases = [
      { name: "eligibility-version", changed: { eligibilityVersion: 999 } },
      { name: "static-context", changed: { staticContextHash: "7".repeat(64) } },
      { name: "workload-type", changed: { workloadType: "browser_session" } },
      { name: "placement-owner", changed: { placementOwner: "managed_cloud" } },
      { name: "placement-target-class", changed: { placementTargetClass: "managed_cloud" } },
      { name: "placement-target-scope", changed: { placementTargetScope: "platform" } },
      { name: "placement-target-generation", changed: { placementTargetGeneration: 999 } },
      { name: "placement-profile-hash", changed: { placementProfileHash: "8".repeat(64) } },
      { name: "placement-provider-hash", changed: { placementProviderConstraintHash: "9".repeat(64) } },
      { name: "placement-input-digest", changed: { placementInputDigest: "a".repeat(64) } },
      { name: "placement-policy-digest", changed: { placementPolicyDigest: "b".repeat(64) } },
    ] as const;
    for (const [index, mismatch] of cases.entries()) {
      await resetRuntimeRows();
      const seeded = await seedPlacedJob({ ordinal: 970 + index });
      const certificate = { ...currentCertificateFacts, ...mismatch.changed };
      await admin`INSERT INTO worker_lease_rejections
        (organization_id, company_id, job_id, attempt_id, worker_id, target_id,
         target_authority_key, eligibility_version, static_context_hash, workload_type,
         placement_owner, placement_target_class, placement_target_scope,
         placement_target_generation, placement_profile_hash,
         placement_provider_constraint_hash, placement_input_digest, placement_policy_digest,
         reason_code)
        VALUES (${ORG}, ${COMPANY}, ${seeded.jobId}, ${seeded.attemptId}, ${WORKER}, ${TARGET},
          ${`organization:${ORG}`}, ${certificate.eligibilityVersion}, ${certificate.staticContextHash},
          ${certificate.workloadType}, ${certificate.placementOwner}, ${certificate.placementTargetClass},
          ${certificate.placementTargetScope}, ${certificate.placementTargetGeneration},
          ${certificate.placementProfileHash}, ${certificate.placementProviderConstraintHash},
          ${certificate.placementInputDigest}, ${certificate.placementPolicyDigest},
          'static_requirements_mismatch')`;
      const result = await createJobLeasingService({ appDb: app.db }).poll({
        auth: auth(`stale-certificate-${mismatch.name}`),
        request: pollRequest(WORKER, TARGET, `stale-certificate-${mismatch.name}`),
      });
      expect.soft(result.outcome, mismatch.name).toBe("offer");
      expect.soft(result.outcome === "offer" ? result.body.job.jobId : null, mismatch.name)
        .toBe(seeded.jobId);
    }

    // Candidate facts are bound explicitly. Changing the relevant source fact
    // and its placement-input digest must expose the global head immediately.
    await resetRuntimeRows();
    const changedCandidate = await seedPlacedJob({
      ordinal: 975,
      requiredCapabilities: ["sandbox.filtered_egress"],
    });
    const rejectedCandidate = await createJobLeasingService({ appDb: app.db }).poll({
      auth: auth("certificate-candidate-before"),
      request: pollRequest(WORKER, TARGET, "certificate-candidate-before"),
    });
    expect.soft(rejectedCandidate.outcome).toBe("no_work");
    const [beforeCandidateChange] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_lease_rejections
      WHERE attempt_id = ${changedCandidate.attemptId}`;
    expect.soft(beforeCandidateChange?.count).toBe(1);
    await admin`UPDATE jobs SET requirements = ${{
      workloadType: "batch",
      requiredCapabilities: ["sandbox.process_isolated"],
    }} WHERE id = ${changedCandidate.jobId}`;
    await admin`UPDATE job_attempts SET placement_input_digest = ${"8".repeat(64)}
      WHERE id = ${changedCandidate.attemptId}`;
    const candidateNowEligible = await createJobLeasingService({ appDb: app.db }).poll({
      auth: auth("certificate-candidate-after"),
      request: pollRequest(WORKER, TARGET, "certificate-candidate-after"),
    });
    expect.soft(candidateNowEligible.outcome).toBe("offer");
    expect.soft(candidateNowEligible.outcome === "offer" ? candidateNowEligible.body.job.jobId : null)
      .toBe(changedCandidate.jobId);

    // The matcher snapshot is separately hashed. A successfully parsed
    // non-capacity profile change invalidates a certificate even when the
    // enrollment-time authorization profile_hash deliberately stays fixed.
    await resetRuntimeRows();
    const contextProvider = providerProfile();
    const contextProfile = {
      ...registeredProfile(contextProvider),
      capabilityCeiling: [
        "workload.batch",
        "sandbox.process_isolated",
        "sandbox.filtered_egress",
      ],
    };
    const contextProfileHash = sha256(canonicalizeJsonV1(contextProfile));
    const initialHello = workerHello();
    const enrollmentProfileHash = sha256(JSON.stringify(initialHello));
    await admin`UPDATE execution_targets SET registered_profile = ${contextProfile},
      registered_profile_hash = ${contextProfileHash}, provider_constraint_profile = ${contextProvider},
      status = 'active', device_generation = 1, last_seen_at = clock_timestamp()
      WHERE id = ${TARGET}`;
    await admin`UPDATE workers SET profile_snapshot = ${initialHello}, profile_hash = ${enrollmentProfileHash},
      status = 'enrolled', revoked_at = NULL, last_seen_at = clock_timestamp()
      WHERE id = ${WORKER}`;
    const changedContext = await seedPlacedJob({
      ordinal: 976,
      requiredCapabilities: ["sandbox.filtered_egress"],
      placement: { profileHash: contextProfileHash, providerHash: contextProvider.digest },
    });
    const rejectedContext = await createJobLeasingService({ appDb: app.db }).poll({
      auth: auth("certificate-context-before", WORKER, TARGET, enrollmentProfileHash),
      request: pollRequest(WORKER, TARGET, "certificate-context-before"),
    });
    expect.soft(rejectedContext.outcome).toBe("no_work");
    const expandedHello = {
      ...initialHello,
      reportedCapabilities: [
        "workload.batch" as const,
        "sandbox.process_isolated" as const,
        "sandbox.filtered_egress" as const,
      ],
    };
    await admin`UPDATE workers SET profile_snapshot = ${expandedHello}
      WHERE id = ${WORKER}`;
    const contextNowEligible = await createJobLeasingService({ appDb: app.db }).poll({
      auth: auth("certificate-context-after", WORKER, TARGET, enrollmentProfileHash),
      request: pollRequest(WORKER, TARGET, "certificate-context-after"),
    });
    expect.soft(contextNowEligible.outcome).toBe("offer");
    expect.soft(contextNowEligible.outcome === "offer" ? contextNowEligible.body.job.jobId : null)
      .toBe(changedContext.jobId);

    // The same invalidation must hold when enrollment correctly rehashes the
    // changed snapshot instead of deliberately retaining the old profile_hash.
    await resetRuntimeRows();
    await admin`UPDATE execution_targets SET registered_profile = ${contextProfile},
      registered_profile_hash = ${contextProfileHash}, provider_constraint_profile = ${contextProvider},
      status = 'active', device_generation = 1, last_seen_at = clock_timestamp()
      WHERE id = ${TARGET}`;
    await admin`UPDATE workers SET profile_snapshot = ${initialHello}, profile_hash = ${enrollmentProfileHash},
      status = 'enrolled', revoked_at = NULL, last_seen_at = clock_timestamp()
      WHERE id = ${WORKER}`;
    const rehashedContext = await seedPlacedJob({
      ordinal: 977,
      requiredCapabilities: ["sandbox.filtered_egress"],
      placement: { profileHash: contextProfileHash, providerHash: contextProvider.digest },
    });
    const rehashedBefore = await createJobLeasingService({ appDb: app.db }).poll({
      auth: auth("certificate-rehashed-before", WORKER, TARGET, enrollmentProfileHash),
      request: pollRequest(WORKER, TARGET, "certificate-rehashed-before"),
    });
    expect.soft(rehashedBefore.outcome).toBe("no_work");
    const expandedEnrollmentProfileHash = sha256(JSON.stringify(expandedHello));
    await admin`UPDATE workers SET profile_snapshot = ${expandedHello},
      profile_hash = ${expandedEnrollmentProfileHash} WHERE id = ${WORKER}`;
    const rehashedAfter = await createJobLeasingService({ appDb: app.db }).poll({
      auth: auth("certificate-rehashed-after", WORKER, TARGET, expandedEnrollmentProfileHash),
      request: pollRequest(WORKER, TARGET, "certificate-rehashed-after"),
    });
    expect.soft(rehashedAfter.outcome).toBe("offer");
    expect.soft(rehashedAfter.outcome === "offer" ? rehashedAfter.body.job.jobId : null)
      .toBe(rehashedContext.jobId);
  });

  it("rejects each isolated platform generation with full rollback, then invalidates the old certificate on coherent rotation", async () => {
    const { admin, app, operator } = guard();
    const [certificateTable] = await admin<{ name: string | null }[]>`
      SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
    const certificateTableExists = certificateTable?.name === "worker_lease_rejections";

    const platformAuthority = (generation: number, makeCandidateEligible = false) => {
      const provider = platformProviderProfile(1);
      const profile = {
        ...platformRegisteredProfile(provider),
        deviceGeneration: generation,
        ...(makeCandidateEligible
          ? { capabilityCeiling: [
              "workload.batch" as const,
              "sandbox.process_isolated" as const,
              "sandbox.filtered_egress" as const,
            ] }
          : {}),
      };
      const logicalHello = {
        ...workerHello(PLATFORM_LOGICAL_WORKER_A, PLATFORM_TARGET, 1),
        deviceGeneration: generation,
        ...(makeCandidateEligible
          ? { reportedCapabilities: [
              "workload.batch" as const,
              "sandbox.process_isolated" as const,
              "sandbox.filtered_egress" as const,
            ] }
          : {}),
      };
      const physicalHello = {
        ...workerHello(PLATFORM_PHYSICAL_WORKER, PLATFORM_TARGET, 1),
        deviceGeneration: generation,
      };
      return {
        generation,
        provider,
        profile,
        profileHash: sha256(canonicalizeJsonV1(profile)),
        logicalHello,
        logicalProfileHash: sha256(JSON.stringify(logicalHello)),
        physicalHello,
        physicalProfileHash: sha256(JSON.stringify(physicalHello)),
      };
    };
    const installPlatformAuthority = async (state: ReturnType<typeof platformAuthority>): Promise<void> => {
      await admin`UPDATE execution_targets SET status = 'active', device_generation = ${state.generation},
        registered_profile = ${state.profile}, registered_profile_hash = ${state.profileHash},
        provider_constraint_profile = ${state.provider}, last_seen_at = clock_timestamp()
        WHERE id = ${PLATFORM_TARGET}`;
      await admin`UPDATE workers SET status = 'active', revoked_at = NULL,
        device_generation = ${state.generation}, profile_hash = ${state.physicalProfileHash},
        profile_snapshot = ${state.physicalHello}, device_public_key = 'job-003-public-key',
        device_thumbprint = ${THUMBPRINT}, last_seen_at = clock_timestamp()
        WHERE id = ${PLATFORM_PHYSICAL_WORKER}`;
      await admin`UPDATE workers SET status = 'enrolled', revoked_at = NULL,
        device_generation = ${state.generation}, profile_hash = ${state.logicalProfileHash},
        profile_snapshot = ${state.logicalHello}, device_public_key = 'job-003-public-key',
        device_thumbprint = ${THUMBPRINT}, last_seen_at = NULL
        WHERE id = ${PLATFORM_LOGICAL_WORKER_A}`;
    };
    const platformPoll = (
      state: ReturnType<typeof platformAuthority>,
      proofId: string,
    ) => createJobLeasingService({ appDb: app.db, operatorDb: operator.db }).poll({
      auth: auth(
        proofId,
        PLATFORM_LOGICAL_WORKER_A,
        PLATFORM_TARGET,
        state.logicalProfileHash,
        ORG,
        state.generation,
      ),
      request: {
        ...pollRequest(PLATFORM_LOGICAL_WORKER_A, PLATFORM_TARGET, proofId, 1),
        deviceGeneration: state.generation,
      },
    });
    const committedState = async (attemptId: string, proofId: string) => {
      const [row] = await admin<{
        attempt: Record<string, unknown> | null;
        job: Record<string, unknown> | null;
        logical_worker: Record<string, unknown> | null;
        physical_worker: Record<string, unknown> | null;
        target: Record<string, unknown> | null;
        leases: Array<Record<string, unknown>>;
        proofs: Array<Record<string, unknown>>;
      }[]>`SELECT
          (SELECT to_jsonb(attempt) FROM job_attempts attempt WHERE attempt.id = ${attemptId}) AS attempt,
          (SELECT to_jsonb(job) FROM jobs job WHERE job.id = (
            SELECT attempt.job_id FROM job_attempts attempt WHERE attempt.id = ${attemptId}
          )) AS job,
          (SELECT to_jsonb(logical) FROM workers logical
            WHERE logical.id = ${PLATFORM_LOGICAL_WORKER_A}) AS logical_worker,
          (SELECT to_jsonb(physical) FROM workers physical
            WHERE physical.id = ${PLATFORM_PHYSICAL_WORKER}) AS physical_worker,
          (SELECT to_jsonb(target) FROM execution_targets target
            WHERE target.id = ${PLATFORM_TARGET}) AS target,
          COALESCE((SELECT jsonb_agg(to_jsonb(lease_row) ORDER BY lease_row.id)
            FROM leases lease_row WHERE lease_row.attempt_id = ${attemptId}), '[]'::jsonb) AS leases,
          COALESCE((SELECT jsonb_agg(to_jsonb(replay) ORDER BY replay.id)
            FROM worker_proof_replays replay WHERE replay.proof_id = ${proofId}), '[]'::jsonb) AS proofs`;
      const certificates = certificateTableExists
        ? await admin<{ row: Record<string, unknown> }[]>`
            SELECT to_jsonb(rejection) AS row FROM worker_lease_rejections rejection
            WHERE rejection.attempt_id = ${attemptId}
            ORDER BY rejection.worker_id, rejection.attempt_id`
        : [];
      return row ? { ...row, certificates } : row;
    };

    const divergences = [
      {
        name: "logical-303",
        mutate: () => admin`UPDATE workers SET device_generation = 303
          WHERE id = ${PLATFORM_LOGICAL_WORKER_A}`,
      },
      {
        name: "physical-202",
        mutate: () => admin`UPDATE workers SET device_generation = 202
          WHERE id = ${PLATFORM_PHYSICAL_WORKER}`,
      },
      {
        name: "target-101",
        mutate: () => admin`UPDATE execution_targets SET device_generation = 101
          WHERE id = ${PLATFORM_TARGET}`,
      },
    ];
    for (const [index, divergence] of divergences.entries()) {
      await resetRuntimeRows();
      const baseline = platformAuthority(1);
      await installPlatformAuthority(baseline);
      const seeded = await seedPlacedJob({
        ordinal: 1130 + index,
        workerId: PLATFORM_LOGICAL_WORKER_A,
        placement: {
          targetId: PLATFORM_TARGET,
          owner: "managed_cloud",
          targetClass: "managed_cloud",
          targetScope: "platform",
          generation: baseline.generation,
          profileHash: baseline.profileHash,
          providerHash: baseline.provider.digest,
        },
      });
      await divergence.mutate();
      const proofId = `platform-divergence-${divergence.name}`;
      const before = await committedState(seeded.attemptId, proofId);
      expect.soft(before?.attempt?.status, `${divergence.name}:pending baseline`).toBe("pending");
      expect.soft(before?.job?.status, `${divergence.name}:queued baseline`).toBe("queued");
      expect.soft(before?.certificates).toEqual([]);
      expect.soft(before?.leases).toEqual([]);
      expect.soft(before?.proofs).toEqual([]);
      const claimCounter = await installClaimAttemptCounter({
        attemptId: seeded.attemptId,
        stem: divergence.name.replace("-", "_") as "logical_303" | "physical_202" | "target_101",
      });
      try {
        await expect(boundedAwait(
          `${divergence.name} authority rejection`,
          platformPoll(baseline, proofId),
          () => cancelActiveBackends({ roles: ["aoa_app", "aoa_operator"] }),
        )).rejects.toMatchObject({ code: "target_revoked" });
        expect.soft(await claimCounter.readAttempts(), `${divergence.name}:claim-attempt oracle`).toBe(0);
        expect.soft(
          await committedState(seeded.attemptId, proofId),
          `${divergence.name}:complete committed-state rollback`,
        ).toEqual(before);
      } finally {
        await boundedAwait(
          `${divergence.name} claim-counter cleanup`,
          claimCounter.drop(),
          () => cancelActiveBackends({ roles: ["aoa_app", "aoa_operator", "test"] }),
        );
      }
    }

    expect.soft(certificateTable?.name).toBe("worker_lease_rejections");
    if (!certificateTableExists) return;
    await resetRuntimeRows();
    const original = platformAuthority(1);
    await installPlatformAuthority(original);
    const rotatedCandidate = await seedPlacedJob({
      ordinal: 1139,
      workerId: PLATFORM_LOGICAL_WORKER_A,
      requiredCapabilities: ["sandbox.filtered_egress"],
      placement: {
        targetId: PLATFORM_TARGET,
        owner: "managed_cloud",
        targetClass: "managed_cloud",
        targetScope: "platform",
        generation: original.generation,
        profileHash: original.profileHash,
        providerHash: original.provider.digest,
      },
    });
    const originalPoll = await boundedAwait(
      "coherent rotation baseline poll",
      platformPoll(original, "platform-coherent-rotation-before"),
      () => cancelActiveBackends({ roles: ["aoa_app", "aoa_operator"] }),
    );
    expect.soft(originalPoll.outcome).toBe("no_work");
    const oldCertificates = await admin<{ row: Record<string, unknown> }[]>`
      SELECT to_jsonb(rejection) AS row FROM worker_lease_rejections rejection
      WHERE rejection.attempt_id = ${rotatedCandidate.attemptId}
      ORDER BY rejection.worker_id, rejection.attempt_id`;
    expect.soft(oldCertificates).toHaveLength(1);
    expect.soft(oldCertificates[0]?.row.static_context_hash).toMatch(/^[0-9a-f]{64}$/);

    const rotated = platformAuthority(2, true);
    await installPlatformAuthority(rotated);
    await admin`UPDATE job_attempts SET placement_target_generation = ${rotated.generation},
      placement_profile_hash = ${rotated.profileHash},
      placement_provider_constraint_hash = ${rotated.provider.digest}
      WHERE id = ${rotatedCandidate.attemptId}`;
    await admin.unsafe(`CREATE FUNCTION job003_forbid_rotation_certificate_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE affected_attempt uuid;
      BEGIN
        affected_attempt := CASE WHEN TG_OP = 'DELETE' THEN OLD.attempt_id ELSE NEW.attempt_id END;
        IF affected_attempt = '${rotatedCandidate.attemptId}'::uuid THEN
          RAISE EXCEPTION 'old certificate was cleaned up or rewritten before comparison';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`);
    await admin.unsafe(`CREATE TRIGGER job003_forbid_rotation_certificate_mutation
      BEFORE INSERT OR UPDATE OR DELETE ON worker_lease_rejections FOR EACH ROW
      EXECUTE FUNCTION job003_forbid_rotation_certificate_mutation()`);
    let rotatedPoll: Awaited<ReturnType<typeof platformPoll>> | undefined;
    try {
      rotatedPoll = await boundedAwait(
        "coherent rotation poll",
        platformPoll(rotated, "platform-coherent-rotation-after"),
        () => cancelActiveBackends({ roles: ["aoa_app", "aoa_operator"] }),
      );
    } finally {
      await boundedAwait(
        "coherent rotation trigger cleanup",
        admin.unsafe("DROP TRIGGER IF EXISTS job003_forbid_rotation_certificate_mutation ON worker_lease_rejections"),
        () => cancelActiveBackends({ roles: ["aoa_app", "aoa_operator", "test"] }),
      );
      await boundedAwait(
        "coherent rotation function cleanup",
        admin.unsafe("DROP FUNCTION IF EXISTS job003_forbid_rotation_certificate_mutation()"),
        () => cancelActiveBackends({ roles: ["aoa_app", "aoa_operator", "test"] }),
      );
    }
    expect.soft(rotatedPoll?.outcome).toBe("offer");
    expect.soft(rotatedPoll?.outcome === "offer" ? rotatedPoll.body.job.jobId : null)
      .toBe(rotatedCandidate.jobId);
    const currentCertificates = await admin<{ row: Record<string, unknown> }[]>`
      SELECT to_jsonb(rejection) AS row FROM worker_lease_rejections rejection
      WHERE rejection.attempt_id = ${rotatedCandidate.attemptId}
      ORDER BY rejection.worker_id, rejection.attempt_id`;
    expect.soft(currentCertificates, "old certificate remains byte-for-byte unchanged").toEqual(oldCertificates);
  }, 180_000);

  it("isolates every mutable platform authority key and algorithm version in the exact 25-key certificate context", async () => {
    const { admin, app, operator } = guard();
    const [certificateTable] = await admin<{ name: string | null }[]>`
      SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
    expect.soft(certificateTable?.name).toBe("worker_lease_rejections");
    if (certificateTable?.name !== "worker_lease_rejections") return;
    const eligibilityUrl = new URL("../services/job-lease-eligibility.ts", import.meta.url);
    expect.soft(existsSync(eligibilityUrl), "static eligibility implementation must exist").toBe(true);
    if (!existsSync(eligibilityUrl)) return;
    const eligibilitySpecifier = `../services/${"job-lease-eligibility"}.js`;
    const eligibility = await import(eligibilitySpecifier) as {
      LEASE_STATIC_ELIGIBILITY_VERSION: number;
      LEASE_CANONICALIZER_VERSION: number;
      LEASE_ALGORITHM_VERSION: number;
      LEASE_MATCHER_VERSION: number;
      LEASE_PLACEMENT_NORMALIZER_VERSION: number;
      LEASE_WORKLOAD_VOCABULARY_VERSION: number;
      logicalWorkerStaticMatcherProfileHash(hello: Record<string, unknown>): string;
      leaseStaticContextHash(input: Record<string, unknown>): string;
    };

    type PlatformAuthorityState = {
      generation: number;
      provider: ProviderConstraintProfileV1;
      profile: RegisteredTargetProfileV1;
      profileHash: string;
      logicalHello: ReturnType<typeof workerHello>;
      logicalProfileHash: string;
      physicalHello: ReturnType<typeof workerHello>;
      physicalProfileHash: string;
    };
    type PlatformContextInput = {
      organizationId: string;
      logicalWorkerId: string;
      logicalWorkerScope: string;
      logicalWorkerOwnerUserId: string | null;
      logicalWorkerTargetAuthorityKey: string;
      logicalWorkerDeviceGeneration: number;
      logicalWorkerDeviceThumbprint: string;
      logicalWorkerProfileHash: string;
      logicalWorkerStaticMatcherProfileHash: string;
      physicalAuthorityWorkerId: string;
      physicalAuthorityWorkerDeviceGeneration: number;
      physicalAuthorityWorkerProfileHash: string;
      targetId: string;
      targetScope: string;
      targetOwnerUserId: string | null;
      targetAuthorityKey: string;
      targetDeviceGeneration: number;
      targetRegisteredProfileHash: string;
      targetProviderConstraintHash: string;
    };
    type PlatformAuthorityRow = {
      organization_id: string;
      logical_worker_id: string;
      logical_worker_scope: string;
      logical_worker_owner_user_id: string | null;
      logical_worker_target_authority_key: string;
      logical_worker_device_generation: number;
      logical_worker_device_thumbprint: string;
      logical_worker_profile_hash: string;
      logical_worker_profile_snapshot: Record<string, unknown>;
      physical_authority_worker_id: string;
      physical_authority_worker_device_generation: number;
      physical_authority_worker_profile_hash: string;
      target_id: string;
      target_scope: string;
      target_owner_user_id: string | null;
      target_authority_key: string;
      target_device_generation: number;
      target_registered_profile_hash: string;
      target_provider_constraint_hash: string;
    };
    const authorityState = (input: {
      generation?: number;
      provider?: ProviderConstraintProfileV1;
      profilePolicyHash?: string;
      logicalAgentVersion?: string;
      logicalBatchSlots?: number;
      physicalAgentVersion?: string;
    } = {}): PlatformAuthorityState => {
      const generation = input.generation ?? 1;
      const provider = input.provider ?? platformProviderProfile(1);
      const profile = {
        ...platformRegisteredProfile(provider),
        deviceGeneration: generation,
        ...(input.profilePolicyHash ? { policyHash: input.profilePolicyHash } : {}),
      };
      const logicalHello = {
        ...workerHello(
          PLATFORM_LOGICAL_WORKER_A,
          PLATFORM_TARGET,
          input.logicalBatchSlots ?? 1,
        ),
        deviceGeneration: generation,
        ...(input.logicalAgentVersion ? { agentVersion: input.logicalAgentVersion } : {}),
      };
      const physicalHello = {
        ...workerHello(PLATFORM_PHYSICAL_WORKER, PLATFORM_TARGET, 1),
        deviceGeneration: generation,
        ...(input.physicalAgentVersion ? { agentVersion: input.physicalAgentVersion } : {}),
      };
      return {
        generation,
        provider,
        profile,
        profileHash: sha256(canonicalizeJsonV1(profile)),
        logicalHello,
        logicalProfileHash: sha256(JSON.stringify(logicalHello)),
        physicalHello,
        physicalProfileHash: sha256(JSON.stringify(physicalHello)),
      };
    };
    const installAuthority = async (state: PlatformAuthorityState): Promise<void> => {
      await admin`UPDATE execution_targets SET status = 'active', device_generation = ${state.generation},
        registered_profile = ${state.profile}, registered_profile_hash = ${state.profileHash},
        provider_constraint_profile = ${state.provider}, last_seen_at = clock_timestamp()
        WHERE id = ${PLATFORM_TARGET}`;
      await admin`UPDATE workers SET status = 'active', revoked_at = NULL,
        device_generation = ${state.generation}, profile_hash = ${state.physicalProfileHash},
        profile_snapshot = ${state.physicalHello}, device_public_key = 'job-003-public-key',
        device_thumbprint = ${THUMBPRINT}, last_seen_at = clock_timestamp()
        WHERE id = ${PLATFORM_PHYSICAL_WORKER}`;
      await admin`UPDATE workers SET status = 'enrolled', revoked_at = NULL,
        device_generation = ${state.generation}, profile_hash = ${state.logicalProfileHash},
        profile_snapshot = ${state.logicalHello}, device_public_key = 'job-003-public-key',
        device_thumbprint = ${THUMBPRINT}, last_seen_at = NULL
        WHERE id = ${PLATFORM_LOGICAL_WORKER_A}`;
    };
    const pollPlatform = async (
      service: ReturnType<typeof createJobLeasingService>,
      state: PlatformAuthorityState,
      proofId: string,
    ) => service.poll({
      auth: auth(
        proofId,
        PLATFORM_LOGICAL_WORKER_A,
        PLATFORM_TARGET,
        state.logicalProfileHash,
        ORG,
        state.generation,
      ),
      request: {
        ...pollRequest(PLATFORM_LOGICAL_WORKER_A, PLATFORM_TARGET, proofId, 1),
        deviceGeneration: state.generation,
      },
    });
    const readCertificate = async (attemptId: string) => {
      const [row] = await admin<{
        count: number;
        static_context_hash: string | null;
        eligibility_version: number | null;
      }[]>`SELECT count(*)::int AS count, min(static_context_hash) AS static_context_hash,
          min(eligibility_version)::int AS eligibility_version
        FROM worker_lease_rejections WHERE organization_id = ${ORG}
          AND worker_id = ${PLATFORM_LOGICAL_WORKER_A} AND attempt_id = ${attemptId}`;
      return row;
    };
    const readContextInput = async (): Promise<PlatformContextInput> => {
      const [row] = await admin<PlatformAuthorityRow[]>`SELECT
          logical.organization_id::text AS organization_id,
          logical.id::text AS logical_worker_id,
          logical.scope AS logical_worker_scope,
          logical.owner_user_id AS logical_worker_owner_user_id,
          logical.target_authority_key AS logical_worker_target_authority_key,
          logical.device_generation::int AS logical_worker_device_generation,
          logical.device_thumbprint AS logical_worker_device_thumbprint,
          logical.profile_hash AS logical_worker_profile_hash,
          logical.profile_snapshot AS logical_worker_profile_snapshot,
          physical.id::text AS physical_authority_worker_id,
          physical.device_generation::int AS physical_authority_worker_device_generation,
          physical.profile_hash AS physical_authority_worker_profile_hash,
          target.id::text AS target_id,
          target.scope AS target_scope,
          target.owner_user_id AS target_owner_user_id,
          target.target_authority_key AS target_authority_key,
          target.device_generation::int AS target_device_generation,
          target.registered_profile_hash AS target_registered_profile_hash,
          target.provider_constraint_profile ->> 'digest' AS target_provider_constraint_hash
        FROM workers logical
        JOIN execution_targets target ON target.id = logical.execution_target_id
          AND target.target_authority_key = logical.target_authority_key
        JOIN workers physical ON physical.execution_target_id = target.id
          AND physical.target_authority_key = target.target_authority_key
          AND physical.scope = 'platform'
        WHERE logical.id = ${PLATFORM_LOGICAL_WORKER_A}`;
      expect.soft(row, "real platform authority row must exist").toBeDefined();
      if (!row) throw new Error("real platform authority row missing");
      return {
        organizationId: row.organization_id,
        logicalWorkerId: row.logical_worker_id,
        logicalWorkerScope: row.logical_worker_scope,
        logicalWorkerOwnerUserId: row.logical_worker_owner_user_id,
        logicalWorkerTargetAuthorityKey: row.logical_worker_target_authority_key,
        logicalWorkerDeviceGeneration: row.logical_worker_device_generation,
        logicalWorkerDeviceThumbprint: row.logical_worker_device_thumbprint,
        logicalWorkerProfileHash: row.logical_worker_profile_hash,
        logicalWorkerStaticMatcherProfileHash:
          eligibility.logicalWorkerStaticMatcherProfileHash(row.logical_worker_profile_snapshot),
        physicalAuthorityWorkerId: row.physical_authority_worker_id,
        physicalAuthorityWorkerDeviceGeneration: row.physical_authority_worker_device_generation,
        physicalAuthorityWorkerProfileHash: row.physical_authority_worker_profile_hash,
        targetId: row.target_id,
        targetScope: row.target_scope,
        targetOwnerUserId: row.target_owner_user_id,
        targetAuthorityKey: row.target_authority_key,
        targetDeviceGeneration: row.target_device_generation,
        targetRegisteredProfileHash: row.target_registered_profile_hash,
        targetProviderConstraintHash: row.target_provider_constraint_hash,
      };
    };
    const fullCanonicalContext = (
      input: PlatformContextInput,
      algorithmVersion = eligibility.LEASE_ALGORITHM_VERSION,
    ): Record<string, unknown> => ({
      certificateVersion: eligibility.LEASE_STATIC_ELIGIBILITY_VERSION,
      canonicalizerVersion: eligibility.LEASE_CANONICALIZER_VERSION,
      leasingAlgorithmVersion: algorithmVersion,
      matcherVersion: eligibility.LEASE_MATCHER_VERSION,
      placementNormalizerVersion: eligibility.LEASE_PLACEMENT_NORMALIZER_VERSION,
      workloadVocabularyVersion: eligibility.LEASE_WORKLOAD_VOCABULARY_VERSION,
      ...input,
    });
    const independentContextHash = (canonical: Record<string, unknown>): string =>
      sha256(canonicalizeJsonV1(canonical));
    const exactCurrentContextHash = (input: PlatformContextInput): string => {
      const canonical = fullCanonicalContext(input);
      expect.soft(Object.keys(canonical), "full certificate context keys")
        .toHaveLength(25);
      const independent = independentContextHash(canonical);
      expect.soft(eligibility.leaseStaticContextHash(input), "production hash must equal independent oracle")
        .toBe(independent);
      return independent;
    };
    const mirrorOrdinaryCertificateFacts = async (
      attemptId: string,
      state: PlatformAuthorityState,
      staticContextHash: string,
    ): Promise<void> => {
      await admin`UPDATE job_attempts SET placement_target_generation = ${state.generation},
        placement_profile_hash = ${state.profileHash},
        placement_provider_constraint_hash = ${state.provider.digest}
        WHERE id = ${attemptId}`;
      await admin`UPDATE worker_lease_rejections SET eligibility_version = 1,
        static_context_hash = ${staticContextHash},
        placement_target_generation = ${state.generation},
        placement_profile_hash = ${state.profileHash},
        placement_provider_constraint_hash = ${state.provider.digest}
        WHERE organization_id = ${ORG} AND worker_id = ${PLATFORM_LOGICAL_WORKER_A}
          AND attempt_id = ${attemptId}`;
    };

    const coherentGeneration = authorityState({ generation: 2 });
    const contextCases: Array<{
      name: string;
      omittedKey: keyof PlatformContextInput;
      next: PlatformAuthorityState;
      isolatedGeneration?: number;
      assertIsolation(before: PlatformContextInput, after: PlatformContextInput): void;
    }> = [
      {
        name: "physical-generation",
        omittedKey: "physicalAuthorityWorkerDeviceGeneration",
        next: coherentGeneration,
        isolatedGeneration: 101,
        assertIsolation: (before, after) => {
          expect(after.physicalAuthorityWorkerDeviceGeneration)
            .not.toBe(before.physicalAuthorityWorkerDeviceGeneration);
        },
      },
      {
        name: "physical-profile",
        omittedKey: "physicalAuthorityWorkerProfileHash",
        next: authorityState({ physicalAgentVersion: "job-003-physical-profile-v2" }),
        assertIsolation: (before, after) => {
          expect(after.physicalAuthorityWorkerProfileHash)
            .not.toBe(before.physicalAuthorityWorkerProfileHash);
          expect(after.physicalAuthorityWorkerDeviceGeneration)
            .toBe(before.physicalAuthorityWorkerDeviceGeneration);
        },
      },
      {
        name: "target-generation",
        omittedKey: "targetDeviceGeneration",
        next: coherentGeneration,
        isolatedGeneration: 202,
        assertIsolation: (before, after) => {
          expect(after.targetDeviceGeneration).not.toBe(before.targetDeviceGeneration);
        },
      },
      {
        name: "target-profile",
        omittedKey: "targetRegisteredProfileHash",
        next: authorityState({ profilePolicyHash: "e".repeat(64) }),
        assertIsolation: (before, after) => {
          expect(after.targetRegisteredProfileHash).not.toBe(before.targetRegisteredProfileHash);
          expect(after.targetProviderConstraintHash).toBe(before.targetProviderConstraintHash);
        },
      },
      {
        name: "target-provider",
        omittedKey: "targetProviderConstraintHash",
        next: authorityState({ provider: platformProviderProfile(2) }),
        assertIsolation: (before, after) => {
          expect(after.targetProviderConstraintHash).not.toBe(before.targetProviderConstraintHash);
        },
      },
      {
        name: "logical-generation",
        omittedKey: "logicalWorkerDeviceGeneration",
        next: coherentGeneration,
        isolatedGeneration: 303,
        assertIsolation: (before, after) => {
          expect(after.logicalWorkerDeviceGeneration).not.toBe(before.logicalWorkerDeviceGeneration);
        },
      },
      {
        name: "logical-stored-profile",
        omittedKey: "logicalWorkerProfileHash",
        next: authorityState({ logicalBatchSlots: 2 }),
        assertIsolation: (before, after) => {
          expect(after.logicalWorkerProfileHash).not.toBe(before.logicalWorkerProfileHash);
          expect(after.logicalWorkerStaticMatcherProfileHash)
            .toBe(before.logicalWorkerStaticMatcherProfileHash);
        },
      },
      {
        name: "logical-static-matcher-snapshot",
        omittedKey: "logicalWorkerStaticMatcherProfileHash",
        next: authorityState({ logicalAgentVersion: "job-003-logical-static-v2" }),
        assertIsolation: (before, after) => {
          expect(after.logicalWorkerStaticMatcherProfileHash)
            .not.toBe(before.logicalWorkerStaticMatcherProfileHash);
        },
      },
    ];

    for (const [index, contextCase] of contextCases.entries()) {
      await resetRuntimeRows();
      const baseline = authorityState();
      await installAuthority(baseline);
      const seeded = await seedPlacedJob({
        ordinal: 980 + index,
        workerId: PLATFORM_LOGICAL_WORKER_A,
        requiredCapabilities: ["sandbox.filtered_egress"],
        placement: {
          targetId: PLATFORM_TARGET,
          owner: "managed_cloud",
          targetClass: "managed_cloud",
          targetScope: "platform",
          generation: baseline.generation,
          profileHash: baseline.profileHash,
          providerHash: baseline.provider.digest,
        },
      });
      const service = createJobLeasingService({ appDb: app.db, operatorDb: operator.db });
      const beforePoll = await pollPlatform(service, baseline, `platform-context-${contextCase.name}-before`);
      expect.soft(beforePoll.outcome, `${contextCase.name}:before`).toBe("no_work");
      const baselineInput = await readContextInput();
      const baselineHash = exactCurrentContextHash(baselineInput);
      expect.soft(await readCertificate(seeded.attemptId), `${contextCase.name}:baseline certificate`)
        .toMatchObject({ count: 1, eligibility_version: 1, static_context_hash: baselineHash });

      if (contextCase.isolatedGeneration !== undefined) {
        if (contextCase.omittedKey === "targetDeviceGeneration") {
          await admin`UPDATE execution_targets SET device_generation = ${contextCase.isolatedGeneration}
            WHERE id = ${PLATFORM_TARGET}`;
        } else if (contextCase.omittedKey === "physicalAuthorityWorkerDeviceGeneration") {
          await admin`UPDATE workers SET device_generation = ${contextCase.isolatedGeneration}
            WHERE id = ${PLATFORM_PHYSICAL_WORKER}`;
        } else if (contextCase.omittedKey === "logicalWorkerDeviceGeneration") {
          await admin`UPDATE workers SET device_generation = ${contextCase.isolatedGeneration}
            WHERE id = ${PLATFORM_LOGICAL_WORKER_A}`;
        } else {
          throw new Error(`${contextCase.name}: isolated generation case has a non-generation key`);
        }
        const isolatedInput = await readContextInput();
        expect.soft(isolatedInput[contextCase.omittedKey], `${contextCase.name}: isolated generation value`)
          .toBe(contextCase.isolatedGeneration);
        for (const sibling of [
          "targetDeviceGeneration",
          "physicalAuthorityWorkerDeviceGeneration",
          "logicalWorkerDeviceGeneration",
        ] as const) {
          if (sibling !== contextCase.omittedKey) {
            expect.soft(isolatedInput[sibling], `${contextCase.name}: ${sibling} remains independent`)
              .toBe(baselineInput[sibling]);
          }
        }
        const isolatedHash = independentContextHash(fullCanonicalContext(isolatedInput));
        expect.soft(
          eligibility.leaseStaticContextHash(isolatedInput),
          `${contextCase.name}: production hash uses its distinct generation source`,
        ).toBe(isolatedHash);
        expect.soft(isolatedHash, `${contextCase.name}: isolated generation invalidates the context`)
          .not.toBe(baselineHash);
      }

      // Polling requires coherent target/physical/logical authority. Restore a
      // coherent generation and use the one-key omission hash as the runtime
      // invalidation adversary after proving the three stored sources apart.
      await installAuthority(contextCase.next);
      const currentInput = await readContextInput();
      contextCase.assertIsolation(baselineInput, currentInput);
      const expectedCurrentHash = exactCurrentContextHash(currentInput);
      const omissionProjection = Object.fromEntries(
        Object.entries(fullCanonicalContext(currentInput))
          .filter(([key]) => key !== contextCase.omittedKey),
      );
      expect.soft(Object.keys(omissionProjection), `${contextCase.name}:one-key omission`)
        .toHaveLength(24);
      const adversarialHash = independentContextHash(omissionProjection);
      expect.soft(adversarialHash, `${contextCase.name}:omission must differ from current`)
        .not.toBe(expectedCurrentHash);
      await mirrorOrdinaryCertificateFacts(seeded.attemptId, contextCase.next, adversarialHash);

      const afterPoll = await pollPlatform(
        service,
        contextCase.next,
        `platform-context-${contextCase.name}-after`,
      );
      expect.soft(afterPoll.outcome, `${contextCase.name}:after`).toBe("no_work");
      expect.soft(await readCertificate(seeded.attemptId), `${contextCase.name}:refreshed certificate`)
        .toMatchObject({
          count: 1,
          eligibility_version: 1,
          static_context_hash: expectedCurrentHash,
        });
    }

    await resetRuntimeRows();
    const baseline = authorityState();
    await installAuthority(baseline);
    const algorithm = await seedPlacedJob({
      ordinal: 989,
      workerId: PLATFORM_LOGICAL_WORKER_A,
      requiredCapabilities: ["sandbox.filtered_egress"],
      placement: {
        targetId: PLATFORM_TARGET,
        owner: "managed_cloud",
        targetClass: "managed_cloud",
        targetScope: "platform",
        generation: baseline.generation,
        profileHash: baseline.profileHash,
        providerHash: baseline.provider.digest,
      },
    });
    const service = createJobLeasingService({ appDb: app.db, operatorDb: operator.db });
    const algorithmBefore = await pollPlatform(service, baseline, "platform-algorithm-version-before");
    expect.soft(algorithmBefore.outcome).toBe("no_work");
    const currentInput = await readContextInput();
    const expectedCurrentHash = exactCurrentContextHash(currentInput);
    expect.soft(await readCertificate(algorithm.attemptId), "algorithm baseline certificate")
      .toMatchObject({ count: 1, eligibility_version: 1, static_context_hash: expectedCurrentHash });
    const currentCanonical = fullCanonicalContext(currentInput);
    const algorithmAdversaries: Array<[string, Record<string, unknown>]> = [
      [
        "omitted",
        Object.fromEntries(Object.entries(currentCanonical)
          .filter(([key]) => key !== "leasingAlgorithmVersion")),
      ],
      [
        "incremented",
        {
          ...currentCanonical,
          leasingAlgorithmVersion: eligibility.LEASE_ALGORITHM_VERSION + 1,
        },
      ],
    ];
    for (const [name, adversarialCanonical] of algorithmAdversaries) {
      const adversarialHash = independentContextHash(adversarialCanonical);
      expect.soft(adversarialHash, `algorithm-${name}:adversary must differ from current`)
        .not.toBe(expectedCurrentHash);
      await mirrorOrdinaryCertificateFacts(algorithm.attemptId, baseline, adversarialHash);
      const algorithmAfter = await pollPlatform(
        service,
        baseline,
        `platform-algorithm-version-${name}-after`,
      );
      expect.soft(algorithmAfter.outcome, `algorithm-${name}:after`).toBe("no_work");
      expect.soft(await readCertificate(algorithm.attemptId), `algorithm-${name}:refreshed certificate`)
        .toMatchObject({ count: 1, eligibility_version: 1, static_context_hash: expectedCurrentHash });
    }
  }, 180_000);

  it("restarts the global head twice and offers on the third pass of the same real poll", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const staticHead = await seedPlacedJob({
      ordinal: 1110,
      requiredCapabilities: ["sandbox.filtered_egress"],
      availableAt: new Date(Date.now() - 120_000),
    });
    const eligible = await seedPlacedJob({
      ordinal: 1111,
      availableAt: new Date(Date.now() - 60_000),
    });
    const offerGate = await installOfferRestartGate({
      attemptId: eligible.attemptId,
      allowOnPass: 3,
      stem: "success",
    });
    const certificateCounter = await installCertificateWriteCounter({
      attemptId: staticHead.attemptId,
      stem: "success",
    });
    const service = createJobLeasingService({ appDb: app.db });
    let pollResult: Awaited<ReturnType<typeof service.poll>> | undefined;
    let pollFailure: unknown;
    let restartPasses = 0;
    let certificateWrites: number | null = null;
    try {
      pollResult = await service.poll({
        auth: auth("head-restart-third-pass"),
        request: pollRequest(WORKER, TARGET, "head-restart-third-pass"),
      });
    } catch (error) {
      pollFailure = error;
    } finally {
      restartPasses = await offerGate.readPasses();
      certificateWrites = certificateCounter ? await certificateCounter.readWrites() : null;
      await offerGate.drop();
      await certificateCounter?.drop();
    }

    expect.soft(pollFailure).toBeUndefined();
    expect.soft(restartPasses, "the real conditional offer must be attempted exactly three times").toBe(3);
    expect.soft(
      certificateWrites,
      "the static predecessor must be evaluated and written inside each rolled-back head pass",
    ).toBe(3);
    expect.soft(pollResult?.outcome).toBe("offer");
    expect.soft(pollResult?.outcome === "offer" ? pollResult.body.job.jobId : null)
      .toBe("a3100000-0000-4000-8000-000000001111");

    const [state] = await admin<{
      leases: number;
      pending: number;
      offered: number;
      proofs: number;
    }[]>`SELECT
      (SELECT count(*)::int FROM leases
        WHERE attempt_id IN (${staticHead.attemptId}, ${eligible.attemptId})) AS leases,
      (SELECT count(*)::int FROM job_attempts
        WHERE id IN (${staticHead.attemptId}, ${eligible.attemptId}) AND status = 'pending') AS pending,
      (SELECT count(*)::int FROM job_attempts
        WHERE id IN (${staticHead.attemptId}, ${eligible.attemptId}) AND status = 'offered') AS offered,
      (SELECT count(*)::int FROM worker_proof_replays
        WHERE proof_id = 'head-restart-third-pass') AS proofs`;
    expect.soft(state).toEqual({ leases: 1, pending: 1, offered: 1, proofs: 1 });

    const [certificateTable] = await admin<{ name: string | null }[]>`
      SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
    expect.soft(certificateTable?.name).toBe("worker_lease_rejections");
    if (certificateTable?.name === "worker_lease_rejections") {
      const [certificates] = await admin<{ staticHead: number; eligible: number }[]>`SELECT
        (SELECT count(*)::int FROM worker_lease_rejections
          WHERE worker_id = ${WORKER} AND attempt_id = ${staticHead.attemptId}) AS "staticHead",
        (SELECT count(*)::int FROM worker_lease_rejections
          WHERE worker_id = ${WORKER} AND attempt_id = ${eligible.attemptId}) AS eligible`;
      expect.soft(certificates).toEqual({ staticHead: 1, eligible: 0 });
    }
  }, 60_000);

  it("rebuilds rolled-back logical, physical, and target profile context from fresh database snapshots", async () => {
    const { admin, app, operator } = guard();
    const eligibilityUrl = new URL("../services/job-lease-eligibility.ts", import.meta.url);
    expect.soft(existsSync(eligibilityUrl), "static eligibility implementation must exist").toBe(true);
    if (!existsSync(eligibilityUrl)) return;
    const eligibilitySpecifier = `../services/${"job-lease-eligibility"}.js`;
    const eligibility = await import(eligibilitySpecifier) as {
      buildLeaseStaticContextInput(sources: Record<string, unknown>): Record<string, unknown>;
      leaseStaticContextHash(input: Record<string, unknown>): string;
    };
    expect.soft(typeof eligibility.buildLeaseStaticContextInput).toBe("function");
    expect.soft(typeof eligibility.leaseStaticContextHash).toBe("function");
    if (typeof eligibility.buildLeaseStaticContextInput !== "function" ||
        typeof eligibility.leaseStaticContextHash !== "function") return;
    const [certificateTable] = await admin<{ name: string | null }[]>`
      SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
    expect.soft(certificateTable?.name, "static-negative certificate table must exist")
      .toBe("worker_lease_rejections");
    if (certificateTable?.name !== "worker_lease_rejections") return;

    const readCurrentContext = async (input: {
      logicalWorkerId: string;
      targetId: string;
      physicalWorkerId: string | null;
    }, database: Sql = admin): Promise<{ input: Record<string, unknown>; hash: string }> => {
      const [row] = await database<{
        organization_id: string;
        logical_id: string;
        logical_scope: "organization" | "owner";
        logical_owner_user_id: string | null;
        logical_target_authority_key: string;
        logical_device_generation: number;
        logical_device_thumbprint: string;
        logical_profile_hash: string;
        logical_profile_snapshot: Record<string, unknown>;
        target_id: string;
        target_scope: "platform" | "organization" | "owner";
        target_owner_user_id: string | null;
        target_authority_key: string;
        target_device_generation: number;
        target_registered_profile_hash: string;
        target_provider_constraint_hash: string;
        physical_id: string | null;
        physical_device_generation: number | null;
        physical_profile_hash: string | null;
      }[]>`SELECT
          logical.organization_id::text AS organization_id,
          logical.id::text AS logical_id,
          logical.scope AS logical_scope,
          logical.owner_user_id AS logical_owner_user_id,
          logical.target_authority_key AS logical_target_authority_key,
          logical.device_generation::int AS logical_device_generation,
          logical.device_thumbprint AS logical_device_thumbprint,
          logical.profile_hash AS logical_profile_hash,
          logical.profile_snapshot AS logical_profile_snapshot,
          target.id::text AS target_id,
          target.scope AS target_scope,
          target.owner_user_id AS target_owner_user_id,
          target.target_authority_key AS target_authority_key,
          target.device_generation::int AS target_device_generation,
          target.registered_profile_hash AS target_registered_profile_hash,
          target.provider_constraint_profile ->> 'digest' AS target_provider_constraint_hash,
          physical.id::text AS physical_id,
          physical.device_generation::int AS physical_device_generation,
          physical.profile_hash AS physical_profile_hash
        FROM workers logical
        JOIN execution_targets target ON target.id = ${input.targetId}
          AND target.id = logical.execution_target_id
          AND target.target_authority_key = logical.target_authority_key
        LEFT JOIN workers physical ON physical.id = ${input.physicalWorkerId}
        WHERE logical.id = ${input.logicalWorkerId}`;
      expect.soft(row, "current context source row").toBeDefined();
      if (!row) throw new Error("current context source row missing");
      const physicalAuthorityWorker = row.target_scope === "platform"
        ? {
            id: row.physical_id,
            deviceGeneration: row.physical_device_generation,
            profileHash: row.physical_profile_hash,
          }
        : null;
      const projected = eligibility.buildLeaseStaticContextInput({
        organizationId: row.organization_id,
        parsedWorkerHello: row.logical_profile_snapshot,
        logicalWorker: {
          id: row.logical_id,
          scope: row.logical_scope,
          ownerUserId: row.logical_owner_user_id,
          targetAuthorityKey: row.logical_target_authority_key,
          deviceGeneration: row.logical_device_generation,
          deviceThumbprint: row.logical_device_thumbprint,
          profileHash: row.logical_profile_hash,
        },
        currentTarget: {
          id: row.target_id,
          scope: row.target_scope,
          ownerUserId: row.target_owner_user_id,
          targetAuthorityKey: row.target_authority_key,
          deviceGeneration: row.target_device_generation,
          registeredProfileHash: row.target_registered_profile_hash,
          providerConstraintHash: row.target_provider_constraint_hash,
        },
        physicalAuthorityWorker,
      });
      return { input: projected, hash: eligibility.leaseStaticContextHash(projected) };
    };

    type RestartCase = {
      stem: "logical_profile" | "physical_profile" | "target_profile";
      advisoryKey: number;
      proofId: string;
      logicalWorkerId: string;
      targetId: string;
      physicalWorkerId: string | null;
      staticAttemptId: string;
      eligibleAttemptId: string;
      expectedJobId: string;
      expectedPasses: number;
      expectedCertificateWrites: number;
      expectedChangedContextKey: string;
      poll(): Promise<Awaited<ReturnType<ReturnType<typeof createJobLeasingService>["poll"]>>>;
      mutate(sql: Sql): Promise<void>;
      verify(oldHash: string, newHash: string): Promise<void>;
    };
    type RestartCommittedState = {
      logical_worker: Record<string, unknown> | null;
      physical_worker: Record<string, unknown> | null;
      target: Record<string, unknown> | null;
      attempts: Array<Record<string, unknown>>;
      jobs: Array<Record<string, unknown>>;
      proofs: Array<Record<string, unknown>>;
      certificates: Array<Record<string, unknown>>;
      leases: Array<Record<string, unknown>>;
    };
    const readRestartCommittedState = async (
      input: RestartCase,
      database: Sql = admin,
    ): Promise<RestartCommittedState> => {
      const [state] = await database<RestartCommittedState[]>`SELECT
          (SELECT to_jsonb(logical) FROM workers logical
            WHERE logical.id = ${input.logicalWorkerId}) AS logical_worker,
          (SELECT to_jsonb(physical) FROM workers physical
            WHERE physical.id = ${input.physicalWorkerId}) AS physical_worker,
          (SELECT to_jsonb(target) FROM execution_targets target
            WHERE target.id = ${input.targetId}) AS target,
          COALESCE((SELECT jsonb_agg(to_jsonb(attempt) ORDER BY attempt.id)
            FROM job_attempts attempt
            WHERE attempt.id IN (${input.staticAttemptId}, ${input.eligibleAttemptId})), '[]'::jsonb)
            AS attempts,
          COALESCE((SELECT jsonb_agg(to_jsonb(job) ORDER BY job.id)
            FROM jobs job WHERE job.id IN (
              SELECT attempt.job_id FROM job_attempts attempt
              WHERE attempt.id IN (${input.staticAttemptId}, ${input.eligibleAttemptId})
            )), '[]'::jsonb) AS jobs,
          COALESCE((SELECT jsonb_agg(to_jsonb(replay) ORDER BY replay.id)
            FROM worker_proof_replays replay
            WHERE replay.proof_id = ${input.proofId}), '[]'::jsonb) AS proofs,
          COALESCE((SELECT jsonb_agg(to_jsonb(rejection)
              ORDER BY rejection.worker_id, rejection.attempt_id)
            FROM worker_lease_rejections rejection
            WHERE rejection.attempt_id IN (${input.staticAttemptId}, ${input.eligibleAttemptId})),
            '[]'::jsonb) AS certificates,
          COALESCE((SELECT jsonb_agg(to_jsonb(lease_row) ORDER BY lease_row.id)
            FROM leases lease_row
            WHERE lease_row.attempt_id IN (${input.staticAttemptId}, ${input.eligibleAttemptId})),
            '[]'::jsonb) AS leases`;
      if (!state) throw new Error(`${input.stem}: committed-state snapshot missing`);
      return state;
    };
    const runRestartCase = async (testCase: RestartCase): Promise<void> => {
      const barrier = await installContextRefreshRestartBarrier({
        attemptId: testCase.eligibleAttemptId,
        stem: testCase.stem,
        advisoryKey: testCase.advisoryKey,
      });
      const counter = await installCertificateWriteCounter({
        attemptId: testCase.staticAttemptId,
        stem: testCase.stem,
        workerId: testCase.logicalWorkerId,
      });
      expect.soft(counter, `${testCase.stem}:certificate counter`).not.toBeNull();
      if (!counter) {
        await barrier.drop();
        return;
      }
      const coordinator = postgres(adminUrl, { max: 1 });
      const mutator = postgres(adminUrl, { max: 1 });
      const [coordinatorSession] = await coordinator<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      const [mutatorSession] = await mutator<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      const commitBarrierKey = testCase.advisoryKey + 10_000;
      let passBarrierLocked = false;
      let commitBarrierLocked = false;
      let pollPromise: ReturnType<RestartCase["poll"]> | undefined;
      let mutationPromise: Promise<unknown> | undefined;
      try {
        await coordinator`SELECT pg_advisory_lock(${testCase.advisoryKey})`;
        passBarrierLocked = true;
        await coordinator`SELECT pg_advisory_lock(${commitBarrierKey})`;
        commitBarrierLocked = true;
        const committedBaseline = await readRestartCommittedState(testCase);
        const oldContext = await readCurrentContext(testCase);
        pollPromise = testCase.poll();
        await barrier.waitForFirstPass();
        let firstPollPid: number | null = null;
        await waitUntil(`${testCase.stem} pass one blocked by coordinator`, async () => {
          const [activity] = await admin<{ pid: number; blocking_pids: number[] }[]>`
            SELECT pid::int, pg_blocking_pids(pid) AS blocking_pids
            FROM pg_stat_activity
            WHERE usename = 'aoa_app'
              AND ${coordinatorSession?.pid ?? -1} = ANY(pg_blocking_pids(pid))
            ORDER BY pid LIMIT 1`;
          firstPollPid = activity?.pid ?? null;
          return Boolean(firstPollPid && activity?.blocking_pids.includes(coordinatorSession?.pid ?? -1));
        });
        mutationPromise = mutator.begin(async (tx) => {
          const transactionalSql = tx as unknown as Sql;
          await transactionalSql`SELECT id FROM workers
            WHERE id = ${testCase.logicalWorkerId} FOR UPDATE`;
          const afterPassOne = await readRestartCommittedState(testCase, transactionalSql);
          expect(afterPassOne, `${testCase.stem}:pass one commits no relevant state`)
            .toEqual(committedBaseline);
          const committedContext = await readCurrentContext(testCase, transactionalSql);
          expect(committedContext, `${testCase.stem}:mutator observes rolled-back context`)
            .toEqual(oldContext);
          await testCase.mutate(tx as unknown as Sql);
          await transactionalSql`SELECT pg_advisory_lock(${commitBarrierKey})`;
          await transactionalSql`SELECT pg_advisory_unlock(${commitBarrierKey})`;
        });
        await waitUntil(`${testCase.stem} mutator queued behind pass one`, async () => {
          const [activity] = await admin<{ wait_event_type: string | null; blocking_pids: number[] }[]>`
            SELECT wait_event_type, pg_blocking_pids(pid) AS blocking_pids
            FROM pg_stat_activity WHERE pid = ${mutatorSession?.pid ?? -1}`;
          return activity?.wait_event_type === "Lock" &&
            activity.blocking_pids.includes(firstPollPid ?? -1);
        });
        await coordinator`SELECT pg_advisory_unlock(${testCase.advisoryKey})`;
        passBarrierLocked = false;
        await waitUntil(`${testCase.stem} mutation committed facts held before pass two`, async () => {
          const [activity] = await admin<{ wait_event_type: string | null; blocking_pids: number[] }[]>`
            SELECT wait_event_type, pg_blocking_pids(pid) AS blocking_pids
            FROM pg_stat_activity WHERE pid = ${mutatorSession?.pid ?? -1}`;
          return activity?.wait_event_type === "Lock" &&
            activity.blocking_pids.includes(coordinatorSession?.pid ?? -1);
        });
        await waitUntil(`${testCase.stem} pass two queued behind mutator`, async () => {
          const [activity] = await admin<{ pid: number; wait_event_type: string | null; blocking_pids: number[] }[]>`
            SELECT pid::int, wait_event_type, pg_blocking_pids(pid) AS blocking_pids
            FROM pg_stat_activity
            WHERE usename = 'aoa_app'
              AND ${mutatorSession?.pid ?? -1} = ANY(pg_blocking_pids(pid))
            ORDER BY pid LIMIT 1`;
          return activity?.wait_event_type === "Lock" &&
            activity.blocking_pids.includes(mutatorSession?.pid ?? -1);
        });
        await coordinator`SELECT pg_advisory_unlock(${commitBarrierKey})`;
        commitBarrierLocked = false;
        await boundedAwait(
          `${testCase.stem} mutation commit`,
          mutationPromise,
          () => cancelActiveBackends({ pids: [mutatorSession?.pid ?? -1] }),
        );
        const newContext = await readCurrentContext(testCase);
        const changedContextKeys = Object.keys(newContext.input)
          .filter((key) => newContext.input[key] !== oldContext.input[key]);
        expect.soft(changedContextKeys, `${testCase.stem}:one-factor source rotation`)
          .toEqual([testCase.expectedChangedContextKey]);
        expect.soft(newContext.hash, `${testCase.stem}:source rotation changes context`).not.toBe(oldContext.hash);
        const result = await boundedAwait(
          `${testCase.stem} restarted poll`,
          pollPromise,
          () => cancelActiveBackends({ roles: ["aoa_app", "aoa_operator"] }),
        );
        expect.soft(result.outcome, `${testCase.stem}:second attempt result`).toBe("offer");
        expect.soft(result.outcome === "offer" ? result.body.job.jobId : null, `${testCase.stem}:fresh head`)
          .toBe(testCase.expectedJobId);
        expect.soft(await barrier.readPasses(), `${testCase.stem}:restart passes`).toBe(testCase.expectedPasses);
        expect.soft(await counter.readWrites(), `${testCase.stem}:one certificate evaluation per reached attempt`)
          .toBe(testCase.expectedCertificateWrites);
        await testCase.verify(oldContext.hash, newContext.hash);
      } finally {
        if (passBarrierLocked) {
          await boundedAwait(
            `${testCase.stem} pass-barrier unlock`,
            coordinator`SELECT pg_advisory_unlock(${testCase.advisoryKey})`,
            () => cancelActiveBackends({ pids: [coordinatorSession?.pid ?? -1] }),
          ).catch(() => {});
        }
        if (commitBarrierLocked) {
          await boundedAwait(
            `${testCase.stem} mutation-barrier unlock`,
            coordinator`SELECT pg_advisory_unlock(${commitBarrierKey})`,
            () => cancelActiveBackends({ pids: [coordinatorSession?.pid ?? -1] }),
          ).catch(() => {});
        }
        await boundedAwait(
          `${testCase.stem} pending operation cancellation`,
          Promise.allSettled([
            ...(pollPromise ? [pollPromise] : []),
            ...(mutationPromise ? [mutationPromise] : []),
          ]),
          async () => {
            await Promise.all([
              cancelActiveBackends({ pids: [mutatorSession?.pid ?? -1] }),
              cancelActiveBackends({ roles: ["aoa_app", "aoa_operator"] }),
            ]);
          },
        ).catch(() => {});
        await boundedAwait(
          `${testCase.stem} restart barrier cleanup`,
          barrier.drop(),
          () => cancelActiveBackends({ roles: ["aoa_app", "aoa_operator", "test"] }),
        );
        await boundedAwait(
          `${testCase.stem} certificate counter cleanup`,
          counter.drop(),
          () => cancelActiveBackends({ roles: ["aoa_app", "aoa_operator", "test"] }),
        );
        await boundedAwait(
          `${testCase.stem} mutator close`,
          mutator.end(),
          () => cancelActiveBackends({ pids: [mutatorSession?.pid ?? -1] }),
        ).catch(() => {});
        await boundedAwait(
          `${testCase.stem} coordinator close`,
          coordinator.end(),
          () => cancelActiveBackends({ pids: [coordinatorSession?.pid ?? -1] }),
        ).catch(() => {});
      }
    };

    await resetRuntimeRows();
    const logicalProvider = providerProfile();
    const logicalTargetProfile = {
      ...registeredProfile(logicalProvider),
      capabilityCeiling: [
        "workload.batch",
        "sandbox.process_isolated",
        "sandbox.filtered_egress",
      ],
    };
    const logicalTargetProfileHash = sha256(canonicalizeJsonV1(logicalTargetProfile));
    const logicalHelloBefore = workerHello();
    const retainedEnrollmentHash = sha256(JSON.stringify(logicalHelloBefore));
    const logicalHelloAfter = {
      ...logicalHelloBefore,
      reportedCapabilities: [
        "workload.batch" as const,
        "sandbox.process_isolated" as const,
        "sandbox.filtered_egress" as const,
      ],
    };
    await admin`UPDATE execution_targets SET registered_profile = ${logicalTargetProfile},
      registered_profile_hash = ${logicalTargetProfileHash},
      provider_constraint_profile = ${logicalProvider}, status = 'active', device_generation = 1,
      last_seen_at = clock_timestamp() WHERE id = ${TARGET}`;
    await admin`UPDATE workers SET profile_snapshot = ${logicalHelloBefore},
      profile_hash = ${retainedEnrollmentHash}, status = 'enrolled', revoked_at = NULL,
      device_generation = 1, last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
    const logicalStaticHead = await seedPlacedJob({
      ordinal: 1140,
      requiredCapabilities: ["sandbox.filtered_egress"],
      availableAt: new Date(Date.now() - 120_000),
      placement: { profileHash: logicalTargetProfileHash, providerHash: logicalProvider.digest },
    });
    const logicalEligible = await seedPlacedJob({
      ordinal: 1141,
      availableAt: new Date(Date.now() - 60_000),
      placement: { profileHash: logicalTargetProfileHash, providerHash: logicalProvider.digest },
    });
    const logicalService = createJobLeasingService({ appDb: app.db });
    await runRestartCase({
      stem: "logical_profile",
      advisoryKey: 30_031,
      proofId: "restart-logical-profile",
      logicalWorkerId: WORKER,
      targetId: TARGET,
      physicalWorkerId: null,
      staticAttemptId: logicalStaticHead.attemptId,
      eligibleAttemptId: logicalEligible.attemptId,
      expectedJobId: logicalStaticHead.jobId,
      expectedPasses: 1,
      expectedCertificateWrites: 1,
      expectedChangedContextKey: "logicalWorkerStaticMatcherProfileHash",
      poll: () => logicalService.poll({
        auth: auth("restart-logical-profile", WORKER, TARGET, retainedEnrollmentHash),
        request: pollRequest(WORKER, TARGET, "restart-logical-profile"),
      }),
      async mutate(sql) {
        await sql`UPDATE workers SET profile_snapshot = ${logicalHelloAfter}
          WHERE id = ${WORKER}`;
      },
      async verify(_oldHash, _newHash) {
        const [state] = await admin<{
          profile_hash: string;
          profile_snapshot: Record<string, unknown>;
          certificates: number;
        }[]>`SELECT worker.profile_hash, worker.profile_snapshot,
            (SELECT count(*)::int FROM worker_lease_rejections
              WHERE attempt_id = ${logicalStaticHead.attemptId}) AS certificates
          FROM workers worker WHERE worker.id = ${WORKER}`;
        expect.soft(state?.profile_hash).toBe(retainedEnrollmentHash);
        expect.soft(state?.profile_snapshot).toEqual(logicalHelloAfter);
        expect.soft(state?.certificates).toBe(0);
      },
    });

    const platformAuthority = (input: { physicalAgentVersion?: string; reverseTargetCapabilities?: boolean } = {}) => {
      const provider = platformProviderProfile(1);
      const baseProfile = platformRegisteredProfile(provider);
      const profile = input.reverseTargetCapabilities
        ? { ...baseProfile, capabilityCeiling: [...baseProfile.capabilityCeiling].reverse() }
        : baseProfile;
      const logicalHello = workerHello(PLATFORM_LOGICAL_WORKER_A, PLATFORM_TARGET, 1);
      const physicalHello = {
        ...workerHello(PLATFORM_PHYSICAL_WORKER, PLATFORM_TARGET, 1),
        ...(input.physicalAgentVersion ? { agentVersion: input.physicalAgentVersion } : {}),
      };
      return {
        provider,
        profile,
        profileHash: sha256(canonicalizeJsonV1(profile)),
        logicalHello,
        logicalProfileHash: sha256(JSON.stringify(logicalHello)),
        physicalHello,
        physicalProfileHash: sha256(JSON.stringify(physicalHello)),
      };
    };
    const installPlatform = async (state: ReturnType<typeof platformAuthority>): Promise<void> => {
      await admin`UPDATE execution_targets SET registered_profile = ${state.profile},
        registered_profile_hash = ${state.profileHash}, provider_constraint_profile = ${state.provider},
        status = 'active', device_generation = 1, last_seen_at = clock_timestamp()
        WHERE id = ${PLATFORM_TARGET}`;
      await admin`UPDATE workers SET profile_snapshot = ${state.logicalHello},
        profile_hash = ${state.logicalProfileHash}, status = 'enrolled', revoked_at = NULL,
        device_generation = 1, last_seen_at = NULL WHERE id = ${PLATFORM_LOGICAL_WORKER_A}`;
      await admin`UPDATE workers SET profile_snapshot = ${state.physicalHello},
        profile_hash = ${state.physicalProfileHash}, status = 'active', revoked_at = NULL,
        device_generation = 1, last_seen_at = clock_timestamp() WHERE id = ${PLATFORM_PHYSICAL_WORKER}`;
    };
    const platformPoll = (
      state: ReturnType<typeof platformAuthority>,
      proofId: string,
    ) => createJobLeasingService({ appDb: app.db, operatorDb: operator.db }).poll({
      auth: auth(
        proofId,
        PLATFORM_LOGICAL_WORKER_A,
        PLATFORM_TARGET,
        state.logicalProfileHash,
        ORG,
        1,
      ),
      request: pollRequest(PLATFORM_LOGICAL_WORKER_A, PLATFORM_TARGET, proofId, 1),
    });

    await resetRuntimeRows();
    const physicalBefore = platformAuthority();
    const physicalAfter = platformAuthority({ physicalAgentVersion: "job-003-physical-retry-v2" });
    await installPlatform(physicalBefore);
    const physicalStaticHead = await seedPlacedJob({
      ordinal: 1142,
      workerId: PLATFORM_LOGICAL_WORKER_A,
      requiredCapabilities: ["sandbox.filtered_egress"],
      availableAt: new Date(Date.now() - 120_000),
      placement: {
        targetId: PLATFORM_TARGET, owner: "managed_cloud", targetClass: "managed_cloud",
        targetScope: "platform", profileHash: physicalBefore.profileHash,
        providerHash: physicalBefore.provider.digest,
      },
    });
    const physicalEligible = await seedPlacedJob({
      ordinal: 1143,
      workerId: PLATFORM_LOGICAL_WORKER_A,
      availableAt: new Date(Date.now() - 60_000),
      placement: {
        targetId: PLATFORM_TARGET, owner: "managed_cloud", targetClass: "managed_cloud",
        targetScope: "platform", profileHash: physicalBefore.profileHash,
        providerHash: physicalBefore.provider.digest,
      },
    });
    await runRestartCase({
      stem: "physical_profile",
      advisoryKey: 30_032,
      proofId: "restart-physical-profile",
      logicalWorkerId: PLATFORM_LOGICAL_WORKER_A,
      targetId: PLATFORM_TARGET,
      physicalWorkerId: PLATFORM_PHYSICAL_WORKER,
      staticAttemptId: physicalStaticHead.attemptId,
      eligibleAttemptId: physicalEligible.attemptId,
      expectedJobId: physicalEligible.jobId,
      expectedPasses: 2,
      expectedCertificateWrites: 2,
      expectedChangedContextKey: "physicalAuthorityWorkerProfileHash",
      poll: () => platformPoll(physicalBefore, "restart-physical-profile"),
      async mutate(sql) {
        await sql`UPDATE workers SET profile_snapshot = ${physicalAfter.physicalHello},
          profile_hash = ${physicalAfter.physicalProfileHash}
          WHERE id = ${PLATFORM_PHYSICAL_WORKER}`;
      },
      async verify(_oldHash, newHash) {
        const [certificate] = await admin<{ count: number; static_context_hash: string | null }[]>`
          SELECT count(*)::int AS count, min(static_context_hash) AS static_context_hash
          FROM worker_lease_rejections WHERE attempt_id = ${physicalStaticHead.attemptId}`;
        expect.soft(certificate).toEqual({ count: 1, static_context_hash: newHash });
      },
    });

    await resetRuntimeRows();
    const targetBefore = platformAuthority();
    const targetAfter = platformAuthority({ reverseTargetCapabilities: true });
    await installPlatform(targetBefore);
    const targetStaticHead = await seedPlacedJob({
      ordinal: 1144,
      workerId: PLATFORM_LOGICAL_WORKER_A,
      requiredCapabilities: ["sandbox.filtered_egress"],
      availableAt: new Date(Date.now() - 120_000),
      placement: {
        targetId: PLATFORM_TARGET, owner: "managed_cloud", targetClass: "managed_cloud",
        targetScope: "platform", profileHash: targetBefore.profileHash,
        providerHash: targetBefore.provider.digest,
      },
    });
    const targetEligible = await seedPlacedJob({
      ordinal: 1145,
      workerId: PLATFORM_LOGICAL_WORKER_A,
      availableAt: new Date(Date.now() - 60_000),
      placement: {
        targetId: PLATFORM_TARGET, owner: "managed_cloud", targetClass: "managed_cloud",
        targetScope: "platform", profileHash: targetBefore.profileHash,
        providerHash: targetBefore.provider.digest,
      },
    });
    await runRestartCase({
      stem: "target_profile",
      advisoryKey: 30_033,
      proofId: "restart-target-profile",
      logicalWorkerId: PLATFORM_LOGICAL_WORKER_A,
      targetId: PLATFORM_TARGET,
      physicalWorkerId: PLATFORM_PHYSICAL_WORKER,
      staticAttemptId: targetStaticHead.attemptId,
      eligibleAttemptId: targetEligible.attemptId,
      expectedJobId: targetEligible.jobId,
      expectedPasses: 2,
      expectedCertificateWrites: 2,
      expectedChangedContextKey: "targetRegisteredProfileHash",
      poll: () => platformPoll(targetBefore, "restart-target-profile"),
      async mutate(sql) {
        await sql`UPDATE execution_targets SET registered_profile = ${targetAfter.profile},
          registered_profile_hash = ${targetAfter.profileHash} WHERE id = ${PLATFORM_TARGET}`;
        await sql`UPDATE job_attempts SET placement_profile_hash = ${targetAfter.profileHash}
          WHERE id IN (${targetStaticHead.attemptId}, ${targetEligible.attemptId})`;
      },
      async verify(_oldHash, newHash) {
        const [certificate] = await admin<{ count: number; static_context_hash: string | null }[]>`
          SELECT count(*)::int AS count, min(static_context_hash) AS static_context_hash
          FROM worker_lease_rejections WHERE attempt_id = ${targetStaticHead.attemptId}`;
        expect.soft(certificate).toEqual({ count: 1, static_context_hash: newHash });
      },
    });
  }, 180_000);

  it("bounds all three static head restarts and rolls the exhausted poll transaction back", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const staticHead = await seedPlacedJob({
      ordinal: 1120,
      requiredCapabilities: ["sandbox.filtered_egress"],
      availableAt: new Date(Date.now() - 120_000),
    });
    const eligible = await seedPlacedJob({
      ordinal: 1121,
      availableAt: new Date(Date.now() - 60_000),
    });
    const attemptsBefore = await admin<{ id: string; status: string; updatedAt: string }[]>`
      SELECT id::text AS id, status,
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS "updatedAt"
      FROM job_attempts WHERE id IN (${staticHead.attemptId}, ${eligible.attemptId}) ORDER BY id`;
    const [workerBefore] = await admin<{ lastSeenAt: string }[]>`
      SELECT to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS "lastSeenAt"
      FROM workers WHERE id = ${WORKER}`;
    const offerGate = await installOfferRestartGate({
      attemptId: eligible.attemptId,
      allowOnPass: 4,
      stem: "exhaustion",
    });
    const certificateCounter = await installCertificateWriteCounter({
      attemptId: staticHead.attemptId,
      stem: "exhaustion",
    });
    const service = createJobLeasingService({ appDb: app.db });
    let pollResult: Awaited<ReturnType<typeof service.poll>> | undefined;
    let pollFailure: unknown;
    let restartPasses = 0;
    let certificateWrites: number | null = null;
    try {
      pollResult = await service.poll({
        auth: auth("head-restart-exhausted"),
        request: pollRequest(WORKER, TARGET, "head-restart-exhausted"),
      });
    } catch (error) {
      pollFailure = error;
    } finally {
      restartPasses = await offerGate.readPasses();
      certificateWrites = certificateCounter ? await certificateCounter.readWrites() : null;
      await offerGate.drop();
      await certificateCounter?.drop();
    }

    expect.soft(restartPasses, "the fourth conditional offer must never run").toBe(3);
    expect.soft(certificateWrites, "each failed pass must reach the real static-certificate write").toBe(3);
    expect.soft(pollResult).toBeUndefined();
    expect.soft(pollFailure).toMatchObject({ code: "internal_unavailable" });

    const [state] = await admin<{
      leases: number;
      pending: number;
      offered: number;
      proofs: number;
    }[]>`SELECT
      (SELECT count(*)::int FROM leases
        WHERE attempt_id IN (${staticHead.attemptId}, ${eligible.attemptId})) AS leases,
      (SELECT count(*)::int FROM job_attempts
        WHERE id IN (${staticHead.attemptId}, ${eligible.attemptId}) AND status = 'pending') AS pending,
      (SELECT count(*)::int FROM job_attempts
        WHERE id IN (${staticHead.attemptId}, ${eligible.attemptId}) AND status = 'offered') AS offered,
      (SELECT count(*)::int FROM worker_proof_replays
        WHERE proof_id = 'head-restart-exhausted') AS proofs`;
    expect.soft(state).toEqual({ leases: 0, pending: 2, offered: 0, proofs: 0 });
    const attemptsAfter = await admin<{ id: string; status: string; updatedAt: string }[]>`
      SELECT id::text AS id, status,
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS "updatedAt"
      FROM job_attempts WHERE id IN (${staticHead.attemptId}, ${eligible.attemptId}) ORDER BY id`;
    const [workerAfter] = await admin<{ lastSeenAt: string }[]>`
      SELECT to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS "lastSeenAt"
      FROM workers WHERE id = ${WORKER}`;
    expect.soft(attemptsAfter).toEqual(attemptsBefore);
    expect.soft(workerAfter).toEqual(workerBefore);

    const [certificateTable] = await admin<{ name: string | null }[]>`
      SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
    expect.soft(certificateTable?.name).toBe("worker_lease_rejections");
    if (certificateTable?.name === "worker_lease_rejections") {
      const [certificates] = await admin<{ count: number }[]>`
        SELECT count(*)::int AS count FROM worker_lease_rejections
        WHERE worker_id = ${WORKER}
          AND attempt_id IN (${staticHead.attemptId}, ${eligible.attemptId})`;
      expect.soft(certificates?.count).toBe(0);
    }
  }, 60_000);

  it("rolls back predecessor certificates when lease insert fails and never certifies invariant failures", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const [certificateTable] = await admin<{ name: string | null }[]>`
      SELECT to_regclass('public.worker_lease_rejections')::text AS name`;
    expect.soft(certificateTable?.name).toBe("worker_lease_rejections");
    if (certificateTable?.name !== "worker_lease_rejections") return;

    const authority = await configureMixedWorkloadAuthority();
    const placement = { profileHash: authority.targetProfileHash, providerHash: authority.providerHash };
    const incompatible = await seedPlacedJob({
      ordinal: 980,
      workloadType: "batch",
      requiredCapabilities: ["sandbox.filtered_egress"],
      availableAt: new Date(Date.now() - 120_000),
      placement,
    });
    const eligible = await seedPlacedJob({
      ordinal: 981,
      workloadType: "browser_session",
      availableAt: new Date(Date.now() - 60_000),
      placement,
    });
    await admin.unsafe(`CREATE OR REPLACE FUNCTION job003_fail_lease_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'job003 forced lease insert failure'; END $$`);
    await admin.unsafe(`CREATE TRIGGER job003_fail_lease_insert BEFORE INSERT ON leases
      FOR EACH ROW EXECUTE FUNCTION job003_fail_lease_insert()`);
    try {
      const capacity = {
        batchSlots: 1,
        browserSessionSlots: 1,
        serviceSlots: 0,
        freeCpuMillis: 2_000,
        freeMemoryMiB: 4_096,
        freeDiskMiB: 8_192,
      };
      await expect(createJobLeasingService({ appDb: app.db }).poll({
        auth: auth("certificate-offer-rollback", WORKER, TARGET, authority.workerProfileHash),
        request: pollRequestWithCapacity(WORKER, TARGET, "certificate-offer-rollback", capacity),
      })).rejects.toMatchObject({ code: "internal_unavailable" });
    } finally {
      await admin.unsafe("DROP TRIGGER IF EXISTS job003_fail_lease_insert ON leases");
      await admin.unsafe("DROP FUNCTION IF EXISTS job003_fail_lease_insert()");
    }
    const [rolledBack] = await admin<{ certificates: number; leases: number; pending: number }[]>`SELECT
      (SELECT count(*)::int FROM worker_lease_rejections
        WHERE attempt_id IN (${incompatible.attemptId}, ${eligible.attemptId})) AS certificates,
      (SELECT count(*)::int FROM leases
        WHERE attempt_id IN (${incompatible.attemptId}, ${eligible.attemptId})) AS leases,
      (SELECT count(*)::int FROM job_attempts
        WHERE id IN (${incompatible.attemptId}, ${eligible.attemptId}) AND status = 'pending') AS pending`;
    expect.soft(rolledBack).toEqual({ certificates: 0, leases: 0, pending: 2 });

    await resetRuntimeRows();
    const malformed = await seedPlacedJob({ ordinal: 982 });
    await admin`UPDATE jobs SET input = '{}'::jsonb WHERE id = ${malformed.jobId}`;
    await expect(createJobLeasingService({ appDb: app.db }).poll({
      auth: auth("certificate-invariant-failure"),
      request: pollRequest(WORKER, TARGET, "certificate-invariant-failure"),
    })).rejects.toMatchObject({ code: "internal_unavailable" });
    const [invariant] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM worker_lease_rejections WHERE attempt_id = ${malformed.attemptId}`;
    expect.soft(invariant?.count).toBe(0);
  });

  it("uses a readiness signal only for retry latency and never lets newer work leap the canonical head", async () => {
    const { app } = guard();
    await resetRuntimeRows();
    const older = await seedPlacedJob({ ordinal: 960, availableAt: new Date(Date.now() - 120_000) });
    await seedPlacedJob({ ordinal: 961, availableAt: new Date(Date.now() - 60_000) });
    const scheduler = createJobReadyScheduler();
    const signal = (scheduler as unknown as {
      signal?: (input: { organizationId: string; targetId: string }) => boolean;
    }).signal;
    expect.soft(typeof signal).toBe("function");
    if (signal) expect.soft(signal.call(scheduler, { organizationId: ORG, targetId: TARGET })).toBe(true);
    const result = await createJobLeasingService({ appDb: app.db, scheduler }).poll({
      auth: auth("signal-does-not-rank"),
      request: pollRequest(WORKER, TARGET, "signal-does-not-rank"),
    });
    expect.soft(result.outcome).toBe("offer");
    expect.soft(result.outcome === "offer" ? result.body.job.jobId : null).toBe(older.jobId);
  });

  it("drains one exact-target readiness bit only into no-work retry latency", async () => {
    const { app } = guard();
    await resetRuntimeRows();
    const scheduler = createJobReadyScheduler();
    const signal = (scheduler as unknown as {
      signal?: (input: { organizationId: string; targetId: string }) => boolean;
    }).signal;
    expect.soft(typeof signal).toBe("function");
    if (!signal) return;
    expect.soft(signal.call(scheduler, { organizationId: ORG, targetId: TARGET })).toBe(true);
    const service = createJobLeasingService({ appDb: app.db, scheduler });
    const signaled = await service.poll({
      auth: auth("signaled-no-work"),
      request: pollRequest(WORKER, TARGET, "signaled-no-work"),
    });
    const ordinary = await service.poll({
      auth: auth("ordinary-no-work"),
      request: pollRequest(WORKER, TARGET, "ordinary-no-work"),
    });
    expect.soft(signaled).toMatchObject({ outcome: "no_work", retryAfterMs: 100 });
    expect.soft(ordinary).toMatchObject({ outcome: "no_work", retryAfterMs: 750 });
  });

  it("allows concurrent claims in independent workload classes under the explicit provider total", async () => {
    const { app } = guard();
    await resetRuntimeRows();
    const authority = await configureMixedWorkloadAuthority();
    const placement = { profileHash: authority.targetProfileHash, providerHash: authority.providerHash };
    await seedPlacedJob({ ordinal: 40, workloadType: "batch", placement });
    await seedPlacedJob({ ordinal: 41, workloadType: "browser_session", placement });
    const service = createJobLeasingService({ appDb: app.db });
    const baseCapacity = {
      serviceSlots: 0,
      freeCpuMillis: 2_000,
      freeMemoryMiB: 4_096,
      freeDiskMiB: 8_192,
    };
    const [batch, browser] = await Promise.all([
      service.poll({
        auth: auth("concurrent-batch-class", WORKER, TARGET, authority.workerProfileHash),
        request: pollRequestWithCapacity(WORKER, TARGET, "concurrent-batch-class", {
          ...baseCapacity, batchSlots: 1, browserSessionSlots: 0,
        }),
      }),
      service.poll({
        auth: auth("concurrent-browser-class", WORKER, TARGET, authority.workerProfileHash),
        request: pollRequestWithCapacity(WORKER, TARGET, "concurrent-browser-class", {
          ...baseCapacity, batchSlots: 0, browserSessionSlots: 1,
        }),
      }),
    ]);
    expect([batch, browser].filter((result) => result.outcome === "offer")).toHaveLength(2);
  });

  it("scopes shared-platform capacity to each Organization logical profile without a cross-tenant oracle", async () => {
    const { admin, app, operator } = guard();
    await resetRuntimeRows();
    const provider = platformProviderProfile(1);
    const profile = platformRegisteredProfile(provider);
    const profileHash = sha256(canonicalizeJsonV1(profile));
    const helloA = workerHello(PLATFORM_LOGICAL_WORKER_A, PLATFORM_TARGET, 1);
    const helloB = workerHello(PLATFORM_LOGICAL_WORKER_B, PLATFORM_TARGET, 1);
    await admin`UPDATE execution_targets SET status = 'active', device_generation = 1,
      registered_profile = ${profile}, registered_profile_hash = ${profileHash},
      provider_constraint_profile = ${provider}, last_seen_at = clock_timestamp()
      WHERE id = ${PLATFORM_TARGET}`;
    await admin`UPDATE workers SET status = 'active', revoked_at = NULL, device_generation = 1,
      last_seen_at = clock_timestamp() WHERE id = ${PLATFORM_PHYSICAL_WORKER}`;
    await admin`UPDATE workers SET status = 'enrolled', revoked_at = NULL, device_generation = 1,
      profile_hash = ${sha256(JSON.stringify(helloA))}, profile_snapshot = ${helloA}, last_seen_at = NULL
      WHERE id = ${PLATFORM_LOGICAL_WORKER_A}`;
    await admin`UPDATE workers SET status = 'enrolled', revoked_at = NULL, device_generation = 1,
      profile_hash = ${sha256(JSON.stringify(helloB))}, profile_snapshot = ${helloB}, last_seen_at = NULL
      WHERE id = ${PLATFORM_LOGICAL_WORKER_B}`;

    const placement = {
      targetId: PLATFORM_TARGET,
      owner: "managed_cloud",
      targetClass: "managed_cloud",
      targetScope: "platform",
      profileHash,
      providerHash: provider.digest,
    };
    const tenantB = await seedPlacedJob({
      ordinal: 962,
      organizationId: ORG_B,
      companyId: COMPANY_B,
      workerId: PLATFORM_LOGICAL_WORKER_B,
      placement,
    });
    const tenantA = await seedPlacedJob({
      ordinal: 963,
      organizationId: ORG,
      companyId: COMPANY,
      workerId: PLATFORM_LOGICAL_WORKER_A,
      placement,
    });
    const service = createJobLeasingService({ appDb: app.db, operatorDb: operator.db });

    const resultB = await service.poll({
      auth: auth(
        "platform-capacity-b",
        PLATFORM_LOGICAL_WORKER_B,
        PLATFORM_TARGET,
        sha256(JSON.stringify(helloB)),
        ORG_B,
      ),
      request: pollRequest(PLATFORM_LOGICAL_WORKER_B, PLATFORM_TARGET, "platform-capacity-b", 1),
    });
    expect.soft(resultB.outcome).toBe("offer");
    expect.soft(resultB.outcome === "offer" ? resultB.body.job.jobId : null).toBe(tenantB.jobId);

    // Provider maxConcurrentOperations=1 is a logical-profile clamp. Tenant B's
    // live offer on the same physical target must neither consume A's slot nor
    // reveal B's job/capacity through A's tenant transaction.
    const resultA = await service.poll({
      auth: auth(
        "platform-capacity-a",
        PLATFORM_LOGICAL_WORKER_A,
        PLATFORM_TARGET,
        sha256(JSON.stringify(helloA)),
        ORG,
      ),
      request: pollRequest(PLATFORM_LOGICAL_WORKER_A, PLATFORM_TARGET, "platform-capacity-a", 1),
    });
    expect.soft(resultA.outcome).toBe("offer");
    expect.soft(resultA.outcome === "offer" ? resultA.body.job.jobId : null).toBe(tenantA.jobId);

    const [leases] = await admin<{ orgA: number; orgB: number }[]>`SELECT
      count(*) FILTER (WHERE organization_id = ${ORG})::int AS "orgA",
      count(*) FILTER (WHERE organization_id = ${ORG_B})::int AS "orgB"
      FROM leases WHERE target_id = ${PLATFORM_TARGET}`;
    expect.soft(leases).toEqual({ orgA: 1, orgB: 1 });
  });

  it("fails closed for stale placement, target, worker, generation, and profile/provider authority", async () => {
    const { admin, app } = guard();
    const mutations: Array<{ name: string; mutate(jobId: string, attemptId: string): Promise<unknown> }> = [
      { name: "shadow", mutate: async (_jobId, attemptId) => admin`UPDATE job_attempts SET
          placement_mode = 'shadow', placement_lease_eligible = false WHERE id = ${attemptId}` },
      { name: "target offline", mutate: async () => admin`UPDATE execution_targets SET status = 'offline' WHERE id = ${TARGET}` },
      { name: "worker draining", mutate: async () => admin`UPDATE workers SET status = 'draining' WHERE id = ${WORKER}` },
      { name: "generation", mutate: async () => admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET}` },
      { name: "placement target profile", mutate: async (_jobId, attemptId) => admin`UPDATE job_attempts SET
          placement_profile_hash = ${"7".repeat(64)} WHERE id = ${attemptId}` },
      { name: "placement provider profile", mutate: async (_jobId, attemptId) => admin`UPDATE job_attempts SET
          placement_provider_constraint_hash = ${"8".repeat(64)} WHERE id = ${attemptId}` },
    ];
    for (const [index, mutation] of mutations.entries()) {
      await resetRuntimeRows();
      const seeded = await seedPlacedJob({ ordinal: 100 + index });
      await mutation.mutate(seeded.jobId, seeded.attemptId);
      const service = createJobLeasingService({ appDb: app.db });
      try {
        const result = await service.poll({
          auth: auth(`poll-stale-${index}`),
          request: pollRequest(WORKER, TARGET, `poll-stale-${index}`),
        });
        expect(result.outcome, mutation.name).not.toBe("offer");
      } catch (error) {
        expect(error, mutation.name).toBeInstanceOf(JobLeasingError);
        expect((error as JobLeasingError).code, mutation.name).toMatch(/^(unauthorized|target_revoked)$/);
      }
      const [count] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM leases`;
      expect(count?.count, mutation.name).toBe(0);
    }
  });

  it("settles public poll against target-first revoke in both valid orders with complete side-effect snapshots", async () => {
    const { admin, app } = guard();
    const snapshot = async (attemptId: string, jobId: string, outboxId: string) => {
      const [row] = await admin<{
        jobStatus: string; attemptStatus: string; leases: number; certificates: number;
        receipts: number; replays: number; outboxStatus: string; workerLastSeen: Date | null;
      }[]>`SELECT
        (SELECT status FROM jobs WHERE id = ${jobId}) AS "jobStatus",
        (SELECT status FROM job_attempts WHERE id = ${attemptId}) AS "attemptStatus",
        (SELECT count(*)::int FROM leases WHERE attempt_id = ${attemptId}) AS leases,
        (SELECT count(*)::int FROM worker_lease_rejections WHERE attempt_id = ${attemptId}) AS certificates,
        (SELECT count(*)::int FROM worker_operation_receipts WHERE attempt_id = ${attemptId}) AS receipts,
        (SELECT count(*)::int FROM worker_proof_replays WHERE device_thumbprint = ${THUMBPRINT}) AS replays,
        (SELECT status FROM job_outbox WHERE id = ${outboxId}) AS "outboxStatus",
        (SELECT last_seen_at FROM workers WHERE id = ${WORKER}) AS "workerLastSeen"`;
      return row!;
    };
    const revoke = async (release: Promise<void>, entered: () => void) => admin.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '750ms'`;
      await tx`SELECT id FROM execution_targets WHERE id = ${TARGET} FOR UPDATE`;
      entered();
      await release;
      await tx`SELECT id FROM workers WHERE id = ${WORKER} AND execution_target_id = ${TARGET} FOR UPDATE`;
      await tx`UPDATE execution_targets SET status = 'disabled', updated_at = clock_timestamp() WHERE id = ${TARGET}`;
      return "revoked" as const;
    });

    // Revoke wins: public poll must wait at target authority before any liveness,
    // certificate, claim, attempt, lease, receipt, replay, or outbox mutation.
    await resetRuntimeRows();
    const revokeWinsSeed = await seedPlacedJob({ ordinal: 7_700 });
    const beforeRevokeWins = await snapshot(
      revokeWinsSeed.attemptId, revokeWinsSeed.jobId, revokeWinsSeed.outboxId,
    );
    let revokeLocked!: () => void;
    const revokeHasTarget = new Promise<void>((resolve) => { revokeLocked = resolve; });
    let releaseRevoke!: () => void;
    const revokeMayCommit = new Promise<void>((resolve) => { releaseRevoke = resolve; });
    const revokeFirst = revoke(revokeMayCommit, revokeLocked);
    await revokeHasTarget;
    const service = createJobLeasingService({ appDb: app.db });
    let revokeWinsError: unknown = null;
    const revokeWinsPoll = service.poll({
      auth: auth("revoke-wins-public-poll"),
      request: pollRequest(WORKER, TARGET, "revoke-wins-public-poll"),
    }).catch((error) => { revokeWinsError = error; return null; });
    await waitUntil("public poll waits on revoke target lock", async () => {
      const [row] = await admin<{ waiting: boolean }[]>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE usename = 'aoa_app' AND wait_event_type = 'Lock'
      ) AS waiting`;
      return row?.waiting === true;
    });
    releaseRevoke();
    const revokeWinsSettled = await Promise.allSettled([revokeFirst, revokeWinsPoll]);
    expect.soft(revokeWinsSettled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect.soft(revokeWinsSettled[0]).toEqual({ status: "fulfilled", value: "revoked" });
    expect.soft(revokeWinsSettled[1]).toEqual({ status: "fulfilled", value: null });
    expect.soft(revokeWinsError).toMatchObject({ code: "target_revoked" });
    expect.soft(await snapshot(
      revokeWinsSeed.attemptId, revokeWinsSeed.jobId, revokeWinsSeed.outboxId,
    )).toEqual({ ...beforeRevokeWins, workerLastSeen: beforeRevokeWins.workerLastSeen });

    // Poll wins: an offer-transition trigger blocks only after the public poll
    // has crossed authority and reached its real attempt mutation.
    await resetRuntimeRows();
    const pollWinsSeed = await seedPlacedJob({ ordinal: 7_701 });
    const blocker = postgres(adminUrl, { max: 1 });
    const advisoryKey = 3_350_033;
    await blocker`SELECT pg_advisory_lock(${advisoryKey})`;
    await admin.unsafe(`CREATE SEQUENCE job003_public_poll_wins_seq START WITH 1`);
    await admin.unsafe(`GRANT USAGE, SELECT ON SEQUENCE job003_public_poll_wins_seq TO aoa_app`);
    await admin.unsafe(`CREATE FUNCTION job003_public_poll_wins_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM nextval('job003_public_poll_wins_seq'::regclass);
        PERFORM pg_advisory_lock(${advisoryKey});
        PERFORM pg_advisory_unlock(${advisoryKey});
        RETURN NEW;
      END $$`);
    await admin.unsafe(`CREATE TRIGGER job003_public_poll_wins_trigger
      BEFORE UPDATE OF status ON job_attempts FOR EACH ROW
      WHEN (OLD.id = '${pollWinsSeed.attemptId}'::uuid AND NEW.status = 'offered')
      EXECUTE FUNCTION job003_public_poll_wins_fn()`);
    try {
      const pollFirst = service.poll({
        auth: auth("poll-wins-public-poll"),
        request: pollRequest(WORKER, TARGET, "poll-wins-public-poll"),
      });
      await waitUntil("public poll reaches offer mutation", async () => {
        const [row] = await admin<{ reached: boolean }[]>`
          SELECT is_called AS reached FROM job003_public_poll_wins_seq`;
        return row?.reached === true;
      });
      let pollWinsRevokeEntered!: () => void;
      const pollWinsRevokeHasTarget = new Promise<void>((resolve) => { pollWinsRevokeEntered = resolve; });
      const pollWinsRevoke = revoke(Promise.resolve(), pollWinsRevokeEntered);
      await waitUntil("revoke waits behind public poll", async () => {
        const [row] = await admin<{ waiting: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE usename = 'test' AND wait_event_type = 'Lock' AND query LIKE '%execution_targets%FOR UPDATE%'
        ) AS waiting`;
        return row?.waiting === true;
      });
      await blocker`SELECT pg_advisory_unlock(${advisoryKey})`;
      const [pollResult, revokeResult] = await Promise.all([pollFirst, pollWinsRevoke]);
      expect.soft(pollResult.outcome).toBe("offer");
      expect.soft(revokeResult).toBe("revoked");
      const state = await snapshot(pollWinsSeed.attemptId, pollWinsSeed.jobId, pollWinsSeed.outboxId);
      // The offer transitions the ATTEMPT to 'offered' and mints the lease; the JOB row stays
      // 'queued' (jobs_status_check forbids 'offered', and offerLease never writes jobs.status). The
      // accepted proof leaves exactly one anti-replay guard row for this device thumbprint.
      expect.soft(state).toMatchObject({
        jobStatus: "queued", attemptStatus: "offered", leases: 1,
        certificates: 0, receipts: 0, replays: 1, outboxStatus: "pending",
      });
      expect.soft(state.workerLastSeen).not.toBeNull();
    } finally {
      await blocker`SELECT pg_advisory_unlock_all()`;
      await blocker.end();
      await admin.unsafe(`DROP TRIGGER IF EXISTS job003_public_poll_wins_trigger ON job_attempts`);
      await admin.unsafe(`DROP FUNCTION IF EXISTS job003_public_poll_wins_fn()`);
      await admin.unsafe(`DROP SEQUENCE IF EXISTS job003_public_poll_wins_seq`);
    }
  }, 60_000);

  it("keeps readiness signals attempt-free, coalesced, and recovers a crashed claim", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const seeded = await seedPlacedJob({ ordinal: 200 });
    const scheduler = createJobReadyScheduler({ maxOrganizationShards: 32 });
    const exactScheduler = scheduler as unknown as {
      signal?: (input: { organizationId: string; targetId: string }) => boolean;
      consume?: (organizationId: string, targetId: string) => boolean;
      size(): { organizations: number; targets: number; signals: number };
    };
    expect.soft(typeof exactScheduler.signal).toBe("function");
    expect.soft(typeof exactScheduler.consume).toBe("function");
    if (!exactScheduler.signal || !exactScheduler.consume) return;
    let crashOnce = true;
    const worker = createJobOutboxWorker({
      appDb: app.db,
      scheduler,
      listAdmittedOrganizationIds: async () => [ORG, ORG],
      visibilityTimeoutMs: 1,
      publishHint: async (signal) => {
        expect.soft(Object.keys(signal).sort()).toEqual(["organizationId", "targetId"]);
        if (crashOnce) {
          crashOnce = false;
          throw new Error("simulated_after_commit_crash");
        }
        exactScheduler.signal!(signal);
      },
    });
    await expect(worker.tick()).rejects.toThrow("simulated_after_commit_crash");
    const [claimed] = await admin<{ status: string }[]>`SELECT status FROM job_outbox WHERE id = ${seeded.outboxId}`;
    expect(claimed?.status).toBe("claimed");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, delivered: 1 });
    expect.soft(exactScheduler.size()).toEqual({ organizations: 1, targets: 1, signals: 1 });
    expect.soft(exactScheduler.consume(ORG, TARGET)).toBe(true);
    expect.soft(exactScheduler.consume(ORG, TARGET)).toBe(false);
    const [delivered] = await admin<{ status: string }[]>`SELECT status FROM job_outbox WHERE id = ${seeded.outboxId}`;
    expect(delivered?.status).toBe("delivered");
  });

  it("uses fresh PostgreSQL statement time across the JavaScript millisecond boundary", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const ready = await seedPlacedJob({ ordinal: 213 });
    const future = await seedPlacedJob({ ordinal: 214 });
    const [sampled] = await admin<{ callerNow: Date }[]>`
      SELECT date_trunc('milliseconds', clock_timestamp()) AS "callerNow"`;
    if (!sampled) throw new Error("expected a sampled database timestamp");
    await admin`UPDATE jobs SET available_at = ${sampled.callerNow}::timestamptz + interval '500 microseconds'
      WHERE id = ${ready.jobId}`;
    await admin`UPDATE job_outbox SET available_at = ${sampled.callerNow}::timestamptz + interval '500 microseconds'
      WHERE id = ${ready.outboxId}`;
    await admin`UPDATE jobs SET available_at = clock_timestamp() + interval '1 minute'
      WHERE id = ${future.jobId}`;
    await admin`UPDATE job_outbox SET available_at = clock_timestamp() + interval '1 minute'
      WHERE id = ${future.outboxId}`;
    await admin`SELECT pg_sleep(0.002)`;
    const claimed = await runInTenant(app.db, ORG, async (repos) => {
      return repos.jobControl.claimReadyOutbox({
        claimToken: crypto.randomUUID(),
        now: sampled.callerNow,
        staleBefore: new Date(sampled.callerNow.getTime() - 60_000),
        limit: 32,
      });
    });
    expect(claimed).toEqual([{
      id: ready.outboxId,
      organizationId: ORG,
      targetId: TARGET,
      attemptId: ready.attemptId,
    }]);
  });

  it("enforces the immutable tick deadline inside real PostgreSQL cleanup and delivery statements", async () => {
    const { admin, app } = guard();
    const scheduler = createJobReadyScheduler();
    const installSleepOracle = async (input: {
      stem: "cleanup" | "delivery";
      table: "worker_lease_rejections" | "job_outbox";
      event: "DELETE" | "UPDATE OF status";
      when: string;
    }) => {
      const sequence = `job003_deadline_${input.stem}_seq`;
      const fn = `job003_deadline_${input.stem}_fn`;
      const trigger = `job003_deadline_${input.stem}_trigger`;
      await admin.unsafe(`CREATE SEQUENCE ${sequence} START WITH 1`);
      await admin.unsafe(`GRANT USAGE, SELECT ON SEQUENCE ${sequence} TO aoa_app`);
      await admin.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM nextval('${sequence}'::regclass);
          PERFORM pg_sleep(0.10);
          RETURN OLD;
        END $$`);
      await admin.unsafe(`CREATE TRIGGER ${trigger} BEFORE ${input.event} ON ${input.table}
        FOR EACH ROW WHEN (${input.when}) EXECUTE FUNCTION ${fn}()`);
      return {
        async calls(): Promise<number> {
          const [row] = await admin.unsafe<Array<{ calls: number }>>(
            `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS calls FROM ${sequence}`,
          );
          return Number(row?.calls ?? 0);
        },
        async drop(): Promise<void> {
          await admin.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON ${input.table}`);
          await admin.unsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
          await admin.unsafe(`DROP SEQUENCE IF EXISTS ${sequence}`);
        },
      };
    };

    await resetRuntimeRows();
    const obsolete = await seedLeaseRejectionCertificate({ ordinal: 7_090 });
    await admin`UPDATE job_attempts SET status = 'leased' WHERE id = ${obsolete.attemptId}`;
    const cleanupOracle = await installSleepOracle({
      stem: "cleanup",
      table: "worker_lease_rejections",
      event: "DELETE",
      when: `OLD.attempt_id = '${obsolete.attemptId}'::uuid`,
    });
    try {
      const cleanupWorker = (createJobOutboxWorker as unknown as (input: Record<string, unknown>) => {
        tick(): Promise<Record<string, number>>;
      })({
        appDb: app.db,
        scheduler,
        listAdmittedOrganizationIds: async () => [ORG],
        tickBudgetMs: 50,
        cleanupLimit: 256,
        cleanupCardinalityLimit: 4_096,
      });
      const cleanupResult = await cleanupWorker.tick();
      expect.soft(cleanupResult).toMatchObject({ claimed: 0, delivered: 0, cleaned: 0 });
      expect.soft(await cleanupOracle.calls()).toBe(1);
      const [certificate] = await admin<{ count: number }[]>`
        SELECT count(*)::int AS count FROM worker_lease_rejections WHERE attempt_id = ${obsolete.attemptId}`;
      expect.soft(certificate?.count).toBe(1);
    } finally {
      await cleanupOracle.drop();
    }

    await resetRuntimeRows();
    const deliverable = await seedPlacedJob({ ordinal: 7_091 });
    const deliveryOracle = await installSleepOracle({
      stem: "delivery",
      table: "job_outbox",
      event: "UPDATE OF status",
      when: `OLD.id = '${deliverable.outboxId}'::uuid AND NEW.status = 'delivered'`,
    });
    try {
      const deliveryWorker = (createJobOutboxWorker as unknown as (input: Record<string, unknown>) => {
        tick(): Promise<Record<string, number>>;
      })({
        appDb: app.db,
        scheduler: createJobReadyScheduler(),
        listAdmittedOrganizationIds: async () => [ORG],
        publishHint: async () => {},
        tickBudgetMs: 50,
        cleanupLimit: 256,
        cleanupCardinalityLimit: 4_096,
      });
      let deliveryError: unknown = null;
      try {
        await deliveryWorker.tick();
      } catch (caught) {
        deliveryError = caught;
      }
      expect((deliveryError as { code?: string; cause?: { code?: string } } | null)?.code
        ?? (deliveryError as { cause?: { code?: string } } | null)?.cause?.code).toBe("57014");
      expect(await deliveryOracle.calls()).toBe(1);
      const [outbox] = await admin<{ status: string }[]>`
        SELECT status FROM job_outbox WHERE id = ${deliverable.outboxId}`;
      expect(outbox?.status).toBe("claimed");
    } finally {
      await deliveryOracle.drop();
    }
  }, 60_000);

  it("publishes only current lease-eligible placement signals without changing canonical claim order", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const unplaced = await seedPlacedJob({ ordinal: 210 });
    await admin`UPDATE job_attempts SET
      placement_disposition = NULL, placement_owner = NULL, placement_target_id = NULL,
      placement_target_class = NULL, placement_target_scope = NULL,
      placement_target_generation = NULL, placement_profile_hash = NULL,
      placement_provider_constraint_hash = NULL, placement_fallback_disposition = NULL,
      placement_reason_code = NULL, placement_mode = NULL, placement_lease_eligible = NULL,
      placement_input_digest = NULL, placement_policy_digest = NULL, placement_decided_at = NULL
      WHERE id = ${unplaced.attemptId}`;
    const older = await seedPlacedJob({ ordinal: 211, availableAt: new Date(Date.now() - 120_000) });
    const newer = await seedPlacedJob({ ordinal: 212, availableAt: new Date(Date.now() - 60_000) });
    const scheduler = createJobReadyScheduler();
    const exactScheduler = scheduler as unknown as {
      signal?: (input: { organizationId: string; targetId: string }) => boolean;
    };
    expect.soft(typeof exactScheduler.signal).toBe("function");
    if (!exactScheduler.signal) return;
    const published: Array<{ organizationId: string; targetId: string }> = [];
    const worker = createJobOutboxWorker({
      appDb: app.db,
      scheduler,
      listAdmittedOrganizationIds: async () => [ORG],
      publishHint: async (signal) => {
        expect.soft(Object.keys(signal).sort()).toEqual(["organizationId", "targetId"]);
        published.push(signal);
        if (!exactScheduler.signal!(signal)) throw new Error("job_ready_scheduler_full");
      },
    });
    await worker.tick();
    expect.soft(published).toEqual([
      { organizationId: ORG, targetId: TARGET },
      { organizationId: ORG, targetId: TARGET },
    ]);
    const leasing = createJobLeasingService({
      appDb: app.db,
      scheduler,
    } as unknown as Parameters<typeof createJobLeasingService>[0]);
    const first = await leasing.poll({
      auth: auth("poll-signal-global-head"),
      request: pollRequest(WORKER, TARGET, "poll-signal-global-head"),
    });
    expect(first.outcome).toBe("offer");
    if (first.outcome === "offer") expect.soft(first.body.job.jobId).toBe(older.jobId);

    const second = await leasing.poll({
      auth: auth("poll-after-signal"),
      request: pollRequest(WORKER, TARGET, "poll-after-signal"),
    });
    expect(second.outcome).toBe("offer");
    if (second.outcome === "offer") expect.soft(second.body.job.jobId).toBe(newer.jobId);
  });

  // ★ E3-F034, the adjacent case. This is the SAME hazard as the 100-claimer poll race one
  // test-shape over: 100 concurrent `ack()`s, every one of which takes the same
  // `execution_targets` and `workers` rows FOR UPDATE in `lockWorkerLeaseAuthority` and holds
  // them to COMMIT. The finding named only the poll test, because that is the one CI was
  // observed failing — and closing a defect on the case that motivated it while leaving the
  // identical adjacent case open is this programme's own named recurring mistake (§1.9.5).
  it("activates exactly once across 100 concurrent ACKs and semantically replays after restart", async () => {
    const { admin, app } = guard();
    await resetRuntimeRows();
    const contended = createContendedAppDb();
    try {
      await assertContendedLockBudget(contended);
      const { seeded, offer, service } = await offerPlacedJob({
        ordinal: 300,
        service: createJobLeasingService({ appDb: contended.db }),
      });
      const idempotencyKey = crypto.randomUUID();
      const first = ackRequest(offer, idempotencyKey);
      const results = await settleAllClaimers(
        Array.from({ length: CONTENDED_CLAIMERS }, (_, index) => service.ack({
          auth: auth(`ack-race-${index}`),
          request: {
            ...first,
            correlationId: crypto.randomUUID(),
            issuedAt: new Date().toISOString(),
            nonce: `ack-race-${index}`,
          },
        })),
        `${CONTENDED_CLAIMERS}-claimer idempotent ACK race`,
      );
      expect(results.every((result) => result.outcome === "acknowledged")).toBe(true);
      expect(new Set(results.map((result) => `${result.leaseId}:${result.expiresAt}`))).toEqual(
        new Set([`${offer.leaseId}:${offer.expiresAt}`]),
      );
      const [state] = await admin<{
        leaseStatus: string;
        attemptStatus: string;
        jobStatus: string;
        activated: boolean;
        receipts: number;
      }[]>`SELECT
        (SELECT status FROM leases WHERE id = ${offer.leaseId}) AS "leaseStatus",
        (SELECT status FROM job_attempts WHERE id = ${seeded.attemptId}) AS "attemptStatus",
        (SELECT status FROM jobs WHERE id = ${seeded.jobId}) AS "jobStatus",
        (SELECT activated_at IS NOT NULL FROM leases WHERE id = ${offer.leaseId}) AS activated,
        (SELECT count(*)::int FROM worker_operation_receipts WHERE lease_id = ${offer.leaseId}) AS receipts`;
      expect(state).toEqual({
        leaseStatus: "active",
        attemptStatus: "leased",
        jobStatus: "queued",
        activated: true,
        receipts: 1,
      });

      const restarted = createJobLeasingService({ appDb: app.db });
      const replay = await restarted.ack({
        auth: auth("ack-restart-replay"),
        request: { ...first, correlationId: crypto.randomUUID(), nonce: "ack-restart-replay" },
      });
      expect(replay).toMatchObject({ outcome: "acknowledged", leaseId: offer.leaseId, expiresAt: offer.expiresAt });

      const changed = ackRequest(offer, idempotencyKey, {
        ackedAt: new Date(Date.parse(first.body.ackedAt) + 1_000).toISOString(),
      });
      await expect(restarted.ack({ auth: auth("ack-changed-digest"), request: changed }))
        .rejects.toMatchObject({ code: "malformed" });
      await expect(restarted.ack({
        auth: auth("ack-restart-replay"),
        request: ackRequest(offer, crypto.randomUUID()),
      })).rejects.toMatchObject({ code: "unauthorized" });
    } finally {
      await contended.close({ timeoutSeconds: 5 });
    }
  }, 60_000);

  it("never replays an exact expired ACK receipt hidden behind more than 100 older rows", async () => {
    const { admin } = guard();
    await resetRuntimeRows();
    const { offer, service } = await offerPlacedJob({ ordinal: 305 });
    const idempotencyKey = crypto.randomUUID();
    const request = ackRequest(offer, idempotencyKey);
    await expect(service.ack({ auth: auth("ack-expiry-first"), request }))
      .resolves.toMatchObject({ outcome: "acknowledged" });

    await admin`UPDATE worker_operation_receipts
      SET created_at = clock_timestamp() - interval '3 hours',
          expires_at = clock_timestamp() - interval '1 hour'
      WHERE lease_id = ${offer.leaseId} AND idempotency_key = ${idempotencyKey}`;
    await admin`INSERT INTO worker_operation_receipts
      (organization_id, company_id, job_id, attempt_id, lease_id, operation, worker_id,
       target_id, target_authority_key, target_generation, profile_hash, idempotency_key,
       semantic_digest, outcome, expires_at, created_at)
      SELECT organization_id, company_id, job_id, attempt_id, lease_id, operation, worker_id,
        target_id, target_authority_key, target_generation, profile_hash,
        md5('job003-expired-' || series::text)::uuid, semantic_digest, outcome,
        clock_timestamp() - interval '2 hours', clock_timestamp() - interval '3 hours'
      FROM worker_operation_receipts receipt
      CROSS JOIN generate_series(1, 101) series
      WHERE receipt.lease_id = ${offer.leaseId} AND receipt.idempotency_key = ${idempotencyKey}`;

    await expect(service.ack({
      auth: auth("ack-expiry-retry-fresh-proof"),
      request: { ...request, correlationId: crypto.randomUUID(), nonce: "ack-expiry-retry" },
    })).rejects.toMatchObject({ code: "attempt_terminal" });
  });

  it("uses fresh DB time so before-deadline ACK succeeds and late or crossing ACK changes nothing", async () => {
    const { admin } = guard();
    await resetRuntimeRows();
    const before = await offerPlacedJob({ ordinal: 310 });
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() + interval '1 second'
      WHERE id = ${before.offer.leaseId}`;
    await expect(before.service.ack({
      auth: auth("ack-before-deadline"),
      request: ackRequest(before.offer),
    })).resolves.toMatchObject({ outcome: "acknowledged", leaseId: before.offer.leaseId });

    await resetRuntimeRows();
    const late = await offerPlacedJob({ ordinal: 311 });
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() - interval '1 millisecond'
      WHERE id = ${late.offer.leaseId}`;
    await expect(late.service.ack({
      auth: auth("ack-after-deadline"),
      request: ackRequest(late.offer),
    })).rejects.toMatchObject({ code: "stale_fence" });
    await expectOfferUnchanged(late.seeded.attemptId);

    await resetRuntimeRows();
    const crossing = await offerPlacedJob({ ordinal: 312 });
    await admin.unsafe(`CREATE OR REPLACE FUNCTION job003_sleep_ack_proof() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.proof_id = 'ack-crossing-deadline' THEN PERFORM pg_sleep(0.10); END IF;
        RETURN NEW;
      END $$`);
    await admin.unsafe(`CREATE TRIGGER job003_sleep_ack_proof_trigger BEFORE INSERT ON worker_proof_replays
      FOR EACH ROW EXECUTE FUNCTION job003_sleep_ack_proof()`);
    try {
      await admin`UPDATE leases SET ack_deadline = clock_timestamp() + interval '50 milliseconds'
        WHERE id = ${crossing.offer.leaseId}`;
      await expect(crossing.service.ack({
        auth: auth("ack-crossing-deadline"),
        request: ackRequest(crossing.offer),
      })).rejects.toMatchObject({ code: "stale_fence" });
    } finally {
      await admin.unsafe("DROP TRIGGER IF EXISTS job003_sleep_ack_proof_trigger ON worker_proof_replays");
      await admin.unsafe("DROP FUNCTION IF EXISTS job003_sleep_ack_proof()");
    }
    await expectOfferUnchanged(crossing.seeded.attemptId);
  });

  it("rejects wrong worker, target, fence, lease, and revoked authority without disclosing or mutating", async () => {
    const { admin } = guard();
    await resetRuntimeRows();
    const offered = await offerPlacedJob({ ordinal: 320 });
    const cases = [
      {
        proof: "ack-wrong-worker",
        auth: auth("ack-wrong-worker"),
        request: ackRequest(offered.offer, undefined, { workerId: OTHER_WORKER }),
      },
      {
        proof: "ack-wrong-target",
        auth: auth("ack-wrong-target", OTHER_WORKER, OTHER_TARGET),
        request: ackRequest(offered.offer),
      },
      {
        proof: "ack-wrong-fence",
        auth: auth("ack-wrong-fence"),
        request: ackRequest(offered.offer, undefined, { fenceToken: "x".repeat(43) }),
      },
      {
        proof: "ack-wrong-lease",
        auth: auth("ack-wrong-lease"),
        request: ackRequest(offered.offer, undefined, { leaseId: crypto.randomUUID() }),
      },
    ];
    for (const candidate of cases) {
      await expect(offered.service.ack({ auth: candidate.auth, request: candidate.request }))
        .rejects.toMatchObject({ code: expect.stringMatching(/^(unauthorized|target_revoked|stale_fence)$/) });
      await expectOfferUnchanged(offered.seeded.attemptId);
    }
    await admin`UPDATE execution_targets SET status = 'revoked' WHERE id = ${TARGET}`;
    await expect(offered.service.ack({
      auth: auth("ack-revoked-target"),
      request: ackRequest(offered.offer),
    })).rejects.toMatchObject({ code: "target_revoked" });
    await expectOfferUnchanged(offered.seeded.attemptId);
  });

  it("rolls back lease, attempt, receipt, and proof when any ACK statement fails", async () => {
    const { admin } = guard();
    const stages = [
      { table: "leases", event: "UPDATE", when: "WHEN (NEW.status = 'active')" },
      { table: "job_attempts", event: "UPDATE", when: "WHEN (NEW.status = 'leased')" },
      { table: "worker_operation_receipts", event: "INSERT", when: "" },
    ] as const;
    for (const [index, stage] of stages.entries()) {
      await resetRuntimeRows();
      const offered = await offerPlacedJob({ ordinal: 330 + index });
      const functionName = `job003_fail_ack_${index}`;
      const triggerName = `job003_fail_ack_trigger_${index}`;
      await admin.unsafe(`CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'job003 forced ack rollback'; END $$`);
      await admin.unsafe(`CREATE TRIGGER ${triggerName} BEFORE ${stage.event} ON ${stage.table}
        FOR EACH ROW ${stage.when} EXECUTE FUNCTION ${functionName}()`);
      try {
        await expect(offered.service.ack({
          auth: auth(`ack-rollback-${index}`),
          request: ackRequest(offered.offer),
        })).rejects.toThrow();
      } finally {
        await admin.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON ${stage.table}`);
        await admin.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
      }
      await expectOfferUnchanged(offered.seeded.attemptId);
      const [proof] = await admin<{ count: number }[]>`SELECT count(*)::int AS count
        FROM worker_proof_replays WHERE proof_id = ${`ack-rollback-${index}`}`;
      expect(proof?.count).toBe(0);
    }
  });
});
