import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  foldEnvKey,
  resolveAoaInstanceRootForAdapter,
} from "@armyofagents/adapter-utils/server-utils";
import { CLAUDE_CREDENTIAL_FILE_NAME } from "./login.js";

/**
 * Ambient Claude-config isolation (D9) — the strip list claude_local applies to
 * CREW runs (`kind='aoa'`).
 *
 * A crew run used to inherit the operator's entire environment, so the host
 * machine's `~/.claude` bled straight into the agent: SessionStart hooks,
 * third-party skills, plugins — observed live hijacking a crew run. It also
 * handed the child the server's ambient `ANTHROPIC_API_KEY`, which flips the
 * CLI from subscription auth to API-key auth behind the founder's back.
 *
 * Mechanism is `mergeChildEnv`'s `unsetEnvPrefixes` (adapter-utils), NOT a
 * parallel env builder — so the "overlay wins" and Windows case-folding rules
 * are the SAME ones codex's `unsetEnvKeys` strip has been using.
 *
 * This module holds the strip list, the keep-list, and the per-run config-home
 * factory the local execute path uses.
 */

/**
 * Host-config classes a crew run must not inherit. A PREFIX class rather than an
 * enumerated key list: an enumeration silently leaks every variable Claude Code
 * introduces after we wrote it down, and D9 is that crew agents see *nothing*
 * from the host config.
 *
 * `CLAUDE_CONFIG_DIR` needs no exception here — the caller pins it in the
 * overlay env, and an overlay-set key always survives the strip.
 *
 * That same overlay-wins rule is how an env-based auth mode is kept for a crew
 * agent: set it on the agent's `adapterConfig.env` (e.g. `CLAUDE_CODE_USE_BEDROCK`,
 * `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_BASE_URL`, or a dedicated
 * `CLAUDE_CONFIG_DIR`) and it survives while the ambient copy is dropped.
 * Deliberate: an operator's per-agent choice is explicit, the host machine's is not.
 */
export const CLAUDE_AMBIENT_CONFIG_UNSET_PREFIXES: readonly string[] = [
  "CLAUDE_",
  "ANTHROPIC_",
];

/**
 * Session-/process-identity variables that a Claude Code parent leaks into every
 * child it spawns, stripped from EVERY claude_local run — org AND crew — via
 * `mergeChildEnv`'s exact-key `unsetEnvKeys` mechanism.
 *
 * Unlike the operator's `~/.claude` login (which an org agent legitimately
 * inherits and works from), these keys are NEVER legitimate to pass to a child:
 * `CLAUDE_CODE_CHILD_SESSION=1` + `CLAUDE_CODE_SESSION_ID` + `CLAUDE_CODE_ENTRYPOINT`
 * *declare the child to be a continuation of a specific live session* — a
 * behavioural input to the CLI, and the most plausible mechanism behind the
 * observed live agent-hijack. When AoA's server is started from inside a Claude
 * Code session (which is exactly how AoA is developed, QA'd and live-verified),
 * an org claude_local child inherits the PARENT session's identity and silently
 * contaminates the very runs used to validate agent behaviour.
 *
 * 🚨 EXACT KEYS, not a prefix. The `CLAUDE_CODE_*` namespace also carries pure
 * config (`CLAUDE_CODE_DISABLE_CRON`, `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`, …)
 * and AUTH (`CLAUDE_CODE_OAUTH_SCOPES`, `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH`),
 * neither of which may be dropped for an org run — an org agent keeps its login.
 * So this is an enumerated set of the six identity/process keys observed on a
 * live parent, NOT the crew-only `CLAUDE_`/`ANTHROPIC_` prefix strip. Crew is
 * already covered by that prefix (this is redundant-but-harmless there); org
 * gains exactly the identity strip and nothing else.
 *
 * Carries NO credential and NO founder-configured auth mode, so stripping it can
 * break no login — which is why it ships always-on and independently of T3's
 * credential provisioning.
 *
 * `mergeChildEnv`'s overlay-wins rule still applies: an agent that explicitly
 * sets one of these on `adapterConfig.env` keeps its own value; only the AMBIENT
 * inherited copy is dropped.
 */
export const CLAUDE_SESSION_IDENTITY_UNSET_KEYS: readonly string[] = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
];

/**
 * Variables that MUST survive the strip. None of them match the prefixes above,
 * so this list is a regression guard, not a filter: it fails loudly if the
 * prefix list is ever widened into something that would take the agent's ability
 * to do real work with it.
 *
 * 🚨 `HOME` / `USERPROFILE` are never relocated or stripped — git, SSH and npm
 * all resolve through them for the tools the agent launches — and `PATH` is how
 * the CLI is found at all. Isolating the Claude CONFIG is not the same as
 * sandboxing the process, and conflating the two breaks every agent run.
 */
export const CLAUDE_AMBIENT_CONFIG_KEEP_KEYS: readonly string[] = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "COMSPEC",
  "SHELL",
  "TMP",
  "TEMP",
];

/**
 * Naming class for the per-run config homes, spelled ONCE: `createIsolated…`
 * mints with it and the boot sweep reclaims by it. Two copies would let the two
 * drift, and a drifted sweep leaves credentials at rest while its own tests stay
 * green — so `ambient-config.test.ts` mints a real dir and sweeps it.
 */
export const ISOLATED_CLAUDE_CONFIG_DIR_PREFIX = "aoa-claude-config-";

/**
 * Where per-run config homes live: an AoA-owned directory under the user
 * profile, NOT `os.tmpdir()`.
 *
 * 🚨 THIS IS A SECURITY BOUNDARY, and `os.tmpdir()` was the wrong side of it.
 * These directories hold a copy of the operator's Claude OAuth credential, and
 * `%TEMP%` on Windows is shared by default — a real machine was measured
 * carrying eight non-inherited `(OI)(CI)` Modify ACEs for other principals,
 * including a group. Object-inherit means every new file underneath is
 * group-readable and -writable, and the copied credential has no DACL of its own
 * to fall back on. On a service-account deployment `%TEMP%` is `C:\Windows\Temp`,
 * which is worse. Since provisioning is what MOVES the credential out of
 * profile-ACL'd `~/.claude`, keeping it in tmpdir would be a regression this
 * change introduced rather than one it inherited.
 *
 * The precedent is codex's managed home (`codex-local/src/server/codex-home.ts`),
 * which solves the identical "copy a credential into a scoped home so the CLI
 * authenticates" problem by rooting under the user profile. `AOA_HOME` (default
 * `~/.aoa`) is already that root, and honoring it also keeps e2e/QA instances
 * isolated from each other for free.
 */
export function resolveIsolatedClaudeConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveAoaInstanceRootForAdapter({ env }), "claude-config-homes");
}

/**
 * Per-run config homes minted by THIS process that are still in use.
 *
 * The sweep's age check cannot protect a live run on its own: a directory's
 * mtime only moves when an entry is created/renamed/removed directly inside it —
 * not when the CLI writes into `sessions/`, and not when it rewrites
 * `.credentials.json` in place. So mtime is "run start, plus the first few
 * minutes" and then static, while `timeoutSec` defaults to 0 (no timer armed),
 * which makes the default run unbounded. A run past the reclaim age would have
 * its config home deleted underneath it, and the CLI writes session state there,
 * so the failure is an ENOENT mid-session rather than the loss of a file already
 * read.
 *
 * Registering live directories makes same-process runs race-proof by
 * construction and returns the mtime rule to what it is actually good for:
 * orphans left by a PREVIOUS boot, which by definition are in no set.
 */
const LIVE_ISOLATED_CLAUDE_CONFIG_DIRS = new Set<string>();

/**
 * Create the per-run directory `CLAUDE_CONFIG_DIR` is pinned to, so the CLI
 * reads its config from a location the operator's `~/.claude` cannot reach.
 *
 * `mkdtemp` (not a deterministic name) is deliberate — see codex-exec.ts:88-101
 * for why a predictable path is attackable — and the root is mode 0700 on POSIX.
 * On Windows the protection is that the root sits inside the user profile, whose
 * ACL is the account's own; that is a claim about `~/.aoa`, not about `%TEMP%`.
 *
 * Registers the directory as live. The caller MUST
 * `releaseIsolatedClaudeConfigDir` it when the run ends — `execute`'s `finally`
 * does, next to the removal.
 *
 * Empty on return. `provisionClaudeConfigHome` is what makes it usable.
 */
export async function createIsolatedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const root = resolveIsolatedClaudeConfigRoot(env);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.join(root, ISOLATED_CLAUDE_CONFIG_DIR_PREFIX));
  LIVE_ISOLATED_CLAUDE_CONFIG_DIRS.add(path.resolve(dir));
  return dir;
}

/**
 * Drop a per-run directory from the live set, making it sweepable again.
 *
 * Called BEFORE the removal rather than after: if the `fs.rm` fails (a Windows
 * file handle held open a moment longer), the directory is already releasable
 * and the next sweep reclaims it. Releasing after a failed removal would pin it
 * live forever.
 */
export function releaseIsolatedClaudeConfigDir(dir: string): void {
  LIVE_ISOLATED_CLAUDE_CONFIG_DIRS.delete(path.resolve(dir));
}

/** Exported for tests — the live set is otherwise unobservable. */
export function isLiveIsolatedClaudeConfigDir(dir: string): boolean {
  return LIVE_ISOLATED_CLAUDE_CONFIG_DIRS.has(path.resolve(dir));
}

/**
 * Render a path with the user's home directory collapsed to `~`.
 *
 * `ClaudeCredentialsMissingError`'s message is persisted verbatim to
 * `internal_agent_runs.errorMessage` and surfaced on the crew failure card, so
 * an un-relativised `C:\Users\<name>\.claude` would broadcast the operator's
 * account name to every teammate with thread access. Only the display is
 * changed; the error keeps the real paths on its own fields for logs.
 */
function homeRelative(target: string): string {
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(target);
  if (resolved === home) return "~";
  if (resolved.startsWith(home + path.sep)) {
    return `~${path.sep}${resolved.slice(home.length + 1)}`;
  }
  return resolved;
}

/**
 * The source config home held no credential file. Thrown BEFORE the spawn so an
 * unauthenticated agent never runs: the alternative is a `--print` run that dies
 * somewhere inside the CLI with a message the founder cannot act on (or, worse,
 * blocks on an interactive login prompt that nobody can answer).
 *
 * The message is the entire founder-facing diagnosis — it names the path we
 * looked in and the command that fixes it — because it is what lands verbatim in
 * `internal_agent_runs.errorMessage` and on the crew failure card.
 */
export class ClaudeCredentialsMissingError extends Error {
  readonly code = "claude_credentials_missing";
  constructor(
    readonly sourceConfigHome: string,
    readonly credentialPath: string,
  ) {
    // Paths are home-relativised: this string is persisted and shown to every
    // teammate with thread access, and `C:\Users\<name>\…` would put the
    // operator's account name in front of all of them. `~/.claude` is exactly as
    // actionable and says nothing about who they are.
    super(
      `Claude credentials not found at ${homeRelative(credentialPath)}. Crew runs are isolated ` +
        `from the host machine's Claude config (D9), so they authenticate from a copy of that ` +
        `one file and nothing else. Run \`claude auth login\` on the machine running AoA so the ` +
        `credential exists in ${homeRelative(sourceConfigHome)}, then dispatch again. ` +
        `(Alternatively, set an env-based auth mode — ANTHROPIC_API_KEY, ` +
        `CLAUDE_CODE_USE_BEDROCK, ANTHROPIC_BASE_URL — or a dedicated CLAUDE_CONFIG_DIR on this ` +
        `agent's adapterConfig.env.)`,
    );
    this.name = "ClaudeCredentialsMissingError";
  }
}

/**
 * Provision the per-run config home: copy the credential file, and ONLY the
 * credential file.
 *
 * A real operator config home has 20 entries; 19 of them are exactly the
 * contamination D9 exists to stop (`CLAUDE.md`, `settings.json`, `plugins/`,
 * `skills/`, `sessions/`, `projects/`, …). So this is an explicit single-file
 * copy rather than a copy-with-exclusions: an allowlist of one cannot silently
 * grow when Claude Code adds a directory we have never heard of.
 *
 * 🚨 `sourceConfigHome` MUST be resolved from the AMBIENT environment
 * (`resolveClaudeConfigHome(process.env)`) BEFORE the caller pins
 * `CLAUDE_CONFIG_DIR` to `targetDir`. Resolve it from the overlay, or after the
 * pin, and the source IS the target: an empty directory copied onto itself,
 * "succeeding" while provisioning nothing. The source===target guard below turns
 * that inversion into a loud throw instead of a baffling auth failure.
 *
 * ── OPEN RISK: credential rotation inside the per-run copy ──────────────────
 *
 * The credential is an OAuth bundle — measured on a dogfood machine it carries
 * `accessToken`, `refreshToken`, `expiresAt` and an 8-hour access-token
 * lifetime. So a per-run copy CAN go stale mid-run, and the CLI holding it has
 * everything it needs to refresh.
 *
 * If the refresh rotates the refresh token server-side, then whichever copy
 * refreshes wins and every other holder — INCLUDING the operator's real
 * `~/.claude` — is left with a dead one. That would look exactly like "a crew
 * run silently logged the founder out of their own CLI", and this project has a
 * prior false alarm with that same signature (a "Commander OAuth revoked"
 * report that turned out to be a Claude Code child-session artifact), so it is
 * worth being precise rather than fast.
 *
 * What was actually measured, and what was NOT:
 *   - MEASURED: the host credential file's mtime equals its birthtime and it had
 *     not been rewritten 18.5h after creation, despite its access token having
 *     expired 10.5h earlier. So the CLI does not rewrite this file merely
 *     because the token aged.
 *   - NOT MEASURED: whether a refresh rewrites it, and whether Anthropic rotates
 *     refresh tokens on use. Settling that needs a long-running real crew run
 *     that crosses the 8h boundary — it cannot be inferred from a file listing.
 *
 * DECISION: no copy-back. Writing a rotated credential back into the operator's
 * real `~/.claude` is a write into a file AoA otherwise refuses to touch (the
 * same reason an agent-configured CLAUDE_CONFIG_DIR is never written into), and
 * with concurrent crew runs it invites clobbering a newer token with an older
 * one. Implementing it on an unmeasured premise would be guessing in the
 * direction that does more damage if the guess is wrong.
 *
 * INSTEAD: `provisionClaudeConfigHome` returns a fingerprint of the file it
 * wrote, and the caller compares it at teardown
 * (`claudeCredentialChangedSinceProvisioning`). If the child ever DOES rewrite
 * its copy, the first occurrence is logged loudly instead of vanishing with the
 * directory — which is the observation that settles the question. Revisit this
 * decision the first time that warning fires.
 */
export async function provisionClaudeConfigHome(args: {
  /** The operator's config home — the copy SOURCE. See the ordering note above. */
  sourceConfigHome: string;
  /** The per-run directory `CLAUDE_CONFIG_DIR` is pinned to — the copy TARGET. */
  targetDir: string;
  /** Overridable for tests only; production always uses claude's real filename. */
  credentialFileName?: string;
}): Promise<{ credentialPath: string; fingerprint: string }> {
  const credentialFileName = args.credentialFileName ?? CLAUDE_CREDENTIAL_FILE_NAME;
  const source = path.resolve(args.sourceConfigHome);
  const target = path.resolve(args.targetDir);
  if (source === target) {
    throw new Error(
      `Refusing to provision a Claude config home from the same directory it targets ` +
        `(${target}). The operator's config home must be resolved from the ambient ` +
        `environment BEFORE CLAUDE_CONFIG_DIR is pinned to the per-run directory.`,
    );
  }

  const from = path.join(source, credentialFileName);
  const to = path.join(target, credentialFileName);
  const stat = await fs.stat(from).catch(() => null);
  // `isFile()` and not bare existence: a directory named `.credentials.json`
  // would make `copyFile` fail with EISDIR, which reads as an internal error
  // rather than "you are not logged in".
  if (!stat?.isFile()) {
    throw new ClaudeCredentialsMissingError(source, from);
  }

  // Only after the credential is known to exist — a failed provisioning should
  // not leave a directory behind for the sweep to reclaim. `mode` applies only
  // when this actually creates the directory; the normal caller passes one
  // `mkdtemp` already made 0700.
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  // COPYFILE_EXCL turns the docblock's "freshly minted target" promise into a
  // checked invariant: a caller that reuses a directory, or two runs somehow
  // sharing one, fails here instead of silently overwriting a credential.
  await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
  // `copyFile` carries the SOURCE's mode across, so a world-readable `~/.claude`
  // would produce a world-readable copy. Clamp it. Windows has no POSIX modes —
  // `chmod` there only toggles the read-only bit — which is precisely why the
  // per-run root lives under the user profile rather than in shared `%TEMP%`
  // (see `resolveIsolatedClaudeConfigRoot`); the directory's ACL is the
  // protection there, and it is a real one.
  if (process.platform !== "win32") {
    await fs.chmod(to, 0o600);
  }
  return { credentialPath: to, fingerprint: await fingerprintCredential(to) };
}

/**
 * Cheap change-detector for the provisioned credential: size + mtime, which is
 * all that is needed to notice a rewrite and involves no token material.
 * Deliberately not a content hash — this never needs to read the secret.
 */
async function fingerprintCredential(credentialPath: string): Promise<string> {
  const stat = await fs.stat(credentialPath).catch(() => null);
  return stat ? `${stat.size}:${stat.mtimeMs}` : "absent";
}

/**
 * Did the child rewrite its private copy of the credential during the run?
 *
 * See the rotation note on `provisionClaudeConfigHome`. A `true` here is the
 * observation that decides whether copy-back is needed — it means the CLI
 * refreshed into a file that is about to be deleted, and therefore that the
 * operator's host credential may have been rotated out from under them.
 * Best-effort: an unreadable file reports no change rather than throwing during
 * teardown.
 */
export async function claudeCredentialChangedSinceProvisioning(
  credentialPath: string,
  fingerprint: string,
): Promise<boolean> {
  const current = await fingerprintCredential(credentialPath);
  return current !== "absent" && current !== fingerprint;
}

/**
 * Auth variables an operator can set on the agent's `adapterConfig.env`, which
 * survive the ambient strip by the overlay-wins rule (see the module header).
 *
 * This list exists so provisioning does not BREAK that documented escape hatch:
 * an operator on Bedrock/Vertex/a gateway has no `.credentials.json` and never
 * needed one, and turning their working configuration into a hard failure would
 * be a regression T2 explicitly protected against.
 *
 * ONE map, not a list plus a second list of exceptions. The shape is chosen at
 * the point of edit, so adding a key forces the author to answer "value or
 * switch?" right there. The previous shape — an exported key list beside a
 * module-private list of which ones were booleans — meant a contributor adding
 * `CLAUDE_CODE_USE_VERTEX_AI` would find the exported list, add it, and stop,
 * silently reinstating the "an explicitly-disabled switch counts as configured
 * auth" bug the split was introduced to fix.
 *
 *   value  — a key, token, URL or id. No falsy spelling: non-empty means set.
 *   switch — a boolean. `0`/`false`/`no`/`off` means the operator turned this
 *            auth mode OFF, which is emphatically not "auth is configured".
 */
const CLAUDE_OVERLAY_AUTH_KEY_SHAPES = {
  ANTHROPIC_API_KEY: "value",
  ANTHROPIC_AUTH_TOKEN: "value",
  CLAUDE_CODE_OAUTH_TOKEN: "value",
  CLAUDE_CODE_USE_BEDROCK: "switch",
  ANTHROPIC_BEDROCK_BASE_URL: "value",
  CLAUDE_CODE_USE_VERTEX: "switch",
  ANTHROPIC_VERTEX_PROJECT_ID: "value",
  ANTHROPIC_BASE_URL: "value",
} as const satisfies Record<string, "value" | "switch">;

export const CLAUDE_OVERLAY_AUTH_KEYS: readonly string[] = Object.keys(
  CLAUDE_OVERLAY_AUTH_KEY_SHAPES,
);

/** Spellings Claude Code treats as "off" for its boolean switches. */
const FALSY_ENV_VALUES = new Set(["0", "false", "no", "off"]);

/** Folded key → shape, built once. Windows folds; POSIX is exact. */
const FOLDED_AUTH_KEY_SHAPES = new Map<string, "value" | "switch">(
  Object.entries(CLAUDE_OVERLAY_AUTH_KEY_SHAPES).map(([key, shape]) => [foldEnvKey(key), shape]),
);

/**
 * Does the agent's own overlay already carry a working auth mode?
 *
 * Case-folded via `foldEnvKey` — literally the function `mergeChildEnv`'s strip
 * uses, so the claim that the two agree is true by construction rather than by
 * comment. It matters because an operator who wrote `Anthropic_Api_Key` on
 * Windows configured `ANTHROPIC_API_KEY`, and would otherwise be told to run
 * `claude auth login` for auth they already have.
 */
export function hasOverlayConfiguredClaudeAuth(env: Record<string, string>): boolean {
  return Object.entries(env).some(([key, value]) => {
    const shape = FOLDED_AUTH_KEY_SHAPES.get(foldEnvKey(key));
    if (!shape) return false;
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    if (shape === "switch" && FALSY_ENV_VALUES.has(trimmed.toLowerCase())) return false;
    return true;
  });
}

export interface ClaudeConfigDirSweepResult {
  scanned: number;
  removed: number;
  failed: number;
  /** Skipped because a run in THIS process still holds them. */
  live: number;
}

/**
 * Reclaim age for ORPHANS — directories left by a previous boot, which is the
 * only population this age check now governs. Runs in this process are excluded
 * outright via the live set, so this no longer has to be a bet on how long a
 * crew run can last; it only bounds how long a credential from a crashed
 * previous boot sits on disk.
 */
export const ISOLATED_CLAUDE_CONFIG_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Reclaim orphaned per-run config homes.
 *
 * `execute`'s `finally` removes the directory for every run that returns or
 * throws, but a SIGKILL (or a crashed previous boot) leaves one behind. Before
 * provisioning an orphan was junk; now it holds the operator's Claude
 * credential, which is why this sweep exists at all.
 *
 * 🚨 A directory a live run still holds is NEVER swept, whatever its age. Age
 * alone cannot protect it: a directory's mtime moves only when an entry is
 * created/renamed/removed directly inside it — not when the CLI writes into
 * `sessions/`, not when it rewrites `.credentials.json` in place — so mtime goes
 * static minutes into a run, while `timeoutSec` defaults to 0 and leaves the run
 * unbounded. Deleting a live config home is not "losing a file already read":
 * the CLI keeps session state there, so it surfaces as an ENOENT mid-session.
 *
 * SCOPE: this instance's root only (`AOA_HOME` + `AOA_INSTANCE_ID`). A second
 * instance's orphans are deliberately left alone — the live set is per-process,
 * so sweeping a sibling root could delete a directory a concurrently-running
 * instance is actively using, which is worse than leaving an orphan for that
 * instance's own boot sweep to collect. The residue is an operator who RENAMES
 * their instance id, whose old root then has no sweeper; that is rare, visible
 * (`$AOA_HOME/instances/<old>/claude-config-homes`), and safe to delete by hand.
 *
 * Best-effort by construction: every failure mode — an unreadable root, a
 * directory held open by a live process on Windows, AND a root that cannot even
 * be resolved — is counted, never thrown. Boot must not be blocked or failed by
 * housekeeping, and that has to be true of this function itself rather than of
 * the wrapper that happens to call it.
 */
export async function sweepOrphanedIsolatedClaudeConfigDirs(opts?: {
  /** The per-run root. Defaults to the same one `createIsolated…` mints under. */
  rootDir?: string;
  maxAgeMs?: number;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ClaudeConfigDirSweepResult> {
  // ONE constant behind both the mint and the sweep — a second spelling of the
  // root is how a sweep silently stops finding what the mint creates.
  //
  // Resolution is INSIDE the absorbing region: `resolveAoaInstanceRootForAdapter`
  // throws on a malformed `AOA_INSTANCE_ID`, and leaving that outside would make
  // the "never thrown" promise above false — technically survivable, because the
  // server wrapper catches, but a docblock that overstates what the code
  // guarantees is exactly the failure mode that put the credential in `%TEMP%`.
  // The function keeps its own promise.
  let rootDir: string;
  try {
    rootDir = opts?.rootDir ?? resolveIsolatedClaudeConfigRoot(opts?.env ?? process.env);
  } catch {
    return { scanned: 0, removed: 0, failed: 0, live: 0 };
  }
  const maxAgeMs = opts?.maxAgeMs ?? ISOLATED_CLAUDE_CONFIG_MAX_AGE_MS;
  const now = opts?.now ?? Date.now();

  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return { scanned: 0, removed: 0, failed: 0, live: 0 };

  let scanned = 0;
  let removed = 0;
  let failed = 0;
  let live = 0;
  for (const entry of entries) {
    // Directories only, and only ones WE minted. A file that happens to share
    // the prefix is not ours to delete.
    if (!entry.isDirectory() || !entry.name.startsWith(ISOLATED_CLAUDE_CONFIG_DIR_PREFIX)) continue;
    const dir = path.join(rootDir, entry.name);
    scanned++;
    // Before the age check, not after: a live run is protected regardless of how
    // long it has been running.
    if (isLiveIsolatedClaudeConfigDir(dir)) {
      live++;
      continue;
    }
    // mtime, not birthtime: birthtime is unreliable on several filesystems. It
    // is a weak signal — see the note above — but for the only population that
    // reaches here (orphans from a dead process) "old enough" is sufficient.
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat) {
      failed++;
      continue;
    }
    if (now - stat.mtimeMs < maxAgeMs) continue;
    try {
      await fs.rm(dir, { recursive: true, force: true });
      removed++;
    } catch {
      failed++;
    }
  }
  return { scanned, removed, failed, live };
}
