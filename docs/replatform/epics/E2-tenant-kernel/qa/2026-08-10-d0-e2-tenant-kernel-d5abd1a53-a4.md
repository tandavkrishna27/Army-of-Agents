# QA — D0 — E2 tenant-kernel corrective prerequisite — `d5abd1a53` — a4

## Record identity

| Field | Value |
|---|---|
| Date (UTC) | `2026-08-10` |
| Scope | Prerequisite P1 fix round 1: bounded serving/operator-role correction only |
| Supersedes | a3 only if a distinct reviewer accepts this candidate |
| RED revision | `2db268b01b947907a0a64adaee475caa4d503d9e` |
| Candidate code revision | `d5abd1a539d27bac6e60e4b49ae0d4a71d062d86` |
| Topology | `operator-directed windows-local`, embedded PostgreSQL 18.1 |
| Formal authority | Linux CI under DEC-03 |
| Gate owner | `TBD — distinct reviewer` |
| Result | **`awaiting_review`** |

This is implementer-observed evidence, not an independent gate decision. It does not
mark E2 or prerequisite P1 complete/pass and grants no E3 ticket authority.

## Candidate observations

| Requirement | Observation | Candidate result |
|---|---|---|
| Real `aoa_app` parity | Representative real checkout reconciles a stale hub item and real runtime-decision prompt creation emits its hub/notification dependencies. An unapproved secret table remains denied. | `observed_green` |
| Exact operator authority | Positive named-column reads pass; writes, DELETE, owner/routing/credential columns, tenant rows, and job/event/artifact/secret tables are denied. | `observed_green` |
| Flag-off strangler | A real server using the non-superuser `execution_targets` table owner reads/writes the legacy route with bounded URLs absent. RLS has no permissive PUBLIC policy; distributed owner fallback remains rejected. | `observed_green` |
| Drift convergence/startup | Migration reconciles memberships, stale grants, NOINHERIT/NOREPLICATION; object ownership fails closed. Startup rejects inherited, stale, owned-object, replication, identity, and effective-authority drift. | `observed_green` |
| Shutdown | Both bounded pools are awaited once after plugin/host cleanup and before embedded PostgreSQL. Failures are logged and remaining cleanup is attempted. | `observed_green` |
| Focused acceptance | Root Vitest invocation with `AOA_RUN_WIN_INTEGRATION=1`: 5 files, 49/49 tests passed in 56.51 s. | `observed_green` |
| Migration | Additive custom migration 0214; migration 0213 untouched. Builder-byte coverage passes in the focused lane and migration idempotency passes 5/5. | `observed_green` |
| Repository verification | Recursive typecheck exits 0 (24/25 workspace projects) and production build exits 0. `pnpm test:run` completes exit 1 in 181.9 s only on the independently reproduced Windows worker-protocol transform/collection SyntaxError at `cross-version.test.ts:12`; no P1 lane failed. | `observed_with_baseline` |

## Review decision placeholder

**Reviewer identity:** `TBD`

**Reviewed revision:** `TBD`

**Decision:** `awaiting_review`

**Residuals:** Linux CI remains formal DEC-03 authority. JOB-002 owns any future
operator write/enrollment/proof/revocation authority. No result from this record may
be treated as a prerequisite pass before distinct re-review.
