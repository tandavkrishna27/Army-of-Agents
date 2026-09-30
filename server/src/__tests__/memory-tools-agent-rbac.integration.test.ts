/**
 * U2a — the crew-agent-facing unscoped memory-search tools are RBAC-gated.
 *
 * `find_similar_memory` and `detect_conflicts` (server/src/services/internal-agent/
 * tools/memory-tools.ts) previously returned memory with NO scope/private filter —
 * safe when the caller was board/Commander, but a leak for a sandboxed crew AGENT
 * actor. This test proves, against a REAL Postgres (embedded-postgres + the
 * committed migration chain), that both tools now gate on `memoryAccessConditions`
 * (Decisions #118/#119) when `ctx.actorType === "agent"`, mirroring the converged
 * `handleMemorySearch` gate in mcp/tools/read-tools.ts:
 *
 *   - `find_similar_memory` now goes through `memoryService.searchMultiPath`
 *     (switched off `searchSemantic`, which has no accessConditions seam) with
 *     the actor's accessConditions AND-ed in, then `filterMemoryForActor` as a
 *     post-fetch safety net.
 *   - `detect_conflicts` (backed by `memoryService.findSimilarItems`) gates
 *     IN-SQL ONLY — its projection is narrower than `AccessibleMemoryRow` (no
 *     visibility/agentId), so `filterMemoryForActor` would not type-check there;
 *     `memoryAccessConditions` is the sole, authoritative gate on that path.
 *
 * NOT covered here: `find_similar_memory_hnsw` (memory-find-similar.ts). That
 * tool queries `memory_items.embedding` directly, and embedded-postgres's
 * bundled vanilla Postgres does NOT ship pgvector (see migration
 * 0115_enable_pgvector.sql's own comment) — the column doesn't exist under this
 * harness on ANY platform, not just Windows, so a real-DB exercise of that tool
 * is structurally impossible here. Its gate wiring is proven locally instead by
 * the mocked-DB unit test in memory-tools-agent-rbac.unit.test.ts (which asserts
 * `memoryAccessConditions`'s result reaches the tool's in-SQL `conditions` array
 * and composes cleanly with real drizzle-orm `and(...)`).
 *
 * Skipped on Windows (the `runneradmin` account can't start embedded-postgres —
 * Issue #114); Linux CI `push` is the authoritative gate for this file, mirroring
 * every other `*.integration.test.ts` in this suite (e.g.
 * mcp-memory-read-rbac.integration.test.ts, whose embedded-pg setup this harness
 * is modeled on).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { memoryService } from "../services/memory.js";
import { createMemoryTools } from "../services/internal-agent/tools/memory-tools.js";
import type { ToolContext, ToolResult } from "../services/internal-agent/types.js";
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
let deptD1 = "";
let deptD2 = "";
let crewAgentId = "";

// Shared keyword text so both tools' fallback candidate fetch (ilike
// substring for find_similar_memory's keyword pathway; ilike top-5-word OR
// for detect_conflicts' text-overlap fallback) reaches BOTH rows before the
// RBAC gate narrows the result. Embedded-PG has no OpenAI key configured (and
// getDbCapabilities() defaults hasVectorSupport=false without a probe call),
// so both tools' semantic pathways no-op and fall back to these keyword paths
// — this is what makes the overlap wording load-bearing rather than cosmetic.
const SHARED_PREFIX = "shared secret plan for department overlap testing";

/** Insert one approved memory row with explicit scope; RETURNING its id. */
async function insertMemory(opts: {
  title: string;
  content: string;
  layer: string;
  visibility: string;
  departmentId?: string | null;
}): Promise<string> {
  return firstId(
    await db.execute<{ id: string }>(sql`
      INSERT INTO memory_items
        (id, company_id, title, content, category, source, status, created_by,
         layer, visibility, department_id)
      VALUES
        (gen_random_uuid(), ${co}, ${opts.title}, ${opts.content}, 'reference',
         'founder', 'approved', 'integration-test',
         ${opts.layer}, ${opts.visibility}, ${opts.departmentId ?? null})
      RETURNING id`),
  );
}

function ctxFor(actorType: string, agentId?: string): ToolContext {
  return {
    companyId: co,
    userId: "founder-1",
    userRole: "founder",
    enabledCapabilities: [],
    actorType,
    ...(agentId ? { agentId } : {}),
    db,
    services: { memory: memoryService(db) },
  } as unknown as ToolContext;
}

async function titlesFromFindSimilarMemory(actorType: string, agentId?: string): Promise<Set<string>> {
  const tools = createMemoryTools();
  const tool = tools.find((t) => t.name === "find_similar_memory")!;
  const result: ToolResult = await tool.execute(
    { query: "shared secret plan", limit: 10 },
    ctxFor(actorType, agentId),
  );
  expect(result.success).toBe(true);
  const items = result.data as Array<{ title: string }>;
  return new Set(items.map((i) => i.title));
}

async function titlesFromDetectConflicts(actorType: string, agentId?: string): Promise<Set<string>> {
  const tools = createMemoryTools();
  const tool = tools.find((t) => t.name === "detect_conflicts")!;
  const result: ToolResult = await tool.execute(
    { proposedTitle: "Proposed", proposedContent: SHARED_PREFIX },
    ctxFor(actorType, agentId),
  );
  expect(result.success).toBe(true);
  const conflicts = (result.data as { conflicts: Array<{ title: string; similarity: number }> }).conflicts;
  // Sanity: every conflict returned actually cleared detect_conflicts' own
  // >0.85 overlap bar (proves the test's shared wording is a real detector
  // hit, not an artifact of an empty/permissive filter).
  for (const c of conflicts) expect(c.similarity).toBeGreaterThan(0.85);
  return new Set(conflicts.map((c) => c.title));
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-memtools-rbac-"));
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
    console.error("[memory-tools-agent-rbac] embedded-postgres setup failed:", err);
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

describe.skipIf(process.platform === "win32")(
  "find_similar_memory / detect_conflicts RBAC gate — agent actor scope (U2a)",
  () => {
    it("setup: company, two departments, a crew agent scoped to D2 only, M-visible (unscoped) + M-hidden (dept D1)", async () => {
      assertSetupOk();

      co = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (id, name) VALUES (gen_random_uuid(), 'U2a Memtools Co') RETURNING id`),
      );
      deptD1 = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO projects (id, company_id, name, type)
          VALUES (gen_random_uuid(), ${co}, 'D1', 'department') RETURNING id`),
      );
      deptD2 = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO projects (id, company_id, name, type)
          VALUES (gen_random_uuid(), ${co}, 'D2', 'department') RETURNING id`),
      );
      crewAgentId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO agents (id, company_id, name, kind, status)
          VALUES (gen_random_uuid(), ${co}, 'Crew Agent', 'aoa', 'idle') RETURNING id`),
      );
      // Agent assigned to D2 ONLY — must never see D1-scoped memory.
      await db.execute(sql`
        INSERT INTO agent_projects (agent_id, project_id, company_id) VALUES (${crewAgentId}, ${deptD2}, ${co})`);

      // M-visible: fully unscoped (no department/project/goal/task), non-private —
      // ambient company-level memory under Decision #119. Visible to every
      // internal member + every agent regardless of department assignment.
      await insertMemory({
        title: "M-visible",
        content: `${SHARED_PREFIX} visible marker item`,
        layer: "domain",
        visibility: "scoped",
        departmentId: null,
      });
      // M-hidden: scoped to D1. The D2-only agent's departmentIds=[D2] excludes it.
      await insertMemory({
        title: "M-hidden",
        content: `${SHARED_PREFIX} hidden marker item`,
        layer: "domain",
        visibility: "scoped",
        departmentId: deptD1,
      });

      expect(co && deptD1 && deptD2 && crewAgentId).toBeTruthy();
    });

    it("sanity — both rows are keyword-reachable for an unrestricted (board) actor before RBAC narrows anything", async () => {
      assertSetupOk();
      const viaSearch = await titlesFromFindSimilarMemory("board");
      expect(viaSearch.has("M-visible")).toBe(true);
      expect(viaSearch.has("M-hidden")).toBe(true);

      const viaConflicts = await titlesFromDetectConflicts("board");
      expect(viaConflicts.has("M-visible")).toBe(true);
      expect(viaConflicts.has("M-hidden")).toBe(true);
    });

    it("LEAK CHECK — find_similar_memory: D2 agent sees M-visible but NOT M-hidden (dept D1)", async () => {
      assertSetupOk();
      const titles = await titlesFromFindSimilarMemory("agent", crewAgentId);
      expect(titles.has("M-visible")).toBe(true);
      expect(titles.has("M-hidden")).toBe(false);
    });

    it("LEAK CHECK — detect_conflicts: D2 agent sees M-visible but NOT M-hidden (dept D1)", async () => {
      assertSetupOk();
      const titles = await titlesFromDetectConflicts("agent", crewAgentId);
      expect(titles.has("M-visible")).toBe(true);
      expect(titles.has("M-hidden")).toBe(false);
    });

    it("REGRESSION — find_similar_memory: board actor still sees M-hidden after the gate landed (path unchanged)", async () => {
      assertSetupOk();
      const titles = await titlesFromFindSimilarMemory("board");
      expect(titles.has("M-hidden")).toBe(true);
      expect(titles.has("M-visible")).toBe(true);
    });

    it("REGRESSION — detect_conflicts: board actor still sees M-hidden after the gate landed (path unchanged)", async () => {
      assertSetupOk();
      const titles = await titlesFromDetectConflicts("board");
      expect(titles.has("M-hidden")).toBe(true);
      expect(titles.has("M-visible")).toBe(true);
    });
  },
);
