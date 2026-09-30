#!/usr/bin/env bash
set -Eeuo pipefail

# Root entrypoint for the real-provider lane.
#
# Why this exists: `/research/artifacts` is a host bind mount. The Docker daemon
# creates a missing bind-mount source as root:root on the host, and the sibling
# `aoa`/`e2e` services (which run as root) also write into it. The real-provider
# run itself must execute as `pwuser` so Playwright can launch a sandboxed
# Chromium without --no-sandbox. A pwuser process cannot mkdir under a
# root-owned mount, so `run-real-provider-e2e.sh` used to die on its first
# `mkdir -p` before it could even record a skipped summary.
#
# So: start as root, pre-create + chown the artifacts dir, then drop to pwuser
# for the real work. (Compose therefore must NOT set `user: pwuser` on this
# service — the privilege drop happens here.)

cd /app

ARTIFACTS_DIR="${AOA_RESEARCH_ARTIFACTS_DIR:-/research/artifacts}"
mkdir -p "${ARTIFACTS_DIR}"
chown -R pwuser:pwuser "${ARTIFACTS_DIR}" 2>/dev/null || true

# gosu/setpriv preserve the environment, so HOME would stay root's. The
# real-provider script writes provider CLI auth (e.g. codex auth.json) under
# $HOME, so pin it to pwuser's home before dropping privileges — otherwise that
# write lands in /root and fails with EACCES once a real provider key is set.
export HOME=/home/pwuser

if command -v gosu >/dev/null 2>&1; then
  exec gosu pwuser bash docker/research/run-real-provider-e2e.sh "$@"
elif command -v setpriv >/dev/null 2>&1; then
  exec setpriv --reuid=pwuser --regid=pwuser --init-groups \
    bash docker/research/run-real-provider-e2e.sh "$@"
else
  exec runuser -u pwuser -- bash docker/research/run-real-provider-e2e.sh "$@"
fi
