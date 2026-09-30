---
"@armyofagents/server": patch
"@armyofagents/shared": patch
---

fix(security): require founder role to set workspace shell commands (provision/teardown/cleanup) on projects, and reject agent/MCP actors entirely. Validator tightened to a strict Zod schema. Closes C1 (RCE via executionWorkspacePolicy.provisionCommand).
