// W7.5d — cloud Commander turn reroute + ATOMIC release (F2).
//
// On cloud_auth, a Commander turn delegates the in-sandbox CLI to
// `runCommanderAdapterTurn` (adapter.execute), NOT a host spawn, and the warm
// lease is released EXACTLY ONCE on every post-acquire exit — normal completion,
// throw, guard-refuse, and host-detect-bypass. commander-sandbox.js is mocked so
// the acquire/JWT/turn/release are observable spies (no live sandbox required).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { setDeploymentMode } from "../config/deployment-mode.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn() };
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

// The reroute seam — fully mocked so acquire/JWT/turn/release are spies.
const resolveCommanderSandboxContextMock = vi.fn();
const runCommanderAdapterTurnMock = vi.fn();
vi.mock("../services/internal-agent/commander-sandbox.js", () => ({
  resolveCommanderSandboxContext: resolveCommanderSandboxContextMock,
  runCommanderAdapterTurn: runCommanderAdapterTurnMock,
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

const doneChunk = {
  kind: "chunk" as const,
  chunk: {
    type: "done",
    summary: { runId: "", toolsCalled: [], durationMs: 0, costCents: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 } },
  },
};

function providerSandboxContext(release: () => Promise<void>) {
  return {
    executionTarget: {
      type: "provider-sandbox",
      provider: "e2b",
      providerLeaseId: "e2b-1",
      remoteCwd: "/workspace",
      runner: { execute: vi.fn() },
    },
    authToken: "commander-jwt",
    apiBaseUrl: "http://api",
    release,
  };
}

async function runChat(cliTool: string, paramsOverrides: Record<string, unknown> = {}) {
  // vi.resetModules() (beforeEach) gives us a FRESH deployment-mode singleton for
  // the dynamically-imported cli-mode; set the mode on THAT instance (the static
  // top-level import points at a stale pre-reset instance).
  (await import("../config/deployment-mode.js")).setDeploymentMode("cloud_auth");
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
      runId: "run-1",
      ...paramsOverrides,
    } as any,
    { cliTool, executionMode: "cli" } as any,
  )) {
    chunks.push(chunk);
  }
  return { chunks, spawn: vi.mocked(cp.spawn), execSync: vi.mocked(cp.execSync) };
}

describe("W7.5d cloud Commander reroute + atomic release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    setDeploymentMode("cloud_auth");
    process.env.AOA_AGENT_JWT_SECRET = "test-secret";
    // The guard-refuse test relies on the opt-in being ABSENT so a refused target
    // actually throws (otherwise the override permits it process-wide).
    delete process.env.AOA_ALLOW_UNSANDBOXED_MULTITENANT;
    resolveCommanderSandboxContextMock.mockReset();
    runCommanderAdapterTurnMock.mockReset();
  });
  afterEach(() => setDeploymentMode("local_trusted"));

  it("claude_cli: delegates to adapter.execute (NOT host spawn) and releases exactly once", async () => {
    const release = vi.fn(async () => {});
    resolveCommanderSandboxContextMock.mockResolvedValue(providerSandboxContext(release));
    runCommanderAdapterTurnMock.mockImplementation(async function* () {
      yield { kind: "chunk", chunk: { type: "text", delta: "hi" } };
      yield doneChunk;
      yield { kind: "result", result: { exitCode: 0, timedOut: false, summary: "hi" } };
    });

    const { chunks, spawn } = await runChat("claude_cli");
    expect(resolveCommanderSandboxContextMock).toHaveBeenCalledTimes(1);
    expect(runCommanderAdapterTurnMock).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(chunks.some((c: any) => c.type === "text" && c.delta === "hi")).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("passes the provider-sandbox target + commander JWT (brokered) to runCommanderAdapterTurn — never DATABASE_URL", async () => {
    const release = vi.fn(async () => {});
    resolveCommanderSandboxContextMock.mockResolvedValue(providerSandboxContext(release));
    runCommanderAdapterTurnMock.mockImplementation(async function* () {
      yield doneChunk;
      yield { kind: "result", result: { exitCode: 0, timedOut: false } };
    });

    await runChat("claude_cli");
    const turnInput = runCommanderAdapterTurnMock.mock.calls[0][1];
    expect(turnInput.executionTarget.type).toBe("provider-sandbox");
    expect(turnInput.authToken).toBe("commander-jwt");
    expect(turnInput.mcpParams.brokered).toBe(true);
    expect(turnInput.mcpParams.apiBaseUrl).toBe("http://api");
    // The brokered aoa entry never carries DATABASE_URL — a run-JWT is the identity.
    expect(JSON.stringify(turnInput.mcpParams)).not.toContain("DATABASE_URL");
  });

  it("releases the lease exactly once when the in-sandbox turn THROWS (surfaced, not swallowed)", async () => {
    const release = vi.fn(async () => {});
    resolveCommanderSandboxContextMock.mockResolvedValue(providerSandboxContext(release));
    runCommanderAdapterTurnMock.mockImplementation(async function* () {
      throw new Error("VM boom");
      // eslint-disable-next-line no-unreachable
      yield doneChunk;
    });

    const { chunks, spawn } = await runChat("claude_cli");
    expect(chunks.some((c: any) => c.type === "error")).toBe(true); // surfaced
    expect(release).toHaveBeenCalledTimes(1); // finally ran exactly once
    expect(spawn).not.toHaveBeenCalled();
  });

  it("releases the lease when the D1 guard REFUSES the resolved target (guard-refuse early return)", async () => {
    const release = vi.fn(async () => {});
    // A docker-family target is refused on cloud without the opt-in — drive the
    // guard-refuse branch and assert the lease is released before the early return.
    resolveCommanderSandboxContextMock.mockResolvedValue({
      executionTarget: { type: "sandbox-docker", image: "x" },
      authToken: "commander-jwt",
      apiBaseUrl: "http://api",
      release,
    });

    const { chunks, spawn } = await runChat("claude_cli");
    expect(chunks.some((c: any) => c.type === "error")).toBe(true);
    expect(runCommanderAdapterTurnMock).not.toHaveBeenCalled(); // never reached the turn
    expect(release).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does NOT leak when host detectCliTool would have failed — it is bypassed on the sandbox path (F2)", async () => {
    const release = vi.fn(async () => {});
    resolveCommanderSandboxContextMock.mockResolvedValue(providerSandboxContext(release));
    runCommanderAdapterTurnMock.mockImplementation(async function* () {
      yield doneChunk;
      yield { kind: "result", result: { exitCode: 0, timedOut: false } };
    });

    // Make the host CLI probe FAIL (execSync throws → detectCliTool unavailable).
    // On the sandbox path the probe is bypassed, so the turn must still run and no
    // "not found in PATH" error is surfaced.
    (await import("../config/deployment-mode.js")).setDeploymentMode("cloud_auth");
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockImplementation(() => {
      throw new Error("which: not found");
    });
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
        runId: "run-1",
      } as any,
      { cliTool: "claude_cli", executionMode: "cli" } as any,
    )) {
      chunks.push(chunk);
    }

    expect(runCommanderAdapterTurnMock).toHaveBeenCalledTimes(1);
    expect(chunks.some((c: any) => c.type === "error" && /not found in PATH/i.test(c.message))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("resolve throw (e.g. missing JWT secret): surfaces an error chunk, never spawns, never delegates", async () => {
    resolveCommanderSandboxContextMock.mockRejectedValue(
      new Error("Commander sandbox requires a run-JWT secret (AOA_AGENT_JWT_SECRET/BETTER_AUTH_SECRET)."),
    );
    const { chunks, spawn } = await runChat("claude_cli");
    expect(chunks.some((c: any) => c.type === "error" && /run-JWT secret/.test(c.message))).toBe(true);
    expect(runCommanderAdapterTurnMock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
