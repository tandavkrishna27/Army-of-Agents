/**
 * FU-23 — single source of truth for the "AoA-owned ambient secret" denylist.
 *
 * When a heartbeat/crew agent run hosts external MCP connectors, the vendor CLI
 * (claude / codex / opencode / gemini) spawns each stdio connector's process
 * (`npx -y <pkg>`) as a CHILD that inherits the CLI's environment. That env must
 * NOT carry AoA's own secrets — DB creds, the embeddings `OPENAI_API_KEY`, the
 * auth signing secret, the master key, the GitHub PAT — or a third-party package
 * could read them all.
 *
 * This module lives in `adapter-utils` (NOT `server/`) on purpose: the adapters
 * MUST NOT import from `server/`, but the server MAY import from adapter-utils.
 * The server's `buildScrubbedCliEnv` (Commander's spawn, `cli-spawn-safety.ts`)
 * re-uses {@link isAoaAmbientSecretEnvKey} so the Commander spawn and the four
 * adapter spawns strip the EXACT same set — there is no second denylist to drift.
 *
 * The denylist targets AoA's OWN ambient (server-process) secrets only. It does
 * NOT — and cannot — provide sibling-connector-token isolation: every connector
 * token must sit in the one CLI env for `${VAR}` expansion, and the CLI (not
 * AoA) spawns the connector children.
 */

/** Exact env keys that are always stripped (AoA-internal / infra secrets). */
const ALWAYS_DROP_EXACT = new Set([
  "GITHUB_PAT",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "REDIS_URL",
]);

/**
 * Vendor auth env that SOME CLI may read for auth. Dropped by default so a
 * different vendor's CLI never sees it; a caller re-adds its own via `keep`.
 */
const VENDOR_AUTH_KEYS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
]);

/**
 * Generic credential-style names (covers app/plugin/infra secrets not enumerated
 * by exact name): token / api-key / access-key / private-key / credential /
 * cookie / auth / secret / password. Vendor auth the CLI genuinely needs is
 * re-added via `keep` (checked before this regex).
 */
const SECRETISH_RE =
  /(secret|password|passwd|passphrase|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|auth)/i;

export interface AoaAmbientSecretOptions {
  /** Vendor auth keys to PRESERVE for THIS spawn's own CLI (never treated as secret). */
  keep?: Iterable<string>;
}

/**
 * Is `key` an AoA-owned ambient secret a third-party MCP connector child must
 * never inherit?
 *
 * Denylist (drop only known-sensitive keys; keep PATH/HOME/APPDATA/TMP/…):
 *   - anything the caller `keep`s is NEVER a secret (checked first),
 *   - all `AOA_*` (app-internal config + secrets),
 *   - ALWAYS_DROP_EXACT (infra creds),
 *   - VENDOR_AUTH_KEYS,
 *   - generic secret-ish names.
 */
export function isAoaAmbientSecretEnvKey(
  key: string,
  opts: AoaAmbientSecretOptions = {},
): boolean {
  if (opts.keep) {
    for (const k of opts.keep) {
      if (k === key) return false;
    }
  }
  if (key.startsWith("AOA_")) return true;
  if (ALWAYS_DROP_EXACT.has(key)) return true;
  if (VENDOR_AUTH_KEYS.has(key)) return true;
  if (SECRETISH_RE.test(key)) return true;
  return false;
}

/**
 * The keys of `parentEnv` that are AoA-owned ambient secrets — i.e. the exact
 * list to pass as `unsetEnvKeys` when spawning a connector-hosting CLI, so the
 * child never inherits them. Keys absent from `parentEnv` are not returned (an
 * `unsetEnvKeys` entry that matches nothing is harmless but pointless).
 *
 * `mergeChildEnv` (server-utils) already exempts any key the spawn OVERLAY set
 * from `unsetEnvKeys`, so a connector's own `AOA_MCP_*_TOKEN` and the run's own
 * `AOA_RUN_ID` / `AOA_API_KEY` (all overlay-set) survive even though they match
 * the `AOA_*` rule. Callers whose overlay ITSELF carries `parentEnv` (opencode)
 * must additionally pass `keep` here so those overlay keys are not stripped from
 * that overlay before the spawn.
 */
export function aoaAmbientSecretEnvKeys(
  parentEnv: NodeJS.ProcessEnv = process.env,
  opts: AoaAmbientSecretOptions = {},
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (isAoaAmbientSecretEnvKey(key, opts)) out.push(key);
  }
  return out;
}
