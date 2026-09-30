# Commander Bundle — Capability Report (E2E Audit)

**Date:** 2026-06-15 · **Branch:** `feat/v1-commander-chat` (AoA-commander) · **Method:** code-grounded inventory + live browser drive (real app on `:3201` against Docker pgvector) + Playwright E2E (fake-claude, fresh DB) + component/unit suites + a service-level role-scoping script. Every row cites its evidence; nothing inferred.

**Evidence legend:** `LIVE` = seen working in the real browser this audit · `E2E` = Playwright spec · `UNIT` = component/unit suite (green) · `SVC` = service-level script on real PG · `CODE` = code-grounded inventory (used only for 🚧 deferred / 🔌 needs-config rows).
**Status legend:** ✅ works · ⚠️ partial · ❌ broken · 🔌 needs-config (scaffolding verified, needs a real integration to exercise) · 🚧 deferred/disabled (intentional).

---

## TL;DR

The Commander bundle — **chat + content viewer + cockpit** — is **functionally complete and working**. Live in the real browser: the 4-panel Commander page renders with zero console errors; chat history, the MemoryContextStrip, output-ref chips, the viewer (artifact tab + Home recents + conversation zone), and the cockpit (Pinned + Review + "In this conversation" + Configure) all work against real Postgres. The chat **message pipeline** works end-to-end (send → persist → SSE → render); producing actual agent replies is **🔌 needs-config** (set a CLI tool in Settings — a one-row config; a clean "not configured" error is shown until then). No broken features found. The "build-next" list is all **intentional deferrals** (voice/@-mention/file-attach "coming soon", viewer Phase-2 task/goal refs, a few opt-in cards, mobile tab-bar).

---

## 1. Commander Chat

| Feature | Status | Evidence | Note |
|---|---|---|---|
| Commander page loads (4-panel: sidebar·chat·viewer·cockpit) | ✅ | LIVE | `/PIN/commander`, 1920px, **0 console errors**; screenshot captured |
| Chat history renders (user/assistant bubbles, markdown) | ✅ | LIVE | Q3-brief assistant msg + user bubbles |
| MemoryContextStrip (per-agent context mode) | ✅ | LIVE | "Memory · balanced · commander · identity, domain, active_context, working" |
| Output-ref chip under assistant message | ✅ | LIVE | "Q3 launch brief" chip; click → viewer tab |
| Composer (contenteditable, +/@/mic, send) | ✅ | LIVE | renders; send disabled when empty |
| Send message → persist → SSE → render | ✅ | LIVE | "What are my blocked tasks?" persisted + streamed back |
| Agent produces a reply | 🔌 | LIVE | clean **"Internal agent not configured. Go to Settings"** until a CLI tool is configured (one `internal_agent_config` row); pipeline itself works |
| Copy message / Open reply in viewer | ✅ | LIVE | both buttons present + render reply tab |
| Streaming: thinking / tool_call / tool_result / done | ⏳→ | E2E | covered by `commander-viewer.spec.ts` (fake-claude scripted turns) — see §4 |
| Multi-chat sidebar (new/switch/pin/rename/archive/delete/reorder/search) | ✅ | UNIT + LIVE | New-chat clicked live (no errors); full CRUD + dnd-reorder in `SessionsSidebar` component tests |
| `/skill` token + `+` menu + hover card | ✅ | UNIT | `commanderInputModel` + CommanderInput component tests; tool-finicky to drive headless |
| Action confirmations (allow once/always/deny) | 🔌 | UNIT | needs an agent emitting `action_confirm`; card + dispatch covered by tests |
| Keyboard shortcuts (e.g. New Task) | ✅ | LIVE | global hotkey opened the New-task modal |
| @-mention / Voice / File attach | 🚧 | LIVE | buttons present but **disabled ("coming soon")** |

## 2. Content Viewer

| Feature | Status | Evidence | Note |
|---|---|---|---|
| Open artifact from chip → viewer tab | ✅ | LIVE | tab opened, "Q3 launch brief" selected |
| Tab bar (Home + artifact tabs, switch, close) | ✅ | LIVE | Home + artifact tab + close button |
| Artifact version resolution + empty-state | ✅ | LIVE | "…has no versions yet" (seed artifact had no version — correct handling) |
| Home tab: Recent-from-conversation + Recent-in-company | ✅ | LIVE | both sections populated |
| Conversation zone ("In this conversation") | ✅ | LIVE | "Q3 launch brief · created here" (chat-fed) |
| Resizable 4-panel composition + collapse/expand rails | ✅ | LIVE | viewer + cockpit expand independently at 1920px |
| Auto-open on created ref / streaming refs | ⏳→ | E2E | `commander-viewer.spec.ts` (createArtifactTurn) — see §4 |
| Tab persistence (per-conversation; collapse persists) | ⏳→ | E2E | `commander-viewer-persistence.spec.ts` — see §4 |
| Content-types beyond markdown (PDF/image/code) | 🔌 | CODE | renderers exist; seed/fake-claude only exercises markdown |
| Task/goal refs, branching/lineage UI, Documents | 🚧 | CODE | Phase 2; `COMMANDER_OUTPUT_REF_KINDS = ["artifact"]` today |

## 3. Cockpit

| Feature | Status | Evidence | Note |
|---|---|---|---|
| Batched `/cockpit` load + render | ✅ | LIVE | panel populated, 0 errors |
| Pinned card | ✅ | LIVE | "Review the new Pinned card UX" (Task · In review) |
| Review card | ✅ | LIVE | 2 in_review tasks |
| Conversation zone in cockpit | ✅ | LIVE | "In this conversation (1)" |
| Configure popover (show/hide + opt-in) | ⚠️/✅ | UNIT | "Configure cockpit cards" button live; popover is a Radix portal (tool-finicky headless) — mechanism is component- + localStorage-tested |
| Collapse/expand rail | ✅ | LIVE | cockpit expands/collapses |
| Approvals card — 7 sources, binary/ternary | ✅ | UNIT | `CockpitApprovalsCard` tests (7 sources, ternary runtime); not shown live (demo runtime rows expired/other-user) |
| Approvals **per-role scoping (A4)** founder/lead/member | ✅ | SVC | `a4-live-verify` on real PG: founder=all, lead=dept memory+own runtime, member=own runtime |
| Running / My-tasks / Today / Discussions cards | ✅ | UNIT | component + cockpit-service tests green; not lit live (sparse demo data) |
| Opt-in cards (Goals-at-risk, Budget, Done-today, Proactive, Teammates) | ✅ | UNIT | `cockpit-optin*` tests green; need data to show live |
| All-clear empty state | ✅ | UNIT | `CommanderCockpitPanel` test |

## 4. Playwright E2E (deterministic, fake-claude) — RESULT: 4 passed / 3 failed

Run on Windows against a fresh `aoa_e2e` DB (port 3299), real Postgres, fake-claude on PATH.

- ✅ **`commander-viewer.spec.ts` + `commander-viewer-persistence.spec.ts` — 4/4 PASSED** — chat send→stream (fake-claude scripted turns), tool_call/tool_result indicators, output-ref chip + desktop auto-open, artifact tab render, **tab persistence across reload**. This is the authoritative proof of the chat-streaming + viewer integration end-to-end.
- ✅ **`commander-team-tab.spec.ts` — 3 failed → FIXED → 3/3 PASS.** Root cause (3 stale specs, not a product bug): (a) company-create auto-provisions the full Commander crew (`ensureCommanderAgent`, companies.ts:150) → "No AoA agents yet" is unreachable; (b) the specs queried `commander-subtab-*` testids, but TeamPage renders its own header bar with `aoa-header-subtab-*` and mounts CommanderTeamTab with `showSubTabs={false}` (stale after a refactor); (c) `getByText("Idle")` collided with the 9 agents' status text. **Fixes (commit `93877a485`):** retarget `aoa-header-subtab-*`; rewrite the empty-state test to assert the populated roster (empty state stays component-tested); add `data-testid="kanban-column-*"` to the Kanban headers + use them. Re-run: **3/3 pass**. Team→Commander tab also verified working live on `:3201` (8-agent roster, 0 console errors).

**Net Commander E2E: 7/7 passing** (commander-viewer 4/4 + team-tab 3/3).

## 5. Breadth (component/unit suites — already green)

- **server:** 682 files / 5852 tests pass (incl. cockpit 77, agent-loop, cli-mode, parse-stream-json, output-refs).
- **ui:** ~2598 tests pass (incl. commander/viewer/cockpit component suites).

---

## What's WORKING (verified)
The whole Commander surface renders and operates: 4-panel layout, chat history + MemoryContextStrip + ref chips, message send/persist/stream pipeline, the viewer (artifact tabs, Home recents, conversation zone, version handling), and the cockpit (Pinned, Review, conversation zone, configure, collapse) — all live on real Postgres with zero console errors. Approval role-scoping (A4) is proven on real PG for all three roles. Everything else is covered green by the component/unit suites and the deterministic Playwright specs.

## What's NOT working (broken)
**No broken product features found.** No console errors, no crashes, no broken flows across chat / viewer / cockpit / Team-Commander tab in the audit.

The one red signal — **3 stale E2E specs** (`commander-team-tab.spec.ts`) — has been **FIXED** this session (commit `93877a485`): retargeted to the current `aoa-header-subtab-*` testids, rewrote the unreachable empty-state assertion to verify the populated roster, and added `kanban-column-*` testids to disambiguate the column headers. **All 3 now pass → full Commander E2E is 7/7 green.**

## Bonus surface verified: Team → Commander (AoA Team) tab
| Feature | Status | Evidence |
|---|---|---|
| Roster / Tasks / Kanban / Governance sub-tabs | ✅ | LIVE |
| AoA agent roster (8-agent crew, status + budget cards) | ✅ | LIVE |
| "New AoA Agent" | ✅ | LIVE (button present) |
| Empty-state ("No AoA agents yet") | ⚠️ | unreachable in practice (backfill always provisions a Commander) — the spec asserting it is stale |

## Needs-config (🔌 — works once wired)
- **Agent replies / streaming / tool-calls / action-confirmations:** require a CLI tool configured per company (Settings → Execution & Model, or one `internal_agent_config` row). The pipeline + UI are proven; only the LLM execution needs setup. The "not configured" path is handled gracefully.
- **Non-markdown viewer content** (PDF/image/code): renderers exist; need such an artifact to exercise live.

## Build-NEXT (🚧 — intentional deferrals, ranked)
1. **Chat input completeness:** @-mention, voice input, file attach (all "coming soon" buttons today).
2. **Viewer Phase 2:** task/goal output-refs (widen `COMMANDER_OUTPUT_REF_KINDS`), artifact branching/lineage UI, Documents in Home.
3. **Cockpit depth:** Quick-capture card, Teammates transparency toggle, Done-today artifacts, dept-lead Budget view, per-user crew Running scope; "Brief me" header triage button.
4. **Approvals follow-ups:** grant-based (`joins:approve`) lead delegation for join_request; dept-lead scoping for discussion_item/memory_archive if their routes widen.
5. **Settings UI gaps:** inbound-routing level, autonomy master surface.
6. **Mobile:** the `[Chat][Detail][Cockpit]` tab-bar (cockpit + viewer are desktop-only today).
7. **Sibling epics:** Suggestion-engine harden → Suggestions cockpit card; Google (Calendar/Drive/Gmail).
8. **Proactive:** a "run check now" button (backend timer exists; no manual trigger).
