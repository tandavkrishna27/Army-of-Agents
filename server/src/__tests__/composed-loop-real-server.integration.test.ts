// -----------------------------------------------------------------------------
// CLI-006 / D2 — Sprint 5 Step 1, "Leg B Part 1": the COMPOSED poll loop
// (createPollLoop — the E4-1 symbol) leases a REAL server-minted attempt over the
// REAL embedded-PG worker-control HTTP routes.
//
// The composed-journey component test (packages/worker-daemon) drives createPollLoop
// against a protocol-faithful FAKE control plane. This test replaces the counterparty
// with the REAL server: embedded PostgreSQL + the real `workerControlRoutes` (poll +
// ack), a REAL device proof, and a REAL session. It proves the SERVER's placement
// offers the composed loop a lease and the composed loop ACKs it — upgrading E4-1's
// evidence from a double to a real control plane.
//
// Scope: this is "Part 1" — the lease. The credential resolve over a LIVE fence
// (Part 2) is DAT-008 slice 5's explicitly-deferred residual and is NOT exercised
// here (the seeded attempt carries no secret handle). Real E2B remains E7-1.
//
// Fuses two existing harnesses: the route+device-proof standup from
// execution-secret-resolve-worker.integration.test.ts, and the target/worker/job/
// attempt seed from worker-hello-refresh.integration.test.ts (made provisioned).
// -----------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net, { type AddressInfo } from "node:net";
import type { Server } from "node:http";
import postgres, { type Sql } from "postgres";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  createSessionProvider,
  generateDeviceKey,
  measureCapacity,
  SessionStore,
  type CapacityProbes,
  type DeviceKey,
  type LeaseHandoff,
  type WorkerSelfModel,
  type WorkerSession,
} from "@armyofagents/worker-daemon";
import {
  registeredTargetProfileV1Schema,
  verifyAndBrandProviderConstraintProfileV1,
  workerHelloV1Schema,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { workerControlRoutes } from "../routes/worker-control.js";
import { createWorkerSessionToken, SESSION_MAX_MS } from "../middleware/worker-session-auth.js";
import { digestHello } from "../services/worker-hello-refresh.js";
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
const PASSWORD = "legb-role-password";
const SIGNING_KEY = "legb-session-signing-key-at-least-32-bytes-long";

// A REAL (aligned) clock — NOT frozen. A far-frozen clock trips the poll's 300s
// heartbeat-age gate (authorityCurrent) and the ±5min device-proof skew window.
const now = () => new Date();

/** The PROVISIONED hello the worker row snapshots and the composed loop reports: caps ⊆ the
 * ratified ceiling (workload.batch), the ratified policy hash, real capacity. */
function provisionedHello(): WorkerHelloV1 {
  return {
    protocolVersion: 1,
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 1,
    agentVersion: "legb",
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
    dataDir = await mkdtemp(join(tmpdir(), "aoa-legb-"));
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
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Leg B', 'leg-b')`;
    await admin`INSERT INTO companies (id, organization_id, name, issue_prefix) VALUES (${COMPANY}, ${ORG}, 'Leg B Co', 'LGB')`;

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
}, 60_000);

/** Seed a ratified target + a PROVISIONED worker bound to `key`, plus a lease-eligible batch attempt. */
async function seed(key: DeviceKey): Promise<void> {
  if (!admin) throw new Error("no admin conn");
  const hello = provisionedHello();
  const profileHash = digestHello(hello);
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
    VALUES (${TARGET}, ${ORG}, 'legb-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
      'organization', ${AUTHORITY_KEY}, 1, ${FIXTURE.registeredProfile}, ${FIXTURE.registeredProfileHash},
      ${FIXTURE.providerConstraintProfile}, ${null}, clock_timestamp())`;
  await admin`INSERT INTO workers
    (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
     device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
     last_seen_at, label, status)
    VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, ${key.publicKeyDer},
      ${key.deviceThumbprint}, 1, ${profileHash}, ${hello as unknown as Record<string, unknown>}, clock_timestamp(),
      clock_timestamp(), 'Leg B worker', 'enrolled')`;
  const workload = { command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds: 600 };
  const availableAt = new Date(Date.now() - 60_000);
  await admin`INSERT INTO jobs
    (id, organization_id, company_id, workload_type, source_kind, source_identity, source_intent,
     requester_principal_kind, requester_principal_id, executor_principal_kind, executor_principal_id,
     input, input_hash, policy_snapshot, policy_hash, requirements, placement_request,
     available_at, priority, status, max_attempts, created_at, updated_at)
    VALUES (${JOB}, ${ORG}, ${COMPANY}, 'batch', 'one_shot', ${JOB},
      ${{ kind: "one_shot", operationId: JOB, operationKind: "extraction" }},
      'system', 'legb-test', 'worker', ${WORKER}, ${workload},
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
}

/** A session bound to (worker, target, thumbprint, profileHash) so the real poll/ack routes authenticate. */
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

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "Leg B Part 1 — the composed poll loop leases a REAL server-offered attempt over the REAL routes (embedded PostgreSQL)",
  () => {
    beforeEach(() => {
      if (setupError) throw setupError;
    });

    it("★ createPollLoop polls the real server, is OFFERED the seeded attempt, and ACKs it over the real routes", async () => {
      const key = generateDeviceKey();
      await seed(key);
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

      // A collecting supervisor seam: the composed loop hands the leased offer to it after the ACK.
      const handoffs: LeaseHandoff[] = [];
      const supervisor = { accept: (h: LeaseHandoff) => { handoffs.push(h); } };

      const loop = createPollLoop({
        client,
        self,
        key,
        session: createSessionProvider(store),
        limiter,
        measure,
        supervisor,
        backoff: { baseMs: 1, maxMs: 5, jitter: 0 } as never,
      });

      void loop.run();
      const handedOff = await settle(() => handoffs.length === 1);
      loop.stopLeasing();
      await loop.drain().catch(() => {});

      // E4-1: the REAL server offered the seeded attempt and the composed loop leased + ACKed it.
      expect(handedOff).toBe(true);
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]!.offer.job.jobId).toBe(JOB);
      expect(handoffs[0]!.offer.job.workloadType).toBe("batch");
      expect(handoffs[0]!.offer.job.workload.command).toBe("codex");

      // The ACK reached the SERVER and ACTIVATED the lease — proven specifically (not merely the
      // OFFER): `offerLease` leaves the attempt/lease 'offered', and only `activateLeaseAck` flips
      // the attempt to 'leased' + the lease to 'active' + writes a `lease_ack` receipt. So these
      // three facts are the composed loop's real ACK reaching the real server, not the poll's offer.
      const attemptRows = await admin!`SELECT status FROM job_attempts WHERE id = ${ATTEMPT}`;
      expect(attemptRows[0]!.status).toBe("leased");
      const leaseRows = await admin!`SELECT worker_id, status FROM leases WHERE attempt_id = ${ATTEMPT}`;
      expect(leaseRows.length).toBeGreaterThanOrEqual(1);
      expect(String(leaseRows[0]!.worker_id)).toBe(WORKER);
      expect(leaseRows[0]!.status).toBe("active");
      const receipts = await admin!`SELECT operation FROM worker_operation_receipts WHERE attempt_id = ${ATTEMPT} AND operation = 'lease_ack'`;
      expect(receipts.length).toBeGreaterThanOrEqual(1);
    }, 60_000);

    it("★ negative control — a NON-lease-eligible attempt is NOT offered, so the composed loop hands off nothing", async () => {
      const key = generateDeviceKey();
      await seed(key);
      // The ONLY change from the happy case: remove the lease-eligible attempt, so the real server's
      // placement has no candidate and returns no_work. If the happy-case handoff were vacuous, this
      // would still hand off — it must not. (The placement columns are atomically constrained, so a
      // lone `lease_eligible=false` UPDATE is rejected; removing the attempt is the clean lever.)
      await admin!`DELETE FROM job_outbox WHERE attempt_id = ${ATTEMPT}`;
      await admin!`DELETE FROM job_attempts WHERE id = ${ATTEMPT}`;
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
      // Give the loop time to poll (and get no_work) a few times; it must NOT hand off.
      const handedOff = await settle(() => handoffs.length === 1, 2000);
      loop.stopLeasing();
      await loop.drain().catch(() => {});

      expect(handedOff).toBe(false);
      expect(handoffs).toHaveLength(0);
      // The attempt was never offered/leased (no lease row) — the server correctly withheld it.
      const leaseRows = await admin!`SELECT id FROM leases WHERE attempt_id = ${ATTEMPT}`;
      expect(leaseRows).toHaveLength(0);
    }, 60_000);
  },
);
