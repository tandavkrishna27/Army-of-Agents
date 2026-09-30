# Discussions Verification — Findings Ledger

**Instance:** isolated `qa-disc` (server :3300, vite :5373 via preview `qa`, embedded-pg :54440). Company **QAD** (`8d7569f2-43e9-4b57-8709-2a4687364e44`). Branch `feat/v1-combined` @ 60ce128f, worktree `AoA-qa` (`qa/discussions-verify`).
**Mode:** report-only. Severity: S1 blocks feature · S2 major · S3 minor · S4 nit.
**Adapter note:** Onboarding seeds crew as **claude_local** (see F1). We tried codex_local (user pick) but it produces no output (see **D1**), so the flow verification runs on **claude_local** (the working default).

---

## Headline

**D1 (S1) — `codex_local` crew agents run but execute NO tool calls (no output).**
Decisive isolation on one thread, same @mention, same dispatch path, only the adapter changed:
- **Scout = codex_local** → run reports `succeeded`, **0 posts**; codex procs accumulate (5→9). Chronicler (codex) `succeeded` but `summary_text` stayed **null**.
- **Scout = claude_local** → posts a real reply in ~55s (`discussion_entries.input_type='agent'`, author=Scout, content references memory search + embedding-unavailable note).

⇒ The orchestration is fine; the **codex adapter** is the problem: codex crew agents complete but never call `post_entry` / summary tools. This is the real cause behind "convene/round-table doesn't work" **when the crew is on codex**. On claude_local the dispatch → participation → MCP `post_entry` chain works end-to-end.
Candidate causes (need adapter-level investigation, not orchestration): codex MCP-tool bridge not wiring AoA tools into the codex session; or codex-with-ChatGPT-account tool execution limitation. Evidence: `thread_orchestration_state.hop_count` incremented (runner ran), `last_error=null`, no `[threads] processMentions error`, no agent entries.

---

## What works (verified)

| Area | Result | Evidence |
|---|---|---|
| Isolated instance boot (pg/server/vite, migrations 0137) | ✅ | health 200, `companies=0` fresh |
| Library build required on fresh worktree | ⚠️ needed `pnpm --filter "./packages/**" build` (plan updated) | server boot ERR_MODULE_NOT_FOUND until built |
| Onboarding wizard (8 steps) end-to-end | ✅ | company QAD created |
| Codex adapter **probe** | ✅ | `test-environment 200`, codex executable + auth |
| Thread create (Discussion type, write) | ✅ | `discussions` row, phase=discuss, controller-path |
| @mention autocomplete | ✅ | "Scout general Agent" option on `@` |
| @mention dispatch → crew reply (**claude**) | ✅ | Scout posted real reply ~55s |
| **Convene / round-table (claude, clean hop budget)** | ✅ | Adjutant convened; **Scout + Engineer + Planner** each posted independent takes; hop settled at 4 (no stall) |
| Chronicler background sweep fires on new entries | ✅ (fires) | `agent_wakeup_requests` source=`sweep.chronicler` succeeded |

**Convene mechanism (confirmed):** Adjutant posts a round-table invite that @mentions the crew → each mention cascades via `post_entry → processMentions → requestParticipation`, one **hop** each, bounded by **HOP_CAP=5**. Works on claude. Two caveats: (a) on **codex** crew nothing posts (D1) so convene looks dead; (b) long round-tables (>~4 agents) hit "Agent loop reached hop cap", and **failed codex participations silently burn hop budget** (each increments hop without posting) — which stalled the first attempt until I reset the counter.

## Findings

| # | Sev | Finding | Evidence |
|---|---|---|---|
| **D1** | **S1** | codex_local crew agents run but produce no output (no post_entry, null summary). claude works. | isolation test above |
| **F1** | **S2** | Onboarding "Choose your Crew = Codex" ignored — crew seeds `claude_local` regardless | all 8 aoa agents `claude_local` after picking Codex |
| **F2** | **S2** | **Reviewer not seeded** by codebase ensure-* (only 7 roles + Commander; marketplace has reviewer) | crew roles: adjutant/scout/engineer/navigator/planner/memory_keeper/chronicler |
| **F3** | **S3** | Engineer has **2 trigger rows** (duplicate role=engineer) → double-dispatch risk | trigger count Engineer=2, others=1 |
| **F4** | **S2** | Codex default model `gpt-5.3-codex` unusable w/ ChatGPT-account auth → Director run 400 | heartbeat_runs error "not supported when using Codex with a ChatGPT account" |
| **F5** | **S4** | Onboarding step-4 crew copy stale — names "Dispatcher" (retired), omits Chronicler + Reviewer | wizard text |
| **F6** | **S3** | `backfillMemoryFolderSeeds` not idempotent — duplicate-key on restart of existing instance (non-fatal) | server log DrizzleQueryError memory_folders |
| **F7** | **S3** | WebSocket `/events/ws` "closed before established" warning (live-events via vite proxy) | browser console |
| **F8** | **S4** | `/containers/attempt-context` 404 with malformed `\\?\C:\...` ref | server log 404 |

## Environment notes (not bugs)

- pgvector absent in embedded-postgres → memory semantic search falls back to text; agents see "embedding service unavailable". Expected (CLAUDE.md).
- "Agent JWT missing" boot warning — NOT the dispatch blocker (crew post via MCP stdio bridge, not authed HTTP).

---

## Flow matrix (verified on claude_local crew)

| Grp | Flow | Result | Notes |
|---|---|---|---|
| A | Create (write) | ✅ | thread + entry; paste/voice/MCP not separately run |
| B | Adjutant proactive (30s debounce, Assist+) | ◑ partial | code-confirmed gate; convene shows Adjutant runs; not isolated-tested |
| C | @mention → reply | ✅ | autocomplete + Scout posted real reply ~55s |
| D | **Convene / round-table** | ✅ | Adjutant convened; Scout+Engineer+Planner each posted; hop settled 4 (no stall on clean budget) |
| — | **Relay / cascade self-advance** | ✅ | cascade advanced Adjutant→Engineer→Planner with NO human nudge between steps — does NOT stall after step 1; bounded by HOP_CAP=5 |
| E | Scope→tasks (+ Drive auto-approve) | ✅ | scope_proposal w/ proposedTasks → auto-approved at Drive → 3 real tasks created |
| F | Crew Board | ✅ | Kanban Todo=3, columns Backlog/Todo/In Progress/In Review/Blocked/Done; route `/QAD/team?tab=aoa&aoaTab=tasks` |
| G | Task exec (dispatched agent does work) | ◑ partial | tasks created + **assigned** (Engineer×2, Planner×1) but stayed `todo` — crew-task auto-dispatch not observed at Drive (follow-up) |
| H | Chronicler summary | ✅ | real summary + routing_terms written (null under codex) |
| I | Navigator / Inbox | ⏳ not run | 1 inbox item present; not exercised |
| J | Memory — Commander recall | ✅ | Commander queried memory+tasks via MCP, synthesized decision+tasks, offered pending memory item (correct governance) |
| K | Dial (Manual/Assist/Drive) | ◑ partial | Drive auto-approve confirmed (E); dial UI shows Manual/Assist/Drive; Manual-suppression not isolated-tested on claude |
| L | UI / chat | ✅ | agent bubbles left / human right; "Adjutant is typing…" presence pill; phase rail; Drive pill |

**Combinations:** #1 full pipeline (create→convene→scope→approve→board) ✅ verified. #2–#5 not run.

## Prioritized triage

1. **D1 (S1)** — codex_local crew produces no output. Investigate codex adapter MCP-tool bridge / tool execution. *Blocks the codex crew path entirely.*
2. **F1 (S2)** — onboarding crew-provider selection ignored (seeds claude). Wire the step-4 pick into crew seeding.
3. **F2 (S2)** — Reviewer not seeded by codebase ensure-*. Add reviewer to the seed set.
4. **F4 (S2)** — codex default model `gpt-5.3-codex` invalid for ChatGPT-account auth. Default to a supported model (e.g. gpt-5.x).
5. **Hop-cap UX (S2/S3)** — HOP_CAP=5 stalls large round-tables; failed participations burn the budget silently. Consider not counting failed/empty participations, and a clearer "continue?" affordance.
6. **F7 (S3)** — `/events/ws` WebSocket never connects via vite proxy → live updates fall back to polling.
7. **F3 (S3)** Engineer duplicate trigger · **F6 (S3)** non-idempotent memory-folder backfill · **F5/F8 (S4)** stale onboarding copy / container-context 404.

## Remaining (not run — honest coverage)

B (isolated proactive), G (crew-task execution dispatch), I (Navigator/Inbox routing), K (Manual suppression isolated), combinations #2–#5. Core pipeline + the user's primary concern (convene/round-table/relay) are verified on the working adapter.

## Net

The discussion **orchestration is sound** on the default claude crew: create → @mention → **convene/round-table (self-advancing cascade)** → scope → auto-approve → tasks → board, plus Chronicler summaries and Commander recall. The single S1 blocker is the **codex adapter (D1)** producing no output, which (stacked with the seeding gaps F1/F2/F4) is why convene looked broken on a codex crew.
