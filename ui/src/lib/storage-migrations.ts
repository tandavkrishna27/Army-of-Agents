import { migrateStorageKey, migrateStorageKeyPrefix } from "./storage-migration";

/**
 * Run every Paperclip → AoA localStorage migration registered below.
 * Idempotent: safe to call on every boot. Each individual migration
 * is a no-op once the old key is gone.
 *
 * Call this once, early in app boot — before any context provider
 * reads from localStorage.
 */
export function runStorageMigrations(): void {
  // Single keys (paperclip:* and paperclip.* — both punctuations were used).
  const single: Array<[string, string]> = [
    ["paperclip:inbox:dismissed", "aoa:inbox:dismissed"],
    ["paperclip:inbox:dismissed:migrated", "aoa:inbox:dismissed:migrated"],
    ["paperclip.theme", "aoa.theme"],
    ["paperclip:sidebar-collapsed", "aoa:sidebar-collapsed"],
    ["paperclip.selectedCompanyId", "aoa.selectedCompanyId"],
    ["paperclip.companyPaths", "aoa.companyPaths"],
    ["paperclip:agent-panel-open", "aoa:agent-panel-open"],
    ["paperclip:recent-assignees", "aoa:recent-assignees"],
    ["paperclip:issues-view", "aoa:issues-view"],
    ["paperclip:issue-draft", "aoa:issue-draft"],
  ];
  for (const [oldKey, newKey] of single) migrateStorageKey(oldKey, newKey);

  // Prefix-based: keys that include a dynamic id suffix.
  migrateStorageKeyPrefix("paperclip.projectOrder:", "aoa.projectOrder:");
  migrateStorageKeyPrefix("paperclip:project-view:", "aoa:project-view:");
  migrateStorageKeyPrefix("paperclip:issue-comment-draft:", "aoa:issue-comment-draft:");

  // Already-deprecated keys (cleanup-on-boot pattern in Layout.tsx) — don't
  // migrate, just delete.
  if (typeof window !== "undefined") {
    for (const dead of ["paperclip.companyOrder", "paperclip:panel-visible"]) {
      localStorage.removeItem(dead);
    }
  }
}
