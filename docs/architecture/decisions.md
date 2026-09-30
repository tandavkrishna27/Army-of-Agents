# AoA — Locked Decisions

Decisions made during product design and development. Do not relitigate unless explicitly reopened.

**Numbering systems:**
- `#N` — Core product decisions and later amendments
- `DA-N` — Discussions & Internal Agent specific decisions

> **Version note:** Older decision entries used V-number labels for planning phases. AoA's current product line is version 1; this log now describes those entries by feature area where possible.

---

## Naming

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Issue → Task (UI only, DB stays `issues`) | "Issue" implies problems. "Task" is universal. Avoids massive DB migration. |
| 2 | Dashboard → Home | Home is a starting point, not a data dashboard. |
| 3 | Costs → Budget | Budget implies planning + control, not just tracking. |
| 4 | Actor/Org → Team | Team naturally covers humans + agents. |
| 5 | Review Pack → Brief | Brief is a structured review object. Clean, professional. **[Updated: Brief replaced by inline Discussion review — see DA-3, DA-9]** |
| 6 | (new) Debrief | The action of capturing content. Pairs with Brief. **[Updated: Debrief replaced by Discussions — see DA-3]** |
| 7 | (new) Memory | Company knowledge store. More intuitive than "Knowledge Base." |
| 8 | Goals stays Goals | No rename needed. Well understood. |
| 9 | Projects stays Projects | Tried renaming, decided to keep alongside Departments. |
| 10 | Agents stays Agents | Clear and accurate. |

---

## Architecture

| # | Decision | Rationale |
|---|----------|-----------|
| 11 | Departments + Projects coexist (same table, type field) | Departments are permanent orgs, Projects are temporary. Same mechanics, different lifespan. |
| 12 | Vision & Mission are company-level text fields | Not goals, not memory items. Strategic anchors stored on companies table. |
| 13 | Goals must belong to at least one department or project via `project_goals` join table | No floating company-level goals. Use existing many-to-many join table, NOT a new projectId column on goals. A goal CAN span multiple departments/projects. |
| 14 | MCP inbound with authenticated write permission may create tasks directly; `debrief-push` remains for unstructured content | RBAC + per-user keys provide the quality gate that originally lived in the Discussion pipeline. **[Revised 2026-04-21 — see "Decision #14 (revised 2026-04-21)" entry below for full wording. Original wording: "Debrief pipeline" → "Discussion pipeline." See DA-3.]** |
| 15 | Memory is approval-gated | Founder is sole gatekeeper. Agents suggest, founder approves. **[Extended: see #52 for team lead extension]** |
| 16 | Agents have read-only Memory access | Receive context at execution time, cannot write directly. |
| 17 | Tasks don't care who does them | Same task model for humans and agents. Experience adapts. |
| 18 | Agents can only self-transition: todo → in_progress → in_review | Only humans mark done/cancelled. Deliberate control point. |
| 18A | Decision #18 is superseded by Decision #109 (2026-07-11) | Review-required remains the safe default; explicitly governed tasks may allow agent completion under policy, autonomy, and structured acceptance criteria. |
| 19 | Drizzle only, no raw SQL | Matches Paperclip patterns. `pnpm db:generate` for all schema DDL. Narrow C14 exception: idempotency guards + data-only backfills may be hand-appended post-generation (e.g. 0189/0195), always idempotent. **Extended by Decision #122** (and its 2026-09-01 amendment) to idempotent cluster/security DDL — roles, GRANT/REVOKE, RLS, policies, and `SECURITY DEFINER` functions plus their ACLs — in delta-free `--custom` migrations. Tables, columns, indexes and foreign keys are never hand-authored. |
| 20 | ~~Sub-goals limited to one level deep~~ **(SUPERSEDED 2026-05-25)** | Superseded by the multi-parent goals model — goals form a freely-nested, multi-parent DAG; integrity (cycles + child⊆parent scope) enforced on write. See `docs/superpowers/plans/2026-05-25-threads-goals-followup.md` B0. |
| 21 | Task dependencies use a separate `task_dependencies` table, not parentId | parentId = subtasks (hierarchy). Dependencies = blocking relationships (different concept). Separate table, separate logic. |
| 22 | Cancelled dependency notifies but does NOT auto-cancel dependents | Too aggressive. Founder decides what to do with orphaned tasks. |
| 23 | All dependencies must be met before a task can be worked on | AND logic, not OR. If Task C depends on A and B, both A and B must be done. |
| 24 | Dependencies auto-unblock to `todo` status and wake the assigned agent | When all dependencies are met, the system moves the task to `todo` and fires heartbeat.wakeup() if an agent is assigned. Minimal friction. |

---

## UX

| # | Decision | Rationale |
|---|----------|-----------|
| 25 | Sidebar is flat, not deeply nested | Depth lives in detail pages. Sidebar stays scannable. |
| 26 | Goals not in sidebar — inside department/project detail pages | Goals belong to their parent context, not global nav. |
| 27 | Home screen is action-first, not information-first | Founder opens AoA to DO things, not LOOK at things. |
| 28 | ~~Home screen IS the onboarding~~ **(SUPERSEDED 2026-07-18)** | The shipped model uses a resumable, route-driven onboarding flow at `/onboarding`; Home/Lobby entry points route into it. See the onboarding supersession note below. |
| 29 | Debrief has paste/write first, voice later | Voice recording adds complexity. Start with text input. **[Updated: Voice shipped via Whisper API]** |
| 30 | Brief pipeline: artifact-first | All content stored as raw artifact before extraction. Original never lost. |
| 31 | Department goals show activity metrics, not progress bars | Ongoing departments don't "progress" — they operate. |
| 32 | Project goals show progress bars | Projects have endpoints and measurable completion. |
| 33 | Suggestion engine starts with goal-gap nudges only | Full suggestion engine deferred. Keep the first release simple. |
| 34 | ~~Initial release is solo founder only (single user, no RBAC enforcement)~~ **(SUPERSEDED 2026-07-18)** | Multi-user Google identity, company membership, founder/lead/member RBAC, invitations, and approval-gated joining have shipped. See the onboarding supersession note below. |
| 35 | Tasks and memory items CAN exist without a department/project | Not everything fits a department (e.g., legal, personal, strategic). Unscoped items live in global views. Founder assigns a department later if one gets created. |
| 36 | LLM extraction prompt includes available departments for auto-suggestion | The extraction prompt is dynamically built with the company's department/project list. LLM suggests placement per item but sets null if no clear fit. Founder confirms during Brief review. |

---

## Scope

| # | Decision | Rationale |
|---|----------|-----------|
| 37 | Initial release excludes: voice debrief, suggestion engine, templates, ~~multi-user~~, autonomy tiers, automated workflows, analytics page, mobile | Multi-user onboarding and Team RBAC shipped in July 2026 and supersede that portion of the scope lock. The other exclusions remain historical scope context unless separately superseded. |
| 38 | Department templates are deferred | Need real usage data to make good templates. |
| 39 | LLM preferences per task type are deferred | Founder starts with one preferred LLM globally. |
| 57 | Deferred intelligence/team/artifact scope excludes: autonomy tiers, automated workflows, department blueprints, service connectors, hosted deployment, external publishing, meeting integration, mobile, multi-company, experiment system, cross-agent memory propagation | Focuses on intelligence + team + artifacts. Autonomy, integration, and scale are later. |
| 58 | Later scale scope: 5 pillars — Autonomy (tiers, confidence, cross-agent learning), Workflows (pipeline templates, conversation-to-delivery), Connectors (GitHub/Figma/Linear/Slack bidirectional sync), Blueprints (department/project templates + ClipHub), Hosted (API adapters, cloud workspaces, BYOK/bundled). Plus: meeting integration, mobile, multi-company, analytics, experiment system | Full autonomy and scale. Founder shifts from operator to strategist. |

---

## Onboarding And Multi-User Supersession (2026-07-18)

**Status:** Shipped. This note supersedes Decisions #28 and #34 and only the
`multi-user` exclusion in Decision #37.

1. **Onboarding is a resumable route, not a Home empty state or modal.** New
   founders enter `/onboarding`. Progress is durable, forward-only, and split
   between the user layer and the organization layer, so interrupted setup
   resumes without duplicating the organization. The shipped founder sequence
   covers Human Operating Profile, organization, writable environment,
   Commander selection and verification, first department, first assigned
   agent, and review.

2. **Human identity is Google-only outside the loopback trust boundary.**
   Better Auth provides session cookies; email/password auth is removed.
   Authenticated deployments fail startup without Google credentials. The
   first Google user on an empty instance becomes the instance administrator.
   A loopback-only `local_trusted` quickstart may instead use the explicit local
   development identity.

3. **Multi-user Team governance is current behavior.** Humans have active
   company memberships and `founder`, `team_lead`, or `team_member` roles.
   Email-targeted invitations carry role/scope defaults. A verified-email match
   may auto-admit an ordinary member or lead, while mismatches and privileged
   authority remain pending for founder approval. Tokenless verified-email
   discovery requires explicit consent before the invite is claimed.

4. **The current invited journey ends at membership.** It collects the Human
   Operating Profile, files or claims the join request, and reaches
   `SETUP_COMPLETE` after admission. Reserved walkthrough/discussion/scope
   states are not shipped onboarding behavior.

**Key references:** `packages/shared/src/onboarding.ts`,
`server/src/routes/onboarding.ts`,
`server/src/routes/onboarding-journey.ts`,
`server/src/routes/onboarding-environment.ts`,
`server/src/routes/onboarding-join.ts`,
`server/src/routes/user-profiles.ts`,
`server/src/auth/better-auth.ts`, `ui/src/onboarding/`,
`tests/e2e/onboarding-founder-happy-path.spec.ts`,
`tests/e2e/onboarding-invited.spec.ts`, and
`tests/e2e/onboarding-resume.spec.ts`.

---

## Intelligence, Memory, And Artifact Architecture

| # | Decision | Rationale |
|---|----------|-----------|
| 40 | Memory has 4 layers: identity, domain, active_context, working | Different lifespans and scoping rules. Identity = always included. Domain = department-scoped. Active context = goal/project-scoped with expiry. Working = task-chain-scoped, ephemeral. |
| 41 | Semantic memory retrieval via pgvector, not separate vector DB | Keeps infrastructure simple. PostgreSQL extension. 1536-dimension embeddings. |
| 42 | Artifacts are separate from assets | Assets = raw files (immutable). Artifacts = versioned deliverables with metadata, status, and lineage. Artifact versions point to assets. |
| 43 | Artifact versions are immutable | Like assets — once created, never modified. Changes = new version. Full history preserved. |
| 44 | Artifact versioning is source-agnostic | Versions can come from agents, founder, team members, MCP pushes, or external uploads. AoA is the system of record, not the workshop. |
| 45 | Version branching: founder picks winner, no auto-merge | Simple conflict resolution. No git-level merge complexity. Founder decides which version becomes canonical. |
| 46 | Feedback patterns require ≥3 occurrences before suggesting memory | Prevents noise from one-off edits. Pattern must be consistent before becoming a suggestion. |
| 47 | Trust score = approval rate, weighted by recency | Simple, transparent, explainable. Not a complex AI model. Last 20 tasks count more than first 20. |
| 48 | RBAC is additive from restrictive defaults | Start locked down, founder grants permissions. Three roles: founder, team_lead, team_member. Department-scoped access. |
| 49 | AoA as MCP server: expose read-only resources + limited write tools | External agents can query Tasks, Memory, Goals, Artifacts. Write access limited to Discussion push, memory suggestions, task status updates. |
| 50 | Working memory auto-expires after 7 days | Prevents context bloat. Ephemeral by design. Founder can promote to domain layer if needed. |
| 51 | Suggestion engine runs on-demand (Home load) + periodic (every 4 hours) | Real-time suggestions when founder looks, background pattern detection in between. Not a streaming system. |
| 52 | Memory approval gate extends to team leads (extends #15) | Founder remains sole gatekeeper for identity + domain layers (per #15). Team leads can additionally approve active_context items for their departments. Working memory is auto-created (no approval needed). |

---

## Intelligence, Memory, And Artifact UX

| # | Decision | Rationale |
|---|----------|-----------|
| 53 | Task detail page gets "Open in [LLM]" button with context packaging | Assembles company identity + goal + task + memory into a structured prompt. Copies to clipboard or deep-links to preferred LLM. |
| 54 | Artifact version timeline is visual, not a flat list | Timeline view showing who created each version, source (agent/founder/MCP), and status transitions. Makes lineage intuitive. |
| 55 | Agent trust score displayed on agent cards and detail pages | Transparency. Founder sees trust trajectory. Builds confidence in delegation. |
| 56 | Suggestions show evidence, not just recommendations | Each suggestion explains WHY it's being made (goal at risk because X, pattern detected from Y). Founder makes informed decisions. |

---

## Audit Additions (March 2026)

| # | Decision | Rationale |
|---|----------|-----------|
| 59 | Issues table gets `dueDate` field (nullable timestamp) | Referenced in Home screen ("tasks due today") and PRD but was missing from V1 schema. Needed for risk detection and sorting. |
| 60 | Goal status machine: planned → active → at_risk → achieved/cancelled, with at_risk → active recovery | Standardized across all docs. "planned" not "draft". "achieved" not "completed". Recovery from at_risk allowed. |
| 61 | Discussion scope fallback: item-level > entry-level > discussion-level > null | Clear resolution order when creating tasks from discussion approval. Founder's per-item override always wins. **[Updated: was "brief-level" → "entry-level" and "discussion-level" to match Discussions model]** |
| 62 | Task can be blocked from any non-terminal status (backlog, todo, in_progress) | Dependencies can be added to tasks in any state. When unblocked, returns to previous status, not auto-promoted. |
| 63 | Department deletion blocked if it has tasks or goals | Must reassign or cancel tasks/goals first. Memory items become unscoped (departmentId → null). Prevents orphaned work. |
| 64 | Extraction failure: entry marked 'processing_failed', founder notified | Graceful degradation. Founder can retry or manually create work. Empty extraction creates empty extracted items (allowed). **[Updated: was "debrief" → "entry"]** |
| 65 | Memory expiration: auto-archive (not delete), preserved in history | Working memory archived after 7 days. Active context archived when goal completes or expiresAt passes. "Show Archived" view available. |
| 66 | Global search (cmd+K) includes tasks, memory, artifacts, goals | PostgreSQL full-text search. RBAC-scoped. Results grouped by entity type. |

---

## Artifact And Search Additions (March 2026)

| # | Decision | Rationale |
|---|----------|-----------|
| 67 | Agent output captured via 3-step pipeline: workspace diff → adapter hinting → founder confirmation | Bridges the gap between workspace (where agents work) and storage (where files are kept). Workspace untouched — files copied, not moved. |
| 68 | Artifacts can be referenced by multiple tasks (multi-task linkage) | A spec artifact is produced by task 1 but consumed by tasks 3, 4, 5. sourceIssueId tracks creator; issues.artifactId on other tasks indicates consumption. |
| 69 | Review state supports extended refinement, not just approve/reject | Founder can add artifact versions while task is in_review. Downstream tasks stay blocked until approval. Review is a workspace, not just a gate. |
| 70 | Adding artifact versions must be frictionless: drag-and-drop, paste content, MCP push | If it takes >2 clicks to push external work back to AoA, founder won't do it. AoA loses refinement history. |
| 71 | Dependency task artifacts auto-included in downstream task context | When task depends on completed tasks, those tasks' artifacts are automatically part of the agent's context package. Enables artifact-driven pipelines. |
| 72 | Department templates moved later (as "Blueprints") | Needs more design work and real usage data. ClipHub integration makes blueprints more powerful. |
| 73 | Discussion is the universal intake for all content entering AoA | Meetings, conversations, voice notes, agent output, and external LLM work all enter through Discussions (or as artifact versions for existing artifacts). Decision #14 reinforced. **[Updated: was "Debrief" → "Discussion"]** |

---

## Later Architecture

| # | Decision | Rationale |
|---|----------|-----------|
| 74 | Autonomy tiers are per-agent, not global | One agent can be Level 3 while another is Level 0. Granular control per agent's proven reliability. |
| 75 | Level 3 autonomy never auto-recommended; founder must explicitly opt in | Safety guardrail. Trust score can recommend Level 0→1→2, but full autonomy is a conscious founder decision. |
| 76 | Pipeline templates are data (JSON manifests), not executable code | Stored as configuration. Instantiation creates real tasks with real dependencies. No workflow engine complexity. |
| 77 | Connectors are department-scoped, not company-wide | Engineering connects to GitHub, Marketing to HubSpot. Keeps integrations focused and avoids cross-department data leakage. |
| 78 | AoA is control plane, external tools are execution plane | AoA owns WHY (goals, priorities, memory, agents). External tools own HOW (PRs, designs, CI). Neither replaces the other. |
| 79 | Blueprints work offline without ClipHub | Built-in blueprints ship with AoA. ClipHub is an enhancement for community sharing, not a dependency. |
| 80 | Hosted mode changes only adapter and storage layers | Heartbeat, tasks, artifacts, memory, RBAC — all unchanged. Same upper layers, different execution layer. |
| 81 | BYOK is the default hosted tier, bundled is premium | Respects user's existing LLM investments. Non-technical founders can opt for bundled convenience. |
| 82 | Meeting integration routes through Discussion pipeline | Decision #14 preserved for meeting transcripts. No special intake path — meetings are just another discussion source. |

---

## Implementation Fixes (March 2026)

| # | Decision | Rationale |
|---|----------|-----------|
| 83 | Windows path fix: use `fileURLToPath()` instead of `new URL().pathname` in db client | `new URL(..., import.meta.url).pathname` produces double drive letters on Windows (e.g., `/C:/C:/...`). Node's `fileURLToPath` handles cross-platform path resolution correctly. |
| 84 | Activity log "issue" → "task" replacement uses display-layer mapping, not DB changes | ACTION_VERBS/ACTION_LABELS maps in UI components translate `issue.*` entity types to "task" text. `entityType` stays `issue` in DB — renaming would break existing activity rows. Fallback regex replaces `\bissue\b` with "task" for unmapped actions. |
| 85 | Sidebar route roots must be registered for company prefix routing | `BOARD_ROUTE_ROOTS` set in `company-routes.ts` controls which paths get the company slug prefix (e.g., `/briefs` → `/SEAA/briefs`). Missing entries cause bare paths that 404. All first-release sidebar pages registered. |
| 86 | Goal status transitions are validated server-side | Allowed transitions enforced in `goals.update()` with a defined map (e.g., `planned → active`, `active → at_risk → active`). Invalid transitions return 400. Prevents inconsistent state from UI bugs or API misuse. |

---

## Discussion And Commander Additions (March-April 2026)

| # | Decision | Rationale |
|---|----------|-----------|
| 87 | Per-agent context mode: minimal / standard / full | Three levels control how much context each agent receives. Stored in `runtimeConfig.contextMode`. Default: `standard`. Prevents token waste for simple adapters. |
| 88 | Run summary comments auto-generated after each heartbeat run | Auto-generated task comments show duration, token usage, cost, outcome, and detected files. Uses existing `issue_comments` table. Opt-out via `runtimeConfig.autoRunSummary`. Files truncated to 10 shown + "+N more". |
| 89 | _(not documented — referenced by count only)_ | — |
| 90 | _(not documented — referenced by count only)_ | — |
| 91 | AoA drops API adapters (`claude_api`, `openai_api`, `gemini_api`) in favor of CLI-only agent execution | Single-turn API adapters duplicated the multi-turn loop logic CLI adapters already handle correctly. Commander migrates to CLI default (`claude_cli` / `codex` / `opencode`) — no per-company LLM API key required. Data migration (heuristic D): `UPDATE internal_agent_config SET execution_mode='cli', cli_tool=COALESCE(cli_tool, 'claude_cli') WHERE execution_mode='api'`. `internal_agent_config.provider`/`.model` columns stay dormant for rollback safety. `server/src/services/internal-agent/providers/` is preserved as an internal SDK util for extraction + embeddings until the team-under-Commander architecture replaces it. Hosted deployment revised to CLI-in-container. Per-turn run tracking / cost / token accounting / tool confirmations are deferred to the same future sprint. Sprint 2A (2026-04-24). Deferred follow-ups: (a) rehome non-API-mode tests into domain-matching files; (b) add a behavioral agent-loop shell test to complement the import-level static guard; (c) delete or finish the orphaned `/internal-agent/confirm` stub route. |

---

## Discussions & Internal Agent Decisions (DA series)

These decisions are specific to the Discussions pipeline and Internal Agent features.

---

### DA-1: Product Positioning

**Decision: Hybrid Workforce OS (not AI Agent Manager)**

AoA is where a solo founder runs their company — with AI agents doing most of the work and humans filling the gaps. Positions against "Linear + Notion + AI tools duct-taped together," not against Claude Code or Cursor directly.

**Consequences:** All UX decisions prioritize the "company operating system" feel. Discussions become the primary input channel. The internal agent is the system's intelligence, not a chatbot feature.

---

### DA-2: Three-Tier Agent Architecture

**Decision: Master orchestrator → department lead personas → worker agents**

```
Internal Agent (one entity, department-scoped personas)
  ├── Engineering context
  ├── Marketing context
  └── [other departments]
      ↓
Worker Agents (user-created, adapter-based)
```

**Consequences:** Internal agent does NOT appear in the Agents page alongside worker agents. Department lead "personas" are not separate agents — they are the internal agent with department-scoped context.

---

### DA-3: Discussions Replace Debrief + Brief

**Decision: Discussions replace both Debrief and Brief**

Discussions are threaded records of real conversations (transcribed meetings, LLM sessions via MCP, voice recordings). Each entry in a thread is processed in context of the full thread. Brief as a separate staging area is redundant when review happens inline within the Discussion.

**What goes away:** `debriefs` table (deprecated), `briefs` table (deprecated), `brief_items` table (replaced by `discussion_extracted_items`), BriefReview page, Briefs sidebar item.

**Consequences:** Decision #14 updated — MCP routes through Discussion pipeline. Each existing debrief migrated to a single-entry Discussion.

---

### DA-4: Internal Agent Surface — Right Collapsible Panel

**Decision: Right collapsible panel (primary) + expandable for deep sessions**

Right panel is the daily driver — always available, context-aware of current page. Panel can expand wider for longer sessions.

**Consequences:** New global component in Layout.tsx. Panel is collapsible (closed by default). Panel is context-aware of current page. Mobile: panel overlays as a sheet/drawer from right.

---

### DA-5: Internal Agent Execution — Dual Mode (API + CLI)

**⚠️ Superseded by Decision #91 (Sprint 2A, 2026-04-24)**

Original decision: API-based agent loop as default; CLI-based via MCP as optional power-user mode. That decision shipped API mode only and deferred CLI mode.

**What changed:** Decision #91 removed API-mode execution entirely. Every turn now routes through `cliModeService` regardless of the legacy `executionMode` column (kept dormant for rollback safety). The `executionMode` column on `internal_agent_config` is no longer read by the dispatch path. See `server/src/services/internal-agent/agent-loop.ts` for the code comment.

---

### DA-6: Internal Agent Permissions — Logged-In User's Role

**Decision: Internal agent inherits the logged-in user's RBAC permissions**

Solo founder → agent has founder permissions. Team lead → agent has team lead permissions. No new RBAC role.

---

### DA-7: Discussion Entry Sources — Four Input Types

**Decision: paste, write, voice, MCP**

Same 4 input types as the old Debrief, with voice added. Transcription tool integrations (Otter, Fireflies, Recall.ai) and live recording deferred.

---

### DA-8: Discussion Threading Model

**Decision: Flexible threading with manual and agent-assisted connection**

Any entry can be standalone (new thread) or part of an existing thread. At creation time, user chooses "New Discussion" or "Add to existing." Entries can be attached/moved between threads. Agent can suggest connections.

---

### DA-9: Inline Review (No Separate Brief Page)

**Decision: Review happens inline within Discussion thread + Inbox notifications**

Extracted items appear below each Discussion entry. "Confirm All" for fast path. Inbox gets a notification for pending review items. BriefReview page removed.

---

### DA-10: Sidebar Navigation Structure

**Decision: Discussions replaces Briefs, ordered first under WORK**

```
Home | Inbox
WORK: Discussions → Tasks → Agents → Goals
DEPARTMENTS: [dynamic]
PROJECTS: [dynamic]
COMPANY: Vision & Mission, Memory, Team
Settings
```

---

### DA-11: Discussions Tab on Project/Department Pages

**Decision: Add Discussions tab to ProjectDetail**

ProjectDetail gets a "Discussions" tab alongside Overview, Issues, Goals, Team, Budget. Shows discussions scoped to that project/department. "New Discussion" action pre-scoped.

---

### DA-12: Internal Agent Conversation Persistence

**Decision: Persistent forever with summarization**

All messages stored permanently. One primary conversation thread per user. Older conversations summarized for token management. User can manually reset but old context remains retrievable.

---

### DA-13: Internal Agent Capabilities (12 capabilities)

Discussion processing, proactive suggestions, organizational queries, system actions, context briefing, memory management, conflict detection, budget awareness, workflow coaching, workflow discovery/SOP creation, cross-department coordination, department lead personas.

**Deferred:** Onboarding conversation, full autonomy tiers. Current behavior starts at Level 0 — always ask.

---

### DA-14: Core Tool Set — 30 Tools

Discussion (3) + Query (6) + Action (8) + Memory (5) + Workflow (3) + File (2) + Coordination (1) + Analysis (2) = 30 tools. 14 tools deferred to V3. Same tool registry backs both API mode and MCP/CLI mode.

---

### DA-15: Annotations on Discussion Entries

**Decision: Annotations supported, NOT extracted — they are metadata**

Founder can annotate any point in a discussion entry. Annotations are context for the internal agent, not items to extract. Agent sees annotations when processing subsequent entries.

---

### DA-16: Data Migration Strategy

**Decision: Migrate existing debriefs → Discussions (no dual systems)**

Each existing debrief becomes a single-entry Discussion. Brief items attach as extracted items. Old URLs redirect. Old debrief/brief code replaced, not maintained alongside.

---

### DA-17: Discussion Entry Processing — Internal Agent Handles Extraction

**Decision: Internal agent handles extraction (not a separate pipeline)**

Extraction needs thread context + system state awareness — exactly what the internal agent provides. `extraction.ts` refactored from one-shot LLM call into a tool the internal agent invokes (`extract_from_content`). Auto-processing on entry arrival.

---

### DA-18: Internal Agent Settings

**Decision: Settings section with execution mode, provider/model, autonomy level (Level 0 only), enabled capabilities, notification preferences**

Settings persisted per company, not per user.

---

### DA-19: Quick Capture Modal (evolved from DebriefModal)

**Decision: Lightweight modal — paste, write, voice, plus "Add to existing Discussion" option**

Default: creates new standalone Discussion. Processing happens async (no blocking spinner). Notification in Inbox when extraction is ready. Accessible from Home, Cmd+K, keyboard shortcut.

---

### DA-20: Workflow/SOP System — Lightweight Templates

**Decision: Internal agent interviews founder to discover processes, creates reusable workflow templates**

Templates are stored as ordered task chains with dependencies. Instantiation creates real tasks. Connection to later `pipeline_templates` work is preserved; the current product ships a lighter version that may be pulled forward.

---

### DA-21: Internal Agent Panel Toggle — BreadcrumbBar + Keyboard Shortcut

**Decision: Icon button in BreadcrumbBar (top right) + keyboard shortcut (Cmd+J)**

Panel remembers open/closed state per session.

---

### DA-22: Content Pasted in Agent Panel → Routed to Discussion

**Decision: Agent detects pasted content, routes to Discussions — agent panel is never the permanent home**

Flow: detect content → search for related discussions → offer to add to existing or create new → content lives in Discussions (searchable, threaded, linked).

---

### DA-23: Agent Panel on Mobile — Full-Screen Sheet, Mutually Exclusive

**Decision: Full-screen sheet on mobile, mutually exclusive with task slide-over**

One primary overlay at a time. Modals can overlay on top of the agent panel.

---

### DA-24: Internal Agent Token Budget — Configurable with Smart Allocation

**Decision: Configurable token budget (default 8,000 tokens for context assembly)**

Allocation: identity (~500) + department memory (~1,500) + conversation history (~4,000) + page context (~1,000) + tool results reserve (~1,000). Summarization kicks in when history exceeds threshold. Settings UI: compact/standard/large.

---

### DA-25: Internal Agent Cost Attribution — Separate Budget Line

**Decision: Internal agent has its own `budgetMonthlyCents` and `spentMonthlyCents`**

Stored in `internal_agent_config` (not in agents table). Every API call logs a `cost_event` with `source: 'internal_agent'`. Same 80% warning / 100% pause logic as worker agents. Agent pauses and shows message in panel if over budget.

---

### DA-26: Mobile Bottom Nav — Agent Replaces Create Button

**Decision: Center position → AoA (internal agent toggle), not Create (+)**

```
Home | Tasks | AoA | Agents | Inbox
```

Creation accessible via agent panel, Cmd+K, Home page.

---

### DA-27: Internal Agent Run Tracking — Dedicated `internal_agent_runs` Table

**Decision: Separate run tracking system from worker agent `heartbeat_runs`**

New table: `internal_agent_runs` with triggerType (conversation / proactive / event / sub_agent), triggerSource (extensible text), toolsCalled, tokenUsage, costCents, durationMs, relatedEntityType/Id.

**Why separate from worker heartbeat:** Different execution model (conversational + event-driven vs. task-based), no queue, no atomic checkout, no adapter abstraction, no wakeup/assignment lifecycle.

**Background processing:** Event triggers fire even when founder is not in app. Results queued as Inbox notifications. Greeting on next login: "I processed 2 new discussions while you were away."

---

## Decision #14 (revised 2026-04-21)

**Status:** Revised. Original locked version superseded.

**Rule:** MCP inbound with authenticated per-user write permission may create tasks, update tasks, and add comments directly. `debrief-push` remains the alternative tool for unstructured content that should pass through AoA's extraction pipeline (meeting notes, emails, paste-dumps). Anonymous / unauthenticated MCP input (if ever exposed) still routes through Discussion pipeline.

**Reasoning:** The original Decision #14 was locked before AoA had per-user MCP keys with RBAC. Discussion-extraction served as the quality gate for external input. With authenticated per-user keys bound to company + user role, the quality gate is now the RBAC layer plus the caller's explicit tool choice. Teammates using external MCP clients (Claude Code, Cursor, etc.) should not need a two-step extraction for tasks they know they want to create.

**What stays the same:**
- `debrief-push` continues to route through Discussion pipeline
- Extraction-approval workflow for Discussion items unchanged
- RBAC scoping (founder / team_lead / team_member) enforced on all MCP writes

**What changes:**
- `create-task`, `update-task`, `add-comment` tools become first-class MCP writes
- Callers with write-permission role can bypass Discussion for direct task creation

**Original wording (for reference):** "MCP inbound always routes through Discussion pipeline — never create raw tasks from MCP input."

---

## Decision (annotation, 2026-04-21): MCP `upsert-task-document` ≡ artifact operations

Paperclip's `paperclipUpsertIssueDocument` tool wraps a markdown body (identified by a `key`) attached to an issue, with an append-only revision history. AoA's equivalent substrate is the existing `artifacts` + `artifact_versions` subsystem, with a 1:1 link from task to artifact via `issues.artifactId`. Phase C (Task C.4) maps Paperclip's document tool surface onto AoA's artifact subsystem:

- `upsert-task-document` → if the task's artifact exists and is of type `document`, add a new immutable version; else create a new artifact of type `document` and link it via `issues.artifactId`
- `list-task-documents` → return the task's document artifact (0 or 1 item — AoA has a single artifact per task, unlike Paperclip's per-key multiplicity)
- `get-task-document` → return the artifact + its latest version (content + metadata)
- `list-task-document-revisions` → return all artifact versions ordered ascending by `versionNumber` (immutable history)
- `restore-task-document-revision` → create a **new** artifact version whose content is copied from the specified older version; the old version is **never mutated** (preserves Decisions #43 / #45 — artifact versions are immutable)

**Surface divergence from Paperclip:** AoA does not accept Paperclip's `key` parameter because its data model is 1:1 task↔artifact. If Paperclip-style per-key multiplicity is ever needed, it would require a schema change (e.g., a `task_documents` junction table), not a tool-surface change.

**RBAC:** All five tools enforce company isolation (cross-company access returns 404) and — for scoped users — project-scope membership via the task's `projectId`. Writes additionally require `permissionsSvc.canAccessEntity("artifact", "update", { departmentId: task.projectId })`.

---

## Decision (annotation, 2026-05-25): Task Outputs are an additive output index

AoA keeps `issues.artifactId` as the primary artifact pointer for artifact-as-input, MCP document tools, and existing artifact viewer flows. The new `task_outputs` table is an additive task-level product index for artifacts, detected files, preview URLs, runtime services, branches, and PRs. PRs, preview URLs, runtime services, and branches are task outputs, not artifacts.

---

## Decision #92 — Defer Phase 6 Hermes wire-field rename to upstream coordination

**Status:** Deferred (locked 2026-04-26)

**Context:** The Paperclip → AoA rename plan (`docs/archive/sessions/2026-04-25-paperclip-to-aoa-rename.md`) defined Phase 6 as renaming `paperclip_session_key` / `paperclip_stream_transport` JSON field names in the OpenClaw / Hermes wire payload (sent during agent execution from `packages/adapters/openclaw/src/server/execute-webhook.ts` and `packages/adapters/openclaw/src/server/execute-sse.ts`). Hermes is owned by an external project; renaming our send-side without coordinating their receive-side breaks the integration for any operator running an older Hermes build.

**Decision:** Phase 6 stays deferred until either (a) the Hermes maintainer confirms readiness for a coordinated rename, or (b) a Hermes adapter version ships that accepts both old and new names (one-release migration window), the minimum-required Hermes version in `package.json` is bumped to that release, and the old field names are removed from the execute files.

**Consequences:**
- Existing Hermes wire fields keep `paperclip_session_key` / `paperclip_stream_transport` names. Documented as wire-compat surface #8 in `docs/architecture/wire-compat.md`.
- Brand-check CI (currently 9 guards in `.github/workflows/pr.yml`) must continue to allow `paperclip` matches inside `packages/adapters/openclaw/**`.
- Re-open this decision when an upstream coordination window opens. Owner: whoever picks up the Hermes adapter or OpenClaw integration work next.

**Reference:** Original Phase 6 spec lives in the rename plan; do not re-litigate without reading it first. Wire-compat surface #8 in `wire-compat.md` cross-references this decision.

---

## Decision #93 — Skip standalone `@paperclipai/mcp-server` package port

**Status:** Locked (2026-04-26)

**Context:** Paperclip released `packages/mcp-server` — a stdio-based MCP server that wraps the Paperclip REST API for external MCP clients (e.g., Claude Desktop, Cursor) to call Paperclip from outside a running instance. It's a separate npm package (~1,148 LOC) that ships with its own bin entry and serves as a bridge: external MCP client → stdio → REST → Paperclip backend.

**Decision:** Do NOT port. At the time this decision was locked, AoA's existing in-server MCP at `server/src/mcp/server.ts` exposed 31 RBAC-scoped, rate-limited tools directly to clients connected to the running AoA backend (read tools, write tools, document tools, approval tools — all per-user-keyed via `mcp_api_keys`). The current generated registry may contain more tools; the standalone-wrapper decision does not depend on that historical count. The wrapper would only matter when the MCP client cannot reach AoA's HTTP endpoint — a use case AoA's local-first deployment model does not currently have.

**Reasoning:**
- AoA's deployment model assumes the client and server run on the same host or LAN. The in-server MCP serves that case directly without a stdio bridge.
- Maintaining the standalone package would mean tracking Paperclip's tool surface separately from AoA's. The surfaces had already diverged when this decision was locked, with different RBAC scoping and AoA-specific tools such as `debrief-push` mapped to discussions.
- The performance + simplicity argument for stdio-MCP doesn't hold when AoA's MCP is already a single in-process call away.

**Revisit when:** AoA grows a multi-tenant cloud deployment where external Claude Desktop / Cursor / etc. clients on a different machine need to talk to a hosted instance. At that point, port the standalone package and rebrand: `@paperclipai/mcp-server` → `@armyofagents/mcp-server`, bin `paperclip-mcp-server` → `aoa-mcp-server`, env vars stay as wire-protocol contracts (`PAPERCLIP_API_KEY` etc.) per Decision #92's rationale.

**Reference:** Plan `docs/archive/sessions/2026-04-26-upstream-paperclip-resync.md` (Tier 5 / D1 skipped).

---

## Decision #94 — Skip Paperclip `pi-local` skill bin/ PATH support port

**Status:** Locked (2026-04-26)

**Context:** Paperclip commit `854fa817` adds skill `bin/` directories to the child process PATH for the `pi-local` adapter so AGENTS.md-invoked skill helpers (`paperclip-get-issue`, `paperclip-add-comment`, etc.) resolve without absolute paths during agent CLI runs.

**Decision:** Do NOT port. AoA's adapter set is `claude_local | opencode_local | openclaw | http | process | cursor | codex_local | hermes_local | gemini_local`. None of these are Paperclip's `pi-local`. Skill helpers via the PATH-prepending mechanism are not part of AoA's heartbeat protocol today — agents communicate with the AoA backend via the in-server MCP, not via shelling out to skill-bundled CLI binaries.

**Reasoning:**
- The Paperclip change targets a specific adapter (`pi-local`) that AoA does not have and has no plan to add (Sprint 2A / Decision #91 removed API-mode adapters; the adapter list is curated).
- AoA's equivalent agent-tool surface is the in-server MCP exposed via per-user keys — agents call MCP tools, not bundled CLI binaries.
- Adding generic skill-bin PATH support to AoA's other adapters (claude_local, codex_local, etc.) would be feature-creep without a concrete agent workflow that needs it.

**Revisit when:** AoA introduces a similar skill-helper protocol (e.g., bundled CLI binaries that run alongside the agent) or adopts a `pi-local`-family adapter. At that point the PATH-prepending logic in the existing adapter `execute.ts` files is the porting site.

**Reference:** Plan `docs/archive/sessions/2026-04-26-upstream-paperclip-resync.md` (Tier 5 / D5 skipped).

---

## Decision #95 — Defer memory access model (Phase 6.2d) until team-under-Commander work has a concrete consumer

**Status:** Deferred (locked 2026-05-04)

**Context:** Phase 6.2 of the memory page redesign sketched (in `docs/archive/sessions/2026-05-03-memory-layer-first-redesign-design.md` §11) a `MemoryAccessService` with `ActorContext` + `MemoryScope` enforcement — three caller classes (external MCP, Commander, worker agents) with permission ceilings, a unified scope filter type, and worker-default restrictions (Identity + own-dept Domain + own-task Working + tagged-shared). Phases 6.2a / 6.2b / 6.2c / 6.2e / 6.2f shipped the user-facing redesign; 6.2d (the access model implementation) was scoped as the final architectural slice.

During the 6.2d brainstorm (2026-05-04), the founder pushed for a more aggressive design: **no pre-baked context for any agent class** — full MCP for everything, including worker agents. Workers would receive only their task description + memory tools (`memory.search`, `memory.list`, `memory.create_working_item`) + a default skill prompt instructing them to fetch context as needed. Commander stays tool-based (already is). External MCP stays tool-based (already is). The pre-baked heartbeat context package shrinks dramatically or disappears.

**Decision:** Defer the entire 6.2d implementation. Write only the design notes; do not build until a concrete consumer exists.

**Reasoning:**
1. **No live consumer for worker scoping today.** Worker adapters (`claude_local`, `codex_local`, `opencode_local`, `openclaw`, `cursor`, `hermes_local`, `gemini_local`, `http`, `process`) do not have memory tools wired up. They consume the heartbeat-built context package and have no way to call `memory.search` mid-task. Adding tools to each adapter is part of the team-under-Commander architecture (Decision #91), not 6.2d.
2. **Commander already works.** Commander's 30 tools include memory tools today. It uses them. Phase 6.2d would not add functionality there — at best it would refactor the existing scope filter to a unified type.
3. **External MCP already works.** Tokens authenticate, get full company access. The `folderPath` filter could be added independently as a small polish slice if the founder wants it (see Revisit options).
4. **Speculative design risk.** Building the access model without a worker consumer means we'd be guessing at usage patterns sub-agents will reveal. When team-under-Commander lands, we'd likely refactor — better to design alongside the consumer.
5. **Founder's full-MCP preference reinforces this.** The aggressive "no pre-bake" model REQUIRES adapters to have memory tools. That's the team-under-Commander work.

**What we're NOT doing yet (and why):**
- `MemoryAccessService` + `ActorContext` types — no consumer that exercises them.
- Worker scope ceiling enforcement — no worker calls memory tools today.
- `sharedWithAgentIds` / tagged-sharing — no agent-tool surface to share into.
- Read audit log — workers don't read memory directly.
- Heartbeat refactor — invisible behavior change with no immediate upside.

**What stays valid in the §11 sketch (preserved for future):**
- Three consumer classes (external MCP / Commander / worker agents) with different default ceilings.
- Worker agents get the most restricted default.
- `MemoryScope` unified type covering layer + departmentId + folderPath + goalId + taskId.
- `ActorContext` derived from auth middleware (not caller-supplied) — caller can narrow within ceiling, never escalate.
- Future: per-agent or per-role grants via `sharedWithAgentIds` for explicit cross-scope access.

**Founder's revised vision (captured for future implementation):**
- Workers: no pre-bake. Task description + memory tools only. Default skill instructs use of `memory.search`, `memory.list`, `memory.create_working_item`. Working memory items lifecycle: archive on task close (current 7-day TTL behavior — keep).
- Commander: full MCP, no pre-bake. Already operating this way.
- External MCP: full MCP, token-authed. Already operating this way.

**Open questions to resolve when this is picked back up:**
1. Worker default scope precise rules (Active Context inclusion logic — by goal lineage, or excluded until tagged?).
2. `sharedWithAgentIds` design: per-agent UUID grants vs role tags vs both.
3. Read audit log: when, what, where (Commander's run summary? Settings? Inbox?).
4. Migration path for existing MCP clients passing `{layer}` only after the unified type lands.
5. Heartbeat context builder: shrink to bare minimum (task + working memory) when adapters gain tools, or eliminate entirely?

**Revisit when:**
- Team-under-Commander work begins (Decision #91 follow-up). At that point, sub-agents will need MCP tool access and the access model designs alongside the actual consumer.
- OR: founder wants the `folderPath` filter exposed via Commander or external MCP today — that's a small standalone slice (~½ day) without the broader access-ceiling infrastructure.

**Reference:** Spec `docs/archive/sessions/2026-05-03-memory-layer-first-redesign-design.md` §11 (sketch + open questions). Brainstorm conversation logged 2026-05-04. Phase 6.2 shipped a/b/c/e/f without 6.2d.

---

## Decision #96 — Marketplace catalog sourced from external repo (`MeteoriteLabs/aoa-marketplace-cdn`)

**Status:** Locked 2026-05-08.

**Rule:** The marketplace catalog (`/api/marketplace/catalog`) is fetched at runtime from `https://meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json`, with a build-time bundled snapshot fallback (`ui/src/aoa-marketplace-snapshot.json`, gitignored, generated by `pnpm fetch-catalog`). The schema in `packages/shared/src/marketplace.ts` is a **mirror** of the catalog repo's schema — it must stay in sync.

**Reasoning:** Separating catalog content from app code lets the catalog evolve independently (new items, version bumps, curation) without redeploying AoA. CDN hosting via GitHub Pages costs nothing and gives instant invalidation on push.

**Implications:**
- Schema bumps require coordinated changes in both repos. Zod schemas use the default `.strip()` mode (unknown fields silently dropped), so **additive changes** (new optional fields) don't require version bumps.
- Adding marketplace fields (e.g., `packageId` per Decision #97) means adding to the shared schema in this repo AND to the catalog generator in `MeteoriteLabs/aoa-marketplace-cdn`. AoA-side code that depends on a new field must handle the field being missing (e.g., synthesis from existing data).
- `CatalogSyncStatus.source` differentiates `"cdn"` (fresh fetch) vs `"bundled"` (build-time snapshot fallback when CDN is unreachable). The cached catalog in `marketplaceCatalogCache` table is the working copy the API serves from.

**Reference:** `server/src/services/aoa-marketplace.ts:24` (CDN URL constant), `scripts/fetch-bundled-catalog.ts` (build snapshot script), `packages/shared/src/marketplace.ts:3-4` (mirror comment).

---

## Decision #97 — Skill packages: synthesis-with-explicit-override hybrid (skill-only after `d8dd326`)

**Status:** Locked 2026-05-08, refined 2026-05-09.

**Rule:** A "marketplace package" is a synthetic grouping of catalog items that share a GitHub source repo. Packages are derived server-side via `derivePackages()`:

1. **Explicit override** — items with a non-empty `packageId` field group under that key (threshold: 1 item). The catalog repo can populate `packageId` to force grouping (e.g., curated bundles that span multiple repos, or one repo split into multiple packages).
2. **Synthesis fallback** — items without `packageId` group by `owner/repo` extracted from `source.url`. Threshold: ≥ 2 items. Items with non-github URLs are skipped from synthesis.
3. **Skill-only constraint** — synthesized packages require **all** members to have `type === "skill"`. Explicit `packageId` overrides accept any type. Reasoning: `PackageCard`'s amber + `Sparkles` visual is skill-themed (per design-system §9.14, §9.15); synthesizing a package from plugins/agents would mis-render the visual identity.
4. **Collision rule** — when an explicit `packageId` matches a synthesizable `owner/repo` ID, the explicit package wins; the synthesized one is suppressed for that ID.

Output is deterministic: packages sorted by `id` ascending, `memberItemIds` sorted ascending. `verified` is true iff every member has `trust.tier === "verified"` (strict).

**Reasoning:** The catalog repo doesn't emit `packageId` today, but synthesis from `source.url` works against existing data (gstack 49 skills, superpowers 14 skills). When the catalog repo eventually adds `packageId`, the explicit-override path activates without an AoA-side code change. **Forward-compatible from day one.**

**Implications:**
- Adding `packageId?: string` to `MarketplaceCatalogItemSchema` is purely additive (optional, Zod strips unknowns). No catalog schema version bump.
- UI surfaces (`PackageCard` §9.15, `MarketplacePackageDetail` page, "Part of X" pill §9.17) consume the derived `MarketplacePackage` type and don't care whether the package was synthesized or explicit.
- Future curated metadata (description, cover image, author profile) would arrive via the catalog repo emitting `packageId` plus a sibling metadata block — extension point only, not implemented.
- The Marketplace hub's sectioned view (design-system §9.18) embeds the Packages strip inside the Skills section, which only makes sense because of the skill-only constraint.

**Reference:** `server/src/services/derivePackages.ts`, `packages/shared/src/marketplace.ts` (`MarketplacePackageSchema`), 21 unit tests in `server/src/services/__tests__/derivePackages.test.ts` (synthesis threshold, explicit override, collision resolution, deterministic ordering, verified math, skill-only constraint, mixed-type via explicit override, whitespace trimming, empty-string fallthrough).

---

## Decision #98 — Primary sidebar auto-collapse rule: secondary takes over

**Status:** Locked 2026-05-09.

**Rule:** A page **force-collapses the primary sidebar on every mount** if and only if it provides a secondary sidebar. Pages without a secondary sidebar respect the user's manual primary-collapse preference (stored in `localStorage["aoa.lobby.sidebar-collapsed"]`).

Implementation: pages opt in by passing `defaultCollapsed={true}` to `LobbyShell`. The `LobbySidebar` state initializer treats `defaultCollapsed === true` as a **force-override** that supersedes localStorage on every mount. The user can still manually expand within that page (the manual toggle writes localStorage). Navigating away and back re-applies the force-collapse.

**Reasoning:** During the marketplace UI overhaul (Phase A) we briefly applied auto-collapse to all marketplace pages, rationalized as "give cards more horizontal room." User feedback during Phase D: the rule felt arbitrary — *"why does primary collapse on Marketplace? There's nothing taking over."* The cleaner mental model is: **primary collapses BECAUSE secondary takes over.** If there's no secondary sidebar, primary should stay where the user left it.

**Current consumers** (as of 2026-05-09):

- `InstanceSettingsPage` — has `SecondarySidebar` with 7 settings sections → `defaultCollapsed={true}`
- All marketplace pages (Hub, Search, Detail, PackageDetail, Updates) — no secondary sidebar → `defaultCollapsed` not passed
- Lobby — no secondary sidebar → `defaultCollapsed` not passed

**Reference:** `ui/src/components/LobbySidebar.tsx` (state initializer), design-system §8.1.1.

---

## Decision #99 — Sub-Agent #1 (discussion extraction): durable poll, atomic claim, linked-run orphan recovery

**Status:** Locked 2026-05-17.

**Context:** Decision #95 deferred the team-under-Commander memory-access model until "a concrete consumer exists ... designs alongside the actual consumer." Sub-Agent #1 — the discussion-extraction consumer — is that first concrete consumer. It implements DA-17 (internal agent handles extraction, not a separate pipeline) as a durable background sub-agent, tracked via DA-27's `internal_agent_runs` (`triggerType='sub_agent'`, `triggerSource='discussion_entry'`).

**Rule:**

1. **Durable poll, NOT an event listener.** Sub-Agent #1's PRIMARY trigger is a durable sweep over `discussion_entries.extraction_status='pending'` (transactional-outbox pattern), registered on the server worker loop (`server/src/index.ts`, 45s interval, module-level in-flight guard). The committed `pending` row IS the work item — the in-memory LiveEvents bus is a lossy *secondary* nicety, never the correctness path. An entry committed while no listener is attached, or during a crash/restart, is still drained on the next tick.

2. **Atomic `pending→processing` claim.** `extractFromDiscussionEntry` claims via a single guarded `UPDATE ... SET extraction_status='processing' WHERE id=? AND extraction_status='pending' RETURNING` (replaced a non-atomic read-then-check). Guarantees at-most-once extraction even under concurrent pickup (sweeper tick racing the reprocess direct-call path). This also fixes a pre-existing reprocess race that predates the sub-agent.

3. **Linked-run orphan recovery.** The consumer links `discussion_entries.extraction_run_id` to its current `internal_agent_runs` row at run **creation — before** the atomic claim. The sweeper's orphan signal is: entry `processing` **AND** its LINKED run is `running` **AND** `created_at < staleCutoff`. Reclaim is atomic and guarded: terminalize that linked run → `failed` (so it can never re-trigger reclaim — no zombie `running` rows) **AND** reset the entry → `pending`, `extraction_run_id=null`. There is deliberately **NO** `extraction_run_id IS NULL` orphan branch: the only producer of (`processing`, `run_id` NULL) is the untouched reprocess direct-call path, which is *healthy in-flight* work — a NULL branch would false-reclaim it and cause double extraction. Reprocess-crash recovery is a tracked deferred follow-up, not in scope.

4. **Reserved per-company platform agent.** Sub-agent runs are attributed to a real but **non-dispatchable** `agents` row, `kind='platform'` ("Commander Team"). It is excluded from every user-facing enumeration (`agentService.list` / `orgForCompany` / `getByUrlKey` / dashboard / home / companies / issues — kind='org' filter applied only at user-facing sites; by-id / cost / budget / heartbeat paths are NOT filtered) and is structurally non-dispatchable (`runtimeConfig.heartbeat={enabled:false,intervalSec:0}` → heartbeat `tickTimers()` skips it via the existing `intervalSec<=0` gate). It is a real row because `cost_events.agentId` is a FK. It owns an **inactive** `budget_policies` row (unlimited-until-configured) so Commander-team spend reuses the existing budget system per DA-25.

5. **Trigger/executor-agnostic consumer + hard error boundary.** `runExtractionConsumer(db, companyId, entryId, platformAgentId)` does not know how it was triggered or where it runs. Any failure is caught and recorded (run → `failed` via a nested try/catch — Drizzle builders are thenables without `.catch`) and **never rethrown**, so extraction can never slow or break `addEntry` / chat / the sweep tick. Per Decision #95 this is a *minimal concrete consumer*, NOT a speculative sub-agent framework.

6. **v1 cost is zeroed (budget PATH proven, not amounts).** The consumer emits a platform-agent-scoped `cost_event` through the existing `costService.createEvent → budgetService.evaluateCostEvent` path. v1 amounts are zeroed (`callLLM` surfaces no token usage yet); the platform agent's inactive policy makes enforcement a structural no-op. This proves the budget path end-to-end without billing real money. Accurate per-extraction token/cost accounting is deferred.

**Reasoning:** The original event-listener design was lossy by construction (in-memory bus, no replay). Making the committed `pending` row the durable work item, plus an atomic claim, makes extraction crash-safe and exactly-once without a queue subsystem. Orphan recovery went through three TDD/review-caught bugs (never-resets → join-on-any-running zombie loop → null-branch double-extraction); the linked-run-only signal is the design that survives skeptical review. The platform agent reuses the existing budget/cost infrastructure rather than inventing a parallel one.

**Implications:**
- `packages/db/src/schema/agents.ts` gains a `kind text not null default 'org'` discriminator (migration `0098_flat_christian_walker.sql`); the default + backfill make it additive-safe for existing rows.
- Adding org-agent filters is *selective* — only user-facing enumeration sites. Cost/budget/heartbeat/by-id paths intentionally still see the platform agent.
- `staleMs` must stay conservatively larger than the longest legitimate extraction so healthy in-flight work is never reclaimed (server wires 10 min; the SQL `staleCutoff` predicate is the authority and is exercised by the Linux-CI integration test, not the Windows-runnable contract tests).
- The reprocess direct-call path (Q2-b) is untouched and remains the only (`processing`, `run_id` NULL) producer; reprocess-crash recovery is a deferred follow-up.

**Reference:** `server/src/services/internal-agent/subagents/{extraction-sweeper,extraction-consumer,platform-agent,concurrency-limiter}.ts`; `server/src/services/extraction.ts` (atomic claim); `server/src/index.ts` (sweep registration). Tests: `extraction-sweeper.test.ts`, `extraction-consumer.test.ts`, `extraction-consumer-contract.test.ts`, `extraction-atomic-claim.test.ts`, `platform-agent-seed.test.ts`, `concurrency-limiter.test.ts`, `extraction-sweeper-wiring.test.ts`, `agents-list-excludes-platform.test.ts` (+ `.integration.test.ts`, Linux-CI), `agents-kind-normalize.test.ts`, `agent-read-sites-org-filter.test.ts`. Implements DA-17; uses DA-27; cost attribution per DA-25; the concrete consumer Decision #95 / #91 (team-under-Commander) deferred for. Working spec/plan were `docs/superpowers/` material (gitignored); code is the authority per `CLAUDE.md`.

---

## Decision #100 — AoA Agents framework: Commander + sub-agents as trigger-driven first-class agents

**Status:** Locked 2026-05-17. **Amended 2026-05-25 (extraction routing).**

**Amendment (2026-05-25):** discussion-entry extraction now defaults to the
direct-provider path (`extractionService` → `resolveAvailableProvider`, Decision
A1), NOT the CLI-adapter agent runner. In practice the agent/CLI path could not
reliably submit results: codex/opencode have no MCP-bridge wiring yet
(`aoa-agents/runner.ts` injects `--mcp-config` for `claude_local` only) and the
claude CLI subprocess does not complete the `submit_extracted_items` handshake
in local / Windows dev — both finish the run but leave the entry stuck
`processing` (silent loss). The agent/CLI extraction path is now opt-in pending
hardening (bridge wiring for non-claude adapters + the claude headless submit
hang). The framework (Commander + crew + the durable dispatcher) is unchanged;
only `subagents/extraction-consumer.ts`'s execution target moved. This narrows
the "uniform CLI-adapter execution" clause below for the extraction sub-agent
only.

- **Uniform CLI-adapter execution:** every AoA agent (`kind='aoa'`: Commander + sub-agents) runs through the existing worker CLI adapter via a no-task runner; structured results persisted by the agent calling internal-agent MCP tools through the bridge (e.g. `submit-extracted-items`), not by parsing adapter stdout (`AdapterExecutionResult` returns no text). No hybrid/`structured_llm` executor. Provider-SDK stays a non-agent primitive (embeddings, transcription) — **Decision #91 honored, not superseded.**
- **Supersedes DA-27** clauses (b) no queue, (c) no atomic checkout, (d) no adapter abstraction, and the *wakeup* half of (e) — AoA agents use atomic-claim dispatch, the worker adapter, and trigger/wakeup. **Keeps** DA-27 (a) separate `internal_agent_runs` table and the *assignment/task* half of (e) (no founder-managed issue/task lifecycle).
- **Resolves Decision #95** — the deferred access model is implemented (per-agent tool allowlist, default-deny) against its now-concrete consumer.
- **Extends Decision #99** — the durable transactional-outbox trigger, atomic claim and orphan-recovery generalize framework-wide; the extraction sub-agent is the first migrated `kind='aoa'` citizen, its #99/M2 correctness preserved (the runner re-asserts the atomic `pending→processing` claim).
- **Discriminator:** `kind='aoa'` + `runtimeConfig.aoa.role` (`lead`|`member`); `agents.role` is NOT overloaded (it is special-cased: `role==='cxo'`, 0070 tiers).
- **Rationale:** a growing internal automation team needs real agentic execution + a uniform reusable model; ~70–75% is reuse of existing `agents`-keyed infrastructure. Spec: `docs/superpowers/specs/2026-05-17-aoa-agents-framework-design.md`.

---

## Decision #101 — Commander chat bubble + run-cost semantics (2026-06-16)

- The founder's own chat messages use a **neutral surface** (`bg-card`, `rounded-2xl`),
  NOT brand red (`bg-primary`). Brand red is reserved for primary CTAs; a filled
  brand-red bubble reads as an error. Actor is distinguished by alignment, not hue —
  mirroring the workspace timeline (`TimelineUserMessage.tsx`). Timestamps are
  hover-revealed (relative time), no avatars (1:1 chat).
- Commander **per-run cost is a list-price ESTIMATE**, always labeled "Est." CLI
  subscription runs report `total_cost_usd: 0` by design (see `cost-model.ts`); the
  estimate is `computeCostCents(model, tokens)`. Tokens are real. Cost is surfaced
  only in Settings → Run History, never in the chat. (Partially un-defers the
  per-run accounting deferral of Decision #91, for observability only.)

## Decision #102 — Thread action-commit idempotency: minimum bar ([#197]) + full outbox alignment ([#198]) (2026-06-18)

The thread-orchestration action-commit path (`thread-agent-actions.ts` / `thread-orchestration.ts`)
kept producing edge cases across three review rounds (stall → park → mixed-batch
duplicate) because "retry" meant "re-run the agent," and the agent re-proposed actions
with **run-scoped** idempotency keys (`${runId}:…`) + a **run-scoped** commit selection
(`eq(runId)`) over **non-idempotent** side-effects — the inverse of the transactional
outbox the org already locked in **Decision #99/#100** (where the stable key is the
entry id, not the run id). PR **[#197]** ships the **minimum non-flaky bar**, every part
a forward-compatible subset of the full fix:

- **Run-independent, turn-anchored keys** for the two highest-value action types
  (`post_reply`, `create_artifact_candidate`); the turn anchor is the latest human
  entry seq at run start (a same-turn retry dedups, two genuine turns stay distinct).
  The other four action types keep run-scoped keys (locked by a guard test).
- **`source_action_id`** column + partial unique index on `discussion_entries` and
  `artifacts` (migration `0145`); the commit converges on the unique violation
  (`isUniqueViolation`, which now reads the postgres-js `constraint_name`), so the same
  action can never produce two side-effects (closes the partial-crash / reaper re-commit).
- **`committed === 0` guard**: a mixed batch advances the cursor instead of re-running
  (no re-execution of already-committed actions); the failed action is dropped — not a
  duplicate, not a stall.
- **Bounded reschedule** on the adjutant-runner-throw and entries-load stall paths
  (reusing `consecutive_commit_failures`) so a deterministic failure can't park a thread.

Deferred to **[#198]** (full Decision #99 alignment): run-independent keys for all six
action types, **thread/company-scoped** commit selection (drop `eq(runId)`) + atomic
`proposed→committing` claim + a durable sweep that drains orphaned `proposed` rows, and a
real UI/Inbox surface for `lastError`. Residuals until then (all failure/edge-path only):
mixed-batch failed-action drop, possible duplicate *draft* on the deferred draft types'
retry path, and the agent-only-thread null-anchor content-dedup.

**Addendum (2026-06-19) — the SEAL: a `proposed→ready` producer-gate completes the outbox; the
relay drains `ready`, not raw `proposed`.** The #198 mechanism above shipped on PR [#203] and a
review round (Codex P1) found it re-creates the leak it set out to fix. A thread-action `proposed`
row is written MID-RUN (by a tool call in the mcp-bridge subprocess), **decoupled from run
success** — unlike #99's `pending` row, which is written in the producer's transaction and so
*means* "the producer committed." Because PR-B's thread-scoped drain selects every `proposed` row,
it commits the side-effects (reply / artifact / scope change / convene) of runs that **failed,
were cancelled, or crashed**. The fix supplies the missing producer-gate, completing the #99
alignment: a producing run, **ON SUCCESS**, promotes the actions it proposed (`proposed → ready`)
by its idempotency-key set — persisted on `internal_agent_runs.proposed_action_keys` (migration
`0147`) because the bridge subprocess and the seal site (the runner) are different processes, so an
in-memory key-set cannot cross. **The relay drains only sealed `ready` rows** (+ post-gate `failed`
retries); an unsealed `proposed` row is never committable; failed/crashed runs never seal and their
`proposed` rows are reaped by `gcOrphanedProposedActions`. This **amends** the #198 bullet: the
durable sweep drains `ready` (sealed), not raw `proposed` — same #99 intent (the committed/sealed
row IS the work item), corrected mechanism. Refs: PR [#203];
`docs/aoa/plans/2026-06-19-prb-outbox-seal-{design,implementation}.md` (adversarial review wf_65e3511f).

## Decision #103 — Plugin sandbox: scoped fs-read, but NO network-egress boundary at any trust tier (2026-06-21)

The plugin worker sandbox (`server/src/services/plugin-sandbox.ts`,
`buildSandboxExecArgv`) uses Node's `--permission` model for non-`core` trust tiers
(`untrusted` / `verified`). Two boundaries it does and does not provide:

- **Filesystem read — scoped (B-M4).** Previously `--allow-fs-read=*` granted full host
  read. It is now scoped to the plugin's package directory, its scratch dir, and the
  instance plugins root (`~/.aoa/plugins`). The plugins root is included because Node
  resolves a plugin's runtime dependencies from the hoisted
  `~/.aoa/plugins/node_modules` tree, so scoping reads to the package dir alone breaks
  module loading for npm-installed plugins. The plugins root is a strict subset of the
  host filesystem — it does not expose the host source tree, secrets, or the rest of the
  user's home directory. When the package dir cannot be resolved, fs-read falls back to
  the plugins root — never to `*`. `--allow-fs-write` stays scoped to scratch + tmp.

- **Network egress — NO boundary exists, at any trust tier.** Node's `--permission`
  model has **no** `--allow-net` flag (that is Deno). Network access from a plugin worker
  is therefore **unrestricted**: raw `node:https` / `node:net` / global `fetch` bypass the
  `http.outbound` capability check **and** the SSRF guard entirely. Those in-process
  controls only constrain the SDK `ctx.http.fetch` helper — a cooperative plugin's
  convenience path, not a security boundary. **A malicious or compromised plugin can make
  arbitrary outbound network calls regardless of its declared capabilities or trust tier.**
  Real egress control requires **OS-level isolation** (a network namespace, a seccomp /
  container sandbox, or a mandatory egress proxy) — it is not fixable with an in-process
  patch and is explicitly **out of scope** for the in-process sandbox. Tracked as separate
  infra work.

**Cloud enforcement amendment (2026-08-03).** Because this worker model is not
a tenant boundary, `cloud_auth` must not execute any host-process plugin worker,
including a plugin whose mutable trust tier is `core`. Activation is rejected at
the lifecycle boundary and independently before worker registration and
`child_process.fork()`. Executable plugin UI, bridge, and stream surfaces are
also deployment-gated independently of persisted status, so a stale `ready` row
cannot execute during boot reconciliation. The stable persisted/HTTP reason is
`PLUGIN_WORKER_BLOCKED_IN_CLOUD`; there is no operator override. Self-hosted
`local_trusted` and `authenticated` behavior remains unchanged. Agent gVisor
does not cover plugin workers. See
`docs/guides/cloud-plugin-execution.md`.

## Decision #125 — Optimistic concurrency for agent updates: optional `updatedAt` token → 409 (2026-06-25)

> ★ **RENUMBERED 2026-09-03: this was filed as `#104`, and so was
> [Decision #104 — Keyless-except-embeddings](#decision-104--keyless-except-embeddings-selectable-extraction-engine--embedding-resilience-2026-06-26)
> one day later.** Two different locked decisions, one number, for over two months. The
> ownership/uniqueness guards key by id, and `DEP-012-design.md:1449` had already resorted to
> disambiguating by LINE NUMBER ("Decision #104 (`decisions.md:913`, the Keyless-except-embeddings
> one)") because the id alone was not enough.
>
> **Why THIS one moved, even though it is the OLDER of the two** — which puts the earlier decision
> (2026-06-25) at the higher number, out of chronological order. That is deliberate, and it is the
> only direction that avoids editing frozen evidence:
>
> - **Every citation of the OTHER #104 that lives in a frozen record** — `artifact-policy.md` makes
>   `tickets/*-result.md` immutable once `complete`, and QA/handoff records write-once from first
>   commit — means Keyless-except-embeddings. `e7-1-evidence-verifier-result.md` alone cites it three
>   times (leak class, provider-key security), and CLI-006-campaign-result, CLI-007-result,
>   CLI-006-D2-step1-result, REL-003-result and the `docs/replatform/qa/*` records do the same.
>   Renumbering that one would require rewriting evidence policy forbids touching.
> - **All four `CLAUDE.md` citations mean the other one too** — rule 11 and the Discussion Pipeline
>   (extraction is CLI-only), the Adapters section (provider SDK), and the memory-write→RAG line.
>   None is about optimistic concurrency, so none of them moves.
> - **This decision's own citations are ALL live source, tests, and one historical plan doc** — none
>   frozen, all updated in the same commit as this rename.
>
> So: chronological order was traded for not falsifying immutable records. If you are here because
> the numbering looks wrong, that is why — please do not "fix" it back.

Agent updates (`PATCH /api/agents/:id` → `agentService.update`) were pure
last-write-wins (guarded by `id` only). Two concurrent human editors of the same
agent (two tabs / two board members) silently clobbered each other. This is
hardening, not a live fire — no MCP/automated path writes agents today — but the
fix is cheap and aligns with **Decision #45** ("founder picks winner — surface
conflicts, no auto-merge").

**Locked pattern:**
- **Token = the existing `agents.updatedAt`** (stamped on every write). No version
  column, **no DB migration**.
- **Optional / opt-in.** `updateAgentSchema` gains `expectedUpdatedAt?` (ISO
  datetime). Absent → last-write-wins (full back-compat; no caller breaks).
  Present → enforced.
- **Millisecond-precision guard (load-bearing).** `agents.updatedAt` is stored at
  Postgres **microsecond** resolution (`defaultNow()` on never-updated rows), while
  the client token is a **millisecond**-precision ISO string. A naked
  `eq(agents.updatedAt, expected)` would spuriously 409 (then loop) on the FIRST
  edit of a freshly-created agent. The guard therefore truncates **both sides to
  milliseconds**:

  ```ts
  where(and(eq(agents.id, id), sql`date_trunc('milliseconds', ${agents.updatedAt}) = ${new Date(expected)}`))
  ```

  The token does **not** round-trip losslessly — this `date_trunc` is what makes it safe.
- **Race-free atomic guard.** The check lives in the WHERE clause of the UPDATE —
  never a pre-read compare (that is TOCTOU). Zero rows matched **while the row still
  exists** → `conflict()` (HTTP **409**) with `details.currentUpdatedAt` (an **ISO
  string** — the service calls `.toISOString()`, since `errorHandler` doesn't coerce
  raw-`HttpError` `Date`s) so the client can refetch. Zero rows + row gone → `null` →
  404. Precedent: the atomic conditional UPDATE in `issues.ts` `checkout`. Proven
  against a real embedded Postgres (Linux-gated / Windows-skipped) because the
  mock-style unit tests can't evaluate the WHERE clause.
- **Scope = whole row.** The token guards the entire `agents` row (Skills vs
  Config conflicts included). False-positive 409s on non-overlapping fields are
  acceptable — a refetch resolves them. Field-level reconciliation via
  `agent_config_revisions.changedKeys` is a possible follow-up, not now.
- **UI opt-in (first wave):** Skills tab + Config save send `agent.updatedAt`
  from the query cache; on 409 they invalidate/refetch and toast "changed
  elsewhere — reloaded, please redo." The Skills tab advances a
  `latestExpectedUpdatedAt` ref from each successful update response (mirroring its
  `latestSkillKeys` ref) so back-to-back toggles before the refetch lands don't
  self-409 on a stale token. The transport-only token is destructured out on the
  route so it never reaches Drizzle `.set()`. Other editors can opt in later by
  passing the token.

Refs: `packages/shared/src/validators/agent.ts`, `server/src/services/agents.ts`,
`server/src/routes/agents.ts`, `ui/src/components/agent-detail/AgentSkillsTab.tsx`,
`ui/src/components/AgentConfigForm.tsx`;
`docs/aoa/plans/2026-06-25-agent-page-followups-design.md`.

[#197]: https://github.com/MeteoriteLabs/AoA/pull/197
[#198]: https://github.com/MeteoriteLabs/AoA/issues/198
[#203]: https://github.com/MeteoriteLabs/AoA/pull/203

---

## Decision #104 — Keyless-except-embeddings: selectable extraction engine + embedding resilience (2026-06-26)

> ★ **This is the sole `#104` as of 2026-09-03.** A second, unrelated locked decision (*Optimistic
> concurrency for agent updates*, 2026-06-25) carried the same number for over two months and is now
> [Decision #125](#decision-125--optimistic-concurrency-for-agent-updates-optional-updatedat-token--409-2026-06-25),
> which records why that one moved rather than this one. **Every citation of "#104" anywhere in this
> repository — all four in `CLAUDE.md`, and every frozen ticket-result and QA record — means THIS
> decision, and none of them needed to change.**

**Status:** Locked 2026-06-26. **Amended 2026-06-27 (extraction is CLI-only; hosted-API fallback removed) and 2026-08-08 (PR #320 `cloud_auth` sandbox credential alignment).**

**Amendment (2026-08-08):** The 2026-06-27 amendment's CLI-only rule remains
controlling, but its keyless wording is narrowed by the shipped multi-tenant
isolation boundary. In self-hosted modes, extraction still uses the installed
CLI login and reads no hosted model-provider key. In `cloud_auth`, extraction
is still a CLI invocation rather than an `api` engine: the control plane
resolves the Company's configured model-provider credential and adapter
configuration, acquires an isolated E2B environment, and materializes that
credential only for the sandbox-local CLI execution through
`one-shot-sandbox-cli.ts`. It does not execute model output on the shared host,
use the shared host's CLI login, or restore `callLLM` / `callAnthropic` /
`callOpenAI` as an extraction fallback. The credential must not appear in the
prompt, argv, protocol, events, logs, artifacts, or evidence, and missing
Company/provider/environment context fails closed.

The earlier statements that embeddings are the only hosted runtime key and
that no extraction path ever reads a provider key are therefore superseded for
`cloud_auth` only. Failure guidance is mode/cause specific: a missing local CLI
or login points to CLI installation/authentication, while a cloud
`sandbox_unavailable` failure may point to the Company's provider-key and
execution-environment settings. There is still no selectable/direct-API
extraction engine or silent host fallback.

**Amendment (2026-06-27):** The founder overrode the original "selectable engine"
ruling below. Discussion extraction (and every other extraction entry point —
debrief-push, file-import, the crew memory-extract tools) is now **CLI-only**: no
extraction code path ever reads a hosted provider key. The dormant `api` engine
(the `callLLM` / `callAnthropic` / `callOpenAI` direct-API path) and the
`GET …/extraction/engine-status` route + `ExtractionEngineStatusResponse` shared
type are **deleted**, not retained. `resolveExtractionEngine` now returns `"cli"`
or throws ("install a CLI and run its login"); there is no api fallback and no
key precheck. Hosted provider keys (the OpenAI `llm:openai` secret / env
`OPENAI_API_KEY`) are used **only** for embeddings. The Provider SDK utilities in
`server/src/services/internal-agent/providers/` remain for embeddings + Commander,
but are no longer reachable from any extraction path. UI: the Settings extraction
engine-status banner is removed and the "LLM providers" settings section is
renamed to **Memory** (OpenAI embeddings key only); extraction-failure copy points
at the local CLI, never at a key. See `docs/aoa/plans/2026-06-27-decouple-extraction-from-keys-spec.md`
and the matching PLAN. The original (now-superseded) selectable-engine ruling is
preserved below for history.

**Original principle (superseded for `cloud_auth` by the 2026-08-08 amendment):** The only hosted API key AoA needs at runtime is for **embeddings** (`text-embedding-3-small` via OpenAI). Every other runtime operation — agent execution, Commander, and **discussion extraction** — runs keyless through the user's locally-installed CLI (Claude Code / Codex / Gemini CLI), authenticating against the subscription the user already has.

### Extraction: selectable engine ~~(SUPERSEDED 2026-06-27 — extraction is CLI-only, see amendment above)~~

**Rule:** `resolveExtractionEngine(db, companyId)` runs **before** the old hosted-key precheck and returns one of `cli` | `api`:

- `auto` (default): resolve `cli` when a local CLI is installed and authenticated; else resolve `api` when a hosted provider key is configured; else surface "no extraction engine available."
- Desktop installs default-resolve to `cli` — keyless extraction.
- ~~The `api` engine (the old `callLLM` direct-API path) is retained **dormant** as the fallback and as the seed for a future "per-company provider keys for crew/org adapters" initiative. It is NOT deleted.~~ **(Superseded 2026-06-27: the `api` engine, the `call*` functions, and the engine-status route/type are now DELETED. Extraction is CLI-only.)**

**Why Option B (server-side one-shot, not crew-bridge):** Decision #100 (amended 2026-05-25) shelved the crew-CLI extraction path because (a) the MCP bridge is wired for `claude_local` only — codex/opencode have no bridge wiring — and (b) the `claude` headless `submit_extracted_items` handshake hangs in local/Windows dev, leaving entries stuck `processing`. Option B invokes the CLI headless (`claude --print` / `codex exec`), captures stdout, parses the JSON array, and writes rows itself — exactly today's server-side structure, transport swapped. No MCP bridge, no handshake, no Decision #100 blockers.

**One-shot invocation:**
- claude: `claude --print --output-format text --system-prompt-file <promptfile>` — entry text on **stdin** (never argv, avoiding Windows cmd.exe mangling).
- codex: `codex exec --json -` — prompt on **stdin**, final assistant text extracted.
- ~60s timeout + grace kill. `cwd` = tmpdir (never reads the project CLAUDE.md).

**Windows prompt fix:** `cli-mode.ts` now delivers the user-content string via **stdin** for claude (not as an argv positional through cmd.exe). This fixes empty Commander turns on Windows and enables keyless claude extraction. The `--system-prompt-file` temp-file path is unchanged (already Windows-safe). No user/content string ever rides argv on Windows.

**Key files:** `server/src/services/extraction-engine.ts` (`resolveExtractionEngine`), `server/src/services/extraction-cli.ts` (one-shot invoker), `server/src/services/codex-exec.ts`, `server/src/services/internal-agent/cli-mode.ts` (Windows stdin fix).

### Embeddings: the sole hosted dependency

**Per-company key resolution:** The `createOpenAiEmbedder` chokepoint in `server/src/services/embeddings.ts` resolves the key per company — Settings secret `llm:openai` first, then env `OPENAI_API_KEY`. No other runtime code path hits the OpenAI API for anything except embeddings.

**Fake-embedder seam:** `AOA_E2E_FAKE_EMBEDDER=1` (env-gated at the `createOpenAiEmbedder` chokepoint) substitutes a deterministic hash-based embedder for CI, avoiding any OpenAI dependency in automated tests.

**Resilience model:**

| Error class | Examples | Handling |
|-------------|----------|----------|
| Transient | 429, 5xx, timeout, network | Exponential backoff + full jitter; honors `Retry-After`; `embedding_queue.next_retry_at` persisted |
| Row-permanent | Malformed / oversized input | Dead-letter fast → `failed` row |
| Systemic | No key / invalid key / `insufficient_quota` | Per-company circuit breaker: pause worker for that company, leave rows `pending` (not `failed`) so the backlog auto-drains when a valid key is added |

Claim: `SELECT … FOR UPDATE SKIP LOCKED` (per-company circuit breaker prevents burning a keyless backlog to `failed`).

**Backfill / catch-up:** On key-add and via a periodic reconciliation sweep, `reconcileNullVectors` enqueues every `memory_items` row with a null vector and no live queue row. Manual re-index endpoints for individual items and all failed items.

**New `embedding_queue` columns:** `company_id uuid` (nullable, populated on new enqueues), `next_retry_at timestamptz` (null = ready immediately).

### Memory write → RAG unification

Every memory write path — `memory.create()`, `memory.approve()`, crew `write_memory` tool, MCP `memory.write` / `memory.retain` / `suggest-memory` / `propose_memory_from_thread` — enqueues an embedding via `writeMemoryAndIndex` / `enqueueMemoryEmbedding` (status-agnostic, deduped). Closes a pre-existing gap where `memory.create()` never enqueued.

### Status model

Per-item `indexStatus` is derived (not stored): `indexed` (vector column not null), `pending` (live queue row pending/processing), `failed` (latest queue row failed), `not_indexed` / `no_key` (no vector, no live row). Surfaced as badges on memory card/row/table. A dismissible no-key banner shows on the Memory page / MemoryExplorer when `semanticAvailable` is false (deep-links to Settings → Memory). Actionable failure copy shown in DiscussionDetail on CLI errors. ~~Extraction-engine status shown in Settings.~~ **(Removed 2026-06-27 — the engine-status banner is deleted; extraction is CLI-only.)**

### New endpoints

- ~~`GET /companies/:cid/extraction/engine-status` — returns resolved engine, CLI availability, and failure details.~~ **(Deleted 2026-06-27 — extraction is CLI-only; the route + `ExtractionEngineStatusResponse` type are removed.)**
- `POST /companies/:cid/memory/:id/reindex` — enqueues a single memory item for re-embedding. Auth: `founder` | `team_lead`. Logs activity.
- `POST /companies/:cid/memory/reindex-failed` — enqueues all `failed` queue rows for this company. Auth: `founder` | `team_lead`. Logs activity.
- `POST /companies/:cid/memory/reindex-all` — enqueues every company memory item without a live queue row for re-embedding (dedup-safe; no-op without pgvector). Auth: **`founder`-only** (board + `assertRole(…, "founder")`). Logs activity. (Added 2026-06-27 — backs the Settings → Memory "Re-index all" button.)

**Reference:** `server/src/services/extraction-engine.ts`, `extraction-cli.ts`, `codex-exec.ts`, `embeddings.ts`, `embeddings-backfill.ts`, `memory-write.ts`, `server/src/routes/memory.ts`. Design: `docs/aoa/plans/2026-06-25-keyless-except-embeddings-design.md`; CLI-only amendment: `docs/aoa/plans/2026-06-27-decouple-extraction-from-keys-spec.md`.

### Embedding worker correctness + pgvector CI lane (2026-06-27 follow-up)

The embedding write path had **never executed end-to-end** — no CI lane set `AOA_E2E_PGVECTOR`, so the worker short-circuited before pgvector code. Running the real pgvector e2e locally surfaced three latent bugs (all now fixed, regression-gated):

1. **Raw-SQL timestamps are strings, not Date.** `db.execute(sql.raw(...))` with the postgres.js driver returns `timestamp`/`timestamptz` columns as **strings** (Drizzle's column type-mapping is bypassed for raw SQL). Feeding such a value into a Drizzle timestamp comparison calls `.toISOString()` on a string → throws. **Rule:** always coerce raw-claimed timestamps to `Date` before reuse (`embeddings-row-utils.ts: coerceQueueRowTimestamps`).
2. **Stale-write guard must exclude self by `id`, not by timestamp.** Coerced `Date`s are millisecond-precision while stored `timestamptz` is microsecond, so `created_at > $coerced` matches the row against itself. Use `ne(id, claimedId)` in both newer-row guards.
3. **Don't bind a `Date` into a raw `db.execute(sql\`…\`)` template** (drizzle-postgres-js execute throws `ERR_INVALID_ARG_TYPE`), and **don't write a pgvector value via a dynamic `.set({[col]: number[]})`** (bypasses the customType → array mis-binds). Write vectors as `.set({[col]: sql\`\${toVectorString(v)}::vector\`})` with a query-builder WHERE (typed `eq`/`ne`/`gt` convert `Date`+uuid correctly).

**CI:** a new required `e2e-pgvector` lane (`pgvector/pgvector:pg16` + `AOA_E2E_PGVECTOR=1`, wired into `ci-required`) now exercises the embedding **write + retrieval** path, including the first cosine-distance ranking assertion (`tests/e2e/semantic-retrieval.spec.ts`). Plan: `docs/aoa/plans/2026-06-27-embedding-pgvector-timestamp-fix-and-retrieval-tests.md`.

---

## Decision #105 — W5b: `claude_local` runtime permission bridge (2026-07-03)

**Status:** Locked 2026-07-03.

### What this is

W5b wires the previously inert W5a runtime-decision broker to a **live `claude_local` run**. When enabled, risky tool calls from a running Claude Code process are intercepted and routed to the human-decision hub so a founder can **allow or deny** them in real time before the CLI proceeds. This is **permission prompts only** — the `work_question` kind is **deferred** because `AskUserQuestion` is Claude Code SDK-only and AoA is CLI-only per Decision #91; there is no CLI hook that intercepts it.

### Hook mechanism

The interception uses a **`PreToolUse` hook** configured in a per-run `settings.json` written by heartbeat and passed via `--settings`. The hook `matcher` is scoped to the set of permission-requiring tools (`Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch`) so benign read-only tools (Read, Grep, Glob, etc.) never prompt.

**Spike finding (2026-07-03, Claude Code 2.1.126):** `PermissionRequest` is **NOT** a firing hook event in the current Claude Code CLI. `PreToolUse` is the working hook. Any future migration to a native permission hook would require a fresh spike and a follow-up decision.

### Transport: command forwarder (not native HTTP hook)

The forwarder is a `type:"command"` hook (`hook-forward.mjs`), **not** native `type:"http"`. This is deliberate:

- Native HTTP hooks in Claude Code are **fail-OPEN** on non-2xx responses, timeouts, and connection failures — the CLI continues executing the tool call even when the hook server is unreachable.
- A command forwarder is **fail-CLOSED**: it emits `{"decision":"deny"}` on any error (network failure, timeout, bad auth, server error). This enforces fail-safe-deny — a founder away from the hub cannot accidentally approve a risky action by being absent.

### Endpoint and authentication

The hook calls `POST /internal/runtime-hooks/permission-request` on the existing Express server. The endpoint is authenticated by a **per-run bearer token** minted by heartbeat at spawn time and stored in an **in-process registry** (single-process assumption: the adapter execute path runs in the same Node process as the Express server; multi-process deployments would require DB-backed token storage, which is a follow-up). The token travels from heartbeat to the CLI **via environment variable only** (`AOA_RUNTIME_HOOK_TOKEN`) and is redacted in all log output. It never appears in `context`, adapter config, or metadata.

The endpoint always returns HTTP 200 with a valid `{"decision":"allow"|"deny"}` JSON body — fail-safe deny on every error/auth path, so the CLI always gets a parseable decision.

### Timeout and SLA

Block timeout: **5 minutes** (`RUNTIME_HOOK_BLOCK_TIMEOUT_SEC=300`). When a pending permission times out on the server side, the route returns **deny** to the CLI (anti-hang) via `requestPermissionBounded`, which on timeout terminates the wait without later marking the decision relayed. The prompt's `timeoutPolicy="escalate"` keeps missed/timed-out prompts **visible** in the hub so the founder can see what happened.

> **Amendment (2026-07-04, BUG-2):** the escalate-visible *mechanism* changed; the *intent* (founder can see what happened) is preserved. Keeping the `agent_runtime_decision` item open in Waiting-on-you forever produced phantom answerable items, an inflated badge, and 409s on action. Now the waiting_on_you item **archives on every terminal transition** (relayed/expired/cancelled — push-close via the version-guarded reconciler), and visibility moves to a **notifications-lane `agent_error` follow-up item** ("Permission request timed out: …") plus the archived row remaining inspectable via status filter/audit trail.

Overnight / away scenarios are handled by **trust rules (allow-always) and keeping unsupervised agents on bypass** — not by extending the timeout. Extending the timeout beyond 5 min risks hanging a run indefinitely.

### Gating and opt-in

Routing is **off by default** (bypass mode, unchanged). It activates only when all three conditions hold:

1. **Per-agent opt-in:** `runtimeConfig.runtimeDecisionRoutingEnabled = true`
2. **Instance kill-switch env:** `AOA_RUNTIME_DECISION_ROUTING=1`
3. **Local execution target:** `executionTarget.type === "local"` (Docker and remote sandbox adapters cannot reach `127.0.0.1` and must not use this bridge)

When the bridge is active, `--dangerously-skip-permissions` is **omitted** from the CLI invocation. The two options are mutually exclusive and never coexist.

### Scope guard

This decision applies to `claude_local` only. Other adapters (`codex_local`, etc.) are follow-up bridges, each gated on their own hook spike — some adapters may never qualify due to the absence of a suitable hook mechanism.

### Review trail

Design reviewed: staff-eng plan review, Codex plan review, and a live proof-of-concept spike (2026-07-03) confirming `PreToolUse` fires and the command forwarder correctly fail-closes before implementation.

**Key files:** `server/src/services/heartbeat/runtime-hooks.ts` (token registry + endpoint), `server/src/adapters/claude-local.ts` (hook injection), `packages/adapters/src/claude-local/hook-forward.mjs` (command forwarder). Plan: `docs/aoa/plans/2026-07-03-w5b-first-adapter-runtime-bridge-plan.md`.

## Decision #106 — W5c: `codex_local` runtime permission bridge via `app-server` (2026-07-03)

**Status:** Locked 2026-07-03.

### What this is

W5c extends the W5b (Decision #105) human-in-the-loop **permission** bridge to `codex_local`. When enabled, a **supervised** codex run that proposes a risky shell command **or** a file-change patch pauses, surfaces an approval in the AoA Hub ("Waiting on you"), and waits for the founder to **allow or deny** before the CLI proceeds — **fail-closed** on timeout/error. W5b is the sibling decision; the two share the same broker, gate resolver, 5-minute SLA, and permission-only scope.

### Dual-path, supervision-gated

`codex_local` keeps **two** execution paths:

- **Unsupervised (default):** the existing `codex exec` one-shot spawn — unchanged. `exec` has no blocking approve/deny callback, so it cannot host the bridge.
- **Supervised (opt-in):** a long-lived `codex app-server` child speaking **JSON-RPC 2.0 over stdio**. This is the only codex mode that exposes a blocking approval callback (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`). Approval policy `untrusted` — auto-approves benign commands, prompts for risky commands + file changes (see `docs/adapters/codex-appserver-protocol.md`).

Supervision is chosen **per run** by the gate below; nothing else about the exec path changes.

### In-process JSON-RPC bridge — no token / registry / HTTP

Unlike W5b (out-of-process `PreToolUse` hook → HTTP callback → per-run bearer token → in-process registry → command forwarder), the codex approval request arrives **in-process** on the adapter's own JSON-RPC read loop. W5c therefore needs **NO HTTP endpoint, NO per-run token, NO registry, and NO forwarder.** The approval-bridge function receives the request frame directly and calls the broker in-process. The claude-only hook/token/registry/forwarder machinery is **untouched** — it is only gated `claude_local`-only in heartbeat and is never reached by codex runs.

### Tracked-child via `spawnTrackedChild` is mandatory (the blocker fix)

The app-server child **must** be spawned through the shared `spawnTrackedChild()` (extracted from `runChildProcess`) so it registers in the **same** `runningProcesses` Map as exec runs. Without this, a supervised run blocked on a pending approval would be (a) **uncancellable** — `heartbeat.cancelRun` couldn't find its PID/PGID — and (b) **wrongly reaped** by the orphan-run sweeper at ~5 min. The 300s approval SLA coincides with the reap threshold, so the shared registration + `runningProcesses.has()` skip is what protects a legitimately-waiting run from being killed while the founder decides. `spawnTrackedChild` also preserves `unsetEnvKeys: ["OPENAI_API_KEY"]` — no key leak, no accidental billing switch.

### Decision enum map (codex v2, fail-closed)

The broker's tri-state outcome maps to codex v2 camelCase `ReviewDecision` enums:

- `allow_once` → `accept`
- `allow_always` → `acceptForSession` (approve + remember for the session)
- `deny` / timeout / thrown (incl. `RuntimeDecisionCancelledError`) / cancel → `decline`

`decline` is a valid **universal deny** even when omitted from the request's advertised `availableDecisions` (live-confirmed in Task 1). Every non-affirmative outcome resolves to `decline` — fail-safe deny.

### File-change trust boundary — decline out-of-tree writes

The `item/fileChange/requestApproval` frame carries **no path** (only `itemId`); the path arrives on the preceding `item/started` frame. The driver correlates `itemId → paths` and the approval bridge **declines OUT-OF-TREE (path-escape) writes WITHOUT surfacing them** — an out-of-tree write must never reach the founder as an approvable prompt. Correlation is string-level only (no `fs`/`stat`/`readlink`). File-change is **NOT descoped**: Task 1 confirmed it fires under the `untrusted` policy, so the bridge ships **command + file-change**.

### 5-minute SLA + escalate-visible

Reuses the W5b block timeout `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC=300` and `timeoutPolicy: "escalate"`. On timeout the broker returns **deny** (fail-closed) and never marks the decision relayed; the hub row stays **visible** so the founder can see what happened. Overnight/away runs are handled by trust rules + keeping unsupervised agents on the default path — not by extending the timeout.

> **Amendment (2026-07-04, BUG-2):** escalate-visible mechanism amended, same as Decision #105: the waiting_on_you `agent_runtime_decision` item archives on terminal transition (it no longer lingers as a phantom answerable item); visibility moves to a notifications-lane `agent_error` follow-up item + the audit trail/status filter.

### Permission-only — `work_question` deferred

W5c covers permission prompts only. The codex `item/tool/requestUserInput` "ask the human a question" frame is **deferred** (same as W5b's `AskUserQuestion` deferral) and noted for a future workstream.

### Cross-path session resume

Supervision is decided per run, so a stored session id may have been created by the `exec` path and later hit by the `app-server` driver (or vice-versa). The driver **attempts `thread/resume` and falls back to a fresh `thread/start` on an unknown-session error** — toggling supervision at worst starts a **new** thread; it never errors the run. `clearSession` is set only when a resume was expected-missing AND no replacement id was obtained (mirrors the exec path).

### Cancel → teardown

A run cancelled mid-approval throws `RuntimeDecisionCancelledError` → the bridge returns `decline`, the tracked child is signalled via `runningProcesses` (SIGTERM→SIGKILL), and the driver's `onClose` hook unwinds the turn — no hang.

### Gating and opt-in — default OFF

Routing is **off by default**. The shared resolver `resolveRuntimeDecisionRoutingEnabled` now allow-lists **both** `claude_local` and `codex_local`, gated identically by all four conditions:

1. **Instance kill-switch env:** `AOA_RUNTIME_DECISION_ROUTING=1` (anything else → off)
2. **Adapter allow-list:** `adapterType ∈ {claude_local, codex_local}`
3. **Local execution target:** `executionTarget.type === "local"`
4. **Per-agent opt-in:** `runtimeConfig.runtimeDecisionRoutingEnabled === true`

Only when all four hold does a codex run take the supervised `app-server` path.

### CI honesty

The full supervised loop is proved by a **guarded live spike** (`AOA_CODEX_APPSERVER_LIVE=1`) and an e2e spec that **SKIPS in CI** (codex is not authed on the runners) — the same posture as W5b.

### Review trail

Design reviewed: W5c plan (staff-eng + Codex review) plus the Task 1 live `app-server` spike (codex-cli 0.130.0, ChatGPT auth) confirming command + file-change approvals fire and `decline` is a universal deny before implementation.

**Key files:** `packages/adapter-utils/src/server-utils.ts` (`spawnTrackedChild`), `packages/adapters/codex-local/src/server/execute-app-server.ts` (dual-path spawn), `packages/adapters/codex-local/src/server/app-server/` (`driver.ts`, `approval-bridge.ts`, `jsonrpc-client.ts`, `parse-events.ts`), `server/src/services/runtime-decision-routing-flag.ts` (allow-list). Protocol: `docs/adapters/codex-appserver-protocol.md`. Board-operator guide: `docs/adapters/codex-local.md` § Runtime-decision bridge (W5c). Plan: `docs/aoa/plans/2026-07-03-w5c-codex-app-server-bridge-plan.md`.

## Decision #107 — Inbox hub correctness wave: four founder decisions (2026-07-04)

**Status:** Locked 2026-07-04. Context: the post-tabbed-redesign content-coverage audit + root-cause investigation (`docs/aoa/qa/inbox-hub-2026-07-03/`), driven by live testing of all 19 hub semantic types. Plan: `docs/aoa/plans/2026-07-04-inbox-correctness-wave-plan.md`.

1. **Waiting-lane items are a MIRROR of their source, not a triage list.** Manual resolve/archive of a source-backed decision item (`approval_request`, `join_request`, `agent_runtime_decision`) is **server-rejected** (409) while the source is still pending — the item leaves the lane only when the source is decided (approve/reject/answer/expire/cancel). Personal **Dismiss/Snooze** remain available (per-user hiding), surfaced back via a "N hidden" chip so nothing becomes permanently invisible. This fixes the archive-hides-a-still-pending-approval hole. `agent_runtime_decision` uses a bespoke `status ∈ {created, shown}` block so `answered`/`relay_failed` stall rows stay manually clearable.

2. **Approvals is removed from the primary navigation; all `/approvals` routes are kept.** The Inbox hub now hosts the full approval workflow embedded (approve/reject/request-revision/resubmit, settled-approval history via the archived filter), so a second nav destination for the same queue is the redundancy the hub redesign exists to kill. The routes remain load-bearing infrastructure: 8 deep-link producers, shareable per-approval URLs, cross-company route-sync, and agent-authored markdown links baked into comment history all terminate at `/approvals/:id`. Pruning the routes (or the list page) is deferred until hub history gains an approvals-aware view — pre-launch that is polish, not a blocker.

3. **Crew-autonomy dial gates agent-INITIATED work only; explicit founder authorization always dispatches.** Approving a `crew_dispatch` (or manually assigning/reassigning a task to a crew agent) exempts the resulting task wakeup from the company crew-autonomy gate (keyed on `payload.issueId` + `source ∈ {assignment, automation}`, covering both the assignee-wakeup chokepoint and the PATCH-reassign path). `crewPaused` stays the true global kill-switch. This fixes the `skipped_autonomy` behavior where approving a dispatch visibly did nothing at Manual/Assist autonomy.

4. **Dead-type package — build 2, prune 2, defer 2, hide 1.** BUILD now (docs already promised them): `extraction_failed` (emit on CLI-extraction failure; auto-archive on successful reprocess) and `routine_outcome` (failure-only; success never notifies). PRUNE (type-only, superseded): `human_input_needed` and `scope_proposal` — the "agent needs the human" channels are `agent_runtime_decision`/`work_question` + `mention`, and scope proposals surface as thread cards + the `crew_dispatch` approval. DEFER to 1.1 (need schedulers): `reminder` (Commander reminders) and `proactive` (the periodic scan loop — CLAUDE.md corrected to reflect it is unwired today). KEEP internal-only, hidden from settings: `legacy_other` (the catch-all sink stays functional for Paperclip-era company-bundle imports).

**Deferred (not decided here, tracked separately) — BOTH NOW RESOLVED 2026-07-04 (see the note below this decision):** the `work_question` **adapter caller** (agents can't yet ask the founder a product question in-run — the service/panel/answer path exist but no bridge raises one; W5b scoped it out) → shipped as the `ask_founder` MCP tool; BUG-6 (`codex_local` supervised turn completes empty) → root-caused (no model on the app-server turn → `gpt-5.3-codex` 400) + fixed. Safety fix shipped for `work_question`: answering one whose run is dead returns an honest 409 + cancels the decision instead of stalling forever.

**Key files:** `packages/shared/src/hub.ts` (`HUB_SOURCE_MIRRORED_TYPES`, semantic-type registry), `server/src/services/hub-items.ts` (mirror guard in `recordLifecycleAction`, `reconcileCompanyBudget`, `resolveLaneForStoredType`), `server/src/services/hub-source-producers.ts` (extraction/routine/budget producers), `server/src/services/internal-agent/aoa-agents/dispatcher.ts` (task-dispatch exemption), `ui/src/components/Sidebar.tsx` (nav removal), `ui/src/components/hub/HubShell.tsx` (dismiss chip). Investigation + test evidence: `docs/aoa/qa/inbox-hub-2026-07-03/`.

## Note — BUG-6 supervised-codex fix + `ask_founder` work_question caller landed (2026-07-04)

The two items deferred by Decision #107 shipped together on `feat/inbox-hub-tabbed`. Plan (verified via a 5-agent claim-verification + completeness-critic workflow, then amended): `docs/aoa/plans/2026-07-04-bug6-and-work-question-adapter-plan.md`.

**BUG-6 (Part A) — codex supervised turn completed EMPTY and falsely reported success.** Root cause (live-proven; auth-staleness ruled out): the supervised `codex app-server` path fires `turn/start` with **no model**, so codex 0.130 falls back to the compiled-in `gpt-5.3-codex`, which a ChatGPT/subscription account rejects with HTTP 400 → zero-item turn; the accumulator's `turn/completed` M1 rule then cleared the error **unconditionally** → false "succeeded". Fix: (1) resolve a codex-compatible chat model via a package-local mirror of `resolveCodexChatModel` (→ `gpt-5.5`; the adapter package cannot import the server-side canonical) and deliver it via the managed `config.toml` (app-server has no per-turn `--model`), gated to subscription auth so a valid api-key `gpt-5.3-codex` is untouched; (2) the config writer is serialized per managed-home (`withCodexHomeConfigLock`) because the home is per-company and concurrent runs share `config.toml` — an un-serialized MCP-write + model-write race could drop the model line and re-introduce the bug; (3) the crew-adapter self-heal also heals an EMPTY model on chatgpt-auth; (4) M1 now clears the error **only when the turn produced real work** — a zero-work completed turn with an error is preserved → `exitCode 1` → honest failure. Key files: `packages/adapters/codex-local/src/server/{codex-config-toml.ts, execute-app-server.ts, execute.ts, resolve-chat-model.ts, app-server/parse-events.ts}`, `server/src/services/internal-agent/aoa-agents/resolve-crew-adapter.ts`.

**`ask_founder` (Part B) — the missing `work_question` caller.** New MCP tool `server/src/mcp/tools/ask-founder-tool.ts` (registered `["agent"]`-gated). An org/heartbeat task-execution agent (guarded on `actor.source==="agent"` + an active `runId`) raises a `work_question` runtime decision and **blocks** (bounded ~5 min) on `waitForAnswer`, returning the founder's answer. **Crew/internal-agent are out of scope by design** — their question channel is the in-thread reply, and the existing `run_id → heartbeat_runs` scope is correct (no FK change). Timeout policy is `park_run`: on cancel / block-timeout / "no longer actionable" the tool returns a non-error `{answered:false, status:"parked"}` (the model must stop, not retry-loop); the hub row keeps its own 24h TTL. A terminal run releases the block within ~1s via `cancelActiveForRun` (heartbeat.ts terminal sites). The hub `RuntimeDecisionPanel` renders clickable option buttons when the tool supplies `options[]` (unique values), else the existing free-text box. MCP tool count: **36** (Read 11, Write 10, Document 5, Approval 10; `memory.write` was also a pre-existing doc-count omission, trued up here). **Live end-to-end proof** (agent calls `ask_founder` mid-run on real codex output) is deferred to the dogfood pass — it needs a live codex run, and this account is out of Codex credits until 2026-07-07; all logic is unit-verified now and BUG-6's fatal-400 was captured live.

## Decision #108 - Hub tabbed-viewer redesign (tab-first, no preview) + ask_founder relay-on-answer (2026-07-04)

**Status:** Locked 2026-07-04. Builds on Decision #107's Inbox hub correctness wave and replaces the temporary reading-pane model with a tab-first viewer.

1. **Tab-first, no preview pane.** Row-click opens and activates a dedicated tab per item (`hubTabForItem` to factory), deduped and activated through `useHubTabs.openTab`. The Home tab hosts the `HubHome` "Needs you most" dashboard; it is not a per-item preview. `HubHomeTab` and the old `HubViewer` reading pane are deleted. Deep-links open a tab. Keyboard `j`/`k` move the list highlight, `Enter` opens the highlighted item's tab, and `Escape` clears the highlight; tabs close only from the tab strip. The redundant in-body type-label header is gone because the tab strip owns that label. Tabs are capped at `HUB_TABS_MAX = 12` (Home + 11 newest closeable tabs), with oldest closeable eviction and a visible "12 max" indicator.

2. **Contextual action bar above non-home tabs.** `HubActionBar` mounts above every non-home tab body and targets the active tab's resolved hub item. It carries Mark-unread, Dismiss, Snooze, Resolve/Archive, Claim/Release, an optional undo affordance, and disabled Route/Delegate plus Ask-Commander stubs with coming-soon aria labels. Mirror rules remain: source-backed open mirrored items do not expose manual Resolve/Archive, and runtime decisions do not expose Claim/Release.

3. **Purpose-built in-tab bodies.** Built viewers stay rich: approvals host `ApprovalDetailCore`, tasks host `TaskDetail`/`TaskOutputViewer`, threads host `ThreadDetail`, agents/runs host their detail containers, and budget hosts `BudgetCapsSection`. Former placeholder kinds now have content bodies for join requests, suggestions, reminders, marketplace operations, routine outcomes, generic notifications, and graceful unlinkable artifact/memory tabs. Row-backed tab payloads carry `hubItemId`, and re-opening a same-key row-backed tab refreshes that payload so duplicate entity keys retarget the latest clicked hub row.

4. **Readable work-question viewer + explicit option metadata.** `RuntimeDecisionPanel` now renders a context callout, roomier prompt text, full-width option cards, optional `description` and `rationale`, and an always-available free-text answer. Free text wins over a selected option. `ask_founder` option objects explicitly declare optional `description` and `rationale` in the strict zod input schema, the MCP JSON inputSchema, and the shared `runtimeDecisionDetailSchema`; relying on passthrough was not sufficient for the tool input. No migration is required because `agent_runtime_decisions.options` is arbitrary jsonb.

5. **Answered `ask_founder` questions terminalize.** After a successful `waitForAnswer`, `handleAskFounder` calls `markRelayed`, mirroring heartbeat's wait-and-relay pattern. This changes the decision from `answered` to terminal `relayed`, causing the projected waiting-lane hub item to close. Relay is best-effort: if it loses a race after a durable answer, the tool still returns the answer. It is never called on park, timeout, or cancel; those paths remain owned by cancellation/expiry cleanup.

**Deferred:** Route/Delegate wiring; Commander "weigh in" wiring; automatic content generation for option descriptions/rationales; full artifact/memory tab payloads and viewers; background auto-annotation of decisions.

**Key files:** `ui/src/components/hub/HubShell.tsx`, `HubActionBar.tsx`, `HubTabBody.tsx`, `useHubTabs.ts`, `hubViewerModel.ts`, `hubRegistry.tsx`, `viewers/*`, `RuntimeDecisionPanel.tsx`; `server/src/mcp/tools/ask-founder-tool.ts`; `packages/shared/src/validators/hub.ts`. Plan: `docs/aoa/plans/2026-07-04-hub-tabbed-viewer-redesign-plan.md`.

## Decision #109 - Task completion policy + durable Ask Human questions (2026-07-11)

**Status:** Locked 2026-07-11. Supersedes the agent-completion restriction in Decision #18 while preserving single-assignee, approval, budget, and atomic-checkout invariants.

1. **Agent-owned tasks resolve one of two completion policies.** `review_required` sends completed work to `in_review`; `agent_can_complete` permits `done` only when structured acceptance criteria and the autonomy ceiling allow it. Company default is `review_required`. A hard company review guardrail can tighten but never loosen child scopes.

2. **Policy precedence follows the actual task model.** Task override -> Routine/workflow-template creator override -> the task's single department-or-project scope -> company. The `projects` table represents both scope types and `issues.projectId` points to one row, so V1 does not invent a department-to-project inheritance chain.

3. **Configured policy and effective authority are separate.** Tasks snapshot the effective policy, source, source identifier, and resolution time. Overrides may change before execution; running-task authority stays stable except an audited founder change that tightens the task to `review_required`.

4. **Review routing is materialized.** `reviewerUserId` may be explicitly set before review. On entering `in_review`, fallback resolution (responsible human -> scoped lead -> founder) is materialized with reviewer provenance, giving Commander and Inbox one stable recipient.

5. **Ask Human is a durable work-domain object.** New questions live in `work_questions`, linked to company, task, agent, recipient, optional run/workspace/source Discussion, answer, and continuation state. Runtime permission decisions remain in `agent_runtime_decisions`. Existing run-bound work questions remain on their legacy lifecycle until terminal and are not unsafely migrated.

6. **One answer resolves every mirror.** Commander, Inbox, Task Work, Workspace, and a source Discussion render the same question identity. First authorized answer wins. Live-broker adapters may relay into an active session; other runtimes ask-and-park and start one idempotent continuation after answer.

7. **Process success is not task completion.** Technical run completion remains in run ledgers and observability. User-facing task completion and source-Discussion milestones are emitted only from actual task-domain transitions.

**Addendum (2026-07-24) — crew completion at default autonomy (product-approved):**

8. **The default autonomy is Assist (1), not Manual (0).** The agent-work dial defaults to `1`. A fresh company's crew must be able to hand a finished task to `in_review` out of the box; completing to `done` still requires Drive (2). Rationale: at Manual (0) the A4 dial-gate (`set-task-status-tool.ts` → `assertAgentStatusTransition`) forbids **any** status advance, so a crew agent physically could not move its task — and the runner's silent-stuck guard then failed the run and ping-ponged the task back to `todo` forever. Schema-default changes affect NEW company rows only; existing configs keep their stored value (intentional — no mass migration).

   *Originally landed on the shared `internal_agent_config.autonomyLevel` (migration `0180_little_omega_sentinel`), which moved four systems at once. **Superseded by §10 below** — the default now lives on `crew_autonomy_level`.*

   **Nothing dangerous unlocks at Assist.** Assist permits advancing only to `in_review` (never `done` — that needs Drive), enables agent-*initiated* scope-compilation, and does **not** auto-dispatch or auto-complete anything. Every real crew dispatch still passes `preflightCrewDispatch` (company budget hard-stop + thread pause/disable) and every founder-gated approval path (crew_dispatch approval, memory candidates, spend brakes) is unchanged.

   At Assist a fresh company's Adjutant/thread scope-draft gate resolves to `accept_apply` (auto-create crew tasks as `planning` + raise ONE `crew_dispatch` Inbox approval) rather than `draft_only` (propose-only). This is onboarding-visible and intended. `accept_apply` still does **not** dispatch — dispatch needs the founder to approve the `crew_dispatch` item.

9. **A Manual-autonomy crew run that did its work is a SUCCESS, not a failure.** The crew runner's completion guard (`runner.ts`, "TASK SILENT-STUCK GUARD") treats a still-`in_progress` task after the run as a failure **only when the agent was permitted to advance it** — i.e. `effectiveAutonomy >= 1` (Assist/Drive). At `effectiveAutonomy === 0` (Manual) a still-`in_progress` task is the **expected terminal state** (the dial-gate forbade the advance): the run completes successfully, the agent's posted comment/artifact stands, the task is **not** released to `todo`, and no "Failed" card posts. The runner clears only the execution lock so the still-`in_progress` task is founder-actionable (Manual = the founder advances it) without being stuck-locked; Manual also gates agent-initiated re-dispatch, so the task does not loop. The guard's real purpose — catching a genuinely hung run at Assist/Drive that never moved the task — is preserved (unknown/`null` dial still fires the guard; only a positive `=== 0` exempts). The guard's error text was corrected from the misleading `"...no set_task_status call"` (an assumption) to `"crew task run finished with the task still in progress (not advanced)"`.

**Addendum (2026-07-24, second) — D18 dial split BUILT (supersedes the §8 blast-radius note):**

10. **Two columns, not one. The shared dial is gone.** `internal_agent_config` now carries **two independent autonomy dials** (migration `0183_clean_lady_ursula`). This closes the D18 follow-up filed in §8; the "one row drives four flows" description above is **historical**, not current behaviour.

    | Column | Owner | Read by |
    |---|---|---|
    | `autonomy_level` (`autonomyLevel`) | **Commander only** | Nothing at runtime today — see the honesty note below |
    | `crew_autonomy_level` (`crewAutonomyLevel`) | **Agent work** | crew task runs, org-agent heartbeat runs, and every Adjutant/thread flow |

    The **complete** reader enumeration, and the dial each one reads (verified against source, not inferred):

    - `dispatcher.ts` → `resolveCompanyConfig` — crew wakeups + crew task runs — **crew**
    - `heartbeat.ts` → `resolveHeartbeatEffectiveAutonomy` — org-agent heartbeat runs — **crew** (see naming note)
    - `controller-adjutant-runner.ts` — Adjutant scope-compilation — **crew**
    - `thread-participation-runner.ts` — crew @mention answers — **crew**
    - `thread-agent-actions.ts` → `resolveScopeAutoAcceptGate` — scope-draft auto-accept — **crew**
    - `thread-events.ts` — proactive Adjutant wake — **crew**
    - `threads.ts` → `advancePhase` — phase-advance auto-approve + dispatch — **crew**
    - `routes/discussions.ts` — the phase-advance authz gate that mirrors `advancePhase` — **crew**
    - `reconcile-autonomy-scale.ts` — startup clamp of the legacy 0..3 scale — **both**, independently
    - `company-portability.ts` — export/import — **both**

    Downstream consumers (`runner.ts`'s completion guard, `set-task-status-tool.ts`, `advance-phase-tool.ts`, `propose-crew-work.ts`, `tool-registry.ts`, `mcp-bridge.ts`, `cli-mode.ts`) read a **resolved** `effectiveAutonomy` off the run payload / tool context. They inherit whichever dial the resolution site chose and were deliberately left untouched — there is exactly one resolution site per system.

11. **Naming honesty — `crew_autonomy_level` also governs ORG agents.** D18's language was "crew autonomy column" and the column keeps that name, but the dial means *"how far may an agent take its own task"*, which is the same question for a crew agent and an org-agent heartbeat run. Splitting those two further would be a third dial with no product story. The Settings control is therefore labelled **"Agent autonomy (crew + org agents)"**, the schema comment lists the org-heartbeat reader by name, and `docs/api/internal-agent.md` documents both the mismatch and the migration note for clients still sending `autonomyLevel`. What makes the narrow name acceptable is the **mitigation, not the reasoning**: this is documented deliberate narrowing rather than undocumented drift.

    **RENAME TRIGGER — inherit this, not just the decision.** The asymmetry here is inverted from the usual failure mode: the column with the *honest* name (`autonomy_level`) does nothing, and the one with the *narrow* name (`crew_autonomy_level`) does everything. That holds only while every consumer is crew or org. **If a third consumer arrives that is neither — a plugin-run agent, an autonomously-executing routine, a scheduled proactive scanner — do NOT add it to `crew_autonomy_level` by default.** That is the point at which renaming to `agent_autonomy_level` stops being churn and becomes the cheaper option, because a third unrelated consumer is what turns "documented narrowing" back into drift.

12. **Commander's dial is currently inert, and that is stated rather than hidden.** No Commander code path reads `autonomy_level` at runtime: Commander's gating is the unconditional runtime-approval policy (`mcp-bridge.ts` → `runtime-approvals.ts`, `actorType:"commander"`). The column is retained as D18's declared Commander home and is carried by portability bundles. The Settings UI shows **no level for Commander at all** — not a read-only one. A control would have to display *some* number, and every number would assert behaviour that does not exist; the pre-split stub hard-coded `0` while the column defaults to `1` and round-trips through portability bundles, so importing a bundle with `2` displayed "Level 0". Commander's block is now a plain statement that it asks before every governed action, pointing at the runtime-approval settings that actually govern it.

13. **Existing rows were backfilled, not defaulted.** `ADD COLUMN ... DEFAULT 1` would have stamped every existing row with Assist, silently moving any company that had deliberately chosen Manual or Drive. Migration `0183` therefore runs `UPDATE internal_agent_config SET crew_autonomy_level = autonomy_level` immediately after the DDL: on the day of the split the crew dial holds exactly what the crew readers read the day before, so **no live company's behaviour moved**. Both dials keep the Assist(1) default for new rows, preserving §8. Pre-split portability bundles (no `crewAutonomyLevel`) import with the same fallback.

14. **The invariant under test is "moving one does not move the other."** A change that merely aliased the two columns would satisfy any single-dial assertion, so the tests are written to fail on an alias: `d18-autonomy-dial-split.test.ts` (distinct SQL names, plus **three** source guards) and `d18-autonomy-dial-split.integration.test.ts` (real Postgres; Commander=Drive/crew=Manual must behave Manual **and** Commander=Manual/crew=Drive must behave Drive, through the real `thread-agent-actions.ts` gate). Ablation-verified: repointing one reader back at `autonomyLevel` fails both directional cases and the registry guard.

    **A reader can take two shapes, and the guards cover both.** A column-name sweep alone is not enough: a whole-row `db.select().from(internalAgentConfig)` followed by `cfg.autonomyLevel` never names the column. That shape is not hypothetical — six such selects exist, and `agent-loop.ts` spreads the entire row (both dials) into the object handed to `cliService.chat`, so a `config.autonomyLevel` check added inside `cli-mode.ts` or a provider would re-couple Commander invisibly. The guards are therefore (a) a column-name sweep with a closed allowlist, (b) a token sweep asserting the Commander **runtime** surface (`services/internal-agent/*.ts` + `providers/`) never mentions `autonomyLevel` in any form, and (c) a whole-row-reader sweep with its own allowlist for the two paths that legitimately move the value without interpreting it (the settings PATCH and portability).

15. **Known residual, accepted: the settings route cannot detect a *wrong known key*.** `PATCH …/internal-agent/config` is `.set({ ...req.body, updatedAt })` with zod stripping unknown keys. Zod protects against unknown keys, not against a caller who sends `autonomyLevel` *meaning* "agent autonomy" — that writes the inert column and nothing fails. This predates the split; the split makes it silent rather than loud, because pre-split the write would at least have worked. Mitigation is documentation, not code: `docs/api/internal-agent.md` carries an explicit migration note for clients still sending `autonomyLevel`. A server-side rejection would need a deprecation window and is not worth one for a field with no external consumers today.

**Plan:** `docs/aoa/plans/2026-07-11-commander-ask-human-completion-policy-plan.md`. D18 split: `docs/aoa/plans/2026-07-24-phase2-marketplace-provisioning.md` § T2.10.

## Decision #110 - Two-tier Claude instruction isolation for agent runs (2026-07-23)

**Status:** Locked 2026-07-23 (plan decision D16). Implemented by the crew config-isolation work; one sub-claim remains unverified and is stated as such below.

1. **Two tiers, not one switch.** The operator's **global** Claude config — `~/.claude`'s hooks, `settings.json`, `plugins/`, user `skills/`, and `CLAUDE.md` — is **blocked** for agent runs. The **workspace repository's own `CLAUDE.md` is allowed**: build commands, test conventions and architecture rules are legitimate engineering context, and an agent that ignores them does the wrong thing confidently.

2. **AoA's instructions outrank the repo's by construction, not by convention.** Agent instructions are delivered via `--append-system-prompt-file` (`claude-local/src/server/execute.ts:650`). A repo `CLAUDE.md` arrives as user-level context, so no precedence rule needs enforcing — the layering is structural.

3. **The mechanism is config-home redirection, not a disable flag.** Blocking is achieved by pinning `CLAUDE_CONFIG_DIR` to a fresh per-run directory and provisioning **only** `.credentials.json` into it. The operator's global instructions live *inside* the config home, so redirecting the home is what makes them unreachable.

4. **`--bare` was evaluated and rejected.** It is the CLI's only all-or-nothing context switch (skips hooks, plugin sync, auto-memory and `CLAUDE.md` auto-discovery). It is **unusable here** for two independent reasons: it forces `ANTHROPIC_API_KEY`/`apiKeyHelper` auth and never reads OAuth or the keychain, which breaks the subscription-based credential provisioning this design depends on; and it suppresses **all** `CLAUDE.md` discovery including the project's, contradicting tier two.

5. **A previously-assumed mechanism was disproven.** Earlier planning drafts referenced `CLAUDE_CODE_DISABLE_CLAUDE_MDS` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. **Neither exists in the installed CLI** (`claude --help`, 2026-07-23). Do not reintroduce them.

6. **Open sub-claim — do not treat as settled.** Whether `CLAUDE_CONFIG_DIR` also redirects the *user-level* `~/.claude/CLAUDE.md`, or whether that file is reached by a second route, is **not established**. Tier one is proven for `settings.json`/`plugins/`/`skills/` (the per-run directory demonstrably contains only the credential); the user-level `CLAUDE.md` specifically is inferred, not observed. **What would settle it:** during live crew verification, run with a distinctive marker string in the operator's `~/.claude/CLAUDE.md` and assert it is absent from the run transcript. Note that testing this by invoking `claude` from inside an agent session is unreliable — that has produced false findings in this project before.

7. **Tier two was satisfied by accident, and wrongly — CLOSED 2026-07-23.** Crew runs were not workspace-backed: the crew runner never set a workspace, so `cwd` fell through to `process.cwd()` (`claude-local/src/server/execute.ts:188`) — the **AoA server's own repository**. Every crew run therefore loaded *AoA's* `CLAUDE.md` rather than the customer workspace's. This is the most likely mechanism behind the observed live hijack. **Fixed by crew workspace resolution (T5):** the crew runner now populates `context.paperclipWorkspace` by reusing heartbeat's own resolver (`server/src/services/workspace-resolution.ts`, extracted from `heartbeat.ts`), with the per-agent home `<AOA_HOME>/instances/<id>/workspaces/<agentId>` as an always-present floor — so `process.cwd()` is unreachable from the crew path. Crew does **not** realize per-task git worktrees; an `isolated_workspace` / `operator_branch` project policy degrades to the project's shared primary workspace until W3b.

**Key files:** `packages/adapters/claude-local/src/server/ambient-config.ts`, `execute.ts`; `packages/adapter-utils/src/server-utils.ts` (`mergeChildEnv`, `foldEnvKey`); `server/src/services/internal-agent/aoa-agents/runner.ts`. Plan: `docs/aoa/plans/2026-07-19-crew-execution-phase1-foundation.md`.

## Decision #111 — Teams may be company-wide: `teams.parent_project_id` is nullable (D21) (2026-07-24)

**Status:** Locked 2026-07-24 (Phase 2 marketplace provisioning, plan decision D21). Implemented by T2.1; migration `0181_light_overlord`.

1. **A team may have no parent department.** `teams.parent_project_id` is nullable. `NULL` means **company-wide**, not "unknown" or "not yet set" — it is a first-class scope, and the only writer of it is the crew installer.

2. **Why it had to change.** AoA crew (Adjutant, Scout, Engineer, …) are **company-wide singletons** — Adjutant serves every department. Nothing creates a department at company-create time (not company creation, not onboarding; the founder makes them), so at the moment the crew is installed there is no department to install into. Worse, the column carries `ON DELETE CASCADE`: parenting the crew to an arbitrary department meant deleting that department would silently delete the crew team row.

3. **The FK stays `ON DELETE CASCADE`.** Nullability is not a relaxation of the departmental contract — a departmental team still cascades away with its department. A `NULL` parent simply has nothing to cascade from. Both halves are asserted together in `server/src/__tests__/teams-null-parent-cascade.integration.test.ts`; a test that only checks "NULL is accepted" would not have caught a dropped FK.

4. **Existing rows are untouched.** The migration is a bare `DROP NOT NULL`. No backfill, no re-parenting.

5. **The public install API is unchanged.** `POST …/marketplace/install` still returns **400** for a team or agent install without a `targetDepartmentId` (`server/src/routes/marketplace-installs.ts:338`), and `createTeamSchema` still requires `parentProjectId`. Only the internal crew bootstrap may omit it. `installTeam` accepts `null`/absent and skips the department pre-flight — but a **supplied** id is still fully validated (exists, belongs to the company, `type: 'department'`). A bad id is an error, never a silent fallback to company-wide.

6. **Authorization fails closed on `NULL`.** `assertDepartmentAccess` takes `string | null`; a null department is founder / instance-admin only. No team lead can be "lead of no department", so the lead-scoped grant cannot apply to a company-wide entity.

7. **A company-wide team's roster is installer-owned.** `addMember`, `removeMember`, and `updateMemberRole` all **refuse** when `parentProjectId` is null (`server/src/services/teams.ts`, `loadTeamForRosterEdit`). The roster comes from the marketplace package, is written by the installer inside its own transaction, and is reconciled by `team-reconcile`. This is deliberately symmetric: closing only `addMember` would let a founder strip the crew one agent at a time with no supported way to put anyone back. The department-membership lookup in `addMember` is also the **tenancy-bearing** guard — skipping it for null-parent teams rather than refusing would open a cross-tenant path. Making the crew roster founder-editable requires its own company-scoped agent check and is a separate design call.

8. **Company-wide is a visible state, not a blank.** The Teams list renders a distinct **"Company-wide"** pill rather than the `—` used for an unresolvable department id, and search matches that label so the crew is findable by scope (`ui/src/components/team/TeamCard.tsx`, `ui/src/pages/TeamsListPage.tsx`).

**Resolved follow-up (T2.3, 2026-07-24):** `dispatchInstall` no longer hard-throws for a team install without a department. The throw was a redundant backstop — the user-facing guard is the route's 400 (point 5 above), which fires *before* `startInstallOperation` — so relaxing it loosened no HTTP path. The relaxation is **null-only**: a supplied department id is still forwarded verbatim to `installTeam`, which validates it. See Decision #112.

**Plan:** `docs/aoa/plans/2026-07-24-phase2-marketplace-provisioning.md` (T2.1).

---

## Decision #112 — Company creation installs the crew from the marketplace, and degrades loudly (D21/P8, P8c) (2026-07-24)

**Status:** Locked 2026-07-24 (Phase 2 marketplace provisioning, T2.3).

1. **Company create installs `team:aoa-curated/default-crew`.** The legacy `ensure-*` seeders write no `templateOrigin`; the boot backfill stamps them `…@legacy`; and `crew-updater.ts` skips `@legacy` rows **forever**. Every company was therefore permanently frozen out of the update pipeline that was already built and running. Installing the marketplace team at create time is what makes a company **born updateable**.

2. **Through the orchestrator, not straight to `installTeam`.** `startInstallOperation` + `dispatchInstall` own the `marketplace_install_operations` record, `cascadeResults`, and idempotency-key dedupe — which T2.7 (diff/merge) and T2.8 (re-materialization) build on. A second, divergent bootstrap path would fork them.

3. **Deterministic idempotency key `bootstrap-crew:<companyId>`, plus an atomic claim.** `startInstallOperation` returns the existing operation on a key hit, and `claimOperationForDispatch` then decides ownership with a conditional `UPDATE … SET status='running' WHERE status IN ('pending','failure')`. A status *read* would not be enough: `startInstallOperation` is check-then-act, and two concurrent callers can both receive the same row while it is still `pending` (the loser's conflict-fetch returns the winner's row before the winner writes `running`). Dispatching twice would re-run the team installer and mint a renamed duplicate roster.

   **Claimable statuses:** `pending`, `failure` (nobody owns a failed install and nothing was installed, so repair must be able to retry), and a `running` row **older than `OPERATION_CLAIM_STALE_AFTER_MS`** (10 min). Without that last one a process killed between claim and terminal patch strands the row forever: after 24h the idempotency lookup misses, the INSERT trips the unbounded unique index, `onConflictDoNothing` suppresses it, and the fallback SELECT — which has no `createdAt` cutoff — returns the same stale `running` row, so the caller reports "already dispatched", short-circuits **before** the seeding guard, and the company ends with no marketplace crew, no legacy crew, and no repair path. The claim also resets `startedAt` and clears `errorMessage`/`completedAt`, so a retried-and-succeeded operation does not end `success` carrying the previous attempt's error. A fresh `running` is never stolen; `requested` is never claimable (it is a pending human decision).

   **Correction (2026-07-24):** an earlier draft of this decision — and of the T2.3 plan — justified the key by saying "company create already retries on issue-prefix collision, so this is reachable". **That is false.** The retry loop in `companies.ts` only re-enters on a conflict at the company `INSERT`, before any `companyId` exists, so it can never re-provision the same company. The key and the claim are still correct and load-bearing; the reachable repeat caller is T2.3b's repair path, and `failure` is claimable precisely so that repair can retry.

4. **Catalog resolution is a bounded wait, not a cache read.** cached catalog → (bounded) live sync, which itself falls back to the bundled snapshot → `null`. The boot sync is fire-and-forget (`startSyncLoop` → `void this.sync()`), so a company created seconds after boot would otherwise read an empty cache and be provisioned `@legacy` — non-deterministically, and invisibly afterwards. `MarketplaceCatalogService.ensureCatalogAvailable` **joins** the in-flight sync (deduped) under `CATALOG_AVAILABILITY_TIMEOUT_MS` (12s, deliberately shorter than the 30s CDN timeout so a hung CDN cannot hold onboarding open).

   **What this guarantees vs. makes likely:** it *guarantees* create never loses to the boot sync merely by ordering — a cold cache waits for the same attempt instead of racing it. It does **not** guarantee a marketplace roster: a CDN that is slow past the budget, or unreachable with no bundled snapshot present, still degrades. That is intentional.

5. **`app.ts` registers the catalog service in a process-wide registry.** The service is constructed at the app layer (it owns the bundled-snapshot provider); company create sits far below the route layer. With **no** service registered — every unit and integration test that is not explicitly exercising this path — resolution is cache-only and degrades immediately. That is the seam that keeps the test suite off the network.

6. **The degrade is lossy, and the log says which roles are lost.** The legacy seeders cover 8 roles; the crew team declares 9. There is **no `ensure-reviewer.ts` anywhere in the tree**, so a company provisioned during a marketplace outage is permanently missing its Reviewer with nothing in the data to distinguish it from a complete roster. `describeLegacyCoverageGap` computes the gap from the live team item's `requires[]` when a catalog is in hand (authoritative, catches roster drift) and from a static last-known map otherwise, and the degrade log names the gap in both the message and the structured context. A generic "install failed, using legacy seeders" line is not sufficient to diagnose this later.

7. **The degrade calls `ensureCrewAgents`, never a union.** `ensureInfrastructureAgents` has already run unconditionally by then (P8d / T2.2). There is deliberately no "seed everything" export.

8. **The create-time `isCrewMarketplaceManaged` gate SURVIVES.** T2.3 was specified to delete it as unreachable. It was kept: it is what pins the **read-the-gate-before-any-seeding** ordering that `aoa-bootstrap-wiring.test.ts` (`stampsOriginOnSeed`) guards — a read-after-write gate would let a company see its own freshly-inserted Commander, conclude "marketplace-managed", and skip its entire crew — and it correctly short-circuits a concurrent create that already installed the marketplace crew. It costs one indexed query.

9. **The degrade re-checks a WITNESS immediately before it seeds, and repairs the record.** `dispatchInstall` can commit the team-body transaction, write `success`, and *then* throw — the success DB write can fail, and `publishLiveEvent` is a bare synchronous `EventEmitter.emit` so a throwing subscriber propagates — landing in its own catch, which overwrites the terminal patch with `failure`. A `failed` result therefore does not prove nothing was installed. Seeding on top of a committed roster is silent and permanent: `seedCrewAgent` hits `ON CONFLICT DO NOTHING` on every name-overlapping role, takes the `!inserted` branch, and overwrites the **marketplace** rows' `runtimeConfig.aoa.toolAllowlist` and possibly their adapter — while `templateOrigin`/`templateVersion` survive, so `crew-updater` sees managed rows at the current catalog version and never repairs them, and no duplicate row is minted to reveal the damage. Instruction-bundle seeding itself is idempotent and preserves founder files; the DB mutation is already sufficient to corrupt the effective configuration. One indexed query before the write closes the whole class rather than the two known triggers.

   The witness is the `teams` row carrying the crew team's `templateOrigin` — written in the same transaction as the agents, and `installTeam` now **refuses to write it with zero agents**, so it is exact in both directions. It is deliberately **not** `isCrewMarketplaceManaged`: that predicate also matches Commander if the infrastructure seeder ever stamps an origin, and using it made a company skip its own crew as soon as any seeder stamped an origin (`aoa-bootstrap-wiring.test.ts`, `stampsOriginOnSeed`, caught exactly that). The witness is tri-state — `installed` / `absent` / `unknown` — and `unknown` fails closed *without* claiming the install succeeded.

   **Refusing to seed is not sufficient on its own.** That guard protects the legacy-seeder path but not the marketplace **re-install** path, which consumes the same lying row: a later `provisionCompanyCrew` (T2.3b repair) claims the `failure` row and re-runs `installTeam` over a company that already has the roster, minting `Scout-2` / `Reviewer-2` / `default-crew-2` — all carrying the same `templateOrigin`, which additionally breaks the single-row team lookups in `resolver.ts` and `team-reconcile.ts`. So the averted path **repairs the operation row** to `success` (not claimable), which closes the hole and corrects the audit record in one move.

10. **The install is bounded, and the deadline aborts rather than abandons.** The published roster is 27 network fetches (`team.json` + 9 `agent.json` + 17 skill bodies — **zero** of the crew's skills carry `content.inline`). Sequential at `FETCH_TIMEOUT_MS` = 30s that is ~13.5 minutes inside an interactive POST, past which Node's 300s default `requestTimeout` was the real ceiling: a socket error, a founder retry, and a company row already created with an install still running. `CREW_INSTALL_DEADLINE_MS` (30s) is chained into every fetch as an `AbortSignal` and re-checked before each phase, and `CREW_INSTALL_FETCH_CONCURRENCY` (6) makes the healthy path ~1-2s. Worst case for company create is now ~42s (12s catalog + 30s install). The signal **aborts** in-flight requests rather than merely abandoning their results — and it fires on EVERY exit path, not just deadline expiry: a phase-1 503 or parse error used to cancel the timer and leave ~26 orphan fetches running at `FETCH_TIMEOUT_MS` apiece while the caller was already writing legacy rows — an install that landed after the caller had degraded would be point 9's clobber all over again. Other `installTeam` callers are unchanged (no signal, concurrency 1): the public install route is 202-accepted and does not pay this latency synchronously.

11. **A failed sync is negatively cached.** With an empty cache, an unreachable CDN, and no bundled snapshot (any image built without `pnpm fetch-catalog` — the file is gitignored), the cache never fills, so *every* create would start a fresh 30s-timeout fetch and burn the full availability budget. `CATALOG_SYNC_FAILURE_COOLDOWN_MS` (60s) short-circuits `ensureCatalogAvailable` to cache-only after an attempt that produced no catalog.

12. **Catalog unavailability keeps its cause.** `no-service-registered` (a wiring regression — nothing called `registerMarketplaceCatalogService`) must not read like a CDN blip in the degrade log, so `resolveCatalogForBootstrap` returns a typed reason that reaches `degradeReason` as e.g. `no-catalog:no-service-registered`.

13. **Bundle import provisions too.** `companies.create` has a second caller — `company-portability.ts`, `new_company` mode. An imported company marketplace-provisions like any other, deliberately: skipping it would mint a second class of permanently-`@legacy` companies. It is safe against the bundle's own agents because the crew is `kind='aoa'` and every import/export agent path is `kind='org'`, so the two rosters never see each other.

14. **Node >= 20.3.** The aggregate deadline uses `AbortSignal.any`, which landed in Node 20.3.0. On 20.0-20.2 it throws inside the fetch helper, is wrapped as a fetch failure, and every company on that runtime silently degrades to `@legacy` — arriving as a "CDN problem". `engines.node` is `>=20.3`. CI (24) and the Docker image were never exposed; source checkout, the supported install path, was.

**Known limitation — "offline" means *catalog* offline, not *install* offline.** The bundled snapshot carries only the catalog **index**. `installTeam` still fetches `team.json` and each `agent.json` over the network (`fetchCatalogResource`), and published skills carry `content.inline === null`, so their bodies are fetched too. A genuinely network-isolated instance resolves a catalog from the snapshot and then **fails the install**, degrading to legacy. True offline provisioning would require bundling resource bodies, not just the index — not built, not claimed.

**Key files:** `server/src/services/crew-provisioning.ts`, `server/src/services/marketplace-install/crew-bootstrap.ts`, `server/src/services/aoa-marketplace.ts`, `server/src/services/companies.ts`, `server/src/services/marketplace-install/orchestrator.ts`, `server/src/services/marketplace-install/team-installer.ts`, `server/src/services/marketplace-install/operation-store.ts`.

**Plan:** `docs/aoa/plans/2026-07-24-phase2-marketplace-provisioning.md` (T2.3).

## Decision #113 — Protected AoA agents are identity-keyed, and the guard lives at team uninstall (D23) (2026-07-24)

**Context.** Commander and Steward are essential to AoA: Commander is the
always-on internal assistant, Steward drives Inbox Hub curation. A marketplace
uninstall must never destroy them.

**Decisions.**

1. **Protection is an AoA fact, enforced server-side** — not catalog metadata.
   Commander is not published; Steward is. Publication does not make essential
   runtime identity a mutable catalog policy, so both remain protected here.

2. **The set is keyed on agent IDENTITY, not only on `templateOrigin`.** Older
   Steward rows can have a NULL origin until Phase 4A adoption runs. A canonical
   role slug is recovered from **either** signal a row can carry — the origin
   (legacy-suffixed or a catalog id) **or** the name — and either alone suffices.

3. **Steward's NULL origin must not be blindly stamped by a seeder.** Before
   the marketplace package existed, that would have flipped the broad managed
   predicate and suppressed the crew. Phase 4A instead adopts only a verified
   legacy Steward into an already marketplace-managed default crew; Phase 4B
   then moves new Steward creation behind the same crew gate.

4. **The guard belongs at team uninstall, not at agent delete.** `DELETE
   /agents/:id` already hard-refuses every `kind='aoa'` row for all actors.
   There are exactly three `delete(agents)` sites: the agents service, whole-
   company delete (intended), and `team-uninstaller.ts`, which deletes members
   with raw SQL inside its own transaction — so a per-agent guard is invisible
   to it. That was the only unguarded path, and it is where the refusal lives.
   The refusal is raised **before** the transaction opens.

5. **Team uninstall DETACHES protected agents; it does not refuse.**
   `uninstallTeam` partitions before any write, deletes the unprotected members
   and the team row, retains the protected agents, and returns
   `{ deletedAgentIds, retainedAgents }` (the route also projects
   `retainedAgentIds`). Retained agents are excluded from **both** the
   `aoa_agent_triggers` delete and the `agents` delete — excluding them from
   only the latter would leave the row alive with its triggers wiped, which is
   point 7's harm arriving through this door.

   *Superseded reasoning, recorded so it is not re-adopted:* an earlier revision
   refused the whole uninstall, on the argument that a `deletedAgentIds`
   silently omitting requested members is worse than a named refusal. That is
   an argument against **silence**, not against partial retention — an explicit
   `retainedAgents` is not silent, and agents are not owned by teams. It also
   rested on a false premise: `teamsService.loadTeamForRosterEdit` refuses both
   `addMember` and `removeMember` when `parentProjectId === null`, and the crew
   team is company-wide, so there was **no** detach path and no other route.
   Refusing would have made the crew team permanently un-removable with the
   only exit being deletion of the company.

6. **Over-matching is deliberate and safe-by-direction.** A third-party agent
   named `Commander` is treated as protected. That is recoverable (rename, then
   delete); the inverse — deleting a real Commander — is not.

7. **A catalog update must not functionally destroy a protected agent.**
   `applyCrewAgentUpdate` deletes every `aoa_agent_triggers` row and re-inserts
   only what the template carries, so a catalog change could drop Steward's
   `sweep`/`role:steward` trigger and silently stop hub curation — the row
   survives while the function dies. Trigger replacement is therefore skipped
   for protected agents. Deliberate trade: a catalog-*added* trigger will never
   reach Commander or Steward through update; Commander is AoA-seeded, while
   Steward's first marketplace install and Phase 4A adoption preserve the
   required sweep trigger.

8. **This is a guardrail, not an authorization boundary, and the code says so.**
   A founder who renames a NULL-origin Steward before uninstalling erases its
   last signal. Closing that with the `sweep`/`role:steward` trigger was
   considered and rejected: the trigger is founder-writable *and* deletable, so
   it adds a signal without closing the hole while making the predicate
   db-aware. Phase 4A closes the historical gap by adopting the catalog origin;
   Phase 4B installs new Stewards with that origin from birth. It never applied
   to Commander.

**Related.** [Decision #111] (company-wide teams), [Decision #112] (marketplace
crew at company creation).

---

## Decision #114 — Agent instruction bundles are founder config, not app code (D22) (2026-07-24)

**This reverses a shipped design.** `services/marketplace-install/crew-updater.ts`
opened with, verbatim:

> `DESIGN DECISION: instruction files are app code, not user config.`
> `replaceExisting: true → ALL files replaced (no preservation of edits).`

That rationale is **withdrawn**. It was internally inconsistent with the rest of
the product: `routes/agents.ts` ships a first-class instructions editor
(`GET/PATCH /agents/:id/instructions-bundle`, `PUT/DELETE
…/instructions-bundle/file`, `PATCH …/instructions-path`) whose entire purpose
is to let a founder edit those files — and a founder editing an AoA agent is
gated to `founder` role specifically because the edit is consequential. Calling
the output of that editor "app code" made every catalog version bump a silent,
unrecoverable deletion (`materializeManagedBundle`'s first act is
`fs.rm(rootPath, { recursive: true, force: true })`), with no diff, no
notification, and no backup. Skills already had the opposite rule
(`company_skills.customized` → `SkillCustomizedError` → notify), so the same
artifact class was governed two different ways for no stated reason.

**Decisions.**

1. **Agent instruction edits are customizations, governed exactly like skill
   edits.** A customized agent routes to **notify** — the ordinary
   `marketplace_pending_updates` row + `updateAvailable` notification — never to
   full replacement. `agentUpdatePolicy: "auto"` is consent to take catalog
   content over *catalog* content; it is not consent to discard the founder's
   own work, which they have no way to recover.

2. **The flag is a column on `agents`: `instructions_customized`, mirroring
   `company_skills.customized`.** Not a `metadata` key — it participates in an
   optimistic-lock `WHERE instructions_customized = false … RETURNING`, the same
   concurrency guard `applySkillUpdate` uses.

3. **It is THREE-state, unlike the skills flag.** `false` = AoA materialized
   this bundle from a catalog template and no edit has been observed since;
   `true` = an edit landed through the instructions API; **`null` = unknown**.
   `null` is treated as `true` (fail closed).

4. **`null` is the honest answer for rows that predate the column, and there is
   no backfill.** Two candidate historical witnesses were investigated and both
   are unsound: `agent_config_revisions` only records a row when
   `changedKeys.length > 0`, and an instruction file write on an
   already-managed bundle leaves `adapterConfig` byte-identical — so the edits
   that matter most are exactly the ones with no revision row. A content hash
   has no pre-existing baseline to compare against, so it cannot answer the
   historical question either. Defaulting the column to `false` would assert
   "untouched" about every pre-existing row, which is the one claim the data
   cannot support and the precise harm this decision exists to prevent.
   **Consequence, accepted:** every crew agent installed before this migration
   routes to notify on its next catalog bump, including untouched ones. Until
   T2.7 lands the agent diff/merge path, `POST /updates/:id/apply` still answers
   501 for `itemType: "agent"`, so those updates sit as pending rows. That is a
   visible, reversible cost; silent data loss is neither.

5. **Detection is an explicit flag set by the edit routes, not a content hash.**
   Chosen because it is the pattern `company_skills` already uses, because it
   costs no filesystem I/O in a pass that walks every crew agent of every
   company at boot, and because a disk-only hash would miss the legacy
   `promptTemplate` pseudo-file, which lives in `adapterConfig` rather than on
   disk. **What it does NOT detect, stated plainly:** an edit made directly on
   the filesystem outside the API (the bundle root is a real directory under the
   founder's home); an edit made before this column existed; and any future
   write path that bypasses these routes. It also *over*-detects: a no-op write
   of byte-identical content marks the agent customized. A false "customized"
   costs one notification; a false "untouched" costs the founder's work.

6. **Three checks, at progressively tighter windows.** Ordering is load-bearing:
   a check inside the transaction would throw *after* the `fs.rm` had already
   deleted the edits.
   (a) A gate on the caller's snapshot, before any fetch. That snapshot comes
   from `checkCrewUpdates`' single **batch SELECT of every crew agent, taken
   before its loop** — so for the k-th agent it is stale by every preceding
   agent's entire apply cycle (template fetch + N file fetches + `fs.rm` +
   writes + transaction), seconds to tens of seconds over a CDN. This gate
   avoids pointless work; it is not the safety boundary.
   (b) A single indexed PK re-read immediately before `materializeManagedBundle`.
   **This is the disk-safety gate.** It reduces the exposed window to the gap
   between that read and the `fs.rm`.
   (c) The transactional `instructions_customized = false` predicate, which
   closes the database half completely.
   The window in (b) is not closed; closing it needs the edit routes and the
   updater to share a lock. Not done, not claimed. And the two post-materialize
   failure states differ and must not be conflated: an ordinary transaction
   error loses no founder work (catalog-vs-catalog inconsistency, next pass
   converges), while a **lost optimistic lock** means the `fs.rm` already ran —
   DB reads `customized = true` at the OLD `templateVersion` while disk holds
   pure catalog content. The founder sees a pending update rather than a silent
   success: the best available outcome, not a good one.

10. **There are FIVE instruction-changing write paths, not four.** The four
   `/agents/:id/instructions*` routes are the obvious set. The fifth is the
   **generic `PATCH /agents/:id`**, whose free-form `adapterConfig` is what the
   shipped Config tab uses to edit `promptTemplate`. It was missed in the first
   implementation, and the miss was a live regression of this very decision: the
   founder's Prompt Template was deleted on the next catalog bump with no
   notification and no revision row. It is gated on
   `INSTRUCTION_BEARING_ADAPTER_CONFIG_KEYS`, derived from what
   `applyBundleConfig` actually destroys — `promptTemplate` and
   `bootstrapPromptTemplate` are DELETED (both founder-editable, both read at
   runtime), and the four `instructions*` bundle keys are OVERWRITTEN.
   `agentsMdPath` is included though not destroyed, because the route already
   treats it as an instruction change for authz. `cwd` is deliberately excluded
   (dominantly a workspace setting; stamping every `cwd` edit would freeze
   agents out of updates), as is `instructions` (no live reader — verified).
   `agent-instructions-service.test.ts` pins the destruction set so the key list
   cannot drift from it silently.

11. **The flag is stamped BEFORE founder content reaches disk.** The three
   bundle routes learn the `adapterConfig` to persist *from* the disk operation,
   so the main write cannot move ahead of it; they issue a separate cheap
   pre-write instead. Writing disk first left a window in which an edited bundle
   existed with `instructions_customized = false` — fail-open, and contrary to
   this decision's own asymmetry. Over-stamping a write that then fails costs one
   spurious notification; under-stamping costs the founder's work.

7. **`applyCrewAgentUpdate` throws `AgentInstructionsCustomizedError` rather
   than silently skipping,** so callers must make an explicit fallback choice.
   `checkCrewUpdates` catches it into the existing notify path.

8. **Composes with, and does not weaken, [Decision #113].** D22 decides
   *whether* `applyCrewAgentUpdate` runs; D23's protected-agent carve-out
   narrows *what* it writes once it does. Both gates are independent and both
   fail closed.

9. **This does not change T2.3b's pointer-only adoption.** Repaired rows carry
   `instructions_customized = null`, so they route to notify — which is correct:
   repair genuinely cannot know whether the legacy bundle it adopted was edited.
   D22 makes content adoption *safe* to build; it does not perform it. Adopting
   content for those rows is T2.7's diff/merge.

**Related.** [Decision #112] (marketplace crew at company creation),
[Decision #113] (protected AoA agents), T2.7 (agent diff/merge).

---

## Decision #115 — Reviewed agent merge: `<file>::<section>`, byte-derived customization, no `fs.rm` (T2.7) (2026-07-24)

Decision #114 (D22) routes a customized — or unknown-provenance — crew agent's
catalog update to **notify**. It did not say what the founder does next, and
there was nothing to do: `POST /updates/:id/apply` answered **501** "use merge",
`POST /updates/:id/merge` answered **404** "not a skill", and
`GET /updates/:id/diff` answered **400** "skill updates only". The Review button
led nowhere, and #114's accepted consequence — *every* crew agent installed
before migration `0182` routes to notify on its next catalog bump, untouched ones
included — meant those rows accumulate with no exit. This decision closes the
loop.

**Decisions.**

1. **An agent's reviewable section is `<file>::<## heading>`.** The skill
   differ's unit, namespaced by the bundle file it came from. File granularity
   was rejected (an all-or-nothing choice on a 400-line `AGENTS.md`), and hunk
   granularity was rejected (a hunk has no stable identity across a rewrite, so
   a founder cannot tell which of their edits a decision covers). The file
   prefix is load-bearing rather than decorative: two files in one bundle may
   both declare `## Tone`, and one shared decision key would silently govern
   both. A file present on only one side is mapped straight to `added` /
   `removed` sections rather than diffed against the empty string, which would
   have labelled a brand-new file's preamble `changed`.

2. **`promptTemplate` and `bootstrapPromptTemplate` are virtual files** —
   `promptTemplate.legacy.md` and `bootstrapPromptTemplate.legacy.md`. They live
   in `adapterConfig`, not on disk, and `applyBundleConfig` **deletes** both when
   a catalog update materializes. The first name is not invented here:
   `agent-instructions.ts` already surfaces `promptTemplate` under exactly that
   path as a `virtual: true, deprecated: true` bundle entry. Upstream never
   carries either, so they surface as `removed` sections defaulting to "mine".
   Excluding them was the alternative and it is wrong in both directions: drop
   them silently and the merge becomes the very harm #114 exists to prevent;
   keep them unconditionally and no merge could ever honestly report that the
   agent holds pure catalog content, so the backlog could never drain.

3. **After a merge, `instructions_customized` is derived from the resulting
   BYTES, not from the founder's clicks.** `false` iff the bundle is
   byte-identical to upstream — same file set, same bytes, same entry file —
   otherwise `true`. Never back to `null`: after a review the divergence is
   known, not unknown. This is the same statement `applyCrewAgentUpdate` already
   makes when it re-asserts `false` after a full replacement, and getting it
   wrong is expensive in both directions: a false `false` re-opens surviving
   founder bytes to a silent overwrite on the next bump, a false `true` freezes a
   provably clean agent out of auto-update forever.

   The byte test is not pedantry. `applyMergeDecisions` *reassembles* a document
   (join the surviving sections with a blank line, trim, add a trailing
   newline), so an all-"accept upstream" merge does not reproduce upstream's
   bytes. Two verbatim shortcuts exist for exactly this: a file whose every
   section resolves upstream is copied from upstream verbatim, and a file whose
   every decision is "mine" is copied from the founder's side verbatim. Without
   the first, `pureUpstream` could never be true. Without the second, "keep
   mine" would rewrite the founder's blank lines and would append a newline to
   their `promptTemplate` on every merge.

   Rebuilding a file from its diff sections was tried and is **unsound**:
   `splitSections` always emits a `__preamble__` section, and for a
   heading-first document that section holds zero lines while its content string
   is empty — indistinguishable from one blank line. Both sides are passed as
   whole-file maps instead.

4. **The merged result is written file-by-file; `materializeManagedBundle` is
   never called.** Its first act is a recursive, forced `fs.rm` of the directory
   holding the founder's edits, outside any transaction — the hazard T2.3b's
   review and #114 both landed on. `writeMergedAgentBundle` is the single named
   function that touches disk and uses the same `agentInstructionsService`
   surface the founder's own editor uses. When every decision is "accept
   upstream" the end state is identical to a replace-everything materialize,
   reached without the rm. Deletions skip the entry file; a skipped deletion is
   reported and forces `pureUpstream` false.

5. **`conflict` is now written, and means something narrower than `pending`.**
   It was read in three places and written in none. `conflict` = the local copy
   is (or may be) divergent, so the update cannot be taken wholesale;
   `pending` = held back only by policy or the update window, one click from
   landing. Reconciliation is bidirectional.

   **`checkCrewUpdates` is the ONLY writer of `itemType: "agent"` rows**, so it
   owns every state transition for them. `upsertPendingUpdate`
   (marketplace-update-checker.ts), which owns the equivalent logic for skills
   and plugins, has no agent caller — `checkCompany` still carries a
   `TODO: Add agent + team template checks`. A first version of this decision
   deferred re-opening to it; that was wrong, and with the unique index on
   (companyId, catalogItemId) `onConflictDoNothing` cannot re-open anything, so
   dismiss was permanent *per agent* rather than per version and an agent that
   ever took an update never announced another one. The agent path therefore
   re-opens `applied`/`dismissed` rows itself, for a strictly newer release only
   (`compareVersions`), mirroring `upsertPendingUpdate`'s rule so the two kinds
   behave the same.

6. **`/apply` handles agents; 501 now means TEAM updates only.** Forcing a
   provably untouched agent through a review it has nothing to review is the
   failure mode on the far side of D22. `/apply` delegates to
   `applyCrewAgentUpdate`, which owns the D22 gate, and answers 409
   `AGENT_INSTRUCTIONS_CUSTOMIZED` for `true`/`null` rows — the shape the skill
   path already used. The **UI offers it for `pending` rows only**: a `conflict`
   row is one whose local copy diverges, so its `/apply` answers 409 by design
   and the card sends it straight to Review. A 409 received anyway (the status
   went stale between render and click) opens the review modal rather than
   surfacing an error. Wiring this also un-stranded the *skill* `/apply`, which
   had been equally unreachable — `UpdateCard` rendered its Update button only
   for plugins.

   **`bundlesAreByteIdentical`, not "every section is `unchanged`", decides what
   the review modal tells the founder.** `computeSectionDiff` classifies a
   section `unchanged` on `.trim()`; the wholesale-upstream relaxation in (3)
   requires byte equality. Reading "identical" off the states therefore reported
   *"No local changes found"* about a trailing-whitespace divergence that then
   merged to `true`. The bulk `Accept all upstream` / `Keep all mine` control
   renders whenever there is any section at all, for the same reason: unchanged
   sections render no per-section buttons, so gating the bar on "has a changed
   section" left an all-`unchanged` review with no control able to resolve it to
   upstream — a permanent freeze-out announced as success.

7. **A merge moves the catalog-owned non-instruction fields too** — `skillKeys`,
   `runtimeConfig.aoa.toolAllowlist`, `templateVersion`, triggers — mirroring
   `applyCrewAgentUpdate`. It must: stamping the new `templateVersion` without
   them leaves a row claiming content it does not have, and `checkCrewUpdates`
   would never look at it again. **Decision #113 (D23) composes unchanged:** a
   protected AoA agent keeps its triggers through a reviewed merge exactly as it
   does through an auto-applied one.

8. **Agent resolution fails closed on ambiguity.** `agents.template_origin` is
   not unique per company while `marketplace_pending_updates` is unique on
   (company, item). Two agents sharing an origin returns 409
   `AMBIGUOUS_AGENT_ORIGIN` rather than writing the merge into whichever row the
   planner returned first.

**Consequence: #114's `null` backlog is now drainable end to end.** Those agents
surface as `conflict`; Review shows either nothing (bundle already matches) or
catalog-vs-catalog changes; `Accept all upstream` (a bulk control added for this
reason, not for convenience — the per-section default of "mine" would otherwise
re-declare them customized on every review) lands upstream verbatim and stamps
`instructions_customized = false`, returning the agent to auto-update
permanently.

**A file the founder declines wholesale is not created.** An upstream-only file
whose every section resolves to "mine" is skipped outright — it appears in
neither the write set nor the delete set, because there is nothing on disk to
delete. Letting it fall through to `applyMergeDecisions` produced a one-newline
phantom file that the agent then read and that showed as the founder's own
content in every later diff.

**A real on-disk file whose name collides with a legacy prompt pseudo-file is
excluded from review in both directions.** `agentInstructionsService.readFile`
short-circuits on `promptTemplate.legacy.md` and returns
`adapterConfig.promptTemplate` rather than the file's bytes, so the merge cannot
see such a file's contents at all — "disk wins" is not implementable here. It is
therefore never written, never deleted, and its `adapterConfig` counterpart is
left out too; the collision is logged with the rename that would bring it under
review, and it **forces `pureUpstream` false**, because unaccounted local content
must never be mistaken for pure catalog content.

**Known gaps, stated rather than hidden.** Files are written before the
transaction: a transaction failure leaves the merged bundle on disk with the row
still on the old `templateVersion`, so the pending update survives and the next
diff shows the merged content as "mine" — recoverable, whereas the reverse order
would silently claim content that is not there. Two concurrent merges of the same
update are serialised by the pending row's `pending`/`conflict` → `applied` claim
and the loser gets 409, but that cannot un-write the files the loser already put
on disk. An upstream entry-file rename is honoured only when the upstream entry
file survives the merge; otherwise the old entry file is kept and `pureUpstream`
is forced false. And the reassembly path (mixed merges only — never the wholesale
ones) inherits two defects from the skill primitives it shares: `\n\n` joins
damage a CRLF document, and `splitSections` is fence-unaware, so a `## ` line
inside a fenced example is independently decidable and carries the closing fence
with it. Both matter more for agents than they ever did for skills, because
AGENTS.md bundles routinely carry fenced examples; fixing them means changing
the shipped skill merge, so they are marked at the call site rather than done
here.

**Related.** [Decision #113] (protected AoA agents — the trigger carve-out this
composes with), [Decision #114] (D22, which this completes), T2.8 (skill-bundle
re-materialization on merge — deliberately left as a separate seam; do NOT unify
it by routing the agent merge through `materializeManagedBundle`).

## Decision #116 - External MCP connectors: transport union, strict isolation, env-indirection secrets (2026-07-23)

**Status:** Implemented. Locked 2026-07-23 and corrected 2026-07-29 to
record the fleet-compatible catalog boundary. Establishes how AoA consumes
EXTERNAL MCP servers. Does not change Decision #93 or #14, which govern AoA as
an inbound MCP *server*; this is the outbound direction and is a separate
concern.

1. **Connector and plugin are distinct product types and distinct CDN
   artifacts.** A **plugin** is code AoA runs (a forked Node worker with UI
   slots, jobs, webhooks). A **connector** is a pointer plus credentials to an
   external MCP server, giving agents tools and nothing else. Deciding rule: if
   it must render UI, run jobs, or receive webhooks inside AoA it is a plugin;
   if it only gives agents tools it is a connector. A plugin MAY additionally
   declare a connector. Connectors are published in `connectors.json`; they are
   never a fifth `catalog.json` item type. Older AoA instances reject an unknown
   catalog item enum and retain their last-known-good catalog, so adding
   `connector` to the four-type union would freeze marketplace updates across
   that fleet. The consumer contract is
   `packages/shared/src/mcp-connector-catalog.ts`, with frozen producer vectors
   and hashes in `docs/contracts/mcp-connectors/v1/`.

2. **Additive types, never a breaking union.** `McpBridgeSpec` keeps its exact stdio shape and continues to describe only AoA's own loopback bridge. External servers use a new `McpServerSpec` discriminated union (`stdio | http`) carried on a new optional `AdapterExecutionContext.mcpServers` map. Rationale: `McpBridgeSpec` is hand-duplicated in five packages by deliberate convention with no cross-boundary compiler enforcement, so a breaking edit risks silent drift.

3. **Strict isolation everywhere.** Every Claude-family agent run passes `--strict-mcp-config`. Previously only heartbeat did; crew and Commander silently inherited the host machine's `~/.claude.json` and project `.mcp.json`. AoA is the sole source of truth for what an agent can reach — required for reproducibility, auditability, and revocation.

4. **Commander receives all active company connectors**, exempt from per-agent opt-in, still under strict mode. Strict governs where the list comes from, not how much Commander gets.

5. **Company-level install, per-agent opt-in.** A connector is registered once per company and reaches an agent run only via an explicit enablement row. Mirrors how `browser_use` gates Playwright. BYO connectors are company-level, never agent-level, so credentials have one rotation and revocation point.

6. **Secrets travel by env indirection.** Config files written to disk contain only `${VAR}` placeholders; real values are injected into the spawned process env. This preserves the existing convention (`packages/adapter-utils/src/types.ts:274-286`) that config/context are persisted into run events and must never carry secrets. All four target CLIs support env substitution. External servers additionally receive a scrubbed env via `buildScrubbedCliEnv` — `DATABASE_URL` and provider keys must never reach a third-party server.

7. **stdio policy is deployment-mode-aware.** `local_trusted` may register stdio connectors (the host is the founder's own machine). `authenticated`/cloud restricts BYO to remote HTTP; stdio is permitted only from verified catalog entries. Regardless of mode: pinned versions, a command allowlist, no shell interpolation, and an audit entry per spawn. Consistent with the D6 divergence pattern.

8. **Governance mirrors the agent-hire rule.** Connector installation requires approval in `authenticated` mode and is auto-approved in `local_trusted`.

9. **AoA brokers OAuth; it does not delegate to the CLI.** Whether a CLI-stored MCP OAuth token keys by server name or URL is undocumented, and headless OAuth callbacks remain an open upstream limitation. Brokering and injecting a token as a static `Authorization` header also gives identical behavior across all four MCP-capable adapters, whereas delegation would be Claude-only. Better Auth's `genericOAuth` plugin is the broker substrate; it requires company-scoping (its `account` table is user-keyed and a user may belong to several companies) and explicit token lifetimes or refresh silently never fires.

   **Implementation correction (2026-08-02):** the broker substrate is a
   discovery-first, provider-policy-pinned AoA implementation, not Better Auth
   `genericOAuth`. Better Auth remains the browser-session identity boundary.
   The custom broker stores company-scoped, explicitly expiring,
   broker-owned signed token bundles and performs its own fenced refresh. This
   correction supersedes only the substrate sentence above; the company
   scoping, explicit token lifetime, broker ownership, and historical record
   remain controlling.

10. **Adapter rollout is phased by writer complexity, not capability.** All four CLIs already support remote HTTP with auth headers; AoA's writers do not. `claude_local` ships first (its writer is raw `JSON.stringify`), then `gemini_local`, `opencode_local`, `codex_local`. The codex TOML stripper targets only `[mcp_servers.X]` and `[mcp_servers.X.env]`, so header support MUST land with a stripper fix or stale credentials accumulate across runs.

**Deferred:** bulk registry import; flagship plugin track and the OAuth broker
itself; connector tool-call audit logging (deferred until all adapters land so
the event shape covers them); tool-count budgeting.

**Key files:** `packages/shared/src/mcp-connector-catalog.ts`,
`packages/adapter-utils/src/types.ts`,
`server/src/services/mcp-connector-catalog.ts`,
`server/src/services/mcp-connectors-loader.ts`,
`server/src/services/internal-agent/cli-mode.ts`,
`server/src/services/heartbeat-mcp.ts`,
`server/src/services/internal-agent/aoa-agents/runner.ts`,
`server/src/services/cli-spawn-safety.ts`,
`packages/db/src/schema/company_mcp_connectors.ts`. Plan:
`docs/aoa/plans/2026-07-23-mcp-connectors-foundation-byo.md`.

## Decision #117 — Execution-target registry, hardened gVisor sandbox, route-by-credential, per-org concurrency clamp (multi-tenant cloud Phase 5, 2026-07-30)

**Status:** Locked 2026-07-30 (implemented, see Plan). Depends on Phase 1 (`organizations` / `organization_id`, merged first) and Phase 4 (unified provider-credential resolver, merged first). Self-hosted single-tenant is unchanged — every mechanism below is opt-in / default-off and falls back to the pre-Phase-5 local driver when unconfigured.

1. **`execution_targets` is a new tenant-scoped fleet-inventory table**, distinct from the company-scoped `environments` table (which gains a nullable `execution_target_id` FK; `null` = route by credential). `organization_id` is a real nullable FK to `organizations.id` (`ON DELETE CASCADE`) — nullable rows (`organization_id = NULL`) are system/shared targets: the pooled gVisor row and the seeded `control-plane` row. The FK is `ON DELETE CASCADE`, not `SET NULL`: `NULL organization_id` is the security-defining 'system/shared, operator-trusted' signal, so `SET NULL` would silently promote a deleted tenant's dedicated targets into trusted shared infra — cascading them away is the only safe behavior (see `packages/db/src/schema/execution_targets.ts` and migration 0196). Uniqueness is `(organization_id, slug)` with `NULLS NOT DISTINCT` (mirrors `provider_quota_windows`) so the boot seed is idempotent across restarts instead of duplicating a NULL-org row every time. `ensureControlPlaneExecutionTarget` seeds the `control-plane` row (`kind = local_host`, `trust_class = local_trusted`) at boot, keystoning back-compat for every existing self-hosted install that already sets `AOA_EXECUTION_TARGET_ID=control-plane`.

2. **gVisor is a hardened profile layered onto the existing `sandbox-docker` transport, not a new transport.** `buildDockerRunArgs` (`packages/adapter-utils/src/execution-target.ts`) gained an opt-in, default-off `runtime`/`isolation` profile: `--runtime=runsc`, `--user`, `--cap-drop=ALL`, `--read-only`, `--tmpfs`, `--memory`/`--memory-swap`, `--cpus`, `--pids-limit`, `--security-opt no-new-privileges`(+ optional `seccomp=`), `--ulimit nofile=`, `--ipc private`. Leaving `runtime`/`isolation` unset reproduces the exact pre-Phase-5 arg list byte-for-byte (locked by an exact-array regression test) — a self-hosted `sandbox-docker` environment is unaffected. `resolveGvisorSandboxTarget` (`server/src/services/environment-runtime.ts`) maps a `driver: "sandbox", config.provider: "gvisor"` environment to this hardened profile with sane defaults (`user 1000:1000`, `capDropAll`/`noNewPrivileges`/`readOnlyRootfs` on, `2g`/`2 cpus`/`512 pids`, `network: "none"`); a `createGvisorSandboxRuntimeProvider` (`server/src/services/gvisor-sandbox-provider.ts`) registers the pool-transport seam (peer to the existing E2B provider) for a future multi-worker pool client — the single-box beta runs the hardened `sandbox-docker` path directly, no pool client is implemented yet.

**2026-08-02 fail-closed clarification:** direct `sandbox-docker`/`runsc` execution remains available only to self-hosted single-tenant installs. On shared `cloud_auth` infrastructure, pooled and dedicated targets are registry-only and fail closed before adapter execution until the worker pool exists and Gate-B hardware validation passes. The control-plane host is not a tenant worker.

This clarification supersedes the earlier “single-box beta” wording below for
hosted deployments. A tenant-authored `runtime: "runsc"` value is configuration,
not worker-plane provenance: the cloud guard refuses every local Docker-family
target unless the explicit process-wide unsafe override is enabled. The sink also
forces `network: none`, removal, and fixed resource ceilings as defense in depth.
Organization capacity is claimed atomically under a transaction advisory lock and
completion dispatches the oldest queued work across the Organization; an unresolved
Company-to-Organization edge fails closed in `cloud_auth` instead of bypassing the cap.
The same refusal applies before workspace provision/cleanup/jobs and local runtime
services, including archive and startup paths; guarding only the final adapter
process is insufficient because these commands are independently tenant-authored.
At startup, persisted local runtime-service PIDs are matched against their OS
start identity before process-group termination and are reconciled before desired
services can restart. A live PID that cannot be verified or confirmed dead blocks
`cloud_auth` boot and remains tracked for operator remediation; PID reuse is never
handled with a blind kill. Generic project-workspace metadata may not write the
server-reserved `runtimeConfig` auto-start envelope.

3. **SSRF fix: `--add-host host.docker.internal:host-gateway` becomes conditional.** It was previously emitted unconditionally by every `sandbox-docker` run, which is a route from any sandboxed container straight to the control-plane host. It is now emitted only when the callback bridge is actually running **and** the target explicitly opts in via `allowHostGateway` (default `false`). This ships in this PR for every `sandbox-docker` run, not only gVisor — closing an existing SSRF-adjacent route in the pre-Phase-5 code, not something newly introduced by gVisor.

4. **Route-by-credential: `execution-target-resolver.ts` replaces the old hard-throw** that previously rejected any run needing a dedicated target it couldn't resolve. `chooseExecutionTargetRow` reads the Phase 4 credential-resolution seam `{ credentialKind, executionTargetSlug }` verbatim (it does not re-query `provider_credentials`): a `company_api_key` (business key) run routes to the org's `pooled_gvisor` target (or falls back to the local driver if no pooled target is configured — this local fallback also occurs on SHARED infra when the org has no pooled target, not only self-hosted; the D1 guard `assertUnsandboxedMultitenantAllowed` (`server/src/services/unsandboxed-multitenant-guard.ts`) now EXISTS and FAILS CLOSED on this: on `cloud_auth` it refuses the local (and non-`runsc` docker) fallback unless `AOA_ALLOW_UNSANDBOXED_MULTITENANT=1`, so a shared-infra `company_api_key` run no longer silently runs locally — it is no longer merely tracked); a `personal_subscription` run routes to the specific `dedicated_worker` (or `local_host`) target whose slug matches the credential's bound `AOA_EXECUTION_TARGET_ID`, and **fails closed** (throws) if no matching target is active — a personal-subscription run never silently falls back to a different tenant's dedicated worker or the shared pool. An explicit `environments.execution_target_id` pin always wins over credential-kind routing, and is itself checked against a personal-subscription's bound slug before being honored.

5. **Per-organization concurrency clamp layers on top of the existing per-agent clamp**, not instead of it — `orgAvailableSlots`/`normalizeOrgConcurrencyCap` (`server/src/services/org-concurrency.ts`) gate `startNextQueuedRunForAgent` on `min(perAgentSlots, perOrgSlots)`. `ORG_MAX_CONCURRENT_RUNS_DEFAULT = 8`, `ORG_MAX_CONCURRENT_RUNS_MAX = 200` (mirrors the D5 per-agent pattern in spirit, independent constants — do not conflate with `HEARTBEAT_MAX_CONCURRENT_RUNS_*`). A company with no `organization_id` (should not occur once Phase 1 backfills it, but defensively) stays unclamped by the org gate — only the per-agent clamp applies, so self-hosted/local behavior is unchanged either way.

6. **Egress posture — stated plainly, not oversold.** `--network none` is the default and only *safe* posture the app layer guarantees. A pooled run that needs the provider API must run on a **filtered** `bridge`; filtering is a **worker-image** responsibility (a `DOCKER-USER` iptables/nftables policy or egress proxy denying RFC1918, `169.254.0.0/16` incl. the `169.254.169.254` cloud-metadata address, and the control-plane CIDR, allowing only provider API hosts + package registries) — **the app layer does not and will not filter egress**. The conditional `--add-host` fix (#3 above) removes one SSRF route; it is not egress filtering and does not by itself make `bridge` safe. **This firewall has not been validated on real hardware as of this decision.** Task 0's `runsc` + firewall validation spike (`docs/aoa/guides/gvisor-worker-image.md`) is a **pending Gate-B deployment step, not run during this PR** — the guide is a specification with an explicit "SPEC ONLY — NOT YET VALIDATED ON HARDWARE" banner and four UNRUN checkpoints (A: runsc present without nested virt; B: pinned `claude`/`codex` CLIs survive under `runsc`; C: the hardened flag set doesn't starve Node; D: the filtered `bridge` reaches the provider API but not metadata/RFC1918/control-plane). **A cloud pool on `bridge` is unshippable until checkpoint D passes on a real worker.**

**Self-hosted single-tenant is unchanged.** No self-hosted install populates `execution_targets` beyond the auto-seeded `control-plane` row; `resolveExecutionTargetForRun` falls back to the pre-Phase-5 local driver whenever no pool/dedicated target is configured; `runtime`/`isolation` default to unset so `buildDockerRunArgs` reproduces the exact legacy arg list.

**Deferred:** the real multi-worker `GvisorPoolClient` implementation + worker-token rotation (Task 13 ships a rotatable per-target credential — a SHA-256 `worker_token_hash`, migration 0194; the plaintext is returned once at registration and the row id is no longer a bearer credential). The multi-worker `GvisorPoolClient` that consumes it remains deferred; the Task 0 hardware spike itself (Gate-B, pending); generalizing the egress firewall beyond the documented iptables/nftables sketch to a maintained, tested artifact.

**Key files:** `packages/db/src/schema/execution_targets.ts`, `packages/adapter-utils/src/execution-target.ts`, `packages/adapter-utils/src/types.ts`, `server/src/services/environment-runtime.ts`, `server/src/services/gvisor-sandbox-provider.ts`, `server/src/services/execution-target-resolver.ts`, `server/src/services/heartbeat-execution-target.ts`, `server/src/services/org-concurrency.ts`, `server/src/services/org-spend.ts`, `server/src/services/execution-targets.ts`, `server/src/routes/execution-targets.ts`, `server/src/routes/org-spend.ts`, `ui/src/components/settings/sections/EnvironmentsSection.tsx`, `ui/src/components/settings/sections/environment-target-form.ts`. Plan: `docs/aoa/plans/2026-07-29-aoa-mt-phase5-execution-gvisor.md`. Guide: `docs/aoa/guides/gvisor-worker-image.md`.

## Decision #118 — Memory read-visibility tiers: identity = agents + team-lead+, company = all internal members but not external MCP keys (2026-08-05)

**Status:** Locked 2026-08-05 (implemented on `claude/memory-enterprise-build`, PR #318). Reconciles the two memory-RBAC read gates surfaced by the adversarial security review of the enterprise-memory merge.

**Problem.** The enterprise-memory work added a second read gate (`memory-access.ts` `canActorSee` / `memory-access-sql.ts` `memoryAccessConditions`, guarding ORG-agent + CREW + external-MCP + MCP-board reads) alongside the pre-existing Commander gate (`memory-policy.ts` `canSeeDurableMemory`). The new gate admitted `layer='identity'` and `visibility='company'` rows to EVERY actor, which (a) contradicted the Commander gate (identity = team-lead+ for humans), (b) contradicted the "humans unchanged" intent of the actor-aware fix, and (c) silently let team_member humans and external MCP keys read company identity that the deleted `filterMemoryForScope` had excluded.

**Decision (read tiers).**
- **`identity`** → **agents** (grounding — an agent that cannot read the company vision cannot ground its work) + **founder / team_lead** humans (+ the `commander` actor kind). NOT team_member humans, NOT external MCP keys.
- **`visibility='company'`** → every INTERNAL member (agents + founder/team_lead + team_member humans). NOT external MCP keys.
- **`domain` / `active_context` / `working`** → scope-matched: a row's `departmentId`/`projectId`, its goal's project (via `project_goals`), or its task's project (via `issues.projectId`) must intersect the actor's assigned `projects.id` set.
- **Private** (owner-typed `user`/`agent`, or `agentId` set) → owner-only (agent sees its own; human sees its own user-private; founder never sees others' private — break-glass is a separate P4 path).
- **Invalidated** (`invalidatedAt` set) → nobody. **Founder** sees every non-private, non-invalidated row.

**External-key distinction.** `actorForMcp` marks a bearer-token caller (`source='mcp'`) as `{ kind: 'team_member', external: true }`; a board/user human (`source='board'`) leaves `external` unset. The gate excludes `external` team_members from identity + company, so an external key sees only its explicitly-scoped memory + its own (typically empty) private set — third-party integrations do not receive company grounding by default.

**Reconciliation.** `memory-policy.ts` already gated identity to `agent || team_lead+`; it now also recognizes `visibility='company'` → all members, so both gates agree. The remaining `company`-vs-`shared` visibility-vocabulary split between the two modules is a tracked consolidation follow-up, not a behavior gap (both are fail-closed for non-identity layers).

**Do NOT** re-broaden identity/company to team_member humans or external MCP keys without a successor decision — the founder is the identity-layer gatekeeper (Decisions #15, #6, Rule #6). Company-wide *employee* readability of identity (Model B — readable by all members, gated from external keys, with a separate confidential tier so founders don't silently leak) was considered and deferred as a larger change.

**Key files:** `server/src/services/memory-access.ts` (`canActorSee`, `MemoryActor.external`), `server/src/services/memory-access-sql.ts` (`actorForMcp`, `memoryAccessConditions`), `server/src/services/internal-agent/memory-policy.ts` (`canSeeDurableMemory`). Tests: `memory-access.test.ts`, `memory-actor-resolver.test.ts`, `memory-rbac-leakage.integration.test.ts` (tier case).

## Decision #119 — Fully-unscoped memory is ambient company-level (internal members + agents see it; not external keys) (2026-08-05)

**Status:** Locked 2026-08-05 (PR #318). Follow-up to Decision #118, surfaced by the first Linux CI run of the enterprise-memory branch.

**Problem.** The P1 RBAC gate + run-path scope filter both require a memory row to match a scope (dept/project/goal/task) to be visible to a scoped actor. But a large class of memory — notably **discussion-extracted memory** (`thread-scope-versions.ts` `buildMemoryCandidateCreateInput` sets `departmentId` from `payload.departmentId ?? null`) — is created **fully unscoped** (all scope columns NULL, `visibility='scoped'`). Under the P1 gate this became **founder-only**, so ORG/crew agents stopped retrieving discussion memory (the pre-existing `full-discussion-to-workspace-cycle.spec.ts` e2e caught it). Before #318 the ungated retrieval showed it to any agent.

**Decision.** Memory with **no scope of any kind** (`departmentId`/`projectId`/`goalId`/`taskId` all NULL), non-private, non-identity, is **ambient company-level** knowledge: visible to every INTERNAL member (agents + founder/team_lead + team_member humans), **NOT external MCP keys** (mirrors #118's `visibility='company'` tier). It is NOT identity — identity stays team-lead+/agents (#118).

**Three consistent touches:**
1. `memory-access.ts` `canActorSee`: fully-unscoped non-private non-identity row → `!isExternalKey`. (Identity is handled by the earlier sequential `layer === 'identity'` check, so it never reaches this branch.)
2. `memory-access-sql.ts` `memoryAccessConditions`: adds a fully-unscoped OR-branch, **guarded with `layer IS DISTINCT FROM 'identity'`** — the SQL gate is an OR (unlike canActorSee's sequential check), so without the guard a team_member would see identity here, re-opening #118.
3. `memory.ts` `searchMultiPath` scope block: run-path `departmentId`/`projectId`/`goalId` filters become `= scope OR IS NULL`, so a scoped retrieval (ORG heartbeat / crew bundle / `query_memory`) never *excludes* company-wide/unscoped memory — company memory is relevant to every scope.

**Follow-up (not this PR):** stamp discussion-extracted memory with its thread's department at creation, so it's properly dept-scoped rather than relying on the ambient tier. Tracked.

**Key files/tests:** the three files above; `memory-access.test.ts` (unscoped tier + identity guard), `memory-rbac-leakage.integration.test.ts` (real-pg unscoped case + scope-filter check + identity guard).

## Decision #120 — Commander runs in a warm per-conversation E2B sandbox on cloud_auth (2026-08-07)

**Status:** Locked (2026-08-07). Part of the E2B cloud-execution-isolation follow-up. Supersedes the parent E2B spec's U4-Commander "ephemeral like org/crew" line item.

- **Broker-actor + Commander run-JWT (D-A):** on `cloud_auth`, Commander reaches the control plane only through the MCP broker, authenticated by a per-turn `kind:"commander"` run-JWT (`createCommanderRunJwt`, HS256, ~10 min TTL via `AOA_COMMANDER_JWT_TTL_SECONDS`, company-bound). `resolveCommanderBrokerToolContext` (`mcp/broker-tool-context.ts`) builds the tool context with **NO agents-row lookup** and NO `kind ∈ {aoa,org}` gate (Commander has no agents row); the auth middleware has a commander branch (`type:"commander"` actor); the broker enforces `jwt.company_id === :companyId` via `assertCompanyAccess`'s commander branch. The agent resolver's `kind ∈ {aoa,org}` fail-closed (`broker-tool-context.ts:181-188`) is byte-identical and untouched (regression-locked by `commander-broker-fail-closed.test.ts`).
- **Third D1 run sink (D-A cont.):** Commander is now the **third** run sink passing a resolved `provider-sandbox` execution target into the D1 guard (`assertUnsandboxedMultitenantAllowed`), alongside org (`heartbeat.ts`) + crew (`aoa-agents/runner.ts` via `resolveGuardedAdapterExecutionContext`). The guard stays a closed refuse-enumeration and permits the resolved E2B target for the `"Commander"` sink exactly as for `"org agent"`/`"crew agent"`; a `null`/`local` Commander target (acquire failed) still fails closed on cloud (Commander SSE error, never a silent host spawn). The guard/cloud-policy remain extensible for a future `remote-tenant-runner` (`RESERVED_TENANT_RUNNER_DRIVER`, Scenario 2 — not enabled in v1).
- **Streaming (D-C):** additive `onStdout`/`onStderr` from cli-mode → driver → provider `execute`; the buffered result is still returned and is the source of truth for the parsed outcome + cost accounting. Brings the E2B provider-sandbox path to docker live-log parity — the buffered bytes equal the streamed bytes (`org-crew-streaming-regression.test.ts`), so org/crew outcomes are byte-identical.
- **Warm per-conversation lease (D-D):** `environment_leases.commander_conversation_id`; the `warmCommanderConversations` instance toggle (default `true` on cloud). The idle reaper (`warmSandboxIdleTtlMinutes`, default 30) + per-company cap bound the new per-user idle-VM cost surface. `false` = ephemeral-per-turn.
- **Session model = warm VM + spawn-per-turn + context replay (D-E):** no persistent suspended CLI; each turn spawns fresh in the warm VM; codex `resume` continuity via `~/.codex` on the warm disk.
- **Credential taxonomy (spec §4 caveat a / §9):** the U5 env allowlist (`buildSandboxEnvAllowlist`, keyed on the **model provider family**, not the E2B infra id) strips every host secret (`DATABASE_URL`, `AOA_AGENT_JWT_SECRET` — the key that mints the run-JWT — `GITHUB_PAT`, …) while the company's own model key + the minted run-JWT (`AOA_API_KEY`) survive (`commander-sandbox-env-allowlist.test.ts`; F4 wrong-provider regression locked). Blast radius = that ONE company's own data/keys — intra-company defense-in-depth, not a tenant breach.
- **Self-hosted / local_trusted Commander is byte-identical** (host-direct spawn; D1 guard is a no-op; in-process approval gate). Commander does NOT use `ask_founder`/`ask_human` — the agent-only gate excludes the commander actor by construction; the non-blocking ⚡CONFIRM runtime-approval marker over the broker is Commander's sole human-in-the-loop path.

**Key files/tests:** `mcp/broker-tool-context.ts`, `agent-auth-jwt.ts`, `services/internal-agent/commander-sandbox.ts`, `services/internal-agent/cli-mode.ts`, `services/unsandboxed-multitenant-guard.ts`, `services/cloud-environment-policy.ts`, `services/environment-run-orchestrator.ts`; `commander-broker-fail-closed.test.ts`, `commander-guard-extensibility.test.ts`, `org-crew-streaming-regression.test.ts`, `broker-stdio-parity.test.ts`, `commander-sandbox-env-allowlist.test.ts`, `commander-broker-parity.test.ts`. Deployment matrix + credential taxonomy: `docs/deploy/deployment-modes.md`; env var: `docs/deploy/environment-variables.md` (`AOA_COMMANDER_JWT_TTL_SECONDS`).

## Decision #121 — Cloud control plane uses a fenced outbound worker protocol with distinct batch, browser-session, and service lifecycles (2026-08-08)

**Status:** Locked for the re-platform program. Implementation is phased and default-off.

AoA retains its product/domain model but moves hosted execution behind a separately deployable worker protocol. PostgreSQL remains authoritative for policy and execution state. Workers lease work outbound and may mutate the control plane only through an active attempt/lease fence. `batch`, `browser_session`, and `service` are distinct workload classes; a service is desired state plus reconciled instances, not an infinitely renewed batch job.

The canonical lifecycle status sets, allowed transitions, cancellation behavior, and lease-loss rules are in [`distributed-execution-lifecycles.md`](distributed-execution-lifecycles.md) and its machine-readable peer `distributed-execution-lifecycles.json`.

Authority, synchronization, single-writer cutover, and late-result quarantine are locked in [`distributed-execution-authority.md`](distributed-execution-authority.md). No desktop or worker database is a peer replica of the hosted control plane.

The trust boundaries, the **required** controls, verification gates, and residual release exclusions are locked in [`distributed-execution-threat-model.md`](distributed-execution-threat-model.md). ★ That record locks a **charter, not a report**: locking a control does not establish that it exists. Every crossing has now been audited for delivery, and as of 2026-09-08 the tally is **1 `delivered`, 25 `partial`, 4 `not-delivered`, 0 `unaudited`** — read that record's head before treating any control named here as in force.

The custodian roles, one-ticket/branch/worktree rule, testing cadence, phased rollout/rollback order, isolation invariants, executable hard-negative controls, and reproducible authoritative build are locked in [`distributed-execution-delivery-policy.md`](distributed-execution-delivery-policy.md), which links the threat model and [`../replatform/test-gates.md`](../replatform/test-gates.md).

The six frozen execution-source kinds (`task_run`, `commander_turn`, `crew_run`, `one_shot`, `browser_request`, `service_reconcile`), their opaque requester/executor principals, and their legacy parity matrix — checkout/assignment, capacity claim/release/wakeup, product/runtime approval, budget, audit, cost, output/run-summary, completion/cancel/retry — are frozen in [`distributed-execution-legacy-parity.json`](distributed-execution-legacy-parity.json). Only `task_run` carries `runId`/`issueId`; no execution source may be admitted against a sentinel Organization. The current-main migration inventory that owns the bridge, cutover, drain, rollback, and hard-negative evidence for every existing execution sink — including the post-PR #320 migration-0188 snapshot/marker seam — is [`../replatform/current-main-crosswalk.md`](../replatform/current-main-crosswalk.md); it is an observed inventory, not a new authority.

This decision extends Decision #117 by treating its target registry, route-by-credential policy, and provider seams as migration inputs to one authoritative placement and fenced worker protocol. Once FND-005 lands, it supersedes Decision #117 only where that decision permits `AOA_ALLOW_UNSANDBOXED_MULTITENANT` in `cloud_auth`: hosted startup must reject that escape hatch, and it is never a distributed fallback. It does not make the deferred gVisor pool implemented.

Decision #120 remains authoritative for current Commander warm-E2B behavior until MIG-005 completes its shadow, drain, cutover, and rollback contract; this decision neither silently disables nor dual-runs that path. Decision #103 remains authoritative for plugins: `cloud_auth` executes no host-resident plugin worker unless a later locked decision supplies a separately isolated plugin-worker architecture and its release evidence.

## Decision #122 — C14 hand-append also covers idempotent RLS/role/GRANT/FORCE security DDL that drizzle-kit cannot emit (2026-08-09)

**Status:** Locked 2026-08-09 (re-platform Epic E2 / TEN-002; operator = Migration + Security Gate Owner); **amended 2026-09-01** (BLOCKER E-1 / Unit 1.6 — see the amendment at the end of this decision). Amends Decision #19 (Drizzle-only) and the C14 narrow exception in `CLAUDE.md` Rule #1 / `AGENTS.md` §6. Promoted from re-platform epic decision **E2-D01** (`docs/replatform/epics/E2-tenant-kernel/decisions.md`).

**Context.** E2 enforces DB-level tenant isolation on the new distributed job/worker/service/lease tables via a non-owner role + forced RLS. The required DDL — `CREATE ROLE … NOLOGIN NOSUPERUSER NOBYPASSRLS`, `GRANT`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and `CREATE POLICY … USING/WITH CHECK (… = current_setting('aoa.organization_id', true)::uuid)` — is **provably not emittable** by the pinned `drizzle-kit@0.31.10` under this repo's config (no `entities.roles`, no `pgPolicy` in schema; `FORCE`/`GRANT`/`LOGIN`-role are absent from the generator entirely). The C14 exception as previously written blessed hand-appended SQL only for idempotency guards and data backfills (exemplars `0189`, `0195`).

**Decision.** The C14 exception is extended to also permit **hand-authored idempotent RLS/role/GRANT/FORCE-RLS/CREATE-POLICY security DDL** that `drizzle-kit generate` cannot emit, subject to all of:
1. Tenant **tables, columns, indexes, and foreign keys** are still authored in `packages/db/src/schema/*.ts` and emitted by `pnpm db:generate` — schema DDL is never hand-authored (Rule #1 unchanged).
2. The security DDL lives in a drizzle **`--custom`** (delta-free) migration created by `drizzle-kit generate --custom`, applied through the standard `applyPendingMigrations` path (uniform in tests/dev/runtime), never a runtime `sql.unsafe` bootstrap for the primary path.
3. Every statement is **idempotent** using the established idioms (`IF NOT EXISTS`, `DROP … IF EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object/duplicate_table THEN NULL … END $$;`) and carries an inline comment stating what it does, that it is hand-authored because drizzle-kit cannot emit it, and why it is idempotent.
4. Role names are validated (`assertSafeRoleName`), and no role credential (`LOGIN PASSWORD`) is committed — the role is created `NOLOGIN` and its login credential is provisioned separately from an env/secret at deploy/boot time.

**Consequences.** RLS enforcement is versioned/ordered/auditable in the migration ledger like all other DDL, with one apply path. `db:push` remains absent. This does not authorize hand-authoring any DDL drizzle-kit *can* emit. `CLAUDE.md` Rule #1 and `AGENTS.md` §6 prose carry this cross-reference when TEN-002 lands.

### Amendment (2026-09-01) — the class also covers `CREATE FUNCTION` and its ACL

**Status:** Locked 2026-09-01 (BLOCKER E-1 / Unit 1.6, PR #333). Extends the enumerated DDL class
above. Conditions 1-4 are unchanged and still apply in full.

**Context.** The CLI-006 canary preflight runs on the non-owner `aoa_app` pool and holds ZERO
privileges on `environment_leases`, `environments`, `runtime_provider_keys` and
`company_secret_versions`. Every read raised 42501 and the gate answered `preflight_error` — an
unreadability refusal indistinguishable from a policy decision. A table grant is not available:
`company_secret_versions.material` is AES-256-GCM secret material and `environment_leases.metadata`
is secret-bearing at rest, and a bare `GRANT` is ACL drift, which `assertExactServingRoleAuthority`
treats as a fatal boot error. The remedy is an owner-owned `SECURITY DEFINER` function that narrows
both the projection and the predicate — which requires `CREATE FUNCTION`, an object kind the
enumeration above does not name (and the first in 266 migrations).

`CREATE FUNCTION` is **provably not emittable** by the pinned generator, on the same footing as the
DDL already covered: `drizzle-orm`'s `pg-core` exposes no function/routine/procedure primitive at
any level (zero exports matching `/[Ff]unction|[Rr]outine|[Pp]roc/`), so there is nothing for
`drizzle-kit generate` to diff or emit.

**Decision.** The C14 class is extended to permit hand-authored, idempotent
`CREATE OR REPLACE FUNCTION` plus its `REVOKE`/`GRANT`, subject to conditions 1-4 above **and**,
for any function declared `SECURITY DEFINER`, all of:

5. The function is listed in `server/src/db/security-definer-manifest.ts`, with a written rationale,
   the exact roles that may `EXECUTE` it, and the relations whose authority it borrows. A definer
   function runs with the OWNER's authority regardless of caller, so it is the entire
   privilege-escalation surface the table/column/sequence scans cannot see — before this amendment
   there was not one `prosecdef` reference in the repository.
6. The certificate runs at boot and **drift is fatal**, in two arms with deliberately different
   reach:
   - **`assertManifestedSecurityDefinerFunctions` — EVERY boot, flag on or off**
     (`server/src/index.ts`). Every manifested function must exist with exactly its pinned owner,
     `EXECUTE` grantees, execution config and body, and must not be `LEAKPROOF`; a serving-role
     owner, an owner that is not the owner of its declared authority relations, or a NULL `proacl`
     (PostgreSQL's default grants `EXECUTE` to `PUBLIC`) each abort startup. This arm is
     unconditional because the function is created by a migration that runs on every deployment and a
     serving role keeps `EXECUTE` on it regardless of the flag — and a box that was once flag-on keeps
     that role's LOGIN credential, since `maybeProvisionDistributedExecutionRoles` is a strict no-op
     when the flag is off and never restores `NOLOGIN`.

     **Amended 2026-09-01 (Unit 1.7, migration 0267).** That grantee is now `aoa_operator`, not
     `aoa_app`. 0266 granted `EXECUTE` to `aoa_app`, which made an owner-authority read reachable from
     the pool that serves tenant HTTP requests, the outbox worker, the admission bridge and the
     live-event log. 0267 revokes it there and grants `aoa_operator` only. The justification above is
     unchanged in shape — a serving role still holds `EXECUTE` on every deployment and keeps its LOGIN
     — only the role differs. Note this is a **widening for `aoa_operator`**, which previously held no
     grant on `companies` or `organizations` at all; the capability moved rather than shrank.
   - **`assertNoUnmanifestedSecurityDefinerFunctions` — the flag-on serving-role path only.** It
     asserts a property of the WHOLE database, which holds on a controlled distributed-execution
     fleet (where `assertExactServingRoleAuthority` already fails boot on any unexpected schema) but
     not on `external-postgres` against an operator-owned database, where a vendor or extension
     definer function in another schema is legitimate and unknowable to us. Making it unconditional
     would convert those deployments into hard boot failures. **This is a stated residual:** on a
     flag-off deployment a NEW unmanifested definer function is not detected at boot.

   Discovery is keyed on `pg_proc.prosecdef`, never on effective `EXECUTE` — `CREATE EXTENSION
   vector` has no `SCHEMA` clause and installs ~100 `public` functions carrying the default
   `PUBLIC EXECUTE`, so an EXECUTE-keyed certificate would fail boot on every pgvector fleet.
7. The body pins `SET search_path = ''` and schema-qualifies every relation, so a caller's
   `search_path` cannot redirect it; and it is scoped to the caller-supplied tenant on every branch.

   **★ Corrected 2026-09-01 (Unit 1.7): that tenant scoping is DEFENCE IN DEPTH, not the boundary,
   and the earlier wording here — "so an owner-authority function cannot become a cross-tenant
   existence oracle" — was wrong.** The tenant parameter is supplied by the caller and compared only
   to itself, so passing a victim's id satisfies it trivially; `companies` carries no row-level
   security, so a caller need not even guess the id. This was reproduced against real PostgreSQL, not
   argued. **The boundary is the `EXECUTE` grantee** — the one thing a caller cannot forge is the role
   it connects as. Any future definer function must be justified on its grantee first, and may cite a
   tenant predicate only as a second layer. **This is enforced,
   not merely required:** the certificate pins `pg_proc.proconfig` and a SHA-256 fingerprint of the
   body, and rejects `LEAKPROOF`. `CREATE OR REPLACE FUNCTION` preserves the owner and the ACL, so
   without those pins a replacement that drops the `search_path` clause or a tenant predicate would
   satisfy every identity/owner/ACL assertion — a stated guarantee with no mechanism behind it. The
   fingerprint is taken over the body with carriage returns stripped, because
   `packages/db/src/migrations/` carries no `eol=lf` pin and a raw hash would pin one platform and
   fail boot on the other. Changing the body of a definer function is therefore a deliberate,
   reviewed manifest edit.

**Consequences.** Migration `0267_canary_preflight_evidence_org_scope.sql` is the compliant
exemplar under this amendment: delta-free `--custom`, every statement carrying its own inline
comment, three manifested functions certified at boot, and `EXECUTE` granted to `aoa_operator`
only.

**★ `0266_canary_preflight_evidence_fn.sql` is NOT an exemplar, and an earlier revision of this
amendment wrongly said it was.** It fails two of the conditions above: its two `CREATE FUNCTION`
statements carry no per-statement comment (condition 3), and neither of its function identities is
in the manifest, because `0267` drops both (condition 5). It also granted `EXECUTE` to `aoa_app` —
the arrangement the ★ correction above retracts. It remains in the ledger unchanged because a
shipped migration is history, not a template; cite `0267`.

foreign keys are never hand-authored.** This does not authorize hand-authoring any DDL drizzle-kit
*can* emit, and it does not authorize a definer function that is not manifested and certified —
conditions 5-7 are what make the extension narrower than "functions are now allowed".

## Decision #123 — Distributed execution uses bounded tenant-serving and platform-operator database roles (2026-08-10)

**Status:** Locked 2026-08-10 (operator-approved option B; corrective successor to E2-D03). Implementation revision `920e55de5a6557577bed9d228e9a00c4d49beadc` awaits the distinct prerequisite reviewer.

**Decision.** `aoa_app` is the non-owner tenant-serving role for every E3 `runInTenant` transaction. Under the distributed-execution flag it has the eight E2 new-path grants plus only the legacy table privileges proven necessary by the traced JOB-010–014 engine calls. Legacy Company isolation remains enforced by existing application checks under CAV-005; this decision adds no legacy Company-table RLS retrofit.

A distinct NOSUPERUSER/NOBYPASSRLS `aoa_operator` role and fail-closed database connection own the null-Organization platform target/worker metadata seam. On current tables it may access only the exact null-Org metadata needed to establish that seam; it receives no access to jobs, attempts, leases, events, artifacts, secrets, or tenant worker/target rows. Future E3 enrollment-route/proof/revocation grants remain owned by JOB-002.

Privileged owner database access remains migration/bootstrap-only for this path. No owner fallback is allowed when the distributed flag is on. When `AOA_DISTRIBUTED_EXECUTION_ENABLED=false`, no new serving/operator pool is required and the current legacy execution path remains authoritative. When true, both explicit non-owner URLs are required and missing/invalid credentials, an unexpected authenticated role, privileged role attributes, or a failed connection aborts startup before E3 routes/work can start.

`runInTenant(appDb, organizationId, fn(repos))` remains the mandatory tenant transaction boundary; no unscoped tenant repository is added. Migration `0213_e2_serving_role_correction.sql` is a delta-free drizzle `--custom` migration under Decision #122/C14, with idempotent role/grant/FORCE-RLS/policy statements and no committed credential. The exact traced legacy operation allowlist is versioned in `server/src/db/job-control-legacy-grants.ts`.

**Implementation clarification (fix round 1, 2026-08-10).** Distinct review of the
initial candidate found that its synthetic trace omitted real transitive checkout and
prompt dependencies and that its operator table-wide CRUD exceeded this decision.
Successor custom migration `0214_e2_serving_role_hardening.sql` preserves option B
while converging both roles to exact authority: the app allowlist includes operations
proved by representative real service calls; the current pre-JOB-002 operator seam is
read-only `SELECT` on named safe worker/target metadata columns; both roles are
`NOINHERIT`/`NOREPLICATION`, have no memberships or application-object ownership,
and retain no stale schema/table/column/sequence authority. `execution_targets`
remains RLS-enabled but is not forced so the flag-off non-superuser-owner legacy path
remains authoritative, with no `PUBLIC` policy and no owner fallback. Startup audits
the exact effective posture, and both bounded pools are resources of the single
awaited shutdown sequence. Candidate code revision `d5abd1a53` awaits distinct
re-review; this is not a prerequisite pass and grants no JOB-002 authority.

**Implementation clarification (fix round 2, 2026-08-10).** Startup now binds
both the authenticated `session_user` and active `current_user` to the exact expected
bounded role, so an owner/superuser URL cannot mask itself with PostgreSQL startup
`role` options and later recover broader authority with `SET ROLE NONE`. The exact
effective-authority audit covers ordinary and partitioned tables, views,
materialized views, and foreign tables, including column privileges; an adversarial
view over a secret object therefore aborts startup. Successor custom migration
`0215_e2_serving_role_audit_completion.sql` grants `aoa_app` `SELECT` only on the
seven `execution_targets` columns read by the current heartbeat pinned-target
resolver: `id`, `slug`, `kind`, `trust_class`, `status`, `organization_id`, and
`config`. It excludes `worker_token_hash`, `owner_user_id`, `capabilities`,
`last_seen_at`, and all operator writes. Candidate code revision `21335854f` awaits distinct re-review;
this is not a prerequisite pass and grants no JOB-002 authority.

## Decision #124 — Tenant work on platform targets uses Organization-scoped logical worker sessions (2026-08-10)

**Status:** Locked 2026-08-10 (operator-approved E3-F018 amendment; Epic E3 / JOB-003).

**Context.** A platform physical worker session is deliberately null-Organization, while the
strict frozen Lease ACK v1 body and lease-only HTTP path carry no tenant shard. No durable
lease-to-Organization locator exists, and Decision #123 forbids `aoa_operator` from reading
jobs, attempts, leases, outbox rows, or operation receipts. Memory routing is not restart-safe;
tenant scans create latency and isolation oracles; widening operator job authority violates
H-01. E1 and JOB-002 already support one device having multiple Organization-scoped logical
profiles on a shared platform target.

**Decision.** Tenant job poll, offer, ACK, renew, event upload, control ACK, artifact/secret
access, and completion always authenticate with the selected Organization-scoped logical
worker session, including when its registered physical target has `scope='platform'`. The
session binds Organization, logical worker ID, target ID/generation, device thumbprint, and
profile hash. Its authenticated Organization is the sole tenant-shard selector for
`runInTenant`; request JSON, headers, extensions, operator lookup, and scanning cannot select
or widen that shard. The logical worker ID remains the lease and receipt FK identity.

The platform-scoped physical session remains null-Organization and physical-control-only:
enrollment, device/target health, generation, drain/revoke, and other platform registry
lifecycle operations that expose no tenant or job identity. Tenant worker-operation routes
reject it uniformly before tenant lookup. No lease locator is added and frozen E1 v1 remains
byte-for-byte unchanged.

For a platform target, each governed tenant mutation uses a revocation-linearized advisory
handoff with the app transaction outermost. Inside the already-open `runInTenant` transaction,
a bounded operator transaction locks the exact physical target and then physical worker
`FOR SHARE` in fixed order and validates active generation/device/profile without receiving
tenant, job, lease, fence, or payload facts. While those row locks remain held, the app
transaction acquires a domain-separated transaction-scoped shared advisory lock for the
target and performs a plain SELECT authority recheck; it never requests a row UPDATE lock or
wider RLS policy. Operator validation must commit successfully, after which the app retains
the advisory lock through its tenant mutation and commit. Operator failure forces app
rollback; app/process failure automatically releases the transaction-scoped advisory lock.
All nested pool acquisition is app→operator.

Every platform status, generation, device-binding, or registered-profile authority writer
locks target then its bound worker when present `FOR UPDATE`, obtains the matching transaction-scoped exclusive
advisory lock, and only then mutates. Last-seen-only physical heartbeat is split from authority
changes. Guard-first tenant work commits before the exclusive cutoff can complete; cutoff-
first work blocks the shared-row handoff and then fails the changed authority check. Locks are
bounded and fail closed. This requires no grant/RLS widening or distributed two-phase commit.
A static writer inventory prevents an authority-changing path from bypassing the protocol.

Platform logical-profile liveness is not circular. A fresh session-bound device proof plus
the guarded current physical worker/target heartbeat supplies operation liveness; a newly
enrolled logical profile may have `workers.last_seen_at IS NULL`. After authority succeeds,
the tenant transaction writes the exact logical profile's database-time `last_seen_at` for
observability. A stale physical worker/target still denies. Organization/owner targets retain
their ordinary logical worker and target heartbeat requirements.

The flag-on outbox runtime may list admitted Organization IDs through the bounded non-owner
app pool and enumerate those shards internally only to
claim tenant outbox rows through separate `runInTenant` calls and create identifier-only,
non-authoritative ready hints. It excludes sentinel/inactive/unmapped entries and visits a
stable lexical rotating window rather than a permanent first-N prefix. Each Organization-
scoped poll consumes only its own hints and retains a bounded tenant-local pull fallback, so
hint rejection/loss/restart or membership churn affects latency rather than correctness. A
platform-scoped session never consumes tenant-ready hints.

**Consequences.** This preserves H-01/H-02 and frozen wire compatibility without exposing job
metadata through the operator role. One physical device may hold many logical sessions; the
worker-side WRK-003 implementation owns process-local cross-profile polling and local capacity,
while JOB-003 enforces per-logical-profile lease authority and registered clamps, and JOB-007
later enforces Organization/workload quota authority after E6-D1-FOUNDATION. Any future move
to one cross-tenant platform session requires a new locked decision and threat-model review;
it is not an additive JOB-003 implementation choice.
