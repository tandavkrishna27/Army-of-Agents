# DAT-009 slice 2 Result — the fence window

**Status:** LANDED and **PROVEN END TO END**. The gap named in §6 is closed by DAT-011, and
`tests/d1/e6f-14-orphan-sweep.test.mjs` now exercises the whole path against real PostgreSQL
and real MinIO — mint → intent → PUT → stale fence → commit denied → **object deleted** →
intent `swept`. That live lane also found a production defect in DAT-011's trigger placement
that unit tests, mutation testing and grep verification had all missed.
**Start SHA:** `a423bd6a7` ([`DAT-009-slice-2-design.md`](./DAT-009-slice-2-design.md)).

---

## 1. What landed

| Design § | Piece | State |
|---|---|---|
| 4.1 | Grant TTL **clamped** to a 300s ceiling (was floor-only, no ceiling) | ✅ |
| 4.2 | Migration 0265 — `granted` partial-unique + `granted`/`expires_at` index | ✅ |
| 4.2 | `recordArtifactGrantIntent` on the fence-guarded seam; mint writes it | ✅ |
| 4.3 | `isSweepEligible` — the pure decision | ✅ |
| 4.3 | `runArtifactOrphanSweep` — the runner | ✅ built |
| 4.3 | **Anything that calls the runner** | ✅ **DAT-011** — see §6 |

**Mutation: 20 mutants, 20 killed** (8 decision + 5 TTL + 7 runner). 34 unit tests. The
`artifact-transfer-commit` integration suite was run **for real** against embedded
PostgreSQL rather than accepting its 17 silent Windows skips — 17/17. Migration gates
47/47 including idempotent re-apply. `tsc` clean across `db` and `server`.

## ★ 2. A defect I created, caught before it shipped

The `granted` and `committed` partial-unique keys are **disjoint**, so a successful commit
inserts a **second** row rather than transitioning the first. The intent therefore
**survives its own commit**, and both rows name the **same `objectKey`**.

The sweeper would have waited for the intent to expire and then **deleted a committed,
immutable artifact's bytes** — destroying data instead of collecting litter, **on the happy
path**, not an edge case.

Found by reasoning through the interaction between two pieces written hours apart, not by a
failing test. Closed with a `hasCommittedSibling` guard in the pure decision, and the mutant
that removes it is proven to die.

This is the "sweeper worse than the orphan" trap the design already had a section about —
arriving in a shape that section did not cover.

## 3. Two orderings that are the correctness properties

**Mint: record the intent BEFORE returning the grant**, inside the same tenant transaction.
A failure rolls the mint back and no grant is handed out. A grant returned but unrecorded is
precisely the undiscoverable orphan — the storage port cannot list, so an object nobody
recorded can never be found again.

**Sweep: delete the object BEFORE marking the row.** Marking first and failing the delete
leaves a live object with no record pointing at it — an orphan invisible to the mechanism
built to find orphans. Deleting first makes the worst case a retry. Both directions are
pinned by mutants (M1, M2).

## 4. Where the guard is, and where it deliberately is not

`recordArtifactGrantIntent` went on the **enumerated** `GUARDED_JOB_MUTATORS` seam, not the
easier door: `jobArtifacts` already exposes a raw unguarded `insert()`, so "writes to this
table are fenced" was never universally true — and using the easy door is how a guarded
action acquires a second, quieter one. In the mint's path the guard is defence-in-depth
(the lock is already held); it is there so the mutator is safe for *any* caller.

`markSwept` is **deliberately NOT fence-guarded**, and that is the point: the sweeper runs
precisely when the fence is gone, so `guardActiveFence` there would refuse every real call —
a guard that can never fire. Its safety comes from `WHERE status = 'granted'` (it can only
ever move a granted row) plus the caller having satisfied `isSweepEligible`. Stated in the
interface rather than left implicit.

## ★ 5. What the design said and the measurements corrected

- **"Just add a sweeper" was impossible.** The mint recorded nothing durable, and the
  storage port has **no list operation** — so a sweeper had neither a database record of
  what to look for nor a way to enumerate the bucket. Hence record-first, sweep-second.
- **The TTL was dead configuration**: `Math.max(30, ?? 300)` with no ceiling and no caller
  passing it, so the effective value was always 300s. The frozen schema would have accepted
  a **seven-day** ordinary upload grant while quarantine is capped at five minutes in two
  places — a real, undocumented asymmetry.
- **There is no GC of anything.** `deleteObject` has two call sites, both task attachments;
  no S3 lifecycle rule exists. Committed artifacts are never collected either.

## ★ 6. THE GAP (CLOSED by DAT-011) — kept because the reasoning still governs

**As shipped, this slice's runner was invoked by nothing** — the exact failure class this
programme keeps finding, which is why it had its own section rather than a footnote.
DAT-011 closed it with the event-driven trigger, option (2) below, and
`e6f-14-orphan-sweep` now proves the whole path live.

The analysis is retained because it is still the reason the sweeper is NOT scheduled, and
because the live lane went on to prove the fix's first placement wrong: the trigger fired
only on successful commits, never on the stale-fence refusal it was designed for.

It was not simply unwired. A periodic sweep must run **per organization** (`runInTenant`
scopes every query, and forced RLS filters on the tenant GUC), so a global sweeper needs to
**enumerate organizations** — and the tenant repository boundary **deliberately has no
unscoped reader**: *"a raw cross-tenant helper would sidestep the tenant context and forced
RLS"*, enforced by `tenant-repository-surface.test.ts`.

So wiring this requires choosing one of:

1. an **operator/admin-scoped** enumeration path that is explicitly outside the tenant
   boundary and audited as such;
2. an **event-driven** sweep — e.g. triggered per-organization when a commit is refused
   `stale_fence`, which is exactly when an orphan is created;
3. a **per-tenant scheduled** sweep driven by whatever already knows the tenant set.

(2) is attractive because it needs no enumeration at all and fires precisely when the
condition arises. It is a design decision with an RLS-shaped security question in it, and
it is **not** taken here.

The precedent for boot-time scheduling exists (`scheduleClaudeConfigDirSweeper`, called from
`server/src/index.ts`), so the mechanism is not the obstacle — the tenant enumeration is.

## 7. Follow-ups, unchanged from the design plus one

1. **Frozen TTL ceiling** for ordinary grants, mirroring quarantine — E4-D02 STOP.
2. **Retention enforcement for committed artifacts**, especially
   `CREDENTIAL_BEARING_ARTIFACT_KINDS` — a **live gap today**: the codebase declares those
   bytes "ARE a usable credential" and nothing reads the class back to act.
3. **`maxBytes` enforced at write** via a signed content-length-range condition — today it
   is advisory and dropped, so a presigned PUT admits an unbounded write for its whole TTL.
4. **NEW — schedule the sweeper** (§6), including the tenant-enumeration decision.
