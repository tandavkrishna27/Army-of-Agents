import { describe, expect, it, vi } from "vitest";
import { execute } from "../execute.js";
import type { AdapterProviderSandboxRunInput } from "@armyofagents/adapter-utils";

const okResultStdout = [
  JSON.stringify({ type: "result", result: "ok" }),
].join("\n");

describe("U5 — sandbox env allowlist wired through the gemini-local provider-sandbox call site", () => {
  // Wave 2 review (CONFIRMED regression): pre-fix, gemini-local's execute()
  // passed NO `sandboxProvider` to runAdapterExecutionTargetProcess, so
  // buildSandboxEnvAllowlist resolved provider:"" and dropped
  // GEMINI_API_KEY/GOOGLE_API_KEY on every sandboxed gemini run — the CLI in
  // the VM had no credential and failed to authenticate. This test fails
  // pre-fix (GEMINI_API_KEY/GOOGLE_API_KEY absent) and passes post-fix.
  it("drops DATABASE_URL + AOA_SECRETS_MASTER_KEY from the runner's env while keeping GEMINI_API_KEY + GOOGLE_API_KEY + AOA_API_KEY", async () => {
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
      runId: "run-gemini-allowlist",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Gemini Coder",
        adapterType: "gemini_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "gemini",
        env: {
          // NEVER-in-VM infra secrets — must not survive even though the
          // caller's overlay carries them.
          DATABASE_URL: "postgres://leak",
          AOA_SECRETS_MASTER_KEY: "leaked-master-key",
          // Legitimate credentials for a gemini-provider run.
          GEMINI_API_KEY: "test-gemini-key",
          GOOGLE_API_KEY: "test-google-key",
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
        command: "gemini",
        installCommand: "npm install -g @google/gemini-cli",
      },
      // authToken flows into env.AOA_API_KEY when no explicit key is configured
      // (see execute.ts's `hasExplicitApiKey` branch) — this is the run-JWT.
      authToken: "secret-run-token",
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(providerInputs.length).toBeGreaterThan(0);
    const runInput = providerInputs[0];

    // NEVER-in-VM secrets absent.
    expect(runInput.env.DATABASE_URL).toBeUndefined();
    expect(runInput.env.AOA_SECRETS_MASTER_KEY).toBeUndefined();

    // Legitimate credentials present — this is the regression assertion.
    expect(runInput.env.GEMINI_API_KEY).toBe("test-gemini-key");
    expect(runInput.env.GOOGLE_API_KEY).toBe("test-google-key");
    expect(runInput.env.AOA_API_KEY).toBe("secret-run-token");
  });
});
