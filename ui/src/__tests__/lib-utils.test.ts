import { describe, it, expect } from "vitest";
import { billingTypeDisplayName } from "../lib/utils";
import type { AdapterBillingType } from "@armyofagents/adapter-utils";

// ── T15: billingTypeDisplayName covers all 8 AdapterBillingType variants ────

describe("billingTypeDisplayName (T15)", () => {
  it("returns correct label for all 8 AdapterBillingType variants", () => {
    const cases: Array<[AdapterBillingType, string]> = [
      ["api", "API"],
      ["subscription", "Subscription"],
      ["metered_api", "Metered API"],
      ["subscription_included", "Subscription (included)"],
      ["subscription_overage", "Subscription (overage)"],
      ["credits", "Credits"],
      ["fixed", "Fixed fee"],
      ["unknown", "Unknown"],
    ];
    for (const [variant, expected] of cases) {
      expect(billingTypeDisplayName(variant), `variant: ${variant}`).toBe(expected);
    }
  });

  it("handles null/undefined gracefully", () => {
    expect(billingTypeDisplayName(null)).toBe("Unknown");
    expect(billingTypeDisplayName(undefined)).toBe("Unknown");
    expect(billingTypeDisplayName("")).toBe("Unknown");
  });

  it("falls back to raw string for unrecognized values", () => {
    // Forward-compatibility: future variants or legacy strings pass through unchanged
    expect(billingTypeDisplayName("subscription_claude")).toBe("subscription_claude");
    expect(billingTypeDisplayName("mystery_type")).toBe("mystery_type");
  });
});
