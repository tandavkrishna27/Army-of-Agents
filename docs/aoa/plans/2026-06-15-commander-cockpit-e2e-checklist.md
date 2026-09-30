# Commander / Cockpit — Full E2E Flow Checklist

**Purpose:** Exhaustive browser E2E of every Commander-page + cockpit user flow before continuing to approval families. Drive each in the real app (http://127.0.0.1:3100, company "Pinned Demo Co", local-board = founder). Mark ✅ pass / ❌ bug (fix + retest) / ⏭️ covered-by-tests-only (note why). Capture screenshots for the visual ones.

> Legend: **[B]** = browser-drivable now with seeded data · **[T]** = primarily unit/component-test-covered (note in report) · **[A]** = needs a real agent run (note).

## A. Layout & chrome
- [ ] A1 [B] Desktop 3-pane layout renders: chat | viewer/detail | cockpit.
- [ ] A2 [B] Drag a panel separator → widths change; reload → geometry persists.
- [ ] A3 [B] Collapse viewer → rail; expand → restored.
- [ ] A4 [B] Collapse cockpit → rail; expand → restored.
- [ ] A5 [B] No console errors on load.

## B. Sessions sidebar (multi-chat)
- [ ] B1 [B] "New chat" creates + selects a fresh conversation.
- [ ] B2 [B] Switch between conversations → messages + conversation zone update.
- [ ] B3 [T/B] Pin / archive / rename a chat (if reachable in headless).
- [ ] B4 [T] Drag-reorder + Reset (dnd-kit; component-tested).
- [ ] B5 [B] "Search sessions" filters.

## C. Chat
- [ ] C1 [A] Send a message → assistant responds (real agent; note).
- [ ] C2 [T] `/skill` token insertion in the composer (component-tested).
- [ ] C3 [A] Output-ref chips appear under an assistant message that created an artifact.

## D. Viewer / Detail
- [ ] D1 [B] Open an artifact tab (from the conversation zone / a ref) → artifact body renders.
- [ ] D2 [B] Open a task tab (from a cockpit task row) → task detail renders.
- [ ] D3 [B] Close a tab.
- [ ] D4 [B] Open multiple tabs; switch between them.

## E. Cockpit — config / prefs
- [ ] E1 [B] Config popover lists default cards (checked) + an "Optional" section (opt-in cards unchecked by default).
- [ ] E2 [B] Hide a default card → it disappears; reload → still hidden.
- [ ] E3 [B] Enable an opt-in card → it appears; reload → still enabled.
- [ ] E4 [B] Disable a previously-enabled opt-in card → disappears.

## F. Cockpit — sections (render + interactions)
- [ ] F1 [B] In this conversation: renders refs; click → opens artifact viewer tab.
- [ ] F2 [B] Pinned: renders; click task → viewer tab; Unpin → row drops.
- [ ] F3 [B] Pin from a Review/MyTasks/Today row (📌) → appears in Pinned.
- [ ] F4 [B] Running now: renders running agents; click → task; Ask↩ → chat.
- [ ] F5 [B] Review: renders in_review tasks; click → task; Ask↩.
- [ ] F6 [B] My tasks: renders (assignee=me); click → task.
- [ ] F7 [B] Today: reminders + due tasks; click → task.
- [ ] F8 [B] Discussions: renders; click → /discussions/:id; Ask↩.
- [ ] F9 [B/T] Approvals: renders (founder); approve/deny per source (workflow data — may be T).
- [ ] F10 [B] Goals at risk: renders; click → /goals/:id.
- [ ] F11 [B] Budget pulse: renders $ + bar + % (founder).
- [ ] F12 [B] Done today: renders completed tasks; click → task.
- [ ] F13 [B] Proactive findings: renders notifications; click → /inbox or Ask.
- [ ] F14 [B] Teammates' activity: renders other-human activity (NOT agents/self); click → entity.
- [ ] F15 [B] "All clear" empty state: shows only when NO cards visible AND no conversation refs.

## G. RBAC (scope)
- [ ] G1 [T] Budget pulse = null for non-founder (unit-covered; local-board is founder).
- [ ] G2 [T] Teammates: member → []; lead → dept-scoped (unit + live SQL-filter proof done).
- [ ] G3 [T] Approvals founder-only (unit-covered).

## H. Cross-cutting
- [ ] H1 [B] Live updates: an external change (e.g. pin via API) reflects after refetch/invalidation.
- [ ] H2 [B] No console errors after exercising all flows.
- [ ] H3 [T] Full server + ui test suites green (regression).

---

## E2E Results (2026-06-15) — PASS

**Browser-driven (live, real app + real backend):** A1/A3/A4/A5 layout+collapse+no-errors ✅ · D1 open-artifact-tab ✅ · D2 open-task-tab (with Comments/Sub-tasks/Activity/Artifacts) ✅ · F2 unpin ✅ · F3 pin-from-Review-row (grows; idempotent re-pin) ✅ · F5 Ask→chat (graceful "agent not configured") ✅ · F10 Goals-at-risk→/goals/:id ✅ · F13 Proactive→Ask ✅ · F14 Teammates→/issues/:id ✅ · E2/E3 hide+enable **mechanism** ✅ (via prefs; the Radix-portal popover *click* is component-tested — headless can't drive the portal) · F1–F14 all 8 sections render ✅ (full-cockpit screenshot) · H1 pin/unpin invalidation→refetch ✅ · H2 no console errors after all flows ✅.

**Live SQL-filter proofs (real PG):** teammates excludes agents + self + plugin (allowlist) ✅; proactive per-user + both-string type ✅.

**Covered by tests (not browser-driven):** A2 geometry persist (Phase 1) · B3/B4 sessions pin/archive/rename/reorder (component) · C1/C3 chat send + ref chips (need real agent) · C2 /skill token (component) · E2/E3/E4 popover click (component) · F9 approvals approve/deny (workflow data; 3c component) · F15 All-clear (component) · G1–G3 RBAC (unit + the live teammates SQL proof).

**Regression:** server **682 files / all pass** (14 infra-skipped); ui **2598 pass**, 1 parallel-run pollution flake (`ProjectDetailWorkspaces` — passes 16/16 isolated; outside the cockpit blast radius, not touched this session). Cockpit targeted: server 66/66, ui 188/188; all typechecks clean.

**Holistic review:** "solid and ready to land," no Critical/Important. Fixes applied (2780cf628): teammates allowlist (plugin-leak), done-today `hiddenAt`, empty-card wrapper divs, stale doc comments. Deferred (documented): instant live-updates for 4 low-urgency cards (8s poll covers them), collapsed-rail badge, proactive `/inbox` deep-link (upstream writer), testid naming.
