#!/bin/sh
# DEP-001 control-plane entrypoint — minimal, non-root, read-only-root safe.
#
# Unlike the combined image's entrypoint, this does NO runtime usermod/groupmod,
# gosu, or chown: the image runs as a fixed non-root user (node/uid 1000) so the
# root filesystem can be mounted read-only. The ONLY writable location is the
# /aoa volume; every state directory lives under it. App startup runs NO database
# migrations (DEP-003 owns the privileged migration job).
set -eu

export AOA_HOME="${AOA_HOME:-/aoa}"
export AOA_INSTANCE_ID="${AOA_INSTANCE_ID:-default}"
export AOA_CONFIG="${AOA_CONFIG:-$AOA_HOME/instances/$AOA_INSTANCE_ID/config.json}"
export HOME="${HOME:-$AOA_HOME}"
export TMPDIR="${TMPDIR:-$AOA_HOME/tmp}"

# All writable state stays under the /aoa volume (root fs is read-only).
AOA_INSTANCE_DIR="$(dirname "$AOA_CONFIG")"
mkdir -p \
  "$AOA_HOME" \
  "$TMPDIR" \
  "$AOA_INSTANCE_DIR" \
  "$AOA_INSTANCE_DIR/data" \
  "$AOA_INSTANCE_DIR/data/storage" \
  "$AOA_INSTANCE_DIR/logs"

exec "$@"
