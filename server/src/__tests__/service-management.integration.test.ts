// -----------------------------------------------------------------------------
// SVC-007 (Unit A) — a service is CREATED, and the loop that was wired to nothing runs.
//
// ★★★ WHAT WAS NOT TRUE BEFORE THIS SUITE, in the words of the documents that said it. Three
// shipped records agreed, and all three were right:
//
//   SVC-002-result.md §7   "Nothing creates a service. `repos.services.insert` keeps its zero
//                           production callers … Nothing writes a generation."
//   SVC-003a-result.md §2  "NOTHING CREATES A SERVICE … so on a real deployment there is no
//                           `services` row, so no instance, so nothing for this projection to
//                           move."
//   E9 README              "every pass stalls at `no_generation` on a real deployment".
//
// So the reconciler and the projection were both SHIPPED AND UNREACHABLE. T2 is the case
// that makes those sentences false: a definition written by the create path, read back by
// SVC-002's own `findServiceGenerationDefinition`, turned into one instance and one `service`
// job by SVC-002's own `reconcileService`.
//
// EVERY CASE NAMES THE MUTANT THAT MUST RE-RED IT, and `SVC-007a-result.md` records which did.
//
// ── WHAT IS REAL HERE, SAID BEFORE THE FIRST ASSERTION ──────────────────────────────────
//
// REAL: embedded PostgreSQL with every constraint, the `services_org_company_fk` composite
// tenant FK, `service_generations_service_generation_uq`, the partial unique index
// `service_instances_live_service_uq`, the shipped `createService` / `setServiceDesiredState`
// / `readService` entry points the route calls, SVC-002's `reconcileService`, and JOB-006's
// JOB-006's own `repos.jobControl.requestCancellation` (graceful), reached exactly as the route
// reaches it — not a stub.
//
// NOT REAL, and it is stated rather than hidden: no worker ever leases the service job this
// creates. `E9-F002` keeps `workload.service` unofferable on a fleet like this fixture's, and
// building a service-capable fleet is not this unit's work. So the instance never leaves
// `pending` by a worker's hand, and the DAEMON half of "created, supervised, projected" is
// NOT exercised here. E9's exit gate is not claimed — see `SVC-007a-result.md` §7.
// -----------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { setupJobControlFixture, type JobControlFixture, ORG, COMPANY } from "./helpers/job-control-fixture.js";
import { runInTenant } from "../db/tenant-context.js";
import { reconcileService } from "../services/service-reconciler.js";
import {
  createService,
  createServiceWithinTenant,
  listServices,
  readService,
  setServiceDesiredState,
  setServiceDesiredStateWithinTenant,
} from "../services/service-management.js";

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

/** A SECOND tenant, seeded here rather than in the shared fixture, for the cross-tenant cases. */
const OTHER_ORG = "a6900000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "a6900000-0000-4000-8000-000000000002";

const DEFINITION = { command: "node", args: ["queue-worker.js", "--concurrency", "4"], gracefulStopSeconds: 25 };

function f(): JobControlFixture {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
  if (!fixture) throw new Error("fixture was not initialized");
  return fixture;
}

/**
 * The control's dependencies EXACTLY as `jobControlRoutes` passes them.
 *
 * ★ IT IS JUST THE POOL NOW. The first revision injected a `requestGracefulStop` callback
 * bound to `jobOperations.drainJob`, which opens its OWN transaction — and external review of
 * PR #412 (P1) showed that releasing the service lock before that call lets a concurrent
 * resume be overtaken by an in-flight stop. The control now reaches
 * `repos.jobControl.requestCancellation` inside the SAME transaction, under the same lock, so
 * there is nothing left to inject.
 */
function controlDeps() {
  return { appDb: f().app.db };
}

/**
 * SVC-007 Unit B — the operator identity every mutating control now attributes its
 * `activity_log` row to. A real user id, because `assertOrgAdmin` has already refused any
 * caller without one before a control action can exist.
 */
const OPERATOR = { actorType: "user" as const, actorId: "a6900000-0000-4000-8000-0000000000aa" };

/**
 * The audit context for a DIRECT `...WithinTenant` call — the shape the two rollback probes
 * need, since they open the transaction themselves. `published` is drained by the caller after
 * commit; a probe that rolls back never drains it, which is the point.
 */
function auditCtx(tx: Parameters<typeof createServiceWithinTenant>[2]["tx"]) {
  return { tx, actor: OPERATOR, published: [] };
}

async function create(overrides?: {
  organizationId?: string;
  companyId?: string;
  desiredState?: "running" | "paused";
  definition?: typeof DEFINITION;
}) {
  return createService(f().app.db, {
    organizationId: overrides?.organizationId ?? ORG,
    companyId: overrides?.companyId ?? COMPANY,
    definition: overrides?.definition ?? DEFINITION,
    actor: OPERATOR,
    desiredState: overrides?.desiredState ?? "running",
    createdBy: "svc-007-operator",
  });
}

async function serviceRows(organizationId = ORG) {
  return f().admin<Array<{ id: string; company_id: string; desired_state: string; generation: number }>>`
    SELECT id, company_id, desired_state, generation FROM services WHERE organization_id = ${organizationId}
    ORDER BY id`;
}

async function generationRows(organizationId = ORG) {
  return f().admin<Array<{
    id: string; service_id: string; company_id: string; generation: number;
    definition: Record<string, unknown>; ttl_seconds: number | null;
    checkpoint_artifact_id: string | null; created_by: string | null;
  }>>`
    SELECT id, service_id, company_id, generation, definition, ttl_seconds, checkpoint_artifact_id, created_by
    FROM service_generations WHERE organization_id = ${organizationId} ORDER BY service_id, generation`;
}

async function instanceRows(serviceId: string) {
  return f().admin<Array<{ id: string; status: string; generation: number; job_id: string | null; attempt_id: string | null }>>`
    SELECT id, status, generation, job_id, attempt_id FROM service_instances
    WHERE service_id = ${serviceId} ORDER BY created_at`;
}

async function serviceJobs() {
  return f().admin<Array<{ id: string; status: string; workload_type: string; input: Record<string, unknown>; source_kind: string }>>`
    SELECT id, status, workload_type, input, source_kind FROM jobs WHERE workload_type = 'service' ORDER BY created_at`;
}

/**
 * SVC-007 Unit B — the durable audit rows, read with the ADMIN connection.
 *
 * ★ READ AS ADMIN DELIBERATELY. `aoa_app` holds `SELECT, INSERT ON activity_log` and the table
 * carries no RLS, so the app role could read these back — but a suite that verified the write
 * through the same role and session that made it could not tell "committed" from "visible
 * inside my own open transaction". The admin connection is a different session, so a row it
 * can see is a row that COMMITTED.
 */
async function auditRows(companyId = COMPANY) {
  return f().admin<Array<{
    id: string; company_id: string | null; actor_type: string; actor_id: string;
    action: string; entity_type: string; entity_id: string;
    agent_id: string | null; run_id: string | null; details: Record<string, unknown> | null;
  }>>`
    SELECT id, company_id, actor_type, actor_id, action, entity_type, entity_id,
           agent_id, run_id, details
    FROM activity_log WHERE company_id = ${companyId} ORDER BY created_at, id`;
}

async function attemptStatuses(jobId: string) {
  const rows = await f().admin<Array<{ status: string }>>`
    SELECT status FROM job_attempts WHERE job_id = ${jobId}`;
  return rows.map((row) => row.status);
}

async function clearServiceState(): Promise<void> {
  await f().admin`DELETE FROM activity_log`;
  await f().admin`DELETE FROM job_outbox`;
  await f().admin`DELETE FROM job_control_commands`;
  await f().admin`DELETE FROM job_events`;
  await f().admin`DELETE FROM job_projection_receipts`;
  await f().admin`DELETE FROM leases`;
  await f().admin`DELETE FROM job_attempts`;
  await f().admin`DELETE FROM jobs`;
  await f().admin`DELETE FROM service_instances`;
  await f().admin`DELETE FROM service_generations`;
  await f().admin`DELETE FROM services`;
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("svc-007-management");
    await fixture.admin`INSERT INTO organizations (id, name, slug) VALUES (${OTHER_ORG}, 'SVC-007 other org', 'svc-007-other')`;
    await fixture.admin`INSERT INTO companies (id, organization_id, name, issue_prefix)
      VALUES (${OTHER_COMPANY}, ${OTHER_ORG}, 'SVC-007 other company', 'S7O')`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  try { await fixture?.teardown(); } catch { /* ignore */ }
}, 60_000);

const suite = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

suite("SVC-007 — creating a service, and the loop it unblocks", () => {
  const previousFlag = process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;

  beforeEach(async () => {
    // The submit-time org-capacity admission the reconciler's submission passes through is
    // gated on this flag, exactly as SVC-002's own suite sets it.
    process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "true";
    await clearServiceState();
  });

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;
    else process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = previousFlag;
  });

  // ── T1 — the two writes are ONE transaction ─────────────────────────────────────────────
  //
  // MUTANT: give the generation insert its own `runInTenant`. A `services` row without its
  // generation is not a partial success — it is a service that stalls at `no_generation` for
  // the rest of its life, with NO route able to repair it (this unit mints generation 1 only,
  // and 1 is taken). The rollback probe is what distinguishes one transaction from two: a
  // write on its own connection would SURVIVE the outer rollback.
  it("★ T1 — the service and its generation commit together, or neither does", async () => {
    const created = await create();
    expect(created).not.toBeNull();
    expect(await serviceRows()).toHaveLength(1);
    expect(await generationRows()).toHaveLength(1);

    await clearServiceState();
    await expect(runInTenant(f().app.db, ORG, async (repos, tx) => {
      const inner = await createServiceWithinTenant(repos, {
        organizationId: ORG, companyId: COMPANY, definition: DEFINITION,
        desiredState: "running", createdBy: "rollback-probe",
      }, auditCtx(tx));
      expect(inner, "the probe must have written both rows before rolling back").not.toBeNull();
      throw new Error("deliberate rollback");
    })).rejects.toThrow("deliberate rollback");
    expect(await serviceRows(), "the services row must not survive the rollback").toEqual([]);
    expect(await generationRows(), "the generation must not survive the rollback").toEqual([]);
    // ★ SVC-007 Unit B — THE AUDIT IS PART OF THE SAME ATOMIC UNIT, and this is the assertion
    // that says so. The audit row was written inside the transaction (T15 proves a committed
    // create leaves exactly one), so if it survived here it would be on a second connection —
    // which is the mutant "move the audit insert outside the transaction". An audit row for a
    // service that does not exist is worse than no row: it is a record of an act that was
    // undone.
    expect(await auditRows(), "the audit row must not survive the rollback either").toEqual([]);
  }, 90_000);

  // ── T2 — ★ THE CHAIN, and the sentence it makes false ──────────────────────────────────
  //
  // MUTANT: delete the `insertServiceGeneration` call (the base-tree state — `service_generations`
  // had ZERO writers). `reconcileService` then answers `no_generation` and nothing converges,
  // which is EXACTLY the state SVC-002 and SVC-003a shipped in.
  // MUTANT: write the definition under different key names. The reconciler's `readDefinition`
  // then reads `undefined` and the frozen workload validator refuses -> `invalid_definition`.
  it("★ T2 — a CREATED service converges into one instance and one real `service` job", async () => {
    const created = await create();
    expect(created).not.toBeNull();
    const serviceId = created!.serviceId;
    expect(created!.generation).toBe(1);
    expect(created!.desiredState).toBe("running");

    const outcome = await reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId });
    expect(outcome, "the pass must CREATE — a `none` here means the chain is broken")
      .toMatchObject({ action: "created" });
    if (outcome.action !== "created") return;

    const instances = await instanceRows(serviceId);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.status).toBe("pending");
    expect(instances[0]!.generation).toBe(1);
    expect(instances[0]!.job_id).toBe(outcome.jobId);
    expect(instances[0]!.attempt_id).toBe(outcome.attemptId);

    const jobs = await serviceJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.source_kind).toBe("service_reconcile");
    // The workload is rebuilt FROM THE STORED DEFINITION. Asserting the three fields
    // individually rather than the whole object is deliberate: the identity half is stamped
    // from the authorized source and is SVC-002's property, not this unit's.
    expect(jobs[0]!.input.command).toBe(DEFINITION.command);
    expect(jobs[0]!.input.args).toEqual(DEFINITION.args);
    expect(jobs[0]!.input.gracefulStopSeconds).toBe(DEFINITION.gracefulStopSeconds);
    expect(jobs[0]!.input.serviceId).toBe(serviceId);
    expect(jobs[0]!.input.serviceInstanceId).toBe(instances[0]!.id);
    expect(jobs[0]!.input.generation).toBe(1);

    // Idempotent: a second pass changes nothing.
    const second = await reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId });
    expect(second).toEqual({ action: "none", reason: "instance_present" });
    expect(await instanceRows(serviceId)).toHaveLength(1);
    expect(await serviceJobs()).toHaveLength(1);
  }, 120_000);

  // ── T3 — a service created `paused` does not start ─────────────────────────────────────
  //
  // MUTANT: ignore the requested `desiredState` and always write `running`. Creating a
  // service would then start it immediately, which is the opposite of what was asked.
  it("T3 — a service created `paused` writes its generation and converges NOTHING", async () => {
    const created = await create({ desiredState: "paused" });
    expect(created!.desiredState).toBe("paused");
    expect(await generationRows()).toHaveLength(1);
    const outcome = await reconcileService(f().app.db, {
      organizationId: ORG, companyId: COMPANY, serviceId: created!.serviceId,
    });
    expect(outcome).toEqual({ action: "none", reason: "desired_state_not_running" });
    expect(await instanceRows(created!.serviceId)).toEqual([]);
  }, 90_000);

  // ── T4 — the stored definition, exactly ────────────────────────────────────────────────
  //
  // MUTANT: write `ttl_seconds` / `checkpoint_artifact_id` from the request. Nothing enforces
  // a TTL (SVC-005) and nothing restores a checkpoint (SVC-004), so a stored value would be a
  // bound no code keeps — and `readService` would show an operator a limit that never fires.
  it("T4 — the generation stores the three definition fields and NOTHING it cannot enforce", async () => {
    const created = await create();
    const generations = await generationRows();
    expect(generations).toHaveLength(1);
    expect(generations[0]!.service_id).toBe(created!.serviceId);
    expect(generations[0]!.company_id).toBe(COMPANY);
    expect(generations[0]!.generation).toBe(1);
    expect(generations[0]!.definition).toEqual(DEFINITION);
    expect(generations[0]!.ttl_seconds, "a TTL nothing enforces must not be stored").toBeNull();
    expect(generations[0]!.checkpoint_artifact_id, "no restore pointer is accepted").toBeNull();
    expect(generations[0]!.created_by).toBe("svc-007-operator");

    // …and SVC-002's own reader finds it, which is the seam this unit exists to close.
    const read = await runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.findServiceGenerationDefinition({
        organizationId: ORG, companyId: COMPANY, serviceId: created!.serviceId, generation: 1,
      }));
    expect(read).not.toBeNull();
    expect(read!.definition).toEqual(DEFINITION);
  }, 90_000);

  // ── T5 — the composite tenant FK is the authority for the org/company pair ──────────────
  //
  // MUTANT: drop the FK-violation branch and let it 500. The refusal is what stops a service
  // pairing org A with a company owned by org B; a 500 would leave the caller unable to tell
  // a bad pair from an outage — and, worse, a version that did NOT fail would create a
  // cross-tenant service.
  it("T5 — a company from another organization is REFUSED, and no service row lands", async () => {
    await expect(create({ companyId: OTHER_COMPANY })).rejects.toThrow();
    expect(await serviceRows()).toEqual([]);
    expect(await serviceRows(OTHER_ORG)).toEqual([]);
    expect(await generationRows()).toEqual([]);
  }, 90_000);

  // ── T6 — ★ THE STOP ACTUALLY STOPS, AND THE RESUME ACTUALLY RESUMES ────────────────────
  //
  // ★★★ THIS IS THE CASE THAT REDS IF ANY ONE OF THE THREE WRITES STOPS. It drives create →
  // reconcile → stop → resume → reconcile, and every leg is a shipped entry point.
  //
  // MUTANT: delete the `requestGracefulStop` call — the desired-state column still moves and
  // the job stays `queued`, i.e. a Stop button that leaves a job the fleet can still lease.
  // MUTANT: delete `terminalizeServiceInstanceForCancelledAttempt` — the job is cancelled but
  // the instance stays `pending` inside `service_instances_live_service_uq` forever, so the
  // RESUME leg converges nothing on every tick. That wedge is invisible to any assertion that
  // stops at "the stop request was made", which is exactly why the resume leg is here.
  // MUTANT: swap the order of the desired-state write and the cancellation.
  it("★ T6 — stopping cancels the job AND terminalizes the instance, and resume starts a NEW one", async () => {
    const created = await create();
    const serviceId = created!.serviceId;
    const first = await reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId });
    expect(first).toMatchObject({ action: "created" });
    if (first.action !== "created") return;

    const stopped = await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId, desiredState: "stopped", reason: "operator stop",
      actor: OPERATOR,
    });
    expect(stopped.verdict).toMatchObject({ outcome: "updated", from: "running", to: "stopped" });
    expect(stopped.stop).toMatchObject({ status: "requested", jobId: first.jobId });
    // The job was never leased, so `requestCancellation` FINALIZES rather than queueing a
    // command — and that is precisely the branch on which no worker event will ever arrive.
    expect(stopped.stop && "cancellation" in stopped.stop ? stopped.stop.cancellation : null).toBe("cancelled");
    expect(stopped.stop && "instance" in stopped.stop ? stopped.stop.instance : null).toBe("applied");

    const jobs = await serviceJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("cancelled");
    expect(await attemptStatuses(first.jobId)).toEqual(["cancelled"]);

    const afterStop = await instanceRows(serviceId);
    expect(afterStop).toHaveLength(1);
    expect(afterStop[0]!.status, "a cancelled attempt must not strand its instance").toBe("failed");

    // While stopped, a pass creates no replacement.
    expect(await reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId }))
      .toEqual({ action: "none", reason: "desired_state_not_running" });

    // ★ THE RESUME LEG. Without the terminalization above this reds with `instance_present`,
    // and the service would never run again.
    const resumed = await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId, desiredState: "running", reason: "operator resume",
      actor: OPERATOR,
    });
    expect(resumed.verdict).toMatchObject({ outcome: "updated", from: "stopped", to: "running" });
    expect(resumed.stop, "resuming cancels nothing").toBeNull();

    const second = await reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId });
    expect(second, "a resumed service must start a NEW instance").toMatchObject({ action: "created" });
    if (second.action !== "created") return;
    expect(second.serviceInstanceId).not.toBe(first.serviceInstanceId);
    const finalInstances = await instanceRows(serviceId);
    expect(finalInstances).toHaveLength(2);
    expect(finalInstances.filter((row) => row.status === "pending")).toHaveLength(1);
  }, 180_000);

  // ── T7 — the FROZEN desired-state table refuses the illegal move, over real SQL ─────────
  //
  // MUTANT: replace `canTransitionServiceDesiredState` with `() => true`. `stopped -> paused`
  // is not an edge in the frozen table, and admitting it would let an operator park a stopped
  // service in a state the reconciler treats identically while the audit line says otherwise.
  it("T7 — an illegal desired-state move is refused and the column does not budge", async () => {
    const created = await create();
    const serviceId = created!.serviceId;
    await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId, desiredState: "stopped", reason: "stop",
      actor: OPERATOR,
    });
    expect((await serviceRows())[0]!.desired_state).toBe("stopped");

    const illegal = await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId, desiredState: "paused", reason: "pause",
      actor: OPERATOR,
    });
    expect(illegal.verdict).toEqual({ outcome: "illegal", from: "stopped", to: "paused" });
    expect(illegal.stop).toBeNull();
    expect((await serviceRows())[0]!.desired_state, "the refused move must not have written").toBe("stopped");

    const unchanged = await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId, desiredState: "stopped", reason: "again",
      actor: OPERATOR,
    });
    expect(unchanged.verdict).toMatchObject({ outcome: "unchanged", state: "stopped" });

    const absent = await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId: randomUUID(), desiredState: "stopped", reason: "x",
      actor: OPERATOR,
    });
    expect(absent.verdict).toEqual({ outcome: "absent" });
  }, 120_000);

  // ── T8 — the operator view, and its tenant scoping ─────────────────────────────────────
  //
  // MUTANT: drop the `companyId` predicate from `findServiceForCompany`. `aoa.organization_id`
  // is the ONLY GUC, so company scoping is necessarily app-layer — dropping it makes one
  // company's services readable from a sibling company in the same organization.
  it("T8 — the view shows desired state, generation, definition and the live instance", async () => {
    const created = await create();
    const serviceId = created!.serviceId;
    const before = await readService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId });
    expect(before).not.toBeNull();
    expect(before!.desiredState).toBe("running");
    expect(before!.generation).toBe(1);
    expect(before!.definition).toEqual(DEFINITION);
    expect(before!.liveInstance).toBeNull();

    await reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId });
    const after = await readService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId });
    expect(after!.liveInstance).toMatchObject({ status: "pending", generation: 1 });
    expect(after!.liveInstance!.jobId).not.toBeNull();

    const listed = await listServices(f().app.db, {
      organizationId: ORG, companyId: COMPANY, afterServiceId: null, limit: 100,
    });
    expect(listed.map((row) => row.serviceId)).toEqual([serviceId]);

    // Cross-COMPANY within the same org, and cross-ORG, are both invisible.
    expect(await readService(f().app.db, {
      organizationId: ORG, companyId: OTHER_COMPANY, serviceId,
    })).toBeNull();
    expect(await readService(f().app.db, {
      organizationId: OTHER_ORG, companyId: OTHER_COMPANY, serviceId,
    })).toBeNull();
    expect(await listServices(f().app.db, {
      organizationId: OTHER_ORG, companyId: OTHER_COMPANY, afterServiceId: null, limit: 100,
    })).toEqual([]);
  }, 120_000);

  // ── T10 — the backstop's precondition is a DATABASE fact ───────────────────────────────
  //
  // MUTANT: delete the "the attempt must already be terminal and not succeeded" gate in
  // `terminalizeServiceInstanceForCancelledAttempt`. Nothing above would red — T6 cancels the
  // attempt first, so the gate is satisfied there — and the method would become able to
  // terminalize a LIVE instance out from under a running worker, which is the split-brain
  // `service_instances_live_service_uq` exists to prevent. Driven directly against the
  // repository because no shipped caller can reach the unsafe state.
  it("T10 — the control-plane backstop REFUSES an instance whose attempt is still live", async () => {
    const created = await create();
    const serviceId = created!.serviceId;
    const first = await reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId });
    expect(first).toMatchObject({ action: "created" });
    if (first.action !== "created") return;
    expect((await instanceRows(serviceId))[0]!.status).toBe("pending");

    const refused = await runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.terminalizeServiceInstanceForCancelledAttempt({
        organizationId: ORG, companyId: COMPANY, jobId: first.jobId,
        toStatus: "failed", allowedFromStatuses: ["pending", "leased", "starting", "healthy", "unhealthy", "stopping"],
      }));
    expect(refused).toMatchObject({ outcome: "attempt_not_terminal", attemptStatus: "pending" });
    expect((await instanceRows(serviceId))[0]!.status, "a live instance must not be terminalized").toBe("pending");

    // …and an empty predecessor set REFUSES rather than writing unconditionally, once the
    // attempt IS terminal. MUTANT: treat an empty `allowedFromStatuses` as "anything goes".
    await f().admin`UPDATE job_attempts SET status = 'cancelled' WHERE job_id = ${first.jobId}`;
    const failClosed = await runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.terminalizeServiceInstanceForCancelledAttempt({
        organizationId: ORG, companyId: COMPANY, jobId: first.jobId,
        toStatus: "failed", allowedFromStatuses: [],
      }));
    expect(failClosed).toMatchObject({ outcome: "illegal_transition", fromStatus: "pending" });
    expect((await instanceRows(serviceId))[0]!.status).toBe("pending");
  }, 120_000);

  // ── T13 — ★ THE WHOLE STOP IS ONE TRANSACTION, UNDER THE SERVICE'S OWN LOCK ─────────────
  //
  // ★★★ THE REVIEW FIX, PINNED. The first revision committed the desired-state write, RELEASED
  // the lock, and then cancelled in a second transaction. External review of PR #412 named the
  // race that leaves: a concurrent `stopped -> running` landing in the gap means the older stop
  // still drains a job the operator has already resumed. Under one lock that interleaving is
  // unrepresentable — a resume cannot commit between the read of `desired_state` and the
  // cancellation, because it cannot acquire the row.
  //
  // The rollback probe is what distinguishes ONE transaction from two: the desired-state write,
  // the cancellation and the terminalization all vanish together, and a second transaction
  // would have committed its own half.
  //
  // MUTANT: give the cancellation or the terminalization its own `runInTenant` again.
  it("★ T13 — the desired-state write, the cancellation and the terminalization roll back TOGETHER", async () => {
    const created = await create();
    const serviceId = created!.serviceId;
    const first = await reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId });
    expect(first).toMatchObject({ action: "created" });
    if (first.action !== "created") return;

    const auditBefore = (await auditRows()).length;
    await expect(runInTenant(f().app.db, ORG, async (repos, tx) => {
      const inner = await setServiceDesiredStateWithinTenant(repos, {
        organizationId: ORG, companyId: COMPANY, serviceId,
        desiredState: "stopped", reason: "rollback probe",
      }, auditCtx(tx));
      // Everything must have HAPPENED inside the transaction before it is rolled back —
      // otherwise this probe would pass over a control that did nothing at all.
      expect(inner.verdict).toMatchObject({ outcome: "updated", from: "running", to: "stopped" });
      expect(inner.stop).toMatchObject({ status: "requested", instance: "applied" });
      throw new Error("deliberate rollback");
    })).rejects.toThrow("deliberate rollback");

    expect((await serviceRows())[0]!.desired_state, "the desired-state write must not survive").toBe("running");
    expect((await serviceJobs())[0]!.status, "the cancellation must not survive").toBe("queued");
    expect(await attemptStatuses(first.jobId)).toEqual(["pending"]);
    expect((await instanceRows(serviceId))[0]!.status, "the terminalization must not survive").toBe("pending");
    // ★ SVC-007 Unit B — the audit row rolls back with the other three. `auditBefore` is the
    // create's own row from `create()` above, so this asserts the DELTA is zero rather than
    // that the table is empty — which would have been a weaker assertion that a create writing
    // nothing would also satisfy.
    expect((await auditRows()).length - auditBefore, "the audit row must roll back too").toBe(0);
  }, 180_000);

  // ── T12 — the two narrow guards, driven directly because no shipped caller can reach them ─
  //
  // ★ WHY THESE ARE HERE AT ALL. Both guards were measured NOT to kill their mutants through
  // the shipped entry points: the generation insert's narrow catch has no reachable
  // non-`23505` failure from `createServiceWithinTenant` (the composite tenant FK is
  // satisfied by construction — the service row was inserted in the same transaction), and the
  // compare-and-set predicate is redundant while the caller holds the row lock. A guard whose
  // mutant nothing kills is a guard that can be deleted with a green suite, so each is
  // exercised against the repository directly and the residual is stated rather than dropped.
  it("T12 — the generation writer THROWS on a tenant violation, and the CAS refuses a stale expectation", async () => {
    // (a) MUTANT: widen the 23505 catch to a bare `catch { return null }`. A missing parent
    // would then be reported as "a generation already exists", which is a definite wrong
    // answer for a tenant mismatch — the fail-open shape this epic keeps refusing.
    await expect(runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.insertServiceGeneration({
        organizationId: ORG, companyId: COMPANY, serviceId: randomUUID(), generation: 1,
        definition: DEFINITION, createdBy: "t12",
      }))).rejects.toThrow();

    // …and a genuine (service, generation) duplicate IS resolved into a definite `null`.
    const created = await create();
    const duplicate = await runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.insertServiceGeneration({
        organizationId: ORG, companyId: COMPANY, serviceId: created!.serviceId, generation: 1,
        definition: DEFINITION, createdBy: "t12",
      }));
    expect(duplicate).toBeNull();
    expect(await generationRows()).toHaveLength(1);

    // (b) MUTANT: drop the `expectedDesiredState` predicate. It is redundant for the shipped
    // caller, which holds the row lock — it exists so a FUTURE caller that forgets the lock
    // still cannot overwrite a state it did not read.
    const stale = await runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.updateServiceDesiredState({
        organizationId: ORG, companyId: COMPANY, serviceId: created!.serviceId,
        expectedDesiredState: "paused", desiredState: "stopped",
      }));
    expect(stale, "a stale expectation must match no row").toBeNull();
    expect((await serviceRows())[0]!.desired_state).toBe("running");

    const fresh = await runInTenant(f().app.db, ORG, (repos) =>
      repos.jobControl.updateServiceDesiredState({
        organizationId: ORG, companyId: COMPANY, serviceId: created!.serviceId,
        expectedDesiredState: "running", desiredState: "stopped",
      }));
    expect(fresh).toMatchObject({ desiredState: "stopped", generation: 1 });
  }, 120_000);

  // ── T11 — the SWEEPER, not just the per-service pass ───────────────────────────────────
  //
  // ★ THE ARMING DISCRIMINATION FOR THE PRODUCTION LOOP. T2 calls `reconcileService`
  // directly; the composition root drives `createServiceReconciler(...).tick()`, whose window
  // comes from `listReconcilableServices`. A created service that never entered that window
  // would converge in T2 and never converge in production.
  //
  // ★ WHAT IS AND IS NOT THE PRODUCTION COMPOSITION, said so the case is not over-read: this
  // builds the SAME factory the composition root builds, and drives the SAME `tick()`, but the
  // admitted-organization enumerator is a stub returning `[ORG]` rather than
  // `listAdmittedOrganizationIds` off the `aoa_app` pool, and the backoff timer that
  // `server/src/index.ts` wraps around it is not exercised. What this proves is that a service
  // this unit created enters `listReconcilableServices`'s window and converges through the
  // sweep — not that the process wiring around the sweeper runs.
  //
  // MUTANT: write `desired_state` as anything but `running` at create — the sweep window's
  // predicate is `desired_state = 'running'`, so the service would be invisible to the tick.
  it("★ T11 — the composition root's sweeper converges a service the create path made", async () => {
    const { createServiceReconciler } = await import("../services/service-reconciler.js");
    const created = await create();
    const reconciler = createServiceReconciler({
      appDb: f().app.db,
      listAdmittedOrganizationIds: async () => [ORG],
      tickBudgetMs: 5_000,
    });
    const tick = await reconciler.tick();
    expect(tick.created, "the sweeper must converge the created service").toBe(1);
    expect(tick.services).toBeGreaterThanOrEqual(1);
    const instances = await instanceRows(created!.serviceId);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.status).toBe("pending");
    // The window is now empty — a converged service leaves it.
    const second = await reconciler.tick();
    expect(second.created).toBe(0);
  }, 180_000);

  // ── T9 — ★ NAMED POSITIVE CONTROL ──────────────────────────────────────────────────────
  //
  // ★ WHY THIS EXISTS. Every convergence assertion above could be made green a second way:
  // by weakening the reconciler until it starts a service WITHOUT a readable definition. This
  // control pins the honest stall — a hand-inserted `services` row with NO generation converges
  // NOTHING and reports `no_generation`, which is the exact state the whole tree was in at
  // base. It must stay GREEN under every mutant applied to this unit's writer; if it ever reds,
  // a green T2 was measuring a broken reconciler rather than a working writer.
  it("★ T9 POSITIVE CONTROL — a service with no generation still stalls at `no_generation`", async () => {
    const serviceId = randomUUID();
    await f().admin`INSERT INTO services (id, organization_id, company_id, desired_state, generation)
      VALUES (${serviceId}, ${ORG}, ${COMPANY}, 'running', 1)`;
    expect(await generationRows()).toEqual([]);
    const outcome = await reconcileService(f().app.db, { organizationId: ORG, companyId: COMPANY, serviceId });
    expect(outcome).toEqual({ action: "none", reason: "no_generation" });
    expect(await instanceRows(serviceId)).toEqual([]);
    expect(await serviceJobs()).toEqual([]);
  }, 90_000);

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // SVC-007 UNIT B — THE DURABLE AUDIT, over the real table, the real grant and the real role.
  //
  // ★★★ WHAT THESE FIVE CASES ARE FOR, AND WHY THEY CANNOT BE PURE. `SVC-007a-result.md`
  // §4a(iii)/§7 concluded that an `activity_log` row was "currently unwritable" from these
  // routes because `jobAuditBridge.recordAcceptedActivity` requires an `ActiveFenceRequest`.
  // That is a claim about what the DATABASE and the app ROLE permit, so a stub cannot settle
  // it. These cases settle it: the writes below go through the `aoa_app` pool inside
  // `runInTenant`, with no lease, no attempt, no fence and no projection receipt, and the rows
  // are read back on the ADMIN connection — a different session, so a visible row is a
  // COMMITTED row. See `E9-F010`.
  //
  // Each case names the mutant that must re-red it; `SVC-007b-result.md` records which did.
  // ─────────────────────────────────────────────────────────────────────────────────────────

  // MUTANT: delete the `recordServiceCreateActivity` call from `createServiceWithinTenant` —
  // the BASE-TREE state, in which these routes wrote nothing durable at all.
  it("★ T14 — a create writes exactly ONE durable audit row, with no fence and no receipt", async () => {
    const created = await create();
    const rows = await auditRows();
    expect(rows, "one control action is one row").toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("service.create");
    expect(row.entity_type).toBe("service");
    expect(row.entity_id).toBe(created!.serviceId);
    expect(row.company_id).toBe(COMPANY);
    expect(row.actor_type).toBe("user");
    expect(row.actor_id).toBe(OPERATOR.actorId);
    expect(row.run_id, "run_id FKs heartbeat_runs and there is no heartbeat run here").toBeNull();
    expect(row.agent_id).toBeNull();
    expect(row.details).toMatchObject({ generation: 1, desiredState: "running" });

    // ★ THE OTHER HALF OF THE CLAIM, ASSERTED RATHER THAN ASSUMED: this path writes NO
    // JOB-005 projection receipt, because it has no fence to guard one with and
    // `job_projection_receipts.source_fence` is NOT NULL. If a row ever appeared here, the
    // audit would have acquired a second, fenced identity nobody designed.
    const receipts = await f().admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM job_projection_receipts WHERE projection_kind = 'activity_audit'`;
    expect(receipts[0]!.n).toBe(0);
  }, 120_000);

  // MUTANT: skip the audit on `unchanged`, or drop `reason` from the details.
  //
  // ★ THE RESUME LEG IS THE ONE THAT MATTERS. A stop already carried the operator's reason
  // into `job_control_commands.body` through `requestCancellation`; a RESUME reached no
  // durable sink at all before this unit — external review of PR #412 raised exactly that, and
  // SVC-007a fixed only the process log. This case reads the resume's reason back out of the
  // database.
  it("★ T15 — stop, re-issued stop and resume each leave one durable row carrying the reason", async () => {
    const created = await create();
    const serviceId = created!.serviceId;

    const stopped = await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId,
      desiredState: "stopped", reason: "audit-stop", actor: OPERATOR,
    });
    expect(stopped.verdict).toMatchObject({ outcome: "updated" });

    const again = await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId,
      desiredState: "stopped", reason: "audit-restop", actor: OPERATOR,
    });
    expect(again.verdict).toMatchObject({ outcome: "unchanged" });

    const resumed = await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId,
      desiredState: "running", reason: "audit-resume", actor: OPERATOR,
    });
    expect(resumed.verdict).toMatchObject({ outcome: "updated", from: "stopped", to: "running" });

    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual([
      "service.create", "service.desired_state", "service.desired_state", "service.desired_state",
    ]);
    const controls = rows.slice(1).map((r) => r.details as Record<string, unknown>);
    expect(controls[0]).toMatchObject({ outcome: "updated", from: "running", to: "stopped", reason: "audit-stop" });
    expect(controls[1]).toMatchObject({ outcome: "unchanged", from: null, to: "stopped", reason: "audit-restop" });
    expect(controls[2], "the RESUME's reason is the one that reached nothing durable before")
      .toMatchObject({ outcome: "updated", from: "stopped", to: "running", reason: "audit-resume" });
  }, 180_000);

  // MUTANT: audit unconditionally, on every exit of the control.
  it("★ T16 — a refused control writes NO durable row", async () => {
    const created = await create();
    const serviceId = created!.serviceId;
    await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId,
      desiredState: "stopped", reason: "park it", actor: OPERATOR,
    });
    const beforeRefusals = (await auditRows()).length;

    // `stopped -> paused` is not an edge in the FROZEN table.
    const illegal = await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId,
      desiredState: "paused", reason: "illegal", actor: OPERATOR,
    });
    expect(illegal.verdict.outcome).toBe("illegal");

    // A service that is not there. The route answers a UNIFORM 404 so a caller cannot tell it
    // from another tenant's service; a row here would be a record of a mutation that did not
    // happen.
    const absent = await setServiceDesiredState(controlDeps(), {
      organizationId: ORG, companyId: COMPANY, serviceId: randomUUID(),
      desiredState: "stopped", reason: "absent", actor: OPERATOR,
    });
    expect(absent.verdict.outcome).toBe("absent");

    expect((await auditRows()).length - beforeRefusals, "two refusals must add nothing").toBe(0);
  }, 150_000);

  // MUTANT: write the audit row on the ADMIN pool, or outside `runInTenant`.
  //
  // ★ THE ROLE IS THE POINT. `SVC-007a-result.md` called this write blocked; the block, if
  // there were one, would be a missing privilege on the non-owner serving role. This case
  // proves the privilege by exercising it: the row below is written by `aoa_app` — the pool
  // `jobControlRoutes` is mounted over — through `createService`, and nothing about it is
  // elevated. `activity_log` carries table-level `SELECT, INSERT` for `aoa_app` (migration
  // `0213`, re-affirmed by `0214`) and no RLS, which migration `0245`'s own header states.
  it("★ T17 — the row is written by the non-owner `aoa_app` serving role itself", async () => {
    const created = await create();
    const viaApp = await runInTenant(f().app.db, ORG, async (_repos, tx) => {
      const rows = await tx.execute(
        // Read back through the SAME role that wrote it. `current_user` is asserted so a
        // future change of pool cannot make this case pass for the wrong reason.
        sql`SELECT current_user::text AS role, count(*)::int AS n FROM activity_log
            WHERE company_id = ${COMPANY} AND action = 'service.create'`,
      );
      return (rows as unknown as Array<{ role: string; n: number }>)[0]!;
    });
    expect(viaApp.role, "the serving role, not the owner").toBe("aoa_app");
    expect(viaApp.n).toBe(1);
    expect((await auditRows())[0]!.entity_id).toBe(created!.serviceId);
  }, 120_000);

  // MUTANT: drop the after-commit drain (`publishServiceControlActivity`) from `createService`.
  //
  // ★ WHAT THIS CASE PROVES AND WHAT IT DOES NOT, stated so it is not over-read. It proves
  // that a COMMITTED create pokes the live feed exactly once, with the `activity.logged`
  // payload the durable row carries, and that the row is durable by the time the caller
  // returns. It does NOT prove the poke happened AFTER the commit rather than just before it:
  // the poke leaves no database trace, and a second connection reading at the instant of the
  // poke would block until commit and then answer "visible" either way, so no observation from
  // here can separate the two. That ordering is held by construction — the drain sits after
  // `runInTenant` has returned, so a mid-transaction throw never reaches it — and by `B5` in
  // `service-control-audit.test.ts`, which pins that recording publishes nothing at all and
  // that publishing is a separate call the transaction's owner makes.
  it("★ T18 — a committed create pokes the live feed exactly once, and the row is already durable", async () => {
    const live = await import("../services/live-events.js");
    const spy = vi.spyOn(live, "publishLiveEvent").mockImplementation(() => {});
    try {
      const created = await create();
      expect(spy, "a committed create must poke the feed exactly once").toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatchObject({ companyId: COMPANY, type: "activity.logged" });
      const rows = await auditRows();
      expect(rows, "the row is durable by the time the caller returns").toHaveLength(1);
      expect(rows[0]!.entity_id).toBe(created!.serviceId);
    } finally {
      spy.mockRestore();
    }
  }, 120_000);
});
