# Plan 6 — Home board: header redesign, deep-linking, and new widgets

Status: ready to execute (subagent-driven). Branch `claude/home-page-widgets-a927af`.
Continues Plans 1–5 (all merged into this branch, unpushed). Driven by founder
design feedback after the Plan 5 live check.

## Goal

Tighten the top of the Home board and make widgets genuinely actionable:

1. **Header → one line.** Replace the greeting subline + the three big quick-action
   cards with a compact `+ New ▾` menu and a single **customize icon** (replacing the
   "Edit board" text button). Enter edit mode straight from the icon.
2. **Row-level deep-linking.** A tile's *title* opens its surface page (peek → drill);
   each *row* opens the specific entity. Rows never navigate while editing.
3. **Arrange-mode affordance.** In edit mode the whole tile already drags — make that
   obvious (grab cursor + arrange-mode outline).
4. **"Waiting on you"** — rename the existing Approvals widget (title only) and turn its
   count into a deep-linked list of the actual approvals + ask-human questions.
5. **Two new widgets** — Discussions (recent threads) and Memory review (pending memory
   awaiting approval).

Deferred by founder: Crew board (not needed), Workspaces, Recent deliverables.

## Locked decisions (from the design discussion)

- Header is a single line: `Good <time>, <Name>` left; `+ New ▾` + customize icon right.
- Drop the "N items need attention" / "All clear" subline entirely.
- `+ New ▾` menu items = New task, Discussion, New goal (the current three). Uses the
  real `DropdownMenu` primitive.
- Customize icon → tap goes **straight into edit mode** (no intermediate menu). Add
  widget / Reset / Done stay as the in-edit chrome (unchanged from Plan 3/5).
- "Waiting on you" = approvals **and** ask-human questions only (NOT memory — that's its
  own widget). It already combines both today.
- Memory review is founder-oriented (FOUNDER default layout only, `requiresFounder`).

## Critical constraints (do not violate)

- **NEVER rename the `approvals` widget key.** `HOME_BOARD_WIDGET_KEYS` is the persistence
  key set; `home_board_layouts` stores tiles by these strings and the validator looks
  `item.i` up directly in `HOME_BOARD_ALLOWED_SIZES`. Renaming the key ⇒ PATCH 400 +
  `reconcileLg()` silently drops the tile from every saved board. Change the registry
  **`title` only** (title is not part of the persisted schema — zero migration impact).
- **New widget keys are additive-safe.** Adding `discussions` + `memory-review` to
  `HOME_BOARD_WIDGET_KEYS` / `HOME_BOARD_ALLOWED_SIZES` / registry / defaultLayout is
  fine — old saved boards simply won't contain them until the user adds them or Resets
  (same behaviour as any new widget; `reconcileLg` only *drops* unknown keys, it does not
  reject the payload). `HOME_BOARD_MAX_ITEMS` derives from the key count, so it grows
  automatically.
- **Whole-tile drag already works.** `HomeBoard`'s `dragConfig` sets no `handle`, only
  `cancel: ".home-board-tile-remove"`. Do not add a `handle`. This task is CSS affordance
  only (cursor + outline while editing).
- **Work questions have no standalone route.** Deep-link a question row to its task
  (`/issues/${issueIdentifierSnapshot ?? issueId}` — the task view mirrors the question).
  Approvals have a real page: `/approvals/${id}`.
- **Rows must not navigate while editing.** Every row that becomes a link takes the
  widget's `editing` prop and renders a plain element (no `Link`) when editing, exactly
  like `WidgetShell` swaps its header `Link`→`div`.
- Keep the four-way widget contract from Plan 5 (loading / error / empty / content); the
  `widget-completeness` meta-test enforces it for every registered widget.

## Grounding (verified — file:line)

- `useDialog()` — `ui/src/context/DialogContext.tsx`: `openNewIssue(defaults?)`,
  `openDiscussionCapture(defaults?)`, `openNewGoal(defaults?)`, also `openNewAgent`,
  `openNewProject`, `openNewThread`.
- Dropdown primitive — `ui/src/components/ui/dropdown-menu.tsx` (Radix). Precedent:
  `ui/src/components/commander/InputAddMenu.tsx` (`DropdownMenu` > `DropdownMenuTrigger asChild`
  > `DropdownMenuContent` > `DropdownMenuItem onSelect=…`).
- Header JSX — `ui/src/pages/Dashboard.tsx:137-153` (greeting + `statusLine` subline;
  3× `QuickActionCard` in `grid-cols-3`; then `<HomeBoard>`). `getGreeting()` at :21;
  `statusLine`/`statusParts`/`liveAgentCount` at :101-122 (feed only the subline —
  removable). `buildActionGroups`/`getTotalActionCount` also feed the bottom "Nothing
  needs attention" card at :157-161 — LEAVE that card and those helpers.
- RGL config — `ui/src/components/home/HomeBoard.tsx:128-141`: `dragConfig={{ enabled: editableNow, cancel: REMOVE_BUTTON_CANCEL_SELECTOR }}`,
  `resizeConfig={{ enabled: editableNow }}`, `rowHeight={120}`. `editableNow = editing && activeBreakpoint === "lg" && !isSaving` (:87).
- `WidgetShell` — `ui/src/components/home/widgets/WidgetShell.tsx`: header is a `Link to={to}`
  when not editing, plain `div` when editing; body is `children`. Takes `editing?: boolean`.
- `ApprovalsWidget` — `ui/src/components/home/widgets/ApprovalsWidget.tsx`: already sums
  `dashboardApi.summary().pendingApprovals` + `workQuestionsApi.list(companyId,{scope:"mine",status:"open"})`
  and labels the total "waiting on you".
- `approvalsApi.list(companyId, "pending")` → `Approval[]` (`ui/src/api/approvals.ts`;
  route `server/src/routes/approvals.ts:101`). `Approval`: `{id,type,payload,status,…}`.
  `ApprovalType` label/icon maps live in `ui/src/components/ApprovalPayload` (used by
  `ApprovalCard.tsx`) — reuse for row labels. Row link: `/approvals/${id}`.
- `WorkQuestion` (`packages/shared/src/work-questions.ts`): `{id,title,question,issueId,issueIdentifierSnapshot,issueTitleSnapshot,askingAgentNameSnapshot,status,…}`.
  Row link: `/issues/${issueIdentifierSnapshot ?? issueId}`.
- `discussionsApi.list(companyId, filters?)` → **`DiscussionListResponse = { discussions: DiscussionListItem[]; total; limit; offset }`**
  (NOT a bare array — `ui/src/api/discussions.ts:47-52`). `DiscussionListItem`:
  `{id,title,status,entryCount,pendingItemCount,lastEntryAt,createdAt,scopeName,…}` (no
  `updatedAt`). The widget MUST read `res.discussions`. Row link: `/discussions/${id}`
  (see `ThreadsList.tsx:598`). Sort by `lastEntryAt ?? createdAt` desc (or pass
  `{ status:"active", sortBy:"lastEntryAt", sortOrder:"desc", limit:5 }` if supported and
  still read `.discussions`).
- `memoryApi.listPending(companyId)` → `PendingMemoryQueue { items: MemoryItem[]; versions; archives; totalCount }`
  (`ui/src/api/memory.ts`). `MemoryItem`: `{id,title,content,layer,category,status,…}`.
  Row link: `/memory/explore?item=${id}&type=memory_item` (`MemoryExplorer.tsx` reads
  `?item` + `?type`). Title link: `/memory`.
- Activity deep-link helper — `entityLink(entityType, entityId, name?)` in
  `ui/src/lib/activityFormat.ts:65-78` (`issue`→`/issues/:name??id`, `goal`→`/goals/:id`,
  `agent`→`/agents/:id`, `approval`→`/approvals/:id`, else null). `RecentActivityItem`
  (`packages/shared/src/types/home.ts:12-21`) has `entityType`+`entityId` but **NO
  `entityName`** — call `entityLink(item.entityType, item.entityId)` with TWO args (the
  helper's `name??entityId` fallback already yields the correct `/issues/:id`).
- Registry — `ui/src/components/home/widgets/registry.ts` (`widgetRegistry`, `WidgetDef`
  = `{key,title,icon,Component,allowedSizes,defaultSize,requiresFounder?}`).
- Default layout — `ui/src/components/home/defaultLayout.ts`: `FOUNDER` (8 keys) / `MEMBER`
  (6 keys, no `approvals`/`budget`).
- Shared — `packages/shared/src/home-board.ts`: `HOME_BOARD_WIDGET_KEYS`,
  `HOME_BOARD_ALLOWED_SIZES` (stats `[1×1,2×1]`; list widgets `[2×2,2×1,4×2]`),
  `HOME_BOARD_MAX_ITEMS = keys.length`. Validator — `packages/shared/src/validators/home-board-layout.ts`.

---

## Tasks

Each task: TDD, commit at the end with the given message, run the named suites. Verify
line numbers against the real files (they drift). Do not touch the widget four-way state
logic except where a task says so.

### Task 1 — `+ New` menu + single-line header

Files: new `ui/src/components/home/NewMenu.tsx` (+ `NewMenu.test.tsx`); `ui/src/pages/Dashboard.tsx`;
`ui/src/__tests__/Dashboard.test.tsx`; `tests/e2e/home-widget-board.spec.ts` (P1-4).

- `NewMenu`: `DropdownMenu` (mirror `InputAddMenu`). Trigger = a `Button` "＋ New" with a
  chevron, `aria-label="Create"`. Items (each `DropdownMenuItem onSelect`): "New task" →
  `openNewIssue()`, "Discussion" → `openDiscussionCapture()`, "New goal" → `openNewGoal()`,
  each with its lucide icon (Plus / MessageSquare / Target). Pull openers from `useDialog()`.
- `Dashboard.tsx`: header row becomes greeting (`<h1>`) on the left and, on the right, a
  flex group `<NewMenu /> <HomeBoardControls boardEdit={boardEdit} />`. **Remove** the
  `statusLine` subline `<p>`, the `grid-cols-3` `QuickActionCard` block, and the now-unused
  `statusLine`/`statusParts`/`liveAgentCount`/`getGreeting`-adjacent bits **only if unused**
  (`getGreeting` stays; `QuickActionCard` component can be deleted if nothing else imports it —
  grep first). Keep `buildActionGroups`/`getTotalActionCount` + the bottom "Nothing needs
  attention" card untouched.
- `Dashboard.test.tsx`: update the guardrail — greeting still renders; the "N items need
  attention" subline is gone; a "＋ New" trigger is present; the three creators are no longer
  top-level buttons (they live behind the menu — assert the trigger exists, and open it with
  `userEvent.click` then assert the `menuitem`s "New task"/"Discussion"/"New goal" — Radix
  menus DO open in this jsdom, precedent `InputAddMenu.test.tsx`). Board + bottom card
  assertions stay. Specific breaks to fix (P1-4): the `getByText("+ New Task")` sites at
  ~:236,330,348 (now behind the menu, and the item label is "New task", not "+ New Task").
  Keep it a real behaviour guardrail, don't gut it.
- `tests/e2e/home-widget-board.spec.ts:17` asserts `getByText("+ New Task")` — update to
  assert the greeting or the `＋ New` trigger instead (e2e is not in the plan's local verify
  gate; Windows skips it — validate via Linux CI push or `AOA_E2E_FORCE_WINDOWS=1`).
- Cleanup (P3-12): after removing the cards/subline, drop now-unused `Dashboard.tsx` imports
  `Plus`/`MessageSquare`/`Target` (:19) and the `useLiveAgentCount` import+call (:10,:55);
  KEEP `Home` (used by EmptyState). Delete the Dashboard-local `QuickActionCard` component if
  nothing else imports it (grep first). `pnpm typecheck` has no `noUnusedLocals`, so this is
  hygiene, not a hard failure.

Commit: `feat(home): + New menu + single-line header (drop subline + action cards)`

### Task 2 — Customize icon + arrange-mode affordance

Files: `ui/src/components/home/HomeBoardControls.tsx`; `ui/src/components/home/HomeBoard.tsx`
(+/or `WidgetShell.tsx`). **Tests that reference `"Edit board"` and MUST be updated to
`"Customize board"` (P1-3, ~26 sites — not just "their tests"):**
`ui/src/__tests__/home/HomeBoard.test.tsx` (~20 sites), `HomeBoard.strictmode.test.tsx:156,158`,
`HomeBoard.a11y.test.tsx:136`, `ui/src/__tests__/Dashboard.test.tsx:374,391,399`, and
`tests/e2e/home-widget-board.spec.ts:58,111,131` (`exact:true`). Grep `Edit board` across
`ui/src` + `tests/e2e` to catch every site before finishing.

- `HomeBoardControls`: the view-mode toggle becomes an **icon button** — `LayoutGrid` (or
  `LayoutDashboard`) icon, `aria-label="Customize board"`, keep the exact disabled/tooltip
  gate (`disabled={isSaving || (!editing && activeBreakpoint !== "lg")}`, title "Edit on a
  larger screen (1024px+)") and `onClick={startEdit}`. Edit-mode chrome (Add widget / Reset
  in tray / Done) unchanged — "Done" may stay a text button.
- Arrange-mode visual: while `editableNow`, give each tile `cursor: grab` (`active:cursor-grabbing`)
  and a clearer editable outline (e.g. an emphasized/dashed ring). The grid wrapper already
  carries `data-home-board-editing` (Plan 5) — scope the CSS to it. Do not add an RGL `handle`.
- Tests: `HomeBoardControls` — renders an icon button with `aria-label="Customize board"`,
  still disabled below lg, calls `startEdit`. `HomeBoard` — tiles carry the grab-cursor/outline
  class when editing and not when idle.

Commit: `feat(home): customize icon + visible arrange-mode affordance`

### Task 3 — Row-level deep-linking

Files: `ui/src/components/home/widgets/ActivityFeedWidget.tsx`, `MyTasksWidget.tsx`,
**`ActionQueueGroup.tsx`** (the ActionQueue rows/`Link` live HERE, not in `ActionQueueWidget.tsx`
— P2-6); their tests. Audit only — `ObjectivesWidget` already links rows to `/goals/:id`;
`SuggestionsWidget` already interactive; `ActionQueueGroup.tsx:30` ALREADY renders correct
per-item `<Link to={item.to}>` (targets from `actionQueue.ts`), so its only delta is the
edit-mode gate.

- Each data row is a `Link` to its specific entity when `!editing`, and a plain
  non-navigating element when `editing`. **Import `Link` from `@/lib/router`** (auto-prefixes
  the company; never `react-router-dom`).
  - Activity → `entityLink(item.entityType, item.entityId)` (TWO args — no `entityName`, P1-2);
    if it returns null, render a plain row (not every activity has a target).
  - My tasks → `/issues/${task.identifier ?? task.id}`.
  - Action queue → thread `editing` from `ActionQueueWidget` → `ActionQueueGroup` and swap
    the existing `Link`→plain element when editing (targets already correct; do NOT rewrite them).
- Factor the editing-gated row link into a tiny local helper per widget (or reuse a shared
  `WidgetRowLink` if it reads cleanly). Hover affordance consistent with existing rows.
- Tests: per widget — a row is an anchor with the correct **unprefixed** `href`
  (`renderWithProviders` has `selectedCompany: null`, so assert `/issues/abc`, `/goals/g1`,
  etc. with no prefix — P3-11) when not editing, and is not a link when `editing`. Keep
  existing four-way tests green.

Commit: `feat(home): deep-link widget rows to their specific entity`

### Task 4 — "Waiting on you" (rename + deep-linked list)

Files: `ui/src/components/home/widgets/registry.ts` (title only); `ApprovalsWidget.tsx`
(keep the filename + key `approvals`); `ApprovalsWidget.test.tsx`;
`ui/src/__tests__/home/HomeBoard.test.tsx:142` (composition array asserts the old title — P2-7).

- Registry: `approvals.title` `"Approvals & questions"` → `"Waiting on you"`. **Keep
  `key: "approvals"`.** Icon may change to `Bell`/`BellRing` (optional).
- **P2-8: `ApprovalsWidget.tsx:28` hardcodes `<WidgetShell title="Approvals & questions">`
  independently of the registry.** Change BOTH in lockstep — the `widget-completeness`
  meta-test asserts the rendered heading equals the *registry* `title`, so a mismatch fails.
- `ApprovalsWidget`: replace the count with a **list**. Queries: `approvalsApi.list(companyId, "pending")`
  and `workQuestionsApi.list(companyId, {scope:"mine", status:"open"})`. Merge into rows:
  - approval → label from the `ApprovalType` map, link `/approvals/${a.id}`.
  - question → `q.title || q.question` (truncate), link `/issues/${q.issueIdentifierSnapshot ?? q.issueId}`.
    **P3-10: both `issueId` and `issueIdentifierSnapshot` are nullable** (Discussion/Commander-
    sourced questions) → when both are null render a non-navigating row (never `/issues/null`).
  - Cap at ~5 rows, "+N more" tail (like the run-summary file pattern).
  - Rows gated on `editing` (non-navigating while editing). `Link` from `@/lib/router`.
- Four-way: both queries must settle — `isLoading = aLoading || qLoading`, `isError = aErr || qErr`
  (keep the "no misleading partial total" guard). Empty (both empty) → `WidgetEmpty` "Nothing
  waiting on you" (no CTA). Content → the list.
- Tests: rewrite `ApprovalsWidget.test.tsx` for the list — renders approval + question rows
  with correct hrefs; empty state; loading; error; editing disables row links. Update the
  title assertion to "Waiting on you".

Commit: `feat(home): Waiting on you — deep-linked list of approvals + questions`

### Task 5 — Discussions widget (new)

Files: `packages/shared/src/home-board.ts` (add key + sizes); new
`ui/src/components/home/widgets/DiscussionsWidget.tsx` (+ test); `registry.ts`;
`defaultLayout.ts`; `widget-completeness.test.tsx`; **`ui/src/__tests__/home/registry.test.ts`
(hardcoded 8-key array + `toHaveLength(8)` — P1-5)**.

- Shared: add `"discussions"` to `HOME_BOARD_WIDGET_KEYS` and
  `HOME_BOARD_ALLOWED_SIZES["discussions"] = [{w:2,h:2},{w:2,h:1},{w:4,h:2}]` (list sizes).
  (`HOME_BOARD_ALLOWED_SIZES satisfies Record<HomeBoardWidgetKey,…>` and `widgetRegistry:
  Record<WidgetKey,…>` are total, so TS FORCES the new entry — you can't silently miss the
  type-enforced sites; only test arrays need manual updates.)
- `DiscussionsWidget`: `const res = await discussionsApi.list(companyId, { status: "active" })`
  then **`res.discussions`** (the call returns `{discussions,…}`, NOT an array — P1-1), sort by
  `lastEntryAt ?? createdAt` desc, take top ~5. Rows: title + a meta line (`entryCount` entries
  · `pendingItemCount` pending if >0), link `/discussions/${d.id}` when `!editing` (`Link` from
  `@/lib/router`). Four-way; empty → "No discussions yet" + CTA "＋ New discussion"
  (`openDiscussionCapture()`), CTA hidden while editing. Title link `/discussions`. Icon `MessagesSquare`.
- Registry entry + add `"discussions"` to `FOUNDER` and `MEMBER` in `defaultLayout.ts`.
- `registry.test.ts`: extend the expected key array + bump `toHaveLength` (→ 9 after this task,
  10 after Task 6).
- `widget-completeness` meta-test (P2-9): add `vi.mock` for `discussionsApi.list` (→ empty) and
  add `openDiscussionCapture` to the `useDialog` mock (currently only `openNewIssue`/`openNewGoal`),
  else the widget silently renders via its error arm instead of the intended empty path.

Commit: `feat(home): Discussions widget (recent active threads)`

### Task 6 — Memory review widget (new)

Files: `packages/shared/src/home-board.ts` (key + sizes); new `MemoryReviewWidget.tsx` (+ test);
`registry.ts`; `defaultLayout.ts`; `widget-completeness.test.tsx`;
**`ui/src/__tests__/home/registry.test.ts`** (bump to 10 keys — P1-5).

- Shared: add `"memory-review"` + `HOME_BOARD_ALLOWED_SIZES["memory-review"] = [{w:2,h:2},{w:2,h:1},{w:4,h:2}]`.
- `MemoryReviewWidget`: `memoryApi.listPending(companyId)` → returns `{items, versions, archives,
  totalCount}`; render `data.items` (pending `MemoryItem`s), top ~5. Rows: title + `layer` chip,
  link `/memory/explore?item=${m.id}&type=memory_item` when `!editing` (`Link` from `@/lib/router`).
  Four-way; empty → "No memory to review" (no CTA — creation isn't a founder action here). Title
  link `/memory`. Icon `Brain`. Handle 403/error via the error arm (a member without access just
  sees "Couldn't load").
- Registry entry with `requiresFounder: true` (UX-only flag — declared but unused today; harmless).
  Add `"memory-review"` to **FOUNDER only** (not MEMBER), matching approvals/budget.
- `registry.test.ts`: expected key array + `toHaveLength(10)`.
- `widget-completeness` meta-test (P2-9): extend the existing `../../api/memory` mock (stubs only
  `create` today) with `listPending` → `{items:[],versions:[],archives:[],totalCount:0}`.

Commit: `feat(home): Memory review widget (pending items awaiting approval)`

### Task 7 — Packing, completeness, full verify + live check

- Default layout now has 10 founder widgets / 7 member widgets. Verify `buildDefaultLg`
  output for both roles: no overlap, `x+w <= 4`, gaps minimized (measure via the real
  functions; retune the `FOUNDER`/`MEMBER` order only if a cheap reorder removes interior
  gaps — document, don't guess). Update `defaultLayout.test.ts` + any `HomeBoard.test.tsx`
  heading-order/keyboard-announcement assertion that shifts.
- `widget-completeness.test.tsx`: now 10 widgets, all four-way + titled shell. Update the
  expected key list.
- Full verify: `pnpm typecheck` clean; `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/home src/__tests__/Dashboard.test.tsx` green;
  `pnpm --filter @armyofagents/shared exec vitest run src/__tests__/home-board-layout.test.ts` green;
  `pnpm --filter @armyofagents/server exec vitest run src/__tests__/routes-home-board-layout.test.ts` green.
- Live check (I do this, not a subagent): sync `hwb`, rebuild `shared`, restart, verify the
  new header + menu + customize icon + the 3 widget changes at `lg`.

Commit: `test(home): packing + completeness for 10-widget board`

---

## Test / infra notes

- UI tests: Vitest + jsdom + `renderWithProviders` (mock `useCompany`; for menu tests the
  Radix `DropdownMenu` renders in a portal — query with `screen`/`findByRole("menuitem")`,
  and `userEvent.click` the trigger to open). Mock `useDialog` openers.
- New API clients used in tests (`approvalsApi.list`, `discussionsApi.list`,
  `memoryApi.listPending`) get mocked like the existing widget queries (per-widget
  `useQuery`). Follow the ApprovalsWidget test's existing mock style. In
  `widget-completeness.test.tsx` (P2-9) ADD `vi.mock("../../api/approvals")` (Task 4 makes
  ApprovalsWidget call `approvalsApi.list`, currently only `dashboardApi` is mocked there),
  the `discussionsApi.list` + `memoryApi.listPending` mocks, and `openDiscussionCapture` in the
  `useDialog` mock — each resolving empty so the widgets hit their intended empty arm.
- Deep-link href assertions (P3-11): `renderWithProviders` sets `selectedCompany: null`, so
  `@/lib/router` `Link` renders the path UNPREFIXED — assert `/issues/abc`, `/approvals/q1`,
  `/goals/g1`, `/discussions/d1`, `/memory/explore?item=…&type=memory_item` verbatim. New
  widgets import `Link` from `@/lib/router` (never `react-router-dom`).
- Server/shared: adding keys touches `home-board-layout.test.ts` (shared) — it asserts the
  key set / disallowed sizes; extend the key list, keep the `agents-now 2×2` disallowed case
  and the server `OVERSIZE_LAYOUT` case green (stats unchanged).
- Registry test (`registry.test.ts`) asserts `defaultSize === allowedSizes[0]`,
  reference-equality to the shared constant, AND a hardcoded key array + `toHaveLength(N)` —
  new entries must satisfy all three (bump the array + count in Tasks 5/6).

## Self-review notes (author)

- Title-only rename for approvals keeps persistence stable (title isn't in the validator).
  New keys are supersets of the old key set → existing saved boards validate unchanged and
  just lack the new tiles until Reset/Add.
- The `+ New` menu removes three always-visible creators; the Dashboard guardrail must prove
  the creators are still reachable (open the menu) so we don't regress discoverability silently.
- Whole-tile drag is unchanged behaviour — Task 2 is affordance only; don't add a `handle`
  (that would *reduce* the drag surface to the header, the opposite of the ask).
- Memory review is founder-scoped by default layout; the widget still must not crash for a
  member who adds it — the error arm covers a 403.
- Work-question rows link to the task, not a question page (none exists). If we later add a
  question route, swap the row target; the task view mirrors the question today.
