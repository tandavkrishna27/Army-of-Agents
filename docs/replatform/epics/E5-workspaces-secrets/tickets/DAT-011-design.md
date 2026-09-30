# DAT-011 — Design: trigger the orphan sweep without enumerating tenants

**Status:** DESIGN. **Start SHA:** the commit that adds this file.
**Closes:** [`DAT-009-slice-2-result.md`](./DAT-009-slice-2-result.md) §6 — the runner exists and
nothing calls it.
**Founder decision:** event-driven trigger (option 2 of that section), authorised.

---

## 1. Why not a periodic sweeper

A periodic sweep must run **per organization** — `runInTenant` scopes every query and forced RLS
filters on the tenant GUC — so a global sweeper must **enumerate organizations**. The tenant
repository boundary **deliberately has no unscoped reader**: *"a raw cross-tenant helper would
sidestep the tenant context and forced RLS"* (`repositories/tenant/index.ts:10-13`), enforced by
`tenant-repository-surface.test.ts`.

Building that enumeration to satisfy a sweeper would punch a hole in the tenancy model for
housekeeping. **The event-driven trigger needs no enumeration at all**, because the event already
arrives inside a tenant context.

## 2. The trigger

`artifact-commit.ts:183-184` turns a `DbJobFenceError` into `rejected("stale_fence")`. **That is
the exact moment an orphan is created**: the bytes landed (commit was attempted, so the PUT
completed) and the fence that authorised them is gone.

The handler already runs inside `runInTenant` for the right organization. So the sweep is
triggered there, with the tenant context it needs already established.

## ★ 3. The timing problem, and why the sweep still waits for expiry

**A `stale_fence` refusal does NOT make its own object sweepable yet.** The grant remains
redeemable until `expiresAt` — up to 300s — so a **retry could still re-PUT to the same key**.
Deleting on refusal and having a retry land afterwards would recreate the orphan and leave the
record marked swept.

So `isSweepEligible` is unchanged: **strictly after `expiresAt`**, always. The trigger decides
*when to look*, never *what is eligible*. Those stay separate, and the eligibility decision
remains the single authority.

**Consequence:** the refusal that reveals an orphan does not collect *that* orphan. It collects
whatever has already expired, and this one is collected by a later trigger.

## ★ 4. The residual, stated rather than discovered later

**An organization whose LAST artifact activity produced an orphan keeps it** until that
organization commits an artifact again. There is no timer and no enumeration, so nothing else
will look.

This is a real, bounded gap and it is accepted deliberately:

- It is bounded by **one org's most recent orphan**, not an unbounded accumulation.
- The alternative — a timer surviving restarts, or tenant enumeration — costs materially more
  than the residual is worth, and enumeration weakens the tenancy model.
- It is **strictly better than today**, where nothing is ever collected.

If that residual later proves unacceptable, the honest fix is an operator-scoped maintenance
surface that is explicitly outside the tenant boundary and audited as such — **not** a quiet
cross-tenant reader added for housekeeping.

## 5. Shape

- **Best-effort and out of band.** The sweep must never fail, slow, or roll back a commit. It is
  fired after the commit outcome is decided, and every error inside it is swallowed with a log.
  A failed sweep is litter left for next time; a failed commit is lost work.
- **Debounced per organization.** Artifact commits can be frequent; sweeping on each would run
  the same indexed query repeatedly for nothing. At most one sweep per org per interval, in
  memory — a restart simply re-arms it, which is harmless.
- **Also triggered on SUCCESSFUL commits**, not only refusals. Success is the common event, so it
  gives far more collection opportunities, and the sweep is a no-op when nothing has expired.
  This is what keeps the §4 residual to "the last orphan" rather than "every orphan after the
  last refusal".

## 6. Tests

| Area | Test |
|---|---|
| A `stale_fence` refusal triggers a sweep for that org | injected trigger observed |
| A successful commit triggers one too | same |
| ★ The sweep NEVER changes the commit outcome | a throwing sweep leaves the response identical |
| ★ Debounce holds | N commits within the interval produce ONE sweep |
| Debounce releases | a commit after the interval produces a second |
| Eligibility is untouched | the trigger passes `now`; it does not widen what is sweepable |
| Anti-vacuity | a trigger that swept nothing is distinguishable from one that never ran |

## 7. Out of scope

- **Timers, schedulers, and cross-tenant enumeration** (§1, §4).
- **Changing `isSweepEligible`** (§3). The trigger decides when to look, never what qualifies.
- **Marking the refused artifact as a confirmed orphan.** Tempting — `orphanDisposition` already
  exists from DAT-006 — and it would let a future sweep distinguish "commit refused" from "never
  heard from". But it is not needed for correctness here, and widening the commit path's writes
  is not something to slip into a trigger ticket.
