/**
 * image-admission.mjs — pure, fail-closed image-admission logic (DEP-001).
 *
 * The security core of the separate-signed-images supply chain. Given a
 * candidate image digest plus its detached signature, source provenance, the
 * signed-digest allowlist, and the TEST trust root, `evaluateAdmission` decides
 * whether the image may run. It admits ONLY a digest that is:
 *   1. well-formed (`sha256:<64 lowercase hex>`),
 *   2. present on the allowlist,
 *   3. carrying provenance whose `sourceRevision` matches the allowlisted
 *      recorded revision,
 *   4. accompanied by a non-empty signature that
 *   5. verifies — over the canonical simple-signing payload that binds the
 *      digest AND the revision — against the trust root's public key.
 *
 * FAIL-CLOSED by construction: `admitted:true` is produced at exactly ONE point,
 * the final line, and only after every check has passed. Every other path —
 * malformed input, missing/garbage allowlist or trust root, a non-allowlisted
 * digest, missing/mismatched provenance, a missing/empty signature, a signature
 * that does not verify, OR any thrown error while verifying — returns
 * `{admitted:false, reason}`. The function never throws for caller-supplied data.
 *
 * This mirrors cosign key-based signing: a detached ECDSA-P256-over-SHA256
 * signature of a canonical "simple signing" JSON payload, verifiable with only
 * `node:crypto` (no cosign binary, no Docker, no network). `docker/images/
 * sign.sh` produces the real signatures with a TEST cosign key; this verifier is
 * what D1 (DEP-002) consults to accept only recorded signed digests.
 *
 * Dependencies: Node built-ins only (`node:crypto`, `node:buffer`).
 */

import { verify as cryptoVerify } from "node:crypto";
import { Buffer } from "node:buffer";

/** A well-formed OCI image content digest: sha256 + 64 lowercase hex chars. */
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** A recorded source revision (a git SHA): 7–64 lowercase hex chars. */
const REVISION_RE = /^[0-9a-f]{7,64}$/;

function reject(reason) {
  return { admitted: false, reason };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The canonical bytes that are signed and verified. Built as a fixed-key-order
 * string (not `JSON.stringify` of an object literal, whose key order is an
 * implementation detail) so signer and verifier are byte-identical across Node
 * versions. Binds BOTH the manifest digest and the source revision, so tampering
 * with either invalidates the signature.
 *
 * @param {{digest: string, sourceRevision: string}} args
 * @returns {string}
 */
export function canonicalSigningPayload({ digest, sourceRevision }) {
  return (
    `{"critical":{"image":{"docker-manifest-digest":${JSON.stringify(String(digest))}},` +
    `"type":"cosign container image signature"},` +
    `"optional":{"sourceRevision":${JSON.stringify(String(sourceRevision))}}}`
  );
}

/**
 * Normalize a trust root to a PEM public-key string, or null if unusable.
 * Accepts `{publicKey: pem}`, `{publicKeyPem: pem}`, or a bare PEM string.
 * @returns {string|null}
 */
export function normalizeTrustRoot(trustRoot) {
  let pem;
  if (typeof trustRoot === "string") pem = trustRoot;
  else if (isPlainObject(trustRoot)) pem = trustRoot.publicKey ?? trustRoot.publicKeyPem;
  if (typeof pem !== "string") return null;
  if (!pem.includes("BEGIN PUBLIC KEY") && !pem.includes("BEGIN EC PUBLIC KEY")) return null;
  return pem;
}

/**
 * Normalize an allowlist to an array of `{image, digest, sourceRevision}`
 * entries, or null if the shape is invalid. Accepts `{entries: [...]}` or a bare
 * array. Only entries with a well-formed digest + revision are retained;
 * anything else makes the whole allowlist invalid (fail-closed — we never
 * silently drop a malformed entry and admit the rest).
 * @returns {Array<{image?:string, digest:string, sourceRevision:string}>|null}
 */
export function normalizeAllowlist(allowlist) {
  let raw;
  if (Array.isArray(allowlist)) raw = allowlist;
  else if (isPlainObject(allowlist) && Array.isArray(allowlist.entries)) raw = allowlist.entries;
  else return null;
  const out = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) return null;
    if (typeof entry.digest !== "string" || !DIGEST_RE.test(entry.digest)) return null;
    if (typeof entry.sourceRevision !== "string" || !REVISION_RE.test(entry.sourceRevision)) {
      return null;
    }
    out.push({ image: entry.image, digest: entry.digest, sourceRevision: entry.sourceRevision });
  }
  return out;
}

/**
 * Verify a detached base64 ECDSA-P256/SHA256 signature over `payloadStr` against
 * a PEM public key. Returns a boolean; NEVER throws (a malformed key/signature
 * is a `false`, i.e. fail-closed).
 * @returns {boolean}
 */
export function verifyDetachedSignature(payloadStr, signatureB64, publicKeyPem) {
  try {
    const signature = Buffer.from(String(signatureB64), "base64");
    if (signature.length === 0) return false;
    return cryptoVerify(
      "sha256",
      Buffer.from(String(payloadStr), "utf8"),
      publicKeyPem,
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Decide whether an image digest may be admitted. Pure + fail-closed.
 *
 * @param {{
 *   digest?: unknown,
 *   signature?: unknown,
 *   provenance?: unknown,
 *   allowlist?: unknown,
 *   trustRoot?: unknown,
 * }} input
 * @returns {{admitted: boolean, reason: string}}
 */
export function evaluateAdmission(input) {
  // 0. Structural validation — anything not shaped like a request is rejected.
  if (!isPlainObject(input)) return reject("malformed admission request");
  const { digest, signature, provenance, allowlist, trustRoot } = input;

  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
    return reject(`malformed or missing image digest: ${JSON.stringify(digest)}`);
  }

  const trustRootPem = normalizeTrustRoot(trustRoot);
  if (!trustRootPem) return reject("missing or malformed trust root");

  const entries = normalizeAllowlist(allowlist);
  if (!entries) return reject("missing or malformed allowlist");

  // 1. Allowlist membership — admit ONLY recorded digests.
  const entry = entries.find((e) => e.digest === digest);
  if (!entry) return reject(`digest not on allowlist: ${digest}`);

  // 2. Provenance presence + match against the recorded revision.
  if (!isPlainObject(provenance) || typeof provenance.sourceRevision !== "string") {
    return reject("missing source provenance");
  }
  if (!REVISION_RE.test(provenance.sourceRevision)) {
    return reject("malformed source provenance");
  }
  if (provenance.sourceRevision !== entry.sourceRevision) {
    return reject(
      `provenance mismatch: signed-for ${entry.sourceRevision}, presented ${provenance.sourceRevision}`,
    );
  }

  // 3. Signature must be present (an unsigned image is never admitted).
  if (typeof signature !== "string" || signature.length === 0) {
    return reject("unsigned digest (no signature presented)");
  }

  // 4. Signature must verify over the canonical payload binding digest+revision.
  const payload = canonicalSigningPayload({ digest, sourceRevision: provenance.sourceRevision });
  if (!verifyDetachedSignature(payload, signature, trustRootPem)) {
    return reject("signature verification failed against trust root");
  }

  // 5. ALL checks passed — the sole admit point.
  return { admitted: true, reason: `admitted ${entry.image ?? "image"} ${digest}` };
}
