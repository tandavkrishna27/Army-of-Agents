# MIG-002 — convergence · result (second slice)

**Start SHA** `3a28e5a5c` (the design commit) ·
**Terrain** [`MIG-002-convergence-terrain.md`](./MIG-002-convergence-terrain.md) (revision 2) ·
**Design** [`MIG-002-convergence-design.md`](./MIG-002-convergence-design.md) (D5 revised at
implementation) · **Branch** `docs/replatform-program` (PR #323).

**Status: inherited deferral #2 is CLOSED. The lease reaper has a live trigger, and a reaped
attempt now converges its heartbeat run.**

| # | Commit | Scope |
|---|---|---|
| 1 | `7a4865605` | terrain (revision 1) |
| 2 | `daab622d9` | terrain revision 2 — the headline was wrong |
| 3 | `3a28e5a5c` | design |
| 4 | `c7127a444` | part 1 — the reaper reports which attempts it terminalized |
| 5 | this | part 2 — the sweeper projects, and is started |

**17 mutants: 17 killed, 0 survived** (7 in part 1, 10 in part 2).

---

## 1. What was wrong, in the order it became clear

**Revision 1 of my own terrain was wrong**, and following it would have made things worse. I
wrote *"the machine is complete, it is simply never started"* and concluded that starting the
sweeper would fix the stranded run. An adversarial pass refuted it:

`onAttemptTerminal` — the hook that projects a distributed terminal onto a run — **has exactly
one producer, the worker's accepted event batch** (`worker-control.ts:100`; the codebase states
it at `distributed-cancellation-port.ts:163`). `reapExpiredLeases` does row updates inside a
tenant transaction and emits no `job_events` row, so the projector never fires.

Worse than incomplete: the orphaned-run reaper stands down on `execution_owner = "distributed"`
**because the attempt projector is the terminal authority**. After a reaper-terminalized attempt,
that stated rationale is false — the authority it defers to will never speak. Stranded with its
justification invalidated is worse than stranded with a pending one.

## 2. What made it tractable anyway

**The projection already existed**, and its header says why it must be reused rather than
duplicated: the ownership predicate lives there, so a second writer would make the projector a
second authority for run state. So: **one projection, two triggers.** The registration passes
`onAttemptTerminal` itself as the sweeper's `projectRunTerminal` — literally the same function
object, reached from the ingest hook and from the reaper.

**The reaper already had the identities.** It selects `{id, companyId, jobId, attemptId,
attemptNumber}` per expired lease under `SKIP LOCKED` and iterates them — and discarded them,
returning counts. That is the second time in this ticket that the value was already in hand: the
first slice found `resolveWorkloadPolicy`'s contract already carrying `sourceKind`.

## 3. The sharp edge: which attempts qualify

The run's terminal follows the **job**, not the attempt:

| Reap branch | Job | Listed? |
|---|---|---|
| worker succeeded then vanished | `succeeded` | yes → `succeeded` |
| cancelled / cancel_requested | `cancelled` | yes → `cancelled` |
| abandoned, retries exhausted | `dead_letter` | yes → `failed` |
| **abandoned, retry available** | stays open, successor created | **NO** |

Listing a retried attempt would make the sweeper project a run terminal for work that is about to
execute — **a two-executor bug manufactured by the fix.** That exclusion is mutant P1 and it dies.

## 4. Acceptance → named executable artifact

| # | Invariant | Artifact | Result |
|---|---|---|---|
| N1 | The reap result lists exactly what it terminalized, for all three terminal dispositions | `job-reconciliation.integration.test.ts` (embedded PostgreSQL) | pass |
| N2 | A retried attempt is NOT listed | same | pass |
| N3 | The six counts are unchanged; all three existing consumers untouched | they compile and pass unmodified | pass |
| N4 | One signal per terminalized attempt, carrying the sweep loop's Organization | `job-control-sweeper-projection.test.ts` | pass |
| N5 | A projection failure costs visibility, never the batch or the tick | same | pass |
| N6 | The sweeper decides nothing about ownership — it passes the signal through | same | pass |
| N7 | The composed root actually STARTS it: ticks on a loop, not disabled, shares the one enumerator, stops on SIGTERM/SIGINT | same (source contract on `index.ts`) | pass |
| N8 | `nextDelayMs` is exercised — it had **zero callers anywhere**, including its own tests | same + the registration uses it | pass |

## 5. Two corrections I made to my own work

**Terrain revision 2** (§1) — the headline claim, refuted before it reached code.

**D5, revised at implementation.** The design said register unconditionally and let the sweeper's
own `enabled` flag govern it, citing REL-004 Lane D (a safety net must not be disabled by an
unrelated operator knob). **That precedent does not transfer.** Flag-off allocates no `aoa_app`
pool at all — `distributedExecutionDatabases`' own comment says *"Flag-off skips … pool
allocation"* — and `reapOrganization` runs through `runInTenant` on that pool. A flag-off sweeper
has nothing to open. Convergence flag-off is **impossible, not disabled**, so registration goes
inside the block. REL-004's case was an asymmetry (minting ungated, reclaiming gated); here
minting and converging share one gate.

## 6. Limits, stated

1. **Flag-off convergence is impossible**, per §5. If an operator turns the flag off while
   distributed work is in flight, that work loses its convergence path — which is exactly why the
   rollback runbook says to keep `AOA_DISTRIBUTED_EXECUTION_ENABLED` set across a restart. The
   limit is structural, not a policy choice.
2. **An Organization suspended while holding live leases is invisible.**
   `listAdmittedOrganizationIds` requires `status = 'active'`, so a suspended tenant is never
   scanned and never reported skipped — a blind spot exactly where an operator has just suspended
   a misbehaving tenant. Out of scope here; worth its own ticket.
3. **The drain is still unwired**, and further away than it looks: `listActiveAttempts` has no
   SQL and its row shape carries no `attemptId`; its rollback gate calls
   `assertRollbackSafe(organizationId)` while all three implementations take a **companyId**
   (both `(string) => Promise<void>`, so it typechecks, and the drain's catch is bare — a naively
   wired drain would mark every Organization `rollback_pending` and cancel nothing *while
   reporting a clean sweep*); and `DRAINED_STATUSES` counts `"cancelled"`, the one outcome that
   strands a run, which is also the only status with no test.
4. **The revocation fan-out is still unwired while its producer is live** — the Revoke control
   writes a `status:"pending"` row nothing reads. Filed separately.
5. **`nextDelayMs`'s predicate is `revoked > 0`, not `scanned > 0`.** A tick that scans a lot and
   revokes nothing backs off as if idle. Probably right; now at least exercised.
6. **Not rehearsed live.** The D1 nonce is bumped so the two-replica lane drives the new reap
   return through its `_test/reap` route, but a deliberate "kill a worker, watch the run
   converge" rehearsal belongs with the Wave-4 cutover.
