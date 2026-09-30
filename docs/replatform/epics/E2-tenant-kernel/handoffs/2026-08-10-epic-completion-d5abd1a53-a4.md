# Handoff — E2 tenant-kernel corrective prerequisite fix-round candidate

**Date (UTC):** `2026-08-10`

**Candidate code revision:** `d5abd1a539d27bac6e60e4b49ae0d4a71d062d86`

**Supersedes:** a3 only if the distinct reviewer accepts this candidate

**Decision:** `awaiting_review`

**Gate owner:** `TBD — distinct reviewer`

This handoff is intentionally non-passing. It neither completes prerequisite P1 nor
authorizes JOB-001, JOB-002, or any other E3 work.

## Candidate correction

- Additive custom migration 0214 converges exact roles/grants without editing 0213.
- Real checkout stale-hub reconciliation and runtime-decision prompt creation execute
  through `aoa_app`; only their traced transitive operation map is granted.
- `aoa_operator` is read-only on named safe worker/target metadata columns. No
  credential, routing, owner, destructive, enrollment, proof, or revocation authority
  is included.
- Flag-off remains a real working non-superuser-owner legacy server. The transition
  uses neither a `PUBLIC` policy nor distributed owner fallback.
- Migration/startup reject membership, stale-grant, role-attribute, object-ownership,
  and effective-authority drift. Bounded pools are awaited and failure-logged in the
  shared shutdown order.
- Focused embedded-Postgres acceptance is implementer-observed green at 49/49;
  migration idempotency is 5/5; recursive typecheck and build pass. The full test run
  completes exit 1 only on the independently reproduced Windows worker-protocol
  transform/collection baseline at `cross-version.test.ts:12`; the implementation
  report records the exact command evidence without converting it into a pass.

## Evidence paths

- Result ledger: `docs/replatform/epics/E3-job-control/prerequisites/E2-serving-role-correction-result.md`
- QA candidate: `docs/replatform/epics/E2-tenant-kernel/qa/2026-08-10-d0-e2-tenant-kernel-d5abd1a53-a4.md`
- Implementation report: `.superpowers/sdd/implementation-plan/prereq-p1-e2-role-correction-report.md`

## Reviewer action required

Review the final exact docs revision, independently validate every Important finding,
classify repository-wide baselines, and then issue the prerequisite decision. Until
that happens, E3 must not begin from this handoff.
