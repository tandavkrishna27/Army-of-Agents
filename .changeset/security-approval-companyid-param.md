---
"@armyofagents/server": patch
---

fix(security): defense-in-depth on approval mutations. `approvalService.approve/reject/requestRevision` now require a `companyId` argument and include `eq(approvals.companyId, companyId)` in the UPDATE's WHERE clause. If a future route forgets the route-layer `load+assertCompanyAccess` guard (which PR #131 added), the service silently refuses the cross-tenant write. Existing route handlers were updated to pass `existing.companyId` (which they already load). Closes the PR #131 follow-up flagged by the C3/C4 review as "defense-in-depth, deferred".
