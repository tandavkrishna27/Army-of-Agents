// JOB-010 — legacy admission/assignment parity (embedded PG; Linux CI is the formal
// authority, SKIPPED locally on Windows unless AOA_RUN_WIN_INTEGRATION=1).
//
// The eight cases prove the bridge drives the SAME as-built checkout engine and honours
// every admission/assignment invariant: dependency reject-before-job, same-source replay,
// bounded stale adoption, assignee removal/reassignment fencing, status-gate, one-winner
// legacy/distributed race, cross-path duplicate-key dedupe, and failed-submission release.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { jobAdmissionBridge, type BridgeActor } from "../services/job-admission-bridge.js";
import { jobSubmissionService } from "../services/job-submission.js";
import { TenantAdmissionDeniedError } from "../services/tenant-admission.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const APP_PASSWORD = "job010-parity-app-password";
const ORG = "10a00000-0000-4000-8000-000000000001";
const COMPANY = "20a00000-0000-4000-8000-000000000001";
const USER = "job010-parity-user";
const AGENT_A = "30a00000-0000-4000-8000-000000000001";
const AGENT_B = "30a00000-0000-4000-8000-000000000002";

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
  const [row] = await admin!<{ status: string; assignee_agent_id: string | null; checkout_run_id: string | null; execution_run_id: string | null; started_at: Date | null }[]>`
    SELECT status, assignee_agent_id, checkout_run_id, execution_run_id, started_at FROM issues WHERE id = ${id}
  `;
  return row!;
}
async function seedRun(runId: string, agentId: string, status = "running") {
  await admin!`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at)
    VALUES (${runId}, ${COMPANY}, ${agentId}, ${status}, now())`;
}
async function seedIssue(input: {
  id: string;
  status: string;
  assigneeAgentId?: string | null;
  checkoutRunId?: string | null;
  executionRunId?: string | null;
}) {
  await admin!`INSERT INTO issues (id, company_id, title, status, assignee_agent_id, checkout_run_id, execution_run_id, updated_at)
    VALUES (${input.id}, ${COMPANY}, 'parity task', ${input.status},
      ${input.assigneeAgentId ?? null}, ${input.checkoutRunId ?? null}, ${input.executionRunId ?? null}, now())`;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-job010-parity-"));
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
    admin = postgres(adminUrl, { max: 6 });
    await admin.unsafe(provisionTenantAppRoleLoginSql(TENANT_APP_ROLE, APP_PASSWORD));
    appConnection = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${APP_PASSWORD}`), { max: 12 });

    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Parity Org', 'parity-org')`;
    await admin`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${COMPANY}, 'Parity Co', 'PAR', ${ORG})`;
    await admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${USER}, 'Parity User', 'parity@example.test', true, now(), now())`;
    await admin`INSERT INTO organization_memberships (organization_id, user_id, role, status)
      VALUES (${ORG}, ${USER}, 'owner', 'active')`;
    await admin`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
      VALUES (${COMPANY}, 'user', ${USER}, 'active', 'owner')`;
    await admin`INSERT INTO agents (id, company_id, name, kind, status, adapter_type, adapter_config)
      VALUES
        (${AGENT_A}, ${COMPANY}, 'Agent A', 'org', 'idle', 'http', ${admin.json({ url: "http://127.0.0.1:1/x" })}),
        (${AGENT_B}, ${COMPANY}, 'Agent B', 'org', 'idle', 'http', ${admin.json({ url: "http://127.0.0.1:1/x" })})`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await appConnection?.close({ timeoutSeconds: 5 }); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  try { await embedded?.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-010 admission/assignment parity",
  () => {
    it("[1] rejects a task with an unmet dependency BEFORE any job row", async () => {
      guard();
      const run = randomUUID();
      const issue = randomUUID();
      const dep = randomUUID();
      const key = "parity-unmet-dep";
      await seedRun(run, AGENT_A);
      await seedIssue({ id: issue, status: "todo" });
      await seedIssue({ id: dep, status: "todo" }); // non-terminal upstream → unmet
      await admin!`INSERT INTO task_dependencies (company_id, dependent_issue_id, dependency_issue_id)
        VALUES (${COMPANY}, ${issue}, ${dep})`;

      await expect(
        bridge().admitAndSubmit({ kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A }, userActor, key),
      ).rejects.toThrow(/unmet dependencies/i);

      expect(await jobCount(key)).toBe(0);
      const after = await issueRow(issue);
      expect(after.status).toBe("todo");
      expect(after.checkout_run_id).toBeNull();
    });

    it("[2] replays the same source without a second checkout or job", async () => {
      guard();
      const run = randomUUID();
      const issue = randomUUID();
      const key = "parity-replay";
      await seedRun(run, AGENT_A);
      await seedIssue({ id: issue, status: "todo" });
      const source = { kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A } as const;

      const first = await bridge().admitAndSubmit(source, userActor, key);
      expect(first.replayed).toBe(false);
      const afterFirst = await issueRow(issue);
      const replay = await bridge().admitAndSubmit(source, userActor, key);
      expect(replay.replayed).toBe(true);
      expect(replay.jobId).toBe(first.jobId);
      expect(await jobCount(key)).toBe(1);
      const afterReplay = await issueRow(issue);
      expect(afterReplay.execution_run_id).toBe(run);
      // The replay must NOT re-run checkout: started_at is stable (checkout sets it to now
      // unconditionally, so a re-fire would reset it forward) — proving the idempotent
      // fast-path skipped the non-idempotent checkout on redelivery.
      expect(afterReplay.started_at).toEqual(afterFirst.started_at);
    });

    // CLI-006 (D3a) — the canary path submits LATE, after the HARNESS has already
    // checked the run out (the immutable envelope carries the run's context as
    // artifacts, so it cannot be built at the CLI-005 seam). Re-driving checkout
    // here would reset `started_at` and re-broadcast, checking the run out twice —
    // the Invariant 3 break CLI-005's review caught for active mode.
    it("[2b] skips checkout when THIS run already owns it (CLI-006 late submit)", async () => {
      guard();
      const run = randomUUID();
      const issue = randomUUID();
      await seedRun(run, AGENT_A);
      // Exactly the state the harness checkout leaves behind.
      await seedIssue({
        id: issue,
        status: "in_progress",
        assigneeAgentId: AGENT_A,
        checkoutRunId: run,
        executionRunId: run,
      });
      const before = await issueRow(issue);
      const source = { kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A } as const;

      const response = await bridge().admitAndSubmit(source, userActor, "parity-late-submit");
      expect(response.replayed).toBe(false);
      expect(response.jobId).toBeTruthy();

      const after = await issueRow(issue);
      // The single load-bearing assertion: no second checkout. `checkout` sets
      // started_at to now unconditionally, so a stable value proves it did not fire.
      expect(after.started_at).toEqual(before.started_at);
      expect(after.checkout_run_id).toBe(run);
      expect(after.execution_run_id).toBe(run);
    });

    // The bypass must never ADMIT something admission would reject: it is gated on
    // the same predicate `submitJobWithinTenant` admits on, so a run that does NOT
    // own the checkout still goes through the real checkout engine and its gates.
    it("[2c] still drives checkout for a run that does NOT already own it", async () => {
      guard();
      const run = randomUUID();
      const issue = randomUUID();
      await seedRun(run, AGENT_A);
      await seedIssue({ id: issue, status: "todo" });
      const source = { kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A } as const;

      await bridge().admitAndSubmit(source, userActor, "parity-not-owned");

      const after = await issueRow(issue);
      expect(after.checkout_run_id).toBe(run);
      expect(after.execution_run_id).toBe(run);
      expect(after.status).toBe("in_progress");
    });

    it("[3] adopts a bounded stale checkout run (terminal/missing prior run)", async () => {
      guard();
      const oldRun = randomUUID(); // intentionally NOT seeded → missing → stale
      const newRun = randomUUID();
      const issue = randomUUID();
      const key = "parity-adopt";
      await seedRun(newRun, AGENT_A);
      await seedIssue({ id: issue, status: "in_progress", assigneeAgentId: AGENT_A, checkoutRunId: oldRun, executionRunId: oldRun });

      const result = await bridge().admitAndSubmit(
        { kind: "task_run", runId: newRun, issueId: issue, assigneeAgentId: AGENT_A }, userActor, key,
      );
      expect(result.replayed).toBe(false);
      const after = await issueRow(issue);
      expect(after.checkout_run_id).toBe(newRun);
      expect(after.execution_run_id).toBe(newRun);
      expect(await jobCount(key)).toBe(1);
    });

    it("[4] fences a losing attempt when the issue is checked out to another live run", async () => {
      guard();
      const winnerRun = randomUUID();
      const loserRun = randomUUID();
      const issue = randomUUID();
      const key = "parity-fence-loser";
      await seedRun(winnerRun, AGENT_A);
      await seedRun(loserRun, AGENT_A);
      // Winner already owns the issue on a LIVE (running) run.
      await seedIssue({ id: issue, status: "in_progress", assigneeAgentId: AGENT_A, checkoutRunId: winnerRun, executionRunId: winnerRun });

      await expect(
        bridge().admitAndSubmit({ kind: "task_run", runId: loserRun, issueId: issue, assigneeAgentId: AGENT_A }, userActor, key),
      ).rejects.toThrow(/checkout conflict|run ownership/i);
      expect(await jobCount(key)).toBe(0);
      // The winner's claim is untouched (loser permanently fenced).
      expect((await issueRow(issue)).checkout_run_id).toBe(winnerRun);
    });

    it("[4b] fences a losing attempt when the issue was reassigned to another agent", async () => {
      guard();
      const run = randomUUID();
      const issue = randomUUID();
      const key = "parity-reassigned";
      await seedRun(run, AGENT_A);
      // Reassigned to AGENT_B; the AGENT_A attempt must not steal it.
      await seedIssue({ id: issue, status: "in_progress", assigneeAgentId: AGENT_B, checkoutRunId: randomUUID(), executionRunId: randomUUID() });

      await expect(
        bridge().admitAndSubmit({ kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A }, userActor, key),
      ).rejects.toThrow(/checkout conflict|run ownership/i);
      expect(await jobCount(key)).toBe(0);
      expect((await issueRow(issue)).assignee_agent_id).toBe(AGENT_B);
    });

    it("[5] honours the expected-status gate (a terminal task is not checked out)", async () => {
      guard();
      const run = randomUUID();
      const issue = randomUUID();
      const key = "parity-status-gate";
      await seedRun(run, AGENT_A);
      await seedIssue({ id: issue, status: "done" }); // not in [todo,backlog,blocked,in_progress]

      await expect(
        bridge().admitAndSubmit({ kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A }, userActor, key),
      ).rejects.toThrow(/checkout conflict|run ownership/i);
      expect(await jobCount(key)).toBe(0);
      expect((await issueRow(issue)).status).toBe("done");
    });

    it("[6] resolves a concurrent legacy/distributed race to exactly one winner", async () => {
      guard();
      const runA = randomUUID();
      const runB = randomUUID();
      const issue = randomUUID();
      const keyA = "parity-race-a";
      const keyB = "parity-race-b";
      await seedRun(runA, AGENT_A);
      await seedRun(runB, AGENT_A);
      await seedIssue({ id: issue, status: "todo" });

      const results = await Promise.allSettled([
        bridge().admitAndSubmit({ kind: "task_run", runId: runA, issueId: issue, assigneeAgentId: AGENT_A }, userActor, keyA),
        bridge().admitAndSubmit({ kind: "task_run", runId: runB, issueId: issue, assigneeAgentId: AGENT_A }, userActor, keyB),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // Exactly one job total across both keys; the issue is checked out to the winner.
      expect((await jobCount(keyA)) + (await jobCount(keyB))).toBe(1);
      const after = await issueRow(issue);
      expect([runA, runB]).toContain(after.checkout_run_id);
    });

    it("[7] dedupes a legacy submission and a bridge submission via the shared composite", async () => {
      guard();
      const run = randomUUID();
      const issue = randomUUID();
      const key = "parity-cross-path";
      await seedRun(run, AGENT_A);
      // Legacy heartbeat already checked the issue out to the run before submitting.
      await seedIssue({ id: issue, status: "in_progress", assigneeAgentId: AGENT_A, checkoutRunId: run, executionRunId: run });
      const source = { kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A } as const;

      const legacy = await jobSubmissionService(appConnection!.db).submit({
        organizationId: ORG,
        companyId: COMPANY,
        principal: { kind: "user", id: USER },
        command: { idempotencyKey: key, source, input: { value: "x" } },
      });
      expect(legacy.replayed).toBe(false);

      const viaBridge = await bridge().admitAndSubmit(source, userActor, key, { value: "x" });
      expect(viaBridge.replayed).toBe(true);
      expect(viaBridge.jobId).toBe(legacy.jobId);
      expect(await jobCount(key)).toBe(1);
    });

    it("[8] releases the existing claim exactly once on a failed submission / explicit release", async () => {
      guard();
      // (a) A pre-commit submission failure rolls the checkout claim back atomically.
      const runFail = randomUUID();
      const issueFail = randomUUID();
      const keyFail = "parity-rollback-unclaim";
      await seedRun(runFail, AGENT_A);
      await seedIssue({ id: issueFail, status: "todo" });
      await admin!.unsafe(`
        CREATE OR REPLACE FUNCTION parity_fail_jobs() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'forced jobs failure'; END $$;
        DROP TRIGGER IF EXISTS parity_fail_jobs_trg ON jobs;
        CREATE TRIGGER parity_fail_jobs_trg BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION parity_fail_jobs();
      `);
      try {
        // The forced INSERT failure aborts the authoritative transaction; drizzle wraps
        // the "forced jobs failure" pg error. Any throw here proves the tx aborted — the
        // rollback effect (no job, issue un-claimed) below is the load-bearing assertion.
        await expect(
          bridge().admitAndSubmit({ kind: "task_run", runId: runFail, issueId: issueFail, assigneeAgentId: AGENT_A }, userActor, keyFail),
        ).rejects.toThrow();
      } finally {
        await admin!.unsafe(`DROP TRIGGER IF EXISTS parity_fail_jobs_trg ON jobs`);
      }
      expect(await jobCount(keyFail)).toBe(0);
      const rolledBack = await issueRow(issueFail);
      expect(rolledBack.status).toBe("todo");
      expect(rolledBack.checkout_run_id).toBeNull();

      // (b) The explicit run-guarded release is exactly-once: the owning run releases,
      // a foreign run is rejected (only the checkout run may release).
      const run = randomUUID();
      const issue = randomUUID();
      const key = "parity-explicit-release";
      await seedRun(run, AGENT_A);
      await seedIssue({ id: issue, status: "todo" });
      await bridge().admitAndSubmit({ kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A }, userActor, key);
      expect((await issueRow(issue)).checkout_run_id).toBe(run);

      const foreignRun = randomUUID();
      await expect(
        bridge().releaseTaskClaim({ kind: "task_run", runId: foreignRun, issueId: issue, assigneeAgentId: AGENT_A }, userActor),
      ).rejects.toThrow(/checkout run can release/i);

      const released = await bridge().releaseTaskClaim({ kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A }, userActor);
      expect(released.released).toBe(true);
      const afterRelease = await issueRow(issue);
      expect(afterRelease.status).toBe("todo");
      expect(afterRelease.checkout_run_id).toBeNull();
    });

    it("denies a sentinel/unmapped Organization uniformly before any job", async () => {
      guard();
      const run = randomUUID();
      const issue = randomUUID();
      await seedRun(run, AGENT_A);
      await seedIssue({ id: issue, status: "todo" });
      // A company that resolves to NO Organization edge (no company row) → unmapped →
      // opaque denial before any admission or legacy checkout effect.
      const unmappedCompany = randomUUID();
      await expect(
        bridge().admitAndSubmit(
          { kind: "task_run", runId: run, issueId: issue, assigneeAgentId: AGENT_A },
          { kind: "user", id: USER, companyId: unmappedCompany },
          "parity-unmapped",
        ),
      ).rejects.toBeInstanceOf(TenantAdmissionDeniedError);
      expect(await jobCount("parity-unmapped")).toBe(0);
    });
  },
);
