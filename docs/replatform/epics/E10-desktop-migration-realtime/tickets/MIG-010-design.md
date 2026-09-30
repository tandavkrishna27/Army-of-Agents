# MIG-010 — Legacy-resource reconciliation becomes runnable, and closure becomes decidable

**Status:** `shipped` (units 2.2–2.5; PR #336 = Unit 2.3, `597e77715`, migrations 0268/0269/0270) —
**corrected 2026-09-18** from the original `scoping stub` label below, which went stale after the units
landed. **Resolves E10-F002, E7-F004, E7-F005, E7-F006.** The reconciler gained a production operator-CLI
caller, the gate inventory narrowed to a DB-clock reconciliation watermark, and unattributable records got
an operator remedy. Original filing note (kept for provenance): *"filed so two open findings have a
checkable owner (E4-F013); no implementation, no result doc; the design work lives in
[`qa/2026-09-01-blocker-e-2-e-3-design.md`](../../../qa/2026-09-01-blocker-e-2-e-3-design.md)."*
**Epic:** `E10 — desktop migration / realtime`. **Owns:** `E10-F002` (E-2) and `E7-F004` (E-3).
**Filed (UTC):** `2026-09-01`, from Blocker E terrain verification at `c7ead3a73`.

## Why this is a ticket and not a line in MIG-008

MIG-008 shipped. Its result doc is on disk, so it cannot own an open finding without the ownership
reading as "owned by nobody" (E4-F013). What it shipped is also **half a mechanism**: a pure
classifier, a record builder, a closure assertion, and a pass that drives an injected store — none
of which anything calls, over a crosswalk table nothing writes.

Closing that is not "add a caller". Three separate things are wrong, and two of them are semantics:

1. **Nothing drives the pass** (E10-F002), and the pass cannot run as `aoa_operator` even if
   something did — it reads four tables neither serving role holds a grant on, and writes to
   `environment_leases`.
2. **The gate can never agree with any pass** (E7-F004): it re-derives its inventory from live rows,
   so every lease created after the pass is an unmapped key. On a box with traffic that is a
   permanently-losing race.
3. **Closure has no defined boundary.** Deciding what "reconciled" means as of a point in time is a
   design decision with a blast radius — it changes what the canary gate is allowed to answer — not
   a line in a composition ticket.

## Scope sketch (not a plan)

- The reconcile pass becomes **organization-scoped and read-only** (no `environment_leases` write),
  driven by an operator CLI that asserts the role it connected as.
- A **snapshot watermark**, DB-clock on both sides, bounds what closure is asserted over — with a
  freshness bound, because a watermark inverts the gate's failure direction from "tightens with
  traffic" to "loosens with age".
- The reads move to owner-owned `SECURITY DEFINER` functions, org-bound, `EXECUTE` to `aoa_operator`
  alone — the `0267` shape, ceremony included.
- A resolution path for an `unattributable` record, which today refuses the gate permanently with no
  remedy in code.

## Acceptance (to be fixed when this stops being a stub)

The canary preflight returns `ok` for an organization whose reconciliation has actually been run,
**on a box taking legacy traffic**, and still refuses for: no pass, a stale pass, an unresolved
`unattributable` record, and a superseded provider-key generation. Every refusal is a policy reason,
never `preflight_error`.

## Depends on

`MIG-008` (the pass being fixed), `CLI-006` (the gate that consumes it), and the definer-surface
precedent set by Units 1.6+1.7 (`c7ead3a73`).
