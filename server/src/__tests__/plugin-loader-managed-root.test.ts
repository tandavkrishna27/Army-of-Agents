import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execNpm = vi.hoisted(() => vi.fn());
const registry = vi.hoisted(() => ({
  getByPackageNameScoped: vi.fn(),
  listInstalledForCompanies: vi.fn(),
  install: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../utils/npm-spawn.js", () => ({ execNpm }));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

import {
  pluginLoader,
  resolveManagedCompanyInstallDir,
  resolveWorkerEntrypoint,
} from "../services/plugin-loader.js";

let root: string;

function writeInstalledPackage(prefix: string, version: string) {
  fs.mkdirSync(prefix, { recursive: true });
  fs.writeFileSync(
    path.join(prefix, "package.json"),
    JSON.stringify({ private: true })
  );
  const packageDir = path.join(prefix, "node_modules", "@acme", "shared");
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@acme/shared",
      version,
      type: "module",
      paperclipPlugin: { manifest: "./dist/manifest.js" },
    })
  );
  const manifest = {
    id: "acme.shared",
    apiVersion: 1,
    version,
    displayName: "Shared",
    description: "Tenant-scoped plugin fixture",
    author: "AoA",
    categories: ["automation"],
    capabilities: [],
    entrypoints: { worker: "./dist/worker.js" },
  };
  fs.writeFileSync(
    path.join(packageDir, "dist", "manifest.js"),
    `export default ${JSON.stringify(manifest)};\n`
  );
  return packageDir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-plugin-roots-"));
  for (const mock of Object.values(registry)) mock.mockReset();
  registry.getByPackageNameScoped.mockResolvedValue(null);
  registry.listInstalledForCompanies.mockResolvedValue([]);
  registry.install.mockResolvedValue({ id: "plugin-row" });
  registry.update.mockResolvedValue({ id: "plugin-row" });
  execNpm.mockReset();
  execNpm.mockImplementation(async (args: string[]) => {
    const prefix = args[args.indexOf("--prefix") + 1];
    if (args[0] === "install") {
      writeInstalledPackage(
        prefix,
        args[1].includes("2.0.0") ? "2.0.0" : "1.0.0"
      );
    }
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("managed plugin artifact tenant isolation", () => {
  it("does not fall back to the legacy shared package when a persisted path is missing", () => {
    const legacyPath = writeInstalledPackage(root, "1.0.0");
    fs.writeFileSync(
      path.join(legacyPath, "dist", "worker.js"),
      "export default {}\n"
    );

    expect(() =>
      resolveWorkerEntrypoint(
        {
          pluginKey: "acme.shared",
          packageName: "@acme/shared",
          packagePath: path.join(root, "companies", "company-a", "missing"),
          manifestJson: {
            entrypoints: { worker: "./dist/worker.js" },
          },
        } as any,
        root
      )
    ).toThrow(/persisted package path/);
  });

  it("installs the same npm package into distinct company prefixes and persists exact paths", async () => {
    const loader = pluginLoader({} as any, { localPluginDir: root });
    await loader.installPlugin({
      packageName: "@acme/shared",
      version: "1.0.0",
      companyId: "company-a",
    });
    await loader.installPlugin({
      packageName: "@acme/shared",
      version: "1.0.0",
      companyId: "company-b",
    });

    const prefixes = execNpm.mock.calls.map(
      ([args]) => args[args.indexOf("--prefix") + 1]
    );
    expect(prefixes).toEqual([
      resolveManagedCompanyInstallDir(root, "company-a"),
      resolveManagedCompanyInstallDir(root, "company-b"),
    ]);
    expect(registry.install.mock.calls[0][0].packagePath).toBe(
      path.join(prefixes[0], "node_modules", "@acme", "shared")
    );
    expect(registry.install.mock.calls[1][0].packagePath).toBe(
      path.join(prefixes[1], "node_modules", "@acme", "shared")
    );
  });

  it("rejects an active same-package reinstall before mutating npm state", async () => {
    registry.getByPackageNameScoped.mockResolvedValue({ status: "ready" });
    const loader = pluginLoader({} as any, { localPluginDir: root });
    await expect(
      loader.installPlugin({
        packageName: "@acme/shared",
        companyId: "company-a",
      })
    ).rejects.toThrow(/already installed/);
    expect(execNpm).not.toHaveBeenCalled();
  });

  it("upgrades only the owning company path and persists the replacement path", async () => {
    const companyBPath = writeInstalledPackage(
      resolveManagedCompanyInstallDir(root, "company-b"),
      "1.0.0"
    );
    registry.getById.mockResolvedValue({
      id: "plugin-a",
      companyId: "company-a",
      packageName: "@acme/shared",
      packagePath: path.join(
        resolveManagedCompanyInstallDir(root, "company-a"),
        "node_modules",
        "@acme",
        "shared"
      ),
      manifestJson: { id: "acme.shared", version: "1.0.0", capabilities: [] },
    });
    const loader = pluginLoader({} as any, { localPluginDir: root });
    await loader.upgradePlugin("plugin-a", { version: "2.0.0" });

    const installArgs = execNpm.mock.calls[0][0] as string[];
    expect(installArgs[installArgs.indexOf("--prefix") + 1]).toBe(
      resolveManagedCompanyInstallDir(root, "company-a")
    );
    expect(registry.update).toHaveBeenCalledWith(
      "plugin-a",
      expect.objectContaining({
        version: "2.0.0",
        packagePath: path.join(
          resolveManagedCompanyInstallDir(root, "company-a"),
          "node_modules",
          "@acme",
          "shared"
        ),
      })
    );
    expect(fs.existsSync(companyBPath)).toBe(true);
  });

  it("cleans one company prefix without deleting another tenant's package", async () => {
    const companyAPath = writeInstalledPackage(
      resolveManagedCompanyInstallDir(root, "company-a"),
      "1.0.0"
    );
    const companyBPath = writeInstalledPackage(
      resolveManagedCompanyInstallDir(root, "company-b"),
      "1.0.0"
    );
    const loader = pluginLoader({} as any, { localPluginDir: root });

    await loader.cleanupInstallArtifacts({
      id: "plugin-a",
      companyId: "company-a",
      pluginKey: "acme.shared",
      packageName: "@acme/shared",
      packagePath: companyAPath,
    } as any);

    expect(fs.existsSync(companyAPath)).toBe(false);
    expect(fs.existsSync(companyBPath)).toBe(true);
    const uninstallArgs = execNpm.mock.calls.at(-1)?.[0] as string[];
    expect(uninstallArgs[uninstallArgs.indexOf("--prefix") + 1]).toBe(
      resolveManagedCompanyInstallDir(root, "company-a")
    );
  });
});
