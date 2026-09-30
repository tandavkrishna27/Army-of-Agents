/**
 * Real-DB integration test for agentService.list() — authoritative proof
 * that platform agents (kind='platform') are excluded and org agents are
 * returned, with cross-company isolation. Mirrors environments-integration.test.ts.
 *
 * Boots embedded-postgres, applies all migrations (incl. 0098 agents.kind),
 * seeds companies, inserts org + platform agents, exercises list().
 *
 * Skipped on Windows (embedded-postgres / migration-chain issue — Issue #114);
 * Linux CI is the authoritative gate for this test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { agentService } from "../services/agents.js";

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
let svc: ReturnType<typeof agentService>;
let setupError: unknown = null;

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as any)?.id;
  return (result as any).rows?.[0]?.id;
}

const PORT = 57000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-agents-kind-test-"));
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
    svc = agentService(db);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[agents-kind-integration] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32")(
  "agentService.list() — real DB: excludes platform, isolates by company",
  () => {
    let companyAId: string;
    let companyBId: string;

    it("setup: seeds two companies", async () => {
      if (setupError) {
        throw new Error(
          `embedded-postgres setup failed; cannot run integration test: ${String(setupError)}`,
        );
      }
      companyAId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO companies (id, name, issue_prefix) VALUES (gen_random_uuid(), 'Kind Test Co A', 'KTA') RETURNING id
      `));
      companyBId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO companies (id, name, issue_prefix) VALUES (gen_random_uuid(), 'Kind Test Co B', 'KTB') RETURNING id
      `));
      expect(companyAId).toBeTruthy();
      expect(companyBId).toBeTruthy();
    });

    it("list() returns org agents and excludes platform agents", async () => {
      if (setupError) throw new Error(String(setupError));

      // Company A: 2 org agents + 1 platform agent
      await db.execute(sql`INSERT INTO agents (id, company_id, name, kind) VALUES (gen_random_uuid(), ${companyAId}, 'A-Org-1', 'org')`);
      await db.execute(sql`INSERT INTO agents (id, company_id, name, kind) VALUES (gen_random_uuid(), ${companyAId}, 'A-Org-2', 'org')`);
      await db.execute(sql`INSERT INTO agents (id, company_id, name, kind) VALUES (gen_random_uuid(), ${companyAId}, 'A-Platform', 'platform')`);
      // Company B: 1 org agent (cross-company isolation check)
      await db.execute(sql`INSERT INTO agents (id, company_id, name, kind) VALUES (gen_random_uuid(), ${companyBId}, 'B-Org-1', 'org')`);

      const listA = await svc.list(companyAId);
      const listB = await svc.list(companyBId);

      expect(listA).toHaveLength(2); // platform agent excluded
      expect(listA.every((a: any) => a.kind === "org")).toBe(true);
      expect(listA.some((a: any) => a.name === "A-Platform")).toBe(false);

      expect(listB).toHaveLength(1); // cross-company isolation
      expect(listB[0].companyId).toBe(companyBId);
    });

    it("a default-kind insert (no kind specified) is treated as 'org' and returned", async () => {
      if (setupError) throw new Error(String(setupError));
      await db.execute(sql`INSERT INTO agents (id, company_id, name) VALUES (gen_random_uuid(), ${companyAId}, 'A-Default-Kind')`);
      const listA = await svc.list(companyAId);
      expect(listA.some((a: any) => a.name === "A-Default-Kind")).toBe(true); // default 'org' backfill behavior
    });
  },
);
