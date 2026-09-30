/**
 * Tests for Task 6: PreToolUse hook settings injection in execute().
 *
 * When ctx.runtimeHookBridge is enabled:
 *   - --settings <path> is added to args
 *   - The settings file parses to { hooks: { PreToolUse: [...] } } invoking node <forwarder>
 *   - --dangerously-skip-permissions is NOT added even if config.dangerouslySkipPermissions === true
 *   - child env contains AOA_RUNTIME_HOOK_URL; the TOKEN rides in a sibling file
 *     (path is a hook-command arg), never in the env a connector child inherits (F1)
 *   - The raw token does NOT appear in the onMeta payload (neither env nor argv)
 *
 * When ctx.runtimeHookBridge is absent/disabled:
 *   - Behavior is byte-for-byte current: --settings not added, skip-permissions honored per config
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../server/execute.js";
import type { AdapterInvocationMeta } from "@armyofagents/adapter-utils";
import type { RuntimeHookBridgeSpec, McpServerSpec } from "@armyofagents/adapter-utils";

const HOOK_BRIDGE_SPEC: RuntimeHookBridgeSpec = {
  enabled: true,
  selfBaseUrl: "http://127.0.0.1:3000",
  path: "/internal/runtime-hooks/permission-request",
  timeoutSec: 300,
};
const HOOK_TOKEN = "SECRET-TOKEN-VALUE-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const HOOK_URL = "http://127.0.0.1:3000/internal/runtime-hooks/permission-request";

// WS1 — connector fixtures to force `connectorsPresent` (claude needs BOTH an
// mcpBridge and a non-empty mcpServers). Used only by the connector-run test.
const CONNECTOR_MCP_BRIDGE = {
  command: "node",
  args: ["/path/to/mcp-bridge.js"],
  env: { AOA_SESSION_COMPANY_ID: "company-hooks" },
};
// STDIO — the transport that spawns a local child inheriting the CLI env, so the
// one that triggers the WS1 bearer strip (F4: an http-only connector would not).
const CONNECTOR_SERVERS: Record<string, McpServerSpec> = {
  pg: {
    kind: "stdio",
    command: "npx",
    args: ["-y", "dbhub@1.0.0"],
    env: {},
  },
};

// Fake claude command that captures argv + env (and, when bridged, the settings
// file + the sibling hook-token file) to a JSON file, then exits cleanly. The
// token file is read DURING execution — before execute()'s finally cleans up the
// temp dir — which is exactly what proves the forwarder could read it (F1).
async function writeFakeClaudeCommand(commandBase: string): Promise<string> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const capturePath = process.env.AOA_TEST_CAPTURE_PATH;
let settingsContent = null;
let tokenFileContent = null;
const settingsIdx = process.argv.indexOf("--settings");
if (settingsIdx >= 0) {
  const settingsPath = process.argv[settingsIdx + 1];
  try { settingsContent = fs.readFileSync(settingsPath, "utf8"); } catch {}
  // F1: the hook token rides in a sibling file (path is a hook-command arg), not
  // in the env. It sits next to the settings file in the run's temp hook dir.
  try {
    tokenFileContent = fs.readFileSync(path.join(path.dirname(settingsPath), "aoa-runtime-hook-token"), "utf8");
  } catch {}
}
const payload = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.assign({}, process.env),
  settingsContent,
  tokenFileContent,
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "claude-session-hooks-test",
  model: "claude-test",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "claude-session-hooks-test",
  result: "ok",
  usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0 },
  total_cost_usd: 0,
}));
`;
  const jsPath = commandBase + ".js";
  await fs.writeFile(jsPath, script, "utf8");
  await fs.chmod(jsPath, 0o755).catch(() => {});

  if (process.platform === "win32") {
    const cmdPath = commandBase + ".cmd";
    await fs.writeFile(cmdPath, `@node "${jsPath}" %*\r\n`, "utf8");
    return cmdPath;
  }

  await fs.writeFile(commandBase, script, "utf8");
  await fs.chmod(commandBase, 0o755);
  return commandBase;
}

function makeBaseContext(commandPath: string, capturePath: string, workspace: string) {
  return {
    runId: "run-hooks-test",
    agent: {
      id: "agent-hooks",
      companyId: "company-hooks",
      name: "Hook Test Agent",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: commandPath,
      cwd: workspace,
      env: { AOA_TEST_CAPTURE_PATH: capturePath },
      promptTemplate: "Prompt for hooks test.",
      timeoutSec: 10,
      graceSec: 1,
    },
    context: {},
    executionTarget: { type: "local" as const },
    onLog: async () => {},
  };
}

describe("execute — runtime hook bridge (Task 6)", () => {
  it("bridged: adds --settings, injects hook env vars, skips --dangerously-skip-permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-hooks-bridged-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeClaudeCommand(commandBase);

    const metaEvents: AdapterInvocationMeta[] = [];

    try {
      const result = await execute({
        ...makeBaseContext(commandPath, capturePath, workspace),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { AOA_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Prompt for hooks test.",
          timeoutSec: 10,
          graceSec: 1,
          // Even if dangerouslySkipPermissions is true, bridge takes precedence
          dangerouslySkipPermissions: true,
        },
        runtimeHookBridge: HOOK_BRIDGE_SPEC,
        runtimeHookToken: HOOK_TOKEN,
        onMeta: async (next) => {
          metaEvents.push(next);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        env: Record<string, string>;
        tokenFileContent: string | null;
      };

      // --settings <path> must be present
      const settingsIdx = capture.argv.indexOf("--settings");
      expect(settingsIdx).toBeGreaterThanOrEqual(0);
      const settingsPath = capture.argv[settingsIdx + 1];
      expect(settingsPath).toBeTruthy();

      // The settings file must parse to { hooks: { PreToolUse: [...] } } invoking node <forwarder>
      const settingsRaw = await fs.readFile(settingsPath, "utf8").catch(() => null);
      // File may be cleaned up by the time we read it — parse from capture instead
      // Actually we need to check it was written correctly. The settings file is cleaned in finally,
      // but we capture argv BEFORE the finally block runs.
      // Re-read the capture and verify the settings path exists/existed via argv shape only.
      // We can read the file synchronously before execute() returns if we intercept —
      // instead, test via argv presence and env vars (the settings file cleanup is async/non-blocking).
      if (settingsRaw !== null) {
        const settings = JSON.parse(settingsRaw) as {
          hooks?: { PreToolUse?: unknown[] };
        };
        expect(settings).toHaveProperty("hooks");
        expect(settings.hooks).toHaveProperty("PreToolUse");
        const entry = (settings.hooks!.PreToolUse as Array<{ hooks: Array<{ command: string }> }>)[0];
        expect(entry.hooks[0].command).toContain("node");
        expect(entry.hooks[0].command).toContain("hook-forward");
      }

      // --dangerously-skip-permissions must NOT be present when bridged
      expect(capture.argv).not.toContain("--dangerously-skip-permissions");

      // F1: the URL rides in the env (non-secret), but the TOKEN does NOT — it is
      // delivered via a sibling file the forwarder reads (path is a hook-command
      // arg). The fake CLI read that file during the run: it holds the real token.
      expect(capture.env.AOA_RUNTIME_HOOK_URL).toBe(HOOK_URL);
      expect(capture.env.AOA_RUNTIME_HOOK_TOKEN).toBeUndefined();
      expect(capture.tokenFileContent).toBe(HOOK_TOKEN);

      // Token-absence-from-meta: the raw token must not appear in the meta payload
      // (it is neither in env nor in the CLI argv — only the settings-file path is).
      const meta = metaEvents.at(-1);
      expect(meta).toBeDefined();
      const metaJson = JSON.stringify(meta);
      expect(metaJson).not.toContain(HOOK_TOKEN);
      // ...and there is no hook-token env entry to redact anymore.
      expect(meta?.env?.AOA_RUNTIME_HOOK_TOKEN).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("bridged: settings file parses to PreToolUse hook invoking node + hook-forward.mjs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-hooks-settings-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });

    // Write a fake claude that captures argv and reads+writes the settings file content
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const capturePath = process.env.AOA_TEST_CAPTURE_PATH;
const settingsIdx = process.argv.indexOf("--settings");
let settingsContent = null;
let tokenFileContent = null;
if (settingsIdx >= 0) {
  const settingsPath = process.argv[settingsIdx + 1];
  try { settingsContent = fs.readFileSync(settingsPath, "utf8"); } catch {}
  try { tokenFileContent = fs.readFileSync(path.join(path.dirname(settingsPath), "aoa-runtime-hook-token"), "utf8"); } catch {}
}
const payload = { argv: process.argv.slice(2), settingsContent, tokenFileContent };
if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-test" }));
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "s1", result: "ok", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }, total_cost_usd: 0 }));
`;
    const jsPath = commandBase + ".js";
    await fs.writeFile(jsPath, script, "utf8");

    let commandPath: string;
    if (process.platform === "win32") {
      commandPath = commandBase + ".cmd";
      await fs.writeFile(commandPath, `@node "${jsPath}" %*\r\n`, "utf8");
    } else {
      commandPath = commandBase;
      await fs.writeFile(commandPath, script, "utf8");
      await fs.chmod(commandPath, 0o755);
    }

    try {
      await execute({
        ...makeBaseContext(commandPath, capturePath, workspace),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { AOA_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "test",
          timeoutSec: 10,
          graceSec: 1,
        },
        runtimeHookBridge: HOOK_BRIDGE_SPEC,
        runtimeHookToken: HOOK_TOKEN,
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        settingsContent: string | null;
        tokenFileContent: string | null;
      };

      expect(capture.argv).toContain("--settings");
      expect(capture.settingsContent).not.toBeNull();

      const settings = JSON.parse(capture.settingsContent!) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }> };
      };
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      const entry = settings.hooks.PreToolUse[0];
      expect(entry.matcher).toBeTruthy();
      expect(entry.hooks[0].type).toBe("command");
      // F1: the command invokes the forwarder AND passes the token-file path as an
      // arg; the file (read during the run) holds the real token.
      expect(entry.hooks[0].command).toMatch(/node.*hook-forward.*aoa-runtime-hook-token/);
      expect(capture.tokenFileContent).toBe(HOOK_TOKEN);
      expect(entry.hooks[0].timeout).toBe(300);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("unbridged: no --settings flag, --dangerously-skip-permissions honored per config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-hooks-unbridged-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeClaudeCommand(commandBase);

    try {
      const result = await execute({
        ...makeBaseContext(commandPath, capturePath, workspace),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { AOA_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Prompt for hooks test.",
          timeoutSec: 10,
          graceSec: 1,
          dangerouslySkipPermissions: true,
        },
        // No runtimeHookBridge → unbridged behavior
      });

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        env: Record<string, string>;
      };

      // --settings must NOT be present in unbridged mode
      expect(capture.argv).not.toContain("--settings");

      // --dangerously-skip-permissions IS present (config respected)
      expect(capture.argv).toContain("--dangerously-skip-permissions");

      // Hook env vars must NOT be set when unbridged
      expect(capture.env.AOA_RUNTIME_HOOK_TOKEN).toBeUndefined();
      expect(capture.env.AOA_RUNTIME_HOOK_URL).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("bridged: strips --dangerously-skip-permissions from extraArgs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-hooks-strip-dsp-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeClaudeCommand(commandBase);

    try {
      const result = await execute({
        ...makeBaseContext(commandPath, capturePath, workspace),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { AOA_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "strip test",
          timeoutSec: 10,
          graceSec: 1,
          extraArgs: ["--dangerously-skip-permissions"],
        },
        runtimeHookBridge: HOOK_BRIDGE_SPEC,
        runtimeHookToken: HOOK_TOKEN,
      });

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
      };

      // Bypass flag must be stripped in bridged mode
      expect(capture.argv).not.toContain("--dangerously-skip-permissions");
      // --settings must still be present (bridge is wired)
      expect(capture.argv).toContain("--settings");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("bridged: strips --permission-mode bypassPermissions (two-token form) from extraArgs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-hooks-strip-pm-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeClaudeCommand(commandBase);

    try {
      const result = await execute({
        ...makeBaseContext(commandPath, capturePath, workspace),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { AOA_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "strip test",
          timeoutSec: 10,
          graceSec: 1,
          extraArgs: ["--permission-mode", "bypassPermissions"],
        },
        runtimeHookBridge: HOOK_BRIDGE_SPEC,
        runtimeHookToken: HOOK_TOKEN,
      });

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
      };

      // Both flag and value tokens must be stripped
      expect(capture.argv).not.toContain("--permission-mode");
      expect(capture.argv).not.toContain("bypassPermissions");
      // --settings must still be present
      expect(capture.argv).toContain("--settings");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("bridged: preserves --permission-mode plan (benign value) in extraArgs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-hooks-keep-pm-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeClaudeCommand(commandBase);

    try {
      const result = await execute({
        ...makeBaseContext(commandPath, capturePath, workspace),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { AOA_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "strip test",
          timeoutSec: 10,
          graceSec: 1,
          extraArgs: ["--permission-mode", "plan"],
        },
        runtimeHookBridge: HOOK_BRIDGE_SPEC,
        runtimeHookToken: HOOK_TOKEN,
      });

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
      };

      // Benign --permission-mode value must be preserved
      const pmIdx = capture.argv.indexOf("--permission-mode");
      expect(pmIdx).toBeGreaterThanOrEqual(0);
      expect(capture.argv[pmIdx + 1]).toBe("plan");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("unbridged: --dangerously-skip-permissions in extraArgs is preserved (unchanged behavior)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-hooks-unbridged-dsp-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeClaudeCommand(commandBase);

    try {
      const result = await execute({
        ...makeBaseContext(commandPath, capturePath, workspace),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { AOA_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "strip test",
          timeoutSec: 10,
          graceSec: 1,
          extraArgs: ["--dangerously-skip-permissions"],
        },
        // No runtimeHookBridge → unbridged; bypass flags must NOT be stripped
      });

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
      };

      // In unbridged mode, --dangerously-skip-permissions in extraArgs is kept
      expect(capture.argv).toContain("--dangerously-skip-permissions");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("bridged + connectors present: BOTH run bearers (hook token + API key) are stripped from the connector-facing env", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-hooks-connectors-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeClaudeCommand(commandBase);
    try {
      const result = await execute({
        ...makeBaseContext(commandPath, capturePath, workspace),
        config: {
          command: commandPath,
          cwd: workspace,
          env: { AOA_TEST_CAPTURE_PATH: capturePath, AOA_MCP_NOTION_TOKEN: "connector-token" },
          promptTemplate: "Prompt for hooks test.",
          timeoutSec: 10,
          graceSec: 1,
        },
        // Bridge ON (hook wired, token delivered via file — F1) AND connectors
        // present (so the WS1 strip must fire on AOA_API_KEY). authToken set so
        // AOA_API_KEY is injected — otherwise the strip assertion would be vacuous.
        runtimeHookBridge: HOOK_BRIDGE_SPEC,
        runtimeHookToken: HOOK_TOKEN,
        authToken: "secret-run-token",
        mcpBridge: CONNECTOR_MCP_BRIDGE,
        mcpServers: CONNECTOR_SERVERS,
      });
      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        env: Record<string, string>;
        tokenFileContent: string | null;
      };
      // BOTH run bearers must be absent from the connector-facing env: AOA_API_KEY
      // (injected via authToken, stripped by value) and AOA_RUNTIME_HOOK_TOKEN
      // (F1: never injected into env at all). ABLATION for AOA_API_KEY: delete
      // stripConnectorRunBearers(...) in execute.ts → RED.
      expect(capture.env.AOA_RUNTIME_HOOK_TOKEN).toBeUndefined();
      expect(capture.env.AOA_API_KEY).toBeUndefined();
      // The connector's own token still rides (it's the credential the connector needs).
      expect(capture.env.AOA_MCP_NOTION_TOKEN).toBe("connector-token");
      // F1 — the crux: WITH a connector present, the hook still WORKS, because its
      // token is delivered via the sibling file (readable during the run), not via
      // the stripped env. Before F1 this run denied every governed tool. ABLATION:
      // revert execute.ts to inject env.AOA_RUNTIME_HOOK_TOKEN → the strip removes
      // it and tokenFileContent is null → RED.
      expect(capture.tokenFileContent).toBe(HOOK_TOKEN);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("unbridged: runtimeHookBridge.enabled === false means no hook injection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-hooks-disabled-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeClaudeCommand(commandBase);

    try {
      const result = await execute({
        ...makeBaseContext(commandPath, capturePath, workspace),
        runtimeHookBridge: { ...HOOK_BRIDGE_SPEC, enabled: false },
        runtimeHookToken: HOOK_TOKEN,
      });

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        env: Record<string, string>;
      };

      expect(capture.argv).not.toContain("--settings");
      expect(capture.env.AOA_RUNTIME_HOOK_TOKEN).toBeUndefined();
      expect(capture.env.AOA_RUNTIME_HOOK_URL).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
