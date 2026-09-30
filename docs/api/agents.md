---
title: Agents
summary: Agent lifecycle, configuration, permissions, keys, wakeup, runtime state, and heartbeat runs
---

Manage AI agents within a company. Agents execute tasks via the heartbeat system — they are told what to work on, not polling for work.

## List Agents

```
GET /api/companies/{companyId}/agents
```

Returns all agents in the company.

## Get Agent

```
GET /api/agents/{agentId}
```

Returns agent details including chain of command.

## Get Current Agent

```
GET /api/agents/me
```

Returns the agent record for the currently authenticated agent (requires agent auth, not board auth).

## Create Agent (Direct)

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

Creates the agent directly in `idle` status, bypassing the approval queue. Requires board access.

## Hire Agent (Approval Flow)

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Engineer",
  "role": "engineer",
  "adapterType": "claude_local",
  "adapterConfig": { ... },
  "sourceIssueId": "{issueId}"
}
```

When `company.requireBoardApprovalForNewAgents` is true (the default), the agent is created in `pending_approval` status and a `hire_agent` approval request lands in the Inbox. When false, the agent is created `idle` directly. Use `sourceIssueId` or `sourceIssueIds` to link the hire request to an issue.

## Update Agent

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

## Update Permissions

```
PATCH /api/agents/{agentId}/permissions
{
  "allowedTools": ["bash", "read"],
  "deniedTools": []
}
```

Board users can update any agent. Agent callers must have `cxo` role and be in the same company.

## Update Instructions Path

```
PATCH /api/agents/{agentId}/instructions-path
{
  "value": "/path/to/CLAUDE.md",
  "adapterConfigKey": "agentsMdPath"
}
```

Sets the filesystem path to the agent's instructions file inside its adapter config. `adapterConfigKey` is optional — each adapter type has a default key. Returns `422` if the adapter type has no default and no key is provided.

## Delete Agent

```
DELETE /api/agents/{agentId}
```

Permanently removes the agent. Requires `founder` role. Returns `{ ok: true }`.

## Pause Agent

```
POST /api/agents/{agentId}/pause
```

Temporarily stops heartbeats for the agent.

## Resume Agent

```
POST /api/agents/{agentId}/resume
```

Resumes heartbeats for a paused agent.

## Terminate Agent

```
POST /api/agents/{agentId}/terminate
```

Permanently deactivates the agent. **Irreversible.**

## API Keys

### List Keys

```
GET /api/agents/{agentId}/keys
```

Returns all API keys for the agent (key values are not included).

### Create Key

```
POST /api/agents/{agentId}/keys
{ "name": "production-key" }
```

Returns `201` with the created key including the full `keyValue`. **Store it securely — the full value is only shown once.**

### Revoke Key

```
DELETE /api/agents/{agentId}/keys/{keyId}
```

Returns `{ ok: true }`.

## Wakeup

```
POST /api/agents/{agentId}/wakeup
{
  "source": "manual",
  "triggerDetail": "manual",
  "reason": "Re-check blocked task",
  "payload": null,
  "idempotencyKey": "{key}"
}
```

Triggers a heartbeat wake cycle for the agent. Agent callers can only invoke themselves (`403` if `agentId` doesn't match caller). Returns `202 { status: "skipped" }` if the run was not created (e.g. agent already active).

## Invoke Heartbeat (Board)

```
POST /api/agents/{agentId}/heartbeat/invoke
```

Manually triggers a heartbeat for the agent from the board. Simpler than `/wakeup` — no payload or idempotency options.

## Runtime State

### Get Runtime State

```
GET /api/agents/{agentId}/runtime-state
```

Returns the agent's current runtime execution state (active sessions, queued work, adapter status). Board only.

### List Task Sessions

```
GET /api/agents/{agentId}/task-sessions
```

Returns the agent's task session history. Sensitive fields in `sessionParamsJson` are redacted. Board only.

### Reset Session

```
POST /api/agents/{agentId}/runtime-state/reset-session
{ "taskKey": "{taskKey}" }
```

Clears the agent's active session state, optionally scoped to a specific task key. `taskKey` is optional. Board only.

## Instructions Bundle

The instructions bundle controls what instruction files an agent receives. Only applies to adapters that support it (e.g. `claude_local`, `codex_local`).

### Get Bundle

```
GET /api/agents/{agentId}/instructions-bundle
```

Returns the bundle configuration: mode, root path, entry file, and the list of files.

### Update Bundle Settings

```
PATCH /api/agents/{agentId}/instructions-bundle
{
  "mode": "file",
  "rootPath": "/path/to/instructions",
  "entryFile": "CLAUDE.md",
  "clearLegacyPromptTemplate": true
}
```

Updates the bundle configuration and persists it back to the agent's adapter config. Returns the updated bundle.

### Read File

```
GET /api/agents/{agentId}/instructions-bundle/file?path={relativePath}
```

Returns the content and metadata of a single file in the bundle. `path` query param is required.

### Write File

```
PUT /api/agents/{agentId}/instructions-bundle/file
{
  "path": "CLAUDE.md",
  "content": "# Agent Instructions\n\n...",
  "clearLegacyPromptTemplate": false
}
```

Creates or overwrites a file in the bundle. Returns the updated file metadata.

### Delete File

```
DELETE /api/agents/{agentId}/instructions-bundle/file?path={relativePath}
```

Deletes a file from the bundle. `path` query param is required.

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
GET /api/agents/{agentId}/config-revisions/{revisionId}
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View the full history of agent configuration changes and roll back to any previous revision.

## Org Chart

```
GET /api/companies/{companyId}/org
```

Returns the full organizational tree for the company.

## Adapter Models

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

Returns selectable models for an adapter type.

- `codex_local` — merged with OpenAI model discovery when available.
- `opencode_local` — discovered from `opencode models` in `provider/model` format. Can be empty if discovery is unavailable.

## Heartbeat Runs

### List Runs

```
GET /api/companies/{companyId}/heartbeat-runs
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by agent |
| `limit` | Max results (default 200, max 1000) |

### List Live Runs

```
GET /api/companies/{companyId}/live-runs
```

Returns all currently `queued` or `running` heartbeat runs for the company, enriched with agent name and adapter type. Optionally pads the result with recent completed runs.

Query parameters:

| Param | Description |
|-------|-------------|
| `minCount` | Minimum number of results (0–20). If live count is less than this, fills with recent completed runs. |

### Live Runs for Issue

```
GET /api/issues/{issueId}/live-runs
```

Returns active (`queued` or `running`) heartbeat runs whose context snapshot points at the given issue. Accepts issue ID or `PROJ-123` identifier format.

### Active Run for Issue

```
GET /api/issues/{issueId}/active-run
```

Returns the single currently active run for the issue, or `null` if none. Accepts issue ID or identifier format.

### Cancel Run

```
POST /api/heartbeat-runs/{runId}/cancel
```

Cancels an in-progress or queued heartbeat run. Board only. Returns the updated run.

### Run Events

```
GET /api/heartbeat-runs/{runId}/events
```

Returns structured events emitted during the run. Sensitive payloads are redacted.

Query parameters:

| Param | Description |
|-------|-------------|
| `afterSeq` | Return events after this sequence number (default 0) |
| `limit` | Max events (default 200) |

### Run Log

```
GET /api/heartbeat-runs/{runId}/log
```

Returns raw log output from the run as a byte stream segment.

Query parameters:

| Param | Description |
|-------|-------------|
| `offset` | Byte offset to start reading from (default 0) |
| `limitBytes` | Max bytes to return (default 256000) |
