# syntax=docker/dockerfile:1
#
# DEP-002 — fake-provider service image (harness only).
#
# Runs the deterministic fixture-driven fake sandbox provider
# (packages/sandbox-fake-provider, DEP-000) behind docker/d1/fake-provider-entry.mjs.
# Least-privilege: non-root, no server/db, closure limited to sandbox-fake-provider
# + worker-protocol (+ zod). The container BUILD is Linux/CI-only (deferred; CI
# currently billing-blocked); the exact build steps are finalized at first CI build.
#
# Base pinned BY DIGEST — same node:lts-trixie-slim index digest as the DEP-001
# split images (docker/control-plane/Dockerfile, docker/worker/Dockerfile).
FROM node:lts-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/sandbox-fake-provider/package.json packages/sandbox-fake-provider/
COPY packages/worker-protocol/package.json packages/worker-protocol/
COPY patches/ patches/
RUN pnpm install --frozen-lockfile --prod --filter "@armyofagents/sandbox-fake-provider..."

FROM deps AS build
WORKDIR /app
RUN npm install --global typescript@5.7.3 @types/node@24
COPY tsconfig.json ./
COPY packages/worker-protocol/ packages/worker-protocol/
COPY packages/sandbox-fake-provider/ packages/sandbox-fake-provider/
RUN ln -s "$(npm root -g)/@types" node_modules/@types || true
RUN tsc -p packages/worker-protocol/tsconfig.json \
  && tsc -p packages/sandbox-fake-provider/tsconfig.json \
  && test -f packages/sandbox-fake-provider/dist/index.js \
    || (echo "ERROR: sandbox-fake-provider build output missing" && exit 1)
RUN pnpm --filter @armyofagents/sandbox-fake-provider deploy --prod /fake-app

FROM base AS production
LABEL org.opencontainers.image.title="AoA D1 Fake Sandbox Provider"
LABEL org.opencontainers.image.description="Deterministic fixture-driven fake sandbox provider (DEP-000) for the D1 harness"
LABEL org.armyofagents.image.role="fake-provider"

WORKDIR /fake-app
COPY --chown=node:node --from=build /fake-app /fake-app
COPY --chown=node:node docker/d1/fake-provider-entry.mjs /fake-app/fake-provider-entry.mjs
COPY --chown=node:node docker/d1/ctl-allowlist.mjs /fake-app/ctl-allowlist.mjs

ENV NODE_ENV=production \
  AOA_FAKE_PROVIDER_API_PORT=8080 \
  AOA_FAKE_PROVIDER_CTL_PORT=8081 \
  AOA_FAKE_PROVIDER_FIXTURES_DIR=/fixtures

USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=5 \
  CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.AOA_FAKE_PROVIDER_API_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "fake-provider-entry.mjs"]
