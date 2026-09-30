import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: #22 / Decision #100 amendment (2026-05-25). Discussion-entry
// extraction must route through the reliable direct-provider path
// (extractionService), NOT the CLI-adapter agent runner — the agent path left
// entries stuck 'processing' (codex: no MCP bridge; claude: submit hang).

const mockExtract = vi.fn();
vi.mock("../services/extraction.js", () => ({
  extractionService: vi.fn(() => ({ extractFromDiscussionEntry: mockExtract })),
}));

import { runExtractionConsumer } from "../services/internal-agent/subagents/extraction-consumer.js";

describe("runExtractionConsumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtract.mockResolvedValue(undefined);
  });

  it("routes extraction through extractionService.extractFromDiscussionEntry", async () => {
    await runExtractionConsumer({} as never, "co1", "entry1", "agent-unused");
    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(mockExtract).toHaveBeenCalledWith("co1", "entry1");
  });
});
