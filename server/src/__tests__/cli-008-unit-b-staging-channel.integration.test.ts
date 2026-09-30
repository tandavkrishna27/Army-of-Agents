// server/src/__tests__/cli-008-unit-b-staging-channel.integration.test.ts
//
// CLI-008 Unit B · Task 5 — THE CHANNEL, END TO END, THROUGH THE MOCK TRANSPORT.
//
// A file authored by the control plane appears INSIDE the sandbox before the agent runs.
// Every link is the real one:
//
//   stageJobInputFiles          real object store double + a REAL committed `job_artifacts`
//                               row on `aoa_app` against embedded PostgreSQL
//   buildJobEnvelope            the REAL leasing service's poll, which emits the staged-input
//                               pointer in the frozen envelope's `extensions[]`
//   createStagedInputResolver   the REAL worker-side reader + grant minter, over a REAL
//                               `artifact_transfer_grant` download branch on a REAL live fence
//   E2bSandboxProvider          the REAL driver, redeeming the grant and calling the REAL
//                               `transport.writeFiles`
//   MockE2bTransport            models an in-memory filesystem, so the file is READ BACK
//
// No E2B key is needed and no network is touched. The one seam that is a double rather than
// the real thing is the HTTP/device-proof hop: the client double hands the signed request
// bytes straight to the grant service instead of posting them. That layer is proven
// separately (`artifact-transfer-commit.integration.test.ts`, the worker transport tests);
// what THIS file proves is that the four orphaned components compose.

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
  type LeaseAckOperationRequestV1,
  type LeaseOfferV1,
  type PollRequestV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
  type WorkerEventV1,
} from "@armyofagents/worker-protocol";
import {
  createStagedInputResolver,
  createSupervisor,
  generateDeviceKey,
  readStagedInputPointers,
} from "@armyofagents/worker-daemon";
// Relative, not a package specifier: `@armyofagents/sandbox-e2b-provider` is deliberately NOT
// a server dependency — the control plane must never gain a provider in its runtime graph. The
// same shape `job-leasing.integration.test.ts` uses to reach into `packages/db`.
import { E2bSandboxProvider } from "../../../packages/sandbox-e2b-provider/src/e2b-provider.js";
import { MockE2bTransport } from "../../../packages/sandbox-e2b-provider/src/mock-transport.js";

import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { createJobLeasingService, type VerifiedWorkerOperation } from "../services/job-leasing.js";
import { createArtifactTransferGrantService } from "../services/artifact-transfer-grant.js";
import { stageJobInputFiles } from "../services/job-input-staging.js";
import type { PresignResult, StorageProvider } from "../storage/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORG = "c8b00000-0000-4000-8000-000000000001";
const COMPANY = "c8b00000-0000-4000-8000-000000000002";
const TARGET = "c8b00000-0000-4000-8000-000000000003";
const WORKER = "c8b00000-0000-4000-8000-000000000005";
const PASSWORD = "cli-008-e2e-password";
const POLICY_HASH = "3".repeat(64);
const THUMBPRINT = "4".repeat(64);
const AUTHORITY_KEY = `organization:${ORG}`;

// The two files Units C and D will eventually author. Here they are just bytes, which is the
// point: Unit B is the channel and knows nothing about what rides it.
const MCP_PATH = "/home/user/.aoa/mcp.json";
const MCP_BODY = '{"mcpServers":{"aoa":{"type":"http","url":"https://cp.example/companies/c/mcp"}}}';
const AGENTS_PATH = "/home/user/.aoa/AGENTS.md";
const AGENTS_BODY = "# Agent instructions\n\nDo the task described in the prompt.\n";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const sha256 = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");

function providerProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "cli-008-provider",
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
    agentVersion: "cli-008-integration",
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

/** An in-memory object store that both accepts the control plane's PUT and serves the
 * worker's presigned GET — the same bytes, so the digest check is meaningful. */
function makeStore() {
  const objects = new Map<string, Buffer>();
  const presignCalls: string[] = [];
  const provider: StorageProvider = {
    id: "s3",
    async putObject(input) { objects.set(input.objectKey, Buffer.from(input.body)); },
    async getObject() { throw new Error("not used"); },
    async headObject(input) {
      const object = objects.get(input.objectKey);
      return object ? { exists: true, contentLength: object.byteLength } : { exists: false };
    },
    async deleteObject(input) { objects.delete(input.objectKey); },
    async presignGet(input): Promise<PresignResult> {
      presignCalls.push(`GET ${input.objectKey}`);
      return { method: "GET", url: `https://store.example/get/${encodeURIComponent(input.objectKey)}?sig=1`, headers: {} };
    },
    async presignPut(input): Promise<PresignResult> {
      presignCalls.push(`PUT ${input.objectKey}`);
      return { method: "PUT", url: `https://store.example/put/${encodeURIComponent(input.objectKey)}?sig=1`, headers: {} };
    },
  };
  return { objects, presignCalls, provider };
}

/**
 * A transport that snapshots the sandbox filesystem AT THE MOMENT THE TENANT COMMAND RUNS.
 *
 * ★ The snapshot is taken inside `runCommand`, not after `accept()` returns, and that is the
 * whole point: the claim under test is "the file is inside the sandbox BEFORE the agent runs".
 * Reading afterwards could not prove it — the supervisor destroys the sandbox on the happy
 * path, so a post-hoc read would find nothing whether staging worked or not.
 */
function observingTransport(inner: MockE2bTransport, watchDir: string) {
  const snapshot: Record<string, string> = {};
  let ran = 0;
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "runCommand") {
        return async (req: Parameters<MockE2bTransport["runCommand"]>[0], handlers?: unknown) => {
          ran += 1;
          for (const path of await target.listDir(req.sandboxId, watchDir)) {
            snapshot[path] = dec(await target.readFile(req.sandboxId, path));
          }
          return target.runCommand(req, handlers as never);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { proxy: proxy as MockE2bTransport, snapshot, ranCount: () => ran };
}

integration("CLI-008 Unit B — the staging channel, end to end", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;
  let ordinal = 7_000;

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
      publicKey: "cli-008-public-key",
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
      device_public_key = 'cli-008-public-key', device_thumbprint = ${THUMBPRINT},
      last_seen_at = clock_timestamp() WHERE id = ${WORKER}`;
  }

  async function seedPlacedJob(n: number): Promise<{ jobId: string; attemptId: string }> {
    const { admin } = ctx();
    const suffix = n.toString().padStart(12, "0");
    const jobId = `c8b10000-0000-4000-8000-${suffix}`;
    const attemptId = `c8b20000-0000-4000-8000-${suffix}`;
    const outboxId = `c8b30000-0000-4000-8000-${suffix}`;
    const provider = providerProfile();
    const profile = registeredProfile(provider);
    const profileHash = sha256(canonicalizeJsonV1(profile));
    const availableAt = new Date(Date.now() - 60_000 + n);
    const workload = { command: "claude", args: ["--print", "do the task"], stdinArtifactId: null, maxRuntimeSeconds: 240 };
    await admin`INSERT INTO jobs
      (id, organization_id, company_id, workload_type, source_kind, source_identity, source_intent,
       requester_principal_kind, requester_principal_id, executor_principal_kind, executor_principal_id,
       input, input_hash, policy_snapshot, policy_hash, requirements, placement_request,
       available_at, priority, status, created_at, updated_at)
      VALUES (${jobId}, ${ORG}, ${COMPANY}, 'batch', 'one_shot', ${jobId},
        ${{ kind: "one_shot", operationId: jobId, operationKind: "extraction" }},
        'system', 'cli-008-test', 'worker', ${WORKER}, ${workload},
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

  /**
   * Stage `files`, then take a real lease. Staging happens BEFORE the poll, which is the
   * production ordering: the attempt becomes leasable only after placement, and the bytes must
   * be committed before a worker can be offered the job.
   */
  async function stageThenLease(files: readonly { path: string; bytes: Uint8Array }[]) {
    const { app } = ctx();
    const n = ordinal++;
    await resetRuntimeRows();
    const seeded = await seedPlacedJob(n);
    const store = makeStore();
    const staged = await stageJobInputFiles({
      appDb: app.db,
      storage: store.provider,
      organizationId: ORG,
      companyId: COMPANY,
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      files,
    });
    const leasing = createJobLeasingService({ appDb: app.db });
    const polled = await leasing.poll({ auth: auth(`p-${n}`), request: pollRequest(`p-${n}`) });
    if (polled.outcome !== "offer") throw new Error(`expected an offer, got ${polled.outcome}`);
    const offer = polled.body;
    const acked = await leasing.ack({ auth: auth(`a-${n}`), request: ackRequest(offer) });
    if (acked.outcome !== "acknowledged") throw new Error("expected an ack");
    return { seeded, offer, store, staged };
  }

  /** The worker's control-plane client, with the HTTP hop replaced by a direct call into the
   * REAL grant service. Everything the service decides — fence, tenant, prefix, committed
   * existence — is real. */
  function grantClient(store: ReturnType<typeof makeStore>) {
    const { app } = ctx();
    const service = createArtifactTransferGrantService({ appDb: app.db, storage: store.provider });
    const requests: unknown[] = [];
    return {
      requests,
      client: {
        artifactTransferGrantPath: "/api/worker-control/artifacts/transfer-grant",
        async artifactTransferGrant(request: { bytes: Buffer }) {
          const parsed = JSON.parse(request.bytes.toString("utf8"));
          requests.push(parsed);
          const body = await service.grant({
            auth: auth(`g-${crypto.randomUUID()}`),
            request: parsed,
          });
          return { status: 200, body };
        },
      },
    };
  }

  /** A supervisor over the REAL E2B driver logic and the fs-modelling mock transport. */
  function supervisorOver(
    transport: MockE2bTransport,
    store: ReturnType<typeof makeStore>,
    resolveStagedFiles?: (input: { handoff: unknown }) => Promise<readonly unknown[]>,
  ) {
    const events: WorkerEventV1[] = [];
    const provider = new E2bSandboxProvider({
      transport,
      // The "presigned GET": the store serves the same bytes the control plane PUT.
      redeemDownloadGrant: async (grant) => {
        const object = store.objects.get(grant.objectKey);
        if (!object) throw new Error("no such object");
        return new Uint8Array(object);
      },
    });
    const supervisor = createSupervisor({
      provider,
      identity: { targetId: TARGET, deviceGeneration: 1 },
      eventSink: { emit: (event) => { events.push(event); } },
      redactionCanaries: [],
      resolveStagedFiles: resolveStagedFiles as never,
    });
    return { supervisor, events, provider };
  }

  function sandboxIdOf(events: readonly WorkerEventV1[]): string {
    const started = events.find((event) => event.eventType === "attempt_started");
    const payload = started?.payload as { sandboxId?: string } | undefined;
    if (!payload?.sandboxId) throw new Error("no attempt_started event carried a sandboxId");
    return payload.sandboxId;
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-cli008e2e-"));
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
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'CLI-008 e2e', 'cli-008-e2e')`;
      await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (${COMPANY}, ${ORG}, 'CLI-008 e2e company', 'C8E')`;
      const provider = providerProfile();
      const profile = registeredProfile(provider);
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'cli-008-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${profile}, ${sha256(canonicalizeJsonV1(profile))},
          ${provider}, clock_timestamp())`;
      const hello = workerHello();
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, 'cli-008-public-key',
          ${THUMBPRINT}, 1, ${sha256(JSON.stringify(hello))}, ${hello}, clock_timestamp(),
          clock_timestamp(), 'CLI-008 worker', 'enrolled')`;
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close({ timeoutSeconds: 5 }).catch(() => {});
    await admin?.end().catch(() => {});
    await embedded?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it("★★ a file authored by the CONTROL PLANE is inside the sandbox before the agent runs", async () => {
    const { offer, store } = await stageThenLease([
      { path: MCP_PATH, bytes: enc(MCP_BODY) },
      { path: AGENTS_PATH, bytes: enc(AGENTS_BODY) },
    ]);

    // LINK 1 — the envelope carries the pointer the control plane's write produced.
    const pointers = readStagedInputPointers(offer.job.extensions);
    expect(pointers.map((p) => p.path).sort()).toEqual([AGENTS_PATH, MCP_PATH]);
    expect(pointers.find((p) => p.path === MCP_PATH)?.sha256).toBe(sha256(MCP_BODY));

    // LINK 2 — the worker mints REAL download grants over the frozen op.
    const { client, requests } = grantClient(store);
    const resolveStagedFiles = createStagedInputResolver({
      client: client as never,
      key: generateDeviceKey(),
      session: async () => ({ token: "session-token", expiresAt: new Date(Date.now() + 600_000) } as never),
    });

    // LINK 3 + 4 — the provider redeems and writes; the mock transport is the filesystem.
    const observed = observingTransport(new MockE2bTransport(), "/home/user/.aoa");
    const { supervisor, events } = supervisorOver(observed.proxy, store, resolveStagedFiles as never);
    await supervisor.accept({
      offer,
      leaseId: String(offer.leaseId),
      fenceToken: String(offer.fenceToken),
      workloadClass: "batch",
    } as never);

    // ★ THE ASSERTION THIS UNIT EXISTS FOR: at the instant the tenant command runs, the files
    // the control plane authored are INSIDE the sandbox, with the right bytes.
    expect(observed.ranCount()).toBe(1);
    expect(observed.snapshot[MCP_PATH]).toBe(MCP_BODY);
    expect(observed.snapshot[AGENTS_PATH]).toBe(AGENTS_BODY);
    expect(sandboxIdOf(events)).toMatch(/^sbx-/);

    // …and the run really did proceed to a successful terminal, so staging is not a detour
    // that happens to leave a file behind on a broken run.
    const terminal = events.find((event) => event.eventType === "terminal");
    expect((terminal?.payload as { status?: string } | undefined)?.status).toBe("succeeded");

    // Two grants were minted, one per file, and both were downloads.
    expect(requests).toHaveLength(2);
    expect(store.presignCalls.filter((call) => call.startsWith("GET "))).toHaveLength(2);
  }, 120_000);

  it("★ THE NEGATIVE: with NO staged bundle, `execute` still runs", async () => {
    // Staging must be optional, or every existing run breaks. This is the case that is true
    // of every production run today.
    const { offer, store } = await stageThenLease([]);
    expect(readStagedInputPointers(offer.job.extensions)).toEqual([]);
    expect(offer.job.extensions).toEqual([]);

    const { client } = grantClient(store);
    const resolveStagedFiles = createStagedInputResolver({
      client: client as never,
      key: generateDeviceKey(),
      session: async () => ({ token: "session-token", expiresAt: new Date(Date.now() + 600_000) } as never),
    });
    const observed = observingTransport(new MockE2bTransport(), "/home/user/.aoa");
    const { supervisor, events } = supervisorOver(observed.proxy, store, resolveStagedFiles as never);
    await supervisor.accept({
      offer,
      leaseId: String(offer.leaseId),
      fenceToken: String(offer.fenceToken),
      workloadClass: "batch",
    } as never);

    const terminal = events.find((event) => event.eventType === "terminal");
    expect((terminal?.payload as { status?: string } | undefined)?.status).toBe("succeeded");
    // The tenant command ran — and nothing was staged into the sandbox.
    expect(observed.ranCount()).toBe(1);
    expect(observed.snapshot).toEqual({});
    expect(store.presignCalls).toEqual([]);
  }, 120_000);

  it("★ a staged file whose bytes were TAMPERED WITH in the store fails the attempt CLOSED", async () => {
    // The one outcome the whole verification chain exists to prevent: an agent running on
    // content nobody authored, with a clean terminal.
    const { offer, store } = await stageThenLease([{ path: MCP_PATH, bytes: enc(MCP_BODY) }]);
    const pointer = readStagedInputPointers(offer.job.extensions)[0]!;
    store.objects.set(pointer.objectKey, Buffer.from("tampered"));

    const { client } = grantClient(store);
    const resolveStagedFiles = createStagedInputResolver({
      client: client as never,
      key: generateDeviceKey(),
      session: async () => ({ token: "session-token", expiresAt: new Date(Date.now() + 600_000) } as never),
    });
    const observed = observingTransport(new MockE2bTransport(), "/home/user/.aoa");
    const { supervisor, events } = supervisorOver(observed.proxy, store, resolveStagedFiles as never);
    await supervisor.accept({
      offer,
      leaseId: String(offer.leaseId),
      fenceToken: String(offer.fenceToken),
      workloadClass: "batch",
    } as never);

    const terminal = events.find((event) => event.eventType === "terminal");
    expect((terminal?.payload as { status?: string; errorCode?: string } | undefined)).toMatchObject({
      status: "failed",
      errorCode: "stage_input_failed",
    });
    // The tenant command NEVER started.
    expect(events.some((event) => event.eventType === "attempt_started")).toBe(false);
  }, 120_000);

  it("★ a pointer whose artifact was never committed fails the attempt CLOSED", async () => {
    // The download branch proves committed existence under this tenant before it presigns
    // anything, so a pointer to a phantom artifact is refused at the control plane.
    const { offer, store } = await stageThenLease([{ path: MCP_PATH, bytes: enc(MCP_BODY) }]);
    const { admin } = ctx();
    await admin`DELETE FROM job_artifacts WHERE job_id = ${offer.job.jobId}`;

    const { client } = grantClient(store);
    const resolveStagedFiles = createStagedInputResolver({
      client: client as never,
      key: generateDeviceKey(),
      session: async () => ({ token: "session-token", expiresAt: new Date(Date.now() + 600_000) } as never),
    });
    const observed = observingTransport(new MockE2bTransport(), "/home/user/.aoa");
    const { supervisor, events } = supervisorOver(observed.proxy, store, resolveStagedFiles as never);
    await supervisor.accept({
      offer,
      leaseId: String(offer.leaseId),
      fenceToken: String(offer.fenceToken),
      workloadClass: "batch",
    } as never);

    const terminal = events.find((event) => event.eventType === "terminal");
    expect((terminal?.payload as { status?: string; errorCode?: string } | undefined)).toMatchObject({
      status: "failed",
      errorCode: "stage_input_unavailable",
    });
    expect(events.some((event) => event.eventType === "attempt_started")).toBe(false);
  }, 120_000);
});
