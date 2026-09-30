import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { drainMentionOutbox, enqueueMentionOutbox, heartbeatClaim } from "../services/mention-outbox.js";
import { discussionService } from "../services/discussions.js";
import { resolveMentionTargets } from "../services/threads.js";

// PR #291 round-6 (#3) — the transactional @mention outbox must guarantee the
// summon survives a post-commit failure and a same-key replay, and fire the
// non-idempotent processMentions EXACTLY ONCE. Needs real Postgres (FOR UPDATE
// SKIP LOCKED + real tx atomicity). Collects + skips on Windows.

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

const PORT = 60300 + Math.floor(Math.random() * 400);
const companyId = "11111111-1111-4111-8111-111111111111";
const discussionId = "22222222-2222-4222-8222-222222222222";

async function countOutbox(entryId: string, status?: string): Promise<number> {
  const rows = await db.execute(
    status
      ? sql`SELECT id FROM discussion_mention_outbox WHERE entry_id = ${entryId} AND status = ${status}`
      : sql`SELECT id FROM discussion_mention_outbox WHERE entry_id = ${entryId}`,
  );
  const arr = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
  return arr.length;
}

async function outboxStatus(entryId: string): Promise<string | null> {
  const rows = await db.execute(
    sql`SELECT status FROM discussion_mention_outbox WHERE entry_id = ${entryId}`,
  );
  const arr = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
  return (arr[0] as { status: string } | undefined)?.status ?? null;
}

/** All resolved mention NAMES across every outbox row for an entry. */
async function outboxMentionNames(entryId: string): Promise<string[]> {
  const rows = await db.execute(
    sql`SELECT mentions FROM discussion_mention_outbox WHERE entry_id = ${entryId}`,
  );
  const arr = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
  const names: string[] = [];
  for (const r of arr as Array<{ mentions: unknown }>) {
    const parsed = typeof r.mentions === "string" ? JSON.parse(r.mentions) : r.mentions;
    if (Array.isArray(parsed)) {
      for (const m of parsed as Array<{ name?: string }>) {
        if (typeof m.name === "string") names.push(m.name);
      }
    }
  }
  return names;
}

beforeAll(async () => {
  if (process.platform === "win32") return;
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mention-outbox-test-"));
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
      VALUES (${companyId}, 'Outbox Co', 'OBX')
    `);
    await db.execute(sql`
      INSERT INTO discussions (id, company_id, title, status, created_by)
      VALUES (${discussionId}, ${companyId}, 'Outbox thread', 'active', 'user:1')
    `);
    // Round-13 #2 / round-14 #3: seed a MULTI-WORD crew agent ("Memory Keeper"),
    // a single-word one ("Scout"), AND a single-word agent ("Memory") whose name
    // is a PREFIX of the multi-word one — so resolveMentionTargets must resolve
    // "@Memory Keeper" to ONLY "Memory Keeper", not also the "Memory" prefix.
    await db.execute(sql`
      INSERT INTO agents (company_id, name, kind)
      VALUES (${companyId}, 'Memory Keeper', 'aoa'), (${companyId}, 'Scout', 'aoa'), (${companyId}, 'Memory', 'aoa')
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

describe.skipIf(process.platform === "win32")("mention outbox (real DB)", () => {
  it("boots the harness", () => {
    expect(setupError).toBeNull();
  });

  it("addEntry enqueues a pending outbox row ATOMICALLY with the entry (a committed entry always has a summon)", async () => {
    const entry = await discussionService(db).addEntry(
      companyId,
      discussionId,
      { rawContent: "@Scout please look", inputType: "write" },
      "user:1",
    );
    // A committed entry carries exactly one pending summon row.
    expect(await countOutbox(entry.id, "pending")).toBe(1);
  });

  it("does NOT enqueue when the entry has no @mention", async () => {
    const entry = await discussionService(db).addEntry(
      companyId,
      discussionId,
      { rawContent: "just thinking out loud", inputType: "write" },
      "user:1",
    );
    expect(await countOutbox(entry.id)).toBe(0);
  });

  it("stores hop_count=0 for a human entry and hop_count=1 for an agent-authored entry (round-8 #1)", async () => {
    const readHop = async (entryId: string): Promise<number | null> => {
      const rows = await db.execute(
        sql`SELECT hop_count FROM discussion_mention_outbox WHERE entry_id = ${entryId}`,
      );
      const arr = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
      return (arr[0] as { hop_count: number } | undefined)?.hop_count ?? null;
    };

    // Human entry → hopCount 0 (start of a cascade).
    const humanEntry = await discussionService(db).addEntry(
      companyId,
      discussionId,
      { rawContent: "@Scout please look", inputType: "write" },
      "user:1",
    );
    expect(await readHop(humanEntry.id)).toBe(0);

    // Agent-authored reply → hopCount 1 (preserves the internal writers' { hopCount: 1 }).
    const agentEntry = await discussionService(db).addEntry(
      companyId,
      discussionId,
      { rawContent: "@Engineer over to you", inputType: "agent", authorAgentId: null },
      "agent:planner",
    );
    expect(await readHop(agentEntry.id)).toBe(1);

    // The worker applies the stored hopCount to processMentions.
    const runMentions = vi.fn(async () => undefined);
    await drainMentionOutbox(db, { runMentions });
    expect(runMentions).toHaveBeenCalledWith(
      db, companyId, discussionId, humanEntry.id, expect.anything(), { hopCount: 0 },
    );
    expect(runMentions).toHaveBeenCalledWith(
      db, companyId, discussionId, agentEntry.id, expect.anything(), { hopCount: 1 },
    );
  });

  it("the worker drains a pending row EXACTLY ONCE and marks it done", async () => {
    // Clear any backlog from earlier tests so this asserts on our row alone.
    await drainMentionOutbox(db, { runMentions: async () => undefined });

    const entryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1";
    await enqueueMentionOutbox(db, {
      companyId,
      discussionId,
      entryId,
      mentions: [{ raw: "@Scout", name: "Scout" }],
    });
    const runMentions = vi.fn(async () => undefined);

    const first = await drainMentionOutbox(db, { runMentions });
    expect(first.processed).toBe(1);
    expect(runMentions).toHaveBeenCalledTimes(1);
    expect(runMentions).toHaveBeenCalledWith(
      db,
      companyId,
      discussionId,
      entryId,
      [{ raw: "@Scout", name: "Scout" }],
      { hopCount: 0 }, // no hopCount enqueued → default 0 (human-originated)
    );
    expect(await outboxStatus(entryId)).toBe("done");

    // Second drain must NOT re-run it (done → exactly-once across restarts).
    const second = await drainMentionOutbox(db, { runMentions });
    expect(second.processed).toBe(0);
    expect(runMentions).toHaveBeenCalledTimes(1);
  });

  it("a crash-orphaned 'processing' row is reclaimed on a later drain", async () => {
    const entryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2";
    await enqueueMentionOutbox(db, {
      companyId,
      discussionId,
      entryId,
      mentions: [{ raw: "@Nova", name: "Nova" }],
    });
    // Simulate a worker that claimed the row then crashed mid-process. Past the
    // 35-min stale window (round-9 #1), it becomes reclaimable.
    await db.execute(sql`
      UPDATE discussion_mention_outbox
      SET status = 'processing', updated_at = now() - interval '40 minutes'
      WHERE entry_id = ${entryId}
    `);

    const runMentions = vi.fn(async () => undefined);
    const result = await drainMentionOutbox(db, { runMentions });
    expect(result.processed).toBe(1);
    expect(runMentions).toHaveBeenCalledTimes(1);
    expect(await outboxStatus(entryId)).toBe("done");
  });

  // ── Round-9 #1/#2: lease / heartbeat / owner-token / per-mention rows ─────
  // Clear any pending/processing backlog from earlier tests so `processed`
  // counts assert on THIS test's rows alone.
  async function nukeBacklog(): Promise<void> {
    await db.execute(sql`UPDATE discussion_mention_outbox SET status='done' WHERE status IN ('pending','processing')`);
  }
  async function readRow(entryId: string): Promise<{ status: string; claim_token: string | null } | null> {
    const rows = await db.execute(
      sql`SELECT status, claim_token FROM discussion_mention_outbox WHERE entry_id = ${entryId}`,
    );
    const arr = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
    return (arr[0] as { status: string; claim_token: string | null } | undefined) ?? null;
  }
  async function rowIdFor(entryId: string): Promise<string> {
    const rows = await db.execute(sql`SELECT id FROM discussion_mention_outbox WHERE entry_id = ${entryId} LIMIT 1`);
    const arr = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
    return String((arr[0] as { id: string } | undefined)?.id ?? "");
  }
  // Live (non-terminal) row counts by status — after nukeBacklog the only
  // pending/processing rows are the current test's.
  async function liveCounts(): Promise<{ processing: number; pending: number }> {
    const rows = await db.execute(
      sql`SELECT status, count(*)::int AS n FROM discussion_mention_outbox WHERE status IN ('pending','processing') GROUP BY status`,
    );
    const arr = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? [])) as Array<{ status: string; n: number }>;
    const by = new Map(arr.map((r) => [r.status, Number(r.n)]));
    return { processing: by.get("processing") ?? 0, pending: by.get("pending") ?? 0 };
  }

  it("claims EACH row just-in-time — while one runs, later rows stay 'pending' (never batch-claimed) (round-10 #1)", async () => {
    await nukeBacklog();
    const entryIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaac401",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaac402",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaac403",
    ];
    for (const entryId of entryIds) {
      await enqueueMentionOutbox(db, { companyId, discussionId, entryId, mentions: [{ raw: "@Seq", name: "Seq" }] });
    }
    // Snapshot the live counts observed DURING each row's run. With per-row
    // claim-before-execute there is EXACTLY ONE 'processing' at a time and the
    // rows whose turn hasn't come are still 'pending' (never pre-claimed).
    const observed: Array<{ processing: number; pending: number }> = [];
    const runMentions = vi.fn(async () => {
      observed.push(await liveCounts());
    });

    const result = await drainMentionOutbox(db, { runMentions });
    expect(result.processed).toBe(3);
    expect(observed).toEqual([
      { processing: 1, pending: 2 }, // row 1 runs; rows 2 & 3 NOT yet claimed
      { processing: 1, pending: 1 }, // row 2 runs; row 3 still pending
      { processing: 1, pending: 0 }, // row 3 runs; none left
    ]);
    // All three completed.
    expect(await liveCounts()).toEqual({ processing: 0, pending: 0 });
  });

  it("a 'processing' claim younger than the stale window is NOT reclaimable; a heartbeat keeps a long claim alive (round-9 #1)", async () => {
    await nukeBacklog();
    const entryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac1";
    await enqueueMentionOutbox(db, { companyId, discussionId, entryId, mentions: [{ raw: "@Long", name: "Long" }] });
    const token = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
    // A live worker's claim, aged near the window but still fresh.
    await db.execute(sql`
      UPDATE discussion_mention_outbox
      SET status = 'processing', claim_token = ${token}, updated_at = now() - interval '34 minutes'
      WHERE entry_id = ${entryId}
    `);
    // 34 min < 35 min window → not reclaimable.
    let result = await drainMentionOutbox(db, { runMentions: async () => undefined });
    expect(result.processed).toBe(0);
    expect((await readRow(entryId))?.status).toBe("processing");

    // A heartbeat (with the owner token) refreshes updated_at → stays alive even
    // if it would otherwise have aged past the window.
    await db.execute(sql`UPDATE discussion_mention_outbox SET updated_at = now() - interval '40 minutes' WHERE entry_id = ${entryId}`);
    await heartbeatClaim(db, await rowIdFor(entryId), token);
    result = await drainMentionOutbox(db, { runMentions: async () => undefined });
    expect(result.processed).toBe(0); // refreshed → still not reclaimable

    // A heartbeat with the WRONG token is a no-op (a reclaimed old owner can't
    // keep the lease alive).
    await db.execute(sql`UPDATE discussion_mention_outbox SET updated_at = now() - interval '40 minutes' WHERE entry_id = ${entryId}`);
    await heartbeatClaim(db, await rowIdFor(entryId), "00000000-0000-4000-8000-000000000000");
    result = await drainMentionOutbox(db, { runMentions: async () => undefined });
    expect(result.processed).toBe(1); // wrong-token heartbeat didn't refresh → reclaimed
  });

  it("a reclaimed original worker's completion is a no-op — it cannot clobber the new owner (round-9 #1)", async () => {
    await nukeBacklog();
    const entryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac2";
    await enqueueMentionOutbox(db, { companyId, discussionId, entryId, mentions: [{ raw: "@Race", name: "Race" }] });
    // The runMentions simulates the row being reclaimed by ANOTHER worker mid-run
    // (its claim_token is rotated). The original worker's terminal write is then
    // guarded by its now-stale token and must be a no-op.
    const runMentions = vi.fn(async (_db: any, _c: string, _d: string, e: string) => {
      await db.execute(sql`UPDATE discussion_mention_outbox SET claim_token = gen_random_uuid() WHERE entry_id = ${e}`);
    });
    await drainMentionOutbox(db, { runMentions });
    // The guarded 'done' write no-ops (token no longer matches) — the row is NOT
    // clobbered to 'done'; it stays 'processing' for the new owner to finish.
    expect((await readRow(entryId))?.status).toBe("processing");
  });

  it("enqueues ONE outbox row PER mention so a failed agent retries without re-summoning the succeeded one (round-9 #2)", async () => {
    await nukeBacklog();
    const entryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac3";
    await enqueueMentionOutbox(db, {
      companyId,
      discussionId,
      entryId,
      mentions: [{ raw: "@Ok", name: "Ok" }, { raw: "@Fail", name: "Fail" }],
    });
    // Two rows, one per mention.
    expect(await countOutbox(entryId, "pending")).toBe(2);

    // @Ok succeeds, @Fail rejects.
    const runMentions = vi.fn(async (_db: any, _c: string, _d: string, _e: string, mentions: Array<{ name: string }>) => {
      if (mentions[0]?.name === "Fail") throw new Error("participation rejected");
    });
    const first = await drainMentionOutbox(db, { runMentions, maxAttempts: 5 });
    expect(first.processed).toBe(1); // @Ok done
    expect(first.failed).toBe(1); // @Fail retried

    // @Ok's row is done and never re-summoned; @Fail's is pending (retry).
    const rows = await db.execute(sql`SELECT status, mentions FROM discussion_mention_outbox WHERE entry_id = ${entryId}`);
    const arr = (Array.isArray(rows) ? rows : (rows as any).rows) as Array<{ status: string; mentions: any }>;
    const byName = new Map(arr.map((r) => [Array.isArray(r.mentions) ? r.mentions[0]?.name : JSON.parse(r.mentions)[0]?.name, r.status]));
    expect(byName.get("Ok")).toBe("done");
    expect(byName.get("Fail")).toBe("pending");

    // A second drain (after backoff) with @Fail now succeeding completes it —
    // and does NOT re-run @Ok (its row is already done).
    await db.execute(sql`UPDATE discussion_mention_outbox SET next_retry_at = now() - interval '1 minute' WHERE entry_id = ${entryId} AND status = 'pending'`);
    const okRuns: string[] = [];
    const runMentions2 = vi.fn(async (_db: any, _c: string, _d: string, _e: string, mentions: Array<{ name: string }>) => {
      okRuns.push(mentions[0]?.name ?? "");
    });
    const second = await drainMentionOutbox(db, { runMentions: runMentions2, maxAttempts: 5 });
    expect(second.processed).toBe(1);
    expect(okRuns).toEqual(["Fail"]); // only the failed agent re-ran; @Ok not re-summoned
  });

  // ── Attachment provenance binding (round-6 #2 security) ──────────────────
  async function insertAsset(id: string, composerValidated: boolean): Promise<void> {
    await db.execute(sql`
      INSERT INTO assets (id, company_id, provider, object_key, content_type, byte_size, sha256, composer_validated)
      VALUES (${id}, ${companyId}, 'memory', ${"k/" + id}, 'text/plain', 10, 'sha', ${composerValidated})
    `);
  }

  it("REJECTS binding a non-composer-validated asset (namespace=files) as a discussion attachment (round-6 #2)", async () => {
    const assetId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
    await insertAsset(assetId, false); // uploaded via namespace=files → not validated
    await expect(
      discussionService(db).addEntry(
        companyId,
        discussionId,
        { rawContent: "see file", inputType: "write", attachments: [{ assetId }] },
        "user:1",
      ),
    ).rejects.toThrow(/not a validated composer upload/i);
  });

  it("ACCEPTS binding a composer-validated asset as a discussion attachment (round-6 #2)", async () => {
    const assetId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
    await insertAsset(assetId, true); // uploaded via a composer namespace → validated
    const entry = await discussionService(db).addEntry(
      companyId,
      discussionId,
      { rawContent: "see file", inputType: "write", attachments: [{ assetId }] },
      "user:1",
    );
    expect(entry.id).toBeTruthy();
  });

  it("a failing summon is retried with backoff, then terminalized as 'failed'", async () => {
    const entryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab3";
    await enqueueMentionOutbox(db, {
      companyId,
      discussionId,
      entryId,
      mentions: [{ raw: "@Boom", name: "Boom" }],
    });
    const runMentions = vi.fn(async () => {
      throw new Error("summon failed");
    });

    const first = await drainMentionOutbox(db, { runMentions, maxAttempts: 2 });
    expect(first.failed).toBe(1);
    // Not terminal yet → back to pending with a backoff (next_retry_at set).
    expect(await outboxStatus(entryId)).toBe("pending");

    // Force the backoff to elapse, then drain again → terminal 'failed'.
    await db.execute(sql`
      UPDATE discussion_mention_outbox SET next_retry_at = now() - interval '1 minute' WHERE entry_id = ${entryId}
    `);
    const second = await drainMentionOutbox(db, { runMentions, maxAttempts: 2 });
    expect(second.failed).toBe(1);
    expect(await outboxStatus(entryId)).toBe("failed");
  });
});

// PR #291 round-13 #2 — the Discussion picker inserts the FULL label ("@Memory
// Keeper"), but the outbox enqueue previously ran the naive parseMentions \w+
// tokenizer, truncating it to "Memory" so the worker never resolved the crew
// agent. resolveMentionTargets now matches complete multi-word company agent
// names (mirroring findMentionedAgents) before enqueueing.
describe.skipIf(process.platform === "win32")("multi-word mention resolution (real DB)", () => {
  it("resolves a MULTI-WORD crew name the naive tokenizer would truncate", async () => {
    const names = (await resolveMentionTargets(db, companyId, "@Memory Keeper please look")).map(
      (m) => m.name,
    );
    // The full name is resolved (the raw "@Memory" token alone would never match).
    expect(names).toContain("Memory Keeper");
  });

  it("still resolves a single-word name via the token pass", async () => {
    const names = (await resolveMentionTargets(db, companyId, "@Scout ping")).map((m) => m.name);
    expect(names).toContain("Scout");
  });

  it("does NOT match a longer name at the trailing boundary (round-9 #4 parity)", async () => {
    const names = (await resolveMentionTargets(db, companyId, "@Memory Keepers rock")).map(
      (m) => m.name,
    );
    // "@Memory Keepers" must not resolve to "Memory Keeper".
    expect(names).not.toContain("Memory Keeper");
  });

  it("addEntry enqueues an outbox row that carries the RESOLVED multi-word name", async () => {
    const entry = await discussionService(db).addEntry(
      companyId,
      discussionId,
      { rawContent: "@Memory Keeper can you take this", inputType: "write" },
      "user:1",
    );
    // The committed entry's outbox rows include the full "Memory Keeper" name, so
    // the worker can resolve + summon the crew agent (exactly-once via one row).
    const names = await outboxMentionNames(entry.id);
    expect(names).toContain("Memory Keeper");
    expect(names.filter((n) => n === "Memory Keeper")).toHaveLength(1);
  });

  // Round-14 #3: the company has BOTH a "Memory" and a "Memory Keeper" agent, so
  // the full-name match must SUPPRESS the "Memory" prefix token it consumed.
  it("resolves @Memory Keeper to ONLY Memory Keeper (suppresses the Memory prefix)", async () => {
    const names = (await resolveMentionTargets(db, companyId, "@Memory Keeper please")).map(
      (m) => m.name,
    );
    expect(names).toContain("Memory Keeper");
    expect(names).not.toContain("Memory");
  });

  it("resolves a standalone @Memory to ONLY Memory", async () => {
    const names = (await resolveMentionTargets(db, companyId, "@Memory what do you think")).map(
      (m) => m.name,
    );
    expect(names).toContain("Memory");
    expect(names).not.toContain("Memory Keeper");
  });

  it("resolves @Memory Keeper and @Memory to BOTH agents", async () => {
    const names = (
      await resolveMentionTargets(db, companyId, "@Memory Keeper and also @Memory please")
    ).map((m) => m.name);
    expect(names).toContain("Memory Keeper");
    expect(names).toContain("Memory");
  });
});

// PR #291 round-15 — the create-with-first-entry route was the LAST non-outbox
// summon path (fire-and-forget processMentions, lost on failure). svc.create now
// enqueues the opening summon IN THE ENTRY-INSERT TRANSACTION, so a committed
// first entry always carries a durable, worker-retried outbox row — exactly like
// addEntry. The route resolves the mentions pre-commit (round-14) and threads
// them into svc.create.
describe.skipIf(process.platform === "win32")("create-with-first-entry summon (real DB)", () => {
  it("commits the discussion + first entry + a PENDING outbox row ATOMICALLY", async () => {
    const content = "@Memory Keeper please open this thread";
    const mentions = await resolveMentionTargets(db, companyId, content);
    const created = await discussionService(db).create(
      companyId,
      { title: "Opener", entry: { inputType: "write", rawContent: content } },
      "user:1",
      mentions,
    );
    expect(created.entry?.id).toBeTruthy();
    // A committed first entry carries its pending summon (the round-15 invariant,
    // mirroring addEntry) — and it is the RESOLVED multi-word name, exactly once.
    const names = await outboxMentionNames(created.entry!.id);
    expect(names).toContain("Memory Keeper");
    expect(names.filter((n) => n === "Memory Keeper")).toHaveLength(1);
    expect(await countOutbox(created.entry!.id, "pending")).toBe(1);
  });

  it("enqueues NO outbox row when the opening message has no @mention", async () => {
    const content = "just opening a thread, no mentions here";
    const mentions = await resolveMentionTargets(db, companyId, content);
    const created = await discussionService(db).create(
      companyId,
      { title: "Quiet opener", entry: { inputType: "write", rawContent: content } },
      "user:1",
      mentions,
    );
    expect(created.entry?.id).toBeTruthy();
    expect(await countOutbox(created.entry!.id)).toBe(0);
  });

  it("the worker drains the opening summon EXACTLY ONCE", async () => {
    const content = "@Scout take a first look";
    const mentions = await resolveMentionTargets(db, companyId, content);
    const created = await discussionService(db).create(
      companyId,
      { title: "Scout opener", entry: { inputType: "write", rawContent: content } },
      "user:1",
      mentions,
    );
    const runMentions = vi.fn(async () => undefined);
    await drainMentionOutbox(db, { runMentions });
    const callsForEntry = runMentions.mock.calls.filter((c) => c[3] === created.entry!.id);
    expect(callsForEntry).toHaveLength(1);
    expect(callsForEntry[0][4]).toEqual(
      expect.arrayContaining([{ raw: "@Scout", name: "Scout" }]),
    );
    // Second drain must NOT re-run it (exactly-once).
    const runAgain = vi.fn(async () => undefined);
    await drainMentionOutbox(db, { runMentions: runAgain });
    expect(runAgain.mock.calls.filter((c) => c[3] === created.entry!.id)).toHaveLength(0);
  });

  it("a failed opening summon leaves the row RECLAIMABLE (not lost)", async () => {
    const content = "@Memory Keeper handle the opener";
    const mentions = await resolveMentionTargets(db, companyId, content);
    const created = await discussionService(db).create(
      companyId,
      { title: "Retry opener", entry: { inputType: "write", rawContent: content } },
      "user:1",
      mentions,
    );
    // The summon throws → the row is not lost; it returns to 'pending' for retry.
    const failing = vi.fn(async () => {
      throw new Error("controller participation failed");
    });
    await drainMentionOutbox(db, { runMentions: failing, maxAttempts: 3 });
    expect(await countOutbox(created.entry!.id, "pending")).toBe(1);
  });
});
