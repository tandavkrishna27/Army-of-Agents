import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobReconciliationService } from "../services/job-reconciliation.js";
import { createJobControlSweeper } from "../services/job-control-sweeper.js";
import { runInTenant } from "../db/tenant-context.js";
import {
  auth,
  COMPANY,
  ORG,
  pollRequest,
  setupJobControlFixture,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

integration("JOB-006 reconciliation / reaper", () => {
  let fx: JobControlFixture | null = null;
  let setupError: unknown = null;

  function ctx(): JobControlFixture {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!fx) throw new Error("fixture not initialized");
    return fx;
  }

  /** Force the active lease past its expiry so the reaper treats the worker as gone. */
  async function expireLease(leaseId: string): Promise<void> {
    const { admin } = ctx();
    await admin`UPDATE leases SET ack_deadline = clock_timestamp() - interval '2 seconds',
      expires_at = clock_timestamp() - interval '1 second' WHERE id = ${leaseId}`;
  }

  async function jobState(jobId: string) {
    const { admin } = ctx();
    const [row] = await admin<{
      status: string; deadLetterReason: string | null; attempts: number;
    }[]>`SELECT
      (SELECT status FROM jobs WHERE id = ${jobId}) AS status,
      (SELECT dead_letter_reason FROM jobs WHERE id = ${jobId}) AS "deadLetterReason",
      (SELECT count(*)::int FROM job_attempts WHERE job_id = ${jobId}) AS attempts`;
    return row!;
  }

  async function attemptByNumber(jobId: string, attemptNumber: number) {
    const { admin } = ctx();
    const [row] = await admin<{
      id: string; status: string; backoffUntil: Date | null;
    }[]>`SELECT id, status, backoff_until AS "backoffUntil"
      FROM job_attempts WHERE job_id = ${jobId} AND attempt_number = ${attemptNumber}`;
    return row ?? null;
  }

  async function outboxCount(attemptId: string): Promise<number> {
    const { admin } = ctx();
    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM job_outbox
      WHERE attempt_id = ${attemptId} AND kind = 'attempt_ready'`;
    return Number(row!.count);
  }

  beforeAll(async () => {
    try {
      fx = await setupJobControlFixture("job-reconciliation");
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await fx?.teardown();
  }, 60_000);

  it("reaps an abandoned lease: fence revoked, attempt expired, retry attempt N+1 + ready row with immutable backoff", async () => {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db, baseBackoffMs: 5_000 });
    const { seeded, offer } = await f.activateLease(6_101);
    await expireLease(offer.leaseId);

    const result = await reconciliation.reapOrganization(ORG);
    expect(result.revoked).toBe(1);
    expect(result.retried).toBe(1);
    expect(result.deadLettered).toBe(0);

    // The reaped lease's fence is permanently revoked, attempt 1 expired.
    const { admin } = f;
    const [lease] = await admin<{ status: string }[]>`SELECT status FROM leases WHERE id = ${offer.leaseId}`;
    expect(lease?.status).toBe("expired");
    expect((await attemptByNumber(seeded.jobId, 1))?.status).toBe("expired");

    // Attempt 2 exists (pending) with an immutable backoff + exactly one attempt-ready row; job requeued.
    const attempt2 = await attemptByNumber(seeded.jobId, 2);
    expect(attempt2?.status).toBe("pending");
    expect(attempt2?.backoffUntil).not.toBeNull();
    expect(await outboxCount(attempt2!.id)).toBe(1);
    expect((await jobState(seeded.jobId)).status).toBe("queued");
  }, 60_000);

  it("CAV-003 restart: after reaping, a re-poll mints a NEW attempt (2) with a NEW lease/fence (never revives the expired one)", async () => {
    const f = ctx();
    // baseBackoff 0 so the retry attempt is immediately dispatchable.
    const reconciliation = createJobReconciliationService({ appDb: f.app.db, baseBackoffMs: 0 });
    const { offer } = await f.activateLease(6_102);
    await expireLease(offer.leaseId);
    await reconciliation.reapOrganization(ORG);

    const repolled = await f.leasing.poll({ auth: auth("restart-poll"), request: pollRequest("restart-poll") });
    expect(repolled.outcome).toBe("offer");
    if (repolled.outcome === "offer") {
      expect(repolled.body.job.attempt).toBe(2);
      expect(repolled.body.leaseId).not.toBe(offer.leaseId);
      expect(repolled.body.fenceToken).not.toBe(offer.fenceToken);
    }
  }, 60_000);

  it("a disconnect AFTER a winning terminal (succeeded) finalizes the job and never retries", async () => {
    const f = ctx();
    const { admin } = f;
    const reconciliation = createJobReconciliationService({ appDb: f.app.db });
    const { seeded, offer } = await f.activateLease(6_103);
    // The worker committed a winning terminal (JOB-005 projection) then vanished.
    await admin`UPDATE job_attempts SET status = 'succeeded' WHERE id = ${seeded.attemptId}`;
    await expireLease(offer.leaseId);

    const result = await reconciliation.reapOrganization(ORG);
    expect(result.finalized).toBe(1);
    // MIG-002 N1: a finalized job IS terminal, so its run needs a terminal projected.
    expect(result.terminalized).toHaveLength(1);
    expect(result.terminalized[0]).toMatchObject({ terminalStatus: "succeeded" });
    expect(result.retried).toBe(0);
    const state = await jobState(seeded.jobId);
    expect(state.status).toBe("succeeded");
    expect(state.attempts).toBe(1); // no retry attempt was minted
  }, 60_000);

  it("a late worker mutation on the revoked fence is refused (cannot overwrite the winner)", async () => {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db, baseBackoffMs: 0 });
    const { identity, offer, seeded } = await f.activateLease(6_104);
    await expireLease(offer.leaseId);
    await reconciliation.reapOrganization(ORG);

    // The disconnected worker tries to complete on the reaped fence. The guard refuses
    // it — attempt_terminal (the reaper marked the attempt terminal) or stale_fence
    // (the lease is revoked); either way the winner stands and nothing is overwritten.
    let refusalCode: string | undefined;
    await expect(runInTenant(f.app.db, ORG, async (repos) =>
      repos.jobControl.completeAttempt({ ...identity, terminalStatus: "succeeded" }),
    ).catch((error: { code?: string }) => {
      refusalCode = error.code;
      throw error;
    })).rejects.toBeInstanceOf(Error);
    expect(["stale_fence", "attempt_terminal"]).toContain(refusalCode);

    // The reaped attempt 1 is still terminal 'expired' — the late "succeeded" did NOT land.
    const [attempt1] = await f.admin<{ status: string }[]>`
      SELECT status FROM job_attempts WHERE id = ${seeded.attemptId}`;
    expect(attempt1?.status).toBe("expired");
  }, 60_000);

  it("retry exhaustion alone dead-letters (max_attempts = 1) with an explicit reason and no new attempt", async () => {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db });
    const { seeded, offer } = await f.activateLease(6_105, { maxAttempts: 1 });
    await expireLease(offer.leaseId);

    const result = await reconciliation.reapOrganization(ORG);
    expect(result.deadLettered).toBe(1);
    expect(result.retried).toBe(0);
    const state = await jobState(seeded.jobId);
    expect(state.status).toBe("dead_letter");
    expect(state.deadLetterReason).toBe("retry_exhausted");
    expect(state.attempts).toBe(1);
    expect(await attemptByNumber(seeded.jobId, 2)).toBeNull();
  }, 60_000);

  it("a cancelled job converges to cancelled on reap (no retry), and the fence is revoked", async () => {
    const f = ctx();
    const { admin } = f;
    const reconciliation = createJobReconciliationService({ appDb: f.app.db });
    const { seeded, offer } = await f.activateLease(6_106);
    await reconciliation.requestCancellation({
      organizationId: ORG, companyId: COMPANY, jobId: seeded.jobId, reason: "stop", graceful: true,
    });
    await expireLease(offer.leaseId);

    const result = await reconciliation.reapOrganization(ORG);
    expect(result.cancelled).toBe(1);
    // MIG-002 N1: cancellation is terminal too, and must map to the frozen `cancelled`.
    expect(result.terminalized).toHaveLength(1);
    expect(result.terminalized[0]).toMatchObject({ terminalStatus: "cancelled" });
    expect(result.retried).toBe(0);
    const state = await jobState(seeded.jobId);
    expect(state.status).toBe("cancelled");
    expect(state.attempts).toBe(1);
    expect((await attemptByNumber(seeded.jobId, 1))?.status).toBe("cancelled");
    const [lease] = await admin<{ status: string }[]>`SELECT status FROM leases WHERE id = ${offer.leaseId}`;
    expect(lease?.status).toBe("revoked");
  }, 60_000);

  it("two concurrent retry creators produce EXACTLY one attempt N+1 and one ready row (the loser observes it)", async () => {
    const f = ctx();
    const { admin } = f;
    const { seeded } = await f.activateLease(6_107);
    // Simulate a reaped-but-not-yet-retried attempt: attempt 1 is terminal, no successor.
    await admin`UPDATE job_attempts SET status = 'expired' WHERE id = ${seeded.attemptId}`;

    const now = new Date();
    const allocate = () => runInTenant(f.app.db, ORG, async (repos) =>
      repos.jobControl.allocateRetryAttempt({
        organizationId: ORG,
        companyId: COMPANY,
        jobId: seeded.jobId,
        reapedAttemptId: seeded.attemptId,
        reapedAttemptNumber: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        now,
      }));
    const [a, b] = await Promise.all([allocate(), allocate()]);

    // Exactly one creator wins; the other idempotently observes the successor.
    expect([a.status, b.status].filter((s) => s === "created")).toHaveLength(1);
    expect([a.status, b.status].filter((s) => s === "created" || s === "not_latest" || s === "observed")).toHaveLength(2);
    expect(await jobState(seeded.jobId)).toMatchObject({ attempts: 2 });
    const attempt2 = await attemptByNumber(seeded.jobId, 2);
    expect(attempt2?.status).toBe("pending");
    expect(await outboxCount(attempt2!.id)).toBe(1);
  }, 60_000);

  // ─── MIG-002 convergence (N1/N2) ───────────────────────────────────────────
  // The reaper terminalizes attempts, but `onAttemptTerminal` has exactly ONE producer (the
  // worker's event batch), so a reaped attempt leaves its heartbeat run pinned at `running`.
  // To project a run terminal, the sweeper needs to know WHICH attempts were terminalized —
  // and the result carried counts only. The reaper already selects the identities it needs
  // (`{id, companyId, jobId, attemptId, attemptNumber}` under SKIP LOCKED) and discarded them.
  //
  // N2 is the sharp one: a reaped lease can end in a RETRY, where the job runs again. Listing
  // a retried attempt would make the sweeper project a run terminal for work that is about to
  // execute — a two-executor bug manufactured by the fix.
  it("N1/N2 lists the attempts it TERMINALIZED, and never a retried one", async () => {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db, baseBackoffMs: 5_000 });

    // (a) abandoned WITH a retry available -> job runs again -> must NOT be listed.
    const retried = await f.activateLease(6_401);
    await expireLease(retried.offer.leaseId);
    const retryResult = await reconciliation.reapOrganization(ORG);
    expect(retryResult.retried).toBe(1);
    expect(
      retryResult.terminalized,
      "a retried attempt's job is about to run again; projecting a run terminal for it would " +
        "leave two executors",
    ).toEqual([]);

    // (b) retry EXHAUSTED -> dead-letter -> terminal, and reported as `failed`.
    const dead = await f.activateLease(6_402, { maxAttempts: 1 });
    await expireLease(dead.offer.leaseId);
    const deadResult = await reconciliation.reapOrganization(ORG);
    expect(deadResult.deadLettered).toBe(1);
    expect(deadResult.terminalized).toHaveLength(1);
    expect(deadResult.terminalized[0]).toMatchObject({
      jobId: dead.seeded.jobId,
      attemptId: dead.seeded.attemptId,
      terminalStatus: "failed",
    });
    expect(deadResult.terminalized[0]?.companyId).toBeTruthy();
  }, 90_000);

  it("the sweeper is flag-gated, single-in-flight, and idempotent across duplicate ticks", async () => {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db, baseBackoffMs: 0 });
    const { seeded, offer } = await f.activateLease(6_108);
    await expireLease(offer.leaseId);
    const listAdmittedOrganizationIds = async () => [ORG];

    // Flag-off: a no-op tick that never touches the database.
    const disabled = createJobControlSweeper({ reconciliation, listAdmittedOrganizationIds, enabled: false });
    expect(await disabled.tick()).toMatchObject({ organizations: 0, revoked: 0, retried: 0 });
    expect((await attemptByNumber(seeded.jobId, 1))?.status).toBe("leased"); // untouched

    // Flag-on: one tick reaps the abandoned lease; a re-entrant tick is the SAME promise.
    const sweeper = createJobControlSweeper({ reconciliation, listAdmittedOrganizationIds, enabled: true });
    const first = sweeper.tick();
    const reentrant = sweeper.tick();
    expect(reentrant).toBe(first);
    const firstResult = await first;
    expect(firstResult.revoked).toBe(1);
    expect(firstResult.retried).toBe(1);

    // A duplicate sweep is idempotent: no expired lease remains, so nothing is reaped again.
    const second = await sweeper.tick();
    expect(second.revoked).toBe(0);
    expect(second.retried).toBe(0);
    expect((await jobState(seeded.jobId)).attempts).toBe(2); // still exactly one retry
  }, 60_000);
});
