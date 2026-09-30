// server/src/services/inbox-attach.ts
//
// Task 0.3 (Inbound Dirty-Data Routing) — shared content-posting attach/promote write-path.
//
// Fixes Codex #6: the existing triage route's `attach` action only sets status='attached'
// on the inbox row — it NEVER inserts a discussion_entries row, so rawContent is lost.
// This service is the load-bearing fix: inbound content actually LANDS in the thread as
// an entry. Task 0.4 will rewire the human-triage routes + the router's auto-attach to
// call this service instead of writing directly.
//
// Security (Codex #5): companyId is validated BEFORE entering any transaction.
// If the inbox item or target thread belongs to a different company → COMPANY_MISMATCH.
//
// Atomicity: the inbox row is claimed (pending→attached) in ONE transaction together with
// the discussion_entries insert + the entrySeq/entryCount bump. If any step fails, the
// entire transaction rolls back — no duplicate entries, no ghost "attached" rows without
// a matching entry.
//
// Idempotency: the claim UPDATE uses a WHERE status='pending' guard. If the row is
// already 'attached' (claim returns 0 rows), we return { posted:false, alreadyHandled:true }
// without inserting a duplicate entry.
//
// inputType mapping: mirrors inbox-attach-to-thread.ts — originMedium is used if it maps
// to a valid DiscussionEntryInputType, otherwise falls back to 'mcp'.
//
// Provenance authorship: originSource is used as the entry's createdBy. If originSource
// is null or undefined, we fall back to 'system' — this matches how crew-result-relay and
// other system-authored paths stamp entries when there is no clean human/agent actor id.
// authorAgentId is left null for inbox-sourced entries because originSource is a free
// string (not a validated agents.id uuid) and writing a bad uuid would violate the FK.

import { and, eq, sql } from "drizzle-orm";
import { discussionEntries, discussions, threadInboxItems } from "@armyofagents/db";
import { DISCUSSION_ENTRY_INPUT_TYPES } from "@armyofagents/shared";
import type { Db } from "@armyofagents/db";
import { publishLiveEvent } from "./live-events.js";
import { discussionService } from "./discussions.js";

const VALID_INPUT_TYPES = new Set<string>(DISCUSSION_ENTRY_INPUT_TYPES as readonly string[]);

// ── Public API ────────────────────────────────────────────────────────────────

export interface AttachResult {
  posted: boolean;
  entryId: string | null;
  alreadyHandled: boolean;
}

export interface PromoteResult {
  threadId: string | null;
  entryId: string | null;
  /** True when a concurrent caller already claimed+created the thread.
   * No new thread was created. Callers must handle this gracefully. */
  alreadyHandled: boolean;
}

/**
 * Attach an inbox item to an existing thread as a discussion_entries row.
 *
 * @throws {Error} with message containing "COMPANY_MISMATCH" when the inbox
 *   item or target thread is not found or belongs to a different company (Codex #5).
 * @throws {Error} for any other DB error inside the transaction.
 */
export async function attachInboxItemToThread(
  db: Db,
  args: {
    companyId: string;
    inboxItemId: string;
    threadId: string;
    actor: { actorId: string; actorType: string; agentId?: string | null };
  },
): Promise<AttachResult> {
  const { companyId, inboxItemId, threadId } = args;

  // ── Step 1: companyId validation (Codex #5) ─────────────────────────────────
  // Pre-flight SELECTs before the transaction so mismatches are caught cheaply,
  // before we acquire any row locks. Mirror scope-proposal-writer.ts pattern.
  const inboxRows = await (db as any)
    .select({
      id: threadInboxItems.id,
      companyId: threadInboxItems.companyId,
      rawContent: threadInboxItems.rawContent,
      originSource: threadInboxItems.originSource,
      originMedium: threadInboxItems.originMedium,
      status: threadInboxItems.status,
    })
    .from(threadInboxItems)
    .where(eq(threadInboxItems.id, inboxItemId));

  const item = inboxRows[0] ?? null;
  if (!item || item.companyId !== companyId) {
    throw new Error(
      `COMPANY_MISMATCH: inbox item ${inboxItemId} not found or belongs to a different company`,
    );
  }

  const threadRows = await (db as any)
    .select({ companyId: discussions.companyId })
    .from(discussions)
    .where(eq(discussions.id, threadId));

  const thread = threadRows[0] ?? null;
  if (!thread || thread.companyId !== companyId) {
    throw new Error(
      `COMPANY_MISMATCH: thread ${threadId} not found or belongs to a different company`,
    );
  }

  // ── Step 2: originMedium → inputType mapping ─────────────────────────────────
  // Mirror inbox-attach-to-thread.ts: use originMedium if it's a valid
  // DiscussionEntryInputType, otherwise fall back to 'mcp'.
  const candidateInputType = item.originMedium ?? "mcp";
  const inputType = VALID_INPUT_TYPES.has(candidateInputType)
    ? candidateInputType
    : "mcp";

  // ── Step 3: provenance author ─────────────────────────────────────────────────
  // originSource is a free string (ThreadOriginSource) — not necessarily a valid
  // agents.id uuid. We use it as createdBy (text column) but leave authorAgentId
  // null to avoid FK violations. Fall back to 'system' when absent.
  const createdBy = item.originSource ?? "system";

  // ── Step 4: atomic claim + entry insert + seq bump ──────────────────────────
  // Everything in ONE transaction: claim the inbox row, bump entrySeq/entryCount,
  // insert the discussion_entries row. If the claim returns 0 rows (already
  // attached), return the idempotent result immediately without inserting a
  // duplicate entry.
  const txResult = await (db as any).transaction(async (tx: any) => {
    // Atomic claim: only claims if status='pending'. If already 'attached',
    // returns 0 rows → idempotent path.
    const claimed = await tx
      .update(threadInboxItems)
      .set({
        status: "attached",
        routingStatus: "routed",
        routedAt: new Date(),
        suggestedThreadId: threadId,
      })
      .where(
        and(
          eq(threadInboxItems.id, inboxItemId),
          eq(threadInboxItems.status, "pending"),
        ),
      )
      .returning({ id: threadInboxItems.id });

    if (!claimed || claimed.length === 0) {
      // Already handled — no duplicate entry.
      return { alreadyHandled: true, entry: null, entrySeq: 0, companyId };
    }

    // Bump entrySeq + entryCount atomically (mirrors scope-proposal-writer.ts).
    const [{ entrySeq, companyId: threadCompanyId }] = await tx
      .update(discussions)
      .set({
        entrySeq: sql`${discussions.entrySeq} + 1`,
        entryCount: sql`${discussions.entryCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(discussions.id, threadId))
      .returning({
        entrySeq: discussions.entrySeq,
        companyId: discussions.companyId,
      });

    // Insert the discussion_entries row carrying the inbox item's rawContent.
    const inserted = await tx
      .insert(discussionEntries)
      .values({
        discussionId: threadId,
        inputType,
        rawContent: item.rawContent,
        sourceInfo: {
          originSource: item.originSource,
          fromInboxItem: inboxItemId,
        },
        authorAgentId: null, // originSource is a free string, not a validated agents.id
        createdBy,
        extractionStatus: "skipped",
        seq: entrySeq,
      })
      .returning();

    const entry = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!entry || !entry.id) {
      throw new Error("discussion_entries insert returned no row");
    }

    return { alreadyHandled: false, entry, entrySeq, companyId: threadCompanyId };
  });

  if (txResult.alreadyHandled) {
    return { posted: false, entryId: null, alreadyHandled: true };
  }

  // ── Step 5: live events (happy path only) ─────────────────────────────────────
  // Publish the same pair as scope-proposal-writer.ts.
  const { entry, companyId: cid } = txResult;
  publishLiveEvent({
    companyId: cid,
    type: "discussion.entry.created",
    payload: {
      discussionId: threadId,
      entryId: entry.id,
      inputType,
    },
  });
  publishLiveEvent({
    companyId: cid,
    type: "thread.entry.created",
    payload: {
      threadId,
      entryId: entry.id,
      seq: entry.seq ?? 0,
    },
  });

  return { posted: true, entryId: entry.id, alreadyHandled: false };
}

/**
 * Promote an inbox item to a brand-new thread, posting the rawContent as
 * the first discussion_entries row.
 *
 * @throws {Error} with message containing "COMPANY_MISMATCH" when the inbox
 *   item is not found or belongs to a different company (Codex #5).
 * @throws {Error} for any other DB error.
 */
export async function promoteInboxItemToNewThread(
  db: Db,
  args: {
    companyId: string;
    inboxItemId: string;
    actor: { actorId: string; actorType: string; agentId?: string | null };
  },
): Promise<PromoteResult> {
  const { companyId, inboxItemId, actor } = args;

  // ── Step 1: companyId validation (Codex #5) ─────────────────────────────────
  const inboxRows = await (db as any)
    .select({
      id: threadInboxItems.id,
      companyId: threadInboxItems.companyId,
      rawContent: threadInboxItems.rawContent,
      originSource: threadInboxItems.originSource,
      originMedium: threadInboxItems.originMedium,
      suggestedThreadTitle: threadInboxItems.suggestedThreadTitle,
    })
    .from(threadInboxItems)
    .where(eq(threadInboxItems.id, inboxItemId));

  const item = inboxRows[0] ?? null;
  if (!item || item.companyId !== companyId) {
    throw new Error(
      `COMPANY_MISMATCH: inbox item ${inboxItemId} not found or belongs to a different company`,
    );
  }

  // ── Step 2: inputType + author ───────────────────────────────────────────────
  const candidateInputType = item.originMedium ?? "mcp";
  const inputType = VALID_INPUT_TYPES.has(candidateInputType)
    ? candidateInputType
    : "mcp";
  const createdBy = item.originSource ?? "system";

  // ── Step 3: claim-first + create thread + post entry (in one transaction) ─────
  // Atomic claim-first: we claim the inbox row (pending → attached) BEFORE creating
  // the thread. If the claim returns 0 rows, a concurrent caller already won the
  // claim — return alreadyHandled:true without creating a duplicate thread.
  //
  // This closes the double-create TOCTOU race: two concurrent callers can't both
  // create a new thread for the same inbox item.
  //
  // companyId is included in the claim WHERE as defense-in-depth (Lens A) — it
  // mirrors the attachInboxItemToThread claim pattern.
  const result = await (db as any).transaction(async (tx: any) => {
    // Atomic claim: only claims if status='pending'. If already 'attached' or
    // claimed by a concurrent caller, returns 0 rows → alreadyHandled path.
    const claimed = await tx
      .update(threadInboxItems)
      .set({
        status: "attached",
        routingStatus: "routed",
        routedAt: new Date(),
      })
      .where(
        and(
          eq(threadInboxItems.id, inboxItemId),
          eq(threadInboxItems.companyId, companyId),
          eq(threadInboxItems.status, "pending"),
        ),
      )
      .returning({ id: threadInboxItems.id });

    if (!claimed || claimed.length === 0) {
      // Already handled by a concurrent caller — do NOT create a duplicate thread.
      return { alreadyHandled: true, created: null };
    }

    const txSvc = discussionService(tx as unknown as Db);

    // Create the discussion WITH the first entry in a single call.
    const created = await txSvc.create(
      companyId,
      {
        // Prefer the Navigator's suggest_new title (D2) when present — it's the
        // clean human-readable title shown in the suggest_new banner. Fall back to
        // the rawContent-derived title for plain/override promotes (no suggestion).
        title:
          item.suggestedThreadTitle?.trim() ||
          item.rawContent.slice(0, 80).replace(/\n/g, " ") ||
          "New thread",
        entry: {
          inputType,
          rawContent: item.rawContent,
          sourceInfo: {
            originSource: item.originSource,
            fromInboxItem: inboxItemId,
          },
        },
      },
      createdBy,
    );

    // Backfill suggestedThreadId now that we have the created thread id.
    await tx
      .update(threadInboxItems)
      .set({ suggestedThreadId: created.id })
      .where(
        and(
          eq(threadInboxItems.id, inboxItemId),
          eq(threadInboxItems.companyId, companyId),
        ),
      );

    return { alreadyHandled: false, created };
  });

  if (result.alreadyHandled) {
    return { threadId: null, entryId: null, alreadyHandled: true };
  }

  const entryId = result.created?.entry?.id ?? null;
  if (!entryId) {
    throw new Error("promote: discussion was created but first entry id is missing");
  }

  return { threadId: result.created.id, entryId, alreadyHandled: false };
}
