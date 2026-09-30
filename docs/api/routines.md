---
title: Routines API
summary: Reusable scheduled, webhook, API, and manual task automation
---

Routines create repeatable task runs from schedules, authenticated webhooks, API triggers, or manual requests. They are company-scoped and keep a revision and run history.

For the board-operator workflow, see [How to Automate Recurring Work with Routines](../guides/board-operator/routines.md).

## List, Create, and Update

```http
GET /api/companies/{companyId}/routines
POST /api/companies/{companyId}/routines
GET /api/routines/{routineId}
PATCH /api/routines/{routineId}
```

Example create payload:

```json
{
  "title": "Weekly customer report",
  "description": "Summarize customer activity for {{date}}",
  "projectId": "{projectId}",
  "goalId": "{goalId}",
  "parentIssueId": "{issueId}",
  "assigneeAgentId": "{agentId}",
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed",
  "agentCompletionPolicyOverride": "review_required",
  "variables": [
    {
      "name": "region",
      "label": "Region",
      "type": "select",
      "defaultValue": "APAC",
      "required": true,
      "options": ["APAC", "EMEA"]
    }
  ]
}
```

Statuses are `active`, `paused`, and `archived`. Priorities are `urgent`, `high`, `medium`, and `low`.

Concurrency policies are `coalesce_if_active`, `always_enqueue`, and `skip_if_active`. Catch-up policies are `skip_missed` and `enqueue_missed_with_cap`.

Variable names begin with a letter and contain only letters, digits, and underscores. Types are `text`, `textarea`, `number`, `boolean`, and `select`. Templates interpolate variables as `{{name}}`; `{{date}}` is built in.

Only human operators with task-assignment authority can set `agentCompletionPolicyOverride` (`review_required`, `agent_can_complete`, or `null`). It participates in the task completion-policy precedence described in the [Tasks API](issues.md); the resolved policy is snapshotted on each generated task.

## Revision History

```http
GET /api/routines/{routineId}/revisions
POST /api/routines/{routineId}/revisions/restore

{ "revisionId": "{revisionId}" }
```

Restoring a revision requires board authentication and task-assignment authority.

## Triggers

```http
POST /api/routines/{routineId}/triggers
PATCH /api/routine-triggers/{triggerId}
DELETE /api/routine-triggers/{triggerId}
POST /api/routine-triggers/{triggerId}/rotate-secret
```

Trigger kinds:

- `schedule` — cron expression and timezone
- `webhook` — public endpoint protected by bearer-token or HMAC-SHA256 signing
- `api` — run through the authenticated API

Creating or rotating a webhook secret returns the plaintext secret once. Store it securely. Rotation invalidates the previous secret.

Webhook signing modes are `bearer` and `hmac_sha256`. HMAC triggers validate the request timestamp and replay window; the replay window can be configured from 0 to 86,400 seconds and defaults to 300 seconds.

Deleting a trigger returns `204`.

## Start a Run

```http
POST /api/routines/{routineId}/run

{
  "triggerId": "{triggerId}",
  "payload": { "source": "board" },
  "variables": { "region": "APAC" },
  "variableOverrides": { "date": "2026-07-18" },
  "idempotencyKey": "weekly-report-2026-07-18",
  "source": "manual"
}
```

Sources are `schedule`, `manual`, `api`, and `webhook`. Accepted runs return `202`. Use an idempotency key when a caller may retry.

```http
GET /api/routines/{routineId}/runs?limit=50
```

Lists recent runs.

## Public Webhook

```http
POST /api/routine-triggers/public/{publicId}/fire
Authorization: Bearer {secret}
Idempotency-Key: {key}
```

For HMAC triggers, compute the SHA-256 HMAC over `{timestamp}.{rawBody}`. Send the timestamp in `X-Aoa-Timestamp` and the hex digest (optionally prefixed with `sha256=`) in `X-Aoa-Signature`. The legacy `X-Paperclip-Timestamp` and `X-Paperclip-Signature` names are also accepted. Valid requests return `202`. Public webhook callers do not otherwise need board or agent authentication.

## Authorization

Company access is required for routine reads. Human operators need task-assignment
authority to create routines, change assignment, activate or run them, create or
update triggers, restore revisions, and set completion-policy overrides. Deleting
a trigger or rotating its secret uses the existing-routine management check but
does not currently add the task-assignment permission check. An agent may manage
a routine assigned to itself where the route permits, but cannot set completion
policy.
