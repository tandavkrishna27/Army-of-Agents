# MIG-002 — convergence · terrain (second slice)

**Status: TERRAIN ONLY. No design, no code.** The first slice
([`MIG-002-dial-terrain.md`](./MIG-002-dial-terrain.md) /
[`-design`](./MIG-002-dial-design.md) / [`-result`](./MIG-002-dial-result.md)) made the routing
dial live and per-sink, and explicitly deferred convergence. This is that deferral.

Line references are to `docs/replatform-program` at `d43b1d26f`.

---

> ## ★ REVISION 2 — the headline below was WRONG, and following it would have made things worse
>
> Revision 1 said "the machine is complete, it is simply never started", and concluded that
> wiring the sweeper would fix "the stranded-run half of gate clause 3". An adversarial pass
> refuted that, and I re-verified every leg by hand:
>
> **The reaper cannot converge a heartbeat RUN.** `onAttemptTerminal` — the hook that projects a
> distributed terminal back onto the run — **has exactly one producer, the worker's accepted
> event batch** (`worker-control.ts:100` is the only place it reaches a service; the codebase
> says so itself at `distributed-cancellation-port.ts:163`). `reapExpiredLeases` is a repository
> reaper doing row updates inside a tenant transaction. It emits no `job_events` row, so the
> projector never fires, so **the run stays `running`**.
>
> And the run is un-reapable by the other side too: the orphaned-run reaper stands down on
> `execution_owner = "distributed"` (`heartbeat.ts:2482`) *because the attempt projector is the
> terminal authority*. After a reaper-terminalized attempt, **that stated rationale is false** —
> the authority it defers to will never speak for this attempt. The run is stranded with its
> justification invalidated, which is worse than stranded with a pending authority.
>
> So wiring the sweeper alone buys the capacity slot and the lease/attempt/job terminal — real
> value — and does **not** buy run convergence. §3 below is corrected accordingly. An honest
> convergence slice needs the sweeper **and** a run-terminal path for reaper-terminalized
> attempts.
>
> **The drain is further away than revision 1 implied**, on four counts, all verified:
> **(a)** `listActiveAttempts` has no SQL anywhere, and its `DistributedExecutionActiveAttempt`
> shape is three strings — `organizationId`, `companyId`, `jobId` — with **no attemptId, no
> lease, no status**, so despite the name its unit of work is a job;
> **(b)** its rollback gate is wired at the WRONG GRAIN and typechecks: the drain declares and
> calls `assertRollbackSafe(organizationId)` (`job-distributed-drain.ts:50`, `:118`) while all
> three implementations take a **companyId** (`job-audit-bridge.ts:116`,
> `job-budget-cost-bridge.ts:108`, `job-output-bridge.ts`). Both are `(string) => Promise<void>`,
> and the drain's catch is bare — so a naively wired drain would mark EVERY organization
> `rollback_pending` and cancel nothing, while reporting a clean, deliberate sweep;
> **(c)** `DRAINED_STATUSES` counts `"cancelled"`, which is the no-live-lease branch that updates
> rows directly with no `job_events` append — i.e. it counts as "drained" the one outcome that
> strands a run, and it is the only status with no test;
> **(d)** `listAdmittedOrganizationIds` is a local `const` inside the flag block (`index.ts:586`,
> never exported), so a drain built on it cannot exist flag-off — the exact state a
> disable-drain is for.
>
> Also: `nextDelayMs` has **zero callers anywhere, including its own tests** (`job-control-sweeper.ts`
> :13/:46/:127 are the only hits), so half the sweeper's public interface is unexercised; and an
> Organization suspended while holding live leases is invisible to the enumerator — never
> scanned, never reported skipped.

## 1. Half the finding holds: the LEASE machine is complete and never started

Inherited deferral #2 says *"JOB-006's lease reaper has no live trigger … an attempt whose lease
expires without emitting a terminal event has no convergence path — its run stays `running`."*
That is true, and it understates how close the fix is.

Everything is built:

| Piece | State |
|---|---|
| `createJobControlSweeper` (`job-control-sweeper.ts:49`) | complete — one in-flight tick, bounded batches, fair rotating cursor, wall-clock tick budget, productive/idle backoff, **flag-off is a no-op that touches no database** |
| `JobReconciliationService.reapOrganization` (`job-reconciliation.ts:115-132`) | complete — `runInTenant` → `repos.jobControl.reapExpiredLeases(...)` under the authoritative locks |
| `createJobReconciliationService({ appDb })` | **already constructed in `index.ts`** (for the cancel port) |
| `listAdmittedOrganizationIds` (`index.ts:586-612`) | **already exists** — cursor-paged, bounded limit, `statement_timeout` capped at 750 ms, skips the platform Organization, requires ≥1 company |
| a scheduled tick loop | **the outbox worker's, 20 lines below at `index.ts:613-625`, is the precedent** |

So the sweeper's two dependencies are already in the file that would register it, and the
registration pattern is immediately adjacent. For the LEASE side, nothing has to be designed;
something has to be started. For the RUN side, revision 2 shows something still has to be built.

One small adapter is needed: the sweeper's `AdmittedOrganizationPage` is
`{ afterOrganizationId, limit }` (`job-control-sweeper.ts:25-28`) while the existing lister also
takes `statementTimeoutMs`. That is a defaulted argument, not a redesign.

## 2. Why this is safe — three independent reasons, all verified

Scheduling something that terminalizes work deserves more than "it looked fine".

**2.1 It reaps only leases that are already expired, by a DATABASE clock.**
`reapOrganization` takes `const now = await repos.jobControl.currentDatabaseTime()` and passes it
into `reapExpiredLeases` (`job-reconciliation.ts:119-126`). The comment is explicit: *"A FRESH
database clock anchors the immutable backoff (never JavaScript time)."* A healthy worker that
renews its lease is never a candidate, and control-plane clock skew cannot make it one.

**2.2 A superseded worker cannot land anything anyway.** Every worker write path is
fence-guarded and rejects `stale_fence`: the control-command ACK
(`job-control-ack.ts:133-147`), `artifact-commit.ts`, `artifact-transfer-grant.ts`,
`egress-proxy.ts`, `worker-control.ts`. So even if a reaped attempt's worker is still executing,
it cannot commit an artifact, upload an event, or reach the egress proxy. The failure mode is
wasted compute, not corrupted state.

**2.3 The wasted compute already has an owner.** REL-004 clause 3b's warm-sandbox reaper arms
(strand / reclaim / superseded) exist to reclaim provider resources left behind. Convergence and
resource reclamation are separate mechanisms and both now exist.

## 3. What it would actually fix

- **Inherited deferral #2, the LEASE half.** Its wording ("an attempt whose lease expires
  without emitting a terminal event has no convergence path") is satisfied for the attempt and
  not for the run it names.
- ~~The stranded-run half of gate clause 3.~~ **NO — see revision 2.** Reaping the lease does
  not terminalize the RUN, because the projector has exactly one producer and it is the worker.
  What reaping DOES buy is real but narrower: `reapExpiredLeases` is one of the three
  capacity-release sites (`job-control.ts:3251`), so it hands back the org concurrency slot —
  the general case of the specific leak fixed in the dial slice — and it terminalizes the
  lease/attempt/job so the row stops looking active.
- It does NOT remove the "manual per-run cancel" from the rollback runbook: that action exists
  to converge the RUN, which the reaper still cannot do.

## 4. What it does NOT fix, and must not be claimed to

- **`createDistributedExecutionDrain` stays unwired.** Its `listActiveAttempts` exists only as an
  interface member (`job-distributed-drain.ts:40`) and a call site (`:137`) — **there is no SQL
  implementation at all**, so wiring the drain is a strictly larger piece of work than wiring the
  sweeper, and the two should not be bundled.
- **`createExecutionTargetRevocationFanout` stays unwired**, while its producer is live (the
  Revoke control writes a `status:"pending"` row nothing reads). Filed separately.
- **The kill switch still has no write path** (REL-001/005), so rollback step 1 is still hand-SQL.

## 4b. REVISION 2 addendum — the projection bridge exists, and the reaper cannot reach it

There is already a standalone, reusable handler for exactly this: `canary-terminal-projection.ts`
turns an attempt terminal into a run terminal, and its header states the two properties that
make it the right target rather than a new writer:

* *"The ownership predicate lives here, in one place. A terminal projects onto a run ONLY when
  `execution_owner === "distributed"` … projecting onto [a legacy run] would make the projector a
  second authority for run state (Invariant 8)."*
* *"Evidence gathering is best-effort; the terminal is not … without that the run never latches,
  the issue lock is never released, and the agent pins at `running`, dragging every other run of
  that agent with it."* — i.e. the module already names the failure this slice exists to prevent.

So the shape is **one projection, two triggers** (worker ingest, and the reaper) rather than a
second run-terminal writer. That keeps Invariant 8 intact.

**But the reaper cannot supply the trigger.** `AttemptTerminalSignal` requires
`{organizationId, companyId, jobId, attemptId, terminalStatus}` (`job-events.ts:86-92`).
`ReapExpiredLeasesResult` is **counts only** — `{scanned, revoked, retried, deadLettered,
cancelled, finalized}` (`job-control.ts:722-729`). **No identities.** You cannot build a signal
from a count.

That sizes the slice honestly. It is not "start the sweeper"; it is:

1. `reapExpiredLeases` returns the identities of what it terminalized — a change to a tenant
   mutator that runs under the authoritative locks, so it needs care and its own proof;
2. the sweeper projects each one through the EXISTING `canary-terminal-projection` handler;
3. the sweeper is registered.

Step 1 is the real work and the real risk. Steps 2 and 3 are wiring.

## 5. The question a design must answer first

> **Does the sweeper get its own scheduler, or ride the outbox worker's tick?**

Both patterns are in `index.ts` already. A separate loop is more code but independently
observable and independently backed off; sharing a tick couples two cadences whose backoff
policies differ (the sweeper's `nextDelayMs` is its own). The sweeper was written expecting to
own its cadence, which argues for its own registration — but that is a design call, not a
terrain fact.

Secondary, and worth deciding explicitly: **the sweeper is flag-gated internally** (`enabled:
false` → a no-op that touches no database). So it can be registered unconditionally and stay
inert, or registered inside the distributed block. The warm-sandbox reaper precedent (REL-004
Lane D, moved to module scope because it is the only force-kill) and the outbox precedent (inside
the flag block) point in different directions, and the difference is not cosmetic — one of them
governs whether an operator's flag can silently disable convergence.

## 6. Traps

- **Do not bundle the drain with the sweeper.** §4 — the drain needs SQL that does not exist.
- **Do not reap on JavaScript time.** §2.1 — the database clock is what makes the predicate
  skew-proof, and it is easy to "simplify" away.
- **Do not assume registering it is enough.** The sweeper's `enabled` flag is a second door: a
  registration with `enabled` left false is a scheduled no-op, which is this programme's
  signature failure. Whatever the design chooses, a test must prove the composed sweeper actually
  ticks against a database.
- **Check the capacity interaction.** `reapExpiredLeases` releases the org slot; the dial slice
  just added a second release path on the legacy-after-convert exit. Both must be idempotent
  (`releaseAttemptCapacity` matches only `held` rows, so it is — but re-verify rather than assume).
