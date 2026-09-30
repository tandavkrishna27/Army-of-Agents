# FND-007 Result — Freeze Execution Sources and Legacy Parity

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E0-foundation`
**Plan task:** `Task 7: FND-007 — Freeze Execution Sources and Legacy Parity`
**Implementer:** FND-007 implementer subagent (Claude)
**Start SHA:** 188cd2a96f86a11622f1b2b4bc20d9d4946fe0b4

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the Independent review section and is the only role that may change it to `complete`.

This file is a controlled append-only review ledger until `complete`; do not delete or rewrite prior review attempts. Once `complete`, it is frozen.

## Delivered scope

Freezes the six current-main execution-source kinds, their legacy parity matrix, and the current-main crosswalk as machine-checkable authorities validated by the always-on `policy`-job checker.

- **New authority `docs/architecture/distributed-execution-legacy-parity.json`.** Declares exactly the six execution-source kinds (`task_run`, `commander_turn`, `crew_run`, `one_shot`, `browser_request`, `service_reconcile`). Each kind declares required/forbidden source fields, opaque requester/executor principal kinds, its owning crosswalk `CM-*` rows, and a behavior (or a justified `not_applicable`) for every one of the eight parity dimensions: `checkout_assignment`, `capacity_claim_release_wakeup`, `product_runtime_approval`, `budget`, `audit`, `cost`, `output_run_summary`, `completion_cancel_retry`. Only `task_run` requires `runId`/`issueId`; the other five forbid them (opaque typed provenance, not run/issue identity). A `not_applicable` dimension must carry a non-empty justification. Also declares `forbiddenOrganizationSentinels` (the fail-open `DEFAULT_ORGANIZATION_ID` sentinel that TEN-006 removes) so a sentinel-Organization admission is rejected.
- **`docs/replatform/current-main-crosswalk.md` is now machine-checkable.** The CM (execution/lifecycle) and CP (cloud-plugin) tables are parsed as structured tables: contiguous unique row IDs `CM-001…CM-015` and `CP-001…CP-005` (exact set, count-pinned, unknown/extra rejected), explicit enumerated owner ticket IDs (ranges/prose invalid) that all exist in `program-design.md`, non-empty current-authority + disposition cells, per-CM-row `shadow`/`drain`/`rollback` + hard-negative evidence, and the CM-015 migration-0188 snapshot/marker seam (`record_0188_marker` + snapshot + a per-clause-negated no-auto-bypass invariant). Row wording was tightened only to surface these tokens where the concept was already present; no substantive disposition changed.
- **Fixture source/principal binding.** The nine golden-journey fixtures already carried `source.kind` + the `task_run` `runId`/`issueId` discriminant (schema, FND-004) and `requester`/`executor` principals; FND-007 binds them to the authority — the checker validates each fixture's `source.kind` against the six kinds, its `requester`/`executor` principal kinds against the per-kind allow-lists, its forbidden/required source fields against the authority, and rejects a sentinel Organization. No fixture bytes changed; every `eventDigest` is unchanged and still valid.
- **Decision #121 links both authorities.**

### Non-goals preserved

- No substantive crosswalk disposition changed; only literal tokens were surfaced for machine-checkability.
- No server/DB/network code; docs + fixtures + dependency-free checker only.
- FND-001..006 validations, the nine fixtures/digests, and every prior mutation still pass unchanged.

## Changed files

| File | Responsibility |
|---|---|
| `docs/architecture/distributed-execution-legacy-parity.json` | NEW — six execution-source kinds, principals, required/forbidden fields, eight parity dimensions (or justified `not_applicable`), sentinel-Organization block. |
| `docs/replatform/current-main-crosswalk.md` | Tighten CM row evidence wording to surface `shadow`/`drain`/`rollback` tokens (substance unchanged). |
| `docs/architecture/decisions.md` | Decision #121 links the legacy-parity authority + the current-main crosswalk. |
| `scripts/check-distributed-execution-foundation.mjs` | FND-007 validation: legacy-parity authority, crosswalk structured tables, fixture source/principal binding. |
| `scripts/check-distributed-execution-foundation.test.mjs` | FND-007 mutation corpus + copy legacy-parity.json + crosswalk into the fixture tree. |
| `docs/replatform/epics/E0-foundation/tickets/FND-007-result.md` | This result. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| Six execution-source kinds frozen (exact set, count-pinned) | `check` legacy-parity kind-set + mutation | `pass` |
| Every parity dimension present or justified `not_applicable` | `check` parity-dimension loop + mutations | `pass` |
| Only `task_run` requires `runId`/`issueId`; others forbid | `check` runId/issueId rule + fabricated-provenance mutations | `pass` |
| CM-001…CM-015 + CP-001…CP-005 contiguous, unique, count-pinned | `check` crosswalk exact-set + missing/extra-row mutations | `pass` |
| Owner ticket IDs enumerated (no ranges/prose) and all exist in program-design | `check` owner enumeration + unknown-ticket + range mutations | `pass` |
| CM-015 migration-0188 snapshot/marker + no-auto-bypass | `check` CM-015 marker + auto-bypass mutations | `pass` |
| Requester/executor principal binding per source kind | `check` fixture principal cross-validation + identity-mismatch mutation | `pass` |
| Sentinel Organization admission rejected | `check` sentinel mutation | `pass` |
| Markdown↔JSON drift (legacy-parity references a non-existent CM row) | `check` drift mutation | `pass` |
| Every `eventDigest` still valid; FND-001..006 corpus unchanged | full `node:test` run | `pass` |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `git rev-parse HEAD` (before first change) | `0` | `188cd2a96f86a11622f1b2b4bc20d9d4946fe0b4` |
| **RED** `node scripts/check-distributed-execution-foundation.mjs` (authority absent, crosswalk unstructured, Decision #121 links absent) | `1` | 23 errors: `distributed-execution-legacy-parity.json: missing`; 20 `shadow`/`drain`/`rollback` CM evidence-field errors across 11 rows (CM-003/005/007/008/009/010/011/012/013/014/015); 2 Decision #121 back-references absent |
| **RED** `node --test scripts/check-distributed-execution-foundation.test.mjs` | `1` | tests 136, fail 3 (the two valid baselines + the unmutated fixture copy — legacy-parity.json not yet copied into the tree) |
| **GREEN** `node scripts/check-distributed-execution-foundation.mjs` (`pnpm check:distributed-foundation`) | `0` | `distributed execution foundation: PASS` |
| **GREEN** `node --test scripts/check-distributed-execution-foundation.test.mjs` | `0` | tests 162, pass 162, fail 0 (was 136; +26 FND-007 mutations) |
| `git diff --check` | `0` | clean (only benign LF→CRLF notices) |
| `git diff -- pnpm-lock.yaml` | `0` | EMPTY (byte-unchanged) |
| `git diff --stat -- tests/fixtures/distributed-execution` | `0` | EMPTY (no fixture bytes changed; every `eventDigest` unchanged and valid) |

## Deviations

1. **Fixtures/schema already carried the source/principal fields (no new fixture bytes).** FND-004 pre-placed the closed six-kind `Source` discriminant (`source.kind` ∈ the six, with the `task_run` `runId`/`issueId` `if/then/else` rule) and the `requester`/`executor` principals into `schema-v1.json` and the nine fixtures — including the two fabricated-provenance discriminant tests. FND-007 therefore "extends" the fixtures by **binding** them to the new `legacy-parity.json` authority (per-kind principal allow-lists, forbidden/required source fields, sentinel-Organization block) through the checker rather than adding redundant bytes. No fixture bytes changed, so every `eventDigest` is untouched and still valid. This is a minor deviation from the literal "extend all nine fixtures + `schema-v1.json`" wording; the extension is the authority + strict cross-validation, and the schema Source contract was already present.
2. **CM (migration) vs CP (disable) field-sets differ, by the crosswalk's own framing.** The checker requires the full `shadow`/`drain`/`rollback` + hard-negative evidence contract on the CM execution/lifecycle rows (migration rows with a cutover) but NOT on the CP cloud-plugin rows, because the crosswalk itself frames the CP rows as "a release blocker, not a migration option" (disable-in-cloud / preserve-self-hosted) and its closure rule treats CM and CP differently. CP rows are validated for contiguity, non-empty cells, enumerated owners, and a hard-negative. Forcing cutover/drain/rollback tokens onto a never-migrate row would misstate the disposition.
3. **Crosswalk wording tightening.** Eleven CM rows expressed the `shadow`/`drain`/`rollback` concepts in synonyms (`comparison`, `reconciliation`, `kill switch`, …) but not the literal tokens the machine check requires; the literal token was surfaced adjacent to the existing concept. No substantive disposition changed (verified by the checker's continued acceptance of every current-authority/target-disposition cell).

## Findings

Applies **E0-F003** (carry-forward from FND-002 review):
- **Item 2 — exact-set / reject-unknown / count pinning.** The CM/CP row-ID sets are pinned to exactly `CM-001…CM-015` and `CP-001…CP-005` (missing, extra/unknown, duplicate, and count all fail — see the removed-CM-row, removed-CP-row, and extra-CM-016 mutations). The six execution-source kinds are likewise an exact count-pinned set (unknown kind + 7th-source mutations fail).
- **Item 1 — per-clause negation scoping.** The CM-015 migration-0188 no-auto-bypass invariant splits the row into clauses on `[;.,|]` and requires the clause that mentions `auto-bypass` to be negated **in that clause**, not merely somewhere in the row — so an un-negated auto-bypass clause fails even though the row carries other negations elsewhere.

Does not edit `findings.md`.

## Follow-up tickets

None. (Consumers PRT-002/003/006/007, TEN-006, JOB-010..014, CLI-005, MIG-005/006/007 read this frozen authority in later epics; the `browser_request`/`service_reconcile` kinds are net-new target-only classes with no current-main CM row, owned by BRW-*/SVC-*.)

## Gate recommendation

`ready for independent review` — the legacy-parity authority (six kinds × eight parity dimensions, principals, run/issue-identity rule, sentinel block), the structured crosswalk (contiguous CM/CP sets, enumerated owners cross-referenced to program-design, CM-015 migration-0188 marker + per-clause no-auto-bypass), and the fixture source/principal binding all validate; the dependency-free checker PASSes and the 162-case mutation corpus (136 prior + 26 new FND-007) is green. `pnpm-lock.yaml` byte-unchanged, no fixture bytes touched, `git diff --check` clean. FND-001..006 validations, the nine fixtures/digests, and every prior mutation still pass.

## Independent review

**Reviewer:** FND-007 independent reviewer subagent (Claude)
**Reviewed revision:** 419400291a0b3e96725b9fc1c5d386d3253fec4a
**Disposition:** `approved`
**Review evidence:**

Reviewed `git diff 188cd2a96f86a11622f1b2b4bc20d9d4946fe0b4 419400291a0b3e96725b9fc1c5d386d3253fec4a` (6 files: the new `distributed-execution-legacy-parity.json` authority, the crosswalk evidence-token surfacing, the Decision #121 links, the checker + test extensions, and this ledger). The only code is the `scripts/check-distributed-execution-foundation.mjs` extension; verified by reading + running on Windows, every exit code observed directly. HEAD confirmed `= 419400291…`.

- **Focused commands — both green.**
  - `pnpm check:distributed-foundation` (= `node scripts/check-distributed-execution-foundation.mjs`) → exit `0` (`distributed execution foundation: PASS`).
  - `node --test scripts/check-distributed-execution-foundation.test.mjs` → exit `0` (tests 162, pass 162, fail 0; +26 FND-007 mutations over the 136 prior). Each new mutation fires its exact expected error: missing/extra/removed CM+CP rows (contiguous count-pin + exact-set), unknown source kind + 7th-source count pin, bare `not_applicable`, `not_applicable` object without justification, unknown parity dimension, `task_run`-only `runId`/`issueId` (both directions), unknown executor principal, JSON↔CM drift, missing/invented/range owner ticket, missing `rollback` evidence field, CM-015 `record_0188_marker` + per-clause auto-bypass negation, requester + executor identity mismatch, forbidden `issueId` on `one_shot`, sentinel Organization, and both Decision #121 back-references.
- **Crosswalk structured-table parser — sound, not brittle to the real doc.** Reuses the FND-001/002/003 `sectionBody`/`extractTable`/`splitRow` spine. CM/CP headers, column indices (authority 2 / disposition 3 / owner 4 / evidence CM=5,CP=4), contiguous count-pinned ID sets (`CM-001..015`, `CP-001..005`), the enumerated-owner residue check (ranges/prose rejected on CM), the owner cross-reference against the shared `parseProgramTicketIds(program-design.md)` set (FND-003 parse, reused correctly — CP owners `FND-006`/`FND-008` resolve), per-CM `shadow`/`drain`/`rollback` + hard-negative, and the CM-015 per-clause `auto-bypass` negation all verified correct against the current file. A removed/added/renumbered CM/CP row is caught (missing-required + count-pin + exact-set), and the legitimate crosswalk passes clean.
- **legacy-parity validator — no observed false-negative.** Enforces the exact six kinds + count pin, per-kind required/forbidden fields with the `task_run`-only `runId`/`issueId` rule (both directions), non-empty opaque requester/executor principal enums, JSON↔crosswalk CM-row existence binding, and every one of the eight parity dimensions present as a non-empty behavior string or a justified `not_applicable` object (bare token rejected; empty/whitespace justification rejected; unknown/duplicate dimension rejected). `parseJsonStrict` independently rejects duplicate keys and trailing content (probed directly), closing the malformed-JSON path.
- **Migration-0188 no-auto-bypass invariant — robust.** The per-clause split on `[;.,|]` (pipes included, so a negation in a different cell cannot satisfy an affirmative clause) requires every `auto-bypass` clause to carry a negation in that same clause; adding an un-negated affirmative fails even when the negated invariant is still present. No false-positive on the real CM-015 row.
- **Source/principal fixture binding — genuine.** Each of the nine golden-journey fixtures binds `source.kind` → per-kind principal allow-lists + forbidden/required source fields + the sentinel-Organization block; the fabricated-provenance (forbidden `issueId`), identity-mismatch (requester/executor), and sentinel-Org mutations genuinely fail. No fixture bytes changed (`git diff --stat -- tests/fixtures/distributed-execution` EMPTY); every `eventDigest` intact.
- **Dependency-free held.** No new imports added to the checker; `git diff -- pnpm-lock.yaml` EMPTY. `git diff --check` clean (only benign LF/CRLF notices).

No Critical or Important issues. Minor, non-blocking (recorded for the shared spine; no fix required for approval): (1) `ownerCol = isCm ? 4 : 4` is a redundant ternary (both branches 4); (2) `parseProgramTicketIds` reads `program-design.md` twice per run (`validateThreatModel` + `runCheck`) — a duplicate "missing" error if that file is ever absent; (3) `validateCrosswalkTable` does not assert per-row cell count == header length, so with the naive `splitRow` pipe split a future inline/escaped `|` inside a cell could silently misalign columns (shared-spine limitation; no impact today — the current tables carry no inline pipes); (4) the bare-`not_applicable` guard matches only the exact token, so authored prose like "not applicable"/"N/A" would pass as a behavior string; (5) `crosswalkRows` binding is existence-only — a source could cite a wrong-but-existing CM row and pass (semantic mapping unenforced, acceptable for a freeze); (6) the Decision #121 reference checks are whole-file substring presence rather than scoped to the #121 section, matching the pre-existing four references. All are consistent with the reviewed FND-001..006 spine and none weaken the freeze.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary above is not a review attempt. The first independent reviewer appends attempt 1, and later reviewers append monotonically increasing rows without replacing prior attempts.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | FND-007 independent reviewer subagent (Claude) | 419400291a0b3e96725b9fc1c5d386d3253fec4a | `approved` | `pnpm check:distributed-foundation` exit 0 (`PASS`) + `node --test scripts/check-distributed-execution-foundation.test.mjs` exit 0 (162/162; the 26 FND-007 mutations each fire their exact error). Crosswalk parser + legacy-parity validator + migration-0188 per-clause no-auto-bypass + fixture source/principal binding all verified sound; malformed inputs rejected, legitimate corpus passes. Dependency-free held (`pnpm-lock.yaml` unchanged); no fixture bytes changed. No Critical/Important; 6 Minor spine notes, non-blocking. |
<!-- Later reviewers append attempt 2+ below without editing attempt 1. -->
