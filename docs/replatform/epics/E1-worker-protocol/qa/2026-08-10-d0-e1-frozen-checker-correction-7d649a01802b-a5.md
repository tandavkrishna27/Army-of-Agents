# QA - D0 - E1 frozen-consumer checker correction - `7d649a01802b` - a5

## Record identity

| Field | Value |
|---|---|
| Date (UTC) | `2026-08-10` |
| Scope | Prerequisite P2 fix round 2: smoke-environment and temp-ownership correction only |
| Supersedes | a4 only if a distinct reviewer accepts this candidate |
| RED revision | `4ffd5e0d822e8d3b3a763bca47f1c3c621072480` |
| Candidate code revision | `7d649a01802bc2062e91ded370ec7d6385c72931` |
| Environment | `operator-directed windows-local`; Git object database available |
| Formal authority | Linux CI under DEC-03 |
| Gate owner | `TBD - distinct reviewer` |
| Result | **`awaiting_review`** |

This is implementer-observed evidence, not an independent gate decision. It does not
mark E1/P2 complete or authorize JOB-001.

## Candidate observations

| Requirement | Observation | Candidate result |
|---|---|---|
| Zero JavaScript environment | The child clears every `process.env` key before dynamic import. The same valid fixture reports exactly zero keys on the Windows host and in a local Linux Node 24 container; parent secret, `NODE_OPTIONS`, and `NODE_PATH` are absent. Absolute executable/module paths, local cwd, timeout/kill, and output cap remain. | `observed_green` |
| Owned cleanup | Each 30-case process creates one unique parent and places every fixture, Git repo, clone, and hang module below it. Leak checks and final cleanup inspect/remove only that exact owned tree; no shared-prefix sweep remains. | `observed_green` |
| Staggered concurrency | Two full child corpora pass `30/30`; A exits while B is blocked on a live repo, B remains intact, both unique parents disappear only on their owner's exit, and the outer test leaves only its expected coordination files before cleanup. | `observed_green` |
| Resolved security corpus | Default and signing-config runs both pass `30/30`, retaining coordinated mutation, replacement, sentinel, timeout, source/dependency, CRLF, clean-clone, and later-consumer cases. | `observed_green` |
| Boundary/package/checker | Actual frozen check, boundary `50/50` plus CLI, package smoke, and contract-manifest check pass. | `observed_green` |
| Typecheck/build | Worker-protocol and recursive repository typecheck/build exit `0`. | `observed_green` |
| Repository tests | Worker lane exits `1` only on the documented Windows collection failure after `16` files / `490` tests pass. Fresh full `pnpm test:run` exits `1` on the same sole failed suite; no other failed suite is reported. | `observed_with_baseline` |
| Immutable boundary | Protected diff and scoped diff-check are clean; owned-temp audit finds no run parents. Frozen/protocol/dependency/E3 bytes remain unchanged. | `observed_green` |

## Review decision placeholder

**Reviewer identity:** `TBD`

**Reviewed revision:** `TBD`

**Decision:** `awaiting_review`

**Residuals:** Linux CI remains DEC-03 authority. The process-isolation suite is
deliberately separate because it launches two complete 30-case child corpora and takes
about 92 seconds locally. Distinct review alone may close E1-F008 and prerequisite P2.
