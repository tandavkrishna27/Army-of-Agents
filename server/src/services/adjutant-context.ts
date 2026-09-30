/**
 * Adjutant context packager (Task B3, T13).
 *
 * When the Adjutant agent is woken for a thread, it needs three things to
 * reason well:
 *
 *   1. The thread's own entry log (capped — 200 entries by default).
 *   2. The thread's running summary, used as the "older context" stand-in
 *      whenever the entry count exceeds the cap.
 *   3. A handful of RELATED threads in the same company, scored by
 *      `discussions.summary_embedding` cosine similarity, so cross-thread
 *      context can flow without leaking private threads the caller has no
 *      business reading.
 *
 * This file is the pure assembly step. It does NOT spawn the Adjutant runtime,
 * does NOT format the bundle for any specific provider, and does NOT call out
 * to embedding generation — the embedding is already on the thread row by the
 * time we get here (populated by the B1 write-behind queue).
 *
 * Privacy model — three visibility tiers (see THREAD_VISIBILITIES in
 * packages/shared/src/constants.ts):
 *
 *   - "company"    — visible to anyone with company access
 *   - "department" — Phase 1 treats this as accessible to crew agents inside
 *                    the same company. Department-scoped narrowing will land
 *                    in Phase 2 once we have a stable "agent ↔ department"
 *                    binding to check against
 *   - "private"    — visible ONLY when the caller (an agent, passed via
 *                    `callerAgentId`) is listed as a participant in
 *                    `thread_participants`. No `callerAgentId` → private
 *                    threads are dropped entirely. Fail-closed.
 *
 * The candidate set is over-fetched (relatedLimit × 3) before visibility
 * filtering so a private-thread cluster can't starve the result list down
 * to zero accessible neighbors.
 *
 * Embedded-postgres reality: the bundled `pg-embedded` instance does NOT ship
 * pgvector. In environments without vector support, `summary_embedding` is null
 * on every row. P2-T6: rather than returning `relatedThreads: []` in that case,
 * we fall back to core-postgres full-text search (`websearch_to_tsquery` over
 * title+summary) so cross-thread discovery still works in dev. The prod
 * semantic path is unchanged. Tests mock the DB select layer; they don't rely
 * on actual pgvector or full-text SQL semantics.
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { discussions, discussionEntries, threadParticipants } from "@armyofagents/db";
import type { Db } from "@armyofagents/db";

/** Default cap on the entry log returned to the Adjutant. */
const DEFAULT_MAX_ENTRIES = 200;

/** Default size of the related-thread sidecar. */
const DEFAULT_RELATED_THREAD_LIMIT = 5;

/** Multiplier on the candidate set before visibility filtering. */
const RELATED_OVERFETCH_MULTIPLIER = 3;

export interface AdjutantContextOpts {
  /** Cap on `entries.length`. Defaults to 200. When totalEntryCount > maxEntries we mark `usedSummaryFallback = true`. */
  maxEntries?: number;
  /** Max number of accessible related threads to surface. Defaults to 5. */
  relatedThreadLimit?: number;
  /**
   * When packaging context for a specific agent (e.g. Adjutant), pass its id
   * so the "accessible related threads" calculation can include private
   * threads that this agent is a participant in. If omitted, only non-private
   * related threads are surfaced (safe default).
   */
  callerAgentId?: string;
}

export interface RelatedThread {
  id: string;
  title: string | null;
  summaryText: string | null;
  visibility: string;
}

export interface AdjutantContext {
  /** The most recent `maxEntries` entries in chronological order. */
  entries: Array<typeof discussionEntries.$inferSelect>;
  /** Thread.summaryText, or null if the summarizer hasn't produced one yet. */
  summaryText: string | null;
  /**
   * True when totalEntryCount > maxEntries. The Adjutant runtime uses this
   * to decide whether to prefix the entry log with "(earlier context
   * summarized as: …)" so the model knows it doesn't have the full log.
   */
  usedSummaryFallback: boolean;
  /** Up to `relatedThreadLimit` related threads, filtered for visibility. */
  relatedThreads: RelatedThread[];
  /** ThreadIntent[] — empty array when the column is null. */
  intent: string[];
  /** ThreadPhase: discuss|scope|assign|done. */
  phase: string;
  /** 1..3, or null if the thread defers to internal_agent_config. */
  autonomyLevel: number | null;
  /** ThreadVisibility: private|department|company. */
  visibility: string;
  /** Total entry rows on the thread (not just the returned slice). */
  totalEntryCount: number;
}

/**
 * Format a 1536-d embedding as a pgvector literal. Mirrors the pattern in
 * `embeddings.ts` / `memory.ts` — keep them in sync if pgvector ever changes
 * its literal grammar.
 */
function toVectorString(embedding: number[]): string {
  // We trust the column dimensionality (defended at insert time) and skip the
  // per-element finite check that `embeddings.toVectorString` does — by the
  // time the value lands in `discussions.summary_embedding` it has already
  // been validated by the write-behind queue.
  return `[${embedding.join(",")}]`;
}

/** A related-thread candidate row before visibility filtering. */
interface RelatedCandidate {
  id: string;
  title: string | null;
  summaryText: string | null;
  visibility: string;
}

/**
 * Resolve which private threads the calling agent participates in (and may
 * therefore see in the related-thread sidecar). Returns an empty set when no
 * `callerAgentId` is supplied — private candidates then all fall through to the
 * fail-closed reject branch in {@link filterRelatedByVisibility}.
 */
async function resolveAccessiblePrivateThreadIds(
  db: Db,
  companyId: string,
  callerAgentId?: string,
): Promise<Set<string>> {
  if (!callerAgentId) return new Set();
  const participantRows = await db
    .select({ threadId: threadParticipants.threadId })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.companyId, companyId),
        eq(threadParticipants.principalType, "agent"),
        eq(threadParticipants.principalId, callerAgentId),
      ),
    );
  return new Set(participantRows.map((r) => r.threadId));
}

/**
 * Apply the three-tier visibility model to a candidate list, cap to
 * `relatedLimit`, and project to the public {@link RelatedThread} shape. Shared
 * by the pgvector path and the dev full-text fallback so both enforce the
 * identical fail-closed privacy rule.
 */
function filterRelatedByVisibility(
  candidates: RelatedCandidate[],
  accessiblePrivateThreadIds: Set<string>,
  relatedLimit: number,
): RelatedThread[] {
  return candidates
    .filter((c) => {
      if (c.visibility === "company") return true;
      // Phase 1: department-scoped threads are visible to any crew agent inside
      // the same company. Phase 2 will tighten this once we wire agent ↔
      // department bindings.
      // TODO(Phase 2): narrow "department" to same-department crew only.
      if (c.visibility === "department") return true;
      if (c.visibility === "private") {
        return accessiblePrivateThreadIds.has(c.id);
      }
      // Unknown visibility — fail closed. Future enum additions should require
      // an explicit branch here.
      return false;
    })
    .slice(0, relatedLimit)
    .map((c) => ({
      id: c.id,
      title: c.title,
      summaryText: c.summaryText,
      visibility: c.visibility,
    }));
}

/**
 * Package the context bundle for an Adjutant wakeup on a single thread.
 *
 * @throws Error when `threadId` does not resolve to a `discussions` row.
 *         (Intentionally throws rather than returning null — a wakeup on a
 *         deleted thread is a programming bug, not a user-visible state.)
 */
export async function packageAdjutantContext(
  db: Db,
  threadId: string,
  opts: AdjutantContextOpts = {},
): Promise<AdjutantContext> {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const relatedLimit = opts.relatedThreadLimit ?? DEFAULT_RELATED_THREAD_LIMIT;

  // ── 1. Fetch the source thread ──────────────────────────────────────────
  const [thread] = await db
    .select()
    .from(discussions)
    .where(eq(discussions.id, threadId))
    .limit(1);

  if (!thread) {
    throw new Error(`Thread ${threadId} not found`);
  }

  // ── 2. Entry-log slice + total count ────────────────────────────────────
  //
  // Two queries because we need *both* the recent window and the exact total
  // (for the summary-fallback flag). Counting then slicing in a single
  // window function is cheaper in raw SQL but the drizzle-orm composition
  // is clearer this way and the discussion_entries index already covers
  // (discussion_id, created_at) for the second query.
  const totalEntryCountRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(discussionEntries)
    .where(eq(discussionEntries.discussionId, threadId));
  const totalEntryCount = totalEntryCountRow[0]?.count ?? 0;

  const usedSummaryFallback = totalEntryCount > maxEntries;

  // Fetch the latest `maxEntries` entries (newest is the most relevant
  // recency signal for the model) then reverse to chronological so the
  // packed bundle reads top-to-bottom in conversation order.
  const recentEntriesDesc = await db
    .select()
    .from(discussionEntries)
    .where(eq(discussionEntries.discussionId, threadId))
    .orderBy(desc(discussionEntries.createdAt))
    .limit(maxEntries);
  const entries = [...recentEntriesDesc].reverse();

  // ── 3. Related threads ──────────────────────────────────────────────────
  // Prod path: pgvector cosine similarity on `summary_embedding`. Dev fallback
  // (P2-T6): the bundled embedded-postgres ships NO pgvector, so embeddings are
  // null on every row and the vector path would always return []. When the
  // source thread has no embedding we fall back to core-postgres full-text
  // search over title+summary so cross-thread discovery still works locally.
  // Both paths share the identical visibility filter.
  let relatedThreads: RelatedThread[] = [];
  // Over-fetch so visibility filtering can drop private threads the caller
  // can't see without starving the final list.
  const overFetch = relatedLimit * RELATED_OVERFETCH_MULTIPLIER;

  if (thread.summaryEmbedding) {
    const vectorStr = toVectorString(thread.summaryEmbedding);

    const candidates = await db
      .select({
        id: discussions.id,
        title: discussions.title,
        summaryText: discussions.summaryText,
        visibility: discussions.visibility,
      })
      .from(discussions)
      .where(
        and(
          eq(discussions.companyId, thread.companyId),
          sql`${discussions.id} <> ${threadId}`,
          sql`${discussions.summaryEmbedding} IS NOT NULL`,
          eq(discussions.status, "active"),
        ),
      )
      .orderBy(sql`${discussions.summaryEmbedding} <=> ${vectorStr}::vector`)
      .limit(overFetch);

    const accessiblePrivateThreadIds = await resolveAccessiblePrivateThreadIds(
      db,
      thread.companyId,
      opts.callerAgentId,
    );
    relatedThreads = filterRelatedByVisibility(candidates, accessiblePrivateThreadIds, relatedLimit);
  } else {
    // ── Dev full-text fallback (P2-T6) ────────────────────────────────────
    // No source embedding → derive a keyword query from the source thread's
    // title (preferred — short and topical) or, lacking a title, the leading
    // words of its summary. `websearch_to_tsquery` is injection-safe and ships
    // with core postgres (NOT pgvector), so this works in embedded-postgres.
    // An empty query (brand-new thread, no title/summary) yields [], matching
    // the prior always-empty behavior — never a regression.
    const rawText = (thread.title ?? thread.summaryText ?? "").trim();
    const queryText = rawText.split(/\s+/).slice(0, 12).join(" ").trim();

    if (queryText.length > 0) {
      const tsVector = sql`to_tsvector('simple', concat_ws(' ', coalesce(${discussions.title}, ''), coalesce(${discussions.summaryText}, '')))`;
      const tsQuery = sql`websearch_to_tsquery('simple', ${queryText})`;

      const candidates = await db
        .select({
          id: discussions.id,
          title: discussions.title,
          summaryText: discussions.summaryText,
          visibility: discussions.visibility,
        })
        .from(discussions)
        .where(
          and(
            eq(discussions.companyId, thread.companyId),
            sql`${discussions.id} <> ${threadId}`,
            eq(discussions.status, "active"),
            sql`${tsVector} @@ ${tsQuery}`,
          ),
        )
        .orderBy(sql`ts_rank_cd(${tsVector}, ${tsQuery}) DESC`)
        .limit(overFetch);

      const accessiblePrivateThreadIds = await resolveAccessiblePrivateThreadIds(
        db,
        thread.companyId,
        opts.callerAgentId,
      );
      relatedThreads = filterRelatedByVisibility(candidates, accessiblePrivateThreadIds, relatedLimit);
    }
  }

  // ── 4. Assemble the bundle ───────────────────────────────────────────────
  return {
    entries,
    summaryText: thread.summaryText,
    usedSummaryFallback,
    relatedThreads,
    // jsonb defaults to [] in schema but we double-defend here in case
    // legacy rows were inserted before the default was set.
    intent: Array.isArray(thread.intent) ? (thread.intent as string[]) : [],
    phase: thread.phase,
    autonomyLevel: thread.autonomyLevel,
    visibility: thread.visibility,
    totalEntryCount,
  };
}
