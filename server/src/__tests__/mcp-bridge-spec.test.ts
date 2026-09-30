import { describe, it, expect } from "vitest";
import {
  buildMcpBridgeSpec,
  buildMcpConfig,
} from "../services/internal-agent/cli-mode.js";

// ── MX1: provider-neutral buildMcpBridgeSpec seam ─────────────────────────────
//
// buildMcpBridgeSpec exposes the already-neutral inner MCP server spec
// ({command,args,env}) that buildMcpConfig wraps. This milestone is purely
// additive — buildMcpConfig's output must remain byte-identical (it becomes a
// thin claude {mcpServers:{aoa:spec}} wrapper over buildMcpBridgeSpec).

describe("buildMcpBridgeSpec", () => {
  const params = {
    companyId: "c",
    userId: "u",
    userRole: "founder",
    enabledCapabilities: ["discussion_processing"],
    bridgeEntrypoint: "/b.js",
    agentKind: "aoa",
    toolAllowlist: ["submit_extracted_items"],
  } as const;

  it("produces the neutral {command,args,env} inner spec", () => {
    // Mirror cli-mode.ts's exact conditional-omission for DATABASE_URL so the
    // assertion is robust to its presence/absence in the test environment.
    const expectedEnv: Record<string, string> = {
      // Routes the bridge's pino logger to stderr so a stray log can't corrupt
      // the JSON-RPC stdout stream (see middleware/logger.ts + the pino-leak fix).
      AOA_LOG_STDOUT: "0",
      AOA_SESSION_COMPANY_ID: "c",
      AOA_SESSION_USER_ID: "u",
      AOA_SESSION_USER_ROLE: "founder",
      AOA_SESSION_ENABLED_CAPABILITIES: "discussion_processing",
      AOA_AGENT_KIND: "aoa",
      AOA_TOOL_ALLOWLIST: "submit_extracted_items",
      ...(process.env.DATABASE_URL
        ? { DATABASE_URL: process.env.DATABASE_URL }
        : {}),
      // FU-23: the bridge's own secrets-provider config (non-secret values), so
      // it can decrypt the per-company embeddings key in-process once the
      // connector-capable CLI spawns are scrubbed of AoA's ambient env.
      ...(process.env.AOA_SECRETS_PROVIDER
        ? { AOA_SECRETS_PROVIDER: process.env.AOA_SECRETS_PROVIDER }
        : {}),
      ...(process.env.AOA_SECRETS_STRICT_MODE
        ? { AOA_SECRETS_STRICT_MODE: process.env.AOA_SECRETS_STRICT_MODE }
        : {}),
      ...(process.env.AOA_SECRETS_MASTER_KEY_FILE
        ? { AOA_SECRETS_MASTER_KEY_FILE: process.env.AOA_SECRETS_MASTER_KEY_FILE }
        : {}),
    };

    expect(buildMcpBridgeSpec(params)).toEqual({
      command: "node",
      args: ["/b.js"],
      env: expectedEnv,
    });
  });

  it("omits AOA_AGENT_KIND / AOA_TOOL_ALLOWLIST when not provided (matches cli-mode conditionals)", () => {
    const spec = buildMcpBridgeSpec({
      companyId: "c",
      userId: "u",
      userRole: "founder",
      enabledCapabilities: [],
      bridgeEntrypoint: "/b.js",
    });
    expect(spec.command).toBe("node");
    expect(spec.args).toEqual(["/b.js"]);
    expect(spec.env.AOA_SESSION_ENABLED_CAPABILITIES).toBe("");
    expect("AOA_AGENT_KIND" in spec.env).toBe(false);
    expect("AOA_TOOL_ALLOWLIST" in spec.env).toBe(false);
  });

  it("runs TypeScript bridge entrypoints through node + tsx cli instead of a shell shim", () => {
    const spec = buildMcpBridgeSpec({
      companyId: "c",
      userId: "u",
      userRole: "founder",
      enabledCapabilities: [],
      bridgeEntrypoint: "C:/repo/server/src/services/internal-agent/mcp-bridge.ts",
    });

    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toMatch(/tsx[\\/]+dist[\\/]+cli\.mjs$/);
    expect(spec.args[1]).toBe("C:/repo/server/src/services/internal-agent/mcp-bridge.ts");
  });

  it("buildMcpConfig is a thin {mcpServers:{aoa:spec}} wrapper over buildMcpBridgeSpec", () => {
    expect(buildMcpConfig(params)).toEqual({
      mcpServers: { aoa: buildMcpBridgeSpec(params) },
    });
  });

  it("pins the optional Playwright MCP package when browser_use is enabled", () => {
    const config = buildMcpConfig({
      ...params,
      enabledCapabilities: ["browser_use"],
    });

    expect(config.mcpServers.playwright?.command).toBe("npx");
    expect(config.mcpServers.playwright?.args[0]).toMatch(/^@playwright\/mcp@\d+\.\d+\.\d+/);
    expect(config.mcpServers.playwright?.args[0]).not.toContain("@latest");
  });
});
