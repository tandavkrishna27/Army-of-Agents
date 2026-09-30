// Plan 2b Task 6 — gemini external MCP connectors.
//
// gemini's native interpolation syntax IS `${VAR}` — the exact form the specs
// already carry — so unlike opencode (which must rewrite to `{env:VAR}`) and
// codex (which expands nothing), this writer emits placeholders VERBATIM.
// Verified live: a header of `Bearer ${AOA_PROBE_TOKEN}` reached the listener
// fully expanded (Plan 2b gate result / B2N9).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AOA_MCP_MANIFEST_FILENAME,
  readAoaManagedServerNames,
  resolveMcpManagedManifestPath,
  writeAoaManagedServerNames,
  type McpServerSpec,
} from "@armyofagents/adapter-utils";
import { writeGeminiMcpSettingsJson } from "../gemini-settings-json.js";

const BRIDGE_SPEC = {
  command: "node",
  args: ["/path/to/mcp-bridge.js"],
  env: { AOA_SESSION_COMPANY_ID: "co-1" },
};

const REAL_SECRET_VALUE = "REALSECRET";
const HTTP_CONNECTOR: McpServerSpec = {
  kind: "http",
  url: "https://mcp.notion.com/mcp",
  headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
  authTokenEnvVar: "AOA_MCP_NOTION_TOKEN",
};
const STDIO_CONNECTOR_WITH_SECRET: McpServerSpec = {
  kind: "stdio",
  command: "npx",
  args: ["-y", "srv", "--token", "${AOA_MCP_SLACK_TOKEN}"],
  env: { SLACK_TOKEN: "${AOA_MCP_SLACK_TOKEN}" },
};

let tmpDir: string;
let aoaHome: string;
let previousAoaHome: string | undefined;

/** Scope every write to one company/agent so the manifest path is stable. */
const SCOPE = { companyId: "company-1", agentId: "agent-1" };

function manifestPath(): string {
  return resolveMcpManagedManifestPath({ adapter: "gemini", cwd: tmpDir, ...SCOPE });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-gemini-conn-"));
  // The manifest lives under the AoA instance root (I2). Redirect it at a temp
  // home so tests never touch the developer's real ~/.aoa.
  aoaHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-home-"));
  previousAoaHome = process.env.AOA_HOME;
  process.env.AOA_HOME = aoaHome;
});

afterEach(async () => {
  if (previousAoaHome === undefined) delete process.env.AOA_HOME;
  else process.env.AOA_HOME = previousAoaHome;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(aoaHome, { recursive: true, force: true }).catch(() => {});
});

function settingsPath(): string {
  return path.join(tmpDir, ".gemini", "settings.json");
}
async function readRaw(): Promise<string> {
  return fs.readFile(settingsPath(), "utf8");
}
async function readConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readRaw());
}

describe("gemini external connectors — emitted shape", () => {
  it("emits an http connector as httpUrl + headers", async () => {
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });

    const written = await readConfig();
    expect(written.mcpServers.notion).toEqual({
      httpUrl: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
    });
    expect(written.mcpServers.aoa.command).toBe("node");
  });

  it("emits placeholders VERBATIM — no {env:...} rewrite (that is opencode's syntax)", async () => {
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR, slack: STDIO_CONNECTOR_WITH_SECRET },
    });

    const raw = await readRaw();
    expect(raw).toContain("${AOA_MCP_NOTION_TOKEN}");
    expect(raw).toContain("${AOA_MCP_SLACK_TOKEN}");
    // A rewrite here would break the one CLI whose syntax already matches.
    expect(raw).not.toContain("{env:");
  });

  it("emits a stdio connector as command + args + env", async () => {
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { slack: STDIO_CONNECTOR_WITH_SECRET },
    });
    expect((await readConfig()).mcpServers.slack).toEqual({
      command: "npx",
      args: ["-y", "srv", "--token", "${AOA_MCP_SLACK_TOKEN}"],
      env: { SLACK_TOKEN: "${AOA_MCP_SLACK_TOKEN}" },
    });
  });

  it("writes without a bridge (connectors-only run)", async () => {
    const result = await writeGeminiMcpSettingsJson(tmpDir, null, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    const written = await readConfig();
    expect(written.mcpServers.aoa).toBeUndefined();
    expect(written.mcpServers.notion.httpUrl).toBe("https://mcp.notion.com/mcp");
    expect(result.managedServerNames).toEqual(["notion"]);
  });

  it("is idempotent — same input, byte-identical output", async () => {
    const opts = {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR, slack: STDIO_CONNECTOR_WITH_SECRET },
    };
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, opts);
    const first = await readRaw();
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, opts);
    expect(await readRaw()).toBe(first);
  });
});

describe("gemini external connectors — D5: no live secret on disk", () => {
  it("a connector whose token is REALSECRET never puts REALSECRET in the file", async () => {
    const connectorEnv = { AOA_MCP_NOTION_TOKEN: REAL_SECRET_VALUE };

    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR, slack: STDIO_CONNECTOR_WITH_SECRET },
    });

    const raw = await readRaw();
    expect(raw).not.toContain(REAL_SECRET_VALUE);
    expect(raw).toContain("${AOA_MCP_NOTION_TOKEN}");
    expect(connectorEnv.AOA_MCP_NOTION_TOKEN).toBe(REAL_SECRET_VALUE);

    const manifest = await fs.readFile(manifestPath(), "utf8");
    expect(manifest).not.toContain(REAL_SECRET_VALUE);
  });
});

describe("gemini external connectors — reserved names + classified skips", () => {
  it("reserved names never displace AoA's own servers", async () => {
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        aoa: { kind: "http", url: "https://evil.example.com", headers: {} },
        playwright: { kind: "http", url: "https://evil2.example.com", headers: {} },
      },
    });
    const written = await readConfig();
    expect(written.mcpServers.aoa.command).toBe("node");
    expect(written.mcpServers.playwright).toBeUndefined();
  });

  it("honours a NON-DEFAULT bridge name as reserved too (M2)", async () => {
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      serverName: "aoa-crew",
      externalServers: {
        "aoa-crew": { kind: "http", url: "https://evil.example.com", headers: {} },
      },
    });
    expect((await readConfig()).mcpServers["aoa-crew"].command).toBe("node");
  });

  it("reports classified skips instead of dropping silently", async () => {
    const result = await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        aoa: { kind: "http", url: "https://evil.example.com", headers: {} },
        weird: { kind: "sse", url: "https://x" } as unknown as McpServerSpec,
        notion: HTTP_CONNECTOR,
      },
    });
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { serverName: "aoa", reason: "reserved_name" },
        { serverName: "weird", reason: "unsupported_transport" },
      ]),
    );
    expect(result.managedServerNames.sort()).toEqual(["aoa", "notion"]);
  });

  it("does NOT skip a stdio connector carrying a secret (that is codex-only)", async () => {
    const result = await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { slack: STDIO_CONNECTOR_WITH_SECRET },
    });
    expect(result.skipped).toEqual([]);
    expect(result.managedServerNames).toContain("slack");
  });
});

describe("gemini external connectors — B5 stale sweep", () => {
  it("removes a connector that is no longer active on the next run", async () => {
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    expect((await readConfig()).mcpServers.notion).toBeDefined();

    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });

    const written = await readConfig();
    expect(written.mcpServers.notion).toBeUndefined();
    expect(written.mcpServers.aoa).toBeDefined();
  });

  it("NEVER removes a server the user added by hand", async () => {
    await fs.mkdir(path.join(tmpDir, ".gemini"), { recursive: true });
    await fs.writeFile(
      settingsPath(),
      JSON.stringify({ theme: "dark", mcpServers: { mine: { command: "my-srv" } } }),
      "utf8",
    );
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });

    const written = await readConfig();
    expect(written.mcpServers.mine).toEqual({ command: "my-srv" });
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.notion).toBeUndefined();
  });

  it("adds no unknown key to settings.json — ownership lives in the sidecar", async () => {
    // gemini's tolerance of unknown settings keys could NOT be verified here
    // (it exits at an auth wall before config load is observable). The sidecar
    // means correctness never depended on that unverified assumption.
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    expect(Object.keys(await readConfig())).toEqual(["mcpServers"]);

    expect(await readAoaManagedServerNames(manifestPath())).toEqual(["aoa", "notion"]);
    // Nothing AoA-owned is left lying around in the workspace.
    expect(await fs.readdir(path.join(tmpDir, ".gemini"))).toEqual(["settings.json"]);
  });
});

describe("gemini external connectors — adversarial names", () => {
  it("a connector named __proto__ neither pollutes the prototype nor vanishes", async () => {
    const result = await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        ["__proto__"]: { kind: "http", url: "https://attacker.example.com", headers: {} },
      },
    });

    expect(({} as Record<string, unknown>).httpUrl).toBeUndefined();
    expect(({} as Record<string, unknown>).command).toBeUndefined();

    const written = await readConfig();
    expect(Object.prototype.hasOwnProperty.call(written.mcpServers, "__proto__")).toBe(true);
    expect(result.managedServerNames).toContain("__proto__");
    expect(written.mcpServers.aoa.command).toBe("node");
  });

  it("sweeps a previously-written __proto__ connector without disturbing the prototype", async () => {
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        ["__proto__"]: { kind: "http", url: "https://attacker.example.com", headers: {} },
      },
    });
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });

    const written = await readConfig();
    expect(Object.prototype.hasOwnProperty.call(written.mcpServers, "__proto__")).toBe(false);
    expect(written.mcpServers.aoa).toBeDefined();
    expect(({} as Record<string, unknown>).httpUrl).toBeUndefined();
  });
});

describe("gemini manifest — I1 crash window (manifest first, union)", () => {
  it("claims ownership BEFORE the config exists", async () => {
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    expect(await readAoaManagedServerNames(manifestPath())).toEqual(["aoa", "notion"]);
  });

  it("a crash between config and manifest still sweeps on the NEXT run", async () => {
    // With the old config-first ordering, run 2's `beta` was never recorded,
    // run 3 rewrote the manifest from its own set, and `beta` survived FOREVER.
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { alpha: HTTP_CONNECTOR },
    });

    // run 2 writes `beta` then "crashes" before narrowing: restore the union it
    // wrote FIRST.
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { beta: HTTP_CONNECTOR },
    });
    await writeAoaManagedServerNames(manifestPath(), ["alpha", "aoa", "beta"]);
    expect((await readConfig()).mcpServers.beta).toBeDefined();

    // run 3 — founder deleted every connector.
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });

    const written = await readConfig();
    expect(written.mcpServers.beta).toBeUndefined();
    expect(written.mcpServers.alpha).toBeUndefined();
    expect(written.mcpServers.aoa).toBeDefined();
  });

  it("narrows the claim to this run's set once the config is durable", async () => {
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });
    expect(await readAoaManagedServerNames(manifestPath())).toEqual(["aoa"]);
  });
});

describe("gemini manifest — I2 untrusted input", () => {
  it("a manifest PLANTED in the workspace cannot make the sweep eat user entries", async () => {
    await fs.mkdir(path.join(tmpDir, ".gemini"), { recursive: true });
    await fs.writeFile(
      settingsPath(),
      JSON.stringify({
        mcpServers: { mine: { command: "my-srv" }, other: { command: "other-srv" } },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, ".gemini", AOA_MCP_MANIFEST_FILENAME),
      JSON.stringify({ managedServerNames: ["mine", "other"] }),
      "utf8",
    );

    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });

    const written = await readConfig();
    expect(written.mcpServers.mine).toEqual({ command: "my-srv" });
    expect(written.mcpServers.other).toEqual({ command: "other-srv" });
    expect(written.mcpServers.aoa).toBeDefined();
  });

  it("deletes the stale in-workspace manifest an earlier build wrote", async () => {
    await fs.mkdir(path.join(tmpDir, ".gemini"), { recursive: true });
    const legacy = path.join(tmpDir, ".gemini", AOA_MCP_MANIFEST_FILENAME);
    await fs.writeFile(legacy, JSON.stringify({ managedServerNames: ["mine"] }), "utf8");
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });
    await expect(fs.access(legacy)).rejects.toThrow();
  });
});

describe("gemini — I3 secret with an EMPTY headerTemplate", () => {
  it("synthesizes a bearer header instead of emitting an unauthenticated connector", async () => {
    const result = await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        notion: {
          kind: "http",
          url: "https://mcp.notion.com/mcp",
          headers: {},
          authTokenEnvVar: "AOA_MCP_NOTION_TOKEN",
        },
      },
    });

    const written = await readConfig();
    expect(written.mcpServers.notion.headers).toEqual({
      Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}",
    });
    expect(result.skipped).toEqual([]);
    expect(await readRaw()).not.toContain(REAL_SECRET_VALUE);
  });

  it("does not double up when a header already references the token", async () => {
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        acme: {
          kind: "http",
          url: "https://acme.example.com/mcp",
          headers: { "X-Api-Key": "${AOA_MCP_ACME_TOKEN}" },
          authTokenEnvVar: "AOA_MCP_ACME_TOKEN",
        },
      },
    });
    const written = await readConfig();
    expect(written.mcpServers.acme.headers).toEqual({
      "X-Api-Key": "${AOA_MCP_ACME_TOKEN}",
    });
  });

  it("adds no auth header for a connector that genuinely has no secret", async () => {
    await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        public_docs: { kind: "http", url: "https://docs.example.com/mcp", headers: {} },
      },
    });
    expect((await readConfig()).mcpServers.public_docs.headers).toEqual({});
  });
});
