import { describe, it, expect, vi, beforeEach } from "vitest";

const post = vi.fn().mockResolvedValue({ id: "entry-new" });
vi.mock("../client", () => ({ api: { post: (...a: unknown[]) => post(...a), get: vi.fn(), patch: vi.fn() } }));

import { discussionsApi, type DiscussionEntry } from "../discussions";

describe("discussionsApi.addEntry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards parentEntryId in the POST body", async () => {
    await discussionsApi.addEntry("co", "disc-1", {
      rawContent: "a reply",
      inputType: "write",
      parentEntryId: "parent-1",
    });
    expect(post).toHaveBeenCalledWith(
      "/companies/co/discussions/disc-1/entries",
      expect.objectContaining({ parentEntryId: "parent-1" }),
    );
  });

  it("DiscussionEntry type carries the new authorship fields", () => {
    const e: DiscussionEntry = {
      id: "e1",
      inputType: "agent",
      rawContent: "x",
      title: null,
      sourceInfo: null,
      departmentId: null,
      projectId: null,
      goalId: null,
      parentEntryId: null,
      authorAgentId: "agent-7",
      authorAgentName: "Scribe",
      authorAgentAvatar: "scribe.png",
      extractionStatus: "completed",
      createdBy: "agent-7",
      createdAt: "2026-01-01T00:00:00Z",
      extractedItems: [],
      annotations: [],
    };
    expect(e.authorAgentId).toBe("agent-7");
  });
});
