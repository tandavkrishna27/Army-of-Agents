// -----------------------------------------------------------------------------
// E6F-11 — DEP-009 LIVE two-replica control-plane HA + shared admission (Linux/CI
// ONLY — requires Docker + a running docker-compose.d1.yml stack with the
// control-plane-b replica). Built on the LIVE-GREEN E6F harness; SKIPs cleanly off
// AOA_D1_LIVE=1 (never faked — DEC-03). Bring-up is identical to E6F-03.
//
//   AOA_D1_LIVE=1 node --test tests/d1/e6f-11-two-replica.test.mjs
//
// ── What this proves (DEP-009 §2 acceptance) ─────────────────────────────────
// Two INTERCHANGEABLE control-plane replicas (`control-plane`, `control-plane-b`) over
// ONE PostgreSQL + object store cannot double-place/lease, exceed Organization capacity,
// or disagree on a terminal; polling is replica-agnostic; replica loss preserves
// correctness + bounded progress; and admission (rate limit + capacity) is DB-backed and
// SHARED across replicas, never process-local. Each `test()` is a hermetic org (its own
// unique issue prefix). ALL A/B concurrency lives INSIDE one `dexecModule("test-runner")`
// exec (`runReplicaRace`) — the campaign is `--test-concurrency=1` serial, so a test must
// never fan out its own docker execs. Every fault is restored in a `finally`.
//
// The single-winner/terminal/replica-loss guarantees are 2-replica-FREE: every control-plane
// mutation runs inside one `runInTenant` tx over FOR UPDATE [SKIP LOCKED] / partial-unique /
// advisory-lock / DB clock, so PostgreSQL is the single writer. DEP-009's net-new pieces are
// the PG-backed shared rate limiter (worker_admission_rate_limits) and submit-time
// org-capacity admission (admitAttemptCapacity), both DB-backed and fail-closed.
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
  CONTROL_PLANE_URL,
  CONTROL_PLANE_B_URL,
  WORKER_CONTROL,
  WORKER_CONTROL_B,
  raceCapacity,
  buildRaceWorkerHello,
  newRaceScenarioIds,
  seedRaceScenario,
  stampWorkersLiveness,
  enroll,
  poll,
  ack,
  runReplicaRace,
  raceOrgCapacityClaims,
  queryAdmissionRateWindows,
  queryLeaseFaultState,
  queryJobEventTrace,
  expireLeaseDeadlines,
  advanceJobAvailableAt,
  reapOrganization,
  setProxyEnabled,
  probeProxyReachable,
  computeEventDigests,
  uploadEvents,
} from "./lib/e6f-harness.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPACITY_CEILING = 64; // one worker may hold its whole per-target pool of leases

function truncate(value, max = 4000) {
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

/** Seed a hermetic single-org / single-target / N-job scenario (unique issue prefix) and
 * ENROLL its one dedicated worker over the real device-proof scheme. Enrollment is at the
 * given replica base (default A); the minted session is portable to EITHER replica (shared
 * signing key). Returns { ids, target, session } for the race helpers. */
function seedAndEnroll({ jobCount = 1, enrollBase = WORKER_CONTROL.enroll } = {}) {
  const ids = newRaceScenarioIds({ targetCount: 1 });
  const target = ids.targets[0];
  const jobs = Array.from({ length: jobCount }, () => ({
    jobId: randomUUID(),
    attemptId: randomUUID(),
    targetIndex: 0,
  }));
  const seed = stepResult(
    seedRaceScenario({
      orgId: ids.orgId,
      companyId: ids.companyId,
      slug: ids.slug,
      issuePrefix: ids.issuePrefix,
      targets: ids.targets,
      jobs,
      capacityCeiling: CAPACITY_CEILING,
    }),
    "seed",
  );
  assert.equal(seed.ok, true, `seed failed: ${truncate(seed)}`);
  const hello = buildRaceWorkerHello({
    workerId: target.workerId,
    targetId: target.targetId,
    batchSlots: CAPACITY_CEILING,
  });
  const enrolled = stepResult(
    enroll({ url: enrollBase, code: target.code.code, hello, deviceKey: target.deviceKey }),
    "enroll",
  );
  assert.equal(enrolled.status, 200, `enroll expected 200, got ${enrolled.status}: ${truncate(enrolled.body)}`);
  assert.ok(typeof enrolled.session === "string" && enrolled.session.length > 0, "enroll must mint a session");
  stepResult(stampWorkersLiveness([{ workerId: target.workerId, targetId: target.targetId }]), "liveness");
  return { ids, target, jobs, session: enrolled.session };
}

/** Build a fully-formed worker event for the FROZEN worker-protocol v1 schema. Every base field
 * (org/company/worker/job/attempt/lease/fence + `seq` + `extensions`) lives on EACH event — the
 * strict schema rejects a hand-rolled subset as 400 malformed. `jobId` comes from the live offer.
 * Mirrors e6f-09's makeEvent; computeEventDigests adds the canonical eventDigest afterward. */
function makeEvent(s, offer, { eventType, seq, payload, eventId }) {
  return {
    protocolVersion: 1,
    eventId: eventId ?? randomUUID(),
    organizationId: s.ids.orgId,
    companyId: s.ids.companyId,
    workerId: s.target.workerId,
    jobId: offer.job.jobId,
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

/** The event-batch envelope carrying the digested events (same base identity as each event). */
function batchFromEvents(s, offer, events) {
  return {
    protocolVersion: 1,
    organizationId: s.ids.orgId,
    companyId: s.ids.companyId,
    workerId: s.target.workerId,
    jobId: offer.job.jobId,
    attempt: offer.job.attempt,
    leaseId: offer.leaseId,
    fenceToken: offer.fenceToken,
    events,
  };
}

/** A poll spec for `runReplicaRace` addressed at a specific replica (A or B). */
function raceSpec(replica, base, s) {
  return {
    replica,
    pollUrl: `${base}/api/worker-control/poll`,
    ackPrefix: `${base}/api/worker-control/leases/`,
    ackSuffix: "/ack",
    session: s.session,
    workerId: s.target.workerId,
    targetId: s.target.targetId,
    privateKeyPem: s.target.deviceKey.privateKeyPem,
    publicKeyDer: s.target.deviceKey.publicKeyDer,
  };
}

// 1 ── No double-place/lease: one job, concurrent polls from replica A and replica B.
test("E6F-11 CONTROL-PLANE gate (harness-driven; no worker daemon, no device): single-winner lease race across replicas A and B (exactly one lease)", { skip: SKIP }, () => {
  const s = seedAndEnroll({ jobCount: 1 });
  const race = stepResult(
    runReplicaRace({
      requests: [raceSpec("A", CONTROL_PLANE_URL, s), raceSpec("B", CONTROL_PLANE_B_URL, s)],
      capacity: raceCapacity(CAPACITY_CEILING),
    }),
    "replica-race",
  );
  const offers = race.results.filter((r) => r.outcome === "offer");
  const noWork = race.results.filter((r) => r.outcome === "no_work");
  assert.equal(offers.length, 1, `exactly one replica must win the offer: ${truncate(race.results)}`);
  assert.equal(noWork.length, 1, `the losing replica must get no_work (never a second offer): ${truncate(race.results)}`);
  assert.match(offers[0].offer.leaseId, UUID);
  // The winner's ack succeeds on its own replica.
  assert.equal(offers[0].ackStatus, 200, `winner ack failed: ${truncate(offers[0])}`);

  const state = stepResult(queryLeaseFaultState({ organizationId: s.ids.orgId, jobId: s.jobs[0].jobId }), "lease-state");
  assert.equal(state.ok, true, `lease-state probe failed: ${truncate(state)}`);
  assert.equal(state.leases.length, 1, `exactly one lease row for the job: ${truncate(state.leases)}`);
});

// 2 ── No capacity exceed: concurrent capacity claims across replicas cannot exceed the cap.
test("E6F-11 CONTROL-PLANE gate (harness-driven; no worker daemon, no device): concurrent org-capacity claims across replicas never exceed the cap", { skip: SKIP }, () => {
  // Seed one org with 3 lease-eligible attempts, then race 3 concurrent claims under the
  // shared advisory lock with cap=1 (the same authority admitAttemptCapacity composes into
  // submitJobWithinTenant — see job-submit-capacity-admission.integration for the wiring).
  const s = seedAndEnroll({ jobCount: 3 });
  const attemptIds = s.jobs.map((j) => j.attemptId);
  const race = stepResult(
    raceOrgCapacityClaims({ organizationId: s.ids.orgId, attemptIds, cap: 1 }),
    "capacity-race",
  );
  assert.equal(race.ok, true, `capacity race failed: ${truncate(race)}`);
  assert.equal(race.admitted, 1, `exactly one concurrent claim may win at cap=1: ${truncate(race)}`);
  assert.equal(race.held, 1, `exactly one attempt may hold a slot (cap not exceeded): ${truncate(race)}`);
});

// 3 ── No terminal disagreement: ack at one replica, terminal event at the other → one terminal.
test("E6F-11 CONTROL-PLANE gate (harness-driven; no worker daemon, no device): consistent terminal across replicas (ack@A, terminal@B)", { skip: SKIP }, () => {
  const s = seedAndEnroll({ jobCount: 1 });
  // Win a lease at replica A and ack it there.
  const polled = stepResult(
    poll({ url: WORKER_CONTROL.poll, session: s.session, workerId: s.target.workerId, targetId: s.target.targetId, capacity: raceCapacity(CAPACITY_CEILING), deviceKey: s.target.deviceKey }),
    "poll@A",
  );
  assert.equal(polled.status, 200, `poll@A expected 200: ${truncate(polled.body)}`);
  assert.equal(polled.body.outcome, "offer", `poll@A must offer: ${truncate(polled.body)}`);
  const offer = polled.body.body;
  const acked = stepResult(
    ack({ session: s.session, workerId: s.target.workerId, jobId: offer.job.jobId, attempt: offer.job.attempt, leaseId: offer.leaseId, fenceToken: offer.fenceToken, deviceKey: s.target.deviceKey }),
    "ack@A",
  );
  assert.equal(acked.status, 200, `ack@A expected 200: ${truncate(acked.body)}`);

  // Upload the attempt's terminal event stream through replica B (events endpoint on B). Events
  // use the FROZEN worker-protocol v1 shape — `seq` (not `sequence`), the full base identity on
  // each event, and the terminal payload {status, exitCode, errorCode, errorMessage} — via the
  // same makeEvent→computeEventDigests→batchFromEvents path e6f-09/e6f-10 use; a hand-rolled
  // subset is rejected 400 malformed by the strict schema.
  const events = [
    makeEvent(s, offer, { eventType: "attempt_started", seq: 1, payload: { sandboxId: `sbx-${randomUUID()}` } }),
    makeEvent(s, offer, { eventType: "terminal", seq: 2, payload: { status: "succeeded", exitCode: 0, errorCode: null, errorMessage: null } }),
  ];
  const withDigests = stepResult(computeEventDigests({ events }), "event-digests");
  assert.equal(withDigests.ok, true, `digest compute failed: ${truncate(withDigests)}`);
  const batch = batchFromEvents(s, offer, withDigests.events);
  const uploaded = stepResult(
    uploadEvents({ url: WORKER_CONTROL_B.events, session: s.session, batch, deviceKey: s.target.deviceKey }),
    "events@B",
  );
  assert.equal(uploaded.status, 200, `events@B expected 200: ${truncate(uploaded.body)}`);

  // Both replicas agree on ONE terminal in the durable trace.
  const trace = stepResult(queryJobEventTrace({ organizationId: s.ids.orgId, jobId: offer.job.jobId }), "trace");
  assert.equal(trace.ok, true, `trace probe failed: ${truncate(trace)}`);
  const terminals = trace.events.filter((e) => e.eventType === "terminal");
  assert.equal(terminals.length, 1, `exactly one terminal event: ${truncate(trace.events)}`);
});

// 4 ── Replica-agnostic polling: enroll@A, poll+ack@B — one portable session.
test("E6F-11 CONTROL-PLANE gate (harness-driven; no worker daemon, no device): replica-agnostic session (enroll@A, poll+ack@B)", { skip: SKIP }, () => {
  const s = seedAndEnroll({ jobCount: 1, enrollBase: WORKER_CONTROL.enroll });
  // The A-minted session verifies at B (shared signing key + host-agnostic device proof).
  const polled = stepResult(
    poll({ url: WORKER_CONTROL_B.poll, session: s.session, workerId: s.target.workerId, targetId: s.target.targetId, capacity: raceCapacity(CAPACITY_CEILING), deviceKey: s.target.deviceKey }),
    "poll@B",
  );
  assert.equal(polled.status, 200, `poll@B with an A-minted session expected 200: ${truncate(polled.body)}`);
  assert.equal(polled.body.outcome, "offer", `poll@B must offer: ${truncate(polled.body)}`);
  const offer = polled.body.body;
  const acked = stepResult(
    ack({ session: s.session, workerId: s.target.workerId, jobId: offer.job.jobId, attempt: offer.job.attempt, leaseId: offer.leaseId, fenceToken: offer.fenceToken, deviceKey: s.target.deviceKey }),
    "ack@B",
  );
  // ack() addresses replica A's ack URL; the SAME session acking there proves portability.
  assert.equal(acked.status, 200, `ack (A URL) with the same session expected 200: ${truncate(acked.body)}`);
});

// 5 ── Replica loss → correctness + bounded progress: cut B's worker link, reap via A, converge.
test("E6F-11 CONTROL-PLANE gate (harness-driven; no worker daemon, no device): replica loss (cut worker-to-control-plane-b) converges via A", { skip: SKIP }, async () => {
  const s = seedAndEnroll({ jobCount: 1 });
  // Offer a lease at replica B.
  const polled = stepResult(
    poll({ url: WORKER_CONTROL_B.poll, session: s.session, workerId: s.target.workerId, targetId: s.target.targetId, capacity: raceCapacity(CAPACITY_CEILING), deviceKey: s.target.deviceKey }),
    "poll@B",
  );
  assert.equal(polled.body.outcome, "offer", `poll@B must offer: ${truncate(polled.body)}`);
  const offer = polled.body.body;

  // OBSERVABILITY (DEP-009 MEDIUM-2): the replica-loss cut must sever a REAL link, not a
  // dead one. Prove B's worker path is reachable THROUGH the toxiproxy:13101 listen BEFORE
  // the cut, so the post-cut UNREACHABLE assertion is non-vacuous.
  const preProbe = stepResult(probeProxyReachable({ proxy: "worker-to-control-plane-b" }), "probe-b-pre");
  assert.equal(preProbe.reachable, true, `worker→control-plane-b must be reachable before the cut: ${truncate(preProbe)}`);

  let cut = false;
  try {
    // Sever replica B's worker-facing link (the real worker-b path to B); A is untouched.
    const off = stepResult(setProxyEnabled({ proxy: "worker-to-control-plane-b", enabled: false }), "cut-b");
    assert.equal(off.ok, true, `disabling worker-to-control-plane-b failed: ${truncate(off)}`);
    cut = true;

    // The cut is OBSERVABLE: a poll driven THROUGH the toxiproxy:13101 listen is now
    // UNREACHABLE (TCP connect refused), proving the link is genuinely severed — not a
    // decorative toggle over a path no traffic uses.
    const cutProbe = stepResult(probeProxyReachable({ proxy: "worker-to-control-plane-b" }), "probe-b-cut");
    assert.equal(cutProbe.reachable, false, `worker→control-plane-b must be UNREACHABLE while cut: ${truncate(cutProbe)}`);

    // Back-date the pre-ack lease deadline and reap via replica A (reachable directly, not
    // through the cut proxy) → the offered lease expires and a retry attempt is minted.
    stepResult(expireLeaseDeadlines({ leaseId: offer.leaseId, ackDeadlineIntervalSec: 2 }), "expire");
    const reaped = stepResult(reapOrganization({ organizationId: s.ids.orgId }), "reap@A");
    assert.equal(reaped.status, 200, `reap@A expected 200: ${truncate(reaped.body)}`);

    const state = stepResult(queryLeaseFaultState({ organizationId: s.ids.orgId, jobId: offer.job.jobId }), "post-reap");
    assert.equal(state.ok, true, `post-reap probe failed: ${truncate(state)}`);
    // Exactly one retry: attempt N+1 exists (assert exactly 2 attempts, never >=1, so a
    // double-retry defect cannot hide), and the reaped lease is expired.
    assert.equal(state.attempts.length, 2, `exactly one retry attempt after reap: ${truncate(state.attempts)}`);
    assert.ok(state.leases.some((l) => l.status === "expired"), `the offered lease must be expired: ${truncate(state.leases)}`);

    // Clear the retry backoff. allocateRetry stamps jobs.available_at = now + an exponential
    // backoff and copies the placement snapshot verbatim, so the retry attempt is placement-
    // eligible but the offer predicate (jobs.available_at <= now) holds it until the backoff
    // elapses — an immediate poll@A would (correctly) return no_work. Back-date available_at
    // (deterministic clock control, same as expireLeaseDeadlines) so the retry is offerable now.
    const cleared = stepResult(advanceJobAvailableAt({ jobId: offer.job.jobId }), "clear-backoff@A");
    assert.equal(cleared.ok, true, `clearing the retry backoff failed: ${truncate(cleared)}`);
    assert.equal(cleared.updated, 1, `exactly one job's backoff cleared: ${truncate(cleared)}`);

    // The surviving replica A converges the work: poll@A offers the retry.
    const retry = stepResult(
      poll({ url: WORKER_CONTROL.poll, session: s.session, workerId: s.target.workerId, targetId: s.target.targetId, capacity: raceCapacity(CAPACITY_CEILING), deviceKey: s.target.deviceKey }),
      "poll@A-retry",
    );
    assert.equal(retry.body.outcome, "offer", `poll@A must offer the retry (converge via A): ${truncate(retry.body)}`);
  } finally {
    if (cut) {
      const on = setProxyEnabled({ proxy: "worker-to-control-plane-b", enabled: true });
      assert.ok(on.result && on.result.ok, `restoring worker-to-control-plane-b failed: ${truncate(on.result ?? on.stderr)}`);
    }
  }
});

// 6 ── Shared rate limit: concurrent A+B polls increment ONE shared window counter.
test("E6F-11 CONTROL-PLANE gate (harness-driven; no worker daemon, no device): concurrent A+B polls share ONE rate-limit window counter", { skip: SKIP }, () => {
  const s = seedAndEnroll({ jobCount: 1 });
  // Six polls split across both replicas (same worker/session). Every poll — offer OR
  // no_work — increments the shared per-org window counter, so a process-local limiter would
  // show two separate counters; the DB-backed shared limiter shows ONE window row.
  const requests = [
    raceSpec("A", CONTROL_PLANE_URL, s),
    raceSpec("B", CONTROL_PLANE_B_URL, s),
    raceSpec("A", CONTROL_PLANE_URL, s),
    raceSpec("B", CONTROL_PLANE_B_URL, s),
    raceSpec("A", CONTROL_PLANE_URL, s),
    raceSpec("B", CONTROL_PLANE_B_URL, s),
  ];
  const race = stepResult(runReplicaRace({ requests, capacity: raceCapacity(CAPACITY_CEILING) }), "rate-limit-race");
  // No poll may be throttled at the generous default cap (a throttle would mean the shared
  // window is far smaller than the campaign expects).
  const throttled = race.results.filter((r) => r.outcome === "other" && r.status === 429);
  assert.equal(throttled.length, 0, `no poll should be throttled at the default cap: ${truncate(throttled)}`);

  const windows = stepResult(queryAdmissionRateWindows({ organizationId: s.ids.orgId }), "rate-windows");
  assert.equal(windows.ok, true, `rate-window probe failed: ${truncate(windows)}`);
  // ONE shared window row (both replicas incremented the SAME counter, not one each). Allow a
  // second row only if the polls straddled the 60s window boundary; the sum still reflects
  // BOTH replicas' polls, proving the counter is shared, not process-local.
  assert.ok(windows.totalRows >= 1 && windows.totalRows <= 2, `expected one shared window row: ${truncate(windows)}`);
  assert.ok(
    windows.totalRequests >= requests.length,
    `the shared counter must reflect ALL A+B polls (${requests.length}): ${truncate(windows)}`,
  );
});
