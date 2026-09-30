---
title: Adapters Overview
summary: What adapters are and how they connect agents to AoA
---

Adapters are the bridge between AoA's orchestration layer and agent runtimes. Each adapter knows how to invoke a specific type of AI agent and capture its results.

## How Adapters Work

When a heartbeat fires, AoA:

1. Looks up the agent's `adapterType` and `adapterConfig`
2. Calls the adapter's `execute()` function with the execution context
3. The adapter spawns or calls the agent runtime
4. The adapter captures stdout, parses usage/cost data, and returns a structured result

## Built-in Adapters

| Adapter | Type Key | Description |
|---------|----------|-------------|
| [Claude Local](claude-local.md) | `claude_local` | Runs Claude Code CLI locally |
| [Codex Local](codex-local.md) | `codex_local` | Runs OpenAI Codex CLI locally |
| [OpenCode Local](opencode-local.md) | `opencode_local` | Runs OpenCode CLI locally (multi-provider `provider/model`) |
| [Cursor](cursor.md) | `cursor` | Runs Cursor Agent CLI locally |
| [OpenClaw](openclaw.md) | `openclaw` | Runs an OpenClaw agent remotely (SSE or webhook transport) |
| [Process](process.md) | `process` | Executes arbitrary shell commands |
| [HTTP](http.md) | `http` | Sends webhooks to external agents |
| [Gemini Local](gemini-local.md) | `gemini_local` | Runs Gemini CLI locally with session resume support |
| [Hermes Local](hermes-local.md) | `hermes_local` | Runs Hermes Agent (Nous Research) locally via the `hermes` CLI |

## Adapter Architecture

Each adapter is a package with three modules:

```
packages/adapters/<name>/
  src/
    index.ts            # Shared metadata (type, label, models)
    server/
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui/
      parse-stdout.ts   # Stdout -> transcript entries for run viewer
      build-config.ts   # Form values -> adapterConfig JSON
    cli/
      format-event.ts   # Terminal output for `aoa run --watch`
```

Three registries consume these modules:

| Registry | What it does |
|----------|-------------|
| **Server** | Executes agents, captures results |
| **UI** | Renders run transcripts, provides config forms |
| **CLI** | Formats terminal output for live watching |

## Choosing an Adapter

- **Need a coding agent on the local machine?** Use `claude_local`, `codex_local`, `opencode_local`, `cursor`, `gemini_local`, or `hermes_local`
- **Need to run a script or command?** Use `process`
- **Need to call an HTTP endpoint or external service?** Use `http`
- **Need to run a remote OpenClaw agent?** Use `openclaw`
- **Need something custom?** See [creating-an-adapter.md](creating-an-adapter.md)
