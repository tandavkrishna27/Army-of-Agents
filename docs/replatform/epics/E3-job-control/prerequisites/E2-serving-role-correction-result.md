# Prerequisite P1 Result — E2 bounded serving/operator-role correction

**Status:** `complete`
**Disposition:** `pass`
**Date (UTC):** `2026-08-10`
**Implementer:** `Codex implementer agent (/root/e2_role_correction_impl)`
**Start SHA:** `2c33cb220a4a3cdcd8423f6018258011a24090d7`
**RED test commit:** `e3c681421`
**Implementation revision:** `920e55de5a6557577bed9d228e9a00c4d49beadc`
**Reviewed revision:** `7843b86e25eb1ff9c520308aef7f123fec6997a7`
**Fix-round 1 RED commit:** `2db268b01`
**Fix-round 1 candidate code revision:** `d5abd1a53`
**Fix-round 1 review:** `needs_changes` (review attempt 2)
**Fix-round 2 review:** `pass` (review attempt 3)
**Scope:** Corrective E2 prerequisite resolving the premises of E3-F001/E3-F002 only. No JOB-001 or other E3 ticket behavior is implemented.

## Attempt 1 delivered behavior (superseded by the candidate below)

- `aoa_app` retains the eight E2 new-path DML grants and receives the operation-level legacy table allowlist traced from the current JOB-010–014 checkout/heartbeat, approval/runtime-decision, budget/cost/concurrency, and output-summary engines.
- `aoa_operator` is a distinct NOSUPERUSER/NOBYPASSRLS role with DML only on `workers` and `execution_targets`; forced policies restrict it to null-Organization platform metadata and prevent tenant-row enumeration/writes.
- Flag-off startup creates neither bounded pool and requires neither URL. Flag-on startup requires `AOA_APP_DATABASE_URL` and `AOA_OPERATOR_DATABASE_URL`, opens both connections, verifies the exact authenticated role and non-privileged attributes, and aborts before serving on connection, credential, role, or privilege failure. There is no owner fallback.
- `runInTenant(appDb, organizationId, fn(repos))` remains the mandatory tenant boundary. No unscoped tenant repository was added; CAV-005 legacy Company isolation is unchanged.
- Optional role passwords are provisioned only in the migration/bootstrap phase from environment secrets. No credential is committed.

## Strict TDD evidence

### RED (before production changes)

1. `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server exec vitest run src/__tests__/config.test.ts src/__tests__/e2-serving-role-correction.integration.test.ts src/__tests__/distributed-execution-db-startup.integration.test.ts`
   - Exit `1`; `6 failed / 27 passed` in the first combined behavior run.
   - Intended failures: both missing bounded URLs were accepted; `aoa_app` lacked `issues:SELECT`; `aoa_operator` was denied `workers`. The first child-process attempt also exposed an unrelated local-auth harness requirement and was corrected before using that lane as evidence.
2. After adding only `AOA_DEV_LOCAL_IDENTITY=1` to the child-process harness: `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server exec vitest run src/__tests__/distributed-execution-db-startup.integration.test.ts`
   - Exit `1`; `2 failed / 0 passed`. Both bad-credential child processes reached `/api/health` (`exited:false`), proving the pre-correction server did not gate startup on either bounded connection.

### GREEN (implementation revision)

- `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server exec vitest run src/__tests__/e2-serving-role-correction.integration.test.ts src/__tests__/distributed-execution-databases-unit.test.ts`: exit `0`, `15 passed`. This performs every traced table operation, checks unapproved-table denial, exercises `runInTenant` H-01 RLS/composite-FK behavior, bounds operator metadata, denies job/event/artifact/secret surfaces, and directly reapplies migration 0213 twice.
- `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server exec vitest run src/__tests__/distributed-execution-db-startup.integration.test.ts src/__tests__/config.test.ts`: exit `0`, `22 passed` (bad app/operator credentials, owner-role fallback for both pools, missing URL failures, and default-off behavior).
- Decision #122/C14 lanes: `pnpm --filter @armyofagents/db exec vitest run src/__tests__/migration-idempotency.test.ts` exits `0`, `5 passed`; `pnpm --filter @armyofagents/server exec vitest run src/__tests__/tenant-rls-enforcement-unit.test.ts` exits `0`, `16 passed`.
- `@armyofagents/db` and `@armyofagents/server` typecheck/build: exit `0`.
- Environment label: `operator-directed windows-local`; Linux CI remains the formal DEC-03 authority.
- Repository-wide AGENTS §8 verification: recursive typecheck and production build exited `0`; `pnpm test:run` completed with `1 failed / 2,005 passed / 118 skipped` files and `18,800 passed / 680 skipped` tests. The sole failed suite is the documented pre-existing Windows transform failure at `packages/worker-protocol/src/cross-version.test.ts:12`; reviewer must independently classify it.

## Migration

`0213_e2_serving_role_correction.sql` was created by the repository's working drizzle custom-migration invocation. It has no schema-authored delta, CREATE TABLE, or CREATE INDEX. Role/GRANT/FORCE-RLS/POLICY statements are builder-backed, individually C14-commented, and idempotent. Migration 0211 was not edited. The migration transaction applies the complete role/grant/policy correction atomically.

## Changed files

| Area | Files |
|---|---|
| DB factories | `packages/db/src/client.ts`, `packages/db/src/index.ts` |
| Migration | `packages/db/src/migrations/0213_e2_serving_role_correction.sql`, journal + generated 0213 snapshot |
| Startup/config | `server/src/index.ts`, `server/src/config/distributed-execution.ts`, `server/src/db/distributed-execution-databases.ts` |
| Grant/policy source | `server/src/db/job-control-legacy-grants.ts`, `server/src/db/rls-tenant.ts` |
| Tests | `config.test.ts`, `distributed-execution-databases-unit.test.ts`, `distributed-execution-db-startup.integration.test.ts`, `e2-serving-role-correction.integration.test.ts`, `tenant-rls-enforcement-unit.test.ts`, `distributed-execution-exclusions.test.ts` |
| Decisions/evidence | Decision #123, E2-D10, E2-F014/F015, environment-variable guide, this result, corrective QA and handoff candidates |

## Review attempt 1

**Reviewer:** `Codex distinct reviewer (/root/e2_role_correction_review)`

**Reviewed revision:** `ed1887bf29c688a0d0d83018a2f63144fb027041`

**Disposition:** `needs_changes`

**Findings:** the traced `aoa_app` matrix does not serve the actual checkout/runtime-decision paths; `aoa_operator` receives table-wide credential/routing/revocation/destructive authority beyond the metadata-only seam; forced RLS can alter the non-superuser-owner flag-off legacy target path; exact-named roles can retain/inherit authority outside the bounded matrices; bounded pools are not awaited by the shared shutdown sequence.

**Verification:** operator-directed Windows embedded-Postgres focused lanes passed (`15/15`, `22/22`, `5/5`, and `21/21`); affected and recursive typecheck/build passed. Repository `pnpm test:run` remained exit `1`: the known Windows worker-protocol transform/collection failure was independently reproduced, and one unrelated opencode environment-scrub test timed out under full-suite load but passed `3/3` immediately in isolation. Linux CI remains the formal DEC-03 authority. Passing focused ACL tests did not override the confirmed service-path/spec findings.

**Required next action:** fix the Important findings without owner fallback or E3 ticket implementation, add real service-path/non-superuser-owner/adversarial-role acceptance coverage, then submit a new exact revision for distinct review. Corrective E2 QA and the superseding completion handoff remain non-passing.

## Fix round 1 candidate

**Disposition:** `needs_changes` pending distinct re-review. This implementer record
does not pass or complete prerequisite P1.

### Corrected behavior

- Migration `0214_e2_serving_role_hardening.sql` is an additive, idempotent Drizzle
  `--custom` successor under Decision #122/C14; applied migration 0213 is unchanged.
- The `aoa_app` operation map includes the real transitive dependencies exercised by
  checkout stale-hub reconciliation and runtime-decision prompt creation, including
  owner/membership/preference reads, notification/digest writes, and hub counter
  reconciliation. It remains bounded and `company_secrets` remains denied.
- `aoa_operator` receives `SELECT` only on named safe metadata columns of `workers`
  and `execution_targets`. It receives no writes, `DELETE`, `owner_user_id`, routing
  `config`, `worker_token_hash`, or future JOB-002 enrollment/proof/revocation power.
- Both roles converge to NOSUPERUSER/NOBYPASSRLS/NOINHERIT/NOREPLICATION with no
  inherited roles, stale schema/table/column/sequence grants, or application-object
  ownership. Migration and startup both fail closed on unreconcilable drift.
- `execution_targets` remains RLS-enabled but is not forced. A real flag-off server
  backed by its non-superuser table owner continues to read/write the legacy target
  route. There is no permissive `PUBLIC` policy and no distributed owner fallback.
- The app/operator pools close inside the sole awaited shutdown sequence, after
  plugin/host cleanup and before embedded PostgreSQL; close failures are logged and
  do not prevent the other pool or remaining cleanup from being attempted.

### Fix-round strict TDD evidence

RED commit `2db268b01` captured all production gaps before correction:

- Real-service/authority lane: exit `1`, `5 failed / 13 passed`; real checkout and
  prompt creation failed with SQLSTATE `42501`, stale role posture survived reapply,
  role-owned objects were accepted, and an unsafe operator column was exposed.
- Startup lane: exit `1`, `5 failed / 4 passed`; the flag-off non-superuser owner
  failed on forced RLS, while inherited/stale/owned/replication authority passed.
- Shutdown lane: exit `1`, `2 failed / 1 passed`; bounded pools were neither ordered
  in the shared shutdown path nor failure-logged.

GREEN candidate `fc32f1d1adc7c5e0688a235b83e3791c6efb7794`, plus test-harness
cleanup `d5abd1a53`, produced:

- `AOA_RUN_WIN_INTEGRATION=1 pnpm exec vitest run` over the two integration and three
  focused unit files: exit `0`, 5 files and `49/49` tests passed in 56.51 s. This
  invokes representative real services, the flag-off real server, adversarial role
  drift, exact column authority, migration reapplication, and shutdown behavior.
- A root-invocation hygiene RED first exposed package-cwd-dependent test paths; both
  touched integration tests now anchor files to `import.meta.url`, and the exact same
  root command passes.

Migration idempotency passes `5/5`; recursive typecheck (24/25 workspace projects)
and production build exit `0`. `pnpm test:run` completes exit `1` in 181.9 seconds
only on the independently reproduced Windows worker-protocol transform/collection
SyntaxError at `packages/worker-protocol/src/cross-version.test.ts:12`; no P1 lane
failed, and the repository command is not converted into a pass. Linux CI remains
formal DEC-03 authority. A distinct reviewer must independently review the final docs
revision and decide the gate.

## Review attempt 2

**Reviewer:** `Codex distinct reviewer (/root/e2_role_correction_review)`

**Reviewed revision:** `c3aefc6591b7ed4469a7cf2ea9f92040a1c71079`

**Disposition:** `needs_changes`

**Prior-finding verdicts:** the direct operator ACL, `execution_targets` NO-FORCE
transition, awaited shutdown ordering, and both test-hygiene observations are
addressed. The real checkout/prompt cases close the original circular-test gap, but
the traced app grant remains incomplete because the current heartbeat target resolver
still receives no `execution_targets:SELECT`. Role hardening is also incomplete:
startup validates `current_user` rather than the authenticated `session_user`, and its
exact-authority scan excludes views/materialized views/foreign tables.

**Blocking findings:** (1) owner/superuser URLs with PostgreSQL startup
`options=-c role=aoa_app` / `aoa_operator` pass the actual startup gate; a reviewer
probe observed `session_user=test,current_user=aoa_app`, then `SET ROLE NONE` restored
`current_user=test,rolsuper=true`; (2) a granted view over `company_secrets` is omitted
from the `relkind IN ('r','p')` audit, so startup accepts it and the operator can query
it; (3) fresh 0214 denies `aoa_app` target-registry resolution with SQLSTATE `42501`.
These violate the no-owner-fallback, exact metadata-only, and complete traced-grant
requirements. Corrective E2 QA and the superseding handoff remain non-passing.

**Independent verification:** `operator-directed windows-local` focused acceptance
passed `49/49`; migration idempotency passed `5/5`; clean valid-role flag-on startup,
affected DB/server typecheck/build, recursive typecheck, and production build passed.
Repository `pnpm test:run -- --reporter=dot` remained exit `1` after 176 seconds only
on the independently reproduced Windows worker-protocol transform/collection
SyntaxError at `cross-version.test.ts:12`; the imported JavaScript files pass
`node --check` and zero bodies collect. Linux CI remains formal DEC-03 authority. The
green focused suite does not cover the three blocking cases above.

**Required next action:** bind both `session_user` and `current_user` to the exact
expected role; audit/reconcile all table-like effective authority; complete the traced
target-resolver grant under the approved RLS boundary; add adversarial masked-owner,
view-grant, and real resolver tests; then submit a new exact revision for review.

## Fix round 2 candidate implementation

**Implementer:** `Codex implementation agent (/root/e2_role_correction_impl)`

**RED revision:** `cdeb9caaa51c2d04da57e396bf8f19ae391d7e4a`

**Candidate code revision:** `21335854f1fe33773b1ef70b4b5da9bc8f618f3f`

**Disposition:** `needs_changes` pending distinct re-review. This implementer record
does not mark prerequisite P1 complete/pass or authorize any E3 ticket.

The candidate addresses only review attempt 2's three Important findings:

- Startup requires both authenticated `session_user` and active `current_user` to
  equal the expected bounded role. Masked owner/superuser URLs using startup role
  options are rejected before health; accepted exact-role connections remain bounded
  after `SET ROLE NONE`.
- Exact authority audits ordinary/partitioned tables, views, materialized views, and
  foreign tables (`relkind` `r,p,v,m,f`) with consistent table and column privilege
  checks. An operator-granted view over `company_secrets` aborts startup.
- Additive C14 custom migration 0215 grants `aoa_app` `SELECT` only on
  `execution_targets(id, slug, kind, trust_class, status, organization_id, config)`,
  the exact columns selected by the real heartbeat pinned-target resolver. Token,
  `owner_user_id`, `capabilities`, `last_seen_at`, and other unselected columns remain denied; operator
  authority is unchanged.

Implementer-observed focused acceptance is green at 56/56 and migration idempotency
is green at 5/5. Recursive typecheck and production build pass. Repository-wide test
evidence and any Windows-local baseline limitation are recorded in the implementer
report and the then-awaiting-review a5 QA/handoff candidate, finalized below.

**Candidate reviewer action (satisfied by review attempt 3 below):** inspect the exact
final revision, rerun the adversarial identity/view/resolver cases, classify
repository-wide verification, and issue the prerequisite decision.

## Review attempt 3

**Reviewer:** `Codex distinct reviewer (/root/e2_role_correction_review)`

**Reviewed revision:** `7843b86e25eb1ff9c520308aef7f123fec6997a7`

**Disposition:** `pass`

All three review-attempt-2 Important findings are addressed. The startup identity
gate requires authenticated `session_user` and active `current_user` to equal each
other and the expected bounded role; direct-pool and real-child tests reject masked
superuser URLs. Table and column authority scans cover relation kinds `r,p,v,m,f`,
and real view plus reviewer materialized-view/foreign-table drift probes fail closed.
Migration 0215 grants `aoa_app` only the seven columns selected by the actual pinned
execution-target resolver; token, owner, capabilities, and liveness fields remain
denied to that role, and `aoa_operator` authority is unchanged.

Independent operator-directed Windows acceptance passed the three isolated
regressions (`4/4`, `1/1`, `1/1`), the full focused P1 matrix (`56/56`), migration
idempotency (`5/5`), and affected DB/server typecheck and build. A clean exact-role
flag-on gate probe passed. PostgreSQL 18 startup-option probes also established that
`session_authorization` remains bound to the authenticated login and cannot mask the
gate; combined `session_authorization`/`role` options still expose the privileged
`session_user` and are rejected.

The isolated worker-protocol lane still exits `1` on the known Windows Vitest
transform/collection `SyntaxError` at `cross-version.test.ts:12`, with zero tests
collected; both directly imported JavaScript files pass `node --check`, and this
candidate changes no frozen E1 path. It remains an honestly recorded Windows-local
caveat; Linux CI is the formal DEC-03 authority and is not represented as having run
locally.

Prerequisite P1 is complete/pass on the exact reviewed revision above. This closes
only the corrective E2 gate; it does not itself implement JOB-001, JOB-002, or any
other E3 ticket.
