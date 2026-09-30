# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

AoA (Army of Agents) is a Hybrid Workforce Operating System for startups — founding teams of any size, from solo founders to multi-person teams, running AI agents alongside humans from a single control room. The current product line is version 1.

## 2. Read This First

Before making changes, read in this order:

1. `CLAUDE.md` — architecture baseline, critical rules, naming map, all implemented tables
2. `docs/architecture/decisions.md` — 90+ locked product and architectural decisions. **Do not relitigate.**
3. `docs/roadmap.md` — planned features (NOT current behavior); `CLAUDE.md` is the source of truth for what shipped

## 3. Repo Map

```
server/src/           → Express 5.x REST API, services, adapters, heartbeat
ui/src/               → React + Vite board UI
packages/db/          → Drizzle schema, migrations, DB clients
packages/shared/      → Shared types, constants, validators, API path constants
packages/adapters/    → Adapter utilities
docs/                 → All documentation
```

Key doc paths:
- `docs/architecture/decisions.md` — locked decisions (90+)
- `docs/architecture/` — design system, memory, wire-compat, workspace decisions
- `docs/api/` — REST + MCP API contracts
- `docs/archive/` — historical session logs, plans, and audits

## 4. Dev Setup (Auto DB)

Use the embedded PostgreSQL instance in dev by leaving `DATABASE_URL` unset. AoA
bundles a real Postgres binary via [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres)
— **not** WASM-based PGlite.

```sh
pnpm install
pnpm dev
```

This starts:

- API + UI: `http://localhost:3100`

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB (default instance):

```sh
rm -rf ~/.aoa/instances/default/db
pnpm dev
```

## 5. Core Engineering Rules

1. **Keep changes company-scoped.**
   Every domain entity must be scoped to a company. Enforce company boundaries in routes and services.

2. **Keep contracts synchronized.**
   If you change schema or API behavior, update all impacted layers:
   - `packages/db` — schema and exports
   - `packages/shared` — types, constants, validators
   - `server` — routes and services
   - `ui` — API clients and pages

3. **Preserve control-plane invariants.**
   - Single-assignee task model
   - Atomic issue checkout semantics (`SELECT FOR UPDATE NO WAIT`)
   - Approval gates for governed actions
   - Budget hard-stop auto-pause behavior
   - Activity logging for all mutating actions

4. **Naming map — UI says Task/Home/Budget/Team/Discussion, DB/API stay unchanged.**
   See `CLAUDE.md` §Naming Map for the full table. Never rename DB tables or API routes.

5. **MCP inbound follows revised Decision #14.** Authenticated MCP, board, and agent callers may create or update structured tasks directly when RBAC allows it. Use `debrief-push` for unstructured content that should enter the Discussion extraction pipeline. Anonymous MCP traffic is rejected outside `local_trusted`; loopback `local_trusted` traffic is treated as trusted board/agent context, not public anonymous input.

6. **Drizzle ORM only.** Schema changes go in `packages/db/src/schema/`. Run `pnpm db:generate`. Never write raw SQL migration files. (Decision #19) **Narrow exception (C14) — TWO classes, and nothing else.** Both are things drizzle-kit provably cannot emit under this repo's config.

   **(a) Idempotency guards and data-only backfills**, hand-APPENDED below generated DDL, always with an inline comment and always idempotent (`WHERE … IS NULL` / `ON CONFLICT DO NOTHING`). Concretely, 0195 was produced by `pnpm db:generate`, then the C14 idempotency guards on its constraint swap plus the data backfills were hand-appended below the generated DDL.

   **(b) Idempotent cluster/security DDL** — roles, `GRANT`/`REVOKE`, `ENABLE`/`FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, and `SECURITY DEFINER` functions plus their ACLs — hand-authored into a delta-free `--custom` migration (`pnpm db:generate --custom --name=…`), because there is no schema delta to diff onto. `drizzle.config.ts` declares no `entities.roles` and no `pgPolicy`, and drizzle-orm's `pg-core` exposes no function/routine primitive, so no generator route exists for any of it. Exemplars: 0211 (the tenant-RLS foundation), 0213/0214 (serving-role hardening), 0259/0261 (app-select grants), 0267 (the canary preflight's `SECURITY DEFINER` evidence functions; 0266 is superseded and is NOT an exemplar — see Decision #122).

   **⚠ Class (b) is governed by Decision #122 in `docs/architecture/decisions.md`, plus its 2026-09-01 amendment covering `CREATE FUNCTION`. That decision is the AUTHORITY and carries the binding conditions — a delta-free `--custom` migration, idempotent statements with an inline comment saying why drizzle-kit cannot emit them, no committed role credential, and for definer functions a manifest entry certified at boot with fatal drift. Read it before hand-authoring anything; the text here is a summary and cannot widen it.**

   **Tables, columns, indexes and foreign keys are NEVER hand-authored** — that is always `db:generate` output, diffed from `packages/db/src/schema/`. A `--custom` migration that touches them is the violation this rule exists to stop.

7. **New services follow `server/src/services/goals.ts`. New routes follow `server/src/routes/goals.ts`.**

## 6. Database Change Workflow

When changing the data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Dependency Change Workflow

Adding, upgrading, or removing a dependency needs care because CI blocks any PR that commits `pnpm-lock.yaml` **on its own**. The gate is the `Block manual lockfile edits` step in the `policy` job of [`.github/workflows/pr.yml`](.github/workflows/pr.yml): it fails a PR that changes `pnpm-lock.yaml` *unless the same PR also changes a package manifest* (`package.json`, `pnpm-workspace.yaml`, `.npmrc`, or a `pnpmfile`). Lockfile-only commits are rejected; lockfile + manifest together is allowed.

> **Retired 2026-06-24:** the old `chore/refresh-lockfile` branch-name escape hatch and the `refresh-lockfile.yml` auto-bot were removed. The bot watched the now-dead `Porting1.1` branch, and the branch-name carve-out was a policy bypass — any PR could use that exact name to slip a lockfile-only change past the gate. Re-introducing an auto-refresh bot pointed at `main` is a Phase 2 follow-up. Until then, refresh the lockfile inline (below).

### Standard flow: change a dependency

Commit the manifest and the regenerated lockfile **together, on any branch** — no special branch name required.

```sh
# 1. Edit the relevant package.json (root, server/, ui/, packages/*/).
#    Add / upgrade / remove deps as needed.

# 2. Regenerate the lockfile.
pnpm install --no-frozen-lockfile

# 3. Verify it's in sync — should be a no-op.
pnpm install --frozen-lockfile

# 4. Commit BOTH the manifest change(s) and pnpm-lock.yaml in the same PR.
git add package.json '**/package.json' pnpm-lock.yaml
git commit -m "chore(deps): <description>"

# 5. Open the PR. The policy gate accepts the lockfile because a manifest
#    changed; the "Validate dependency resolution when manifests change"
#    step re-runs `pnpm install --lockfile-only --no-frozen-lockfile` to
#    confirm the lockfile is internally consistent.
```

The gate's logic lives in the `Block manual lockfile edits` step of the `policy` job in `.github/workflows/pr.yml`. The manifest match is:
`(^|/)package\.json$|^pnpm-workspace\.yaml$|^\.npmrc$|^pnpmfile\.(cjs|js|mjs)$`.

### Lockfile-only refresh (no manifest change)

A pure lockfile refresh (e.g. transitive-dependency drift with no manifest edit) is **blocked by the gate and currently has no automated path** — the auto-bot was retired (see the note above). Options:

- Pair the refresh with a real manifest change. This is the common case: you are usually refreshing *because* you changed a dependency.
- Otherwise, fold it into the next dependency-changing PR.

### Two dependency PRs racing

If two open PRs both add deps, the second to merge hits a `pnpm-lock.yaml` conflict when it rebases onto the updated base. Resolve by regenerating, not by hand-merging the lockfile:

```sh
git rebase origin/main
# take the base lockfile, then regenerate it against your manifests
git checkout origin/main -- pnpm-lock.yaml
pnpm install --no-frozen-lockfile
git add pnpm-lock.yaml
git rebase --continue
```

The `verify` job uses `--frozen-lockfile`, so the regenerated lockfile must be in sync before you push.

## 8. Verification Before Hand-off

Run this full check before claiming done:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

> **Authoritative build (FND-005 / Decision #121).** `pnpm build` is the
> repository/CI build authority. It is **network-free**: `prebuild` verifies the
> pinned checked-in snapshot inputs (`scripts/bundled-snapshots.manifest.json`)
> via `node scripts/check-bundled-snapshot-inputs.mjs` instead of fetching the
> live catalog/connector CDN, and it must leave tracked bytes unchanged. To
> intentionally refresh the bundled marketplace/connector snapshots, run the
> explicit `pnpm refresh:bundled-snapshots` (network) — it re-fetches and re-pins
> the manifest together, and is never invoked by build or test. See
> `docs/architecture/distributed-execution-delivery-policy.md`.

> Docs-only PRs (every changed file under `docs/` or a root-level `*.md` like
> README/CLAUDE/AGENTS) skip the heavy CI suite and pass via the `ci-required`
> aggregator in ~1 min. Any `.github/**` file, any nested `*.md` (e.g. runtime
> prompt assets under `server/src/onboarding-assets/`), or other code path runs
> the full suite.

## 9. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:
- Apply company access checks
- Enforce actor permissions (board vs agent)
- Write activity log entries for mutations
- Return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 10. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 11. Definition of Done

A change is done when all are true:

1. Behavior matches `CLAUDE.md` and relevant current product and architecture docs
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
