---
title: Docker Research Harness
summary: Disposable Compose setup for isolated runtime research
---

# Docker Research Harness

Use `docker-compose.research.yml` when you want to understand AoA runtime
behavior without touching your host `~/.aoa`, real agent CLIs, real provider
keys, or the default development server.

## What It Runs

- Postgres 18 with pgvector in a disposable Docker volume mounted at
  `/var/lib/postgresql`, matching the Postgres 18 Docker image layout.
- AoA from source in `local_trusted` mode on `node:24-trixie-slim`.
- A loopback-preserving browser proxy so your host browser can reach the
  container while `aoa` and `db` stay on an internal Docker network.
- Fake Claude and Codex CLIs from `tests/e2e/fixtures`.
- Fake embeddings and fake AWS Secrets Manager for deterministic tests.
- Marketplace CDN pinned to `http://127.0.0.1:1/catalog.json` so runtime fetches
  fail fast and use bundled fallback data.
- Runtime logs, snapshots, Playwright reports, workspaces, storage, and backups
  under `.runtime-research/`.
- An opt-in `real-provider` profile for cost-bearing real Claude/Codex/Gemini
  CLI tests. The default e2e profile stays deterministic and does not need
  provider keys.

The runtime Compose network is `internal: true`. `aoa` and `db` can talk to
each other, but ordinary outbound network calls from the running app are
blocked by Docker networking. The only default host-facing service is
`browser-proxy`, which publishes `127.0.0.1:${AOA_RESEARCH_PORT:-33100}`.
The opt-in `e2e-real-provider` service also joins the non-internal network so
real provider CLIs can call external APIs. Building the image still needs
network access unless the base image, apt packages, pnpm dependencies, and
real-provider CLI packages are cached.

The large Playwright base image is used only when running the `e2e` service. It
defaults to `mcr.microsoft.com/playwright:v1.61.0-noble`; the ordinary app
container does not pull or depend on it. The e2e image upgrades
`@playwright/test` inside the image to `1.61.0` so Playwright looks for the
browser revisions preinstalled by that base image.

## Start The App

```sh
docker compose -f docker-compose.research.yml up --build
```

Open:

```txt
http://127.0.0.1:33100
```

Override ports if needed:

```sh
AOA_RESEARCH_PORT=33101 \
  docker compose -f docker-compose.research.yml up --build
```

## Capture A Runtime Snapshot

With `aoa` running:

```sh
docker compose -f docker-compose.research.yml exec aoa \
  bash docker/research/capture-runtime-snapshot.sh
```

The snapshot includes health/company API responses, redacted config/env, DB
extensions, table list, table row estimates, and fake CLI invocation logs when
present.

## Run E2E Flows

Run the full e2e suite:

```sh
docker compose -f docker-compose.research.yml run --rm e2e
```

Run a focused subset:

```sh
docker compose -f docker-compose.research.yml run --rm e2e \
  tests/e2e/onboarding.spec.ts \
  tests/e2e/commander-codex-reply.spec.ts
```

The e2e service uses a separate database named `paperclip_e2e` and resets it by
default before each run. Set `AOA_RESEARCH_E2E_RESET_DB=0` if you want to keep
state between e2e runs.

## Run Real-Provider Flows

The real-provider lane is separate from the deterministic e2e lane. It builds
the `e2e-real-provider` image target, installs real Claude/Codex/Gemini CLIs,
disables the fake crew and fake embedder seams, and runs only the gated
real-provider specs by default:

```sh
ANTHROPIC_API_KEY=... \
docker compose -f docker-compose.research.yml --profile real-provider run --rm --build e2e-real-provider
```

Provider selection:

- `AOA_E2E_REAL_CREW_PROVIDER=anthropic` uses `ANTHROPIC_API_KEY` and `claude`.
- `AOA_E2E_REAL_CREW_PROVIDER=openai` uses `OPENAI_API_KEY` and `codex`.
- `AOA_E2E_REAL_CREW_PROVIDER=google` uses `GEMINI_API_KEY` or
  `GOOGLE_API_KEY` and `gemini`.
- If no provider is set, the runner chooses Anthropic when
  `ANTHROPIC_API_KEY` is present, then OpenAI when `OPENAI_API_KEY` is present,
  then Google/Gemini when a Gemini/Google key is present.
- If no supported key is present, the runner records a skipped summary and
  exits zero. This lets portable automation run the mock lane everywhere and
  the real lane only where credentials are available.
- Set `AOA_RESEARCH_REAL_PROVIDER_REQUIRED=1` to fail when credentials are
  missing.

Run a specific real-provider spec:

```sh
OPENAI_API_KEY=... \
AOA_E2E_REAL_CREW_PROVIDER=openai \
docker compose -f docker-compose.research.yml --profile real-provider run --rm --build e2e-real-provider \
  tests/e2e/full-discussion-to-workspace-cycle.real-provider.spec.ts
```

Run the Google/Gemini lane:

```sh
GEMINI_API_KEY=... \
AOA_E2E_REAL_CREW_PROVIDER=google \
docker compose -f docker-compose.research.yml --profile real-provider run --rm --build e2e-real-provider
```

The real-provider lane uses a separate database named
`paperclip_e2e_real_provider` and resets it by default. Artifacts are written
under:

```txt
.runtime-research/artifacts/real-provider-uat/real-provider-*
```

Each run records `environment.redacted.json`, `real-provider-summary.json`,
`logs/playwright.log`, and copied Playwright reports/results when present. Do
not paste provider key values into docs or logs; pass them through environment
variables or a secret manager.

## Inspect The Database

```sh
docker compose -f docker-compose.research.yml run --rm psql
```

Or open a tool shell:

```sh
docker compose -f docker-compose.research.yml run --rm shell
```

## Tear Down

Stop containers but keep the DB volume and artifacts:

```sh
docker compose -f docker-compose.research.yml down
```

Remove containers and the disposable Postgres volume:

```sh
docker compose -f docker-compose.research.yml down -v
```

Generated files under `.runtime-research/` are gitignored. Delete that folder
when you no longer need logs, snapshots, reports, or workspaces.
