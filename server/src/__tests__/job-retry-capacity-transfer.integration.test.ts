// server/src/__tests__/job-retry-capacity-transfer.integration.test.ts
//
// DEP-009 (HIGH-2) — the retry successor must INHERIT the reaped attempt's Organization
// capacity slot, against real embedded Postgres under the aoa_app RLS role. Proves the
// reap→retry boundary conserves org occupancy: when the reaper abandons an attempt that
// HELD a slot and mints attempt N+1, N+1 is stamped `capacity_claim_state='held'` (a
// transfer inside the ONE reaper transaction) instead of the schema default `unclaimed`.
//
// Without the transfer the retry hole is: attempt N is released (held→released), N+1 is
// minted `unclaimed`, offer-time capacity enforcement is DEFERRED, so N+1 leases and runs
// UNCOUNTED and the org cap is exceeded. The final assertion — a concurrent submit of
// ANOTHER job is DENIED (429) while the retry is in flight — is the observable proof that
// occupancy stays ≤ cap. (RED before the transfer: heldCount collapses to 0 and the submit
// is admitted; GREEN after: heldCount stays 1 and the submit is denied.)

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { submitJobWithinTenant } from "../services/job-submission.js";
import { admitAttemptCapacity } from "../services/org-concurrency.js";
import { runInTenant } from "../db/tenant-context.js";
import { ORG, COMPANY, setupJobControlFixture, type JobControlFixture } from "./helpers/job-control-fixture.js";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

integration("DEP-009 reap→retry capacity-claim transfer", () => {
  let fx: JobControlFixture | null = null;
  let setupError: unknown = null;
  let priorFlag: string | undefined;

  function ctx(): JobControlFixture {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!fx) throw new Error("fixture not initialized");
    return fx;
  }

  async function setCap(cap: number | null): Promise<void> {
    await ctx().admin`UPDATE organizations SET concurrency_cap = ${cap} WHERE id = ${ORG}`;
  }

  async function heldCount(): Promise<number> {
    const [row] = await ctx().admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_attempts
      WHERE organization_id = ${ORG} AND capacity_claim_state = 'held'`;
    return row?.n ?? 0;
  }

  async function attemptStates(jobId: string): Promise<Array<{ attempt_number: number; capacity_claim_state: string }>> {
    const rows = await ctx().admin<{ attempt_number: number; capacity_claim_state: string }[]>`
      SELECT attempt_number, capacity_claim_state FROM job_attempts
      WHERE job_id = ${jobId} ORDER BY attempt_number`;
    return rows.map((r) => ({ attempt_number: Number(r.attempt_number), capacity_claim_state: r.capacity_claim_state }));
  }

  const submit = (idempotencyKey: string) =>
    runInTenant(ctx().app.db, ORG, (repos, tx) => submitJobWithinTenant(repos, {
      organizationId: ORG,
      companyId: COMPANY,
      principal: { kind: "system" as const, id: "dep-009-retry-transfer-test" },
      command: {
        idempotencyKey,
        source: { kind: "one_shot" as const, operationId: randomUUID(), operationKind: "readiness_probe" as const },
        input: { value: "dep-009-retry" },
      },
    }, tx));

  beforeAll(async () => {
    // Submit-time admission is dormant behind the deployment flag; turn it on for this suite.
    priorFlag = process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;
    process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "true";
    try {
      fx = await setupJobControlFixture("job-retry-capacity");
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterEach(async () => {
    if (fx) {
      await ctx().resetRuntimeRows();
      await setCap(null);
    }
  });

  afterAll(async () => {
    if (priorFlag === undefined) delete process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;
    else process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = priorFlag;
    await fx?.teardown();
  }, 60_000);

  it("transfers the reaped attempt's held slot to the retry successor so occupancy stays <= cap", async () => {
    await setCap(1);

    // Seed + activate a lease for a job with retries remaining (maxAttempts=3), then claim
    // the Organization capacity slot on attempt #1 exactly as submit-time admission would.
    const { seeded } = await ctx().activateLease(9_001, { maxAttempts: 3 });
    await runInTenant(ctx().app.db, ORG, (_repos, tx) => admitAttemptCapacity(tx, {
      organizationId: ORG, companyId: COMPANY, workloadType: "batch", attemptId: seeded.attemptId,
      principalId: "retry-transfer-test", principalKind: "system",
    }));
    expect(await heldCount()).toBe(1);

    // Expire the active lease so the reaper abandons attempt #1 and allocates a retry.
    // ack_deadline must stay STRICTLY < expires_at (leases_authority_atomic_check).
    // `clock_timestamp()` advances WITHIN a statement, so two calls with the same
    // interval leave a zero margin and the second one can land later — which makes
    // ack_deadline > expires_at and violates the constraint. Under CI-DB load the
    // gap reached ~52ms and failed the run twice. Every sibling call site already
    // uses a 1-unit margin for exactly this reason (see job-fencing.integration).
    await ctx().admin`
      UPDATE leases SET expires_at = clock_timestamp() - interval '1 minute',
        ack_deadline = clock_timestamp() - interval '2 minutes'
      WHERE attempt_id = ${seeded.attemptId}`;

    const reap = await runInTenant(ctx().app.db, ORG, (repos) => repos.jobControl.reapExpiredLeases({
      organizationId: ORG, now: new Date(), limit: 16, baseBackoffMs: 0, maxBackoffMs: 0,
    }));
    expect(reap.retried).toBe(1);

    // The transfer: attempt #1 released, attempt #2 minted already 'held'. Occupancy conserved.
    expect(await attemptStates(seeded.jobId)).toEqual([
      { attempt_number: 1, capacity_claim_state: "released" },
      { attempt_number: 2, capacity_claim_state: "held" },
    ]);
    expect(await heldCount()).toBe(1);

    // The observable proof: with the retry holding the slot, a concurrent submit of ANOTHER
    // job is DENIED (429) — the org cap is NOT exceeded while the retry is in flight.
    await expect(submit(randomUUID())).rejects.toMatchObject({ status: 429 });
    expect(await heldCount()).toBe(1);
  }, 60_000);
});
