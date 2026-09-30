import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldPluginProject } from "./index.js";

const generated: string[] = [];

afterEach(() => {
  for (const dir of generated.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AoA plugin scaffold", () => {
  it("generates and loads the canonical manifest and SDK contract", async () => {
    const parent = mkdtempSync(path.join(process.cwd(), "aoa-plugin-scaffold-"));
    generated.push(parent);
    const output = scaffoldPluginProject({
      pluginName: "@acme/example",
      outputDir: path.join(parent, "example"),
    });
    const pkg = JSON.parse(readFileSync(path.join(output, "package.json"), "utf8"));
    const manifest = readFileSync(path.join(output, "src", "manifest.ts"), "utf8");

    expect(pkg.aoaPlugin.manifest).toBe("./dist/manifest.js");
    expect(pkg.scripts["dev:ui"]).toContain("aoa-plugin-dev-server");
    expect(manifest).toContain("AoAPluginManifestV1");
    expect(manifest).toContain('id: "acme.example"');
    const compiled = ts.transpileModule(manifest, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    }).outputText;
    const loaded = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
    expect(loaded.default.id).toBe("acme.example");
  });
});
