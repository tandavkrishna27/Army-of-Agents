import { describe, expect, it } from "vitest";
import {
  draftDestinationSchema,
  draftPatchSchema,
  universeDraftPatchSchema,
  UNIVERSE_DRAFT_MAX_ATTACHMENTS,
  UNIVERSE_DRAFT_MAX_TEXT,
} from "../validators/universe-draft.js";

describe("universe draft validators", () => {
  it("accepts a well-formed destination and patch", () => {
    expect(
      draftDestinationSchema.safeParse({ kind: "task", id: "33333333-3333-4333-8333-333333333333" }).success,
    ).toBe(true);
    expect(
      draftPatchSchema.safeParse({
        schemaVersion: 1,
        expectedRevision: 0,
        text: "hello",
        attachmentAssetIds: ["55555555-5555-4555-8555-555555555555"],
      }).success,
    ).toBe(true);
  });

  it("accepts each structured destination and bounded pending metadata", () => {
    const base = { schemaVersion: 1, expectedRevision: 0 };
    const payloads = [
      { kind: "commander", text: "hello", attachmentAssetIds: [] },
      { kind: "task", text: "reply", attachmentAssetIds: [] },
      { kind: "question", expectedVersion: 2, text: "", selectedValues: ["yes"] },
      { kind: "runtime_decision", expectedSourceRevision: 3, answer: { kind: "permission", decision: "allow_once" } },
      { kind: "approval", observedUpdatedAt: new Date().toISOString(), decision: "approve", decisionNote: "ok" },
    ];
    for (const payload of payloads) {
      expect(universeDraftPatchSchema.safeParse({ ...base, payload, pendingAttempt: null }).success).toBe(true);
    }
    expect(universeDraftPatchSchema.safeParse({
      ...base,
      payload: payloads[0],
      pendingAttempt: { attemptId: "a1", draftRevision: 1, payloadHash: "a".repeat(64), clientSubmissionId: "s1", state: "unknown" },
    }).success).toBe(true);
  });

  it("rejects unknown structured fields, invalid decisions, and oversized metadata", () => {
    const base = { schemaVersion: 1, expectedRevision: 0 };
    expect(universeDraftPatchSchema.safeParse({ ...base, payload: { kind: "approval", observedUpdatedAt: "bad", decision: "maybe", decisionNote: "" } }).success).toBe(false);
    expect(universeDraftPatchSchema.safeParse({ ...base, payload: { kind: "question", expectedVersion: 0, text: "", selectedValues: [], execute: true } }).success).toBe(false);
    expect(universeDraftPatchSchema.safeParse({ ...base, payload: { kind: "task", text: "x", attachmentAssetIds: [] }, pendingAttempt: { attemptId: "a", draftRevision: 0, payloadHash: "x".repeat(3000), state: "pending" } }).success).toBe(false);
  });

  it("rejects unknown destination kinds and extra keys", () => {
    expect(
      draftDestinationSchema.safeParse({ kind: "evil", id: "x" }).success,
    ).toBe(false);
    expect(
      draftDestinationSchema.safeParse({ kind: "task", id: "t1", userId: "u" })
        .success,
    ).toBe(false);
  });

  it("rejects oversized text, too many attachments and a wrong schemaVersion", () => {
    const base = { schemaVersion: 1, expectedRevision: 0, attachmentAssetIds: [] };
    expect(
      draftPatchSchema.safeParse({
        ...base,
        text: "x".repeat(UNIVERSE_DRAFT_MAX_TEXT + 1),
      }).success,
    ).toBe(false);
    expect(
      draftPatchSchema.safeParse({
        ...base,
        text: "ok",
        attachmentAssetIds: Array.from(
          { length: UNIVERSE_DRAFT_MAX_ATTACHMENTS + 1 },
          (_, i) => `a${i}`,
        ),
      }).success,
    ).toBe(false);
    expect(
      draftPatchSchema.safeParse({ ...base, schemaVersion: 2, text: "ok" })
        .success,
    ).toBe(false);
  });
});
