import { describe, expect, it, vi } from "vitest";

import { bootstrapWorkerDaemon, type ProcessLike } from "../bin/worker-daemon.js";
import type { Env } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import type { HealthServerHandle } from "../health/health-server.js";

function baseEnv(overrides: Env = {}): Env {
  return {
    AOA_WORKER_CONTROL_PLANE_URL: "https://control.example.com",
    AOA_WORKER_ENROLLMENT_CODE_FILE: "/run/secrets/enrollment-code",
    AOA_WORKER_KEY_STORE_MODE: "mounted_secret",
    AOA_WORKER_TARGET_SCOPE: "organization",
    ...overrides,
  };
}

function noopLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    flush: async () => {},
  };
}

function fakeProc() {
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  const exitCodes: number[] = [];
  const proc: ProcessLike = {
    once: (event, listener) => {
      listeners.set(event, listener);
    },
    exit: (code) => {
      exitCodes.push(code);
    },
  };
  return { listeners, exitCodes, proc };
}

describe("bootstrapWorkerDaemon — signal wiring", () => {
  it("registers SIGINT/SIGTERM one-shot handlers and opens the health server", async () => {
    const closed: string[] = [];
    const handle: HealthServerHandle = { port: 12345, close: async () => void closed.push("closed") };
    const startHealth = vi.fn(async () => handle);
    const { listeners, exitCodes, proc } = fakeProc();

    const result = await bootstrapWorkerDaemon({
      env: baseEnv(),
      proc,
      createLogger: () => noopLogger(),
      startHealth: startHealth as never,
    });

    expect(result.ok).toBe(true);
    expect(startHealth).toHaveBeenCalledTimes(1);
    expect(listeners.has("SIGINT")).toBe(true);
    expect(listeners.has("SIGTERM")).toBe(true);
    expect(exitCodes).toEqual([]);

    // Firing a signal runs the shutdown path (stop health -> exit(0)).
    listeners.get("SIGINT")!();
    await result.shutdown!("SIGINT");
    expect(closed).toEqual(["closed"]);
    expect(exitCodes).toEqual([0]);
  });

  it("both signals resolve to the same one-shot shutdown", async () => {
    const handle: HealthServerHandle = { port: 1, close: async () => {} };
    const { listeners, exitCodes, proc } = fakeProc();
    const result = await bootstrapWorkerDaemon({
      env: baseEnv(),
      proc,
      createLogger: () => noopLogger(),
      startHealth: (async () => handle) as never,
    });
    listeners.get("SIGINT")!();
    listeners.get("SIGTERM")!();
    await result.shutdown!("SIGINT");
    await result.shutdown!("SIGTERM");
    expect(exitCodes).toEqual([0]);
  });
});

describe("bootstrapWorkerDaemon — lease lifecycle composition (WRK-003)", () => {
  it("runs lease-stop then drain BEFORE the health-server stop when a loop is wired", async () => {
    const order: string[] = [];
    const handle: HealthServerHandle = { port: 1, close: async () => void order.push("health") };
    const { listeners, proc } = fakeProc();

    const result = await bootstrapWorkerDaemon({
      env: baseEnv(),
      proc,
      createLogger: () => noopLogger(),
      startHealth: (async () => handle) as never,
      leasing: {
        stopLeasing: () => order.push("lease-stop"),
        drain: async () => void order.push("drain"),
      },
    });

    expect(result.ok).toBe(true);
    listeners.get("SIGTERM")!();
    await result.shutdown!("SIGTERM");
    expect(order).toEqual(["lease-stop", "drain", "health"]);
  });
});

describe("bootstrapWorkerDaemon — fail-closed on invalid config", () => {
  it("exits non-zero BEFORE opening the health server or any socket", async () => {
    const startHealth = vi.fn(async () => ({ port: 0, close: async () => {} }) as HealthServerHandle);
    const { exitCodes, listeners, proc } = fakeProc();

    const result = await bootstrapWorkerDaemon({
      env: baseEnv({ AOA_WORKER_CONTROL_PLANE_URL: undefined }),
      proc,
      createLogger: () => noopLogger(),
      startHealth: startHealth as never,
    });

    expect(result.ok).toBe(false);
    expect(startHealth).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
    expect(exitCodes.length).toBe(1);
    expect(exitCodes[0]).not.toBe(0);
  });
});
