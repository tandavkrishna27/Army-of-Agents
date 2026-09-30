// -----------------------------------------------------------------------------
// CLI-006 / D2 — Sprint 5b, "Leg B Part 2": the credential resolve over a LIVE
// fence (DAT-008 slice 5 §8's residual).
//
// Leg B Part 1 (composed-loop-real-server.integration.test.ts) proved the composed
// poll loop leases a REAL server-minted attempt over the REAL routes, but the seeded
// attempt carried NO secret handle, so the credential resolve was never exercised.
// DAT-008 slice 5 (execution-secret-resolve-worker.integration.test.ts) drove the
// worker's redeem client against the REAL resolve route, but with fenceToken
// "no-such-fence" and no minted handle — so it proved the wire + fail-closed denial,
// NOT a live `resolved` value ("The RESOLVED-path value return over a live fence …
// is Sprint 5's journey", that test's header).
//
// This test ALIGNS the three pieces that residual named — a real active fence + a
// minted `provider_key` handle + a Company provider-key store — in ONE embedded-PG
// harness, and drives the worker's REAL redemption (createRedeemer +
// synthesiseRunSecrets, replicating dispatch-runtime.ts:138-150 verbatim) over the
// REAL resolve route on the SERVER-MINTED fence. The worker gets a genuine
// `outcome:"resolved"` and the real decrypted value.
//
// Boundary held: the provider-key VALUE is a synthetic random string (never a real
// key — Decision #104 containment), and there is NO sandbox (the value is asserted in
// `env`, not forwarded to E2B — that forwarding is E7-1, which stays `unwired`). Real
// E2B is proven nowhere here, by design.
//
// dist-rebuild gotcha (Leg B Part 1): the server test imports the BUILT
// @armyofagents/worker-daemon, so any edit to secret-redemption.ts / createRedeemer /
// synthesiseRunSecrets needs `pnpm --filter worker-daemon build` before it is seen.
// -----------------------------------------------------------------------------

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net, { type AddressInfo } from "node:net";
import type { Server } from "node:http";
import postgres, { type Sql } from "postgres";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  createOperatorDbConnection,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import {
  ConcurrencyLimiter,
  createControlPlaneClient,
  createPollLoop,
  createRedeemer,
  createSessionProvider,
  generateDeviceKey,
  measureCapacity,
  SecretMaterializationError,
  SessionStore,
  synthesiseRunSecrets,
  type CapacityProbes,
  type DeviceKey,
  type LeaseHandoff,
  type WorkerSelfModel,
  type WorkerSession,
} from "@armyofagents/worker-daemon";
import {
  registeredTargetProfileV1Schema,
  verifyAndBrandProviderConstraintProfileV1,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { workerControlRoutes } from "../routes/worker-control.js";
import { createWorkerSessionToken, SESSION_MAX_MS } from "../middleware/worker-session-auth.js";
import { digestHello } from "../services/worker-hello-refresh.js";
import { secretService } from "../services/secrets.js";
import { errorHandler } from "../middleware/error-handler.js";

const sha256hex = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../tests/fixtures/worker-provisioned-target.json", import.meta.url)), "utf8"),
) as {
  ids: { organizationId: string; targetId: string; policyHash: string };
  registeredProfile: Record<string, unknown>;
  registeredProfileHash: string;
  providerConstraintProfile: Record<string, unknown> & { digest: string };
  leaseOffer: { workerId: string; job: { jobId: string } };
};

const ORG = FIXTURE.ids.organizationId;
const TARGET = FIXTURE.ids.targetId;
const WORKER = FIXTURE.leaseOffer.workerId;
const COMPANY = "b0000000-0000-4000-8000-000000000002";
const JOB = FIXTURE.leaseOffer.job.jobId;
const ATTEMPT = "b6200000-0000-4000-8000-000000000001";
const OUTBOX = "b6300000-0000-4000-8000-000000000001";
const POLICY_HASH = FIXTURE.ids.policyHash;
const AUTHORITY_KEY = `organization:${ORG}`;
const PASSWORD = "legb2-role-password";
const SIGNING_KEY = "legb2-session-signing-key-at-least-32-bytes-long";

// The Company provider-key store the canary `provider_key` handle resolves against.
const PROVIDER_SECRET_NAME = "provider:anthropic";
const ENV_TARGET = "ANTHROPIC_API_KEY";
// A SYNTHETIC provider-key value — never a real key (Decision #104). Fresh per run so
// the resolve assertion cannot pass against a hardcoded/guessed constant.
const SYNTHETIC_PROVIDER_KEY = `sk-ant-legb2-${randomBytes(24).toString("hex")}`;
// A fixed 32-byte master key so local-encrypted-provider can encrypt/decrypt in-test.
const TEST_MASTER_KEY_HEX = "1f".repeat(32);

// A REAL (aligned) clock — NOT frozen (Leg B Part 1): a far-frozen clock trips the
// poll's 300s heartbeat-age gate and the ±5min device-proof skew window.
const now = () => new Date();

function provisionedHello(): WorkerHelloV1 {
  return {
    protocolVersion: 1,
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 1,
    agentVersion: "legb2",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "desktop" },
    reportedCapabilities: ["workload.batch"],
    capacity: { batchSlots: 2, browserSessionSlots: 0, serviceSlots: 0, freeCpuMillis: 2_000, freeMemoryMiB: 4_096, freeDiskMiB: 8_192 },
    policyHash: POLICY_HASH,
  } as WorkerHelloV1;
}

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let admin: Sql | null = null;
let appConn: NonOwnerDbConnection | null = null;
let operatorConn: NonOwnerDbConnection | null = null;
let ownerDb: ReturnType<typeof createDb> | null = null;
let httpServer: Server | null = null;
let baseUrl = "";
let setupError: unknown = null;
let priorMasterKey: string | undefined;

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) =>
        error ? reject(error) : !address || typeof address === "string" ? reject(new Error("port")) : resolve(address.port),
      );
    });
    server.on("error", reject);
  });
}

beforeAll(async () => {
  try {
    // Set the secrets master key so the local-encrypted provider can encrypt (seed)
    // and decrypt (resolve) the Company key. Restored in afterAll.
    priorMasterKey = process.env.AOA_SECRETS_MASTER_KEY;
    process.env.AOA_SECRETS_MASTER_KEY = TEST_MASTER_KEY_HEX;

    dataDir = await mkdtemp(join(tmpdir(), "aoa-legb2-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    const pgPort = await allocatePort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: pgPort,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    const adminUrl = `postgres://test:test@127.0.0.1:${pgPort}/postgres`;
    await applyPendingMigrations(adminUrl);
    admin = postgres(adminUrl, { max: 1 });
    ownerDb = createDb(adminUrl);
    await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
    await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", PASSWORD));
    appConn = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`));
    operatorConn = createOperatorDbConnection(adminUrl.replace("test:test", `aoa_operator:${PASSWORD}`));
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Leg B2', 'leg-b2')`;
    await admin`INSERT INTO companies (id, organization_id, name, issue_prefix) VALUES (${COMPANY}, ${ORG}, 'Leg B2 Co', 'LGC')`;

    // Seed the Company provider-key secret via the REAL encryption chokepoint
    // (secretService.create → local-encrypted-provider, AES-256-GCM). This writes
    // company_secrets (active, latestVersion 1) + company_secret_versions (current).
    await secretService(ownerDb).create(COMPANY, {
      name: PROVIDER_SECRET_NAME,
      provider: "local_encrypted",
      managedMode: "aoa_managed",
      value: SYNTHETIC_PROVIDER_KEY,
    });

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, bytes) => {
          (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
        },
      }),
    );
    app.use(
      "/api",
      workerControlRoutes({ db: ownerDb, appDb: appConn.db, operatorDb: operatorConn.db, sessionSigningKey: SIGNING_KEY, now }),
    );
    app.use(errorHandler);
    httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((res) => httpServer!.once("listening", () => res()));
    baseUrl = `http://127.0.0.1:${(httpServer!.address() as AddressInfo).port}`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try {
    await new Promise<void>((res) => (httpServer ? httpServer.close(() => res()) : res()));
  } catch {
    /* ignore */
  }
  try {
    await ownerDb?.$client.end();
  } catch {
    /* ignore */
  }
  try {
    await operatorConn?.close({ timeoutSeconds: 5 });
  } catch {
    /* ignore */
  }
  try {
    await appConn?.close({ timeoutSeconds: 5 });
  } catch {
    /* ignore */
  }
  try {
    await admin?.end();
  } catch {
    /* ignore */
  }
  try {
    await embedded?.stop();
  } catch {
    /* ignore */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (priorMasterKey === undefined) delete process.env.AOA_SECRETS_MASTER_KEY;
  else process.env.AOA_SECRETS_MASTER_KEY = priorMasterKey;
}, 60_000);

/**
 * Seed a ratified target + a PROVISIONED worker bound to `key`, a lease-eligible batch
 * attempt (the Leg B Part 1 recipe), AND a `provider_key`/env/sandbox_local_only secret
 * handle on the job (the CLI-007-minted shape — a REFERENCE, never a value).
 *
 * `handleId` is the opaque handle (a uuid — the resolve request schema requires one);
 * `refId` is the Company secret NAME the broker resolves by (`provider:anthropic` for
 * the happy path, or a nonexistent name to exercise the fail-closed value-store path).
 */
async function seed(key: DeviceKey, opts: { handleId: string; refId: string }): Promise<void> {
  if (!admin) throw new Error("no admin conn");
  const hello = provisionedHello();
  const profileHash = digestHello(hello);
  // job_secret_handles CASCADEs with jobs; delete jobs last so the cascade is clean.
  await admin`DELETE FROM job_outbox`;
  await admin`DELETE FROM job_attempts`;
  await admin`DELETE FROM jobs`;
  await admin`DELETE FROM leases`;
  await admin`DELETE FROM worker_proof_replays`;
  await admin`DELETE FROM workers`;
  await admin`DELETE FROM execution_targets`;
  await admin`INSERT INTO execution_targets
    (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
     target_authority_key, device_generation, registered_profile, registered_profile_hash,
     provider_constraint_profile, worker_token_hash, last_seen_at)
    VALUES (${TARGET}, ${ORG}, 'legb2-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
      'organization', ${AUTHORITY_KEY}, 1, ${FIXTURE.registeredProfile}, ${FIXTURE.registeredProfileHash},
      ${FIXTURE.providerConstraintProfile}, ${null}, clock_timestamp())`;
  await admin`INSERT INTO workers
    (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
     device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
     last_seen_at, label, status)
    VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, ${key.publicKeyDer},
      ${key.deviceThumbprint}, 1, ${profileHash}, ${hello as unknown as Record<string, unknown>}, clock_timestamp(),
      clock_timestamp(), 'Leg B2 worker', 'enrolled')`;
  const workload = { command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds: 600 };
  const availableAt = new Date(Date.now() - 60_000);
  await admin`INSERT INTO jobs
    (id, organization_id, company_id, workload_type, source_kind, source_identity, source_intent,
     requester_principal_kind, requester_principal_id, executor_principal_kind, executor_principal_id,
     input, input_hash, policy_snapshot, policy_hash, requirements, placement_request,
     available_at, priority, status, max_attempts, created_at, updated_at)
    VALUES (${JOB}, ${ORG}, ${COMPANY}, 'batch', 'one_shot', ${JOB},
      ${{ kind: "one_shot", operationId: JOB, operationKind: "extraction" }},
      'system', 'legb2-test', 'worker', ${WORKER}, ${workload},
      ${"5".repeat(64)}, ${{ policyId: "job-submission-default", version: 1 }}, ${POLICY_HASH},
      ${{ workloadType: "batch", requiredCapabilities: [] }},
      ${{ policyId: "job-submission-default", policyVersion: 1, requestedTarget: TARGET }},
      ${availableAt}, 50, 'queued', 3, ${availableAt}, ${availableAt})`;
  await admin`INSERT INTO job_attempts
    (id, organization_id, company_id, job_id, attempt_number, status,
     placement_disposition, placement_owner, placement_target_id, placement_target_class,
     placement_target_scope, placement_target_generation, placement_profile_hash,
     placement_provider_constraint_hash, placement_fallback_disposition, placement_reason_code,
     placement_mode, placement_lease_eligible, placement_input_digest, placement_policy_digest,
     placement_decided_at, created_at, updated_at)
    VALUES (${ATTEMPT}, ${ORG}, ${COMPANY}, ${JOB}, 1, 'pending',
      'selected', 'organization_dedicated', ${TARGET}, 'organization_dedicated',
      'organization', 1, ${FIXTURE.registeredProfileHash}, ${FIXTURE.providerConstraintProfile.digest}, 'primary', 'target_selected',
      'active', true, ${"6".repeat(64)}, ${"6".repeat(64)}, clock_timestamp(),
      ${availableAt}, ${availableAt})`;
  await admin`INSERT INTO job_outbox
    (id, organization_id, company_id, job_id, attempt_id, kind, status, payload, available_at)
    VALUES (${OUTBOX}, ${ORG}, ${COMPANY}, ${JOB}, ${ATTEMPT}, 'attempt_ready', 'pending',
      ${{ organizationId: ORG, companyId: COMPANY, jobId: JOB, attemptId: ATTEMPT, sourceKind: "one_shot" }},
      clock_timestamp())`;
  // The CLI-007-minted handle shape (a REFERENCE, never a value): provider_key / env /
  // ANTHROPIC_API_KEY / sandbox_local_only, unpinned (bound_target_generation NULL),
  // unowned (owner_* NULL ⇒ no membership re-check), status active so the offer path's
  // listActiveExecutionSecretHandles advertises it.
  await admin`INSERT INTO job_secret_handles
    (organization_id, job_id, handle, ref_kind, ref_id, materialization, materialization_target,
     use_policy, status, resolve_count)
    VALUES (${ORG}, ${JOB}, ${opts.handleId}, 'provider_key', ${opts.refId}, 'env', ${ENV_TARGET},
      'sandbox_local_only', 'active', 0)`;
}

/** A session bound to (worker, target, thumbprint, profileHash) so the real routes authenticate. */
function mintSession(key: DeviceKey): WorkerSession {
  const iat = Math.floor(Date.now() / 1000);
  const token = createWorkerSessionToken(SIGNING_KEY, {
    aud: "device_session",
    sub: WORKER,
    organizationId: ORG,
    targetId: TARGET,
    generation: 1,
    scope: "organization",
    deviceThumbprint: key.deviceThumbprint,
    profileHash: digestHello(provisionedHello()),
    iat,
    exp: iat + 10 * 60,
  } as never);
  return {
    token,
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 1,
    obtainedAtMs: Date.now(),
    ttlMs: SESSION_MAX_MS,
    expiresAtMs: Date.now() + SESSION_MAX_MS,
  } as WorkerSession;
}

async function buildSelf(): Promise<WorkerSelfModel> {
  const verified = await verifyAndBrandProviderConstraintProfileV1(FIXTURE.providerConstraintProfile, sha256hex);
  if (verified === null) throw new Error("fixture provider profile failed to verify");
  return {
    registeredTargetProfile: registeredTargetProfileV1Schema.parse(FIXTURE.registeredProfile),
    verifiedProviderConstraints: verified,
    report: provisionedHello(),
  };
}

const PROBES: CapacityProbes = { freeCpuMillis: () => 2_000, freeMemoryMiB: () => 4_096, freeDiskMiB: () => 8_192 };

async function settle(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

/** Drive the composed poll loop against the real server until it leases + hands off the
 * seeded attempt, and return the collected handoff (which carries the SERVER-MINTED
 * fence token + the advertised secret handles). */
async function leaseAndCaptureHandoff(key: DeviceKey): Promise<LeaseHandoff> {
  const session = mintSession(key);
  const self = await buildSelf();
  const client = createControlPlaneClient({ baseUrl });
  const store = new SessionStore(
    { now: () => Date.now(), renew: async () => { throw new Error("no renew"); }, bootstrap: async () => { throw new Error("no bootstrap"); } },
    session,
  );
  const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
  const measure = () =>
    measureCapacity({
      probes: PROBES,
      reserved: { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 },
      slots: limiter.snapshot(),
      ceiling: { cpuMillis: 2_000, memoryMiB: 4_096, diskMiB: 8_192 },
    });
  const handoffs: LeaseHandoff[] = [];
  const supervisor = { accept: (h: LeaseHandoff) => { handoffs.push(h); } };
  const loop = createPollLoop({
    client, self, key, session: createSessionProvider(store), limiter, measure, supervisor,
    backoff: { baseMs: 1, maxMs: 5, jitter: 0 } as never,
  });
  void loop.run();
  const handedOff = await settle(() => handoffs.length === 1);
  loop.stopLeasing();
  await loop.drain().catch(() => {});
  expect(handedOff, "the composed loop must lease the seeded attempt and hand it off").toBe(true);
  return handoffs[0]!;
}

/** Redeem `handoff`'s advertised handles over the REAL resolve route, replicating
 * dispatch-runtime.ts:138-150's materializeRunSecrets VERBATIM but with an overridable
 * fence token (so a negative control can present a STALE fence). */
async function materialize(
  handoff: LeaseHandoff,
  key: DeviceKey,
  session: WorkerSession,
  fenceTokenOverride?: string,
): Promise<{ env: Record<string, string>; canaries: readonly string[] }> {
  const client = createControlPlaneClient({ baseUrl });
  const redeem = createRedeemer({
    client,
    key,
    session,
    fence: {
      workerId: String(handoff.offer.workerId),
      jobId: String(handoff.offer.job.jobId),
      attempt: handoff.offer.job.attempt,
      leaseId: handoff.leaseId,
      fenceToken: fenceTokenOverride ?? String(handoff.fenceToken),
    },
  });
  return synthesiseRunSecrets(handoff.offer.job.secretHandles ?? [], redeem);
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "Leg B Part 2 — the worker redeems a real credential over a LIVE server-minted fence (embedded PostgreSQL)",
  () => {
    it("★ the composed loop leases a real fence, and the worker redeems the minted handle to the REAL Company key", async () => {
      if (setupError) throw setupError;
      const key = generateDeviceKey();
      const handleId = randomUUID();
      await seed(key, { handleId, refId: PROVIDER_SECRET_NAME });
      const session = mintSession(key);
      const handoff = await leaseAndCaptureHandoff(key);

      // The offer advertised exactly the minted provider_key/env handle (the credential
      // the worker is about to redeem).
      const handles = handoff.offer.job.secretHandles ?? [];
      expect(handles).toHaveLength(1);
      expect(handles[0]!.handleId).toBe(handleId);
      expect(handles[0]!.materialization).toMatchObject({ kind: "env", target: ENV_TARGET });
      expect(handles[0]!.usePolicy).toBe("sandbox_local_only");
      // The fence is a real server-minted token (randomBytes at offer time), not a fixture.
      expect(typeof handoff.fenceToken).toBe("string");
      expect(String(handoff.fenceToken).length).toBeGreaterThan(0);

      // The lease is genuinely ACTIVE (only activateLeaseAck writes this) — a live fence.
      const leaseRows = await admin!`SELECT status FROM leases WHERE attempt_id = ${ATTEMPT}`;
      expect(leaseRows[0]!.status).toBe("active");

      // THE MILESTONE: the worker's real redeemer resolves the handle over the real route
      // on the live fence and gets back the REAL decrypted Company key value.
      const materialized = await materialize(handoff, key, session);
      expect(materialized.env[ENV_TARGET]).toBe(SYNTHETIC_PROVIDER_KEY);
      // The redeemed value is registered as a redaction canary (the DAT-008 tripwire input).
      expect(materialized.canaries).toContain(SYNTHETIC_PROVIDER_KEY);

      // Audit-as-columns: exactly one resolve recorded, and NO value column exists on the
      // handle row (Decision #104 — the store never holds the value).
      const auditRows = await admin!`SELECT resolve_count FROM job_secret_handles WHERE handle = ${handleId}`;
      expect(Number(auditRows[0]!.resolve_count)).toBe(1);
      const cols = await admin!`SELECT column_name FROM information_schema.columns WHERE table_name = 'job_secret_handles'`;
      const colNames = cols.map((r) => String(r.column_name));
      expect(colNames).not.toContain("value");
      expect(colNames).not.toContain("secret_value");
    }, 60_000);

    it("★ fail-closed — a STALE fence token on the same live handle is DENIED (200), so no env is produced", async () => {
      if (setupError) throw setupError;
      const key = generateDeviceKey();
      const handleId = randomUUID();
      await seed(key, { handleId, refId: PROVIDER_SECRET_NAME });
      const session = mintSession(key);
      const handoff = await leaseAndCaptureHandoff(key);

      // Everything real (handle present, key present, lease active) — the ONLY thing wrong
      // is the fence token, so this isolates the LIVE FENCE as the discriminator. The route
      // returns HTTP 200 outcome:"denied" (stale_fence), and the worker FAILS CLOSED.
      await expect(
        materialize(handoff, key, session, "stale-not-the-real-fence-token"),
      ).rejects.toBeInstanceOf(SecretMaterializationError);
    }, 60_000);

    it("★ fail-closed — a handle pointing at a nonexistent Company key is DENIED, so no env is produced", async () => {
      if (setupError) throw setupError;
      const key = generateDeviceKey();
      const handleId = randomUUID();
      // The handle + fence are real, but ref_id points at a provider name with NO
      // company_secrets row, so the broker's value lookup throws → the resolve returns
      // denied. Isolates the Company provider-key STORE as load-bearing (the permanent
      // form of the fail-first: without a real key, the resolve fails closed).
      await seed(key, { handleId, refId: "provider:does-not-exist" });
      const session = mintSession(key);
      const handoff = await leaseAndCaptureHandoff(key);

      await expect(materialize(handoff, key, session)).rejects.toBeInstanceOf(SecretMaterializationError);
    }, 60_000);
  },
);
