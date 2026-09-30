# E1 — Versioned Worker Protocol

**Status:** `complete`
**Depends on:** E0 completion gate
**Tickets:** PRT-001 through PRT-007
**Implementation plan:** `implementation-plan.md` is written and reviewed before E1 execution begins.

**Gate status:** All seven ticket results are `complete`/`approved` and the Task-8 integration gate **passes** (attempt 2) on revision `b03262692882a7ce17834131ad358d3aecf07f5b` — accepted QA `qa/2026-08-09-d0-e1-completion-b03262692882-a2.md` (Result `pass`) and completion handoff `handoffs/2026-08-09-epic-completion-b03262692882-a2.md` (Decision `pass`). Attempt 1 (`93c5e9f2763a…`) was `fail` on finding [E1-F007](findings.md) (packed-import smoke); E1-F007 is now RESOLVED (`233e65b2b`) and the smoke is green (incl. 3× stability) and wired into CI. The a1 `fail` QA + handoff records are retained immutably and superseded by the a2 records. Non-blocking: finding [E1-F006](findings.md) (Step-1-regex vs PRT-004's annotated line) and the DEC-03 Linux-CI formalization recommendation.

**Corrective gate status:** The frozen-checker correction required by E3 prerequisite P2 independently **passes** on reviewed revision `01ad1ab554fe25c5178c7552ec047d4df45b7dcf`: accepted QA [`qa/2026-08-10-d0-e1-frozen-checker-correction-01ad1ab554fe-a6.md`](qa/2026-08-10-d0-e1-frozen-checker-correction-01ad1ab554fe-a6.md) and completion handoff [`handoffs/2026-08-10-epic-completion-01ad1ab554fe-a6.md`](handoffs/2026-08-10-epic-completion-01ad1ab554fe-a6.md). Finding [E1-F008](findings.md) is RESOLVED; prior corrective attempts remain immutable. E1 remains `complete`; Linux CI remains the formal DEC-03 authority.

## Outcome

Create a dependency-light, runtime-portable `@armyofagents/worker-protocol` package with opaque typed principals, discriminated execution-source provenance, branded domain identities, distinct job/attempt/lease states, job/lease envelopes, events, artifact/quarantine policy, separate product/runtime approval controls, transport/error schemas, capability negotiation, and frozen cross-version conformance vectors.

## Exit gate

- Package build, typecheck, and tests pass.
- Every protocol/operation/error reference resolves and every checked-in current/frozen-consumer vector is pinned by hash.
- All six execution-source variants round-trip with opaque typed requester/executor principals; only `task_run` carries required `runId`/`issueId`, and fabricated or cross-source provenance fails closed.
- Product approvals and runtime decisions remain separate versioned/idempotent controls; nonce, digest, version, expiry, principal, or governed-action mismatch fails closed.
- The complete PRT-007 v1 consumer is frozen as an independent hash-pinned baseline. The initial gate records `baseline_established`; from the first contract change onward, the current and oldest supported frozen consumers must pass bidirectional compatibility, while unsupported critical behavior fails closed.
- Registered target authority cannot be elevated by WorkerHello claims; ordinary artifact commit and quarantine remain distinct.
- Every applicable D0 REQUIRED condition plus HARD/INITIAL threshold in `test-gates.md` passes on one revision.
- Runtime source contains no Node, server, database, adapter, or UI imports.

## Records

- [`decisions.md`](decisions.md)
- [`findings.md`](findings.md)
- [`tickets/`](tickets/)
- [`qa/`](qa/)
- [`handoffs/`](handoffs/)
