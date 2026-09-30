#!/bin/sh
# DEP-001 worker entrypoint — minimal, non-root, read-only-root safe.
#
# The worker daemon runs as a fixed non-root user (node/uid 1000) so the root
# filesystem can be mounted read-only. The ONLY writable location is the /worker
# volume (device key store in mounted_secret mode, TMPDIR, logs). No usermod /
# gosu / chown at runtime. The daemon dispatches no work until provisioned +
# supervised (E4-D12); this entrypoint only prepares writable state and execs it.
set -eu

export HOME="${HOME:-/worker}"
export TMPDIR="${TMPDIR:-$HOME/tmp}"

mkdir -p "$HOME" "$TMPDIR"

exec "$@"
