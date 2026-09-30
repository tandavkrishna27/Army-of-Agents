// JOB-013 — transactional activity/hub audit parity (embedded PG; Linux CI is the
// formal authority, SKIPPED locally on Windows unless AOA_RUN_WIN_INTEGRATION=1).
//
// The bridge projects ONE accepted state/control/accounting mutation into the EXISTING
// activity_log (+ optional hub_audit) AND a JOB-005 `activity_audit` projection receipt
// IN ONE tenant transaction; the live `activity.logged` event publishes ONLY AFTER the
// transaction commits. A worker OBSERVATION alone (poll→ack lifecycle) NEVER becomes an
// accepted product action — only a server-accepted mutation calls this bridge. Replay
// returns the already-linked activity WITHOUT re-inserting; a stale/rejected fence writes
// nothing; a mid-tx failure rolls back and publishes nothing. Flag-off touches nothing;
// the rollback gate fails closed while an `activity_audit` receipt is pending.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SubmitJobSource } from "@armyofagents/shared";
import {
  setupJobControlFixture,
  COMPANY,
  ORG,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";
import {
  jobAuditBridge,
  JobAuditBridgeDisabledError,
  JobAuditBridgeRollbackPendingError,
  type BridgeActor,
} from "../services/job-audit-bridge.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import type { LogActivityInput } from "../services/activity-log.js";

const ENABLED_ENV = { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" } as const;
const AGENT = "a7000000-0000-4000-8000-0000000000d1";
const USER = "job013-user";
const DIGEST = "a".repeat(64);
const actor: BridgeActor = { kind: "user", id: USER, companyId: COMPANY };

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

function bridge(env: Record<string, string | undefined> = ENABLED_ENV) {
  return jobAuditBridge(fixture!.app.db, { env });
}
function guard(): void {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
}
async function count(table: string, where: string): Promise<number> {
  const [row] = await fixture!.admin.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`);
  return (row as { n: number }).n;
}
function taskSource(agentId: string): SubmitJobSource {
  return { kind: "task_run", runId: randomUUID(), issueId: randomUUID(), assigneeAgentId: agentId };
}
const CREW_SOURCE: SubmitJobSource = { kind: "crew_run", crewRunId: randomUUID() };
const COMMANDER_SOURCE: SubmitJobSource = { kind: "commander_turn", internalAgentRunId: randomUUID(), conversationId: randomUUID() };

/** Build the EXISTING activity action the accepted mutation supplies. */
function activityInput(overrides: Partial<LogActivityInput> = {}): LogActivityInput {
  return {
    companyId: COMPANY,
    actorType: "agent",
    actorId: AGENT,
    action: "approval.created",
    entityType: "approval",
    entityId: randomUUID(),
    agentId: null,
    details: { note: "accepted-mutation" },
    ...overrides,
  };
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("job013-parity");
    await fixture.admin`INSERT INTO agents (id, company_id, name, kind, status, adapter_type, adapter_config)
      VALUES (${AGENT}, ${COMPANY}, 'J013 Agent', 'org', 'idle', 'claude_local', ${fixture.admin.json({})})`;
    await fixture.admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${USER}, 'J013 User', 'j013@example.test', true, now(), now())`;
    await fixture.admin`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
      VALUES (${COMPANY}, 'user', ${USER}, 'active', 'owner')`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  await fixture?.teardown().catch(() => {});
}, 60_000);

beforeEach(async () => {
  if (!fixture) return;
  await fixture.admin`DELETE FROM hub_audit`;
  await fixture.admin`DELETE FROM activity_log`;
  await fixture.admin`DELETE FROM notifications`;
});

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-013 transactional activity/hub audit parity",
  () => {
    it("[accepted] records the activity + an applied activity_audit receipt in one tx (runId forced null)", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(1);
      const eventId = randomUUID();
      // Deliberately pass a bogus runId + a real agentId: the bridge MUST force runId
      // null (a distributed attemptId is not a heartbeat_runs row — the FK would roll the
      // tx back) while threading agentId through for attribution.
      const out = await bridge().recordAcceptedActivity({
        source: taskSource(AGENT), actor, fence, acceptedEventId: eventId, eventDigest: DIGEST,
        activity: activityInput({ agentId: AGENT, runId: randomUUID() }),
      });
      expect(out.status).toBe("recorded");
      expect(out.activityId).toBeTruthy();
      expect(await count("activity_log", `company_id = '${COMPANY}' AND action = 'approval.created'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'activity_audit' AND status = 'applied'`)).toBe(1);
      const [row] = await fixture!.admin`SELECT id, run_id, agent_id FROM activity_log WHERE company_id = ${COMPANY}`;
      const r = row as { id: string; run_id: string | null; agent_id: string | null };
      expect(r.run_id).toBeNull();          // forced null — no heartbeat_runs FK violation
      expect(r.agent_id).toBe(AGENT);
      expect(r.id).toBe(out.activityId);
      const [receipt] = await fixture!.admin`SELECT target_aggregate_id, aggregate_kind
        FROM job_projection_receipts WHERE projection_kind = 'activity_audit'`;
      const rec = receipt as { target_aggregate_id: string; aggregate_kind: string };
      expect(rec.target_aggregate_id).toBe(out.activityId);
      expect(rec.aggregate_kind).toBe("activity_log");
    });

    it("[per-source] each accepted source (task_run / crew_run / commander_turn) writes exactly one activity + receipt", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(2);
      for (const source of [taskSource(AGENT), CREW_SOURCE, COMMANDER_SOURCE]) {
        const out = await bridge().recordAcceptedActivity({
          source, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
          activity: activityInput({ details: { source: source.kind } }),
        });
        expect(out.status).toBe("recorded");
      }
      expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(3);
      expect(await count("job_projection_receipts", `projection_kind = 'activity_audit' AND status = 'applied'`)).toBe(3);
    });

    it("[approval + budget action] both persist activity_log; the hub lifecycle action also writes one hub_audit row", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(3);
      const budgetEventId = randomUUID();
      await bridge().recordAcceptedActivity({
        source: taskSource(AGENT), actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
        activity: activityInput({ action: "approval.created", entityType: "approval" }),
      });
      const out = await bridge().recordAcceptedActivity({
        source: CREW_SOURCE, actor, fence, acceptedEventId: budgetEventId, eventDigest: DIGEST,
        activity: activityInput({ action: "hub_item.budget_paused", entityType: "hub_item" }),
        hubAudit: { actorType: "autonomy", actorId: "system", action: "budget_paused", autonomyLevel: "drive" },
      });
      expect(out.status).toBe("recorded");
      expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(2);
      expect(await count("hub_audit", `idempotency_key = 'activity_audit:${budgetEventId}'`)).toBe(1);
      expect(await count("hub_audit", `company_id = '${COMPANY}'`)).toBe(1); // only the hub action wrote one
    });

    it("[replay] a duplicate accepted event uses the receipt and does NOT re-insert activity/hub audit", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(4);
      const eventId = randomUUID();
      const open = {
        source: taskSource(AGENT), actor, fence, acceptedEventId: eventId, eventDigest: DIGEST,
        activity: activityInput(),
        hubAudit: { actorType: "autonomy" as const, actorId: "system", action: "paused" },
      };
      const first = await bridge().recordAcceptedActivity(open);
      expect(first.status).toBe("recorded");
      const second = await bridge().recordAcceptedActivity(open);
      expect(second.status).toBe("replayed");
      expect(second.activityId).toBe(first.activityId);
      expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'activity_audit'`)).toBe(1);
      expect(await count("hub_audit", `idempotency_key = 'activity_audit:${eventId}'`)).toBe(1);
    });

    it("[distinct events] different accepted events → distinct audit rows; replaying the first adds none", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(5);
      const e1 = randomUUID();
      const e2 = randomUUID();
      await bridge().recordAcceptedActivity({ source: taskSource(AGENT), actor, fence, acceptedEventId: e1, eventDigest: DIGEST, activity: activityInput() });
      await bridge().recordAcceptedActivity({ source: taskSource(AGENT), actor, fence, acceptedEventId: e2, eventDigest: DIGEST, activity: activityInput() });
      expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(2);
      const replay = await bridge().recordAcceptedActivity({ source: taskSource(AGENT), actor, fence, acceptedEventId: e1, eventDigest: DIGEST, activity: activityInput() });
      expect(replay.status).toBe("replayed");
      expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(2);
    });

    it("[stale fence] a rejected fence writes no activity and no receipt", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(6);
      const stale = { ...fence, fence: `${fence.fence}-stale` }; // fence token mismatch → JobFenceError
      await expect(
        bridge().recordAcceptedActivity({ source: taskSource(AGENT), actor, fence: stale, acceptedEventId: randomUUID(), eventDigest: DIGEST, activity: activityInput() }),
      ).rejects.toThrow();
      expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(0);
      expect(await count("job_projection_receipts", `projection_kind = 'activity_audit'`)).toBe(0);
    });

    it("[worker observation ≠ accepted action] a poll→ack lifecycle alone mints no audit; only a bridge call does", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(7); // poll→ack = the worker lifecycle
      // The worker OBSERVATION has occurred (a live lease exists), but no server mutation
      // was accepted → zero product audit.
      expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(0);
      expect(await count("job_projection_receipts", `projection_kind = 'activity_audit'`)).toBe(0);
      // A single ACCEPTED mutation flips both to 1 — audit is minted ONLY by the server bridge.
      await bridge().recordAcceptedActivity({ source: taskSource(AGENT), actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST, activity: activityInput() });
      expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'activity_audit'`)).toBe(1);
    });

    it("[rollback publishes nothing] a mid-tx FK failure rolls back the whole tx and fires no live event", async () => {
      guard();
      const events: unknown[] = [];
      const off = subscribeCompanyLiveEvents(COMPANY, (e) => { if (e.type === "activity.logged") events.push(e); });
      try {
        const { identity: fence } = await fixture!.activateLease(8);
        // A bogus agentId (no agents row) violates activity_log.agent_id → agents FK mid-tx,
        // AFTER lockActiveFence + the receipt fast-path. (runId is force-nulled by the bridge,
        // so agentId is the injectable FK vector.) The whole tenant tx rolls back.
        await expect(
          bridge().recordAcceptedActivity({
            source: taskSource(AGENT), actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
            activity: activityInput({ agentId: randomUUID() }),
          }),
        ).rejects.toThrow();
        expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(0);
        expect(await count("job_projection_receipts", `projection_kind = 'activity_audit'`)).toBe(0);
        expect(events.length).toBe(0); // no publish on rollback
      } finally {
        off();
      }
    });

    it("[publish after commit] the committed activity fires exactly one activity.logged AFTER the tx commits", async () => {
      guard();
      const events: unknown[] = [];
      const off = subscribeCompanyLiveEvents(COMPANY, (e) => { if (e.type === "activity.logged") events.push(e); });
      try {
        const { identity: fence } = await fixture!.activateLease(9);
        await bridge().recordAcceptedActivity({ source: taskSource(AGENT), actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST, activity: activityInput() });
        expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(1);
        expect(events.length).toBe(1); // committed AND published exactly once, post-commit
      } finally {
        off();
      }
    });

    it("[publication-before-commit denial — static] publish is deferred, never inline; no worker payload is read", () => {
      guard();
      const source = readFileSync(
        fileURLToPath(new URL("../services/job-audit-bridge.ts", import.meta.url)),
        "utf8",
      );
      // Publication is deferred to an after-commit drain.
      expect(source).toMatch(/afterCommit\.push\(/);
      // The SOLE publishActivity call is inside an afterCommit.push closure.
      expect(source.match(/publishActivity\(/g) ?? []).toHaveLength(1);
      expect(source).toMatch(/afterCommit\.push\(\(\) => publishActivity\(/);
      // Never the inline insert+publish helper, never the worker-event accept path.
      expect(source).not.toMatch(/\blogActivity\b/);
      expect(source).not.toMatch(/publishActivityLogged/);
      expect(source).not.toMatch(/acceptEvent/);
      // Reads no worker usage/observation payload (structural invariant).
      expect(source).not.toMatch(/usagePayload|inputTokens|outputTokens|\.units\b/);
    });

    it("[rollback gate] a pending activity_audit receipt makes assertRollbackSafe fail closed; the gate touches nothing", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(11);
      // Seed a PENDING activity_audit receipt directly (valid composite FK + digest).
      await fixture!.admin`INSERT INTO job_projection_receipts
        (organization_id, company_id, projection_kind, source_identity, source_digest, job_id, attempt_id, source_fence, status, target_aggregate_id, aggregate_kind, applied_at)
        VALUES (${ORG}, ${COMPANY}, 'activity_audit', ${`activity:${COMPANY}:${randomUUID()}`}, ${DIGEST}, ${fence.jobId}, ${fence.attemptId}, ${fence.fence}, 'pending', ${randomUUID()}, 'activity_log', NULL)`;
      await expect(bridge().assertRollbackSafe(COMPANY)).rejects.toBeInstanceOf(JobAuditBridgeRollbackPendingError);
      // Flip to applied → the gate passes; no activity_log rows were touched.
      await fixture!.admin`UPDATE job_projection_receipts SET status = 'applied', applied_at = now()
        WHERE projection_kind = 'activity_audit' AND status = 'pending'`;
      await expect(bridge().assertRollbackSafe(COMPANY)).resolves.toBeUndefined();
      expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(0);
    });

    it("[flag off] every entrypoint refuses fail-closed and touches nothing", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(12);
      const disabled = bridge({});
      expect(disabled.isEnabled()).toBe(false);
      await expect(
        disabled.recordAcceptedActivity({ source: taskSource(AGENT), actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST, activity: activityInput() }),
      ).rejects.toBeInstanceOf(JobAuditBridgeDisabledError);
      expect(await count("activity_log", `company_id = '${COMPANY}'`)).toBe(0);
      expect(await count("job_projection_receipts", `projection_kind = 'activity_audit'`)).toBe(0);
    });

    it("[tenant + actor attribution] the persisted activity carries the supplied actor/action; the receipt binds the attempt", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(13);
      const entityId = randomUUID();
      const out = await bridge().recordAcceptedActivity({
        source: taskSource(AGENT), actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
        activity: activityInput({ actorType: "user", actorId: USER, action: "task.completed", entityType: "issue", entityId }),
      });
      const [row] = await fixture!.admin`SELECT actor_type, actor_id, action, entity_type, entity_id FROM activity_log WHERE id = ${out.activityId}`;
      expect(row).toMatchObject({ actor_type: "user", actor_id: USER, action: "task.completed", entity_type: "issue", entity_id: entityId });
      const [receipt] = await fixture!.admin`SELECT organization_id, company_id, job_id, attempt_id
        FROM job_projection_receipts WHERE projection_kind = 'activity_audit'`;
      expect(receipt).toMatchObject({ organization_id: ORG, company_id: COMPANY, job_id: fence.jobId, attempt_id: fence.attemptId });
    });
  },
);
