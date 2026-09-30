import { describe, expect, it } from "vitest";
import { shouldUseFullBleedMain } from "../Layout";

describe("Layout full-bleed inbox", () => {
  it("makes the inbox hub edge-to-edge (browse + detail)", () => {
    expect(shouldUseFullBleedMain("/QAL/inbox", "QAL")).toBe(true);
    expect(shouldUseFullBleedMain("/QAL/inbox/waiting/123", "QAL")).toBe(true);
    expect(shouldUseFullBleedMain("/QAL/inbox-hub/waiting", "QAL")).toBe(true);
  });

  it("does not regress other sections", () => {
    // Home is NOT full-bleed.
    expect(shouldUseFullBleedMain("/QAL/home", "QAL")).toBe(false);
    // Existing full-bleed case stays true.
    expect(shouldUseFullBleedMain("/QAL/discussions", "QAL")).toBe(true);
  });
});
