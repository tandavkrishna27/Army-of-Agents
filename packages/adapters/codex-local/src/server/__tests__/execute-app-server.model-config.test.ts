import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAppServerTurn, type RunAppServerTurnDeps } from "../execute-app-server.js";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-appserver-model-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function fakeDeps() {
  const client = {
    close: vi.fn(),
  };
  return {
    spawnAppServerClient: vi.fn(() => ({ client, terminate: vi.fn() })),
    driveCodexAppServer: vi.fn(async () => ({
      summary: "ok",
      usage: null,
      errorMessage: null,
      errorCode: null,
      sessionId: "t1",
      timedOut: false,
      clearSession: false,
    })),
    createAppServerResultAccumulator: vi.fn(() => ({
      onNotification: vi.fn(),
      result: () => ({ summary: "ok", usage: null, errorMessage: null, errorCode: null }),
    })),
    // Loose test double — the mocks intentionally implement only the surface
    // runAppServerTurn exercises here (client.close, terminate, drive result,
    // accumulator). Cast to the full deps type rather than stubbing ChildProcess
    // / the whole JsonRpcClient. (Fixes a typecheck/build error: SpawnedAppServerClient
    // requires a `child` field this mock omits.)
  } as unknown as RunAppServerTurnDeps;
}

const baseInput = () => ({
  runId: "run-1",
  command: "codex",
  cwd: process.cwd(),
  env: {} as Record<string, string>,
  prompt: "do work",
  timeoutSec: 0,
  graceSec: 20,
});

describe("runAppServerTurn — model config delivery", () => {
  it("writes model into <managedCodexHome>/config.toml before spawn when model is set", async () => {
    const deps = fakeDeps();
    await runAppServerTurn(
      { ...baseInput(), model: "gpt-5.5", managedCodexHome: home, deps },
    );
    const toml = await fs.readFile(path.join(home, "config.toml"), "utf8");
    expect(toml).toContain('model = "gpt-5.5"');
    // The config write happens BEFORE the spawn.
    expect(deps.spawnAppServerClient).toHaveBeenCalledTimes(1);
  });

  it("clears a stale top-level model when model is undefined while preserving MCP config", async () => {
    const deps = fakeDeps();
    await fs.writeFile(
      path.join(home, "config.toml"),
      'model = "gpt-5.5"\n\n[mcp_servers.aoa]\ncommand = "node"\n',
      "utf8",
    );
    await runAppServerTurn(
      { ...baseInput(), managedCodexHome: home, deps },
    );
    const toml = await fs.readFile(path.join(home, "config.toml"), "utf8");
    expect(toml).not.toContain('model = "gpt-5.5"');
    expect(toml).toContain("[mcp_servers.aoa]");
  });
});
