# SVC-003b — the liveness deadline: terrain, and the design it forced

**Epic:** E9 · **Lane:** B · **Base:** `053f90fc8` (`docs/replatform-program`)
**Predecessor:** [`SVC-003a-result.md`](./SVC-003a-result.md) · **Result:** [`SVC-003b-result.md`](./SVC-003b-result.md)

> ★ **THE ENUMERATION IN §1 WAS RE-MEASURED, NOT INHERITED.** SVC-003a §6 lists four undelivered
> clauses; this unit read `program-design.md`'s SVC-003 node at source and re-derived the
> conjunction, then measured each conjunct against the tree at `053f90fc8`. Where the
> re-measurement disagrees with SVC-003a, §1.1 says so.

---

## 1. The clause, re-measured at source

`docs/replatform/program-design.md`, node **SVC-003 — Long-session lease and health semantics**:

> **Outcome:** Add service health, **liveness deadline**, **graceful stop**, **checkpoint
> request**, and **bounded lease renewal** semantics.
> **Acceptance:** Health events do not extend ownership without a successful lease renewal;
> memory/context callbacks and connector refresh/materialization require the current fence;
> **unreachable workers are fenced and replaced by policy**.

Five Outcome conjuncts. SVC-003a delivered **health** and said so. This unit takes the four
that remain, and delivers **one** of them.

| # | Conjunct | State at `053f90fc8` | This unit |
|---|---|---|---|
| 1 | service health | delivered by SVC-003a | untouched |
| 2 | **liveness deadline** | **not built** | **DELIVERED** |
| 3 | graceful stop | request path has no producer | measured, **not built** — E9-F008 |
| 4 | checkpoint request | not persistable, no producer | measured, **not built** — E9-F008 |
| 5 | bounded lease renewal | per-renewal extent bounded; total unbounded | measured, **not changed** |

### 1.1 Two corrections to SVC-003a's own record, found by re-measuring

**(i) "the ten frozen worker operations" is ELEVEN.** SVC-003a §6 justifies declining the
memory/context clause partly on "no memory operation exists among the ten frozen worker
operations". `PROVIDER_OPERATIONS` (`packages/worker-protocol/src/capabilities.ts`) has **eleven**
members — `create`, `execute`, `cancel`, `kill`, `destroy`, `list`, `inspect`,
`reconcile_cleanup`, `checkpoint`, `restore`, `health`. The count is wrong; **the substantive
claim is right and survives re-measurement**: none of the eleven is a memory operation, and
`MemoryActor` (`server/src/services/memory-access.ts`) still has exactly five kinds —
`founder`, `team_lead`, `team_member`, `commander`, `agent` — with **no `service` kind**. So the
memory/context acceptance clause remains **NOT BUILDABLE**, for the reason SVC-003a gave, with the
number corrected.

**(ii) "graceful stop — SVC-005 owns the request side" understates it.** SVC-003a's phrasing reads
as a scope handoff. The measurement is stronger and is filed as **E9-F008**: `graceful_stop` is a
frozen `CONTROL_COMMAND_KINDS` member, it is permitted by `job_control_commands_kind_check`,
`renewLease` surfaces it, and the daemon classifies it — and **nothing in the tree produces one**.
The only general-purpose producer, `queueGovernedControlCommand`, is narrowed at the TYPE level to
`"product_approval_result" | "runtime_decision_result"`. It is not a handoff, it is a missing
producer plus an interface that refuses the kind.

---

## 2. Terrain: what happens today when a worker goes silent

Traced at `053f90fc8`, in the shipped source rather than from the tickets' prose.

### 2.1 The projection cannot see it, by construction

Every path SVC-003a built hangs off `applyServiceProjectionForFence`, which runs inside
`acceptEvent`, which runs when a worker POSTs a batch. A consumer that only runs when an event
arrives cannot notice that none did. This is not a gap in SVC-003a; it is the shape of a
projection.

### 2.2 The lease reaper terminalizes everything EXCEPT the instance

`reapExpiredLeases` (`packages/db/src/repositories/tenant/job-control.ts`) claims expired leases
`FOR UPDATE SKIP LOCKED`, revokes the fence, releases the attempt's capacity slot, and drives the
ATTEMPT and the JOB to a terminal state or a retry. It contains **no write to
`service_instances`**. So after a reap the instance keeps whatever status it last had, stays
inside `service_instances_live_service_uq`, and `listReconcilableServices` — whose `NOT EXISTS`
predicate is that index's — keeps filtering its service out of the sweep window forever. `L-T8`
drives the real reaper and measures this rather than asserting it.

### 2.3 ★★★ And the dangerous case never reaches the reaper at all

`runServiceLifecycle` (`packages/worker-daemon/src/supervisor/service-lifecycle.ts`), supervise
loop, health step: a `processStatus` read whose answer is `unknown` results in **`EMIT NOTHING`**.
The comment beside it is explicit that this is correct — a fabricated `healthy` is the failure
class the module exists to prevent, and *"a fabricated unhealthy is as wrong, and it would
additionally drive SVC-003 to kill a working service"* — and it closes with *"SVC-003 owns the
liveness DEADLINE policy."*

Meanwhile lease renewal runs on a **separate driver** (`packages/worker-daemon/src/lease/lease-renewal.ts`).
So a worker whose supervision has gone silent — an unreachable sandbox, `ProcessUnknownReason
"sandbox_unreachable"` — keeps renewing, holds a lease that never expires, and is **invisible to
`reapExpiredLeases` entirely**. No existing mechanism in the tree can see it.

That is the case this ticket is for, and it is why §3's placement question has only one answer.

---

## 3. Where the deadline lives, and why the other two placements cannot work

The brief put three candidates: the reconciler (SVC-002), the projection (SVC-003a), or beside the
lease reaper. **Taken: beside the reconciler, inside its own tick.**

**NOT the projection.** §2.1. Edge-triggered by events; the failure is their absence. A deadline
must be driven by a clock.

**NOT beside the lease reaper**, on two independent grounds, either of which settles it:

1. **It cannot see the case that matters.** §2.3. A reaper keyed on lease expiry is structurally
   blind to a worker that keeps renewing while its supervision is dead.
2. **It would need a fourth copy of a frozen list.** `reapExpiredLeases` is a `packages/db`
   repository method, and the legality authority `SERVICE_INSTANCE_TRANSITIONS` lives in
   `@armyofagents/worker-protocol`, which `packages/db` deliberately does not depend on — that
   dependency refusal is why the status CHECK and the live-instance index predicate are already
   hand-written copies. Putting the terminalization there means writing the table out a fourth
   time, which is exactly what SVC-003a refused when it put `predecessorsOf` on the server.

**BESIDE THE RECONCILER, AND IN ITS TICK.** The deadline is the OBSERVED side of the convergence
loop the reconciler already drives on the INTENDED side, and it needs precisely what a server-side
sweeper has: a clock, the frozen table, and the admitted-organization enumeration that tick already
performs. Running it AHEAD of the convergence pages, in the same organization iteration, is what
makes terminalize-then-replace **one tick instead of two timers**: the terminalized row leaves
`service_instances_live_service_uq`, and `listReconcilableServices` reads that index's predicate in
the very next statement. `L-T1` asserts both halves of that in one pass.

The split of labour inside it mirrors SVC-003a's: the **policy** is a pure server-side function
over two numbers (`classifyServiceInstanceLiveness`), the **transaction** is a repository method
holding the row lock and the single writer (`sweepServiceInstanceLiveness`), and the policy is
INJECTED into the transaction the same way `renewLease` takes `projectControlExtensions` and
`applyServiceProjectionForFence` takes `allowedFromStatuses`.

---

## 4. ★★★ Two windows, because "silent" and "unreadable" are different facts

SVC-008b's lesson governs: **an honest UNKNOWN that stalls beats a confident wrong verdict that
acts.** A deadline that terminalizes a LIVE instance because an observation was unreadable is worse
than the stuck instance it was fixing, because it turns a rare wedge into a routine kill.

So the deadline reads **two different columns under two different windows**, and neither ever
substitutes for the other:

| Input | Meaning | Window | Verdict |
|---|---|---|---|
| `last_observed_at` NOT NULL, age ≤ window | the worker was seen recently | `livenessDeadlineMs` | `fresh` — no write |
| `last_observed_at` NOT NULL, age > window | **seen, then went silent** | `livenessDeadlineMs` | `silent` — **terminalize** |
| `last_observed_at` NULL, `created_at` age ≤ window | never seen, still plausibly starting | `admissionDeadlineMs` | `awaiting_first_observation` — **honest stall** |
| `last_observed_at` NULL, `created_at` age > window | never seen, and the control plane has waited long enough | `admissionDeadlineMs` | `never_observed` — **terminalize** |

Both collapses are defects with names, and both are mutation-pinned:

* **Collapse onto creation** — `COALESCE(last_observed_at, created_at)` **in the value the verdict
  reads**, or `?? createdAgeMs` in the classifier — applies the SHORT window to an instance whose
  worker has simply not polled yet, and kills services that are merely starting. Mutants **L4**
  (classifier) and **L15** (the sweep's SELECT).
  ★ The same `COALESCE` appears legitimately in the sweep's **ORDER BY** (§6), and the distinction
  is the whole point: there it decides only WHICH ROW IS LOOKED AT FIRST, and the two ages are
  still projected and judged separately. L15 is what keeps the two uses from being confused.
* **Collapse onto infinity** (a missing observation treated as maximally stale) terminalizes a
  freshly created instance on the first tick, before any worker could reach it. Mutant **L5**.
* **The observed arm consulting `created_at` too** terminalizes every long-running healthy service,
  since a week-old instance is older than any admission window. Mutant **L3**.

`last_observed_at` is therefore **nullable with no default**. A `DEFAULT now()` would forge an
observation at INSERT time — the reconciler creating a row is not the worker being seen — and would
destroy the distinction the whole design rests on.

### 4.1 The stamp is written on events that move NOTHING, and that is the load-bearing part

The steady state of a HEALTHY service is `service_health healthy` arriving every
`SERVICE_HEALTH_TICK_MS_DEFAULT` (10 s) onto a row that is already `healthy` — i.e.
`noop_same_status`, for the life of the instance. A stamp written only alongside a real status MOVE
would go stale on every WORKING service and the deadline would terminalize exactly the population it
exists to protect. So the stamp sits **before** the three no-write arms (`noop_same_status`,
`noop_already_terminal`, `illegal_transition`) and **after** the three fences (attribution,
identity, generation) — an event refused by a fence is not evidence about this row, and letting it
stamp would give a rolled-past worker a way to hold its instance out of the deadline's reach
forever. Mutants **L11** and **L12** drive both halves of that position.

### 4.2 The ages are computed in SQL

`last_observed_at` is written with `clock_timestamp()`. Ageing it against a JavaScript `Date.now()`
would measure the skew between the app process and the database on top of the elapsed time — a
control plane running a few minutes ahead of its database would terminalize healthy services, one
running behind would never terminalize anything. Both ages come out of the same `clock_timestamp()`
that wrote the column. The classifier stays pure over two numbers, so it is testable without a
mocked clock that does not resemble production.

---

## 5. Deliberate non-goals, each with its owner

* **Replacement policy is SVC-004's.** Terminalizing is sufficient BY CONSTRUCTION — the row leaves
  the live index and SVC-002's unchanged reconciler does the rest. WHETHER a service that keeps
  dying should be replaced at all, and with what backoff, is the crash-loop clause and this unit has
  no opinion.
* **Fencing the worker is not done, and the residual is filed (E9-F007).** The sweep writes exactly
  one table, because E9's own acceptance sentence makes ownership `renewLease`'s and the reaper's.
  The replacement row is protected by SVC-003a's split-brain refusal; the old worker's external
  effects are not, and that is SVC-005's overlap clause reached one ticket early.
* **The health-tick interval stays an open question.** SVC-008 §9.3 records it as OPEN *because it
  interacts with SVC-003's liveness deadline*. Choosing a default here does not close it. What IS
  decided, and must survive any later ruling: the liveness window is a MULTIPLE of the tick, never a
  peer of it (mutant **L8**), and the admission window is strictly longer than the liveness window
  (mutant **L9**).

---

## 6. ★★★ The batch is BOUNDED, so its ORDER BY is a correctness property, not a preference

This section exists because the first version of this design got it wrong and external review of
PR #413 caught it. It is written as the rule rather than as an incident, because the rule is what a
later bounded sweeper needs.

**A bounded batch over a population that some members never leave will starve that population's
tail.** The sweep reads `LIMIT n` from the LIVE instances. A HEALTHY instance never leaves the live
set. So under `ORDER BY created_at ASC`, the `n` oldest-created healthy rows fill the batch on every
tick, forever, and a silent instance created after them is **never inspected** — which is a stuck
service the deadline itself cannot see, i.e. the failure this ticket exists to remove, reintroduced
by the fix for it.

This is not a new lesson in this repo. `listReconcilableServices` shipped the same shape and review
caught it on PR #406; its correction note lives a few hundred lines above the new query, in the same
file. *A lesson recorded in a neighbouring comment is not a lesson applied.*

**Two fixes were available and only one of them is free.** SVC-002 took the pair "rotating cursor +
make the window BE the work", and recorded that the second half is the load-bearing one. Here the
second half is not available cheaply: narrowing the window to condemnable rows means putting the two
deadline windows into SQL, which is a **second copy of the policy** — the thing this design keeps in
one pure function on purpose.

**So the ordering carries it instead:** `ORDER BY COALESCE(last_observed_at, created_at) ASC`. A
healthy instance is refreshed every health tick and therefore sinks to the back; an instance that
has gone quiet floats to the front within one tick and stays there until it is terminalized. The
window is always the most-likely-condemned rows, a condemned row leaves the live set, so every batch
is real work — the same property SVC-002's query filter buys, obtained from the sort instead.

★ **AND THE `COALESCE` IS AN ORDERING, NOT A VERDICT.** Mutant **L15** collapses the two instants in
the SELECT — the value the decider judges — and kills starting services; that mutant is what keeps
this legitimate use and that illegitimate one from being confused. `L-T12` is the starvation
regression case and **L18** restores the defect.
