import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterTargetProcessOptions } from "@armyofagents/adapter-utils/execution-target";

/**
 * Local-target probe tests for the ambient-key strip.
 *
 * The concern (T2 review): Settings → Providers reports "anthropic verified"
 * off an ambient server-process ANTHROPIC_API_KEY, but a crew run STRIPS that
 * key (ambient-config.ts, D9/T2) and authenticates from the copied
 * `.credentials.json` instead — so readiness could go green via a path no real
 * run takes. The fix mirrors codex: the probe passes
 * `unsetEnvKeys: ["ANTHROPIC_API_KEY"]` at both spawn sites so it authenticates
 * from the SAME source a crew run does.
 *
 * These drive the LOCAL execution path, so the execution-target module is mocked
 * (a real local spawn would shell out to `claude`). The mock is file-local — the
 * provider-sandbox tests in test.test.ts keep the real module.
 */

const spawnCalls: { target: unknown; opts: AdapterTargetProcessOptions }[] = [];
let helloResult: { exitCode: number; stdout: string; stderr?: string; timedOut?: boolean };
let statusResult: { exitCode: number; stdout: string; stderr?: string; timedOut?: boolean };

vi.mock("@armyofagents/adapter-utils/execution-target", async (importActual) => {
  const actual = await importActual<
    typeof import("@armyofagents/adapter-utils/execution-target")
  >();
  return {
    ...actual,
    // Succeed silently so `canRunProbe` stays true regardless of whether the
    // `claude` CLI is installed on the test host.
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    runAdapterExecutionTargetProcess: vi.fn(
      async (target: unknown, opts: AdapterTargetProcessOptions) => {
        spawnCalls.push({ target, opts });
        const isStatus = opts.args.includes("auth") && opts.args.includes("status");
        const r = isStatus ? statusResult : helloResult;
        return {
          exitCode: r.exitCode,
          signal: null,
          timedOut: r.timedOut ?? false,
          stdout: r.stdout,
          stderr: r.stderr ?? "",
        };
      },
    ),
  };
});

// Imported AFTER the mock is registered (vi.mock is hoisted above imports).
const { testEnvironment } = await import("./test.js");

function heartbeatLine(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

function helloStdout(resultFields: Record<string, unknown>): string {
  return [
    heartbeatLine({ type: "system", subtype: "init", session_id: "s", model: "claude-test" }),
    heartbeatLine({
      type: "result",
      subtype: "success",
      session_id: "s",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
      total_cost_usd: 0,
      ...resultFields,
    }),
  ].join("\n");
}

const HELLO_OK = { exitCode: 0, stdout: helloStdout({ is_error: false, result: "hello" }) };
const HELLO_REVOKED = {
  exitCode: 1,
  stdout: helloStdout({
    is_error: true,
    api_error_status: 401,
    result:
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
  }),
};

function helloSpawn() {
  return spawnCalls.find((c) => c.opts.args.includes("--print"));
}
function statusSpawn() {
  return spawnCalls.find((c) => c.opts.args.includes("auth") && c.opts.args.includes("status"));
}

describe("claude_local testEnvironment — ambient ANTHROPIC_API_KEY strip (local target)", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    spawnCalls.length = 0;
    helloResult = HELLO_OK;
    statusResult = { exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) };
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  });

  it("strips the ambient ANTHROPIC_API_KEY from the hello probe so it can't pass via a key crew discards", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ambient-only";
    helloResult = HELLO_OK;

    const result = await testEnvironment({
      adapterType: "claude_local",
      companyId: "company-1",
      config: { command: "claude", env: {} },
    });

    // The load-bearing fix: the ambient key is stripped at the spawn.
    expect(helloSpawn()?.opts.unsetEnvKeys).toEqual(["ANTHROPIC_API_KEY"]);
    // And the diagnostic no longer claims the ambient key will be used.
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "claude_anthropic_api_key_server_env_only" }),
    );
    expect(
      result.checks.some((c) => c.code === "claude_anthropic_api_key_overrides_subscription"),
    ).toBe(false);
  });

  it("keeps an adapter-config (overlay) ANTHROPIC_API_KEY as a real auth source", async () => {
    // No ambient key; the operator configured one on the agent's adapterConfig.env.
    const result = await testEnvironment({
      adapterType: "claude_local",
      companyId: "company-1",
      config: { command: "claude", env: { ANTHROPIC_API_KEY: "sk-agent-configured" } },
    });

    // Overlay key survives the strip (mergeChildEnv overlay-wins); the probe still
    // requests the strip of the AMBIENT key — the two do not conflict.
    expect(helloSpawn()?.opts.unsetEnvKeys).toEqual(["ANTHROPIC_API_KEY"]);
    // Reported as a genuine API-key auth source (a crew run honours it too).
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "claude_anthropic_api_key_overrides_subscription" }),
    );
    expect(
      result.checks.some((c) => c.code === "claude_anthropic_api_key_server_env_only"),
    ).toBe(false);
  });

  it("strips the ambient key from the auth-status probe too", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ambient-only";
    helloResult = HELLO_REVOKED;
    statusResult = { exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) };

    const result = await testEnvironment({
      adapterType: "claude_local",
      companyId: "company-1",
      config: { command: "claude", env: {} },
    });

    // Both spawns read the SAME credential store — neither sees the ambient key.
    expect(statusSpawn()?.opts.unsetEnvKeys).toEqual(["ANTHROPIC_API_KEY"]);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "claude_hello_probe_auth_required" }),
    );
  });
});
