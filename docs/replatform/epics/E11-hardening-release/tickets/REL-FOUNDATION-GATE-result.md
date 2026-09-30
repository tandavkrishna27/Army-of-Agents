# REL-FOUNDATION-GATE — Result: the E0 release-test gate no longer accepts a bare string

**Sprint 9, unit 1. Epic E11 (touching the E0 foundation checker).** Design + Start SHA:
[`REL-FOUNDATION-GATE-design.md`](./REL-FOUNDATION-GATE-design.md) (committed at `149f4df9a`).
Ship commits: `e8e1975a5` (code) + the docs commit carrying this result. `verify`/§2.0 is
RESOLVED, so CI honesty is reported against the full `code=true` gate (§7 below).

---

## ★ HEADLINE

**This unit makes E0 honest WITHOUT re-reddening `ci-required`.** The foundation checker's
release-test contract used to be satisfied by a crossing *naming* a REL ticket — written or
not; 24 of 30 Critical/High trust crossings named REL-001/002/003/005, which have **never been
written**, and E0 reported PASS over all 24. The gate is now **trackable-strict**: a named REL
ticket is admissible only if its `<id>-design.md` exists on disk **or** it is declared, with a
reason, in a new deferral manifest. It **ships 0-error at rest** — 6 crossings admit on the
written REL-004, 24 on manifest-deferral — so `policy` → `ci-required` stays green while E0
becomes honest. **The four unwritten release tests (REL-001/002/003/005) are now machine-tracked
debt**, not vacuous green; each one's landing is forced to retire its own deferral.

This is **option (c)**, the trackable-strict gate — **not** a hard-strict flip. A hard-strict
"the ticket must exist on disk" flip (option b) would push 24 errors at rest → red the always-on
`policy` job → red `ci-required` on **every** PR until all four REL tickets land (REL-001/002
block on Sprints 7/8, REL-005 on all of them). That is a self-inflicted merge freeze, forbidden
by GO-BOOK §2.0 now that `verify` is green. Proven below, from source, that (b) reds.

---

## What shipped

| Path | Change |
|---|---|
| `scripts/check-distributed-execution-foundation.mjs` | replaced `crossingHasReleaseTest` (bare-string) with `namedReleaseTickets` + `checkCrossingReleaseTest` (admissibility gate); added `parseWrittenRelTickets` (readdir the E11 tickets dir, `^(REL-\d+)-design\.md$`), `loadReleaseTestManifest` (fail-closed on absent/unreadable/bad JSON), and `validateReleaseTestDeferrals` (stale / malformed / unreferenced hygiene); threaded both inputs through `validateThreatCrossings`/`validateThreatModel`. New constants `REL_TICKETS_DIR`, `RELEASE_TESTS_JSON`, `REL_TOKEN_RE`. |
| `docs/architecture/distributed-execution-release-tests.json` | **new** deferral manifest, `version: 1`, declaring REL-001/002/003/005 with reasons; REL-004 is written and NOT declared; REL-003's reason marks its deferral **transitional** (removed in unit 2). |
| `scripts/check-distributed-execution-foundation.test.mjs` | extended `makeFixture` to `cpSync` the E11 tickets dir + `copyFileSync` the manifest into the fixture root and expose `relTicketsDir`/`releaseTestsPath` (design §3.4); updated the DE-14 release-test case to the refined message; added 13 release-gate cases (M0–M8 + 3 structural + a symmetric absent-tickets-dir fail-closed). No NEW `*.test.mjs` file — no execution-census bump (verified). |
| `docs/replatform/epics/E11-hardening-release/findings.md` | **new** — filed **E11-F001** (§0f discrepancy). |
| `scripts/finding-ownership.json` | added `E11-F001` (`unowned` + reason) in the SAME commit as the finding. |
| `docs/replatform/program-design.md` | added an **inert** `#### REL-FOUNDATION-GATE` node (human traceability only; no 3-digit id → invisible to `check-ticket-graph-coverage` and to `parseProgramTicketIds` — verified). |
| `docs/replatform/GO-BOOK.md` | §3.1 S9 unit-1 ship row; §4/§5 confirmed matching (already corrected in review round 2). |

**No migration, no schema, no `packages/worker-protocol` change (FROZEN), no new `AOA_*`.**

---

## The decision function (as built)

A Critical/High crossing's release test is **admissible** iff it NAMES ≥1 REL ticket and
EVERY named REL ticket is admissible: on disk (`written`) OR deferred-with-reason (`deferred`).
Two deliberate strengthenings over the go-book's literal "must exist": the release test must
*name* a REL ticket (`named.size === 0` reds — closes the arbitrary-non-empty-string loophole),
and *every* named ticket must be admissible (a bogus `REL-999` alongside a real one reds). The
`releaseTest` field's REL token is now cross-referenced too — the `ownerTickets` arm already
was. An **absent manifest fails closed** (`readOrError` pushes `: missing`; `deferred` → `{}`),
not empty-allow-list — the DSK-004/REL-004 D2 refusal rule.

---

## Mutation line

**9 mutants, 9 killed, 0 survivors, 0 documented equivalents, 0 false kills.** Positive control
(M0) FIRST; every guard DELETED (never rewritten to an equivalent); the anchor was grepped
present on each mutate and grepped absent after each `git checkout` revert (anchor matched on
all nine).

| # | Mutant (DELETE / neuter) | Killed by | Observed on kill |
|---|---|---|---|
| **M0** | `checkCrossingReleaseTest` → no-op (`return;`) | positive-control case | case reds; **rest-CLI stays green** (exit 0) — see Residual |
| M1 | disk-existence arm (`written.has(id)` → false) | `valid: the real repository passes` | exactly the **6** REL-004 crossings red (DE-09/10/15/17/24/26); rest exit 1 |
| M2 | manifest-deferral arm (`isDeferred` → false) | `valid: the real repository passes` | exactly **24** crossings red — this mutant **is** option (b)'s hard-red state |
| M3 | "names a REL ticket" guard (`named.size===0` push) | M3 non-REL-string case + DE-14 case | both red |
| M4 | stale-deferral guard | M4 `deferred["REL-004"]` case | case reds |
| M5 | malformed-deferral guard | M5 `{}` case | case reds — **diagnostic kill, backstopped** (see note) |
| M6 | unreferenced-deferral guard | M6 `REL-777` case | case reds |
| M7 | absent-manifest fail-open (discard `readOrError` missing push) | M7 `rmSync` case | case reds — **diagnostic kill, backstopped** (see note) |
| M8 | existence keyed on `-result.md` not `-design.md` | M8 `REL-006-design.md` fixture case | case reds — **isolated kill, see note** |

**M5 note (anchor-matched equivalence proof).** M5's kill is *diagnostic*: deleting the
malformed hygiene guard removes the precise "must be an object with a non-empty reason" message,
but the `{}` entry still reds the 14 REL-001 crossings via the crossing-level `isDeferred`
reason-check (the design's deliberate defense-in-depth). Verified on the **unmutated** checker
that the `{}` fixture produces **both** the malformed diagnostic AND 14 crossing reds (15
REL-001 errors total). Deleting BOTH the malformed guard AND the `isDeferred` reason-check
(presence-only) fails the `{}` entry **open** — the pair is jointly the fail-closed mechanism.
Not an equivalent mutant: M5 alone is killed.

**M7 note (same shape as M5 — diagnostic kill, backstopped).** M7's kill is *diagnostic*, structurally identical to M5: the M7 case asserts the specific `distributed-execution-release-tests.json: missing` substring, and discarding the `readOrError` missing-push removes exactly that diagnostic. The fail-closed *behavior* is backstopped — with the manifest absent, `loadReleaseTestManifest` returns `deferred → {}`, so the crossing-level `!isDeferred` check still reds the 24 declared crossings and the CLI still exits 1. The `: missing` push is load-bearing as the EXPLICIT fail-closed signal: it is the only signal that would fire if the register ever had zero Critical/High crossings (nothing for the crossing-level backstop to red). Killed by the specific-substring assertion; behavior backstopped. (Surfaced by the completeness reviewer, who noted M5 carried this note and M7 did not.)

**M8 note (why the dedicated fixture is load-bearing).** Under M8, `valid: the real repository
passes` **still passes** — REL-004 has *both* a design doc and a result doc, so result-keying
still finds it. Only the dedicated M8 fixture (a `REL-006-design.md` with **no** result doc)
isolates the design-vs-result distinction and reds the mutant. That fixture writes the design
doc INTO the fixture root and asserts it is seen there — so it doubles as the C4 root-relative
proof (a cwd-relative `readdir` would read the real tree, where REL-006 is absent, and red).

---

## The finding filed

**E11-F001** (`findings.md`, LOW, `open`) with its byte-equal `E11-F001` ownership key
(`unowned` + reason, same commit): the 2026-08-27 breadth terrain audit's Sprint 9 section
still carries the pre-CI-green *"flips E0 to honestly-red until E11 lands"* framing and the
imprecise *"30/30 name REL-001/002/003/005"* count (6 name the written REL-004; 24 name only
unwritten). `unowned` is **forced** — `REL-FOUNDATION-GATE` has no numeric id, so `findTicketIds`
cannot recognise it and `owned` would red `owner_ticket_missing`. The dated QA snapshot is
recorded, not silently rewritten (GO-BOOK §4/§5 were corrected in review round 2).

---

## ★ The residual (design §0h) — enforced AT REST, not AGAINST REGRESSION

The foundation checker's own suite `check-distributed-execution-foundation.test.mjs` is
`status:"unrun"` in `scripts/test-execution-census.json` and wired into **no CI job** — only the
CLI `node scripts/check-…mjs` runs (`pr.yml`, `policy` step). The M0 mutation demonstrated the
residual precisely: **the rest-CLI stays green (exit 0) with the gate neutered to a no-op** —
the CLI passes at rest under BOTH the vacuous bare-string form and option (c)'s strict form
(strict is merely more restrictive). So a future regression that re-vacuates
`checkCrossingReleaseTest` is caught by **no CI signal** — only by the unwired M0–M8 cases. The
gate ships **enforced-at-rest but not enforced-against-regression.**

This is **not** a blocker and was **not** folded into this unit (kept small + green). The
natural completion — the census's own *"single highest-value item"* — is to fix the pre-existing
`additionalProperties:false` mutate no-op and move the suite into the `policy` job. Named as a
candidate later Sprint-9 hardening unit in GO-BOOK §5.

**STEP-0 correction to the design's §0h:** the design names one pre-existing suite failure (the
`additionalProperties` no-op). At tip there are **three** — all the same "mutate self-check
no-op" class (the mutate callback's own assertion that it changed the fixture fails because the
target string drifted out of the doc): `'## Worked journeys' removed`, `authority-matrix row`,
and `additionalProperties:false`. All fail *inside* `makeFixture`, none in checker logic, none
related to this unit. `valid: the real repository passes` and `valid: an unmutated fixture copy
passes` both pass in isolation — the truest green signals. Methodology unchanged (run the
relevant cases individually).

---

## What this unit did NOT do (non-goals, with owners)

- **Writing any REL test (REL-001/002/003/005)** — Sprint 9 units 2–5, dependency-gated (§0d).
  A green gate is NOT license to attempt them (§2.4 STOP trap against absent workloads).
- **The pure "must exist, no deferrals" check** — collapses automatically as each REL ticket
  lands and removes its deferral; doing it now reds `ci-required`.
- **Wiring the foundation suite into CI** — the residual above; a candidate later S9 unit.

---

## Verification summary

- `node scripts/check-distributed-execution-foundation.mjs` → **exit 0 at rest** (after every step).
- All 13 release-gate cases + both `valid:` baselines green in isolation; full suite unchanged at
  the 3 pre-existing failures (176 pass / 3 fail; my 15 targeted cases all green).
- All five registers green: `gate-clause-wiring`, `finding-ownership` (E11-F001 UNOWNED, on the
  record), `ticket-graph-coverage`, `guard-inventory`, `execution-census` (no bump).
- **Adversarial review — 3 independent subagents, 0 HIGH/BLOCKING, 0 defects in the code.**
  (1) *0-error-at-rest + hard-strict-reds reviewer*: PASS on both — rest-green across the checker
  + all five registers, and a hard-strict variant proven from source to red (24 errors → exit 1
  → `policy` unconditionally reds `ci-required` on every PR, with exact `pr.yml` line numbers).
  (2) *Refutation skeptic*: every ships-red angle REFUTED (checker exit 0; no BOM, `JSON.parse`
  tolerates CRLF; path resolution keys off `root`; inert node doesn't pollute parsing; the 3
  pre-existing suite failures proven pre-existing at parent `149f4df9a` and absent from CI's
  `node --test` list). (3) *Completeness critic*: all 9 guards M0–M8 individually killed by a
  named case (empirically confirmed, no survivors / no false kills / no loose assertions),
  finding⇄ownership byte-consistency intact, `owned` proven impossible. **One minor doc fix
  applied:** the M7 backstop note above (the critic observed M5 carried it and M7 did not) — a
  documentation asymmetry, not a code defect.
