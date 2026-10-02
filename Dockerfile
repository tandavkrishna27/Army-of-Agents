FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    docker-cli \
    gh \
    git \
    gosu \
    iproute2 \
    jq \
    less \
    lsof \
    netcat-openbsd \
    openssh-client \
    pkg-config \
    postgresql-client \
    procps \
    python3 \
    ripgrep \
    rsync \
    socat \
    unzip \
    wget \
    zip \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /aoa node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw/package.json packages/adapters/openclaw/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/adapters/hermes-local/package.json packages/adapters/hermes-local/
COPY packages/plugins/create-aoa-plugin/package.json packages/plugins/create-aoa-plugin/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY patches/ patches/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
# Include the published catalog snapshots in the Docker image so the app can
# resolve marketplace items when its runtime catalog sync is unavailable.
RUN pnpm prebuild
RUN pnpm --filter @armyofagents/ui build
RUN pnpm --filter @armyofagents/plugin-sdk build
RUN pnpm --filter @armyofagents/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
ARG CODEX_CLI_VERSION=0.145.0
ARG CLAUDE_CODE_VERSION=2.1.220
ARG AOA_IMAGE_REVISION=unknown

LABEL org.opencontainers.image.title="AoA"
LABEL org.opencontainers.image.description="Army of Agents — Hybrid Workforce OS"
LABEL org.opencontainers.image.source="https://github.com/meteoritelabs/aoa"
LABEL org.opencontainers.image.revision="${AOA_IMAGE_REVISION}"

WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev \
    @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    @google/gemini-cli@latest \
    @openai/codex@${CODEX_CLI_VERSION} \
    opencode-ai \
  && mkdir -p /aoa \
  && chown node:node /aoa

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/aoa \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  AOA_HOME=/aoa \
  AOA_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  AOA_CONFIG=/aoa/instances/default/config.json \
  AOA_DEPLOYMENT_MODE=authenticated \
  AOA_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true

VOLUME ["/aoa"]
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 CMD curl -fsS "http://127.0.0.1:${PORT:-3100}/api/health" >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
