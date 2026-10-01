import { describe, expect, it } from "vitest";
import { getRouteSidebarMode } from "./sidebarPolicy";

describe("getRouteSidebarMode", () => {
  it.each([
    ["/UAT/settings", "compact"],
    ["/UAT/team", "compact"],
    ["/UAT/inbox", "compact"],
    ["/UAT/skills", "compact"],
    ["/UAT/commander", "hidden"],
    ["/UAT/discussions", "hidden"],
  ])("maps %s to %s", (pathname, expected) => {
    expect(getRouteSidebarMode(pathname)).toBe(expected);
  });

  it("leaves ordinary and memory routes user-controlled", () => {
    expect(getRouteSidebarMode("/UAT/home")).toBeNull();
    expect(getRouteSidebarMode("/UAT/memory")).toBeNull();
  });
});
