# Commander Skills Overhaul — Scope Document

**Date:** 2026-07-10
**Status:** Scope **finalized** 2026-07-10. Next: implementation plan(s) → plan reviews → build.
**Owner:** TK
**Purpose:** Establish the source of truth across AoA's tool + skill surfaces, then scope the work
to turn Commander into an always-on operating copilot for every employee — grounded in what the
code actually is today, not what the docs claim.

Related repos:
- **AoA-Skills** — `github.com/MeteoriteLabs/AoA-Skills` (the distributable skill/context pack).
- **AoA product** — this repo (`server/src/services/internal-agent/*`, `server/src/mcp/*`,
  `server/src/onboarding-assets/commander/*`).

---

## 0. TL;DR

Commander already has a large capability surface (**75 registry tools**, ~all reachable in chat).
The skills that drive it teach a **34-tool, partly-wrong** picture — including a phantom tool
(`create_memory`) that **does not exist on any surface**, is referenced 16× across the skills repo,
is codified in the live product's Commander onboarding assets, and is *enforced* by an inverted
linter. So the first job is not "add capability" — it's **fix the contract and surface what's
already there**, then add the operating skills (triage, review, delegate, org-awareness) that make
Commander feel like a copilot instead of a planning wizard.

Most of the "Jarvis" experience ships with **little-to-no new product code**: it's better skills over
tools Commander already has. Only a handful of genuinely new tools (run history, approvals oversight,
trust scores, budget incidents) require real product work, and each is justified by a specific skill
that reaches for it — not guessed up front.

---

## 1. Source of truth (reconciled from code, 2026-07-10)

| Surface | Count | Notes |
|---|---|---|
| **Commander runtime registry** (`createToolRegistry()`) | **75** tools | 2 are `NOT_IMPLEMENTED` stubs (`create_workflow_template`, `instantiate_workflow`). |
| **Commander *chat* actually reaches** | **~75** | Chat spawns `agentKind: undefined` → the `agentKind==="aoa"` allowlist gate is skipped. Gated only by user role, enabled capabilities, and per-tool enable/disable (default enabled). The 37-tool `COMMANDER_TOOL_ALLOWLIST` applies only to the autonomous crew-lead path, **not chat**. |
| **MCP outbound** (external agent → AoA) | **36** tools + `use_skill` + **4** resources | `aoa://tasks`, `aoa://goals`, `aoa://memory`, `aoa://artifacts`. Families: Read 11 / Write 10 / Document 5 / Approval 10. |
| **AoA-Skills repo believes** | **34** | 33 real, **1 phantom** (`create_memory`), **41 real tools never mentioned**. |

**Tool-name divergence:** Commander tools are `snake_case`/dotted (`suggest_memory`, `thread.setIntent`);
MCP tools are `kebab`/dotted (`memory.write`, `suggest-memory`). **Only `use_skill` is spelled
identically on both surfaces.** A skill that hardcodes a Commander tool name is wrong on the MCP surface.

**The tool contract is hand-maintained in ≥7 places, all derivable from one registry:**
`tool-registry.ts` (code source of truth) · `mcp/tools/index.ts` `TOOL_DEFINITIONS` · crew allowlist
arrays · `onboarding-assets/commander/TOOLS.md` (+ per-crew TOOLS.md) · `CLAUDE.md` counts ·
`docs/api/mcp.md` · AoA-Skills `validate.ts`. The Commander tool count is stated **four different ways**
(75 / 37 / 35 / 31) across the repo.

---

## 2. Findings that shape the scope

### F1 — The `create_memory` phantom (CRITICAL, live)
`create_memory` exists on **no** surface. The real tools are `suggest_memory` (Commander) /
`memory.write` (MCP). Yet:
- AoA-Skills `validate.ts` puts `create_memory` in `VALID_TOOLS` and **bans the real `suggest_memory`**
  ("was never a real tool") → the linter reports false-green and would fail a correct fix.
- 16 phantom references across 9 skills-repo files; 3 overlays *teach the inversion as a rule*.
- **The live product Commander is affected**: `onboarding-assets/commander/TOOLS.md` + `AGENTS.md`
  list `create_memory` as callable. Commander loads these via `commander-context.ts`.
- SOUL.md's principle #7 is literally "No phantom tools" — while naming a phantom.

**Root cause:** hand-maintained tool lists with no generation from the registry, duplicated across
two repos. Fix must span both, and must remove the duplication.

### F2 — Naming divergence is a real fork (not a detail)
"Same skills everywhere" means two different things:
- **Axis 1 (consumer):** Commander vs org/crew agents. → Settled: **org agents are out of scope; R1 is Commander only.**
- **Axis 2 (surface):** same skill file run by Commander (`use_skill` + registry tools) vs by an
  external Claude/Codex over the MCP server (MCP tools). Because tool names differ, a Commander-authored
  skill does **not** "just work" over authenticated MCP today. **R1 decision (revised): skills are
  surface-agnostic — intent in prose + a generated per-surface tool cheat-sheet from `tools.json`.
  Rationale: AoA-Skills is open-source precisely so external users install it into their own Claude/Codex
  and drive AoA over the MCP surface (`memory.write`), so dual-surface is the *primary* use case, not a
  deferral. Hardcoding Commander names would break external install.**

### F3 — Delivery pipeline realities (gate the upgrades)
- **Multi-file skills (SKILL.md + references/ + scripts/) work end-to-end for org agents today** (the
  "deferred" docstring in `company-skills.ts` is stale) — but **break for Commander**: `use_skill`
  returns markdown only. → Progressive disclosure *for Commander* needs a small product change; **R1
  keeps Commander skills single-file** and defers this.
- **`triggerPhrases` dies in the marketplace pipeline** — catalog schema has no trigger field, installer
  never populates the column. The one rich field that survives is `description`. → **R1 routing
  improvement = richer descriptions (pure repo).** Structured triggers = product change (catalog +
  installer + surfacing), deferred.
- **A shared preamble** injects cleanly product-side in one function (`buildCompactSkillList`) — small
  change, applies to every skill, one authoritative place for persona/confirm-gate/memory-PENDING.

### F4 — Transfer verdicts (superpowers + gstack)
- **From superpowers — adopt the authoring *method*, skip the drill-sergeant *voice*.**
  Adopt: WHEN-only descriptions (their hardest-won lesson: a description that summarizes the workflow
  makes the model skip the body); progressive disclosure; TDD-for-skills (baseline-test that a skill
  changed behavior — AoA already persists the transcript substrate in `internal_agent_messages` /
  `internal_agent_runs`); rigid-vs-flexible + degrees-of-freedom labels; cross-skill references by
  name (never `@`-load). **Skip** for Commander: rationalization/red-flag/"YOU MUST/STOP" tables and
  mandatory-1%-invocation — they break SOUL.md's "one voice, no lecture." Keep only mild
  Authority/Commitment for genuine governance gates (budget hard-stop, approval-required).
- **From gstack — generate the tool contract from the registry.** The doc becomes a projection of the
  code; drift becomes a red CI check; `validate.ts` imports its allowlist from the registry instead of
  copying it. This is the structural fix for F1. Also adopt: tiered shared preamble, model-overlay
  `{{INHERIT}}` composition + subordination wrapper, a generated central routing registry.
  **Skip** (AoA already owns as product features): browser daemon, gbrain/learnings, git worktrees.

---

## 3. Decisions locked

1. **Consumer scope:** Commander only. Org/crew-agent execution skills are a separate, later effort.
2. **Surface scope:** Skills are **surface-agnostic** — prose describes *intent*; a generated
   per-surface tool cheat-sheet (from `tools.json`) resolves real names: Commander-flavored for the
   in-app build, MCP-flavored for the open-source distribution. Driven by AoA-Skills being public
   specifically so people install it into their own Claude/Codex and drive AoA over MCP. R1 authors +
   validates the Commander flavor; the MCP flavor is generated from the same source.
3. **Skill files:** single-file for R1; multi-file (progressive disclosure) added only when a skill
   needs it (requires the `use_skill` product change).
4. **Tool contract:** the product emits a machine-readable `tools.json` manifest from the real
   registry; the skills repo's generator + `validate.ts` consume it. One source of truth.
5. **Testing (R1):** lite — a skill-triggering eval (naive prompt → did the right skill fire?). Full
   behavioral eval (assert tool-sequence/budget/output vs transcript) is R2.
6. **Release boundary:** north-star capability map (design the whole surface) **+** a tight R1 slice.
7. **Voice:** adopt superpowers' authoring rigor; do **not** adopt its enforcement/lecture tone.

---

## 4. North-star capability map (the whole surface)

Commander = an always-on operating copilot for **any** employee (founder / team lead / team member,
RBAC-scoped). Not just planning — *operating*. Organized by conversation type. Tool coverage tiers:
**Have** = Commander already has the tool (just needs a skill); **B1** = existing tool, untaught;
**B2** = exists on MCP surface, port into Commander; **B3** = new tool to build.

> **Role:** keep the name **Commander** (no rename). Remit line for persona copy: *"your always-on
> operator — helps every employee plan, run, and review their AI team's work."*

### Thinking partner (critical, memory-grounded)
Idea conversations where Commander must be a *challenging* partner, not a sycophant, and pull context
from company memory before opining.
- Rough idea → interrogate → shape → plan. → **Have** (`query_company`, `query_memory`,
  `find_similar_memory`, `suggest_memory`, hands to spec/sprint). *Existing: brainstorm, office-hours —
  need hardening to be critical + memory-grounded.*
- "Should we do X?" decision review / devil's advocate. → **Have** (mostly) — **new skill**.

### My work (personal assistant)
- "What should I work on?" triage/prioritize (role-aware). → **B1** (`query_tasks`,
  `query_dependency_chain`, `analyze_workload`) — **new skill**.
- "Pull up this task, help me understand it, answer questions." → **Have** (`get_task`,
  `query_dependency_chain`, memory) — **new skill**.
- "Help me respond to / act on this." → advisory: **Have** (draft in chat, `post_task_comment`,
  `update_task`). Deeper execution = later.

### The organization (awareness)
- Status / what's blocked / how's a department doing. → **Have** reads + **B1**; **new skill**.
- "What did agent X's last run do / how'd it end / cost?" → **B3** (read `heartbeat_runs` /
  `heartbeat_run_events`). *Biggest single gap.*
- Agent performance / trust. → **B3** (read `agent_trust_scores`).
- Budget spiking — what caused it. → **B2/B3** (`query_budget` is summary-only; incidents/cost detail new).

### Take action (with confirm gates)
- Delegate / handoff: pick the right agent, write a good spec, set deps, hand off. → **Have**
  (`assign_task`, `create_task`, `add_task_dependency`, `wakeup_agent`) — **new skill** (the
  planning→execution bridge).
- Review agent output before approving. → artifacts **B1** (`query_artifacts`, `read_file`,
  `create_artifact_version`); workspace **diff** = **B3**. Feeds the trust-score system. — **new skill**.
- Clear approvals / triage the hub. → **B2** (Approval family + heartbeat-context exist on MCP, port
  to Commander) + **B3** (unified `hubItems`) — **new skill**.

### Setup & governance (occasional)
- Company identity, team design. → **Have** (`update_company_identity`, `create_agent`,
  `create_department`). *Existing: identity-setup, team-design.*
- Agent readiness (install/auth/test). → product initiative already queued; can be skill-driven.
- Memory curation (review pending, spot stale/conflicting). → **Have** (`query_memory`,
  `detect_conflicts`, `archive_stale_memory`, `update_memory`) — **new skill**.

**Observation:** all 8 existing skills are "beginning-of-journey" (set up, plan). The whole
**operate + review + report** middle is missing — that's what turns a planning wizard into a copilot.

---

## 5. Workstreams

Repo tags: **[S]** AoA-Skills repo · **[P]** AoA product · **[S+P]** both.

### WS-0 — Fix the contract (foundational, urgent)
- Fix every `create_memory` → `suggest_memory` (skills repo **and** `onboarding-assets/commander/*`). **[S+P]**
- De-invert `validate.ts`; regenerate its allowlist from `tools.json`. **[S]**
- Product emits `tools.json` from the registry (Commander names now; MCP names + mapping fields
  reserved). **[P]**
- Skills-repo generator: `tools.json` → `TOOLS.md` + validate allowlist; CI freshness gate
  (`--dry-run` + `git diff --exit-code`). **[S]**
- De-duplicate the Commander instruction files across the two repos (pick one source; generate/sync the
  other). **[S+P]**
- **Effort:** M. **Fixes a live bug; must land first.**

### WS-1 — Authoring substrate
- Rewrite all skill `description`s to WHEN-only + embed routing/disambiguation prose (survives the
  marketplace pipeline). **[S]**
- Shared Commander preamble injected in `buildCompactSkillList` / `use_skill` return (persona +
  confirm-gate + memory-PENDING + routing, one place). **[P]**
- Rigid/flexible + degrees-of-freedom labels; cross-skill reference convention. **[S]**
- Lite skill-triggering eval harness (naive prompt → assert the right skill key routed, read from
  the classifier-proxy output or the in-process `use_skill` `tool_call` chunk `input.key` / `Loaded
  skill: <name>` result summary — NOT the persisted `internal_agent_messages.toolCalls`, which stores
  only the tool name, not the skill key). **[P]**
- **Effort:** M.

### WS-2 — Commander skill expansion (R1 slice + map)
- Build the operating skills from §4. **R1 recommended set (4):**
  1. **Daily triage / org-awareness** — "what needs me?" role-aware. (B1)
  2. **Review agent output** — walk diff/artifact vs acceptance criteria → approve/revise. (B1 + later B3 diff)
  3. **Delegate / handoff** — the planning→execution bridge. (Have)
  4. **Harden thinking-partner** — make brainstorm/office-hours critical + memory-grounded. (Have)
- Each new skill surfaces exactly which B1/B2/B3 tools it needs → feeds WS-3.
- **Effort:** L.

### WS-3 — Capability / tool expansion
- **B1** (free): teach the 41 untaught existing tools — folds into WS-2 skill authoring. **[S]**
- **B2** (port): bring MCP-only tools into Commander's registry — Approval family
  (`list-approvals`/`approval-decision`/…), `get-heartbeat-context`, Document family. **[P]**
- **B3** (build): new read tools — run history (`heartbeat_runs`), runtime-approval oversight
  (`internal_agent_runtime_approvals`), trust scores (`agent_trust_scores`), budget incidents /
  cost-event detail, workspace-diff read, unified hub (`hubItems`). **[P]** — **R2** for most; only the
  ones an R1 skill hard-needs come into R1.
- **Effort:** M–L.

**Sequencing:** WS-0 → WS-1 → (WS-2 pulls WS-3). WS-0 ships almost immediately.

---

## 6. Release one (proposed boundary)

Ships: **WS-0** (contract fix + generation) · **WS-1** (authoring substrate + lite eval) · **WS-2**
(the 4 skills above) · **WS-3 B1/B2** (surface existing tools + port the Approval/heartbeat-context
tools the review/triage skills need). **B3 new tools → R2**, except any single tool an R1 skill can't
function without (candidate: run-history read for the review/org-awareness skills — decide in planning).

Outcome: the `create_memory` bug is gone and structurally can't recur; Commander teaches its real
capabilities; and an employee can, in one conversation, be triaged, review an agent's output, and hand
work off — the copilot loop, not just the planning wizard.

---

## 7. Resolved (were open items)

1. **Role name** — keep **Commander** (no rename). Remit = *"your always-on operator — helps every
   employee plan, run, and review their AI team's work."*
2. **R1 skill set** — confirmed 4: **daily-triage/org-awareness · review-agent-output ·
   delegate-handoff · harden-thinking-partner.**
3. **B3 in R1** — keep R1 to **at most one** new tool. Build run-history (`heartbeat_runs` read) only if
   review-agent-output can't work from artifacts alone; decide when that skill is specced. Default: defer.
4. **`tools.json` shape** — `{ name, surface (commander|mcp), category, readWrite, requiredRole,
   description, mcpAlias }`. `surface`/`mcpAlias` power the per-surface cheat-sheet generation.
5. **Instruction-file source of truth** — the product's `onboarding-assets/commander/*` is canonical
   (what the live Commander loads); the AoA-Skills repo's `commander/*` is generated/synced from it at
   publish. Same philosophy as generating the tool contract.

Remaining detail for planning: exact field-by-field `tools.json` schema; whether run-history lands in R1.

---

## 8. Appendix — investigation basis

Five parallel code investigations (2026-07-10) plus direct verification produced this doc:
canonical tool source-of-truth (Commander 75 / MCP 36+4, verified) · AoA-Skills quality audit
(16 phantom refs, inverted linter, ~4.5/10) · superpowers mechanism-transfer · gstack
mechanism-transfer (generate-from-registry) · skill delivery/routing pipeline (multi-file works for
org agents / breaks for Commander; triggerPhrases dies in marketplace). Contradiction on Commander
chat's tool count resolved directly from `authorize-tool.ts` + `internal-agent.ts:434-449`.
