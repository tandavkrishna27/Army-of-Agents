/**
 * DAT-005 D4 — the NET-NEW worker-daemon in-place secret-redaction scrubber.
 *
 * The frozen `wire-safety.ts` canary registry is LOCATE-ONLY
 * (`findSecretCanaryStringMatches` returns paths; it never rewrites). This scrubber
 * is the rewrite half: it deep-copies an event, replacing every occurrence of a
 * per-run secret canary in EVERY string leaf with a fixed marker, so a known secret
 * value can never survive into a persisted/dispatched event.
 *
 * It is run in `EventSequencer.#emit` BEFORE the `eventDigest` is computed, so the
 * digest + `workerEventV1Schema.parse()` cover the SCRUBBED bytes and the WRK-006
 * durable outbox (which seals verbatim + never re-digests) can only ever hold the
 * marker.
 *
 * Per-run scoping: the canaries are passed in explicitly (never read from the
 * module singleton) so one run's secrets cannot bleed into another run's events.
 *
 * Built on the frozen `visitWireStrings`/`findSecretCanaryStringMatches` traversal
 * for the presence short-circuit. Runtime imports: `@armyofagents/worker-protocol`
 * only — the E4-D01 boundary (no server/db, no Node beyond standard globals).
 */

import { findSecretCanaryStringMatches } from "@armyofagents/worker-protocol";

/** The fixed replacement marker (« redacted » guillemets — outside any secret's
 * alphabet, and short enough to fit every bounded event string field). */
export const REDACTION_MARKER = "«redacted»";

/** Replace every occurrence of each canary substring in `value` with the marker.
 * Substring replacement (`split`/`join`) — never a regex — so a canary containing
 * regex metacharacters is matched literally. */
export function redactString(value: string, canaries: readonly string[]): string {
  let out = value;
  for (const canary of canaries) {
    if (canary.length === 0) continue;
    if (out.includes(canary)) out = out.split(canary).join(REDACTION_MARKER);
  }
  return out;
}

/** Recursively rebuild a plain-object/array/scalar structure, scrubbing every
 * string leaf. Mirrors the frozen `visitWireStrings` traversal (objects, arrays,
 * strings; scalars pass through). */
function redactValue(value: unknown, canaries: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, canaries);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, canaries));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = redactValue((value as Record<string, unknown>)[key], canaries);
    }
    return out;
  }
  return value; // number | boolean | null | undefined
}

/**
 * Return a deep copy of `event` with every registered canary substring replaced by
 * {@link REDACTION_MARKER} in EVERY string field (structured fields, the free-text
 * `network_denied.reason`, and the terminal `errorMessage` alike). When no canary is
 * supplied — or none is present anywhere in the event — the original reference is
 * returned unchanged (no needless clone).
 */
export function scrubEventStrings<T>(event: T, canaries: Iterable<string>): T {
  const needles = [...canaries].filter((c) => typeof c === "string" && c.length > 0);
  if (needles.length === 0) return event;
  // Presence short-circuit via the frozen locate-only scanner (visitWireStrings).
  if (findSecretCanaryStringMatches(event, needles).length === 0) return event;
  return redactValue(event, needles) as T;
}
