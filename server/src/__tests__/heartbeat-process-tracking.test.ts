import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

// R1 zombie-run teardown: signalRunningProcess now shells out to taskkill on
// Windows. Mock spawn so no real taskkill runs on any runner; capture calls so
// the win32 tree-kill shape can be asserted. The POSIX signalRunningProcess path
// uses process.kill (not spawn), so this mock does not affect those tests.
const spawnCalls: Array<{ command: string; args: unknown[]; options: unknown }> = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: unknown[], options: unknown) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 4242;
      return child;
    }),
  };
});

import { resolveProcessGroupId, signalRunningProcess } from "@armyofagents/adapter-utils/server-utils";
import type { spawn } from "node:child_process";

describe("resolveProcessGroupId", () => {
  it("returns null on Windows", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      writable: true,
      configurable: true,
    });
    try {
      const fakeChild = { pid: 1234 } as ReturnType<typeof spawn>;
      expect(resolveProcessGroupId(fakeChild)).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });

  it("returns the child's pid on POSIX (which equals pgid when spawned with detached:true)", () => {
    if (process.platform === "win32") return;
    const fakeChild = { pid: 1234 } as ReturnType<typeof spawn>;
    expect(resolveProcessGroupId(fakeChild)).toBe(1234);
  });

  it("returns null when child has no pid (spawn failed)", () => {
    const fakeChild = { pid: undefined } as unknown as ReturnType<typeof spawn>;
    expect(resolveProcessGroupId(fakeChild)).toBeNull();
  });

  it("returns null when child pid is invalid (0)", () => {
    if (process.platform === "win32") return;
    const fakeChild = { pid: 0 } as ReturnType<typeof spawn>;
    expect(resolveProcessGroupId(fakeChild)).toBeNull();
  });
});

describe("signalRunningProcess", () => {
  it("uses process.kill(-pgid, signal) on POSIX when processGroupId is valid", () => {
    if (process.platform === "win32") return;

    let capturedTarget: number | null = null;
    let capturedSignal: NodeJS.Signals | string | null = null;
    const originalKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = ((pid: number, sig?: NodeJS.Signals | number) => {
      capturedTarget = pid;
      capturedSignal = (sig as NodeJS.Signals) ?? null;
      return true;
    }) as typeof process.kill;

    try {
      const childKill = vi.fn();
      const fakeChild = { pid: 1234, killed: false, kill: childKill } as unknown as ReturnType<typeof spawn>;
      signalRunningProcess({ child: fakeChild, processGroupId: 1234 }, "SIGTERM");
      expect(capturedTarget).toBe(-1234);
      expect(capturedSignal).toBe("SIGTERM");
      expect(childKill).not.toHaveBeenCalled();
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  it("falls back to child.kill when group signal throws", () => {
    if (process.platform === "win32") return;

    const originalKill = process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = (() => {
      throw new Error("ESRCH");
    }) as typeof process.kill;

    try {
      const childKill = vi.fn();
      const fakeChild = { pid: 1234, killed: false, kill: childKill } as unknown as ReturnType<typeof spawn>;
      signalRunningProcess({ child: fakeChild, processGroupId: 1234 }, "SIGTERM");
      expect(childKill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    }
  });

  // R1 zombie-run teardown: on Windows signalRunningProcess now shells out to
  // `taskkill /PID <pid> /T /F` (whole process TREE) instead of child.kill (which
  // only reaped the cmd.exe wrapper and orphaned the real CLI grandchild). The
  // exhaustive win32 shape/edge assertions live in adapter-utils'
  // server-utils-win32-taskkill.test.ts; these pin the core behavior swap.
  it("shells out to taskkill /T /F (tree kill) on Windows instead of child.kill", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });
    spawnCalls.length = 0;

    try {
      const childKill = vi.fn();
      const fakeChild = { pid: 1234, killed: false, kill: childKill } as unknown as ReturnType<typeof spawn>;
      signalRunningProcess({ child: fakeChild, processGroupId: null }, "SIGTERM");
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]!.command).toBe("taskkill");
      expect(spawnCalls[0]!.args).toEqual(["/PID", "1234", "/T", "/F"]);
      expect(spawnCalls[0]!.options).toMatchObject({ shell: false });
      expect(childKill).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: original, writable: true, configurable: true });
    }
  });

  it("falls back to child.kill on Windows only when there is no pid", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });
    spawnCalls.length = 0;

    try {
      const childKill = vi.fn();
      const fakeChild = { pid: undefined, killed: false, kill: childKill } as unknown as ReturnType<typeof spawn>;
      signalRunningProcess({ child: fakeChild, processGroupId: null }, "SIGTERM");
      expect(spawnCalls).toHaveLength(0);
      expect(childKill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      Object.defineProperty(process, "platform", { value: original, writable: true, configurable: true });
    }
  });
});
