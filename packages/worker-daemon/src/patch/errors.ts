/**
 * DAT-003 — the fail-closed error for the workspace-patch producer.
 *
 * Mirrors `snapshot/errors.ts` `WorkspaceSnapshotError`: every rejection collapses
 * the WHOLE patch (never a silent partial diff). A no-op diff, an internal
 * invariant break, or the final frozen `.parse()` gate all surface here.
 */
export class WorkspacePatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePatchError";
  }
}
