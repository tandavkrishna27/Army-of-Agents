# E4-F013 — result: the ownership guard's `ownerStillOpen`-is-free-text hole is closed

**Epic:** E4 · **Kind:** guard hardening (the programme's finding-ownership backstop)
**Owns / resolves:** finding **E4-F013** (`epics/E4-worker-daemon/findings.md`) — resolved in this landing
**Design:** `E4-F013-ownership-successor-design.md` (Start SHA `4f8d9a515`) · **Depends on:** nothing
(pure-logic guard + its manifest); `worker-protocol` untouched (FROZEN)

---

## What landed

Before this ticket, `scripts/lib/finding-ownership.mjs` let an OPEN finding stay `owned` by a
**shipped** ticket (one with a `*-result.md`) on nothing but a non-empty `ownerStillOpen` string —
so "the ticket shipped but the finding legitimately survives it" and "nobody moved this and nobody
noticed" were indistinguishable. The guard is the programme's backstop against exactly that failure,
and it had the hole in it.

Now, when `entry.status === "owned"` **and** `completed.has(entry.ticket)`, the guard runs a
**five-arm chain**. `ownerStillOpen` is kept as the human PROSE (which part is still open) and
`successor` is added as the machine-checkable POINTER (which real ticket inherits the residual):

| # | Condition (in code order) | Kind pushed | Detail |
|---|----------------------------|-------------|--------|
| 1 | `!hasReason(entry.ownerStillOpen)` | `owner_ticket_already_complete` | `entry.ticket` |
| 2 | `!hasReason(entry.successor)` | `successor_missing` | `entry.ticket` |
| 3 | `entry.successor === entry.ticket` | `successor_is_self` | `entry.successor` |
| 4 | `!tickets.has(entry.successor)` | `successor_not_on_disk` | `entry.successor` |
| 5 | `completed.has(entry.successor)` | `successor_already_complete` | `entry.successor` |

Arm 1 is independent (it can co-occur with a successor problem — a shipped owner missing *both* prose
and successor emits two kinds). Arms 2–5 are a **mutually-exclusive else-if cascade** so a
`deepEqual(kinds, …)` assertion stays single-kind.

- **Arm 1 is byte-preserved** from the prior one-line check — same kind, same detail, same trigger.
  The V2 calibration ("has a result doc ≠ finished"; you may name a shipped ticket only if you write
  which part survives) is intact. Existing calibration test unchanged in intent.
- **Arm 3 (`successor_is_self`)** is the C2 self-bypass fix: a shipped owner naming ITSELF re-opens the
  exact hole one field over. It mirrors `dependency-graph.mjs`'s existing `dep === id` self-check and
  is placed BEFORE arms 4/5 so it produces its own diagnostic (without it, a self-successor would fall
  through to `successor_already_complete`, since the owner is completed).
- **Arm 4 (`successor_not_on_disk`)** reuses the identical `tickets` set that `owner_ticket_missing`
  uses (`= new Set(findTicketIds(ROOT))`), so the two guards cannot disagree about what "a ticket
  exists" means.
- **Arm 5 (`successor_already_complete`)** is the C3 free-strengthening: `completed` was already in
  scope, and a shipped successor is the same hole one level down.

Scope is narrow by construction: nothing changes for `unowned`/`accepted` entries (the whole `owned`
block is skipped) or for owned entries whose ticket has NOT shipped (`completed.has(...)` false), so
the three repointed stubs `E4-F008 → WRK-012`, `E4-F009 → WRK-013`, `E6-F003 → DEP-011` are
structurally untouched (they have no result doc).

**Runner change is EXPLAIN-map-only** (`scripts/check-finding-ownership.mjs`): four new render strings
(`successor_missing`, `successor_is_self`, `successor_not_on_disk`, `successor_already_complete`); no
logic, no new inputs — `tickets`/`completedTicketIds` were already passed. JSDoc `declared` type
gained `successor?: string`.

### The existence-only limit (C5 — stated plainly)

The successor check is **existence-only**. It machine-forces a real ticket node + dependency skeleton
(via the ticket-graph-coverage and dependency-graph guards, which reject a bare id with no `#### ID`
node or no `Depends on:` line), but it **cannot verify the named ticket is the *correct* inheritor** —
that stays author/review responsibility. Naming any on-disk, unshipped, non-self ticket passes. This
is a deliberate limit, documented in the guard comment and the finding's resolution text: the guard
makes "it survives its owner" name a *real, live* ticket, which is the checkable half of the problem.

## The migration (bounded to E11-F002)

By STEP-0 re-verification at tip (result-doc census): `E11-F002 → REL-003` is the **only** owned entry
whose ticket has a `*-result.md`. (WRK-012/WRK-013/DEP-011 — the other owned entries' tickets — have
design docs only; confirmed by `find … -name '*-result.md'`.) So it is the only entry the new branch
reaches with force at rest, and today it carried `ownerStillOpen` but no `successor` → it would red
`successor_missing`. The migration:

- **Files the successor stub `DBR-001`** (DataBase Restore) —
  `epics/E11-hardening-release/tickets/DBR-001-design.md`, a scoping stub in the WRK-012/DEP-011 shape
  (why it exists, what it must build, precondition; no result doc, no design steps) + a
  `#### DBR-001 — … (scope)` node in `program-design.md` with `- **Depends on:** REL-003.`. It is a
  **genuine** residual, not a fig-leaf: REL-003 shipped the DR verification core + runbook but
  `runDatabaseRestore` (`packages/db/src/backup-lib.ts`) has zero production/CLI callers, is not
  barrel-exported, and no `aoa db:restore` exists — so the owed leg is a real operator restore
  entrypoint + a live staging DR rehearsal.
- **NON-REL id on purpose.** `DBR-001` is invisible to the REL-FOUNDATION-GATE release gate: it matches
  no `^REL-\d+$` owner pattern, no `/REL-\d+/g` token, and no `^(REL-\d+)-design\.md$` written-ticket
  pattern. `check-distributed-execution-foundation.mjs` still PASSES; the only observer of `DBR-001` is
  the owner-id allow-list `parseProgramTicketIds`, which is widened harmlessly.
- **Adds `"successor": "DBR-001"` to E11-F002**; keeps `status: "owned"`, `ticket: "REL-003"`,
  `ownerStillOpen`, and `reason`. **E11-F002 stays `open`** — the migration makes its
  survival-past-a-shipped-owner *checkable*, it does not resolve it.

Graph consistency of `DBR-001` (all four id-regexes): `findTicketIds` sees it (→ `tickets.has` true);
`expandTicketIdsFromFilename("DBR-001-design.md") → ["DBR-001"]` (a tracked file → needs a node → the
`#### DBR-001` node supplies it, `parseAuthorityNodes` `[A-Z]{2,5}-\d{3}` matches); dependency-graph's
`TICKET_HEADING` `[A-Z]{3,4}-\d{3}` picks up the node → requires a `Depends on:` line → `REL-003`
(a real node) supplied. `DBR-001` has no `*-result.md`, so it never itself trips the completed-owner
rule.

## The two EXISTING-test fixes (C1 — the design's §1 was wrong)

The new arms break two tests that ship in the `policy` job, so a literal implementation would ship RED.
Both were updated in the same change:

1. **`finding-ownership.test.mjs` "owned by a ticket that has ALREADY SHIPPED fails"** — its fixture is
   a completed owner with NEITHER prose NOR successor. The old assertion expected the single kind
   `["owner_ticket_already_complete"]`; the correct new output is BOTH arms firing in order,
   `["owner_ticket_already_complete", "successor_missing"]`. Assertion updated (detail on `problems[0]`
   is still the owner ticket).
2. **`finding-ownership.test.mjs` "naming a part-shipped ticket is allowed ONLY by writing what is still
   open"** — this test isolates the PROSE arm. Its `declared` helper gained a fixed valid base
   `successor: "WRK-012"` (on disk in the fixture's `ticketIds`, ≠ the owner `WRK-008`, not shipped),
   and `args.ticketIds` gained `"WRK-012"`, so the successor arm is always satisfied and only
   `ownerStillOpen` varies. All three of its assertions hold under the new code.

Seven new tests were added to the same (already census-declared) file — **positive control first**,
then the four new-arm REDs, an unaffected-non-shipped case, and a calibration-preserved case.

## Fail-first + mutation (positive control first, DELETE never rewrite)

- **RED watched before implementation:** with the arms absent, the two updated/added assertions that
  demand the new behaviour failed for the right reason (5 REDs: the ALREADY-SHIPPED both-kinds
  expectation + `successor_missing`/`successor_is_self`/`successor_not_on_disk`/`successor_already_complete`).
  Then the guard was implemented and all **21** tests went green.
- **Mutation sweep — positive control fired, all five arms killed by DELETION, 0 survivors:**

| Mutation (a DELETION, not a rewrite) | Result | Test(s) reddened |
|---|---|---|
| **M0 positive control** — delete the whole completed-owner block | KILLED | 7 tests red (proves the suite reaches this block) |
| M-owner_complete — delete arm 1 | KILLED | calibration-preserved (+ ALREADY-SHIPPED + part-shipped) |
| M-successor_missing — delete arm 2 (relink cascade) | KILLED | `successor_missing` test |
| M-successor_is_self — delete arm 3 (relink) | KILLED | `successor_is_self` test (isolated) |
| M-successor_not_on_disk — delete arm 4 (relink) — **the required M1** | KILLED | `successor_not_on_disk` test (isolated) |
| M-successor_already_complete — delete arm 5 | KILLED | `successor_already_complete` test (isolated) |

Every mutation was a deletion; the file was restored and the suite re-confirmed green after each.

## Self-resolution (same landing commit)

- `epics/E4-worker-daemon/findings.md` ## E4-F013 `**Status:**` flipped `open` → `resolved` (the
  original text kept below a `---` per the resolution convention).
- `scripts/finding-ownership.json` E4-F013 key **deleted** (an `open`-only manifest must not carry a
  resolved finding — otherwise `stale_declaration` reds the always-on `policy` job).

Both in the same commit — the standard two-step flip-and-delete (go-book §9 / C4).

## Green at rest — registers

`node scripts/check-finding-ownership.mjs` → **exit 0**, "12 open finding(s)" (was 13; E4-F013 gone),
E11-F002 green, `UNOWNED` list `E10-F001, E11-F001, E4-F014, E4-F015`. All registers green at rest:

| Register | Result |
|---|---|
| `check-finding-ownership.mjs` | OK (12 open) |
| `check-guard-inventory.mjs` | OK (40 — no new guard) |
| `check-execution-census.mjs` | OK (no census bump — the test file already existed) |
| `check-test-inventory.mjs` | OK (unchanged) |
| `check-ticket-graph-coverage.mjs` | OK (DBR-001 file+node consistent) |
| `check-dependency-graph.mjs` | OK (DBR-001 → REL-003 resolves) |
| `check-gate-clause-wiring.mjs` | OK |
| `check-distributed-execution-foundation.mjs` | PASS (DBR-001 invisible to the REL gate) |

No census bump (extended an already-declared test file); no guard-inventory change (the guard was
already registered); no migration; no `worker-protocol` change (FROZEN); no new `AOA_*`.

## Adversarial review (on the IMPLEMENTATION)

A **3-agent adversarial pass on the shipped implementation** (not the design) found **0
HIGH/BLOCKING**, nothing changed:

- **Correctness reviewer → CORRECT.** The five arms are present in order at
  `finding-ownership.mjs:127-140`, arm 1 an independent `if` and arms 2–5 a mutually-exclusive
  else-if cascade, each with the correct kind + detail; `owner_ticket_already_complete` is
  byte-identical to the pre-change push (verified against `HEAD~1`); JSDoc gained `successor?`. Both
  changed existing tests are correct under the code. Runner change is EXPLAIN-map-only. Registers
  unchanged (guard-inventory 40, no census bump).
- **Bypass skeptic → HOLE-CLOSED.** Imported `evaluateFindingOwnership` into a throwaway harness (no
  repo file touched) and drove every attack against a shipped owner with valid prose: self-reference →
  `successor_is_self`; another shipped id → `successor_already_complete`; off-disk id →
  `successor_not_on_disk`; omitted → `successor_missing`; and every coercion dodge (`"  "`, `""`, `0`,
  `true`, `null`, `{}`, `["X"]`, trailing-space) → `successor_missing`/`successor_not_on_disk`.
  Skipping the prose via a good successor still fails `owner_ticket_already_complete` (the arms are
  independent). The branch cannot be made not-to-run while open+owned-by-shipped (`tickets` and
  `completed` share one disk scan; a wrong id trips `owner_ticket_missing` first; flipping Status reds
  `stale_declaration`). The only pass is the acknowledged **existence-only** case (an on-disk,
  unshipped, unrelated ticket), which the skeptic judged **adequately documented** in both the guard
  comment and the finding resolution — not a defect.
- **Completeness critic → COMPLETE.** Mapped each of the five kinds to an isolating killing test, then
  **executed** each pure DELETE mutation against a system-temp copy (repo file never mutated,
  `restoredIdentical: true`): every arm's deletion reds ≥1 test, 0 survivors. DBR-001 graph-consistent
  (file + `#### DBR-001` node + `Depends on: REL-003`), coverage/dependency/foundation checkers all
  exit 0, invisible to the REL gate. Resolution consistent (Status `resolved`, JSON key gone, E11-F002
  gained the successor and kept owned/REL-003/prose).

The pass mirrors the design's own 2-agent round-2 review, but targets the IMPLEMENTATION per the
go-book §2.2 step 4 (attack your own work). It was NOT delegated to any plan-writing or auto-fixing
skill.

## Limits / what this does NOT do

- It does **not** verify the successor is the semantically correct inheritor (existence-only, C5).
- It does **not** resolve E11-F002 — the DR restore-entrypoint residual stays open, owned by DBR-001.
- `ci-required` rides the full heavy suite because this PR touches `scripts/*.mjs` +
  `finding-ownership.json` (`code=true`); the guard itself is a pure-logic check, green at rest.
