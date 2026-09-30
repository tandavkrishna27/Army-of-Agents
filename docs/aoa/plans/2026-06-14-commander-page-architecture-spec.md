# Commander Page Architecture — Spec (P2)

**Date:** 2026-06-14
**Branch:** `feat/v1-commander-chat`
**Status:** Spec-ready (all design decisions closed + data-verified). Next: per-phase implementation plans → review → build.
**Builds on:** shipped Commander Content Viewer P1 (`2026-06-11-commander-viewer-design.md`) and the cockpit brainstorm (`2026-06-13-commander-cockpit-design-note.md` — card catalog in §5, data verification in §14). This spec is the authoritative consolidation.

---

## 1. Scope & phasing

**In this spec (the bundle):** rounded-panel chrome · right-side composition · interactive detail tab · the cockpit · multi-human scoping.
**Follow-up (separate, after this bundle ships):** "Brief me" triage tool + any other new Commander tools (own tools-design pass); harden the suggestion engine (`merge_memory` stub); the Google epic (Calendar/Drive/Gmail).

**Build as PHASED plans, not one mega-plan** (the brainstorming "decompose large scope" rule; the per-feature pipeline proven by the viewer P1):

| Phase | Deliverable | Depends on |
|-------|-------------|-----------|
| **0 — Chrome** | Rounded-panel chrome on the Commander page (and the shipped viewer) | — (independent; ship first) |
| **1 — Composition** | `react-resizable-panels` 4-region layout + persistence + mobile tab-bar; migrate viewer off its hand-rolled divider | 0 |
| **2 — Detail tab** | Extract `<TaskDetail>`; task opens as an interactive viewer tab | 1 |
| **3 — Cockpit** | The cockpit panel + cards + data + scoping + live | 1, 2 |
| **X — Multi-human** | Cross-cutting `cockpitScope()` woven through 3 (not a separate phase) | — |

Each phase: writing-plans → review (Claude + Codex) → subagent-driven build → live verify. Each ships independently.

---

## 2. Phase 0 — Rounded-panel chrome

**Goal:** Commander panels become rounded "cards" matching Memory/Discussions/Workspace.
**Verified recipe** (design-system §5.1 radius, §6 shadow): panels `rounded-xl border border-border bg-background shadow-sm` (side panels) / `rounded-lg` (center); wrapper `gap-2 p-2 bg-muted/30`.
**Current state:** Commander is full-bleed — a `section === "commander"` exception in `Layout.tsx:42` drops padding; panels sit flush.
**Changes:** remove the `/commander` full-bleed exception; add the `gap-2 p-2 bg-muted/30` wrapper in `Commander.tsx:67`; wrap sessions, chat, and the viewer in the card chrome. Applies to the **already-shipped viewer** too.
**Bug-watch:** chat's bottom-fixed input must round inside its card (scroll/overflow); the viewer drag-divider at a rounded edge; reverting full-bleed changes mobile padding (Phase 1's mobile tab-bar redoes this anyway).
**Independent — can ship before the rest.**

---

## 3. Phase 1 — Right-side composition

**Goal:** a coherent multi-panel Commander layout that the cockpit slots into.
**Foundation (verified):** `react-resizable-panels` ^4.9.0 is already in `ui/package.json` and used by `WorkspaceLayout` + `MemoryExplorer` (`Group`/`Panel`/`Separator`/`useDefaultLayout`). Adopt it for Commander; **no shared wrapper exists** — use directly like Workspace.

**Layout:** `[sessions | chat (flex center) | detail | cockpit]`. Detail (the viewer/detail panel) + cockpit are each collapsible to a rail.

**Decisions (locked):**
- **Responsive — "protect the chat":** below ultrawide (~1600px) only ONE of detail/cockpit is expanded at a time; the other auto-collapses to its rail. Ultrawide allows both. Chat stays readable always. **(Mandatory responsive cap — not optional; mid-width screens otherwise get a phone-width chat.)**
- **Persistence — global per-user:** panel widths + open/collapsed states persist across reloads AND across all chats (one personal layout), via `useDefaultLayout({ id: "aoa:commander:panel-sizes", storage: localStorage })` + a `useSidebarCollapsed`-style key per panel. (Viewer TAB *contents* remain per-conversation, as P1 decided — that's separate from geometry.)
- **Migrate the viewer:** replace `CommanderViewerPanel`'s hand-rolled pointer-drag divider (`:188-222`) with the library; the viewer width starts persisting (per above). Unifies all right-side resize; removes the edge-case-prone hand-rolled code.
- **Auto-expand arbitration:** a `created` ref auto-expands the detail panel; on a constrained screen with the cockpit open, the **cockpit drops to its rail** (viewer wins; re-expandable). Consistent with P1 auto-open.
- **Mobile (Workspace-style tab bar):** below 1024px, `[Chat] [Detail] [Cockpit]` tab bar (sessions a drawer or 4th tab), full-screen panels, all rendered + CSS-`hidden` to preserve state (mirrors `WorkspaceLayout` `workspace-mobile-tabs`). Retrofit the P1 viewer's mobile pill into this tab model for consistency.

**Bug-watch:** enforce the responsive cap; persist geometry globally (not per-conversation); preserve panel state across mobile tab switches via CSS-hidden (don't unmount).

---

## 4. Phase 2 — Interactive detail tab

**Goal:** the viewer becomes the unified **detail panel** — clicking a cockpit item opens it as a tab.
**Verified:** `TaskSlideOver.tsx` (1,860 lines) already takes `{issueId, open, onClose}` props (not route params) and gates every query on `enabled: !!issueId && open`. The viewer `TabBodySwitch` (`CommanderViewerPanel.tsx:355`) is a clean per-kind switch.

**Decisions (locked):**
- **Task = extract-existing:** pull TaskSlideOver's inner content into `<TaskDetail issueId active>`; `<TaskSlideOver>` becomes a thin Sheet wrapper around it (keeps existing slide-over usages working, zero behavior change). Add a `task` tab kind to the viewer model + `TabBodySwitch`. **The `open` gate maps to `active`** — pass tab-is-active so inactive (CSS-hidden) tabs don't fetch.
- **Goal & Approval = NOT tabs yet** (verified: only route-coupled full pages exist — `GoalDetail.tsx`, `ApprovalDetail.tsx`). Their cockpit interaction = **quick-action inline in the card + "↗ open full page"** for deep detail. Tab-ification deferred to a later phase.

**Bug-watch:** the active-tab fetch gate (don't fetch background tabs); TaskSlideOver's contexts (Company/Toast/Router/react-query) work in a tab — verify no Sheet-only assumptions leak into `<TaskDetail>`.

---

## 5. Phase 3 — The cockpit

**Card catalog, per-card data sources, and the hybrid layout: see `2026-06-13-commander-cockpit-design-note.md` (§5 cards, §13 resolutions, §14 verified sources).** Summary of what's locked:

- **State, not content:** a card earns its place only if the item needs you or is moving. No "recent/browse" lists (those are the viewer home).
- **Hybrid zones:** global mission-control (same every chat) + a per-session "In this conversation" zone (entities this chat touched, live; same source as viewer's "Recent from this conversation").
- **Default-on set:** ✅ Review · ⚑ Approvals · ▶ Running · 🗂 My tasks · 📅 Today · 💬 Discussions. Everything else opt-in (Goals, Budget, Suggestions, Proactive, Pinned, Done today, Teammates, Quick capture). **Show-only-active** hides empty cards; per-user ⚙ config (show/hide/reorder/pin).
- **Interaction:** every row has a direct action + **Ask ↩** (seeds the composer with a scoped question). Clicking opens detail per Phase 2 rules (task→tab, others→inline + ↗). Inline approvals are compact (summary + approve/deny + details↗), never cramped forms.
- **Collapse:** full / semi (badge rail showing `⚡N need you`, pulses on new) / hidden. Semi is the default while chatting.
- **"Brief me"** header button = **follow-up** (needs the triage tool; out of this bundle).

**Architecture (locked):**
- **One batched `/cockpit` endpoint** returns all enabled cards' data in a single call (not N requests).
- **Live via existing LiveEvents WS** (`live-events-ws.ts`) — subscribe to `heartbeat.run.*`, `issue.status_changed`, `internal_agent.*`, `budget.*`; **it already RBAC-filters per connection and recomputes role per-event** (no stale cache).
- **The "clear" is the dopamine:** handled items optimistically vanish.

**New persistence (the only net-new tables/stores in the whole bundle):**
- `user_entity_pins` (`userId, companyId, entityType, entityId, pinnedAt`) — the Pinned card.
- a small per-user cockpit-prefs store (which cards / order / pinned-always) — mirrors `sidebar_preferences`.

---

## 6. Multi-human (cross-cutting)

**Visibility model — scoped via the existing hierarchy (locked):** founder = company-wide; team_lead = their chain-of-command + departments; team_member = own work + own-department read. Personal cards (My tasks, Today, reminders) self-scope by data. Genuinely sensitive cards (Budget) are founder/lead card-gated. **Least-privilege; enterprise-grade; reuses controls that exist.**

**Single `cockpitScope(actor)` helper** funnels every card's query through one scoping definition — built from verified primitives:
- `permissionService.getEffectiveRole` / `getTeamLeadDepartments` / `isFounder` (`server/src/services/permissions.ts:47-104`).
- The owner-scoping pattern (`loadOwnedConversation`, 404-not-403, founder bypass — `internal-agent.ts:101-134`).
- **Agent responsibility via the existing reporting chain (no schema change):** `agents.parentType`/`parentId` (`"user"`→a human) + `getChainOfCommand()` (`agents.ts:782-864`); CXO agents are required to report to a human. "Agents I'm responsible for" = agents whose chain reaches me + my departments.
- **Approvals per-scope:** add a role/dept-scoped WHERE to the approvals query for the cockpit (today it's company-wide — `approvals.ts:39`). founder=all, lead=dept, member=routed-to-them.
- **Teammates card:** scoped the same way (founder=all, lead=dept, member=own-dept).
- **LiveEvents already RBAC-filter** per connection → live updates inherit scoping for free.

**Bug-watch:** never cache role (recompute per request/event, like the thread-event layer); centralize the agent-responsibility chain walk in `cockpitScope` so no card over-scopes; honor `local_implicit`/instance-admin founder bypass.

---

## 7. Scalability & correctness (the enterprise bar)

- **One batched endpoint + LiveEvents** — bounded query count; real-time without polling.
- **Show-only-active + per-user config** — no dashboard bloat; cards appear only with content.
- **Active-tab fetch gating** — detail tabs don't fetch while hidden.
- **Responsive caps** — chat never starved; one right panel below ultrawide.
- **Zero new authorization surface** — visibility + actions both flow through existing RBAC; the only new auth code is the `cockpitScope` *composition* of existing helpers.
- **Optimistic clear** with reconciliation on the next LiveEvent/refetch.
- **Library over hand-rolled** for resize (kills the class of bugs we hand-patched in P1).

---

## 8. Net-new build (the entire bundle)

1. Chrome: CSS only (Phase 0).
2. `react-resizable-panels` adoption + viewer migration + mobile tab-bar (Phase 1).
3. `<TaskDetail>` extraction + `task` tab kind (Phase 2).
4. Cockpit panel + cards (mostly querying existing tables) + the batched `/cockpit` endpoint + LiveEvents subscription (Phase 3).
5. `user_entity_pins` table + cockpit-prefs store (Phase 3).
6. `cockpitScope()` helper + approvals-scoped query (cross-cutting).

Everything else = querying/composing existing tables + the existing LiveEvents WS. **Follow-ups (not this bundle):** Brief-me triage tool, suggestion-engine `merge_memory`, the Google epic.

---

## 9. Open items

- **None blocking.** v1 default-card set is locked (§5). Brief-me + other tools, suggestion-engine harden, and Google are explicitly deferred.
- Per-phase plans will surface implementation-level specifics (exact query shapes, component file layout, test lists) — that's the writing-plans step, done one phase at a time.
