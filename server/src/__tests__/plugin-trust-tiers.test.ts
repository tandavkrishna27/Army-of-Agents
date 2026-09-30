import { describe, it, expect } from "vitest";
import { PLUGIN_TRUST_TIERS } from "@armyofagents/shared";

describe("PLUGIN_TRUST_TIERS", () => {
  it("includes untrusted, verified, and core", () => {
    expect(PLUGIN_TRUST_TIERS).toContain("untrusted");
    expect(PLUGIN_TRUST_TIERS).toContain("verified");
    expect(PLUGIN_TRUST_TIERS).toContain("core");
  });

  it("has exactly 3 values", () => {
    expect(PLUGIN_TRUST_TIERS).toHaveLength(3);
  });
});

describe("trustTier DB default", () => {
  it("'untrusted' is the first element and acts as the default", () => {
    expect(PLUGIN_TRUST_TIERS[0]).toBe("untrusted");
  });

  it("trustTier values are the canonical 3-tier model", () => {
    expect(PLUGIN_TRUST_TIERS).toEqual(["untrusted", "verified", "core"]);
  });
});
