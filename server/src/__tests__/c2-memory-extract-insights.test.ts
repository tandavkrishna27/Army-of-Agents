// server/src/__tests__/c2-memory-extract-insights.test.ts
//
// Task C2 batch 3 — extract_insights tool tests.
// Mirrors extract_decisions but for type='insight'.

import { describe, expect, it, vi } from "vitest";

vi.mock("../services/extraction.js", () => ({
  extractInsights: vi.fn(),
}));

import { extractInsights } from "../services/extraction.js";
import { CliExtractionError } from "../services/extraction-cli.js";
import { extractInsightsTool } from "../services/internal-agent/tools/memory-extract-insights.js";
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

describe("extract_insights tool (C2 batch 3)", () => {
  it("metadata: name=extract_insights, category=memory", () => {
    expect(extractInsightsTool.name).toBe("extract_insights");
    expect(extractInsightsTool.category).toBe("memory");
    expect(extractInsightsTool.requiredRole).toBe("team_member");
    expect(extractInsightsTool.requiresConfirmation).toBe(false);
  });

  it("returns INVALID_PARAMS when threadId is missing", async () => {
    const result = await extractInsightsTool.execute({}, makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(extractInsights as any).not.toHaveBeenCalled();
  });

  it("wraps extractInsights and returns filtered list", async () => {
    const insights = [
      { type: "insight", title: "Users skip onboarding", description: null, suggestedLayer: null, suggestedPriority: null, suggestedDepartment: null },
      { type: "insight", title: "Conversion drops at step 3", description: null, suggestedLayer: null, suggestedPriority: null, suggestedDepartment: null },
    ];
    (extractInsights as any).mockResolvedValueOnce(insights);

    const ctx = makeCtx();

    const result = await extractInsightsTool.execute(
      { threadId: "th-1" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual(insights);
    expect(result.summary).toContain("2");
    // CLI-only: the tool always passes `null` as the llm.
    expect(extractInsights).toHaveBeenCalledWith(
      ctx.db,
      null,
      expect.objectContaining({ companyId: "co-1", threadId: "th-1" }),
    );
  });

  it("returns EXTRACTION_LLM_UNAVAILABLE when the extraction CLI is unavailable", async () => {
    (extractInsights as any).mockRejectedValueOnce(
      new CliExtractionError("claude CLI not found on PATH", "not_installed"),
    );
    const result = await extractInsightsTool.execute(
      { threadId: "th-1" },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("EXTRACTION_LLM_UNAVAILABLE");
    expect(result.data).toEqual([]);
  });
});
