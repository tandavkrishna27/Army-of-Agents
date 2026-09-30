---
"@armyofagents/server": patch
---

fix(security): close Commander RBAC bypass + capability bypass (C13). `executeTool` now gates on `tool.requiredRole` (against an actual `founder > team_lead > team_member` hierarchy) AND on `internal_agent_config.enabledCapabilities` for capability-gated categories (`discussion`, `action`, `memory`). The chat route now looks up the caller's effective role via `permissionService` instead of hardcoding `"founder"`. `mcp-bridge.ts` fails closed if `AOA_SESSION_USER_ROLE` is missing instead of defaulting to founder.
