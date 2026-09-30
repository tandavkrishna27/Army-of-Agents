# TEN-006b Result — Drop the fail-open sentinel Organization default + admission-denial helper

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E2-tenant-kernel`
**Plan task:** `TEN-006b — drop the schema default (migration 0210) + the sentinel/unmapped admission-denial helper + tests (split of TEN-006 per E2-D07)`
**Implementer:** `claude-opus (implementer subagent)`
**Start SHA:** 80bb23552a915abcf24c9c0daabbb25d0a322043

Start SHA is the actual `git rev-parse HEAD` of the C:\e2 worktree captured before
the first change (tree clean), mirroring the TEN-001a/b/TEN-004/TEN-006a convention.

## Delivered scope

TEN-006b lands the second half of the E2-D07 reconciliation on top of the completed
TEN-006a writer sweep. It removes the last **fail-OPEN** mechanism — the
`companies.organization_id` schema default — so an Organization-omitting company
INSERT now **fails closed** on the retained `NOT NULL` (SQLSTATE 23502) instead of
silently bucketing into the Default Org. It adds the dormant sentinel/unmapped
**admission-denial helper** (consuming FND-007's `forbiddenOrganizationSentinels`),
and proves both with a real embedded-PG integration test and a Windows-visible unit
test.

The sentinel value survives as the **legitimate single-tenant Default Org**
(`DEFAULT_ORGANIZATION_ID`, `@armyofagents/shared`) — NOT deleted, NOT treated as an
invalid row; only its **fail-open silent-bucketing** is removed (E2-D07 dual
identity: the "blocker" is admission-time, not row existence).

### 1. Drop the schema default — `packages/db/src/schema/companies.ts`

- Removed `.default("00000000-0000-0000-0000-000000000001")` from the
  `organizationId` column. `.notNull()`, the `references(() => organizations.id,
  { onDelete: "restrict" })` FK, and every other column/index are UNCHANGED
  (incl. the additive TEN-004 `companies_org_id_uq` composite unique).
- Rewrote the adjacent comment (formerly the "keep the `.default(...)` chain
  until then" TRACKING note) to state the fail-open default was DROPPED in
  TEN-006b / migration 0210 (ref E2-D07), that every writer must now resolve the
  Organization explicitly (TEN-006a), and that the sentinel remains the legitimate
  Default Org resolved explicitly by the self-hosted path — "Do NOT re-add
  `.default(...)`".

### 2. Migration 0210 — `packages/db/src/migrations/0210_drop_sentinel_org_default.sql`

- Generated via `pnpm --filter @armyofagents/db build && drizzle-kit generate
  --name=drop_sentinel_org_default`. Operative content is the verbatim single
  `db:generate` statement:
  `ALTER TABLE "companies" ALTER COLUMN "organization_id" DROP DEFAULT;`
- Hand-added ONLY a leading header comment (0195/0209 style — no DDL text added or
  changed) documenting E2-D07: **no company→real-org backfill at E2** (beta
  companies all legitimately sit on the Default Org; the operative content is the
  DROP DEFAULT no-op scaffold); "mapped OR blocks rollout" is satisfied by the
  **blocks-rollout arm** (the admission-denial helper + `organization_id NOT NULL`
  on new-path tables). Idempotency note: `ALTER … DROP DEFAULT` is naturally
  idempotent (dropping a non-existent default is a no-op, not an error) and is not
  matched by `migration-idempotency.test.ts`'s CREATE-scan, so no
  `IF NOT EXISTS`/`DO $$` guard is needed.
- Journal `_journal.json` gets idx 210 (`0210_drop_sentinel_org_default`);
  `meta/0210_snapshot.json` emitted by `db:generate`. Snapshot delta vs 0209 is
  confined to removing the `"default"` on `companies.organization_id` (verified —
  see Acceptance).

### 3. Admission-denial helper — `server/src/services/tenant-admission.ts` (NEW)

Exports:
- `FORBIDDEN_ORGANIZATION_SENTINELS: readonly string[]` — `Object.freeze`d, mirrors
  FND-007's two values EXACTLY (`org_00000000000000000000000000`,
  `00000000-0000-0000-0000-000000000001`) with an inline comment naming
  `distributed-execution-legacy-parity.json:15-19` (Decision #121) as the authority.
- `isForbiddenOrganizationSentinel(orgId: string): boolean` — case-insensitive +
  whitespace-trimmed match against the sentinel set.
- `assertAdmissibleOrganization(orgId: string): void` — throws the typed
  `ForbiddenOrganizationSentinelError` (also exported; carries `.organizationId`
  and a `.code` discriminant) on a forbidden sentinel; returns void otherwise.

Documented as **dormant at E2** (no runtime caller; enforces the **sentinel**
rejection only). The **unmapped** (Organization-does-not-exist) check + the
submit/place/lease wiring are E3 (JOB-001/JOB-010). NOT wired into any
route/scheduler here (E2-D07). A blank/empty id is intentionally NOT rejected (that
is the E3 unmapped/existence concern).

### Non-goals preserved
- `DEFAULT_ORGANIZATION_ID` retained in `packages/shared/src/constants.ts`
  (unchanged). No other `companies` column/behavior touched; NO RLS added;
  `assertCompanyAccess` / `rls-bootstrap.ts` / `with-tenant-tx.ts` / new-path tenant
  tables NOT touched (CAV-005-safe). No `package.json` / `pnpm-lock.yaml` change.

## Changed files

2 modified + 5 new = **7** files (+ this result doc). `packages/db/dist/**` is
git-ignored (rebuild artifacts not committed).

| File | Change |
|---|---|
| `packages/db/src/schema/companies.ts` | Drop `.default(...)` on `organization_id`; rewrite the adjacent comment to the fail-closed / E2-D07 contract. |
| `packages/db/src/migrations/0210_drop_sentinel_org_default.sql` | **NEW** — verbatim `ALTER … DROP DEFAULT` + E2-D07 header comment. |
| `packages/db/src/migrations/meta/_journal.json` | idx 210 journal entry. |
| `packages/db/src/migrations/meta/0210_snapshot.json` | **NEW** — `db:generate` snapshot (default removed on companies.organization_id). |
| `server/src/services/tenant-admission.ts` | **NEW** — dormant sentinel admission-denial helper (FND-007 mirror). |
| `packages/db/src/__tests__/sentinel-org-removal.integration.test.ts` | **NEW** — real embedded-PG fail-closed proof (env-hatch, E2-D05). |
| `server/src/__tests__/sentinel-admission-unit.test.ts` | **NEW** — Windows-visible unit proof of the helper. |

## Acceptance evidence

| Acceptance condition (ticket §Scope / §Tests) | Evidence | RED → GREEN |
|---|---|---|
| (a) `companies.organization_id` has NO column default post-0210, still `is_nullable='NO'` | `sentinel-org-removal` test "has NO column default and is still NOT NULL"; `information_schema.columns.column_default IS NULL`. RED pre-drop: `column_default = "'00000000-…0001'::uuid"`. | `pass` (RED→GREEN) |
| (b) raw `INSERT INTO companies (...)` OMITTING `organization_id` is REJECTED with 23502 (fail closed) | same test; PG server log confirms `null value in column "organization_id" … violates not-null constraint`; `err.code==='23502'`, `err.column_name==='organization_id'`. RED pre-drop: INSERT SUCCEEDS (buckets via default) → `captureReject` throws. | `pass` (RED→GREEN) |
| (c) explicit-org INSERT (incl. the Default-Org sentinel) still SUCCEEDS; sentinel-org company is valid, not invalid/deleted | same test; two positive controls — sentinel-org INSERT returns the row + a follow-up SELECT finds it; real-org INSERT succeeds. Green both pre/post (control). | `pass` |
| Admission helper rejects BOTH FND-007 sentinels + accepts a real uuid; `assertAdmissibleOrganization` throws for sentinels, not for real id; case/whitespace-insensitive | `sentinel-admission-unit` (10 tests): set-mirror + frozen; `isForbiddenOrganizationSentinel` both forms true / real false / padded+upper true / empty false; `assertAdmissibleOrganization` throws typed error for both forms + padded, not for real; error carries `.organizationId`. RED: module absent → fail-to-collect. | `pass` (RED→GREEN) |
| `DEFAULT_ORGANIZATION_ID` not removed | `packages/shared/src/constants.ts:406` unchanged (untouched by this ticket). | `pass` |
| Migration idempotency gate holds (no guard needed for DROP DEFAULT) | `migration-idempotency.test.ts` **5 passed** — 0210 not flagged. | `pass` |
| Journal contiguous + file-aligned | `migration-journal-contiguity.test.ts` **4 passed** (idx 210 aligned). | `pass` |
| Broad glob: dropping the default does NOT NOT-NULL-break the swept surface | server `companies-*/company-*/*org*` glob **59 passed / 13 skipped / 2 plugin-sdk fail-to-collect** (514 tests passed / 62 skipped) — identical to the TEN-006a-recorded figure; real-PG env-hatch spot-runs GREEN (see Commands). | `pass` |

**Snapshot integrity:** `diff` of the sorted `0209_snapshot.json` vs
`0210_snapshot.json` (ignoring the always-changing `id`/`prevId`) yields a single
removed line — `"default": "'00000000-0000-0000-0000-000000000001'"` on
`companies.organization_id`. No other schema drift.

## Commands

| Command | Exit | Summary |
|---|---:|---|
| `git rev-parse HEAD` (before first change) | `0` | `80bb23552…` (Start SHA), tree clean |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run sentinel-org-removal.integration.test.ts` (RED, pre-change) | `1` | **2 failed / 3 passed** — (a) `column_default` = sentinel `::uuid` (not null); (b) org-omitting INSERT SUCCEEDS (buckets via default); controls green |
| `vitest run sentinel-admission-unit.test.ts` (RED, pre-helper) | `1` | fail-to-collect: `Cannot find module '../services/tenant-admission.js'` |
| `pnpm --filter @armyofagents/db build` (compile schema) + `drizzle-kit generate --name=drop_sentinel_org_default` | `0` | emitted `0210_drop_sentinel_org_default.sql` = single `ALTER … DROP DEFAULT` |
| `pnpm --filter @armyofagents/db typecheck` | `0` | clean |
| `pnpm --filter @armyofagents/db build` | `0` | clean (dist/migrations synced) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run sentinel-org-removal.integration.test.ts` (GREEN) | `0` | **5 passed**; PG log confirms 23502 not-null trip on the org-omitting INSERT |
| `vitest run sentinel-admission-unit.test.ts` (GREEN) | `0` | **10 passed** |
| `vitest run migration-idempotency + migration-journal-contiguity + migration-cli-snapshot-gate + migration-snapshot-gate + organizations-migration-journal` | `0` | **45 passed** (5 files) — DROP DEFAULT needs no idempotency guard; journal contiguous |
| `vitest run companies-*.test.ts company-*.test.ts *org*.test.ts` (broad glob, no env var) | `1` | **59 passed / 13 skipped / 2 failed** (514 tests passed / 62 skipped). The 2 fail-to-collect = `company-plugin-upgrade-rollback` + `company-portability-preview-export` (E2-F009 plugin-sdk baseline; neither touches a changed file) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run` swept company-inserting env-hatch integration files | `0` | **66 passed** — `org-agent-platform-default-sandbox` 2, `memory-rbac-leakage` 8, `crew-repair` 37, `crew-marketplace-bootstrap` 15, `ask-founder-dogfood` 4 (isolated). Proves explicit-org company inserts still succeed against real PG with the default DROPPED (no NOT-NULL regression) |
| `pnpm --filter @armyofagents/server typecheck` | `2` | **66 errors, ALL plugin-subsystem** (`@armyofagents/plugin-sdk` absent, E2-F009); **zero reference any changed file** (grep of `tenant-admission`/`sentinel-*` = none) |

## Deviations

1. **Real-PG regression coverage on Windows is env-hatch-only.** 11 of the 12
   `*.integration.test.ts` files in the broad company/org glob are shipped
   **Pattern A** (`skipIf(process.platform !== "linux")`) and skip on Windows
   regardless of `AOA_RUN_WIN_INTEGRATION` (E2-D05 documents this). They were NOT
   source-edited to run (no edit-and-restore dance). Instead, the no-NOT-NULL-
   regression proof against real PG uses the **env-hatch** company-inserting files
   that TEN-006a swept (66 tests GREEN above). The full swept-surface real-PG run
   across the Pattern-A files is owned by the mandatory **≥1 Linux CI run**
   (E2-D05 / E2-F008) — a gate action.
2. **One transient parallel-boot flake, not a regression.** In the batched
   env-hatch run, `ask-founder-dogfood` failed in its `beforeAll` embedded-PG setup
   (`setupError` re-thrown — the documented E2-F010 socket-bind flake class under
   4× parallel PG boots), never reaching a test body / the guard. Re-running it
   isolated → **4 passed**. This is the coordinator-flagged hardcoded/parallel-boot
   flake, orthogonal to the fail-closed change.
3. **Migration file carries a header comment only** (E2-D07 documentation +
   idempotency rationale). No DDL text was added or changed beyond the verbatim
   `db:generate` `ALTER … DROP DEFAULT` — this is the C14 comment/attribution
   convention (0195/0209 precedent), not hand-authored DDL.

## Findings

- `E2-F009` (pre-existing `@armyofagents/plugin-sdk` absence → server typecheck
  exit 2, 66 plugin-subsystem errors; the 2 company-glob suites
  `company-plugin-upgrade-rollback` + `company-portability-preview-export`
  fail-to-collect on the transitive plugin import) re-confirmed unchanged: zero
  errors reference any TEN-006b file. DEC-03 / E2-F009-waivable; not an
  epic-touched defect. **No new findings.**

## Fail-closed choices to scrutinize

- The only new fail-closed edge is the intended one: a company writer that supplies
  **no** Organization now trips `NOT NULL` (23502) instead of bucketing into the
  Default Org. No legitimate Default-Org resolution was replaced by a fail-closed
  path — the self-hosted explicit Default-Org resolution (TEN-006a
  `resolveCompanyOrganizationId` non-enforced branch) is untouched and still
  succeeds (proven by control (c): explicit-sentinel INSERT succeeds).
- The admission helper is deliberately **narrow** at E2 (sentinel-only; empty/
  unmapped NOT rejected) and **dormant** (no caller). Reviewer should confirm this
  matches E2-D07 (unmapped + wiring = E3 JOB-001/JOB-010) and that leaving empty-id
  admissible here is intended (not a helper-level fail-open — new-path
  `organization_id NOT NULL` is the E2 structural guard).

## Gate recommendation

`ready for independent review` — the fail-open→fail-closed drop is RED→GREEN proven
against real embedded PG (23502 on the org-omitting INSERT; explicit-org + sentinel
controls green); the admission helper is RED→GREEN proven at the unit level and
mirrors FND-007 exactly; migration 0210 is verbatim `db:generate` + a C14 comment,
the idempotency/journal gates pass, and the snapshot delta is confined to the
default removal; the broad glob shows zero new unit-level regression and the
env-hatch real-PG spot-runs show no NOT-NULL regression; the server-typecheck delta
is subset-of-baseline (E2-F009). **H-01 formal evidence still requires the mandatory
≥1 Linux CI run (E2-D05 / E2-F008) across the full swept + new integration surface —
a gate action.**

## Independent review

**Reviewer:** `claude-opus (independent reviewer subagent) — NOT the TEN-006b implementer`
**Reviewed revision:** `a269f8bd2cd15a90c26c61784c473033ab229872` (HEAD; tree clean)
**Disposition:** `approved → complete`
**Review evidence:**

Re-ran the full acceptance set from C:\e2 at HEAD; every gate passed and the
fail-open→fail-closed drop is proven against real embedded PG:

- **Schema (V1):** `companies.ts:20` — `.default(...)` DROPPED; `.notNull()` + the
  `references(organizations.id, onDelete:"restrict")` FK RETAINED; comment rewritten
  to the fail-closed / E2-D07 contract ("Do NOT re-add `.default(...)`").
  `DEFAULT_ORGANIZATION_ID` retained at `constants.ts:406`.
- **Migration (V2):** `0210_drop_sentinel_org_default.sql` = exactly ONE DDL
  statement (`ALTER TABLE "companies" ALTER COLUMN "organization_id" DROP DEFAULT;`,
  verbatim `db:generate`) + a leading C14 header comment only. Snapshot delta
  `0209→0210` (id/prevId stripped) = **1 line** — the removed
  `"default": "'00000000-0000-0000-0000-000000000001'"` on
  `companies.organization_id`, no other drift. `_journal.json` idx 210 contiguous
  after 209. `migration-idempotency.test.ts` **5 passed** (DROP DEFAULT not flagged;
  no `IF NOT EXISTS`/`DO $$` needed — naturally idempotent, outside the CREATE-scan).
- **Fail-closed is genuine (V3):** `AOA_RUN_WIN_INTEGRATION=1 vitest run
  sentinel-org-removal.integration.test.ts` → **5 passed**; PG server log shows a REAL
  `ERROR: null value in column "organization_id" of relation "companies" violates
  not-null constraint` (SQLSTATE 23502) on the org-omitting INSERT — not a
  mocked/typo failure. Explicit-org INSERT (incl. the Default-Org sentinel) still
  SUCCEEDS and the sentinel-org row is valid, not deleted. Without the env flag the
  suite is **5 skipped** (E2-D05 `skipIf` env-hatch, not the banned ternary).
- **Admission helper (V4):** `FORBIDDEN_ORGANIZATION_SENTINELS` mirrors FND-007
  `forbiddenOrganizationSentinels` **byte-exact, same order**
  (`["org_00000000000000000000000000","00000000-0000-0000-0000-000000000001"]`),
  frozen, cited to `distributed-execution-legacy-parity.json:15-19` (Decision #121).
  `sentinel-admission-unit.test.ts` **10 passed** — both sentinel forms + padded/upper
  rejected, real uuid accepted, empty NOT rejected (E3 unmapped concern), typed
  `ForbiddenOrganizationSentinelError` carries `.organizationId`. Helper is **DORMANT**:
  grep across `server/src` + `packages` for every export finds NO caller beyond the
  module + its unit test (unmapped check + submit/place/lease wiring correctly deferred
  to E3 JOB-001/JOB-010 per E2-D07).
- **CAV-005 / Rule #1 / hygiene (V5):** commit `a269f8bd2` touches only 8 files
  (2 modified + 5 new + this ledger); NO RLS / `assertCompanyAccess` / `rls-bootstrap.ts`
  / `with-tenant-tx.ts` / new-path tenant table touched (the only `services/*` change is
  the chartered `tenant-admission.ts` helper itself). Sentinel-org rows remain valid at
  the row level (E2-D07 dual identity). No `package.json` / `pnpm-lock.yaml` change.
- **E2-F009 baseline (V6):** `server` typecheck grep for
  `tenant-admission|companies.ts|constants|sentinel` → **none**. Broad regression payoff
  `companies-*/company-*/*org*` = **59 passed / 13 skipped / 2 fail-to-collect files**
  (514 tests passed / 62 skipped) — IDENTICAL to the TEN-006a baseline; the only 2
  failures are `company-plugin-upgrade-rollback` + `company-portability-preview-export`,
  both the pre-existing `@armyofagents/plugin-sdk`-absent collect failure (E2-F009),
  neither touching a changed file. Real-PG spot-runs with the default gone:
  `org-agent-platform-default-sandbox` **2 passed**, `memory-rbac-leakage` **8 passed**
  — explicit-org company inserts still succeed (no NOT-NULL regression).

**Re-run commands + exit codes:** `db typecheck` 0 · `db build` 0 ·
`sentinel-org-removal.integration` (flag) 0 / **5 passed** (23502 in PG log) ·
`sentinel-org-removal.integration` (no flag) 0 / **5 skipped** ·
`sentinel-admission-unit` 0 / **10 passed** · `migration-idempotency` 0 / **5 passed** ·
broad `companies-*/company-*/*org*` glob exit 1 (plugin-sdk collect only) / **514 passed
/ 62 skipped, 2 fail-to-collect** · spot `org-agent-platform-default-sandbox` 0 / 2 ·
spot `memory-rbac-leakage` 0 / 8.

**Notes (non-blocking):** (1) the plan's TEN-006b owned-files list named
`company-writer-no-sentinel.integration.test.ts`, which does not exist — the
writer-fail-closed coverage correctly landed as `company-writer-fail-closed.test.ts`
under TEN-006a (`c4d8756c8`); this is a benign allocation across the E2-D07 split, and
TEN-006b's DB-level 23502 proof is present. (2) H-01 formal evidence still owes the
mandatory ≥1 real Linux CI run across the full swept + new integration surface
(E2-D05 / E2-F008) — a GATE action, Windows-local per DEC-03 for this ticket review,
NOT a TEN-006b defect. With TEN-006a already `complete`, this completes **TEN-006 (a+b)**.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | `claude-opus (independent, ≠ implementer)` | `a269f8bd2` | `approved → complete` | All acceptance re-run GREEN: 23502 fail-closed proven in PG log on the org-omitting INSERT; migration = verbatim single DROP DEFAULT + C14 header, snapshot delta 1 line, journal idx 210 contiguous, idempotency 5/5; helper mirrors FND-007 byte-exact + DORMANT (no caller); broad glob 514 passed / 62 skipped / 2 E2-F009 plugin-sdk collect-fails (= TEN-006a baseline); real-PG spot-runs 2+8 GREEN. No new findings. Pending H-01 Linux-CI run is a gate action (E2-D05/F008), not a ticket defect. |
