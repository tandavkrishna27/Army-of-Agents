# WRK-012 — A self-model refresh channel for a long-lived worker (E4-F008 successor)

**Epic:** E4 · **Plan node:** `docs/replatform/program-design.md`, `#### WRK-012`
**Depends on:** WRK-008 slice 2b · **Size:** (scope only) · **Status:** scoping
**Owns:** finding **E4-F008** (`epics/E4-worker-daemon/findings.md`)

---

## Why this ticket exists

WRK-008 slice 2b (Sprint 3) composes the poll loop from a self-model that is read **once**, at
boot: `composeDispatchRuntime` clamps capacity to
`selfModel.verifiedProviderConstraints.resourceCeiling` at composition time, and
`PollLoopDeps.self` is a plain value, not a getter. **Nothing in that composition ever re-reads
the self-model**, so a provider-constraint rotation *after* boot cannot be observed, and in-flight
leases cannot be reconciled against it. Composing the loop is exactly the seam E4-F008 named, and
the seam now exists — but the reconciliation does not.

E4-F008 stays LOW for a robust reason independent of any other ticket: the direction of failure is
CLOSED. `workerSatisfiesRequirements` compares the worker's verified constraints against **both**
the target's registered ref and the job's requested ref
(`worker-protocol/src/capabilities.ts:466-467`), so a stale digest makes the worker
**unmatchable**, not wrongly matched. (The historical second reason — that while E4-F010 was open
the worker was unmatchable anyway — lapsed when WRK-011 closed E4-F010; the direction-closed reason
does not depend on it.)

It is filed **now**, at WRK-008's completion, so E4-F008 is not left `owned` by a shipped ticket —
which reads as owned by nobody and fails nothing (finding **E4-F013**). WRK-008 slice 2b's result
doc repoints E4-F008's manifest `ticket` to this id.

## What it must build (design written at sprint start, against the tree as it exists then)

A self-model refresh channel — a periodic or poll-triggered re-read of `client.selfModelRead` that
updates `PollLoopDeps.self` — **plus a stated policy** for leases in flight when the provider-
constraint digest changes: finish the run under the old constraints, or fence it. Both are design
decisions with a blast radius, and neither is a line in a composition ticket.

## Precondition — when this becomes REQUIRED, not before

When a worker runs long enough that a mid-life provider-constraint rotation is a real operational
event — i.e. after Sprint 5 proves a real journey and long-lived workers exist. E4-F008 stays
**open** (LOW) until then.

## Status

Scoping stub. No design steps and no result doc yet — deliberately. Its full design is written at
that sprint's start, per the go-book's "write the plan at sprint start" rule for work that would go
stale if planned early.
