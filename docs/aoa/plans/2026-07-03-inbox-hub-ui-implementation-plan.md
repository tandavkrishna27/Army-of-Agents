# Inbox Hub UI — Implementation Plan (Part 1)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Fresh subagent per task + two-stage review. This is **Part 1 (UI layout)** of the one Inbox-hub PR; Part 2 (functional bugs, incl. the codex BLOCKER) follows per `2026-07-03-inbox-hub-tabbed-architecture.md`. **BUG-3 (query flood) is fixed here** (Task F1) because it lives in the file we rework.

**Goal:** Rebuild the Inbox hub as a Discussions-style three-panel tabbed workspace (left lane rail · center list = Home tab · right resizable tabbed viewer), where clicking an item opens a tab that **hosts the existing detail viewer** for its entity, and links inside items open their entities as sibling tabs.

**Architecture:** Reuse the Discussions tab model (`threadViewerModel` factories + a shared `ensureTab`/`closeTab`), a new `useHubTabs` manager (mirrors `ThreadsWorkspace.tsx:78-196`), `react-resizable-panels` + `useDefaultLayout` for the shell (Workspace pattern), full-bleed via `Layout.shouldUseFullBleedMain`. Existing viewers are made tab-embeddable by prop id; a few small panels are built fresh.

**Tech stack:** React + Vite + Tailwind v4, `@tanstack/react-query`, `react-resizable-panels`, vitest + Testing Library. All UI under `ui/src/`.

**Base:** worktree `C:/Users/TK/.aoa/wt/inbox-hub`, branch off `test/inbox-hub-e2e-sweep` (or a fresh `feat/inbox-hub-tabbed`). Design source: `2026-07-03-inbox-hub-tabbed-architecture.md`.

---

## File structure

| File | New/Edit | Responsibility |
|------|----------|----------------|
| `ui/src/lib/viewer-tabs.ts` | New | Generic `ensureTab<T>`/`closeTab<T>` extracted from `threadViewerModel.ts` (shared by threads + hub). |
| `ui/src/components/threads/threadViewerModel.ts` | Edit | Re-import the two helpers from `viewer-tabs.ts` (behavior identical). |
| `ui/src/components/hub/hubViewerModel.ts` | New | `HubTab`, `HubTabKind`, `HubTabPayload` (discriminated union), tab factories, `HOME_TAB`. |
| `ui/src/components/hub/useHubTabs.ts` | New | Tab manager hook: state, open/close/activate, seed Home, re-activate-on-close, localStorage persist, URL active-item sync. |
| `ui/src/components/hub/HubTabStrip.tsx` | New | Horizontal tab bar (active/close/add-browser) + reuse a collapsed icon strip. |
| `ui/src/components/hub/HubTabBody.tsx` | New | `switch(tab.kind)` → hosted viewer (mirrors `ThreadViewerBody`, `ThreadViewer.tsx:293-425`). |
| `ui/src/components/hub/RuntimeDecisionPanel.tsx` | New | Lifted verbatim out of `HubViewer.tsx:260-370`. |
| `ui/src/components/hub/HubShell.tsx` | Edit (major) | Replace CSS-flex 2-pane with `react-resizable-panels` 3-panel; right panel = `HubTabStrip` + `HubTabBody`. |
| `ui/src/pages/InboxHub.tsx` | Edit (major) | Wire `useHubTabs`; `handleSelectItem` → `openTab`; scope invalidations (BUG-3). |
| `ui/src/components/hub/HubHomeTab.tsx` | New | The Home tab body: existing lane list + the folded-in selected-row preview/lifecycle chrome (from `HubViewer`). |
| `ui/src/components/hub/hubRegistry.tsx` | Edit | Add `tabKind` + `resolveTabId(item)`; prefer `relatedEntityId`. |
| `ui/src/api/hub-items.ts` | Edit | Expose `relatedEntityId`/`relatedEntityType` on `HubItemListRow`. |
| `ui/src/components/Layout.tsx` | Edit | Add `"inbox"`/`"inbox-hub"` to `shouldUseFullBleedMain`. |
| `ui/src/pages/ApprovalDetail.tsx` + `ui/src/components/approval/ApprovalDetailCore.tsx` | Edit + New | Extract `ApprovalDetailCore(approvalId, embedded, onOpenTab?)`. |
| `ui/src/pages/ThreadDetail.tsx` | Edit | Accept `discussionId` prop (fallback to `useParams`); suppress rail/breadcrumbs when `embedded`. |
| `ui/src/components/agent-detail/AgentDetailContainer.tsx` + `.../RunDetailContainer.tsx` | New | Fetch-by-prop wrappers for agent + run tabs. |
| `ui/src/components/hub/panels/{JoinRequestReviewPanel,SuggestionReviewPanel,MarketplaceOpStatusPanel,ReminderPanel}.tsx` | New | Small fresh panels for the 4 no-viewer types. |

---

## Phase A — Shell foundation (full-bleed + resizable 3-panel)

### Task A1 — Full-bleed the inbox (also fixes the sidebar-background bug)
**Files:** Edit `ui/src/components/Layout.tsx` (`shouldUseFullBleedMain`, ~35-45); Test `ui/src/components/__tests__/Layout.fullbleed.test.ts`.

- [ ] **Step 1 (failing test):** assert `shouldUseFullBleedMain("/QAL/inbox", "QAL") === true` and `.../inbox/waiting/123` true. Run → FAIL.
- [ ] **Step 2 (impl):** add `section === "inbox" || section === "inbox-hub"` to the OR-list (next to `discussions`/`threads`).
- [ ] **Step 3:** test passes; confirm existing discussions/workspaces cases unchanged.
- [ ] **Step 4:** in `HubShell.tsx:246`, drop `h-[calc(100vh-96px)] min-h-[520px] border-y` → `h-full` (matches `ThreadsWorkspace`). Commit.

### Task A2 — HubShell resizable 3-panel skeleton
**Files:** Edit `HubShell.tsx`; Test `ui/src/components/hub/__tests__/HubShell.layout.test.tsx`.

- [ ] **Step 1 (REAL API — copy from `WorkspaceLayout.tsx:64-68,452-500`, do NOT paraphrase):**
```ts
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
const { defaultLayout, onLayoutChanged } = useDefaultLayout({
  id: "aoa:hub:panel-sizes", storage: localStorage, panelIds: ["hub-list", "hub-viewer"],
});
```
- [ ] **Step 2 (DESKTOP layout — the prop is `orientation` NOT `direction`; sizes are STRING percents; `<Separator>` has NO `withHandle`):**
```tsx
<Group orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
  <Panel id="hub-list" defaultSize="38%" minSize="24%"> {/* center list */} </Panel>
  <Separator className="w-1 bg-border hover:bg-border-strong" />
  <Panel id="hub-viewer" minSize="30%"> {/* tabbed right (Phase C) */} </Panel>
</Group>
```
The `<HubRail>` stays a fixed-width element to the LEFT of the `<Group>` (not a Panel). **Mobile:** render the `<Group>` ONLY on desktop (`isMobile` gate, per `WorkspaceLayout.tsx:31-36`); on mobile keep the existing CSS-stacked layout + the mobile rail dialog (`HubShell.tsx:255-280`) — do NOT put the resizable Group on mobile or it fights the rail.
- [ ] **Step 3 (test):** render desktop → assert two `Panel`s + a `Separator`; render mobile (matchMedia mock) → assert the stacked layout + rail dialog, no Group. Commit. (Right panel content wired in Phase C.)

---

## Phase B — Tab model + manager

### Task B1 — Extract generic tab helpers + build the hub tab model
**Files:** New `ui/src/lib/viewer-tabs.ts`; Edit `threadViewerModel.ts`; New `ui/src/components/hub/hubViewerModel.ts`; Tests `ui/src/lib/__tests__/viewer-tabs.test.ts`, `ui/src/components/hub/__tests__/hubViewerModel.test.ts`.

- [ ] **Step 1:** create `viewer-tabs.ts` with generics:
```ts
export interface ViewerTabBase { key: string; closeable: boolean }
export function ensureTab<T extends ViewerTabBase>(tabs: T[], tab: T): T[] {
  return tabs.some((t) => t.key === tab.key) ? tabs : [...tabs, tab];
}
export function closeTab<T extends ViewerTabBase>(tabs: T[], key: string): T[] {
  return tabs.filter((t) => t.key !== key || !t.closeable);
}
```
- [ ] **Step 2:** `threadViewerModel.ts` re-exports these (delete its local copies at :230-236, import from `viewer-tabs`). Run the existing threads tests → still green (behavior identical).
- [ ] **Step 3 (failing test):** `hubViewerModel.test.ts` — `approvalTab("a1").key === "approval:a1"`, `taskTab("t1").kind === "task"`, `ensureTab` dedupes same key, `HOME_TAB.closeable === false`.
- [ ] **Step 4 (impl):** `hubViewerModel.ts`:
```ts
export type HubTabKind =
  | "home" | "browser" | "approval" | "join_request" | "thread"
  | "runtime_decision" | "task" | "task_output" | "agent" | "run"
  | "artifact" | "memory" | "budget" | "suggestion" | "marketplace_op"
  | "reminder" | "routine" | "notification";
export interface HubTab extends ViewerTabBase { kind: HubTabKind; title: string; payload?: HubTabPayload }
export const HOME_TAB: HubTab = { key: "home", kind: "home", title: "Home", closeable: false };
export function approvalTab(id: string, title = "Approval"): HubTab { return { key: `approval:${id}`, kind: "approval", title, closeable: true, payload: { approvalId: id } }; }
export function threadTab(id: string, title = "Discussion", entryId?: string): HubTab { return { key: `thread:${id}`, kind: "thread", title, closeable: true, payload: { discussionId: id, entryId } }; }
export function runtimeDecisionTab(itemId: string, title = "Decision"): HubTab { return { key: `runtime_decision:${itemId}`, kind: "runtime_decision", title, closeable: true, payload: { itemId } }; }
// + taskTab, agentTab, runTab, budgetTab, suggestionTab, joinRequestTab, marketplaceOpTab, reminderTab, browserTab (dedupe key `browser:<normalizedUrl>`), notificationTab
```
Payload is a discriminated union keyed by the entity id each viewer needs. Commit.

### Task B2 — `useHubTabs` manager hook
**Files:** New `ui/src/components/hub/useHubTabs.ts`; Test `.../__tests__/useHubTabs.test.tsx` (renderHook).

- [ ] **Step 1 (failing tests):** open dedupes (same key → re-activate, no dup); close active → re-activates `nextTabs.at(-1)?.key ?? null`; Home never closes; state persists to `localStorage("aoa:hub:tabs:<cid>")` and rehydrates.
- [ ] **Step 2 (impl):** mirror `ThreadsWorkspace.tsx:78-196`:
```ts
export function useHubTabs(companyId: string | undefined) {
  const [tabs, setTabs] = useState<HubTab[]>(() => rehydrate(companyId) ?? [HOME_TAB]);
  const [activeKey, setActiveKey] = useState<string | null>(HOME_TAB.key);
  const openTab = useCallback((tab: HubTab) => { setTabs((t) => ensureTab(t, tab)); setActiveKey(tab.key); }, []);
  const closeTab = useCallback((key: string) => setTabs((t) => { const next = closeTabHelper(t, key); setActiveKey((a) => (a !== key ? a : next.at(-1)?.key ?? null)); return next; }), []);
  const activateTab = useCallback((key: string) => setActiveKey(key), []);
  useEffect(() => persist(companyId, tabs), [companyId, tabs]);
  return { tabs, activeKey, openTab, closeTab, activateTab };
}
```
Persist stores `{kind, key, title, payload}` (payload is already plain-serializable). Rehydrate drops nothing eagerly (lazy 404-drop handled by each viewer). Commit.

---

## Phase C — Tab strip + viewer body

### Task C1 — HubTabStrip
**Files:** New `ui/src/components/hub/HubTabStrip.tsx`; Test `.../__tests__/HubTabStrip.test.tsx`.

- [ ] **Step 1 (failing test):** renders one button per tab; active tab has `aria-selected`; clicking a tab calls `onActivate(key)`; the `×` calls `onClose(key)` and is absent on `home` (non-closeable); a `+` calls `onAddBrowser`.
- [ ] **Step 2 (impl):** horizontal strip; each tab shows `HUB_REGISTRY[..].icon` or a kind icon + `title`; reuse the collapsed icon-rail pattern from `ThreadViewer.tsx:212-271` (`ThreadCollapsedTabStrip`) for the collapsed state via `onToggleCollapse`. Commit.

### Task C2 — HubTabBody (dispatch, ready kinds first)
**Files:** New `ui/src/components/hub/HubTabBody.tsx`; Test `.../__tests__/HubTabBody.test.tsx`.

- [ ] **Step 1 (failing test):** `kind:"task"` renders `<TaskDetail issueId active/>`; `kind:"browser"` renders `<BrowserViewer/>`; `kind:"notification"` renders the generic summary body; `kind:"home"` renders `<HubHomeTab/>` (Phase E). Unknown kind → null (no crash).
- [ ] **Step 2 (impl):** `switch(tab.kind)` mirroring `ThreadViewerBody` (`ThreadViewer.tsx:293-425`), casting `tab.payload` per kind, passing `onOpenTab` into each child. Wire the kinds whose viewers are already prop-driven now (`task`→TaskDetail, `task_output`→TaskOutputViewer, `artifact`→ArtifactAttachmentViewer via `resolveViewer`, `memory`→MemoryLinkedViewer, `browser`→BrowserViewer, `budget`→BudgetCapsSection, `notification`→generic). Other kinds render a `<TabLoadingPlaceholder/>` until Phase D lands them (never fall through to `null`). **A2-review caveat:** the current `HubViewer` root aside is fixed `lg:w-[360px] shrink-0` with its own `lg:border-l`. When the viewer becomes the tabbed body here, make the tab body `w-full h-full` (fluid) and DROP the fixed 360px + the `border-l` — otherwise dragging the viewer panel wider leaves an empty gutter, and dragging the list panel wide clips the aside (`shrink-0` + panel `overflow-hidden`). Commit.

---

## Phase D — Embeddable refactors (the real work)

### Task D1 — Lift RuntimeDecisionPanel
**Files:** New `ui/src/components/hub/RuntimeDecisionPanel.tsx` (move `HubViewer.tsx:260-370` verbatim, export it); Edit `HubViewer.tsx` (import from new module); wire `HubTabBody` `kind:"runtime_decision"` → `<RuntimeDecisionPanel item={payload.item}/>`.

- [ ] **Step 1:** move the component + its local helpers, keep props identical. **Step 2:** the existing hub tests that mount RuntimeDecisionPanel still pass. **Step 3:** `HubTabBody` renders it for the decision tab. Commit. (No behavior change — proven pattern.)

### Task D2 — ThreadDetail embeddable-by-prop (unblocks 6 item types)
**Files:** Edit `ui/src/pages/ThreadDetail.tsx`; Test `.../__tests__/ThreadDetail.embedded.test.tsx`.

- [ ] **Step 1 (failing test):** `<ThreadDetail discussionId="d1" embedded/>` renders the thread for `d1` WITHOUT calling `useParams`, and does NOT call `setBreadcrumbs`/render its own rail.
- [ ] **Step 2 (impl):** add `discussionId?: string` + `embedded?: boolean` props; `const id = discussionId ?? params.discussionId`; gate breadcrumb/rail/route side-effects behind `!embedded`. Full-page route usage passes no props (unchanged). **Step 3:** existing ThreadDetail route tests green; new embedded test green. **Step 4:** `HubTabBody` `kind:"thread"` → `<ThreadDetail discussionId={payload.discussionId} embedded onOpenTab={...}/>`. Commit.

### Task D3 — ApprovalDetailCore extraction
**Files:** New `ui/src/components/approval/ApprovalDetailCore.tsx`; Edit `ui/src/pages/ApprovalDetail.tsx`; Test `.../__tests__/ApprovalDetailCore.test.tsx`.

- [ ] **Step 1 (failing test):** `<ApprovalDetailCore approvalId="a1" embedded onOpenTab={spy}/>` renders the payload body + Approve/Reject, and on a linked issue calls `onOpenTab(taskTab(issueId))` instead of `navigate`.
- [ ] **Step 2 (impl):** move the body (payload renderer + actions) into `ApprovalDetailCore(approvalId, embedded, onOpenTab?)`; take id as prop (fallback `useParams`); gate `setBreadcrumbs`/`setSelectedCompanyId`/`navigate` behind `!embedded`; when embedded, approve/reject just refetch (no navigate). `ApprovalDetail.tsx` becomes a thin route wrapper rendering `<ApprovalDetailCore approvalId={param}/>`. **Step 3:** route + embedded tests green. **Step 4:** wire `HubTabBody` `kind:"approval"`. Commit.

### Task D4 — Agent + Run containers  ⚠️ BIGGER THAN ONE TASK (per review)
**Files:** New `AgentDetailContainer.tsx`, `RunDetailContainer.tsx`; **Edit** `ui/src/pages/AgentDetail.tsx` (export `RunDetail`); possibly `ui/src/api/heartbeats.ts` + `server/src/routes/agents.ts`; Tests each.

- [ ] **D4a — AgentDetailContainer(agentId):** replicate AgentDetail's fetch orchestration (agent + runtimeState + heartbeats + issues + trustScore) by prop id (no `useParams`), feeding the already-prop-driven `AgentDetailCore`. Test with mocked queries. Wire `HubTabBody` `kind:"agent"`.
- [ ] **D4b — Run tab needs `{runId, agentId}`, NOT just runId (review P1):** `RunDetail` is a **non-exported inner fn** at `AgentDetail.tsx:1601` and takes `{ run: HeartbeatRun, agentRouteId, adapterType }` (agent-derived). `heartbeatsApi` (`heartbeats.ts:45-70`) has NO single-run getter. So: (1) **export** `RunDetail` from AgentDetail; (2) the `run` hub items carry `sourceId=runId` — the run tab factory must ALSO carry `agentId` (from `relatedEntityId`/the item's agent ref); (3) `RunDetailContainer({runId, agentId})` fetches `heartbeatsApi.list(companyId, agentId)`, `.find(r => r.id === runId)`, derives `adapterType` from the agent query, and renders `<RunDetail run agentRouteId adapterType/>`. Prefer this over adding a `GET /heartbeat-runs/:runId` endpoint (keeps it UI-only). If the agent id is unavailable on the item, fall back to opening the agent tab (RunsTab) instead. Test the list-find + adapter-derive path. Wire `HubTabBody` `kind:"run"`.

(RoutineDetail deferred — no producer.)

---

## Phase E — Registry, Home tab, fresh panels

### Task E1 — Registry tabKind + ID resolution fix
**Files:** Edit `hubRegistry.tsx`, `ui/src/api/hub-items.ts`; Test `.../__tests__/hubRegistry.resolveTab.test.ts`.

- [ ] **Step 1 (failing test):** `resolveTabId(approvalItem) === approvalItem.sourceId`; for a pushed notification with composite `sourceId="ent:user:type:evt"` and `relatedEntityId="ent"`, `resolveTabId === "ent"` (prefers relatedEntityId), NOT the composite.
- [ ] **Step 2 (impl):** add `relatedEntityId?: string`/`relatedEntityType?: string` to `HubItemListRow` (`hub-items.ts:17-50`) — already persisted server-side (`hub-items.ts:408-409,438-439`), just surface it. Add `tabKind: HubTabKind` + `resolveTabId(item)` per registry entry (prefer `relatedEntityId`, fallback split composite on `:`). Fix `agent_error`'s hard-coded `/agents/all` → its real discussion source. Commit.

### Task E2 — Home tab + open-on-click
**Files:** New `HubHomeTab.tsx`; Edit `InboxHub.tsx`, `HubShell.tsx`.

- [ ] **Step 1:** `HubHomeTab` renders the existing lane list (`HubList`) + a compact selected-row preview built from the retired `HubViewer` chrome (why/audit/lifecycle actions: dismiss/snooze/resolve/archive/claim/release). **Step 2:** replace `handleSelectItem` (`InboxHub.tsx:554-562`) → on row click, `openTab(factoryFor(item))` where `factoryFor` maps `HUB_REGISTRY[item.semanticType].tabKind` + `resolveTabId` to the right factory; also reflect the active item in the `:itemId` URL (keep deep-links). **Step 3:** deep-link `/inbox/waiting/<id>` opens that item's tab active on load. **Step 4:** delete the old right-side `HubViewer` aside from HubShell (its chrome now lives in Home + tabs). Commit.

### Task E3 — Fresh small panels
**Files:** New `panels/{JoinRequestReviewPanel,SuggestionReviewPanel,MarketplaceOpStatusPanel,ReminderPanel}.tsx`; Tests each.

- [ ] **Step 1:** `JoinRequestReviewPanel(id)` — hub-row fields + `accessApi.approve/rejectJoinRequest`. `SuggestionReviewPanel(id)` — title/evidence/why + one CTA per `actionType`, Accept = `suggestions` accept API; on accept, `onOpenTab(taskTab/memoryTab)` for the created entity. `MarketplaceOpStatusPanel(sourceId)` + `ReminderPanel(id)` — light status + actions. **Step 2:** tests per panel (renders, primary action fires). **Step 3:** wire their `HubTabBody` kinds. Commit.

---

## Phase F — BUG-3 (query flood) — fixed here

### Task F1 — Scope invalidations + debounce live updates
**Files:** Edit `InboxHub.tsx` (mutations ~231-346, live-update ~182-202); Test `.../__tests__/InboxHub.invalidation.test.tsx`.

- [ ] **Step 1 (failing test):** toggling a preference invalidates ONLY the preferences + counts keys (assert the broad `["hub-items", cid]` prefix invalidate is gone); a burst of N `onHubItemChanged` pokes results in ≤1 refetch within the debounce window.
- [ ] **Step 2 (impl):** replace each `invalidateQueries({ queryKey: ["hub-items", selectedCompanyId] })` with the specific keys that actually changed (preferences/autopilot/counts as applicable — NOT the list unless the list changed). Debounce/coalesce `onHubItemChanged` (batch item pokes; dedupe by itemId within ~250ms) so a batch action fires one refetch, not 10. **Step 3:** tests green; manual: the Network tab no longer floods on preference/autopilot toggles. Commit.

---

## Phase G — Integration + verification

### Task G1 — Wire it all + remove dead code
- [ ] `HubShell` right panel = `<HubTabStrip .../>` + `<HubTabBody tab={activeTab} onOpenTab={openTab} companyId={selectedCompanyId} resolveHubItem={...}/>`; `InboxHub` provides `useHubTabs`. Home tab default. Remove the old single-item `HubViewer` aside + its navigate-away button.
- [ ] **D2-review seam (must-do):** `HubTabBody` MUST be passed a concrete `companyId`. If it's `undefined`, an embedded `ThreadDetail` falls back to context which on the Inbox route can be undefined → the thread query stays disabled and the tab shows a skeleton forever with no error. Add a test asserting the hub passes a real `companyId`.
- [ ] Wire `resolveHubItem` (the D1 prop): supply `(hubItemId) => loadedItems.find(...) ?? getOne(...)` so `runtime_decision`/`notification` tabs resolve their hub item.
- [ ] **Full typecheck:** `pnpm --filter @armyofagents/ui typecheck`. **Unit:** `pnpm test:run` for all new suites + the existing hub/threads suites (no regression). Commit.

### Task G2 — Live UI verification (the "you check it" step)
- [ ] Build + relaunch the QA instance (`localhost:3399`), drive `/browse`: full-bleed (no doubled sidebar bg), resize the panels (persists on reload), click a Notification item → opens a tab hosting its viewer, open a Browser tab, click a link inside an item → opens that entity as a sibling tab, close tabs (Home never closes), reload → tabs rehydrate. Capture screenshots. **Report the URL to the user for their own check.**

---

## Implementation decision — reading-pane model (E2/G1, 2026-07-04)

The three-panel shell landed as **rail | center list | right tabbed viewer** with an
**email-client interaction**, not "every click opens a tab":

- **Single-click a row / deep-link `/inbox/:lane/:itemId`** → the item previews in the
  **Home reading pane** (right panel, Home tab): `HubViewer` in `variant="tab"` fill mode,
  carrying its why / meta / audit / lifecycle actions (dismiss/snooze/resolve/archive/
  claim/release/mark-unread) and the runtime-decision panel. No auto-tab (so keyboard j/k
  and history triage don't spawn tabs). This is why the existing InboxHub "viewer" +
  runtime-decision + audit tests keep passing unchanged.
- **"Open full" (in the reading pane) / linked entities inside a hosted viewer / the `+`
  button** → open **dedicated closeable tabs** hosting the real detail viewers
  (`ApprovalDetailCore` / `ThreadDetail` / `AgentDetailContainer` / `RunDetailContainer` /
  `TaskDetail` / `RuntimeDecisionPanel` / `BrowserViewer`). Home is non-closeable.
- Deep-link hydrates a hidden/resolved/cross-lane item via `hubItemsApi.getOne` so the
  reading pane can still preview it; `:itemId` stays a **hub-item id** (never an entity id).
- `HubList` gained an optional `onOpenItem` (click-opens-tab) that is intentionally **not
  wired** yet — it's the one-line seam to flip to "single-click opens a tab" if the founder
  prefers that after the live look. **Flag this choice to the user at G2.**

## Deferred UX polish (from D2/D4/E1 reviews — later phase, non-blocking)
- **Run tab agentId (E1 gap):** `run_failed`/`run_complete` items carry `run.id` but NOT the agent id on `HubItemListRow` (server sets `sourceActorId: run.agentId`). So `hubTabForItem` falls back to `notificationTab` for runs. To open a real Run tab from the inbox, surface `sourceActorId` (or `relatedEntityId=agentId`) on the UI row + have `hubTabForItem` use it in `runTab(runId, agentId)`. Small UI-type add if the server already returns `sourceActorId`.
- **Thread `entryId` anchor:** `HubThreadPayload.entryId` is carried but `ThreadDetail` has no prop to scroll/highlight the entry — wire it or drop the field.
- **Agent-tab Runs list:** inside the embedded agent tab, the `RunsTab` run rows are `<Link>`s that route-navigate away — thread `onOpenTab(runTab(runId, agentId))` into `RunsTab` when embedded so a run opens as a sibling hub tab.
- **Agent-tab hero KPIs:** the container drops the `to:` deep-links on "Tasks (wk)"/"Last run" KPIs — re-add as `onOpenTab(taskTab/runTab)` when embedded.

## Review corrections (Codex + staff-eng, folded 2026-07-04)

Read alongside the task. The two P1s (A2 panels API, D4 run fetch) are already fixed inline above.

- **B1 (clarify):** `viewer-tabs.ts` shares ONLY the two pure array ops (`ensureTab`/`closeTab`). Active-tab RE-SELECTION differs per manager and stays per-hook: threads re-activate `next[0]?.key` (`ThreadDetail.tsx:290`), hub re-activates `next.at(-1)?.key`. Do NOT try to unify re-activation.
- **B2 (rehydration safety):** the persisted blob gets a `version` field + a `try/catch` that resets to `[HOME_TAB]` on parse/shape mismatch + a **max-tab cap** (e.g. 12). A stale `HubTabPayload` shape must not crash a viewer.
- **C1 (a11y):** the tab strip must wire `role="tablist"`/`role="tab"`/`aria-controls` + focus management on close (match `ThreadDetail.tsx:1244-1289`). Add these asserts to the C1 test.
- **C2 (ordering fix):** `HubHomeTab` doesn't exist until E2 — do NOT assert `kind:"home"`→`<HubHomeTab/>` in C2. In C2 render a trivial Home stub (E2 replaces it). Non-ready kinds return an explicit `<TabLoadingPlaceholder/>` (never fall through to `null`, so the tab chrome still renders).
- **D2 (precise gating — the rail is ALREADY gated at `ThreadDetail.tsx:908`, don't re-do it):** add `discussionId?`/`companyId?` props; use prop before `useParams`; **key the query + tab-reset effect on the prop** (`:228-233,:266-270`). Gate `setBreadcrumbs`/`setSubtitle`/`setEntityColor` (`:668-680`) behind `!embedded`. **Decide the live-WS policy:** `subscribeThread`/`sendPresence`/`onReconnect` (`:343-361`) fire regardless of `embedded` — opening a thread tab opens a WS sub + 8s presence interval per tab; decide keep-or-suppress-when-embedded and state it.
- **D3 (Approval — 4 route couplings to neutralize when embedded, ~1.5 tasks):** `setSelectedCompanyId({source:"route_sync"})` (`:57-60`), the `useSearchParams` `resolved=approved` success banner (`:25,:159`), BOTH `navigate` sites — approve (`:100`) and agent-delete (`:147`), and `resolvedCta`/linked-task `<Link>`s (`:161-178,:248-255`) → replace with `onOpenTab(taskTab(id))`. When embedded, approve/reject just refetch (no navigate, no company-route-sync).
- **E1 (ID resolution — per-semanticType, NOT a generic split):** `sourceId.split(":")[0]` is WRONG — mentions are `taskId:userId` OR `threadId:entryId:userId` (`issues.ts:2191`, `threads.ts:319`), marketplace is `install_completed:operationId:userId` (`marketplace-notifications.ts:49`) where the entity id is NOT first. So: **always prefer `relatedEntityId`** (verified persisted + returned via row spread, `hub-items.ts:227`, `notifications.ts:36,38`); only if absent, parse per `semanticType`/`sourceType` with a small map, never a blanket `[0]`.
- **E2 (URL conflict — real desync bug):** today `:itemId` is a HUB-ITEM id validated against loaded `items` (`InboxHub.tsx:481-485`). A tab's entity is a task/thread/agent id (via `resolveTabId`) ≠ hub-item id. **Do NOT push entity-tab ids into `:itemId`.** Keep `:itemId` = the Home-selected hub item only; the open-tab set lives in state + localStorage (not the path). Deep-link `/inbox/:lane/:itemId` opens the Home selection AND its entity tab, but only the hub-item id is in the URL.
- **E2 (deep-link hydration):** selecting `:itemId` currently only works if the item is in a loaded page (`InboxHub.tsx:481-485`). Add an explicit `hubItemsApi.getOne(cid, itemId)` hydration for hidden/resolved/not-yet-loaded items before opening its tab.
- **E2 / G1 (HubViewer teardown — order-sensitive):** do NOT delete `HubViewer.tsx` wholesale. It holds RuntimeDecisionPanel (D1 relocates it) AND the summary/audit body (E2's Home preview reuses it). E2 removes only the *aside usage* from HubShell; the file is deleted in G1 ONLY after D1's extraction + the Home-preview relocation are merged.
- **F1 (BUG-3 scope — don't over-narrow, don't double-debounce):** the LIST query shape depends on `groupMode`/visible-lanes (`InboxHub.tsx:381-389,402-406`), so KEEP list refetch for those; only drop the broad `["hub-items", cid]` invalidate for preference/autopilot fields that DON'T shape the list. And note: `LiveUpdatesProvider` (`:561-578,:698-713`) ALREADY debounces list invalidation — the fix is the per-item `getOne()` fan-out (`InboxHub.tsx:182-202`) + the over-broad mutation invalidations, NOT adding a second list debounce.

## Verification
- `pnpm --filter @armyofagents/ui typecheck` clean.
- New suites: viewer-tabs, hubViewerModel, useHubTabs, HubTabStrip, HubTabBody, ThreadDetail.embedded, ApprovalDetailCore, hubRegistry.resolveTab, InboxHub.invalidation — all green.
- Existing threads + hub + Layout suites unchanged.
- Live: full-bleed fixed, resizable persists, item→tab, link→tab, browser tab, rehydrate — all confirmed via `/browse` + user check.

## Scope guard
**In scope (Part 1):** the three-panel tabbed shell, tab manager, hosting existing viewers, the embeddable refactors (ThreadDetail/Approval/Agent/Run), fresh panels, full-bleed, and BUG-3. **Not in scope (Part 2):** BUG-1 codex handshake, BUG-2 runtime-decision reconcile, BUG-4/5 minors, RoutineDetail tab, budget spend dashboard, Notifications/Autopilot settings UIs. **Do not** change hub server/API semantics beyond surfacing `relatedEntityId` on the row type.
