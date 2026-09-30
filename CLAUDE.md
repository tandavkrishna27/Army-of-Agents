# AoA (Army of Agents)

Hybrid Workforce Operating System for startups. Founding teams of any size — solo founders to multi-person teams — run AI agents + humans from a single control room. Agents extend your team; they don't replace it.

---

## If You Are an AI Agent

You are reading this as context for working on the AoA codebase. This applies whether you are doing feature development, bug fixes, code review, or exploration.

- **Code is always truth.** If this file conflicts with what you find in source, trust the code and flag the discrepancy.
- **Architectural decisions are locked.** Before changing how a system works, read `docs/architecture/decisions.md`. Do not relitigate them.
- **AoA is not open source.** Do not add open-source license headers, public contribution guides, or community-facing copy.
- **Commander** is the name of the always-on internal AI assistant built into AoA. It has its own onboarding context (`server/src/onboarding-assets/`). You are not Commander unless explicitly told so.
- **Paperclip** is the open-source base AoA forked from. It is not mentioned in user-facing docs. For wire protocol contracts and deprecated table tracking, see `docs/paperclip-migration.md`.

---

## Critical Rules

1. **Drizzle ORM only.** Schema changes go in `packages/db/src/schema/`. Run `pnpm db:generate` for migrations. NEVER write raw SQL migration files. Schema DDL is always `db:generate` output. **Narrow exception (C14) — TWO classes, both of which drizzle-kit provably cannot emit:** **(a) idempotency guards** (`IF NOT EXISTS` / `DO $$ … duplicate_object`) **and data-only backfills**, hand-APPENDED below generated DDL (e.g. `0189`, `0195`); **(b) idempotent cluster/security DDL** — roles, `GRANT`/`REVOKE`, `ENABLE`/`FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, and `SECURITY DEFINER` functions plus their ACLs — hand-authored into a delta-free `--custom` migration (e.g. `0211`, `0213`, `0214`, `0261`, `0267`; `0266` is superseded and is NOT an exemplar). **Class (b) is governed by Decision #122 and its 2026-09-01 amendment, which carry the binding conditions — read them before hand-authoring anything;** this line is a summary, not the authority. **Tables, columns, indexes and foreign keys are NEVER hand-authored** — that is always `db:generate` output. See `AGENTS.md` and Decisions #19 + #122.
2. **Follow existing patterns.** New services follow `server/src/services/goals.ts`. New routes follow `server/src/routes/goals.ts`. New schemas follow `packages/db/src/schema/goals.ts`.
3. **"Issues" = "Tasks" in UI only.** The DB table is `issues`. The API routes use `/issues`. All user-facing text says "Task" / "Tasks". Never rename the table or routes.
4. **"Projects" table serves both Departments and Projects.** Distinguished by `type` field: `'department'` | `'project'`. Same mechanics for both.
5. **MCP inbound with authenticated write permission may create tasks directly.** `debrief-push` remains for unstructured content requiring extraction. Anonymous MCP input must route through Discussion. (Decision #14, revised 2026-04-21)
6. **Agents cannot write to Memory directly.** They can suggest items (status: 'pending'), but only the founder can approve identity + domain layers. Team leads can additionally approve active_context for their departments. Working memory is auto-created. (Decisions #15, #52)
7. **Artifact versions are immutable.** Once created, never modified. Changes = new version. Founder picks winner for branching — no auto-merge. (Decisions #43, #45)
8. **Memory feedback requires ≥3 occurrences.** Don't suggest memory from one-off edits. Pattern must be consistent. (Decision #46)
9. **Discussion scope fallback: item-level > entry-level > discussion-level > null.** Founder's per-item override always wins. (Decision #61)
10. **Consult `docs/architecture/decisions.md` before making architectural choices.** Do not relitigate locked decisions.
11. **Extraction is CLI-only; credential mode follows the deployment boundary.** In self-hosted modes, agents, Commander, and extraction (discussion + debrief-push + file-import + crew memory-extract tools) use locally installed CLI logins and no hosted model-provider key. In `cloud_auth`, PR #320 keeps extraction as a sandbox-local CLI invocation but resolves the Company's configured model-provider key and materializes it only inside the isolated E2B environment; the shared host never executes model output or falls back to its own CLI login. There is no selectable/direct `api` extraction engine—the removed `callLLM`/`callAnthropic`/`callOpenAI` path and engine-status route stay removed. Embeddings continue to use OpenAI `text-embedding-3-small` through the `createOpenAiEmbedder` chokepoint. Do not add direct hosted-API extraction calls, serialize provider keys into prompts/protocol/evidence, or introduce a host fallback. (Decision #104, amended 2026-06-27 and 2026-08-08)

---

## Paperclip Divergence Points

These are intentional AoA-specific choices that **differ from Paperclip** and must
survive future Paperclip pull syncs. Future agents: when you see a Paperclip commit
touching these areas, check against this list before porting.

### D5 — Concurrency clamp (heartbeat)

- `HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1` — **permanent teaching default**.
  AoA teams opt-up per-agent as they build trust. A founding team of 3-5 people
  running a multi-agent pipeline can set each agent to 3-5, yielding 9-25 concurrent
  runs — well within the clamp.
- `HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50` — raised from Paperclip's 10 in v1.1 (D5).
  Founding teams legitimately need > 10 concurrent runs across all agents.
- **Do NOT port** any Paperclip commit that raises the DEFAULT above 1 or the MAX
  above 50 unless there is a specific AoA team-size reason to do so.

### D6 — Hire-approval default by deployment mode (company create)

- `local_trusted` mode: `requireBoardApprovalForNewAgents = false` at create time.
  Loopback trust boundary = all users are already implicitly trusted. One-click
  approval for every agent hire is friction with no multi-human safety benefit.
- `authenticated` mode: `requireBoardApprovalForNewAgents = true` at create time.
  Multi-human board → agent hiring is a governance decision. Default on = safe.
- DB schema default (`.default(true)`) is unchanged — this is injected server-side
  in `server/src/routes/companies.ts` POST handler using `opts.deploymentMode`.
- **Do NOT port** any Paperclip commit that sets this field to `false` in
  `authenticated` mode. Multi-human board accountability is the AoA thesis.

### D8 — Planning mode dispatch gate

- `issues.work_mode` column (`"standard" | "planning"`, DB default `"standard"`).
- When `work_mode = "planning"`, the heartbeat dispatch gate in
  `server/src/routes/issues.ts` (CREATE line ≈609, UPDATE/PATCH line ≈772)
  is suppressed via `shouldDispatchIssueWakeup()` in
  `server/src/routes/issues-planning-mode-dispatch.ts`.
- UI: amber "Planning" pill on IssuesList rows, NewIssueDialog chip bar, and
  TaskSlideOver header (click to revert to Standard).
- **Do NOT port** any Paperclip commit that adds `work_mode` or a similar field
  differently — AoA's interpretation is that planning tasks are human-curated and
  must not auto-dispatch until the founder switches them to Standard.

---

## Naming Map (UI ↔ DB/API)

| UI Label | DB Table | Notes |
|----------|----------|-------|
| Task | `issues` | API routes use `/issues` |
| Home | — | Was "Dashboard" |
| Budget | `cost_events` | Was "Costs" |
| Team | — | Was "Org" |
| Discussion | `discussions` | Was "Debrief" |
| Extracted Item | `discussion_extracted_items` | Was "Brief Item" |
| Objectives | `goals` | UI route is `/objectives`; API routes stay `/goals` |

Agents, Company, Settings, Activity, Inbox — UI label matches DB/API name.

---

## Stack

- **Frontend:** React + Vite + TailwindCSS v4 (`ui/src/`)
- **Backend:** Express 5.x (`server/src/`)
- **Database:** PostgreSQL + Drizzle ORM (`packages/db/src/schema/`)
- **Shared types:** `packages/shared/src/`
- **Adapters:** `packages/adapters/` + `server/src/adapters/`

---

## Adapters

Registered in `server/src/adapters/registry.ts`. All agent execution is CLI-only — no direct SDK adapters.

| Type | Runtime |
|------|---------|
| `claude_local` | Claude Code CLI |
| `codex_local` | OpenAI Codex CLI |
| `cursor` | Cursor IDE |
| `opencode_local` | OpenCode CLI |
| `openclaw` | OpenClaw runtime |
| `gemini_local` | Gemini CLI |
| `hermes_local` | Hermes (uses `PAPERCLIP_RUN_ID` / `PAPERCLIP_API_KEY` wire protocol — do NOT rename to AOA_*) |
| `process` | Generic shell process |
| `http` | HTTP webhook |

API-mode adapters (`claude_api`, `openai_api`, `gemini_api`) were removed per Decision #91 and must not be re-added. The Provider SDK utilities in `server/src/services/internal-agent/providers/` remain for **embeddings + Commander only** — extraction is **CLI-only** (Decision #104, amended 2026-06-27; see Discussion Pipeline below) and no longer reaches the provider SDK. Not in the adapter registry.

---

## Architecture

### Heartbeat System

Push-based agent execution. `heartbeat.wakeup()` → HeartbeatRun → adapter executes. Agents don't pull tasks — they get told what to work on.

- **Atomic checkout:** Issues use `SELECT FOR UPDATE NO WAIT` for single-agent locking.
- **Goal status machine:** `planned → active → at_risk → achieved/cancelled` with `at_risk → active` recovery.
- **Why/What/How context:** Agents receive Vision + Mission + Goal + Memory items + Task details.
- **Agent hire approvals:** When `company.requireBoardApprovalForNewAgents` is true (default for `authenticated` mode), hires queue in Inbox. Agent created as `pending_approval`. In `local_trusted` mode new companies default to `false` (agent created `idle` directly). See `server/src/routes/agents.ts:784` and **Paperclip Divergence Points § D6** above.
- **Inbox Hub:** tab-first, no reading-pane preview. Row-click/deep-link opens and activates a dedicated tab; Home is the attention dashboard. Non-home tabs get the contextual `HubActionBar`; tabs are capped at 12 (Home + 11 closeable). `ask_founder` work questions relay on successful answer so the waiting-lane item closes. See Decision #108.
- **Concurrency clamp:** `HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1` (teaching default; teams opt-up per-agent). `HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50` (v1.1 D5 raise from 10). See **Paperclip Divergence Points § D5** above.
- **Run summary comments:** Auto-generated task comments after each heartbeat run (duration, token usage, cost, outcome, detected files). Uses `issue_comments` table. Opt-out via `runtimeConfig.autoRunSummary`. Files truncated to 10 + "+N more". The writer is the shared `postRunSummaryComment` (`server/src/services/run-summary-comment.ts`) — heartbeat delegates to it, and the crew runner (`runAoaAgent`) uses it too (W3a).
- **Crew result loopback (W3a):** when a CREW agent (kind='aoa') finishes a discussion-spawned task (`issues.originKind='crew_thread'`), `runAoaAgent` posts back into the originating thread — `relayCrewResult` ("Completed: …") on success, `postCrewFailureCard` ("… could not complete …") on failure — plus a `postRunSummaryComment` on the task. Composed as `postCrewRunSuccess`/`postCrewRunFailure` (`internal-agent/aoa-agents/crew-run-outcome.ts`), all best-effort (per-substep try/catch, never fail the run). The `autoRunSummary` opt-out suppresses ONLY the summary comment — the loopback/failure card always post (founder visibility). `detectedFiles` is `[]` for crew until W3b (workspaces). Was heartbeat-only before W3a.

### Memory System

4-layer approval-gated memory model. Founder is sole gatekeeper for identity + domain layers.

| Layer | Scope | Lifetime |
|-------|-------|----------|
| `identity` | Company-wide | Permanent. Vision, mission, values. Sources: companies table fields + memory items with layer='identity'. |
| `domain` | Department-scoped | Semi-permanent. How we do X. |
| `active_context` | Goal/project-scoped | Temporary. `expiresAt` field. Team leads can approve for their departments. |
| `working` | Task-chain-scoped | Ephemeral. Auto-archives after 7 days (BFS chain check, max depth 50). |

**Read visibility (RBAC, Decisions #118/#119):** retrieval is gated per actor — `memory-access.ts` `canActorSee` / `memory-access-sql.ts` `memoryAccessConditions` (ORG/CREW/MCP paths), `memory-policy.ts` `canSeeDurableMemory` (Commander). **identity** → agents (grounding) + founder/team_lead; NOT team_member humans, NOT external MCP keys. **visibility='company'** → every internal member (incl. team_member); NOT external MCP keys. **Fully-unscoped** (no dept/project/goal/task) non-identity memory → ambient company-level: every internal member + agents, NOT external keys (Decision #119; discussion-extracted memory is created this way). **domain/active_context/working** → scope-matched (department/project/goal→project/task→project); the run-path scope filter is `= scope OR IS NULL` so it never excludes company-wide/unscoped memory. **Private** (owner-typed or agent-personal) → owner-only; founder never sees others' private (break-glass is separate). **Invalidated** → nobody; **founder** sees all non-private. External MCP keys resolve to a scoped `team_member` marked `external:true` and are excluded from identity+company. Do NOT re-broaden without a successor decision.

**Lifecycle:** Auto-archive on goal completion, TTL-based archival (7-day working memory), expiresAt archival, 90-day staleness flagging via suggestions. Archived items can be restored. `touchAccessedAt` tracks usage.

**Memory versioning:** draft/approved/archived lifecycle. `memory_item_versions` table.

**Memory feedback:** `memory_feedback_patterns` table detects recurring founder edits on agent work. Suggests memory items after ≥3 occurrences. Grouped by agent.

**Memory write → RAG indexing:** every write path (`memory.create`, `memory.approve`, crew `write_memory`, MCP `memory.write`/`retain`/`suggest-memory`/`propose_memory_from_thread`) enqueues an embedding via `writeMemoryAndIndex` / `enqueueMemoryEmbedding` (status-agnostic, deduped). Key files: `server/src/services/memory-write.ts`. (Decision #104)

See `docs/architecture/memory.md` for UI layout, semantic retrieval configuration, and feedback detector details.

### Discussion Pipeline

Thread-based. Input modes: paste, write, voice, MCP.

Flow: Discussion entry → CLI extraction → `discussion_extracted_items` → founder approval → Tasks + Memory items.

- Polymorphic scope: department / project / goal. Entry-level scope overrides thread-level scope.
- Inline annotations on entries (anchorStart/anchorEnd character offsets).
- **Extraction engine — CLI-only (Decision #104, amended 2026-08-08 for PR #320):** `resolveExtractionEngine` returns `"cli"` or throws. There is no `api` engine. In self-hosted modes, extraction remains a server-side one-shot (`--print` / `exec`) using the installed CLI login. In `cloud_auth`, `one-shot-sandbox-cli.ts` resolves the Company's model-provider key, directly acquires an isolated E2B environment, and invokes the sandbox provider runtime; it does not use the MCP bridge and fails closed when Company/provider/environment context is unavailable. The key is scoped to that sandbox execution and is never taken from the shared host's CLI login. There is no `submit_extracted_items` handshake or Decision #100 crew-CLI blocker. Windows prompt delivery sends user content via **stdin** to claude (never argv). The same CLI extractor serves discussion, debrief-push, file-import, and crew memory-extract tools.
- Extraction failure: entry marked `failed`/`skipped`, founder notified via `notifications` table. Can retry or manually create. Failure copy is cause-aware: local `not_installed`/`not_authed` points to the configured CLI login, while cloud `sandbox_unavailable` may point to provider-key and execution-environment Settings; timeout/nonzero/unparseable cases do not invent credential advice. No selectable-engine status banner exists.
- **Extract-then-scope (W2, D6):** the controller `create_scope_draft` commit awaits `extractionService.extractThreadEntriesAwait` (never-extracted entries only — status pending/skipped/failed with zero items; 25-entry cap + 180s wall-clock deadline; best-effort) BEFORE compiling, then compiles with `suppressFallbackTask: true` — an Adjutant draft with zero real items shows **no synthetic task card**. Range integrity: the helper folds truncation (cap/deadline) + the first non-completed entry into `rangeEndCap` → the draft's `sourceEndSeq` is capped there, so unprocessed/failed entries stay in the NEXT scope's range (an all-failed pass mints NO draft; entries stay retryable). Applying a card that came from an extracted item resolves the source item (approved + result linkage + pendingItemCount decrement + hub reconcile — no duplicate approvals, no stale badges). The human create-draft route does not run extraction (synchronous request) and keeps ONE fallback card titled by `derivedTitleFromEntries` (longest entry's first sentence, ≤80 chars); the keyword-stub titles ("Implement real multi-message scope generation", …) are dead. Reprocess (delete + re-extract) semantics stay in `discussions.ts reprocessAllEntries`. End-state (D17): all task titles agent-authored — the human button becomes "Ask Adjutant to scope", queued behind the fake-crew-harness CI work.
- **Autonomy → dispatch (W1a/W1b/W1c):** a scope draft (`create_scope_draft`) auto-applies per thread autonomy (`thread.autonomyLevel ?? internal_agent_config.crewAutonomyLevel` — D18 split the company dial; crew reads `crew_autonomy_level`, Commander keeps `autonomy_level`). **Manual (0)** = propose-only (founder accepts each card). **Assist (1)** = auto-create + assign the crew tasks as `planning` (non-dispatchable), then raise ONE `crew_dispatch` approval in the Inbox (`approvalService`, generic `approval_request` hub item → deep-links to `/approvals`); approving flips those tasks `planning→standard` + dispatches them, rejecting leaves them parked. **Drive (2)** = auto-create as `standard` + auto-dispatch. Every real dispatch (Drive auto + Assist-on-approve) runs `preflightCrewDispatch` (company budget hard-stop + thread pause/disable); blocked → left for manual accept (Assist approve throws + rolls back). The `crew_dispatch` approval carries only `taskIds` — memory candidates always stay founder-gated (D12). Key files: `server/src/services/thread-agent-actions.ts` (enqueue), `server/src/services/approvals.ts` (`crew_dispatch` approve/reject side-effect).

### Artifacts

Versioned deliverables: documents, presentations, code, design, reports.

- **Immutable versions.** Source-agnostic (agent/founder/MCP/teammate/external). Version numbering atomic via transactions.
- **Founder picks winner** for branching — no auto-merge. (Decisions #43, #45)
- **Agent output capture:** workspace diff → adapter hinting → founder confirmation during review. Files copied from workspace to storage, never moved. (Decision #67)
- **Artifact-as-input:** downstream tasks auto-receive artifacts from dependency tasks as context (spec→design→code→test pipelines). Content truncated at 2000 chars per artifact. (Decision #71)
- **Task Outputs:** `task_outputs` is the unified product index for artifacts, detected files, preview URLs, runtime services, branches, and PRs. It does not replace `issues.artifactId`; that field remains the primary artifact pointer for artifact-as-input and existing viewer flows.
- **Refinement loop:** review state supports adding artifact versions. Founder can refine on external LLMs and push back via MCP, upload, or paste. (Decisions #69, #70)

### Task Dependencies

`task_dependencies` table links tasks in blocking relationships. When a dependency task completes → dependent auto-unblocks. Separate from `parentId` (which is subtask hierarchy, not blocking). Tasks can be blocked from any non-terminal status: backlog, todo, in_progress.

### Task Completion And Ask Human

Agent-owned tasks snapshot an effective completion policy: `review_required` (safe company default) or `agent_can_complete`. Resolution order is task override -> Routine/workflow-template override -> the task's single department-or-project scope -> company; a hard company guardrail can force review. Agent completion also requires structured acceptance criteria and sufficient autonomy. Review assignment is materialized in `reviewerUserId` on entry to `in_review`.

`work_questions` is the durable Ask Human source of truth. A question is linked to its task, asking agent, recipient, optional run/workspace/source Discussion, answer, and continuation state. Commander, Inbox, Task Work, Workspace, and source Discussion are mirrors of the same question. Technical run completion never implies task completion. See Decision #109.

### RBAC

Three roles: `founder`, `team_lead`, `team_member`. Department-scoped. Additive permissions from restrictive defaults.

- Team leads can approve `active_context` memory for their departments.
- Workspace authz: founder > team_lead (project-scoped) > team_member (read-only).
- `user_roles` table. `instance_user_roles` for instance-level roles. `principal_permission_grants` for fine-grained plugin grants.

### MCP (Bidirectional)

**Inbound:** `/companies/:cid/mcp` JSON-RPC endpoint. Three protocol actor sources (`server/src/mcp/server.ts`):
- `mcp` — caller presented a Bearer token matching an `mcp_api_keys` row
- `board` — caller has a valid board session (browser cookie in authenticated deployments, or synthetic `local-board` actor in `local_trusted` mode)
- `agent` — caller presented an agent run JWT / agent key context during execution

Requests with neither → 401 in authenticated deployments. `local_trusted` no-token loopback requests are treated as trusted board context, and requests carrying a valid run id may be treated as the running agent. `cloud_auth` / `authenticated` deployments reject unauth'd MCP traffic.

**Outbound (AoA as MCP server):** tools are RBAC- and actor-scoped, and four MCP resources expose tasks, goals, memory, and artifacts. The runtime registry in `server/src/mcp/tools/index.ts` is authoritative. `use_skill` is available to Commander and to **crew agents** (`kind='aoa'`), scoped per-agent by `skillKeys` — a crew agent may only invoke a skill deliberately attached to it, and the gate is **fail-closed on missing identity** (the open-library security boundary: D7/D8, enforced in `skill-tools.ts`). `ask_human` and its `ask_founder` compatibility alias require an agent's active **task run** — either a crew dispatch or an org heartbeat run — i.e. `actorType:"agent"` with `agentKind` in {`aoa`, `org`} plus a live `agentId`/`runId` (`ask-human-tool.ts`). Crew tool calls run through the same bridge as Commander but are **not** subject to Commander's runtime-approval policy — that gate applies only to `actorType:"commander"` (`mcp-bridge.ts`).

### Commander (Internal Agent)

Always-on AI assistant for coordination, proactive monitoring, and workflow management. CLI-mode execution (defaults to `claude_cli`; `codex` and `opencode` also supported). No per-company API key required. SSE streaming.

- **Generated tools:** `packages/shared/src/generated/tools.json` is the source of truth; `server/src/onboarding-assets/commander/TOOLS.md` is generated from it. Validate drift with `pnpm gen:tools:check`, `pnpm gen:tools:md:check`, and `pnpm gen:skills:check`.
- **Per-company config** (`internal_agent_config` table): executionMode, provider, model, autonomyLevel + crewAutonomyLevel (**two independent dials** since the D18 split, 2026-07-24 — `autonomyLevel` is Commander-only and is not read at runtime today; `crewAutonomyLevel` is the agent-work dial read by crew task runs, org-agent heartbeat runs, and every Adjutant/thread flow. Both **default Assist/1**; existing rows were backfilled from the old shared column so no behaviour moved. See Decision #109 addendum §10-14), enabledCapabilities (12 types), budget, proactive interval.
- **Agent loop:** HTTP route → agentLoopService (conversation + user message persistence) → cliModeService (subprocess spawn + MCP bridge + stdout streaming) → SSE to UI.
- **One persistent conversation** per user per company. History summarization for token management.
- **Proactive checks:** the check functions (blocked tasks, budget thresholds, stale work, dependency gaps, memory conflicts, workload imbalance) are implemented and push to Inbox via notifications, but the periodic scheduler that runs them on an interval is **not yet wired** (the `proactiveIntervalMinutes` config exists; nothing reads it at runtime). Event-driven + chat coverage ships today; scheduled proactive scans are tracked for 1.1. (Verified 2026-07-04.)
- **Event-driven:** listens to LiveEvents (heartbeat completion, activity changes, MCP inbound, discussion entry creation) with debouncing.
- **Per-agent context mode** (`runtimeConfig.contextMode`): minimal / standard / full. Default: `standard`. Prevents token waste for simple adapters. (Decision #87)
- **Session management (UI):** multi-chat sidebar (`ui/src/components/commander/`) with pin, archive, rename, hard-delete, and **drag-to-reorder**. Manual order overrides the default date groups (TODAY/YESTERDAY/…) — the first drag collapses the non-pinned list into one flat "Arranged" list; a Reset control restores recency. Persisted via `internal_agent_conversations.sort_order` (nullable; null = recency). Routes: `PATCH …/conversations/reorder`, `DELETE …/conversations/order` — both owner-scoped (a founder viewing others' chats can't clobber their order). DnD uses dnd-kit with Mouse + Touch (long-press) + Keyboard sensors.
- **Unified composer:** Commander, Discussions, and task comments share draft identity, replay-safe `clientSubmissionId` handling, and attachment validation. Drafts are user/company/surface/entity/reply scoped and expire after seven days. Composer submissions accept at most five files of 10 MB each from the shared MIME allow-list. Commander supports company-agent mentions, skill tokens, files, and Retry/Edit/Discard; Discussion mentions and task-comment wake/control effects use durable outboxes. See `docs/guides/board-operator/composer.md`.

### Onboarding and Human Context

Onboarding is route-driven and role-aware: founder setup and invited-member entry
do not share the same required steps. Durable progress belongs in
`onboarding_progress`, while global identity and company-specific operating
context live in `user_profiles`, `company_user_profiles`, and
`company_user_capability_documents`. Do not infer onboarding completion from a
single browser-local flag.

### Workflow Templates

Backend-ready (schema + API). Ordered steps with dependencies that expand to tasks + `task_dependencies` on instantiation. Usage tracking (`instantiationCount`). Create programmatically via `POST /api/companies/:cid/workflow-templates`. UI list + step builder deferred to 1.1.

### Suggestion Engine

8 categories: goal_gap, pipeline_bottleneck, memory_gap, pattern_detected, budget_optimization, recurring_work, risk_flag, workload_balance — plus agent proposals. Runs on Home load + every 4 hours. Deduped by `actionPayload.patternId`.

### Agent Trust Score

Formula: `(approvedWithoutChanges / totalTasksCompleted) × 100`. Last 20 tasks weighted 2×. Sliding window approximation for the recent window. Auto-creates trust score row on first review. Displayed on agent cards.

### Feedback & Privacy

Thumbs-up/down on agent-authored comments (`FeedbackThumbs` in CommentThread). Routes: `POST/GET /issues/:id/feedback-votes`, `GET /issues/:id/feedback-votes/summary`, `DELETE /feedback-votes/:id`. Feedback bundles are redacted and transmitted (or written to `~/.aoa/feedback-exports/`) when `instance.feedbackDataSharingPreference === "allowed"`. See `docs/deploy/telemetry.md` for redaction pipeline, anonymization, consent settings, and plugin telemetry.

### Company Portability

Export/import full company bundles (`schemaVersion: 2`, 12 sections). Paperclip v1 bundles import compatibly (warn-and-continue for unknown sections). UI: `/export` (checkboxes + preview → JSON download) + `/import` (upload → plan → import). See `docs/api/companies.md` for the full bundle schema and section list.

### Execution Workspaces

Per-task git worktree isolation for software engineering projects. Instance-wide default: `enableIsolatedWorkspaces: true`. Gate: `functionType === "software_development"` + `executionWorkspacePolicy.defaultMode`.

- **Per-task preference:** `shared_workspace | isolated_workspace | reuse_existing` (IssueWorkspaceCard in TaskSlideOver).
- **Key files:** `ui/src/components/workspace/`, `server/src/services/workspace-runtime.ts`, `packages/db/src/schema/execution_workspaces.ts`.
- See `docs/guides/board-operator/execution-workspaces.md` for the full guide (close flow, TTL sweeper, IDE integration, Create PR).

### Marketplace

- **Catalog:** sourced from `https://meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json`. Schema mirror in `packages/shared/src/marketplace.ts` — bumps require coordinated changes in both repos; AoA-side code must handle new fields being absent. Build-time snapshot fallback: `ui/src/aoa-marketplace-snapshot.json` (generated by `pnpm fetch-catalog`). (Decision #96)
- **Packages:** synthetic groupings derived server-side via `derivePackages()` in `server/src/services/derivePackages.ts`. Grouped by `owner/repo` from `source.url` (threshold ≥ 2, skill items only). `packageId` field overrides synthesis. (Decision #97)
- **Card chrome + Hub layout:** locked in `docs/architecture/design-system.md` §9.13–9.18.
- **Key files:** `ui/src/components/marketplace/`, `ui/src/lib/marketplace-constants.ts`, `ui/src/pages/Marketplace*.tsx`, `server/src/services/derivePackages.ts`, `packages/shared/src/marketplace.ts`.

### LobbyShell & Settings Chrome

`LobbyShell` (`ui/src/components/LobbyShell.tsx`): shared chrome for pre-company-selection pages (Lobby, Marketplace, Settings). Exposes a `secondarySidebar` slot rendered flush between primary sidebar and content. Auto-collapse rule: `defaultCollapsed={true}` only when a secondary sidebar is present — Settings is the only current consumer (Decision #98). Mobile sub-nav pattern: design-system §8.6. Key files: `ui/src/components/LobbyShell.tsx`, `ui/src/components/LobbySidebar.tsx`, `ui/src/components/SecondarySidebar.tsx`.

### Global Search

PostgreSQL full-text search (tsvector/tsquery). cmd+K. RBAC-scoped. Results grouped by entity type.

### Voice Input

Browser recording → Whisper API transcription → Discussion pipeline. Third input mode alongside paste and write.

### Context Packaging

"Open in [LLM]" assembles 8-section markdown context: company identity + department/project + goal + dependencies + task details + artifacts + agent config + preferences. Token estimate: `ceil(markdown.length / 4)`. 8000-token warning threshold.

### Distribution

Docker + npm release pipeline is configured for SemVer (0.1.0+), multi-arch
GHCR images, and scoped `@armyofagents/*` packages. No MeteoriteLabs AoA npm
package is currently published; source checkout is the supported install path.
See `docs/deploy/distribution.md` for current release status and the Changesets,
rollback, and smoke-test runbook.

### CI Platform Status

**Triggers (2026-06-24 redesign):**

- `pr.yml` (the gate suite) runs on **every** pull request — no base-branch
  filter — plus `push` to `main`. Required checks: `verify`, `e2e`,
  `migrations`, `policy`, `brand-check`. Cross-platform lanes stay advisory.
- **Draft PRs are gated:** each `pr.yml` job carries
  `if: ${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}`,
  and the `pull_request` trigger lists `ready_for_review`. Draft PRs show the
  gate jobs as `skipped`; marking a PR ready re-runs them for real before merge.
  (Safe despite skip-as-success: drafts can't be merged, and `ready_for_review`
  re-runs the jobs. Do NOT add `edited` to chase retarget re-runs — on a
  *mergeable* PR a title/body edit would skip the required jobs into a success
  and bypass branch protection. Retarget + `paths-ignore` need the aggregator
  gate pattern, tracked for 1.1.)
- `release.yml` / `docker.yml` run on `push` to `main` (Docker also on `v*`
  tags). The porting-era branch allow-list is gone.
- Do NOT re-introduce a `branches:` filter on `pr.yml`'s `pull_request` trigger
  (it silently ran zero checks on stacked/feature PRs), and do NOT add a
  `paths:`/`paths-ignore:` filter to `pr.yml` (a skipped required check leaves
  PRs stuck on "Expected — Waiting for status").
- **Single required check (Phase 1.1):** branch protection requires only
  `ci-required` — an always-running (`if: !cancelled()`) aggregator that computes
  pass/fail from `needs.*.result` + `changes.outputs.code`. The heavy jobs
  (`verify`/`e2e`/`migrations` + cross-platform) are non-required and **skip on
  docs-only PRs** (every changed file under `docs/` or a root-level `*.md` like
  README/CLAUDE/AGENTS), detected by the `changes` job (`--no-renames`; nested
  `*.md` such as runtime prompt assets count as code). Drafts skip all real jobs and `ci-required`
  goes red (zero CI; honest "not validated"). Do NOT make an individual job a
  required check again, and do NOT add a `paths-ignore` trigger filter — route
  conditional execution through `ci-required` (a skipped required check passes
  silently; the aggregator computes the verdict instead). Required human review
  + CODEOWNERS are deferred until a second committer with write access exists.

| Platform | Verify | E2E |
|----------|--------|-----|
| Linux | Required gate | Required gate |
| macOS | Advisory (green) | Advisory (green) |
| Windows | Advisory (4 tests skipped — Issues #113/#127) | Skipped — embedded-postgres can't start on `runneradmin` runner (Issue #114) |

Windows e2e skip is implemented at playwright config level (`tests/e2e/playwright.config.ts`).

**CDN fallback:** The required Linux `e2e` job uses a Google Chrome-for-Testing download when `cdn.playwright.dev` stalls (configured in `.github/workflows/pr.yml`). The advisory `e2e-cross-platform` macOS/Windows lanes do NOT use that fallback — they still rely on the default Playwright CDN and time out at 12 min if the CDN stalls. Generalizing the Google-storage fallback to mac/win lanes is tracked for 1.1.

---

## Database Schema

All table definitions live in `packages/db/src/schema/`. Schema changes use Drizzle ORM only — never raw SQL — except the C14 narrow exception, which has two classes: **(a)** hand-appended idempotency guards and data-only backfills (e.g. 0189/0195), and **(b)** idempotent cluster/security DDL, governed by Decision #122. Schema DDL is always `db:generate` output. See rule 1 above and `AGENTS.md` for the full text; **Decision #122 is the authority — this line summarises it and cannot widen it.**

### Core / Company

| Table | Purpose |
|-------|---------|
| `companies` | Company config. Key fields: `requireBoardApprovalForNewAgents`, `enableIsolatedWorkspaces`, `feedbackDataSharingPreference` |
| `company_memberships` | User ↔ company membership |
| `company_secrets` | Encrypted secrets per company. Includes `github_pat` for workspace PR creation |
| `company_secret_versions` | Secret rotation history |
| `projects` | Departments AND projects. `type`: `'department'` \| `'project'` |
| `goals` | Company goals. Status: planned → active → at_risk → achieved/cancelled |
| `issues` | Tasks. `parentId` = subtask hierarchy. `artifactId` = linked deliverable. Snapshots completion policy, provenance, reviewer source, and acceptance criteria |
| `work_questions` | Durable Ask Human questions linked to task/agent/recipient with answer and continuation state |
| `work_question_continuation_requests` | Durable requests to resume work after a human answer |
| `task_dependencies` | Blocking relationships between tasks |
| `issue_comments` | Task comments. Also used for heartbeat run summary comments |
| `issue_labels`, `labels` | Task labeling |
| `issue_attachments` | File attachments on tasks |
| `issue_read_states` | Per-user read state on tasks |
| `user_entity_follows` | Per-user follow state for company entities |
| `user_notes` | Private user notes attached to company context |
| `comment_wakeup_outbox` | Replay-safe task-comment wake and control effects |
| `issue_approvals` | Approval linkage on tasks |
| `issue_documents` | Document linkage on tasks |
| `activity_log` | Full audit trail |
| `routines` | Scheduled/trigger-based automation |
| `sidebar_preferences` | Per-user sidebar collapse state |
| `inbox_dismissals` | Dismissed inbox items |

### Agents

| Table | Purpose |
|-------|---------|
| `agents` | Agent definitions. `adapterType`, `adapterConfig`, `runtimeConfig` (contextMode, autoRunSummary) |
| `agent_projects` | Agent ↔ project (department) assignments |
| `agent_config_revisions` | Config version history |
| `agent_runtime_state` | Current runtime state |
| `agent_task_sessions` | Per-task execution sessions |
| `agent_wakeup_requests` | Queued wakeup triggers |
| `agent_api_keys` | Per-agent API keys |
| `agent_trust_scores` | Trust score: (approvedWithoutChanges/totalCompleted)×100, last 20 tasks weighted 2× |
| `heartbeat_runs` | Heartbeat execution records |
| `heartbeat_run_events` | Per-event log within a heartbeat run |
| `heartbeat_run_watchdog_decisions` | Watchdog intervention records |

### Memory

| Table | Purpose |
|-------|---------|
| `memory_items` | Core memory store. `layer`: identity/domain/active_context/working. `expiresAt`, `goalId`, `sourceArtifactId`, `embedding` (vector 1536) |
| `memory_item_versions` | Version history. draft/approved/archived lifecycle |
| `memory_feedback_patterns` | Recurring edit patterns. `patternType`, `occurrenceCount`, `status` |
| `memory_folders` | Folder organization for memory items |
| `memory_relations` | Relationships between memory items |
| `memory_retrievals` | Retrieval history for staleness detection |
| `memory_assets` | File assets attached to memory items |
| `memory_extractions` | LLM extraction records |
| `memory_extraction_batches` | Batch extraction records |
| `company_brain_edges` | Company knowledge graph edges used by brain/memory surfaces |

### Discussions

| Table | Purpose |
|-------|---------|
| `discussions` | Thread container. Polymorphic scope (department/project/goal). `status`: active/archived. Denormalized `entryCount`, `pendingItemCount` |
| `discussion_entries` | Individual entries. `inputType`: paste/write/voice/mcp. `extractionStatus`. Entry-level scope override |
| `discussion_entry_attachments` | Asset and artifact references attached to entries |
| `discussion_mention_outbox` | Durable mention summons created with discussion entries |
| `discussion_extracted_items` | Extracted items: decision/task/insight/context/reference/preference. Approval workflow. `resultTaskId`, `resultMemoryId` |
| `discussion_annotations` | Inline annotations. `anchorStart`/`anchorEnd` character offsets |
| `threads` | Thread workspace metadata for the current Discussions UI |
| `thread_scope_versions` | Immutable scope draft/version records for thread planning |
| `thread_scope_items` | Per-item records within a thread scope version |
| `thread_agent_actions` | Agent action records tied to thread orchestration |
| `thread_orchestration_state` | Current orchestration state for thread/crew workflows |
| `debriefs` | @deprecated — kept for rollback safety. New code uses `discussions` |
| `briefs` | @deprecated — kept for rollback safety. New code uses `discussions` |
| `brief_items` | @deprecated — replaced by `discussion_extracted_items` |

### Artifacts & Documents

| Table | Purpose |
|-------|---------|
| `artifacts` | `type`: document/presentation/code/design/report/other. `status`: draft/active/archived. `currentVersionId` |
| `artifact_versions` | Immutable. `versionNumber`, `source` (agent/founder/mcp/teammate/external), `parentVersionId` (branching) |
| `task_outputs` | Additive task-level output index for artifacts, detected files, preview URLs, runtime services, branches, and PRs. Does not replace `issues.artifactId` |
| `documents` | Document system (separate from artifacts; MCP document tools map here) |
| `document_revisions` | Document revision history |
| `assets` | File assets. All file types, 50MB limit |

### Workspaces

| Table | Purpose |
|-------|---------|
| `execution_workspaces` | Per-task git worktrees. `metadata.config` snapshot, `metadata.pr`. Linked to issues |
| `project_workspaces` | Project-level workspace config |
| `workspace_operations` | Workspace lifecycle operations log |
| `workspace_runtime_services` | Dev server service definitions per workspace |
| `environments` | Company-scoped execution environment definitions |
| `environment_leases` | Runtime leases for environment-backed execution |

### Commander (Internal Agent)

| Table | Purpose |
|-------|---------|
| `internal_agent_config` | Per-company: executionMode, provider, model, `autonomyLevel` (Commander dial) + `crewAutonomyLevel` (agent-work dial — D18 split), enabledCapabilities (12 types), budget, proactive interval |
| `internal_agent_conversations` | Multi-chat per user per company. `summarizedContext` for token management. `pinned` (sidebar pin), `sortOrder` (nullable manual drag-order; null = recency/date groups), `archivedAt` |
| `internal_agent_messages` | `role`: user/assistant/system/tool_call/tool_result. `toolCalls`/`toolResults` JSON. `pageContext`, `departmentContext` |
| `internal_agent_runs` | `triggerType`: conversation/proactive/event/sub_agent. `toolsCalled`, `tokenUsage`, `costCents` |
| `internal_agent_reminders` | Scheduled reminders. `triggerAt`, `status`: pending/fired/cancelled |
| `internal_agent_runtime_approvals` | Runtime approval requests for governed Commander/tool actions |
| `internal_agent_tool_trust_rules` | Trust rules for repeated runtime approval decisions |
| `commander_login_challenges` | Company-scoped Commander CLI sign-in challenge state |
| `workflow_templates` | Reusable task chains. `steps` (JSON ordered array), `dependencies` (JSON fromStep/toStep), `instantiationCount` |
| `notifications` / `hubItems` | Physical notifications table plus `hubItems` schema alias for the unified Inbox/Home item index |
| `notification_preferences` | Per-user notification preferences |
| `notification_digest_items` | Digest queue rows for grouped notification delivery |

### Inbox Hub

| Table | Purpose |
|-------|---------|
| `notifications` / `hubItems` | Unified Inbox/Home item index across approvals, runtime decisions, notifications, suggestions, and workflow events |
| `hub_item_user_state` | Per-user read/hidden/dismissed state for hub items |
| `hub_preferences` | Per-user hub grouping and display preferences |
| `hub_counter_snapshots` | Cached counts for sidebar and hub badges |
| `hub_audit` | Audit trail for hub item lifecycle/action handling |
| `hub_autopilot_policies` | Autopilot policy records used by hub routing/automation |

### Teams

| Table | Purpose |
|-------|---------|
| `teams` | Team definitions. `manifest`, `slug`, `status` |
| `team_members` | Team membership |
| `team_coordinations` | Coordination records |

### Marketplace

| Table | Purpose |
|-------|---------|
| `marketplace_catalog_cache` | CDN catalog cache |
| `marketplace_company_settings` | Per-company marketplace settings |
| `marketplace_install_operations` | Installation operation records |
| `marketplace_pending_updates` | Pending catalog updates |

### Plugins

| Table | Purpose |
|-------|---------|
| `plugins` | Plugin definitions |
| `plugin_config` | Plugin configuration |
| `plugin_entities` | Plugin-owned entities |
| `plugin_state` | Plugin runtime state |
| `plugin_jobs` | Async plugin job queue |
| `plugin_logs` | Plugin execution logs |
| `plugin_webhooks` | Plugin webhook registrations |
| `plugin_version_snapshots` | Plugin version history |
| `plugin_company_settings` | Per-company plugin settings |
| `principal_permission_grants` | Fine-grained permission grants (plugin RBAC) |

### Finance & Budget

| Table | Purpose |
|-------|---------|
| `cost_events` | Per-agent/per-run cost records |
| `budget_policies` | Company/department budget limits |
| `budget_incidents` | Budget threshold breach events |
| `finance_events` | Financial events with cost-event slug linkage |
| `provider_quota_windows` | Provider API quota tracking (composite-key UPSERT + staleness warning) |

### Auth & Security

| Table | Purpose |
|-------|---------|
| `auth` | User authentication records |
| `user_profiles` | Global user profile data |
| `company_user_profiles` | Company-specific user profile and operating context |
| `company_user_capability_documents` | Versioned company-specific capability documents |
| `onboarding_progress` | Durable route-driven onboarding completion state |
| `invites` | Company invitations |
| `join_requests` | Join request workflow |
| `user_roles` | RBAC: `founder`/`team_lead`/`team_member`, department-scoped |
| `instance_user_roles` | Instance-level roles |
| `board_api_keys` | Board-level API keys |
| `mcp_api_keys` | MCP authentication keys |
| `mcp_client_connections` | MCP client connection records |
| `cli_auth_challenges` | CLI authentication challenges |
| `runtime_provider_keys` | Runtime provider key metadata/bindings |
| `github_installations` | GitHub App installation records for workspace/repo integrations |

### Feedback

| Table | Purpose |
|-------|---------|
| `feedback_votes` | Thumbs up/down on agent-authored comments |
| `feedback_exports` | Exported feedback bundles (for telemetry transmission) |

### File & Import

| Table | Purpose |
|-------|---------|
| `file_import_jobs` | Background file import job tracking |
| `embedding_queue` | Write-behind outbox for pgvector embeddings. Key columns: `company_id` (per-company key resolution), `next_retry_at` (backoff persistence), `status` (pending/processing/failed). Worker uses `FOR UPDATE SKIP LOCKED`; per-company circuit breaker leaves rows `pending` on systemic key errors. `AOA_E2E_FAKE_EMBEDDER=1` substitutes a hash-based embedder at the `createOpenAiEmbedder` chokepoint for CI. |
| `approvals`, `approval_comments` | Approval workflow |
| `suggestions` | Suggestion engine output. `category` (8 types + agent_proposal), `actionPayload`, `evidence`, `status` |

---

## Workspace System

- **Route:** `/:companyPrefix/workspaces/:workspaceId` → `WorkspaceView` page
- **Layout:** `WorkspaceLayout` — 3-panel resizable (task nav | timeline+preview | context)
- **Mobile:** Tab-based navigation [Tasks][Timeline][Preview][Context] using CSS hidden (not conditional render)
- **functionType:** Project field (`software_development` | `design` | `marketing` | etc.) controls workspace tool visibility
- **executionWorkspacePolicy:** Project field (`per_task` | `shared` | `none`) controls workspace creation
- **TaskSlideOver:** Right-side Sheet — standard (task detail) and workspace (embedded timeline) modes
- **Lifecycle:** Archived workspaces shown in collapsed section
- **Key files:** `ui/src/components/workspace/`, `server/src/services/workspace-runtime.ts`, `packages/db/src/schema/execution_workspaces.ts`

---

## Test Patterns

Tests in `server/src/__tests__/`. Drizzle-orm ESM cycle workaround:

- **Pure function tests:** Import and test directly (e.g., `formatRunSummary`, `detectToneCorrections`, `computeScore`).
- **Service tests with mocks:** Mock `@armyofagents/db` and `drizzle-orm` with Proxy-based table stubs and no-op operators. Use sequence-based mock DBs (`createSequenceDb`) — each `select`/`update`/`insert` returns the next pre-configured result.
- **Contract tests:** Verify API shapes, constants, and formulas without importing drizzle internals.
- **QA suites:** `memory-qa.test.ts`, `artifacts-qa.test.ts`, `integration-qa.test.ts`, `edge-cases-qa.test.ts`, `performance-qa.test.ts`.

---

## Sidebar Structure

```
Home, Inbox, Commander
WORK: Discussions, Tasks, Crew Board, Agents, Routines, Workspaces
COMPANY: Objectives, Memory, Team, Skills, Settings, Budget marker
PLUGINS: dynamic plugin entries
```

Compatibility routes: `/goals` redirects to the Objectives surface, and `/org` redirects to Team. DB/API names remain `goals` and `projects`/`agents`; only the UI label changes.

---

## File Structure

```
packages/db/src/schema/    → Drizzle table definitions
packages/shared/src/       → Types, validators, constants
server/src/services/       → Business logic (one file per domain)
server/src/routes/         → Express route handlers
server/src/adapters/       → Agent execution adapters + registry
server/src/mcp/            → MCP server implementation
server/src/onboarding-assets/ → Agent onboarding templates (cxo/, lead/, default/)
ui/src/components/         → React components
ui/src/pages/              → Page-level components
ui/src/api/                → API client functions
ui/src/lib/                → Shared utilities + constants
```

---

## Documentation Reference

| Location | Purpose |
|----------|---------|
| `docs/architecture/decisions.md` | **Read before making any architectural change.** |
| `docs/architecture/design-system.md` | Visual design system — colors, typography, component patterns |
| `docs/architecture/memory.md` | Memory UI layout, semantic retrieval config, feedback detector details |
| `docs/architecture/wire-compat.md` | Wire protocol compatibility tracking |
| `docs/architecture/workspace-decisions.md` | Workspace-specific architectural decisions |
| `docs/api/` | REST API endpoint reference (per-domain), including MCP, Commander, Discussions, and workflow templates |
| `docs/adapters/` | Adapter authoring guide + per-adapter reference |
| `docs/deploy/` | Deployment modes, env vars, database, Docker, distribution, telemetry |
| `docs/guides/board-operator/` | How-tos for founders and team leads |
| `docs/guides/agent-developer/` | Heartbeat protocol, skill authoring, cost reporting |
| `docs/start/` | What is AoA, quickstart, core concepts |
| `docs/cli/` | CLI command reference |
| `docs/roadmap.md` | Planned features — NOT current behavior |
| `docs/STANDARDS.md` | Documentation lifecycle and session log extraction rules |
| `docs/paperclip-migration.md` | Paperclip→AoA tracking: wire protocol, deprecated tables, removed adapters |
| `docs/archive/` | Historical session logs, shipped plans, retired specs — not authoritative |
