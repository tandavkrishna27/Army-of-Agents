import path from "node:path";
import { expandHomePrefix } from "../config/home.js";

/**
 * Resolve the REQUIRED `--file` argument for `aoa db:restore` to an absolute backup path.
 *
 * A restore with no source file must fail LOUDLY. `runDatabaseRestore` overwrites the target
 * database's schema and data, so silently resolving an unset `--file` (to the cwd, or anywhere)
 * is the one outcome an operator must never get. Extracted from the command so this guard is
 * unit-testable without loading the `@armyofagents/db` barrel or the CLI IO layer — the CLI test
 * convention is to test pure helpers directly (see `data-dir.test.ts`).
 */
export function resolveRestoreBackupFile(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new Error(
      "A backup file is required. Pass --file <path> to the backup (.dump/.sql) to restore from.",
    );
  }
  return path.resolve(expandHomePrefix(trimmed));
}
