# PR-B Thread-Action Outbox: Root Cause & Invariant Consolidation

**Status:** design / roadmap. Authored after 8 Codex review rounds on PR #203.

## The root generator (why eight rounds, not eight bugs)

The producing **run** was an *implicit aggregate lock*. Because every `thread_agent_actions` row was only ever touched by the one run that proposed it, that run silently enforced **seven** independent properties at once:

1. **run-success gating** — only a succeeded run's side-effects commit
2. **freshness currency** — the world hasn't moved since propose
3. **exactly-once identity** — a side-effect commits once
4. **drainage** — a committable row gets picked up
5. **crash-liveness** — a dead producer is noticed
6. **concurrency-ownership** — one writer per row
7. **turn / cursor boundary** — the controller's notion of "new input"

PR-B dropped `eq(runId)` from the commit SELECT to fix a real liveness hole (a row stranded by a dead run could *only* be flushed by that same dead run). But dropping it **unbundled all seven properties simultaneously**, without first deciding which belongs to the *run*, which to the *thread*, and which to the *turn*. Every property the run-lock had given for free then had to be re-coupled **explicitly — one review round per property**:

| Property | Re-coupled by | Round |
|---|---|---|
| exactly-once identity | run-independent turn-anchored keys + `source_action_id` unique indexes | PR-A |
| concurrency-ownership | fenced CAS (`claimActionForCommit`) + claim-before-suppress reorder | #2, #7 |
| freshness currency | per-row freshness snapshot + revive re-stamps it | #3 |
| run-success gating | the **SEAL** (`proposed→ready` on run success, by durable key-set) | #4 |
| drainage | seal/re-seal arm `pendingRun` | #5, #8 |
| crash-liveness | zombie TTL + Step-2 self-heal (idle-lease = #204) | #6 |
| status contract | `ready` must be a declared status | #9 |
| turn / cursor boundary | agent output must not open a turn | #10 |

**The model the code converged on is correct.** This is convergence discovered incrementally in review, not a wrong architecture. The keep-list is sound and load-bearing: the SEAL producer-gate, the thread-scoped drain, the fenced CAS, the `source_action_id` idempotency indexes, and the per-row freshness snapshot. **A from-scratch rewrite is the failure mode, not the fix.**

## The clean model: one invariant, one owner

| Invariant | Single owner (target) |
|---|---|
| producer→committable lifecycle | one status state-machine whose alphabet (incl. `ready`) is the single source of truth the DB write, shared const, and transition fn all derive from |
| per-row currency | the freshness snapshot **on the row**, sole staleness gate; revive always re-stamps |
| concurrency-ownership | a fenced CAS that is the *only* way to transition a row (claim strictly before any conditional write) |
| drainage | the lifecycle: a transition into `ready` arms `pendingRun` in the same write |
| crash-liveness | an explicit lease/heartbeat (#204) — crash observed, not guessed |
| turn boundary | the controller runs on new **non-controller** input only; its own output advances the cursor without opening a turn |

## Scope

### In #203 (this PR) — C1 only: status contract gets one owner

`ready` is persisted by the seal but absent from `THREAD_AGENT_ACTION_STATUSES`
(`packages/shared/src/constants.ts`). The column is free `text` so it persists, but
`ThreadAgentActionStatus` (used by the typed `updateActionStatus`) treats `ready` as
impossible — a latent type-vs-state divergence (Codex #9).

- Add `"ready"` to `THREAD_AGENT_ACTION_STATUSES` (the single source of truth).
- Annotate the bulk raw `.set({ status: ... })` writes in `sealRunActions`,
  `gcOrphanedProposedActions`, `claimActionForCommit`, and `reapStaleThreadAgentActions`
  with `satisfies ThreadAgentActionStatus`, so any future unlisted persisted status is a
  **compile error**, not a runtime surprise.

Low blast radius (additive enum value + type annotations). Closes #9 as a class.

### Follow-up consolidation PR (not #203) — real blast radius, own concurrency proofs

These touch the runner commit path and/or the turn model and must ship with their own
real-DB concurrency proofs. They retire whole edge *classes* rather than patch instances:

1. **Collapse the dual write-authority.** Convert direct/mention runs (which currently
   self-flush `commitThreadAgentActions` in `runner.ts`) to *seal-then-arm-pendingRun*, so a
   **single consumer** (`runControllerSweep`) drains every thread. This demotes the fenced
   CAS from primary serializer to defense-in-depth and structurally retires the
   clobber class (#7). It also makes the turn-boundary reasoning sound (no concurrent
   committers / interleaved agent runs to reason about).

2. **C2 — turn boundary (Codex #10), done on the single-consumer model.** The controller
   runs Adjutant only on new **non-controller-authored** input; its own reply (the single
   per-company Adjutant agent is identifiable) advances the cursor without opening a turn,
   while *other* agents' replies remain legitimate cascade (hopCount-bounded). Must never
   skip a human entry, and must not skip a concurrently-posted other-agent reply — both of
   which are far easier to guarantee once a single consumer owns the thread. Interim: #10 is
   bounded by hopCount (extra self-runs, not a correctness bug).

3. **Atomic seal + run-status** (with retry, keeping GC re-seal as the crash net) — together
   with move #1, since they share the runner commit path. Makes the in-band seal the only
   routine seal path and demotes GC re-seal to a rare-crash safety net.

4. **Land #204** (run-liveness idle-lease/heartbeat column), then delete the 2h zombie
   start-age proxy + the Step-2 self-heal and collapse the four-step ordered GC into a single
   "expire stale committing-claims" sweep — retiring #6 and most of the GC's accidental complexity.

5. **Status machine from one definition** — DB write, shared const, and a total
   transition fn derive from one declaration so they can never desync again (durable #9);
   and "becoming `ready`" atomically arms drainage everywhere (durable #8).

6. **Housekeeping:** `create_scope_output` / `request_thread_workspace` are in
   `THREAD_AGENT_ACTION_TYPES` but have no commit handler (fall through to
   `unsupported_action`) — confirm intentional or wire them.

### Never
A from-scratch outbox rewrite, or relitigating Decision #99/#100/#102. The keep-list is correct.

## Risks (from the root-cause investigation)
- Dual-authority collapse reroutes the direct/mention commit path; mis-scoped, it could starve
  direct-participation threads. Ship with its own real-DB concurrency proofs.
- Atomic seal+status widens a tx boundary; a seal throw must not roll back a legitimately
  completed run — keep GC re-seal as the crash net even after it lands.
- C2's cursor advance must advance past *only* controller-authored entries, never human ones,
  and not skip a concurrently-posted other-agent reply.
- Deferring #204 keeps the 2h zombie TTL + self-heal live; confirm no realistic
  `controller_action_gate` run approaches 2h (non-lossy but adds ≤2-min latency on a false-reap).
- Removing the `runEpoch` turn-gate as redundant is only safe if the per-row freshness snapshot
  truly subsumes it on every path — prove before deleting.
