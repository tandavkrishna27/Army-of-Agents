// -----------------------------------------------------------------------------
// E6F-10 — LIVE distributed-observability telemetry contract (DEP-007; Linux/CI
// ONLY — requires Docker + a running docker-compose.d1.yml stack). Authored on the
// LIVE-GREEN E6F harness; it clones the E6F-03/09 fake-job flow (enroll → poll →
// lease → ack → attempt_started + terminal events) and then asserts the three facets
// of the DEP-007 telemetry contract on the DURABLE `job_events` backbone.
//
//   AOA_D1_LIVE=1 node --test --test-concurrency=1 tests/d1/e6f-10-telemetry.test.mjs
//
// Without AOA_D1_LIVE=1 (the Windows dev box, or any host without the stack up) it
// SKIPS cleanly — it is NEVER faked (DEC-03). Bring-up is identical to E6F-03.
//
// ── What this proves (DEP-007 §2 invariants) ─────────────────────────────────
//   (a) DURABLE TRACE (inv. 1) — for a single job, the `job_events` rows ORDERED BY
//       the contiguous `sequence` reconstruct exec-source → job → attempt → lease →
//       sandbox, with the terminal `sandboxId` surfaced from the `attempt_started`
//       event's jsonb payload (sandboxId is payload-only — no column, no FK).
//   (b) TENANT SCOPING (inv. 4) — a non-owner `aoa_app` read (NOSUPERUSER/
//       NOBYPASSRLS) of a FOREIGN org's `job_events` is EMPTY under FORCE RLS, even
//       though the job_id matches; the owning-org read is non-empty (positive
//       control), and the foreign org CAN see its OWN rows (proves the 0 is RLS
//       isolation, not a broken grant/scope). High-cardinality ids never leak to a
//       foreign reader; they live only in the restricted `job_events` + log sinks.
//   (c) EVIDENCE (inv. 6) — the DEP-007-repointed collector (`gatherEvents`, now
//       `job_events`/`sequence`, no longer the non-existent `worker_events`/`seq`)
//       returns the job's events, so a merge-train failure retains the trace.
//
// The label-discipline invariant (§2.3 — no id as a metric label) is proven in
// process by server/src/__tests__/job-control-metrics.test.ts (compile-closed +
// the id-rejection mirror), and the logger-spine binding (§2.2) by
// server/src/__tests__/job-trace-log.test.ts — the robust DB probe is the D1 anchor;
// fragile mid-test container-log scraping is avoided (design D6).
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  SKIP,
  COMPOSE_FILE,
  newScenarioIds,
  generateDeviceKey,
  newEnrollmentCode,
  buildWorkerHello,
  seedTenancyOrg,
  stampWorkerLiveness,
  enroll,
  poll,
  ack,
  computeEventDigests,
  uploadEvents,
  queryJobEventTrace,
  queryJobEventsAsApp,
} from "./lib/e6f-harness.mjs";
// DEP-007 facet (c): the repointed evidence collector's events gatherer. main() is
// CLI-guarded, so importing it has zero side effects.
import { gatherEvents } from "../../scripts/collect-d1-evidence.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FENCE = /^[A-Za-z0-9_-]{43,}$/;

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

/** A complete wire event WITHOUT eventDigest (computeEventDigests fills it). Repeats the
 * batch delivery identity on every event (workerEventBatchV1Schema requires it). */
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

/** Seed one hermetic org + enroll + stamp liveness + poll the worker's own offer + ack.
 * Shared bring-up (mirrors e6f-09). Returns { A, deviceKey, session, offer }. */
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

  const acked = run(
    ack({ session, workerId: A.workerId, jobId: A.jobId, attempt: offer.job.attempt, leaseId: offer.leaseId, fenceToken: offer.fenceToken, deviceKey }),
    "ack",
  );
  assert.equal(acked.result.status, 200, `ack expected 200: ${truncate(acked.result.body)}${acked.raw}`);
  assert.equal(acked.result.body.outcome, "acknowledged", `ack outcome${acked.raw}`);

  return { A, deviceKey, session, offer };
}

/** Upload [attempt_started(seq1, sandboxId), terminal(seq2)] over the real fenced
 * /worker-control/events path. Returns the sandboxId embedded in attempt_started. */
function uploadStartedAndTerminal(A, session, offer, deviceKey) {
  const sandboxId = `sbx-${randomUUID()}`;
  const rawEvents = [
    makeEvent(A, offer, { eventType: "attempt_started", seq: 1, payload: { sandboxId } }),
    makeEvent(A, offer, { eventType: "terminal", seq: 2, payload: { status: "succeeded", exitCode: 0, errorCode: null, errorMessage: null } }),
  ];
  const digested = run(computeEventDigests({ events: rawEvents }), "digests");
  assert.equal(digested.result.ok, true, `digest build ok${digested.raw}`);
  const batch = batchFromEvents(A, offer, digested.result.events);
  const uploaded = run(uploadEvents({ session, batch, deviceKey }), "events");
  assert.equal(uploaded.result.status, 200, `event upload expected 200: ${truncate(uploaded.result.body)}${uploaded.raw}`);
  assert.equal(uploaded.result.body.ack.status, "accepted", `events accepted${uploaded.raw}`);
  assert.equal(uploaded.result.body.ack.acceptedThroughSeq, 2, `accepted through seq 2${uploaded.raw}`);
  return sandboxId;
}

test(
  "E6F-10 telemetry contract: durable trace + tenant scoping + retained evidence",
  { skip: SKIP },
  () => {
    // Two hermetic orgs so tenant scoping (b) is proven against a REAL foreign tenant
    // that has its OWN job_events — not merely a nonexistent org id.
    const primary = bringUpLeasedWorker("E6T1");
    const foreign = bringUpLeasedWorker("E6T2");
    const { A } = primary;
    const B = foreign.A;

    const sandboxId = uploadStartedAndTerminal(A, primary.session, primary.offer, primary.deviceKey);
    uploadStartedAndTerminal(B, foreign.session, foreign.offer, foreign.deviceKey);

    // ── (a) DURABLE TRACE: exec-source → job → attempt → lease → sandbox ──────────
    const traced = run(queryJobEventTrace({ organizationId: A.orgId, jobId: A.jobId }), "trace");
    assert.equal(traced.result.ok, true, `trace probe ok${traced.raw}`);
    // exec-source end: the job carries its seeded source_kind + owning company.
    assert.ok(traced.result.job, `job row present (exec-source)${traced.raw}`);
    assert.equal(
      traced.result.job.sourceKind,
      "one_shot",
      `job carries the seeded execution source_kind (the exec-source end of the trace)${traced.raw}`,
    );
    assert.equal(traced.result.job.companyId, A.companyId, `job scoped to its company${traced.raw}`);

    const events = traced.result.events;
    assert.equal(events.length, 2, `exactly the two uploaded job_events${traced.raw}`);
    // Contiguous ordering: seq 1 attempt_started, seq 2 terminal — no gap.
    assert.deepEqual(events.map((e) => e.sequence), [1, 2], `job_events ordered by contiguous sequence${traced.raw}`);
    const started = events[0];
    const terminal = events[1];
    assert.equal(started.eventType, "attempt_started", `first event is attempt_started${traced.raw}`);
    assert.equal(terminal.eventType, "terminal", `second event is terminal${traced.raw}`);
    // job → attempt → lease chain is fully linked and consistent across the two rows.
    assert.equal(started.jobId, A.jobId, `event carries the job${traced.raw}`);
    assert.match(started.attemptId, UUID, `attempt id present (job→attempt link)${traced.raw}`);
    assert.equal(started.attemptId, terminal.attemptId, `both events share one attempt${traced.raw}`);
    assert.equal(started.attemptNumber, primary.offer.job.attempt, `attempt number matches the lease offer${traced.raw}`);
    assert.equal(started.leaseId, primary.offer.leaseId, `event lease === the acked lease (attempt→lease link)${traced.raw}`);
    assert.equal(terminal.leaseId, primary.offer.leaseId, `terminal shares the lease${traced.raw}`);
    // sandbox end: parsed from the attempt_started jsonb payload (payload-only, no FK).
    assert.equal(started.sandboxId, sandboxId, `terminal sandboxId surfaced from attempt_started payload (lease→sandbox link)${traced.raw}`);
    assert.equal(terminal.sandboxId, null, `terminal event carries no sandboxId (payload-only on attempt_started)${traced.raw}`);

    // ── (b) TENANT SCOPING: a foreign-org aoa_app read of A's job_events is empty ──
    // Positive control: aoa_app scoped to A's OWNING org sees A's rows.
    const ownScoped = run(queryJobEventsAsApp({ jobId: A.jobId, scopeOrganizationId: A.orgId }), "app-own");
    assert.equal(ownScoped.result.ok, true, `owner-scoped aoa_app read ok${ownScoped.raw}`);
    assert.equal(ownScoped.result.total, 2, `owner-scoped aoa_app read sees A's 2 job_events${ownScoped.raw}`);
    // Foreign: aoa_app scoped to org B sees ZERO of A's job_events under FORCE RLS.
    const foreignScoped = run(queryJobEventsAsApp({ jobId: A.jobId, scopeOrganizationId: B.orgId }), "app-foreign");
    assert.equal(foreignScoped.result.ok, true, `foreign-scoped aoa_app read ok${foreignScoped.raw}`);
    assert.equal(
      foreignScoped.result.total,
      0,
      `a non-owner aoa_app read of a FOREIGN org's job_events must be EMPTY (RLS isolation)${foreignScoped.raw}`,
    );
    // Cross-check: org B CAN see its OWN job_events under the same scope mechanism —
    // proves the 0 above is tenant isolation, not a broken grant/scope.
    const foreignOwn = run(queryJobEventsAsApp({ jobId: B.jobId, scopeOrganizationId: B.orgId }), "app-foreign-own");
    assert.equal(foreignOwn.result.ok, true, `B-scoped aoa_app read of B's own job ok${foreignOwn.raw}`);
    assert.equal(foreignOwn.result.total, 2, `org B sees its OWN 2 job_events (scope works)${foreignOwn.raw}`);

    // ── (c) EVIDENCE: the repointed collector returns the job's events ────────────
    // gatherEvents runs `docker compose exec postgres psql` under the owner role (no RLS)
    // and returns up to the last 500 job_events across the stack. The repoint
    // (worker_events/seq → job_events/sequence) is what makes A's rows appear at all.
    const collected = gatherEvents(COMPOSE_FILE);
    assert.ok(Array.isArray(collected), "collector returns an events array");
    const mine = collected.filter((row) => row && row.job_id === A.jobId);
    assert.ok(mine.length >= 2, `repointed collector retains A's job_events (got ${mine.length})`);
    const collectedTypes = new Set(mine.map((row) => row.event_type));
    assert.ok(collectedTypes.has("attempt_started"), "retained evidence includes the attempt_started event");
    assert.ok(collectedTypes.has("terminal"), "retained evidence includes the terminal event");
  },
);
