// DEP-011 reaper Slice C — the trigger loop + config resolution.
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REAPER_INTERVAL_MS,
  resolveReaperConfig,
  startReaperLoop,
  type ReaperScheduler,
  type ReaperTimer,
} from "../reaper-loop.js";
import type { ReconcileReaperResult } from "../reconcile-reaper.js";

const URL_ENV = "AOA_ADAPTER_MANAGER_CONTROL_PLANE_URL";
const FLAG_ENV = "AOA_ADAPTER_MANAGER_REAPER_ENABLED";
const INTERVAL_ENV = "AOA_ADAPTER_MANAGER_REAPER_INTERVAL_MS";
const CP_URL = "http://control-plane:8080";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const noopLogger = { info: () => {}, error: () => {} };
const ZERO_RESULT: ReconcileReaperResult = { reaped: 0, skipped: 0, unknown: 0, failed: 0 };

function fakeScheduler() {
  const scheduled: Array<() => void> = [];
  let cancels = 0;
  const scheduler: ReaperScheduler = {
    schedule(callback: () => void): ReaperTimer {
      scheduled.push(callback);
      return { cancel: () => { cancels += 1; } };
    },
  };
  return { scheduler, scheduled, cancels: () => cancels };
}

describe("resolveReaperConfig — strict flag parse + refusal", () => {
  it("enabled ONLY on an exact trimmed '1' with a control-plane URL", () => {
    const cfg = resolveReaperConfig({ [FLAG_ENV]: "1", [URL_ENV]: CP_URL });
    expect(cfg.kind).toBe("enabled");
    if (cfg.kind === "enabled") {
      expect(cfg.controlPlaneUrl).toBe(CP_URL);
      expect(cfg.intervalMs).toBe(DEFAULT_REAPER_INTERVAL_MS);
    }
  });

  it("trims surrounding whitespace on the flag ('  1  ' is on)", () => {
    expect(resolveReaperConfig({ [FLAG_ENV]: "  1  ", [URL_ENV]: CP_URL }).kind).toBe("enabled");
  });

  it("every off-token → disabled (a clean no-op)", () => {
    for (const token of [undefined, "", "0", "false", "true", "yes", "on", "11", "1a", "01", "2"]) {
      const env: Record<string, string | undefined> = { [URL_ENV]: CP_URL };
      if (token !== undefined) env[FLAG_ENV] = token;
      expect(resolveReaperConfig(env).kind, `token=${JSON.stringify(token)}`).toBe("disabled");
    }
  });

  it("flag ON but the control-plane URL MISSING → refused (never a silently-dead reaper)", () => {
    for (const url of [undefined, "", "   "]) {
      const env: Record<string, string | undefined> = { [FLAG_ENV]: "1" };
      if (url !== undefined) env[URL_ENV] = url;
      const cfg = resolveReaperConfig(env);
      expect(cfg.kind, `url=${JSON.stringify(url)}`).toBe("refused");
    }
  });

  it("interval: default when unset, non-positive, or unparseable; parsed when valid", () => {
    const base = { [FLAG_ENV]: "1", [URL_ENV]: CP_URL };
    const intervalOf = (raw: string | undefined) => {
      const cfg = resolveReaperConfig(raw === undefined ? base : { ...base, [INTERVAL_ENV]: raw });
      return cfg.kind === "enabled" ? cfg.intervalMs : null;
    };
    expect(intervalOf(undefined)).toBe(DEFAULT_REAPER_INTERVAL_MS);
    expect(intervalOf("0")).toBe(DEFAULT_REAPER_INTERVAL_MS);
    expect(intervalOf("-5")).toBe(DEFAULT_REAPER_INTERVAL_MS);
    expect(intervalOf("abc")).toBe(DEFAULT_REAPER_INTERVAL_MS);
    expect(intervalOf("15000")).toBe(15_000);
    expect(DEFAULT_REAPER_INTERVAL_MS).toBeLessThan(60_000); // below the E2B create-TTL
  });
});

describe("startReaperLoop — self-rescheduling, contained ticks", () => {
  it("arms the first tick, and firing it calls reconcile exactly once", async () => {
    const { scheduler, scheduled } = fakeScheduler();
    const reconcile = vi.fn(async () => ZERO_RESULT);
    startReaperLoop({ scheduler, reconcile, logger: noopLogger, intervalMs: 1000 });
    expect(scheduled).toHaveLength(1); // first tick armed
    expect(reconcile).not.toHaveBeenCalled();
    scheduled[0]!();
    await flush();
    expect(reconcile).toHaveBeenCalledTimes(1);
    // Self-reschedule in the settled .finally: a SECOND tick is now armed.
    expect(scheduled).toHaveLength(2);
  });

  it("a REJECTED reconcile is swallowed — the loop survives and reschedules", async () => {
    const { scheduler, scheduled } = fakeScheduler();
    const reconcile = vi.fn(async () => {
      throw new Error("provider.list exploded");
    });
    const error = vi.fn();
    startReaperLoop({ scheduler, reconcile, logger: { info: () => {}, error }, intervalMs: 1000 });
    // Firing the tick must not throw out of the loop.
    expect(() => scheduled[0]!()).not.toThrow();
    await flush();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1); // logged at error, contained
    expect(scheduled).toHaveLength(2); // rescheduled despite the failure
  });

  it("a SYNCHRONOUSLY-throwing reconcile is also contained", async () => {
    const { scheduler, scheduled } = fakeScheduler();
    const reconcile = vi.fn((() => {
      throw new Error("sync boom");
    }) as unknown as () => Promise<ReconcileReaperResult>);
    startReaperLoop({ scheduler, reconcile, logger: noopLogger, intervalMs: 1000 });
    expect(() => scheduled[0]!()).not.toThrow();
    await flush();
    expect(scheduled).toHaveLength(2);
  });

  it("the re-entrancy guard prevents an overlapping sweep if a tick is fired twice", async () => {
    const { scheduler, scheduled } = fakeScheduler();
    let resolveReconcile: (r: ReconcileReaperResult) => void = () => {};
    const reconcile = vi.fn(
      () => new Promise<ReconcileReaperResult>((resolve) => { resolveReconcile = resolve; }),
    );
    startReaperLoop({ scheduler, reconcile, logger: noopLogger, intervalMs: 1000 });
    scheduled[0]!();
    scheduled[0]!(); // a double-fire while the first sweep is still in flight
    await flush();
    expect(reconcile).toHaveBeenCalledTimes(1); // guard held
    resolveReconcile(ZERO_RESULT);
    await flush();
  });

  it("stop() cancels the pending timer and prevents further ticks", async () => {
    const { scheduler, scheduled, cancels } = fakeScheduler();
    const reconcile = vi.fn(async () => ZERO_RESULT);
    const stop = startReaperLoop({ scheduler, reconcile, logger: noopLogger, intervalMs: 1000 });
    stop();
    expect(cancels()).toBe(1);
    scheduled[0]!(); // a late fire of the already-armed tick
    await flush();
    expect(reconcile).not.toHaveBeenCalled(); // stopped guard held
  });
});
