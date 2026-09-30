import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { SpawnTrackedChildOptions, TrackedChildHandle } from "@armyofagents/adapter-utils/server-utils";
import { extractCodexDeviceCode, runCodexLogin } from "../login.js";

function fakeSpawn() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const handle: TrackedChildHandle = { child: child as never, pid: 1, pgid: 1, startedAt: new Date(0), terminate: vi.fn() };
  const calls: Array<{ runId: string; command: string; argv: string[]; opts: SpawnTrackedChildOptions }> = [];
  const spawn = (runId: string, command: string, argv: string[], opts: SpawnTrackedChildOptions) => {
    calls.push({ runId, command, argv, opts });
    return handle;
  };
  return { spawn, calls, child };
}

describe("runCodexLogin (Plan 3 T3)", () => {
  let scopedHome: string;

  beforeEach(() => {
    scopedHome = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-codex-login-"));
  });

  afterEach(() => {
    fs.rmSync(scopedHome, { recursive: true, force: true });
  });

  it("spawns remote-safe Codex device auth and returns URL plus user code", async () => {
    const f = fakeSpawn();
    const codexHome = path.join(scopedHome, ".codex");
    const res = runCodexLogin({
      runId: "c1",
      env: { HOME: scopedHome, CODEX_HOME: codexHome },
      spawn: f.spawn,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].command).toBe("codex");
    expect(f.calls[0].argv).toEqual(["login", "--device-auth"]);
    expect(f.calls[0].opts.env.CODEX_HOME).toBe(codexHome);
    expect(f.calls[0].opts.env.HOME).toBe(scopedHome);
    expect(res.authHome).toBe(codexHome);
    f.child.stdout.emit(
      "data",
      "Sign in to Codex from the command-line.\n" +
        "COMMAND-LINE\n" +
        "Open \u001b[4mhttps://auth.openai.com/codex/dev",
    );
    f.child.stdout.emit("data", "ice\u001b[0m in your browser.\n");
    f.child.stderr.emit(
      "data",
      "Enter this one-time code (expires in 15 minutes):\n\n" +
        "\u001b[1mAB1C-D2E3",
    );
    let prematurelyResolvedCode: string | undefined;
    void res.userCodePromise.then((code) => {
      prematurelyResolvedCode = code;
    });
    await Promise.resolve();
    expect(prematurelyResolvedCode).toBeUndefined();
    f.child.stderr.emit("data", "F\u001b[0m\ncodex-auth\n");
    await expect(res.urlPromise).resolves.toBe("https://auth.openai.com/codex/device");
    await expect(res.userCodePromise).resolves.toBe("AB1C-D2E3F");
  });

  it("requires device-prompt context and ignores standalone hyphenated prose", () => {
    expect(
      extractCodexDeviceCode(
        "COMMAND-LINE\nCODEX-AUTH\ncommand-line\ncodex-auth\nABCD-EFGH\n",
      ),
    ).toBeNull();
    expect(
      extractCodexDeviceCode(
        "Enter this device code:\n\n\u001b[1mABCD-EFGH\u001b[0m\n",
      ),
    ).toBe("ABCD-EFGH");
    expect(
      extractCodexDeviceCode(
        "Enter this device code:\r\u001b[1mABCD-EFGH\u001b[0m\r",
      ),
    ).toBe("ABCD-EFGH");
  });

  it("reconstructs the real-shaped URL and code at every character boundary", async () => {
    const output =
      "Sign in to Codex from the command-line.\n" +
      "COMMAND-LINE\n" +
      "Open \u001b[4mhttps://auth.openai.com/codex/device\u001b[0m in your browser.\n" +
      "Enter this one-time code:\n" +
      "\u001b[1mAB1C-D2E3F\u001b[0m\n";

    for (let split = 1; split < output.length; split += 1) {
      const f = fakeSpawn();
      const res = runCodexLogin({
        runId: `boundary-${split}`,
        env: { HOME: scopedHome, CODEX_HOME: path.join(scopedHome, ".codex") },
        spawn: f.spawn,
      });
      f.child.stdout.emit("data", output.slice(0, split));
      f.child.stdout.emit("data", output.slice(split));
      await expect(res.urlPromise, `URL split at ${split}`).resolves.toBe(
        "https://auth.openai.com/codex/device",
      );
      await expect(res.userCodePromise, `code split at ${split}`).resolves.toBe("AB1C-D2E3F");
    }
  });

  it("accepts carriage-return-only terminal redraw lines", async () => {
    const f = fakeSpawn();
    const res = runCodexLogin({
      runId: "cr-only",
      env: { HOME: scopedHome, CODEX_HOME: path.join(scopedHome, ".codex") },
      spawn: f.spawn,
    });
    f.child.stdout.emit(
      "data",
      "Open https://auth.openai.com/codex/device\r" +
        "Enter this device code:\r" +
        "ABCD-EFGH\r",
    );
    await expect(res.urlPromise).resolves.toBe("https://auth.openai.com/codex/device");
    await expect(res.userCodePromise).resolves.toBe("ABCD-EFGH");
  });

  it("does not let stdout terminate a partial code still being written on stderr", async () => {
    const f = fakeSpawn();
    const res = runCodexLogin({
      runId: "cross-stream",
      env: { HOME: scopedHome, CODEX_HOME: path.join(scopedHome, ".codex") },
      spawn: f.spawn,
    });
    let resolved: string | undefined;
    void res.userCodePromise.then((code) => {
      resolved = code;
    });
    f.child.stderr.emit("data", "Enter this one-time code:\nAB1C-D2E3");
    f.child.stdout.emit("data", "\n");
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    f.child.stderr.emit("data", "F\n");
    await expect(res.userCodePromise).resolves.toBe("AB1C-D2E3F");
  });

  it("flushes an unterminated final code when the child closes", async () => {
    const f = fakeSpawn();
    const res = runCodexLogin({
      runId: "final-line",
      env: { HOME: scopedHome, CODEX_HOME: path.join(scopedHome, ".codex") },
      spawn: f.spawn,
    });
    f.child.stderr.emit(
      "data",
      "Open https://auth.openai.com/codex/device\nEnter this device code:\nABCD-EFGH",
    );
    f.child.emit("close", 0);
    await expect(res.urlPromise).resolves.toBe("https://auth.openai.com/codex/device");
    await expect(res.userCodePromise).resolves.toBe("ABCD-EFGH");
  });

  it("bounds device-code discovery when the CLI prints a URL but no code", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeSpawn();
      const codexHome = path.join(scopedHome, ".codex");
      const res = runCodexLogin({
        runId: "c2",
        env: { HOME: scopedHome, CODEX_HOME: codexHome },
        discoveryTimeoutMs: 250,
        spawn: f.spawn,
      });
      f.child.stdout.emit("data", "open https://chatgpt.com/device\n");
      const rejected = expect(res.userCodePromise).rejects.toThrow("device-code-timeout");
      await vi.advanceTimersByTimeAsync(250);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
