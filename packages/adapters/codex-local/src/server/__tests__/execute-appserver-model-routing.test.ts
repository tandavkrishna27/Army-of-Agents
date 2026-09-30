/**
 * BUG-6 fix 1 — supervised chat-model routing on the bridged codex app-server path.
 *
 * Proves `execute` resolves a codex-compatible chat model and threads it (plus
 * the managed CODEX_HOME) into `runAppServerTurn` so it lands in config.toml:
 *   - empty config model (subscription auth) → resolves the safe default gpt-5.5;
 *   - a codex-compatible config model passes through unchanged;
 *   - api-key mode (OPENAI_API_KEY present) leaves `model` undefined so a valid
 *     api-key model is never forced/rewritten.
 *
 * Uses the same full-`execute` harness as execute-routing.test.ts: a real,
 * resolvable fake `codex` command (satisfies ensureCommandResolvable) + a temp
 * CODEX_HOME (satisfies prepareManagedCodexHome) + an injected runAppServerTurn
 * spy (no real app-server child spawns). The bridged path is selected via
 * runtimeDecisionRoutingEnabled + a local execution target.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute, type CodexExecuteDeps } from "../execute.js";
import type { DriverResult } from "../app-server/driver.js";
import type { RunAppServerTurnInput } from "../execute-app-server.js";
import type {
  AdapterExecutionContext,
  AdapterRuntimeDecisionBroker,
} from "@armyofagents/adapter-utils";

async function writeFakeCodexCommand(commandBase: string): Promise<string> {
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-exec" }));
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

/** No-op broker — present on every run; must NOT itself enable routing. */
const dummyBroker: AdapterRuntimeDecisionBroker = {
  requestPermission: async () => {
    throw new Error("should not be called");
  },
  requestPermissionBounded: async () => ({ timedOut: true }),
  askWorkQuestion: async () => {
    throw new Error("should not be called");
  },
};

function makeSpy() {
  return vi.fn<(input: RunAppServerTurnInput) => Promise<DriverResult>>(async () => ({
    summary: "ok",
    usage: null,
    errorMessage: null,
    errorCode: null,
    sessionId: "t1",
    timedOut: false,
    clearSession: false,
  }));
}

async function withWorkspace<T>(
  fn: (workspace: string, commandPath: string) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-model-routing-"));
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
  configOver: Record<string, unknown> = {},
): AdapterExecutionContext {
  return {
    runId: "run-model-routing",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: commandPath, cwd: workspace, timeoutSec: 10, graceSec: 1, ...configOver },
    context: {},
    executionTarget: { type: "local" },
    runtimeCommandSpec: { command: "codex", installCommand: "do-not-run" },
    authToken: "secret-run-token",
    runtimeDecisionRoutingEnabled: true,
    runtimeDecisionBroker: dummyBroker,
    onLog: async () => {},
  };
}

describe("execute — supervised model routing (BUG-6 fix 1)", () => {
  it("resolves gpt-5.5 for an empty config model and threads model + managedCodexHome to runAppServerTurn", async () => {
    await withWorkspace(async (workspace, commandPath) => {
      const runAppServerTurn = makeSpy();
      const deps: CodexExecuteDeps = { runAppServerTurn };
      await execute(baseCtx(workspace, commandPath, { model: "" }), deps);
      expect(runAppServerTurn).toHaveBeenCalledTimes(1);
      const arg = runAppServerTurn.mock.calls[0][0];
      expect(arg.model).toBe("gpt-5.5");
      expect(typeof arg.managedCodexHome).toBe("string");
      expect((arg.managedCodexHome as string).length).toBeGreaterThan(0);
    });
  });

  it("passes a codex-compatible config model through unchanged (gpt-4o)", async () => {
    await withWorkspace(async (workspace, commandPath) => {
      const runAppServerTurn = makeSpy();
      await execute(baseCtx(workspace, commandPath, { model: "gpt-4o" }), { runAppServerTurn });
      expect(runAppServerTurn.mock.calls[0][0].model).toBe("gpt-4o");
    });
  });

  it("leaves model undefined in api-key mode (OPENAI_API_KEY present)", async () => {
    await withWorkspace(async (workspace, commandPath) => {
      const runAppServerTurn = makeSpy();
      await execute(
        baseCtx(workspace, commandPath, {
          model: "gpt-5.3-codex",
          env: { OPENAI_API_KEY: "sk-live" },
        }),
        { runAppServerTurn },
      );
      expect(runAppServerTurn.mock.calls[0][0].model).toBeUndefined();
    });
  });
});
