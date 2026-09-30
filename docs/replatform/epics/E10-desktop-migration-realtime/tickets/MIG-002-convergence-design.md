# MIG-002 — convergence · design (second slice)

**Terrain** [`MIG-002-convergence-terrain.md`](./MIG-002-convergence-terrain.md) (read revision 2
first — revision 1's headline was refuted) · **Branch** `docs/replatform-program` (PR #323) ·
**Wave 4 item 1, second slice.**

Scope: give a reaped attempt a path back to its **run**. The drain, the revocation fan-out, and a
kill-switch write path stay out (§6).

---

## 1. The shape, and why it is smaller than it looks

Terrain revision 2 established the constraint: `onAttemptTerminal` has exactly one producer (the
worker's event batch), so `reapExpiredLeases` terminalizing an attempt leaves the **run** pinned
at `running` — and worse, invalidates the stated rationale for the orphaned-run reaper standing
down on `execution_owner = "distributed"`.

Two facts make the fix tractable rather than a redesign:

**The projection already exists and is the right target.** `canary-terminal-projection.ts` turns
an attempt terminal into a run terminal, and its header states why it must be reused rather than
duplicated: *"The ownership predicate lives here, in one place … projecting onto [a legacy run]
would make the projector a second authority for run state (Invariant 8)."* So the design is **one
projection, two triggers** — worker ingest, and the reaper — never a second run-terminal writer.

**The reaper already has the identities.** `reapExpiredLeases` selects
`{id, companyId, jobId, attemptId, attemptNumber}` per expired lease under `SKIP LOCKED`
(`job-control.ts:3189-3195`) and iterates them. It simply **discards** them, returning counts
only (`:722-729`).

That is the same shape as this ticket's first slice, where `resolveWorkloadPolicy`'s contract
already carried `sourceKind` and the rollout source discarded it. Twice in one ticket, the value
was already in hand.

## 2. Decisions

**D1 — the reap result gains identities, ADDITIVELY.** `ReapExpiredLeasesResult` keeps its six
counts unchanged and gains `terminalized: ReadonlyArray<{ jobId, attemptId, companyId,
terminalStatus }>`. Additive because three consumers read the counts today
(`job-reconciliation.ts`, `job-fence-surface.contract.test.ts`,
`job-retry-capacity-transfer.integration.test.ts`) and none should change. The worker-daemon
reference is a comment only.

**D2 — only genuinely terminalized attempts are listed.** A reaped lease can end in a *retry*
(the attempt lives on) as well as a terminal disposition. Only the dispositions that make the
attempt terminal may appear, or the sweeper would project a run terminal for an attempt that is
about to run again — a two-executor bug manufactured by the fix. This is the sharpest correctness
risk in the slice and gets its own test and mutant.

**D3 — the sweeper projects, the repository does not.** The repository stays a pure mutator under
its locks; the projection is an after-commit concern, exactly as the ingest path already treats it
(*"JOB-005's ingest fires `onAttemptTerminal` once, AFTER the tenant transaction commits"*).
Projecting inside the lock would hold it across a second unit of work.

**D4 — per-attempt best-effort, per the projection's own rule.** The handler's header: *"Evidence
gathering is best-effort; the terminal is not … without that the run never latches, the issue
lock is never released, and the agent pins at `running`, dragging every other run of that agent
with it."* One attempt's projection failure must not abort the batch or the tick.

**D5 — REVISED AT IMPLEMENTATION. Registered INSIDE the distributed-execution block.**

~~Register unconditionally; the sweeper's own `enabled` flag governs it.~~ The original D5
argued this from the REL-004 Lane D precedent — the warm-sandbox reaper was moved out of the
heartbeat gate because an operator knob that advertises itself as governing *schedule ticks*
should not silently disable the only force-kill.

**That precedent does not transfer, and the reason is structural rather than a judgement call.**
Flag-off allocates **no `aoa_app` pool at all** — `distributedExecutionDatabases` is built only
when the flag is on, and its own comment says "Flag-off skips migration identity loading, URL
reads, and pool allocation." `reapOrganization` runs through `runInTenant` on that pool. So a
flag-off sweeper has nothing to open: convergence flag-off is **impossible**, not disabled.

The REL-004 case was an *asymmetry* (minting ungated, reclaiming gated). Here minting and
converging share one gate, so there is none — with one real exception, which is why the
rollback runbook already says what it says: if an operator turns the flag off while distributed
work is in flight, that work loses its convergence path. That is a genuine limit and it is
recorded in §4, not designed away.

> **The trap D5 walks past.** Registering it with `enabled` left false is a *scheduled no-op* —
> this programme's signature failure, one level in. So the acceptance below requires a test that
> the composed sweeper actually ticks against a database, not merely that it is registered.

## 3. Acceptance → named executable artifact

| # | Invariant | Artifact |
|---|---|---|
| N1 | The reap result lists exactly the attempts it terminalized | `job-reconciliation.integration.test.ts` (embedded PostgreSQL) |
| N2 | A **retried** attempt is NOT listed (D2) | same |
| N3 | The six counts are unchanged for every existing consumer | the three existing consumers compile + pass untouched |
| N4 | The sweeper projects one run terminal per terminalized attempt, through the EXISTING handler | `job-control-sweeper` unit test |
| N5 | A projection failure does not abort the batch or the tick (D4) | same |
| N6 | A legacy-owned run is never projected onto (the predicate stays in the handler) | inherited from `canary-terminal-projection`; asserted here so the second trigger cannot bypass it |
| N7 | The composed sweeper actually TICKS — not merely registered | registration test + a composed-tick assertion |
| N8 | `nextDelayMs` is exercised (today it has zero callers anywhere) | the tick loop uses it; unit test pins the productive/idle split |

Every guard mutation-tested. D1 nonce bumped: this schedules a loop that terminalizes work on the
two-replica lane.

## 4. What could still go wrong, stated

1. **A reaped-then-projected run is a NEW convergence path.** If a worker's terminal later
   arrives for the same attempt, the ingest projects a second time. The handler must be
   idempotent for that case — **UNVERIFIED, and the first thing implementation must check.**
2. **`nextDelayMs`'s predicate is `revoked > 0`, not `scanned > 0`** (`job-control-sweeper.ts:128`).
   A tick that scans a lot and revokes nothing backs off as if idle. Probably correct; recorded
   because it is unexercised today.
3. **An Organization suspended while holding live leases is invisible** to
   `listAdmittedOrganizationIds` (`status = 'active'`) — never scanned, never reported skipped.
   Out of scope, but it means convergence has a blind spot exactly where an operator has just
   suspended a misbehaving tenant.

## 5. Out of scope

The drain (its `listActiveAttempts` has no SQL, its rollback gate is wired at the wrong grain,
and `DRAINED_STATUSES` counts the one outcome that strands a run); the revocation fan-out; the
kill-switch write path. All recorded in the terrain with evidence.
