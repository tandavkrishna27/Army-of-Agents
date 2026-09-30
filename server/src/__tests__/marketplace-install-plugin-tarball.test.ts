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

const TARBALL_URL =
  "https://github.com/MeteoriteLabs/aoa-marketplace/releases/download/v1.0.0/aoa-plugin-slack-1.0.0.tgz";

const SLACK_PLUGIN_WITH_TARBALL: CatalogItem = {
  id: "plugin:aoa-curated/aoa-plugin-slack",
  type: "plugin",
  name: "Slack",
  description: "Slack integration",
  version: "1.0.0",
  source: {
    adapter: "aoa-curated",
    url: "https://github.com/MeteoriteLabs/aoa-marketplace",
    locator: "plugins/aoa-plugin-slack",
    commitSha: "abc123",
  },
  npm: {
    packageName: "aoa-plugin-slack",
    version: "1.0.0",
    tarballUrl: TARBALL_URL,
  },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-05-06T00:00:00Z",
  category: "integrations",
  tags: [],
};

const SLACK_PLUGIN_NO_TARBALL: CatalogItem = {
  ...SLACK_PLUGIN_WITH_TARBALL,
  npm: { packageName: "aoa-plugin-slack", version: "1.0.0" },
};

describe("installMarketplacePlugin — tarball routing", () => {
  const makeLoader = (capturedSpec: { packageName?: string; version?: string; companyId?: string; catalogItemId?: string }[]) => ({
    installPlugin: vi.fn(async (opts: { packageName?: string; version?: string; companyId?: string; catalogItemId?: string }) => {
      capturedSpec.push(opts);
      return {
        packagePath: "/plugins/aoa-plugin-slack",
        packageName: "aoa-plugin-slack",
        version: "1.0.0",
        source: "npm",
        manifest: { id: "aoa.plugin-slack" },
      };
    }),
    registry: {
      getByKeyScoped: vi.fn(async () => ({ id: "plugin-uuid", pluginKey: "aoa.plugin-slack" })),
    },
    lifecycle: {
      load: vi.fn(async () => {}),
    },
  });

  const mockDb = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  };

  it("passes tarball URL as packageName (no version) when tarballUrl is present", async () => {
    const captured: { packageName?: string; version?: string }[] = [];
    const loader = makeLoader(captured);

    await installMarketplacePlugin({
      catalogItem: SLACK_PLUGIN_WITH_TARBALL,
      companyId: "c-1",
      db: mockDb as any,
      pluginLoader: loader,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].packageName).toBe(TARBALL_URL);
    expect(captured[0].version).toBeUndefined();
  });

  it("passes packageName + version when tarballUrl is absent", async () => {
    const captured: { packageName?: string; version?: string }[] = [];
    const loader = makeLoader(captured);

    await installMarketplacePlugin({
      catalogItem: SLACK_PLUGIN_NO_TARBALL,
      companyId: "c-1",
      db: mockDb as any,
      pluginLoader: loader,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].packageName).toBe("aoa-plugin-slack");
    expect(captured[0].version).toBe("1.0.0");
  });
});
