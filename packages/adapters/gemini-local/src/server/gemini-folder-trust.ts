import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * gemini-cli's workspace-trust model silently disables MCP.
 *
 * ── THE PROBLEM (Plan 2b B7, corrected) ─────────────────────────────────────
 * When folder trust is enabled and the working folder is not trusted,
 * gemini-cli loads **ZERO MCP servers** — not just external connectors, but
 * AoA's own `aoa` loopback bridge as well. It prints
 *
 *   "MCP servers are configured but disabled because this folder is untrusted.
 *    User-level servers are also suppressed…"
 *
 * and continues. The run SUCCEEDS. The agent simply has no tools, does nothing
 * useful, and reports completion — the exact silent-capability-loss failure the
 * connector work exists to prevent, except total.
 *
 * ── WHAT DOES NOT FIX IT (empirically disproven — do not retry) ─────────────
 * Probed against the real CLI under an isolated HOME with folder trust enabled,
 * using a stdio recorder that writes a marker file the instant it is spawned
 * (a signal independent of gemini's model call, which 403s without quota):
 *
 *   | config                      | recorder spawned? |
 *   |-----------------------------|-------------------|
 *   | plain                       | NO (warning shown)|
 *   | `--skip-trust`              | NO (warning only  |
 *   |                             |  suppressed)      |
 *   | per-server `"trust": true`  | NO                |
 *
 * With folder trust DISABLED (the default) all three spawn normally.
 *
 * `--skip-trust` is documented as "Trust the current workspace for this
 * session", which reads like the remedy — it is not. It suppresses the WARNING
 * while leaving MCP disabled, which is strictly worse than doing nothing:
 * the operator loses the one signal that told them why the agent had no tools.
 * **Do not add `--skip-trust` to the adapter's argv.** An earlier draft of the
 * plan assumed it was the fix; that assumption was wrong.
 *
 * There is also no trust registry AoA could legitimately write:
 * `~/.gemini/projects.json` is only a project-NAME map, and no
 * `trustedFolders.json` is ever created.
 *
 * ── SO: DETECT AND WARN ─────────────────────────────────────────────────────
 * No programmatic remedy is currently known, so the adapter's obligation is to
 * make the failure LOUD rather than silent. This module answers "is folder
 * trust switched on?" so `execute()` can say plainly that this run will have no
 * tools and which setting caused it. Detection is best-effort by construction:
 * an unreadable or malformed settings file must never fail a run, and must
 * never produce a spurious warning either.
 */

/** Where a folder-trust setting was found. */
export interface GeminiFolderTrustDetection {
  enabled: boolean;
  /** Absolute path of the settings file that enabled it, for the warning. */
  source: string | null;
}

/**
 * Read `enabled` out of one settings object.
 *
 * Two shapes are accepted because gemini-cli's settings schema has moved: the
 * current nesting is `security.folderTrust.enabled`, and older/looser forms put
 * `folderTrust` at the top level (either a bare boolean or an object with
 * `enabled`). Checking all three is cheap; missing a shape means shipping the
 * silent failure this module exists to surface.
 */
function readsFolderTrustEnabled(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const root = parsed as Record<string, unknown>;

  const security = root.security;
  if (security && typeof security === "object") {
    const ft = (security as Record<string, unknown>).folderTrust;
    if (ft === true) return true;
    if (ft && typeof ft === "object" && (ft as Record<string, unknown>).enabled === true) {
      return true;
    }
  }

  const legacy = root.folderTrust;
  if (legacy === true) return true;
  if (
    legacy
    && typeof legacy === "object"
    && (legacy as Record<string, unknown>).enabled === true
  ) {
    return true;
  }

  return false;
}

async function fileEnablesFolderTrust(file: string): Promise<boolean> {
  try {
    return readsFolderTrustEnabled(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    // Missing, unreadable, or malformed — report NOT enabled. A false positive
    // here would cry wolf on every run of a perfectly healthy setup, which is
    // how warnings get tuned out.
    return false;
  }
}

/**
 * Detect whether gemini folder trust is switched on for a run in `cwd`.
 *
 * Both scopes gemini reads are checked: user-global `~/.gemini/settings.json`
 * and the workspace `<cwd>/.gemini/settings.json`. The workspace file is the
 * one AoA itself writes, and the writer preserves unrelated user keys, so a
 * trust setting can legitimately live there too.
 */
export async function detectGeminiFolderTrust(
  cwd: string,
  homeDir: string = os.homedir(),
): Promise<GeminiFolderTrustDetection> {
  const candidates = [
    path.join(homeDir, ".gemini", "settings.json"),
    path.join(cwd, ".gemini", "settings.json"),
  ];
  for (const file of candidates) {
    if (await fileEnablesFolderTrust(file)) return { enabled: true, source: file };
  }
  return { enabled: false, source: null };
}

/**
 * The operator-facing warning. Says what is broken, how bad it is, and what NOT
 * to try — a maintainer who reads only this line must not go add `--skip-trust`.
 */
export function geminiFolderTrustWarning(source: string | null): string {
  const where = source ? ` (set in ${source})` : "";
  return (
    `[aoa] WARNING: gemini folder trust is ENABLED${where}. `
    + `gemini will load ZERO MCP servers for this run — external connectors AND `
    + `AoA's own "aoa" bridge — so this agent will run with NO TOOLS and may `
    + `report success having done nothing. Disable folder trust `
    + `(security.folderTrust.enabled) in gemini's settings to restore MCP. `
    + `NOTE: --skip-trust does NOT fix this (verified) — it only hides the `
    + `warning while MCP stays disabled.\n`
  );
}
