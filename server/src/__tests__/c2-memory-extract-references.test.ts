// server/src/__tests__/c2-memory-extract-references.test.ts
//
// Task C2 batch 3 — extract_references tool tests.
// Mirrors extract_decisions but for type='reference'.

import { describe, expect, it, vi } from "vitest";

vi.mock("../services/extraction.js", () => ({
  extractReferences: vi.fn(),
}));

import { extractReferences } from "../services/extraction.js";
import { CliExtractionError } from "../services/extraction-cli.js";
import { extractReferencesTool } from "../services/internal-agent/tools/memory-extract-references.js";
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

describe("extract_references tool (C2 batch 3)", () => {
  it("metadata: name=extract_references, category=memory", () => {
    expect(extractReferencesTool.name).toBe("extract_references");
    expect(extractReferencesTool.category).toBe("memory");
    expect(extractReferencesTool.requiredRole).toBe("team_member");
    expect(extractReferencesTool.requiresConfirmation).toBe(false);
  });

  it("returns INVALID_PARAMS when threadId is missing", async () => {
    const result = await extractReferencesTool.execute({}, makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(extractReferences as any).not.toHaveBeenCalled();
  });

  it("wraps extractReferences and returns filtered list", async () => {
    const references = [
      { type: "reference", title: "Stripe docs URL", description: "https://stripe.com/docs", suggestedLayer: null, suggestedPriority: null, suggestedDepartment: null },
    ];
    (extractReferences as any).mockResolvedValueOnce(references);

    const ctx = makeCtx();

    const result = await extractReferencesTool.execute(
      { threadId: "th-1", sinceEntryId: "e-2" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual(references);
    expect(result.summary).toContain("1");
    // CLI-only: the tool always passes `null` as the llm.
    expect(extractReferences).toHaveBeenCalledWith(
      ctx.db,
      null,
      expect.objectContaining({ companyId: "co-1", threadId: "th-1", sinceEntryId: "e-2" }),
    );
  });

  it("returns EXTRACTION_LLM_UNAVAILABLE when the extraction CLI is unavailable", async () => {
    (extractReferences as any).mockRejectedValueOnce(
      new CliExtractionError("claude CLI not found on PATH", "not_installed"),
    );
    const result = await extractReferencesTool.execute(
      { threadId: "th-1" },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("EXTRACTION_LLM_UNAVAILABLE");
    expect(result.data).toEqual([]);
  });
});
