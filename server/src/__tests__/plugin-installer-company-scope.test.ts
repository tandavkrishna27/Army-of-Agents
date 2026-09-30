import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted() runs at hoist time — before vi.mock factories — so these
// variables are safe to reference inside the mock factories below.
const { capturedEqArgs, symbols } = vi.hoisted(() => ({
  capturedEqArgs: [] as unknown[][],
  symbols: {} as { companyId?: symbol },
}));

vi.mock("@armyofagents/db", () => {
  const companyIdSym = Symbol("companyId");
  symbols.companyId = companyIdSym;
  const pluginsProxy = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "companyId") return companyIdSym;
      return Symbol(String(prop));
    },
  });
  return {
    plugins: pluginsProxy,
    companies: new Proxy({}, { get: () => Symbol("col") }),
  };
});

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => {
    capturedEqArgs.push(args);
    return Symbol("op:eq");
  },
  and: () => Symbol("op:and"),
  asc: () => Symbol("op:asc"),
  sql: new Proxy(
    Object.assign(function () { return Symbol("sql"); }, { raw: () => Symbol("sql") }),
    { get: (_t: any, p: string) => p === "raw" ? () => Symbol("sql") : () => Symbol("sql") },
  ),
  ne: () => Symbol("op:ne"),
  desc: () => Symbol("op:desc"),
}));

import { installMarketplacePlugin } from "../services/marketplace-install/plugin-installer.js";

beforeEach(() => { capturedEqArgs.length = 0; });

const makeDb = (existingPlugins: any[]) => ({
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(existingPlugins),
      }),
    }),
  }),
  insert: () => ({ values: () => Promise.resolve() }),
});

describe("installMarketplacePlugin companyId scoping", () => {
  it("idempotency check scopes by packageName — same version returns alreadyInstalled", async () => {
    const db = makeDb([{ id: "plug-1", version: "1.0.0", companyId: "co-a" }]) as any;
    const loader = {
      installPlugin: vi.fn(),
      registry: { getByKeyScoped: vi.fn() },
      lifecycle: { load: vi.fn() },
    };
    const result = await installMarketplacePlugin({
      catalogItem: {
        type: "plugin",
        id: "plugin:test",
        npm: { packageName: "@test/plugin", version: "1.0.0" },
      } as any,
      companyId: "co-a",
      db,
      pluginLoader: loader,
    });
    expect(result.alreadyInstalled).toBe(true);
    expect(loader.installPlugin).not.toHaveBeenCalled();
  });

  it("passes companyId to installPlugin and uses getByKeyScoped for registry lookup", async () => {
    const db = makeDb([]) as any;
    const getByKeyScoped = vi.fn(async () => ({ id: "plug-2", pluginKey: "test.plugin" }));
    const installPlugin = vi.fn(async () => ({
      packagePath: "/tmp/test",
      packageName: "@test/plugin",
      version: "1.0.0",
      source: "npm",
      manifest: { id: "test.plugin" },
    }));
    const load = vi.fn(async () => {});
    const loader = {
      installPlugin,
      registry: { getByKeyScoped },
      lifecycle: { load },
    };

    const result = await installMarketplacePlugin({
      catalogItem: {
        type: "plugin",
        id: "plugin:test",
        npm: { packageName: "@test/plugin", version: "1.0.0" },
      } as any,
      companyId: "co-b",
      db,
      pluginLoader: loader,
    });

    expect(installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "co-b" }),
    );
    expect(getByKeyScoped).toHaveBeenCalledWith("test.plugin", "co-b");
    expect(load).toHaveBeenCalledWith("plug-2");
    expect(result.pluginId).toBe("plug-2");
    expect(result.alreadyInstalled).toBe(false);
  });
});

describe("pluginRegistryService.install — nextInstallOrder company scoping", () => {
  it("passes companyId to eq() when computing MAX install order", async () => {
    const { pluginRegistryService } = await import(
      "../services/plugin-registry.js"
    );

    let selectN = 0;
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => {
            selectN++;
            // call 1: getByKeyScoped check → no existing row (not found)
            // call 2: nextInstallOrder MAX query → max is 2
            return selectN === 1
              ? Promise.resolve([])
              : Promise.resolve([{ maxOrder: 2 }]);
          },
        }),
      }),
      insert: () => ({
        values: (vals: any) => ({
          returning: () =>
            Promise.resolve([{ ...vals, id: "plug-new", installOrder: 3 }]),
        }),
      }),
    };

    const registry = pluginRegistryService(mockDb as any);
    const result = await registry.install(
      { packageName: "@test/plugin" } as any,
      {
        id: "test.plugin",
        version: "1.0.0",
        apiVersion: "1.0",
        categories: [],
        capabilities: [],
      } as any,
      "co-a",
    );

    // After the fix, eq(plugins.companyId, "co-a") must appear among captured calls
    // at least twice: once in getByKeyScoped and once in nextInstallOrder.
    const pluginsCompanyIdSymbol = symbols.companyId!;
    const scopedCalls = capturedEqArgs.filter(
      ([col, val]) => col === pluginsCompanyIdSymbol && val === "co-a",
    );
    expect(scopedCalls.length).toBeGreaterThanOrEqual(2);

    // Behavioral check: the install order must be maxOrder(2) + 1 = 3
    expect(result?.installOrder).toBe(3);
  });
});
