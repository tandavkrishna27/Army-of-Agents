# MIG-002 — the routing dial · result (first slice)

**Start SHA** `0d550d01a` (the design commit) ·
**Terrain** [`MIG-002-dial-terrain.md`](./MIG-002-dial-terrain.md) ·
**Design** [`MIG-002-dial-design.md`](./MIG-002-dial-design.md) ·
**Branch** `docs/replatform-program` (PR #323) · **Wave 4 item 1, first slice.**

**Status: the dial is live and per-sink. 11 mutants, 11 killed, 0 survived.**

Convergence (drain / sweeper) and a kill-switch write path are explicitly **not** in this slice
(§6).

---

## 1. What shipped

Two changes, both inside `distributed-execution-rollout-source.ts`:

**The source re-reads per resolution.** The parsed map and the deployment flag were captured on
two adjacent lines at construction; they are now read per call, memoized on the raw env string.
Rollback needs no restart.

**The per-sink axis is honoured rather than added.** `resolveWorkloadPolicy`'s contract already
declared `sourceKind` (`job-placement.ts:392-397`) and placement already passed it (`:445`) —
this implementation discarded it. A new optional `sources` list on an Organization entry now
filters by it. **Nothing in the FROZEN `packages/worker-protocol` changed.**

```jsonc
{ "organizations": { "<id>": {
    "mode": "canary",
    "workloads": ["batch"],
    "sources": ["commander_turn"]   // NEW — absent means ALL sinks
} } }
```

That last line is what makes Wave 4's prescribed ordering possible: Commander can be canaried
without arming the org heartbeat, crew, or one-shot. Before this, all four resolved to
`workloadType: "batch"` and one switch armed them together.

## 2. Consistency is structural, not engineered

`index.ts` passes `resolveOrganizationPolicy` and `resolveWorkloadPolicy` **by reference** into
the placement service and holds the same source object for the run seam. Putting the re-read
inside those shared closures means every consumer becomes live in the same instant — there is no
window in which the seam and placement disagree, because there is one source of truth and one
moment of reading it.

A design that added a second, live source alongside the captured one would have manufactured the
divergence it was meant to remove. Recorded because it is the kind of thing that looks like an
implementation detail and is actually the whole safety argument.

## 3. Two hazards a live dial creates, both handled

**A bad edit now lands on a running process.** Malformed JSON previously failed at *startup*,
loudly. Per-call, it would have thrown into a live run. It now resolves to `off` — legacy is the
safe executor — never throws, and reports once per distinct bad value. Startup validation is
unchanged and still loud. Fixing the value recovers on the next resolution, with no restart.

*Keeping the last good value was rejected*: it silently ignores an operator's edit and gives them
no feedback that it did not take.

**The value can flip between the seam's decision and placement's.** Both directions land on
legacy: if it flips off mid-run, placement refuses and the legacy adapter is never suppressed, so
there is exactly one executor; if it flips on mid-run, the seam already chose legacy and placement
is never consulted. Pinned by M8 — a live dial whose worst interleaving produced two executors
would be strictly worse than the restart it replaces.

## 4. Acceptance → named executable artifact

| # | Invariant | Artifact | Result |
|---|---|---|---|
| M1 | A live source observes removal, downgrade and re-enable — no restart | `rollout-dial-live.test.ts` | pass |
| M2 | The deployment flag is live in the source too; both values move together | same | pass |
| M3 | `sources` filters by sink; **absent = all**, byte-identical to today | same | pass |
| M3b | A caller that passes no `sourceKind` is unfiltered (existing callers unchanged) | same | pass |
| M4 | An unknown source kind fails the parse, like an unknown mode | same | pass |
| M5 | A malformed value at runtime → `off`, never throws, reports once per distinct value, recovers live | same | pass |
| M6 | Unchanged value does not re-parse (memo), asserted on a parse counter | same | pass |
| M7 | Placement and the seam read ONE source | structural (§2) + `index.ts` composition | pass |
| M8 | Every live-flip interleaving lands on legacy, never two executors | same file | pass |
| M9 | The org heartbeat seam NAMES its sink, and heartbeat.ts actually passes it | `rollout-rollback-liveness.test.ts` (behavioural + source contract) | pass |
| M10 | The clause-3 pins and both runbooks updated in the same commit | G1 removed/superseded; docs diff | done |

## 5. Mutation ledger — and the two that survived first

| Mutant | |
|---|---|
| K1 the map goes back to being captured | ✓ |
| K2 the deployment flag goes back to being captured | ✓ |
| K3 `sourceKind` is discarded again (the original defect) | ✓ |
| K4 an absent `sources` stops meaning all sinks (backward compat broken) | ✓ |
| K5 a caller with no `sourceKind` starts being filtered | ✓ |
| K6 an unknown source kind is accepted silently | ✓ |
| K7 a malformed runtime value throws into the run | ✓ |
| K8 the parse-error report fires on every call | ✓ |
| K9 the memo stops memoizing | ✓ |
| K10 the seam stops naming its sink | ✓ |
| K11 the seam names the wrong sink | ✓ |

**K8 survived first, and the fix was to delete code.** I had written a separate `reportedRaw`
flag to bound the log to once per distinct bad value. Mutation showed removing it changed
nothing: the memo already stores the bad value, so every repeat call short-circuits before
reaching the error path. The flag was **dead state that read like a guard** — removed, and the
comment now names the memo write as the thing that actually bounds the report. (The same lesson
as DSK-003's dead-code survivors.)

**K10 survived first, and it was a real gap.** Nothing proved the org heartbeat passes
`sourceKind: "task_run"`. Without it, an Organization opted in for `commander_turn` alone would
have armed the heartbeat too — silently defeating the axis this slice exists to add. A behavioural
test proves the filter works; only a source-contract test proves the one production caller uses
it. **A resolver cannot filter on what it is not told.**

## 5b. A HIGH defect the cross-check found, and fixed

An adversarial pass over this slice's terrain surfaced a consequence my own M8 analysis missed:
**fail-safe for EXECUTION is not fail-safe for STATE.**

The chain, each link verified by hand:

1. the convert's submit claims an org concurrency slot — `job-submission.ts:296-303` calls
   `admitAttemptCapacity`, setting `job_attempts.capacity_claim_state = 'held'`;
2. `resolveExecutionOwner` returned `legacy("placement_not_leasable")` when placement declined
   (`run-execution-owner.ts:232`) and released **nothing**;
3. that attempt is then inert forever — never leased, so never terminalized — and the only
   releases are attempt-terminal, cancel-finalize, and the lease reaper, whose
   `createJobControlSweeper` has **zero production callers**;
4. the org cap counts `capacity_claim_state = 'held'` (`org-concurrency.ts:116-121`), and the
   **LEGACY** heartbeat claims against that same budget (`heartbeat.ts:2748`).

So every canary run that is not placed permanently removes one slot from the Organization's
ordinary legacy capacity. And placement declining after a successful convert is a NORMAL
outcome — no worker enrolled yet, requirements mismatch, capacity — so the very first thing an
operator does, arming a canary before enrolling a worker, leaks a slot on every run. The symptom
is the Organization's legacy work quietly slowing to a stop, with nothing pointing at the cause.

**This is pre-existing, not created by the live dial.** The dial adds one more way to reach it
(an operator can now drop a sink mid-run). Stating that precisely matters: the fix is not a
consequence of this slice, and the slice is not excused from carrying it.

Fixed: the resolver releases the claimed slot on both legacy exits after a convert — the
placement decline and the catch-all — best-effort, so a capacity-table failure cannot turn an
already-decided legacy run into a throw. It deliberately does **not** release when the attempt
is going to execute distributed; that would let the org over-subscribe its cap, the inverse
defect and a worse one. Wired at the composition root inside a tenant transaction, because
`job_attempts` is RLS-protected and an untenanted update would silently match zero rows — and
the wiring itself is pinned, because a release nothing composes is a fix that never runs.

6 mutants, 6 killed, 1 documented equivalent.

## 6. Limits, stated

1. **Convergence is unchanged and still absent.** `createJobControlSweeper`,
   `createDistributedExecutionDrain` and `createExecutionTargetRevocationFanout` all have zero
   production callers, and `listActiveAttempts` has no SQL implementation. A live dial removes
   the *restart* that stranded work; it does not converge work already handed off. Owner MIG-002
   proper.
2. **"Reversible in seconds" is still not fully true.** Step 1 of the rollback runbook — the
   REL-004 kill switch — still has no UI and no API, so it means hand-executed SQL, and it has no
   Organization or sink dimension. That is REL-001/005 and is the remaining half.
3. **Only the org heartbeat seam passes its sink so far.** The shadow recorder passes it for the
   three MIG sinks, but those are shadow-only. Each sink must name itself as it goes active.
4. **`sources` is env-config, not a database dial.** Moving rollout state into the database
   remains open and belongs with (2), solved once (terrain §3).
5. **Not validated on the live lane beyond CI.** The D1 nonce is bumped so the two-replica lane
   exercises the new resolution path, but a deliberate live rollback rehearsal belongs with the
   Wave-4 cutover.
