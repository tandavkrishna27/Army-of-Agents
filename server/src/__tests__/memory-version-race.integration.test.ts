import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  memoryItemVersions,
  type Db,
} from "@armyofagents/db";
import { memoryService } from "../services/memory.js";

// A-M6 — version-number allocation (suggestUpdate / saveDraft / changeLayer)
// must be conflict-safe. Each method previously read max(version_number)+1 then
// inserted with no row lock, so two different agents/users that both pass the
// per-creator dedup check would read the same `latest` and both insert
// `latest+1` → the unique index (memory_item_id, version_number) raises 23505,
// surfacing as an unhandled 500. The fix serializes allocation by taking a
// SELECT … FOR UPDATE on the PARENT memory_items row inside a transaction and
// running the dedup + max-version read + insert inside it.
//
// This race needs real transaction isolation, so it runs against an embedded
// Postgres. It collects + skips on Windows (embedded-postgres can't start on
// the CI Windows runner); the controller runs it on Linux.

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
let setupError: unknown = null;

const PORT = 58000 + Math.floor(Math.random() * 1000);

const companyId = "22222222-2222-4222-8222-222222222222";

// Fresh memory-item id per test so cases never collide on the unique
// (memory_item_id, version_number) index across cases.
function freshItemId(suffix: string) {
  return `cccccccc-cccc-4ccc-8ccc-${suffix.padStart(12, "0")}`;
}

async function seedApprovedItem(id: string, title: string) {
  // Seed an approved memory item with one existing approved version (#1), so
  // the next allocation is #2 for both concurrent callers.
  await db.execute(sql`
    INSERT INTO memory_items (id, company_id, title, content, category, source, status, created_by, layer)
    VALUES (${id}, ${companyId}, ${title}, 'seed content', 'reference', 'founder', 'approved', 'founder-1', 'domain')
  `);
  await db.execute(sql`
    INSERT INTO memory_item_versions (memory_item_id, version_number, content, status, created_by)
    VALUES (${id}, 1, 'seed content', 'approved', 'founder-1')
  `);
}

async function versionRows(itemId: string) {
  return db
    .select({
      versionNumber: memoryItemVersions.versionNumber,
      status: memoryItemVersions.status,
      createdBy: memoryItemVersions.createdBy,
    })
    .from(memoryItemVersions)
    .where(eq(memoryItemVersions.memoryItemId, itemId));
}

beforeAll(async () => {
  if (process.platform === "win32") return; // skipped suite — don't boot pg
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-memver-race-test-"));
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

    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'MemVer Race Co', 'MVR')
    `);
  } catch (err) {
    setupError = err;
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    // ignore cleanup failures
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}, 60_000);

describe.skipIf(process.platform === "win32")(
  "A-M6 — memory version-number allocation is conflict-safe under concurrency",
  () => {
    it("suggestUpdate: two different agents get DISTINCT version numbers, no 23505", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const itemId = freshItemId("a00000000001");
      await seedApprovedItem(itemId, "Suggest race item");

      const svc = memoryService(db);

      // Two DIFFERENT createdBy agents → both pass the per-agent pending dedup,
      // both must allocate. Without the parent-row lock one insert collides on
      // (memory_item_id, version_number) → 23505. With it, they serialize.
      const [a, b] = await Promise.all([
        svc.suggestUpdate(companyId, itemId, "content from agent A", "reason A", "agent-A"),
        svc.suggestUpdate(companyId, itemId, "content from agent B", "reason B", "agent-B"),
      ]);

      // Both succeeded with a row.
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();

      // Distinct version numbers, both > 1 (seed was #1).
      const aVer = (a as { versionNumber: number }).versionNumber;
      const bVer = (b as { versionNumber: number }).versionNumber;
      expect(aVer).not.toBe(bVer);
      expect(new Set([aVer, bVer])).toEqual(new Set([2, 3]));

      // DB reflects three rows total, all distinct version numbers.
      const rows = await versionRows(itemId);
      const numbers = rows.map((r) => r.versionNumber).sort((x, y) => x - y);
      expect(numbers).toEqual([1, 2, 3]);
    });

    it("saveDraft: two different users get DISTINCT version numbers, no 23505", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const itemId = freshItemId("a00000000002");
      await seedApprovedItem(itemId, "Draft race item");

      const svc = memoryService(db);

      const [a, b] = await Promise.all([
        svc.saveDraft(companyId, itemId, "draft from user A", "user-A"),
        svc.saveDraft(companyId, itemId, "draft from user B", "user-B"),
      ]);

      expect(a).toBeTruthy();
      expect(b).toBeTruthy();

      const aVer = (a as { versionNumber: number }).versionNumber;
      const bVer = (b as { versionNumber: number }).versionNumber;
      expect(aVer).not.toBe(bVer);
      expect(new Set([aVer, bVer])).toEqual(new Set([2, 3]));

      const rows = await versionRows(itemId);
      const numbers = rows.map((r) => r.versionNumber).sort((x, y) => x - y);
      expect(numbers).toEqual([1, 2, 3]);
    });
  },
);
