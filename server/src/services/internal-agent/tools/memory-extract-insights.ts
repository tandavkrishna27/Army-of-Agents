// server/src/services/internal-agent/tools/memory-extract-insights.ts
//
// Task C2 batch 3 — `extract_insights` (memory tool, Memory Keeper).
// Filters `extractMemoryCandidates` to type='insight'. See extract_decisions
// for the shared CLI-only resolution + error-handling pattern.

import { extractInsights } from "../../extraction.js";
import { CliExtractionError } from "../../extraction-cli.js";
import type { AgentTool } from "../types.js";

export const extractInsightsTool: AgentTool = {
  name: "extract_insights",
  description:
    "Extract insight-type memory candidates from a thread (filtered subset of extract_memory_candidates).",
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread (discussion) id" },
      sinceEntryId: {
        type: "string",
        description: "Optional cursor — only consider entries posted strictly after this entry",
      },
    },
    required: ["threadId"],
  },
  category: "memory",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { threadId, sinceEntryId } = (params ?? {}) as {
      threadId?: string;
      sinceEntryId?: string;
    };
    if (!threadId || typeof threadId !== "string") {
      return {
        success: false,
        data: [],
        summary: "threadId is required",
        error: "INVALID_PARAMS",
      };
    }

    try {
      const insights = await extractInsights(ctx.db, null, {
        companyId: ctx.companyId,
        threadId,
        ...(sinceEntryId ? { sinceEntryId } : {}),
      });
      return {
        success: true,
        data: insights,
        summary: `Extracted ${insights.length} insight${insights.length === 1 ? "" : "s"}`,
      };
    } catch (err: any) {
      const isCliUnavailable =
        err instanceof CliExtractionError &&
        (err.kind === "not_installed" || err.kind === "not_authed");
      const msg = err?.message ?? "unknown error";
      return {
        success: false,
        data: [],
        summary: isCliUnavailable
          ? "Extraction CLI unavailable — install a CLI (e.g. the Claude Code CLI) and run its login flow"
          : `Extraction failed: ${msg}`,
        error: isCliUnavailable ? "EXTRACTION_LLM_UNAVAILABLE" : "EXTRACTION_FAILED",
      };
    }
  },
};
