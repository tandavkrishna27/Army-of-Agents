# Crew Board + Chat Experience — Full QA Plan

**Purpose:** verify *everything* built this session, end to end, across **every site** — the crew/org separation, the whole conversational pattern (per dial), the cards, and the chat UI. "For each thing that happened, we see it."

**Instance under test:** server `:3200`, UI `:5273`, company **QA-Crew-Live** (`a58e1f16…`, 8 crew agents `kind='aoa'`, 0 org agents → every task is crew). DB `postgres://…@127.0.0.1:54330/paperclip`. **Restart the server first** (loads the latest scope + lobby fixes).

**How to run each check:** UI via `/browse` (screenshot evidence) · API via `curl /api/companies/:cid/issues?taskScope=…` · DB via the `packages/db` postgres probe · automated via `vitest` (server + ui) and the Linux-CI integration suites. Set the dial via the internal-agent config (`autonomyLevel` 0/1/2) or per-thread `discussions.autonomyLevel`.

---

## Section A — Crew/Org separation (every site)

**Rule:** crew tasks (assignee = non-terminated `kind='aoa'`) appear ONLY on the Crew Board + the task graph; org surfaces are clean. In this all-crew company: org surfaces = **0**, crew/graph = **15**.

| # | Site | Scope | Expect (this company) | Verify |
|---|------|-------|----------------------|--------|
| A1 | Main Tasks board (`/QAC/issues`) | org | **empty** | /browse screenshot + `GET /issues` = 0 |
| A2 | Department/project board (`ProjectDetail`) | org | no crew cards | /browse the "software" dept board |
| A3 | Crew Board (`/QAC/team?tab=tasks`) | crew | **all 15**, flat, enriched | /browse screenshot + `?taskScope=crew` = 15 |
| A4 | Home / Dashboard task counts | org | 0 active/in-review/blocked | /browse Home + DB home stats |
| A5 | Sidebar Inbox badge (unread-touched) | org | crew tasks you touched don't count | comment on a crew task → badge unchanged |
| A6 | Lobby card "Active tasks" | org | **0** (was 15) | /browse lobby after restart |
| A7 | Global search cmd+K | all | crew tasks **findable** | search a crew task title → appears |
| A8 | Goal progress % | all | crew work **counts** toward goal | link a crew task to a goal → % reflects it |
| A9 | Project-delete gate | all | crew task still **warns** on delete | attempt delete of a project w/ a crew task |
| A10 | TaskSlideOver dependencies / children | all | a crew dep/child is **visible** | open a task, add a crew dep |
| A11 | Active-Agents live panel | all | a live crew run is **labeled** | trigger a crew run → panel shows it |
| A12 | Agent detail "assigned tasks" (a crew agent) | all | crew agent's tasks **show** | open Engineer's page → its tasks |
| A13 | MCP `list_tasks` / `aoa://tasks` | org (default) | org-only unless `taskScope:'all'` | MCP call (documented behavior) |
| A14 | API back-compat `crewBoard=true` | crew | = 15 | `?crewBoard=true` |

**Automated coverage:** predicate unit + per-scope contract + per-consumer scope + real-DB integration (`crew-org-scope.integration.test.ts`, Linux CI) + count-scope + lobby-stats tests.

---

## Section B — Conversational pattern (thread chat, per dial)

Run each fresh-thread flow at each dial; capture the agent reply text + the DB run.

**B-Manual (autonomy 0):**
- B1 create thread + **ambient** first message → **silence** (no proactive join).
- B2 `@Scout` → Scout **answers** (mention always answers), exactly **one** reply, **no stuck `queued`** wakeup (expect `skipped_controller_path`).
- B3 the reply carries injected **`## Context`** (thread history) — not "started blind".

**B-Assist (autonomy 1):**
- B4 create-with-first-message (the BUG-1 path) → Adjutant **proactively joins** (run fires on the FIRST entry).
- B5 Adjutant **posts** a substantive reply (not silent / `tools=[]`) — the BUG-2 fix.
- B6 **follow-up** after an agent already replied → Adjutant **still answers** (the latest-message scoping fix), not silent.
- B7 ambient un-mentioned chatter that needs no reply → silence is still allowed.

**B-Drive (autonomy 2):**
- B8 scoping-ready ambient → Adjutant posts a **`scope_proposal`** (auto-approved) → **tasks created** → assigned to crew → land on the **Crew Board**.
- B9 the full chain visible: discuss → scope → assign → (execute) → review.

**Cross-cutting:**
- B10 thread-level dial override beats company dial (`thread.autonomyLevel ?? company`).
- B11 no double-post / no double-drive (mention path vs proactive debounce de-dup).

---

## Section C — Cards

- C1 **Crew Board card** renders: owner **avatar** (role-colored robot / custom image) + name; **source badge** (`from "<discussion>"` / `<goal>` / `routine` / `direct`) that is **clickable → jumps to origin**; **artifact** chip when a deliverable exists; **live pill** "{agent} · {elapsed}" while running.
- C2 Click a crew card → the **full TaskSlideOver** (assignee, deps, workspace, runs/activity, artifacts, review) — not the old audit card.
- C3 **Org/department card = standard** (PriorityIcon + bare assignee), **byte-unchanged** from pre-enrichment — verified by the card-variant snapshot test (no org tasks exist here to eyeball, so the test is the gate).
- C4 Card renders correctly for each owner (Engineer/Scout/Planner) + each source type (discussion vs direct).

---

## Section D — Chat UI rendering

- D1 **Agent reply = chat bubble** (AgentCard: role-colored border + robot avatar + full text), NOT a muted "System notice" divider. New Adjutant replies have `source_info=null` (no `systemNotice`).
- D2 **User message** = right-aligned bubble, **flush right**, avatar grouped (no 63px gap).
- D3 **No horizontal overflow** (long replies wrap; `bodyScrollW == clientW`).
- D4 **Presence pills**: "{Agent} is {activity}…" with a **default robot avatar** (not a low-contrast violet chip); the background **Chronicler** sweep does NOT show as typing.
- D5 **AI summary** (Chronicler) updates as the thread grows.
- D6 optimistic "Summoning…" chip on `@mention` send; own message appears immediately.

---

## Section E — End-to-end (the whole journey)

E1 Open a thread → talk (Assist) → ask to scope (Drive) → Adjutant proposes tasks → approve → tasks appear on the **Crew Board** (and NOT the main board) → Engineer executes → task moves columns live (pill) → review. **Every step visible and trackable, on the right surface.**

---

## Execution recommendation

1. **Restart** server + UI on the latest commit.
2. **Automated first** — full server suite + UI suite + (Linux CI) the integration suites. The contract/regression floor.
3. **Scripted live matrix** — Section A (sites) + Section B (dials) via `/browse` + API/DB probes; capture a screenshot + the DB state per checkpoint.
4. **Triage** — anything red becomes a fix task; re-verify.

> Known-baseline (not introduced here): `agent-in-review-guard.test.ts` (`logger.child` test-mock) fails pre-existing; Windows e2e is skipped (Issue #114 encoding); the integration tests are the Linux-CI authority.
