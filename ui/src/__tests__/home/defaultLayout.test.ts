import { describe, it, expect } from "vitest";
import { getDefaultLayout } from "../../components/home/defaultLayout";
import { widgetRegistry } from "../../components/home/widgets/registry";

describe("getDefaultLayout", () => {
  it("returns only registered keys for every role", () => {
    for (const role of ["founder", "team_lead", "team_member", null] as const)
      for (const key of getDefaultLayout(role)) expect(widgetRegistry[key]).toBeDefined();
  });

  // Plan 7 Task 5: curated the founder default down from "every registered
  // widget" (10) to a smaller, prioritized set (8) — suggestions and
  // memory-review are tray-only now, not dropped from the registry.
  it("founder default is the curated 8-widget board, including budget, approvals, and discussions, but not suggestions or memory-review", () => {
    const founder = getDefaultLayout("founder");
    expect(founder).toContain("budget");
    expect(founder).toContain("approvals");
    expect(founder).toContain("discussions");
    expect(founder).not.toContain("memory-review");
    expect(founder).not.toContain("suggestions");
    expect(founder).toHaveLength(8);
  });

  it("team_lead and null get the same oversight board as founder", () => {
    expect(getDefaultLayout("team_lead")).toEqual(getDefaultLayout("founder"));
    expect(getDefaultLayout(null)).toEqual(getDefaultLayout("founder"));
  });

  // Plan 7 Task 5: "approvals" (Waiting on you) is now on the member default
  // too (it flipped from excluded to included); budget, suggestions, and
  // memory-review remain founder/tray-only.
  it("member default excludes budget, suggestions, and memory-review, includes approvals and discussions, and starts with my-tasks", () => {
    const member = getDefaultLayout("team_member");
    expect(member).not.toContain("budget");
    expect(member).not.toContain("suggestions");
    expect(member).not.toContain("memory-review");
    expect(member).toContain("approvals");
    expect(member).toContain("discussions");
    expect(member[0]).toBe("my-tasks");
    expect(member).toHaveLength(7);
  });
});
