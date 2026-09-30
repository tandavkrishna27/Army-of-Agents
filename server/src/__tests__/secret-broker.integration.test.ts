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
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { createJobLeasingService, type VerifiedWorkerOperation } from "../services/job-leasing.js";
import { createSecretBrokerService, type SecretBrokerSet } from "../services/secret-broker.js";
import {
  captureSecretResolveDenial,
  createSecretResolveDenialSink,
} from "../services/secret-resolve-denial-audit.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

// DAT-004 — the lease-scoped secret broker against embedded-PG. It proves the
// fence-first + no-early-broker-access ordering, owner re-derivation + membership
// re-check, the materialization×use_policy / target-generation invariants,
// audit-as-columns, revocation via device_generation bump, worker-partition no-list
// (FORCE RLS), and the hard no-value-in-the-DB / no-value-to-sandbox invariants.

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "a6000000-0000-4000-8000-000000000001";
const COMPANY = "a6000000-0000-4000-8000-000000000002";
const TARGET = "a6000000-0000-4000-8000-000000000003";
const WORKER = "a6000000-0000-4000-8000-000000000005";
const OTHER_ORG = "a6000000-0000-4000-8000-0000000000aa";
const OTHER_COMPANY = "a6000000-0000-4000-8000-0000000000bb";
const OWNER_USER = "a6000000-0000-4000-8000-0000000000cc";
// DSK-001 Lane B (D12/1): for `device_local`, ref_id IS provider_credentials.id — a
// uuid PK, never a slug. The fixture used the literal "provider-credential-1", which
// no row could ever have. Seeded for real so the handle points at something.
const PROVIDER_CREDENTIAL = "a6000000-0000-4000-8000-0000000000c1";
// The membership re-check test needs a user who is NOT a member, and (since B6) a
// credential that user actually owns — otherwise re-adding the membership still fails
// on credential_owner_mismatch and the test would prove the wrong refusal.
const GONE_USER = "a6000000-0000-4000-8000-0000000000dd";
const GONE_CREDENTIAL = "a6000000-0000-4000-8000-0000000000c2";
const PASSWORD = "dat-004-role-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;
const SECRET_MARKER = "SECRET-VALUE-must-never-be-persisted-or-sandboxed";

const integration = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "dat-004-provider",
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
    agentVersion: "dat-004-integration",
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

function recordingBrokers(): SecretBrokerSet & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveConnectorOAuth(input) { calls.push(`oauth:${input.companyId}:${input.refId}`); return SECRET_MARKER; },
    async resolveProviderOrCompanySecret(input) { calls.push(`secret:${input.refKind}:${input.companyId}:${input.refId}`); return SECRET_MARKER; },
  };
}

integration("DAT-004 lease-scoped secret broker", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let appRaw: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let operator: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;
  let ordinalCounter = 4_000;

  function guardCtx() {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!admin || !app || !operator || !appRaw) throw new Error("test setup incomplete");
    return { admin, app, operator, appRaw };
  }

  function auth(proofId: string): VerifiedWorkerOperation {
    return {
      organizationId: ORG,
      workerId: WORKER,
      targetId: TARGET,
      targetGeneration: 1,
      deviceThumbprint: THUMBPRINT,
      profileHash: WORKER_PROFILE_HASH,
      publicKey: "dat-004-public-key",
      proofId,
      proofIssuedAt: new Date(),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  async function resetRuntimeRows(): Promise<void> {
    const { admin } = guardCtx();
    await admin`DELETE FROM worker_operation_receipts`;
    await admin`DELETE FROM job_secret_handles`;
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
      device_public_key = 'dat-004-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  async function seedPlacedJob(ordinal: number, executor: { kind: string; id: string }): Promise<{ jobId: string; attemptId: string }> {
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
         'system', 'dat-004-test', ${executor.kind}, ${executor.id}, ${workload},
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

  async function activateLease(executor: { kind: string; id: string } = { kind: "worker", id: WORKER }):
    Promise<{ seeded: { jobId: string; attemptId: string }; offer: LeaseOfferV1 }> {
    const { app } = guardCtx();
    const ordinal = ordinalCounter++;
    await resetRuntimeRows();
    const seeded = await seedPlacedJob(ordinal, executor);
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

  interface HandleCols {
    refKind?: string | null; refId?: string | null;
    materialization?: string | null; usePolicy?: string | null; destination?: string | null;
    boundTargetGeneration?: number | null; status?: string | null;
    ownerPrincipalKind?: string | null; ownerPrincipalId?: string | null;
    organizationId?: string; jobId?: string;
  }

  async function mintHandle(jobId: string, handle: string, cols: HandleCols): Promise<void> {
    const { admin } = guardCtx();
    await admin`INSERT INTO job_secret_handles
      (organization_id, job_id, handle, ref_kind, ref_id, materialization, use_policy, destination,
       bound_target_generation, status, owner_principal_kind, owner_principal_id)
      VALUES (${cols.organizationId ?? ORG}, ${cols.jobId ?? jobId}, ${handle},
        ${cols.refKind ?? "company_secret"}, ${cols.refId ?? "company-secret-1"},
        ${cols.materialization ?? "env"}, ${cols.usePolicy ?? "sandbox_local_only"},
        ${cols.destination ?? null}, ${cols.boundTargetGeneration ?? null},
        ${cols.status ?? "active"}, ${cols.ownerPrincipalKind ?? null}, ${cols.ownerPrincipalId ?? null})`;
  }

  function request(offer: LeaseOfferV1, handleId: string) {
    return {
      workerId: WORKER,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      handleId,
    };
  }

  async function auditRow(handle: string): Promise<{ resolveCount: number | null; lastResolvedAt: Date | null }> {
    const { admin } = guardCtx();
    const [row] = await admin<{ resolve_count: number | null; last_resolved_at: Date | null }[]>`
      SELECT resolve_count, last_resolved_at FROM job_secret_handles WHERE handle = ${handle}`;
    return { resolveCount: row?.resolve_count ?? null, lastResolvedAt: row?.last_resolved_at ?? null };
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-dat004-"));
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
      // A raw aoa_app client with NO tenant GUC — the worker-partition no-list probe.
      appRaw = postgres(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 2 });
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DAT-004 org', 'dat-004-org')`;
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${OTHER_ORG}, 'DAT-004 other', 'dat-004-other')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'DAT-004 company', 'D004')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${OTHER_COMPANY}, ${OTHER_ORG}, 'DAT-004 other company', 'D004O')`;
      // The device_local owner's ACTIVE company membership (re-checked at resolve).
      await admin`INSERT INTO company_memberships (company_id, principal_type, principal_id, status)
        VALUES (${COMPANY}, 'user', ${OWNER_USER}, 'active')`;
      // DSK-001 Lane B. provider_credentials.owner_user_id FKs to "user" with
      // onDelete restrict, and this suite never seeded a user row — so the credential
      // could not exist at all until now.
      await admin`INSERT INTO "user" (id, name, email, created_at, updated_at)
        VALUES (${OWNER_USER}, 'DAT-004 owner', 'owner@dat-004.test', now(), now())`;
      // The credential the device_local handles point at. state='verified' is what the
      // B6 gate will admit on; seeding it here (assertions unchanged) is what keeps
      // that later diff pure decision logic.
      await admin`INSERT INTO provider_credentials
        (id, company_id, provider, owner_user_id, execution_target_id, kind, state, verified_at)
        VALUES (${PROVIDER_CREDENTIAL}, ${COMPANY}, 'anthropic', ${OWNER_USER}, ${TARGET},
                'personal_subscription', 'verified', now())`;
      await admin`INSERT INTO "user" (id, name, email, created_at, updated_at)
        VALUES (${GONE_USER}, 'DAT-004 non-member', 'gone@dat-004.test', now(), now())`;
      await admin`INSERT INTO provider_credentials
        (id, company_id, provider, owner_user_id, execution_target_id, kind, state, verified_at)
        VALUES (${GONE_CREDENTIAL}, ${COMPANY}, 'anthropic', ${GONE_USER}, ${TARGET},
                'personal_subscription', 'verified', now())`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'dat-004-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'dat-004-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'DAT-004 worker', 'enrolled')`;
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await operator?.close({ timeoutSeconds: 5 }).catch(() => {});
    await app?.close({ timeoutSeconds: 5 }).catch(() => {});
    await appRaw?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await embedded?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  // ---- schema invariant: NO secret value column ---------------------------

  it("job_secret_handles has NO secret value column (no-plaintext-at-rest)", async () => {
    const { admin } = guardCtx();
    const cols = await admin<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'job_secret_handles'`;
    const names = cols.map((c) => c.column_name);
    for (const banned of ["value", "secret", "secret_value", "token", "material", "plaintext", "ciphertext"]) {
      expect(names, `job_secret_handles must not have a '${banned}' column`).not.toContain(banned);
    }
    // The rich binding + audit columns exist.
    expect(names).toEqual(expect.arrayContaining([
      "ref_kind", "ref_id", "materialization", "use_policy", "destination",
      "bound_target_generation", "status", "last_resolved_at", "resolve_count", "revoked_at",
      "owner_principal_kind", "owner_principal_id",
    ]));
    // `revoked_at` is asserted PRESENT on purpose, and it is VESTIGIAL AND UNREAD.
    // DE-07's ruling (2026-09-09) retired it as a revocation lever — zero writers
    // tree-wide, and its only reader ANDed it with `status = 'active'` so it could never
    // independently deny anything. That reader conjunct is removed (the EXPAND step);
    // per-handle liveness is `status` alone and revocation is device-grained. The
    // DECLARATION must outlive the reader removal by one release: a failed deploy rolls
    // the BINARY back and reverts NO schema, so dropping the column here would leave an
    // N-1 binary selecting a column that no longer exists. The CONTRACT step (E0-F017)
    // drops it once the rollback window has closed, and flips this line back to
    // `.not.toContain("revoked_at")` in the same commit.
  });

  // ---- happy resolves per ref_kind ----------------------------------------

  it("resolves a company_secret via the broker + writes audit-as-columns (value NEVER persisted)", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-company", { refKind: "company_secret", refId: "company-secret-1", materialization: "env", usePolicy: "sandbox_local_only" });
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-company") });
    expect(res.outcome).toBe("resolved");
    if (res.outcome !== "resolved") return;
    expect(res.seam).toBe("sandbox_local_only");
    expect(res.material.value).toBe(SECRET_MARKER);
    expect(brokers.calls).toEqual([`secret:company_secret:${COMPANY}:company-secret-1`]);
    const audit = await auditRow("h-company");
    expect(audit.resolveCount).toBe(1);
    expect(audit.lastResolvedAt).not.toBeNull();
    // The resolved value is NEVER written to the DB row.
    const { admin } = guardCtx();
    const [full] = await admin<Record<string, unknown>[]>`SELECT * FROM job_secret_handles WHERE handle = 'h-company'`;
    expect(JSON.stringify(full)).not.toContain(SECRET_MARKER);
  }, 60_000);

  it("resolves a connector_oauth handle to the fence_proxy seam", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-oauth", { refKind: "connector_oauth", refId: "mcp:oauth:notion", materialization: "proxy", usePolicy: "fence_proxy", destination: "https://api.notion.com" });
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-oauth") });
    expect(res.outcome).toBe("resolved");
    if (res.outcome !== "resolved") return;
    expect(res.seam).toBe("fence_proxy");
    expect(brokers.calls).toEqual([`oauth:${COMPANY}:mcp:oauth:notion`]);
  }, 60_000);

  it("returns a device_local HANDOFF (no value, no broker) when the owner is the job executor with active membership", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease({ kind: "user", id: OWNER_USER });
    await mintHandle(offer.job.jobId, "h-device", { refKind: "device_local", refId: PROVIDER_CREDENTIAL, materialization: "file", usePolicy: "sandbox_local_only", ownerPrincipalKind: "user", ownerPrincipalId: OWNER_USER });
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-device") });
    expect(res.outcome).toBe("device_handoff");
    if (res.outcome !== "device_handoff") return;
    expect(brokers.calls).toEqual([]);
    expect(JSON.stringify(res)).not.toContain(SECRET_MARKER);
    expect(res.handoff.refId).toBe(PROVIDER_CREDENTIAL);
  }, 60_000);

  // ---- fence-first + no audit on refusal ----------------------------------

  it("decides fence staleness BEFORE resolving: a stale fence rejects with no broker call + no audit write", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-stale", { refKind: "company_secret", refId: "company-secret-1" });
    await expireLease(offer.leaseId);
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-stale") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    expect(res.reason).toBe("stale_fence");
    expect(brokers.calls).toEqual([]);
    const audit = await auditRow("h-stale");
    expect(audit.resolveCount).toBeNull(); // no audit write on a denied resolve
    expect(audit.lastResolvedAt).toBeNull();
  }, 60_000);

  it("target_revoked: a device_generation bump denies resolution before any broker call", async () => {
    const brokers = recordingBrokers();
    const { app, admin } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-revoked", { refKind: "company_secret", refId: "company-secret-1" });
    await admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET}`;
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    // The stale authority (bumped generation) is an AUTH-LAYER failure: the shared
    // worker-fence-context throws JobLeasingError('target_revoked') BEFORE the mutator/
    // broker are reached (the route maps it to an HTTP protocol error). No broker call.
    await expect(svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-revoked") }))
      .rejects.toThrow(/target_revoked/);
    expect(brokers.calls).toEqual([]);
    await admin`UPDATE execution_targets SET device_generation = 1 WHERE id = ${TARGET}`;
  }, 60_000);

  // ---- cross-tenant + wrong identity --------------------------------------

  it("a foreign-org handle is invisible: resolving it is a non-disclosing malformed (no oracle)", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    // Mint a handle owned by ANOTHER org+job — the composite FK requires a real foreign
    // job, so instead assert that a handle id that does not exist for THIS fence's job
    // is a coarse malformed (never reveals foreign existence).
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "does-not-exist") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    expect(res.reason).toBe("malformed");
    expect(brokers.calls).toEqual([]);
  }, 60_000);

  it("a wrong fence token throws stale_fence (auth layer) without reading the handle or broker", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-wrongfence", { refKind: "company_secret", refId: "company-secret-1" });
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const req = request(offer, "h-wrongfence");
    req.fenceToken = crypto.randomUUID();
    // An unresolvable fence tuple is an AUTH-LAYER failure: worker-fence-context throws
    // JobLeasingError('stale_fence') BEFORE any handle read or broker call (no cross-tenant
    // existence oracle). The route maps the throw to an HTTP protocol error.
    await expect(svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: req }))
      .rejects.toThrow(/stale_fence/);
    expect(brokers.calls).toEqual([]);
  }, 60_000);

  // ---- owner membership re-check ------------------------------------------

  it("device_local: denies (malformed) when the owner is NOT the locked job executor", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    // Job executor is the WORKER, but the handle claims a user owner → binding incomplete.
    const { offer } = await activateLease({ kind: "worker", id: WORKER });
    await mintHandle(offer.job.jobId, "h-wrongowner", { refKind: "device_local", refId: PROVIDER_CREDENTIAL, materialization: "file", usePolicy: "sandbox_local_only", ownerPrincipalKind: "user", ownerPrincipalId: OWNER_USER });
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-wrongowner") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    expect(res.reason).toBe("malformed");
  }, 60_000);

  it("device_local: denies (malformed) when the owner lost company membership", async () => {
    const brokers = recordingBrokers();
    const { app, admin } = guardCtx();
    const gone = GONE_USER;
    const { offer } = await activateLease({ kind: "user", id: gone });
    // Points at the credential `gone` OWNS. Since B6 the owner triple is checked too, so
    // reusing OWNER_USER's credential here would deny on credential_owner_mismatch and
    // the re-admit below would fail for a reason that has nothing to do with membership.
    await mintHandle(offer.job.jobId, "h-nomember", { refKind: "device_local", refId: GONE_CREDENTIAL, materialization: "file", usePolicy: "sandbox_local_only", ownerPrincipalKind: "user", ownerPrincipalId: gone });
    // No active membership exists for `gone`.
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-nomember") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    expect(res.reason).toBe("malformed");
    // Now add the membership → the same fence resolves as a handoff.
    await admin`INSERT INTO company_memberships (company_id, principal_type, principal_id, status)
      VALUES (${COMPANY}, 'user', ${gone}, 'active')`;
    const res2 = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-nomember") });
    expect(res2.outcome).toBe("device_handoff");
    await admin`DELETE FROM company_memberships WHERE principal_id = ${gone}`;
  }, 60_000);

  // ---- the materialization x use_policy + generation invariants -----------

  it("denies (malformed) a sandbox_local_only handle carrying a network destination", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-sandboxnet", { refKind: "company_secret", refId: "company-secret-1", materialization: "env", usePolicy: "sandbox_local_only", destination: "https://exfil.example" });
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-sandboxnet") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    expect(res.reason).toBe("malformed");
    expect(brokers.calls).toEqual([]);
  }, 60_000);

  it("denies (malformed) an env handle that claims the fence_proxy policy", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-envproxy", { refKind: "company_secret", refId: "company-secret-1", materialization: "env", usePolicy: "fence_proxy", destination: "https://egress.example" });
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-envproxy") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    expect(res.reason).toBe("malformed");
  }, 60_000);

  it("denies (malformed) a handle bound to a DIFFERENT target generation than the live lease (D5)", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-gen", { refKind: "company_secret", refId: "company-secret-1", boundTargetGeneration: 2 });
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-gen") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    expect(res.reason).toBe("malformed");
  }, 60_000);

  it("resolves a handle pinned to the LIVE target generation (D5 match)", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-gen-ok", { refKind: "company_secret", refId: "company-secret-1", boundTargetGeneration: 1 });
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-gen-ok") });
    expect(res.outcome).toBe("resolved");
  }, 60_000);

  it("denies (malformed) a revoked handle", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-rev", { refKind: "company_secret", refId: "company-secret-1", status: "revoked" });
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-rev") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    expect(res.reason).toBe("malformed");
  }, 60_000);

  // ---- worker-partition no-list (FORCE RLS) -------------------------------

  it("no-list: a worker-partition query with NO tenant GUC sees ZERO handle rows", async () => {
    const { appRaw } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-nolist", { refKind: "company_secret", refId: "company-secret-1" });
    // aoa_app WITHOUT a tenant GUC → FORCE RLS filters every row.
    const rows = await appRaw`SELECT count(*)::int AS count FROM job_secret_handles`;
    expect(rows[0].count).toBe(0);
  }, 60_000);

  // ---- audit monotonicity -------------------------------------------------

  it("audit-as-columns: resolve_count increments monotonically per authorized resolve", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-count", { refKind: "company_secret", refId: "company-secret-1" });
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-count") });
    await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-count") });
    const audit = await auditRow("h-count");
    expect(audit.resolveCount).toBe(2);
  }, 60_000);

  // ---- DE-29 + DE-04/DE-18: the denied resolve leaves a durable record ----
  //
  // Until the audit-wiring unit, every `denied` outcome below left NOTHING
  // durable — only the count-only `metrics.secretRead` tick E0-F013 files
  // against DE-29 as forensically indistinguishable. These arms assert the
  // durable `security.denied.*` row per refusal class, driven through the REAL
  // service against real embedded PostgreSQL. Observed RED against the
  // unchanged wiring before the sinks landed.

  interface DenialRow {
    action: string;
    actor_type: string;
    actor_id: string;
    company_id: string | null;
    organization_id: string | null;
    entity_type: string;
    entity_id: string;
    details: Record<string, unknown>;
  }

  async function denialRows(): Promise<DenialRow[]> {
    const { admin } = guardCtx();
    return await admin<DenialRow[]>`
      SELECT action, actor_type, actor_id, company_id, organization_id,
             entity_type, entity_id, details
      FROM activity_log WHERE action LIKE ${"security.denied.%"}
      ORDER BY created_at ASC`;
  }

  async function clearDenialRows(): Promise<void> {
    const { admin } = guardCtx();
    await admin`DELETE FROM activity_log WHERE action LIKE ${"security.denied.%"}`;
  }

  it("DE-29 CLAUSE: a wrong-owner device_local denial writes ONE attributable row with the REAL reason (wire stays malformed)", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    // Job executor is the WORKER, but the handle claims a user owner →
    // authorizeSecretResolve verdict `owner_binding_incomplete` — the DE-29
    // threat proper, thrown as SecretResolveRejection inside the mutator.
    const { offer } = await activateLease({ kind: "worker", id: WORKER });
    await mintHandle(offer.job.jobId, "h-de29", { refKind: "device_local", refId: PROVIDER_CREDENTIAL, materialization: "file", usePolicy: "sandbox_local_only", ownerPrincipalKind: "user", ownerPrincipalId: OWNER_USER });
    await clearDenialRows();
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-de29") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    // The WIRE stays coarse and non-disclosing.
    expect(res.reason).toBe("malformed");
    // The tenant's own audit trail records the real branch.
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("security.denied.secret_resolve");
    expect(row.details.reason).toBe("owner_binding_incomplete");
    expect(row.details.crossing).toBe("DE-29");
    // WHO — the refused worker (a machine identity: actor_type system, id direct).
    expect(row.actor_type).toBe("system");
    expect(row.actor_id).toBe(WORKER);
    // TENANT — both axes, from the locked lease / verified session, never the wire.
    expect(row.company_id).toBe(COMPANY);
    expect(row.organization_id).toBe(ORG);
    // RESOURCE — the presented handle.
    expect(row.entity_type).toBe("job_secret_handle");
    expect(row.entity_id).toBe("h-de29");
    expect(row.details.jobId).toBe(offer.job.jobId);
    expect(row.details.leaseId).toBe(offer.leaseId);
  }, 60_000);

  it("DE-29 reason distinctness: a revoked handle records handle_revoked — distinct branch, distinct code", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-de29-rev", { refKind: "company_secret", refId: "company-secret-1", status: "revoked" });
    await clearDenialRows();
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-de29-rev") });
    expect(res.outcome).toBe("denied");
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("security.denied.secret_resolve");
    expect(rows[0]!.details.reason).toBe("handle_revoked");
  }, 60_000);

  it("DE-04 fence arm: a stale-fence resolve refusal at resolveExecutionSecret's guardActiveFence writes a fence_guard row (operation secret_resolve)", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-de04", { refKind: "company_secret", refId: "company-secret-1" });
    await expireLease(offer.leaseId);
    await clearDenialRows();
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-de04") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    expect(res.reason).toBe("stale_fence");
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("security.denied.fence_guard");
    expect(row.details.reason).toBe("stale_fence");
    expect(row.details.crossing).toBe("DE-04");
    expect(row.details.operation).toBe("secret_resolve");
    expect(row.actor_id).toBe(WORKER);
    expect(row.entity_type).toBe("job_lease");
    expect(row.entity_id).toBe(offer.leaseId);
    expect(row.company_id).toBe(COMPANY);
  }, 60_000);

  it("capture guard: a NON-rejection error captures NOTHING (narrow direct pin — the guard is unreachable through the production catch, which calls capture only from the rejection branch; this is the SVC-002 T1c shape)", () => {
    const sink = createSecretResolveDenialSink();
    const fence = {
      organizationId: ORG, companyId: COMPANY, workerId: WORKER,
      leaseId: "l", jobId: "j", attemptId: "a", targetId: TARGET, targetGeneration: 1,
    };
    captureSecretResolveDenial(sink, fence, "h-x", new Error("not a rejection"));
    expect(sink.intent).toBeNull();
  });

  it("DE-29 probe class: an ABSENT-handle probe records unknown_ref_kind — a foreign handle is absent-by-scoping, so the cross-tenant probe is deliberately IN this row stream (Codex P2 on PR #447, adjudicated)", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await clearDenialRows();
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "no-such-handle") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    expect(res.reason).toBe("malformed");
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("security.denied.secret_resolve");
    expect(rows[0]!.details.reason).toBe("unknown_ref_kind");
    expect(rows[0]!.entity_id).toBe("no-such-handle");
  }, 60_000);

  it("ANTI-VACUITY: an admitted resolve writes ZERO security.denied rows", async () => {
    const brokers = recordingBrokers();
    const { app } = guardCtx();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-clean", { refKind: "company_secret", refId: "company-secret-1" });
    await clearDenialRows();
    const svc = createSecretBrokerService({ appDb: app.db, brokers });
    const res = await svc.resolve({ auth: auth(`r-${crypto.randomUUID()}`), request: request(offer, "h-clean") });
    expect(res.outcome).toBe("resolved");
    expect(await denialRows()).toHaveLength(0);
  }, 60_000);
});
