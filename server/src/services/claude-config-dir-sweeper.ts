import {
  ISOLATED_CLAUDE_CONFIG_MAX_AGE_MS,
  sweepOrphanedIsolatedClaudeConfigDirs,
} from "@armyofagents/adapter-claude-local/server";
import { logger } from "../middleware/logger.js";

/**
 * Reclaim orphaned per-run Claude config homes.
 *
 * A crew run mints one of those directories under the AoA instance root and
 * copies the operator's Claude credential into it (D9 / T3). `execute`'s
 * `finally` removes it for every run that returns or throws — but a SIGKILL, or
 * a crashed previous boot, leaves one behind. Before provisioning existed an
 * orphan was junk; now it holds a credential, which is the whole reason this
 * sweeper exists.
 *
 * The adapter owns the location, the naming class and the age policy — this
 * module is only the scheduling + logging half, so the server never re-spells
 * any of them.
 *
 * Best-effort by construction: the sweep itself never throws, and the schedule
 * wraps it anyway. Housekeeping must not be able to block or fail boot.
 */
export async function runClaudeConfigDirSweep(): Promise<void> {
  const result = await sweepOrphanedIsolatedClaudeConfigDirs().catch((err) => {
    logger.warn({ err }, "orphaned Claude config-dir sweep failed (non-fatal)");
    return null;
  });
  if (result && (result.removed > 0 || result.failed > 0)) {
    logger.info({ ...result }, "reclaimed orphaned per-run Claude config directories");
  }
}

/**
 * Boot sweep + a periodic repeat. The boot pass is what clears anything a crash
 * or SIGKILL left behind while the server was down; the interval bounds how long
 * an orphan from a still-running instance sits on disk. Fires immediately
 * (unawaited — boot never waits on housekeeping) and then on the interval.
 *
 * Cadence defaults to hourly, well below the adapter's reclaim age, so an orphan
 * is removed close to the moment it becomes eligible.
 */
export function scheduleClaudeConfigDirSweeper(
  intervalMs = Math.min(60 * 60 * 1000, ISOLATED_CLAUDE_CONFIG_MAX_AGE_MS),
): NodeJS.Timeout {
  void runClaudeConfigDirSweep();
  return setInterval(() => {
    void runClaudeConfigDirSweep();
  }, intervalMs);
}
