// -----------------------------------------------------------------------------
// SVC-002 — the service reconciler. Acceptance: repeated reconciliation is idempotent,
// tenant quota and worker drain are respected, and a stopped service creates no instance.
//
// EVERY CASE NAMES THE MUTANT THAT MUST RE-RED IT. This programme's recurring defect is a
// test that was green before the fix and nobody checked, so each `it` carries the mutation
// its assertion is supposed to survive, and SVC-002-result.md records which reded.
//
// ★ WHY T1 IS FOUR CASES AND MUST NOT BE MERGED BACK INTO ONE. A single-row version of T1
// declares a red state that CANNOT OCCUR: with the reconciler's advisory lock in place,
// dropping the partial unique index still yields one instance, because the second pass
// serializes and sees the instance at the observed-state check. Such a test names the index
// as "the authority" and then measures the lock. T1a is the INDEX, with the lock deliberately
// out of the picture (two lock-free inserters, which is exactly how SVC-004's restart path
// and SVC-007's "start now" control will look). T1b is the LOCK, whose expected result under
// a dropped index is GREEN. T1c is the composite idempotency key, driven by the TEST because
// the reconciler never submits twice for one instance. T1d is the narrow catch.
//
// Real embedded PostgreSQL throughout: the mechanism under test is a storage-engine
// guarantee, and a mocked repository cannot have one.
// -----------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  SERVICE_INSTANCE_STATUSES,
  canTransitionServiceInstanceStatus,
  canonicalProviderConstraintProfileDigestInputV1,
  canonicalizeJsonV1,
  type JobCapabilityRequirementsV1,
  type ProviderConstraintProfileV1,
  type RegisteredTargetProfileV1,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";

import { setupJobControlFixture, type JobControlFixture, ORG, COMPANY } from "./helpers/job-control-fixture.js";
import { runInTenant } from "../db/tenant-context.js";
import {
  createServiceReconciler,
  deriveReconciliationId,
  deriveServiceIdempotencyKey,
  reconcileService,
} from "../services/service-reconciler.js";
import { submitJobWithinTenant } from "../services/job-submission.js";
import { decideJobPlacement } from "../services/job-placement.js";

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

const SERVICE = "a6500000-0000-4000-8000-000000000001";
const OTHER_SERVICE = "a6500000-0000-4000-8000-000000000002";

/** The definition SVC-007 would write. `service_generations` has no writer, so the tests do. */
const DEFINITION = { command: "node", args: ["server.js"], gracefulStopSeconds: 30 };

function f(): JobControlFixture {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
  if (!fixture) throw new Error("fixture was not initialized");
  return fixture;
}

/** Postgres error codes arrive wrapped; unwrap the cause chain. */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function seedService(input: {
  serviceId: string;
  desiredState?: string;
  generation?: number;
  withDefinition?: boolean;
}): Promise<void> {
  const generation = input.generation ?? 1;
  await f().admin`INSERT INTO services (id, organization_id, company_id, desired_state, generation)
    VALUES (${input.serviceId}, ${ORG}, ${COMPANY}, ${input.desiredState ?? "running"}, ${generation})`;
  if (input.withDefinition ?? true) {
    await f().admin`INSERT INTO service_generations
      (id, organization_id, company_id, service_id, generation, definition)
      VALUES (${randomUUID()}, ${ORG}, ${COMPANY}, ${input.serviceId}, ${generation}, ${DEFINITION})`;
  }
}

async function clearServiceState(): Promise<void> {
  await f().admin`DELETE FROM job_outbox`;
  await f().admin`DELETE FROM job_attempts`;
  await f().admin`DELETE FROM jobs`;
  await f().admin`DELETE FROM service_instances`;
  await f().admin`DELETE FROM service_generations`;
  await f().admin`DELETE FROM services`;
  await f().admin`UPDATE organizations SET concurrency_cap = NULL WHERE id = ${ORG}`;
}

async function liveInstances(serviceId: string): Promise<Array<{ id: string; job_id: string | null; attempt_id: string | null; company_id: string; status: string }>> {
  return f().admin<Array<{ id: string; job_id: string | null; attempt_id: string | null; company_id: string; status: string }>>`
    SELECT id, job_id, attempt_id, company_id, status FROM service_instances
    WHERE service_id = ${serviceId} AND status NOT IN ('stopped', 'failed', 'lost')
  `;
}

async function serviceJobs(): Promise<Array<{ id: string; workload_type: string; input: Record<string, unknown> }>> {
  return f().admin<Array<{ id: string; workload_type: string; input: Record<string, unknown> }>>`
    SELECT id, workload_type, input FROM jobs WHERE workload_type = 'service'
  `;
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("svc-002-reconciler");
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await fixture?.teardown(); } catch { /* ignore */ }
}, 60_000);

const suite = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

suite("SVC-002 — the reconciler converges desired state into exactly one instance", () => {
  const previousFlag = process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;

  beforeEach(async () => {
    // The submit-time org-capacity admission is gated on this flag, and T2 is entirely
    // about it. Setting it for the whole suite keeps the composition under test identical
    // to the one the composition root builds (which only exists flag-on anyway).
    process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "true";
    await clearServiceState();
  });

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;
    else process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = previousFlag;
  });

  // ── The authority itself ────────────────────────────────────────────────────────────────

  it("SCHEMA — the partial unique index exists and its predicate IS the frozen terminal set", async () => {
    // This is the assertion that keeps the index's predicate reconciled with the FROZEN
    // authority rather than hand-picked. `packages/db` cannot import worker-protocol, so
    // the predicate is hand-written in migration 0275 and in
    // TERMINAL_SERVICE_INSTANCE_STATUSES — a third and fourth copy of a frozen list. This
    // test is what makes them move together.
    const [row] = await f().admin<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'service_instances' AND indexname = 'service_instances_live_service_uq'
    `;
    expect(row, "service_instances_live_service_uq is missing entirely").toBeTruthy();
    expect(row.indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(row.indexdef).toMatch(/\(organization_id, service_id\)/);

    const inPredicate = [...row.indexdef.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    const frozenTerminals = SERVICE_INSTANCE_STATUSES
      .filter((status) => SERVICE_INSTANCE_STATUSES.every(
        (target) => !canTransitionServiceInstanceStatus(status, target),
      ))
      .slice()
      .sort();
    // Derived from the frozen transition table, never hand-listed here: a state is terminal
    // exactly when it has no outgoing transition.
    expect(frozenTerminals).toEqual(["failed", "lost", "stopped"]);
    // MUTANT: change the predicate's terminal set in 0275 (e.g. add 'pending') -> red.
    expect(inPredicate).toEqual(frozenTerminals);
  });

  // ── T1a — THE INDEX IS THE THING UNDER TEST ─────────────────────────────────────────────

  it("T1a — two LOCK-FREE concurrent inserters: the second blocks, then loses to the index", async () => {
    // RED STATE, and it is reachable: with the index absent, both inserts commit and TWO
    // non-terminal instances exist for one service. Nothing serializes these two writers --
    // which is the point. They model the writers that will never take the reconciler's
    // advisory lock: SVC-004's restart path and SVC-007's manual "start now" control.
    //
    // MUTANT: drop the index -> two rows -> red. MUTANT: widen the loser's catch to a bare
    // `catch {}` -> this case still passes, which is why T1d exists.
    await seedService({ serviceId: SERVICE });
    const idA = randomUUID();
    const idB = randomUUID();
    const values = (id: string) => ({
      id,
      organizationId: ORG,
      companyId: COMPANY,
      serviceId: SERVICE,
      generation: 1,
      status: "pending",
    });

    const inserted = deferred();
    const release = deferred();

    const aPromise = runInTenant(f().app.db, ORG, async (repos) => {
      const result = await repos.jobControl.insertServiceInstance(values(idA));
      inserted.resolve();
      // Hold the transaction open so B's insert has to block on OUR uncommitted index entry.
      await release.promise;
      return result;
    });
    await inserted.promise;

    const bPromise = runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.insertServiceInstance(values(idB)));
    // Give B's insert time to actually reach the index and block. If it did not block, the
    // assertions below still hold it to the same outcome, so this sleep is a fidelity aid
    // rather than the mechanism.
    await new Promise((resolve) => setTimeout(resolve, 250));
    release.resolve();

    const [a, b] = await Promise.all([aPromise, bPromise]);
    expect(a.outcome).toBe("inserted");
    // The loser DOES NOT THROW, and it re-reads the winner rather than returning blind.
    expect(b.outcome).toBe("conflict");
    expect(b.instance?.id).toBe(idA);

    const live = await liveInstances(SERVICE);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(idA);
  }, 60_000);

  // ── T1b — the lock's job, which is NOT the authority ────────────────────────────────────

  it("T1b — two concurrent full passes yield ONE instance and ONE job; the loser says instance_present", async () => {
    // MUTANT: remove the advisory lock from `lockServiceForReconcile` -> this case must STAY
    // GREEN (the index catches it; only the loser's internal path changes from the
    // observed-state check to a 23505). That "stays green" is the assertion, and it is what
    // proves the lock is a wait-instead-of-race convenience and NOT the authority.
    //
    // ★ NOT ASSERTED HERE: which of the two paths the loser took. The two outcomes are
    // BYTE-IDENTICAL by design (that is what "idempotent" means), so no in-test assertion
    // can separate them. The lock's own behaviour is asserted separately, below.
    await seedService({ serviceId: SERVICE });
    const [first, second] = await Promise.all([
      reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId: SERVICE }),
      reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId: SERVICE }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.action === "created")).toHaveLength(1);
    const loser = outcomes.find((o) => o.action === "none");
    expect(loser).toEqual({ action: "none", reason: "instance_present" });

    expect(await liveInstances(SERVICE)).toHaveLength(1);
    expect(await serviceJobs()).toHaveLength(1);
  }, 60_000);

  it("T1b(ii) — a pass SERIALIZES per service: a second pass on the SAME service waits, a different service does not", async () => {
    // ★★★ WHAT THIS MEASURES, CORRECTED BY MEASUREMENT. An earlier version of this case was
    // titled "the advisory lock actually serializes" and that attribution is FALSE.
    // `lockServiceForReconcile` holds TWO serializing mechanisms at the same granularity --
    // `pg_advisory_xact_lock(hashtext('aoa:service-reconcile'), hashtext(serviceId))` and
    // `SELECT ... FROM services ... FOR UPDATE` -- and both key on the same service.
    //
    // MEASURED, one mutant at a time:
    //   * remove the advisory lock ONLY  -> 14/14 GREEN (the row lock still serializes)
    //   * remove the FOR UPDATE ONLY     -> 14/14 GREEN (the advisory lock still serializes)
    //   * remove BOTH                    -> THIS CASE REDS ("expected true to be false")
    //
    // So this case pins the PAIR, and neither member is individually necessary for the
    // property. That redundancy is recorded rather than sold as two mechanisms: the design
    // gives them different justifications (step 1 "serializes concurrent passes", step 2
    // "interlocks with SVC-005's generation bump"), and at SVC-002's granularity those
    // justifications collapse into one. The advisory lock's only remaining distinct value is
    // for a future writer that serializes without reading the `services` row at all -- which
    // is speculative, and is why the DUPLICATE-PLACEMENT authority is neither of them but
    // the partial unique index (T1a).
    await seedService({ serviceId: SERVICE });
    await seedService({ serviceId: OTHER_SERVICE });

    const held = deferred();
    const release = deferred();
    const holder = runInTenant(f().app.db, ORG, async (repos) => {
      await repos.jobControl.lockServiceForReconcile({
        organizationId: ORG, companyId: COMPANY, serviceId: SERVICE,
      });
      held.resolve();
      await release.promise;
    });
    await held.promise;

    let sameResolved = false;
    const same = runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.lockServiceForReconcile({
        organizationId: ORG, companyId: COMPANY, serviceId: SERVICE,
      })).then((value) => { sameResolved = true; return value; });

    let otherResolved = false;
    const other = runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.lockServiceForReconcile({
        organizationId: ORG, companyId: COMPANY, serviceId: OTHER_SERVICE,
      })).then((value) => { otherResolved = true; return value; });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sameResolved, "a second pass for the SAME service must wait for the holder").toBe(false);
    expect(otherResolved, "a pass for a DIFFERENT service must not be blocked").toBe(true);

    release.resolve();
    await holder;
    await Promise.all([same, other]);
    expect(sameResolved).toBe(true);
  }, 60_000);

  // ── T1c — the composite-key trap, pinned where it is REACHABLE ──────────────────────────

  it("T1c — two submissions for ONE serviceInstanceId collapse to ONE job (the derived reconciliationId)", async () => {
    // ★ STATED HONESTLY: no path in SVC-002 ever submits twice for one instance id -- the
    // loser returns before the submission and the observed-state check short-circuits before
    // a later tick can. So this property is UNREACHABLE from the reconciler, and a mutant
    // reverting `reconciliationId` to randomUUID() CANNOT be killed by T1b. The TEST is the
    // second submitter. SVC-004's replacement path is its first real consumer.
    //
    // MUTANT: revert `deriveReconciliationId` to `randomUUID()` -> `authenticated_source_identity`
    // differs -> the seven-column composite does not collide -> TWO jobs -> red. It kills
    // ONLY because the test performs the second submission; rewriting this to drive the
    // reconciler would silence it again.
    await seedService({ serviceId: SERVICE });
    const serviceInstanceId = randomUUID();
    await f().admin`INSERT INTO service_instances (id, organization_id, company_id, service_id, generation, status)
      VALUES (${serviceInstanceId}, ${ORG}, ${COMPANY}, ${SERVICE}, 1, 'pending')`;

    const command = {
      idempotencyKey: deriveServiceIdempotencyKey(serviceInstanceId),
      source: {
        kind: "service_reconcile" as const,
        serviceId: SERVICE,
        generation: 1,
        reconciliationId: deriveReconciliationId(serviceInstanceId),
      },
      input: {
        serviceId: SERVICE,
        serviceInstanceId,
        generation: 1,
        command: DEFINITION.command,
        args: DEFINITION.args,
        checkpointArtifactId: null,
        gracefulStopSeconds: DEFINITION.gracefulStopSeconds,
      },
    };
    const submit = () => runInTenant(f().app.db, ORG, (repos, tx) => submitJobWithinTenant(
      repos,
      { organizationId: ORG, companyId: COMPANY, principal: { kind: "system", id: COMPANY }, command },
      tx,
    ));

    const first = await submit();
    const second = await submit();
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    expect(await serviceJobs()).toHaveLength(1);

    // The derivation is a pure function of the instance id, in every process and replica.
    expect(deriveReconciliationId(serviceInstanceId)).toBe(deriveReconciliationId(serviceInstanceId));
    expect(deriveReconciliationId(serviceInstanceId)).not.toBe(deriveReconciliationId(randomUUID()));
    expect(deriveReconciliationId(serviceInstanceId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  }, 60_000);

  // ── T1d — the loser's catch is NARROW ───────────────────────────────────────────────────

  it("T1d — a DIFFERENT constraint violation on the same insert propagates, and is not reported as instance_present", async () => {
    // MUTANT: replace the constraint-name check in `isLiveServiceInstanceConflict` with a
    // bare `catch {}` -> the FK violation is swallowed and the pass reports
    // `{outcome:'conflict'}` for a service that has no instance at all -> red. That
    // fabricated definite answer is the exact fail-open shape this catch is narrow to avoid.
    await seedService({ serviceId: SERVICE });
    let raised: unknown = null;
    try {
      await runInTenant(f().app.db, ORG, (repos) => repos.jobControl.insertServiceInstance({
        id: randomUUID(),
        organizationId: ORG,
        companyId: COMPANY,
        // No such service -> violates service_instances_org_company_service_fk, NOT the
        // partial unique index.
        serviceId: randomUUID(),
        generation: 1,
        status: "pending",
      }));
    } catch (error) {
      raised = error;
    }
    expect(raised, "a foreign-key violation must PROPAGATE, never resolve to `conflict`").not.toBeNull();
    expect(errorCode(raised)).toBe("23503");
  }, 60_000);

  // ── T2 — quota exhaustion ───────────────────────────────────────────────────────────────

  it("T2 — quota exhaustion creates ZERO jobs AND ZERO instances", async () => {
    // THE LOAD-BEARING HALF IS THE ZERO-INSTANCES ASSERTION. A reasonable implementer writes
    // the instance insert in its own transaction first; then quota exhaustion leaves an
    // orphan `pending` instance, the observed-state check reads it as "instance present" on
    // every later tick, and the service NEVER STARTS -- a silent permanent wedge.
    //
    // MUTANT: move the instance insert out of the submission transaction -> the
    // zero-instances assertion goes red while the zero-jobs assertion stays green.
    // MUTANT: catch the 429 INSIDE the transaction instead of outside it -> the transaction
    // commits the orphan -> the same red.
    await seedService({ serviceId: SERVICE });
    // Cap is clamped to >= 1, so exhaustion is cap=1 with one slot already held.
    await f().admin`UPDATE organizations SET concurrency_cap = 1 WHERE id = ${ORG}`;
    const seeded = await f().seedPlacedJob(901);
    // `job_attempts_capacity_claim_check` requires the whole held triple, not just the state.
    await f().admin`UPDATE job_attempts
      SET capacity_claim_state = 'held', capacity_workload_type = 'batch',
          capacity_claimed_at = clock_timestamp(), capacity_released_at = NULL
      WHERE id = ${seeded.attemptId}`;

    const outcome = await reconcileService(f().app.db, {
      organizationId: ORG, companyId: COMPANY, serviceId: SERVICE,
    });
    expect(outcome).toEqual({ action: "none", reason: "quota_denied" });
    expect(await serviceJobs()).toHaveLength(0);
    const all = await f().admin<{ id: string }[]>`SELECT id FROM service_instances`;
    expect(all, "quota exhaustion must leave NO orphan instance").toHaveLength(0);
  }, 60_000);

  // ── T3 — stopped services create no new instance ────────────────────────────────────────

  it("T3(a) — a stopped service returns desired_state_not_running, raises NO error, and creates nothing", async () => {
    // ★ THE REASON AND THE NO-ERROR ASSERTION ARE THE POINT, and a "zero instances" assertion
    // alone would be VACUOUS. Delete the reconciler's sweep filter and the admission
    // predicate still denies, the transaction still rolls back, and a zero-instances test
    // stays GREEN under the mutant -- the two guards mask each other exactly as SVC-001's
    // three immutability tests masked ON DELETE CASCADE.
    //
    // MUTANT: delete the `service.desiredState !== "running"` check in
    // reconcileServiceWithinTenant -> the pass proceeds, the admission predicate denies, and
    // the outcome becomes a thrown denial rather than
    // `{action:'none', reason:'desired_state_not_running'}` -> red on BOTH the reason and
    // the no-error assertion.
    await seedService({ serviceId: SERVICE, desiredState: "stopped" });
    const outcome = await reconcileService(f().app.db, {
      organizationId: ORG, companyId: COMPANY, serviceId: SERVICE,
    });
    expect(outcome).toEqual({ action: "none", reason: "desired_state_not_running" });
    expect(await liveInstances(SERVICE)).toHaveLength(0);
    expect(await serviceJobs()).toHaveLength(0);
  }, 60_000);

  it.each(["stopped", "paused", "deleted"])(
    "T3(b) — a DIRECT submission naming a %s service is denied by the admission authority (allow-list, not deny-list)",
    async (desiredState) => {
      // ★ RED AT BASE, GENUINELY. Before SVC-002, `serviceSourceIsAdmitted` filtered on
      // id/org/company/generation and had NO desiredState predicate at all, so a
      // `service_reconcile` submission naming a stopped service was ADMITTED. SVC-001's
      // terrain handed this here by name.
      //
      // MUTANT: delete the `eq(services.desiredState, "running")` predicate -> all three
      // cases red. MUTANT: change it to `ne(services.desiredState, "stopped")` -> the
      // `paused` and `deleted` cases red while `stopped` stays green, which is exactly why
      // all three run.
      await seedService({ serviceId: SERVICE, desiredState });
      const serviceInstanceId = randomUUID();
      let raised: unknown = null;
      try {
        await runInTenant(f().app.db, ORG, (repos, tx) => submitJobWithinTenant(
          repos,
          {
            organizationId: ORG,
            companyId: COMPANY,
            principal: { kind: "system", id: COMPANY },
            command: {
              idempotencyKey: deriveServiceIdempotencyKey(serviceInstanceId),
              source: {
                kind: "service_reconcile",
                serviceId: SERVICE,
                generation: 1,
                reconciliationId: deriveReconciliationId(serviceInstanceId),
              },
              input: {
                serviceId: SERVICE,
                serviceInstanceId,
                generation: 1,
                command: DEFINITION.command,
                args: DEFINITION.args,
                checkpointArtifactId: null,
                gracefulStopSeconds: DEFINITION.gracefulStopSeconds,
              },
            },
          },
          tx,
        ));
      } catch (error) {
        raised = error;
      }
      expect(raised, `a ${desiredState} service must not be admitted`).not.toBeNull();
      expect(await serviceJobs()).toHaveLength(0);
    },
    60_000,
  );

  it("T3(c) — a running service whose intent is UNREADABLE stalls; it does not start with a default command", async () => {
    // The UNKNOWN case, which is different from the absent one. `desired_state='running'`
    // says the intent IS to run, but `service_generations` has no row for this generation,
    // so the definition needed to realize that intent cannot be read. The honest verdict is
    // a stall.
    //
    // MUTANT: make `findServiceGenerationDefinition`'s null branch fall through to a default
    // command -> a job appears for a service whose definition nobody wrote -> red.
    //
    // ★ THIS IS THE STATE OF EVERY SERVICE ON A REAL DEPLOYMENT TODAY: `service_generations`
    // has zero writers in the tree and SVC-002 adds none (SVC-007 owns the controls).
    await seedService({ serviceId: SERVICE, withDefinition: false });
    const outcome = await reconcileService(f().app.db, {
      organizationId: ORG, companyId: COMPANY, serviceId: SERVICE,
    });
    expect(outcome).toEqual({ action: "none", reason: "no_generation" });
    expect(await liveInstances(SERVICE)).toHaveLength(0);
    expect(await serviceJobs()).toHaveLength(0);
  }, 60_000);

  // ── T4 — drained worker ─────────────────────────────────────────────────────────────────

  it("T4 — three ticks under a drained fleet produce exactly ONE instance and ONE job", async () => {
    // ★ THE DUPLICATE RISK LIVES HERE, NOT IN THE HAPPY PATH. A reconciler that asked "is
    // there a HEALTHY instance?" answers no on every tick under a fleet that can never lease
    // the job, and submits forever. The observed-state check asks "is there a NON-TERMINAL
    // instance?", and `pending` is non-terminal.
    //
    // ★★★ THE MUTANT SVC-002-design.md NAMED FOR THIS ROW DOES NOT KILL, AND THAT IS
    // RECORDED RATHER THAN QUIETLY DROPPED. The design says: "Change step 4's predicate from
    // non-terminal to `status = 'healthy'` -> red on ticks 2 and 3." MEASURED: that mutant
    // alone leaves this case 14/14 GREEN. The reason is the same masking shape the design
    // warned about for T1: `countNonTerminalInstances` and
    // `service_instances_live_service_uq` carry THE SAME PREDICATE at two layers, so under
    // the healthy-mutant tick 2 proceeds past the observed-state check, hits the index,
    // resolves to `conflict`, and still returns `instance_present` with `created` unchanged.
    //
    // MEASURED, so the clause is not vacuous:
    //   * healthy predicate ONLY        -> GREEN (measured 14/14, pre-T5; the index masks it)
    //   * index dropped ONLY            -> this case GREEN (the count check masks it)
    //   * index dropped AND healthy     -> THIS CASE REDS: `created` is [1, 1, 1], three
    //                                      instances and three jobs across three ticks --
    //                                      the exact failure mode the row describes.
    //
    // The honest reading: the observed-state predicate is a fast path, the index is the
    // authority, and the property survives losing either one. What is NOT true is the
    // design's claim that this row pins the predicate on its own.
    //
    // This case's job is NOT to prove that placement declines -- nothing in SVC-002 causes
    // that. The positive control below is where drain is actually measured.
    await f().admin`UPDATE execution_targets SET status = 'draining' WHERE organization_id = ${ORG}`;
    await seedService({ serviceId: SERVICE });
    const reconciler = createServiceReconciler({
      appDb: f().app.db,
      listAdmittedOrganizationIds: async () => [ORG],
    });

    const results = [await reconciler.tick(), await reconciler.tick(), await reconciler.tick()];
    expect(results.map((r) => r.created)).toEqual([1, 0, 0]);
    expect(results.map((r) => r.failed)).toEqual([0, 0, 0]);
    // Ticks 2 and 3 do not even VISIT the service: `listReconcilableServices` excludes a
    // service that already has a non-terminal instance, so a converged service leaves the
    // window. That is the property T6 exists for, and it is why the sweep terminates.
    expect(results.map((r) => r.services)).toEqual([1, 0, 0]);

    // ★ The in-pass observed-state check, exercised directly rather than through the window.
    // With the window filter in place the sweeper stops visiting a converged service, so
    // three ticks no longer drive three passes -- and the check that a REPEATED PASS creates
    // nothing would go untested if this were left to the sweeper. Two more direct passes:
    const repeat = [
      await reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId: SERVICE }),
      await reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId: SERVICE }),
    ];
    expect(repeat).toEqual([
      { action: "none", reason: "instance_present" },
      { action: "none", reason: "instance_present" },
    ]);

    const live = await liveInstances(SERVICE);
    expect(live).toHaveLength(1);
    expect(live[0]!.status).toBe("pending");
    expect(live[0]!.company_id).toBe(COMPANY);
    // The instance is ATTRIBUTABLE: without job_id/attempt_id nothing correlates it with the
    // job serving it and SVC-003 has nothing to fence against.
    const jobs = await serviceJobs();
    expect(jobs).toHaveLength(1);
    expect(live[0]!.job_id).toBe(jobs[0]!.id);
    expect(live[0]!.attempt_id).not.toBeNull();
    // The workload carries the server-stamped identity and the stored definition, and the
    // instance id is the one actually inserted -- closed BY CONSTRUCTION for this caller,
    // which is NOT the same as "the service workload's identity is authorized".
    expect(jobs[0]!.input).toMatchObject({
      serviceId: SERVICE,
      serviceInstanceId: live[0]!.id,
      generation: 1,
      command: DEFINITION.command,
      args: DEFINITION.args,
      gracefulStopSeconds: DEFINITION.gracefulStopSeconds,
    });

    // The backoff is only real if the caller reads it, so assert the two arms differ.
    expect(reconciler.nextDelayMs(results[0]!)).toBeLessThan(reconciler.nextDelayMs(results[1]!));

    await f().admin`UPDATE execution_targets SET status = 'active' WHERE organization_id = ${ORG}`;
  }, 90_000);

  it("T5 — every service is reconciled even when the tenant has more of them than one page holds", async () => {
    // ★ REGRESSION for a STARVATION BUG THIS RECONCILER HAD, caught in review on PR #406.
    // The first version always asked for the FIRST page (`afterServiceId: null`). A converged
    // service stays `desired_state='running'` forever, so for a tenant with more services
    // than `serviceBatchLimit` the same lowest-id rows filled every page on every tick and
    // every later service was NEVER reconciled -- silently, with no error anywhere.
    //
    // MUTANT (and the exact shipped-before state): pass `afterServiceId: null` instead of the
    // per-organization cursor -> only the first `serviceBatchLimit` services ever converge
    // -> red. Five services with a page size of two makes it reachable in three ticks.
    const ids = [1, 2, 3, 4, 5].map((n) => `a6700000-0000-4000-8000-00000000000${n}`);
    for (const id of ids) await seedService({ serviceId: id });

    const reconciler = createServiceReconciler({
      appDb: f().app.db,
      listAdmittedOrganizationIds: async () => [ORG],
      serviceBatchLimit: 2,
    });
    // Three ticks is the number a correct cursor needs for 5 services at 2 per page; a
    // head-anchored sweep would still be on the first two after any number of ticks.
    await reconciler.tick();
    await reconciler.tick();
    await reconciler.tick();

    const converged = await f().admin<{ service_id: string }[]>`
      SELECT DISTINCT service_id FROM service_instances ORDER BY service_id
    `;
    expect(converged.map((row) => row.service_id).sort()).toEqual([...ids].sort());
  }, 90_000);

  it("T7 — a page cut off by the tick budget KEEPS its cursor, so a stalled tail is not starved", async () => {
    // ★ THE SCENARIO THAT MAKES THIS REACHABLE, and it is not the obvious one. Wrapping the
    // cursor on `window.length < serviceBatchLimit` alone is harmless for services that
    // CONVERGE -- they leave the window (T6), so restarting at the head lands on the
    // unprocessed tail anyway. It is NOT harmless for services that stay in the window
    // because a pass does not converge them, and TODAY THAT IS EVERY SERVICE ON A REAL
    // DEPLOYMENT: `service_generations` has no writer, so a pass stalls at `no_generation`
    // and the service is still there on the next tick. A short page cut off by the budget
    // then wraps to the head, and the tail behind those stalled rows never gets a turn.
    //
    // Three stalled services (no definition) sorted before one reconcilable service. The
    // clock is driven so exactly ONE row is admitted per tick, so the reconcilable service is
    // reachable only if each tick RESUMES where the last stopped.
    //
    // MUTANT: wrap on `window.length < serviceBatchLimit` without checking that the page was
    // fully processed -> every tick re-admits the first stalled service, the fourth is never
    // reached, and no instance is ever created -> red.
    const stalled = [1, 2, 3].map((n) => `a6900000-0000-4000-8000-00000000000${n}`);
    const reconcilable = "a6900000-0000-4000-8000-000000000009";
    for (const id of stalled) await seedService({ serviceId: id, withDefinition: false });
    await seedService({ serviceId: reconcilable });

    // A monotonic clock that advances a fixed step PER CALL. The sweeper calls it once for
    // the deadline, once per organization, once per page, and once per row, so a budget of 35
    // with a step of 10 admits exactly one row before `remaining()` goes under 1.
    let calls = 0;
    const reconciler = createServiceReconciler({
      appDb: f().app.db,
      listAdmittedOrganizationIds: async () => [ORG],
      serviceBatchLimit: 5, // one SHORT page of four -- the case the wrap bug mishandles
      tickBudgetMs: 35,
      monotonicNow: () => {
        calls += 1;
        return calls * 10;
      },
    });

    const perTick: number[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      perTick.push((await reconciler.tick()).services);
    }
    // One row per tick, four ticks, four services -- the fourth is the reconcilable one.
    expect(perTick).toEqual([1, 1, 1, 1]);

    const converged = await f().admin<{ service_id: string }[]>`
      SELECT service_id FROM service_instances
    `;
    expect(
      converged.map((row) => row.service_id),
      "the tail behind three stalled services must eventually get a turn",
    ).toEqual([reconcilable]);
  }, 90_000);

  it("T6 — a converged service LEAVES the sweep window, so progress does not depend on remembering a cursor", async () => {
    // ★ THE LOAD-BEARING HALF of the starvation fix, and the one T5 cannot see. T5 proves the
    // cursor advances WITHIN a live sweeper object; this proves the WINDOW ITSELF SHRINKS, so
    // progress does not depend on any process remembering anything.
    //
    // ★ WHICH ASSERTION ACTUALLY DISCRIMINATES, measured rather than assumed. The converged
    // list below does NOT: one tick pages through the whole tenant using the in-tick cursor,
    // so all three converge with or without the convergence predicate, and a fresh sweeper
    // per tick changes nothing at this size. **The EMPTY-WINDOW assertion is the one that
    // separates them** -- with the predicate dropped, `listReconcilableServices` still
    // returns all three converged services and would hand them to a restarted process
    // forever. Stated here because an earlier draft of this comment claimed the fresh-sweeper
    // setup was itself the discriminator, and mutant 13 showed it is not.
    //
    // MUTANT: drop the `notExists` from `listReconcilableServices` -> the window still
    // contains all three converged services (and T4's per-tick `services` count goes
    // [1,1,1]) -> 2 red.
    const ids = [1, 2, 3].map((n) => `a6800000-0000-4000-8000-00000000000${n}`);
    for (const id of ids) await seedService({ serviceId: id });

    for (let tick = 0; tick < 3; tick += 1) {
      const fresh = createServiceReconciler({
        appDb: f().app.db,
        listAdmittedOrganizationIds: async () => [ORG],
        serviceBatchLimit: 1,
      });
      await fresh.tick();
    }

    const converged = await f().admin<{ service_id: string }[]>`
      SELECT DISTINCT service_id FROM service_instances ORDER BY service_id
    `;
    expect(converged.map((row) => row.service_id).sort()).toEqual([...ids].sort());

    // And once every service has converged, the window is EMPTY — the sweep terminates
    // rather than re-walking work that is already done.
    const empty = await runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.listReconcilableServices({ afterServiceId: null, limit: 32 }));
    expect(empty).toEqual([]);
  }, 90_000);

  it("T4 POSITIVE CONTROL — the SAME placement input selects an ACTIVE service-capable target and refuses a DRAINING one", () => {
    // Without this the drained-worker case could pass because placement never selects
    // anything at all, which would prove nothing about drain. Pure `decideJobPlacement`, the
    // real JOB-009 authority -- the same function the placement transaction calls.
    const decideFor = (status: "active" | "draining") =>
      decideJobPlacement(placementInput(status) as never) as { disposition: string; reasonCode: string; targetId: string | null };

    const active = decideFor("active");
    expect(active.disposition, "the positive control must actually select").toBe("selected");
    expect(active.targetId).toBe(PLACEMENT_TARGET);

    const draining = decideFor("draining");
    expect(draining.disposition).toBe("queued");
    expect(draining.reasonCode).toBe("no_eligible_target");
    expect(draining.targetId).toBeNull();
  });
});

// ── The placement fixture for the T4 positive control ─────────────────────────────────────
//
// A service job requires `workload.service` (job-placement.ts builds
// `workload.${workloadType}` into the required set unconditionally) plus a free service
// slot. SVC-008b widened the daemon constant so a real fleet CAN advertise it; this fixture
// advertises it so the control is a real selection rather than a second refusal.

const PLACEMENT_ORG = "a6600000-0000-4000-8000-000000000001";
const PLACEMENT_TARGET = "a6600000-0000-4000-8000-000000000002";
const PLACEMENT_WORKER = "a6600000-0000-4000-8000-000000000003";
const PLACEMENT_POLICY_HASH = "a".repeat(64);
const PLACEMENT_NOW = new Date("2026-09-10T10:00:00.000Z");

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function placementProvider(): ProviderConstraintProfileV1 {
  const unsigned = {
    profileId: "svc-002-provider",
    version: 1,
    maxContinuousRuntimeSeconds: 3_600,
    maxIdleSeconds: 300,
    resourceCeiling: { cpuMillis: 4_000, memoryMiB: 8_192, pids: 1_024, diskMiB: 16_384 },
    maxConcurrentOperations: 8,
    supportedOperations: [
      "create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup",
    ],
    localityTags: ["organization_target_only"],
    checkpointMode: "none",
    healthMode: "none",
  } as Omit<ProviderConstraintProfileV1, "digest">;
  return { ...unsigned, digest: sha256(canonicalProviderConstraintProfileDigestInputV1(unsigned)) };
}

function placementProfile(provider: ProviderConstraintProfileV1): RegisteredTargetProfileV1 {
  return {
    protocolVersion: 1,
    targetId: PLACEMENT_TARGET,
    targetClass: "organization_dedicated",
    scope: "organization",
    organizationId: PLACEMENT_ORG,
    ownerPrincipalId: null,
    trustCeiling: "organization_isolated",
    credentialCeiling: "organization_brokered",
    dataLocalityCeiling: "organization_target_only",
    providerConstraints: {
      profileId: provider.profileId, version: provider.version, digest: provider.digest,
    },
    capabilityCeiling: ["workload.service", "sandbox.process_isolated"],
    deviceGeneration: 1,
    revokedAt: null,
    policyHash: PLACEMENT_POLICY_HASH,
  } as RegisteredTargetProfileV1;
}

function placementInput(status: "active" | "draining") {
  const provider = placementProvider();
  const profile = placementProfile(provider);
  const worker: WorkerHelloV1 = {
    protocolVersion: 1,
    workerId: PLACEMENT_WORKER,
    targetId: PLACEMENT_TARGET,
    deviceGeneration: 1,
    agentVersion: "svc-002-test",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "worker" },
    reportedCapabilities: ["workload.service", "sandbox.process_isolated"],
    capacity: {
      batchSlots: 0, browserSessionSlots: 0, serviceSlots: 1,
      freeCpuMillis: 2_000, freeMemoryMiB: 4_096, freeDiskMiB: 8_192,
    },
    policyHash: PLACEMENT_POLICY_HASH,
  } as WorkerHelloV1;
  const requirements = {
    protocol: { min: 1, max: 1 },
    capabilities: ["sandbox.process_isolated"],
    workloadType: "service",
    targetRequirements: {
      allowedTargetClasses: ["organization_dedicated"],
      allowedTrustClasses: ["organization_isolated"],
      requiredOwnerPrincipalId: null,
      credentialKind: "organization_brokered",
      dataLocality: "organization_target_only",
      fallback: { mode: "ordered_explicit", orderedTargetClasses: ["organization_dedicated"] },
      providerConstraints: {
        profileId: provider.profileId, version: provider.version, digest: provider.digest,
      },
    },
    policyHash: PLACEMENT_POLICY_HASH,
    mustUnderstand: [],
  } as JobCapabilityRequirementsV1;
  return {
    sourceKind: "service_reconcile",
    rollout: { enabled: true, mode: "active", reason: "enabled" },
    requirements,
    providerDemand: {
      maxRuntimeSeconds: 600,
      maxIdleSeconds: 60,
      resources: { cpuMillis: 1_000, memoryMiB: 1_024, pids: 128, diskMiB: 1_024 },
      concurrentOperations: 1,
      operations: ["create", "execute"],
      localityTags: ["organization_target_only"],
    },
    credentialOwnerPrincipalId: null,
    now: PLACEMENT_NOW,
    maxHeartbeatAgeMs: 30_000,
    inputDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    candidates: [{
      registry: {
        targetId: PLACEMENT_TARGET,
        targetSlug: "svc-002-target",
        targetClass: "organization_dedicated",
        targetScope: "organization",
        targetGeneration: 1,
        profileHash: sha256(canonicalizeJsonV1(profile)),
        providerConstraintHash: provider.digest,
        status,
        lastSeenAt: new Date(PLACEMENT_NOW.getTime() - 1_000),
        registeredProfile: profile,
        providerConstraintProfile: provider,
      },
      worker,
      workerProfileHash: sha256(JSON.stringify(worker)),
      workerStatus: "active",
      ownerMembershipActive: true,
      currentOperations: 0,
    }],
  };
}
