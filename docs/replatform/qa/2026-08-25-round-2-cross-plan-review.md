# Round-2 plan review — the cross-plan pass, 2026-08-25

**What ran.** Three independent reviewers, one per revised Sprint 1-3 plan; eleven skeptics, each
told to REFUTE one BLOCKING/HIGH finding and to default to "refuted" if it could not be reproduced
from source; one completeness critic asking only what no single-plan reviewer could see.

**Result.** 20 findings raised, 11 adversarially tested, **7 survived**. The critic found three
cross-plan defects, none visible from inside any one plan, and **one of them invalidated the sprint
sequence itself.**

---

## The finding that changed the plan of record

After Sprints 1, 2 and 3 shipped exactly as written, **the renewal route Sprint 1 exists to build
would have had zero callers.**

Sprint 3's composition wires `SessionStoreDeps.renew` to `Enroller.renew` — the enrolment *code
replay*, whose own module header says there is no dedicated renew route and that it only succeeds
while the 10-minute code route is live. So the worker would still have lost authority at the
ten-minute boundary, while a fully-tested device-proof renewal endpoint sat on the server unused.

That is this programme's signature failure mode — a capability that is built, tested, documented,
and called by nothing — reproduced *inside the sprint sequence written to fix it*. Neither
single-plan reviewer could see it: WRK-010 is correct about what it builds, WRK-008 slice 2b is
correct about what it composes, and the defect lives only in the seam.

**Consequence:** the go-book gains **Sprint 2.5 — WRK-010 slice 2**, and Sprint 1 no longer closes
E4-F007. A second, related seam defect came with it: `SessionStore.ensureFresh` refreshes only once
a session is *already expired*, and the renewal route refuses an expired session by construction —
so the thunk would have fired exactly when the credential it must present was dead.

---

## What survived refutation

| # | Plan | Severity | Finding |
|---|---|---|---|
| 1 | WRK-010 | BLOCKING | Flipping E4-F007 to `resolved` while keeping its manifest entry is a `stale_declaration` — the always-on `policy` job goes red on the ticket's last step. And substantively the finding is not resolved at all (above). |
| 2 | WRK-010 | HIGH | The structural dormancy clause cannot be written: the helper it reuses only ever scans `app.ts`, and the renewal route lives in a file with no flag block. It fails spuriously either way, and would be "fixed" by weakening it. |
| 3 | WRK-010 | HIGH | All six "documented equivalent mutants" are unwritable — the authority row never escapes the verifier, so there is no row value to substitute. A documented equivalent that does not compile is not an equivalent. |
| 4 | WRK-008/2b | HIGH | §2's gate table marks the desktop as gated on the outbox gate, then counts the desktop at two in the sentence below it. One section, two answers. |
| 5 | DEP-010 | HIGH | Every citation of go-book decision D-3 points at the wrong line — five occurrences. Cause: the go-book was edited after the plan was written. Fixed as a class: cite living documents by section and id, never by line. |
| 6 | DEP-010 | HIGH | The credential-removal fix does not remove the credential from the path that actually reads it (narrowed in scope by its refuter, not killed). |
| 7 | DEP-010 | HIGH | E4-F011 names DEP-010 as its owner and DEP-010 never mentions it. `finding-ownership.mjs` only checks the `ownerStillOpen` string is non-empty, so a stale one fails nothing. |

## What was refuted, and why that matters

Four findings died under scrutiny: a new-finding-undeclared claim that was true mechanically but
whose consequence could not occur as the plan is written; a guard said to enumerate a call site
that "does not syntactically exist", where the plan named the alias three times; a shared event-sink
claim whose code facts all reproduced but whose consequence did not; and a mutation said to be
unfailable, which the plan never prescribed alone.

**Three of the four were strawman readings of a plan that already handled the case.** That ratio is
the reason the refutation stage exists: without it, four confident, well-cited, wrong findings would
have been "fixed" into the plans.

---

## Other cross-plan defects, now scheduled

- **Sprint 2 falsifies four Sprint 3 assertions on arrival** — including a guard that would land in
  the always-on `policy` job and be red on every PR. Slice 2b was written against the pre-DEP-010
  tree and the go-book runs it after.
- **DEP-010's primary inertness proof expires at Sprint 3.** It is provable exactly once. After
  Sprint 3 the shipped desktop's inertness rests on environment variables and zero structural gates.
- **Two findings owned by plans that never mention them** (E4-F011 → DEP-010, E4-F008 → WRK-008),
  each carrying an `ownerStillOpen` string no guard can falsify.
- **The go-book itself carried a false claim** — "zero unowned findings" — written an hour before
  E4-F010 was filed as unowned, in a section headed *do not relitigate*. Corrected in place, with
  the correction left visible rather than edited away.

---

## Method note

The refutation stage changed four verdicts and the completeness critic changed the sprint sequence.
Neither is reachable by reviewing plans one at a time, and neither is reachable by a reviewer who
is rewarded for finding things. The critic was given exactly one instruction the reviewers were
not: *do not re-review the plans — ask what is missing across the set.*
