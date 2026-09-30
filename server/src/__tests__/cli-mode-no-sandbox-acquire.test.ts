// W7.5d — Commander sandbox-acquire is DEPLOYMENT-MODE-GATED (inverts the Wave-2
// "never acquire" enforcement).
//
// Wave 2 deleted a dead `acquireExecutionContext` call from cli-mode's Commander
// path (it acquired a lease nothing consumed and nothing released → orphaned E2B
// VMs). This suite proved the negative unconditionally. W7.5d reroutes the
// in-sandbox CLI through `adapter.execute` on cloud, so the invariant is now
// conditional:
//   - self-hosted (local_trusted): NEVER acquires — Commander spawns host-direct.
//   - cloud (cloud_auth): ALWAYS acquires (the warm conversation lease) and
//     delegates to `runCommanderAdapterTurn` (adapter.execute), never a host spawn.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { setDeploymentMode } from "../config/deployment-mode.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Simulate production layout: mcp-bridge.js exists → command = 'node' (not 'tsx').
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn() }; // never throws → .js "exists"
});

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}));

vi.mock("@armyofagents/adapter-codex-local/server", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@armyofagents/adapter-codex-local/server")
  >();
  return {
    ...actual,
    writeCodexMcpConfigToml: vi.fn(async () => {}),
    ensureCodexAuthInHome: vi.fn(async () => true),
    readSharedCodexModel: vi.fn(async () => null),
  };
});

vi.mock("../services/mcp-connectors-loader.js", () => ({
  resolveAgentConnectors: vi.fn(async () => ({ extraMcpServers: {}, connectorEnv: {} })),
}));

// The seam under test. If cli-mode.ts calls acquireExecutionContext on the
// Commander turn path, this spy records it.
const acquireExecutionContextMock = vi
  .fn()
  .mockResolvedValue({ sandbox: null, lease: null, warmResolved: false });
vi.mock("../services/acquire-execution-context.js", () => ({
  acquireExecutionContext: acquireExecutionContextMock,
}));

// Keep commander-sandbox REAL (so the cloud block exercises the real acquire via
// resolveCommanderSandboxContext AND the real runCommanderAdapterTurn) — a partial
// mock via importOriginal loads the resolver in a separate module graph whose
// deployment-mode is not the instance the test sets, so tenantIsolationEnforced()
// would read false and no acquire would happen. Instead, stub the ADAPTER registry
// so runCommanderAdapterTurn delegates to a controlled fake execute (never a real
// in-sandbox CLI); we only assert acquire + no-host-spawn here.
const fakeAdapterExecute = vi.fn(async (ctx: any) => {
  // A single stream-json `result` frame → StreamJsonParser emits a `done`; codex
  // buffers it and parseCodexBufferedChunks appends a `done` too.
  await ctx.onLog("stdout", JSON.stringify({ type: "result", is_error: false, usage: {} }) + "\n");
  return { exitCode: 0, timedOut: false, summary: "ok", usage: { inputTokens: 0, outputTokens: 0 } };
});
vi.mock("../adapters/registry.js", () => ({
  getServerAdapter: () => ({ execute: fakeAdapterExecute }),
}));

function makeFakeProcess() {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { writable: true, write: vi.fn(), end: vi.fn(), on: vi.fn() };
  proc.kill = vi.fn();
  let driven = false;
  const drive = () => {
    if (driven) return;
    driven = true;
    setImmediate(() => {
      proc.stdout.emit("data", Buffer.from("ok"));
      proc.emit("exit", 0, null);
      proc.emit("close", 0, null);
    });
  };
  proc.stdout.on("newListener", drive);
  proc.on("newListener", (ev: string) => {
    if (ev === "exit") drive();
  });
  return proc;
}

async function runChat(
  cliTool: string,
  mode: "local_trusted" | "cloud_auth",
  paramsOverrides: Record<string, unknown> = {},
  configOverrides: Record<string, unknown> = {},
) {
  // vi.resetModules() (beforeEach) gives the dynamically-imported cli-mode a FRESH
  // deployment-mode singleton (default local_trusted); set the mode on THAT
  // instance, not the stale static import.
  (await import("../config/deployment-mode.js")).setDeploymentMode(mode);
  const cp = await import("node:child_process");
  vi.mocked(cp.execSync).mockReturnValue(`/usr/local/bin/x\n` as any);
  const fake = makeFakeProcess();
  vi.mocked(cp.spawn).mockReturnValue(fake as any);

  const { cliModeService } = await import("../services/internal-agent/cli-mode.js");
  const service = cliModeService({} as any);
  const chunks: any[] = [];
  for await (const chunk of service.chat(
    {
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      content: "hello world",
      enabledCapabilities: [],
      conversationId: "conversation-a",
      ...paramsOverrides,
    } as any,
    { cliTool, executionMode: "cli", ...configOverrides } as any,
  )) {
    chunks.push(chunk);
  }
  return { chunks, spawn: vi.mocked(cp.spawn) };
}

describe("Commander turns: sandbox-acquire is deployment-mode-gated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    acquireExecutionContextMock.mockClear();
    acquireExecutionContextMock.mockResolvedValue({ sandbox: null, lease: null, warmResolved: false });
    fakeAdapterExecute.mockClear();
  });

  describe("self-hosted (local_trusted): NEVER acquires (host-direct spawn)", () => {
    it("claude_cli: a full Commander turn spawns the CLI without ever calling acquireExecutionContext", async () => {
      const { spawn } = await runChat("claude_cli", "local_trusted", { runId: "run-1" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(acquireExecutionContextMock).not.toHaveBeenCalled();
    });

    it("codex: a full Commander turn spawns codex exec without ever calling acquireExecutionContext", async () => {
      const { spawn } = await runChat("codex", "local_trusted", { runId: "run-1" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(acquireExecutionContextMock).not.toHaveBeenCalled();
    });
  });

  describe("cloud (cloud_auth): MUST acquire + delegate to adapter.execute (NOT host spawn)", () => {
    beforeEach(() => {
      process.env.AOA_AGENT_JWT_SECRET = "test-secret";
      acquireExecutionContextMock.mockResolvedValue({
        sandbox: {
          configPatch: {
            executionTarget: {
              type: "provider-sandbox",
              provider: "e2b",
              providerLeaseId: "e2b-1",
              remoteCwd: "/workspace",
              runner: { execute: async () => ({ exitCode: 0, timedOut: false, summary: "ok" }) },
            },
          },
        },
        lease: { id: "l1", companyId: "comp1", environmentId: "env1", provider: "e2b", providerLeaseId: "e2b-1" },
        warmResolved: true,
      });
    });
    afterEach(() => setDeploymentMode("local_trusted"));

    it("claude_cli: acquires the sandbox and does NOT host-spawn", async () => {
      const { spawn } = await runChat("claude_cli", "cloud_auth", { runId: "run-1" });
      expect(acquireExecutionContextMock).toHaveBeenCalledTimes(1);
      expect(fakeAdapterExecute).toHaveBeenCalledTimes(1); // delegated to adapter.execute
      expect(spawn).not.toHaveBeenCalled(); // not host spawn
    });

    it("codex: acquires the sandbox and does NOT host-spawn", async () => {
      const { spawn } = await runChat("codex", "cloud_auth", { runId: "run-1" });
      expect(acquireExecutionContextMock).toHaveBeenCalledTimes(1);
      expect(fakeAdapterExecute).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
    });
  });
});
