// server/src/services/internal-agent/tools/thread-spin-off.ts
//
// Task C2 batch 2 — `spin_off_thread` (action tool, Navigator).
//
// Creates a new thread spun off from an existing one. Optionally copies
// "seed" entries from the source thread (preserving the rawContent but
// marking the new entries as inputType='agent' with sourceInfo pointing
// back at the original entry). Also writes a thread_links row of kind=
// 'spinoff' so the relationship is queryable.
//
// All three writes — discussion insert, seed entry copies, thread_links
// insert — go in ONE transaction so the spinoff is atomic: either the
// new thread exists with its complete seed set + link, or nothing changes.

import { eq, inArray } from "drizzle-orm";
import { discussions, discussionEntries, threadLinks } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

export const spinOffThreadTool: AgentTool = {
  name: "spin_off_thread",
  description:
    "Create a new thread spun off from an existing thread. Optionally copy seed entries; writes a thread_links row of kind 'spinoff'.",
  parameters: {
    type: "object",
    properties: {
      fromThreadId: {
        type: "string",
        description: "Source thread (discussion) id to spin off from",
      },
      title: {
        type: "string",
        description: "Title for the new spun-off thread",
      },
      seedEntries: {
        type: "array",
        items: { type: "string" },
        description: "Optional entry IDs to copy into the new thread",
      },
    },
    required: ["fromThreadId", "title"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: true,
  async execute(params, ctx) {
    const { fromThreadId, title, seedEntries } = (params ?? {}) as {
      fromThreadId?: string;
      title?: string;
      seedEntries?: unknown;
    };
    if (!fromThreadId || typeof fromThreadId !== "string") {
      return {
        success: false,
        data: null,
        summary: "fromThreadId is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!title || typeof title !== "string") {
      return {
        success: false,
        data: null,
        summary: "title is required",
        error: "INVALID_PARAMS",
      };
    }
    const seedEntryIds = Array.isArray(seedEntries)
      ? seedEntries.filter((id): id is string => typeof id === "string")
      : [];

    try {
      const result = await ctx.db.transaction(async (tx: any) => {
        // ── Source-thread guard (Phase G4 wiring gap close) ──
        // Only `subtype='live'` threads spin off — a "normal" thread is
        // self-contained. Reading the source row here also lets us inherit
        // `visibility` so a private live thread doesn't silently widen to
        // company scope on its derived thread.
        const sourceRows = await tx
          .select()
          .from(discussions)
          .where(eq(discussions.id, fromThreadId))
          .limit(1);
        const sourceList = Array.isArray(sourceRows) ? sourceRows : [];
        const source = sourceList[0];
        if (!source) {
          // Throw to roll back the (still-empty) transaction and surface a
          // structured error via the catch below.
          const err: any = new Error(`Source thread ${fromThreadId} not found`);
          err.__toolErrorCode = "SOURCE_NOT_FOUND";
          throw err;
        }
        // Cross-tenant guard (#7): reject if the source thread belongs to a
        // different company than the caller's ctx. This closes the hole where a
        // Navigator agent scoped to company A could spin off a thread owned by
        // company B simply by knowing its ID.
        if (source.companyId !== ctx.companyId) {
          const err: any = new Error("Source thread belongs to a different company");
          err.__toolErrorCode = "COMPANY_MISMATCH";
          throw err;
        }
        if (source.subtype !== "live") {
          const err: any = new Error(
            "Spin-off requires source thread subtype='live'",
          );
          err.__toolErrorCode = "NOT_LIVE";
          throw err;
        }

        const insertedThread = await tx
          .insert(discussions)
          .values({
            companyId: ctx.companyId,
            title,
            status: "active",
            phase: "discuss",
            forkedFromId: fromThreadId,
            // Inherit visibility from the source. Enum values
            // (private|department|company) all propagate verbatim.
            visibility: source.visibility ?? "company",
            createdBy: ctx.agentId ?? "system",
          })
          .returning();
        const newThread = Array.isArray(insertedThread) ? insertedThread[0] : insertedThread;
        if (!newThread || !newThread.id) {
          throw new Error("discussions insert returned no row");
        }

        if (seedEntryIds.length > 0) {
          const seedRows = await tx
            .select()
            .from(discussionEntries)
            .where(inArray(discussionEntries.id, seedEntryIds));
          // Seed-entry scope guard (#7): only copy entries that actually belong
          // to the source thread. This prevents cross-thread / cross-company
          // content leakage if a caller passes entry IDs from another thread.
          const seedList = (Array.isArray(seedRows) ? seedRows : []).filter(
            (r: any) => r.discussionId === fromThreadId,
          );
          for (const r of seedList) {
            await tx.insert(discussionEntries).values({
              discussionId: newThread.id,
              inputType: "agent",
              rawContent: r.rawContent,
              sourceInfo: {
                copiedFromThreadId: fromThreadId,
                originalEntryId: r.id,
              },
              authorAgentId: ctx.agentId ?? null,
              createdBy: ctx.agentId ?? "system",
            });
          }
        }

        await tx.insert(threadLinks).values({
          companyId: ctx.companyId,
          fromThreadId,
          toThreadId: newThread.id,
          kind: "spinoff",
          createdBy: ctx.agentId ?? "system",
        });

        return newThread;
      });

      return {
        success: true,
        data: {
          threadId: result.id,
          seedEntryCount: seedEntryIds.length,
        },
        summary: `Spun off thread: ${title}`,
      };
    } catch (err: any) {
      // Surface structured guard rejections (NOT_LIVE, SOURCE_NOT_FOUND)
      // distinctly from infrastructure failures so callers can branch on
      // the error code. Unknown failures fall through to TRANSACTION_FAILED.
      const code: string | undefined = err?.__toolErrorCode;
      if (code === "NOT_LIVE" || code === "SOURCE_NOT_FOUND" || code === "COMPANY_MISMATCH") {
        return {
          success: false,
          data: null,
          summary: err?.message ?? "Spin-off rejected",
          error: code,
        };
      }
      return {
        success: false,
        data: null,
        summary: `Failed to spin off thread: ${err?.message ?? "unknown error"}`,
        error: "TRANSACTION_FAILED",
      };
    }
  },
};
