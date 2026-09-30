# MIG-002 — the routing dial · terrain (first slice)

**Status: TERRAIN ONLY. No design, no code.** Wave 4 item 1
([HANDOFF-wave-3-4.md](../../../HANDOFF-wave-3-4.md) §5): *"Route distributed execution by
Organization and workload; retain legacy for everything else. **This is the dial the rest of the
wave turns.**"*

Line references are to `docs/replatform-program` at `7c6784b50`.

---

## 0. Why this slice, and why now

§5 states, as the premise for cutting sinks over one at a time: *"The kill switch and the per-org
dial exist precisely so a bad cutover is reversible in seconds."*

The gate clause-3 review established that **this is false as built** — both halves of it:

- the kill switch has **zero production writers** (an operator must hand-execute SQL), and it has
  no Organization and no sink dimension;
- the per-org dial **needs a process restart**, because
  `createDistributedExecutionRolloutSource` captures its parsed map and the deployment flag once
  at construction (`distributed-execution-rollout-source.ts:159-160`).

And the Wave-3 shadow work established that **all four cutover sinks resolve to
`workloadType: "batch"`**, so one switch arms them together — the MIG-005 → 006 → 007 ordering
§5 prescribes is not expressible against the current key.

So the first buildable slice of MIG-002 is: **make the dial actually be a dial.** Everything else
in Wave 4 turns it.

## 1. The finding: the finer axes were designed in and never used

`job-placement.ts:392-397` declares the resolver contract as:

```ts
resolveWorkloadPolicy(input: {
  organizationId: string;
  companyId: string;
  sourceKind: ExecutionSourceKind;
  workloadType: string;
}): Promise<boolean> | boolean;
```

and placement calls it with the **whole input** (`:445` — `await deps.resolveWorkloadPolicy(input)`),
where `input.sourceKind` is a real `ExecutionSourceKind` (`:415`).

**Both `sourceKind` and `companyId` are already at the call site.** The implementation
(`distributed-execution-rollout-source.ts:181-183`) destructures only `organizationId` and
`workloadType` and discards the rest.

Consequences, and they are the shape of the ticket:

1. **A per-sink axis needs no plumbing and no frozen-protocol change.** `packages/worker-protocol`
   is untouched: `sourceKind` is already carried on the job (`jobs.sourceKind`) and already
   reaches the placement decision.
2. **A per-Company axis is available too**, on the same contract, for free.
3. E3 anticipated this when it designed the boundary; CLI-005's config-driven source
   under-implemented it. This is not a redesign — it is finishing an interface.

## 2. Consistency is structural if the change is made in one place

The risk a design must not create is a **live seam with a static placement** (or the reverse):
one says legacy, the other says enabled, and a task ends with two executors or none.

That risk is avoidable by construction here. `index.ts:1162-1163` passes
`rolloutSource.resolveOrganizationPolicy` and `rolloutSource.resolveWorkloadPolicy` **by
reference** into `createJobPlacementService`, and the seam hook holds the same `rolloutSource`
object (`:1216`). So a re-read placed **inside the shared closures** makes every consumer live in
the same instant — there is no window in which two consumers disagree, because there is only one
source of truth and one moment of reading it.

A design that instead introduced a second, live source alongside the captured one would create
exactly the divergence it was trying to remove.

## 3. Storage: what a live dial costs

Two candidate homes:

| Home | Live? | Cost |
|---|---|---|
| **Keep the env var, re-read per call** | yes | zero migrations, zero grants. `parseDistributedExecutionRolloutMap` is a `JSON.parse` of a small string; memoizing on the raw string makes the steady state a string compare. Operator UX unchanged (edit env, but **no restart**). |
| **Move to the database** | yes | a column on `instance_settings` needs **no new grant** — migration `0261` already granted `aoa_app` `SELECT` on that table for the kill switch, and a new column inherits it. But it needs a migration, a write path (routes/service), and it changes the operator model from "edit env" to "call an API". |

The env re-read is the smaller, more honest first slice: it removes the restart requirement
without inventing an operator surface, and it leaves the database option open. The kill switch's
missing write path (REL-001/005) is the same problem one layer over and should be solved once,
deliberately, not twice by accident.

**UNVERIFIED and load-bearing for the DB option:** whether a rollout read would land on a hot
path. `resolveRunRolloutState` is per-run and per-shadow-record; `resolveWorkloadPolicy` is per
placement decision. Neither is the worker poll. The kill-switch precedent (read per poll) is
therefore a *stronger* case than this one — but confirm before citing it.

## 4. Convergence is a separate, larger problem — do not fold it in

`createDistributedExecutionDrain`, `createJobControlSweeper` and
`createExecutionTargetRevocationFanout` all have zero production callers, and the drain's
`listActiveAttempts` has **no SQL implementation** — it exists only as an interface member
(`job-distributed-drain.ts:40`) and a call site (`:137`).

A dial that is live but strands in-flight work on rollback is still a large improvement (the
strand needs a *restart*, which a live dial removes the need for). But "reversible in seconds"
is not fully true until convergence exists. **These are separable and should be separate lanes.**

## 5. The question a design must answer first

> **Does the dial become live where it is read, or does the rollout state move to the database?**

The evidence favours the first as the opening slice — it is smaller, needs no migration or grant,
makes every consumer live simultaneously by construction (§2), and immediately delivers the two
things Wave 4's ordering depends on: a per-sink axis (§1) and no-restart rollback. The database
option is a real second step, and it belongs with the kill switch's missing write path rather
than on its own.

## 6. Traps

- **Do not make the map live and leave `deploymentEnabled` captured** (or vice versa). Both are
  captured on the same two lines; a half-migration is the divergence §2 warns about.
- **Do not add a second rollout source.** One object, read by reference in three places, is what
  makes consistency structural.
- **Do not widen the frozen `WORKLOAD_TYPES`** to express sinks. The sink axis is `sourceKind`,
  which already exists on the job and in the resolver contract. `packages/worker-protocol` is
  FROZEN.
- **Do not fold convergence (drain/sweeper) into this slice.** §4.
- **Re-read the clause-3 pins before changing this.** `rollout-rollback-liveness.test.ts` G1
  asserts the map is captured, deliberately, and its failure message says the runbook and
  `CLI-006-result.md` must be corrected in the same change. That test failing is the signal it
  was built to give — not an obstacle to route around.
