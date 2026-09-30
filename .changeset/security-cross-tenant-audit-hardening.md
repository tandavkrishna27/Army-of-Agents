---
"@armyofagents/server": patch
---

Cross-tenant + audit hardening:
- DELETE /feedback-votes/:voteId now loads the vote and `assertCompanyAccess` before dismissal (DiD against UUID-knowledge attacks across companies).
- Better-auth trustedOrigins drops `http://<host>` in `authenticated`/`cloud_auth` deployments (downgrade-attack surface). `local_trusted` keeps both schemes for loopback dev.
- POST /agents/:id/keys activity log now uses the canonical `getActorInfo` spread for shape parity.
- DELETE /agents/:id/keys/:keyId now emits `agent.key_revoked` (was silent in the activity log — incident-forensics gap closed).
