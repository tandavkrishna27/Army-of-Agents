# E4-F013 — Close the `ownerStillOpen`-is-free-text hole: a shipped owner must name a checkable successor

**Epic:** E4 · **Kind:** guard hardening (the programme's own finding-ownership backstop)
**Owns:** finding **E4-F013** (`epics/E4-worker-daemon/findings.md`) — resolved by this ticket
**Depends on:** nothing (pure-logic guard + its manifest); `worker-protocol` untouched (FROZEN)
**Status:** design only — no implementation in this document

This design is the machine-checkable version of E4-F013's own **"Proposed fix, checkable"**. It
does not relitigate the finding; it turns its one sentence into an exact guard change, a bounded
manifest migration, a fail-first test plan with a deleted-guard mutation, and a self-resolution.

---

## ★★ Review round 2 (orchestrator) — corrections to fold in at execution

A 2-agent review verified the design's spine (VERIFIED: reds only E11-F002 at rest; `DBR-001` is a
graph-consistent, release-gate-invisible id; the M1 `tickets.has(successor)` mutation has teeth;
E4-F013 self-resolution + the `- **Depends on:** REL-003.` bullet form are correct) and that **DBR-001
is a genuine inheritor, not a fig-leaf** (real two-part residual: the missing `aoa db:restore`
entrypoint + the owed live DR rehearsal). But it found a **merge-blocker** and left the guard
**self-bypassable**. Apply all of these:

- **C1 (HIGH — MERGE-BLOCKER — the design's §1 is WRONG here).** The new `successor_missing` branch
  **breaks two EXISTING tests** in `scripts/lib/__tests__/finding-ownership.test.mjs`, which run in the
  `policy` job — so the design as written ships a RED suite. (a) `:40-53` asserts
  `kinds === ["owner_ticket_already_complete"]` for a completed-owner entry with **no successor**; the
  new rule adds `successor_missing` → two kinds → fails. (b) `:67-70` asserts `.ok === true` for a
  completed-owner-with-prose-**no-successor** entry; the new rule reds it → fails. Both fixtures MUST
  be updated (add a valid on-disk `successor`; the `:40-53` case expects both kinds or gains a successor
  to drop to one). Add these to §5 files-touched + §4 acceptance. §1's "the calibration test keeps
  passing" is false — delete that claim.
- **C2 (HIGH — the anti-vacuity guard is self-bypassable).** `successor === entry.ticket` is NOT
  caught: a shipped owner naming **itself** as successor passes `hasReason` + `tickets.has` — re-opening
  the *exact* hole E4-F013 exists to close (an author could write E11-F002's `successor: "REL-003"`, the
  shipped owner itself, + prose and pass everything). Add a `successor_is_self` check
  (`entry.successor === entry.ticket`), mirroring `dependency-graph.mjs`'s existing `dep === id`
  self-check, with its own RED test.
- **C3 (MED — free strengthening the guard already has the data for).** A **shipped successor**
  (`completed.has(entry.successor)`) is the same hole one level down. Add a `successor_already_complete`
  check (`completed` is already in scope), with its own RED test.
- **C4 (MED — the "reds only E11-F002" scope is FRAGILE).** Add an execution-start STOP: re-verify no
  OTHER owned entry's ticket has gained a `*-result.md` since snapshot `c208acfd7` — WRK-012/013/DEP-011
  are filed-but-unshipped and could ship; any that has now ALSO reds `successor_missing` at rest and
  must get its own successor filed in the same landing, or STOP. Acceptance A7 (0-error at rest)
  silently depends on this.
- **C5 (LOW — honesty).** State in one plain sentence that the successor check is **existence-only**: it
  forces a real node+dep skeleton (via the graph guards) but cannot verify the named ticket is the
  *correct* inheritor — that stays author/review responsibility.
- **C6 (LOW).** The mutation-table M3 attribution is imprecise (post-change the "calibration test" reds
  via `successor_missing` regardless); M3 keeps teeth via new Test 5 — fix the cited detector.

**The full guard chain (when `owned && completed.has(ticket)`), each arm a RED test + a DELETE mutant:**
`!hasReason(ownerStillOpen)`→`owner_ticket_already_complete`; `!hasReason(successor)`→`successor_missing`;
`successor === ticket`→`successor_is_self`; `!tickets.has(successor)`→`successor_not_on_disk`;
`completed.has(successor)`→`successor_already_complete`.

---

## §0 — Verified state (re-verify at execution start; lines rot, cite by id thereafter)

Snapshot taken at `docs/replatform-program` tip `c208acfd7`. Path:line is a starting coordinate,
not a citation — the go-book rule is to cite living docs by section/id, which the rest of this doc does.

| # | Fact | Where (snapshot) |
|---|------|------------------|
| V1 | **The hole.** When the owning ticket has shipped (`completed.has(entry.ticket)`), the only escape from `owner_ticket_already_complete` is that `ownerStillOpen` is a non-empty string. Non-emptiness is the entire test — any prose passes. | `scripts/lib/finding-ownership.mjs:118-120` |
| V2 | **The calibration that must survive.** "has a result doc ≠ finished"; the rule must NOT become "you may not name a shipped ticket" — it must become "if you name one, say IN WRITING what part is still open." | `finding-ownership.mjs:110-117` (comment) |
| V3 | **The reusable existence check.** `owner_ticket_missing` is `!tickets.has(entry.ticket)`; `tickets = new Set(findTicketIds(ROOT))`. The successor check reuses this exact set/notion. | `finding-ownership.mjs:102-104`; runner `check-finding-ownership.mjs:35-49,89` |
| V4 | **`hasReason`** = "string, non-empty after trim". The successor presence check reuses it. | `finding-ownership.mjs:53-55` |
| V5 | **Only one owned entry has a SHIPPED owner.** `E11-F002 → REL-003`, and `REL-003-result.md` exists. The other three owned entries point at on-disk **stubs with no result doc**: `E4-F008 → WRK-012`, `E4-F009 → WRK-013`, `E6-F003 → DEP-011`. | `scripts/finding-ownership.json`; `find … -name '*-result.md'` |
| V6 | `findCompletedTicketIds` = ticket ids with a `*-result.md` file: `^([A-Z]+-\d+).*-result\.md$`. `REL-003` matches; `WRK-012/WRK-013/DEP-011` do **not** (design docs only). | `check-finding-ownership.mjs:53-67` |
| V7 | **The test suite exists and is extendable.** `scripts/lib/__tests__/finding-ownership.test.mjs` already carries the completed-owner + calibration cases; it is already declared in the census manifest. | test file; `scripts/test-execution-census.json:203` |
| V8 | **The guard is already registered.** `check-finding-ownership.mjs` is in `scripts/guard-inventory.json`. No guard-inventory change. | `scripts/guard-inventory.json:68` |
| V9 | **This design-doc slug is graph-inert.** `expandTicketIdsFromFilename("E4-F013-ownership-successor-design.md") → []` (E4 has one leading letter; `F013` is not a `\d{3}` triplet). No `program-design.md` node needed for THIS file. | verified via `ticket-graph-coverage.mjs`; `parseFindings`/`findTicketIds` also see no ticket id in it |
| V10 | **The release-test gate keys ONLY on `REL-…`.** Owner match `^REL-\d+$`; token `/REL-\d+/g`; written-set `^(REL-\d+)-design\.md$` under `E11-hardening-release/tickets`. A non-REL id is invisible to it. | `check-distributed-execution-foundation.mjs:189-192,758-826` |
| V11 | **Stub precedent (WRK-012 / WRK-013 / DEP-011):** each is a `<ID>-design.md` ticket file + a `#### <ID> — … (scope)` node with a `**Depends on:**` line, **no result doc**; none appears in a `CM-0NN` crosswalk row, and all are green at rest. | `program-design.md:650,656,844`; crosswalk grep empty |
| V12 | **REL-003 is a real graph node** (`#### REL-003 — Disaster recovery and migration rehearsal (M)`), so a stub may depend on it. | `program-design.md:1128` |

**Parser reach of an id — the four regexes a stub id must satisfy consistently:**

| Consumer | Regex | Purpose |
|----------|-------|---------|
| `findTicketIds` (finding-ownership) | filename `^([A-Z]+-\d+)` | makes `tickets.has(successor)` true |
| `expandTicketIdsFromFilename` (graph-coverage, file side) | `^([A-Z]{2,5})-(\d{3})` | ticket FILE becomes a tracked id → needs a node |
| `parseAuthorityNodes` (graph-coverage, node side) | `^####\s+([A-Z]{2,5}-\d{3})\s` | the node that satisfies coverage |
| `TICKET_HEADING` (dependency-graph) | `^####\s+([A-Z]{3,4}-\d{3})\s` | node picked up → **requires a `Depends on:` line** |

The tightest constraint is dependency-graph's **3–4-letter** prefix. A **3-letter prefix + 3-digit
number** satisfies all four at once and matches the WRK/DEP precedent.

**STOP-condition check (from the ticket):** the fix reds **only E11-F002** at rest (V5+V6), and a
non-REL 3-letter/3-digit stub id avoids the release gate cleanly (V10). Neither STOP condition
fires; this design proceeds.

---

## §1 — The guard change (`finding-ownership.mjs`)

### Decision

Keep `ownerStillOpen` as the **human explanation** (which part of the shipped ticket is still open)
and **add `successor` as the checkable pointer** (which ticket inherits the residual, verified to
exist on disk). Both are required only in the state the hole lives in: `entry.status === "owned"`
**and** `completed.has(entry.ticket)`. This is the faithful reading of both E4-F013's proposed fix
("require a `successor` field naming a ticket that exists on disk") and the V2 calibration ("say in
writing what part is still open") — the prose says *why it survives*, the pointer says *who inherits
it*, and neither substitutes for the other.

### Exact edit — replace the single-line check at `:118-120`

Current:

```js
if (completed.has(entry.ticket) && !hasReason(entry.ownerStillOpen)) {
  problems.push({ kind: "owner_ticket_already_complete", finding: finding.id, detail: entry.ticket });
}
```

New (each condition checked on its own so the report names which half is missing):

```js
// The owner has SHIPPED (has a result doc). "Shipped" is not "finished" (V2): a finding may
// legitimately survive its owner. To say so on the record, BOTH must hold —
//   (1) ownerStillOpen — PROSE: which part of the shipped ticket is still open. Nobody can
//       write it honestly when the answer is "nothing". (unchanged behaviour + kind)
//   (2) successor      — a CHECKABLE POINTER to the ticket that inherits the residual, which
//       must EXIST ON DISK: the same `tickets.has(...)` test owner_ticket_missing runs on
//       `ticket`. Without it, "it survives its owner" names no real inheritor and a
//       shipped-and-forgotten finding hides behind any prose.
if (completed.has(entry.ticket)) {
  if (!hasReason(entry.ownerStillOpen)) {
    problems.push({ kind: "owner_ticket_already_complete", finding: finding.id, detail: entry.ticket });
  }
  if (!hasReason(entry.successor)) {
    problems.push({ kind: "successor_missing", finding: finding.id, detail: entry.ticket });
  } else if (!tickets.has(entry.successor)) {
    problems.push({ kind: "successor_not_on_disk", finding: finding.id, detail: entry.successor });
  }
}
```

Notes on composition:

- **`owner_ticket_already_complete` is preserved verbatim** — same kind, same detail, same trigger
  (missing prose). Existing test *"naming a part-shipped ticket is allowed ONLY by writing what is
  still open"* keeps passing. The calibration is untouched.
- **Two new kinds**, mirroring the two failure shapes the existing ticket-side already distinguishes:
  `successor_missing` (the pointer is absent — analogue of "no ticket named") and
  `successor_not_on_disk` (the pointer is a false claim of inheritance — analogue of
  `owner_ticket_missing`).
- **The existence check reuses `tickets`** (V3) — the identical set `owner_ticket_missing` uses, so
  the two guards cannot disagree about what "a ticket exists" means.
- **Scope is narrow by construction.** Nothing changes for `unowned`/`accepted` entries (the whole
  `owned` block is skipped) or for owned entries whose ticket has **not** shipped
  (`completed.has(...)` is false) — so the three repointed stubs (V5) are structurally untouched.
- The block falls through to the existing `continue` at `:121`; an entry may now accrue two
  problems (missing prose **and** missing successor). That is correct — the report should name both.
  Tests isolate each failure so a `deepEqual(kinds, …)` assertion stays single-kind.
- JSDoc: extend the `declared` param type with `successor?: string`.

### Runner change (`check-finding-ownership.mjs`) — EXPLAIN map only

Add two lines to the `EXPLAIN` object (used only to render a failing run's message; no logic, no
new inputs — `tickets`/`completedTicketIds` are already passed):

```js
successor_missing: "owned by a ticket that has SHIPPED but names no `successor` — say which ticket inherits the residual",
successor_not_on_disk: "the named `successor` has no file on disk — a false claim of inheritance",
```

No other runner change. `guard-inventory.json` unchanged (V8). No new `*.test.mjs` (V7).

---

## §2 — Migrate E11-F002, and file its successor stub `DBR-001`

### Why exactly one entry moves

By V5+V6, `E11-F002 → REL-003` is the sole owned entry whose ticket has a result doc, so it is the
**only** entry the new `completed.has(entry.ticket)` branch reaches with force. Today its manifest
entry has `ownerStillOpen` (prose about the owed restore leg) but **no `successor`** → under §1 it
would red `successor_missing` at rest. The migration adds the pointer and files the ticket it points
at. Every other entry is unaffected:

| Entry | Owner | Owner shipped? | New rule reaches it? | At-rest verdict |
|-------|-------|----------------|----------------------|-----------------|
| E4-F008 | WRK-012 | no (V6) | no — `completed` false | green (unchanged) |
| E4-F009 | WRK-013 | no | no | green (unchanged) |
| E6-F003 | DEP-011 | no | no | green (unchanged) |
| **E11-F002** | **REL-003** | **yes** | **yes** | **red until `successor` added → green after** |
| E4-F013, E4-F014, E4-F015, E11-F001, E10-F001 | (unowned) | — | no (`owned` block skipped) | green (unchanged) |
| E6-F005, E6-F006, E6-F007, E4-F016 | (accepted) | — | no | green (unchanged) |

### The residual E11-F002 carries

REL-003 shipped the DR verification core + the operator runbook, but E11-F002 stays **open** because
the **database-restore operator leg is owed**: `runDatabaseRestore` (`packages/db/src/backup-lib.ts`)
has zero production/CLI callers, is not barrel-exported, and no `aoa db:restore` command exists. The
finding resolves only when a real restore entrypoint lands **and** a live staging rehearsal exercises
it. That residual is a concrete, buildable ticket — the natural successor.

### The successor stub: `DBR-001`

- **Id:** `DBR-001` — **D**ata**B**ase **R**estore, ticket 001. Three letters + three digits.
- **File:** `docs/replatform/epics/E11-hardening-release/tickets/DBR-001-design.md` — a scoping stub
  in the WRK-012/DEP-011 shape (V11): why it exists, what it must build (the `aoa db:restore`
  entrypoint + the live rehearsal that exercises it), the precondition, **no result doc, no design
  steps** (its full design is written at the sprint that builds it, per the go-book "write the plan
  at sprint start" rule).
- **Program node:** add under E11 in `docs/replatform/program-design.md`:

  ```
  #### DBR-001 — Operator database-restore entrypoint + live DR-restore rehearsal (E11-F002 successor) (scope)

  - **Depends on:** REL-003.
  - **Outcome:** Land a real operator restore entrypoint (an `aoa db:restore` command or an
    exercised harness wrapper over `runDatabaseRestore`/`pg_restore`) and exercise it in a live
    staging DR rehearsal. REL-003 shipped the DR verification core + runbook but `runDatabaseRestore`
    has ZERO production/CLI callers and is not barrel-exported, so the restore leg has no operator
    invocation. Filed at REL-003 completion so E11-F002 is owned by a ticket that exists and has not
    shipped (finding E4-F013), not left with a shipped owner and only prose. Owns finding E11-F002.
  - **Acceptance:** Written at sprint start; no result doc until the entrypoint lands and the live
    rehearsal exercises it. E11-F002 stays open (MED) until then.
  ```

- **Manifest edit:** add `"successor": "DBR-001"` to the E11-F002 entry. Keep its `status: "owned"`,
  `ticket: "REL-003"`, `ownerStillOpen` (the prose), and `reason` as they are. **E11-F002 stays
  `open`** — this migration does not resolve it; it only makes its survival-past-a-shipped-owner
  checkable.

### Non-REL naming rationale + release-gate-invisibility proof

The residual belongs to E11, whose ticket prefix is `REL`. A `REL-00X` id would collide with the
just-shipped **REL-FOUNDATION-GATE** release-test gate. `DBR-001` sidesteps every REL-keyed path:

| Release-gate mechanism (V10) | Sees `DBR-001`? | Why |
|------------------------------|-----------------|-----|
| `namedReleaseTickets` owner match `^REL-\d+$` | no | `DBR-001` is not `REL-…` |
| `REL_TOKEN_RE` `/REL-\d+/g` in `releaseTest` free text | no | not referenced there, and would not match if it were |
| `parseWrittenRelTickets` `^(REL-\d+)-design\.md$` (E11 tickets dir) | no | `DBR-001-design.md` fails the anchored `REL-` pattern even though it sits in that dir |
| deferral manifest `distributed-execution-release-tests.json` | no | not added there; no crossing names it |

The **only** release-gate function that observes `DBR-001` is `parseProgramTicketIds`
(`^####\s+([A-Z][A-Z0-9]*-\d+)`), which adds it to the **allow-list of valid owner-ticket ids** that
`threat-controls.json` crossings *may* name. That is a widening, not a constraint: it permits
`DBR-001` as an owner id but requires nothing to name it. No crossing is edited, so the gate stays
0-error. **Net effect on the release gate: none.**

### Graph / dependency consistency of `DBR-001` (all four regexes)

- `findTicketIds` sees `DBR-001` (filename `^([A-Z]+-\d+)`) → `tickets.has("DBR-001")` true → E11-F002's
  successor check passes.
- `expandTicketIdsFromFilename("DBR-001-design.md") → ["DBR-001"]` (verified) → the file is a tracked
  id → graph-coverage requires a node → **the `#### DBR-001` node supplies it** (`parseAuthorityNodes`
  `[A-Z]{2,5}-\d{3}` matches). File + node are consistent.
- `dependency-graph` `TICKET_HEADING` (`[A-Z]{3,4}-\d{3}`) picks up the node → **requires a
  `Depends on:` line** → `**Depends on:** REL-003.` supplied; `REL-003` is a real node (V12), so no
  `unknown`/`self`/cycle problem.
- `DBR-001` is **not** completed (no `*-result.md`), so it never itself trips the completed-owner rule.

---

## §3 — Fail-first plan + the deleted-guard mutation

Extend `scripts/lib/__tests__/finding-ownership.test.mjs` (no new file → no census bump, V7).
**Positive control first**, then the RED cases, then the mutation.

### Fixtures

`OPEN_MED = { id: "E11-F002", status: "open", severity: "MED", title: "restore has no operator entrypoint" }`.
Ticket sets model V5/V6: `ticketIds: ["REL-003", "DBR-001"]`, `completedTicketIds: ["REL-003"]`
(so `REL-003` shipped, `DBR-001` exists-but-unshipped).

### Tests to add (in order)

1. **Positive control — the happy path exists BEFORE any refusal is asserted.** Owned by shipped
   `REL-003`, `ownerStillOpen` present, `successor: "DBR-001"` on disk → `r.ok === true`. (This is
   E11-F002 post-migration. Guards against E1-F008: a refusal test passing for an unrelated reason.)
2. **RED — `successor_missing`.** Owned by shipped `REL-003`, `ownerStillOpen` present, **no
   `successor`** → `r.ok === false`, `kinds(r)` includes `"successor_missing"`, detail `"REL-003"`.
   (This is E11-F002 *before* migration — proves the at-rest red the migration cures.)
3. **RED — `successor_not_on_disk`.** Owned by shipped `REL-003`, `ownerStillOpen` present,
   `successor: "DBR-999"` **absent from `ticketIds`** → `r.ok === false`, `kinds(r)` is
   `["successor_not_on_disk"]`, detail `"DBR-999"`. *(This is the case the mutation neutralises.)*
4. **Unaffected — non-shipped owner needs no successor.** Owned by `DBR-001` which exists but is
   **not** in `completedTicketIds`, no `successor`, no `ownerStillOpen` → `r.ok === true`. (Proves
   the three repointed stubs stay green — the whole point of scoping to `completed`.)
5. **Calibration preserved.** Owned by shipped `REL-003`, `successor: "DBR-001"` on disk, but
   `ownerStillOpen` **missing** → `kinds(r)` includes `"owner_ticket_already_complete"`. (The prose
   requirement still bites even when the pointer is valid.)

### Mutation table (DELETE the guard; never rewrite it — positive control first)

| # | Mutation applied to `finding-ownership.mjs` | Test that must go RED | Why it proves load-bearing |
|---|---------------------------------------------|------------------------|-----------------------------|
| M1 (**required**) | DELETE the `else if (!tickets.has(entry.successor)) { … successor_not_on_disk … }` existence check | Test 3 | Without it, an entry naming an **off-disk** successor passes → the finding's exact hole reopens one field over. Test 3 asserts `r.ok === false`; the mutant makes it `true`. |
| M2 | DELETE the `if (!hasReason(entry.successor)) { … successor_missing … }` presence check | Test 2 | Without it, a shipped-and-forgotten finding with **no** successor passes on prose alone — the original E4-F013 hole. Test 2 flips to green-when-red. |
| M3 (regression) | DELETE the retained `if (!hasReason(entry.ownerStillOpen)) { … owner_ticket_already_complete … }` | existing calibration test + Test 5 | Confirms the preserved calibration branch is still independently load-bearing. |

M1 is the mutation E4-F013 explicitly requires ("DELETE the successor-exists check → that bogus
entry passes → the test reds"). Each mutation is a **deletion**, not a rewrite (`return false`-style
equivalents are banned by the go-book).

---

## §4 — Acceptance (every clause → a RED/GREEN test)

| # | Clause | Verifying test | Kind on violation |
|---|--------|----------------|-------------------|
| A1 | An owned finding whose ticket **shipped** and names **no** successor FAILS | Test 2 | `successor_missing` |
| A2 | An owned finding whose ticket **shipped** and names an **off-disk** successor FAILS | Test 3 | `successor_not_on_disk` |
| A3 | An owned finding whose ticket **shipped**, with prose **and** an on-disk successor, PASSES | Test 1 (positive control) | — |
| A4 | An owned finding whose ticket **has not shipped** needs no successor and PASSES | Test 4 | — |
| A5 | The V2 calibration survives: shipped owner + valid successor but **missing prose** still FAILS | Test 5 + existing "part-shipped" test | `owner_ticket_already_complete` |
| A6 | The successor existence check is load-bearing (deleting it reopens the hole) | Mutation M1 → Test 3 reds | — |
| A7 | The manifest is **0-error at rest** after migration (E11-F002 green; three stubs green; unowned/accepted green) | `node scripts/check-finding-ownership.mjs` on the tree | — |
| A8 | E4-F013 is resolved without leaving a stale manifest key | `check-finding-ownership` (no `stale_declaration`) after §5 | — |
| A9 | `DBR-001` file+node consistent; graph-coverage + dependency-graph green | `check-ticket-graph-coverage`, `check-dependency-graph` | — |
| A10 | Release gate unaffected | `check-distributed-execution-foundation` still 0-error | — |

---

## §5 — Files touched (all in ONE landing commit)

| File | Change |
|------|--------|
| `scripts/lib/finding-ownership.mjs` | §1 guard change (replace `:118-120` block; extend `declared` JSDoc with `successor?`) |
| `scripts/check-finding-ownership.mjs` | Add `successor_missing` + `successor_not_on_disk` to the `EXPLAIN` map |
| `scripts/lib/__tests__/finding-ownership.test.mjs` | Add tests 1–5 (positive control first); the file is already census-declared |
| `scripts/finding-ownership.json` | (a) add `"successor": "DBR-001"` to **E11-F002**; (b) **DELETE the `E4-F013` key** |
| `docs/replatform/epics/E4-worker-daemon/findings.md` | Flip **E4-F013** `**Status:**` `open` → `resolved` |
| `docs/replatform/epics/E11-hardening-release/tickets/DBR-001-design.md` | **NEW** successor stub (no result doc) |
| `docs/replatform/program-design.md` | **NEW** `#### DBR-001 — … (scope)` node with `**Depends on:** REL-003.` |
| `docs/replatform/epics/E4-worker-daemon/tickets/E4-F013-ownership-successor-design.md` | this design doc (graph-inert slug, V9) |

**Resolve = flip status + delete key in the SAME commit (go-book §9 / C4).** Because §1 now makes a
completed-owner entry require a successor, and E4-F013 is *unowned* (not owned by a completed ticket),
E4-F013's own resolution is the standard two-step: its register Status flips to `resolved` (so it is
no longer `open` and needs no declaration) **and** its `finding-ownership.json` key is removed in the
same commit (otherwise `stale_declaration` reds the always-on `policy` job).

### Register interactions (confirmed, no extra moves)

- **No census bump** — tests extend an already-declared file (V7); no new `*.test.mjs`.
- **No guard-inventory change** — `check-finding-ownership.mjs` is already registered (V8); only its
  EXPLAIN map + the pure lib change.
- **Graph-coverage** — the design-doc slug is inert (V9, `→ []`); the stub `DBR-001-design.md` is
  tracked (`→ ["DBR-001"]`) and its `#### DBR-001` node satisfies coverage. File and node are
  consistent because `DBR-001` is a numeric-triplet id (chosen deliberately, §2).
- **Dependency-graph** — `#### DBR-001` (3-letter prefix) is picked up and its `Depends on: REL-003`
  resolves to a real node (V12); no dangling edge, self-edge, or cycle.
- **Release-test gate** — `DBR-001` is invisible to every REL-keyed path (V10 / §2 table); the only
  observer is the owner-id allow-list, which is widened harmlessly.

---

## §6 — Risks

| Risk | Assessment |
|------|------------|
| **The fix reds more than E11-F002 at rest.** | It does not. The new branch runs only for `owned` entries whose ticket is in `completedTicketIds`; V5/V6 show that is exactly `{E11-F002}`. The §2 table enumerates all fourteen entries and confirms the other thirteen are structurally out of reach. If a future entry points at a *shipped* ticket, the guard will (correctly) demand a successor — that is the feature, not a regression. |
| **The stub id collides with the release gate.** | Ruled out. `DBR-001` matches no `REL-` pattern (V10); the release gate's sole observer of it is the harmless owner-id allow-list. If the id were ever changed to a `REL-…` form, `parseWrittenRelTickets` would begin counting `REL-00X-design.md` as a *written* release-test ticket and could silently satisfy a Critical/High crossing's release-test requirement — precisely why the non-REL id is mandatory, not cosmetic. |
| **Breaking the three repointed entries (WRK-012/WRK-013/DEP-011).** | Their owners have **no result doc** (V6), so `completed.has(...)` is false and the new block never runs for them. Test 4 pins this. They also do not (and must not) gain a `successor` field. |
| **New epic prefix `DBR` upsets a prefix→epic registry.** | No such registry guard exists (searched). The only prefix-length constraint is dependency-graph's 3–4 letters; `DBR` (3) satisfies it and all three other regexes simultaneously (§0 table). |
| **The stub node needs a crosswalk (`CM-0NN`) row.** | It does not — WRK-012/WRK-013/DEP-011 carry no crosswalk row and are green (V11). A leaf `(scope)` node with a `Depends on:` line is sufficient for both graph guards. |
| **Multiple problems per entry confuse a `deepEqual(kinds, …)`.** | The fall-through means a shipped owner missing *both* prose and successor emits two kinds. Tests isolate each failure (Test 3 supplies prose so only `successor_not_on_disk` fires; Test 2 supplies prose so only `successor_missing` fires), keeping the assertions single-kind. The production manifest never hits the two-problem state because E11-F002 already has prose. |

---

## §7 — Rollback

The change is one commit, pure docs + `scripts/` (no schema, no migration, no `worker-protocol` —
FROZEN). `git revert` of that commit restores a fully consistent tree in a single step:

- The guard reverts to the `:118-120` one-liner, which does **not** require a `successor`, so
  E11-F002 (whose `successor` field would also be reverted) is green again under the old rule.
- E4-F013's register Status returns to `open` and its `finding-ownership.json` key returns — again
  consistent, because an `open` finding *must* have a declaration.
- The `DBR-001` ticket file and its `#### DBR-001` node are removed together; nothing else references
  `DBR-001` (it is a fresh leaf), so graph-coverage and dependency-graph stay green post-revert.
- The two new EXPLAIN keys and the five tests revert with the guard they describe.

No partial-revert hazard exists: every added artifact (guard branch, successor field, stub file,
stub node, resolution) is mutually self-consistent both present-together and absent-together.
