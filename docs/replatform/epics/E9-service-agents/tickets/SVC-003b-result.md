# SVC-003b — the liveness deadline — RESULT

**Epic:** E9 · **Lane:** B · **Base:** `053f90fc8` (branched from `docs/replatform-program`)
**Terrain + design:** [`SVC-003b-design.md`](./SVC-003b-design.md) · **Predecessor:**
[`SVC-003a-result.md`](./SVC-003a-result.md)
**Register:** gate clause `E9-4-service-liveness-deadline` enrolled `wired`. **`E9-F007`, `E9-F008`
and `E9-F009` FILED (`open`/`unowned`). NO finding is closed. SVC-003 STAYS OPEN.**

---

## 1. What shipped, in one paragraph

A live `service_instances` row whose worker has stopped being observed is now driven to the frozen
`lost` status **by a clock rather than by an event**. `applyServiceProjectionForFence` stamps a new
nullable `service_instances.last_observed_at` for every observation that survived attribution,
identity and generation — including the ones that move no status, which is the steady state of a
healthy service. A new repository method `sweepServiceInstanceLiveness` reads the tenant's LIVE
instances `FOR UPDATE SKIP LOCKED` **least-recently-heard-from first** — an ordering that is a
correctness property rather than a preference, because a bounded batch over a population healthy
rows never leave would otherwise starve its tail (§4b(i), §6 of the design) — computes both ages
with the database's own `clock_timestamp()`, asks an injected pure policy about each, and
terminalizes the condemned ones through the same single writer every other status move goes through.
That sweep runs inside `createServiceReconciler`'s own
tick, **ahead of the convergence pages**, so a terminalized instance leaves
`service_instances_live_service_uq` and SVC-002's unchanged reconciler creates its replacement in the
SAME tick. One migration, `db:generate` output plus a C14 class (a) guard, adding one column.

---

## 2. ★★★ WHAT IS NOW TRUE THAT WAS NOT, AND WHAT IS STILL NOT TRUE

**Now true.** SVC-003a stated the gap exactly, and that sentence is no longer a true description of
the tree: *"a worker that goes silent WITHOUT EMITTING ANYTHING is still only reaped at the LEASE
level, and nothing terminalizes its instance."* Measured at base and re-measured at head: `reapExpiredLeases` revokes the lease,
releases the capacity slot and terminalizes the ATTEMPT and the JOB, and contains **no write to
`service_instances` at all**. `L-T8` drives the real shipped reaper and measures that, then shows
the deadline converting the orphan into a replaceable state. The harder variant is closed too, and
it was invisible to every mechanism in the tree: `runServiceLifecycle`'s supervise loop answers an
unanswerable `processStatus` read with `unknown ⇒ EMIT NOTHING` while `lease-renewal.ts` renews on a
**separate driver**, so a worker whose supervision is dead can hold a lease that never expires. The
lease reaper is structurally blind to that; a clock is not.

**★ STILL NOT TRUE, AND THE E9 EXIT GATE IS NOT MET.** The gate names desired state, generation,
placement, health, restart, checkpoint, drain, budgets, UI and a 72-hour D4 canary.

* **NOTHING CREATES A SERVICE.** Re-measured at head with `countProductionCallers`, not inherited:
  `repos.services.insert` has the same **zero** production callers it had at base, and this unit
  adds no route. On a real deployment there is no `services` row, so no instance, so the sweep reads
  an empty population and terminalizes nothing. SVC-007.
* **NOTHING WRITES A GENERATION**, so a replacement still stalls at `no_generation`. SVC-007.
* **★★★ THE DEADLINE TERMINALIZES THE INSTANCE AND DOES NOT FENCE THE WORKER.** The sweep writes
  exactly ONE table — `L-T11` asserts the lease's `status`, `expires_at` and `fence` are unchanged
  across a terminalization, and mutant **L17** reds it. That restraint is E9's own acceptance
  sentence (*"health events do not extend ownership without a successful lease renewal"*) applied to
  a second writer. The cost is real and is **filed as E9-F007, not implied**: a silent-but-still-
  renewing worker keeps its fence while its replacement starts. The replacement's ROW is protected
  (SVC-003a's split-brain refusal returns `illegal_transition` for the old worker's late events, so
  two live rows under one partial-unique key stay impossible); the old worker's EXTERNAL EFFECTS are
  not. That is SVC-005's overlap clause reached one ticket early, by a same-generation route.
* **THREE OF SVC-003'S FIVE OUTCOME CLAUSES ARE STILL NOT DELIVERED** — §6.

---

## 3. The arming path, counted rather than asserted

Measured with the register's own `countProductionCallers`, in a detached worktree at base
`053f90fc8` versus this ticket's head. Every figure re-run after the last edit — and RE-RUN
AGAIN at the MERGED head after this branch took in `7f95b1ae8` (SVC-007a). The merge moved
exactly ONE of these sixteen figures, `writeServiceInstanceStatus`, and the row says so; the
other fifteen are byte-identical at both heads.

| Symbol | Base | Head | What the head count is |
|---|---|---|---|
| **`sweepOrganizationServiceLiveness`** | **0** | **1** | ★ the arming symbol: the pass inside `createServiceReconciler`'s own `runTick`, ahead of the convergence pages |
| `sweepServiceInstanceLiveness` | 0 | **3** | the repository interface declaration, its implementation, and **one** call. Only the third is a caller — the same over-count SVC-003a records as 2 for `recordServiceHealth` |
| `classifyServiceInstanceLiveness` | 0 | 1 | the injected decider |
| `livenessVerdictTerminalizes` | 0 | 1 | the same decider |
| `livenessDeadlineAllowedFromStatuses` | 0 | 2 | the sweep, and the module's own load-time coverage assertion |
| `nonTerminalServiceInstanceStatuses` | 0 | 1 | that assertion |
| `SERVICE_LIVENESS_DEADLINE_TO_STATUS` | 0 | 3 | the sweep, the predecessor derivation, the assertion's message |
| `SERVICE_LIVENESS_DEADLINE_MS_DEFAULT` | 0 | 1 | the reconciler's default policy |
| `SERVICE_ADMISSION_DEADLINE_MS_DEFAULT` | 0 | 1 | the same |
| **`writeServiceInstanceStatus`** | **2** | **3** — **4 at the merged head** | ★ the deadline is the THIRD entry point onto the ONE writer of that column. SVC-007a's `terminalizeServiceInstanceForCancelledAttempt`, merged in after this ticket's head was measured, is the FOURTH — which is the point of funnelling them: four entry points, still ONE writer and one idea of a legal move |
| `predecessorsOf` | 1 | 2 | SVC-003a's decider, and now the deadline |
| `applyServiceProjectionForFence` | 1 | 1 | UNCHANGED |
| `createServiceReconciler` | 2 | 2 | UNCHANGED — the tick gained a pass, not a composition site |
| `recordServiceHealth` | 2 | 2 | UNCHANGED |
| `reapExpiredLeases` | 3 | 3 | UNCHANGED — and that is the point of `L-T8` |
| `createStartupReconciler` (cautionary neighbour) | 0 | 0 | untouched; still zero |

The chain above `sweepOrganizationServiceLiveness` is pre-existing and shipped:
`server/src/index.ts` → `createServiceReconciler` → `tick()` on a `nextDelayMs` backoff timer,
inside the `config.distributedExecutionEnabled && distributedExecutionDatabases` block, stopped on
SIGTERM/SIGINT. This unit adds **no new composition site**; it adds a pass to a timer that already
runs. `L-T1` is the case that proves it, and mutant **L6** is the case that proves `L-T1` proves it.

---

## 4. Reds observed, and the NAMED POSITIVE CONTROL

**★ HOW THE REDS WERE OBSERVED, stated so they are not over-read.** There is **no genuine base-tree
red** in this unit, and that is said first. The module under test does not exist at base, so a suite
run against base reds on "cannot import", which proves nothing about the shipped path — SVC-008b's
lesson, restated by SVC-003a. **Every red below is a mutation result** against a green unmutated
baseline measured immediately before and immediately after the campaign.

**THE HARNESS, and it refuses both of the ways SVC-003a's failed.** (i) `apply` REFUSES when a
`.mutbak` already exists, so a stray second apply cannot save an already-mutated file as
"original" and stack mutants. (ii) Every failure path restores BEFORE reporting, and `restore`
byte-verifies the file equals the backup before deleting it — SVC-003a's harness threw after
writing, leaving a mutant on disk while the driver said `APPLY FAILED`. Each anchor is tried in
**both line-ending forms** and a miss THROWS before any write. ★ An earlier revision of this note
said `service-reconciler.ts` and `job-control.ts` were CRLF while the new
`service-liveness-deadline.ts` was LF. Re-measured at head with `git ls-files --eol`, **all three
are `i/lf` in the index and `w/crlf` in a Windows checkout** — the difference the note described
was the authoring checkout's own disk, not the tree. The both-forms attempt stays, because the
harness has to hold on either checkout. Repository mutants rebuild `dist` before the run, because
the server suite resolves `@armyofagents/db` through `dist` while vitest prints `src` paths.

**NAMED POSITIVE CONTROL: `L-T9 POSITIVE CONTROL — SVC-002's convergence is untouched by the
deadline`.** A service with no instance converges to exactly one, through the unchanged reconciler,
on a tick that also runs the sweep. **Green before, green after, and green under nineteen of the
twenty mutants — L7 is the exception and is not a survival, it is a non-run:** that mutant makes the
module throw at load, so neither suite collects and no case executes, the control included. Said
this way rather than as "green under all twenty", because a control that did not run is not a
control that held.

★ **AND ITS FIRST VERSION WAS NOT A CONTROL, WHICH IS THE LESSON OF THIS UNIT'S OWN CAMPAIGN.** It
also asserted `livenessScanned === 0` — an ORDERING fact, not a convergence one — so mutant **L10**
(sweep moved after the convergence pages) **reded the positive control itself**. A control that reds
under a mutant it is supposed to survive is not a control; it is a second case wearing the name, and
it would have made L10's result unreadable. The liveness counters moved to `L-T1`, where they
belong.

**TWENTY mutants over 28 cases** (15 pure + 13 integration). ★ The figures below were **re-measured
in one campaign after the last edit**, and that re-measurement is not a formality — it has now
corrected this table TWICE. An earlier pass ran while the suite held 25 cases and reported `L1` at
**10** red; after `L-T11` it was **11**; after the review fixes in §4b added `L-T12` and `L-T13` it
is **13**. The same pass moved `L6` from "1 red — and ONLY L-T1" to **2**. A count taken before the
last edit is a stale count that does not look stale. `BASELINE: 0 red of 28` before the campaign and
`FINAL BASELINE: 0 red of 28` after it.

| # | Mutant | Result |
|---|---|---|
| L1 | Invert the liveness comparison | **13 red** |
| L2 | `>=` instead of `>` on the liveness window | **1 red** — P3, the strictness boundary |
| L3 | Let the OBSERVED arm consult `createdAgeMs` too | **3 red** — ★ P4: a week-old healthy service is condemned by its age |
| **L4** | **Judge a never-observed instance under the SHORT window** (classifier) | **3 red** — ★★★ the collapse; L-T3 + P5 + P8 |
| **L5** | **Treat a missing observation as infinitely stale** | **5 red** — ★★★ the opposite collapse; P6 is "kill a brand-new instance on tick one" |
| **L6** | **Delete the sweep call site in `runTick`** | **2 red — L-T1 and L-T13, and nothing else.** ★ the arming discrimination: the only two cases that drive the real tick |
| L7 | Retarget the deadline at `stopped` | **HARD RED** — see below |
| L8 | Liveness default = the health-tick interval | **1 red** — P14 |
| L9 | Swap the two defaults | **1 red** — P15 |
| **L10** | **Run the sweep AFTER the convergence pages** | **1 red — and ONLY L-T1**, on `created === 1` |
| **L11** | **Move the stamp BELOW the `noop_same_status` return** | **1 red** — ★★★ L-T5: a working service's steady-state tick stops refreshing liveness |
| **L12** | **Move the stamp ABOVE the generation fence** | **1 red** — L-T6: a rolled-past worker holds its instance alive forever |
| L13 | Drop `nonTerminalServiceInstanceStatus()` from the sweep's WHERE | **1 red** — L-T7 |
| **L14** | **Delete the sweep's independent legality gate** | **1 red** — L-T10. ★ **it killed NOTHING on the first campaign; see §4a** |
| **L15** | **`COALESCE(last_observed_at, created_at)` in the sweep's SELECT** | **1 red** — ★★★ L-T3; the same collapse as L4, one layer down |
| L16 | Ignore the injected decider; terminalize every live instance | **4 red** |
| **L17** | **Expire the instance's lease alongside the status write** | **1 red** — ★★★ L-T11, the ownership clause |
| **L18** | **Revert the sweep's ORDER BY to `created_at`** (the pre-review state) | **1 red** — ★★★ L-T12, the starvation §4b(i) describes |
| **L19** | **Revert `nextDelayMs` to `created > 0`** (the pre-review state) | **1 red** — L-T13 |
| **L20** | **Drop the per-instance `onTerminalized` loop** | **1 red** — L-T13 |

**L7 is a HARD RED and is reported as one rather than as a count.** It retargets the deadline at
`stopped`, whose sole frozen predecessor is `stopping`, and the module's load-time coverage
assertion throws during collection:
`SVC-003b: the liveness deadline cannot reach stopped from ["pending"], so an instance stuck in one
of those statuses would be swept and then refused.` Both suites fail to load, so the JSON reporter
records zero tests rather than N failures. Stated this way because "0 red" in a table would read as
a survivor.

### 4a. ★★★ ONE MUTANT SURVIVED THE FIRST CAMPAIGN, AND IT IS RECORDED RATHER THAN DROPPED

**L14 killed nothing.** The sweep applies an independent legality gate — the same check
`applyServiceProjectionForFence` applies to a worker's payload, pointed at the control plane's own
verdict — and deleting it left all **24** cases of the suite as it then stood green. (24, not 26:
`L-T10` and `L-T11` did not exist yet. The number is stated as measured at that moment rather than
back-filled from the final suite size, because that is exactly the substitution §4's note about
`L1` warns about.)

The reason is structural, not an oversight in coverage: `lost` is reachable from **all six**
non-terminal statuses in the frozen table, and the sweep's population is exactly those six, so
through the shipped caller **the gate can never fire**. It was a vacuously-true clause, which is
this programme's recurring defect appearing inside the fix for a different one.

It was **kept and pinned**, not deleted, for the reason its twin is kept:
`sweepServiceInstanceLiveness` is a repository method, a decider is not more trusted than a worker's
payload, and SVC-004's restart path and SVC-005's stop path will call this surface with sets this
file does not control. `L-T10` performs the narrow call itself — the same shape SVC-002's T1c uses
for its composite idempotency key, which the reconciler likewise cannot reach — and L14 now reds
exactly that one case.

**Suites:** `server/src/__tests__/service-liveness-deadline.test.ts` (15 pure cases) and
`server/src/__tests__/service-liveness-deadline.integration.test.ts` (13 cases: real embedded
PostgreSQL, real poll/ACK-minted ACTIVE fence, the real shipped `reapExpiredLeases`, the real
`createServiceReconciler().tick()`).

---

## 4b. ★★★ CI AND REVIEW BOTH FOUND REAL DEFECTS IN THIS DIFF

CI's fail-closed fence-surface guard caught one **(0)**. External review of PR #413 raised three
more; **all three were verified against source before being believed. One was a real defect and is
fixed; one was a real observation whose proposed fix is not taken and is filed instead; one was a
real smaller defect and is fixed.**

**(i) ★★★ THE BOUNDED SWEEP STARVED, and it is PR #406's bug rebuilt one function along.** No
finding is filed for it: the defect existed only in this diff and is gone from it, and nothing else
in the tree carries it. What is worth recording is how it got there. The sweep read
`ORDER BY created_at ASC LIMIT 64`. A HEALTHY instance
NEVER LEAVES THE LIVE SET, so for a tenant with more than `limit` live instances the oldest-created
healthy rows filled the batch on every tick and **a silent instance created after them was never
inspected** — a stuck service the deadline itself cannot see, which is the exact failure the ticket
exists to remove.

★ **AND MY OWN COMMENT ASSERTED THE OPPOSITE**: *"Ordered oldest-created first so a tenant with more
stale instances than one batch holds makes deterministic progress instead of re-reading the same
window."* That is true only of rows that LEAVE the population when handled, and healthy rows never
do. It is the identical error `listReconcilableServices` shipped and review caught on PR #406, whose
own correction note is in this very file — *"a converged service stays `desired_state='running'`
forever, so the same lowest-id rows filled every page on every tick and every later service was
NEVER reconciled — silently"*. I read that note while writing this function and rebuilt the bug
beside it. **A lesson recorded in a neighbouring comment is not a lesson applied.**

The fix is `ORDER BY COALESCE(last_observed_at, created_at) ASC`: a healthy instance is refreshed
every ~10 s and sinks to the back, while an instance that has gone quiet floats to the front within
one tick. No cursor, and — importantly — **no second copy of the policy**. ★ The `COALESCE` here is
an ORDERING, not a verdict, and that distinction is precisely mutant L15's: L15 collapses the two
instants in the SELECT, the value the decider judges, and kills starting services; this one decides
only which row is looked at first, and the verdict still reads the two ages separately (`L-T3` still
holds). `L-T12` is the regression case and `L18` is the mutant that restores the defect.

**(ii) A `lost` row records the STATUS and not the AUTHOR.** True, and now materially so: SVC-003b
creates a SECOND author for `lost`, and a worker-reported loss leaves a `job_projection_receipts`
row while a deadline kill leaves nothing. The reviewed fix — an `activity_log` write from the sweep
— is **not taken**: measured, **no repository method under `packages/db/src/repositories/tenant/`
writes `activity_log` at all**, so it would be a new convention entering the layer through its least
prominent door. The instance-specific half IS delivered (`onTerminalized`, one call per condemned
instance, logged at the composition root with the row's identity and the status it left). **The
durable half is not, and is filed as E9-F009** with the in-house route named — a `db:generate`
widening of `job_projection_receipts_projection_kind_check`, exactly as SVC-003a's `0277` widened it,
with `deadline:{serviceInstanceId}` as the source identity. Half a clause is not the clause, so
nothing is claimed closed.

**(0) ★★★ AND BEFORE THOSE THREE, CI CAUGHT SOMETHING NO REVIEWER DID, AND THE LESSON IS ABOUT
WHAT I RAN.** `verify (1)` went red on
`server/src/__tests__/job-fence-surface.contract.test.ts` — *"keeps the returned repository object a
CLOSED method surface (fail-closed on new methods)"*. Adding `sweepServiceInstanceLiveness` to
`JobControlRepository` without classifying it in that test's `EXPECTED_UNGUARDED` list is exactly
what the guard exists to refuse, and it refused it. **The guard worked; my local verification did
not**, because I ran the suites I wrote plus their neighbours rather than the guards a new
repository method trips. *In a tree with fail-closed inventory guards, running the suites you touched
is not running the suites your change touches.*

The method is now classified with its reason: it is the SAME SPECIES as `reapExpiredLeases`,
`recordOrphanQuarantine` and `classifyLeaseTruth` — it acts precisely WHEN the fence is gone, has no
lease id or worker to name, and a `guardActiveFence` on it would be unsatisfiable rather than
stricter, i.e. a dead lever. Its safety is the live-set predicate, `FOR UPDATE SKIP LOCKED`, the
server-computed frozen predecessor set, and the conditional write through the one shared writer.

★ **AND THE SAME EDIT CORRECTED A COMMENT THAT HAD GONE FALSE.** That list carried
*"`recordServiceHealth` stays the sole (and guarded) writer of instance status"*, true when SVC-002
wrote it and untrue since SVC-003a. There are now three authors, all funnelling through one inner
writer. Left uncorrected it would have been another record disagreeing with the code it describes.

**(iii) A terminalizing tick backed off to the IDLE delay.** `nextDelayMs` read only
`result.created`. If the sweep consumes the tick budget the convergence pages are skipped entirely,
so `created` is 0 on a tick that has just made known work available — and the loop waited 30 s. It
cannot busy-loop the other way: a terminalized row has left the live set, so the next tick condemns
it never again. `L-T13`(b) drives it on a synthetic result with `created: 0`, deliberately, because
a real tick here also creates the replacement and a case that could not separate the two would pass
under the reverted predicate for the wrong reason. Mutants `L19` and `L20`.

---

## 5. Deviations and judgement calls, each with its reason

**5.1 — the column is `last_observed_at`, not the reserved `last_health_at`.** SVC-002's schema
header reserved `last_health_at` for SVC-003 on the assumption that `service_health` would be its
only writer. It is not: EVERY attributed service observation witnesses that the worker is alive, and
the deadline must age against the last time the worker was seen AT ALL. A column called
`last_health_at` written by `service_instance_started` and `attempt_started` too would be a lie in
its own name. The rename is recorded in the schema header beside the original reservation.
`started_at` stays unadded — SVC-004's restart history needs it and nothing here reads it.

**5.2 — NULLABLE with NO DEFAULT, and that is the safety property rather than an omission.**
`DEFAULT now()` would forge an observation at INSERT time: the reconciler creating a row is not the
worker being seen. NULL means "never observed", which is aged against `created_at` under the
separate admission window — §4 of the design, mutants L4/L5/L15.

**5.3 — the stamp is written on events that move NOTHING, and its POSITION is the design.** After
the three fences (attribution / identity / generation), before the three no-write arms
(`noop_same_status` / `noop_already_terminal` / `illegal_transition`). The steady state of a healthy
service is `noop_same_status` forever, so a stamp gated on a real status move would go stale on
every WORKING service. An event refused by a fence is not evidence about the row, so stamping above
one would hand a rolled-past worker a way to stay alive. Mutants L11 and L12.

**5.4 — the ages are computed in SQL, in the same `clock_timestamp()` that wrote the column.**
Ageing against a JavaScript clock would measure app/database skew on top of elapsed time. The
classifier stays a pure function of two numbers, so it needs no mocked clock.

**5.5 — the migration is `db:generate` output plus a C14 class (a) guard.**
`0278_service_instance_last_observed_at.sql` is one `ALTER TABLE ... ADD COLUMN`, hand-appended with
`IF NOT EXISTS` for the measured reason 0275 states: migration-idempotency's static check matches
only `/^\s*CREATE (UNIQUE )?(TABLE|INDEX)\s+"/`, so a bare `ADD COLUMN` is covered by no static
check and a re-apply raises 42701. No class (b) block: `service_instances` is an already-registered
relation whose grants, RLS and policy are in place, and adding a column changes no ACL. Only the
generated filename was renamed (and its `_journal.json` tag with it), matching 0275/0277's
precedent.

**5.6 — no new index, AND THE COST THAT CHOICE CARRIES IS STATED RATHER THAN LEFT TO BE FOUND.** The
sweep's population is the LIVE instances per organization, and `service_instances_live_service_uq`
is already a partial unique index on `(organization_id, service_id)` with exactly that predicate, so
the FILTER is served. ★ The SORT is not: §4b(i)'s fix orders by
`COALESCE(last_observed_at, created_at)`, which is an expression no existing index covers, so
PostgreSQL narrows through the partial index and then sorts that organization's live set on every
tick before applying `LIMIT`.

Accepted deliberately, with the reason and the exit both named. **Today the cost is zero**:
`repos.services.insert` has zero production callers, so the live set is empty on every real
deployment, and the population is in any case bounded by ONE live instance per service (that is what
the partial unique index enforces) rather than by instance history. The fix, if it is ever needed,
is one `db:generate` expression index on
`(organization_id, COALESCE(last_observed_at, created_at))` with the same partial predicate — no
hand-authored DDL. **This should be re-measured with `EXPLAIN` the moment SVC-007 makes services
creatable**, which is the same discipline PR #406's review applied when it caught a generic plan
dropping this table's partial index; adding an index now against a population of zero would be
optimising a plan nobody has observed.

**5.7 — `FOR UPDATE SKIP LOCKED`, and skipping is CORRECT rather than merely convenient.** A row
another transaction holds locked is one an event ingest is projecting onto right now, which is
positive evidence its worker is alive. Skipping cannot be a false negative in the dangerous
direction: the sweep never terminalizes an instance it could not inspect, and a genuinely silent
instance is never locked.

**5.8 — the target is `lost`, not `failed`.** The frozen table makes `lost` reachable from every
non-terminal status, which is exactly the swept population, so a deadline can never be refused as an
illegal move on a live row. `failed` is equally reachable but means the workload failed, and a
deadline knows nothing about the workload — only that the instance can no longer be accounted for,
which is what the frozen lifecycle names `lost`. A load-time assertion derives the coverage from the
frozen table rather than asserting it, so a table amendment that breaks the deadline cannot ship
quietly (mutant L7).

**5.9 — the defaults are 180 s / 600 s, and neither closes SVC-008 §9.3.** That section records the
health-tick interval as OPEN *because it interacts with SVC-003's liveness deadline*. Picking a
number here does not decide it. What IS decided and must survive any later ruling: the liveness
window is a MULTIPLE of the tick (180 s is eighteen 10 s ticks — one dropped tick must not kill a
working service, mutant L8), and the admission window is strictly longer, because a `pending`
instance is waiting for placement, a poll, an ACK, a sandbox create and a process launch, none of
which is bounded by a tick interval (mutant L9). Both are injectable at the composition root.

---

## 6. ★ THE THREE CLAUSES OF SVC-003 THIS UNIT DOES NOT DELIVER

Re-measured from `program-design.md`'s SVC-003 node at source, not inherited from SVC-003a §6. The
Outcome is a five-way conjunction: health (SVC-003a), liveness deadline (this unit), graceful stop,
checkpoint request, bounded lease renewal. **SVC-003 STAYS OPEN.**

1. **Graceful stop — NOT BUILT, and it is BLOCKED, not merely deferred.** Filed as **E9-F008**.
   `graceful_stop` is a frozen `CONTROL_COMMAND_KINDS` member, `job_control_commands_kind_check`
   permits it, `renewLease` surfaces it in both `cancelRequested` and the `dev.aoa.job/control-v1`
   extension, and the daemon's `control-commands.ts` classifies it — and **nothing in the tree
   produces one**. The only general-purpose producer, `queueGovernedControlCommand`, is narrowed at
   the TYPE level to `"product_approval_result" | "runtime_decision_result"`, so a producer needs a
   repository-interface widening as well. SVC-003a called this "SVC-005 owns the request side",
   which reads as a handoff; it is a missing producer plus an interface that refuses the kind.
2. **Checkpoint request — STRUCTURALLY UNAVAILABLE, confirmed at source.**
   `job_control_commands_kind_check` permits five of the six frozen kinds and omits `checkpoint`
   entirely, so the row cannot be written at all. Widening the CHECK must precede any producer.
   SVC-004. Also E9-F008.
3. **Bounded lease renewal — NOT CHANGED, and measured rather than restated.** Each renewal's EXTENT
   is bounded and always was (`renewLease` sets `expires_at = clock_timestamp() + leaseDurationMs`;
   `createJobLeaseRenewalService` clamps that to ≥ 1 s and defaults it to 300 s, and the repository
   clamps to ≥ 1 ms below it). The NUMBER of renewals is not: there is no
   renewal counter, no total-ownership budget, and no `ttl_deadline_at` on `service_instances` — the
   schema header reserves that column for SVC-005. Bounding the total therefore needs SVC-005's
   TTL/budget columns. ★ What this unit DOES add is a second pin on the negative half: the deadline,
   like the projection, writes exactly one table and never touches `leases` (`L-T11`, mutant L17).

**And the two acceptance clauses SVC-003a recorded as NOT BUILDABLE — re-verified at source, and
the verdict HOLDS with one number corrected.** `MemoryActor` (`server/src/services/memory-access.ts`)
has exactly five kinds — `founder`, `team_lead`, `team_member`, `commander`, `agent` — and **no
`service` kind**, so there is nothing for a memory/context callback to be authorized as. SVC-003a
adds that "no memory operation exists among the **ten** frozen worker operations";
`PROVIDER_OPERATIONS` has **eleven** members (`create`, `execute`, `cancel`, `kill`, `destroy`,
`list`, `inspect`, `reconcile_cleanup`, `checkpoint`, `restore`, `health`). The count was wrong and
**the claim is right**: none of the eleven is a memory operation. Not attempted, as instructed. The
network-partition test likewise stays unbuildable — no replica identity or partition detector exists
anywhere in the tree.

**No finding is closed.** E9-F002, E9-F003 and E9-F004 are untouched and stay `open`/`unowned`.
E9-F005 stays `resolved`, and **E9-F006 belongs to SVC-007a** and is untouched. **E9-F001 is
unaffected.** **THREE findings are OPENED** — the same three the header and §8 list, said here in
full rather than as a pair: **E9-F007** (the deadline terminalizes the instance and does not fence
the worker), **E9-F008** (three frozen control-command kinds have zero producers, one of them
unstorable, and a repository docstring says otherwise) and **E9-F009** (a `lost` row records the
STATUS and not the AUTHOR, so a deadline kill and a worker-reported loss are indistinguishable
after the fact).

---

## 7. ★ WHAT THIS DOES **NOT** EXERCISE, said before anyone over-reads it

**The leased attempt is a placed BATCH job, not a service job**, for the reason SVC-003a §7 gives:
leasing a real service job needs the fleet to advertise `workload.service` with a free service slot
AND the reconciler's submission to be placed by the placement loop. It weakens nothing here — the
sweep keys on the organization and on the instance's own status and timestamps and never on the
job's workload type, and the stamp keys on (job, attempt) attribution, whose independence from
workload type SVC-003a's T4 already pins.

**No worker actually goes silent in this suite.** Ages are back-dated in SQL rather than produced by
a real worker falling over, because a test that waited three minutes for a real liveness window is a
test nobody runs. What is real is everything the sweep touches: the constraints, the partial unique
index, the `FOR UPDATE SKIP LOCKED` read, the database-computed ages, the single writer, the real
`reapExpiredLeases`, the real ingest path for the stamp, and the whole
`createServiceReconciler().tick()`.

**★ `FOR UPDATE SKIP LOCKED` IS NOT DRIVEN BY A CONCURRENT TRANSACTION.** No case here holds a
second transaction's lock on an instance while the sweep reads. The clause it buys — "a row an
ingest is projecting onto right now is skipped, not raced" — is therefore argued in §5.7 and
enforced by PostgreSQL, not demonstrated. It is the cheapest thing to add next, alongside §4a's
observation that a gate no test can reach is a clause that is vacuously true.

**The starvation case is scaled down, deliberately and visibly.** `L-T12` uses FOUR live instances
against a batch limit of THREE, not sixty-five against sixty-four. The property is about the batch
BOUNDARY and not about an absolute count, and a case that seeded sixty-five instances would take
minutes to prove the same thing. Mutant `L18` is what makes the scaling honest: it restores the real
defect and the scaled case still reds.

**★ THE END-TO-END STORY IS STILL NOT JOINED, AND SAYING SO IS THE POINT.** SVC-008b proves a
service job is offered to a daemon and supervised as a service. SVC-003a proves those events project.
This unit proves the absence of those events terminalizes and replaces. **No suite anywhere covers
all three legs on one job**, and that stays true until SVC-007 gives a human a way to create a
service. It is not claimed here.

---

## 8. Register changes in this commit

- `scripts/gate-clause-wiring.json`: **added** `E9-4-service-liveness-deadline`, `wired`, symbol
  `sweepOrganizationServiceLiveness` (1 production caller, base 0). Six insert lines, no
  reformatting; the guard reported OK with 15 wired clauses at this ticket's head and reports
  **16** at the merged head, SVC-007a's `E9-4-service-create-and-desired-state` being the
  sixteenth.
- `docs/replatform/epics/E9-service-agents/findings.md`: **E9-F007 FILED** (`open`/`unowned`, HIGH —
  the worker is not fenced); **E9-F008 FILED** (`open`/`unowned`, MED — three frozen command kinds
  with zero producers); **E9-F009 FILED** (`open`/`unowned`, MED — a `lost` row records the status
  and not the author; the durable half of what review asked for, deliberately not built here). No
  existing finding's status changed.
- `scripts/finding-ownership.json`: **E9-F007, E9-F008 and E9-F009 keys ADDED** (`unowned`, each
  with its residual and resolve criterion). No key deleted — this unit closes nothing.
- `docs/replatform/epics/E9-service-agents/README.md`: one paragraph, above the exit-gate line.
- `packages/db/src/migrations/0278_service_instance_last_observed_at.sql` + `meta/` +
  `_journal.json` — `db:generate` output, renamed, with a C14 class (a) guard appended.
- `server/src/__tests__/job-fence-surface.contract.test.ts`: `sweepServiceInstanceLiveness`
  classified `UNGUARDED` with its reason (§4b(0)), and the stale
  *"`recordServiceHealth` stays the sole (and guarded) writer of instance status"* comment
  corrected. This is a REGISTER edit, not a test relaxation: the guard's equality still fails
  closed on the next unclassified method.
- `packages/db/src/__tests__/migration-idempotency.test.ts`: a named double-apply case for `0278`
  beside `0275`'s, asserting the column stays NULLABLE with no default. Observed red (42701) with
  the `IF NOT EXISTS` guard removed.
