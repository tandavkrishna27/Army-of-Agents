# FND-002 Result — Authority and Migration Contract

**Status:** `complete`
**Date (UTC):** `2026-08-08`
**Epic:** `E0-foundation`
**Plan task:** `Task 2: FND-002 — Authority and Migration Contract`
**Implementer:** `FND-002 implementer subagent (Claude)`
**Start SHA:** 58dc75d47f13e0ee70a234e1d72a15c24629d8f2

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the section below and is the only role that may change it to `complete`.

This file is a controlled append-only review ledger until `complete`; do not delete or rewrite prior review attempts. Once `complete`, it is frozen. Ticket commands are focused acceptance evidence, not the immutable epic D0 rollup.

## Delivered scope

- Locked the distributed-execution authority contract in `docs/architecture/distributed-execution-authority.md`: the seven-row authority matrix (state -> authority -> worker behavior), the `ExecutionOwner = legacy | distributed` single-writer cutover rule, worker-event synchronization, workspace/artifact synchronization, and the late/orphan-output quarantine rule, with the invariant `No AoA database is a peer replica`.
- Appended the Decision #121 authority paragraph after the existing lifecycle-link paragraph, locking authority, synchronization, single-writer cutover, and late-result quarantine in `distributed-execution-authority.md`, and asserting no desktop or worker database is a peer replica of the hosted control plane.
- Extended the shared structural checker (`scripts/check-distributed-execution-foundation.mjs`) with a `requireFile` presence gate plus real structured validation: it parses the authority matrix and validates every required row, parses the `ExecutionOwner` cutover enum (exactly `legacy | distributed`), enforces the atomic single-owner selection and rollback rules, and negation-scans the stale-commit / no-auto-promote / no-peer-replica invariants rather than relying on substring presence. Added the Decision #121 `distributed-execution-authority.md` back-reference check.
- Extended the `node:test` mutation corpus (`scripts/check-distributed-execution-foundation.test.mjs`) with the five Step-4 FND-002 mutations (missing authority row, worker-database peer claim, dual-writer cutover, ordinary stale commit, auto-promoted quarantine) on top of the untouched FND-001 corpus, and updated `makeFixture` to copy the authority document.
- Resolved carry-forward finding E0-F002 items 1-3: pruned the dead `__test` export and its sole-purpose `fileURLToPath` import; guarded the forbidden-edge validation so a present-but-malformed lifecycle (`states` missing) referenced by a forbidden edge pushes a clean error instead of throwing a `TypeError`; and pinned the previously unpinned validation branches (unreachable state, non-terminal dead-end, forbidden self-lifecycle edge, forbidden unknown-lifecycle reference, reason-only guard drift, and the malformed-state-set forbidden edge).

**Non-goals preserved:** no build/template files (`package.json`, `scripts/fetch-bundled-*`, `scripts/check-bundled-snapshot-inputs.*`, `AGENTS.md`, `artifact-policy.md`, templates) created or staged — those remain FND-005-owned; no new dependency (`pnpm-lock.yaml` byte-unchanged); no FND-001 checks or mutation cases removed; the ticket is left at `gate_review` for independent review, not self-certified `complete`; `findings.md` untouched.

## Changed files

| File | Responsibility |
|---|---|
| `docs/architecture/distributed-execution-authority.md` | New authority contract: authority matrix, single-writer cutover, worker/workspace/artifact synchronization, late/orphan-output quarantine, and the no-peer-replica invariant. |
| `docs/architecture/decisions.md` | Appended the Decision #121 authority paragraph after the lifecycle-link paragraph (references `distributed-execution-authority.md`). |
| `scripts/check-distributed-execution-foundation.mjs` | Added `requireFile` + structured authority validation (matrix rows, ExecutionOwner enum, late-output/peer-replica invariants) and the #121 authority back-reference; fixed E0-F002 items 1-2. |
| `scripts/check-distributed-execution-foundation.test.mjs` | Added the five FND-002 authority mutations and the E0-F002 item-3 pinning mutations; `makeFixture` now copies the authority document. |
| `docs/replatform/epics/E0-foundation/tickets/FND-002-result.md` | This ticket result ledger. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| Checker validates every authority row | `validateAuthorityMatrix` parses the `## Authority matrix` table and verifies all seven required rows (state/authority/worker behavior); the "missing authority row" mutation fails with the exact cause | `pass` |
| Checker validates the single-writer transition | `validateSingleWriter` parses the `ExecutionOwner = legacy | distributed` enum and requires atomic single-owner selection + the rollback rule; the "dual-writer cutover" mutation fails | `pass` |
| ADR forbids database peer sync | Doc-wide negation scan of `peer replica`; `No AoA database is a peer replica` invariant; the "worker-database peer claim" mutation fails | `pass` |
| ADR forbids permanent dual writes | `ExecutionOwner` enum must be exactly `legacy \| distributed`; single-owner selected atomically before any side effect | `pass` |
| Quarantine behavior for late worker output | `validateLateOutput` negation-scans `authoritative state` (stale commit) and `auto-applied` (no auto-promote); both mutations fail | `pass` |
| Decision #121 references both lifecycle and authority docs | `requireFile`/decisions checks for `distributed-execution-lifecycles.md` and `distributed-execution-authority.md` | `pass` |
| FND-001 contract still enforced | Full FND-001 mutation corpus still passes; no FND-001 case removed | `pass` |
| E0-F002 items 1-3 resolved | Dead `__test`/`fileURLToPath` pruned; forbidden-edge malformed-state-set guard; five previously-unpinned branches now have mutation cases | `pass` |
| No new dependency | `git diff -- pnpm-lock.yaml` empty | `pass` |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm check:distributed-foundation` (RED, before authority doc / #121 link existed) | `1` | Printed `docs/architecture/distributed-execution-authority.md: missing` and `docs/architecture/decisions.md: missing reference to "distributed-execution-authority.md"` |
| `pnpm check:distributed-foundation` (GREEN, full structured checker) | `0` | `distributed execution foundation: PASS` |
| `node --test scripts/check-distributed-execution-foundation.test.mjs` | `0` | `tests 29 / pass 29 / fail 0` (16 retained FND-001 cases + 13 new FND-002/E0-F002 cases) |
| `git diff -- pnpm-lock.yaml` | `0` | No output — lockfile byte-unchanged (no dependency change) |

## Deviations

None.

## Findings

`E0-F002` (items 1-3 resolved). Item 4 (optional prose parity hardening) intentionally not addressed. `findings.md` disposition is left for the controller to update after review.

## Follow-up tickets

None.

## Gate recommendation

`ready for independent review` — the checker is GREEN, the RED→GREEN sequence is recorded, the FND-002 authority mutations and the retained FND-001 corpus all pass, E0-F002 items 1-3 are resolved, `pnpm-lock.yaml` is unchanged, and only the five planned files are touched.

## Independent review

**Reviewer:** FND-002 independent reviewer subagent (Claude)
**Reviewed revision:** f5e45cf2b2a3ddf588307e2cba12ec2d183925f6
**Disposition:** `approved`
**Review evidence:**

- `pnpm check:distributed-foundation` → exit `0`, prints `distributed execution foundation: PASS`.
- `node --test scripts/check-distributed-execution-foundation.test.mjs` → exit `0`, `tests 29 / pass 29 / fail 0` (16 retained FND-001 cases + 13 new FND-002/E0-F002 cases; baseline `valid: the real repository passes with zero errors` green).
- `git diff BASE..HEAD -- pnpm-lock.yaml package.json` → empty (dependency-free constraint held; checker imports only `node:*` built-ins).
- Code-quality read of the diff: the new validators (`requireFile`, `extractTable`, `splitSentences`, `requireNegatedMention`, `validateAuthorityMatrix`, `validateSingleWriter`, `validateLateOutput`, orchestrated by `validateAuthority`) each carry a single responsibility, are cleanly named/decomposed for FND-003..008 to extend, and contain no dead code and no silent catch-and-ignore (`readOrError` classifies and pushes every failure).
- Structured-validation correctness verified adversarially: all seven authority rows are pinned verbatim (state/authority/worker) — a removed or drifted row is caught; the `ExecutionOwner` enum parse rejects dual-writer/extra-owner drift; the negation scan catches an affirmative peer-replica / stale-commit / auto-promote claim added as a **separate sentence** (proven by the mutation corpus and by out-of-tree probes). No false-positive on the real document.
- E0-F002 items 1–3 confirmed resolved: dead `__test`/`fileURLToPath` pruned (no residual refs in the checker); the forbidden-edge `Array.isArray(states)` guard returns a clean structured error without masking the pre-existing non-array-states error (`runCheck` no longer throws `TypeError`); the five newly-pinned mutations each assert an exact, branch-isolating cause.
- Two **Minor** (non-blocking) robustness observations for later FND tickets, both inside the checker's accidental-drift threat model and neither a plan requirement: (1) the sentence-level negation scan can miss an affirmative clause smuggled into a sentence that already carries a negation word (same-sentence false-negative); (2) the matrix validator pins the required rows but does not reject an *added* contradictory row. The plan's prescribed substring-only `requireFile` would catch neither; the delivered structured approach is strictly stronger than the plan.

For `approved`, verify the result describes the reviewed revision, all focused acceptance evidence passes, and every accepted finding is resolved; then change the top-level `Status` to `complete` and commit this disposition separately. Otherwise leave `Status` as `gate_review` or set `blocked`, and link stable findings.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary above is not a review attempt. The first independent reviewer appends attempt 1, and later reviewers append monotonically increasing rows without replacing prior attempts. The summary fields above mirror the latest real attempt for existing gate tooling. Do not include a `Review commit` column: a row cannot embed the SHA of the commit that first contains it. Repository history identifies that commit, and handoffs pin the resulting ticket-result blob SHA.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | FND-002 independent reviewer subagent (Claude) | f5e45cf2b2a3ddf588307e2cba12ec2d183925f6 | `approved` | `pnpm check:distributed-foundation` exit 0 (PASS); `node --test …test.mjs` exit 0 (29/29); `pnpm-lock.yaml`/`package.json` byte-unchanged; all 7 authority rows + `ExecutionOwner` enum + late-output negation scans validated adversarially; E0-F002 items 1–3 resolved (item 4 optional, deferred). Two Minor non-blocking robustness notes recorded (same-sentence negation smuggle; added-row not rejected) — neither a plan requirement, both stronger than the plan's substring-only approach. |
<!-- First independent reviewer appends attempt 1. -->
