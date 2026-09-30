// server/src/routes/adapter-manager-control-auth.ts
//
// DEP-012 Slice 4+5 (P3) — the drizzle-free peer-auth for the control-plane READ-ONLY
// lease-truth route (the AM↔CP shared-secret BEARER, the THIRD gate arm on top of the
// B1 double-gate). Kept in its OWN module — NO `@armyofagents/db` import — so the
// fail-closed decision is unit-testable without the drizzle ESM require-cycle.
//
// ★ [Img-2] FAIL-CLOSED CORRECTLY. The check is "configured secret UNSET ⇒ reject", NOT
// `header === env`: a naive equality falls OPEN when both are `undefined` (the route
// enabled via AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED=1 but the operator forgot the
// secret), re-opening the exact B1-F1 unauthenticated-oracle. So an unset/empty
// configured secret is a REJECT, and a set secret is compared in constant time.
//
// The const values MUST stay byte-identical to the adapter-manager's
// TRUTH_SHARED_SECRET_ENV / TRUTH_SHARED_SECRET_HEADER (reaper-truth-client.ts) — they
// cross the AM↔CP + compose boundary. Peer-auth for the E7-1 first proof on a controlled
// staging network; real client-cert mTLS on both hops is a FILED hard production
// follow-up (control-net is flat, so a privileged compromised worker could still MITM the
// cleartext bearer — staging uses DISPOSABLE provider keys until mTLS lands).

import { createHash, timingSafeEqual } from "node:crypto";

/** The AM↔CP shared-secret env, read via `process.env[CONST]` (a computed access, NOT a
 * `process.env.AOA_…` literal). MUST equal the adapter-manager's const value. */
export const TRUTH_SHARED_SECRET_ENV = "AOA_ADAPTER_MANAGER_TRUTH_SHARED_SECRET";

/** The HTTP header the AM presents the bearer on (lower-case; Node normalizes header
 * names). MUST equal the adapter-manager's const value. */
export const TRUTH_SHARED_SECRET_HEADER = "x-aoa-adapter-manager-truth";

/**
 * Constant-time bearer comparison over FIXED-LENGTH SHA-256 hashes of both sides.
 * `timingSafeEqual` THROWS on unequal-length buffers, so hashing first is BOTH constant-
 * time AND removes the length-leak oracle a raw compare of the secrets would carry. A
 * missing/empty presented header hashes `""`, which never equals a non-empty configured
 * secret's hash.
 */
export function bearerMatches(configured: string, presented: string | undefined): boolean {
  const a = createHash("sha256").update(configured).digest();
  const b = createHash("sha256").update(presented ?? "").digest();
  return timingSafeEqual(a, b);
}

/**
 * The bearer gate arm. Fail-closed: an UNSET/empty configured secret ⇒ `false` (reject) —
 * never a fall-open equality of two `undefined`s. Otherwise a constant-time match of the
 * presented header against the configured secret.
 */
export function truthBearerAccepted(
  env: Record<string, string | undefined>,
  presented: string | undefined,
): boolean {
  const configured = env[TRUTH_SHARED_SECRET_ENV]?.trim();
  if (!configured) return false;
  return bearerMatches(configured, presented);
}
