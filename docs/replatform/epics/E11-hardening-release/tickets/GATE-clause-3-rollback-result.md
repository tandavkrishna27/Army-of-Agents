# Wave-3→4 gate, clause 3 — result

**Start SHA** `ad34edab7` (the design commit) ·
**Terrain** [`GATE-clause-3-rollback-terrain.md`](./GATE-clause-3-rollback-terrain.md) ·
**Design** [`GATE-clause-3-rollback-design.md`](./GATE-clause-3-rollback-design.md) ·
**Branch** `docs/replatform-program` (PR #323).

**Status: clause 3 SATISFIED for the org heartbeat, WITH THE CORRECTIONS BELOW. Recorded as NOT
ticked on triviality for the three shadow-only sinks, which must re-satisfy it at activation.**

> ## ★ CORRECTIONS — this document was wrong three times, and the first one is the same failure
> ## it was written to fix
>
> An adversarial cross-check over the rollback terrain refuted three claims in the first version
> of this result. All four were re-verified by hand before being written here.
>
> **C1 — "throw the REL-004 kill switch — immediate" hid that THERE IS NO WRITE PATH.**
> `instance_settings.kill_switches` has **zero production writers** (verified: the only mutation
> anywhere in the repo is in `execution-kill-switch-poll.integration.test.ts`). "Immediate" is
> true of the READ — the poll re-reads the row every time — but the operator ACTION is executing
> SQL against the production database by hand. **I had already written this down myself**:
> `REL-004-lane-D-result.md` §6 limit 4 says "No write path or UI for throwing a switch — still
> REL-001/005". I then named that step "immediate" in the next ticket without carrying the
> limit forward. **This is precisely the hazard I documented hours earlier** — a deferral that
> does not travel to the document that later depends on it (see `CLI-005-result.md`'s correction
> block). Knowing the failure class is not the same as being immune to it.
>
> **C2 — the kill switch has no Organization and no sink dimension.** `KILL_SWITCH_DIMENSIONS`
> is `["provider", "template"]` (`execution-kill-switches.ts:41`). Step 1 stops the named
> provider for the **whole instance**, not for one tenant. A clause about "a rollback path per
> sink" must not present an instance-wide provider stop as a per-sink lever.
>
> **C3 — the restart must keep `AOA_DISTRIBUTED_EXECUTION_ENABLED` ON, and the first version did
> not say so.** This is the operationally dangerous one. A handed-off run carries
> `execution_owner = "distributed"`, and the orphaned-run reaper stands down on that marker
> unconditionally — explicitly including the startup sweep (`heartbeat.ts:2476-2482`) — because
> the attempt projector is the terminal authority. But `onAttemptTerminal` is composed only when
> the flag is on (`index.ts:866-867`). **Restart flag-off and nothing terminalizes those runs and
> nothing reaps them**; restart flag-on and they converge. Other documents call the flag a
> rollback lever, so an operator could very reasonably have done both and stranded work.
>
> **C4 — "wire the drain" understates MIG-002.** `listActiveAttempts` exists only as an interface
> member and a call site inside the unwired drain (`job-distributed-drain.ts:40,:137`); there is
> **no SQL implementation**. Also newly found: `createExecutionTargetRevocationFanout` has zero
> callers **while its producer is live** — the Revoke control writes a `status:"pending"` row
> that nothing ever reads or advances.
>
> §2 and §6 below are corrected in place; the runbook in
> `docs/deploy/environment-variables.md` is rewritten accordingly.

**8 mutants: 8 killed, 0 survived.**

---

## 1. What was actually wrong

The rollback path a successor would follow was written down in three places and was **incomplete
in all three**: CLI-006's result names it as *"removing the Organization's key … a config edit,
with no code change and no migration"*, and the operator env reference described the variable
without saying when a change takes effect.

`createDistributedExecutionRolloutSource` parses the map — and reads the deployment flag —
**once at construction** (`distributed-execution-rollout-source.ts:159-160`), and `index.ts`
builds the source once at boot. **A live process never sees the edit.**

The test that appears to cover this (`cli-006-canary-rollout-mode.test.ts:121`, *"returns the
next run to legacy when the canary key is removed"*, under the comment *"Invariant 9 — rollback
is a config edit"*) constructs a **fresh** source from a new env bag. A running process cannot do
that. It proves the decision function, not a rollback.

Nobody was careless: each statement is true. The gap is that "config edit" and "takes effect
now" read as the same sentence to an operator in an incident.

## 2. The path, as it now reads

An **ordered pair**, and the order is load-bearing:

1. **Throw the REL-004 kill switch** (`instance_settings.kill_switches`) — the poll re-reads it
   every time, so the effect is immediate **once written**; but there is **no UI and no API**, so
   writing it means hand-executing SQL (C1), and it is **instance-wide per provider/template**,
   not per Organization and not per sink (C2). Workers stop being offered new leases; in-flight
   work finishes.
2. **Edit `AOA_DISTRIBUTED_EXECUTION_ROLLOUT` and restart — with the deployment flag still ON**
   (C3). Restarting flag-off strands every already-handed-off run.

Doing 2 without 1 is the hazard: the restart can land while an attempt has already been handed
off (legacy adapter suppressed at `heartbeat.ts:5250`, attempt durably lease-eligible). After a
flag-off restart no worker can lease it, the reaper stands down on its durable marker, and
**`createJobControlSweeper`, `createDistributedExecutionDrain` and
`createExecutionTargetRevocationFanout` all have zero production callers** — so the run stays
`running` indefinitely, holding its issue lock. Step 1 drains that window; keeping the flag on
across the restart (C3) closes it.

**`AOA_DISTRIBUTED_EXECUTION_ENABLED` is not a master switch**, and the result doc says so: it is
live for new heartbeat conversions (the hook re-reads `process.env` per call) but the worker
control routes sit behind a construction-time `if` (`app.ts:438`), so workers keep polling until
a restart.

**Clause 1 turns out to answer most of clause 3.** REL-004's kill switch is the only genuinely
live lever for the leasing half. The handoff lists the two clauses as unrelated; they are not.

## 3. Acceptance → named executable artifact

| # | Invariant | Artifact | Result |
|---|---|---|---|
| G1 | A constructed rollout source ignores later env mutation — removal, downgrade, and flag-unset | `rollout-rollback-liveness.test.ts` | pass |
| G1b | A freshly constructed source DOES see the edit — i.e. the restart is what applies it | same file | pass |
| G2 | The deployment flag IS live at the heartbeat hook, and flag-first (no Organization resolved when off) | same file | pass |
| G2b | The two levers are not interchangeable — same env bag, same edit shape, different latency | same file | pass |
| G3 | Worker control routes are gated at construction, not per request | same file (source contract) | pass |
| G4 | The operator-facing instruction names both steps and the restart | `docs/deploy/environment-variables.md` § "Rolling distributed execution back"; correction block at the head of `CLI-006-result.md` | done |
| G5 | Clause 3 status recorded per sink | this doc §4 + handoff §4 | done |

## 4. Per-sink status — and what must NOT be read as satisfied

| Sink | Execution can move today? | Clause 3 |
|---|---|---|
| org heartbeat (`task_run`) | **yes** (CLI-006 canary) | **SATISFIED** — path named, limits pinned, in-flight gap stated |
| `commander_turn` | no — shadow only | trivially satisfied; **RE-SATISFY at activation** |
| `crew_run` | no — shadow only | trivially satisfied; **RE-SATISFY at activation** |
| `one_shot` | no — shadow only | trivially satisfied; **RE-SATISFY at activation** |

The three MIG sinks have nothing to roll back because nothing has moved. That is a fact about
today, not a property of the design, and Wave 4 changes it for each sink it activates.

## 4b. A live defect found by this review, and fixed

`routeDistributedCancelsForRuns` — the **fifth** cancel writer (`issues.ts:296`) — opened with:

```ts
const port = getDistributedCancellationPort();
if (!port) return;
```

`dispatchCancel` takes `port: DistributedCancellationPort | undefined` **by design**
(`distributed-cancellation-port.ts:139`) and answers LEGACY with `writeLegacyTerminal: true`,
its own comment naming the scenario: *"a control-plane restart with the distributed flag off
leaves marked runs behind and no port. Refusing to terminalize them would strand them forever …
the legacy write is the only convergent outcome."*

The early return meant this writer **never reached that handling, in exactly the post-rollback
state the handling exists for.** The H1 convergence block below it — latch `cancelled`, release
the execution lock — was dead precisely when it mattered. Its own comment describes the
consequence: the run is pinned at `running`, and because `countRunningRunsForAgent` counts it
with no owner filter, at the permanent concurrency default of 1 that agent never dispatches
again.

Two tests already proved the CALLEE handles a missing port
(`cli-006-cancel-routing.test.ts:60`, `:162`). **Proving the callee handles a case is not proving
the caller reaches it** — the same shape as this programme's zero-caller findings, one level in.

Fixed by deleting the guard. Cost: one indexed SELECT on terminate paths; the query filters on
`executionOwner = "distributed"`, so a deployment that never enabled distributed execution
matches zero rows. 3 further mutants, 3 killed (§5).

## 5. Mutation ledger

| Mutant | Kills |
|---|---|
| H1 the rollout map becomes LIVE (re-parsed per call) | ✓ |
| H1b the source's captured flag becomes LIVE | ✓ |
| H2 the hook stops re-reading the flag — rollback stops being live anywhere | ✓ |
| H3 the hook resolves an Organization before checking the flag (not flag-first) | ✓ |
| H4 the worker-control gate becomes a per-request env read | ✓ |
| J1 the fifth writer's early return is restored (the defect) | ✓ |
| J2 the port stops being passed to `dispatchCancel` | ✓ |
| J3 the distributed-only filter is dropped | ✓ |

**These are PINNING tests, so they passed on first run.** The fail-first evidence is the mutation
pass: each pin was shown to break under the exact change it exists to detect. H1 is the important
one — it is *supposed* to fail the day someone makes the map live, and its failure message names
the two documents that must be corrected in the same change.

## 6. Limits, stated

1. **CLOSED by MIG-002 (Wave 4 item 1).** The source now re-reads per resolution and gained a per-sink `sources` axis, so per-Organization rollback is live and the Wave-4 one-sink-at-a-time ordering is expressible. The G1 pin fired on that change, named the two documents to correct, and they were corrected in the same commit — which is what the pin existed for. ~~No live per-Organization rollback exists.~~
   `index.ts:1162-1163` hands `resolveOrganizationPolicy` / `resolveWorkloadPolicy` to
   `createJobPlacementService`, so the seam and placement share one source. Making the map live
   must make **all** resolvers live together; a version where the seam is live and placement is
   not is worse than both being static. It also changes the canary path CLI-006 validated on the
   live lane, so it needs its own ticket and its own D1 bring-up.
2. **The in-flight strand is a WAVE-4 BLOCKER, not a limit.** `createJobControlSweeper`,
   `createDistributedExecutionDrain` and `createExecutionTargetRevocationFanout` all have zero
   production callers, and the drain's `listActiveAttempts` has no SQL implementation at all
   (C4) — so `assertRollbackSafe` is a guard reachable only through a service nothing invokes,
   and "wire the drain" is not a one-line fix. Owner MIG-002. Steps 1 and 2 of §2 mitigate it
   operationally; they do not fix it.
5. **A live control does nothing today.** The execution-target Revoke path writes a
   `status:"pending"` row that no consumer reads, because the revocation fan-out has no caller
   (C4). Not this clause's to fix, but it is a user-facing control with no effect and should be
   filed rather than left for someone to discover during an incident.
3. **G3 is a source contract test**, so a refactor of `app.ts`'s composition must carry it along.
4. **Nothing here was validated on a live lane.** The rollback path is named and its limits are
   pinned by unit-level evidence. An actual rehearsal — throw the switch, restart, confirm one
   executor — belongs to the Wave-4 cutover rehearsal.
