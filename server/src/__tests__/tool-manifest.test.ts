import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createToolRegistry } from "../services/internal-agent/tool-registry.js";
import {
  buildToolManifest,
  serializeToolManifest,
  renderCommanderToolsMd,
} from "../services/internal-agent/tool-manifest.js";

describe("tool manifest — contract vs live registry", () => {
  const manifest = buildToolManifest();
  const commander = manifest.filter((t) => t.surface === "commander");
  const mcp = manifest.filter((t) => t.surface === "mcp");

  it("has one commander entry per registry tool (count + names)", () => {
    const registry = createToolRegistry();
    expect(commander.length).toBe(registry.length);
    expect(commander.map((t) => t.name).sort()).toEqual(
      registry.map((t) => t.name).sort(),
    );
  });

  it("never emits the create_memory phantom and always emits suggest_memory", () => {
    const names = new Set(manifest.map((t) => t.name));
    expect(names.has("create_memory")).toBe(false);
    expect(names.has("suggest_memory")).toBe(true);
  });

  it("emits at least one mcp entry and marks memory.write as a write tool", () => {
    expect(mcp.length).toBeGreaterThan(0);
    const memWrite = mcp.find((t) => t.name === "memory.write");
    expect(memWrite?.readWrite).toBe("write");
  });

  it("every entry has the agreed shape", () => {
    for (const t of manifest) {
      expect(t).toMatchObject({
        name: expect.any(String),
        surface: expect.stringMatching(/^(commander|mcp)$/),
        category: expect.any(String),
        readWrite: expect.stringMatching(/^(read|write)$/),
        description: expect.any(String),
      });
      expect(["founder", "team_lead", "team_member", null]).toContain(t.requiredRole);
      expect(typeof t.mcpAlias === "string" || t.mcpAlias === null).toBe(true);
    }
  });
});

describe("tool manifest — committed artifact is fresh", () => {
  it("packages/shared/src/generated/tools.json equals the freshly-built manifest", () => {
    const committed = readFileSync(
      resolve(__dirname, "../../../packages/shared/src/generated/tools.json"),
      "utf8",
    );
    expect(committed).toBe(serializeToolManifest(buildToolManifest()));
  });
});

describe("TOOLS.md — generated commander cheat-sheet is fresh", () => {
  it("onboarding-assets/commander/TOOLS.md equals the rendered output", () => {
    const committed = readFileSync(
      resolve(__dirname, "../onboarding-assets/commander/TOOLS.md"),
      "utf8",
    );
    expect(committed).toBe(renderCommanderToolsMd(buildToolManifest()));
  });

  it("rendered TOOLS.md contains suggest_memory and never create_memory", () => {
    const md = renderCommanderToolsMd(buildToolManifest());
    expect(md).toContain("`suggest_memory`");
    expect(md).not.toContain("create_memory");
  });
});
