import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net, { type AddressInfo } from "node:net";
import type { Server } from "node:http";
import postgres, { type Sql } from "postgres";
import express from "express";
import {
  applyPendingMigrations,
  createDb,
  createOperatorDbConnection,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import {
  createWorkerSessionLifecycle,
  createControlPlaneClient,
  createEnroller,
  enrollOnce,
  type DeviceIdentityRecord,
  type DeviceEnrollmentReceipt,
  type DeviceRecordStore,
  type EnrollmentInput,
} from "@armyofagents/worker-daemon";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { workerControlRoutes } from "../routes/worker-control.js";
import { createWorkerEnrollmentService } from "../services/worker-enrollment.js";
import { errorHandler } from "../middleware/error-handler.js";

// ★ WRK-010 slice 2 (go-book Sprint 2.5) — the renewal route gets its FIRST caller, proven
// against a REAL database with the REAL daemon lifecycle. This is the clause the go-book's
// Sprint 2.5 line actually promises. It injects NO fixture session: the first session is minted
// by real enrolment (the sink) or the real code replay (bootstrap), and the renewed one comes
// from THIS ticket's route via the daemon's real `createSessionRenewer`. A test that injects a
// fake session proves neither transition (WRK-010 §9.1.1).
//
// Everything — server routes, enrolment service, and the daemon's enroller/renewer — reads one
// injected `clock`, so proof skew is always zero and the clock can be advanced deterministically.
// The daemon's real fetch client talks to a REAL http listener.

const SIGNING_KEY = "test-signing-key-at-least-32-bytes";
const ORG_A = "71000000-0000-4000-8000-000000000001";
const TARGET_A = "72000000-0000-4000-8000-000000000001";
const OWNER_USER = "wrk-010-s2-owner";
const COMPANY_A = "76000000-0000-4000-8000-000000000001";
const PASSWORD = "wrk-010-s2-role";
const NOW = new Date(Date.UTC(2026, 7, 12, 0, 0, 0));
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
let clock = NOW.getTime();
let httpServer: Server | null = null;
let baseUrl = "";
let enrollmentService: ReturnType<typeof createWorkerEnrollmentService> | null = null;

const now = () => new Date(clock);

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
  if (!admin || !enrollmentService || !baseUrl) throw new Error("test setup incomplete");
  return { admin, enrollment: enrollmentService };
}

/** An in-memory record store with real compare-and-set semantics (mirrors enroll-once tests). */
function memoryStore<T>(): DeviceRecordStore<T> & { peek: () => T | null } {
  let value: T | null = null;
  return {
    load: () => value,
    saveIfAbsent: (r: T) => { if (value !== null) return "already_present"; value = r; return "stored"; },
    clear: () => { value = null; },
    peek: () => value,
  };
}

/** Every daemon enroller reads the shared clock, so its proof skew against the server is zero. */
const clockEnroller: NonNullable<Parameters<typeof enrollOnce>[0]["createEnrollerFn"]> =
  (d) => createEnroller({ keyStore: d.keyStore, client: d.client, now: () => clock });

/** Fresh identity + receipt stores, a client at the real listener, and a lifecycle wired to them. */
function composeLifecycle(code: string, stores?: { identityStore: DeviceRecordStore<DeviceIdentityRecord> & { peek(): DeviceIdentityRecord | null }; receiptStore: DeviceRecordStore<DeviceEnrollmentReceipt> & { peek(): DeviceEnrollmentReceipt | null } }) {
  const identityStore = stores?.identityStore ?? memoryStore<DeviceIdentityRecord>();
  const receiptStore = stores?.receiptStore ?? memoryStore<DeviceEnrollmentReceipt>();
  const client = createControlPlaneClient({ baseUrl });
  const readInput = (): EnrollmentInput => ({ targetId: TARGET_A, enrollmentCode: code });
  const lifecycle = createWorkerSessionLifecycle({
    identityStore, client, now: () => clock, readInput,
    platform: process.platform, arch: process.arch,
    createEnrollerFn: clockEnroller,
  });
  return { identityStore, receiptStore, client, readInput, lifecycle };
}

function decodeClaims(token: string): { iat: number; exp: number; generation: number } {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

async function issueCode(): Promise<string> {
  const { enrollment } = guard();
  const issued = await enrollment.issueTenantCode({
    organizationId: ORG_A, executionTargetId: TARGET_A, scope: "organization",
    ownerUserId: null, createdByPrincipalKind: "user", createdByPrincipalId: OWNER_USER,
  });
  return issued.code;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-wrk010-s2-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    const pgPort = await allocatePort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"), user: "test", password: "test", port: pgPort,
      persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"],
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
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG_A}, 'WRK-010 S2', 'wrk-010-s2')`;
    await admin`INSERT INTO companies (id, organization_id, name, issue_prefix) VALUES (${COMPANY_A}, ${ORG_A}, 'S2 Co', 'WPS')`;
    await admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${OWNER_USER}, 'Owner', 'wrk-010-s2-owner@example.invalid', true, now(), now())`;
    await admin`INSERT INTO organization_memberships (organization_id, user_id, role, status, joined_at)
      VALUES (${ORG_A}, ${OWNER_USER}, 'owner', 'active', now())`;
    await admin`INSERT INTO execution_targets
      (id, organization_id, owner_user_id, slug, kind, trust_class, status, capabilities, config, scope, target_authority_key)
      VALUES (${TARGET_A}, ${ORG_A}, NULL, 'target-a', 'dedicated_worker', 'dedicated_tenant', 'active',
        ${{ providerConstraints: { profileId: "desktop-v1", version: 1, digest: "b".repeat(64) } }}, '{}',
        'organization', ${`organization:${ORG_A}`})`;

    const app = express();
    app.use(express.json({ verify: (req, _res, bytes) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
    } }));
    app.use("/api", workerControlRoutes({
      db: ownerDb, appDb: appConn.db, operatorDb: operatorConn.db,
      sessionSigningKey: SIGNING_KEY, now,
    }));
    app.use(errorHandler);
    enrollmentService = createWorkerEnrollmentService({
      appDb: appConn.db, operatorDb: operatorConn.db, sessionSigningKey: SIGNING_KEY, now,
    });

    httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((res) => httpServer!.once("listening", () => res()));
    baseUrl = `http://127.0.0.1:${(httpServer!.address() as AddressInfo).port}`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await new Promise<void>((res) => (httpServer ? httpServer.close(() => res()) : res())); } catch { /* ignore */ }
  try { await ownerDb?.$client.end(); } catch { /* ignore */ }
  try { await operatorConn?.close({ timeoutSeconds: 5 }); } catch { /* ignore */ }
  try { await appConn?.close({ timeoutSeconds: 5 }); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

beforeEach(async () => {
  clock = NOW.getTime();
  if (!admin) return;
  await admin`DELETE FROM worker_proof_replays`;
  await admin`DELETE FROM worker_enrollment_codes`;
  await admin`DELETE FROM worker_enrollment_code_routes`;
  await admin`DELETE FROM workers`;
  await admin`UPDATE execution_targets SET device_generation = 1, status = 'active', last_seen_at = NULL WHERE id = ${TARGET_A}`;
  await admin`UPDATE organization_memberships SET status = 'active' WHERE organization_id = ${ORG_A} AND user_id = ${OWNER_USER}`;
});

afterEach(() => { vi.restoreAllMocks(); });

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "WRK-010 slice 2 — composed daemon session lifecycle (embedded PostgreSQL)",
  () => {
    it("S2-A1 + S2-A2 + T0+15min: FIRST session from the sink, RENEWED from the route, authority sustains", async () => {
      const code = await issueCode();
      const { identityStore, receiptStore, lifecycle } = composeLifecycle(code);

      // ── S2-A1: the ENROLLING boot. Real enrolment against the real control plane; the sink —
      //           NOT a fixture — is the only thing that puts a session in the store.
      const outcome = await enrollOnce({
        identityStore, receiptStore,
        client: createControlPlaneClient({ baseUrl }),
        readInput: () => ({ targetId: TARGET_A, enrollmentCode: code }),
        platform: process.platform, arch: process.arch,
        createEnrollerFn: clockEnroller,
        onSessionMinted: lifecycle.onSessionMinted,
      });
      expect(outcome.enrolled).toBe(true);
      expect(outcome.skipped).toBe(false);
      // S2-A4 (unit half is in the daemon suite): the outcome carries no session/token.
      expect(Object.keys(outcome)).not.toContain("session");
      const s0 = lifecycle.store.current();
      expect(s0, "the sink must have seeded the store").not.toBeNull();
      const t0 = s0!.token;
      expect(typeof t0).toBe("string");

      // ── S2-A2: RENEW from THIS ticket's route. forceRefresh presents the live s0 to the
      //           renewal client → the real route → a NEW session. No fixture anywhere.
      clock += MIN; // one minute later, so iat advances a whole second and the token differs
      const s1 = await lifecycle.store.forceRefresh();
      expect(s1.token).not.toBe(t0);
      expect(lifecycle.store.current()!.token).toBe(s1.token);
      const c0 = decodeClaims(t0);
      const c1 = decodeClaims(s1.token);
      expect(c1.exp - c1.iat).toBe(900); // still a 15-minute ceiling
      expect(c1.iat).toBeGreaterThan(c0.iat);
      expect(c1.exp).toBeGreaterThan(c0.exp); // authority extended past s0's window

      // ── crosses T0+15min still authorised: advance PAST s0's original expiry. s0 is now dead,
      //    but s1 (minted at T0+1min, expiring T0+16min) is live — a route call with it succeeds.
      clock = NOW.getTime() + 15 * MIN + 30_000; // T0 + 15m30s
      const s2 = await lifecycle.store.forceRefresh(); // presents s1 (still live) → route → s2
      expect(s2.token).not.toBe(s1.token);
      expect(decodeClaims(s2.token).iat).toBeGreaterThan(c1.iat);
    });

    it("S2-A3: a STEADY-STATE boot obtains its first session from BOOTSTRAP (code replay), not the sink", async () => {
      const code = await issueCode();
      const identityStore = memoryStore<DeviceIdentityRecord>();
      const receiptStore = memoryStore<DeviceEnrollmentReceipt>();

      // First boot enrols and persists identity + receipt (no sink needed for this clause).
      await enrollOnce({
        identityStore, receiptStore, client: createControlPlaneClient({ baseUrl }),
        readInput: () => ({ targetId: TARGET_A, enrollmentCode: code }),
        platform: process.platform, arch: process.arch, createEnrollerFn: clockEnroller,
      });
      expect(identityStore.peek()).not.toBeNull();

      // Second boot: identity + receipt on disk ⇒ enrollOnce short-circuits `skipped`, the sink
      // never fires — the first session must come from the bootstrap dependency instead.
      const onSessionMinted = vi.fn();
      const lifecycle = createWorkerSessionLifecycle({
        identityStore, client: createControlPlaneClient({ baseUrl }), now: () => clock,
        readInput: () => ({ targetId: TARGET_A, enrollmentCode: code }),
        platform: process.platform, arch: process.arch, createEnrollerFn: clockEnroller,
      });
      const steady = await enrollOnce({
        identityStore, receiptStore, client: createControlPlaneClient({ baseUrl }),
        readInput: () => ({ targetId: TARGET_A, enrollmentCode: code }),
        platform: process.platform, arch: process.arch, createEnrollerFn: clockEnroller,
        onSessionMinted,
      });
      expect(steady.skipped).toBe(true);
      expect(onSessionMinted).not.toHaveBeenCalled();

      // Still within the 10-minute code window ⇒ bootstrap (code replay) recovers a session.
      const first = await lifecycle.store.ensureFresh();
      expect(typeof first.token).toBe("string");
      expect(lifecycle.store.isStopped()).toBe(false);
      // …and it can then RENEW through the route off that bootstrapped session.
      clock += MIN;
      const renewed = await lifecycle.store.forceRefresh();
      expect(renewed.token).not.toBe(first.token);
    });
  },
);
