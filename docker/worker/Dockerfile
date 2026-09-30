# syntax=docker/dockerfile:1
#
# DEP-001 — Worker image (the worker-daemon closure + the networked-host boot root).
#
# Least-privilege, signed, pinned-by-digest worker image. It runs as a NON-ROOT user on a
# READ-ONLY root filesystem and exposes ONLY a loopback health/metrics surface
# (GET /healthz, GET /metrics on 127.0.0.1):
#   * NO UI, NO @armyofagents/server
#   * NO DB / drizzle tooling
#   * NO @armyofagents/adapter-utils, shared, or any agent CLI
#
# ★ THE CLOSURE IS NO LONGER "EXACTLY worker-daemon + worker-protocol". DEP-011 Slice 2b
# added `@armyofagents/worker-networked-host` — the CONTAINER boot root that can construct a
# per-run provider over the gated adapter-manager wire — and Blocker B gives it an image home.
# Its runtime closure is SEVEN workspace packages:
#
#     worker-daemon, worker-protocol, worker-networked-host,
#     provider-wire, provider-capability, sandbox-e2b-provider, sandbox-provider-contract
#
# `sandbox-e2b-provider` (and therefore the `e2b` SDK) is in that closure because
# `provider-wire` VALUE-imports its error classes. That is structurally safe — the container
# worker holds no E2B key and never constructs an E2B transport; the real one lives in the
# adapter-manager — but the old "EXACTLY two packages" claim is simply false now, and a false
# closure statement is worse than a wider true one. E4-D01's REAL invariant survives intact:
# `worker-daemon` still imports no provider (`scripts/check-worker-daemon-boundary.mjs`), and
# the networked driver lives OUTSIDE it.
#
# ADDITIVE + default-off: the combined ./Dockerfile and docker.yml are untouched, and the
# image's CMD is UNCHANGED (see the production stage) — the new bin is opt-in per service.
#
# Base pinned BY DIGEST (node:lts-trixie-slim multi-arch index digest, resolved
# from Docker Hub on 2026-08-13; re-verify/refresh at the first CI build).
FROM node:lts-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS base
RUN corepack enable

# ---------------------------------------------------------------------------
# deps — install EXACTLY the worker runtime closure: the SEVEN workspace packages that are
# the transitive runtime deps of `worker-daemon` + `worker-networked-host`. Validated for
# exact parity by scripts/check-image-deps-stages.mjs — a missing OR extra workspace manifest
# here fails the deps-stage gate, so copying server/db/shared/adapter-utils still FAILS.
#
# ★ `--filter-prod` FOR SELECTION, and NO `--prod`. These look interchangeable and are not:
#
#   * `--filter-prod "X..."` restricts the SELECTED package set to X's *production* graph.
#     That set is byte-identical to `computeRuntimeClosure` in
#     `scripts/lib/image-deps-stage.mjs` (both walk `.dependencies` only), which is exactly
#     what makes the guard's COPY-set check equal to what pnpm actually installs.
#   * `--prod` additionally writes `included:{devDependencies:false}` into `.modules.yaml`.
#     The build stage's non-prod re-install then hits INCLUDED_DEPS_CONFLICT, falls through
#     to pnpm's purge prompt, and with Docker's closed stdin EXITS 0 HAVING INSTALLED
#     NOTHING. The next `pnpm ... build` then dies on a missing `tsc`. A silent success that
#     installs nothing is the worst failure mode available here, so `--prod` stays out.
#
# Dev deps are pruned at the END instead, by `pnpm deploy --prod` — the same shape the
# control-plane and adapter-manager images already use.
# ---------------------------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/worker-daemon/package.json packages/worker-daemon/
COPY packages/worker-protocol/package.json packages/worker-protocol/
COPY packages/worker-networked-host/package.json packages/worker-networked-host/
COPY packages/provider-wire/package.json packages/provider-wire/
COPY packages/provider-capability/package.json packages/provider-capability/
COPY packages/sandbox-e2b-provider/package.json packages/sandbox-e2b-provider/
COPY packages/sandbox-provider-contract/package.json packages/sandbox-provider-contract/
COPY patches/ patches/
RUN pnpm install --frozen-lockfile \
  --filter-prod "@armyofagents/worker-daemon..." \
  --filter-prod "@armyofagents/worker-networked-host..."

# ---------------------------------------------------------------------------
# build — compile the whole closure to dist. This fat stage is discarded; only the compiled
# dist + a pruned prod node_modules reach production. Built FROM deps, so node_modules already
# links the seven closure packages.
#
# ★ THE 8th MANIFEST. `sandbox-provider-contract` DEV-depends on `sandbox-fake-provider`, and
# its tsconfig lists that package's conformance suite in `files:` — which is NOT subject to
# `exclude`. So tsc needs the 8th package present to compile the closure at all. It is copied
# HERE and never in `deps`: the deps stage's COPY set is the RUNTIME closure that
# `scripts/check-image-deps-stages.mjs` enforces exactly, and `pnpm deploy --prod` below prunes
# fake-provider back out of the shipped tree (asserted by `image-contents.test.mjs`, whose
# anti-fake-provider `find` is deliberately UNSCOPED — it is about a fabricating provider
# reaching the image by ANY route).
#
# ★ THE BUILD LINE STAYS PLAIN `--filter`. `--filter-prod` here BREAKS it, and not obviously:
# `provider-capability`'s only edge to `worker-daemon` is a DEVdependency, so under the prod
# graph it becomes a leaf and compiles before `worker-daemon/dist/index.d.ts` exists → TS2307.
# That devDep edge is precisely what yields the correct topological order. The deps stage uses
# `--filter-prod` and this one does not; they are NOT inconsistent, they answer different
# questions (what to INSTALL vs what order to BUILD IN). Do not "make them consistent".
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
# The ONE script this stage runs. Copied by NAME — this image must never `COPY . .`: the
# `dockerfile-static` exclusion greps (no server/db/ui/adapter-utils/shared/drizzle, no agent
# CLIs) are text scans, and a whole-tree copy spells none of those paths while shipping them
# all, making every one of those assertions vacuous.
COPY docker/apply-workspace-publish-config.mjs docker/
COPY packages/sandbox-fake-provider/package.json packages/sandbox-fake-provider/
COPY packages/worker-protocol/ packages/worker-protocol/
COPY packages/worker-daemon/ packages/worker-daemon/
COPY packages/worker-networked-host/ packages/worker-networked-host/
COPY packages/provider-wire/ packages/provider-wire/
COPY packages/provider-capability/ packages/provider-capability/
COPY packages/sandbox-e2b-provider/ packages/sandbox-e2b-provider/
COPY packages/sandbox-provider-contract/ packages/sandbox-provider-contract/
COPY packages/sandbox-fake-provider/ packages/sandbox-fake-provider/
# Re-install against the manifest set THIS stage actually has (now 8), non-prod so the
# workspace `typescript` devDep is resolved. No `--prod` was used in deps, so this does not
# hit INCLUDED_DEPS_CONFLICT — see the deps-stage comment for why that matters.
RUN pnpm install --frozen-lockfile --filter "@armyofagents/worker-networked-host..."
RUN pnpm --filter "@armyofagents/worker-networked-host..." build
RUN test -f packages/worker-daemon/dist/bin/worker-daemon.js \
  || (echo "ERROR: worker-daemon build output missing" && exit 1)
# WRK-017 — the CONTAINER custody boot root. `docker-compose.d1.yml` enters it on one worker
# via a `command:` override, and a `command:` naming a file that is not in the image is not a
# build failure: the container starts, node exits `ERR_MODULE_NOT_FOUND`, and `up --wait`
# reports an unhealthy service with no hint that the BIN is what is missing. Assert it here,
# where the failure names itself. (The daemon deploy tree below is produced by
# `pnpm --filter @armyofagents/worker-daemon deploy`, which ships this package's whole `dist`,
# so the compiled bin reaching /worker-app follows from this line.)
RUN test -f packages/worker-daemon/dist/bin/container-host.js \
  || (echo "ERROR: worker-daemon container-host build output missing" && exit 1)
RUN test -f packages/worker-networked-host/dist/bin/networked-host.js \
  || (echo "ERROR: worker-networked-host build output missing" && exit 1)
# TWO self-contained, prod-only deploy trees.
#
# `/worker-app` is UNTOUCHED — the existing daemon deployment, still the image's CMD and still
# what every `image-contents` assertion inspects.
#
# `/worker-net-app` is the new, SEPARATE tree for the networked boot root. A second tree rather
# than a widened first one, because the daemon deployment must keep resolving exactly what it
# resolved before: a shared tree would put provider-wire (and the e2b SDK) inside the daemon's
# own node_modules, which is the thing E4-D01 exists to prevent from happening by accident.
RUN pnpm --filter @armyofagents/worker-daemon deploy --prod /worker-app
RUN pnpm --filter @armyofagents/worker-networked-host deploy --prod /worker-net-app
# ★ REQUIRED, and its absence fails at CONTAINER START, not at build. pnpm 9's `deploy` does
# NOT apply `publishConfig`, so the deployed @armyofagents/* manifests keep their dev
# `./src/*.ts` exports. Plain node then resolves those and dies:
#     ERR_MODULE_NOT_FOUND ... provider-wire/src/index.ts
# Promoting publishConfig -> manifest points them at the built ./dist. `/worker-app` does not
# need this (worker-daemon is entered by its own compiled path with no workspace dep to
# re-resolve); `/worker-net-app` does, because its bin imports two workspace packages.
RUN node docker/apply-workspace-publish-config.mjs /worker-net-app/node_modules
RUN test -f /worker-net-app/dist/bin/networked-host.js \
  || (echo "ERROR: worker-networked-host deploy output missing" && exit 1)
# WRK-017 — the DEPLOYED container-host, at the exact path the D1 `command:` override names
# (WORKDIR is /worker-app, so `dist/bin/container-host.js` resolves here). Asserted on the
# deploy tree and not only on the build tree, because `pnpm deploy` is what decides which
# files actually ship.
RUN test -f /worker-app/dist/bin/container-host.js \
  || (echo "ERROR: worker-daemon container-host deploy output missing" && exit 1)

# ---------------------------------------------------------------------------
# production — non-root, read-only-root runtime. TWO pruned deploy trees: the daemon
# (`/worker-app`, the CMD) and the networked boot root (`/worker-net-app`, opt-in per service).
# ---------------------------------------------------------------------------
FROM base AS production
ARG AOA_IMAGE_REVISION=unknown

LABEL org.opencontainers.image.title="AoA Worker"
LABEL org.opencontainers.image.description="Army of Agents worker daemon — least-privilege split image (E4-D01 closure)"
LABEL org.opencontainers.image.source="https://github.com/meteoritelabs/aoa"
LABEL org.opencontainers.image.revision="${AOA_IMAGE_REVISION}"
LABEL org.opencontainers.image.version="${AOA_IMAGE_REVISION}"
LABEL org.armyofagents.image.rootfs="read-only"
LABEL org.armyofagents.image.role="worker"

WORKDIR /worker-app
COPY --chown=node:node --from=build /worker-app /worker-app
# DEP-011 Slice 2b's CONTAINER boot root, in its own pruned tree. Present but NOT entered:
# see the CMD at the bottom of this file for why the default must not move.
COPY --chown=node:node --from=build /worker-net-app /worker-net-app
COPY --chown=node:node docker/worker/entrypoint.sh /usr/local/bin/worker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/worker-entrypoint.sh \
  && chmod +x /usr/local/bin/worker-entrypoint.sh \
  && mkdir -p /worker \
  && chown node:node /worker

ENV NODE_ENV=production \
  HOME=/worker \
  TMPDIR=/worker/tmp \
  AOA_WORKER_HEALTH_HOST=127.0.0.1 \
  AOA_WORKER_HEALTH_PORT=9464

# Non-root fixed identity — the prerequisite for a read-only root filesystem.
USER node

VOLUME ["/worker"]
# Loopback-only health/metrics surface; the healthcheck runs inside the
# container's own network namespace. No curl in the image — Node's global fetch
# probes the local liveness endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.AOA_WORKER_HEALTH_PORT||9464)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["worker-entrypoint.sh"]
# ★ THE DEFAULT DOES NOT MOVE, and repointing it would crash-loop the fleet.
#
# `runContainerHost` constructs its `FileRecordStore`s UNCONDITIONALLY, and `resolveCustody`
# REFUSES `mounted_secret` custody when stores are present — exiting before the health socket
# ever binds. Every deployed worker today is `mounted_secret` (D1 declares it explicitly; the
# staging manifest does too), so a global repoint to the networked host would take the whole
# fleet down on the next deploy.
#
# The new bin is therefore OPT-IN PER SERVICE, via a compose `command:` override — the
# entrypoint is `exec "$@"`, so `command: ["node", "/worker-net-app/dist/bin/networked-host.js"]`
# is all it takes. That override, and `AOA_WORKER_PROVIDER_URL`, are what a staging-manifest
# invariant now watches for.
CMD ["node", "dist/bin/worker-daemon.js"]
