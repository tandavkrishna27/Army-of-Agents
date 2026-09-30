// server/src/__tests__/job-quotas.integration.test.ts
//
// JOB-007 — the shared Organization concurrency/capacity authority. Proves, against
// real embedded Postgres under the aoa_app RLS role:
//   * concurrent claims never exceed the Organization cap (advisory-lock count-then-claim);
//   * legacy heartbeat runs and distributed attempts are counted TOGETHER against one cap;
//   * the claim is released by ONE conditional transition — exactly once even when
//     retry/reaper/revocation/cost paths race on the same attempt;
//   * a reached budget hard-stop denies admission (budget bridge seam);
//   * unavailable admission storage FAILS CLOSED (denied, never a silent admit, no claim).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  admitAttemptCapacity,
  admitAttemptCapacityFailClosed,
  releaseAttemptCapacity,
  type CapacityBudgetBridge,
} from "../services/org-concurrency.js";
import { runInTenant } from "../db/tenant-context.js";
import {
  COMPANY,
  ORG,
  setupJobControlFixture,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

integration("JOB-007 organization quotas / shared capacity authority", () => {
  let fx: JobControlFixture | null = null;
  let setupError: unknown = null;

  function ctx(): JobControlFixture {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!fx) throw new Error("fixture not initialized");
    return fx;
  }

  async function setCap(cap: number | null): Promise<void> {
    const { admin } = ctx();
    await admin`UPDATE organizations SET concurrency_cap = ${cap} WHERE id = ${ORG}`;
  }

  async function claimState(attemptId: string): Promise<string | null> {
    const { admin } = ctx();
    const [row] = await admin<{ state: string }[]>`
      SELECT capacity_claim_state AS state FROM job_attempts WHERE id = ${attemptId}`;
    return row?.state ?? null;
  }

  /** A committed legacy running heartbeat run for ORG (an agent + a 'running' run). */
  async function seedLegacyRunningRun(): Promise<{ agentId: string; runId: string }> {
    const { admin } = ctx();
    const agentId = randomUUID();
    await admin`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${COMPANY}, 'quota-legacy')`;
    const [run] = await admin<{ id: string }[]>`
      INSERT INTO heartbeat_runs (company_id, agent_id, status)
      VALUES (${COMPANY}, ${agentId}, 'running') RETURNING id`;
    return { agentId, runId: run!.id };
  }

  async function clearLegacyRuns(): Promise<void> {
    const { admin } = ctx();
    await admin`DELETE FROM heartbeat_runs WHERE company_id = ${COMPANY}`;
    await admin`DELETE FROM agents WHERE company_id = ${COMPANY} AND name LIKE 'quota-legacy%'`;
  }

  const admit = (attemptId: string, workloadType: string, budgetBridge?: CapacityBudgetBridge) =>
    runInTenant(ctx().app.db, ORG, async (_repos, tx) =>
      admitAttemptCapacity(tx, {
        organizationId: ORG,
        companyId: COMPANY,
        workloadType,
        attemptId,
        principalId: "job-quotas-test",
        principalKind: "system",
        budgetBridge,
      }));

  const release = (attemptId: string) =>
    runInTenant(ctx().app.db, ORG, async (_repos, tx) =>
      releaseAttemptCapacity(tx, { attemptId, organizationId: ORG }));

  beforeAll(async () => {
    try {
      fx = await setupJobControlFixture("job-quotas");
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await fx?.teardown();
  }, 60_000);

  it("never exceeds the Organization cap under concurrent claims (cap=1)", async () => {
    const f = ctx();
    await f.resetRuntimeRows();
    await clearLegacyRuns();
    await setCap(1);
    const a = await f.seedPlacedJob(7_001);
    const b = await f.seedPlacedJob(7_002);
    const c = await f.seedPlacedJob(7_003);

    const [ra, rb, rc] = await Promise.all([
      admit(a.attemptId, "batch"),
      admit(b.attemptId, "batch"),
      admit(c.attemptId, "batch"),
    ]);
    const admitted = [ra, rb, rc].filter((r) => r.admitted);
    expect(admitted).toHaveLength(1);
    expect([ra, rb, rc].filter((r) => !r.admitted).map((r) => (r as { reason: string }).reason))
      .toEqual(["capacity", "capacity"]);

    // Exactly one attempt actually holds a slot.
    const states = await Promise.all([a, b, c].map((s) => claimState(s.attemptId)));
    expect(states.filter((s) => s === "held")).toHaveLength(1);
  }, 60_000);

  it("counts legacy heartbeat runs and distributed attempts together against one cap (cap=2)", async () => {
    const f = ctx();
    await f.resetRuntimeRows();
    await clearLegacyRuns();
    await setCap(2);
    await seedLegacyRunningRun(); // 1 legacy running run consumes one slot.
    const a = await f.seedPlacedJob(7_011);
    const b = await f.seedPlacedJob(7_012);

    // usage = 1 legacy + 0 held = 1 < 2 -> admitted (now 1 legacy + 1 held = 2).
    const ra = await admit(a.attemptId, "batch");
    expect(ra.admitted).toBe(true);
    // usage = 1 legacy + 1 held = 2 >= 2 -> denied by capacity (legacy IS counted).
    const rb = await admit(b.attemptId, "batch");
    expect(rb).toMatchObject({ admitted: false, reason: "capacity" });

    await clearLegacyRuns();
  }, 60_000);

  it("releases the slot EXACTLY once across racing retry/reaper/revocation paths", async () => {
    const f = ctx();
    await f.resetRuntimeRows();
    await clearLegacyRuns();
    await setCap(8);
    const a = await f.seedPlacedJob(7_021);
    expect((await admit(a.attemptId, "batch")).admitted).toBe(true);
    expect(await claimState(a.attemptId)).toBe("held");

    // Three concurrent releasers (retry, reaper, revocation) race the same held slot.
    const [r1, r2, r3] = await Promise.all([
      release(a.attemptId), release(a.attemptId), release(a.attemptId),
    ]);
    expect([r1, r2, r3].filter((r) => r.released)).toHaveLength(1);
    expect(await claimState(a.attemptId)).toBe("released");

    // A late releaser is an idempotent no-op.
    expect((await release(a.attemptId)).released).toBe(false);
  }, 60_000);

  it("is idempotent: re-admitting a held attempt claims no second slot", async () => {
    const f = ctx();
    await f.resetRuntimeRows();
    await clearLegacyRuns();
    await setCap(1);
    const a = await f.seedPlacedJob(7_031);
    const first = await admit(a.attemptId, "batch");
    expect(first).toMatchObject({ admitted: true, alreadyHeld: false });
    const second = await admit(a.attemptId, "batch");
    expect(second).toMatchObject({ admitted: true, alreadyHeld: true });
    // A DIFFERENT attempt is still denied — the idempotent re-admit took no new slot.
    const b = await f.seedPlacedJob(7_032);
    expect(await admit(b.attemptId, "batch")).toMatchObject({ admitted: false, reason: "capacity" });
  }, 60_000);

  it("denies admission when the company budget hard-stop is reached (budget bridge)", async () => {
    const f = ctx();
    await f.resetRuntimeRows();
    await clearLegacyRuns();
    await setCap(8);
    const a = await f.seedPlacedJob(7_041);
    // A company hard-stop policy with a 0-cent cap is already at/over budget.
    await f.admin`INSERT INTO budget_policies
      (company_id, scope_type, scope_id, metric, window_kind, amount_cents, is_active, hard_stop_enabled)
      VALUES (${COMPANY}, 'company', ${COMPANY}, 'cost_cents', 'calendar_month_utc', 0, true, true)`;
    const result = await admit(a.attemptId, "batch");
    expect(result).toMatchObject({ admitted: false, reason: "budget" });
    expect(await claimState(a.attemptId)).toBe("unclaimed");
    await f.admin`DELETE FROM budget_policies WHERE company_id = ${COMPANY}`;
  }, 60_000);

  it("FAILS CLOSED when the admission storage / budget dependency is unavailable", async () => {
    const f = ctx();
    await f.resetRuntimeRows();
    await clearLegacyRuns();
    await setCap(8);
    const a = await f.seedPlacedJob(7_051);
    const brokenBridge: CapacityBudgetBridge = {
      async checkAdmission() {
        throw new Error("admission storage unavailable");
      },
    };
    // The fail-closed wrapper turns any thrown admission into an explicit denial.
    const result = await runInTenant(f.app.db, ORG, async (_repos, tx) =>
      admitAttemptCapacityFailClosed(tx, {
        organizationId: ORG,
        companyId: COMPANY,
        workloadType: "batch",
        attemptId: a.attemptId,
        budgetBridge: brokenBridge,
      }));
    expect(result).toEqual({ admitted: false, reason: "unavailable" });
    // No slot was claimed (the thrown admission rolled back cleanly).
    expect(await claimState(a.attemptId)).toBe("unclaimed");

    // The raw admit propagates (never a silent admit) so callers must fail closed.
    await expect(admit(a.attemptId, "batch", brokenBridge)).rejects.toThrow(/unavailable/i);
    expect(await claimState(a.attemptId)).toBe("unclaimed");
  }, 60_000);
});
