// packages/worker-keystore/src/control-effects.ts
//
// DSK-003 Lane A — the production control effects: the last composition step.
//
// Four properties carry the weight here, and three are about what these must NOT do.
//
// SIGTERM, NEVER SIGKILL. The daemon's shutdown handler is what performs
// lease-stop → renewal-stop → drain → outbox → health, in that order
// (`worker-daemon/src/lifecycle/shutdown.ts`). SIGKILL skips every step: leases stay held
// until the server reaps them and the outbox never flushes. A `drain` that killed would
// be the exact opposite of draining.
//
// THE PROBE IS LOOPBACK BY CONSTRUCTION. The state record carries a PORT and no host, so
// a tampered record cannot redirect the instance probe at a remote server. The host is a
// literal here and a test asserts it stays one — the moment it becomes a field, the
// stale-pid defence turns into an SSRF.
//
// STATUS CARRIES NO TOKEN. `status` needs no authorization, so anything it returns is
// readable by any caller able to run the binary. It projects the record's fields and
// nothing about the token — not its value and not its path.
//
// AN ABSENT LOG IS SAID, NOT FAKED. Returning `""` would read as "the host logged
// nothing", which is a different and far more alarming statement than "there is no log
// file on this platform". On Windows there is genuinely no target: Task Scheduler cannot
// redirect and the host does not yet open its own file (see `install/autostart.ts`).
//
// Every outward call is injected, so all four properties are provable without a process,
// a socket, or a filesystem.

import type { ControlPaths } from "./control-paths.js";

/** The shape `readHostState` returns, restated so this module needs no daemon import
 * for a type it only reads. */
type HostStateRead =
  | { readonly ok: true; readonly record: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

export interface DesktopControlEffectDeps {
  readonly paths: ControlPaths;
  readonly platform: NodeJS.Platform | string;
  /** `process.kill`, injected. */
  kill(pid: number, signal: string): void;
  /** GET the loopback `/instance` endpoint and parse it. */
  fetchInstance(url: string): Promise<{ instanceId?: string }>;
  /** `readHostState(statePath)`, injected. */
  readHostStateAt(): HostStateRead;
  /** Read the platform's log file, when it has one. Absent means it has none. */
  readLogFile?: () => string;
}

export interface DesktopControlEffects {
  signal(pid: number): Promise<void>;
  resolveTarget(): Promise<{ ok: true; pid: number } | { ok: false; reason: string }>;
  readStatus(): Promise<unknown>;
  readLogTail(): Promise<string>;
}

/** The only host this process will ever probe. A literal, deliberately — see the header. */
const LOOPBACK = "127.0.0.1";

export function createDesktopControlEffects(
  deps: DesktopControlEffectDeps,
): DesktopControlEffects {
  return {
    async signal(pid: number): Promise<void> {
      // Ask, do not kill. The ordering guarantees live in the daemon's shutdown handler.
      deps.kill(pid, "SIGTERM");
    },

    async resolveTarget() {
      const state = deps.readHostStateAt();
      if (!state.ok) return { ok: false as const, reason: state.reason };

      const port = state.record.healthPort;
      if (typeof port !== "number") return { ok: false as const, reason: "malformed_record" };

      let live: { instanceId?: string };
      try {
        // The host is a LITERAL. Nothing from the record contributes to it.
        live = await deps.fetchInstance(`http://${LOOPBACK}:${port}/instance`);
      } catch {
        return { ok: false as const, reason: "host_not_responding" };
      }
      if (live?.instanceId !== state.record.instanceId) {
        return { ok: false as const, reason: "instance_mismatch" };
      }
      const pid = state.record.pid;
      if (typeof pid !== "number") return { ok: false as const, reason: "malformed_record" };
      return { ok: true as const, pid };
    },

    async readStatus(): Promise<unknown> {
      const state = deps.readHostStateAt();
      if (!state.ok) return { running: false, reason: state.reason };
      // Built by NAMING each field — never by spreading the record — so a future field
      // cannot arrive in an unauthenticated response by default.
      return {
        running: true,
        pid: state.record.pid,
        healthPort: state.record.healthPort,
        startedAt: state.record.startedAt,
        version: state.record.version,
      };
    },

    async readLogTail(): Promise<string> {
      if (!deps.readLogFile) {
        return `no log file on ${String(deps.platform)}; the host writes to its service manager`;
      }
      try {
        return deps.readLogFile();
      } catch (err) {
        return `could not read the log file: ${(err as Error).message}`;
      }
    },
  };
}
