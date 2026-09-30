// Phase 6.2 follow-up (Codex P1, round 2):
// Decide whether an upload should be allowed in the current memory scope.
// `MemoryExplorer` previously rendered the upload button for every non-home
// state, which included layer-only views (Identity, Domain, etc) and virtual
// shortcuts (Pinned, Pending, Recent, Archived). In those scopes the upload
// would succeed but the asset would never be visible: layer/virtual modes in
// `MemoryFileList` intentionally suppress assets, so files were stored at "" or
// at a reserved sentinel path and effectively orphaned.
//
// This helper centralizes the gate so the rule lives in one place and is
// independently testable.

export const VIRTUAL_FOLDER_PATHS = [
  "__pinned",
  "__pending",
  "__recent",
  "__archived",
] as const;

export type VirtualFolderPath = (typeof VIRTUAL_FOLDER_PATHS)[number];

export function isVirtualFolderPath(folderPath: string): boolean {
  return (VIRTUAL_FOLDER_PATHS as readonly string[]).includes(folderPath);
}

interface UploadScopeArgs {
  folderPath: string;
  departmentId: string | null;
  layer: string | null;
}

/**
 * Returns true when the current memory scope has a concrete destination an
 * upload can land at and remain visible to the user.
 *
 * Allowed scopes:
 *   - Concrete folder (folderPath is a real, non-virtual path)
 *   - Department root (folderPath empty + departmentId set + no layer override)
 *
 * Disallowed scopes:
 *   - Home (no folder, no dept, no layer)
 *   - Layer-only (Identity / Domain / Active Context / Working — folderPath empty,
 *     departmentId null, layer set). Layer views suppress assets, so the upload
 *     would be invisible.
 *   - Virtual shortcuts (Pinned, Pending, Recent, Archived). These are derived
 *     views, not real folders.
 */
export function canUploadInScope(args: UploadScopeArgs): boolean {
  const { folderPath, departmentId, layer } = args;

  // Virtual shortcuts: never accept uploads.
  if (isVirtualFolderPath(folderPath)) return false;

  // Concrete folder path (e.g. "engineering/Decisions"): allowed.
  if (folderPath) return true;

  // Dept root (folderPath empty, dept set, no layer): allowed — upload lands at
  // <deptSlug> via MemoryUploadButton's deptSlug fallback.
  if (departmentId && !layer) return true;

  // Everything else (home, layer-only): no concrete destination → block.
  return false;
}
