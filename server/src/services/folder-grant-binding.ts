// server/src/services/folder-grant-binding.ts
//
// DSK-002 Lane A (I1/I3) — bind a resolved folder grant to the DEVICE presenting it.
//
// WHAT WAS MISSING. `folder-grant.ts` `resolve()` filters on `folderGrantId` +
// `revokedAt IS NULL` within the org's RLS scope. It SELECTs `executionTargetId`,
// `deviceGeneration` and `ownerUserId`, returns all three, and compares none of them.
// An organization's RLS scope is not a device scope: two desktops in one org both pass
// it. So a grant issued for desktop A was usable by desktop B, survived the re-enrolment
// of the device it was issued for, and survived its owner losing membership.
//
// The precedent for the correct behaviour was already in the tree —
// `execution-target-resolver.ts:137` fails closed on the identical mismatch:
//
//     if (profile.deviceGeneration !== row.deviceGeneration) return null;
//
// Folder grants simply did not follow it. This module makes them.
//
// D1 — WHAT THIS IS NOT. This is a DECLARATION CHECK. It validates the identity a device
// CLAIMS against the grant on record, and it is the right place for that. It is NOT the
// symlink/containment defence: `entry.kind` and every field here are device-supplied, so
// a compromised daemon can lie to all of it. Containment is `lstat` on the device
// (`worker-daemon/src/snapshot/build-manifest.ts` `assertRepresentable` +
// `assertCaptureRoot`). Both layers are required; neither substitutes for the other, and
// a test of one must never be cited as evidence for the other.
//
// PURE by construction — no DB, no fs, no clock. The service composes it: resolve (DB) →
// bind (here) → admit paths (`folder-grant-path.ts`). That split is the Lane D lesson:
// the security artifact is a named, exhaustively tested function; the caller is delivery.

/**
 * Every reason a binding can be refused. Declared as an array with the union DERIVED from
 * it (the Lane B `SECRET_RESOLVE_REJECTION_REASONS` shape), so the vocabulary cannot drift
 * from the type and a test can enumerate it.
 */
export const GRANT_BINDING_REJECTIONS = [
  "grant_absent",
  "wrong_target",
  "stale_device_generation",
  "wrong_owner",
] as const;

export type GrantBindingRejection = (typeof GRANT_BINDING_REJECTIONS)[number];

/** The fields of a resolved grant that participate in binding. */
export interface BindableGrant {
  readonly folderGrantId: string;
  readonly ownerUserId: string;
  readonly executionTargetId: string;
  readonly deviceGeneration: number;
  readonly declaredBasePath: string;
}

/** The identity a device presents alongside a capture. Device-supplied — see D1. */
export interface PresentedDeviceIdentity {
  readonly ownerUserId: string;
  readonly executionTargetId: string;
  readonly deviceGeneration: number;
}

export type GrantBindingResult =
  | { readonly bound: true }
  | { readonly bound: false; readonly reason: GrantBindingRejection };

/**
 * Bind a resolved grant to the presenting device, or refuse with a named reason.
 *
 * Every field is checked with `&&`-style sequencing rather than a single combined
 * predicate, so each mismatch reports WHICH fact failed — an operator debugging a refused
 * capture needs "your device was re-enrolled" and not "denied".
 *
 * Generation is compared with `!==`, deliberately, NOT `<`. A grant belongs to exactly the
 * generation it was issued for: a device presenting an OLDER generation is replaying a
 * superseded enrolment, and a NEWER one has been re-enrolled since the grant was given.
 * Both are refusals, and an `only reject if newer` implementation would admit the replay.
 */
export function bindGrantToDevice(
  grant: BindableGrant | null,
  presented: PresentedDeviceIdentity,
): GrantBindingResult {
  if (!grant) return { bound: false, reason: "grant_absent" };
  if (grant.executionTargetId !== presented.executionTargetId) {
    return { bound: false, reason: "wrong_target" };
  }
  if (grant.deviceGeneration !== presented.deviceGeneration) {
    return { bound: false, reason: "stale_device_generation" };
  }
  if (grant.ownerUserId !== presented.ownerUserId) {
    return { bound: false, reason: "wrong_owner" };
  }
  return { bound: true };
}
