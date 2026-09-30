// server/src/services/internal-agent/tools/submit-extracted-items.ts
//
// THE LINCHPIN: the internal-agent tool a discussion-extraction agent calls to
// persist its structured output. AoA agents do NOT have stdout parsed by the
// runner — they persist results by calling this tool through the bridge.
//
// Mirrors the exact ExtractedItem -> discussion_extracted_items value mapping
// used by server/src/services/extraction.ts (lines ~597-627) so an agent-driven
// submission produces rows indistinguishable from legacy in-process extraction.

import type { AgentTool } from "../types.js";
// publishLiveEvent is a runtime value (not a type) — static top import,
// mirroring extraction.ts:5. live-events.ts only imports node:events + a
// shared type, so this introduces no circular-import at module load.
import { publishLiveEvent } from "../../live-events.js";
import { buildDiscussionPendingHubEmit, emitHubItem } from "../../hub-source-producers.js";

interface SubmitItem {
  type: string;
  content: string;
  confidence?: number;
}

/**
 * Internal-agent tool: write extracted items for a discussion entry and mark
 * the entry's extraction terminal status to "completed" (the same success
 * terminal value extraction.ts sets — see schema discussion_entries).
 *
 * Category `discussion` => automatically gated on the `discussion_processing`
 * capability via authorizeToolInvocation/CAPABILITY_TO_CATEGORY (same gating
 * path as the existing `extract_from_content` tool — no per-tool gating added).
 */
export const submitExtractedItemsTool: AgentTool = {
  name: "submit_extracted_items",
  description:
    "Persist structured extracted items (decisions, tasks, insights, etc.) for a discussion entry and mark the entry's extraction as completed. Called by the discussion-extraction agent to write its results.",
  parameters: {
    type: "object",
    properties: {
      entryId: {
        type: "string",
        description: "Discussion entry ID these items were extracted from (required)",
      },
      items: {
        type: "array",
        description: "Extracted items to persist (required; may be empty)",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description:
                "Item type: 'decision' | 'task' | 'insight' | 'context' | 'reference' | 'preference' (required)",
            },
            content: {
              type: "string",
              description: "Item content/title (required)",
            },
            confidence: {
              type: "number",
              description: "Optional extraction confidence 0-1",
            },
          },
          required: ["type", "content"],
        },
      },
    },
    required: ["entryId", "items"],
  },
  category: "discussion",
  requiredRole: "founder",
  requiresConfirmation: false,
  execute: async (params: unknown, ctx) => {
    const { entryId, items } = (params ?? {}) as {
      entryId?: unknown;
      items?: unknown;
    };
    const entryIdStr = entryId as string;
    const itemList: SubmitItem[] = Array.isArray(items)
      ? (items as SubmitItem[])
      : [];

    const { discussionExtractedItems, discussionEntries, discussions } =
      await import("@armyofagents/db");
    const { eq, and, sql } = await import("drizzle-orm");

    // Resolve entry -> owning discussion UNCONDITIONALLY in a SINGLE lookup
    // reused by the M3 company gate, the I-1 pendingItemCount increment, and
    // the F2 completion event. extraction.ts gets discussionId from
    // `entry.discussionId` after fetching the entry row; the tool only has
    // entryId in scope so it queries for it. Done regardless of
    // itemList.length so empty-items completions still carry a discussionId
    // for the LiveEvent (F2 parity).
    //
    // M3: also yield the owning discussion's companyId by JOINing
    // discussion_entries -> discussions in this SAME query (mirrors the
    // established entry->discussion->companyId resolution pattern in
    // dispatcher.ts:131-137). entryId is an untrusted agent/payload-supplied
    // input; every other write surface in the codebase enforces company
    // isolation. Gate ALL side-effects below on companyId === ctx.companyId
    // (defense-in-depth — consistent with the rest of the codebase).
    const [entryRow] = await ctx.db
      .select({
        discussionId: discussionEntries.discussionId,
        companyId: discussions.companyId,
      })
      .from(discussionEntries)
      .innerJoin(
        discussions,
        eq(discussions.id, discussionEntries.discussionId),
      )
      .where(eq(discussionEntries.id, entryIdStr));
    const resolvedDiscussionId: string | null =
      entryRow?.discussionId ?? null;

    // M3 gate: refuse if the entry/discussion doesn't exist OR its owning
    // company differs from the caller's. Mirrors the error-result convention
    // in the sibling tool delegate-to-subagent.ts ("no such agent" ->
    // { success:false, data:null, summary, error }). NO insert, NO
    // pendingItemCount update, NO extractionStatus update, NO LiveEvent.
    if (!entryRow || entryRow.companyId !== ctx.companyId) {
      return {
        success: false,
        data: null,
        summary: `Entry '${entryIdStr}' not found in this company`,
        error: "entry not found in caller company",
      };
    }

    const runInTransaction = async <T>(fn: (db: any) => Promise<T>): Promise<T> => {
      const dbWithTx = ctx.db as typeof ctx.db & {
        transaction?: (callback: (tx: unknown) => Promise<T>) => Promise<T>;
      };
      if (typeof dbWithTx.transaction === "function") {
        return dbWithTx.transaction((tx) => fn(tx));
      }
      return fn(ctx.db);
    };

    const shouldPublish = await runInTransaction(async (tx) => {
      // Terminal success status — extraction.ts sets extractionStatus
      // "completed" after writing items. Here the guarded processing->completed
      // transition is the claim that this tool call owns the terminalization. If
      // it matches 0 rows, a concurrent terminalizer already won; do not create
      // duplicate extracted items or pending hub work.
      const terminalized = await tx
        .update(discussionEntries)
        .set({ extractionStatus: "completed" })
        .where(
          and(
            eq(discussionEntries.id, entryIdStr),
            eq(discussionEntries.extractionStatus, "processing"),
          ),
        )
        .returning({ id: discussionEntries.id });

      if (terminalized.length === 0) return false;

      // Map onto the REAL discussion_extracted_items columns, matching
      // extraction.ts's itemValues shape. The schema has no `content`,
      // `confidence`, or `companyId` columns — `content` maps to the required
      // `title` column; new items get status "pending" (same as extraction.ts).
      if (itemList.length > 0) {
        const rows = itemList.map((item) => ({
          discussionEntryId: entryIdStr,
          type: item.type,
          title: item.content,
          description: null,
          suggestedPriority: null,
          suggestedDepartmentId: null,
          suggestedProjectId: null,
          suggestedLayer: "domain",
          layer: "domain",
          status: "pending" as const,
        }));

        await tx.insert(discussionExtractedItems).values(rows);

        // I-1: increment the parent discussion's pendingItemCount, mirroring
        // extraction.ts (lines ~614-620) EXACTLY. Reuses the discussionId
        // resolved above (no second identical query).
        if (resolvedDiscussionId) {
          await tx
            .update(discussions)
            .set({
              pendingItemCount: sql`${discussions.pendingItemCount} + ${rows.length}`,
              updatedAt: new Date(),
            })
            .where(eq(discussions.id, resolvedDiscussionId));
          const [discussion] = await tx
            .select()
            .from(discussions)
            .where(eq(discussions.id, resolvedDiscussionId));
          if (discussion) {
            await emitHubItem(tx, buildDiscussionPendingHubEmit(discussion));
          }
        }
      }

      return true;
    });

    if (!shouldPublish) {
      return {
        success: true,
        data: { count: itemList.length },
        summary: `Persisted ${itemList.length} extracted item(s) for entry ${entryIdStr}`,
      };
    }

    // F2: publish the completion LiveEvent AFTER the terminal status write,
    // mirroring extraction.ts:630-638 (ordering parity) so UIs subscribed to
    // `discussion.extraction.completed` refresh when an AoA agent finishes.
    if (resolvedDiscussionId) {
      publishLiveEvent({
        companyId: ctx.companyId,
        type: "discussion.extraction.completed",
        payload: {
          discussionId: resolvedDiscussionId,
          entryId: entryIdStr,
          itemCount: itemList.length,
        },
      });
    }

    return {
      success: true,
      data: { count: itemList.length },
      summary: `Persisted ${itemList.length} extracted item(s) for entry ${entryIdStr}`,
    };
  },
};
