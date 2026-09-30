// server/src/__tests__/c2-memory-extract-candidates.test.ts
//
// Task C2 batch 3 — extract_memory_candidates tool tests.
// Verifies: metadata, INVALID_PARAMS for missing threadId, success path (the
// tool is CLI-only and always passes `null` as the llm), sinceEntryId cursor is
// passed through, and the EXTRACTION_LLM_UNAVAILABLE error when the extraction
// CLI is unavailable (CliExtractionError not_installed/not_authed).

import { describe, expect, it, vi } from "vitest";

// Mock the extraction service before importing the tool — vi.mock is hoisted
// so this rewires `extractMemoryCandidates` for the SUT.
vi.mock("../services/extraction.js", () => ({
  extractMemoryCandidates: vi.fn(),
}));

import { extractMemoryCandidates } from "../services/extraction.js";
import { CliExtractionError } from "../services/extraction-cli.js";
import { extractMemoryCandidatesTool } from "../services/internal-agent/tools/memory-extract-candidates.js";
import type { ToolContext } from "../services/internal-agent/types.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: [],
    db: {} as any,
    services: {} as any,
    ...overrides,
  } as unknown as ToolContext;
}

describe("extract_memory_candidates tool (C2 batch 3)", () => {
  it("metadata: name, category=memory, requiredRole=team_member, no confirmation", () => {
    expect(extractMemoryCandidatesTool.name).toBe("extract_memory_candidates");
    expect(extractMemoryCandidatesTool.category).toBe("memory");
    expect(extractMemoryCandidatesTool.requiredRole).toBe("team_member");
    expect(extractMemoryCandidatesTool.requiresConfirmation).toBe(false);
  });

  it("returns INVALID_PARAMS when threadId is missing", async () => {
    const result = await extractMemoryCandidatesTool.execute({}, makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(extractMemoryCandidates as any).not.toHaveBeenCalled();
  });

  it("returns candidates on success and passes sinceEntryId cursor through", async () => {
    const candidates = [
      { type: "decision", title: "Use Postgres", description: null, suggestedLayer: "domain", suggestedPriority: null, suggestedDepartment: null },
      { type: "insight", title: "Onboarding stalls", description: null, suggestedLayer: null, suggestedPriority: null, suggestedDepartment: null },
    ];
    (extractMemoryCandidates as any).mockResolvedValueOnce({ candidates });

    const ctx = makeCtx();

    const result = await extractMemoryCandidatesTool.execute(
      { threadId: "th-1", sinceEntryId: "e-5" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).candidates).toEqual(candidates);
    expect(result.summary).toContain("2");
    // CLI-only: the tool always passes `null` as the llm.
    expect(extractMemoryCandidates).toHaveBeenCalledWith(
      ctx.db,
      null,
      expect.objectContaining({ companyId: "co-1", threadId: "th-1", sinceEntryId: "e-5" }),
    );
  });

  it("passes null llm (CLI-only)", async () => {
    (extractMemoryCandidates as any).mockResolvedValueOnce({ candidates: [] });
    const ctx = makeCtx();
    const result = await extractMemoryCandidatesTool.execute({ threadId: "th-1" }, ctx);
    expect(result.success).toBe(true);
    const [, llmArg] = (extractMemoryCandidates as any).mock.calls.at(-1);
    expect(llmArg).toBeNull();
  });

  it("returns EXTRACTION_LLM_UNAVAILABLE when the extraction CLI is unavailable", async () => {
    (extractMemoryCandidates as any).mockRejectedValueOnce(
      new CliExtractionError("claude CLI not found on PATH", "not_installed"),
    );
    const result = await extractMemoryCandidatesTool.execute(
      { threadId: "th-1" },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("EXTRACTION_LLM_UNAVAILABLE");
    expect((result.data as any).candidates).toEqual([]);
  });

  it("returns EXTRACTION_FAILED for other errors", async () => {
    (extractMemoryCandidates as any).mockRejectedValueOnce(
      new Error("Network error"),
    );
    const result = await extractMemoryCandidatesTool.execute(
      { threadId: "th-1" },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("EXTRACTION_FAILED");
    expect(result.summary).toContain("Network error");
  });
});
