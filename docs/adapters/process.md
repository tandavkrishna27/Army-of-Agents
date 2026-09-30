---
title: Process Adapter
summary: Generic shell process adapter
---

The `process` adapter executes arbitrary shell commands. Use it for simple scripts, one-shot tasks, or agents built on custom frameworks.

## When to Use

- Running a Python script that calls the AoA API
- Executing a custom agent loop
- Any runtime that can be invoked as a shell command

## When Not to Use

- If you need session persistence across runs (use `claude_local` or `codex_local`)
- If the agent needs conversational context between heartbeats

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `args` | string[] | No | Command arguments passed separately (avoids shell quoting issues) |
| `cwd` | string | No | Working directory (defaults to server's `process.cwd()`) |
| `env` | object | No | Environment variables (merged on top of injected AoA vars) |
| `timeoutSec` | number | No | Process timeout in seconds (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill after timeout (default: 15s) |

## How It Works

1. AoA spawns the configured command as a child process
2. Standard AoA environment variables are injected: `AOA_AGENT_ID`, `AOA_COMPANY_ID`, `AOA_API_URL`
3. The process runs to completion
4. Non-zero exit code marks the run as failed

Note: The `process` adapter does not issue an agent JWT — `AOA_API_KEY` is not injected. If the script needs to authenticate to the AoA API, provide a key via `env` or use an adapter that supports `supportsLocalAgentJwt` (e.g. `claude_local`, `codex_local`).

## Example

An agent that runs a Python script:

```json
{
  "adapterType": "process",
  "adapterConfig": {
    "command": "python3 /path/to/agent.py",
    "cwd": "/path/to/workspace",
    "timeoutSec": 300
  }
}
```

The script can use the injected environment variables to authenticate with the AoA API and perform work.
