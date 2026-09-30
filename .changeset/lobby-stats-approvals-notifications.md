---
"@armyofagents/server": patch
---

Extend `GET /api/companies/stats` response with `pendingApprovalCount` and `unreadNotificationCount` per company. Aggregates from the `approvals` (status='pending') and `notifications` (readAt IS NULL) tables. Multi-tenant isolation preserved via the existing route-level filter against the actor's accessible companies. No schema changes; backward-compatible additive type expansion of the `CompanyStats` shape consumed by the lobby UI.
