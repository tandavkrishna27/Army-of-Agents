---
title: AoA Agents Acceptance Script
summary: §17 hard-bar acceptance test — proving the Discussion Extraction AoA agent produces real extracted items
---

# AoA Agents Acceptance Script

This guide is for board operators (founders and team leads) who want to run the §17 real-output acceptance test.
The acceptance test proves that the Discussion Extraction AoA agent can process a live discussion entry and
produce real `discussion_extracted_items` rows — the hard bar that a no-credentials mock cannot satisfy.

## Prerequisites

Before running this test you need a working AoA instance with:

- A running PostgreSQL database (see `docs/deploy/` for database setup)
- A company created and its database migrations applied
- The Claude Code CLI installed and authenticated on the machine running the server
  (same requirements as any `claude_local` adapter — see [Managing Agents](managing-agents.md))
- The AoA server running and connected to the database

## Setup

### 1. Locate the Discussion Extraction agent

Every company seeds a `Discussion Extraction` AoA agent automatically when the company is created
(via `ensureExtractionAgent`). Confirm it exists:

```sql
SELECT id, name, adapter_type, status
FROM agents
WHERE kind = 'aoa' AND name = 'Discussion Extraction';
```

The agent is created with `adapterType='process'` and no adapter command by default. You must
configure it to use `claude_local` before running the acceptance test.

### 2. Configure the `claude_local` adapter

Update the Discussion Extraction agent to use the Claude Code CLI adapter. You can do this via
the API:

```
PATCH /api/companies/:companyId/agents/:agentId
Content-Type: application/json

{
  "adapterType": "claude_local",
  "adapterConfig": {
    "cwd": "/path/to/your/working/directory"
  }
}
```

Or directly in the database:

```sql
UPDATE agents
SET adapter_type = 'claude_local',
    adapter_config = '{"cwd": "/path/to/your/working/directory"}'
WHERE kind = 'aoa' AND name = 'Discussion Extraction';
```

The `cwd` must be a directory the Claude Code CLI can use as a working directory. It does not
need to be a git repository — any writable directory works.

### 3. Verify the outbox trigger is enabled

The Discussion Extraction agent has an outbox trigger (`kind='outbox'`) that fires when a
discussion entry is pending. Verify it is enabled:

```sql
SELECT enabled, kind
FROM aoa_agent_triggers
WHERE agent_id = (
  SELECT id FROM agents WHERE kind = 'aoa' AND name = 'Discussion Extraction'
);
```

The `enabled` column should be `true`. If it is `false`, re-enable it:

```sql
UPDATE aoa_agent_triggers
SET enabled = true
WHERE agent_id = (
  SELECT id FROM agents WHERE kind = 'aoa' AND name = 'Discussion Extraction'
);
```

## Manual acceptance test

1. Open your AoA instance and navigate to **Discussions** in the sidebar
2. Create a new Discussion or open an existing one
3. Add a new entry containing a clear decision and a clear task, for example:
   > "We have decided to use PostgreSQL for the database. We need to set up the schema migrations."
4. Within one dispatch tick (the default heartbeat interval, approximately 45 seconds), the
   Discussion Extraction agent should run
5. Verify the following:
   - Real `discussion_extracted_items` appear attached to the discussion entry (a decision item
     and a task item, visible in the UI after extraction)
   - A completed run appears on the Discussion Extraction agent's Runs tab
   - The discussion entry's `extraction_status` column changed from `pending` → `processing` →
     `completed` (or `failed` if the adapter is misconfigured)
   - A `cost_events` row is recorded for the agent with `cost_cents=0` (v1 zeroed billing)

If the entry status is `failed`, check the `internal_agent_runs` table for the `error_message`
column — it will contain the Claude Code CLI error output.

## Running the automated acceptance test

Set the environment variable `AOA_ACCEPTANCE_CLI=1` and run the gated integration test:

```
cd server && npx vitest run src/__tests__/aoa-realoutput.integration.test.ts
```

**This test requires:**
- A running database (embedded-postgres is NOT used — you need a real external database)
- The `DATABASE_URL` environment variable pointing to a database with migrations applied
- A configured `claude_local` adapter on the Discussion Extraction agent
- Valid Claude Code CLI credentials on the test machine

Without `AOA_ACCEPTANCE_CLI=1`, the test skips entirely. This is intentional — the skip guard
is the honest §17 precondition. A credential-less run would be a false green.

On Windows, the test also skips unconditionally (embedded-postgres migration issues — see
Issue #114 and `docs/deploy/` for Linux/macOS guidance).

### Example run with credentials:

```bash
DATABASE_URL="postgres://user:pass@localhost:5432/aoa" \
AOA_ACCEPTANCE_CLI=1 \
npx vitest run src/__tests__/aoa-realoutput.integration.test.ts
```

The test polls for `extraction_status='completed'` on the seeded discussion entry with a 90-second
timeout (checking every 2 seconds). If the extraction agent processes the entry, the test asserts:

1. At least one `discussion_extracted_items` row for the entry
2. An `internal_agent_runs` row with `status='completed'` for the Discussion Extraction agent
3. The `discussion_entries` row has `extraction_status='completed'`

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Entry stays at `pending` indefinitely | Outbox trigger disabled or agent paused | Re-enable trigger; resume agent |
| Run row shows `status='failed'` with adapter error | `adapterType='process'` still set, or `claude_local` misconfigured | Apply Setup step 2 above |
| Run row shows `status='failed'` with auth error | Claude Code CLI not authenticated | Run `claude auth` on the server machine |
| `extraction_status='processing'` but no items appear | Claude Code CLI ran but did not call `submit_extracted_items` | Check the run's `error_message`; verify the tool allowlist includes `submit_extracted_items` |
| Test times out after 90 seconds | Dispatch loop not running or agent taking too long | Check the server logs for the AoA dispatcher; verify the heartbeat is not paused |

## Codex adapter variant (provider-neutral MCP bridge)

The internal-agent MCP bridge is **provider-neutral**: AoA agents (and the Commander chat) work on
`codex_local` as well as `claude_local`. Each CLI adapter translates the same neutral bridge spec
into its own MCP mechanism — `claude_local` via `--mcp-config`, `codex_local` via a
`[mcp_servers.aoa]` table written into the adapter-managed `CODEX_HOME/config.toml`.

### Codex setup

1. Install + authenticate the Codex CLI on the server machine (`codex login`; verify
   `codex login status`). Codex auth (`~/.codex/auth.json`) is copied into each managed
   `CODEX_HOME` automatically.
2. Configure the Discussion Extraction agent (and/or Commander) for codex:
   ```
   PATCH /api/agents/:agentId?companyId=:companyId
   { "adapterType": "codex_local",
     "adapterConfig": { "command": "codex", "cwd": "<writable dir>",
                        "dangerouslyBypassApprovalsAndSandbox": true } }
   ```
3. Commander **chat** on codex: Settings → Commander → CLI tool = `codex`
   (`internal_agent` config `executionMode:"cli", cliTool:"codex"`).

### Verified results (this branch, live, isolated instance)

- **§17 hard bar PROVEN on codex:** a discussion entry processed by the `codex_local` Discussion
  Extraction agent produced **3 real `discussion_extracted_items`** (`decision`, `task`,
  `insight`) via the wired MCP bridge — entry `completed`, run completed, cost event emitted.
  (Before the provider-neutral bridge: 0 items / stuck `processing`, because `--mcp-config` is a
  claude-only flag codex ignores.)
- **Codex Commander chat works end-to-end:** real streamed assistant reply AND persisted to
  conversation history (multi-turn via codex `resume`).
- Full server suite green (0 failed) + `tsc` clean with the generalization; `claude_local`
  byte-unchanged.

### Codex troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Codex run `failed`, stderr `Process adapter missing command` | Agent still `adapterType='process'` | Apply the Codex PATCH above |
| Codex `401 Unauthorized … api.openai.com` | Codex not authenticated / no `auth.json` in the managed `CODEX_HOME` | `codex login` on the server (auth auto-copied into managed homes) |
| Chat returns nothing / raw JSON | Stale build before the provider-neutral bridge | Rebuild/redeploy this branch (codex chat parses `codex exec --json` via `parseCodexJsonl`) |
| `opencode` chat says "not yet supported" | opencode MCP translator is a tracked follow-up (design-compatible, not implemented) | Use `claude` or `codex` for the chat |

## Commander Chat Foundation

**When to run:** After deploying any update to `agent-loop.ts`, `commander-context.ts`, `commander-skills.ts`, `cli-summarizer.ts`, or `context-assembly.ts`.

**Preconditions:** A company with ≥1 approved memory item (identity or domain layer). The Commander agent seeded with its persona bundle (AGENTS.md, SOUL.md, TOOLS.md, HEARTBEAT.md present).

**Manual check steps:**
1. Open the sidebar Commander chat for the test company.
2. Send 25+ messages in sequence (e.g., number them: "Message 1", "Message 2", …).
3. After 25+ messages, send: "What was message 5 about?" — Commander should reference it from the rolling summary.
4. Send a message referencing something in your approved company memory (e.g., mention a domain term from a memory note). Commander should incorporate the memory note in its reply.
5. Confirm the conversation continues replying after crossing the compaction threshold (no 500 errors, no blank replies).

**Pass criteria:**
- Commander remembers content from early in the conversation (history+compaction working).
- Commander's replies reflect approved company memory items (relevance injection working).
- No error responses after 20+ message exchanges.
