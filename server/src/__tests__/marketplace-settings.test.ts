import { describe, it, expect, vi } from "vitest";

// Mock drizzle-orm and @armyofagents/db to avoid ESM cycle in test env
vi.mock("drizzle-orm", () => ({
  eq: (..._args: unknown[]) => "eq",
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    marketplaceCompanySettings: makeTable("marketplace_company_settings"),
  };
});

// Pure function: mergeWithDefaults
import { mergeWithDefaults } from "../services/marketplace-settings.js";
import { MARKETPLACE_SETTINGS_DEFAULTS } from "@armyofagents/shared";

describe("mergeWithDefaults", () => {
  it("returns defaults when stored is empty", () => {
    const result = mergeWithDefaults({});
    expect(result).toEqual(MARKETPLACE_SETTINGS_DEFAULTS);
  });

  it("overrides individual fields", () => {
    const result = mergeWithDefaults({ pluginUpdatePolicy: "notify_all" });
    expect(result.pluginUpdatePolicy).toBe("notify_all");
    expect(result.skillUpdatePolicy).toBe("notify"); // default unchanged
  });

  it("ignores unknown keys", () => {
    const result = mergeWithDefaults({ unknownKey: "oops" } as any);
    expect(result).toEqual(MARKETPLACE_SETTINGS_DEFAULTS);
    expect("unknownKey" in result).toBe(false);
  });
});
