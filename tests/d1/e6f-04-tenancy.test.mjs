// -----------------------------------------------------------------------------
// E6F-04 — LIVE available-path tenancy gate (Linux/CI ONLY — requires Docker + a
// running docker-compose.d1.yml stack). The third live suite of the
// E6-D1-FOUNDATION campaign, built on the LIVE-GREEN E6F-03 harness.
//
//   AOA_D1_LIVE=1 node --test tests/d1/e6f-04-tenancy.test.mjs
//
// Without AOA_D1_LIVE=1 (Windows dev box, or any host without the stack up) it
// SKIPS cleanly — it is NEVER faked. Bring-up is identical to E6F-03.
//
// ── What this proves (test-gates.md E6F-04) ──────────────────────────────────
// "zero cross-Organization reads/existence disclosures in the available
// submit/enroll/placement/lease paths." The LOAD-BEARING invariant is UNIFORM
// NON-DISCLOSURE: a foreign-tenant resource must produce the BYTE-IDENTICAL
// outcome as a genuinely nonexistent one (same HTTP status, same outcome/error
// code, same response key-set, no leaked id/count) — NEVER a distinct
// "forbidden but exists" that reveals existence. Each attack is therefore
// asserted for EQUALITY against its nonexistent-resource baseline, not merely
// that each is denied. Positive controls prove the denials are real isolation,
// not a broken setup (Org A/B workers CAN enroll/poll/lease/ack their OWN org).
//
// ── The cross-org matrix (each verified against source; foreign == missing) ──
// TWO independent orgs A and B, each a full org/company/organization-target/
// enrollment-code/lease-eligible-job scenario (seedTenancyOrg, unique issue
// prefix). One dedicated worker enrolled per org over the REAL device-proof HTTP
// path (worker-enrollment binds exactly one worker per target).
//
//   A3 POLL non-disclosure — server/src/services/job-leasing.ts poll() runs
//     `runInTenant(appDb, auth.organizationId, ...)`; under FORCE RLS keyed on the
//     `aoa.organization_id` GUC (db/tenant-context.ts runInTenant), Org B's rows
//     are simply NOT PRESENT to Org A's candidate scan. Positive control: Org A
//     polls and receives its OWN job's offer (never Org B's jobId). Then Org A's
//     drained-state `no_work` is measured twice — once while Org B's job is still
//     PENDING+eligible (foreign eligible PRESENT), once after Org B leased it
//     (foreign eligible ABSENT). The two `no_work` bodies are byte-identical
//     (modulo per-request correlationId/serverTime), carry EXACTLY the 5
//     pollResponse keys, and never contain a foreign jobId — the presence of
//     foreign eligible work is undetectable. A cross-tenant `no_work` from Org B
//     confirms the same uniform shape.
//
//   A5 ACK non-disclosure — Org A's own valid worker acks a REAL Org B leaseId
//     (created by enrolling+polling Org B) vs a random nonexistent leaseId. In
//     job-leasing.ts ack(): the Org A worker passes ackAuthorityCurrent (its own
//     authority is valid), then `lockLeaseAckContext({ organizationId: A, ... })`
//     returns null for BOTH the RLS-hidden foreign lease and the missing lease →
//     BOTH throw JobLeasingError("stale_fence") → HTTP 409, byte-identical body.
//     The Org B lease's existence is never revealed (no "wrong tenant" vs
//     "unknown lease" distinction). Positive control: Org B's OWN worker acks its
//     lease → 200 acknowledged (so Org A's failure is tenancy, not a dead lease).
//
//   A2 ENROLL non-disclosure — a VALID Org A enrollment code presented with
//     hello.targetId = Org B's target vs a random nonexistent uuid. In
//     worker-enrollment.ts enroll(): the code routes to Org A and pins
//     stored.executionTargetId = Org A's target; findTargetByAuthority resolves
//     THAT target under Org A, then `request.hello.targetId !== target.id` throws
//     WorkerEnrollmentError("unauthorized") for BOTH the foreign and the missing
//     targetId → HTTP 401, byte-identical body (E4-D11: no target_revoked-vs-
//     not_found distinction). Positive control: Org A's worker enrolls with its
//     OWN target → 200 enrolled.
//
// The in-process model server/src/__tests__/job-placement.integration.test.ts
// asserts the same equalities directly: findActiveTarget foreign=null/missing=
// null/own=id ("foreign and missing IDs indistinguishable"), and foreign vs
// nonexistent jobs both "placement_not_found" inside the tenant transaction.
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
// The exact key-set of a pollResponseV1 `no_work` (job-leasing.ts poll()):
// pollResponseV1Schema.parse({ protocolVersion, correlationId, serverTime, outcome, retryAfterMs }).
const NO_WORK_KEYS = ["correlationId", "outcome", "protocolVersion", "retryAfterMs", "serverTime"];
// Every code below hides existence identically for a foreign vs a missing lease;
// the source-derived value for the A5 pair is "stale_fence" (lockLeaseAckContext
// returns null under RLS for both). Membership keeps the specific-code assertion
// non-brittle while EQUALITY (foreign == missing) stays the hard gate invariant.
const NON_DISCLOSING_ACK_DENIALS = new Set(["stale_fence", "target_revoked", "unauthorized", "attempt_terminal"]);

function truncate(value, max = 6000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text;
}

/** Assert a `docker exec` step produced a parseable __E6F_RESULT__; else surface the
 * raw stdout/stderr so a live CI failure is diagnosable in one pass (mirrors E6F-03). */
function stepResult(res, label) {
  assert.ok(
    res.result !== null && res.result !== undefined,
    `${label}: no result parsed (exit=${res.status}${res.error ? ` error=${res.error}` : ""})\n` +
      `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
  );
  return res.result;
}

/** Raw container stdout/stderr for one step, attached to every assertion about it so a
 * live failure is fully diagnosable without a rerun (mirrors E6F-01's `raw`). */
function diag(res, label) {
  return `\n--- ${label} stdout ---\n${truncate(res.stdout, 6000)}\n--- ${label} stderr ---\n${truncate(
    res.stderr,
    1500,
  )}`;
}

/** Run one in-container HTTP/seed step: parse its result and pre-render its raw dump. */
function run(res, label) {
  return { result: stepResult(res, label), raw: diag(res, label) };
}

/** Drop the two inherently per-request fields so "byte-identical" compares the stable
 * response identity (outcome/code/message/shape), never the request nonce or timestamp. */
function stripVolatile(body) {
  if (!body || typeof body !== "object") return body;
  const { correlationId: _correlationId, serverTime: _serverTime, ...rest } = body;
  return rest;
}

function sortedKeys(body) {
  return body && typeof body === "object" ? Object.keys(body).sort() : [];
}

const missingFence = () => randomBytes(32).toString("base64url"); // 43 chars ∈ FENCE

test(
  "E6F-04 available-path tenancy: zero cross-Organization reads/existence disclosures (enroll/poll/lease)",
  { skip: SKIP },
  () => {
    // Two hermetic, per-run orgs. Distinct slugs + distinct globally-unique issue
    // prefixes ('E64A…'/'E64B…') so neither collides with the other, with E6F-03's
    // 'E6F', or with E6F-01's 'E6R' on the same live stack.
    const A = newScenarioIds();
    const B = newScenarioIds();
    const prefixA = `E64A${A.slug}`.slice(0, 12).toUpperCase();
    const prefixB = `E64B${B.slug}`.slice(0, 12).toUpperCase();
    const deviceKeyA = generateDeviceKey();
    const deviceKeyB = generateDeviceKey();
    const codeA = newEnrollmentCode();
    const codeB = newEnrollmentCode();
    // Two extra VALID Org-A codes for the A2 enroll attacks (foreign-target + missing-target).
    const codeAforeignTarget = newEnrollmentCode();
    const codeAmissingTarget = newEnrollmentCode();

    // ── 1. Seed both orgs (control-plane container, owner DB; server reads under RLS) ──
    const seedA = run(
      seedTenancyOrg({ ids: A, code: codeA, issuePrefix: prefixA, extraCodes: [codeAforeignTarget, codeAmissingTarget] }),
      "seed-A",
    );
    assert.equal(seedA.result.ok, true, `seed A failed: ${truncate(seedA.result)}${seedA.raw}`);
    assert.match(seedA.result.registeredProfileHash, /^[0-9a-f]{64}$/, `seed A profile hash${seedA.raw}`);
    assert.match(seedA.result.providerDigest, /^[0-9a-f]{64}$/, `seed A provider digest${seedA.raw}`);
    const seedB = run(
      seedTenancyOrg({ ids: B, code: codeB, issuePrefix: prefixB, extraCodes: [] }),
      "seed-B",
    );
    assert.equal(seedB.result.ok, true, `seed B failed: ${truncate(seedB.result)}${seedB.raw}`);
    // Distinct orgs => distinct registered target profiles.
    assert.notEqual(
      seedA.result.registeredProfileHash,
      seedB.result.registeredProfileHash,
      `orgs A and B must seed DISTINCT registered target profiles${seedA.raw}${seedB.raw}`,
    );

    // ── 2. Enroll one dedicated worker per org (POSITIVE CONTROL for enroll) ──────
    const enrolledA = run(
      enroll({ code: codeA.code, hello: buildWorkerHello({ workerId: A.workerId, targetId: A.targetId }), deviceKey: deviceKeyA }),
      "enroll-A",
    );
    assert.equal(enrolledA.result.status, 200, `enroll A expected 200: ${truncate(enrolledA.result.body)}${enrolledA.raw}`);
    assert.equal(enrolledA.result.body.outcome, "enrolled", `enroll A outcome${enrolledA.raw}`);
    assert.equal(enrolledA.result.body.targetId, A.targetId, `enroll A echoes its OWN target${enrolledA.raw}`);
    const sessionA = enrolledA.result.session;
    assert.ok(typeof sessionA === "string" && sessionA.length > 0, `enroll A must return a worker session${enrolledA.raw}`);

    const enrolledB = run(
      enroll({ code: codeB.code, hello: buildWorkerHello({ workerId: B.workerId, targetId: B.targetId }), deviceKey: deviceKeyB }),
      "enroll-B",
    );
    assert.equal(enrolledB.result.status, 200, `enroll B expected 200: ${truncate(enrolledB.result.body)}${enrolledB.raw}`);
    const sessionB = enrolledB.result.session;
    assert.ok(typeof sessionB === "string" && sessionB.length > 0, `enroll B must return a worker session${enrolledB.raw}`);

    // ── 3. Worker liveness (poll authority gate needs last_seen_at fresh) ─────────
    const livenessA = run(stampWorkerLiveness({ workerId: A.workerId, targetId: A.targetId }), "liveness-A");
    assert.equal(livenessA.result.workerUpdated, 1, `worker A stamped${livenessA.raw}`);
    assert.equal(livenessA.result.targetUpdated, 1, `target A stamped${livenessA.raw}`);
    const livenessB = run(stampWorkerLiveness({ workerId: B.workerId, targetId: B.targetId }), "liveness-B");
    assert.equal(livenessB.result.workerUpdated, 1, `worker B stamped${livenessB.raw}`);
    assert.equal(livenessB.result.targetUpdated, 1, `target B stamped${livenessB.raw}`);

    const pollA = (label) =>
      run(poll({ session: sessionA, workerId: A.workerId, targetId: A.targetId, deviceKey: deviceKeyA }), label);
    const pollB = (label) =>
      run(poll({ session: sessionB, workerId: B.workerId, targetId: B.targetId, deviceKey: deviceKeyB }), label);

    // ── 4. A3 POSITIVE POLL — Org A sees its OWN job's offer, never Org B's ───────
    const offerPollA = pollA("poll-A-offer");
    assert.equal(offerPollA.result.status, 200, `poll A(offer) expected 200: ${truncate(offerPollA.result.body)}${offerPollA.raw}`);
    assert.equal(offerPollA.result.body.outcome, "offer", `poll A must offer its own job${offerPollA.raw}`);
    const offerA = offerPollA.result.body.body;
    assert.equal(offerA.job.jobId, A.jobId, `Org A offer carries Org A's OWN job${offerPollA.raw}`);
    assert.notEqual(offerA.job.jobId, B.jobId, `Org A offer must NEVER carry Org B's job${offerPollA.raw}`);
    assert.match(offerA.leaseId, UUID, `Org A offer leaseId shape${offerPollA.raw}`);
    // Org A's job is now `offered` (drained). Org B's job is still PENDING+eligible.

    // ── 5. A3 no_work #1 — foreign eligible job PRESENT (Org B pending), invisible ─
    const noWorkAforeignPresent = pollA("poll-A-nowork-foreign-present");
    assert.equal(noWorkAforeignPresent.result.status, 200, `poll A(no_work#1) expected 200${noWorkAforeignPresent.raw}`);
    assert.equal(noWorkAforeignPresent.result.body.outcome, "no_work", `poll A(no_work#1) drained${noWorkAforeignPresent.raw}`);
    const noWorkA1 = noWorkAforeignPresent.result.body;

    // ── 6. A3/A5 setup — Org B leases its OWN job (POSITIVE CONTROL + real lease B) ─
    const offerPollB = pollB("poll-B-offer");
    assert.equal(offerPollB.result.status, 200, `poll B(offer) expected 200: ${truncate(offerPollB.result.body)}${offerPollB.raw}`);
    assert.equal(offerPollB.result.body.outcome, "offer", `poll B must offer its own job${offerPollB.raw}`);
    const offerB = offerPollB.result.body.body;
    assert.equal(offerB.job.jobId, B.jobId, `Org B offer carries Org B's OWN job${offerPollB.raw}`);
    assert.notEqual(offerB.job.jobId, A.jobId, `Org B offer must NEVER carry Org A's job${offerPollB.raw}`);
    assert.match(offerB.leaseId, UUID, `Org B lease id shape${offerPollB.raw}`);
    assert.match(offerB.fenceToken, FENCE, `Org B fence shape${offerPollB.raw}`);

    // ── 7. A5 POSITIVE CONTROL — Org B's OWN worker acks lease B (prompt, within ackDeadline) ─
    const ackBpositive = run(
      ack({
        session: sessionB,
        workerId: B.workerId,
        jobId: B.jobId,
        attempt: offerB.job.attempt,
        leaseId: offerB.leaseId,
        fenceToken: offerB.fenceToken,
        deviceKey: deviceKeyB,
      }),
      "ack-B-positive",
    );
    assert.equal(ackBpositive.result.status, 200, `Org B own-lease ack expected 200: ${truncate(ackBpositive.result.body)}${ackBpositive.raw}`);
    assert.equal(ackBpositive.result.body.outcome, "acknowledged", `Org B own-lease ack outcome${ackBpositive.raw}`);
    assert.equal(ackBpositive.result.body.leaseId, offerB.leaseId, `Org B ack echoes its lease id${ackBpositive.raw}`);

    // ── 8. A3 no_work #2 — foreign eligible job now ABSENT (Org B's job leased) ────
    const noWorkAforeignAbsent = pollA("poll-A-nowork-foreign-absent");
    assert.equal(noWorkAforeignAbsent.result.status, 200, `poll A(no_work#2) expected 200${noWorkAforeignAbsent.raw}`);
    assert.equal(noWorkAforeignAbsent.result.body.outcome, "no_work", `poll A(no_work#2) drained${noWorkAforeignAbsent.raw}`);
    const noWorkA2 = noWorkAforeignAbsent.result.body;

    // Cross-tenant baseline: Org B's OWN drained-state no_work.
    const noWorkBpoll = pollB("poll-B-nowork");
    assert.equal(noWorkBpoll.result.status, 200, `poll B(no_work) expected 200${noWorkBpoll.raw}`);
    assert.equal(noWorkBpoll.result.body.outcome, "no_work", `poll B(no_work) drained${noWorkBpoll.raw}`);
    const noWorkB = noWorkBpoll.result.body;

    const pollRaws = `${noWorkAforeignPresent.raw}${noWorkAforeignAbsent.raw}${noWorkBpoll.raw}`;

    // ── 9. A3 ASSERTIONS — uniform non-disclosure over the poll path ──────────────
    // (a) Every no_work carries EXACTLY the 5 pollResponse keys — no `body`/offer,
    //     no `count`, no jobId leaks through an unexpected field.
    for (const [label, body, raw] of [
      ["no_work#1(foreign present)", noWorkA1, noWorkAforeignPresent.raw],
      ["no_work#2(foreign absent)", noWorkA2, noWorkAforeignAbsent.raw],
      ["no_work(Org B)", noWorkB, noWorkBpoll.raw],
    ]) {
      assert.deepEqual(sortedKeys(body), NO_WORK_KEYS, `${label} must carry EXACTLY the 5 no_work keys${raw}`);
      assert.equal(body.outcome, "no_work", `${label} outcome${raw}`);
      assert.equal(body.protocolVersion, 1, `${label} protocolVersion${raw}`);
      assert.equal(typeof body.retryAfterMs, "number", `${label} retryAfterMs is numeric${raw}`);
      assert.match(body.correlationId, UUID, `${label} correlationId is a per-request uuid${raw}`);
      // No foreign (or own) resource id may appear anywhere in a no_work.
      const serialized = JSON.stringify(body);
      assert.ok(!serialized.includes(B.jobId), `${label} must NOT leak Org B's jobId${raw}`);
      assert.ok(!serialized.includes(A.jobId), `${label} must NOT leak Org A's jobId${raw}`);
      assert.ok(!serialized.includes(B.targetId), `${label} must NOT leak Org B's targetId${raw}`);
      assert.ok(
        !/"body"|"job"|"jobId"|"leaseId"|"count"/.test(serialized),
        `${label} must carry no offer/job/lease/count field${raw}`,
      );
    }
    // (b) BYTE-IDENTICAL: Org A's no_work is the same whether Org B has an eligible
    //     job or not (same worker; only the foreign eligible job's existence toggled).
    assert.deepEqual(
      stripVolatile(noWorkA1),
      stripVolatile(noWorkA2),
      "A3: Org A no_work must be byte-identical whether a foreign eligible job is PRESENT or ABSENT " +
        `(foreign eligibility must be undetectable)${pollRaws}`,
    );
    assert.equal(
      noWorkA1.retryAfterMs,
      noWorkA2.retryAfterMs,
      `A3: retryAfterMs must not vary with foreign eligibility (${noWorkA1.retryAfterMs} vs ${noWorkA2.retryAfterMs})${pollRaws}`,
    );
    // (c) Cross-tenant: Org B's drained no_work is the SAME uniform shape.
    assert.deepEqual(
      stripVolatile(noWorkA1),
      stripVolatile(noWorkB),
      `A3: no_work shape must be uniform across tenants (Org A vs Org B)${pollRaws}`,
    );

    // ── 10. A5 ACK non-disclosure — foreign lease vs missing lease ────────────────
    // Foreign: Org A's OWN valid worker acks Org B's REAL lease (all real B values).
    const ackForeign = run(
      ack({
        session: sessionA,
        workerId: A.workerId,
        jobId: B.jobId,
        attempt: offerB.job.attempt,
        leaseId: offerB.leaseId,
        fenceToken: offerB.fenceToken,
        deviceKey: deviceKeyA,
      }),
      "ack-A-foreign-leaseB",
    );
    // Missing: Org A's worker acks a random nonexistent lease (schema-valid values).
    const ackMissing = run(
      ack({
        session: sessionA,
        workerId: A.workerId,
        jobId: randomUUID(),
        attempt: 1,
        leaseId: randomUUID(),
        fenceToken: missingFence(),
        deviceKey: deviceKeyA,
      }),
      "ack-A-missing",
    );
    const ackRaws = `${ackForeign.raw}${ackMissing.raw}`;
    // Neither may succeed.
    assert.notEqual(ackForeign.result.status, 200, `A5: foreign-lease ack must NOT succeed: ${truncate(ackForeign.result.body)}${ackRaws}`);
    assert.notEqual(ackMissing.result.status, 200, `A5: missing-lease ack must NOT succeed: ${truncate(ackMissing.result.body)}${ackRaws}`);
    // EQUALITY (the gate invariant): same status, same code, same key-set, same body.
    assert.equal(
      ackForeign.result.status,
      ackMissing.result.status,
      `A5: foreign vs missing ack must share HTTP status (${ackForeign.result.status} vs ${ackMissing.result.status})${ackRaws}`,
    );
    assert.equal(
      ackForeign.result.body.code,
      ackMissing.result.body.code,
      `A5: foreign vs missing ack must share the error code — foreign existence must not leak ` +
        `(${ackForeign.result.body.code} vs ${ackMissing.result.body.code})${ackRaws}`,
    );
    assert.deepEqual(
      sortedKeys(ackForeign.result.body),
      sortedKeys(ackMissing.result.body),
      `A5: foreign vs missing ack must share their response key-set${ackRaws}`,
    );
    assert.deepEqual(
      stripVolatile(ackForeign.result.body),
      stripVolatile(ackMissing.result.body),
      `A5: foreign vs missing ack body must be byte-identical (modulo correlationId/serverTime)${ackRaws}`,
    );
    // Source-derived expectation: lockLeaseAckContext returns null under RLS for both
    // => JobLeasingError("stale_fence") => HTTP 409. Membership keeps it non-brittle;
    // any of these codes is a uniform non-disclosing denial (never a 200 or an
    // exists-only signal), and equality above already forbids a foreign/missing split.
    assert.ok(
      NON_DISCLOSING_ACK_DENIALS.has(ackForeign.result.body.code),
      `A5: ack denial must be a non-disclosing code (source-derived: "stale_fence"), got "${ackForeign.result.body.code}"${ackRaws}`,
    );
    assert.equal(
      ackForeign.result.status,
      409,
      `A5: source-derived ack denial ("stale_fence") maps to HTTP 409, got ${ackForeign.result.status}${ackRaws}`,
    );
    assert.equal(ackForeign.result.body.redaction, "secret", `A5: ack error carries secret redaction${ackRaws}`);

    // ── 11. A2 ENROLL non-disclosure — foreign target vs missing target ───────────
    // Foreign: VALID Org A code, hello.targetId = Org B's REAL target.
    const enrollForeignTarget = run(
      enroll({
        code: codeAforeignTarget.code,
        hello: buildWorkerHello({ workerId: randomUUID(), targetId: B.targetId }),
        deviceKey: generateDeviceKey(),
      }),
      "enroll-A-foreign-target",
    );
    // Missing: VALID Org A code, hello.targetId = random nonexistent uuid.
    const enrollMissingTarget = run(
      enroll({
        code: codeAmissingTarget.code,
        hello: buildWorkerHello({ workerId: randomUUID(), targetId: randomUUID() }),
        deviceKey: generateDeviceKey(),
      }),
      "enroll-A-missing-target",
    );
    const enrollRaws = `${enrollForeignTarget.raw}${enrollMissingTarget.raw}`;
    // Neither may enroll (no session issued).
    assert.notEqual(enrollForeignTarget.result.status, 200, `A2: foreign-target enroll must NOT succeed: ${truncate(enrollForeignTarget.result.body)}${enrollRaws}`);
    assert.notEqual(enrollMissingTarget.result.status, 200, `A2: missing-target enroll must NOT succeed: ${truncate(enrollMissingTarget.result.body)}${enrollRaws}`);
    assert.equal(enrollForeignTarget.result.session ?? null, null, `A2: foreign-target enroll must issue no session${enrollRaws}`);
    assert.equal(enrollMissingTarget.result.session ?? null, null, `A2: missing-target enroll must issue no session${enrollRaws}`);
    // EQUALITY (the gate invariant): same status, same code, same key-set, same body.
    assert.equal(
      enrollForeignTarget.result.status,
      enrollMissingTarget.result.status,
      `A2: foreign vs missing enroll must share HTTP status (${enrollForeignTarget.result.status} vs ${enrollMissingTarget.result.status})${enrollRaws}`,
    );
    assert.equal(
      enrollForeignTarget.result.body.code,
      enrollMissingTarget.result.body.code,
      `A2: foreign vs missing enroll must share the error code — foreign target existence must not leak ` +
        `(${enrollForeignTarget.result.body.code} vs ${enrollMissingTarget.result.body.code})${enrollRaws}`,
    );
    assert.deepEqual(
      sortedKeys(enrollForeignTarget.result.body),
      sortedKeys(enrollMissingTarget.result.body),
      `A2: foreign vs missing enroll must share their response key-set${enrollRaws}`,
    );
    assert.deepEqual(
      stripVolatile(enrollForeignTarget.result.body),
      stripVolatile(enrollMissingTarget.result.body),
      `A2: foreign vs missing enroll body must be byte-identical (modulo correlationId/serverTime)${enrollRaws}`,
    );
    // Source-derived: enroll maps every non-malformed WorkerEnrollmentError to
    // "unauthorized" => HTTP 401 (E4-D11: no target_revoked-vs-not_found split).
    assert.equal(
      enrollForeignTarget.result.status,
      401,
      `A2: target-mismatch enroll denial maps to HTTP 401, got ${enrollForeignTarget.result.status}${enrollRaws}`,
    );
    assert.equal(
      enrollForeignTarget.result.body.code,
      "unauthorized",
      `A2: target-mismatch enroll denial code must be "unauthorized", got "${enrollForeignTarget.result.body.code}"${enrollRaws}`,
    );
  },
);
