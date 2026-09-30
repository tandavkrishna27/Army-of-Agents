/**
 * mcp-config-broker-seam.test.ts
 *
 * U2d — plumbs a `brokered` flag through `buildMcpConfig` so an E2B-sandboxed
 * run's CLI reaches the control-plane DB ONLY via the HTTP broker (U2c),
 * never via the stdio bridge (which injects `DATABASE_URL` into the
 * subprocess env — a secret that must never enter the VM).
 *
 * When `brokered: true`, the reserved `aoa` MCP server entry must be an HTTP
 * entry pointing at `${apiBaseUrl}/companies/${companyId}/mcp`, carrying a
 * `${AOA_API_KEY}` bearer placeholder (the real run-JWT rides the spawn env,
 * never this file — mirrors the `${AOA_MCP_*_TOKEN}` convention
 * `mergeExternalMcpServers`/`withSynthesizedBearerHeader` already use for
 * external connectors), and — the security invariant — the generated config
 * must contain NO `DATABASE_URL` anywhere.
 *
 * When `brokered` is falsy (including unset — the default), `buildMcpConfig`
 * must keep emitting the existing stdio `buildMcpBridgeSpec` bridge
 * byte-identically. This wave only PLUMBS the flag; nothing sets it yet.
 *
 * Pure — no DB, no fs/child_process mocking needed (buildMcpConfig never
 * touches disk or spawns; only buildMcpBridgeSpec's dev-mode tsx resolution
 * path — gated on a `.ts` bridgeEntrypoint — hits node:fs, so tests use a
 * `.js` entrypoint like the existing buildMcpConfig suite in cli-mode.test.ts
 * does).
 */

import { describe, it, expect } from "vitest";
import type { McpConfigParams } from "../services/internal-agent/cli-mode.js";
import {
  buildMcpConfig,
  buildCodexAoaMcpSpec,
  buildMcpBridgeSpec,
} from "../services/internal-agent/cli-mode.js";

function baseParams(): McpConfigParams {
  return {
    companyId: "co-1",
    userId: "user1",
    userRole: "founder",
    enabledCapabilities: [],
    bridgeEntrypoint: "/app/dist/mcp-bridge.js",
  };
}

describe("buildMcpConfig — broker seam (U2d)", () => {
  it("brokered:true emits an HTTP aoa entry at the broker URL with a bearer placeholder, and NO DATABASE_URL anywhere", () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://should-not-leak:5432/db";
    try {
      const brokered = buildMcpConfig({
        ...baseParams(),
        brokered: true,
        apiBaseUrl: "https://cp.example",
        companyId: "co-1",
      });

      const aoa = brokered.mcpServers.aoa;
      expect(aoa.type).toBe("http");
      expect(aoa.url).toBe("https://cp.example/companies/co-1/mcp");
      expect(aoa.headers).toBeDefined();
      expect(aoa.headers!.Authorization).toBe("Bearer ${AOA_API_KEY}");

      // CRITICAL security invariant: DATABASE_URL must never appear in a
      // brokered config — it would ride into the E2B sandbox otherwise.
      expect(aoa.command).toBeUndefined();
      expect(aoa.args).toBeUndefined();
      expect(aoa.env).toBeUndefined();
      expect(JSON.stringify(brokered)).not.toContain("DATABASE_URL");
    } finally {
      process.env.DATABASE_URL = original;
    }
  });

  it("brokered:false (explicit) keeps the stdio buildMcpBridgeSpec bridge", () => {
    const local = buildMcpConfig({ ...baseParams(), brokered: false });
    expect(local.mcpServers.aoa.command).toBe("node");
    expect(local.mcpServers.aoa.args).toContain("/app/dist/mcp-bridge.js");
    expect(local.mcpServers.aoa.type).toBeUndefined();
    expect(local.mcpServers.aoa.url).toBeUndefined();
  });

  it("brokered unset (default) is byte-identical to the pre-existing stdio config", () => {
    const params = baseParams();
    const withoutFlag = buildMcpConfig(params);
    const withExplicitFalse = buildMcpConfig({ ...params, brokered: false });
    expect(withoutFlag).toEqual(withExplicitFalse);
    expect(withoutFlag.mcpServers.aoa.command).toBe("node");
    expect(withoutFlag.mcpServers.aoa.type).toBeUndefined();
  });

  it("desktop (non-brokered) config is unaffected by apiBaseUrl being present but brokered unset", () => {
    // apiBaseUrl alone (no brokered:true) must never flip the transport —
    // only the explicit brokered flag does, per the plan's call-site scope
    // guard (nothing sets brokered this wave; defaults to false).
    const config = buildMcpConfig({ ...baseParams(), apiBaseUrl: "https://cp.example" });
    expect(config.mcpServers.aoa.command).toBe("node");
    expect(config.mcpServers.aoa.type).toBeUndefined();
  });
});

/**
 * U2d-bridge — the deferred codex half. codex has no `--mcp-config` flag (it
 * reads `$CODEX_HOME/config.toml`), so the reserved `aoa` server for codex
 * travels through `buildCodexAoaMcpSpec` + `writeCodexMcpConfigToml`, not
 * `buildMcpConfig`. Pure — same no-fs guarantee as buildMcpConfig itself
 * (buildMcpBridgeSpec's dev-mode tsx resolution only triggers for a `.ts`
 * bridgeEntrypoint, so baseParams() uses a `.js` one, matching the sibling
 * suite above).
 */
describe("buildCodexAoaMcpSpec — codex broker seam (U2d-bridge)", () => {
  it("brokered:true returns an McpHttpServerSpec at the broker URL with authTokenEnvVar=AOA_API_KEY, no DATABASE_URL anywhere", () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://should-not-leak:5432/db";
    try {
      const spec = buildCodexAoaMcpSpec({
        ...baseParams(),
        brokered: true,
        apiBaseUrl: "https://cp.example",
        companyId: "co-1",
      });

      expect(spec).toEqual({
        kind: "http",
        url: "https://cp.example/companies/co-1/mcp",
        headers: {},
        authTokenEnvVar: "AOA_API_KEY",
      });
      expect(JSON.stringify(spec)).not.toContain("DATABASE_URL");
      expect(JSON.stringify(spec)).not.toContain("postgres://");
    } finally {
      process.env.DATABASE_URL = original;
    }
  });

  it("brokered:false (explicit) returns the exact same stdio spec as buildMcpBridgeSpec", () => {
    const params: McpConfigParams = { ...baseParams(), brokered: false };
    expect(buildCodexAoaMcpSpec(params)).toEqual(buildMcpBridgeSpec(params));
  });

  it("brokered unset (default) is byte-identical to the pre-existing stdio spec", () => {
    const params = baseParams();
    const withoutFlag = buildCodexAoaMcpSpec(params);
    const withExplicitFalse = buildCodexAoaMcpSpec({ ...params, brokered: false });
    expect(withoutFlag).toEqual(withExplicitFalse);
    expect(withoutFlag).toEqual(buildMcpBridgeSpec(params));
    expect((withoutFlag as { kind?: string }).kind).toBeUndefined();
  });

  it("desktop (non-brokered) spec is unaffected by apiBaseUrl being present but brokered unset", () => {
    const spec = buildCodexAoaMcpSpec({ ...baseParams(), apiBaseUrl: "https://cp.example" });
    expect((spec as { command?: string }).command).toBe("node");
    expect((spec as { kind?: string }).kind).toBeUndefined();
  });
});
