/**
 * FU-23 (opencode_local) — the OUTLIER. For local targets opencode composes its
 * spawn env as `{ ...process.env, ...env }` and passes THAT as the spawn overlay,
 * so `unsetEnvKeys` alone cannot remove AoA's ambient secrets (mergeChildEnv
 * exempts overlay-set keys). execute.ts therefore ALSO strips them from the
 * overlay it passes. This fake opencode dumps the env it received.
 *
 * ABLATION: drop either the overlay strip (`spawnEnv`) or the `unsetEnvKeys` on
 * the spawn in execute.ts → the "secret absent" assertions go RED.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServerSpec } from "@armyofagents/adapter-utils";
import { execute } from "./execute.js";
import { resetOpenCodeModelsCacheForTests } from "./models.js";

const AMBIENT_SECRETS: Record<string, string> = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/aoa",
  REDIS_URL: "redis://localhost:6379",
  OPENAI_API_KEY: "sk-embeddings-should-not-leak",
  GITHUB_PAT: "ghp_should_not_leak",
  BETTER_AUTH_SECRET: "auth-signing-should-not-leak",
  AOA_SECRETS_MASTER_KEY: "raw-master-key-should-not-leak",
};

const NOTION: McpServerSpec = {
  kind: "http",
  url: "https://mcp.notion.com/mcp",
  headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
  authTokenEnvVar: "AOA_MCP_NOTION_TOKEN",
};
const BRIDGE = {
  command: "node",
  args: ["/path/to/mcp-bridge.js"],
  env: { AOA_SESSION_COMPANY_ID: "company-1", DATABASE_URL: AMBIENT_SECRETS.DATABASE_URL },
};

// A STDIO connector — the ONLY transport that spawns a local child inheriting
// the CLI env, so the ONLY one that triggers env isolation (F4).
const PG_STDIO: McpServerSpec = {
  kind: "stdio",
  command: "npx",
  args: ["-y", "dbhub@1.0.0"],
  env: {},
};

async function writeFakeOpenCodeCommand(commandBase: string): Promise<string> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "models") { console.log("test/provider"); process.exit(0); }
const capturePath = process.env.AOA_TEST_CAPTURE_PATH;
if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(Object.assign({}, process.env)), "utf8");
console.log(JSON.stringify({ type: "step_finish", sessionID: "s1", part: { reason: "done", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }));
`;
  await fs.writeFile(commandBase + ".js", script, "utf8");
  await fs.chmod(commandBase + ".js", 0o755).catch(() => {});
  if (process.platform === "win32") {
    const cmdPath = commandBase + ".cmd";
    await fs.writeFile(cmdPath, `@node "${commandBase}.js" %*\r\n`, "utf8");
    return cmdPath;
  }
  await fs.writeFile(commandBase, script, "utf8");
  await fs.chmod(commandBase, 0o755);
  return commandBase;
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(AMBIENT_SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const k of Object.keys(AMBIENT_SECRETS)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function runOnce(connectors: "none" | "stdio" | "http"): Promise<Record<string, string>> {
  resetOpenCodeModelsCacheForTests();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-opencode-fu23-"));
  const workspace = path.join(root, "workspace");
  const capturePath = path.join(root, "capture.json");
  await fs.mkdir(workspace, { recursive: true });
  const commandPath = await writeFakeOpenCodeCommand(path.join(root, "agent"));
  const mcpFields =
    connectors === "none"
      ? {}
      : {
          mcpBridge: BRIDGE,
          mcpServers: (connectors === "stdio"
            ? { pg: PG_STDIO }
            : { notion: NOTION }) as Record<string, McpServerSpec>,
        };
  try {
    const result = await execute({
      runId: "run-opencode-fu23",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath,
        cwd: workspace,
        model: "test/provider",
        env: { AOA_TEST_CAPTURE_PATH: capturePath, AOA_MCP_NOTION_TOKEN: "connector-token" },
        promptTemplate: "Prompt.",
        timeoutSec: 15,
        graceSec: 1,
      },
      context: {},
      executionTarget: { type: "local" as const },
      runtimeCommandSpec: { command: "opencode", installCommand: "do-not-run" },
      ...mcpFields,
      authToken: "secret-run-token",
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

describe("opencode_local FU-23 env scrub", () => {
  it("STDIO connector present → AoA ambient secrets absent, run bearer stripped, connector token + PATH survive", async () => {
    const env = await runOnce("stdio");
    for (const key of Object.keys(AMBIENT_SECRETS)) {
      expect(env[key], `${key} must not leak to a connector child`).toBeUndefined();
    }
    expect(env.AOA_MCP_NOTION_TOKEN).toBe("connector-token");
    expect(env.PATH ?? env.Path).toBeTruthy();
    // WS1 — the run-scoped API bearer must NOT reach a stdio connector child.
    // ABLATION: delete stripConnectorRunBearers(...) in execute.ts → RED.
    expect(env.AOA_API_KEY, "run token must not leak to a connector child").toBeUndefined();
  });

  it("no connectors → env is unscrubbed (byte-identical: ambient secrets present)", async () => {
    const env = await runOnce("none");
    expect(env.DATABASE_URL).toBe(AMBIENT_SECRETS.DATABASE_URL);
    expect(env.OPENAI_API_KEY).toBe(AMBIENT_SECRETS.OPENAI_API_KEY);
    expect(env.AOA_MCP_NOTION_TOKEN).toBe("connector-token");
    // WS1 byte-identity foil: the run token is present when no connectors.
    expect(env.AOA_API_KEY).toBe("secret-run-token");
  });

  it("HTTP-ONLY connector → byte-identical, bearer KEPT (F4: remote connectors spawn no child)", async () => {
    // Enabling an HTTP connector must NOT strip the agent's own bearer — otherwise
    // authenticated-deployment REST (curl with AOA_API_KEY) 401s for no isolation
    // benefit, since an HTTP connector inherits nothing. ABLATION: gate the strip
    // on connector-presence again → AOA_API_KEY becomes undefined → RED.
    const env = await runOnce("http");
    expect(env.DATABASE_URL).toBe(AMBIENT_SECRETS.DATABASE_URL);
    expect(env.OPENAI_API_KEY).toBe(AMBIENT_SECRETS.OPENAI_API_KEY);
    expect(env.AOA_API_KEY).toBe("secret-run-token");
    expect(env.AOA_MCP_NOTION_TOKEN).toBe("connector-token");
  });
});
