// packages/adapter-manager/src/reaper-loop.ts
//
// DEP-011 reaper Slice C — the trigger loop + its config resolution. This is the ONLY
// slice that introduces a running loop; isolating it behind its own default-off flag is
// what makes "INERT" verifiable.
//
// ★ TICK CONTAINMENT IS THE LOOP'S JOB (B2C-F1, HIGH). `reconcileReaper` wraps only the
// per-target cleanup — the fleet `provider.list` and the `resolveTruth` await are
// UNWRAPPED, so a `provider.list` throw REJECTS the whole tick. The AM bin has NO
// `unhandledRejection` handler and the loop runs in the SAME process as the gated
// create/execute/teardown host — an unhandled tick rejection would crash the host serving
// LIVE workers. So: (1) every tick is `.catch()`-guarded (a failed sweep neither crashes
// the process nor stops the loop); (2) a self-rescheduling `setTimeout` chain with a
// re-entrancy guard (next tick scheduled in the settled `.finally`), NOT raw
// `setInterval`, so a slow/hung sweep can't overlap the next.
//
// ★ START PRE-CONDITIONS ARE A REFUSAL, NOT A SILENT NO-OP (B2C-F6). `resolveReaperConfig`
// returns `refused` when the flag is on but the control-plane URL is missing — a
// silently-dead reaper lets orphans accumulate with zero signal, the exact failure
// Option-A exists to prevent. Flag-OFF is the only clean no-op.

import type { ReaperLogger, ReconcileReaperResult } from "./reconcile-reaper.js";
import { CONTROL_PLANE_URL_ENV } from "./reaper-truth-client.js";

/** Enables the reaper loop. Strict parse: on IFF the trimmed value is exactly "1". Read in
 * the bin via `env[CONST]` (Guards-F3 — never a `process.env.AOA_…` literal). */
export const REAPER_ENABLED_ENV = "AOA_ADAPTER_MANAGER_REAPER_ENABLED";
/** The sweep cadence in ms. */
export const REAPER_INTERVAL_MS_ENV = "AOA_ADAPTER_MANAGER_REAPER_INTERVAL_MS";
/** Default cadence, BELOW the E2B create-TTL (`DEFAULT_TTL_MS = 60_000`, e2b-provider.ts),
 * so a sweep reclaims before the interim TTL backstop. */
export const DEFAULT_REAPER_INTERVAL_MS = 30_000;

/** The resolved reaper start decision. `disabled` is the only clean no-op; `refused` is a
 * loud boot failure (never a silently-dead reaper). */
export type ReaperConfig =
  | { readonly kind: "disabled" }
  | { readonly kind: "enabled"; readonly intervalMs: number; readonly controlPlaneUrl: string }
  | { readonly kind: "refused"; readonly reason: string };

function parseIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_REAPER_INTERVAL_MS;
  const n = Number(raw.trim());
  // Non-positive / unparseable falls back to the default (a positive, finite cadence).
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REAPER_INTERVAL_MS;
  return n;
}

/**
 * Resolve the reaper start decision from the environment. STRICT flag parse: enabled IFF
 * `REAPER_ENABLED_ENV` trims to exactly "1"; unset / "" / "0" / "false" / anything else =
 * disabled (a clean no-op). Flag-on but the control-plane URL missing = a loud refusal.
 */
export function resolveReaperConfig(env: Record<string, string | undefined>): ReaperConfig {
  if (env[REAPER_ENABLED_ENV]?.trim() !== "1") return { kind: "disabled" };
  const controlPlaneUrl = env[CONTROL_PLANE_URL_ENV]?.trim();
  if (controlPlaneUrl === undefined || controlPlaneUrl === "") {
    return {
      kind: "refused",
      reason:
        `${REAPER_ENABLED_ENV}=1 requires ${CONTROL_PLANE_URL_ENV} to name the control-plane ` +
        "service — refusing to start a silently-dead reaper (orphans would accumulate with no signal)",
    };
  }
  return { kind: "enabled", intervalMs: parseIntervalMs(env[REAPER_INTERVAL_MS_ENV]), controlPlaneUrl };
}

/** A cancellable scheduled callback. */
export interface ReaperTimer {
  cancel(): void;
}

/** The injected timer seam (the bin passes a `setTimeout`-backed one; tests a fake). */
export interface ReaperScheduler {
  schedule(callback: () => void, delayMs: number): ReaperTimer;
}

/** The real `setTimeout`-backed scheduler the bin uses. */
export const realReaperScheduler: ReaperScheduler = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  },
};

export interface StartReaperLoopDeps {
  readonly scheduler: ReaperScheduler;
  /** The INJECTED sweep thunk the bin builds (closing over the raw provider, per-op-fresh
   * makeCtx, and B2's resolveTruth). Its rejection is contained here. */
  readonly reconcile: () => Promise<ReconcileReaperResult>;
  readonly logger: ReaperLogger;
  readonly intervalMs: number;
}

/**
 * Arm the self-rescheduling reaper loop. Returns a `stop()` that cancels the pending timer
 * and prevents further ticks. The first tick fires after `intervalMs`; each subsequent tick
 * is scheduled only in the PRIOR tick's settled `.finally`, so ticks can never overlap.
 */
export function startReaperLoop(deps: StartReaperLoopDeps): () => void {
  let stopped = false;
  let running = false;
  let timer: ReaperTimer | null = null;

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = deps.scheduler.schedule(tick, deps.intervalMs);
  };

  const tick = (): void => {
    // Re-entrancy guard — belt-and-suspenders with the self-reschedule (a fake/misbehaving
    // scheduler that double-fires cannot start an overlapping sweep).
    if (stopped || running) return;
    running = true;
    // `Promise.resolve().then(reconcile)` so a SYNCHRONOUS throw in reconcile is also caught.
    Promise.resolve()
      .then(() => deps.reconcile())
      .then((result) => deps.logger.info({ ...result }, "reaper: sweep complete"))
      .catch((err) => deps.logger.error({ err }, "reaper: sweep failed (contained; loop continues)"))
      .finally(() => {
        running = false;
        scheduleNext();
      });
  };

  scheduleNext();
  return () => {
    stopped = true;
    timer?.cancel();
  };
}
