// server/src/services/inbox-producer.ts
//
// Task 0.5 (Inbound Dirty-Data Routing) — single insert chokepoint for all inbound items.
// Task 1.4 (Inbound Dirty-Data Routing) — fire-and-forget async routing after insert.
//
// Every code path that creates a thread_inbox_items row (MCP debrief-push, paste route,
// and the async router in 1.4) must call this function — never insert directly.
//
// Durable dedup (Codex #8):
//   The unique index `thread_inbox_items_company_dedup_idx` on (company_id, dedup_key)
//   is non-partial (no WHERE clause) so it covers ALL statuses. This prevents a
//   re-delivered item — even one that was already attached — from creating a second
//   inbox row and a second thread entry. When the index fires we SELECT the existing
//   row's id and return { deduped: true } instead of propagating the error.
//
// Only the exact index above is caught. Any other 23505 (e.g. a future unique index
// on a different column) propagates normally so real failures are never silently swallowed.
//
// Fire-and-forget routing (Task 1.4, D5):
//   After a fresh (non-deduped) insert the producer triggers routing asynchronously
//   via a dynamic import of inbox-router.js. The producer returns immediately — it is
//   never blocked on embedding or network I/O. The sweep-inbox.ts backstop catches
//   any items whose async route never landed (crash / restart before claim).
//
//   Dynamic import rationale: keeps the producer's static import chain light and avoids
//   the transitive-import mock cascade that has bitten this codebase before (the inbox-
//   router pulls in embeddings, drizzle, and network code that tests must mock carefully).
//   A deduped re-delivery does NOT trigger routing — the existing row is already queued.

import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { threadInboxItems } from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import { isUniqueViolation } from "./db-errors.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "inbox-producer" });

// The exact Drizzle-generated index name for the durable cross-status dedup guard.
const DEDUP_INDEX = "thread_inbox_items_company_dedup_idx";

export interface EnqueueInboxItemArgs {
  companyId: string;
  originMedium: string;
  originSource?: string | null;
  rawContent: string;
}

export interface EnqueueInboxItemResult {
  inboxItemId: string;
  /** true when the item already existed (re-delivered / duplicate). */
  deduped: boolean;
}

/**
 * Compute the canonical dedup key for an inbound item.
 *
 * Formula: SHA-256 of NUL-delimited fields:
 *   companyId + "\0" + originMedium + "\0" + (originSource ?? "") + "\0" + rawContent
 *
 * Exported for use in contract tests that verify key stability.
 */
export function computeDedupKey(
  companyId: string,
  originMedium: string,
  originSource: string | null | undefined,
  rawContent: string,
): string {
  const payload = [companyId, originMedium, originSource ?? "", rawContent].join("\0");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/**
 * Insert a thread_inbox_items row and return its id.
 *
 * On a unique violation against `thread_inbox_items_company_dedup_idx` (durable
 * cross-status dedup, Codex #8) the function SELECTs the existing row and returns
 * { inboxItemId: <existing id>, deduped: true }.
 *
 * All other errors propagate.
 */
export async function enqueueInboxItem(
  db: Db,
  args: EnqueueInboxItemArgs,
): Promise<EnqueueInboxItemResult> {
  const { companyId, originMedium, originSource, rawContent } = args;

  const dedupKey = computeDedupKey(companyId, originMedium, originSource, rawContent);

  try {
    const inserted = await (db as any)
      .insert(threadInboxItems)
      .values({
        companyId,
        status: "pending",
        routingStatus: "pending_route",
        dedupKey,
        originMedium,
        originSource: originSource ?? null,
        rawContent,
      })
      .returning({ id: threadInboxItems.id });

    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    const inboxItemId: string = row.id;

    // ── Fire-and-forget routing (Task 1.4, D5) ────────────────────────────────
    // The producer returns immediately after the durable insert. Routing runs
    // asynchronously; the sweep-inbox.ts backstop catches any items that never
    // get routed (process restart, crash before the dynamic import resolves).
    //
    // Dynamic import keeps the static chain light (avoids the transitive drizzle/
    // embeddings mock cascade). A deduped re-delivery skips this — only fresh items.
    void import("./inbox-router.js")
      .then((m) => m.routeInboxItem(db, { inboxItemId }))
      .catch((err) =>
        log.warn({ err, inboxItemId }, "inbox-producer: async routing failed — sweep backstop will retry"),
      );

    return { inboxItemId, deduped: false };
  } catch (err: unknown) {
    // ── Durable dedup: re-delivered item (Codex #8) ────────────────────────────
    // Only swallow the exact index that guards (company_id, dedup_key).
    // Any other 23505 from a different index propagates.
    if (isUniqueViolation(err, DEDUP_INDEX)) {
      const existingRows = await (db as any)
        .select({ id: threadInboxItems.id })
        .from(threadInboxItems)
        .where(
          and(
            eq(threadInboxItems.companyId, companyId),
            eq(threadInboxItems.dedupKey, dedupKey),
          ),
        );
      const existingId: string = existingRows[0]?.id ?? "";
      return { inboxItemId: existingId, deduped: true };
    }
    throw err;
  }
}
