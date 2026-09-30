---
title: OpenClaw
summary: OpenClaw remote agent adapter — SSE streaming and webhook transport
---

The `openclaw` adapter wakes an OpenClaw agent over HTTP. The agent runs remotely and communicates back to AoA via its OpenClaw endpoint.

## When to Use

- Your agent runs as an OpenClaw server (remotely or on another machine)
- You want streaming execution via SSE in a single AoA run
- You want wake-style webhook callbacks

## When Not to Use

- You need local CLI execution on the same machine — use `claude_local`, `codex_local`, `cursor`, or `opencode_local`
- The OpenClaw endpoint is not reachable from the AoA server

## Configuration Fields

### Core

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | OpenClaw endpoint URL |
| `streamTransport` | string | No | `sse` (default) or `webhook` |
| `method` | string | No | HTTP method (default: `POST`) |
| `headers` | object | No | Extra HTTP headers for all requests |
| `webhookAuthHeader` | string | No | `Authorization` header value for webhook endpoints requiring auth |
| `payloadTemplate` | object | No | Additional JSON fields merged into each wake payload |
| `paperclipApiUrl` | string | No | AoA base URL advertised to the OpenClaw agent as `AOA_API_URL` (useful when AoA is behind a proxy) |
| `hookIncludeSessionKey` | boolean | No | Include derived `sessionKey` in `/hooks/agent` webhook payloads (default: `false`) |
| `timeoutSec` | number | No | SSE request timeout in seconds (default: `0` = no adapter timeout) |

### Session Routing

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKeyStrategy` | string | No | `fixed` (default), `issue`, or `run` |
| `sessionKey` | string | No | Fixed session key value when strategy is `fixed` (default: `paperclip`) |

### Hire-Approved Callback

Called when this agent is approved/hired via the approval workflow.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hireApprovedCallbackUrl` | string | No | Callback endpoint URL |
| `hireApprovedCallbackMethod` | string | No | HTTP method for the callback (default: `POST`) |
| `hireApprovedCallbackAuthHeader` | string | No | `Authorization` header for callback requests |
| `hireApprovedCallbackHeaders` | object | No | Extra headers merged into callback requests |

## Transport Modes

**`sse` (default):** AoA opens a long-lived SSE connection to the OpenClaw endpoint. The run stays open until the stream closes. Full stdout/log capture.

**`webhook`:** AoA sends a wake payload and returns immediately. The OpenClaw agent processes asynchronously and calls back to AoA's MCP endpoint. Use for fire-and-forget invocations or when the execution takes too long for a synchronous SSE session.

## Wake Payload

OpenClaw receives a JSON payload merged from `payloadTemplate` plus AoA context fields: `AOA_AGENT_ID`, `AOA_COMPANY_ID`, `AOA_API_URL`, and `AOA_RUN_ID`. `AOA_API_KEY` is **not** injected — the OpenClaw adapter has `supportsLocalAgentJwt: false`. The remote agent authenticates back to AoA using its own configured API key.

## Environment Test

The environment test checks that the OpenClaw URL is reachable and returns an expected response format.
