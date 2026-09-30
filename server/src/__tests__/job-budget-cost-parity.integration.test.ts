// JOB-012 — legacy budget/cost authoritative-pricing parity (embedded PG; Linux CI is
// the formal authority, SKIPPED locally on Windows unless AOA_RUN_WIN_INTEGRATION=1).
//
// The bridge prices an accepted worker usage event ONCE through the EXISTING cost/budget
// authority — bounded UNITS in, SERVER-resolved rate out (never a worker price), a
// JOB-005 `authoritative_cost` receipt linking the cost_events row to the distributed
// attempt, synchronous budget evaluation at agent+company+department scope, and an
// exactly-once exhaustion cancel through the EXISTING requestCancellation (never a second
// capacity-release engine). Flag-off touches nothing; the rollback gate fails closed
// while a cost receipt is pending.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usagePayloadV1Schema } from "@armyofagents/worker-protocol";
import type { SubmitJobSource } from "@armyofagents/shared";
import {
  setupJobControlFixture,
  COMPANY,
  ORG,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";
import {
  jobBudgetCostBridge,
  JobBudgetCostBridgeDisabledError,
  JobBudgetCostBridgeRollbackPendingError,
  type BridgeActor,
} from "../services/job-budget-cost-bridge.js";
import { JobBudgetCostRateError } from "../services/job-authoritative-rate.js";
import { computeCostCents } from "../services/internal-agent/cost-model.js";
import {
  admitAttemptCapacityFailClosed,
  budgetAwareCapacityBridge,
} from "../services/org-concurrency.js";

const ENABLED_ENV = { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" } as const;
const AGENT = "a7000000-0000-4000-8000-0000000000b1";
const AGENT_UNKNOWN = "a7000000-0000-4000-8000-0000000000b2";
const DEPT = "a7000000-0000-4000-8000-0000000000c1";
const USER = "job012-user";
const DIGEST = "a".repeat(64);
const KNOWN_MODEL = "claude-sonnet-4-6";
const actor: BridgeActor = { kind: "user", id: USER, companyId: COMPANY };

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

function bridge(env: Record<string, string | undefined> = ENABLED_ENV) {
  return jobBudgetCostBridge(fixture!.app.db, { env });
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
const units = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: 0,
  runtimeMillis: 100,
});
/** Insert a cost_events row directly (seed observed spend for admission/budget tests). */
async function seedCost(opts: { agentId?: string | null; projectId?: string | null; costCents: number }): Promise<void> {
  await fixture!.admin`INSERT INTO cost_events
    (company_id, agent_id, project_id, provider, biller, billing_type, model, input_tokens, output_tokens, cost_cents, occurred_at)
    VALUES (${COMPANY}, ${opts.agentId ?? null}, ${opts.projectId ?? null}, 'claude_local', 'claude_local', 'subscription_claude',
      ${KNOWN_MODEL}, 0, 0, ${opts.costCents}, now())`;
}
async function seedPolicy(scopeType: "company" | "agent" | "department", scopeId: string, amountCents: number): Promise<void> {
  await fixture!.admin`INSERT INTO budget_policies
    (company_id, scope_type, scope_id, metric, window_kind, amount_cents, warn_percent, hard_stop_enabled, is_active)
    VALUES (${COMPANY}, ${scopeType}, ${scopeId}, 'cost_cents', 'calendar_month_utc', ${amountCents}, 80, true, true)`;
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("job012-parity");
    await fixture.admin`INSERT INTO agents (id, company_id, name, kind, status, adapter_type, adapter_config)
      VALUES (${AGENT}, ${COMPANY}, 'J012 Agent', 'org', 'idle', 'claude_local', ${fixture.admin.json({ model: KNOWN_MODEL })})`;
    await fixture.admin`INSERT INTO agents (id, company_id, name, kind, status, adapter_type, adapter_config)
      VALUES (${AGENT_UNKNOWN}, ${COMPANY}, 'J012 Unknown', 'org', 'idle', 'claude_local', ${fixture.admin.json({ model: "totally-unknown-model-x" })})`;
    // Company crew/Commander/workload default model (agent-less rate resolution source).
    await fixture.admin`INSERT INTO internal_agent_config (company_id, model, provider)
      VALUES (${COMPANY}, ${KNOWN_MODEL}, 'anthropic')`;
    // A department (projects row) for department-scope budget/attribution.
    await fixture.admin`INSERT INTO projects (id, company_id, name, type)
      VALUES (${DEPT}, ${COMPANY}, 'J012 Dept', 'department')`;
    await fixture.admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${USER}, 'J012 User', 'j012@example.test', true, now(), now())`;
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
  await fixture.admin`DELETE FROM budget_incidents`;
  await fixture.admin`DELETE FROM budget_policies`;
  await fixture.admin`DELETE FROM cost_events`;
  await fixture.admin`DELETE FROM approvals`;
  await fixture.admin`DELETE FROM notifications`;
  await fixture.admin`UPDATE companies SET spent_monthly_cents = 0 WHERE id = ${COMPANY}`;
  await fixture.admin`UPDATE agents SET spent_monthly_cents = 0, status = 'idle'`;
});

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-012 budget / authoritative-cost parity",
  () => {
    it("[worker price rejected] units-only schema + charge is SERVER-priced, never worker-supplied", async () => {
      guard();
      // (a) the frozen usage payload is bounded units only — a costCents field is rejected.
      expect(
        usagePayloadV1Schema.safeParse({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, runtimeMillis: 1, costCents: 5000 }).success,
      ).toBe(false);
      expect(
        usagePayloadV1Schema.safeParse({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, runtimeMillis: 1 }).success,
      ).toBe(true);

      // (b) the bridge reads ONLY units → charge == computeCostCents(resolved model, units).
      const { identity: fence } = await fixture!.activateLease(1);
      const eventId = randomUUID();
      const out = await bridge().priceAcceptedUsage({
        source: taskSource(AGENT), actor, fence, acceptedEventId: eventId, eventDigest: DIGEST, units: units(1_000_000, 1_000_000),
      });
      const expected = computeCostCents("claude_local", KNOWN_MODEL, 1_000_000, 1_000_000);
      expect(out.status).toBe("charged");
      expect(out.costCents).toBe(expected);
      const [row] = await fixture!.admin`SELECT cost_cents, rate_id, rate_version, rounding_mode, source_idempotency_key, agent_id
        FROM cost_events WHERE company_id = ${COMPANY}`;
      const r = row as { cost_cents: number; rate_id: string; rate_version: number; rounding_mode: string; source_idempotency_key: string; agent_id: string };
      expect(r.cost_cents).toBe(expected);
      expect(r.rate_id).toBe(KNOWN_MODEL);
      expect(r.rate_version).toBe(1);
      expect(r.rounding_mode).toBe("round_half_up_cents");
      expect(r.agent_id).toBe(AGENT);
      expect(r.source_idempotency_key).toBe(`cost:${COMPANY}:${eventId}`);
      expect(await count("job_projection_receipts", `projection_kind = 'authoritative_cost' AND status = 'applied'`)).toBe(1);
    });

    it("[unknown rate] fails closed BEFORE any effect (0 cost_events, 0 receipts)", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(2);
      await expect(
        bridge().priceAcceptedUsage({
          source: taskSource(AGENT_UNKNOWN), actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST, units: units(1_000, 1_000),
        }),
      ).rejects.toBeInstanceOf(JobBudgetCostRateError);
      expect(await count("cost_events", `company_id = '${COMPANY}'`)).toBe(0);
      expect(await count("job_projection_receipts", `projection_kind = 'authoritative_cost'`)).toBe(0);
    });

    it("[replay] a duplicate accepted event uses the receipt and does NOT charge again", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(3);
      const eventId = randomUUID();
      const open = { source: taskSource(AGENT), actor, fence, acceptedEventId: eventId, eventDigest: DIGEST, units: units(500_000, 0) };
      const first = await bridge().priceAcceptedUsage(open);
      expect(first.status).toBe("charged");
      const second = await bridge().priceAcceptedUsage(open);
      expect(second.status).toBe("replayed");
      expect(second.costEventId).toBe(first.costEventId);
      expect(await count("cost_events", `company_id = '${COMPANY}'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'authoritative_cost'`)).toBe(1);
    });

    it("[retry attribution] distinct events → distinct charges + idempotency keys; replay adds none", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(4);
      const e1 = randomUUID();
      const e2 = randomUUID();
      await bridge().priceAcceptedUsage({ source: taskSource(AGENT), actor, fence, acceptedEventId: e1, eventDigest: DIGEST, units: units(100_000, 0) });
      await bridge().priceAcceptedUsage({ source: taskSource(AGENT), actor, fence, acceptedEventId: e2, eventDigest: DIGEST, units: units(200_000, 0) });
      expect(await count("cost_events", `company_id = '${COMPANY}'`)).toBe(2);
      expect(await count("cost_events", `source_idempotency_key = 'cost:${COMPANY}:${e1}'`)).toBe(1);
      expect(await count("cost_events", `source_idempotency_key = 'cost:${COMPANY}:${e2}'`)).toBe(1);
      // Replaying e1 does NOT add a third charge.
      const replay = await bridge().priceAcceptedUsage({ source: taskSource(AGENT), actor, fence, acceptedEventId: e1, eventDigest: DIGEST, units: units(100_000, 0) });
      expect(replay.status).toBe("replayed");
      expect(await count("cost_events", `company_id = '${COMPANY}'`)).toBe(2);
    });

    it("[exhaustion] a hard-stop breach creates ONE incident + cancels; a 2nd same-job charge re-confirms cancel idempotently", async () => {
      guard();
      await seedPolicy("company", COMPANY, 1); // cap = 1 cent → any positive charge crosses
      const { identity: fence, seeded } = await fixture!.activateLease(5);
      const first = await bridge().priceAcceptedUsage({ source: taskSource(AGENT), actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST, units: units(1_000_000, 0) });
      expect(first.incidentCreated).toBe(true);
      expect(first.cancelled).toBe(true);
      // A 2nd distinct charge (same fence) still observes over-cap → hardStopBreached, so it
      // re-confirms the cancel (requestCancellation → already_requested → cancelled:true).
      // No NEW incident (one-per-window dedup) and — because the cancel commandId is derived
      // from the job — NO new cancel control (ON CONFLICT DO NOTHING).
      const second = await bridge().priceAcceptedUsage({ source: taskSource(AGENT), actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST, units: units(1_000_000, 0) });
      expect(second.incidentCreated).toBe(false);
      expect(second.cancelled).toBe(true);
      expect(await count("cost_events", `company_id = '${COMPANY}'`)).toBe(2);
      expect(await count("budget_incidents", `company_id = '${COMPANY}' AND threshold_type = 'hard_stop'`)).toBe(1);
      // Exactly ONE cancel control queued for the lease (deterministic commandId dedup).
      expect(await count("job_control_commands", `command_kind = 'cancel' AND lease_id = '${fence.leaseId}'`)).toBe(1);
      const [job] = await fixture!.admin`SELECT status FROM jobs WHERE id = ${seeded.jobId}`;
      expect((job as { status: string }).status).toBe("cancel_requested");
    });

    it("[exhaustion sibling] a DIFFERENT job crossing an already-breached cap is ALSO cancelled (not just the incident-winner)", async () => {
      guard();
      await seedPolicy("company", COMPANY, 1); // cap = 1 cent
      // Job A crosses the cap → creates the one hard-stop incident + cancels A.
      const { identity: fenceA } = await fixture!.activateLease(50);
      const a = await bridge().priceAcceptedUsage({ source: taskSource(AGENT), actor, fence: fenceA, acceptedEventId: randomUUID(), eventDigest: DIGEST, units: units(1_000_000, 0) });
      expect(a.incidentCreated).toBe(true);
      expect(a.cancelled).toBe(true);
      // Job B is a DIFFERENT job/attempt/lease. resetRuntimeRows wipes leases/jobs but NOT
      // cost_events/budget_incidents, so A's spend + the open incident persist. B's charge
      // crosses the SAME already-breached cap: createIncidentIfNeeded returns null (dedup) so
      // incidentCreated is false — but B MUST STILL be cancelled (hardStopBreached), else a
      // concurrent sibling overspends past the hard stop. This is the JOB-012 review defect.
      const { identity: fenceB, seeded: seededB } = await fixture!.activateLease(51);
      const b = await bridge().priceAcceptedUsage({ source: taskSource(AGENT), actor, fence: fenceB, acceptedEventId: randomUUID(), eventDigest: DIGEST, units: units(1_000_000, 0) });
      expect(b.incidentCreated).toBe(false);
      expect(b.cancelled).toBe(true);
      expect(await count("job_control_commands", `command_kind = 'cancel' AND lease_id = '${fenceB.leaseId}'`)).toBe(1);
      const [jobB] = await fixture!.admin`SELECT status FROM jobs WHERE id = ${seededB.jobId}`;
      expect((jobB as { status: string }).status).toBe("cancel_requested");
    });

    it("[after-cost determinism] the incident is committed in the SAME tx (not fire-and-forget)", async () => {
      guard();
      await seedPolicy("company", COMPANY, 1);
      const { identity: fence } = await fixture!.activateLease(6);
      const out = await bridge().priceAcceptedUsage({ source: taskSource(AGENT), actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST, units: units(1_000_000, 0) });
      // No delay / setImmediate: the incident is already visible because evaluateCostEvent
      // ran synchronously inside the committed tenant transaction.
      expect(out.incidentCreated).toBe(true);
      expect(await count("budget_incidents", `threshold_type = 'hard_stop' AND status = 'open'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'authoritative_cost' AND status = 'applied'`)).toBe(1);
    });

    it("[department scope] the charge attributes to project_id so department policies observe it", async () => {
      guard();
      await seedPolicy("department", DEPT, 1);
      const { identity: fence } = await fixture!.activateLease(7);
      // Agent-less source (crew_run) resolves the company-default model and charges with project_id.
      const out = await bridge().priceAcceptedUsage({ source: CREW_SOURCE, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST, units: units(1_000_000, 0), projectId: DEPT });
      expect(out.status).toBe("charged");
      expect(out.incidentCreated).toBe(true); // department hard-stop breached + enforced
      expect(await count("cost_events", `project_id = '${DEPT}' AND agent_id IS NULL`)).toBe(1);
      expect(await count("budget_incidents", `scope_type = 'department' AND threshold_type = 'hard_stop'`)).toBe(1);
    });

    it("[rollback gate] a pending authoritative_cost receipt makes assertRollbackSafe fail closed", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(8);
      // Insert a PENDING authoritative_cost receipt directly (valid composite FK + digest).
      await fixture!.admin`INSERT INTO job_projection_receipts
        (organization_id, company_id, projection_kind, source_identity, source_digest, job_id, attempt_id, source_fence, status, target_aggregate_id, aggregate_kind, applied_at)
        VALUES (${ORG}, ${COMPANY}, 'authoritative_cost', ${`cost:${COMPANY}:${randomUUID()}`}, ${DIGEST}, ${fence.jobId}, ${fence.attemptId}, ${fence.fence}, 'pending', ${randomUUID()}, 'cost_events', NULL)`;
      await expect(bridge().assertRollbackSafe(COMPANY)).rejects.toBeInstanceOf(JobBudgetCostBridgeRollbackPendingError);
      // Flip to applied → the gate passes; no cost_events were touched.
      await fixture!.admin`UPDATE job_projection_receipts SET status = 'applied', applied_at = now()
        WHERE projection_kind = 'authoritative_cost' AND status = 'pending'`;
      await expect(bridge().assertRollbackSafe(COMPANY)).resolves.toBeUndefined();
      expect(await count("cost_events", `company_id = '${COMPANY}'`)).toBe(0);
    });

    it("[flag off] every entrypoint refuses fail-closed and touches nothing", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(9);
      const disabled = bridge({});
      expect(disabled.isEnabled()).toBe(false);
      await expect(
        disabled.priceAcceptedUsage({ source: taskSource(AGENT), actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST, units: units(1_000_000, 0) }),
      ).rejects.toBeInstanceOf(JobBudgetCostBridgeDisabledError);
      expect(await count("cost_events", `company_id = '${COMPANY}'`)).toBe(0);
      expect(await count("job_projection_receipts", `projection_kind = 'authoritative_cost'`)).toBe(0);
    });

    it("[admission] the budget-aware bridge denies at company/agent/department scope; admits when clear", async () => {
      guard();
      // The bridge is the JOB-012 admission unit — it reads only the non-RLS budget
      // tables (`budget_policies`/`cost_events`), so it is the seam the shared
      // `admitAttemptCapacity` consults at its `budgetBridge` injection point.
      // Clear (no policy) → admits.
      expect(await budgetAwareCapacityBridge.checkAdmission(fixture!.app.db, { companyId: COMPANY })).toEqual({ allowed: true });

      // Company hard-stop already reached → denies (this is the value admitAttemptCapacity
      // surfaces as reason 'budget').
      await seedPolicy("company", COMPANY, 1);
      await seedCost({ costCents: 100 });
      expect(await budgetAwareCapacityBridge.checkAdmission(fixture!.app.db, { companyId: COMPANY })).toMatchObject({ allowed: false });

      // Richer scope: an agent hard-stop and a department hard-stop each deny.
      await seedPolicy("agent", AGENT, 1);
      await seedCost({ agentId: AGENT, costCents: 100 });
      expect(await budgetAwareCapacityBridge.checkAdmission(fixture!.app.db, { companyId: COMPANY, agentId: AGENT })).toMatchObject({ allowed: false });
      await seedPolicy("department", DEPT, 1);
      await seedCost({ projectId: DEPT, costCents: 100 });
      expect(await budgetAwareCapacityBridge.checkAdmission(fixture!.app.db, { companyId: COMPANY, projectId: DEPT })).toMatchObject({ allowed: false });
    });

    it("[admission fail-closed] an unavailable admission dependency denies (never a silent admit)", async () => {
      guard();
      await fixture!.activateLease(11); // a live attempt exists
      // `admitAttemptCapacityFailClosed` converts ANY thrown admission dependency into an
      // explicit denial. The tenant-scoped attempt read requires org context (absent on a
      // raw aoa_app call), so the admission storage is "unavailable" here → fail-closed.
      const failClosed = await admitAttemptCapacityFailClosed(fixture!.app.db, {
        organizationId: ORG, companyId: COMPANY, workloadType: "batch", attemptId: randomUUID(), budgetBridge: budgetAwareCapacityBridge,
      });
      expect(failClosed).toEqual({ admitted: false, reason: "unavailable" });
    });

    it("[no second release engine] the bridge never writes capacity_claim_state / releaseAttemptCapacity", () => {
      guard();
      // Static proof: the exhaustion stop is realized ONLY through the existing
      // requestCancellation (which releases the slot exactly once). The bridge must not
      // contain a parallel capacity-release engine (JOB-007 owns admit/release).
      const source = readFileSync(
        fileURLToPath(new URL("../services/job-budget-cost-bridge.ts", import.meta.url)),
        "utf8",
      );
      expect(source).not.toMatch(/releaseAttemptCapacity/);
      expect(source).not.toMatch(/capacityClaimState/);
      expect(source).not.toMatch(/capacity_claim_state/);
      // The one sanctioned release path IS present (via requestCancellation).
      expect(source).toMatch(/requestCancellation/);
    });
  },
);
