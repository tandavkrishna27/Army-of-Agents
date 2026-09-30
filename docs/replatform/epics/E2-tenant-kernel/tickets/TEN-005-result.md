# TEN-005 Result — Tenant adversarial property suite

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E2-tenant-kernel`
**Plan task:** `TEN-005 — Tenant adversarial property suite (M) — surface scope E2-D04 / finding E2-F003`
**Implementer:** `claude-opus (implementer subagent)`
**Start SHA:** 3fb4c368001a7ba8a6be57e49fce415f67de212a

The Start SHA is the actual `git rev-parse HEAD` of the C:\e2 worktree captured
before the first change. Plan §0 lists `df509b946` as the "E2 Start SHA"; that commit
is an ancestor of this HEAD (TEN-001a/b, TEN-004, TEN-006a/b, TEN-002 + E2-F011 fix,
TEN-003 + E2-F012 confirmation have since landed). Mirrors the TEN-001/002/003/004/006
convention.

**Preconditions verified:** TEN-003 (`runInTenant`) and TEN-004 (composite FKs) are
`complete` on the branch; TEN-002 (non-owner `aoa_app` role + FORCE RLS + per-table
policies + `createTenantAppDb` fail-closed pool + migration `0211`) underpins them.
E2-D04 (surface scope + uniform denial + null-Org read) governs this ticket;
`AOA_RUN_WIN_INTEGRATION` env-hatch per E2-D05.

## E2-F013 fix (post review attempt 1) — FK-identity existence oracle closed at the DB level (E2-D09)

Review **attempt 1** was `changes_requested` on a REAL, untested H-01 existence
oracle (**E2-F013**): FK referential-integrity checks **bypass RLS**, and TEN-004 kept
redundant single-column PARENT FKs alongside the composite tenant FKs. So as `aoa_app`
in org A, an **own-org** insert (RLS `WITH CHECK` passes) whose composite parent id is a
**cross-tenant** row failed the COMPOSITE FK (`jobs_org_company_fk`), while an **absent**
parent id failed the SINGLE-column FK (`jobs_company_id_companies_id_fk`) — a distinct
`constraint_name` + message = a cross-tenant existence oracle. Systemic across all 7
child tables. The original suite tested only the cross-ORG insert (uniform 42501) and
never this own-org write-vs-write axis; the result misclaimed "no leak found."

**Fix (E2-D09 — closed at the DB level, NOT app-layer normalization):** dropped the 7
redundant single-column PARENT FKs and moved their `ON DELETE` onto the composite tenant
FKs, so a cross-tenant parent id and an absent parent id now BOTH fail the SAME composite
FK with an identical constraint/message. The `organization_id → organizations`
single-column FKs are KEPT (tenant key; a cross-org value hits RLS `WITH CHECK` (42501)
before any FK — not an oracle). Schema edits in the 7 `packages/db/src/schema/*.ts`
child modules; migration **`0212_fk_dedup_tenant_oracle.sql`** (`pnpm db:generate`, all
14 `DROP CONSTRAINT` precede the 7 composite-FK `ADD CONSTRAINT` — DROP-before-ADD holds
without reorder, E2-D08 N/A; ALTER-only, no CREATE → migration-idempotency unaffected).

**RED→GREEN proof:** on the pre-fix schema (single-col FKs restored, 0212 removed) the
new oracle-axis assertion FAILS for all 8 seeds — cross parent → `jobs_org_company_fk`,
absent parent → `jobs_company_id_companies_id_fk` (distinct constraint + message). After
the fix both are the byte-identical `insert or update on table "jobs" violates foreign
key constraint "jobs_org_company_fk"` → GREEN.

**New coverage:** `tenant-adversarial.property.integration.test.ts` gains the
`crossParentVsAbsentUniform` op class (216 ops; own-org insert, cross-tenant vs absent
parent for `jobs`/`job_attempts`/`services`) asserting identical SQLSTATE (23503) +
constraint_name + byte-identical deepest DB message. `tenant-graph.ts` exports
`TENANT_ADVERSARIAL_OP_CLASSES` (the counter set, incl. the oracle axis). New
`packages/db/src/__tests__/tenant-composite-ondelete.integration.test.ts` proves the ON
DELETE moved correctly: deleting a job CASCADEs its attempts/artifacts/secret-handles
(and attempts CASCADE leases), deleting a service CASCADEs its instances, deleting a
company that owns a job/service is RESTRICTED (`23001` restrict_violation on the
composite FK — confirming RESTRICT, not NO ACTION). Total ops now **4,460/8 seeds**.

## Delivered scope

- **`server/src/testing/tenant-graph.ts`** — a deterministic, seed-reproducible tenant
  graph generator + hostile-identifier corpus + surface registry. **No `Math.random` /
  no wall-clock** — a seeded **mulberry32** PRNG plus the seed integer derives every
  value (ids, counts, slugs, prefixes), so the same seed reproduces a **byte-identical**
  graph. Exports:
  - `generateTenantGraph(seed, opts?) → TenantGraph`: **4–6 Organizations** (count is
    PRNG-drawn from the seed, bounded by `minOrgs`/`maxOrgs`), each with companies +
    `jobs` / `job_attempts` / `leases` / `services` / `service_instances` /
    `job_artifacts` / `job_secret_handles` + org-scoped `workers`, PLUS graph-level
    **platform (null-Org) `workers`**. Emits typed **row descriptors** (ids + org/company/
    parent linkage) so the suite seeds them with EXPLICIT ids and can cross-reference
    tenants. Slugs (`s{seed}-org{n}`) and issue-prefixes (`T{seed}O{n}C{n}`) embed the
    seed so many graphs coexist in one DB without tripping `organizations_slug_uq` /
    `companies_issue_prefix_idx`.
  - `buildHostileCorpus(graph, actorOrgId) → HostileCorpus`: for an actor tenant, the
    other-tenant ids per accessor type (cross-Organization, cross-Company-within-other-
    org), the forbidden sentinel Organization (`FORBIDDEN_SENTINEL_ORG_ID` =
    `…000000000001`), the null-Org platform worker ids, plus valid-format-but-**absent**
    uuids and **malformed** ids.
  - `TENANT_ADVERSARIAL_SURFACES`: the surface registry — `repository` + `composite_sql`
    `implemented: true`; `http` / `worker_events` / `websocket` / `object_key` /
    `placement` / `restore` `implemented: false` with the owning epic in `note` (E2-D04,
    no silent cap; later epics flip these + register drivers).
  - `TENANT_ADVERSARIAL_SEEDS`: the fixed **8-seed** set `[1, 7, 13, 42, 101, 1337,
    20260809, 2147483647]`.
- **`server/src/__tests__/tenant-adversarial.property.integration.test.ts`** — the
  capstone H-01 adversarial property suite (E2-D05 env-hatch embedded-PG). For **each of
  the 8 seeds**, seeds the graph as the SUPERUSER (RLS-bypassing) then, acting through
  the NON-OWNER `aoa_app` pool inside `runInTenant` / `withTenantTx`, hurls the hostile
  corpus at the E2-available surfaces and asserts **fail-closed with no existence
  disclosure** (see Acceptance). **4,244 adversarial ops** across the 8 seeds
  (414–647/seed), every op class exercised ≥ once (non-vacuous).
- **`server/src/__tests__/tenant-graph-unit.test.ts`** — Windows-visible unit sibling:
  generator determinism (same seed → byte-identical; different seeds differ; options
  honored), intra-tenant referential integrity, uuid-format + global uniqueness of
  ids/slugs/prefixes (incl. across seeds), corpus shape, and surface-registry shape.

**E2-D04 surface-scope note (recorded, no silent cap):** the surfaces that EXIST at E2
and are exercised here are **`repository`** (tenant repositories via `runInTenant` over
the non-owner pool + forced RLS — TEN-002/TEN-003) and **`composite_sql`** (direct-SQL
mixed-tenant construction rejected by the TEN-004 composite FKs — 23503). **`http`** is
not exercised because no HTTP endpoint reads/writes a new-path table at E2 (entry-point
adoption rides E3 per E2-D04); **`worker_events`/`websocket`/`placement`** (E3/E4),
**`object_key`** (E5), and **`restore`** (E6) are registered NOT-implemented for later
epics to extend the SAME harness. The **full D1 floor** (`D1-01`: 20 seeds × 10,000 ops
× ≥10 Organizations, `test-gates.md`) is owned by the **D1 gate**, NOT E2.

**Audit note (E2):** at E2 there is **no audit sink** for these DB-level RLS denials
(activity-log wiring is E3). "Failures are audited where a sink exists" is therefore
**vacuously satisfied** — no audit path is fabricated.

**Non-goals preserved:**
- **Schema/migration change (E2-F013 fix only):** migration **`0212`** drops the 7
  redundant single-column parent FKs + moves ON DELETE onto the composite FKs (per
  E2-D09; see the E2-F013-fix section). The chain caps at `0212`. This is a TEN-004
  schema correction riding under E2-F013 (TEN-004's frozen ledger is NOT edited). **No**
  route/scheduler wiring. *(The original TEN-005 commit `664daadc9` was test-only, chain
  at 0211; the fix adds the schema correction.)*
- **No change** to the TEN-002 RLS policies, `rls-tenant.ts`, `runInTenant`,
  `with-tenant-tx.ts`, the tenant repository, `createDb`, `rls-bootstrap.ts`, or
  `assertCompanyAccess`. **The FK-identity oracle is closed at the DB level (E2-D09), NOT
  by app-layer normalization** — the tenant repository accessors stay plain RLS-backed
  `tx.select`/`insert` with no catch-and-differentiate; the DB-enforced fix means even a
  raw `aoa_app` query gets the uniform composite-FK denial (app-layer normalization
  remains an OPTIONAL E3 defense-in-depth per E2-D09).
- No new dependency; **no `package.json`/`pnpm-lock.yaml` change** (AGENTS §7 N/A).
- Caveat/credential/target impact: *N/A — E2 introduces no placement, credential,
  provider, or locality logic; CAV-005: no legacy RLS retrofit; provider-neutral seam
  untouched.*

## Changed files

| File | Responsibility |
|---|---|
| `server/src/testing/tenant-graph.ts` | **New / updated.** Deterministic seeded generator + hostile corpus + surface registry + SEED set; **E2-F013:** exports `TENANT_ADVERSARIAL_OP_CLASSES` (incl. the `crossParentVsAbsentUniform` oracle axis). |
| `server/src/__tests__/tenant-adversarial.property.integration.test.ts` | **New / updated.** Embedded-PG H-01 adversarial property suite; **E2-F013:** adds the own-org cross-vs-absent parent oracle axis (identical composite FK + byte-identical message). |
| `server/src/__tests__/tenant-graph-unit.test.ts` | **New / updated.** Windows-visible determinism + corpus/registry shape; **E2-F013:** asserts the op-class set incl. the oracle axis. |
| `packages/db/src/schema/{jobs,job_attempts,leases,services,service_instances,job_artifacts,job_secret_handles}.ts` | **E2-F013/E2-D09:** drop the redundant single-column parent FK; move ON DELETE onto the composite FK. `organization_id` FK kept. |
| `packages/db/src/migrations/0212_fk_dedup_tenant_oracle.sql` (+ `meta/`) | **New.** `db:generate` output: DROP 7 single-col + 7 composite FKs, ADD 7 composite FKs with ON DELETE (DROP-before-ADD). |
| `packages/db/src/__tests__/tenant-composite-ondelete.integration.test.ts` | **New.** Proves ON DELETE moved correctly to the composite FKs (cascade + restrict). |

## Acceptance evidence

Property suite `tenant-adversarial.property.integration.test.ts`, embedded-PG,
`AOA_RUN_WIN_INTEGRATION=1` → **11 passed**. Unit sibling → **11 passed** (was 10;
+op-class test). **Post-E2-F013 op counts** (deterministic, identical on re-run):
`totalOps=4460`,
`perClass={crossRead:2688, absentRead:288, crossList:640, crossInsertReject:72,
crossUpdateZero:144, crossDeleteZero:144, updateToOtherOrgReject:36, nullOrgReadZero:144,
nullOrgWriteReject:72, compositeSqlReject:16, crossParentVsAbsentUniform:216}`,
`perSeed={1:677, 7:438, 13:677, 42:677, 101:438, 1337:438, 20260809:438, 2147483647:677}`.
(The original test-only commit `664daadc9` was `totalOps=4244`; +216 is the new oracle
axis.)

| Acceptance condition (plan §TEN-005 / E2-D04) | Evidence | Result |
|---|---|---|
| **READ** — another tenant's row by id → `null`, and an absent id → `null`, and the two are **indistinguishable** (both null), across all 8 accessor types | integration per-seed it, `crossRead=2688` / `absentRead=288` ops, `check()` asserts `crossRes === absentRes === null` | `pass` |
| **READ (list)** — `listForCompany(otherOrgCompany)` → `[]`; `listForOrganization(otherOrg)` → `[]` | `crossList=640` ops → all length 0 | `pass` |
| **WRITE (insert)** — `repos.jobs.insert({ organizationId: OTHER_ORG, … })` in actor context → **42501** (RLS WITH CHECK) | `crossInsertReject=72`; `expect(sqlstate).toBe("42501")` | `pass` |
| **WRITE no-disclosure** — cross-insert 42501 is IDENTICAL whether the referenced company exists (real victim company) or not (absent uuid); deepest DB message identical + never echoes a victim id | real vs absent SQLSTATE both 42501 + `pgDeepestMessage` equal = `new row violates row-level security policy for table "jobs"` (logged) | `pass` |
| **WRITE (update-to-other-org)** — UPDATE the actor's own row to OTHER_ORG → **42501**; same class as cross-insert | `updateToOtherOrgReject=36`; `expect(sqlstate).toBe("42501")` and equals cross-insert SQLSTATE | `pass` |
| **UPDATE/DELETE cross-tenant by id → 0 rows** (RLS USING hides it — indistinguishable from an absent id) | `crossUpdateZero=144` / `crossDeleteZero=144`; `RETURNING id` rows length 0 for cross AND absent | `pass` |
| **null-Org read** — no tenant GUC returns a platform (org-NULL) worker (by `IS NULL` filter or by id) | `nullOrgReadZero=144` → all counts 0 | `pass` |
| **null-Org write** — `aoa_app` cannot INSERT or UPDATE a worker to org NULL → **42501** | `nullOrgWriteReject=72`; `expect(sqlstate).toBe("42501")` | `pass` |
| **composite_sql** — direct-SQL mixed-tenant construction rejected by the TEN-004 composite FKs → **23503** (`jobs_org_company_fk`, `job_attempts_org_job_fk`) | `compositeSqlReject=16`; `expect(sqlstate).toBe("23503")` + constraint name | `pass` |
| **FK-oracle axis (E2-F013)** — own-org insert with a CROSS-TENANT parent id vs an ABSENT parent id both fail with the SAME composite FK (`jobs_org_company_fk` / `job_attempts_org_job_fk` / `services_org_company_fk`) + byte-identical deepest DB message → indistinguishable | `crossParentVsAbsentUniform=216`; RED (pre-fix): cross=`jobs_org_company_fk`, absent=`jobs_company_id_companies_id_fk` (distinct) → all 8 seeds FAIL. GREEN (post-0212): both `jobs_org_company_fk`, msg byte-identical (logged) | `pass` |
| **ON DELETE preserved (E2-D09)** — job delete CASCADEs attempts/artifacts/secret-handles (+ attempts CASCADE leases); service delete CASCADEs instances; company-with-job/service delete RESTRICTED | `tenant-composite-ondelete.integration.test.ts` 4 passed (cascade counts → 0; restrict → `23001` on `jobs_org_company_fk` / `services_org_company_fk`) | `pass` |
| **Non-vacuous** — ≥2 orgs/seed, non-empty corpus, ≥1 op per class, ≥100 ops/seed | dedicated `it`: every `opCounts[*] > 0` (incl. the oracle axis), every `perSeedOpCounts[*] ≥ 100` | `pass` |
| **Determinism** — reproducible from the fixed seeds | unit: `JSON.stringify` byte-identical same-seed / differs cross-seed; integration re-run → identical `totalOps=4244` + per-class counts | `pass` |
| **Serving role is non-owner** (else the whole suite is vacuous) | `assertNonOwnerConnection(appDb)` resolves; `(db)` rejects | `pass` |

**Uniform denial (E2-D04) — how "identical across read/write/absent" is proved:** the
operationally-precise, load-bearing property is **per-operation-KIND
indistinguishability of a cross-tenant target from an absent target** — proved on BOTH
axes:
- **read-vs-read:** cross-tenant READ ≡ absent READ (both `null`/`[]`).
- **write-vs-write (RLS axis):** cross-ORG WRITE ≡ absent-related WRITE (both `42501`,
  byte-identical DB message) — RLS `WITH CHECK` fires before any FK.
- **write-vs-write (FK axis — E2-F013 fix):** own-org WRITE with a cross-tenant PARENT id
  ≡ own-org WRITE with an absent PARENT id (both the SAME composite FK `23503`,
  byte-identical DB message). This is the axis review attempt 1 found leaking (distinct
  single-col vs composite constraint names) and E2-D09 closed at the DB level.

This is exactly "no existence disclosure": the caller cannot tell whether a supplied id
belongs to another tenant or does not exist, for any operation kind. The read + RLS-write
axes hold naturally (RLS-backed accessors, no leaky pre-checks); the FK-write axis now
holds because the redundant single-column FKs (the guard-identity discriminator) are gone
(migration 0212 / E2-D09).

## Commands

| Command | Exit | Result |
|---|---:|---|
| `pnpm --filter @armyofagents/db typecheck` | `0` | clean |
| `pnpm --filter @armyofagents/server typecheck` | `2` | **66** errors, **all** `@armyofagents/plugin-sdk` (E2-F009); **zero** reference `tenant-graph`/`tenant-adversarial` (grep clean); zero non-plugin errors |
| `vitest run tenant-graph-unit.test.ts` (RED, pre-impl) | `1` | `Cannot find module '../testing/tenant-graph.js'` |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-adversarial.property.integration.test.ts` (RED, pre-impl) | `1` | fails to load — `../testing/tenant-graph.js` missing |
| `vitest run tenant-graph-unit.test.ts` (GREEN) | `0` | **10 passed** |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-adversarial.property.integration.test.ts` (GREEN) | `0` | **11 passed**; `totalOps=4244`, 8 seeds, every op class > 0 |
| `vitest run tenant-adversarial.property.integration.test.ts` (NO flag) | `0` | **11 skipped** (E2-D05 env-hatch `skipIf`, not the banned ternary) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-adversarial.property.integration.test.ts` (re-run, determinism) | `0` | **11 passed**; **identical** `totalOps=4244` + per-class/per-seed counts |
| `vitest run integration-test-hygiene.test.ts` | `0` | **2 passed** (my `skipIf` form + comments not flagged) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-rls-enforcement + tenant-tx-context` | `0` | **17 passed** (TEN-002 10 + TEN-003 7 — no regression) |

**E2-F013 fix re-run (post-0212):**

| Command | Exit | Result |
|---|---:|---|
| `pnpm --filter @armyofagents/db typecheck` + `build` | `0` | clean (`foreignKey().onDelete()` valid) |
| `cd packages/db && drizzle-kit generate --name=fk_dedup_tenant_oracle` | `0` | `0212_fk_dedup_tenant_oracle.sql` (14 DROP before 7 composite ADD) |
| **RED** `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-adversarial…` (pre-fix schema restored, 0212 removed) | `1` | **8 failed** — oracle axis: cross=`jobs_org_company_fk` vs absent=`jobs_company_id_companies_id_fk` (distinct constraint + message) for all 8 seeds |
| **GREEN** `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-adversarial…` | `0` | **11 passed**; oracle msg cross==absent==`…"jobs_org_company_fk"`; `totalOps=4460` (identical on determinism re-run) |
| `vitest run tenant-graph-unit.test.ts` | `0` | **11 passed** (adds op-class-set test) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-composite-ondelete.integration.test.ts` | `0` | **4 passed** (cascade → 0; restrict → `23001` on composite FK) |
| `cd packages/db && AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-kernel-schema{,-b} + tenant-composite-integrity + tenant-composite-ondelete + migration-idempotency` | `0` | **29 passed** (no regression; TEN-004 composite FKs still reject mixed-tenant) |
| `AOA_RUN_WIN_INTEGRATION=1 vitest run tenant-rls-enforcement + tenant-tx-context + tenant-adversarial + tenant-graph-unit` | `0` | **39 passed** (no regression) |
| `vitest run tenant-adversarial…` (NO flag) | `0` | **11 skipped** (env-hatch) |
| `pnpm --filter @armyofagents/server typecheck` | `2` | **66** (E2-F009 baseline unchanged; zero reference `tenant-graph`/`tenant-adversarial`/the 7 schema files) |

**Seed count:** 8 (`TENANT_ADVERSARIAL_SEEDS`). **Ops per class (post-E2-F013, total across
8 seeds):** crossRead 2688, absentRead 288, crossList 640, crossInsertReject 72,
crossUpdateZero 144, crossDeleteZero 144, updateToOtherOrgReject 36, nullOrgReadZero 144,
nullOrgWriteReject 72, compositeSqlReject 16, **crossParentVsAbsentUniform 216** → **4460
total**.

## Deviations

1. **Raw-SQL ops via `withTenantTx` / superuser `db`.** The tenant repository surface
   deliberately exposes only `insert` / `getById` / `listFor*` (no update/delete/raw —
   TEN-001a). So READ + cross-INSERT ops go through `runInTenant` (the repository
   surface), while **UPDATE/DELETE-to-0-rows**, **update-to-other-org**, the **null-Org
   read/write** checks, and the **composite_sql** bypass are driven via `withTenantTx`
   (the same non-owner-pool primitive `runInTenant` is built on — TEN-003) or the
   superuser `db` (for the direct-SQL app-bypass, the TEN-004 surface). The RLS
   enforcement path is identical; mirrors the TEN-003 test's use of `withTenantTx` for
   raw SQL. Not a plan deviation — an interface consequence of the read-only repository.
2. **"No error message reveals existence" asserted on the DEEPEST PostgresError message,
   not drizzle's wrapper.** drizzle's `DrizzleQueryError.message` echoes the failing
   query + the params the CALLER supplied (the caller's OWN input — never a DB
   disclosure), so a naive substring check on it self-trips. The meaningful assertion is
   on the raw PostgresError leaf message (`pgDeepestMessage`), which for both the
   real-company and absent-company cross-inserts is the byte-identical RLS text `new row
   violates row-level security policy for table "jobs"` — no ids, no row contents.
3. **Uniform-denial interpretation (per-KIND indistinguishability) — CORRECTED after
   E2-F013.** E2-D04 frames it as "identical across a cross-tenant read, a cross-tenant
   write, and a truly-absent row." A READ returns `null` while a WRITE throws — these
   differ by operation KIND, so the load-bearing reading is that **within each kind** a
   cross-tenant target is indistinguishable from an absent one. Review attempt 1 correctly
   noted the original result over-narrowed this to the read-vs-RLS-write axes and MISSED
   the **write-vs-write FK axis** (own-org insert, cross-tenant parent vs absent parent),
   where the redundant single-column FKs leaked the guard identity (composite vs single
   constraint name). That axis is now (a) closed at the DB level (drop the single-col FKs,
   E2-D09 / migration 0212) and (b) explicitly asserted (the `crossParentVsAbsentUniform`
   op class: same composite FK + byte-identical message). All three write/read axes are
   proved.
4. **Malformed uuids kept in the corpus but not used for the indistinguishability core.**
   The corpus includes malformed ids (shape asserted in the unit test), but the property
   suite drives indistinguishability with valid-format **absent** uuids: a malformed uuid
   is `22P02` input-validation (tenant-independent), a different class from existence
   disclosure — kept separate to avoid conflation.

## Findings

- **E2-F013 (RESOLVED by this fix, per E2-D09)** — the composite-vs-single FK
  constraint-name existence oracle on the own-org `repos.*.insert` path. **Superseded the
  original result's incorrect "no leak found" claim.** Closed at the DB level: migration
  `0212` drops the 7 redundant single-column parent FKs + moves ON DELETE onto the
  composite FKs; TEN-005 gains the `crossParentVsAbsentUniform` axis (RED on the pre-fix
  schema for all 8 seeds; GREEN after). See `../findings.md#E2-F013`, `../decisions.md#E2-D09`.
- **E2-F009 (pre-existing)** re-confirmed unchanged: `pnpm --filter server typecheck`
  exits 2 with 66 errors, ALL `@armyofagents/plugin-sdk` / plugin subsystem; grep for
  `tenant-graph`/`tenant-adversarial` over the error output → none. DEC-03-waivable /
  subset-of-baseline.
- **E2-F012 (informational)** — the suite drives every new-path access through
  `runInTenant` / `withTenantTx` with the context ALWAYS set to a valid uuid, so it never
  encounters the reused-connection `22P02` fail-closed path (as E2-F012 itself notes);
  no uniform-denial concern.

## Follow-up tickets

`None` — later epics (E3/E4/E5/E6) extend `TENANT_ADVERSARIAL_SURFACES` with their new
surfaces; the full D1-floor cross-surface run is the D1 gate's (E2-D04), not a TEN-005
follow-up.

## Gate recommendation

`ready for RE-review (E2-F013 fix)` — review attempt 1's blocking finding **E2-F013** is
resolved. The FK-identity existence oracle is closed at the DB level (E2-D09): migration
`0212` drops the 7 redundant single-column parent FKs and moves ON DELETE onto the
composite FKs, so an own-org insert with a cross-tenant parent id and one with an absent
parent id now BOTH fail the SAME composite FK with a byte-identical message. The suite
gains the `crossParentVsAbsentUniform` axis proving it (**RED on the pre-fix schema for
all 8 seeds; GREEN after 0212**), and a new `tenant-composite-ondelete` test proves the ON
DELETE cascade/restrict moved correctly. All prior coverage stands (reads null≡null,
cross-writes 42501-uniform, UPDATE/DELETE 0-rows, null-Org denied, composite_sql 23503),
now **4,460 deterministic ops / 8 seeds** (identical on re-run). Chain caps at `0212`;
TEN-004 composite-integrity + migration-idempotency + the full tenant chain do not
regress (29 db + 39 server passed); server typecheck baseline unchanged (66, E2-F009).
The re-reviewer should scrutinize: (1) the RED→GREEN oracle-axis evidence (constraint
name cross==absent post-fix) and that migration `0212` is DROP-before-ADD + ALTER-only;
(2) that the `organization_id → organizations` FKs are KEPT (not part of the drop) and
`onDelete` moved verbatim per the E2-D09 table; (3) the ON DELETE preservation
(cascade → 0, restrict → `23001` on the composite FK); (4) that the fix is DB-level (no
app-layer normalization) so a raw `aoa_app` query is also covered; (5) the still-owed
real Linux run for H-01 at the E2 gate (E2-D05/E2-F008 — Windows-local evidence here).

## Independent review

**Reviewer:** `claude-opus (independent reviewer subagent)` — distinct identity from the implementer (`claude-opus (implementer subagent)`); did not author the suite. (Latest attempt = 2; attempt 1 preserved in the history table below.)
**Reviewed revision:** `3f994fd6b1c1c3d9c51fb7242f3bde0426437aac` (HEAD of `claude/epic-e2-tenant-kernel`).
**Disposition:** `approved`
**Review evidence (attempt 2 — E2-F013 fix re-review):** The blocking attempt-1 finding **E2-F013** (the FK-guard-identity existence oracle) is **CLOSED at the DB level per E2-D09**, verified at HEAD `3f994fd6b`. Migration `0212_fk_dedup_tenant_oracle.sql` is DROP-before-ADD + ALTER-only (14 `DROP CONSTRAINT` — the 7 redundant single-column parent FKs + the 7 composite FKs — then 7 composite `ADD CONSTRAINT` with `ON DELETE`); every `organization_id → organizations` FK is KEPT; the 7 schema modules retain NO parent-id single-col `.references()` (verified by grep) and each composite `foreignKey(...).onDelete(...)` matches the E2-D09 table (jobs/services company = `restrict`; job_attempts/leases/service_instances/job_artifacts/job_secret_handles parent = `cascade`). **Oracle closed (the crux, from the PG log):** own-org(A) `repos.{jobs,attempts,services}.insert` with a cross-tenant parent id and with an absent parent id now BOTH fail the SAME composite FK — `jobs oracle msg (cross)="…violates foreign key constraint \"jobs_org_company_fk\"" (absent)="…\"jobs_org_company_fk\""` — byte-identical `23503`, identical `constraint_name`, no id echo; `crossParentVsAbsentUniform=216` (> 0). **Determinism:** property suite 11 passed, `totalOps=4460`, identical on a second run (per-class + per-seed identical). **ON DELETE preserved** (`tenant-composite-ondelete.integration.test.ts` → 4 passed): job delete CASCADEs attempts/artifacts/secret-handles=0 and attempt→leases=0; service delete CASCADEs instances=0; deleting a company that owns a job/service is RESTRICTED — `23001` on `jobs_org_company_fk` / `services_org_company_fk` (observed in the PG log). **No regression:** db chain 25 passed (`tenant-composite-integrity` 9 — references only composite FK names, `tenant-kernel-schema` 4, `-b` 7, `migration-idempotency` 5), server chain 28 passed (`tenant-rls-enforcement` 10, `tenant-tx-context` 7, `tenant-graph-unit` 11), no-flag → 11 skipped; `@armyofagents/db` typecheck → 0; server typecheck baseline unchanged (66 = E2-F009; grep confirms zero errors reference the changed schema/suite files). **Scope:** DB-level fix only — no app-layer normalization added; `server/src/db/rls-tenant.ts` (RLS policies), `packages/db/src/client.ts` (`createTenantAppDb`/`assertNonOwnerConnection`), `rls-bootstrap.ts`, `assertCompanyAccess`, and package manifests/lockfile are UNCHANGED (`git diff --name-only 9adb6816f..HEAD`); the frozen `TEN-004-result.md` ledger is unedited (correction rides under E2-F013); the 7 comment corrections (`3f994fd6b`) are comment-only. All other TEN-005 aspects were already approved at attempt 1 (determinism, non-owner serving via `assertNonOwnerConnection`, null-Org denial, composite_sql 23503, RLS 42501 uniformity, non-vacuous op-class counters) and continue to hold. The original "no leak found" claim has been corrected in this result (§Findings / §Deviations 3 / §Gate recommendation). **APPROVED — completes all 7 E2 (tenant-kernel) tickets.**

For `approved`, verify the result describes the reviewed revision, all focused acceptance evidence passes, and every accepted finding is resolved; then change the top-level `Status` to `complete` and commit this disposition separately. Otherwise leave `Status` as `gate_review` or set `blocked`, and link stable findings.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary above is not a review attempt. The first independent reviewer appends attempt 1, and later reviewers append monotonically increasing rows without replacing prior attempts. The summary fields above mirror the latest real attempt for existing gate tooling. Do not include a `Review commit` column: a row cannot embed the SHA of the commit that first contains it. Repository history identifies that commit, and handoffs pin the resulting ticket-result blob SHA.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
<!-- First independent reviewer appends attempt 1. -->
| 1 | `claude-opus (independent reviewer subagent)` | `664daadc9c8d9fb86235bf2eb79cbd8bb377203b` | `changes_requested` | Acceptance re-runs all reproduce (db typecheck 0; server typecheck 66 = E2-F009 baseline, none reference TEN-005 files; unit 10 passed; property 11 passed `totalOps=4244`; **determinism re-run identical 4244** + per-class/per-seed; no-flag 11 skipped; TEN-002/003 regressions 17 passed). Non-vacuity + non-owner serving + null-Org + composite_sql confirmed. **Blocking finding E2-F013:** own-org insert referencing a cross-tenant company (`23503 jobs_org_company_fk`) is distinguishable from an absent company (`23503 jobs_company_id_fkey`) by constraint-name + message on the sanctioned `repos.*.insert` path — the exact FK-vs-RLS-vs-not-found guard-identity leak E2-D04 / plan `:410-413` require normalized to one shape and asserted absent. Suite tests only the cross-ORG insert (uniform 42501); normalization not implemented; result misclaims "no leak found." Reproduced on embedded-PG 18.1. Fix + file:line in findings.md#E2-F013. |
| 2 | `claude-opus (independent reviewer subagent)` | `3f994fd6b1c1c3d9c51fb7242f3bde0426437aac` | `approved` | Focused re-review of the E2-F013 fix (E2-D09). **Oracle CLOSED at the DB level:** migration `0212` (DROP-before-ADD, ALTER-only; 14 DROP → 7 composite ADD with ON DELETE; org FKs kept; no parent-id single-col `.references()` remains) makes own-org cross-parent and absent-parent inserts BOTH fail the SAME composite FK — PG log shows byte-identical `23503` `jobs_org_company_fk` (cross)==(absent), no id echo; `crossParentVsAbsentUniform=216`. Property suite 11 passed, `totalOps=4460`, **identical on re-run**. **ON DELETE preserved:** `tenant-composite-ondelete` 4 passed (job/service delete CASCADE children→0; company-with-job/service delete RESTRICT `23001` on the composite FK). **No regression:** db chain 25 passed (composite-integrity references only composite names; migration-idempotency 5), server chain 28 passed; db typecheck 0; server typecheck 66 (E2-F009 baseline, none reference changed files); no-flag 11 skipped. **Scope clean:** DB-level fix only (no app-layer normalization); RLS policies / non-owner-role helpers / rls-bootstrap / assertCompanyAccess / manifests / lockfile UNCHANGED; TEN-004 frozen ledger unedited. "no leak found" claim corrected. Completes all 7 E2 tickets. |
