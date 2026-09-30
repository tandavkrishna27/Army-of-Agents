/**
 * DAT-owned snapshot size ceilings (DAT-001-D6).
 *
 * These are DISTINCT from the frozen schema maxes (the schema caps entries at
 * 1,000,000 and each `sizeBytes` at `Number.MAX_SAFE_INTEGER`). The DAT ceilings
 * are the producer's own fail-closed policy: exceeding ANY of them throws a
 * `WorkspaceSnapshotError` and rejects the whole snapshot — the producer never
 * silently skips an oversize file (contrast the diff/output-capture pipeline in
 * `server/src/services/output-detection.ts`, which is NOT a canonical snapshot).
 *
 * The defaults are the design's proposed starting points; a caller may pass a
 * stricter `SnapshotLimits`. `maxEntries` may not exceed the schema's cap.
 */

/** The frozen `workspaceManifestV1Schema` entry-count cap. */
export const SCHEMA_MAX_ENTRIES = 1_000_000;

export interface SnapshotLimits {
  /** Per-file byte ceiling; a single file larger than this rejects the snapshot. */
  readonly maxFileBytes: number;
  /** Cumulative byte ceiling across all files; the running total rejects on breach. */
  readonly maxTotalBytes: number;
  /** Entry-count ceiling (files + directories); must be ≤ {@link SCHEMA_MAX_ENTRIES}. */
  readonly maxEntries: number;
}

/** Design defaults: 100 MiB / 2 GiB / 1,000,000 (DAT-001-D6). */
export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: SCHEMA_MAX_ENTRIES,
};
