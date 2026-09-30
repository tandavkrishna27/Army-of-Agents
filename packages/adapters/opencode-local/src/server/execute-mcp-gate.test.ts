// Plan 2b Task 6 (D) — the C2 presence gate at execute() level.
//
// The gate must test PRESENCE, not truthiness. `mcpServers: {}` means "every
// connector was deleted or disabled" and MUST still reach the writer, because
// the writer's sweep is what removes the entries a previous run wrote. Gating
// on non-emptiness (or on `ctx.mcpBridge` alone) leaves a revoked connector in
// opencode.json forever and the agent keeps the tool.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServerSpec } from "@armyofagents/adapter-utils";
import { execute } from "./execute.js";
import { resetOpenCodeModelsCacheForTests } from "./models.js";

async function writeFakeOpenCodeCommand(commandPath: string): Promise<string> {
  const script = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "models") {
  console.log("test/provider");
  process.exit(0);
}
console.log(JSON.stringify({
  type: "step_finish",
  sessionID: "s1",
  part: { reason: "done", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
}));
`;
  await fs.writeFile(commandPath + ".js", script, "utf8");
  await fs.chmod(commandPath + ".js", 0o755);
  if (process.platform === "win32") {
    const cmdPath = commandPath + ".cmd";
    await fs.writeFile(cmdPath, `@node "%~dp0agent.js" %*\r\n`, "utf8");
    return cmdPath;
  }
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

const BRIDGE = {
  command: "node",
  args: ["/path/to/mcp-bridge.js"],
  env: { AOA_SESSION_COMPANY_ID: "company-1" },
};

const NOTION: McpServerSpec = {
  kind: "http",
  url: "https://mcp.notion.com/mcp",
  headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
  authTokenEnvVar: "AOA_MCP_NOTION_TOKEN",
};

interface RunOpts {
  mcpBridge?: typeof BRIDGE;
  mcpServers?: Record<string, McpServerSpec>;
  workspace: string;
  commandPath: string;
}

async function runOnce(opts: RunOpts): Promise<string[]> {
  resetOpenCodeModelsCacheForTests();
  const logs: string[] = [];
  const result = await execute({
    runId: "run-opencode-mcp-gate",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenCode Coder",
      adapterType: "opencode_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command: opts.commandPath,
      cwd: opts.workspace,
      model: "test/provider",
      env: {},
      promptTemplate: "Prompt.",
      timeoutSec: 10,
      graceSec: 1,
    },
    context: {},
    executionTarget: { type: "local" },
    runtimeCommandSpec: { command: "opencode", installCommand: "do-not-run" },
    ...(opts.mcpBridge !== undefined ? { mcpBridge: opts.mcpBridge } : {}),
    ...(opts.mcpServers !== undefined ? { mcpServers: opts.mcpServers } : {}),
    authToken: "secret-run-token",
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
  });
  expect(result.exitCode).toBe(0);
  return logs;
}

async function setup(): Promise<{ root: string; workspace: string; commandPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-opencode-mcp-gate-"));
  // The ownership manifest lives under the AoA instance root (I2). Point it at
  // the throwaway root so tests never write into the developer's real ~/.aoa.
  process.env.AOA_HOME = path.join(root, "aoa-home");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const commandPath = await writeFakeOpenCodeCommand(path.join(root, "agent"));
  return { root, workspace, commandPath };
}

const PREVIOUS_AOA_HOME = process.env.AOA_HOME;
afterEach(() => {
  if (PREVIOUS_AOA_HOME === undefined) delete process.env.AOA_HOME;
  else process.env.AOA_HOME = PREVIOUS_AOA_HOME;
});

describe("opencode execute — C2 MCP presence gate", () => {
  it("writes opencode.json when ONLY ctx.mcpServers is present (no bridge)", async () => {
    const { root, workspace, commandPath } = await setup();
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await runOnce({ workspace, commandPath, mcpServers: { notion: NOTION } });

      const written = JSON.parse(
        await fs.readFile(path.join(workspace, "opencode.json"), "utf8"),
      ) as Record<string, any>;
      expect(written.mcp.notion.type).toBe("remote");
      expect(written.mcp.notion.headers.Authorization).toBe(
        "Bearer {env:AOA_MCP_NOTION_TOKEN}",
      );
      expect(written.mcp.aoa).toBeUndefined();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("an EMPTY mcpServers map still reaches the writer and sweeps a stale connector", async () => {
    const { root, workspace, commandPath } = await setup();
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await runOnce({ workspace, commandPath, mcpBridge: BRIDGE, mcpServers: { notion: NOTION } });
      let written = JSON.parse(
        await fs.readFile(path.join(workspace, "opencode.json"), "utf8"),
      ) as Record<string, any>;
      expect(written.mcp.notion).toBeDefined();

      // Founder deletes the connector — emptiness is NOT absence.
      await runOnce({ workspace, commandPath, mcpBridge: BRIDGE, mcpServers: {} });

      written = JSON.parse(
        await fs.readFile(path.join(workspace, "opencode.json"), "utf8"),
      ) as Record<string, any>;
      expect(written.mcp.notion).toBeUndefined();
      expect(written.mcp.aoa).toBeDefined();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("does not write opencode.json when NEITHER field is present", async () => {
    const { root, workspace, commandPath } = await setup();
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await runOnce({ workspace, commandPath });
      await expect(fs.access(path.join(workspace, "opencode.json"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("surfaces a classified connector skip on the run log", async () => {
    const { root, workspace, commandPath } = await setup();
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const logs = await runOnce({
        workspace,
        commandPath,
        mcpBridge: BRIDGE,
        mcpServers: { aoa: NOTION },
      });
      expect(logs.join("")).toContain(
        '[aoa] opencode MCP connector "aoa" skipped: reserved_name',
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
