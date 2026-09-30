import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runStreamingLogin, type StreamingLoginResult } from "@armyofagents/adapter-utils/streaming-login";
import type { SpawnTrackedChildOptions, TrackedChildHandle } from "@armyofagents/adapter-utils/server-utils";

/**
 * The Claude Code CLI config home (Plan 3 / §6.2, Codex P1 #9). There is no
 * pre-existing repo resolver for this, so we define it here and let the login
 * lifecycle (Task 4) reuse it. `claude login` persists its credential file
 * under this dir — that file's presence is claude's completion evidence
 * (do NOT reuse codex's `auth.json`).
 */
export function resolveClaudeConfigHome(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/**
 * Claude's credential file, relative to the config home resolved above.
 * Dogfood-verified (do NOT reuse codex's `auth.json`).
 *
 * 🚨 THE ONLY SPELLING OF THIS FILENAME IN PRODUCTION CODE. It lives here,
 * beside the resolver, because the two together are the whole answer to "where
 * does Claude keep its auth". The provider-login runner registry
 * (`server/src/services/commander-login-runtime.ts`) sets claude's
 * `credentialFileName` from this const, and T3's per-run provisioning
 * (`ambient-config.ts`) copies exactly this file — so a future rename is one
 * edit, not a hunt. Direction is forced: `server/` depends on the adapter
 * packages, never the reverse.
 *
 * The e2e tree deliberately re-declares it (`tests/e2e/helpers/fake-claude.ts`)
 * rather than importing it, for the same reason it re-declares other shared
 * shapes: the e2e helpers do not depend on workspace package resolution. That
 * copy is a fixture, not a second source of truth — and a rename that misses it
 * fails the isolation spec loudly.
 */
export const CLAUDE_CREDENTIAL_FILE_NAME = ".credentials.json";

/**
 * Start an interactive `claude auth login` (Plan 3 / §6.2), streaming the
 * verification URL out live. The subcommand is `auth login` — dogfood confirmed
 * there is NO `claude login` (it just prints "Please run /login" and exits).
 *
 * NOTE: unlike `codex login` (local :1455 callback, self-completing), Claude's
 * flow redirects to a REMOTE callback (platform.claude.com) and then BLOCKS on
 * stdin: "Paste code here". So surfacing the URL is not enough — completing it
 * requires piping the pasted auth code into the child's stdin. This runner
 * opts into that (`stdin: "pipe"`) and returns `submitCode` for the caller to
 * deliver the pasted code; the rest of the paste-code bridge (a live-challenge
 * registry, the route that accepts the code, and the UI prompt) is wired by
 * later tasks — until they land, the UI still offers Claude the API-key path.
 */
export function runClaudeLoginStreaming(args: {
  runId: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  discoveryTimeoutMs?: number;
  spawn?: (
    runId: string,
    command: string,
    argv: string[],
    opts: SpawnTrackedChildOptions,
  ) => TrackedChildHandle;
  /**
   * DI seam — defaults to a recursive `fs.mkdirSync`. `claude auth login` runs
   * with `cwd: authHome` and persists its credential file there, but on a fresh
   * machine that dir (`~/.claude` / `CLAUDE_CONFIG_DIR`) may not exist yet, and
   * spawning with a non-existent cwd fails with ENOENT before the CLI can run
   * (Codex P2). Ensure it exists first — mkdir(recursive) is idempotent.
   */
  ensureDir?: (dir: string) => void;
}): StreamingLoginResult & { authHome: string } {
  const env = args.env ?? process.env;
  const authHome = resolveClaudeConfigHome(env);
  const ensureDir =
    args.ensureDir ??
    ((dir: string) => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    });
  ensureDir(authHome);
  const result = runStreamingLogin({
    runId: args.runId,
    command: args.command ?? "claude",
    args: ["auth", "login", "--claudeai"],
    cwd: authHome,
    // Preserve the caller's scoped HOME as well as CLAUDE_CONFIG_DIR. Passing
    // only the provider variable would re-inherit the server's shared HOME.
    env: { ...env, CLAUDE_CONFIG_DIR: authHome },
    // Claude blocks on "Paste code here" (see the module header). Codex does
    // not, and deliberately keeps the default "ignore".
    stdin: "pipe",
    discoveryTimeoutMs: args.discoveryTimeoutMs,
    spawn: args.spawn,
  });
  return { ...result, authHome };
}
