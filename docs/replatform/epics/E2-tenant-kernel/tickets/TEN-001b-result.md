# TEN-001b Result — New-path tenant schema (workers/services/service_instances/job_artifacts/job_secret_handles) + repository extension

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E2-tenant-kernel`
**Plan task:** `TEN-001 — New-path tenant schema and repository boundary (TEN-001b default split, E2-D06)`
**Implementer:** `claude-opus (implementer subagent)`
**Start SHA:** 629439c71f452202fd8541077b6dd856fa756d96

The Start SHA is the actual `git rev-parse HEAD` of the C:\e2 worktree captured
before the first change (`629439c71` — "docs(e2): TEN-001a reviewed + approved
(complete)"). The plan §0 table lists `df509b946` as the "E2 Start SHA"; that
commit is an ancestor of this HEAD (`git merge-base --is-ancestor df509b946 HEAD`
= true). Per the ticket directive ("run `git rev-parse HEAD` BEFORE your first
change"), the actual current HEAD is recorded here — mirroring the TEN-001a
convention.

## Delivered scope

- Five new-path tenant kernel schema modules under `packages/db/src/schema/`
  (house style; one table per file; `id: uuid().primaryKey().defaultRandom()`;
  timestamps `withTimezone:true` + `.defaultNow().notNull()`; `text` + `check`
  status, **no** `pgEnum`; `.js` local imports):
  - `workers.ts` — `scope` text NOT NULL + check `('platform','organization','owner')`;
    `organization_id` uuid **NULLABLE** (FK → `organizations.id` `onDelete:"restrict"`;
    NULL only for `platform`); `owner_user_id` uuid NULLABLE (**no FK** — reserved
    for JOB-002 owner binding); `label` text NOT NULL; `status` text NOT NULL
    default `'enrolled'` + check `('enrolled','active','draining','revoked')`;
    timestamps. **`workers_scope_org_check`** =
    `(scope='platform' AND organization_id IS NULL) OR (scope IN ('organization','owner') AND organization_id IS NOT NULL)`.
    Index `(organization_id)`.
  - `services.ts` — `organization_id` uuid **NOT NULL, no default** (FK → orgs
    restrict); `company_id` uuid NOT NULL (FK → `companies.id` restrict);
    `desired_state` text NOT NULL default `'running'` + check
    `('running','stopped','deleted')`; `generation` integer NOT NULL default 1;
    timestamps. Indexes `(organization_id)`, `(organization_id, company_id)`.
  - `service_instances.ts` — `organization_id` denorm uuid NOT NULL (FK → orgs
    restrict); `service_id` uuid NOT NULL (FK → `services.id`
    `onDelete:"cascade"`); `generation` integer NOT NULL default 1; `status` text
    NOT NULL default `'pending'` + check
    `('pending','healthy','stopped','lost','interrupted')`; timestamps. Indexes
    `(organization_id)`, `(service_id)`.
  - `job_artifacts.ts` — `organization_id` denorm uuid NOT NULL (FK → orgs
    restrict); `job_id` uuid NOT NULL (FK → `jobs.id` `onDelete:"cascade"`);
    `identifier` text NOT NULL; timestamps. Indexes `(organization_id)`, `(job_id)`.
  - `job_secret_handles.ts` — `organization_id` denorm uuid NOT NULL (FK → orgs
    restrict); `job_id` uuid NOT NULL (FK → `jobs.id` `onDelete:"cascade"`);
    `handle` text NOT NULL; timestamps. Indexes `(organization_id)`, `(job_id)`.
- Named barrel re-exports (`workers`/`services`/`serviceInstances`/`jobArtifacts`/
  `jobSecretHandles` + their `$inferSelect`/`$inferInsert` type aliases) in
  `packages/db/src/schema/index.ts`.
- Tenant repository extension `packages/db/src/repositories/tenant/index.ts`:
  `TenantRepositories` gains `workers`/`services`/`serviceInstances`/`jobArtifacts`/
  `jobSecretHandles` accessors (`insert`/`getById`/`listForOrganization|listForCompany|listForService|listForJob`),
  each operating strictly through the passed `tx`. The module's top-level runtime
  export set stays **exactly** `{ tenantRepositories }` (+ erased types); **no**
  new standalone unscoped/raw cross-tenant reader.
- Generated migration `0208_tenant_kernel_services.sql` (+ `meta/0208_snapshot.json`
  + `_journal.json` idx 208) via `drizzle-kit generate --name=tenant_kernel_services`,
  diffed from compiled `dist/schema/*.js`; C14 `IF NOT EXISTS` hand-added to every
  `CREATE TABLE`/`CREATE INDEX` (header comment matching 0207); `ADD CONSTRAINT`
  left plain (0206/0207 convention).
- New integration test `tenant-kernel-schema-b.integration.test.ts` (embedded-PG,
  E2-D05 env-hatch); one added assertion in `tenant-repository-surface.test.ts`
  (factory-shape guard, plain unit, Windows-visible).

**Non-goals preserved:**
- **NO** RLS/role/GRANT/FORCE/policy DDL, non-owner pool, GUC wiring, or the
  platform null-Org operator-read *policy* (TEN-002). This ticket lays only the
  `workers` table + the `workers_scope_org_check` shape and proves (via direct SQL)
  that platform rows are null-Org and tenant-scoped rows are non-null-Org.
- **NO** composite FK (job↔attempt, service↔instance, artifact↔job,
  secret-handle↔job, service↔company↔org, worker↔org) and **NO** partial-unique
  (TEN-004).
- **NO** sentinel default on any new-path `organization_id` (fail-closed).
- No legacy table, `assertCompanyAccess`, `rls-bootstrap.ts`, or `with-tenant-tx.ts`
  touched. No TEN-001a committed file modified except the two sanctioned extension
  points (`schema/index.ts`, `repositories/tenant/index.ts`) and the surface test.

## Changed files

| File | Responsibility |
|---|---|
| `packages/db/src/schema/workers.ts` | New: worker registration identity; `platform\|organization\|owner` scope; `workers_scope_org_check`. |
| `packages/db/src/schema/services.ts` | New: service desired-state row; mandatory org+company identity. |
| `packages/db/src/schema/service_instances.ts` | New: service instance + generation; denorm org, cascade from service. |
| `packages/db/src/schema/job_artifacts.ts` | New: minimal artifact-ownership index (E5 extends). |
| `packages/db/src/schema/job_secret_handles.ts` | New: minimal opaque secret-handle ownership (E5 extends). |
| `packages/db/src/schema/index.ts` | Add named re-exports for the five modules. |
| `packages/db/src/repositories/tenant/index.ts` | Extend `TenantRepositories` + factory with five accessors; top-level export set unchanged. |
| `packages/db/src/migrations/0208_tenant_kernel_services.sql` | New generated migration + C14 `IF NOT EXISTS` guards. |
| `packages/db/src/migrations/meta/0208_snapshot.json` | New drizzle snapshot. |
| `packages/db/src/migrations/meta/_journal.json` | Journal idx 208 appended. |
| `packages/db/src/__tests__/tenant-kernel-schema-b.integration.test.ts` | New: embedded-PG proof (existence, org-col nullability/default, scope/org check). |
| `packages/db/src/__tests__/tenant-repository-surface.test.ts` | Add factory-shape assertion for the five new accessors. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| All five tables exist after full migration chain | `tenant-kernel-schema-b.integration.test.ts` "creates the five remaining new-path kernel tables" | `pass` |
| `services`/`service_instances`/`job_artifacts`/`job_secret_handles` `organization_id` = NOT NULL, no default (fail-closed, no sentinel) | Four `is_nullable='NO'` + `column_default IS NULL` assertions | `pass` |
| `workers.organization_id` is nullable | "makes workers.organization_id NULLABLE" (`is_nullable='YES'`) | `pass` |
| `workers_scope_org_check` enforces platform⇒null-org, organization⇒non-null-org via direct SQL (real org seeded so FK passes and only the CHECK fires) | Insert `platform`+null org succeeds; `platform`+non-null org rejected `/workers_scope_org_check/`; `organization`+null org rejected `/workers_scope_org_check/` | `pass` |
| Repository top-level export set unchanged (`['tenantRepositories']`) | `tenant-repository-surface.test.ts` assertion 1 | `pass` |
| Factory returns all eight accessor groups w/ `insert`/`getById` | `tenant-repository-surface.test.ts` factory-shape assertion | `pass` |
| Migration 0208 C14-idempotent (every CREATE has IF NOT EXISTS) | `migration-idempotency.test.ts` (5 tests) | `pass` |
| No new hosted-API/runtime dep; no manifest/lock change | `git status` shows no `package.json`/`pnpm-lock.yaml` change | `pass` |
| No E2 file in server typecheck errors (E2-F009 baseline holds) | server typecheck = 66 errors, all `plugin-*`/plugin-sdk; grep for TEN-001b files = none | `pass` |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm --filter @armyofagents/db typecheck` | `0` | clean (`tsc --noEmit`) |
| `pnpm --filter @armyofagents/db build` | `0` | `tsc && cp -r src/migrations dist/migrations` |
| `pnpm exec drizzle-kit generate --name=tenant_kernel_services` | `0` | emitted `0208_tenant_kernel_services.sql` + snapshot + journal idx 208 |
| `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-kernel-schema-b.integration.test.ts` (RED, pre-impl) | `1` | 7 failed (tables absent — `relation "workers" does not exist`) |
| `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-kernel-schema-b.integration.test.ts` (GREEN) | `0` | 7 passed |
| `pnpm exec vitest run src/__tests__/tenant-repository-surface.test.ts` | `0` | 3 passed |
| `pnpm exec vitest run src/__tests__/migration-idempotency.test.ts` | `0` | 5 passed |
| `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-kernel-schema.integration.test.ts` (TEN-001a sibling regression) | `0` | 4 passed (0208 in chain does not break TEN-001a) |
| `pnpm --filter @armyofagents/server typecheck` | `2` | 66 errors, ALL pre-existing plugin-sdk baseline (E2-F009); zero reference any TEN-001b file |

## Deviations

None. Scope, table shapes, constraints, indexes, migration invocation, and the
C14 guard follow the plan §1/§2 + the TEN-001b directive and E2-D06 exactly.

## Findings

`E2-F009` (pre-existing plugin-sdk absence → server typecheck/build exit 2) observed
and re-confirmed unchanged: 66 errors, all in `plugin-*`/plugin-sdk-dependent files;
zero reference any E2 file. DEC-03-waivable per the finding disposition; not an
epic-touched defect. No new findings.

## Follow-up tickets

None. TEN-004 (composite FKs + partial-unique) and TEN-002 (RLS/policy incl. the
platform null-Org operator-read policy) consume these tables as already-planned
successors, not follow-ups from this ticket.

## Gate recommendation

`ready for independent review` — all focused acceptance passes (RED→GREEN captured),
no non-goal crossed, C14 idempotency + repository export-surface invariants hold,
and the server-typecheck delta is subset-of-baseline (E2-F009).

## Independent review

**Reviewer:** `claude-opus (independent reviewer subagent) — distinct from the implementer subagent`
**Reviewed revision:** `f9b37cd98e195e57f65eeb9d04f330b933b0dc74`
**Disposition:** `approved`
**Review evidence:**

Read-only inspection of the reviewed revision (`git rev-parse HEAD` = `f9b37cd98e195e57f65eeb9d04f330b933b0dc74`, an ancestor of HEAD; `git status --porcelain` clean before the disposition edit). Diff `629439c71..HEAD` touches only the 13 sanctioned files (5 new schema modules, `schema/index.ts`, `repositories/tenant/index.ts`, `0208_*.sql` + `meta/0208_snapshot.json` + `meta/_journal.json`, the two tests, the result ledger) — all additive, no manifest/lock change, no legacy table / `assertCompanyAccess` / `rls-bootstrap.ts` / `with-tenant-tx.ts` touched.

Re-run acceptance (Git Bash, C:\e2):
- `pnpm --filter @armyofagents/db typecheck` → `0`.
- `pnpm --filter @armyofagents/db build` → `0`.
- `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-kernel-schema-b.integration.test.ts` → `0` (7 passed).
- `pnpm exec vitest run src/__tests__/tenant-repository-surface.test.ts` → `0` (3 passed).
- `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-kernel-schema.integration.test.ts` (TEN-001a sibling) → `0` (4 passed — 0208 in chain does not regress TEN-001a).
- `pnpm exec vitest run src/__tests__/migration-idempotency.test.ts` → `0` (5 passed).
- Env-hatch: `pnpm exec vitest run src/__tests__/tenant-kernel-schema-b.integration.test.ts` WITHOUT the flag → `0` (7 skipped) — confirms the E2-D05 hatch.
- `pnpm --filter @armyofagents/server typecheck` → exit `2`, 66 errors, ALL in the plugin subsystem (`plugin-event-bus`/`plugin-host-services`/`plugin-tool-dispatcher`/`plugin-tool-registry`/`plugin-worker-manager`/`routes/plugins.ts`) from the absent `@armyofagents/plugin-sdk`; zero reference any E2 file (`packages/db`/`schema/workers|services|service_instances|job_artifacts|job_secret_handles`/`repositories/tenant`) — E2-F009 baseline holds unchanged.

Per-item verification (file:line):
1. Five modules mirror TEN-001a house style (cf. `schema/jobs.ts`): `text`+`check` (no `pgEnum`), `.js` imports, `uuid().primaryKey().defaultRandom()`, `withTimezone` timestamps. Shapes match plan §1: `services`/`service_instances`/`job_artifacts`/`job_secret_handles` `organization_id` NOT NULL, no default; `workers.ts:24-26` org nullable + `workers.ts:43-46` `workers_scope_org_check` = `(scope='platform' AND organization_id IS NULL) OR (scope IN ('organization','owner') AND organization_id IS NOT NULL)`; `workers.ts:27` `owner_user_id` present with NO `.references()` (JOB-002 reserve). Status/desired_state/scope check sets match. FKs: org `restrict` everywhere; `service_id`/`job_id` `cascade` (`services.ts:19,22`, `service_instances.ts:19,22`, `job_artifacts.ts:19,22`, `job_secret_handles.ts:20,23`).
2. NO composite FK / partial-unique / RLS/policy anywhere in the five modules, migration, or repo (grep for `foreignKey|uniqueIndex|.unique(|policy|row level|force|grant|create role|rls|bypassrls` → only comment references). Absence is correct (TEN-004/TEN-002).
3. `0208_tenant_kernel_services.sql` = pure `drizzle-kit generate` output + C14 `IF NOT EXISTS` on every CREATE TABLE/INDEX; CHECK inline in CREATE TABLE, FK `ADD CONSTRAINT` plain — identical convention to `0207` (header comment lists `0203/0206/0207`). No RLS/role/GRANT/backfill. `meta/_journal.json` idx 208 tag `0208_tenant_kernel_services`; `meta/0208_snapshot.json` contains the 5 tables, all 185 tables `isRLSEnabled:false`, all `policies:{}` empty.
4. `tenant-kernel-schema-b.integration.test.ts:198-226` seeds a REAL `organizations` row, then asserts: `platform`+null-org insert succeeds; `platform`+non-null-org rejected `/workers_scope_org_check/`; `organization`+null-org rejected `/workers_scope_org_check/`. Postgres DETAIL in the run log confirms both rejections fire on `workers_scope_org_check` (not the FK). Org-NOT-NULL assertions (`:159-189`) check `is_nullable='NO'` AND `column_default IS NULL`; workers nullability (`:191-196`) checks `is_nullable='YES'`.
5. `repositories/tenant/index.ts` exposes 8 accessor groups on `TenantRepositories` (`:81-90`), every method through `tx`; top-level runtime export set stays exactly `{ tenantRepositories }`. Surface test `:22-24` asserts `Object.keys(...).sort() === ['tenantRepositories']` (core export-set assertion intact + meaningful); `:35-51` factory-shape assertion covers all 8 groups with `insert`/`getById`.
6. Hygiene: new integration test boots embedded-PG in `beforeAll` with `initdbFlags` UTF8/C, captures `setupError`, re-throws in each `it`; uses `describe.skipIf(...)` (`:147`), not the banned `X ? describe : describe.skip` ternary. No manifest/lock change.
7. Ledger: bare 40-hex Start SHA (`629439c71…`), accurate evidence table, review block now filled.
8. E2-F009 baseline confirmed `none` for actual E2 files (the ticket's suggested `grep` also matches the `src/services/` path prefix; refined grep against E2 file basenames returns zero).

Adversarial probes: (a) forced the no-flag path → correctly skipped (hatch not vacuous-on). (b) Confirmed the workers CHECK rejects with a real org seeded so the FK cannot mask it (DETAIL shows `workers_scope_org_check`, non-null org present in the failing row). (c) Verified snapshot carries no non-empty `policies`/`isRLSEnabled:true` (no smuggled RLS). (d) Verified the repo diff is purely additive (no TEN-001a accessor rewritten). No scope error, no unresolved finding.

Disposition: `approved`. Set top-level `Status: complete`.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | `claude-opus (independent reviewer subagent)` | `f9b37cd98e195e57f65eeb9d04f330b933b0dc74` | `approved` | Re-run: db typecheck 0, db build 0, schema-b integ 7 pass (flag), surface 3 pass, TEN-001a sibling 4 pass (flag), idempotency 5 pass, no-flag → 7 skipped, server typecheck 66 errors all plugin-sdk (E2-F009), zero E2 files. All 8 verify items pass; no scope error; no new finding. → `Status: complete`. |
<!-- Subsequent reviewers append attempt N (keep this guidance row). -->
