import { describe, it, expect } from "vitest";
import { createDiscussionEntrySchema } from "../validators/discussion.js";

describe("createDiscussionEntrySchema", () => {
  it("accepts and preserves parentEntryId and authorAgentId", () => {
    const parsed = createDiscussionEntrySchema.parse({
      inputType: "agent",
      rawContent: "hello",
      parentEntryId: "11111111-1111-1111-1111-111111111111",
      authorAgentId: "22222222-2222-2222-2222-222222222222",
    });
    expect(parsed.parentEntryId).toBe("11111111-1111-1111-1111-111111111111");
    expect(parsed.authorAgentId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("accepts 'agent' as a valid inputType", () => {
    const parsed = createDiscussionEntrySchema.parse({
      inputType: "agent",
      rawContent: "hi",
    });
    expect(parsed.inputType).toBe("agent");
  });

  it("rejects a non-uuid parentEntryId", () => {
    expect(() =>
      createDiscussionEntrySchema.parse({
        inputType: "write",
        rawContent: "x",
        parentEntryId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("still parses a minimal human entry with neither field", () => {
    const parsed = createDiscussionEntrySchema.parse({
      inputType: "write",
      rawContent: "plain",
    });
    expect(parsed.parentEntryId ?? null).toBeNull();
    expect(parsed.authorAgentId ?? null).toBeNull();
  });

  it("accepts an attachment-only entry", () => {
    const parsed = createDiscussionEntrySchema.parse({
      inputType: "write",
      rawContent: "",
      attachments: [{ assetId: "11111111-1111-1111-1111-111111111111" }],
    });
    expect(parsed.rawContent).toBe("");
  });

  it("rejects an empty entry without attachments", () => {
    expect(() => createDiscussionEntrySchema.parse({ inputType: "write", rawContent: "  " })).toThrow(
      "rawContent is required unless the entry includes an attachment",
    );
  });

  it("rejects an attachment item that references neither an asset nor an artifact", () => {
    // {} and { assetId: null, artifactId: null } would be filtered out by the
    // server before insert — accepting them here lets a blank entry slip
    // through the attachment-only exemption (PR #291 review).
    expect(() =>
      createDiscussionEntrySchema.parse({
        inputType: "write",
        rawContent: "text",
        attachments: [{}],
      }),
    ).toThrow();
    expect(() =>
      createDiscussionEntrySchema.parse({
        inputType: "write",
        rawContent: "text",
        attachments: [{ assetId: null, artifactId: null }],
      }),
    ).toThrow();
  });

  it("rejects a blank entry whose only attachments carry no real reference", () => {
    expect(() =>
      createDiscussionEntrySchema.parse({
        inputType: "write",
        rawContent: "   ",
        attachments: [{ assetId: null, artifactId: null }],
      }),
    ).toThrow();
  });

  it("rejects more than five attachments (round-6 composer cap)", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      assetId: `1111111${i}-1111-1111-1111-111111111111`,
    }));
    expect(() =>
      createDiscussionEntrySchema.parse({
        inputType: "write",
        rawContent: "here are lots of files",
        attachments: many,
      }),
    ).toThrow();
  });

  it("accepts exactly five attachments (at the cap)", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      assetId: `2222222${i}-2222-2222-2222-222222222222`,
    }));
    const parsed = createDiscussionEntrySchema.parse({
      inputType: "write",
      rawContent: "five files",
      attachments: five,
    });
    expect(parsed.attachments).toHaveLength(5);
  });

  it("accepts an artifact-only attachment entry", () => {
    const parsed = createDiscussionEntrySchema.parse({
      inputType: "write",
      rawContent: "",
      attachments: [{ artifactId: "33333333-3333-3333-3333-333333333333" }],
    });
    expect(parsed.attachments?.[0]?.artifactId).toBe("33333333-3333-3333-3333-333333333333");
  });
});
