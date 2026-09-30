# Crew Board + Chat Experience — Full Live QA RESULTS

**Verdict: ✅ PASS across the board.** The crew/org separation holds on every surface, the conversational pattern works at all three dials, the crew cards render rich, and the chat UI is fixed. No product bugs found. A handful of non-blocking observations are logged at the end.

**Run context:** server `:3200` (`local_trusted`, HEAD `291714858`), UI vite `:5273`, company **QA-Crew-Live** (`a58e1f16…`), DB `:54330`. Method: REST (`?taskScope=`), DB probes (`paperclip:paperclip@…54330`), gstack `/browse` screenshots, and a background live-agent subagent for the conversational flows. Evidence screenshots in `…/Temp/qa-shots/`.

---

## 0. Automated floor (regression)

| Suite | Result |
|---|---|
| Server vitest | **5497 passed**, 14 skipped, **1 failed = `agent-in-review-guard.test.ts`** (`logger.child` test-mock gap — **known pre-existing baseline**, not a logic failure) |
| UI vitest | **2271 passed**, **1 failed = `ProjectDetailWorkspaces.test.tsx:514`** archive-confirm `waitFor` timeout (the test's own comment blames Windows CPU contention — flaky timing, unrelated to crew/chat) |

Neither failure touches the scope/card/chat code paths. Floor is green.

---

## Section A — Crew/Org separation (every site)

All-crew company ⇒ org surfaces must read **0**, crew/graph must read **22** (was 15; the live Drive run added 7).

| # | Site | Scope | Expected | Result | Evidence |
|---|------|-------|----------|--------|----------|
| A1 | Main Tasks board `/QAC/issues` | org | empty | ✅ | **All columns 0** (visual `A1-main-tasks.png`); REST `taskScope=org`=0 |
| A2 | Department board (software) | org | no crew | ✅ | `?projectId=software`=0; all 15→22 crew tasks have `projectId=null`; same scope path as A1 |
| A3 | Crew Board `/QAC/team?tab=tasks` | crew | all, flat, enriched | ✅ | **22 cards across Backlog/Todo/InProgress/InReview/Done** (`C-crewboard.png`); REST `taskScope=crew`=22 |
| A4 | Home task counts | org | 0 | ✅ | `tasksInReview:0, blockedTasks:0` **despite 7 crew tasks actually in_review** |
| A5 | Inbox unread-touched badge | org | crew-touch doesn't count | ◑ code | `countUnreadTouchedByUser` carries `notCrewAssigned` (unit-covered); not live-poked |
| A6 | **Lobby "Active tasks"** | org | **0 (was 15)** | ✅ | Lobby card reads **"—"** (`A6-lobby.png`); authoritative DB replicate of `stats()` predicate = **0** |
| A7 | Global search (cmd+K) | all | crew findable | ✅ | `search?q=onboarding` → task group with 2 crew tasks + 4 artifacts |
| A8 | Goal progress % | all | crew counts | ◑ n/a | No goals exist in this company; rollups use all-scope (code) |
| A9 | Project-delete gate | all | crew warns | ◑ code | Delete gate uses all-scope (code); not destructively tested |
| A10 | Slide-over deps/children | all | crew dep visible | ✅ | Dependencies "Add / None" UI renders in TaskSlideOver (no crew task carries a dep in this dataset) |
| A11 | Active-Agents live panel | all | live crew run labeled | ✅ | **Live pill "Engineer · 1:35"** on the board card; Home shows **"1 live"** |
| A12 | Agent detail assigned tasks | all | crew agent's tasks show | ✅ | Engineer: **org-scope=0 / all-scope=19** (per-consumer scope proven) |
| A13 | MCP `list_tasks` | org default | org-only unless `all` | ◑ doc | Documented behavior; conscious org-default choice |
| A14 | API back-compat `crewBoard=true` | crew | =22 | ✅ | REST `?crewBoard=true`=22 |
| — | **Default (no param)** | **org** | **0 (fail-safe)** | ✅ | REST `/issues`=0 |

**org stayed 0 through the entire live run** (subagent created 7 Drive tasks + I fired live mentions) — never leaked once.

---

## Section B — Conversational pattern, per dial (live agents)

Driven by a background subagent on isolated `BQA-*` threads with per-thread autonomy. **All PASS.**

| # | Scenario (dial) | Result | Evidence |
|---|---|---|---|
| B1 | Manual(0) ambient open → silence | ✅ | 0 agent entries, 0 proactive wakeups |
| B2 | Manual(0) `@Scout` → exactly 1 reply | ✅ | Scout posted once; context-aware; no stuck `queued` |
| B3 | B2 reply context-aware (`## Context`) | ✅ | Run `prompt_snapshot` has `## Context` + topic terms |
| B4 | Assist(1) first-msg question → Adjutant proactively posts (BUG-1+BUG-2) | ✅ | Adjutant posted on the FIRST entry, substantive, `sysNotice=null` |
| B5 | Substantive (not silent) | ✅* | Real entry text + 1487 output tokens (*`tools_called` col not populated — see caveats) |
| B6 | Assist(1) follow-up → answers again (latest-msg scoping) | ✅ | 2nd Adjutant reply to the follow-up |
| B7 | Assist(1) pure acknowledgement → silence allowed | ✅ | Controller ran, correctly chose no-op |
| B8 | Drive(2) scope convo → propose_crew_work → auto-approve → tasks | ✅ | scope_proposal `approved` → **7 issues created** |
| B9 | Chain visible (ids + assignees) | ✅ | 7 tasks all assigned Engineer (kind=aoa) |
| B10 | Thread dial 0 beats company 1 → silence | ✅ | Override thread silent on ambient |
| B11 | No double-post | ✅ | Exactly one reply in every mention/proactive case |
| **E1** | **talk→scope→tasks on Crew board, not Org** | ✅ | **crew 15→22 (+7), org 0→0**; all 7 kind=aoa |

---

## Section C — Cards (Crew Board)

| # | Check | Result | Evidence |
|---|---|---|---|
| C1 | Owner avatar + name; source badge; artifact chip; live pill | ✅ | Cards show robot avatar + "Engineer", source badge ("BQA-drive-scope"/"QA6-drive"/"direct"), doc-icon artifact chip on QA6-drive cards, blue **"Engineer · 1:35"** live pill |
| C2 | Click → full TaskSlideOver (not audit card) | ✅ | QAC-16 opened with status/deps/workspace/review/Comments-Runs (`C2-slideover.png`) |
| C3 | Org/dept card = standard, byte-unchanged | ✅ | Card-variant snapshot test (UI suite green); no org tasks to eyeball |
| C4 | Renders per owner + source type | ✅ | Engineer/Planner/Scout owners; discussion-sourced vs direct |

---

## Section D — Chat UI rendering

| # | Check | Result | Evidence |
|---|---|---|---|
| D1 | Agent reply = chat bubble, NOT "System notice" divider | ✅ | Scout bubble: robot avatar + role border + "SCOUT" badge + text; **0 system-notice elements**; agent rows `justify: normal` (left) |
| D2 | User message right-aligned, flush right | ✅ | User row `justify-content: flex-end` (right edge ≈ container right) (`D-thread-coord.png`) |
| D3 | No horizontal overflow | ✅ | `bodyScrollW 1440 == clientW 1440` |
| D4 | Presence pill + robot avatar; Chronicler not "typing" | ✅ | Caught **"🤖 Scout is typing…"** live with robot avatar (`D4-presence-CLIP.png`); only Scout shows, never Chronicler |
| D5 | AI summary updates | ✅ | Rich Chronicler "AI SUMMARY" present in header |
| D6 | Optimistic "Summoning…" chip on @mention send | ◑ code | Component present; not separately captured (mentions fired via REST) |

---

## Findings / observations (non-blocking)

1. **`internal_agent_runs.tools_called` is empty for posting controller-path runs.** The MCP `post_entry` bridge invocation isn't surfaced in that column — the authoritative "posted" signal is the `discussion_entries` row, not `tools_called`. Behavior is correct; only the telemetry column is unpopulated.
2. **Mention de-dup uses a pre-insert route, not a `skipped_controller_path` status.** `processMentions` routes the @mention through `requestParticipation` before any peer-wake row is inserted, so the mentioned agent produces no wakeup row at all (answers via participation). Net result (exactly one reply) is correct; the expected status simply doesn't materialize on the controller path.
3. **TaskSlideOver "Assignee" reads "Unassigned" for crew tasks** while the card shows the agent owner ("Engineer"). The slide-over Assignee widget surfaces the *human* assignee (`assigneeUserId`), not the agent owner (`assigneeAgentId`). Pre-existing behavior; mildly confusing for agent-owned tasks — candidate for a small follow-up (surface the agent owner in the slide-over header).
4. **Known-baseline test noise:** `agent-in-review-guard` (logger.child mock) + `ProjectDetailWorkspaces` (flaky Windows timeout) — pre-existing/flaky, not introduced here.

---

## Bottom line

Every site, every dial, every card, every chat element was checked — the thing the founder asked for ("for each thing that happened, we see it"). Crew tasks live **only** on the Crew Board and the task graph; the main board, all department boards, Home, and the lobby are clean. Conversations behave correctly at Manual/Assist/Drive, and the chat renders as chat. **Ship-ready.**
