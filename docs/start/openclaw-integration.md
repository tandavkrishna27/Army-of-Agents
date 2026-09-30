---
title: "OpenClaw integration"
summary: "How AoA orchestrates OpenClaw agents and the wire fields involved"
---

## What is OpenClaw?

OpenClaw is a separate open-source agent runtime project. It runs as a Docker gateway that manages agent sessions, tools, and LLM calls. The public repository is at `github.com/openclaw/openclaw` (referenced in the AoA Docker setup tooling).

AoA integrates with OpenClaw as one optional adapter (`adapterType: "openclaw"`). Nothing in AoA requires OpenClaw — it is one of several supported execution backends alongside `claude_local`, `opencode_local`, `codex_local`, and others.

## The relationship

AoA is the **control plane**. OpenClaw is one possible **execution plane**.

```
AoA (control plane)              OpenClaw (execution plane)
─────────────────────            ─────────────────────────
org chart / agents          ↔    agent runtime
tasks / approvals                tools + models
cost tracking                    workspaces
heartbeat scheduler              LLM calls
```

AoA decides *what* an agent should work on and *when*. OpenClaw decides *how* to actually run it. When a heartbeat fires for an OpenClaw-backed agent, AoA packages up a context bundle (company identity, goal, task details, memory items) and POSTs it to the OpenClaw gateway. OpenClaw executes the agent and reports results back.

## How they talk

The adapter (`packages/adapters/openclaw/`) supports two transport modes, selected via `adapterConfig.streamTransport`:

**SSE streaming (default, `streamTransport: "sse"`)**

AoA POSTs a streaming request to the OpenClaw gateway endpoint (typically `/v1/responses`). OpenClaw streams `text/event-stream` responses back until a terminal event (`[DONE]`, a `*.completed` event type, or a payload with `status: "completed"`). AoA consumes the stream inline within the heartbeat run.

```json
{
  "url": "http://127.0.0.1:18789/v1/responses",
  "streamTransport": "sse",
  "headers": { "x-openclaw-token": "replace-me" }
}
```

**Webhook callback (`streamTransport: "webhook"`)**

AoA POSTs a fire-and-forget request to an OpenClaw hook endpoint (`/hooks/agent` or `/hooks/wake`). OpenClaw processes asynchronously and calls back when done. If the configured URL is `/v1/responses` in webhook mode, the adapter first tries `/hooks/agent` and falls back to the original URL if the hook endpoint returns 404 — this lets older OpenClaw deployments keep working without config changes.

```json
{
  "url": "http://127.0.0.1:18789/hooks/agent",
  "streamTransport": "webhook",
  "headers": { "x-openclaw-token": "replace-me" }
}
```

Each request carries a `paperclip_session_key` field in the metadata (see [Wire compatibility](#wire-compatibility-and-the-paperclip-field-names) below).

## Onboarding an OpenClaw agent into AoA

The join flow is handled via `server/src/routes/access.ts`:

1. **Create an invite.** An operator creates an invite with `allowedJoinTypes: ["agent"]`. AoA returns an onboarding URL.

2. **OpenClaw POSTs a join request.** The OpenClaw client calls the invite endpoint including:
   - `agentDefaultsPayload.url` — the OpenClaw gateway endpoint AoA will call back to
   - `paperclipApiUrl` — the AoA base URL, so OpenClaw knows where to reach the AoA API
   - `headers["x-openclaw-auth"]` (or `x-openclaw-token`) — the gateway token AoA will use to authenticate outbound requests

3. **Board approval.** The join request lands in the AoA Inbox as a hire approval. A board member clicks through to approve. In `local_trusted` mode, the synthetic `local-board` actor handles this automatically.

4. **API key claim.** After approval, the OpenClaw client makes a one-time call to claim an `AOA_API_KEY`. This is a single-use secret — replaying the claim returns an error. The agent is now `idle` and ready to receive heartbeats.

Once bound, OpenClaw can call back into the AoA API as that agent, and AoA will invoke the OpenClaw gateway endpoint each time the heartbeat scheduler wakes the agent.

See [/api/agents](/api/agents) for the full join-request API contract.

## Quickstart paths

**Recommended for first-time setup — one command:**

```bash
pnpm smoke:openclaw-docker-ui
```

This clones the OpenClaw repo, builds a local Docker image, writes an isolated config, starts the gateway via Compose, and prints a dashboard URL. No flags required. Full guide: [/guides/openclaw-docker-setup](/guides/openclaw-docker-setup).

**Manual Docker setup:**

Follow "Option A: Docker Sandbox" (Docker Desktop v29+, microVM isolation) or "Option B: Docker Compose" (fallback for older Docker Desktop) in [/guides/openclaw-docker-setup](/guides/openclaw-docker-setup).

**Programmatic join:**

To integrate an existing OpenClaw deployment without the smoke script, use the join-request API directly. See [/api/agents](/api/agents).

## Wire compatibility and the "paperclip" field names

OpenClaw clients in the wild parse specific JSON field names that include the legacy "paperclip" string. Renaming these would break every existing OpenClaw deployment, so AoA preserves them unchanged:

| Field | Where it appears | What it carries |
|---|---|---|
| `paperclip_session_key` | `/v1/responses` metadata + `x-openclaw-session-key` header | Session routing key for the agent run |
| `paperclip_stream_transport` | `/v1/responses` metadata (webhook mode) | Signals webhook transport to the OpenClaw side |
| `paperclipApiUrl` | Join request payload + adapter config | AoA base URL advertised to OpenClaw as `AOA_API_URL` |

These names come from AoA's Paperclip lineage. The AoA adapter layer writes them exactly as OpenClaw expects. See [wire-compat.md](../architecture/wire-compat.md) for the complete list.

## Connectivity tips

**OpenClaw in Docker, AoA on the host**

From inside an OpenClaw container, `localhost` or `127.0.0.1` resolves to the container itself — not the host where AoA is running. Use `host.docker.internal` or the Docker bridge gateway IP instead:

```bash
# In your agent defaults
"paperclipApiUrl": "http://host.docker.internal:3100"
```

The `pnpm smoke:openclaw-docker-ui` script detects and prints the correct reachable URL automatically.

**Authenticated or private-mode deployments**

If AoA is running in `authenticated` mode, the hostname OpenClaw uses to call back must be in the allowed-hostnames list:

```bash
pnpm aoa allowed-hostname host.docker.internal
```

Restart AoA after adding the hostname. The join-request endpoint emits connectivity diagnostics in its response to help identify hostname and allow-list issues before approval.
