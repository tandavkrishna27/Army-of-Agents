# TEN-003 Result — Mandatory transaction tenant context

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E2-tenant-kernel`
**Plan task:** `TEN-003 — Mandatory transaction tenant context (M)`
**Implementer:** `claude-opus (implementer subagent)`
**Start SHA:** f730c2c2219329c34996678c0f4217ad358dd181

The Start SHA is the actual `git rev-parse HEAD` of the C:\e2 worktree captured
before the first change. Plan §0 lists `df509b946` as the "E2 Start SHA"; that
commit is an ancestor of this HEAD (TEN-001a/b, TEN-004, TEN-006a/b, TEN-002 +
E2-F011 fix have since landed). Mirrors the TEN-001/002/004/006 convention.

**Preconditions verified:** TEN-002 is `complete` (non-owner `aoa_app` role +
FORCE RLS + per-table policies + the `createTenantAppDb` fail-closed pool factory +
migration `0211` are on the branch — `runInTenant` reuses all of it). E2-D02 (GUC
`aoa.organization_id`) and E2-D04 (E2 wrapper + property proofs; adoption rides E3)
govern this ticket.

## Delivered scope

- **`server/src/db/tenant-context.ts`** — the mandatory Organization context wrapper:
  ```ts
  runInTenant<T>(appDb: Db, organizationId: string, fn: (repos: TenantRepositories) => Promise<T>): Promise<T>
  ```
  Implemented as `withTenantTx(appDb, organizationId, (tx) => fn(tenantRepositories(tx)))` —
  it opens a transaction on the **caller-supplied NON-OWNER pool** (`createTenantAppDb`,
  role `aoa_app`), writes the transaction-local `aoa.organization_id` GUC via the proven
  writer (org bound as a query **parameter**, never interpolated), builds the tenant
  repositories from that transaction, and runs `fn`. The tx/repos never escape the
  callback — only `fn`'s DATA result is returned. `organizationId` is validated as a
  non-empty string **before** opening a transaction (fail closed — never
  `set_config('aoa.organization_id', '')`, which would make a later `''::uuid` cast
  throw). Docstring records the mandatory-context contract, the transaction-local
  no-leak guarantee, and the E2-D04 scope note.
- **`server/src/db/with-tenant-tx.ts`** — **comment-only** update: the stale `NOTE (M3)`
  docblock ("defense-in-depth only; app connects as owner/superuser; GUC has no effect")
  is replaced with the TEN-002 reality — for the 8 new-path tables served by the
  non-owner `aoa_app` role under FORCE RLS the GUC is the **LIVE** filter (a query with
  no GUC sees zero rows); the legacy `company_secrets` canary remains owner-exempt/inert.
  **Function behavior is byte-for-byte identical** (`git diff` shows only the docblock
  changed) — `runInTenant` depends on it.
- **`packages/db/src/client.ts`** — `createTenantAppDb(url, opts?: { max?: number })`:
  additive optional `max` forwarded to `postgres()` (default behavior unchanged when
  omitted). Used by the integration test to pin the app pool to a single physical
  connection so the pooled-reuse no-leak proof is real, not vacuous. `createDb`
  untouched; the fail-closed blank-URL throw (E2-F007) unchanged.
- **`packages/db/src/index.ts`** — re-export `tenantRepositories` + type
  `TenantRepositories` from the package barrel so the server's `runInTenant` imports
  them as a bare `@armyofagents/db` specifier (alongside `createTenantAppDb`/`Db`). The
  tenant repository module's OWN surface is unchanged (still exactly one export) — this
  adds no raw unscoped reader.
- Two tests: `tenant-tx-context-unit.test.ts` (Windows-visible; wrapper contract) and
  `tenant-tx-context.integration.test.ts` (E2-D05 env-hatch embedded-PG; property proofs
  a–e over the max:1 non-owner pool).

**E2-D04 scope note (mirrored):** at E2 no HTTP / scheduler / reconciliation /
worker-event path calls `runInTenant` yet — those tables are E3/E4 and **real
entry-point adoption is a forward declaration that rides E3+**. TEN-003 delivers the
wrapper + the pool-reuse / rollback / nested / background property proofs now; adoption
is E3. No route/scheduler was wired (dormant per E2-D04).

**Non-goals preserved:**
- `withTenantTx` BEHAVIOR unchanged (comment only). RLS migration/schema, TEN-002's
  `rls-tenant.ts` builders, `createDb`, `rls-bootstrap.ts`, `assertCompanyAccess` all
  untouched. No legacy RLS retrofit (CAV-005).
- `runInTenant` NOT wired into any route/scheduler at E2 (E2-D04 — dormant).
- No new dependency; **no `package.json`/`pnpm-lock.yaml` change** (AGENTS §7 N/A).
- Caveat/credential/target impact: *N/A — E2 introduces no placement, credential,
  provider, or locality logic; CAV-005: no legacy RLS retrofit; provider-neutral seam
  untouched.*

## Changed files

| File | Responsibility |
|---|---|
| `server/src/db/tenant-context.ts` | **New.** `runInTenant` mandatory Organization context wrapper. |
| `server/src/db/with-tenant-tx.ts` | Comment-only: stale `NOTE (M3)` docblock → TEN-002 live-filter reality. Behavior identical. |
| `packages/db/src/client.ts` | `createTenantAppDb` gains optional `{ max?: number }` (additive; default unchanged). |
| `packages/db/src/index.ts` | Re-export `tenantRepositories` + `TenantRepositories` from the barrel. |
| `server/src/__tests__/tenant-tx-context-unit.test.ts` | **New.** Windows-visible wrapper-contract unit proof. |
| `server/src/__tests__/tenant-tx-context.integration.test.ts` | **New.** Embedded-PG property proofs (a–e) over the max:1 non-owner pool. |

## Acceptance evidence

Integration suite `tenant-tx-context.integration.test.ts`, embedded-PG,
`AOA_RUN_WIN_INTEGRATION=1` → **7 passed**. Seeds two orgs + a company + a job in
each; `aoa_app` LOGIN provisioned in-test as superuser (migration left it NOLOGIN);
the app pool is `createTenantAppDb(url, { max: 1 })` (single physical connection, so
the reuse proof is real). Unit sibling → **6 passed**.

| Acceptance condition (plan §TEN-003 / task a–e) | Evidence | Result |
|---|---|---|
| (a) `runInTenant(ORG_A)` returns ONLY ORG_A rows; `runInTenant(ORG_B)` ONLY ORG_B — disjoint on the same physical connection; cross lookups (other company / by id) → 0/null | integration it (a) | `pass` |
| (b) No GUC leak across pooled reuse: after a COMMITTED `runInTenant(ORG_A)` and a ROLLED-BACK `runInTenant(ORG_B)` (fn throws → `.rejects.toBe(boom)`), a raw `appDb` query outside any wrapper reads `current_setting` EMPTY, and the next `runInTenant(ORG_A)` sees only ORG_A | integration it (b) | `pass` |
| (b2) The GUC value INSIDE a tenant tx equals this call's org (ORG_A) and is EMPTY at the raw `appDb` level outside | integration it (b2) | `pass` |
| (c) A nested `db.transaction` (SAVEPOINT) inherits the outer tenant — GUC still ORG_A without re-setting; repo read via `tenantRepositories(nested)` sees only ORG_A | integration it (c) | `pass` |
| (d) A query on a **pristine** `appDb` connection OUTSIDE any `runInTenant` (no GUC) → **0** new-path rows (forced RLS from TEN-002); superuser sees 2 — proving the wrapper is mandatory | integration it (d) | `pass` |
| (d2) A no-context query on a **reused** pooled connection FAILS CLOSED — throws `22P02` (`''::uuid`), never returns rows (finding E2-F012; server log `ERROR: invalid input syntax for type uuid: ""`) | integration it (d2) | `pass` |
| (e) `runInTenant(appDb, "")` and `("  ")` THROW `/non-empty organizationId/`; GUC untouched (fail closed before any DB round-trip) | integration it (e) | `pass` |
| Unit: `fn` receives `TenantRepositories` (8 accessor groups), NOT a raw tx | unit it 1 | `pass` |
| Unit: `runInTenant` returns `fn`'s DATA result (tx/repos don't escape) | unit it 2 | `pass` |
| Unit: delegates to `withTenantTx` — one transaction, one `set_config` with org bound as a param (`is_local => true`), org never interpolated | unit it 3 | `pass` |
| Unit: empty / blank / whitespace `organizationId` rejected BEFORE any transaction; `fn` not invoked | unit it 4–6 | `pass` |

**(d) genuinely relies on TEN-002's forced RLS:** confirmed — on the pristine
connection the non-owner `aoa_app` role sees 0 of the 2 seeded jobs with no GUC, while
the superuser owner (bypasses RLS) sees both. Remove FORCE/policies and (d) would
return 2. The wrapper is the only way to read anything.

## Commands

| Command | Exit | Result |
|---|---:|---|
| `pnpm --filter @armyofagents/db typecheck` | `0` | clean |
| `pnpm --filter @armyofagents/db build` | `0` | `tsc && cp -r src/migrations dist/migrations` |
| `vitest run tenant-tx-context-unit.test.ts` (RED, pre-impl) | `1` | `Cannot find module '../db/tenant-context.js'` |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-tx-context.integration.test.ts` (RED, pre-impl) | `1` | fails to load — `../db/tenant-context.js` missing |
| `vitest run tenant-tx-context-unit.test.ts` (GREEN) | `0` | **6 passed** |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-tx-context.integration.test.ts` (GREEN) | `0` | **7 passed** (a, b, b2, c, d, d2, e) |
| `vitest run tenant-tx-context.integration.test.ts` (NO flag) | `0` | **7 skipped** (E2-D05 env-hatch `skipIf`, not the banned ternary) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-tx-context.integration + -unit` (stability re-run) | `0` | **13 passed** (2 files) |
| `vitest run integration-test-hygiene.test.ts` | `0` | 2 passed (my `skipIf` form + comments not flagged) |
| `vitest run rls-canary-unit.test.ts` | `0` | 4 passed (`withTenantTx` behavior unchanged) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-rls-enforcement.integration.test.ts` | `0` | **10 passed** — TEN-002 not regressed by the `with-tenant-tx.ts` comment + `createTenantAppDb` max option |
| `vitest run tenant-rls-enforcement-unit.test.ts` | `0` | 15 passed |
| `cd packages/db && vitest run tenant-repository-surface.test.ts` | `0` | 3 passed (tenant module surface unchanged by the barrel re-export) |
| `cd packages/db && AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-kernel-schema{,-b} + tenant-composite-integrity` | `0` | **20 passed** (barrel re-export + client.ts change do not regress TEN-001/004) |
| `cd packages/db && vitest run migration-idempotency.test.ts` | `0` | 5 passed |
| `pnpm --filter @armyofagents/server typecheck` | `2` | 66 errors, **all** `@armyofagents/plugin-sdk` (E2-F009); **zero** reference `tenant-context`/`with-tenant-tx`/`tenant-tx-context` (grep clean) |

## Deviations

1. **`(d)` split into pristine `(d)` + reused `(d2)` (finding E2-F012).** The task's
   `(d)` expects "no GUC → 0 rows". That holds only on a **pristine** connection
   (GUC never set → `current_setting` NULL → `NULL::uuid` → 0 rows). Because
   `aoa.organization_id` is a placeholder GUC, once any `runInTenant`/`withTenantTx`
   has run on a pooled connection its reset value becomes `''`, so a later no-context
   query on that **reused** connection evaluates `''::uuid` and fails closed by
   THROWING `22P02` instead of returning 0. Both are fail-closed (no leak). I proved
   `(d)` on a pristine connection (runs first, deterministic) AND documented the
   reused-connection throw in `(d2)` (robust assertion: never returns rows; asserts
   `22P02` when it throws). Filed as **E2-F012** (Low, resolved-by-design). This does
   **not** change the TEN-002 policy — it reinforces that `runInTenant` is mandatory.
2. **Barrel re-export of `tenantRepositories`.** The task lists `tenant-context.ts`,
   the `with-tenant-tx.ts` comment, and the optional `client.ts` max option. Making
   `runInTenant` compile requires `tenantRepositories` importable in the server; under
   NodeNext + the package's `exports` map, re-exporting it from `packages/db/src/index.ts`
   (the same barrel `createTenantAppDb`/`Db` come from) is the minimal, precedent-following
   enabling change. The tenant module's own surface test (`tenant-repository-surface.test.ts`)
   still passes — it asserts that module's keys, which the barrel re-export does not touch.
3. **Nested inheritance `(c)` demonstrated via `withTenantTx` + nested `tx.transaction`.**
   `runInTenant` hands `fn` the repositories, not the raw tx, so a SAVEPOINT cannot be
   opened from inside `fn`. A "nested `runInTenant`" would instead grab a **second**
   pooled connection (and would deadlock on the intentional `max:1` pool), so it is NOT
   the "nested inherits" mechanism. The real inheritance is a SAVEPOINT on the SAME
   connection, so `(c)` uses `withTenantTx(appDb, ORG_A, tx => tx.transaction(nested => …))`
   — exactly "a nested `db.transaction` inherits the outer tenant" (the task's own `/`
   alternative). `runInTenant` is `withTenantTx` + `tenantRepositories`, so the property
   transfers.

## Findings

- **E2-F012 (new, Low, resolved-by-design)** — on a REUSED pooled connection a
  no-context new-path query fails closed by THROWING `22P02` (placeholder-GUC reset
  value `''` → `''::uuid`), not by returning 0 rows. Both outcomes are fail-closed;
  reinforces the mandatory-wrapper contract. E3-adoption note: always route new-path
  access through `runInTenant`. See `../findings.md#E2-F012`.
- **E2-F009 (pre-existing)** re-confirmed unchanged: `pnpm --filter server typecheck`
  exits 2 with 66 errors, ALL `@armyofagents/plugin-sdk` / plugin subsystem; grep for
  `tenant-context`/`with-tenant-tx`/`tenant-tx-context` over the error output → none.
  DEC-03-waivable / subset-of-baseline.

## Follow-up tickets

`None` — E2-F012's optional NULL-safe-predicate hardening is explicitly out of E2 scope
(would alter the shipped TEN-002 policy) and is noted for E3 consideration only.

## Gate recommendation

`ready for independent review` — `runInTenant` is proved on real embedded-Postgres over
the non-owner `aoa_app` pool pinned to a single connection: interleaved tenants are
disjoint (a); the transaction-local GUC does not leak across pooled reuse after either a
commit or a rollback (b/b2); a nested SAVEPOINT inherits the tenant (c); a query outside
the wrapper reaches 0 rows on a pristine connection and fails closed (throws) on a reused
one (d/d2), proving the wrapper is mandatory (relies on TEN-002 forced RLS); and an
empty/blank Organization is rejected before any DB round-trip (e). `withTenantTx` is a
comment-only change (behavior identical); `createTenantAppDb`'s `max` option is additive;
the barrel re-export adds no raw reader; TEN-002/TEN-001/TEN-004 suites do not regress; no
manifest/lock change. Reviewer should scrutinize: (1) the `(d)`/`(d2)` split + E2-F012
(pristine-0 vs reused-throw, both fail-closed); (2) that `withTenantTx` is truly
behavior-identical (`git diff` = docblock only); (3) the nested-inheritance modeling via
`withTenantTx`+SAVEPOINT (Deviation 3); (4) the barrel re-export (Deviation 2); (5) that a
real Linux run is still owed for H-01 at the E2 gate (E2-D05/E2-F008 — Windows-local
evidence here).

## Independent review

**Reviewer:** `claude-opus (independent reviewer subagent — distinct from the implementer subagent)`
**Reviewed revision:** `10592fc0b5cd9f759fb24d0fc2e15e908d4d7653`
**Disposition:** `approved`
**Review evidence:**

Reviewed at HEAD `10592fc0b` (Start SHA `f730c2c22` = `HEAD~1`, confirmed a real
ancestor via `git merge-base --is-ancestor`); working tree clean (`git status
--porcelain` empty).

Re-run acceptance (from `C:\e2`, Git Bash):

| Command | Exit | Result |
|---|---:|---|
| `pnpm --filter @armyofagents/db typecheck` | `0` | clean |
| `pnpm --filter @armyofagents/server typecheck` | `2` | **66** errors, **all** plugin subsystem (E2-F009: `app.ts` = `Cannot find module '@armyofagents/plugin-sdk'`, plus `plugins.ts`/`plugin-host-services.ts`/`plugin-*`); `grep -vi plugin` over the error lines → **empty**; zero reference `tenant-context`/`with-tenant-tx`/`tenant-tx-context` |
| `vitest run tenant-tx-context-unit.test.ts` | `0` | **6 passed** |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-tx-context.integration.test.ts` | `0` | **7 passed** (a, b, b2, c, d, d2, e) |
| `vitest run tenant-tx-context.integration.test.ts` (no flag) | `0` | **7 skipped** (`describe.skipIf` env-hatch) |
| `vitest run rls-canary-unit.test.ts` | `0` | **4 passed** (`withTenantTx` behavior unchanged) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-rls-enforcement.integration.test.ts` | `0` | **10 passed** (TEN-002 not regressed) |

**Observed SQLSTATEs (read from the embedded-PG server log during the integration
run):** assertion (d2) emitted `ERROR: invalid input syntax for type uuid: ""` on
`STATEMENT: SELECT count(*)::int AS c FROM jobs` — the reused-connection `''::uuid`
throw = **SQLSTATE 22P02**, statement returned no rows. Assertion (a) cross-tenant
lookups + (d) pristine both denied at 0 rows (RLS default-deny, no error).

Per-item verification:

1. **`runInTenant` contract (`tenant-context.ts:36-50`)** — `= withTenantTx(appDb,
   org, tx => fn(tenantRepositories(tx)))`. The non-empty-org guard (`typeof !==
   "string" || .trim() === ""`) throws **before** `withTenantTx`/`db.transaction`,
   so `set_config('aoa.organization_id', '')` / `''::uuid` is never reached (unit it
   4-6 + integration (e): GUC untouched after reject). `fn` receives the repositories,
   not the tx (unit it 1 asserts `__isFakeTx` absent + the 8 accessor groups); only
   `fn`'s DATA result returns (unit it 2). GUC is transaction-local (`with-tenant-tx.ts:36`
   `is_local => true`; unit it 3 asserts `,\s*true)` + org bound as **param** `[ORG]`,
   never interpolated).
2. **`with-tenant-tx.ts` comment-only** — `git show f730c2c22..HEAD -- server/src/db/with-tenant-tx.ts`
   = docblock hunk ONLY (`NOTE (M3)` → `NOTE (TEN-002)`); function body/signature
   byte-identical. rls-canary-unit (4 passed) corroborates.
3. **Property proofs on a REAL max:1 non-owner pool** — `beforeAll` builds
   `createTenantAppDb(url, { max: 1 })` (integration:138); `client.ts` forwards `max`
   to `postgres()` only when defined (diff confirmed), so the pool is genuinely one
   physical connection and (b)'s no-leak is not vacuous. (a) disjoint tenants + cross
   lookups 0/null; (b) GUC empty after BOTH a committed and a rolled-back `runInTenant`
   on the same connection, next call sees only its org; (b2) GUC == call's org inside,
   empty outside; (c) nested SAVEPOINT inherits without re-set; (d) pristine no-GUC →
   **0** rows while the superuser owner sees **2** (genuinely relies on TEN-002 forced
   RLS — remove FORCE and (d) returns 2); (e) empty/blank throws pre-DB.
4. **E2-F012 fail-closed verdict — CONFIRMED resolved-by-design.** Grep proves the
   ONLY writer of `aoa.organization_id` is `with-tenant-tx.ts:36` with `is_local =>
   true`; no code sets it session-level. Therefore the placeholder-GUC reset value can
   only ever be **NULL** (pristine → `NULL::uuid` → 0 rows) or **''** (reused →
   `''::uuid` → 22P02 throw, no rows) — there is **no variant** where a no-context read
   yields another tenant's rows, because the reset is never a valid uuid. Policy
   predicate (`rls-tenant.ts:105`) is `organization_id = current_setting('aoa.organization_id',
   true)::uuid` for both USING and WITH CHECK (no `NULLIF`), so the throw-vs-0-rows
   split is a faithful consequence, not a defect. Deferring the `NULLIF(current_setting(…),
   '')::uuid` hardening to E3 introduces **no H-01 gap at E2**: the policies are dormant
   (no entry point wires `runInTenant`) and every runtime read goes through `runInTenant`
   which sets a valid uuid. The throw-vs-0-rows inconsistency is **not** an E2 defect —
   both branches are fail-closed and it reinforces the mandatory-wrapper contract.
5. **Scope (E2-D04) / Rule #1** — `grep runInTenant` (non-test) finds only its own
   definition + docblock comments (incl. `server/src/index.ts:277`, a docblock line,
   not a call): NO route/scheduler/worker wiring (dormant). Migration chain caps at
   `0211` (no `0212`; no schema change). `git diff --stat f730c2c22..HEAD` touches only
   `tenant-context.ts`, `with-tenant-tx.ts` (comment), `client.ts`, `index.ts`, the 2
   tests, and the two docs files — so `rls-bootstrap.ts`, `rls-tenant.ts`,
   `assertCompanyAccess`, and `createDb` are untouched; `createTenantAppDb`'s `max` and
   the barrel re-export are additive; NO `package.json`/`pnpm-lock.yaml` change.
6. **Ledger** — `Status: gate_review` at review start; bare 40-hex Start SHA
   (`f730c2c22…` = real ancestor); a–e evidence + the E2-D04 scope note present; review
   block was at pending sentinels; attempt-history table body empty. All consistent.

No defects found. The one owed item is the H-01 Linux run at the E2 gate
(E2-D05/E2-F008) — evidence here is Windows-local embedded-PG, which the ledger
already flags; not a TEN-003 blocker.

For `approved`, verify the result describes the reviewed revision, all focused acceptance evidence passes, and every accepted finding is resolved; then change the top-level `Status` to `complete` and commit this disposition separately. Otherwise leave `Status` as `gate_review` or set `blocked`, and link stable findings.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary above is not a review attempt. The first independent reviewer appends attempt 1, and later reviewers append monotonically increasing rows without replacing prior attempts. The summary fields above mirror the latest real attempt for existing gate tooling. Do not include a `Review commit` column: a row cannot embed the SHA of the commit that first contains it. Repository history identifies that commit, and handoffs pin the resulting ticket-result blob SHA.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
<!-- First independent reviewer appends attempt 1. -->
| 1 | `claude-opus (independent reviewer subagent; ≠ implementer)` | `10592fc0b5cd9f759fb24d0fc2e15e908d4d7653` | `approved` | db typecheck 0; server typecheck 2 (66 errs, all plugin/E2-F009, 0 TEN-003); unit 6 passed; integration 7 passed (flag) / 7 skipped (no flag); rls-canary-unit 4 passed; tenant-rls-enforcement 10 passed (no TEN-002 regression). (d2) SQLSTATE **22P02** (`invalid input syntax for type uuid: ""`) observed in PG log — reused-connection fail-closed. E2-F012 **confirmed resolved-by-design** (sole GUC writer is `is_local` → reset only NULL/'' → never leaks rows; no H-01 gap at E2). Scope clean: no route/scheduler wiring, migration caps 0211, no manifest/lock change. |
