# TRACK-001 — Design: the dependency guard cannot see the work it governs

**Status:** DESIGN. **Start SHA:** the commit that adds this file.
**Motivated by:** [`WAVE-4-RESEQUENCE.md`](../../../WAVE-4-RESEQUENCE.md) §1.2 and §5 step 0.

---

## 1. The defect, measured

`check-dependency-graph.mjs` parses exactly one authority, `docs/replatform/program-design.md`,
for `#### TICKET-ID` headings and their `**Depends on:**` lines. Measured against the tree:

| | Count |
|---|---|
| Graph nodes (`#### ID` headings) in the authority | 95 |
| Distinct ticket IDs covered by ticket FILES on disk | 81 |
| **Ticket files whose ID appears NOWHERE in the authority** | **3** |

The three are `DAT-008`, `WRK-008`, `WRK-009` — **zero mentions each**, not merely missing
headings. All three have landed code. The guard has been passing green while structurally unable
to see them.

**This is my own guard exhibiting the failure class I built it to catch**, and it is a class the
standing `check-guard-inventory.mjs` cannot detect: that guard verifies a script is *invoked*.
This one is invoked, runs, and compares against a document that has drifted. **Stale authority is
a distinct failure mode from no caller.**

## ★ 2. Two corrections to the numbers this fix was originally scoped from

Recorded because the fix would have been mis-shaped by either.

**2.1 — "21 prose-only tickets" was wrong; it is 19, and it is NOT a defect.** My first extraction
took only the leading ID from each filename, so the COMBINED ticket file
`MIG-005-006-007-shadow-*.md` registered as `MIG-005` alone and made `MIG-006`/`MIG-007` look
file-less. Correct extraction must expand `PREFIX-NNN-NNN-NNN` into every ID it names.

More importantly: a ticket named in the authority with no file yet **is the backlog**, not drift.
`SVC-001..007` (E9), `BRW-003..006`, `REL-001/002/003/005` are planned, unbuilt work. Treating
that direction as a failure would make the guard cry wolf on every planned ticket and guarantee it
gets disabled.

**2.2 — The asymmetry is the whole design.** Only ONE direction is dangerous:

- **file exists, authority does not know it** → the graph is missing a node, so every
  reachability conclusion drawn from it is unsound. **This is the failure.**
- **authority names it, no file yet** → backlog. **Not a failure.**

A symmetric check would have been easier to write and would have been wrong.

## 3. The fix — a detector first, nodes second, deliberately in that order

**Part 1 — `check-ticket-graph-coverage.mjs` (new).** Walk `docs/replatform/epics/*/tickets/`,
expand each filename into the ticket IDs it names, and FAIL on any ID with no `#### ID` heading in
`program-design.md`. Cheap, mechanical, and it converts silent drift into a loud failure. Declared
in `scripts/guard-inventory.json` and wired into the `policy` job.

**Part 2 — add the three missing nodes.** Deferred to *after* Part 1 is proven failing, because
the edges require judgement and getting them wrong is worse than leaving them absent:

> **`DAT-008` owns inherited deferral #1.** The load-bearing check in `dependency-graph.mjs` is
> `undominatedCrosswalkRows`, and `crosswalk-coverage.json` carries a declared **open_gap** for
> row `CM-013`. Adding `DAT-008` with edges to `MIG-005/006/007` could make that row *dominated*,
> which the checker would then report as a **STALE** exception — i.e. the graph would assert the
> debt is closed. **DAT-008 landed slices 1-4 only; slices 5/6/7 are deferred.** So that assertion
> would be FALSE, and it would be false in the specific way this programme keeps being bitten by:
> a document claiming an ownership that does not hold.

Therefore Part 2 adds nodes with `Depends on:` lines reflecting only what is *actually* true, and
whatever the crosswalk check then says is **reported, not engineered**. If CM-013 goes stale, that
is a finding for the Integration Gate Owner, not something to make go away by choosing edges.

## 4. Anti-vacuity — the guard must be proven to fail

The failure mode for this exact guard is that it passes because it found nothing to check (a bad
glob, a wrong root, an extraction that yields zero IDs). So:

1. Run it BEFORE Part 2 → must fail naming exactly `DAT-008`, `WRK-008`, `WRK-009`.
2. A unit test with a fixture tree asserts a known-missing ID is reported.
3. A unit test asserts a combined filename expands to all its IDs (the 2.1 defect, pinned).
4. A unit test asserts an authority-only ID is **NOT** reported (the 2.2 asymmetry, pinned) — this
   is the one that stops a future author from "tightening" it into uselessness.

## 5. Out of scope

- **Making the guard read a second authority** (`current-main-crosswalk.md` is already read by
  `check-dependency-graph.mjs`). Not touched.
- **The 19 prose-only tickets.** Backlog, not debt (§2.1).
- **E4-D12-class gaps** — epic-level decision ids referenced by no ticket. `dependency-graph.mjs`
  already states plainly that it does not catch these; this ticket does not change that, and does
  not let a green run imply otherwise.
