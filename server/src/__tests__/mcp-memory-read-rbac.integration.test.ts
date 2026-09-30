/**
 * P1-T5 — the MCP memory-read path is RBAC-gated at the ROW level.
 *
 * Proves, against a REAL Postgres (embedded-postgres + the committed migration
 * chain), that the *converged* gate now used by the MCP worker-facing memory
 * tools (`memory.get` / `memory.search` in read-tools.ts) holds: an agent whose
 * scope excludes a goal's project can NOT read a memory row scoped ONLY to that
 * goal — the exact leak a naive `filterMemoryForScope` → `filterMemoryForActor`
 * swap would introduce.
 *
 * Why this is the leak canary: the pure `filterMemoryForActor` PASSES goal-/task-
 * only-scoped rows THROUGH (it can't resolve goal→project without a DB join). It
 * is a safe post-fetch net ONLY because the FETCH already applied
 * `memoryAccessConditions` (the in-SQL gate that DOES resolve goal→project via the
 * project_goals junction). This test drives the ACTUAL handlers — which call
 * `actorForMcp` → `memoryAccessConditions` → gated fetch → `filterMemoryForActor` —
 * so a regression that drops the SQL gate on any read site turns a leak-check
 * `false` into `true`. The positive-control agent (in the goal's department) DOES
 * get the row, so absence is the gate at work, not a vacuous empty set.
 *
 * Skipped on Windows CI by default (the `runneradmin` account can't start
 * embedded-postgres — Issue #114); Linux CI `push` is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real. Harness
 * modeled on memory-rbac-leakage.integration.test.ts (P1-T7).
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

let co = "";
let deptA = "";
let deptB = "";
let agA = "";
let agB = "";
let gB = "";
let goalRowId = ""; // memory row scoped ONLY to goal gB (dept B) — the leak canary

/** Insert one approved memory row with an explicit scope; RETURNING its id. */
async function insertMemory(opts: {
  title: string;
  layer: string;
  visibility: string;
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
         'founder', 'approved', 'integration-test',
         ${opts.layer}, ${opts.visibility},
         ${opts.departmentId ?? null}, ${opts.goalId ?? null})
      RETURNING id`),
  );
}

/**
 * A minimal ToolContext for an agent MCP caller. The converged memory handlers
 * read only `db`, `companyId`, `actor`, and `services.memorySvc` — they resolve
 * the RBAC actor themselves (they no longer trust `ctx.scope`), so the other
 * fields are inert stubs cast to satisfy the interface.
 */
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

async function searchTitlesForAgent(agentId: string): Promise<Set<string>> {
  const res = await readToolHandlers["memory.search"](ctxForAgent(agentId), {
    query: "body",
    limit: 50,
  });
  if (!res.ok) throw new Error(`memory.search failed: ${res.message}`);
  const items = (res.data as { items: Array<{ title: string }> }).items;
  return new Set(items.map((i) => i.title));
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mcp-mem-rbac-"));
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
    console.error("[mcp-mem-rbac] embedded-postgres setup failed:", err);
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
  "MCP memory-read path RBAC — goal-scope gate (P1-T5)",
  () => {
    it("setup: company, two departments, two agents, a goal in dept B, and 3 scoped rows", async () => {
      assertSetupOk();

      co = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (id, name) VALUES (gen_random_uuid(), 'MCP Leak Co') RETURNING id`),
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
      // agent A → dept A ONLY; agent B → dept B ONLY.
      await db.execute(sql`
        INSERT INTO agent_projects (agent_id, project_id, company_id) VALUES (${agA}, ${deptA}, ${co})`);
      await db.execute(sql`
        INSERT INTO agent_projects (agent_id, project_id, company_id) VALUES (${agB}, ${deptB}, ${co})`);

      // Goal that belongs to dept B via the project_goals junction (goals has no
      // projectId column — the exact path memoryAccessConditions must resolve).
      gB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO goals (id, company_id, title)
          VALUES (gen_random_uuid(), ${co}, 'Goal B') RETURNING id`),
      );
      await db.execute(sql`
        INSERT INTO project_goals (project_id, goal_id, company_id) VALUES (${deptB}, ${gB}, ${co})`);

      await insertMemory({ title: "Alpha domain", layer: "domain", visibility: "scoped", departmentId: deptA });
      await insertMemory({ title: "Company identity", layer: "identity", visibility: "scoped" });
      // The canary: scoped to goal gB ONLY (no department/project). Resolves to dept
      // B via project_goals — so it must be INVISIBLE to dept-A agent A.
      goalRowId = await insertMemory({
        title: "Beta goal secret",
        layer: "active_context",
        visibility: "scoped",
        goalId: gB,
      });

      expect(co && deptA && deptB && agA && agB && gB && goalRowId).toBeTruthy();
    });

    it("LEAK CHECK — memory.get: agent A (dept A) canNOT read the dept-B goal-scoped row", async () => {
      assertSetupOk();
      const res = await memoryGet(agA, goalRowId);
      // A naive filterMemoryForActor-only swap would return this row (the pure net
      // passes goal-only rows through). The in-SQL gate on the fetch closes it.
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toBe("Memory item not found");
    });

    it("positive control — memory.get: agent B (dept B, owns the goal) DOES read it", async () => {
      assertSetupOk();
      const res = await memoryGet(agB, goalRowId);
      expect(res.ok).toBe(true);
      if (res.ok) expect((res.data as { id: string }).id).toBe(goalRowId);
    });

    it("LEAK CHECK — memory.search: agent A never sees the dept-B goal row; sees its dept + identity", async () => {
      assertSetupOk();
      const titles = await searchTitlesForAgent(agA);
      expect(titles.has("Beta goal secret")).toBe(false); // the goal→dept-B leak
      expect(titles.has("Alpha domain")).toBe(true);
      expect(titles.has("Company identity")).toBe(true);
    });

    it("positive control — memory.search: agent B DOES see the dept-B goal row (gate is not vacuous)", async () => {
      assertSetupOk();
      const titles = await searchTitlesForAgent(agB);
      expect(titles.has("Beta goal secret")).toBe(true);
      expect(titles.has("Company identity")).toBe(true);
      expect(titles.has("Alpha domain")).toBe(false); // cross-department, still gated
    });
  },
);
