import { expect, it, describe } from "vitest";
import { shouldAutoScroll } from "./InternalAgentPanel";

describe("shouldAutoScroll — 120px proximity threshold", () => {
  it("auto-scrolls when user is within 120px of the bottom", () => {
    // scrollHeight=1000, scrollTop=880, clientHeight=100 → 20px from bottom
    expect(shouldAutoScroll(1000, 880, 100)).toBe(true);
  });

  it("auto-scrolls when exactly at the threshold boundary (120px)", () => {
    // 1000 - 780 - 100 = 120px from bottom → equal to threshold → scroll
    expect(shouldAutoScroll(1000, 780, 100)).toBe(true);
  });

  it("does NOT auto-scroll when user has scrolled more than 120px from bottom", () => {
    // 1000 - 500 - 100 = 400px from bottom → do not snap
    expect(shouldAutoScroll(1000, 500, 100)).toBe(false);
  });

  it("auto-scrolls when container is fully scrolled to bottom", () => {
    // 0px from bottom
    expect(shouldAutoScroll(1000, 900, 100)).toBe(true);
  });
});
