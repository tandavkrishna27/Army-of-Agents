/**
 * PR-A2 — real-DB proof that discussionService.getById surfaces the thread's coordination-level
 * lastError (and clears it on recovery). Boots embedded-postgres + applies migrations, like the
 * other integration suites. Skipped on Windows (embedded-postgres / Issue #114); runs in node:24
 * Docker / Linux CI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { discussionService } from "../services/discussions.js";

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
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let connectionString = "";
let setupError: unknown = null;
let companyId = "";

const PORT = 59000 + Math.floor(Math.random() * 1000);

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<Record<string, unknown>>;
}

describe.skipIf(process.platform === "win32")("discussion getById — lastError surface (PR-A2, real DB)", () => {
  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-disc-lasterr-"));
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
      connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
      await applyPendingMigrations(connectionString);
      db = createDb(connectionString);
      const company = await companyService(db).create({ name: "LastError Co" } as never);
      companyId = company.id;
    } catch (err) {
      setupError = err;
      // eslint-disable-next-line no-console
      console.error("[discussion-lasterror] embedded-postgres setup failed:", err);
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
  });

  it("surfaces the orchestration lastError, and null when cleared (self-clear)", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = discussionService(db);

    const [d] = rowsOf(
      await db.execute(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`),
    );
    const threadId = String(d.id);

    // No orchestration row yet → no error surfaced.
    const before = await svc.getById(companyId, threadId);
    expect(before?.lastError ?? null).toBeNull();

    // The controller recorded an error.
    await db.execute(sql`
      INSERT INTO thread_orchestration_state (thread_id, pending_run, last_error, consecutive_commit_failures)
      VALUES (${threadId}, false, 'action_commit_failed_skipped: boom', 2)`);
    const withErr = await svc.getById(companyId, threadId);
    expect(withErr?.lastError).toBe("action_commit_failed_skipped: boom");
    expect(withErr?.consecutiveCommitFailures).toBe(2);

    // Recovered → cleared → banner self-clears.
    await db.execute(sql`UPDATE thread_orchestration_state SET last_error = NULL WHERE thread_id = ${threadId}`);
    const cleared = await svc.getById(companyId, threadId);
    expect(cleared?.lastError ?? null).toBeNull();
  });
});
