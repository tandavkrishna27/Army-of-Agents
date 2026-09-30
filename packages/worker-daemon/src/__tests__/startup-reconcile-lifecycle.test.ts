/**
 * WRK-007 Slice 4b — the startup lifecycle seam + inertness (E4-D12).
 *
 * The bootstrap gains an OPTIONAL `reconciler?: StartupReconciler`. When present it
 * runs ONCE between `startHealth` and signal registration (mirroring how the WRK-005
 * renewal + WRK-006 event-outbox shutdown seams degrade to `[]`); when ABSENT the
 * startup pass runs nothing at all (inert default — rollback = omit). It never
 * dispatches work and never starts a loop.
 *
 * Fail-first: `bootstrapWorkerDaemon` does not know the `reconciler` seam yet.
 */

import { describe, expect, it } from "vitest";

import { bootstrapWorkerDaemon, type ProcessLike } from "../bin/worker-daemon.js";
import {
  createStartupSteps,
  runStartupSteps,
  type StartupLogger,
  type StartupReconciler,
} from "../lifecycle/startup-steps.js";
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
  return { info: () => {}, warn: () => {}, error: () => {}, flush: async () => {} };
}
function orderedProc(order: string[]) {
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  const proc: ProcessLike = {
    once: (event, listener) => {
      order.push(`register:${event}`);
      listeners.set(event, listener);
    },
    exit: () => {},
  };
  return { listeners, proc };
}

describe("createStartupSteps / runStartupSteps — the one-shot startup runner", () => {
  it("gates on presence: undefined reconciler ⇒ empty step list ⇒ nothing runs", async () => {
    expect(createStartupSteps(undefined)).toEqual([]);
    let ran = 0;
    await runStartupSteps(createStartupSteps(undefined), noopLogger());
    expect(ran).toBe(0);
    // A present reconciler yields exactly one step that invokes run().
    const reconciler: StartupReconciler = { run: () => void (ran += 1) };
    const steps = createStartupSteps(reconciler);
    expect(steps).toHaveLength(1);
    await runStartupSteps(steps, noopLogger());
    expect(ran).toBe(1);
  });

  it("a throwing startup step never aborts boot (swallowed + logged)", async () => {
    const reconciler: StartupReconciler = {
      run: () => {
        throw new Error("probe blew up");
      },
    };
    await expect(runStartupSteps(createStartupSteps(reconciler), noopLogger())).resolves.toBeUndefined();
  });

  it("AWAITS an async reconciliation before returning (not fire-and-forget)", async () => {
    // Regression (HIGH): a `void reconciler.run()` wrapper discards the promise, so the
    // runner returns before an ASYNC pass (which suspends at its first await) completes.
    // The concrete reconciler is async (probe → list → drain), so boot would proceed to
    // signal registration mid-reconcile. This reconciler finishes only AFTER two awaits.
    let completed = false;
    const reconciler: StartupReconciler = {
      // A MACROTASK boundary — it outlasts the runner's own microtask chain, so a
      // fire-and-forget `void` wrapper would return before `completed` is set.
      run: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        completed = true;
      },
    };
    await runStartupSteps(createStartupSteps(reconciler), noopLogger());
    expect(completed).toBe(true); // the runner awaited the FULL async pass
  });

  it("CATCHES a rejecting ASYNC reconciliation (logs it, never an orphaned unhandledRejection)", async () => {
    // Regression (HIGH): run() is not exception-safe by construction; a fire-and-forget
    // `void reconciler.run()` orphans an async rejection (Node unhandledRejection →
    // process termination) instead of the runner's try/catch swallowing + logging it.
    const errs: unknown[] = [];
    const logger: StartupLogger = {
      info: () => {},
      error: (bindings) => errs.push((bindings as { err?: unknown }).err),
    };
    const reconciler: StartupReconciler = {
      run: async () => {
        await Promise.resolve();
        throw new Error("async probe blew up");
      },
    };
    await expect(runStartupSteps(createStartupSteps(reconciler), logger)).resolves.toBeUndefined();
    expect(errs).toHaveLength(1); // the runner AWAITED + CAUGHT the async rejection
    expect((errs[0] as Error).message).toBe("async probe blew up");
  });
});

describe("bootstrapWorkerDaemon — startup reconciliation seam (WRK-007)", () => {
  it("runs the reconciler EXACTLY once, between startHealth and signal registration", async () => {
    const order: string[] = [];
    const handle: HealthServerHandle = { port: 1, close: async () => {} };
    const startHealth = (async () => {
      order.push("health");
      return handle;
    }) as never;
    const { proc } = orderedProc(order);
    let ran = 0;
    const reconciler: StartupReconciler = {
      run: async () => {
        order.push("reconcile");
        ran += 1;
      },
    };

    const result = await bootstrapWorkerDaemon({
      env: baseEnv(),
      proc,
      createLogger: () => noopLogger(),
      startHealth,
      reconciler,
    });

    expect(result.ok).toBe(true);
    expect(ran).toBe(1);
    expect(order).toEqual(["health", "reconcile", "register:SIGINT", "register:SIGTERM"]);
  });

  it("is INERT by default: with no reconciler wired, the startup pass runs nothing", async () => {
    const order: string[] = [];
    const handle: HealthServerHandle = { port: 1, close: async () => {} };
    const startHealth = (async () => {
      order.push("health");
      return handle;
    }) as never;
    const { proc } = orderedProc(order);

    const result = await bootstrapWorkerDaemon({
      env: baseEnv(),
      proc,
      createLogger: () => noopLogger(),
      startHealth,
    });

    expect(result.ok).toBe(true);
    expect(order).toEqual(["health", "register:SIGINT", "register:SIGTERM"]);
    expect(order).not.toContain("reconcile");
  });
});
