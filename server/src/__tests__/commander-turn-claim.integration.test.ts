import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { conversationService } from "../services/internal-agent/conversation.js";

// PR #291 round-6 (#1) — the durable Commander turn claim (claimTurn CAS) must
// guarantee, across processes, that exactly ONE caller runs a given turn. The
// in-process Set could not do this in a multi-worker deployment. The CAS needs
// real Postgres row-level serialization, so this runs against embedded Postgres.
// It collects + skips on Windows (embedded-postgres can't start on the CI Windows
// runner); the controller runs it on Linux.

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

const PORT = 59900 + Math.floor(Math.random() * 400);

const companyId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";

async function insertUserMessage(id: string, clientSubmissionId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO internal_agent_messages (id, conversation_id, role, content, client_submission_id)
    VALUES (${id}, ${conversationId}, 'user', 'hi', ${clientSubmissionId})
  `);
}

async function readTurnStatus(id: string): Promise<string | null> {
  const rows = await db.execute(sql`SELECT turn_status FROM internal_agent_messages WHERE id = ${id}`);
  const arr = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
  return (arr[0] as { turn_status: string | null } | undefined)?.turn_status ?? null;
}

beforeAll(async () => {
  if (process.platform === "win32") return; // skipped suite — don't boot pg
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-turn-claim-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };

    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();

    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);

    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'Turn Claim Co', 'TCC')
    `);
    await db.execute(sql`
      INSERT INTO internal_agent_conversations (id, company_id, user_id, status)
      VALUES (${conversationId}, ${companyId}, ${userId}, 'active')
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

describe.skipIf(process.platform === "win32")("Commander durable turn claim (real DB)", () => {
  it("boots the harness", () => {
    expect(setupError).toBeNull();
  });

  it("exactly one of two racing claims wins; the loser gets no token", async () => {
    const msgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    await insertUserMessage(msgId, "sub-race");
    const svc = conversationService(db);

    // Two connections race the CAS concurrently. The conditional UPDATE
    // serializes on the row, so exactly one gets a token back.
    const [a, b] = await Promise.all([svc.claimTurn(msgId), svc.claimTurn(msgId)]);
    expect([a, b].filter((t) => t !== null)).toHaveLength(1);
    expect(await readTurnStatus(msgId)).toBe("running");
  });

  it("a fresh 'running' claim cannot be re-acquired (no double-run)", async () => {
    const msgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    await insertUserMessage(msgId, "sub-fresh-running");
    const svc = conversationService(db);

    expect(await svc.claimTurn(msgId)).not.toBeNull(); // first wins (token)
    expect(await svc.claimTurn(msgId)).toBeNull(); // still running, fresh → denied
  });

  it("a claim younger than the 35-min window is NOT reclaimable, even at 30 min (round-7 #1)", async () => {
    // A legit turn can idle up to the 30-min CLI idle timeout; the window (35m)
    // must exceed that so a genuinely-alive turn is never reclaimed + double-run.
    const msgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
    await insertUserMessage(msgId, "sub-young");
    const svc = conversationService(db);

    expect(await svc.claimTurn(msgId)).not.toBeNull();
    await db.execute(
      sql`UPDATE internal_agent_messages SET turn_claimed_at = now() - interval '30 minutes' WHERE id = ${msgId}`,
    );
    expect(await svc.claimTurn(msgId)).toBeNull(); // 30m < 35m window → NOT reclaimable
  });

  it("a STALE 'running' claim (past the 35-min window) is reclaimable (owner presumed dead)", async () => {
    const msgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
    await insertUserMessage(msgId, "sub-stale");
    const svc = conversationService(db);

    expect(await svc.claimTurn(msgId)).not.toBeNull();
    await db.execute(
      sql`UPDATE internal_agent_messages SET turn_claimed_at = now() - interval '40 minutes' WHERE id = ${msgId}`,
    );
    expect(await svc.claimTurn(msgId)).not.toBeNull(); // 40m > 35m → reclaimed
  });

  it("a heartbeat keeps a live turn's claim from aging out; a stale reclaim's heartbeat is a no-op (round-7 #1)", async () => {
    const msgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6";
    await insertUserMessage(msgId, "sub-heartbeat");
    const svc = conversationService(db);

    const token = await svc.claimTurn(msgId);
    expect(token).not.toBeNull();
    // Age the lease near the window, then heartbeat with the owner token → fresh.
    await db.execute(
      sql`UPDATE internal_agent_messages SET turn_claimed_at = now() - interval '34 minutes' WHERE id = ${msgId}`,
    );
    await svc.heartbeatTurn(msgId, token!);
    // Refreshed → a duplicate cannot reclaim it.
    expect(await svc.claimTurn(msgId)).toBeNull();

    // A WRONG token (a reclaimed old owner) cannot bump the lease.
    await db.execute(
      sql`UPDATE internal_agent_messages SET turn_claimed_at = now() - interval '40 minutes' WHERE id = ${msgId}`,
    );
    await svc.heartbeatTurn(msgId, "00000000-0000-4000-8000-000000000000");
    // Lease still stale (heartbeat no-op) → reclaimable, which mints a NEW token.
    const newToken = await svc.claimTurn(msgId);
    expect(newToken).not.toBeNull();
    expect(newToken).not.toBe(token);
  });

  it("'done'/'failed' obey the owner token; a non-owner cannot overwrite (round-7 #1)", async () => {
    const msgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
    await insertUserMessage(msgId, "sub-terminal");
    const svc = conversationService(db);

    const token = await svc.claimTurn(msgId);
    expect(token).not.toBeNull();

    // A stale non-owner's finishTurn is a no-op (still running).
    await svc.finishTurn(msgId, "11111111-1111-4111-8111-111111111111", "failed");
    expect(await readTurnStatus(msgId)).toBe("running");

    await svc.finishTurn(msgId, token!, "done");
    expect(await readTurnStatus(msgId)).toBe("done");
    expect(await svc.claimTurn(msgId)).toBeNull(); // done → never reclaimed

    await svc.finishTurn(msgId, token!, "failed");
    expect(await svc.claimTurn(msgId)).not.toBeNull(); // failed → reclaimable
  });
});
