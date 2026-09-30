#!/bin/sh
# DEP-012 adapter-manager entrypoint — minimal, non-root, read-only-root safe.
#
# Like the control-plane entrypoint, this does NO runtime usermod/groupmod, gosu,
# or chown: the image runs as a fixed non-root user (node/uid 1000) so the root
# filesystem can be mounted read-only. The ONLY writable location is the /am
# volume; the durable idempotency ledger + TMPDIR live under it.
set -eu

export HOME="${HOME:-/am}"
export TMPDIR="${TMPDIR:-/am/tmp}"
export AOA_ADAPTER_MANAGER_IDEMPOTENCY_LEDGER_DIR="${AOA_ADAPTER_MANAGER_IDEMPOTENCY_LEDGER_DIR:-/am/ledger}"

# All writable state stays under the /am volume (root fs is read-only). Recreated
# here so a fresh tmpfs-backed /am volume is usable before the bin's ledger write.
mkdir -p \
  "$HOME" \
  "$TMPDIR" \
  "$AOA_ADAPTER_MANAGER_IDEMPOTENCY_LEDGER_DIR"

exec "$@"
