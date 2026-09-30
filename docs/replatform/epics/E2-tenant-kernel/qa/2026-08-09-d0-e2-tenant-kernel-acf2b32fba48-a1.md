# QA — D0 — E2 tenant-kernel — `acf2b32fba48` — a1

## EVID-01 — Record identity

| Field | Value |
|---|---|
| **Record path** | `docs/replatform/epics/E2-tenant-kernel/qa/2026-08-09-d0-e2-tenant-kernel-acf2b32fba48-a1.md` |
| **Date (UTC)** | `2026-08-09` |
| **Epic** | `E2-tenant-kernel` |
| **Lane** | `D0` (per-ticket focused acceptance + immutable D0 rollup) |
| **Scope** | `e2-tenant-kernel` |
| **Attempt** | `1` |
| **Supersedes** | `none` |
| **Exact revision (40-char)** | `acf2b32fba480aa5d440e9606e20c3b542544d5d` |
| **E2 Start SHA (base, bare)** | `df509b946c5b5342c3aba4ae2bcab28a7aad835d` |
| **Topology** | Windows-local, embedded-Postgres (`embedded-postgres@18.1.0-beta.16`, PG 18.1), `initdbFlags: ["--encoding=UTF8","--locale=C"]`; hermetic (no network/provider/live creds). |
| **Image digests / provider / template versions** | `not_applicable` — E2 constructs no distributed runtime, container image, or provider; all tests use in-process embedded-Postgres. |
| **Protocol contract hash** | `not_applicable` at E2 (no worker wire protocol change; PRT-006/007 stay context-free). |
| **Feature flags** | Non-owner serving-pool cutover is behind the FND-005 distributed-execution disable flag (dormant-by-default, flag-OFF); new-path repositories always use the non-owner pool + forced RLS (E2-D03). Tenant integration suites gated by the `AOA_RUN_WIN_INTEGRATION` env-hatch (E2-D05). |
| **Config hashes / toolchain** | `node v24.14.0`, `pnpm 9.15.4`, `vitest 3.2.6`, `drizzle-orm 0.45.2`, `drizzle-kit 0.31.10`. Migration journal at idx 212 (`0212_fk_dedup_tenant_oracle`); E2 owns `0207`–`0212`. |
| **Gate owner role** | `Integration Gate Owner` (implemented/reviewed no E2 ticket). |
| **Gate owner identity** | `E2 integration-gate owner subagent (Claude)`. |
| **Result** | **`blocked_external`** |

> Write-once from first commit (EVID-02). Every locally-runnable REQUIRED / HARD (H-01) /
> INITIAL condition **passes** on this revision; the sole outstanding requirement is the
> mandatory **≥1 real Linux execution of the H-01 suites** (E2-D05 / E2-F008), an operator-gated
> CI action the gate owner must not trigger. Its required lane has **not started**, so the H-01
> Linux lane is `blocked_external` and the overall Result is `blocked_external` — **not** `pass`
> (nothing has passed the Linux lane yet), **not** `fail` (nothing failed). A superseding `a2`
> record will record `pass` once the Linux run is green.

## Ticket + review integrity (independently re-verified)

All 8 E2 ticket ledgers are `Status: complete` with a latest `Disposition: approved`, an
Independent-review block whose **Reviewer ≠ Implementer** (every ticket's implementer =
`claude-opus (implementer subagent)`; each reviewer is an explicitly distinct subagent), and a
**Reviewed revision that is a 40-hex commit ancestor of HEAD** (`git merge-base --is-ancestor`
= true for each; `git cat-file -t` = commit). Ticket-result blob SHAs recomputed with
`git rev-parse HEAD:<path>`.

| Ticket | Ticket-result blob SHA (`git rev-parse HEAD:<path>`) | Reviewed impl SHA (ancestor of HEAD) | Latest disposition |
|---|---|---|---|
| TEN-001a | `9e3f922879d0cdb5d7010e40b7a2128b205e0102` | `b5a9e8178c4bcc3fb0c72b564a858b06fad1ddc0` | `approved` |
| TEN-001b | `b4fd200929bc6493ad4333dff41182f302c691de` | `f9b37cd98e195e57f65eeb9d04f330b933b0dc74` | `approved` |
| TEN-002 | `bffc21baa481b3d2316aaa131d19dda83cb474a2` | `0b22d3934396c6c2bb6f3844800696c0fc38f233` | `approved` |
| TEN-003 | `ab5b28894d631fe74f971761e8119b2ff905945a` | `10592fc0b5cd9f759fb24d0fc2e15e908d4d7653` | `approved` |
| TEN-004 | `9fbd065157039c523d0ed1f35aad17b0f59903b5` | `bd4fe0283cce23f3e0983340435c14749a7a0c73` | `approved` |
| TEN-005 | `762fdc3ad2860afbb1b719e312313aa93564715b` | `3f994fd6b1c1c3d9c51fb7242f3bde0426437aac` | `approved` (attempt 2; attempt 1 `changes_requested` → E2-F013 fixed) |
| TEN-006a | `1ed2724d6043a8e1c7bbd0b6fc008fefc0d0d8ba` | `324e62ca64045c12f0aacba01afe454e6decdb9d` | `approved` (attempt 2; attempt 1 `changes_requested` → E2-F010 fixed) |
| TEN-006b | `3a89564dfad9c2fa80e0f76340dded345173c47c` | `a269f8bd2cd15a90c26c61784c473033ab229872` | `approved` |

**Findings:** E2-F001…F013 all Resolved / resolved-by-design / non-blocking accepted caveat.
E2-F001/F002 (locked E2-D01/E2-D03). E2-F004/F005/F006/F007 resolved by plan revision a2.
E2-F009 = build-ordering setup artifact (see baseline; corrected — plugin-sdk is present).
E2-F010 (TEN-006a service-writer sweep) RESOLVED at `324e62ca6`. E2-F011 (stale packages/db
source-assert) RESOLVED inline. E2-F012 (reused-connection 22P02 fail-closed) resolved-by-design.
E2-F013 (composite-vs-single FK existence oracle) RESOLVED at the DB level via E2-D09 / migration
`0212`. **E2-F008 (≥1 real Linux H-01 run) — OPEN, gate-external, the sole blocker below.**

## Requirement → evidence → result

| Requirement ID | Class | Required value/condition | Observed value | Evidence | Result |
|---|---|---|---|---|---|
| **H-01** — tenant isolation | **HARD** | Zero cross-Organization / unauthorized cross-Company reads, writes, deletes, existence disclosures; forced RLS; mandatory context; composite integrity; uniform denial. | **Windows-local: PASS, 3× deterministic.** TEN-002 rls-enforcement 10/10 (FORCE+ENABLE on all 8 tables via `pg_class`; no-GUC→0; GUC=A→only A; wrong-org→0; cross-tenant INSERT→42501 `WITH CHECK`; null-Org write rejected; no tenant GUC returns null-Org platform worker; `assertNonOwnerConnection` passes aoa_app NOSUPERUSER+NOBYPASSRLS / throws superuser; non-superuser-owner filtered by FORCE). TEN-003 tx-context 7/7 (no pool leak; reused-conn fail-closed). TEN-004 composite 9/9 (every composite relationship rejected `23503`; partial-unique one-active-lease `23505`) + ondelete 4/4 (CASCADE children→0; company-with-job/service delete RESTRICT `23001` on composite FK). TEN-005 adversarial 11/11, 8 seeds, `totalOps=4460`, `crossParentVsAbsentUniform=216` (cross-tenant vs absent parent → SAME composite FK + byte-identical deepest message), non-vacuous, non-owner serving, deterministic across 3 runs. **Linux lane: NOT STARTED (E2-D05 / E2-F008).** | `srv-crit-run{1,2,3}.log`, `db-crit-run{1,2,3}.log` | **Windows-local `pass`; Linux lane `blocked_external`** |
| **D0-T01** — Focused acceptance | REQUIRED | Each ticket's focused tests + affected-package typecheck/build once, zero failures. | Re-verified per ticket via the critical-suite runs (below) + ticket ledgers; db typecheck/build 0; server typecheck 0 (packages built). | critical-suite logs; `typecheck.log`; `r-build.log` | `pass` |
| **D0-T02** — Lifecycle ownership | REQUIRED | Lifecycle-owning ticket tests legal/illegal transitions. | TEN-003 owns the `runInTenant` tenant-context lifecycle: commit/rollback/nested/background reuse over a `max:1` pool; `(d)/(d2)` pristine-0-rows vs reused-connection 22P02 fail-closed. 7/7. | `srv-crit-run*.log` | `pass` |
| **D0-T04** — Protocol/schema ownership | REQUIRED | Schema-changing tickets cover every valid/invalid conformance vector. | TEN-001/004/006 migration integration (`0207`–`0212`): schema/composite-FK/ondelete/idempotency 37 db tests; migration idempotency 5/5; E2-D08 verbatim reorder proven; E2-D09 oracle dedup (`0212`). TEN-002 policy/role SQL builder unit 15 + config 15. | `db-crit-run*.log`, `srv-crit-run*.log` | `pass` |
| **D0-T03** — Validator ownership | REQUIRED | ≥10,000 vectors for an owned secret/path validator. | `not_applicable` for E2 — E2 owns no new secret/path validator (`assertSafeRoleName` is reused, not new; per plan §5). Secret canaries/object keys arrive in later epics. | plan §5 | `recorded` |
| **D0-T05** — Hermetic inputs | REQUIRED | No network provider, customer data, or live credential. | All suites boot in-process embedded-Postgres; no network/provider/secret. | topology | `pass` |
| **D0-R01** — Repository verification | REQUIRED | `pnpm -r typecheck` + `pnpm test:run` + `pnpm -r build` on the exact revision; DEC-03-governed; workspace packages built first. | `pnpm -r typecheck` **exit 0** (0 `error TS`). `pnpm -r build` **exit 0** (`@armyofagents/db` + server clean). `pnpm test:run` **exit 1** — **1 failed FILE** (`packages/worker-protocol/src/cross-version.test.ts`, non-E2, DEC-03 baseline B1), **18795 passed / 662 skipped, 0 failed test bodies**. **Zero E2-changed file** in any failure/typecheck error (grep-confirmed). | `typecheck.log`, `r-build.log`, `testrun.log`, `pre-existing-failure-baseline.md` | `pass` (DEC-03: the single failure is baseline B1, non-epic-touched) |
| **D0-R02** — Authoritative root build | REQUIRED | Root `pnpm build` passes network-free; zero tracked-byte change. | Root `pnpm build` (= `pnpm -r build`) **exit 0**; `git status --porcelain` empty before and after; `git diff --check` clean. | `root-build.log` | `pass` |
| **D0-R03** — Critical-suite stability | REQUIRED | Each designated critical suite passes 3 consecutive runs, zero flaky/retried. | DB group (7 files/37 tests): runs 1/2/3 exit 0, all `37 passed`. Server group (8 files/74 tests incl. TEN-002/003/005 + company-writer + units): runs 1/2/3 exit 0, all `74 passed`, `totalOps=4460` identical each run. **No flake, no re-run needed** (no EACCES port flake encountered). | `db-crit-run{1,2,3}.log`, `srv-crit-run{1,2,3}.log` | `pass` |
| **D0-R04** — Clean retained evidence | REQUIRED | Byte-clean worktree after the gate; commands/exits/counts retained. | `git status --porcelain` empty; `git diff --check` clean after all runs. All commands + exit codes + counts retained in the logs referenced here. | `git status` | `pass` |
| **DEC-01** — Gate decision | REQUIRED | Owner records pass/fail/blocked_external on one revision; REQUIRED failure is fail unless DEC-03-covered; no hard-invariant failure. | Zero hard-invariant failure. The one `test:run` file failure is DEC-03 baseline B1 (non-epic-touched). No locally-runnable REQUIRED/HARD/INITIAL failure. The H-01 **Linux** lane has not started → `blocked_external` per the DEC-01 definition (external environment prevents a required lane from starting after every locally-runnable condition passed). | this record | `blocked_external` |
| **DEC-03** — Pre-existing-failure baseline | REQUIRED | REQUIRED-suite failures ⊆ attributed baseline in the gate environment; new/epic-touched failure is fail. | Windows-local advisory seed committed at `pre-existing-failure-baseline.md`; the single `test:run` failure (B1, worker-protocol cross-version) is attributed, byte-unchanged since the Start SHA, and non-E2-touched. E2-F009 plugin-sdk corrected to a build-ordering artifact (packages present + built → `-r` lanes clean). No E2-touched genuine failure. | baseline record | `pass` |
| **E2-D04** — TEN-005 surface scope | OBSERVED | Record the E2-available surface set (no silent cap). | Covered at E2: tenant **repositories** via the non-owner pool + `runInTenant`; **composite-constraint direct-SQL** bypass; object-key **format**; null-Org platform-row denial. **Deferred** to later epics (D1 floor): HTTP endpoints touching new-path tables (none wired at E2), worker events, WebSockets, placement, object-commit, restore. Full D1-01 cross-surface floor (20 seeds × 10,000 ops × ≥10 Orgs) owned by the **D1 gate**. | plan §TEN-005; decisions.md E2-D04 | `recorded` |
| **D1-01** — Tenant property floor | INITIAL | 20 seeds × 10,000 ops × ≥10 Organizations (D1 gate). | `not_applicable` at E2 — TEN-005 is the E2-available-surface partial (8 seeds × 4460 ops); the full D1 floor runs at the D1 gate (E2-D04). | decisions.md E2-D04 | `deferred (D1 gate)` |
| **TEN-002 owner-cred-absence** | REQUIRED | "owner/superuser credentials absent from the application container." | Certified **flag-ON** only (E2-D03): `createTenantAppDb` throws on blank `AOA_APP_DATABASE_URL` (fail-closed, never falls back to the owner pool); boot asserts the serving role is `NOT rolsuper AND NOT rolbypassrls` (`assertNonOwnerConnection`, test (i)). Flag-OFF default is an explicitly-labeled interim, NOT claimed. Not H-05. | rls-enforcement (i); decisions.md E2-D03 | `pass (flag-ON)` |

## CAV-005 / scope notes recorded (per plan §4 step 5)

- **Legacy tables remain app-layer-only isolated.** H-01 is DB-enforced (RLS + FORCE + non-owner
  role) for the **new-path** tenant tables only. The ~129 legacy `companyId` tables keep their
  `assertCompanyAccess` (556 sites) + `tenantIsolationEnforced()` + the `company_secrets` canary;
  no legacy RLS retrofit (CAV-005). The non-owner role is GRANT'd full DML on legacy tables with
  no RLS there (behavior-identical).
- **Sentinel admission denial is dormant until E3.** TEN-006's `forbiddenOrganizationSentinels`
  admission-denial helper (`server/src/services/tenant-admission.ts`) is unit-proven but has no
  runtime caller at E2; it is wired end-to-end by JOB-001/JOB-010 (E3). At E2 only "cannot own
  objects" (via `organization_id NOT NULL` on the new-path tables) is runtime-enforced. The
  self-hosted Default-Org resolution is preserved as an **explicit** (no longer silent)
  resolution (E2-D07).
- **E2-F012 NULLIF hardening deferred to E3.** The TEN-002 policy predicate carries no `NULLIF`;
  a reused-connection un-wrapped read fails closed by throwing `22P02` (never leaks rows). No
  H-01 gap at E2 (policies dormant; runtime always sets a valid uuid inside `runInTenant`).

## Failure classification

- **Product failures:** none.
- **Hard-invariant (H-01) failures:** none (Windows-local, 3× deterministic).
- **Harness/environment:** DEC-03 baseline B1 (`worker-protocol/cross-version.test.ts`,
  vitest-transform/Windows artifact; non-E2). Plugin-sdk isolated `--filter` failure = build-order
  artifact (packages present + built → `-r` lanes clean).
- **Outstanding required lane (not started):** the H-01 **Linux** execution (E2-D05 / E2-F008).

## Cleanup

Worktree byte-clean (`git status --porcelain` empty; `git diff --check` clean). Embedded-Postgres
instances are per-suite ephemeral; no residual process or datastore. No provider resources (none
created). No generated logs/traces committed.

## Decision

**`blocked_external`.** All locally-runnable REQUIRED / HARD (H-01) / INITIAL conditions pass on
`acf2b32fba480aa5d440e9606e20c3b542544d5d`. The sole outstanding requirement is the mandatory
≥1 real Linux execution of the H-01 suites (E2-D05 / E2-F008), which the gate owner must not
trigger. Per `test-gates.md` DEC-01 and `artifact-policy.md`, `blocked_external` does not promote
the epic — E2 remains in `gate_review`. A superseding `a2` QA record will record `pass` once the
Linux H-01 run is green.
