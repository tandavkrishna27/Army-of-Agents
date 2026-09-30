---
title: Costs
summary: Cost events, summaries, and budget management
---

Track token usage and spending across agents, projects, and the company.

## Report Cost Event

```
POST /api/companies/{companyId}/cost-events
{
  "agentId": "{agentId}",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12,
  "occurredAt": "2026-04-25T10:00:00.000Z"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | UUID | yes | Agent that incurred the cost |
| `provider` | string | yes | e.g. `"anthropic"`, `"openai"` |
| `model` | string | yes | Model name/ID |
| `costCents` | integer | yes | Total cost in cents (non-negative) |
| `occurredAt` | ISO 8601 datetime | yes | When the cost was incurred |
| `inputTokens` | integer | no | Input token count (default 0) |
| `outputTokens` | integer | no | Output token count (default 0) |
| `issueId` | UUID | no | Task the cost is attributed to |
| `projectId` | UUID | no | Project the cost is attributed to |
| `goalId` | UUID | no | Goal the cost is attributed to |
| `billingCode` | string | no | Custom billing code |

Typically reported automatically by adapters after each heartbeat.

## Cost Analytics

All analytics endpoints accept optional `from` and `to` query parameters (ISO 8601) to filter by date range.

### Company Cost Summary

```
GET /api/companies/{companyId}/costs/summary
```

Returns total spend, budget, and utilization for the current month (or the specified date range).

### Costs by Agent

```
GET /api/companies/{companyId}/costs/by-agent
```

Returns per-agent cost breakdown.

### Costs by Project

```
GET /api/companies/{companyId}/costs/by-project
```

Returns per-project cost breakdown.

### Costs by Model

```
GET /api/companies/{companyId}/costs/by-model
```

Returns cost breakdown grouped by provider + model.

### Costs by Biller

```
GET /api/companies/{companyId}/costs/by-biller
```

Returns cost breakdown grouped by billing code.

## Budget Management

### Set Company Budget

```
PATCH /api/companies/{companyId}/budgets
{ "budgetMonthlyCents": 100000 }
```

Sets the company's monthly budget cap. Also upserts a matching company-scoped budget policy (80% warn threshold, hard stop enabled). Requires board role.

### Set Agent Budget

```
PATCH /api/agents/{agentId}/budgets
{ "budgetMonthlyCents": 5000 }
```

Sets an individual agent's monthly budget cap. Also upserts a matching agent-scoped budget policy (80% warn threshold, hard stop enabled). Agents may only update their own budget.

### Budget Overview

```
GET /api/companies/{companyId}/budgets/overview
```

Returns all active budget policies and open budget incidents for the company.

```json
{
  "policies": [ ... ],
  "openIncidents": [ ... ]
}
```

## Budget Policies

### Create / Update Budget Policy

```
POST /api/companies/{companyId}/budgets/policies
{
  "scopeType": "company",
  "scopeId": "{companyId}",
  "amountCents": 100000,
  "warnPercent": 80,
  "hardStopEnabled": true
}
```

Upserts a budget policy for the given scope. Requires board role.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scopeType` | `"company"` \| `"agent"` | yes | Scope of the policy |
| `scopeId` | UUID | yes | ID of the company or agent |
| `amountCents` | integer | yes | Budget cap in cents |
| `warnPercent` | integer 1–99 | no | Warning threshold percentage (default 80) |
| `hardStopEnabled` | boolean | no | Whether to hard-stop on 100% (default true) |

### Delete Budget Policy

```
DELETE /api/companies/{companyId}/budgets/policies/{policyId}
```

Removes a budget policy. Returns `{ "ok": true }` on success. Requires board role.

## Budget Incidents

### Resolve Budget Incident

```
POST /api/companies/{companyId}/budget-incidents/{incidentId}/resolve
{
  "action": "raise_and_resume",
  "newAmountCents": 150000
}
```

Resolves an open budget incident. Requires board role.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `"raise_and_resume"` \| `"dismiss"` | yes | How to resolve the incident |
| `newAmountCents` | integer | conditional | Required when `action` is `"raise_and_resume"` |

Returns `{ "ok": true }` on success.

## Budget Enforcement

| Threshold | Effect |
|-----------|--------|
| 80% | Soft alert — agent should focus on critical tasks |
| 100% | Hard stop — agent is auto-paused |

Budget windows reset on the first of each month (UTC).
