/**
 * Integration tests for marketplace plugin integrity verification — Sprint 1 C11.
 *
 * Tests that catalog `npm.integrity` is forwarded into pluginLoader.installPlugin
 * as `catalogIntegrity` so the loader can verify the resolved package matches
 * what the catalog declares.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { plugins: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
}));

import { installMarketplacePlugin } from "../services/marketplace-install/plugin-installer.js";
import type { CatalogItem } from "@armyofagents/shared";

const SLACK_INTEGRITY =
  "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==";

const PLUGIN_WITH_INTEGRITY: CatalogItem = {
  id: "plugin:aoa-curated/aoa-plugin-slack",
  type: "plugin",
  name: "Slack",
  description: "Slack integration",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  npm: {
    packageName: "aoa-plugin-slack",
    version: "1.0.0",
    integrity: SLACK_INTEGRITY,
  },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  capabilities: [],
  category: "integrations",
  tags: [],
};

const PLUGIN_WITHOUT_INTEGRITY: CatalogItem = {
  ...PLUGIN_WITH_INTEGRITY,
  npm: { packageName: "aoa-plugin-slack", version: "1.0.0" },
};

const DISCOVERED_OK = {
  packagePath: "/tmp/aoa-plugin-slack",
  packageName: "aoa-plugin-slack",
  version: "1.0.0",
  source: "npm" as const,
  manifest: { id: "aoa.slack", displayName: "Slack" },
};

function makeMockDb() {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  };
}

describe("installMarketplacePlugin — integrity wiring", () => {
  it("forwards catalogIntegrity to installPlugin when the catalog declares npm.integrity", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const installPluginMock = vi.fn(async (opts: Record<string, unknown>) => {
      captured.push(opts);
      return DISCOVERED_OK;
    });

    await installMarketplacePlugin({
      catalogItem: PLUGIN_WITH_INTEGRITY,
      companyId: "c1",
      db: makeMockDb() as any,
      pluginLoader: {
        installPlugin: installPluginMock,
        registry: { getByKeyScoped: vi.fn(async () => ({ id: "plug-uuid-1", pluginKey: "aoa.slack" })) },
        lifecycle: { load: vi.fn(async () => {}) },
      } as any,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].catalogIntegrity).toBe(SLACK_INTEGRITY);
    expect(captured[0].packageName).toBe("aoa-plugin-slack");
    expect(captured[0].version).toBe("1.0.0");
  });

  it("propagates IntegrityMismatchError when the loader rejects on integrity mismatch", async () => {
    const installPluginMock = vi.fn(async () => {
      const err = new Error(
        "Plugin aoa-plugin-slack integrity mismatch: expected sha512-abc actual sha512-xyz",
      );
      err.name = "IntegrityMismatchError";
      throw err;
    });

    await expect(
      installMarketplacePlugin({
        catalogItem: PLUGIN_WITH_INTEGRITY,
        companyId: "c1",
        db: makeMockDb() as any,
        pluginLoader: {
          installPlugin: installPluginMock,
          registry: { getByKeyScoped: vi.fn() },
          lifecycle: { load: vi.fn() },
        } as any,
      }),
    ).rejects.toThrow(/aoa-plugin-slack.*sha512-abc.*sha512-xyz/);
  });

  it("does not pass catalogIntegrity when the catalog omits it (backward compat)", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const installPluginMock = vi.fn(async (opts: Record<string, unknown>) => {
      captured.push(opts);
      return DISCOVERED_OK;
    });

    await installMarketplacePlugin({
      catalogItem: PLUGIN_WITHOUT_INTEGRITY,
      companyId: "c1",
      db: makeMockDb() as any,
      pluginLoader: {
        installPlugin: installPluginMock,
        registry: { getByKeyScoped: vi.fn(async () => ({ id: "plug-uuid-2", pluginKey: "aoa.slack" })) },
        lifecycle: { load: vi.fn(async () => {}) },
      } as any,
    });

    expect(captured).toHaveLength(1);
    // catalogIntegrity is either omitted or undefined — both are fine
    expect(captured[0].catalogIntegrity).toBeUndefined();
  });

  it("forwards integrity even when catalog ships a tarballUrl", async () => {
    const tarballUrl = "https://github.com/example/foo-1.0.0.tgz";
    const catalog: CatalogItem = {
      ...PLUGIN_WITH_INTEGRITY,
      npm: {
        packageName: "aoa-plugin-slack",
        version: "1.0.0",
        tarballUrl,
        integrity: SLACK_INTEGRITY,
      },
    };
    const captured: Array<Record<string, unknown>> = [];
    const installPluginMock = vi.fn(async (opts: Record<string, unknown>) => {
      captured.push(opts);
      return DISCOVERED_OK;
    });

    await installMarketplacePlugin({
      catalogItem: catalog,
      companyId: "c1",
      db: makeMockDb() as any,
      pluginLoader: {
        installPlugin: installPluginMock,
        registry: { getByKeyScoped: vi.fn(async () => ({ id: "plug-uuid-3", pluginKey: "aoa.slack" })) },
        lifecycle: { load: vi.fn(async () => {}) },
      } as any,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].packageName).toBe(tarballUrl);
    expect(captured[0].catalogIntegrity).toBe(SLACK_INTEGRITY);
  });
});
