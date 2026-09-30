// server/src/services/browser-artifact-retention.ts
//
// BRW-001 — artifact retention as a TOTAL FUNCTION of artifact kind.
//
// Acceptance requires artifact retention be MANDATORY. It is modelled as a total function
// over the closed frozen `ARTIFACT_KINDS` enum, control-plane-owned, and never caller- or
// worker-supplied:
//
//   1. MANDATORY MEANS NO ABSENT PATH. A total function over a closed enum cannot return
//      "unset". Per-job caller-chosen retention has a missing/null path by construction.
//   2. SECURITY. A caller or worker choosing the retention of a `browser_cookie_state` or
//      `browser_storage_state` artifact is a privilege the threat model must not grant —
//      those artifacts carry live session credentials.
//   3. It needs no storage, so no migration and no schema coupling.
//
// `artifactManifestV1Schema.retention` is already a REQUIRED frozen field. This map is what
// guarantees a correct value is always available when BRW-003 stamps a manifest.
//
// The parameter is `string`, not `ArtifactKind`, on purpose: artifact kinds cross a JSON
// boundary and are not type-checked at runtime, so the function must fail safe on a value
// the type system never saw. Totality is enforced on the MAP via `satisfies`, which is the
// thing that actually has to be exhaustive.
import type { ArtifactKind, ArtifactRetentionClass } from "@armyofagents/worker-protocol";

/** The frozen artifact kinds produced by a browser session. Every one is `restricted`
 * (`RESTRICTED_ARTIFACT_KINDS = ARTIFACT_KINDS` in the frozen protocol). */
export const BROWSER_ARTIFACT_KINDS = [
  "screenshot",
  "dom_snapshot",
  "browser_cookie_state",
  "browser_storage_state",
  "playwright_trace",
  "browser_video",
  "download",
] as const satisfies readonly ArtifactKind[];

/** Artifacts whose bytes ARE a usable credential. Anything longer than `ephemeral` leaves a
 * live session credential on disk after the session that minted it has ended. */
export const CREDENTIAL_BEARING_ARTIFACT_KINDS = [
  "browser_cookie_state",
  "browser_storage_state",
] as const satisfies readonly ArtifactKind[];

/** The shortest-lived class. Also the fail-safe answer for an unrecognised kind. */
const FAIL_SAFE_RETENTION: ArtifactRetentionClass = "ephemeral";

// EXHAUSTIVENESS GUARD — `satisfies Record<ArtifactKind, ArtifactRetentionClass>` makes a
// newly added frozen artifact kind a COMPILE error here. Without it a new kind would fall
// through to the fail-safe silently, and "retention is mandatory" would quietly become
// "retention is ephemeral by accident".
const RETENTION_BY_KIND = {
  // Browser evidence — useful for the life of the run, no longer.
  screenshot: "run",
  dom_snapshot: "run",
  playwright_trace: "run",
  browser_video: "run",
  download: "run",
  // Browser credential material — shortest possible life.
  browser_cookie_state: "ephemeral",
  browser_storage_state: "ephemeral",
  // Non-browser kinds, mapped so the function is total over the whole frozen enum.
  workspace_snapshot: "run",
  workspace_patch: "run",
  log: "run",
  service_checkpoint: "checkpoint",
  other: "ephemeral",
} as const satisfies Record<ArtifactKind, ArtifactRetentionClass>;

/**
 * The retention class for an artifact kind. Total: every frozen kind has a mapping, and an
 * unrecognised value fails safe to the shortest retention rather than the longest.
 *
 * Uses a null-prototype lookup so `__proto__` / `constructor` cannot resolve to an
 * inherited property instead of falling through to the fail-safe.
 */
const RETENTION_LOOKUP: Record<string, ArtifactRetentionClass> = Object.assign(
  Object.create(null) as Record<string, ArtifactRetentionClass>,
  RETENTION_BY_KIND,
);

export function browserArtifactRetention(kind: string): ArtifactRetentionClass {
  return RETENTION_LOOKUP[kind] ?? FAIL_SAFE_RETENTION;
}
