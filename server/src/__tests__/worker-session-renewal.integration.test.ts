import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, createHash, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import express from "express";
import request from "supertest";
import {
  applyPendingMigrations,
  createDb,
  createOperatorDbConnection,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import { WORKER_CONTROL_HEADERS } from "@armyofagents/shared";
import { canonicalizeJsonV1, canonicalProviderConstraintProfileDigestInputV1, type ProviderConstraintProfileV1, type RegisteredTargetProfileV1 } from "@armyofagents/worker-protocol";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { workerControlRoutes } from "../routes/worker-control.js";
import { createWorkerEnrollmentService } from "../services/worker-enrollment.js";
import { ratifyPlatformExecutionTargetPlacementProfile } from "../services/execution-targets.js";
import { logger } from "../middleware/logger.js";
import { errorHandler } from "../middleware/error-handler.js";

// WRK-010 slice 1 — the device-proof session-renewal route, end to end against embedded
// PostgreSQL. ★ THIS FILE IS THE SOLE HOME of the authority matrix (§10 R6): those guards
// live in the SHIPPED authenticator, so the only way to exercise them THROUGH this route is
// here. Do not delete a case thinking it is covered in the unit tier — it is not.
//
// ★ On Windows this whole describe is skipIf-skipped unless AOA_RUN_WIN_INTEGRATION=1, and
// vitest renders a skipped file as GREEN. Six of the nine acceptance clauses have this suite
// as their ONLY evidence, so a plain `pnpm test` on Windows signs them off against a run that
// evaluated NOTHING. Run it with the prefix.

const SIGNING_KEY = "test-signing-key-at-least-32-bytes";
const ORG_A = "71000000-0000-4000-8000-000000000001";
const ORG_B = "71000000-0000-4000-8000-000000000002";
const TARGET_A = "72000000-0000-4000-8000-000000000001";
const TARGET_PLATFORM = "72000000-0000-4000-8000-000000000003";
const TARGET_OWNER = "72000000-0000-4000-8000-000000000004";
const WORKER_A = "73000000-0000-4000-8000-000000000001";
const WORKER_PLATFORM = "73000000-0000-4000-8000-000000000004";
const WORKER_OWNER = "73000000-0000-4000-8000-000000000006";
const WORKER_LOGICAL = "73000000-0000-4000-8000-000000000007";
const OWNER_USER = "wrk-010-owner-user";
const COMPANY_A = "76000000-0000-4000-8000-000000000001";
const PASSWORD = "wrk-010-role-test";
const NOW = new Date(Math.floor(Date.now() / 1_000) * 1_000);
const MIN = 60_000;

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let admin: Sql | null = null;
let appConn: NonOwnerDbConnection | null = null;
let operatorConn: NonOwnerDbConnection | null = null;
let ownerDb: ReturnType<typeof createDb> | null = null;
let setupError: unknown = null;
let clock = NOW;
let httpApp: express.Express | null = null;
let enrollmentService: ReturnType<typeof createWorkerEnrollmentService> | null = null;

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) :
        !address || typeof address === "string" ? reject(new Error("port allocation failed")) : resolve(address.port));
    });
    server.on("error", reject);
  });
}

function guard() {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
  if (!admin || !appConn || !operatorConn || !httpApp || !enrollmentService) throw new Error("test setup incomplete");
  return { admin, app: httpApp, enrollment: enrollmentService };
}

let cidCounter = 0;
function cid(): string {
  cidCounter += 1;
  return `74000000-0000-4000-8000-${cidCounter.toString().padStart(12, "0")}`;
}

function enrollmentBody(workerId: string, targetId: string, deviceGeneration = 1) {
  return {
    protocolVersion: 1,
    correlationId: cid(),
    issuedAt: NOW.toISOString(),
    nonce: `enroll-nonce-${workerId}-${targetId}-${cidCounter}`,
    audience: "target_enrollment",
    idempotencyKey: cid().replace("74", "75"),
    hello: {
      protocolVersion: 1,
      workerId,
      targetId,
      deviceGeneration,
      agentVersion: "wrk-010-test",
      supportedProtocol: { min: 1, max: 1 },
      platform: { os: "windows", arch: "x64", runtime: "desktop" },
      reportedCapabilities: ["workload.batch"],
      capacity: {
        batchSlots: 1, browserSessionSlots: 0, serviceSlots: 0,
        freeCpuMillis: 1000, freeMemoryMiB: 1024, freeDiskMiB: 1024,
      },
      policyHash: "a".repeat(64),
    },
  };
}

const rawBody = (body: unknown): Buffer => Buffer.from(JSON.stringify(body));

/** A device proof over an ARBITRARY path, at an ARBITRARY clock. Generalises the enrollment
 *  test's `deviceProof` (which is path- and NOW-locked) — the one change §7 Step 5 asks for. */
function deviceProofFor(input: {
  bytes: Buffer;
  correlationId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  proofId: string;
  path: string;
  proofNow: Date;
}) {
  const issuedAt = input.proofNow.toISOString();
  const publicKeyDer = input.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const canonical = [
    "AOA-DEVICE-PROOF-V1", "POST", input.path,
    createHash("sha256").update(input.bytes).digest("hex"), input.correlationId, issuedAt, input.proofId,
  ].join("\n");
  return {
    version: "1", publicKey: publicKeyDer,
    signature: sign(null, Buffer.from(canonical), input.privateKey).toString("base64url"),
    issuedAt, proofId: input.proofId,
  };
}

function proofHeaders(proof: ReturnType<typeof deviceProofFor>) {
  return {
    [WORKER_CONTROL_HEADERS.proofVersion]: proof.version,
    [WORKER_CONTROL_HEADERS.publicKey]: proof.publicKey,
    [WORKER_CONTROL_HEADERS.signature]: proof.signature,
    [WORKER_CONTROL_HEADERS.issuedAt]: proof.issuedAt,
    [WORKER_CONTROL_HEADERS.proofId]: proof.proofId,
  };
}

function placementProviderProfile(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "wrk-010-platform", version: 1, maxContinuousRuntimeSeconds: 3_600, maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 2_000, memoryMiB: 4_096, pids: 512, diskMiB: 8_192 },
    maxConcurrentOperations: 8,
    supportedOperations: ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup"],
    localityTags: ["transfer_allowed"], checkpointMode: "none", healthMode: "none",
  } as Omit<ProviderConstraintProfileV1, "digest">;
  return { ...unsigned, digest: createHash("sha256").update(canonicalProviderConstraintProfileDigestInputV1(unsigned)).digest("hex") } as ProviderConstraintProfileV1;
}

function placementRegisteredProfile(provider: ProviderConstraintProfileV1): RegisteredTargetProfileV1 {
  return {
    protocolVersion: 1, targetId: TARGET_PLATFORM, targetClass: "managed_cloud", scope: "platform",
    organizationId: null, ownerPrincipalId: null, trustCeiling: "shared_isolated",
    credentialCeiling: "platform_brokered", dataLocalityCeiling: "transfer_allowed",
    providerConstraints: { profileId: provider.profileId, version: provider.version, digest: provider.digest },
    capabilityCeiling: ["workload.batch"], deviceGeneration: 1, revokedAt: null, policyHash: "a".repeat(64),
  };
}

/** Issue a code, then enroll through the REAL enroll route, returning the session + keypair. */
async function enroll(input: {
  workerId: string;
  targetId: string;
  scope: "organization" | "owner";
  organizationId: string;
  ownerUserId: string | null;
  keys?: { privateKey: KeyObject; publicKey: KeyObject };
  platform?: boolean;
}): Promise<{ session: string; keys: { privateKey: KeyObject; publicKey: KeyObject }; body: ReturnType<typeof enrollmentBody>; code: string }> {
  const { app, enrollment } = guard();
  const keys = input.keys ?? generateKeyPairSync("ed25519");
  const issued = input.platform
    ? await enrollment.issuePlatformCode({ executionTargetId: input.targetId, createdByPrincipalKind: "operator", createdByPrincipalId: "wrk-010-operator" })
    : await enrollment.issueTenantCode({
        organizationId: input.organizationId, executionTargetId: input.targetId, scope: input.scope,
        ownerUserId: input.ownerUserId, createdByPrincipalKind: "user", createdByPrincipalId: OWNER_USER,
      });
  const body = enrollmentBody(input.workerId, input.targetId);
  const proof = deviceProofFor({
    bytes: rawBody(body), correlationId: body.correlationId, privateKey: keys.privateKey, publicKey: keys.publicKey,
    proofId: `enroll-${input.workerId}-${cidCounter}`, path: "/api/worker-control/enroll", proofNow: clock,
  });
  const resp = await request(app)
    .post("/api/worker-control/enroll")
    .set(WORKER_CONTROL_HEADERS.enrollmentCode, issued.code)
    .set(proofHeaders(proof))
    .send(body);
  expect(resp.status, JSON.stringify(resp.body)).toBe(200);
  const session = resp.headers[WORKER_CONTROL_HEADERS.session] as string;
  expect(typeof session).toBe("string");
  return { session, keys, body, code: issued.code };
}

/** Renew a session through the REAL renewal route. */
async function renew(input: {
  session: string;
  keys: { privateKey: KeyObject; publicKey: KeyObject };
  proofId: string;
  proofNow?: Date;
  correlationId?: string;
}) {
  const { app } = guard();
  const correlationId = input.correlationId ?? cid();
  const body = { protocolVersion: 1, audience: "device_session", correlationId };
  const proof = deviceProofFor({
    bytes: rawBody(body), correlationId, privateKey: input.keys.privateKey, publicKey: input.keys.publicKey,
    proofId: input.proofId, path: "/api/worker-control/session/renew", proofNow: input.proofNow ?? clock,
  });
  return request(app)
    .post("/api/worker-control/session/renew")
    .set("authorization", `Bearer ${input.session}`)
    .set(proofHeaders(proof))
    .send(body);
}

/** Replay the enroll route with the same code but a FRESH proof at the current clock. */
async function replayEnroll(code: string, body: ReturnType<typeof enrollmentBody>, keys: { privateKey: KeyObject; publicKey: KeyObject }, proofId: string) {
  const { app } = guard();
  const proof = deviceProofFor({
    bytes: rawBody(body), correlationId: body.correlationId, privateKey: keys.privateKey, publicKey: keys.publicKey,
    proofId, path: "/api/worker-control/enroll", proofNow: clock,
  });
  return request(app)
    .post("/api/worker-control/enroll")
    .set(WORKER_CONTROL_HEADERS.enrollmentCode, code)
    .set(proofHeaders(proof))
    .send(body);
}

function decodeClaims(session: string): { iat: number; exp: number; generation: number; deviceThumbprint: string; scope: string } {
  const payload = JSON.parse(Buffer.from(session.split(".")[1]!, "base64url").toString("utf8"));
  return payload;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-wrk010-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    const port = await allocatePort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"), user: "test", password: "test", port,
      persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(adminUrl);
    admin = postgres(adminUrl, { max: 1 });
    ownerDb = createDb(adminUrl);
    await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
    await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", PASSWORD));
    appConn = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`));
    operatorConn = createOperatorDbConnection(adminUrl.replace("test:test", `aoa_operator:${PASSWORD}`));
    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${ORG_A}, 'WRK-010 A', 'wrk-010-a'), (${ORG_B}, 'WRK-010 B', 'wrk-010-b')`;
    await admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
      VALUES (${COMPANY_A}, ${ORG_A}, 'WRK-010 Company A', 'WPA')`;
    await admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${OWNER_USER}, 'Owner', 'wrk-010-owner@example.invalid', true, now(), now())`;
    await admin`INSERT INTO organization_memberships (organization_id, user_id, role, status, joined_at)
      VALUES (${ORG_A}, ${OWNER_USER}, 'owner', 'active', now())`;
    await admin`INSERT INTO execution_targets
      (id, organization_id, owner_user_id, slug, kind, trust_class, status, capabilities, config, scope, target_authority_key)
      VALUES
      (${TARGET_A}, ${ORG_A}, NULL, 'target-a', 'dedicated_worker', 'dedicated_tenant', 'active',
        ${{ providerConstraints: { profileId: "desktop-v1", version: 1, digest: "b".repeat(64) } }}, '{}',
        'organization', ${`organization:${ORG_A}`}),
      (${TARGET_PLATFORM}, NULL, NULL, 'target-platform', 'pooled_gvisor', 'shared_multitenant', 'active',
        ${{ providerConstraints: { profileId: "platform-v1", version: 1, digest: "c".repeat(64) } }}, '{}',
        'platform', 'platform'),
      (${TARGET_OWNER}, ${ORG_A}, ${OWNER_USER}, 'target-owner', 'desktop', 'dedicated_tenant', 'active',
        ${{ providerConstraints: { profileId: "owner-v1", version: 1, digest: "d".repeat(64) } }}, '{}',
        'owner', ${`owner:${ORG_A}:${OWNER_USER}`})`;

    httpApp = express();
    httpApp.use(express.json({ verify: (req, _res, bytes) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
    } }));
    httpApp.use("/api", workerControlRoutes({
      db: ownerDb, appDb: appConn.db, operatorDb: operatorConn.db,
      sessionSigningKey: SIGNING_KEY, now: () => clock,
    }));
    httpApp.use(errorHandler);
    enrollmentService = createWorkerEnrollmentService({
      appDb: appConn.db, operatorDb: operatorConn.db, sessionSigningKey: SIGNING_KEY, now: () => clock,
    });
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await ownerDb?.$client.end(); } catch { /* ignore */ }
  try { await operatorConn?.close({ timeoutSeconds: 5 }); } catch { /* ignore */ }
  try { await appConn?.close({ timeoutSeconds: 5 }); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

beforeEach(async () => {
  clock = NOW;
  if (!admin) return;
  await admin`DELETE FROM worker_proof_replays`;
  await admin`DELETE FROM worker_enrollment_codes`;
  await admin`DELETE FROM worker_enrollment_code_routes`;
  await admin`DELETE FROM workers`;
  await admin`UPDATE execution_targets
    SET device_generation = 1, status = 'active', last_seen_at = NULL,
        registered_profile = NULL, registered_profile_hash = NULL, provider_constraint_profile = NULL
    WHERE id IN (${TARGET_A}, ${TARGET_PLATFORM}, ${TARGET_OWNER})`;
  await admin`UPDATE organization_memberships SET status = 'active' WHERE organization_id = ${ORG_A} AND user_id = ${OWNER_USER}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "WRK-010 device-proof session renewal (embedded PostgreSQL)",
  () => {
    it("★ THE POINT: renews AFTER the 10-min code route lapses, the minted session WORKS, and authority SUSTAINS past the original expiry", async () => {
      const { app } = guard();
      const { session: s0, keys, body, code } = await enroll({
        workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null,
      });

      // ★ PRECONDITION CONTROL (a PAIR, both REPLAYING the code that minted s0 with a FRESH
      // proof so only CODE_TTL_MS moves — a T0 proof replayed at T0+11min would die on SKEW
      // and never touch the code table, which would isolate nothing).
      // T0+4min: same code, fresh proof → 200 (code route ALIVE, the replay path works).
      clock = new Date(NOW.getTime() + 4 * MIN);
      const alive = await replayEnroll(code, body, keys, "control-alive");
      expect(alive.status, JSON.stringify(alive.body)).toBe(200);
      // T0+11min: same code, fresh proof → 401 (code route LAPSED).
      clock = new Date(NOW.getTime() + 11 * MIN);
      const lapsed = await replayEnroll(code, body, keys, "control-lapsed");
      expect(lapsed.status, JSON.stringify(lapsed.body)).toBe(401);

      // Still at T0+11min: renew s0 with a live session + fresh proof, NO code header → 200.
      const renewed = await renew({ session: s0, keys, proofId: "renew-first" });
      expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
      const s1 = renewed.headers[WORKER_CONTROL_HEADERS.session] as string;
      expect(s1).not.toBe(s0);
      const c0 = decodeClaims(s0);
      const c1 = decodeClaims(s1);
      expect(c1.exp - c1.iat).toBe(900);
      expect(c1.iat).toBeGreaterThan(c0.iat);
      expect(c1.exp).toBeGreaterThan(c0.exp);
      expect(c1.generation).toBe(c0.generation);
      expect(c1.deviceThumbprint).toBe(c0.deviceThumbprint);
      expect(renewed.body).toMatchObject({ protocolVersion: 1, outcome: "renewed", deviceGeneration: 1 });

      // ★ PRODUCT CONTROL: a token that parses is not a token that WORKS. Spend s1 on the poll
      // route, which routes through verifyWorkerOperationProof (the OTHER verifier, NOT the
      // renewal authenticator). The proof of the claim is that the minted token is ACCEPTED by
      // that verifier: verifyWorkerOperationProof runs FIRST in the poll handler and a rejected
      // token would 401 `unauthorized` (worker-control.ts:332). We instead reach the leasing
      // layer — which returns 409 `target_revoked` because TARGET_A has no placement profile and
      // no recent heartbeat, both orthogonal to the auth claim and, unlike the renewal route,
      // measured against the DB's real clock. So: NOT unauthorized proves the token satisfies the
      // second verifier. (Getting all the way to 200 no_work needs the full placement + heartbeat
      // scaffold, which does not strengthen the "the minted token authenticates" claim.)
      const pollCorrelation = cid();
      const pollReq = {
        protocolVersion: 1, correlationId: pollCorrelation, issuedAt: clock.toISOString(),
        nonce: "renew-poll", audience: "worker_poll", workerId: WORKER_A, targetId: TARGET_A,
        deviceGeneration: 1, capacity: body.hello.capacity,
      };
      const pollResp = await request(app)
        .post("/api/worker-control/poll")
        .set("authorization", `Bearer ${s1}`)
        .set(proofHeaders(deviceProofFor({
          bytes: rawBody(pollReq), correlationId: pollCorrelation, privateKey: keys.privateKey,
          publicKey: keys.publicKey, proofId: "renew-poll-proof", path: "/api/worker-control/poll", proofNow: clock,
        })))
        .send(pollReq);
      expect(pollResp.status, JSON.stringify(pollResp.body)).not.toBe(401);
      expect((pollResp.body as { code?: string }).code, JSON.stringify(pollResp.body)).not.toBe("unauthorized");

      // ★ SUSTAINS past the ORIGINAL session's hard expiry: at T0+20min (s0 dead since T0+15min)
      // renew FROM the renewed session s1 → a third session.
      clock = new Date(NOW.getTime() + 20 * MIN);
      const third = await renew({ session: s1, keys, proofId: "renew-second" });
      expect(third.status, JSON.stringify(third.body)).toBe(200);
      const s2 = third.headers[WORKER_CONTROL_HEADERS.session] as string;
      expect(s2).not.toBe(s1);
      expect(decodeClaims(s2).iat).toBeGreaterThan(c1.iat);
    });

    it("★ never consults the enrollment code table: delete every code + route row, then renew → 200", async () => {
      const { session, keys } = await enroll({
        workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null,
      });
      await admin!`DELETE FROM worker_enrollment_codes`;
      await admin!`DELETE FROM worker_enrollment_code_routes`;
      const renewed = await renew({ session, keys, proofId: "renew-nocode" });
      expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    });

    it("★ refuses the SAME request once the target is REVOKED, coarsely and anonymously (positive control)", async () => {
      const warnSpy = vi.spyOn(logger, "warn");
      const { session, keys } = await enroll({
        workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null,
      });
      // The identical shape succeeds first, so the later 401 is attributable to the revocation.
      const ok = await renew({ session, keys, proofId: "revoke-ok" });
      expect(ok.status).toBe(200);
      await admin!`UPDATE workers SET status = 'revoked' WHERE id = ${WORKER_A}`;
      const refused = await renew({ session, keys, proofId: "revoke-refused" });
      expect(refused.status).toBe(401);
      // The envelope names no target, worker, generation or reason.
      expect(JSON.stringify(refused.body)).not.toMatch(new RegExp(`${WORKER_A}|${TARGET_A}|revoked|generation`, "i"));
      const reasons = warnSpy.mock.calls.map((c) => (c[0] as { reasonCode?: string })?.reasonCode);
      expect(reasons).toContain("worker_session_renewal_target_revoked");
    });

    it("★ DE-18 session arm: the target_revoked refusal leaves ONE attributable security.denied.worker_session row naming the failed disjunct (RED-first)", async () => {
      const denialRows = async () => await admin!<Array<{
        action: string; actor_type: string; actor_id: string;
        company_id: string | null; organization_id: string | null;
        entity_type: string; entity_id: string; details: Record<string, unknown>;
      }>>`SELECT action, actor_type, actor_id, company_id, organization_id, entity_type, entity_id, details
          FROM activity_log WHERE action LIKE ${"security.denied.%"} ORDER BY created_at ASC`;

      // ANTI-VACUITY FIRST, on pristine beforeEach state: a successful renewal
      // writes ZERO denial rows. (Run first because the revocation arms below
      // re-enroll the same worker/target repeatedly, which entangles a trailing
      // fresh-enroll's device-generation handshake — unrelated to the audit.)
      await admin!`DELETE FROM activity_log WHERE action LIKE ${"security.denied.%"}`;
      const okEnroll = await enroll({ workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null });
      expect((await renew({ session: okEnroll.session, keys: okEnroll.keys, proofId: `de18-ok-${crypto.randomUUID()}` })).status).toBe(200);
      expect(await denialRows()).toHaveLength(0);
      await admin!`DELETE FROM workers`;

      // Disabled target → NOT a generation replacement, so not DE-18 — but it IS
      // a worker-authority-currency refusal, recorded under DE-04's
      // worker-authority-currency arm (register amendment 2026-09-13).
      const first = await enroll({ workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null });
      await admin!`UPDATE execution_targets SET status = 'disabled' WHERE id = ${TARGET_A}`;
      await admin!`DELETE FROM activity_log WHERE action LIKE ${"security.denied.%"}`;
      expect((await renew({ session: first.session, keys: first.keys, proofId: `de18-disabled-${crypto.randomUUID()}` })).status).toBe(401);
      let rows = await denialRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("security.denied.worker_session");
      expect(rows[0]!.details.reason).toBe("session_authority_revoked");
      expect(rows[0]!.details.failed).toEqual(["target_disabled"]);
      expect(rows[0]!.details.crossing).toBe("DE-04");
      await admin!`UPDATE execution_targets SET status = 'active' WHERE id = ${TARGET_A}`;
      await admin!`DELETE FROM workers`;

      // Generation supersession → failed names generation_drift (the DE-18 cutoff proper).
      const second = await enroll({ workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null });
      // RELATIVE bump (re-enrollment itself moves the generation, so an absolute
      // value can be a downgrade), and no restore — the next enroll re-syncs.
      await admin!`UPDATE execution_targets SET device_generation = device_generation + 1 WHERE id = ${TARGET_A}`;
      await admin!`DELETE FROM activity_log WHERE action LIKE ${"security.denied.%"}`;
      expect((await renew({ session: second.session, keys: second.keys, proofId: `de18-gen-${crypto.randomUUID()}` })).status).toBe(401);
      rows = await denialRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("security.denied.worker_session");
      expect(rows[0]!.details.reason).toBe("session_authority_revoked");
      expect(rows[0]!.details.failed).toContain("generation_drift");
      // ★ A genuine generation cutoff IS DE-18.
      expect(rows[0]!.details.crossing).toBe("DE-18");
      expect(rows[0]!.actor_id).toBe(WORKER_A);
      expect(rows[0]!.organization_id).toBe(ORG_A);
      expect(rows[0]!.company_id).toBeNull();
      // Restore RELATIVELY (the enroll hello pins deviceGeneration 1, so the row
      // must return to its pre-bump value for the next enrollment to admit).
      await admin!`UPDATE execution_targets SET device_generation = device_generation - 1 WHERE id = ${TARGET_A}`;
      await admin!`DELETE FROM workers`;

    });

    it("refuses a DISABLED target, worker revoked by revoked_at alone, and an inactive owner membership → target_revoked class", async () => {
      // disabled target
      const disabled = await enroll({ workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null });
      await admin!`UPDATE execution_targets SET status = 'disabled' WHERE id = ${TARGET_A}`;
      expect((await renew({ session: disabled.session, keys: disabled.keys, proofId: "disabled" })).status).toBe(401);
      await admin!`UPDATE execution_targets SET status = 'active' WHERE id = ${TARGET_A}`;
      await admin!`DELETE FROM workers`;

      // worker revoked by revoked_at ALONE (status left enrolled) — the two are independent columns
      const revokedAt = await enroll({ workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null });
      await admin!`UPDATE workers SET revoked_at = ${NOW} WHERE id = ${WORKER_A}`;
      expect((await renew({ session: revokedAt.session, keys: revokedAt.keys, proofId: "revoked-at" })).status).toBe(401);

      // owner-scope worker whose organization membership is set inactive
      const owner = await enroll({ workerId: WORKER_OWNER, targetId: TARGET_OWNER, scope: "owner", organizationId: ORG_A, ownerUserId: OWNER_USER });
      expect((await renew({ session: owner.session, keys: owner.keys, proofId: "owner-ok" })).status).toBe(200);
      await admin!`UPDATE organization_memberships SET status = 'suspended' WHERE organization_id = ${ORG_A} AND user_id = ${OWNER_USER}`;
      expect((await renew({ session: owner.session, keys: owner.keys, proofId: "owner-suspended" })).status).toBe(401);
    });

    it("refuses on generation supersession — target ahead, worker-row ahead, and claims ahead (both directions)", async () => {
      const { session, keys } = await enroll({ workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null });
      // target generation moved AHEAD of the session claim
      await admin!`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET_A}`;
      expect((await renew({ session, keys, proofId: "gen-target-ahead" })).status).toBe(401);
      await admin!`UPDATE execution_targets SET device_generation = 1 WHERE id = ${TARGET_A}`;
      // worker row generation moved while the target's did not
      await admin!`UPDATE workers SET device_generation = 2 WHERE id = ${WORKER_A}`;
      expect((await renew({ session, keys, proofId: "gen-worker-ahead" })).status).toBe(401);
      await admin!`UPDATE workers SET device_generation = 1 WHERE id = ${WORKER_A}`;
      // claim ahead of BOTH rows — the other direction, via a crafted session
      const { createWorkerSessionToken, verifyWorkerSessionToken } = await import("../middleware/worker-session-auth.js");
      const claims = verifyWorkerSessionToken(SIGNING_KEY, session, NOW);
      const aheadClaim = createWorkerSessionToken(SIGNING_KEY, { ...claims, generation: 2 });
      expect((await renew({ session: aheadClaim, keys, proofId: "gen-claim-ahead" })).status).toBe(401);
    });

    it("distinguishes proof-matches-TOKEN from proof-matches-ROW (rotated row key), and refuses a FOREIGN key", async () => {
      const warnSpy = vi.spyOn(logger, "warn");
      const { session, keys } = await enroll({ workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null });
      // Rotate the ROW's public key to a different real SPKI while session + proof stay mutually
      // consistent → the proof matches the TOKEN's thumbprint but not the ROW's key → unauthorized.
      const otherKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
      await admin!`UPDATE workers SET device_public_key = ${otherKey} WHERE id = ${WORKER_A}`;
      expect((await renew({ session, keys, proofId: "row-key-rotated" })).status).toBe(401);
      // Reset, then a proof signed by a FOREIGN key (thumbprint ≠ session claim) → refused at the
      // transport, before the tenant transaction opens.
      await admin!`UPDATE workers SET device_public_key = ${keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url")} WHERE id = ${WORKER_A}`;
      const foreign = generateKeyPairSync("ed25519");
      expect((await renew({ session, keys: foreign, proofId: "foreign-key" })).status).toBe(401);
      const reasons = warnSpy.mock.calls.map((c) => (c[0] as { reasonCode?: string })?.reasonCode);
      expect(reasons).toContain("worker_session_renewal_unauthorized");
    });

    it("enforces the ±5-minute proof skew window (anti-vacuity 4-min success) and refuses a REPLAYED proofId", async () => {
      const { session, keys } = await enroll({ workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null });
      clock = new Date(NOW.getTime() + 2 * MIN);
      // proof 6 minutes stale → outside the ±5-minute window → refused
      expect((await renew({ session, keys, proofId: "skew-stale", proofNow: new Date(clock.getTime() - 6 * MIN) })).status).toBe(401);
      // ANTI-VACUITY: proof 4 minutes off → inside the window → succeeds (the path isn't broken)
      expect((await renew({ session, keys, proofId: "skew-inside", proofNow: new Date(clock.getTime() - 4 * MIN) })).status).toBe(200);
      // REPLAY: a fresh proofId succeeds, then the SAME proofId at the same clock is refused
      expect((await renew({ session, keys, proofId: "replay-fresh" })).status).toBe(200);
      expect((await renew({ session, keys, proofId: "replay-fresh" })).status).toBe(401);
    });

    it("★ RENEWS a DRAINING and an OFFLINE target — withholding authority would strand finishing work", async () => {
      const { session, keys } = await enroll({ workerId: WORKER_A, targetId: TARGET_A, scope: "organization", organizationId: ORG_A, ownerUserId: null });
      await admin!`UPDATE execution_targets SET status = 'draining' WHERE id = ${TARGET_A}`;
      expect((await renew({ session, keys, proofId: "draining-ok" })).status).toBe(200);
      await admin!`UPDATE execution_targets SET status = 'offline' WHERE id = ${TARGET_A}`;
      expect((await renew({ session, keys, proofId: "offline-ok" })).status).toBe(200);
    });

    it("★ refuses a platform PHYSICAL session, and RENEWS a shared-platform TENANT worker", async () => {
      const warnSpy = vi.spyOn(logger, "warn");
      // Ratify the platform placement profile + enroll the PHYSICAL device on the shared target.
      const provider = placementProviderProfile();
      await ratifyPlatformExecutionTargetPlacementProfile({
        operatorDb: operatorConn!.db, executionTargetId: TARGET_PLATFORM,
        registeredProfile: placementRegisteredProfile(provider), providerConstraintProfile: provider,
      });
      const physical = await enroll({ workerId: WORKER_PLATFORM, targetId: TARGET_PLATFORM, scope: "organization", organizationId: ORG_A, ownerUserId: null, platform: true });
      // The physical (platform) session authenticates via the operator DB (organizationId null)
      // and admitSessionRenewal R1 refuses it.
      const physicalRefused = await renew({ session: physical.session, keys: physical.keys, proofId: "platform-physical" });
      expect(physicalRefused.status, JSON.stringify(physicalRefused.body)).toBe(401);
      // ★ ISOLATE THE MECHANISM to R1, not merely "some 401". The physical session PASSES the
      // authenticator (findSessionAuthority admits it via the operator branch); only admission R1
      // refuses it, logging the discriminating reason. Without this a regression that moved the
      // refusal EARLIER (e.g. verifyCurrent throwing target_revoked) would still show 401 and pass
      // — the E1-F008 "right answer, wrong mechanism" trap. The sibling reasons are proven not to
      // fire by the shared-platform TENANT renewal below (200), which shares this same operator path.
      expect(warnSpy.mock.calls.map((c) => (c[0] as { reasonCode?: string })?.reasonCode))
        .toContain("worker_session_renewal_platform_physical_unsupported");

      // A shared-platform TENANT worker (org-scoped, platform target) shares the physical device
      // key. Its authority resolves the shared-platform authority → R2 passes → renews.
      const logical = await enroll({ workerId: WORKER_LOGICAL, targetId: TARGET_PLATFORM, scope: "organization", organizationId: ORG_A, ownerUserId: null, keys: physical.keys });
      const logicalRenewed = await renew({ session: logical.session, keys: physical.keys, proofId: "platform-tenant" });
      expect(logicalRenewed.status, JSON.stringify(logicalRenewed.body)).toBe(200);
    });
  },
);
