# WRK-016 — Replicated/autoscaled-fleet worker identity granularity + retirement runbook (WRK-014 successor)

**Epic:** E4 · **Plan node:** `docs/replatform/program-design.md`, `#### WRK-016`
**Depends on:** WRK-014 · **Size:** (scope only) · **Status:** scoping
**Terrain of record:** [`WRK-014-design.md`](./WRK-014-design.md) §4 · [`qa/2026-08-28-worker-dispatch-chain-reconciled.md`](../../../qa/2026-08-28-worker-dispatch-chain-reconciled.md)

---

## Why this ticket exists

WRK-014 gives a **singleton** container worker a durable device identity: a `file_record`
`DeviceRecordStore` over a named volume, a boot-time writable-state-dir assert, and a `docs/deploy`
note that the state dir MUST be a durable named volume and that a revoked container identity is
retired (there is no container reset). That is exactly what the E7-1 campaign needs — it enrols
**one** canary worker.

It is **not** what a replicated staging fleet needs, and WRK-014 deliberately scoped that out (review
F1, verified against source):

- `docker-compose.staging.yml` worker services declare `deploy.replicas: 2` and are documented for
  autoscale 2–8, and they **share one enrolment code**. So N replicas of one service cannot each own a
  distinct durable identity through a single named volume — a named volume mounted into a replicated
  service is shared, and `enrollOnce`'s compare-and-set makes the first replica the identity's owner
  while the others load it or fail closed. "One named volume per worker" holds for a singleton and
  breaks for a replica set.
- A recreated/replaced container that lost its `DeviceIdentityRecord` re-mints a `workerId`, which the
  server denies as `worker_transfer_denied` **forever** (`worker-enrollment.ts` — `findWorkerForBinding`
  has no status predicate, so the revoked row keeps matching with no reset route). Under autoscaling,
  scale-down leaves **orphaned `workers` rows** with no operator procedure to retire them.

That is a real **identity-granularity decision** — per-container vs per-replica vs per-target under
autoscaling, plus a deny-transfer/retirement policy — and its shape is **not decided**. Filing it now,
at WRK-014's completion, keeps the dependency graph honest: the gap is a tracked backlog node, not a
silent residual (WAVE-4-RESEQUENCE §4 — "the graph must SEE the gaps").

## What it must decide + build (design written at sprint start, against the tree as it exists then)

1. **The identity-granularity model** for a replicated/autoscaled worker service: how each replica
   obtains a distinct durable identity (per-replica volume via a `StatefulSet`-style ordinal, a
   per-replica enrolment code, or a per-target model where the replica set enrols once and shares a
   session — each with its own transfer-deny implications), stated positively with the security
   properties WRK-002/WRK-014 already hold (identity is one artifact; compare-and-set persist; no
   silent re-mint).
2. **A deliberate retirement/replacement runbook** for the orphaned `workers` rows a scale-down leaves,
   and for replacing a retired container identity — the operator procedure WRK-014's singleton note
   says is "retired, no reset", generalized to a fleet.
3. **Only if the chosen model needs it:** a replicated-fleet manifest checker. WRK-014 deliberately
   did **not** author one — its shape is not decided, and a checker written against an undecided model
   would be a guard that measures nothing.

## Precondition — when this becomes REQUIRED, not before

It sits AFTER WRK-014 and after the E7-1 singleton-canary campaign. The campaign proves the distributed
coding journey with **one** worker; the replicated fleet is a scale-out concern that only bites when
staging runs more than one worker replica against real load. Building it before the singleton path is
proven would design granularity for a mechanism not yet demonstrated once. So: **filed for visibility,
built when the fleet moves from a singleton canary to a replicated set** — not on the E7-1 critical
path.

## Explicitly NOT in scope

No product code lands with this stub. It adds **no** dependency edge beyond `WRK-014` (justified: the
singleton identity path is the prerequisite for deciding replicated-fleet granularity — there is
nothing to replicate until one container can hold an identity). It owns **no** finding: 3.1's
replicated-fleet gap exists only as WRK-014 §4's deferral, never filed as an `E4-Fxxx`, so
`finding-ownership.json` is untouched.
