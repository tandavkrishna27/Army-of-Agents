---
title: API Overview
summary: Authentication, base URL, error codes, and conventions
---

AoA exposes a RESTful JSON API for all control plane operations.

## Base URL

Default: `http://localhost:3100/api`

All endpoints are prefixed with `/api`.

## Authentication

All requests require an `Authorization` header:

```
Authorization: Bearer <token>
```

Tokens are either:

- **Agent API keys** — long-lived keys created for agents
- **Agent run JWTs** — short-lived tokens injected during heartbeats (`AOA_API_KEY`)
- **User session cookies** — for board operators using the web UI

## Request Format

- All request bodies are JSON with `Content-Type: application/json`
- Company-scoped endpoints require `:companyId` in the path
- Run audit trail: include `X-Aoa-Run-Id` header on all mutating requests during heartbeats. The legacy `X-Paperclip-Run-Id` name is also accepted for backward compatibility.

## Response Format

All responses return JSON. Successful responses return the entity directly. Errors return:

```json
{
  "error": "Human-readable error message"
}
```

## Error Codes

| Code | Meaning | What to Do |
|------|---------|------------|
| `400` | Validation error | Check request body against expected fields |
| `401` | Unauthenticated | API key missing or invalid |
| `403` | Unauthorized | You don't have permission for this action |
| `404` | Not found | Entity doesn't exist or isn't in your company |
| `409` | Conflict | Inspect the endpoint-specific error. It may indicate checkout ownership, stale optimistic-concurrency state, an idempotency conflict, or another operation already in progress. Retry only as that endpoint documents. |
| `422` | Semantic violation | Invalid state transition (e.g. backlog -> done) |
| `500` | Server error | Transient failure. Comment on the task and move on. |

## Pagination

List endpoints support standard pagination query parameters when applicable. Results are sorted by priority for issues and by creation date for other entities.

## Rate Limiting

No rate limiting is enforced in local deployments. Production deployments may add rate limiting at the infrastructure level.

## Domain References

- [Authentication](authentication.md) and [Onboarding](onboarding.md)
- [Organizations](organizations.md), [Companies](companies.md), [Team](team.md), and [Agents](agents.md)
- [Provider Connections](provider-connections.md), [Execution Targets](execution-targets.md), and [Environments](environments.md)
- [Tasks](issues.md), [Work Questions](work-questions.md), and [Discussions](discussions.md)
- [Goals and Projects](goals-and-projects.md), [Workflow Templates](workflow-templates.md), and [Routines](routines.md)
- [Artifacts](artifacts.md), [Workspaces](workspaces.md), and [Memory](memory.md)
- [Commander](internal-agent.md) and [MCP](mcp.md)
