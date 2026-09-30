import { describe, expect, it } from "vitest";
import { updateDiscussionSchema } from "../discussion.js";
import { updateInternalAgentConfigSchema } from "../internal-agent.js";

describe("updateDiscussionSchema — autonomyLevel", () => {
  it("accepts null", () => {
    expect(updateDiscussionSchema.safeParse({ autonomyLevel: null }).success).toBe(true);
  });
  it("accepts 0 (Manual)", () => {
    expect(updateDiscussionSchema.safeParse({ autonomyLevel: 0 }).success).toBe(true);
  });
  it("accepts 1 (Assist)", () => {
    expect(updateDiscussionSchema.safeParse({ autonomyLevel: 1 }).success).toBe(true);
  });
  it("accepts 2 (Drive)", () => {
    expect(updateDiscussionSchema.safeParse({ autonomyLevel: 2 }).success).toBe(true);
  });
  it("rejects 3 — out-of-range for canonical 0-2 scale", () => {
    expect(updateDiscussionSchema.safeParse({ autonomyLevel: 3 }).success).toBe(false);
  });
  it("rejects -1", () => {
    expect(updateDiscussionSchema.safeParse({ autonomyLevel: -1 }).success).toBe(false);
  });
  it("rejects non-integer", () => {
    expect(updateDiscussionSchema.safeParse({ autonomyLevel: 1.5 }).success).toBe(false);
  });
});

describe("updateInternalAgentConfigSchema — autonomyLevel", () => {
  it("accepts 0 (Manual)", () => {
    expect(updateInternalAgentConfigSchema.safeParse({ autonomyLevel: 0 }).success).toBe(true);
  });
  it("accepts 1 (Assist)", () => {
    expect(updateInternalAgentConfigSchema.safeParse({ autonomyLevel: 1 }).success).toBe(true);
  });
  it("accepts 2 (Drive)", () => {
    expect(updateInternalAgentConfigSchema.safeParse({ autonomyLevel: 2 }).success).toBe(true);
  });
  it("rejects 3 — out-of-range for canonical 0-2 scale", () => {
    expect(updateInternalAgentConfigSchema.safeParse({ autonomyLevel: 3 }).success).toBe(false);
  });
  it("rejects -1", () => {
    expect(updateInternalAgentConfigSchema.safeParse({ autonomyLevel: -1 }).success).toBe(false);
  });
  it("rejects non-integer", () => {
    expect(updateInternalAgentConfigSchema.safeParse({ autonomyLevel: 1.5 }).success).toBe(false);
  });
});
