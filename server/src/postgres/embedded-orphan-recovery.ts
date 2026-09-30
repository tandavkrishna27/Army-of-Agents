import { exec } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";

const execAsync = promisify(exec);

/**
 * On Windows the embedded postgres can leave an orphan postgres.exe process
 * behind after a hard-kill of the parent Node. The next startup detects the
 * stale lock file but cannot start a new postgres because the orphan still
 * holds the shared-memory block. This helper best-effort kills any postgres
 * processes whose CommandLine references the given data directory.
 *
 * No-op on non-Windows platforms: those platforms clean up cleanly on parent
 * exit via signal propagation.
 */
export async function tryRecoverOrphanPostgres(opts: {
  dataDir: string;
}): Promise<void> {
  if (process.platform !== "win32") return;

  // Match postgres.exe whose CommandLine includes the absolute dataDir path.
  // Forward-slashes in dataDir are tolerated by Windows but we normalize to
  // backslashes for the CIM query match, and double single-quotes for
  // PowerShell's standard quote-escape rule — an unescaped apostrophe in a
  // username (legal NTFS char) would otherwise unbalance the -like pattern
  // and trigger a silent parse failure.
  const dataDirPattern = opts.dataDir.replace(/\//g, "\\\\").replace(/'/g, "''");

  const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='postgres.exe'\\" | Where-Object { $_.CommandLine -like '*${dataDirPattern}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;

  try {
    await execAsync(cmd, { timeout: 10_000 });
  } catch (err) {
    logger.warn(
      {
        dataDir: opts.dataDir,
        err: err instanceof Error ? err.message : String(err),
      },
      "embedded-postgres orphan recovery: kill attempt failed (best-effort, boot will continue)",
    );
  }
}
