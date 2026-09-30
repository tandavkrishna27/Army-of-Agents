// scripts/lib/release-manifest.mjs
//
// REL-004 Lane A — the release manifest, and the gate that CALLS the three admission
// verifiers (clause 1: an unapproved digest cannot run).
//
// WHY THIS EXISTS, PLAINLY. `evaluateAdmission` (DEP-001), `evaluateInstallerAdmission`
// (DSK-003) and `evaluateUpdateAdmission` (DSK-004) are pure, fail-closed and
// mutation-tested — and until this module, none of them had a caller anywhere outside its
// own unit suite. `docker/d1/.env.example` documents images as "verified ... at bring-up"
// and `d1-merge-train.yml` delegates live admission to "the split-image admission verifier
// (DEP-001), not by this lane"; the verifier they point at was invoked by nothing. The
// acceptance clause was vacuously true: nothing could be refused because nothing was
// checked.
//
// So this module is mostly DISPATCH, and that is the point. The one genuinely new decision
// is the manifest itself, which answers a question no per-artifact verifier can: not "is
// this digest signed and allowlisted" but "are these the five artifacts of candidate X, and
// are they ALL here". A promotion that silently omitted the sandbox image passes every
// pre-existing check.
//
// Pure and fail-closed, like everything it composes. The CLI wrapper
// (`scripts/check-release-admission.mjs`) does the file reading.

import { createRequire } from "node:module";

import {
  canonicalSigningPayload,
  evaluateAdmission,
  normalizeTrustRoot,
  verifyDetachedSignature,
} from "./image-admission.mjs";
import { evaluateInstallerAdmission } from "./installer-admission.mjs";
import { evaluateUpdateAdmission } from "./update-admission.mjs";

// Referenced so a bundler/linter cannot conclude the import is unused; the real use is the
// verifier table below. (Kept explicit rather than clever — see ARTIFACT_VERIFIERS.)
void createRequire;
void canonicalSigningPayload;

/** The five artifact classes a release consists of. Order is part of the signed payload. */
export const RELEASE_ARTIFACT_CLASSES = Object.freeze([
  "control_plane",
  "worker",
  "sandbox",
  "desktop_installer",
  "desktop_updater",
]);

/** Which verifier each class is checked by. */
export const RELEASE_ARTIFACT_KINDS = Object.freeze({
  control_plane: "image",
  worker: "image",
  sandbox: "image",
  desktop_installer: "installer",
  desktop_updater: "update",
});

/**
 * The dispatch table. Every admission verifier in `scripts/lib` must appear here — a test
 * walks the directory and fails if one does not, which is the guard that stops this
 * ticket's finding from recurring.
 */
export const ARTIFACT_VERIFIERS = Object.freeze({
  image: evaluateAdmission,
  installer: evaluateInstallerAdmission,
  update: evaluateUpdateAdmission,
});

/**
 * Distinct from `cosign container image signature`, `aoa desktop installer signature` and
 * `aoa desktop update signature`. Without domain separation an installer signature would
 * authorize an entire release.
 */
export const RELEASE_MANIFEST_PAYLOAD_TYPE = "aoa release manifest signature";

const REVISION_RE = /^[0-9a-f]{7,64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_SCHEMA = 1;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reject(reason, extra = {}) {
  return { admitted: false, reason, ...extra };
}

/**
 * The canonical bytes signed and verified.
 *
 * Built as a fixed-key-order string over `RELEASE_ARTIFACT_CLASSES` — NOT `JSON.stringify`
 * of the manifest, whose artifact key order is an accident of however the file was written.
 * Signer and verifier must be byte-identical regardless of serialization.
 *
 * Binds the candidate AND every artifact digest, so tampering with any one of them
 * invalidates the whole release signature.
 */
export function canonicalReleaseManifestPayload(manifest) {
  const source = isPlainObject(manifest) ? manifest : {};
  const artifacts = isPlainObject(source.artifacts) ? source.artifacts : {};
  const parts = RELEASE_ARTIFACT_CLASSES.map((cls) => {
    const digest = isPlainObject(artifacts[cls]) ? artifacts[cls].digest : undefined;
    return `${JSON.stringify(cls)}:${JSON.stringify(String(digest ?? ""))}`;
  });
  return (
    `{"critical":{"candidate":${JSON.stringify(String(source.candidate ?? ""))},` +
    `"artifacts":{${parts.join(",")}}},` +
    `"type":${JSON.stringify(RELEASE_MANIFEST_PAYLOAD_TYPE)}}`
  );
}

/**
 * Structure, completeness, then signature.
 *
 * COMPLETENESS BEFORE SIGNATURE is deliberate. Both outcomes are refusals, so there is no
 * security difference — but "the sandbox artifact is missing" sends an operator to the
 * promotion pipeline, while `signature_invalid` sends them to the signing key. The more
 * specific refusal is the more useful one, and this ordering is the same principle
 * DSK-004 applied when it checked revocation before the signature.
 */
export function evaluateReleaseManifest(input) {
  if (!isPlainObject(input)) return reject("malformed_manifest");
  const { manifest, signature, trustRoot } = input;
  if (!isPlainObject(manifest)) return reject("malformed_manifest");
  if (manifest.schema !== MANIFEST_SCHEMA) return reject("malformed_manifest");

  const candidate = manifest.candidate;
  if (typeof candidate !== "string" || !REVISION_RE.test(candidate)) {
    return reject("malformed_candidate");
  }

  const artifacts = manifest.artifacts;
  if (!isPlainObject(artifacts)) return reject("malformed_manifest");

  for (const cls of RELEASE_ARTIFACT_CLASSES) {
    const entry = artifacts[cls];
    if (!isPlainObject(entry)) return reject("missing_artifact_class", { artifactClass: cls });
    if (typeof entry.digest !== "string" || !DIGEST_RE.test(entry.digest)) {
      return reject("malformed_artifact_digest", { artifactClass: cls });
    }
  }
  // Default-deny: an unrecognized class means the manifest and this gate disagree about
  // what a release contains, and "ignore the part I do not understand" is not a safe
  // reading of that disagreement.
  for (const cls of Object.keys(artifacts)) {
    if (!RELEASE_ARTIFACT_CLASSES.includes(cls)) {
      return reject("unknown_artifact_class", { artifactClass: cls });
    }
  }

  const trustRootPem = normalizeTrustRoot(trustRoot);
  if (trustRootPem === null) return reject("missing_trust_root");
  if (typeof signature !== "string" || signature.length === 0) {
    return reject("missing_signature");
  }
  if (!verifyDetachedSignature(canonicalReleaseManifestPayload(manifest), signature, trustRootPem)) {
    return reject("signature_invalid");
  }
  return { admitted: true };
}

/**
 * Assemble the per-verifier input for one artifact class.
 *
 * Each verifier has its own input shape; this is the only place that knows the mapping, so
 * a verifier's contract changing breaks one function rather than five call sites.
 */
function verifierInputFor(cls, entry, request) {
  const kind = RELEASE_ARTIFACT_KINDS[cls];
  const signature = isPlainObject(request.signatures) ? request.signatures[cls] : undefined;
  if (kind === "image") {
    return {
      digest: entry.digest,
      signature,
      provenance: { sourceRevision: entry.sourceRevision },
      allowlist: request.imageAllowlist,
      trustRoot: request.trustRoot,
    };
  }
  if (kind === "installer") {
    return {
      digest: entry.digest,
      version: entry.version,
      platform: entry.platform,
      signature,
      allowlist: request.installerAllowlist,
      trustRoot: request.trustRoot,
    };
  }
  return {
    digest: entry.digest,
    fromVersion: entry.fromVersion,
    toVersion: entry.toVersion,
    platform: entry.platform,
    signature,
    trustRoot: request.trustRoot,
    revokedVersions: request.revokedVersions,
  };
}

/**
 * The whole gate: the manifest verdict, then every artifact through its own verifier.
 *
 * A bad manifest short-circuits with NO artifact verdicts, rather than reporting a
 * half-checked release. Claiming per-artifact results for a document we have not
 * authenticated would invite a reader to trust the parts that "passed".
 */
export function evaluateReleaseAdmission(request) {
  if (!isPlainObject(request)) return { ...reject("malformed_manifest"), artifacts: [] };

  const manifestVerdict = evaluateReleaseManifest(request);
  if (!manifestVerdict.admitted) return { ...manifestVerdict, artifacts: [] };

  const artifacts = [];
  for (const cls of RELEASE_ARTIFACT_CLASSES) {
    const kind = RELEASE_ARTIFACT_KINDS[cls];
    const verify = ARTIFACT_VERIFIERS[kind];
    const entry = request.manifest.artifacts[cls];
    const verdict = verify(verifierInputFor(cls, entry, request));
    artifacts.push({
      artifactClass: cls,
      kind,
      // `=== true` rather than truthiness. Mutation testing records this as an EQUIVALENT
      // mutant today, because all three verifiers return a boolean `admitted` — so the
      // strictness is defensive, against a fourth verifier that returns something truthy
      // and non-boolean. Kept and labelled rather than removed or chased with a contrived
      // test, since ARTIFACT_VERIFIERS is frozen and not injectable.
      admitted: verdict.admitted === true,
      reason: verdict.admitted === true ? null : (verdict.reason ?? "refused"),
    });
  }

  const refused = artifacts.filter((a) => !a.admitted);
  if (refused.length > 0) return { admitted: false, reason: "artifact_refused", artifacts };
  return { admitted: true, artifacts };
}
