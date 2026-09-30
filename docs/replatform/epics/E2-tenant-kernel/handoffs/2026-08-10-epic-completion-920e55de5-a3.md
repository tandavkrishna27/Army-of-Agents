# Handoff — E2 tenant-kernel corrective prerequisite candidate

**Date (UTC):** `2026-08-10`

**Reviewed implementation candidate:** `920e55de5a6557577bed9d228e9a00c4d49beadc`

**Attempt:** `3`

**Supersedes:** `2026-08-09-epic-completion-9a5455071f8c-a2.md` only if the distinct reviewer accepts this correction

**Decision:** `awaiting_review`

**Gate owner:** `TBD — distinct reviewer`

This handoff is intentionally not a `pass` and does not mark E2 or prerequisite P1 complete. It records the implementer's candidate correction so the independent reviewer has a pinned code revision and evidence paths.

## Candidate correction

- Decision #123 / E2-D10 records operator-approved option B.
- Migration 0213 adds only Decision #122/C14 role/grant/FORCE-RLS/policy DDL; 0211 is untouched.
- `aoa_app` gains only the traced JOB-010–014 legacy operation allowlist in addition to its eight E2 grants.
- `aoa_operator` is a distinct non-owner role restricted by forced RLS to null-Organization platform worker/target metadata.
- Flag-on startup verifies both exact roles and fails before health/routes/work on connection or identity failure; valid owner credentials are rejected. Flag-off allocates no bounded pool.
- `runInTenant` and CAV-005 remain unchanged; no JOB-001 or other E3 behavior is included.
- Implementer-observed repository verification has one documented pre-existing Windows worker-protocol transform failure; the distinct reviewer must classify it, and Linux CI remains formal DEC-03 authority.

## Evidence paths

- Result ledger: `docs/replatform/epics/E3-job-control/prerequisites/E2-serving-role-correction-result.md`
- Corrective QA candidate: `docs/replatform/epics/E2-tenant-kernel/qa/2026-08-10-d0-e2-tenant-kernel-920e55de5-a3.md`
- Implementation report: `.superpowers/sdd/implementation-plan/prereq-p1-e2-role-correction-report.md`

## Reviewer action required

Independently review the exact grants and operator policies, rerun the required lanes, verify repository-wide failure classification, and then either issue an accepted superseding record or record concerns/blocks. E3 must not begin based on this implementer-prepared handoff alone.
