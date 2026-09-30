---
"@armyofagents/server": patch
"@armyofagents/shared": patch
"@armyofagents/cli": patch
---

fix(security): close cross-tenant IDOR on /approvals/:id/approve|reject|request-revision (C3) and remove the spoofable `decidedByUserId` body field (C4). Decider is now derived from `req.actor.userId` server-side; CLI no longer accepts `--decided-by-user-id`.
