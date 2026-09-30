// Wave-4 — the periodic heartbeat driver.
//
// Beats once immediately, then every `intervalMs`, so the server keeps worker.lastSeenAt +
// target.lastSeenAt fresh and the poll authority admits the worker. Fail-soft: a transient
// failure retries after `retryDelayMs`; a terminal session stops the loop (the daemon stays up
// serving health — the same "healthy and inert" discipline the poll loop uses). The internal
// loop is wrapped so it never rejects out of `firstBeat` or leaks an unhandled rejection.
//
// `firstBeat` lets the boot ORDER the poll loop after a real seed: a poll issued before the
// first heartbeat is denied and returned as `target_revoked`, which the poll loop treats as
// terminal and never retries. See docs/replatform/2026-09-16-worker-daemon-heartbeat-design.md.

import { SessionTerminalError, type SessionProvider } from "./poll-loop.js";
import { sendHeartbeat as defaultSend } from "../identity/worker-heartbeat.js";
import type { DeviceKey } from "../identity/device-key.js";
import type { ControlPlaneClient } from "../transport/client.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import type { Metrics } from "../metrics/metrics.js";
import type { Logger } from "../logging/logger.js";

const HEARTBEAT_OUTCOME_METRIC = "heartbeat_outcome";

export interface HeartbeatLoopDeps {
  readonly session: SessionProvider;
  readonly key: DeviceKey;
  readonly client: ControlPlaneClient;
  /** Steady-state cadence between successful beats (must stay under the poll authority's
   * maxHeartbeatAgeMs, default 5 min server-side). */
  readonly intervalMs: number;
  /** Delay after a transient failure / session-unavailable before retrying. */
  readonly retryDelayMs?: number;
  /** Test seam. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam — the one-shot heartbeat sender. */
  readonly send?: typeof defaultSend;
  readonly metrics?: Metrics;
  readonly logger?: Logger;
}

export interface HeartbeatLoop {
  start(): void;
  stop(): void;
  /** Resolves "ok" on the FIRST successful beat, or "terminal" if the session goes terminal
   * before any success. Resolves at most once. */
  readonly firstBeat: Promise<"ok" | "terminal">;
}

export function createHeartbeatLoop(deps: HeartbeatLoopDeps): HeartbeatLoop {
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        // .unref() so the heartbeat's own timer never keeps the process (or a test runner) alive
        // on its own — the health server + poll loop are what hold the daemon up, not this sleep.
        const t: ReturnType<typeof setTimeout> = setTimeout(r, ms);
        (t as { unref?: () => void }).unref?.();
      }));
  const send = deps.send ?? defaultSend;
  const retryDelayMs = deps.retryDelayMs ?? 5_000;

  // A metrics fault must NEVER break the heartbeat/boot path. `inc` throws on an unregistered label
  // value (metrics.ts keeps a CLOSED `outcome` allow-list), and this loop is fire-and-forget, so an
  // escaping throw would orphan the rejection AND (before settleFirst) strand `firstBeat` unresolved,
  // leaving the poll loop unseeded — the exact failure the heartbeat exists to prevent. The outcome
  // tokens ARE registered, so this only guards against future vocabulary drift.
  const recordOutcome = (outcome: "ok" | "failed" | "terminal" | "session_unavailable"): void => {
    try {
      deps.metrics?.inc(HEARTBEAT_OUTCOME_METRIC, { outcome });
    } catch {
      /* metrics contract fault — never fatal to the daemon */
    }
  };

  let stopped = false;
  let firstResolved = false;
  let resolveFirst!: (v: "ok" | "terminal") => void;
  const firstBeat = new Promise<"ok" | "terminal">((resolve) => {
    resolveFirst = resolve;
  });
  const settleFirst = (v: "ok" | "terminal"): void => {
    if (!firstResolved) {
      firstResolved = true;
      resolveFirst(v);
    }
  };

  async function loop(): Promise<void> {
    try {
      while (!stopped) {
        let session: WorkerSession;
        try {
          session = await deps.session.get();
        } catch (err) {
          if (err instanceof SessionTerminalError) {
            recordOutcome("terminal");
            deps.logger?.warn("worker heartbeat: session terminal; stopping (re-enrollment required)");
            settleFirst("terminal");
            return; // stop: re-enrollment required; daemon stays up inert
          }
          recordOutcome("session_unavailable");
          deps.logger?.warn("worker heartbeat: session unavailable; will retry");
          await sleep(retryDelayMs);
          continue;
        }
        if (stopped) return;

        let outcome: "ok" | "failed";
        try {
          outcome = await send({ client: deps.client, session, key: deps.key });
        } catch {
          outcome = "failed"; // defensive; send is already best-effort
        }
        recordOutcome(outcome);

        if (outcome === "ok") {
          settleFirst("ok");
          await sleep(deps.intervalMs);
        } else {
          deps.logger?.warn("worker heartbeat: beat failed; will retry");
          await sleep(retryDelayMs);
        }
      }
    } catch (err) {
      // Belt-and-suspenders: every await above is already guarded, but a future edit — or an
      // injected `sleep`/`send` that rejects — must still never turn `void loop()` into an unhandled
      // rejection. `firstBeat` is intentionally left pending here (boot stays healthy-and-inert).
      deps.logger?.error({ err }, "worker heartbeat loop crashed; poll loop will not be seeded");
    }
  }

  return {
    start(): void {
      // Fire-and-forget: `loop` never rejects — every await is guarded AND the whole body sits in an
      // outer try/catch, and metric emits go through the swallowing `recordOutcome` — so this can
      // never become an unhandled rejection. A terminal stop leaves the daemon up.
      void loop();
    },
    stop(): void {
      stopped = true;
    },
    firstBeat,
  };
}
