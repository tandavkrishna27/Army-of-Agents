# SVC-005a — the generation rollout fence (terrain + design)

**Status:** implemented. Terrain and design are in ONE file because **SVC-005 had ZERO files on
disk** — the same condition SVC-003 and SVC-007 were in, and the same answer those units gave.

**Scope:** the `services.generation` **writer** and the fence that makes writing it safe. This is
**Unit A of SVC-005**, not SVC-005. §7 enumerates what is left.

---

## 1. Terrain — what SVC-005 actually inherited, measured at `c27feeea8`

### 1.1 The handoff chain, and what each predecessor left

| Ticket | Commit | What it left SVC-005 |
|---|---|---|
| **SVC-002** | `b45b20c94` | The reconciler, and `lockServiceForReconcile` — which **pins `desired_state` AND `generation` under a row lock for the whole transaction**, explicitly so "a concurrent SVC-005 generation bump cannot land between this read and the insert". Its design says in terms: *"SVC-002 reads generation under a row lock and never bumps it; `services.generation` still has no writer after this ticket."* |
| **SVC-003a** | `053f90fc8` | The **stale-generation refusal** — `applyServiceProjectionForFence` step (3). The fence already refuses; SVC-005 supplies the writer. ★ It compares the worker's claim against the **INSTANCE's** generation, and its own comment says why: comparing against `services.generation` *"would refuse every event the moment SVC-005 bumps, including events from the instance that is legitimately being drained"*. **The bump lands exactly as that design anticipated.** |
| **SVC-003b** | `c27feeea8` | The liveness deadline — and, in the same commit, **E9-F007**, the hole this unit's fence exists to close. |
| **SVC-007a** | `7f95b1ae8` | `insertServiceGeneration`, which writes the immutable generation-**1** row and **deliberately does not bump**. `updateServiceDesiredState`'s docstring scopes the bump out to SVC-005 by name: minting a generation without SVC-005's fence *"is exactly the overlap E9's acceptance forbids"*. |

### 1.2 Does SVC-005 have files on disk?

**No. Zero.** `git ls-files | grep SVC-005` returns nothing at `c27feeea8`; the only on-disk
mentions are other tickets deferring work to it and the DE-12 register row naming it as an owner
with no ticket. So terrain and design are part of this unit's job, exactly as they were for
SVC-003a and SVC-007a.

### 1.3 The column

`services.generation` is `integer notNull default(1)`. Measured whole-tree at `c27feeea8`:

* **Read** as a WHERE predicate in ONE place: `serviceSourceIsAdmitted`.
* **Pinned** under a row lock in ONE place: `lockServiceForReconcile`.
* **Written**: nowhere. `update(services)` had exactly one occurrence — SVC-007a's
  `updateServiceDesiredState`, writing `desired_state`. **`update(services)` for `generation`
  appeared zero times.**

★ **A record that was already wrong.** DE-12's `deliveryEvidence` says *"the call `update(services)`
appears ZERO times anywhere in the tree outside comments"*. Re-measured at `c27feeea8`: it was
**one**, added by SVC-007a. The measurement predates SVC-007a and was never re-taken. Corrected by
a dated append rather than an edit, so the drift stays visible. See §6.

---

## 2. ★★★ The property, and why the column is not it

E9's acceptance for SVC-005 is:

> No two generations may perform external effects simultaneously.

That is a claim about **two processes**, not about an integer. Bumping the integer performs no
external effect at all. The dangerous moment is a generation N+1 instance **starting** while a
generation-N worker is still running. So the fence belongs at **placement**, and it is built out
of two facts:

**(A) Placement overlap is already structurally impossible, and not by anything this unit adds.**
`service_instances_live_service_uq` is a partial unique index permitting exactly one non-terminal
instance per `(organization, service)`, and `listReconcilableServices` filters on the
byte-identical predicate. So the reconciler **cannot** place generation N+1 while generation N's
instance is live, whatever `services.generation` says. Rolling the integer therefore yields
**replace-after-stop by construction**.

**(B) The hole is E9-F007.** SVC-003b's deadline drives an instance `lost` **by a clock** when its
worker has gone silent. The row leaves the live index — so (A) stops protecting anything — while
the worker *"may still be running and still performing external effects"* (E9-F007 §1). Placing
generation N+1 on the strength of such a row is exactly the overlap the clause forbids, reached by
a rollout instead of by a same-generation replacement.

---

## 3. ★★★ The answer to "what if the old worker is unreachable at the bump"

1. `rollServiceGeneration` mints generation N+1, bumps the column, and — if an instance is live —
   issues the **same** graceful stop SVC-007a's operator stop issues, all in **one transaction
   under the service's row lock**.
2. That stop is a **request**. It writes a `job_control_commands` row the worker collects on its
   next `renewLease`. An unreachable worker never collects it. **Nothing about step 1 establishes
   that the old process stopped, and the code does not pretend otherwise** — the route answers
   **202, not 200**.
3. Because the generation-N instance is still live, (A) holds and the reconciler places nothing.
   The rollout simply does not progress. An un-drained old generation blocks the new one.
4. Eventually SVC-003b's deadline condemns the silent instance by a clock, with
   `terminalized_by = 'liveness_deadline'` — an **assumption**. Now (B) applies and the reconciler
   answers `predecessor_generation_unwitnessed` instead of starting N+1.
5. **The stall clears** — it is a stall, not a wedge — when the old instance's **attempt** reaches
   a terminal status. `classifyFence` returns `attempt_terminal` **before any other test**
   (`packages/db/src/repositories/tenant/job-fence.ts`), so from that moment the old worker cannot
   write anything through the fenced ingest. Lease expiry plus `reapExpiredLeases` reaches that
   state **without the worker's cooperation**, so the stall is bounded by the lease TTL and the
   reaper interval rather than by the worker's goodwill.

★ **The residual, not claimed closed.** A closed fence stops the old worker **writing**. It does not
stop its **process**, and no control-plane fact can — E9-F007 §3 says so and this unit does not
overturn it. Filed as **E9-F012**.

---

## 4. The mechanism: `terminalized_by`

The fence needs to tell "the worker said it stopped" from "we gave up on it". E9-F009 recorded that
`service_instances` carries `status` and `updated_at` and **nothing that says who moved the row**,
and called that the "durable half" it deliberately left open. Migration **0279** is that half.

One nullable column, one CHECK, written **only when the status being written is terminal**, at the
single chokepoint `writeServiceInstanceStatus` — the one writer of `status`, which all **four call
sites** already funnel through (`applyServiceProjectionForFence`, `recordServiceHealth`,
`sweepServiceInstanceLiveness`, `terminalizeServiceInstanceForCancelledAttempt`). `author` is a
**required** parameter, so a fifth call site cannot arrive without classifying itself: the omission
is a typecheck failure.

| Author | Who | Witness? |
|---|---|---|
| `worker_stopped` | the worker's own fenced observation that the process **was seen gone** (`service_instance_stopped → stopped`) | **yes — the only one** |
| `worker_unconfirmed` | the worker's own fenced event that it **cannot account for** the process (`service_instance_lost`) | no — see below |
| `liveness_deadline` | SVC-003b's clock | no — E9-F007 |
| `control_plane_backstop` | SVC-007a's cancelled-attempt projection | no — its terminal attempt closes the fence, which is not the process stopping |

★★★ **THE WORKER'S EVENT IS SPLIT IN TWO, AND THE FIRST REVISION GOT THIS WRONG.** It had a single
`worker_event` author covering every terminal move the ingest applied, reasoning that an attributed,
fenced event is evidence. It is evidence — **of its authority, not of its content.** The daemon's own
header says what the two service terminals mean
(`packages/worker-daemon/src/supervisor/service-lifecycle.ts`):

> `service_instance_stopped` ← an observation of `exited` or `gone`.
> `service_instance_lost` ← `inspect` could not describe the sandbox, or **a full stop ladder ended
> with the process still observed `running`**.

So `service_instance_lost` is the worker reporting that **it could not confirm the stop** — in the
worst case that the process **survived cancel and kill**. Treating it as a witness would place
generation N+1 exactly when generation N's process is **known to be alive**: the overlap this fence
exists to refuse, admitted by the fence itself. **Found by external review of PR #415 (P1)**,
verified at that source, and fixed in the **author** rather than in the fence — the fence was right;
the author was lying. `R-T7c` is the regression case and it reds on the original defect while `R-T7`
stays green, which is exactly the asymmetry that let a fully green suite ship it.

★ **`WITNESSED_...` is derived by exclusion**, so a fifth author that nobody classifies makes the
fence **stall** rather than admit — and that held when the fourth author arrived: `T-P4` needed no
edit. NULL — a row terminalized before 0279 — is UNKNOWN and therefore not a witness. Both are the
fail-closed direction and both are pinned (`T-P2`, `T-P4`).

---

## 5. What ships

| File | What |
|---|---|
| `packages/db/src/schema/service_instances.ts` | `terminalized_by` + its CHECK, and the CHECK literal is reconciled against the constant by `T-P5c` |
| `packages/db/src/migrations/0279_service_instance_terminalized_by.sql` | `db:generate` output + C14 class (a) guards only |
| `packages/db/src/repositories/tenant/job-control.ts` | the author constants; `writeServiceInstanceStatus` gains required `author` and all four call sites classify; `bumpServiceGeneration`; `listUnwitnessedGenerationPredecessors` |
| `packages/db/src/index.ts` | barrel exports for the author constants |
| `server/src/services/service-generation-rollout.ts` | the roll, the pure classifier, `ROLLABLE_DESIRED_STATES` |
| `server/src/services/service-reconciler.ts` | step **4b** — the cross-generation placement fence — and its outcome reason |
| `server/src/services/service-management.ts` | `CANCELLED_ATTEMPT_PROJECTION` exported so the roll's drain shares ONE mapping |
| `server/src/routes/job-control.ts` | `POST …/services/:serviceId/generation` |
| `server/src/__tests__/job-fence-surface.contract.test.ts` | both new repository methods classified in the same commit |
| `server/src/__tests__/service-generation-rollout.test.ts` | 12 pure cases |
| `server/src/__tests__/service-generation-rollout.integration.test.ts` | 14 cases over embedded PostgreSQL |
| `scripts/gate-clause-wiring.json` | `E9-5-service-generation-rollout` |
| `scripts/finding-ownership.json` | **E9-F012** registered `unowned` with its resolve condition — required, and `check-distributed-execution-foundation.mjs` failed the policy gate until it was there (a cited finding must be owned) |
| `docs/architecture/distributed-execution-threat-controls.json` | DE-12 dated correction; **`deliveryStatus` unchanged** |
| `packages/db/src/migrations/meta/_journal.json` | the `0279` journal entry (tag renamed from drizzle-kit's generated slug) |
| `packages/db/src/migrations/meta/0279_snapshot.json` | `db:generate` output, unedited |
| `docs/replatform/epics/E9-service-agents/README.md` | the SVC-005a paragraph |
| `docs/replatform/epics/E9-service-agents/findings.md` | **E9-F012** filed; **E9-F009** gains a delivered/not-delivered split and stays OPEN |
| `SVC-005a-design.md` | this document |
| `SVC-005a-result.md` | the result note |

**20 files changed** — 13 modified plus 7 added — counted against `git diff --name-only` and
`git status --porcelain` **after the last edit**, not listed from memory. The count is stated so the
next edit has to keep it true.

---

## 6. Two decisions worth stating

**Why `POST …/generation` and not `PATCH …/services/:id`.** A roll is not an edit of a service; it
is the minting of a new **immutable** definition plus a rollout, and `aoa_app` holds only SELECT and
INSERT on `service_generations`. A PATCH-shaped route invites the mutate-in-place reading that the
immutability mechanism exists to refuse.

**Why the fence is narrow.** A **same-generation** replacement is *not* fenced. E9-F007 §3 ruled
that overlap the smaller harm against the permanent wedge of never terminalizing, and SVC-005a does
not reopen it — the acceptance clause is about two **generations**. `R-T6` is the named positive
control that proves the fence does not slow a same-generation replacement, and it is the only case
in either suite that reds when condition (1) is dropped.

---

## 7. ★★★ What is NOT delivered — SVC-005 stays OPEN

E9's Outcome for SVC-005 is *"operator pause/resume, worker drain, replace-before/after-stop policy
for a single replica, and hard runtime/spend limits"*, and its Acceptance is a conjunction. Per
conjunct:

* **Operator pause/resume** — partly, and by SVC-007a rather than here: its desired-state control
  already moves `running ⇄ paused` and drains on the way in. Nothing is added.
* **Worker drain** — **not delivered.** E9-F008 records that the frozen `drain` and `graceful_stop`
  command kinds have **zero producers** and that `queueGovernedControlCommand` is narrowed at the
  **type** level against them. The roll issues `cancel` (graceful), which is a different frozen kind.
* **Replace-before-stop** — **structurally unreachable** under `service_instances_live_service_uq`,
  which permits one live instance. Replace-**after**-stop is what this delivers. Stated rather than
  silently dropped: delivering before-stop needs the index predicate widened, which is the DE-12
  split brain itself.
* **Hard runtime/spend limits** — **not delivered.** `service_generations.ttl_seconds` exists and is
  written NULL by both generation writers, deliberately, because nothing enforces it.
* **Stuck-stop force-kill** — **not delivered.** It needs SVC-008a's `signalProcess` reachable from
  the control plane; no such channel exists.
* **"Budget/TTL stop is auditable and cannot be overridden by the worker"** — **not delivered**, and
  vacuous today since there is no budget/TTL stop.
* **"No two generations may perform external effects simultaneously"** — **the fenceable half only.**
  See §2, §3 and E9-F012. **The clause is not claimed.**

**E9's exit gate is NOT moved and is NOT claimed.** No service job is leased anywhere in this
unit's suites (E9-F002), so the daemon half is unexercised, exactly as SVC-007a and SVC-003b both
recorded for themselves.
