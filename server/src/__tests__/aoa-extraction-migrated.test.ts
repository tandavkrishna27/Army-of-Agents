// Decision #100 (amended 2026-05-25): extraction default = direct-provider.
// runExtractionConsumer is now a thin delegator to extractionService, NOT to
// runAoaAgent. The agent/CLI path is opt-in until hardened (bridge wiring for
// codex/opencode + the claude headless submit hang).
//
// This test pins the new delegation contract:
//   runExtractionConsumer(db, companyId, entryId, agentId)
//     → extractionService(db).extractFromDiscussionEntry(companyId, entryId)
//   Never rethrows (the isolation guarantee lives in extractionService).
import { describe, expect, it, vi } from "vitest";

const { extractFromDiscussionEntryMock } = vi.hoisted(() => ({
  extractFromDiscussionEntryMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/extraction.js", () => ({
  extractionService: () => ({
    extractFromDiscussionEntry: extractFromDiscussionEntryMock,
  }),
}));

import { runExtractionConsumer } from "../services/internal-agent/subagents/extraction-consumer.js";

describe("runExtractionConsumer delegates to extractionService (Decision #100)", () => {
  it("delegates to extractionService.extractFromDiscussionEntry, never rethrows", async () => {
    const db: any = {};
    await expect(
      runExtractionConsumer(db, "co-1", "e1", "ext-1"),
    ).resolves.toBeUndefined();
    expect(extractFromDiscussionEntryMock).toHaveBeenCalledWith("co-1", "e1");
    expect(extractFromDiscussionEntryMock).toHaveBeenCalledOnce();
  });
});
