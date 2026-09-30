/**
 * DE-06, audit clause — a refused artifact object operation is durably
 * distinguishable from an operation that never happened, and ATTRIBUTABLE.
 *
 * ★ WHAT THIS TEST IS FOR. `docs/architecture/distributed-execution-threat-controls.json`
 * DE-06 asserts "object put/get and rejected-key attempts are audited". Before
 * this test NOTHING recorded a rejected-key attempt:
 *   - the GRANT path's `rejected()` (`artifact-transfer-grant.ts`) only
 *     constructed a response object — no row, no metric, no log line;
 *   - the COMMIT path emitted a COUNT-ONLY `metrics.artifactOp({outcome:"rejected"})`
 *     tick that is compile-closed against ids by deliberate design, so it can
 *     answer "how many" and never "whose", "which tenant", "which key" or "why".
 * A worker in organization A that repeatedly asked for a presigned URL under
 * organization B's object-key prefix therefore left the same durable trace as a
 * worker that asked for nothing at all. That is the gap `E0-F010` files for
 * DE-06, and closing THE REJECTED-KEY HALF of it is what this file proves.
 *
 * ★ WHAT THIS FILE DOES NOT PROVE, first, because the clause is CONJUNCTIVE and
 * this file proves only one conjunct. DE-06's clause is verbatim "object put/get
 * AND rejected-key attempts are audited".
 *   - "rejected-key attempts" — delivered and proven below.
 *   - "object put/get" — delivered on 2026-09-10, and NOT HERE. It is proven, arm
 *     by arm, in `de-06-object-access-audit.integration.test.ts`: a SUCCESSFUL
 *     upload or download grant writes an attributable `security.object_access.*`
 *     row. Two arms in THIS file were amended by that unit and are marked where
 *     they sit — the granted-upload positive control (which asserted "nothing at
 *     all was appended", i.e. exactly that conjunct's absence) and the whole-log
 *     namespace sweep. **Nothing in this file closes DE-06**, and no record may
 *     cite it as the closure; what closes the clause is the two files together.
 *     DE-06 stays `partial` in the threat register for its separately-absent
 *     `authentication` clause (`E0-F012`).
 *     *(Superseded text, kept so the correction is visible: "NOT delivered. A
 *     SUCCESSFUL download grant … presigns, parses and returns while writing no
 *     audit record at all, and no arm here asserts one. So DE-06's audit clause
 *     is HALF delivered, DE-06 stays in `E0-F010`'s open cohort".)*
 *   - The fence-AUTH refusals are now ALL SIX recorded, and that still does not
 *     move DE-06. Only the post-resolution tuple-integrity branch has an
 *     FK-valid company in hand; the other five carry a token-attested
 *     `organization_id` and write a company-null row into the sink `E0-F013`
 *     Decision 2 (a2) opened (`worker-denial-audit.ts`). FOUR of the six are
 *     PROVOKED through the real path below (`:86`, `:100` in both codes, `:121`,
 *     plus the tuple-integrity branch); `:103` and `:108` are structurally
 *     unreachable behind `ackAuthorityCurrent` and are PINNED as never-fired
 *     rather than claimed. A larger fraction of a conjunction is not a closure.
 *
 * ★ WHY THIS IS NOT A READ-BACK. This file never constructs a denial. It
 * PROVOKES the real refusal through the real service — a real enrolled worker,
 * a real polled + acked lease, a real live fence — and then asserts the durable
 * row the refusal itself left behind. A read-back verifies what was DECLARED,
 * never what is ENFORCED (the measured lesson of DE-08).
 *
 * ★ ATTRIBUTION IS THE ASSERTION. Each of the four questions is asserted
 * separately, because a record saying "something was denied" satisfies no
 * crossing in this class:
 *   WHO      -> actor_id is the refused worker
 *   TENANT   -> company_id is the LOCKED LEASE's company (resolved from the
 *               database under the refusing worker's own org GUC), and it is
 *               NOT the tenant that was probed
 *   RESOURCE -> entity_type/entity_id is the artifact identity, and
 *               details.requestedObjectKey is the key that was actually asked for
 *   WHY      -> details.reason is a stable machine code, and the branches are
 *               told APART behind one identical opaque wire reason
 *
 * ★ THE CROSS-TENANT ARM IS THE POINT, not an extra. DE-06's whole subject is a
 * worker reaching into a FOREIGN organization's object-key namespace. So the
 * central provocation here uses a key under a second, genuinely separate
 * organization's prefix, and the file then asserts the storage posture the
 * recorder's design rests on: `activity_log` is outside the tenant RLS kernel,
 * against a positive control that the kernel really is present and forced on
 * this database. Fold `activity_log` into the kernel and this file goes red
 * naming the change rather than merely losing a row.
 *
 * ★ NON-DISCLOSURE IS PRESERVED, and that is asserted too. Six distinct refusal
 * branches answer the worker with the identical coarse `reason:"malformed"`, and
 * that coarseness is correct — a finer wire code would tell a prober whether a
 * foreign object key exists. The audit row is where the distinction lives.
 *
 * Real Postgres (embedded-postgres + the committed migration chain), the real
 * `aoa_app` non-owner role, the real leasing / transfer-grant / commit services.
 * No stubs on the gate and none on the recorder; only the object store is stubbed.
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI `push` is the authoritative gate. On
 * a Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real. Harness
 * modeled on artifact-transfer-commit.integration.test.ts (DAT-002).
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
  JobLeasingError,
  type VerifiedWorkerOperation,
} from "../services/job-leasing.js";
import { createArtifactTransferGrantService } from "../services/artifact-transfer-grant.js";
import { createArtifactCommitService } from "../services/artifact-commit.js";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "../services/artifact-size-ceiling.js";
import type { StorageProvider, HeadObjectResult, PresignResult } from "../storage/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "d6000000-0000-4000-8000-000000000001";
const COMPANY = "d6000000-0000-4000-8000-000000000002";
const TARGET = "d6000000-0000-4000-8000-000000000003";
const WORKER = "d6000000-0000-4000-8000-000000000005";
// A genuinely separate tenant at the unit the kernel keys on (`organizations`),
// not merely a second company inside the same organization.
const OTHER_ORG = "d6000000-0000-4000-8000-0000000000aa";
const OTHER_COMPANY = "d6000000-0000-4000-8000-0000000000bb";
const PASSWORD = "de-006-role-password";
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
    profileId: "de-006-provider",
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
    agentVersion: "de-006-integration",
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

function makeStubStorage(): StorageProvider & { headResult: HeadObjectResult; readonly headCalls: number } {
  const state = {
    headResult: { exists: true, contentLength: 0, checksumSha256: "0".repeat(64) } as HeadObjectResult,
    // Counted so an arm can assert the store was NEVER probed — the ordering
    // property that stops object existence being a cross-tenant oracle.
    headCalls: 0,
  };
  return {
    id: "s3",
    get headResult() { return state.headResult; },
    set headResult(v: HeadObjectResult) { state.headResult = v; },
    get headCalls() { return state.headCalls; },
    async putObject() {},
    async getObject() { throw new Error("not used"); },
    async headObject() { state.headCalls += 1; return state.headResult; },
    async deleteObject() {},
    async presignPut(i): Promise<PresignResult> {
      return { method: "PUT", url: `https://worker.example/put/${encodeURIComponent(i.objectKey)}`, headers: {} };
    },
    async presignGet(i): Promise<PresignResult> {
      return { method: "GET", url: `https://worker.example/get/${encodeURIComponent(i.objectKey)}`, headers: {} };
    },
  };
}

interface DenialRow {
  company_id: string | null;
  organization_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown> | null;
}

integration("DE-06 — a refused artifact object operation is durable and attributable", () => {
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
      publicKey: "de-006-public-key",
      proofId,
      proofIssuedAt: new Date(),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  /**
   * ★ NARROWED TO THE DENIAL NAMESPACE (2026-09-10, the put/get unit). This
   * helper was action-BLIND — `WHERE entity_id = $1` and nothing else — so it
   * answered "any audit row about this artifact", while every one of its ~20
   * call sites reads it as "the denial rows". That was harmless only while the
   * denial recorder was the sole writer keyed on an artifact id; the
   * OBJECT-ACCESS recorder is a second one, and an unnarrowed helper would have
   * made this file's refusal arms start counting successful grants. Narrowing
   * cannot lose a row any existing arm asserts on: every row they assert is a
   * `security.denied.*` row.
   */
  async function denialRowsFor(artifactId: string): Promise<DenialRow[]> {
    const { admin } = ctx();
    return (await admin<DenialRow[]>`
      SELECT company_id, organization_id, actor_type, actor_id, action, entity_type, entity_id, details
      FROM activity_log
      WHERE entity_id = ${artifactId} AND action LIKE 'security.denied.%'
      ORDER BY created_at`) as unknown as DenialRow[];
  }

  /** The fence-resolution denial rows for one lease. The tuple-integrity branch
   * refuses BEFORE any artifact is authorized, so its `entity_id` is the LEASE —
   * `denialRowsFor` (keyed on artifactId) can never see it. */
  async function fenceDenialRowsFor(leaseId: string): Promise<DenialRow[]> {
    const { admin } = ctx();
    return (await admin<DenialRow[]>`
      SELECT company_id, organization_id, actor_type, actor_id, action, entity_type, entity_id, details
      FROM activity_log
      WHERE entity_id = ${leaseId} AND action = 'security.denied.worker_fence_resolution'
      ORDER BY created_at`) as unknown as DenialRow[];
  }

  /** The ORGANIZATION-ONLY fence-resolution rows for one presented lease. These
   * refusals resolve no company at all, so they are invisible to
   * `fenceDenialRowsFor` (which is company-blind but entity-keyed on the RESOLVED
   * lease id) and to `activityRowCount(COMPANY)` (which is company-keyed).
   * `details.presentedLeaseId` is the only stable key they share. */
  async function fenceOrgDenialRowsFor(leaseId: string): Promise<DenialRow[]> {
    const { admin } = ctx();
    return (await admin<DenialRow[]>`
      SELECT company_id, organization_id, actor_type, actor_id, action, entity_type, entity_id, details
      FROM activity_log
      WHERE action = 'security.denied.worker_fence_resolution'
        AND details->>'presentedLeaseId' = ${leaseId}
      ORDER BY created_at`) as unknown as DenialRow[];
  }

  /** The DE-03 replay-rejection rows for one proof id. */
  async function proofDenialRowsFor(proofId: string): Promise<DenialRow[]> {
    const { admin } = ctx();
    return (await admin<DenialRow[]>`
      SELECT company_id, organization_id, actor_type, actor_id, action, entity_type, entity_id, details
      FROM activity_log
      WHERE action = 'security.denied.worker_proof_replay' AND entity_id = ${proofId}
      ORDER BY created_at`) as unknown as DenialRow[];
  }

  /** Rows in the tenantless sink E0-F013 Decision 2 (a2) opened: no company, one
   * organization. Counted separately because `activityRowCount(COMPANY)` cannot
   * see them and would read a real write as silence. */
  async function tenantlessRowCount(organizationId: string): Promise<number> {
    const { admin } = ctx();
    const rows = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log
      WHERE company_id IS NULL AND organization_id = ${organizationId}`;
    return Number(rows[0]?.n ?? "-1");
  }

  async function activityRowCount(companyId: string): Promise<number> {
    const { admin } = ctx();
    const rows = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log WHERE company_id = ${companyId}`;
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
      device_public_key = 'de-006-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  async function seedPlacedJob(ordinal: number): Promise<{ jobId: string }> {
    const { admin } = ctx();
    const suffix = ordinal.toString().padStart(12, "0");
    const jobId = `d6100000-0000-4000-8000-${suffix}`;
    const attemptId = `d6200000-0000-4000-8000-${suffix}`;
    const outboxId = `d6300000-0000-4000-8000-${suffix}`;
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
         'system', 'de-006-test', 'worker', ${WORKER}, ${workload},
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

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-de006-"));
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
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DE-06 org', 'de-006-org')`;
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${OTHER_ORG}, 'DE-06 other', 'de-006-other')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'DE-06 company', 'D006')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${OTHER_COMPANY}, ${OTHER_ORG}, 'DE-06 other company', 'D006O')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'de-006-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'de-006-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'DE-06 worker', 'enrolled')`;
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

  it("setup: nothing has been refused yet, so neither tenant's activity log holds anything", async () => {
    ctx();
    expect(await activityRowCount(COMPANY)).toBe(0);
    expect(await activityRowCount(OTHER_COMPANY)).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE GRANT PATH — "object put/get ... attempts are audited"
  // ───────────────────────────────────────────────────────────────────────────

  it("★ THE CROSS-TENANT CLAUSE (upload grant) — a key under a FOREIGN organization's prefix is refused, and that refusal writes ONE row attributing WHO / TENANT / RESOURCE / WHY", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage: makeStubStorage() });
    const probeKey = foreignKey(offer.job.jobId);
    const { request, artifactId } = grantRequest(offer, "upload", { expectedObjectKey: probeKey });

    expect(await denialRowsFor(artifactId)).toHaveLength(0);
    const res = await svc.grant({ auth: auth(`x-${crypto.randomUUID()}`), request });

    // The refusal itself, and the coarse non-disclosing wire reason.
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.reason).toBe("malformed");

    const rows = await denialRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // WHO — the refused worker, not "system"-anonymous, not the empty string.
    expect(row.actor_id).toBe(WORKER);
    expect(row.actor_type).toBe("system");
    // TENANT — the company of the LOCKED LEASE, i.e. the tenant that refused.
    expect(row.company_id).toBe(COMPANY);
    expect(row.company_id).not.toBe(OTHER_COMPANY);
    // RESOURCE.
    expect(row.entity_type).toBe("job_artifact");
    expect(row.entity_id).toBe(artifactId);
    // WHY — a stable machine code, plus the crossing and the refusing control.
    expect(row.action).toBe("security.denied.artifact_transfer_grant");
    expect(row.details?.reason).toBe("foreign_object_prefix");
    expect(row.details?.crossing).toBe("DE-06");
    expect(String(row.details?.control)).toContain("artifact-transfer-grant.ts");
    // ★ THE EVIDENCE THE WIRE HIDES: the key that was actually asked for, carrying
    // the foreign organization segment. Without this the row would say a key was
    // refused and never say which — the count-only shape this crossing already had.
    expect(row.details?.requestedObjectKey).toBe(probeKey);
    expect(String(row.details?.requestedObjectKey)).toContain(OTHER_ORG);
    expect(String(row.details?.expectedObjectKeyPrefix)).toContain(ORG);
    expect(row.details?.operation).toBe("upload");
  });

  it("★ THE PROBED TENANT LEARNS NOTHING — the cross-tenant probe wrote into the prober's own tenant and not into the tenant it reached for", async () => {
    ctx();
    expect(await activityRowCount(OTHER_COMPANY)).toBe(0);
    expect(await activityRowCount(COMPANY)).toBeGreaterThan(0);
  });

  it("★ REASON IS READ FROM THE BRANCH, NOT STAMPED — a different refusal on the SAME path records a different code behind the SAME opaque wire reason", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage: makeStubStorage() });
    const { request, artifactId } = grantRequest(offer, "upload", {
      maxBytes: DEFAULT_MAX_ARTIFACT_BYTES + 1,
    });

    const res = await svc.grant({ auth: auth(`o-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    // Identical wire text: the caller cannot tell this apart from the probe above.
    if (res.outcome === "rejected") expect(res.reason).toBe("malformed");

    const rows = await denialRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    // ...and the audit CAN. This is the whole point of the record.
    expect(rows[0].details?.reason).toBe("declared_size_over_ceiling");
    expect(rows[0].details?.reason).not.toBe("foreign_object_prefix");
    expect(rows[0].details?.ceilingBytes).toBe(DEFAULT_MAX_ARTIFACT_BYTES);
    expect(rows[0].company_id).toBe(COMPANY);
  });

  it("★ THE DOWNLOAD HALF — 'object get' is audited too, and a foreign-prefix GET is recorded as a key attempt rather than as an ordinary miss", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage: makeStubStorage() });
    const probeKey = foreignKey(offer.job.jobId, "leaked.bin");
    const { request, artifactId } = grantRequest(offer, "download", { expectedObjectKey: probeKey });

    const res = await svc.grant({ auth: auth(`d-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.reason).toBe("malformed");

    const rows = await denialRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    expect(rows[0].details?.operation).toBe("download");
    // NOT `artifact_not_committed`: the tenant-scoped lookup would always miss on a
    // foreign key, so recording the miss would have hidden the cross-tenant attempt.
    expect(rows[0].details?.reason).toBe("foreign_object_prefix");
    expect(String(rows[0].details?.requestedObjectKey)).toContain(OTHER_ORG);
  });

  it("★ AND AN ORDINARY MISS IS STILL TOLD APART — an in-tenant download of an uncommitted artifact records `artifact_not_committed`", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage: makeStubStorage() });
    const { request, artifactId } = grantRequest(offer, "download");

    const res = await svc.grant({ auth: auth(`m-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    const rows = await denialRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    expect(rows[0].details?.reason).toBe("artifact_not_committed");
  });

  it("★ A `guardActiveFence` REFUSAL IS RECORDED TOO — the branch DE-04/DE-18 turn on, exercised here at one of its callers", async () => {
    const { app, admin } = ctx();
    const offer = await activateLease();
    // Kill the fence the way the DAT-002 suite does: the lease is expired, so
    // `lockActiveFence` raises JobFenceError('stale_fence') INSIDE the tenant
    // transaction. The refusal is a throw the service catches and turns into a
    // `rejected` return — so the transaction still COMMITS, and the intent
    // recorded in the catch drains on the pool handle afterwards.
    //
    // ★ AND THIS ARM'S REACH IS EXACTLY THAT ONE CATCH. The lease tuple still
    // MATCHES here (only its deadlines moved), so `resolveWorkerFenceContext`
    // resolves and its own `stale_fence`/`target_revoked` throws are never
    // exercised. Those are driven, and pinned as unrecorded, two arms below.
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() - interval '2 seconds',
      expires_at = clock_timestamp() - interval '1 second' WHERE id = ${offer.leaseId}`;
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage: makeStubStorage() });
    const { request, artifactId } = grantRequest(offer, "upload");

    const res = await svc.grant({ auth: auth(`f-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.reason).toBe("stale_fence");

    const rows = await denialRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    expect(rows[0].details?.reason).toBe("stale_fence");
    expect(rows[0].company_id).toBe(COMPANY);
    expect(rows[0].actor_id).toBe(WORKER);
    expect(rows[0].details?.leaseId).toBe(offer.leaseId);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ★ THE GAP THAT WAS PINNED HERE IS NOW WIRED, AND THESE ARMS ARE INVERTED
  // RATHER THAN DELETED. Until this unit the two arms below asserted that
  // `resolveWorkerFenceContext`'s ORGANIZATION-ONLY throws left NOTHING, and the
  // comment they carried said in terms that they must be INVERTED when the
  // wiring landed. It has: `E0-F013` Decision 2 was ruled option (a2) and shipped
  // (migration `0274`), `activity_log.company_id` is nullable inside the reserved
  // `security.denied.` namespace, a nullable `organization_id` sits beside it,
  // and all five sites now record the organization their token attests.
  //
  // ★ THE `rejects` ASSERTION STILL FIRES FIRST, AND THAT ORDERING IS THE POINT.
  // It is the reachability control: without it, a fixture that stopped reaching
  // the branch would pass by vacuity — first as "no row was written" (the old
  // shape) and now as a stale row left by an earlier arm. The row assertions are
  // keyed on `details.presentedLeaseId`, which is per-activation, so a row from a
  // previous arm cannot satisfy them either.
  //
  // ★ WHAT IS STILL NOT PROVEN HERE, stated rather than implied. Of the SIX
  // throw sites, this file provokes FOUR through the real path — `:86` proof
  // replay, `:100` in BOTH of its codes (missing authority / not-current
  // authority), and `:121` no-lease-resolved — plus the tuple-integrity branch
  // further down. `:103` (target inactive) and `:108` (profile drift) are
  // STRUCTURALLY UNREACHABLE behind `ackAuthorityCurrent`, whose conjunction at
  // `:100` already requires `target.status === "active"`, the matching device
  // generation, and a non-revoked worker — every condition those two later
  // branches test. They are compiled and reviewable but unprovoked, and an arm
  // below PINS that their reason codes never appear, so the day one becomes
  // reachable this file goes red naming it.
  //
  // ★ AND DE-06 STILL DOES NOT CLOSE. Its audit clause is a conjunction and the
  // `object put/get` half — a SUCCESSFUL grant — writes nothing at the tree's
  // only production `presignGet` call site. Nothing below asserts one.
  //
  // ★ THE HISTORICAL NOTE, kept because it is what makes the inversion legible:
  //
  // The `guardActiveFence` arm above expires a lease whose tuple still MATCHES,
  // so `lockLeaseAckContext` still resolves and the refusal lands on the LATER
  // `lockActiveFence` catch. That arm therefore cannot reach
  // `resolveWorkerFenceContext`'s OWN throws — a test that appears to cover a
  // branch it cannot reach. The two arms below drive those throws directly: a
  // lease tuple that no longer resolves (`stale_fence`) and a revoked target
  // authority (`target_revoked`).
  //
  // They assert what is TRUE TODAY, which is that NOTHING is recorded, and they
  // are written aspiration-first: `rejects` fires before the row assertion, so a
  // fixture that stopped reaching the branch would fail LOUDLY rather than pass
  // by vacuity. Observed in this shape against the current tree.
  //
  // ★ WHY THESE TWO ARE STILL NOT WIRED — and why a THIRD one now is.
  // The transaction was never the blocker: a drain point outside `runInTenant` is
  // a `.finally`, and that is exactly what the three services now do.
  // ATTRIBUTION is the blocker, and it is not uniform across the six throw sites.
  // At the FIVE sites these two arms drive, `workers` and `execution_targets`
  // carry `organization_id` only and the one row that carries `company_id` — the
  // lease — is precisely what failed to resolve.
  //
  // ★ UPDATED 2026-09-09 — AND THE REASON THOSE FIVE ARE STILL UNWIRED HAS
  // CHANGED, so do not read the sentence above as the whole story. Until the
  // ruling, `activity_log.company_id` was NOT NULL with a cascade FK, so
  // `recordSecurityDenial` would log-and-return-null: the STORAGE was the
  // blocker. `E0-F013` Decision 2 was then ruled, option (a2) — `company_id` is
  // nullable inside the `security.denied.` namespace, guarded by a partial CHECK,
  // and a nullable `organization_id` exists — so the storage blocker is GONE and
  // all five of these throws could record the organization they do hold.
  // WHAT REMAINS IS THE WIRING, and nothing else. That is exactly what the two
  // arms below pin: they assert NO row, and when the wiring lands they must be
  // INVERTED rather than deleted.
  //
  // Of the two escapes the finding weighed, neither was taken: resolving the
  // company from the CALLER-SUPPLIED `jobId` was option (c) and was NOT ruled —
  // it lets a prober choose which of its own tenants absorbs the record — and
  // widening the shared helper is not a DE-06-scoped change, since
  // `resolveWorkerFenceContext` is shared by FOUR services (artifact-commit,
  // artifact-transfer-grant, patch-apply, secret-broker).
  //
  // The SIXTH — the post-resolution tuple-integrity branch — is different: by
  // then the lease has been resolved AND inner-joined to `job_attempts` on
  // `company_id`, so an FK-valid company is in hand. It was wired on 2026-09-09
  // and is proven by the "TUPLE-INTEGRITY FENCE REFUSAL IS RECORDED" arms further
  // down. THE TWO ARMS IMMEDIATELY BELOW THIS COMMENT are those arms' NAMED
  // POSITIVE CONTROLS: remove the recorder and they must stay green while the
  // tuple-integrity arms go red. Observed in exactly that shape.
  //
  // ★ AND THE FIRST ARM BELOW IS ALSO THE `:110`-vs-tuple-integrity FIXTURE PIN.
  // A superseded fence changes the LOOKUP key, so `lockLeaseAckContext` returns
  // NO ROW and the refusal lands on `!context` — never on the tuple-integrity
  // branch. If that ever stopped being true this arm would go red naming it,
  // which is the mistake §3(d) of the Decision 2 paper records having been made
  // once already.
  // ───────────────────────────────────────────────────────────────────────────

  it("★ THE `:121` FENCE-AUTH REFUSAL IS RECORDED — a superseded lease tuple is refused on BOTH paths and each writes ONE organization-attributed, company-null row", async () => {
    const { app, admin } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const beforeCompany = await activityRowCount(COMPANY);
    const beforeTenantless = await tenantlessRowCount(ORG);
    // The lease tuple no longer RESOLVES: `lockLeaseAckContext` looks the lease up
    // BY the presented fence, so a superseded fence finds no row at all and
    // `resolveWorkerFenceContext` throws before `lockActiveFence` is ever reached.
    // ★ This is ALSO the `:121`-vs-tuple-integrity fixture pin: if a superseded
    // fence ever started landing on the tuple-integrity branch instead, the reason
    // asserted below would change and this arm would go red naming it.
    await admin`UPDATE leases SET fence = ${"9".repeat(32)} WHERE id = ${offer.leaseId}`;

    const grantSvc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const g = grantRequest(offer, "upload");
    // REACHABILITY CONTROL, asserted FIRST: the branch really is reached, and it
    // is reached as a THROW. Without this a fixture that stopped reaching the
    // branch would pass on a row left by some other arm.
    await expect(
      grantSvc.grant({ auth: auth(`sl-${crypto.randomUUID()}`), request: g.request }),
    ).rejects.toBeInstanceOf(JobLeasingError);

    const afterGrant = await fenceOrgDenialRowsFor(offer.leaseId);
    expect(afterGrant).toHaveLength(1);
    const row = afterGrant[0]!;
    // WHY — the branch, not the wire code. The worker saw only `stale_fence`.
    expect(row.details?.reason).toBe("lease_unresolved");
    // TENANT — the ORGANIZATION axis only. `company_id` is null because nothing
    // in scope resolves one: the lease is exactly what failed to resolve.
    expect(row.company_id).toBeNull();
    expect(row.organization_id).toBe(ORG);
    // WHO — the refused worker, as a machine identity.
    expect(row.actor_id).toBe(WORKER);
    expect(row.actor_type).toBe("system");
    // RESOURCE — the lease the worker PRESENTED, named as unresolved.
    expect(row.entity_type).toBe("job_lease");
    expect(row.entity_id).toBe(offer.leaseId);
    expect(row.details?.operation).toBe("artifact_transfer_grant");
    expect(row.details?.crossings).toEqual(["DE-06"]);

    const commitSvc = createArtifactCommitService({ appDb: app.db, storage });
    const c = commitRequest(offer);
    await expect(
      commitSvc.commit({ auth: auth(`slc-${crypto.randomUUID()}`), request: c.request }),
    ).rejects.toBeInstanceOf(JobLeasingError);
    const afterCommit = await fenceOrgDenialRowsFor(offer.leaseId);
    // The DISTINGUISHING assertion: two independent drains, one recorder.
    expect(afterCommit).toHaveLength(2);
    expect(afterCommit[1]!.details?.operation).toBe("artifact_commit");
    expect(afterCommit[1]!.details?.reason).toBe("lease_unresolved");

    // The artifact-keyed view still sees nothing — this is not an artifact
    // refusal — and neither is the COMPANY-keyed log, which is the whole shape of
    // a tenantless record. The tenantless sink is where the two rows landed.
    expect(await denialRowsFor(g.artifactId)).toHaveLength(0);
    expect(await denialRowsFor(c.artifactId)).toHaveLength(0);
    expect(await activityRowCount(COMPANY)).toBe(beforeCompany);
    expect(await tenantlessRowCount(ORG)).toBe(beforeTenantless + 2);
  });

  it("★ THE `:100` FENCE-AUTH REFUSAL IS RECORDED — a revoked target authority is refused on BOTH paths and records `authority_not_current`", async () => {
    const { app, admin } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const beforeCompany = await activityRowCount(COMPANY);
    const beforeTenantless = await tenantlessRowCount(ORG);
    // A revoked authority: the target is no longer active. `ackAuthorityCurrent`
    // itself requires `target.status === "active"`, so the refusal lands on the
    // `:100` recheck — NOT on the later `:103` target-inactive branch, which this
    // arm's reason assertion therefore also pins.
    await admin`UPDATE execution_targets SET status = 'disabled' WHERE id = ${TARGET}`;

    const grantSvc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const g = grantRequest(offer, "upload");
    await expect(
      grantSvc.grant({ auth: auth(`rv-${crypto.randomUUID()}`), request: g.request }),
    ).rejects.toBeInstanceOf(JobLeasingError);
    const afterGrant = await fenceOrgDenialRowsFor(offer.leaseId);
    expect(afterGrant).toHaveLength(1);
    const row = afterGrant[0]!;
    // The authority ROW existed and was refused as stale — a different code from
    // the missing-authority arm below, at the SAME line and behind two different
    // wire answers (`target_revoked` here, `unauthorized` there).
    expect(row.details?.reason).toBe("authority_not_current");
    expect(row.company_id).toBeNull();
    expect(row.organization_id).toBe(ORG);
    expect(row.entity_type).toBe("execution_target");
    expect(row.entity_id).toBe(TARGET);
    expect(row.actor_id).toBe(WORKER);

    const commitSvc = createArtifactCommitService({ appDb: app.db, storage });
    const c = commitRequest(offer);
    await expect(
      commitSvc.commit({ auth: auth(`rvc-${crypto.randomUUID()}`), request: c.request }),
    ).rejects.toBeInstanceOf(JobLeasingError);
    const afterCommit = await fenceOrgDenialRowsFor(offer.leaseId);
    expect(afterCommit).toHaveLength(2);
    expect(afterCommit[1]!.details?.operation).toBe("artifact_commit");

    expect(await denialRowsFor(g.artifactId)).toHaveLength(0);
    expect(await activityRowCount(COMPANY)).toBe(beforeCompany);
    expect(await tenantlessRowCount(ORG)).toBe(beforeTenantless + 2);

    await admin`UPDATE execution_targets SET status = 'active' WHERE id = ${TARGET}`;
  });

  it("★ THE SAME LINE, THE OTHER CODE — an attested target that no longer EXISTS records `authority_missing`, not `authority_not_current`", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const beforeTenantless = await tenantlessRowCount(ORG);
    // `lockWorkerLeaseAuthority` returns null when the attested target has no row
    // at all (`job-control.ts`: the unlocked authority-key probe returns nothing).
    // A worker token minted before the target was torn down is exactly this case,
    // and the session artefact still attests the organization — which is why the
    // row is writable at all.
    const missingTarget = "d6000000-0000-4000-8000-00000000dead";
    const staleAuth = { ...auth(`am-${crypto.randomUUID()}`), targetId: missingTarget };

    const grantSvc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const g = grantRequest(offer, "upload");
    await expect(
      grantSvc.grant({ auth: staleAuth, request: g.request }),
    ).rejects.toBeInstanceOf(JobLeasingError);

    const rows = await fenceOrgDenialRowsFor(offer.leaseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details?.reason).toBe("authority_missing");
    expect(rows[0]!.company_id).toBeNull();
    expect(rows[0]!.organization_id).toBe(ORG);
    expect(rows[0]!.entity_id).toBe(missingTarget);
    expect(await tenantlessRowCount(ORG)).toBe(beforeTenantless + 1);
  });

  it("★ THE `:86` REPLAY REFUSAL IS RECORDED, AND IT SERVES TWO CROSSINGS — a spent proof id on the grant path writes DE-03's replay row", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const beforeTenantless = await tenantlessRowCount(ORG);
    // A REAL replay, not a constructed one: the first grant SUCCEEDS and commits
    // the proof row, so the second presents a genuinely spent (thumbprint, proof
    // id) pair and the real unique constraint refuses it.
    const spentProof = `rp-${crypto.randomUUID()}`;
    const grantSvc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const first = grantRequest(offer, "upload");
    const granted = await grantSvc.grant({ auth: auth(spentProof), request: first.request });
    expect(granted.outcome).toBe("upload_granted");

    const g = grantRequest(offer, "upload");
    await expect(
      grantSvc.grant({ auth: auth(spentProof), request: g.request }),
    ).rejects.toBeInstanceOf(JobLeasingError);

    const rows = await proofDenialRowsFor(spentProof);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details?.reason).toBe("proof_replayed");
    expect(rows[0]!.company_id).toBeNull();
    expect(rows[0]!.organization_id).toBe(ORG);
    expect(rows[0]!.entity_type).toBe("worker_proof");
    expect(rows[0]!.entity_id).toBe(spentProof);
    // ★ THIS SITE SERVES BOTH CROSSINGS — it is DE-06's `:75` fence throw AND
    // DE-03's `worker-fence-context.ts:68` `recordProof` site. A row naming only
    // one of them would under-report the other crossing's coverage.
    expect(rows[0]!.details?.crossings).toEqual(["DE-03", "DE-06"]);
    expect(await tenantlessRowCount(ORG)).toBe(beforeTenantless + 1);
    // The SUCCESSFUL first grant is the positive control inside this arm: it
    // wrote no denial row of its own.
    expect(await denialRowsFor(first.artifactId)).toHaveLength(0);
  });

  it("★ PINNED AS UNREACHABLE — `:103` target-inactive and `:108` profile-drift have never fired, and this arm goes red the day one does", async () => {
    const { admin } = ctx();
    // Every condition those two branches test is already a conjunct of
    // `ackAuthorityCurrent` at `:100` (`target.status === "active"`, the matching
    // device generation, a non-revoked worker), so no legal row can reach them.
    // They are wired and reviewable but UNPROVOKED, and this file says so rather
    // than letting a compiled branch read as a proven one.
    const rows = await admin<{ reason: string }[]>`
      SELECT details->>'reason' AS reason FROM activity_log
      WHERE action = 'security.denied.worker_fence_resolution'
        AND details->>'reason' IN ('target_inactive', 'profile_drift')`;
    expect(
      rows.map((r) => r.reason),
      "one of the two structurally-unreachable fence throws fired — it is now provokable, so prove it directly and invert this pin",
    ).toEqual([]);
    // POSITIVE CONTROL for the query itself: the reasons that DO fire are visible
    // to exactly this predicate, so an empty result above is a fact and not a typo.
    const live = await admin<{ reason: string }[]>`
      SELECT DISTINCT details->>'reason' AS reason FROM activity_log
      WHERE action = 'security.denied.worker_fence_resolution'
        AND details->>'reason' IN ('lease_unresolved', 'authority_not_current', 'authority_missing')`;
    expect(live.length).toBeGreaterThan(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ★ THE ONE FENCE THROW THAT RESOLVES A COMPANY — the post-resolution
  // tuple-integrity branch. (Its heading used to read "THE ONE FENCE THROW THAT
  // IS ATTRIBUTABLE", and that stopped being true above: all six now record. The
  // difference is the AXIS — five carry only a token-attested organization, and
  // this one carries an FK-valid company as well.) The lease RESOLVES (organization, lease id, job,
  // attempt number, worker, target, generation, profile hash and fence all match
  // `lockLeaseAckContext`'s lookup) and is then rejected on a residual conjunct
  // the lookup does not cover. By then it has inner-joined `job_attempts` on
  // `company_id`, so the refusal has an FK-valid tenant and can be recorded.
  //
  // ★ THE PROVOCATION IS A LEGAL ROW, not a hand-built one. `provider_constraint_hash`
  // is outside the lookup key and the `leases_authority_atomic_check` CHECK
  // permits any 64-hex value, so drifting it models the real event: the target's
  // provider-constraint profile moved after the lease was minted. (The `expires_at`
  // and `company_id` disjuncts CANNOT be provoked this way — the same CHECK forbids
  // nulling them while the rest of the tuple is populated, which is precisely why
  // the recorder takes a runtime narrow instead of a non-null assertion.)
  // ───────────────────────────────────────────────────────────────────────────

  it("★ THE TUPLE-INTEGRITY FENCE REFUSAL IS RECORDED — a resolved lease that disagrees with the CURRENT target writes the ONE row on this path that names a COMPANY, not just an organization", async () => {
    const { app, admin } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const before = await activityRowCount(COMPANY);
    await admin`UPDATE leases SET provider_constraint_hash = ${"c".repeat(64)} WHERE id = ${offer.leaseId}`;

    const grantSvc = createArtifactTransferGrantService({ appDb: app.db, storage });
    const g = grantRequest(offer, "upload");
    // POSITIVE CONTROL for the fixture: the branch really is reached, and it is
    // reached as a THROW (a `rejected` return would mean a different branch fired).
    await expect(
      grantSvc.grant({ auth: auth(`ti-${crypto.randomUUID()}`), request: g.request }),
    ).rejects.toBeInstanceOf(JobLeasingError);

    const rows = await fenceDenialRowsFor(offer.leaseId);
    expect(rows).toHaveLength(1);
    // WHO — the refused worker, carried in plain-text `actor_id` because a worker
    // has no `agents` row and no `auth` row.
    expect(rows[0].actor_id).toBe(WORKER);
    expect(rows[0].actor_type).toBe("system");
    // TENANT — the LOCKED LEASE's company, resolved under the worker's own org GUC.
    expect(rows[0].company_id).toBe(COMPANY);
    // RESOURCE — the lease, not the artifact: the control refused before any
    // artifact was authorized, so naming the artifact would be a fiction.
    expect(rows[0].entity_type).toBe("job_lease");
    expect(rows[0].entity_id).toBe(offer.leaseId);
    // WHY — the branch, not the wire code. The worker saw only `stale_fence`.
    expect(rows[0].details?.reason).toBe("fence_tuple_mismatch");
    expect(rows[0].details?.mismatched).toEqual(["provider_constraint_hash"]);
    expect(rows[0].details?.operation).toBe("artifact_transfer_grant");
    expect(rows[0].details?.crossing).toBe("DE-06");
    // ...and the row is the ONLY thing appended.
    expect(await activityRowCount(COMPANY)).toBe(before + 1);
    // The artifact-keyed view still sees nothing: this refusal is not an
    // artifact-operation refusal and must not be counted as one.
    expect(await denialRowsFor(g.artifactId)).toHaveLength(0);
  });

  // ★ MEASURED, so the single-conjunct coverage below is not read as laziness.
  // Of the seven mismatch conjuncts, SIX cannot be provoked through the real
  // path at all, and each is closed by a different structure:
  //   `job_id`, `attempt_number`, `target_id`, `target_generation`,
  //   `profile_hash` — all appear in `lockLeaseAckContext`'s own WHERE, so a
  //     drifted value stops the lease JOINING and the refusal lands on `:110`.
  //   `target_authority_key` — FK-pinned from BOTH sides. `leases_target_authority_fk`
  //     is composite on `(target_authority_key, target_id) → execution_targets`, and
  //     `workers_target_authority_fk` is the same on the worker; the worker also
  //     carries a CHECK forcing `organization:<org-id>`. Observed: an `UPDATE leases
  //     SET target_authority_key = …` is refused by the FK, so this conjunct cannot
  //     be reached without standing up a second target AND a second worker.
  // `provider_constraint_hash` is the ONE that a legal row can drift, and it is
  // therefore the conjunct both arms use. The arm below proves the OTHER SERVICE's
  // drain, not another conjunct — which is what its name now says.
  it("★ THE SAME BRANCH ON THE COMMIT PATH — the second service drains it too, and the row names the conjunct that fired", async () => {
    const { app, admin } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    storage.headResult = { exists: true, contentLength: 128, checksumSha256: "b".repeat(64) };
    await admin`UPDATE leases SET provider_constraint_hash = ${"d".repeat(64)} WHERE id = ${offer.leaseId}`;

    const commitSvc = createArtifactCommitService({ appDb: app.db, storage });
    const c = commitRequest(offer);
    await expect(
      commitSvc.commit({ auth: auth(`tic-${crypto.randomUUID()}`), request: c.request }),
    ).rejects.toBeInstanceOf(JobLeasingError);

    const rows = await fenceDenialRowsFor(offer.leaseId);
    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe(COMPANY);
    expect(rows[0].details?.reason).toBe("fence_tuple_mismatch");
    expect(rows[0].details?.mismatched).toEqual(["provider_constraint_hash"]);
    // The distinguishing assertion: this row came from the COMMIT service's drain,
    // not the grant service's — two independent `.finally` wirings, one recorder.
    expect(rows[0].details?.operation).toBe("artifact_commit");
    // ...and the object store was never touched: the fence refusal precedes the
    // `headObject` probe, so there is no cross-tenant existence oracle here.
    expect(storage.headCalls).toBe(0);
  });

  it("★ THE PROBED TENANT LEARNS NOTHING FROM A FENCE REFUSAL EITHER — the row landed in the lease's own company and the second tenant's log is still empty", async () => {
    const { admin } = ctx();
    // Every fence refusal above belongs to COMPANY. OTHER_COMPANY has never been
    // written to by this mechanism, and a cross-tenant write would show here.
    const rows = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log
      WHERE company_id = ${OTHER_COMPANY}
        AND action = 'security.denied.worker_fence_resolution'`;
    expect(Number(rows[0]?.n ?? "-1")).toBe(0);
  });

  it("POSITIVE CONTROL — a GRANTED upload writes NO denial row (so 'always write a denial' fails this file)", async () => {
    const { app, admin } = ctx();
    const offer = await activateLease();
    const svc = createArtifactTransferGrantService({ appDb: app.db, storage: makeStubStorage() });
    const before = await activityRowCount(COMPANY);
    const { request, artifactId } = grantRequest(offer, "upload");

    const res = await svc.grant({ auth: auth(`ok-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("upload_granted");
    expect(await denialRowsFor(artifactId)).toHaveLength(0);
    // ★ AMENDED 2026-09-10 BY THE PUT/GET UNIT, and the amendment is the point.
    // This arm used to assert `toBe(before)` — "nothing at all was appended" —
    // which was TRUE and was exactly DE-06's other open conjunct: a successful
    // grant left no trace. It now appends ONE row, in the OBJECT-ACCESS
    // namespace and NOT in the denial namespace, so the control this arm exists
    // for ("always write a denial" must fail this file) still holds and is
    // asserted directly rather than inferred from a total count.
    expect(await activityRowCount(COMPANY)).toBe(before + 1);
    const appended = await admin<{ action: string }[]>`
      SELECT action FROM activity_log
      WHERE company_id = ${COMPANY} AND entity_id = ${artifactId}`;
    expect(appended).toHaveLength(1);
    expect(appended[0]!.action).toBe("security.object_access.artifact_upload_grant");
    expect(appended[0]!.action.startsWith("security.denied.")).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE COMMIT PATH — where the only prior trace was a count-only metric
  // ───────────────────────────────────────────────────────────────────────────

  it("★ THE COMMIT HALF, CROSS-TENANT — a SELF-CONSISTENT manifest for a FOREIGN organization is refused, and the row names both the foreign key and the foreign claim", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    storage.headResult = { exists: true, contentLength: 128, checksumSha256: "b".repeat(64) };
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    // ★ The manifest must be INTERNALLY consistent to get through the frozen
    // wire schema at all: `artifactManifestV1Schema`'s superRefine requires
    // objectKey to sit under `organizations/<manifest.organizationId>/…`. So the
    // real cross-tenant commit probe declares the foreign org AND carries the
    // matching foreign key — which is what a worker attempting to write into
    // another tenant's namespace would actually have to send.
    const probeKey = foreignKey(offer.job.jobId, "commit.bin");
    const { request, artifactId } = commitRequest(offer, {
      organizationId: OTHER_ORG,
      companyId: OTHER_COMPANY,
      objectKey: probeKey,
    });

    const res = await svc.commit({ auth: auth(`ct-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.reason).toBe("malformed");

    const rows = await denialRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.action).toBe("security.denied.artifact_commit");
    // The mutator checks prefix before tenant, so this is the branch that fires.
    expect(row.details?.reason).toBe("foreign_object_prefix");
    expect(row.details?.verificationBranch).toBe("wrong_prefix");
    expect(row.actor_id).toBe(WORKER);
    // The row lands in the tenant that REFUSED, resolved from the LOCKED LEASE —
    // never in the tenant the manifest claimed for itself.
    expect(row.company_id).toBe(COMPANY);
    expect(row.details?.requestedObjectKey).toBe(probeKey);
    expect(String(row.details?.requestedObjectKey)).toContain(OTHER_ORG);
    // ...and the self-asserted tenancy is kept too, so an operator can see the
    // worker claimed to be another tenant rather than merely mistyped a key.
    expect(row.details?.declaredOrganizationId).toBe(OTHER_ORG);
    expect(row.details?.declaredCompanyId).toBe(OTHER_COMPANY);
    expect(await activityRowCount(OTHER_COMPANY)).toBe(0);
  });

  it("★ THE COMMIT HALF, REASON READ FROM THE BRANCH — a content-hash refusal on the same path records a DIFFERENT code and a different wire reason", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    // The store observes a different digest than the manifest declares.
    storage.headResult = { exists: true, contentLength: 128, checksumSha256: "c".repeat(64) };
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { request, artifactId } = commitRequest(offer);

    const res = await svc.commit({ auth: auth(`ch-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.reason).toBe("event_hash_mismatch");

    const rows = await denialRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    expect(rows[0].details?.reason).toBe("declared_hash_mismatch");
    expect(rows[0].details?.reason).not.toBe("foreign_object_prefix");
    expect(rows[0].details?.verificationBranch).toBe("hash_mismatch");
    expect(rows[0].company_id).toBe(COMPANY);
  });

  it("POSITIVE CONTROL — a COMMITTED artifact writes NO denial row", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    storage.headResult = { exists: true, contentLength: 128, checksumSha256: "b".repeat(64) };
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const before = await activityRowCount(COMPANY);
    const { request, artifactId } = commitRequest(offer);

    const res = await svc.commit({ auth: auth(`cok-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("committed");
    expect(await denialRowsFor(artifactId)).toHaveLength(0);
    expect(await activityRowCount(COMPANY)).toBe(before);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ★ THE ARGUMENT, PINNED — why the row can exist at all.
  //
  // Every refusal above that IS recorded (the returning ones — not the two
  // pinned fence-auth arms, which record nothing) is recorded from INSIDE a
  // request whose tenant context is the refusing worker's own organization. The
  // recorder writes to `activity_log` specifically because that table sits
  // OUTSIDE the tenant RLS kernel: an RLS-forced table would refuse the denial
  // write for the same reason a cross-tenant read is refused. If `activity_log`
  // is ever folded into the kernel, every recording arm above would go red as
  // "the row is missing" without saying why. These arms name the change instead.
  // ───────────────────────────────────────────────────────────────────────────

  it("★ activity_log sits OUTSIDE the tenant RLS kernel — and the kernel is genuinely present on this database", async () => {
    const { admin } = ctx();
    const posture = (await admin<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: string;
      org_col: string;
    }[]>`
      SELECT c.relrowsecurity,
             c.relforcerowsecurity,
             (SELECT count(*)::text FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = 'activity_log') AS policies,
             (SELECT count(*)::text FROM information_schema.columns col
               WHERE col.table_schema = 'public'
                 AND col.table_name = 'activity_log'
                 AND col.column_name = 'organization_id') AS org_col
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'activity_log'`)[0];

    expect(posture, "activity_log must exist").toBeTruthy();
    expect(
      posture.relrowsecurity,
      "activity_log has ENABLE ROW LEVEL SECURITY — it is now inside the tenant kernel and a denial recorded under a wrong/absent org GUC can no longer be written",
    ).toBe(false);
    expect(
      posture.relforcerowsecurity,
      "activity_log has FORCE ROW LEVEL SECURITY — the denial recorder now lives behind the policy it exists to observe",
    ).toBe(false);
    expect(posture.policies, "activity_log grew row-level policies").toBe("0");
    // ★ AMENDED 2026-09-09 — E0-F013 Decision 2, ruled option (a2). This line
    // used to assert `.toBe("0")`: the ABSENCE of an `organization_id` column
    // stood in for "activity_log is not a kernel table". The ruling adds that
    // column deliberately (as a NULLABLE attribution column for denials that
    // resolve no company), so the proxy is now false while the property it stood
    // for is unchanged. Replaced, not deleted. What made a kernel tenant key a
    // kernel tenant key is that it is NOT NULL and READ BY A POLICY — the policy
    // half is `posture.policies === "0"` on the line above; the NOT NULL half is
    // asserted here. The same reasoning is written out at length in
    // `de-19-memory-denial-audit.integration.test.ts`.
    expect(
      posture.org_col,
      "activity_log lost its organization_id column — E0-F013 Decision 2 (a2) requires it, and five of DE-06's six fence throws have no other tenant axis to be recorded on",
    ).toBe("1");
    const nullability = await admin<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'activity_log'
        AND column_name IN ('company_id', 'organization_id')
      ORDER BY column_name`;
    expect(
      nullability.map((r) => `${r.column_name}=${r.is_nullable}`),
      "a tenant column on activity_log became NOT NULL — that is the kernel shape, and a denial that resolves neither axis can no longer be recorded at all",
    ).toEqual(["company_id=YES", "organization_id=YES"]);

    // POSITIVE CONTROL for the assertion itself: four false/0 readings are also
    // what a database with NO RLS at all would report.
    const forced = await admin<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
      ORDER BY c.relname`;
    expect(
      forced.length,
      "no table on this database is FORCE-RLS, so the contrast asserted above is meaningless here",
    ).toBeGreaterThan(0);
    expect(forced.map((r) => r.relname)).toContain("jobs");
  });

  it("★ EVERY DENIAL ROW LANDED IN THE RESERVED NAMESPACE, and nothing else was written to either tenant's log", async () => {
    const { admin } = ctx();
    const rows = await admin<{ action: string; company_id: string | null; organization_id: string | null }[]>`
      SELECT action, company_id, organization_id FROM activity_log ORDER BY created_at`;
    expect(rows.length).toBeGreaterThanOrEqual(6);
    // ★ AMENDED 2026-09-10 BY THE PUT/GET UNIT. This loop asserted that EVERY row
    // in `activity_log` is a `security.denied.` row. That was true while a
    // refusal was the only thing this file could produce; the granted-upload
    // positive control above now also writes an OBJECT-ACCESS row. The property
    // this arm exists for is unchanged and is now stated exactly: every row is in
    // ONE OF THE TWO reserved audit namespaces, and a row in neither still fails.
    // The `security.object_access.` rows are then excluded from the denial-shape
    // assertions below, which are about denials.
    const reserved = ["security.denied.", "security.object_access."];
    for (const row of rows) {
      expect(
        reserved.some((prefix) => row.action.startsWith(prefix)),
        `row action ${row.action} is in neither reserved audit namespace`,
      ).toBe(true);
    }
    // A NAMED POSITIVE CONTROL for the widening: the object-access namespace is
    // genuinely represented here, so the extra prefix is not dead allowance.
    expect(rows.some((r) => r.action.startsWith("security.object_access."))).toBe(true);
    const denialRows = rows.filter((r) => r.action.startsWith("security.denied."));
    expect(denialRows.length).toBeGreaterThanOrEqual(6);
    for (const row of denialRows) {
      expect(row.action.startsWith("security.denied.")).toBe(true);
      // Two shapes and NO third: a company-attributed row in THIS company, or a
      // tenantless row in THIS organization. A row naming another tenant, or one
      // attributed to neither axis, fails here.
      if (row.company_id === null) {
        expect(row.organization_id).toBe(ORG);
      } else {
        expect(row.company_id).toBe(COMPANY);
      }
    }
    // ★ AND THE PARTIAL CHECK IS REAL, not merely unexercised: the tenantless rows
    // above exist only because `0274`'s
    // `company_id IS NOT NULL OR action LIKE 'security.denied.%'` admits them.
    expect(rows.some((r) => r.company_id === null)).toBe(true);
    expect(rows.some((r) => r.company_id === COMPANY)).toBe(true);
    // Both surfaces are represented, so neither service is silently unwired.
    const actions = new Set(rows.map((r) => r.action));
    expect(actions).toContain("security.denied.artifact_transfer_grant");
    expect(actions).toContain("security.denied.artifact_commit");
    // ...and so is the fence-resolution surface, whose rows are keyed on the
    // LEASE rather than the artifact and so are invisible to every other arm's
    // `denialRowsFor` lookup.
    expect(actions).toContain("security.denied.worker_fence_resolution");
    // ...and the DE-03 replay surface, which the `:86` throw shares.
    expect(actions).toContain("security.denied.worker_proof_replay");
  });
});
