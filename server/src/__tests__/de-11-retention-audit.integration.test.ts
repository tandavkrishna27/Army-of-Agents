/**
 * DE-11, `audit` clause — RETENTION HALF. A control-plane retention override is
 * durably distinguishable from a commit that agreed, and it is ATTRIBUTABLE.
 *
 * ★ WHAT THIS TEST IS FOR, AND THE PREMISE IT RETIRES.
 * `docs/architecture/distributed-execution-threat-controls.json` DE-11 asserts
 * "sensitive-artifact access and retention are audited". The register's stated
 * blocker was that "the controls themselves are absent; nothing decides, so
 * there is nothing to record". Re-measured at source at `6b39c77f6`, that is
 * FALSE for the retention half. `resolveStoredRetention`
 * (`server/src/services/artifact-retention-authority.ts:49`) is a LIVE
 * control-plane decision: it derives the retention class from the frozen `kind`
 * and IGNORES the worker's declaration. It is called at
 * `server/src/services/artifact-commit.ts:272` and branched on at `:276`, and
 * the code's own comment there said, verbatim, "This is a LOG LINE, not an audit
 * record — DE-11 claims retention is audited and nothing audits it". A worker
 * whose declared retention was overridden left EXACTLY the same durable trace as
 * one whose declaration was accepted. That is the gap this file closes.
 *
 * ★★★ WHAT THIS FILE DOES NOT PROVE — first, because DE-11's clause is a
 * CONJUNCTION and half a conjunction is not the conjunction.
 *   - "sensitive-artifact ACCESS ... audited" — NOT delivered here and NOT
 *     asserted here. Its missing piece is the SUCCESSFUL put/get record, which
 *     is DE-06's own still-open conjunct at the tree's only production
 *     `presignGet` call site. Nothing below asserts a successful-access row.
 *   - "... RETENTION are audited" — delivered and proven below, WITH the
 *     coverage caveat immediately following.
 *   ⇒ **DE-11 DOES NOT CLOSE ON THIS FILE AND STAYS `partial`.**
 *
 * ★★★ THE COVERAGE CAVEAT, ASSERTED RATHER THAN FOOTNOTED. DE-11's boundary is
 * "Browser-session workload <-> sensitive artifacts", and NOTHING IN PRODUCTION
 * UPLOADS `browser_cookie_state` OR `browser_storage_state` TODAY because
 * `BRW-003` is unbuilt. The decision at `artifact-commit.ts:272` fires for EVERY
 * artifact kind, so the record is real and live — but on today's traffic it can
 * only ever be about a `log` or a `workspace_patch`, and NEVER ONCE about a
 * credential-bearing kind. The arm named "THE COVERAGE CAVEAT" below provokes
 * `browser_cookie_state` BY HAND through the commit service and says so in its
 * own title, so that arm can never be read as production coverage. The
 * `deliveryStatus` move is FORBIDDEN until `BRW-003` ships and the record is
 * provoked through the real browser upload path.
 *
 * ★ WHY THIS IS NOT A READ-BACK. This file never constructs a retention record.
 * It PROVOKES the real decision through the real service — a real enrolled
 * worker, a real polled + acked lease, a real live fence, the real
 * `createArtifactCommitService` — and then asserts the durable row the decision
 * itself left behind. A read-back verifies what was DECLARED, never what is
 * ENFORCED (the measured lesson of DE-08, and the reason `declarationIgnored` is
 * asserted through a COMMITTED artifact rather than by calling the authority).
 *
 * ★ ATTRIBUTION IS THE ASSERTION. Each question is asserted separately, because
 * a row saying "a retention decision happened" satisfies no crossing:
 *   WHO      -> actor_id is the worker whose declaration was ignored
 *   TENANT   -> company_id is the LOCKED LEASE's company (and organization_id
 *               the token-attested organization)
 *   RESOURCE -> entity_type/entity_id is the artifact identity, plus its kind
 *   WHAT     -> details.declaredRetention and details.storedRetention are BOTH
 *               present and DIFFERENT — the two values the record exists for
 *
 * ★ THE NAMESPACE SEPARATION IS ASSERTED, NOT ASSUMED. A retention override is
 * not a refusal, so it must not land in `security.denied.*`: if it did, "count
 * the denial rows" would stop answering "count the refusals", which is the exact
 * property `activity-namespace.ts`'s denial reservation exists to protect. One
 * arm asserts the action prefix, and one asserts the denial-namespace count is
 * unchanged across a provoked override.
 *
 * Real Postgres (embedded-postgres + the committed migration chain), the real
 * `aoa_app` non-owner role — which is the role `artifact-commit`'s `input.appDb`
 * genuinely is in production — the real leasing and commit services. No stubs on
 * the decision and none on the recorder; only the object store is stubbed.
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI `push` is the authoritative gate. On
 * a Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real. Harness
 * modeled on de-06-artifact-denial-audit.integration.test.ts.
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
import { createJobLeasingService, type VerifiedWorkerOperation } from "../services/job-leasing.js";
import { createArtifactCommitService } from "../services/artifact-commit.js";
import { browserArtifactRetention } from "../services/browser-artifact-retention.js";
import {
  ReservedActivityNamespaceError,
  SECURITY_DENIAL_ACTION_PREFIX,
  SECURITY_RETENTION_ACTION_PREFIX,
  assertUnreservedActivityNamespace,
} from "../services/activity-namespace.js";
import { RETENTION_DECLARATION_IGNORED_REASON } from "../services/artifact-retention-audit.js";
import type { StorageProvider, HeadObjectResult, PresignResult } from "../storage/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "de110000-0000-4000-8000-000000000001";
const COMPANY = "de110000-0000-4000-8000-000000000002";
const TARGET = "de110000-0000-4000-8000-000000000003";
const WORKER = "de110000-0000-4000-8000-000000000005";
const PASSWORD = "de-011-role-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;

/** The action the recorder writes. Composed from the exported prefix + surface so
 * a rename of either goes red here rather than silently writing elsewhere. */
const RETENTION_ACTION = `${SECURITY_RETENTION_ACTION_PREFIX}artifact_commit`;

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "de-011-provider",
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
    agentVersion: "de-011-integration",
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

function makeStubStorage(): StorageProvider & { headResult: HeadObjectResult } {
  const state = {
    headResult: { exists: true, contentLength: 128, checksumSha256: "b".repeat(64) } as HeadObjectResult,
  };
  return {
    id: "s3",
    get headResult() { return state.headResult; },
    set headResult(v: HeadObjectResult) { state.headResult = v; },
    async putObject() {},
    async getObject() { throw new Error("not used"); },
    async headObject() { return state.headResult; },
    async deleteObject() {},
    async presignPut(i): Promise<PresignResult> {
      return { method: "PUT", url: `https://worker.example/put/${encodeURIComponent(i.objectKey)}`, headers: {} };
    },
    async presignGet(i): Promise<PresignResult> {
      return { method: "GET", url: `https://worker.example/get/${encodeURIComponent(i.objectKey)}`, headers: {} };
    },
  };
}

interface AuditRow {
  company_id: string | null;
  organization_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown> | null;
}

integration("DE-11 (retention half) — a control-plane retention override is durable and attributable", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;
  let ordinalCounter = 11_000;

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
      publicKey: "de-011-public-key",
      proofId,
      proofIssuedAt: new Date(),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  /** Every retention-decision row for one artifact. */
  async function retentionRowsFor(artifactId: string): Promise<AuditRow[]> {
    const { admin } = ctx();
    return (await admin<AuditRow[]>`
      SELECT company_id, organization_id, actor_type, actor_id, action, entity_type, entity_id, details
      FROM activity_log
      WHERE entity_id = ${artifactId} AND action LIKE ${`${SECURITY_RETENTION_ACTION_PREFIX}%`}
      ORDER BY created_at`) as unknown as AuditRow[];
  }

  /** Rows in the DENIAL namespace, company-wide. The separation control. */
  async function denialRowCount(): Promise<number> {
    const { admin } = ctx();
    const rows = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log
      WHERE company_id = ${COMPANY} AND action LIKE ${`${SECURITY_DENIAL_ACTION_PREFIX}%`}`;
    return Number(rows[0]?.n ?? "-1");
  }

  async function retentionRowCount(): Promise<number> {
    const { admin } = ctx();
    const rows = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM activity_log
      WHERE company_id = ${COMPANY} AND action LIKE ${`${SECURITY_RETENTION_ACTION_PREFIX}%`}`;
    return Number(rows[0]?.n ?? "-1");
  }

  async function storedRetentionFor(artifactId: string): Promise<string | null> {
    const { admin } = ctx();
    const rows = await admin<{ retention: string | null }[]>`
      SELECT retention FROM job_artifacts WHERE identifier = ${artifactId} LIMIT 1`;
    return rows[0]?.retention ?? null;
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
      device_public_key = 'de-011-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  async function seedPlacedJob(ordinal: number): Promise<{ jobId: string }> {
    const { admin } = ctx();
    const suffix = ordinal.toString().padStart(12, "0");
    const jobId = `de111000-0000-4000-8000-${suffix}`;
    const attemptId = `de112000-0000-4000-8000-${suffix}`;
    const outboxId = `de113000-0000-4000-8000-${suffix}`;
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
         'system', 'de-011-test', 'worker', ${WORKER}, ${workload},
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
            // The AGREEING default: `browserArtifactRetention("log")` is "run".
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
      dataDir = await mkdtemp(join(tmpdir(), "aoa-de011-"));
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
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DE-11 org', 'de-011-org')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'DE-11 company', 'D011')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'de-011-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'de-011-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'DE-11 worker', 'enrolled')`;
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

  it("setup: no retention decision has been recorded yet", async () => {
    ctx();
    expect(await retentionRowCount()).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ANTI-VACUITY. If the derivation ever agreed with what the provoking arms
  // declare, every assertion below would pass while proving nothing. This pins
  // the two (kind, declared) pairs the file relies on, read from the authority
  // itself rather than restated.
  // ───────────────────────────────────────────────────────────────────────────
  it("ANTI-VACUITY — the provoking manifests really do DISAGREE with the derived class, and the agreeing one really does agree", () => {
    expect(browserArtifactRetention("log")).toBe("run");
    expect(browserArtifactRetention("log")).not.toBe("audit");
    expect(browserArtifactRetention("browser_cookie_state")).toBe("ephemeral");
    expect(browserArtifactRetention("browser_cookie_state")).not.toBe("run");
  });

  it("★ THE RECORD — a worker's declared retention is OVERRIDDEN on a COMMITTED artifact, and that override writes ONE row naming WHO / TENANT / RESOURCE / DECLARED / STORED", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const storage = makeStubStorage();
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    // kind `log` derives `run`; the worker declares the LONGER `audit` class.
    const { request, artifactId } = commitRequest(offer, { retention: "audit" });

    expect(await retentionRowsFor(artifactId)).toHaveLength(0);
    const res = await svc.commit({ auth: auth(`ro-${crypto.randomUUID()}`), request });

    // The commit SUCCEEDS — the override is not a refusal, which is the whole
    // reason it needs a record of its own.
    expect(res.outcome).toBe("committed");
    // ...and the value the control plane actually stored is the DERIVED one.
    expect(await storedRetentionFor(artifactId)).toBe("run");

    const rows = await retentionRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // WHO — the worker whose declaration was ignored.
    expect(row.actor_id).toBe(WORKER);
    expect(row.actor_type).toBe("system");
    // TENANT — the LOCKED LEASE's company, plus the token-attested organization.
    expect(row.company_id).toBe(COMPANY);
    expect(row.organization_id).toBe(ORG);
    // RESOURCE.
    expect(row.entity_type).toBe("job_artifact");
    expect(row.entity_id).toBe(artifactId);
    expect(row.details?.kind).toBe("log");
    // WHAT — the two values the record exists for, both present and DIFFERENT.
    expect(row.details?.declaredRetention).toBe("audit");
    expect(row.details?.storedRetention).toBe("run");
    expect(row.details?.declaredRetention).not.toBe(row.details?.storedRetention);
    // WHY / WHERE — a stable machine code, the crossing, and the deciding control.
    expect(row.action).toBe(RETENTION_ACTION);
    expect(row.details?.reason).toBe(RETENTION_DECLARATION_IGNORED_REASON);
    expect(row.details?.crossing).toBe("DE-11");
    expect(String(row.details?.control)).toContain("artifact-commit.ts");
    // The run context, so an operator can go from the row to the attempt.
    expect(row.details?.jobId).toBe(offer.job.jobId);
    expect(row.details?.leaseId).toBe(offer.leaseId);
  });

  it("★ A RETENTION OVERRIDE IS NOT A DENIAL — the row is OUTSIDE the `security.denied.` namespace, and the denial count did not move", async () => {
    const { app } = ctx();
    const beforeDenials = await denialRowCount();
    const beforeRetention = await retentionRowCount();
    const offer = await activateLease();
    const svc = createArtifactCommitService({ appDb: app.db, storage: makeStubStorage() });
    const { request, artifactId } = commitRequest(offer, { retention: "audit" });

    const res = await svc.commit({ auth: auth(`nd-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("committed");

    // A row was written...
    expect(await retentionRowCount()).toBe(beforeRetention + 1);
    // ...and it did NOT land in the denial namespace. Were it to, "count the
    // denial rows" would stop answering "count the refusals" — the exact property
    // `activity-namespace.ts`'s denial reservation exists to hold.
    expect(await denialRowCount()).toBe(beforeDenials);
    const row = (await retentionRowsFor(artifactId))[0]!;
    expect(row.action.startsWith(SECURITY_DENIAL_ACTION_PREFIX)).toBe(false);
    expect(row.action.startsWith(SECURITY_RETENTION_ACTION_PREFIX)).toBe(true);
  });

  it("★ AGREEMENT WRITES NOTHING — and that is the LIMIT of what is delivered, not an omission", async () => {
    const { app } = ctx();
    const before = await retentionRowCount();
    const offer = await activateLease();
    const svc = createArtifactCommitService({ appDb: app.db, storage: makeStubStorage() });
    // kind `log` + declared `run` = the derived class. No disagreement.
    const { request, artifactId } = commitRequest(offer);

    const res = await svc.commit({ auth: auth(`ag-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("committed");
    expect(await storedRetentionFor(artifactId)).toBe("run");

    // No row. A reader must NOT read "no row" as "no artifact committed": the
    // retention that WAS stored is on `job_artifacts.retention`, asserted above.
    // What this module recovers is the DISAGREEMENT and the value the worker
    // wanted, which agreement does not have.
    expect(await retentionRowsFor(artifactId)).toHaveLength(0);
    expect(await retentionRowCount()).toBe(before);
  });

  it("★ A REFUSED COMMIT RECORDS NO RETENTION — the decision runs BEFORE the mutator, and a rollback must not leave a record of a retention that was never stored", async () => {
    const { app } = ctx();
    const beforeRetention = await retentionRowCount();
    const beforeDenials = await denialRowCount();
    const offer = await activateLease();
    const storage = makeStubStorage();
    // The store observes a digest the manifest does not declare -> refusal, on a
    // branch that sits AFTER the retention decision at artifact-commit.ts:276.
    storage.headResult = { exists: true, contentLength: 128, checksumSha256: "c".repeat(64) };
    const svc = createArtifactCommitService({ appDb: app.db, storage });
    const { request, artifactId } = commitRequest(offer, { retention: "audit" });

    const res = await svc.commit({ auth: auth(`rf-${crypto.randomUUID()}`), request });
    // REACHABILITY CONTROL, asserted FIRST: without it a fixture that stopped
    // reaching the refusal would pass this arm by vacuity.
    expect(res.outcome).toBe("rejected");

    // Nothing was stored, so nothing is claimed to have been stored.
    expect(await storedRetentionFor(artifactId)).toBeNull();
    expect(await retentionRowsFor(artifactId)).toHaveLength(0);
    expect(await retentionRowCount()).toBe(beforeRetention);
    // ...while the DENIAL record for the same commit did land, which is what
    // makes this a gating assertion rather than a broken-recorder assertion.
    expect(await denialRowCount()).toBe(beforeDenials + 1);
  });

  it("★★★ THE COVERAGE CAVEAT — a CREDENTIAL-BEARING kind records correctly, but this commit is TEST-PROVOKED: nothing in production uploads it (BRW-003 unbuilt), so DE-11 STAYS `partial`", async () => {
    const { app } = ctx();
    const offer = await activateLease();
    const svc = createArtifactCommitService({ appDb: app.db, storage: makeStubStorage() });
    // `browser_cookie_state` derives `ephemeral` — the shortest class, precisely
    // because those bytes ARE a live session credential. A worker declaring `run`
    // is asking for that credential to outlive the session that minted it.
    const { request, artifactId } = commitRequest(offer, {
      kind: "browser_cookie_state",
      retention: "run",
    });

    const res = await svc.commit({ auth: auth(`cc-${crypto.randomUUID()}`), request });
    expect(res.outcome).toBe("committed");
    expect(await storedRetentionFor(artifactId)).toBe("ephemeral");

    const rows = await retentionRowsFor(artifactId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details?.kind).toBe("browser_cookie_state");
    expect(rows[0]!.details?.declaredRetention).toBe("run");
    expect(rows[0]!.details?.storedRetention).toBe("ephemeral");

    // ★ AND THE CAVEAT ITSELF, ASSERTED SO IT CANNOT BE READ AWAY. This manifest
    // was hand-built by this test. `BRW-003` is unbuilt, so NO PRODUCTION PATH
    // uploads a `browser_cookie_state`, and DE-11's boundary — "Browser-session
    // workload <-> sensitive artifacts" — therefore remains unobserved in a
    // running system. The row above proves the RECORDER covers the kind; it does
    // not prove the CROSSING is exercised. The `deliveryStatus` move is forbidden
    // until the record is provoked through the real browser upload path.
    expect(rows[0]!.details?.control).toContain("artifact-commit.ts");
  });

  it("★★★ AN IDEMPOTENT REPLAY DECIDES NOTHING, SO IT AUDITS NOTHING — the SAME artifact re-committed answers `committed` again and writes NO second row, even when the replay declares a DIFFERENT class", async () => {
    // Codex P2 on PR #409, verified at source and fixed. commitArtifactVersion
    // answers `committed` in two cases — it inserted the row, or the artifact was
    // already committed and it returned the existing one unchanged. Without the
    // mutator's `replayed` signal, an outcome check alone duplicates the record on
    // every ordinary transport retry, and the SECOND provocation below is the
    // serious half: a replay declaring a different class would mint a row
    // asserting a declared/stored pair that was never decided for the stored row.
    const { app } = ctx();
    const offer = await activateLease();
    const svc = createArtifactCommitService({ appDb: app.db, storage: makeStubStorage() });
    const artifactId = crypto.randomUUID();

    // (1) The genuine first commit, with an override. ONE row.
    const first = commitRequest(offer, { artifactId, retention: "audit" });
    expect((await svc.commit({ auth: auth(`rp1-${crypto.randomUUID()}`), request: first.request })).outcome)
      .toBe("committed");
    expect(await retentionRowsFor(artifactId)).toHaveLength(1);
    expect(await storedRetentionFor(artifactId)).toBe("run");

    // (2) The same artifact, replayed under the same live fence with the SAME
    // declaration — an ordinary transport retry.
    const replay = commitRequest(offer, { artifactId, retention: "audit" });
    const res2 = await svc.commit({ auth: auth(`rp2-${crypto.randomUUID()}`), request: replay.request });
    // REACHABILITY CONTROL, asserted FIRST: if the replay stopped answering
    // `committed` it would no longer exercise the branch and this arm would pass
    // by vacuity.
    expect(res2.outcome).toBe("committed");
    expect(await retentionRowsFor(artifactId)).toHaveLength(1);

    // (3) ★ THE SERIOUS HALF — a replay declaring a DIFFERENT class. Still
    // `committed`, still no new row: nothing about the stored artifact changed, so
    // no record may claim a decision was made about it.
    const drift = commitRequest(offer, { artifactId, retention: "ephemeral" });
    const res3 = await svc.commit({ auth: auth(`rp3-${crypto.randomUUID()}`), request: drift.request });
    expect(res3.outcome).toBe("committed");
    expect(await retentionRowsFor(artifactId)).toHaveLength(1);
    // ...and the ONE row still describes the decision that actually happened.
    const rows = await retentionRowsFor(artifactId);
    expect(rows[0]!.details?.declaredRetention).toBe("audit");
    expect(rows[0]!.details?.declaredRetention).not.toBe("ephemeral");
    // The stored value never moved either — the replay wrote nothing at all.
    expect(await storedRetentionFor(artifactId)).toBe("run");
  });

  it("★ THE NAMESPACE IS RESERVED — a caller-supplied `action` cannot forge a retention record through the two writers that accept one", () => {
    // Forgery matters here for the same reason it matters in the denial
    // namespace: if any board client could POST a row saying the control plane
    // overrode a worker's retention, "there is a retention record" would stop
    // implying "the control plane decided".
    expect(() =>
      assertUnreservedActivityNamespace({ action: RETENTION_ACTION, entityType: "job_artifact" }),
    ).toThrow(ReservedActivityNamespaceError);
    // POSITIVE CONTROL — an ordinary product action still passes, so the guard is
    // rejecting the namespace and not everything.
    expect(() =>
      assertUnreservedActivityNamespace({ action: "issue.created", entityType: "issue" }),
    ).not.toThrow();
  });

  it("★ STORAGE POSTURE — `activity_log` is OUTSIDE the tenant RLS kernel, against a positive control that the kernel really is forced on this database", async () => {
    const { admin } = ctx();
    // The recorder writes to `activity_log` specifically because an RLS-FORCED
    // table would refuse the write under the same org GUC the commit ran with.
    // If `activity_log` is ever folded into the kernel, every arm above goes red
    // as "the row is missing"; this arm names the change instead.
    const rows = await admin<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname IN ('activity_log', 'job_attempts')`;
    const byName = new Map(rows.map((r) => [r.relname, r]));
    expect(byName.get("activity_log")?.relforcerowsecurity).toBe(false);
    // POSITIVE CONTROL — a genuinely kernel-forced table on the SAME database.
    expect(byName.get("job_attempts")?.relforcerowsecurity).toBe(true);
  });
});
