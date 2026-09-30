# TEN-006a Result — Company-writer sweep (make Organization explicit)

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E2-tenant-kernel`
**Plan task:** `TEN-006a — exhaustive Company-writer sweep + fail-closed writers + shared explicit-org test factory (split of TEN-006 per E2-D07)`
**Implementer:** `claude-opus (implementer subagent)`
**Start SHA:** 8f1da300bfdf81bb2854f866e7081ef53fbb2522

Start SHA is the actual `git rev-parse HEAD` of the C:\e2 worktree captured before
the first change (mirrors the TEN-001a/b/TEN-004 convention).

## Delivered scope

TEN-006a removes only the **fail-OPEN** mechanisms in the Company writers — the
**silent** `?? DEFAULT_ORGANIZATION_ID` / `?? undefined`-then-buckets — so an
Organization-omitting write now **fails closed** (throws). It **preserves** the
explicit self-hosted Default-Org resolution and does **not** touch the schema
default or build the admission-denial helper (both TEN-006b).

### 1. Fail-closed Company writers (production) — `server/src/services/companies.ts`

- New module-level guard `requireResolvedOrganizationId(data)` — throws when
  `data.organizationId` is absent/blank (message: *"Company writer requires an
  explicitly resolved organizationId (TEN-006a)…"*); returns the resolved id
  otherwise. It references **no** sentinel — pure fail-closed.
- Removed all four silent `data.organizationId ?? DEFAULT_ORGANIZATION_ID` sinks
  (fresh `rg`-derived, not stale line numbers):
  - `resolveCompanyCreationReplay` (replay lookup key) → `requireResolvedOrganizationId(data)`.
  - `createCompanyWithUniquePrefix` (operator-free `create`) → resolves once at
    the top, insert uses `organizationId`.
  - `createWithOperator` (atomic create) → resolves once at the top **before any
    read/write**, so both the `pg_advisory_xact_lock` key and the insert use the
    resolved `organizationId`.
- Removed the now-unused `DEFAULT_ORGANIZATION_ID` import (companies.ts references
  it only in comments/the guard message now).
- **Preserved:** atomic checkout, replay idempotency, advisory-lock semantics, and
  `companies.update` still stripping `organizationId` (all untouched).

### 2. Explicit self-hosted resolution preserved — `server/src/routes/companies.ts`

- `resolveCompanyOrganizationId` non-enforced branch **still returns
  `DEFAULT_ORGANIZATION_ID`** — but now documented as an **explicit, caller-side
  Default-Org resolution** (comments updated), not a silent writer default. The
  route already passes a concrete `organizationId: string` to the writer in every
  path (POST `/`, POST `/import` new_company), so production behavior is unchanged.

### 3. Import path — `server/src/services/company-portability.ts`

- The `new_company` `createWithOperator` call passes `opts?.organizationId` through
  (comment corrected: the route resolves + authorizes the Org; a direct non-route
  caller now **fails closed** at the writer instead of silently bucketing). The
  `?? undefined` is retained only to normalize a `null` opts value to `undefined`
  for the writer's `organizationId?: string` field — it is not a fallback.

### 4. Shared explicit-org test factory — `server/src/__tests__/helpers/insert-test-company.ts` (NEW)

- `insertTestCompany(db, { …, organizationId })` ALWAYS writes `organization_id`
  explicitly (defaults to the single-tenant Default Org so a test may pass it
  deliberately, but never relies on the schema default). Returns the inserted row.

### 5. Test-site sweep — every company-insert passes `organization_id` explicitly

Derived from a fresh exhaustive sweep (`rg "DEFAULT_ORGANIZATION_ID"`,
`rg "INSERT INTO companies"`, `rg "\.insert\(companies\)"` across `server`,
`packages`, `cli`, incl. all `__tests__`). Inventory at execution:

- Raw `INSERT INTO companies (…)`: **107** occurrences; **37** already had
  `organization_id`; **70** omitted it (1 was a `packages/db/dist` build artifact —
  excluded; 70 source statements swept).
- Drizzle `.insert(companies)`: 14 hits — 2 are the production writers (§1), 2 are
  comments, 2 already passed `organizationId` (`founder-grants`,
  `org-concurrency-claim` ×3), the prod seed already explicit; leaving 4 Drizzle
  test inserts to convert.
- Mocked-service portability unit tests (15 files) mock
  `createWithOperator` → never reach the real writer → unaffected.

**Swept by mechanism:**

- **Raw-SQL inline (70 statements / 52 files)** — injected `organization_id` as the
  first column + the Default-Org sentinel `'00000000-0000-0000-0000-000000000001'`
  as the first value (paired atomically per statement; behavior-identical to the
  current schema default, FK-valid post-0188). Files:
  `packages/db/src/__tests__/revert-0188.integration.test.ts`;
  `server/src/services/__tests__/mcp-connector-token-refresh.integration.test.ts`;
  and under `server/src/__tests__/`: `add-dependency-race`,
  `agents-list-excludes-platform` (×2), `agents-update-concurrency`,
  `blocked-task-scan`, `broker-internal-registry` (×2), `cheap-fallback-integration`,
  `checkout-race`, `commander-turn-claim`, `comment-wakeup-outbox`,
  `companies-remove-provider-connections`, `companies-scope-pushdown` (×2),
  `crew-marketplace-bootstrap` (×6), `crew-org-scope`, `crew-output-capture`,
  `crew-repair` (×3), `crew-run-log-pointer`, `crew-skill-assignment-e2e`,
  `environments-integration` (×2), `execution-workspaces-unique-integration`,
  `hub-curation`, `hub-items-action`, `hub-items-budget-reconcile`,
  `hub-items-counts`, `hub-items-emit`, `hub-items-query`, `hub-items-sweeper`,
  `hub-source-producers`, `issue-attachment-completion-race`,
  `issues-comment-reassign-atomicity`, `mcp-connector-install`,
  `mcp-connector-oauth`, `mcp-connectors-e2e-delivery` (×2), `mcp-connectors-plan2-e2e`,
  `mcp-memory-read-rbac`, `memory-rbac-leakage`, `memory-tools-agent-rbac`,
  `memory-version-race`, `mention-outbox`, `mt-import-authz`,
  `output-detection-confirm-race`, `plugin-broker-cloud` (×2),
  `provider-connections-backfill`, `provider-readiness-upsert` (×2),
  `provider-switching` (×2), `quota-windows-dedup` (×2), `routine-revisions-integration`,
  `secrets-schema-integration`, `suggestions-dedupe-migration`,
  `teams-null-parent-cascade`, `w6-org-reporting` (×3).
- **Factory-converted Drizzle inserts (4 files)** → `insertTestCompany(db, …)`:
  `ask-founder-dogfood` (dropped now-unused `companies` import),
  `home-board-layout`, `mcp-oauth-operator-cli`, `work-questions`.
- **Service-writer `.create()`/`.createWithOperator()` (47 calls that needed org
  / 22 files)** — added explicit `organizationId` to the create input. **The true
  population of company-service create calls in the tests is 72**; after this sweep
  70 pass `organizationId` explicitly and the only 2 org-LESS calls are the
  intentional fail-closed throw-assertions in `company-writer-fail-closed.test.ts`.
  - **Initial commit (`c4d8756c8`), 15 calls / 9 files:** `aoa-bootstrap-wiring`
    (×5, mock db), `aoa-backend`, `aoa-realoutput`, `artifact-add-version-parent`,
    `broker-tool-context` (×3), `commander-skill-triggering`,
    `companies-delete-integration`, `companies-prefix-conflict` (mock db),
    `crew-marketplace-bootstrap` (:490 only).
  - **E2-F010 follow-up (this fix), 32 calls / 14 files** — the initial commit
    undercounted this axis (recurrence of the E2-F006 undercount, this time on
    `.create()`); the reviewer reproduced RED on embedded PG. Swept the remaining
    31 via explicit-org injection: `crew-marketplace-bootstrap` (×9, the 561/604/
    717/791/819/843/1099/1158/1191 calls the initial commit missed within that same
    file), `crew-repair` (×9), `d18-autonomy-dial-split`, `discussion-detail-lasterror`,
    `extraction-sandbox-batch`, `link-entry-seq`, `thread-commit-idempotency` (×2),
    `thread-v2-real-e2e` (×2), `w1a-crew-assignment`, `w1b-auto-accept`,
    `w1c-inbox-dispatch-approval`, `w2-extract-then-scope`, `w3a-crew-loopback`.
    The 32nd — `organizations-backfill.integration.test.ts:50` — is semantically
    special (its premise is "a company that lands on the Default Org"): the guarded
    service can no longer create an org-less company, so it is now seeded via **raw
    SQL** with the EXPLICIT Default Org (`INSERT INTO companies (organization_id,
    name, issue_prefix) VALUES (…sentinel…)`), preserving the org-attachment
    assertion and the unchanged explicit-NULL → 23502 NOT NULL proof; the unused
    `companyService` import was dropped.
  - (`company-create-atomicity` already passed `organizationId` on all 13 of its
    `createWithOperator` calls — 9 inline, 4 via the shared `input` object literal
    that carries `organizationId: orgId` — verified, left unchanged.)
- **`importBundle` opts (2 direct non-route callers)** — added
  `{ organizationId }` opts so a direct self-hosted `new_company` import resolves
  the Default Org explicitly (previously leaned on the removed writer fallback):
  `w6-org-reporting` (self-hosted import), `mt-import-authz` (H3 self-hosted). The
  `mt-import-authz` H3-threaded-org call already passed `{ organizationId: orgId }`.

### 6. Source-asserting tests re-pointed to the explicit contract

- `company-service-org-scope.test.ts` — **INVERTED**: was pinning the fail-open
  `organizationId: data.organizationId ?? DEFAULT_ORGANIZATION_ID`; now asserts
  that expression is **absent** and the fail-closed `requireResolvedOrganizationId`
  guard is present.
- `companies-create-org-default.test.ts` — reworded to the explicit-resolution
  contract; asserts the route still resolves via `resolveCompanyOrganizationId`
  (assertions preserved — route behavior unchanged).
- `cloud-auth-cutover.test.ts` — reworded ("falls back" → "explicitly resolves");
  the `resolveCompanyOrganizationId({}) === DEFAULT_ORGANIZATION_ID` assertion is
  the PRESERVED behavior, unchanged.
- `companies-org-scope.test.ts` (line ~201) — reviewed: it pins the **route's**
  explicit self-hosted `DEFAULT_ORGANIZATION_ID` stamping (preserved), not the
  service fail-open, so it passes unchanged and was left as-is.

**Non-goals preserved (TEN-006b, untouched):**
- NO `packages/db/src/schema/companies.ts` change — the `organization_id`
  `.default(...)` schema default is intact (verified `git status`: no schema/
  migration/`.sql` change).
- NO migration; NO admission-denial helper; `DEFAULT_ORGANIZATION_ID` and
  `ensureDefaultOrganization` retained.
- `assertCompanyAccess`, `rls-bootstrap.ts`, `with-tenant-tx.ts`, new-path tenant
  tables not touched. No `package.json`/`pnpm-lock.yaml` change.

## Changed files

3 production + 2 new helper/test + 67 test files = **72** files (+ this result doc).

| File | Responsibility |
|---|---|
| `server/src/services/companies.ts` | **Fail-closed writers.** Add `requireResolvedOrganizationId` guard; remove 4 silent `?? DEFAULT_ORGANIZATION_ID` sinks; drop unused import. |
| `server/src/routes/companies.ts` | Comments: non-enforced branch reframed as EXPLICIT Default-Org resolution (behavior unchanged). |
| `server/src/services/company-portability.ts` | Comment: import path fails closed at the writer, no silent bucketing (behavior unchanged). |
| `server/src/__tests__/helpers/insert-test-company.ts` | **NEW** shared `insertTestCompany` factory (always-explicit `organization_id`). |
| `server/src/__tests__/company-writer-fail-closed.test.ts` | **NEW** RED→GREEN behavioral proof: writers throw on an unresolved Organization. |
| `server/src/__tests__/company-service-org-scope.test.ts` | Source-asserting test **inverted** to the fail-closed contract. |
| `server/src/__tests__/companies-create-org-default.test.ts` | Reworded to explicit-resolution contract. |
| `server/src/__tests__/cloud-auth-cutover.test.ts` | Reworded to explicit-resolution (assertion preserved). |
| 64 test files | Test-site sweep (raw-SQL inline / factory / service-create / importBundle opts) — full list in §5. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| A Company writer reached with no resolvable Organization fails CLOSED (throws), not silent-buckets | `company-writer-fail-closed.test.ts`: `create()` + `createWithOperator()` reject `/explicitly resolved organizationId/` | `pass` (RED→GREEN) |
| Explicit resolution still works (explicit org + Default Org both accepted) | same test, cases 2–3 (org-explicit + `DEFAULT_ORGANIZATION_ID`) | `pass` |
| No silent `?? DEFAULT_ORGANIZATION_ID` remains in the service | `company-service-org-scope.test.ts` (inverted): expression absent, guard present | `pass` |
| Self-hosted route resolution preserved (returns Default Org explicitly) | `companies-org-scope.test.ts` (self-hosted stamps `DEFAULT_ORGANIZATION_ID`), `cloud-auth-cutover` assertion | `pass` (org-scope), baseline-blocked (cutover, see Findings) |
| Raw-SQL sweep parses + FK-valid against real PG | `teams-null-parent-cascade.integration.test.ts` (swept raw insert) GREEN on embedded PG | `pass` |
| Factory works against real PG | `ask-founder-dogfood.integration.test.ts` (`insertTestCompany`) GREEN on embedded PG | `pass` |
| No schema/migration change (TEN-006b boundary) | `git status`: no `schema/` `migrations/` `.sql`; `packages/db` typecheck `0` | `pass` |
| No new error references an E2-changed file (E2-F009 baseline holds) | `server typecheck` 66 errors, all plugin-subsystem; grep of changed files = none | `pass` |

**Structural verification of the raw-SQL sweep:** 70 added `INSERT INTO companies
(organization_id, …` lines; 70 added `VALUES ('00000000-…0001', …` value prefixes;
0 removed sentinel literals; 0 transformed INSERTs left without `organization_id`.
Only statements whose column list lacked `organization_id` were touched (the 37
already-explicit statements untouched).

## Commands

| Command | Exit | Summary |
|---|---:|---|
| `git rev-parse HEAD` (before first change) | `0` | `8f1da300b…` (Start SHA) |
| `pnpm exec vitest run src/__tests__/company-writer-fail-closed.test.ts` (RED, pre-writer-change) | `1` | 2 failed / 2 passed — `create()` resolved instead of rejecting; `createWithOperator()` threw wrong error (silent bucketing present) |
| `pnpm exec vitest run src/__tests__/company-writer-fail-closed.test.ts` (GREEN) | `0` | **4 passed** |
| `pnpm exec vitest run src/__tests__/company-service-org-scope.test.ts src/__tests__/companies-create-org-default.test.ts src/__tests__/companies-org-scope.test.ts src/__tests__/companies-prefix-conflict.test.ts` | `0` | **20 passed** (source-asserting inversions + route resolution + prefix-conflict) |
| `pnpm exec vitest run src/__tests__/companies-*.test.ts src/__tests__/company-*.test.ts src/__tests__/*org*.test.ts` | `1` | **42 files / 390 passed, 4 skipped**; 2 files fail-to-collect = `@armyofagents/plugin-sdk` baseline (E2-F009), confirmed identical on clean stash |
| `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run src/__tests__/teams-null-parent-cascade.integration.test.ts src/__tests__/ask-founder-dogfood.integration.test.ts` | `0` | **6 passed** on embedded PG (raw-SQL sweep + factory both real-PG validated) |
| `pnpm --filter @armyofagents/db typecheck` | `0` | clean |
| `pnpm --filter @armyofagents/server typecheck` | `2` | 66 errors, ALL plugin-subsystem (`@armyofagents/plugin-sdk` absent, E2-F009); zero reference any changed file |
| **E2-F010 fix** `AOA_RUN_WIN_INTEGRATION=1 vitest run crew-repair + extraction-sandbox-batch` | `0` | **41 passed** (crew-repair 37, extraction-sandbox-batch 4) — the reviewer's RED files GREEN |
| **E2-F010 fix** `AOA_RUN_WIN_INTEGRATION=1 vitest run d18-autonomy-dial-split` | `0` | **6 passed** (attempt 2; attempt 1 hit a transient embedded-PG socket-bind flake on d18's hardcoded 60100–60399 port — its `beforeAll`, before any test body; not the guard) |
| **E2-F010 fix** `AOA_RUN_WIN_INTEGRATION=1 vitest run crew-marketplace-bootstrap` | `0` | **15 passed** (the file the initial commit swept only partially — now complete) |
| **E2-F010 fix** `vitest run company-writer-fail-closed + 10 Pattern-A edited files + organizations-backfill` | `0` | **4 passed / 65 skipped** — fail-closed guard intact; all Pattern-A edits collect cleanly (Windows-skip, validated for real on the Linux gate) |
| **E2-F010 fix** `pnpm --filter @armyofagents/db typecheck` | `0` | clean (no db change) |

## Deviations

1. **Raw-SQL test sweep uses the literal sentinel value**, not the imported
   `DEFAULT_ORGANIZATION_ID` constant, in the injected SQL text
   (`'00000000-0000-0000-0000-000000000001'`). Rationale: these are raw
   `sql\`…\`` template strings; injecting the literal is behavior-identical to the
   current schema default (same value), FK-valid (0188 seeds the Default Org),
   avoids adding an import to ~50 files, and is consistent + greppable. Service-
   writer `.create()` inline sites use the same literal for uniformity. The Drizzle
   factory + its 4 converted sites use `DEFAULT_ORGANIZATION_ID` via the factory.
2. **`company-portability.ts` has no functional change** — the fail-closed point is
   the writer (§1); the import-path change is a corrected comment + the writer now
   throwing on a missing Org for a direct non-route caller. Production is unchanged
   (the route always resolves the Org).
3. **Two direct-non-route `importBundle` self-hosted callers** (`w6-org-reporting`,
   `mt-import-authz` H3-self-hosted) previously relied on the removed writer
   fallback; they now pass `{ organizationId: DEFAULT_ORGANIZATION_ID / sentinel }`
   explicitly. This is the intended self-hosted **explicit** resolution — reviewer
   should confirm this is the correct interpretation (it preserves each test's
   `orgOnCompany === DEFAULT_ORGANIZATION_ID` assertion while making the resolution
   explicit rather than silent).
4. **E2-F010 (fixed):** the initial commit's `.create()`/`.createWithOperator()`
   sweep undercounted — 32 calls across 14 files still omitted `organizationId` and
   regressed on the new fail-closed guard (reviewer reproduced `crew-repair` 34/37,
   `extraction-sandbox-batch` 4/4, `d18-autonomy-dial-split` 6/6 RED on embedded
   PG). The follow-up commit re-derived the COMPLETE inventory (all 72 company-
   service create calls analyzed by receiver + arg), swept the 32 (31 explicit-org
   injections + `organizations-backfill` raw-SQL reseed), and re-ran the three named
   files + `crew-marketplace-bootstrap` to GREEN on embedded PG. App-layer only —
   no schema/migration/production change in the fix. See finding E2-F010.

## Findings

- `E2-F009` (pre-existing `@armyofagents/plugin-sdk` absence → server typecheck
  exit 2, ~66 errors; a handful of vitest suites fail-to-collect on the transitive
  plugin import) re-confirmed unchanged: all 66 errors in the plugin subsystem,
  zero reference any changed file; the 2 collect-failing suites in the company glob
  (`company-plugin-upgrade-rollback`, `company-portability-preview-export`) fail
  **identically on the clean stash** (proven). DEC-03/E2-F009-waivable; not an
  epic-touched defect.
- `E2-F010` (raised by TEN-006a independent review attempt 1) — **resolved by the
  follow-up commit**: the incomplete `.create()`/`.createWithOperator()` sweep is
  now complete (32 sites across 14 files fixed); the three reviewer-reproduced RED
  files (`crew-repair`, `extraction-sandbox-batch`, `d18-autonomy-dial-split`) plus
  `crew-marketplace-bootstrap` are GREEN on embedded PG; the fail-closed guard's 2
  intentional throw-assertions remain org-less. No other new findings.

## Fail-closed choices to scrutinize

- No path was chosen fail-closed **in place of** a legitimate Default-Org
  resolution. Every self-hosted create/import path retains an explicit Default-Org
  resolution (route `resolveCompanyOrganizationId`; direct test callers now pass it
  explicitly). Fail-closed fires only when a caller supplies **no** Organization at
  all — the removed silent-bucket case.

## Gate recommendation

`ready for independent review` — the fail-closed behavioral change is RED→GREEN
proven at the unit level and the swept surface is validated against real embedded
PG (raw-SQL + factory); the exhaustive sweep is structurally verified (70/70 paired,
0 stragglers); no schema/migration change (TEN-006b boundary intact); the
server-typecheck delta is subset-of-baseline (E2-F009). **H-01 formal evidence
requires the mandatory ≥1 Linux CI run (E2-D05) across the full swept integration
surface — Windows-local + 2 real-PG spot-runs are recorded here; the full-suite
Linux run is a gate action.**

## Independent review

**Reviewer:** `claude-opus (independent reviewer — NOT the implementer)`
**Reviewed revision:** `324e62ca64045c12f0aacba01afe454e6decdb9d` (HEAD; attempt-2 fix commit). Attempt 1 reviewed `c4d8756c8`.
**Disposition:** `approved` (attempt 2 — E2-F010 resolved; attempt 1 was `changes_requested`).
**Review evidence:**

**Attempt 2 (focused re-review of the E2-F010 fix at HEAD `324e62ca6`):** fix commit is test + result-doc only — `git show --name-only` confirms NO `services/companies.ts` / `routes/companies.ts` / schema / migrations / `company-writer-fail-closed.test.ts` change. Independent balanced-paren sweep of `server/src/__tests__` → **0** `companyService.create()/createWithOperator()` sites still omit `organizationId` (only the 2 intentional throws in `company-writer-fail-closed.test.ts` remain org-less, correctly); all `.createWithOperator(` calls + the `company-create-atomicity` shared-`input` literal + alias `svc.create(` receivers pass org. `organizations-backfill.integration.test.ts:50` reseeded via raw SQL `INSERT INTO companies (organization_id, …)` with the unused `companyService` import dropped (the semantic flag from attempt 1, handled correctly). Embedded-PG re-runs (`AOA_RUN_WIN_INTEGRATION=1`), each previously RED on the guard, now **GREEN**: `crew-repair`, `crew-marketplace-bootstrap`, `d18-autonomy-dial-split`, `extraction-sandbox-batch` (d18 + extraction each took one re-run past the coordinator-flagged hardcoded-port EACCES socket-bind flake — never reached a test body, no guard error; dynamic-port control `teams-null-parent-cascade` GREEN concurrently confirms the env). `company-writer-fail-closed` **4 passed**; broad `companies-*/company-*/*org*` glob **59 passed / 13 skipped / 2 plugin-sdk fail-to-collect** (E2-F009 baseline, unchanged); `@armyofagents/db` typecheck **0**. My attempt-1 Independent-review block was not edited by the implementer. **E2-F010 resolved; no new regression → APPROVED, ticket complete.**

---

_Attempt 1 evidence (retained):_

Re-run acceptance (C:\e2, `c4d8756c8`, tree clean):

| Command | Exit / result |
|---|---|
| `git rev-parse HEAD` / `git status --porcelain` | `c4d8756c8…` / clean |
| `pnpm --filter @armyofagents/db typecheck` | `0` |
| `pnpm --filter @armyofagents/server typecheck` (grep companies\|company-portability\|organizations\|insert-test-company) | `none`; 66 total errors, ALL plugin-subsystem = E2-F009 baseline |
| `vitest run company-writer-fail-closed.test.ts` | **4 passed** (fail-closed guard proven; RED→GREEN genuine — pre-change had `?? DEFAULT_ORGANIZATION_ID`) |
| `vitest run company-service-org-scope + companies-create-org-default + cloud-auth-cutover + companies-org-scope + companies-prefix-conflict` | 4 files **16 passed**; `cloud-auth-cutover.test.ts` **fails-to-collect** on the transitive `@armyofagents/plugin-sdk` import (E2-F009 baseline — file unmodified by TEN-006a, no plugin-sdk import added) |
| `vitest run companies-*.test.ts company-*.test.ts *org*.test.ts` (bash-expanded) | 74 files: **59 passed / 13 skipped / 2 fail-to-collect**; **514 tests passed, 62 skipped**. The 2 collect-failures (`company-plugin-upgrade-rollback`, `company-portability-preview-export`) are the E2-F009 plugin-sdk baseline — both unmodified by TEN-006a, transitive plugin-sdk. (Higher file count than the ledger's 42 = bash glob-expansion vs PowerShell literal-arg passing; strictly more coverage, same 2 baseline collect-failures.) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run` swept integration sites | **PASS:** `ask-founder-dogfood` (factory) 4/4, `teams-null-parent-cascade` (raw-SQL) 2/2, `memory-rbac-leakage` (raw-SQL control) 8/8. **FAIL (regression):** `crew-repair` **34/37**, `extraction-sandbox-batch` **4/4**, `d18-autonomy-dial-split` **6/6** — all throwing the new TEN-006a guard. |

Verify-item results: (1) no schema/migration change, sentinel `.default(…)` intact at `packages/db/src/schema/companies.ts:21` — **PASS**. (2) all 4 former sinks covered by `requireResolvedOrganizationId` (`companies.ts` :214 replay-key, :353 create, :420 createWithOperator + :447 advisory-lock key + :464 insert), no active `?? DEFAULT_ORGANIZATION_ID` remains (only comments/guard message) — **PASS**. (3) self-hosted Default-Org resolution preserved + threaded explicitly (`routes/companies.ts` `resolveCompanyOrganizationId` :64 → :329 writer; import path :235→:279); no path fail-closed in place of a legit resolution — **PASS**. (4) RED genuine — **PASS**. (5) source-asserting tests inverted/strengthened not weakened; `companies-org-scope.test.ts:201` correctly left as-is — **PASS**. (6/7) raw-SQL + factory sweep verified (column/value pairing correct; factory always explicit); literal-sentinel deviation is **acceptable** (explicit, behavior-preserving, greppable — ledger note, non-blocking). (8) Rule #1 / CAV-005 hygiene — **PASS** (no schema/migration/RLS/manifest/lock change; `companies.update` still strips org). (9) ledger accurate for the raw-SQL half but **overstates exhaustiveness** for the service-writer half.

**BLOCKING DEFECT (E2-F010):** the `companyService(db).create(…)` test-site sweep is **incomplete** — **32 call sites across 14 test files** still pass only `{ name }` and now throw `requireResolvedOrganizationId`. Raw-SQL sweep (0 stragglers) and production callers are clean; the gap is entirely the service-writer axis. Reproduced on embedded PG (crew-repair 34/37, extraction-sandbox-batch 4/4, d18-autonomy-dial-split 6/6). This regresses ~14 currently-green integration files and would turn the mandatory E2-D05/E2-F008 Linux H-01 run RED. Full site list + fix in findings.md **E2-F010**.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | claude-opus (independent) | `c4d8756c8` | `changes_requested` | Fail-closed writers + raw-SQL/factory sweep + source-asserting inversions + self-hosted-resolution-preserved all verified PASS. **Blocking:** service-writer sweep incomplete — 32 `companyService.create()` sites / 14 test files omit `organizationId` → throw the TEN-006a guard (crew-repair 34/37, extraction-sandbox-batch 4/4, d18 6/6 reproduced on embedded PG). See **E2-F010**. |
| 2 | claude-opus (independent) | `324e62ca6` | `approved` | Focused re-review of the E2-F010 fix (test + result-doc only). Independent sweep: 0 real service-writer sites still omit org (only the 2 intentional throws remain). All 4 previously-RED files GREEN on embedded PG (crew-repair, crew-marketplace-bootstrap, d18, extraction-sandbox; d18+extraction cleared a transient hardcoded-port socket-bind flake on one re-run). `organizations-backfill:50` correctly reseeded via raw SQL. company-writer-fail-closed 4 passed; broad glob 59 passed/13 skipped/2 plugin-sdk baseline; db typecheck 0. **E2-F010 resolved; no new regression.** |
