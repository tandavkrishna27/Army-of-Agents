#!/bin/sh
set -eu

# Capture runtime UID/GID from environment variables, defaulting to 1000.
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the node user's UID/GID if they differ from the runtime request.
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

export AOA_HOME="${AOA_HOME:-/aoa}"
export AOA_INSTANCE_ID="${AOA_INSTANCE_ID:-default}"
export AOA_CONFIG="${AOA_CONFIG:-$AOA_HOME/instances/$AOA_INSTANCE_ID/config.json}"
export HOME="${HOME:-$AOA_HOME}"

# New images use /aoa. An old Compose file mounts the named volume over the
# compatibility symlink at /paperclip, leaving /aoa on a different anonymous
# volume. Refuse that mixed layout instead of silently initializing empty data.
if [ "$AOA_HOME" = "/aoa" ] && [ -d /paperclip ] && [ ! -L /paperclip ]; then
    echo "ERROR: legacy /paperclip is mounted but AOA_HOME is /aoa." >&2
    echo "Upgrade the Compose file so the existing aoa-data volume mounts at /aoa." >&2
    exit 1
fi

mkdir -p "$AOA_HOME"
layout_sentinel="$AOA_HOME/.aoa-data-layout-version"
if [ -f "$layout_sentinel" ]; then
    layout_version=$(cat "$layout_sentinel")
    if [ "$layout_version" != "2" ]; then
        echo "ERROR: unsupported AOA data-layout version '$layout_version' (expected 2)." >&2
        exit 1
    fi
else
    printf '%s\n' "2" > "$layout_sentinel"
fi

# Assemble DATABASE_URL from the discrete AOA_POSTGRES_* pieces, percent-encoding
# the user/password so URL-reserved characters in a hardened password survive
# postgres.js's URL parsing. An explicitly-provided DATABASE_URL always wins.
# The script prints nothing when no AOA_POSTGRES_PASSWORD is set (embedded-postgres
# deployments: quickstart / standalone docker run), so DATABASE_URL stays unset and
# the server keeps using embedded postgres. Runs before docker-bootstrap.mjs (which
# bakes config.json) and before the final exec, so both the baked config and the
# server's process.env are correct. A bad AOA_POSTGRES_DB exits nonzero here (set -e).
if [ -z "${DATABASE_URL:-}" ]; then
    _assembled_database_url="$(node /app/scripts/compose-database-url.mjs)"
    if [ -n "$_assembled_database_url" ]; then
        export DATABASE_URL="$_assembled_database_url"
    fi
    unset _assembled_database_url
fi

node /app/scripts/docker-bootstrap.mjs

AOA_INSTANCE_DIR=$(dirname "$AOA_CONFIG")
AOA_ENV_FILE="$AOA_INSTANCE_DIR/.env"

read_instance_env() {
    key=$1
    if [ -f "$AOA_ENV_FILE" ]; then
        sed -n "s/^${key}=//p" "$AOA_ENV_FILE" | tail -n 1
    fi
}

if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
    value=$(read_instance_env BETTER_AUTH_SECRET || true)
    if [ -n "$value" ]; then
        export BETTER_AUTH_SECRET="$value"
    fi
fi

if [ -z "${AOA_AGENT_JWT_SECRET:-}" ]; then
    value=$(read_instance_env AOA_AGENT_JWT_SECRET || true)
    if [ -n "$value" ]; then
        export AOA_AGENT_JWT_SECRET="$value"
    fi
fi

unset_if_blank() {
    for key in "$@"; do
        eval "value=\${$key-}"
        if [ -z "$value" ]; then
            unset "$key"
        fi
    done
}

unset_if_blank \
    AOA_ALLOWED_HOSTNAMES \
    AOA_AUTH_BASE_URL_MODE \
    AOA_AUTH_PUBLIC_BASE_URL \
    AOA_MIGRATION_PROMPT \
    AOA_PUBLIC_URL \
    AOA_STORAGE_LOCAL_DIR \
    AOA_STORAGE_S3_BUCKET \
    AOA_STORAGE_S3_ENDPOINT \
    AOA_STORAGE_S3_PREFIX \
    AOA_STORAGE_S3_REGION \
    ANTHROPIC_API_KEY \
    CURSOR_API_KEY \
    GEMINI_API_KEY \
    GITHUB_APP_CLIENT_ID \
    GITHUB_APP_CLIENT_SECRET \
    GITHUB_APP_ID \
    GITHUB_APP_PRIVATE_KEY_PEM \
    GITHUB_APP_SLUG \
    GITHUB_APP_WEBHOOK_SECRET \
    GOOGLE_API_KEY \
    OPENAI_API_KEY

if [ -S /var/run/docker.sock ]; then
    sock_gid=$(stat -c "%g" /var/run/docker.sock 2>/dev/null || true)
    if [ -n "$sock_gid" ]; then
        if ! getent group "$sock_gid" >/dev/null 2>&1; then
            groupadd -g "$sock_gid" dockerhost >/dev/null 2>&1 || true
        fi
        sock_group=$(getent group "$sock_gid" | cut -d: -f1 | head -n 1 || true)
        if [ -n "$sock_group" ]; then
            usermod -aG "$sock_group" node >/dev/null 2>&1 || true
        fi
    fi
fi

if [ "$changed" = "1" ]; then
    chown -R node:node "$AOA_HOME"
else
    for target in \
        "$AOA_HOME" \
        "$AOA_HOME/instances" \
        "$AOA_INSTANCE_DIR" \
        "$AOA_INSTANCE_DIR/data" \
        "$AOA_INSTANCE_DIR/data/storage" \
        "$AOA_INSTANCE_DIR/data/backups" \
        "$AOA_INSTANCE_DIR/logs" \
        "$AOA_INSTANCE_DIR/secrets" \
        "$AOA_INSTANCE_DIR/workspaces" \
        "$AOA_CONFIG" \
        "$AOA_ENV_FILE"
    do
        if [ -e "$target" ]; then
            chown node:node "$target"
        fi
    done
fi

exec gosu node "$@"
