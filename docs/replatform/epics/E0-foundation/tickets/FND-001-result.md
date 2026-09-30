# FND-001 Result — Workload Lifecycle Contract

**Status:** `complete`
**Date (UTC):** `2026-08-08`
**Epic:** `E0-foundation`
**Plan task:** `Task 1: FND-001 — Workload Lifecycle Contract`
**Implementer:** `FND-001 implementer subagent (Claude)`
**Start SHA:** c24fc57fff1135f323567a3a38c9ce6d26cf74d3

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the section below and is the only role that may change it to `complete`.

This file is a controlled append-only review ledger until `complete`; do not delete or rewrite prior review attempts. Once `complete`, it is frozen. Ticket commands are focused acceptance evidence, not the immutable epic D0 rollup.

## Delivered scope

- Locked the distributed-execution lifecycle contract in both a human-readable ADR (`docs/architecture/distributed-execution-lifecycles.md`) and its machine-readable peer (`docs/architecture/distributed-execution-lifecycles.json`), with the exact job/attempt/lease states from `docs/replatform/program-design.md` and distinct `browserSession`, `serviceDesired`, and `serviceInstance` machines.
- JSON authority owns separate state sets, allowed edges, guarded job-edge reasons (`dead_letter` → `policy_exhausted`, `failed` → `non_retryable_failure`), terminal sets, and forbidden cross-lifecycle edges. `dead_letter` is reachable only through exhausted job policy; retry allocates a new attempt; service `healthy|stopped|lost` is not a generic attempt terminal.
- Markdown includes Mermaid diagrams, exhaustive allowed and forbidden transition tables, batch/browser/service worked journeys, cancellation/fence/quarantine/cleanup deadlines, E2B pause/resume (or replacement) semantics, and a legacy heartbeat/Commander/crew/run concept mapping. Lease-loss splits revoked effect authority from a resource/ownership/generation/deadline-bound monotonic cleanup authority.
- Replaced the intentional RED string-fragment scaffold with a structured checker (`scripts/check-distributed-execution-foundation.mjs`) that parses both authorities, validates reachability, terminal immutability, guarded-edge reasons, and forbidden cross-lifecycle edges, and fails on any JSON↔Markdown drift in either direction. Added `check:distributed-foundation` to root `package.json`.
- Added a dependency-free `node:test` mutation corpus (`scripts/check-distributed-execution-foundation.test.mjs`) covering missing files, malformed JSON, missing fields, semantic mismatch, filesystem errors, deleted allowed edge, added terminal outgoing edge, removed guard, drifted Markdown row, forbidden-edge drift, and missing headings — extensible by every later FND ticket.
- Appended Decision #121 verbatim after the existing Decision #120, guarded by a one-time precondition check (max decision = 120, #120 title = Commander warm-E2B, #121 unused) that tolerates the legacy duplicate #104.

**Non-goals preserved:** no job tables, worker routes, provider implementations, or execution calls; no new dependency (`pnpm-lock.yaml` unchanged); no changes outside the seven committed files; the ticket is left at `gate_review` for independent review, not self-certified `complete`.

## Changed files

| File | Responsibility |
|---|---|
| `docs/architecture/distributed-execution-lifecycles.md` | Human-readable canonical workload/transition semantics: diagrams, allowed/forbidden tables, worked journeys, deadlines, legacy mapping. |
| `docs/architecture/distributed-execution-lifecycles.json` | Machine-readable job/attempt/lease/browserSession/serviceDesired/serviceInstance state sets, allowed edges, guards, terminals, and forbidden cross-lifecycle edges. |
| `docs/architecture/decisions.md` | Appended Decision #121 (fenced outbound worker protocol; distinct batch/browser/service lifecycles) after Decision #120. |
| `scripts/check-distributed-execution-foundation.mjs` | Dependency-free structural checker: JSON/Markdown parse, reachability, terminal immutability, guarded edges, forbidden edges, table parity; `--root` for the test harness. |
| `scripts/check-distributed-execution-foundation.test.mjs` | `node:test` mutation corpus proving each drift fails with the exact path/cause. |
| `package.json` | Added `check:distributed-foundation` script next to `check:tokens`. |
| `docs/replatform/epics/E0-foundation/tickets/FND-001-result.md` | This ticket result ledger. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| Human-readable ADR and machine-readable JSON agree | Checker's bidirectional table parity (`compareEdgeMaps` + forbidden-table parity) passes; drift mutations fail | `pass` |
| Diagrams, exhaustive allowed/forbidden transitions present | `## Lifecycle diagrams` (6 Mermaid state diagrams), per-lifecycle allowed tables, `## Forbidden cross-lifecycle transitions` table | `pass` |
| Reachability + terminal immutability enforced | `validateLifecycleGraph` BFS reachability + zero-outgoing terminal check; `add a terminal outgoing edge` test fails as expected | `pass` |
| Guarded job edges (`dead_letter`=`policy_exhausted`, `failed`=`non_retryable_failure`) | JSON `guards` + reason-on-edge enforcement; `remove a guard` test fails as expected | `pass` |
| One example per workload + heartbeat/Commander/crew/run mapping | `## Worked journeys` (batch/browser/service) + `## Legacy concept mapping` table | `pass` |
| String-fragment presence alone is insufficient | RED scaffold replaced with structured graph/table checker; mutation corpus proves structural failures | `pass` |
| Decision #121 appended after #120 without touching #120 or dup #104 | Guard verified max=120/#121 absent/#120 title match; block committed verbatim | `pass` |
| No new dependency | `git diff -- pnpm-lock.yaml` empty | `pass` |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm check:distributed-foundation` (RED scaffold, before docs/JSON existed) | `1` | Printed `distributed-execution-lifecycles.md: missing`, `decisions.md: missing "## Decision #121 — Cloud control plane uses a fenced outbound worker protocol"`, and `decisions.md: missing "distributed-execution-lifecycles.md"` |
| `pnpm check:distributed-foundation` (GREEN, full structured checker) | `0` | `distributed execution foundation: PASS` |
| `node --test scripts/check-distributed-execution-foundation.test.mjs` | `0` | `tests 16 / pass 16 / fail 0` |
| `git diff -- pnpm-lock.yaml` | `0` | No output — lockfile byte-unchanged (no dependency change) |

## Deviations

None.

## Findings

None.

## Follow-up tickets

None.

## Gate recommendation

`ready for independent review` — the checker is GREEN, the full mutation corpus passes, the RED→GREEN sequence is recorded, `pnpm-lock.yaml` is unchanged, and only the seven planned files are touched.

## Independent review

**Reviewer:** FND-001 independent reviewer subagent (Claude)
**Reviewed revision:** 490049551ef57bc741ec4e0d51238bdb1ce96e69
**Disposition:** `approved`
**Review evidence:**
- `pnpm check:distributed-foundation` → exit `0` (`distributed execution foundation: PASS`).
- `node --test scripts/check-distributed-execution-foundation.test.mjs` → exit `0` (`tests 16 / pass 16 / fail 0`).
- Adversarial code-quality review of the checker, mutation corpus, and both authority documents at the reviewed revision. Verified the structured validation is correct and fail-closed: bidirectional JSON↔Markdown parity catches both edge-presence and guard-reason drift in each direction; BFS reachability, terminal immutability (no outgoing edge from a terminal state), non-terminal dead-end detection, guarded-edge reason enforcement, and forbidden cross-lifecycle edge checks (real lifecycle/state refs + genuinely cross-machine) all hold. `--root` harness with `makeFixture`/`runCheck(root)` is cleanly reusable by later FND tickets; mutations assert exact path/cause, not trivial passes. Dependency-free constraint respected (`pnpm-lock.yaml` byte-unchanged).
- No Critical or Important issues. Minor, non-blocking observations only: unused `__test` export and its sole-purpose `fileURLToPath` import are dead code; several validation branches are not yet mutation-pinned (reachability, non-terminal dead-end, forbidden self-lifecycle edge, forbidden unknown-lifecycle/state, reason-only drift); the Markdown prose `Statuses:`/terminal-immutability lines are not parity-checked against JSON `states`/`terminal` (within the documented edges+guard-reasons parity scope). These are left for the implementer's later-ticket extension and do not block approval.

For `approved`, verify the result describes the reviewed revision, all focused acceptance evidence passes, and every accepted finding is resolved; then change the top-level `Status` to `complete` and commit this disposition separately. Otherwise leave `Status` as `gate_review` or set `blocked`, and link stable findings.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary above is not a review attempt. The first independent reviewer appends attempt 1, and later reviewers append monotonically increasing rows without replacing prior attempts. The summary fields above mirror the latest real attempt for existing gate tooling. Do not include a `Review commit` column: a row cannot embed the SHA of the commit that first contains it. Repository history identifies that commit, and handoffs pin the resulting ticket-result blob SHA.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | FND-001 independent reviewer subagent (Claude) | `490049551ef57bc741ec4e0d51238bdb1ce96e69` | `approved` | `pnpm check:distributed-foundation` exit `0` (PASS); `node --test scripts/check-distributed-execution-foundation.test.mjs` exit `0` (16/16 pass). Adversarial code-quality review confirmed bidirectional edge+reason parity, BFS reachability, terminal immutability, guarded-edge, and forbidden cross-lifecycle checks are correct and fail-closed. No Critical/Important issues; Minor non-blocking observations only (dead `__test` export/`fileURLToPath` import; unpinned validation branches; prose state-list not parity-checked). |
<!-- Later reviewers append attempt 2+ below without rewriting attempt 1. -->
