#!/usr/bin/env bash
set -Eeuo pipefail

cd /app

ARTIFACTS_DIR="${AOA_RESEARCH_ARTIFACTS_DIR:-/research/artifacts}"
RUN_ID="${AOA_RESEARCH_RUN_ID:-e2e-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="${ARTIFACTS_DIR}/runs/${RUN_ID}"
mkdir -p "${RUN_DIR}/logs" "${RUN_DIR}/playwright"

export PATH="/app/tests/e2e/fixtures/fake-claude:/app/tests/e2e/fixtures/fake-codex:${PATH}"
export DATABASE_URL="${AOA_RESEARCH_E2E_DATABASE_URL:-${DATABASE_URL:-postgres://paperclip:paperclip@db:5432/paperclip_e2e}}"
export AOA_HOME="${AOA_HOME:-/tmp/aoa-e2e-home}"
export AOA_INSTANCE_ID="${AOA_INSTANCE_ID:-docker-research-e2e}"
export AOA_MIGRATION_AUTO_APPLY="${AOA_MIGRATION_AUTO_APPLY:-true}"
export AOA_E2E_PORT="${AOA_E2E_PORT:-3199}"

ADMIN_URL="${AOA_RESEARCH_E2E_ADMIN_DATABASE_URL:-postgres://paperclip:paperclip@db:5432/postgres}"
DB_NAME="$(node docker/research/url-db-name.mjs "${DATABASE_URL}")"
if [[ ! "${DB_NAME}" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "[aoa-research:e2e] refusing unsafe database name: ${DB_NAME}" >&2
  exit 2
fi

if [[ "${AOA_RESEARCH_E2E_RESET_DB:-1}" == "1" ]]; then
  echo "[aoa-research:e2e] resetting database ${DB_NAME}"
  psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${DB_NAME}\" WITH (FORCE);"
  psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DB_NAME}\" OWNER paperclip;"
fi

node docker/research/write-redacted-env.mjs "${RUN_DIR}/environment.redacted.json"

set +e
if [[ "$#" -gt 0 ]]; then
  pnpm exec playwright test --config=tests/e2e/playwright.config.ts "$@" 2>&1 | tee "${RUN_DIR}/logs/playwright.log"
  status="${PIPESTATUS[0]}"
else
  pnpm test:e2e 2>&1 | tee "${RUN_DIR}/logs/playwright.log"
  status="${PIPESTATUS[0]}"
fi
set -e

for path in \
  "tests/e2e/test-results" \
  "tests/e2e/playwright-report" \
  "test-results" \
  "playwright-report"; do
  if [[ -d "${path}" ]]; then
    mkdir -p "${RUN_DIR}/playwright"
    cp -a "${path}" "${RUN_DIR}/playwright/"
  fi
done

echo "[aoa-research:e2e] artifacts: ${RUN_DIR}"
exit "${status}"
