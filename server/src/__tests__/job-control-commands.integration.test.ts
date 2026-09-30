import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LeaseOfferV1, LeaseRenewOperationRequestV1 } from "@armyofagents/worker-protocol";
import { controlCommandV1Schema } from "@armyofagents/worker-protocol";
import { CONTROL_EXTENSION_NAMESPACE } from "../services/control-command-projection.js";
import { createJobReconciliationService } from "../services/job-reconciliation.js";
import { createJobLeaseRenewalService } from "../services/job-fencing.js";
import { runInTenant } from "../db/tenant-context.js";
import {
  auth,
  COMPANY,
  ORG,
  WORKER,
  setupJobControlFixture,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

function renewRequest(offer: LeaseOfferV1): LeaseRenewOperationRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `renew-${crypto.randomUUID()}`,
    audience: "worker_run",
    idempotencyKey: crypto.randomUUID(),
    body: {
      protocolVersion: 1,
      workerId: offer.workerId,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      observedAt: new Date().toISOString(),
      extensions: [],
    },
  };
}

integration("JOB-006 durable control commands + ACK", () => {
  let fx: JobControlFixture | null = null;
  let setupError: unknown = null;

  function ctx(): JobControlFixture {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!fx) throw new Error("fixture not initialized");
    return fx;
  }

  async function commandRows(leaseId: string) {
    const { admin } = ctx();
    return admin<{ commandId: string; commandSeq: number; commandKind: string; ackStatus: string | null }[]>`
      SELECT command_id AS "commandId", command_seq AS "commandSeq", command_kind AS "commandKind",
        ack_status AS "ackStatus"
      FROM job_control_commands WHERE lease_id = ${leaseId} ORDER BY command_seq`;
  }

  async function jobAttemptStatus(jobId: string, attemptId: string) {
    const { admin } = ctx();
    const [row] = await admin<{ jobStatus: string; attemptStatus: string }[]>`SELECT
      (SELECT status FROM jobs WHERE id = ${jobId}) AS "jobStatus",
      (SELECT status FROM job_attempts WHERE id = ${attemptId}) AS "attemptStatus"`;
    return row!;
  }

  beforeAll(async () => {
    try {
      fx = await setupJobControlFixture("job-control-commands");
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await fx?.teardown();
  }, 60_000);

  it("queues ONE monotonically-sequenced cancel command bound to the active fence and marks the requested state", async () => {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db });
    const { seeded, offer } = await f.activateLease(6_001);

    const outcome = await reconciliation.requestCancellation({
      organizationId: ORG,
      companyId: COMPANY,
      jobId: seeded.jobId,
      reason: "operator stopped it",
      graceful: true,
    });
    expect(outcome.status).toBe("queued");
    expect(outcome.command?.commandKind).toBe("cancel");
    expect(outcome.command?.commandSeq).toBe(1);
    expect(outcome.command?.fenceToken).toBe(offer.fenceToken);
    expect(outcome.command?.ackStatus).toBeNull();

    // The requested state is marked; exactly one durable command row exists.
    expect(await jobAttemptStatus(seeded.jobId, seeded.attemptId)).toEqual({
      jobStatus: "cancel_requested", attemptStatus: "cancel_requested",
    });
    const rows = await commandRows(offer.leaseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ commandSeq: 1, commandKind: "cancel", ackStatus: null });
  }, 60_000);

  it("finalizes cancellation to terminal 'cancelled' when the job has NO active lease (no cancel_requested hang)", async () => {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db });
    // A placed-but-unleased attempt: queued job, attempt 'pending', NO lease. The reaper's
    // expired-lease scan never reaches it and claimReadyOutbox won't dispatch a
    // cancel_requested job, so cancellation MUST finalize inline (else it hangs forever).
    const seeded = await f.seedPlacedJob(6_050);
    const outcome = await reconciliation.requestCancellation({
      organizationId: ORG,
      companyId: COMPANY,
      jobId: seeded.jobId,
      reason: "operator stopped an unleased job",
      graceful: true,
    });
    expect(outcome.status).toBe("cancelled");
    expect(outcome.command).toBeNull();
    // Converged to TERMINAL cancelled — not left in cancel_requested.
    expect(await jobAttemptStatus(seeded.jobId, seeded.attemptId)).toEqual({
      jobStatus: "cancelled", attemptStatus: "cancelled",
    });
  }, 60_000);

  it("replays the SAME cancel command idempotently (no second row) on a re-request", async () => {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db });
    const { seeded, offer } = await f.activateLease(6_002);

    const first = await reconciliation.requestCancellation({
      organizationId: ORG, companyId: COMPANY, jobId: seeded.jobId, reason: "stop", graceful: true,
    });
    const second = await reconciliation.requestCancellation({
      organizationId: ORG, companyId: COMPANY, jobId: seeded.jobId, reason: "stop again", graceful: false,
    });
    expect(first.status).toBe("queued");
    expect(second.status).toBe("already_requested");
    expect(second.command?.commandId).toBe(first.command?.commandId);
    expect(await commandRows(offer.leaseId)).toHaveLength(1);
  }, 60_000);

  it("surfaces the pending cancel on renew (cancelRequested=true) UNTIL the worker ACKs it", async () => {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db });
    const renewal = createJobLeaseRenewalService({ appDb: f.app.db });
    const { seeded, offer, identity } = await f.activateLease(6_003);

    const outcome = await reconciliation.requestCancellation({
      organizationId: ORG, companyId: COMPANY, jobId: seeded.jobId, reason: "please stop", graceful: true,
    });
    expect(outcome.status).toBe("queued");

    // Renew (active fence: attempt is cancel_requested, NOT terminal) → cancelRequested surfaces.
    const renewed = await renewal.renew({ auth: auth("renew-cancel-1"), request: renewRequest(offer) });
    expect(renewed.outcome).toBe("renewed");
    if (renewed.outcome === "renewed") {
      expect(renewed.body.cancelRequested).toBe(true);
      expect(renewed.body.cancelReason).toBe("please stop");
    }

    // Worker ACKs the command → the durable ack_status is recorded.
    const commandId = outcome.command!.commandId;
    const ack = await runInTenant(f.app.db, ORG, async (repos) => repos.jobControl.ackControlCommand({
      ...identity,
      ack: { commandId, commandSeq: 1, status: "completed", observedAt: new Date(), detail: null },
    }));
    expect(ack.guarded).toBe(true);
    expect(ack.ackOutcome?.applied).toBe(true);

    // A later renew no longer surfaces the (now ACKed) control.
    const afterAck = await renewal.renew({ auth: auth("renew-cancel-2"), request: renewRequest(offer) });
    expect(afterAck.outcome).toBe("renewed");
    if (afterAck.outcome === "renewed") expect(afterAck.body.cancelRequested).toBe(false);
    const [row] = await commandRows(offer.leaseId);
    expect(row?.ackStatus).toBe("completed");
  }, 60_000);

  it("records the worker ACK idempotently: first terminal ACK wins, replay is a no-op", async () => {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db });
    const { seeded, offer, identity } = await f.activateLease(6_004);
    const outcome = await reconciliation.requestCancellation({
      organizationId: ORG, companyId: COMPANY, jobId: seeded.jobId, reason: "stop", graceful: true,
    });
    const commandId = outcome.command!.commandId;
    const ackWith = (status: "accepted" | "completed" | "rejected") =>
      runInTenant(f.app.db, ORG, async (repos) => repos.jobControl.ackControlCommand({
        ...identity,
        ack: { commandId, commandSeq: 1, status, observedAt: new Date(), detail: null },
      }));

    // accepted → completed is allowed; a later different status cannot overwrite a terminal ACK.
    expect((await ackWith("accepted")).ackOutcome).toEqual({ applied: true, status: "accepted" });
    expect((await ackWith("completed")).ackOutcome).toEqual({ applied: true, status: "completed" });
    expect((await ackWith("rejected")).ackOutcome).toEqual({ applied: false, status: "rejected" });
    // A replay of the winning terminal status is idempotent (still applies the same value).
    expect((await ackWith("completed")).ackOutcome).toEqual({ applied: true, status: "completed" });

    const [row] = await commandRows(offer.leaseId);
    expect(row?.ackStatus).toBe("completed");
  }, 60_000);

  it("enforces the monotonic per-lease sequence uniqueness (no two commands share a sequence)", async () => {
    const f = ctx();
    const { admin } = f;
    const { seeded, offer } = await f.activateLease(6_005);
    await createJobReconciliationService({ appDb: f.app.db }).requestCancellation({
      organizationId: ORG, companyId: COMPANY, jobId: seeded.jobId, reason: "stop", graceful: true,
    });
    // A second command re-using command_seq = 1 on the same lease violates the unique index.
    await expect(admin`INSERT INTO job_control_commands
      (organization_id, company_id, job_id, attempt_id, attempt_number, lease_id, command_id,
       command_seq, command_kind, fence_token, command)
      VALUES (${ORG}, ${COMPANY}, ${seeded.jobId}, ${seeded.attemptId}, 1, ${offer.leaseId},
        ${crypto.randomUUID()}, 1, 'drain', ${offer.fenceToken}, ${{ commandKind: "drain" }})`)
      .rejects.toMatchObject({ constraint_name: "job_control_commands_org_lease_seq_uq" });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// JOB-015 — control-command DELIVERY, end to end against a real lease fence.
//
// ★ Slice (a) THE PIN. The first test below was RED on the pre-JOB-015 mutator, which
// hardcoded `extensions: []` and filtered the queue to cancel/graceful_stop: a queued
// `drain` or `runtime_decision_result` was invisible to a renewing worker no matter how
// many times it renewed. Without a test that failed against that, the green suite after
// the fix would prove nothing at all.
// ---------------------------------------------------------------------------

integration("JOB-015 control-command delivery on the lease-renew response", () => {
  let fx: JobControlFixture | null = null;
  let setupError: unknown = null;

  function ctx(): JobControlFixture {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!fx) throw new Error("fixture not initialized");
    return fx;
  }

  interface ControlValue {
    commands: Record<string, unknown>[];
    pendingCount: number;
    truncated: boolean;
    oversizedLeading?: { commandId: string; commandSeq: number };
  }

  function controlExtension(body: Record<string, unknown>): ControlValue | null {
    const extensions = (body.extensions ?? []) as { namespace?: string; value?: unknown }[];
    const found = extensions.find((extension) => extension.namespace === CONTROL_EXTENSION_NAMESPACE);
    return found ? (found.value as ControlValue) : null;
  }

  /** The E1 body `job-approval-bridge.ts` hands `queueGovernedControlCommand` — built
   * here the way the bridge's private `buildControlCommandBody` builds it, and parsed
   * against the FROZEN schema so a fixture can never store a shape production cannot
   * produce. `commandSeq` is a placeholder: the repository stamps the lease-allocated
   * one, which is exactly the allocation under test. */
  function governedResultBody(
    seeded: { jobId: string },
    leaseId: string,
    fenceToken: string,
    commandId: string,
  ): Record<string, unknown> {
    return controlCommandV1Schema.parse({
      protocolVersion: 1,
      audience: "control_channel",
      commandId,
      commandSeq: 1,
      idempotencyKey: commandId,
      issuedAt: new Date().toISOString(),
      nonce: `nonce-${commandId}`,
      organizationId: ORG,
      companyId: COMPANY,
      workerId: WORKER,
      jobId: seeded.jobId,
      attempt: 1,
      leaseId,
      fenceToken,
      commandKind: "runtime_decision_result",
      result: {
        decisionKind: "permission",
        requestId: crypto.randomUUID(),
        nonce: "decision-nonce",
        requestDigest: "a".repeat(64),
        schemaVersion: 1,
        sourceRevision: 0,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        decidedBy: { principalType: "user", principalId: "operator-1" },
        decidedAt: new Date().toISOString(),
        idempotencyKey: crypto.randomUUID(),
        timeoutPolicy: "deny",
        decision: "deny",
      },
    }) as unknown as Record<string, unknown>;
  }

  // Insert a control command of an arbitrary kind directly. There is no production
  // writer for `drain` — the two insert sites are `requestCancellation` (which
  // hardcodes `cancel`) and `queueGovernedControlCommand` (typed to the two result
  // kinds) — so every `drain` exercised below is a row this test wrote. That gap is
  // stated in JOB-015-result.md §5; the DELIVERY path it exercises is real.
  async function queueRaw(
    seeded: { jobId: string; attemptId: string },
    leaseId: string,
    fenceToken: string,
    kind: string,
    seq: number,
  ): Promise<string> {
    const { admin } = ctx();
    const commandId = crypto.randomUUID();
    // A body the FROZEN schema accepts. The worker re-validates every delivered command
    // against `controlCommandV1Schema` (the extension container bounds size and
    // structure, not fields), so a fixture that stored a loose body would be testing a
    // shape production can never produce.
    const wireBody: Record<string, unknown> = {
      protocolVersion: 1,
      audience: "control_channel",
      commandId,
      commandSeq: seq,
      idempotencyKey: commandId,
      issuedAt: new Date().toISOString(),
      nonce: `nonce-${commandId}`,
      organizationId: ORG,
      companyId: COMPANY,
      workerId: WORKER,
      jobId: seeded.jobId,
      attempt: 1,
      leaseId,
      fenceToken,
      commandKind: kind,
      ...(kind === "drain"
        ? { reason: "fleet rollout" }
        : {
          result: {
            decisionKind: "permission",
            requestId: crypto.randomUUID(),
            nonce: "decision-nonce",
            requestDigest: "a".repeat(64),
            schemaVersion: 1,
            sourceRevision: 0,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            decidedBy: { principalType: "user", principalId: "operator-1" },
            decidedAt: new Date().toISOString(),
            idempotencyKey: crypto.randomUUID(),
            timeoutPolicy: "deny",
            decision: "deny",
          },
        }),
    };
    expect(controlCommandV1Schema.safeParse(wireBody).success).toBe(true);
    await admin`INSERT INTO job_control_commands
      (organization_id, company_id, job_id, attempt_id, attempt_number, lease_id, command_id,
       command_seq, command_kind, fence_token, command)
      VALUES (${ORG}, ${COMPANY}, ${seeded.jobId}, ${seeded.attemptId}, 1, ${leaseId},
        ${commandId}, ${seq}, ${kind}, ${fenceToken}, ${wireBody})`;
    return commandId;
  }

  beforeAll(async () => {
    try {
      fx = await setupJobControlFixture("job-015-control-delivery");
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await fx?.teardown();
  }, 60_000);

  it("★ THE PIN — delivers a queued `drain`, which the boolean path could never carry", async () => {
    const f = ctx();
    const renewal = createJobLeaseRenewalService({ appDb: f.app.db });
    const { seeded, offer } = await f.activateLease(6_100);

    // ★ POSITIVE CONTROL FIRST: with nothing queued the response is byte-identical to
    // the pre-JOB-015 hardcoded `extensions: []`. That is what proves this change is
    // inert when it should be.
    const before = await renewal.renew({ auth: auth("j15-renew-0"), request: renewRequest(offer) });
    expect(before.outcome).toBe("renewed");
    if (before.outcome === "renewed") {
      expect(before.body.extensions).toEqual([]);
      expect(controlExtension(before.body)).toBeNull();
    }

    const commandId = await queueRaw(seeded, offer.leaseId, offer.fenceToken, "drain", 1);
    const after = await renewal.renew({ auth: auth("j15-renew-1"), request: renewRequest(offer) });
    expect(after.outcome).toBe("renewed");
    if (after.outcome !== "renewed") return;

    const value = controlExtension(after.body);
    expect(value).not.toBeNull();
    expect(value!.commands).toHaveLength(1);
    expect(value!.commands[0]!.commandId).toBe(commandId);
    expect(value!.commands[0]!.commandKind).toBe("drain");
    expect(value!.truncated).toBe(false);
    expect(value!.pendingCount).toBe(1);
    // ★ D2 — the boolean floor is untouched: a `drain` is NOT a cancel.
    expect(after.body.cancelRequested).toBe(false);
  }, 60_000);

  it("delivers a queued `runtime_decision_result` — the kind two epics are blocked on", async () => {
    const f = ctx();
    const renewal = createJobLeaseRenewalService({ appDb: f.app.db });
    const { seeded, offer } = await f.activateLease(6_101);
    await queueRaw(seeded, offer.leaseId, offer.fenceToken, "runtime_decision_result", 1);

    const renewed = await renewal.renew({ auth: auth("j15-renew-2"), request: renewRequest(offer) });
    expect(renewed.outcome).toBe("renewed");
    if (renewed.outcome !== "renewed") return;
    expect(controlExtension(renewed.body)!.commands[0]!.commandKind).toBe("runtime_decision_result");
  }, 60_000);

  it("delivers cancel on BOTH channels — the boolean floor AND the extension (D2)", async () => {
    const f = ctx();
    const reconciliation = createJobReconciliationService({ appDb: f.app.db });
    const renewal = createJobLeaseRenewalService({ appDb: f.app.db });
    const { seeded, offer } = await f.activateLease(6_102);
    await reconciliation.requestCancellation({
      organizationId: ORG, companyId: COMPANY, jobId: seeded.jobId, reason: "please stop", graceful: true,
    });

    const renewed = await renewal.renew({ auth: auth("j15-renew-3"), request: renewRequest(offer) });
    expect(renewed.outcome).toBe("renewed");
    if (renewed.outcome !== "renewed") return;
    // The boolean an already-deployed worker reads...
    expect(renewed.body.cancelRequested).toBe(true);
    expect(renewed.body.cancelReason).toBe("please stop");
    // ...and the extension an adopting worker reads. Intentional redundancy (D2).
    const delivered = controlExtension(renewed.body)!.commands[0]!;
    expect(delivered.commandKind).toBe("cancel");
    // ★★ THE PRODUCER MUST STORE WHAT THE CONSUMER ACCEPTS. `requestCancellation` builds
    // its `command` jsonb INLINE and never `.parse`s it, while the worker re-validates
    // every delivered body against the frozen `controlCommandV1Schema`. A drift between
    // the two would make every real cancel arrive as a delivery FAULT, and nothing else
    // in the tree would notice: the boolean floor would keep cancelling and the
    // extension would keep failing to read. This is that check.
    const parsed = controlCommandV1Schema.safeParse(delivered);
    expect(parsed.success ? "valid" : JSON.stringify(parsed.error?.issues)).toBe("valid");
  }, 60_000);

  it("stops delivering a command once it is ACKed — the ACK is what suppresses redelivery", async () => {
    const f = ctx();
    const renewal = createJobLeaseRenewalService({ appDb: f.app.db });
    const { seeded, offer, identity } = await f.activateLease(6_103);
    const commandId = await queueRaw(seeded, offer.leaseId, offer.fenceToken, "drain", 1);

    const first = await renewal.renew({ auth: auth("j15-renew-4"), request: renewRequest(offer) });
    expect(first.outcome).toBe("renewed");
    if (first.outcome === "renewed") expect(controlExtension(first.body)!.commands).toHaveLength(1);

    const ack = await runInTenant(f.app.db, ORG, async (repos) => repos.jobControl.ackControlCommand({
      ...identity,
      ack: { commandId, commandSeq: 1, status: "completed", observedAt: new Date(), detail: null },
    }));
    expect(ack.ackOutcome?.applied).toBe(true);

    const second = await renewal.renew({ auth: auth("j15-renew-5"), request: renewRequest(offer) });
    expect(second.outcome).toBe("renewed");
    if (second.outcome !== "renewed") return;
    expect(second.body.extensions).toEqual([]);
    expect(controlExtension(second.body)).toBeNull();
  }, 60_000);

  it("★★★ E3-F035's sibling — an ACK echoing the WRONG commandSeq cannot suppress redelivery", async () => {
    const f = ctx();
    const renewal = createJobLeaseRenewalService({ appDb: f.app.db });
    const { seeded, offer, identity } = await f.activateLease(6_104);
    const commandId = await queueRaw(seeded, offer.leaseId, offer.fenceToken, "drain", 1);

    // The frozen ACK schema has always carried `commandSeq` and its docstring always
    // said the worker echoes it. Before JOB-015 the mutator matched on
    // (organizationId, leaseId, commandId) alone and DISCARDED the sequence.
    const wrong = await runInTenant(f.app.db, ORG, async (repos) => repos.jobControl.ackControlCommand({
      ...identity,
      ack: { commandId, commandSeq: 99, status: "completed", observedAt: new Date(), detail: null },
    }));
    expect(wrong.ackOutcome?.applied).toBe(false);

    // ...and the command is STILL delivered, because `ack_status` is still NULL.
    const stillPending = await renewal.renew({ auth: auth("j15-renew-6"), request: renewRequest(offer) });
    expect(stillPending.outcome).toBe("renewed");
    if (stillPending.outcome !== "renewed") return;
    expect(controlExtension(stillPending.body)!.commands).toHaveLength(1);

    // ★ POSITIVE CONTROL, same test: the MATCHING sequence succeeds. Without it a
    // predicate that rejected everything would look like working validation.
    const right = await runInTenant(f.app.db, ORG, async (repos) => repos.jobControl.ackControlCommand({
      ...identity,
      ack: { commandId, commandSeq: 1, status: "completed", observedAt: new Date(), detail: null },
    }));
    expect(right.ackOutcome?.applied).toBe(true);
    const drained = await renewal.renew({ auth: auth("j15-renew-7"), request: renewRequest(offer) });
    expect(drained.outcome).toBe("renewed");
    if (drained.outcome === "renewed") expect(drained.body.extensions).toEqual([]);
  }, 60_000);

  it("answers open question 1 — the per-lease sequence is CONTIGUOUS across BOTH production writers", async () => {
    const f = ctx();
    const { admin } = f;
    const reconciliation = createJobReconciliationService({ appDb: f.app.db });
    const { seeded, offer, identity } = await f.activateLease(6_105);
    // ★★★ BOTH WRITERS, FOR REAL. An earlier version of this test called
    // `requestCancellation` and then `queueRaw(..., 2)` — a raw INSERT whose sequence
    // was the literal 2. That could not fail: it asserted the number the test itself
    // wrote. Only ONE writer was exercised, so a second writer that allocated
    // non-contiguously would have left this green, and a hole makes EVERY worker-side
    // classification a `gap` — the fail-closed dead lever the design warns about.
    //
    // The two production writers are `queueGovernedControlCommand` (JOB-011 governance
    // results) and `requestCancellation` (JOB-006 cancel). Both allocate
    // COALESCE(MAX(command_seq),0)+1 under the lease lock. Neither sequence below is
    // supplied by this test: each is read back from what the writer returned.
    const governedCommandId = crypto.randomUUID();
    const governed = await runInTenant(f.app.db, ORG, async (repos) =>
      repos.jobControl.queueGovernedControlCommand({
        ...identity,
        control: {
          commandId: governedCommandId,
          commandKind: "runtime_decision_result",
          commandBody: governedResultBody(seeded, offer.leaseId, offer.fenceToken, governedCommandId),
          now: new Date(),
        },
      }));
    expect(governed.queued).toBe(true);
    expect(governed.command?.commandSeq).toBe(1);

    const cancel = await reconciliation.requestCancellation({
      organizationId: ORG, companyId: COMPANY, jobId: seeded.jobId, reason: "stop", graceful: true,
    });
    expect(cancel.status).toBe("queued");
    // ★ THE ASSERTION THAT CAN FAIL: the SECOND writer's own allocated sequence. A
    // per-job counter, a global counter, an unlocked read, or an off-by-one would
    // produce something other than 2 here and this reds.
    expect(cancel.command?.commandSeq).toBe(2);

    const rows = await admin`
      SELECT command_seq AS "commandSeq", command_kind AS "commandKind"
      FROM job_control_commands WHERE lease_id = ${offer.leaseId} ORDER BY command_seq`;
    expect(rows.map((r: { commandSeq: number; commandKind: string }) => [r.commandSeq, r.commandKind]))
      .toEqual([[1, "runtime_decision_result"], [2, "cancel"]]);
  }, 60_000);
});
