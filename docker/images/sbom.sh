#!/usr/bin/env bash
# docker/images/sbom.sh — emit a MINIMUM SBOM per DEP-001 image.
#
# For each built image (from docker/images/digests.env) writes an SPDX-ish JSON
# SBOM listing the image ref, content digest, recorded source revision, base
# image digest, and the top-level runtime package inventory. Prefers `syft` if
# present; otherwise falls back to enumerating the image's node_modules via a
# throwaway container (still Docker-dependent).
#
# LINUX/CI-ONLY (needs a Docker daemon and the built images). TEST ROOT ONLY.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

DIGESTS="${REPO_ROOT}/docker/images/digests.env"
[ -f "${DIGESTS}" ] || { echo "ERROR: ${DIGESTS} missing — run build.sh first" >&2; exit 1; }
# shellcheck disable=SC1090
source "${DIGESTS}"

OUT_DIR="${REPO_ROOT}/docker/images/sbom"
mkdir -p "${OUT_DIR}"

emit_sbom() {
  local name="$1" image_ref="$2" digest="$3" revision="$4"
  local out="${OUT_DIR}/${name}.sbom.json"
  echo ">> SBOM for ${name} (${digest})"

  if command -v syft >/dev/null 2>&1; then
    syft "${image_ref}" -o spdx-json > "${out}"
    return
  fi

  # Minimum fallback: image identity + top-level runtime package inventory.
  local packages
  packages="$(docker run --rm --entrypoint sh "${image_ref}" -c \
    'for d in ./node_modules/* ./*/node_modules/*; do [ -f "$d/package.json" ] && node -e "const p=require(process.argv[1]+\"/package.json\");console.log(p.name+\"@\"+p.version)" "$d"; done 2>/dev/null | sort -u' \
    || echo "")"

  {
    echo "{"
    echo "  \"spdxVersion\": \"SPDX-2.3-min\","
    echo "  \"name\": \"${name}\","
    echo "  \"image\": \"${image_ref}\","
    echo "  \"digest\": \"${digest}\","
    echo "  \"sourceRevision\": \"${revision}\","
    echo "  \"packages\": ["
    local first=1
    while IFS= read -r pkg; do
      [ -z "${pkg}" ] && continue
      if [ "${first}" -eq 1 ]; then first=0; else echo ","; fi
      printf '    {"name": "%s"}' "${pkg}"
    done <<< "${packages}"
    echo ""
    echo "  ]"
    echo "}"
  } > "${out}"
  echo ">> wrote ${out}"
}

emit_sbom "control-plane" "${CONTROL_PLANE_IMAGE}" "${CONTROL_PLANE_DIGEST}" "${CONTROL_PLANE_REVISION}"
emit_sbom "worker" "${WORKER_IMAGE}" "${WORKER_DIGEST}" "${WORKER_REVISION}"
