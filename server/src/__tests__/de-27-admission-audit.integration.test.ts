/**
 * DE-27, audit clause (cross-replica-admission conjunct) — a refused worker admission
 * leaves an attributable durable record, for BOTH of the two admission deny sites.
 *
 * ★ WHAT THIS TEST IS FOR. `docs/architecture/distributed-execution-threat-controls.json`
 * DE-27's `audit` clause was AMENDED by E0-F013 Decision 1.2(c): "cross-replica
 * admission events are audited" is read WEAKLY — each admission REFUSAL is durably
 * recorded — and the "partition" conjunct is dropped as vacuous (no detector exists).
 * Admission is already DB-serialized across replicas (a shared advisory lock over the
 * organization for capacity; one shared counter row for the poll limiter), so the
 * clause does NOT require a record naming WHICH replica decided, and the system has no
 * replica identity to name. So the whole remaining deliverable is: durably record the
 * two admission refusals —
 *   over_cap  — `worker-admission-rate-limit.ts admit()`, the shared
 *               per-organization worker-poll rate limit; and
 *   capacity  — `org-concurrency.ts admitAttemptCapacity()`, the shared
 *               per-organization concurrency cap, reached at submit time.
 * Before this unit both deny paths returned/threw before anything durable was written,
 * so a throttled poll and a capacity-refused submit were indistinguishable from traffic
 * that never happened.
 *
 * ★ WHY THIS IS NOT A READ-BACK. It never constructs a denial row. It PROVOKES the real
 * refusals through the real code — the real `createWorkerAdmissionRateLimiter().admit`
 * over a real shared counter, and the real `jobSubmissionService.submit` over a real
 * organization cap of 1 — and then asserts the durable rows the refusals themselves
 * leave behind, against real embedded PostgreSQL under the real `aoa_app` non-owner role.
 *
 * ★ ATTRIBUTION IS THE ASSERTION. Each of WHO / TENANT / RESOURCE / WHY is asserted
 * separately rather than asserting that a row merely exists:
 *   WHO      -> actor_type is "system" (a worker/principal has no truthful
 *               ActivityActorType) and actor_id is the SPECIFIC authenticated principal
 *               refused — the refused worker's id (over_cap) or the submitting
 *               principal's id (capacity) — NEVER the organization id. The tenant is
 *               not the actor: two principals in one org must stay distinguishable.
 *   TENANT   -> organization_id (and, for capacity, company_id) is the refusing tenant
 *   RESOURCE -> over_cap names the org's worker-poll admission; capacity names the attempt
 *   WHY      -> details.reason is a stable branch code, told APART (over_cap vs capacity),
 *               plus details.crossing = "DE-27"
 *
 * ★ POSITIVE CONTROLS, so a lazy writer fails this file:
 *   1. The two ADMITTED polls (count 1, 2) below the cap write NO row.
 *   2. The ADMITTED submit (under the cap of 1) writes NO row.
 *   3. The two refusals carry DIFFERENT reason codes — a constant reason would fail the
 *      anti-vacuity arm.
 *   4. ATTRIBUTION IS NOT A CONSTANT: a refusal for a SECOND organization lands under
 *      that organization, not the first.
 *   5. WHO IS THE PRINCIPAL, NOT THE TENANT: actor_id is the refused worker id
 *      (over_cap) / the submitting principal id (capacity), and each arm asserts it is
 *      NOT the organization id — so the reverted bug (`actorId = organizationId`, or
 *      any constant) goes RED. The over_cap worker id and the capacity principal id are
 *      DISTINCT from the org uuid and from each other, so a writer that stamped either
 *      the org or one constant identity cannot pass both arms.
 *   6. EACH REFUSAL IS RECORDED (per-refusal, not coalesced): the over_cap write fires on
 *      EVERY over-cap poll, per the founder-ruled reading of the DE-27 audit clause
 *      (E0-F013 Decision 1.2c: "each admission REFUSAL is durably recorded"). A second
 *      over-cap poll in the SAME window by a DIFFERENT worker writes a SECOND, distinctly
 *      attributed row (with its own count). A first-crossing / per-window coalesce was
 *      considered and REJECTED — it drops refusals the ruled clause requires be recorded;
 *      write-amplification is bounded by the poll rate limit + activity_log retention, a
 *      pattern-wide property of the whole deny-path class (DE-03/DE-06/DE-19 also per-refusal).
 *   7. actorType REFLECTS THE PRINCIPAL KIND — honest about the id in `principal.id`: the
 *      userId-backed kinds `user`/`commander`/`local_board` record actor_type "user",
 *      `agent` records "agent", and the machine/key kinds record "system" — `worker`
 *      (over_cap), `system`, and `mcp` (whose principal.id is the authentication KEY id, not
 *      the owner userId, so recording it as "user" would misattribute). A real
 *      human/board/Commander capacity denial is NOT flattened to "system".
 *
 * ★ KILLED MUTANTS (each makes at least one arm RED, verified RED-first):
 *   (a)  delete the over_cap write            -> "THE CLAUSE (over_cap)" RED
 *   (b)  delete the capacity intent capture   -> "THE CLAUSE (capacity)" RED
 *   (c)  stamp a constant `reason`            -> "THE REASON IS READ FROM THE BRANCH" RED
 *   (d)  write on the ADMITTED poll path too  -> the over_cap "wrote ONE row" positive control RED
 *   (e)  stamp `actorId = organizationId`     -> the three WHO arms RED (control 5)
 *   (f') ADD a first-crossing gate `count === config.max + 1` -> the per-refusal arm's
 *        "expect 2 rows" assertion RED (the second over-cap refusal would be dropped)
 *   (g)  map `mcp` (a key credential) to "user" (or map any userId-backed kind to "system")
 *        -> the "actorType REFLECTS THE PRINCIPAL KIND" arm's mcp `="system"` (resp.
 *        user-backed `="user"`) assertion RED
 *
 * Real Postgres (embedded-postgres + the committed migration chain), the real limiter,
 * the real submit path (which threads the capacity-denial sink and drains it on the pool
 * handle after the rolled-back tenant transaction closes). No stubs on the deny path and
 * none on the writer.
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI `push` is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real. Harness modeled on
 * `worker-admission-rate-limit.integration.test.ts`, `job-submit-capacity-admission.integration.test.ts`
 * and `de-19-memory-denial-audit.integration.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import { createWorkerAdmissionRateLimiter } from "../services/worker-admission-rate-limit.js";
import { recordWorkerAdmissionDenial } from "../services/worker-admission-denial-audit.js";
import { jobSubmissionService } from "../services/job-submission.js";
import { ORG, COMPANY, setupJobControlFixture, type JobControlFixture } from "./helpers/job-control-fixture.js";

const integration = describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
);

/** A SECOND organization, for the attribution control. Its own `organizations` row so a
 * refusal for it is FK-valid and attributable to it and not to `ORG`. */
const ORG2 = "a6000000-0000-4000-8000-0000000000f2";

/** DE-27 WHO — the refused worker ids, DISTINCT from any org uuid, so an over_cap row
 * that named the org (the reverted bug) or a constant is caught. `actor_id` has no FK, so
 * these need no `workers` row. `WORKER_A` refuses under ORG, `WORKER_B` under ORG2, and
 * `WORKER_C` re-polls the SAME over-cap window as `WORKER_A` to prove each refusal is
 * recorded per-poll (a second, distinctly-attributed row). */
const WORKER_A = "d7000000-0000-4000-8000-0000000000a1";
const WORKER_B = "d7000000-0000-4000-8000-0000000000b2";
const WORKER_C = "d7000000-0000-4000-8000-0000000000c3";

/** DE-27 WHO — the submitting principal for the capacity path. `submission()` presents
 * this exact (kind, id), and the capacity row's actor_id must equal this id, NOT the org. */
const SUBMIT_PRINCIPAL_KIND = "system";
const SUBMIT_PRINCIPAL_ID = "de27-submit-test";

interface DenialRow {
  company_id: string | null;
  organization_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown> | null;
}

integration("DE-27 audit clause — the two worker-admission refusals leave attributable durable records", () => {
  let fx: JobControlFixture | null = null;
  let setupError: unknown = null;
  let priorFlag: string | undefined;

  function ctx(): JobControlFixture {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!fx) throw new Error("fixture not initialized");
    return fx;
  }

  /** Every `security.denied.worker_admission` row, newest last. */
  async function admissionDenialRows(): Promise<DenialRow[]> {
    return ctx().admin<DenialRow[]>`
      SELECT company_id, organization_id, actor_type, actor_id, action, entity_type, entity_id, details
      FROM activity_log
      WHERE action = 'security.denied.worker_admission'
      ORDER BY created_at ASC`;
  }

  async function rowsWithReason(reason: string): Promise<DenialRow[]> {
    return (await admissionDenialRows()).filter((r) => r.details?.reason === reason);
  }

  async function clearAll(): Promise<void> {
    const { admin } = ctx();
    await admin`DELETE FROM activity_log WHERE action = 'security.denied.worker_admission'`;
    await admin`DELETE FROM worker_admission_rate_limits`;
    await admin`DELETE FROM job_outbox`;
    await admin`DELETE FROM job_attempts`;
    await admin`DELETE FROM jobs`;
    await admin`UPDATE organizations SET concurrency_cap = NULL WHERE id IN (${ORG}, ${ORG2})`;
  }

  const WINDOW_MS = 60_000;
  const clockAt = (ms: number) => () => new Date(ms);

  function submission(idempotencyKey: string) {
    return {
      organizationId: ORG,
      companyId: COMPANY,
      principal: { kind: SUBMIT_PRINCIPAL_KIND as const, id: SUBMIT_PRINCIPAL_ID },
      command: {
        idempotencyKey,
        source: { kind: "one_shot" as const, operationId: randomUUID(), operationKind: "readiness_probe" as const },
        input: { value: "de27" },
      },
    };
  }

  beforeAll(async () => {
    // The submit-time capacity admission is dormant behind the deployment flag; turn it on.
    priorFlag = process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;
    process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = "true";
    try {
      fx = await setupJobControlFixture("de27-admission-audit");
      // The second organization for the attribution control (no company needed — the
      // over_cap refusal is org-scoped and records companyId=null).
      await fx.admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG2}, 'DE-27 org B', 'de27-org-b')`;
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterEach(async () => {
    if (fx && !setupError) await clearAll();
  });

  afterAll(async () => {
    if (priorFlag === undefined) delete process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED;
    else process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = priorFlag;
    await fx?.teardown();
  }, 60_000);

  it("setup: nothing has been refused yet, so no admission-denial row exists", async () => {
    await clearAll();
    expect(await admissionDenialRows()).toHaveLength(0);
  });

  // ── over_cap ────────────────────────────────────────────────────────────────────────

  it("PROVOKE over_cap — the third poll over a cap of 2 is refused", async () => {
    await clearAll();
    const limiter = createWorkerAdmissionRateLimiter({
      appDb: ctx().app.db,
      config: { windowMs: WINDOW_MS, max: 2 },
      now: clockAt(120_000),
    });
    expect((await limiter.admit(ORG, WORKER_A)).allowed).toBe(true); // count 1
    expect((await limiter.admit(ORG, WORKER_A)).allowed).toBe(true); // count 2
    const third = await limiter.admit(ORG, WORKER_A);
    expect(third).toEqual({ allowed: false, reason: "over_cap", count: 3, limit: 2 });
  }, 60_000);

  it("★ THE CLAUSE (over_cap) — that refusal wrote ONE durable row attributing WHO / TENANT / RESOURCE / WHY", async () => {
    await clearAll();
    const limiter = createWorkerAdmissionRateLimiter({
      appDb: ctx().app.db,
      config: { windowMs: WINDOW_MS, max: 2 },
      now: clockAt(120_000),
    });
    await limiter.admit(ORG, WORKER_A);
    await limiter.admit(ORG, WORKER_A);
    await limiter.admit(ORG, WORKER_A); // over_cap

    const rows = await admissionDenialRows();
    // POSITIVE CONTROL — the two ADMITTED polls wrote NO row. Without this, "write an
    // admission-denial row unconditionally" would pass every over_cap assertion below.
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // WHO — the SPECIFIC refused worker, not the tenant org. actor_type is "system"
    // (a worker has no truthful ActivityActorType); actor_id is the refused worker id.
    expect(row.actor_type).toBe("system");
    expect(row.actor_id).toBe(WORKER_A);
    // …and WHO is NOT the organization: the reverted bug (`actorId = organizationId`)
    // stamped ORG here, so this assertion is exactly what goes RED without the fix.
    expect(row.actor_id).not.toBe(ORG);
    expect(String(row.details?.principalKind)).toBe("worker");
    // TENANT — org-scoped limiter: the organization axis is set, the company axis is null.
    expect(row.organization_id).toBe(ORG);
    expect(row.company_id).toBeNull();
    // RESOURCE — the org's worker-poll admission bucket.
    expect(row.entity_type).toBe("worker_poll_admission");
    expect(row.entity_id).toBe(ORG);
    // WHY — a stable branch code, the crossing, and the control that refused.
    expect(row.action).toBe("security.denied.worker_admission");
    expect(row.details?.reason).toBe("over_cap");
    expect(row.details?.crossing).toBe("DE-27");
    expect(String(row.details?.control)).toContain("worker-admission-rate-limit.ts");
    // The window count and limit ride details, so an operator can see how far over the org went.
    expect(Number(row.details?.count)).toBe(3);
    expect(Number(row.details?.limit)).toBe(2);
  }, 60_000);

  it("★ ATTRIBUTION IS NOT A CONSTANT — a refusal for a SECOND organization lands under THAT organization", async () => {
    await clearAll();
    const limiterB = createWorkerAdmissionRateLimiter({
      appDb: ctx().app.db,
      config: { windowMs: WINDOW_MS, max: 1 },
      now: clockAt(120_000),
    });
    expect((await limiterB.admit(ORG2, WORKER_B)).allowed).toBe(true); // count 1
    const over = await limiterB.admit(ORG2, WORKER_B);
    expect(over).toMatchObject({ allowed: false, reason: "over_cap" });

    const rows = await admissionDenialRows();
    expect(rows).toHaveLength(1);
    // TENANT is attributed to ORG2 — the refusing organization — not to ORG. A writer that
    // stamped a constant tenant would fail here.
    expect(rows[0]!.organization_id).toBe(ORG2);
    expect(rows[0]!.organization_id).not.toBe(ORG);
    // WHO is the refused WORKER, and it is NEITHER organization id. This is the precise
    // proof that actor_id is the principal and not the tenant: a writer that recorded
    // `actorId = organizationId` would stamp ORG2 here (== organization_id), and a writer
    // that stamped a constant identity would not carry WORKER_B's distinct value.
    expect(rows[0]!.actor_id).toBe(WORKER_B);
    expect(rows[0]!.actor_id).not.toBe(ORG2);
    expect(rows[0]!.actor_id).not.toBe(ORG);
    expect(rows[0]!.actor_id).not.toBe(rows[0]!.organization_id);
  }, 60_000);

  it("★ EACH over_cap REFUSAL IS RECORDED — a second over-cap poll writes a SECOND row, per Decision 1.2c", async () => {
    await clearAll();
    const limiter = createWorkerAdmissionRateLimiter({
      appDb: ctx().app.db,
      config: { windowMs: WINDOW_MS, max: 2 },
      now: clockAt(120_000), // one fixed window for every poll below
    });
    expect((await limiter.admit(ORG, WORKER_A)).allowed).toBe(true); // count 1
    expect((await limiter.admit(ORG, WORKER_A)).allowed).toBe(true); // count 2

    // count 3 = max + 1 — the first over-cap refusal, attributed to WORKER_A. One row.
    const firstOver = await limiter.admit(ORG, WORKER_A);
    expect(firstOver).toMatchObject({ allowed: false, reason: "over_cap", count: 3 });
    const afterFirst = await admissionDenialRows();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.actor_id).toBe(WORKER_A);
    expect(Number(afterFirst[0]!.details?.count)).toBe(3);

    // count 4 = max + 2 — a DIFFERENT worker re-polls the SAME over-cap window. The ruled
    // clause (Decision 1.2c) requires EACH admission refusal be recorded, so this writes a
    // SECOND row, attributed to WORKER_C and carrying its own count. Adding a first-crossing
    // gate `count === config.max + 1` (the mutant) would DROP this row → this arm goes RED.
    const secondOver = await limiter.admit(ORG, WORKER_C);
    expect(secondOver).toMatchObject({ allowed: false, reason: "over_cap", count: 4 });
    const afterSecond = await admissionDenialRows();
    expect(afterSecond).toHaveLength(2); // per-refusal: each over-cap poll leaves its own row
    // The rows are two DISTINCT refusals, each attributed to the worker that provoked it and
    // carrying that poll's count — not one coalesced row and not two identical copies.
    const byWorker = new Map(afterSecond.map((r) => [r.actor_id, r]));
    expect(byWorker.has(WORKER_A)).toBe(true);
    expect(byWorker.has(WORKER_C)).toBe(true);
    expect(Number(byWorker.get(WORKER_A)!.details?.count)).toBe(3);
    expect(Number(byWorker.get(WORKER_C)!.details?.count)).toBe(4);
  }, 60_000);

  // ── capacity ────────────────────────────────────────────────────────────────────────

  it("PROVOKE capacity — a submit over an organization cap of 1 is refused (429), and the ADMITTED submit before it wrote NO row", async () => {
    await clearAll();
    await ctx().admin`UPDATE organizations SET concurrency_cap = 1 WHERE id = ${ORG}`;
    const svc = jobSubmissionService(ctx().app.db);

    const first = await svc.submit(submission(randomUUID()));
    expect(first.replayed).toBe(false);
    // POSITIVE CONTROL — the admitted submit wrote no capacity denial row.
    expect(await rowsWithReason("capacity")).toHaveLength(0);

    await expect(svc.submit(submission(randomUUID()))).rejects.toMatchObject({ status: 429 });
  }, 60_000);

  it("★ THE CLAUSE (capacity) — the capacity refusal wrote ONE durable row attributing WHO / TENANT / RESOURCE / WHY", async () => {
    await clearAll();
    await ctx().admin`UPDATE organizations SET concurrency_cap = 1 WHERE id = ${ORG}`;
    const svc = jobSubmissionService(ctx().app.db);

    await svc.submit(submission(randomUUID())); // admitted, holds the one slot
    await expect(svc.submit(submission(randomUUID()))).rejects.toMatchObject({ status: 429 });

    const rows = await rowsWithReason("capacity");
    // Exactly one — the admitted submit wrote nothing, the refused submit wrote one.
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // WHO — the SUBMITTING PRINCIPAL, not the tenant org. actor_type is derived from the
    // principal kind: this submission's principal is `system`, so `system` (a user/agent
    // submitter would be `user`/`agent` — see the "actorType REFLECTS THE PRINCIPAL KIND"
    // arm). actor_id is the submitting principal's id; details.principalKind names its kind.
    expect(row.actor_type).toBe("system");
    expect(row.actor_id).toBe(SUBMIT_PRINCIPAL_ID);
    // …and WHO is NOT the organization: the reverted bug (`actorId = organizationId`)
    // stamped ORG here, so this assertion goes RED without the fix.
    expect(row.actor_id).not.toBe(ORG);
    expect(String(row.details?.principalKind)).toBe(SUBMIT_PRINCIPAL_KIND);
    // TENANT — both axes: capacity holds an FK-valid company (the just-inserted attempt).
    expect(row.organization_id).toBe(ORG);
    expect(row.company_id).toBe(COMPANY);
    // RESOURCE — the attempt that could not claim a slot (a real uuid; the attempt row
    // itself rolled back with the refused submission, but entity_id carries no FK).
    expect(row.entity_type).toBe("job_attempt");
    expect(row.entity_id).toMatch(/^[0-9a-f-]{36}$/i);
    // WHY.
    expect(row.action).toBe("security.denied.worker_admission");
    expect(row.details?.reason).toBe("capacity");
    expect(row.details?.crossing).toBe("DE-27");
    expect(String(row.details?.control)).toContain("org-concurrency.ts");
    expect(Number(row.details?.cap)).toBe(1);
  }, 60_000);

  // ── anti-vacuity ──────────────────────────────────────────────────────────────────

  it("★ THE REASON IS READ FROM THE BRANCH, NOT STAMPED — the two refusals carry DIFFERENT reason codes under the SAME action", async () => {
    await clearAll();
    // one over_cap
    const limiter = createWorkerAdmissionRateLimiter({
      appDb: ctx().app.db,
      config: { windowMs: WINDOW_MS, max: 1 },
      now: clockAt(120_000),
    });
    await limiter.admit(ORG, WORKER_A);
    await limiter.admit(ORG, WORKER_A); // over_cap
    // one capacity
    await ctx().admin`UPDATE organizations SET concurrency_cap = 1 WHERE id = ${ORG}`;
    const svc = jobSubmissionService(ctx().app.db);
    await svc.submit(submission(randomUUID()));
    await expect(svc.submit(submission(randomUUID()))).rejects.toMatchObject({ status: 429 });

    const rows = await admissionDenialRows();
    const reasons = rows.map((r) => r.details?.reason);
    // Both refusals filed under the ONE admission action, distinguished only by reason —
    // a constant reason (the mutation) would collapse this set to size 1.
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(["security.denied.worker_admission"]));
    expect(new Set(reasons)).toEqual(new Set(["over_cap", "capacity"]));
  }, 60_000);

  // ── actorType ───────────────────────────────────────────────────────────────────────

  it("★ actorType REFLECTS THE PRINCIPAL KIND — user/commander/local_board→user, agent→agent, mcp/worker/system→system", async () => {
    await clearAll();
    // Drive the shared recorder DIRECTLY (the function the actorType mapping lives in),
    // once per principal kind, against real PostgreSQL. actor_id stays the principal id;
    // the recorder derives actor_type from principalKind via actorTypeForPrincipalKind,
    // HONEST about the id actually in principal.id (built by principalFor, job-control.ts):
    // user/commander/local_board have a userId → `user`; `agent` has an agentId → `agent`;
    // `mcp` has the authentication KEY id (NOT the owner userId) → `system` (recording it as
    // user would misattribute); worker/system → `system`. Mapping `mcp` (a key credential) to
    // "user" (the mutant) makes its `="system"` assertion go RED.
    //
    // Why not provoke a `user` capacity refusal through the submit path: `one_shot` (the
    // submission builder's source) only admits requester kinds agent/system/commander
    // (SOURCE_REQUESTER_KINDS), and a `user` principal resolves to a founder/team_lead/
    // team_member requester (admission repo), which one_shot rejects BEFORE the capacity
    // branch — so a user capacity refusal is unreachable via one_shot. Recording through
    // the real recorder→recordSecurityDenial→activity_log path exercises the exact code
    // under change. The submit-path capacity arm above still covers the `system` case
    // end-to-end.
    const db = ctx().app.db;
    const cases: Array<{ kind: string; actorId: string; expected: string }> = [
      { kind: "user", actorId: "de27-user-actor", expected: "user" },
      // mcp WITHOUT a threaded owner userId (the defensive fallback) → system: the
      // principal.id is the KEY id, and with no owner in hand `system` is the honest
      // label. The common path threads an owner and records `user` — see the dedicated
      // arm below (task_8a0402bf).
      { kind: "mcp", actorId: "de27-mcp-key-id", expected: "system" },
      { kind: "commander", actorId: "de27-commander-actor", expected: "user" },
      { kind: "local_board", actorId: "de27-localboard-actor", expected: "user" },
      { kind: "agent", actorId: "de27-agent-actor", expected: "agent" },
      { kind: "worker", actorId: WORKER_A, expected: "system" },
      { kind: "system", actorId: "de27-system-actor", expected: "system" },
    ];
    for (const c of cases) {
      await recordWorkerAdmissionDenial(db, {
        reason: "capacity",
        companyId: COMPANY,
        organizationId: ORG,
        actorId: c.actorId,
        principalKind: c.kind,
        entityType: "job_attempt",
        entityId: randomUUID(),
        control: "server/src/__tests__/de-27-admission-audit.integration.test.ts:actorType",
      });
    }
    const rows = await admissionDenialRows();
    expect(rows).toHaveLength(cases.length);
    const byActor = new Map(rows.map((r) => [r.actor_id, r]));
    for (const c of cases) {
      const row = byActor.get(c.actorId)!;
      // WHO's TYPE is the truthful ActivityActorType for the kind — NOT always "system".
      expect(row.actor_type).toBe(c.expected);
      // The kind is also stamped into details for legibility, from the first-class field.
      expect(String(row.details?.principalKind)).toBe(c.kind);
      // actor_id is unchanged (the specific principal), and the org is never the actor.
      expect(row.actor_id).toBe(c.actorId);
      expect(row.actor_id).not.toBe(ORG);
    }
  }, 60_000);

  it("★ mcp OWNER attribution — a capacity refusal from an mcp submitter records the KEY OWNER as a `user`, not the bare key as `system` (task_8a0402bf)", async () => {
    await clearAll();
    // `principalFor` (job-control.ts) threads the mcp key's owner userId
    // (`mcp_api_keys.userId`, notNull, from `req.actor.userId`) as `ownerUserId`
    // alongside the key id. When present for an mcp principal the recorder attributes
    // the row to that owner as a `user` action — the SAME classification the canonical
    // `getActorInfo` makes for mcp at request time — and keeps the key id in
    // `details.mcpKeyId` for the trail. Driven directly on the recorder (the mapping's
    // home), against real PostgreSQL, because an mcp submitter is not reachable through
    // the one_shot capacity path (SOURCE_REQUESTER_KINDS excludes mcp), the same reason
    // the kind-matrix arm above drives the recorder directly.
    const db = ctx().app.db;
    const OWNER = "de27-mcp-owner-user";
    const KEY_ID = "de27-mcp-key-id-owned";
    const attemptId = randomUUID();
    await recordWorkerAdmissionDenial(db, {
      reason: "capacity",
      companyId: COMPANY,
      organizationId: ORG,
      actorId: KEY_ID,
      principalKind: "mcp",
      ownerUserId: OWNER,
      entityType: "job_attempt",
      entityId: attemptId,
      control: "server/src/__tests__/de-27-admission-audit.integration.test.ts:mcpOwner",
    });
    const rows = await admissionDenialRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // WHO — the OWNER, as a `user` action (matching getActorInfo), NOT the bare key as `system`.
    expect(row.actor_type).toBe("user");
    expect(row.actor_id).toBe(OWNER);
    // The authenticating key is still on the trail, and the kind is still legible.
    expect(String(row.details?.mcpKeyId)).toBe(KEY_ID);
    expect(String(row.details?.principalKind)).toBe("mcp");
    // The tenant is never the actor.
    expect(row.actor_id).not.toBe(ORG);
  }, 60_000);
});
