---
title: Docker Runtime Research Changelog
summary: Consolidation notes for the July 2026 Docker deploy and runtime research worktrees
---

# Docker Runtime Research Changelog

This note records the branch-level consolidation of the two July 2026 Docker
worktrees into the main AoA repository. The intent comes from
`../aoa-repository-research`, which was the handoff and validation folder for
this work.

## Purpose

The research effort had two connected goals:

- Make Docker Compose a practical remote-dev deployment path with external
  pgvector Postgres, durable app data, generated first-run secrets, health
  checks, Google-OAuth `authenticated` mode (first Google sign-in becomes the
  instance admin), and an opt-in CEO invite bootstrap helper to pre-designate
  that admin when the instance URL is exposed before the founder signs in
  (the invite is redeemed via Google — not a way to run without Google).
- Make runtime research repeatable in Docker, with deterministic mocked e2e
  coverage by default and an explicit, cost-bearing real-provider lane for
  Claude, Codex, and Gemini.

The research notes also identify what this consolidation does not prove by
itself: authenticated multi-user coverage, full Vitest health in Docker,
recurring green real-provider UAT, route/auth/company-scope maps, plugin
network isolation, and migration/restore safety remain follow-up work.

## Consolidated From `AoA-deploy-compose`

- Expanded the production Docker image with common runtime/debug tooling,
  provider CLIs, `psql`, Docker CLI, and an image healthcheck.
- Reworked `docker-compose.yml` into the main multi-service deployment stack:
  `server` and `db`, plus an opt-in `bootstrap` profile (CEO invite, off by
  default) and a `psql` tools profile.
- Updated `docker-compose.quickstart.yml` as the single-container embedded
  Postgres trial path.
- Added `scripts/docker-bootstrap.mjs` to create first-run config, directories,
  and persisted auth/JWT secrets under `/paperclip`.
- Added `scripts/docker-bootstrap-ceo.mjs` for printing the first CEO invite.
- Updated `scripts/docker-entrypoint.sh` to run first-boot bootstrap, load
  persisted secrets, unset blank optional variables, handle optional Docker
  socket group membership, and narrow volume ownership changes.
- Updated Docker/database docs for pgvector Compose, generated secrets,
  bootstrap invites, S3 storage, psql access, and manual Docker runs.

Promotion cleanup applied during consolidation:

- Tracked the two bootstrap scripts required by the Dockerfile/entrypoint flow.
- Matched Compose GitHub App env names to `.env.example` and server code:
  `GITHUB_APP_PRIVATE_KEY_PEM`, `GITHUB_APP_WEBHOOK_SECRET`, and
  `GITHUB_APP_SLUG`.
- Removed disconnected AWS Secrets env placeholders from Compose; the current
  deploy path keeps `AOA_SECRETS_PROVIDER=local_encrypted` unless configured
  through the supported secrets UI/API flow.
- Added a Compose-specific variable table to `docs/deploy/docker.md`.

## Consolidated From `AoA-runtime-research`

- Added `.runtime-research/` ignores for generated Docker research artifacts.
- Added `docker-compose.research.yml`.
- Added `docker/research/*` scripts and Dockerfile targets for deterministic
  e2e, runtime snapshots, redacted env/config capture, and real-provider UAT.
- Added `docs/deploy/docker-research.md` for operating the disposable research
  harness.
- Added `tests/e2e/playwright.real-provider.config.ts` and the root
  `test:e2e:real-provider` script.
- Extended real-provider helper support from Anthropic/OpenAI to include
  Google/Gemini via `gemini_local`, `gemini`, and default model
  `gemini-2.5-pro`.
- Added the workspace-safety persona Playwright spec under
  `tests/e2e/personas/`.
- Promoted focused first-run regression coverage for the route-driven founder
  onboarding flow, including first-agent setup and launch behavior identified
  by the research notes.

## Research Evidence Carried Forward

The research folder records these historical results after the worktrees were
fast-forwarded to the then-current main on 2026-07-09:

- Docker deploy compose smoke passed in `AoA-deploy-compose`: external
  `pgvector/pgvector:pg18` database healthy, server healthy, migrations
  applied, generated instance config/secrets present, `/api/health` OK, and
  bootstrap invite helper exited `0`.
- Docker mocked Playwright e2e passed in `AoA-runtime-research`: 124 passed,
  17 skipped, 0 failed.
- Focused workspace-safety persona passed in Docker: 1 passed.
- Docker Vitest remained red: 102 failed suites and 230 failed tests.
- Real-provider Docker UAT remained non-recurring: Google/Gemini passed 2 of 3
  on the July 9 rerun, Anthropic/Claude reached provider execution but hit low
  credit, and OpenAI/Codex was blocked by provider quota.

Treat those as worktree evidence, not proof for this consolidation branch until
fresh verification is run against the branch tip.

## Follow-Ups

- Run a fresh Compose smoke from this branch: build, boot `db + server +
  bootstrap`, check `/api/health`, and verify the bootstrap invite output.
- Run deterministic Docker e2e from `docker-compose.research.yml`.
- Decide whether Docker full Vitest should become a release gate after its
  environment and assertion failures are triaged.
- Rerun real-provider lanes after provider quota/credit is available and the
  visible-agent-entry expectation is diagnosed.
- Add authenticated/private persona e2e coverage before recommending public or
  multi-user deployments as recurring green paths.
