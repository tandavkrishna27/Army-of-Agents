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
  type NetworkPolicyV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { createJobLeasingService, type VerifiedWorkerOperation } from "../services/job-leasing.js";
import type { SecretBrokerSet } from "../services/secret-broker.js";
import {
  createFenceAwareEgressProxy,
  type EgressDispatchInput,
} from "../services/egress-proxy.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

// DAT-005 — the fence-aware egress proxy + policy-version persistence against
// embedded-PG. It proves default-deny classification through the fence path, the
// materialize-into-headers-only invariant, applied_policy_version persistence in the
// resolveExecutionSecret audit write, and fail-closed denial (no dispatch, no leak).

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "a5000000-0000-4000-8000-000000000001";
const COMPANY = "a5000000-0000-4000-8000-000000000002";
const TARGET = "a5000000-0000-4000-8000-000000000003";
const WORKER = "a5000000-0000-4000-8000-000000000005";
// DSK-001 Lane B. A device_local credential belongs to a USER (its owner_user_id
// references the `user` table), so the handle owner must be a user — and rule 6 also
// requires the handle owner to be the LOCKED job's executor. The job below therefore
// executes as this user rather than as the worker principal.
const OWNER_USER = "a5000000-0000-4000-8000-0000000000cc";
const DEVICE_CREDENTIAL = "a5000000-0000-4000-8000-0000000000c1";
const PASSWORD = "dat-005-role-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;
const SECRET_MARKER = "EGRESS-SECRET-must-never-be-persisted-or-leaked";

const integration = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "dat-005-provider",
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
    agentVersion: "dat-005-integration",
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

function policyV1(overrides?: Partial<NetworkPolicyV1>): NetworkPolicyV1 {
  return {
    policyId: "dat-005-egress",
    version: 5,
    digest: "a".repeat(64),
    defaultAction: "deny",
    allow: [{ scheme: "https", host: "api.notion.com", port: 443 }],
    denyPrivateNetworks: true,
    denyMetadata: true,
    denyControlPlane: true,
    ...overrides,
  };
}

function recordingDispatch() {
  const captured: EgressDispatchInput[] = [];
  return {
    captured,
    dispatch: async (input: EgressDispatchInput) => {
      captured.push(input);
      return { status: 200 };
    },
  };
}

integration("DAT-005 fence-aware egress proxy", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let operator: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;
  let ordinalCounter = 5_000;

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
      publicKey: "dat-005-public-key",
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
      device_public_key = 'dat-005-public-key', device_thumbprint = ${THUMBPRINT},
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
         'system', 'dat-005-test', 'user', ${OWNER_USER}, ${workload},
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

  async function activateLease(): Promise<{ offer: LeaseOfferV1 }> {
    const { app } = guardCtx();
    const ordinal = ordinalCounter++;
    await resetRuntimeRows();
    await seedPlacedJob(ordinal);
    const service = createJobLeasingService({ appDb: app.db });
    const polled = await service.poll({ auth: auth(`p-${ordinal}`), request: pollRequest(`p-${ordinal}`) });
    if (polled.outcome !== "offer") throw new Error(`expected offer, got ${polled.outcome}`);
    const offer = polled.body;
    const acked = await service.ack({ auth: auth(`a-${ordinal}`), request: ackRequest(offer) });
    if (acked.outcome !== "acknowledged") throw new Error("expected ack");
    return { offer };
  }

  async function expireLease(leaseId: string): Promise<void> {
    const { admin } = guardCtx();
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() - interval '2 seconds',
      expires_at = clock_timestamp() - interval '1 second' WHERE id = ${leaseId}`;
  }

  interface HandleCols {
    refKind?: string; refId?: string; materialization?: string; usePolicy?: string;
    destination?: string | null; status?: string;
    ownerPrincipalKind?: string | null; ownerPrincipalId?: string | null;
  }

  // `destination` distinguishes ABSENT from explicitly NULL. It used to default with
  // `cols.destination ?? "https://api.notion.com"`, and `??` cannot tell those apart —
  // so the one caller that passed `destination: null` (the device_local test) silently
  // received a network destination and was refused `sandbox_local_network_destination`
  // by rule 4, never reaching the branch it was written to exercise.
  async function mintHandle(jobId: string, handle: string, cols: HandleCols): Promise<void> {
    const { admin } = guardCtx();
    await admin`INSERT INTO job_secret_handles
      (organization_id, job_id, handle, ref_kind, ref_id, materialization, use_policy, destination,
       status, owner_principal_kind, owner_principal_id)
      VALUES (${ORG}, ${jobId}, ${handle},
        ${cols.refKind ?? "connector_oauth"}, ${cols.refId ?? "mcp:oauth:notion"},
        ${cols.materialization ?? "proxy"}, ${cols.usePolicy ?? "fence_proxy"},
        ${cols.destination === undefined ? "https://api.notion.com" : cols.destination},
        ${cols.status ?? "active"}, ${cols.ownerPrincipalKind ?? null}, ${cols.ownerPrincipalId ?? null})`;
  }

  function egressRequest(offer: LeaseOfferV1, handleId: string, requestedUrl: string) {
    return {
      workerId: WORKER,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      handleId,
      requestedUrl,
    };
  }

  async function handleRow(handle: string): Promise<Record<string, unknown> | undefined> {
    const { admin } = guardCtx();
    const [row] = await admin<Record<string, unknown>[]>`SELECT * FROM job_secret_handles WHERE handle = ${handle}`;
    return row;
  }

  function proxyDeps(extra: {
    brokers: SecretBrokerSet;
    resolveAddresses?: (host: string) => Promise<string[]>;
    dispatch?: (input: EgressDispatchInput) => Promise<{ status: number }>;
    resolveNetworkPolicy?: () => Promise<NetworkPolicyV1 | null>;
    controlPlane?: { cidrs: string[] };
  }) {
    const { app } = guardCtx();
    return createFenceAwareEgressProxy({
      appDb: app.db,
      brokers: extra.brokers,
      resolveNetworkPolicy: extra.resolveNetworkPolicy ?? (async () => policyV1()),
      resolveAddresses: extra.resolveAddresses ?? (async () => ["104.18.32.7"]),
      dispatch: extra.dispatch,
      controlPlane: extra.controlPlane,
    });
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-dat005-"));
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
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DAT-005 org', 'dat-005-org')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'DAT-005 company', 'D005')`;
      // DSK-001 Lane B (C-8). This suite seeded NO company_memberships, so the
      // owner-bound device_local handle below was refused `owner_membership_lost` at
      // AUTHORIZATION and never reached the egress-layer check the test is named for.
      // Both paths deny `malformed` (non-disclosing by design), so the test passed
      // while proving nothing.
      await admin`INSERT INTO company_memberships (company_id, principal_type, principal_id, status)
        VALUES (${COMPANY}, 'user', ${OWNER_USER}, 'active')`;
      await admin`INSERT INTO "user" (id, name, email, created_at, updated_at)
        VALUES (${OWNER_USER}, 'DAT-005 owner', 'owner@dat-005.test', now(), now())`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'dat-005-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      // The credential the device_local handle points at. `execution_target_id` is THIS
      // target: a device_local value lives in one machine's OS keystore, and the job
      // must be placed on that machine to read it.
      await admin`INSERT INTO provider_credentials
        (id, company_id, provider, owner_user_id, execution_target_id, kind, state, verified_at)
        VALUES (${DEVICE_CREDENTIAL}, ${COMPANY}, 'anthropic', ${OWNER_USER}, ${TARGET},
                'personal_subscription', 'verified', now())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'dat-005-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'DAT-005 worker', 'enrolled')`;
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

  // ---- schema: the applied_policy_version column exists, no value column ----

  it("job_secret_handles has applied_policy_version and NO secret value column", async () => {
    const { admin } = guardCtx();
    const cols = await admin<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'job_secret_handles'`;
    const names = cols.map((c) => c.column_name);
    expect(names).toContain("applied_policy_version");
    for (const banned of ["value", "secret", "secret_value", "material", "plaintext"]) {
      expect(names).not.toContain(banned);
    }
  });

  // ---- default-deny ALLOW → dispatched + version persisted + value in headers --

  it("allows an allowlisted public destination: dispatches with the value in HEADERS, persists applied_policy_version, never the value", async () => {
    const brokers = recordingBrokers();
    const rec = recordingDispatch();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-allow", {});
    const proxy = proxyDeps({ brokers, dispatch: rec.dispatch });
    const res = await proxy.egress({ auth: auth(`e-${crypto.randomUUID()}`), request: egressRequest(offer, "h-allow", "https://api.notion.com/v1/pages") });
    expect(res.outcome).toBe("dispatched");
    if (res.outcome !== "dispatched") return;
    expect(res.status).toBe(200);
    expect(res.appliedPolicyVersion).toBe(5);
    // The value went into the request HEADERS at delivery, pinned to the resolved IP.
    expect(rec.captured).toHaveLength(1);
    const call = rec.captured[0]!;
    expect(call.options.host).toBe("104.18.32.7"); // socket pinned to the resolved IP
    // node Headers lowercases keys; the materialized value is in the Authorization header.
    const headers = call.options.headers as Record<string, string> | undefined;
    expect(String(headers?.authorization)).toContain(SECRET_MARKER);
    expect(headers?.host).toBe("api.notion.com");
    // The version is persisted; the VALUE is never anywhere in the DB row.
    const row = await handleRow("h-allow");
    expect(row?.applied_policy_version).toBe(5);
    expect(row?.resolve_count).toBe(1);
    expect(JSON.stringify(row)).not.toContain(SECRET_MARKER);
  }, 60_000);

  // ---- IP-range block + DNS-rebind: deny + NO dispatch + NO value resolved ----

  it("denies a rebind to an RFC1918 address as 'private' — classification runs after the fenced reauth, and the value is NEVER dispatched", async () => {
    const brokers = recordingBrokers();
    const rec = recordingDispatch();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-rebind", {});
    const proxy = proxyDeps({ brokers, dispatch: rec.dispatch, resolveAddresses: async () => ["10.0.0.5"] });
    const res = await proxy.egress({ auth: auth(`e-${crypto.randomUUID()}`), request: egressRequest(offer, "h-rebind", "https://api.notion.com/v1/pages") });
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") return;
    expect(res.reason).toBe("private");
    // The value was resolved behind the fence (per the D2 reauth-then-classify order)
    // but is materialized ONLY at delivery — a denied destination NEVER dispatches it.
    expect(rec.captured).toHaveLength(0);
  }, 60_000);

  it("denies the cloud metadata address as 'metadata'", async () => {
    const brokers = recordingBrokers();
    const rec = recordingDispatch();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-meta", {});
    const proxy = proxyDeps({ brokers, dispatch: rec.dispatch, resolveAddresses: async () => ["169.254.169.254"] });
    const res = await proxy.egress({ auth: auth(`e-${crypto.randomUUID()}`), request: egressRequest(offer, "h-meta", "https://api.notion.com/v1") });
    expect(res.outcome === "denied" && res.reason).toBe("metadata");
    expect(rec.captured).toHaveLength(0);
  }, 60_000);

  it("denies a config-sourced control-plane address as 'control_plane'", async () => {
    const brokers = recordingBrokers();
    const rec = recordingDispatch();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-cp", {});
    const proxy = proxyDeps({ brokers, dispatch: rec.dispatch, resolveAddresses: async () => ["45.55.9.9"], controlPlane: { cidrs: ["45.55.0.0/16"] } });
    const res = await proxy.egress({ auth: auth(`e-${crypto.randomUUID()}`), request: egressRequest(offer, "h-cp", "https://api.notion.com/v1") });
    expect(res.outcome === "denied" && res.reason).toBe("control_plane");
    expect(rec.captured).toHaveLength(0);
  }, 60_000);

  // ---- destination binding: a handle bound to X can't reach Y ----------------

  it("denies a requested URL whose host is not the handle's bound destination as 'not_allowlisted'", async () => {
    const brokers = recordingBrokers();
    const rec = recordingDispatch();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-bind", { destination: "https://api.notion.com" });
    const proxy = proxyDeps({ brokers, dispatch: rec.dispatch });
    // Requested host differs from the bound destination host.
    const res = await proxy.egress({ auth: auth(`e-${crypto.randomUUID()}`), request: egressRequest(offer, "h-bind", "https://evil.example/steal") });
    expect(res.outcome === "denied" && res.reason).toBe("not_allowlisted");
    expect(rec.captured).toHaveLength(0);
  }, 60_000);

  // ---- fence-first: a stale fence denies before classification ---------------

  it("denies 'stale_fence' when the lease has expired, with no dispatch and no version persisted", async () => {
    const brokers = recordingBrokers();
    const rec = recordingDispatch();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-stale", {});
    await expireLease(offer.leaseId);
    const proxy = proxyDeps({ brokers, dispatch: rec.dispatch });
    const res = await proxy.egress({ auth: auth(`e-${crypto.randomUUID()}`), request: egressRequest(offer, "h-stale", "https://api.notion.com/v1") });
    expect(res.outcome === "denied" && res.reason).toBe("stale_fence");
    expect(rec.captured).toHaveLength(0);
    expect(brokers.calls).toEqual([]);
    const row = await handleRow("h-stale");
    expect(row?.applied_policy_version ?? null).toBeNull();
  }, 60_000);

  // ---- fail-closed: missing policy → malformed, no reauth, no dispatch -------

  it("fails closed to 'malformed' when the network policy is unavailable", async () => {
    const brokers = recordingBrokers();
    const rec = recordingDispatch();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-nopolicy", {});
    const proxy = proxyDeps({ brokers, dispatch: rec.dispatch, resolveNetworkPolicy: async () => null });
    const res = await proxy.egress({ auth: auth(`e-${crypto.randomUUID()}`), request: egressRequest(offer, "h-nopolicy", "https://api.notion.com/v1") });
    expect(res.outcome === "denied" && res.reason).toBe("malformed");
    expect(rec.captured).toHaveLength(0);
    expect(brokers.calls).toEqual([]);
  }, 60_000);

  // ---- a device_local (non-network) handle can never egress ------------------

  it("denies 'malformed' for a device_local handle (non-network) — never dispatches", async () => {
    const brokers = recordingBrokers();
    const rec = recordingDispatch();
    const { offer } = await activateLease();
    await mintHandle(offer.job.jobId, "h-device", {
      refKind: "device_local", refId: DEVICE_CREDENTIAL, materialization: "file", usePolicy: "sandbox_local_only",
      destination: null, ownerPrincipalKind: "user", ownerPrincipalId: OWNER_USER,
    });
    const proxy = proxyDeps({ brokers, dispatch: rec.dispatch });
    const res = await proxy.egress({ auth: auth(`e-${crypto.randomUUID()}`), request: egressRequest(offer, "h-device", "https://api.notion.com/v1") });
    expect(res.outcome === "denied" && res.reason).toBe("malformed");
    expect(rec.captured).toHaveLength(0);
    // C-8: prove the denial came from the EGRESS layer, not from authorization.
    // Both refusals surface the same opaque `malformed`, so the reason alone cannot
    // tell them apart. The audit can: `resolveExecutionSecret` increments
    // resolve_count only AFTER authorizeSecretResolve admits, so a non-zero count
    // means the fence said yes and the proxy is what refused to egress a value it
    // cannot hold.
    const { admin: adminSql } = guardCtx();
    const [audited] = await adminSql`SELECT resolve_count FROM job_secret_handles
      WHERE organization_id = ${ORG} AND handle = 'h-device'`;
    expect(Number(audited?.resolve_count ?? 0)).toBe(1);
  }, 60_000);
});
