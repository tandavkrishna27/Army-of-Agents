# Commander Panel-System Redesign (B4 — Workspace Parity) — Build Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or executing-plans. Steps use `- [ ]`. Build phase-by-phase; each phase = build → spec review → quality review → live verify, per the established Commander loop.

**Goal:** Rebuild the Commander page's panel system to mirror `WorkspaceLayout` exactly — **Sessions ("Chats") | Chat | Viewer | Cockpit** — with unified 42px headers, rounded-card chrome, a single `PanelRight` "Open preview" toggle, the `applyPreviewFocus` collapse choreography (opening the preview collapses *both* side panels to 48px rails), collapsible cockpit cards, a new **Memory** cockpit card, and removal of the old twin fat icon-rails + duplicate collapse controls.

**Architecture:** Reuse the **existing workspace machinery** wherever possible — don't reinvent it. The Commander page already uses `react-resizable-panels`; this re-shapes it to the workspace model. Locked design via `~/.gstack/projects/MeteoriteLabs-AoA/designs/commander-panels-20260615/` (variant-B4 + approved.json). Frontend-heavy; one small backend add (Memory card retrievals-by-conversation).

**Tech stack:** React + Tailwind v4 (ui/src), react-resizable-panels, Radix Collapsible; Express + Drizzle for the Memory-card query.

---

## REVIEW FIXES — APPLIED (authoritative; override anything below that conflicts)

A code-reading review (2026-06-15) found structural errors. Mandatory corrections:

- **[A1] Where the layout lives.** `SessionsSidebar` is rendered by the PAGE (`ui/src/pages/Commander.tsx:71-78`), a sibling of `AgentPanelContent`; the resizable `Group` inside `AgentPanelContent` (`InternalAgentPanel.tsx:1437-1502`) holds Chat|Viewer|Cockpit. Phase 1 must therefore **introduce the new work-area container at the `Commander.tsx` level** (or a new `CommanderWorkArea` component) that lays out `Sessions(width-div) | center Group(Chat|Viewer) | Cockpit(width-div)` and passes chat/viewer/cockpit down — keeping `AgentPanelContent`'s docked/`enableViewerPanel=false` single-column + mobile-Sheet usage intact via a branch/prop. This is the largest structural change; scope Phase 1 accordingly.
- **[B1] Side panels are WIDTH-TOGGLED DIVS, not resizable Panels.** Mirror workspace exactly: `WorkspaceLayout.tsx` uses `Group/Panel/Separator` ONLY for the center split (`center-left`/`center-right`, :452-522); the left task-nav (:428-449) and right cockpit (:525-559) are plain `<div>`s with `transition-[width] duration-200` toggling `w-[250px]↔w-[48px]` / `w-[280px]↔w-[48px]`. So **Sessions + Cockpit = width divs; only Chat|Viewer = the Group**. (Correct the Reference section + Phase 1.)
- **[A2] Wire ALL SIX viewer entry points through the new `openPreview()` (Phase 6).** Not 3 — the six are: `OutputRefChips`→`viewer.openRef` (`InternalAgentPanel.tsx:1162`), cockpit `onOpenArtifact`/`onOpenTask` (:1490-1497), **`viewer.openReply` (:1112)**, **`viewer.openBrowser` for in-message links (:1146)**, and **`viewer.onLiveRef` streaming auto-open (:753)**. These last three currently surface the panel via the `viewer.state.expanded` bridge effect (:464-469) that Phase 6 removes — re-route them or they silently break. Live-ref auto-open uses `source="right-panel"` (don't yank both panels mid-stream).
- **[A3] Memory card conversationId = `ctx.contextScope?.conversationId`, NOT `ctx.conversationId`.** The bridge builds the tool context without top-level `conversationId` (`mcp-bridge.ts:245-261`); the populated path is `contextScope.conversationId` (threaded `agent-loop.ts:217`→`cli-mode.ts:529`→env→`mcp-bridge.ts:223,258`). Using `ctx.conversationId` logs NULL → Memory card always empty. (Optionally also set top-level for symmetry, but read `contextScope`.)
- **[B3] Phase 5 is bigger: strip card headers + extend the registry.** Each Commander card renders its OWN `<header>` (e.g. `CockpitRunningCard.tsx:20-24`); `CockpitSection` ALSO renders a trigger header → double-title. So Phase 5 must (a) **strip the internal header from ~13 card files + the conversation zone**, and (b) extend `COCKPIT_REGISTRY` (`CommanderCockpitPanel.tsx:80-214`, entries are `id/title/defaultOn/isActive/render` — no icon/summary) with a per-card **`icon`** + **`summary(data)`** deriver that `CockpitSection` needs. Budget Phase 5 as the largest UI phase.
- **[B4] "In this conversation" is NOT a registry card** (`CommanderCockpitPanel.tsx:69-70,374-376`; fed by `conversationRefs`, not `/cockpit`). To make it collapsible, give it a parallel collapsible wrapper, not the registry path.
- **[B5] DECISION — keep collapse state GLOBAL per-user, NOT per-conversation.** The existing hooks are intentionally global ("one personal layout across reloads + all chats", `useCommanderViewerCollapsed.ts:3`). Phase 1's new hook keeps ONE global key per side (`aoa:commander:panel-<side>-collapsed`), mirroring `useSidebarCollapsed`'s intent. (Do not key by conversationId — that resets layout per chat + grows storage unbounded.)
- **[B6] DECISION — tablet tier (1024–1535px, `isWide=false`).** "Open from cockpit" must still **collapse the cockpit** at <1536px (fall back to `source="center"` behavior) so chat+viewer fit; only on ultrawide (≥1536px) does the cockpit stay open beside the viewer. Replace the current resize-cap effect with this rule.
- **[B7] Migration (Phase 7) idempotency.** `memory_retrievals` gets a nullable `conversation_id` + index + FK to `internal_agent_conversations` (`onDelete:"set null"`, matching the table's audit-preserve pattern). The generated migration must be hand-edited to `CREATE INDEX IF NOT EXISTS` AND wrap the FK `ADD CONSTRAINT` in `DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN NULL; END $$` (the `migration-idempotency.test.ts` enforces both, :117-118,:147-154; Drizzle doesn't emit them by default). Match the existing `memory_items.conversation_id` FK migration precedent.
- **[B8] Phase 2 — preserve SessionsSidebar's existing features + internal collapse.** It's `w-56` (224px, not 250px), owns its OWN `collapsed` state + `CollapsedSessionStrip` rail (`SessionsSidebar.tsx:230,459-470`), and has an **"online" status indicator** + full-width New-chat + morphing Search field (:483-550). Phase 2 must relocate those into the 42px "Chats" header (keep New-chat + Search + online), and **reconcile/replace its internal collapse** with the Phase-1 global hook (don't double-manage collapse).
- **Nits:** delete BOTH effects at `:464-469` (auto-open bridge) and `:471-476` (resize cap); current collapse icons are `ChevronsRight`/`ChevronsLeft` (cockpit/viewer) — standardize to `PanelRightClose`/`PanelLeftClose`; old rails are `w-9`=36px, new rails target 48px (mirror workspace); the "Open preview" toggle must handle the **no-active-conversation** case (`ChatPaneCaption` only renders when `conversationId` set, :1001 — give the toggle a home there too); `ViewerTabs` is already `h-[42px]` (small change); Memory route/api template (`memory-retrievals.ts:27-37`, `memory.ts:1336-1371` `listRetrievalsForIssue`, `memoryRetrievals.ts:33-46`) mirrors 1:1 for `listForConversation`.

---

## Reference: the exact Workspace pattern to mirror (from the deep audit)
- Panels: left task-nav (250px / 48px rail) | center `Group` (timeline + preview split) | right cockpit (280px / 48px rail). `react-resizable-panels` `Group`/`Panel`/`Separator`.
- **Open-preview choreography** — `applyPreviewFocus(source)` (`WorkspaceLayout.tsx:136-145`): on open, `setLeftCollapsed(true)`; if `source==="center"` also `setRightCollapsed(true)`. Triggered by the `PanelRight` toggle in the center header (`handleTogglePreviewPanel` :248-260). Opening a doc *from the right panel* passes `source="right-panel"` → left-only collapse (cockpit stays).
- **Rails** — 48px, `transition-[width] duration-200`; rail header 42px with the expand button; below, a divider + stacked icons that expand-and-scroll-to (`onExpandAndShowGroup`/`onExpandAndShowSection`).
- **Collapsible cards** — `cockpit/CockpitSection.tsx` = Radix `Collapsible`; `ChevronRight` rotates 90° on open; per-section persisted `localStorage["aoa:workspace:cockpit:section:<id>"]`; **max 3 open** (`WorkspaceRightPanel.tsx:327-356`).
- **Icons (lucide):** `PanelRight`/`PanelRightClose` (preview + right collapse), `PanelLeft`/`PanelLeftClose` (left collapse), `ChevronRight` (section toggle), `MoreVertical` (cockpit menu), `Plus`, `Search`.
- **Persistence:** `useSidebarCollapsed(id, side)` → `localStorage["aoa:workspace:<id>:sidebar-<side>-collapsed"]`; geometry via `useDefaultLayout({id:"aoa:workspace:panel-sizes:<id>"})`.
- **Mobile:** tab bar (Tasks/Timeline/Preview/Context) + CSS-hidden panels; `applyPreviewFocus` no-op on mobile.

Reference files: `ui/src/components/workspace/WorkspaceLayout.tsx`, `WorkspaceRightPanel.tsx`, `WorkspaceTaskNav.tsx`, `cockpit/CockpitSection.tsx`, `useSidebarCollapsed.ts`, `sections/MemorySection.tsx`, `ui/src/api/memoryRetrievals.ts`.

Current Commander files to change: `ui/src/components/InternalAgentPanel.tsx` (AgentPanelContent layout ~:1418-1510 + the resize-cap effect ~:464-476), `ui/src/components/commander/SessionsSidebar.tsx`, `ui/src/components/commander/ChatPaneCaption.tsx`, `ui/src/components/commander/viewer/CommanderViewerPanel.tsx` (rail to be removed), `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx`, `commanderChrome.ts`, `useCommanderViewerCollapsed.ts` / `useCommanderCockpitCollapsed.ts` (to be replaced), `ViewerTabs.tsx`.

---

## Phase 1 — Layout shell: workspace 3-work-panel Group + state

**Files:** `InternalAgentPanel.tsx` (AgentPanelContent), new `ui/src/components/commander/useCommanderPanelCollapsed.ts`.

- [ ] Restructure `AgentPanelContent` (full-page, `enableViewerPanel`) to the workspace layout: `[app sidebar — unchanged]` then a work area = **Sessions `Panel`** | center **`Group`**(Chat `Panel` + optional Viewer `Panel` + `Separator`) | **Cockpit `Panel`**. Use `react-resizable-panels` `Group`/`Panel`/`Separator` like `WorkspaceLayout.tsx:452-522`. The Viewer `Panel` (center-right) renders ONLY when `previewVisible && viewer has a tab`.
- [ ] Add a collapse-state hook mirroring `useSidebarCollapsed`, keyed per-conversation: `useCommanderPanelCollapsed(conversationId, "sessions"|"cockpit")` → `localStorage["aoa:commander:<cid>:panel-<side>-collapsed"]`. Replaces `useCommanderViewerCollapsed`/`useCommanderCockpitCollapsed`.
- [ ] Geometry persistence via `useDefaultLayout({ id: "aoa:commander:panel-sizes:<cid>", panelIds:["chat","viewer"] })` for the center split.
- [ ] Default widths: Sessions ~250px (expanded) / 48px (rail); Cockpit ~300px / 48px; Chat flex; Viewer min 24% of center.
- [ ] Keep the docked (non-full-page) usage (`enableViewerPanel=false`) single-column as today.
- [ ] Build, typecheck, commit.

## Phase 2 — Sessions panel: "Chats" header + collapse + rail

**Files:** `SessionsSidebar.tsx`.

- [ ] Add a real **42px "Chats" header**: title "Chats" (text-sm font-semibold) + `Plus` (new chat) + `Search` toggle + a `PanelLeftClose` collapse button (right). Move the currently-floating new-chat/search controls into this header (audit: they float in an ad-hoc `px-2.5 pt-2.5` div today).
- [ ] Collapse-to-rail (48px): rail header 42px with `PanelLeft` expand; divider; stacked icons (`Plus` new-chat, `Search`) — mirror `WorkspaceTaskNav.tsx:128-176`. Expand restores.
- [ ] Drive collapse via the Phase-1 hook (`sessions` side). Add `data-testid`s: `commander-sessions-header`, `commander-sessions-collapse`, `commander-sessions-rail`.
- [ ] Keep all existing sessions features (pin/rename/archive/delete/reorder/search/date-groups). Build, test, commit.

## Phase 3 — Chat header: single "Open preview" toggle

**Files:** `ChatPaneCaption.tsx` (→ 42px), `InternalAgentPanel.tsx`.

- [ ] Make the chat header exactly **42px** (currently `h-11`/44px). Left: conversation title + meta. Right: a **`PanelRight` "Open preview"** toggle (becomes `PanelRightClose` + "Hide preview" when open) — mirror `PreviewPanelToggle` (`WorkspaceLayout.tsx:645-664`). `data-testid="commander-open-preview"`.
- [ ] The toggle calls the Phase-6 `togglePreview()`. Keep the `MemoryContextStrip` below the header (unchanged). Build, test, commit.

## Phase 4 — Viewer as center split (remove the old viewer rail)

**Files:** `CommanderViewerPanel.tsx`, `InternalAgentPanel.tsx`, `ViewerTabs.tsx`.

- [ ] Render the Viewer as the **center-right `Panel`** (resizable, beside Chat) when `previewVisible`. Keep `ViewerTabs` (Home + artifact/task/reply/browser) + the tab bodies unchanged.
- [ ] **Remove** `CommanderViewerRail` (the fat 36px icon-rail at `CommanderViewerPanel.tsx:317-370`) and its per-tab quick-jump icons; the viewer no longer has a rail (it's shown/hidden via the preview toggle). The viewer header's collapse button now = "Hide preview" (`PanelRightClose`) that closes the preview (calls `closePreview()`), keeping the `commander-viewer-tabs` testid.
- [ ] Mobile: keep the existing pill+Sheet for the viewer (audit: `CommanderViewerPanel.tsx:437-478`). Build, test, commit.

## Phase 5 — Cockpit: 42px header + collapse + rail + collapsible cards

**Files:** `CommanderCockpitPanel.tsx`, new `ui/src/components/commander/cockpit/CockpitCard.tsx` (or reuse workspace `CockpitSection`), `cockpitCardModel.ts`.

- [ ] Cockpit header → **42px**: `PanelRightClose` collapse (left) + "Cockpit" title + the existing Config popover (`Settings2`) + a `MoreVertical` menu (right) — mirror `WorkspaceRightPanel.tsx:410-439`.
- [ ] Collapse-to-rail (48px): `PanelRight` expand header + divider + one stacked icon per active card; expand-and-scroll-to-card. `data-testid="commander-cockpit-rail"`.
- [ ] **Make each cockpit card a collapsible section**: adapt workspace `CockpitSection` (Radix `Collapsible`, `ChevronRight` rotate-90, icon box + title + summary + chevron grid). Persist per-card: `localStorage["aoa:commander:cockpit:section:<cardId>"]`. Apply to ALL cards (Running, Review, MyTasks, Today, Discussions, Approvals, Pinned, Goals-at-risk, Budget, Done-today, Proactive, Teammates, In-this-conversation, Memory). Decide max-open: workspace caps at 3 — for Commander, **default all expanded, no hard cap** (the cockpit is the home surface) unless live testing shows clutter; persist user collapses. (Build-verify the registry render loop in `CommanderCockpitPanel` to wrap each card in the collapsible.)
- [ ] Keep the opt-in mechanism + config popover + the All-clear empty state. Build, test, commit.

## Phase 6 — applyPreviewFocus choreography

**Files:** `InternalAgentPanel.tsx`.

- [ ] Implement `applyPreviewFocus(source)` mirroring workspace: `togglePreview()` (from the chat-header toggle) opens the viewer + collapses **both** Sessions and Cockpit to rails (`source="center"`). Opening a doc **from the cockpit / conversation-zone / a chat ref chip** opens the viewer + collapses **only Sessions** (`source="right-panel"` → cockpit stays). `closePreview()` hides the viewer + restores both panels to their prior expanded state.
- [ ] No-op the collapse on mobile (use the existing pill/Sheet). Replace the old `<1536px` resize-cap effect (`:464-476`) with this model.
- [ ] Wire all existing "open in viewer" entry points (chip click, cockpit `onOpenArtifact`/`onOpenTask`, conversation zone `onOpenRef`) through `openPreview(ref, "right-panel")`. Build, test, commit.

## Phase 7 — Memory cockpit card (NEW: backend + frontend)

**Backend — files:** `packages/db/src/schema/memory_retrievals.ts`, `server/src/services/internal-agent/tools/memory-tools.ts`, `server/src/services/memory-retrieval-audit.ts`, a route in `server/src/routes/memory*.ts`, `ui/src/api/memoryRetrievals.ts`.

- [ ] **BUILD-VERIFY the conversation linkage (the one schema decision).** `memory_retrievals` has **no conversationId** today (columns: company_id, agent_id, run_id→heartbeatRuns, task_id, triggered_by, query, item_id, similarity_score, rank, shown_to_agent, created_at). Commander's `query_memory` already logs `triggeredBy:"commander_query"` + `runId: ctx.runId` (memory-tools.ts:120,154) — but run_id's FK is to `heartbeatRuns`, so commander run linkage is unreliable. **Decision (preferred):** add a nullable `conversation_id uuid` column (+ index) to `memory_retrievals` (Drizzle, `pnpm db:generate`, add `IF NOT EXISTS` to the migration per the idempotency test), write it from `recordMemoryRetrievals` (extend `RecordMemoryRetrievalsInput` with `conversationId`) called by the commander memory tools (pass `ctx.conversationId`). Confirm `ctx` exposes the conversationId; if not, thread it through the cli-mode/agent-loop tool context. (Fallback if a migration is unwanted: join via `internal_agent_runs` — verify run_id semantics first; the column is cleaner + indexable.)
- [ ] Add `memoryRetrievalsApi.listForConversation(companyId, conversationId, {limit})` + route, mirroring `listForIssue` (server/ui).
- [ ] **Frontend — `ui/src/components/commander/cockpit/CockpitMemoryCard.tsx`:** mirror `sections/MemorySection.tsx` — fetch `listForConversation`, group by `triggeredBy` (auto / agent_search+agent_get / commander_query / skill_materialize), per-row: item title (or "(deleted)"), layer badge, category, similarity %, "filtered" badge if `!shownToAgent`; link each to `/{prefix}/memory/explore?item=<id>&type=memory_item`. Empty state when none. Render as a collapsible cockpit card (Phase 5).
- [ ] Add it to `COCKPIT_REGISTRY` (id `memory`, defaultOn? — propose opt-in to start, since it's an audit surface; confirm with founder). Build, test, commit.

## Phase 8 — Header unification + rounded chrome + cleanup

**Files:** `commanderChrome.ts`, all panel components.

- [ ] Confirm ALL work-area panels use the rounded-card chrome (`COMMANDER_PANEL_CARD = rounded-xl border border-border bg-background shadow-sm`) with ~8px gaps (the `gap-2 p-2` row) — fix the B2-style flush regression; the app primary sidebar stays flush.
- [ ] Unify every panel header to **42px** (sessions, chat, viewer tab-bar [already 42], cockpit [was 36]).
- [ ] **Remove dead code:** the old viewer/cockpit fat rails + duplicate collapse controls; `useCommanderViewerCollapsed`/`useCommanderCockpitCollapsed` (replaced by Phase-1 hook); the old resize-cap effect. Grep for now-unused exports. Build, typecheck, commit.

## Phase 9 — Tests + live verification

- [ ] **Component tests:** the Phase-1 collapse hook (persistence); `applyPreviewFocus` choreography (open-from-center collapses both; open-from-cockpit collapses sessions only; close restores); `CockpitMemoryCard` (grouping, badges, empty); the collapsible cockpit cards (toggle + persistence); the Sessions "Chats" header + rail.
- [ ] **E2E:** update `tests/e2e/commander-viewer.spec.ts` + `-persistence.spec.ts` for the new layout (preview opens as center split; both rails collapse) — they currently assert the old rail/auto-open; add a spec for the choreography (open preview → sessions-rail + cockpit-rail visible; "open from cockpit" keeps cockpit). Run on the Docker DB (Windows e2e needs `DATABASE_URL`).
- [ ] **Static:** `cd ui && pnpm tsc -b && pnpm vitest run commander cockpit viewer`; `cd server && pnpm vitest run memory cockpit && pnpm typecheck`; `pnpm --filter @armyofagents/db ...` for the migration idempotency test.
- [ ] **Live verify (real app on :3201, Docker pgvector):** the page matches B4 — default (Sessions|Chat|Cockpit), Open preview → Sessions-rail + Chat + Viewer + Cockpit-rail; open a doc from the cockpit → cockpit stays; cockpit cards collapse + persist; the Memory card shows real commander_query retrievals after a chat that queries memory. Screenshot both states. Clean tree; do not finish the branch.

---

## Self-review (run after drafting; fix inline)
- **Workspace parity / reuse:** every panel/rail/collapse/card mirrors a named workspace file — minimal net-new code, consistent by construction. No invented patterns except the Memory `conversation_id` linkage (the one justified backend add).
- **Choreography correctness:** open-from-center collapses BOTH sidebars; open-from-cockpit collapses ONLY sessions (cockpit stays so you can see the doc you opened from it); close restores prior state. This is the exact behavior the founder asked for ("viewer opens as another panel, cockpit closes to a right sidebar").
- **No regressions:** all existing Commander features survive (sessions CRUD/reorder, viewer tabs incl. task/reply/browser, all cockpit cards + opt-in + approvals A4 scoping, conversation zone, MemoryContextStrip). The redesign is chrome/layout, not feature removal.
- **Pinning deferred (documented):** the center `Group` split is exactly the seam pinning will later use (let the viewer sit beside the cockpit on ultrawide). Nothing here blocks it.
- **Migration safety:** the `memory_retrievals.conversation_id` migration adds `IF NOT EXISTS` (idempotency test) + nullable (no backfill needed); never raw SQL.
- **Headers 42px everywhere; rounded-card chrome restored; dead rails removed** — the three things the founder explicitly called out are first-class acceptance criteria.
- **Bug-watch:** the Memory card needs `ctx.conversationId` in the tool context — if absent, thread it (don't silently log null); the collapsible-card max-open default (none) may need revisiting if the cockpit feels cluttered; per-conversation collapse keys must not leak across conversations.
