// server/src/__tests__/task-run-sandbox-invocation.test.ts — CLI-008 Unit C, slice 1.
//
// Proves the sandbox-side plumbing that lets a distributed claude run reach mcp__aoa__*:
// (1) the pure brokeredAoaHttpEntry emits the brokered http entry carrying the ${AOA_API_KEY}
//     PLACEHOLDER (never a token — the CLI expands it from env);
// (2) buildSandboxInvocation, for claude_local ONLY and ONLY when a config is supplied, stages
//     that config as a JSON file and adds --mcp-config/--strict-mcp-config/--allowedTools mcp__aoa
//     to the argv — and is BYTE-IDENTICAL to the pre-Unit-C output when no config is supplied.
// The config-present-vs-absent differential is the anti-vacuity control; the off path is also
// guarded by the existing task-run-batch-workload argv/staged tests.
import { describe, expect, it } from "vitest";

import {
  buildSandboxInvocation,
  STAGED_AOA_MCP_CONFIG_PATH,
  STAGED_PROMPT_PATH,
} from "../services/task-run-sandbox-invocation.js";
import { brokeredAoaHttpEntry } from "@armyofagents/adapter-utils";

const CONFIG = JSON.stringify({
  mcpServers: { aoa: brokeredAoaHttpEntry({ apiBaseUrl: "https://api.example.test", companyId: "co-1" }) },
});
// args = ["-c", <script>, <binary>, ...paths]; the script is index 1.
const scriptOf = (inv: { args: readonly string[] }) => inv.args[1];

describe("brokeredAoaHttpEntry — CLI-008 Unit C brokered aoa MCP entry", () => {
  it("emits the http entry with the ${AOA_API_KEY} placeholder header — never a real token", () => {
    expect(brokeredAoaHttpEntry({ apiBaseUrl: "https://api.example.test", companyId: "co-1" })).toEqual({
      type: "http",
      url: "https://api.example.test/companies/co-1/mcp",
      headers: { Authorization: "Bearer ${AOA_API_KEY}" },
    });
  });
});

describe("buildSandboxInvocation — Unit C aoa MCP config staging", () => {
  it("claude_local + config, no instructions: stages the JSON config at $2 and adds the mcp flags", () => {
    const inv = buildSandboxInvocation({
      adapterType: "claude_local",
      binary: "claude",
      prompt: "do the task",
      instructions: null,
      aoaMcpConfig: CONFIG,
    })!;
    const cfg = inv.stagedFiles.find((f) => f.path === STAGED_AOA_MCP_CONFIG_PATH);
    expect(cfg).toBeDefined();
    expect(new TextDecoder().decode(cfg!.bytes)).toBe(CONFIG);
    expect(cfg!.contentType).toContain("application/json");
    const script = scriptOf(inv);
    expect(script).toContain('--mcp-config "$2"'); // prompt=$1, config=$2 (no instructions)
    expect(script).toContain("--strict-mcp-config");
    expect(script).toContain("--allowedTools mcp__aoa");
    expect(inv.args).toContain(STAGED_AOA_MCP_CONFIG_PATH);
  });

  it("claude_local + config + instructions: instructions stay $2, config becomes $3", () => {
    const inv = buildSandboxInvocation({
      adapterType: "claude_local",
      binary: "claude",
      prompt: "p",
      instructions: "standing bundle",
      aoaMcpConfig: CONFIG,
    })!;
    const script = scriptOf(inv);
    expect(script).toContain('--append-system-prompt-file "$2"');
    expect(script).toContain('--mcp-config "$3"');
    expect(script).toContain("--strict-mcp-config");
  });

  it("codex_local: NEVER stages the config or adds the flag, even when a config is supplied (MX3 deferred)", () => {
    const inv = buildSandboxInvocation({
      adapterType: "codex_local",
      binary: "codex",
      prompt: "p",
      instructions: null,
      aoaMcpConfig: CONFIG,
    })!;
    expect(inv.stagedFiles.find((f) => f.path === STAGED_AOA_MCP_CONFIG_PATH)).toBeUndefined();
    expect(scriptOf(inv)).not.toContain("--mcp-config");
  });

  it("byte-identical when no config is supplied: aoaMcpConfig null equals aoaMcpConfig omitted, no mcp flag, prompt-only staging", () => {
    const withNull = buildSandboxInvocation({
      adapterType: "claude_local",
      binary: "claude",
      prompt: "p",
      instructions: null,
      aoaMcpConfig: null,
    })!;
    const omitted = buildSandboxInvocation({
      adapterType: "claude_local",
      binary: "claude",
      prompt: "p",
      instructions: null,
    })!;
    expect(withNull).toEqual(omitted); // an unset optional never stages the config
    expect(withNull.stagedFiles.find((f) => f.path === STAGED_AOA_MCP_CONFIG_PATH)).toBeUndefined();
    expect(withNull.stagedFiles.map((f) => f.path)).toEqual([STAGED_PROMPT_PATH]);
    expect(scriptOf(withNull)).not.toContain("--mcp-config");
  });
});
