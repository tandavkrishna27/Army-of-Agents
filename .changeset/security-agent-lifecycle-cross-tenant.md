---
"@armyofagents/server": patch
---

fix(security): close cross-tenant IDOR on /agents/:id/{pause,resume,terminate} (parallel-C5 follow-up flagged by the PR #132 code review). Each handler now follows the canonical load → 404-if-missing → assertCompanyAccess → act pattern, mirroring the fix that PR #132 applied to /agents/:id/keys. Without this guard, a board user with membership in company A could pause/resume/terminate any agent in company B by knowing the agent UUID.
