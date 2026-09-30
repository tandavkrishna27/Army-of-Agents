---
"@armyofagents/db": patch
---

feat(db): add `0115_enable_pgvector.sql` preflight migration that runs `CREATE EXTENSION IF NOT EXISTS vector` ahead of any future vector-column migrations (Thread-Native Agent Coordination Pre-Task 0.5). Wrapped in `DO $$ ... EXCEPTION` so it no-ops on installs without pgvector (embedded-postgres bundle, CI postgres:16) and only enables the extension where the binary is available. Memory semantic-search paths remain gated by `probeDbCapabilities()`.
