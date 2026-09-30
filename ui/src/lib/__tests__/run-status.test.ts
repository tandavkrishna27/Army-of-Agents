import { describe, it, expect } from "vitest";
import { CheckCircle2, Clock } from "lucide-react";
import {
  getRunStatusIcon,
  formatDuration,
  triggerTypeColors,
  runSourceLabels,
} from "../run-status";

describe("getRunStatusIcon", () => {
  it("maps known statuses", () => {
    expect(getRunStatusIcon("succeeded").icon).toBe(CheckCircle2);
    expect(getRunStatusIcon("succeeded").color).toContain("green");
  });
  it("falls back to a neutral Clock for unknown status", () => {
    const fallback = getRunStatusIcon("totally_unknown");
    expect(fallback.icon).toBe(Clock);
    expect(fallback.color).toContain("neutral");
  });
});

describe("formatDuration", () => {
  it("returns '-' for null/zero/negative", () => {
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(0)).toBe("-");
    expect(formatDuration(-5)).toBe("-");
  });
  it("formats sub-minute as seconds", () => {
    expect(formatDuration(4200)).toBe("4s");
  });
  it("formats minutes + seconds", () => {
    expect(formatDuration(134_000)).toBe("2m 14s");
  });
});

describe("maps", () => {
  it("has the four trigger-type colors and source labels", () => {
    expect(Object.keys(triggerTypeColors)).toEqual(
      expect.arrayContaining(["conversation", "proactive", "event", "sub_agent"]),
    );
    expect(runSourceLabels.on_demand).toBe("On-demand");
  });
});
