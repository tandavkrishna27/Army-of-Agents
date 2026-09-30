# syntax=docker/dockerfile:1
#
# DEP-012 Slice 4+5 — Adapter-manager image (the out-of-process provider HOST).
#
# Least-privilege, pinned-by-digest image for `@armyofagents/adapter-manager` — the
# host of the per-op SandboxProvider (the `e2b` transport lives here, ONLY here).
# It mirrors docker/control-plane (NOT docker/worker) because, like the control
# plane, it makes outbound HTTPS calls (the e2b SDK) and needs a curl HEALTHCHECK —
# neither of which the worker image ships. Its runtime closure is EXACTLY the
# 7-package adapter-manager transitive workspace closure and NOTHING ELSE:
#   adapter-manager, provider-wire, sandbox-e2b-provider, worker-daemon,
#   worker-protocol, provider-capability, sandbox-provider-contract.
# (Validated for exact parity by scripts/check-image-deps-stages.mjs.)
#
# It runs as a NON-ROOT user on a READ-ONLY-capable root filesystem: all writable
# state (the β1 durable idempotency ledger + TMPDIR) is externalized to the /am
# volume. The bin fail-closes without the mounted ed25519 control-plane PUBLIC key
# (Slice-5 deploy-owed); nothing here is built or run in CI (the staging compose is
# render-only). Actually building/pushing aoa-adapter-manager:staging is a C0 concern.
#
# This file is ADDITIVE and default-off: it is OUTSIDE the frozen release-admission
# set (RELEASE_ARTIFACT_CLASSES) — staging is pre-release, so build/sbom/sign.sh are
# deliberately NOT wired to it.
#
# Base pinned BY DIGEST (node:lts-trixie-slim multi-arch index digest, the same the
# control-plane + worker images pin; re-verify/refresh at the first CI build).
FROM node:lts-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS base
# Minimal runtime tooling: CA certs (the e2b SDK makes HTTPS calls) + curl (the
# compose HEALTHCHECK is `curl -fsS …/healthz`). The worker image ships NEITHER —
# this is why the adapter-manager mirrors the control-plane, not the worker.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# ---------------------------------------------------------------------------
# deps — install EXACTLY the adapter-manager runtime workspace closure: the
# transitive runtime deps of @armyofagents/adapter-manager. COPY the 7-package
# closure and NOTHING more (validated by scripts/check-image-deps-stages.mjs —
# any missing OR extra workspace manifest here fails the deps-stage gate).
# provider-capability is a DEVdependency of adapter-manager but a RUNTIME
# dependency of provider-wire, so it is in the closure; sandbox-fake-provider is
# a devDependency of sandbox-provider-contract only and is deliberately absent.
# ---------------------------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/adapter-manager/package.json packages/adapter-manager/
COPY packages/provider-wire/package.json packages/provider-wire/
COPY packages/sandbox-e2b-provider/package.json packages/sandbox-e2b-provider/
COPY packages/worker-daemon/package.json packages/worker-daemon/
COPY packages/worker-protocol/package.json packages/worker-protocol/
COPY packages/provider-capability/package.json packages/provider-capability/
COPY packages/sandbox-provider-contract/package.json packages/sandbox-provider-contract/
COPY patches/ patches/
# Install only the adapter-manager closure. The lockfile stays frozen; the filter
# restricts the install to adapter-manager and its transitive workspace deps so the
# image never resolves server/ui/cli/db or any non-closure package. No --prod here
# (mirroring control-plane): the build stage needs the workspace devDep `typescript`
# to compile, then prunes dev deps via `pnpm deploy --prod` below.
RUN pnpm install --frozen-lockfile --filter "@armyofagents/adapter-manager..."

# ---------------------------------------------------------------------------
# build — compile the ENTIRE adapter-manager closure to dist. This fat stage is
# discarded; only the compiled dist + a pruned prod node_modules reach production.
# Building the WHOLE closure (the `...` suffix, topological order) is what lets the
# production stage ship the PRUNED `pnpm deploy` output instead of the whole source
# tree — the deployed workspace packages resolve to their built `dist` via
# `publishConfig`, so the runtime needs NO tsx (plain `node dist/bin/…`).
# ---------------------------------------------------------------------------
FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
# ★ RE-INSTALL, and it is NOT optional. `COPY . .` above brings in every workspace manifest,
# including `packages/sandbox-fake-provider` — which the deps stage deliberately does NOT copy
# (it is a devDependency of sandbox-provider-contract and is OUT of the runtime closure). pnpm's
# `...` walks the DISCOVERED workspace, so the deps-stage filter legitimately selected 7, but
# this build-stage filter now selects 8 and the 8th has no `node_modules`:
#
#     packages/sandbox-fake-provider build: src/hash.ts(11,28): error TS2307:
#       Cannot find module 'node:crypto' ...
#
# This is a MEASURED failure, not a hypothetical: the image did not build. The fix belongs
# HERE, after the copy that widens the workspace — not in the deps stage, whose COPY set is
# exactly the runtime closure `scripts/check-image-deps-stages.mjs` enforces.
#
# Plain `--filter`, NEVER `--filter-prod`: provider-capability's only edge to worker-daemon is a
# DEVdependency, so under the prod graph it is a leaf and compiles before worker-daemon's
# declarations exist (TS2307). That devDep edge is what produces the correct topological order.
RUN pnpm install --frozen-lockfile --filter "@armyofagents/adapter-manager..."
RUN pnpm --filter "@armyofagents/adapter-manager..." build
RUN test -f packages/adapter-manager/dist/bin/adapter-manager.js \
  || (echo "ERROR: adapter-manager build output missing" && exit 1)
# Self-contained, PROD-only deployment of JUST the adapter-manager closure: its dist
# + a pruned production node_modules with the workspace deps injected as built dist.
# No devDependencies (tsx / vitest), no server/ui/cli/db, no non-closure package.
RUN pnpm --filter @armyofagents/adapter-manager deploy --prod /am-app
# pnpm 9 `deploy` does NOT apply publishConfig, so the deployed @armyofagents/*
# manifests keep their dev ./src exports (not shipped; files:["dist"], no tsx here).
# Promote each package's publishConfig -> manifest so plain-node resolves the built
# ./dist (fixes ERR_MODULE_NOT_FOUND on the workspace deps + the bin).
RUN node docker/apply-workspace-publish-config.mjs /am-app/node_modules
RUN test -f /am-app/dist/bin/adapter-manager.js \
  || (echo "ERROR: adapter-manager deploy output missing" && exit 1)

# ---------------------------------------------------------------------------
# production — non-root, read-only-root-capable runtime. Provider host only.
# ---------------------------------------------------------------------------
FROM base AS production
ARG AOA_IMAGE_REVISION=unknown

LABEL org.opencontainers.image.title="AoA Adapter Manager"
LABEL org.opencontainers.image.description="Army of Agents adapter-manager — out-of-process SandboxProvider host (least-privilege split image)"
LABEL org.opencontainers.image.source="https://github.com/meteoritelabs/aoa"
LABEL org.opencontainers.image.revision="${AOA_IMAGE_REVISION}"
LABEL org.opencontainers.image.version="${AOA_IMAGE_REVISION}"
# Declares intended runtime posture; enforced by the compose + a `docker run
# --read-only` smoke. The writable /am volume backs the ledger + TMPDIR below.
LABEL org.armyofagents.image.rootfs="read-only"
LABEL org.armyofagents.image.role="adapter-manager"

WORKDIR /am-app
# Ship ONLY the least-privilege runtime artifacts — the PRUNED deploy closure:
# adapter-manager dist + a production-only node_modules whose workspace deps are the
# built dist, nothing else. No server/ui/cli, no agent CLIs, no non-closure source.
COPY --chown=node:node --from=build /am-app /am-app
COPY --chown=node:node docker/adapter-manager/entrypoint.sh /usr/local/bin/adapter-manager-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/adapter-manager-entrypoint.sh \
  && chmod +x /usr/local/bin/adapter-manager-entrypoint.sh \
  && mkdir -p /am /am/tmp /am/ledger \
  && chown -R node:node /am

# ★ [Img-1] The β1 durable idempotency ledger persists into a WRITABLE, node-owned
# volume dir. On a GATED server the ledger dir otherwise defaults to
# mkdtempSync(tmpdir(), …) (server.ts), and the bin calls startServer UN-try-caught —
# so under a `--read-only` root /tmp is unwritable → mkdtempSync THROWS → the
# container never goes healthy. Pointing the ledger (+ TMPDIR) at /am keeps boot
# viable on a read-only root, mirroring the control-plane's /aoa + worker's /worker.
ENV NODE_ENV=production \
  HOME=/am \
  HOST=0.0.0.0 \
  PORT=8090 \
  TMPDIR=/am/tmp \
  AOA_ADAPTER_MANAGER_IDEMPOTENCY_LEDGER_DIR=/am/ledger

# Non-root: the stock node user (uid 1000). No gosu/usermod at runtime — the fixed
# identity is what makes `--read-only` root viable.
USER node

VOLUME ["/am"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8090}/healthz" >/dev/null || exit 1

ENTRYPOINT ["adapter-manager-entrypoint.sh"]
# Plain node from the deploy root (WORKDIR /am-app): the deployed workspace deps
# resolve to built dist via publishConfig, so no tsx loader is needed. The bin has
# no `bin` field/shebang; it is invoked like the worker's `dist/bin/…` CMD.
CMD ["node", "dist/bin/adapter-manager.js"]
