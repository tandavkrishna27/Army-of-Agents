---
title: Claude Local
summary: Claude Code local adapter setup and configuration
---

The `claude_local` adapter runs Anthropic's Claude Code CLI locally. It supports session persistence, skills injection, and structured output parsing.

## Prerequisites

- Claude Code CLI installed (`claude` command available)
- `ANTHROPIC_API_KEY` set in the environment or agent config

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `instructionsFilePath` | string | No | Absolute path to a markdown instructions file injected at runtime |
| `model` | string | No | Claude model to use (e.g. `claude-opus-4-6`) |
| `effort` | string | No | Reasoning effort passed via `--effort` (`low` \| `medium` \| `high`) |
| `chrome` | boolean | No | Pass `--chrome` when running Claude |
| `promptTemplate` | string | No | Prompt used for all runs |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat |
| `dangerouslySkipPermissions` | boolean | No | Pass `--dangerously-skip-permissions` to Claude (dev only) |
| `command` | string | No | CLI command to invoke (default: `claude`) |
| `extraArgs` | string[] | No | Additional CLI arguments |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout in seconds (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill after timeout/cancel |

## Prompt Templates

Templates support `{{variable}}` substitution:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{companyId}}` | Company ID |
| `{{runId}}` | Current run ID |
| `{{agent.name}}` | Agent's name |
| `{{company.name}}` | Company name |

## Session Persistence

The adapter persists Claude Code session IDs between heartbeats. On the next wake, it resumes the existing conversation so the agent retains full context.

Session resume is cwd-aware: if the agent's working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown session error, the adapter automatically retries with a fresh session.

## Skills Injection

The adapter creates a temporary directory with symlinks to AoA skills and passes it via `--add-dir`. This makes skills discoverable without polluting the agent's working directory.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Claude CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- API key/auth mode hints (`ANTHROPIC_API_KEY` vs subscription login)
- A live hello probe (`claude --print - --output-format stream-json --verbose` with prompt `Respond with hello.`) to verify CLI readiness

## Runtime Permission Bridge (Supervised Mode)

By default the `claude_local` adapter passes `--dangerously-skip-permissions` and lets the agent proceed uninterrupted. **Supervised mode** replaces this with a `PreToolUse` hook that pauses risky tool calls and routes them to the W5a human-decision hub, where a founder can **allow** or **deny** the call before the CLI continues.

### What it covers

Permission prompts only. The `work_question` kind (`AskUserQuestion`) is **deferred** — it is SDK-only and AoA is CLI-only (Decision #91); there is no CLI hook that intercepts it.

Intercepted tools: `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `WebFetch`. Read-only tools (Read, Grep, Glob, etc.) are never intercepted.

### Enabling supervised mode

Two gates must both be open:

| Gate | How to enable |
|------|--------------|
| **Per-agent flag** | Set `runtimeConfig.runtimeDecisionRoutingEnabled = true` on the agent |
| **Instance kill-switch** | Set env `AOA_RUNTIME_DECISION_ROUTING=1` on the AoA server process |

When both are set and the agent's `executionTarget.type` is `"local"`, the adapter:

1. Omits `--dangerously-skip-permissions`.
2. Mints a per-run bearer token and writes a temporary `settings.json` with a `PreToolUse` command hook (`hook-forward.mjs`).
3. Passes the settings file via `--settings` and the token via the `AOA_RUNTIME_HOOK_TOKEN` environment variable (redacted in logs).

### Fail-safe deny

The hook forwarder is a `type:"command"` process, not a native HTTP hook. Native HTTP hooks are fail-open (the CLI continues on any non-2xx or connection error). The command forwarder is **fail-closed**: it emits `{"decision":"deny"}` on any error, so a network blip or hub unavailability defaults to deny rather than allow.

### Timeout behaviour

The hub blocks for up to **5 minutes** (`RUNTIME_HOOK_BLOCK_TIMEOUT_SEC=300`). If no decision arrives in time, the server returns `deny` to the CLI (anti-hang). Timed-out prompts remain visible in the hub with `timeoutPolicy="escalate"`.

For overnight or unattended runs, keep agents on bypass (the default) or configure trust rules (allow-always) rather than relying on a longer timeout.

### Local-target only

The bridge requires the CLI to reach `127.0.0.1`. It is automatically disabled for Docker and remote sandbox execution targets regardless of the per-agent flag.

### Relationship to `dangerouslySkipPermissions`

`--dangerously-skip-permissions` and supervised mode are mutually exclusive. When supervised mode is active, the skip-permissions flag is never passed. When supervised mode is off (the default), the flag is passed as before.

## Crew Config Isolation (D9)

Crew agents (`kind='aoa'`) run with `isolateAmbientConfig`. Two things happen that
do not happen for org/heartbeat runs.

**1. The ambient Claude config is stripped.** The whole `CLAUDE_*` / `ANTHROPIC_*`
environment class is removed at the spawn, so the operator's host setup —
SessionStart hooks, third-party skills, plugins, the server's own
`ANTHROPIC_API_KEY`, and Claude Code's session-identity variables — cannot reach
a crew agent. `PATH`, `HOME`/`USERPROFILE` and the rest of the keep-list survive:
isolating the *config* is not the same as sandboxing the process, and git, SSH
and npm all resolve through those.

An operator whose Claude access is env-based keeps it by setting the variable on
the **agent's** `adapterConfig.env` (`CLAUDE_CODE_USE_BEDROCK`,
`ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or a
dedicated `CLAUDE_CONFIG_DIR`). Overlay values win over the strip; only the
ambient copy is dropped.

### Per-run config homes

**2. `CLAUDE_CONFIG_DIR` is pinned to a fresh directory per run**, and exactly one
file is copied into it: Claude's credential (`.credentials.json`). Nothing else —
not `CLAUDE.md`, not `settings.json`, not `plugins/`, `skills/`, `sessions/` or
`projects/`. A real operator config home has twenty entries; nineteen of them are
the contamination this exists to stop.

| | |
|---|---|
| **Where** | `$AOA_HOME/instances/<instanceId>/claude-config-homes/aoa-claude-config-*` (`AOA_HOME` defaults to `~/.aoa`) |
| **Contents** | one file: `.credentials.json`, mode `0600` on POSIX |
| **Lifetime** | removed when the run ends, success or failure |
| **Reclaim** | orphans (SIGKILL, crashed boot) swept at server start and hourly, once older than 12h |

These directories are **deliberately not in `os.tmpdir()`**. They hold a copy of a
live OAuth credential, and the system temp directory is shared by default —
Windows `%TEMP%` was measured carrying inherited Modify entries for other
principals, and on a service-account deployment it is `C:\Windows\Temp`. Rooting
under `AOA_HOME` puts the credential inside the user profile, which is the same
choice codex's managed home makes for the same reason. A directory a run still
holds is never swept, whatever its age.

### If you rename your instance

The sweeper only reclaims orphans under the **current** instance root — the one
`AOA_HOME` and `AOA_INSTANCE_ID` resolve to right now. It deliberately does not
touch sibling instance roots: the live-run registry that protects a running
agent's config home is per-process, so a cross-instance sweep could delete a
directory another running AoA instance is actively using.

The consequence: if you change `AOA_INSTANCE_ID` (or `AOA_HOME`), any orphans
left under the old root have no sweeper and will stay there. Check
`$AOA_HOME/instances/<old-id>/claude-config-homes/` after a rename and delete it
by hand — the directories may contain credential copies. Normal runs leave
nothing behind, so this is usually empty; it is only non-empty if the old
instance was killed mid-run.

If the operator is not logged in, the run **fails before spawning**, naming the
config home and `claude auth login`. An unauthenticated agent is not dispatched
to die inside the CLI with an opaque error. The exception is the env-based auth
above: if the agent carries a working auth mode, the run proceeds with an empty
config home and says so in its command notes.

> **Known open question — credential rotation.** Each run gets a private copy of
> the credential and deletes it at teardown. If the CLI refreshes the OAuth token
> mid-run, that refresh lands in the copy and is discarded with it. Whether that
> also invalidates the operator's host login depends on whether Anthropic rotates
> refresh tokens on use, which has not been established. AoA does not copy the
> credential back — writing to the operator's real `~/.claude` on an unverified
> premise is the more damaging guess — but it does log a warning if a run is
> observed rewriting its copy.
>
> **Where to look for it.** The warning is written to the run's **stderr
> transcript** — open the run in the agent's Runs tab (or the crew thread's run
> log) and search for `rewrote the per-run credential copy`. It is *not* a
> notification and *not* on the failure card, because the runs it appears on
> typically **succeeded**, and nobody opens the transcript of a successful run.
> That is a known gap: routing it to the Inbox is tracked separately.
>
> **Absence is not evidence.** The check runs in the adapter's teardown, so a run
> killed by SIGKILL — or by a server restart — never performs it. Long runs are
> both the most likely to have crossed the 8-hour token expiry and the most
> likely to be killed, so the population that would trigger the warning is the
> one most likely to skip it. If you ever have to run `claude auth login` again
> for no apparent reason, that is worth reporting even with no warning in any
> transcript. Either observation decides whether copy-back is needed.

### What this does *not* cover

Settings → Providers probes the **host** config home, not the per-run one, so it
can report Anthropic verified while crew runs fail auth. Each crew run's command
notes name the directory it actually used. Org/heartbeat runs are unaffected by
everything on this page.
