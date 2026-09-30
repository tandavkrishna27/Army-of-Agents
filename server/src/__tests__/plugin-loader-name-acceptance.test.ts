import { describe, it, expect, vi } from "vitest";

// Mock drizzle-orm and @armyofagents/db to break the ESM cycle when importing
// from plugin-loader (which transitively pulls in plugin-registry → drizzle).
// See CLAUDE.md shared test patterns.
vi.mock("drizzle-orm", () => ({
  asc: vi.fn(),
  eq: vi.fn(),
  ne: vi.fn(),
  sql: vi.fn(),
  and: vi.fn(),
}));

vi.mock("@armyofagents/db", () => ({
  plugins: {} as unknown,
  pluginConfig: {} as unknown,
  pluginCompanySettings: {} as unknown,
  pluginEntities: {} as unknown,
  pluginJobs: {} as unknown,
  pluginJobRuns: {} as unknown,
  pluginLogs: {} as unknown,
  pluginState: {} as unknown,
  pluginWebhookDeliveries: {} as unknown,
}));

import { isPluginPackageName } from "../services/plugin-loader.js";

describe("isPluginPackageName — name convention acceptance", () => {
  it("accepts paperclip-plugin-* (legacy)", () => {
    expect(isPluginPackageName("paperclip-plugin-linear")).toBe(true);
  });

  it("accepts @scope/plugin-* (scoped)", () => {
    expect(isPluginPackageName("@armyofagents/plugin-discord")).toBe(true);
  });

  it("accepts aoa-plugin-* (current AoA convention)", () => {
    expect(isPluginPackageName("aoa-plugin-discord")).toBe(true);
    expect(isPluginPackageName("aoa-plugin-slack")).toBe(true);
    expect(isPluginPackageName("aoa-plugin-github-issues")).toBe(true);
  });

  it("rejects unrelated package names", () => {
    expect(isPluginPackageName("some-random-package")).toBe(false);
    expect(isPluginPackageName("react")).toBe(false);
  });
});
