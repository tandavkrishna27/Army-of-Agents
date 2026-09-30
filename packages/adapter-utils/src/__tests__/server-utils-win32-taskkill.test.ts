import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R1 (zombie-run teardown): on Windows the supervised CLI is a grandchild of the
// cmd.exe wrapper spawned with shell:true, so child.kill() orphans it. The fix is
// a `taskkill /PID <pid> /T /F` process-TREE kill in signalRunningProcess. This
// suite mocks node:child_process.spawn to assert the taskkill invocation shape
// WITHOUT actually launching taskkill (the test runner may be POSIX).

interface SpawnCall {
  command: string;
  args: string[];
  options: unknown;
}

const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], options: unknown) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 999;
      return child;
    }),
  };
});

// Import AFTER the mock is registered so server-utils binds the mocked spawn.
const { signalRunningProcess } = await import("../server-utils.js");

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function fakeChild(pid: number | undefined, killed = false) {
  const kill = vi.fn();
  return {
    child: { pid, killed, kill } as unknown as ChildProcess,
    kill,
  };
}

beforeEach(() => {
  spawnCalls.length = 0;
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
  vi.clearAllMocks();
});

describe("signalRunningProcess win32 tree-kill", () => {
  it("spawns `taskkill /PID <pid> /T /F` (no shell) on SIGTERM instead of child.kill", () => {
    setPlatform("win32");
    const { child, kill } = fakeChild(1234);

    signalRunningProcess({ child, processGroupId: null }, "SIGTERM");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.command).toBe("taskkill");
    expect(spawnCalls[0]!.args).toEqual(["/PID", "1234", "/T", "/F"]);
    expect(spawnCalls[0]!.options).toMatchObject({ shell: false });
    // The win32 tree-kill supersedes the single-process child.kill.
    expect(kill).not.toHaveBeenCalled();
  });

  it("maps a SIGKILL escalation to the same forceful taskkill (Windows has no graceful signal)", () => {
    setPlatform("win32");
    const { child } = fakeChild(4321);

    signalRunningProcess({ child, processGroupId: null }, "SIGKILL");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toEqual(["/PID", "4321", "/T", "/F"]);
  });

  it("swallows a taskkill spawn failure (never throws out of a cancel path)", async () => {
    setPlatform("win32");
    const { child } = fakeChild(5555);
    const spawnMock = (await import("node:child_process")).spawn as unknown as ReturnType<typeof vi.fn>;
    spawnMock.mockImplementationOnce(() => {
      throw new Error("ENOENT: taskkill not found");
    });

    expect(() => signalRunningProcess({ child, processGroupId: null }, "SIGTERM")).not.toThrow();
  });

  it("falls back to child.kill when there is no pid (spawn never succeeded)", () => {
    setPlatform("win32");
    const { child, kill } = fakeChild(undefined);

    signalRunningProcess({ child, processGroupId: null }, "SIGTERM");

    expect(spawnCalls).toHaveLength(0);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not tree-kill on POSIX (uses process-group signaling, not taskkill)", () => {
    setPlatform("linux");
    const { child } = fakeChild(1234);
    const originalKill = process.kill;
    let target: number | null = null;
    (process as unknown as { kill: typeof process.kill }).kill = ((pid: number) => {
      target = pid;
      return true;
    }) as typeof process.kill;
    try {
      signalRunningProcess({ child, processGroupId: 1234 }, "SIGTERM");
      expect(spawnCalls).toHaveLength(0);
      expect(target).toBe(-1234);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });
});
