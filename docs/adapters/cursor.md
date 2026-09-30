---
title: Cursor
summary: Cursor Agent CLI local adapter setup and configuration
---

The `cursor` adapter runs Cursor's Agent CLI locally. It supports session resume across heartbeats via `--resume` and structured stream output.

## Prerequisites

- Cursor Agent CLI installed (`agent` command available)
- Cursor authenticated on the host machine

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `instructionsFilePath` | string | No | Absolute path to a markdown instructions file prepended to the run prompt |
| `model` | string | No | Cursor model ID (default: `auto`). Examples: `auto`, `gpt-5.3-codex`, `opus-4.6`, `sonnet-4.6` |
| `mode` | string | No | Cursor execution mode passed as `--mode` (`plan` \| `ask`). Leave unset for normal autonomous runs. |
| `promptTemplate` | string | No | Prompt used for all runs |
| `command` | string | No | CLI command to invoke (default: `agent`) |
| `extraArgs` | string[] | No | Additional CLI arguments |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout in seconds (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill after timeout/cancel |

## Session Persistence

The adapter stores a session identifier after each run. On the next heartbeat, it resumes the existing session with `--resume` when the stored session's working directory matches the current `cwd`. If the directory changed, a fresh session starts instead.

## Skills Injection

AoA auto-injects skills into `~/.cursor/skills/` via symlinks so Cursor can discover `$paperclip` and related skills on local runs. Skills files are materialized to disk before execution (`requiresMaterializedRuntimeSkills: true`).

## Invocation

Runs are executed as:

```
agent -p --output-format stream-json [--resume <sessionId>] [--mode <mode>] [--yolo] ...
```

Prompts are piped to Cursor via stdin. `--yolo` is automatically added unless `--trust`, `--yolo`, or `-f` is already present in `extraArgs`.

## Environment Test

The environment test checks:
- Cursor Agent CLI is installed and accessible
- Working directory is valid
- Authentication state via Cursor CLI
