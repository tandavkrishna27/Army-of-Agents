# E2 — Tenant Kernel — Findings

Stable IDs `E2-F###`. Each finding records severity, evidence, affected tickets,
disposition, and whether it blocks the gate. Findings are never silently deleted; a
resolved finding retains its resolution link.

---

## E2-F001 — RLS/role/GRANT/FORCE security DDL exceeds the current C14 exception; TEN-002 needs E2-D01 locked first

- **Severity:** High (process/assignability gate — not a defect).
- **Status:** **RESOLVED 2026-08-09** — operator locked E2-D01 and it is promoted to `docs/architecture/decisions.md` #122; TEN-002 is unblocked on this axis.
- **Blocks gate:** No. **Blocked TEN-002 assignability** until E2-D01 was locked (now locked).
- **Evidence:** The C14 exception as written (CLAUDE.md Rule #1, `docs/architecture/decisions.md` Decision #19, `AGENTS.md` §6) permits hand-appended DDL for **only** idempotency guards and data backfills (exemplars `0189`, `0195`). E2's forced-RLS enforcement requires `CREATE ROLE`, `GRANT`, `FORCE ROW LEVEL SECURITY`, and `CREATE POLICY` — DDL that `drizzle-kit@0.31.10` **provably cannot emit** (recon: `FORCE` absent from the generator bundle; no `GRANT`/`REVOKE` emission; role generation gated off and never emits `LOGIN`/`PASSWORD`). Neither a pure idempotency guard nor a data backfill.
- **Affected tickets:** TEN-002 (primary), TEN-001/TEN-004/TEN-006 (mechanism reuse).
- **Disposition:** Resolved-by-decision. Proposed **E2-D01** extends C14 to cover idempotent RLS/role/GRANT/FORCE security DDL and is promoted to `docs/architecture/decisions.md`. **Requires the operator (Migration Custodian + Security Gate Owner) to lock E2-D01 before TEN-002 begins.** Not a STOP condition — the mechanism is clean and precedented (`rls-bootstrap.ts` proves the exact DDL); it is a governance ratification, not an architectural blocker.
- **Resolution link:** [decisions.md#E2-D01](decisions.md).

---

## E2-F002 — TEN-002 "no owner/superuser in the application container" is a boot-sequence + deployment change with cross-mode blast radius

- **Severity:** Medium (scope/risk flag for planning).
- **Status:** **RESOLVED 2026-08-09** — operator confirmed the whole-app non-owner role, flag-gated dormant-but-tested (E2-D03).
- **Blocks gate:** No.
- **Evidence:** The serving process today connects via a single owner/superuser pool (`packages/db/src/client.ts:46`) and auto-applies migrations at boot (`server/src/index.ts:246,262`). Satisfying "owner/superuser credentials are absent from the application container" + "Run application queries with a non-owner role" means moving *all* app queries onto a non-owner role and relocating migration-apply/runtime-DDL to a separate privileged phase — a change that touches every deployment mode's boot path.
- **Affected tickets:** TEN-002, TEN-003.
- **Disposition:** Addressed by **E2-D03** (whole-app non-owner role reconciled with CAV-005: legacy tables get full GRANTs + no RLS; new-path gets forced RLS; migrations under a separate privileged role; whole-legacy-surface cutover behind the FND-005 disable flag, dormant-but-tested). **Operator confirmation requested** on whether E2 delivers the full whole-app cutover (recommended, flag-gated) or the bounded fallback (new-path pool only). Not a STOP condition.
- **Resolution link:** [decisions.md#E2-D03](decisions.md).

---

## E2-F003 — TEN-005 cannot reach the full D1 tenant-property floor at E2 (surfaces not yet built)

- **Status:** resolved
- **Severity:** Low (scope clarification).
- **Blocks gate:** No.
- **Evidence:** TEN-005/E2-README name worker events, WebSockets, placement, object keys, and restored data; these are built by E3/E4/E5/E6. The full D1 tenant property floor (`D1-01`, `test-gates.md`) runs at the D1 gate; the D1 hard-invariant preamble "does not imply behavior whose owning tickets have not landed."
- **Affected tickets:** TEN-005.
- **Disposition:** Addressed by **E2-D04** — E2's suite is seed-reproducible and surface-parametrized over the E2-available surfaces (repositories/HTTP/composite-SQL/object-key format), fail-closed + non-disclosing (a HARD subset of H-01), and designed to extend; the full D1-floor run is owned by the D1 gate. Recorded explicitly in the E2 gate QA record (no silent cap).
- **Resolution link:** [decisions.md#E2-D04](decisions.md).

---

## E2-F004 — Original plan's `FORCE ROW LEVEL SECURITY` H-01 assertion was unsound (owner ≠ superuser)

- **Status:** resolved
- **Severity:** High (correctness of a HARD-invariant proof).
- **Blocks gate:** No (resolved by plan revision a2 before execution).
- **Evidence:** Plan revision a1 asserted "owner/superuser is not exempt because FORCE ROW LEVEL SECURITY is on" and a RED step expecting the embedded-PG owner filtered to 0 rows. PostgreSQL semantics (confirmed unanimously by all three reviewers): `FORCE ROW LEVEL SECURITY` subjects only the **non-superuser table owner** to RLS; **superusers and BYPASSRLS roles always bypass RLS regardless of FORCE**. In embedded-PG the tables are owned by the `test` superuser, so FORCE would not filter it and the assertion could not pass.
- **Affected tickets:** TEN-002.
- **Disposition:** **Resolved by revision a2.** The DB-enforcement guarantee is re-anchored on the serving role `aoa_app` being **non-owner + NOSUPERUSER + NOBYPASSRLS** (plain RLS filters it). FORCE is proved via `pg_class.relforcerowsecurity = true` + a dedicated non-superuser-owner behavioral test; provisioning never grants SUPERUSER/BYPASSRLS/CREATEDB to `aoa_app`. See E2-D01 (FORCE semantics) + TEN-002 TDD steps.
- **Resolution link:** [decisions.md#E2-D01](decisions.md), implementation-plan.md §TEN-002.

---

## E2-F005 — Sentinel Organization dual identity (forbidden distributed sentinel AND real single-tenant Default Org)

- **Status:** resolved
- **Severity:** High (following the plan literally would brick/false-block the default self-hosted deployment).
- **Blocks gate:** No (resolved by revision a2 + E2-D07). **Blocks TEN-006b correctness:** must land the E2-D07 reconciliation.
- **Evidence:** `00000000-…-000000000001` is both the FND-007 `forbiddenOrganizationSentinels` distributed-admission sentinel (`distributed-execution-legacy-parity.json:15-19`) and the legitimate single-tenant Default Org (`organizations.ts` slug `default`; `routes/companies.ts:47-61` resolves it in the isolation-not-enforced branch). Revision a1's "sentinel = blocker" + "remove the `:61` fallback" would break self-hosted company creation and false-flag every self-hosted install.
- **Affected tickets:** TEN-006 (a/b).
- **Disposition:** **Resolved by revision a2 + E2-D07** — remove only fail-open mechanisms; preserve explicit self-hosted resolution; scope "sentinel = blocker" to distributed admission; backfill is a no-op scaffold at E2 (blocks-rollout arm).
- **Resolution link:** [decisions.md#E2-D07](decisions.md).

---

## E2-F006 — TEN-006 Company-writer sweep is ~70 sites, not 6; TEN-006 exceeds the 3-day bound and must split

- **Status:** resolved
- **Severity:** High (partial-cutover / NOT-NULL-break risk; sizing).
- **Blocks gate:** No (resolved by split + exhaustive-sweep requirement).
- **Evidence:** Dropping `companies.organization_id`'s schema default fails-closed **every** company-insert that omits the column: `grep "INSERT INTO companies"` ≈ 106 hits (~70 omit `organization_id` inline), 13 `.insert(companies)` call sites, plus source-asserting unit tests pinning `?? DEFAULT_ORGANIZATION_ID` (`company-service-org-scope.test.ts:14`, `companies-create-org-default.test.ts:10`, `cloud-auth-cutover.test.ts:38-39`, `companies-org-scope.test.ts:201`). Real fallback sites include `services/companies.ts:187,334,414,434`, `services/organizations.ts:101,108`, `company-portability.ts:2213` (`?? undefined` → now NOT NULL) — the a1 list of 6 files with drifted line numbers was off by ~10×.
- **Affected tickets:** TEN-006.
- **Disposition:** **Resolved by revision a2 + E2-D07** — split into TEN-006a (exhaustive `rg`-derived sweep + fail-closed writers + shared `insertTestCompany` factory) and TEN-006b (drop default + admission-denial helper); inventory derived at execution, not from stale line numbers.
- **Resolution link:** [decisions.md#E2-D07](decisions.md).

---

## E2-F007 — Non-owner pool must fail closed (never fall back to the owner/superuser pool)

- **Status:** resolved
- **Severity:** High (latent total H-01 fail-open).
- **Blocks gate:** No (resolved by revision a2).
- **Evidence:** If `createTenantAppDb`/`runInTenant` fell back to `createDb` (the owner/superuser pool) when `AOA_APP_DATABASE_URL` is unset, every new-path query would run as a superuser that bypasses RLS entirely — invisible at E2 (tables dormant) and only manifesting when E3 wires callers.
- **Affected tickets:** TEN-002, TEN-003.
- **Disposition:** **Resolved by revision a2** — `createTenantAppDb` throws on a missing/blank `AOA_APP_DATABASE_URL` and never falls back; boot asserts the non-owner pool's role is `NOT rolsuper AND NOT rolbypassrls`.
- **Resolution link:** [decisions.md#E2-D03](decisions.md).

---

## E2-F008 — H-01 (non-waivable) must have ≥1 real Linux execution, not Windows-only console evidence

- **Severity:** Medium (gate-fidelity for the crown-jewel invariant).
- **Status:** **RESOLVED 2026-08-09** — the operator (TK, Security + Integration Gate Owner) accepted Windows-local evidence for the E2 gate, matching the E0/E1 operator-directed precedent (E2-D05 amendment). The ≥1 real Linux H-01 run is deferred to that precedent and is not required for E2 `pass`.
- **Blocks gate:** No — resolved (was "gate `pass` requires the Linux run" at a1).
- **Evidence:** The tenant/company-writer suites are gated so they run on Linux CI + Windows-on-demand, but `pr.yml` does not auto-run on `docs/replatform-program`. Resting the non-waivable H-01 proof on Windows-only console output risks a Linux-only breakage (e.g. a missed company-insert site) passing silently (review R#-05).
- **Affected tickets:** E2 gate.
- **Disposition:** **RESOLVED via the E2-D05 amendment (operator-directed, E0/E1 precedent).** The original disposition offered two paths — trigger a real Linux run **or** explicit operator acceptance of the E0/E1 Windows-local precedent for E2. The operator chose the latter on 2026-08-09 after the a1 gate showed every locally-runnable REQUIRED/HARD/INITIAL condition green (a1 was `blocked_external` **solely** on the un-run Linux lane). This is acceptance of Windows-local **evidence for a pass**, never a waiver of a failure — H-01 remains HARD, non-waivable, and **PASSED** (TEN-002/003/004/005 green Windows-local, 3× deterministic). DEC-03 is honored: Linux CI stays the formal authority; a later Linux divergence would create a superseding QA/handoff (`Supersedes`). Gate finalized `pass` in the a2 QA record + handoff.
- **Resolution link:** [decisions.md#E2-D05](decisions.md) (Amendment 2026-08-09); `qa/2026-08-09-d0-e2-tenant-kernel-9a5455071f8c-a2.md`; `handoffs/2026-08-09-epic-completion-9a5455071f8c-a2.md`.

---

## E2-F009 — CORRECTED (misdiagnosis): `@armyofagents/plugin-sdk` is present; the isolated `--filter` typecheck failure was a build-order artifact, not a missing package

- **Status:** resolved
- **Severity:** Low (no real failure — record-keeping correction).
- **Blocks gate:** No.
- **Original (incorrect) premise:** that `packages/plugin-sdk` was absent so server typecheck/build fail. The per-ticket runs saw `pnpm --filter @armyofagents/server typecheck` exit 2 with ~66 `@armyofagents/plugin-sdk`-related errors and treated it as a pre-existing baseline.
- **Correction (E2 gate a1, code-is-truth):** `@armyofagents/plugin-sdk` **IS present** at `packages/plugins/sdk` (note the path — `packages/plugins/sdk`, not `packages/plugin-sdk`), tracked since Start SHA `df509b946` (`git ls-tree df509b946 packages/plugins/sdk` = present; `package.json` name = `@armyofagents/plugin-sdk`). The ~66 errors were a **build-order artifact** of running the ISOLATED `pnpm --filter @armyofagents/server typecheck` against an unbuilt, gitignored `dist/` for the workspace dep. The D0-R01 recursive lanes build packages first: **`pnpm -r typecheck` and `pnpm -r build` both exit 0**, and the 2 files this finding predicted would fail-to-collect (`company-plugin-upgrade-rollback`, `company-portability-preview-export`) **pass**. Zero E2-changed files were ever implicated (that part held).
- **Affected tickets:** none (no real defect). The per-ticket "server typecheck = 66 baseline errors" notes are explained by this build-order artifact.
- **Disposition:** **RESOLVED as a misdiagnosis.** The only genuine `pnpm test:run` baseline failure at HEAD is `packages/worker-protocol/src/cross-version.test.ts` (E1, non-epic-touched, a Windows vitest-transform harness artifact expected green on Linux), recorded in `qa/pre-existing-failure-baseline.md`. No plugin-sdk absence exists.
- **Resolution link:** `qa/pre-existing-failure-baseline.md`; the E2 gate a1 QA record.

---

## E2-F010 — TEN-006a service-writer sweep is INCOMPLETE: ~32 `companyService.create()` test sites still omit `organizationId` and now throw the fail-closed guard

- **Status:** resolved
- **Severity:** High (breaks the H-01 integration safety-net suite the ticket relies on; regresses ~14 currently-green integration files).
- **Blocks gate:** **No — RESOLVED** by fix commit `324e62ca6` (was Yes at attempt 1).
- **Found by:** TEN-006a independent review (attempt 1), reviewed revision `c4d8756c8`.
- **Evidence:** TEN-006a added `requireResolvedOrganizationId` (`server/src/services/companies.ts:91`), which throws when a Company writer is reached with no `organizationId`. The **raw-SQL sweep is complete** (0 `INSERT INTO companies` stragglers; control `memory-rbac-leakage.integration.test.ts` GREEN 8/8 on embedded PG) and **production callers are clean** (`routes/companies.ts:329`, `company-portability.ts:2197` both pass org explicitly). BUT the **service-writer (`companyService(db).create({…})`) sweep missed 32 call sites across 14 test files**, each passing only `{ name }` (no `organizationId`), so each now throws `Company writer requires an explicitly resolved organizationId (TEN-006a)`. Empirically reproduced on embedded PG (`AOA_RUN_WIN_INTEGRATION=1`): `crew-repair.integration.test.ts` **34/37 FAIL**, `extraction-sandbox-batch.integration.test.ts` **4/4 FAIL**, `d18-autonomy-dial-split.integration.test.ts` **6/6 FAIL** — all with that exact guard message (pre-change these bucketed to `DEFAULT_ORGANIZATION_ID` and passed). Missed sites (file: lines):
  - `crew-marketplace-bootstrap.integration.test.ts`: 561, 604, 717, 791, 819, 843, 1099, 1158, 1191 (9 — note 490 in the *same file* WAS swept, so the sweep is partial within one file)
  - `crew-repair.integration.test.ts`: 506, 580, 1065, 1476, 1561, 1583, 1601, 1616, 1850 (9)
  - `d18-autonomy-dial-split.integration.test.ts`: 93; `discussion-detail-lasterror.integration.test.ts`: 62; `extraction-sandbox-batch.integration.test.ts`: 224; `link-entry-seq.integration.test.ts`: 93; `organizations-backfill.integration.test.ts`: 50; `thread-commit-idempotency.integration.test.ts`: 119, 1721; `thread-v2-real-e2e.integration.test.ts`: 100, 366; `w1a-crew-assignment.integration.test.ts`: 91; `w1b-auto-accept.integration.test.ts`: 69; `w1c-inbox-dispatch-approval.integration.test.ts`: 71; `w2-extract-then-scope.integration.test.ts`: 92; `w3a-crew-loopback.integration.test.ts`: 93.
  The ledger §5 undercounted the service-create population ("15 service-create calls / 9 files") — the actual population is ~47 calls; 32 remain unswept — a recurrence of the E2-F006 undercount, this time on the `.create()` axis. `organizations-backfill.integration.test.ts:50` is a semantic red flag: its premise (create a company *without* an org, then backfill) is now impossible through the guarded service and needs a rethink, not just an added literal.
- **Affected tickets:** TEN-006a.
- **Disposition:** **RESOLVED (attempt 2, fix commit `324e62ca6`, verified at HEAD `324e62ca6`).** The implementer swept all 32 real service-writer sites to pass `organizationId: "00000000-0000-0000-0000-000000000001"` explicitly (matching the raw-SQL convention); `organizations-backfill.integration.test.ts:50` was correctly reseeded via **raw SQL** `INSERT INTO companies (organization_id, …)` (the guarded service can no longer mint an org-less company — the exact semantic flag raised here) with the now-unused `companyService` import dropped; the 2 intentional throws in `company-writer-fail-closed.test.ts` kept org-less. **Independent re-verification (reviewer, attempt 2):** balanced-paren sweep of `server/src/__tests__` → 0 real `companyService.create()/createWithOperator()` sites still omit org (only the 2 intentional throws remain); all `.createWithOperator(` + alias/`input`-literal receivers pass org. Embedded-PG (`AOA_RUN_WIN_INTEGRATION=1`) re-runs GREEN: `crew-repair`, `crew-marketplace-bootstrap`, `d18-autonomy-dial-split`, `extraction-sandbox-batch` (all previously RED on the guard), + dynamic-port control `teams-null-parent-cascade`. `company-writer-fail-closed` still 4 passed; broad glob 59 passed / 13 skipped / 2 plugin-sdk-baseline fail-to-collect; `@armyofagents/db` typecheck 0. Fix is test + result-doc only (no schema/migration/production change).
- **Resolution link:** [decisions.md#E2-D07](decisions.md); TEN-006a-result.md (§5 reconciled, attempt-2 review block); fix commit `324e62ca6`.

---

## E2-F011 — TEN-006b left a stale `packages/db` source-asserting test (missed by the server-only regression glob)

- **Status:** resolved
- **Severity:** Medium (pre-existing gate-blocker — the D0 `pnpm test:run` would fail).
- **Blocks gate:** Was yes (fixed inline). **Blocks TEN-002:** No (orthogonal — TEN-002 never touches `companies.ts`).
- **Evidence:** TEN-006b (`a269f8bd2`, migration 0210) correctly dropped the fail-open `.default("00000000-0000-0000-0000-000000000001")` from `packages/db/src/schema/companies.ts` (E2-D07), but `packages/db/src/__tests__/companies-org-scope-schema.test.ts:11` is a **source-asserting** test whose regex still required that `.default(...)` (its title even read "+ sentinel DB default"). It now fails on the branch (full `@armyofagents/db` suite: 291 passed / **1 failed** / 38 skipped). The TEN-006a/TEN-006b regression checks ran the `server/` glob `companies-*/company-*/*org*` and did not cover this `packages/db` test — the coverage gap that let it through. Surfaced during TEN-002 regression (implementer `a61ff33e…`).
- **Affected tickets:** TEN-006b (defect source); the E2 gate D0 rollup.
- **Disposition:** **RESOLVED (controller fix, inline).** Updated the assertion to require the NOT-NULL FK **without** the sentinel default AND to assert the `.default("…0001")` is absent (a fail-closed marker for E2-D07). Comment + title reworded. Test-only change; `companies-org-scope-schema.test.ts` now 2/2 green. Because TEN-006b's result ledger is frozen (`complete`), this correction is recorded here + committed rather than rewriting the approved TEN-006b evidence (artifact-policy). Follow-up lesson: source-asserting-test regression checks must run repo-wide (`pnpm -r`), not per-package globs.
- **Resolution link:** fix committed on `claude/epic-e2-tenant-kernel`; [decisions.md#E2-D07](decisions.md).

---

## E2-F012 — On a REUSED pooled connection, a no-context new-path query fails closed by THROWING (22P02), not by returning 0 rows

- **Status:** resolved
- **Severity:** Low (behavioral nuance; both outcomes are fail-closed — no data leak).
- **Blocks gate:** No.
- **Found by:** TEN-003 implementation (`tenant-tx-context.integration.test.ts` assertion (d) → (d)/(d2) split).
- **Evidence:** The TEN-002 tenant policy predicate is `organization_id = current_setting('aoa.organization_id', true)::uuid`. On a **pristine** connection the GUC has never been set, so `current_setting(..., true)` returns **NULL**, `NULL::uuid` is NULL, and a no-context query returns **0 rows** (clean default-deny — assertion (d)). But `aoa.organization_id` is a **placeholder (custom) GUC**: once `set_config('aoa.organization_id', <org>, true)` has run in a session (as every `runInTenant`/`withTenantTx` does), its **reset value becomes the empty string `''`** for the rest of that physical connection. A subsequent query issued **OUTSIDE** any `runInTenant` on that **reused** connection therefore evaluates `organization_id = ''::uuid`, which raises **`22P02` (invalid input syntax for type uuid: "")** — the query FAILS CLOSED by throwing rather than leaking rows (proved live on embedded-PG: server log `ERROR: invalid input syntax for type uuid: ""`; assertion (d2)). postgres-js pools reuse connections, so this is the production-relevant case.
- **Affected tickets:** TEN-003 (documented + tested); E3 entry-point adopters (JOB-*); TEN-005 (uniform-denial harness — informational).
- **Disposition:** **Resolved-by-design / documented.** Both outcomes are fail-closed (H-01 holds: a no-context query NEVER returns another tenant's rows — it returns 0 on a pristine connection or throws 22P02 on a reused one). This **reinforces** that `runInTenant` is mandatory: a stray un-wrapped new-path query on a live pool fails loudly instead of silently returning nothing. **E3-adoption note:** every new-path DB access MUST route through `runInTenant`; never issue a bare `appDb`-level new-path query. **TEN-005 note:** the adversarial suite drives new-path access via `runInTenant` (context always set), so it does not encounter (d2); the 22P02 throw is not a uniform-denial concern because it only occurs on a mis-implemented un-wrapped access path, not on a normal cross-tenant attempt (which is denied inside a set context by RLS as 0-rows / 42501). No policy change is warranted at E2. A future hardening option (register the GUC with a NULL-safe default, or use a `NULLIF(current_setting(...), '')::uuid` predicate) can be considered at E3 if any operator/monitoring path legitimately issues un-wrapped reads — out of E2 scope (would alter the shipped TEN-002 policy).
- **Resolution link:** `tickets/TEN-003-result.md` (assertions (d)/(d2)); TEN-002 policy `server/src/db/rls-tenant.ts` `tenantPolicySql`.
- **Independent-review confirmation (TEN-003 attempt 1, HEAD `10592fc0b`):** Resolved-by-design **CONFIRMED**. Verified by grep that the ONLY writer of `aoa.organization_id` is `with-tenant-tx.ts:36` with `is_local => true` (no session-level set anywhere), so the placeholder-GUC reset value can only ever be NULL or `''` — never a valid uuid — hence no variant of a no-context read can return another tenant's rows (pristine → 0 rows; reused → 22P02 throw, no rows). Re-observed the 22P02 (`invalid input syntax for type uuid: ""`) live in the embedded-PG server log during (d2). Confirmed the predicate carries no `NULLIF`, so the deferral of NULL-safe hardening to E3 introduces no H-01 gap at E2 (policies dormant — no entry point wires `runInTenant`; runtime always sets a valid uuid). Not an E2 defect.

---

## E2-F013 — Composite-vs-single FK constraint-name reveals another tenant's company/parent existence (the exact "guard identity" leak TEN-005's uniform-denial normalization was required to close, and the suite never tests it)

- **Status:** resolved
- **Severity:** Medium. A real H-01 existence-disclosure oracle on the **sanctioned** tenant write path (`repos.*.insert` inside `runInTenant`), reachable by the non-owner `aoa_app` role. Mitigations: the probed identifier is an unguessable v4 uuid (confirmation oracle, not enumeration), the DETAIL key-values are already suppressed by PG (the tenant lacks `SELECT` on the referenced table), and E2 wires no HTTP surface yet (E2-D04). It leaks 1 bit — "this uuid is a company/job/attempt that exists in *some* tenant" — not the owning tenant, name, or contents. But H-01 is HARD / non-waivable and explicitly bans "existence disclosures," and TEN-005's acceptance names this exact leak class.
- **Blocks gate:** Yes for the TEN-005 gate as written — TEN-005's plan acceptance (`implementation-plan.md:410-413`) and E2-D04 (`decisions.md:218-222`) require the tenant repository to map "FK-violation, RLS `WITH CHECK` violation, and not-found into one identical denial shape … so no guard's identity (FK vs RLS vs not-found) leaks," and require the suite to assert the denial shape is **identical** across a cross-tenant read, a cross-tenant write, and a truly-absent row. That normalization was not implemented and this leak is neither closed nor asserted-absent.
- **Found by:** TEN-005 independent review (reviewer, attempt 1), HEAD `664daadc9`. Reproduced on real embedded-Postgres (PG 18.1) as the non-owner `aoa_app` role with the tenant GUC set to the actor org.
- **Evidence:** The composite-FK tables carry BOTH a redundant single-column FK AND the TEN-004 composite FK: e.g. `jobs.company_id → companies(id)` (`packages/db/src/schema/jobs.ts:19-21`, auto-named `jobs_company_id_..._fk`) **and** `jobs_org_company_fk (organization_id, company_id) → companies(organization_id, id)` (`jobs.ts:45-49`; the schema comment at `:44` calls the single FKs "kept (harmless)"). Same shape on `job_attempts` (`:21` + `:41`), `leases` (`:21` + `:39`), and services/service_instances/job_artifacts/job_secret_handles — so the oracle is systemic across the composite-FK surface. FK referential-integrity checks bypass RLS, so the single-column FK sees rows the tenant cannot `SELECT`. As `aoa_app` with GUC = org A:
  - own-org(A) insert referencing **another tenant's** company `cB` (exists in org B) → `SQLSTATE 23503`, `constraint_name = jobs_org_company_fk` (single FK passes because `cB` exists; composite fails).
  - own-org(A) insert referencing an **absent** company uuid → `SQLSTATE 23503`, `constraint_name = jobs_company_id_fkey` (single FK fails first).
  - The two are **distinguishable** by `constraint_name` **and** by the deepest DB message text (`violates foreign key constraint "jobs_org_company_fk"` vs `"…jobs_company_id_fkey"`) — the caller learns whether a supplied uuid is a company in another tenant. This fails the suite's own `pgDeepestMessage` byte-identity standard for this untested case.
  The suite only exercises the **cross-ORG** insert (`tenant-adversarial.property.integration.test.ts:406-417`, `organizationId: victim.org.id`), where RLS `WITH CHECK` (42501) fires first and is uniform; it never issues the own-org + cross/absent-company insert where the FK guard identity diverges. The only 23503 the suite drives is via the **superuser** `composite_sql` path (`:534`), which is not a tenant-role denial and is never compared against an absent-company case. Net: three distinguishable denial shapes exist at the tenant boundary (42501 RLS, 23503-composite, 23503-single); the required normalization collapses them to one and is absent.
- **Affected tickets:** TEN-005 (test coverage gap + misclaim); the E2 gate H-01 rollup. Root cause is the redundant single-column FKs (TEN-004 / schema) plus the missing repository normalization (§1 of the plan).
- **Disposition:** **OPEN — changes requested.** TEN-005-result.md §Non-goals claims "uniform denial holds NATURALLY … no leak found → no normalization needed," and Deviation 3 reinterprets E2-D04's "identical across read/write/absent" as per-KIND. The per-KIND reading is defensible only on the read-vs-write axis; it does not address the **write-vs-write** axis, where the banned guard-identity leak is real and untested. Fix (any one, then re-assert): (a) implement the E2-D04 repository normalization — catch 42501/23503(composite)/23503(single)/not-found in `packages/db/src/repositories/tenant/index.ts` insert/update and surface ONE identical `TenantDenied` shape carrying no `constraint_name`/discriminating text; (b) minimally, drop the redundant single-column FKs so both cross and absent references fail the SAME composite FK with an identical constraint name (changes ON DELETE semantics — the composite FK must then carry the delete behavior; coordinate with TEN-004); THEN extend TEN-005 to assert the denial shape is identical across own-org+cross-company, own-org+absent-company, and cross-org inserts (currently only the last is tested). If the program elects to defer normalization, amend E2-D04 + the plan via a successor decision and record this as an explicitly ACCEPTED open existence-disclosure (the current "no leak found" claim is factually wrong); the suite must still add the own-org cross/absent case so coverage is honest.
- **Resolution link:** fix commits `a0b24c40f` (schema + migration `0212` + suite oracle axis) / `3f994fd6b` (stale-comment correction); decision `ec9b97027` (E2-D09, `decisions.md`); TEN-005-result.md (attempt-1 + attempt-2 review blocks); original leak refs E2-D04 (`decisions.md:218-222`), plan `implementation-plan.md:94-96` + `:410-413`.
- **Disposition update — RESOLVED (TEN-005 review attempt 2, verified at HEAD `3f994fd6b`).** Closed at the DB level per **E2-D09** (not app-layer normalization): migration `0212_fk_dedup_tenant_oracle.sql` drops the 7 redundant single-column parent FKs and moves their `ON DELETE` onto the composite tenant FKs, so a cross-tenant parent id and an absent parent id now fail the **same** composite FK. **Independent re-verification (reviewer, attempt 2):** on embedded-PG 18.1, own-org `repos.{jobs,attempts,services}.insert` with a cross-tenant parent id and with an absent parent id both raise `23503` on the identical composite constraint with a **byte-identical** deepest DB message and no id echo (PG log: `…violates foreign key constraint "jobs_org_company_fk"` for both), asserted by the new `crossParentVsAbsentUniform` op class (216 ops, > 0); property suite 11 passed, `totalOps=4460`, deterministic on re-run. `organization_id → organizations` FKs are KEPT (a cross-org value hits RLS `WITH CHECK` 42501 before any FK — not an oracle). ON DELETE preserved (`tenant-composite-ondelete.integration.test.ts` 4 passed: CASCADE children → 0; company-with-job/service delete RESTRICTED `23001` on the composite FK). No regression across the tenant DB/server chains; RLS policies + non-owner role + `assertCompanyAccess` unchanged; TEN-004 frozen ledger unedited. The original result's "no leak found" claim has been corrected.

---

## E2-F014 — E2-D03's serving role lacked the traced JOB-010–014 parity privileges required by E3

- **Status:** resolved
- **Severity:** High; blocked the E3 predecessor gate, not the default-off legacy product path.
- **Evidence:** The `aoa_app` role from migration 0211 had DML only on the eight E2 new-path tables. The current checkout/heartbeat, approval/runtime-decision, budget/cost/concurrency, and output-summary engines touch a bounded legacy operation set; running those calls under the E3 tenant transaction would otherwise fail with `42501`.
- **Disposition:** **IMPLEMENTED, AWAITING DISTINCT REVIEW.** E2-D10 / Decision #123 freeze the operation-level trace in `server/src/db/job-control-legacy-grants.ts`; migration 0213 grants exactly that map. Embedded-Postgres tests perform every traced SELECT/INSERT/UPDATE/DELETE privilege and deny `company_secrets`. CAV-005 remains unchanged; no legacy Company RLS retrofit was added.
- **Implementation revision:** `920e55de5a6557577bed9d228e9a00c4d49beadc`. The reviewer, not the implementer, owns the final disposition.
- **Fix-round 1 candidate update:** Review attempt 1 found the original synthetic
  privilege proof circular and the trace incomplete. Candidate revisions
  `2db268b01` (RED) and `fc32f1d1a` (GREEN) now invoke the real
  `issueService.checkout` stale-hub reconciliation and real runtime-decision prompt
  creation through `aoa_app`. Migration 0214 adds only the transitive operations
  those paths require, including `user_roles`, `company_memberships`, preferences,
  notifications/digest writes, and hub counter reconciliation. Embedded PostgreSQL
  observes both representative paths completing and the unapproved secret surface
  remaining denied. **Still awaiting distinct re-review; not resolved/pass.**

---

## E2-F015 — Null-Organization platform metadata had no distinct bounded operator pool

- **Status:** resolved
- **Severity:** High; blocked the E3 predecessor gate because owner fallback would bypass RLS and a shared app/operator role would collapse the trust boundary.
- **Evidence:** E2 described operator-only platform workers, but boot provisioned no `aoa_operator`, opened no operator connection, and did not verify both role identities before startup.
- **Disposition:** **IMPLEMENTED, AWAITING DISTINCT REVIEW.** Migration 0213 creates a NOSUPERUSER/NOBYPASSRLS `aoa_operator` and forced policies that expose only null-Organization platform workers/targets. Flag-on boot now requires and verifies both explicit roles; bad credentials and valid owner credentials both abort before health can serve. Flag-off allocates neither pool. Tests deny the operator job/attempt/lease/event/artifact/secret access and tenant metadata enumeration/writes.
- **Implementation revision:** `920e55de5a6557577bed9d228e9a00c4d49beadc`. Corrective QA and handoff remain `awaiting_review`.
- **Fix-round 1 candidate update:** Migration 0214 replaces table-wide operator CRUD
  with `SELECT` on named safe metadata columns only; it omits `DELETE`, writes,
  `owner_user_id`, target `config`, and `worker_token_hash`. It reconciles stale
  grants/memberships, `NOINHERIT`/`NOREPLICATION`, and application-object ownership,
  while startup audits the exact effective authority. `execution_targets` is
  RLS-enabled but not forced, preserving a real flag-off non-superuser-owner server
  without `PUBLIC` policy or owner fallback. Both bounded pools are awaited and
  failure-logged in the shared shutdown sequence. Candidate code revision
  `d5abd1a53` remains **awaiting distinct re-review; not resolved/pass**.

## Fix-round 2 candidate update (E2-F014 / E2-F015)

- Reviewer attempt 2 found that the current heartbeat pinned-target resolver still
  failed under `aoa_app`. Candidate revisions `cdeb9caaa` (RED) and `21335854f`
  (GREEN) exercise the real resolver query under that role. Migration 0215 grants
  only its seven selected columns and denies `worker_token_hash`, `owner_user_id`,
  `capabilities`, and `last_seen_at`. This extends E2-F014's exact operation map without
  widening operator authority.
- The same revisions bind authenticated and active identities, reject masked
  owner/superuser startup URLs, and audit all table-like relkinds `r,p,v,m,f` with
  consistent table/column checks. A granted view over `company_secrets` now aborts
  startup. Direct accepted bounded sessions prove `SET ROLE NONE` remains bounded;
  masked privileged sessions demonstrate why the gate rejects them.

Both findings remain **implemented, awaiting distinct re-review**. This candidate
update is not a resolution/pass and grants no JOB-002 authority.

## Resolution of E2-F014 / E2-F015 (recorded 2026-09-03, register catch-up)

The distinct re-review the two paragraphs above were awaiting **happened, and passed** — the
register was simply never updated to say so, which is why both findings still read
"awaiting distinct re-review" nine months of programme time later.

- [`handoffs/2026-08-10-epic-completion-21335854f-a5.md`](handoffs/2026-08-10-epic-completion-21335854f-a5.md)
  records **`Decision: pass`** by a distinct gate owner on reviewed revision
  `7843b86e25eb1ff9c520308aef7f123fec6997a7`, for candidate code revision
  `21335854f1fe33773b1ef70b4b5da9bc8f618f3f` — the exact GREEN revision the fix-round-2
  paragraph above names. It validates masked-identity rejection, the fail-closed
  secret-view/materialized-view/foreign-table authority checks, the real pinned-target
  resolver projection, migration replay and the complete focused P1 matrix.
- `README.md:3` carries E2 as `complete`, and the handoff is its accepted corrective gate.

Both findings' `Status:` is therefore `resolved`. Nothing above is rewritten: the
awaiting-review paragraphs are the contemporaneous record and stay exactly as written.

★ **Why this was invisible.** Neither finding carried a machine-readable `Status:` line, so
`check-finding-ownership.mjs` never read them — and both are severity **High**. Had the fix
round *not* passed, two open HIGH findings would have sat in a `complete` epic with no
guard able to see them. That is the case for failing closed on an unreadable status rather
than treating it as "not open"; see the guard's `unparseable_status` arm.
