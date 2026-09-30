/**
 * P1-T7 — cross-scope memory-RBAC leakage gate (the release gate).
 *
 * Proves, against a REAL Postgres (embedded-postgres + the committed migration
 * chain, incl. 0187's P0 ownership/invalidation columns), that the run-path RBAC
 * gate holds at the ROW level: an agent scoped to department A can retrieve its
 * own department's memory, company-wide identity/company-visibility memory, and
 * its own agent-private memory — and CANNOT retrieve another department's scoped
 * memory, another agent's private memory, a goal-scoped row whose goal belongs to
 * another department, or an invalidated row. Any ABSENT title that appears IS a
 * real cross-scope leak — a Critical failure, not a flaky test.
 *
 * The gate under test is the exact production composition used by the ORG and CREW
 * run paths (P1-T2/T3/T4):
 *   actor            = actorForAgentRun(db, companyId, agentId)
 *   accessConditions = memoryAccessConditions(db, actor)   // in-SQL, pre-ranking
 *   raw              = searchMultiPath(companyId, q, { accessConditions })
 *   visible          = filterMemoryForActor(raw, actor)    // post-fetch safety net
 * The last block re-runs searchMultiPath WITHOUT accessConditions and shows the
 * dept-B row DOES come back — so the gate is meaningfully filtering, not vacuously
 * returning an empty set.
 *
 * Skipped on Windows CI by default (the `runneradmin` account can't start
 * embedded-postgres — Issue #114); Linux CI `push` is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real — the UTF-8
 * initdbFlags below make the cluster locale-safe. Harness modeled on
 * d18-autonomy-dial-split.integration.test.ts / crew-org-scope.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { memoryService } from "../services/memory.js";
import { actorForAgentRun, memoryAccessConditions } from "../services/memory-access-sql.js";
import { filterMemoryForActor, type MemoryActor } from "../services/memory-access.js";
import { buildCrewContextBundle } from "../services/internal-agent/aoa-agents/crew-context-bundle.js";
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

/**
 * Fail LOUDLY and ONCE when embedded-postgres never came up. A boolean guard is
 * used because embedded-postgres can reject with `undefined` (falsy), which would
 * make a bare `if (setupError) throw` silently no-op and let every case run against
 * an unassigned `db` — a wall of "Cannot read properties of undefined" that reads
 * like a product bug instead of a setup failure.
 */
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

// Company + scope ids, resolved in the setup case and reused by the gate cases.
let co = "";
let deptA = "";
let deptB = "";
let projP = "";
let agA = "";
let agB = "";
let gB = "";

/** Insert one approved memory row with an explicit scope. Unused scope columns → NULL. */
async function insertMemory(opts: {
  title: string;
  layer: string;
  visibility: string;
  departmentId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  agentId?: string | null;
  invalidated?: boolean;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO memory_items
      (id, company_id, title, content, category, source, status, created_by,
       layer, visibility, department_id, project_id, goal_id, agent_id, invalidated_at)
    VALUES
      (gen_random_uuid(), ${co}, ${opts.title}, ${`body of ${opts.title}`}, 'reference',
       'founder', 'approved', 'integration-test',
       ${opts.layer}, ${opts.visibility},
       ${opts.departmentId ?? null}, ${opts.projectId ?? null}, ${opts.goalId ?? null},
       ${opts.agentId ?? null}, ${opts.invalidated ? sql`now()` : sql`NULL`})
  `);
}

/** The production retrieval composition: actor → in-SQL gate → search → safety net. */
async function visibleTitlesForAgent(agentId: string): Promise<Set<string>> {
  const actor = await actorForAgentRun(db, co, agentId);
  return visibleTitlesForActor(actor);
}

/** Same production composition (in-SQL gate → search → safety net) for any actor. */
async function visibleTitlesForActor(actor: MemoryActor): Promise<Set<string>> {
  const accessConditions = memoryAccessConditions(db, actor);
  const raw = await memoryService(db).searchMultiPath(co, "", { accessConditions, limit: 100 });
  return new Set(filterMemoryForActor(raw, actor).map((r) => r.title));
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mem-rbac-leak-"));
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
      // Force UTF-8 so migration SQL applies on a Windows dev box (initdb would
      // otherwise inherit WIN1252).
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
    console.error("[mem-rbac-leakage] embedded-postgres setup failed:", err);
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
  "memory RBAC cross-scope leakage — release gate (P1-T7)",
  () => {
    it("setup: seeds a company, two departments (+ a project under B), two agents, and 8 multi-scope rows", async () => {
      assertSetupOk();

      co = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (organization_id, id, name) VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Leak Co') RETURNING id`),
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
      // A project-type scope under dept B that agent A is NOT assigned to — negative
      // space that proves the actor resolver stays dept-A-only (asserted below).
      projP = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO projects (id, company_id, name, type)
          VALUES (gen_random_uuid(), ${co}, 'Beta Project', 'project') RETURNING id`),
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
      // agent A assigned to dept A ONLY; agent B to dept B ONLY.
      await db.execute(sql`
        INSERT INTO agent_projects (agent_id, project_id, company_id) VALUES (${agA}, ${deptA}, ${co})`);
      await db.execute(sql`
        INSERT INTO agent_projects (agent_id, project_id, company_id) VALUES (${agB}, ${deptB}, ${co})`);

      // A goal that belongs to dept B (via the project_goals junction; the goals
      // table has no projectId column). Item (7) is scoped to this goal only.
      gB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO goals (id, company_id, title)
          VALUES (gen_random_uuid(), ${co}, 'Goal B') RETURNING id`),
      );
      await db.execute(sql`
        INSERT INTO project_goals (project_id, goal_id, company_id) VALUES (${deptB}, ${gB}, ${co})`);

      // (1) dept-A scoped     → agent A: VISIBLE
      await insertMemory({ title: "Alpha domain (deptA)", layer: "domain", visibility: "scoped", departmentId: deptA });
      // (2) dept-B scoped     → agent A: LEAK if visible
      await insertMemory({ title: "Beta domain (deptB)", layer: "domain", visibility: "scoped", departmentId: deptB });
      // (3) identity          → everyone: VISIBLE
      await insertMemory({ title: "Company identity", layer: "identity", visibility: "scoped" });
      // (4) company visibility → everyone: VISIBLE
      await insertMemory({ title: "Company-wide note", layer: "domain", visibility: "company" });
      // (5) agent-B private    → agent A: LEAK if visible
      await insertMemory({ title: "Agent B private", layer: "working", visibility: "scoped", agentId: agB });
      // (6) agent-A private    → agent A: VISIBLE (its own)
      await insertMemory({ title: "Agent A private", layer: "working", visibility: "scoped", agentId: agA });
      // (7) goal-scoped to gB (dept B) → agent A: LEAK if visible (goal→project resolves to dept B)
      await insertMemory({ title: "Beta goal note (goal in deptB)", layer: "active_context", visibility: "scoped", goalId: gB });
      // (8) invalidated + company visibility → nobody: LEAK if visible (correction/forgetting)
      await insertMemory({ title: "Invalidated company note", layer: "domain", visibility: "company", invalidated: true });

      expect(co && deptA && deptB && projP && agA && agB && gB).toBeTruthy();
    });

    it("actorForAgentRun scopes agent A to dept A only (not dept B, not the project)", async () => {
      assertSetupOk();
      const actor = await actorForAgentRun(db, co, agA);
      expect(actor).toEqual({ kind: "agent", agentId: agA, departmentIds: [deptA] });
    });

    it("THE GATE: agent A sees dept-A + identity + company + own-private; never dept-B, other-private, dept-B-goal, or invalidated", async () => {
      assertSetupOk();
      const titles = await visibleTitlesForAgent(agA);

      // PRESENT — everything agent A is entitled to.
      expect(titles.has("Alpha domain (deptA)")).toBe(true);
      expect(titles.has("Company identity")).toBe(true);
      expect(titles.has("Company-wide note")).toBe(true);
      expect(titles.has("Agent A private")).toBe(true);

      // ABSENT — the leak checks. Any `true` here is a real cross-scope leak.
      expect(titles.has("Beta domain (deptB)")).toBe(false); // cross-department
      expect(titles.has("Agent B private")).toBe(false); // cross-owner private
      expect(titles.has("Beta goal note (goal in deptB)")).toBe(false); // goal→dept-B leak
      expect(titles.has("Invalidated company note")).toBe(false); // invalidated/forgotten
    });

    it("symmetry: agent B sees dept-B + its own private + identity; never dept-A's scoped row", async () => {
      assertSetupOk();
      const titles = await visibleTitlesForAgent(agB);

      expect(titles.has("Beta domain (deptB)")).toBe(true);
      expect(titles.has("Agent B private")).toBe(true); // its own private IS visible
      expect(titles.has("Beta goal note (goal in deptB)")).toBe(true); // its goal IS visible
      expect(titles.has("Company identity")).toBe(true);

      expect(titles.has("Alpha domain (deptA)")).toBe(false); // cross-department
      expect(titles.has("Agent A private")).toBe(false); // cross-owner private
      expect(titles.has("Invalidated company note")).toBe(false);
    });

    it("tiers (MINOR-1): a team_member human sees company but NOT identity; an external MCP key sees neither", async () => {
      assertSetupOk();
      // Internal team_member human scoped to dept A (external unset → internal member).
      // userId must be a real UUID — owner_id is a uuid column and the gate emits
      // `owner_id = <userId>` for the own-private clause.
      const member: MemoryActor = {
        kind: "team_member",
        userId: "11111111-1111-1111-1111-111111111111",
        departmentIds: [deptA],
      };
      const memberTitles = await visibleTitlesForActor(member);
      expect(memberTitles.has("Company-wide note")).toBe(true); // company: internal member YES
      expect(memberTitles.has("Alpha domain (deptA)")).toBe(true); // own dept scoped
      expect(memberTitles.has("Company identity")).toBe(false); // identity: team_member NO
      expect(memberTitles.has("Beta domain (deptB)")).toBe(false); // cross-dept still denied

      // External MCP key: same kind, marked external → NOT an internal member.
      const external: MemoryActor = {
        kind: "team_member",
        userId: "22222222-2222-2222-2222-222222222222",
        departmentIds: [deptA],
        external: true,
      };
      const extTitles = await visibleTitlesForActor(external);
      expect(extTitles.has("Company identity")).toBe(false); // identity: external NO
      expect(extTitles.has("Company-wide note")).toBe(false); // company: external NO
      expect(extTitles.has("Alpha domain (deptA)")).toBe(true); // its scoped access still works
    });

    it("crew bundle wiring: an entitled crew agent's ## Context renders an in-scope/company nonce but NOT an out-of-dept one (RBAC)", async () => {
      assertSetupOk();
      // A crew (kind='aoa') agent assigned to dept A only, and a task in dept A whose
      // single-word title drives the memory query ('grackle' → ilike substring + temporal).
      const crew = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO agents (id, company_id, name, kind, status)
          VALUES (gen_random_uuid(), ${co}, 'Crew A', 'aoa', 'idle') RETURNING id`),
      );
      await db.execute(sql`
        INSERT INTO agent_projects (agent_id, project_id, company_id) VALUES (${crew}, ${deptA}, ${co})`);
      const task = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO issues (id, company_id, project_id, title, status)
          VALUES (gen_random_uuid(), ${co}, ${deptA}, 'grackle', 'todo') RETURNING id`),
      );

      // Nonce in the task's department (crew agent entitled) + an out-of-dept nonce.
      // Both contain 'grackle' (keyword match); crew retrieval is scoped to the task's dept,
      // and the out-of-dept row is additionally RBAC-excluded (agent A is not in dept B).
      await db.execute(sql`
        INSERT INTO memory_items
          (id, company_id, title, content, category, source, status, created_by, layer, visibility, department_id)
        VALUES (gen_random_uuid(), ${co}, 'Crew in-scope', 'grackle codeword NONCE-INSCOPE',
                'reference', 'founder', 'approved', 'itest', 'domain', 'scoped', ${deptA})`);
      await db.execute(sql`
        INSERT INTO memory_items
          (id, company_id, title, content, category, source, status, created_by, layer, visibility, department_id)
        VALUES (gen_random_uuid(), ${co}, 'Other dept secret', 'grackle codeword NONCE-OTHERDEPT',
                'reference', 'founder', 'approved', 'itest', 'domain', 'scoped', ${deptB})`);

      const bundle = await buildCrewContextBundle(db, { companyId: co, agentId: crew, issueId: task });

      // The RBAC-gated bundle rendered the entitled dept-A nonce into the crew prompt (## Context)…
      expect(bundle).toContain("NONCE-INSCOPE");
      // …and the out-of-dept row is ABSENT (RBAC + task scope).
      expect(bundle).not.toContain("NONCE-OTHERDEPT");
    });

    it("unscoped memory (Decision #119): a fully-unscoped non-identity row is retrieved by agents + members, NOT external keys; identity stays hidden from team_member", async () => {
      assertSetupOk();
      // Fully-unscoped, non-private, non-identity (discussion-extracted style: dept/project/goal/task all null).
      await db.execute(sql`
        INSERT INTO memory_items
          (id, company_id, title, content, category, source, status, created_by, layer, visibility, department_id, project_id, goal_id)
        VALUES (gen_random_uuid(), ${co}, 'Ambient company note', 'ambientmarker body', 'reference', 'founder', 'approved', 'itest',
                'domain', 'scoped', NULL, NULL, NULL)`);

      // An agent scoped to dept A retrieves the ambient (unscoped) note — the e2e regression fix.
      expect((await visibleTitlesForAgent(agA)).has("Ambient company note")).toBe(true);

      // #3: the run-path SCOPE FILTER (departmentId) must not exclude unscoped memory —
      // a dept-A-scoped keyword search still returns the ambient note (dept OR NULL).
      const actorA = await actorForAgentRun(db, co, agA);
      const scopedRaw = await memoryService(db).searchMultiPath(co, "ambientmarker", {
        departmentId: deptA,
        accessConditions: memoryAccessConditions(db, actorA),
        limit: 100,
      });
      const scopedTitles = new Set(filterMemoryForActor(scopedRaw, actorA).map((r) => r.title));
      expect(scopedTitles.has("Ambient company note")).toBe(true); // survives the dept-A scope filter

      // A team_member human sees it too...
      const member: MemoryActor = {
        kind: "team_member",
        userId: "33333333-3333-3333-3333-333333333333",
        departmentIds: [deptA],
      };
      const memberTitles = await visibleTitlesForActor(member);
      expect(memberTitles.has("Ambient company note")).toBe(true);
      // ...but the identity row (also fully-unscoped) stays hidden from the team_member (Decision #118 guard).
      expect(memberTitles.has("Company identity")).toBe(false);

      // An external MCP key sees neither the ambient note nor identity.
      const external: MemoryActor = {
        kind: "team_member",
        userId: "44444444-4444-4444-4444-444444444444",
        departmentIds: [deptA],
        external: true,
      };
      const extTitles = await visibleTitlesForActor(external);
      expect(extTitles.has("Ambient company note")).toBe(false);
      expect(extTitles.has("Company identity")).toBe(false);
    });

    it("the gate is meaningful, not vacuous: WITHOUT accessConditions the dept-B row DOES come back", async () => {
      assertSetupOk();
      const raw = await memoryService(db).searchMultiPath(co, "", { limit: 100 });
      const titles = new Set(raw.map((r) => r.title));
      // The exact row agent A was denied is present in the ungated pull — so the
      // absence above is the RBAC gate at work, not a missing/empty fixture.
      expect(titles.has("Beta domain (deptB)")).toBe(true);
      expect(titles.has("Alpha domain (deptA)")).toBe(true);
    });
  },
);
