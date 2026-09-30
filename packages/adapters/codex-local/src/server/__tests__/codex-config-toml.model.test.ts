import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeCodexModelConfigToml,
  writeCodexMcpConfigToml,
} from "../codex-config-toml.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-model-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function readToml(): Promise<string> {
  return fs.readFile(path.join(home, "config.toml"), "utf8");
}

describe("writeCodexModelConfigToml", () => {
  it("writes a top-level model line into a fresh config.toml", async () => {
    await writeCodexModelConfigToml(home, "gpt-5.5");
    expect(await readToml()).toContain('model = "gpt-5.5"');
  });

  it("is idempotent — a second write does not duplicate the model line", async () => {
    await writeCodexModelConfigToml(home, "gpt-5.5");
    await writeCodexModelConfigToml(home, "gpt-5.5");
    const toml = await readToml();
    expect(toml.match(/^model = /gm)?.length ?? 0).toBe(1);
  });

  it("rewrites the model line to a new value without stacking", async () => {
    await writeCodexModelConfigToml(home, "gpt-5.5");
    await writeCodexModelConfigToml(home, "gpt-4o");
    const toml = await readToml();
    expect(toml.match(/^model = /gm)?.length ?? 0).toBe(1);
    expect(toml).toContain('model = "gpt-4o"');
    expect(toml).not.toContain('model = "gpt-5.5"');
  });

  it("preserves an existing [mcp_servers.aoa] block written by the MCP writer", async () => {
    await writeCodexMcpConfigToml(home, {
      command: "node",
      args: ["/tmp/bridge.js"],
      env: { AOA_API_KEY: "k" },
    });
    await writeCodexModelConfigToml(home, "gpt-5.5");
    const toml = await readToml();
    expect(toml).toContain("[mcp_servers.aoa]");
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('model = "gpt-5.5"');
  });

  it("escapes a double quote in the model value (defensive)", async () => {
    await writeCodexModelConfigToml(home, 'gp"t');
    expect(await readToml()).toContain('model = "gp\\"t"');
  });

  it("serializes concurrent MCP + model writes without losing either section", async () => {
    // The managed home is per-COMPANY, so two concurrent runs (Decision #5 allows
    // up to 50) race on <home>/config.toml. Both writers read-strip-rewrite; the
    // per-home lock must serialize them so neither section is lost. Fire both at
    // once and assert BOTH the [mcp_servers.aoa] block AND the model line survive.
    await Promise.all([
      writeCodexMcpConfigToml(home, {
        command: "node",
        args: ["/tmp/bridge.js"],
        env: { AOA_API_KEY: "k" },
      }),
      writeCodexModelConfigToml(home, "gpt-5.5"),
    ]);
    const toml = await readToml();
    expect(toml).toContain("[mcp_servers.aoa]");
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('model = "gpt-5.5"');
    // Exactly one of each — no duplicated/torn sections.
    expect(toml.match(/^model = /gm)?.length ?? 0).toBe(1);
    expect(toml.match(/\[mcp_servers\.aoa\]/g)?.length ?? 0).toBe(1);
  });
});
