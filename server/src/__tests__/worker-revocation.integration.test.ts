// server/src/__tests__/worker-revocation.integration.test.ts
//
// JOB-007 — worker/target revocation via generation cutoff. Proves, against real
// embedded Postgres:
//   * revocation bumps the target's device_generation, disables it, and writes ONE
//     durable operator record;
//   * the committed cutoff DENIES every governed guard on the old fence IMMEDIATELY
//     (before any fanout) — renew/events/secrets/complete/projection/health/control-ACK
//     all refuse `target_revoked` through the locked current-generation recheck;
//   * the fanout marks matching old-generation leases `revoked`, releases their
//     capacity slot, and requests attempt cancellation — idempotently;
//   * a crash after the cutoff but before the fanout still denies old-generation
//     effects; a restart resumes the durable idempotent scan to convergence;
//   * a capacity slot is released exactly once (no double-release across fanout re-runs).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createExecutionTargetRevocationFanout } from "../services/execution-target-revocation-fanout.js";
import { ensureExecutionTargetCutoff, revokeExecutionTarget } from "../services/execution-targets.js";
import { createJobReconciliationService } from "../services/job-reconciliation.js";
import { admitAttemptCapacity, countHeldAttemptsForOrg } from "../services/org-concurrency.js";
import { runInTenant } from "../db/tenant-context.js";
import {
  COMPANY,
  ORG,
  TARGET,
  setupJobControlFixture,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";
import type { ActiveFenceRequest } from "@armyofagents/db";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

integration("JOB-007 worker/target revocation via generation cutoff", () => {
  let fx: JobControlFixture | null = null;
  let setupError: unknown = null;

  function ctx(): JobControlFixture {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!fx) throw new Error("fixture not initialized");
    return fx;
  }

  async function clearRevocations(): Promise<void> {
    await ctx().admin`DELETE FROM execution_target_revocations`;
  }

  function fanout() {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db });
    return createExecutionTargetRevocationFanout({
      appDb: f.app.db,
      operatorDb: f.operator.db,
      reconciliation,
      listAdmittedOrganizationIds: async () => [ORG],
    });
  }

  /** Run one governed mutator on the (now-stale) fence and return its refusal code. */
  async function guardCode(
    label: string,
    call: (identity: ActiveFenceRequest, repos: import("@armyofagents/db").TenantRepositories) => Promise<unknown>,
    identity: ActiveFenceRequest,
  ): Promise<string> {
    const f = ctx();
    try {
      await runInTenant(f.app.db, ORG, async (repos) => call(identity, repos));
      return `${label}:NO_ERROR`;
    } catch (error) {
      return (error as { code?: string }).code ?? `${label}:${String(error)}`;
    }
  }

  async function targetGeneration(): Promise<number> {
    const [row] = await ctx().admin<{ g: number }[]>`
      SELECT device_generation AS g FROM execution_targets WHERE id = ${TARGET}`;
    return Number(row!.g);
  }

  async function leaseStatus(leaseId: string): Promise<string | null> {
    const [row] = await ctx().admin<{ status: string }[]>`SELECT status FROM leases WHERE id = ${leaseId}`;
    return row?.status ?? null;
  }

  beforeAll(async () => {
    try {
      fx = await setupJobControlFixture("worker-revocation");
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await fx?.teardown();
  }, 60_000);

  it("revocation bumps the target generation, disables it, and writes ONE durable record", async () => {
    const f = ctx();
    await clearRevocations();
    await f.activateLease(7_201);
    expect(await targetGeneration()).toBe(1);

    const result = await revokeExecutionTarget({
      appDb: f.app.db,
      operatorDb: f.operator.db,
      targetId: TARGET,
      organizationId: ORG,
      reason: "device_compromised",
    });
    expect(result).toMatchObject({ revoked: true, revokedGeneration: 1, targetScope: "organization" });
    expect(await targetGeneration()).toBe(2);

    const [target] = await f.admin<{ status: string }[]>`SELECT status FROM execution_targets WHERE id = ${TARGET}`;
    expect(target?.status).toBe("disabled");

    const records = await f.admin<{ target_id: string; revoked_generation: number; status: string }[]>`
      SELECT target_id, revoked_generation, status FROM execution_target_revocations WHERE target_id = ${TARGET}`;
    expect(records).toEqual([{ target_id: TARGET, revoked_generation: 1, status: "pending" }]);

    // Re-invoking is a no-op (already disabled) — no second record, no further bump.
    const again = await revokeExecutionTarget({
      appDb: f.app.db, operatorDb: f.operator.db, targetId: TARGET, organizationId: ORG,
    });
    expect(again).toMatchObject({ revoked: false, reason: "already_disabled" });
    expect(await targetGeneration()).toBe(2);
  }, 60_000);

  it("the committed cutoff DENIES every governed guard on the old fence IMMEDIATELY (before fanout)", async () => {
    const f = ctx();
    await clearRevocations();
    const { identity } = await f.activateLease(7_202);

    // Cutoff commits; NO fanout runs yet (simulating a crash after cutoff, before fanout).
    await revokeExecutionTarget({
      appDb: f.app.db, operatorDb: f.operator.db, targetId: TARGET, organizationId: ORG,
    });

    // Every governed mutator gates on the fence guard, whose locked current-generation
    // recheck now refuses the old fence `target_revoked` — the instant the cutoff commits.
    const codes = await Promise.all([
      guardCode("renew", (id, repos) => repos.jobControl.renewLease({
        ...id, leaseDurationMs: 300_000, idempotencyKey: randomUUID(), semanticDigest: "d".repeat(64),
        // JOB-015 — the fence guard runs BEFORE any control read, so this projector is
        // never reached on a revoked fence. Throwing proves that: if the guard ever
        // stopped preceding the projection, this case would fail loudly instead of
        // quietly renewing.
        projectControlExtensions: () => { throw new Error("projector must not run on a revoked fence"); },
      }), identity),
      guardCode("events", (id, repos) => repos.jobControl.acceptEvent({ ...id }), identity),
      guardCode("secrets", (id, repos) => repos.jobControl.readSecretHandle({ ...id, handle: "h" }), identity),
      guardCode("upload", (id, repos) => repos.jobControl.authorizeArtifactCommit({ ...id, identifier: "artifact-1" }), identity),
      guardCode("complete", (id, repos) => repos.jobControl.completeAttempt({ ...id, terminalStatus: "succeeded" }), identity),
      guardCode("projection", (id, repos) => repos.jobControl.applyProjectionReceipt({ ...id }), identity),
      guardCode("health", (id, repos) => repos.jobControl.recordServiceHealth({
        ...id, serviceInstanceId: randomUUID(), healthStatus: "healthy",
      }), identity),
      guardCode("control_ack", (id, repos) => repos.jobControl.ackControlCommand({ ...id }), identity),
    ]);
    expect(codes).toEqual([
      "target_revoked", "target_revoked", "target_revoked", "target_revoked",
      "target_revoked", "target_revoked", "target_revoked", "target_revoked",
    ]);

    // The lease is still 'active' in the row (fanout has not run) — denial came purely
    // from the generation recheck, proving the cutoff is the gate and fanout is convergence.
    const [lease] = await f.admin<{ status: string }[]>`
      SELECT status FROM leases WHERE target_id = ${TARGET} ORDER BY created_at DESC LIMIT 1`;
    expect(lease?.status).toBe("active");
  }, 60_000);

  it("the fanout marks old-generation leases revoked, releases capacity, and cancels — idempotently", async () => {
    const f = ctx();
    await clearRevocations();
    const { seeded, offer } = await f.activateLease(7_203);
    // Claim the attempt's capacity so the fanout has a slot to release exactly once.
    await runInTenant(f.app.db, ORG, async (_repos, tx) => admitAttemptCapacity(tx, {
      organizationId: ORG, companyId: COMPANY, workloadType: "batch", attemptId: seeded.attemptId,
      principalId: "worker-revocation-test", principalKind: "system",
    }));
    const [held] = await f.admin<{ state: string }[]>`
      SELECT capacity_claim_state AS state FROM job_attempts WHERE id = ${seeded.attemptId}`;
    expect(held?.state).toBe("held");

    await revokeExecutionTarget({
      appDb: f.app.db, operatorDb: f.operator.db, targetId: TARGET, organizationId: ORG,
    });

    const first = await fanout().tick();
    expect(first).toMatchObject({ records: 1, leasesRevoked: 1, cancellations: 1, completed: 1 });
    expect(await leaseStatus(offer.leaseId)).toBe("revoked");

    // The job converged to cancelled and the capacity slot was released.
    const [job] = await f.admin<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${seeded.jobId}`;
    expect(job?.status).toBe("cancelled");
    const [attempt] = await f.admin<{ state: string }[]>`
      SELECT capacity_claim_state AS state FROM job_attempts WHERE id = ${seeded.attemptId}`;
    expect(attempt?.state).toBe("released");

    // The durable record is completed; a re-tick is an idempotent no-op (no re-processing,
    // no double-release, no second cancellation).
    const second = await fanout().tick();
    expect(second).toMatchObject({ records: 0, leasesRevoked: 0, cancellations: 0, completed: 0 });
    expect(await leaseStatus(offer.leaseId)).toBe("revoked");
    const [recovered] = await f.admin<{ status: string }[]>`
      SELECT status FROM execution_target_revocations WHERE target_id = ${TARGET}`;
    expect(recovered?.status).toBe("completed");
  }, 60_000);

  it("crash after cutoff / before fanout: restart resumes the durable scan to convergence", async () => {
    const f = ctx();
    await clearRevocations();
    const { seeded, offer, identity } = await f.activateLease(7_204);

    // Cutoff commits. Then a "crash": no fanout runs. The durable record is 'pending'.
    await revokeExecutionTarget({
      appDb: f.app.db, operatorDb: f.operator.db, targetId: TARGET, organizationId: ORG,
    });
    const [pending] = await f.admin<{ status: string }[]>`
      SELECT status FROM execution_target_revocations WHERE target_id = ${TARGET}`;
    expect(pending?.status).toBe("pending");

    // Even with no fanout, the old fence cannot complete (generation recheck is the gate).
    expect(await guardCode("complete", (id, repos) =>
      repos.jobControl.completeAttempt({ ...id, terminalStatus: "succeeded" }), identity)).toBe("target_revoked");

    // Restart: the fanout resumes the durable idempotent scan and converges the tenant.
    const resumed = await fanout().tick();
    expect(resumed).toMatchObject({ records: 1, leasesRevoked: 1, completed: 1 });
    expect(await leaseStatus(offer.leaseId)).toBe("revoked");
    const [job] = await f.admin<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${seeded.jobId}`;
    expect(job?.status).toBe("cancelled");
  }, 60_000);

  it("the cutoff disables the target even when the live generation advanced past the revoked generation (finding-1 race)", async () => {
    const f = ctx();
    await clearRevocations();
    await f.activateLease(7_205);
    expect(await targetGeneration()).toBe(1);

    // Simulate a concurrent re-enrollment (advanceTargetGeneration) that slipped in AFTER
    // the revoke read generation=1 but BEFORE the cutoff runs: the live generation is now 2
    // and the target is STILL active.
    await f.admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET}`;
    const [mid] = await f.admin<{ status: string; g: number }[]>`
      SELECT status, device_generation AS g FROM execution_targets WHERE id = ${TARGET}`;
    expect(mid).toMatchObject({ status: "active" });
    expect(Number(mid!.g)).toBe(2);

    // The cutoff (called by the revoke with the now-STALE revokedGeneration=1) must STILL
    // disable the target. An exact-generation CAS (WHERE device_generation = 1) would match
    // no row here and silently no-op, leaving the target ACTIVE at generation 2 — the
    // lost-revocation / false-success defect.
    await ensureExecutionTargetCutoff({
      appDb: f.app.db, operatorDb: f.operator.db, targetId: TARGET, organizationId: ORG, revokedGeneration: 1,
    });
    const [after] = await f.admin<{ status: string; g: number }[]>`
      SELECT status, device_generation AS g FROM execution_targets WHERE id = ${TARGET}`;
    expect(after?.status).toBe("disabled");
    expect(Number(after!.g)).toBe(3);

    // Idempotent: a re-ensure once disabled does NOT bump again (no runaway self-increment).
    await ensureExecutionTargetCutoff({
      appDb: f.app.db, operatorDb: f.operator.db, targetId: TARGET, organizationId: ORG, revokedGeneration: 1,
    });
    expect(await targetGeneration()).toBe(3);
  }, 60_000);

  it("a resumed tick cancels a job whose lease was already revoked before a Phase-2 crash (finding-2)", async () => {
    const f = ctx();
    await clearRevocations();
    const { seeded, offer } = await f.activateLease(7_206);

    await revokeExecutionTarget({
      appDb: f.app.db, operatorDb: f.operator.db, targetId: TARGET, organizationId: ORG,
    });

    // Simulate: the fanout's Phase 1 committed (the lease was flipped to `revoked` and the
    // record set `converging`), then the process CRASHED before Phase 2 requested job
    // cancellation. The job is still non-terminal.
    await f.admin`UPDATE leases SET status = 'revoked', released_at = clock_timestamp() WHERE id = ${offer.leaseId}`;
    await f.admin`UPDATE execution_target_revocations SET status = 'converging' WHERE target_id = ${TARGET}`;
    const [beforeJob] = await f.admin<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${seeded.jobId}`;
    expect(beforeJob?.status).not.toBe("cancelled");

    // The resumed tick must re-derive the cancellation from the already-`revoked` lease and
    // finalize the job. If convergence only collects freshly-flipped offered/active leases,
    // the already-revoked lease is skipped, Phase 2 never runs, and the job strands
    // non-terminal forever (the reaper only scans offered/active leases).
    const resumed = await fanout().tick();
    expect(resumed.cancellations).toBeGreaterThanOrEqual(1);
    const [job] = await f.admin<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${seeded.jobId}`;
    expect(job?.status).toBe("cancelled");
    const [rec] = await f.admin<{ status: string }[]>`
      SELECT status FROM execution_target_revocations WHERE target_id = ${TARGET}`;
    expect(rec?.status).toBe("completed");
  }, 60_000);

  it("converges a LEASE-LESS held retry successor pinned to the revoked target (MIG-002 strand)", async () => {
    const f = ctx();
    await clearRevocations();

    // Build the strand the MIG-002 reaper mints WITHOUT a lease: `allocateRetry` copies
    // the revoked target's placement (placementTargetId/placementTargetGeneration=1)
    // VERBATIM into a NEW `pending` attempt and, since the reaped attempt was held,
    // stamps it `capacityClaimState:'held'`. Reproduce that shape directly: a placed,
    // NONTERMINAL, LEASE-LESS attempt holding an Organization capacity slot.
    await f.resetRuntimeRows();
    const seeded = await f.seedPlacedJob(7_207);
    await runInTenant(f.app.db, ORG, async (_repos, tx) => admitAttemptCapacity(tx, {
      organizationId: ORG, companyId: COMPANY, workloadType: "batch", attemptId: seeded.attemptId,
      principalId: "worker-revocation-test", principalKind: "system",
    }));

    // Precondition: the attempt is pending, holds a slot, and has NO lease row of any kind.
    const [before] = await f.admin<{ status: string; state: string }[]>`
      SELECT status, capacity_claim_state AS state FROM job_attempts WHERE id = ${seeded.attemptId}`;
    expect(before).toMatchObject({ status: "pending", state: "held" });
    const [leaseCount] = await f.admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM leases WHERE attempt_id = ${seeded.attemptId}`;
    expect(Number(leaseCount!.n)).toBe(0);
    // countHeldAttemptsForOrg reads under RLS, so run it inside the org tenant context.
    const heldBefore = await runInTenant(f.app.db, ORG, async (_repos, tx) =>
      countHeldAttemptsForOrg(tx as unknown as typeof f.app.db, ORG));
    expect(heldBefore).toBe(1);

    await revokeExecutionTarget({
      appDb: f.app.db, operatorDb: f.operator.db, targetId: TARGET, organizationId: ORG,
    });

    // ONE tick. The lease pass finds no lease for this attempt, but the attempt-convergence
    // pass locates it by its pinned placement, terminalizes it, releases the held slot, and
    // hands the job to Phase-2 cancellation. Without that pass the job is never collected
    // (no live lease), so the record completes while the attempt strands `held` forever.
    const result = await fanout().tick();
    expect(result).toMatchObject({ records: 1, completed: 1 });
    expect(result.cancellations).toBeGreaterThanOrEqual(1);

    const [attempt] = await f.admin<{ status: string; state: string }[]>`
      SELECT status, capacity_claim_state AS state FROM job_attempts WHERE id = ${seeded.attemptId}`;
    expect(attempt).toMatchObject({ status: "cancelled", state: "released" });
    const heldAfter = await runInTenant(f.app.db, ORG, async (_repos, tx) =>
      countHeldAttemptsForOrg(tx as unknown as typeof f.app.db, ORG));
    expect(heldAfter).toBe(0);

    const [job] = await f.admin<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${seeded.jobId}`;
    expect(job?.status).toBe("cancelled");
    const [rec] = await f.admin<{ status: string }[]>`
      SELECT status FROM execution_target_revocations WHERE target_id = ${TARGET}`;
    expect(rec?.status).toBe("completed");
  }, 60_000);
});
