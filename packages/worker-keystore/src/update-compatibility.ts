// packages/worker-keystore/src/update-compatibility.ts
//
// DSK-004 Lane B (D3/D4) — is this build one the server will still talk to?
//
// COMPATIBILITY IS NEGOTIATION, NOT COMPARISON (D3). It is whether the candidate's protocol
// range still intersects what the control plane requires. Comparing build numbers would be
// a second, weaker notion of compatibility beside the one the protocol already defines, and
// the two would drift — so this performs the same intersection the lease matcher does.
// Refusing the N-1 case (`{1,1}` against `{1,2}`) would make every rollback impossible,
// which is the opposite of what DSK-004 exists to enable.
//
// A MANIFEST'S CLAIM IS NOT EVIDENCE (D4). An update manifest may carry the compatibility
// its publisher believed at signing time; `declaredCompatible` is accepted as an input and
// deliberately IGNORED. What matters is the intersection with the server this device is
// actually talking to, evaluated at install: a build compatible when signed may not be by
// the time it installs, and the manifest cannot know that. Symmetrically, a stale claim
// must not veto a build that genuinely negotiates, or devices strand on an old version.
//
// VALIDATION IS THIS MODULE'S JOB. `negotiateProtocolVersion` documents that callers must
// have already validated positive integers with `min <= max` — the Zod schemas do that on
// the wire, but an update manifest read from disk has passed through no schema, and handing
// an inverted range to the negotiator would return a number for an impossible peer.
//
// WHY IT LIVES HERE AND NOT IN `scripts/`. The first draft was a `scripts/lib` module, and
// could not resolve `@armyofagents/worker-protocol` — `scripts/` is not a workspace package,
// which is exactly why every other module there is Node-built-ins-only. Reimplementing the
// negotiation to fit that constraint would have been the duplication D3 argues against.
// This package already depends on the protocol, so the real function is importable.

import { negotiateProtocolVersion } from "@armyofagents/worker-protocol";

export const UPDATE_COMPATIBILITY_REJECTIONS = ["malformed_range", "no_protocol_overlap"] as const;
export type UpdateCompatibilityRejection = (typeof UPDATE_COMPATIBILITY_REJECTIONS)[number];

export interface ProtocolRangeInput {
  readonly min: number;
  readonly max: number;
}

export interface UpdateCompatibilityInput {
  readonly candidateProtocol?: unknown;
  readonly serverProtocol?: unknown;
  /** The publisher's belief at signing time. Accepted, and deliberately ignored. */
  readonly declaredCompatible?: boolean;
}

export type UpdateCompatibilityResult =
  | { readonly compatible: true; readonly negotiated: number }
  | { readonly compatible: false; readonly reason: UpdateCompatibilityRejection };

/** A usable inclusive range: positive integers with `min <= max`. */
function isUsableRange(range: unknown): range is ProtocolRangeInput {
  if (!range || typeof range !== "object" || Array.isArray(range)) return false;
  const { min, max } = range as { min?: unknown; max?: unknown };
  if (!Number.isInteger(min) || !Number.isInteger(max)) return false;
  if ((min as number) < 1 || (max as number) < 1) return false;
  return (min as number) <= (max as number);
}

/** Decide whether a candidate build may be installed, protocol-wise. */
export function evaluateUpdateCompatibility(
  input: UpdateCompatibilityInput | null | undefined,
): UpdateCompatibilityResult {
  const source = input && typeof input === "object" ? input : {};
  const candidate = (source as UpdateCompatibilityInput).candidateProtocol;
  const serverRange = (source as UpdateCompatibilityInput).serverProtocol;

  if (!isUsableRange(candidate) || !isUsableRange(serverRange)) {
    return { compatible: false, reason: "malformed_range" };
  }

  // `declaredCompatible` is never consulted — see the header.
  //
  // The argument ORDER here is documentation, not semantics: `negotiateProtocolVersion`
  // computes `min(a.max, b.max)` against `max(a.min, b.min)`, which is commutative, so a
  // mutation swapping the two survives and correctly so. The names are still written the
  // way the frozen signature reads (`controlPlane, worker`) because a reader should not
  // have to rediscover that symmetry to be sure the call is right.
  const negotiated = negotiateProtocolVersion(serverRange, candidate);
  if (negotiated === null) return { compatible: false, reason: "no_protocol_overlap" };
  return { compatible: true, negotiated };
}
