/**
 * Real-DB integration test for routine revision history.
 *
 * Boots an embedded-postgres instance, applies all migrations including 0089,
 * seeds a company + agent + routine, then exercises createRevision, update,
 * listRevisions, and restoreRevision.
 *
 * Skipped on Windows (embedded-postgres encoding issues — see Issue #114).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  type Db,
} from "@armyofagents/db";
import { routineService } from "../services/routines.js";

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
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let svc: ReturnType<typeof routineService>;
let setupError: unknown = null;

// Helpers for normalizing db.execute results
function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as any)?.id;
  return (result as any).rows?.[0]?.id;
}

// Random port between 56000-56999 to avoid collisions with other test runs
const PORT = 56000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-routine-revisions-test-"));
    const { default: EmbeddedPostgres } = (await import(
      "embedded-postgres"
    )) as { default: EmbeddedPostgresCtor };

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
    svc = routineService(db);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error(
      "[routine-revisions-integration] embedded-postgres setup failed:",
      err,
    );
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    // ignore
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}, 60_000);

// Skipped on Windows due to embedded-postgres encoding issue (Issue #114).
describe.skipIf(process.platform === "win32")(
  "routineService revisions — real DB integration (migration 0089)",
  () => {
    let companyId: string;
    let agentId: string;
    let routineId: string;
    const actor = { agentId: null as string | null, userId: "integ-user-1" };

    it("setup: seeds company + agent + routine", async () => {
      if (setupError) {
        throw new Error(
          `embedded-postgres setup failed; cannot run integration test: ${String(setupError)}`,
        );
      }

      const companyInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO companies (id, name)
        VALUES (gen_random_uuid(), 'Revision Test Co')
        RETURNING id
      `);
      companyId = firstId(companyInserted);
      expect(companyId).toBeTruthy();

      const agentInserted = await db.execute<{ id: string }>(sql`
        INSERT INTO agents (id, company_id, name, role, status, adapter_type, runtime_config, adapter_config, permissions, skill_keys, budget_monthly_cents, spent_monthly_cents)
        VALUES (gen_random_uuid(), ${companyId}, 'Test Agent', 'general', 'idle', 'process', '{}', '{}', '{}', '[]', 0, 0)
        RETURNING id
      `);
      agentId = firstId(agentInserted);
      expect(agentId).toBeTruthy();

      const routine = await svc.create(companyId, {
        title: "Initial Title",
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      }, actor);
      routineId = routine.id;
      expect(routineId).toBeTruthy();
      expect(routine.latestRevisionId).toBeNull();
    });

    it("createRevision: inserts a revision row and sets latestRevisionId", async () => {
      if (setupError) throw new Error(String(setupError));

      await svc.createRevision(routineId, actor);

      const revs = await svc.listRevisions(routineId, companyId);
      expect(revs).toHaveLength(1);
      expect(revs[0].snapshot.title).toBe("Initial Title");

      // latestRevisionId should now be set on the routine
      const routine = await svc.get(routineId);
      expect(routine?.latestRevisionId).toBe(revs[0].id);
    });

    it("update: auto-creates a revision before applying changes", async () => {
      if (setupError) throw new Error(String(setupError));

      await svc.update(routineId, { title: "New Title" }, actor);

      const updated = await svc.get(routineId);
      expect(updated?.title).toBe("New Title");

      const revs = await svc.listRevisions(routineId, companyId);
      // Should now have 2: one from createRevision above, one auto-created by update
      expect(revs).toHaveLength(2);

      // Most recent first — snapshot should still show the PREVIOUS state before update
      expect(revs[0].snapshot.title).toBe("Initial Title");
      expect(revs[1].snapshot.title).toBe("Initial Title");
    });

    it("listRevisions: returns items in descending createdAt order", async () => {
      if (setupError) throw new Error(String(setupError));

      const revs = await svc.listRevisions(routineId, companyId);
      expect(revs.length).toBeGreaterThanOrEqual(2);
      // Verify descending order
      for (let i = 1; i < revs.length; i++) {
        expect(new Date(revs[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
          new Date(revs[i].createdAt).getTime(),
        );
      }
    });

    it("restoreRevision: restores snapshot and creates revision entries", async () => {
      if (setupError) throw new Error(String(setupError));

      const revsBefore = await svc.listRevisions(routineId, companyId);
      const oldestRev = revsBefore[revsBefore.length - 1];
      expect(oldestRev.snapshot.title).toBe("Initial Title");
      const current = await svc.get(routineId);
      expect(current).not.toBeNull();

      // Restore to oldest revision (title = "Initial Title")
      const restored = await svc.restoreRevision(routineId, oldestRev.id, current!.latestRevisionId, actor);
      expect(restored).not.toBeNull();
      expect(restored?.title).toBe("Initial Title");

      // restoreRevision should create 2 new revisions (pre-restore + post-restore)
      const revsAfter = await svc.listRevisions(routineId, companyId);
      expect(revsAfter.length).toBe(revsBefore.length + 2);
    });
  },
);
