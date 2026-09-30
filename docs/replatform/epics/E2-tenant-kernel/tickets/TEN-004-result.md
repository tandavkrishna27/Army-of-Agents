# TEN-004 Result — Composite tenant integrity constraints

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E2-tenant-kernel`
**Plan task:** `TEN-004 — Composite tenant integrity constraints (M)`
**Implementer:** `claude-opus (implementer subagent)`
**Start SHA:** 944761515ece9b5c70677c345ba1a844a958ae82

The Start SHA is the actual `git rev-parse HEAD` of the C:\e2 worktree captured
before the first change. The plan §0 table lists `df509b946` as the "E2 Start
SHA"; that commit is an ancestor of this HEAD. Per the ticket directive
("run `git rev-parse HEAD` BEFORE your first change"), the actual current HEAD is
recorded here — mirroring the TEN-001a/b convention.

## Delivered scope

- **Parent FK-target composite uniques** (a composite FK requires a UNIQUE on
  EXACTLY the referenced column set — a PK on `id` alone is insufficient), added
  in the 2nd-arg table-extras callback via `unique(...)` from `drizzle-orm/pg-core`:
  - `jobs.ts` → `unique("jobs_org_id_uq").on(organizationId, id)`
  - `job_attempts.ts` → `unique("job_attempts_org_id_uq").on(organizationId, id)`
  - `services.ts` → `unique("services_org_id_uq").on(organizationId, id)`
  - `workers.ts` → `unique("workers_org_id_uq").on(organizationId, id)` (org
    nullable; `id` PK keeps the pair unique; platform null-org workers coexist)
  - `companies.ts` (**LEGACY table, additive-only, CAV-005-safe**) →
    `unique("companies_org_id_uq").on(organizationId, id)`
- **Composite organization-scoped foreign keys** (child → parent, first
  `foreignKey()` use in the repo), added in the 2nd-arg callback; the pre-existing
  single-column FKs are kept (redundant but harmless):
  - `job_attempts` → `job_attempts_org_job_fk` `(organization_id, job_id) →
    jobs(organization_id, id)`
  - `leases` → `leases_org_attempt_fk` `(organization_id, attempt_id) →
    job_attempts(organization_id, id)`
  - `jobs` → `jobs_org_company_fk` `(organization_id, company_id) →
    companies(organization_id, id)`
  - `services` → `services_org_company_fk` `(organization_id, company_id) →
    companies(organization_id, id)`
  - `service_instances` → `service_instances_org_service_fk` `(organization_id,
    service_id) → services(organization_id, id)`
  - `job_artifacts` → `job_artifacts_org_job_fk` `(organization_id, job_id) →
    jobs(organization_id, id)`
  - `job_secret_handles` → `job_secret_handles_org_job_fk` `(organization_id,
    job_id) → jobs(organization_id, id)`
- **Leases partial-unique** ("at most one live lease per attempt"):
  `uniqueIndex("leases_active_per_attempt_idx").on(attemptId).where(sql`status in
  ('offered', 'active')`)` — a partial unique INDEX (Postgres has no partial
  unique CONSTRAINT; `unique()` cannot express `where`). A
  released/expired/revoked lease leaves the index so the attempt can be re-leased.
- Generated migration `0209_tenant_composite_integrity.sql` (+
  `meta/0209_snapshot.json` + `_journal.json` idx 209) via `drizzle-kit generate
  --name=tenant_composite_integrity`, diffed from compiled `dist/schema/*.js`.
  Two post-generation hand-edits (Rule #1 / C14 — no DDL text changed): (1) the
  five FK-target UNIQUE `ADD CONSTRAINT`s reordered AHEAD of the seven composite
  FK `ADD CONSTRAINT`s so the referenced uniques exist before the FKs (drizzle-kit
  emitted them in the reverse, non-applicable order — 42830); (2) C14
  `IF NOT EXISTS` added to the one `CREATE UNIQUE INDEX`. `ADD CONSTRAINT` left
  plain (0207/0208 convention; not scanned by `migration-idempotency.test.ts`).
- New integration test `tenant-composite-integrity.integration.test.ts`
  (embedded-PG, E2-D05 env-hatch): seeds two real organizations + a real company
  in each, then via **direct SQL** proves every composite relationship rejects the
  mixed-tenant insert (asserting the constraint name) and accepts the same-tenant
  positive control.

**Non-goals preserved:**
- **NO** RLS/role/GRANT/FORCE/policy DDL, non-owner pool, or GUC wiring (TEN-002).
- **NO** legacy-table change beyond the single additive `companies_org_id_uq`
  unique (CAV-005): no RLS, no other `companies` column/behavior touched; the
  sentinel `organization_id` default is untouched (that drop is TEN-006).
- `assertCompanyAccess`, `rls-bootstrap.ts`, `with-tenant-tx.ts` not touched.
- No new runtime dependency; no `package.json`/`pnpm-lock.yaml` change.

## Changed files

| File | Responsibility |
|---|---|
| `packages/db/src/schema/jobs.ts` | Add `jobs_org_id_uq` (FK target) + `jobs_org_company_fk` composite FK → companies. |
| `packages/db/src/schema/job_attempts.ts` | Add `job_attempts_org_id_uq` (FK target) + `job_attempts_org_job_fk` composite FK → jobs. |
| `packages/db/src/schema/leases.ts` | Add `leases_org_attempt_fk` composite FK → job_attempts + `leases_active_per_attempt_idx` partial unique. |
| `packages/db/src/schema/services.ts` | Add `services_org_id_uq` (FK target) + `services_org_company_fk` composite FK → companies. |
| `packages/db/src/schema/service_instances.ts` | Add `service_instances_org_service_fk` composite FK → services. |
| `packages/db/src/schema/workers.ts` | Add `workers_org_id_uq` (FK target for future E3 children). |
| `packages/db/src/schema/job_artifacts.ts` | Add `job_artifacts_org_job_fk` composite FK → jobs. |
| `packages/db/src/schema/job_secret_handles.ts` | Add `job_secret_handles_org_job_fk` composite FK → jobs. |
| `packages/db/src/schema/companies.ts` | **Legacy, additive only:** add `companies_org_id_uq` unique (FK target for jobs/services composite FKs). CAV-005-safe. |
| `packages/db/src/migrations/0209_tenant_composite_integrity.sql` | New generated migration; UNIQUEs reordered before FKs; C14 `IF NOT EXISTS` on the partial index. |
| `packages/db/src/migrations/meta/0209_snapshot.json` | New drizzle snapshot. |
| `packages/db/src/migrations/meta/_journal.json` | Journal idx 209 appended. |
| `packages/db/src/__tests__/tenant-composite-integrity.integration.test.ts` | New: embedded-PG direct-SQL mixed-tenant rejection proof (8 composites + partial-unique, each with a positive control). |

## Acceptance evidence

Direct SQL (bypassing app checks) cannot construct a mixed-tenant relationship —
proved for EVERY composite relationship (each row = its negative test + a
same-tenant positive control), plus the partial-unique. Postgres server log lines
in the GREEN run confirm each rejection fires on the intended constraint.

| Acceptance condition (composite relationship) | Evidence (test case) | Result |
|---|---|---|
| job↔company↔org: `(org=A, company=B-owned)` rejected by `jobs_org_company_fk`; `(org=A, A's company)` ok | test case 1 (`err.code=23503`, `constraint_name=jobs_org_company_fk`) | `pass` |
| attempt↔job: attempt `(org=B, A's job)` rejected by `job_attempts_org_job_fk`; `(org=A, A's job)` ok | test case 2 | `pass` |
| lease↔attempt: lease `(org=B, A's attempt)` rejected by `leases_org_attempt_fk`; `(org=A, A's attempt)` ok | test case 3 | `pass` |
| service↔company↔org: service `(org=A, B-owned company)` rejected by `services_org_company_fk`; `(org=A, A's company)` ok | test case 4 | `pass` |
| service_instance↔service: instance `(org=B, A's service)` rejected by `service_instances_org_service_fk`; `(org=A, A's service)` ok | test case 5 | `pass` |
| artifact↔job: artifact `(org=B, A's job)` rejected by `job_artifacts_org_job_fk`; `(org=A, A's job)` ok | test case 6 | `pass` |
| secret_handle↔job: handle `(org=B, A's job)` rejected by `job_secret_handles_org_job_fk`; `(org=A, A's job)` ok | test case 7 | `pass` |
| leases partial-unique: 2nd `active` lease on one attempt rejected by `leases_active_per_attempt_idx` (`23505`); released + fresh active on same attempt allowed | test case 8 | `pass` |
| FK-target uniques exist (jobs/job_attempts/services/workers/companies `org_id_uq`) | migration applies + composite FKs resolve (else 42830 at apply → beforeAll fails) | `pass` |
| Migration 0209 C14-idempotent (`CREATE UNIQUE INDEX` has `IF NOT EXISTS`) | `migration-idempotency.test.ts` (5 tests) | `pass` |
| TEN-001a/b integration suites still pass with 0209 in the chain (no regression) | `tenant-kernel-schema.integration.test.ts` (4) + `-b` (7) with flag | `pass` |
| No new dep; no manifest/lock change; `companies` change additive-only | `git status` (no `package.json`/`pnpm-lock.yaml`); companies diff = one `unique(...)` line + import | `pass` |
| No E2 file in server typecheck errors (E2-F009 baseline holds) | `pnpm --filter server typecheck` errors all `plugin-*`/plugin-sdk; grep for E2 files = none | `pass` |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm --filter @armyofagents/db typecheck` | `0` | clean (`tsc --noEmit`) |
| `pnpm --filter @armyofagents/db build` | `0` | `tsc && cp -r src/migrations dist/migrations` |
| `pnpm exec drizzle-kit generate --name=tenant_composite_integrity` | `0` | emitted `0209_tenant_composite_integrity.sql` + snapshot + journal idx 209 |
| `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-composite-integrity.integration.test.ts` (RED, pre-impl) | `1` | 8 failed / 1 passed — mixed-tenant inserts + 2nd active lease all SUCCEEDED (no constraints yet) |
| `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-composite-integrity.integration.test.ts` (GREEN) | `0` | 9 passed; PG log confirms each rejection cites its composite constraint |
| `pnpm exec vitest run src/__tests__/migration-idempotency.test.ts src/__tests__/migration-journal-contiguity.test.ts src/__tests__/migration-snapshot-gate.test.ts src/__tests__/migration-cli-snapshot-gate.test.ts` | `0` | 42 passed |
| `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-kernel-schema.integration.test.ts src/__tests__/tenant-kernel-schema-b.integration.test.ts` | `0` | 11 passed (0209 in chain does not regress TEN-001a/b) |
| `pnpm exec vitest run` (full db suite, no flag) | `0` | 292 passed / 33 skipped (integration suites skip without the hatch — composite test = 9 skipped) |
| `pnpm --filter @armyofagents/server typecheck` | `2` | errors all in the plugin subsystem (absent `@armyofagents/plugin-sdk`, E2-F009); zero reference any E2 file |

## Deviations

Two, both approved by the plan/decisions and DDL-text-preserving:

1. **`companies` additive unique** — `companies_org_id_uq` on `(organization_id,
   id)` added to the legacy `companies` table's existing 2nd-arg callback. This is
   the CAV-005-safe additive index the TEN-004 ticket + E2-D06 explicitly call for
   (it is the FK target for `jobs_org_company_fk` / `services_org_company_fk`). No
   RLS, no other `companies` column or behavior changed; the sentinel
   `organization_id` default is deliberately left in place (TEN-006 owns the drop).

2. **Migration statement reorder** — `drizzle-kit generate` emitted the seven
   composite FK `ADD CONSTRAINT`s BEFORE the five FK-target UNIQUE `ADD
   CONSTRAINT`s. Postgres requires the referenced `(organization_id, id)` UNIQUE to
   exist before a FK can reference it (else `42830 "no unique constraint matching
   given keys"`), so the migration would not apply as generated. The five UNIQUE
   ADDs were moved ahead of the seven FK ADDs; statement text is otherwise verbatim
   drizzle-kit output. Documented with an inline header comment in the migration.
   No `DO $$` guard was needed: `migration-idempotency.test.ts` scans only
   `CREATE TABLE/INDEX` (the one `CREATE UNIQUE INDEX` carries `IF NOT EXISTS`); it
   does not flag `ADD CONSTRAINT`, which follows the plain 0207/0208 convention, so
   the conditional 0195 `DO $$ … duplicate_object` guard was not triggered.

## Findings

`E2-F009` (pre-existing plugin-sdk absence → server typecheck/build exit 2)
observed and re-confirmed unchanged: all errors in `plugin-*`/plugin-sdk-dependent
files; zero reference any E2 file (grep over the changed schema modules,
migration, and test returned none). DEC-03-waivable per the finding disposition;
not an epic-touched defect. No new findings.

## Follow-up tickets

None. TEN-002 (RLS/policy/non-owner role) and TEN-005 (adversarial property suite)
consume these composite constraints as already-planned successors, not follow-ups
from this ticket.

## Gate recommendation

`ready for independent review` — the TEN-004 acceptance ("direct SQL cannot
construct a mixed-tenant relationship even when application checks are bypassed")
is proved for every composite relationship (RED→GREEN captured, each rejection
asserting its constraint name) plus the leases partial-unique; the `companies`
touch is additive-only (CAV-005); the migration reorder is DDL-text-preserving and
applies cleanly through the full chain; no regression to TEN-001a/b; the
server-typecheck delta is subset-of-baseline (E2-F009).

## Independent review

**Reviewer:** `claude-opus (independent reviewer subagent — distinct from the implementer subagent)`
**Reviewed revision:** `bd4fe0283cce23f3e0983340435c14749a7a0c73`
**Disposition:** `approved`
**Review evidence:**

Reviewed at HEAD `bd4fe0283` (TEN-004 code commit `8bb127efa` + the E2-D08 doc `bd4fe0283`; code unchanged between them). Working tree clean before and after review.

*Re-run acceptance (C:\e2\packages\db unless noted):*
- `pnpm --filter @armyofagents/db typecheck` → exit `0`.
- `pnpm --filter @armyofagents/db build` → exit `0`.
- `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-composite-integrity.integration.test.ts` → exit `0`, **9 passed**. Postgres server log independently confirms every rejection fires on the INTENDED constraint: `jobs_org_company_fk`, `job_attempts_org_job_fk`, `leases_org_attempt_fk`, `services_org_company_fk`, `service_instances_org_service_fk`, `job_artifacts_org_job_fk`, `job_secret_handles_org_job_fk` (all `23503`), and the dup-active-lease on `leases_active_per_attempt_idx` (`23505`). Positive same-tenant controls all insert cleanly.
- Same test WITHOUT the flag → **9 skipped** (E2-D05 env-hatch `skipIf`, not the banned ternary).
- `pnpm exec vitest run src/__tests__/migration-idempotency.test.ts` → exit `0`, 5 passed.
- `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/tenant-kernel-schema.integration.test.ts src/__tests__/tenant-kernel-schema-b.integration.test.ts` → exit `0`, **11 passed** (0209 in the chain does not regress TEN-001a/b).
- `pnpm --filter @armyofagents/server typecheck 2>&1 | grep -iE "…(jobs|attempt|lease|worker|service|artifact|secret_handle|tenant|composite|repositories)" || echo none` → **none** (E2-F009 plugin-sdk baseline holds; zero E2 files in the server error surface).

*Migration reorder verbatim proof (Rule #1 / E2-D08):* Regenerated `0209` from the compiled `dist/schema/*.js` into the tree (journal idx 209 removed + snapshot/sql deleted, `drizzle-kit generate --name=tenant_composite_integrity`), then restored via `git checkout`. Raw drizzle-kit output emits the **7 composite FK `ADD CONSTRAINT`s first**, then the `CREATE UNIQUE INDEX` (WITHOUT `IF NOT EXISTS`), then the **5 FK-target `UNIQUE ADD CONSTRAINT`s last** — an unappliable order (`42830`). Extracting + sorting the DDL statements of the committed `0209` vs the regenerated output (normalizing only the C14 `IF NOT EXISTS`) → **empty diff, 13 == 13 statements identical**. The committed migration's sole non-order hand-edit is the C14 `IF NOT EXISTS` on the one `CREATE UNIQUE INDEX` (0207/0208 convention); no `DO $$`, no backfill, no RLS/GRANT. The reorder is verbatim, semantics-preserving, documented inline, and applies cleanly through the full chain — **acceptable under E2-D08; the two-migration split is NOT required.**

*Structural verification (file:line):* Composite FK-target `unique(organization_id, id)` present on `jobs.ts:37`, `job_attempts.ts:36`, `services.ts:39`, `workers.ts:51`, and additive on `companies.ts:88`; composite `foreignKey()` present for job_attempts→jobs (`job_attempts.ts:38`), leases→job_attempts (`leases.ts:39`), jobs→companies (`jobs.ts:42`), services→companies (`services.ts:42`), service_instances→services (`service_instances.ts:38`), job_artifacts→jobs (`job_artifacts.ts:31`), job_secret_handles→jobs (`job_secret_handles.ts:31`); leases partial `uniqueIndex(...).where(status in ('offered','active'))` at `leases.ts:48`. Pre-existing single-column FKs retained (redundant, harmless). `companies` sentinel `organization_id` default is UNTOUCHED (`companies.ts:21`) — only the additive `companies_org_id_uq` unique was added (CAV-005-safe). No RLS/role/GRANT/policy DDL anywhere in the schema or migration diff; `assertCompanyAccess`/`rls-bootstrap.ts`/`with-tenant-tx.ts` not touched; no `package.json`/`pnpm-lock.yaml` change. Integration test boots embedded-PG in `beforeAll` with `setupError` re-thrown via `guard()` (fail-closed), UTF8/C initdb flags.

*Non-blocking nit (not a defect, no change required):* the `leases.ts` top-of-file narrative comment (lines 6–11) still describes the partial-unique as `WHERE released_at IS NULL` (the TEN-001a placeholder plan text); the actual implemented predicate is the more-correct `status in ('offered','active')`, and the index's own inline comment (lines 44–50) and the test (case 8) match the implementation. Cosmetic doc-comment lag only.

Disposition: **approved** — all focused acceptance passes, the E2-D08 reorder is proven verbatim and accepted, the `companies` touch is additive-only, and no scope/hygiene error. `Status` set to `complete`.

For `approved`, verify the result describes the reviewed revision, all focused acceptance evidence passes, and every accepted finding is resolved; then change the top-level `Status` to `complete` and commit this disposition separately. Otherwise leave `Status` as `gate_review` or set `blocked`, and link stable findings.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary above is not a review attempt. The first independent reviewer appends attempt 1, and later reviewers append monotonically increasing rows without replacing prior attempts. The summary fields above mirror the latest real attempt for existing gate tooling. Do not include a `Review commit` column: a row cannot embed the SHA of the commit that first contains it. Repository history identifies that commit, and handoffs pin the resulting ticket-result blob SHA.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
<!-- First independent reviewer appends attempt 1. -->
| 1 | `claude-opus (independent reviewer subagent)` | `bd4fe0283cce23f3e0983340435c14749a7a0c73` | `approved` | typecheck/build `0`; composite integ **9 passed** (each rejection on its named `*_fk` / `leases_active_per_attempt_idx`); no-flag **9 skipped**; idempotency 5, TEN-001a/b **11 passed**; E2-F009 grep = none. E2-D08 reorder proven **verbatim** (regenerate → empty sorted-statement diff, 13==13; only order + C14 `IF NOT EXISTS`); `companies` additive-only, sentinel default untouched; no RLS/GRANT, no guarded-file/manifest touch. → `Status: complete`. |
