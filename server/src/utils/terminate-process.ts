import { spawnSync } from "node:child_process";

/**
 * Cross-platform terminate-by-PID primitive (Plan 3 / §6.2 Task 4, Codex P1 #9).
 *
 * The heartbeat reaper only marks DB rows failed; it cannot kill a *detached*
 * login child that survived a hard restart (its in-memory TrackedChildHandle —
 * and thus `terminate()` — is gone). So the login lifecycle persists pid/pgid
 * and, on `cancel`/`reapOrphans`, kills by PID here:
 *
 *  - POSIX: the login child is spawned `detached` (own process group, pgid===pid),
 *    so `process.kill(-pgid, "SIGKILL")` reaps the whole group (CLI + any helper
 *    it forked). Falls back to the bare pid when pgid is unknown.
 *  - Windows: `taskkill /PID <pid> /T /F` kills the tree forcefully.
 *
 * Never throws — a dead process (ESRCH) is the success case for a reaper.
 * The `platform`/`kill`/`runTaskkill` seams exist so the branch selection is
 * unit-testable without spawning anything.
 *
 * PID-REUSE (Codex P1, round 6 → round 7): `terminateByPid` kills
 * UNCONDITIONALLY, so it is safe ONLY for a pid we KNOW is live in the current
 * process. Every kill of a PERSISTED pid — the BOOT `reapOrphans`, the
 * single-flight takeover in `onExisting`, AND `cancel` — must go through
 * {@link terminateByPidIfMatches}, because a pid persisted to a DB row may have
 * been reused by an unrelated process after a crash + restart, and killing it
 * would hit an arbitrary victim. `terminateByPidIfMatches` verifies the target's
 * OS start time against the recorded `startedAt` before signalling. In the
 * commander-login lifecycle the only remaining UNCONDITIONAL kills are the LIVE
 * in-memory `run.handle.terminate()` handles (this process's own child), which
 * do not use this pid-based primitive at all.
 */
export interface TerminateByPidDeps {
  platform?: NodeJS.Platform;
  kill?: (pidOrGroup: number, signal: NodeJS.Signals | number) => void;
  runTaskkill?: (command: string, args: string[]) => void;
}

export function terminateByPid(pid: number, pgid: number | null, deps: TerminateByPidDeps = {}): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const platform = deps.platform ?? process.platform;

  if (platform === "win32") {
    const runTaskkill = deps.runTaskkill ?? ((command, args) => void spawnSync(command, args));
    try {
      runTaskkill("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      // Process already gone / taskkill unavailable — reaper best-effort.
    }
    return;
  }

  const kill = deps.kill ?? ((target, signal) => process.kill(target, signal));
  const target = pgid != null && Number.isFinite(pgid) && pgid > 0 ? -pgid : pid;
  try {
    kill(target, "SIGKILL");
  } catch {
    // ESRCH (already dead) or EPERM — nothing to reap.
  }
}

/** Recorded identity of the process we intend to reap. */
export interface ProcessStartIdentity {
  /** When the login lifecycle recorded the challenge start (row.startedAt). The
   *  genuine child spawns at/just after this instant; a reused-pid process
   *  started materially LATER (after the crash + restart gap). */
  startedAt: Date;
}

export interface TerminateIfMatchesDeps extends TerminateByPidDeps {
  /**
   * Query the OS start time of `pid`. Returns the process's creation timestamp,
   * or `null` when it CANNOT be established (process gone, access denied, query
   * tool unavailable, unparseable output). Injected so the reaper decision is
   * unit-testable without spawning real processes; the default uses `spawnSync`
   * (`ps` on POSIX, PowerShell on win32).
   */
  queryStartTime?: (pid: number) => Date | null;
  /**
   * A queried start time within this many ms of `startedAt` is treated as the
   * SAME process. Covers spawn latency + coarse OS start-time granularity
   * (`ps -o lstart` is 1s). Small on purpose: a real crash+restart gap is many
   * seconds, so a tight window still spares the genuine orphan while refusing to
   * kill a pid that clearly started later.
   */
  toleranceMs?: number;
}

const DEFAULT_START_MATCH_TOLERANCE_MS = 2_000;

export type ProcessStartIdentityMatch = "matching" | "different" | "unknown";

/**
 * Classify a persisted PID without signalling it. Startup reconciliation must
 * distinguish a confirmed reused PID from an identity that cannot be checked.
 */
export function inspectProcessStartIdentity(
  pid: number,
  expected: ProcessStartIdentity,
  deps: TerminateIfMatchesDeps = {},
): ProcessStartIdentityMatch {
  if (!Number.isFinite(pid) || pid <= 0) return "unknown";
  const platform = deps.platform ?? process.platform;
  const queryStartTime = deps.queryStartTime ?? defaultQueryStartTime(platform);

  let startTime: Date | null;
  try {
    startTime = queryStartTime(pid);
  } catch {
    startTime = null;
  }
  if (!startTime || Number.isNaN(startTime.getTime())) return "unknown";

  const tolerance = deps.toleranceMs ?? DEFAULT_START_MATCH_TOLERANCE_MS;
  return startTime.getTime() > expected.startedAt.getTime() + tolerance
    ? "different"
    : "matching";
}

/**
 * Identity-verifying terminate for the BOOT reaper (Codex P1, round 6 —
 * PID reuse). Kills `pid`/`pgid` ONLY when the target process's OS start time is
 * consistent with `expected.startedAt`:
 *
 *  - start time > startedAt + tolerance  → a DIFFERENT, reused-pid process → skip.
 *  - start time ≤ startedAt + tolerance  → our genuine child → terminate.
 *  - start time unestablished (null/NaN) → CONSERVATIVE skip (Codex-approved):
 *    killing an unverifiable pid is the exact harm; not-killing only risks
 *    leaving a (likely-already-dead) orphan, which is the safer failure.
 *
 * Returns whether a kill was issued (observability). Never throws.
 */
export function terminateByPidIfMatches(
  pid: number,
  pgid: number | null,
  expected: ProcessStartIdentity,
  deps: TerminateIfMatchesDeps = {},
): boolean {
  if (inspectProcessStartIdentity(pid, expected, deps) !== "matching") return false;

  terminateByPid(pid, pgid, deps);
  return true;
}

/**
 * Default `queryStartTime` seam. Best-effort + never-throw is enforced by the
 * caller's try/catch and the parsers returning `null` on any surprise.
 *
 *  - POSIX: `ps -o lstart= -p <pid>` → e.g. `Wed Jul 17 10:23:45 2026` (local tz,
 *    1s granularity), parsed by `Date`.
 *  - win32: PowerShell `Get-Process` (wmic is REMOVED on Windows 11 24H2+),
 *    emitting an ISO-8601 round-trip UTC string that `Date` parses natively.
 *    Access-denied / exited pids yield empty output → null → conservative skip.
 */
function defaultQueryStartTime(platform: NodeJS.Platform): (pid: number) => Date | null {
  if (platform === "win32") {
    return (pid) => {
      const res = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { '' }`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      return parseProcessStartTime(res.stdout ?? "");
    };
  }
  return (pid) => {
    const res = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    return parseProcessStartTime(res.stdout ?? "");
  };
}

/**
 * Parse the raw stdout of the start-time query into a `Date`, or `null` when it
 * is empty/unparseable. `Date` handles both the `ps lstart` form
 * (`Wed Jul 17 10:23:45 2026`, day-of-week ignored) and the PowerShell ISO form
 * (`2026-07-17T10:23:45.1234567Z`). Exported for unit tests.
 */
export function parseProcessStartTime(raw: string): Date | null {
  const text = raw.trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
