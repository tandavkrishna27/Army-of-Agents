---
"@armyofagents/server": patch
---

fix(security): close two more cross-tenant IDORs in the same C3/C5/C6 class — `PATCH /companies/:companyId/budgets` (any board user could modify any company's monthly budget) and `POST /heartbeat-runs/:runId/cancel` (any board user could cancel any company's heartbeat runs). Both surfaced by the regression-guard audit prep for the upcoming `assertBoard` pairing CI guard. Each route now follows the canonical load/lookup → assertCompanyAccess → act pattern established by PR #132 / PR #145.
