// server/src/services/internal-agent/tools/memory-extract-candidates.ts
//
// Task C2 batch 3 — `extract_memory_candidates` (memory tool, Scribe/Memory Keeper).
//
// Thin wrapper over C1's `extractMemoryCandidates` (server/src/services/extraction.ts).
// Returns structured memory candidates (decision|insight|reference|context|preference|...)
// without persisting — callers decide whether to submit_extracted_items or
// propose_memory_from_thread.
//
// Extraction is CLI-only (keyless): the wrapper passes NO `llm`, so the
// underlying function runs through `extractViaCli`. A CLI-unavailable failure
// (CliExtractionError not_installed/not_authed) maps to EXTRACTION_LLM_UNAVAILABLE.

import { extractMemoryCandidates } from "../../extraction.js";
import { CliExtractionError } from "../../extraction-cli.js";
import type { AgentTool } from "../types.js";

export const extractMemoryCandidatesTool: AgentTool = {
  name: "extract_memory_candidates",
  description:
    "Run LLM extraction over thread entries and return structured memory candidates " +
    "(decisions, insights, references, etc.). Does not persist — pair with " +
    "submit_extracted_items or propose_memory_from_thread to act on the results.",
  parameters: {
    type: "object",
    properties: {
      threadId: {
        type: "string",
        description: "The thread (discussion) id to extract from",
      },
      sinceEntryId: {
        type: "string",
        description:
          "Optional cursor — only consider entries posted strictly after this entry",
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
        data: { candidates: [] },
        summary: "threadId is required",
        error: "INVALID_PARAMS",
      };
    }

    // Production is CLI-only: pass NO `llm` so extraction runs via extractViaCli.
    try {
      const result = await extractMemoryCandidates(ctx.db, null, {
        companyId: ctx.companyId,
        threadId,
        ...(sinceEntryId ? { sinceEntryId } : {}),
      });
      const count = result.candidates.length;
      return {
        success: true,
        data: result,
        summary: `Extracted ${count} memory candidate${count === 1 ? "" : "s"}`,
      };
    } catch (err: any) {
      // A CLI-unavailable failure (binary missing / not logged in) surfaces as
      // EXTRACTION_LLM_UNAVAILABLE with CLI guidance.
      const isCliUnavailable =
        err instanceof CliExtractionError &&
        (err.kind === "not_installed" || err.kind === "not_authed");
      const msg = err?.message ?? "unknown error";
      return {
        success: false,
        data: { candidates: [] },
        summary: isCliUnavailable
          ? "Extraction CLI unavailable — install a CLI (e.g. the Claude Code CLI) and run its login flow"
          : `Extraction failed: ${msg}`,
        error: isCliUnavailable ? "EXTRACTION_LLM_UNAVAILABLE" : "EXTRACTION_FAILED",
      };
    }
  },
};
