#!/usr/bin/env bash
# docker/images/sign.sh — sign each DEP-001 image digest with the TEST root and
# record it on the signed-digest allowlist.
#
# For each built image (docker/images/digests.env) this:
#   1. ensures a TEST signing keypair exists (docker/images/trust-root.key +
#      trust-root.pub.pem) — a deterministic openssl EC P-256 key;
#   2. computes the canonical simple-signing payload binding {digest, revision}
#      via scripts/lib/image-admission.mjs (the SAME bytes the verifier checks);
#   3. produces a detached ECDSA-P256/SHA256 signature (base64);
#   4. appends/updates the {image, digest, sourceRevision, signature} entry in
#      docker/images/allowlist.json.
#
# The resulting signature is exactly what scripts/lib/image-admission.mjs
# verifies with node:crypto — no cosign binary is needed at ADMISSION time.
#
# LINUX/CI-ONLY for a full run (needs the built digests). TEST ROOT ONLY —
# never release trust; REL-004 owns release signing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

IMAGES_DIR="${REPO_ROOT}/docker/images"
KEY="${IMAGES_DIR}/trust-root.key"
PUB="${IMAGES_DIR}/trust-root.pub.pem"
ALLOWLIST="${IMAGES_DIR}/allowlist.json"
DIGESTS="${IMAGES_DIR}/digests.env"

[ -f "${DIGESTS}" ] || { echo "ERROR: ${DIGESTS} missing — run build.sh first" >&2; exit 1; }
# shellcheck disable=SC1090
source "${DIGESTS}"

# 1. TEST keypair — a deterministic openssl EC P-256 (prime256v1) keypair. This
# is the ONLY producer that round-trips with the node:crypto admission verifier
# (`scripts/lib/image-admission.mjs`, 22/22): `openssl dgst -sha256 -sign` emits a
# DER ECDSA-P256/SHA256 signature that `crypto.verify("sha256", …)` accepts, and
# `openssl ec -pubout` writes an SPKI `BEGIN PUBLIC KEY` PEM that the verifier's
# trust-root normalizer accepts.
#
# We deliberately do NOT branch on cosign here. `cosign generate-key-pair` emits
# an ENCRYPTED sigstore private key (its own PEM envelope) that `openssl dgst
# -sha256 -sign "${KEY}"` below cannot consume — under `set -euo pipefail` that
# aborts signing before any allowlist entry is recorded (fail-closed, but images
# then silently never sign). No cosign binary is needed at sign OR admission time.
if [ ! -f "${KEY}" ] || [ ! -f "${PUB}" ]; then
  echo ">> generating TEST signing keypair (openssl EC P-256)"
  openssl ecparam -name prime256v1 -genkey -noout -out "${KEY}"
  openssl ec -in "${KEY}" -pubout -out "${PUB}"
fi

sign_one() {
  local name="$1" digest="$2" revision="$3"
  echo ">> signing ${name} ${digest} @ ${revision}"

  local payload_file sig_file
  payload_file="$(mktemp)"
  sig_file="$(mktemp)"

  # Canonical simple-signing payload — SAME function the verifier reconstructs.
  node -e '
    import("./scripts/lib/image-admission.mjs").then((m) => {
      process.stdout.write(m.canonicalSigningPayload({ digest: process.argv[1], sourceRevision: process.argv[2] }));
    });
  ' "${digest}" "${revision}" > "${payload_file}"

  # Detached ECDSA-P256/SHA256 signature (base64). openssl DER output matches
  # node:crypto.verify("sha256", payload, pub, der).
  openssl dgst -sha256 -sign "${KEY}" -out "${sig_file}" "${payload_file}"
  local signature
  signature="$(base64 -w0 < "${sig_file}" 2>/dev/null || base64 < "${sig_file}" | tr -d '\n')"

  # Attach provenance next to the signature for auditing.
  AOA_IMAGE_REVISION="${revision}" "${IMAGES_DIR}/provenance.sh" "${name}" \
    > "${IMAGES_DIR}/provenance.${name}.json"

  # Append/update the allowlist entry (idempotent by digest).
  node -e '
    const fs = require("fs");
    const [file, image, digest, sourceRevision, signature] = process.argv.slice(1);
    const a = JSON.parse(fs.readFileSync(file, "utf8"));
    a.entries = (a.entries || []).filter((e) => e.digest !== digest);
    a.entries.push({ image, digest, sourceRevision, signature });
    fs.writeFileSync(file, JSON.stringify(a, null, 2) + "\n");
  ' "${ALLOWLIST}" "${name}" "${digest}" "${revision}" "${signature}"

  rm -f "${payload_file}" "${sig_file}"
}

sign_one "control-plane" "${CONTROL_PLANE_DIGEST}" "${CONTROL_PLANE_REVISION}"
sign_one "worker" "${WORKER_DIGEST}" "${WORKER_REVISION}"

echo ">> allowlist updated: ${ALLOWLIST}"
echo ">> verify with: node scripts/verify-image-admission.mjs --digest <sha256:...> --signature <b64> --source-revision <sha>"
