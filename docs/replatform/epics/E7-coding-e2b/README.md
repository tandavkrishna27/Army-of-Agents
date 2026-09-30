# E7 — Coding/CLI on E2B

**Status:** `backlog`
**Depends on:** E3 through E6; CLI-006 additionally requires MIG-008 and `E10-REALTIME-FOUNDATION` (a cross-epic canary gate, not a cycle — MIG-008 depends on CLI-001/CLI-004, so the ticket graph stays acyclic: CLI-001/004 → MIG-008 → CLI-006)
**Tickets:** CLI-001 through CLI-006
**Exit gate:** one internal/staging canary Organization completes the full coding journey and the real-E2B D2 lane passes cancellation, artifact, and cleanup cases. This rehearsal does not replace the three-Organization D6 external-beta campaign.

## Mandatory planning brief

The E7 plan verifies the current E2B limit matrix and treats it under [`../../accepted-caveats.md`](../../accepted-caveats.md). CLI-001 runs the DEP-008 hostile isolation/cleanup suite against real E2B and records provider/template/policy versions. Provider-control credentials are injected only into the adapter-management boundary under DEP-006; focused real-E2B evidence covers rotation/revocation, old-key denial, new-key continuity, tenant/sandbox non-exposure, provider/target kill, and cleanup of pre-rotation resources through current monotonic cleanup authority. CLI-004 proves post-fence tagged-resource reconciliation cannot escalate, retarget, execute, open egress, or inspect tenant bytes. Common protocol/database fields remain provider neutral. Admission, cancellation, provider timeout/outage, TTL, pause/resume, leaked cleanup, changed workspace base, forbidden fallback, owner/locality constraints, and secret-canary scans have focused tests. CLI-005 also requires JOB-010 through JOB-014 current-control parity. CLI-006 cannot claim reconnect-safe evidence until the named `E10-REALTIME-FOUNDATION` preflight passes, cannot canary before DEP-009, and cannot transfer live ownership until MIG-008 has reconciled legacy leases/resources/provider authority. Coding is one of three mandatory private-beta workloads; passing E7/D2 alone cannot promote REL-005.
