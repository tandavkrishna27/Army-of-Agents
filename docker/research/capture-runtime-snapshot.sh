#!/usr/bin/env bash
set -Eeuo pipefail

cd /app

ARTIFACTS_DIR="${AOA_RESEARCH_ARTIFACTS_DIR:-/research/artifacts}"
RUN_ID="${AOA_RESEARCH_RUN_ID:-snapshot-$(date -u +%Y%m%dT%H%M%SZ)}"
SNAPSHOT_DIR="${ARTIFACTS_DIR}/snapshots/${RUN_ID}"
mkdir -p "${SNAPSHOT_DIR}"

BASE_URL="${AOA_RESEARCH_BASE_URL:-http://127.0.0.1:${PORT:-3100}}"

echo "[aoa-research:snapshot] writing ${SNAPSHOT_DIR}"

curl -fsS "${BASE_URL}/api/health" | jq . > "${SNAPSHOT_DIR}/api-health.json"
curl -fsS "${BASE_URL}/api/companies" | jq . > "${SNAPSHOT_DIR}/api-companies.json"

if [[ -n "${AOA_CONFIG:-}" && -f "${AOA_CONFIG}" ]]; then
  node docker/research/redact-json-file.mjs "${AOA_CONFIG}" "${SNAPSHOT_DIR}/config.redacted.json"
fi

node docker/research/write-redacted-env.mjs "${SNAPSHOT_DIR}/environment.redacted.json"

psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "\dx" > "${SNAPSHOT_DIR}/postgres-extensions.txt"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "\dt public.*" > "${SNAPSHOT_DIR}/postgres-tables.txt"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -Atc \
  "select relname || ',' || n_live_tup from pg_stat_user_tables order by relname" \
  > "${SNAPSHOT_DIR}/postgres-table-counts.csv"

for fake_log in \
  "${AOA_E2E_FAKE_CLAUDE_INVOCATIONS:-/tmp/aoa-e2e-fake-claude-invocations.jsonl}" \
  "${AOA_E2E_FAKE_CODEX_INVOCATIONS:-/tmp/aoa-e2e-fake-codex-invocations.jsonl}"; do
  if [[ -f "${fake_log}" ]]; then
    cp "${fake_log}" "${SNAPSHOT_DIR}/$(basename "${fake_log}")"
  fi
done

echo "[aoa-research:snapshot] done"
