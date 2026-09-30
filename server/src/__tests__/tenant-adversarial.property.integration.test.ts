// TEN-005 (E2-D04) — the capstone H-01 (tenant isolation) adversarial PROPERTY
// suite. REAL embedded-Postgres. For each seed in a fixed reproducible set it
// generates a deterministic multi-Organization graph (server/src/testing/
// tenant-graph.ts), seeds it as the SUPERUSER (RLS-bypassing) so rows exist across
// tenants, then — acting through the NON-OWNER `aoa_app` pool inside `runInTenant`
// (TEN-003) / `withTenantTx` — hurls the hostile-identifier corpus at every
// E2-available surface and asserts every operation FAILS CLOSED WITHOUT DISCLOSING
// EXISTENCE.
//
// Surfaces exercised (E2-D04 surface registry — TENANT_ADVERSARIAL_SURFACES):
//   • repository    — tenant repositories via runInTenant over the non-owner pool +
//                     forced RLS (TEN-002/TEN-003).            [E2-covered]
//   • composite_sql — direct-SQL mixed-tenant construction rejected by the TEN-004
//                     composite FKs (23503).                    [E2-covered]
//   • http / worker_events / websocket / object_key / placement / restore
//                     — NOT implemented at E2 (owned by E3/E4/E5/E6); registered so
//                     later epics extend the same harness. The full D1 floor
//                     (20 seeds × 10 000 ops × ≥10 orgs) is owned by the D1 gate,
//                     NOT E2.
//
// Uniform denial / no existence disclosure (E2-D04, review R1-05) — the load-bearing
// security property is per-operation-KIND INDISTINGUISHABILITY of a cross-tenant
// target from an absent target:
//   • READ  — a cross-tenant id and a truly-absent id both resolve to `null` / `[]`
//             (RLS USING hides the row exactly as if it did not exist).
//   • WRITE — a cross-tenant INSERT is rejected by the policy WITH CHECK (42501)
//             IDENTICALLY whether or not any related row exists (RLS WITH CHECK fires
//             before the composite FK / not-found could differentiate), and an
//             UPDATE-to-another-org is the SAME 42501. No raw error text names another
//             tenant's row.
// The tenant repository accessors (packages/db/src/repositories/tenant/index.ts) are
// plain RLS-backed tx.select/insert with NO existence-revealing pre-check and NO
// catch-and-differentiate, so uniform denial holds NATURALLY — no normalization was
// needed (see TEN-005-result.md §Deviations).
//
// null-Org platform rows (E2-D04, review R1-03): no tenant GUC ever returns a
// platform (org-NULL) worker row, and aoa_app cannot INSERT/UPDATE a worker to org
// NULL (WITH CHECK 42501).
//
// Audit note (E2): at E2 there is NO audit sink for these DB-level RLS denials
// (activity-log wiring is E3). "audited where a sink exists" is therefore vacuously
// satisfied — no audit path is fabricated here.
//
// Determinism: the whole suite is reproducible from TENANT_ADVERSARIAL_SEEDS — the
// graph + corpus come from a seeded PRNG (no Math.random / no wall-clock in the graph;
// only the embedded-PG port allocation is nondeterministic infra, irrelevant to the
// tenant graph). Op counts per class are recorded and asserted non-vacuous.
//
// Gate: E2-D05 env-hatch. Runs automatically on Linux CI (process.platform !==
// "win32") and is Windows-runnable in place via AOA_RUN_WIN_INTEGRATION=1 (no source
// edit-and-restore). `describe.skipIf(...)` (not the banned fail-open ternary) keeps
// integration-test-hygiene green. Boot uses initdbFlags UTF8/C; setupError captured in
// beforeAll, re-thrown in the first `it` (fail closed). aoa_app LOGIN is provisioned
// IN-TEST as the superuser (the 0211 migration creates it NOLOGIN), connected via the
// cred-swap pattern (rls-canary.integration.test.ts:116).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  createTenantAppDb,
  assertNonOwnerConnection,
  organizations,
  companies,
  jobs,
  jobAttempts,
  leases,
  services,
  serviceInstances,
  jobArtifacts,
  jobSecretHandles,
  executionTargets,
  workers,
  type Db,
} from "@armyofagents/db";
import { withTenantTx } from "../db/with-tenant-tx.js";
import { runInTenant } from "../db/tenant-context.js";
import { TENANT_APP_ROLE, provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import {
  TENANT_ADVERSARIAL_OP_CLASSES,
  TENANT_ADVERSARIAL_SEEDS,
  buildHostileCorpus,
  generateTenantGraph,
  type TenantAdversarialOpClass,
  type TenantGraph,
} from "../testing/tenant-graph.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

const APP_PW = "app_pw";

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let adminUrl = "";
let db: Db; // owner/superuser connection (privileged migration/seeding role stand-in)
let appDb: Db; // NON-OWNER aoa_app serving connection (the role forced RLS constrains)
let setupError: unknown = null;

// ---- error/result helpers (walk drizzle's postgres-js cause chain) ---------------
function pgField(err: unknown, field: "code" | "constraint_name" | "message"): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 6 && e && typeof e === "object"; i += 1) {
    const v = (e as Record<string, unknown>)[field];
    if (typeof v === "string") return v;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
const sqlstate = (err: unknown): string | undefined => pgField(err, "code");

// The DEEPEST `message` in the cause chain — the raw PostgresError text (e.g. `new
// row violates row-level security policy "jobs_tenant_isolation" for table "jobs"`),
// NOT drizzle's wrapper message (which echoes the query + the params the CALLER
// supplied — the caller's own input, never a DB disclosure). The DB message is what
// "no raw error message reveals another tenant's existence/contents" is about.
function pgDeepestMessage(err: unknown): string | undefined {
  let e: unknown = err;
  let last: string | undefined;
  for (let i = 0; i < 6 && e && typeof e === "object"; i += 1) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") last = m;
    e = (e as { cause?: unknown }).cause;
  }
  return last;
}
let loggedErrShape = false;

async function captureReject(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  throw new Error("expected the statement to be rejected (RLS / constraint), but it succeeded");
}
function rowsOf<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : (res as { rows: T[] }).rows) as T[];
}
function count(res: unknown): number {
  const row = Array.isArray(res) ? (res[0] as { c: number }) : (res as { rows: { c: number }[] }).rows[0];
  return Number(row.c);
}

// ---- op-class counters (proving the suite is NON-vacuous) ------------------------
// The class set is exported from tenant-graph.ts so later epics extend it; meaning:
//   crossRead                   cross-tenant getById -> null
//   absentRead                  absent getById -> null
//   crossList                   listFor*(cross) -> []
//   crossInsertReject           insert row of another org -> 42501 (RLS WITH CHECK)
//   crossUpdateZero             update cross/absent row by id -> 0 rows
//   crossDeleteZero             delete cross/absent row by id -> 0 rows
//   updateToOtherOrgReject      update own row's org -> 42501
//   nullOrgReadZero             no GUC returns a platform (null-Org) worker
//   nullOrgWriteReject          insert/update a worker to org NULL -> 42501
//   compositeSqlReject          direct-SQL mixed-tenant construction -> 23503
//   crossParentVsAbsentUniform  own-org insert, cross-tenant vs absent PARENT id ->
//                               SAME composite FK + identical message (E2-F013/E2-D09)
type OpClass = TenantAdversarialOpClass;
const opCounts: Record<OpClass, number> = Object.fromEntries(
  TENANT_ADVERSARIAL_OP_CLASSES.map((k) => [k, 0]),
) as Record<OpClass, number>;
const perSeedOpCounts: Record<number, number> = {};
let loggedOracleShape = false;

// Seed a full deterministic graph as the SUPERUSER (RLS-bypassing), typed drizzle
// inserts with EXPLICIT ids so the hostile corpus can reference them. FK-safe order.
async function seedGraph(g: TenantGraph): Promise<void> {
  const orgRows = g.organizations.map((n) => ({ id: n.org.id, name: n.org.name, slug: n.org.slug }));
  await db.insert(organizations).values(orgRows);

  const companyRows = g.organizations.flatMap((n) =>
    n.companies.map((c) => ({
      id: c.id,
      organizationId: c.organizationId,
      name: c.name,
      issuePrefix: c.issuePrefix,
    })),
  );
  await db.insert(companies).values(companyRows);

  await db.insert(jobs).values(
    g.organizations.flatMap((n) =>
      n.jobs.map((j) => ({ id: j.id, organizationId: j.organizationId, companyId: j.companyId })),
    ),
  );
  await db.insert(jobAttempts).values(
    g.organizations.flatMap((n) =>
      n.attempts.map((a) => ({
        id: a.id,
        organizationId: a.organizationId,
        companyId: n.jobs.find((job) => job.id === a.jobId)!.companyId,
        jobId: a.jobId,
      })),
    ),
  );
  await db.insert(leases).values(
    g.organizations.flatMap((n) =>
      n.leases.map((l) => ({
        id: l.id,
        organizationId: l.organizationId,
        attemptId: l.attemptId,
        status: "active" as const,
        fence: l.fence,
        // JOB-003 makes activation explicit: every active lease retains the
        // instant it became authoritative, including legacy adversarial seeds.
        activatedAt: new Date(),
      })),
    ),
  );
  await db.insert(services).values(
    g.organizations.flatMap((n) =>
      n.services.map((s) => ({ id: s.id, organizationId: s.organizationId, companyId: s.companyId })),
    ),
  );
  await db.insert(serviceInstances).values(
    g.organizations.flatMap((n) =>
      n.serviceInstances.map((si) => ({
        id: si.id,
        organizationId: si.organizationId,
        companyId: si.companyId,
        serviceId: si.serviceId,
      })),
    ),
  );
  await db.insert(jobArtifacts).values(
    g.organizations.flatMap((n) =>
      n.jobArtifacts.map((ar) => ({
        id: ar.id,
        organizationId: ar.organizationId,
        jobId: ar.jobId,
        identifier: ar.identifier,
      })),
    ),
  );
  await db.insert(jobSecretHandles).values(
    g.organizations.flatMap((n) =>
      n.jobSecretHandles.map((sh) => ({
        id: sh.id,
        organizationId: sh.organizationId,
        jobId: sh.jobId,
        handle: sh.handle,
      })),
    ),
  );
  await db.insert(executionTargets).values([
    ...g.organizations.flatMap((n) =>
      n.workers.map((w) => ({
        id: w.id,
        organizationId: w.organizationId,
        ownerUserId: null,
        slug: `adversarial-org-${w.id.replaceAll("-", "")}`,
        kind: "dedicated_worker" as const,
        trustClass: "dedicated_tenant" as const,
        status: "active" as const,
        capabilities: {},
        config: {},
        scope: "organization" as const,
        targetAuthorityKey: `organization:${w.organizationId}`,
        deviceGeneration: 1,
      })),
    ),
    ...g.platformWorkers.map((w) => ({
      id: w.id,
      organizationId: null,
      ownerUserId: null,
      slug: `adversarial-platform-${w.id.replaceAll("-", "")}`,
      kind: "pooled_gvisor" as const,
      trustClass: "shared_multitenant" as const,
      status: "active" as const,
      capabilities: {},
      config: {},
      scope: "platform" as const,
      targetAuthorityKey: "platform",
      deviceGeneration: 1,
    })),
  ]);
  await db.insert(workers).values([
    ...g.organizations.flatMap((n) =>
      n.workers.map((w) => ({
        id: w.id,
        scope: "organization" as const,
        organizationId: w.organizationId,
        executionTargetId: w.id,
        targetAuthorityKey: `organization:${w.organizationId}`,
        deviceGeneration: 1,
        devicePublicKey: `adversarial-key-${w.id}`,
        deviceThumbprint: "a".repeat(64),
        profileHash: "b".repeat(64),
        enrolledAt: new Date("2026-01-01T00:00:00.000Z"),
        label: w.label,
      })),
    ),
    ...g.platformWorkers.map((w) => ({
      id: w.id,
      scope: "platform" as const,
      organizationId: null,
      executionTargetId: w.id,
      targetAuthorityKey: "platform",
      deviceGeneration: 1,
      devicePublicKey: `adversarial-key-${w.id}`,
      deviceThumbprint: "c".repeat(64),
      profileHash: "d".repeat(64),
      enrolledAt: new Date("2026-01-01T00:00:00.000Z"),
      label: w.label,
    })),
  ]);
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-tenant-adversarial-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    adminUrl = `postgres://test:test@localhost:${port}/postgres`;

    // Apply the whole chain incl. 0211 (aoa_app NOLOGIN + GRANT + ENABLE + FORCE +
    // per-table tenant policies on the 8 new-path tables) and 0209 (composite FKs).
    await applyPendingMigrations(adminUrl);
    db = createDb(adminUrl);

    // Provision the aoa_app LOGIN credential as the superuser (migration left it
    // NOLOGIN with no committed secret — E2-D01/E2-D03).
    await db.execute(sql.raw(provisionTenantAppRoleLoginSql(TENANT_APP_ROLE, APP_PW)));

    // The NON-OWNER serving connection (cred-swap). This is the ONLY role the
    // adversarial ops act as; forced RLS filters it.
    appDb = createTenantAppDb(adminUrl.replace("test:test", `${TENANT_APP_ROLE}:${APP_PW}`));
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[tenant-adversarial] embedded-postgres setup failed:", e);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}, 60_000);

function guard(): void {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
}

// Drive every adversarial op class for one seed's graph and return anomalies (must be
// empty) plus the op count. Assertions that would be noisy per-op are folded into the
// returned anomaly list; hard invariants (SQLSTATE identity) are asserted inline.
async function runAdversarialOps(g: TenantGraph): Promise<{ anomalies: string[]; ops: number }> {
  const anomalies: string[] = [];
  let ops = 0;
  const bump = (klass: OpClass): void => {
    opCounts[klass] += 1;
    ops += 1;
  };

  const platformWorkerIds = g.platformWorkers.map((w) => w.id);

  for (let actorIdx = 0; actorIdx < g.organizations.length; actorIdx += 1) {
    const actor = g.organizations[actorIdx]!;
    const corpus = buildHostileCorpus(g, actor.org.id);
    // The "victim" org = the next org (cyclic) — a concrete other tenant to write at.
    const victim = g.organizations[(actorIdx + 1) % g.organizations.length]!;
    const absentA = corpus.absentUuids[0]!;
    const absentB = corpus.absentUuids[1] ?? corpus.absentUuids[0]!;

    // ---- READ class: batched in ONE runInTenant(actor) (no error → tx survives) ----
    // Every cross-tenant id AND an absent id must both resolve to null / [], and be
    // INDISTINGUISHABLE (both null). RLS USING hides other-tenant rows exactly like
    // non-existent ones.
    await runInTenant(appDb, actor.org.id, async (repos) => {
      const check = async (
        label: string,
        crossIds: string[],
        getById: (id: string) => Promise<unknown>,
      ): Promise<void> => {
        // absent id → null (baseline for indistinguishability)
        const absentRes = await getById(absentA);
        bump("absentRead");
        if (absentRes !== null) anomalies.push(`${label}: absent id did not return null`);
        for (const id of crossIds) {
          const crossRes = await getById(id);
          bump("crossRead");
          if (crossRes !== null) anomalies.push(`${label}: cross-tenant id ${id} leaked a row`);
          // uniform denial: cross-tenant read is indistinguishable from an absent read.
          if (crossRes !== absentRes) {
            anomalies.push(`${label}: cross-tenant read distinguishable from absent read`);
          }
        }
      };

      await check("jobs", corpus.crossOrgJobIds, (id) => repos.jobs.getById(id));
      await check("attempts", corpus.crossOrgAttemptIds, (id) => repos.attempts.getById(id));
      await check("leases", corpus.crossOrgLeaseIds, (id) => repos.leases.getById(id));
      await check("services", corpus.crossOrgServiceIds, (id) => repos.services.getById(id));
      await check("serviceInstances", corpus.crossOrgServiceInstanceIds, (id) =>
        repos.serviceInstances.getById(id),
      );
      await check("jobArtifacts", corpus.crossOrgJobArtifactIds, (id) => repos.jobArtifacts.getById(id));
      await check("jobSecretHandles", corpus.crossOrgJobSecretHandleIds, (id) =>
        repos.jobSecretHandles.getById(id),
      );
      await check("workers", corpus.crossOrgWorkerIds, (id) => repos.workers.getById(id));

      // LIST class: listing another org's company / another org id returns [].
      for (const companyId of corpus.crossOrgCompanyIds) {
        const jl = await repos.jobs.listForCompany(companyId);
        bump("crossList");
        if (jl.length !== 0) anomalies.push(`jobs.listForCompany(${companyId}) leaked ${jl.length} rows`);
        const svc = await repos.services.listForCompany(companyId);
        bump("crossList");
        if (svc.length !== 0) anomalies.push(`services.listForCompany(${companyId}) leaked ${svc.length} rows`);
      }
      for (const orgId of corpus.crossOrgIds) {
        const wl = await repos.workers.listForOrganization(orgId);
        bump("crossList");
        if (wl.length !== 0) anomalies.push(`workers.listForOrganization(${orgId}) leaked ${wl.length} rows`);
      }
    });

    // ---- WRITE class: cross-tenant INSERT rejected by WITH CHECK (42501), and the
    // rejection is IDENTICAL whether or not the related row exists (no existence
    // disclosure). Each rejected insert poisons its transaction → its own runInTenant.
    const victimCompany = victim.companies[0]!.id; // a REAL company of the victim org
    const errRealCompany = await captureReject(() =>
      runInTenant(appDb, actor.org.id, (repos) =>
        repos.jobs.insert({ organizationId: victim.org.id, companyId: victimCompany }),
      ),
    );
    bump("crossInsertReject");
    const errAbsentCompany = await captureReject(() =>
      runInTenant(appDb, actor.org.id, (repos) =>
        repos.jobs.insert({ organizationId: victim.org.id, companyId: absentB }),
      ),
    );
    bump("crossInsertReject");
    // Uniform denial on WRITE: both are 42501 (RLS WITH CHECK fires before the
    // composite FK / not-found could differentiate) — the presence/absence of a
    // matching company is UNOBSERVABLE.
    expect(sqlstate(errRealCompany), "cross-insert (real victim company) SQLSTATE").toBe("42501");
    expect(sqlstate(errAbsentCompany), "cross-insert (absent company) SQLSTATE").toBe("42501");
    expect(sqlstate(errRealCompany)).toBe(sqlstate(errAbsentCompany));
    // No existence disclosure in the RAW DB error text: the deepest PostgresError
    // message is the RLS policy-violation text and is IDENTICAL whether or not the
    // referenced company exists (real vs absent) — the caller cannot tell the two
    // apart — and it never echoes a victim row's id/contents.
    const msgReal = pgDeepestMessage(errRealCompany) ?? "";
    const msgAbsent = pgDeepestMessage(errAbsentCompany) ?? "";
    if (!loggedErrShape) {
      loggedErrShape = true;
      // eslint-disable-next-line no-console
      console.log(
        `[tenant-adversarial] cross-insert DB message (real)="${msgReal}" (absent)="${msgAbsent}"`,
      );
    }
    if (msgReal !== msgAbsent) {
      anomalies.push(`cross-insert DB text differs real vs absent (existence disclosure): "${msgReal}" != "${msgAbsent}"`);
    }
    for (const [m, tag] of [
      [msgReal, "real"],
      [msgAbsent, "absent"],
    ] as const) {
      if (!/row-level security policy/i.test(m)) anomalies.push(`cross-insert (${tag}) is not an RLS denial: "${m}"`);
      if (m.includes(victimCompany) || m.includes(victim.jobs[0]!.id)) {
        anomalies.push(`cross-insert (${tag}) DB text disclosed a victim row id`);
      }
    }

    // UPDATE-to-another-org: take the actor's OWN visible row and try to move it to
    // the victim org → USING admits it, WITH CHECK on the new org rejects → 42501.
    const ownJobId = actor.jobs[0]!.id;
    const errUpdateOrg = await captureReject(() =>
      withTenantTx(appDb, actor.org.id, (tx) =>
        tx.execute(sql`UPDATE jobs SET organization_id = ${victim.org.id} WHERE id = ${ownJobId}`),
      ),
    );
    bump("updateToOtherOrgReject");
    expect(sqlstate(errUpdateOrg), "update-own-row-to-other-org SQLSTATE").toBe("42501");
    // The write-denial class is uniform: cross-insert and update-to-other-org share it.
    expect(sqlstate(errUpdateOrg)).toBe(sqlstate(errRealCompany));

    // ---- ORACLE AXIS (E2-F013 / E2-D09): the FK-identity existence oracle. An
    // OWN-org insert (organization_id = actor → RLS WITH CHECK PASSES) whose composite
    // PARENT id is (i) a CROSS-TENANT row (exists in another org) vs (ii) truly ABSENT
    // must fail with the SAME composite-FK constraint AND a byte-identical deepest DB
    // message — so the caller cannot learn whether a supplied uuid is a parent in
    // another tenant. Before the fix the two diverged (composite FK vs the redundant
    // single-column FK); the dropped single-column FKs (migration 0212) collapse them.
    const crossCompany = corpus.crossOrgCompanyIds[0]!; // a company that EXISTS in another org
    const crossJob = corpus.crossOrgJobIds[0]!; // a job that EXISTS in another org
    const checkUniformFkDenial = (
      label: string,
      expectedConstraint: string,
      crossErr: unknown,
      absentErr: unknown,
      crossParentId: string,
    ): void => {
      // both are FK violations (23503), NOT RLS (own-org insert clears WITH CHECK).
      if (sqlstate(crossErr) !== "23503") anomalies.push(`${label} oracle: cross not 23503 (${String(sqlstate(crossErr))})`);
      if (sqlstate(absentErr) !== "23503") anomalies.push(`${label} oracle: absent not 23503 (${String(sqlstate(absentErr))})`);
      // SAME constraint name — the discriminating single-column FK is gone.
      const cCon = pgField(crossErr, "constraint_name");
      const aCon = pgField(absentErr, "constraint_name");
      if (cCon !== expectedConstraint) anomalies.push(`${label} oracle: cross constraint ${String(cCon)} != ${expectedConstraint}`);
      if (aCon !== expectedConstraint) anomalies.push(`${label} oracle: absent constraint ${String(aCon)} != ${expectedConstraint}`);
      // Byte-identical deepest DB message (any leak of the parent id would break this).
      const cMsg = pgDeepestMessage(crossErr) ?? "";
      const aMsg = pgDeepestMessage(absentErr) ?? "";
      if (cMsg !== aMsg) anomalies.push(`${label} oracle: DB message differs cross vs absent (existence disclosure): "${cMsg}" != "${aMsg}"`);
      if (cMsg.includes(crossParentId)) anomalies.push(`${label} oracle: DB message echoed the cross parent id`);
      if (!loggedOracleShape) {
        loggedOracleShape = true;
        // eslint-disable-next-line no-console
        console.log(`[tenant-adversarial] ${label} oracle msg (cross)="${cMsg}" (absent)="${aMsg}" constraint=${String(cCon)}`);
      }
    };

    // jobs ← companies (own-org, cross-company vs absent-company)
    const oracleJobsCross = await captureReject(() =>
      runInTenant(appDb, actor.org.id, (repos) =>
        repos.jobs.insert({ organizationId: actor.org.id, companyId: crossCompany }),
      ),
    );
    bump("crossParentVsAbsentUniform");
    const oracleJobsAbsent = await captureReject(() =>
      runInTenant(appDb, actor.org.id, (repos) =>
        repos.jobs.insert({ organizationId: actor.org.id, companyId: absentA }),
      ),
    );
    bump("crossParentVsAbsentUniform");
    checkUniformFkDenial("jobs", "jobs_org_company_fk", oracleJobsCross, oracleJobsAbsent, crossCompany);

    // job_attempts ← jobs (own-org, cross-job vs absent-job)
    const oracleAttemptCross = await captureReject(() =>
      runInTenant(appDb, actor.org.id, (repos) =>
        repos.attempts.insert({
          organizationId: actor.org.id,
          companyId: actor.companies[0]!.id,
          jobId: crossJob,
        }),
      ),
    );
    bump("crossParentVsAbsentUniform");
    const oracleAttemptAbsent = await captureReject(() =>
      runInTenant(appDb, actor.org.id, (repos) =>
        repos.attempts.insert({
          organizationId: actor.org.id,
          companyId: actor.companies[0]!.id,
          jobId: absentB,
        }),
      ),
    );
    bump("crossParentVsAbsentUniform");
    checkUniformFkDenial("job_attempts", "job_attempts_org_job_fk", oracleAttemptCross, oracleAttemptAbsent, crossJob);

    // services ← companies (own-org, cross-company vs absent-company)
    const oracleServiceCross = await captureReject(() =>
      runInTenant(appDb, actor.org.id, (repos) =>
        repos.services.insert({ organizationId: actor.org.id, companyId: crossCompany }),
      ),
    );
    bump("crossParentVsAbsentUniform");
    const oracleServiceAbsent = await captureReject(() =>
      runInTenant(appDb, actor.org.id, (repos) =>
        repos.services.insert({ organizationId: actor.org.id, companyId: absentB }),
      ),
    );
    bump("crossParentVsAbsentUniform");
    checkUniformFkDenial("services", "services_org_company_fk", oracleServiceCross, oracleServiceAbsent, crossCompany);

    // ---- UPDATE/DELETE of a cross-tenant (or absent) row by id → 0 rows affected
    // (RLS USING hides it — indistinguishable from an absent id). No error → batch in
    // one withTenantTx; nothing is actually mutated (invisible rows never match).
    // ---- Also null-Org platform read (0) in the SAME context.
    await withTenantTx(appDb, actor.org.id, async (tx) => {
      for (const crossJobId of corpus.crossOrgJobIds.slice(0, 3)) {
        const updCross = rowsOf<{ id: string }>(
          await tx.execute(
            sql`UPDATE jobs SET status = 'cancel_requested' WHERE id = ${crossJobId} RETURNING id`,
          ),
        );
        bump("crossUpdateZero");
        if (updCross.length !== 0) anomalies.push(`UPDATE cross job ${crossJobId} affected ${updCross.length} rows`);
        const delCross = rowsOf<{ id: string }>(
          await tx.execute(sql`DELETE FROM jobs WHERE id = ${crossJobId} RETURNING id`),
        );
        bump("crossDeleteZero");
        if (delCross.length !== 0) anomalies.push(`DELETE cross job ${crossJobId} affected ${delCross.length} rows`);
      }
      // absent id: SAME 0-row outcome — update/delete of a cross-tenant row is
      // indistinguishable from update/delete of a non-existent row.
      const updAbsent = rowsOf<{ id: string }>(
        await tx.execute(sql`UPDATE jobs SET status = 'cancel_requested' WHERE id = ${absentA} RETURNING id`),
      );
      bump("crossUpdateZero");
      if (updAbsent.length !== 0) anomalies.push("UPDATE absent job affected rows");
      const delAbsent = rowsOf<{ id: string }>(
        await tx.execute(sql`DELETE FROM jobs WHERE id = ${absentA} RETURNING id`),
      );
      bump("crossDeleteZero");
      if (delAbsent.length !== 0) anomalies.push("DELETE absent job affected rows");

      // null-Org platform workers: invisible to every tenant GUC.
      const nullByFilter = count(
        await tx.execute(sql`SELECT count(*)::int AS c FROM workers WHERE organization_id IS NULL`),
      );
      bump("nullOrgReadZero");
      if (nullByFilter !== 0) anomalies.push(`tenant GUC saw ${nullByFilter} null-Org workers`);
      for (const pwId of platformWorkerIds) {
        const byId = count(await tx.execute(sql`SELECT count(*)::int AS c FROM workers WHERE id = ${pwId}`));
        bump("nullOrgReadZero");
        if (byId !== 0) anomalies.push(`tenant GUC saw platform worker ${pwId} by id`);
      }
    });

    // null-Org WRITE: aoa_app cannot INSERT a worker to org NULL (WITH CHECK 42501)…
    const errNullInsert = await captureReject(() =>
      withTenantTx(appDb, actor.org.id, (tx) =>
        tx.execute(sql`INSERT INTO workers
          (scope, organization_id, label, execution_target_id, target_authority_key,
           device_generation, device_public_key, device_thumbprint, profile_hash, enrolled_at)
          VALUES ('platform', NULL, 'sneak', ${platformWorkerIds[0]}, 'platform',
            1, 'adversarial-sneak-key', ${"1".repeat(64)}, ${"2".repeat(64)}, now())`),
      ),
    );
    bump("nullOrgWriteReject");
    expect(sqlstate(errNullInsert), "null-Org worker INSERT SQLSTATE").toBe("42501");
    // …nor UPDATE an owned worker to org NULL (WITH CHECK on the new null-Org row).
    const ownWorkerId = actor.workers[0]!.id;
    const errNullUpdate = await captureReject(() =>
      withTenantTx(appDb, actor.org.id, (tx) =>
        tx.execute(
          sql`UPDATE workers SET organization_id = NULL, scope = 'platform',
            execution_target_id = ${platformWorkerIds[0]}, target_authority_key = 'platform'
            WHERE id = ${ownWorkerId}`,
        ),
      ),
    );
    bump("nullOrgWriteReject");
    expect(sqlstate(errNullUpdate), "null-Org worker UPDATE SQLSTATE").toBe("42501");
  }

  // ---- composite_sql surface: DIRECT SQL (as the superuser, bypassing every app
  // check AND RLS) that constructs a mixed-tenant relationship is still rejected by
  // the TEN-004 composite FKs (23503). Reuse two TEN-004 cases across two real orgs.
  if (g.organizations.length >= 2) {
    const [oa, ob] = [g.organizations[0]!, g.organizations[1]!];
    const jobAErr = await captureReject(() =>
      db.execute(sql`INSERT INTO jobs (organization_id, company_id) VALUES (${oa.org.id}, ${ob.companies[0]!.id})`),
    );
    bump("compositeSqlReject");
    expect(sqlstate(jobAErr), "mixed-tenant job composite-FK SQLSTATE").toBe("23503");
    if (pgField(jobAErr, "constraint_name") !== "jobs_org_company_fk") {
      anomalies.push(`mixed-tenant job rejected by ${String(pgField(jobAErr, "constraint_name"))}, expected jobs_org_company_fk`);
    }
    const attemptErr = await captureReject(() =>
      db.execute(sql`INSERT INTO job_attempts (organization_id, company_id, job_id) VALUES (${ob.org.id}, ${oa.jobs[0]!.companyId}, ${oa.jobs[0]!.id})`),
    );
    bump("compositeSqlReject");
    expect(sqlstate(attemptErr), "mixed-tenant attempt composite-FK SQLSTATE").toBe("23503");
    if (pgField(attemptErr, "constraint_name") !== "job_attempts_org_job_fk") {
      anomalies.push(
        `mixed-tenant attempt rejected by ${String(pgField(attemptErr, "constraint_name"))}, expected job_attempts_org_job_fk`,
      );
    }
  }

  return { anomalies, ops };
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "TEN-005 tenant adversarial property suite (H-01, E2-available surfaces)",
  () => {
    it("the serving connection is a NON-OWNER role (else the whole suite is vacuous)", async () => {
      guard();
      // If appDb were the superuser, RLS would be bypassed and every null/0-row
      // assertion below would be vacuously true. Prove it is NOT.
      await expect(assertNonOwnerConnection(appDb)).resolves.toBeUndefined();
      await expect(assertNonOwnerConnection(db)).rejects.toThrow(/privileged role/i);
    });

    it("every seed's graph is non-trivial (≥2 orgs, non-empty hostile corpus) — the suite is NOT vacuous", () => {
      guard();
      for (const seed of TENANT_ADVERSARIAL_SEEDS) {
        const g = generateTenantGraph(seed);
        expect(g.organizations.length, `seed ${seed} org count`).toBeGreaterThanOrEqual(2);
        const corpus = buildHostileCorpus(g, g.organizations[0]!.org.id);
        expect(corpus.crossOrgJobIds.length, `seed ${seed} cross-org job ids`).toBeGreaterThan(0);
        expect(corpus.crossOrgIds.length, `seed ${seed} cross-org ids`).toBeGreaterThan(0);
      }
    });

    // The core H-01 proof: one it() per seed keeps the reporter readable and pins the
    // seed in the test name for reproducibility.
    for (const seed of TENANT_ADVERSARIAL_SEEDS) {
      it(`fails closed with no existence disclosure across all E2 surfaces for seed=${seed}`, async () => {
        guard();
        const g = generateTenantGraph(seed);
        await seedGraph(g);
        const { anomalies, ops } = await runAdversarialOps(g);
        perSeedOpCounts[seed] = ops;
        // Zero cross-tenant leaks / zero existence disclosures for this seed.
        expect(anomalies, `seed ${seed} anomalies: ${anomalies.slice(0, 8).join(" | ")}`).toEqual([]);
        // Non-vacuous: this seed genuinely issued many cross-tenant attempts.
        expect(ops, `seed ${seed} op count`).toBeGreaterThanOrEqual(100);
      }, 120_000);
    }

    it("recorded every op class at least once and hundreds of ops per seed (non-vacuous)", () => {
      guard();
      // At least one op per class actually ran (RED-proof against a vacuous harness).
      for (const [klass, n] of Object.entries(opCounts)) {
        expect(n, `op class ${klass} ran at least once`).toBeGreaterThan(0);
      }
      // Every seed drove ≥100 ops; total is in the thousands.
      for (const seed of TENANT_ADVERSARIAL_SEEDS) {
        expect(perSeedOpCounts[seed], `seed ${seed} ops`).toBeGreaterThanOrEqual(100);
      }
      const total = Object.values(opCounts).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(TENANT_ADVERSARIAL_SEEDS.length * 100);
      // eslint-disable-next-line no-console
      console.log(
        `[tenant-adversarial] seeds=${JSON.stringify(TENANT_ADVERSARIAL_SEEDS)} totalOps=${total} ` +
          `perClass=${JSON.stringify(opCounts)} perSeed=${JSON.stringify(perSeedOpCounts)}`,
      );
    });
  },
);
