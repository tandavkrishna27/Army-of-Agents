#!/usr/bin/env bash
set -Eeuo pipefail

cd /app

ARTIFACTS_DIR="${AOA_RESEARCH_ARTIFACTS_DIR:-/research/artifacts}"
RUN_ID="${AOA_RESEARCH_RUN_ID:-real-provider-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="${ARTIFACTS_DIR}/real-provider-uat/${RUN_ID}"
mkdir -p "${RUN_DIR}/logs" "${RUN_DIR}/playwright"

export DATABASE_URL="${AOA_RESEARCH_E2E_DATABASE_URL:-${DATABASE_URL:-postgres://paperclip:paperclip@db:5432/paperclip_e2e_real_provider}}"
export AOA_HOME="${AOA_HOME:-/tmp/aoa-real-provider-e2e-home}"
export AOA_INSTANCE_ID="${AOA_INSTANCE_ID:-docker-research-real-provider-e2e}"
export AOA_MIGRATION_AUTO_APPLY="${AOA_MIGRATION_AUTO_APPLY:-true}"
export AOA_E2E_PORT="${AOA_E2E_PORT:-3299}"
export AOA_E2E_SKIP_LLM="false"
export AOA_E2E_REAL_PROVIDER="${AOA_E2E_REAL_PROVIDER:-1}"
export AOA_E2E_REAL_CREW_FLOW="${AOA_E2E_REAL_CREW_FLOW:-1}"
export AOA_E2E_FAKE_CREW_LLM="0"
export AOA_E2E_FAKE_EMBEDDER="0"

unset AOA_E2E_FAKE_CLAUDE_CONTROL
unset AOA_E2E_FAKE_CLAUDE_INVOCATIONS
unset AOA_E2E_FAKE_CODEX_CONTROL
unset AOA_E2E_FAKE_CODEX_INVOCATIONS
unset AOA_E2E_FAKE_EMBEDDER_CONTROL

provider="${AOA_E2E_REAL_CREW_PROVIDER:-}"
if [[ -z "${provider}" ]]; then
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    provider="anthropic"
  elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
    provider="openai"
  elif [[ -n "${GEMINI_API_KEY:-}" || -n "${GOOGLE_API_KEY:-}" ]]; then
    provider="google"
  fi
fi

write_summary() {
  local status="$1"
  local reason="$2"
  node -e '
const fs = require("node:fs");
const [path, status, reason, provider] = process.argv.slice(1);
const env = process.env;
const has = (name) => Boolean((env[name] || "").trim());
fs.writeFileSync(path, JSON.stringify({
  status,
  reason,
  provider: provider || null,
  startedAt: new Date().toISOString(),
  gates: {
    AOA_E2E_REAL_PROVIDER: env.AOA_E2E_REAL_PROVIDER || null,
    AOA_E2E_REAL_CREW_FLOW: env.AOA_E2E_REAL_CREW_FLOW || null,
    AOA_E2E_REAL_CREW_PROVIDER: env.AOA_E2E_REAL_CREW_PROVIDER || null,
    AOA_E2E_REAL_CREW_MODEL: env.AOA_E2E_REAL_CREW_MODEL || null
  },
  keysPresent: {
    OPENAI_API_KEY: has("OPENAI_API_KEY"),
    ANTHROPIC_API_KEY: has("ANTHROPIC_API_KEY"),
    GEMINI_API_KEY: has("GEMINI_API_KEY"),
    GOOGLE_API_KEY: has("GOOGLE_API_KEY")
  }
}, null, 2) + "\n");
' "${RUN_DIR}/real-provider-summary.json" "${status}" "${reason}" "${provider:-}"
}

if [[ -z "${provider}" ]]; then
  reason="No supported real-provider key was present; run the mock e2e lane instead."
  echo "[aoa-research:real-provider] SKIP: ${reason}" | tee "${RUN_DIR}/logs/real-provider.log"
  node docker/research/write-redacted-env.mjs "${RUN_DIR}/environment.redacted.json"
  write_summary "skipped" "${reason}"
  if [[ "${AOA_RESEARCH_REAL_PROVIDER_REQUIRED:-0}" == "1" ]]; then
    exit 2
  fi
  exit 0
fi

case "${provider}" in
  anthropic)
    required_key="ANTHROPIC_API_KEY"
    required_binary="claude"
    default_model="claude-sonnet-4-5-20250929"
    ;;
  openai)
    required_key="OPENAI_API_KEY"
    required_binary="codex"
    default_model="gpt-5.5"
    ;;
  google)
    required_key="GEMINI_API_KEY"
    required_binary="gemini"
    default_model="gemini-2.5-pro"
    ;;
  *)
    echo "[aoa-research:real-provider] Unsupported provider: ${provider}" >&2
    exit 2
    ;;
esac

export AOA_E2E_REAL_CREW_PROVIDER="${provider}"
export AOA_E2E_REAL_CREW_MODEL="${AOA_E2E_REAL_CREW_MODEL:-${default_model}}"
export GEMINI_CLI_TRUST_WORKSPACE="${GEMINI_CLI_TRUST_WORKSPACE:-true}"

if [[ "${provider}" == "google" ]]; then
  if [[ -z "${GEMINI_API_KEY:-}" && -z "${GOOGLE_API_KEY:-}" ]]; then
    echo "[aoa-research:real-provider] GEMINI_API_KEY or GOOGLE_API_KEY is required for provider ${provider}" >&2
    write_summary "failed" "Missing required provider key GEMINI_API_KEY or GOOGLE_API_KEY"
    exit 2
  fi
elif [[ -z "${!required_key:-}" ]]; then
  echo "[aoa-research:real-provider] ${required_key} is required for provider ${provider}" >&2
  write_summary "failed" "Missing required provider key ${required_key}"
  exit 2
fi

if ! command -v "${required_binary}" >/dev/null 2>&1; then
  echo "[aoa-research:real-provider] ${required_binary} CLI is not installed in the real-provider image" >&2
  write_summary "failed" "Missing required CLI ${required_binary}"
  exit 2
fi

if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  node -e '
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const key = (process.env.OPENAI_API_KEY || "").trim();
if (key) {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: key }), { mode: 0o600 });
}
'
fi

ADMIN_URL="${AOA_RESEARCH_E2E_ADMIN_DATABASE_URL:-postgres://paperclip:paperclip@db:5432/postgres}"
DB_NAME="$(node docker/research/url-db-name.mjs "${DATABASE_URL}")"
if [[ ! "${DB_NAME}" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "[aoa-research:real-provider] refusing unsafe database name: ${DB_NAME}" >&2
  exit 2
fi

if [[ "${AOA_RESEARCH_E2E_RESET_DB:-1}" == "1" ]]; then
  echo "[aoa-research:real-provider] resetting database ${DB_NAME}"
  psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${DB_NAME}\" WITH (FORCE);"
  psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DB_NAME}\" OWNER paperclip;"
fi

node docker/research/write-redacted-env.mjs "${RUN_DIR}/environment.redacted.json"
write_summary "running" "Real-provider run started"

set +e
pnpm exec playwright test --config=tests/e2e/playwright.real-provider.config.ts "$@" 2>&1 | tee "${RUN_DIR}/logs/playwright.log"
status="${PIPESTATUS[0]}"
set -e

for path in \
  "tests/e2e/test-results-real-provider" \
  "tests/e2e/playwright-report-real-provider" \
  "test-results-real-provider" \
  "playwright-report-real-provider"; do
  if [[ -d "${path}" ]]; then
    mkdir -p "${RUN_DIR}/playwright"
    cp -a "${path}" "${RUN_DIR}/playwright/"
  fi
done

if [[ "${status}" == "0" ]]; then
  write_summary "passed" "Real-provider Playwright run passed"
else
  write_summary "failed" "Real-provider Playwright run failed"
fi

echo "[aoa-research:real-provider] artifacts: ${RUN_DIR}"
exit "${status}"
