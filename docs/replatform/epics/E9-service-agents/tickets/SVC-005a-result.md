# SVC-005a — result

**SVC-005 is PARTLY SHIPPED as SVC-005a. SVC-005 stays OPEN. E9's exit gate is not moved and is
not claimed.**

Terrain and design: `SVC-005a-design.md` (one file — **SVC-005 had zero files on disk**).

---

## 1. The sentence this makes false

> *"SVC-002 reads generation under a row lock and never bumps it; `services.generation` still has no
> writer after this ticket."* — `SVC-002-design.md`

> *"`services.generation` HAS NO WRITER … so no generation rollover can be performed and the fence
> has nothing to refuse."* — the DE-12 row of `distributed-execution-threat-controls.json`, on which
> **E0-F013's founder ruling dropped DE-12's audit conjunct as VACUOUS**.

`services.generation` now has a writer, reached by an org admin over HTTP, and the immutable
definition for the new generation is minted in the same transaction.

---

## 2. ★★★ What is claimed, and what is NOT

**CLAIMED:** *no two generations are **placed** while the older one is un-drained or unwitnessed.*

**NOT CLAIMED:** *no two generations perform external effects simultaneously* — E9's acceptance
clause for SVC-005. A closed fence stops the old worker **writing**, not its **process**, and no
control-plane fact can prove a remote process stopped. E9-F007 §3 already established this for the
same-generation case; **E9-F012** files it for the rollout case. The clause is a conjunction and
**half of it is not it**, so it is left OPEN rather than upgraded.

The rollout route answers **202, not 200**, for exactly this reason: it reports that generation N+1
was minted and a stop was *requested*, never that the old generation stopped.

★ **Why `E9-F012` and not `E9-F010`, recorded so the gap in the sequence is not read as a lost
finding.** This finding was first written as `E9-F010`. `check-register-id-uniqueness` is green on a
single branch by construction and reds only on whichever collides second, so the collision was
found by review rather than by CI. **First-filed keeps the id**: the sibling pull request that had
already taken it was opened at `2026-09-10T11:10:24Z` against this one's `2026-09-10T11:14:29Z`.
Measured rather than assumed, and pinned to the revision measured: at that PR's head `2b890c2d1`,
`docs/replatform/epics/E9-service-agents/findings.md` carries `## E9-F010` **and** `## E9-F011`, so
the next free id was **`E9-F012`** and renumbering to `F011` would have rebuilt the same collision
one number along. Nothing else about that branch is asserted here, and its ids may move; what is
fixed is that this unit's finding no longer claims one of them. Content and ordinal position are
otherwise unchanged — it remains the last section of `findings.md`.

---

## 3. How the property is enforced, in one paragraph

The fence is at **placement**, not at the bump — the bump performs no external effect. Overlap of
two *placed* generations is already structurally impossible
(`service_instances_live_service_uq` permits one live instance, and `listReconcilableServices`
filters on the byte-identical predicate), so a roll yields replace-after-stop by construction. The
hole is **E9-F007**: SVC-003b's deadline condemns a silent instance **by a clock**, the row leaves
the live index, and the worker may still be running. So step **4b** of `reconcileServiceWithinTenant`
refuses a **cross-generation** placement while a previous generation's instance is
terminal-by-assumption and its attempt is non-terminal. It clears when that attempt goes terminal,
because `classifyFence` returns `attempt_terminal` before any other test — a bound the worker cannot
extend, since lease expiry plus `reapExpiredLeases` reaches it without the worker's cooperation.

---

## 3b. ★★★ The P1 external review found, and it was real

**External review of PR #415 found a genuine fail-open in the very clause this ticket is about,
and it is recorded rather than folded in silently.**

The first revision had ONE terminal author, `worker_event`, covering every terminal move the fenced
ingest applied — on the reasoning that an attributed, generation-fenced event is evidence. It is
evidence **of its authority, not of its content**, and the daemon says so in its own header:
`service_instance_lost` is emitted when `inspect` could not describe the sandbox **or when "a full
stop ladder ended with the process still observed `running`"**, with the comment at that site reading
*"what is not established is that the PROCESS stopped, and this is where that distinction is
preserved"*. The fence would therefore have read **the worker's own report that the process survived
cancel and kill** as proof that it stopped, and placed generation N+1 beside it.

**Fixed in the AUTHOR, not the fence** — the fence was right; the author was lying. `worker_event`
became `worker_stopped` (an observed stop; the only witness) and `worker_unconfirmed` (everything
else the ingest terminalizes), derived from the status being written so the default is fail-closed
for any terminal status added later. `recordServiceHealth` was moved to the unconfirmed value for
the same reason.

★ **Why a fully green suite shipped it.** `R-T7` drove `service_instance_stopped` only — the one
event where the collapsed author happens to be correct. `R-T7c` drives `service_instance_lost`
through the same fence, same digest, same decider, with the event as the only difference; it **reds
on the original defect while `R-T7` stays green**. That asymmetry is the finding, and it is the same
shape as SVC-003a's own recorded near-miss (*"the only end-to-end case drove `service_instance_lost`,
the one status reachable from everything"*) — pointed the other way.

**The P2 (no `activity_log` row for a generation roll) is real and is NOT closed here**, for two
measured reasons. First: **neither sibling control on this router writes one either** — SVC-007a's
service *create* and its *desired-state* stop/resume — and SVC-007a's result already declares that
open by name under **DE-01**, so closing one of three would make the gap less visible. ★ That is a
measurement of **this branch**, taken at base `c27feeea8` and again at head, not a claim about any
other branch: `grep -n 'activity_log\|activityLog'` over `server/src/routes/job-control.ts` and
`server/src/services/service-management.ts` returns **comments only, no writer**, at both revisions.
If a sibling ticket lands an audit write on those routes, this sentence goes stale by that landing
and not before. ★★★ **IT WENT STALE EXACTLY THAT WAY, on 2026-09-10, when this branch merged
`origin/docs/replatform-program` carrying SVC-007b (#414, `3065f2869`).** Both sibling controls —
`service.create` and `service.desired_state` — now write an `activity_log` row in their own tenant
transaction, so of the three mutating service routes on this router TWO are audited and the roll is
the one that is not. The reason above therefore no longer holds; what remains is the second reason
plus the rule that a merge resolution does not add behaviour. The roll route now sits squarely in
the unaudited-route class **`E9-F010`** tracks as its still-open half (there alongside job
submission, `drain` and worker `revoke`), and wiring it is FOLLOW-UP, not merge work. Second: E9-F009 §3 measured that **no** repository method in that layer writes
`activity_log` at all, and declined to introduce the convention through its least prominent door. Nothing in this
unit's records claims the roll is audited — the DE-12 append says in terms that a `logger.info` line
is not a durable record.

## 3c. ★★★ A SECOND review round found a FALSE CLAIM OF ENFORCEMENT, which is worse than a missing check

The `terminalized_by` author list is spelled in **three** places — the TypeScript constant, the
Drizzle `check()` literal in `packages/db/src/schema/service_instances.ts`, and the DDL of migration
`0279`. Three separate records described that as a reconciled set: the migration's own header, the
constant's docstring, and the schema comment beside the literal. **Only two of the three copies were
reconciled.** `T-P5` read the migration SQL and compared it to the constant; **nothing in the tree
read the Drizzle literal at all**, so the schema comment's *"reconciled … by an assertion that
asserts set EQUALITY"* was simply false.

★ **That is worse than having no check**, and the reason is behavioural rather than technical: a
reader who arrives at that literal and sees a sentence saying it is reconciled has been given a
reason **not** to write the assertion. A missing check invites one; a false claim of one forecloses
it. The same review round found the sibling defect in the same comment — it said **three** authors
over an `IN`-list holding **four**, the token `worker_event` having been swept while the bare word
`three` was not.

**Both are fixed, and the enforcement half was made TRUE rather than merely re-worded.** `T-P5c`
reads the Drizzle literal as source text and asserts set equality against the constant; `T-P5d`
asserts the two DDL copies against each other. Mutant **P2a** — a fifth author added to the Drizzle
literal **alone** — was observed **red on `T-P5c` and `T-P5d` with `T-P5` staying green**, which is
the exact divergence that was invisible before; **P2b**, the same author added to the constant alone,
reds `T-P5` and `T-P5c` while `T-P5d` stays green. Both restores were md5-verified.

★ **What `T-P5c` does NOT prove, stated so this comment does not repeat the defect it fixes.** It
reads source text and says nothing about the constraint any deployed database is running — `0279`
is immutable once applied and `T-P5` is what covers that. What the Drizzle copy governs is the DDL
`db:generate` would emit **next** for this table, so a divergence there plants the wrong list in a
future migration rather than breaking today's deployment. Both statements are now written at the
literal itself.

## 4. What was NOT weakened

* **SVC-003a's stale-generation refusal is untouched.** It compares against the **instance's**
  generation, never `services.generation` — which is precisely what lets a generation-N worker keep
  projecting onto its own instance while being drained past a bump. SVC-003a wrote that sentence in
  anticipation of this ticket. `R-T8` measures **both** halves after a real bump: the old worker can
  still report (a), and a claim naming the NEW generation on the OLD instance is still refused (b).
* **SVC-003b's same-generation replacement is untouched.** The fence filters
  `generation <> currentGeneration`. E9-F007 §3 ruled the same-generation overlap the smaller harm
  and SVC-005a does not reopen it. `R-T6` is the named positive control.

---

## 5. Evidence

**26 cases, all green** — 14 integration + 12 pure — plus **72 in the six neighbouring E9
suites re-run at HEAD**: **98 total across 8 files**, measured after the last edit.

★ **The eight files are enumerated rather than counted from memory**, because "the six
neighbouring suites" is exactly the kind of unnamed set whose total nobody can re-derive:
`service-generation-rollout.integration` (14) + `service-generation-rollout` (12) — this unit —
plus `service-liveness-deadline` (15), `service-health-projection` (15),
`service-liveness-deadline.integration` (13), `service-health-projection.integration` (11),
`service-desired-state-schema.integration` (10) and `job-fence-surface.contract` (8) = **98**.
A wider run of **every** E9 service suite, adding `service-management` (18),
`service-reconciler.integration` (17) and `service-management.integration` (13) — SVC-002's and
SVC-007a's, untouched here — was **146 green across 11 files** at this unit's own head.

★ **RE-COUNTED AFTER THE 2026-09-10 MERGE of SVC-007b (#414), because the merge moved this
number and a merge-moved count that is not re-counted is this programme's most frequent defect.**
The eight files above are **unchanged at 98** — #414 touched none of them. The wider set is now
**161 green across 12 files**: `service-management.integration` went 13 → **18** (#414's five audit
cases, including the two rollback probes it extended to count audit rows), the new
`service-control-audit` (**10**) joins as the twelfth file, and `service-management` (18) and
`service-reconciler.integration` (17) are unmoved. 98 + 18 + 18 + 17 + 10 = **161**. Measured at the
merge commit after the last edit, with `AOA_RUN_WIN_INTEGRATION=1`.

| Case | What it pins |
|---|---|
| `R-T1` | the mint AND the bump — either alone is a defect |
| `R-T2` | they are ONE transaction (rollback probe) |
| `R-T3` | the drain, and that `terminalized_by` is recorded by the SHIPPED chokepoint |
| `R-T3b` | a NON-terminal move records no author |
| `R-T4` | ★★★ a clock-condemned predecessor of an OLD generation REFUSES the placement |
| `R-T5` | ★★★ the stall CLEARS when the old attempt goes terminal — a stall, not a wedge |
| `R-T6` | ★★★ a SAME-generation replacement is unaffected (positive control) |
| `R-T7` / `R-T7b` | a witnessed predecessor does not stall; the SQL half pinned alone |
| `R-T7c` | ★★★ a worker's `lost` event is NOT a witness — the PR #415 P1 regression |
| `R-T8` | SVC-003a's fence still refuses, in both directions, after a real bump |
| `R-T9` / `R-T9b` / `R-T10` | refusals; `stopped` is rollable; forward-by-one |
| `T-P1`, `T-P2`, `T-P3`/`b`/`c`/`d`, `T-P4`, `T-P6` | the witness classification, NULL, and the fail-closed default |
| `T-P5` / `T-P5b` | the 0279 CHECK reconciliation, and its NULL arm |
| `T-P5c` / `T-P5d` | ★★★ the **Drizzle `check()` literal** reconciled too — the copy that had a claim of enforcement and no enforcer |

**14 integration cases + 12 pure cases = 26**, counted from the case list above rather than from
memory: `R-T1`, `R-T2`, `R-T3`, `R-T3b`, `R-T4`, `R-T5`, `R-T6`, `R-T7`, `R-T7b`, `R-T7c`, `R-T8`,
`R-T9`, `R-T9b`, `R-T10`; `T-P1`, `T-P2`, `T-P3`, `T-P3b`, `T-P3c`, `T-P3d`, `T-P4`, `T-P5`,
`T-P5b`, `T-P5c`, `T-P5d`, `T-P6`.

**Twelve mutants observed, each with a named positive control that stayed green** (counted from the table below after the last edit, not from memory)**:**

| Mutant | Killed by | Positive control |
|---|---|---|
| M1 `isWitnessedTerminalAuthor(null) → true` | `T-P2`, `T-P3c` | `T-P1` |
| M2 add `control_plane_backstop` to the witness list | `T-P1` | `T-P4` (structural, correctly green) |
| M3 `findBlockingPredecessor → candidates[0]` | `T-P3b`, `T-P3c` | `T-P3d` |
| R5 delete step 4b | `R-T4`, `R-T5` | `R-T6` |
| R6 drop fence condition (1) — the generation filter | **`R-T6` only** | `R-T4`, `R-T5` |
| R7 drop fence condition (3) — the recovery condition | **`R-T5` only** | `R-T4` |
| R8 vacuous `isWitnessedTerminalAuthor` (pure site only) | `T-P1`, `T-P3b`, `T-P3c`, `T-P4` — and **nothing** in the integration suite | `R-T4`–`R-T8` all green: the finding, not the control |
| R8′ drop fence condition (2) — the witness test, SQL site only | **`R-T7b` only** (and nothing at all before `R-T7b` existed) | `R-T4`, `R-T6`, `R-T7` |
| R8″ vacuous witness test at BOTH sites | `R-T7`, `R-T7b` | `R-T6` |
| **P1** collapse the two worker authors back into one — **the defect external review found** | **`R-T7c` only** | **`R-T7` green — the asymmetry that let it ship** |
| **P2a** add a fifth author to the **Drizzle `check()` literal only** | **`T-P5c` + `T-P5d`** | **`T-P5` green — and that is the point: this divergence was invisible to the whole tree until `T-P5c`** |
| **P2b** add a fifth author to the **TypeScript constant only** | `T-P5` + `T-P5c` | `T-P5d` green (the two DDL copies still agree with each other), `T-P4` green (fail-closed by construction) |

★ **A PREDICTION THAT WAS WRONG, RECORDED RATHER THAN QUIETLY FIXED.** `R-T7`'s first comment named
mutant **R8** (vacuous `isWitnessedTerminalAuthor`) as its killer. **Measured: it is not.** The
witness test lives in TWO places — condition (2) of the repository's WHERE clause and the pure
classifier's re-derivation — so mutating **either alone is survived**, because the other still
catches the witnessed row. `R-T7` stayed green under both single-site mutants, which meant **the SQL
half was covered by nothing**: a redundancy that reads as two checks and pins one. `R-T7b` was added
in response, was **observed red under R8′ while that mutant was still applied**, and is the case
that pins the SQL half alone. The comment now states the measured killer (R8″, both sites) instead of
the guessed one.

**Every mutant restore was md5-verified** against a pre-mutation baseline, and `git status
--porcelain` was checked clean of residue afterwards.

---

## 6. ★ A record that was already wrong before this ticket

DE-12's `deliveryEvidence` asserts *"the call `update(services)` appears ZERO times anywhere in the
tree outside comments"*. Re-measured at this ticket's base `c27feeea8`: it was **one** —
SVC-007a's `updateServiceDesiredState`, writing `desired_state`. The measurement predates SVC-007a
and was never re-taken. That is this programme's signature defect (a record disagreeing with its own
code) sitting **inside a row whose whole purpose is to record measurements**.

Corrected by a **dated append**, with the original sentence left standing so the drift stays visible.
**`deliveryStatus` is deliberately unchanged at `partial`**, and DE-12's audit conjunction gains no
whole conjunct: partition is unchanged, drain is blocked on E9-F008, and a generation change now
*happens* but reaches only a `logger.info` line — a log line is not a durable record.

---

## 7. What is left — SVC-005 stays OPEN

Per conjunct of E9's Outcome and Acceptance: **pause/resume** partly, by SVC-007a, nothing added
here; **worker drain** not delivered (E9-F008 — no producer, and a TYPE-level narrowing);
**replace-before-stop** structurally unreachable under the live-instance index, stated rather than
dropped; **hard runtime/spend limits** not delivered (`ttl_seconds` is written NULL by both
generation writers, deliberately, because nothing enforces it); **stuck-stop force-kill** not
delivered (no control-plane channel to SVC-008a's `signalProcess`); **"budget/TTL stop is auditable
and cannot be overridden by the worker"** vacuous today; **"no two generations perform external
effects simultaneously"** — the fenceable half only, E9-F012.

**No service job is leased anywhere in this unit's suites** (E9-F002), so the daemon half of the
rollout — a real worker collecting a real graceful stop — is unexercised. `R-T3` measures and states
what actually happens instead: the unleased path takes `requestCancellation`'s FINALIZE branch,
queues no command and emits no event, which is E9-F006 and is exactly why the roll must call the
attempt-terminal backstop.

**Findings claimed by this unit: E9-F012** (filed). **E9-F009** is updated with a delivered/not-
delivered split and **stays OPEN**. E9-F001–F008 are untouched, and so are **E9-F010** and
**E9-F011**, which arrived in the same 2026-09-10 merge of SVC-007b (#414) and which SVC-005a
neither opened nor moved.
