/**
 * Narrow suppression of the `node:sqlite` ExperimentalWarning (WRK-006, D1).
 *
 * `node:sqlite` is flag-free on the Node-24 floor but still emits a one-shot
 * `ExperimentalWarning` on first `DatabaseSync` construction. Node emits warnings
 * ASYNCHRONOUSLY (a `process.nextTick` inside `emitWarning`), so a scoped
 * patch-then-restore around the constructor call races: the deferred emission
 * fires after the restore. This installs an idempotent, PROCESS-LIFETIME filter
 * that drops ONLY the SQLite ExperimentalWarning and delegates every other
 * warning to the original emitter untouched — it does NOT globally silence
 * process warnings (only this one string is dropped).
 */

let installed = false;

/** Install the narrow filter once. Idempotent + faithful (all non-SQLite
 * warnings pass through to the original `process.emitWarning`). */
export function installSqliteExperimentalWarningFilter(): void {
  if (installed) return;
  installed = true;
  const original = process.emitWarning.bind(process);
  const filtered: typeof process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const opt = args[0];
    const type = opt !== null && typeof opt === "object" ? (opt as { type?: string }).type : opt;
    const message = typeof warning === "string" ? warning : (warning as Error)?.message ?? "";
    if (type === "ExperimentalWarning" && /SQLite/i.test(String(message))) return;
    (original as (...a: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
  process.emitWarning = filtered;
}
