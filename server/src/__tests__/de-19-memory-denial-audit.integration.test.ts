/**
 * DE-19, audit clause — a refused memory read is durably distinguishable from a
 * read that never happened.
 *
 * ★ WHAT THIS TEST IS FOR. `docs/architecture/distributed-execution-threat-controls.json`
 * DE-19 asserts "context retrieval and denials are recorded in the retrieval
 * audit". Before this test, HALF of that clause held: `recordMemoryRetrievals`
 * runs at `read-tools.ts` AFTER the gate, so a SUCCESSFUL read writes a durable
 * `memory_retrievals` row — and both deny returns sat BEFORE it, so a REFUSED
 * read wrote nothing at all. A cross-department probe and a request that was
 * never made produced byte-identical durable state: nothing. That is the gap
 * `E0-F013` filed for DE-19, and closing it is what this file proves.
 *
 * ★ WHY THIS IS NOT A READ-BACK. A read-back test writes a record and reads it
 * back; it verifies what was DECLARED, never what is ENFORCED (the measured
 * lesson of DE-08, which was accepted, validated, stored and echoed back exactly
 * while enforcing nothing). This test never constructs a denial. It PROVOKES the
 * real refusal through the real handler — agent A, scoped to department A, asks
 * `memory.get` for a row scoped only to a goal that belongs to department B — and
 * then asserts the durable row that the refusal itself left behind.
 *
 * ★ ATTRIBUTION IS THE ASSERTION. A record that says "something was denied" does
 * not satisfy a crossing that asserts denials are ATTRIBUTABLE. Every one of the
 * four questions is asserted separately here:
 *   WHO      -> actorType/actorId is the refused agent, not "system"
 *   TENANT   -> companyId is the company the refusal happened in
 *   RESOURCE -> entityType/entityId is the memory item that was refused
 *   WHY      -> details.reason is a stable machine code, and the two reachable
 *               reasons are told APART (`not_visible` vs `not_approved`)
 *
 * ★ POSITIVE CONTROLS, three of them, because "always write a denial row" must
 * fail this file:
 *   1. Agent B (who owns the goal) reads the SAME row successfully and NO denial
 *      row is written for it.
 *   2. That same success still writes the `memory_retrievals` row it always
 *      wrote — the success audit is not collateral damage of the denial audit.
 *   3. The two refusals carry DIFFERENT reason codes, so the writer is reading
 *      the real branch rather than stamping a constant.
 *
 * ★ THE CROSS-TENANT ARM PINS THE ARGUMENT, not just the outcome. A
 * cross-department refusal does not need the tenant GUC to be wrong, so the arms
 * above would all stay GREEN if `activity_log` were folded into the tenant RLS
 * kernel — while the reason the storage choice was made ("a denial can be
 * recorded even when the org GUC is exactly what is wrong") silently stopped
 * holding. The final four arms therefore probe ACROSS ORGANIZATIONS — the unit
 * `aoa.organization_id` keys on — and then assert the storage posture itself:
 * `activity_log` not RLS-enabled, not forced, no policies, no `organization_id`
 * column, against a positive control that the kernel IS present and forced on
 * eight sibling tables. Move the table into the kernel and this file goes red
 * naming the change.
 *
 * ★ NON-DISCLOSURE IS PRESERVED, and that is asserted too. Both refusals return
 * the identical opaque message "Memory item not found". The audit row is where
 * the distinction lives; the caller still learns nothing. A test that let the
 * reason leak into the response would be closing an audit gap by opening a
 * disclosure one.
 *
 * Real Postgres (embedded-postgres + the committed migration chain), the real
 * `readToolHandlers["memory.get"]`, the real `actorForMcp` ->
 * `memoryAccessConditions` -> gated fetch -> `filterMemoryForActor` chain. No
 * stubs on the gate and none on the writer.
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI `push` is the authoritative gate. On
 * a Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real. Harness
 * modeled on mcp-memory-read-rbac.integration.test.ts (P1-T5).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { memoryService } from "../services/memory.js";
import { readToolHandlers } from "../mcp/tools/read-tools.js";
import type { ToolContext, ToolResult, ToolServices } from "../mcp/tools/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

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

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
let setupFailed = false;

function assertSetupOk(): void {
  const dbReady = (db as Db | undefined) !== undefined;
  if (!setupFailed && dbReady) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as { id: string })?.id;
  return (result as { rows?: { id: string }[] }).rows?.[0]?.id;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

let co = "";
let deptA = "";
let deptB = "";
let agA = "";
let agB = "";
let gB = "";
/** Approved, scoped ONLY to goal gB (department B) — invisible to agent A. */
let crossDeptRowId = "";
/** Draft, scoped to department A — visible to agent A's SQL gate, not approved. */
let draftRowId = "";
/** A SECOND tenant: its own `organizations` row — the unit the RLS kernel keys on. */
let orgB = "";
let coB = "";
/**
 * Approved, `identity` layer, `company` visibility, owned by tenant B. Deliberately
 * a row that agent A would be ALLOWED to read if it were in the same tenant, so the
 * ONLY thing refusing this read is the tenant boundary itself.
 */
let crossTenantRowId = "";

async function insertMemory(opts: {
  title: string;
  layer: string;
  visibility: string;
  status: string;
  departmentId?: string | null;
  goalId?: string | null;
}): Promise<string> {
  return firstId(
    await db.execute<{ id: string }>(sql`
      INSERT INTO memory_items
        (id, company_id, title, content, category, source, status, created_by,
         layer, visibility, department_id, goal_id)
      VALUES
        (gen_random_uuid(), ${co}, ${opts.title}, ${`body of ${opts.title}`}, 'reference',
         'founder', ${opts.status}, 'integration-test',
         ${opts.layer}, ${opts.visibility},
         ${opts.departmentId ?? null}, ${opts.goalId ?? null})
      RETURNING id`),
  );
}

function ctxForAgent(agentId: string): ToolContext {
  return {
    db,
    companyId: co,
    actor: { userId: agentId, companyId: co, keyId: null, source: "agent", agentId, runId: null },
    scope: { kind: "scoped", userId: agentId, projectIds: new Set<string>() },
    services: { memorySvc: memoryService(db) } as unknown as ToolServices,
    actorInfo: {} as ToolContext["actorInfo"],
    resolveRole: async () => "team_member",
    resolveScopedAgentIds: async () => null,
  };
}

const memoryGet = (agentId: string, id: string): Promise<ToolResult> =>
  readToolHandlers["memory.get"](ctxForAgent(agentId), { id });

interface DenialRow {
  company_id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown> | null;
}

/** Every `security.denied.*` activity row for one memory item, newest last. */
async function denialRowsFor(entityId: string): Promise<DenialRow[]> {
  return rowsOf<DenialRow>(
    await db.execute(sql`
      SELECT company_id, actor_type, actor_id, action, entity_type, entity_id, details
      FROM activity_log
      WHERE action LIKE 'security.denied.%' AND entity_id = ${entityId}
      ORDER BY created_at ASC`),
  );
}

async function retrievalCountFor(itemId: string): Promise<number> {
  const rows = rowsOf<{ n: string }>(
    await db.execute(sql`SELECT count(*)::text AS n FROM memory_retrievals WHERE item_id = ${itemId}`),
  );
  return Number(rows[0]?.n ?? "0");
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-de19-denial-"));
    const port = await allocateEmbeddedPgPort();
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
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
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[de19-denial] embedded-postgres setup failed:", err);
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

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "DE-19 audit clause — a refused memory read leaves an attributable durable record",
  () => {
    it("setup: company, two departments, two agents, a goal in dept B, one cross-dept approved row and one in-scope draft row", async () => {
      assertSetupOk();

      co = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (organization_id, id, name)
          VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'DE-19 Denial Co')
          RETURNING id`),
      );
      deptA = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO projects (id, company_id, name, type)
          VALUES (gen_random_uuid(), ${co}, 'Alpha', 'department') RETURNING id`),
      );
      deptB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO projects (id, company_id, name, type)
          VALUES (gen_random_uuid(), ${co}, 'Beta', 'department') RETURNING id`),
      );
      agA = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO agents (id, company_id, name, kind, status)
          VALUES (gen_random_uuid(), ${co}, 'Agent A', 'org', 'idle') RETURNING id`),
      );
      agB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO agents (id, company_id, name, kind, status)
          VALUES (gen_random_uuid(), ${co}, 'Agent B', 'org', 'idle') RETURNING id`),
      );
      await db.execute(sql`
        INSERT INTO agent_projects (agent_id, project_id, company_id) VALUES (${agA}, ${deptA}, ${co})`);
      await db.execute(sql`
        INSERT INTO agent_projects (agent_id, project_id, company_id) VALUES (${agB}, ${deptB}, ${co})`);

      gB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO goals (id, company_id, title)
          VALUES (gen_random_uuid(), ${co}, 'Goal B') RETURNING id`),
      );
      await db.execute(sql`
        INSERT INTO project_goals (project_id, goal_id, company_id) VALUES (${deptB}, ${gB}, ${co})`);

      crossDeptRowId = await insertMemory({
        title: "Beta goal secret",
        layer: "active_context",
        visibility: "scoped",
        status: "approved",
        goalId: gB,
      });
      draftRowId = await insertMemory({
        title: "Alpha unapproved draft",
        layer: "domain",
        visibility: "scoped",
        status: "draft",
        departmentId: deptA,
      });

      expect(co && deptA && deptB && agA && agB && gB && crossDeptRowId && draftRowId).toBeTruthy();
      // Nothing has been refused yet, so nothing may have been recorded yet.
      expect(await denialRowsFor(crossDeptRowId)).toHaveLength(0);
      expect(await denialRowsFor(draftRowId)).toHaveLength(0);
    });

    it("PROVOKE — agent A (dept A) is refused the dept-B goal-scoped row, and the refusal is non-disclosing", async () => {
      assertSetupOk();
      const res = await memoryGet(agA, crossDeptRowId);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toBe("Memory item not found");
    });

    it("★ THE CLAUSE — that refusal wrote ONE durable row, and it attributes WHO / TENANT / RESOURCE / WHY", async () => {
      assertSetupOk();
      const rows = await denialRowsFor(crossDeptRowId);
      expect(rows).toHaveLength(1);
      const row = rows[0];

      // WHO — the refused agent, not "system", not the empty string.
      expect(row.actor_type).toBe("agent");
      expect(row.actor_id).toBe(agA);
      // TENANT — the company the refusal happened in.
      expect(row.company_id).toBe(co);
      // RESOURCE — the memory item that was refused.
      expect(row.entity_type).toBe("memory_item");
      expect(row.entity_id).toBe(crossDeptRowId);
      // WHY — a stable machine code, plus the crossing and the control that refused.
      expect(row.action).toBe("security.denied.memory_read");
      expect(row.details?.reason).toBe("not_visible");
      expect(row.details?.crossing).toBe("DE-19");
      expect(String(row.details?.control)).toContain("read-tools.ts");
      // The agent identity is recoverable from the detail payload too, so a row
      // whose actorId convention later changes is still attributable.
      expect(row.details?.agentId).toBe(agA);
    });

    it("★ REASON IS READ FROM THE BRANCH, NOT STAMPED — an in-scope but unapproved row records a DIFFERENT reason behind the SAME opaque message", async () => {
      assertSetupOk();
      const res = await memoryGet(agA, draftRowId);
      expect(res.ok).toBe(false);
      // Identical response text: the caller still cannot tell the two apart.
      if (!res.ok) expect(res.message).toBe("Memory item not found");

      const rows = await denialRowsFor(draftRowId);
      expect(rows).toHaveLength(1);
      expect(rows[0].details?.reason).toBe("not_approved");
      expect(rows[0].actor_id).toBe(agA);
      // ...and the audit CAN. This is the whole point of the record.
      expect(rows[0].details?.reason).not.toBe("not_visible");
    });

    it("POSITIVE CONTROL — agent B (owns the goal) reads the SAME row and NO denial row is written", async () => {
      assertSetupOk();
      const before = await denialRowsFor(crossDeptRowId);
      const res = await memoryGet(agB, crossDeptRowId);
      expect(res.ok).toBe(true);
      if (res.ok) expect((res.data as { id: string }).id).toBe(crossDeptRowId);

      const after = await denialRowsFor(crossDeptRowId);
      // Unchanged: a success must not manufacture a denial. Without this,
      // "write a denial row unconditionally" would pass every test above.
      expect(after).toHaveLength(before.length);
      // ...and specifically nothing attributed to agent B.
      expect(after.some((r) => r.actor_id === agB)).toBe(false);
    });

    it("POSITIVE CONTROL — that success still writes the memory_retrievals row it always wrote (the success audit is not collateral damage)", async () => {
      assertSetupOk();
      // recordMemoryRetrievals is fire-and-forget (`void`), so allow it to land.
      const deadline = Date.now() + 5_000;
      let n = 0;
      while (Date.now() < deadline) {
        n = await retrievalCountFor(crossDeptRowId);
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(n).toBe(1);
    });

    it("POSITIVE CONTROL — the two refusals are told apart in the durable record", async () => {
      assertSetupOk();
      const reasons = [
        ...(await denialRowsFor(crossDeptRowId)),
        ...(await denialRowsFor(draftRowId)),
      ].map((r) => r.details?.reason);
      expect(new Set(reasons).size).toBe(2);
    });

    // ───────────────────────────────────────────────────────────────────────
    // ★ THE CROSS-TENANT ARM — the case the storage choice was actually argued on.
    //
    // Everything above provokes a cross-DEPARTMENT refusal, and a cross-department
    // refusal does not need the tenant GUC to be wrong. But the reason
    // `security-denial-audit.ts` writes to `activity_log` instead of to a new,
    // RLS-forced table is a claim about the CROSS-TENANT case: "a denial can be
    // recorded even when the org GUC is exactly what is wrong". Without the arms
    // below, that claim was proved nowhere — if `activity_log` were later folded
    // into the tenant RLS kernel, every other test in this file would stay GREEN
    // while the mechanism the design rests on silently broke.
    // ───────────────────────────────────────────────────────────────────────

    it("setup: a SECOND tenant — its own organization, its own company, and an approved memory item owned by it", async () => {
      assertSetupOk();

      orgB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO organizations (id, name, slug, status, plan)
          VALUES (gen_random_uuid(), 'DE-19 Tenant B', 'de19-tenant-b', 'active', 'beta')
          RETURNING id`),
      );
      coB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (organization_id, id, name, issue_prefix)
          VALUES (${orgB}, gen_random_uuid(), 'DE-19 Other Tenant Co', 'TNB')
          RETURNING id`),
      );
      // identity + company visibility: a row agent A would be ALLOWED to read if it
      // shared the tenant (Decision #118 grants agents the identity layer). So the
      // refusal below isolates the tenant boundary and nothing else.
      crossTenantRowId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO memory_items
            (id, company_id, title, content, category, source, status, created_by,
             layer, visibility)
          VALUES
            (gen_random_uuid(), ${coB}, 'Tenant B identity', 'body of Tenant B identity',
             'reference', 'founder', 'approved', 'integration-test', 'identity', 'company')
          RETURNING id`),
      );

      // The two sides are distinct at the level the kernel keys on (`aoa.organization_id`),
      // not merely two companies inside one organization.
      const orgOfA = rowsOf<{ organization_id: string }>(
        await db.execute(sql`SELECT organization_id FROM companies WHERE id = ${co}`),
      )[0];
      expect(orgOfA?.organization_id).toBeTruthy();
      expect(orgOfA.organization_id).not.toBe(orgB);
      expect(await denialRowsFor(crossTenantRowId)).toHaveLength(0);
    });

    it("PROVOKE — an agent in tenant A asks for tenant B's memory item and is refused, non-disclosingly", async () => {
      assertSetupOk();
      const res = await memoryGet(agA, crossTenantRowId);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toBe("Memory item not found");
    });

    it("★ THE CROSS-TENANT CLAUSE — that refusal is durable and attributable, and it lands in the REFUSING tenant, not the probed one", async () => {
      assertSetupOk();
      const rows = await denialRowsFor(crossTenantRowId);
      expect(rows).toHaveLength(1);
      const row = rows[0];

      // WHO — the probing agent.
      expect(row.actor_type).toBe("agent");
      expect(row.actor_id).toBe(agA);
      // TENANT — the tenant that REFUSED. Writing it into the probed tenant would
      // turn the audit record into the disclosure channel it exists to avoid.
      expect(row.company_id).toBe(co);
      expect(row.company_id).not.toBe(coB);
      // RESOURCE — and the resource genuinely belongs to the other tenant, so this
      // is a cross-tenant probe and not a mislabelled in-tenant one.
      expect(row.entity_type).toBe("memory_item");
      expect(row.entity_id).toBe(crossTenantRowId);
      const owner = rowsOf<{ company_id: string }>(
        await db.execute(sql`SELECT company_id FROM memory_items WHERE id = ${crossTenantRowId}`),
      )[0];
      expect(owner.company_id).toBe(coB);
      // WHY.
      expect(row.action).toBe("security.denied.memory_read");
      expect(row.details?.reason).toBe("not_visible");
      expect(row.details?.crossing).toBe("DE-19");

      // The probed tenant's own audit stream learns nothing at all about the probe.
      const probed = rowsOf<{ n: string }>(
        await db.execute(sql`SELECT count(*)::text AS n FROM activity_log WHERE company_id = ${coB}`),
      );
      expect(Number(probed[0]?.n ?? "-1")).toBe(0);
    });

    it("★ THE ARGUMENT, PINNED — the write above is possible ONLY because activity_log sits outside the tenant RLS kernel", async () => {
      assertSetupOk();

      // If `activity_log` is ever moved into the kernel it acquires exactly these
      // four properties, and each one is asserted separately so the failure NAMES
      // the change rather than surfacing as "the denial row is missing".
      const posture = rowsOf<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        policies: string;
        org_col: string;
      }>(
        await db.execute(sql`
          SELECT c.relrowsecurity,
                 c.relforcerowsecurity,
                 (SELECT count(*)::text FROM pg_policies p
                   WHERE p.schemaname = 'public' AND p.tablename = 'activity_log') AS policies,
                 (SELECT count(*)::text FROM information_schema.columns col
                   WHERE col.table_schema = 'public'
                     AND col.table_name = 'activity_log'
                     AND col.column_name = 'organization_id') AS org_col
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'activity_log'`),
      )[0];
      expect(posture, "activity_log must exist").toBeTruthy();
      expect(
        posture.relrowsecurity,
        "activity_log has ENABLE ROW LEVEL SECURITY — it has been moved into the tenant kernel, and a denial whose org GUC is wrong can no longer be recorded (see security-denial-audit.ts, 'WHY activity_log AND NOT A NEW TABLE')",
      ).toBe(false);
      expect(
        posture.relforcerowsecurity,
        "activity_log has FORCE ROW LEVEL SECURITY — same consequence: the denial recorder now lives behind the policy it exists to observe",
      ).toBe(false);
      expect(
        posture.policies,
        "activity_log has row-level policies — the denial write is now conditional on the very tenant context the cross-tenant case has wrong",
      ).toBe("0");
      // ★ AMENDED 2026-09-09 — E0-F013 Decision 2, ruled option (a2).
      //
      // This assertion used to read `.toBe("0")`: the ABSENCE of an
      // `organization_id` column stood in as a proxy for "activity_log is not a
      // kernel table". The founder ruling ADDS that column deliberately, so the
      // proxy is now false while the property it stood for is unchanged — and a
      // proxy that has come apart from its property must be replaced, not
      // deleted and not merely relaxed to accept both readings.
      //
      // What actually made the proxy work was never the column's existence. It
      // was that a kernel table's tenant key is NOT NULL and is READ BY A
      // POLICY: `jobs.organization_id` is `notNull()` and
      // `0211_tenant_rls_enforcement.sql:20-28` gates every row on
      // `organization_id = current_setting('aoa.organization_id')`. Both halves
      // of that are asserted directly now:
      //   - the policy half by `posture.policies === "0"` immediately above —
      //     a column no policy reads cannot gate a write;
      //   - the NOT NULL half here. A NULLABLE attribution column records who
      //     was refused when a company cannot be resolved; a NOT NULL one would
      //     mean a cross-tenant denial with no resolvable organization can no
      //     longer be written at all, which is precisely the failure the proxy
      //     was watching for.
      expect(
        posture.org_col,
        "activity_log lost its organization_id column — E0-F013 Decision 2 (a2) requires it, and without it every organization-only denial (DE-03, DE-15, five of DE-06's six fence throws) becomes unattributable again",
      ).toBe("1");
      const orgColumnNullable = rowsOf<{ is_nullable: string }>(
        await db.execute(sql`
          SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'activity_log'
            AND column_name = 'organization_id'`),
      )[0];
      expect(
        orgColumnNullable?.is_nullable,
        "activity_log.organization_id became NOT NULL — that is the kernel shape, and a denial that resolves NEITHER tenant axis (worker-enrollment.ts:295 and :315) can no longer be recorded at all",
      ).toBe("YES");
      // The same reasoning applies to the column the recorder writes when it DOES
      // resolve a tenant: it must stay nullable, or the ruling is undone.
      const companyColumnNullable = rowsOf<{ is_nullable: string }>(
        await db.execute(sql`
          SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'activity_log'
            AND column_name = 'company_id'`),
      )[0];
      expect(
        companyColumnNullable?.is_nullable,
        "activity_log.company_id went back to NOT NULL — the tenantless denial sink is gone",
      ).toBe("YES");

      // POSITIVE CONTROL for the assertion itself. Four `false`/`0` readings are
      // also what a database with no RLS at all would report, so prove the kernel
      // really is present and forced on this database — otherwise the assertion
      // above passes vacuously and pins nothing.
      const forced = rowsOf<{ relname: string }>(
        await db.execute(sql`
          SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
          ORDER BY c.relname`),
      );
      expect(
        forced.length,
        "no table on this database is FORCE-RLS, so the contrast this test asserts is meaningless here",
      ).toBeGreaterThan(0);
      expect(forced.map((r) => r.relname)).toContain("jobs");
    });
  },
);
