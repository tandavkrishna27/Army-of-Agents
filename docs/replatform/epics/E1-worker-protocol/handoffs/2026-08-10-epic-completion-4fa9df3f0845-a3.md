# Handoff - E1 frozen-consumer checker corrective candidate

**Date (UTC):** `2026-08-10`

**Candidate code revision:** `4fa9df3f08452509f24c94681df73a8909451684`

**Supersedes:** `2026-08-09-epic-completion-b03262692882-a2.md` only if a distinct reviewer accepts this candidate

**Decision:** `awaiting_review`

**Gate owner:** `TBD - distinct reviewer`

This handoff is intentionally non-passing. It neither completes prerequisite P2 nor authorizes JOB-001 or any other E3 ticket.

## Candidate correction

- Frozen dependency evidence is verified from the fixture-recorded E1 commit's raw Git blobs.
- The checker no longer reads mutable current package/lock bytes or installed Zod/esbuild versions.
- Missing commit/blob evidence fails closed; later unrelated consumer manifest/lock changes and working-tree CRLF conversion do not affect the result.
- The mutation corpus expands from 12 to 21 cases, covering later consumers, CRLF, object availability, Zod/esbuild snapshot drift, both recorded integrity fields, and clean-clone determinism.
- Existing bundle/schema/manifest/no-runtime-dependency/path-leak/smoke enforcement is retained.
- Frozen fixture and worker-protocol trees are byte-identical to start; no dependency version or E3 behavior changed.
- Focused checks, typecheck, and build pass. Repository tests retain the honestly recorded Windows-only `cross-version.test.ts:12` collection failure; Linux CI is DEC-03 authority.

## Evidence paths

- Result ledger: `docs/replatform/epics/E3-job-control/prerequisites/E1-frozen-checker-correction-result.md`
- Corrective QA candidate: `docs/replatform/epics/E1-worker-protocol/qa/2026-08-10-d0-e1-frozen-checker-correction-4fa9df3f0845-a3.md`
- Finding: `docs/replatform/epics/E1-worker-protocol/findings.md#e1-f008---frozen-consumer-checker-couples-immutable-e1-evidence-to-a-later-consumers-working-tree-and-installed-dependencies`
- Implementation report: `.superpowers/sdd/implementation-plan/prereq-p2-e1-frozen-checker-report.md`

## Reviewer action required

Review the exact evidence revision, independently rerun the focused lanes, verify the frozen Git trees/hashes and missing-object behavior, and classify the Windows-local test baseline. Issue a separate accepted record or concerns; do not treat this implementer handoff as a pass.
