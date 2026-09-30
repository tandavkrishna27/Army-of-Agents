# CLI-006 Result — First coding golden journey and tenant canary (E7 GATE)


> **CORRECTION added by the Wave-3→4 gate (clause 3), then SUPERSEDED by MIG-002.**
>
> This document named rollback as a config edit and did not say that a live process never saw
> it: the rollout source parsed the map — and read the deployment flag — once at construction,
> and the server built it once at boot. The rollback cases in `cli-006-canary-rollout-mode.test.ts`
> construct a FRESH source, which a running process cannot do, so they proved the decision
> function rather than a live rollback.
>
> **MIG-002 fixed the underlying behaviour.** The source re-reads per resolution (memoized on the
> raw string), so removing an Organization's key, downgrading its `mode`, or dropping a sink from
> its new `sources` list takes effect **with no restart**. This document's rollback instruction
> is correct again as written.
>
> Two caveats it still does not carry, and both matter in an incident: **(a)** the recommended
> FIRST step is the REL-004 kill switch (immediate, read per poll), but it has no UI and no API,
> so throwing it means hand-executing SQL, and it is instance-wide per provider rather than per
> Organization; **(b)** if a restart happens for any other reason, keep
> `AOA_DISTRIBUTED_EXECUTION_ENABLED` set, or already-handed-off runs strand.
>
> Runbook: `docs/deploy/environment-variables.md` § "Rolling distributed execution back".
> Reasoning: `epics/E11-hardening-release/tickets/GATE-clause-3-rollback-*.md` and
> `epics/E10-desktop-migration-realtime/tickets/MIG-002-dial-*.md`.


**Status:** implementation complete, PR-gate and live-D1 green. **The E7 exit gate's CODE is done; its VOLUME clauses (D1/D2) are operator campaign records and are NOT claimed here.**
**Epic:** `E7 — Coding/CLI workload on E2B`, sixth and final ticket.
**Design:** `CLI-006-design.md` · **Plan:** `CLI-006-seam-plan.md` · **Start SHA:** `cd93ef8ff`.
**Frozen artifacts untouched:** `packages/worker-protocol/`, the worker-daemon `SandboxProvider` port, `docs/architecture/distributed-execution-threat-*`. No new hosted-API call (Rule #11).

---

## 1. What shipped

One canary Organization's coding run now transfers execution ownership from the legacy in-process adapter to a distributed worker attempt, and the attempt's durable evidence surfaces in the existing run experience.

| # | Piece | Commit |
|---|---|---|
| — | Migration 0258 — `execution_owner` / `distributed_job_id` / `distributed_attempt_id` | `113463f92` |
| — | Reaper stands down for distributed-owned runs (R1) + honours the terminal latch (R1b) | `d5d7e890c`, `ad2e15eb5` |
| — | After-commit attempt-terminal projection trigger | `ddaa29b78` |
| — | Projector finalization + won/lost latch semantics (R7) | `0b6d146f6` |
| 1 | Canary credential binding — four explicit nulls, asserting nothing | `52317a180` |
| 2a | Compose the canary ownership path | `f569a9985` |
| 2b | Attempt-terminal projection wired into the JOB-005 ingest hook | `cc28ab0ab` |
| 3 | **The suppression seam** — a canary run's `adapter.execute` no longer runs | `3799c8048` |
| 4 | Cancel routing across all five writers | `e7cfae545`, `922ed081b`, `387447d35` |
| 5-7 | Capacity characterization, the outer-`finally` catch, the D1 nonce | `7f22288ad` |
| 8 | Three HIGH fixes from adversarial review | `a10f43f33` |
| 8 | M6 parity fix + the M4/M5 projector-loop hoist | `037b1334f` |
| 8b | Round 2: the fifth writer's dropped outcome + a converging marker-failure | *(this commit)* |

**Still inert in every deployment.** Nothing resolves to `canary` until an Organization is set `mode:"canary"` in `AOA_DISTRIBUTED_EXECUTION_ROLLOUT`. Rollback is deleting that key (Invariant 9) — no code change, no migration, and since MIG-002 no restart either.

---

## 2. Evidence

- **PR gate green** on the branch tip, all jobs including `ci-required`.
- **Live D1 lane green — 40/40, 0 skipped, on `fb963d71c`** — the final state, review fixes and round 2 included. Two control planes, real workers, Toxiproxy, MinIO, fake provider.
  > **The nonce had to be bumped three times, and that is the lesson.** `server/src` is off `d1-merge-train.yml`'s push path filter, so the first bump proved only `8324e434b`; every fix after it (H1/H2/H3, then M6 + M4/M5, then round 2) was `server/src`-only and therefore invisible to the lane. A green D1 on an earlier SHA says nothing about the code that ships. **Bump `campaign.env` after the LAST `server/src` change, not once per ticket** — and re-check which SHA the lane actually ran before citing it as evidence.
- **163 tests** across 11 CLI-006 files.
- **Seven always-on policy checkers** pass.
- **Every guard mutation-tested.** Removing any of these turns the suite RED: the `execution_owner` predicate; the `expired`→`timed_out` mapping; the suppression `return`'s position inside the inner `try`; a throw latching a local terminal; the `propagate` branch; the bulk SQL exclusion; one writer's cancel routing; the H1 outcome mapping; the H3 lock narrowing; the M6 wake predicate; and — for the Task 5 characterization, which passes by construction — adding an owner exclusion that would dissolve the trap.

---

## 3. Adversarial review — what it caught

The review was run by a distinct reviewer, refute-by-default. It **confirmed the single-decision architecture (D3/D4) closes the four double-execution vectors it was designed against** — mid-run config change, replayed convert, late placement, and a replica race — structurally, not by test coverage. Every defect it found was *downstream* of the decision.

Three HIGH, all re-traced in the code before acceptance and fixed fail-first:

**H1 — cancel made a canary run permanently uncancellable.** `requestCancellation` returns six statuses; only `queued` / `already_requested` mean a fenced worker will emit a terminal event. The `"cancelled"` status is the *no-live-lease* path, where `job-control.ts:3001-3033` finalizes job and attempt **directly with row updates and no `job_events` row** — deliberately, because the outbox would never dispatch it. `onAttemptTerminal` has exactly one producer, so discarding that outcome pinned the run at `running` forever; every retry then returned `job_terminal`, also treated as handled. Unrecoverable without manual SQL. An unleased attempt is the **ordinary first-canary state**, not an edge case, because E4-D12 keeps the daemon inert outside D1.

**H2 — a throw from the marker write produced two executors.** The seam's `try` has only a `finally`, so an unguarded throw reached `executeRun`'s outer `catch`, which writes `adapter_failed` *and* calls `releaseIssueExecutionAndPromote` — promoting a deferred wake into a new run on the same issue while the attempt was already durably lease-eligible. Now guarded, and suppression happens regardless. The write was also narrowed so the marker UPDATE is the only critical statement.

> **Corrected in round 2.** This section originally called an unmarked suppressed run "a recoverable inconsistency". **That was false**, and it was load-bearing for shipping the residual. Nothing in the codebase recovers such a run, and the one mechanism that touches it does the actively wrong thing: with the marker absent, the reaper's R1 stand-down does not apply, so the run is reaped and the issue lock is freed and a deferred wake promoted — a second executor, while the attempt is live. The marker-failure branch now **revokes the attempt's fence**, converting the failure into a genuine Invariant 2 outcome: the attempt never runs, the later reap becomes correct, and the work returns to legacy.

**H3 — the issue execution lock was released while the attempt was live.** The bulk terminal update was narrowed; the `issues` update immediately below it still used the unfiltered id list. **The plan's own note was the defect** — it claimed the release must cover both subsets, reasoning that an ineligible task cannot be claimed. False for `reason='reassigned'`: the task stays perfectly eligible for a *different* agent, so the freed lock lets that agent check out and execute the same task concurrently. The per-agent clamp does not help.

**M6 — a silent parity break, fixed.** The canary guard omitted `shouldAutoCheckoutForWake`, which the CLI-005 active-convert block carries. On a mention / `execution_*` / null wake the harness skips its checkout, the canary block fired anyway, the D3a bypass probe failed, and `admitAndSubmit` drove its own checkout — flipping a backlog task the founder merely *mentioned* into `in_progress` with `startedAt` reset. Exactly the break CLI-005's review closed for active mode.

**M4/M5 — fixed together.** The projector re-read `max(seq)` *inside* its event loop, so the base grew with every insert and projected seqs went 1, 3, 6, 10 … — sum-of-sequence growth that overflows `heartbeat_run_events.seq` (int4) near 65k events, where the projector's blanket catch would swallow it silently. It also issued three sequential round-trips per event inside the worker's awaited ACK path. Run row and seq base are now resolved once per projection.

---

## 4. Deferrals — stated, not hidden

1. **D1/D2 volume clauses are NOT discharged.** D1 (≥1,000 lease races, ≥100,000 events, ≥100 lifecycle faults) and D2 (≥120 real-E2B jobs, ≥20 across six classes, **three consecutive** passing runs, p95 cancellation ≤30s) are operator campaign records with real spend. This ticket supplies the harness and the cases. No clause is marked met on unit evidence.
2. **A canary worker still receives NO provider credential.** ~~The lease envelope hardcodes `secretHandles: []` (`job-leasing.ts:349`) and `job_secret_handles` has no production writer.~~ Ownership transfers; a CLI inside the sandbox cannot yet authenticate. **This bounds what CLI-006's D2 leg can claim.**
   > **Mechanism corrected — Sprint 5 (E7-F001).** The struck sentence is stale: DAT-008 landed the writer (`mintExecutionSecretHandleForPlacement`, `job-placement-transaction.ts:367`) and the envelope now advertises handles (`secretHandles: toSecretHandleRefs(storedHandles)`, `job-leasing.ts:601-613`). The bound still holds, for a different reason: the **canary** binding returns `credentialKind: null` (`canary-credential-binding.ts:59-64`), which trips the mint's owner-authority gate (`execution-secret-handle-mint.ts:122-127,149-151`) → `owner_authority_disagreement` → the canary mints no handle → the canary sandbox still gets no key. Filed HIGH/unowned as **E7-F001** (`epics/E7-coding-e2b/findings.md`).
3. **JOB-006's lease reaper has no production trigger.** `createJobControlSweeper` has no caller. An attempt whose lease expires *without* emitting a terminal event has no convergence path — its run stays `running`. Scheduling it belongs to MIG-002.
4. **M3 — retry attempt N+1 and reaper-finalized terminals never project.** The marker binds ONE `distributed_attempt_id`, so a JOB-006 retry mints an attempt the projector can never match, and `reapExpiredLeases` finalizes by writing rows, not events. **Design Invariant 7 and the acceptance verb "retry" are not satisfied by this wiring.** Latent today (`reapOrganization` has no scheduled caller) but reachable from the operator route. Belongs with MIG-002's cutover, alongside deferral 3 — they are the same missing piece: *terminalizations that do not flow through worker event ingest do not project*.
5. **M1/M2 — the placement/marker window.** An indeterminate placement commit (the client sees an error after the tenant transaction committed) yields `transfer_error` → legacy, while the attempt is durably lease-eligible → both execute. Symmetrically, a terminal arriving between placement-commit and marker-commit finds no run and is dropped permanently. H2's narrowing shrinks the window to one statement but does not close it. **The real fix is a durable re-read of `placement_lease_eligible` before any legacy finalization touches a run that reached the ownership call** — that closes M1 and M2 together. Not attempted here because it changes the ownership contract and deserves its own ticket.
6. **The placement owner check remains tautological.** `credentialOwnerId` and `requiredOwnerPrincipalId` both read from the routed target's profile, so `candidateFits` compares a value to itself. Safety rests on the *structural* exclusion of `owner_desktop` routing (verified: `requestedTarget: null` on every submitted job, and `TARGET_KIND_BY_CLASS` maps `owner_desktop` to `{desktop, local_host}` only). **Re-derive that argument before enriching the credential binding.**
7. **L1 — no index** backs `(companyId, distributedJobId, distributedAttemptId)`. Fine at canary volume; a sequential scan per attempt-terminal ingest is not fine at cutover volume.
8. **Old-key kill-switch enforcement** → REL-004. **CLI-005 deferrals** (live drain enumeration, shadow independent derivation, admissibility probe) → MIG-002. **Brokered in-VM memory** → DAT-007.

---

## 5. Operator guidance

**Set the Organization's `concurrency_cap` strictly greater than its concurrent legacy runs — not merely greater than 1.**

This is the Task 5 finding and it is not obvious. Occupancy is `legacyRunning + heldAttempts`, and at the moment the seam resolves ownership the canary run is *already* `status='running'` — so it is counted against itself before its attempt has claimed anything. At `cap = 1` usage is 1 on a **completely idle Organization**, admission denies with `reason:"capacity"`, the convert fails, and the run falls back to legacy. Nothing errors; nothing surfaces at the operator's altitude. **The canary simply never happens, and `cap = 1` is the natural first choice for a pilot.**

`cap = 2` works only on an otherwise-idle org. JOB-007 owns the capacity engine; CLI-006 characterises the behaviour rather than changing it.

**Rollback** is removing the Organization's key from `AOA_DISTRIBUTED_EXECUTION_ROLLOUT` (or setting `mode:"active"`). Since MIG-002 this is LIVE — no restart. See the CORRECTION above for two caveats. Do **not** roll back by downgrading the binary: `parseDistributedExecutionRolloutMap` throws on an unknown mode, so an old binary reading a `canary` config fails loudly at startup.

---

## 6. Acceptance mapping

| Clause | Status |
|---|---|
| MIG-008 reconciled before first transfer | ✅ preflight fail-closed matrix, recomputed per run over **every** Company in the Organization |
| create / schedule | ✅ PR gate + D1 |
| lease | ✅ D1 lane (live worker) |
| stage / execute | ✅ D1 lane; keyed D2 leg **bounded by deferral 2** (no credential reaches the sandbox) |
| stream | ✅ producers → durable sink → projector |
| produce patch | ✅ D1; keyed D2 = campaign |
| review | ✅ projector surfaces review state |
| **retry** | ⚠️ **NOT satisfied by this wiring** — see deferral 4 |
| cancel | ✅ fence-revoking across all five writers, with the H1 fix ensuring a cancel that no worker will terminalize still converges (round 2 wired the fifth writer, which had been dropping that outcome) |
| audit / operator inspection | ✅ JOB-008 surface asserted |
| non-canary tenants remain legacy | ✅ four-mode byte-identity matrix |

---

## 6a. Round 2 — re-reviewing the fixes

The first adversarial review ran at `8324e434b` and therefore **could not have seen any of the fixes it prompted**. A second review over the fix diff alone, five independent lenses with 2-of-3 adjudication, found one genuinely new HIGH and refuted the rest as restatements of deferral 5.

**The new HIGH: the fifth cancel writer dropped the outcome H1 had just made load-bearing.** `writeLegacyTerminal` had exactly ONE consumer in `server/src`; `routeDistributedCancelsForRuns` bound the outcome and read only `.degraded` for a log line. So a canary task with an unleased attempt, marked done/cancelled/reassigned/deleted, left its run pinned `running` with no convergence path. The blast radius is what makes it HIGH rather than one stranded row: `countRunningRunsForAgent` counts it with no owner filter, so at AoA's permanent `HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1` **the canary agent never dispatches again**. Fixed and mutation-proven.

The lesson worth carrying: a fix that makes a previously-ignored value load-bearing must be followed by finding **every** consumer of that value, not just the ones the fix touched.

## 7. Residual risk

The change has **one durable marker and exactly one producer of terminal projections** (worker event ingest), while an attempt can reach terminal in at least four ways: a worker terminal event, a direct cancel finalize, a reaper cancel finalize, and a reaper dead-letter. H1 closed the cancel path. Deferrals 3 and 4 are the remaining two, and they share a root: **terminalizations that do not flow through worker event ingest do not project.** That is the single most important thing for MIG-002 to close before the sink cutover, and it is why the canary is scoped to one Organization whose runs an operator is watching.
