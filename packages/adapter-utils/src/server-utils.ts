import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterSkillEntry, AdapterSkillSnapshot } from "./types.js";
// Env secret redaction lives in the browser-safe shared package so the UI
// (ui/src/lib/env-redaction.ts) and the adapters share ONE source of truth
// for the key regex + value patterns. Re-exported here so existing
// `@armyofagents/adapter-utils/server-utils` importers (every adapter
// execute.ts + server/src/adapters/utils.ts) keep working unchanged.
import { redactEnvForLogs, looksLikeSecretValue } from "@armyofagents/shared";
export { redactEnvForLogs, looksLikeSecretValue };

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
  /** POSIX process-group id captured at spawn; null on Windows. Equals child.pid when spawned with detached:true. */
  processGroupId: number | null;
}

// ---------------------------------------------------------------------------
// Platform-aware process-tree helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the POSIX process-group id for a freshly spawned child.
 *
 * Assumes the child was spawned with `detached: true` on POSIX, which
 * causes the OS to put the child in its own new process group with
 * pgid === pid. Returns null on Windows (no process groups) or when
 * the child failed to spawn (no pid).
 *
 * Replaces the older safeGetPgid which called process.getpgid(pid)
 * — that API was never exposed by Node and always threw a TypeError.
 */
export function resolveProcessGroupId(child: ChildProcess): number | null {
  if (process.platform === "win32") return null;
  return typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
}

/**
 * Hard-kill a Windows process TREE via `taskkill /PID <pid> /T /F`.
 *
 * On Windows the supervised CLI is a grandchild: heartbeat spawns children with
 * `shell: true` (to run .cmd wrappers), so the direct `child` is the cmd.exe
 * wrapper and the real agent CLI is a grandchild. `child.kill()` only signals the
 * wrapper, orphaning the CLI (which keeps the inherited stdio pipes open, so the
 * adapter `await` never resolves). `taskkill /T` addresses the whole tree.
 *
 * Fire-and-forget (no shell — the args are fixed, not user input). `/F` is a hard
 * TerminateProcess with no graceful window; that matches the previous behavior
 * (`child.kill` was already a hard TerminateProcess on Windows). A missing pid
 * (already-exited tree) exits taskkill with code 128 — swallowed here; the
 * `error` listener swallows a spawn failure (e.g. taskkill not on PATH) so a
 * cancel can never crash the server. Returns true when a taskkill was launched.
 */
function killWindowsProcessTree(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      // No shell: fixed args, avoids any quoting/injection surface.
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    // Swallow a spawn failure (ENOENT if taskkill is somehow missing) and the
    // exit-128 "process not found" case — both are fire-and-forget no-ops.
    killer.on("error", () => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal a running process or its process group.
 *
 * POSIX with a valid processGroupId:
 *   sends the signal to -processGroupId (negative PID), which addresses
 *   the entire process group, killing the parent and all its children.
 *   Falls back to signaling the child directly if the group signal
 *   fails (e.g., the parent has already died but its children
 *   re-parented to init).
 *
 * Windows:
 *   shells out to `taskkill /PID <pid> /T /F` to hard-kill the ENTIRE process
 *   tree (parent + grandchildren). Windows has no graceful signal, so BOTH the
 *   TERM and KILL escalation steps map to the same forceful taskkill — a
 *   cancelled agent CLI gets no graceful-shutdown window (it never got one:
 *   child.kill was already TerminateProcess). Falls back to child.kill only when
 *   there is no pid (spawn failed) — nothing else to address.
 *
 * Caller is responsible for the SIGTERM → SIGKILL escalation timer.
 *
 * Reference impl: paperclip-master/packages/adapter-utils/src/server-utils.ts:57-72
 */
export function signalRunningProcess(
  running: Pick<RunningProcess, "child" | "processGroupId">,
  signal: NodeJS.Signals,
): void {
  if (process.platform === "win32") {
    // Tree-kill via taskkill for both TERM and KILL requests. If there is no
    // pid (spawn never succeeded) fall through to the direct child.kill below.
    const pid = running.child.pid;
    if (typeof pid === "number" && pid > 0) {
      killWindowsProcessTree(pid);
      return;
    }
    if (!running.child.killed) {
      running.child.kill(signal);
    }
    return;
  }
  if (running.processGroupId && running.processGroupId > 0) {
    try {
      process.kill(-running.processGroupId, signal);
      return;
    } catch {
      // Fall back to the direct child signal if group signaling fails.
    }
  }
  if (!running.child.killed) {
    running.child.kill(signal);
  }
}

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

export const runningProcesses = new Map<string, RunningProcess>();
const pendingProcessTerminations = new Map<string, number>();
const PROCESS_TERMINATION_TOMBSTONE_MS = 60 * 60 * 1000;
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 32 * 1024;

function pruneProcessTerminationTombstones(now = Date.now()): void {
  for (const [runId, expiresAt] of pendingProcessTerminations) {
    if (expiresAt <= now) pendingProcessTerminations.delete(runId);
  }
}

function terminateRegisteredProcess(runId: string, running: RunningProcess): void {
  signalRunningProcess(running, "SIGTERM");
  if (process.platform === "win32" && !running.child.killed) {
    // taskkill is fire-and-forget, so starting it is not proof that a child
    // which has only just registered is already addressable by PID. Terminate
    // the tracked parent directly as well; taskkill remains responsible for
    // descendants, while this closes the spawn-to-taskkill race for the parent.
    running.child.kill("SIGTERM");
  }
  const graceMs = Math.max(1, running.graceSec) * 1000;
  const timer = setTimeout(() => {
    const stillRunning = runningProcesses.get(runId);
    if (stillRunning) signalRunningProcess(stillRunning, "SIGKILL");
  }, graceMs);
  timer.unref?.();
}

/**
 * Records cancellation even when the child has not registered yet. This closes
 * the checkout-to-spawn race: spawnTrackedChild observes the tombstone before
 * callers can write stdin, while already-registered children are terminated now.
 */
export function requestTrackedProcessTermination(runId: string): void {
  pruneProcessTerminationTombstones();
  pendingProcessTerminations.set(runId, Date.now() + PROCESS_TERMINATION_TOMBSTONE_MS);
  const running = runningProcesses.get(runId);
  if (running) terminateRegisteredProcess(runId, running);
}

export async function waitForTrackedProcessExit(runId: string): Promise<boolean> {
  const running = runningProcesses.get(runId);
  if (!running) return true;
  const deadline = Date.now() + Math.max(1, running.graceSec) * 1000 + 2_000;
  while (runningProcesses.has(runId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !runningProcesses.has(runId);
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

export function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

export function buildAoaEnv(agent: { id: string; companyId: string }): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const vars: Record<string, string> = {
    AOA_AGENT_ID: agent.id,
    AOA_COMPANY_ID: agent.companyId,
  };
  const runtimeHost = resolveHostForUrl(
    process.env.AOA_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.AOA_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl = process.env.AOA_API_URL ?? `http://${runtimeHost}:${runtimePort}`;
  vars.AOA_API_URL = apiUrl;
  return vars;
}

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

export async function ensureCommandResolvable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    try {
      await fs.access(absolute, fsConstants.X_OK);
    } catch {
      throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
    }
    return;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const windowsExt = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const dir of dirs) {
    for (const ext of windowsExt) {
      const candidate = path.join(dir, process.platform === "win32" ? `${command}${ext}` : command);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return;
      } catch {
        // continue scanning PATH
      }
    }
  }

  throw new Error(`Command not found in PATH: "${command}"`);
}

/**
 * Case-folding for environment-variable NAMES.
 *
 * Windows env names are case-insensitive — `Claude_Config_Dir` IS
 * `CLAUDE_CONFIG_DIR`, one variable — while POSIX names are case-sensitive and
 * must never be folded together.
 *
 * Exported because `mergeChildEnv`'s strip is not the only place that has to
 * compare env keys: claude-local reads the overlay for a configured
 * `CLAUDE_CONFIG_DIR` and for configured auth, and both comparisons must agree
 * with the strip's. A private second copy of this rule drifts silently, and the
 * drift only shows up as a Windows-only bug — so the rule is one function and
 * the strip below uses it too.
 */
export function foldEnvKey(key: string): string {
  return process.platform === "win32" ? key.toLowerCase() : key;
}

/**
 * Build a child-process environment from the parent env + an overlay, with an
 * opt-in strip of inherited keys. A key in `unsetEnvKeys` is removed from the
 * result ONLY if the overlay did not set it — so an agent's own value (even an
 * explicit empty string) survives while an ambient (server-process) value is
 * dropped. Used to keep the AoA server's OPENAI_API_KEY out of agent runs
 * (codex opts in); default behavior (no `unsetEnvKeys`) is unchanged.
 *
 * `unsetEnvPrefixes` applies the SAME rule to a whole prefix CLASS (D9 — crew
 * ambient-config isolation strips `CLAUDE_`/`ANTHROPIC_` so a crew run inherits
 * nothing from the operator's host Claude setup). A prefix rather than an
 * enumerated list because an enumeration silently leaks any newly-introduced
 * variable. Also additive: no prefixes ⇒ behavior identical to before.
 */
export function mergeChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  overlayEnv: Record<string, string>,
  unsetEnvKeys?: string[],
  unsetEnvPrefixes?: string[],
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...parentEnv, ...overlayEnv };
  // Windows env var names are case-insensitive: deleting only the exact-cased
  // `OPENAI_API_KEY` would leave a differently-cased ambient value (e.g.
  // `OpenAI_API_KEY`) in place, so the codex child still inherits the server key
  // and the api-key auth/billing leak this strip prevents returns (Codex P2).
  // Match case-insensitively on Windows, exact elsewhere (POSIX env IS
  // case-sensitive — don't drop a legitimately distinct var there). Delegates to
  // the exported `foldEnvKey` so the adapters that must agree with this strip
  // share the rule rather than reimplementing it.
  const sameKey = (a: string, b: string) => foldEnvKey(a) === foldEnvKey(b);
  for (const key of unsetEnvKeys ?? []) {
    // The exact key(s) the overlay set itself survive (an agent's own key — even
    // an explicit empty string — wins). Any OTHER matching-cased key is an
    // ambient (server-process) value and is dropped. Deleting the differently-
    // cased ambient key matters on Windows, where it is the SAME variable.
    const overlayKeys = new Set(Object.keys(overlayEnv).filter((k) => sameKey(k, key)));
    for (const mergedKey of Object.keys(merged)) {
      if (sameKey(mergedKey, key) && !overlayKeys.has(mergedKey)) delete merged[mergedKey];
    }
  }
  // Prefix class — deliberately built on the SAME `sameKey` case-folding (a
  // second comparison rule would drift from the exact-key strip above, and the
  // Windows case-insensitivity is exactly what makes `Claude_Config_Dir` and
  // `CLAUDE_CONFIG_DIR` one variable). Overlay-set keys survive identically.
  const hasPrefix = (candidate: string, prefix: string) =>
    candidate.length >= prefix.length && sameKey(candidate.slice(0, prefix.length), prefix);
  for (const prefix of unsetEnvPrefixes ?? []) {
    // An empty prefix matches EVERY key — it would wipe the child's whole
    // environment. Skip it: the asymmetry with unsetEnvKeys (where an empty
    // entry deletes at most a literal "" key) makes this a live footgun for a
    // caller building the list dynamically.
    if (prefix.length === 0) continue;
    const overlayKeys = new Set(Object.keys(overlayEnv).filter((k) => hasPrefix(k, prefix)));
    for (const mergedKey of Object.keys(merged)) {
      if (hasPrefix(mergedKey, prefix) && !overlayKeys.has(mergedKey)) delete merged[mergedKey];
    }
  }
  return merged;
}

/**
 * Run-scoped bearer env keys that MUST NOT reach a third-party stdio connector
 * child. `AOA_API_KEY` (raw REST as the agent) + its `PAPERCLIP_*` wire alias,
 * and `AOA_RUNTIME_HOOK_TOKEN` (answers/forges runtime permission prompts).
 */
export const CONNECTOR_STRIPPED_RUN_BEARER_KEYS = [
  "AOA_API_KEY",
  "PAPERCLIP_API_KEY",
  "AOA_RUNTIME_HOOK_TOKEN",
] as const;

/**
 * WS1 — on a connector-attached run the vendor CLI passes its FULL environment
 * to every stdio connector child (empirically confirmed for Claude Code: a probe
 * child received `AOA_API_KEY` + an unrelated sentinel). AoA injects the run
 * bearers as an OVERLAY, and `mergeChildEnv` deliberately PRESERVES overlay keys
 * past the ambient scrub — so the only reliable removal is to delete them from
 * the overlay itself, BEFORE the merge.
 *
 * Mutates `overlayEnv` in place. Deletes by KEY (case-folded, incl. the
 * `PAPERCLIP_` alias) AND by VALUE — a connector could otherwise inherit the
 * token under an arbitrarily-named configured key carrying the same value
 * (Codex plan-review finding). No-op when no connectors are present, so
 * no-connector runs stay byte-identical.
 */
export function stripConnectorRunBearers(
  overlayEnv: Record<string, string>,
  opts: { connectorsPresent: boolean; secretValues?: Array<string | null | undefined> },
): void {
  if (!opts.connectorsPresent) return;
  const strippedKeys = new Set(CONNECTOR_STRIPPED_RUN_BEARER_KEYS.map((k) => foldEnvKey(k)));
  const strippedValues = new Set(
    (opts.secretValues ?? []).filter((v): v is string => typeof v === "string" && v.length > 0),
  );
  for (const key of Object.keys(overlayEnv)) {
    if (strippedKeys.has(foldEnvKey(key)) || strippedValues.has(overlayEnv[key])) {
      delete overlayEnv[key];
    }
  }
}

// ---------------------------------------------------------------------------
// spawnTrackedChild — single source of truth for spawning a child that is
// registered in `runningProcesses` (so heartbeat.cancelRun + reapOrphanedRuns
// can find it), inherits the same env-strip / spawn flags, and offers a
// SIGTERM→SIGKILL terminate(). Both the `exec` path (runChildProcess, layered
// collect-to-EOF on top) and the long-lived codex app-server driver spawn
// through this so their children share ONE registration + kill semantics.
// ---------------------------------------------------------------------------

export interface TrackedChildHandle {
  child: ChildProcess;
  pid: number | null;
  pgid: number | null;
  startedAt: Date;
  /** SIGTERM then, after graceSec, SIGKILL. Idempotent; safe after close. */
  terminate(): void;
}

export interface SpawnTrackedChildOptions {
  cwd: string;
  env: Record<string, string>;
  graceSec: number;
  /** Keys to strip from the inherited parent env unless `env` set them. */
  unsetEnvKeys?: string[];
  /** Key PREFIXES to strip from the inherited parent env unless `env` set them. */
  unsetEnvPrefixes?: string[];
  /** stdio layout; drivers use ["pipe","pipe","pipe"] to keep JSON-RPC bidirectional. */
  stdio?: import("node:child_process").StdioOptions;
  shell?: boolean;
}

export function spawnTrackedChild(
  runId: string,
  command: string,
  args: string[],
  opts: SpawnTrackedChildOptions,
): TrackedChildHandle {
  const mergedEnv = ensurePathInEnv(
    mergeChildEnv(process.env, opts.env, opts.unsetEnvKeys, opts.unsetEnvPrefixes),
  );
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: mergedEnv,
    // Windows requires shell:true to execute .cmd wrappers for npm-installed CLIs.
    // The `command` value comes from trusted adapter configuration, not user input.
    shell: opts.shell ?? process.platform === "win32",
    // detached:true on POSIX puts the child in its own process group (pgid === pid),
    // so signalRunningProcess can address the whole group via process.kill(-pgid, signal)
    // and reap any subprocesses spawned by the child.
    detached: process.platform !== "win32",
    stdio: opts.stdio ?? ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithEvents;

  const pid = child.pid ?? null;
  const pgid = resolveProcessGroupId(child);
  const startedAt = new Date();

  runningProcesses.set(runId, { child, graceSec: opts.graceSec, processGroupId: pgid });

  child.on("close", () => {
    runningProcesses.delete(runId);
    pendingProcessTerminations.delete(runId);
  });

  pruneProcessTerminationTombstones();
  if (pendingProcessTerminations.has(runId)) {
    terminateRegisteredProcess(runId, runningProcesses.get(runId)!);
  }
  child.on("error", () => {
    runningProcesses.delete(runId);
    pendingProcessTerminations.delete(runId);
  });

  const terminate = (): void => {
    // Signal the group/child now; escalate to SIGKILL after the grace window
    // ONLY if the process is still registered (i.e. it hasn't already closed).
    signalRunningProcess({ child, processGroupId: pgid }, "SIGTERM");
    setTimeout(() => {
      if (runningProcesses.has(runId)) {
        signalRunningProcess({ child, processGroupId: pgid }, "SIGKILL");
      }
    }, Math.max(1, opts.graceSec) * 1000);
  };

  return { child, pid, pgid, startedAt, terminate };
}

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onLogError?: (err: unknown, runId: string, message: string) => void;
    stdin?: string;
    /**
     * Called once immediately after the child process spawns, before any
     * stdin is written.  Callers can use this to persist PID / PGID to a
     * database row so that an out-of-process watchdog can kill the group.
     */
    onSpawn?: (pid: number | null, pgid: number | null, startedAt: Date) => void;
    shell?: boolean;
    /** Keys to strip from the inherited parent env (unless `env` set them). */
    unsetEnvKeys?: string[];
    /** Key PREFIXES to strip from the inherited parent env (unless `env` set them). */
    unsetEnvPrefixes?: string[];
  },
): Promise<RunProcessResult> {
  const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));

  return new Promise<RunProcessResult>((resolve, reject) => {
    // Same merged env spawnTrackedChild will build — captured here only so the
    // ENOENT error message can report the effective PATH (kept identical to the
    // pre-refactor behavior).
    const mergedEnv = ensurePathInEnv(
      mergeChildEnv(process.env, opts.env, opts.unsetEnvKeys, opts.unsetEnvPrefixes),
    );
    // spawnTrackedChild owns spawn flags, the env-strip, the runningProcesses
    // registration/deregistration, and the SIGTERM→SIGKILL escalation. The exec
    // path layers stdin-write / stdout-capture / close-resolve on top; net
    // behavior is unchanged (stdio matches the pre-refactor exec layout).
    const handle = spawnTrackedChild(runId, command, args, {
      cwd: opts.cwd,
      env: opts.env,
      graceSec: opts.graceSec,
      unsetEnvKeys: opts.unsetEnvKeys,
      unsetEnvPrefixes: opts.unsetEnvPrefixes,
      shell: opts.shell,
      stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const child = handle.child as ChildProcessWithEvents;
    const spawnedPgid = handle.pgid;

    // Notify caller before writing stdin so they can persist the PID/PGID.
    if (opts.onSpawn) {
      opts.onSpawn(handle.pid, spawnedPgid, handle.startedAt);
    }

    if (opts.stdin != null && child.stdin) {
      // EPIPE / ERR_STREAM_DESTROYED here is benign: the child exited before we
      // finished writing stdin. The close handler still resolves with the captured
      // exit code. Swallow it — an unhandled 'error' on a writable crashes the process.
      child.stdin.on("error", () => {});
      try {
        child.stdin.write(opts.stdin);
        child.stdin.end();
      } catch {
        // synchronous throw (e.g. write-after-end / destroyed) — also benign here
      }
    }

    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let logChain: Promise<void> = Promise.resolve();

    const timeout =
      opts.timeoutSec > 0
        ? setTimeout(() => {
            timedOut = true;
            // Reuse the tracked handle's SIGTERM→SIGKILL escalation.
            handle.terminate();
          }, opts.timeoutSec * 1000)
        : null;

    child.stdout?.on("data", (chunk: unknown) => {
      const text = String(chunk);
      stdout = appendWithCap(stdout, text);
      logChain = logChain
        .then(() => opts.onLog("stdout", text))
        .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"));
    });

    child.stderr?.on("data", (chunk: unknown) => {
      const text = String(chunk);
      stderr = appendWithCap(stderr, text);
      logChain = logChain
        .then(() => opts.onLog("stderr", text))
        .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"));
    });

    child.on("error", (err: Error) => {
      if (timeout) clearTimeout(timeout);
      // runningProcesses.delete already handled by spawnTrackedChild's error listener.
      const errno = (err as NodeJS.ErrnoException).code;
      const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
      const msg =
        errno === "ENOENT"
          ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
          : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
      reject(new Error(msg));
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timeout) clearTimeout(timeout);
      // runningProcesses.delete already handled by spawnTrackedChild's close listener.
      void logChain.finally(() => {
        resolve({
          exitCode: code,
          signal,
          timedOut,
          stdout,
          stderr,
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Skills helpers + wake-payload helpers + log-friendly command resolution
// (ported from Paperclip adapter-utils/server-utils.ts)
// ---------------------------------------------------------------------------

const AOA_SKILL_ROOT_RELATIVE_CANDIDATES = [
  "../../skills",
  "../../../../../skills",
];

export interface AoaSkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  required?: boolean;
  requiredReason?: string | null;
}
// Paperclip-named alias for one-release compatibility (Task 9 consumer ports)
export type PaperclipSkillEntry = AoaSkillEntry;

export interface InstalledSkillTarget {
  targetPath: string | null;
  kind: "symlink" | "directory" | "file";
}

interface PersistentSkillSnapshotOptions {
  adapterType: string;
  availableEntries: AoaSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  skillsHome: string;
  locationLabel?: string | null;
  installedDetail?: string | null;
  missingDetail: string;
  externalConflictDetail: string;
  externalDetail: string;
  warnings?: string[];
}

function normalizePathSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function isMaintainerOnlySkillTarget(candidate: string): boolean {
  return normalizePathSlashes(candidate).includes("/.agents/skills/");
}

function skillLocationLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildManagedSkillOrigin(entry: { required?: boolean }): Pick<
  AdapterSkillEntry,
  "origin" | "originLabel" | "readOnly"
> {
  if (entry.required) {
    return {
      origin: "aoa_required",
      originLabel: "Required by AoA",
      readOnly: false,
    };
  }
  return {
    origin: "company_managed",
    originLabel: "Managed by AoA",
    readOnly: false,
  };
}

function resolveInstalledEntryTarget(
  skillsHome: string,
  entryName: string,
  dirent: Dirent,
  linkedPath: string | null,
): InstalledSkillTarget {
  const fullPath = path.join(skillsHome, entryName);
  if (dirent.isSymbolicLink()) {
    return {
      targetPath: linkedPath ? path.resolve(path.dirname(fullPath), linkedPath) : null,
      kind: "symlink",
    };
  }
  if (dirent.isDirectory()) {
    return { targetPath: fullPath, kind: "directory" };
  }
  return { targetPath: fullPath, kind: "file" };
}

export function joinPromptSections(
  sections: Array<string | null | undefined>,
  separator = "\n\n",
) {
  return sections
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(separator);
}

export const buildPaperclipEnv = buildAoaEnv;

const DEFAULT_AOA_INSTANCE_ID = "default";
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolveAoaInstanceRootForAdapter(input: {
  homeDir?: string;
  instanceId?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const env = input.env ?? process.env;
  const homeRaw = input.homeDir?.trim() || env.AOA_HOME?.trim();
  const homeDir = path.resolve(homeRaw ? expandHomePrefix(homeRaw) : path.resolve(os.homedir(), ".aoa"));
  const instanceId = input.instanceId?.trim() || env.AOA_INSTANCE_ID?.trim() || DEFAULT_AOA_INSTANCE_ID;
  if (!PATH_SEGMENT_RE.test(instanceId)) throw new Error(`Invalid AOA_INSTANCE_ID '${instanceId}'.`);
  return path.resolve(homeDir, "instances", instanceId);
}

export const resolvePaperclipInstanceRootForAdapter = resolveAoaInstanceRootForAdapter;

export const DEFAULT_AOA_AGENT_PROMPT_TEMPLATE =
  "You are agent {{agent.id}} ({{agent.name}}). Continue your AoA work.";
export const DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE = DEFAULT_AOA_AGENT_PROMPT_TEMPLATE;

// ---------------------------------------------------------------------------
// Wake payload normalization / prompt rendering
// ---------------------------------------------------------------------------

type AoaWakeIssue = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  workMode: string | null;
};

type AoaWakeExecutionPrincipal = {
  type: "agent" | "user" | null;
  agentId: string | null;
  userId: string | null;
};

type AoaWakeExecutionStage = {
  wakeRole: "reviewer" | "approver" | "executor" | null;
  stageId: string | null;
  stageType: string | null;
  currentParticipant: AoaWakeExecutionPrincipal | null;
  returnAssignee: AoaWakeExecutionPrincipal | null;
  lastDecisionOutcome: string | null;
  allowedActions: string[];
};

type AoaWakeComment = {
  id: string | null;
  issueId: string | null;
  body: string;
  bodyTruncated: boolean;
  createdAt: string | null;
  authorType: string | null;
  authorId: string | null;
};

type AoaWakePayload = {
  reason: string | null;
  issue: AoaWakeIssue | null;
  checkedOutByHarness: boolean;
  executionStage: AoaWakeExecutionStage | null;
  commentIds: string[];
  latestCommentId: string | null;
  comments: AoaWakeComment[];
  requestedCount: number;
  includedCount: number;
  missingCount: number;
  truncated: boolean;
  fallbackFetchNeeded: boolean;
};

function normalizeAoaWakeIssue(value: unknown): AoaWakeIssue | null {
  const issue = parseObject(value);
  const id = asString(issue.id, "").trim() || null;
  const identifier = asString(issue.identifier, "").trim() || null;
  const title = asString(issue.title, "").trim() || null;
  const status = asString(issue.status, "").trim() || null;
  const priority = asString(issue.priority, "").trim() || null;
  const workMode = asString(issue.workMode, "standard").trim() || "standard";
  if (!id && !identifier && !title) return null;
  return {
    id,
    identifier,
    title,
    status,
    priority,
    workMode,
  };
}

function normalizeAoaWakeComment(value: unknown): AoaWakeComment | null {
  const comment = parseObject(value);
  const author = parseObject(comment.author);
  const body = asString(comment.body, "");
  if (!body.trim()) return null;
  return {
    id: asString(comment.id, "").trim() || null,
    issueId: asString(comment.issueId, "").trim() || null,
    body,
    bodyTruncated: asBoolean(comment.bodyTruncated, false),
    createdAt: asString(comment.createdAt, "").trim() || null,
    authorType: asString(author.type, "").trim() || null,
    authorId: asString(author.id, "").trim() || null,
  };
}

function normalizeAoaWakeExecutionPrincipal(value: unknown): AoaWakeExecutionPrincipal | null {
  const principal = parseObject(value);
  const typeRaw = asString(principal.type, "").trim().toLowerCase();
  if (typeRaw !== "agent" && typeRaw !== "user") return null;
  return {
    type: typeRaw,
    agentId: asString(principal.agentId, "").trim() || null,
    userId: asString(principal.userId, "").trim() || null,
  };
}

function normalizeAoaWakeExecutionStage(value: unknown): AoaWakeExecutionStage | null {
  const stage = parseObject(value);
  const wakeRoleRaw = asString(stage.wakeRole, "").trim().toLowerCase();
  const wakeRole =
    wakeRoleRaw === "reviewer" || wakeRoleRaw === "approver" || wakeRoleRaw === "executor"
      ? wakeRoleRaw
      : null;
  const allowedActions = Array.isArray(stage.allowedActions)
    ? stage.allowedActions
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  const currentParticipant = normalizeAoaWakeExecutionPrincipal(stage.currentParticipant);
  const returnAssignee = normalizeAoaWakeExecutionPrincipal(stage.returnAssignee);
  const stageId = asString(stage.stageId, "").trim() || null;
  const stageType = asString(stage.stageType, "").trim() || null;
  const lastDecisionOutcome = asString(stage.lastDecisionOutcome, "").trim() || null;

  if (!wakeRole && !stageId && !stageType && !currentParticipant && !returnAssignee && !lastDecisionOutcome && allowedActions.length === 0) {
    return null;
  }

  return {
    wakeRole,
    stageId,
    stageType,
    currentParticipant,
    returnAssignee,
    lastDecisionOutcome,
    allowedActions,
  };
}

export function normalizeAoaWakePayload(value: unknown): AoaWakePayload | null {
  const payload = parseObject(value);
  const comments = Array.isArray(payload.comments)
    ? payload.comments
        .map((entry) => normalizeAoaWakeComment(entry))
        .filter((entry): entry is AoaWakeComment => Boolean(entry))
    : [];
  const commentWindow = parseObject(payload.commentWindow);
  const commentIds = Array.isArray(payload.commentIds)
    ? payload.commentIds
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  const executionStage = normalizeAoaWakeExecutionStage(payload.executionStage);

  if (comments.length === 0 && commentIds.length === 0 && !executionStage && !normalizeAoaWakeIssue(payload.issue)) {
    return null;
  }

  return {
    reason: asString(payload.reason, "").trim() || null,
    issue: normalizeAoaWakeIssue(payload.issue),
    checkedOutByHarness: asBoolean(payload.checkedOutByHarness, false),
    executionStage,
    commentIds,
    latestCommentId: asString(payload.latestCommentId, "").trim() || null,
    comments,
    requestedCount: asNumber(commentWindow.requestedCount, comments.length || commentIds.length),
    includedCount: asNumber(commentWindow.includedCount, comments.length),
    missingCount: asNumber(commentWindow.missingCount, 0),
    truncated: asBoolean(payload.truncated, false),
    fallbackFetchNeeded: asBoolean(payload.fallbackFetchNeeded, false),
  };
}
export const normalizePaperclipWakePayload = normalizeAoaWakePayload;

export function stringifyAoaWakePayload(value: unknown): string | null {
  const normalized = normalizeAoaWakePayload(value);
  if (!normalized) return null;
  return JSON.stringify(normalized);
}
export const stringifyPaperclipWakePayload = stringifyAoaWakePayload;

export function renderAoaWakePrompt(
  value: unknown,
  options: { resumedSession?: boolean } = {},
): string {
  const normalized = normalizeAoaWakePayload(value);
  if (!normalized) return "";
  const resumedSession = options.resumedSession === true;
  const executionStage = normalized.executionStage;
  const principalLabel = (principal: AoaWakeExecutionPrincipal | null) => {
    if (!principal || !principal.type) return "unknown";
    if (principal.type === "agent") return principal.agentId ? `agent ${principal.agentId}` : "agent";
    return principal.userId ? `user ${principal.userId}` : "user";
  };

  const lines = resumedSession
    ? [
        "## AoA Resume Delta",
        "",
        "You are resuming an existing AoA session.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "Focus on the new wake delta below and continue the current task without restating the full heartbeat boilerplate.",
        "Fetch the API thread only when `fallbackFetchNeeded` is true or you need broader history than this batch.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ]
    : [
        "## AoA Wake Payload",
        "",
        "Treat this wake payload as the highest-priority change for the current heartbeat.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "Before generic repo exploration or boilerplate heartbeat updates, acknowledge the latest comment and explain how it changes your next action.",
        "Use this inline wake data first before refetching the issue thread.",
        "Only fetch the API thread when `fallbackFetchNeeded` is true or you need broader history than this batch.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ];

  if (normalized.issue?.status) {
    lines.push(`- issue status: ${normalized.issue.status}`);
  }
  if (normalized.issue?.priority) {
    lines.push(`- issue priority: ${normalized.issue.priority}`);
  }
  if (normalized.checkedOutByHarness) {
    lines.push("- checkout: already claimed by the harness for this run");
  }
  if (normalized.missingCount > 0) {
    lines.push(`- omitted comments: ${normalized.missingCount}`);
  }

  if (executionStage) {
    lines.push(
      `- execution wake role: ${executionStage.wakeRole ?? "unknown"}`,
      `- execution stage: ${executionStage.stageType ?? "unknown"}`,
      `- execution participant: ${principalLabel(executionStage.currentParticipant)}`,
      `- execution return assignee: ${principalLabel(executionStage.returnAssignee)}`,
      `- last decision outcome: ${executionStage.lastDecisionOutcome ?? "none"}`,
    );
    if (executionStage.allowedActions.length > 0) {
      lines.push(`- allowed actions: ${executionStage.allowedActions.join(", ")}`);
    }
    lines.push("");
    if (executionStage.wakeRole === "reviewer" || executionStage.wakeRole === "approver") {
      lines.push(
        `You are waking as the active ${executionStage.wakeRole} for this issue.`,
        "Do not execute the task itself or continue executor work.",
        "Review the issue and choose one of the allowed actions above.",
        "If you request changes, the workflow routes back to the stored return assignee.",
        "",
      );
    } else if (executionStage.wakeRole === "executor") {
      lines.push(
        "You are waking because changes were requested in the execution workflow.",
        "Address the requested changes on this issue and resubmit when the work is ready.",
        "",
      );
    }
  }

  if (normalized.checkedOutByHarness) {
    lines.push(
      "",
      "The harness already checked out this issue for the current run.",
      "Do not call `/api/issues/{id}/checkout` again unless you intentionally switch to a different task.",
      "",
    );
  }

  if (normalized.comments.length > 0) {
    lines.push("New comments in order:");
  }

  for (const [index, comment] of normalized.comments.entries()) {
    const authorLabel = comment.authorId
      ? `${comment.authorType ?? "unknown"} ${comment.authorId}`
      : comment.authorType ?? "unknown";
    lines.push(
      `${index + 1}. comment ${comment.id ?? "unknown"} at ${comment.createdAt ?? "unknown"} by ${authorLabel}`,
      comment.body,
    );
    if (comment.bodyTruncated) {
      lines.push("[comment body truncated]");
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
export const renderPaperclipWakePrompt = renderAoaWakePrompt;

export function readAoaIssueWorkModeFromContext(context: Record<string, unknown>): string | null {
  const candidates = [
    parseObject(context.paperclipWake).issue,
    parseObject(context.aoaWake).issue,
    context.issue,
    context.task,
  ];
  for (const candidate of candidates) {
    const workMode = asString(parseObject(candidate).workMode, "").trim();
    if (workMode) return workMode;
  }
  return null;
}
export const readPaperclipIssueWorkModeFromContext = readAoaIssueWorkModeFromContext;

// ---------------------------------------------------------------------------
// Log-friendly env + command resolution
// ---------------------------------------------------------------------------

export function buildInvocationEnvForLogs(
  env: Record<string, string>,
  options: {
    runtimeEnv?: NodeJS.ProcessEnv | Record<string, string>;
    includeRuntimeKeys?: string[];
    resolvedCommand?: string | null;
    resolvedCommandEnvKey?: string;
  } = {},
): Record<string, string> {
  const merged: Record<string, string> = { ...env };
  const runtimeEnv = options.runtimeEnv ?? {};

  for (const key of options.includeRuntimeKeys ?? []) {
    if (key in merged) continue;
    const value = runtimeEnv[key];
    if (typeof value !== "string" || value.length === 0) continue;
    merged[key] = value;
  }

  const resolvedCommand = options.resolvedCommand?.trim();
  if (resolvedCommand) {
    merged[options.resolvedCommandEnvKey ?? "AOA_RESOLVED_COMMAND"] = resolvedCommand;
  }

  return redactEnvForLogs(merged);
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandPath(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? windowsPathExts(env) : [""];
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(dir, command)]
          : exts.map((ext) => path.join(dir, `${command}${ext}`))
        : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

export async function resolveCommandForLogs(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return (await resolveCommandPath(command, cwd, env)) ?? command;
}

// ---------------------------------------------------------------------------
// Skills: discovery, sync preference, snapshot building
// ---------------------------------------------------------------------------

export async function resolveAoaSkillsDir(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<string | null> {
  const candidates = [
    ...AOA_SKILL_ROOT_RELATIVE_CANDIDATES.map((relativePath) => path.resolve(moduleDir, relativePath)),
    ...additionalCandidates.map((candidate) => path.resolve(candidate)),
  ];
  const seenRoots = new Set<string>();

  for (const root of candidates) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const isDirectory = await fs.stat(root).then((stats) => stats.isDirectory()).catch(() => false);
    if (isDirectory) return root;
  }

  return null;
}
export const resolvePaperclipSkillsDir = resolveAoaSkillsDir;

export async function listAoaSkillEntries(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<AoaSkillEntry[]> {
  const root = await resolveAoaSkillsDir(moduleDir, additionalCandidates);
  if (!root) return [];

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        key: `armyofagents/aoa/${entry.name}`,
        runtimeName: entry.name,
        source: path.join(root, entry.name),
        required: true,
        requiredReason: "Bundled AoA skills are always available for local adapters.",
      }));
  } catch {
    return [];
  }
}
export const listPaperclipSkillEntries = listAoaSkillEntries;

export async function readInstalledSkillTargets(
  skillsHome: string,
): Promise<Map<string, InstalledSkillTarget>> {
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  const out = new Map<string, InstalledSkillTarget>();
  for (const entry of entries) {
    const fullPath = path.join(skillsHome, entry.name);
    const linkedPath = entry.isSymbolicLink() ? await fs.readlink(fullPath).catch(() => null) : null;
    out.set(entry.name, resolveInstalledEntryTarget(skillsHome, entry.name, entry, linkedPath));
  }
  return out;
}

export function buildPersistentSkillSnapshot(
  options: PersistentSkillSnapshotOptions,
): AdapterSkillSnapshot {
  const {
    adapterType,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel,
    installedDetail,
    missingDetail,
    externalConflictDetail,
    externalDetail,
  } = options;
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = [];
  const warnings = [...(options.warnings ?? [])];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    let state: AdapterSkillEntry["state"] = "available";
    let managed = false;
    let detail: string | null = null;

    if (installedEntry?.targetPath === available.source) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = installedDetail ?? null;
    } else if (installedEntry) {
      state = "external";
      detail = desired ? externalConflictDetail : externalDetail;
    } else if (desired) {
      state = "missing";
      detail = missingDetail;
    }

    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      desired,
      managed,
      state,
      sourcePath: available.source,
      targetPath: path.join(skillsHome, available.runtimeName),
      detail,
      required: Boolean(available.required),
      requiredReason: available.requiredReason ?? null,
      ...buildManagedSkillOrigin(available),
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the AoA skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: null,
      targetPath: null,
      detail: "AoA cannot find this skill in the local runtime skills directory.",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: skillLocationLabel(locationLabel),
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: externalDetail,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType,
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

function normalizeConfiguredAoaRuntimeSkills(value: unknown): AoaSkillEntry[] {
  if (!Array.isArray(value)) return [];
  const out: AoaSkillEntry[] = [];
  for (const rawEntry of value) {
    const entry = parseObject(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    out.push({
      key,
      runtimeName,
      source,
      required: asBoolean(entry.required, false),
      requiredReason:
        typeof entry.requiredReason === "string" && entry.requiredReason.trim().length > 0
          ? entry.requiredReason.trim()
          : null,
    });
  }
  return out;
}

export async function readAoaRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<AoaSkillEntry[]> {
  const configuredEntries = normalizeConfiguredAoaRuntimeSkills(config.aoaRuntimeSkills);
  if (configuredEntries.length > 0) return configuredEntries;
  return listAoaSkillEntries(moduleDir, additionalCandidates);
}
export const readPaperclipRuntimeSkillEntries = readAoaRuntimeSkillEntries;

export async function materializeAoaSkillCopy(source: string, target: string): Promise<{ skippedSymlinks: string[] }> {
  // Codex P2: fs.cp's filter only skips copying matching SOURCE paths — it does
  // NOT delete a same-named path already present in the TARGET. For a persistent
  // runtime target reused across runs (e.g. ACPX Codex's CODEX_HOME/skills/
  // <runtimeName>), a .git dir or symlink materialized by an earlier run/version
  // would otherwise survive, defeating the exclude-VCS/symlink guarantee below.
  // Remove the target up front so each materialization is a clean, filtered copy
  // (the skill source is authoritative; nothing in target is worth preserving).
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  const resolvedSource = path.resolve(source);
  const skippedSymlinks: string[] = [];
  await fs.cp(source, target, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false,
    filter: async (src) => {
      // Never materialize a nested VCS dir into the runtime skill tree, and
      // never follow symlinked descendants out of the skill dir (security:
      // a malicious skill could symlink to host files / dirs outside it).
      if (path.basename(src) === ".git") return false;
      const info = await fs.lstat(src);
      if (info.isSymbolicLink()) {
        skippedSymlinks.push(path.relative(resolvedSource, path.resolve(src)));
        return false;
      }
      return true;
    },
  });
  return { skippedSymlinks };
}
export const materializePaperclipSkillCopy = materializeAoaSkillCopy;

export async function readAoaSkillMarkdown(
  moduleDir: string,
  skillKey: string,
): Promise<string | null> {
  const normalized = skillKey.trim().toLowerCase();
  if (!normalized) return null;

  const entries = await listAoaSkillEntries(moduleDir);
  const match = entries.find((entry) => entry.key === normalized);
  if (!match) return null;

  try {
    return await fs.readFile(path.join(match.source, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}
export const readPaperclipSkillMarkdown = readAoaSkillMarkdown;

export function readAoaSkillSyncPreference(config: Record<string, unknown>): {
  explicit: boolean;
  desiredSkills: string[];
} {
  // paperclipSkillSync compat read — remove in next major
  const raw = config.aoaSkillSync ?? config.paperclipSkillSync;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, desiredSkills: [] };
  }
  const syncConfig = raw as Record<string, unknown>;
  const desiredValues = syncConfig.desiredSkills;
  const desired = Array.isArray(desiredValues)
    ? desiredValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return {
    explicit: Object.prototype.hasOwnProperty.call(raw, "desiredSkills"),
    desiredSkills: Array.from(new Set(desired)),
  };
}
export const readPaperclipSkillSyncPreference = readAoaSkillSyncPreference;

function canonicalizeDesiredAoaSkillReference(
  reference: string,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string {
  const normalizedReference = reference.trim().toLowerCase();
  if (!normalizedReference) return "";

  const exactKey = availableEntries.find(
    (entry) => entry.key.trim().toLowerCase() === normalizedReference,
  );
  if (exactKey) return exactKey.key;

  const byRuntimeName = availableEntries.filter(
    (entry) =>
      typeof entry.runtimeName === "string" &&
      entry.runtimeName.trim().toLowerCase() === normalizedReference,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0]!.key;

  const slugMatches = availableEntries.filter(
    (entry) => entry.key.trim().toLowerCase().split("/").pop() === normalizedReference,
  );
  if (slugMatches.length === 1) return slugMatches[0]!.key;

  return normalizedReference;
}

export function resolveAoaDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null; required?: boolean }>,
): string[] {
  const preference = readAoaSkillSyncPreference(config);
  const requiredSkills = availableEntries
    .filter((entry) => entry.required)
    .map((entry) => entry.key);
  if (!preference.explicit) {
    return Array.from(new Set(requiredSkills));
  }
  const desiredSkills = preference.desiredSkills
    .map((reference) => canonicalizeDesiredAoaSkillReference(reference, availableEntries))
    .filter(Boolean);
  return Array.from(new Set([...requiredSkills, ...desiredSkills]));
}
export const resolvePaperclipDesiredSkillNames = resolveAoaDesiredSkillNames;

export function writeAoaSkillSyncPreference(
  config: Record<string, unknown>,
  desiredSkills: string[],
): Record<string, unknown> {
  const next = { ...config };
  const raw = next.aoaSkillSync;
  const current =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  current.desiredSkills = Array.from(
    new Set(
      desiredSkills
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  next.aoaSkillSync = current;
  // paperclipSkillSync compat write — remove in next major
  next.paperclipSkillSync = current;
  return next;
}
export const writePaperclipSkillSyncPreference = writeAoaSkillSyncPreference;

export async function ensureAoaSkillSymlink(
  source: string,
  target: string,
  linkSkill: (source: string, target: string) => Promise<void> = (linkSource, linkTarget) =>
    // AoA deviation from Paperclip: use `junction` on Windows so directory
    // symlinks don't require admin elevation. Paperclip ships a Linux-first
    // default; cursor-local already applies the same workaround downstream.
    fs.symlink(linkSource, linkTarget, process.platform === "win32" ? "junction" : undefined),
): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await linkSkill(source, target);
    return "created";
  }

  if (!existing.isSymbolicLink()) {
    return "skipped";
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return "skipped";

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) {
    return "skipped";
  }

  const linkedPathExists = await fs.stat(resolvedLinkedPath).then(() => true).catch(() => false);
  if (linkedPathExists) {
    return "skipped";
  }

  await fs.unlink(target);
  await linkSkill(source, target);
  return "repaired";
}
export const ensurePaperclipSkillSymlink = ensureAoaSkillSymlink;

export async function removeMaintainerOnlySkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
): Promise<string[]> {
  const allowed = new Set(Array.from(allowedSkillNames));
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (allowed.has(entry.name)) continue;

      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing?.isSymbolicLink()) continue;

      const linkedPath = await fs.readlink(target).catch(() => null);
      if (!linkedPath) continue;

      const resolvedLinkedPath = path.isAbsolute(linkedPath)
        ? linkedPath
        : path.resolve(path.dirname(target), linkedPath);
      if (
        !isMaintainerOnlySkillTarget(linkedPath) &&
        !isMaintainerOnlySkillTarget(resolvedLinkedPath)
      ) {
        continue;
      }

      await fs.unlink(target);
      removed.push(entry.name);
    }

    return removed;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Workspace env-var propagation helper
// ---------------------------------------------------------------------------

/**
 * Apply AoA workspace environment variables to an env record.
 *
 * Centralizes all 9 AOA_WORKSPACE_* / AGENT_HOME env keys so adapters
 * don't drift from each other. Values that are null, undefined, or empty
 * strings are silently skipped (the key is not written to the record).
 *
 * Ports d47ffa87 from paperclip (rebranded paperclip→aoa).
 */
export function applyAoaWorkspaceEnv(
  env: Record<string, string>,
  input: {
    workspaceCwd?: string | null;
    workspaceSource?: string | null;
    workspaceStrategy?: string | null;
    workspaceId?: string | null;
    workspaceRepoUrl?: string | null;
    workspaceRepoRef?: string | null;
    workspaceBranch?: string | null;
    workspaceWorktreePath?: string | null;
    agentHome?: string | null;
  },
): Record<string, string> {
  const mappings: [string, string | null | undefined][] = [
    ["AOA_WORKSPACE_CWD", input.workspaceCwd],
    ["AOA_WORKSPACE_SOURCE", input.workspaceSource],
    ["AOA_WORKSPACE_STRATEGY", input.workspaceStrategy],
    ["AOA_WORKSPACE_ID", input.workspaceId],
    ["AOA_WORKSPACE_REPO_URL", input.workspaceRepoUrl],
    ["AOA_WORKSPACE_REPO_REF", input.workspaceRepoRef],
    ["AOA_WORKSPACE_BRANCH", input.workspaceBranch],
    ["AOA_WORKSPACE_WORKTREE_PATH", input.workspaceWorktreePath],
    ["AGENT_HOME", input.agentHome],
  ];
  for (const [key, value] of mappings) {
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

export function refreshAoaWorkspaceEnvForExecution(input: {
  env: Record<string, string>;
  envConfig?: Record<string, unknown>;
  workspaceCwd?: string | null;
  workspaceSource?: string | null;
  workspaceStrategy?: string | null;
  workspaceId?: string | null;
  workspaceRepoUrl?: string | null;
  workspaceRepoRef?: string | null;
  workspaceBranch?: string | null;
  workspaceWorktreePath?: string | null;
  workspaceHints?: Array<Record<string, unknown>>;
  agentHome?: string | null;
  executionTargetIsRemote?: boolean;
  executionCwd?: string | null;
}): Record<string, string> {
  const workspaceCwd = input.executionTargetIsRemote
    ? input.executionCwd || input.workspaceCwd || null
    : input.workspaceCwd || null;
  applyAoaWorkspaceEnv(input.env, {
    workspaceCwd,
    workspaceSource: input.workspaceSource ?? null,
    workspaceStrategy: input.workspaceStrategy ?? null,
    workspaceId: input.workspaceId ?? null,
    workspaceRepoUrl: input.workspaceRepoUrl ?? null,
    workspaceRepoRef: input.workspaceRepoRef ?? null,
    workspaceBranch: input.workspaceBranch ?? null,
    workspaceWorktreePath: input.executionTargetIsRemote ? null : input.workspaceWorktreePath ?? null,
    agentHome: input.agentHome ?? null,
  });
  if (input.workspaceHints && input.workspaceHints.length > 0) {
    input.env.AOA_WORKSPACES_JSON = JSON.stringify(input.workspaceHints);
  }
  const envConfig = parseObject(input.envConfig);
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") input.env[key] = value;
  }
  return input.env;
}
export const refreshPaperclipWorkspaceEnvForExecution = refreshAoaWorkspaceEnvForExecution;

export function shapeAoaWorkspaceEnvForExecution(input: {
  env: Record<string, string>;
  targetType: "local" | "sandbox-docker";
  localCwd: string;
  executionCwd: string;
}): Record<string, string> {
  if (input.targetType === "local") return { ...input.env };

  const next = { ...input.env };
  if (next.AOA_WORKSPACE_CWD === input.localCwd) {
    next.AOA_WORKSPACE_CWD = input.executionCwd;
  }
  if (next.AOA_WORKSPACE_WORKTREE_PATH === input.localCwd) {
    delete next.AOA_WORKSPACE_WORKTREE_PATH;
  }

  if (next.AOA_WORKSPACES_JSON) {
    try {
      const parsed = JSON.parse(next.AOA_WORKSPACES_JSON) as unknown;
      if (!Array.isArray(parsed)) {
        delete next.AOA_WORKSPACES_JSON;
      } else {
        next.AOA_WORKSPACES_JSON = JSON.stringify(
          parsed.map((item) => {
            if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
            const workspace = item as Record<string, unknown>;
            if (workspace.cwd === input.localCwd) return { ...workspace, cwd: input.executionCwd };
            const { cwd: _cwd, ...rest } = workspace;
            return rest;
          }),
        );
      }
    } catch {
      delete next.AOA_WORKSPACES_JSON;
    }
  }

  return next;
}

export const applyPaperclipWorkspaceEnv = applyAoaWorkspaceEnv;
export function shapePaperclipWorkspaceEnvForExecution(input: {
  workspaceCwd?: string | null;
  workspaceWorktreePath?: string | null;
  workspaceHints?: Array<Record<string, unknown>>;
  executionTargetIsRemote?: boolean;
  executionCwd?: string | null;
}): {
  workspaceCwd: string | null;
  workspaceWorktreePath: string | null;
  workspaceHints: Array<Record<string, unknown>>;
} {
  const workspaceCwd =
    input.executionTargetIsRemote ? input.executionCwd || input.workspaceCwd || null : input.workspaceCwd || null;
  const workspaceWorktreePath = input.executionTargetIsRemote ? null : input.workspaceWorktreePath || null;
  const workspaceHints = (input.workspaceHints ?? []).map((hint) => {
    if (!input.executionTargetIsRemote || !input.workspaceCwd || !input.executionCwd) return hint;
    if (hint.cwd === input.workspaceCwd) return { ...hint, cwd: input.executionCwd };
    return hint;
  });
  return { workspaceCwd, workspaceWorktreePath, workspaceHints };
}

export function rewriteWorkspaceCwdEnvVarsForExecution(input: {
  env: Record<string, unknown>;
  workspaceCwd?: string | null;
  executionCwd?: string | null;
  executionTargetIsRemote?: boolean;
}): Record<string, string> {
  const nextEnv = Object.fromEntries(
    Object.entries(input.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const localWorkspaceCwd =
    typeof input.workspaceCwd === "string" && input.workspaceCwd.trim().length > 0
      ? path.resolve(input.workspaceCwd)
      : null;
  const remoteWorkspaceCwd =
    typeof input.executionCwd === "string" && input.executionCwd.trim().length > 0
      ? input.executionCwd.trim()
      : null;

  if (!input.executionTargetIsRemote || !localWorkspaceCwd || !remoteWorkspaceCwd) {
    return nextEnv;
  }

  for (const [key, value] of Object.entries(nextEnv)) {
    if (!key.endsWith("_WORKSPACE_CWD")) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (path.resolve(trimmed) !== localWorkspaceCwd) continue;
    nextEnv[key] = remoteWorkspaceCwd;
  }
  return nextEnv;
}
