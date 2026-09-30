import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../server/execute.js";
import type { AdapterInvocationMeta, AdapterProviderSandboxRunInput } from "@armyofagents/adapter-utils";

async function expectSameRealPath(actual: string, expected: string): Promise<void> {
  await expect(fs.realpath(actual)).resolves.toBe(await fs.realpath(expected));
}

async function writeFakeClaudeCommand(commandPath: string): Promise<string> {
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
    CUSTOM_ENV: process.env.CUSTOM_ENV,
  },
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "claude-session-1",
  model: "claude-test",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "claude-session-1",
  result: "ok",
  usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0 },
  total_cost_usd: 0,
}));
`;
  const jsPath = commandPath + ".js";
  await fs.writeFile(jsPath, script, "utf8");
  await fs.chmod(jsPath, 0o755);

  if (process.platform === "win32") {
    const cmdPath = commandPath + ".cmd";
    await fs.writeFile(cmdPath, `@node "%~dp0agent.js" %*\r\n`, "utf8");
    return cmdPath;
  }

  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("claude execute target", () => {
  it("includes the current task brief in the default Claude prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-task-prompt-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeClaudeCommand(commandBase);

    try {
      const result = await execute({
        runId: "run-claude-task",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Researcher",
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
          timeoutSec: 10,
          graceSec: 1,
        },
        context: {
          currentTaskMarkdown:
            "## Current Task\n- Task ID: task-123\n- Title: Choose the first interview cohort",
        },
        executionTarget: { type: "local" },
        runtimeCommandSpec: null,
        authToken: "secret-run-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { prompt: string };
      expect(capture.prompt).toContain("You are agent agent-1 (Claude Researcher). Continue your AoA work.");
      expect(capture.prompt).toContain("Task ID: task-123");
      expect(capture.prompt).toContain("Choose the first interview cohort");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses an explicit local target and appends task context to a custom prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-execute-target-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeClaudeCommand(commandBase);

    const metaEvents: AdapterInvocationMeta[] = [];

    try {
      const result = await execute({
        runId: "run-claude-target",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
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
          env: {
            AOA_TEST_CAPTURE_PATH: capturePath,
            CUSTOM_ENV: "custom-value",
          },
          promptTemplate: "Prompt for {{agent.id}} in {{runId}}.",
          timeoutSec: 10,
          graceSec: 1,
        },
        context: {
          currentTaskMarkdown: "## Current Task\n- Task ID: task-custom-claude",
        },
        executionTarget: { type: "local" },
        runtimeCommandSpec: { command: "claude", installCommand: "do-not-run" },
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
      expect(capture.argv).toEqual(expect.arrayContaining(["--print", "-", "--output-format", "stream-json"]));
      expect(capture.prompt).toBe(
        "Prompt for agent-1 in run-claude-target.\n\n## Current Task\n- Task ID: task-custom-claude",
      );
      expect(capture.env).toMatchObject({
        AOA_API_KEY: "secret-run-token",
        AOA_RUN_ID: "run-claude-target",
        CUSTOM_ENV: "custom-value",
      });
      const meta = metaEvents.at(-1);
      expect(meta?.commandNotes).toContain("Execution target: local");
      expect(meta?.env?.AOA_API_KEY).toBe("***REDACTED***");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("places variadic extra CLI options after the stdin prompt marker", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-extra-args-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    const mcpConfigPath = path.join(root, "mcp.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(mcpConfigPath, "{}", "utf8");
    const commandPath = await writeFakeClaudeCommand(commandBase);

    try {
      const result = await execute({
        runId: "run-claude-extra-args",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
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
          promptTemplate: "Prompt for {{agent.id}}.",
          args: ["--mcp-config", mcpConfigPath],
          timeoutSec: 10,
          graceSec: 1,
        },
        context: {},
        executionTarget: { type: "local" },
        runtimeCommandSpec: { command: "claude", installCommand: "do-not-run" },
        authToken: "secret-run-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { argv: string[] };
      const promptMarkerIndex = capture.argv.findIndex((arg) => arg === "-");
      const mcpConfigIndex = capture.argv.findIndex((arg) => arg === "--mcp-config");
      expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
      expect(mcpConfigIndex).toBeGreaterThan(promptMarkerIndex);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("syncs provider-sandbox instructions and DB-backed skills before execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-provider-instructions-"));
    const workspace = path.join(root, "workspace");
    const instructionsPath = path.join(root, "instructions.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(instructionsPath, "Follow the configured instructions.", "utf8");
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
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "claude-session-1",
              model: "claude-test",
            }),
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "hello" }] },
            }),
            JSON.stringify({
              type: "result",
              subtype: "success",
              session_id: "claude-session-1",
              result: "ok",
              usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0 },
              total_cost_usd: 0,
            }),
          ].join("\n"),
        };
      }),
    };

    try {
      const result = await execute({
        runId: "run-claude-provider-instructions",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
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
          command: "claude",
          cwd: workspace,
          instructionsFilePath: instructionsPath,
          env: {
            ANTHROPIC_API_KEY: "test-anthropic-key",
          },
        },
        context: {
          skills: [
            {
              key: "company/review",
              name: "Company Review",
              markdown: "# Company Review\n\nUse the company-specific rubric.",
            },
          ],
        },
        executionTarget: {
          type: "provider-sandbox",
          provider: "e2b",
          providerLeaseId: "sandbox-1",
          remoteCwd: "/home/user/aoa-workspace",
          shell: "bash",
          runner: providerRunner,
        },
        authToken: "secret-run-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.executionCwd).toBe("/home/user/aoa-workspace");
      expect(result.sessionParams).toMatchObject({
        sessionId: "claude-session-1",
        cwd: "/home/user/aoa-workspace",
        remoteExecution: {
          type: "provider-sandbox",
          provider: "e2b",
          providerLeaseId: "sandbox-1",
          remoteCwd: "/home/user/aoa-workspace",
        },
      });
      const syncInstructions = providerInputs.find((input) =>
        input.stdin && input.stdin === Buffer.from(
          [
            "Follow the configured instructions.",
            `The above agent instructions were loaded from ${instructionsPath}. Resolve any relative file references from ${path.dirname(instructionsPath)}/.`,
          ].join("\n"),
        ).toString("base64")
      );
      expect(syncInstructions?.args.join(" ")).toContain("/home/user/aoa-workspace/.aoa-runtime/claude/agent-instructions.md");
      const runInput = providerInputs.find((input) => input.args.includes("--print"));
      expect(runInput).toBeDefined();
      expect(runInput!.cwd).toBe("/home/user/aoa-workspace");
      expect(runInput!.env.HOME).toBe("/home/user/aoa-workspace/.aoa-runtime/claude");
      expect(runInput!.args).toEqual(expect.arrayContaining([
        "--append-system-prompt-file",
        "/home/user/aoa-workspace/.aoa-runtime/claude/agent-instructions.md",
        "--add-dir",
        "/home/user/aoa-workspace/.aoa-runtime/claude/.claude/skills",
      ]));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs provider-sandbox targets through the remote install wrapper", async () => {
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
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "claude-session-1",
              model: "claude-test",
            }),
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "hello" }] },
            }),
            JSON.stringify({
              type: "result",
              subtype: "success",
              session_id: "claude-session-1",
              result: "ok",
              usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0 },
              total_cost_usd: 0,
            }),
          ].join("\n"),
        };
      }),
    };

    const result = await execute({
      runId: "run-claude-provider",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
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
        command: "claude",
        env: {
          ANTHROPIC_API_KEY: "test-anthropic-key",
          CUSTOM_ENV: "custom-value",
        },
        promptTemplate: "Prompt for {{agent.id}} in {{runId}}.",
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
      runtimeCommandSpec: {
        command: "claude",
        installCommand: "npm install -g @anthropic-ai/claude-code",
      },
      authToken: "secret-run-token",
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    const providerInput = providerInputs.find((input) => input.args.includes("--print"));
    expect(providerInput).toBeDefined();
    expect(providerInput).toMatchObject({
      command: "bash",
      args: [
        "-lc",
        [
          "set -e",
          "npm install -g @anthropic-ai/claude-code",
          'exec "$@"',
        ].join("\n"),
        "bash",
        "claude",
        "--print",
        "-",
        "--output-format",
        "stream-json",
        "--verbose",
        "--add-dir",
        "/home/user/aoa-workspace/.aoa-runtime/claude/.claude/skills",
      ],
      cwd: "/home/user/aoa-workspace",
    });
    expect(providerInput!.env.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
    // U5: the sandbox env allowlist is a from-scratch positive list — an
    // arbitrary configured env var with no allowlisted meaning (run-identity,
    // provider auth, connector token, managed home) does NOT cross into a
    // sandboxed run, even though it would reach a local-target run unchanged.
    expect(providerInput!.env.CUSTOM_ENV).toBeUndefined();
  });

  it("stages the brokered --mcp-config into the sandbox VM and rewrites the arg to the remote path (W7.4)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-mcp-stage-"));
    const workspace = path.join(root, "workspace");
    const mcpConfigPath = path.join(root, "aoa-mcp-config.host.json");
    await fs.mkdir(workspace, { recursive: true });
    // A brokered `aoa` server is HTTP (points at the control-plane broker), so
    // the config is DB-free by construction — assert that below (defense in
    // depth: a sandbox VM must never receive DATABASE_URL / postgres:// creds).
    const brokeredConfig = JSON.stringify({
      mcpServers: {
        aoa: {
          type: "http",
          url: "https://broker.example/companies/company-1/mcp",
          headers: { Authorization: "Bearer run-scoped-broker-token" },
        },
      },
    });
    await fs.writeFile(mcpConfigPath, brokeredConfig, "utf8");

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
            JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-test" }),
            JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
            JSON.stringify({
              type: "result",
              subtype: "success",
              session_id: "claude-session-1",
              result: "ok",
              usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0 },
              total_cost_usd: 0,
            }),
          ].join("\n"),
        };
      }),
    };

    try {
      const result = await execute({
        runId: "run-claude-mcp-stage",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: "claude",
          cwd: workspace,
          env: { ANTHROPIC_API_KEY: "test-anthropic-key" },
          // AoA's runner injects `--mcp-config <hostPath> --strict-mcp-config`
          // into the adapter-read args key (space-separated pair).
          args: ["--mcp-config", mcpConfigPath, "--strict-mcp-config"],
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
        runtimeCommandSpec: { command: "claude", installCommand: "npm install -g @anthropic-ai/claude-code" },
        authToken: "secret-run-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);

      const remoteMcpConfigPath = "/home/user/aoa-workspace/.aoa-runtime/claude/aoa-mcp-config.json";

      // (1) DELIVERY: a base64-pipe sync staged the config to the remote path.
      const stageInput = providerInputs.find((input) =>
        input.args.some((arg) => arg.includes(remoteMcpConfigPath)) && typeof input.stdin === "string",
      );
      expect(stageInput).toBeDefined();
      // (3) DB-FREE: the bytes actually piped into the VM carry no DB creds.
      const staged = Buffer.from(stageInput!.stdin!, "base64").toString("utf8");
      expect(staged).toBe(brokeredConfig);
      expect(staged).not.toContain("DATABASE_URL");
      expect(staged).not.toContain("postgres://");

      // (2) ARG REWRITE: the in-VM claude reads the REMOTE path, never the host one.
      const runInput = providerInputs.find((input) => input.args.includes("--print"));
      expect(runInput).toBeDefined();
      const flagIdx = runInput!.args.indexOf("--mcp-config");
      expect(flagIdx).toBeGreaterThanOrEqual(0);
      expect(runInput!.args[flagIdx + 1]).toBe(remoteMcpConfigPath);
      expect(runInput!.args).not.toContain(mcpConfigPath);
      // The strict flag rides along unchanged so the CLI does not also inherit
      // host/project MCP servers.
      expect(runInput!.args).toContain("--strict-mcp-config");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
