---
title: HTTP Adapter
summary: HTTP webhook adapter
---

The `http` adapter sends a webhook request to an external agent service. The agent runs externally and AoA just triggers it.

## When to Use

- Agent runs as an external service (cloud function, dedicated server)
- Fire-and-forget invocation model
- Integration with third-party agent platforms

## When Not to Use

- If the agent runs locally on the same machine (use `process`, `claude_local`, or `codex_local`)
- If you need stdout capture and real-time run viewing

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Webhook URL to POST to |
| `method` | string | No | HTTP method (default: `POST`) |
| `headers` | object | No | Additional HTTP headers |
| `payloadTemplate` | object | No | Extra JSON fields merged into every request body |
| `timeoutMs` | number | No | Request timeout in milliseconds (0 = no timeout) |

## How It Works

1. AoA sends a POST request (or configured method) to the URL
2. The URL is validated and DNS-pinned before the request fires (SSRF guard — private IPs rejected)
3. The external agent processes the request and calls back to the AoA API
4. Non-2xx responses throw an error and fail the run

## Request Body

```json
{
  "agentId": "...",
  "runId": "...",
  "context": { ... },
  ...payloadTemplate
}
```

`context` is the execution context passed to the adapter (includes task info, wake reason, etc.). Any fields in `payloadTemplate` are merged into the body.

The external agent authenticates back to AoA using `AOA_API_URL` and an agent API key (configured separately in the agent's environment or hardcoded credentials).
