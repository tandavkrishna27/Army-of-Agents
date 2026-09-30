// -----------------------------------------------------------------------------
// E6F-01 — LIVE networked lease-race gate (Linux/CI ONLY — requires Docker + a
// running docker-compose.d1.yml stack). The second live suite of the
// E6-D1-FOUNDATION campaign, built on the LIVE-GREEN E6F-03 harness.
//
//   AOA_D1_LIVE=1 node --test tests/d1/e6f-01-lease-races.test.mjs
//
// Without AOA_D1_LIVE=1 (Windows dev box, or any host without the stack up) it
// SKIPS cleanly — it is NEVER faked. Bring-up is identical to E6F-03.
//
// ── What this proves (test-gates.md E6F-01) ──────────────────────────────────
// "100 submit->placement->lease->ACK races across at least two registered target
// profiles, with exactly one winner each." The single-winner property is guaranteed
// by three stacked DB primitives, read from source:
//   1. lockWorkerLeaseAuthority's per-target `SELECT ... FOR UPDATE` (the outer
//      single-executor serialization for a given target), plus the candidate scan's
//      `FOR UPDATE ... SKIP LOCKED` on job_attempts
//      (packages/db/.../tenant/job-control.ts lockEligibleLeaseCandidates);
//   2. offerLease's compare-and-set `UPDATE job_attempts SET status='offered'
//      WHERE status='pending' ... RETURNING` (job-leasing.ts);
//   3. the partial-unique `leases_active_per_attempt_idx`
//      (uniqueIndex on attempt_id WHERE status in ('offered','active')).
// JOB-003 already proved a 100-claimer single-offer race on embedded-PG; this is the
// live-stack version, driven over the REAL /api/worker-control/* HTTP path with
// genuine Ed25519 device proofs (no security check weakened).
//
// ── Topology (dictated by source, not the plan's "3 workers per target") ─────
// Enrollment binds EXACTLY ONE worker per execution_target (worker-enrollment.ts
// findWorkerForBinding -> worker_transfer_denied on a second worker), so concurrency
// is N dedicated targets each with its own worker, PLUS concurrent/overlapping polls
// per worker. A worker's concurrent in-flight leases are bounded by
// min(provider.maxConcurrentOperations, hello.capacity.batchSlots) — there is no job
// COMPLETION step in THIS gate to free a slot, so the race target profile advertises
// a high (schema-valid, seed-controlled) maxConcurrentOperations + batchSlots so one
// worker can hold its whole per-target pool of leases at once. E6F-03's constants and
// seedScenario are left byte-for-byte unchanged; this suite only ADDS harness helpers.
//
// Counts (env-overridable; defaults match the gate procedure in
// docs/replatform/epics/E6-.../implementation-plan.md §7.3):
//   AOA_E6F_LEASE_RACES    = 100  drain jobs (the load-bearing 100-race count)
//   AOA_E6F_TARGET_PROFILES=   2  drain targets (registered profiles) the races span
//   AOA_E6F_RACE_CONCURRENCY= 24  concurrent pollers in the focused single-job race
//   AOA_E6F_RACE_WAVE      =  10  concurrent polls per drain wave
// One extra focused target + its single job runs the N-way single-winner sub-test,
// so the stack seeds RACES+1 jobs across TARGET_PROFILES+1 organization-scoped targets.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  SKIP,
  raceCapacity,
  buildRaceWorkerHello,
  newRaceScenarioIds,
  seedRaceScenario,
  stampWorkersLiveness,
  enroll,
  runLeaseRace,
} from "./lib/e6f-harness.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const RACES = intEnv("AOA_E6F_LEASE_RACES", 100);
const PROFILES = intEnv("AOA_E6F_TARGET_PROFILES", 2);
const CONCURRENCY = intEnv("AOA_E6F_RACE_CONCURRENCY", 24);
const WAVE = intEnv("AOA_E6F_RACE_WAVE", 10);

/** Even split of `total` across `buckets` (remainder spread over the first buckets),
 * so the per-target job counts sum to exactly `total`. */
function split(total, buckets) {
  const base = Math.floor(total / buckets);
  const extra = total % buckets;
  return Array.from({ length: buckets }, (_unused, index) => base + (index < extra ? 1 : 0));
}

function truncate(value, max = 4000) {
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

test(
  "E6F-01 lease races: 100 submit->placement->lease->ACK races across >=2 profiles, one winner each",
  { skip: SKIP },
  () => {
    assert.ok(PROFILES >= 2, `E6F-01 requires >=2 target profiles, got ${PROFILES}`);
    assert.ok(RACES >= PROFILES, `RACES (${RACES}) must be >= PROFILES (${PROFILES})`);

    const targetCount = PROFILES + 1; // PROFILES drain targets + 1 focused-race target
    const focusedIndex = PROFILES;
    const ids = newRaceScenarioIds({ targetCount });

    // Per-drain-target job split, summing to exactly RACES.
    const perTarget = split(RACES, PROFILES);
    const maxPerTarget = Math.max(...perTarget);
    // Provider maxConcurrentOperations + worker batchSlots: comfortably above the most
    // leases one worker holds (its whole pool), clamped under the schema max (10_000).
    const capacityCeiling = Math.min(9000, maxPerTarget + 32);

    // Build the seed's job list (drain jobs routed per target + one focused job) and a
    // per-target expected jobId pool for the routing assertion.
    const jobs = [];
    const poolByIndex = new Map();
    for (let index = 0; index < PROFILES; index += 1) {
      const pool = new Set();
      for (let n = 0; n < perTarget[index]; n += 1) {
        const jobId = randomUUID();
        jobs.push({ jobId, attemptId: randomUUID(), targetIndex: index });
        pool.add(jobId);
      }
      poolByIndex.set(index, pool);
    }
    const focusedJobId = randomUUID();
    jobs.push({ jobId: focusedJobId, attemptId: randomUUID(), targetIndex: focusedIndex });

    // 1. Seed everything in ONE control-plane exec.
    const seed = stepResult(
      seedRaceScenario({
        orgId: ids.orgId,
        companyId: ids.companyId,
        slug: ids.slug,
        issuePrefix: ids.issuePrefix,
        targets: ids.targets,
        jobs,
        capacityCeiling,
      }),
      "seed",
    );
    assert.equal(seed.ok, true, `seed failed: ${truncate(seed)}`);
    assert.equal(seed.jobCount, jobs.length, `seed job count: ${truncate(seed)}`);
    assert.equal(seed.targets.length, targetCount, `seed target count: ${truncate(seed)}`);
    for (const fact of seed.targets) {
      assert.match(fact.registeredProfileHash, HEX64, `registered profile hash: ${truncate(fact)}`);
      assert.match(fact.providerDigest, HEX64, `provider digest: ${truncate(fact)}`);
    }
    // >=2 DISTINCT registered profiles actually got seeded.
    const distinctProfileHashes = new Set(seed.targets.map((fact) => fact.registeredProfileHash));
    assert.ok(
      distinctProfileHashes.size >= PROFILES,
      `expected >=${PROFILES} distinct registered profiles, got ${distinctProfileHashes.size}`,
    );

    // 2. ENROLL one dedicated worker per target over the real device-proof scheme.
    const sessions = ids.targets.map((target) => {
      const hello = buildRaceWorkerHello({
        workerId: target.workerId,
        targetId: target.targetId,
        batchSlots: capacityCeiling,
      });
      const enrolled = stepResult(
        enroll({ code: target.code.code, hello, deviceKey: target.deviceKey }),
        `enroll[${target.index}]`,
      );
      assert.equal(
        enrolled.status,
        200,
        `enroll[${target.index}] expected 200, got ${enrolled.status}: ${truncate(enrolled.body)}`,
      );
      assert.ok(
        typeof enrolled.session === "string" && enrolled.session.length > 0,
        `enroll[${target.index}] must return an aoa-worker-session header`,
      );
      assert.equal(enrolled.body.outcome, "enrolled", `enroll[${target.index}] outcome: ${truncate(enrolled.body)}`);
      assert.equal(enrolled.body.workerId, target.workerId, `enroll[${target.index}] echoes worker id`);
      assert.equal(enrolled.body.targetId, target.targetId, `enroll[${target.index}] echoes target id`);
      return enrolled.session;
    });

    // 3. Worker liveness for every worker/target (poll authority gate needs it fresh).
    const liveness = stepResult(
      stampWorkersLiveness(
        ids.targets.map((target) => ({ workerId: target.workerId, targetId: target.targetId })),
      ),
      "liveness",
    );
    assert.equal(liveness.workerUpdated, targetCount, `all workers stamped: ${truncate(liveness)}`);
    assert.equal(liveness.targetUpdated, targetCount, `all targets stamped: ${truncate(liveness)}`);

    // 4. RACE + DRAIN — all concurrency inside ONE test-runner exec.
    const focusedTarget = ids.targets[focusedIndex];
    const drainTargets = ids.targets.slice(0, PROFILES);
    const raceRes = runLeaseRace({
      capacity: raceCapacity(capacityCeiling),
      maxWaves: Math.ceil(maxPerTarget / WAVE) + 5,
      focused: {
        session: sessions[focusedIndex],
        workerId: focusedTarget.workerId,
        targetId: focusedTarget.targetId,
        jobId: focusedJobId,
        privateKeyPem: focusedTarget.deviceKey.privateKeyPem,
        publicKeyDer: focusedTarget.deviceKey.publicKeyDer,
        concurrency: CONCURRENCY,
      },
      drain: drainTargets.map((target) => ({
        session: sessions[target.index],
        workerId: target.workerId,
        targetId: target.targetId,
        privateKeyPem: target.deviceKey.privateKeyPem,
        publicKeyDer: target.deviceKey.publicKeyDer,
        waveSize: Math.min(WAVE, Math.max(1, perTarget[target.index])),
      })),
    });
    const race = stepResult(raceRes, "race");
    // A single dump of the raw container stdout attached to every race assertion so a
    // live failure is fully diagnosable without a rerun.
    const raw = `\n--- race stdout ---\n${truncate(raceRes.stdout, 8000)}\n--- race stderr ---\n${truncate(
      raceRes.stderr,
      2000,
    )}`;

    // ── Focused single-job race: EXACTLY ONE winner ──────────────────────────
    const focused = race.focused;
    assert.equal(
      focused.other.length,
      0,
      `focused race: no poll may error/return an unexpected outcome; got ${truncate(focused.other)}${raw}`,
    );
    assert.equal(
      focused.offers.length,
      1,
      `focused race: EXACTLY ONE poll must win an offer, got ${focused.offers.length}: ${truncate(
        focused.offers,
      )}${raw}`,
    );
    assert.equal(
      focused.noWork,
      CONCURRENCY - 1,
      `focused race: the ${CONCURRENCY - 1} losers must all get no_work, got ${focused.noWork}${raw}`,
    );
    const focusedOffer = focused.offers[0];
    assert.equal(focusedOffer.jobId, focusedJobId, `focused offer must be the seeded focused job${raw}`);
    assert.equal(focusedOffer.workerId, focusedTarget.workerId, `focused offer echoes the worker${raw}`);
    assert.match(focusedOffer.leaseId, UUID, `focused offer leaseId shape: ${focusedOffer.leaseId}${raw}`);
    assert.ok(focused.ack, `focused winner must be acked${raw}`);
    assert.equal(focused.ack.status, 200, `focused ack expected 200: ${truncate(focused.ack.body)}${raw}`);
    assert.equal(
      focused.ack.body.outcome,
      "acknowledged",
      `focused ack outcome: ${truncate(focused.ack.body)}${raw}`,
    );
    assert.equal(focused.ack.body.leaseId, focusedOffer.leaseId, `focused ack echoes the lease id${raw}`);

    // ── Drain: 100 races, one winner each, no double-lease ────────────────────
    const drain = race.drain;
    assert.equal(drain.length, PROFILES, `drain covered every profile: ${truncate(drain.map((d) => d.workerId))}${raw}`);

    const allOffers = [];
    for (const workerResult of drain) {
      assert.equal(
        workerResult.anomalies.length,
        0,
        `drain worker ${workerResult.workerId}: zero poll/ack anomalies (losers get no_work, never 5xx); ` +
          `got ${truncate(workerResult.anomalies)}${raw}`,
      );
      assert.ok(
        workerResult.noWorkCount >= 1,
        `drain worker ${workerResult.workerId}: losing polls must return no_work (>=1 observed on drain-down)${raw}`,
      );
      for (const offer of workerResult.offers) allOffers.push({ ...offer, byWorker: workerResult.workerId });
    }

    // Every one of the RACES jobs leased EXACTLY ONCE.
    assert.equal(
      allOffers.length,
      RACES,
      `expected exactly ${RACES} offers across the drain, got ${allOffers.length}${raw}`,
    );
    const leaseIds = new Set(allOffers.map((offer) => offer.offer.leaseId));
    const jobIds = new Set(allOffers.map((offer) => offer.offer.jobId));
    assert.equal(leaseIds.size, RACES, `every offer must carry a DISTINCT leaseId (no double-lease)${raw}`);
    assert.equal(jobIds.size, RACES, `every offer must carry a DISTINCT jobId (no job leased twice)${raw}`);

    // The leased jobId set is EXACTLY the seeded drain-job set.
    const seededDrainJobIds = new Set(
      jobs.filter((job) => job.targetIndex < PROFILES).map((job) => job.jobId),
    );
    assert.equal(seededDrainJobIds.size, RACES, `sanity: seeded exactly ${RACES} drain jobs`);
    for (const jobId of jobIds) {
      assert.ok(seededDrainJobIds.has(jobId), `leased jobId ${jobId} is not a seeded drain job${raw}`);
    }
    for (const jobId of seededDrainJobIds) {
      assert.ok(jobIds.has(jobId), `seeded drain job ${jobId} was never leased${raw}`);
    }

    // Placement routing: each drain worker leased ONLY jobs placed to its own target.
    for (let index = 0; index < PROFILES; index += 1) {
      const workerResult = drain.find((entry) => entry.workerId === drainTargets[index].workerId);
      assert.ok(workerResult, `drain result for target ${index} present${raw}`);
      const pool = poolByIndex.get(index);
      for (const offer of workerResult.offers) {
        assert.ok(
          pool.has(offer.offer.jobId),
          `worker on target ${index} leased a job routed to a DIFFERENT profile: ${offer.offer.jobId}${raw}`,
        );
      }
    }

    // Every winning offer acked successfully within its deadline.
    for (const offer of allOffers) {
      assert.equal(
        offer.ackStatus,
        200,
        `offer ${offer.offer.leaseId} (job ${offer.offer.jobId}) ack expected 200, got ${offer.ackStatus}: ` +
          `${truncate(offer.ackBody)}${raw}`,
      );
      assert.equal(
        offer.ackOutcome,
        "acknowledged",
        `offer ${offer.offer.leaseId} ack outcome: ${offer.ackOutcome}${raw}`,
      );
      assert.equal(offer.ackLeaseId, offer.offer.leaseId, `ack echoes the lease id for ${offer.offer.leaseId}${raw}`);
      assert.match(offer.offer.leaseId, UUID, `offer leaseId shape: ${offer.offer.leaseId}${raw}`);
      assert.equal(offer.offer.attempt, 1, `offer attempt number: ${offer.offer.attempt}${raw}`);
    }
  },
);
