// -----------------------------------------------------------------------------
// SVC-003 — the service-health PROJECTION, over a real active fence and real Postgres.
//
// ★★★ WHAT WAS NOT TRUE BEFORE THIS SUITE. SVC-008b's supervisor emits
// `service_instance_started` / `service_health` / `service_instance_stopped` /
// `service_instance_lost`; JOB-005 ingests, digest-verifies and durably appends them; and
// they PROJECTED NO STATE CHANGE. `recordServiceHealth` was the only writer of
// `service_instances.status` and had no consumer, so SVC-002's reconciler converged zero
// instances to one and went quiescent forever — nothing could drive an instance terminal, so
// nothing could ever be replaced. Every case below is about that seam.
//
// EVERY CASE NAMES THE MUTANT THAT MUST RE-RED IT, and `SVC-003a-result.md` records which did.
//
// ── WHAT IS REAL HERE AND WHAT IS NOT, SAID BEFORE THE FIRST ASSERTION ──────────────────
//
// REAL: the embedded PostgreSQL, every constraint and partial index on `service_instances`,
// the poll/ACK-minted ACTIVE lease fence, `guardActiveFence`, `acceptEvent`'s durable append,
// the projection, SVC-002's own `insertServiceInstance`/`attributeServiceInstance` writers,
// and SVC-002's `reconcileService` for the replacement leg. T1 additionally drives the FULL
// `createJobEventIngestService` path, so the decider is proven to be reached from the wire.
//
// NOT REAL, and it is deliberate rather than hidden: the leased attempt is a placed BATCH
// job, not a service job. Leasing a real service job needs the fleet to advertise
// `workload.service` with a free service slot AND the reconciler's submission to be placed by
// the placement loop — machinery this unit does not build (see `SVC-003a-result.md` §7).
// It does not weaken any assertion below, because the projection keys on
// `service_instances.job_id`/`.attempt_id` attribution and never on the job's workload type;
// that independence is itself the point of the attribution SVC-002 wrote.
// -----------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { canonicalEventDigestInputV1, type LeaseOfferV1 } from "@armyofagents/worker-protocol";
import type { ActiveFenceRequest, AcceptEventInput } from "@armyofagents/db";

import {
  setupJobControlFixture,
  auth,
  ORG,
  COMPANY,
  WORKER,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";
import { runInTenant } from "../db/tenant-context.js";
import { createJobEventIngestService } from "../services/job-events.js";
import { decideServiceProjection } from "../services/service-health-projection.js";
import { reconcileService } from "../services/service-reconciler.js";

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

const SERVICE = "a6700000-0000-4000-8000-000000000001";
const OTHER_SERVICE = "a6700000-0000-4000-8000-000000000002";
const DEFINITION = { command: "node", args: ["queue-worker.js"], gracefulStopSeconds: 30 };

function f(): JobControlFixture {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
  if (!fixture) throw new Error("fixture was not initialized");
  return fixture;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The service-instance ref every frozen service payload carries. */
function ref(instanceId: string, generation = 1, serviceId = SERVICE) {
  return { serviceId, serviceInstanceId: instanceId, generation };
}

/**
 * One wire event, digest-computed exactly as the ingest service recomputes it, then handed
 * to the REAL decider. Building the projection any other way would test a hand-written
 * input instead of the shipped mapping.
 */
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

/** Append a batch through the real guarded mutator and return the per-event outcomes. */
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

async function seedService(serviceId: string, generation = 1): Promise<void> {
  await f().admin`INSERT INTO services (id, organization_id, company_id, desired_state, generation)
    VALUES (${serviceId}, ${ORG}, ${COMPANY}, 'running', ${generation})`;
  await f().admin`INSERT INTO service_generations
    (id, organization_id, company_id, service_id, generation, definition)
    VALUES (${randomUUID()}, ${ORG}, ${COMPANY}, ${serviceId}, ${generation}, ${DEFINITION})`;
}

/**
 * Create the instance exactly the way SVC-002's reconciler does — its own two writers, in one
 * transaction — and attribute it to the leased attempt. This is the step that makes the
 * projection's AUTHORITY (`job_id`/`attempt_id`) real rather than assumed.
 */
async function attributedInstance(input: {
  seeded: { jobId: string; attemptId: string };
  serviceId?: string;
  generation?: number;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await runInTenant(f().app.db, ORG, async (repos) => {
    const inserted = await repos.jobControl.insertServiceInstance({
      id,
      organizationId: ORG,
      companyId: COMPANY,
      serviceId: input.serviceId ?? SERVICE,
      generation: input.generation ?? 1,
      status: input.status ?? "pending",
    });
    if (inserted.outcome !== "inserted") throw new Error(`instance insert conflicted: ${inserted.outcome}`);
    await repos.jobControl.attributeServiceInstance({
      organizationId: ORG,
      serviceInstanceId: id,
      jobId: input.seeded.jobId,
      attemptId: input.seeded.attemptId,
    });
  });
  return id;
}

async function statusOf(instanceId: string): Promise<string> {
  const [row] = await f().admin<{ status: string }[]>`
    SELECT status FROM service_instances WHERE id = ${instanceId}`;
  return row?.status ?? "<absent>";
}

async function liveInstanceIds(serviceId: string): Promise<string[]> {
  const rows = await f().admin<{ id: string }[]>`
    SELECT id FROM service_instances
    WHERE service_id = ${serviceId} AND status NOT IN ('stopped', 'failed', 'lost')
    ORDER BY created_at`;
  return rows.map((row) => row.id);
}

async function serviceReceipts(attemptId: string) {
  return f().admin<{ projection_kind: string; aggregate_kind: string | null; target_aggregate_id: string }[]>`
    SELECT projection_kind, aggregate_kind, target_aggregate_id FROM job_projection_receipts
    WHERE attempt_id = ${attemptId} AND projection_kind = 'service_instance_status'`;
}

async function clearServiceState(): Promise<void> {
  await f().admin`DELETE FROM service_instances`;
  await f().admin`DELETE FROM service_generations`;
  await f().admin`DELETE FROM services`;
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("svc-003-projection");
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await fixture?.teardown(); } catch { /* ignore */ }
}, 60_000);

const suite = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

suite("SVC-003 — service events project onto the instance row, under the fence", () => {
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

  // ── T1 — the projection is ARMED, from the wire ───────────────────────────────────────
  //
  // Deliberately through `createJobEventIngestService.ingest`, not through `acceptEvent`:
  // the arming question is whether `toAcceptInputs` actually calls the decider, and a test
  // that hands `acceptEvent` a hand-built projection cannot answer it. Everything downstream
  // of this case uses the faster direct path.
  //
  // MUTANT: `serviceProjection: null` in `toAcceptInputs` (m13) — the whole feature wired to
  // nothing while every pure case stays green. Also: delete the `if (event.serviceProjection)`
  // call site in `acceptEvent` (m12).
  it("★ T1 — a real worker batch walks the instance pending -> leased -> starting -> healthy", async () => {
    await seedService(SERVICE);
    // No `identity` here on purpose: T1 goes through the FULL ingest service, which resolves
    // the fence itself from the lease row. That is the arming question — mutant 13.
    const { seeded, offer } = await f().activateLease(701);
    const instanceId = await attributedInstance({ seeded });
    expect(await statusOf(instanceId)).toBe("pending");

    const ingest = createJobEventIngestService({ appDb: f().app.db });
    const wires = [
      event(offer, 1, "attempt_started", { sandboxId: `sbx-${randomUUID()}` }),
      event(offer, 2, "service_instance_started", { ...ref(instanceId), providerResourceId: "sbx-abc" }),
      event(offer, 3, "service_health", { ...ref(instanceId), status: "healthy", detail: null }),
    ];
    const response = await ingest.ingest({
      auth: auth(`svc003-t1-${randomUUID()}`),
      request: {
        protocolVersion: 1,
        correlationId: randomUUID(),
        issuedAt: new Date().toISOString(),
        nonce: `svc003-t1-${randomUUID()}`,
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
          events: wires,
        },
      } as never,
    });

    expect(response.ack.status).toBe("accepted");
    expect(await statusOf(instanceId)).toBe("healthy");
    // The receipt makes the projection auditable and is what makes a replay a no-op.
    const receipts = await serviceReceipts(seeded.attemptId);
    expect(receipts).toHaveLength(3);
    for (const receipt of receipts) {
      expect(receipt.aggregate_kind).toBe("service_instance");
      expect(receipt.target_aggregate_id).toBe(instanceId);
    }
  }, 120_000);

  // ── T2 — replay is a no-op, not a second write ───────────────────────────────────────
  //
  // MUTANT: drop the `instance.status === projection.toStatus` short-circuit — a repeated
  // health tick then reports `illegal_transition` (no self-edge exists in the frozen table),
  // which is false and would drown the real refusals in the operator log.
  it("T2 — a repeated health verdict is noop_same_status and writes no second receipt", async () => {
    await seedService(SERVICE);
    const { seeded, offer, identity } = await f().activateLease(702);
    const instanceId = await attributedInstance({ seeded });

    await ingestDirect(identity, [
      event(offer, 1, "attempt_started", { sandboxId: "sbx-1" }),
      event(offer, 2, "service_instance_started", { ...ref(instanceId), providerResourceId: "sbx-1" }),
      event(offer, 3, "service_health", { ...ref(instanceId), status: "healthy", detail: null }),
    ]);
    expect(await statusOf(instanceId)).toBe("healthy");
    const before = (await serviceReceipts(seeded.attemptId)).length;

    const second = await ingestDirect(identity, [
      event(offer, 4, "service_health", { ...ref(instanceId), status: "healthy", detail: "still up" }),
    ]);
    expect(second.projections).toEqual([{ outcome: "noop_same_status", fromStatus: "healthy" }]);
    expect(await statusOf(instanceId)).toBe("healthy");
    expect((await serviceReceipts(seeded.attemptId)).length).toBe(before);
  }, 120_000);

  // ── T3 — ★ THE GENERATION FENCE, which is the thing SVC-002 handed over ──────────────
  //
  // SVC-002-design.md scopes it out in its own words: "SVC-002 reads generation under a row
  // lock and never bumps it; services.generation still has no writer after this ticket", and
  // it hands the fence here. A worker still running generation 1 whose instance is recorded
  // at generation 2 may not write status onto it.
  //
  // MUTANT: m9 — delete the generation comparison.
  it("★ T3 — an event naming a STALE generation is refused and writes nothing", async () => {
    await seedService(SERVICE, 2);
    const { seeded, offer, identity } = await f().activateLease(703);
    const instanceId = await attributedInstance({ seeded, generation: 2, status: "healthy" });

    const result = await ingestDirect(identity, [
      event(offer, 1, "service_instance_lost", { ...ref(instanceId, 1), reason: "old generation says lost" }),
    ]);
    expect(result.ack?.status).toBe("accepted"); // the EVENT is still durably stored
    expect(result.projections).toEqual([{ outcome: "stale_generation", instanceGeneration: 2 }]);
    expect(await statusOf(instanceId)).toBe("healthy");
    expect(await serviceReceipts(seeded.attemptId)).toHaveLength(0);
  }, 120_000);

  // ── T4 — the payload is a CLAIM, and a mismatched claim is refused ───────────────────
  //
  // E9-F003 made load-bearing: the lease envelope's `executionPrincipal` for a
  // `service_reconcile` job names the SERVICE under the kind `service_instance` while the
  // workload carries a different `serviceInstanceId`, so `payload.serviceInstanceId` is an
  // UNAUTHORIZED value. A projection that trusted it could write status onto any instance in
  // the tenant. The authority is the (job, attempt) attribution instead.
  //
  // MUTANT: m8 — drop the identity comparison. The assertion that separates the arms is the
  // one on the OTHER service's instance: without it, a mutant that projects onto the
  // ATTRIBUTED row (rather than the named one) would still leave this row untouched and the
  // case would pass while proving nothing.
  it("★ T4 — an event naming ANOTHER instance is refused, and neither row moves", async () => {
    await seedService(SERVICE);
    await seedService(OTHER_SERVICE);
    const { seeded, offer, identity } = await f().activateLease(704);
    const mine = await attributedInstance({ seeded, status: "healthy" });
    // A second instance, on a different service, NOT attributed to this attempt.
    const theirs = randomUUID();
    await f().admin`INSERT INTO service_instances (id, organization_id, company_id, service_id, generation, status)
      VALUES (${theirs}, ${ORG}, ${COMPANY}, ${OTHER_SERVICE}, 1, 'healthy')`;

    const result = await ingestDirect(identity, [
      event(offer, 1, "service_instance_lost", { ...ref(theirs, 1, OTHER_SERVICE), reason: "not mine to say" }),
    ]);
    expect(result.projections).toEqual([{ outcome: "identity_mismatch", attributedInstanceId: mine }]);
    expect(await statusOf(theirs)).toBe("healthy");
    expect(await statusOf(mine)).toBe("healthy");
  }, 120_000);

  // ── T5 — ★★★ THE SPLIT BRAIN, AND THE LOOP CLOSING ───────────────────────────────────
  //
  // This is the case that would red if ANY of the three legs stopped: the projection
  // terminalizing the instance, SVC-002's reconciler replacing it, or the legality gate
  // refusing the late event. `service_instances_live_service_uq` is unique on
  // (organization_id, service_id) WHERE status NOT IN the three frozen terminals — so a late
  // event resurrecting the corpse to `healthy` after the replacement exists is a UNIQUE
  // violation that fails the whole ingest transaction, and the worker replays that batch
  // forever. With the gate, the corpse stays dead and exactly one instance is live.
  //
  // MUTANT: m7 — delete the legality check. Also m10 (`unattributed` returning a definite
  // `applied`), which reaches this case through the replacement's own attribution.
  it("★★★ T5 — a terminal instance is replaced, and a late event cannot resurrect it", async () => {
    await seedService(SERVICE);
    const { seeded, offer, identity } = await f().activateLease(705);
    const first = await attributedInstance({ seeded });

    // Leg 1 — the PROJECTION drives the instance terminal. Before SVC-003, nothing could.
    await ingestDirect(identity, [
      event(offer, 1, "attempt_started", { sandboxId: "sbx-1" }),
      event(offer, 2, "service_instance_started", { ...ref(first), providerResourceId: "sbx-1" }),
      event(offer, 3, "service_instance_lost", { ...ref(first), reason: "sandbox vanished" }),
    ]);
    expect(await statusOf(first)).toBe("lost");
    expect(await liveInstanceIds(SERVICE)).toEqual([]);

    // Leg 2 — SVC-002's REAL reconciler now has work to do, which is the whole point of
    // leg 1. Before SVC-003 this pass returned `instance_present` forever.
    const outcome = await reconcileService(f().app.db, {
      organizationId: ORG, companyId: COMPANY, serviceId: SERVICE,
    });
    expect(outcome.action).toBe("created");
    const replacement = outcome.action === "created" ? outcome.serviceInstanceId : "";
    expect(await liveInstanceIds(SERVICE)).toEqual([replacement]);

    // Leg 3 — the LATE event from the dead worker's still-active fence.
    const late = await ingestDirect(identity, [
      event(offer, 4, "service_health", { ...ref(first), status: "healthy", detail: "I am fine actually" }),
    ]);
    expect(late.ack?.status).toBe("accepted");
    expect(late.projections).toEqual([
      { outcome: "illegal_transition", fromStatus: "lost", toStatus: "healthy" },
    ]);
    expect(await statusOf(first)).toBe("lost");
    // ★ The invariant DE-12 names: one service, one live instance.
    expect(await liveInstanceIds(SERVICE)).toEqual([replacement]);
  }, 180_000);

  // ── T5b — ★★★ E9-F004: THE NORMAL STOP, which my first version refused ───────────────
  //
  // T5 drives `service_instance_lost`, and the frozen table makes `lost` reachable from
  // everything — so T5 passed over a `predecessorsOf` that made `stopped` reachable ONLY from
  // `stopping`, a status no event can assert. Every NORMAL service exit
  // (`runServiceLifecycle`'s `case "process_exited"` arm, `service-lifecycle.ts` ~:293, from
  // `healthy`) was refused as `illegal_transition`, the
  // instance stayed live, and the reconciler could never replace it. Caught by review; this is
  // the case that would have caught it.
  //
  // MUTANT: revert `predecessorsOf` to the direct-edge filter.
  it("★★★ T5b — a service that EXITS from healthy goes `stopped`, and is replaced", async () => {
    await seedService(SERVICE);
    const { seeded, offer, identity } = await f().activateLease(709);
    const first = await attributedInstance({ seeded });

    await ingestDirect(identity, [
      event(offer, 1, "attempt_started", { sandboxId: "sbx-1" }),
      event(offer, 2, "service_instance_started", { ...ref(first), providerResourceId: "sbx-1" }),
      event(offer, 3, "service_health", { ...ref(first), status: "healthy", detail: null }),
    ]);
    expect(await statusOf(first)).toBe("healthy");

    // The observed exit — emitted directly from `healthy`, with no `stopping` in between.
    const stop = await ingestDirect(identity, [
      event(offer, 4, "service_instance_stopped", { ...ref(first), exitCode: 0 }),
    ]);
    expect(stop.projections).toEqual([
      { outcome: "applied", fromStatus: "healthy", toStatus: "stopped" },
    ]);
    expect(await statusOf(first)).toBe("stopped");
    expect(await liveInstanceIds(SERVICE)).toEqual([]);

    const outcome = await reconcileService(f().app.db, {
      organizationId: ORG, companyId: COMPANY, serviceId: SERVICE,
    });
    expect(outcome.action).toBe("created");
  }, 180_000);

  // ── T5c — ★★★ E9-F005: the attempt-terminal backstop ─────────────────────────────────
  //
  // `runServiceLifecycle`'s §4.2a launch comment (`service-lifecycle.ts`, ~:166): a launch that
  // resolves no handle emits NO
  // `service_instance_started`, so "the instance never leaves `leased` and the attempt fails".
  // Without the backstop the attempt is terminal while the instance sits `leased` inside the
  // live unique index forever.
  //
  // MUTANT: delete the `terminal` arm from the decider.
  it("★★★ T5c — a FAILED attempt with no service event still terminalizes the instance", async () => {
    await seedService(SERVICE);
    const { seeded, offer, identity } = await f().activateLease(710);
    const stranded = await attributedInstance({ seeded });

    await ingestDirect(identity, [event(offer, 1, "attempt_started", { sandboxId: "sbx-1" })]);
    expect(await statusOf(stranded)).toBe("leased"); // exactly the stranded state

    // The launch threw: no `service_instance_started`, straight to a failed terminal.
    const result = await runInTenant(f().app.db, ORG, async (repos) => {
      const wire = event(offer, 2, "terminal", {
        status: "failed", exitCode: 1, errorCode: "start_failed", errorMessage: "no handle",
      });
      const accepted = await repos.jobControl.acceptEvent({
        ...identity,
        batch: { events: [{ ...acceptInput(wire), terminalStatus: "failed" as const }] },
      });
      return (accepted.serviceProjections ?? []).map((entry) => entry.result);
    });
    expect(result).toEqual([{ outcome: "applied", fromStatus: "leased", toStatus: "failed" }]);
    expect(await statusOf(stranded)).toBe("failed");
    expect(await liveInstanceIds(SERVICE)).toEqual([]);

    const outcome = await reconcileService(f().app.db, {
      organizationId: ORG, companyId: COMPANY, serviceId: SERVICE,
    });
    expect(outcome.action).toBe("created");
  }, 180_000);

  // ── T5d — the backstop is a BACKSTOP, and it does not shout on the happy path ─────────
  //
  // On the normal path `service_instance_stopped` has already landed when the attempt terminal
  // arrives. Reporting `illegal_transition` there would put a refusal on the happy path of
  // every service run and drown the real ones. ★ The assertion that separates the arms is the
  // SECOND one: `whenAlreadyTerminal:"noop"` must not leak onto service events, or T5's
  // split-brain refusal silently becomes a benign no-op.
  //
  // MUTANT: default `whenAlreadyTerminal` to `"noop"` in the decider's `project`.
  it("★ T5d — an attempt terminal after an observed stop is a NO-OP, but a late health event is not", async () => {
    await seedService(SERVICE);
    const { seeded, offer, identity } = await f().activateLease(711);
    const instanceId = await attributedInstance({ seeded });

    await ingestDirect(identity, [
      event(offer, 1, "attempt_started", { sandboxId: "sbx-1" }),
      event(offer, 2, "service_instance_started", { ...ref(instanceId), providerResourceId: "sbx-1" }),
      event(offer, 3, "service_instance_stopped", { ...ref(instanceId), exitCode: 3 }),
    ]);
    expect(await statusOf(instanceId)).toBe("stopped");

    const terminal = await runInTenant(f().app.db, ORG, async (repos) => {
      const wire = event(offer, 4, "terminal", {
        status: "failed", exitCode: 3, errorCode: "service_exited", errorMessage: null,
      });
      const accepted = await repos.jobControl.acceptEvent({
        ...identity,
        batch: { events: [{ ...acceptInput(wire), terminalStatus: "failed" as const }] },
      });
      return (accepted.serviceProjections ?? []).map((entry) => entry.result);
    });
    expect(terminal).toEqual([{ outcome: "noop_already_terminal", fromStatus: "stopped" }]);
    expect(await statusOf(instanceId)).toBe("stopped");
  }, 180_000);

  // ── T6 — health does not extend ownership ────────────────────────────────────────────
  //
  // E9's acceptance for SVC-003 opens with exactly this clause. The mechanism is that the
  // projection writes ONE table; ownership is extended by `renewLease` and nothing else.
  //
  // MUTANT: m11 — have the projection bump `leases.expires_at`.
  it("★ T6 — a health projection does not extend the lease", async () => {
    await seedService(SERVICE);
    const { seeded, offer, identity } = await f().activateLease(706);
    const instanceId = await attributedInstance({ seeded });
    const [before] = await f().admin<{ expires_at: Date }[]>`
      SELECT expires_at FROM leases WHERE id = ${offer.leaseId}`;

    await ingestDirect(identity, [
      event(offer, 1, "attempt_started", { sandboxId: "sbx-1" }),
      event(offer, 2, "service_instance_started", { ...ref(instanceId), providerResourceId: "sbx-1" }),
      event(offer, 3, "service_health", { ...ref(instanceId), status: "healthy", detail: null }),
    ]);
    expect(await statusOf(instanceId)).toBe("healthy");

    const [after] = await f().admin<{ expires_at: Date }[]>`
      SELECT expires_at FROM leases WHERE id = ${offer.leaseId}`;
    expect(after!.expires_at.toISOString()).toBe(before!.expires_at.toISOString());
  }, 120_000);

  // ── T7 — ★ UNKNOWN IS NOT A DEFAULT ──────────────────────────────────────────────────
  //
  // A plain batch attempt has no service instance at all. `attempt_started` still carries a
  // decided projection (the decider cannot know a job is a service job), so it reaches the
  // repository — and the answer must be "there is nothing here to say anything about", never
  // a definite status. SVC-008b's lesson, in this seam.
  //
  // MUTANT: m10 — return a definite `applied` when no row is attributed.
  it("★ T7 — an attempt with NO service instance projects nothing and invents no row", async () => {
    const { seeded, offer, identity } = await f().activateLease(707);
    const result = await ingestDirect(identity, [
      event(offer, 1, "attempt_started", { sandboxId: "sbx-1" }),
    ]);
    expect(result.projections).toEqual([{ outcome: "unattributed" }]);
    const [{ count }] = await f().admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM service_instances`;
    expect(count).toBe(0);
    expect(await serviceReceipts(seeded.attemptId)).toHaveLength(0);
    // The ATTEMPT projection still ran — the service arm must not swallow the batch one.
    const [attempt] = await f().admin<{ status: string }[]>`
      SELECT status FROM job_attempts WHERE id = ${seeded.attemptId}`;
    expect(attempt!.status).toBe("running");
  }, 120_000);

  // ── T8 — NAMED POSITIVE CONTROL ──────────────────────────────────────────────────────
  //
  // ★ GREEN BEFORE, GREEN AFTER, AND GREEN UNDER EVERY MUTANT ABOVE. The JOB-005 batch
  // projection is untouched by SVC-003: `attempt_started` still drives attempt leased->running
  // and job queued->running, and `terminal` still completes the attempt. If this reds
  // alongside the service cases, the HARNESS broke rather than the feature — and without it,
  // several cases above could pass because ingest stopped projecting anything at all.
  it("T8 POSITIVE CONTROL — the batch attempt/job projection is byte-identical", async () => {
    const { seeded, offer, identity } = await f().activateLease(708);
    await ingestDirect(identity, [
      event(offer, 1, "attempt_started", { sandboxId: "sbx-1" }),
    ]);
    const [running] = await f().admin<{ attempt: string; job: string }[]>`
      SELECT (SELECT status FROM job_attempts WHERE id = ${seeded.attemptId}) AS attempt,
             (SELECT status FROM jobs WHERE id = ${seeded.jobId}) AS job`;
    expect(running).toEqual({ attempt: "running", job: "running" });

    await runInTenant(f().app.db, ORG, async (repos) => {
      await repos.jobControl.acceptEvent({
        ...identity,
        batch: {
          events: [{
            ...acceptInput(event(offer, 2, "terminal", {
              status: "succeeded", exitCode: 0, errorCode: null, errorMessage: null,
            })),
            terminalStatus: "succeeded" as const,
          }],
        },
      });
    });
    const [done] = await f().admin<{ status: string }[]>`
      SELECT status FROM job_attempts WHERE id = ${seeded.attemptId}`;
    expect(done!.status).toBe("succeeded");
    const [{ receipts }] = await f().admin<{ receipts: number }[]>`
      SELECT count(*)::int AS receipts FROM job_projection_receipts
      WHERE attempt_id = ${seeded.attemptId}
        AND projection_kind IN ('attempt_started', 'attempt_terminal')`;
    expect(receipts).toBe(2);
  }, 120_000);
});
