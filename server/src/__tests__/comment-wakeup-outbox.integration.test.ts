import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import {
  enqueueCommentWakeupOutbox,
  drainCommentWakeupOutbox,
  markCommentWakeupsReady,
} from "../services/comment-wakeup-outbox.js";

// PR #291 round-16 — the durable PER-TARGET comment-wakeup outbox. Mirrors the
// discussion mention outbox: a multi-agent comment enqueues one pending row per
// target atomically; the worker drains each EXACTLY ONCE; a crash mid-drain
// leaves the row reclaimable; a single-target failure retries ONLY that target;
// a keyed retry re-enqueues without duplicating a target. Needs real Postgres
// (FOR UPDATE SKIP LOCKED + the (comment, agent) unique index). Skips on Windows.

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

const PORT = 61200 + Math.floor(Math.random() * 400);
const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
const AGENT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";

async function countRows(commentId: string, status?: string): Promise<number> {
  const rows = await db.execute(
    status
      ? sql`SELECT id FROM comment_wakeup_outbox WHERE comment_id = ${commentId} AND status = ${status}`
      : sql`SELECT id FROM comment_wakeup_outbox WHERE comment_id = ${commentId}`,
  );
  const arr = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
  return arr.length;
}

async function rowStatus(commentId: string, agentId: string): Promise<string | null> {
  const rows = await db.execute(
    sql`SELECT status FROM comment_wakeup_outbox WHERE comment_id = ${commentId} AND target_agent_id = ${agentId}`,
  );
  const arr = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
  return (arr[0] as { status: string } | undefined)?.status ?? null;
}

beforeAll(async () => {
  if (process.platform === "win32") return;
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-comment-wakeup-outbox-test-"));
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
      INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Wakeup Co', 'WAK')
    `);
    await db.execute(sql`
      INSERT INTO issues (id, company_id, title, status) VALUES (${issueId}, ${companyId}, 'Task', 'todo')
    `);
    // A crew (kind='aoa') agent so the default runWakeup routes to
    // enqueueAoaMentionWakeup (a simple agent_wakeup_requests insert) for the
    // round-17 #2 idempotent-consumer test.
    await db.execute(sql`
      INSERT INTO agents (id, company_id, name, kind) VALUES (${AGENT_A}, ${companyId}, 'Scout', 'aoa')
    `);
  } catch (err) {
    setupError = err;
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

let commentSeq = 0;
function nextCommentId(): string {
  commentSeq += 1;
  const hex = commentSeq.toString(16).padStart(12, "0");
  return `cccccccc-cccc-4ccc-8ccc-${hex}`;
}

describe.skipIf(process.platform === "win32")("comment wakeup outbox (real DB)", () => {
  it("boots the harness", () => {
    expect(setupError).toBeNull();
  });

  it("enqueues one PENDING row PER TARGET", async () => {
    const commentId = nextCommentId();
    await enqueueCommentWakeupOutbox(db, {
      companyId,
      issueId,
      commentId,
      targets: [
        { agentId: AGENT_A, wakeup: { reason: "issue_commented" } },
        { agentId: AGENT_B, wakeup: { reason: "issue_comment_mentioned" } },
      ],
    });
    expect(await countRows(commentId, "pending")).toBe(2);
  });

  it("re-enqueueing the SAME targets is idempotent on (comment, agent)", async () => {
    const commentId = nextCommentId();
    const targets = [
      { agentId: AGENT_A, wakeup: { reason: "issue_commented" } },
      { agentId: AGENT_B, wakeup: { reason: "issue_comment_mentioned" } },
    ];
    await enqueueCommentWakeupOutbox(db, { companyId, issueId, commentId, targets });
    // A keyed retry re-enqueues the same targets — no new rows (round-16 #2).
    await enqueueCommentWakeupOutbox(db, { companyId, issueId, commentId, targets });
    expect(await countRows(commentId)).toBe(2);
  });

  it("the worker drains each target EXACTLY ONCE and marks it done", async () => {
    const commentId = nextCommentId();
    await enqueueCommentWakeupOutbox(db, {
      companyId,
      issueId,
      commentId,
      targets: [
        { agentId: AGENT_A, wakeup: { reason: "issue_commented" } },
        { agentId: AGENT_B, wakeup: { reason: "issue_comment_mentioned" } },
      ],
    });

    const runWakeup = vi.fn(async () => undefined);
    await drainCommentWakeupOutbox(db, { runWakeup });
    // Each target dispatched once for THIS comment.
    const forComment = runWakeup.mock.calls.filter(
      (c) => (c[1] as { commentId: string }).commentId === commentId,
    );
    expect(forComment).toHaveLength(2);
    expect(await countRows(commentId, "done")).toBe(2);

    // Second drain must NOT re-run them (exactly-once across restarts).
    const again = vi.fn(async () => undefined);
    await drainCommentWakeupOutbox(db, { runWakeup: again });
    expect(
      again.mock.calls.filter((c) => (c[1] as { commentId: string }).commentId === commentId),
    ).toHaveLength(0);
  });

  it("retries ONLY the failed target — a succeeded sibling stays done (no double-wake)", async () => {
    const commentId = nextCommentId();
    await enqueueCommentWakeupOutbox(db, {
      companyId,
      issueId,
      commentId,
      targets: [
        { agentId: AGENT_A, wakeup: { reason: "issue_commented" } },
        { agentId: AGENT_B, wakeup: { reason: "issue_comment_mentioned" } },
      ],
    });

    // Agent B's dispatch fails; Agent A's succeeds.
    const runWakeup = vi.fn(async (_db: Db, row: { targetAgentId: string }) => {
      if (row.targetAgentId === AGENT_B) throw new Error("participation failed");
    });
    await drainCommentWakeupOutbox(db, { runWakeup, maxAttempts: 5 });

    // A is done (delivered once); B is back to pending for retry (not lost).
    expect(await rowStatus(commentId, AGENT_A)).toBe("done");
    expect(await rowStatus(commentId, AGENT_B)).toBe("pending");

    // A later drain (B now succeeds) delivers ONLY B — A is never re-dispatched.
    await db.execute(
      sql`UPDATE comment_wakeup_outbox SET next_retry_at = now() - interval '1 minute' WHERE comment_id = ${commentId}`,
    );
    const retryRun = vi.fn(async () => undefined);
    await drainCommentWakeupOutbox(db, { runWakeup: retryRun });
    const delivered = retryRun.mock.calls
      .filter((c) => (c[1] as { commentId: string }).commentId === commentId)
      .map((c) => (c[1] as { targetAgentId: string }).targetAgentId);
    expect(delivered).toEqual([AGENT_B]);
    expect(await rowStatus(commentId, AGENT_B)).toBe("done");
  });

  it("a crash-orphaned 'processing' row is reclaimed on a later drain", async () => {
    const commentId = nextCommentId();
    await enqueueCommentWakeupOutbox(db, {
      companyId,
      issueId,
      commentId,
      targets: [{ agentId: AGENT_A, wakeup: { reason: "issue_commented" } }],
    });
    // Simulate a worker that claimed the row then crashed mid-dispatch, past the
    // 5-min stale window.
    await db.execute(
      sql`UPDATE comment_wakeup_outbox
          SET status = 'processing', claim_token = gen_random_uuid(), updated_at = now() - interval '10 minutes'
          WHERE comment_id = ${commentId}`,
    );
    const runWakeup = vi.fn(async () => undefined);
    await drainCommentWakeupOutbox(db, { runWakeup });
    // Reclaimed + delivered (not lost).
    expect(
      runWakeup.mock.calls.filter((c) => (c[1] as { commentId: string }).commentId === commentId),
    ).toHaveLength(1);
    expect(await rowStatus(commentId, AGENT_A)).toBe("done");
  });

  it("terminalizes a persistently-failing target as 'failed' after maxAttempts", async () => {
    const commentId = nextCommentId();
    await enqueueCommentWakeupOutbox(db, {
      companyId,
      issueId,
      commentId,
      targets: [{ agentId: AGENT_A, wakeup: { reason: "issue_commented" } }],
    });
    const boom = vi.fn(async () => {
      throw new Error("always fails");
    });
    // First attempt → pending w/ backoff; force it due, second attempt → failed.
    await drainCommentWakeupOutbox(db, { runWakeup: boom, maxAttempts: 2 });
    expect(await rowStatus(commentId, AGENT_A)).toBe("pending");
    await db.execute(
      sql`UPDATE comment_wakeup_outbox SET next_retry_at = now() - interval '1 minute' WHERE comment_id = ${commentId}`,
    );
    await drainCommentWakeupOutbox(db, { runWakeup: boom, maxAttempts: 2 });
    expect(await rowStatus(commentId, AGENT_A)).toBe("failed");
  });

  // Round-18 #2/#3: the deferred→ready gate holds a wakeup until the side effects
  // it references (attachments / control effects) are durable.
  it("does NOT drain a row whose ready_at is still in the future (deferred)", async () => {
    const commentId = nextCommentId();
    await enqueueCommentWakeupOutbox(db, {
      companyId,
      issueId,
      commentId,
      targets: [{ agentId: AGENT_B, wakeup: { reason: "issue_commented" } }],
      readyAt: new Date(Date.now() + 60_000),
    });
    const runWakeup = vi.fn(async () => undefined);
    await drainCommentWakeupOutbox(db, { runWakeup });
    // Not yet drainable → never dispatched, still pending.
    expect(runWakeup.mock.calls.filter((c) => (c[1] as { commentId: string }).commentId === commentId)).toHaveLength(0);
    expect(await rowStatus(commentId, AGENT_B)).toBe("pending");
  });

  it("drains after markCommentWakeupsReady flips ready_at", async () => {
    const commentId = nextCommentId();
    await enqueueCommentWakeupOutbox(db, {
      companyId,
      issueId,
      commentId,
      targets: [{ agentId: AGENT_B, wakeup: { reason: "issue_commented" } }],
      readyAt: new Date(Date.now() + 60_000),
    });
    // Still deferred → not drained.
    const before = vi.fn(async () => undefined);
    await drainCommentWakeupOutbox(db, { runWakeup: before });
    expect(before.mock.calls.filter((c) => (c[1] as { commentId: string }).commentId === commentId)).toHaveLength(0);

    // The route flips it ready once the side effects are durable → now drainable.
    await markCommentWakeupsReady(db, commentId);
    const runWakeup = vi.fn(async () => undefined);
    await drainCommentWakeupOutbox(db, { runWakeup });
    expect(runWakeup.mock.calls.filter((c) => (c[1] as { commentId: string }).commentId === commentId)).toHaveLength(1);
    expect(await rowStatus(commentId, AGENT_B)).toBe("done");
  });

  it("auto-drains once the ready_at grace window has elapsed (crash backstop)", async () => {
    const commentId = nextCommentId();
    // Simulate a crash BEFORE the ready-flip: ready_at is set (grace) but already
    // elapsed. The worker drains it anyway (durability preserved).
    await enqueueCommentWakeupOutbox(db, {
      companyId,
      issueId,
      commentId,
      targets: [{ agentId: AGENT_B, wakeup: { reason: "issue_commented" } }],
      readyAt: new Date(Date.now() - 1_000),
    });
    const runWakeup = vi.fn(async () => undefined);
    await drainCommentWakeupOutbox(db, { runWakeup });
    expect(runWakeup.mock.calls.filter((c) => (c[1] as { commentId: string }).commentId === commentId)).toHaveLength(1);
    expect(await rowStatus(commentId, AGENT_B)).toBe("done");
  });

  // Round-17 #2: the DEFAULT dispatch is idempotent. If the worker dispatches the
  // downstream wakeup then crashes before marking the row done, a re-drain must
  // NOT double-wake — the dispatch is deduped by the idempotency key.
  it("does NOT double-dispatch on a re-drain after a mark-done crash (idempotent consumer)", async () => {
    const commentId = nextCommentId();
    await enqueueCommentWakeupOutbox(db, {
      companyId,
      issueId,
      commentId,
      targets: [{ agentId: AGENT_A, wakeup: { reason: "issue_comment_mentioned" } }],
    });

    async function countWakeups(): Promise<number> {
      const rows = await db.execute(
        sql`SELECT id FROM agent_wakeup_requests WHERE idempotency_key LIKE 'comment-wakeup:%' AND agent_id = ${AGENT_A}`,
      );
      const arr = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
      return arr.length;
    }

    // First drain: the default dispatch resolves kind='aoa' → enqueueAoaMentionWakeup
    // → exactly ONE agent_wakeup_requests row tagged with the outbox row's key.
    await drainCommentWakeupOutbox(db);
    expect(await countWakeups()).toBe(1);
    expect(await countRows(commentId, "done")).toBe(1);

    // Simulate: the worker had dispatched but crashed before marking done — the row
    // is 'processing' past the stale window. A re-drain reclaims it and re-runs the
    // default dispatch, which must SKIP (the agent_wakeup_requests row already
    // exists for this key) — so still exactly ONE wakeup, no double-wake.
    await db.execute(
      sql`UPDATE comment_wakeup_outbox
          SET status = 'processing', claim_token = gen_random_uuid(), updated_at = now() - interval '10 minutes'
          WHERE comment_id = ${commentId}`,
    );
    await drainCommentWakeupOutbox(db);
    expect(await countWakeups()).toBe(1);
    expect(await countRows(commentId, "done")).toBe(1);
  });
});
