// server/src/__tests__/worker-hello-refresh.integration.test.ts
//
// WRK-011 (Sprint 2.75) — embedded-PostgreSQL proof that a REFRESH makes an enrolled but
// UNPROVISIONED worker OFFERABLE work, through the REAL `poll` service, and that the atomic
// triple (profile_snapshot + profile_hash + a fresh session) moves together or not at all.
//
// ★ FIVE of the ticket's eleven acceptance clauses have this suite as their ONLY evidence,
// and on Windows it is `describe.skipIf`'d — which vitest renders as GREEN. Run it with
// AOA_RUN_WIN_INTEGRATION=1, or you have signed off five clauses against a run that
// evaluated nothing. Linux CI runs it unconditionally.

import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  createOperatorDbConnection,
  createTenantAppDbConnection,
  type Db,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import {
  leaseOfferV1Schema,
  workerHelloV1Schema,
  type PollRequestV1,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { createJobLeasingService, type VerifiedWorkerOperation } from "../services/job-leasing.js";
import {
  createWorkerHelloRefreshService,
  digestHello,
} from "../services/worker-hello-refresh.js";
import { createWorkerSessionToken, verifyWorkerSessionToken, type VerifiedTargetPrincipal } from "../middleware/worker-session-auth.js";
import { WORKER_CONTROL_HEADERS } from "@armyofagents/shared";
import { executionTargetRoutes } from "../routes/execution-targets.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createWorkerToken, hashWorkerToken } from "../services/execution-targets.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const FIXTURE_PATH = fileURLToPath(new URL("../../../tests/fixtures/worker-provisioned-target.json", import.meta.url));

const PASSWORD = "wrk011-role-password";
const COMPANY = "b0000000-0000-4000-8000-000000000002";
const THUMBPRINT = "8".repeat(64);
const SIGNING_KEY = "wrk011-session-signing-key-at-least-32-bytes-long";
const sha256 = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");

interface Fixture {
  ids: { organizationId: string; targetId: string; policyHash: string };
  registeredProfile: Record<string, unknown>;
  registeredProfileHash: string;
  providerConstraintProfile: Record<string, unknown> & { digest: string };
  leaseOffer: unknown;
}

let fixture: Fixture;
let ORG: string;
let TARGET: string;
let WORKER: string;
let POLICY_HASH: string;
let AUTHORITY_KEY: string;

/** The UNPROVISIONED hello a fresh desktop enrols with: no capabilities, zero capacity, the
 * all-zero policy hash (byte-for-byte what buildDesktopHello emits with no provisioning). */
function unprovisionedHello(): WorkerHelloV1 {
  return {
    protocolVersion: 1, workerId: WORKER, targetId: TARGET, deviceGeneration: 1,
    agentVersion: "wrk011", supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "desktop" },
    reportedCapabilities: [],
    capacity: { batchSlots: 0, browserSessionSlots: 0, serviceSlots: 0, freeCpuMillis: 0, freeMemoryMiB: 0, freeDiskMiB: 0 },
    policyHash: "0".repeat(64),
  } as WorkerHelloV1;
}

/** The PROVISIONED hello: caps ⊆ the ratified ceiling, real capacity, the ratified policy. */
function provisionedHello(overrides: Partial<WorkerHelloV1> = {}): WorkerHelloV1 {
  return {
    protocolVersion: 1, workerId: WORKER, targetId: TARGET, deviceGeneration: 1,
    agentVersion: "wrk011", supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "desktop" },
    // ONLY workload.batch — a "none"-isolation desktop cannot provide sandbox.* (DSK-003),
    // and the daemon self-check (Step 8c) reports exactly this via deriveHelloProvisioning,
    // so the captured offer must be satisfiable by workload.batch alone (§10 non-goal).
    reportedCapabilities: ["workload.batch"],
    capacity: { batchSlots: 2, browserSessionSlots: 0, serviceSlots: 0, freeCpuMillis: 2_000, freeMemoryMiB: 4_096, freeDiskMiB: 8_192 },
    policyHash: POLICY_HASH,
    ...overrides,
  } as WorkerHelloV1;
}

function ratified() {
  return {
    capabilityCeiling: (fixture.registeredProfile.capabilityCeiling as string[]),
    policyHash: POLICY_HASH,
  };
}

function principal(profileHash: string): VerifiedTargetPrincipal {
  return {
    workerId: WORKER, targetId: TARGET, targetGeneration: 1, deviceThumbprint: THUMBPRINT,
    profileHash, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    organizationId: ORG, scope: "organization", targetScope: "organization",
  };
}

/** A hand-built poll auth, exactly as job-control-fixture does — poll authenticates via
 * `verifyWorkerOperationProof` in production, but the leasing SERVICE takes a pre-verified
 * auth, so profileHash here is compared against the ROW at job-leasing.ts:259. */
function pollAuth(profileHash: string, proofId: string): VerifiedWorkerOperation {
  return {
    organizationId: ORG, workerId: WORKER, targetId: TARGET, targetGeneration: 1,
    deviceThumbprint: THUMBPRINT, profileHash, publicKey: "wrk011-public-key",
    proofId, proofIssuedAt: new Date(), sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
  };
}

function pollRequest(nonce: string): PollRequestV1 {
  return {
    protocolVersion: 1, correlationId: crypto.randomUUID(), issuedAt: new Date().toISOString(),
    nonce, audience: "worker_poll", workerId: WORKER, targetId: TARGET, deviceGeneration: 1,
    capacity: { batchSlots: 2, browserSessionSlots: 0, serviceSlots: 0, freeCpuMillis: 2_000, freeMemoryMiB: 4_096, freeDiskMiB: 8_192 },
  } as PollRequestV1;
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "WRK-011 — a provisioned worker is offered work (embedded PostgreSQL)",
  () => {
    let dataDir: string;
    let embedded: EmbeddedPostgresInstance;
    let admin: Sql;
    let ownerDb: Db;
    let appConn: NonOwnerDbConnection;
    let operatorConn: NonOwnerDbConnection;
    let leasing: ReturnType<typeof createJobLeasingService>;
    let httpApp: express.Express;
    let setupError: unknown;

    beforeAll(async () => {
      try {
        fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Fixture;
        ORG = fixture.ids.organizationId;
        TARGET = fixture.ids.targetId;
        WORKER = "b0000000-0000-4000-8000-000000000005";
        POLICY_HASH = fixture.ids.policyHash;
        AUTHORITY_KEY = `organization:${ORG}`;

        dataDir = await mkdtemp(join(tmpdir(), "aoa-wrk011-"));
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
        ownerDb = createDb(adminUrl);
        await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
        await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", PASSWORD));
        appConn = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 16 });
        operatorConn = createOperatorDbConnection(adminUrl.replace("test:test", `aoa_operator:${PASSWORD}`), { max: 8 });

        // No user/membership rows are needed: the service-level tests build the principal by
        // hand (like job-control-fixture), and A7 uses a LEGACY token — neither reaches the
        // session authenticator's `ownerMembershipActive` check.
        await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'WRK-011 org', 'wrk011-org')`;
        await admin`INSERT INTO companies (id, organization_id, name, issue_prefix) VALUES (${COMPANY}, ${ORG}, 'WRK-011 company', 'W011')`;

        leasing = createJobLeasingService({ appDb: appConn.db });

        httpApp = express();
        httpApp.use(express.json({ verify: (req, _res, bytes) => { (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes); } }));
        httpApp.use("/api", executionTargetRoutes({
          db: ownerDb, // target lookups (resolve legacy token, loadWorkerSelfModel) read execution_targets
          workerSession: { appDb: appConn.db, operatorDb: operatorConn.db, sessionSigningKey: SIGNING_KEY, now: () => new Date() },
        }));
        httpApp.use(errorHandler);
      } catch (err) {
        setupError = err;
      }
    }, 180_000);

    afterAll(async () => {
      await operatorConn?.close({ timeoutSeconds: 5 }).catch(() => {});
      await appConn?.close({ timeoutSeconds: 5 }).catch(() => {});
      await ownerDb?.$client.end().catch(() => {});
      await admin?.end().catch(() => {});
      await embedded?.stop().catch(() => {});
      if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    });

    // Reset the target + worker to a fresh UNPROVISIONED enrolment before each test.
    async function seedUnprovisioned(opts?: { ratified?: boolean; legacyTokenHash?: string; devicePublicKey?: string; deviceThumbprint?: string }): Promise<void> {
      const devicePublicKey = opts?.devicePublicKey ?? "wrk011-public-key";
      const deviceThumbprint = opts?.deviceThumbprint ?? THUMBPRINT;
      const un = unprovisionedHello();
      await admin`DELETE FROM job_outbox`;
      await admin`DELETE FROM job_attempts`;
      await admin`DELETE FROM jobs`;
      await admin`DELETE FROM leases`;
      await admin`DELETE FROM worker_proof_replays`;
      await admin`DELETE FROM workers`;
      await admin`DELETE FROM execution_targets`;
      const registered = (opts?.ratified ?? true) ? fixture.registeredProfile : null;
      const registeredHash = (opts?.ratified ?? true) ? fixture.registeredProfileHash : null;
      const provider = (opts?.ratified ?? true) ? fixture.providerConstraintProfile : null;
      await admin`INSERT INTO execution_targets
        (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, registered_profile, registered_profile_hash,
         provider_constraint_profile, worker_token_hash, last_seen_at)
        VALUES (${TARGET}, ${ORG}, 'wrk011-target', 'dedicated_worker', 'dedicated_tenant', 'active', '{}', '{}',
          'organization', ${AUTHORITY_KEY}, 1, ${registered}, ${registeredHash},
          ${provider}, ${opts?.legacyTokenHash ?? null}, clock_timestamp())`;
      await admin`INSERT INTO workers
        (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
         device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
         last_seen_at, label, status)
        VALUES (${WORKER}, 'organization', ${ORG}, ${TARGET}, ${AUTHORITY_KEY}, ${devicePublicKey},
          ${deviceThumbprint}, 1, ${digestHello(un)}, ${un as unknown as Record<string, unknown>}, clock_timestamp(),
          clock_timestamp(), 'WRK-011 worker', 'enrolled')`;
    }

    async function seedLeaseableBatchJob(ordinal: number): Promise<void> {
      const suffix = ordinal.toString().padStart(12, "0");
      const jobId = `b6100000-0000-4000-8000-${suffix}`;
      const attemptId = `b6200000-0000-4000-8000-${suffix}`;
      const outboxId = `b6300000-0000-4000-8000-${suffix}`;
      const availableAt = new Date(Date.now() - 60_000 + ordinal);
      const workload = { command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds: 600 };
      await admin`INSERT INTO jobs
        (id, organization_id, company_id, workload_type, source_kind, source_identity, source_intent,
         requester_principal_kind, requester_principal_id, executor_principal_kind, executor_principal_id,
         input, input_hash, policy_snapshot, policy_hash, requirements, placement_request,
         available_at, priority, status, max_attempts, created_at, updated_at)
        VALUES (${jobId}, ${ORG}, ${COMPANY}, 'batch', 'one_shot', ${jobId},
          ${{ kind: "one_shot", operationId: jobId, operationKind: "extraction" }},
          'system', 'wrk011-test', 'worker', ${WORKER}, ${workload},
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
        VALUES (${attemptId}, ${ORG}, ${COMPANY}, ${jobId}, 1, 'pending',
          'selected', 'organization_dedicated', ${TARGET}, 'organization_dedicated',
          'organization', 1, ${fixture.registeredProfileHash}, ${fixture.providerConstraintProfile.digest}, 'primary', 'target_selected',
          'active', true, ${"6".repeat(64)}, ${"6".repeat(64)}, clock_timestamp(),
          ${availableAt}, ${availableAt})`;
      await admin`INSERT INTO job_outbox
        (id, organization_id, company_id, job_id, attempt_id, kind, status, payload, available_at)
        VALUES (${outboxId}, ${ORG}, ${COMPANY}, ${jobId}, ${attemptId}, 'attempt_ready', 'pending',
          ${{ organizationId: ORG, companyId: COMPANY, jobId, attemptId, sourceKind: "one_shot" }},
          clock_timestamp())`;
    }

    async function rowProfile(): Promise<{ hash: string; snapshot: unknown; updatedAt: string }> {
      const rows = await admin`SELECT profile_hash, profile_snapshot, updated_at FROM workers WHERE id = ${WORKER}`;
      return { hash: rows[0]!.profile_hash as string, snapshot: rows[0]!.profile_snapshot, updatedAt: String(rows[0]!.updated_at) };
    }

    function service(mint?: undefined | (() => never)) {
      return createWorkerHelloRefreshService({
        appDb: appConn.db, sessionSigningKey: SIGNING_KEY,
        ...(mint ? { mint } : {}),
      });
    }

    beforeEach(() => {
      if (setupError) throw setupError;
    });

    it("A1: an UNPROVISIONED worker polls NO_WORK, a refresh makes it OFFERABLE, the OLD hash is dead, and both columns move together", async () => {
      await seedUnprovisioned();
      await seedLeaseableBatchJob(1);
      const oldHash = digestHello(unprovisionedHello());

      // (3) PRECONDITION CONTROL — the real poll must return no_work BEFORE the refresh, or
      // the suite cannot tell "the refresh made it work" from "it always worked".
      const pre = await leasing.poll({ auth: pollAuth(oldHash, "poll-pre"), request: pollRequest("pre") });
      expect(pre.outcome).toBe("no_work");

      // (4) the refresh, through the service; the atomic triple lands.
      const outcome = await service().refresh({ principal: principal(oldHash), hello: provisionedHello(), ratified: ratified() });
      expect(outcome.outcome).toBe("refreshed");
      if (outcome.outcome !== "refreshed") throw new Error("unreachable");
      const newHash = digestHello(provisionedHello());
      expect(outcome.profileHash).toBe(newHash);
      // the minted session is real and carries the NEW hash (kills M12 — mint from the 200 path)
      expect(verifyWorkerSessionToken(SIGNING_KEY, outcome.session).profileHash).toBe(newHash);

      // both columns moved together: re-derive the digest EXACTLY as job-placement.ts:543 does
      // — parse the stored snapshot through the frozen schema FIRST, then hash, because a JSONB
      // round-trip reorders keys and only the parse-then-hash reproduces the stored hash (§0e).
      const row = await rowProfile();
      expect(row.hash).toBe(newHash);
      expect(sha256(JSON.stringify(workerHelloV1Schema.parse(row.snapshot)))).toBe(row.hash); // M9/M10: snapshot ⇄ hash bound

      // (5) poll with the NEW hash → offer.
      const offered = await leasing.poll({ auth: pollAuth(newHash, "poll-new"), request: pollRequest("new") });
      expect(offered.outcome).toBe("offer");
      if (offered.outcome !== "offer") throw new Error("unreachable");
      const parsedOffer = leaseOfferV1Schema.parse(offered.body);
      expect(parsedOffer.job.workloadType).toBe("batch");

      // (7) capture the offer to the shared fixture for the daemon self-check (Step 8c), only
      // when explicitly asked — a plain CI run must NOT mutate a committed file.
      if (process.env.AOA_WRK011_CAPTURE === "1") {
        await writeFile(FIXTURE_PATH, JSON.stringify({ ...fixture, leaseOffer: parsedOffer }, null, 2) + "\n");
      }

      // (6) poll with the OLD session's hash → the leasing authority REJECTS it (job-leasing.ts:259
      // `worker.profileHash === auth.profileHash` now fails). The §0(f) coupling — changing
      // profile_hash invalidates the caller's own session — proven, not asserted.
      await expect(
        leasing.poll({ auth: pollAuth(oldHash, "poll-old"), request: pollRequest("old") }),
      ).rejects.toThrow(/target_revoked/);
    });

    it("A2: a second identical refresh is a NO-OP — 204 semantics, mints nothing, leaves updated_at unchanged (kills M8)", async () => {
      await seedUnprovisioned();
      const oldHash = digestHello(unprovisionedHello());
      const first = await service().refresh({ principal: principal(oldHash), hello: provisionedHello(), ratified: ratified() });
      expect(first.outcome).toBe("refreshed");
      const afterFirst = await rowProfile();
      const newHash = digestHello(provisionedHello());

      // The worker now holds a session bound to newHash; a second identical refresh is a no-op.
      const second = await service().refresh({ principal: principal(newHash), hello: provisionedHello(), ratified: ratified() });
      expect(second.outcome).toBe("unchanged");
      const afterSecond = await rowProfile();
      expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt); // wrote nothing
    });

    it("A3: a throwing signer leaves NO committed refresh — the row is byte-identical (kills M13 / Step 5 ordering)", async () => {
      await seedUnprovisioned();
      const oldHash = digestHello(unprovisionedHello());
      const before = await rowProfile();
      const throwingMint = (() => { throw new Error("signer boom"); }) as unknown as () => never;
      const outcome = await service(throwingMint).refresh({ principal: principal(oldHash), hello: provisionedHello(), ratified: ratified() });
      expect(outcome.outcome).toBe("unavailable");
      const after = await rowProfile();
      expect(after.hash).toBe(before.hash);            // UPDATE rolled back
      expect(after.updatedAt).toBe(before.updatedAt);  // nothing committed
    });

    it("A4: a stale expectedProfileHash (a concurrent refresh already moved the row) is refused (kills M14)", async () => {
      await seedUnprovisioned();
      const oldHash = digestHello(unprovisionedHello());
      // First refresh wins.
      expect((await service().refresh({ principal: principal(oldHash), hello: provisionedHello(), ratified: ratified() })).outcome).toBe("refreshed");
      // A second caller still presenting the OLD hash loses the compare-and-set.
      const conflict = await service().refresh({ principal: principal(oldHash), hello: provisionedHello({ agentVersion: "wrk011-b" }), ratified: ratified() });
      expect(conflict.outcome).toBe("refused");
      if (conflict.outcome === "refused") expect(conflict.logReason).toBe("refresh_conflict");
    });

    it("A5: the refusal matrix — each refusal names its SPECIFIC reason (positive control ran in A1)", async () => {
      await seedUnprovisioned();
      const oldHash = digestHello(unprovisionedHello());
      const cases: Array<[WorkerHelloV1, ReturnType<typeof ratified> | null, string]> = [
        [provisionedHello({ workerId: "b0000000-0000-4000-8000-0000000000aa" }), ratified(), "identity_mismatch"],
        [provisionedHello({ reportedCapabilities: ["workload.batch", "workload.service"] }), ratified(), "capability_not_granted"],
        [provisionedHello({ policyHash: "1".repeat(64) }), ratified(), "policy_stale"],
        [provisionedHello(), null, "profile_unratified"],
      ];
      for (const [hello, rat, reason] of cases) {
        const outcome = await service().refresh({ principal: principal(oldHash), hello, ratified: rat });
        expect(outcome.outcome).toBe("refused");
        if (outcome.outcome === "refused") expect(outcome.logReason).toBe(reason);
      }
    });

    it("A6: an unratified target refuses with the SPECIFIC reason profile_unratified (service-level)", async () => {
      const oldHash = digestHello(unprovisionedHello());
      const outcome = await service().refresh({ principal: principal(oldHash), hello: provisionedHello(), ratified: null });
      expect(outcome.outcome).toBe("refused");
      if (outcome.outcome === "refused") expect(outcome.logReason).toBe("profile_unratified");
    });

    it("A7: a LEGACY worker token cannot refresh — the route refuses it before any DB write (kills M1)", async () => {
      const legacyToken = createWorkerToken();
      await seedUnprovisioned({ legacyTokenHash: hashWorkerToken(legacyToken) });
      const res = await request(httpApp)
        .post("/api/execution-targets/self/hello")
        .set("authorization", `Bearer ${legacyToken}`)
        .send({ protocolVersion: 1, correlationId: crypto.randomUUID(), hello: provisionedHello() });
      expect(res.status).toBe(401); // NOT 200, NOT 500 — a proofless token may not write a snapshot
      // and the row is untouched.
      const row = await rowProfile();
      expect(row.hash).toBe(digestHello(unprovisionedHello()));
    });

    it("A8: the REAL route, session + device proof → 200, a minted session header binding the NEW hash, and the row updated", async () => {
      // The end-to-end HTTP success path: this is the ONLY test that exercises the route's
      // production glue — validate(selfHelloRequestSchema) PARSING the raw body before the
      // digest (the M11 property in production), loadWorkerSelfModel → the ratified parse, the
      // service call, and the aoa-worker-session response header. A1-A6 drive the service.
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pubDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
      const pubB64 = pubDer.toString("base64url");
      const thumbprint = createHash("sha256").update(pubDer).digest("hex");
      await seedUnprovisioned({ devicePublicKey: pubB64, deviceThumbprint: thumbprint });

      const oldHash = digestHello(unprovisionedHello());
      const iat = Math.floor(Date.now() / 1000);
      const session = createWorkerSessionToken(SIGNING_KEY, {
        aud: "device_session", sub: WORKER, organizationId: ORG, targetId: TARGET, generation: 1,
        scope: "organization", deviceThumbprint: thumbprint, profileHash: oldHash,
        iat, exp: iat + 10 * 60,
      });

      const PATH = "/api/execution-targets/self/hello";
      const correlationId = crypto.randomUUID();
      const body = { protocolVersion: 1, correlationId, hello: provisionedHello() };
      // The proof signs the digest of the SERIALIZED body; superagent JSON-encodes the object
      // with the same JSON.stringify, so this digest equals what express.json captures as rawBody.
      // (Sending a Buffer instead flips content-type to octet-stream, so express.json never
      // captures rawBody and the authenticator rejects — that cost a debugging round.)
      const bodyDigest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const issuedAt = new Date().toISOString();
      const proofId = `proof-${crypto.randomUUID()}`;
      const canonical = ["AOA-DEVICE-PROOF-V1", "POST", PATH, bodyDigest, correlationId, issuedAt, proofId].join("\n");
      const signature = edSign(null, Buffer.from(canonical), privateKey).toString("base64url");

      const res = await request(httpApp)
        .post(PATH)
        .set("authorization", `Bearer ${session}`)
        .set(WORKER_CONTROL_HEADERS.proofVersion, "1")
        .set(WORKER_CONTROL_HEADERS.publicKey, pubB64)
        .set(WORKER_CONTROL_HEADERS.signature, signature)
        .set(WORKER_CONTROL_HEADERS.issuedAt, issuedAt)
        .set(WORKER_CONTROL_HEADERS.proofId, proofId)
        .set(WORKER_CONTROL_HEADERS.requestId, correlationId)
        .send(body);

      expect(res.status).toBe(200);
      const newHash = digestHello(provisionedHello());
      expect(res.body).toMatchObject({ protocolVersion: 1, profileHash: newHash });
      // The minted session is on the response header and verifies with the NEW hash.
      const headerSession = res.headers[WORKER_CONTROL_HEADERS.session];
      expect(typeof headerSession).toBe("string");
      expect(verifyWorkerSessionToken(SIGNING_KEY, headerSession as string).profileHash).toBe(newHash);
      // And the durable row moved — proving the route (not just the service) committed the triple.
      const row = await rowProfile();
      expect(row.hash).toBe(newHash);
    });
  },
);
