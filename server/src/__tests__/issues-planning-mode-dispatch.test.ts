import { describe, expect, it } from "vitest";
import { shouldDispatchIssueWakeup } from "../routes/issues-planning-mode-dispatch.js";

describe("shouldDispatchIssueWakeup", () => {
  it("returns true for standard mode", () => {
    expect(shouldDispatchIssueWakeup({ workMode: "standard" })).toBe(true);
  });

  it("returns false for planning mode", () => {
    expect(shouldDispatchIssueWakeup({ workMode: "planning" })).toBe(false);
  });

  it("returns true for unknown/null work mode (safe default)", () => {
    expect(shouldDispatchIssueWakeup({ workMode: null as unknown as string })).toBe(true);
    expect(shouldDispatchIssueWakeup({ workMode: "" })).toBe(true);
  });
});
