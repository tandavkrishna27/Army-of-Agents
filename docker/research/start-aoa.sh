#!/usr/bin/env bash
set -Eeuo pipefail

cd /app

ARTIFACTS_DIR="${AOA_RESEARCH_ARTIFACTS_DIR:-/research/artifacts}"
RUN_ID="${AOA_RESEARCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="${ARTIFACTS_DIR}/runs/${RUN_ID}"
LOG_DIR="${RUN_DIR}/logs"
mkdir -p "${LOG_DIR}" "${RUN_DIR}/snapshots" "${RUN_DIR}/tmp" "${AOA_HOME:-/research/aoa-home}"

export PATH="/app/tests/e2e/fixtures/fake-claude:/app/tests/e2e/fixtures/fake-codex:${PATH}"
export AOA_CONFIG="${AOA_CONFIG:-${AOA_HOME}/instances/${AOA_INSTANCE_ID:-docker-research}/config.json}"
export AOA_LOG_DIR="${AOA_LOG_DIR:-${LOG_DIR}/aoa}"
export RUN_LOG_BASE_PATH="${RUN_LOG_BASE_PATH:-${RUN_DIR}/run-logs}"
export WORKSPACE_OPERATION_LOG_BASE_PATH="${WORKSPACE_OPERATION_LOG_BASE_PATH:-${RUN_DIR}/workspace-operation-logs}"
export AOA_WORKTREES_DIR="${AOA_WORKTREES_DIR:-${RUN_DIR}/workspaces}"
export AOA_STORAGE_LOCAL_DIR="${AOA_STORAGE_LOCAL_DIR:-${RUN_DIR}/storage}"
export AOA_DB_BACKUP_DIR="${AOA_DB_BACKUP_DIR:-${RUN_DIR}/db-backups}"

mkdir -p \
  "${AOA_LOG_DIR}" \
  "${RUN_LOG_BASE_PATH}" \
  "${WORKSPACE_OPERATION_LOG_BASE_PATH}" \
  "${AOA_WORKTREES_DIR}" \
  "${AOA_STORAGE_LOCAL_DIR}" \
  "${AOA_DB_BACKUP_DIR}"

node docker/research/write-redacted-env.mjs "${RUN_DIR}/environment.redacted.json"

if [[ "${AOA_RESEARCH_ENABLE_PROXY:-1}" == "1" ]]; then
  PROXY_PORT="${AOA_RESEARCH_PROXY_PORT:-3101}"
  TARGET_PORT="${PORT:-3100}"
  socat "TCP-LISTEN:${PROXY_PORT},fork,reuseaddr,bind=0.0.0.0" "TCP:127.0.0.1:${TARGET_PORT}" &
  proxy_pid=$!
  echo "[aoa-research] localhost proxy listening on container port ${PROXY_PORT} -> 127.0.0.1:${TARGET_PORT}"
fi

cleanup() {
  if [[ -n "${aoa_pid:-}" ]]; then
    kill "${aoa_pid}" 2>/dev/null || true
  fi
  if [[ -n "${proxy_pid:-}" ]]; then
    kill "${proxy_pid}" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup INT TERM

echo "[aoa-research] artifacts: ${RUN_DIR}"
echo "[aoa-research] starting AoA in local_trusted mode against ${DATABASE_URL}"

pnpm aoa onboard --yes --run > >(tee -a "${LOG_DIR}/aoa-server.log") 2>&1 &
aoa_pid=$!

wait "${aoa_pid}"
