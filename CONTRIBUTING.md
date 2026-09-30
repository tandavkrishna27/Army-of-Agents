# Contributing to Army of Agents

Thanks for helping improve Army of Agents. This guide explains the contribution workflow for code, docs, adapters, tests, and configuration changes.

## Before you start

Read these files first:

1. [`AGENTS.md`](AGENTS.md) — repository rules for human and AI contributors
2. [`CLAUDE.md`](CLAUDE.md) — architecture baseline, naming map, and shipped behavior
3. [`docs/architecture/decisions.md`](docs/architecture/decisions.md) — locked product and architecture decisions
4. [`docs/roadmap.md`](docs/roadmap.md) — planned work; do not document roadmap items as shipped behavior

## Development setup

Requirements:

- Node.js 20.3 or newer
- pnpm 9
- Git

Install dependencies:

```sh
pnpm install
```

Start local development:

```sh
pnpm dev
```

The app runs at [http://localhost:3100](http://localhost:3100).

When `DATABASE_URL` is unset, local development uses embedded PostgreSQL through `embedded-postgres`, not PGlite.

Useful health checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset the default local development database:

```sh
rm -rf ~/.aoa/instances/default/db
pnpm dev
```

## Branches and commits

- Use a focused branch for each change.
- The preferred branch prefix is `codex/` for AI-assisted work.
- Keep unrelated changes out of the same pull request.
- Include generated files only when the workflow requires them.

## Verification

Run the standard checks before opening a pull request that changes code:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Docs-only changes may rely on lighter checks, but still run relevant validation such as:

```sh
git diff --check
```

For public docs changes, also check Mintlify navigation and links when practical.

## Database changes

Use Drizzle for schema changes.

1. Edit schema files under `packages/db/src/schema/`.
2. Export new tables from `packages/db/src/schema/index.ts` when needed.
3. Generate the migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Do not hand-write raw SQL migration files except for the narrow idempotency guard and data-only backfill exceptions documented in `AGENTS.md`.

## Dependency and lockfile changes

If a dependency changes, commit the manifest and regenerated lockfile together:

```sh
pnpm install --no-frozen-lockfile
pnpm install --frozen-lockfile
```

A pull request that changes only `pnpm-lock.yaml` is blocked by CI unless a package manifest or dependency configuration changed in the same PR.

## Contract changes

Keep contracts synchronized. If a behavior touches schema or API contracts, update the affected layers together:

- `packages/db`
- `packages/shared`
- `server`
- `ui`
- docs and tests

Public UI language says Task, Home, Budget, Team, and Discussion. Some API and database names intentionally remain unchanged for compatibility, such as `/issues` and the `issues` table.

## Documentation changes

Documentation should describe shipped behavior. Planned behavior belongs in `docs/roadmap.md` or in clearly labeled planning documents.

For public Mintlify docs, follow [`docs/contributing/public-docs-style.md`](docs/contributing/public-docs-style.md).

## Security changes

For security-sensitive changes, include the affected trust boundary and verification evidence in the pull request. Do not include secrets, tokens, private logs, or exploit payloads in public discussions.

See [`SECURITY.md`](SECURITY.md) for vulnerability reporting.

## Pull request checklist

Before requesting review, confirm:

- [ ] The change matches `CLAUDE.md` and relevant architecture decisions.
- [ ] Company scoping and permission boundaries are preserved.
- [ ] Database, shared types, server, UI, adapters, and docs are synchronized where relevant.
- [ ] Tests or checks were run and listed in the PR.
- [ ] Docs were updated when behavior or commands changed.
- [ ] No secrets or private local data were committed.
- [ ] No retired brand terms were introduced.
