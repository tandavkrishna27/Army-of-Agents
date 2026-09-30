# AoA Inbox Hub — Tabbed-Workspace Architecture + Bug Fixes

**Status:** Design (for approval) · **Date:** 2026-07-03 · One PR, done in parts.

**Execution sequence (agreed):** investigate → **Part 1: UI layout** (this doc §1-7) → build + live-test → **Part 2: functional bugs** (§ Part 2 below) → live-test one by one. Both parts land in the single Inbox-hub PR.

---

## PART 1 — UI layout (tabbed three-panel)

The Inbox/Approvals hub becomes a **full-bleed, tabbed workspace modeled 1:1 on Discussions** (`ThreadsWorkspace` + `ThreadViewer` + the shared `ViewerTabs`), with panel-size persistence borrowed from Workspace (`react-resizable-panels` + `useDefaultLayout`). Clicking an inbox item opens it as a **tab that hosts the existing detail viewer** for its linked entity (reuse, not rebuild); links inside an item open the linked task/thread/agent/file as their own tabs. The current 360px `HubViewer` aside (with its navigate-away "Open full" button, `HubViewer.tsx:243-254`) is retired as an inline reader and folded into the **Home tab**'s selected-row preview + lifecycle chrome.

Existing proof the pattern works: `RuntimeDecisionPanel` is already hosted inline in the hub (`HubViewer.tsx:260-370`).

---

## 1. Tab model + manager (reuse Discussions')

New `ui/src/components/hub/hubViewerModel.ts` mirroring `threadViewerModel.ts` (`{key,kind,title,closeable,payload?}`, pure `ensureTab` dedupe-by-key, `closeTab`). A `useHubTabs(companyId)` hook owns `tabs[]` (seeded `[HOME_TAB]`, non-closeable) + `activeKey`. `openTab`/`closeTab`/`activateTab` reuse the ThreadsWorkspace helpers verbatim. **Dedupe key = `<kind>:<entityId>`** so re-clicking an item/link re-activates its tab instead of duplicating.

**Persistence + URL:** active item tab → today's `:itemId` path param (deep-links keep working); the rest of the open set → `localStorage` per company (`aoa:hub:tabs:<cid>`), rehydrated on mount, 404-dropped lazily. This mirrors the ThreadsWorkspace split exactly.

## 2. Tab registry — all ~19 item types

Extend `HUB_REGISTRY` (`hubRegistry.tsx`) with `tabKind` + `resolveTabId(item)`. A `HubTabBody` switch (modeled on `ThreadViewerBody`) dispatches on `tab.kind`.

| # | semanticType | tabKind | Reused viewer | Embed status | Links → tabs |
|---|---|---|---|---|---|
| 1 | approval_request | approval | ApprovalDetail + ApprovalPayload | **refactor** → `ApprovalDetailCore(id,embedded)` | task, agent (hire), tasks (crew_dispatch), budget |
| 2 | join_request | join_request | none | **build** `JoinRequestReviewPanel` | created agent |
| 3 | discussion_pending | thread | ThreadDetail(embedded) | **refactor** (thread) | extracted items→task/memory, agent |
| 4 | human_input_needed | thread | ThreadDetail | **refactor** (thread) | asking agent, thread |
| 5 | scope_proposal | thread | ThreadDetail | **refactor** (thread) | proposed tasks, crew_dispatch approval |
| 6 | agent_runtime_decision | runtime_decision | **RuntimeDecisionPanel (already inline)** | **lift** into own module | agent, run |
| 7 | run_failed | run | RunDetail (in AgentDetail) | **build** `RunDetailContainer(runId)` | agent, task |
| 8 | run_complete (reserved) | run | RunDetail | build (same) | agent, artifacts, task |
| 9 | budget_alert | budget | BudgetCapsSection | ready (context) | budget, top agents |
| 10 | agent_error | thread | ThreadDetail / CrewFailureCard | **refactor** (thread) + **fix** hard-coded `/agents/all` | thread, agents, tasks, run |
| 11 | mention | thread | ThreadDetail | **refactor** (thread) + **fix** null link | thread, agent |
| 12 | suggestion | suggestion | none | **build** `SuggestionReviewPanel` | created task/goal/memory |
| 13 | stale_work | task | **TaskDetail (ready, prop-driven)** | ready — cleanest reuse | agent, artifact, task_output |
| 14 | proactive | notification | none | **no tab** (inline in Home) | — |
| 15 | extraction_failed | thread | DiscussionDetail (reprocess) | **refactor** (thread) + **fix** link | thread, failed entry |
| 16 | marketplace_op | marketplace_op | none | **build light** `MarketplaceOpStatusPanel` | install op, catalog→browser, agent |
| 17 | reminder | reminder | none | **build light** `ReminderPanel` | reminder, Commander |
| 18 | routine_outcome (reserved) | routine | RoutineDetail | **refactor** (defer) | routine, runs, tasks |
| 19 | legacy_other | notification | none | **no tab** (inline in Home) | best-effort |

**Cross-cutting sub-entity viewers (all prop-driven, no refactor):** `TaskDetail(issueId,active)`, `TaskOutputViewer`, artifact/file → `resolveViewer` → `SharedContentViewer`/`PdfDocumentViewer`/`BrowserViewer`, `MemoryLinkedViewer`, `BrowserViewer`, `WorkspacePreviewPanel`. Reuse the `taskTab`/`artifactRefTab`/`memoryTab`/`browserTab` factories from `threadViewerModel.ts`.

## 3. Refactor ledger (host existing viewers in tabs)

- **Ready as-is:** TaskDetail, TaskOutputViewer, SharedContentViewer, MemoryLinkedViewer, BrowserViewer, WorkspacePreviewPanel, BudgetCapsSection. RuntimeDecisionPanel needs only to be **lifted** out of HubViewer.
- **Refactor route/Sheet → id-prop panel:** `ApprovalDetailCore(id,embedded)`; **ThreadDetail embeddable-by-prop (highest leverage — unblocks 6 types)**; `AgentDetailContainer(agentId)`; `RunDetailContainer(runId)`; RoutineDetail (defer).
- **Build fresh:** JoinRequestReviewPanel, SuggestionReviewPanel, MarketplaceOpStatusPanel, ReminderPanel, + generic notification fallback (reuse HubViewer's summary/audit body).

Each hosted viewer gets an `onOpenTab(tab)` callback so its links open sibling tabs (established pattern: `ThreadViewer.tsx:355-380`).

## 4. Home tab + lane rail

Home tab (pinned, non-closeable) hosts the existing lane rail + item list (`HubShell`). The retired HubViewer chrome (why/audit/lifecycle footer) folds in as the selected-row preview so lifecycle actions (dismiss/snooze/resolve/archive/claim/release) stay one click from the list. Clicking a row → `openTab(factory(item))`.

## 5. Browser tab

`browser` tab reuses `BrowserViewer(initialUrl)` (or WorkspacePreviewPanel's runtime-service picker). Opened via the `ViewerTabs` `+` (blank URL) or auto when an item carries an external URL / preview. Dedupe `browser:<normalizedUrl>`.

## 6. Full-bleed + resizable layout

- **Full-bleed fix (fixes the sidebar-background bug):** add `"inbox"`/`"inbox-hub"` to `shouldUseFullBleedMain` (`Layout.tsx:35-45`, currently omits inbox), drop `HubShell`'s `h-[calc(100vh-96px)]` for `h-full`.
- **Resizable:** replace fixed widths with `useDefaultLayout` + `<Group>`/`<Panel>`/`<Separator>` (react-resizable-panels, Workspace pattern). Left = lane rail + list; right = `ViewerTabs` strip + active `HubTabBody`. Panel sizes persist per install. Reuse Discussions' `ThreadCollapsedTabStrip` for a collapsed 46px rail.

## 7. Links open tabs + the ID-resolution fix

Links inside viewers call `onOpenTab(taskTab(id))` etc. instead of `navigate()`. **Critical fix:** `hubRegistry`'s `sourceLink` breaks for pushed notifications whose `sourceId` is composite `{relatedEntityId}:{userId}:{type}:{eventId}` (breaks extraction_failed, agent_error, mention, legacy_other). Fix = expose the server-persisted `relatedEntityId`/`relatedEntityType` (`hub-items.ts:408-409,438-439`) on the UI row type (`ui/src/api/hub-items.ts:17-50`, currently absent), prefer it in `resolveTabId`, parse composite only as fallback.

---

## Open decisions (recommendations)

1. **Discussion-family items** (6 thread types): host full ThreadDetail vs focused panels → **Hybrid** (focused panel for single-action items like extraction reprocess / scope approve; full ThreadDetail for pending/mention/human_input). Same refactor cost either way.
2. **Persistence/URL:** → **active tab in path + rest in localStorage per company** (mirrors ThreadsWorkspace; keeps deep-links).
3. **budget_alert:** → **reuse BudgetCapsSection now** (caps editor + util% header), file a spend dashboard as fast-follow.
4. **Reserved/undelivered types** (run_complete, human_input, scope_proposal, routine_outcome): → **build the 3 that reuse RunDetail/ThreadDetail already being built; defer routine_outcome** (no producer, untestable).
5. **proactive / legacy_other** (no entity): → **inline in Home tab, no dedicated tab** (avoids empty tabs).
6. **Tab session state:** → **persist per company in localStorage** + a "close all"/reset control.

## Reuse risks (the real work)

- **ThreadDetail embeddable-by-prop** — highest leverage (unblocks 6 item types); suppress its own rail/breadcrumbs when embedded.
- **ApprovalDetailCore(id,embedded)** — gate breadcrumb/company-route/navigate side-effects behind an `embedded` flag.
- **AgentDetailContainer / RunDetailContainer** — extract fetch-by-prop from the AgentDetail page.
- **TaskDetail** — trivial (drop the `TaskSlideOver` Sheet wrapper; inner is already prop-driven).
- **RoutineDetail** — defer (no producer).
- **hubRegistry ID resolution** — the composite-sourceId fix above.

---

## PART 2 — Functional bugs (from the live QA sweep, 2026-07-03)

Full repro + evidence in `docs/aoa/qa/inbox-hub-2026-07-03/BUGS.md` (+ RESULTS.md, SUMMARY.md, 22 screenshots). Fixed AFTER Part 1 lands, live-tested one by one, same PR.

| ID | Severity | Title | Root cause (verified) | Suspected fix site |
|----|----------|-------|-----------------------|--------------------|
| **BUG-1** | **BLOCKER** | codex_local supervised runs die at the app-server handshake (`Invalid request: missing field 'params'`) — **W5c non-functional live on codex** | `driver.ts:305` sends `client.request("initialize")` with no params; `jsonrpc-client.ts` drops the undefined `params` key from the wire frame; codex 0.130 requires it. Never caught because the driver's real handshake was only ever mocked (the Task-1 spike used its own inline drive). claude_local (W5b) works end-to-end. | `packages/adapters/codex-local/src/server/app-server/driver.ts:305` (+ send the `{clientInfo,capabilities}` params the proven spike used); add a live driver test |
| **BUG-2** | MAJOR | runtime_decision hub items never reconcile to resolved when the decision terminates → phantom "Waiting on you" items pile up, inflate the badge, 409 on click | the runtime_decision projector doesn't close hub items on superseded/expired/cancelled (approval projector does) | the runtime_decision reconcile path in `server/src/services/hub-*` |
| **BUG-3** | MAJOR | InboxHub floods the browser with polling → `ERR_INSUFFICIENT_RESOURCES`; Allow/Deny POST can stall under load (the "slowness" you saw) | prefix-match `invalidateQueries(["hub-items", cid])` refetches all 6 hub queries per mutation (`InboxHub.tsx:234-240,309-319`); `onHubItemChanged` fires an un-batched `getOne()` per item change (`:182-202`) | `ui/src/pages/InboxHub.tsx` — scope invalidations + debounce/batch live updates |
| **BUG-4** | MINOR | SPA fallback 404s on hard-nav/reload of deep `/:prefix/...` routes | server SPA fallback (verify vs prod build) | `server/src/app.ts` SPA fallback |
| **BUG-5** | MINOR | no `run_complete` notification for a succeeded claude run | no live producer emits run_complete (reserved type) | `server/src/services/hub-source-producers.ts` |

**Note (BUG-3 ↔ Part 1):** the Part 1 UI rework touches `InboxHub.tsx` heavily, so BUG-3's query cascade should be fixed as part of that rework (not deferred) — they're the same file. BUG-1 is the standalone codex fix.
