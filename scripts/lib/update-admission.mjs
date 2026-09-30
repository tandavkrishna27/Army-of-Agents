/**
 * update-admission.mjs — fail-closed desktop UPDATE admission (DSK-004 Lane A, D5/D6).
 *
 * Extends `installer-admission.mjs`'s construction rather than repeating it: a detached
 * signature over a canonical payload, verified with `node:crypto` against a TEST trust
 * root that REL-004 swaps for release roots. The crypto primitives are imported from
 * `image-admission.mjs` — the same place the installer verifier takes them from — because
 * those are genuinely one problem, while the digest SHAPE comes from the installer
 * verifier because an update and an installer describe the same kind of artifact.
 *
 * WHAT DIFFERS IS THE PAYLOAD. An installer signature authorizes a BUILD; an update
 * signature authorizes a TRANSITION. Binding `fromVersion` as well as `toVersion` is what
 * stops a signature for 0.1.0→0.1.1 being replayed to authorize 0.1.0→0.9.9 — and, just
 * as importantly, stops one being used to push a device BACKWARD onto a version whose bugs
 * are known. The payload string also differs in its `type`, so an installer signature can
 * never double as an update signature: installing a build fresh and transitioning onto it
 * from a specific version are different authorizations.
 *
 * REVOCATION IS SEPARATE FROM SIGNING (D6). A build found broken after it was signed must
 * stop installing without anyone re-keying anything, so revocation is a deny-list consulted
 * at admission. It is deliberately NOT JOB-007's target revocation: those answer different
 * questions — "may this build run" versus "may this device work" — and conflating them
 * would mean revoking a bad build required revoking every device running it.
 *
 * AN ABSENT DENY-LIST IS A REFUSAL, not an empty one. A caller that could not fetch the
 * list has not proven the build is allowed, and treating "unknown" as "not revoked" is
 * exactly how a withdrawn build installs during an outage of whatever serves it.
 *
 * FAIL-CLOSED: `admitted: true` is produced at one point, the final line.
 *
 * Dependencies: Node built-ins, via the installer verifier.
 */

// The crypto primitives come from `image-admission.mjs`, the same place
// `installer-admission.mjs` takes them from — not chained through it. Routing them via the
// installer verifier would make that module a pass-through and hide where they actually
// live, which is the opposite of what importing them is meant to make clear.
import { normalizeTrustRoot, verifyDetachedSignature } from "./image-admission.mjs";
import { DIGEST_RE } from "./installer-admission.mjs";

/** Platforms an update may target. Mirrors `INSTALLER_PLATFORMS`. */
export const UPDATE_PLATFORMS = ["darwin", "win32"];

/**
 * The canonical payload an update signature covers.
 *
 * Hand-serialized in a fixed key order — object key order is an implementation detail and
 * this string IS the contract, the same reasoning as the installer payload.
 */
export function canonicalUpdatePayload({ digest, fromVersion, toVersion, platform }) {
  return (
    `{"critical":{"update":{"artifact-digest":${JSON.stringify(String(digest))},` +
    `"from-version":${JSON.stringify(String(fromVersion))},` +
    `"platform":${JSON.stringify(String(platform))},` +
    `"to-version":${JSON.stringify(String(toVersion))}},` +
    `"type":"aoa desktop update signature"}}`
  );
}

export const UPDATE_ADMISSION_REJECTIONS = [
  "malformed_digest",
  "missing_version",
  "unsupported_platform",
  "no_op_transition",
  "missing_revocation_list",
  "version_revoked",
  "missing_trust_root",
  "missing_signature",
  "signature_invalid",
];

/**
 * Decide whether a desktop update may be applied.
 *
 * @param {{digest?:string, fromVersion?:string, toVersion?:string, platform?:string,
 *          signature?:string, trustRoot?:unknown, revokedVersions?:unknown}} input
 * @returns {{admitted:true}|{admitted:false, reason:string}}
 */
export function evaluateUpdateAdmission(input) {
  const source = input && typeof input === "object" ? input : {};
  const digest = typeof source.digest === "string" ? source.digest : "";
  const fromVersion = typeof source.fromVersion === "string" ? source.fromVersion : "";
  const toVersion = typeof source.toVersion === "string" ? source.toVersion : "";
  const platform = typeof source.platform === "string" ? source.platform : "";

  if (!DIGEST_RE.test(digest)) return { admitted: false, reason: "malformed_digest" };
  if (fromVersion.length === 0 || toVersion.length === 0) {
    return { admitted: false, reason: "missing_version" };
  }
  if (!UPDATE_PLATFORMS.includes(platform)) {
    return { admitted: false, reason: "unsupported_platform" };
  }
  // from == to is not an update. Admitting it would let one signature be replayed
  // indefinitely against a device already on that version.
  if (fromVersion === toVersion) return { admitted: false, reason: "no_op_transition" };

  // REVOCATION BEFORE SIGNATURE, deliberately. A revoked build is refused whether or not
  // its signature checks out, and the refusal names revocation: an operator chasing
  // `signature_invalid` on a build that was simply withdrawn would be looking in entirely
  // the wrong place.
  if (!Array.isArray(source.revokedVersions)) {
    return { admitted: false, reason: "missing_revocation_list" };
  }
  if (source.revokedVersions.map(String).includes(toVersion)) {
    return { admitted: false, reason: "version_revoked" };
  }

  const trustRootPem = normalizeTrustRoot(source.trustRoot);
  if (trustRootPem === null) return { admitted: false, reason: "missing_trust_root" };

  const signature = typeof source.signature === "string" ? source.signature : "";
  if (signature.length === 0) return { admitted: false, reason: "missing_signature" };

  const payload = canonicalUpdatePayload({ digest, fromVersion, toVersion, platform });
  if (!verifyDetachedSignature(payload, signature, trustRootPem)) {
    return { admitted: false, reason: "signature_invalid" };
  }

  return { admitted: true };
}
