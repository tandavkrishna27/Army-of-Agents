/**
 * One-time migration helpers for renaming localStorage keys.
 *
 * Pattern: read the old key, copy its value to the new key (only if
 * the new key isn't already set — never clobber fresh user data),
 * then delete the old key. Idempotent: running again is a no-op once
 * the old key is gone.
 *
 * Used by the Paperclip → AoA rebrand to migrate user-visible state
 * (theme, sidebar collapse, drafts, recent picks, etc.) without
 * losing it across the rename.
 */

export function migrateStorageKey(oldKey: string, newKey: string): void {
  if (typeof window === "undefined") return;
  const oldVal = localStorage.getItem(oldKey);
  if (oldVal === null) return;
  if (localStorage.getItem(newKey) === null) {
    localStorage.setItem(newKey, oldVal);
  }
  localStorage.removeItem(oldKey);
}

/**
 * Rename every localStorage key starting with `oldPrefix` to use
 * `newPrefix` instead. Same no-clobber semantics as `migrateStorageKey`.
 */
export function migrateStorageKeyPrefix(oldPrefix: string, newPrefix: string): void {
  if (typeof window === "undefined") return;
  const toMigrate: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(oldPrefix)) toMigrate.push(key);
  }
  for (const oldKey of toMigrate) {
    const newKey = newPrefix + oldKey.slice(oldPrefix.length);
    migrateStorageKey(oldKey, newKey);
  }
}
