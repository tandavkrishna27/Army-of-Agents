/**
 * Transactional outbox for @mention crew summons (PR #291 round-6 #3).
 *
 * `enqueueMentionOutbox` is called INSIDE the entry-insert transaction, so a
 * committed entry always has a pending summon row (atomic — the whole point).
 * `drainMentionOutbox` is the worker tick: it claims pending (and stale-
 * 'processing', i.e. crash-orphaned) rows with FOR UPDATE SKIP LOCKED, runs
 * `processMentions` exactly once per row, and marks 'done' or schedules a backoff
 * retry. Single-claim + mark-'done' means the non-idempotent hop bump fires once
 * across concurrent workers and across a worker restart. (A crash DURING
 * processMentions can still re-run on the stale reclaim — at-least-once — but
 * that is far rarer, and infinitely better than the old fire-and-forget which
 * lost the summon on any failure.)
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { discussionMentionOutbox } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "mention-outbox" });

export type OutboxMention = { raw: string; name: string };

export type RunMentionsFn = (
  db: Db,
  companyId: string,
  discussionId: string,
  entryId: string,
  mentions: OutboxMention[],
  opts?: { hopCount?: number },
) => Promise<void>;

/**
 * Rows still 'processing' longer than this are treated as crash-orphaned and may
 * be reclaimed. Round-9 #1: raised above the CLI idle timeout (30 min) so a
 * legitimately long controller participation is never reclaimed mid-run — the
 * worker also heartbeats the claim (below) so an actively-running row never ages
 * into this window at all; the window is the crash-recovery backstop.
 */
const STALE_PROCESSING_MINUTES = 35;
/** Heartbeat cadence for an in-flight claim (well under the stale window). */
const HEARTBEAT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BATCH_SIZE = 20;

/**
 * Enqueue summon rows. MUST run inside the entry-insert transaction (`tx`).
 * Round-9 #2: ONE row PER mention (per agent) — so a rejected crew participation
 * retries only THAT agent, and agents that already succeeded (their row is
 * 'done') are never re-summoned (requestParticipation is NOT idempotent per
 * agent: it unconditionally increments the hop, runs the CLI, and posts a reply).
 */
export async function enqueueMentionOutbox(
  tx: Db,
  row: {
    companyId: string;
    discussionId: string;
    entryId: string;
    mentions: OutboxMention[];
    /** Mention-cascade hop count (round-8 #1). 0 = human-originated (default);
     * 1 = an agent-authored reply. Preserves the loop-cap semantics the internal
     * writers' direct { hopCount: 1 } calls had before the outbox owned summons. */
    hopCount?: number;
  },
): Promise<void> {
  if (row.mentions.length === 0) return;
  await tx.insert(discussionMentionOutbox).values(
    row.mentions.map((mention) => ({
      companyId: row.companyId,
      discussionId: row.discussionId,
      entryId: row.entryId,
      mentions: [mention],
      hopCount: row.hopCount ?? 0,
    })),
  );
}

/** Default summon: lazy-import processMentions to keep its heavy crew-runner
 * transitive tree off the worker's module-load path (mirrors threads.ts). */
const defaultRunMentions: RunMentionsFn = async (db, companyId, discussionId, entryId, mentions, opts) => {
  const { processMentions } = await import("./threads.js");
  await processMentions(db, companyId, discussionId, entryId, mentions, opts);
};

export interface DrainOpts {
  batchSize?: number;
  maxAttempts?: number;
  /** Injectable for tests; defaults to the real processMentions. */
  runMentions?: RunMentionsFn;
  /** Lease heartbeat cadence override (tests); defaults to HEARTBEAT_MS. */
  heartbeatMs?: number;
}

export interface DrainResult {
  processed: number;
  failed: number;
}

interface ClaimedRow {
  id: string;
  companyId: string;
  discussionId: string;
  entryId: string;
  mentions: OutboxMention[];
  attempts: number;
  hopCount: number;
  claimToken: string;
}

function normalizeMentions(value: unknown): OutboxMention[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as OutboxMention[]) : [];
}

/** Exponential-ish backoff, capped, mirroring the embedding queue's shape. */
function backoffMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

/** Refresh the lease of a claim THIS worker owns (round-9 #1). No-op if the row
 * was reclaimed (token changed) or already terminalized. Best-effort. Exported
 * for the lease integration test. */
export async function heartbeatClaim(db: Db, id: string, claimToken: string): Promise<void> {
  await db
    .update(discussionMentionOutbox)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(discussionMentionOutbox.id, id),
        eq(discussionMentionOutbox.claimToken, claimToken),
        eq(discussionMentionOutbox.status, "processing"),
      ),
    );
}

/**
 * Atomically claim EXACTLY ONE eligible row (pending+due OR stale-'processing'),
 * marking it 'processing' with a fresh token in the same round-trip. Returns null
 * when nothing is claimable. Round-10 #1: claiming one row immediately before
 * executing it — rather than a batch up front — means no row is ever left in
 * 'processing' un-heartbeated while an EARLIER row's CLI participation runs, so a
 * later row can never age past the stale window and be reclaimed by another
 * worker mid-loop.
 */
async function claimOneRow(db: Db): Promise<ClaimedRow | null> {
  const result = await db.execute(
    sql.raw(`
      WITH claimed AS (
        SELECT id FROM discussion_mention_outbox
        WHERE (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= now()))
           OR (status = 'processing' AND updated_at < now() - interval '${STALE_PROCESSING_MINUTES} minutes')
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE discussion_mention_outbox
      SET status = 'processing', updated_at = now(), claim_token = gen_random_uuid()
      WHERE id IN (SELECT id FROM claimed)
      RETURNING
        id,
        company_id AS "companyId",
        discussion_id AS "discussionId",
        entry_id AS "entryId",
        mentions,
        attempts,
        hop_count AS "hopCount",
        claim_token AS "claimToken"
    `),
  );
  const rawRows = Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? []);
  const r = rawRows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: String(r.id),
    companyId: String(r.companyId),
    discussionId: String(r.discussionId),
    entryId: String(r.entryId),
    mentions: normalizeMentions(r.mentions),
    attempts: Number(r.attempts ?? 0),
    hopCount: Number(r.hopCount ?? 0),
    claimToken: String(r.claimToken),
  };
}

export async function drainMentionOutbox(db: Db, opts: DrainOpts = {}): Promise<DrainResult> {
  // Max rows to process per drain call (throughput cap). Each is claimed
  // just-in-time (claimOneRow) immediately before executing it — never a batch.
  const maxRows = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const runMentions = opts.runMentions ?? defaultRunMentions;
  const heartbeatMs = Math.max(1, opts.heartbeatMs ?? HEARTBEAT_MS);

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < maxRows; i++) {
    // Claim ONE row immediately before running it (round-10 #1).
    const row = await claimOneRow(db);
    if (!row) break;

    // Lease heartbeat (round-9 #1): refresh updated_at while runMentions is in
    // flight — a controller participation CLI run can legitimately outlast the
    // stale window, and without this another worker would reclaim + double-run.
    const hb = setInterval(() => {
      void heartbeatClaim(db, row.id, row.claimToken).catch(() => {});
    }, heartbeatMs);
    if (typeof (hb as { unref?: () => void }).unref === "function") (hb as { unref: () => void }).unref();
    try {
      await runMentions(db, row.companyId, row.discussionId, row.entryId, row.mentions, { hopCount: row.hopCount });
      clearInterval(hb);
      // Owner-guarded terminal write (round-9 #1): only mark done if we still own
      // the claim, so a reclaimed original worker can't clobber the new owner.
      await db
        .update(discussionMentionOutbox)
        .set({ status: "done", updatedAt: new Date() })
        .where(
          and(
            eq(discussionMentionOutbox.id, row.id),
            eq(discussionMentionOutbox.claimToken, row.claimToken),
          ),
        );
      processed += 1;
    } catch (err) {
      clearInterval(hb);
      const attempts = row.attempts + 1;
      const terminal = attempts >= maxAttempts;
      await db
        .update(discussionMentionOutbox)
        .set({
          status: terminal ? "failed" : "pending",
          attempts,
          error: String((err as { message?: string })?.message ?? err).slice(0, 500),
          nextRetryAt: terminal ? null : new Date(Date.now() + backoffMs(attempts)),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(discussionMentionOutbox.id, row.id),
            eq(discussionMentionOutbox.claimToken, row.claimToken),
          ),
        );
      failed += 1;
      log.warn({ err, outboxId: row.id, attempts, terminal }, "mention outbox row failed");
    } finally {
      clearInterval(hb);
    }
  }

  return { processed, failed };
}
