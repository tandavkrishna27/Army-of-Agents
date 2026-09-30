/**
 * A-H7 — real-DB proof that discussionService.linkEntry reassigns the moved
 * entry's `seq` into the TARGET thread's independent seq space (and handles a
 * moved reply's cross-thread parent pointer).
 *
 * The bug: the old linkEntry only flipped `discussionId` and bumped the target's
 * entryCount; it left `seq` untouched. Since seqs are per-thread and there is a
 * partial UNIQUE index on (discussion_id, seq) WHERE seq <> 0, moving an entry
 * whose seq already exists in the target throws Postgres 23505 (unhandled → 500),
 * and even without a collision the target's next addEntry can re-issue the moved
 * entry's seq (a fresh duplicate). This suite needs real Postgres because the
 * partial unique index is what makes the bug observable.
 *
 * Boots embedded-postgres + applies migrations like the other integration suites.
 * Skipped on Windows (embedded-postgres / Issue #114); runs in node:24 Docker / Linux CI.
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

async function seqOf(entryId: string): Promise<number> {
  const [row] = rowsOf(
    await db.execute(sql`SELECT seq FROM discussion_entries WHERE id = ${entryId}`),
  );
  return Number(row.seq);
}

async function entrySeqOf(discussionId: string): Promise<number> {
  const [row] = rowsOf(
    await db.execute(sql`SELECT entry_seq FROM discussions WHERE id = ${discussionId}`),
  );
  return Number(row.entry_seq);
}

async function entryCountOf(discussionId: string): Promise<number> {
  const [row] = rowsOf(
    await db.execute(sql`SELECT entry_count FROM discussions WHERE id = ${discussionId}`),
  );
  return Number(row.entry_count);
}

describe.skipIf(process.platform === "win32")("linkEntry — seq reassignment + moved replies (A-H7, real DB)", () => {
  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-link-entry-seq-"));
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
      const company = await companyService(db).create({ name: "LinkEntry Co" } as never);
      companyId = company.id;
    } catch (err) {
      setupError = err;
      // eslint-disable-next-line no-console
      console.error("[link-entry-seq] embedded-postgres setup failed:", err);
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

  it("reassigns the moved entry's seq into the target thread (no 23505) and advances the target counter", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = discussionService(db);

    // Two independent threads, each with their own seq space.
    const a = await svc.create(companyId, { title: "A" }, "tester");
    const b = await svc.create(companyId, { title: "B" }, "tester");

    // ≥2 entries in each → both threads issue seq 1 and seq 2, so a naive move
    // of A's 2nd entry (seq 2) into B (which already has a seq 2) collides.
    await svc.addEntry(companyId, a.id, { inputType: "write", rawContent: "A-1" }, "tester");
    const a2 = await svc.addEntry(companyId, a.id, { inputType: "write", rawContent: "A-2" }, "tester");
    await svc.addEntry(companyId, b.id, { inputType: "write", rawContent: "B-1" }, "tester");
    await svc.addEntry(companyId, b.id, { inputType: "write", rawContent: "B-2" }, "tester");

    expect(await seqOf(a2.id)).toBe(2); // collides with B's seq 2
    expect(await entrySeqOf(b.id)).toBe(2);

    // OLD code: this throws Postgres 23505 on the partial unique index.
    // FIXED code: the move allocates a fresh target seq (3) and succeeds.
    const result = await svc.linkEntry(companyId, a2.id, b.id);
    expect(result.targetDiscussionId).toBe(b.id);

    const movedSeq = await seqOf(a2.id);
    expect(movedSeq).toBe(3); // B's new entrySeq after the move
    expect(await entrySeqOf(b.id)).toBe(3);
    expect(await entryCountOf(b.id)).toBe(3); // 2 original + moved
    expect(await entryCountOf(a.id)).toBe(1); // 2 original - moved

    // No duplicate seq within B.
    const [dup] = rowsOf(
      await db.execute(sql`
        SELECT seq, COUNT(*) AS n
        FROM discussion_entries
        WHERE discussion_id = ${b.id} AND seq <> 0
        GROUP BY seq
        HAVING COUNT(*) > 1`),
    );
    expect(dup).toBeUndefined();

    // The moved entry actually belongs to B now.
    const [moved] = rowsOf(
      await db.execute(sql`SELECT discussion_id FROM discussion_entries WHERE id = ${a2.id}`),
    );
    expect(String(moved.discussion_id)).toBe(b.id);
  });

  it("B's next addEntry gets a seq strictly greater than the moved entry's (no re-collision)", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = discussionService(db);

    const a = await svc.create(companyId, { title: "A2" }, "tester");
    const b = await svc.create(companyId, { title: "B2" }, "tester");
    await svc.addEntry(companyId, a.id, { inputType: "write", rawContent: "A-1" }, "tester");
    const a2 = await svc.addEntry(companyId, a.id, { inputType: "write", rawContent: "A-2" }, "tester");
    await svc.addEntry(companyId, b.id, { inputType: "write", rawContent: "B-1" }, "tester");
    await svc.addEntry(companyId, b.id, { inputType: "write", rawContent: "B-2" }, "tester");

    await svc.linkEntry(companyId, a2.id, b.id);
    const movedSeq = await seqOf(a2.id);

    // The very next entry added to B must not re-issue the moved entry's seq.
    const next = await svc.addEntry(companyId, b.id, { inputType: "write", rawContent: "B-3" }, "tester");
    const nextSeq = await seqOf(next.id);
    expect(nextSeq).toBeGreaterThan(movedSeq);
  });

  it("rejects moving a reply (non-null parentEntryId) with badRequest", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = discussionService(db);

    const a = await svc.create(companyId, { title: "A3" }, "tester");
    const b = await svc.create(companyId, { title: "B3" }, "tester");
    const parent = await svc.addEntry(
      companyId,
      a.id,
      { inputType: "write", rawContent: "parent" },
      "tester",
    );
    const reply = await svc.addEntry(
      companyId,
      a.id,
      { inputType: "write", rawContent: "reply", parentEntryId: parent.id },
      "tester",
    );

    await expect(svc.linkEntry(companyId, reply.id, b.id)).rejects.toMatchObject({
      status: 400,
    });

    // The reply did NOT move.
    const [row] = rowsOf(
      await db.execute(sql`SELECT discussion_id FROM discussion_entries WHERE id = ${reply.id}`),
    );
    expect(String(row.discussion_id)).toBe(a.id);
  });
});
