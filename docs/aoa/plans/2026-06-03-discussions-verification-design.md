# Discussions Feature Set — Full Verification (Design / Spec)

**Status:** approved design (2026-06-03). Next: writing-plans → executable verification plan.
**Branch under test:** `feat/v1-combined` (consolidated trunk; contains crew arc + memory-recall + discussions/memory UI).

## Goal
Exhaustively verify **every** discussion/thread flow — and every meaningful **combination** of flows — on a freshly-seeded `v1-combined` instance, driven through the **real UI** with **live crew agents**. Primary focus: prove whether **convene → round-table → relay** actually works (we suspect relay does not reliably advance). Output a findings report + a prioritized fix list. **No fixes during the pass** — report, then decide together.

## Approach (locked)
- **Browser-driven, full E2E** via `/browse` (real Chromium on the localhost UI) — click every flow as a user.
- **Live crew** via `codex_local` (codex CLI is installed + authed: `codex-cli 0.130.0`, `~/.codex/auth.json`). Agents respond for real.
- **Report-then-decide:** log every finding; no code changes mid-verification.

## Setup — isolated fresh instance (does NOT disturb other live sessions)
- **Worktree:** `git worktree add ../AoA-qa -b qa/discussions-verify feat/v1-combined` (own branch off latest trunk; isolated).
- **Dedicated ports + fresh DB** so "completely fresh" coexists with the other sessions' running servers: server **:3300**, vite **:5373**, embedded-postgres **:54430**, fresh data dir. (⚠️ NOT a global "kill all servers" — that would disrupt the codex/UI session.)
- **Seed via the real onboarding wizard** (browser) — this tests onboarding *as the first flow*; creating the company auto-seeds the crew. Pick **Commander = codex, Crew = codex** → every crew agent runs `codex_local`.

## Flow matrix — exhaustive (the "no gaps" contract)
| Group | Flows |
|---|---|
| **A. Create** | Write · Paste · Voice · MCP inbound · first-entry arms proactive Adjutant |
| **B. Adjutant** | answers a question · answers a follow-up · silence-when-idle · Manual vs Assist |
| **C. @mention** | Scout · Engineer · Planner · Reviewer · Navigator · mention-autocomplete |
| **D. ⭐ Convene** | "team's take" → round-table (parallel) · relay (advance / build-on-last?) · convene per dial |
| **E. Scope→tasks** | suggest scope · `propose_crew_work` card · approve → tasks · Drive auto-approve · Manual/Assist card-approve |
| **F. Crew board** | every agent task shows · source badge resolves · artifact chip · slide-over · crew-vs-org scoping |
| **G. Task exec** | dispatched agent: get_task → comment → artifact → set_status · dial-gated transitions |
| **H. Chronicler** | thread summary card updates · routingTerms |
| **I. Navigator/Inbox** | inbound → attach/promote/defer · routing dial · suggest_new banner |
| **J. Memory** | Memory Keeper proposes · Commander recall (new) · extraction |
| **K. Dial (cross-cut)** | Manual/Assist/Drive across all above · thread override vs company dial |
| **L. UI/chat** | bubbles · typing/presence pills · summoning chip · live kanban |

**Combinations (no combo left out):**
1. Full pipeline: create → convene → scope → approve → board → task exec → artifact.
2. MCP → Navigator route → convene → scope.
3. @mention *during* an active convene.
4. Dial change mid-thread (Manual→Assist→Drive).
5. Two concurrent threads (no cross-talk / no dropped dispatches).

## Convene/relay deep-dive (primary focus)
Dispatch Scout → Engineer → Planner and determine **definitively**: does relay **advance on its own** (Adjutant re-wakes + dispatches the next, each building on the last) or **stall after step 1** (the "exit on no new *human* input" anti-noise heuristic)? Evidence: the thread transcript + the server-log dispatch trace (`agent.dispatch` rows, `fireAdjutantWakeup`, re-dispatch or silence).

## Observe + report
- **Drive:** `/browse` on the localhost UI.
- **Verify under the hood:** psql on the QA DB (`agent_wakeup_requests`, `issues`, `discussion_entries`, board lineage) + server logs (dispatch/run trace) for what the UI doesn't surface.
- **Report format:** per cell — *flow · expected · actual · pass/fail · severity · evidence (screenshot/log ref)* — ending in a triage list.

## Success criteria
Every matrix cell + every combination has a recorded pass/fail **with evidence**; the convene/relay question is answered definitively; we end with a prioritized fix list.

## Non-goals
- No code fixes during the pass (report-only).
- Not testing non-discussion areas (marketplace install, workspaces beyond task-exec, billing) except where a combination touches them.
- Not a load/perf test.
