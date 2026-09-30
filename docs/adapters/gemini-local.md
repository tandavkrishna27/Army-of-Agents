---
title: Gemini Local
summary: Gemini CLI local adapter setup and configuration
---

The `gemini_local` adapter runs Google's Gemini CLI locally. It supports session resume across heartbeats via `--resume` and skills injection into the Gemini local skills directory.

## Prerequisites

- Gemini CLI installed (`gemini` command available)
- Authentication via `GEMINI_API_KEY` / `GOOGLE_API_KEY` in the environment, or local Gemini CLI login

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `instructionsFilePath` | string | No | Absolute path to a markdown instructions file prepended to the run prompt |
| `model` | string | No | Gemini model ID (default: `auto`). Options: `auto`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`, `gemini-2.0-flash-lite` |
| `sandbox` | boolean | No | Run in sandbox mode (default: `false`; passes `--sandbox=none` when false) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `command` | string | No | CLI command to invoke (default: `gemini`) |
| `extraArgs` | string[] | No | Additional CLI arguments |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout in seconds (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill after timeout/cancel |

## Session Persistence

The adapter stores a session identifier after each run and resumes with `--resume` on the next heartbeat when the stored session's working directory matches the current `cwd`. A fresh session starts when the directory changes.

## Skills Injection

AoA auto-injects skills into `~/.gemini/skills/` via symlinks so the Gemini CLI can discover them. Skills files are materialized to disk before execution (`requiresMaterializedRuntimeSkills: true`).

## Invocation

Prompts are passed as positional arguments (not via stdin):

```
gemini [--resume <sessionId>] [--sandbox=none] [--model <model>] "<prompt>"
```

## Authentication

The adapter accepts both `GEMINI_API_KEY` and `GOOGLE_API_KEY`. If neither is set in the agent's environment, Gemini falls back to local CLI login credentials.

## Environment Test

The environment test checks:
- Gemini CLI is installed and accessible
- Working directory is valid
- Authentication signal (`GEMINI_API_KEY` / `GOOGLE_API_KEY` presence or local login)
- A live hello probe to verify CLI readiness
