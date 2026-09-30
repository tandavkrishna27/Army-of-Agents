# E5 — Workspaces, Artifacts, Secrets, and Network Policy

**Status:** tickets `complete` — **exit gate NOT met.** DAT-001 through DAT-011 shipped, but of the 7 gate clauses 2 pass in D1, 4 are proven weakly, and 1 is not proven; all five shortfalls are build items (nothing wired), not coverage gaps. See [`qa/2026-08-24-d0-e5-exit-gate-audit-a1.md`](./qa/2026-08-24-d0-e5-exit-gate-audit-a1.md). (Reconciled from a stale `backlog` in the 2026-09-13 record-integrity sweep; ticket range corrected from `through DAT-007` to the actual `tickets/` set. `complete` was previously a ticket count, not the gate.)
**Depends on:** E3 and E4
**Tickets:** DAT-001 through DAT-011
**Exit gate:** immutable workspace staging, fenced object commit, patch conflict quarantine, lease-scoped secrets, redaction, denied egress, and the brokered internal tool surface (DAT-007) pass in D1.

## Mandatory planning brief

The E5 plan treats synchronization as immutable content exchange, not database replication or direct mutation of a live desktop folder. It must define explicit folder grants; isolated snapshot staging; Git/content base, dirty/untracked/ignore/case/special-file/executable/hash semantics; attributable data leaving a device; object retention/cleanup; base revalidation before apply; and review for conflicts, binaries, late output, and orphan output.

`DAT-006 — Local workspace admission and orphan reconciliation` implements the quarantine model in [`accepted-caveats.md`](../../accepted-caveats.md). Ordinary artifact commit always requires an active fence. Secret handles bind actor/owner, job/attempt/lease/fence, target identity/generation, trust, materialization, and policy; owner-bound material is denied on shared or differently owned targets. Required tests include path/symlink/case/special-file escape, dirty/untracked round trip, likely-secret exclusion, changed base, stale fence at each upload phase, quarantine non-promotion, owner/target/credential rotation, full disk, interrupted upload, and locality allowed/denied.
