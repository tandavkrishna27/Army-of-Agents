// -----------------------------------------------------------------------------
// E6F-03 — LIVE networked worker-control smoke (Linux/CI ONLY — requires Docker +
// a running docker-compose.d1.yml stack). The first live suite of the
// E6-D1-FOUNDATION gate: it drives the control-plane's REAL /api/worker-control/*
// endpoints across the segmented D1 network and proves the full
//   enroll -> (seeded submit + placement) -> poll -> lease -> ack -> fake-execute
// path works end to end, with genuine Ed25519 device proofs (no security check is
// weakened or bypassed). There is NO live worker-daemon loop — the harness plays
// the worker with HTTP calls + real proofs.
//
//   AOA_D1_LIVE=1 node --test tests/d1/e6f-03-networked-smoke.test.mjs
//
// Without AOA_D1_LIVE=1 (e.g. the Windows dev box, or any host without the stack
// up) it SKIPS cleanly — it is NEVER faked. Bring-up:
//   cp docker/d1/.env.example docker/d1/.env   # DEP-001 admitted digests
//   docker compose -f docker-compose.d1.yml up -d
//
// ── Seeding approach (why not test-support) ──────────────────────────────────
// Board routes need actor.type==='board'; the clean test-support session-mint seam
// is BLOCKED here (assertTestSupportFlagSafe demands a loopback-only bind, but the
// D1 control-plane binds 0.0.0.0 by design, and the stack is
// AOA_DEPLOYMENT_MODE=authenticated). So the scenario is seeded by a script run
// INSIDE the control-plane container (owner/superuser DATABASE_URL bypasses RLS for
// writes; the server reads under aoa_app/aoa_operator via the deployed RLS
// policies). The placement decision is written by direct SQL (job_attempts has no
// static-context column; the poll candidate SELECT filters only on the concrete
// placement columns, and the two hashes are computed with the SAME worker-protocol
// canonicalizer the server re-derives). See tests/d1/lib/e6f-harness.mjs for the
// full rationale, incl. the post-enroll worker-liveness stamp (enroll does not set
// last_seen_at, which the poll authority gate requires).
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SKIP,
  FAKE_PROVIDER_API_URL,
  FAKE_PROVIDER_CTL_URL,
  newScenarioIds,
  generateDeviceKey,
  newEnrollmentCode,
  buildWorkerHello,
  seedScenario,
  stampWorkerLiveness,
  enroll,
  poll,
  ack,
  containerFetch,
} from "./lib/e6f-harness.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FENCE = /^[A-Za-z0-9_-]{43,}$/;
const FIXTURE_ID = "batch-success"; // a golden fixture guaranteed in tests/fixtures/distributed-execution/

/** Assert a `docker exec` step produced a parseable __E6F_RESULT__; else surface
 * the raw stdout/stderr so a live CI failure is diagnosable in one pass. */
function stepResult(res, label) {
  assert.ok(
    res.result !== null && res.result !== undefined,
    `${label}: no result parsed (exit=${res.status}${res.error ? ` error=${res.error}` : ""})\n` +
      `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  );
  return res.result;
}

test("E6F-03 networked smoke: enroll -> poll -> lease -> ack -> fake-execute", { skip: SKIP }, () => {
  const ids = newScenarioIds();
  const deviceKey = generateDeviceKey();
  const code = newEnrollmentCode();
  const hello = buildWorkerHello({ workerId: ids.workerId, targetId: ids.targetId });
  const providerId = `e6f-${ids.slug}`;

  // 1. Seed org/company/organization-target + enrollment code/route + queued batch
  //    job with a lease-eligible placement (control-plane container, owner DB).
  const seed = stepResult(seedScenario({ ids, code }), "seed");
  assert.equal(seed.ok, true, `seed failed: ${JSON.stringify(seed)}`);
  assert.match(seed.registeredProfileHash, /^[0-9a-f]{64}$/, "seed registered profile hash");
  assert.match(seed.providerDigest, /^[0-9a-f]{64}$/, "seed provider digest");

  // 2. ENROLL over the real device-proof scheme -> 200 + a worker session JWT.
  const enrolled = stepResult(enroll({ code: code.code, hello, deviceKey }), "enroll");
  assert.equal(enrolled.status, 200, `enroll expected 200, got ${enrolled.status}: ${JSON.stringify(enrolled.body)}`);
  assert.ok(typeof enrolled.session === "string" && enrolled.session.length > 0, "enroll must return an aoa-worker-session header");
  assert.equal(enrolled.body.outcome, "enrolled", `enroll outcome: ${JSON.stringify(enrolled.body)}`);
  assert.equal(enrolled.body.workerId, ids.workerId, "enroll echoes the worker id");
  assert.equal(enrolled.body.targetId, ids.targetId, "enroll echoes the target id");

  // 3. Worker liveness (a real daemon heartbeats before polling; enroll leaves
  //    last_seen_at NULL and the poll authority gate requires it fresh).
  const liveness = stepResult(stampWorkerLiveness({ workerId: ids.workerId, targetId: ids.targetId }), "liveness");
  assert.equal(liveness.workerUpdated, 1, `expected the enrolled worker row to be stamped: ${JSON.stringify(liveness)}`);
  assert.equal(liveness.targetUpdated, 1, `expected the target row to be stamped: ${JSON.stringify(liveness)}`);

  // 4. POLL -> exactly one lease offer for the placed job.
  const polled = stepResult(
    poll({ session: enrolled.session, workerId: ids.workerId, targetId: ids.targetId, deviceKey }),
    "poll",
  );
  assert.equal(polled.status, 200, `poll expected 200, got ${polled.status}: ${JSON.stringify(polled.body)}`);
  assert.equal(polled.body.outcome, "offer", `poll must return an offer, got: ${JSON.stringify(polled.body)}`);
  const offer = polled.body.body;
  assert.match(offer.fenceToken, FENCE, `offer fenceToken shape: ${offer.fenceToken}`);
  assert.match(offer.leaseId, UUID, `offer leaseId shape: ${offer.leaseId}`);
  assert.equal(offer.workerId, ids.workerId, "offer worker id");
  assert.equal(offer.job.jobId, ids.jobId, "offer carries the seeded job");
  assert.equal(offer.job.workloadType, "batch", "offer job workload type");
  const attempt = offer.job.attempt;

  // 5. ACK the lease (must land within the ack deadline; the URL carries the lease id).
  const acked = stepResult(
    ack({
      session: enrolled.session,
      workerId: ids.workerId,
      jobId: ids.jobId,
      attempt,
      leaseId: offer.leaseId,
      fenceToken: offer.fenceToken,
      deviceKey,
    }),
    "ack",
  );
  assert.equal(acked.status, 200, `ack expected 200, got ${acked.status}: ${JSON.stringify(acked.body)}`);
  assert.equal(acked.body.outcome, "acknowledged", `ack outcome: ${JSON.stringify(acked.body)}`);
  assert.equal(acked.body.leaseId, offer.leaseId, "ack echoes the lease id");

  // 6. FAKE-EXECUTE: the harness (playing the leased worker) drives the deterministic
  //    fake provider's declared API and reads its ledger — a per-run providerId +
  //    /reset keep it hermetic. Proves the create+execute substrate on the networked
  //    stack (reuses the fixture + /script,/invoke,/invocations pattern of
  //    fake-provider-job.test.mjs).
  const reset = stepResult(
    containerFetch("test-runner", { url: `${FAKE_PROVIDER_CTL_URL}/reset`, method: "POST", body: {} }),
    "fake-reset",
  );
  assert.equal(reset.status, 200, `fake /reset: ${JSON.stringify(reset.body)}`);

  const scripted = stepResult(
    containerFetch("test-runner", { url: `${FAKE_PROVIDER_CTL_URL}/script`, method: "POST", body: { providerId, fixtureId: FIXTURE_ID } }),
    "fake-script",
  );
  assert.equal(scripted.status, 200, `fake /script: ${JSON.stringify(scripted.body)}`);

  const created = stepResult(
    containerFetch("test-runner", { url: `${FAKE_PROVIDER_API_URL}/invoke`, method: "POST", body: { providerId, op: "create", args: {} } }),
    "fake-create",
  );
  assert.equal(created.status, 200, `fake create: ${JSON.stringify(created.body)}`);

  const executed = stepResult(
    containerFetch("test-runner", { url: `${FAKE_PROVIDER_API_URL}/invoke`, method: "POST", body: { providerId, op: "execute", args: {} } }),
    "fake-execute",
  );
  assert.equal(executed.status, 200, `fake execute: ${JSON.stringify(executed.body)}`);

  const ledger = stepResult(
    containerFetch("test-runner", { url: `${FAKE_PROVIDER_CTL_URL}/invocations?providerId=${providerId}`, method: "GET" }),
    "fake-ledger",
  );
  assert.equal(ledger.status, 200, `fake /invocations: ${JSON.stringify(ledger.body)}`);
  const ops = JSON.stringify(ledger.body);
  assert.match(ops, /"op":"create"/, `ledger records create: ${ops}`);
  assert.match(ops, /"op":"execute"/, `ledger records execute: ${ops}`);
});
