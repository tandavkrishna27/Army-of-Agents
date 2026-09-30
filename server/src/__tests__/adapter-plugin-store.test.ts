import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAdapterPlugin,
  getAdapterPluginByType,
  getAdapterPluginsDir,
  getDisabledAdapterTypes,
  isAdapterDisabled,
  listAdapterPlugins,
  removeAdapterPlugin,
  setAdapterDisabled,
  __resetAdapterPluginStoreCaches,
} from "../services/adapter-plugin-store.js";

describe("adapter-plugin-store", () => {
  const originalAoaHome = process.env.AOA_HOME;
  const cleanupDirs = new Set<string>();

  async function makeHome(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-adapter-plugin-store-"));
    cleanupDirs.add(dir);
    return dir;
  }

  beforeEach(() => {
    __resetAdapterPluginStoreCaches();
  });

  afterEach(async () => {
    if (originalAoaHome === undefined) delete process.env.AOA_HOME;
    else process.env.AOA_HOME = originalAoaHome;
    __resetAdapterPluginStoreCaches();
    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("returns empty list when registry file does not exist", async () => {
    process.env.AOA_HOME = await makeHome();
    expect(listAdapterPlugins()).toEqual([]);
  });

  it("persists a registered adapter and returns it on list", async () => {
    process.env.AOA_HOME = await makeHome();
    addAdapterPlugin({
      packageName: "my-custom-llm-adapter",
      version: "1.0.0",
      type: "custom-llm",
      installedAt: new Date().toISOString(),
    });
    const adapters = listAdapterPlugins();
    expect(adapters).toHaveLength(1);
    expect(adapters[0].type).toBe("custom-llm");
    expect(adapters[0].packageName).toBe("my-custom-llm-adapter");
  });

  it("upserts a record when re-adding same type", async () => {
    process.env.AOA_HOME = await makeHome();
    addAdapterPlugin({
      packageName: "foo",
      version: "1.0.0",
      type: "custom-llm",
      installedAt: "2024-01-01T00:00:00.000Z",
    });
    addAdapterPlugin({
      packageName: "foo",
      version: "2.0.0",
      type: "custom-llm",
      installedAt: "2024-02-01T00:00:00.000Z",
    });
    const adapters = listAdapterPlugins();
    expect(adapters).toHaveLength(1);
    expect(adapters[0].version).toBe("2.0.0");
  });

  it("removes an adapter from the registry on remove", async () => {
    process.env.AOA_HOME = await makeHome();
    addAdapterPlugin({
      packageName: "foo",
      version: "1.0.0",
      type: "custom-llm",
      installedAt: new Date().toISOString(),
    });
    const removed = removeAdapterPlugin("custom-llm");
    expect(removed).toBe(true);
    expect(listAdapterPlugins()).toEqual([]);
  });

  it("returns false when removing a type that doesn't exist", async () => {
    process.env.AOA_HOME = await makeHome();
    expect(removeAdapterPlugin("nonexistent")).toBe(false);
  });

  it("getAdapterPluginByType returns the record or undefined", async () => {
    process.env.AOA_HOME = await makeHome();
    addAdapterPlugin({
      packageName: "foo",
      type: "custom-llm",
      installedAt: new Date().toISOString(),
    });
    expect(getAdapterPluginByType("custom-llm")?.packageName).toBe("foo");
    expect(getAdapterPluginByType("unknown")).toBeUndefined();
  });

  it("getAdapterPluginsDir creates and returns the managed directory with package.json", async () => {
    const home = await makeHome();
    process.env.AOA_HOME = home;
    const dir = getAdapterPluginsDir();
    expect(dir).toBe(path.join(home, "adapter-plugins"));
    const pkgRaw = await fs.readFile(path.join(dir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    expect(pkg.private).toBe(true);
  });

  it("setAdapterDisabled toggles disabled flag and persists", async () => {
    process.env.AOA_HOME = await makeHome();
    expect(isAdapterDisabled("claude-local")).toBe(false);
    expect(setAdapterDisabled("claude-local", true)).toBe(true);
    expect(isAdapterDisabled("claude-local")).toBe(true);
    expect(getDisabledAdapterTypes()).toEqual(["claude-local"]);

    expect(setAdapterDisabled("claude-local", true)).toBe(false);
    expect(setAdapterDisabled("claude-local", false)).toBe(true);
    expect(isAdapterDisabled("claude-local")).toBe(false);
  });
});
