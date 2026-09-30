import { describe, expect, it } from "vitest";
import {
  buildComposerDraftKey,
  buildComposerIdempotencyKey,
  composerDraftSchema,
  composerSubmissionSchema,
} from "../composer-contracts.js";

describe("composer contracts", () => {
  it("scopes drafts by company, user, surface, entity, and reply target", () => {
    const key = buildComposerDraftKey({
      companyId: "company/a",
      userId: "user-1",
      surface: "discussion",
      entityId: "thread-1",
      replyTargetId: "entry-2",
    });
    expect(key).toBe("aoa:composer-draft:company%2Fa:user-1:discussion:thread-1:entry-2");
  });

  it("keeps idempotency keys deterministic for retries", () => {
    const input = { companyId: "c", userId: "u", surface: "task" as const, entityId: "i", clientSubmissionId: "s" };
    expect(buildComposerIdempotencyKey(input)).toBe(buildComposerIdempotencyKey(input));
  });

  it("accepts attachment-only submissions and rejects malformed drafts", () => {
    expect(composerSubmissionSchema.safeParse({
      clientSubmissionId: "s",
      text: "",
      mentions: [],
      commands: [],
      attachments: [{ id: "a", filename: "x.pdf", contentType: "application/pdf", byteSize: 3, capability: "stored-only" }],
      action: "comment",
    }).success).toBe(true);
    expect(composerDraftSchema.safeParse({ version: 1, savedAt: -1, text: "", mentions: [], commands: [], attachments: [] }).success).toBe(false);
  });
});
