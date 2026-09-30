// server/src/services/internal-agent/tools/memory-propose.ts
//
// Task C2 batch 3 — `propose_memory_from_thread` (memory tool, Memory Keeper).
//
// Creates a `memory_items` row with status='pending' (founder approves; per
// Decisions #15/#16/#52). Distinct from the existing `suggest_memory` tool —
// this variant inherits visibility + scope from the source thread and enforces
// the private-thread layer restriction:
//
//   visibility = 'private'      → may only propose 'working' or 'active_context'
//                                  (private threads must not seed identity/domain)
//   visibility ∈ {department, company} → all four layers allowed
//
// Also respects `discussions.allowMemoryExtraction` — when false, refuses with
// MEMORY_EXTRACTION_DISABLED.
//
// The `sourceThreadId` is recorded in `sourceContext` (memory_items has no
// dedicated thread FK column; sourceContext is the existing text breadcrumb).
// Best-effort embedding enqueue (non-fatal) so retrieval picks the item up.

import { and, eq } from "drizzle-orm";
import { memoryItems, discussions } from "@armyofagents/db";
import type { AgentTool } from "../types.js";
import { buildAddScopeItemIdempotencyKey } from "./thread-action-keys.js";
import { enqueueMemoryEmbedding } from "../../memory-write.js";

const PRIVATE_THREAD_ALLOWED_LAYERS = new Set(["working", "active_context"]);
const VALID_LAYERS = new Set(["identity", "domain", "active_context", "working"]);
const VALID_CATEGORIES = new Set([
  "decision",
  "insight",
  "context",
  "reference",
  "preference",
]);

export const proposeMemoryFromThreadTool: AgentTool = {
  name: "propose_memory_from_thread",
  description:
    "Propose a memory item (status='pending', founder approves) seeded from a thread. " +
    "Inherits visibility + scope from the source thread. Private threads may only " +
    "propose working or active_context layers.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "Memory content (required)" },
      layer: {
        type: "string",
        description: "identity|domain|active_context|working",
      },
      sourceThreadId: {
        type: "string",
        description: "Originating thread (discussion) id",
      },
      type: {
        type: "string",
        description:
          "Optional category: decision|insight|context|reference|preference (default 'context')",
      },
      title: {
        type: "string",
        description:
          "Optional title; defaults to a truncated first line of content",
      },
    },
    required: ["content", "layer", "sourceThreadId"],
  },
  category: "memory",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { content, layer, sourceThreadId, type, title } = (params ?? {}) as {
      content?: string;
      layer?: string;
      sourceThreadId?: string;
      type?: string;
      title?: string;
    };
    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return {
        success: false,
        data: null,
        summary: "content is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!layer || !VALID_LAYERS.has(layer)) {
      return {
        success: false,
        data: null,
        summary: `layer is required and must be one of identity|domain|active_context|working`,
        error: "INVALID_PARAMS",
      };
    }
    if (!sourceThreadId || typeof sourceThreadId !== "string") {
      return {
        success: false,
        data: null,
        summary: "sourceThreadId is required",
        error: "INVALID_PARAMS",
      };
    }
    const category = type && VALID_CATEGORIES.has(type) ? type : "context";
    const defaultedTitle =
      title && title.trim().length > 0
        ? title.trim()
        : content.trim().split("\n")[0].slice(0, 200);

    if (ctx.discussionRunMode === "controller_action_gate") {
      if (!ctx.runId) {
        return {
          success: false,
          data: null,
          summary: "Cannot queue memory candidate without a run id",
          error: "MISSING_RUN_ID",
        };
      }

      // PRIVACY (review fix (b)): enforce the same per-thread privacy gates the
      // non-gated path runs — load the source thread's `allowMemoryExtraction`
      // + `visibility` and short-circuit BEFORE queuing the action. Without this
      // the gated branch would queue (and later commit) a memory candidate even
      // when the founder disabled extraction for the thread, or when a private
      // thread tried to seed identity/domain memory. Mirrors the non-gated
      // checks below verbatim (same error codes).
      const gateRows = await ctx.db
        .select({
          id: discussions.id,
          visibility: discussions.visibility,
          allowMemoryExtraction: discussions.allowMemoryExtraction,
        })
        .from(discussions)
        .where(and(eq(discussions.id, sourceThreadId), eq(discussions.companyId, ctx.companyId)))
        .limit(1);
      const gateThread = Array.isArray(gateRows) ? gateRows[0] : null;
      if (!gateThread) {
        return {
          success: false,
          data: null,
          summary: "Source thread not found",
          error: "THREAD_NOT_FOUND",
        };
      }
      if (gateThread.allowMemoryExtraction === false) {
        return {
          success: false,
          data: null,
          summary: "Memory extraction is disabled for this thread",
          error: "MEMORY_EXTRACTION_DISABLED",
        };
      }
      if (
        gateThread.visibility === "private" &&
        !PRIVATE_THREAD_ALLOWED_LAYERS.has(layer)
      ) {
        return {
          success: false,
          data: null,
          summary:
            "Private threads can only propose memory at layer 'working' or 'active_context'",
          error: "VISIBILITY_VIOLATION",
        };
      }

      const { threadAgentActionService } = await import("../../thread-agent-actions.js");
      const action = await threadAgentActionService(ctx.db).proposeThreadAction({
        companyId: ctx.companyId,
        threadId: sourceThreadId,
        runId: ctx.runId,
        agentId: ctx.agentId ?? null,
        actionType: "add_scope_item",
        payload: {
          kind: "memory_candidate",
          title: defaultedTitle,
          content,
          layer,
          category,
        },
        idempotencyKey: buildAddScopeItemIdempotencyKey({
          threadId: sourceThreadId,
          agentId: ctx.agentId,
          title: defaultedTitle,
          content,
          layer,
          category,
          // Turn anchor: latest human entry seq at run start (null → content-only). #198.
          turnAnchor:
            ctx.threadFreshness?.latestHumanSeq != null
              ? String(ctx.threadFreshness.latestHumanSeq)
              : null,
        }),
        freshness: ctx.threadFreshness ?? {},
      }) as { id?: string };

      return {
        success: true,
        data: { actionId: action.id, queued: true },
        summary: "Queued memory candidate for freshness-checked scope commit",
      };
    }

    // Look up the source thread for visibility + extraction-allowed checks
    // and to inherit scope (department/project/goal) onto the memory item.
    const threadRows = await ctx.db
      .select({
        id: discussions.id,
        visibility: discussions.visibility,
        allowMemoryExtraction: discussions.allowMemoryExtraction,
        scopeType: discussions.scopeType,
        scopeId: discussions.scopeId,
        goalId: discussions.goalId,
      })
      .from(discussions)
      .where(and(eq(discussions.id, sourceThreadId), eq(discussions.companyId, ctx.companyId)))
      .limit(1);
    const thread = Array.isArray(threadRows) ? threadRows[0] : null;
    if (!thread) {
      return {
        success: false,
        data: null,
        summary: "Source thread not found",
        error: "THREAD_NOT_FOUND",
      };
    }

    if (thread.allowMemoryExtraction === false) {
      return {
        success: false,
        data: null,
        summary: "Memory extraction is disabled for this thread",
        error: "MEMORY_EXTRACTION_DISABLED",
      };
    }

    // Visibility-scoped layer restriction. Private threads must not seed
    // identity/domain memory — those layers are company-wide truth and a
    // private thread cannot speak for the company.
    if (
      thread.visibility === "private" &&
      !PRIVATE_THREAD_ALLOWED_LAYERS.has(layer)
    ) {
      return {
        success: false,
        data: null,
        summary:
          "Private threads can only propose memory at layer 'working' or 'active_context'",
        error: "VISIBILITY_VIOLATION",
      };
    }

    // Inherit scope. scopeType='department' → departmentId; 'project' → projectId;
    // 'goal' → goalId. discussion.goalId is set independently for goal-as-property
    // semantics; if scope is goal and the discussion.goalId is set we use that.
    const scopeInherit: {
      departmentId?: string;
      projectId?: string;
      goalId?: string;
    } = {};
    if (thread.scopeType === "department" && thread.scopeId) {
      scopeInherit.departmentId = thread.scopeId;
    } else if (thread.scopeType === "project" && thread.scopeId) {
      scopeInherit.projectId = thread.scopeId;
    } else if (thread.scopeType === "goal" && thread.scopeId) {
      scopeInherit.goalId = thread.scopeId;
    }
    if (thread.goalId && !scopeInherit.goalId) {
      scopeInherit.goalId = thread.goalId;
    }

    // Default the title to a truncated first line of content when caller omits.
    const inserted = await ctx.db
      .insert(memoryItems)
      .values({
        companyId: ctx.companyId,
        title: defaultedTitle,
        content,
        category,
        source: "agent",
        layer,
        status: "pending",
        sourceContext: `thread:${sourceThreadId}`,
        ...scopeInherit,
        createdBy: ctx.agentId ?? ctx.userId ?? "system",
      })
      .returning({ id: memoryItems.id });
    const item = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!item || !item.id) {
      return {
        success: false,
        data: null,
        summary: "Memory insert returned no row",
        error: "INSERT_FAILED",
      };
    }

    // Best-effort embedding enqueue via the shared helper — non-fatal,
    // deduped, company-scoped. enqueueMemoryEmbedding already catches its own
    // errors internally, but guard here too so any unexpected throw (e.g. from
    // mocks in tests) never blocks the proposal returning success.
    try {
      await enqueueMemoryEmbedding(ctx.db, ctx.companyId, { id: item.id, title: defaultedTitle, content });
    } catch {
      /* non-fatal — see note above */
    }

    return {
      success: true,
      data: { memoryItemId: item.id },
      summary: `Memory proposed (status=pending) at layer ${layer}`,
    };
  },
};
