// server/src/services/canary-credential-binding.ts
//
// CLI-006 (Task 1) — the credential binding a canary attempt presents to placement.
//
// DECISION: this resolver asserts NOTHING about which provider credential the run
// uses at PLACEMENT. It returns the same constant for every Organization, Company,
// job and source kind. That is not a placeholder and not a degraded fallback — the
// binding is the sole credential input to the placement REPLAY digest and to target
// ROUTING, and it must stay a stable, routing-neutral constant for the reasons below.
//
// E11-F004 (canary org-routing, this PR) changed ONE field: `executionTargetSlug` is
// now a stable well-known constant (`CANARY_EXECUTION_TARGET_SLUG`) instead of null.
// The three credential-shaped fields (`credentialId`, `credentialKind`, `pinnedTargetId`)
// stay null. The slug ROUTES the canary to a tenant-creatable `organization_dedicated`
// (`dedicated_worker`) target an operator CAN create + ratify — whereas a four-null
// binding fell through to a `pooled_gvisor`/`managed_cloud`/`platform` target NO operator
// create+ratify sequence can produce (the E11-F004 blocker), so a keyed run went to the
// legacy executor via `placement_not_leasable`. The slug does NOT name a credential, does
// NOT re-open owner routing, and does NOT rotate — see "WHY THE SLUG IS SAFE" below.
//
//   1. THE CREDENTIAL IS DELIVERED OUT OF BAND, NOT THROUGH THE BINDING (CLI-007,
//      E7-F001). A canary now DOES mint a Company `provider_key` handle: the Company
//      ownership authority the mint needs ("company_api_key") is established by the
//      MIG-008 preflight and threaded to the DAT-008 mint via
//      `PlaceJobAttemptInput.mintCredentialAuthority` (see canary-mint-authority.ts),
//      AFTER the digest is computed and the replay early-return has fired. So the
//      binding never has to name a credential: naming one here would change the digest
//      and re-open routing, and the mint authority reaches the mint another way.
//      (Historic note: before CLI-007 the null-credential binding's `credentialKind: null`
//      tripped the mint's owner-authority gate → owner_authority_disagreement → no
//      handle; that WAS E7-F001, and it is what CLI-007 fixed without touching the
//      credential fields.)
//   2. THE CREDENTIAL INPUTS DO NOT EXIST YET AT THIS SEAM. The only functions that can
//      authorize a credential (`resolveProviderCredential`, `resolveAgentSubscriptionEnvironment`)
//      need `provider`, `adapterType`, `agentId`, `executionTargetId`, `currentEnv`
//      and a `SecretConsumerContext`. At this seam none of them is in scope: the
//      heartbeat computes `resolvedEnv` at heartbeat.ts:3378 and `hbProviderId` at
//      heartbeat.ts:3430 — 140+ and 190+ lines AFTER the convert/place seam at
//      heartbeat.ts:3231-3258 that reaches this resolver.
//   3. PLACEMENT CANNOT CHECK A CREDENTIAL CLAIM. `credentialOwnerId` is read off
//      the ROUTED TARGET's profile (job-placement.ts:279-281), and
//      `requiredOwnerPrincipalId` off the SAME profile (job-placement.ts:289), so
//      the owner comparison in `candidateFits` (job-placement.ts:557-563) is
//      tautological. A richer credential binding would be accepted without ever being verified.
//
// WHY THE SLUG IS SAFE — the DE-29 owner-misrouting class stays STRUCTURALLY excluded:
// the three credential-shaped fields are all null, so target routing
// (`chooseExecutionTargetRow`) takes neither the pin branch (`pinnedTargetId` null) nor
// the personal_subscription branch (`credentialKind` null). It takes the E11-F004 slug
// arm, which is `active.find(t => t.kind === "dedicated_worker" && t.slug === slug) ?? null`
// (execution-target-resolver.ts). A `dedicated_worker` row can ONLY normalize as
// `organization_dedicated` (TARGET_KIND_BY_CLASS maps `owner_desktop` to
// {desktop, local_host} only), and a missing slug resolves to `null`, never a fall-through
// to another class. There is therefore NO reachable path from this binding to an
// `owner_desktop` target — the DE-29 class is structurally excluded, not merely checked.
// (The owner comparison in `candidateFits` remains tautological, which is exactly why the
// exclusion has to be structural: routing, not a predicate, is what keeps the canary off
// an owner target.)
//
// WHY THE SLUG IS SAFE FOR REPLAY: the binding is hashed into
// `placementInputDigest`/`placementPolicyDigest` (job-placement.ts:315 → :333-335), and a
// digest that changes between the first placement and a retry throws
// `placement_already_decided` (job-placement-transaction.ts:219-221) → `transfer_error` →
// permanent legacy fallback for that run. A STABLE constant slug is byte-identical on every
// attempt of every run, so replay holds. Do NOT make the slug (or any field) carry a
// rotating value (a key generation, a freshly-read credential row): that would break replay.
//
// DO NOT "enrich" the credential fields without re-deriving that argument. Adding a
// non-null `pinnedTargetId` or `credentialKind: "personal_subscription"` re-opens owner
// routing; adding any rotating value breaks placement replay. The canary's Company mint
// authority does NOT belong here for that reason — it rides the out-of-band
// `mintCredentialAuthority` channel (CLI-007), established by the preflight, which already
// owns credential-generation freshness (canary-preflight.ts). Even a routing-neutral
// constant such as `"company_api_key"` belongs there, not here: on the binding it would
// change the digest value and make the mint's owner-authority cross-check assert Company
// authority WITHOUT the preflight having verified it.
//
// FOLLOW-UP (filed, not built — E11-F008): a single global slug forces EVERY canary org to
// name its `dedicated_worker` target identically. A per-org slug (or a per-org binding
// resolver) is the natural next step so multiple orgs can canary concurrently; it is out of
// scope for the E7-1 first-proof unblock.

import type { JobPlacementCredentialBinding } from "./job-placement.js";

/**
 * The well-known slug the canary names as its execution target. Every canary org must
 * create + ratify its `dedicated_worker` execution target with EXACTLY this slug (see
 * docs/replatform/RUNBOOK-e7-1-keyed-run.md §7). A single global module constant on
 * purpose: the binding takes no inputs and reads no config/db (see below), so the slug
 * cannot be per-org today. Widening to a per-org slug is E11-F008 (filed, not built).
 */
export const CANARY_EXECUTION_TARGET_SLUG = "aoa-canary-e2b" as const;

/**
 * The canary binding: three null credential fields + one well-known routing slug.
 *
 * All four keys are written out (the slug is non-null, the other three explicitly null).
 * The binding is canonicalized by key set (canonical-json.ts serializes `Object.keys`), so
 * an omitted key is a DIFFERENT digest, not an equivalent one. Freezing the object keeps
 * both the key set AND the slug value stable for every attempt this composition ever places.
 */
export const CANARY_CREDENTIAL_BINDING: Readonly<JobPlacementCredentialBinding> = Object.freeze({
  credentialId: null,
  credentialKind: null,
  executionTargetSlug: CANARY_EXECUTION_TARGET_SLUG,
  pinnedTargetId: null,
});

/**
 * `resolveCredentialBinding` for the production composition root.
 *
 * Deliberately ignores its inputs. It takes no `db` handle and performs no read,
 * so it has no failure mode to degrade from — the constant IS the contract, never
 * a fallback that masks a failed lookup. The slug is a compile-time module constant,
 * not a config or env read, so this property is unchanged by E11-F004.
 */
export function resolveCanaryCredentialBinding(): JobPlacementCredentialBinding {
  return { ...CANARY_CREDENTIAL_BINDING };
}
