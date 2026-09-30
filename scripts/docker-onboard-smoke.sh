#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-paperclip-onboard-smoke}"
HOST_PORT="${HOST_PORT:-3131}"
AOA_CLI_VERSION="${AOA_CLI_VERSION:-latest}"
DATA_DIR="${DATA_DIR:-$REPO_ROOT/data/docker-onboard-smoke}"
HOST_UID="${HOST_UID:-$(id -u)}"
SMOKE_DETACH="${SMOKE_DETACH:-false}"
SMOKE_METADATA_FILE="${SMOKE_METADATA_FILE:-}"
AOA_DEPLOYMENT_MODE="${AOA_DEPLOYMENT_MODE:-local_trusted}"
AOA_DEPLOYMENT_EXPOSURE="${AOA_DEPLOYMENT_EXPOSURE:-private}"
AOA_PUBLIC_URL="${AOA_PUBLIC_URL:-http://localhost:${HOST_PORT}}"
AOA_DEV_LOCAL_IDENTITY="${AOA_DEV_LOCAL_IDENTITY:-1}"
CONTAINER_NAME="${IMAGE_NAME//[^a-zA-Z0-9_.-]/-}"
LOG_PID=""
PRESERVE_CONTAINER_ON_EXIT="false"

mkdir -p "$DATA_DIR"

cleanup() {
  if [[ -n "$LOG_PID" ]]; then
    kill "$LOG_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$PRESERVE_CONTAINER_ON_EXIT" != "true" ]]; then
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

container_is_running() {
  local running
  running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  [[ "$running" == "true" ]]
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-60}"
  local sleep_seconds="${3:-1}"
  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if ! container_is_running; then
      echo "Smoke bootstrap failed: container $CONTAINER_NAME exited before $url became ready" >&2
      docker logs "$CONTAINER_NAME" >&2 || true
      return 1
    fi
    sleep "$sleep_seconds"
  done
  if ! container_is_running; then
    echo "Smoke bootstrap failed: container $CONTAINER_NAME exited before readiness check completed" >&2
    docker logs "$CONTAINER_NAME" >&2 || true
  fi
  return 1
}

write_metadata_file() {
  if [[ -z "$SMOKE_METADATA_FILE" ]]; then
    return 0
  fi
  mkdir -p "$(dirname "$SMOKE_METADATA_FILE")"
  {
    printf 'SMOKE_BASE_URL=%q\n' "$AOA_PUBLIC_URL"
    printf 'SMOKE_CONTAINER_NAME=%q\n' "$CONTAINER_NAME"
    printf 'SMOKE_DATA_DIR=%q\n' "$DATA_DIR"
    printf 'SMOKE_IMAGE_NAME=%q\n' "$IMAGE_NAME"
    printf 'SMOKE_AOA_CLI_VERSION=%q\n' "$AOA_CLI_VERSION"
  } >"$SMOKE_METADATA_FILE"
}

echo "==> Building onboard smoke image"
docker build \
  --build-arg AOA_CLI_VERSION="$AOA_CLI_VERSION" \
  --build-arg HOST_UID="$HOST_UID" \
  -f "$REPO_ROOT/Dockerfile.onboard-smoke" \
  -t "$IMAGE_NAME" \
  "$REPO_ROOT"

echo "==> Running onboard smoke container"
echo "    UI should be reachable at: http://localhost:$HOST_PORT"
echo "    Public URL: $AOA_PUBLIC_URL"
echo "    Detached mode: $SMOKE_DETACH"
echo "    Data dir: $DATA_DIR"
echo "    Deployment: $AOA_DEPLOYMENT_MODE/$AOA_DEPLOYMENT_EXPOSURE"
if [[ "$SMOKE_DETACH" != "true" ]]; then
  echo "    Live output: onboard banner and server logs stream in this terminal (Ctrl+C to stop)"
fi

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

docker run -d --rm \
  --name "$CONTAINER_NAME" \
  -p "$HOST_PORT:3101" \
  -e AOA_DEPLOYMENT_MODE="$AOA_DEPLOYMENT_MODE" \
  -e AOA_DEPLOYMENT_EXPOSURE="$AOA_DEPLOYMENT_EXPOSURE" \
  -e AOA_PUBLIC_URL="$AOA_PUBLIC_URL" \
  -e AOA_DEV_LOCAL_IDENTITY="$AOA_DEV_LOCAL_IDENTITY" \
  -v "$DATA_DIR:/aoa" \
  "$IMAGE_NAME" >/dev/null

if [[ "$SMOKE_DETACH" != "true" ]]; then
  docker logs -f "$CONTAINER_NAME" &
  LOG_PID=$!
fi

if ! wait_for_http "$AOA_PUBLIC_URL/api/health" 90 1; then
  echo "Smoke bootstrap failed: server did not become ready at $AOA_PUBLIC_URL/api/health" >&2
  exit 1
fi

write_metadata_file

if [[ "$SMOKE_DETACH" == "true" ]]; then
  PRESERVE_CONTAINER_ON_EXIT="true"
  echo "==> Smoke container ready for automation"
  echo "    Smoke base URL: $AOA_PUBLIC_URL"
  if [[ -n "$SMOKE_METADATA_FILE" ]]; then
    echo "    Smoke metadata file: $SMOKE_METADATA_FILE"
  fi
  exit 0
fi

wait "$LOG_PID"
