import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestTrackedProcessTermination,
  runChildProcess,
  runningProcesses,
  spawnTrackedChild,
} from "../server-utils.js";

const IS_WIN = process.platform === "win32";

/**
 * Task 2 (W5c) — `spawnTrackedChild` is the single source of truth for spawning
 * a child that is REGISTERED in `runningProcesses` (so heartbeat.cancelRun and
 * reapOrphanedRuns can find it), strips the ambient OPENAI_API_KEY, and offers a
 * SIGTERM→SIGKILL `terminate()`. Both the `exec` path (`runChildProcess`) and the
 * long-lived `codex app-server` driver spawn through it, so an app-server child
 * blocked on a human approval stays cancellable and un-reaped.
 */
describe("spawnTrackedChild (W5c Task 2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const drain = (child: { on: (ev: string, cb: () => void) => void }) =>
    new Promise<void>((resolve) => child.on("close", () => resolve()));

  it("registers in runningProcesses at spawn and removes on close", async () => {
    const runId = `tracked-close-${Date.now()}`;
    const handle = spawnTrackedChild(
      runId,
      process.execPath,
      ["-e", "process.exit(0)"],
      { cwd: os.tmpdir(), env: {}, graceSec: 1, shell: false },
    );
    expect(runningProcesses.has(runId)).toBe(true);
    expect(handle.pid === null || typeof handle.pid === "number").toBe(true);
    expect(handle.startedAt).toBeInstanceOf(Date);
    await drain(handle.child);
    expect(runningProcesses.has(runId)).toBe(false);
  });

  it("terminates a child that registers after cancellation was requested", async () => {
    const runId = `tracked-late-spawn-${Date.now()}`;
    requestTrackedProcessTermination(runId);
    const handle = spawnTrackedChild(
      runId,
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 60000)"],
      { cwd: os.tmpdir(), env: {}, graceSec: 1, shell: false },
    );
    expect(runningProcesses.has(runId)).toBe(true);
    const terminal = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      handle.child.on("close", (code, signal) => resolve({ code, signal }));
    });
    expect(terminal.code === 0 && terminal.signal === null).toBe(false);
    expect(runningProcesses.has(runId)).toBe(false);
  });

  it("removes from runningProcesses on error (command not found)", async () => {
    const runId = `tracked-error-${Date.now()}`;
    const handle = spawnTrackedChild(
      runId,
      // A path that cannot exist — spawn emits `error`, not `close`.
      "/definitely/not/a/real/binary/aoa-xyz",
      [],
      { cwd: os.tmpdir(), env: {}, graceSec: 1, shell: false },
    );
    await new Promise<void>((resolve) => {
      handle.child.on("error", () => resolve());
      handle.child.on("close", () => resolve());
    });
    // Give the microtask that deletes the entry a tick to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(runningProcesses.has(runId)).toBe(false);
  });

  it("strips an ambient OPENAI_API_KEY but keeps one set via opts.env", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-should-be-stripped";
    try {
      // Case 1: ambient key, unsetEnvKeys strips it → child sees empty string.
      const runId1 = `tracked-strip-${Date.now()}`;
      const handle1 = spawnTrackedChild(
        runId1,
        process.execPath,
        ["-e", "process.stdout.write(String(process.env.OPENAI_API_KEY ?? ''))"],
        {
          cwd: os.tmpdir(),
          env: {},
          graceSec: 1,
          shell: false,
          unsetEnvKeys: ["OPENAI_API_KEY"],
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let out1 = "";
      handle1.child.stdout?.on("data", (c: Buffer) => {
        out1 += String(c);
      });
      await drain(handle1.child);
      expect(out1).toBe("");

      // Case 2: overlay sets its own key → survives the strip.
      const runId2 = `tracked-keep-${Date.now()}`;
      const handle2 = spawnTrackedChild(
        runId2,
        process.execPath,
        ["-e", "process.stdout.write(String(process.env.OPENAI_API_KEY ?? ''))"],
        {
          cwd: os.tmpdir(),
          env: { OPENAI_API_KEY: "agent-own-key" },
          graceSec: 1,
          shell: false,
          unsetEnvKeys: ["OPENAI_API_KEY"],
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let out2 = "";
      handle2.child.stdout?.on("data", (c: Buffer) => {
        out2 += String(c);
      });
      await drain(handle2.child);
      expect(out2).toBe("agent-own-key");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  // POSIX-only: this pins the SIGTERM→SIGKILL escalation + the still-registered
  // grace-timer re-check. On Windows signalRunningProcess shells out to a
  // taskkill /T /F subprocess instead of child.kill / process.kill (R1), and the
  // module-namespace `spawn` cannot be spied in ESM — the Windows taskkill shape
  // + escalation is covered exhaustively in server-utils-win32-taskkill.test.ts.
  it.skipIf(IS_WIN)(
    "terminate() signals the child and escalates SIGTERM→SIGKILL after graceSec (POSIX)",
    async () => {
      vi.useFakeTimers();
      try {
        const runId = `tracked-terminate-${Date.now()}`;
        // A long sleeper so the process is still registered when we terminate.
        const handle = spawnTrackedChild(
          runId,
          process.execPath,
          ["-e", "setTimeout(()=>{}, 60000)"],
          { cwd: os.tmpdir(), env: {}, graceSec: 2, shell: false },
        );
        expect(runningProcesses.has(runId)).toBe(true);

        // Spy on the child's own kill (signalRunningProcess falls back to it) and
        // process.kill (the group signal via process.kill(-pgid)).
        const childKill = vi.spyOn(handle.child, "kill").mockReturnValue(true);
        const procKill = vi
          .spyOn(process, "kill")
          .mockImplementation(() => true as unknown as true);
        const signals = () => [
          ...childKill.mock.calls.map((c) => c[0]),
          ...procKill.mock.calls.map((c) => c[1]),
        ];

        handle.terminate();
        expect(signals()).toContain("SIGTERM");
        expect(signals()).not.toContain("SIGKILL");

        // Advance past graceSec — child is still registered, so escalate.
        vi.advanceTimersByTime(2000);
        expect(signals()).toContain("SIGKILL");

        // Idempotent + safe after close: simulate close deregistration then
        // terminate again — a SIGTERM is sent but no further SIGKILL escalation
        // fires because the row is gone.
        runningProcesses.delete(runId);
        const beforeKillCount = childKill.mock.calls.length + procKill.mock.calls.length;
        handle.terminate();
        vi.advanceTimersByTime(5000);
        const afterKillCount = childKill.mock.calls.length + procKill.mock.calls.length;
        // Exactly one more SIGTERM (no escalation).
        expect(afterKillCount).toBe(beforeKillCount + 1);

        procKill.mockRestore();
        childKill.mockRestore();
        // Actually kill the real sleeper so the test process can exit.
        handle.child.kill("SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("regression: runChildProcess (exec-style) still registers at spawn and deregisters on close", async () => {
    const runId = `exec-regression-${Date.now()}`;
    let seenRegistered = false;
    const result = await runChildProcess(
      runId,
      process.execPath,
      ["-e", "process.stdout.write('hi'); process.exit(0)"],
      {
        cwd: os.tmpdir(),
        env: {},
        timeoutSec: 30,
        graceSec: 1,
        shell: false,
        onLog: async () => {
          // The child is running here, so it must be registered.
          if (runningProcesses.has(runId)) seenRegistered = true;
        },
      },
    );
    expect(result.stdout).toContain("hi");
    expect(result.exitCode).toBe(0);
    expect(seenRegistered).toBe(true);
    expect(runningProcesses.has(runId)).toBe(false);
  });
});
