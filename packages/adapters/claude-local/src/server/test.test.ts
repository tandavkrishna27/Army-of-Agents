import { describe, expect, it, vi } from "vitest";
import type { AdapterProviderSandboxRunInput } from "@armyofagents/adapter-utils";
import { testEnvironment } from "./test.js";

type FakeRun = { exitCode: number; stdout: string; stderr?: string; timedOut?: boolean };

function heartbeatLine(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

/** Builds realistic `claude --output-format stream-json` output for a failed hello probe. */
function failedHelloStdout(resultFields: Record<string, unknown>): string {
  return [
    heartbeatLine({ type: "system", subtype: "init", session_id: "claude-session-x", model: "claude-test" }),
    heartbeatLine({
      type: "result",
      subtype: "success",
      session_id: "claude-session-x",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
      total_cost_usd: 0,
      ...resultFields,
    }),
  ].join("\n");
}

async function runProbeWith(opts: { hello: FakeRun; authStatus: FakeRun }) {
  const runner = {
    execute: vi.fn(async (input: AdapterProviderSandboxRunInput) => {
      if (input.args.includes("auth") && input.args.includes("status")) {
        const r = opts.authStatus;
        return { exitCode: r.exitCode, signal: null, timedOut: r.timedOut ?? false, stdout: r.stdout, stderr: r.stderr ?? "" };
      }
      if (input.args.includes("--print")) {
        const r = opts.hello;
        return { exitCode: r.exitCode, signal: null, timedOut: r.timedOut ?? false, stdout: r.stdout, stderr: r.stderr ?? "" };
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    }),
  };
  const result = await testEnvironment({
    adapterType: "claude_local",
    companyId: "company-1",
    config: { command: "claude", env: {} },
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
    return input.args.includes("auth") && input.args.includes("status");
  });
}

describe("claude_local testEnvironment — auth_required vs auth_expired", () => {
  // Field evidence from a real revoked-token run: `subtype` misleadingly says
  // "success" even though `is_error` is true — the probe must not trust it.
  const REVOKED_HELLO: FakeRun = {
    exitCode: 1,
    stdout: failedHelloStdout({
      is_error: true,
      api_error_status: 401,
      result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}',
    }),
  };

  it("emits claude_hello_probe_auth_expired with the account when status is logged in", async () => {
    const { result, runner } = await runProbeWith({
      hello: REVOKED_HELLO,
      authStatus: { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, email: "ada@example.com", authMethod: "claude.ai" }) },
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_hello_probe_auth_expired",
        message: expect.stringContaining("ada@example.com"),
      }),
    );
    expect(result.checks.some((c) => c.code === "claude_hello_probe_failed")).toBe(false);
    expect(calledAuthStatus(runner)).toBe(true);
  });

  it("emits claude_hello_probe_auth_required when status is logged out", async () => {
    const { result } = await runProbeWith({
      hello: REVOKED_HELLO,
      authStatus: { exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) },
    });

    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_hello_probe_auth_required" }));
    expect(result.checks.some((c) => c.code === "claude_hello_probe_auth_expired")).toBe(false);
  });

  it("degrades to auth_required, without throwing, when the status command is unavailable", async () => {
    const { result } = await runProbeWith({
      hello: REVOKED_HELLO,
      authStatus: { exitCode: 1, stdout: "error: unknown command 'auth'" },
    });

    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_hello_probe_auth_required" }));
    expect(result.checks.some((c) => c.code === "claude_hello_probe_failed")).toBe(false);
  });

  it("uses the account-less message when status is logged in but has no email", async () => {
    const { result } = await runProbeWith({
      hello: REVOKED_HELLO,
      authStatus: { exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) },
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_hello_probe_auth_expired",
        message: "Your Claude sign-in has expired or been revoked.",
      }),
    );
  });

  it("emits claude_hello_probe_failed for a non-auth failure and never spawns the status probe", async () => {
    const { result, runner } = await runProbeWith({
      hello: {
        exitCode: 1,
        stdout: failedHelloStdout({
          is_error: true,
          api_error_status: 500,
          result: "API Error: 500 internal server error",
        }),
      },
      authStatus: { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, email: "unused@example.com" }) },
    });

    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_hello_probe_failed" }));
    expect(calledAuthStatus(runner)).toBe(false);
  });

  it("passes as before on a successful hello probe, without spawning the status probe", async () => {
    const { result, runner } = await runProbeWith({
      hello: {
        exitCode: 0,
        stdout: failedHelloStdout({ is_error: false, api_error_status: null, result: "hello" }),
      },
      authStatus: { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, email: "unused@example.com" }) },
    });

    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_hello_probe_passed" }));
    expect(calledAuthStatus(runner)).toBe(false);
  });
});

describe("claude_local testEnvironment", () => {
  it("probes provider-sandbox targets through the selected environment", async () => {
    const providerInputs: AdapterProviderSandboxRunInput[] = [];
    const providerRunner = {
      execute: vi.fn(async (input: AdapterProviderSandboxRunInput) => {
        providerInputs.push(input);
        if (input.args.includes("--print")) {
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
                type: "result",
                subtype: "success",
                session_id: "claude-session-1",
                result: "hello",
                usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
                total_cost_usd: 0,
              }),
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
      adapterType: "claude_local",
      companyId: "company-1",
      config: {
        command: "claude",
        env: { ANTHROPIC_API_KEY: "test-anthropic-key" },
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

    expect(result.status).toBe("warn");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_environment_target",
        message: "Probing inside environment: E2B Cloud QA",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_hello_probe_passed",
      }),
    );
    const runInput = providerInputs.find((input) => input.args.includes("--print"));
    expect(runInput).toBeDefined();
    expect(runInput).toMatchObject({
      command: "bash",
      cwd: "/home/user/aoa-workspace",
      env: { ANTHROPIC_API_KEY: "test-anthropic-key" },
    });
  });
});
