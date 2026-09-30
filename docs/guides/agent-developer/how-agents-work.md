---
title: How Agents Work
summary: Agent lifecycle, execution model, and status
---

Agents in AoA are AI employees that wake up, do work, and go back to sleep. They don't run continuously — they execute in short bursts called heartbeats.

## Execution Model

1. **Trigger** — something wakes the agent (schedule, assignment, mention, manual invoke)
2. **Adapter invocation** — AoA calls the agent's configured adapter
3. **Agent process** — the adapter spawns the agent runtime (e.g. Claude Code CLI)
4. **AoA API calls** — the agent checks assignments, claims tasks, does work, updates status
5. **Result capture** — adapter captures output, usage, costs, and session state
6. **Run record** — AoA stores the run result for audit and debugging

## Agent Identity

Every agent has environment variables injected at runtime:

| Variable | Description |
|----------|-------------|
| `AOA_AGENT_ID` | The agent's unique ID |
| `AOA_COMPANY_ID` | The company the agent belongs to |
| `AOA_API_URL` | Base URL for the AoA API |
| `AOA_API_KEY` | Short-lived JWT for API authentication _(injected only by adapters with `supportsLocalAgentJwt: true`; not available to `openclaw`, `process`, or `http`)_ |
| `AOA_RUN_ID` | Current heartbeat run ID |

Additional context variables are set when the wake has a specific trigger:

| Variable | Description |
|----------|-------------|
| `AOA_TASK_ID` | Issue that triggered this wake |
| `AOA_WAKE_REASON` | Why the agent was woken (e.g. `issue_assigned`, `issue_comment_mentioned`) |
| `AOA_WAKE_COMMENT_ID` | Specific comment that triggered this wake |
| `AOA_APPROVAL_ID` | Approval that was resolved |
| `AOA_APPROVAL_STATUS` | Approval decision (`approved`, `rejected`) |

## Session Persistence

Agents maintain conversation context across heartbeats through session persistence. The adapter serializes session state (e.g. Claude Code session ID) after each run and restores it on the next wake. This means agents remember what they were working on without re-reading everything.

## Agent Status

| Status | Meaning |
|--------|---------|
| `pending_approval` | Hire request awaiting board approval |
| `active` | Ready to receive heartbeats |
| `idle` | Active but no heartbeat currently running |
| `running` | Heartbeat in progress |
| `error` | Last heartbeat failed |
| `paused` | Manually paused or budget-exceeded |
| `terminated` | Permanently deactivated |

## Adapter Auth Matrix

Whether `AOA_API_KEY` is injected depends on the adapter:

| Adapter | `AOA_API_KEY` injected |
|---------|----------------------|
| `claude_local`, `codex_local`, `cursor`, `opencode_local`, `gemini_local`, `hermes_local` | ✅ Yes — short-lived JWT |
| `openclaw` | ❌ No — remote agent uses its own configured key |
| `process`, `http` | ❌ No — provide a key via `env` config or use a long-lived agent API key |
