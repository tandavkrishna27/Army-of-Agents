# AoA Docker Research Harness

This directory contains a disposable Docker harness for runtime research. It is
separate from the production Dockerfile and Compose files on purpose.

The default harness runs AoA in `local_trusted` mode, uses an external
Postgres/pgvector 18 container, wires the e2e fake Claude/Codex CLIs into
`PATH`, enables the fake embedder, forces marketplace network fetches to fail
back to bundled data, and writes runtime evidence under `.runtime-research/`.

The opt-in `real-provider` profile builds a separate Playwright image with
real Claude, Codex, and Gemini CLIs. It disables fake crew/embedder seams,
passes provider keys from the host environment, attaches only that runner to a
non-internal Docker network, and writes cost-bearing evidence under
`.runtime-research/artifacts/real-provider-uat/`.

The normal `aoa` and `shell` services build from `node:24-trixie-slim`. The
large Playwright image is used only by the `e2e` profile and currently defaults
to `mcr.microsoft.com/playwright:v1.61.0-noble`. The e2e image also aligns
`@playwright/test` to `1.61.0` inside the image so the test runner looks for the
browser revisions already present in that base image.

## Services

- `db`: disposable Postgres with pgvector.
- `aoa`: AoA server bound to loopback inside the container.
- `browser-proxy`: host-facing proxy to the isolated AoA container.
- `e2e`: one-shot Playwright runner with a resettable e2e database.
- `e2e-real-provider`: one-shot Playwright runner for gated real-provider specs
  with a separate resettable database.
- `shell`: tool container for ad hoc commands.
- `psql`: direct psql session into the runtime database.

The main Compose network is marked `internal: true`, so `aoa` and `db` can talk
to each other but cannot make normal outbound network calls. The
`browser-proxy` service is the only default service attached to a non-internal
network, and it publishes only `127.0.0.1:${AOA_RESEARCH_PORT:-33100}`. The
`e2e-real-provider` service also joins the non-internal network because real
provider CLIs must call external APIs. Image builds still need network access
for apt, pnpm, and optional real-provider CLI packages unless your Docker cache
is already warm.

## Local Trusted Proxy

AoA refuses `local_trusted` mode unless the server binds to a loopback host. The
`aoa` container keeps the real app on `127.0.0.1:3100` and runs `socat` from
container port `3101` to that loopback listener. The `browser-proxy` service
then forwards the host loopback port to `aoa:3101`.

## Real-Provider Lane

The mock lane remains the default portable check:

```sh
docker compose -f docker-compose.research.yml --profile e2e run --rm e2e
```

The real-provider lane is explicit and cost-bearing:

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
- If no supported key is present, the runner writes a skipped summary and exits
  zero so a "mock plus optional real" harness can run on machines without
  provider credentials.
- Set `AOA_RESEARCH_REAL_PROVIDER_REQUIRED=1` when a missing key should fail.

Artifacts land under:

```txt
.runtime-research/artifacts/real-provider-uat/real-provider-*
```

Each run writes `environment.redacted.json`, `real-provider-summary.json`,
`logs/playwright.log`, and copied Playwright reports/results when present.
