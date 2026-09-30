/**
 * DE-03, audit clause — a REPLAYED worker credential is durably distinguishable
 * from a request that never happened, and ATTRIBUTABLE to the organization whose
 * session artefact was replayed.
 *
 * ★ WHAT THIS FILE PROVES, and ONLY that. `distributed-execution-threat-controls.json`
 * DE-03 asserts "enrollment, session issue, and replay-rejection are audited".
 * That is a THREE-TERM CONJUNCTION and only the third term is wired. Enrollment
 * and session issue still write nothing, so DE-03 does NOT close on this file and
 * stays in `E0-F010`'s open cohort. Nothing below asserts either of the other two.
 *
 * ★ WHAT WAS TRUE BEFORE. `recordProof` (`worker-enrollment.ts`, backed by the
 * real `worker_proof_replays_device_proof_uq` constraint) returns `false` for a
 * spent (device thumbprint, proof id) pair, and NINE production call sites turn
 * that into a refusal. Every one of them then threw out of `runInTenant` and left
 * NOTHING: no row, no metric, no log line. A captured worker session replayed a
 * thousand times was indistinguishable from silence — the exact failure DE-03's
 * audit clause names.
 *
 * ★ WHY IT COULD NOT BE FIXED UNTIL NOW, and what changed. Those refusals hold a
 * TOKEN-ATTESTED organization and NO company: the lease — the only row carrying
 * `company_id` — has not been looked at when `recordProof` runs. `activity_log.company_id`
 * was `NOT NULL`, so the row was unwritable, not merely unwritten. `E0-F013`
 * Decision 2 was ruled option (a2) and shipped (migration `0274`): `company_id` is
 * nullable inside the reserved `security.denied.` namespace, guarded by a partial
 * CHECK, and a nullable `organization_id` sits beside it. The storage blocker is
 * gone; this file proves the wiring that replaced it.
 *
 * ★ SEVEN OF THE NINE, NOT NINE. TWO sites stay DOUBLY NULL and are deliberately
 * NOT wired and NOT claimed:
 *   - `server/src/services/worker-enrollment.ts:315`, where
 *     `authoritativeOrganizationId` is typed `string | null`;
 *   - `server/src/middleware/worker-session-auth.ts:151`, whose `:183-185` branch
 *     passes an explicit `null` for a platform-scope worker.
 * A row attributable to neither axis is a different decision from a row
 * attributable to one, and this unit does not take it. No arm here touches them.
 *
 * ★ FIVE OF THE SEVEN ARE WIRED AND PROVEN HERE; ONE MORE IS PROVEN ELSEWHERE; ONE
 * IS PINNED AS UNWIRED. `job-leasing.ts:816` (ack) could NOT be wired -- the frozen
 * JOB-003 ack-flow contract leaves no drain point outside the transaction, and the
 * arm below PINS it as recording nothing rather than quietly dropping it from the
 * count. The one proven elsewhere —
 * `worker-fence-context.ts:68`, the `recordProof` refusal inside
 * `resolveWorkerFenceContext` — is proven in
 * `de-06-artifact-denial-audit.integration.test.ts` ("THE `:86` REPLAY REFUSAL IS
 * RECORDED"), because that site serves BOTH crossings and its row names both.
 * It is not duplicated here.
 *
 * ★ THE REPLAY IS REAL, NOT CONSTRUCTED. Each arm first runs a SUCCEEDING
 * operation with a proof id, which COMMITS the `worker_proof_replays` row, and
 * then presents the SAME proof id to the site under test. The refusal is produced
 * by the real unique constraint inside the real service; nothing here inserts a
 * denial or a replay row by hand.
 *
 * ★ THE THROW IS ASSERTED FIRST, EVERY TIME. `rejects.toBeInstanceOf(JobLeasingError)`
 * runs before the row assertion. It is the reachability control: without it, a
 * fixture that stopped reaching the branch would pass on a row some other arm
 * left behind.
 *
 * Real Postgres (embedded-postgres + the committed migration chain), the real
 * `aoa_app` non-owner role, the real leasing / event-ingest / renewal /
 * control-ack / quarantine services. Nothing is stubbed but the object store.
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  canonicalEventDigestInputV1,
  canonicalProviderConstraintProfileDigestInputV1,
  canonicalizeJsonV1,
  expectedQuarantineObjectPrefix,
  type EventUploadOperationRequestV1,
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type LeaseRenewOperationRequestV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type QuarantineGrantOperationRequestV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import {
  createJobLeasingService,
  JobLeasingError,
  type VerifiedWorkerOperation,
} from "../services/job-leasing.js";
import { createJobEventIngestService } from "../services/job-events.js";
import { createJobLeaseRenewalService } from "../services/job-fencing.js";
import {
  createJobControlAckService,
  type ControlAckOperationRequestV1,
} from "../services/job-control-ack.js";
import { createQuarantineGrantService } from "../services/quarantine-grant.js";
import type { StorageProvider, HeadObjectResult, PresignResult } from "../storage/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "d3000000-0000-4000-8000-000000000001";
const COMPANY = "d3000000-0000-4000-8000-000000000002";
const TARGET = "d3000000-0000-4000-8000-000000000003";
const WORKER = "d3000000-0000-4000-8000-000000000005";
const PASSWORD = "de-003-role-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;
const REPLAY_ACTION = "security.denied.worker_proof_replay";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "de-003-provider",
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
    agentVersion: "de-003-integration",
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

function renewRequest(offer: LeaseOfferV1): LeaseRenewOperationRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `rn-${crypto.randomUUID()}`,
    audience: "worker_run",
    idempotencyKey: crypto.randomUUID(),
    body: {
      protocolVersion: 1,
      workerId: WORKER,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      observedAt: new Date().toISOString(),
      extensions: [],
    },
  } as unknown as LeaseRenewOperationRequestV1;
}

function logEvent(offer: LeaseOfferV1, seq: number): Record<string, unknown> {
  const base = {
    protocolVersion: 1,
    eventId: crypto.randomUUID(),
    organizationId: ORG,
    companyId: COMPANY,
    workerId: WORKER,
    jobId: offer.job.jobId,
    attempt: offer.job.attempt,
    leaseId: offer.leaseId,
    fenceToken: offer.fenceToken,
    seq,
    occurredAt: new Date().toISOString(),
    extensions: [] as unknown[],
    eventType: "log",
    payload: { stream: "stdout", level: "info", message: `line ${seq}` },
  };
  return { ...base, eventDigest: sha256(canonicalEventDigestInputV1(base)) };
}

function batchRequest(offer: LeaseOfferV1, seq: number): EventUploadOperationRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `ev-${crypto.randomUUID()}`,
    audience: "worker_run",
    idempotencyKey: crypto.randomUUID(),
    body: {
      protocolVersion: 1,
      organizationId: ORG,
      companyId: COMPANY,
      workerId: WORKER,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      events: [logEvent(offer, seq)],
    },
  } as unknown as EventUploadOperationRequestV1;
}

function controlAckRequest(offer: LeaseOfferV1): ControlAckOperationRequestV1 {
  const correlationId = crypto.randomUUID();
  return {
    protocolVersion: 1,
    correlationId,
    issuedAt: new Date().toISOString(),
    nonce: `ca-${crypto.randomUUID()}`,
    audience: "worker_run",
    body: {
      organizationId: ORG,
      companyId: COMPANY,
      workerId: WORKER,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      ack: {
        protocolVersion: 1,
        correlationId,
        commandId: crypto.randomUUID(),
        commandSeq: 1,
        status: "accepted",
        observedAt: new Date().toISOString(),
        detail: null,
      },
    },
  };
}

function quarantineGrantRequest(offer: LeaseOfferV1): QuarantineGrantOperationRequestV1 {
  const artifactId = crypto.randomUUID();
  const prefix = expectedQuarantineObjectPrefix({
    organizationId: ORG,
    jobId: offer.job.jobId,
    attempt: offer.job.attempt,
  });
  return {
    protocolVersion: 1,
    correlationId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `qg-${crypto.randomUUID()}`,
    audience: "device_session",
    idempotencyKey: crypto.randomUUID(),
    body: {
      protocolVersion: 1,
      workerId: WORKER,
      targetId: TARGET,
      deviceGeneration: 1,
      organizationId: ORG,
      companyId: COMPANY,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      observedLeaseId: offer.leaseId,
      observedFenceToken: offer.fenceToken,
      reason: "stale_fence",
      artifactId,
      expectedObjectKey: `${prefix}orphan.bin`,
      expectedSha256: "a".repeat(64),
      sizeBytes: 128,
    },
  } as unknown as QuarantineGrantOperationRequestV1;
}

function makeStubStorage(): StorageProvider {
  return {
    id: "s3",
    async putObject() {},
    async getObject() { throw new Error("not used"); },
    async headObject(): Promise<HeadObjectResult> {
      return { exists: true, contentLength: 128, checksumSha256: "a".repeat(64) };
    },
    async deleteObject() {},
    async presignPut(i): Promise<PresignResult> {
      return { method: "PUT", url: `https://worker.example/put/${encodeURIComponent(i.objectKey)}`, headers: {} };
    },
    async presignGet(i): Promise<PresignResult> {
      return { method: "GET", url: `https://worker.example/get/${encodeURIComponent(i.objectKey)}`, headers: {} };
    },
  };
}

interface ReplayRow {
  company_id: string | null;
  organization_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown> | null;
}

integration("DE-03 — a replayed worker credential is durable and attributable", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;
  let ordinalCounter = 3_000;

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
      publicKey: "de-003-public-key",
      proofId,
      proofIssuedAt: new Date(),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  async function replayRowsFor(proofId: string): Promise<ReplayRow[]> {
    const { admin } = ctx();
    return (await admin<ReplayRow[]>`
      SELECT company_id, organization_id, actor_type, actor_id, action, entity_type, entity_id, details
      FROM activity_log
      WHERE action = ${REPLAY_ACTION} AND entity_id = ${proofId}
      ORDER BY created_at`) as unknown as ReplayRow[];
  }

  /**
   * The shared assertion, so seven sites cannot drift into seven shapes. Asserts
   * all four attribution axes plus the tenantless SHAPE the ruling opened, and
   * the control string that lets an operator go from the row back to the line.
   */
  async function expectReplayRow(
    proofId: string,
    expected: { operation: string; control: string },
  ): Promise<void> {
    const rows = await replayRowsFor(proofId);
    expect(rows, `no replay-denial row for ${expected.operation}`).toHaveLength(1);
    const row = rows[0]!;
    // WHY — a stable machine code naming the branch, behind an unchanged coarse
    // `unauthorized` on the wire.
    expect(row.details?.reason).toBe("proof_replayed");
    // The obligation this row exists to satisfy, so a reader can go from the row
    // back to the crossing that required it.
    expect(row.details?.crossing).toBe("DE-03");
    expect(row.details?.crossings).toEqual(["DE-03"]);
    // TENANT — the ORGANIZATION axis only. `company_id` is null because
    // `recordProof` refuses before any lease has been looked at, and a null here
    // is a claim that nothing in scope resolves a company.
    expect(row.company_id).toBeNull();
    expect(row.organization_id).toBe(ORG);
    // WHO — the refused worker, as a machine identity with no `agents`/`auth` row.
    expect(row.actor_id).toBe(WORKER);
    expect(row.actor_type).toBe("system");
    // RESOURCE — the spent proof id itself.
    expect(row.entity_type).toBe("worker_proof");
    expect(row.entity_id).toBe(proofId);
    // WHICH CALL SITE — so seven rows in one namespace stay tellable apart.
    expect(row.details?.operation).toBe(expected.operation);
    expect(row.details?.control).toBe(expected.control);
    expect(row.details?.deviceThumbprint).toBe(THUMBPRINT);
  }

  async function resetRuntimeRows(): Promise<void> {
    const { admin } = ctx();
    await admin`DELETE FROM worker_operation_receipts`;
    await admin`DELETE FROM leases`;
    await admin`DELETE FROM job_artifacts`;
    await admin`DELETE FROM job_events`;
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
      device_public_key = 'de-003-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  async function seedPlacedJob(ordinal: number): Promise<{ jobId: string }> {
    const { admin } = ctx();
    const suffix = ordinal.toString().padStart(12, "0");
    const jobId = `d3100000-0000-4000-8000-${suffix}`;
    const attemptId = `d3200000-0000-4000-8000-${suffix}`;
    const outboxId = `d3300000-0000-4000-8000-${suffix}`;
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
         'system', 'de-003-test', 'worker', ${WORKER}, ${workload},
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

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-de003-"));
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
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DE-03 org', 'de-003-org')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'DE-03 company', 'D003')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'de-003-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'de-003-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'DE-03 worker', 'enrolled')`;
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

  it("setup: nothing has been refused yet, so the reserved replay namespace is empty", async () => {
    const { admin } = ctx();
    const rows = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log WHERE action = ${REPLAY_ACTION}`;
    expect(Number(rows[0]?.n ?? "-1")).toBe(0);
  });

  it("★ SITE 1 — `job-leasing.ts:poll`: a spent proof id on the lease poll writes ONE organization-attributed row", async () => {
    const { app } = ctx();
    await resetRuntimeRows();
    await seedPlacedJob(ordinalCounter++);
    const svc = createJobLeasingService({ appDb: app.db });
    const spent = `poll-${crypto.randomUUID()}`;
    // The FIRST poll succeeds and COMMITS the proof row. Nothing is inserted by
    // hand: the replay below is refused by the real unique constraint.
    const first = await svc.poll({ auth: auth(spent), request: pollRequest(spent) });
    expect(first.outcome).toBe("offer");

    await expect(
      svc.poll({ auth: auth(spent), request: pollRequest(`replay-${crypto.randomUUID()}`) }),
    ).rejects.toBeInstanceOf(JobLeasingError);
    await expectReplayRow(spent, {
      operation: "lease_poll",
      control: "server/src/services/job-leasing.ts:poll",
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ★ SITE 2 IS THE ONE THIS UNIT COULD NOT WIRE, AND IT IS PINNED, NOT SKIPPED.
  // `job-leasing.ts:816` (ack) is one of DE-03's seven organization-attested
  // `recordProof` sites. Its refusal THROWS out of `runInTenant`, so the row has
  // to be drained on the pool handle after the transaction unwinds — and the
  // FROZEN JOB-003 ack-flow contract closes every such drain point:
  // `job-leasing-contract.test.ts`'s `exactAckReturnDominance` requires a return
  // whose parent IS the ack method body and whose expression unwraps to the
  // `runInTenant` call itself, and its `unwrap` strips only `await`, parens, `as`
  // and `!` — so neither `.finally(…)` nor a wrapping `try`/`finally` survives.
  // The poll path CAN take a `finally` on its retry `try` (which leaves the
  // classifier/exhaustion/continue triple untouched); ack has no retry `try`.
  // Wiring it needs an AMENDMENT to that contract, which is a decision this unit
  // does not take. An earlier revision of this change put the drain in poll's
  // CATCH and broke the frozen triple; CI caught it, which is the evidence that
  // the contract is live rather than decorative.
  //
  // The arm below therefore asserts what is TRUE TODAY — that this site records
  // NOTHING — with the throw asserted FIRST so it cannot pass by vacuity. WHEN
  // THE CONTRACT IS AMENDED AND THIS SITE IS WIRED, INVERT THIS ARM; DO NOT
  // DELETE IT.
  // ───────────────────────────────────────────────────────────────────────────
  it("★ SITE 2 IS PINNED AS UNRECORDED — `job-leasing.ts:ack` refuses the replay and writes NOTHING, because the frozen JOB-003 ack-flow contract has no drain point", async () => {
    const { app, admin } = ctx();
    const offer = await activateLease();
    const svc = createJobLeasingService({ appDb: app.db });
    const spent = `ack-${crypto.randomUUID()}`;
    const first = await svc.poll({ auth: auth(spent), request: pollRequest(spent) });
    expect(first.outcome === "offer" || first.outcome === "no_work").toBe(true);
    const before = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log WHERE action = ${REPLAY_ACTION}`;

    // REACHABILITY CONTROL, asserted FIRST: the replay branch really is reached.
    await expect(
      svc.ack({ auth: auth(spent), request: ackRequest(offer) }),
    ).rejects.toBeInstanceOf(JobLeasingError);

    expect(
      await replayRowsFor(spent),
      "job-leasing.ts:ack now records its replay refusal — INVERT this arm and update DE-03's records",
    ).toHaveLength(0);
    const after = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log WHERE action = ${REPLAY_ACTION}`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("★ SITE 3 — `job-events.ts:ingest`: a replayed proof on event upload", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const ingest = createJobEventIngestService({ appDb: app.db });
    const spent = `ev-${crypto.randomUUID()}`;
    const first = await ingest.ingest({ auth: auth(spent), request: batchRequest(offer, 1) });
    expect(first.ack.status).toBe("accepted");

    await expect(
      ingest.ingest({ auth: auth(spent), request: batchRequest(offer, 2) }),
    ).rejects.toBeInstanceOf(JobLeasingError);
    await expectReplayRow(spent, {
      operation: "event_upload",
      control: "server/src/services/job-events.ts:ingest",
    });
  });

  it("★ SITE 4 — `job-fencing.ts:renew`: a replayed proof on lease renewal", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const renewal = createJobLeaseRenewalService({ appDb: app.db });
    const spent = `rn-${crypto.randomUUID()}`;
    const first = await renewal.renew({ auth: auth(spent), request: renewRequest(offer) });
    expect(first.outcome).toBe("renewed");

    await expect(
      renewal.renew({ auth: auth(spent), request: renewRequest(offer) }),
    ).rejects.toBeInstanceOf(JobLeasingError);
    await expectReplayRow(spent, {
      operation: "lease_renew",
      control: "server/src/services/job-fencing.ts:renew",
    });
  });

  it("★ SITE 5 — `job-control-ack.ts:ack`: a replayed proof on the control-command ACK", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    // The proof is spent by a SUCCEEDING renewal, so the replay is the only thing
    // this arm's control-ack call can be refused for at `recordProof`.
    const spent = `ca-${crypto.randomUUID()}`;
    const renewal = createJobLeaseRenewalService({ appDb: app.db });
    expect((await renewal.renew({ auth: auth(spent), request: renewRequest(offer) })).outcome).toBe("renewed");

    const svc = createJobControlAckService({ appDb: app.db });
    await expect(
      svc.ack({ auth: auth(spent), request: controlAckRequest(offer) }),
    ).rejects.toBeInstanceOf(JobLeasingError);
    await expectReplayRow(spent, {
      operation: "control_command_ack",
      control: "server/src/services/job-control-ack.ts:ack",
    });
  });

  it("★ SITE 6 — `worker-fence-context.ts:resolveWorkerDeviceContext`: the DEVICE-auth path refuses a replay too", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const spent = `qg-${crypto.randomUUID()}`;
    const renewal = createJobLeaseRenewalService({ appDb: app.db });
    expect((await renewal.renew({ auth: auth(spent), request: renewRequest(offer) })).outcome).toBe("renewed");

    const svc = createQuarantineGrantService({ appDb: app.db, storage: makeStubStorage() });
    await expect(
      svc.grant({ auth: auth(spent), request: quarantineGrantRequest(offer) }),
    ).rejects.toBeInstanceOf(JobLeasingError);
    await expectReplayRow(spent, {
      operation: "quarantine_grant",
      control: "server/src/services/worker-fence-context.ts:resolveWorkerDeviceContext",
    });
  });

  it("POSITIVE CONTROL — a FRESH proof writes NO denial row, on every one of the paths above", async () => {
    const { app, admin } = ctx();
    const offer = await activateLease();
    const before = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log WHERE action = ${REPLAY_ACTION}`;

    // Four DIFFERENT services, four FRESH proof ids, four successes. "Always write
    // a denial" fails here; so does "write one per operation".
    const renewal = createJobLeaseRenewalService({ appDb: app.db });
    expect((await renewal.renew({ auth: auth(`ok-rn-${crypto.randomUUID()}`), request: renewRequest(offer) })).outcome)
      .toBe("renewed");
    const ingest = createJobEventIngestService({ appDb: app.db });
    expect((await ingest.ingest({ auth: auth(`ok-ev-${crypto.randomUUID()}`), request: batchRequest(offer, 1) })).ack.status)
      .toBe("accepted");
    const grant = createQuarantineGrantService({ appDb: app.db, storage: makeStubStorage() });
    expect((await grant.grant({ auth: auth(`ok-qg-${crypto.randomUUID()}`), request: quarantineGrantRequest(offer) })).outcome)
      .toBe("quarantine_upload_granted");
    const leasing = createJobLeasingService({ appDb: app.db });
    const polled = await leasing.poll({ auth: auth(`ok-p-${crypto.randomUUID()}`), request: pollRequest(`ok-${crypto.randomUUID()}`) });
    expect(polled.outcome === "offer" || polled.outcome === "no_work").toBe(true);

    const after = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log WHERE action = ${REPLAY_ACTION}`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("★ EVERY REPLAY ROW IS TENANTLESS-BY-ORGANIZATION AND IN THE RESERVED NAMESPACE — and the five WIRED sites are told apart", async () => {
    const { admin } = ctx();
    const rows = await admin<{ action: string; company_id: string | null; organization_id: string | null; operation: string }[]>`
      SELECT action, company_id, organization_id, details->>'operation' AS operation
      FROM activity_log WHERE action = ${REPLAY_ACTION} ORDER BY created_at`;
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      // The partial CHECK `0274` added is what makes these rows storable at all;
      // a row outside the reserved namespace with a null company would violate it.
      expect(row.action).toBe(REPLAY_ACTION);
      expect(row.company_id).toBeNull();
      expect(row.organization_id).toBe(ORG);
    }
    // ★ FIVE DISTINCT SITES, not one site fired five times. If two call sites ever
    // recorded the same `operation`, an operator could not tell which control
    // refused, and this assertion is what stops that.
    expect(new Set(rows.map((r) => r.operation))).toEqual(new Set([
      "lease_poll",
      "event_upload",
      "lease_renew",
      "control_command_ack",
      "quarantine_grant",
    ]));
    // ...and `lease_ack` is ABSENT by design, not by accident: SITE 2 is pinned
    // as unrecorded above. If it ever appears here, that pin is stale.
    expect(rows.some((r) => r.operation === "lease_ack")).toBe(false);
  });

  it("★ THE TWO DOUBLY-NULL SITES ARE NOT WIRED, AND THIS FILE DOES NOT PRETEND THEY ARE", async () => {
    const { admin } = ctx();
    // `worker-enrollment.ts:315` and `middleware/worker-session-auth.ts:151` hold
    // NEITHER axis, so a row for them would be attributable to nothing but a
    // device thumbprint. That is a different decision and this unit did not take
    // it. No row in this file's namespace may therefore be doubly null.
    const rows = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log
      WHERE action LIKE 'security.denied.%' AND company_id IS NULL AND organization_id IS NULL`;
    expect(
      Number(rows[0]?.n ?? "-1"),
      "a doubly-null denial row appeared — the two unwired sites were wired without updating DE-03's records",
    ).toBe(0);
    // POSITIVE CONTROL for the predicate: single-axis rows DO exist and this same
    // query shape finds them, so the zero above is a fact and not a typo.
    const single = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log
      WHERE action LIKE 'security.denied.%' AND company_id IS NULL AND organization_id IS NOT NULL`;
    expect(Number(single[0]?.n ?? "-1")).toBeGreaterThan(0);
  });
});
