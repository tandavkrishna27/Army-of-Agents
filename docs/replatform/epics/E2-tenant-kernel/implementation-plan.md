# E2 — Tenant-safe Control-plane Kernel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> to implement this plan ticket-by-ticket (fresh implementer subagent per ticket, then a
> DISTINCT independent reviewer). Steps use checkbox (`- [ ]`) syntax. This plan is the
> executable scope; behavior-changing edits after execution begins require a `decisions.md`
> entry + a plan amendment reviewed by the Integration Gate Owner (`artifact-policy.md`).
>
> **Revision note:** This is revision **a2** of the plan — amended after an independent
> 3-lens adversarial review (contract/scope, security/H-01, TDD/gate). The review corrected
> the FORCE-RLS-vs-superuser semantics (findings E2-F004), the sentinel dual-identity + TEN-006
> scope (E2-F005/E2-F006), the delta-free RLS migration mechanism, and several gate/DoR items.
> Two review findings were **rejected as verification errors** (next migration IS `0207`, and
> `forbiddenOrganizationSentinels` IS present in FND-007 — both re-verified against disk).

**Goal:** Give the new distributed job/worker/service/lease path DB-enforced tenant
isolation — a non-owner (NOSUPERUSER, NOBYPASSRLS) Postgres role, forced RLS, one mandatory
Organization transaction context, composite tenant integrity, sentinel-Organization removal,
and a seed-reproducible adversarial tenant suite — without retrofitting the ~129 legacy
`companyId` tables (CAV-005).

**Architecture:** New-path tenant **tables/columns/FKs** are Drizzle schema (`pnpm
db:generate`); the **RLS enforcement DDL** (non-owner role, GRANT, `ENABLE` + `FORCE ROW
LEVEL SECURITY`, `CREATE POLICY`) is C14 hand-appended idempotent raw SQL in a drizzle
**`--custom`** (delta-free) migration (E2-D01). The app serves new-path repositories through a
**non-owner pool** (`aoa_app`, NOSUPERUSER/NOBYPASSRLS) governed by a **mandatory
`runInTenant` Organization context** writing the transaction-local `aoa.organization_id` GUC
(E2-D02); migrations run under a separate privileged role (E2-D03). The DB-enforcement
guarantee rests on the serving role being **non-owner + non-superuser**; `FORCE` is
defense-in-depth against a *non-superuser* owner mistake. H-01 (tenant isolation) is a HARD,
non-waivable invariant proved by TEN-005.

**Tech stack:** PostgreSQL + Drizzle ORM (`drizzle-orm@0.45.2` / `drizzle-kit@0.31.10`),
`postgres-js`, Vitest 3.2.6 + `embedded-postgres@18.1.0-beta.16`, Express 5.

---

## 0. Context, invariants, and preconditions

| Item | Value |
|---|---|
| E2 Start SHA (worktree HEAD) | `df509b946` (record **bare** in each `TEN-00X-result.md`) |
| Frozen `origin/main` | `003492988` (ancestor of advanced `origin/main`; freeze intact) |
| Upstream gates | **E0 = pass** (`3a469b6bec68`), **E1 = pass** (`b03262692882`, supersedes a1 fail). E2 is **independent of E1**, unblocked by E0. |
| Scope line | **CAV-005** — non-owner role + forced RLS **only** on the new distributed job/worker/service/lease tables. Legacy ~129 `companyId` tables keep their `assertCompanyAccess` (556 sites, `server/src/routes/authz.ts:36`) + `tenantIsolationEnforced()` (`server/src/config/deployment-mode.ts:12`) app-layer boundary + the `company_secrets` canary. **No legacy retrofit.** |
| HARD invariant | **H-01** (tenant isolation), non-waivable (`test-gates.md:25`): zero cross-Organization / unauthorized cross-Company reads, writes, deletes, existence disclosures, subscriptions, object-key accesses, secret resolutions, provider-resource accesses. |
| Gate class | E2 exit gate = **D0 rollup** (`D0-R01..R04`) + per-ticket focused acceptance (`D0-T01..T05`), governed by `DEC-01`/`DEC-03`. Windows-local operator-directed **plus at least one real Linux run for the H-01 suites** (E2-D05). |
| Epic decisions | [`decisions.md`](decisions.md): E2-D01 (RLS-DDL via `--custom` migration; **lock before TEN-002**; E2-F001), E2-D02 (GUC), E2-D03 (non-owner scope + fail-closed pool), E2-D04 (TEN-005 surface + error-normalization + null-Org read), E2-D05 (gate lane), E2-D06 (table inventory + TEN-001 split), E2-D07 (sentinel dual-identity + TEN-006 split). |
| Open findings | [`findings.md`](findings.md): E2-F001 (gates TEN-002), E2-F002 (operator scope confirm), E2-F003 (TEN-005 surface), E2-F004 (FORCE semantics — resolved by revision), E2-F005 (sentinel dual-identity), E2-F006 (TEN-006 sweep/resize), E2-F007 (fail-closed pool), E2-F008 (H-01 Linux-run evidence). |

**Assignment preconditions (agent-execution-guide):**
- **TEN-001, TEN-004** — assignable now (E0 pass).
- **TEN-006** — assignable now for the writer-sweep half (TEN-006a); the sentinel-default drop + admission-denial half (TEN-006b) is assignable now but must land the E2-D07 reconciliation.
- **TEN-002** — **NOT assignable** until the operator locks **E2-D01** (finding E2-F001) and confirms **E2-D03** scope (finding E2-F002).
- **TEN-003** depends on TEN-002; **TEN-005** depends on TEN-003 + TEN-004.

**Epic non-goals (preserve):**
- No RLS/policy/role change on any legacy `companyId` table (CAV-005). The non-owner role is GRANT'd full DML on legacy tables with **no** RLS there (behavior-identical).
- No weakening/bypass of `assertCompanyAccess` / `tenantIsolationEnforced()`.
- No distributed scheduler, worker, provider, artifact-content, secret-materialization, workspace, WebSocket, or object-storage logic (E3/E4/E5/E6). E2 builds only the tenant-ownership kernel + its enforcement.
- No Organization context in the worker wire protocol — PRT-006/PRT-007 stay context-free; sentinel/unmapped-Org denial is a control-plane policy check (coordinates with JOB-001/JOB-010).
- No hand-authored schema DDL; tables/FKs come from `pnpm db:generate` (Rule #1). Only RLS/role/GRANT/FORCE/backfill blocks are C14 hand-appended (E2-D01).

---

## 1. New-path table inventory & repository boundary (E2-D06)

New Drizzle modules under `packages/db/src/schema/` (one table per file; barrel-exported). Rich
columns deferred to E3/E4/E5 (additive). The kernel "run" surface is `job_attempts`
(program-design's "job/company/run" — rich run columns deferred to E3).

| Table | Org/Company scope | Purpose (kernel shape only) |
|---|---|---|
| `jobs` | `organization_id NOT NULL`, `company_id NOT NULL` | Immutable job intent + aggregate status (`text` + `check`). |
| `job_attempts` | via `job_id` (+ denorm `organization_id`) | The "run" surface; composite FK to `(jobs.organization_id, jobs.id)`. |
| `leases` | via `job_attempts` (+ denorm `organization_id`) | At-most-one active lease per attempt (partial unique index); fence token. |
| `workers` | `platform \| organization \| owner` scope; `organization_id NULL` only for `platform` | Worker/target registration identity. |
| `services` | `organization_id NOT NULL`, `company_id NOT NULL` | Service desired-state row. |
| `service_instances` | via `service_id` (+ denorm `organization_id`) | Service instance + generation. |
| `job_artifacts` | via `job_id` (+ denorm `organization_id`) | Minimal artifact **ownership** index. E5 extends. |
| `job_secret_handles` | via `job_id` (+ denorm `organization_id`) | Minimal opaque secret-**handle** ownership. E5 extends. |

**Platform (null-Org) worker rows under forced RLS (E2-D04):** a tenant GUC never matches
`organization_id IS NULL` (`NULL = <org>` → NULL → excluded), so tenants can neither read nor
(via `WITH CHECK`) write platform rows — correct fail-closed. The **operator read** of platform
rows uses a **dedicated operator policy** admitting `organization_id IS NULL` only to a distinct
operator role (never any tenant GUC), or a privileged path that establishes job/RLS scope
before returning details (program-design.md:142). Rich worker behavior is JOB-002 (E3); E2 only
lays the table + the operator-read policy shape and proves tenants can't reach null-Org rows.

**Repository boundary:** `packages/db/src/repositories/tenant/` exposes typed accessors bound
**only** to a tenant transaction; raw unscoped `db.select(jobs)` helpers are **not** exported
from the package public surface (compile-time export test in TEN-001). The tenant repository is
also the **uniform-denial normalization point** (E2-D04): it maps FK-violation, RLS
`WITH CHECK` violation, and not-found into one identical denial shape so no guard's identity
leaks (TEN-005 asserts identical error shape across cross-tenant read/write and truly-absent).

---

## 2. Test lanes, commands, and hygiene (all tickets)

**Focused per-ticket lane (`D0-T01`):** the ticket's RED→GREEN tests + affected-package
typecheck/build + changed-manifest checks, once.

```bash
# affected-package typecheck/build (Git Bash — packages/db build uses cp -r/rm -rf)
pnpm --filter @armyofagents/db typecheck && pnpm --filter @armyofagents/db build
pnpm --filter @armyofagents/server typecheck && pnpm --filter @armyofagents/server build
# schema → migration (Rule #1). Migration numbers are "next unused NNNN" (0208 next after
# TEN-001a's 0207 at HEAD; db:generate assigns them — do NOT hard-code non-contiguous numbers.
# If a ticket lands out of order the numbers shift; re-confirm at execution.
# NOTE (verified in TEN-001a): `pnpm db:generate -- --name=X` DOUBLE-FORWARDS `--` through the
# nested pnpm filter and drizzle-kit rejects the stray token. Working invocation = build the
# schema to dist first, then run drizzle-kit directly from packages/db:
pnpm --filter @armyofagents/db build && cd /c/e2/packages/db && pnpm exec drizzle-kit generate --name=<slug>   # normal schema delta
cd /c/e2/packages/db && pnpm exec drizzle-kit generate --custom --name=<slug>   # DELTA-FREE stub (TEN-002 RLS only)
# Then hand-add the C14 `IF NOT EXISTS` guard to every generated CREATE TABLE/INDEX (drizzle-kit
# omits it; `migration-idempotency.test.ts` requires it — this is the sanctioned C14 idempotency
# guard, NOT the RLS/role/backfill hand-append, and applies to EVERY E2 migration).
# single integration file (real embedded-Postgres); AOA_RUN_WIN_INTEGRATION hatch (E2-D05)
cd /c/e2/server && AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/<file>.integration.test.ts
cd /c/e2/packages/db && pnpm exec vitest run src/__tests__/<file>.integration.test.ts
cd /c/e2/server && pnpm exec vitest run src/__tests__/<file>-unit.test.ts   # windows-visible unit sibling
```

**E2 integration suites use the `AOA_RUN_WIN_INTEGRATION` env-hatch pattern (E2-D05, revised):**
```ts
const runWin = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";
describe.skipIf(!runWin)("…", () => { /* boot embedded-PG in beforeAll with initdbFlags */ });
```
This runs automatically on **Linux CI** (`process.platform !== "win32"` → true) **and** on the
Windows dev box when `AOA_RUN_WIN_INTEGRATION=1` — **no source edit-and-restore needed** (unlike
the shipped MT Pattern-A). It is a `skipIf`, so it satisfies `integration-test-hygiene.test.ts`
(which bans only the `X ? describe : describe.skip` ternary). Boot embedded-Postgres in
`beforeAll` **with `initdbFlags: ["--encoding=UTF8","--locale=C"]`**, capture setup failure into
`setupError`, and re-throw it in the first `it` (fail closed). **Cross-platform unit siblings**
(`*-unit.test.ts`) cover role-name/GUC/policy-SQL construction + the repository export surface.

**D0 rollup (`D0-R01..R04`, epic gate only):** `pnpm -r typecheck`, `pnpm test:run`,
`pnpm -r build`, authoritative root `pnpm build` (network-free; tracked bytes unchanged), each
critical suite three consecutive times, byte-clean worktree. Judged against the `DEC-03`
pre-existing-failure baseline captured at `df509b946`.

**Commit boundary (every ticket):** one reviewable commit (or short clean sequence). Each
schema/dependency change commits the manifest **+** regenerated `pnpm-lock.yaml` together
(AGENTS §7). Reviewers use plain `git commit`. Ledger convention (E0-F001): **Start SHA bare
40-hex**; `Status`/`Disposition` backtick-wrapped; Reviewer ≠ Implementer; Reviewed revision a
40-hex ancestor of HEAD.

---

## 3. Ticket plan

Execution order (valid topological order of Wave-1 `TEN-001 → {TEN-002, TEN-004, TEN-006} →
TEN-003 → TEN-005`, serialized to avoid migration collisions):

**TEN-001 → TEN-004 → TEN-006 → TEN-002 → TEN-003 → TEN-005 → E2 gate.**

(TEN-006 is placed before TEN-002 so the blocked-on-E2-D01 TEN-002 does not stall the assignable
sentinel work; TEN-006's migration is a normal schema delta — only TEN-002's RLS migration is
`--custom`.)

Each ticket additionally carries a **Caveat/credential/target impact** line (DoR
`program-design.md:297-298`): for every E2 ticket this is *"N/A — E2 introduces no placement,
credential, provider, or locality logic; CAV-005: no legacy RLS retrofit; provider-neutral
seam untouched."*

---

### TEN-001 — New-path tenant schema and repository boundary (M; split default — E2-D06)

**Depends on:** FND-002, FND-003 (present). **Default split (E2-D06):** **TEN-001a** = `jobs`,
`job_attempts`, `leases` + tenant repository factory + export test; **TEN-001b** = `workers`,
`services`, `service_instances`, `job_artifacts`, `job_secret_handles` + platform null-Org
operator-read policy shape. Each ≤3 days.

**Owned files:** the 8 schema modules under `packages/db/src/schema/`; `packages/db/src/schema/index.ts`;
`packages/db/src/repositories/tenant/index.ts`; migration `0207/0208_*` (via `pnpm db:generate -- --name=tenant_kernel_tables[_b]`);
tests `packages/db/src/__tests__/tenant-kernel-schema.integration.test.ts`,
`packages/db/src/__tests__/tenant-repository-surface.test.ts`.

**Interfaces:** house style (`goals.ts`), no `pgEnum` (use `text` + `check`), `.js` local
imports, `organization_id` inline FK (no shared helper), **no sentinel default** on any
new-path table. `tenantRepositories(tx)` is the only exported reader; no raw unscoped select is
exported.

**Failure/acceptance:** every owned row has non-null Organization identity (NOT NULL, no
default); Company-owned rows are constrained to the same Organization by TEN-004's composite FK;
raw unscoped repository reads are not exported (compile-time/export test).

**TDD:**
- [ ] RED — `tenant-kernel-schema.integration.test.ts`: boot embedded-PG + `applyPendingMigrations`, assert each table exists and `organization_id` is NOT NULL with **no** column default (`information_schema.columns`). FAIL (tables absent).
- [ ] RED — `tenant-repository-surface.test.ts`: assert the package public surface exports `tenantRepositories` and **no** raw table-reader. FAIL.
- [ ] GREEN — author modules + barrel + repo factory; `pnpm db:generate -- --name=tenant_kernel_tables`; `pnpm --filter @armyofagents/db build`; re-run → PASS; typecheck clean.
- [ ] Commit — one commit per split half; `TEN-001[a/b]-result.md` at `gate_review` (Start SHA `df509b946` bare).

**Maps to:** D0-T01, D0-T04, H-01 (non-null Org precondition).

---

### TEN-004 — Composite tenant integrity constraints (M)

**Depends on:** TEN-001. **Owned files:** the TEN-001 schema modules (add composite FKs/uniques
in the 2nd-arg callback — first `foreignKey()` use in the repo), an additive
`UNIQUE(organization_id, id)` on `companies` (CAV-005-safe — additive index, no RLS), migration
`0209_*` (`pnpm db:generate -- --name=tenant_composite_integrity`), test
`packages/db/src/__tests__/tenant-composite-integrity.integration.test.ts`.

**Interfaces:**
```ts
import { foreignKey, uniqueIndex, unique } from "drizzle-orm/pg-core";
// parent jobs: uniqueOrgId: unique("jobs_org_id_uq").on(t.organizationId, t.id)   // FK-targetable
// child job_attempts: jobFk: foreignKey({ columns:[t.organizationId,t.jobId], foreignColumns:[jobs.organizationId, jobs.id] })
// one active lease per attempt (PARTIAL UNIQUE INDEX, not a partial UNIQUE constraint — Postgres has no partial unique constraint):
//   oneActive: uniqueIndex("leases_one_active_idx").on(t.attemptId).where(sql`released_at IS NULL`)   // stays db:generate output
```
Composite relationships to constrain (E2-D06): job↔company↔org (`(organization_id, company_id) →
companies(organization_id, id)`), attempt↔job, lease↔attempt, worker↔org, service↔company↔org,
service_instance↔service, artifact↔job, secret_handle↔job.

**Acceptance:** **direct SQL** (bypassing app checks) that constructs any mixed-tenant
relationship is rejected by the composite FK. Prove for **every** composite relationship.

**TDD:** RED — per-composite `db.execute(sql\`INSERT … mixed tenant\`)` → `.rejects.toThrow()`
(FK violation), fails before FKs exist. GREEN — add composite FKs/uniques + the `companies`
org-unique; `pnpm db:generate -- --name=tenant_composite_integrity`; build; re-run → PASS.
Commit; `TEN-004-result.md`. **Maps to:** D0-T01, D0-T04, H-01.

---

### TEN-006 — Remove the sentinel Organization default + backfill (split — E2-D07)

**Depends on:** TEN-001, FND-007 (present). **Split (E2-F006/E2-D07; TEN-006 exceeds the 3-day
bound as a single ticket):**
- **TEN-006a** — exhaustive Company-writer sweep + fail-closed writers + shared explicit-org test factory.
- **TEN-006b** — drop the schema default (migration) + the sentinel/unmapped **admission-denial** helper + tests.

**Sentinel dual-identity reconciliation (E2-D07 — REQUIRED reading before implementing):** the
sentinel `00000000-0000-0000-0000-000000000001` is BOTH (a) the FND-007 forbidden
**distributed-admission** sentinel (`distributed-execution-legacy-parity.json:15-19`,
`forbiddenOrganizationSentinels`) AND (b) the legitimate **single-tenant Default Organization**
for self-hosted/`local_trusted` (`organizations.ts` slug `default`, `ensureDefaultOrganization`;
`routes/companies.ts:47-61` deliberately resolves it in the non-enforced branch). TEN-006
therefore:
- Removes only the **fail-OPEN** mechanisms: the `companies.organization_id` **schema default**
  and every **silent** `?? DEFAULT_ORGANIZATION_ID` bucketing — so a writer that omits an
  Organization now **fails closed** (NOT NULL / explicit error).
- **Preserves** the explicit self-hosted default-org resolution (`resolveCompanyOrganizationId`
  non-enforced branch keeps returning the Default Org — now an *explicit*, not silent,
  resolution).
- Scopes the **"sentinel = blocker"** rule to **distributed/new-path admission** (the FND-007
  deny-list at submit/place/lease), **not** to legacy company existence. `sentinel-org-removal`
  asserts **admission denial**, never a global "zero companies on `…0001`".
- **Backfill = no-op scaffold at E2:** in the beta every company legitimately sits on the
  Default Org and no real target orgs exist to remap to; the migration's operative content is
  `ALTER COLUMN organization_id DROP DEFAULT`. Program-design TEN-006's "mapped **or** blocks
  rollout" is satisfied by the **blocks-rollout arm** (unmapped rows are blocked from
  distributed admission; Wave-1). A real company→org backfill activates only when a mapping
  source is provisioned in a later epic.

**Owned files (TEN-006a):** derive the inventory from a **fresh exhaustive** sweep at execution
time (not stale line numbers) — `rg "DEFAULT_ORGANIZATION_ID"` + `rg "INSERT INTO companies"` +
`rg "\.insert\(companies\)"` across `server/`, `packages/`, `cli/`, and all `__tests__`; ~70
company-insert sites omit `organization_id` inline and 13 `.insert(companies)` call sites exist.
Known sites to include: `server/src/services/companies.ts:187` (`resolveCompanyCreationReplay`),
`:334`, `:414` (advisory-lock `hashtext` key — name it, kill the dead `??`), `:434`;
`server/src/services/organizations.ts:101,108` (`ensureDefaultOrganization` — the legitimate
Default-Org seed, keep but audit); `server/src/routes/companies.ts:61` (preserve as explicit
resolution), `:323`; `server/src/services/company-portability.ts:2213` (uses `?? undefined` →
now hits NOT NULL — requires an explicit Organization); `packages/db/src/seed.ts:14/24`.
Add a shared `insertTestCompany({ …, organizationId })` factory and update every test-helper +
the **source-asserting unit tests** that pin the fail-open expression
(`company-service-org-scope.test.ts:14`, `companies-create-org-default.test.ts:10`,
`cloud-auth-cutover.test.ts:38-39`, `companies-org-scope.test.ts:201`) in the same commit.

**Owned files (TEN-006b):** `packages/db/src/schema/companies.ts` (drop `.default(...)`);
migration `0210_*` (`pnpm db:generate -- --name=drop_sentinel_org_default` — this IS a schema
delta, normal `db:generate`; C14 hand-append only the idempotent no-op backfill scaffold +
attributable unresolved-row report); the admission-denial helper (consumes FND-007
`forbiddenOrganizationSentinels`; owned handoff to JOB-001/JOB-010); tests
`packages/db/src/__tests__/sentinel-org-removal.integration.test.ts`,
`server/src/__tests__/company-writer-no-sentinel.integration.test.ts`,
`server/src/__tests__/sentinel-admission-unit.test.ts`.

**Acceptance:** no schema default, seed, route, background job, import, or test helper silently
assigns the sentinel; omitted-Org writers fail closed; the self-hosted Default-Org resolution is
explicit and preserved; unmapped rows are blocked from distributed admission; rollback preserves
the explicit mapping and never restores the fail-open default; `companies.update` keeps
stripping `organizationId` (unchanged).

**TDD:** RED — `company-writer-no-sentinel.integration.test.ts`: each writer with no
Organization now fails closed (before change it buckets to sentinel → assertion fails).
`sentinel-org-removal.integration.test.ts`: post-migration no column default; admission helper
rejects a sentinel/unmapped Org (mirror `forbiddenOrganizationSentinels`); self-hosted
Default-Org resolution still succeeds (not flagged as a blocker). GREEN — sweep + drop default +
helper + explicit test factory. Commit per half; `TEN-006[a/b]-result.md`. **Maps to:** D0-T01,
D0-T04, H-01 (no implicit tenant).

---

### TEN-002 — Non-owner database role and forced RLS harness (M) — BLOCKED on E2-D01 + E2-D03

**Depends on:** TEN-001. **BLOCKED until E2-D01 locked + E2-D03 confirmed (E2-F001/E2-F002).**

**Owned files:** `server/src/db/rls-tenant.ts` (policy/role SQL builders; role-name safety via
`assertSafeRoleName`); `packages/db/src/client.ts` (add `createTenantAppDb(url)` non-owner pool
factory + config; keep `createDb` for the privileged/migration path); `server/src/index.ts`
(privileged boot phase: migrate + provision role login credential under the privileged role,
**then** open the non-owner serving pool — flag-gated per E2-D03); migration
`0211_tenant_rls_enforcement.sql` created **delta-free** via
`cd packages/db && pnpm exec drizzle-kit generate --custom --name=tenant_rls_enforcement`, then
**C14 hand-append** the role/GRANT/ENABLE/FORCE/POLICY SQL (E2-D01 — with this repo's config,
drizzle-kit emits **none** of ENABLE/POLICY/FORCE/GRANT/ROLE for these tables, so the entire
block is hand-appended into the custom stub); tests
`server/src/__tests__/tenant-rls-enforcement.integration.test.ts`,
`server/src/__tests__/tenant-rls-enforcement-unit.test.ts`.

**RLS DDL (C14 hand-appended into the `--custom` stub — idempotent, `DO $$` guarded):**
```sql
-- Tenant RLS enforcement for the new-path tables. Delta-free `--custom` migration: CREATE ROLE
-- / GRANT / ENABLE+FORCE ROW LEVEL SECURITY / CREATE POLICY are cluster/security DDL that
-- drizzle-kit generate cannot emit (verified). Idempotent (IF NOT EXISTS / DROP … IF EXISTS /
-- duplicate_object guard) so re-apply under the migration advisory lock is a no-op.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_app') THEN
  CREATE ROLE "aoa_app" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;  -- login credential provisioned at boot (E2-D01)
END IF; END $$;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "jobs","job_attempts","leases","workers","services","service_instances","job_artifacts","job_secret_handles" TO "aoa_app";--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "jobs_tenant_isolation" ON "jobs";--> statement-breakpoint
CREATE POLICY "jobs_tenant_isolation" ON "jobs" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);--> statement-breakpoint
-- … repeat ENABLE+FORCE+POLICY per new-path table; workers additionally get an operator policy
--    admitting organization_id IS NULL only to the distinct operator role (never a tenant GUC).
```

**Security model (corrected — E2-F004):** the DB-enforcement guarantee is that the serving pool
authenticates as **`aoa_app` (non-owner, NOSUPERUSER, NOBYPASSRLS)** — plain RLS filters it.
`FORCE ROW LEVEL SECURITY` only removes a **non-superuser table owner's** exemption
(superusers/BYPASSRLS always bypass RLS regardless of FORCE); it is defense-in-depth against a
non-superuser-owner serving mistake. Provisioning must never grant SUPERUSER/BYPASSRLS/CREATEDB
to `aoa_app`.

**Fail-closed pool (E2-F007):** `createTenantAppDb` **throws** on a missing/blank
`AOA_APP_DATABASE_URL` and **never** falls back to `createDb` (the owner pool) — a fallback
would run new-path queries as a superuser bypassing RLS (total H-01 fail-open). Boot asserts the
non-owner pool's role reports `NOT rolsuper AND NOT rolbypassrls`.

**TDD:**
- [ ] Precondition — E2-D01 `locked` + E2-D03 confirmed; else STOP + finding.
- [ ] RED — `tenant-rls-enforcement.integration.test.ts` (env-hatch pattern, connect as `aoa_app` via cred-swap like `rls-canary.integration.test.ts:116`): (a) **FORCE applied** — `SELECT relforcerowsecurity FROM pg_class WHERE relname IN (…)` all `true`; (b) `aoa_app`, no GUC → 0 rows; (c) `runInTenant(ORG_A)` → only ORG_A rows; (d) wrong org → 0; (e) cross-tenant INSERT (GUC=ORG_A, row=ORG_B) → rejected by `WITH CHECK`; (f) a purpose-built **non-superuser owner** role is filtered under FORCE without a GUC (proves FORCE behaviorally on the only role it can bind); (g) `aoa_app` cannot INSERT/UPDATE a row to `organization_id IS NULL`; (h) a tenant GUC never returns a null-Org platform worker row. FAIL before DDL.
- [ ] RED — `tenant-rls-enforcement-unit.test.ts`: policy-SQL builder emits `FORCE` + `current_setting('aoa.organization_id', true)::uuid`; rejects an unsafe role name; `createTenantAppDb` throws on blank URL. FAIL.
- [ ] GREEN — author `rls-tenant.ts` + `createTenantAppDb` + boot phase (flag-gated); `drizzle-kit generate --custom --name=tenant_rls_enforcement`; C14 hand-append the idempotent DDL; prove `applyPendingMigrations` twice = no-op. Build; re-run → PASS.
- [ ] Commit — one commit; `TEN-002-result.md`.

**Maps to:** D0-T01, D0-T04 (policy/role validator), **H-01 (HARD)**. Owner-cred-absence is a
TEN-002 acceptance certified in the **flag-ON** config (E2-D03) — not claimed for the flag-OFF
default.

---

### TEN-003 — Mandatory transaction tenant context (M)

**Depends on:** TEN-002. **Owned files:** `server/src/db/with-tenant-tx.ts` (generalize to expose
tenant repositories only inside the callback, over the non-owner pool);
`server/src/db/tenant-context.ts` (`runInTenant(organizationId, fn(repos))`); the new-path
entry points that touch new-path tables (route through the wrapper); tests
`server/src/__tests__/tenant-tx-context.integration.test.ts`,
`server/src/__tests__/tenant-tx-context-unit.test.ts`.

**Scope note (mirrors E2-D04):** at E2 the HTTP/scheduler/reconciliation/worker-event paths do
not yet touch new-path tables (those are E3/E4). TEN-003 delivers the `runInTenant` wrapper +
the pool-reuse/rollback/nested/background **property proofs**; real entry-point adoption is a
forward declaration that rides E3+. The acceptance clause "those paths use the wrapper" is
satisfied at E2 by the wrapper existing + the property proofs; a gate note records this.

**Interfaces:**
```ts
export async function runInTenant<T>(organizationId: string, fn: (repos: TenantRepositories) => Promise<T>): Promise<T>;
// appDb.transaction(tx => { set_config('aoa.organization_id', $org, true); return fn(tenantRepositories(tx)); })
// tx/repos MUST NOT escape the callback (returned value is data only).
```

**Acceptance:** transaction-local GUC (`is_local => true`) prevents bleed across pooled
`postgres-js` connections; concurrent two-tenant rows disjoint; nested tx inherits; background
job opens its own `runInTenant`.

**TDD:** RED — `tenant-tx-context.integration.test.ts` with the app pool pinned to **`max: 1`**
(so the reuse case is real — postgres-js defaults to 10 and would otherwise land on different
physical connections and pass vacuously): (a) ORG_A/ORG_B interleaved → disjoint; (b) after a
`runInTenant` commit **and** after a rollback, the next call on the **same** connection reads
`current_setting('aoa.organization_id', true)` empty; (c) nested inherits; (d) a path without a
wrapper reads 0 new-path rows (forced RLS). FAIL before wiring. GREEN — implement; re-run →
PASS. Commit; `TEN-003-result.md`. **Maps to:** D0-T01, D0-T02, **H-01 (HARD)**.

---

### TEN-005 — Tenant adversarial property suite (M) — surface scope E2-D04 / finding E2-F003

**Depends on:** TEN-003, TEN-004. **Owned files:**
`server/src/__tests__/tenant-adversarial.property.integration.test.ts` (env-hatch,
seed-reproducible); `server/src/testing/tenant-graph.ts` (deterministic seeded generator +
hostile-identifier corpus + a **surface registry** later epics extend); unit
`server/src/__tests__/tenant-graph-unit.test.ts`.

**Acceptance (E2-D04):** generate randomized Org/Company/job graphs from a fixed seed set;
attempt cross-tenant identifiers through **E2-available surfaces** — repositories via
`runInTenant`, HTTP endpoints touching new-path tables, composite-constraint direct-SQL bypass,
object-key **format**. Every operation **fails closed without disclosing existence**: assert the
**error/denial shape is identical** across a cross-tenant read, a cross-tenant write, and a
truly-absent row (via the tenant-repository uniform-denial normalization — §1), so no guard's
identity (FK vs RLS vs not-found) leaks. Also assert no tenant GUC returns a null-Org platform
row. Failures are audited where a sink exists. The suite is designed so later epics register
worker-events/WebSockets/object-commit/placement/restore surfaces; the **full D1-floor
cross-surface run is owned by the D1 gate**.

**TDD:** RED — property test over N seeds × K ops asserts zero cross-tenant / zero-disclosure +
identical denial shape; assert the harness actually issues cross-tenant attempts (not vacuous).
GREEN — implement generator + surface drivers + uniform-denial + audit assertions; run with the
fixed seeds → PASS; record seeds. Commit; `TEN-005-result.md` (record the E2-D04 surface-scope
note + that admission denial is a unit/harness proof at E2, end-to-end at E3). **Maps to:**
D0-T01, **H-01 (HARD)**, D1-01 (partial, E2-available surfaces only).

---

## 4. E2 integration gate (separate gate-owner subagent — no self-certification)

Run by a fresh **Integration Gate Owner subagent** that implemented/reviewed no ticket, on one
exact revision after all ticket results are `complete` (approved by distinct reviewers).

**Preconditions:** all `TEN-00X[-a/b]-result.md` at `Status: complete` with `approved` latest
reviews; E0 + E1 handoffs present + `pass`; E2-D01 locked (promoted to
`docs/architecture/decisions.md`); E2-D03 operator-confirmed; findings dispositioned.

**Procedure:**
1. Capture the `DEC-03` pre-existing-failure baseline at `df509b946` → `qa/pre-existing-failure-baseline.md` (Windows-local = advisory seed; Linux CI = formal authority).
2. Focused re-run of each ticket's acceptance on the reviewed revision.
3. **D0 rollup (`D0-R01..R04`):** `pnpm -r typecheck`, `pnpm test:run`, `pnpm -r build`, authoritative root `pnpm build` (network-free; tracked bytes unchanged); critical suites (TEN-002/003/004/005 + company-writer) **three consecutive** times; byte-clean worktree.
4. **H-01 proof:** run the tenant/company-writer suites via `AOA_RUN_WIN_INTEGRATION=1` (Windows-local) **and obtain at least one real Linux execution** (a `workflow_dispatch` on `pr.yml` or a scratch PR to a throwaway branch) pinned as the formal H-01 evidence — the non-waivable invariant must not rest on Windows-only console output (E2-F008/E2-D05). Record zero cross-tenant / zero-disclosure across all E2-available surfaces (E2-D04). **Any H-01 failure = non-waivable `fail`.**
5. Immutable QA record `qa/<UTC>-d0-e2-tenant-kernel-<sha12>-a1.md` (EVID-01..03) + completion handoff `handoffs/<UTC>-epic-completion-<sha12>-a1.md` (`Decision: pass|fail`), pinning each ticket-result blob SHA + reviewed impl SHA. Record explicitly: legacy tables remain app-layer-only isolated (H-01 "green" is DB-enforced for new-path only — CAV-005); sentinel admission denial is dormant until E3 (JOB-001/JOB-010).
6. Only on committed `Result: pass` + `Decision: pass` on one revision: flip E2 `gate_review → complete` in `README.md` + the epics index, commit evidence, then `git push origin HEAD:docs/replatform-program` (fetch + verify `origin/docs/replatform-program` is an ancestor of HEAD; never force-push; if diverged, STOP + report).

---

## 5. D0 / HARD / INITIAL mapping

| Requirement (`test-gates.md`) | Where satisfied |
|---|---|
| **H-01 tenant isolation (HARD)** | TEN-002 (non-owner+NOSUPERUSER+forced RLS denial), TEN-003 (mandatory context, no pool leak), TEN-004 (composite integrity), TEN-005 (adversarial + uniform-denial) — proved at the E2 gate incl. a real Linux run. |
| D0-T01 focused acceptance | every ticket. |
| D0-T02 lifecycle ownership | TEN-003 (tenant-context lifecycle). |
| D0-T04 schema/protocol | TEN-001/004/006 (migration integration); TEN-002 policy/role SQL. |
| D0-T03 secret/path validator | **N/A for E2** — E2 owns no secret/path validator (`assertSafeRoleName` is reused, not new); those arrive with secret canaries/object keys in later epics. |
| D0-T05 hermetic | all tests use embedded-Postgres; no network/provider/live creds. |
| D0-R01..R04 rollup | §4 gate. |
| DEC-01/DEC-03 | §4: baseline at `df509b946`; H-01 failure non-waivable; Linux CI = formal authority + ≥1 real Linux run (E2-D05); Windows-local operator-directed. |
| TEN-002 acceptance "owner/superuser creds absent from app container" | Delivered/certified **flag-ON** (E2-D03); the flag-OFF default is an explicitly labeled interim (NOT claimed as H-05). |
| D1-01 tenant property floor | TEN-005 partial (E2-available surfaces, E2-D04); full floor owned by the D1 gate. |

(H-05 — worker/host boundary, `test-gates.md:29` — is **not** an E2 deliverable; do not map the
owner-cred question to it.)

---

## 6. Self-review (planner, revision a2)

- **Spec coverage:** TEN-001 (tables+repos), TEN-002 (non-owner+NOSUPERUSER role + forced RLS), TEN-003 (mandatory tx context), TEN-004 (composite integrity, every relationship + `run`=`job_attempts`), TEN-005 (adversarial + uniform-denial), TEN-006 (sentinel removal + backfill scaffold + admission denial, dual-identity reconciled) — all mapped. Security invariants (non-owner role, one mandatory Org context, composite FKs, secret-handle ownership, platform null-Org operator-only) mapped.
- **Rule #1 / C14:** tables/FKs via `db:generate`; the RLS block via a `--custom` (delta-free) migration + C14 hand-append (E2-D01, locked before TEN-002). No hand-authored schema DDL.
- **CAV-005:** no legacy table gets RLS; legacy stays on `assertCompanyAccess`; the additive `companies` org-unique is CAV-005-safe. New enforcement is new-path only.
- **Corrected by review (a2):** FORCE-vs-superuser semantics (E2-F004); delta-free `--custom` migration; sentinel dual-identity + TEN-006 sweep/split (E2-F005/F006); fail-closed non-owner pool (E2-F007); TEN-005 uniform-denial; operator null-Org read; flag-ON owner-cred certification; ≥1 real Linux H-01 run (E2-F008); partial-unique = `uniqueIndex().where()`; DoR caveat/credential line; README `planning`; D0-T03 N/A.
- **Rejected review findings (verified errors):** next migration IS `0207` (not 0204); `forbiddenOrganizationSentinels` IS present in FND-007 (`distributed-execution-legacy-parity.json:15-19`).
- **Type/name consistency:** GUC `aoa.organization_id`; role `aoa_app`; `runInTenant`/`tenantRepositories`/`createTenantAppDb` consistent across TEN-001/002/003.
- **DoR:** each ticket names outcome+non-goals, dependencies, owned files, interfaces, failure/acceptance, focused RED/GREEN commands + affected-package typecheck/build, migration/compat, observability, rollback/disable, caveat/credential impact, ≤3 agent-days (TEN-001 + TEN-006 split), evidence, commit boundary.
- **Assignability gate:** TEN-002 blocked on E2-D01 lock + E2-D03 confirm (E2-F001/F002) — surfaced for the operator before any code.
