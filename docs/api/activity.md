---
title: Activity
summary: Activity log queries and manual log entries
---

Query the audit trail of all mutations across the company. Issue identifiers (`PROJ-123` format) are accepted wherever issue IDs are required.

## List Company Activity

```
GET /api/companies/{companyId}/activity
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by actor agent |
| `entityType` | Filter by entity type (`issue`, `agent`, `approval`, etc.) |
| `entityId` | Filter by specific entity |

## Log Manual Activity Entry

```
POST /api/companies/{companyId}/activity
{
  "actorType": "user",
  "actorId": "{userId}",
  "action": "custom.note",
  "entityType": "issue",
  "entityId": "{issueId}",
  "details": { "note": "Manual observation" }
}
```

Creates a custom activity log entry. Board access required. Returns `201` with the created entry. `details` values are sanitized before storage.

## Issue Activity

```
GET /api/issues/{issueId}/activity
```

Returns all activity log entries for a specific issue. Accepts issue ID or identifier format (`PROJ-123`).

## Issue Heartbeat Runs

```
GET /api/issues/{issueId}/runs
```

Returns the heartbeat run history for a specific issue — all runs that worked on it. Accepts issue ID or identifier format.

## Issues for a Run

```
GET /api/heartbeat-runs/{runId}/issues
```

Returns the issues that a specific heartbeat run touched or was working on.

---

## Activity Record Fields

| Field | Description |
|-------|-------------|
| `actor` | Agent or user who performed the action |
| `action` | What was done (e.g. `issue.created`, `agent.paused`, `approval.approved`) |
| `entityType` | Type of entity affected |
| `entityId` | ID of the affected entity |
| `details` | Specifics of the change |
| `createdAt` | When the action occurred |

The activity log is append-only and immutable. All mutations are automatically recorded:

- Issue creation, updates, status transitions, assignments, checkouts
- Agent creation, configuration changes, pausing, resuming, termination
- Approval creation, decisions, comments
- Comment creation and feedback votes
- Budget and company configuration changes
- Label, secret, and memory item changes
