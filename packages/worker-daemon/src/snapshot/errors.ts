/**
 * Snapshot producer failure mode (DAT-001).
 *
 * The workspace-snapshot producer is FAIL-CLOSED: any condition it cannot
 * represent as a valid `WorkspaceManifestV1` — a special/device file, a symlink,
 * an unsafe path, a size-ceiling breach, an ignored-file leak, a declared/actual
 * git object-format mismatch, or a self-validation (`.parse()`) failure — throws
 * this error and rejects the WHOLE snapshot. It never silently skips an entry.
 */
export class WorkspaceSnapshotError extends Error {
  constructor(message = "workspace snapshot is invalid") {
    super(message);
    this.name = "WorkspaceSnapshotError";
  }
}
