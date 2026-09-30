/**
 * Real-DB integration proof for the crew/org task-scope predicate (T-A).
 *
 * Authoritative proof that `issueService.list()` resolves `taskScope` against
 * real rows: a crew-assigned task (assignee = active `kind='aoa'` agent), an
 * org-assigned task (assignee = `kind='org'` agent), and an unassigned task.
 *   - taskScope:'org'  → org + unassigned   (NOT crew)   ← fail-safe default
 *   - taskScope:'crew' → crew only
 *   - taskScope:'all'  → all three
 *   - default (no taskScope) === 'org'
 *   - crewBoard:true (legacy) === 'crew'
 *
 * Boots embedded-postgres, applies all migrations, seeds one company.
 * Skipped on Windows (embedded-postgres / migration-chain — Issue #114); Linux
 * CI is the authoritative gate. Mirrors agents-list-excludes-platform.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { issueService } from "../services/issues.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean;
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let svc: ReturnType<typeof issueService>;
let setupError: unknown = null;

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as { id: string })?.id;
  return (result as { rows?: { id: string }[] }).rows?.[0]?.id;
}

const PORT = 58000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-crew-scope-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    svc = issueService(db);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[crew-scope-integration] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32")(
  "issueService.list() taskScope — real DB: crew vs org vs all",
  () => {
    let companyId: string;
    let crewIssueId: string;
    let orgIssueId: string;
    let unassignedIssueId: string;

    it("setup: seeds a company, a crew + an org agent, and 3 issues", async () => {
      if (setupError) {
        throw new Error(
          `embedded-postgres setup failed; cannot run integration test: ${String(setupError)}`,
        );
      }
      companyId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO companies (id, name) VALUES (gen_random_uuid(), 'Crew Scope Co') RETURNING id
      `));
      expect(companyId).toBeTruthy();

      const crewAgentId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO agents (id, company_id, name, kind, status)
        VALUES (gen_random_uuid(), ${companyId}, 'Engineer', 'aoa', 'idle') RETURNING id
      `));
      const orgAgentId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO agents (id, company_id, name, kind, status)
        VALUES (gen_random_uuid(), ${companyId}, 'Marketing Bot', 'org', 'idle') RETURNING id
      `));
      expect(crewAgentId).toBeTruthy();
      expect(orgAgentId).toBeTruthy();

      crewIssueId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO issues (id, company_id, title, status, assignee_agent_id)
        VALUES (gen_random_uuid(), ${companyId}, 'Crew task', 'todo', ${crewAgentId}) RETURNING id
      `));
      orgIssueId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO issues (id, company_id, title, status, assignee_agent_id)
        VALUES (gen_random_uuid(), ${companyId}, 'Org task', 'todo', ${orgAgentId}) RETURNING id
      `));
      unassignedIssueId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO issues (id, company_id, title, status)
        VALUES (gen_random_uuid(), ${companyId}, 'Unassigned task', 'todo') RETURNING id
      `));
      expect(crewIssueId).toBeTruthy();
      expect(orgIssueId).toBeTruthy();
      expect(unassignedIssueId).toBeTruthy();
    });

    it("taskScope:'org' returns org + unassigned, NOT crew", async () => {
      if (setupError) throw new Error(String(setupError));
      const rows = await svc.list(companyId, { taskScope: "org" });
      const ids = new Set(rows.map((r) => r.id));
      expect(ids.has(orgIssueId)).toBe(true);
      expect(ids.has(unassignedIssueId)).toBe(true);
      expect(ids.has(crewIssueId)).toBe(false);
    });

    it("taskScope:'crew' returns crew only", async () => {
      if (setupError) throw new Error(String(setupError));
      const rows = await svc.list(companyId, { taskScope: "crew" });
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(crewIssueId);
      expect(ids).not.toContain(orgIssueId);
      expect(ids).not.toContain(unassignedIssueId);
    });

    it("taskScope:'all' returns all three", async () => {
      if (setupError) throw new Error(String(setupError));
      const rows = await svc.list(companyId, { taskScope: "all" });
      const ids = new Set(rows.map((r) => r.id));
      expect(ids.has(crewIssueId)).toBe(true);
      expect(ids.has(orgIssueId)).toBe(true);
      expect(ids.has(unassignedIssueId)).toBe(true);
    });

    it("default (no taskScope) behaves as 'org' — the fail-safe default", async () => {
      if (setupError) throw new Error(String(setupError));
      const rows = await svc.list(companyId);
      const ids = new Set(rows.map((r) => r.id));
      expect(ids.has(orgIssueId)).toBe(true);
      expect(ids.has(unassignedIssueId)).toBe(true);
      expect(ids.has(crewIssueId)).toBe(false);
    });

    it("legacy crewBoard:true maps to 'crew' (back-compat)", async () => {
      if (setupError) throw new Error(String(setupError));
      const rows = await svc.list(companyId, { crewBoard: true });
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(crewIssueId);
      expect(ids).not.toContain(orgIssueId);
      expect(ids).not.toContain(unassignedIssueId);
    });

    it("crew rows carry sourceThreadTitle (the crew LEFT JOIN shape is preserved)", async () => {
      if (setupError) throw new Error(String(setupError));
      const rows = await svc.list(companyId, { taskScope: "crew" });
      const crewRow = rows.find((r) => r.id === crewIssueId) as
        | { sourceThreadTitle?: unknown }
        | undefined;
      expect(crewRow).toBeTruthy();
      // No source discussion was set → null, but the field must be present
      // (proves the JOIN projection ran, not that it was dropped).
      expect(crewRow).toHaveProperty("sourceThreadTitle");
    });

    it("reassigning the crew task to the org agent moves it org-side and out of crew", async () => {
      if (setupError) throw new Error(String(setupError));
      const orgAgentRow = firstId(await db.execute<{ id: string }>(sql`
        SELECT id FROM agents WHERE company_id = ${companyId} AND kind = 'org' LIMIT 1
      `));
      await db.execute(sql`
        UPDATE issues SET assignee_agent_id = ${orgAgentRow} WHERE id = ${crewIssueId}
      `);

      const crewRows = (await svc.list(companyId, { taskScope: "crew" })).map((r) => r.id);
      const orgRows = (await svc.list(companyId, { taskScope: "org" })).map((r) => r.id);
      expect(crewRows).not.toContain(crewIssueId);
      expect(orgRows).toContain(crewIssueId);

      // Restore for isolation if more tests are appended later.
      const crewAgentRow = firstId(await db.execute<{ id: string }>(sql`
        SELECT id FROM agents WHERE company_id = ${companyId} AND kind = 'aoa' LIMIT 1
      `));
      await db.execute(sql`
        UPDATE issues SET assignee_agent_id = ${crewAgentRow} WHERE id = ${crewIssueId}
      `);
    });
  },
);
