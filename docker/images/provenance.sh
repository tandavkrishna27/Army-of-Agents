#!/usr/bin/env bash
# docker/images/provenance.sh — record source provenance for a DEP-001 image.
#
# Emits the source-revision provenance a signed image binds to. The recorded
# revision is `git rev-parse HEAD` (override with AOA_IMAGE_REVISION) and MUST
# equal the image's org.opencontainers.image.revision label. build.sh injects it
# as a build-arg; sign.sh signs a payload that binds digest + this revision; the
# admission verifier re-checks the binding.
#
# Usage: docker/images/provenance.sh <image-name> > provenance.<image>.json
#
# TEST ROOT ONLY. No network. Pure git + shell.
set -euo pipefail

image_name="${1:?usage: provenance.sh <control-plane|worker>}"
revision="${AOA_IMAGE_REVISION:-$(git rev-parse HEAD)}"
source_url="$(git config --get remote.origin.url 2>/dev/null || echo 'unknown')"
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat <<JSON
{
  "image": "${image_name}",
  "sourceRevision": "${revision}",
  "sourceUrl": "${source_url}",
  "builtAt": "${built_at}",
  "builder": "docker/images/build.sh",
  "trustRoot": "test"
}
JSON
