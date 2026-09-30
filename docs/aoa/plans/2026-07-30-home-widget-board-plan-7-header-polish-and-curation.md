# Plan 7 — Home board: header polish, customize UX, de-noise, curated defaults

Status: ready to execute (subagent-driven). Branch `claude/home-page-widgets-a927af`.
Continues Plans 1–6 (all on this branch, unpushed). Driven by founder feedback after
the Plan 6 live check.

## Goal

1. **Create menu** — replace the subtle "＋ New" outline button with a prominent, solid
   **"Create"** menu (Lobby-style prominence) that opens the full set: Task · Discussion ·
   Goal — Agent · Department · Project.
2. **Date subline** — a small muted date under the greeting.
3. **Header ↔ tiles alignment** — the header currently overhangs the tiles by 12px each
   side; make it flush.
4. **Customize UX** — the customize icon opens a proper dropdown (closes on outside-click,
   no header morph, no Create-button shift); arrange mode shows a floating toolbar instead
   of morphing the header; retire the hand-rolled Add-widget tray.
5. **Activity de-noise** — collapse consecutive duplicate events.
6. **Curated default board** — a prioritized, smaller default set (rest available in the
   tray); "Waiting on you" sized to show its list; tray hides founder-only widgets from
   members.

**Dropped after investigation:** Objectives progress bars + at-risk pill — already shipped
(`ObjectivesWidget.tsx` renders them; `home.ts` returns `progressPercent`/`status`). No work.

## Locked decisions

- **Create = one prominent solid button** labeled "Create" that opens the whole 6-item menu
  (NOT a split button — Home has no single default create, unlike the Lobby's one-org case).
- Menu order + grouping: **Task · Discussion · Goal** — divider — **Agent · Department · Project**.
- **Customize icon → a Radix dropdown**: `Rearrange tiles` · `Add widget ▸` (submenu) ·
  `Reset to default`. Closes on outside-click/escape. No header morph.
- **Arrange mode** (after Rearrange, or after adding a widget) = board draggable/resizable/
  removable + a **floating toolbar** (fixed, bottom-center) with `＋ Add widget` · `Reset` ·
  status (Saving…/Unsaved) · **Done**. The header stays `[Create ▾] [⊞ customize]` at all times.
- Date format: weekday + `D Month YYYY`, e.g. **"Wednesday, 30 July 2026"**, small + muted.
- **Curated default set** (rest tray-only). Order is **stats-last** so packing is gap-free
  (P3-3: 6×`2×2` list tiles pack into 3 clean shelves, the `1×1` stats trail on the last row —
  0 interior gaps; putting stats mid-array leaves a 2-cell interior hole):
  - Founder: `approvals`(Waiting on you) · `action-queue` · `objectives` · `my-tasks` ·
    `discussions` · `activity-feed` · `agents-now` · `budget`. Tray-only: `suggestions`, `memory-review`.
  - Member: `my-tasks` · `action-queue` · `approvals` · `objectives` · `discussions` ·
    `activity-feed` · `agents-now`. Tray-only: `budget`, `suggestions`, `memory-review`.
- **"Waiting on you" (`approvals` key) gets list sizes** `[2×2, 2×1, 4×2]` (default 2×2),
  replacing the stat sizes `[1×1, 2×1]` — it's a list now, not a count.
- Founder-only widgets (`requiresFounder`) are **hidden from the Add-widget list for
  non-founders** (real fix for the dead flag).

## Critical constraints / gotchas (verified — file:line)

- **`addWidget` can't be driven from view mode.** `useBoardEdit.ts:310` guards `if (!editing) return;`,
  and it's a `useCallback` closed over `editing` (dep `[editing]`, :324) — so a synchronous
  `startEdit(); addWidget(key)` in one handler STILL no-ops (stale closure). **Fix: add a new
  hook action `addWidgetAndEdit(key)`** that in one body reads `sourceLg`, appends the widget
  (reuse addWidget's append logic), sets `draft = next`, `baselineRef.current = sourceLg` (so
  it's dirty → Done saves), and `setEditing(true)`. Wire the Add-widget items to THIS, not
  `addWidget`. (`addWidget` stays for keyboard/other in-mode callers.)
- **`resetBoard` IS callable from view mode** (`useBoardEdit.ts:327`, guarded only on
  `isSaving`/`isResetting`) — it fires the DELETE + reverts. But since `lg = editing && draft
  ? draft : sourceLg`, a view-mode reset only becomes visible after the DELETE + savedLayout
  refetch (brief lag, no optimistic snap). Acceptable for an infrequent action. Show a
  **confirm** first (reuse the app's AlertDialog/confirm pattern) — Reset discards the saved
  layout.
- **Alignment = one prop.** `Responsive` (rgl 2.2.3) accepts `containerPadding?: [number,number]`
  (default null → falls back to `margin`, hence the 12px inset). Add `containerPadding={[0,0]}`
  to the `<Responsive>` at `HomeBoard.tsx:137` (leaves the 12px inter-tile gutter intact).
- **`role` isn't threaded to the controls.** `Dashboard.tsx:108` renders
  `<HomeBoardControls boardEdit={boardEdit} />` with no `role`; `HomeBoardControlsProps` has no
  role. Add `role: UserRole | null` to the props, pass `role={teamRole}` at :108, thread into
  the Add-widget list, and filter `!onBoard.has(key) && (!def.requiresFounder || role === "founder")`.
- **Waiting-on-you size change drops `1×1`.** New sizes `[2×2,2×1,4×2]` no longer include
  `1×1`. Existing saved boards with `approvals` at `1×1` → `reconcileLg`/`nearestAllowedSize`
  clamps to the nearest allowed (`2×1`/`2×2`) on load — no crash, but a one-time size bump.
  `2×1` stays valid. Update every test that asserted `approvals` at `1×1` (grep) and any
  disallowed-size case that used an approvals size now allowed. The `agents-now 2×2` disallowed
  case + server `OVERSIZE_LAYOUT` stay green (agents-now/budget stat sizes unchanged).
- **Curated defaults change packing.** Founder default is now 5×`2×2`(action-queue, objectives,
  my-tasks, discussions, activity-feed) + `approvals`@2×2 (6×2×2=24) + `agents-now`@1×1 +
  `budget`@1×1 → re-verify `buildDefaultLg` for founder AND member (no overlap, `x+w<=4`, gaps
  minimized) empirically; retune order only if a cheap swap helps; document.
- **Two `activityFormat` files exist.** Row label helpers = `ui/src/components/home/activityFormat.ts`
  (`formatAction`/`activityEntityName`). Deep-link `entityLink` = `ui/src/lib/activityFormat.ts`
  (Plan 6). Don't confuse them.
- `new Date()` in the app is fine (this is app code, not a workflow script).

## Grounding (verified)

- Create wiring — `DialogContext.tsx`: `openNewIssue(d?)`, `openDiscussionCapture(d?)`,
  `openNewGoal(d?)`, `openNewAgent()` (no args), `openNewProject({type:"department"|"project"})`.
- Radix submenu parts exported from `ui/src/components/ui/dropdown-menu.tsx`:
  `DropdownMenuSub`, `DropdownMenuSubTrigger` (auto-appends a chevron), `DropdownMenuSubContent`.
- Activity: `ActivityFeedWidget.tsx` renders `data.recentActivity` with NO cap; server
  `home.ts:167-190` returns `.limit(20)` (last 24h). `RecentActivityItem` =
  `{id,actorType,actorId,action,entityType,entityId,details,createdAt}`. `suggestion.detection_run`
  always logs `(action="suggestion.detection_run", entityType="suggestion", entityId=companyId)`.
- `useBoardEdit` API: `lg, editing, dirty, isSaving, isResetting, saveError, resetError,
  activeBreakpoint, announcement, startEdit, exitEdit, retrySave, removeWidget, addWidget,
  resetBoard, onLayoutChange, onBreakpointChange, onResizeStop, moveWidget, cycleWidgetSize`.
- `AddWidgetTray.tsx` (to retire): hand-rolled `role="menu"` div, props `{boardKeys,onAdd,onReset,resetting}`,
  filters `listWidgets().filter(d => !onBoard.has(d.key))`, per-row icon+title button, Reset
  row, empty copy "All widgets are already on your board." — port the inner rows into the Radix submenu.
- `defaultLayout.ts:76-77` current FOUNDER/MEMBER arrays; `registry.ts` `requiresFounder` set only
  on `memory-review`; nothing reads it yet.

---

## Tasks

TDD, commit per task, verify against the real files (line numbers drift). Batches run
sequentially (shared Dashboard/HomeBoard/test files → no parallel git races).

### Task 1 — Create menu (solid, six items)
Files: `ui/src/components/home/NewMenu.tsx` (rename intent → keep file or rename to `CreateMenu.tsx`;
keep it simple, keep the filename `NewMenu.tsx` to limit churn) + its test; `Dashboard.test.tsx`;
`tests/e2e/home-widget-board.spec.ts` (grep for "Create"/"New" trigger assertions).
- Trigger: a **solid** `Button` (default variant, prominent — mirror the Lobby's `+ New organization`
  fill, not the current `variant="outline"`), label "Create" + `ChevronDown`, `aria-label="Create"`.
- Menu (Radix `DropdownMenuContent align="end"`): `Task`→`openNewIssue()`, `Discussion`→
  `openDiscussionCapture()`, `Goal`→`openNewGoal()`, `DropdownMenuSeparator`, `Agent`→
  `openNewAgent()`, `Department`→`openNewProject({type:"department"})`, `Project`→
  `openNewProject({type:"project"})`. Each with a lucide icon.
- Tests: opening the menu shows all six items; each calls its opener with the right args
  (esp. the two `openNewProject({type})` args). **P2-2 breaks to fix:** `NewMenu.test.tsx:10-16`
  mocks `useDialog` with ONLY `openNewIssue/openDiscussionCapture/openNewGoal` — add
  `openNewProject`+`openNewAgent` to that mock or clicking the new items calls `undefined()`
  (crash). `NewMenu.test.tsx:28` asserts the trigger text "New" → now "Create". Item-label
  assertions `NewMenu.test.tsx:37,39,42-76` + `Dashboard.test.tsx:393-395,404-413` ("New task"/
  "New goal") → new labels "Task"/"Goal". (`getByRole("button",{name:"Create"})` already passes
  — the trigger already has `aria-label="Create"`.) The e2e spec has no create-menu-item
  assertion (only the trigger).
- Commit: `feat(home): Create menu — solid trigger + agent/department/project`

### Task 2 — Date subline + header/tiles alignment
Files: `Dashboard.tsx`; `HomeBoard.tsx`; `Dashboard.test.tsx`.
- Under the `<h1>` greeting, render a muted subline: weekday + `D Month YYYY`
  (`new Date().toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"long",year:"numeric"})`
  → "Wednesday, 30 July 2026"). `text-sm text-muted-foreground`.
- `HomeBoard.tsx:137`: add `containerPadding={[0, 0]}` to `<Responsive>`.
- Tests: Dashboard renders a date line matching a weekday; (alignment is visual — optional
  assertion that the grid receives containerPadding, else rely on the live check).
- Commit: `feat(home): date subline + flush header/tile alignment`

### Task 3 — Customize dropdown + floating arrange toolbar (the big one)
Files: `useBoardEdit.ts` (+ test); `HomeBoardControls.tsx` (+ test); new
`ui/src/components/home/AddWidgetMenu.tsx` (shared addable-widget list) (+ test); new
`ui/src/components/home/ArrangeToolbar.tsx` (floating bar) (+ test); `Dashboard.tsx` (pass `role`);
retire `AddWidgetTray.tsx` (+ delete its test). **Test blast radius (P1-1 — bigger than "header
assertions"; the whole customize→edit *entry interaction* changes):**
`ui/src/__tests__/Dashboard.test.tsx:444-453` (click "Customize board" no longer enters edit
immediately + expects header "Done"), `HomeBoard.test.tsx` (~25 edit tests that click "Customize
board" then act), `HomeBoard.a11y.test.tsx:147,169-178`, `HomeBoard.strictmode.test.tsx:171-173`,
and `tests/e2e/home-widget-board.spec.ts:60-61,76-79,110,113,133` (customize→Done +
`getByRole("menu",{name:"Add widget"})`). Grep `Customize board`, `"Done"`, `Add widget` across
`ui/src` + `tests/e2e` and update every edit-entry flow, not just header text.
- **Hook**: add `addWidgetAndEdit(key)` to `useBoardEdit` — **mirror `startEdit` fully** (P3-1):
  `const next = [...sourceLg, { i:key, x:0, y:bottomEdge(sourceLg), w:def.defaultSize.w, h:def.defaultSize.h }]`,
  then `setDraft(next); baselineRef.current = sourceLg; setInitialized(false); setSaveError(null);
  setAnnouncement(""); setEditing(true)`. Guard `if (isSaving) return;`. **Deps MUST be
  `[isSaving, sourceLg]`** (not `[editing]`) or it reintroduces the stale-closure bug. Baseline =
  `sourceLg` (not `next`) so `dirty` is true → Done saves. Export in `UseBoardEditResult`. Reuse
  the exact `bottomEdge`/append shape from `addWidget` (`useBoardEdit.ts:318-321`).
- **`HomeBoardControlsProps`**: add `role: UserRole | null`; pass `role={teamRole}` at `Dashboard.tsx:108`.
- **View mode**: the `⊞` customize icon becomes a Radix `DropdownMenu` trigger (keep the
  lg-gate: disabled + "Edit on a larger screen (1024px+)" tooltip below lg). Menu items:
  - `Rearrange tiles` → `startEdit()`.
  - `Add widget` → `DropdownMenuSub` whose content is `<AddWidgetMenu>` — the addable list
    filtered `!onBoard.has(key) && (!def.requiresFounder || role !== "team_member")` (P3-2: match
    `getDefaultLayout`'s own predicate — founder/team_lead/null all get the founder board, so all
    may add its founder-tier widgets; only `team_member` is restricted); each item →
    `addWidgetAndEdit(key)`. Empty → "All widgets are already on your board." (disabled item).
  - `DropdownMenuSeparator`, then `Reset to default` → confirm → `resetBoard()`.
  - Radix handles outside-click/escape close (fixes the bug). No inline header morph.
- **Arrange mode** (`editableNow`): render `<ArrangeToolbar>` — a fixed, bottom-center pill
  (not in the header) with `＋ Add widget` (opens the same `AddWidgetMenu` in a dropdown/popover),
  `Reset`, the Saving…/Unsaved/Retry status (moved out of the header), and **Done** (`exitEdit`).
  The header shows only `[Create ▾] [⊞]` (⊞ can be disabled/inert while arranging). **Mount
  ArrangeToolbar INSIDE `HomeBoard` (P1-2)**, not Dashboard: HomeBoard already computes the exact
  `editableNow = editing && activeBreakpoint==="lg" && !isSaving` gate (`HomeBoard.tsx:88`), which
  gives correct unmount on company-switch / drop-below-lg / isSaving; and the four `HomeBoard.*.test.tsx`
  harnesses render `<HomeBoardControls/> + <HomeBoard/>` (no Dashboard), so a Dashboard mount would
  make their `Done` assertions unreachable. Gate render on `editableNow`.
- Delete the `trayOpen` state + hand-rolled absolute tray from `HomeBoardControls`; retire
  `AddWidgetTray.tsx` (port its rows/filter/empty-copy into `AddWidgetMenu`).
- Tests: `useBoardEdit` — `addWidgetAndEdit` enters edit + appends the tile + is dirty (assert
  `editing===true`, `lg.length` grew, `dirty===true`). **`AddWidgetMenu` tested STANDALONE with
  props (P2-1)** — pass `boardKeys`/`role`/`onAdd` directly and assert the filtered list
  (on-board excluded; `requiresFounder` hidden when `role==="team_member"`, shown otherwise); do
  NOT drive it *through* the customize Radix submenu — `DropdownMenuSub` content opens on
  pointer-hover with an internal timer that jsdom/`userEvent` fire unreliably (the "InputAddMenu
  precedent" is a FLAT menu, not a submenu — it does NOT prove submenu opening). Customize
  dropdown test — assert the three items incl. the `Add widget` sub-*trigger* is present (not that
  the sub-content opens), Reset shows a confirm, Rearrange calls `startEdit`, lg-gate intact.
  ArrangeToolbar — Done calls `exitEdit`, status states render, add-widget entry calls
  `addWidgetAndEdit`. Then repair the P1-1 edit-entry flows across Dashboard/HomeBoard/a11y/
  strictmode/e2e.
- Commit: `feat(home): customize dropdown + floating arrange toolbar (no header morph)`

### Task 4 — Activity de-noise
Files: `ActivityFeedWidget.tsx` (+ test); maybe a small pure helper `collapseActivity()` in
`ui/src/components/home/activityFormat.ts` (+ test).
- Collapse **consecutive** items sharing `action+entityType+entityId` into one row with a
  count suffix ("×N") when N>1; keep the newest `createdAt`; preserve order. Pure function,
  unit-tested. (Deep-link + label still per Plan 6 / `activityFormat`.)
- Optional: cap the rendered rows to a sensible number per size (the server already limits 20).
- Tests: `collapseActivity` — three identical consecutive → one "×3"; non-adjacent duplicates
  stay separate; distinct actions untouched. Widget renders the collapsed rows + still
  deep-links + editing-gate intact.
- Commit: `feat(home): collapse repeated activity events (de-noise)`

### Task 5 — Curated default layout + Waiting-on-you sizing + packing
Files: `packages/shared/src/home-board.ts` (approvals sizes); `defaultLayout.ts` (+ rewrite the
stale packing comment at `:4-75`); `packages/shared/src/__tests__/home-board-layout.test.ts`;
`server/src/__tests__/routes-home-board-layout.test.ts`; `ui/src/__tests__/home/defaultLayout.test.ts`,
`gridLayout.test.ts`, `HomeBoard.test.tsx`, `HomeBoard.a11y.test.tsx`, `HomeBoard.strictmode.test.tsx`,
`HomeBoard.queries.test.tsx`. (`registry.test.ts` + `widget-completeness.test.tsx` unaffected — all
10 stay registered; `defaultSize=allowedSizes[0]` still holds → approvals default becomes 2×2 automatically.)
- `HOME_BOARD_ALLOWED_SIZES["approvals"]` → `[{w:2,h:2},{w:2,h:1},{w:4,h:2}]` (was `[{1,1},{2,1}]`).
- **P1-3 fixture trap:** `home-board-layout.test.ts:15` `VALID_FULL_LAYOUT` has `approvals` at
  `1×1` (now disallowed) → the "valid full layout" tests (`:24`, `:98`) fail. Change that entry to
  `{ i:"approvals", x:2, y:0, w:2, h:1 }` (2×1). Do NOT use 2×2 there — h:2 at cols 2-3 overlaps
  `suggestions` at `(2,1,2,1)` → overlap failure. `agents-now 2×2` disallowed + server
  `OVERSIZE_LAYOUT` use agents-now/budget, NOT approvals → stay green, no change. The
  `home-board-layout.integration.test.ts:180` upsert (approvals 1×1, no validation, no size assert)
  passes as-is — leave it.
- `defaultLayout.ts` FOUNDER/MEMBER → the curated **stats-last** arrays (Locked decisions).
  Dropping widgets from the DEFAULT is safe (still registered + tray-addable via `reconcileLg`).
- **P1-4 composition-assertion breaks to rewrite:**
  - `defaultLayout.test.ts:11-18` founder `toHaveLength(10)` + `toContain("memory-review")` → 8, no
    memory-review/suggestions. `:25-33` member `not.toContain("approvals")` → member NOW INCLUDES
    approvals (flip it).
  - founder-count `10`→`8`: `HomeBoard.test.tsx:196,244,256,303,398,561`,
    `HomeBoard.strictmode.test.tsx:161,187`, `HomeBoard.queries.test.tsx:155`,
    `HomeBoard.a11y.test.tsx:102-113` `FOUNDER_TITLES` (10→8 entries, drives `:134-138,154,163-166`).
  - `HomeBoard.queries.test.tsx:204-220` (member): approvals is now on the member board, so
    `expect(apiSpies.approvalsList).not.toHaveBeenCalled()` (`:218`) + `workQuestionsList` (`:219`)
    must flip to `toHaveBeenCalled()`; fix the now-false `:216` comment. Re-derive the founder query
    assertions for the new 8-set (suggestions/memory-review dropped).
- **P3-3 packing:** stats-last order gives founder 7 rows / 0 interior gaps, member likewise —
  verify empirically with the real `buildDefaultLg` (no overlap, `x+w<=4`, `< HOME_BOARD_MAX_ROWS`).
  Rewrite the 70-line packing rationale comment in `defaultLayout.ts:4-75` to match.
- Update `HomeBoard.test.tsx` heading-order / keyboard-announcement-row assertions that shift.
- Commit: `feat(home): curated default board + Waiting-on-you list sizing`

### Task 6 — Verify + live check
- `pnpm typecheck` clean; `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/home src/__tests__/Dashboard.test.tsx`;
  `pnpm --filter @armyofagents/shared exec vitest run src/__tests__/home-board-layout.test.ts`;
  `pnpm --filter @armyofagents/server exec vitest run src/__tests__/routes-home-board-layout.test.ts` — all green.
- **e2e (P1-1):** vitest does NOT cover `tests/e2e/home-widget-board.spec.ts`, which Task 3 edits
  heavily. Windows skips e2e, so it only truly validates on the Linux CI gate at PR time — the
  edits must still be made + self-consistent. Optionally run locally via `AOA_E2E_FORCE_WINDOWS=1`
  (embedded-PG permitting). Do NOT consider Plan 7 "green" on Windows vitest alone re: the e2e.
- Live (I do this): sync `hwb`, rebuild `shared` (approvals sizes + any shared change), restart,
  verify Create menu (6 items), date line, flush alignment, customize dropdown (outside-click
  close, no header shift), floating Done, collapsed activity, and Reset → curated default.
- Commit: `test(home): verify Plan 7 (create menu, customize UX, defaults)`

## Test / infra notes
- Radix menus open in this jsdom via `userEvent.click` + `findByRole("menuitem")` (precedent
  `InputAddMenu.test.tsx`); submenu content renders on hover/click of the sub-trigger.
- New widgets/menus import `Link` from `@/lib/router`; test hrefs are unprefixed (`selectedCompany:null`).
- `registry.test.ts` stays at 10 keys (no new widgets this plan) — only defaults + one widget's
  sizes change.
- The floating ArrangeToolbar uses `position: fixed` (real app, allowed) — ensure it doesn't
  cover the board's last row (bottom offset) and is hidden when not `editableNow`.

## Self-review notes (author)
- Objectives enrichment is NOT in scope (already shipped) — don't re-add.
- `addWidget` from view mode is a trap (stale closure) — the plan mandates `addWidgetAndEdit`;
  a reviewer should reject any PR wiring the raw `addWidget` to a view-mode menu item.
- Waiting-on-you size change drops `1×1` (not a pure superset) — existing boards clamp on load;
  that's the one migration wrinkle, called out + test-covered.
- Curated defaults remove widgets from the default only, never from the registry — tray still
  offers them; members additionally can't see `requiresFounder` ones.
- Header must not morph or shift the Create button in any state — that was the core complaint.
