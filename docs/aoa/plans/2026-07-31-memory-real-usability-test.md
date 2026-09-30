# Memory — Real-Usability Test Plan (2026-07-31)

## Why this exists

Prior verification proved the **plumbing** of the enterprise-memory build: writes,
retrieval, the row-level RBAC gate (10 integration tests on real Postgres), the
tier/access/scope/core-block logic (unit tests), and the UI render. What it did
**not** do is watch a **real CLI agent / Commander / discussion actually READ and USE
memory** in a live run — that was blocked by CLI auth. This plan closes exactly that
gap: end-to-end, observed, on the running instance.

## Prerequisite (gating)

- **Valid `claude` CLI login.** Current on-disk creds are EXPIRED (`~/.claude/.credentials.json`
  `expiresAt` in the past; clean-env probe returns 401 "revoked"). → **User re-login once**
  (`claude` → `/login`). codex is authed but its account tier rejects all models, so claude
  is the path (Commander is configured `anthropic` / `claude-sonnet-4-6`).
- **Fix F1 must land first** (below), else the server — launched from within Claude Code —
  spawns a `claude` that inherits the CC session env and reports `needs_auth` even with a
  valid on-disk login.

## Fix F1 — scrub the Claude Code session env at CLI spawn

AoA today scrubs only the `ANTHROPIC_API_KEY` family (`resolve-crew-adapter.ts:310`). It does
NOT scrub the `CLAUDE_CODE_*` / session-OAuth vars a parent Claude Code session injects, so a
child `claude` uses the (revoked) session token instead of the machine's on-disk login. Add a
shared scrub applied at every CLI spawn (Commander cli-mode, crew runner, `claude_local`
adapter execute, and the `testEnvironment` probe): strip `CLAUDECODE`, `CLAUDE_CODE_*`,
`CLAUDE_AGENT_SDK_*`, `USE_STAGING_OAUTH`, `USE_LOCAL_OAUTH`, and the CC-injected
`ANTHROPIC_BASE_URL`. No-op in a normal terminal (vars absent); corrective only when AoA is
launched from Claude Code.
- **Accept:** after F1 + user re-login, `POST /internal-agent/verify` → `{"outcome":"verified"}`
  (was `needs_auth`).

## Test flows — each has a concrete PASS check

| # | Flow | Action | PASS = |
|---|------|--------|--------|
| T1 | **Commander recall** | Ask Commander "What is our company vision?" | Answer contains **"Be the memory layer every founder trusts"** (only in seeded identity memory) |
| T2 | **Commander write** | "Remember we deploy on Fridays after the 2pm review" | A **pending** item appears in Memory → Pending (founder-gated, not auto-approved) |
| T3 | **Discussion → extraction** | New thread, paste text with a clear decision + task → run extraction → approve items | Extracted items created (decision/task), approve → becomes a memory item |
| T4 | **Task → ORG agent run** | Create an org agent + task that requires recall, dispatch a run | Empirically determine + confirm HOW memory reaches the ORG agent: MCP `memory.search` call in the run (RBAC-scoped) and/or pinned skill file — settles the open T6 question (ORG `context.memory` is dead code) |
| T5 | **Crew agent run** | Crew agent works a thread task | The crew context bundle (scoped memory lines) is rendered into the agent prompt |
| T6 | **RBAC live** | 2 departments, memory scoped to each, agent assigned to Dept A | Dept-A agent retrieves A + company/identity memory, **NOT** Dept-B's scoped memory |

## How each is observed

- **Commander (T1/T2):** SSE stream of the `/internal-agent/chat` turn + the Memory UI.
- **ORG run (T4):** heartbeat run log + the run's MCP tool calls (`memory.search`) + the
  assembled context; add a temporary debug log if the path isn't visible.
- **Crew run (T5):** crew run log / the `buildTriggerPrompt` `## Context` block.
- **RBAC (T6):** drive retrieval as the Dept-A agent (via its run or MCP `memory.search` with
  the agent actor) and diff against Dept-B-scoped seed rows.

## Explicitly out of scope (note, don't block)

- **Semantic (pgvector) retrieval** — OFF (no embeddings key). All retrieval here is the
  keyword/temporal path. A separate pass with an embeddings key would exercise semantic recall.
- **Procedural self-improvement** (agents editing own instructions/skills) — separate session.

## Order of execution

1. Land F1 (env-scrub) + user re-login → verify `verified`.
2. T1, T2 (fastest, Commander).
3. T3 (discussion extraction).
4. T6 (RBAC — seed 2 departments).
5. T4, T5 (agent runs — need an agent + task set up).
6. Record PASS/FAIL per flow; fix any real defects found; re-run.
