import { spawnTrackedChild, type TrackedChildHandle, type SpawnTrackedChildOptions } from "./server-utils.js";
import { createLoginUrlDetector } from "./login-url-detector.js";

/**
 * Interactive CLI-login runner (Plan 3 / §6.2 Task 3).
 *
 * Spawns `claude login` / `codex login` through {@link spawnTrackedChild} (so
 * the child shares the one kill/registration path the heartbeat reaper knows
 * about), tees stdout+stderr through {@link createLoginUrlDetector}, and hands
 * back the full contract the login lifecycle (Task 4) needs:
 *
 *  - `handle`      — the TrackedChildHandle (pid/pgid/terminate) to persist + reap.
 *  - `urlPromise`  — resolves with the verification URL on first detection;
 *                    rejects with `no-url` if the child exits first, with the
 *                    spawn `error`, or with `login-url-timeout` after the
 *                    discovery window.
 *  - `exitPromise` — resolves with the child's exit code (null on spawn error)
 *                    so the lifecycle can mark completed/failed.
 *
 * The runner owns the child's `close`/`error` listeners and clears the
 * discovery timer as soon as the URL is found (Codex P2 #6).
 */

export interface StreamingLoginResult {
  handle: TrackedChildHandle;
  urlPromise: Promise<string>;
  exitPromise: Promise<number | null>;
  /**
   * Write a pasted auth code to the child's stdin.
   *
   * Claude's flow REQUIRES this: `claude auth login` prints its URL and then
   * blocks on "Paste code here". Codex self-completes via a local callback and
   * never needs it. Returns false when stdin was not piped or the child has
   * already gone, so the caller can report an honest error instead of hanging —
   * a silent no-op here is the exact failure this feature removes.
   */
  submitCode(code: string): boolean;
}

export interface RunStreamingLoginOptions {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Reject `urlPromise` if no URL is seen within this window. Default 120s. */
  discoveryTimeoutMs?: number;
  /** Extra parent-env keys to strip (forwarded to spawnTrackedChild). */
  unsetEnvKeys?: string[];
  /** Extra parent-env key PREFIXES to strip (forwarded to spawnTrackedChild). */
  unsetEnvPrefixes?: string[];
  /**
   * stdin disposition. Defaults to "ignore" — codex's device flow needs no
   * input, and leaving its spawn byte-identical keeps a working flow risk-free.
   * Claude passes "pipe" because its login blocks reading a pasted code.
   */
  stdin?: "ignore" | "pipe";
  /** DI seam — defaults to the real spawnTrackedChild. */
  spawn?: (
    runId: string,
    command: string,
    args: string[],
    opts: SpawnTrackedChildOptions,
  ) => TrackedChildHandle;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 120_000;

export function runStreamingLogin(opts: RunStreamingLoginOptions): StreamingLoginResult {
  const spawnFn = opts.spawn ?? spawnTrackedChild;
  const handle = spawnFn(opts.runId, opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    graceSec: 5,
    unsetEnvKeys: opts.unsetEnvKeys,
    unsetEnvPrefixes: opts.unsetEnvPrefixes,
    // stdin defaults to ignored (codex's device flow needs none); callers that
    // must answer a "paste code here" prompt (claude) opt in via opts.stdin.
    // stdout+stderr are always piped for URL detection.
    stdio: [opts.stdin ?? "ignore", "pipe", "pipe"],
  });

  const child = handle.child;
  // stdout and stderr are independent byte streams. Combining them lets a
  // delimiter from one stream terminate a partial URL still being written on
  // the other, so keep parser state isolated and settle on the first real URL.
  const stdoutDetector = createLoginUrlDetector();
  const stderrDetector = createLoginUrlDetector();

  // A-H11 precedent (server-utils.ts spawnTrackedChild): an unhandled 'error'
  // on a writable throws as an UNCAUGHT exception, and this server has no
  // uncaughtException handler — a single EPIPE (e.g. the CLI exits/times out
  // while the founder is still typing a pasted code) would take the whole
  // process down. Attach the no-op listener once, up front, not per
  // submitCode call — repeated attaches would leak listeners.
  child.stdin?.on?.("error", () => {});

  let settled = false;
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (err: Error) => void;
  const urlPromise = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });

  let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const clearDiscoveryTimer = (): void => {
    if (discoveryTimer !== undefined) {
      clearTimeout(discoveryTimer);
      discoveryTimer = undefined;
    }
  };

  const onData = (detector: ReturnType<typeof createLoginUrlDetector>) =>
    (chunk: Buffer | string): void => {
      if (settled) return;
      const url = detector.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      if (url !== null) {
        settled = true;
        clearDiscoveryTimer();
        resolveUrl(url);
      }
    };
  child.stdout?.on("data", onData(stdoutDetector));
  child.stderr?.on("data", onData(stderrDetector));

  discoveryTimer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectUrl(new Error("login-url-timeout"));
    }
  }, opts.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
  // Never keep the event loop alive solely for the discovery timer.
  discoveryTimer.unref?.();

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("close", (code: number | null) => {
      clearDiscoveryTimer();
      if (!settled) {
        settled = true;
        rejectUrl(new Error("no-url"));
      }
      resolve(code);
    });
    child.on("error", (err: Error) => {
      clearDiscoveryTimer();
      if (!settled) {
        settled = true;
        rejectUrl(err);
      }
      resolve(null);
    });
  });

  const submitCode = (code: string): boolean => {
    const stdin = child.stdin;
    if (!stdin || stdin.writable === false) return false;
    try {
      stdin.write(`${code}\n`);
    } catch {
      // Synchronous write failure (e.g. write-after-end / destroyed) — benign,
      // mirrors the try/catch around the stdin write in spawnTrackedChild's
      // caller (server-utils.ts, A-H11).
      return false;
    }
    return true;
  };

  return { handle, urlPromise, exitPromise, submitCode };
}
