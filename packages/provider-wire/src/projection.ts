// -----------------------------------------------------------------------------
// provider-wire — the redacted LIST projection (DEP-012 Slice 1 · Unit B2).
//
// `inspect` crosses as the authoritative `RedactedResourceProjection` (worker-daemon).
// `list` crosses as this thin envelope: the redacted rows + the server's `providerOpId`.
//
// ★ `nextPageToken` is ALWAYS null for B2's narrow own-resource list (review skeptic F1).
// The provider does not push the ownership selector into pagination, so its real cursor
// walks the GLOBAL resource set and would be a FOREIGN sandbox id — a cross-tenant
// enumeration oracle. The server mirrors `CleanupAuthority.list` (a single scoped page, no
// cursor); the field stays for port-shape completeness. Complete coarse-scope enumeration
// (a real cursor) is the deferred reconcile / v:2 case.
//
// Each row is the redacted projection ONLY (hashed labels, state, generation) — no raw
// labels, no env/secrets/command. The driver re-synthesizes `hasLiveLease` from `state`.
// -----------------------------------------------------------------------------

import type { RedactedResourceProjection } from "@armyofagents/worker-daemon";

export interface RedactedListResult {
  readonly providerOpId: string;
  readonly resources: readonly RedactedResourceProjection[];
  readonly nextPageToken: string | null;
}
