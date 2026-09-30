// server/src/services/internal-agent/tools/thread-update-summary.ts
import { eq } from "drizzle-orm";
import { discussions, internalAgentConfig } from "@armyofagents/db";
import type { AgentTool } from "../types.js";
import { logActivity } from "../../activity-log.js";

/** Cap on routing terms count + per-term length to keep the card bounded. */
const MAX_ROUTING_TERMS = 50;
const MAX_TERM_LENGTH = 120;

export const threadUpdateSummaryTool: AgentTool = {
  name: "thread.updateSummary",
  description:
    "Update a thread's summary text + routing terms, then queue embedding regeneration.",
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread (discussion) ID" },
      summary: {
        type: "string",
        description: "1-3 sentence summary of current thread state",
      },
      routingTerms: {
        type: "array",
        items: { type: "string" },
        description:
          "Key entities, aliases, and synonyms for routing retrieval " +
          "(e.g. [\"Acme Corp\",\"ACME\",\"the renewal\"]). Omit to leave unchanged.",
      },
    },
    required: ["threadId", "summary"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { threadId, summary, routingTerms } = (params ?? {}) as {
      threadId?: string;
      summary?: string;
      routingTerms?: unknown;
    };

    if (!threadId || typeof threadId !== "string") {
      return { success: false, data: null, summary: "threadId is required", error: "INVALID_PARAMS" };
    }
    if (typeof summary !== "string") {
      return { success: false, data: null, summary: "summary must be a string", error: "INVALID_PARAMS" };
    }
    // Codex P2: validate every element is a string (not just Array.isArray) + cap.
    let normalizedTerms: string[] | undefined;
    if (routingTerms !== undefined) {
      if (!Array.isArray(routingTerms)) {
        return { success: false, data: null, summary: "routingTerms must be a string array", error: "INVALID_PARAMS" };
      }
      if (!routingTerms.every((t) => typeof t === "string")) {
        return { success: false, data: null, summary: "routingTerms must contain only strings", error: "INVALID_PARAMS" };
      }
      normalizedTerms = (routingTerms as string[])
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= MAX_TERM_LENGTH)
        .slice(0, MAX_ROUTING_TERMS);
    }

    // Cross-tenant guard (#7): verify thread belongs to caller's company.
    const existing = await ctx.db
      .select({ companyId: discussions.companyId, crewPaused: discussions.crewPaused })
      .from(discussions)
      .where(eq(discussions.id, threadId))
      .then((rows: Array<{ companyId: string; crewPaused?: boolean | null }>) => rows[0] ?? null);

    if (!existing) {
      return { success: false, data: null, summary: `Thread ${threadId} not found`, error: "THREAD_NOT_FOUND" };
    }
    if (existing.companyId !== ctx.companyId) {
      return { success: false, data: null, summary: "Thread belongs to a different company", error: "COMPANY_MISMATCH" };
    }
    if (ctx.agentId && existing.crewPaused === true) {
      return { success: false, data: null, summary: "Thread crew is paused; summary update skipped", error: "THREAD_PAUSED" };
    }
    if (ctx.agentId) {
      const companyPause = await ctx.db
        .select({ crewPaused: internalAgentConfig.crewPaused })
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, existing.companyId))
        .then((rows: Array<{ crewPaused?: boolean | null }>) => rows[0] ?? null);
      if (companyPause?.crewPaused === true) {
        return { success: false, data: null, summary: "Company crew is paused; summary update skipped", error: "COMPANY_PAUSED" };
      }
    }

    const summaryUpdatedAt = new Date();
    const updatePayload: Record<string, unknown> = { summaryText: summary, summaryUpdatedAt };

    let routingTermsWritten = false;
    if (normalizedTerms !== undefined) {
      // jsonb string[] column — store the array directly (no serialize).
      updatePayload.routingTerms = normalizedTerms;
      routingTermsWritten = true;
    }

    await ctx.db
      .update(discussions)
      .set(updatePayload)
      .where(eq(discussions.id, threadId));

    // Audit trail (Codex P1 #8 / spec C6): card writes are user-facing state, so
    // log who changed the summary. Actor resolved from ctx (agentId when present —
    // e.g. the Chronicler — else 'system'). Non-fatal: never block the write.
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: ctx.agentId ? "agent" : "system",
      actorId: ctx.agentId ?? "system",
      action: "thread.summary.updated",
      entityType: "discussion",
      entityId: threadId,
      details: { routingTermsWritten },
    }).catch(() => {
      /* non-fatal — summary already saved */
    });

    // Best-effort embedding regeneration.
    let embeddingQueued = false;
    try {
      if (ctx.services?.embeddings?.enqueue) {
        await ctx.services.embeddings.enqueue({
          // Stamp the owning company (P2, Codex): without it the row gets
          // company_id = NULL and the per-company embedding worker can only
          // resolve a key via the env fallback — so companies that configured
          // only the Settings llm:openai key would leave these summary
          // embeddings pending until an env key is added or a restart backfills.
          companyId: ctx.companyId,
          targetTable: "discussions",
          targetId: threadId,
          targetColumn: "summary_embedding",
          inputText: summary,
        });
        embeddingQueued = true;
      }
    } catch {
      embeddingQueued = false;
    }

    return {
      success: true,
      data: { threadId, summaryUpdatedAt: summaryUpdatedAt.toISOString(), embeddingQueued, routingTermsWritten },
      summary: embeddingQueued
        ? "Summary updated; embedding queued"
        : "Summary updated (embedding not queued — service unavailable)",
    };
  },
};
