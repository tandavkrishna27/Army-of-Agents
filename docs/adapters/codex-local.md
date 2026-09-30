---
title: Codex Local
summary: OpenAI Codex local adapter setup and configuration
---

The `codex_local` adapter runs OpenAI's Codex CLI locally. It supports session persistence via `previous_response_id` chaining and skills injection through the global Codex skills directory.

## Prerequisites

- Codex CLI installed (`codex` command available)
- `OPENAI_API_KEY` set in the environment or agent config

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `instructionsFilePath` | string | No | Absolute path to a markdown instructions file prepended to stdin prompt at runtime |
| `model` | string | No | Codex model to use (default: `gpt-5.5`). The runtime corrects API-key-only models (e.g. `gpt-5.3-codex`) to a ChatGPT-login-compatible model when the login isn't API-key mode — see the provider-switching engine. |
| `modelReasoningEffort` | string | No | Reasoning effort override (`minimal` \| `low` \| `medium` \| `high`) — passed via `-c model_reasoning_effort=...` |
| `promptTemplate` | string | No | Prompt used for all runs |
| `search` | boolean | No | Run Codex with `--search` |
| `fastMode` | boolean | No | Enable Codex Fast tier for lower-latency runs. Currently supported on `gpt-5.4` only; ignored on other models. |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | No | Skip safety checks (dev only; default: `true`) |
| `command` | string | No | CLI command to invoke (default: `codex`) |
| `extraArgs` | string[] | No | Additional CLI arguments |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout in seconds (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill after timeout/cancel |

## Session Persistence

Codex uses `previous_response_id` for session continuity. The adapter serializes and restores this across heartbeats, allowing the agent to maintain conversation context.

## Skills Injection

The adapter symlinks AoA skills into the global Codex skills directory (`~/.codex/skills`). Existing user skills are not overwritten.

## Environment Test

The environment test checks:

- Codex CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- Authentication signal (`OPENAI_API_KEY` presence)
- A live hello probe (`codex exec --json -` with prompt `Respond with hello.`) to verify the CLI can actually run

## Runtime-decision bridge (W5c)

The runtime-decision bridge puts a human in the loop for **risky runtime permissions**. When an agent is **supervised**, a codex run that proposes a risky shell command **or** a file-change patch pauses, surfaces an approval in the AoA Hub ("Waiting on you"), and waits for a founder to **allow or deny** before the CLI proceeds. This is the codex counterpart of the `claude_local` bridge (Decision #106 / sibling Decision #105); see also `docs/architecture/decisions.md` and the protocol reference `docs/adapters/codex-appserver-protocol.md`.

### Turning it on (default OFF)

Supervision is **off by default** and only activates when **all four** conditions hold:

1. **Instance kill-switch:** the server env `AOA_RUNTIME_DECISION_ROUTING=1`.
2. **Adapter:** the agent's adapter is `codex_local` (the resolver allow-lists `claude_local` + `codex_local`).
3. **Local execution:** the agent runs on the local execution target (Docker / remote-sandbox targets can't reach the loopback broker and stay on the default path).
4. **Per-agent opt-in:** `runtimeConfig.runtimeDecisionRoutingEnabled = true` on the agent.

If any condition is missing, the run takes the normal unsupervised path — **no behavior change**.

### Two execution paths

| Mode | Runtime | Behavior |
|------|---------|----------|
| Unsupervised (default) | `codex exec` (one-shot) | Existing path, unchanged. No approval prompts. |
| Supervised (opt-in) | `codex app-server` (long-lived, JSON-RPC over stdio) | Risky commands + file changes gate on founder approval before applying. |

Codex uses `app-server` **only** when supervised because it is the only codex mode that exposes a blocking approve/deny callback; `exec` cannot host the bridge. Supervision is chosen per run — toggling it on an agent at worst starts a fresh session thread, it never errors an in-flight run.

### Approval UX

- A pending approval appears in the AoA Hub as a **"Waiting on you"** row.
- **Allow** lets the command/patch proceed; **allow-always** approves and remembers the choice for the rest of the session; **deny** rejects it (codex reports the command/patch as rejected by the user).
- **Coverage:** both **shell commands** (`item/commandExecution/requestApproval`) and **file-change patches** (`item/fileChange/requestApproval`). Benign, trusted commands auto-approve and never prompt.
- **Fail-closed timeout:** if no one responds within **5 minutes**, the run is **denied** automatically (fail-safe deny) and the row stays **visible** in the hub so you can see what was missed. For unattended/overnight work, keep agents unsupervised or use trust rules rather than relying on the timeout.
- **Permission-only:** the bridge gates permissions. Codex "ask the user a question" prompts (`item/tool/requestUserInput`) are **not** yet routed and are deferred to a future workstream.

### Security posture

- **Out-of-tree writes are declined automatically** — a file-change whose target resolves outside the agent's working directory is rejected **without** ever surfacing as an approvable prompt (the founder can't accidentally approve a path-escape write).
- **`OPENAI_API_KEY` is never leaked to the app-server child.** The tracked-child spawn strips it from the inherited environment, so supervised runs neither expose the key nor accidentally switch billing modes.
- A cancelled run tears down cleanly — the pending approval is denied, the child process is signalled, and the turn unwinds without hanging.

The full JSON-RPC framing, approval-policy matrix, decision-enum mapping, token-usage shape, and cross-path resume behavior are documented in `docs/adapters/codex-appserver-protocol.md`.
