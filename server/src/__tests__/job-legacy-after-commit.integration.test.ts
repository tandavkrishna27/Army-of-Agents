// JOB-010 (plan T2) — legacy-bridge after-commit + single-release proofs (embedded PG;
// Linux CI is the formal authority, SKIPPED locally on Windows unless
// AOA_RUN_WIN_INTEGRATION=1). This file is shared with the JOB-011..014 parity bridges;
// JOB-010 lands the task_run checkout proofs.
//
// The bridge drives `issueService.checkout` INSIDE its authoritative tenant transaction.
// checkout's live `issue.status_changed` publish is staged into an after-commit sink and
// drained ONLY after the tx commits — so a rollback fires NO publication, and a committed
// submission publishes exactly once. The run-guarded release releases exactly once.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import {
  applyPendingMigrations,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { provisionTenantAppRoleLoginSql, TENANT_APP_ROLE } from "../db/rls-tenant.js";

// Spy on the ONLY live-event checkout publishes, preserving every other export. The
// JOB-011 approval bridge stages a generic `publishLiveEvent` poke into its own
// after-commit sink; a second spy proves that sink fires once on commit / zero on rollback.
const { publishSpy, liveEventSpy } = vi.hoisted(() => ({ publishSpy: vi.fn(), liveEventSpy: vi.fn() }));
vi.mock("../services/live-events.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/live-events.js")>();
  return {
    ...actual,
    publishIssueStatusChanged: (...args: unknown[]) =>
      (publishSpy as (...a: unknown[]) => void)(...args),
    publishLiveEvent: (...args: unknown[]) =>
      (liveEventSpy as (...a: unknown[]) => void)(...args),
  };
});

const { jobAdmissionBridge } = await import("../services/job-admission-bridge.js");
type BridgeActor = import("../services/job-admission-bridge.js").BridgeActor;

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const APP_PASSWORD = "job010-aftercommit-app-password";
const ORG = "10b00000-0000-4000-8000-000000000001";
const COMPANY = "20b00000-0000-4000-8000-000000000001";
const USER = "job010-aftercommit-user";
const AGENT_A = "30b00000-0000-4000-8000-000000000001";

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let admin: Sql | null = null;
let appConnection: NonOwnerDbConnection | null = null;
let setupError: unknown = null;

const ENABLED_ENV = { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" } as const;
function bridge() {
  return jobAdmissionBridge(appConnection!.db, { env: ENABLED_ENV });
}
const userActor: BridgeActor = { kind: "user", id: USER, companyId: COMPANY };

function guard(): void {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
}
async function jobCount(key: string): Promise<number> {
  const [row] = await admin!<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE idempotency_key = ${key}`;
  return row!.n;
}
async function issueRow(id: string) {
  const [row] = await admin!<{ status: string; checkout_run_id: string | null }[]>`
    SELECT status, checkout_run_id FROM issues WHERE id = ${id}`;
  return row!;
}
async function seedRun(runId: string) {
  await admin!`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at)
    VALUES (${runId}, ${COMPANY}, ${AGENT_A}, 'running', now())`;
}
async function seedFreshIssue(id: string) {
  await admin!`INSERT INTO issues (id, company_id, title, status, updated_at)
    VALUES (${id}, ${COMPANY}, 'after-commit task', 'todo', now())`;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-job010-aftercommit-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
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
    appConnection = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${APP_PASSWORD}`), { max: 8 });

    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'AfterCommit Org', 'aftercommit-org')`;
    await admin`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${COMPANY}, 'AfterCommit Co', 'ACC', ${ORG})`;
    await admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${USER}, 'AC User', 'ac@example.test', true, now(), now())`;
    await admin`INSERT INTO organization_memberships (organization_id, user_id, role, status)
      VALUES (${ORG}, ${USER}, 'owner', 'active')`;
    await admin`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
      VALUES (${COMPANY}, 'user', ${USER}, 'active', 'owner')`;
    await admin`INSERT INTO agents (id, company_id, name, kind, status, adapter_type, adapter_config)
      VALUES (${AGENT_A}, ${COMPANY}, 'AC Agent', 'org', 'idle', 'http', ${admin.json({ url: "http://127.0.0.1:1/x" })})`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

beforeEach(() => {
  publishSpy.mockClear();
});

afterAll(async () => {
  try { await appConnection?.close({ timeoutSeconds: 5 }); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-010 legacy bridge after-commit + single release",
  () => {
    it("publishes issue.status_changed exactly once AFTER the submission commits", async () => {
      guard();
      const run = randomUUID();
      const issue = randomUUID();
      await seedRun(run);
      await seedFreshIssue(issue);

      const result = await bridge().admitAndSubmit(
        { kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A }, userActor, "ac-success",
      );
      expect(result.replayed).toBe(false);
      // The job committed AND the publish fired exactly once with the durable identity.
      expect(await jobCount("ac-success")).toBe(1);
      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(publishSpy).toHaveBeenCalledWith(COMPANY, issue, "in_progress");
      expect((await issueRow(issue)).checkout_run_id).toBe(run);
    });

    it("fires NO publication when the authoritative transaction rolls back", async () => {
      guard();
      const run = randomUUID();
      const issue = randomUUID();
      await seedRun(run);
      await seedFreshIssue(issue);
      // Force the submission INSERT to fail AFTER checkout has staged its publish.
      await admin!.unsafe(`
        CREATE OR REPLACE FUNCTION ac_fail_jobs() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'forced jobs failure'; END $$;
        DROP TRIGGER IF EXISTS ac_fail_jobs_trg ON jobs;
        CREATE TRIGGER ac_fail_jobs_trg BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION ac_fail_jobs();
      `);
      try {
        await expect(
          bridge().admitAndSubmit({ kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A }, userActor, "ac-rollback"),
        ).rejects.toThrow();
      } finally {
        await admin!.unsafe(`DROP TRIGGER IF EXISTS ac_fail_jobs_trg ON jobs`);
      }
      // The rollback un-claimed the issue AND the deferred publish never fired.
      expect(await jobCount("ac-rollback")).toBe(0);
      const after = await issueRow(issue);
      expect(after.status).toBe("todo");
      expect(after.checkout_run_id).toBeNull();
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it("releases the existing authoritative claim exactly once (run-guarded single winner)", async () => {
      guard();
      const run = randomUUID();
      const issue = randomUUID();
      await seedRun(run);
      await seedFreshIssue(issue);
      await bridge().admitAndSubmit(
        { kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A }, userActor, "ac-release",
      );
      expect((await issueRow(issue)).checkout_run_id).toBe(run);

      // A foreign run cannot release the claim; only the checkout run may.
      const foreignRun = randomUUID();
      await expect(
        bridge().releaseTaskClaim({ kind: "task_run", runId: foreignRun, issueId: issue, assigneeAgentId: AGENT_A }, userActor),
      ).rejects.toThrow(/checkout run can release/i);
      expect((await issueRow(issue)).checkout_run_id).toBe(run);

      const released = await bridge().releaseTaskClaim(
        { kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A }, userActor,
      );
      expect(released.released).toBe(true);
      const after = await issueRow(issue);
      expect(after.status).toBe("todo");
      expect(after.checkout_run_id).toBeNull();
    });

    it("does not publish for a non-task source (no fabricated task identity)", async () => {
      guard();
      // crew_run carries no issue identity; the bridge admits + submits but drives no
      // checkout and therefore publishes no issue.status_changed.
      const crewRunId = randomUUID();
      await admin!`INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source, status, user_id, agent_id)
        VALUES (${crewRunId}, ${COMPANY}, 'sub_agent', 'crew_dispatch', 'running', ${USER}, ${AGENT_A})`;
      const result = await bridge().admitAndSubmit(
        { kind: "crew_run", crewRunId }, userActor, "ac-crew",
      );
      expect(result.replayed).toBe(false);
      expect(await jobCount("ac-crew")).toBe(1);
      expect(publishSpy).not.toHaveBeenCalled();
    });
  },
);

// JOB-011 — the approval bridge's after-commit sink fires its live poke ONLY after the
// authoritative tenant transaction commits, and fires NOTHING on rollback. Uses its own
// job-control fixture (an active fence is required to link a governance receipt).
describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-011 approval bridge after-commit + rollback",
  () => {
    let f: import("./helpers/job-control-fixture.js").JobControlFixture | null = null;
    let fErr: unknown = null;
    const J11_AGENT = "a6000000-0000-4000-8000-0000000000b1";
    const J11_USER = "job011-ac-user";

    beforeAll(async () => {
      try {
        const { setupJobControlFixture, COMPANY: FCO } = await import("./helpers/job-control-fixture.js");
        f = await setupJobControlFixture("job011-aftercommit");
        await f.admin`INSERT INTO agents (id, company_id, name, kind, status, adapter_type, adapter_config)
          VALUES (${J11_AGENT}, ${FCO}, 'J011 AC Agent', 'org', 'idle', 'claude_local', ${f.admin.json({})})`;
        await f.admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
          VALUES (${J11_USER}, 'J011 AC User', 'j011ac@example.test', true, now(), now())`;
        await f.admin`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
          VALUES (${FCO}, 'user', ${J11_USER}, 'active', 'owner')`;
      } catch (error) {
        fErr = error;
      }
    }, 180_000);

    afterAll(async () => { await f?.teardown().catch(() => {}); }, 60_000);

    beforeEach(() => { liveEventSpy.mockClear(); });

    it("fires the live poke exactly once AFTER the governance transaction commits", async () => {
      if (fErr) throw new Error(`fixture setup failed: ${String(fErr)}`);
      const { jobApprovalBridge } = await import("../services/job-approval-bridge.js");
      const { COMPANY: FCO } = await import("./helpers/job-control-fixture.js");
      const { identity: fence } = await f!.activateLease(1);
      const runId = randomUUID();
      await f!.admin`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at)
        VALUES (${runId}, ${FCO}, ${J11_AGENT}, 'running', now())`;
      const bridge = jobApprovalBridge(f!.app.db, { env: { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" } });
      const out = await bridge.openGovernedDecision({
        source: { kind: "task_run", runId: "seed", issueId: "seed", assigneeAgentId: J11_AGENT },
        actor: { kind: "user", id: J11_USER, companyId: FCO },
        fence, idempotencyKey: randomUUID(),
        runtimeDecision: {
          agentId: J11_AGENT, runId, adapterType: "claude_local", kind: "work_question",
          nonce: randomUUID(), title: "AC?", promptText: "?", options: [], timeoutPolicy: "cancel_run",
        },
      });
      expect(out.status).toBe("created");
      expect(liveEventSpy).toHaveBeenCalledTimes(1);
    });

    it("fires NOTHING when the governance transaction rolls back", async () => {
      if (fErr) throw new Error(`fixture setup failed: ${String(fErr)}`);
      const { jobApprovalBridge } = await import("../services/job-approval-bridge.js");
      const { COMPANY: FCO } = await import("./helpers/job-control-fixture.js");
      const { identity: fence } = await f!.activateLease(2);
      const runId = randomUUID();
      await f!.admin`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at)
        VALUES (${runId}, ${FCO}, ${J11_AGENT}, 'running', now())`;
      await f!.admin.unsafe(`
        CREATE OR REPLACE FUNCTION j011ac_fail() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'forced receipt failure'; END $$;
        DROP TRIGGER IF EXISTS j011ac_fail_trg ON job_projection_receipts;
        CREATE TRIGGER j011ac_fail_trg BEFORE INSERT ON job_projection_receipts
          FOR EACH ROW EXECUTE FUNCTION j011ac_fail();
      `);
      const bridge = jobApprovalBridge(f!.app.db, { env: { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" } });
      try {
        await expect(
          bridge.openGovernedDecision({
            source: { kind: "task_run", runId: "seed", issueId: "seed", assigneeAgentId: J11_AGENT },
            actor: { kind: "user", id: J11_USER, companyId: FCO },
            fence, idempotencyKey: randomUUID(),
            runtimeDecision: {
              agentId: J11_AGENT, runId, adapterType: "claude_local", kind: "work_question",
              nonce: randomUUID(), title: "AC rollback", promptText: "?", options: [], timeoutPolicy: "cancel_run",
            },
          }),
        ).rejects.toThrow();
      } finally {
        await f!.admin.unsafe(`DROP TRIGGER IF EXISTS j011ac_fail_trg ON job_projection_receipts`);
      }
      // The deferred poke is staged INSIDE the tx callback but drained only after commit;
      // the throw aborts before the drain, so nothing fires.
      expect(liveEventSpy).not.toHaveBeenCalled();
    });
  },
);
