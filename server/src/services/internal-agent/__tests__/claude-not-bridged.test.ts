/**
 * Guard test: claude_local NEVER consumes the MCP stdio bridge.
 *
 * The blast-radius boundary for the MCP bridge fix (fix/codex-mcp-bridge):
 *   - codex / opencode / gemini: consume ctx.mcpBridge (bridge delivery)
 *   - claude_local: uses native `--mcp-config <file>` delivery via config.args
 *
 * If someone removes the isClaudeFamily gate or wires claude through the bridge,
 * these tests fail immediately — catching it before any run-time regression.
 *
 * Source-level assertions only (fs.readFileSync). No imports of drizzle or server
 * modules. Fast and dependency-free.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("claude_local never consumes the MCP stdio bridge", () => {
  it("the claude adapter execute source contains no mcpBridge reference", () => {
    // packages/adapters/claude-local/src/server/execute.ts
    // Path from __tests__: up 5 dirs to worktree root, then into packages/
    const claudeExecPath = resolve(
      here,
      "../../../../../packages/adapters/claude-local/src/server/execute.ts",
    );
    const src = readFileSync(claudeExecPath, "utf8");
    // Sanity: we actually read the real file (it must define the execute fn)
    expect(src).toContain("export async function execute(");
    // Guard: no stdio bridge reference — claude uses --mcp-config native delivery
    expect(src).not.toContain("mcpBridge");
  });

  it("the runner gates --mcp-config delivery on isClaudeFamily (claude uses native flag; codex/opencode/gemini do not)", () => {
    const runnerPath = resolve(here, "../aoa-agents/runner.ts");
    const src = readFileSync(runnerPath, "utf8");

    // The gate variable must exist
    expect(src).toContain('const isClaudeFamily = agent.adapterType === "claude_local"');

    // --mcp-config is injected ONLY in the claude (truthy) branch of the ternary
    // Real expression from runner.ts line 361-363:
    //   const config = isClaudeFamily
    //     ? { ...baseConfig, promptTemplate: triggerPrompt, args: ["--mcp-config", cfgPath, ...prevArgs] }
    //     : { ...baseConfig, promptTemplate: triggerPrompt };
    expect(src).toMatch(/isClaudeFamily\s*\n\s*\?\s*\{[^}]*"--mcp-config"/);

    // The mcpAttempted flag explicitly records that claude does NOT use the bridge
    // Real expression from runner.ts line 485:
    //   mcpAttempted: !isClaudeFamily,  // codex/opencode/gemini use the bridge; claude does not
    expect(src).toContain("mcpAttempted: !isClaudeFamily");
  });
});
