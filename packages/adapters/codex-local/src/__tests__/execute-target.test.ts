import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../server/execute.js";
import { testEnvironment } from "../server/test.js";
import type { AdapterInvocationMeta, AdapterProviderSandboxRunInput, McpHttpServerSpec } from "@armyofagents/adapter-utils";

async function expectSameRealPath(actual: string, expected: string): Promise<void> {
  await expect(fs.realpath(actual)).resolves.toBe(await fs.realpath(expected));
}

async function writeFakeCodexCommand(commandPath: string): Promise<string> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.AOA_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  prompt: fs.readFileSync(0, "utf8"),
  env: {
    AOA_API_KEY: process.env.AOA_API_KEY,
    AOA_RUN_ID: process.env.AOA_RUN_ID,
    CODEX_HOME: process.env.CODEX_HOME,
    CUSTOM_ENV: process.env.CUSTOM_ENV,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  },
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 },
}));
`;
  const jsPath = commandPath + ".js";
  await fs.writeFile(jsPath, script, "utf8");
  await fs.chmod(jsPath, 0o755);

  if (process.platform === "win32") {
    const cmdPath = commandPath + ".cmd";
    await fs.writeFile(cmdPath, `@node "%~dp0${path.basename(jsPath)}" %*\r\n`, "utf8");
    return cmdPath;
  }

  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("codex execute target", () => {
  it("uses an explicit local target and appends task context to a custom prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-execute-target-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeCodexCommand(commandBase);

    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const metaEvents: AdapterInvocationMeta[] = [];

    try {
      const result = await execute({
        runId: "run-codex-target",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
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
          env: {
            AOA_TEST_CAPTURE_PATH: capturePath,
            CUSTOM_ENV: "custom-value",
          },
          promptTemplate: "Prompt for {{agent.id}} in {{runId}}.",
          timeoutSec: 10,
          graceSec: 1,
        },
        context: {
          currentTaskMarkdown: "## Current Task\n- Task ID: task-custom-codex",
        },
        executionTarget: { type: "local" },
        runtimeCommandSpec: { command: "codex", installCommand: "do-not-run" },
        authToken: "secret-run-token",
        onLog: async () => {},
        onMeta: async (next) => {
          metaEvents.push(next);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.executionCwd).toBeTruthy();
      await expectSameRealPath(result.executionCwd!, workspace);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        cwd: string;
        prompt: string;
        env: Record<string, string>;
      };
      await expectSameRealPath(capture.cwd, workspace);
      expect(capture.argv).toEqual(expect.arrayContaining(["exec", "--json", "-"]));
      expect(capture.prompt).toBe(
        "Prompt for agent-1 in run-codex-target.\n\n## Current Task\n- Task ID: task-custom-codex",
      );
      expect(capture.env).toMatchObject({
        AOA_API_KEY: "secret-run-token",
        AOA_RUN_ID: "run-codex-target",
        CUSTOM_ENV: "custom-value",
      });
      expect(capture.env.CODEX_HOME).toBe(
        path.join(codexHome, "aoa-instances", "company-1", "agent-1"),
      );
      const meta = metaEvents.at(-1);
      expect(meta?.commandNotes).toContain("Execution target: local");
      expect(meta?.env?.AOA_API_KEY).toBe("***REDACTED***");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  async function runCodexAndCaptureEnv(configEnv: Record<string, string>): Promise<Record<string, string>> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-envstrip-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeCodexCommand(commandBase);
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const result = await execute({
        runId: "run-envstrip",
        agent: { id: "agent-1", companyId: "company-1", name: "Codex Coder", adapterType: "codex_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          env: { AOA_TEST_CAPTURE_PATH: capturePath, ...configEnv },
          timeoutSec: 10,
          graceSec: 1,
        },
        context: {},
        executionTarget: { type: "local" },
        runtimeCommandSpec: { command: "codex", installCommand: "do-not-run" },
        authToken: "secret-run-token",
        onLog: async () => {},
        onMeta: async () => {},
      });
      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { env: Record<string, string> };
      return capture.env;
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it("does NOT pass the ambient OPENAI_API_KEY to the codex child when config.env has none (Codex finding 3)", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-server-ambient";
    try {
      const env = await runCodexAndCaptureEnv({});
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("DOES pass a config-set OPENAI_API_KEY to the codex child (overlay wins)", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-server-ambient";
    try {
      const env = await runCodexAndCaptureEnv({ OPENAI_API_KEY: "sk-agent-explicit" });
      expect(env.OPENAI_API_KEY).toBe("sk-agent-explicit");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("an explicit empty config.env OPENAI_API_KEY suppresses the inherited one (overlay wins)", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-server-ambient";
    try {
      const env = await runCodexAndCaptureEnv({ OPENAI_API_KEY: "" });
      expect(env.OPENAI_API_KEY).toBe("");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("includes the current task brief in the default Codex prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-task-prompt-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    const codexHome = path.join(root, "codex-home");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeCodexCommand(commandBase);

    try {
      const result = await execute({
        runId: "run-codex-task",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
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
          env: {
            AOA_TEST_CAPTURE_PATH: capturePath,
          },
          timeoutSec: 10,
          graceSec: 1,
        },
        context: {
          currentTaskMarkdown:
            "## Current Task\n- Identifier: MAN-1\n- Title: Start preview\n\n### Description\nStart a localhost preview app.",
        },
        executionTarget: { type: "local" },
        runtimeCommandSpec: null,
        authToken: "secret-run-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        prompt: string;
      };
      expect(capture.prompt).toContain("You are agent agent-1 (Codex Coder). Continue your AoA work.");
      expect(capture.prompt).toContain("## Current Task");
      expect(capture.prompt).toContain("- Identifier: MAN-1");
      expect(capture.prompt).toContain("Start a localhost preview app.");
      expect(capture.prompt).not.toContain("AOA_PREVIEW_URL=<full localhost URL>");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses a remote Codex home for provider-sandbox targets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-provider-target-"));
    const hostCodexHome = path.join(root, "host-codex-home");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = hostCodexHome;
    const providerInputs: AdapterProviderSandboxRunInput[] = [];
    const providerRunner = {
      execute: vi.fn(async (input: AdapterProviderSandboxRunInput) => {
        providerInputs.push(input);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stderr: "",
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }),
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }),
            JSON.stringify({
              type: "turn.completed",
              usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 },
            }),
          ].join("\n"),
        };
      }),
    };

    try {
      const result = await execute({
        runId: "run-codex-provider",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "codex",
          env: {
            CUSTOM_ENV: "custom-value",
          },
          timeoutSec: 10,
          graceSec: 1,
        },
        context: {},
        executionTarget: {
          type: "provider-sandbox",
          provider: "e2b",
          providerLeaseId: "sandbox-1",
          remoteCwd: "/home/user/aoa-workspace",
          shell: "bash",
          runner: providerRunner,
        },
        runtimeCommandSpec: { command: "codex", installCommand: "npm install -g @openai/codex" },
        authToken: "secret-run-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const providerInput = providerInputs[0];
      expect(providerInput).toBeDefined();
      expect(providerInput!.env.CODEX_HOME).toBe("/home/user/aoa-workspace/.aoa-codex-home");
      expect(providerInput!.env.CODEX_HOME).not.toContain(hostCodexHome);
      // U5: the sandbox env allowlist is a from-scratch positive list — an
      // arbitrary configured env var with no allowlisted meaning (run-identity,
      // provider auth, connector token, managed home) does NOT cross into a
      // sandboxed run, even though it would reach a local-target run unchanged.
      expect(providerInput!.env.CUSTOM_ENV).toBeUndefined();
      expect(providerInput!.command).toBe("bash");
      expect(providerInput!.args[1]).toContain('mkdir -p "/home/user/aoa-workspace/.aoa-codex-home"');
      expect(providerInput!.args[1]).toContain("codex login --with-api-key");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("stages the managed config.toml into the sandbox VM's CODEX_HOME (W7.4)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-mcp-stage-"));
    const hostCodexHome = path.join(root, "host-codex-home");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = hostCodexHome;
    const providerInputs: AdapterProviderSandboxRunInput[] = [];
    const providerRunner = {
      execute: vi.fn(async (input: AdapterProviderSandboxRunInput) => {
        providerInputs.push(input);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stderr: "",
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }),
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }),
            JSON.stringify({
              type: "turn.completed",
              usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 },
            }),
          ].join("\n"),
        };
      }),
    };

    // A brokered (E2B-sandboxed) run's `aoa` server is HTTP-shaped: it points at
    // the control-plane broker with a bearer env-var NAME, so the rendered
    // config.toml carries NO DATABASE_URL — the stdio bridge's `.env` (which
    // does carry DB creds) is never selected for a sandbox. Assert DB-free below.
    const brokerBridge: McpHttpServerSpec = {
      kind: "http",
      url: "https://broker.example/companies/company-1/mcp",
      headers: {},
      authTokenEnvVar: "AOA_BROKER_TOKEN",
    };

    try {
      const result = await execute({
        runId: "run-codex-mcp-stage",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: "codex",
          env: {},
          timeoutSec: 10,
          graceSec: 1,
        },
        context: {},
        executionTarget: {
          type: "provider-sandbox",
          provider: "e2b",
          providerLeaseId: "sandbox-1",
          remoteCwd: "/home/user/aoa-workspace",
          shell: "bash",
          runner: providerRunner,
        },
        runtimeCommandSpec: { command: "codex", installCommand: "npm install -g @openai/codex" },
        mcpBridge: brokerBridge,
        authToken: "secret-run-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);

      const remoteConfigTomlPath = "/home/user/aoa-workspace/.aoa-codex-home/config.toml";
      // (1) DELIVERY: a base64-pipe sync staged config.toml into the VM's CODEX_HOME.
      const stageInput = providerInputs.find(
        (input) => input.args.some((arg) => arg.includes(remoteConfigTomlPath)) && typeof input.stdin === "string",
      );
      expect(stageInput).toBeDefined();
      // The sync's own remote command creates the parent dir before writing, so
      // remoteCodexHome is guaranteed to exist even before the install `mkdir`.
      expect(stageInput!.args[1]).toContain('mkdir -p "$(dirname');

      // (2) CONTENT + DB-FREE: the exact bytes piped into the VM.
      const staged = Buffer.from(stageInput!.stdin!, "base64").toString("utf8");
      expect(staged).toContain("[mcp_servers.aoa]");
      expect(staged).toContain('url = "https://broker.example/companies/company-1/mcp"');
      expect(staged).toContain('bearer_token_env_var = "AOA_BROKER_TOKEN"');
      expect(staged).not.toContain("DATABASE_URL");
      expect(staged).not.toContain("postgres://");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("codex testEnvironment probe env-strip (Codex P2)", () => {
  async function runProbeAndCaptureEnv(configEnv: Record<string, string>): Promise<Record<string, string | undefined>> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-probe-env-"));
    const workspace = path.join(root, "workspace");
    const capturePath = path.join(root, "capture.json");
    const codexHome = path.join(root, "codex-home"); // no auth.json
    await fs.mkdir(workspace, { recursive: true });
    // The probe only spawns when the command basename looks like `codex`
    // (commandLooksLike); name the fake accordingly so the hello probe runs.
    const commandPath = await writeFakeCodexCommand(path.join(root, "codex"));

    const previousCodexHome = process.env.CODEX_HOME;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    try {
      process.env.CODEX_HOME = codexHome;
      // Ambient server key present (the leak condition).
      process.env.OPENAI_API_KEY = "sk-ambient-probe-canary-should-be-stripped";
      await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { command: commandPath, cwd: workspace, env: { AOA_TEST_CAPTURE_PATH: capturePath, ...configEnv } },
      });
      const captured = JSON.parse(await fs.readFile(capturePath, "utf8")) as { env: Record<string, string | undefined> };
      return captured.env;
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousOpenAiKey;
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it("strips the ambient server OPENAI_API_KEY from the probe child (no per-agent key)", async () => {
    const env = await runProbeAndCaptureEnv({});
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("keeps a per-agent OPENAI_API_KEY the agent set in its own config env", async () => {
    const env = await runProbeAndCaptureEnv({ OPENAI_API_KEY: "sk-agent-own-key" });
    expect(env.OPENAI_API_KEY).toBe("sk-agent-own-key");
  });
});
