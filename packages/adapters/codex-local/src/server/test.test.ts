import { describe, expect, it, vi } from "vitest";
import type { AdapterProviderSandboxRunInput } from "@armyofagents/adapter-utils";
import { testEnvironment } from "./test.js";

describe("codex_local testEnvironment", () => {
  it("probes provider-sandbox targets through the selected environment with remote CODEX_HOME", async () => {
    const providerInputs: AdapterProviderSandboxRunInput[] = [];
    const providerRunner = {
      execute: vi.fn(async (input: AdapterProviderSandboxRunInput) => {
        providerInputs.push(input);
        if (input.args.includes("exec")) {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stderr: "",
            stdout: [
              JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }),
              JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }),
            ].join("\n"),
          };
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stderr: "",
          stdout: "",
        };
      }),
    };

    const result = await testEnvironment({
      adapterType: "codex_local",
      companyId: "company-1",
      config: {
        command: "codex",
        env: { OPENAI_API_KEY: "test-openai-key" },
      },
      environmentName: "E2B Cloud QA",
      executionTarget: {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "sandbox-1",
        remoteCwd: "/home/user/aoa-workspace",
        shell: "bash",
        runner: providerRunner,
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_environment_target",
        message: "Probing inside environment: E2B Cloud QA",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_hello_probe_passed",
      }),
    );
    const runInput = providerInputs.find((input) => input.args.includes("exec"));
    expect(runInput).toBeDefined();
    expect(runInput!.args).toContain("--skip-git-repo-check");
    expect(runInput).toMatchObject({
      command: "bash",
      cwd: "/home/user/aoa-workspace",
      env: {
        OPENAI_API_KEY: "test-openai-key",
        CODEX_HOME: "/home/user/aoa-workspace/.aoa-codex-home",
      },
    });
    expect(runInput!.args.join("\n")).toContain("codex login --with-api-key");
  });
});

type FakeRun = { exitCode: number; stdout: string; stderr?: string; timedOut?: boolean };

/** Realistic `codex exec --json` JSONL for a failed hello probe. */
function failedHelloStdout(event: Record<string, unknown>): string {
  return JSON.stringify({ type: "error", ...event });
}

async function runProbeWith(opts: { hello: FakeRun; authStatus: FakeRun }) {
  const runner = {
    execute: vi.fn(async (input: AdapterProviderSandboxRunInput) => {
      if (input.args.includes("login") && input.args.includes("status")) {
        const r = opts.authStatus;
        return { exitCode: r.exitCode, signal: null, timedOut: r.timedOut ?? false, stdout: r.stdout, stderr: r.stderr ?? "" };
      }
      if (input.args.includes("exec")) {
        const r = opts.hello;
        return { exitCode: r.exitCode, signal: null, timedOut: r.timedOut ?? false, stdout: r.stdout, stderr: r.stderr ?? "" };
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    }),
  };
  const result = await testEnvironment({
    adapterType: "codex_local",
    companyId: "company-1",
    config: { command: "codex", env: { OPENAI_API_KEY: "test-openai-key" } },
    environmentName: "probe-test",
    executionTarget: {
      type: "provider-sandbox",
      provider: "e2b",
      providerLeaseId: "sandbox-1",
      remoteCwd: "/home/user/aoa-workspace",
      shell: "bash",
      runner,
    },
  });
  return { result, runner };
}

function calledAuthStatus(runner: { execute: ReturnType<typeof vi.fn> }): boolean {
  return runner.execute.mock.calls.some((call) => {
    const input = call[0] as AdapterProviderSandboxRunInput;
    return input.args.includes("login") && input.args.includes("status");
  });
}

describe("codex_local testEnvironment — auth_required vs auth_expired", () => {
  // Field evidence shape: a revoked/expired token surfaces as a `type: "error"`
  // JSONL event with an auth-flavored message, and a nonzero exit code.
  const REVOKED_HELLO: FakeRun = {
    exitCode: 1,
    stdout: failedHelloStdout({ message: "Unauthorized: your token has expired or been revoked" }),
  };

  it("emits codex_hello_probe_auth_expired with the auth method when status is logged in", async () => {
    const { result, runner } = await runProbeWith({
      hello: REVOKED_HELLO,
      authStatus: { exitCode: 0, stdout: "Logged in using ChatGPT" },
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_hello_probe_auth_expired",
        message: expect.stringContaining("ChatGPT"),
      }),
    );
    expect(result.checks.some((c) => c.code === "codex_hello_probe_failed")).toBe(false);
    expect(calledAuthStatus(runner)).toBe(true);
  });

  it("emits codex_hello_probe_auth_required when status is logged out", async () => {
    const { result } = await runProbeWith({
      hello: REVOKED_HELLO,
      authStatus: { exitCode: 0, stdout: "Not logged in" },
    });

    expect(result.checks).toContainEqual(expect.objectContaining({ code: "codex_hello_probe_auth_required" }));
    expect(result.checks.some((c) => c.code === "codex_hello_probe_auth_expired")).toBe(false);
  });

  it("degrades to auth_required, without throwing, when the status command is unavailable", async () => {
    const { result } = await runProbeWith({
      hello: REVOKED_HELLO,
      authStatus: { exitCode: 1, stdout: "error: unknown command 'login'" },
    });

    expect(result.checks).toContainEqual(expect.objectContaining({ code: "codex_hello_probe_auth_required" }));
    expect(result.checks.some((c) => c.code === "codex_hello_probe_failed")).toBe(false);
  });

  it("spawns the status probe against the SAME CODEX_HOME as the hello probe, not the bare env", async () => {
    const { runner } = await runProbeWith({
      hello: REVOKED_HELLO,
      authStatus: { exitCode: 0, stdout: "Logged in using ChatGPT" },
    });

    const helloCall = runner.execute.mock.calls.find((call) =>
      (call[0] as AdapterProviderSandboxRunInput).args.includes("exec"),
    );
    const statusCall = runner.execute.mock.calls.find((call) => {
      const input = call[0] as AdapterProviderSandboxRunInput;
      return input.args.includes("login") && input.args.includes("status");
    });

    expect(helloCall).toBeDefined();
    expect(statusCall).toBeDefined();
    const helloEnv = (helloCall![0] as AdapterProviderSandboxRunInput).env;
    const statusEnv = (statusCall![0] as AdapterProviderSandboxRunInput).env;

    // The hello probe reads auth from the managed (per-agent; the probe uses the
    // reserved CODEX_ENV_TEST_AGENT_ID slot) CODEX_HOME
    // (prepareManagedCodexHome), NOT the founder's personal ~/.codex. The
    // status probe that follows a failed hello probe must read the SAME
    // store — otherwise it reports on the wrong credentials entirely.
    expect(statusEnv.CODEX_HOME).toBeTruthy();
    expect(statusEnv.CODEX_HOME).toBe(helloEnv.CODEX_HOME);
  });

  it("emits codex_hello_probe_failed for a non-auth failure and never spawns the status probe", async () => {
    const { result, runner } = await runProbeWith({
      hello: {
        exitCode: 1,
        stdout: failedHelloStdout({ message: "API Error: 500 internal server error" }),
      },
      authStatus: { exitCode: 0, stdout: "Logged in using ChatGPT" },
    });

    expect(result.checks).toContainEqual(expect.objectContaining({ code: "codex_hello_probe_failed" }));
    expect(calledAuthStatus(runner)).toBe(false);
  });

  it("does not classify a non-auth failure as auth just because the agent transcript mentions 401", async () => {
    // Reproduces the reviewer's finding: a sandbox-denied failure whose
    // agent_message transcript happens to discuss "401 Unauthorized" (e.g.
    // describing code it wrote) must not be misread as an auth failure. Only
    // the structured `error` event (-> parsed.errorMessage) and stderr are
    // legitimate process-failure evidence; the transcript is agent-authored
    // content and is explicitly excluded by the shared detector's input
    // contract (auth-failure-detector.ts).
    const { result, runner } = await runProbeWith({
      hello: {
        exitCode: 1,
        stdout: [
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "I added a handler returning 401 Unauthorized for missing sessions." },
          }),
          JSON.stringify({ type: "error", message: "sandbox denied write access to /etc/hosts" }),
        ].join("\n"),
      },
      authStatus: { exitCode: 0, stdout: "Logged in using ChatGPT" },
    });

    expect(result.checks).toContainEqual(expect.objectContaining({ code: "codex_hello_probe_failed" }));
    expect(result.checks.some((c) => c.code === "codex_hello_probe_auth_expired")).toBe(false);
    expect(result.checks.some((c) => c.code === "codex_hello_probe_auth_required")).toBe(false);
    expect(calledAuthStatus(runner)).toBe(false);
  });

  it("still classifies the genuine revoked-codex case as auth once stdout is excluded from evidence", async () => {
    // Guards the fix in the test above: the real signal for a revoked/expired
    // token lives in the structured `error` event (-> parsed.errorMessage),
    // not the transcript, so dropping probe.stdout from the evidence must not
    // regress true-positive detection.
    const { result, runner } = await runProbeWith({
      hello: REVOKED_HELLO,
      authStatus: { exitCode: 0, stdout: "Logged in using ChatGPT" },
    });

    expect(result.checks).toContainEqual(expect.objectContaining({ code: "codex_hello_probe_auth_expired" }));
    expect(calledAuthStatus(runner)).toBe(true);
  });

  it("passes as before on a successful hello probe, without spawning the status probe", async () => {
    const { result, runner } = await runProbeWith({
      hello: {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }),
        ].join("\n"),
      },
      authStatus: { exitCode: 0, stdout: "Logged in using ChatGPT" },
    });

    expect(result.checks).toContainEqual(expect.objectContaining({ code: "codex_hello_probe_passed" }));
    expect(calledAuthStatus(runner)).toBe(false);
  });
});
