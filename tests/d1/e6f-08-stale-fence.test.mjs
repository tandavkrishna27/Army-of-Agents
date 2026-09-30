// -----------------------------------------------------------------------------
// E6F-08 — LIVE stale-fence non-disclosure proof (DE-17; Linux/CI ONLY — requires
// Docker + a running docker-compose.d1.yml stack). The runtime counterpart to the
// in-process hostile isolation suite's no-existence-oracle invariant
// (@armyofagents/sandbox-provider-contract runSandboxIsolationConformance §2.3):
// a STALE fence on a real lease must be denied IDENTICALLY to a nonexistent lease —
// a caller can never distinguish "exists but your fence is stale" from "gone".
//
//   AOA_D1_LIVE=1 node --test tests/d1/e6f-08-stale-fence.test.mjs
//
// Without AOA_D1_LIVE=1 it SKIPS cleanly — NEVER faked (DEC-03). Bring-up = E6F-03.
//
// Built on the LIVE-GREEN E6F harness (enroll/poll/ack over real Ed25519 device
// proofs). One hermetic org (unique issue prefix 'E68…' so it never collides with
// E6F-03 'E6F', E6F-01 'E6R', or E6F-04 'E64…' on the same live stack). The load-
// bearing invariant is EQUALITY: a stale-fence ack on a REAL lease and a missing-
// lease ack share the SAME HTTP status, error code, response key-set, and body
// (modulo per-request correlationId/serverTime). A positive control (the worker's
// OWN valid ack → 200) proves the denials are real fence enforcement, not a dead
// lease.
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
import { randomBytes, randomUUID } from "node:crypto";
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
} from "./lib/e6f-harness.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FENCE = /^[A-Za-z0-9_-]{43,}$/;
// Every code here hides existence identically for a stale-fence vs a missing lease;
// membership keeps the specific-code assertion non-brittle while EQUALITY stays the
// hard gate invariant.
const NON_DISCLOSING_ACK_DENIALS = new Set(["stale_fence", "target_revoked", "unauthorized", "attempt_terminal"]);

const missingFence = () => randomBytes(32).toString("base64url"); // 43 chars ∈ FENCE

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

function stripVolatile(body) {
  if (!body || typeof body !== "object") return body;
  const { correlationId: _correlationId, serverTime: _serverTime, ...rest } = body;
  return rest;
}

function sortedKeys(body) {
  return body && typeof body === "object" ? Object.keys(body).sort() : [];
}

test(
  "E6F-08 CONTROL-PLANE gate (harness-driven; no worker daemon, no device) stale-fence non-disclosure: a stale fence on a real lease is denied IDENTICALLY to a nonexistent lease",
  { skip: SKIP },
  () => {
    const A = newScenarioIds();
    const prefix = `E68${A.slug}`.slice(0, 12).toUpperCase();
    const deviceKey = generateDeviceKey();
    const code = newEnrollmentCode();

    // ── 1. Seed one hermetic org + enroll one dedicated worker over the real device-proof path ──
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

    // ── 2. Poll → the worker's OWN lease offer ────────────────────────────────
    const offerPoll = run(poll({ session, workerId: A.workerId, targetId: A.targetId, deviceKey }), "poll-offer");
    assert.equal(offerPoll.result.status, 200, `poll expected 200: ${truncate(offerPoll.result.body)}${offerPoll.raw}`);
    assert.equal(offerPoll.result.body.outcome, "offer", `poll must offer the worker's own job${offerPoll.raw}`);
    const offer = offerPoll.result.body.body;
    assert.match(offer.leaseId, UUID, `offer leaseId shape${offerPoll.raw}`);
    assert.match(offer.fenceToken, FENCE, `offer fence shape${offerPoll.raw}`);

    // ── 3. POSITIVE CONTROL — the worker's OWN valid ack → 200 acknowledged ───
    const ackValid = run(
      ack({
        session,
        workerId: A.workerId,
        jobId: A.jobId,
        attempt: offer.job.attempt,
        leaseId: offer.leaseId,
        fenceToken: offer.fenceToken,
        deviceKey,
      }),
      "ack-valid",
    );
    assert.equal(ackValid.result.status, 200, `valid ack expected 200: ${truncate(ackValid.result.body)}${ackValid.raw}`);
    assert.equal(ackValid.result.body.outcome, "acknowledged", `valid ack outcome${ackValid.raw}`);

    // ── 4. Stale-fence ack on the REAL lease vs missing-lease ack ─────────────
    // Stale: the real leaseId but a bogus/stale fence token.
    const ackStale = run(
      ack({
        session,
        workerId: A.workerId,
        jobId: A.jobId,
        attempt: offer.job.attempt,
        leaseId: offer.leaseId,
        fenceToken: missingFence(),
        deviceKey,
      }),
      "ack-stale-fence",
    );
    // Missing: a random nonexistent lease (schema-valid values).
    const ackMissing = run(
      ack({
        session,
        workerId: A.workerId,
        jobId: randomUUID(),
        attempt: 1,
        leaseId: randomUUID(),
        fenceToken: missingFence(),
        deviceKey,
      }),
      "ack-missing",
    );
    const raws = `${ackStale.raw}${ackMissing.raw}`;

    // Neither may succeed.
    assert.notEqual(ackStale.result.status, 200, `stale-fence ack must NOT succeed: ${truncate(ackStale.result.body)}${raws}`);
    assert.notEqual(ackMissing.result.status, 200, `missing-lease ack must NOT succeed: ${truncate(ackMissing.result.body)}${raws}`);

    // EQUALITY (the gate invariant): a stale fence and a missing lease are indistinguishable.
    assert.equal(
      ackStale.result.status,
      ackMissing.result.status,
      `stale vs missing ack must share HTTP status (${ackStale.result.status} vs ${ackMissing.result.status})${raws}`,
    );
    assert.equal(
      ackStale.result.body.code,
      ackMissing.result.body.code,
      `stale vs missing ack must share the error code — lease existence must not leak ` +
        `(${ackStale.result.body.code} vs ${ackMissing.result.body.code})${raws}`,
    );
    assert.deepEqual(
      sortedKeys(ackStale.result.body),
      sortedKeys(ackMissing.result.body),
      `stale vs missing ack must share their response key-set${raws}`,
    );
    assert.deepEqual(
      stripVolatile(ackStale.result.body),
      stripVolatile(ackMissing.result.body),
      `stale vs missing ack body must be byte-identical (modulo correlationId/serverTime)${raws}`,
    );

    // The denial must be a non-disclosing code, and must never echo the real fence/lease.
    assert.ok(
      NON_DISCLOSING_ACK_DENIALS.has(ackStale.result.body.code),
      `ack denial must be a non-disclosing code, got "${ackStale.result.body.code}"${raws}`,
    );
    const staleSerialized = JSON.stringify(ackStale.result.body);
    assert.ok(!staleSerialized.includes(offer.fenceToken), `stale-fence denial must not echo the real fence token${raws}`);
  },
);
