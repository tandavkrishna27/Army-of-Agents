import { describe, it, expect } from "vitest";
import { getInitials } from "@/lib/initials";

describe("getInitials", () => {
  it("returns first letter of two words", () => {
    expect(getInitials("Tandav Krishna")).toBe("TK");
  });
  it("returns first + last letter for 3+ word names", () => {
    expect(getInitials("Sam Marquez Jr")).toBe("SJ");
  });
  it("falls back to first 2 letters when only one word", () => {
    expect(getInitials("Maya")).toBe("MA");
  });
  it("returns empty string for empty input", () => {
    expect(getInitials("")).toBe("");
  });
  it("uppercases output", () => {
    expect(getInitials("alice bob")).toBe("AB");
  });
  it("handles single-character names", () => {
    expect(getInitials("X")).toBe("X");
  });
});
