/**
 * installer-admission.mjs — fail-closed desktop-installer admission (DSK-003 Lane D, D4).
 *
 * WHY THIS IS NOT BLOCKED ON A CERTIFICATE. REL-004 owns signing and attestation of
 * "every enabled desktop installer/updater artifact". DEP-001 already established the
 * shape here: `image-admission.mjs` is a pure `node:crypto` verifier signed with a TEST
 * cosign key, and its own ticket text says REL-004 later replaces test roots with release
 * roots. This is the same construction for a different artifact, so packaging/
 * signature-tamper is provable in CI today and the release-root swap touches no logic.
 *
 * REUSES ONLY WHAT IS ACTUALLY GENERIC. `verifyDetachedSignature`, `normalizeTrustRoot`
 * and `DIGEST_RE` come from the image verifier — the crypto and the digest shape are the
 * same problem, and a second copy would be a second thing to drift.
 *
 * `normalizeAllowlist` is deliberately NOT reused, and the first draft of this file did
 * reuse it — by name, without reading it. It REQUIRES a `sourceRevision` on every entry
 * and returns only `{image, digest, sourceRevision}`, so an installer entry's `version`
 * and `platform` were both rejected and, had they passed, silently dropped. It is an
 * image-shaped helper wearing a generic name. The installer needs its own, below.
 *
 * The other genuine difference is the CANONICAL PAYLOAD: an image binds
 * `{digest, sourceRevision}`; an installer must bind `{digest, version, platform}`.
 *
 * WHY THE PLATFORM IS IN THE PAYLOAD. Without it, a validly signed macOS installer's
 * signature would verify against a Windows allowlist entry carrying the same digest —
 * and more importantly, a signature made for one platform's artifact could be replayed
 * onto another's release channel. Binding all three means a signature authorizes exactly
 * one artifact for exactly one platform at exactly one version.
 *
 * FAIL-CLOSED BY CONSTRUCTION: `admitted: true` is produced at exactly one point, the
 * final line, after every check has passed. Every other path — malformed input, missing
 * allowlist or trust root, a non-allowlisted digest, a version/platform mismatch, a
 * missing or empty signature, a signature that does not verify, or any throw while
 * verifying — returns `{ admitted: false, reason }`. It never throws for caller data.
 *
 * Dependencies: Node built-ins, via the image verifier.
 */

import {
  DIGEST_RE,
  normalizeTrustRoot,
  verifyDetachedSignature,
} from "./image-admission.mjs";

export { DIGEST_RE };

/** The platforms an installer may be admitted for. */
export const INSTALLER_PLATFORMS = ["darwin", "win32"];

/**
 * The canonical payload a signature covers. Binds digest + version + platform together,
 * so a signature cannot be replayed onto a different artifact, version, or OS.
 *
 * Hand-serialized in a fixed key order rather than via `JSON.stringify` on an object,
 * because object key order is an implementation detail and this string IS the contract.
 */
export function canonicalInstallerPayload({ digest, version, platform }) {
  return (
    `{"critical":{"installer":{"artifact-digest":${JSON.stringify(String(digest))},` +
    `"platform":${JSON.stringify(String(platform))},` +
    `"version":${JSON.stringify(String(version))}},` +
    `"type":"aoa desktop installer signature"}}`
  );
}

/**
 * Validate the released-artifact allowlist and PRESERVE the installer fields.
 *
 * Every entry must carry a well-formed digest, a non-empty version, and a supported
 * platform. One bad entry rejects the WHOLE list rather than being skipped: a malformed
 * allowlist means the release record is not trustworthy, and quietly ignoring the bad row
 * would admit everything else on a list nobody can vouch for.
 */
export function normalizeInstallerAllowlist(allowlist) {
  let raw;
  if (Array.isArray(allowlist)) raw = allowlist;
  else if (allowlist && typeof allowlist === "object" && Array.isArray(allowlist.entries)) {
    raw = allowlist.entries;
  } else return null;

  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (typeof entry.digest !== "string" || !DIGEST_RE.test(entry.digest)) return null;
    if (typeof entry.version !== "string" || entry.version.length === 0) return null;
    if (typeof entry.platform !== "string" || !INSTALLER_PLATFORMS.includes(entry.platform)) {
      return null;
    }
    out.push({ digest: entry.digest, version: entry.version, platform: entry.platform });
  }
  return out;
}

/**
 * Decide whether a desktop installer artifact may be installed.
 *
 * @param {{digest?:string, version?:string, platform?:string, signature?:string,
 *          allowlist?:unknown, trustRoot?:unknown}} input
 * @returns {{admitted:true}|{admitted:false, reason:string}}
 */
export function evaluateInstallerAdmission(input) {
  const source = input && typeof input === "object" ? input : {};
  const digest = typeof source.digest === "string" ? source.digest : "";
  const version = typeof source.version === "string" ? source.version : "";
  const platform = typeof source.platform === "string" ? source.platform : "";

  if (!DIGEST_RE.test(digest)) return { admitted: false, reason: "malformed_digest" };
  if (version.length === 0) return { admitted: false, reason: "missing_version" };
  if (!INSTALLER_PLATFORMS.includes(platform)) {
    return { admitted: false, reason: "unsupported_platform" };
  }

  const trustRootPem = normalizeTrustRoot(source.trustRoot);
  if (trustRootPem === null) return { admitted: false, reason: "missing_trust_root" };

  const allowlist = normalizeInstallerAllowlist(source.allowlist);
  if (allowlist === null) return { admitted: false, reason: "missing_allowlist" };

  // The allowlist is the record of what was RELEASED. A signature alone is not enough:
  // a validly signed build that was never promoted must not install.
  const entry = allowlist.find((row) => row && row.digest === digest);
  if (!entry) return { admitted: false, reason: "digest_not_allowlisted" };
  if (String(entry.version ?? "") !== version) {
    return { admitted: false, reason: "version_mismatch" };
  }
  if (String(entry.platform ?? "") !== platform) {
    return { admitted: false, reason: "platform_mismatch" };
  }

  const signature = typeof source.signature === "string" ? source.signature : "";
  if (signature.length === 0) return { admitted: false, reason: "missing_signature" };

  const payload = canonicalInstallerPayload({ digest, version, platform });
  if (!verifyDetachedSignature(payload, signature, trustRootPem)) {
    return { admitted: false, reason: "signature_invalid" };
  }

  return { admitted: true };
}
