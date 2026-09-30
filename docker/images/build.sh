#!/usr/bin/env bash
# docker/images/build.sh — reproducibly build BOTH DEP-001 split images from the
# recorded source revision.
#
# Builds docker/control-plane/Dockerfile and docker/worker/Dockerfile with buildx,
# pinning org.opencontainers.image.revision to the recorded source SHA and
# emitting each image's content digest to docker/images/digests.env for sbom.sh /
# sign.sh to consume.
#
# LINUX/CI-ONLY: requires a Docker/buildx daemon. This host has no Docker and CI
# is billing-blocked, so this runs in CI, not locally. Additive + default-off:
# the combined ./Dockerfile and docker.yml are untouched.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

REVISION="${AOA_IMAGE_REVISION:-$(git rev-parse HEAD)}"
REGISTRY="${AOA_IMAGE_REGISTRY:-localhost/aoa}"
PLATFORMS="${AOA_IMAGE_PLATFORMS:-linux/amd64}"
OUT_DIGESTS="${REPO_ROOT}/docker/images/digests.env"

# Reproducibility knobs: pin SOURCE_DATE_EPOCH so timestamps are deterministic.
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git show -s --format=%ct HEAD)}"

: > "${OUT_DIGESTS}"

build_one() {
  local name="$1" dockerfile="$2"
  local tag="${REGISTRY}/${name}:${REVISION}"
  echo ">> building ${name} from ${dockerfile} @ ${REVISION}"
  docker buildx build \
    --file "${dockerfile}" \
    --target production \
    --platform "${PLATFORMS}" \
    --build-arg "AOA_IMAGE_REVISION=${REVISION}" \
    --label "org.opencontainers.image.revision=${REVISION}" \
    --provenance=true \
    --sbom=true \
    --metadata-file "docker/images/${name}.metadata.json" \
    --tag "${tag}" \
    --load \
    "${REPO_ROOT}"

  # Record the resulting content digest for the supply-chain steps.
  local digest
  digest="$(docker inspect --format '{{index .RepoDigests 0}}' "${tag}" 2>/dev/null \
    | sed 's/.*@//' || true)"
  if [ -z "${digest}" ]; then
    digest="$(docker inspect --format '{{.Id}}' "${tag}")"
  fi
  echo "${name^^}_IMAGE=${tag}" >> "${OUT_DIGESTS}"
  echo "${name^^}_DIGEST=${digest}" >> "${OUT_DIGESTS}"
  echo "${name^^}_REVISION=${REVISION}" >> "${OUT_DIGESTS}"
}

build_one "control-plane" "docker/control-plane/Dockerfile"
build_one "worker" "docker/worker/Dockerfile"

echo ">> digests recorded to ${OUT_DIGESTS}:"
cat "${OUT_DIGESTS}"
