import fs from "node:fs/promises";
import path from "node:path";

/**
 * Tools that require a permission decision from AoA before the CLI can
 * proceed.  Benign read-only tools (Read, Grep, Glob, LS, TodoWrite, …)
 * are intentionally omitted so they never trigger a prompt.
 */
export const PERMISSION_REQUIRING_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
] as const;

/** Pipe-separated regex matcher used in the Claude settings `hooks` block. */
const SCOPED_MATCHER = PERMISSION_REQUIRING_TOOLS.join("|");

export interface PreToolUseHook {
  type: "command";
  command: string;
  timeout: number;
}

export interface PreToolUseEntry {
  matcher: string;
  hooks: [PreToolUseHook];
}

export interface PreToolUseSettings {
  hooks: {
    PreToolUse: [PreToolUseEntry];
  };
}

/**
 * Build a Claude CLI `--settings` JSON object that wires the PreToolUse hook
 * to the AoA permission bridge forwarder.
 *
 * Design constraints:
 * - Returns ONLY the `hooks` key — no `permissions`, `mcpServers`, or `env`
 *   top-level keys — so the object can't clobber other run config when
 *   `--settings` replaces rather than merges.
 * - The endpoint URL travels via the `AOA_RUNTIME_HOOK_URL` env var (non-secret).
 * - The auth TOKEN travels via a FILE whose path is passed as a hook-command ARG
 *   (`tokenFilePath`), NOT via an env var (F1). A stdio connector child inherits
 *   the CLI's env — so a token in `AOA_RUNTIME_HOOK_TOKEN` would leak to it, and
 *   `stripConnectorRunBearers` removing it would break the hook (fail-closed →
 *   every governed tool denied). The connector child does NOT see the hook
 *   command's argv, so the token-file path stays out of its reach. The token
 *   VALUE itself is never in this settings object. (Backward-compat: with no
 *   `tokenFilePath`, the forwarder still falls back to the env var.)
 * - Transport is `type:"command"` (fail-CLOSED) — not native http which is
 *   fail-OPEN.
 */
export function buildPreToolUseSettings(input: {
  endpointUrl: string;
  timeoutSec: number;
  forwarderPath: string;
  /** Path to the file holding the bearer token (owner-only). Passed as argv[2]. */
  tokenFilePath?: string;
}): PreToolUseSettings {
  const { timeoutSec, forwarderPath, tokenFilePath } = input;

  const hook: PreToolUseHook = {
    type: "command",
    // node "<forwarder>" ["<tokenFilePath>"] — the URL travels via env; the token
    // travels via the file at argv[2] (never in env, never a literal here).
    command: tokenFilePath
      ? `node "${forwarderPath}" "${tokenFilePath}"`
      : `node "${forwarderPath}"`,
    timeout: timeoutSec,
  };

  const entry: PreToolUseEntry = {
    matcher: SCOPED_MATCHER,
    hooks: [hook],
  };

  return {
    hooks: {
      PreToolUse: [entry],
    },
  };
}

/**
 * Write `settings` as JSON to a file inside `dir` and return the full path.
 */
export async function writeRuntimeHookSettingsFile(
  dir: string,
  settings: PreToolUseSettings,
): Promise<string> {
  const filePath = path.join(dir, "aoa-runtime-hook-settings.json");
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2), "utf-8");
  return filePath;
}

/**
 * Write the hook bearer `token` to an owner-only file inside `dir` and return its
 * path (F1). The path is handed to `hook-forward.mjs` as a command ARG so the
 * token never rides in `AOA_RUNTIME_HOOK_TOKEN` (which a stdio connector child
 * would inherit). Mode 0600 is best-effort: it keeps the file owner-only on
 * POSIX; Windows ignores mode bits (the same-OS-user residual is an OS-sandbox
 * concern tracked separately). `dir` is the run's temp hook dir, cleaned up with
 * the settings file after the run.
 */
export async function writeRuntimeHookTokenFile(dir: string, token: string): Promise<string> {
  const filePath = path.join(dir, "aoa-runtime-hook-token");
  await fs.writeFile(filePath, token, { encoding: "utf-8", mode: 0o600 });
  return filePath;
}
