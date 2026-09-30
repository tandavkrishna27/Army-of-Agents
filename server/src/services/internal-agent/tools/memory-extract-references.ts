// server/src/services/internal-agent/tools/memory-extract-references.ts
//
// Task C2 batch 3 — `extract_references` (memory tool, Memory Keeper).
// Filters `extractMemoryCandidates` to type='reference'. See extract_decisions
// for the shared CLI-only resolution + error-handling pattern.

import { extractReferences } from "../../extraction.js";
import { CliExtractionError } from "../../extraction-cli.js";
import type { AgentTool } from "../types.js";

export const extractReferencesTool: AgentTool = {
  name: "extract_references",
  description:
    "Extract reference-type memory candidates from a thread (filtered subset of extract_memory_candidates).",
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
      const references = await extractReferences(ctx.db, null, {
        companyId: ctx.companyId,
        threadId,
        ...(sinceEntryId ? { sinceEntryId } : {}),
      });
      return {
        success: true,
        data: references,
        summary: `Extracted ${references.length} reference${references.length === 1 ? "" : "s"}`,
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
