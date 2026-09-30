/**
 * artifact-retention-authority.ts — DAT-010. Retention is decided by the CONTROL PLANE.
 *
 * ★ THE DEFECT THIS CLOSES. `browser-artifact-retention.ts:5-14` states the rule and gives
 * the reason:
 *
 *   retention is "control-plane-owned, and never caller- or worker-supplied" … "A caller or
 *   worker choosing the retention of a `browser_cookie_state` or `browser_storage_state`
 *   artifact is a privilege the threat model must not grant — those artifacts carry live
 *   session credentials."
 *
 * And `artifact-commit.ts` granted exactly that privilege: it stored `manifest.retention`,
 * the worker's own declaration, while `browserArtifactRetention()` — the total, fail-safe,
 * already-tested function written to own this decision — had ZERO production callers.
 *
 * ★ WHY OVERRIDE RATHER THAN REJECT. The security property comes from IGNORING the declared
 * value, so refusing a disagreeing manifest would add a failure mode for no additional
 * security — on the commit path, which is where real work is lost. A disagreement is still
 * information (a buggy worker, or an attempted downgrade), so it is REPORTED, not swallowed.
 *
 * ★ THE FAIL-SAFE DIRECTION IS THE POINT. `browserArtifactRetention` is total over the
 * closed frozen `ARTIFACT_KINDS` enum and answers `ephemeral` — the SHORTEST class — for
 * anything unrecognised. An unknown or hostile kind therefore gets the shortest life, never
 * the longest, which is precisely why deriving is safer than trusting.
 *
 * This does NOT enforce retention. Nothing reads the stored column to act. This makes the
 * value TRUSTWORTHY, not EFFECTIVE — see the enforcement follow-up, which must not start
 * before this, or it would enforce the worker's choice.
 */

import type { ArtifactRetentionClass } from "@armyofagents/worker-protocol";

import { browserArtifactRetention } from "./browser-artifact-retention.js";

export interface StoredRetentionDecision {
  /** The class the control plane decided. This is what gets persisted. */
  readonly retention: ArtifactRetentionClass;
  /**
   * True when the manifest's declaration differed from the derived class (or was absent).
   *
   * Deliberately NOT named `downgradeAttempt`: a worker declaring a SHORTER class than
   * derived is not an attack, but it is the same bug class — the worker computed something
   * the control plane did not. Both are worth seeing, and naming it for the hostile case
   * only would teach readers to ignore the benign one.
   */
  readonly declarationIgnored: boolean;
}

export function resolveStoredRetention(input: {
  kind: string;
  declared: string | undefined;
}): StoredRetentionDecision {
  const retention = browserArtifactRetention(input.kind);
  // An ABSENT declaration counts as a disagreement, not a match. The frozen manifest schema
  // requires the field, so absence means something upstream is already wrong and must not
  // read as agreement.
  return { retention, declarationIgnored: input.declared !== retention };
}
