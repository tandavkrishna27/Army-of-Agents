// server/src/services/canary-mint-authority.ts
//
// CLI-007 (E7-F001) — the canary's out-of-band Company ownership authority for the
// DAT-008 execution-secret mint.
//
// A canary run is a Company-authority run BY CONSTRUCTION: its placement credential
// binding names no credential — `credentialId`/`credentialKind`/`pinnedTargetId` are all
// null (`canary-credential-binding.ts`; E11-F004 set the fourth field,
// `executionTargetSlug`, to a routing-only well-known constant). With all three
// credential-shaped fields null, target routing takes neither the pin nor the
// personal_subscription branch: it takes the E11-F004 slug arm, which resolves ONLY a
// `dedicated_worker` (normalizing as `organization_dedicated`) or null — never
// `owner_desktop`, and never a `personal_subscription` credential. So the ownership CLASS a
// canary rides is the invariant `"company_api_key"` (the Company model-provider key,
// Decision #104), never a personal subscription.
//
// The problem E7-F001 filed: the mint's owner-authority gate
// (`execution-secret-handle-mint.ts` `ownerAuthoritiesAgree`) refuses when the job's
// `credentialKind` (Authority B) is null, and the binding presents exactly that null
// credential kind. The FIX must NOT enrich the binding — the binding is the sole credential input
// to the placement REPLAY digest and to target routing, and a rotating or
// owner-routing value there breaks one or the other. Instead the Company ownership
// authority is:
//   1. ESTABLISHED in the MIG-008 preflight (`canary-preflight.ts`), which already
//      verifies the Company holds provider-control authority
//      (`currentKeyGeneration !== null`) and emits `CANARY_CREDENTIAL_AUTHORITY` only
//      on its `ok` result; a refusal emits none (fail-closed by shape), and
//   2. THREADED to the mint out of band (`run-execution-owner.ts` step 4 →
//      `PlaceJobAttemptInput.mintCredentialAuthority` → this module's
//      `mintCredentialKindFor` at the mint call), where it is consumed AFTER the digest
//      is computed and the replay early-return has fired — so it can never touch the
//      digest or routing.
//
// This module is deliberately PURE (no db, no drizzle), so the seam is directly unit-
// and mutation-testable.

import type { JobPlacementCredentialBinding } from "./job-placement.js";

/**
 * The ownership class a canary rides at the mint: the Company model-provider key
 * (Decision #104). A single literal on purpose — a canary is NEVER an
 * `owner_desktop`/`personal_subscription` run — so widening this type is a design
 * change, not a config.
 */
export const CANARY_CREDENTIAL_AUTHORITY = "company_api_key" as const;

/**
 * Choose the `credentialKind` the DAT-008 mint sees (Authority B).
 *
 * The out-of-band `mintCredentialAuthority` (the canary path) OVERRIDES the binding's
 * own `credentialKind`; every other run supplies no authority and the mint sees exactly
 * what the binding resolved — byte-identical to pre-CLI-007 behaviour. `null` is treated
 * as "no authority supplied" (the `??` semantics): a null out-of-band value never masks
 * the binding, and a null result correctly fails the mint's owner-authority gate closed.
 *
 * This selection is Authority B ONLY. It is independent of Authority A
 * (`decision.owner`), so the mint's `ownerAuthoritiesAgree` cross-check stays meaningful:
 * the canary now presents a real, preflight-verified Company authority, and a genuine
 * disagreement (a desktop owner against a company credential, or a null on either side)
 * still refuses.
 */
export function mintCredentialKindFor(
  mintCredentialAuthority: JobPlacementCredentialBinding["credentialKind"] | undefined,
  bindingCredentialKind: JobPlacementCredentialBinding["credentialKind"],
): JobPlacementCredentialBinding["credentialKind"] {
  return mintCredentialAuthority ?? bindingCredentialKind;
}
