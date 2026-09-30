#!/bin/sh
set -eu

# worker-daemon-entrypoint.sh
#
# Container entrypoint for the separately deployable @armyofagents/worker-daemon
# (WRK-001 scaffolds this; DEP-001 builds the distinct signed worker image that
# invokes it). The worker is a NETWORK CLIENT of the control plane and a frozen
# consumer of @armyofagents/worker-protocol: it holds NO database credential,
# mounts no Express route, and runs no migration. Tenant commands execute inside
# the provider sandbox, never in this process.
#
# All configuration arrives through AOA_WORKER_* environment variables consumed
# by `loadWorkerConfig` (strict parse; the process exits non-zero before opening
# any socket on an invalid config). A DATABASE_URL, if present, is deliberately
# IGNORED — the worker never reads one.

# Health/metrics bind loopback only (enforced again in code); never expose them.
: "${AOA_WORKER_HEALTH_HOST:=127.0.0.1}"
export AOA_WORKER_HEALTH_HOST

# Resolve the daemon entrypoint: prefer the packaged bin, fall back to the built
# module path inside the image.
WORKER_DAEMON_ENTRY="${WORKER_DAEMON_ENTRY:-/app/packages/worker-daemon/dist/bin/worker-daemon.js}"

if [ ! -f "$WORKER_DAEMON_ENTRY" ]; then
    echo "ERROR: worker daemon entrypoint not found at $WORKER_DAEMON_ENTRY" >&2
    exit 1
fi

# exec so the daemon is PID 1 and receives SIGINT/SIGTERM directly (its
# one-shot graceful shutdown handler stops the health server and exits).
exec node "$WORKER_DAEMON_ENTRY" "$@"
