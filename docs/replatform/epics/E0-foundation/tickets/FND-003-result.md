# FND-003 Result — Threat Model and Control Ownership

**Status:** `complete`
**Date (UTC):** `2026-08-08`
**Epic:** `E0-foundation`
**Plan task:** `Task 3: FND-003 — Threat Model and Control Ownership`
**Implementer:** `FND-003 implementer subagent (Claude)`
**Start SHA:** 6ccd976b8509d1313d072c6470f77426bb45f24d

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the section below and is the only role that may change it to `complete`.

This file is a controlled append-only review ledger until `complete`; do not delete or rewrite prior review attempts. Once `complete`, it is frozen. Ticket commands are focused acceptance evidence, not the immutable epic D0 rollup.

## Delivered scope

- Locked the distributed-execution threat model as a JSON-authoritative record. `docs/architecture/distributed-execution-threat-controls.json` holds 30 trust-crossing/control objects (DE-01…DE-30); every object carries all 13 required fields (`id`, `trustedSide`, `lessTrustedSide`, `authentication`, `authorization`, `confidentiality`, `integrity`, `revocation`, `audit`, `failureMode`, `severity`, `ownerTickets`, `verificationLane`).
- Seeded DE-01…DE-17 verbatim from the plan Step-3 table (threat, severity, required control, verification, owner) and added the hardening-amendment crossings: placement/target registry (DE-18), context/memory API (DE-19), legacy cutover (DE-20), realtime broker (DE-21), telemetry/evidence integrity (DE-22), backup/restore (DE-23), desktop installer/updater (DE-24), local folder (DE-25), real-provider isolation (DE-26), multi-replica coordination/HA (DE-27), quarantine promotion (DE-28), owner-credential misrouting (DE-29), and capability-claim admission (DE-30). The post-fence cleanup crossing (DE-17) keeps cleanup possible, least-privilege, ownership-scoped, idempotent, deadline-bounded, and incapable of restoring effect authority.
- Wrote `docs/architecture/distributed-execution-threat-model.md` as the rendered view: `# Distributed Execution Threat Model`, `## Trust boundaries` (10-row boundary table), `## Threat and control register` (the 30-row register rendered from the JSON), a hardening-amendment coverage note, and `## Residual risks and release exclusions` explicitly excluding public service ingress, cloud plugins, unvalidated gVisor bridge egress, active-active multi-region writes, and unattended orphan-output application.
- Appended the Decision #121 threat-model link paragraph (plan Step-4 exact line) after the authority paragraph in `docs/architecture/decisions.md`, so #121 now links the lifecycle, authority, and threat-model records.
- Extended the shared structural checker (`scripts/check-distributed-execution-foundation.mjs`) with FND-003 validation: a `requireFile` presence gate on the Markdown; JSON parse + `version`/`crossings` structure; per-crossing exact-required-field enforcement, non-empty string values, unique stable IDs, known severity/verification-lane enumerations, non-empty owner-ticket arrays cross-referenced against the defined backlog ticket IDs parsed from `docs/replatform/program-design.md`, and a release-test requirement (a `REL-*` owner ticket or a `releaseTest` field) for every Critical/High crossing; exact JSON↔Markdown register parity (complete ID set in both directions incl. count, plus per-ID threat/severity/control/verification/owner parity for every control); the residual release-exclusion set; and the Decision #121 threat-model back-reference.
- Extended the `node:test` mutation corpus (`scripts/check-distributed-execution-foundation.test.mjs`) with 26 FND-003 cases on top of the retained FND-001/FND-002 corpus, and taught `makeFixture` to copy the threat model, threat controls, and program design into the fixture.

**Non-goals preserved:** no FND-005-owned files touched (`package.json`, `scripts/fetch-bundled-*`, `scripts/check-bundled-snapshot-*`, `AGENTS.md`, `docs/replatform/artifact-policy.md`, `docs/replatform/templates/*`); no new dependency (`pnpm-lock.yaml` byte-unchanged); no FND-001/FND-002 checks or mutation cases removed; ticket left at `gate_review` for independent review; `findings.md` untouched (controller updates it).

## Changed files

| File | Responsibility |
|---|---|
| `docs/architecture/distributed-execution-threat-controls.json` | New authoritative record: 30 trust-crossing/control objects with the full 13-field contract, severity, control/verification, owner tickets, verification lane, and release tests. |
| `docs/architecture/distributed-execution-threat-model.md` | New rendered threat model: trust-boundary table, the 30-row register rendered from the JSON, hardening-amendment coverage, and residual release exclusions. |
| `docs/architecture/decisions.md` | Appended the Decision #121 threat-model link paragraph after the authority paragraph. |
| `scripts/check-distributed-execution-foundation.mjs` | Added `validateThreatModel` (structured crossing validation, owner-ticket cross-reference, exact JSON↔Markdown register parity, residual exclusions) and the #121 threat-model back-reference. |
| `scripts/check-distributed-execution-foundation.test.mjs` | Added the 26 FND-003 mutation cases; `makeFixture` now copies the threat model, threat controls, and program design. |
| `docs/replatform/epics/E0-foundation/tickets/FND-003-result.md` | This ticket result ledger. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| Every crossing carries all 13 required fields | `validateThreatCrossings` enforces `THREAT_CROSSING_REQUIRED_FIELDS`; the 13 field-removal mutations each fail with the exact missing-field cause | `pass` |
| Unique stable IDs; duplicates rejected | Duplicate-ID scan; the "duplicate crossing id" mutation fails with `duplicate crossing id "DE-01"` | `pass` |
| Known severity and verification-lane values | Enumeration checks; the "unknown severity"/"unknown verificationLane" mutations fail | `pass` |
| Non-empty owner-ticket arrays whose IDs exist in program-design | `parseProgramTicketIds` parses the 95 backlog `#### <ID> —` headings; owner IDs cross-referenced; "invented owner ticket" and "empty ownerTickets" mutations fail | `pass` |
| Release test for every Critical/High crossing | REL-* owner or `releaseTest` field; the "removing a Critical/High release test" mutation fails with `crossing DE-14 is Critical but has no release test` | `pass` |
| Complete JSON↔Markdown ID/field parity (every control, both directions, incl. count) | `validateThreatRegisterParity` asserts exact ID-set equality + per-ID threat/severity/control/verification/owner parity; "omit a Markdown ID", "extra Markdown ID", and "drifted severity" mutations all fail | `pass` |
| Residual risks exclude the five named surfaces | `RESIDUAL_EXCLUSIONS` presence gate on the residual section body | `pass` |
| Decision #121 links the threat model | decisions.md reference check + "loses the threat-model back-reference" mutation fails | `pass` |
| FND-001/FND-002 contract still enforced | Full retained corpus still passes; no prior case removed | `pass` |
| No new dependency | `git diff -- pnpm-lock.yaml` empty | `pass` |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm check:distributed-foundation` (RED, before threat-model docs / #121 link existed) | `1` | Printed `docs/architecture/distributed-execution-threat-model.md: missing`, `docs/architecture/distributed-execution-threat-controls.json: missing`, and `docs/architecture/decisions.md: missing reference to "distributed-execution-threat-model.md"` |
| `pnpm check:distributed-foundation` (GREEN, full structured checker) | `0` | `distributed execution foundation: PASS` |
| `node --test scripts/check-distributed-execution-foundation.test.mjs` | `0` | `tests 55 / pass 55 / fail 0` (29 retained FND-001/FND-002/E0-F002 cases + 26 new FND-003 cases) |
| `git diff -- pnpm-lock.yaml` | `0` | No output — lockfile byte-unchanged (no dependency change) |

## Deviations

None.

## Findings

`E0-F003` — carry-forward hardening applied. FND-003 pins a stable ID set (DE-01…DE-30) and cross-references a Markdown render, so it uses **exact-set / reject-unknown** validation (item 2): the register parity asserts the JSON crossing ID set equals the Markdown register ID set in **both** directions (an extra ID on either side is an error, count included), rejects duplicate IDs, validates **every** control ID's rendered fields (not only first/last), and rejects owner tickets not defined in `program-design.md`. The mutation corpus proves both the missing-ID and extra-ID directions fail. E0-F003 item 1 (per-clause negation scoping) is not applicable to FND-003's new code, which introduces no new negation-style invariant scan — it replaces substring/negation heuristics with structured exact-set parity for its own surface. `findings.md` disposition is left for the controller.

## Follow-up tickets

None.

## Gate recommendation

`ready for independent review` — the checker is GREEN, the RED→GREEN sequence is recorded, all 30 crossings validate with owner IDs cross-referenced against the backlog, the 26 FND-003 mutations and the retained FND-001/FND-002 corpus all pass (55/55), `pnpm-lock.yaml` is byte-unchanged, and only the six planned files are touched.

## Independent review

**Reviewer:** FND-003 independent reviewer subagent (Claude)
**Reviewed revision:** 09651fb63ee24c4b14aadabbd30cfa3450f7b696
**Disposition:** `approved`
**Review evidence:**

- `pnpm check:distributed-foundation` → exit `0`, prints `distributed execution foundation: PASS`.
- `node --test scripts/check-distributed-execution-foundation.test.mjs` → exit `0`, `tests 55 / pass 55 / fail 0` (29 retained FND-001/FND-002/E0-F002 cases + 26 new FND-003 cases; both baselines — real repo and unmutated fixture copy — green).
- `git diff BASE..HEAD -- pnpm-lock.yaml package.json` → empty (dependency-free constraint held; the checker and test import only `node:*` built-ins). Diff touches exactly the six planned files.
- Code-quality read of the diff: the new units (`parseProgramTicketIds`, `crossingHasReleaseTest`, `validateThreatCrossings`, `validateThreatRegisterParity`, orchestrated by `validateThreatModel`) each carry a single responsibility, reuse the existing `readOrError`/`requireFile`/`sectionBody`/`extractTable` helpers, are cleanly named/decomposed for FND-004..008 to extend, and contain no dead code and no silent catch-and-ignore (the sole `try/catch` is `JSON.parse`, which pushes a classified error; every degraded path null-guards and records a cause).
- Owner cross-reference verified adversarially: `parseProgramTicketIds` regex `^####\s+([A-Z][A-Z0-9]*-\d+)(?:\s|$)` correctly parses the real backlog heading format (em-dash separator + `(S)`/`(M)` size suffix); all 95 `#### <ID> —` headings parse and all 30 crossings' `ownerTickets` (incl. `REL-*`/`MIG-*`/`SVC-*`/`DSK-*`/`CLI-*`) resolve to defined tickets; an invented owner (`ZZZ-999`) is rejected. No false-positive/false-negative on the real document.
- Release-test gate verified: for every Critical/High crossing a `REL-*` owner OR a non-empty `releaseTest` field is required; removing DE-14's `releaseTest` (owner `FND-005` only, no `REL-*`) flips exactly that crossing (`crossing DE-14 is Critical but has no release test`) and is not masked by a required-field check (`releaseTest` is intentionally optional). A `REL-*` owner that is itself undefined is still caught by the owner cross-reference — no false pass.
- Exact-set register parity verified in both directions (JSON→MD omit DE-30; MD→JSON extra DE-99), plus per-ID severity drift (DE-01 Critical→High) and duplicate-row detection; the ID-set + duplicate-row checks enforce count. No false-positive on the valid render (30/30 rows match). Field-removal mutations for all 13 required fields each fail with the exact missing-field cause.
- Two **Minor** (non-blocking) robustness observations for the spine, neither a plan requirement and neither affecting the current green data: (1) the JSON `threat`/`control`/`verification` fields are rendered register columns and are compared in per-ID parity, yet are absent from `THREAT_CROSSING_REQUIRED_FIELDS`; because parity is guarded by `typeof c.<field> === "string"`, **deleting** one of these from a JSON crossing yields zero errors (verified by an out-of-tree probe dropping `control` → `errors: 0`) — value-drift is still caught, only field-deletion escapes. Recommend adding those three to the required-field set (all 30 crossings already carry them, so the corpus stays green) so the parity claim is fully robust for FND-004..008. (2) A few mutation cases (`id`, `ownerTickets`, and duplicate-`id` removal/collision) produce a cascade of secondary errors rather than a single isolated one; the assertions still target specific substrings, so they remain valid. The Trust-boundaries table is rendered from JSON `boundary`/`trustedSide`/... but is not parity-checked (only the register is) — acceptable, as the register is the authoritative parity target.

For `approved`, verify the result describes the reviewed revision, all focused acceptance evidence passes, and every accepted finding is resolved; then change the top-level `Status` to `complete` and commit this disposition separately. Otherwise leave `Status` as `gate_review` or set `blocked`, and link stable findings.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary above is not a review attempt. The first independent reviewer appends attempt 1, and later reviewers append monotonically increasing rows without replacing prior attempts. The summary fields above mirror the latest real attempt for existing gate tooling. Do not include a `Review commit` column: a row cannot embed the SHA of the commit that first contains it. Repository history identifies that commit, and handoffs pin the resulting ticket-result blob SHA.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | FND-003 independent reviewer subagent (Claude) | 09651fb63ee24c4b14aadabbd30cfa3450f7b696 | `approved` | `pnpm check:distributed-foundation` exit 0 (PASS); `node --test …test.mjs` exit 0 (55/55; 29 retained + 26 new); `pnpm-lock.yaml`/`package.json` byte-unchanged; diff = the six planned files. Owner cross-reference (regex vs real `#### <ID> —` headings, all 95 parsed, all 30 crossings resolve, invented owner rejected), release-test gate (DE-14 isolation), and exact-set register parity (both directions + count + per-ID severity/owner) all verified adversarially; no false-positive on the valid render. Two Minor non-blocking notes recorded: `threat`/`control`/`verification` not in the required-field set so a JSON field-**deletion** escapes per-ID parity (probe: dropping `control` → 0 errors; value-drift still caught) — recommend adding them to required fields for the spine; and a few mutation cases cascade rather than isolate (assertions still specific). Neither is a plan requirement; the delivered structured parity is stronger than the plan's substring-only gate. |
<!-- First independent reviewer appends attempt 1. -->
