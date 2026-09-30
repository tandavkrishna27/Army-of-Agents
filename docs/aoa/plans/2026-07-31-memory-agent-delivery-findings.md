# Memory → Agent Delivery: Findings & Fix Plan (2026-07-31)

Real-usability testing of the enterprise-memory build — driving **live CLI agent
runs** to verify memory actually reaches Commander / Crew / Org agents (not just
that it's stored + RBAC-gated). This is the "does a real agent USE memory" layer
the prior verification did not cover.

## ✅ Proven

- **Memory plumbing + RBAC + retrieval** — live on the running instance + 10 RBAC
  leakage integration tests on real Postgres (see the as-built topic note).
- **Real CLI agent runs authenticate + execute in-sandbox.** Multiple `claude_local`
  ORG runs completed (exit 0). The claude adapter's **verify PROBE** reports
  `needs_auth`, but that is a **false-negative specific to the probe** — it runs
  from default `~/.claude` (with the user's `superpowers` SessionStart hook) under a
  staging Claude Code env. Real runs use **D9-isolated config** (only the copied
  `.credentials.json`, no hooks) and authenticate fine.
- **Env cause identified.** Launching AoA from a *staging* Claude Code session
  injects **18** `CLAUDE_CODE_*` / staging-OAuth / `ANTHROPIC_BASE_URL` vars that
  route default-config CLI spawns to staging, where a production `claude login`
  reads as "revoked." **Fix shipped:** opt-in `AOA_STRIP_CC_ENV=1` startup scrub
  (`server/src/index.ts`) — no-op in a normal terminal; strips the CC session vars
  when AoA is launched from Claude Code. (D9-isolated runs are unaffected — they use
  the copied creds, not the ambient env.)

## ⚠️ The ORG memory-delivery gap — 3 stacked issues

An ORG heartbeat agent, out of the box, **cannot retrieve memory**. Root-caused to
three concrete, independent gaps (agent's own words: *"memory.search … is not
available in my environment"*, *"you haven't granted it yet"*):

1. **Allowlist omission.** Memory tools were absent from
   `ORG_HEARTBEAT_TOOL_ALLOWLIST` (`server/src/services/heartbeat-mcp.ts`).
   **FIXED** — added `memory.search` + `memory.get` (+ test assertion). Necessary
   but **not sufficient** on its own (see #2).
2. **Dotted tool names are dropped by Claude.** `memory.search` / `memory.get` /
   `memory.write` / `memory.retain` are the *only* dotted tool names in the registry
   (`server/src/mcp/tools/index.ts`). Claude's tool-name schema is
   `^[a-zA-Z0-9_-]+$` — no dots — so `mcp__aoa__memory.search` never survives
   exposure. **Confirmed empirically:** the agent's `system/init` loaded exactly 7
   tools, all underscore-named; `memory.search` absent; the agent fell back to
   `ToolSearch` and failed to find it. **Fix needed:** alias/sanitize dotted MCP tool
   names for Claude at the bridge (`memory.search` → `memory_search` on the wire;
   keep server-side dispatch keyed by the canonical name), and use the sanitized name
   in the allowlist. (Renaming the tools registry-wide is the bigger-blast-radius
   alternative.)
3. **No permission auto-grant.** Even the exposed tools are blocked —
   `permissionMode: "default"`, *"Claude requested permissions to use
   mcp__aoa__get_task, but you haven't granted it yet."* The org heartbeat run is not
   bridged to auto-approve read tools. **Fix needed:** for org/crew runs, enable the
   W5b PreToolUse bridge to auto-approve allowlisted **read-only** tools (or pass a
   permission mode / `allowedTools` that permits the allowlisted MCP tools). Writes
   stay gated.

## Crew status — untested, should work

CREW renders scoped memory **directly into the prompt's `## Context`**
(`server/src/services/internal-agent/aoa-agents/crew-context-bundle.ts:591`) — no
MCP, no tool names, no permissions. Unaffected by #2/#3. **Not yet run** — trigger
via braindump→Librarian or a crew-task dispatch, then inspect the trigger prompt for
the memory bundle.

## Commander status — untested, likely same MCP gaps

Commander uses the same dotted MCP memory tools → likely hits #2 (dotted names) and
#3 (permission). It also uses default-config `cli-mode` (not D9-isolated), so it
depends on `AOA_STRIP_CC_ENV` for auth in the sandbox. **Not yet run.**

## Fix plan (next focused session)

1. **Alias dotted MCP tool names for Claude** at the bridge — `memory.*` →
   `memory_*` on the wire, canonical dispatch preserved. Update the org allowlist +
   Commander toolset to the sanitized names. Bridge unit test for the mapping.
2. **Auto-grant read-only MCP tools** for org/crew runs (bridge auto-approve for
   allowlisted reads, or read-only permission mode). Test.
3. **Prove all three live:** Org (`memory.search` recall of the seeded vision),
   Crew (`## Context` bundle rendered in the prompt), Commander (recall).
4. Keep `AOA_STRIP_CC_ENV` for the launched-from-Claude-Code dev/sandbox case.

## Reproduction

```
AOA_STRIP_CC_ENV=1 AOA_HOME=C:\Users\TK\.aoa\mem-inst PORT=3130 \
  AOA_EMBEDDED_POSTGRES_PORT=54340 AOA_DEV_LOCAL_IDENTITY=1 \
  pnpm -C C:/Users/TK/.aoa/wt/mem --filter @armyofagents/server dev
```
- Company **AcmeMem** `febba560-8625-4aa1-b61b-2207f76faef5`; seeded identity memory
  (vision = "Be the memory layer every founder trusts").
- Org agent **MemProbe** `fe83831b-d050-46b5-9355-e8f1fa204628` (`claude_local`).
- Create a todo task assigned to it → `POST /api/agents/:id/wakeup {"source":"assignment"}`
  → `GET /api/heartbeat-runs/:runId/log`. The `system/init` line lists the exact
  tools the agent loaded (the exposure canary).

---

## CORRECTION & complete diagnosis (2026-07-31, cont.)

The "dotted tool names" theory above was **WRONG**. Agents do **not** use the
external MCP-server registry (`mcp/tools/index.ts`, where `memory.search` is dotted).
They use the **internal-agent** registry (`createToolRegistry` in
`services/internal-agent/tool-registry.ts`), whose memory-read tool is
**`query_memory`** — underscore-named, `requiredRole: team_member`,
`requiresConfirmation: false`. No dot problem exists for agents at all.

**Gap #1 (exposure) — FIXED + VERIFIED** (commit `5264729b3`, supersedes `ff1d17646`):
the org allowlist now lists `query_memory` (not `memory.search`), and the always-on
core hint names `query_memory`. **Live-verified:** `mcp__aoa__query_memory` now
appears in the org agent's `system/init` tool list (it never did before).

**Gap #2 (permission) — the remaining blocker, two sub-issues:**
- **(a) The runtime-decision bridge is NOT activating** for the org run. Despite
  `AOA_RUNTIME_DECISION_ROUTING=1` + the agent's `runtimeConfig.runtimeDecisionRoutingEnabled=true`,
  the server log shows **zero** PreToolUse-hook / runtime-decision activity, and the
  agent hits Claude's *default*-mode `"you haven't granted it yet"`. So
  `resolveRuntimeDecisionRoutingEnabled` is returning **false**. Prime suspect:
  `agent.runtimeConfig` reaches the heartbeat as a JSON **string**, so the
  `typeof agentRuntimeConfig === "object"` guard fails and the per-agent opt-in reads
  false. **Next:** log the 4 conditions in `resolveRuntimeDecisionRoutingEnabled`
  (`runtime-decision-routing-flag.ts`) for a real run and fix whichever is false
  (parse `runtimeConfig` if it's a string).
- **(b) Even once bridged, the broker prompts for founder approval on EVERY tool
  call**, including the read-only `query_memory` — headless runs have no founder, so
  they stall. **Designed fix (implemented, then reverted as unverified because (a)
  blocks live testing):** auto-allow a fixed read-only set
  (`query_memory`, `find_similar_memory`, `get_task`, `get_heartbeat_context`) in the
  PreToolUse hook (`routes/runtime-hooks.ts`) *before* the broker call — reads have no
  side effects and are already RBAC-gated; writes still route to the broker. Match on
  the bare (unprefixed) tool name (`mcp__aoa__query_memory` → `query_memory`).

**Net ORG status:** memory is now REACHABLE (tool exposed); delivery is blocked by the
permission bridge — first make bridging activate (a), then auto-approve safe reads (b).
The governed path (founder approves in the Inbox) would already work once (a) is fixed.

**Crew / Commander:** still untested. Crew renders memory into the prompt (no MCP →
unaffected by #2). Commander uses the same `query_memory` tool → will need (b) too.

## Fix plan (superwedes the earlier one)

1. Fix bridge activation (a): instrument `resolveRuntimeDecisionRoutingEnabled`,
   ensure `agent.runtimeConfig` is an object (parse if string) so the opt-in reads true.
2. Re-apply the read-only auto-approve (b) in `runtime-hooks.ts` + a route unit test.
3. Prove all three live: Org (`query_memory` recall), Crew (`## Context` bundle),
   Commander (`query_memory` recall).

---

## ✅ RESOLVED — ORG memory delivery PROVEN end-to-end (2026-07-31)

A real org `claude_local` agent retrieved company memory autonomously. Verbatim run
output: *"Task ACM-13 (vision recall): Queried memory for 'vision' — Retrieved and
reported: 'Be the memory layer every founder trusts'."*

It took a **5-layer** fix — each layer masked the next:
1. **Registry/name** — agents use `createToolRegistry` → `query_memory`, not the
   MCP-server `memory.search` (commit `5264729b3`).
2. **Allowlist** — `query_memory` added to `ORG_HEARTBEAT_TOOL_ALLOWLIST` (`5264729b3`).
3. **Bridge activation** — confirmed working (`resolveRuntimeDecisionRoutingEnabled`
   true with `AOA_RUNTIME_DECISION_ROUTING=1` + agent opt-in); my earlier "not
   activating" reading was wrong.
4. **MCP tool permission** — the W5b PreToolUse hook matches only **built-in** tools
   (`PERMISSION_REQUIRING_TOOLS = Bash/Write/Edit/MultiEdit/NotebookEdit/WebFetch`), so
   MCP tools were never permitted. Pass `--allowedTools mcp__aoa` for claude_local
   runs — bounded by the bridge's allowlist-scoped exposure (commit `5f1dc75b9`).
5. **Identity visibility** — `canSeeDurableMemory` hid identity memory from anyone
   below team-lead, so an org agent (team_member) couldn't read the company vision.
   Made it actor-aware: agents get identity, humans unchanged (commit `3eb7635a9`).

**Prereqs for the sandbox:** `AOA_STRIP_CC_ENV=1` (CC-session auth scrub) +
`AOA_RUNTIME_DECISION_ROUTING=1` + the agent's `runtimeConfig.runtimeDecisionRoutingEnabled=true`.

## Remaining: Crew + Commander

- **Crew** renders scoped memory into the prompt `## Context` (no MCP tool call).
  Likely works, but its bundle (`crew-context-bundle.ts` → `loadScopedMemoryLines`)
  uses a different filter path — verify it surfaces identity to crew agents.
- **Commander** uses the same `query_memory` tool but a DIFFERENT spawn path
  (`cli-mode.ts`, not the claude_local adapter), so it likely still needs the
  `--allowedTools` equivalent there. `actorType="commander"` already sees identity via
  isFounder/isTeamLead, so the identity fix doesn't regress it.

---

## ✅ ALL THREE agent types PROVEN (2026-07-31)

- **ORG** — live run: an org `claude_local` agent called `query_memory` and reported
  "Be the memory layer every founder trusts". Required the 5-layer fix above.
- **COMMANDER** — live chat: asked "what is our company vision?", answered from the
  live memory record: "Be the memory layer every founder trusts". Works as-is —
  Commander bypasses tool permissions (`--dangerously-skip-permissions`, default on)
  and as founder already sees identity.
- **CREW** — live bundle check: called `loadScopedMemoryLines` + `memoryAccessConditions`
  + `actorForAgentRun` for the real crew agent against the running DB; the rendered
  `## Context` lines contained Company Vision/Mission/Values. Crew works as-is — its
  delivery is prompt-injection through my RBAC gate (identity visible to all actors),
  never touching the org path's MCP-permission/Commander-policy layers.

**Bottom line:** company memory now reaches Commander, Crew, AND Org agents. The org
path needed real fixes (registry name, allowlist, `--allowedTools` for MCP tools,
actor-aware identity visibility); crew + commander worked once the org fixes existed.
