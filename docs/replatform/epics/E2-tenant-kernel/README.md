# E2 — Tenant-safe Control-plane Kernel

**Status:** `complete` (gate `a2` = `pass`; all 8 ticket ledgers `complete`; gate green Windows-local per the E0/E1 operator-directed precedent — E2-D05 amendment / E2-F008 RESOLVED)
**Depends on:** E0 (pass) — independent of E1
**Tickets:** TEN-001a/b, TEN-002, TEN-003, TEN-004, TEN-005, TEN-006a/b — **all `complete`**, each independently reviewed (reviewer ≠ implementer).
**Exit gate:** non-owner PostgreSQL role, forced RLS, mandatory tenant transactions, composite integrity, sentinel-Organization removal, and the adversarial tenant suite — **all green** at gate code revision `acf2b32fb`.

**Artifacts:** [`implementation-plan.md`](implementation-plan.md) · [`decisions.md`](decisions.md) (E2-D01…D09) · [`findings.md`](findings.md) (E2-F001…F013, all resolved/corrected) · [`qa/`](qa/) ([`a2` D0 = `pass`](qa/2026-08-09-d0-e2-tenant-kernel-9a5455071f8c-a2.md), supersedes [`a1` = `blocked_external`](qa/2026-08-09-d0-e2-tenant-kernel-acf2b32fba48-a1.md); + baseline) · [`handoffs/`](handoffs/) ([`a2` = `pass`](handoffs/2026-08-09-epic-completion-9a5455071f8c-a2.md), supersedes `a1` = `blocked_external`).
**Execution order (as run):** TEN-001a/b → TEN-004 → TEN-006a/b → TEN-002 → TEN-003 → TEN-005 → E2 gate.
**Gate decision:** the operator (TK, Security + Integration Gate Owner) accepted the Windows-local H-01 evidence for E2 to the E0/E1 operator-directed standard (Linux CI remains the formal authority per DEC-03; a later Linux divergence supersedes). H-01 is a HARD invariant that **passed** — this is acceptance of evidence for a pass, not the waiver of a failure.

## Mandatory planning brief

The E2 plan must enumerate every new tenant-owned table, repository, background path, worker API, object key, realtime subscription, backup/restore path, and migration role. Missing Organization context fails closed; Company/Organization duplication is protected by composite constraints; no application path uses an owner/superuser role. `TEN-006 — Remove sentinel Organization defaults` inventories every legacy default/sentinel row and caller, maps it to an authoritative Organization or quarantines it, and blocks distributed admission until no implicit tenant remains. The global platform-target catalog is explicitly non-tenant data with operator-only writes and no tenant-facing list API; the internal scheduler may read eligibility but establishes job Organization/RLS scope before details are returned or leased. Property evidence must include hostile identifiers through HTTP, scheduler, platform/Organization/owner target selection, worker events, WebSockets, artifact/quarantine keys, placement, and restored data at the D1 floor in [`../../test-gates.md`](../../test-gates.md).
