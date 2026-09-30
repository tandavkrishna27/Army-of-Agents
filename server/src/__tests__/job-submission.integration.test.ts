import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import postgres, { type Sql } from "postgres";
import request from "supertest";
import {
  applyPendingMigrations,
  createDb,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import {
  browserWorkloadV1Schema,
  serviceWorkloadV1Schema,
  OPERATION_DESCRIPTORS,
} from "@armyofagents/worker-protocol";
import type { StorageService } from "../storage/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { provisionTenantAppRoleLoginSql, TENANT_APP_ROLE } from "../db/rls-tenant.js";
import { createCommanderRunJwt } from "../agent-auth-jwt.js";
import { jobSubmissionService } from "../services/job-submission.js";
import * as placementNamespace from "../services/job-placement.js";

vi.mock("../services/aoa-marketplace.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/aoa-marketplace.js")>();
  class NoopMarketplaceCatalogService {
    constructor(_deps: unknown) {}
    startSyncLoop(): void {}
    stopSyncLoop(): void {}
  }
  return { ...actual, MarketplaceCatalogService: NoopMarketplaceCatalogService };
});

const capturedLogDir = await mkdtemp(join(tmpdir(), "aoa-job-submission-logs-"));
process.env.AOA_LOG_DIR = capturedLogDir;
process.env.AOA_AGENT_JWT_SECRET = "job-submission-commander-jwt-secret";
const { createApp } = await import("../app.js");
const { logger } = await import("../middleware/logger.js");

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const APP_PASSWORD = "job-submission-app-password";
const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const COMPANY_A = "20000000-0000-4000-8000-000000000001";
const COMPANY_B = "20000000-0000-4000-8000-000000000002";
const USER_A = "job-submission-user-a";
const USER_B = "job-submission-user-b";
const AGENT_A = "30000000-0000-4000-8000-000000000001";
const AGENT_B = "30000000-0000-4000-8000-000000000002";
const RUN_A = "40000000-0000-4000-8000-000000000001";
const ISSUE_A = "50000000-0000-4000-8000-000000000001";
const ISSUE_B = "50000000-0000-4000-8000-000000000002";
const MCP_KEY_A = "d0000000-0000-4000-8000-000000000001";
const MCP_TOKEN_A = "job-submission-mcp-token-a";
const COMMANDER_RUN_A = "60000000-0000-4000-8000-000000000001";
const CONVERSATION_A = "70000000-0000-4000-8000-000000000001";
const CREW_RUN_A = "80000000-0000-4000-8000-000000000001";
const BROWSER_RUN_A = "a0000000-0000-4000-8000-000000000001";
const SERVICE_A = "b0000000-0000-4000-8000-000000000001";
const SERVICE_INSTANCE_A = "b0000000-0000-4000-8000-0000000000f1";
/** A service the caller is NOT authorized for, used to prove server-stamping. */
const SERVICE_DECOY = "b0000000-0000-4000-8000-0000000000de";

const SOURCE_CASES = [
  { kind: "task_run", runId: RUN_A, issueId: ISSUE_A, assigneeAgentId: AGENT_A },
  {
    kind: "commander_turn",
    internalAgentRunId: COMMANDER_RUN_A,
    conversationId: CONVERSATION_A,
  },
  { kind: "crew_run", crewRunId: CREW_RUN_A },
  {
    kind: "one_shot",
    operationId: "90000000-0000-4000-8000-000000000001",
    operationKind: "extraction",
  },
  {
    kind: "browser_request",
    browserRequestId: BROWSER_RUN_A,
    parentJobId: null,
  },
  {
    kind: "service_reconcile",
    serviceId: SERVICE_A,
    generation: 1,
    reconciliationId: "c0000000-0000-4000-8000-000000000001",
  },
] as const;

const FROZEN_EXECUTOR_AUTHORITY = {
  task_run: { kind: "worker", id: AGENT_A },
  commander_turn: { kind: "sandbox", id: COMMANDER_RUN_A },
  crew_run: { kind: "worker", id: AGENT_A },
  one_shot: { kind: "worker", id: SOURCE_CASES[3].operationId },
  browser_request: { kind: "browser_worker", id: BROWSER_RUN_A },
  service_reconcile: { kind: "service_instance", id: SERVICE_A },
} as const;

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let admin: Sql | null = null;
let appConnection: NonOwnerDbConnection | null = null;
let app: Awaited<ReturnType<typeof createApp>>;
let localBoardApp: Awaited<ReturnType<typeof createApp>>;
let flagOffApp: Awaited<ReturnType<typeof createApp>>;
let setupError: unknown = null;

function guard(): void {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
}

function route(orgId = ORG_A, companyId = COMPANY_A): string {
  return `/api/organizations/${orgId}/companies/${companyId}/jobs`;
}

/**
 * BRW-001 — the submitted `input` is now WORKLOAD-TYPED for browser jobs.
 *
 * This helper's `{ value, nested }` blob is incidental filler: these tests assert authority
 * and persistence, not workload shape. That was harmless while `job.input` was passed
 * straight through to `buildJobEnvelope` unvalidated — but a `browser_request` carrying
 * `{ value, nested }` could never have leased, because the frozen `browserWorkloadV1Schema`
 * rejects it. The submission simply persisted a job that would silently never run.
 *
 * BRW-001 validates browser input at submit, so the filler is now a 400. The fix is the
 * fixture, not the guard: keep the generic blob for every other source (their workload
 * types are declared `not_enforced`, so they are unchanged), and send a real browser
 * configuration for the browser case. Do NOT "simplify" this back to one shared blob.
 */
function command(idempotencyKey: string, source: Record<string, unknown> = SOURCE_CASES[0], value = "alpha") {
  // SVC-001 promoted the `service` slot to ENFORCED, so a service submission must now
  // carry a real serviceWorkloadV1 rather than the generic {value, nested} probe payload.
  // Before the promotion this fixture's generic input submitted with a 201 and then never
  // leased, which is the silent failure the validator registry exists to prevent.
  const input = source.kind === "browser_request"
    ? { locale: "en-GB", recordTrace: true, maxSessionSeconds: 600 }
    : source.kind === "service_reconcile"
      ? {
          // DELIBERATELY WRONG identity. The source authorizes (SERVICE_A, generation 1);
          // this claims a different service and generation, so the persisted row can only
          // carry the right values if the server actually STAMPED them. With the same
          // values on both sides the assertion below passes even with stamping disabled -
          // verified by mutation, which is how this fixture came to be written this way.
          serviceId: SERVICE_DECOY,
          serviceInstanceId: SERVICE_INSTANCE_A,
          generation: 99,
          command: "node",
          args: ["server.js", value],
          checkpointArtifactId: null,
          gracefulStopSeconds: 30,
        }
      : { value, nested: { stable: true } };
  return { idempotencyKey, source, input };
}

function asUser(userId = USER_A) {
  return { "x-test-user": userId, origin: "http://127.0.0.1", host: "127.0.0.1" };
}

function asAgent() {
  return { "x-aoa-run-id": RUN_A };
}

function asMcp() {
  return { authorization: `Bearer ${MCP_TOKEN_A}` };
}

function asCommander(source = SOURCE_CASES[1]) {
  const token = createCommanderRunJwt({
    companyId: COMPANY_A,
    userId: USER_A,
    userRole: "founder",
    conversationId: source.conversationId,
    turnId: source.internalAgentRunId,
  });
  if (!token) throw new Error("Commander test JWT was not created");
  return { authorization: `Bearer ${token}` };
}

async function flushCapturedLogs(): Promise<string> {
  await new Promise<void>((resolve) => logger.flush(() => resolve()));
  await delay(300);
  try {
    return await readFile(join(capturedLogDir, "server.log"), "utf8");
  } catch {
    return "";
  }
}

async function counts(key: string) {
  const [row] = await admin!<{ jobs: number; attempts: number; outbox: number }[]>`
    SELECT
      (SELECT count(*)::int FROM jobs WHERE idempotency_key = ${key}) AS jobs,
      (SELECT count(*)::int FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE j.idempotency_key = ${key}) AS attempts,
      (SELECT count(*)::int FROM job_outbox o JOIN jobs j ON j.id = o.job_id WHERE j.idempotency_key = ${key}) AS outbox
  `;
  return row!;
}

async function installFailureTrigger(table: "jobs" | "job_attempts" | "job_outbox") {
  await admin!.unsafe(`
    CREATE OR REPLACE FUNCTION job_submission_test_failure() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced ${table} insert failure'; END $$;
    DROP TRIGGER IF EXISTS job_submission_test_failure_trigger ON ${table};
    CREATE TRIGGER job_submission_test_failure_trigger BEFORE INSERT ON ${table}
    FOR EACH ROW EXECUTE FUNCTION job_submission_test_failure();
  `);
}

async function clearFailureTriggers() {
  for (const table of ["jobs", "job_attempts", "job_outbox"]) {
    await admin!.unsafe(`DROP TRIGGER IF EXISTS job_submission_test_failure_trigger ON ${table}`);
  }
}

beforeAll(async () => {
  try {
    process.env.AOA_AGENT_JWT_SECRET = "job-submission-commander-jwt-secret";
    dataDir = await mkdtemp(join(tmpdir(), "aoa-job-submission-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocateEmbeddedPgPort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(adminUrl);
    admin = postgres(adminUrl, { max: 4 });
    await admin.unsafe(provisionTenantAppRoleLoginSql(TENANT_APP_ROLE, APP_PASSWORD));
    const appUrl = adminUrl.replace("test:test", `aoa_app:${APP_PASSWORD}`);
    appConnection = createTenantAppDbConnection(appUrl, { max: 8 });

    await admin`
      INSERT INTO organizations (id, name, slug)
      VALUES (${ORG_A}, 'Job Org A', 'job-org-a'), (${ORG_B}, 'Job Org B', 'job-org-b')
    `;
    await admin`
      INSERT INTO companies (id, name, issue_prefix, organization_id)
      VALUES
        (${COMPANY_A}, 'Job Company A', 'JCA', ${ORG_A}),
        (${COMPANY_B}, 'Job Company B', 'JCB', ${ORG_B})
    `;
    await admin`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES
        (${USER_A}, 'User A', 'job-a@example.test', true, now(), now()),
        (${USER_B}, 'User B', 'job-b@example.test', true, now(), now())
    `;
    await admin`
      INSERT INTO organization_memberships (organization_id, user_id, role, status)
      VALUES (${ORG_A}, ${USER_A}, 'owner', 'active'), (${ORG_A}, ${USER_B}, 'member', 'active')
    `;
    await admin`
      INSERT INTO company_memberships
        (company_id, principal_type, principal_id, status, membership_role)
      VALUES
        (${COMPANY_A}, 'user', ${USER_A}, 'active', 'owner'),
        (${COMPANY_A}, 'user', ${USER_B}, 'active', 'member')
    `;
    await admin`
      INSERT INTO mcp_api_keys (id, company_id, user_id, name, key_hash)
      VALUES (
        ${MCP_KEY_A}, ${COMPANY_A}, ${USER_A}, 'Job submission MCP key',
        ${createHash("sha256").update(MCP_TOKEN_A).digest("hex")}
      )
    `;
    await admin`
      INSERT INTO agents (id, company_id, name, kind, status, adapter_type, adapter_config)
      VALUES
        (${AGENT_A}, ${COMPANY_A}, 'Job agent A', 'org', 'idle', 'http', ${admin.json({ url: "http://127.0.0.1:1/must-not-contact" })}),
        (${AGENT_B}, ${COMPANY_A}, 'Job agent B', 'org', 'idle', 'http', ${admin.json({ url: "http://127.0.0.1:1/must-not-contact" })})
    `;
    await admin`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at)
      VALUES (${RUN_A}, ${COMPANY_A}, ${AGENT_A}, 'running', now())
    `;
    await admin`
      INSERT INTO issues
        (id, company_id, title, status, assignee_agent_id, checkout_run_id, execution_run_id, updated_at)
      VALUES
        (${ISSUE_A}, ${COMPANY_A}, 'Submit immutable job', 'in_progress', ${AGENT_A}, ${RUN_A}, ${RUN_A}, now()),
        (${ISSUE_B}, ${COMPANY_A}, 'Other agent task', 'in_progress', ${AGENT_B}, null, null, now())
    `;
    await admin`
      INSERT INTO internal_agent_conversations (id, company_id, user_id, status)
      VALUES (${CONVERSATION_A}, ${COMPANY_A}, ${USER_A}, 'active')
    `;
    await admin`
      INSERT INTO internal_agent_runs
        (id, company_id, trigger_type, trigger_source, status, user_id, agent_id)
      VALUES
        (${COMMANDER_RUN_A}, ${COMPANY_A}, 'conversation', 'user_message', 'running', ${USER_A}, null),
        (${CREW_RUN_A}, ${COMPANY_A}, 'sub_agent', 'crew_dispatch', 'running', ${USER_A}, ${AGENT_A}),
        (${BROWSER_RUN_A}, ${COMPANY_A}, 'sub_agent', 'browser_request', 'running', ${USER_A}, ${AGENT_A})
    `;
    await admin`
      INSERT INTO internal_agent_messages (conversation_id, role, content, run_id)
      VALUES (${CONVERSATION_A}, 'assistant', 'Commander test turn', ${COMMANDER_RUN_A})
    `;
    await admin`
      INSERT INTO services (id, organization_id, company_id, desired_state, generation)
      VALUES (${SERVICE_A}, ${ORG_A}, ${COMPANY_A}, 'running', 1)
    `;

    const ownerDb = createDb(adminUrl);
    const baseOptions = {
      uiMode: "none",
      storageService: {} as StorageService,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      companyWorkspaceBaseDir: join(dataDir, "workspaces"),
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: true,
      trustProxy: false,
      resolveSession: async (req) => {
        const userId = req.header("x-test-user");
        return userId
          ? { session: { id: `session-${userId}`, userId }, user: { id: userId } as never }
          : null;
      },
    } as const;
    app = await createApp(ownerDb, {
      ...baseOptions,
      distributedExecutionEnabled: true,
      tenantAppDb: appConnection.db,
      operatorDb: appConnection.db,
      workerSessionSigningKey: "job-001-test-worker-session-signing-key",
    } as Parameters<typeof createApp>[1]);
    localBoardApp = await createApp(ownerDb, {
      ...baseOptions,
      resolveSession: undefined,
      devLocalIdentity: true,
      distributedExecutionEnabled: true,
      tenantAppDb: appConnection.db,
      operatorDb: appConnection.db,
      workerSessionSigningKey: "job-001-test-worker-session-signing-key",
    } as Parameters<typeof createApp>[1]);
    flagOffApp = await createApp(ownerDb, {
      ...baseOptions,
      distributedExecutionEnabled: false,
      tenantAppDb: undefined,
    } as Parameters<typeof createApp>[1]);
  } catch (error) {
    setupError = error;
  }
}, 180_000);

beforeEach(async () => {
  if (admin) await clearFailureTriggers();
});

afterAll(async () => {
  try { if (admin) await clearFailureTriggers(); } catch { /* ignore */ }
  try { await appConnection?.close({ timeoutSeconds: 5 }); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { await rm(capturedLogDir, { recursive: true, force: true }); } catch { /* logger transport owns it until process exit */ }
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-001 transactional job submission",
  () => {
    it("returns the original IDs for an identical replay and 409 for a changed digest", async () => {
      guard();
      const body = command("replay-key");
      const first = await request(app).post(route()).set(asUser()).send(body);
      expect(first.status).toBe(201);
      expect(first.body).toEqual({
        jobId: expect.any(String), attemptId: expect.any(String), status: "queued", replayed: false,
      });
      const replay = await request(app).post(route()).set(asUser()).send(body);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, replayed: true });
      const conflict = await request(app).post(route()).set(asUser()).send(command("replay-key", SOURCE_CASES[0], "changed"));
      expect(conflict.status).toBe(409);
      expect(await counts("replay-key")).toEqual({ jobs: 1, attempts: 1, outbox: 1 });
    });

    it("scopes the same client key to the authenticated principal", async () => {
      guard();
      const key = "two-principals";
      const [a, b] = await Promise.all([
        request(app).post(route()).set(asUser(USER_A)).send(command(key)),
        request(app).post(route()).set(asUser(USER_B)).send(command(key)),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.jobId).not.toBe(b.body.jobId);
      expect(await counts(key)).toEqual({ jobs: 2, attempts: 2, outbox: 2 });
    });

    it("admits the trusted local board without fabricating a membership row", async () => {
      guard();
      const response = await request(localBoardApp).post(route()).send(command("local-board"));
      expect(response.status).toBe(201);
      expect(await counts("local-board")).toEqual({ jobs: 1, attempts: 1, outbox: 1 });
    });

    it("revalidates an authenticated MCP key inside the tenant transaction", async () => {
      guard();
      const response = await request(app)
        .post(route())
        .set("authorization", `Bearer ${MCP_TOKEN_A}`)
        .send(command("mcp-key", SOURCE_CASES[2]));
      expect(response.status).toBe(201);
      expect(await counts("mcp-key")).toEqual({ jobs: 1, attempts: 1, outbox: 1 });
    });

    it("admits a same-company Commander run JWT inside the tenant transaction", async () => {
      guard();
      const source = SOURCE_CASES[1];
      const token = createCommanderRunJwt({
        companyId: COMPANY_A,
        userId: USER_A,
        userRole: "founder",
        conversationId: source.conversationId,
        turnId: source.internalAgentRunId,
      });
      expect(token).toEqual(expect.any(String));
      const response = await request(app)
        .post(route())
        .set("authorization", `Bearer ${token}`)
        .send(command("commander-jwt", source));
      expect(response.status).toBe(201);
      expect(await counts("commander-jwt")).toEqual({ jobs: 1, attempts: 1, outbox: 1 });
    });

    it("does not mount the distributed job route while the flag is off", async () => {
      guard();
      const response = await request(flagOffApp).post(route()).set(asUser()).send(command("flag-off"));
      expect(response.status).toBe(404);
      expect(await counts("flag-off")).toEqual({ jobs: 0, attempts: 0, outbox: 0 });
    });

    it("mounts worker control only while distributed execution is enabled", async () => {
      guard();
      const flagOn = await request(app).post("/api/worker-control/enroll").send({});
      const flagOff = await request(flagOffApp).post("/api/worker-control/enroll").send({});
      expect(flagOn.status).toBe(401);
      expect(flagOff.status).toBe(404);
    });

    // ── BRW-003d-1 — the parser cliff, proven against the REAL app ──────────
    // The unit tier proves the mechanism; only this tier proves app.ts actually
    // wires it on the real URL. A mount whose path never matches would satisfy
    // every other assertion in this ticket while parsing nothing.
    it("accepts a legal event batch that the express default refused", async () => {
      guard();
      // ~200 KB: ~2x express's 100 KB default and ~21x INSIDE the frozen 4 MiB
      // event_upload ceiling. Before the scoped mount this died in body-parser
      // as 413 {error:"request entity too large"} — a plain object no worker
      // client can classify, on an operation whose retry rule is
      // `idempotent_retry` over a CLOSED error vocabulary.
      const response = await request(app)
        .post("/api/worker-control/events")
        .send({ p: "x".repeat(200_000) });
      // Reaching the handler is the point. The body is junk, so the handler
      // answers `malformed` — but it answers in the PROTOCOL's shape.
      expect(response.status).toBe(400);
      expect(response.body.protocolVersion).toBe(1);
      expect(response.body.code).toBe("malformed");
    });

    it("fires the event_upload ceiling guard that was provably dead", async () => {
      guard();
      // Above the frozen 4 MiB contract ceiling but below the mount's headroom.
      // This band could not be reached at all before: express rejected at
      // 102,400 bytes, so `rawBody.length > 4 MiB` was false by construction and
      // the guard at worker-control.ts:442 could never evaluate true.
      const over = OPERATION_DESCRIPTORS.event_upload.maxRequestBytes + 10_000;
      const response = await request(app)
        .post("/api/worker-control/events")
        .send({ p: "x".repeat(over) });
      expect(response.body.code).toBe("payload_too_large");
      // NOT 413. `payload_too_large` is not in the 400/503/429/401 map, so it
      // takes the 409 fallthrough — the shape a worker can actually classify.
      expect(response.status).toBe(409);
    });

    it("refuses a compressed body on the real app", async () => {
      guard();
      // ★ THIS TEST EXISTS BECAUSE A MUTANT SURVIVED WITHOUT IT.
      // Deleting `inflate:` from the mount in app.ts left every other assertion
      // in this ticket green: the CONSTANT was guarded by the unit tier, but its
      // BINDING was not. With inflate on, body-parser skips the Content-Length
      // pre-check for a compressed body, so the limit bounds DECOMPRESSED bytes
      // and a few KB of gzip buys megabytes of pre-auth heap.
      const gz = gzipSync(Buffer.from(JSON.stringify({ p: "x".repeat(4_000_000) })));
      expect(gz.length).toBeLessThan(100_000); // the amplification is real
      const response = await request(app)
        .post("/api/worker-control/events")
        .set("content-type", "application/json")
        .set("content-encoding", "gzip")
        .send(gz);
      expect(response.status).toBe(415);
    });

    it("enforces the enrollment ceiling that nothing else enforces", async () => {
      guard();
      // enrollment is the only operation with no rawBody ceiling guard. While the
      // express default (102,400) sat below its 256 KiB contract, bounding happened
      // by ACCIDENT and was too strict. Raising the mount removed the accident, so
      // without an explicit guard a 262,145..327,680-byte enrollment body would be
      // accepted outright - on the unauthenticated pre-enrollment route.
      const over = OPERATION_DESCRIPTORS.enrollment.maxRequestBytes + 8_000;
      const response = await request(app)
        .post("/api/worker-control/enroll")
        .send({ p: "x".repeat(over) });
      expect(response.status).toBe(400);
      expect(response.body.protocolVersion).toBe(1);
      expect(response.body.code).toBe("malformed");
    });

    it("does not mount the raised limit while the flag is off", async () => {
      guard();
      // The gate is observable, so it is asserted rather than assumed. Middleware
      // runs before the 404 catch-all, so an UNGATED mount would parse the body
      // and then 404. A GATED one leaves the path on the express default, which
      // refuses first. 413 vs 404 is exactly the difference.
      const response = await request(flagOffApp)
        .post("/api/worker-control/events")
        .send({ p: "x".repeat(200_000) });
      expect(response.status).toBe(413);
    });

    it("lifts the PREFIX paths clear of the default too, not just /events", async () => {
      guard();
      // The prefix mount had no binding coverage: deleting it left every other
      // assertion in this ticket green. artifact_commit declares 256 KiB, so a
      // 200 KB body is legal for it and used to die at express's 102,400.
      const response = await request(app)
        .post("/api/worker-control/artifact-commits")
        .send({ p: "x".repeat(200_000) });
      expect(response.status).toBe(400);
      expect(response.body.protocolVersion).toBe(1);
      expect(response.body.code).toBe("malformed");
    });

    it("★ refuses an oversized artifact_commit TERMINALLY, not with a retryable 503", async () => {
      guard();
      // THE REGRESSION THIS TICKET ALMOST SHIPPED.
      // Raising the mount is what makes this guard live for the first time — and
      // worker-control.ts emitted `payload_too_large` for artifact_commit, which
      // is NOT in that operation's frozen vocabulary. The envelope builder throws
      // on an out-of-vocabulary code, the route's own catch swallows it, and the
      // fallthrough answers `internal_unavailable` → 503 WITH a bounded
      // retryAfterMs. artifact_commit is `idempotent_retry`, so a body that can
      // never succeed would have been retried forever — strictly worse than the
      // terminal 413 it replaced.
      const over = OPERATION_DESCRIPTORS.artifact_commit.maxRequestBytes + 8_000;
      const response = await request(app)
        .post("/api/worker-control/artifact-commits")
        .send({ p: "x".repeat(over) });
      expect(response.body.code).not.toBe("internal_unavailable");
      expect(response.body.code).toBe("malformed");
      expect(response.status).toBe(400);
      expect(response.body.retryAfterMs).toBeNull();
    });

    it("refuses a compressed body on the PREFIX mount as well", async () => {
      guard();
      const gz = gzipSync(Buffer.from(JSON.stringify({ p: "x".repeat(4_000_000) })));
      const response = await request(app)
        .post("/api/worker-control/artifact-commits")
        .set("content-type", "application/json")
        .set("content-encoding", "gzip")
        .send(gz);
      expect(response.status).toBe(415);
    });

    it("scopes the raise to the worker-control subtree exactly", async () => {
      guard();
      // The PAIR is what proves scoping; either half alone does not. A path one
      // character outside the prefix must still refuse what a path inside accepts.
      // (express requires a separator boundary, so `-not-a-real-path` does not
      // match the `/api/worker-control` mount.)
      const inside = await request(app)
        .post("/api/worker-control/artifact-commits")
        .send({ p: "x".repeat(200_000) });
      const outside = await request(app)
        .post("/api/worker-control-not-a-real-path")
        .send({ p: "x".repeat(200_000) });
      expect(inside.status).not.toBe(413);
      expect(outside.status).toBe(413);
    });

    it("collapses 32 concurrent identical submissions to one aggregate", async () => {
      guard();
      const key = "concurrent-32";
      const responses = await Promise.all(
        Array.from({ length: 32 }, () => request(app).post(route()).set(asUser()).send(command(key))),
      );
      expect(new Set(responses.map((response) => response.body.jobId))).toHaveLength(1);
      expect(responses.filter((response) => response.body.replayed === false)).toHaveLength(1);
      expect(responses.every((response) => [200, 201].includes(response.status))).toBe(true);
      expect(await counts(key)).toEqual({ jobs: 1, attempts: 1, outbox: 1 });
    });

    it.each([
      ["task_run", SOURCE_CASES[0], asUser(), { kind: "founder", id: USER_A }],
      ["commander_turn", SOURCE_CASES[1], asCommander(), { kind: "commander", id: USER_A }],
      ["crew_run", SOURCE_CASES[2], asAgent(), { kind: "agent", id: AGENT_A }],
      ["one_shot", SOURCE_CASES[3], asAgent(), { kind: "agent", id: AGENT_A }],
      ["browser_request", SOURCE_CASES[4], asUser(), { kind: "founder", id: USER_A }],
    ] as const)("persists authenticated requester and frozen executor authority for %s", async (kind, source, headers, requester) => {
      guard();
      const response = await request(app)
        .post(route())
        .set(headers)
        .send(command(`source-${source.kind}`, source));
      expect(response.status).toBe(201);
      const [job] = await admin!<Record<string, unknown>[]>
        `SELECT * FROM jobs WHERE id = ${response.body.jobId}`;
      expect(job).toMatchObject({
        organization_id: ORG_A,
        company_id: COMPANY_A,
        source_kind: source.kind,
        requester_principal_kind: requester.kind,
        requester_principal_id: requester.id,
        executor_principal_kind: FROZEN_EXECUTOR_AUTHORITY[kind].kind,
        executor_principal_id: FROZEN_EXECUTOR_AUTHORITY[kind].id,
      });
      expect(job).toHaveProperty("input_hash");
      expect(job).toHaveProperty("policy_hash");
      expect(job).toHaveProperty("requirements");
      expect(job).toHaveProperty("placement_request");

      // BRW-001 — for a browser job, prove the PERSISTED workload is frozen-valid through
      // the real route and a real database. This is the end-to-end evidence that the
      // silent-non-lease is closed: `buildJobEnvelope` passes `job.input` straight through
      // as the workload, so if this parses, the envelope's workload parses.
      if (source.kind === "browser_request") {
        expect(browserWorkloadV1Schema.safeParse(job!.input).success).toBe(true);
        // Defaults were applied for the fields the caller omitted, and the caller's own
        // values survived.
        expect(job!.input).toMatchObject({
          engine: "chromium",
          locale: "en-GB",
          recordTrace: true,
          maxSessionSeconds: 600,
        });
      }
    });

    it("accepts service reconciliation only through a system principal and tenant-bound service generation", async () => {
      guard();
      const response = await jobSubmissionService(appConnection!.db).submit({
        organizationId: ORG_A,
        companyId: COMPANY_A,
        principal: { kind: "system", id: "service-reconciler" } as never,
        command: command("source-service_reconcile", SOURCE_CASES[5]) as never,
      });
      expect(response).toMatchObject({ status: "queued", replayed: false });
      expect(await counts("source-service_reconcile")).toEqual({ jobs: 1, attempts: 1, outbox: 1 });
      const [job] = await admin!<Record<string, unknown>[]>
        `SELECT * FROM jobs WHERE id = ${response.jobId}`;
      expect(job).toMatchObject({
        requester_principal_kind: "system",
        requester_principal_id: "service-reconciler",
        executor_principal_kind: "service_instance",
        executor_principal_id: SERVICE_A,
      });

      // SVC-001 - what is PERSISTED must satisfy the frozen schema, or the job would
      // submit with a 201 and then never lease.
      expect(serviceWorkloadV1Schema.safeParse(job!.input).success).toBe(true);

      // * SERVER-STAMPED IDENTITY, proven end to end. The fixture deliberately claims
      // SERVICE_DECOY / generation 99 while the source authorizes SERVICE_A / generation
      // 1, so these can only match if the server actually overwrote them. An earlier
      // version used the SAME values on both sides and passed with stamping completely
      // disabled - it was vacuous, and mutation testing is what exposed it.
      expect(job!.input).toMatchObject({ serviceId: SERVICE_A, generation: 1 });
      expect((job!.input as Record<string, unknown>).serviceId).not.toBe(SERVICE_DECOY);
    });

    it("enforces the frozen hostile source/caller authority matrix before persistence", async () => {
      guard();
      const callers = [
        { name: "user", headers: asUser(), requester: { kind: "founder", id: USER_A }, allowed: new Set(["task_run", "commander_turn", "crew_run", "browser_request"]) },
        { name: "agent", headers: asAgent(), requester: { kind: "agent", id: AGENT_A }, allowed: new Set(["task_run", "crew_run", "one_shot", "browser_request"]) },
        { name: "mcp_user", headers: asMcp(), requester: { kind: "founder", id: USER_A }, allowed: new Set(["task_run", "commander_turn", "crew_run", "browser_request"]) },
        { name: "commander", headers: asCommander(), requester: { kind: "commander", id: USER_A }, allowed: new Set(["commander_turn", "one_shot"]) },
      ];
      for (const caller of callers) {
        for (const source of SOURCE_CASES) {
          const key = `matrix-${caller.name}-${source.kind}`;
          const response = await request(app).post(route()).set(caller.headers).send(command(key, source));
          const allowed = caller.allowed.has(source.kind);
          expect(response.status, `${caller.name}/${source.kind}`).toBe(allowed ? 201 : 403);
          expect(await counts(key), `${caller.name}/${source.kind} persistence`).toEqual(
            allowed ? { jobs: 1, attempts: 1, outbox: 1 } : { jobs: 0, attempts: 0, outbox: 0 },
          );
          if (allowed) {
            const [job] = await admin!<Record<string, unknown>[]>
              `SELECT * FROM jobs WHERE id = ${response.body.jobId}`;
            expect(job, `${caller.name}/${source.kind} immutable authority`).toMatchObject({
              requester_principal_kind: caller.requester.kind,
              requester_principal_id: caller.requester.id,
              executor_principal_kind: FROZEN_EXECUTOR_AUTHORITY[source.kind].kind,
              executor_principal_id: FROZEN_EXECUTOR_AUTHORITY[source.kind].id,
            });
          }
        }
      }
    });

    it("binds Commander DTO identifiers to JWT claims and tenant-bound turn state", async () => {
      guard();
      const mismatched = {
        ...SOURCE_CASES[1],
        internalAgentRunId: "60000000-0000-4000-8000-000000000099",
      };
      const response = await request(app)
        .post(route())
        .set(asCommander())
        .send(command("commander-claim-mismatch", mismatched));
      expect(response.status).toBe(403);
      expect(await counts("commander-claim-mismatch")).toEqual({ jobs: 0, attempts: 0, outbox: 0 });
    });

    it.each([
      ["crew", { kind: "crew_run", crewRunId: "80000000-0000-4000-8000-000000000099" }, asAgent()],
      ["browser", { kind: "browser_request", browserRequestId: "a0000000-0000-4000-8000-000000000099", parentJobId: null }, asUser()],
    ] as const)("rejects an unbound %s identity", async (name, source, headers) => {
      guard();
      const key = `${name}-identity-mismatch`;
      const response = await request(app).post(route()).set(headers).send(command(key, source));
      expect(response.status).toBe(403);
      expect(await counts(key)).toEqual({ jobs: 0, attempts: 0, outbox: 0 });
    });

    it("rejects a stale service generation before persistence", async () => {
      guard();
      await expect(jobSubmissionService(appConnection!.db).submit({
        organizationId: ORG_A,
        companyId: COMPANY_A,
        principal: { kind: "system", id: "service-reconciler" } as never,
        command: command("service-stale-generation", { ...SOURCE_CASES[5], generation: 2 }) as never,
      })).rejects.toMatchObject({ name: "TenantAdmissionDeniedError" });
      expect(await counts("service-stale-generation")).toEqual({ jobs: 0, attempts: 0, outbox: 0 });
    });

    it.each(["jobs", "job_attempts", "job_outbox"] as const)(
      "rolls back the complete aggregate when the %s statement fails",
      async (table) => {
        guard();
        const key = `rollback-${table}`;
        await installFailureTrigger(table);
        const response = await request(app).post(route()).set(asUser()).send(command(key));
        expect(response.status).toBe(500);
        expect(await counts(key)).toEqual({ jobs: 0, attempts: 0, outbox: 0 });
      },
    );

    it("emits only stable identifier metadata when a submission transaction fails", async () => {
      guard();
      const before = await flushCapturedLogs();
      const marker = "H01_PRIVATE_INPUT_SENTINEL";
      await installFailureTrigger("jobs");
      const response = await request(app).post(route()).set(asUser()).send(command("log-sanitize", SOURCE_CASES[0], marker));
      expect(response.status).toBe(500);
      const emitted = (await flushCapturedLogs()).slice(before.length);
      expect(emitted).toContain("job_submission_internal_error");
      expect(emitted).toContain(ORG_A);
      expect(emitted).toContain(COMPANY_A);
      expect(emitted).toContain("task_run");
      expect(emitted).not.toContain(marker);
      expect(emitted).not.toContain("source_intent");
      expect(emitted).not.toContain("INSERT INTO \"jobs\"");
      expect(emitted).not.toContain("query:");
      expect(emitted).not.toContain("params:");
      expect(emitted).not.toContain("stack:");
    });

    it("denies requester/assignee mismatch uniformly before persistence", async () => {
      guard();
      const body = command("assignee-mismatch", {
        kind: "task_run", runId: RUN_A, issueId: ISSUE_A, assigneeAgentId: AGENT_B,
      });
      const response = await request(app).post(route()).set("x-aoa-run-id", RUN_A).send(body);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "Job submission denied" });
      expect(await counts("assignee-mismatch")).toEqual({ jobs: 0, attempts: 0, outbox: 0 });
    });

    it("denies a task source whose issue is not checked out to the claimed run and assignee", async () => {
      guard();
      const body = command("issue-source-mismatch", {
        kind: "task_run", runId: RUN_A, issueId: ISSUE_B, assigneeAgentId: AGENT_A,
      });
      const response = await request(app).post(route()).set(asUser()).send(body);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "Job submission denied" });
      expect(await counts("issue-source-mismatch")).toEqual({ jobs: 0, attempts: 0, outbox: 0 });
    });

    it.each([
      ["sentinel-org", "00000000-0000-0000-0000-000000000001", COMPANY_A],
      ["nonexistent-org", "d0000000-0000-4000-8000-000000000001", COMPANY_A],
      ["foreign-company", ORG_A, COMPANY_B],
    ])("denies %s with one response and no persistence", async (key, organizationId, companyId) => {
      guard();
      const response = await request(app)
        .post(route(organizationId, companyId))
        .set(asUser())
        .send(command(key));
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "Job submission denied" });
      expect(await counts(key)).toEqual({ jobs: 0, attempts: 0, outbox: 0 });
    });

    it("does not expose an existing submission through a cross-Organization replay", async () => {
      guard();
      const body = command("h01-cross-org-replay");
      const accepted = await request(app).post(route()).set(asUser()).send(body);
      expect(accepted.status).toBe(201);
      const denied = await request(app).post(route(ORG_B, COMPANY_A)).set(asUser()).send(body);
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: "Job submission denied" });
      expect(await counts("h01-cross-org-replay")).toEqual({ jobs: 1, attempts: 1, outbox: 1 });
    });

    it("rejects malformed and server-authoritative delivery fields", async () => {
      guard();
      const malformed = await request(app).post(route()).set(asUser()).send({
        ...command("malformed"),
        jobId: "e0000000-0000-4000-8000-000000000001",
      });
      expect(malformed.status).toBe(400);
      expect(await counts("malformed")).toEqual({ jobs: 0, attempts: 0, outbox: 0 });
    });

    it("persists one identifier-only ready outbox and creates no lease or adapter effect", async () => {
      guard();
      const response = await request(app).post(route()).set(asUser()).send(command("no-contact"));
      expect(response.status).toBe(201);
      const [outbox] = await admin!<{ kind: string; payload: Record<string, unknown> }[]>`
        SELECT kind, payload FROM job_outbox WHERE job_id = ${response.body.jobId}
      `;
      expect(outbox?.kind).toBe("attempt_ready");
      expect(Object.keys(outbox?.payload ?? {}).sort()).toEqual([
        "attemptId", "companyId", "jobId", "organizationId", "sourceKind",
      ]);
      const [leaseCount] = await admin!<{ count: number }[]>`
        SELECT count(*)::int AS count FROM leases WHERE attempt_id = ${response.body.attemptId}
      `;
      expect(leaseCount?.count).toBe(0);
    });

    it("[I-01] carries every real submitted source through the JOB-009 production normalizer and placement service", async () => {
      guard();
      const normalize = (placementNamespace as unknown as Record<string, unknown>).normalizeSubmittedJobPlacementFacts;
      const place = (placementNamespace as unknown as Record<string, unknown>).placeJobAttempt;
      expect(typeof normalize, "JOB-009 must normalize the exact JOB-001 persisted contract").toBe("function");
      expect(typeof place).toBe("function");
      if (typeof normalize !== "function" || typeof place !== "function") return;

      for (const source of SOURCE_CASES) {
        const key = `job009-real-${source.kind}`;
        const submitted = source.kind === "service_reconcile"
          ? await jobSubmissionService(appConnection!.db).submit({
              organizationId: ORG_A,
              companyId: COMPANY_A,
              principal: { kind: "system", id: "service-reconciler" } as never,
              command: command(key, source) as never,
            })
          : await request(app)
              .post(route())
              .set(source.kind === "commander_turn" ? asCommander(source) :
                source.kind === "crew_run" || source.kind === "one_shot" ? asAgent() : asUser())
              .send(command(key, source))
              .then((response) => {
                expect(response.status, source.kind).toBe(201);
                return response.body as { jobId: string; attemptId: string };
              });
        const [job] = await admin!<{
          input_hash: string;
          policy_hash: string;
          source_kind: string;
          requirements: Record<string, unknown>;
          placement_request: Record<string, unknown>;
        }[]>`SELECT input_hash, policy_hash, source_kind, requirements, placement_request
            FROM jobs WHERE id = ${submitted.jobId}`;
        expect(await (normalize as (input: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>)({
          sourceKind: job!.source_kind,
          inputHash: job!.input_hash,
          policyHash: job!.policy_hash,
          requirements: job!.requirements,
          placementRequest: job!.placement_request,
          rollout: { enabled: false, mode: "legacy", reason: "deployment_disabled" },
          credentialBinding: {
            credentialId: null,
            credentialKind: null,
            executionTargetSlug: null,
            pinnedTargetId: null,
          },
          resolvedTarget: null,
        })).toMatchObject({ success: true });
        await expect((place as (input: unknown) => Promise<unknown>)({
          appDb: appConnection!.db,
          operatorDb: { transaction: () => { throw new Error("flag_off_operator_contact"); } },
          organizationId: ORG_A,
          companyId: COMPANY_A,
          jobId: submitted.jobId,
          attemptId: submitted.attemptId,
          rollout: { enabled: false, mode: "legacy", reason: "deployment_disabled" },
          now: new Date("2026-08-10T10:00:05.000Z"),
          maxHeartbeatAgeMs: 30_000,
        })).resolves.toMatchObject({ disposition: "legacy", leaseEligible: false });
      }

      const malformed = await request(app).post(route()).set(asUser()).send(command("job009-malformed"));
      expect(malformed.status).toBe(201);
      await admin!`UPDATE jobs SET requirements = ${{ workloadType: "batch", requiredCapabilities: "tampered" }}
        WHERE id = ${malformed.body.jobId}`;
      await expect((place as (input: unknown) => Promise<Record<string, unknown>>)({
        appDb: appConnection!.db,
        operatorDb: { transaction: () => { throw new Error("flag_off_operator_contact"); } },
        organizationId: ORG_A,
        companyId: COMPANY_A,
        jobId: malformed.body.jobId,
        attemptId: malformed.body.attemptId,
        rollout: { enabled: false, mode: "legacy", reason: "deployment_disabled" },
        now: new Date("2026-08-10T10:00:05.000Z"),
        maxHeartbeatAgeMs: 30_000,
      })).resolves.toMatchObject({ disposition: "failed", reasonCode: "invalid_placement_input" });
    });
  },
);
