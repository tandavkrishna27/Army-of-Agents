// -----------------------------------------------------------------------------
// SVC-005a — THE GENERATION ROLLOUT FENCE, over real embedded PostgreSQL.
//
// ★★★ WHAT WAS NOT TRUE BEFORE THIS SUITE, in the words of the records that said it:
//
//   SVC-002-design.md   "SVC-002 reads generation under a row lock and never bumps it;
//                        services.generation still has no writer after this ticket."
//   DE-12 register row  "services.generation HAS NO WRITER … so no generation rollover can be
//                        performed and the fence has nothing to refuse."
//   E0-F013 ruling      the DE-12 audit conjunct was dropped as VACUOUS partly because
//                        "no generation ever changes".
//
// R-T1 is the case that makes those sentences false.
//
// ── ★★★ AND THE HARDER HALF, WHICH IS WHY THIS SUITE EXISTS AT ALL ─────────────────────
//
// Writing the integer is easy. The acceptance clause is "no two generations may perform
// external effects simultaneously", and the dangerous moment is not the bump — it is a
// generation N+1 instance STARTING while a generation-N worker is still running. E9-F007 is
// exactly that hole: SVC-003b's deadline condemns a silent instance BY A CLOCK, the row leaves
// `service_instances_live_service_uq`, and "its supervised PROCESS may still be running and
// still performing external effects". R-T4 drives that condition through the REAL sweep and
// shows the reconciler REFUSING to place the new generation beside it; R-T5 shows the refusal
// CLEARING when the old worker's fence provably closes.
//
// ── WHAT IS REAL HERE, SAID BEFORE THE FIRST ASSERTION ──────────────────────────────────
//
// REAL: embedded PostgreSQL with every constraint and partial index, migration 0279's CHECK,
// the shipped `createService` create path, the shipped `rollServiceGeneration` entry point the
// route calls, SVC-002's own `reconcileService`, SVC-003b's own `sweepOrganizationServiceLiveness`
// (so `terminalized_by = 'liveness_deadline'` is written by the SHIPPED sweep, not by a
// hand-written UPDATE), the poll/ACK-minted ACTIVE lease fence, and `acceptEvent`'s durable
// append plus SVC-003a's projection (so `terminalized_by = 'worker_stopped'` is written by the
// SHIPPED ingest).
//
// NOT REAL, and stated rather than hidden: no worker ever leases a SERVICE job. E9-F002 keeps
// `workload.service` unofferable on a fleet like this fixture's, so the leased attempts here
// are placed BATCH jobs — which weakens nothing measured, for `SVC-003b`'s reason: the sweep
// and the fence key on `service_instances` columns and on (job, attempt) attribution, never on
// the job's workload type. The DAEMON half is not exercised and E9's exit gate is NOT claimed.
//
// AGES ARE BACK-DATED IN SQL, never simulated by sleeping.
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
import { reconcileService, sweepOrganizationServiceLiveness } from "../services/service-reconciler.js";
import { createService } from "../services/service-management.js";
import {
  rollServiceGeneration,
  rollServiceGenerationWithinTenant,
} from "../services/service-generation-rollout.js";

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

const DEFINITION = { command: "node", args: ["queue-worker.js"], gracefulStopSeconds: 30 };
const NEXT_DEFINITION = { command: "node", args: ["queue-worker.js", "--v2"], gracefulStopSeconds: 45 };

/** SVC-007b (#414) made `createService` audit its own mutation, so the operator identity is now
 *  a REQUIRED input rather than an optional one. This suite only needs a service to exist; the
 *  audit row it now also writes is SVC-007b's assertion, not this suite's. */
const OPERATOR = { actorType: "user" as const, actorId: "a6900000-0000-4000-8000-0000000000aa" };

/** Both windows short and far apart, so a back-dated age sits unambiguously between them.
 *  Never the shipped defaults: a suite using those could not tell a policy that is READ from
 *  one that is hardcoded. Copied from SVC-003b's suite for exactly that reason. */
const POLICY = { livenessDeadlineMs: 60_000, admissionDeadlineMs: 300_000 };

function f(): JobControlFixture {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
  if (!fixture) throw new Error("fixture was not initialized");
  return fixture;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** One wire event, digest-computed exactly as the ingest recomputes it, then handed to the REAL
 *  decider — so a witnessed terminal is written by the shipped mapping, not a hand-built input. */
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

async function createRunningService(): Promise<string> {
  const created = await createService(f().app.db, {
    organizationId: ORG,
    companyId: COMPANY,
    definition: DEFINITION,
    desiredState: "running",
    createdBy: "svc-005a-operator",
    actor: OPERATOR,
  });
  if (!created) throw new Error("create returned null");
  return created.serviceId;
}

function roll(serviceId: string, definition = NEXT_DEFINITION) {
  return rollServiceGeneration(
    { appDb: f().app.db },
    {
      organizationId: ORG,
      companyId: COMPANY,
      serviceId,
      definition,
      reason: "rolling to v2",
      createdBy: "svc-005a-operator",
      // SVC-005a / DE-12 conjunct 3c made the roll audit its own mutation, so the operator
      // identity is now a REQUIRED input (the durable `activity_log` row's attribution).
      actor: OPERATOR,
    },
  );
}

async function serviceRow(serviceId: string) {
  const [row] = await f().admin<Array<{ desired_state: string; generation: number }>>`
    SELECT desired_state, generation FROM services WHERE id = ${serviceId}`;
  return row ?? null;
}

async function generationRows(serviceId: string) {
  return f().admin<Array<{ generation: number; definition: Record<string, unknown>; created_by: string | null }>>`
    SELECT generation, definition, created_by FROM service_generations
    WHERE service_id = ${serviceId} ORDER BY generation`;
}

async function instanceRows(serviceId: string) {
  return f().admin<Array<{
    id: string; status: string; generation: number; terminalized_by: string | null;
    job_id: string | null; attempt_id: string | null;
  }>>`
    SELECT id, status, generation, terminalized_by, job_id, attempt_id
    FROM service_instances WHERE service_id = ${serviceId} ORDER BY created_at`;
}

/** An instance created the way SVC-002's reconciler creates one, attributed to a real leased
 *  attempt when one is supplied. Copied from SVC-003b's suite so both measure one shape. */
async function seedInstance(input: {
  serviceId: string;
  status: string;
  generation: number;
  seeded?: { jobId: string; attemptId: string };
}): Promise<string> {
  const id = randomUUID();
  await runInTenant(f().app.db, ORG, async (repos) => {
    const inserted = await repos.jobControl.insertServiceInstance({
      id,
      organizationId: ORG,
      companyId: COMPANY,
      serviceId: input.serviceId,
      generation: input.generation,
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

async function backdate(instanceId: string, observedSecondsAgo: number): Promise<void> {
  await f().admin`UPDATE service_instances
    SET last_observed_at = clock_timestamp() - make_interval(secs => ${observedSecondsAgo}),
        created_at = clock_timestamp() - make_interval(secs => ${observedSecondsAgo})
    WHERE id = ${instanceId}`;
}

function reconcile(serviceId: string) {
  return reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId });
}

/**
 * SVC-005a / DE-12 conjunct 3c — the durable roll-audit rows, read with the ADMIN connection.
 *
 * ★ READ AS ADMIN, and FILTERED TO THE ROLL ACTION. `createService` writes a `service.create`
 * row of its own (SVC-007b), so the table is not empty after a service exists; filtering on
 * `service.generation_roll` isolates what THIS unit writes. The admin connection is a different
 * session, so a row it can see is a row that COMMITTED — mirroring SVC-007b's `auditRows`.
 */
async function rollAuditRows() {
  return f().admin<Array<{
    id: string; company_id: string | null; actor_type: string; actor_id: string;
    action: string; entity_type: string; entity_id: string;
    agent_id: string | null; run_id: string | null; details: Record<string, unknown> | null;
  }>>`
    SELECT id, company_id, actor_type, actor_id, action, entity_type, entity_id,
           agent_id, run_id, details
    FROM activity_log
    WHERE company_id = ${COMPANY} AND action = 'service.generation_roll'
    ORDER BY created_at, id`;
}

async function clearServiceState(): Promise<void> {
  await f().admin`DELETE FROM activity_log`;
  await f().admin`DELETE FROM job_outbox`;
  await f().admin`DELETE FROM job_control_commands`;
  await f().admin`DELETE FROM job_events`;
  await f().admin`DELETE FROM job_projection_receipts`;
  await f().admin`DELETE FROM leases`;
  await f().admin`DELETE FROM service_instances`;
  await f().admin`DELETE FROM service_generations`;
  await f().admin`DELETE FROM services`;
  await f().admin`DELETE FROM job_attempts`;
  await f().admin`DELETE FROM jobs`;
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("svc-005a-rollout");
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await fixture?.teardown(); } catch { /* ignore */ }
}, 60_000);

const suite = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

suite("SVC-005a — the generation rollout fence", () => {
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

  // ── R-T1 — ★★★ THE SENTENCE THIS UNIT MAKES FALSE ────────────────────────────────────
  //
  // `services.generation` MOVES, and the immutable definition for the new generation exists —
  // both, because either alone is a defect. A bump with no matching `service_generations` row
  // makes `findServiceGenerationDefinition` answer `null` at the new generation FOREVER, which
  // is the permanent silent wedge SVC-007a's create path exists to avoid, reached from the
  // other side; R-T1 asserts the pair, not the column.
  //
  // MUTANT R1: delete the `bumpServiceGeneration` call — the definition exists, the column
  // does not move, and this case reds on `generation`. MUTANT R2: delete the
  // `insertServiceGeneration` call — the column moves and this case reds on the definition
  // rows. Neither mutant is caught by the other's assertion, which is why both are here.
  it("★★★ R-T1 — a roll mints generation 2 AND moves `services.generation` to it", async () => {
    const serviceId = await createRunningService();
    expect((await serviceRow(serviceId))?.generation).toBe(1);

    const result = await roll(serviceId);
    expect(result.verdict.outcome).toBe("rolled");
    if (result.verdict.outcome !== "rolled") throw new Error("unreachable");
    expect(result.verdict.from).toBe(1);
    expect(result.verdict.to).toBe(2);
    // The desired state is REPORTED and NOT MOVED — a rolled `running` service must stay
    // `running` so the reconciler places the new generation once the old instance is gone.
    expect(result.verdict.desiredState).toBe("running");

    const row = await serviceRow(serviceId);
    expect(row?.generation, "the column the tree had no writer for").toBe(2);
    expect(row?.desired_state, "a roll must not move desired_state").toBe("running");

    const generations = await generationRows(serviceId);
    expect(generations.map((g) => g.generation)).toEqual([1, 2]);
    // The NEW definition is stored, and generation 1's is UNTOUCHED — immutability is the
    // whole contract of this table.
    expect(generations[1]!.definition).toMatchObject({ command: "node", gracefulStopSeconds: 45 });
    expect(generations[0]!.definition).toMatchObject({ gracefulStopSeconds: 30 });
    expect(generations[1]!.created_by).toBe("svc-005a-operator");
  }, 90_000);

  // ── R-T2 — the mint and the bump are ONE transaction ─────────────────────────────────
  //
  // The rollback probe is what distinguishes one transaction from two: a write on its own
  // connection would SURVIVE the outer rollback. Same shape as SVC-007a's T1, and needed for
  // the same reason — the half-states here are a wedge, not a partial success.
  it("★ R-T2 — the mint and the bump commit together, or neither does", async () => {
    const serviceId = await createRunningService();
    await expect(runInTenant(f().app.db, ORG, async (repos, tx) => {
      const inner = await rollServiceGenerationWithinTenant(repos, {
        organizationId: ORG, companyId: COMPANY, serviceId,
        definition: NEXT_DEFINITION, reason: "probe", createdBy: "rollback-probe", actor: OPERATOR,
      }, { tx, actor: OPERATOR, published: [] });
      expect(inner.verdict.outcome, "the probe must have rolled before rolling back").toBe("rolled");
      throw new Error("deliberate rollback");
    })).rejects.toThrow("deliberate rollback");
    expect((await serviceRow(serviceId))?.generation, "the bump must not survive").toBe(1);
    expect(await generationRows(serviceId), "the mint must not survive").toHaveLength(1);
  }, 90_000);

  // ── R-T3 — the roll DRAINS the old generation's live instance ────────────────────────
  //
  // Without this the rollout waits for the old instance to die of old age, which for a healthy
  // service is never. The drain is the SAME composition SVC-007a's operator stop uses, and
  // E9-F006 §4 warned SVC-005 BY NAME that a control-plane path which terminalizes a service
  // job without calling the backstop strands its instance forever.
  //
  // ★ AND IT PROVES THE AUTHOR IS RECORDED. `terminalized_by = 'control_plane_backstop'` is
  // written by the SHIPPED `writeServiceInstanceStatus` chokepoint, not by this test.
  //
  // MUTANT R3: drop the `terminalizeServiceInstanceForCancelledAttempt` call from the roll —
  // the instance stays non-terminal inside `service_instances_live_service_uq` and this case
  // reds on both the status and the author. MUTANT R4: make `writeServiceInstanceStatus` stamp
  // unconditionally rather than only on a terminal status — this case stays green and R-T7's
  // author assertion is unaffected, so R4 is killed by R-T3b instead.
  it("★★★ R-T3 — the roll drains the live instance and RECORDS who ended it", async () => {
    const serviceId = await createRunningService();
    const created = await reconcile(serviceId);
    expect(created.action).toBe("created");

    const result = await roll(serviceId);
    expect(result.verdict.outcome).toBe("rolled");
    expect(result.drain?.status).toBe("requested");

    const [instance] = await instanceRows(serviceId);
    expect(instance!.generation, "the drained instance is the OLD generation's").toBe(1);
    expect(["stopped", "failed", "lost"]).toContain(instance!.status);
    expect(instance!.terminalized_by).toBe("control_plane_backstop");

    // ★★★ MEASURED, NOT ASSUMED, AND THE MEASUREMENT IS E9-F006. The first revision of this
    // case asserted a `cancel` row in `job_control_commands`. There is none, and that is
    // CORRECT rather than a defect in the roll: this service job was never leased (E9-F002
    // keeps `workload.service` unofferable on a fleet like this fixture's), so
    // `requestCancellation` takes its `if (!lease || !attempt || …)` branch and FINALIZES the
    // attempt and job directly instead of queueing a command for a worker that does not exist.
    // No command, and no event either — which is exactly why the roll MUST call the
    // attempt-terminal backstop, and why E9-F006 §4 warned SVC-005 by name that a control-plane
    // path which skips it strands its instance in the live index forever.
    //
    // ★ SO THE DRAIN'S EVIDENCE IS THE FINALIZATION, and it is asserted here rather than
    // inferred: the attempt is terminal, and the instance left the live set with a recorded
    // author. A future fleet that CAN lease a service job takes the other branch and queues a
    // graceful `cancel` instead; that path is unexercised here and is not claimed.
    expect(result.drain).toMatchObject({ status: "requested", generation: 1 });
    const attempts = await f().admin<Array<{ status: string }>>`
      SELECT status FROM job_attempts WHERE id = ${instance!.attempt_id}`;
    expect(["succeeded", "failed", "cancelled", "expired", "dead_letter"])
      .toContain(attempts[0]!.status);
    expect(
      await f().admin`SELECT 1 FROM job_control_commands WHERE job_id = ${instance!.job_id}`,
      "an unleased service job has no worker to queue a command for (E9-F006)",
    ).toHaveLength(0);
  }, 90_000);

  // A NON-terminal status move must leave the author NULL. Without this, `terminalized_by`
  // becomes a "last writer" column and the fence would read `pending → leased` as an authored
  // ending. Driven through the real ingest, so it measures the shipped chokepoint.
  it("★ R-T3b — a NON-terminal status move records no author", async () => {
    const serviceId = await createRunningService();
    const { seeded, offer, identity } = await f().activateLease(701);
    // `leased`, not `pending`: the FROZEN `SERVICE_INSTANCE_TRANSITIONS` gives `pending` the
    // successors `leased`/`failed`/`lost` only, so `pending → starting` is an illegal move and
    // would measure the refusal rather than the stamp. `leased → starting` is the real edge a
    // `service_instance_started` drives.
    const instanceId = await seedInstance({ serviceId, status: "leased", generation: 1, seeded });
    const { projections } = await ingestDirect(identity, [
      event(offer, 1, "service_instance_started", {
        serviceId, serviceInstanceId: instanceId, generation: 1,
      }),
    ]);
    expect(projections[0]?.outcome, `projection said ${JSON.stringify(projections[0])}`).toBe("applied");
    const [row] = await instanceRows(serviceId);
    expect(row!.status, "a real, non-terminal move happened").toBe("starting");
    expect(row!.terminalized_by, "a live row has no ending to attribute").toBeNull();
  }, 90_000);

  // ── R-T4 — ★★★ THE FENCE. The case this whole ticket exists for ──────────────────────
  //
  // The E9-F007 condition, built out of SHIPPED parts end to end: a generation-1 instance whose
  // worker goes silent is condemned by SVC-003b's REAL sweep (`terminalized_by =
  // 'liveness_deadline'`), the operator rolls to generation 2, and the reconciler REFUSES to
  // place it — because the old worker's attempt is still running, so its fence is still open
  // and it may still be performing external effects.
  //
  // ★ THE `instance_present` ARM CANNOT PRODUCE THIS ANSWER. The condemned row has LEFT
  // `service_instances_live_service_uq`, so `countNonTerminalInstances` reads zero and step 4
  // passes. Without step 4b the reconciler would place generation 2 here — which is exactly the
  // overlap E9's acceptance forbids, reached by a rollout rather than by a replacement.
  //
  // MUTANT R5: delete step 4b from `reconcileServiceWithinTenant` — this case reds with
  // `action: "created"` and R-T6 (the positive control) stays green. MUTANT R6: drop condition
  // (1) from `listUnwitnessedGenerationPredecessors` so it matches the CURRENT generation too —
  // this case stays green and R-T6 reds instead, which is why R-T6 is not optional.
  it("★★★ R-T4 — a clock-condemned predecessor of an OLD generation refuses the new placement", async () => {
    const serviceId = await createRunningService();
    const { seeded } = await f().activateLease(702);
    const instanceId = await seedInstance({ serviceId, status: "healthy", generation: 1, seeded });
    // Silent for longer than the liveness window, so the SHIPPED sweep condemns it.
    await backdate(instanceId, 180);
    const swept = await sweepOrganizationServiceLiveness(f().app.db, {
      organizationId: ORG, limit: 64, policy: POLICY,
    });
    expect(swept.terminalized.map((t) => t.serviceInstanceId)).toEqual([instanceId]);

    const [condemned] = await instanceRows(serviceId);
    expect(condemned!.status).toBe("lost");
    expect(condemned!.terminalized_by, "written by the SHIPPED sweep").toBe("liveness_deadline");

    // The operator rolls. The bump itself is NOT fenced — it performs no external effect.
    const rolled = await roll(serviceId);
    expect(rolled.verdict.outcome).toBe("rolled");
    expect((await serviceRow(serviceId))?.generation).toBe(2);
    // There is no live instance, so the drain had nothing to ask.
    expect(rolled.drain?.status).toBe("no_instance");

    // ★ AND THE PLACEMENT IS REFUSED.
    const outcome = await reconcile(serviceId);
    expect(outcome).toEqual({ action: "none", reason: "predecessor_generation_unwitnessed" });
    expect(
      (await instanceRows(serviceId)).filter((r) => r.generation === 2),
      "no generation-2 instance may exist beside a worker that may still be running",
    ).toEqual([]);
  }, 90_000);

  // ── R-T5 — ★★★ THE STALL CLEARS. It is a stall, not a wedge ─────────────────────────
  //
  // The recovery condition is a real control-plane fact with a verifiable consequence: once the
  // old attempt is terminal, `classifyFence` returns `attempt_terminal` before any other test,
  // so the old worker cannot write ANYTHING through the fenced ingest. Lease expiry plus
  // `reapExpiredLeases` reaches that state without the worker's cooperation, so the stall is
  // bounded by the lease TTL rather than by the worker's goodwill.
  //
  // ★ WITHOUT THIS CASE THE FENCE WOULD BE A PERMANENT WEDGE, which is the failure class this
  // epic keeps meeting and is strictly worse than the overlap it prevents.
  //
  // MUTANT R7: drop condition (3) (the attempt-status predicate) from
  // `listUnwitnessedGenerationPredecessors` — R-T4 stays green (it is a real overlap either
  // way) and THIS case reds, because the stall would never clear.
  it("★★★ R-T5 — the stall clears when the old attempt goes terminal and its fence closes", async () => {
    const serviceId = await createRunningService();
    const { seeded } = await f().activateLease(703);
    const instanceId = await seedInstance({ serviceId, status: "healthy", generation: 1, seeded });
    await backdate(instanceId, 180);
    await sweepOrganizationServiceLiveness(f().app.db, { organizationId: ORG, limit: 64, policy: POLICY });
    await roll(serviceId);
    expect((await reconcile(serviceId)).action, "stalled while the fence is open").toBe("none");

    // The old worker's attempt reaches a terminal status. Written directly because the ROUTE to
    // it (lease expiry -> reapExpiredLeases) is JOB-007's and is not this fence's subject; what
    // this case measures is that the fence READS the attempt status, not how it got there.
    await f().admin`UPDATE job_attempts SET status = 'expired' WHERE id = ${seeded.attemptId}`;

    const outcome = await reconcile(serviceId);
    expect(outcome.action, `reconcile answered ${JSON.stringify(outcome)}`).toBe("created");
    const placed = (await instanceRows(serviceId)).filter((r) => r.generation === 2);
    expect(placed, "the new generation is placed once the old fence is closed").toHaveLength(1);
  }, 90_000);

  // ── R-T6 — ★ THE NAMED POSITIVE CONTROL: same-generation replacement is NOT fenced ───
  //
  // E9-F007 §3 ruled a SAME-generation overlap the smaller harm against the permanent wedge of
  // never terminalizing, and SVC-005a does not reopen that ruling. Identical setup to R-T4
  // minus the roll: the deadline condemns a generation-1 instance and the reconciler MUST still
  // replace it at generation 1, immediately.
  //
  // ★ THIS IS THE CASE THAT PROVES THE FENCE IS NARROW. A fence that also blocked
  // same-generation replacement would break SVC-003b's shipped behaviour — the exact "do not
  // weaken a neighbour to make your own thing easy" failure — and would show up here and
  // nowhere else in either suite.
  it("★★★ R-T6 — a SAME-generation replacement is unaffected by the fence", async () => {
    const serviceId = await createRunningService();
    const { seeded } = await f().activateLease(704);
    const instanceId = await seedInstance({ serviceId, status: "healthy", generation: 1, seeded });
    await backdate(instanceId, 180);
    await sweepOrganizationServiceLiveness(f().app.db, { organizationId: ORG, limit: 64, policy: POLICY });
    expect((await instanceRows(serviceId))[0]!.terminalized_by).toBe("liveness_deadline");

    // NO ROLL. The service is still at generation 1.
    expect((await serviceRow(serviceId))?.generation).toBe(1);
    const outcome = await reconcile(serviceId);
    expect(outcome.action, `reconcile answered ${JSON.stringify(outcome)}`).toBe("created");
    expect((await instanceRows(serviceId)).filter((r) => r.generation === 1)).toHaveLength(2);
  }, 90_000);

  // ── R-T7 — ★★★ A WITNESSED predecessor does NOT stall the rollout ───────────────────
  //
  // The other side of R-T4, and the case that keeps the fence from being a fence that always
  // refuses. The generation-1 worker's OWN event drives its instance terminal through the
  // SHIPPED ingest — `terminalized_by = 'worker_stopped'` — and generation 2 is then placed
  // immediately, with the old attempt still non-terminal. That last clause is the point: the
  // witness alone is sufficient, so condition (3) is a recovery route for the UNWITNESSED case
  // and not a second gate on every rollout.
  //
  // ★ MUTANT R8 WAS PREDICTED TO RED THIS CASE AND DOES NOT, and the correction is recorded
  // rather than the prediction quietly fixed. Making `isWitnessedTerminalAuthor` vacuous leaves
  // this case GREEN, because the witness test also lives in SQL (condition (2) of
  // `listUnwitnessedGenerationPredecessors`) and that half still excludes the witnessed row
  // before the pure classifier ever sees it. Neither half is individually visible from here.
  // R-T7b is the case that pins the SQL half on its own; T-P1/T-P3b/T-P3c/T-P4 pin the pure
  // half. What THIS case pins is the composed behaviour: a witnessed predecessor does not stall
  // a rollout even while the old attempt is still running — so condition (3) is a RECOVERY
  // route for the unwitnessed case and not a second gate on every roll. MUTANT R8'': mutate
  // BOTH sites at once and this case reds.
  it("★★★ R-T7 — a worker-witnessed predecessor lets the new generation be placed at once", async () => {
    const serviceId = await createRunningService();
    const { seeded, offer, identity } = await f().activateLease(705);
    const instanceId = await seedInstance({ serviceId, status: "healthy", generation: 1, seeded });
    // The worker's own stop, through the real fence, the real digest and the real decider.
    const { projections } = await ingestDirect(identity, [
      event(offer, 1, "service_instance_stopped", {
        serviceId, serviceInstanceId: instanceId, generation: 1,
      }),
    ]);
    expect(projections[0]?.outcome, `projection said ${JSON.stringify(projections[0])}`).toBe("applied");
    const [witnessed] = await instanceRows(serviceId);
    expect(witnessed!.status).toBe("stopped");
    expect(witnessed!.terminalized_by, "written by the SHIPPED ingest projection").toBe("worker_stopped");

    // The old attempt is deliberately STILL non-terminal, so only the witness can be doing the
    // work here.
    const [attempt] = await f().admin<Array<{ status: string }>>`
      SELECT status FROM job_attempts WHERE id = ${seeded.attemptId}`;
    expect(["succeeded", "failed", "cancelled", "expired", "dead_letter"])
      .not.toContain(attempt!.status);

    await roll(serviceId);
    const outcome = await reconcile(serviceId);
    expect(outcome.action, `reconcile answered ${JSON.stringify(outcome)}`).toBe("created");
    expect((await instanceRows(serviceId)).filter((r) => r.generation === 2)).toHaveLength(1);
  }, 90_000);

  // ── R-T7c — ★★★ THE P1 REGRESSION: A `lost` WORKER EVENT IS NOT A WITNESS ───────────
  //
  // ★★★ EXTERNAL REVIEW OF PR #415 FOUND THIS AND IT WAS A REAL FAIL-OPEN IN THE VERY CLAUSE
  // THIS TICKET IS ABOUT. The first revision stamped `worker_event` for EVERY terminal move the
  // ingest applied. But `service_instance_lost` is what the daemon emits when `inspect` could
  // not describe the sandbox OR when "a full stop ladder ended with the process still observed
  // `running`" (`packages/worker-daemon/src/supervisor/service-lifecycle.ts`, whose comment at
  // that site reads "what is not established is that the PROCESS stopped"). So the fence would
  // have read the worker's own report that THE PROCESS SURVIVED CANCEL AND KILL as proof that
  // it stopped, and placed generation N+1 beside it.
  //
  // This drives a REAL `service_instance_lost` through the REAL fenced ingest — same authority,
  // same digest, same decider as R-T7's `service_instance_stopped` — and the ONLY difference is
  // the event. The author must be `worker_unconfirmed` and the placement must STALL.
  //
  // MUTANT: collapse the two authors back to one (`author: "worker_event"` unconditionally, or
  // equivalently make the ternary in `applyServiceProjectionForFence` constant) — THIS case reds
  // and `R-T7` stays green, which is exactly the asymmetry that let the defect ship in the first
  // revision with a fully green suite.
  it("★★★ R-T7c — a worker's `lost` event is NOT a witness, and the rollout stalls on it", async () => {
    const serviceId = await createRunningService();
    const { seeded, offer, identity } = await f().activateLease(708);
    const instanceId = await seedInstance({ serviceId, status: "healthy", generation: 1, seeded });
    const { projections } = await ingestDirect(identity, [
      event(offer, 1, "service_instance_lost", {
        serviceId, serviceInstanceId: instanceId, generation: 1,
      }),
    ]);
    expect(projections[0]?.outcome, `projection said ${JSON.stringify(projections[0])}`).toBe("applied");

    const [row] = await instanceRows(serviceId);
    expect(row!.status).toBe("lost");
    expect(
      row!.terminalized_by,
      "a `lost` event says the stop could NOT be confirmed — it must not be recorded as a witness",
    ).toBe("worker_unconfirmed");

    // The attempt is still non-terminal, so the old worker's fence is still open.
    await roll(serviceId);
    const outcome = await reconcile(serviceId);
    expect(outcome).toEqual({ action: "none", reason: "predecessor_generation_unwitnessed" });
    expect(
      (await instanceRows(serviceId)).filter((r) => r.generation === 2),
      "generation 2 must not be placed beside a process the worker could not confirm stopped",
    ).toEqual([]);
  }, 90_000);

  // ── R-T7b — ★★★ THE SQL HALF OF THE WITNESS TEST, PINNED ON ITS OWN ─────────────────
  //
  // ★ THIS CASE EXISTS BECAUSE A MUTATION RUN PROVED IT WAS MISSING, and that is worth stating
  // rather than quietly adding. The witness classification lives in TWO places on purpose —
  // condition (2) of `listUnwitnessedGenerationPredecessors`'s WHERE clause, and
  // `findBlockingPredecessor`'s re-derivation, belt to braces. The consequence, MEASURED and
  // not predicted: mutating EITHER site alone is survived, because the other still catches the
  // witnessed row. R-T7 therefore stayed green under both single-site mutants, so the SQL half
  // was covered by NOTHING — a redundancy that reads as two checks and pins one.
  //
  // This drives the repository method DIRECTLY, which is the only way to see the SQL half by
  // itself: two terminal predecessors at an old generation, identical except for their author,
  // and only the unwitnessed one may come back.
  //
  // MUTANT R8': replace condition (2) with `true` — THIS case reds and nothing else in either
  // suite does. MUTANT R8: make `isWitnessedTerminalAuthor` vacuous — this case stays green and
  // T-P1/T-P3b/T-P3c/T-P4 red, so the two halves are now pinned independently.
  it("★★★ R-T7b — the repository read itself excludes a WITNESSED predecessor", async () => {
    const serviceId = await createRunningService();
    const { seeded } = await f().activateLease(707);
    const witnessed = await seedInstance({ serviceId, status: "leased", generation: 1, seeded });
    await f().admin`UPDATE service_instances
      SET status = 'stopped', terminalized_by = 'worker_stopped' WHERE id = ${witnessed}`;
    const assumed = await seedInstance({ serviceId, status: "leased", generation: 1, seeded });
    await f().admin`UPDATE service_instances
      SET status = 'lost', terminalized_by = 'liveness_deadline' WHERE id = ${assumed}`;

    const rows = await runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.listUnwitnessedGenerationPredecessors({
        organizationId: ORG, serviceId, currentGeneration: 2, limit: 8,
      }));
    expect(
      rows.map((r) => r.serviceInstanceId),
      "only the clock-condemned row is unwitnessed",
    ).toEqual([assumed]);
    expect(rows[0]!.terminalizedBy).toBe("liveness_deadline");
  }, 90_000);

  // ── R-T8 — ★★★ THE STALE-GENERATION REFUSAL STILL REFUSES ───────────────────────────
  //
  // SVC-003a's instance-level generation fence is the thing a bump could most plausibly have
  // broken, and its own docstring anticipated this ticket: it compares the worker's claim
  // against the INSTANCE's generation, "not `services.generation` … comparing against the
  // service would refuse every event the moment SVC-005 bumps, including events from the
  // instance that is legitimately being drained". This case measures BOTH halves of that
  // sentence after a real bump:
  //
  //   (a) the generation-1 worker can STILL project onto its generation-1 instance while the
  //       service sits at generation 2 — the drain must keep working; and
  //   (b) a claim naming the NEW generation on that OLD instance is still refused
  //       `stale_generation`.
  //
  // MUTANT R9: change step (3) to compare `claim.generation` against `services.generation` —
  // (a) reds. MUTANT R10: delete step (3) entirely — (b) reds. The two halves are asserted
  // separately because neither mutant kills the other's assertion.
  it("★★★ R-T8 — a bump does not weaken (or over-tighten) SVC-003a's stale-generation fence", async () => {
    const serviceId = await createRunningService();
    const { seeded, offer, identity } = await f().activateLease(706);
    const instanceId = await seedInstance({ serviceId, status: "healthy", generation: 1, seeded });

    const rolled = await roll(serviceId);
    expect(rolled.verdict.outcome).toBe("rolled");
    expect((await serviceRow(serviceId))?.generation).toBe(2);

    // (a) The generation-1 worker still projects onto its own generation-1 instance.
    const okay = await ingestDirect(identity, [
      event(offer, 1, "service_health", {
        serviceId, serviceInstanceId: instanceId, generation: 1, status: "unhealthy",
      }),
    ]);
    expect(
      okay.projections[0]?.outcome,
      "the instance being drained must keep being able to report; " +
        `projection said ${JSON.stringify(okay.projections[0])}`,
    ).toBe("applied");

    // (b) A claim naming the NEW generation on that OLD instance is refused.
    const stale = await ingestDirect(identity, [
      event(offer, 2, "service_health", {
        serviceId, serviceInstanceId: instanceId, generation: 2, status: "healthy",
      }),
    ]);
    expect(stale.projections[0]?.outcome).toBe("stale_generation");
  }, 90_000);

  // ── R-T9 — the refusals ─────────────────────────────────────────────────────────────
  it("★ R-T9 — a `deleted` service cannot be rolled, and an absent one is a definite absence", async () => {
    const serviceId = await createRunningService();
    await f().admin`UPDATE services SET desired_state = 'deleted' WHERE id = ${serviceId}`;
    const forbidden = await roll(serviceId);
    expect(forbidden.verdict).toEqual({ outcome: "desired_state_forbids", desiredState: "deleted" });
    expect((await serviceRow(serviceId))?.generation, "a refused roll writes nothing").toBe(1);
    expect(await generationRows(serviceId)).toHaveLength(1);

    const absent = await roll("a6900000-0000-4000-8000-0000000000ff");
    expect(absent.verdict).toEqual({ outcome: "absent" });
  }, 90_000);

  // A `stopped` service IS rollable — it is the safest time to roll, since there is nothing to
  // drain. A refusal here would push operators toward resume-then-roll, the one ordering the
  // fence has to work hardest on.
  it("★ R-T9b — a `stopped` service rolls, and its desired state does not move", async () => {
    const serviceId = await createRunningService();
    await f().admin`UPDATE services SET desired_state = 'stopped' WHERE id = ${serviceId}`;
    const result = await roll(serviceId);
    expect(result.verdict.outcome).toBe("rolled");
    expect(result.drain).toEqual({ status: "no_instance" });
    const row = await serviceRow(serviceId);
    expect(row?.generation).toBe(2);
    expect(row?.desired_state).toBe("stopped");
  }, 90_000);

  // ── R-T10 — the roll only ever goes FORWARD BY ONE, and a second roll is not idempotent ──
  //
  // Two rolls mean two definitions and generation 3 — a roll is a MINT, not a set-to-N. The
  // reverse property (nothing can ask for a skip or a rewind) is structural: `bumpServiceGeneration`
  // derives both the expected and the next value from ONE parameter, so no caller can express it.
  it("★ R-T10 — consecutive rolls advance by exactly one each", async () => {
    const serviceId = await createRunningService();
    expect((await roll(serviceId, NEXT_DEFINITION)).verdict).toMatchObject({ from: 1, to: 2 });
    expect((await roll(serviceId, DEFINITION)).verdict).toMatchObject({ from: 2, to: 3 });
    expect((await serviceRow(serviceId))?.generation).toBe(3);
    expect((await generationRows(serviceId)).map((g) => g.generation)).toEqual([1, 2, 3]);
  }, 90_000);

  // ── R-T11 — ★★★ THE DURABLE GENERATION-ROLL AUDIT — DE-12 conjunct 3c ─────────────────
  //
  // A roll writes ONE `service.generation_roll` `activity_log` row, inside the roll's own tenant
  // transaction (SVC-007b's SERVICE-layer audit path, used a third time). Before this unit the
  // roll emitted only a `logger.info` line, which is why the DE-12 register left conjunct 3c
  // ("generation changes are audited") NOT delivered — this case is the delivery.
  //
  // ★ AND A NO-OP ROLL WRITES NONE. A `generation_exists` verdict means a concurrent roll
  // already minted N+1 and the column did NOT move, so no generation-change record may be
  // written. It is driven by resetting `services.generation` back to N while
  // `service_generations` still holds N+1 — exactly the `(service_id, generation)` conflict
  // `generation_exists` reports, reached through the SHIPPED path rather than a hand-built one.
  //
  // MUTANT AUDIT-1: delete the `recordServiceGenerationRollActivity` call — the roll arm reds
  // (zero rows). MUTANT AUDIT-2: record on every verdict, not only `rolled` — the no-op arm reds
  // (a second row where there must be none). RED-FIRST: before the write existed, the roll arm
  // found zero rows.
  it("★★★ R-T11 — a roll writes exactly ONE durable audit row; a NO-OP roll writes NONE", async () => {
    const serviceId = await createRunningService();
    // The create's own `service.create` row is not a roll row; the filtered read excludes it.
    expect(await rollAuditRows(), "no roll has happened yet").toHaveLength(0);

    const rolled = await roll(serviceId);
    expect(rolled.verdict.outcome).toBe("rolled");

    const rows = await rollAuditRows();
    expect(rows, "one generation change is one durable row").toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("service.generation_roll");
    expect(row.entity_type).toBe("service");
    expect(row.entity_id, "the audited entity is the service").toBe(serviceId);
    expect(row.company_id, "a mutating control row carries its company").toBe(COMPANY);
    expect(row.actor_type).toBe("user");
    expect(row.actor_id).toBe(OPERATOR.actorId);
    expect(row.run_id, "run_id FKs heartbeat_runs and there is no heartbeat run here").toBeNull();
    expect(row.agent_id, "a roll is an operator act, not an agent one").toBeNull();
    expect(row.details).toMatchObject({
      organizationId: ORG, serviceId, fromGeneration: 1, toGeneration: 2,
    });

    // ★ THE NO-OP ARM. Reset the column to 1 while generation 2's immutable definition still
    // exists, so the next roll's mint conflicts and the verdict is `generation_exists`.
    await f().admin`UPDATE services SET generation = 1 WHERE id = ${serviceId}`;
    const noop = await roll(serviceId);
    expect(noop.verdict).toEqual({ outcome: "generation_exists", generation: 2 });

    expect(
      await rollAuditRows(),
      "a NO-OP roll changed no generation, so it writes no generation-change record",
    ).toHaveLength(1);
  }, 90_000);
});
