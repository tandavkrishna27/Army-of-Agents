import { describe, expect, it } from "vitest";
import type { HealthFinding } from "@armyofagents/shared";
import { buildHealthSummary, deriveHealthStatus, sortHealthFindings } from "../services/health/status.js";

const base = {
  id: "base",
  scope: "company",
  category: "setup",
  title: "Finding",
  message: "Message",
  detectedAt: "2026-05-25T00:00:00.000Z",
} satisfies Omit<HealthFinding, "severity">;

describe("health status helpers", () => {
  it("derives critical when any error exists", () => {
    expect(deriveHealthStatus([{ ...base, severity: "error" }])).toBe("critical");
  });

  it("derives needs_attention when warnings exist without errors", () => {
    expect(deriveHealthStatus([{ ...base, severity: "warning" }])).toBe("needs_attention");
  });

  it("derives healthy for info-only findings", () => {
    expect(deriveHealthStatus([{ ...base, severity: "info" }])).toBe("healthy");
  });

  it("builds severity counts", () => {
    const summary = buildHealthSummary(
      [
        { ...base, id: "e", severity: "error" },
        { ...base, id: "w", severity: "warning" },
        { ...base, id: "i", severity: "info" },
      ],
      "2026-05-25T00:00:00.000Z",
    );
    expect(summary).toMatchObject({ errorCount: 1, warningCount: 1, infoCount: 1 });
  });

  it("sorts errors before warnings before info", () => {
    const sorted = sortHealthFindings([
      { ...base, id: "i", severity: "info" },
      { ...base, id: "e", severity: "error" },
      { ...base, id: "w", severity: "warning" },
    ]);
    expect(sorted.map((finding) => finding.id)).toEqual(["e", "w", "i"]);
  });
});
