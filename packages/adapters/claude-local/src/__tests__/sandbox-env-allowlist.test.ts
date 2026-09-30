import { describe, expect, it, vi } from "vitest";
import { execute } from "../server/execute.js";
import type { AdapterProviderSandboxRunInput } from "@armyofagents/adapter-utils";

const okResultStdout = [
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
].join("\n");

describe("U5 — sandbox env allowlist wired through the claude-local provider-sandbox call site", () => {
  it("drops DATABASE_URL + AOA_SECRETS_MASTER_KEY from the runner's env while keeping ANTHROPIC_API_KEY + AOA_API_KEY", async () => {
    const providerInputs: AdapterProviderSandboxRunInput[] = [];
    const providerRunner = {
      execute: vi.fn(async (input: AdapterProviderSandboxRunInput) => {
        providerInputs.push(input);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stderr: "",
          stdout: okResultStdout,
        };
      }),
    };

    const result = await execute({
      runId: "run-claude-allowlist",
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
          // NEVER-in-VM infra secrets — must not survive even though the
          // caller's overlay carries them.
          DATABASE_URL: "postgres://leak",
          AOA_SECRETS_MASTER_KEY: "leaked-master-key",
          // Legitimate credentials for a claude (anthropic-provider) run.
          ANTHROPIC_API_KEY: "test-anthropic-key",
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
      // authToken flows into env.AOA_API_KEY when no explicit key is configured
      // (see execute.ts's `hasExplicitApiKey` branch) — this is the run-JWT.
      authToken: "secret-run-token",
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    const runInput = providerInputs.find((input) => input.args.includes("--print"));
    expect(runInput).toBeDefined();

    // NEVER-in-VM secrets absent.
    expect(runInput!.env.DATABASE_URL).toBeUndefined();
    expect(runInput!.env.AOA_SECRETS_MASTER_KEY).toBeUndefined();

    // Legitimate credentials present.
    expect(runInput!.env.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
    expect(runInput!.env.AOA_API_KEY).toBe("secret-run-token");
  });
});
