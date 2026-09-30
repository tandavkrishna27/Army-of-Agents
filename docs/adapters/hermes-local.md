---
title: Hermes Local
summary: Hermes Agent (Nous Research) local adapter setup and configuration
---

The `hermes_local` adapter runs Hermes Agent (by Nous Research) locally via the `hermes` CLI. Hermes is a full-featured AI agent with 30+ native tools, persistent memory, session persistence, skills, and MCP support.

## Prerequisites

- Python 3.10+ installed
- Hermes Agent installed: `pip install hermes-agent`
- At least one LLM API key in `~/.hermes/.env`

## Wire Protocol

Hermes uses a Paperclip-compatible wire protocol. The adapter **always** injects:

- `PAPERCLIP_RUN_ID` — current heartbeat run ID
- `PAPERCLIP_API_KEY` — agent JWT (when not explicitly configured; explicit key takes precedence)

**Do not rename these to `AOA_*`** — they are wire-protocol contracts with the `hermes-paperclip-adapter` package and must stay as-is. See [paperclip-migration.md](../paperclip-migration.md).

## Configuration Fields

### Core

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `anthropic/claude-sonnet-4` | Model in `provider/model` format |
| `provider` | string | auto | API provider (`auto`, `openrouter`, `nous`, `openai-codex`, `zai`, `kimi-coding`, `minimax`, `minimax-cn`). Usually not needed — Hermes auto-detects from model name. |
| `hermesCommand` | string | `hermes` | Path to the `hermes` CLI binary |
| `env` | object | `{}` | Extra environment variables |
| `promptTemplate` | string | (default) | Custom prompt template with `{{variable}}` placeholders |

### Tool Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolsets` | string | (all) | Comma-separated toolsets to enable (e.g. `terminal,file,web`) |

### Session & Workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `persistSession` | boolean | `true` | Resume sessions across heartbeats |
| `worktreeMode` | boolean | `false` | Use git worktree for isolated changes |
| `checkpoints` | boolean | `false` | Enable filesystem checkpoints |

### Operational

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeoutSec` | number | `300` | Execution timeout in seconds |
| `graceSec` | number | `10` | Grace period before SIGKILL after SIGTERM |
| `verbose` | boolean | `false` | Enable verbose output |
| `extraArgs` | string[] | `[]` | Additional CLI arguments |

## Prompt Template Variables

| Variable | Value |
|----------|-------|
| `{{agentId}}` | AoA agent ID |
| `{{agentName}}` | Agent display name |
| `{{companyId}}` | AoA company ID |
| `{{companyName}}` | Company display name |
| `{{runId}}` | Current heartbeat run ID |
| `{{taskId}}` | Current task/issue ID (if assigned) |
| `{{taskTitle}}` | Task title (if assigned) |
| `{{taskBody}}` | Task description (if assigned) |
| `{{projectName}}` | Project name (if scoped to a project) |

## Session Persistence

Hermes sessions are persisted across heartbeats when `persistSession: true`. The session is identified by the agent ID and task context. Session resume allows Hermes to maintain memory and context between heartbeat windows.

## Environment Test

The environment test checks:
- Python 3.10+ is available
- `hermes` command is accessible
- Configured API key is present in the environment
