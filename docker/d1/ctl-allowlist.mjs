// -----------------------------------------------------------------------------
// DEP-002 fake-provider control-endpoint peer allowlist — PURE decision helpers
// (no I/O, no heavy deps) shared by docker/d1/fake-provider-entry.mjs and its unit
// test. Kept separate from the entry script so the decision logic is unit-testable
// on any platform (the entry script itself pulls @armyofagents/sandbox-fake-provider
// and is deferred-to-CI / never run locally on Windows).
//
// FAIL-CLOSED posture (FIX B): the control endpoint (/script, /reset, /invocations)
// must NEVER be open by accident. An empty/unset AOA_FAKE_PROVIDER_CTL_ALLOW DENIES
// all control-endpoint requests (403). Opening the endpoint requires the EXPLICIT
// sentinel `AOA_FAKE_PROVIDER_CTL_ALLOW='*'`. Otherwise only peers whose docker-DNS
// IP is in the resolved allowlist are admitted; every other peer gets 403.
// -----------------------------------------------------------------------------

export const CTL_ALLOW_OPEN_SENTINEL = "*";

/**
 * Parse the raw AOA_FAKE_PROVIDER_CTL_ALLOW value into a decision spec.
 * @param {string | undefined | null} raw
 * @returns {{ open: boolean, peers: string[] }}
 *   `open` is true only when the explicit '*' sentinel is present.
 *   `peers` is the sentinel-free list of allowlisted peer hostnames.
 */
export function parseCtlAllow(raw) {
  const tokens = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return {
    open: tokens.includes(CTL_ALLOW_OPEN_SENTINEL),
    peers: tokens.filter((s) => s !== CTL_ALLOW_OPEN_SENTINEL),
  };
}

/**
 * Decide whether a peer may use the control endpoint. FAIL-CLOSED.
 * @param {{ open: boolean, peers: string[] }} spec  result of parseCtlAllow()
 * @param {Set<string>} allowedIps  peer IPs resolved from `spec.peers` (docker DNS)
 * @param {string} peerIp  the normalized remote IP of the requesting socket
 * @returns {boolean} true => admit; false => the caller returns 403
 */
export function isCtlPeerAllowed(spec, allowedIps, peerIp) {
  if (!spec || spec.open !== true) {
    // No explicit '*' sentinel.
    if (!spec || spec.peers.length === 0) return false; // fail-closed: empty => deny all
    return allowedIps instanceof Set && allowedIps.has(peerIp);
  }
  return true; // explicit '*' sentinel => intentionally open
}
