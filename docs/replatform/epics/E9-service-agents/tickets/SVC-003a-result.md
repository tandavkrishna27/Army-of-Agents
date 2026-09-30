# SVC-003a — service health semantics: the projection and its fence — RESULT

**Epic:** E9 · **Lane:** B · **Base:** `6b39c77f6` (branched from `docs/replatform-program`)
**Terrain + design:** [`SVC-003a-design.md`](./SVC-003a-design.md)
**Register:** gate clause `E9-3-service-health-projection` enrolled `wired`. **`E9-F001` CLOSED
(both conjuncts). `E9-F002` and `E9-F003` untouched and both stay `open`/`unowned`.**

> **★ SVC-003 HAD ZERO FILES ON DISK at `6b39c77f6`** — no design, no terrain, no result, only the
> `program-design.md` node and eleven references from other tickets' scope-outs and from three
> `unowned` findings that named it as an inheritor they could not legally point at. Terrain and
> design were part of this unit's job and are in the companion file. Re-measured at source; no
> citation in either document is inherited.

---

## 1. What shipped, in one paragraph

A worker event that WITNESSES a service-instance fact now moves `service_instances.status`, inside
the same fenced transaction that durably appends it. `acceptEvent` gained a per-event branch
calling a new `applyServiceProjectionForFence`, which locks the instance attributed to
`(job, attempt)`, requires the worker's payload identity and generation to match it, requires the
move to be legal under the FROZEN `SERVICE_INSTANCE_TRANSITIONS` table, and writes through the one
shared writer `recordServiceHealth` now also uses. The semantic half — which event means which
status, and which six events mean nothing — is a pure server-side module
(`service-health-projection.ts`) because `packages/db` does not depend on `worker-protocol`. Zero
wire change; one migration, and it is `db:generate` output for a changed CHECK.

---

## 2. ★★★ WHAT IS NOW TRUE THAT WAS NOT, AND WHAT IS STILL NOT TRUE

**Now true.** Three epic documents said the same thing at base and all three were right:
`README.md` (*"the loop converges once and goes quiescent because `recordServiceHealth` still has
no consumer (SVC-003)"*), `SVC-002-result.md` §7, and `SVC-008b-result.md` §7 (*"every service
event emitted here is durably stored and **projects no state change**"*). That sentence is no
longer true. A supervised instance that stops or is lost is now driven terminal by its own
worker's event, leaves `service_instances_live_service_uq`, and SVC-002's reconciler creates its
replacement on the next pass. **T5 drives all three legs and would red if any one stopped.**

**★ STILL NOT TRUE, AND THE E9 EXIT GATE IS NOT MET.** The gate names desired state, generation,
placement, health, restart, checkpoint, drain, budgets, UI and a 72-hour D4 canary. This unit
delivers one of those and does not claim otherwise:

* **NOTHING CREATES A SERVICE.** Re-measured at head, not inherited: `repos.services.insert` has
  the same zero production callers it had at base, and this unit adds no route. On a real
  deployment there is no `services` row, so no instance, so nothing for this projection to move.
  SVC-007.
* **NOTHING WRITES A GENERATION**, so `findServiceGenerationDefinition` still answers `null` and
  every reconcile pass still stalls at `no_generation`. SVC-007.
* **A SERVICE JOB IS STILL NOT LEASED IN THIS SUITE.** §7 says exactly what that costs.
* **FOUR OF SVC-003'S FIVE OUTCOME CLAUSES ARE NOT DELIVERED** — §6.

---

## 3. The arming path, counted rather than asserted

The brief's warning is that a projection nothing reads is `createStartupReconciler` wearing a new
name. Measured with the register's own `countProductionCallers`, base `6b39c77f6` vs head:

| Symbol | Base | Head | What the head count is |
|---|---|---|---|
| `applyServiceProjectionForFence` | — (did not exist) | **1** | the per-event branch in `acceptEvent` |
| `writeServiceInstanceStatus` | — | **2** | the projection **and** `recordServiceHealth` — the two governed entry points now share ONE writer of that column, so they cannot drift into two ideas of a legal move |
| `decideServiceProjectionForEvent` | — | **1** | `toAcceptInputs` in the JOB-005 ingest |
| `decideServiceProjection` | — | **1** | the typed overload above it |
| `predecessorsOf` | — | **1** | the decider |
| **`canTransitionServiceInstanceStatus`** | **0** | **1** | ★ the one that matters — see below |
| `SERVICE_HEALTH_ASSERTABLE_STATUSES` | — | **1** | the `ServiceHealthStatus` type alias derived from it |
| `recordServiceHealth` | **2** | **2** | UNCHANGED. The projection does not call it; both are entry points onto the shared writer |
| `createStartupReconciler` (cautionary neighbour) | **0** | **0** | untouched; still zero |
| `createServiceReconciler` | **2** | **2** | untouched |

★ **`canTransitionServiceInstanceStatus` is the vacuous symbol this unit arms.** The frozen
`SERVICE_INSTANCE_TRANSITIONS` table — the authority the `service_instances_status_check` CHECK and
the `service_instances_live_service_uq` predicate are both hand-written copies of — had **zero**
production consumers at base. Its only references were its own definition, the package barrel
(which the counter strips), and its own unit test. A lifecycle nothing enforces is a clause that is
vacuously true; `predecessorsOf` is its first production consumer, and mutant 7 is what proves the
consumption is load-bearing rather than decorative.

The chain above `applyServiceProjectionForFence` is real and pre-existing: `workerControlRoutes` →
`createJobEventIngestService.ingest` → `repos.jobControl.acceptEvent`. It is the shipped JOB-005
ingest path, not a new composition root, which is why this unit adds no wiring to `index.ts` at all.

---

## 4. Reds observed, and the NAMED POSITIVE CONTROL

**★ HOW THE REDS WERE OBSERVED, stated so they are not over-read.** Only ONE case is red on the
unchanged base tree; the rest are mutation results. A suite that drives a module which does not
exist at base reds on "cannot import", which proves nothing about the shipped path — SVC-008b's
lesson. Each mutant was applied by a harness that tries **both line-ending forms** of its anchor
and **throws when it matches nothing** (this tree is mixed: `job-control.ts` is CRLF, the new
module is LF), and repository mutants were run against a **rebuilt `dist/`**, because the server
suite resolves `@armyofagents/db` through `dist` while vitest prints `src` paths.

> ★ **AND THE FIRST VERSION OF THAT HARNESS WAS WRONG, WHICH IS WORTH RECORDING.** It rewrote its
> `.mutbak` on every apply. A stray second `apply` in the driver loop saved the ALREADY-MUTATED
> file as "original", the restore restored the mutant, and five mutants silently stacked up in the
> working tree — the apply/restore cycle reporting success the whole time. It was caught because
> the failure COUNTS climbed monotonically (2, 3, 6, 7, 8) instead of returning to their own
> values. The harness now refuses to apply when a backup already exists. *A restore that is never
> verified is a check that nothing runs, in the tooling rather than the product.*

**THE GENUINE BASE-TREE RED — E9-F001, 2 cases.** `ServiceHealthStatus` still read
`"healthy" | "stopped" | "lost" | "interrupted"` at base, and `"interrupted"` is not a member of the
frozen nine. Mutant 6 re-adds it, reproducing that state exactly, and reds the two reconciliation
cases.

**NAMED POSITIVE CONTROL: `T8 POSITIVE CONTROL — the batch attempt/job projection is
byte-identical`.** The JOB-005 batch path: `attempt_started` drives attempt `leased→running` and
job `queued→running`, `terminal` completes the attempt, and both receipts are written. **Green
before, green after, and green under all seventeen mutants** — including mutant 12, which reds **10
of the 26 cases**. Without it, several cases above could pass because ingest had stopped projecting
anything at all.

★ This paragraph read "thirteen mutants" and "seven of the eight service cases" until the review
fixes, which added four mutants and four cases and updated the table row and the header four lines
below — and not this sentence. A measurement claim about the positive control that contradicts the
table beneath it is worse than a stale line number, because nothing about it looks stale.

**SEVENTEEN mutants over 26 cases** (10 pure + 8 integration originally; +5 pure and +3 integration
added by the review fixes in §4a). Counts below are the FINAL figures, re-measured on the shipped
source after those fixes — not the pre-review numbers.

| # | Mutant | Result |
|---|---|---|
| 1 | Delete the `attempt_started → leased` arm | **10 red** — ★ without it `pending` is a dead end (the frozen table's only edge into `starting` is from `leased`, and nothing else writes `leased`) |
| 2 | Map `service_instance_started` to `healthy` | **5 red** |
| 3 | Return the transition table unfiltered | **7 red** — including the whole-table "no terminal is ever a predecessor" property |
| 4 | Project `stopping` from `service_graceful_stop_observed` | **1 red** |
| 5 | Default an unreadable health verdict to `healthy` | **2 red** |
| 6 | Reinstate `"interrupted"` (**the base-tree state**) | **2 red** |
| 7 | Delete the legality check | **1 red** — T5, the split-brain case |
| 8 | Trust `payload.serviceInstanceId` | **1 red** — T4 |
| 9 | Delete the generation fence | **1 red** — T3 |
| 10 | Return a definite `applied` for an unattributed observation | **1 red** — T7 |
| 11 | Have the projection bump `leases.expires_at` | **1 red** — T6, E9's "health does not extend ownership" clause |
| 12 | Delete the call site in `acceptEvent` | **10 red**, positive control green |
| 13 | `serviceProjection: null` in `toAcceptInputs` | **1 red — and ONLY T1** |
| **14** | **Revert `predecessorsOf` to the direct-edge filter** (the pre-review state) | **3 red** — E9-F004, T5b, T5d |
| **15** | **Delete the attempt-terminal backstop** (the pre-review state) | **3 red** — E9-F005, T5c, T5d |
| **16** | **Default `whenAlreadyTerminal` to `"noop"`** | **2 red** — and one of them is **T5**, the split-brain case, which is exactly the leak this pins |
| **17** | Walk back through PROJECTABLE states too (plain reachability) | **3 red** |

★ **Mutant 13 is the arming discrimination, and it is why T1 goes through the full
`createJobEventIngestService` rather than through `acceptEvent` directly.** Under it the feature is
wired to nothing and every case that hands `acceptEvent` a hand-built projection still passes. Only
the case that drives the real wire path can see it. A suite built entirely on the direct path would
have declared this feature proven while it reached production code never.

**Suites:** `server/src/__tests__/service-health-projection.test.ts` (15 pure cases over the whole
9×9 transition table) and `server/src/__tests__/service-health-projection.integration.test.ts`
(11 cases, real embedded PostgreSQL, real poll/ACK-minted ACTIVE fence).

---

## 4a. ★★★ REVIEW FOUND TWO REAL DEFECTS IN THIS DIFF, AND BOTH WERE PERMANENT WEDGES

External review of PR #410 raised two P1s. **Both were real, both were verified against source
before being believed, and both are fixed here.** They are recorded rather than folded in silently,
because the shape of the miss is the lesson.

**(i) E9-F004 — the direct-edge legality predicate refused EVERY NORMAL SERVICE STOP.**
`SERVICE_INSTANCE_TRANSITIONS` makes `stopping` the sole predecessor of `stopped`, and **no frozen
worker event can assert `stopping`** — the supervisor emits `service_instance_stopped` directly from
`healthy` (`runServiceLifecycle`'s `case "process_exited"` arm, `service-lifecycle.ts` ~:293, and
`gracefulStop`'s `verdict === "stopped"` branch ~:362 after the graceful ladder), and
`service_graceful_stop_observed` observes a REQUEST. So an ordinary service exit was refused as
`illegal_transition`, the instance stayed `healthy` inside `service_instances_live_service_uq`, and
SVC-002's reconciler could never replace it. **That is the exact opposite of this ticket's purpose.**

★ **HOW IT SURVIVED A NAMED POSITIVE CONTROL AND THIRTEEN KILLED MUTANTS.** The one end-to-end case
drove `service_instance_lost` — and `lost` is the one status the frozen table makes reachable from
every non-terminal status. Every mutant was measured against a suite whose only terminal transition
was the one with no reachability problem. *A lifecycle table proven over the transitions a suite
happens to exercise is not proven over the table.* The fix is `predecessorsOf` walking back through
statuses no event can project; the residual is filed as **E9-F004** and stays open, because closing
it properly needs SVC-005 to write `stopping` or a frozen-table amendment.

**(ii) E9-F005 — a failed attempt with no service event stranded the instance.**
`runServiceLifecycle`'s §4.2a launch comment (`service-lifecycle.ts`, ~:166) says it in its own
words: a launch resolving no handle emits NO
`service_instance_started`, so *"the instance never leaves `leased` and the attempt fails"*. The
attempt went terminal while the instance sat live forever — E9-F004's wedge through another door.
Fixed with the attempt-terminal backstop (§5.7), filed as **E9-F005**, resolved in this commit.

**Both fixes were observed RED under mutants 14–16 that restore the exact pre-fix behaviour**, and
mutant 16 is the one that matters most: it reds **T5**, the split-brain case, proving that letting
`whenAlreadyTerminal: "noop"` leak onto service events would have silently converted the DE-12
refusal into a benign no-op.

★ **AND THE HARNESS FAILED A SECOND WAY DURING THE RE-RUN, recorded for the same reason as the
first.** `apply` mutates the file and *then* rebuilds `dist`. One rebuild exited non-zero, the
harness threw AFTER writing the mutation, and the driver reported `APPLY FAILED` — while the mutant
was still on disk. The next unmutated run came back 10-red and could have been read as a real
regression. It was caught because the backup file was still present when it should not have been.
*Report a mutant as not-applied only when the file is provably unchanged, not when the apply step
merely threw.*

---

## 5. Deviations and judgement calls, each with its reason

**5.1 — `ServiceHealthStatus` is WIDENED, and the widening is E9-F001's, not a side effect.**
`SVC-001-design.md` §3.2 CORRECTION 6a reserved any change to this governed mutator's input domain
for SVC-003. The projection needs `starting`/`unhealthy`, which the old four could not express at
all. The new domain is **five of the frozen nine**, derived as a named constant, with a recorded
reason for each of the four omissions: `pending` (the reconciler's INSERT — a worker cannot observe
a row into existence), `leased` (the control plane's fact, from `attempt_started`), `stopping` (a
REQUEST, not an observation — SVC-005's), and `failed` (no worker event means it). E9-F001's
resolution note forbids fixing it *by widening the type to all nine*; this is not that, and a test
pins the exact set so a later widening must be a decision.

**5.2 — `attempt_started` carries a NULL claim, and that is a typed field rather than an implicit
hole.** Its frozen payload is `{sandboxId}` — there is no service ref to check. `claim: null` is
explicit on the input type with its justification on the field: the target row is still fixed by
attribution, and the only status a null-claim projection may drive is `leased`, whose sole legal
predecessor is `pending`. It cannot escape a terminal status, skip a generation, or reach a row the
worker was not already leased.

**5.3 — `recordServiceHealth` changed shape, and it now reads under a row lock.** It previously
did an UNCONDITIONAL `UPDATE ... WHERE id = ?` — it would happily move `stopped → healthy`. It now
locks, compares, and writes through the shared `writeServiceInstanceStatus`. **Stated honestly: it
does NOT get the legality gate**, because the frozen table lives in a package `packages/db` cannot
import and this mutator's callers do not supply a predecessor set. Its only callers are three test
call sites (2 production references, both its own declaration and implementation), so nothing in
production reaches the ungated path — but it is a real asymmetry and it is recorded rather than
implied. Closing it means either giving `recordServiceHealth` the same server-computed
`allowedFromStatuses` the projection gets, or deleting it once the projection is its only successor.

**5.4 — the migration is `db:generate` output.** `0277_service_health_projection.sql` is a
DROP/ADD CONSTRAINT pair for the `job_projection_receipts_projection_kind_check` CHECK, adding
`'service_instance_status'`. No hand-authored DDL, no C14 exception used: adding a value to a CHECK
on an already-registered relation changes no ACL, so no class-(b) security block is needed. Only
the generated filename was renamed (and its `_journal.json` tag with it), matching `0275`'s
precedent.

**5.5 — the projection returns its outcomes and the ingest LOGS the refusals.** A stale generation,
a worker naming another instance, and a late event refused for illegality are all
security-relevant and would otherwise be silent no-writes. `unattributed` is deliberately excluded
from that log line: a batch job's `attempt_started` is unattributed by construction, and logging it
would bury the real refusals under one line per batch job.

**5.7 — the attempt-terminal backstop, added by review (§4a(ii)).** A NON-succeeded `terminal`
drives the instance to `failed`. Three bounds keep it a backstop: `succeeded` projects nothing (the
service already emitted `_stopped`; re-asserting would be the projection overruling an
observation); it carries no claim, so the target is fixed by attribution; and it is the ONLY
projection with `whenAlreadyTerminal: "noop"`. That flag changes only the REPORTED outcome — no
write happens under either value — so it can never admit a move `"refuse"` would block, and mutant
16 pins that it does not leak onto service events. **Left for SVC-004:** whether such an instance
should be RESTARTED, and with what backoff, is its crash-loop clause; this unit has no opinion.

**5.6 — `noop_same_status` is checked BEFORE legality.** No status has a self-edge in the frozen
table, so a repeated health tick (the common case: SVC-008b ticks every 10–60 s for the life of the
instance) would otherwise be reported as `illegal_transition` — false, and it would drown 5.5's log.

---

## 6. ★ THE FOUR CLAUSES OF SVC-003 THIS UNIT DOES NOT DELIVER

`program-design.md`'s Outcome is a five-way conjunction. **SVC-003 stays OPEN.** Full reasoning in
`SVC-003a-design.md` §8; the ledger:

1. **Liveness deadline — NOT BUILT, the largest omission.** SVC-008b §6.2 handed it here by name. A
   worker that goes silent WITHOUT emitting `_stopped`/`_lost` — crash, partition, vanished sandbox
   — leaves its instance in its last projected status forever. Its LEASE is reaped, but nothing
   propagates that to the instance row, so the reconciler still sees a live instance and never
   replaces it. Needs a durable last-observation column (a migration this unit does not add), a
   sweeper, and the replacement POLICY, which is SVC-004's crash-loop clause. Half of that is not
   it, so none of it is claimed.
2. **Graceful stop — NOT BUILT.** SVC-005 owns the request side; this unit deliberately projects
   nothing from `service_graceful_stop_observed`.
3. **Checkpoint request — STRUCTURALLY UNAVAILABLE.** `job_control_commands_kind_check` permits
   five of the frozen six command kinds and omits `checkpoint` entirely, so one cannot be
   persisted. SVC-004.
4. **Bounded lease renewal — NOT CHANGED.** The negative half of the acceptance clause IS pinned:
   the projection writes exactly one table and never touches `leases` (T6, mutant 11).

**And two acceptance clauses that are not buildable yet**, which is a measurement rather than a
deferral: memory/context callbacks and connector refresh under the current fence (`MemoryActor` has
no `service` kind and no memory operation exists among the ten frozen worker operations — SVC-001
already declined `actor_context_policy_id` for exactly this reason), and the network-partition test
(no replica identity or partition detector exists anywhere in the tree).

**E9-F002 and E9-F003 are NOT closed and NOT inherited.** SVC-003 now has a file, so the guard's
existence bar would no longer block naming it as a successor — but naming it would be a claim this
unit does not honour. E9-F002's residual is the never-re-minted effect authority (SVC-008 §9.1,
unruled); E9-F003's is the envelope-side principal identity, which needs a Protocol Custodian
ruling. Both stay `open`/`unowned`. E9-F003 gained a §2a recording that SVC-003a consumed the
attribution it named — which narrows the blast radius and closes nothing.

---

## 7. ★ WHAT THE INTEGRATION SUITE DOES **NOT** EXERCISE, said before anyone over-reads it

**The leased attempt is a placed BATCH job, not a service job.** Leasing a real service job needs
the fleet to advertise `workload.service` with a free service slot AND the reconciler's submission
to be placed by the placement loop — machinery this unit does not build, and widening the shared
`job-control-fixture` for it would change `WORKER_PROFILE_HASH` under twenty other suites.

**Why it does not weaken any assertion:** the projection keys on `service_instances.job_id` /
`.attempt_id` attribution and never on the job's workload type. That independence is the whole
point of the attribution SVC-002 wrote, and T4 is the case that pins it. Everything else in the
suite is real: the constraints, the partial unique index, the poll/ACK-minted ACTIVE fence,
`guardActiveFence`, `acceptEvent`'s durable append, SVC-002's own two instance writers, and
SVC-002's real `reconcileService` for T5's replacement leg.

**★ THE PRODUCTION WIRE IS PROVEN BY EXACTLY ONE ARM, AND THAT IS THIN — SAID PLAINLY.** T1 is the
only case in either suite that drives `createJobEventIngestService`; every other case hands
`acceptEvent` a projection directly. The measurement agrees rather than the prose: mutant 13
(`serviceProjection: null` in `toAcceptInputs`) reds **T1 and nothing else** — one arm stands
between "the feature reaches production code" and "the feature is wired to nothing and 25 cases
still pass". Nothing here should be read as broader wire coverage than that. A second ingest-driven
case (a refusal path through the real ingest, so the arm is not a single point) is the cheapest
thing to add next, and it is not added here.

**So the leg this suite does not cover is SVC-008b's, and SVC-008b covers it** — its suite proves a
service job is offered to a daemon and supervised as a service, emitting exactly these events.
**What no suite anywhere covers is the two legs joined end to end on one job**, and that stays true
until SVC-007 gives a human a way to create a service. It is not claimed here.

---

## 8. Register changes in this commit

- `scripts/gate-clause-wiring.json`: **added** `E9-3-service-health-projection`, `wired`, symbol
  `applyServiceProjectionForFence` (1 production caller, base 0). Six insert lines, no reformatting.
- `docs/replatform/epics/E9-service-agents/findings.md`: **E9-F001 → `resolved`**, with the
  both-conjuncts note; **E9-F003 gained §2a**, status and owner unchanged; **E9-F004 FILED**
  (`open`/`unowned` — the frozen table's unassertable `stopping`); **E9-F005 FILED** (`resolved`
  here, filed anyway because the daemon behaviour is unchanged and SVC-004 will meet it again).
- `scripts/finding-ownership.json`: **E9-F001 key DELETED**, in the same commit, as its own
  resolution instruction required; **E9-F004 key ADDED** (`unowned`, with its residual and resolve
  criterion). E9-F005 needs no key — the guard accounts only for open findings.
- `scripts/test-inventory.json`: unchanged — the guard reports OK at head (2773 files across 22
  trees); its `server` entry is a floor this diff does not cross.
- `packages/db/src/migrations/0277_service_health_projection.sql` + `meta/` — `db:generate` output.
