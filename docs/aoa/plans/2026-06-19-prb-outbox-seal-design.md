# Thread Action-Commit: Outbox Seal Design (PR-B completion)

> **Status:** REVIEWED — adversarial review (wf_65e3511f) = **GO after must-fixes**. Ready
> to implement once the must-fixes below are folded in + Decision #102 sign-off (§8).
> **Goal:** Close the *class* of cross-run action-commit bugs (Codex P1: failed-run
> side-effects leak through the thread-scoped drain) by completing the transactional
> outbox the codebase already locked in **Decision #99 / #102** — adding the missing
> producer-success gate (a "seal") that PR-B assumed but never built.

---

## 0. Review outcome (LOCKED 2026-06-19)

3-reviewer + judge adversarial review, all code-grounded. **Verdict: GO after must-fixes.**
The central premise was VERIFIED, not just asserted:

- **Proposed-writer audit = CLEAN (the design's load-bearing claim holds).** Exactly TWO
  production lines write `status='proposed'`: the INSERT (thread-agent-actions.ts:325) and the
  suppressed_stale revive (:363), both inside `proposeThreadAction`. Its only callers are the
  **6 crew MCP tools** (post_reply/advance_phase/convene_agent/create_artifact_candidate/
  add_scope_item/create_scope_draft), **all** fenced behind `discussionRunMode ===
  'controller_action_gate'` with a `runId`. **No MCP-inbound, no founder/board, no
  test-as-production writes `proposed`.** Every proposed row has a definite run
  succeeded/failed/cancelled outcome → a seal moment always exists → **no orphan-forever producer.**
- **Migration-free, relay genuinely runId-blind, index already covers `ready`** — all verified.

**MECHANISM: B (seal by the run's proposed key-set). A (runId re-home) is REJECTED** — its
concurrent-same-key race is reachable in production (participation/mention runs are NOT
serialized vs the controller; only controller-vs-controller is, via the pendingRun claim).
Interleave: X inserts `proposed(runId=X)`; Y re-selects + re-homes to runId=Y; X succeeds, seals
`WHERE runId=X` → 0 rows; Y fails → never seals → a SUCCEEDED action stranded forever. B seals
`WHERE idempotencyKey IN (run's keys) AND status='proposed'`, covering collided rows regardless
of runId. A also re-introduces the re-home #102 removed and perturbs `inspectRunPostReply`.

**CORRECTION (found at implementation start) — B → B′.** §0/§4 assumed the key-set is tracked
IN-MEMORY in the run context. NOT implementable: `proposeThreadAction` runs in the **mcp-bridge
subprocess** (`mcp-bridge.ts:353` main-module + `StdioServerTransport`, spawned per
`runner.ts:289`), while the seal runs in the **runner process** — no in-memory channel crosses
that boundary (the review read the code but missed the process split). **Corrected to B′:**
persist the run's proposed key-set durably on the run row (`internal_agent_runs.proposed_action_keys`
jsonb, migration `0147`). `proposeThreadAction` appends each `idempotencyKey` (sequential per
run → no concurrent-append race; recorded on collision too, so a re-proposed key still counts);
the runner/controller read it back on run success and seal by that key-set. Race-free, and LESS
plumbing than in-memory B (no ctx threading through the 6 tools). Cost: one additive migration —
the "migration-free" claim was predicated on the unimplementable in-memory B.

**MUST-FIX before/within implementation:**
1. **(BLOCKER) Controller seal gates on run SUCCESS.** thread-orchestration.ts commit (line
   **632**, not 619 — 619 is the stale-suppression log) is status-blind (`if (threadRow &&
   runResult.runId)`); controller-adjutant-runner.ts:149 returns `output.status` but it's unused.
   As-is a FAILED controller run still seals+commits → re-creates P1. Fix: type
   `AdjutantRunResult.output` as `{status: AoaRunStatus}` and gate BOTH the seal and the commit on
   `output.status === 'succeeded' && runResult.error == null`. Add a no-seal-on-failed-controller test.
2. **(BLOCKER) Revive stays `proposed`, never `ready`.** The suppressed_stale revive (359-371)
   runs mid-run (no run-success moment); reviving to `ready` makes it committable before THIS run
   succeeds. Revive to `proposed`; the key-set seal promotes it on success.
3. **(BLOCKER) Implement Mechanism B** (above).
4. **(MAJOR) Close the `completed`-run-but-unsealed window.** Run-row success status is
   **`completed`** not `succeeded` (runner.ts:568). If the seal crashes between the status write
   and the seal UPDATE, rows orphan under a `completed` run — matched by neither §6 GC nor the
   relay. Fix: seal in the SAME transaction as the run-status write (preferred), OR add a GC branch
   for `completed run + rows still proposed past TTL`. Use run-row vocabulary
   (`completed`/`failed`/`cancelled`/`running`), never the AoaRunStatus `succeeded` string.
5. **(MAJOR) Orphan GC mirrors #99 rule 3.** The time-branch must terminalize the linked run to
   `failed` FIRST (guarded on still-`running`), THEN delete/blocked_policy the row — so a still-alive
   long run cannot have a row deleted out from under its seal. `staleCutoff >= STALE_COMMITTING_TTL_MS`.
6. **(MAJOR→RESOLVED by B) `inspectRunPostReply`** (thread-participation-runner.ts:228-246)
   selects `WHERE runId = result.runId`; a hazard only under A's re-home. B leaves runId stable →
   resolved; add a test asserting it, don't let an A-style re-home sneak back.

**ACCEPTED residuals:**
- **Deploy: ship `ready`-only relay + seal atomically in ONE PR; SKIP the §7 two-phase superset.**
  #203 is pre-merge → no pre-existing `proposed` rows to protect. (If kept for paranoia, scope the
  superset to `proposed AND runId IN (running run ids)` so a failed run is never selected.)
- The sweep backstop relay (sweep-controller.ts) is SAFE/clean under `ready`-only (skips unsealed orphans).
- Direct self-flush seal→commit window: a concurrent drain may win the CAS first — benign
  (exactly-once via `source_action_id`); optionally seal+commit in one tx. Add an exactly-once test.
- **Decision #102 amendment needs founder/team sign-off** (decisions.md:743-745 literally defers to
  "drain orphaned `proposed` rows" — the mechanism we're refining). Do NOT edit decisions.md unilaterally.

> Sections below are the original design; where they conflict with §0 (esp. Mechanism A as default,
> the §7 two-phase superset, the line-619 cite), **§0 wins.**

---

## 1. Problem (verified)

`thread_agent_actions` is a durable action queue. Actions are written `status='proposed'`
**by a tool call during an agent run** (`proposeThreadAction`), then a committer applies
the side-effect (`commitThreadAgentActions`: post reply / create artifact / scope change /
convene / advance phase).

PR-B made the committer **thread-scoped** (dropped `eq(runId)`): any run / sweep drains
*every* `proposed` row for the thread. That is the relay half of an outbox, and it is
correct. But it broke the outbox's load-bearing invariant.

**Decision #99 invariant:** *"The committed `pending` row IS the work item."* In #99 this
holds for free because the `pending` row is written **inside the producer's transaction**
(`addEntry`) — a failed producer never leaves a row. A row in the queue therefore *always*
means "the producer committed."

**Thread actions violate this.** A `proposed` row is written mid-run, **decoupled from run
success**. `runner.ts` only flushes on `runResult.status === "succeeded"` (runner.ts:531-537);
a run that proposes a reply and then **fails / is cancelled** leaves the row `proposed`. The
thread-scoped drain then commits that **failed run's** side-effects (Codex P1, comment on
`thread-agent-actions.ts:410`).

The committer cannot tell, from a `proposed` row alone:

| Run lifecycle at drain time | Correct action | Today |
|---|---|---|
| succeeded-but-uncommitted (crash) | recover (commit) | commits ✓ |
| **failed / cancelled** | **drop** | **commits ✗ (P1)** |
| still in-flight | wait | may commit early ✗ |

`freshness` captures *staleness* (did the thread move on), not run **outcome**. Dropping
`eq(runId)` discarded the only run-lifecycle context the committer had. Every targeted patch
(run-status JOIN, cancel-on-fail, re-home) fixes one row of that table and leaves another
open — which is why this is the 5th consecutive cross-run hole on this PR.

---

## 2. Principle: move the gate to the producer (the seal)

An action becomes committable **only when its producing run reaches success.** We introduce
an explicit **seal** transition — the thread-action analogue of #99's "row exists only if the
producer's transaction committed."

```
 proposeThreadAction (tool call)      INSERT status = 'proposed'   (NOT committable)
 run SUCCEEDS                         SEAL  'proposed' -> 'ready'   (committable)
 relay drains (controller/sweep/      CLAIM 'ready'    -> 'committing'  (fenced CAS)
   direct self-flush)                 apply side-effect -> 'committed'
 transient side-effect failure        'committing' -> 'failed'      (retry, thread-scoped)
 run FAILS / CRASHES                  no seal: row stays 'proposed' -> GC'd, never committed
```

The relay's SELECT changes from `proposed | failed-retryable` to **`ready | failed-retryable`**.
Everything PR-B built — the fenced CAS claim, `source_action_id` idempotent side-effects, the
durable sweep, the per-action freshness re-check, the action-type-aware gate — is **kept**.
We are adding the producer gate those mechanisms assumed.

**Why this closes the class structurally:** an unsealed action is simply not in the relay's
SELECT. Failed-run leak, in-progress early-commit, and "which run owns this" all disappear —
there is nothing to gate against *at commit time*, because the gate now lives at the producer,
where run outcome is actually known. Crash recovery becomes "re-run the work" (re-propose +
re-seal), exactly as #99 resets a crashed extraction to `pending` rather than salvaging it.

---

## 3. State machine

```
                 tool call
                    │
                    ▼
   ┌──────────┐  run success   ┌────────┐  fenced CAS   ┌────────────┐  side-effect ok  ┌────────────┐
   │ proposed │ ─────────────▶ │ ready  │ ────────────▶ │ committing │ ───────────────▶ │ committed  │
   └──────────┘   (SEAL)       └────────┘   (CLAIM)      └────────────┘                  └────────────┘
        │                          │                          │  transient failure
        │ run fails/crashes        │ stale (freshness)        ▼
        │ (no seal)                ▼                       ┌────────┐  retry (thread-scoped,
        ▼                     ┌────────────────┐           │ failed │  idempotent, attempt-capped)
   ┌──────────┐  GC sweep     │ suppressed_stale│          └────────┘
   │ proposed │ ───────────▶  └────────────────┘               │
   │ (orphan) │  delete/term                                   └──▶ re-CLAIM 'ready|failed'
   └──────────┘
```

New status value: **`ready`** (text column; no enum migration). `proposed` keeps its meaning
(written by a tool call, *in-flight*, NOT committable). All other statuses unchanged.

---

## 4. Who seals, and how (the contentious part — review focus)

The seal is "mark the actions THIS run proposed as `ready`, on success." Two candidate
mechanisms; the re-propose / crash-recovery case is what separates them.

### Mechanism A — re-home unsealed rows + seal by runId *(proposed default)*

- `proposeThreadAction`, on idempotency-key conflict (`onConflictDoNothing` returns nothing),
  re-selects the existing row. **If that row is `status='proposed'` (unsealed), re-home it:
  `UPDATE runId = currentRun WHERE id = ? AND status = 'proposed'`** (status-fenced so a
  `ready`/`committing`/`committed`/terminal row is NEVER re-homed — only unsealed staged work
  can change owner).
- Run success seals run-scoped: `UPDATE status='ready' WHERE runId = currentRun AND status='proposed'`.
- Crash recovery: run X crashes leaving `proposed` (runId=X). Re-run Y re-proposes the same
  turn-anchored key → conflict → re-homes the row to Y → on Y's success it seals (runId=Y). ✓
- Failed run: never seals; its `proposed` rows are GC'd. ✓
- **Known edge:** two *concurrent* runs proposing the *same* key bounce the runId; the seal can
  miss it if the winning seal runs before the re-home settles. Narrow (same agent, same turn,
  same content, concurrent) — to be quantified in review.

### Mechanism B — seal by the run's own proposed key-set

- The run accumulates the idempotency keys it proposed this turn (server-side, per-run).
- Run success seals `WHERE idempotencyKey IN (keys) AND status='proposed'` — seals the run's
  own rows AND any collided rows regardless of runId; no re-home needed; concurrent dup-proposes
  both seal idempotently.
- **Cost:** per-run key accumulation must be threaded from the bridge tool handler through the
  runner; in-memory (lost on crash — fine, a crashed run doesn't seal anyway).

> **Open question for review:** A vs B. A reuses the row's `runId` as durable tracking (no
> in-memory state) but needs the status-fenced re-home and has the concurrent-same-key edge.
> B is cleaner for concurrency but adds per-run key plumbing. Lean A unless review finds the
> concurrent edge non-narrow.

### Seal call sites

- **Direct runs** (`payload.source !== "thread.controller"`, self-flush path, runner.ts:531):
  on `succeeded`, SEAL then commit (the direct run is its own relay). On non-success, **do not
  seal** (replaces the cancel-on-fail idea — no seal == not committable, no cancellation needed).
- **Controller runs** (`source === "thread.controller"`): the runner does not self-flush. On the
  controller run's success, `runController` SEALs the run's actions, then drains `ready`
  (thread-orchestration.ts:619). A failed controller run does not seal → its actions are not
  committed (today they are — this also fixes the un-flagged controller-path variant of P1).

---

## 5. Relay (committer) changes

`commitThreadAgentActions` SELECT (thread-agent-actions.ts:~388):

```
WHERE companyId, threadId, (
   status = 'ready'                                            -- sealed, committable
   OR (status = 'failed' AND attemptCount < maxAttempts        -- post-gate transient retry
       AND actionType NOT IN NON_IDEMPOTENT_RETRY_TYPES)
)
```

- `proposed` rows are **never** selected → failed/in-progress runs cannot leak. This is the
  whole fix.
- `failed` retry stays thread-scoped (already gated — it was `ready`, claimed, side-effect
  failed transiently; `source_action_id` makes retry idempotent). The #A non-idempotent
  exclusion stays.
- The fenced CAS claim changes `proposed→committing` to **`ready→committing`** (claim predicate
  `status='ready'`).
- The suppressed_stale revive (round-2) revives to **`ready`** now (a re-proposed sealed action),
  not `proposed` — but a revived row must have been sealed, so revive only applies to rows that
  reached `ready` then `suppressed_stale`. (Confirm in review: can a `proposed` row reach
  `suppressed_stale`? Today freshness suppresses inside the commit loop, which only sees
  committable rows → only `ready`. So suppressed_stale rows were always sealed. ✓ consistent.)

## 6. Orphan GC (failed/crashed `proposed` rows)

A sweep step (mirror #99's linked-run orphan recovery) deletes or terminalizes `proposed` rows
whose producing run is terminal-failed or stale:

```
proposed AND ( run.status IN ('failed','cancelled')
               OR (run is 'running' AND run.created_at < staleCutoff) )   -> delete (or status='blocked_policy', reason='run_orphaned')
```

This is the analogue of #99 rule 3 (terminalize the linked run + reset the work). Keeps the
table from accumulating unsealed orphans. Runs as part of `runControllerSweep`.

## 7. Deploy safety (two-phase, mirrors PR-B's fenced-CAS-first)

Adding `ready` is not single-deploy safe (in-flight `proposed` rows at cutover would never be
sealed if the relay flips to `ready`-only). Sequence:

1. **Phase 1:** ship the SEAL writers (runner/controller mark `proposed→ready` on success) +
   the relay draining **`ready OR proposed`** (superset). In-flight rows still drain.
2. **Phase 2:** once all live runs seal, narrow the relay to **`ready`-only** + enable the GC.

Within a single PR this is a comment-documented ordering, not two PRs, since #203 is unmerged.

## 8. Decision #102 discrepancy (must surface, not silently relitigate)

#102 prescribes *"a durable sweep that drains orphaned `proposed` rows."* That literal mechanism
is the leak. Per CLAUDE.md ("code is truth; flag the discrepancy") this design **amends #102's
mechanism** (drain `ready`, not raw `proposed`) while preserving its **intent** (full Decision
#99 transactional-outbox alignment). Decision #102 should be updated with an addendum, or a new
decision logged, recording the seal as the correctness-completing refinement. **Do not implement
the amendment to decisions.md without founder/team sign-off** (locked-decision change).

## 9. Test impact (non-trivial — scope honestly)

- Integration (`thread-commit-idempotency.integration.test.ts`): every test seeding `proposed`
  rows and expecting them committed must seed `ready` (or seal first). The cross-run-drain,
  crash-recovery, poison-cap, snapshot-suppression, FIX-F1/F2, FIX-#A/#2/#3 tests all touch this.
- Unit (`thread-agent-actions.test.ts`, controller suites): the relay SELECT + claim predicate
  change; mock sequences that return `proposed` for the commit path become `ready`.
- New tests: seal-on-success; no-seal-on-failure ⇒ not committed (the P1 proof); re-home-unsealed
  (A) or seal-by-keys (B); orphan GC; the two-phase superset drain.

## 10. Open questions for adversarial review

1. **Mechanism A vs B** (§4) — is the concurrent-same-key edge in A narrow enough to accept, or
   does B's key-set plumbing pay for itself?
2. **Does any non-runner path INSERT `proposed` rows** that would never get sealed (e.g. MCP
   inbound, founder-driven, tests-as-production)? Audit every `proposeThreadAction` /
   `status:'proposed'` writer. If a writer has no "run success" moment, it needs its own seal
   (or to write `ready` directly).
3. **Controller mixed-batch** (my fix #3) under the seal: with the relay draining `ready`, does
   the mixed/lost reschedule + the round-4 claim gate still compose correctly? Re-derive.
4. **`advance_phase` / `convene_agent`** seal timing — they are key-only (no source_action_id);
   confirm sealing then committing them once is correct and they can't double-fire across the
   seal boundary.
5. **Direct-run self-flush ordering** — seal then commit in the same runner pass: is there a
   window where a concurrent controller drain sees the just-sealed `ready` rows and commits them
   before the direct run's own commit? (Both are idempotent via `source_action_id`, so likely
   benign — confirm.)
6. **Backfill / migration** — any existing `proposed` rows in a real deployment at upgrade.
   (#203 is pre-merge, base `feat/v1-combined`; likely none, but state it.)

---

## 11. Why not the alternatives (for the record)

- **Run-status JOIN at commit** (exclude failed-run `proposed`): penalizes a *successful*
  re-proposing run for the *prior* run's failure (the collided row carries the failed runId);
  adds a JOIN to the hot path; still can't resolve in-progress vs crashed (both `running`).
- **Cancel failed direct run's proposed actions:** concurrent successful run can self-flush them
  first; does not cover the controller-path variant; the seal subsumes it (no seal = cancelled-by-default).
- **Revert to PR-A run-scoped + re-home:** contradicts the locked #102 thread-scoped direction;
  re-home of *committable* rows is the band-aid #102 set out to remove. The seal keeps the
  thread-scoped relay and re-homes only *unsealed* rows (a strictly safer, narrower re-home).
