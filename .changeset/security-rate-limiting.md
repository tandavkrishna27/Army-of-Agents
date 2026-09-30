---
"@armyofagents/server": patch
---

Add per-route rate limits to defend against credential stuffing, billing-drain, and table-flood attacks. Limits: sign-in 10/min/IP, sign-up + forgot-password 5/hour/IP, CLI-auth challenges 5/min/IP (replaces the long-standing TODO at `cli-auth.ts:29`), transcribe 30/min/actor, internal-agent chat 60/min/actor. Uses `express-rate-limit` with the `draft-7` standardized headers; in-memory store (Redis-backed store is a follow-up for multi-instance deployments).
