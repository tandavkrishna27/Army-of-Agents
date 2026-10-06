import { describe, expect, it } from "vitest";
import type { DiscussionDetail } from "../../../api/discussions";
import { extractUrlsFromThread } from "../threadViewerModel";

describe("null discussion title regression", () => {
  it("extracts entry URLs without crashing when a legacy thread title is null", () => {
    const thread = {
      title: null,
      entries: [{
        rawContent: "Reference https://example.com/brief",
        sourceInfo: null,
      }],
    } as unknown as DiscussionDetail;

    expect(extractUrlsFromThread(thread)).toEqual(["https://example.com/brief"]);
  });
});
