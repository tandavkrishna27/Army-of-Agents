ARG NODE_IMAGE=node:24-trixie-slim
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.61.0-noble

FROM ${NODE_IMAGE} AS runtime

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PNPM_HOME=/pnpm \
  PATH=/pnpm:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    dnsutils \
    gh \
    git \
    iproute2 \
    jq \
    less \
    lsof \
    nano \
    net-tools \
    netcat-openbsd \
    openssh-client \
    pkg-config \
    postgresql-client \
    procps \
    python3 \
    python3-pip \
    ripgrep \
    rsync \
    socat \
    tini \
    tree \
    unzip \
    vim-tiny \
    wget \
    zip \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY . .

RUN if [[ ! -f ui/src/aoa-marketplace-snapshot.json && -f tests/e2e/fixtures/marketplace-catalog.json ]]; then \
    cp tests/e2e/fixtures/marketplace-catalog.json ui/src/aoa-marketplace-snapshot.json; \
  fi

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @armyofagents/plugin-sdk build \
  && pnpm install --offline --frozen-lockfile \
  && sed -i 's/\r$//' docker/research/*.sh \
  && chmod +x docker/research/*.sh

EXPOSE 3100 3101 3199

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]

FROM ${PLAYWRIGHT_IMAGE} AS e2e
ARG PLAYWRIGHT_NPM_VERSION=1.61.0

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PNPM_HOME=/pnpm \
  PATH=/pnpm:$PATH \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    dnsutils \
    gh \
    git \
    iproute2 \
    jq \
    less \
    lsof \
    nano \
    net-tools \
    netcat-openbsd \
    openssh-client \
    pkg-config \
    postgresql-client \
    procps \
    python3 \
    python3-pip \
    ripgrep \
    rsync \
    socat \
    tini \
    tree \
    unzip \
    vim-tiny \
    wget \
    zip \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY . .

RUN if [[ ! -f ui/src/aoa-marketplace-snapshot.json && -f tests/e2e/fixtures/marketplace-catalog.json ]]; then \
    cp tests/e2e/fixtures/marketplace-catalog.json ui/src/aoa-marketplace-snapshot.json; \
  fi

RUN pnpm install --frozen-lockfile \
  && pnpm add -Dw "@playwright/test@${PLAYWRIGHT_NPM_VERSION}" \
  && pnpm --filter @armyofagents/plugin-sdk build \
  && pnpm install --offline --frozen-lockfile \
  && sed -i 's/\r$//' docker/research/*.sh \
  && chmod +x docker/research/*.sh

EXPOSE 3100 3101 3199

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]

FROM e2e AS e2e-real-provider
ARG CLAUDE_CODE_NPM_PACKAGE=@anthropic-ai/claude-code@latest
ARG CODEX_NPM_PACKAGE=@openai/codex@latest
ARG GEMINI_NPM_PACKAGE=@google/gemini-cli@latest

RUN npm install --global --omit=dev \
    "${CLAUDE_CODE_NPM_PACKAGE}" \
    "${CODEX_NPM_PACKAGE}" \
    "${GEMINI_NPM_PACKAGE}" \
  && { \
    claude --version >/tmp/aoa-claude-version.txt 2>&1 || true; \
    codex --version >/tmp/aoa-codex-version.txt 2>&1 || true; \
    gemini --version >/tmp/aoa-gemini-version.txt 2>&1 || true; \
  }

RUN chown -R pwuser:pwuser /app
