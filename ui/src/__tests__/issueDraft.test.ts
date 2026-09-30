import { describe, it, expect } from "vitest";
import { pruneStaleId } from "../lib/issueDraft";

describe("pruneStaleId", () => {
  const validIds = new Set(["agent-a", "agent-b"]);

  it("returns the id when it is in the valid set", () => {
    expect(pruneStaleId("agent-a", validIds)).toBe("agent-a");
  });

  it("returns empty string when the id is not in the valid set", () => {
    expect(pruneStaleId("agent-ghost", validIds)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(pruneStaleId("", validIds)).toBe("");
  });

  it("returns empty string for null input", () => {
    expect(pruneStaleId(null, validIds)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(pruneStaleId(undefined, validIds)).toBe("");
  });

  it("returns empty string when valid set is empty", () => {
    expect(pruneStaleId("agent-a", new Set<string>())).toBe("");
  });
});
