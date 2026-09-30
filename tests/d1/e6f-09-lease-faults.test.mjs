// -----------------------------------------------------------------------------
// E6F-09 — LIVE lease-fault demonstrations (DEP-005; Linux/CI ONLY — requires
// Docker + a running docker-compose.d1.yml stack). The three mandated cases from
// program-design.md:721, driven on the standing DEP-002 substrate with the two
// DEP-005 additions — a SQL clock helper that back-dates the durable lease deadline
// columns, and the flag-gated reaper trigger — so every deadline boundary is crossed
// SYNCHRONOUSLY (toxic/toggle + row back-date + reap), NEVER by sleeping on a natural
// deadline.
//
// CORRECTED (MIG-002): this header used to add "or a sweeper interval". That stopped
// being true at `c341cf680`, which starts a LIVE background lease reaper on both
// control-plane replicas. These cases no longer assert WHICH reaper converged the
// lease — only that it converged. See `reapAndConverge`.
//
//   AOA_D1_LIVE=1 node --test tests/d1/e6f-09-lease-faults.test.mjs
//
// Without AOA_D1_LIVE=1 it SKIPS cleanly — NEVER faked (DEC-03). Bring-up = E6F-03.
//
// The three cases (each a hermetic org with a UNIQUE issue prefix, a positive control,
// a fault, a synchronous reap, and fault teardown in a `finally`):
//   1. PRE-ACK DISCONNECT — a worker leases (offer) then the worker-to-control-plane
//      link is cut before ack. Back-date ack_deadline (the offered case) → reap →
//      lease/attempt `expired`, a retry attempt N+1 (`pending`), job requeued; the
//      restored worker's late ack on the revoked fence is refused stale_fence /
//      attempt_terminal.
//   2. LOST COMPLETION ACK — a terminal event uploaded twice (SAME eventIds) yields the
//      SAME cumulative acceptance and no duplicate job_events / projection row. Dedup is
//      EVENT-LEVEL (sequence + eventId + digest under the fence lock); the envelope
//      idempotencyKey is inert for event upload and passed only to mirror a retrying worker.
//   3. EXPIRED LEASE — an acked/active lease whose worker stops renewing. Back-date
//      expires_at (the active case; both columns, ack_deadline < expires_at) → reap →
//      lease/attempt `expired`, exactly one retry attempt N+1 (single-winner); a late
//      event on the revoked fence is refused stale_fence (winner never overwritten).
//
// Built on the LIVE-GREEN E6F harness (enroll/poll/ack over real Ed25519 device
// proofs) + the DEP-005 primitives (expireLeaseDeadlines / reapOrganization /
// setProxyEnabled / computeEventDigests / uploadEvents / queryLeaseFaultState).
//
// ── WHY THE GATE TITLE SAYS "CONTROL-PLANE gate" (W18, 2026-09-08) ──────────
// The suite's own title now names what it tests. This is a TRUTH FIX and nothing
// more: no assertion, threshold or pass condition changed with it. What runs here
// is the CONTROL PLANE under a harness that plays the worker itself —
// tests/d1/lib/e6f-harness.mjs:8-9 states it outright: "There is NO live
// worker-daemon loop: enroll/poll/ack are ordinary authenticated HTTP calls the
// harness makes itself." So a green run is evidence about the control plane's
// fenced routes, and is NOT evidence that any worker daemon, device or machine
// ran anything. Naming the half that has NOT run follows the precedent already in
// this tree: scripts/gate-clause-wiring.json's E5-2-fenced-object-commit-worker-half.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  SKIP,
  newScenarioIds,
  generateDeviceKey,
  newEnrollmentCode,
  buildWorkerHello,
  seedTenancyOrg,
  stampWorkerLiveness,
  enroll,
  poll,
  ack,
  expireLeaseDeadlines,
  reapOrganization,
  setProxyEnabled,
  probeProxyReachable,
  computeEventDigests,
  uploadEvents,
  queryLeaseFaultState,
} from "./lib/e6f-harness.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FENCE = /^[A-Za-z0-9_-]{43,}$/;
// A late ack/event on a revoked fence must be denied by one of these (existence never
// leaks; the same non-disclosing set E6F-08 gates on).
const NON_DISCLOSING_DENIALS = new Set(["stale_fence", "target_revoked", "attempt_terminal", "terminal"]);

function truncate(value, max = 6000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text;
}

function stepResult(res, label) {
  assert.ok(
    res.result !== null && res.result !== undefined,
    `${label}: no result parsed (exit=${res.status}${res.error ? ` error=${res.error}` : ""})\n` +
      `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  );
  return res.result;
}

function diag(res, label) {
  return `\n--- ${label} stdout ---\n${truncate(res.stdout, 6000)}\n--- ${label} stderr ---\n${truncate(res.stderr, 1500)}`;
}

function run(res, label) {
  return { result: stepResult(res, label), raw: diag(res, label) };
}

/**
 * Reap, then converge — tolerating the MIG-002 background lease reaper.
 *
 * WHY THIS EXISTS. This file's header used to claim every deadline boundary is crossed
 * "NEVER by ... a sweeper interval", and the harness's clock-control note claimed "the
 * reaper has no live trigger". Both were true when written and MIG-002 (`c341cf680`)
 * made them false: `createJobControlSweeper` now runs on BOTH D1 control-plane replicas
 * on a self-scheduling loop that drops to a 1-SECOND cadence after any productive tick.
 *
 * So a back-dated lease CAN be reaped by the background sweeper before the explicit
 * `_test/reap` lands, and the explicit reap then correctly reports `scanned:0` — the
 * candidate predicate selects only `offered`/`active` leases, and the sweeper has
 * already moved it to `expired`. Observed on run 32627822479: the sweeper logged
 * "[mig-002] lease reaper converged" at 08:23:13 and this test's reap returned
 * scanned:0 at 08:23:14.
 *
 * Asserting `revoked >= 1` on the explicit reap's body therefore tests WHO performed the
 * convergence, not WHETHER it happened — an implementation detail that is now genuinely
 * racy. The END STATE is the property these cases actually demonstrate, and it is
 * asserted in full immediately after (lease expired, attempt 1 expired, retry attempt 2
 * pending, single winner, job requeued).
 *
 * The reap is still issued and still must answer 200: a reap that ERRORS is a real
 * failure. Only the "I was the one who did it" claim is dropped. A bounded re-read
 * covers the remaining window where a background reap is mid-flight (the candidate
 * SELECT takes `FOR UPDATE SKIP LOCKED`, so an in-flight sweep is invisible to both the
 * explicit reap AND to a state read taken in the same instant).
 */
function reapAndConverge({ organizationId, jobId, attempts = 10 }) {
  const reaped = run(reapOrganization({ organizationId }), "reap");
  assert.equal(reaped.result.status, 200, `reap expected 200: ${truncate(reaped.result.body)}${reaped.raw}`);
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = run(queryLeaseFaultState({ organizationId, jobId }), "state-after");
    if (last.result?.leases?.[0]?.status === "expired") return { reaped, after: last };
    // Re-issue rather than sleep: each docker exec round-trip is itself the delay, and
    // a second reap is idempotent — if the sweeper already converged, it reports zero.
    run(reapOrganization({ organizationId }), "reap-retry");
  }
  assert.fail(`lease never converged to expired after ${attempts} reap+read cycles${last?.raw ?? ""}`);
}

function stripVolatile(body) {
  if (!body || typeof body !== "object") return body;
  const { correlationId: _c, serverTime: _s, ...rest } = body;
  return rest;
}

/** A complete wire event WITHOUT eventDigest (computeEventDigests fills it). Repeats
 * the batch delivery identity on every event (workerEventBatchV1Schema requires it). */
function makeEvent(A, offer, { eventType, seq, payload, eventId }) {
  return {
    protocolVersion: 1,
    eventId: eventId ?? randomUUID(),
    organizationId: A.orgId,
    companyId: A.companyId,
    workerId: A.workerId,
    jobId: A.jobId,
    attempt: offer.job.attempt,
    leaseId: offer.leaseId,
    fenceToken: offer.fenceToken,
    seq,
    occurredAt: new Date().toISOString(),
    extensions: [],
    eventType,
    payload,
  };
}

function batchFromEvents(A, offer, events) {
  return {
    protocolVersion: 1,
    organizationId: A.orgId,
    companyId: A.companyId,
    workerId: A.workerId,
    jobId: A.jobId,
    attempt: offer.job.attempt,
    leaseId: offer.leaseId,
    fenceToken: offer.fenceToken,
    events,
  };
}

/** Seed one hermetic org + enroll + stamp liveness + poll for the worker's own lease
 * offer. Shared bring-up for all three cases. Returns { A, deviceKey, session, offer }. */
function bringUpLeasedWorker(prefixSeed) {
  const A = newScenarioIds();
  const prefix = `${prefixSeed}${A.slug}`.slice(0, 12).toUpperCase();
  const deviceKey = generateDeviceKey();
  const code = newEnrollmentCode();

  const seeded = run(seedTenancyOrg({ ids: A, code, issuePrefix: prefix, extraCodes: [] }), "seed");
  assert.equal(seeded.result.ok, true, `seed failed: ${truncate(seeded.result)}${seeded.raw}`);

  const enrolled = run(
    enroll({ code: code.code, hello: buildWorkerHello({ workerId: A.workerId, targetId: A.targetId }), deviceKey }),
    "enroll",
  );
  assert.equal(enrolled.result.status, 200, `enroll expected 200: ${truncate(enrolled.result.body)}${enrolled.raw}`);
  const session = enrolled.result.session;
  assert.ok(typeof session === "string" && session.length > 0, `enroll must return a worker session${enrolled.raw}`);

  const liveness = run(stampWorkerLiveness({ workerId: A.workerId, targetId: A.targetId }), "liveness");
  assert.equal(liveness.result.workerUpdated, 1, `worker stamped${liveness.raw}`);

  const offerPoll = run(poll({ session, workerId: A.workerId, targetId: A.targetId, deviceKey }), "poll-offer");
  assert.equal(offerPoll.result.status, 200, `poll expected 200: ${truncate(offerPoll.result.body)}${offerPoll.raw}`);
  assert.equal(offerPoll.result.body.outcome, "offer", `poll must offer the worker's own job${offerPoll.raw}`);
  const offer = offerPoll.result.body.body;
  assert.match(offer.leaseId, UUID, `offer leaseId shape${offerPoll.raw}`);
  assert.match(offer.fenceToken, FENCE, `offer fence shape${offerPoll.raw}`);

  return { A, deviceKey, session, offer };
}

function ackOffer(A, session, offer, deviceKey, label = "ack") {
  const acked = run(
    ack({ session, workerId: A.workerId, jobId: A.jobId, attempt: offer.job.attempt, leaseId: offer.leaseId, fenceToken: offer.fenceToken, deviceKey }),
    label,
  );
  assert.equal(acked.result.status, 200, `${label} expected 200: ${truncate(acked.result.body)}${acked.raw}`);
  assert.equal(acked.result.body.outcome, "acknowledged", `${label} outcome${acked.raw}`);
  return acked;
}

// ── Case 1 — pre-ACK disconnect → clean reclaim ──────────────────────────────
test(
  "E6F-09 CONTROL-PLANE gate (harness-driven; no worker daemon, no device) case 1 — pre-ACK disconnect: lease → cut worker-to-control-plane → back-date ack_deadline → reap → reclaimed, late ack refused",
  { skip: SKIP },
  async () => {
    const { A, deviceKey, session, offer } = bringUpLeasedWorker("E691");
    let proxyCut = false;
    try {
      // POSITIVE CONTROL — the offered lease is live before the fault.
      const before = run(queryLeaseFaultState({ organizationId: A.orgId, jobId: A.jobId }), "state-before");
      assert.equal(before.result.ok, true, `state probe ok${before.raw}`);
      assert.equal(before.result.leases.length, 1, `exactly one lease pre-fault${before.raw}`);
      assert.equal(before.result.leases[0].status, "offered", `lease is offered (never acked)${before.raw}`);

      // FAULT — cut the worker-to-control-plane link and PROVE it severed (invariant 1:
      // each of the three links is independently cuttable). The reap below reaches
      // control-plane:3100 DIRECTLY, so the synchronous reclaim proceeds over the intact
      // control path while the worker link stays down.
      const cut = run(setProxyEnabled({ proxy: "worker-to-control-plane", enabled: false }), "proxy-cut");
      assert.equal(cut.result.ok, true, `worker-to-control-plane cut must succeed: ${truncate(cut.result.body)}${cut.raw}`);
      proxyCut = true;

      // OBSERVABLE cut: a probe THROUGH the worker→control-plane listen port (toxiproxy:13100)
      // is now refused — the link is genuinely severed, not merely toggled.
      const cutProbe = run(probeProxyReachable({ proxy: "worker-to-control-plane" }), "cut-probe");
      assert.equal(cutProbe.result.reachable, false, `worker→control-plane must be UNREACHABLE while cut: ${truncate(cutProbe.result)}${cutProbe.raw}`);

      // The worker never delivered its ack: back-date ONLY ack_deadline (offered case;
      // expires_at stays future so ack_deadline < expires_at holds), then reap.
      const expired = run(expireLeaseDeadlines({ leaseId: offer.leaseId, ackDeadlineIntervalSec: 2 }), "back-date-ack");
      assert.equal(expired.result.ok, true, `back-date ok${expired.raw}`);
      assert.equal(expired.result.updated, 1, `exactly one lease back-dated${expired.raw}`);

      // Convergence: lease + attempt 1 expired, retry attempt 2 pending, job requeued.
      // Either reaper may perform it — see `reapAndConverge`.
      const { after } = reapAndConverge({ organizationId: A.orgId, jobId: A.jobId });
      assert.equal(after.result.leases[0].status, "expired", `lease reaped to expired${after.raw}`);
      const attempt1 = after.result.attempts.find((a) => a.attemptNumber === 1);
      const attempt2 = after.result.attempts.find((a) => a.attemptNumber === 2);
      assert.equal(attempt1?.status, "expired", `attempt 1 expired${after.raw}`);
      assert.equal(attempt2?.status, "pending", `retry attempt 2 pending${after.raw}`);
      assert.equal(after.result.attempts.length, 2, `exactly one retry attempt (single winner)${after.raw}`);
      assert.equal(after.result.job.status, "queued", `job requeued${after.raw}`);

      // Restore the link, then the disconnected worker's belated ack on the revoked
      // fence is refused — the reclaim stands, nothing is overwritten.
      const restore = run(setProxyEnabled({ proxy: "worker-to-control-plane", enabled: true }), "proxy-restore");
      assert.equal(restore.result.ok, true, `link restored${restore.raw}`);
      proxyCut = false;

      // The cut was observable in BOTH directions: the link is reachable again post-restore.
      const restoreProbe = run(probeProxyReachable({ proxy: "worker-to-control-plane" }), "restore-probe");
      assert.equal(restoreProbe.result.reachable, true, `worker→control-plane reachable again after restore: ${truncate(restoreProbe.result)}${restoreProbe.raw}`);

      const lateAck = run(
        ack({ session, workerId: A.workerId, jobId: A.jobId, attempt: offer.job.attempt, leaseId: offer.leaseId, fenceToken: offer.fenceToken, deviceKey }),
        "late-ack",
      );
      assert.notEqual(lateAck.result.status, 200, `late ack must NOT succeed: ${truncate(lateAck.result.body)}${lateAck.raw}`);
      assert.ok(
        NON_DISCLOSING_DENIALS.has(lateAck.result.body.code),
        `late ack denial must be non-disclosing, got "${lateAck.result.body.code}"${lateAck.raw}`,
      );
    } finally {
      // MANDATORY (serial campaign): never leak a disabled proxy. Best-effort — never
      // throw in finally (it would mask the primary test failure), but surface a failed
      // restore loudly so a leaked cut is diagnosable.
      if (proxyCut) {
        const r = setProxyEnabled({ proxy: "worker-to-control-plane", enabled: true });
        if (!r?.result?.ok) {
          console.error(`e6f-09 case 1: FAILED to restore worker-to-control-plane proxy — later serial tests may be affected: ${JSON.stringify(r?.result ?? r)}`);
        }
      }
    }
  },
);

// ── Case 2 — lost completion ACK → idempotent replay, no duplicate effect ─────
test(
  "E6F-09 CONTROL-PLANE gate (harness-driven; no worker daemon, no device) case 2 — lost completion ACK: a terminal event uploaded twice (same eventId + stable idempotencyKey) yields the identical ack and no duplicate row",
  { skip: SKIP },
  async () => {
    const { A, deviceKey, session, offer } = bringUpLeasedWorker("E692");
    ackOffer(A, session, offer, deviceKey);

    // Build [attempt_started(seq1), terminal(seq2)] ONCE (stable eventIds + digests)
    // so the replay is byte-identical at the event layer. Digests via the FROZEN
    // worker-protocol canonicalizer (control-plane), never hand-rolled.
    const startedId = randomUUID();
    const terminalId = randomUUID();
    const rawEvents = [
      makeEvent(A, offer, { eventType: "attempt_started", seq: 1, eventId: startedId, payload: { sandboxId: `sbx-${randomUUID()}` } }),
      makeEvent(A, offer, { eventType: "terminal", seq: 2, eventId: terminalId, payload: { status: "succeeded", exitCode: 0, errorCode: null, errorMessage: null } }),
    ];
    const digested = run(computeEventDigests({ events: rawEvents }), "digests");
    assert.equal(digested.result.ok, true, `digest build ok${digested.raw}`);
    const batch = batchFromEvents(A, offer, digested.result.events);
    const idempotencyKey = randomUUID(); // STABLE across both uploads.

    // POSITIVE CONTROL — the first upload commits the terminal (accepted through 2).
    const first = run(uploadEvents({ session, batch, idempotencyKey, deviceKey }), "events-1");
    assert.equal(first.result.status, 200, `first upload expected 200: ${truncate(first.result.body)}${first.raw}`);
    assert.equal(first.result.body.ack.status, "accepted", `first upload accepted${first.raw}`);
    assert.equal(first.result.body.ack.acceptedThroughSeq, 2, `accepted through seq 2${first.raw}`);

    const afterFirst = run(queryLeaseFaultState({ organizationId: A.orgId, jobId: A.jobId }), "state-1");
    assert.equal(afterFirst.result.events.total, 2, `two job_events after first upload${afterFirst.raw}`);
    assert.equal(afterFirst.result.events.terminal, 1, `one terminal event${afterFirst.raw}`);
    assert.equal(afterFirst.result.projections.terminal, 1, `one terminal projection receipt${afterFirst.raw}`);
    assert.equal(afterFirst.result.attempts.find((a) => a.attemptNumber === 1)?.status, "succeeded", `attempt 1 reached terminal succeeded${afterFirst.raw}`);
    // The ingest projection finalizes the ATTEMPT, not the JOB — only the reaper writes
    // jobs.status='succeeded' (finalizeJob). Case 2 never reaps, and attempt_started
    // already flipped the job queued→running, so 'running' is the correct job state here.
    assert.equal(afterFirst.result.job.status, "running", `job stays running (ingest finalizes the attempt, not the job)${afterFirst.raw}`);

    // FAULT — the completion ACK was "lost"; the worker retries the SAME upload (same
    // eventIds). Event-level dedup (seq/eventId/digest under the fence lock) keeps the
    // cumulative acceptance stable and mints no duplicate rows; the idempotencyKey is
    // inert for events (passed only to mirror a real retrying worker).
    const replay = run(uploadEvents({ session, batch, idempotencyKey, deviceKey }), "events-2");
    assert.equal(replay.result.status, 200, `replay expected 200: ${truncate(replay.result.body)}${replay.raw}`);
    // Idempotent-replay contract: the cumulative acceptance is UNCHANGED (still through
    // seq 2). The re-upload of a now-terminal batch is refused by the active-fence guard
    // BEFORE any append, so the server reports a fence-status ('terminal') at the same
    // accepted-through sequence rather than re-accepting — no duplicate effect (the
    // durable-row assertions below prove that directly).
    assert.equal(replay.result.body.ack.acceptedThroughSeq, 2, `replay cumulative ack unchanged (through seq 2)${replay.raw}`);
    assert.ok(
      new Set(["accepted", "terminal"]).has(replay.result.body.ack.status),
      `replay ack status must be accepted|terminal, got "${replay.result.body.ack.status}"${replay.raw}`,
    );

    const afterReplay = run(queryLeaseFaultState({ organizationId: A.orgId, jobId: A.jobId }), "state-2");
    assert.equal(afterReplay.result.events.total, 2, `still two job_events after replay (no duplicate)${afterReplay.raw}`);
    assert.equal(afterReplay.result.projections.terminal, 1, `still one terminal projection (no duplicate)${afterReplay.raw}`);
    assert.equal(afterReplay.result.attempts.length, 1, `no extra attempt minted${afterReplay.raw}`);
    assert.equal(afterReplay.result.job.status, "running", `job unchanged — still running (no reaper ran)${afterReplay.raw}`);
  },
);

// ── Case 3 — expired lease → single-winner convergence ───────────────────────
test(
  "E6F-09 CONTROL-PLANE gate (harness-driven; no worker daemon, no device) case 3 — expired lease: ack → stop renewing → back-date expires_at → reap → single-winner retry, late event refused stale_fence",
  { skip: SKIP },
  async () => {
    const { A, deviceKey, session, offer } = bringUpLeasedWorker("E693");
    ackOffer(A, session, offer, deviceKey);

    // POSITIVE CONTROL — the acked lease is active before the fault.
    const before = run(queryLeaseFaultState({ organizationId: A.orgId, jobId: A.jobId }), "state-before");
    assert.equal(before.result.ok, true, `state probe ok${before.raw}`);
    assert.equal(before.result.leases[0].status, "active", `lease is active after ack${before.raw}`);
    assert.equal(before.result.attempts.find((a) => a.attemptNumber === 1)?.status, "leased", `attempt 1 leased${before.raw}`);

    // FAULT — the worker stops renewing. Back-date expires_at (the active/expired case:
    // BOTH columns, ack_deadline < expires_at), then reap.
    const expired = run(
      expireLeaseDeadlines({ leaseId: offer.leaseId, ackDeadlineIntervalSec: 2, expiresAtIntervalSec: 1 }),
      "back-date-expires",
    );
    assert.equal(expired.result.ok, true, `back-date ok${expired.raw}`);
    assert.equal(expired.result.updated, 1, `exactly one lease back-dated${expired.raw}`);

    // SINGLE-WINNER convergence: lease + attempt 1 expired, EXACTLY one retry attempt.
    // Either reaper may perform it — see `reapAndConverge`. The single-winner property
    // (exactly 2 attempts) is unaffected by WHICH reaper ran and is asserted below.
    const { after } = reapAndConverge({ organizationId: A.orgId, jobId: A.jobId });
    assert.equal(after.result.leases[0].status, "expired", `lease reaped to expired${after.raw}`);
    assert.equal(after.result.attempts.find((a) => a.attemptNumber === 1)?.status, "expired", `attempt 1 expired${after.raw}`);
    assert.equal(after.result.attempts.length, 2, `exactly one retry attempt (single winner)${after.raw}`);
    assert.equal(after.result.attempts.find((a) => a.attemptNumber === 2)?.status, "pending", `retry attempt 2 pending${after.raw}`);
    assert.equal(after.result.job.status, "queued", `job requeued${after.raw}`);

    // A late event on the revoked fence is refused (winner never overwritten). The
    // event-ingest path returns 200 with a fence-status ack (stale_fence / terminal).
    const lateEvents = run(computeEventDigests({
      events: [makeEvent(A, offer, { eventType: "terminal", seq: 1, payload: { status: "succeeded", exitCode: 0, errorCode: null, errorMessage: null } })],
    }), "late-digests");
    assert.equal(lateEvents.result.ok, true, `late digest build ok${lateEvents.raw}`);
    const lateBatch = batchFromEvents(A, offer, lateEvents.result.events);
    const lateUpload = run(uploadEvents({ session, batch: lateBatch, deviceKey }), "late-event");
    assert.equal(lateUpload.result.status, 200, `late event upload returns 200 with a fence-status ack: ${truncate(lateUpload.result.body)}${lateUpload.raw}`);
    assert.ok(
      NON_DISCLOSING_DENIALS.has(lateUpload.result.body.ack.status),
      `late event must be refused (stale_fence/terminal), got "${lateUpload.result.body.ack.status}"${lateUpload.raw}`,
    );

    // The winner stands — the refused late event mutated NOTHING durable (invariant 4):
    // no attempt overwrite, no requeue flip, no new job_events / terminal projection.
    const finalState = run(queryLeaseFaultState({ organizationId: A.orgId, jobId: A.jobId }), "state-final");
    assert.equal(finalState.result.attempts.find((a) => a.attemptNumber === 1)?.status, "expired", `attempt 1 stays expired${finalState.raw}`);
    assert.equal(finalState.result.attempts.length, 2, `still exactly 2 attempts (retry winner not overwritten)${finalState.raw}`);
    assert.equal(finalState.result.attempts.find((a) => a.attemptNumber === 2)?.status, "pending", `retry attempt 2 still pending${finalState.raw}`);
    assert.equal(finalState.result.job.status, "queued", `job stays queued${finalState.raw}`);
    assert.equal(finalState.result.events.total, 0, `no job_events from the refused late event${finalState.raw}`);
    assert.equal(finalState.result.projections.terminal, 0, `no terminal projection from the refused late event${finalState.raw}`);
  },
);
