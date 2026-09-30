# TEN-001a Result — New-path tenant schema (jobs/job_attempts/leases) + repository boundary

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E2-tenant-kernel`
**Plan task:** `TEN-001 — New-path tenant schema and repository boundary (TEN-001a default split, E2-D06)`
**Implementer:** `claude-opus (implementer subagent)`
**Start SHA:** 243cc6cd2530a546b8aef8e318666b9e98669734

The Start SHA is the actual `git rev-parse HEAD` of the C:\e2 worktree captured
before the first change. It is the E2 plan commit (`243cc6cd2` — "E2 tenant-kernel
plan (a2)"); the plan §0 table lists `df509b946` as the "E2 Start SHA", which is
this commit's parent (the pre-plan-commit SHA). Per the ticket directive ("run
`git rev-parse HEAD` BEFORE your first change"), the actual current HEAD is
recorded here; `df509b946` is an ancestor of it.

## Delivered scope

- Three new-path tenant kernel schema modules under `packages/db/src/schema/`
  (house style; one table per file; `text` + `check` status, no `pgEnum`; `.js`
  local imports):
  - `jobs.ts` — `organization_id` uuid **NOT NULL, no default** (FK →
    `organizations.id` `onDelete:"restrict"`); `company_id` uuid NOT NULL (FK →
    `companies.id` restrict); `status` text NOT NULL default `'queued'` + check
    over the 7 states; `created_at`/`updated_at`. Indexes `(organization_id)` and
    `(organization_id, company_id)`.
  - `job_attempts.ts` — `organization_id` denormalized uuid NOT NULL (FK →
    organizations restrict); `job_id` uuid NOT NULL (FK → `jobs.id`
    `onDelete:"cascade"`); `attempt_number` integer NOT NULL default 1; `status`
    text NOT NULL default `'pending'` + check over the 9 states. Indexes
    `(organization_id)`, `(job_id)`.
  - `leases.ts` — `organization_id` denormalized uuid NOT NULL (FK →
    organizations restrict); `attempt_id` uuid NOT NULL (FK → `job_attempts.id`
    `onDelete:"cascade"`); `status` text NOT NULL default `'offered'` + check over
    the 5 states; `fence` text NOT NULL; `released_at` timestamptz nullable;
    `created_at`/`updated_at`. Indexes `(organization_id)`, `(attempt_id)`.
- Named barrel re-exports (`jobs`/`jobAttempts`/`leases` + their
  `$inferSelect`/`$inferInsert` type aliases) in `packages/db/src/schema/index.ts`.
- Tenant repository boundary `packages/db/src/repositories/tenant/index.ts`:
  exports **exactly** `tenantRepositories(tx: Db): TenantRepositories` (a factory)
  plus TypeScript-only types. Every accessor (`jobs`/`attempts`/`leases` with
  `insert`/`getById`/`listForCompany|listForJob|listForAttempt`) operates strictly
  through the passed `tx`. **No** standalone unscoped/raw cross-tenant reader is
  exported.
- Generated migration `0207_tenant_kernel_jobs.sql` (+ `meta/0207_snapshot.json` +
  `_journal.json` idx 207) via `drizzle-kit generate`, diffed from compiled
  `dist/schema/*.js`.
- Two tests: `tenant-kernel-schema.integration.test.ts` (embedded-PG, E2-D05
  env-hatch) and `tenant-repository-surface.test.ts` (plain unit, Windows-visible).

**Non-goals preserved:**
- **NOT** built: `workers`, `services`, `service_instances`, `job_artifacts`,
  `job_secret_handles`, or the platform null-Org operator-read policy shape (all
  TEN-001b).
- **NO** composite FK to `(jobs.organization_id, jobs.id)` on `job_attempts`; **NO**
  partial-unique "one active lease per attempt" on `leases` — both TEN-004.
- **NO** sentinel default on any new-path `organization_id` (fail-closed).
- **NO** RLS/role/GRANT/FORCE/policy/backfill DDL, non-owner pool, or GUC wiring
  (TEN-002/TEN-003). No legacy table, `assertCompanyAccess`, `rls-bootstrap.ts`, or
  `with-tenant-tx.ts` touched.
- **Caveat/credential/target impact:** N/A — E2 introduces no placement,
  credential, provider, or locality logic; CAV-005: no legacy RLS retrofit;
  provider-neutral seam untouched.

## Changed files

| File | Responsibility |
|---|---|
| `packages/db/src/schema/jobs.ts` | New `jobs` kernel table (mandatory org+company identity, status check, indexes). |
| `packages/db/src/schema/job_attempts.ts` | New `job_attempts` "run" surface (denorm org, job_id cascade FK, status check). |
| `packages/db/src/schema/leases.ts` | New `leases` table (denorm org, attempt_id cascade FK, fence, status check). |
| `packages/db/src/schema/index.ts` | Barrel re-exports for the three tables + their type aliases. |
| `packages/db/src/repositories/tenant/index.ts` | `tenantRepositories(tx)` factory — the only sanctioned reader; no raw unscoped export. |
| `packages/db/src/migrations/0207_tenant_kernel_jobs.sql` | Generated DDL; C14 `IF NOT EXISTS` added to CREATE TABLE/INDEX (mandatory idempotency guard). |
| `packages/db/src/migrations/meta/0207_snapshot.json` | Generated drizzle snapshot for 0207. |
| `packages/db/src/migrations/meta/_journal.json` | Generated journal entry (idx 207, tag `0207_tenant_kernel_jobs`). |
| `packages/db/src/__tests__/tenant-kernel-schema.integration.test.ts` | Embedded-PG proof: 3 tables exist; each `organization_id` is NOT NULL, no default. |
| `packages/db/src/__tests__/tenant-repository-surface.test.ts` | Export-surface guard: module exports exactly `tenantRepositories` (a function). |
| `docs/replatform/epics/E2-tenant-kernel/tickets/TEN-001a-result.md` | This result ledger. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| Each owned table has a non-null Organization identity (NOT NULL, no default) | `tenant-kernel-schema.integration.test.ts` asserts `information_schema.columns` `is_nullable='NO'` and `column_default IS NULL` for `organization_id` on `jobs`, `job_attempts`, `leases` — GREEN (4/4) | `pass` |
| The three kernel tables are created by the migration | Same test asserts `information_schema.tables` existence of `jobs`/`job_attempts`/`leases` after `applyPendingMigrations` — GREEN | `pass` |
| Raw unscoped repository reads are not exported (compile-time/export test) | `tenant-repository-surface.test.ts`: `Object.keys(module).sort()` === `['tenantRepositories']` and `typeof tenantRepositories === 'function'` — GREEN (2/2) | `pass` |
| No sentinel default on any new-path table | Generated `0207` emits `"organization_id" uuid NOT NULL` (no `DEFAULT`) for all three; integration test confirms `column_default IS NULL` | `pass` |
| Company-owned rows constrained to same Org by TEN-004 composite FK | Deferred to TEN-004 by design; `job_attempts` has only the plain `job_id` FK + denorm `organization_id` at TEN-001a (verified in `0207`) | `pass` (scope-correct) |
| House style / no `pgEnum` / `.js` imports / inline org FK | Modules mirror `goals.ts`/`organizations.ts`; `text`+`check` status; no shared org helper | `pass` |
| Migration is `db:generate` output (Rule #1) | `0207` produced by `drizzle-kit generate`; only the C14 `IF NOT EXISTS` idempotency guard hand-added (see Deviations) — no schema DDL hand-authored | `pass` |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm exec vitest run src/__tests__/tenant-repository-surface.test.ts` (RED) | `1` | 1 suite failed — `Cannot find module '../repositories/tenant/index.js'` (module absent). |
| `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-kernel-schema.integration.test.ts` (RED) | `1` | 4 failed — tables absent (`tableExists('jobs')` false; org column null). Correct feature-missing RED. |
| `pnpm db:generate -- --name=tenant_kernel_jobs` | `1` | `tsc` compiled dist OK; nested-pnpm leaked a stray `--` to drizzle-kit ("Unrecognized options for command 'generate': --"). See Deviations. |
| `pnpm exec drizzle-kit generate --name=tenant_kernel_jobs` (from `packages/db`) | `0` | Wrote `0207_tenant_kernel_jobs.sql` + `meta/0207_snapshot.json` + journal idx 207. |
| `pnpm --filter @armyofagents/db typecheck` | `0` | Clean (`tsc --noEmit`). |
| `pnpm --filter @armyofagents/db build` | `0` | Clean (`tsc && cp -r src/migrations dist/migrations`). |
| `pnpm exec vitest run src/__tests__/tenant-repository-surface.test.ts` (GREEN) | `0` | 2 passed. |
| `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-kernel-schema.integration.test.ts` (GREEN) | `0` | 4 passed (embedded-PG boots, applies full chain incl. 0207). |
| `pnpm exec vitest run` (full `packages/db` suite, no env) | `0` | 290 passed / 17 skipped (33 files passed, 7 integration files skipped on Windows w/o env). `migration-idempotency` passes. |
| `pnpm exec vitest run src/__tests__/tenant-kernel-schema.integration.test.ts` (skip check, no env) | `0` | 4 skipped — env-hatch skips correctly on Windows w/o the flag. |
| `pnpm --filter @armyofagents/server typecheck` | `2` | 66 **pre-existing** errors, all in the plugin subsystem (`@armyofagents/plugin-sdk` package absent + downstream implicit-any). Zero reference any TEN-001a artifact. See Findings. |

## Deviations

1. **`db:generate` invocation.** The literal `pnpm db:generate -- --name=tenant_kernel_jobs`
   failed: the root script (`pnpm --filter @armyofagents/db generate`) plus the
   package script (`tsc && drizzle-kit generate`) double-forward the `--`, leaving
   a stray `--` token that `drizzle-kit generate` rejects. The `tsc` compile half
   ran successfully; I completed generation with the exact second half of the
   package script — `pnpm exec drizzle-kit generate --name=tenant_kernel_jobs` (run
   in `packages/db`, dist already compiled). The output is identical to what
   `db:generate` produces (Rule #1 satisfied — DDL is drizzle-generated). This is a
   pnpm-forwarding quirk, not a schema/authoring deviation.
2. **C14 `IF NOT EXISTS` idempotency guard (required repo invariant).** drizzle-kit
   emits `CREATE TABLE`/`CREATE INDEX` without `IF NOT EXISTS`;
   `packages/db/src/__tests__/migration-idempotency.test.ts` **fails any new
   migration that omits it**, and CLAUDE.md Rule #1's C14 narrow exception plus the
   documented workflow require editing the generated SQL to add it before commit
   (canonical examples: 0080, 0203, 0206). I added `IF NOT EXISTS` to the three
   `CREATE TABLE` and six `CREATE INDEX` statements in `0207`, with an inline C14
   comment (matching 0206). FK `ADD CONSTRAINT` and `CHECK` statements are left
   plain, per the established convention (0206). This is the sanctioned idempotency
   guard — **not** the RLS/role/backfill hand-append the ticket scoped out (there is
   none). No data or DDL semantics changed from the `db:generate` output.

## Findings

`None` blocking. Informational: `pnpm --filter @armyofagents/server typecheck`
reports 66 pre-existing errors, entirely in the plugin subsystem
(`server/src/services/plugin-host-services.ts`, `routes/plugins.ts`,
`plugin-worker-manager.ts`, `plugin-tool-registry.ts`, `plugin-tool-dispatcher.ts`,
`plugin-event-bus.ts`, `mcp/tools/plugin-broker-tools.ts`, `app.ts`) stemming from
the `@armyofagents/plugin-sdk` workspace package being absent in this worktree
(`packages/plugin-sdk` does not exist) plus downstream `TS7006` implicit-any. None
reference `jobs`/`job_attempts`/`leases`/`tenant`/`repositories`/`@armyofagents/db`
(grep-confirmed zero matches). This is a DEC-03 pre-existing-failure baseline
condition, independent of TEN-001a; the additive db change introduces no new server
errors.

## Follow-up tickets

`None` new. Downstream (already planned): TEN-004 adds the composite FKs
(`(organization_id, company_id) → companies`, attempt↔job, lease↔attempt) + the
`leases` partial-unique; TEN-002/TEN-003 add RLS/role/GUC/non-owner pool; TEN-001b
adds the remaining five tables + platform null-Org operator-read policy.

## Gate recommendation

`ready for independent review` — RED→GREEN captured for both tests; migration is
`db:generate` output with only the mandatory C14 idempotency guard; db
typecheck/build clean; full `packages/db` suite green; server typecheck failures
are pre-existing and unrelated (plugin subsystem). Reviewer should scrutinize: (a)
the C14 `IF NOT EXISTS` edit vs. the ticket's "no hand-append" wording (reconciled
above); (b) the Start SHA choice (actual HEAD `243cc6cd2` vs. plan's `df509b946`
ancestor); (c) confirm the 66 server errors are pre-existing on a clean baseline.

## Independent review

**Reviewer:** `TEN-001a independent reviewer subagent (Claude) — distinct from the implementer (claude-opus implementer subagent)`
**Reviewed revision:** `b5a9e8178c4bcc3fb0c72b564a858b06fad1ddc0`
**Disposition:** `approved`
**Review evidence:**

Reviewed at HEAD `b5a9e8178c4bcc3fb0c72b564a858b06fad1ddc0` (working tree clean —
`git status --porcelain` empty). The TEN-001a code is byte-identical to the impl
commit `34c26e21`; HEAD adds only E2 plan/findings docs (verified: `git show
--stat b5a9e8178` = `findings.md` + `implementation-plan.md` only). Start SHA
`243cc6cd2530a546b8aef8e318666b9e98669734` re-verified as a valid bare 40-hex
ancestor of HEAD (`git merge-base --is-ancestor` → true).

Focused acceptance re-run on the reviewed revision (Git Bash, `C:\e2`):

| Command | Exit | Result |
|---|---:|---|
| `pnpm --filter @armyofagents/db typecheck` | `0` | clean (`tsc --noEmit`). |
| `pnpm --filter @armyofagents/db build` | `0` | clean (`tsc && cp -r src/migrations`). |
| `pnpm exec vitest run src/__tests__/tenant-repository-surface.test.ts` | `0` | 2 passed. |
| `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run …/tenant-kernel-schema.integration.test.ts` | `0` | 4 passed (embedded-PG boots; full chain incl. 0207 applies). |
| `pnpm exec vitest run …/tenant-kernel-schema.integration.test.ts` (no flag) | `0` | 4 **skipped** (env-hatch fails-closed; not silently green-but-run). |
| `pnpm --filter @armyofagents/server typecheck 2>&1 \| grep -iE "jobs\|attempt\|lease\|tenant\|repositories"` | — | `none` (E2-F009 plugin-sdk baseline unrelated to TEN-001a). |

Verification (file:line evidence):
- **Schema scope.** `jobs.ts`/`job_attempts.ts`/`leases.ts` mirror `goals.ts` house
  style (`text`+`check`, no `pgEnum`, `.js` imports, inline org FK). `organization_id`
  is `uuid NOT NULL` with **no `.default()`** on all three (`jobs.ts:16-18`,
  `job_attempts.ts:16-18`, `leases.ts:16-18`); the only `.default()` calls are on
  `status`/`attempt_number` (grep-confirmed). `company_id` NOT NULL on `jobs`
  (`jobs.ts:19-21`). FKs: org `restrict`, company `restrict`, `job_id` `cascade`,
  `attempt_id` `cascade`. Status checks match the specified sets — jobs 7 states,
  job_attempts 9, leases 5. **NO composite FK and NO `leases` partial-unique** present
  (correctly DEFERRED to TEN-004; the `leases.ts:11` `uniqueIndex` token is a comment).
- **Migration `0207_tenant_kernel_jobs.sql`.** Pure `drizzle-kit generate` output plus
  ONLY the sanctioned C14 `IF NOT EXISTS` guard on the 3 CREATE TABLE + 6 CREATE INDEX
  (`:6,:17,:27,:45-50`); FK `ADD CONSTRAINT` + inline `CHECK` left plain (0206
  convention). No RLS/role/GRANT/policy/backfill (grep clean — the sole "force" hit is
  the substring in "enforced"). Integration test asserts `is_nullable='NO'` **AND**
  `column_default IS NULL` (`:156-157,:164-165,:172-173`). `_journal.json` idx 207 =
  `0207_tenant_kernel_jobs` (contiguous after 0206); `0207_snapshot.json` carries
  `public.jobs`/`public.job_attempts`/`public.leases` each with `organization_id`
  `notNull:true` and no `default` key.
- **Repository boundary.** `repositories/tenant/index.ts` exports exactly
  `{ tenantRepositories }` (a factory) + erased TS types; every accessor runs only
  through the passed `tx` (`:52-98`); no standalone unscoped/raw cross-tenant reader.
  Surface test asserts the exact key set `Object.keys(module).sort() ===
  ["tenantRepositories"]` (`:22`), not a weaker check.
- **Tests honest.** Integration boots embedded-PG in `beforeAll` with
  `initdbFlags:["--encoding=UTF8","--locale=C"]`, captures `setupError`, re-throws in
  the first `it` (fail-closed; `:93-122,:146`); gated by
  `describe.skipIf(process.platform === "win32" && …!== "1")` (`:142`) — the sanctioned
  form, not the banned `X ? describe : describe.skip` ternary (negative control in
  `server/src/__tests__/integration-test-hygiene.test.ts:53`). GREEN counts match the
  ledger (2/2, 4/4). RED evidence (module-missing for surface; tables-absent for
  integration) is a genuine feature-missing failure consistent with test design.
- **Rule #1 / CAV-005.** Impl commit `34c26e21` touched exactly 11 files; no legacy
  table, `assertCompanyAccess`, `rls-bootstrap.ts`, or `with-tenant-tx.ts` touched; no
  manifest/`pnpm-lock.yaml` change (no new runtime dependency).
- **Flagged items acceptable.** (a) C14 `IF NOT EXISTS` guard — sanctioned, enforced by
  `migration-idempotency.test.ts` (checks only CREATE TABLE/INDEX, so plain FK
  `ADD CONSTRAINT` is correct). (b) `db:generate -- --name=` quirk — cosmetic; output
  identical (Rule #1 satisfied). (c) plugin-sdk-absent server typecheck failure — E2-F009
  DEC-03 baseline; zero errors reference TEN-001a artifacts (grep → `none`).

No new findings. No scope errors. All focused acceptance passes on the reviewed
revision.

For `approved`, verify the result describes the reviewed revision, all focused acceptance evidence passes, and every accepted finding is resolved; then change the top-level `Status` to `complete` and commit this disposition separately. Otherwise leave `Status` as `gate_review` or set `blocked`, and link stable findings.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
<!-- First independent reviewer appends attempt 1. -->
| 1 | TEN-001a independent reviewer subagent (Claude) | `b5a9e8178c4bcc3fb0c72b564a858b06fad1ddc0` | `approved` | Focused acceptance re-run GREEN (db typecheck 0, build 0, surface 2/2, integration 4/4 with flag, 4 skipped without flag); schema/migration/repo-boundary/tests verified with file:line evidence; no composite FK / no partial-unique (correctly deferred to TEN-004); no forbidden files touched; server typecheck refs to TEN-001a = none (E2-F009 baseline). No new findings. |
