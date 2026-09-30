import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "../server/execute.js";
import type {
  AdapterExecutionContext,
  AdapterProviderSandboxRunInput,
} from "@armyofagents/adapter-utils";

/**
 * U12 — operator ~/.claude provisioning must be structurally unreachable for
 * a remote/sandbox execution target. `isolateAmbientConfig` is already forced
 * false for a remote target (`ctx.isolateAmbientConfig === true &&
 * !isRemoteExecutionTarget`, execute.ts), so `operatorConfigHome` is null and
 * `provisionClaudeConfigHome` never runs — this suite proves that with a
 * SPY on the real function (via `importOriginal`, so every other
 * ambient-config export — resolveClaudeConfigHome's caller, the isolated-dir
 * helpers, etc. — stays real) rather than re-deriving the claim from the env
 * the child received (ambient-config-isolation.test.ts already does that;
 * this is the direct, function-level proof the plan asks for).
 *
 * Uses the SAME provider-sandbox executionTarget shape as
 * ambient-config-isolation.test.ts's "remote crew run" case — no real
 * `claude` binary needed, since a remote target runs through
 * `executionTarget.runner.execute(...)` instead of spawning a child process.
 */
const { provisionClaudeConfigHomeSpy } = vi.hoisted(() => ({
  provisionClaudeConfigHomeSpy: vi.fn(),
}));

vi.mock("../server/ambient-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/ambient-config.js")>();
  provisionClaudeConfigHomeSpy.mockImplementation(actual.provisionClaudeConfigHome);
  return { ...actual, provisionClaudeConfigHome: provisionClaudeConfigHomeSpy };
});

describe("U12: operator ~/.claude provisioning invariant (sandbox target)", () => {
  afterEach(() => {
    provisionClaudeConfigHomeSpy.mockClear();
  });

  it("provider-sandbox target: provisionClaudeConfigHome is NEVER called, and no per-run CLAUDE_CONFIG_DIR home is minted", async () => {
    const providerInputs: AdapterProviderSandboxRunInput[] = [];
    const providerRunner = {
      execute: vi.fn(async (input: AdapterProviderSandboxRunInput) => {
        providerInputs.push(input);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stderr: "",
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: "claude-session-1",
            result: "ok",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
            total_cost_usd: 0,
          }),
        };
      }),
    };

    const result = await execute({
      runId: "run-operator-invariant",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Scout",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", env: {}, timeoutSec: 10, graceSec: 1 },
      context: {},
      executionTarget: {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "sandbox-1",
        remoteCwd: "/home/user/aoa-workspace",
        shell: "bash",
        runner: providerRunner,
      },
      runtimeCommandSpec: null,
      // Worst case: a caller that forgot the remote short-circuit and still
      // asked for isolation — the invariant (and the pre-existing
      // isRemoteExecutionTarget gate it locks) must hold regardless.
      isolateAmbientConfig: true,
      onLog: async () => {},
    } as AdapterExecutionContext);

    expect(result.exitCode).toBe(0);
    expect(provisionClaudeConfigHomeSpy).not.toHaveBeenCalled();

    const runInput = providerInputs.find((input) => input.args.includes("--print"));
    expect(runInput).toBeDefined();
    expect(runInput!.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});
