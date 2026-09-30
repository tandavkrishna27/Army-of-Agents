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
  canonicalEventDigestInputV1,
  canonicalizeJsonV1,
  type EventUploadOperationRequestV1,
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
  canonicalProviderConstraintProfileDigestInputV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { createJobLeasingService, type VerifiedWorkerOperation } from "../services/job-leasing.js";
import { createJobEventIngestService } from "../services/job-events.js";
import {
  createJobOperationsService,
  JOB_DETAIL_EVENT_LIMIT,
} from "../services/job-operations.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "a5000000-0000-4000-8000-000000000001";
const COMPANY = "a5000000-0000-4000-8000-000000000002";
const TARGET = "a5000000-0000-4000-8000-000000000003";
const WORKER = "a5000000-0000-4000-8000-000000000005";
const PASSWORD = "job-005-role-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "job-005-provider",
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
    agentVersion: "job-005-integration",
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
  } as PollRequestV1;
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
  } as LeaseAckOperationRequestV1;
}

type EventInit = { eventType: string; payload: Record<string, unknown>; seq: number; eventId?: string; corruptDigest?: boolean };

function makeEvent(offer: LeaseOfferV1, init: EventInit): Record<string, unknown> {
  const base = {
    protocolVersion: 1,
    eventId: init.eventId ?? crypto.randomUUID(),
    organizationId: ORG,
    companyId: COMPANY,
    workerId: WORKER,
    jobId: offer.job.jobId,
    attempt: offer.job.attempt,
    leaseId: offer.leaseId,
    fenceToken: offer.fenceToken,
    seq: init.seq,
    occurredAt: new Date().toISOString(),
    extensions: [] as unknown[],
    eventType: init.eventType,
    payload: init.payload,
  };
  const digest = sha256(canonicalEventDigestInputV1(base));
  return { ...base, eventDigest: init.corruptDigest ? "b".repeat(64) : digest };
}

function attemptStarted(offer: LeaseOfferV1, seq: number, opts: Partial<EventInit> = {}) {
  return makeEvent(offer, { eventType: "attempt_started", payload: { sandboxId: `sbx-${crypto.randomUUID()}` }, seq, ...opts });
}
function logEvent(offer: LeaseOfferV1, seq: number, opts: Partial<EventInit> = {}) {
  return makeEvent(offer, { eventType: "log", payload: { stream: "stdout", level: "info", message: `line ${seq}` }, seq, ...opts });
}
function terminalEvent(offer: LeaseOfferV1, seq: number, status = "succeeded", opts: Partial<EventInit> = {}) {
  return makeEvent(offer, { eventType: "terminal", payload: { status, exitCode: 0, errorCode: null, errorMessage: null }, seq, ...opts });
}

function batchRequest(offer: LeaseOfferV1, events: Record<string, unknown>[]): EventUploadOperationRequestV1 {
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
      events,
    },
  } as unknown as EventUploadOperationRequestV1;
}

integration("JOB-005 fenced event ingest", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
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
      publicKey: "job-005-public-key",
      proofId,
      proofIssuedAt: new Date(),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  async function resetRuntimeRows(): Promise<void> {
    const { admin } = guardCtx();
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
      device_public_key = 'job-005-public-key', device_thumbprint = ${THUMBPRINT},
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
         'system', 'job-005-test', 'worker', ${WORKER}, ${workload},
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

  async function activateLease(ordinal: number): Promise<{
    seeded: { jobId: string; attemptId: string };
    offer: LeaseOfferV1;
    ingest: ReturnType<typeof createJobEventIngestService>;
  }> {
    const { app } = guardCtx();
    await resetRuntimeRows();
    const seeded = await seedPlacedJob(ordinal);
    const service = createJobLeasingService({ appDb: app.db });
    const ingest = createJobEventIngestService({ appDb: app.db });
    const polled = await service.poll({ auth: auth(`ev-poll-${ordinal}`), request: pollRequest(`ev-poll-${ordinal}`) });
    if (polled.outcome !== "offer") throw new Error(`expected offer, got ${polled.outcome}`);
    const offer = polled.body;
    const acked = await service.ack({ auth: auth(`ev-ack-${ordinal}`), request: ackRequest(offer) });
    if (acked.outcome !== "acknowledged") throw new Error("expected ack");
    return { seeded, offer, ingest };
  }

  async function state(attemptId: string, jobId: string) {
    const { admin } = guardCtx();
    const [row] = await admin<{ events: number; receipts: number; attemptStatus: string; jobStatus: string }[]>`SELECT
      (SELECT count(*)::int FROM job_events WHERE attempt_id = ${attemptId}) AS events,
      (SELECT count(*)::int FROM job_projection_receipts WHERE attempt_id = ${attemptId}) AS receipts,
      (SELECT status FROM job_attempts WHERE id = ${attemptId}) AS "attemptStatus",
      (SELECT status FROM jobs WHERE id = ${jobId}) AS "jobStatus"`;
    return row!;
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-job-events-"));
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
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'JOB-005 org', 'job-005-org')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'JOB-005 company', 'J005')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'job-005-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'job-005-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'JOB-005 worker', 'enrolled')`;
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


  // ── BRW-003d-4 — ordering and response bounding, on a tier that REALLY SORTS ──
  //
  // The unit tier's fake accepts .orderBy() and does not sort, deliberately: an
  // ordering assertion there would pass against a wrong ORDER BY because the
  // fixture order would decide the result. These run against embedded Postgres.
  describe("BRW-003d-4 job detail ordering and bounding", () => {
    const ops = () => {
      // `createTenantAppDbConnection` returns a CONNECTION; the service takes the
      // inner drizzle handle, exactly as app.ts passes `appConnection.db`.
      const { app: appConn, operator: operatorConn } = guardCtx();
      return createJobOperationsService({
        appDb: appConn.db as never,
        operatorDb: operatorConn.db as never,
      });
    };

    it("orders events by (attemptNumber, sequence), not by sequence alone", async () => {
      const { offer, ingest, seeded } = await activateLease(5_401);
      await ingest.ingest({ auth: auth("d4-order"), request: batchRequest(offer, [attemptStarted(offer, 1)]) });
      const { admin } = guardCtx();
      // A SECOND attempt whose sequence 1 must sort AFTER attempt 1's sequence 9.
      // Ordering by `sequence` alone interleaves the two into nonsense — this is
      // the fixture that makes the two-key ORDER BY observable.
      await admin`INSERT INTO job_events
        (id, organization_id, company_id, job_id, attempt_id, attempt_number, lease_id, fence_token,
         event_id, sequence, event_type, event, event_digest, occurred_at)
        VALUES
        (gen_random_uuid(), ${ORG}, ${COMPANY}, ${seeded.jobId}, ${seeded.attemptId}, 1,
         ${offer.leaseId}, ${offer.fenceToken}, gen_random_uuid(), 9, 'log',
         '{"payload":{"m":"a1s9"}}'::jsonb, encode(sha256('a1s9'::bytea),'hex'), now()),
        (gen_random_uuid(), ${ORG}, ${COMPANY}, ${seeded.jobId}, ${seeded.attemptId}, 2,
         ${offer.leaseId}, ${offer.fenceToken}, gen_random_uuid(), 2, 'log',
         '{"payload":{"m":"a2s2"}}'::jsonb, encode(sha256('a2s2'::bytea),'hex'), now())`;

      const detail = await ops().getJobDetail(ORG, COMPANY, seeded.jobId);
      const keys = detail.events.map((e) => `${e.attemptNumber}:${e.sequence}`);
      const a1s9 = keys.indexOf("1:9");
      const a2s2 = keys.indexOf("2:2");
      expect(a1s9).toBeGreaterThan(-1);
      expect(a2s2).toBeGreaterThan(-1);
      // Ordering by `sequence` alone would place 2 BEFORE 9; both keys places it after.
      expect(a1s9).toBeLessThan(a2s2);
      // ascending within an attempt too
      const attempt1 = keys.filter((k) => k.startsWith("1:")).map((k) => Number(k.split(":")[1]));
      expect([...attempt1].sort((x, y) => x - y)).toEqual(attempt1);
    });

    it("bounds the events list and REPORTS the truncation", async () => {
      const { offer, ingest, seeded } = await activateLease(5_402);
      await ingest.ingest({ auth: auth("d4-bound"), request: batchRequest(offer, [attemptStarted(offer, 1)]) });
      const { admin } = guardCtx();
      // One past the cap, so the boundary itself is exercised.
      await admin`INSERT INTO job_events
        (id, organization_id, company_id, job_id, attempt_id, attempt_number, lease_id, fence_token,
         event_id, sequence, event_type, event, event_digest, occurred_at)
        SELECT gen_random_uuid(), ${ORG}, ${COMPANY}, ${seeded.jobId}, ${seeded.attemptId}, 1,
               ${offer.leaseId}, ${offer.fenceToken}, gen_random_uuid(), g, 'log',
               '{"payload":{}}'::jsonb, encode(sha256(('d'||g)::bytea),'hex'), now()
        FROM generate_series(100, ${100 + JOB_DETAIL_EVENT_LIMIT}) AS g`;

      const detail = await ops().getJobDetail(ORG, COMPANY, seeded.jobId);
      expect(detail.events.length).toBeLessThanOrEqual(JOB_DETAIL_EVENT_LIMIT);
      // ★ Silent truncation is the defect, not the cap: an operator reading the
      // last row of a truncated ascending list concludes the job ended there.
      expect(detail.eventsTruncated).toBe(true);
    });

    it("keeps the MOST RECENT window when it truncates", async () => {
      const { offer, ingest, seeded } = await activateLease(5_403);
      await ingest.ingest({ auth: auth("d4-recent"), request: batchRequest(offer, [attemptStarted(offer, 1)]) });
      const { admin } = guardCtx();
      await admin`INSERT INTO job_events
        (id, organization_id, company_id, job_id, attempt_id, attempt_number, lease_id, fence_token,
         event_id, sequence, event_type, event, event_digest, occurred_at)
        SELECT gen_random_uuid(), ${ORG}, ${COMPANY}, ${seeded.jobId}, ${seeded.attemptId}, 1,
               ${offer.leaseId}, ${offer.fenceToken}, gen_random_uuid(), g, 'log',
               '{"payload":{}}'::jsonb, encode(sha256(('r'||g)::bytea),'hex'), now()
        FROM generate_series(1000, ${1000 + JOB_DETAIL_EVENT_LIMIT + 50}) AS g`;

      const detail = await ops().getJobDetail(ORG, COMPANY, seeded.jobId);
      const seqs = detail.events.map((e) => e.sequence as number);
      // The terminal lives at the newest end; dropping the OLDEST is what keeps a
      // truncated response useful.
      expect(Math.max(...seqs)).toBe(1000 + JOB_DETAIL_EVENT_LIMIT + 50);
      // and still ascending after the reverse
      expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    });

    it("★ returns a GRANTED artifact row that never committed — the stale-fence record stays discoverable", async () => {
      const { offer, ingest, seeded } = await activateLease(5_404);
      await ingest.ingest({ auth: auth("d4-art"), request: batchRequest(offer, [attemptStarted(offer, 1)]) });
      const { admin } = guardCtx();
      // A grant-intent row and a committed row for DIFFERENT identifiers. The
      // granted one is the record that survives a refused commit; a
      // committed-only read would delete exactly the evidence the stale-fence
      // clause exists to preserve.
      await admin`INSERT INTO job_artifacts
        (id, organization_id, job_id, attempt, identifier, kind, status, created_at)
        VALUES
        (gen_random_uuid(), ${ORG}, ${seeded.jobId}, 1, 'never-committed', 'trace', 'granted', now()),
        (gen_random_uuid(), ${ORG}, ${seeded.jobId}, 1, 'landed', 'trace', 'committed', now())`;

      const detail = await ops().getJobDetail(ORG, COMPANY, seeded.jobId);
      const byId = Object.fromEntries(detail.artifacts.map((a) => [a.identifier, a.status]));
      expect(byId["never-committed"]).toBe("granted");
      expect(byId["landed"]).toBe("committed");
      expect(detail.artifactsTruncated).toBe(false);
    });
  });

  it("accepts the first attempt_started and projects attempt leased->running + job queued->running", async () => {
    const { offer, ingest, seeded } = await activateLease(5_001);
    const response = await ingest.ingest({
      auth: auth("ev-first"),
      request: batchRequest(offer, [attemptStarted(offer, 1)]),
    });
    expect(response.ack.status).toBe("accepted");
    expect(response.ack.acceptedThroughSeq).toBe(1);
    expect(response.ack.expectedNextSeq).toBe(2);
    expect(await state(seeded.attemptId, seeded.jobId)).toEqual({
      events: 1, receipts: 1, attemptStatus: "running", jobStatus: "running",
    });
  }, 60_000);

  it("replays a re-sent accepted batch with the same cumulative ACK and no duplicate rows", async () => {
    const { offer, ingest, seeded } = await activateLease(5_002);
    const started = attemptStarted(offer, 1);
    const first = await ingest.ingest({ auth: auth("ev-r1"), request: batchRequest(offer, [started]) });
    expect(first.ack.status).toBe("accepted");
    // Exact re-delivery of the same events (new envelope) → same acceptedThroughSeq, no dup rows.
    const replay = await ingest.ingest({ auth: auth("ev-r2"), request: batchRequest(offer, [started]) });
    expect(replay.ack.status).toBe("accepted");
    expect(replay.ack.acceptedThroughSeq).toBe(1);
    expect(await state(seeded.attemptId, seeded.jobId)).toEqual({
      events: 1, receipts: 1, attemptStatus: "running", jobStatus: "running",
    });
  }, 60_000);

  it("rejects a changed digest as hash_mismatch and commits nothing", async () => {
    const { offer, ingest, seeded } = await activateLease(5_003);
    const bad = attemptStarted(offer, 1, { corruptDigest: true });
    const response = await ingest.ingest({ auth: auth("ev-hash"), request: batchRequest(offer, [bad]) });
    expect(response.ack.status).toBe("hash_mismatch");
    expect(response.ack.rejectedEventId).toBe(bad.eventId);
    expect(response.ack.acceptedThroughSeq).toBe(0);
    expect(await state(seeded.attemptId, seeded.jobId)).toEqual({
      events: 0, receipts: 0, attemptStatus: "leased", jobStatus: "queued",
    });
  }, 60_000);

  it("rejects a new-tail event REUSING an already-accepted eventId (no phantom projection, no advance)", async () => {
    const { offer, ingest, seeded } = await activateLease(5_099);
    const started = attemptStarted(offer, 1);
    const first = await ingest.ingest({ auth: auth("ev-reuse1"), request: batchRequest(offer, [started]) });
    expect(first.ack.status).toBe("accepted");
    expect(first.ack.acceptedThroughSeq).toBe(1);
    // A NEW-TAIL event at seq 2 that REUSES the seq-1 eventId (self-consistent digest for a
    // different payload). Without the pre-insert reuse guard the org-wide (org,event_id)
    // ON CONFLICT DO NOTHING would silently drop the row while the projection loop + cumulative
    // ACK still advanced to seq 2 — wedging the attempt's stream on a phantom sequence. It must
    // be rejected hash_mismatch, persisting nothing and NOT advancing acceptedThroughSeq.
    const reused = logEvent(offer, 2, { eventId: started.eventId as string });
    const response = await ingest.ingest({ auth: auth("ev-reuse2"), request: batchRequest(offer, [reused]) });
    expect(response.ack.status).toBe("hash_mismatch");
    expect(response.ack.rejectedEventId).toBe(started.eventId);
    expect(response.ack.acceptedThroughSeq).toBe(1);
    // Unchanged: only the seq-1 event + its projection persist; no phantom seq-2 row/receipt.
    expect(await state(seeded.attemptId, seeded.jobId)).toEqual({
      events: 1, receipts: 1, attemptStatus: "running", jobStatus: "running",
    });
  }, 60_000);

  it("commits NONE of a partially-invalid batch (all-or-nothing)", async () => {
    const { offer, ingest, seeded } = await activateLease(5_004);
    // seq1 + seq2 valid, seq3 corrupt → whole batch rejected, nothing persisted.
    const response = await ingest.ingest({
      auth: auth("ev-partial"),
      request: batchRequest(offer, [
        attemptStarted(offer, 1),
        logEvent(offer, 2),
        logEvent(offer, 3, { corruptDigest: true }),
      ]),
    });
    expect(response.ack.status).toBe("hash_mismatch");
    expect(await state(seeded.attemptId, seeded.jobId)).toEqual({
      events: 0, receipts: 0, attemptStatus: "leased", jobStatus: "queued",
    });
  }, 60_000);

  it("reports a sequence gap without persisting", async () => {
    const { offer, ingest, seeded } = await activateLease(5_005);
    await ingest.ingest({ auth: auth("ev-gap1"), request: batchRequest(offer, [attemptStarted(offer, 1)]) });
    // Skip seq 2 → a batch starting at seq 3 is a gap.
    const response = await ingest.ingest({ auth: auth("ev-gap2"), request: batchRequest(offer, [logEvent(offer, 3)]) });
    expect(response.ack.status).toBe("gap");
    expect(response.ack.acceptedThroughSeq).toBe(1);
    expect(await state(seeded.attemptId, seeded.jobId)).toMatchObject({ events: 1 });
  }, 60_000);

  it("rejects an in-batch duplicate / non-contiguous batch as malformed before persistence", async () => {
    const { offer, ingest } = await activateLease(5_006);
    const dupId = crypto.randomUUID();
    await expect(ingest.ingest({
      auth: auth("ev-dup"),
      request: batchRequest(offer, [attemptStarted(offer, 1, { eventId: dupId }), logEvent(offer, 2, { eventId: dupId })]),
    })).rejects.toMatchObject({ code: "malformed" });
    // Non-contiguous sequences also fail the frozen batch schema.
    await expect(ingest.ingest({
      auth: auth("ev-noncontig"),
      request: batchRequest(offer, [attemptStarted(offer, 1), logEvent(offer, 3)]),
    })).rejects.toMatchObject({ code: "malformed" });
  }, 60_000);

  it("accepts an overlapping replay tail and extends acceptedThroughSeq", async () => {
    const { offer, ingest, seeded } = await activateLease(5_007);
    const e1 = attemptStarted(offer, 1);
    const e2 = logEvent(offer, 2);
    const e3 = logEvent(offer, 3);
    await ingest.ingest({ auth: auth("ev-ov1"), request: batchRequest(offer, [e1, e2, e3]) });
    const e4 = logEvent(offer, 4);
    // Re-send [2,3] (identical) + new [4] → replay the overlap, append 4.
    const response = await ingest.ingest({ auth: auth("ev-ov2"), request: batchRequest(offer, [e2, e3, e4]) });
    expect(response.ack.status).toBe("accepted");
    expect(response.ack.acceptedThroughSeq).toBe(4);
    expect(await state(seeded.attemptId, seeded.jobId)).toMatchObject({ events: 4 });
  }, 60_000);

  it("lets a terminal result win once; a later terminal sees terminal and cannot overwrite", async () => {
    const { offer, ingest, seeded } = await activateLease(5_008);
    await ingest.ingest({ auth: auth("ev-t1"), request: batchRequest(offer, [attemptStarted(offer, 1)]) });
    const first = await ingest.ingest({ auth: auth("ev-t2"), request: batchRequest(offer, [terminalEvent(offer, 2, "succeeded")]) });
    expect(first.ack.status).toBe("accepted");
    expect((await state(seeded.attemptId, seeded.jobId)).attemptStatus).toBe("succeeded");

    // A later batch on the now-terminal attempt is refused as `terminal` (the guard
    // sees the terminal attempt), and the winner is not overwritten.
    const loser = await ingest.ingest({ auth: auth("ev-t3"), request: batchRequest(offer, [terminalEvent(offer, 3, "failed")]) });
    expect(loser.ack.status).toBe("terminal");
    expect((await state(seeded.attemptId, seeded.jobId)).attemptStatus).toBe("succeeded");
  }, 60_000);

  it("refuses a stale (expired) fence with a stale_fence ACK and no writes", async () => {
    const { admin } = guardCtx();
    const { offer, ingest, seeded } = await activateLease(5_009);
    await ingest.ingest({ auth: auth("ev-s1"), request: batchRequest(offer, [attemptStarted(offer, 1)]) });
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() - interval '2 seconds',
      expires_at = clock_timestamp() - interval '1 second' WHERE id = ${offer.leaseId}`;
    const response = await ingest.ingest({ auth: auth("ev-stale"), request: batchRequest(offer, [logEvent(offer, 2)]) });
    expect(response.ack.status).toBe("stale_fence");
    expect(response.ack.acceptedThroughSeq).toBe(1);
    expect(await state(seeded.attemptId, seeded.jobId)).toMatchObject({ events: 1 });
  }, 60_000);

  it("concurrent terminal writers: exactly one wins, the loser observes terminal", async () => {
    const { offer, ingest, seeded } = await activateLease(5_010);
    await ingest.ingest({ auth: auth("ev-c1"), request: batchRequest(offer, [attemptStarted(offer, 1)]) });
    const [a, b] = await Promise.allSettled([
      ingest.ingest({ auth: auth("ev-cA"), request: batchRequest(offer, [terminalEvent(offer, 2, "succeeded")]) }),
      ingest.ingest({ auth: auth("ev-cB"), request: batchRequest(offer, [terminalEvent(offer, 2, "failed")]) }),
    ]);
    const statuses = [a, b].map((r) => (r.status === "fulfilled" ? r.value.ack.status : `rejected:${String((r.reason as { code?: string })?.code)}`));
    // One append wins (accepted); the other is a same-seq contender that either
    // observes the terminal attempt or replays — never a second distinct terminal.
    expect(statuses.filter((s) => s === "accepted").length).toBe(1);
    const final = await state(seeded.attemptId, seeded.jobId);
    expect(final.attemptStatus === "succeeded" || final.attemptStatus === "failed").toBe(true);
    // Exactly one terminal event stored at seq 2.
    expect(final.events).toBe(2);
  }, 60_000);
});
