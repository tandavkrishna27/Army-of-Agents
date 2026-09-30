/**
 * W5c Task 7 — routing + result-assembly tests for the dual-path codex execute.
 *
 * These exercise the PATH SELECTION (exec vs. bridged app-server) and the shared
 * result builder WITHOUT a real codex process:
 *   - the bridged path is injected via `deps.runAppServerTurn` (a spy), so no
 *     `codex app-server` child is spawned;
 *   - the exec path runs the fake `codex` script (same technique as
 *     execute-target.test.ts).
 *
 * Coverage:
 *   1. flag true + local target       → bridged runner invoked.
 *   2. flag false/absent + broker set  → exec path (the P1-miswire regression:
 *                                        routing MUST NOT key off broker presence).
 *   3. flag true + non-local target    → exec path + warn.
 *   4. bypass flag on bridged path      → warn + not bypassed.
 *   5. bridged DriverResult → AdapterExecutionResult carries signal/errorCode/
 *      outputFiles + session fields; exec attempt preserves `signal`.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute, type CodexExecuteDeps } from "../server/execute.js";
import type { DriverResult } from "../server/app-server/driver.js";
import type { RunAppServerTurnInput } from "../server/execute-app-server.js";
import type {
  AdapterExecutionContext,
  AdapterRuntimeDecisionBroker,
  AdapterProviderSandboxRunInput,
} from "@armyofagents/adapter-utils";

async function writeFakeCodexCommand(commandBase: string): Promise<string> {
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-exec" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 } }));
`;
  const jsPath = commandBase + ".js";
  await fs.writeFile(jsPath, script, "utf8");
  await fs.chmod(jsPath, 0o755);
  if (process.platform === "win32") {
    const cmdPath = commandBase + ".cmd";
    await fs.writeFile(cmdPath, `@node "%~dp0${path.basename(jsPath)}" %*\r\n`, "utf8");
    return cmdPath;
  }
  await fs.writeFile(commandBase, script, "utf8");
  await fs.chmod(commandBase, 0o755);
  return commandBase;
}

/** A no-op broker — present on every run; its mere presence must NOT enable routing. */
const dummyBroker: AdapterRuntimeDecisionBroker = {
  requestPermission: async () => {
    throw new Error("should not be called");
  },
  requestPermissionBounded: async () => ({ timedOut: true }),
  askWorkQuestion: async () => {
    throw new Error("should not be called");
  },
};

/** A typed bridged-runner spy so `.mock.calls[0][0]` is a RunAppServerTurnInput. */
function makeRunAppServerTurnSpy(result: () => Promise<DriverResult>) {
  return vi.fn<(input: RunAppServerTurnInput) => Promise<DriverResult>>(result);
}

function makeDriverResult(over: Partial<DriverResult> = {}): DriverResult {
  return {
    summary: "bridged summary",
    usage: { inputTokens: 5, outputTokens: 7, cachedInputTokens: 2 },
    errorMessage: null,
    errorCode: null,
    sessionId: "codex-thread-bridged",
    timedOut: false,
    clearSession: false,
    outputFiles: ["src/a.ts", "src/b.ts"],
    ...over,
  };
}

async function withWorkspace<T>(
  fn: (workspace: string, commandPath: string) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-routing-"));
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  await fs.mkdir(workspace, { recursive: true });
  const commandPath = await writeFakeCodexCommand(path.join(root, "agent"));
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return await fn(workspace, commandPath);
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function baseCtx(
  workspace: string,
  commandPath: string,
  over: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
  return {
    runId: "run-routing",
    agent: { id: "agent-1", companyId: "company-1", name: "Codex", adapterType: "codex_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: commandPath, cwd: workspace, timeoutSec: 10, graceSec: 1 },
    context: {},
    executionTarget: { type: "local" },
    runtimeCommandSpec: { command: "codex", installCommand: "do-not-run" },
    authToken: "secret-run-token",
    onLog: async () => {},
    ...over,
  };
}

describe("codex execute — runtime-decision path routing", () => {
  it("flag true + local target → invokes the bridged runner (not exec)", async () => {
    await withWorkspace(async (workspace, commandPath) => {
      const runAppServerTurn = makeRunAppServerTurnSpy(async () => makeDriverResult());
      const deps: CodexExecuteDeps = { runAppServerTurn };
      const result = await execute(
        baseCtx(workspace, commandPath, {
          runtimeDecisionRoutingEnabled: true,
          runtimeDecisionBroker: dummyBroker,
        }),
        deps,
      );
      expect(runAppServerTurn).toHaveBeenCalledTimes(1);
      expect(result.summary).toBe("bridged summary");
      expect(result.sessionId).toBe("codex-thread-bridged");
      // the broker flowed through to the bridged runner
      expect(runAppServerTurn.mock.calls[0][0].broker).toBe(dummyBroker);
    });
  });

  it("flag ABSENT but broker present → exec path (P1 miswire regression)", async () => {
    await withWorkspace(async (workspace, commandPath) => {
      const runAppServerTurn = vi.fn(async () => makeDriverResult());
      const deps: CodexExecuteDeps = { runAppServerTurn };
      const result = await execute(
        // Broker present (as on EVERY run) but routing flag unset.
        baseCtx(workspace, commandPath, { runtimeDecisionBroker: dummyBroker }),
        deps,
      );
      expect(runAppServerTurn).not.toHaveBeenCalled();
      // exec fake produced this session id
      expect(result.sessionId).toBe("codex-session-exec");
      expect(result.exitCode).toBe(0);
    });
  });

  it("flag explicitly false + broker present → exec path", async () => {
    await withWorkspace(async (workspace, commandPath) => {
      const runAppServerTurn = vi.fn(async () => makeDriverResult());
      const result = await execute(
        baseCtx(workspace, commandPath, {
          runtimeDecisionRoutingEnabled: false,
          runtimeDecisionBroker: dummyBroker,
        }),
        { runAppServerTurn },
      );
      expect(runAppServerTurn).not.toHaveBeenCalled();
      expect(result.sessionId).toBe("codex-session-exec");
    });
  });

  it("flag true + NON-local target → exec (provider-sandbox) path + warn", async () => {
    const logs: string[] = [];
    const providerRunner = {
      execute: vi.fn(async (_input: AdapterProviderSandboxRunInput) => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: "",
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "codex-session-remote" }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 } }),
        ].join("\n"),
      })),
    };
    await withWorkspace(async (workspace) => {
      const runAppServerTurn = vi.fn(async () => makeDriverResult());
      const result = await execute(
        {
          runId: "run-remote",
          agent: { id: "agent-1", companyId: "company-1", name: "Codex", adapterType: "codex_local", adapterConfig: {} },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: { command: "codex", timeoutSec: 10, graceSec: 1 },
          context: {},
          executionTarget: {
            type: "provider-sandbox",
            provider: "e2b",
            providerLeaseId: "lease-1",
            remoteCwd: "/home/user/aoa-workspace",
            shell: "bash",
            runner: providerRunner,
          },
          runtimeCommandSpec: { command: "codex", installCommand: "npm i -g @openai/codex" },
          authToken: "secret",
          runtimeDecisionRoutingEnabled: true,
          runtimeDecisionBroker: dummyBroker,
          onLog: async (_stream, chunk) => {
            logs.push(chunk);
          },
        },
        { runAppServerTurn },
      );
      // Bridged runner NOT used; the remote exec runner was.
      expect(runAppServerTurn).not.toHaveBeenCalled();
      expect(providerRunner.execute).toHaveBeenCalledTimes(1);
      expect(result.exitCode).toBe(0);
      expect(logs.join("")).toContain("supervision needs a local target");
    });
  });

  it("bypass flag on the bridged path → warns and does NOT bypass", async () => {
    const logs: string[] = [];
    await withWorkspace(async (workspace, commandPath) => {
      const runAppServerTurn = makeRunAppServerTurnSpy(async () => makeDriverResult());
      await execute(
        baseCtx(workspace, commandPath, {
          config: {
            command: commandPath,
            cwd: workspace,
            timeoutSec: 10,
            graceSec: 1,
            dangerouslyBypassApprovalsAndSandbox: true,
          },
          runtimeDecisionRoutingEnabled: true,
          runtimeDecisionBroker: dummyBroker,
          onLog: async (_s, chunk) => {
            logs.push(chunk);
          },
        }),
        { runAppServerTurn },
      );
      expect(runAppServerTurn).toHaveBeenCalledTimes(1);
      // The behavioral guarantee that bypass is ignored: a warning is emitted on
      // the bridged path. (The runner hard-codes approvalPolicy "untrusted"
      // internally — verified where the real runner drives the client, not here
      // where it is stubbed; RunAppServerTurnInput has no bypass field to inspect.)
      expect(logs.join("")).toContain("Ignoring config.dangerouslyBypassApprovalsAndSandbox");
    });
  });
});

describe("codex execute — result assembly parity", () => {
  it("bridged DriverResult → result carries signal, errorCode, outputFiles + session fields", async () => {
    await withWorkspace(async (workspace, commandPath) => {
      const runAppServerTurn = vi.fn(async () =>
        makeDriverResult({
          summary: "done",
          errorMessage: "boom",
          errorCode: "turn_failed",
          outputFiles: ["out/x.txt"],
          sessionId: "thread-xyz",
        }),
      );
      const result = await execute(
        baseCtx(workspace, commandPath, {
          runtimeDecisionRoutingEnabled: true,
          runtimeDecisionBroker: dummyBroker,
        }),
        { runAppServerTurn },
      );
      // session fields
      expect(result.sessionId).toBe("thread-xyz");
      expect(result.sessionDisplayId).toBe("thread-xyz");
      expect(result.sessionParams).toMatchObject({ sessionId: "thread-xyz", cwd: expect.any(String) });
      // new fields reproduced by the shared builder
      expect(result.errorCode).toBe("turn_failed");
      expect(result.errorMessage).toBe("boom");
      // execute.ts normalizes hint paths to absolute (path.resolve(cwd, p)).
      expect(result.outputFiles).toEqual([{ path: path.resolve(workspace, "out/x.txt") }]);
      // a supervised turn is not an OS process → signal is null (present, preserved)
      expect(result.signal).toBeNull();
      expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7, cachedInputTokens: 2 });
      // errored turn → non-zero exit code sentinel
      expect(result.exitCode).toBe(1);
    });
  });

  it("bridged timeout DriverResult → minimal timeout result (clearSession passthrough)", async () => {
    await withWorkspace(async (workspace, commandPath) => {
      const runAppServerTurn = vi.fn(async () =>
        makeDriverResult({ timedOut: true, sessionId: null, clearSession: true }),
      );
      const result = await execute(
        baseCtx(workspace, commandPath, {
          runtimeDecisionRoutingEnabled: true,
          runtimeDecisionBroker: dummyBroker,
        }),
        { runAppServerTurn },
      );
      expect(result.timedOut).toBe(true);
      expect(result.errorMessage).toContain("Timed out after");
      expect(result.clearSession).toBe(true);
    });
  });

  it("exec path preserves `signal` from the child process", async () => {
    await withWorkspace(async (workspace, commandPath) => {
      const result = await execute(baseCtx(workspace, commandPath), {
        runAppServerTurn: vi.fn(async () => makeDriverResult()),
      });
      // fake exits cleanly → signal null (the field is present + preserved)
      expect(result.signal).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe("codex-session-exec");
    });
  });
});
