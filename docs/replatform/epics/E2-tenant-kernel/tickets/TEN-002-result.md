# TEN-002 Result — Non-owner database role and forced RLS harness

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E2-tenant-kernel`
**Plan task:** `TEN-002 — Non-owner database role and forced RLS harness (M)`
**Implementer:** `claude-opus (implementer subagent)`
**Start SHA:** 2efac5ad904474e7f659b50a8590680edb99d721

The Start SHA is the actual `git rev-parse HEAD` of the C:\e2 worktree captured
before the first change. The plan §0 table lists `df509b946` as the "E2 Start
SHA"; that commit is an ancestor of this HEAD (TEN-001a/b, TEN-004, TEN-006a/b
have since landed). Mirrors the TEN-001/004/006 convention.

**Preconditions verified:** E2-D01 `locked` (promoted to product Decision #122);
E2-D03 `locked` (whole-app non-owner role, flag-gated dormant-but-tested). Both
required before TEN-002 per E2-F001/E2-F002 — satisfied.

## Delivered scope

- **`server/src/db/rls-tenant.ts`** — pure, role/table-name-safe SQL builders
  (validate via `assertSafeRoleName` + a local identifier predicate; roles/tables
  cannot be query-bound). Exports:
  - `TENANT_APP_ROLE = "aoa_app"`, `TENANT_GUC = "aoa.organization_id"`,
    `TENANT_RLS_TABLES` = frozen list of the 8 new-path tables.
  - `createNonOwnerRoleSql(role)` → idempotent `DO $$ IF NOT EXISTS … CREATE ROLE
    "aoa_app" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE …`.
  - `grantDmlSql(role, tables)` → `GRANT SELECT, INSERT, UPDATE, DELETE ON …8 tables… TO "aoa_app";`.
  - `enableForceRlsSql(table)` → `ENABLE` + `FORCE ROW LEVEL SECURITY` (breakpoint-separated).
  - `tenantPolicySql(table, role)` → `DROP POLICY IF EXISTS …` + `CREATE POLICY … TO
    "aoa_app" USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
    WITH CHECK (…same…)`.
  - `provisionTenantAppRoleLoginSql(role, password)` → runtime-only idempotent
    `ALTER ROLE "aoa_app" WITH LOGIN PASSWORD '<escaped>'` (never committed).
  - `buildTenantRlsMigrationSql()` → the assembled 0211 body (C14 header + all
    statements), the source of truth the committed migration mirrors byte-for-byte.
- **`packages/db/src/migrations/0211_tenant_rls_enforcement.sql`** — DELTA-FREE
  `--custom` migration (created via `drizzle-kit generate --custom
  --name=tenant_rls_enforcement`; journal idx 211 + `meta/0211_snapshot.json`). The
  entire block is C14 hand-authored (drizzle-kit emits none of ROLE/GRANT/ENABLE/
  FORCE/POLICY under this repo's config): CREATE ROLE, GRANT on all 8 tables, and
  per table ENABLE + FORCE + DROP POLICY IF EXISTS + CREATE POLICY. All idempotent.
- **`packages/db/src/client.ts`** — `createTenantAppDb(url)` non-owner serving-pool
  factory (UTF-8 like `createDb`) that **throws** on a missing/blank URL and NEVER
  falls back to the owner pool (E2-F007); `assertNonOwnerConnection(db)` throws
  unless `NOT rolsuper AND NOT rolbypassrls`. `createDb` unchanged (privileged/
  migration path). Re-exported from `packages/db/src/index.ts`.
- **`server/src/index.ts`** — a minimal flag-gated privileged boot hook
  `maybeProvisionTenantAppRole(activeDatabaseConnectionString)` invoked AFTER
  migrations, under the privileged/owner connection. Strict no-op unless
  `config.distributedExecutionEnabled` is true AND `AOA_APP_DB_PASSWORD` is set. Does
  NOT open the non-owner serving pool (TEN-003's `runInTenant`/`createTenantAppDb`).
- Two tests: `tenant-rls-enforcement-unit.test.ts` (Windows-visible; builders +
  fail-closed factory) and `tenant-rls-enforcement.integration.test.ts` (E2-D05
  env-hatch embedded-PG; assertions a–i + a2 idempotency).

**Non-goals preserved:**
- NO legacy-table RLS/policy/role change (CAV-005); `aoa_app` gets DML only on the
  8 new-path tables. `assertCompanyAccess`, `rls-bootstrap.ts`, `with-tenant-tx.ts`,
  and the new-path table SCHEMA (TEN-001/004) not touched.
- NO non-owner serving pool opened at boot (TEN-003). NO operator role/policy for
  platform null-Org rows (deferred to E3/JOB-002 per E2-D04 — see Deviations).
- NO SUPERUSER/BYPASSRLS/CREATEDB granted to `aoa_app`. NO committed credential.
- NO new dependency; no `package.json`/`pnpm-lock.yaml` change.
- Default-off (`AOA_DISTRIBUTED_EXECUTION_ENABLED` unset) boot path unchanged.

## Changed files

| File | Responsibility |
|---|---|
| `server/src/db/rls-tenant.ts` | **New.** Pure role/policy SQL builders + `buildTenantRlsMigrationSql`. |
| `packages/db/src/client.ts` | Add `createTenantAppDb` (fail-closed non-owner factory) + `assertNonOwnerConnection`; import `sql`. `createDb` unchanged. |
| `packages/db/src/index.ts` | Re-export `createTenantAppDb`, `assertNonOwnerConnection`. |
| `packages/db/src/migrations/0211_tenant_rls_enforcement.sql` | **New.** Delta-free `--custom` RLS migration (role/GRANT/ENABLE+FORCE/policy ×8, idempotent). |
| `packages/db/src/migrations/meta/0211_snapshot.json` | **New.** drizzle-kit `--custom` snapshot (no schema delta). |
| `packages/db/src/migrations/meta/_journal.json` | Journal idx 211 appended. |
| `server/src/index.ts` | Minimal flag-gated `maybeProvisionTenantAppRole` boot hook + imports. |
| `server/src/__tests__/tenant-rls-enforcement-unit.test.ts` | **New.** Windows-visible builder + fail-closed-factory unit proof. |
| `server/src/__tests__/tenant-rls-enforcement.integration.test.ts` | **New.** Embedded-PG forced-RLS H-01 proof (a–i + a2). |

## Acceptance evidence (H-01 assertions a–i)

Integration suite `tenant-rls-enforcement.integration.test.ts`, embedded-PG,
`AOA_RUN_WIN_INTEGRATION=1` → **10 passed**. Seeds two orgs + a company in each +
one row per tenant in all 8 tables (+ a platform null-Org worker). `aoa_app` LOGIN
provisioned in-test as superuser (the migration left it NOLOGIN, no committed
secret); connected via the cred-swap.

| H-01 assertion | Evidence (test case) | Result |
|---|---|---|
| (a) FORCE + ENABLE applied to all 8 tables (catalog `pg_class.relforcerowsecurity` + `relrowsecurity` all true) | it (a) | `pass` |
| (a2) migration idempotent: 2nd `applyPendingMigrations` = no-op AND re-running every 0211 statement is a no-op; FORCE still true | it (a2) | `pass` |
| (b) `aoa_app`, NO GUC → 0 rows in every new-path table | it (b) (loop ×8) | `pass` |
| (c) GUC=ORG_A → ONLY ORG_A rows (count 1, all org==ORG_A) in every table | it (c) (loop ×8) | `pass` |
| (d) wrong-org GUC (ORG_NONE) → 0 rows in every table | it (d) (loop ×8) | `pass` |
| (e) cross-tenant INSERT (GUC=ORG_A, row=ORG_B) rejected by policy WITH CHECK (SQLSTATE **42501**, not FK) | it (e) | `pass` |
| (f) NON-superuser owner (`aoa_owner_ns`, LOGIN, owns `jobs`) filtered under FORCE with no GUC → **0 rows**, while the superuser sees 2 (the assertion impossible against the superuser owner) | it (f) | `pass` |
| (g) `aoa_app` cannot INSERT **or** UPDATE a `workers` row to `organization_id IS NULL` (WITH CHECK, SQLSTATE 42501) | it (g) | `pass` |
| (h) no tenant GUC (ORG_A/ORG_B/ORG_NONE) returns a null-Org platform worker (0); superuser confirms the row exists (1) | it (h) | `pass` |
| (i) `assertNonOwnerConnection(appDb)` resolves for `aoa_app` (NOSUPERUSER+NOBYPASSRLS); throws `/privileged role/` for the superuser | it (i) | `pass` |

Windows-visible unit `tenant-rls-enforcement-unit.test.ts` → **15 passed**:
builders emit `FORCE ROW LEVEL SECURITY` (×8 real ALTERs), the `NOLOGIN NOSUPERUSER
NOBYPASSRLS` role, and `current_setting('aoa.organization_id', true)::uuid` in USING
+ WITH CHECK; reject unsafe role/table names; `provisionTenantAppRoleLoginSql`
escapes the secret and is absent from the committed migration string;
`createTenantAppDb("")`/`("   ")`/`undefined`/`null` all THROW before any connection.

**FORCE semantics (E2-F004) — how the guarantee is proved without filtering the
superuser owner:** the DB-enforcement guarantee is that `aoa_app` is non-owner +
NOSUPERUSER + NOBYPASSRLS (plain RLS filters it — assertions b–e,g,h,i + the (i)
`rolsuper=false, rolbypassrls=false` check). FORCE is proved two independent ways:
(a) the catalog flag `relforcerowsecurity=true`, and (f) a purpose-built
non-superuser owner of `jobs` that is filtered to 0 rows under FORCE — the exact
behavioral proof that cannot hold against the embedded-PG superuser owner (a
superuser bypasses RLS regardless of FORCE). Ownership transfer was environmentally
feasible; no fallback to the catalog-only path was needed.

## Commands

| Command | Exit | Result |
|---|---:|---|
| `pnpm --filter @armyofagents/db typecheck` | `0` | clean |
| `pnpm --filter @armyofagents/db build` | `0` | `tsc && cp -r src/migrations dist/migrations` (incl. 0211) |
| `vitest run tenant-rls-enforcement-unit.test.ts` (RED, pre-impl) | `1` | suite fails to load: `Cannot find module '../db/rls-tenant.js'` |
| `vitest run tenant-rls-enforcement-unit.test.ts` (GREEN) | `0` | 15 passed |
| `drizzle-kit generate --custom --name=tenant_rls_enforcement` | `0` | empty stub + journal idx 211 + `0211_snapshot.json` (then filled from `buildTenantRlsMigrationSql`) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-rls-enforcement.integration.test.ts` (RED, pre-migration) | `1` | 9 failed — `ALTER ROLE "aoa_app"` fails in beforeAll (role/FORCE absent) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-rls-enforcement.integration.test.ts` (GREEN) | `0` | **10 passed** (a–i + a2) |
| `vitest run tenant-rls-enforcement.integration.test.ts` (NO flag) | `0` | **10 skipped** (E2-D05 env-hatch `skipIf`, not the banned ternary) |
| `vitest run integration-test-hygiene.test.ts` | `0` | 2 passed (my `skipIf` form not flagged; see Deviations for the reworded comment) |
| `pnpm exec vitest run` migration-idempotency + journal-contiguity + snapshot-gate + cli-snapshot-gate + organizations-journal (db) | `0` | 45 passed (0211 idempotent; journal idx 211 contiguous + file-aligned) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run` tenant-kernel-schema{,-b} + tenant-composite-integrity (db) | `0` | 20 passed (0211 in the chain does not regress TEN-001a/b/TEN-004) |
| `vitest run rls-canary-unit + config + tenant-rls-enforcement-unit` (server) | `0` | 34 passed (`distributedExecutionEnabled` default false unchanged) |
| `pnpm exec vitest run` (full db suite, no flag) | `1` | **291 passed / 1 failed (pre-existing, TEN-006b) / 38 skipped** — see Findings F-1 |
| `pnpm --filter @armyofagents/server typecheck` | `2` | 66 errors, all `@armyofagents/plugin-sdk` (E2-F009); **zero** reference any TEN-002 file (grep clean) |

## Deviations

1. **`provisionTenantAppRoleLoginSql(role, password)` signature** — the plan hint
   showed `(role)` with a `$1`-bound password. Postgres does NOT allow binding a
   parameter to `ALTER ROLE … PASSWORD` (utility DDL, not a Bind-able query), so —
   exactly as the ticket's fallback permits — the secret is **escaped**
   (`.replace(/'/g, "''")`, mirroring `rls-bootstrap.ts`) with the password passed
   as a runtime argument. It stays OUT of git: the migration creates the role
   NOLOGIN with no password; this login SQL is built only at boot/test from env.
2. **No operator role/policy for platform null-Org rows at E2.** The plan's RLS-DDL
   sketch (§334-335) noted "workers additionally get an operator policy". Per
   **E2-D04** the operator read role/policy for platform rows is **E3 (JOB-002)**;
   at E2 the requirement is only to prove tenants cannot read/write null-Org rows —
   satisfied by the tenant policy (NULL = GUC → NULL → excluded) plus WITH CHECK,
   proved by assertions (g) + (h). No operator policy was added (keeping E2 bounded
   and matching the task's per-table ENABLE+FORCE+DROP+CREATE deliverable exactly).
3. **`aoa_app` error SQLSTATE surfaced via a cause-walk.** drizzle's postgres-js
   session wraps the raw PostgresError, so the integration test reads the SQLSTATE
   via a `.cause`-chain walker (`sqlstate()`) rather than top-level `.code` (the
   composite test used a raw `postgres` client and read `.code` directly). Same
   guarantee, robust to the wrapping.
4. **Committed migration mirrors the builder byte-for-byte.** `0211`'s content was
   generated from `buildTenantRlsMigrationSql()` (via `tsx`) and pasted, so the
   unit-tested builder and the applied migration cannot drift.

**Keeping the password out of git:** the only place a login password appears is a
runtime argument to `provisionTenantAppRoleLoginSql` (boot from `AOA_APP_DB_PASSWORD`;
test from a literal `'app_pw'`). The committed migration (`0211`) and
`buildTenantRlsMigrationSql()` contain NO `LOGIN PASSWORD` (unit-test asserted via
`not.toMatch(/LOGIN\s+PASSWORD/i)`), and the password is never logged.

## Findings

- **F-1 (pre-existing, NOT TEN-002; TEN-006b's surface).** The db source-asserting
  test `packages/db/src/__tests__/companies-org-scope-schema.test.ts` — the `it(…"+
  sentinel DB default")` case — FAILS on the branch HEAD. Root cause: TEN-006b
  (commit `a269f8bd2`) dropped the sentinel `.default(...)` from
  `packages/db/src/schema/companies.ts` (line 20; line 19 comment: "Do NOT re-add
  `.default(...)`"), but this source-asserting test still expects it. Proof it is
  pre-existing and independent of TEN-002: `git diff --stat HEAD` for both
  `companies.ts` and the test is **empty** (byte-identical to HEAD), TEN-002 does
  not touch `companies.ts`, and the test reads source only (no DB/migration), so it
  reproduces on a clean checkout. Undocumented in E2 findings before this ticket. It
  is TEN-006b's owned surface (companies schema + its test) and out of TEN-002 scope
  — NOT fixed here; a follow-up task was spawned. It IS a real E2-gate risk (the D0
  rollup runs `pnpm test:run`) and should be dispositioned before the E2 gate.
- **E2-F009 (pre-existing)** re-confirmed unchanged: `pnpm --filter server
  typecheck` exits 2 with 66 errors, ALL `@armyofagents/plugin-sdk` / plugin
  subsystem; a grep over the error output for `rls-tenant`/`tenant-rls`/`index.ts`/
  `client.ts`/`createTenantAppDb`/`assertNonOwnerConnection` returns **none**.
  DEC-03-waivable.
- **Hygiene near-miss (fixed here, no residue).** The
  `integration-test-hygiene.test.ts` scanner is a raw-text grep for `? describe :
  describe.skip`; my header comment originally quoted that literal pattern to explain
  what it avoids, tripping the scanner. The comment was reworded to avoid the literal
  ternary; hygiene is green (2 passed). (TEN-004's identical comment lives in the db
  package, which this server-only scanner does not cover — hence it slipped through
  there.)

## Gate recommendation

`ready for independent review` — TEN-002's H-01 acceptance is proved end-to-end on
real embedded-Postgres: the serving role is non-owner + NOSUPERUSER + NOBYPASSRLS
and forced RLS denies every cross-tenant read/write/existence-probe and the platform
null-Org rows (a–i), FORCE is proved both by catalog and by a non-superuser-owner
behavioral test (E2-F004), the non-owner pool factory fails CLOSED (E2-F007), the
delta-free 0211 migration is idempotent (re-apply + re-run both no-ops), the boot
hook is dormant-by-default (flag OFF unchanged, `config.test` green), no legacy RLS
retrofit (CAV-005), and the server-typecheck delta is subset-of-baseline (E2-F009).
Reviewer should scrutinize: (1) the FORCE non-superuser-owner proof (f) + the
operator-policy deferral (Deviation 2 / E2-D04); (2) the password-out-of-git argument
(Deviation 1); (3) the pre-existing F-1 companies-schema test failure (TEN-006b) that
the E2 gate must disposition; (4) that a real Linux run is still owed for H-01 at the
gate (E2-D05/E2-F008 — Windows-local evidence here).

## Independent review

**Reviewer:** `claude-opus (independent reviewer subagent)` — distinct from the implementer (`claude-opus (implementer subagent)`).
**Reviewed revision:** `0b22d3934396c6c2bb6f3844800696c0fc38f233` (branch HEAD; TEN-002 code from `94da4cda6` is unchanged at HEAD — `0b22d3934` adds only the orthogonal E2-F011 companies-schema source-assert fix).
**Disposition:** `approved`

**Review evidence (re-run from C:\e2, Git Bash):**

| Check | Command | Exit | Result |
|---|---|---:|---|
| db typecheck | `pnpm --filter @armyofagents/db typecheck` | `0` | clean |
| db build | `pnpm --filter @armyofagents/db build` | `0` | `tsc && cp -r src/migrations dist/migrations` (incl. 0211) |
| builder ≡ migration | `tsx` compare `buildTenantRlsMigrationSql()` vs committed `0211` body | `0` | **byte-identical** (5665 chars) — no drift possible |
| snapshot delta-free | JSON compare `0211_snapshot.json` vs `0210` (ignoring id/prevId) | `0` | schema-identical; `0211.prevId === 0210.id` (chain intact) |
| journal | `_journal.json` idx 211 = `0211_tenant_rls_enforcement` | — | contiguous after 210, file-aligned |
| unit | `vitest run tenant-rls-enforcement-unit.test.ts` | `0` | **15 passed** |
| config default-off | `vitest run config.test.ts` (asserts `distributedExecutionEnabled` false→true) | `0` | **15 passed** |
| rls-canary-unit | `vitest run rls-canary-unit.test.ts` | `0` | **4 passed** (34 server-unit total with the two above) |
| migration-idempotency | `cd packages/db && vitest run migration-idempotency.test.ts` | `0` | **5 passed** (0211 does not trip the CREATE-without-IF-NOT-EXISTS scan) |
| **H-01 integration (flag)** | `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-rls-enforcement.integration.test.ts` | `0` | **10 passed** (a, a2, b, c, d, e, f, g, h, i) |
| integration (no flag) | `vitest run tenant-rls-enforcement.integration.test.ts` | `0` | **10 skipped** (`describe.skipIf`, not the banned ternary) |
| db tenant chain (flag) | `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-kernel-schema{,-b} + tenant-composite-integrity` | `0` | **20 passed** — 0211 in the chain does not regress TEN-001a/b/TEN-004 |
| rls-canary integration | `AOA_RUN_WIN_INTEGRATION=1 vitest run rls-canary.integration.test.ts` | `0` | **1 skipped** on Windows (`skipIf(process.platform !== "linux")`; Linux-CI-only — cleanly skipped, no error/regression) |
| E2-F009 baseline | `pnpm --filter @armyofagents/server typecheck` | `2` | 66 errors, **all** `@armyofagents/plugin-sdk`; grep for `rls-tenant`/`client.ts`/`tenant-rls`/`createTenantAppDb`/`assertNonOwnerConnection` → **none**. Subset-of-baseline. |
| F-1 (ledger) resolved | `cd packages/db && vitest run companies-org-scope-schema.test.ts` | `0` | **2 passed** — the pre-existing TEN-006b failure the ledger flagged is FIXED at HEAD by E2-F011 (`0b22d3934`); no longer an E2-gate risk. |

**Observed real Postgres SQLSTATEs (embedded-PG server log, captured live during the integration run):**
- `(e)` cross-tenant INSERT (GUC=ORG_A, row=ORG_B): server log `ERROR: new row violates row-level security policy for table "jobs"` on `INSERT INTO jobs (organization_id, company_id) VALUES ($1,$2)` — genuine **42501** WITH CHECK denial (the `(ORG_B, CO_B)` composite is a valid FK, so RLS — not FK 23503 / typo 42703 — is the rejecter). Test pins `sqlstate(err) === "42501"`.
- `(g)` INSERT platform worker: `ERROR: new row violates row-level security policy for table "workers"` (the `workers_scope_org_check` CHECK is satisfied — platform ⇒ NULL org — so the reject is the RLS WITH CHECK, **42501**, not the check constraint).
- `(g)` UPDATE owned row to null-Org: `ERROR: new row violates row-level security policy for table "workers"` on `UPDATE workers SET organization_id = NULL … WHERE id = $1` — USING admits the ORG_A row, WITH CHECK on the new (NULL) row rejects (**42501**).
- The `(a2)` idempotency re-run emits benign `NOTICE: policy "…" does not exist, skipping` (from `DROP POLICY IF EXISTS`) — confirms idempotent re-apply.

**Adversarial fail-open probes (H-01) and outcomes — no vector found:**
1. **Unset GUC** → `current_setting('aoa.organization_id', true)` returns NULL (missing_ok) → `organization_id = NULL` ⇒ NULL ⇒ row excluded ⇒ **0 rows** on all 8 tables (proved by (b), (h)). Fail-CLOSED default, not all-rows, not an error.
2. **Empty-string GUC** → the sole GUC writer `with-tenant-tx.ts` binds the org as a query **parameter** (never interpolated) and is not called by any serving pool at E2; a pathological `''` would make `''::uuid` throw 22P02 (fail-CLOSED), never leak. No code path in TEN-002 scope sets an empty string. Not a vector.
3. **Cross-tenant INSERT / UPDATE-to-NULL** → WITH CHECK 42501 (server-log-confirmed above).
4. **Cross-tenant UPDATE ORG_A→ORG_B** (not separately asserted): identical WITH CHECK predicate as (e)/(g) — new row org=ORG_B ≠ GUC ORG_A ⇒ 42501. Mechanism proven; not a fail-open gap.
5. **Cross-tenant DELETE** (not separately asserted): governed by the same USING clause proved to filter SELECT to only GUC-matching rows (b/c/d/h) ⇒ 0 rows affected, no cross-tenant mutation. Not a fail-open gap.
6. **Policy `FOR` clause** → the policy has **no `FOR`** (verified in `0211` lines 26-28 etc.), so it governs ALL of SELECT/INSERT/UPDATE/DELETE (USING gates read/update/delete, WITH CHECK gates insert/updated-row). No command left ungoverned.
7. **Null-Org platform rows** unreachable by any tenant GUC (ORG_A/ORG_B/ORG_NONE) → 0 both by aggregate and by-id; superuser confirms the row exists (h). E2-D04 operator-read correctly deferred to E3 (no operator role at E2).
8. **Fail-closed pool (E2-F007):** `createTenantAppDb("")/("  ")/(undefined)/(null)` all THROW before connecting and never fall back to `createDb` (unit-proven + code `client.ts:71-80`); `createDb` is purely additive-diff unchanged. `assertNonOwnerConnection` throws `/privileged role/` for the superuser, resolves for `aoa_app` (i).

**FORCE-proof verdict (E2-F004) — CORRECT.** The security guarantee is anchored on `aoa_app` being **non-owner + NOSUPERUSER + NOBYPASSRLS** (plain RLS filters it — b–e,g,h,i + the (i) `rolsuper=false, rolbypassrls=false` assertion), NOT on FORCE filtering a superuser. FORCE is proved two independent ways: (a) catalog `pg_class.relforcerowsecurity = true` (and `relrowsecurity`) on all 8, and (f) a purpose-built **non-superuser** owner (`aoa_owner_ns`, LOGIN, made OWNER of `jobs`) filtered to **0 rows** under FORCE with no GUC while the superuser sees 2 — the exact behavioral proof impossible against the embedded-PG superuser owner. The non-superuser-owner test was environmentally feasible (no fallback to catalog-only). Deviation 2 (operator-policy deferral to E3/JOB-002 per E2-D04) is honestly documented and correct.

**Scope / Rule #1 / CAV-005 (#122):** the RLS/role/GRANT/FORCE/POLICY DDL is confined to the delta-free `--custom` `0211` (E2-D01/#122-sanctioned; snapshot proved schema-identical to 0210). Role/table names validated via `assertSafeRoleName` + a local identifier predicate before interpolation (roles cannot be query-bound); unit tests prove injection strings throw. No legacy-table RLS, and `with-tenant-tx.ts` / `rls-bootstrap.ts` / `assertCompanyAccess` are **untouched** by `94da4cda6` (verified via `git show --stat`). `TENANT_RLS_TABLES` is frozen to the 8 new-path tables. No committed credential (`grep` of migrations + `buildTenantRlsMigrationSql()` = no `LOGIN PASSWORD`; the only login SQL is the runtime `provisionTenantAppRoleLoginSql`, escaped, boot-only from `AOA_APP_DB_PASSWORD`). Flag-gating (E2-D03): `maybeProvisionTenantAppRole` is a strict no-op unless `distributedExecutionEnabled` (default false) AND the password env is set; it runs after migrations under the privileged connection and opens no serving pool (that is TEN-003).

**Owed at the E2 gate (not a TEN-002 defect):** a real Linux run for the H-01 integration test (E2-D05/E2-F008) — evidence here is Windows-local via the `AOA_RUN_WIN_INTEGRATION` env-hatch (the sanctioned E2 pattern), plus the Windows-visible unit sibling.

**Disposition rationale:** all focused acceptance passes on real embedded-Postgres; FORCE is correctly proven (catalog + non-superuser-owner behavioral); the non-owner serving pool fails CLOSED; no fail-open read/write/existence vector was found under adversarial probing; the migration is delta-free + idempotent and mirrors the unit-tested builder byte-for-byte; no Rule #1 / CAV-005 / scope violation; the boot hook is dormant-by-default. `Status` set to `complete`; this disposition committed separately.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary
above is not a review attempt. The first independent reviewer appends attempt 1, and
later reviewers append monotonically increasing rows without replacing prior
attempts. Do not include a `Review commit` column: a row cannot embed the SHA of the
commit that first contains it.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
<!-- First independent reviewer appends attempt 1. -->
| 1 | claude-opus (independent reviewer subagent) | `0b22d3934` | `approved` | Re-ran full acceptance on embedded-PG: unit 15 + config 15 + rls-canary-unit 4; migration-idempotency 5; **H-01 integration 10 passed** (flag) / 10 skipped (no flag); db tenant chain 20 passed (no 0211 regression). Builder ≡ committed `0211` byte-for-byte (5665 chars); `0211` snapshot delta-free vs `0210` (prevId chains). PG server log confirmed genuine **42501** WITH CHECK denials on (e)/(g). FORCE proven by catalog (a) + non-superuser-owner behavioral (f) — anchored on `aoa_app` non-owner+NOSUPERUSER+NOBYPASSRLS. Fail-closed pool (E2-F007) + `assertNonOwnerConnection` (i) verified. Adversarial probes (unset/empty GUC, cross-tenant UPDATE/DELETE, null-Org rows, policy has no `FOR`) found **no fail-open vector**. CAV-005: `with-tenant-tx.ts`/`rls-bootstrap.ts`/`assertCompanyAccess` untouched; no committed secret; flag dormant-by-default (config default false). E2-F009 typecheck delta = subset of plugin-sdk baseline (0 TEN-002 refs). Ledger F-1 (TEN-006b companies-schema test) now resolved at HEAD by E2-F011. Owed: ≥1 real Linux H-01 run at the E2 gate (E2-D05/E2-F008). |
