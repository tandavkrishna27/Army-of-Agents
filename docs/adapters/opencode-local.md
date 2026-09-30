---
title: OpenCode Local
summary: OpenCode local adapter setup and configuration
---

The `opencode_local` adapter runs OpenCode locally. It supports multi-provider routing in `provider/model` format and session resume across heartbeats via `--session`.

## Prerequisites

- OpenCode CLI installed (`opencode` command available)
- At least one provider API key configured (OpenCode reads from its own config)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `instructionsFilePath` | string | No | Absolute path to a markdown instructions file prepended to the run prompt |
| `model` | string | **Yes** | OpenCode model in `provider/model` format (e.g. `anthropic/claude-sonnet-4-5`). Required — OpenCode has no default. |
| `variant` | string | No | Provider-specific model variant (e.g. `minimal` \| `low` \| `medium` \| `high` \| `max`) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `command` | string | No | CLI command to invoke (default: `opencode`) |
| `extraArgs` | string[] | No | Additional CLI arguments |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout in seconds (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill after timeout/cancel |

## Session Persistence

The adapter stores a session ID after each run and resumes with `--session` on the next heartbeat when the stored session's working directory matches the current `cwd`. A new session starts when the directory changes.

## Skills Injection

AoA injects skills by materializing them to disk before execution. Skills files are required to be present on the filesystem before OpenCode starts (`requiresMaterializedRuntimeSkills: true`).

## Models

Run `opencode models` to list all available models in `provider/model` format. Models are discovered dynamically at runtime — static fallbacks are not provided. If discovery is unavailable, the models list for this adapter may be empty.

## Invocation

Runs are executed as:

```
opencode run --format json [--session <sessionId>] ...
```

## Environment Test

The environment test checks:
- OpenCode CLI is installed and accessible
- Working directory is valid
- Authentication signal for the configured provider
- A live hello probe to verify CLI readiness
