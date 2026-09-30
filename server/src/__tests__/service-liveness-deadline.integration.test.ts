// -----------------------------------------------------------------------------
// SVC-003b — THE LIVENESS DEADLINE, over real embedded PostgreSQL.
//
// ★★★ WHAT WAS NOT TRUE BEFORE THIS SUITE. SVC-003a made a worker EVENT move
// `service_instances.status`, and every path it built is edge-triggered by an event. The
// failure this suite is about is the ABSENCE of events: a worker whose supervision goes
// silent emits nothing, so the projection never runs, so the instance stays inside
// `service_instances_live_service_uq`, so SVC-002's reconciler can NEVER replace it. Its lease
// is reaped, its attempt and job go terminal — and `reapExpiredLeases` touches
// `service_instances` not at all. L-T8 measures that gap rather than asserting it.
//
// EVERY CASE NAMES THE MUTANT THAT MUST RE-RED IT; `SVC-003b-result.md` §4 records which did.
//
// ── WHAT IS REAL HERE AND WHAT IS NOT ───────────────────────────────────────────────────
//
// REAL: the embedded PostgreSQL and every constraint and partial index on
// `service_instances`; the poll/ACK-minted ACTIVE lease fence; `acceptEvent`'s durable append
// and SVC-003a's projection (so the liveness STAMP is measured on the shipped write path, not
// on a hand-written UPDATE); the repository's own `FOR UPDATE SKIP LOCKED` sweep; SVC-002's
// unchanged `insertServiceInstance`/`attributeServiceInstance` writers; and — in L-T1 — the
// whole `createServiceReconciler().tick()`, which is what proves the deadline is ARMED rather
// than merely present.
//
// NOT REAL, and stated before the first assertion so a green run is not over-read: the leased
// attempt is a placed BATCH job, not a service job, for the reason `SVC-003a-result.md` §7
// gives (leasing a real service job needs the fleet to advertise `workload.service` and the
// placement loop to place it). It weakens nothing here: the sweep keys on
// `service_instances.organization_id` and the instance's own status and timestamps, and never
// on the job's workload type; the STAMP keys on (job, attempt) attribution, which is the
// independence T4 of the SVC-003a suite already pins.
//
// AGES ARE BACK-DATED IN SQL, never simulated by sleeping. `last_observed_at` and `created_at`
// are moved into the past with `clock_timestamp() - interval`, so the ages the sweep computes
// are real database ages and no test waits three minutes.
// -----------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { canonicalEventDigestInputV1, type LeaseOfferV1 } from "@armyofagents/worker-protocol";
import type { ActiveFenceRequest, AcceptEventInput } from "@armyofagents/db";

import {
  setupJobControlFixture,
  ORG,
  COMPANY,
  WORKER,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";
import { runInTenant } from "../db/tenant-context.js";
import { decideServiceProjection } from "../services/service-health-projection.js";
import {
  createServiceReconciler,
  sweepOrganizationServiceLiveness,
} from "../services/service-reconciler.js";

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

const SERVICE = "a6900000-0000-4000-8000-000000000001";
const DEFINITION = { command: "node", args: ["queue-worker.js"], gracefulStopSeconds: 30 };

/** Both windows short and far apart, so a back-dated age can sit unambiguously between them.
 *  Never the shipped defaults: a suite using those could not tell a policy that is READ from
 *  one that is hardcoded. */
const POLICY = { livenessDeadlineMs: 60_000, admissionDeadlineMs: 300_000 };

function f(): JobControlFixture {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
  if (!fixture) throw new Error("fixture was not initialized");
  return fixture;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ref(instanceId: string, generation = 1, serviceId = SERVICE) {
  return { serviceId, serviceInstanceId: instanceId, generation };
}

/** One wire event, digest-computed exactly as the ingest service recomputes it, then handed to
 *  the REAL decider — so the stamp is measured on the shipped mapping, not a hand-built input. */
function event(offer: LeaseOfferV1, seq: number, eventType: string, payload: Record<string, unknown>) {
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
    eventType,
    payload,
  };
  return { ...base, eventDigest: sha256(canonicalEventDigestInputV1(base as never)) };
}

function acceptInput(wire: ReturnType<typeof event>): AcceptEventInput {
  return {
    eventId: wire.eventId,
    sequence: wire.seq,
    eventType: wire.eventType,
    fenceToken: wire.fenceToken,
    suppliedDigest: wire.eventDigest,
    recomputedDigest: wire.eventDigest,
    occurredAt: new Date(wire.occurredAt),
    payload: wire as unknown as Record<string, unknown>,
    terminalStatus: null,
    serviceProjection: decideServiceProjection({ eventType: wire.eventType, payload: wire.payload }),
  };
}

async function ingestDirect(identity: ActiveFenceRequest, wires: ReturnType<typeof event>[]) {
  return runInTenant(f().app.db, ORG, async (repos) => {
    const result = await repos.jobControl.acceptEvent({
      ...identity,
      batch: { events: wires.map(acceptInput) },
    });
    return {
      ack: result.ingest,
      projections: (result.serviceProjections ?? []).map((entry) => entry.result),
    };
  });
}

async function seedService(serviceId = SERVICE, generation = 1): Promise<void> {
  await f().admin`INSERT INTO services (id, organization_id, company_id, desired_state, generation)
    VALUES (${serviceId}, ${ORG}, ${COMPANY}, 'running', ${generation})`;
  await f().admin`INSERT INTO service_generations
    (id, organization_id, company_id, service_id, generation, definition)
    VALUES (${randomUUID()}, ${ORG}, ${COMPANY}, ${serviceId}, ${generation}, ${DEFINITION})`;
}

/** An instance created the way SVC-002's reconciler creates one, attributed to a real leased
 *  attempt when one is supplied. */
async function seedInstance(input: {
  status: string;
  seeded?: { jobId: string; attemptId: string };
  serviceId?: string;
  generation?: number;
}): Promise<string> {
  const id = randomUUID();
  await runInTenant(f().app.db, ORG, async (repos) => {
    const inserted = await repos.jobControl.insertServiceInstance({
      id,
      organizationId: ORG,
      companyId: COMPANY,
      serviceId: input.serviceId ?? SERVICE,
      generation: input.generation ?? 1,
      status: input.status,
    });
    if (inserted.outcome !== "inserted") throw new Error(`insert conflicted: ${inserted.outcome}`);
    if (input.seeded) {
      await repos.jobControl.attributeServiceInstance({
        organizationId: ORG,
        serviceInstanceId: id,
        jobId: input.seeded.jobId,
        attemptId: input.seeded.attemptId,
      });
    }
  });
  return id;
}

/** Back-date the row's timestamps IN SQL so the ages the sweep reads are real database ages. */
async function backdate(
  instanceId: string,
  ages: { observedSecondsAgo?: number | null; createdSecondsAgo?: number },
): Promise<void> {
  if (ages.observedSecondsAgo !== undefined) {
    if (ages.observedSecondsAgo === null) {
      await f().admin`UPDATE service_instances SET last_observed_at = NULL WHERE id = ${instanceId}`;
    } else {
      await f().admin`UPDATE service_instances
        SET last_observed_at = clock_timestamp() - make_interval(secs => ${ages.observedSecondsAgo})
        WHERE id = ${instanceId}`;
    }
  }
  if (ages.createdSecondsAgo !== undefined) {
    await f().admin`UPDATE service_instances
      SET created_at = clock_timestamp() - make_interval(secs => ${ages.createdSecondsAgo})
      WHERE id = ${instanceId}`;
  }
}

async function rowOf(instanceId: string): Promise<{ status: string; last_observed_at: Date | null }> {
  const [row] = await f().admin<{ status: string; last_observed_at: Date | null }[]>`
    SELECT status, last_observed_at FROM service_instances WHERE id = ${instanceId}`;
  return row ?? { status: "<absent>", last_observed_at: null };
}

async function liveInstanceIds(serviceId = SERVICE): Promise<string[]> {
  const rows = await f().admin<{ id: string }[]>`
    SELECT id FROM service_instances
    WHERE service_id = ${serviceId} AND status NOT IN ('stopped', 'failed', 'lost')
    ORDER BY created_at`;
  return rows.map((row) => row.id);
}

function sweep(limit = 64) {
  return sweepOrganizationServiceLiveness(f().app.db, {
    organizationId: ORG,
    limit,
    policy: POLICY,
  });
}

async function clearServiceState(): Promise<void> {
  await f().admin`DELETE FROM service_instances`;
  await f().admin`DELETE FROM service_generations`;
  await f().admin`DELETE FROM services`;
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("svc-003b-liveness");
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await fixture?.teardown(); } catch { /* ignore */ }
}, 60_000);

const suite = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

suite("SVC-003b — a silent worker's instance is terminalized and replaced", () => {
  const previousFlag = process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;

  beforeEach(async () => {
    process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "true";
    await clearServiceState();
  });

  afterEach(async () => {
    if (previousFlag === undefined) delete process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;
    else process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = previousFlag;
    await clearServiceState();
  });

  // ── L-T1 — THE WHOLE POINT, AND THE ARMING QUESTION IN ONE CASE ───────────────────────
  //
  // Driven through `createServiceReconciler().tick()` and NOT through
  // `sweepOrganizationServiceLiveness` directly, deliberately: the arming question is whether
  // anything CALLS the sweep, and a case that calls it itself cannot answer that. Every later
  // case uses the faster direct path.
  //
  // MUTANT L6: delete the sweep call site in `runTick` — this case reds and nothing else in
  // either suite does. MUTANT L10: run the sweep AFTER the convergence pages instead of
  // before — the instance still goes `lost`, but the replacement is a tick late, so
  // `created` is 0 here.
  it("★★★ L-T1 — ONE reconciler tick drives a silent instance `lost` AND creates its replacement", async () => {
    await seedService();
    const { seeded } = await f().activateLease(901);
    const stale = await seedInstance({ status: "healthy", seeded });
    await backdate(stale, { observedSecondsAgo: 120, createdSecondsAgo: 3_600 });
    expect(await liveInstanceIds()).toEqual([stale]);

    const reconciler = createServiceReconciler({
      appDb: f().app.db,
      listAdmittedOrganizationIds: async () => [ORG],
      livenessPolicy: POLICY,
      // A generous budget: this assertion is about ordering within one tick, not about
      // whether a 1 ms budget happened to admit both passes.
      tickBudgetMs: 5_000,
    });
    const result = await reconciler.tick();

    // The deadline fired...
    expect(result.livenessScanned).toBe(1);
    expect(result.livenessTerminalized).toBe(1);
    expect(result.livenessFailed).toBe(0);
    expect((await rowOf(stale)).status).toBe("lost");
    // ...and the SAME tick replaced it, because the terminalized row left
    // `service_instances_live_service_uq` before `listReconcilableServices` was read.
    expect(result.created).toBe(1);
    const live = await liveInstanceIds();
    expect(live).toHaveLength(1);
    expect(live[0]).not.toBe(stale);
  }, 120_000);

  // ── L-T2 — the negative half of L-T1, and it is the one that keeps services running ────
  //
  // MUTANT L1/L2/L4/L5 (any collapse of the two windows, or an inverted comparison): red.
  it("★ L-T2 — an instance observed inside the window is NOT touched", async () => {
    await seedService();
    const { seeded } = await f().activateLease(902);
    const fresh = await seedInstance({ status: "healthy", seeded });
    await backdate(fresh, { observedSecondsAgo: 5, createdSecondsAgo: 3_600 });

    const result = await sweep();
    expect(result.scanned).toBe(1);
    expect(result.terminalized).toEqual([]);
    expect(result.refusedIllegal).toEqual([]);
    expect((await rowOf(fresh)).status).toBe("healthy");
  }, 120_000);

  // ── L-T3 / L-T4 — the UNREADABLE arm, driven in both directions ───────────────────────
  //
  // ★ These two are the pair SVC-008b's lesson demands: "silent" and "never observed" are
  // different facts, and a deadline that terminalizes a LIVE instance because its observation
  // was unreadable is worse than the stuck instance it was fixing.
  it("★★★ L-T3 — a NEVER-OBSERVED instance past the LIVENESS window but inside ADMISSION is left alone", async () => {
    await seedService();
    // 120 s old: twice the liveness window, well inside the admission window. A sweep that
    // aged a missing observation against the liveness window would kill this row — an
    // instance whose worker has not polled yet, which is a normal startup state.
    // MUTANT L4: `COALESCE(last_observed_at, created_at)` in the sweep's SQL — this reds.
    const starting = await seedInstance({ status: "pending" });
    await backdate(starting, { observedSecondsAgo: null, createdSecondsAgo: 120 });
    expect((await rowOf(starting)).last_observed_at).toBeNull();

    const result = await sweep();
    expect(result.scanned).toBe(1);
    expect(result.terminalized).toEqual([]);
    expect((await rowOf(starting)).status).toBe("pending");
  }, 120_000);

  it("★ L-T4 — a NEVER-OBSERVED instance past the ADMISSION window IS terminalized", async () => {
    // The other half. Without it, `awaiting_first_observation` would be a stall with no exit
    // and a `pending` instance whose worker never arrives would wedge its service forever —
    // the same permanent wedge, reached through the honest arm.
    await seedService();
    const abandoned = await seedInstance({ status: "pending" });
    await backdate(abandoned, { observedSecondsAgo: null, createdSecondsAgo: 400 });

    const result = await sweep();
    expect(result.terminalized).toHaveLength(1);
    expect(result.terminalized[0]!.fromStatus).toBe("pending");
    expect((await rowOf(abandoned)).status).toBe("lost");
  }, 120_000);

  // ── L-T5 — THE STAMP, ON THE PATH THAT ACTUALLY CARRIES IT ────────────────────────────
  //
  // ★★★ THE STEADY STATE OF A HEALTHY SERVICE IS `noop_same_status`, FOREVER. SVC-008b's
  // supervisor emits `service_health healthy` every ~10 s onto a row that is already
  // `healthy`, so the projection moves nothing on the overwhelming majority of events. A
  // liveness stamp written only alongside a real status MOVE would go stale on every WORKING
  // service and the deadline would terminalize exactly the instances it exists to protect.
  //
  // MUTANT L11: move the stamp below the `noop_same_status` return in
  // `applyServiceProjectionForFence` — this reds and L-T1 stays green, which is the whole
  // reason this case exists separately.
  it("★★★ L-T5 — a repeated health tick (noop_same_status) REFRESHES the liveness stamp", async () => {
    await seedService();
    const { seeded, offer, identity } = await f().activateLease(905);
    const instanceId = await seedInstance({ status: "pending", seeded });

    await ingestDirect(identity, [
      event(offer, 1, "attempt_started", { sandboxId: "sbx-1" }),
      event(offer, 2, "service_instance_started", { ...ref(instanceId), providerResourceId: "sbx-1" }),
      event(offer, 3, "service_health", { ...ref(instanceId), status: "healthy", detail: null }),
    ]);
    expect((await rowOf(instanceId)).status).toBe("healthy");

    // Now age it past the deadline, then deliver ONE more health tick that moves NOTHING.
    await backdate(instanceId, { observedSecondsAgo: 120 });
    const second = await ingestDirect(identity, [
      event(offer, 4, "service_health", { ...ref(instanceId), status: "healthy", detail: "still up" }),
    ]);
    expect(second.projections).toEqual([{ outcome: "noop_same_status", fromStatus: "healthy" }]);

    // The status did not move — and the instance is nonetheless alive again.
    const after = await rowOf(instanceId);
    expect(after.status).toBe("healthy");
    expect(after.last_observed_at).not.toBeNull();
    const result = await sweep();
    expect(result.terminalized).toEqual([]);
    expect((await rowOf(instanceId)).status).toBe("healthy");
  }, 120_000);

  // ── L-T6 — a REFUSED observation does not hold an instance alive ──────────────────────
  //
  // The stamp sits AFTER attribution, identity and generation and before the no-write arms.
  // An event refused by one of the three fences is not evidence about this row, and letting it
  // stamp would give a worker the control plane has already rolled past a way to keep its
  // instance out of the deadline's reach forever — the deadline's own fail-open.
  //
  // MUTANT L12: move the stamp ABOVE the generation fence — this reds.
  it("★ L-T6 — a STALE-GENERATION event does not refresh the stamp", async () => {
    await seedService();
    const { seeded, offer, identity } = await f().activateLease(906);
    const instanceId = await seedInstance({ status: "healthy", seeded, generation: 2 });
    await backdate(instanceId, { observedSecondsAgo: 120, createdSecondsAgo: 3_600 });
    const before = (await rowOf(instanceId)).last_observed_at;

    // Generation 1 from a worker the control plane has rolled past.
    const refused = await ingestDirect(identity, [
      event(offer, 1, "service_health", { ...ref(instanceId, 1), status: "healthy", detail: null }),
    ]);
    expect(refused.projections).toEqual([{ outcome: "stale_generation", instanceGeneration: 2 }]);
    expect((await rowOf(instanceId)).last_observed_at?.getTime()).toBe(before?.getTime());

    // ...so the deadline still fires.
    const result = await sweep();
    expect(result.terminalized).toHaveLength(1);
    expect((await rowOf(instanceId)).status).toBe("lost");
  }, 120_000);

  // ── L-T7 — the sweep's population is the LIVE set, and it cannot resurrect ────────────
  //
  // MUTANT L13: drop `nonTerminalServiceInstanceStatus()` from the sweep's WHERE — the
  // terminal row is then scanned, condemned by age, and refused by the legality gate, so
  // `refusedIllegal` becomes non-empty. Both halves of this case red.
  it("★ L-T7 — an already-terminal instance is never scanned, and never re-terminalized", async () => {
    await seedService();
    const dead = await seedInstance({ status: "pending" });
    await f().admin`UPDATE service_instances SET status = 'stopped' WHERE id = ${dead}`;
    await backdate(dead, { observedSecondsAgo: 9_999, createdSecondsAgo: 9_999 });

    const result = await sweep();
    expect(result.scanned).toBe(0);
    expect(result.terminalized).toEqual([]);
    expect(result.refusedIllegal).toEqual([]);
    // `stopped` has no outgoing edge in the frozen table; the row keeps it.
    expect((await rowOf(dead)).status).toBe("stopped");
  }, 120_000);

  // ── L-T8 — THE GAP, MEASURED RATHER THAN ASSERTED ────────────────────────────────────
  //
  // ★★★ This is the case that shows the deadline is not redundant with machinery that already
  // exists. The lease reaper revokes an expired lease and terminalizes the ATTEMPT and the
  // JOB — and leaves `service_instances` exactly where it was. The instance stays inside the
  // live index and the reconciler can never replace it. Nothing before this ticket noticed.
  //
  // MUTANT: none needed — the first assertion is a measurement of the SHIPPED reaper. If a
  // later ticket teaches `reapExpiredLeases` to terminalize instances, THIS assertion is what
  // will say so, and this case should then be rewritten rather than deleted.
  it("★★★ L-T8 — the lease reaper terminalizes the attempt and leaves the instance LIVE; the deadline is what closes it", async () => {
    await seedService();
    const { seeded } = await f().activateLease(908);
    const orphan = await seedInstance({ status: "healthy", seeded });
    await backdate(orphan, { observedSecondsAgo: 120, createdSecondsAgo: 3_600 });

    // Expire the lease for real, then run the SHIPPED reaper. BOTH instants move: the frozen
    // `leases_authority_atomic_check` requires `ack_deadline < expires_at`, so back-dating the
    // expiry alone is rejected by the constraint rather than producing an expired lease.
    await f().admin`UPDATE leases
      SET ack_deadline = clock_timestamp() - interval '2 minutes',
          expires_at = clock_timestamp() - interval '1 minute'
      WHERE attempt_id = ${seeded.attemptId}`;
    const reaped = await runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.reapExpiredLeases({
        organizationId: ORG,
        limit: 16,
        baseBackoffMs: 1_000,
        maxBackoffMs: 10_000,
        now: new Date(),
      }));
    expect(reaped.revoked).toBeGreaterThanOrEqual(1);

    // ★ THE MEASUREMENT: the attempt is gone and the instance is untouched and STILL LIVE.
    const [attempt] = await f().admin<{ status: string }[]>`
      SELECT status FROM job_attempts WHERE id = ${seeded.attemptId}`;
    expect(["expired", "cancelled", "failed"]).toContain(attempt!.status);
    expect((await rowOf(orphan)).status).toBe("healthy");
    expect(await liveInstanceIds()).toEqual([orphan]);

    // And the deadline is what converts that into a replaceable state.
    const result = await sweep();
    expect(result.terminalized).toHaveLength(1);
    expect((await rowOf(orphan)).status).toBe("lost");
    expect(await liveInstanceIds()).toEqual([]);
  }, 120_000);

  // ── L-T13 — the tick REPORTS each terminalization, and does not back off after one ────
  //
  // Both halves came out of external review of PR #413 and both are measured here rather than
  // asserted in prose.
  //
  // (a) `onTerminalized` fires once PER INSTANCE with the row's identity and the status it was
  //     driven out of. A per-tick COUNT cannot tell an operator which service died, and a
  //     `lost` row records the status without the author (E9-F009 — the DURABLE half of this
  //     is deliberately NOT built, and this case does not claim it).
  // (b) `nextDelayMs` treats a terminalization as convergence work. If the sweep consumes the
  //     tick budget the convergence pages are skipped entirely, so `created` is 0 on a tick
  //     that has just made known work available — and the ORIGINAL `created > 0 ? active :
  //     idle` backed off to 30 s at exactly that moment.
  //
  // MUTANT L19: revert `nextDelayMs` to `result.created > 0`. MUTANT L20: drop the
  // `onTerminalized` loop.
  it("★ L-T13 — each terminalization is reported by instance, and shortens the next delay", async () => {
    await seedService();
    const { seeded } = await f().activateLease(913);
    const stale = await seedInstance({ status: "healthy", seeded });
    await backdate(stale, { observedSecondsAgo: 120, createdSecondsAgo: 3_600 });

    const reported: Array<{ serviceInstanceId: string; serviceId: string; fromStatus: string }> = [];
    const reconciler = createServiceReconciler({
      appDb: f().app.db,
      listAdmittedOrganizationIds: async () => [ORG],
      livenessPolicy: POLICY,
      tickBudgetMs: 5_000,
      activeDelayMs: 2_000,
      idleDelayMs: 30_000,
      onTerminalized: (entry) => reported.push(entry),
    });
    const result = await reconciler.tick();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      organizationId: ORG, serviceInstanceId: stale, serviceId: SERVICE, fromStatus: "healthy",
    });
    // (b) driven on a SYNTHETIC result with `created: 0`, because a real tick here also
    // creates the replacement — and a case that could not separate the two would pass under
    // the reverted `created > 0` for the wrong reason.
    expect(reconciler.nextDelayMs({ ...result, created: 0, livenessTerminalized: 1 })).toBe(2_000);
    expect(reconciler.nextDelayMs({ ...result, created: 0, livenessTerminalized: 0 })).toBe(30_000);
  }, 120_000);

  // ── L-T12 — THE BOUNDED BATCH MUST NOT STARVE ────────────────────────────────────────
  //
  // ★★★ THIS IS A REGRESSION CASE FOR A DEFECT THIS PR SHIPPED AND EXTERNAL REVIEW CAUGHT.
  // The first version ordered the sweep by `created_at`. A HEALTHY instance never leaves the
  // live set, so for a tenant with more live instances than one batch holds, the oldest-created
  // healthy rows filled every batch on every tick and a silent instance created AFTER them was
  // never inspected — a stuck service the deadline cannot see, which is precisely the failure
  // this ticket exists to remove. It is the same starvation bug review found in
  // `listReconcilableServices` on PR #406, rebuilt one function along.
  //
  // The shape is chosen to red under the old ordering and pass under the new one: FOUR live
  // instances, a batch limit of THREE, the silent one created LAST. Under `ORDER BY created_at`
  // the three fresh ones fill the window and the silent one is never scanned. Under
  // least-recently-heard-from it is first.
  //
  // MUTANT L18: revert the ORDER BY to `asc(createdAt)`.
  it("★★★ L-T12 — a silent instance created LAST is still found when the batch is full", async () => {
    // Four services, because `service_instances_live_service_uq` permits one live instance per
    // (organization, service) — four live instances means four services.
    const services = [1, 2, 3, 4].map((n) => `a6900000-0000-4000-8000-00000000000${n}`);
    for (const id of services) await seedService(id);
    const fresh: string[] = [];
    for (const id of services.slice(0, 3)) {
      const instanceId = await seedInstance({ status: "healthy", serviceId: id });
      // Created long ago, observed seconds ago — a normal long-running healthy service.
      await backdate(instanceId, { observedSecondsAgo: 5, createdSecondsAgo: 7_200 });
      fresh.push(instanceId);
    }
    // The silent one: created most recently of all, and heard from longest ago.
    const silent = await seedInstance({ status: "healthy", serviceId: services[3]! });
    await backdate(silent, { observedSecondsAgo: 600, createdSecondsAgo: 60 });

    const result = await sweepOrganizationServiceLiveness(f().app.db, {
      organizationId: ORG,
      limit: 3,
      policy: POLICY,
    });

    expect(result.scanned).toBe(3);
    expect(result.terminalized.map((t) => t.serviceInstanceId)).toEqual([silent]);
    expect((await rowOf(silent)).status).toBe("lost");
    for (const id of fresh) expect((await rowOf(id)).status).toBe("healthy");
  }, 120_000);

  // ── L-T11 — THE DEADLINE WRITES EXACTLY ONE TABLE ────────────────────────────────────
  //
  // ★★★ E9's acceptance for SVC-003 opens "health events do not extend ownership without a
  // successful lease renewal". SVC-003a pinned that for the PROJECTION (its T6). The deadline
  // is a SECOND writer with the same obligation pointed the other way: a sweeper that
  // terminalizes an instance must not also revoke, expire or extend the worker's lease. It is
  // an obvious thing to have reached for — "the worker is gone, kill its lease" — and it is
  // not this function's authority. Ownership is `renewLease`'s and the reaper's, and nothing
  // else's.
  //
  // ★ AND THE RESIDUAL THIS LEAVES IS FILED, NOT HIDDEN (E9-F007). Because the lease survives,
  // a worker that is silent-but-still-renewing keeps its fence while its replacement starts,
  // so two workers can briefly execute one service. What protects the REPLACEMENT is
  // SVC-003a's split-brain refusal: the old worker's late events land on a terminal row and
  // are refused as `illegal_transition`. What is NOT protected is the old worker's external
  // effects, which is SVC-005's "no two generations may perform external effects
  // simultaneously" clause and is out of scope here.
  //
  // MUTANT L17: have the sweep expire the instance's lease alongside the status write.
  it("★★★ L-T11 — terminalizing an instance does NOT touch its lease", async () => {
    await seedService();
    const { seeded } = await f().activateLease(911);
    const stale = await seedInstance({ status: "healthy", seeded });
    await backdate(stale, { observedSecondsAgo: 120, createdSecondsAgo: 3_600 });
    const [before] = await f().admin<{ status: string; expires_at: Date; fence: string }[]>`
      SELECT status, expires_at, fence FROM leases WHERE attempt_id = ${seeded.attemptId}`;
    expect(before!.status).toBe("active");

    const result = await sweep();
    expect(result.terminalized).toHaveLength(1);
    expect((await rowOf(stale)).status).toBe("lost");

    const [after] = await f().admin<{ status: string; expires_at: Date; fence: string }[]>`
      SELECT status, expires_at, fence FROM leases WHERE attempt_id = ${seeded.attemptId}`;
    expect(after!.status).toBe("active");
    expect(after!.expires_at.getTime()).toBe(before!.expires_at.getTime());
    expect(after!.fence).toBe(before!.fence);
  }, 120_000);

  // ── L-T10 — the INDEPENDENT LEGALITY GATE, driven by the test because nothing else can ─
  //
  // ★★★ REACHABILITY, STATED HONESTLY, AND IT IS WHY THIS CASE EXISTS AT ALL. The shipped
  // caller computes `allowedFromStatuses` from the frozen table via
  // `livenessDeadlineAllowedFromStatuses`, and `lost` is reachable from every one of the six
  // non-terminal statuses the sweep reads — so through the server path the gate NEVER fires,
  // and mutant L14 (delete it) killed NOTHING on the first campaign. A gate no test can reach
  // is a vacuously-true clause, which is this programme's recurring defect.
  //
  // The gate is kept rather than deleted for the reason `applyServiceProjectionForFence` keeps
  // its twin: `sweepServiceInstanceLiveness` is a repository method, a decider is not more
  // trusted than a worker's payload, and SVC-004's restart path and SVC-005's stop path will
  // call this surface with sets this file does not control. So the CASE performs the narrow
  // call itself — the same shape SVC-002's T1c uses for its composite idempotency key, which
  // the reconciler likewise cannot reach.
  //
  // MUTANT L14: `if (false as boolean)` in place of the gate. This case reds; nothing else does.
  it("★ L-T10 — a narrowed predecessor set REFUSES the write and reports it as a defect", async () => {
    await seedService();
    const instanceId = await seedInstance({ status: "healthy" });
    await backdate(instanceId, { observedSecondsAgo: 120, createdSecondsAgo: 3_600 });

    const result = await runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.sweepServiceInstanceLiveness({
        organizationId: ORG,
        limit: 16,
        toStatus: "lost",
        // A set that does NOT contain the observed status. `lost` IS legal from `healthy` in
        // the frozen table, so this is a caller bug rather than a lifecycle fact — and the
        // gate must refuse it rather than trust the decider.
        allowedFromStatuses: ["stopping"],
        decide: () => true,
      }));

    expect(result.scanned).toBe(1);
    expect(result.terminalized).toEqual([]);
    expect(result.refusedIllegal).toEqual([{ serviceInstanceId: instanceId, fromStatus: "healthy" }]);
    // And nothing was written: the row keeps the status it had.
    expect((await rowOf(instanceId)).status).toBe("healthy");
  }, 120_000);

  // ── L-T9 — POSITIVE CONTROL for every mutant above ───────────────────────────────────
  //
  // ★ NAMED POSITIVE CONTROL: `L-T9 POSITIVE CONTROL — SVC-002's convergence is untouched`.
  // A service with no instance at all still converges to exactly one, through the unchanged
  // reconciler, on a tick that also runs the sweep. It must stay GREEN under EVERY mutant
  // listed in this file. Without it, several cases above could pass because the tick had
  // stopped doing anything at all.
  //
  // ★ IT ASSERTS ONLY WHAT IT CONTROLS FOR, AND THE FIRST VERSION DID NOT. It also pinned
  // `livenessScanned === 0`, which is an ORDERING fact, not a convergence one — so mutant L10
  // (sweep moved after the convergence pages) reded the positive control itself. A control
  // that reds under a mutant it is supposed to survive is not a control; it is a second case
  // wearing the name. The liveness counters are asserted in L-T1, where they belong.
  it("L-T9 POSITIVE CONTROL — SVC-002's convergence is untouched by the deadline", async () => {
    await seedService();
    expect(await liveInstanceIds()).toEqual([]);

    const reconciler = createServiceReconciler({
      appDb: f().app.db,
      listAdmittedOrganizationIds: async () => [ORG],
      livenessPolicy: POLICY,
      tickBudgetMs: 5_000,
    });
    const result = await reconciler.tick();

    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.livenessFailed).toBe(0);
    expect(await liveInstanceIds()).toHaveLength(1);
  }, 120_000);
});
