/**
 * FU-23 (codex_local, exec path) — codex already strips the ambient
 * OPENAI_API_KEY on EVERY run (billing safety). When THIS run also hosts a STDIO
 * MCP connector, the strip broadens to ALL of AoA's ambient secrets and the run
 * bearer, so a stdio connector child codex spawns cannot inherit them. A fake
 * codex dumps the env it received.
 *
 * codex scrubs its own env before spawning MCP children, so the `aoa` bridge
 * gets its env from `[mcp_servers.aoa.env]` in the managed config.toml — the CLI
 * env scrub here does not touch it.
 *
 * F4 — http connectors inherit nothing; env isolation is stdio-only. An HTTP
 * connector is remote and spawns NO local child that inherits the CLI env, so an
 * http-only run must stay byte-identical to a no-connector run: ambient secrets
 * and the agent's own AOA_API_KEY MUST survive (otherwise merely enabling an http
 * connector 401s the agent's REST calls in authenticated mode). NOTE the
 * always-on codex OPENAI_API_KEY billing strip is orthogonal — it fires on every
 * run regardless of connectors and is NOT connector isolation.
 *
 * ABLATION: change `unsetEnvKeys: codexUnsetEnvKeys` back to `["OPENAI_API_KEY"]`
 * on the exec spawn in execute.ts → the "stdio connector present → DATABASE_URL
 * absent" assertion goes RED. Re-widen the gate to `Object.keys(...).length > 0`
 * (any transport) → the "HTTP-ONLY → DATABASE_URL/AOA_API_KEY present" assertions
 * go RED (the F4 regression).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServerSpec } from "@armyofagents/adapter-utils";
import { execute } from "../server/execute.js";

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
// A STDIO connector — the ONLY transport that spawns a local child inheriting the
// CLI env, so the ONLY one that triggers env isolation (F4).
const PG_STDIO: McpServerSpec = {
  kind: "stdio",
  command: "npx",
  args: ["-y", "dbhub@1.0.0"],
  env: {},
};
// A SECRET-bearing stdio connector — codex CANNOT deliver a stdio secret, so its
// writer drops this as `secret_unreachable` (no child spawns). The isolation gate
// must therefore NOT fire for it (F4 round 2 / Codex round 3).
const SECRET_STDIO: McpServerSpec = {
  kind: "stdio",
  command: "npx",
  args: ["-y", "dbhub@1.0.0", "--token", "${AOA_MCP_PG_TOKEN}"],
  env: {},
  secretEnvVar: "AOA_MCP_PG_TOKEN",
};
const BRIDGE = {
  command: "node",
  args: ["/path/to/mcp-bridge.js"],
  env: { AOA_SESSION_COMPANY_ID: "company-1", DATABASE_URL: AMBIENT_SECRETS.DATABASE_URL },
};

async function writeFakeCodexCommand(commandBase: string): Promise<string> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.AOA_TEST_CAPTURE_PATH;
if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(Object.assign({}, process.env)), "utf8");
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 } }));
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

async function runOnce(
  connectors: "none" | "stdio" | "http" | "secret-stdio",
): Promise<Record<string, string>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-fu23-"));
  const workspace = path.join(root, "workspace");
  const capturePath = path.join(root, "capture.json");
  const codexHome = path.join(root, "codex-home");
  await fs.mkdir(workspace, { recursive: true });
  const commandPath = await writeFakeCodexCommand(path.join(root, "agent"));
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const stdioServers: Record<string, McpServerSpec> =
    connectors === "stdio"
      ? { pg: PG_STDIO }
      : connectors === "secret-stdio"
        ? { pg: SECRET_STDIO }
        : { notion: NOTION };
  const mcpFields =
    connectors === "none"
      ? {}
      : {
          mcpBridge: BRIDGE,
          mcpServers: stdioServers,
        };
  try {
    const result = await execute({
      runId: "run-codex-fu23",
      agent: { id: "agent-1", companyId: "company-1", name: "Codex", adapterType: "codex_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath,
        cwd: workspace,
        env: { AOA_TEST_CAPTURE_PATH: capturePath, AOA_MCP_NOTION_TOKEN: "connector-token" },
        promptTemplate: "Prompt.",
        timeoutSec: 15,
        graceSec: 1,
      },
      context: {},
      executionTarget: { type: "local" as const },
      runtimeCommandSpec: { command: "codex", installCommand: "do-not-run" },
      ...mcpFields,
      authToken: "secret-run-token",
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

describe("codex_local FU-23 env scrub (exec path)", () => {
  it("STDIO connector present → ALL AoA ambient secrets absent, run bearer stripped, connector token + PATH survive", async () => {
    const env = await runOnce("stdio");
    for (const key of Object.keys(AMBIENT_SECRETS)) {
      expect(env[key], `${key} must not leak to a connector child`).toBeUndefined();
    }
    expect(env.AOA_MCP_NOTION_TOKEN).toBe("connector-token");
    expect(env.PATH ?? env.Path).toBeTruthy();
    // WS1 — the run-scoped API bearer must NOT reach a stdio connector child.
    // ABLATION: gate stripConnectorRunBearers off `hasStdioConnector` → RED.
    expect(env.AOA_API_KEY, "run token must not leak to a connector child").toBeUndefined();
  });

  it("no connectors → only the pre-existing OPENAI_API_KEY strip applies (DATABASE_URL still present)", async () => {
    const env = await runOnce("none");
    // codex's long-standing billing-safety strip:
    expect(env.OPENAI_API_KEY).toBeUndefined();
    // ...but the broader FU-23 strip must NOT fire without connectors:
    expect(env.DATABASE_URL).toBe(AMBIENT_SECRETS.DATABASE_URL);
    expect(env.GITHUB_PAT).toBe(AMBIENT_SECRETS.GITHUB_PAT);
    expect(env.AOA_MCP_NOTION_TOKEN).toBe("connector-token");
    // WS1 byte-identity foil: the run token is present when no connectors.
    expect(env.AOA_API_KEY).toBe("secret-run-token");
  });

  it("HTTP-ONLY connector → byte-identical to no-connectors, bearer KEPT (F4: remote connectors spawn no child)", async () => {
    // Enabling an HTTP connector must NOT strip AoA ambient secrets or the agent's
    // own bearer — an HTTP connector is remote and inherits nothing, so isolating
    // the env has zero benefit and would 401 the agent's authenticated REST calls.
    // The always-on codex OPENAI_API_KEY billing strip is unchanged (fires here
    // too, exactly as with no connectors) — that is NOT connector isolation.
    // ABLATION: re-widen the gate to any-transport presence → these go RED.
    const env = await runOnce("http");
    expect(env.OPENAI_API_KEY).toBeUndefined(); // billing strip only, same as "none"
    expect(env.DATABASE_URL).toBe(AMBIENT_SECRETS.DATABASE_URL);
    expect(env.GITHUB_PAT).toBe(AMBIENT_SECRETS.GITHUB_PAT);
    expect(env.AOA_API_KEY).toBe("secret-run-token");
    expect(env.AOA_MCP_NOTION_TOKEN).toBe("connector-token");
  });

  it("SECRET-bearing stdio only → codex drops it (secret_unreachable), so bearer KEPT (Codex round 3)", async () => {
    // codex cannot deliver a stdio secret, so its writer drops a secret-bearing
    // stdio spec before any child spawns. With no delivered stdio child, isolating
    // the env is pure downside — it must NOT strip AOA_API_KEY (else the codex
    // agent's own authenticated REST 401s merely because it was ASSIGNED a
    // connector codex can't run). Uses the writer's OWN predicate
    // (stdioSpecCarriesSecretPlaceholder) so the gate can never disagree with the
    // drop. ABLATION: gate on any-stdio-present → AOA_API_KEY goes undefined → RED.
    const env = await runOnce("secret-stdio");
    expect(env.AOA_API_KEY).toBe("secret-run-token");
    // Byte-identical to no-connectors otherwise: ambient present, only the always-on
    // billing strip fires.
    expect(env.DATABASE_URL).toBe(AMBIENT_SECRETS.DATABASE_URL);
    expect(env.GITHUB_PAT).toBe(AMBIENT_SECRETS.GITHUB_PAT);
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
