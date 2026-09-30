# Hub Tabbed-Viewer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Inbox hub's viewer into a **tab-first, no-preview** workspace (LOCKED decision, 2026-07-04). Row-click opens AND activates a dedicated tab — there is NO reading-pane preview anywhere. The **Home tab hosts the "Needs you most" DASHBOARD** (`HubHome`), not a per-item preview. Deep-links open a tab; keyboard `j`/`k` move a list highlight and `Enter` opens the highlighted item's tab; `Escape` clears the highlight (it never closes a tab — tabs close only via the strip × button). The redundant type-label header is dropped, every tab carries a contextual mirror-aware action bar (always targeting the ACTIVE tab's item), the `agent_runtime_decision` viewer becomes readable (roomy question + option cards + free-text fallback + context callout), the 8 placeholder viewers get real bodies, and the backend bug where an answered `work_question` never leaves the founder's "waiting on you" lane is fixed.

**Architecture:** Front-end is React + Vite + Tailwind v4 (`ui/src/`); the hub viewer is `HubShell` → `HubTabStrip` + `HubTabBody`, with tabs managed by `useHubTabs` and routed by `hubTabForItem(item)` (`hubRegistry.tsx`) → factories in `hubViewerModel.ts`. Under the tab-first model the Home tab's body is the `HubHome` dashboard (already used inside `listSection` when `activeLane === null` — HubShell.tsx:798-808); the former `HubHomeTab` reading pane and the whole `HubViewer` preview surface are **removed from the tabbed viewer** (HubHomeTab.tsx + its test are DELETED — HubHomeTab is imported only by HubShell; see Task 2). `HubList` already accepts an `onOpenItem` prop that prefers a tab-open over `onSelectItem`, and `useHubTabs.openTab` already dedups by key (`ensureTab`) + activates — so the row-click→tab change is mostly wiring `onOpenItem` through. Deep-links resolve the item and call `openTab(hubTabForItem(item))` (InboxHub.tsx deep-link effect). A new `HubActionBar` component holds the contextual/mirror-aware action set (relocated out of `HubViewer`'s footer, which is retired); the undo affordance folds into `HubActionBar` as a left banner so it never double-stacks with a separate undo row. The decision viewer redesign extends the shared `runtimeDecisionDetailSchema.options` + the `ask_founder` zod/JSON schema to carry EXPLICIT optional `description`/`rationale` fields — the `ask_founder` option object is `.strict()`, so unknown keys are rejected; the fields must be declared, not passed through (the JSON `options` DB column is arbitrary JSON — no migration). Backend: `ask_founder`'s `handleAskFounder` (`server/src/mcp/tools/ask-founder-tool.ts`) mirrors heartbeat's `waitAndRelay` pattern — after `waitForAnswer` returns an answer it calls `markRelayed` (agent-runtime-decisions.ts) which terminalizes the decision → `reconcileRuntimeDecision` closes the projected hub item.

**Tech Stack:** React 19, TanStack Query v5, Tailwind v4, lucide-react, vitest + @testing-library (UI), Express 5 + Drizzle + zod (server), embedded-postgres integration harness (env-gated Windows skip `AOA_RUN_WIN_INTEGRATION=1`).

---

## File-coupling map (READ FIRST — a prior parallel-commit run scrambled the git index)

Tasks that touch the **same file** MUST run **sequentially with a single committer** and use **explicit-path `git add`** (never `git add -A` / `git add .`). Do not run two of these in parallel:

| File | Tasks that write it |
|------|---------------------|
| `ui/src/components/hub/HubShell.tsx` | 1 (Home tab = dashboard; deep-link/j/k/Enter/Escape via props), 3 (mount action bar + retire preview wiring), 5 (thread `activeItem`) |
| `ui/src/pages/InboxHub.tsx` | 1 (deep-link effect → `openTab`) |
| `ui/src/components/hub/HubTabBody.tsx` | 4, 5, 6 (Task 1 changes only the `homeContent` VALUE passed from HubShell — `HubTabBody` already renders `homeContent`, no edit to this file in Task 1) |
| `ui/src/components/hub/HubViewer.tsx` | 2 (DELETED — orphaned by tab-first; its mirror gate + footer set are captured for Task 3's HubActionBar) |
| `ui/src/components/hub/hubViewerModel.ts` | 5 (routine factory) |
| `ui/src/components/hub/hubRegistry.tsx` | 5 (routine tabKind) |
| `packages/shared/src/validators/hub.ts` | 7 |
| `server/src/mcp/tools/ask-founder-tool.ts` | 7, 8 |
| `server/src/mcp/tools/index.ts` | 7 |
| `server/src/services/agent-runtime-decisions.ts` | (read-only — Task 8 calls `markRelayed`, does not edit the service) |

**DELETED files (tab-first, no-preview):** `ui/src/components/hub/HubHomeTab.tsx` + `ui/src/components/hub/__tests__/HubHomeTab.test.tsx` — the reading pane it hosted is gone (the Home tab now renders the `HubHome` dashboard). `HubHomeTab` is imported ONLY by `HubShell.tsx` (verified by grep; the mentions in `HubViewer.tsx:33` and `HubTabBody.tsx:41,53,244` are doc comments, not imports). Deletion happens in Task 1 (Home tab = dashboard). Any still-relevant assertion migrates to a `HubHome`-as-home-tab test in `HubShell.test.tsx`; the file is DELETED, not rewritten (Amendment 4).

**File-disjoint (parallelizable) task groups:** Task 5's eight viewer bodies are each a *new* component file (`ui/src/components/hub/viewers/*.tsx`) — those component files are disjoint and can be written in parallel — BUT they all get wired into `HubTabBody.tsx`, which is file-coupled; do the wiring edits to `HubTabBody.tsx` **sequentially** in one committer at the end of Task 5. Task 8 (backend integration test) is a new test file, disjoint from everything except that it depends on Task 7's schema + Task 8's own tool edit.

**Ordering (locked):** 1 → 2 → 3 → 3b → 4 → 7 → 5 → 6 → 8 → 9. (Tab-first behavior first — Task 1 now also lands the Home-tab-dashboard swap, the deep-link→tab effect, the j/k highlight + Enter, and the HubHomeTab deletion; Task 3b — the tab-cap affordance — follows Task 3 since new-tab-per-item makes the 12-cap reachable, and it touches `HubTabStrip` (disjoint from HubShell); option schema (7) lands before the placeholder viewers (5) so the decision cards can consume the fields; backend fix (8) after the option-schema tool edit (7) since both edit `ask-founder-tool.ts`; docs/full-suite last.) **File-coupling note:** because Task 1 and Task 3 and Task 5 all write `HubShell.tsx`, and Task 1 and Task 3 both touch the `viewer` block, they MUST run sequentially with a single committer and explicit-path `git add`.

---

## Task 1: Tab-first, no-preview — row-click opens+activates a tab, Home tab = dashboard, deep-link = tab, j/k = highlight + Enter opens

LOCKED decision (2026-07-04): the hub is **tab-first with NO preview pane**. This task lands four coupled front-end changes plus the `HubHomeTab` deletion:

1. **Row-click opens AND activates a tab.** Wire `HubShell` to pass `onOpenItem` into `HubList`. `HubList` already prefers `onOpenItem` over `onSelectItem` on row click (HubList.tsx:160-167), and `useHubTabs.openTab` already dedups by key (`ensureTab`) + sets the active key (useHubTabs.ts:78-84) — so re-clicking an open item re-activates its existing tab (no duplicate). The parent's `handleOpenItem` (InboxHub.tsx:706-710) already caches the row + selects it + calls `openTab(hubTabForItem(item))`.
2. **The Home tab hosts the `HubHome` DASHBOARD, not a preview.** The Home tab body becomes the "Needs you most" dashboard (`HubHome` — already used inside `listSection` at HubShell.tsx:798-808) instead of the `HubHomeTab` reading pane over `selectedItem`.
3. **`HubHomeTab.tsx` + its test are DELETED** (only HubShell imported it — grep-verified).
4. **Deep-links open a tab.** The InboxHub deep-link effect (InboxHub.tsx:590-618) resolves the item and `openTab(hubTabForItem(item))` (+ activates) instead of only selecting it into a preview. URL/navigation behavior is unchanged.
5. **Keyboard: `j`/`k` move a list HIGHLIGHT, `Enter` opens the highlighted item's tab, `Escape` clears the highlight** (never closes a tab). HubShell's `j`/`k` handler (HubShell.tsx:266-286) today calls `onSelectItem` (which drove the preview). It changes to move a local highlight ref (still calls `onSelectItem` only to drive the center-list highlight + URL `:itemId`, NOT a preview — there is no preview to drive), and a new `Enter` handler calls `onOpenItem` for the highlighted row. `Escape` (HubShell.tsx:254-264) clears the highlight (`onSelectItem(null)` + `focusHubRow`) and does NOT close any tab.

> Design note — the action bar always targets the ACTIVE TAB's item. With no preview, a row-click opens+activates that tab, so there is no "selected row vs. active tab" divergence. Task 3's `activeBarItem` resolves the active tab's hub item directly (no preview-divergence handling).

> Mobile note (Amendment 2.2) — on `<lg` HubShell stacks `{listSection}` above `{viewer}` (HubShell.tsx:906-910); `{viewer}` is the tab strip + action bar + active tab body. Tab-first has NO preview to reconcile: a row-click on mobile opens+activates the tab, and the active tab renders in the stacked `{viewer}` region below the list (the SAME `viewer` node used on desktop — no mobile-only branch). Deep-links likewise open a tab. No extra mobile code path is needed; the tab-first change is layout-agnostic. This is a confirmation, not a separate code change — the stacked mobile layout already shows whatever `activeTab` is.

**Files:**
- Modify: `ui/src/components/hub/HubShell.tsx` (Home tab body → `HubHome`; `<HubList onOpenItem>`; j/k highlight + Enter-opens; drop the `HubHomeTab` import + reading-pane wiring)
- Modify: `ui/src/pages/InboxHub.tsx` (deep-link effect → `openTab`; the `onOpenItem` prop is already wired)
- Delete: `ui/src/components/hub/HubHomeTab.tsx`
- Delete: `ui/src/components/hub/__tests__/HubHomeTab.test.tsx`
- Test: `ui/src/components/hub/__tests__/HubShell.test.tsx` (row-click opens+activates a tab; re-click dedups; Home tab renders the dashboard; j/k highlight; Enter opens; Escape doesn't close a tab; the OLD `:258-267` select-only + `:269-279` reading-pane + `:344-352`/`:683-694` close-viewer tests are rewritten/removed)
- Test: `ui/src/__tests__/InboxHub.test.tsx` (deep-link now opens a tab — the 3 runtime-decision deep-link tests assert the panel renders IN A TAB body; the row-click path asserts a tab appears)

- [ ] **Step 1: Write the failing tests (HubShell)**

Add to `ui/src/components/hub/__tests__/HubShell.test.tsx` inside `describe("HubShell", …)`, and REWRITE the OLD-model tests:

- REWRITE `"selects the item into the reading pane when a row is clicked"` (:258-267) → a row-click now calls `onOpenItem`, not `onSelectItem`:

```tsx
  it("opens AND activates a dedicated tab when a list row is clicked (tab-first)", async () => {
    const user = userEvent.setup();
    const onOpenItem = vi.fn();
    renderShell({ onOpenItem });

    await user.click(screen.getByRole("button", { name: /review hire approval/i }));

    // Row-click opens the item's dedicated tab (HubList prefers onOpenItem).
    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: "hub-1" }));
  });

  it("does NOT add a duplicate tab when the same row is clicked twice (ensureTab dedups)", async () => {
    const user = userEvent.setup();
    const onOpenItem = vi.fn();
    renderShell({ onOpenItem });

    const row = screen.getByRole("button", { name: /review hire approval/i });
    await user.click(row);
    await user.click(row);

    // Both clicks call the open handler; dedup + re-activate lives in useHubTabs
    // (openTab → ensureTab), so HubShell just forwards each click. Assert HubShell
    // forwards every click (the dedup contract is proven in the useHubTabs suite,
    // Amendment 2 tab-cap test).
    expect(onOpenItem).toHaveBeenCalledTimes(2);
    expect(onOpenItem).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "hub-1" }));
    expect(onOpenItem).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "hub-1" }));
  });
```

- REWRITE `"renders the selected item in the Home reading pane and opens it full via a tab"` (:269-279) → the Home tab now renders the DASHBOARD, not a reading pane:

```tsx
  it("renders the HubHome dashboard as the Home tab body (no reading-pane preview)", () => {
    // The Home tab body is the "Needs you most" dashboard, regardless of any
    // center-list selection — there is no per-item preview surface anymore.
    renderShell({ selectedItemId: "hub-1", tabs: [HOME_TAB], activeTabKey: "home" });

    // The dashboard renders inside the tab body (viewer panel), not the list.
    const body = screen.getByTestId("hub-tab-body");
    expect(within(body).getByText(/needs you most/i)).toBeInTheDocument();
    // No reading-pane chrome: the old "Open full" button + hub-viewer aside are gone.
    expect(within(body).queryByRole("button", { name: /open full/i })).toBeNull();
    expect(screen.queryByRole("complementary", { name: /hub viewer/i })).toBeNull();
  });
```

(add `within` to the testing-library import at line 2: `import { render, screen, within } from "@testing-library/react";`)

- ADD a j/k-highlight + Enter-opens + Escape test:

```tsx
  it("moves a list highlight with j/k and opens the highlighted item's tab on Enter", async () => {
    const user = userEvent.setup();
    const onSelectItem = vi.fn();
    const onOpenItem = vi.fn();
    renderShell({
      onSelectItem,
      onOpenItem,
      items: [
        { ...items[0], id: "hub-1", title: "First approval" },
        { ...items[0], id: "hub-2", title: "Second approval" },
      ],
    });

    // j/k move the highlight (drives the center-list highlight + URL, NOT a preview).
    await user.keyboard("j");
    expect(onSelectItem).toHaveBeenLastCalledWith("hub-1");
    await user.keyboard("j");
    expect(onSelectItem).toHaveBeenLastCalledWith("hub-2");

    // Enter opens the highlighted row's tab.
    await user.keyboard("{Enter}");
    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: "hub-2" }));
  });

  it("Escape clears the list highlight and does NOT close a tab", async () => {
    const user = userEvent.setup();
    const onSelectItem = vi.fn();
    const onCloseTab = vi.fn();
    renderShell({ selectedItemId: "hub-1", onSelectItem, onCloseTab });

    await user.keyboard("{Escape}");

    // Escape clears the highlight (selection) — tabs are untouched.
    expect(onSelectItem).toHaveBeenCalledWith(null);
    expect(onCloseTab).not.toHaveBeenCalled();
  });
```

- DELETE the OLD `"closes the viewer with a nullable selection"` (:344-352) and `"focuses the viewer heading and restores focus to the selected row on close"` (:683-694) tests — they clicked a "Close viewer" button that no longer exists (no reading pane). Their Escape-clears-selection coverage is now in the Escape test above. Also DELETE the OLD `"moves selection with j and k"` test (:650-668) — superseded by the j/k-highlight test above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npx vitest run src/components/hub/__tests__/HubShell.test.tsx -t "tab-first"`
Expected: FAIL — HubShell still renders `HubHomeTab` (reading pane) and does not pass `onOpenItem` to `HubList`, and there is no `Enter`-opens handler.

- [ ] **Step 3: Home tab renders the dashboard + drop the reading-pane wiring**

In `ui/src/components/hub/HubShell.tsx`:

(a) Remove the `HubHomeTab` import (line 30: `import { HubHomeTab } from "./HubHomeTab";`). `HubHome` is already imported (line 29).

(b) The `viewer` block (HubShell.tsx:844-864) passes `homeContent={<HubHomeTab … />}`. Replace the whole `<HubTabBody … homeContent={…} />` so the Home tab renders the `HubHome` dashboard. Replace:

```tsx
          <div className="min-h-0 min-w-0 flex-1">
            <HubTabBody
              tab={activeTab}
              companyId={companyId}
              onOpenTab={onOpenTab}
              resolveHubItem={resolveHubItem}
              homeContent={
                <HubHomeTab
                  selectedItem={selectedItem}
                  auditRows={auditRows}
                  auditLoading={auditLoading}
                  onOpenFull={onOpenItem}
                  onClose={handleViewerClose}
                  onMarkUnread={onMarkUnread}
                  onDismiss={onDismiss}
                  onSnooze={onSnooze}
                  onLifecycleAction={onLifecycleAction}
                />
              }
            />
          </div>
```

with (the `HubHome` dashboard as `homeContent`; the action-bar `activeItem` wiring is layered on in Tasks 3 + 5):

```tsx
          <div className="min-h-0 min-w-0 flex-1">
            <HubTabBody
              tab={activeTab}
              companyId={companyId}
              onOpenTab={onOpenTab}
              resolveHubItem={resolveHubItem}
              homeContent={
                <HubHome
                  counts={counts}
                  items={homeItems ?? items}
                  visibleLanes={preferences.visibleLanes}
                  showAutopilotEntry={preferences.showAutopilotEntry}
                  autopilotPolicy={autopilotPolicy}
                  autopilotActions={autopilotActions.items}
                  onLaneChange={(lane: HubLane) => onLaneChange(lane)}
                  onUndoAutopilotAction={onUndoAutopilotAction}
                />
              }
            />
          </div>
```

(`HubHome`'s props all already exist in HubShell scope — the SAME call already renders in `listSection` at :799-808. `HubLane` is already imported via `@armyofagents/shared` — it is used at :393/:806. `auditRows`/`auditLoading`/`handleViewerClose`/`onMarkUnread`/`onDismiss`/`onSnooze`/`onLifecycleAction`/`selectedItem` become UNUSED by the viewer block after this — but `onMarkUnread`/`onDismiss`/`onSnooze`/`onLifecycleAction` are re-consumed by the `HubActionBar` in Task 3, and `selectedItem`/`auditRows`/`auditLoading` stay HubShell props for now; drop the local `handleViewerClose` helper at :293-296 since nothing references it after this — grep `handleViewerClose` to confirm it was only the HubHomeTab `onClose`.)

- [ ] **Step 4: Wire `onOpenItem` into HubList**

In `ui/src/components/hub/HubShell.tsx`, add `onOpenItem={onOpenItem}` to the `<HubList>` element (lines 810-826), immediately before `onSelectItem`:

```tsx
            <HubList
              items={items}
              isLoading={isLoading}
              error={error}
              selectedItemId={selectedItemId}
              selectedBulkIds={selectedBulkIds}
              hasMore={hasMore}
              isLoadingMore={isLoadingMore}
              groupMode={preferences.groupMode}
              density={preferences.density}
              onOpenItem={onOpenItem}
              onSelectItem={onSelectItem}
              onMarkRead={onMarkRead}
```

(`onOpenItem` is already a required HubShell prop — HubShellProps:80, destructured at :147, wired from InboxHub.tsx:863. No new prop plumbing needed.)

- [ ] **Step 5: Change j/k to a highlight + add Enter-opens; Escape clears highlight (no tab close)**

In `ui/src/components/hub/HubShell.tsx`, the keydown handler (HubShell.tsx:244-291). The `j`/`k` branch (:266-286) already maintains `keyboardSelectedItemId.current` and calls `onSelectItem(nextItem.id)` — under tab-first, `onSelectItem` drives ONLY the center-list highlight + URL `:itemId` (there is no preview). Keep that branch AS-IS (it is already a "move the highlight" action). ADD an `Enter` handler that opens the highlighted row's tab, placed right after the `Escape` branch (:254-264) and before the `j`/`k` branch (:266):

```tsx
      if (event.key === "Enter" && activeLane && items.length > 0) {
        const currentId = keyboardSelectedItemId.current ?? selectedItemId;
        if (!currentId) return;
        const target = items.find((item) => item.id === currentId);
        if (target) {
          event.preventDefault();
          onOpenItem(target);
        }
        return;
      }
```

The existing `Escape` branch (:254-264) already does `focusHubRow(selectedItemId)` + `onSelectItem(null)` (clear the highlight) and never touches tabs — that is exactly the tab-first Escape behavior. Leave it. Add `onOpenItem` to the effect's dependency array (:291): change `[activeLane, items, mobileRailOpen, onSelectItem, selectedItemId, showHome]` to `[activeLane, items, mobileRailOpen, onOpenItem, onSelectItem, selectedItemId, showHome]`.

- [ ] **Step 6: Deep-link opens a tab (InboxHub)**

In `ui/src/pages/InboxHub.tsx`, the deep-link effect (:585-618) currently only hydrates `openedItemCache` so the (now-removed) reading pane could preview the item. Change it to ALSO open+activate the item's tab once resolved, keeping the hydrate + the `deepLinkHandledRef` idempotence guard. Replace the effect body (:590-618):

```tsx
  useEffect(() => {
    const itemId = params.itemId;
    if (!itemId || !selectedCompanyId) return;
    if (deepLinkHandledRef.current === itemId) return;
    const listItem = items.find((item) => item.id === itemId);
    if (listItem || openedItemCache[itemId]) {
      if (listItem) {
        setOpenedItemCache((cache) => insertOpenedItem(cache, listItem));
      }
      deepLinkHandledRef.current = itemId;
      return;
    }
    deepLinkHandledRef.current = itemId;
    let cancelled = false;
    hubItemsApi
      .getOne(selectedCompanyId, itemId)
      .then((item) => {
        if (!cancelled) setOpenedItemCache((cache) => insertOpenedItem(cache, item));
      })
      .catch(() => {
        // Stale / hidden deep link — leave the reading pane empty.
      });
    return () => {
      cancelled = true;
    };
  }, [params.itemId, selectedCompanyId, items, openedItemCache]);
```

with (tab-first — resolve the row, then `openTab(hubTabForItem(row))`):

```tsx
  // Deep link (`/inbox/:lane/:itemId`) OPENS + activates the item's dedicated tab
  // (tab-first, no preview). If the item isn't in the loaded lane (hidden /
  // resolved / other lane), hydrate it once, then open its tab. The
  // `deepLinkHandledRef` guard keeps this idempotent so a later list refetch (or
  // a manual tab close) never re-opens the tab for the same `:itemId`.
  useEffect(() => {
    const itemId = params.itemId;
    if (!itemId || !selectedCompanyId) return;
    if (deepLinkHandledRef.current === itemId) return;
    const listItem = items.find((item) => item.id === itemId);
    const cached = openedItemCache[itemId];
    if (listItem || cached) {
      const row = listItem ?? cached;
      if (listItem) setOpenedItemCache((cache) => insertOpenedItem(cache, listItem));
      deepLinkHandledRef.current = itemId;
      if (row) openTab(hubTabForItem(row));
      return;
    }
    deepLinkHandledRef.current = itemId;
    let cancelled = false;
    hubItemsApi
      .getOne(selectedCompanyId, itemId)
      .then((item) => {
        if (cancelled) return;
        setOpenedItemCache((cache) => insertOpenedItem(cache, item));
        openTab(hubTabForItem(item));
      })
      .catch(() => {
        // Stale / hidden deep link — no tab to open.
      });
    return () => {
      cancelled = true;
    };
  }, [params.itemId, selectedCompanyId, items, openedItemCache, openTab]);
```

(`openTab` + `hubTabForItem` are already in scope — `openTab` from `useHubTabs` at InboxHub.tsx:132, `hubTabForItem` imported at InboxHub.tsx:23. No new imports.)

- [ ] **Step 7: Delete `HubHomeTab.tsx` + its test**

```bash
git rm ui/src/components/hub/HubHomeTab.tsx ui/src/components/hub/__tests__/HubHomeTab.test.tsx
```

(Grep confirmed HubHomeTab is imported only by HubShell — after Step 3 the import is gone, so nothing references it. Any still-useful assertion from `HubHomeTab.test.tsx` is superseded by the `"renders the HubHome dashboard as the Home tab body"` HubShell test in Step 1 — the file is DELETED, not rewritten. See Amendment 4.)

- [ ] **Step 8: Run test to verify it passes**

Run: `cd ui && npx vitest run src/components/hub/__tests__/HubShell.test.tsx`
Expected: PASS (all HubShell tests, including the tab-first row-click/dashboard/j-k/Enter/Escape tests).

- [ ] **Step 9: Update the InboxHub page-level tests — deep-link now opens a TAB**

`ui/src/__tests__/InboxHub.test.tsx`:

- `"writes canonical /inbox paths when lanes and items are selected"` (:392-407): the row-click at :403 still navigates to `/P4/inbox/waiting/hub-1` (handleOpenItem calls handleSelectItem) — this assertion stays valid. Add after :406 an assertion that a dedicated tab appeared:

```tsx
    // Row-click now also opens a dedicated tab for the item.
    expect(
      await screen.findByRole("tab", { name: /approve deployment/i }),
    ).toBeInTheDocument();
```

- The three runtime-decision deep-link tests (`"answers runtime permission prompts from the hub viewer"` :409, `"submits runtime work-question answers from the hub viewer"` :441, `"disables runtime decision actions after the prompt expires"` :483) deep-link to `/P4/inbox/waiting/hub-runtime`. Under tab-first the deep-link now OPENS A TAB (Step 6), so the `RuntimeDecisionPanel` renders inside the tab body (`data-testid="hub-runtime-decision-body"`), NOT a reading pane. Their content assertions (`Run pnpm test:run?`, `allow once`, `send answer`, the `work question answer` textbox, `allow always` disabled + `expired`) all still resolve — the panel is the same component (HubTabBody.tsx:188-200 hosts it via `resolveHubItem`). Add to each a guard that the panel is IN A TAB, e.g. for the permission test:

```tsx
    // The decision now renders inside a dedicated tab (tab-first), not a preview.
    expect(await screen.findByTestId("hub-runtime-decision-body")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /hub viewer/i })).toBeNull();
```

(The runtime_decision tab already resolves its row via `resolveHubItem` — which falls back to `openedItemCache` (InboxHub.tsx:620-624), and the deep-link effect hydrates that cache — so the panel resolves in the tab.)

- [ ] **Step 10: Run the affected page suite**

Run: `cd ui && npx vitest run src/__tests__/InboxHub.test.tsx`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add ui/src/components/hub/HubShell.tsx ui/src/pages/InboxHub.tsx ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/__tests__/InboxHub.test.tsx
git rm ui/src/components/hub/HubHomeTab.tsx ui/src/components/hub/__tests__/HubHomeTab.test.tsx
git commit -m "feat(hub): tab-first no-preview — row-click/deep-link open a tab, Home tab hosts the dashboard, j/k highlight + Enter opens"
```

---

## Task 2: Retire the `HubViewer` reading pane (orphaned by tab-first) — capture its mirror + footer logic for Task 3

Under tab-first (Task 1) there is NO reading-pane preview: the Home tab renders the `HubHome` dashboard and `HubHomeTab.tsx` is deleted. `HubViewer.tsx` had two render variants — `variant="tab"` (used ONLY by the now-deleted `HubHomeTab`) and `variant="aside"` (a legacy fixed 360px rail that is NOT mounted anywhere — grep: `<HubViewer` and `variant="tab"` appear ONLY in `HubHomeTab.tsx`). So after Task 1, `HubViewer.tsx` is fully ORPHANED (the remaining `HubViewer` mentions in `hubTypes.ts:6,19`, `HubTabBody.tsx:51,261` are the `HubViewerKind` type + doc comments, not imports). Its 42px header (HubViewer.tsx:110-126) and footer action grid (HubViewer.tsx:208-296) are therefore dead code, not chrome to gate.

This task DELETES `HubViewer.tsx` and records the two pieces of logic Task 3 reuses so they survive the deletion:

- **Mirror gate** (HubViewer.tsx:89-99) — copied verbatim into `HubActionBar` (Task 3):

```tsx
  const isRuntimeDecision = item.semanticType === "agent_runtime_decision";
  const isMirrored = (HUB_SOURCE_MIRRORED_TYPES as readonly string[]).includes(item.semanticType);
  const showResolveArchive = !(isRuntimeDecision || (isMirrored && item.status === "open"));
  const showClaimRelease = !isRuntimeDecision;
```

- **Footer action set** (HubViewer.tsx:208-296) — Mark-unread (when `item.readAt`) / Dismiss / Snooze / Resolve+Archive (gated) / Claim / Release (gated) — relocated into `HubActionBar` (Task 3). The "Open full" affordance is NOT relocated (row-click IS "open" in tab-first; there is no separate open-full).
- **Undo bar** (HubViewer.tsx:127-135) — the `RotateCcw` undo banner. Under tab-first the undo affordance gets a SINGLE home: it folds into `HubActionBar`'s LEFT edge (Task 3, Amendment 2.3), and Task 3 Step 6 REMOVES HubShell's list-panel undo row (HubShell.tsx:785-792) so there is never a second undo affordance.

**Files:**
- Delete: `ui/src/components/hub/HubViewer.tsx`
- (No test file for `HubViewer` exists; `HubHomeTab.test.tsx` was already deleted in Task 1.)

- [ ] **Step 1: Confirm `HubViewer` is orphaned**

Run: `cd ui && rg -n "HubViewer" src` — expect ONLY the `HubViewerKind` type in `hubTypes.ts` (lines 6, 19) + doc-comment mentions in `HubTabBody.tsx` (lines 51, 261). There must be NO `import { HubViewer }` / `<HubViewer` anywhere (HubHomeTab was deleted in Task 1). If any live import remains, STOP — the tab-first Task 1 wiring is incomplete.

- [ ] **Step 2: Delete the orphaned file**

```bash
git rm ui/src/components/hub/HubViewer.tsx
```

- [ ] **Step 3: Build to confirm no dangling reference**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors (nothing imports `HubViewer`; the `HubViewerKind` type in `hubTypes.ts` is independent of the deleted component).

- [ ] **Step 4: Run the hub suite**

Run: `cd ui && npx vitest run src/components/hub`
Expected: PASS (no test imported `HubViewer` directly; HubShell/HubTabBody tests exercise the tab bodies).

- [ ] **Step 5: Commit**

```bash
git rm ui/src/components/hub/HubViewer.tsx
git commit -m "refactor(hub): retire the orphaned HubViewer reading pane (tab-first, no preview)"
```

---

## Task 3: Slim contextual, mirror-aware `HubActionBar` on every tab (targets the ACTIVE TAB's item)

Build a standalone `HubActionBar` component (using the mirror gate + footer action set captured in Task 2 from the now-deleted `HubViewer`) that HubShell mounts above every tab body. It is contextual + mirror-aware: mirrored types (`approval_request`, `join_request`, `agent_runtime_decision`) hide Resolve/Archive while OPEN (the exact `showResolveArchive` logic from Task 2); runtime decisions additionally hide Claim/Release. Every tab shows Mark-unread (when read) / Dismiss / Snooze / (Resolve / Archive when allowed) / Claim / Release (when applicable) plus a **stubbed disabled "Route / Delegate"** button and a **stubbed disabled "Ask Commander to weigh in"** button (both `disabled`, with an `aria-label` naming the coming-soon action + `title="Coming soon"` — wiring is deferred, Amendment 2.4). It also folds in an optional **left-edge undo banner** (Amendment 2.3) so a tab-level undo never double-stacks with a separate undo row.

**Tab-first targeting (no preview divergence):** with no reading pane, a row-click opens+activates that item's tab, so the action bar always targets the ACTIVE TAB's item. The resolver is: decision/notification tabs carry `hubItemId` in their payload → resolve via `resolveHubItem`; entity tabs (task/thread/approval/…) key on the entity id, so `resolveHubItem` misses → fall back to the last-opened hub row (`selectedItem`, which the parent already tracks and caches). There is NO "selected row vs. active tab" special-casing.

**Files:**
- Create: `ui/src/components/hub/HubActionBar.tsx`
- Create: `ui/src/components/hub/__tests__/HubActionBar.test.tsx`
- Modify: `ui/src/components/hub/HubShell.tsx` (render `<HubActionBar>` between `<HubTabStrip>` and `<HubTabBody>` in the `viewer` block, ~lines 837-864, driven by the active tab's resolved hub item)

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/hub/__tests__/HubActionBar.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HubItemListRow } from "@/api/hub-items";
import { HubActionBar } from "../HubActionBar";

function row(overrides: Partial<HubItemListRow> = {}): HubItemListRow {
  return {
    id: "hub-1",
    companyId: "company-1",
    semanticType: "run_failed",
    lane: "notifications",
    status: "open",
    priority: "normal",
    title: "Run failed",
    summary: null,
    sourceType: "heartbeat_run",
    sourceId: "run-1",
    relatedEntityId: null,
    relatedEntityType: null,
    ownerUserId: null,
    ownerPool: null,
    claimedByUserId: null,
    claimedAt: null,
    version: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    groupKey: null,
    groupLabel: null,
    groupCount: null,
    scopeKey: null,
    slaAt: null,
    ...overrides,
  };
}

function renderBar(overrides: Partial<React.ComponentProps<typeof HubActionBar>> = {}) {
  const props = {
    item: row(),
    onDismiss: vi.fn(),
    onSnooze: vi.fn(),
    onLifecycleAction: vi.fn(),
    ...overrides,
  };
  render(<HubActionBar {...props} />);
  return props;
}

describe("HubActionBar", () => {
  it("shows Dismiss/Snooze/Resolve/Archive for a non-mirrored open item and fires them", async () => {
    const user = userEvent.setup();
    const props = renderBar();

    await user.click(screen.getByRole("button", { name: /^dismiss$/i }));
    expect(props.onDismiss).toHaveBeenCalledWith("hub-1");

    await user.click(screen.getByRole("button", { name: /^snooze$/i }));
    expect(props.onSnooze).toHaveBeenCalledWith("hub-1");

    await user.click(screen.getByRole("button", { name: /^resolve$/i }));
    expect(props.onLifecycleAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "hub-1" }),
      "resolve",
    );
    expect(screen.getByRole("button", { name: /^archive$/i })).toBeInTheDocument();
  });

  it("hides Resolve/Archive for an OPEN mirrored type but keeps Dismiss/Snooze", () => {
    renderBar({ item: row({ semanticType: "approval_request", sourceType: "approval" }) });

    expect(screen.queryByRole("button", { name: /^resolve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^dismiss$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^snooze$/i })).toBeInTheDocument();
  });

  it("hides Resolve/Archive/Claim/Release for a runtime decision", () => {
    renderBar({
      item: row({
        semanticType: "agent_runtime_decision",
        sourceType: "runtime_decision",
        ownerPool: "board",
      }),
    });

    expect(screen.queryByRole("button", { name: /^resolve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^claim$/i })).not.toBeInTheDocument();
  });

  it("offers Claim for an unclaimed board-pool item and Release for a claimed one", () => {
    const { rerender } = render(
      <HubActionBar
        item={row({ ownerPool: "board", claimedByUserId: null })}
        onDismiss={vi.fn()}
        onSnooze={vi.fn()}
        onLifecycleAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^claim$/i })).toBeInTheDocument();

    rerender(
      <HubActionBar
        item={row({ ownerPool: "board", claimedByUserId: "user-9" })}
        onDismiss={vi.fn()}
        onSnooze={vi.fn()}
        onLifecycleAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^release$/i })).toBeInTheDocument();
  });

  it("renders disabled Route/Delegate and Ask-Commander stubs with a coming-soon aria-label", () => {
    renderBar();
    // The stubs are disabled AND carry an explicit aria-label naming the
    // coming-soon action (a11y, Amendment 2.4) — not just the visible label.
    const route = screen.getByRole("button", { name: /route or delegate \(coming soon\)/i });
    const ask = screen.getByRole("button", { name: /ask commander to weigh in \(coming soon\)/i });
    expect(route).toBeDisabled();
    expect(ask).toBeDisabled();
  });

  it("renders a left-edge undo banner and fires onUndo when an undo action is present", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    render(
      <HubActionBar
        item={row()}
        onDismiss={vi.fn()}
        onSnooze={vi.fn()}
        onLifecycleAction={vi.fn()}
        undoAction={{ label: "dismiss", onUndo }}
      />,
    );
    // A single undo affordance (folded into the bar) — no separate undo row.
    const undo = screen.getByRole("button", { name: /undo dismiss/i });
    await user.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    // The action bar still renders exactly once (no double-stack).
    expect(screen.getAllByTestId("hub-action-bar")).toHaveLength(1);
  });

  it("offers Mark unread for an already-read item", async () => {
    const user = userEvent.setup();
    const onMarkUnread = vi.fn();
    render(
      <HubActionBar
        item={row({ readAt: "2026-07-01T00:00:00Z" })}
        onDismiss={vi.fn()}
        onSnooze={vi.fn()}
        onLifecycleAction={vi.fn()}
        onMarkUnread={onMarkUnread}
      />,
    );
    await user.click(screen.getByRole("button", { name: /mark unread/i }));
    expect(onMarkUnread).toHaveBeenCalledWith("hub-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/components/hub/__tests__/HubActionBar.test.tsx`
Expected: FAIL — `Cannot find module '../HubActionBar'`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/components/hub/HubActionBar.tsx`:

```tsx
import {
  Archive,
  CheckCircle2,
  Clock3,
  EyeOff,
  MessageCircleQuestion,
  RotateCcw,
  Share2,
  UserCheck,
  UserX,
} from "lucide-react";
import { HUB_SOURCE_MIRRORED_TYPES } from "@armyofagents/shared";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";

interface HubActionBarProps {
  item: HubItemListRow;
  onDismiss: (itemId: string) => void;
  onSnooze: (itemId: string) => void;
  onLifecycleAction: (
    item: HubItemListRow,
    action: "resolve" | "archive" | "claim" | "release",
  ) => void;
  onMarkUnread?: (itemId: string) => void;
  /** Optional undo banner folded into the LEFT edge of the bar so a tab-level
   *  undo never double-stacks with a separate undo row (Amendment 2.3). */
  undoAction?: { label: string; onUndo: () => void } | null;
}

/**
 * Slim contextual, mirror-aware action bar mounted above every hub tab body.
 * Mirror model (R3 + H1, D107): resolve/archive on a source-backed OPEN decision
 * item (approval_request / join_request / agent_runtime_decision) is
 * server-rejected while the source is undecided, so those two affordances are
 * hidden for OPEN mirrored types; runtime decisions additionally have no generic
 * Claim/Release surface. This is the SAME gate the retired HubViewer footer used
 * (captured in Task 2). Route/Delegate + Ask-Commander are stubbed (disabled,
 * aria-labelled "coming soon") — their wiring is a deferred follow-up. An
 * optional undo banner folds into the left edge (no double-stack with the
 * list-level undo row).
 */
export function HubActionBar({
  item,
  onDismiss,
  onSnooze,
  onLifecycleAction,
  onMarkUnread,
  undoAction,
}: HubActionBarProps) {
  const isRuntimeDecision = item.semanticType === "agent_runtime_decision";
  const isMirrored = (HUB_SOURCE_MIRRORED_TYPES as readonly string[]).includes(
    item.semanticType,
  );
  const showResolveArchive = !(isRuntimeDecision || (isMirrored && item.status === "open"));
  const showClaimRelease = !isRuntimeDecision;

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/40 px-4 py-2"
      data-testid="hub-action-bar"
    >
      {undoAction ? (
        <div className="mr-1 inline-flex items-center gap-2 rounded border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
          <span className="truncate">{undoAction.label}</span>
          <Button type="button" variant="ghost" size="sm" onClick={undoAction.onUndo}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Undo {undoAction.label}
          </Button>
        </div>
      ) : null}
      {item.readAt && onMarkUnread ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => onMarkUnread(item.id)}>
          <EyeOff className="size-4" aria-hidden="true" />
          Mark unread
        </Button>
      ) : null}
      <Button type="button" variant="secondary" size="sm" onClick={() => onDismiss(item.id)}>
        <EyeOff className="size-4" aria-hidden="true" />
        Dismiss
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => onSnooze(item.id)}>
        <Clock3 className="size-4" aria-hidden="true" />
        Snooze
      </Button>
      {showResolveArchive ? (
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onLifecycleAction(item, "resolve")}
          >
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Resolve
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onLifecycleAction(item, "archive")}
          >
            <Archive className="size-4" aria-hidden="true" />
            Archive
          </Button>
        </>
      ) : null}
      {showClaimRelease && item.ownerPool === "board" && !item.claimedByUserId ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onLifecycleAction(item, "claim")}
        >
          <UserCheck className="size-4" aria-hidden="true" />
          Claim
        </Button>
      ) : null}
      {showClaimRelease && item.claimedByUserId ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onLifecycleAction(item, "release")}
        >
          <UserX className="size-4" aria-hidden="true" />
          Release
        </Button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled
          aria-label="Route or delegate (coming soon)"
          title="Coming soon"
        >
          <Share2 className="size-4" aria-hidden="true" />
          Route / Delegate
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled
          aria-label="Ask Commander to weigh in (coming soon)"
          title="Coming soon"
        >
          <MessageCircleQuestion className="size-4" aria-hidden="true" />
          Ask Commander to weigh in
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/components/hub/__tests__/HubActionBar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit the standalone component (file-disjoint so far)**

```bash
git add ui/src/components/hub/HubActionBar.tsx ui/src/components/hub/__tests__/HubActionBar.test.tsx
git commit -m "feat(hub): add slim contextual mirror-aware HubActionBar with Route/Ask-Commander stubs"
```

- [ ] **Step 6: Mount the action bar in HubShell above the tab body**

`HubShell` must render `HubActionBar` for whatever hub item the ACTIVE tab represents. Resolve the active tab's item from its payload via the `resolveHubItem` prop (already threaded, HubShell.tsx:151) using the tab key's id, falling back to the last-opened hub row (`selectedItem`). In `ui/src/components/hub/HubShell.tsx`, add an import at the top with the other `./` imports (near line 29-35):

```tsx
import { HubActionBar } from "./HubActionBar";
```

Then locate the `viewer` block (HubShell.tsx after the Task-1 edit, ~:837-864). Between the `<HubTabStrip … />` and the `<div className="min-h-0 min-w-0 flex-1">`, compute the active tab's hub item and conditionally render the bar. **Undo single-home (Amendment 2.3):** the bar's `undoAction` reuses HubShell's existing `undoAction` prop so the undo affordance lives in ONE place — folded into the action bar's left edge. To avoid a second undo affordance, the existing list-panel undo row (`{!showHome && undoAction ? …}` at HubShell.tsx:785-792) is REMOVED in this step (the action bar supersedes it; the `undoAction` prop is now consumed by the bar, not the list panel). Delete that `<div className="flex h-11 …">…Undo {undoAction.label}…</div>` block from `listSection`. Then replace the viewer strip/body:

```tsx
          <HubTabStrip
            tabs={tabs}
            activeKey={activeTabKey}
            onActivate={onActivateTab}
            onClose={onCloseTab}
            onAddBrowser={onAddBrowserTab}
          />
          <div className="min-h-0 min-w-0 flex-1">
```

with:

```tsx
          <HubTabStrip
            tabs={tabs}
            activeKey={activeTabKey}
            onActivate={onActivateTab}
            onClose={onCloseTab}
            onAddBrowser={onAddBrowserTab}
          />
          {activeBarItem && activeTab.kind !== "home" ? (
            <HubActionBar
              item={activeBarItem}
              onDismiss={onDismiss}
              onSnooze={onSnooze}
              onLifecycleAction={onLifecycleAction}
              onMarkUnread={onMarkUnread}
              undoAction={undoAction}
            />
          ) : null}
          <div className="min-h-0 min-w-0 flex-1">
```

> The `activeTab.kind !== "home"` guard keeps the Home tab (the dashboard) chrome-free — the action bar is a per-ITEM affordance, and the Home tab has no item. Entity/decision/notification tabs get the bar.

Immediately BEFORE the `const viewer = (` line (HubShell.tsx, just after `const activeTab = …`), add the active-item resolver (uses `activeTab` + the existing `resolveHubItem` + `selectedItem` props):

```tsx
  // The action bar targets whatever hub item the ACTIVE tab represents. Tab-first:
  // a row-click opens+activates that item's tab, so there is no "selected row vs.
  // active tab" divergence. Decision/notification tabs carry a `hubItemId` in
  // their payload → resolve via resolveHubItem. Entity tabs (task/thread/approval)
  // key on the ENTITY id, so resolveHubItem would miss — fall back to the
  // last-opened hub row (`selectedItem`, which the parent tracks + caches).
  const activeBarItem: HubItemListRow | null =
    activeTab.kind === "home"
      ? null
      : resolveHubItem(hubItemIdForTab(activeTab)) ?? selectedItem;
```

And add a small pure helper near the bottom of the file (next to `laneTitle`):

```tsx
/** Extract a hub-item id from a tab whose payload carries one (runtime_decision
 *  / notification tabs key on `<kind>:<hubItemId>`); "" otherwise. */
function hubItemIdForTab(tab: HubTab): string {
  if (tab.kind === "runtime_decision" || tab.kind === "notification") {
    const payload = tab.payload as { hubItemId?: string } | undefined;
    return payload?.hubItemId ?? "";
  }
  return "";
}
```

> Rationale for the conservative resolver: only `runtime_decision` and `notification` tab payloads carry a `hubItemId` (hubViewerModel.ts:73-75, :36-38). Entity tabs (task/thread/approval/…) key on the ENTITY id, not the hub-item id, so `resolveHubItem` would miss — falling back to `selectedItem` keeps the bar acting on the last-opened hub row rather than fabricating an id. This is intentional and YAGNI: richer per-entity-tab action targeting is a deferred follow-up (noted in Task 9).

- [ ] **Step 7: Add a HubShell test that the action bar mounts above the tab body**

The action bar renders only for a NON-home active tab (the Home tab is the chrome-free dashboard). To exercise it, render HubShell with an entity/decision tab active. Add a helper tab + row to the suite and a test. Add to `ui/src/components/hub/__tests__/HubShell.test.tsx`:

```tsx
  it("mounts the slim action bar above the tab body for the active non-home tab", () => {
    // Open an approval tab for items[0] (an OPEN approval_request = mirrored):
    // Dismiss/Snooze present, Resolve/Archive hidden. The bar renders once.
    const approvalTab = {
      key: "approval:approval-1",
      kind: "approval" as const,
      title: "Review hire approval",
      closeable: true,
      payload: { approvalId: "approval-1" },
    };
    renderShell({
      selectedItemId: "hub-1",
      tabs: [HOME_TAB, approvalTab],
      activeTabKey: "approval:approval-1",
    });

    const bar = within(screen.getByTestId("hub-action-bar"));
    expect(bar.getByRole("button", { name: /^dismiss$/i })).toBeInTheDocument();
    expect(bar.getByRole("button", { name: /^snooze$/i })).toBeInTheDocument();
    // Mirrored + open → resolve/archive hidden.
    expect(bar.queryByRole("button", { name: /^resolve$/i })).toBeNull();
    // The stub is disabled + aria-labelled.
    expect(bar.getByRole("button", { name: /route or delegate \(coming soon\)/i })).toBeDisabled();
  });

  it("does NOT render the action bar on the Home tab (dashboard is chrome-free)", () => {
    renderShell({ selectedItemId: "hub-1", tabs: [HOME_TAB], activeTabKey: "home" });
    expect(screen.queryByTestId("hub-action-bar")).toBeNull();
  });
```

(`within` was already added to the testing-library import in Task 1 Step 1. `resolveHubItem` in the harness maps `hub-1` from `items`, and `selectedItem` is derived from `selectedItemId` in `renderShell` — so `activeBarItem` for the approval tab falls back to `selectedItem` = `hub-1`.)

- [ ] **Step 8: Update the HubShell mirror-model tests to render a non-home tab + scope to the bar**

The mirror-model tests at :281-342 (`"hides generic lifecycle actions for runtime decision prompts"`, `"hides Resolve/Archive for an open approval_request…"`, `"hides Resolve/Archive for an open join_request…"`, `"still offers Resolve/Archive for a non-mirrored notifications item…"`) were written against the reading-pane HubViewer footer, which is GONE. Rewrite them to open the item's tab (so `HubActionBar` renders) and scope queries to `within(screen.getByTestId("hub-action-bar"))`. For each, pass `tabs: [HOME_TAB, <entityTab for the item>]` + `activeTabKey: <that tab key>` (mirroring the Step-7 approvalTab shape — key `<kind>:<entityId>`, payload matching the tab factory) and `selectedItemId: <hub id>` so `activeBarItem` resolves. Example rewrite of `"still offers Resolve/Archive for a non-mirrored notifications item (run_failed)"`:

```tsx
    const runTab = {
      key: "run:run-1",
      kind: "notification" as const,
      title: "Run failed",
      closeable: true,
      payload: { hubItemId: "hub-run" },
    };
    renderShell({
      items: [runItem],
      selectedItemId: "hub-run",
      tabs: [HOME_TAB, runTab],
      activeTabKey: "run:run-1",
    });
    const bar = within(screen.getByTestId("hub-action-bar"));
    expect(bar.getByRole("button", { name: /^resolve$/i })).toBeInTheDocument();
    expect(bar.getByRole("button", { name: /^archive$/i })).toBeInTheDocument();
```

For the runtime-decision test (`"hides generic lifecycle actions for runtime decision prompts"`), open a `runtime_decision` tab (`key: "runtime_decision:hub-runtime"`, `payload: { hubItemId: "hub-runtime" }`) and assert the bar hides Resolve/Archive/Claim; the `allow once` button is asserted from the tab BODY (`within(screen.getByTestId("hub-runtime-decision-body"))`, or unscoped `findByRole`), NOT the bar. Apply the same `within(bar)` scoping to the approval_request + join_request mirror-hiding tests. (The `notification` tab kind carries `hubItemId`, so `activeBarItem` resolves via `resolveHubItem`; the harness `resolveHubItem` looks items up by id — pass the item in `items` so it resolves.)

- [ ] **Step 9: Update the InboxHub lifecycle + undo tests to drive the action bar in a tab**

These InboxHub tests currently click Dismiss/Snooze/Resolve/Mark-unread in the reading-pane HubViewer footer and Undo in the list-level undo row — BOTH surfaces are gone (footer retired in Task 2; list-level undo row removed in Step 6). Under tab-first the deep-link they use (`/inbox/<lane>/hub-1`) now OPENS A TAB (Task 1 Step 6), so the `HubActionBar` renders inside that tab and hosts all of Dismiss/Snooze/Resolve/Mark-unread + the undo banner. The button LABELS are unchanged, so most assertions carry over — but verify each deep-linked item resolves an `activeBarItem` (the tab kind carries `hubItemId`, or `resolveHubItem` falls back to the cached row). Affected tests (InboxHub.test.tsx):

- `"viewer can dismiss and snooze the selected item"` (:781): Dismiss/Snooze now in the bar — still found by `findByRole` (single match; no footer duplicate).
- `"viewer can undo personal dismiss and snooze actions"` (:799): after Dismiss, `handleDismiss` sets `undoAction` (InboxHub.tsx:748-751) → the bar's undo banner renders "Undo dismiss"; likewise "Undo snooze". Confirm the banner is the ONLY undo affordance (list-level row removed).
- `"viewer resolves an item and can undo the server-backed action"` (:815) + `"keeps server undo reachable after the resolved item leaves the active list"` (:840): use a NON-mirrored `run_failed` item so the bar shows Resolve; after Resolve, `undoAction` is set → the bar shows "Undo resolve". These stay valid; the resolve+undo buttons now live in the bar.
- `"viewer can mark a selected read item unread"` (if present in :767-876): Mark-unread moved to the bar (renders when `item.readAt`); label unchanged.

Concretely: these tests need NO new interaction (the deep-link already opens the tab), only a re-verification that a single Dismiss/Snooze/Resolve/Undo button is on screen (the bar), not two. If the deep-linked `hubItem()` default opens a tab whose `activeBarItem` does not resolve, pass a matching `resolveHubItem`-visible row (already in the mocked list) or a `hubItemId`-bearing tab kind.

Run: `cd ui && npx vitest run src/components/hub/__tests__/HubShell.test.tsx src/__tests__/InboxHub.test.tsx`
Expected: PASS (no double-render of Dismiss/Resolve; a single undo home).

- [ ] **Step 10: Run the full hub UI suite + InboxHub**

Run: `cd ui && npx vitest run src/components/hub src/__tests__/InboxHub.test.tsx`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add ui/src/components/hub/HubShell.tsx ui/src/components/hub/HubActionBar.tsx ui/src/components/hub/__tests__/HubActionBar.test.tsx ui/src/components/hub/__tests__/HubShell.test.tsx
git commit -m "feat(hub): mount slim contextual action bar (targets the active tab's item) with undo banner + a11y stubs"
```

---

## Task 3b: Tab-cap (12) feedback + eviction guard (Amendment 2.1)

With new-tab-per-item, `useHubTabs` silently evicts the OLDEST closeable tab once the open set exceeds `HUB_TABS_MAX = 12` (useHubTabs.ts:6, `normalize` at :29-40 — `[HOME_TAB, ...capped]`, capping closeables to `HUB_TABS_MAX - 1 = 11`). Today that eviction has NO UI cue. Make the 12-cap a DELIBERATE, VISIBLE UX choice: the strip's tablist is already horizontally scrollable (`overflow-x-auto` at HubTabStrip.tsx:106, so all open tabs stay reachable), and we add a subtle "12 max" indicator when at capacity. Add an eviction guard test so the silent-drop behavior is pinned.

**Files:**
- Modify: `ui/src/components/hub/HubTabStrip.tsx` (import `HUB_TABS_MAX`; render a "12 max" indicator when `tabs.length >= HUB_TABS_MAX`)
- Modify: `ui/src/components/hub/__tests__/useHubTabs.test.ts` (or create it) — open 13 items → length stays ≤ 12 + OLDEST closeable evicted; AND a same-key dedup test (Amendment 2.6 — re-opening a tab doesn't grow the count + re-activates it)
- Test: `ui/src/components/hub/__tests__/HubTabStrip.test.tsx` (assert the "12 max" indicator appears only at capacity)

- [ ] **Step 1: Write the failing eviction test**

Confirm the useHubTabs test file. If `ui/src/components/hub/__tests__/useHubTabs.test.ts` does not exist, create it; otherwise append. Add:

```ts
import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHubTabs, HUB_TABS_MAX } from "../useHubTabs";
import { browserTab } from "../hubViewerModel";

describe("useHubTabs", () => {
  it("evicts the OLDEST closeable tab when opening past HUB_TABS_MAX (length stays ≤ 12)", () => {
    const { result } = renderHook(() => useHubTabs("company-cap"));

    // Open 13 distinct browser tabs (Home + 13 would be 14 > 12).
    for (let i = 0; i < 13; i += 1) {
      act(() => result.current.openTab(browserTab(`https://x/${i}`, `T${i}`)));
    }

    expect(result.current.tabs.length).toBe(HUB_TABS_MAX); // 12: Home + 11 newest
    // Home is always first + kept.
    expect(result.current.tabs[0].key).toBe("home");
    // The OLDEST closeable (T0, T1) were evicted; the newest (T12) is present.
    const keys = result.current.tabs.map((t) => t.key);
    expect(keys).not.toContain(browserTab("https://x/0", "T0").key);
    expect(keys).toContain(browserTab("https://x/12", "T12").key);
  });

  it("does NOT add a duplicate tab when the same tab is opened twice (Amendment 2.6)", () => {
    const { result } = renderHook(() => useHubTabs("company-dedup"));
    const tab = browserTab("https://x/dup", "Dup");

    act(() => result.current.openTab(tab));
    const lenAfterFirst = result.current.tabs.length; // Home + 1 = 2
    act(() => result.current.openTab(tab)); // same key

    // ensureTab dedups by key — the count is unchanged; the tab is re-activated.
    expect(result.current.tabs.length).toBe(lenAfterFirst);
    expect(result.current.activeKey).toBe(tab.key);
  });
});
```

(Use a fresh `companyId` per test so localStorage rehydration doesn't bleed prior tabs. `browserTab` is a real factory in `hubViewerModel.ts`.)

- [ ] **Step 2: Run to verify it passes (behavior already correct — this pins it)**

Run: `cd ui && npx vitest run src/components/hub/__tests__/useHubTabs.test.ts`
Expected: PASS — the cap logic already exists (`normalize` in useHubTabs.ts). This test documents the 12-cap as intentional and guards against a future regression that raises/removes the cap silently. (If it FAILS, the cap wiring regressed — fix `openTab`'s `next.length > HUB_TABS_MAX ? normalize(next) : next` at useHubTabs.ts:80-82.)

- [ ] **Step 3: Write the failing strip-indicator test**

Add to (or create) `ui/src/components/hub/__tests__/HubTabStrip.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { HubTabStrip } from "../HubTabStrip";
import { HOME_TAB, browserTab } from "../hubViewerModel";
import { HUB_TABS_MAX } from "../useHubTabs";

function tabsAtCapacity() {
  const closeables = Array.from({ length: HUB_TABS_MAX - 1 }, (_, i) =>
    browserTab(`https://x/${i}`, `T${i}`),
  );
  return [HOME_TAB, ...closeables];
}

describe("HubTabStrip capacity indicator", () => {
  it("shows a '12 max' indicator only when at capacity", () => {
    const props = {
      activeKey: "home",
      onActivate: vi.fn(),
      onClose: vi.fn(),
      onAddBrowser: vi.fn(),
    };
    const { rerender } = render(<HubTabStrip tabs={[HOME_TAB]} {...props} />);
    expect(screen.queryByText(/12 max/i)).toBeNull();

    rerender(<HubTabStrip tabs={tabsAtCapacity()} {...props} />);
    expect(screen.getByText(/12 max/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd ui && npx vitest run src/components/hub/__tests__/HubTabStrip.test.tsx`
Expected: FAIL — no "12 max" indicator rendered.

- [ ] **Step 5: Add the capacity indicator to HubTabStrip**

In `ui/src/components/hub/HubTabStrip.tsx`, import the cap (add after the `./hubViewerModel` import at :23):

```tsx
import { HUB_TABS_MAX } from "./useHubTabs";
```

Then in the expanded strip's outer flex row (the `<div className="flex h-[42px] … px-2">` at :99-102), render the indicator to the RIGHT of the scrollable tablist. Immediately AFTER the tablist `</div>` (the div opened at :103 that closes at :175, right after the `+ browser` button) and BEFORE the strip's closing `</div>` (:176), add:

```tsx
        {tabs.length >= HUB_TABS_MAX ? (
          <span
            className="ml-2 shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground"
            title={`Tab limit reached — the oldest tab is closed when you open a new one (max ${HUB_TABS_MAX}).`}
            data-testid="hub-tab-cap"
          >
            {HUB_TABS_MAX} max
          </span>
        ) : null}
```

> The `+ browser` button stays inside the scrollable tablist; the indicator sits outside it (always visible, never scrolled off). The strip's `overflow-x-auto` (:106) already keeps all 12 tabs reachable — the indicator explains the eviction so it is never a silent surprise (Amendment 2.1). Document the 12-cap as a deliberate UX ceiling: a founding team rarely needs > 12 open item tabs, and an unbounded strip degrades the whole viewer.

- [ ] **Step 6: Run to verify it passes**

Run: `cd ui && npx vitest run src/components/hub/__tests__/HubTabStrip.test.tsx src/components/hub/__tests__/useHubTabs.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/hub/HubTabStrip.tsx ui/src/components/hub/__tests__/HubTabStrip.test.tsx ui/src/components/hub/__tests__/useHubTabs.test.ts
git commit -m "feat(hub): visible 12-tab cap indicator + eviction guard test (deliberate UX ceiling)"
```

---

## Task 4: Readable decision viewer (roomy question + option cards + context + free-text)

Redesign `RuntimeDecisionPanel` (`ui/src/components/hub/RuntimeDecisionPanel.tsx`) so a LONG question + LONG options are readable: the question in a roomy full-width block (generous line-height, no truncation), each option rendered as a full-width CARD (bold label + `description` + a "why/tradeoff" `rationale` line + a radio affordance) instead of a cramped button, a "write your own answer" free-text fallback ALWAYS available for `work_question` (even when options exist), and a top "context" callout (the decision `summary` — what/why the agent is asking). Permission decisions keep their Allow/Deny controls. Option fields `description`/`rationale` are OPTIONAL (Task 7 adds them to the schema; the panel must render fine when absent — backward-compatible with `{label,value}`-only).

**Files:**
- Modify: `ui/src/components/hub/RuntimeDecisionPanel.tsx` (the `work_question` render branch at :106-133; add the context callout after the prompt; keep the permission branch :94-105)
- Test: `ui/src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx` (extend; the existing option-buttons test at :129-152 asserts plain buttons — rewrite it for cards + a still-present free-text box)

- [ ] **Step 1: Write the failing tests**

Add to / rewrite in `ui/src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx`. First, extend the `RuntimeDecisionDetail` type in the test's `permissionDetail` factory usage to allow the new option fields — the factory already spreads `overrides`, so options with `description`/`rationale` just pass through. Replace the existing `"renders option buttons and posts {answer:{value}} for a work_question with options"` test (:129-152) with:

```tsx
  it("renders option CARDS with description + rationale and posts {answer:{value}} on select", async () => {
    const { fireEvent } = await import("@testing-library/react");
    detailSpy.mockResolvedValueOnce(
      permissionDetail({
        kind: "work_question",
        summary: "Deciding the launch segment before we build onboarding.",
        promptText:
          "Which customer segment should we prioritize for the v1 launch, given limited eng bandwidth?",
        options: [
          {
            label: "Founder-led SaaS",
            value: "saas",
            description: "Teams of 3-10 running AI + humans from one control room.",
            rationale: "Highest willingness-to-pay; matches our current wedge.",
          },
          { label: "Agencies", value: "agencies" },
        ] as any,
      }),
    );
    answerSpy.mockResolvedValueOnce(permissionDetail({ kind: "work_question" }));
    renderPanel(runtimeDecisionItem());

    // The context callout surfaces the decision summary.
    expect(
      await screen.findByText(/deciding the launch segment/i),
    ).toBeInTheDocument();
    // The long question renders in full (no truncation assertion — just present).
    expect(screen.getByText(/which customer segment should we prioritize/i)).toBeInTheDocument();

    // Option ONE renders as a card with label + description + rationale.
    expect(screen.getByText("Founder-led SaaS")).toBeInTheDocument();
    expect(screen.getByText(/teams of 3-10 running ai/i)).toBeInTheDocument();
    expect(screen.getByText(/highest willingness-to-pay/i)).toBeInTheDocument();

    // Option TWO (label/value only) still renders as a card (no desc/rationale).
    expect(screen.getByText("Agencies")).toBeInTheDocument();

    // A "write your own answer" free-text box is present EVEN WITH options.
    expect(screen.getByLabelText(/work question answer/i)).toBeInTheDocument();

    // Selecting a card posts {answer:{value}}.
    fireEvent.click(screen.getByRole("radio", { name: /founder-led saas/i }));
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));
    await waitFor(() => expect(answerSpy).toHaveBeenCalledTimes(1));
    expect(answerSpy.mock.calls[0][2]).toMatchObject({
      kind: "work_question",
      answer: { value: "saas" },
    });
  });

  it("posts free-text over an empty selection when the user writes their own answer", async () => {
    const { fireEvent } = await import("@testing-library/react");
    detailSpy.mockResolvedValueOnce(
      permissionDetail({
        kind: "work_question",
        options: [{ label: "A", value: "a" }] as any,
      }),
    );
    answerSpy.mockResolvedValueOnce(permissionDetail({ kind: "work_question" }));
    renderPanel(runtimeDecisionItem());

    const box = await screen.findByLabelText(/work question answer/i);
    fireEvent.change(box, { target: { value: "Neither — go SMB." } });
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));
    await waitFor(() => expect(answerSpy).toHaveBeenCalledTimes(1));
    // Free text wins when typed, even though an option exists.
    expect(answerSpy.mock.calls[0][2]).toMatchObject({
      kind: "work_question",
      answer: { text: "Neither — go SMB." },
    });
  });
```

Keep the existing `"still renders the free-text box when a work_question has no options"` test (:154-158) — it stays valid.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npx vitest run src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx -t "option CARDS"`
Expected: FAIL — no `radio` role, no context callout, no free-text box alongside options (the current code renders plain buttons and hides the textarea when options exist).

- [ ] **Step 3: Write the implementation**

In `ui/src/components/hub/RuntimeDecisionPanel.tsx`, add a `selectedValue` state alongside `answerText` (after :11):

```tsx
  const [answerText, setAnswerText] = useState("");
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
```

Replace the `submitQuestionOption` helper (:71-78) so submit is unified — the send button posts free-text if typed, else the selected option value:

```tsx
  const submitQuestionAnswer = () => {
    const text = answerText.trim();
    if (text) {
      answerMutation.mutate({
        kind: "work_question",
        answer: { text },
        expectedSourceRevision: detail.sourceRevision,
        nonce: detail.nonce,
      });
      return;
    }
    if (selectedValue) {
      answerMutation.mutate({
        kind: "work_question",
        answer: { value: selectedValue },
        expectedSourceRevision: detail.sourceRevision,
        nonce: detail.nonce,
      });
    }
  };
```

Add the context callout: right after the `{detail.promptText ? …}` block (:90-92), and make the prompt roomier. Replace lines 90-92:

```tsx
      {detail.promptText ? (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-text">{detail.promptText}</p>
      ) : null}
```

with:

```tsx
      {detail.summary ? (
        <div className="mt-3 rounded-md border border-border bg-card/50 px-3 py-2 text-sm leading-6 text-muted-foreground">
          <span className="mr-1 font-medium text-text">Context:</span>
          {detail.summary}
        </div>
      ) : null}
      {detail.promptText ? (
        <p className="mt-4 whitespace-pre-wrap text-base leading-7 text-text">{detail.promptText}</p>
      ) : null}
```

Replace the entire `work_question` render branch — the `) : detail.options && detail.options.length > 0 ? (` block through the free-text `) : (` block (:106-133) — with a single branch that renders option cards (when present) AND the free-text box (always), plus a unified send button. Replace:

```tsx
      ) : detail.options && detail.options.length > 0 ? (
        <div className="mt-4 grid gap-2">
          {detail.options.map((opt) => (
            <Button
              key={opt.value}
              type="button"
              size="sm"
              disabled={disabled}
              onClick={() => submitQuestionOption(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="mt-4 grid gap-2">
          <textarea
            aria-label="Work question answer"
            value={answerText}
            disabled={disabled}
            onChange={(event) => setAnswerText(event.target.value)}
            className="min-h-24 resize-y rounded border border-border bg-bg p-2 text-sm"
          />
          <Button type="button" size="sm" disabled={disabled || !answerText.trim()} onClick={submitQuestion}>
            Send answer
          </Button>
        </div>
      )}
```

with:

```tsx
      ) : (
        <div className="mt-4 grid gap-3">
          {detail.options && detail.options.length > 0 ? (
            <fieldset className="grid gap-2" disabled={disabled}>
              <legend className="sr-only">Answer options</legend>
              {detail.options.map((opt) => {
                const withDetail = opt as {
                  label: string;
                  value: string;
                  description?: string;
                  rationale?: string;
                };
                const active = selectedValue === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={
                      "flex w-full cursor-pointer gap-3 rounded-md border p-3 text-left transition-colors " +
                      (active ? "border-brand bg-brand/[0.06]" : "border-border hover:bg-card")
                    }
                  >
                    <input
                      type="radio"
                      name="work-question-option"
                      className="mt-1 size-4 accent-brand"
                      checked={active}
                      disabled={disabled}
                      onChange={() => {
                        setSelectedValue(opt.value);
                        setAnswerText("");
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-text">{withDetail.label}</span>
                      {withDetail.description ? (
                        <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                          {withDetail.description}
                        </span>
                      ) : null}
                      {withDetail.rationale ? (
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                          <span className="font-medium">Why: </span>
                          {withDetail.rationale}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ) : null}
          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="work-question-answer">
              {detail.options && detail.options.length > 0 ? "Or write your own answer" : "Your answer"}
            </label>
            <textarea
              id="work-question-answer"
              aria-label="Work question answer"
              value={answerText}
              disabled={disabled}
              onChange={(event) => {
                setAnswerText(event.target.value);
                if (event.target.value.trim()) setSelectedValue(null);
              }}
              className="min-h-24 resize-y rounded border border-border bg-bg p-2 text-sm"
            />
          </div>
          <Button
            type="button"
            size="sm"
            disabled={disabled || (!answerText.trim() && !selectedValue)}
            onClick={submitQuestionAnswer}
          >
            Send answer
          </Button>
        </div>
      )}
```

Delete the now-unused `submitQuestion` helper (:62-70) — its logic is folded into `submitQuestionAnswer`. (Grep the file for `submitQuestion(` to confirm no other caller; there is none.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npx vitest run src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Check the InboxHub work-question test still passes**

The InboxHub test `"submits runtime work-question answers from the hub viewer"` (:441-481) types into the answer box and clicks Send — with the new unified submit, typed text still posts `{ answer: { text } }`. Run:

Run: `cd ui && npx vitest run src/__tests__/InboxHub.test.tsx -t "work-question"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/hub/RuntimeDecisionPanel.tsx ui/src/components/hub/__tests__/RuntimeDecisionPanel.test.tsx
git commit -m "feat(hub): readable decision viewer — context callout + option cards + always-on free-text"
```

---

## Task 7: Extend the `ask_founder` option schema with optional `description` + `rationale`

Carry `description?` + `rationale?` on option objects end-to-end (backward compatible). **No migration:** the DB column `agent_runtime_decisions.options` is `jsonb("options").$type<Array<Record<string, unknown>>>()` (packages/db/src/schema/agent_runtime_decisions.ts:43) — arbitrary JSON, so any extra keys already persist. **The zod is the gate, and it must add EXPLICIT optional fields — NOT rely on `.passthrough()`.** Why: the `ask_founder` INPUT schema's option object (`askFounderSchema`, ask-founder-tool.ts:24-29) is inside a `.strict()` root object and the option object itself has NO `.passthrough()`, so an unknown `description`/`rationale` key is **stripped/rejected** — the fields never reach `createPrompt`. So we add them as declared `z.string().min(1).optional()` fields in three places: (a) the `ask_founder` zod schema option object (widen it — this is the load-bearing fix), (b) the ask_founder JSON `inputSchema` in `TOOL_DEFINITIONS`, (c) the shared `runtimeDecisionDetailSchema.options` element — add the two optional fields EXPLICITLY (so `RuntimeDecisionDetail.options[n].description` is a TYPED field the panel consumed in Task 4; the existing `.passthrough()` there is kept but is not what carries the typed fields). The rationale/description CONTENT source (asking agent / Commander) is DEFERRED — this task only carries the fields.

**Files:**
- Modify: `packages/shared/src/validators/hub.ts:164-173` (add optional `description`/`rationale` to the options element)
- Modify: `server/src/mcp/tools/ask-founder-tool.ts:24-29` (widen the option object schema)
- Modify: `server/src/mcp/tools/index.ts:557-567` (add the two fields to the JSON inputSchema)
- Test: `packages/shared/src/__tests__/hub-validators.test.ts` (create/extend — a shared-validator contract test) AND `server/src/__tests__/ask-founder-tool.test.ts` (assert options with description/rationale pass through)

- [ ] **Step 1: Write the failing shared-validator test**

Find the shared validators test location. If `packages/shared/src/__tests__/hub-validators.test.ts` does not exist, create it; otherwise append. First confirm the run command for shared tests:

Run: `cd packages/shared && npx vitest run 2>&1 | head -5` (to confirm vitest is wired; if not, the repo runs shared tests via the root `pnpm test:run packages/shared/...`).

Create/append `packages/shared/src/__tests__/hub-validators.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runtimeDecisionDetailSchema } from "../validators/hub.js";

function baseDetail() {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    hubItemId: null,
    companyId: "00000000-0000-0000-0000-0000000000c1",
    agentId: "00000000-0000-0000-0000-0000000000b1",
    runId: "00000000-0000-0000-0000-0000000000d1",
    adapterType: "claude_local",
    adapterSessionId: null,
    kind: "work_question" as const,
    status: "shown" as const,
    sourceRevision: 0,
    nonce: "nonce-1",
    title: "Pick a segment",
    summary: null,
    promptText: "Which segment?",
    toolName: null,
    command: null,
    cwd: null,
    path: null,
    networkTarget: null,
    riskClass: null,
    timeoutPolicy: "park_run" as const,
    expiresAt: null,
    answeredAt: null,
    relayedAt: null,
    relayError: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("runtimeDecisionDetailSchema.options", () => {
  it("accepts options carrying optional description + rationale (typed)", () => {
    const parsed = runtimeDecisionDetailSchema.parse({
      ...baseDetail(),
      options: [
        {
          label: "SaaS",
          value: "saas",
          description: "Founder-led teams.",
          rationale: "Highest WTP.",
        },
      ],
    });
    expect(parsed.options?.[0].description).toBe("Founder-led teams.");
    expect(parsed.options?.[0].rationale).toBe("Highest WTP.");
  });

  it("still accepts label/value-only options (backward compatible)", () => {
    const parsed = runtimeDecisionDetailSchema.parse({
      ...baseDetail(),
      options: [{ label: "Agencies", value: "agencies" }],
    });
    expect(parsed.options?.[0].label).toBe("Agencies");
    expect(parsed.options?.[0].description).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run packages/shared/src/__tests__/hub-validators.test.ts`
Expected: FAIL — `parsed.options?.[0].description` is typed `unknown`/absent because the current element schema is `{ label, value }.passthrough()` (extra keys survive at runtime but are NOT typed, so the `.description` access is `any`/undefined at the type layer; the runtime assertion may pass but the `.rationale` typed access fails compile in strict TS, and the intent is an EXPLICIT typed field).

- [ ] **Step 3: Widen the shared options element schema**

In `packages/shared/src/validators/hub.ts`, change the `options` element (lines 164-173). Replace:

```ts
    options: z
      .array(
        z
          .object({
            label: z.string().min(1),
            value: z.string().min(1),
          })
          .passthrough(),
      )
      .nullable(),
```

with:

```ts
    options: z
      .array(
        z
          .object({
            label: z.string().min(1),
            value: z.string().min(1),
            // Optional card detail (D-tabbed). Carried through the JSON options
            // column; the RuntimeDecisionPanel renders them when present. The
            // CONTENT source (asking agent / Commander) is a deferred follow-up.
            description: z.string().min(1).optional(),
            rationale: z.string().min(1).optional(),
          })
          .passthrough(),
      )
      .nullable(),
```

- [ ] **Step 4: Run the shared test to verify it passes**

Run: `pnpm test:run packages/shared/src/__tests__/hub-validators.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing ask_founder tool test for pass-through**

Add to `server/src/__tests__/ask-founder-tool.test.ts` (mock service already stubs `createPrompt`; assert the options with detail fields reach `createPrompt`). Add `markRelayed` to the hoisted mock now to avoid a second edit in Task 8 — but Task 8 owns the relay assertions; here just make it resolve. Update the `vi.hoisted` block (:6-20) and mock (:22-25):

```ts
const { createPrompt, waitForAnswer, markRelayed, FakeCancelledError } = vi.hoisted(() => {
  class FakeCancelledError extends Error {
    readonly decision: unknown;
    constructor() {
      super("cancelled");
      this.name = "RuntimeDecisionCancelledError";
      this.decision = {};
    }
  }
  return {
    createPrompt: vi.fn(),
    waitForAnswer: vi.fn(),
    markRelayed: vi.fn(),
    FakeCancelledError,
  };
});

vi.mock("../services/agent-runtime-decisions.js", () => ({
  agentRuntimeDecisionService: () => ({ createPrompt, waitForAnswer, markRelayed }),
  RuntimeDecisionCancelledError: FakeCancelledError,
}));
```

Add `markRelayed.mockReset()` to `beforeEach` (:42-45). Then add the test:

```ts
  it("passes option description + rationale through to createPrompt", async () => {
    const getById = vi.fn().mockResolvedValue({ adapterType: "codex_local" });
    createPrompt.mockResolvedValue({ decision: { id: "d1" } });
    waitForAnswer.mockResolvedValue({ answerPayload: { value: "saas" } });
    markRelayed.mockResolvedValue({ id: "d1", status: "relayed" });

    await handleAskFounder(
      makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }, getById),
      {
        question: "Which segment?",
        options: [
          { label: "SaaS", value: "saas", description: "Founder-led.", rationale: "High WTP." },
          { label: "Agencies", value: "agencies" },
        ],
      },
    );

    expect(createPrompt.mock.calls[0][0].options).toEqual([
      { label: "SaaS", value: "saas", description: "Founder-led.", rationale: "High WTP." },
      { label: "Agencies", value: "agencies" },
    ]);
  });
```

Also add `markRelayed.mockResolvedValue({ id: "d1", status: "relayed" })` to the two existing SUCCESS-path tests so they don't throw when Task 8 makes the tool call markRelayed: the `"creates a work_question prompt…"` test (:66-95) and the `"coerces empty/whitespace context…"` test (:97-110). (The park/timeout/cancel tests do not reach markRelayed, so they need no stub.)

- [ ] **Step 6: Run the tool test to verify it fails**

Run: `pnpm test:run server/src/__tests__/ask-founder-tool.test.ts -t "passes option description"`
Expected: FAIL — the ask_founder zod schema's option object is `.strict()` (ask-founder-tool.ts:25), so `description`/`rationale` are rejected → `handleAskFounder` throws on `askFounderSchema.parse`, the test never reaches `createPrompt`.

- [ ] **Step 7: Widen the ask_founder zod schema**

In `server/src/mcp/tools/ask-founder-tool.ts`, change the option object schema (lines 24-29). Replace:

```ts
    options: z
      .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
      .refine((opts) => new Set(opts.map((o) => o.value)).size === opts.length, {
        message: "option values must be unique",
      })
      .optional(),
```

with:

```ts
    options: z
      .array(
        z.object({
          label: z.string().min(1),
          value: z.string().min(1),
          // Optional card detail rendered by the RuntimeDecisionPanel (D-tabbed).
          description: z.string().min(1).optional(),
          rationale: z.string().min(1).optional(),
        }),
      )
      .refine((opts) => new Set(opts.map((o) => o.value)).size === opts.length, {
        message: "option values must be unique",
      })
      .optional(),
```

- [ ] **Step 8: Update the JSON inputSchema in TOOL_DEFINITIONS**

In `server/src/mcp/tools/index.ts`, add the two fields to the ask_founder option items (lines 557-567). Replace:

```ts
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
            },
            required: ["label", "value"],
          },
        },
```

with:

```ts
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
              description: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["label", "value"],
          },
        },
```

- [ ] **Step 9: Run the tool test to verify it passes**

Run: `pnpm test:run server/src/__tests__/ask-founder-tool.test.ts`
Expected: PASS (existing tests still green; new pass-through test green).

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/validators/hub.ts packages/shared/src/__tests__/hub-validators.test.ts server/src/mcp/tools/ask-founder-tool.ts server/src/mcp/tools/index.ts server/src/__tests__/ask-founder-tool.test.ts
git commit -m "feat(hub): carry optional option description + rationale through ask_founder schema (no migration)"
```

---

## Task 5: Build the 8 placeholder viewers

Replace the `TabLoadingPlaceholder` fallthrough (HubTabBody.tsx:207-215) for the reachable placeholder kinds with real, designed bodies. Each: title + a compact meta chip row (priority · actor · time) + a purpose-built body. The slim action bar is already mounted ABOVE the tab body by Task 3 (in HubShell), so these bodies focus on CONTENT only. The kinds to build: `join_request`, `suggestion`, `reminder`, `marketplace_op`, `routine`, generic `notification` (already has a minimal body — upgrade it), and payload-less `artifact`/`memory` (give a graceful "not linkable yet" body, not a spinner). `run_complete` routes through the existing `RunDetailContainer` (already wired for the `run` tabKind — no new work). Each viewer resolves its hub row via a small `resolveHubItem` lookup where the payload carries a hubItemId, else renders from the tab title/payload id.

To keep `HubTabBody` focused (DRY/YAGNI), each new body is its own component under `ui/src/components/hub/viewers/`. They share one `HubViewerScaffold` (title + meta chip row + slotted body). `routine` needs a tab factory + registry tabKind wired (currently `hubTabForItem` returns a notification tab for `routine` — hubRegistry.tsx:350-352 — and there is no `routineTab` factory).

**Files (component files are DISJOINT — parallelizable; HubTabBody wiring is COUPLED — sequential):**
- Create: `ui/src/components/hub/viewers/HubViewerScaffold.tsx`
- Create: `ui/src/components/hub/viewers/JoinRequestBody.tsx`
- Create: `ui/src/components/hub/viewers/SuggestionBody.tsx`
- Create: `ui/src/components/hub/viewers/ReminderBody.tsx`
- Create: `ui/src/components/hub/viewers/MarketplaceOpBody.tsx`
- Create: `ui/src/components/hub/viewers/RoutineBody.tsx`
- Create: `ui/src/components/hub/viewers/GenericNotificationBody.tsx`
- Create: `ui/src/components/hub/viewers/UnlinkableEntityBody.tsx` (artifact/memory)
- Modify: `ui/src/components/hub/hubViewerModel.ts` (add `routineTab` factory + `HubRoutinePayload`)
- Modify: `ui/src/components/hub/hubRegistry.tsx` (route `routine` tabKind → `routineTab`)
- Modify: `ui/src/components/hub/HubTabBody.tsx` (replace the placeholder cases with the new bodies)
- Create: `ui/src/components/hub/viewers/__tests__/HubViewers.test.tsx`
- Modify: `ui/src/components/hub/__tests__/HubTabBody.test.tsx` (the placeholder assertions for these kinds become real-body assertions)

- [ ] **Step 1: Write the failing scaffold + viewer tests**

Create `ui/src/components/hub/viewers/__tests__/HubViewers.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HubItemListRow } from "@/api/hub-items";
import { HubViewerScaffold } from "../HubViewerScaffold";
import { JoinRequestBody } from "../JoinRequestBody";
import { SuggestionBody } from "../SuggestionBody";
import { ReminderBody } from "../ReminderBody";
import { MarketplaceOpBody } from "../MarketplaceOpBody";
import { RoutineBody } from "../RoutineBody";
import { GenericNotificationBody } from "../GenericNotificationBody";
import { UnlinkableEntityBody } from "../UnlinkableEntityBody";

function row(overrides: Partial<HubItemListRow> = {}): HubItemListRow {
  return {
    id: "hub-1",
    companyId: "company-1",
    semanticType: "join_request",
    lane: "waiting_on_you",
    status: "open",
    priority: "high",
    title: "Scout wants to join Engineering",
    summary: "Requested by scout@example.com",
    sourceType: "join_request",
    sourceId: "jr-1",
    relatedEntityId: null,
    relatedEntityType: null,
    ownerUserId: null,
    ownerPool: "board",
    claimedByUserId: null,
    claimedAt: null,
    version: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    groupKey: null,
    groupLabel: null,
    groupCount: null,
    scopeKey: null,
    slaAt: null,
    ...overrides,
  };
}

describe("HubViewerScaffold", () => {
  it("renders the title + a meta chip row (priority · source · time)", () => {
    render(
      <HubViewerScaffold item={row()}>
        <div>body</div>
      </HubViewerScaffold>,
    );
    expect(screen.getByRole("heading", { name: /scout wants to join/i })).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });
});

describe("placeholder viewers", () => {
  it("JoinRequestBody shows the requester + Approve/Decline", () => {
    render(<JoinRequestBody item={row()} />);
    expect(screen.getByText(/requested by scout/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /decline/i })).toBeInTheDocument();
  });

  it("SuggestionBody shows the rationale summary + Apply/Open", () => {
    render(
      <SuggestionBody
        item={row({ semanticType: "suggestion", title: "Add a QA task", summary: "Coverage gap detected." })}
      />,
    );
    expect(screen.getByText(/coverage gap detected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /apply/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open/i })).toBeInTheDocument();
  });

  it("ReminderBody shows the reminder text + Open in Commander", () => {
    render(
      <ReminderBody
        item={row({ semanticType: "reminder", title: "Follow up with the design lead" })}
      />,
    );
    expect(screen.getByText(/follow up with the design lead/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open in commander/i })).toBeInTheDocument();
  });

  it("MarketplaceOpBody shows the op status + View", () => {
    render(
      <MarketplaceOpBody
        item={row({ semanticType: "marketplace_op", title: "Install completed: gstack", summary: "Operation finished." })}
      />,
    );
    expect(screen.getByText(/operation finished/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view/i })).toBeInTheDocument();
  });

  it("RoutineBody shows the failure summary + Open routine", () => {
    render(
      <RoutineBody
        item={row({ semanticType: "routine_outcome", title: "Nightly sync failed", summary: "exit code 1" })}
      />,
    );
    expect(screen.getByText(/exit code 1/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open routine/i })).toBeInTheDocument();
  });

  it("GenericNotificationBody shows the text + a single primary action", () => {
    render(
      <GenericNotificationBody
        item={row({ semanticType: "legacy_other", title: "Something happened", summary: "Details here." })}
      />,
    );
    expect(screen.getByText(/details here/i)).toBeInTheDocument();
  });

  it("UnlinkableEntityBody explains the entity is not linkable yet (no spinner)", () => {
    render(<UnlinkableEntityBody item={row({ semanticType: "legacy_other", title: "Artifact" })} kind="artifact" />);
    expect(screen.getByText(/not.*link/i)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/components/hub/viewers/__tests__/HubViewers.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `HubViewerScaffold`**

Create `ui/src/components/hub/viewers/HubViewerScaffold.tsx`:

```tsx
import type { ReactNode } from "react";
import type { HubItemListRow } from "@/api/hub-items";
import { HUB_REGISTRY } from "../hubRegistry";

/**
 * Shared chrome for a hub tab body: the item title + a compact meta chip row
 * (priority · source · relative time), then the slotted purpose-built body. The
 * type-label header was dropped (the tab strip owns it); the action bar is
 * mounted ABOVE this by HubShell. This is CONTENT-only.
 */
export function HubViewerScaffold({
  item,
  children,
}: {
  item: HubItemListRow;
  children: ReactNode;
}) {
  const label = HUB_REGISTRY[item.semanticType]?.label ?? "Item";
  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-y-auto p-5" data-testid="hub-viewer-scaffold">
      <h2 className="text-lg font-semibold leading-snug text-text">{item.title}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <Chip>{item.priority}</Chip>
        <Chip>{item.sourceType ?? label}</Chip>
        <Chip>{formatWhen(item.createdAt)}</Chip>
      </div>
      <div className="mt-4 min-h-0 flex-1">{children}</div>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded border border-border px-1.5 py-0.5">{children}</span>
  );
}

function formatWhen(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
```

- [ ] **Step 4: Write the seven body components**

Create `ui/src/components/hub/viewers/JoinRequestBody.tsx`:

```tsx
import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";
import { HubViewerScaffold } from "./HubViewerScaffold";

/**
 * Join-request body. The row is a MIRROR of the join_request source (approve /
 * decline resolves it), so Approve/Decline deep-link to the Team join-requests
 * surface where the decision is recorded — the hub action bar's Resolve/Archive
 * is intentionally hidden for this open mirrored type (Task 3).
 */
export function JoinRequestBody({ item }: { item: HubItemListRow }) {
  const target = "/team?tab=requests";
  return (
    <HubViewerScaffold item={item}>
      {item.summary ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : null}
      <div className="mt-4 flex gap-2">
        <Button asChild size="sm">
          <Link to={target}>Approve</Link>
        </Button>
        <Button asChild size="sm" variant="secondary">
          <Link to={target}>Decline</Link>
        </Button>
      </div>
    </HubViewerScaffold>
  );
}
```

Create `ui/src/components/hub/viewers/SuggestionBody.tsx`:

```tsx
import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";
import { HubViewerScaffold } from "./HubViewerScaffold";

/** Suggestion body: rationale summary + Apply/Open. Suggestions surface on Home,
 *  so "Open" deep-links there; "Apply" is the primary act (resolves via the bar). */
export function SuggestionBody({ item }: { item: HubItemListRow }) {
  return (
    <HubViewerScaffold item={item}>
      {item.summary ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground">No rationale provided.</p>
      )}
      <div className="mt-4 flex gap-2">
        <Button size="sm" disabled title="Coming soon">
          Apply
        </Button>
        <Button asChild size="sm" variant="secondary">
          <Link to="/home">Open</Link>
        </Button>
      </div>
    </HubViewerScaffold>
  );
}
```

Create `ui/src/components/hub/viewers/ReminderBody.tsx`:

```tsx
import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { HubViewerScaffold } from "./HubViewerScaffold";
import { Button } from "@/components/ui/button";

/** Reminder body: the reminder text + Open in Commander (reminders live there). */
export function ReminderBody({ item }: { item: HubItemListRow }) {
  return (
    <HubViewerScaffold item={item}>
      <p className="text-sm leading-6 text-text">{item.title}</p>
      {item.summary ? (
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : null}
      <div className="mt-4">
        <Button asChild size="sm" variant="secondary">
          <Link to="/commander">Open in Commander</Link>
        </Button>
      </div>
    </HubViewerScaffold>
  );
}
```

Create `ui/src/components/hub/viewers/MarketplaceOpBody.tsx`:

```tsx
import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { HubViewerScaffold } from "./HubViewerScaffold";
import { Button } from "@/components/ui/button";

/** Marketplace-operation body: op status summary + View (the marketplace hub). */
export function MarketplaceOpBody({ item }: { item: HubItemListRow }) {
  return (
    <HubViewerScaffold item={item}>
      {item.summary ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground">Operation status unavailable.</p>
      )}
      <div className="mt-4">
        <Button asChild size="sm" variant="secondary">
          <Link to="/marketplace">View</Link>
        </Button>
      </div>
    </HubViewerScaffold>
  );
}
```

Create `ui/src/components/hub/viewers/RoutineBody.tsx`:

```tsx
import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { HubViewerScaffold } from "./HubViewerScaffold";
import { Button } from "@/components/ui/button";

/** Routine-outcome body: failure/exit summary + Open routine. sourceId is the
 *  routine id (registry: fullLink → /routines/:id) for the deep-link. */
export function RoutineBody({ item }: { item: HubItemListRow }) {
  const routineId = item.relatedEntityId ?? item.sourceId ?? "";
  return (
    <HubViewerScaffold item={item}>
      {item.summary ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground">No outcome details.</p>
      )}
      <div className="mt-4 flex gap-2">
        {routineId ? (
          <Button asChild size="sm" variant="secondary">
            <Link to={`/routines/${routineId}`}>Open routine</Link>
          </Button>
        ) : (
          <Button asChild size="sm" variant="secondary">
            <Link to="/routines">Open routine</Link>
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled title="Coming soon">
          Run now
        </Button>
      </div>
    </HubViewerScaffold>
  );
}
```

Create `ui/src/components/hub/viewers/GenericNotificationBody.tsx`:

```tsx
import { Link } from "@/lib/router";
import type { HubItemListRow } from "@/api/hub-items";
import { HUB_REGISTRY } from "../hubRegistry";
import { HubViewerScaffold } from "./HubViewerScaffold";
import { Button } from "@/components/ui/button";

/** Generic notification body: the text + one primary action derived from the
 *  registry's fullLink (falls back to a no-op when there is no deep-link). */
export function GenericNotificationBody({ item }: { item: HubItemListRow }) {
  const fullLink = HUB_REGISTRY[item.semanticType]?.fullLink(item) ?? null;
  return (
    <HubViewerScaffold item={item}>
      {item.summary ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground">No further details.</p>
      )}
      {fullLink ? (
        <div className="mt-4">
          <Button asChild size="sm" variant="secondary">
            <Link to={fullLink}>Open</Link>
          </Button>
        </div>
      ) : null}
    </HubViewerScaffold>
  );
}
```

Create `ui/src/components/hub/viewers/UnlinkableEntityBody.tsx`:

```tsx
import type { HubItemListRow } from "@/api/hub-items";
import { HubViewerScaffold } from "./HubViewerScaffold";

/** artifact / memory tabs have no hub payload yet (no artifactId/memoryId to feed
 *  a viewer). Render an honest "not linkable yet" body — never a perpetual
 *  spinner. Real wiring lands when the payloads + factories exist (follow-up). */
export function UnlinkableEntityBody({
  item,
  kind,
}: {
  item: HubItemListRow;
  kind: "artifact" | "memory";
}) {
  return (
    <HubViewerScaffold item={item}>
      <p className="text-sm leading-6 text-muted-foreground">
        This {kind} is not directly linkable from the hub yet. Open the related
        entity from its source surface to review it.
      </p>
    </HubViewerScaffold>
  );
}
```

- [ ] **Step 5: Run the viewer suite to verify it passes**

Run: `cd ui && npx vitest run src/components/hub/viewers/__tests__/HubViewers.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit the disjoint component files**

```bash
git add ui/src/components/hub/viewers/HubViewerScaffold.tsx ui/src/components/hub/viewers/JoinRequestBody.tsx ui/src/components/hub/viewers/SuggestionBody.tsx ui/src/components/hub/viewers/ReminderBody.tsx ui/src/components/hub/viewers/MarketplaceOpBody.tsx ui/src/components/hub/viewers/RoutineBody.tsx ui/src/components/hub/viewers/GenericNotificationBody.tsx ui/src/components/hub/viewers/UnlinkableEntityBody.tsx ui/src/components/hub/viewers/__tests__/HubViewers.test.tsx
git commit -m "feat(hub): build the 8 placeholder viewer bodies (scaffold + join/suggestion/reminder/marketplace/routine/notification/unlinkable)"
```

- [ ] **Step 7: Add the `routineTab` factory + payload (hubViewerModel.ts)**

In `ui/src/components/hub/hubViewerModel.ts`, add a payload interface after `HubReminderPayload` (:65-67):

```ts
export interface HubRoutinePayload {
  routineId: string;
}
```

Add it to the `HubTabPayload` union (:77-90) after `HubReminderPayload`:

```ts
  | HubReminderPayload
  | HubRoutinePayload
```

Add the factory after `reminderTab` (:207-215):

```ts
export function routineTab(routineId: string, title?: string): HubTab {
  return {
    key: `routine:${routineId}`,
    kind: "routine",
    title: title || "Routine",
    closeable: true,
    payload: { routineId } satisfies HubRoutinePayload,
  };
}
```

- [ ] **Step 8: Route the `routine` tabKind to `routineTab` (hubRegistry.tsx)**

In `ui/src/components/hub/hubRegistry.tsx`, add `routineTab` to the import block from `./hubViewerModel` (:20-33) and change the `routine` case in `hubTabForItem` (:350-352). Replace:

```tsx
    case "routine":
      // No routine factory yet — fall back to a generic notification tab.
      return notificationTab(item.id, title);
```

with:

```tsx
    case "routine":
      return id ? routineTab(id, title) : notificationTab(item.id, title);
```

- [ ] **Step 9: Wire the new bodies into HubTabBody (COUPLED — sequential)**

In `ui/src/components/hub/HubTabBody.tsx`, add imports for the new bodies + the `HubRoutinePayload` type. After the existing viewer imports (near :11) add:

```tsx
import { JoinRequestBody } from "./viewers/JoinRequestBody";
import { SuggestionBody } from "./viewers/SuggestionBody";
import { ReminderBody } from "./viewers/ReminderBody";
import { MarketplaceOpBody } from "./viewers/MarketplaceOpBody";
import { RoutineBody } from "./viewers/RoutineBody";
import { GenericNotificationBody } from "./viewers/GenericNotificationBody";
import { UnlinkableEntityBody } from "./viewers/UnlinkableEntityBody";
```

These new bodies resolve the hub row by id via `resolveHubItem` (the join_request/suggestion/reminder/marketplace_op/routine payloads carry an ENTITY id, not a hub-item id — but the bodies render from the hub ROW, which is what the list clicked). Since these tab payloads key on the entity id (not hubItemId), and the bodies need the hub row, resolve it from `resolveHubItem` using the payload's hubItemId when available OR fall back to a placeholder. To keep this simple and correct: these five kinds are opened from a row click, and Task 3 already resolves the ACTIVE tab's row for the action bar — but the BODY also needs the row. The cleanest DRY move: have `hubTabForItem` stash the hub-item id so the body can resolve it. Rather than re-plumb, resolve via `resolveHubItem` against the tab key's second segment where it is a hub-item id, else render from the title. Concretely, replace the combined placeholder case block (HubTabBody.tsx:207-215):

```tsx
    case "artifact":
    case "memory":
    // Not-yet-built kinds — Phase D/E wire these.
    case "join_request":
    case "suggestion":
    case "marketplace_op":
    case "reminder":
    case "routine":
      return <TabLoadingPlaceholder kind={tab.kind} />;
```

with:

```tsx
    case "join_request": {
      const payload = tab.payload as HubJoinRequestPayload | undefined;
      const item = resolveHubItem?.(payload?.joinRequestId ?? "");
      if (!item) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <JoinRequestBody item={item} />;
    }

    case "suggestion": {
      const payload = tab.payload as HubSuggestionPayload | undefined;
      const item = resolveHubItem?.(payload?.suggestionId ?? "");
      if (!item) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <SuggestionBody item={item} />;
    }

    case "reminder": {
      const payload = tab.payload as HubReminderPayload | undefined;
      const item = resolveHubItem?.(payload?.reminderId ?? "");
      if (!item) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <ReminderBody item={item} />;
    }

    case "marketplace_op": {
      const payload = tab.payload as HubMarketplaceOpPayload | undefined;
      const item = resolveHubItem?.(payload?.sourceId ?? "");
      if (!item) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <MarketplaceOpBody item={item} />;
    }

    case "routine": {
      const payload = tab.payload as HubRoutinePayload | undefined;
      const item = resolveHubItem?.(payload?.routineId ?? "");
      if (!item) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <RoutineBody item={item} />;
    }

    case "artifact":
    case "memory":
      return <TabLoadingPlaceholder kind={tab.kind} />;
```

> Resolver note: the entity-id payloads (`joinRequestId`, `suggestionId`, `reminderId`, `sourceId`, `routineId`) equal the hub row's `sourceId`/`relatedEntityId` for these producers (see hubRegistry resolveTabId comments), and `resolveHubItem` (InboxHub `resolveHubItem`, InboxHub.tsx:620-624) looks up by HUB ITEM id — which does NOT match the entity id. To make the body resolve reliably, change these tabs to carry the hub-item id. **Simpler, correct approach chosen instead:** give each of these five bodies the hub row by having `hubTabForItem` pass the hub-item id. Because that would ripple into every factory signature, and Task 3 already proved the active row is resolvable from `selectedItem`, THREAD the resolved row through a new optional `HubTabBody` prop `activeItem` (the active tab's hub row, already computed in HubShell Task 3 as `activeBarItem`). Replace the five `resolveHubItem?.(payload?…)` lookups above with `activeItem`:

Refine: add an `activeItem?: HubItemListRow | null` prop to `HubTabBodyProps` (HubTabBody.tsx:28-45) and thread it from `HubTabBodyContent`. Then each new-body case becomes:

```tsx
    case "join_request": {
      if (!activeItem) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <JoinRequestBody item={activeItem} />;
    }
    case "suggestion": {
      if (!activeItem) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <SuggestionBody item={activeItem} />;
    }
    case "reminder": {
      if (!activeItem) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <ReminderBody item={activeItem} />;
    }
    case "marketplace_op": {
      if (!activeItem) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <MarketplaceOpBody item={activeItem} />;
    }
    case "routine": {
      if (!activeItem) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <RoutineBody item={activeItem} />;
    }
    case "artifact":
      if (!activeItem) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <UnlinkableEntityBody item={activeItem} kind="artifact" />;
    case "memory":
      if (!activeItem) return <TabLoadingPlaceholder kind={tab.kind} />;
      return <UnlinkableEntityBody item={activeItem} kind="memory" />;
```

Also upgrade the `notification` case (HubTabBody.tsx:185-186) to the richer body when the row is resolvable — replace `return <HubNotificationBody tab={tab} />;` with:

```tsx
    case "notification":
      return activeItem ? (
        <GenericNotificationBody item={activeItem} />
      ) : (
        <HubNotificationBody tab={tab} />
      );
```

Add the required imports for `HubJoinRequestPayload` etc. are no longer needed (we use `activeItem`), and add `HubItemListRow` is already imported (HubTabBody.tsx:8). Then in `HubShell.tsx`, pass `activeItem={activeBarItem}` to `<HubTabBody>` (the `viewer` block, after `resolveHubItem={resolveHubItem}`):

```tsx
            <HubTabBody
              tab={activeTab}
              companyId={companyId}
              onOpenTab={onOpenTab}
              resolveHubItem={resolveHubItem}
              activeItem={activeBarItem}
              homeContent={ /* the <HubHome … /> dashboard from Task 1 — unchanged */ }
            />
```

> Note (tab-first): the `homeContent` here is the `HubHome` dashboard wired in Task 1 (NOT the deleted `HubHomeTab`). `activeBarItem` is the Task-3 active-tab resolver — for a home tab it is `null`, so `activeItem` is only meaningful on entity/decision/notification tabs, which is exactly the set of new bodies below.

- [ ] **Step 10: Update the HubTabBody unit tests for the new real bodies**

In `ui/src/components/hub/__tests__/HubTabBody.test.tsx`, the test `"renders a placeholder (not null) for an unwired kind like join_request"` (:262-268) is now WRONG — join_request renders a real body when `activeItem` is supplied. Update `renderBody` (:134-148) to accept an optional `activeItem`, and rewrite that test to pass an `activeItem` and assert the JoinRequestBody renders (Approve/Decline). Replace the test with:

```tsx
  it("renders JoinRequestBody for a join_request tab when the active item resolves", () => {
    render(
      <HubTabBody
        tab={joinRequestTab("jr-1", "Join request")}
        companyId="company-1"
        onOpenTab={vi.fn()}
        activeItem={{
          ...runtimeDecisionItem("hub-jr"),
          semanticType: "join_request",
          sourceType: "join_request",
          title: "Scout wants to join",
          summary: "Requested by scout@example.com",
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: /scout wants to join/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
  });

  it("falls back to the placeholder for a join_request tab with no active item", () => {
    renderBody(joinRequestTab("jr-1", "Join request"));
    expect(screen.getByText(/preparing viewer/i)).toBeInTheDocument();
  });
```

Wrap the JoinRequestBody-hosting render in a `MemoryRouter` (the body uses `<Link>`). Add at the top of the file:

```tsx
import { MemoryRouter } from "react-router-dom";
```

and wrap that specific render. (The existing mock-based tests for task/thread/approval/etc. stay valid — they don't touch the new cases.)

- [ ] **Step 11: Run the full hub suite**

Run: `cd ui && npx vitest run src/components/hub`
Expected: PASS.

- [ ] **Step 12: Commit (coupled files, explicit paths)**

```bash
git add ui/src/components/hub/HubTabBody.tsx ui/src/components/hub/HubShell.tsx ui/src/components/hub/hubViewerModel.ts ui/src/components/hub/hubRegistry.tsx ui/src/components/hub/__tests__/HubTabBody.test.tsx
git commit -m "feat(hub): wire real placeholder viewers + routine tab factory into HubTabBody"
```

---

## Task 6: Confirm the ~6 built viewers stay rich (regression guard)

The types that already host a full embedded viewer (approval→`ApprovalDetailCore`, task/stale_work→`TaskDetail`, thread/discussion/agent_error/mention/extraction_failed→`ThreadDetail`, run_failed/run_complete→`RunDetailContainer`, agent→`AgentDetailContainer`, budget→`BudgetCapsSection`) must KEEP hosting those — the redesign only removed the surrounding header chrome (Task 2) and added the action bar above (Task 3). This task is a regression guard: assert those tabs still render their embedded viewer AND that the action bar is present above them (no compact-body regression).

**Files:**
- Test: `ui/src/components/hub/__tests__/HubTabBody.test.tsx` (the existing task/thread/approval/agent/run tests at :201-319 already assert the embedded viewers — verify they still pass; add no compact-body substitution)

- [ ] **Step 1: Run the existing embedded-viewer assertions**

Run: `cd ui && npx vitest run src/components/hub/__tests__/HubTabBody.test.tsx`
Expected: PASS — the mocks for `TaskDetail`, `ThreadDetail`, `ApprovalDetailCore`, `AgentDetailContainer`, `RunDetailContainer` still route through unchanged switch cases (Task 5 only edited the placeholder + notification cases).

- [ ] **Step 2: Add an explicit "built viewers are not replaced by a compact body" guard**

Add to `ui/src/components/hub/__tests__/HubTabBody.test.tsx`:

```tsx
  it("keeps hosting the embedded ApprovalDetailCore (no compact-body regression)", () => {
    renderBody(approvalTab("approval-9", "Review hire"));
    expect(screen.getByTestId("mock-approval-core")).toBeInTheDocument();
    // The scaffold/compact bodies are NOT used for a built viewer kind.
    expect(screen.queryByTestId("hub-viewer-scaffold")).toBeNull();
  });
```

- [ ] **Step 3: Run to verify it passes**

Run: `cd ui && npx vitest run src/components/hub/__tests__/HubTabBody.test.tsx -t "no compact-body regression"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/hub/__tests__/HubTabBody.test.tsx
git commit -m "test(hub): guard that built viewers keep their embedded body (no compact regression)"
```

---

## Task 8: Fix — answered `work_question` never leaves the founder's waiting lane

**Root cause:** `answered` is a NON-terminal ACTIVE status (agent-runtime-decisions.ts:20-25 `ACTIVE_STATUSES` includes `answered`; `TERMINAL_STATUSES` = `{relayed, expired, cancelled}` :26-30), and the runtime_decision reconciler closes the hub item iff status ∈ TERMINAL_STATUSES (`runtimeDecisionSourceSnapshot` :571 → `terminal: TERMINAL_STATUSES.has(status)`). The `ask_founder` tool (`handleAskFounder`) calls `waitForAnswer` and returns the answer, but NEVER calls `markRelayed` — so the decision stays `answered` (non-terminal) and its projected hub item stays `open` in `waiting_on_you` forever.

**Chosen fix (recommended):** Mirror heartbeat's canonical `waitAndRelay` pattern (heartbeat.ts:353-410 / requestPermissionBounded :434-489): after `waitForAnswer` returns an answer, call `svc.markRelayed(...)` which flips the decision `answered → relayed` (terminal), emits + `closeProjectedHubItem` → the hub item leaves the waiting lane. This is done ONLY on the success (answered) branch — NEVER on park/timeout/cancel (those already return "parked" and leave the row for the sweep/cancel, preserving the R2 stranded-answer safety net).

**Safety weighing (why relay-before-agent-consumes is safe here):**
- The answer is DURABLE before `markRelayed` (answerPrompt persists `answerPayload` + `status='answered'`; agent-runtime-decisions.ts:913-921). `markRelayed` only records that the answer was handed back; the tool then returns `{answered:true, answer}` to the agent in the SAME call — there is no separate HTTP round-trip that could drop the answer between relay and delivery (unlike the heartbeat broker, `ask_founder` IS the delivery path).
- `markRelayed` can lose a race to run-cancellation (`RuntimeDecisionCancelledError`) or conflict if the row went terminal concurrently. In BOTH cases the answer is already durable and the tool still has it, so we return the answer anyway (the hub item is closed by whichever terminal transition won). We catch `markRelayed`'s throw and DO NOT let it turn a successful answer into an error — mirroring heartbeat's `waitAndRelay` which rethrows only `RuntimeDecisionCancelledError` but for `ask_founder` a cancel after a real answer still means "the founder answered", so we return the answer + note the relay outcome.
- We do NOT call `markRelayed` on the park/timeout/cancel branches — those keep the existing behavior (return "parked"; the decision is cancelled/expired by the sweep, closing the item). This preserves the "do not markRelayed on timeout" invariant (heartbeat.ts:445-448).

**Alternative considered (rejected):** a distinct "close-on-answer" that keeps the decision `answered` and closes the hub item directly. Rejected because it would diverge from the single source-of-truth terminality model (reconcile keys on TERMINAL_STATUSES); leaving a decision `answered`-but-item-closed re-opens the exact drift this reconciler exists to prevent, and would need a new bespoke close path. `markRelayed` is the existing, tested terminalization.

**Files:**
- Modify: `server/src/mcp/tools/ask-founder-tool.ts:79-99` (call `markRelayed` after `waitForAnswer` succeeds)
- Test: `server/src/__tests__/ask-founder-tool.test.ts` (unit — assert `markRelayed` called on success, NOT on park; already stubbed in Task 7)
- Create: extend `server/src/__tests__/ask-founder-dogfood.integration.test.ts` (new Scenario 7 — end-to-end: item leaves the open waiting lane after an answer)

- [ ] **Step 1: Write the failing unit test**

Add to `server/src/__tests__/ask-founder-tool.test.ts` (the mock service already exposes `markRelayed` from Task 7):

```ts
  it("marks the decision relayed after a successful answer (terminalizes → hub item closes)", async () => {
    const getById = vi.fn().mockResolvedValue({ adapterType: "codex_local" });
    createPrompt.mockResolvedValue({ decision: { id: "d1" } });
    waitForAnswer.mockResolvedValue({ answerPayload: { text: "yes" } });
    markRelayed.mockResolvedValue({ id: "d1", status: "relayed" });

    const res = await handleAskFounder(
      makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }, getById),
      { question: "Ship it?" },
    );

    expect(markRelayed).toHaveBeenCalledWith({ companyId: "co-1", decisionId: "d1" });
    // The agent still gets the answer.
    expect((res as any).data).toEqual({ answered: true, answer: { text: "yes" } });
  });

  it("does NOT mark relayed on a parked (cancelled) outcome", async () => {
    const getById = vi.fn().mockResolvedValue({ adapterType: "codex_local" });
    createPrompt.mockResolvedValue({ decision: { id: "d1" } });
    waitForAnswer.mockRejectedValue(new FakeCancelledError());

    const res = await handleAskFounder(
      makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }, getById),
      { question: "Ship it?" },
    );

    expect(markRelayed).not.toHaveBeenCalled();
    expect((res as any).data.status).toBe("parked");
  });

  it("still returns the answer if markRelayed loses a race (answer is durable)", async () => {
    const getById = vi.fn().mockResolvedValue({ adapterType: "codex_local" });
    createPrompt.mockResolvedValue({ decision: { id: "d1" } });
    waitForAnswer.mockResolvedValue({ answerPayload: { value: "a" } });
    markRelayed.mockRejectedValue(new FakeCancelledError());

    const res = await handleAskFounder(
      makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }, getById),
      { question: "Pick?" },
    );

    // A relay race after a real answer must not lose the answer.
    expect((res as any).ok).toBe(true);
    expect((res as any).data).toEqual({ answered: true, answer: { value: "a" } });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run server/src/__tests__/ask-founder-tool.test.ts -t "marks the decision relayed"`
Expected: FAIL — `markRelayed` is never called (the tool returns the answer without relaying).

- [ ] **Step 3: Implement the relay-on-success in `handleAskFounder`**

In `server/src/mcp/tools/ask-founder-tool.ts`, replace the `try { … } catch (e) { … }` block (lines 79-99) with:

```ts
  try {
    const answered = await svc.waitForAnswer({
      companyId: ctx.companyId,
      decisionId: decision.id,
      timeoutMs: WORK_QUESTION_BLOCK_TIMEOUT_MS,
    });
    // BUG (D-tabbed): an answered work_question stays 'answered' (a NON-terminal
    // ACTIVE status), so its projected waiting-lane hub item never closes. Mirror
    // heartbeat's waitAndRelay: on the SUCCESS branch only, mark the decision
    // relayed → it terminalizes → reconcileRuntimeDecision closes the hub item.
    // The answer is already durable; if markRelayed loses a race to a concurrent
    // cancel/relay (the run went terminal between the answer and here), the item
    // is closed by whichever terminal transition won and we STILL return the
    // real answer — a relay race must never turn a real answer into an error.
    try {
      await svc.markRelayed({ companyId: ctx.companyId, decisionId: decision.id });
    } catch {
      // Best-effort terminalization: answer is durable + returned below; the
      // stranded-answer sweep / run-cancel close the item if this lost the race.
    }
    return ok({ answered: true, answer: answered.answerPayload });
  } catch (e) {
    // Every terminal NON-answer outcome parks gracefully so the model STOPS
    // (never retry-loops): a cancel (RuntimeDecisionCancelledError — e.g. the run
    // went terminal and cancelActiveForRun cancelled this decision), the bounded
    // block timing out ("Timed out…"), OR the decision reaching a terminal
    // non-answered status while we polled ("… no longer actionable" — a benign
    // relayed/expired race). "park_run" means there is no safe default answer, so
    // any of these is a "no answer, stop here" — not a hard error. Any OTHER error
    // (e.g. notFound, a DB fault) is a real failure — rethrow. markRelayed is NOT
    // reached here: we never relay on a park/timeout/cancel (heartbeat invariant).
    const parked = ok({ answered: false, status: "parked", note: "parked for founder" });
    if (e instanceof RuntimeDecisionCancelledError) return parked;
    if (e instanceof Error && /timed out|no longer actionable/i.test(e.message)) return parked;
    throw e;
  }
```

(`svc` already has `markRelayed` — it is a member of the object `agentRuntimeDecisionService` returns, agent-runtime-decisions.ts:1180. No import change.)

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm test:run server/src/__tests__/ask-founder-tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test (Scenario 7)**

Add to `server/src/__tests__/ask-founder-dogfood.integration.test.ts`, inside the `describe.skipIf(...)` block (after Scenario 6, before the closing `});` at :515). This asserts the hub item LEAVES the open waiting lane after a real answer end-to-end:

```ts
  // ── Scenario 7: answered item leaves the waiting lane (the BUG-fix) ─────────

  it("Scenario 7 — an answered work_question closes its hub item (leaves waiting_on_you)", async () => {
    if (setupError) throw new Error(String(setupError));

    const { companyId, agentId } = await seedCompanyAndAgent("S7");
    const runId = await seedHeartbeatRun(companyId, agentId, "running");
    const ctx = buildAgentCtx(companyId, agentId, runId);
    const svc = agentRuntimeDecisionService(db);

    const p = handleAskFounder(ctx, { question: "Ship v1 now?" });

    const decision = await waitForWorkQuestionDecision(companyId, runId);
    const decisionId = String(decision.id);

    // Before answering: the hub item is OPEN in the waiting lane.
    const hubBefore = await findHubRowForDecision(companyId, decisionId);
    expect(hubBefore.length).toBeGreaterThanOrEqual(1);
    expect(String(hubBefore[0].status)).toBe("open");

    // Amendment 2.5: capture the waiting-lane OPEN count BEFORE answering. The
    // runtime-decision projection lands in the waiting_on_you lane (semantic_type
    // 'agent_runtime_decision'), so count OPEN runtime-decision hub rows for the
    // company — answering must DECREMENT this, not just flip one row's status.
    const openCount = async () =>
      Number(
        rowsOf(
          await db.execute(sql`
            SELECT COUNT(*)::int AS n FROM notifications
            WHERE company_id = ${companyId}
              AND source_type = 'runtime_decision'
              AND status = 'open'
          `),
        )[0].n,
      );
    const waitingOpenBefore = await openCount();
    expect(waitingOpenBefore).toBeGreaterThanOrEqual(1);

    // Founder answers (run still running → not stranded).
    await svc.answerPrompt({
      companyId,
      decisionId,
      actorUserId: "local-board",
      expectedSourceRevision: Number(decision.source_revision),
      nonce: String(decision.nonce),
      kind: "work_question",
      answer: { text: "yes" },
    });

    // The tool returns the answer AND (the fix) relays → terminalizes the decision.
    const res = await p;
    expect(res).toEqual({ ok: true, data: { answered: true, answer: { text: "yes" } } });

    // The decision is now RELAYED (terminal), not left at 'answered'.
    const [after] = rowsOf(
      await db.execute(sql`SELECT status FROM agent_runtime_decisions WHERE id = ${decisionId}`),
    );
    expect(String(after.status)).toBe("relayed");

    // The projected hub item is NO LONGER open — it left the waiting_on_you lane.
    const hubAfter = rowsOf(
      await db.execute(sql`
        SELECT status FROM notifications
        WHERE company_id = ${companyId} AND source_type = 'runtime_decision' AND source_id = ${decisionId}
      `),
    );
    expect(hubAfter.length).toBeGreaterThanOrEqual(1);
    expect(String(hubAfter[0].status)).not.toBe("open");

    // Amendment 2.5: the waiting-lane OPEN count DECREASED by exactly one — the
    // item didn't just change status in place, it left the "waiting on you" queue.
    const waitingOpenAfter = await openCount();
    expect(waitingOpenAfter).toBe(waitingOpenBefore - 1);
  });
```

- [ ] **Step 6: Run the integration test (Windows-gated)**

Run: `AOA_RUN_WIN_INTEGRATION=1 pnpm test:run server/src/__tests__/ask-founder-dogfood.integration.test.ts` (on Windows; on Linux CI it runs unconditionally)
Expected: PASS — Scenario 7 green (decision `relayed`, hub item not `open`), all prior scenarios still green. (Scenario 1-3 assert `res` equals `{answered:true, …}` and now ALSO relay — they already expected `answered:true`, and the relay is a side-effect that doesn't change `res`, so they stay green.)

> If embedded-postgres cannot start locally, the `describe.skipIf` short-circuits and the suite is skipped — that is expected on a machine where the harness can't run; rely on Linux CI for the real gate.

- [ ] **Step 7: Commit**

```bash
git add server/src/mcp/tools/ask-founder-tool.ts server/src/__tests__/ask-founder-tool.test.ts server/src/__tests__/ask-founder-dogfood.integration.test.ts
git commit -m "fix(mcp): relay answered work_questions so the hub item leaves the waiting lane (BUG)"
```

---

## Task 9: Full-suite verification + docs

Run the complete affected test surface, then document the redesign + the deferred follow-ups.

**Files:**
- Modify: `docs/architecture/decisions.md` (append a locked decision entry for the tabbed-viewer redesign + the ask_founder relay-on-answer fix)
- Modify: `CLAUDE.md` (the "Inbox & Approvals hub" area — note tab-first / no-preview + the Home-tab dashboard + the action bar + the 12-tab cap, if a hub section exists; otherwise skip — code is truth)

- [ ] **Step 1: Run the full hub UI suite + page test**

Run: `cd ui && npx vitest run src/components/hub src/__tests__/InboxHub.test.tsx`
Expected: PASS (all hub component + viewer + page tests).

- [ ] **Step 2: Run the affected server suites**

Run: `pnpm test:run server/src/__tests__/ask-founder-tool.test.ts server/src/__tests__/agent-runtime-decisions.test.ts server/src/__tests__/heartbeat-runtime-decision-broker.test.ts packages/shared/src/__tests__/hub-validators.test.ts`
Expected: PASS (unit + broker + shared validators). Then the integration test on Linux CI (or `AOA_RUN_WIN_INTEGRATION=1` locally).

- [ ] **Step 3: Typecheck + build the two packages that changed public types**

Run: `cd packages/shared && npx tsc --noEmit` then `cd ../../ui && npx tsc --noEmit`
Expected: no type errors (the widened `runtimeDecisionDetailSchema.options` element flows the optional fields into `RuntimeDecisionDetail`; the panel's `opt as {…description?…}` cast is now aligned with the schema).

- [ ] **Step 4: Append the locked decision entry**

Add to `docs/architecture/decisions.md` (a new numbered decision — use the next free number, referencing #107 for the hub lineage). Content:

```markdown
### Decision #NNN — Hub tabbed-viewer redesign (TAB-FIRST, no preview) + ask_founder relay-on-answer (2026-07-04)

- TAB-FIRST, NO preview pane (LOCKED 2026-07-04). Row-click opens AND activates a
  DEDICATED tab per item (`hubTabForItem` → factory), deduped + activated via
  `useHubTabs.openTab`. The Home tab hosts the `HubHome` "Needs you most"
  DASHBOARD (not a per-item preview); `HubHomeTab` + the `HubViewer` reading pane
  are DELETED. Deep-links open a tab. Keyboard `j`/`k` move a list highlight,
  `Enter` opens the highlighted item's tab, `Escape` clears the highlight (never
  closes a tab — tabs close only via the strip × button). The redundant in-body
  type-label header is gone (the tab strip labels the type). Tabs are capped at
  `HUB_TABS_MAX = 12` (Home + 11 newest closeables; oldest evicted) with a visible
  "12 max" indicator + a horizontally-scrollable strip — a deliberate UX ceiling.
- A slim contextual, mirror-aware `HubActionBar` (Mark-unread/Dismiss/Snooze/
  Resolve/Archive/Claim/Release; Route/Delegate + Ask-Commander stubbed with
  coming-soon aria-labels; an optional left-edge undo banner) mounts above every
  NON-home tab body and targets the ACTIVE TAB's item. The `agent_runtime_decision`
  viewer renders a context callout + full-width option CARDS (label + optional
  description + rationale) + an always-on free-text fallback.
- `ask_founder` now calls `markRelayed` after a successful `waitForAnswer` (mirrors
  heartbeat `waitAndRelay`), terminalizing the decision so its projected
  waiting-lane hub item closes. Relay is best-effort (a race after a durable answer
  never loses the answer) and is NEVER called on park/timeout/cancel (the
  stranded-answer sweep owns those). Option cards carry EXPLICIT optional
  `description`/`rationale` fields added to the `.strict()` `ask_founder` zod
  (unknown keys were rejected — passthrough was NOT enough); the DB `options`
  column is arbitrary jsonb (no migration).
- Deferred: Route/Delegate wiring (reassign owner + notify + authority); Commander
  "weigh in" wiring; rationale/description CONTENT source (asking agent /
  Commander); per-entity-tab action-bar targeting (the bar falls back to the
  last-opened row for entity tabs; only hubItemId-bearing tabs resolve directly);
  artifact/memory hub tab payloads.
```

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/decisions.md CLAUDE.md
git commit -m "docs: lock the hub tabbed-viewer redesign + ask_founder relay-on-answer decision"
```

---

## Self-Review

**1. Spec coverage** (each redesign requirement → task):
- TAB-FIRST, no preview: row-click opens+activates a tab; Home tab = `HubHome` dashboard; deep-link opens a tab; `j`/`k` highlight + `Enter` opens + `Escape` clears (never closes a tab) → **Task 1** (+ HubHomeTab deleted; InboxHub deep-link effect is now a file-coupled write).
- Retire the orphaned `HubViewer` reading pane + drop the redundant type-label header (both dead under tab-first) → **Task 2** (deletes `HubViewer.tsx`; captures its mirror gate + footer set for Task 3).
- Slim contextual + mirror-aware action bar targeting the ACTIVE TAB's item (Mark-unread/Dismiss/Snooze/Resolve/Archive/Claim + Route/Delegate stub + Ask-Commander stub with coming-soon aria-labels + folded-in undo banner) → **Task 3**.
- Tab-cap (12) visible affordance + eviction guard (deliberate UX ceiling; scrollable strip) → **Task 3b** (Amendment 2.1).
- Readable decision viewer (roomy question, option cards w/ description+rationale, free-text fallback, context callout) → **Task 4** (now rendered inside a TAB, not a reading pane).
- Option-schema bump `{label,value,description?,rationale?}` across the `.strict()` ask_founder zod (EXPLICIT fields, not passthrough) + JSON schema + shared validator + panel; DB `options` is arbitrary jsonb (no migration) → **Task 7** (+ consumed in Task 4; Amendment 3).
- Build the 8 placeholder viewers → **Task 5** (join_request, suggestion, reminder, marketplace_op, routine, generic notification, unlinkable artifact/memory; run_complete via existing RunDetailContainer). Bodies receive `activeItem` (the Task-3 active row).
- Built viewers stay rich (no compact-body regression) → **Task 6**.
- Backend BUG: answered work_question never leaves waiting lane → **Task 8** (relay-on-answer, weighed vs. the close-on-answer alternative, integration test proving the item leaves the lane AND the waiting-lane OPEN count decrements — Amendment 2.5).
- Mobile: tab-first shows the active tab in the stacked `{viewer}` region — no mobile-only path → **Task 1 mobile note** (Amendment 2.2).
- a11y on stub buttons (aria-label naming the coming-soon action) → **Task 3** (Amendment 2.4).
- Full-suite + docs → **Task 9**.
- OLD-model tests rewritten/deleted (HubHomeTab.test DELETED — Amendment 4; HubShell "select on click"→"opens+activates a tab", "reading pane"→"dashboard body", "close viewer"→Escape, "moves selection j/k"→highlight+Enter; RuntimeDecisionPanel option-buttons→cards; HubTabBody join_request placeholder→real body; InboxHub row-click + 3 deep-link tests assert the panel renders IN A TAB) → called out inline in Tasks 1-5.

**2. Placeholder scan:** every code step contains real code (no "add X"/"TODO"). Design tradeoffs resolve to concrete mechanisms: (a) Task 3's action-bar targeting = the active tab's `resolveHubItem(hubItemIdForTab)` with a `selectedItem` fallback (no preview divergence); (b) Task 5's body resolution threads `activeItem` (the Task-3 active row) into `HubTabBody`, superseding the first-considered `resolveHubItem?.(entityId)` lookup (documented as rejected inline). The two DELETEs (HubHomeTab in Task 1, HubViewer in Task 2) are grep-verified orphans with the reuse logic captured inline before deletion.

**3. Type consistency:** `HubActionBar` prop names (`onDismiss`/`onSnooze`/`onLifecycleAction`/`onMarkUnread`/`undoAction`) match HubShell's existing handler + `undoAction` props; `showResolveArchive`/`showClaimRelease` logic is copied verbatim from the pre-deletion HubViewer.tsx:89-99 (captured in Task 2). `HubHome`'s props in the Home tab match the SAME call already in `listSection` (HubShell.tsx:799-808). `hubItemIdForTab` reads `payload.hubItemId`, which only `runtime_decision` (hubViewerModel.ts:36-38,143) + `notification` (:73-75,235) payloads carry — verified. `routineTab(routineId, title?)` + `HubRoutinePayload.routineId` match the `reminderTab`/`HubReminderPayload` pattern. `markRelayed({ companyId, decisionId })` matches its service signature (agent-runtime-decisions.ts) and heartbeat's call sites. The widened `runtimeDecisionDetailSchema.options` element (`description?`/`rationale?` explicit optional) matches the ask_founder zod widening and the panel's `opt as {…description?…rationale?…}` cast; the DB column is `jsonb().$type<Array<Record<string,unknown>>>()` (no migration). `activeItem?: HubItemListRow | null` is the same type HubShell resolves for `activeBarItem`.

**File-coupling recap (enforced sequential, explicit-path `git add`):** HubShell.tsx (Tasks 1, 3, 5 — all touch the `viewer` block + Task 1 removes the list-panel undo row; single committer), InboxHub.tsx (Task 1 — deep-link effect; NEW file-coupled write), HubTabBody.tsx (Tasks 5, 6 — 5 wires new bodies + `activeItem`, 6 tests; Task 1 only changes the `homeContent` VALUE from HubShell, not this file), HubTabStrip.tsx (Task 3b), useHubTabs.ts (read-only in Task 3b test), ask-founder-tool.ts (Tasks 7, 8), hub.ts validators + index.ts (Task 7). DELETED: HubViewer.tsx (Task 2), HubHomeTab.tsx + HubHomeTab.test.tsx (Task 1). Disjoint/parallel-safe: the eight new `viewers/*.tsx` component files (Task 5 Step 4), the new `HubActionBar.tsx` (Task 3), and the new test files (HubActionBar/HubTabStrip/useHubTabs/HubViewers).
