---
"@armyofagents/server": patch
---

fix(security): close cross-tenant IDOR on /agents/:id/keys (GET, POST, DELETE). Agent loaded + assertCompanyAccess; DELETE additionally validates the key belongs to the named agent. Adds getKeyById service method. Closes C5.
