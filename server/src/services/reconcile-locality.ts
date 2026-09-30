// server/src/services/reconcile-locality.ts
//
// DAT-006 — the PURE locality decision. Locality is DECIDED, never stored (design §2): a
// reconcile reads the FROZEN `PLACEMENT_MATRIX` × the attempt's committed placement to
// decide whether a desktop/dedicated result may be transferred to a destination (e.g. the
// shared object store) or must stay device/org-local. `owner_device_only` output against a
// shared / differently-owned target is denied; `transfer_allowed` promotes.
//
// It is a pure function over the frozen matrix — fully unit/vectors-testable, no DB, no fs.

import {
  PLACEMENT_MATRIX,
  TARGET_CLASSES,
  DATA_LOCALITIES,
  type TargetClass,
  type DataLocality,
  type TargetScope,
} from "@armyofagents/worker-protocol";

/** Where a reconciled output would land. The shared artifact/quarantine object store is
 * `scope:"platform"`, `sameOwner:false`, `sameOrganization:false`. A same-owner desktop is
 * `scope:"owner"`, `sameOwner:true`. */
export interface TransferDestination {
  scope: TargetScope;
  sameOwner: boolean;
  sameOrganization: boolean;
}

export type LocalityDecisionReason =
  | "transfer_allowed"
  | "same_owner_device"
  | "same_organization_target"
  | "owner_device_only_denied"
  | "organization_target_only_denied"
  | "incoherent_placement"
  | "unknown_target_class";

export interface LocalityDecision {
  allowed: boolean;
  reason: LocalityDecisionReason;
}

const TARGET_CLASS_SET: ReadonlySet<string> = new Set(TARGET_CLASSES);
const DATA_LOCALITY_SET: ReadonlySet<string> = new Set(DATA_LOCALITIES);

/**
 * Decide whether an attempt's committed-placement output may transfer to `destination`.
 * Fails closed: an unknown target class, or a data locality that is not a member of the
 * placement row for that class (an incoherent placement), denies.
 *   * `transfer_allowed`         → allow (may go anywhere, incl. the shared store).
 *   * `owner_device_only`        → allow ONLY to the SAME owner device; a shared /
 *                                  differently-owned destination denies.
 *   * `organization_target_only` → allow ONLY to a same-organization non-platform target;
 *                                  a shared platform / cross-org destination denies.
 */
export function decideOutputTransfer(input: {
  placementTargetClass: string;
  dataLocality: string;
  destination: TransferDestination;
}): LocalityDecision {
  if (!TARGET_CLASS_SET.has(input.placementTargetClass)) {
    return { allowed: false, reason: "unknown_target_class" };
  }
  const targetClass = input.placementTargetClass as TargetClass;
  const row = PLACEMENT_MATRIX[targetClass];
  if (!DATA_LOCALITY_SET.has(input.dataLocality) || !row.localities.includes(input.dataLocality as DataLocality)) {
    // A locality outside the frozen matrix row for this class is an incoherent placement.
    return { allowed: false, reason: "incoherent_placement" };
  }
  const locality = input.dataLocality as DataLocality;
  const dest = input.destination;
  if (locality === "transfer_allowed") return { allowed: true, reason: "transfer_allowed" };
  if (locality === "owner_device_only") {
    return dest.scope === "owner" && dest.sameOwner
      ? { allowed: true, reason: "same_owner_device" }
      : { allowed: false, reason: "owner_device_only_denied" };
  }
  // organization_target_only
  return dest.sameOrganization && dest.scope !== "platform"
    ? { allowed: true, reason: "same_organization_target" }
    : { allowed: false, reason: "organization_target_only_denied" };
}

/** The shared artifact/quarantine object store destination (platform, not owner-bound). */
export const SHARED_STORE_DESTINATION: TransferDestination = Object.freeze({
  scope: "platform",
  sameOwner: false,
  sameOrganization: false,
});

/** Convenience: decide transfer of an attempt's output to the SHARED object store (the
 * canonical reconcile destination). `owner_device_only` and `organization_target_only`
 * both deny; only `transfer_allowed` promotes. */
export function decideSharedStoreTransfer(placementTargetClass: string, dataLocality: string): LocalityDecision {
  return decideOutputTransfer({ placementTargetClass, dataLocality, destination: SHARED_STORE_DESTINATION });
}
