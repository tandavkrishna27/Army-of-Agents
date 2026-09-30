// REL-003 (E11) — rollback-completeness verifier (Lane C, pure).
//
// The DE-20 acceptance clause: "marker deletion alone is never accepted as
// rollback." A `distributed_cutover_markers` row is a GATE MARKER keyed by
// `candidate_sha` — deleting it removes the marker, but the 0188 tenant tables,
// org-referencing FKs, distributed data, and the MIG-002 rollout dial all remain
// (D5). A REAL rollback is a state transition: restore the pre-0188 snapshot, or
// `revert0188` for a single-org instance (it REFUSES otherwise, pointing to the
// snapshot), plus flipping the MIG-002 dial back to legacy.
//
// This pure verifier decides completeness over the ACTION SET taken. `state` is the
// observed post-action tenant-schema fact (the embedded-PG Lane C proves that a
// marker delete leaves it intact); it is carried as corroborating evidence, not a
// verdict input — the verdict is a function of the actions alone (design §7: all
// three Lane-C guards are over the action set). Fail-closed (D2): an empty/unknown
// action set is a refusal, never a default-accept.

/** The rollback actions an operator may take, in the vocabulary the verifier
 * reasons over. `snapshot_restored` and `revert0188_single_org` are the only REAL
 * reverts; `marker_deleted` and `dial_reverted_to_legacy` are not, on their own. */
export const ROLLBACK_ACTIONS = [
  "marker_deleted",
  "snapshot_restored",
  "revert0188_single_org",
  "dial_reverted_to_legacy",
] as const;
export type RollbackAction = (typeof ROLLBACK_ACTIONS)[number];

/** The action(s) that actually undo the 0188 cutover state. */
const REAL_REVERT_ACTIONS: ReadonlySet<RollbackAction> = new Set<RollbackAction>([
  "snapshot_restored",
  "revert0188_single_org",
]);

/** The observed post-action tenant-schema fact (corroborating evidence). */
export interface RollbackState {
  /** Whether the 0188 tenant tables (`organizations`, …) are still present after
   * the claimed rollback. A marker-only "rollback" leaves them present. */
  organizationsTablePresent: boolean;
}

export const ROLLBACK_REFUSAL_REASONS = [
  "empty_action_set",
  "marker_deletion_is_not_rollback",
  "incomplete_rollback_no_revert",
] as const;
export type RollbackRefusalReason = (typeof ROLLBACK_REFUSAL_REASONS)[number];

export interface RollbackCompleteness {
  verdict: "accepted" | "refused";
  /** The refusal reason, or `null` when accepted. */
  reason: RollbackRefusalReason | null;
  /** Echo of `state.organizationsTablePresent` — for a marker-only refusal this is
   * the evidence that the tenant schema was untouched by the marker delete. */
  tenantSchemaIntact: boolean;
}

/**
 * Decide whether the recorded rollback action set constitutes a complete rollback.
 * Each numbered guard is an independent, deletable line (mutation table §7).
 */
export function evaluateRollbackCompleteness(
  actions: readonly RollbackAction[],
  state: RollbackState,
): RollbackCompleteness {
  const tenantSchemaIntact = state.organizationsTablePresent;
  // C-G3 (fail-closed, D2): an empty action set is a refusal, never a default-accept.
  if (actions.length === 0) {
    return { verdict: "refused", reason: "empty_action_set", tenantSchemaIntact };
  }
  // C-G1 (DE-20 headline): marker deletion ALONE is never a rollback. The tenant
  // schema is untouched by a marker delete, which `tenantSchemaIntact` records.
  if (actions.every((a) => a === "marker_deleted")) {
    return { verdict: "refused", reason: "marker_deletion_is_not_rollback", tenantSchemaIntact };
  }
  // C-G2 (require a real revert): an accepted rollback must include a snapshot
  // restore or a single-org `revert0188`. A dial flip / marker delete without one
  // has not undone the cutover state.
  if (!actions.some((a) => REAL_REVERT_ACTIONS.has(a))) {
    return { verdict: "refused", reason: "incomplete_rollback_no_revert", tenantSchemaIntact };
  }
  return { verdict: "accepted", reason: null, tenantSchemaIntact };
}
