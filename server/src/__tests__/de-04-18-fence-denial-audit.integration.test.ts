// DE-04 + DE-18, audit clauses — the governed-fence denial audit, end to end against real
// embedded PostgreSQL under the non-owner `aoa_app` role.
//
// ★ WHAT THIS PROVES, PER OWNER. `guardActiveFence` (job-fence.ts `classifyFence`) is the ONE
// fence chokepoint; when it refuses, the WIRED owner must leave a durable, attributable
// `security.denied.fence_guard` row. Each arm below drives a REAL owner through its PRODUCTION
// entry path and asserts the row carries that owner's OWN drain `control` string — so reverting
// any single owner's drain reds exactly that owner's arm (the coordinator's P2 on the earlier
// revision, which drove only the dormant `projectTerminalWinner` and left the other wirings
// unproven). Observed RED-first per owner: reverting each drain in turn reds only its arm.
//
// ★ WHICH CODES ARE REACHABLE THROUGH WHICH PATH, and why. The worker SERVICES
// (`createJobEventIngestService`, `createJobControlAckService`, `createJobLeaseRenewalService`)
// run their own authority/target/lease-tuple integrity checks BEFORE the guarded mutator, and
// those pre-empt a stale/superseded `target_revoked` (they throw `JobLeasingError` first — a
// SEPARATE, still-unaudited surface tracked as the follow-on). What they do NOT check is the
// ATTEMPT status, so a late claim on an already-terminal attempt reaches `guardActiveFence` and
// is refused `attempt_terminal` — the DE-04 double-execution deny. That is the code these three
// production owners reliably produce.
//   `target_revoked` (DE-18's fence arm) at `guardActiveFence` is reachable only by a mutator
// called with a raw fence and NO service pre-check — `completeAttempt` via
// `jobOutputBridge.projectTerminalWinner`. ★ That method currently has NO production caller (the
// live terminal path is `onAttemptTerminal` → the heartbeat projection), so its arm is a
// CURRENTLY-DORMANT / defense-in-depth path, kept as the ONE arm that exercises the
// `target_revoked → DE-18` crossing mapping through a real drain. It is NOT the sole coverage.
//
// ★ 2026-09-13 (fence follow-on): TWO MORE owners drain the same refusal and are proven in
// their OWN suites, not here — `patch-apply.ts:apply` and `secret-broker.ts:resolve`
// (patch-apply.integration.test.ts / secret-broker.integration.test.ts). Unlike the three
// services above, their pre-check (`resolveWorkerFenceContext`) does NOT gate on fence
// liveness or attempt terminality, so `stale_fence`/`attempt_terminal` are
// PRODUCTION-REACHABLE there; `target_revoked` remains pre-empted (race-only) for them, so
// the sentence above about `target_revoked` reachability stands.
//
// Windows CI can't start embedded-postgres on the runneradmin runner (Issue #114) — gated;
// opt in with AOA_RUN_WIN_INTEGRATION=1. The Linux `verify` gate runs it unconditionally.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SubmitJobSource } from "@armyofagents/shared";
import {
  canonicalEventDigestInputV1,
  type EventUploadOperationRequestV1,
  type ControlAckOperationRequestV1,
  type LeaseRenewOperationRequestV1,
  type LeaseOfferV1,
} from "@armyofagents/worker-protocol";
import type { ActiveFenceRequest } from "@armyofagents/db";
import {
  setupJobControlFixture,
  auth,
  sha256,
  ORG,
  COMPANY,
  TARGET,
  WORKER,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";
import { createJobEventIngestService } from "../services/job-events.js";
import { createJobControlAckService } from "../services/job-control-ack.js";
import { createJobLeaseRenewalService } from "../services/job-fencing.js";
import { jobOutputBridge, type BridgeActor } from "../services/job-output-bridge.js";

const ENABLED_ENV = { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" } as const;
const bridgeActor: BridgeActor = { kind: "user", id: "de0418-user", companyId: COMPANY };
const ONE_SHOT: SubmitJobSource = { kind: "one_shot", operationId: randomUUID(), operationKind: "extraction" };

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;
function guard(): void {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
}

// ---- request envelopes (adapted from de-03-worker-replay-denial-audit) ------
function logEvent(offer: LeaseOfferV1, seq: number): Record<string, unknown> {
  const base = {
    protocolVersion: 1,
    eventId: randomUUID(),
    organizationId: ORG,
    companyId: COMPANY,
    workerId: WORKER,
    jobId: offer.job.jobId,
    attempt: offer.job.attempt,
    leaseId: offer.leaseId,
    fenceToken: offer.fenceToken,
    seq,
    occurredAt: new Date().toISOString(),
    extensions: [] as unknown[],
    eventType: "log",
    payload: { stream: "stdout", level: "info", message: `line ${seq}` },
  };
  return { ...base, eventDigest: sha256(canonicalEventDigestInputV1(base)) };
}
function batchRequest(offer: LeaseOfferV1, seq: number): EventUploadOperationRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `ev-${randomUUID()}`,
    audience: "worker_run",
    idempotencyKey: randomUUID(),
    body: {
      protocolVersion: 1,
      organizationId: ORG,
      companyId: COMPANY,
      workerId: WORKER,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      events: [logEvent(offer, seq)],
    },
  } as unknown as EventUploadOperationRequestV1;
}
function renewRequest(offer: LeaseOfferV1): LeaseRenewOperationRequestV1 {
  return {
    protocolVersion: 1,
    correlationId: randomUUID(),
    issuedAt: new Date().toISOString(),
    nonce: `rn-${randomUUID()}`,
    audience: "worker_run",
    idempotencyKey: randomUUID(),
    body: {
      protocolVersion: 1,
      workerId: WORKER,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      observedAt: new Date().toISOString(),
      extensions: [],
    },
  } as unknown as LeaseRenewOperationRequestV1;
}
function controlAckRequest(offer: LeaseOfferV1): ControlAckOperationRequestV1 {
  const correlationId = randomUUID();
  return {
    protocolVersion: 1,
    correlationId,
    issuedAt: new Date().toISOString(),
    nonce: `ca-${randomUUID()}`,
    audience: "worker_run",
    body: {
      organizationId: ORG,
      companyId: COMPANY,
      workerId: WORKER,
      jobId: offer.job.jobId,
      attempt: offer.job.attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      ack: {
        protocolVersion: 1,
        correlationId,
        commandId: randomUUID(),
        commandSeq: 1,
        status: "accepted",
        observedAt: new Date().toISOString(),
        detail: null,
      },
    },
  };
}
function terminalWinnerInput(fence: ActiveFenceRequest, terminalEventId = randomUUID()) {
  return {
    source: ONE_SHOT,
    actor: bridgeActor,
    fence,
    terminalEventId,
    eventDigest: "d".repeat(64),
    attemptTerminalStatus: "succeeded" as const,
    summaryOutcome: "succeeded" as const,
    issueId: null,
  };
}

// ---- helpers ----------------------------------------------------------------
interface DenialRow {
  company_id: string | null;
  organization_id: string | null;
  actor_type: string;
  actor_id: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
}
async function fenceGuardRows(): Promise<DenialRow[]> {
  return (await fixture!.admin`
    SELECT company_id, organization_id, actor_type, actor_id, entity_type, entity_id, details
    FROM activity_log WHERE action = 'security.denied.fence_guard' ORDER BY created_at ASC
  `) as unknown as DenialRow[];
}
async function terminalize(attemptId: string): Promise<void> {
  await fixture!.admin`UPDATE job_attempts SET status = 'succeeded' WHERE id = ${attemptId}`;
}
/** Assert exactly one fence_guard row with the expected shape, and return it. */
async function expectOneRow(expected: {
  reason: string; crossing: string; controlIncludes: string; entityId?: string;
}): Promise<DenialRow> {
  const rows = await fenceGuardRows();
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.details.reason).toBe(expected.reason);
  expect(row.details.crossing).toBe(expected.crossing);
  // The row names the OWNER's own drain control — this is what makes reverting a single
  // owner's drain red exactly this arm and no other.
  expect(String(row.details.control)).toContain(expected.controlIncludes);
  // WHO is the refused WORKER, never the tenant (kills the actor=organization mutant).
  expect(row.actor_type).toBe("system");
  expect(row.actor_id).toBe(WORKER);
  expect(row.actor_id).not.toBe(ORG);
  // Company-scoped attribution — both axes present, from the locked fence identity.
  expect(row.company_id).toBe(COMPANY);
  expect(row.organization_id).toBe(ORG);
  expect(row.entity_type).toBe("job_lease");
  if (expected.entityId) expect(row.entity_id).toBe(expected.entityId);
  return row;
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("de0418-fence");
  } catch (error) {
    setupError = error;
  }
}, 180_000);
afterAll(async () => {
  await fixture?.teardown().catch(() => {});
}, 60_000);
beforeEach(async () => {
  if (!fixture) return;
  await fixture.admin`DELETE FROM activity_log WHERE action = 'security.denied.fence_guard'`;
});

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "DE-04 + DE-18 governed-fence denial audit (real worker services, per-owner)",
  () => {
    it("POSITIVE CONTROL: a live acceptEvent on an active fence SUCCEEDS and writes NO row", async () => {
      guard();
      const { offer } = await fixture!.activateLease(4_201);
      const res = await createJobEventIngestService({ appDb: fixture!.app.db })
        .ingest({ auth: auth(`pc-${randomUUID()}`), request: batchRequest(offer, 1) });
      expect(res.ack.status).toBe("accepted");
      expect(await fenceGuardRows()).toHaveLength(0);
    }, 90_000);

    it("acceptEvent (job-events) → DE-04/attempt_terminal: a late claim on a terminal attempt is audited", async () => {
      guard();
      const { offer, identity } = await fixture!.activateLease(4_202);
      await terminalize(identity.attemptId);
      // acceptEvent folds the fence refusal into a cumulative-ACK status (invariant #8);
      // the drain still records the denial.
      const res = await createJobEventIngestService({ appDb: fixture!.app.db })
        .ingest({ auth: auth(`ae-${randomUUID()}`), request: batchRequest(offer, 1) });
      expect(res.ack.status).toBe("terminal");
      await expectOneRow({
        reason: "attempt_terminal", crossing: "DE-04",
        controlIncludes: "job-events.ts:acceptEvent", entityId: identity.leaseId,
      });
    }, 90_000);

    it("ackControlCommand (job-control-ack) → DE-04/attempt_terminal: audited (remapped-catch shape)", async () => {
      guard();
      const { offer, identity } = await fixture!.activateLease(4_203);
      await terminalize(identity.attemptId);
      await expect(
        createJobControlAckService({ appDb: fixture!.app.db })
          .ack({ auth: auth(`ac-${randomUUID()}`), request: controlAckRequest(offer) }),
      ).rejects.toMatchObject({ code: "attempt_terminal" });
      await expectOneRow({
        reason: "attempt_terminal", crossing: "DE-04",
        controlIncludes: "job-control-ack.ts:ackControlCommand", entityId: identity.leaseId,
      });
    }, 90_000);

    it("renewLease (job-fencing) → DE-04/attempt_terminal: audited (remapped-catch shape)", async () => {
      guard();
      const { offer, identity } = await fixture!.activateLease(4_204);
      await terminalize(identity.attemptId);
      await expect(
        createJobLeaseRenewalService({ appDb: fixture!.app.db })
          .renew({ auth: auth(`rn-${randomUUID()}`), request: renewRequest(offer) }),
      ).rejects.toMatchObject({ code: "attempt_terminal" });
      await expectOneRow({
        reason: "attempt_terminal", crossing: "DE-04",
        controlIncludes: "job-fencing.ts:renewLease", entityId: identity.leaseId,
      });
    }, 90_000);

    it("completeAttempt (job-output-bridge, CURRENTLY DORMANT) → DE-18/target_revoked: the fence arm is audited", async () => {
      guard();
      const { identity } = await fixture!.activateLease(4_205);
      // A re-enrollment bumps the live device generation past the lease's pin. completeAttempt
      // takes the raw fence with no service pre-check, so guardActiveFence refuses target_revoked
      // — the ONE path reaching DE-18's fence arm. (No production caller today; defense-in-depth.)
      await fixture!.admin`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET}`;
      await expect(
        jobOutputBridge(fixture!.app.db, { env: ENABLED_ENV }).projectTerminalWinner(terminalWinnerInput(identity)),
      ).rejects.toMatchObject({ code: "target_revoked" });
      await expectOneRow({
        reason: "target_revoked", crossing: "DE-18",
        controlIncludes: "job-output-bridge.ts:completeAttempt", entityId: identity.leaseId,
      });
    }, 90_000);
  },
);
