# QA — D0 — E2 tenant-kernel corrective prerequisite — `920e55de5` — a3

## Record identity

| Field | Value |
|---|---|
| Date (UTC) | `2026-08-10` |
| Scope | Corrective prerequisite P1: bounded serving/operator roles only |
| Attempt | `3` |
| Supersedes | `2026-08-09-d0-e2-tenant-kernel-9a5455071f8c-a2.md` for the corrective role-gate assessment |
| Exact implementation revision | `920e55de5a6557577bed9d228e9a00c4d49beadc` |
| Start SHA | `2c33cb220a4a3cdcd8423f6018258011a24090d7` |
| Topology | `operator-directed windows-local`, embedded PostgreSQL 18.1, UTF-8/C locale, hermetic |
| Formal authority | Linux CI under DEC-03 |
| Gate owner | `TBD — distinct reviewer` |
| Result | **`awaiting_review`** |

This is an implementer-prepared corrective QA candidate, not a gate decision. The prior a2 evidence remains immutable. A distinct reviewer must independently pin the reviewed revision, rerun or validate the evidence, and decide whether this record may supersede the previous completion state.

## Implementer-observed evidence (not independent review)

| Requirement | Observation | Candidate result |
|---|---|---|
| Flag-on connection gate | Real server child processes exit nonzero for bad app/operator credentials and for valid owner credentials supplied to either bounded URL; health never serves. | `observed_green` |
| Exact `aoa_app` parity authority | Every traced JOB-010–014 table operation reaches PostgreSQL without `42501`; `company_secrets` remains denied. | `observed_green` |
| H-01 | `runInTenant` cross-org read returns null; composite company mismatch raises `23503`; no tenant leak. | `observed_green` |
| Operator bounds | Only null-Org platform workers/targets are visible/writable; tenant rows and job/attempt/lease/event/artifact/secret tables are denied. | `observed_green` |
| Default-off strangler | Missing bounded URLs accepted and pool helper returns null with no allocation. Legacy path remains authoritative. | `observed_green` |
| Migration | Custom 0213 applied by standard migration path and directly reapplied twice; idempotency suite 5/5. | `observed_green` |
| Affected typecheck/build | DB + server typecheck/build exit 0. | `observed_green` |
| Repository AGENTS §8 | `pnpm -r typecheck` and `pnpm build` exit `0`. `pnpm test:run` completes with `1 failed / 2,005 passed / 118 skipped` files and `18,800 passed / 680 skipped` tests; the only failure is the documented pre-existing Windows `packages/worker-protocol/src/cross-version.test.ts:12` syntax/transform baseline. | `observed_with_baseline` |

## Review decision placeholder

**Reviewer identity:** `TBD`

**Reviewed revision:** `TBD`

**Decision:** `awaiting_review`

**Concerns / residuals:** Linux CI remains the formal DEC-03 authority. Repository-wide tests retain the independently reproducible pre-existing Windows worker-protocol transform failure recorded above; it is not converted into a pass here. Future JOB-002 grants are excluded. No E3 route/work is enabled by this correction.
