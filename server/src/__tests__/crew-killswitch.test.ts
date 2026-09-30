import { describe, it, expect } from "vitest";
import { isCrewPaused } from "../services/internal-agent/aoa-agents/kill-switch.js";

describe("isCrewPaused", () => {
  it("paused when the company crew halt is on", () => {
    expect(isCrewPaused({ companyPaused: true, threadPaused: false })).toBe(true);
  });
  it("paused when the specific thread's crew is paused", () => {
    expect(isCrewPaused({ companyPaused: false, threadPaused: true })).toBe(true);
  });
  it("runs when neither is paused", () => {
    expect(isCrewPaused({ companyPaused: false, threadPaused: false })).toBe(false);
  });
});
