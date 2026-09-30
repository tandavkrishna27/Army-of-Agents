# Team-template Update Discovery Plan

**Status:** Split from testing incident; validate demand before C2/C3
**Repository:** `MeteoriteLabs/AoA`

## Problem

Team-template updates currently have no complete reviewed-merge lifecycle, but
the catalog has one team and the default company-wide crew roster is
installer-owned. A generalized baseline, merge, lock, apply, rollback, and UI
platform is not justified until the update classes and founder demand are
separated.

## Product Classes

| Team class | Ownership | Candidate update model |
|---|---|---|
| Default company-wide crew | installer-owned roster | narrow signed-version update, preview, snapshot rollback |
| Department marketplace team | founder-editable | reviewed three-way merge if demand is observed |
| Founder-created team | founder-owned | never upstream-managed |

## Discovery Gate

1. Instrument detection only; make no automatic mutation.
2. Produce a read-only diff prototype for the default crew.
3. Record real update volume, customization prevalence, review completion, and
   support incidents.
4. Test the cheaper immutable alternative: install a new version side-by-side
   or clone into founder ownership.
5. Proceed to a generalized C2/C3 merge platform only after multiple real
   templates and founder update events justify it.

## Safety Invariants

- Unknown provenance defaults to preserve/conflict.
- Every founder edit remains byte-for-byte recoverable.
- Company-wide roster ownership from Decision #111 is not silently relaxed.
- Apply is transactional, version-checked, auditable, and replay-safe.

## Stop Condition

If detection shows negligible updates or founders prefer immutable replacement,
do not build generalized in-place team merging.

The prior C1/C2/C3 design remains historical input in
`archive/2026-07-28-testing-marketplace-recovery-and-followups-umbrella.md`.
