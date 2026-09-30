import { describe, expect, it } from "vitest";
import {
  getAttentionCount,
  getAvatarInitials,
  getInputSourceMeta,
  getScopeMeta,
} from "../threadCardMeta";

describe("threadCardMeta", () => {
  it("maps thread source, scope, attention, and avatar metadata", () => {
    expect(getInputSourceMeta("voice").label).toBe("Voice");
    expect(getInputSourceMeta("write").label).toBe("Paste");
    expect(getInputSourceMeta("scope_proposal").label).toBe("Proposal");

    expect(
      getScopeMeta({ scopeType: "department", scopeName: "Engineering" })?.label,
    ).toBe("Engineering");
    expect(getScopeMeta({ scopeType: null, scopeName: null })).toBeNull();

    expect(getAttentionCount({ pendingItemCount: 3 })).toEqual({
      count: 3,
      kind: "review",
    });
    expect(getAvatarInitials("Revenue Agent")).toBe("RA");
  });
});
