import { describe, expect, it } from "vitest";
import { afterAcknowledgement, type SentSnapshot } from "../draft-state";

describe("afterAcknowledgement", () => {
  it("keeps text typed after Send", () => {
    const sent: SentSnapshot = {
      revision: 4,
      text: "first",
      attachmentAssetIds: [],
      clientSubmissionId: "s1",
    };
    const current = { revision: 5, text: "second", attachmentAssetIds: [] };
    expect(afterAcknowledgement(current, sent)).toEqual(current);
  });

  it("clears exactly the acknowledged snapshot", () => {
    const sent: SentSnapshot = {
      revision: 4,
      text: "first",
      attachmentAssetIds: [],
      clientSubmissionId: "s1",
    };
    const current = { revision: 4, text: "first", attachmentAssetIds: [] };
    expect(afterAcknowledgement(current, sent)).toEqual({
      revision: 4,
      text: "",
      attachmentAssetIds: [],
    });
  });

  it("retains the draft when attachments changed after Send even if text matches", () => {
    const sent: SentSnapshot = {
      revision: 4,
      text: "hi",
      attachmentAssetIds: ["a1"],
      clientSubmissionId: "s1",
    };
    const current = { revision: 4, text: "hi", attachmentAssetIds: ["a1", "a2"] };
    expect(afterAcknowledgement(current, sent)).toEqual(current);
  });

  it("clears when text and attachments both still match the sent snapshot", () => {
    const sent: SentSnapshot = {
      revision: 7,
      text: "done",
      attachmentAssetIds: ["a1", "a2"],
      clientSubmissionId: "s2",
    };
    const current = { revision: 7, text: "done", attachmentAssetIds: ["a1", "a2"] };
    expect(afterAcknowledgement(current, sent)).toEqual({
      revision: 7,
      text: "",
      attachmentAssetIds: [],
    });
  });
});
