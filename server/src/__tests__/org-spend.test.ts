import { describe, expect, it } from "vitest";
import { summarizeOrgSpend } from "../services/org-spend.js";

describe("summarizeOrgSpend", () => {
  it("rolls up cost_events rows by provider and total cents", () => {
    const summary = summarizeOrgSpend([
      { provider: "anthropic", costCents: 120 },
      { provider: "anthropic", costCents: 80 },
      { provider: "openai", costCents: 50 },
    ]);
    expect(summary.totalCents).toBe(250);
    expect(summary.byProvider).toEqual([
      { provider: "anthropic", costCents: 200 },
      { provider: "openai", costCents: 50 },
    ]);
  });
  it("returns zero for no rows", () => {
    expect(summarizeOrgSpend([])).toEqual({ totalCents: 0, byProvider: [] });
  });
});
