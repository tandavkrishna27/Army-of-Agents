# Commander Phase 1 — Right-side Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the Commander viewer's hand-rolled pointer-drag divider with `react-resizable-panels` so chat + detail(viewer) resize as a proper panel group, with **globally-persisted** width + collapse — establishing the composition that Phase 3's cockpit slots into.

**Architecture:** Mirror `WorkspaceLayout` precisely (lowest-risk, proven). On **desktop**, `AgentPanelContent` renders a `<Group orientation="horizontal">` containing `Panel(chat)` and — when expanded — a `Separator` + `Panel(detail)`; when **collapsed**, the detail Panel unmounts (exactly like Workspace's conditional preview panel) and a fixed `w-9` rail renders as a sibling. Width persists via `useDefaultLayout({ id: "aoa:commander:panel-sizes" })`; collapse persists via a new global hook. The viewer's per-conversation `expanded` flag stays as the **auto-open signal** and is bridged to the global collapse. **Mobile (pill + Sheet + sessions drawer) is unchanged this phase** (tab-bar deferred to Phase 3, per the locked decision).

**Tech Stack:** React + Tailwind v4; `react-resizable-panels@^4.9.0` (`Group`/`Panel`/`Separator`/`useDefaultLayout`) — already a dependency, used by `WorkspaceLayout` + `MemoryExplorer`.

**Scope decisions (locked with the founder):**
- Sessions sidebar: **unchanged** — stays the fixed-width card outside the resize group.
- Mobile: **unchanged** — keep the floating pill + Sheet + drawer; tab bar is Phase 3.
- The responsive "protect the chat" cap (only one of detail/cockpit expanded below ultrawide) is a **Phase 3 concern** — Phase 1 has only one right panel, so there's nothing to arbitrate yet. We just set a generous chat `minSize`.

**Persistence model (the P1 §2#4 "no storage" rule is for CONTENT, not GEOMETRY):**
- **Geometry → global, persisted (new):** chat/detail split (`useDefaultLayout`, localStorage `aoa:commander:panel-sizes`) + collapse (`useCommanderViewerCollapsed`, localStorage `aoa:commander:viewer-collapsed`). One personal layout across reloads + all chats.
- **Content → per-conversation, page-lifetime (unchanged):** which tabs are open + `activeId` stay in `useCommanderViewer`'s `statesRef`.

**Testid / label contract (the e2e in `tests/e2e/commander-viewer.spec.ts` depends on these — DO NOT change):**
`commander-viewer-rail` (collapsed rail root) · `commander-viewer-panel` (expanded detail card root) · `commander-viewer-pill` · `commander-viewer-tabs` (ViewerTabs header) · button labels "Expand viewer", "Close viewer" (ViewerTabs collapse), "Viewer home".

**Verified anchors (read before editing):**
- `ui/src/pages/Commander.tsx:69` row (`COMMANDER_PANEL_ROW`), `:80-88` the `flex-1` wrapper + `<AgentPanelContent enableViewerPanel cardChrome>`. **Sessions stays as-is (`:71-78` desktop, `:92-103` drawer).**
- `ui/src/components/InternalAgentPanel.tsx`: `:412` `useBreakpoint()` (`useDrawerSessions`), `:413` `useCommanderViewer`, `:930-1352` `chatColumn`, `:1354-1366` the flex-row return + `<CommanderViewerPanel>` invocation.
- `ui/src/components/commander/viewer/CommanderViewerPanel.tsx`: `:19-21` width consts, `:178-279` `DesktopPanel` (hand-rolled divider `:189-224`, `:249-255` divider div, width plumbing), `:290-343` `DesktopRail`, `:439-531` `CommanderViewerPanel` (mobile branch `:465-513`, desktop branch `:516-530`).
- `ui/src/components/commander/viewer/useCommanderViewer.ts:84-85` `expand`/`collapse`.
- `ui/src/components/commander/viewer/commanderViewerModel.ts:98-100` `setExpanded` (leave the model UNCHANGED — `expanded` stays the per-conversation signal).
- Reference recipe: `ui/src/components/workspace/WorkspaceLayout.tsx:64-68` `useDefaultLayout`; `:452-522` Group/Panel/Separator (note the **conditional** preview panel `:493-521`); `:495-499` Separator classes.
- Persistence-hook pattern: `ui/src/components/workspace/useSidebarCollapsed.ts` (whole file) + its test `ui/src/__tests__/useSidebarCollapsed.test.ts`.
- Test mock pattern for the lib: `ui/src/__tests__/WorkspaceMobile.test.tsx:43-48`.

---

## Task 1: Global collapse-persistence hook

**Files:**
- Create: `ui/src/components/commander/useCommanderViewerCollapsed.ts`
- Create: `ui/src/components/commander/useCommanderViewerCollapsed.test.ts`

- [ ] **Step 1: Write the failing test** (mirrors `useSidebarCollapsed.test.ts`)

```ts
// ui/src/components/commander/useCommanderViewerCollapsed.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  commanderViewerCollapsedKey,
  useCommanderViewerCollapsed,
} from "./useCommanderViewerCollapsed";

describe("useCommanderViewerCollapsed", () => {
  beforeEach(() => localStorage.clear());

  it("uses one global key (no conversation id)", () => {
    expect(commanderViewerCollapsedKey()).toBe("aoa:commander:viewer-collapsed");
  });

  it("defaults to true (collapsed) when nothing stored", () => {
    const { result } = renderHook(() => useCommanderViewerCollapsed());
    expect(result.current[0]).toBe(true);
  });

  it("reads 'false' from localStorage as expanded", () => {
    localStorage.setItem("aoa:commander:viewer-collapsed", "false");
    const { result } = renderHook(() => useCommanderViewerCollapsed());
    expect(result.current[0]).toBe(false);
  });

  it("persists to the global key when set", () => {
    const { result } = renderHook(() => useCommanderViewerCollapsed());
    act(() => result.current[1](false));
    expect(localStorage.getItem("aoa:commander:viewer-collapsed")).toBe("false");
    expect(result.current[0]).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module not found)
Run: `cd ui ; pnpm vitest run src/components/commander/useCommanderViewerCollapsed.test.ts`

- [ ] **Step 3: Implement** (default `true` = collapsed, matching today's `emptyViewerState().expanded === false` desktop default)

```ts
// ui/src/components/commander/useCommanderViewerCollapsed.ts
import { useCallback, useEffect, useState } from "react";

/** One personal layout across reloads + all chats (Phase 1 geometry persistence). */
export function commanderViewerCollapsedKey(): string {
  return "aoa:commander:viewer-collapsed";
}

function loadCollapsed(): boolean {
  try {
    const v = localStorage.getItem(commanderViewerCollapsedKey());
    return v === null ? true : v === "true"; // default collapsed
  } catch {
    return true;
  }
}

/** Global (per-user) collapse state for the Commander detail/viewer panel. */
export function useCommanderViewerCollapsed(): readonly [boolean, (value: boolean) => void] {
  const [collapsed, setState] = useState<boolean>(() => loadCollapsed());

  // Cross-tab / late-hydration sync (cheap; mirrors useSidebarCollapsed intent).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === commanderViewerCollapsedKey()) setState(loadCollapsed());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setCollapsed = useCallback((value: boolean) => {
    setState(value);
    try {
      localStorage.setItem(commanderViewerCollapsedKey(), String(value));
    } catch {
      // ignore
    }
  }, []);

  return [collapsed, setCollapsed] as const;
}
```

- [ ] **Step 4: Run it — expect PASS.** Then commit:
```bash
git add ui/src/components/commander/useCommanderViewerCollapsed.ts ui/src/components/commander/useCommanderViewerCollapsed.test.ts
git commit -m "feat(commander): global viewer-collapse persistence hook (Phase 1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Refactor CommanderViewerPanel — split desktop into rail + detail content; drop hand-rolled resize

**Files:**
- Modify: `ui/src/components/commander/viewer/CommanderViewerPanel.tsx`

**Why:** the Group + width now live in `AgentPanelContent` (Task 3). This file stops owning desktop width/divider/expanded-branching; it exposes two desktop pieces (`CommanderViewerRail`, `CommanderViewerDetail`) that the Group composes, and keeps `CommanderViewerPanel` as the **mobile-only** pill+Sheet. The collapse buttons call injected handlers (the global bridge), not `viewer.expand/collapse` directly.

- [ ] **Step 1: Delete the hand-rolled width machinery.** Remove the module consts `MIN_WIDTH`, `MAX_WIDTH_FRACTION`, `DEFAULT_WIDTH_FRACTION` (`:19-21`). In `DesktopPanel`, remove: `containerRef`, the entire `onPointerDown` callback (`:189-224`), the `parentWidth`/`resolvedWidth` calc (`:227-231`), the `width`/`onWidthChange` props, the wrapper `style={{ width }}`, and the divider `<div role="separator" … -left-1 …>` (`:249-255`).

- [ ] **Step 2: Rename `DesktopPanel` → exported `CommanderViewerDetail`; it renders only the card body** (the Panel parent owns width). Add an `onCollapse` prop for the tabs collapse button.

```tsx
export interface CommanderViewerDetailProps {
  viewer: CommanderViewerApi;
  companyId: string;
  conversationRefs: CommanderOutputRef[];
  activeTab: ViewerTab | undefined;
  tabModels: ViewerTabModel[];
  /** Global bridge: collapse the panel (persists) — wired by AgentPanelContent. */
  onCollapse: () => void;
}

export function CommanderViewerDetail({
  viewer, companyId, conversationRefs, activeTab, tabModels, onCollapse,
}: CommanderViewerDetailProps) {
  const state = viewer.state;
  const activeKey = {
    id: state.activeId,
    kind: state.activeId === "home" ? "home" : (activeTab?.kind ?? "home"),
  };
  return (
    <div
      data-testid="commander-viewer-panel"
      className={cn("relative flex h-full min-w-0 flex-1 flex-col", COMMANDER_PANEL_CARD)}
    >
      <ViewerTabs
        tabs={tabModels}
        activeKey={activeKey}
        onActivate={(tab) => viewer.activate(tab.id)}
        onClose={(tab) => viewer.close(tab.id)}
        onAdd={() => viewer.activate("home")}
        addLabel="Open viewer home"
        onToggleCollapse={onCollapse}
        headerTestId="commander-viewer-tabs"
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <TabBodySwitch
          activeId={state.activeId}
          activeTab={activeTab}
          companyId={companyId}
          conversationRefs={conversationRefs}
          onOpen={viewer.openRef}
        />
      </div>
    </div>
  );
}
```
(Note: `data-testid="commander-viewer-panel"` stays on this card; `onToggleCollapse` now calls `onCollapse` (the bridge) instead of `viewer.collapse`.)

- [ ] **Step 3: Rename `DesktopRail` → exported `CommanderViewerRail`; add `onExpand` prop** so the rail buttons drive the global bridge. Keep `w-9 … py-2` and all icons.

```tsx
export interface CommanderViewerRailProps {
  viewer: CommanderViewerApi;
  tabModels: ViewerTabModel[];
  /** Global bridge: expand the panel (persists) — wired by AgentPanelContent. */
  onExpand: () => void;
}

export function CommanderViewerRail({ viewer, tabModels, onExpand }: CommanderViewerRailProps) {
  return (
    <div
      data-testid="commander-viewer-rail"
      className={cn("flex h-full w-9 shrink-0 flex-col items-center gap-1 py-2", COMMANDER_PANEL_CARD)}
    >
      <button type="button" title="Expand viewer" aria-label="Expand viewer" onClick={onExpand}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground">
        <ChevronsLeft className="size-3.5" aria-hidden />
      </button>
      <button type="button" title="Viewer home" aria-label="Viewer home"
        onClick={() => { onExpand(); viewer.activate("home"); }}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground">
        <Home className="size-3.5" aria-hidden />
      </button>
      {tabModels.filter((t) => t.id !== "home").map((t) => {
        const Icon = t.icon ?? FileText;
        return (
          <button key={t.id} type="button" title={t.title} aria-label={t.title}
            onClick={() => { onExpand(); viewer.activate(t.id); }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground">
            <Icon className="size-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Reduce `CommanderViewerPanel` to mobile-only.** Keep `tabModels` derivation; the desktop branch (`:516-530`) is **removed** (now in AgentPanelContent). Keep the mobile branch verbatim (pill + Sheet). The `isMobile` prop stays; when called it is always mobile (AgentPanelContent only renders it on mobile), but keep the guard for safety.

```tsx
export interface CommanderViewerPanelProps {
  viewer: CommanderViewerApi;
  companyId: string;
  conversationRefs: CommanderOutputRef[];
  isMobile: boolean;
}

export function CommanderViewerPanel({ viewer, companyId, conversationRefs, isMobile }: CommanderViewerPanelProps) {
  const state = viewer.state;
  const activeTab = state.tabs.find((t) => t.id === state.activeId);
  const tabModels: ViewerTabModel[] = [
    { id: "home", kind: "home", title: "Home", icon: Home, closeable: false },
    ...state.tabs.map((t): ViewerTabModel => ({
      id: t.id, kind: t.kind, title: t.title,
      icon: t.kind === "browser" ? Globe : FileText,
    })),
  ];
  if (!isMobile) return null; // desktop is composed by AgentPanelContent's Group
  // ---------- Mobile (UNCHANGED pill + Sheet) ----------
  const activeKey = { id: state.activeId, kind: state.activeId === "home" ? "home" : (activeTab?.kind ?? "home") };
  return (
    <>
      <MobilePill viewer={viewer} />
      <Sheet open={state.expanded} onOpenChange={(open) => { if (!open) viewer.collapse(); }}>
        {/* …existing SheetContent body verbatim… */}
      </Sheet>
    </>
  );
}
```
(`tabModels` is also needed by the desktop pieces — export a small helper `buildTabModels(state)` and reuse it in AgentPanelContent, OR have AgentPanelContent build it. Add: `export function buildViewerTabModels(state: ConversationViewerState): ViewerTabModel[]` and call it here + in Task 3.)

- [ ] **Step 5: Re-export the new pieces from the barrel** (Codex note: `InternalAgentPanel.tsx:52-58` imports the viewer from `./commander/viewer`, NOT the file). Update `ui/src/components/commander/viewer/index.ts` line 1 to:
```ts
export {
  CommanderViewerPanel,
  CommanderViewerRail,
  CommanderViewerDetail,
  buildViewerTabModels,
} from "./CommanderViewerPanel";
```
(leave the `OutputRefChips`/`useCommanderViewer`/`commanderViewerModel` export lines unchanged.)

- [ ] **Step 6: typecheck + commit**
```bash
cd ui ; pnpm tsc -b
git add ui/src/components/commander/viewer/CommanderViewerPanel.tsx ui/src/components/commander/viewer/index.ts
git commit -m "refactor(commander): split viewer into Rail/Detail pieces; drop hand-rolled resize (Phase 1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Restructure AgentPanelContent desktop into a resizable Group + wire persistence + collapse bridge

**Files:**
- Modify: `ui/src/components/InternalAgentPanel.tsx`

- [ ] **Step 1: Imports** — two new lines + EXTEND the existing viewer barrel import (`:52-58`):
```ts
// New:
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useCommanderViewerCollapsed } from "./commander/useCommanderViewerCollapsed";

// EXTEND the existing import block at InternalAgentPanel.tsx:52-58 — add the 3 new pieces:
import {
  CommanderViewerPanel,        // existing (now mobile-only)
  CommanderViewerRail,         // new
  CommanderViewerDetail,       // new
  buildViewerTabModels,        // new
  OutputRefChips,              // existing
  collectConversationRefs,     // existing
  mergeRefs,                   // existing
  useCommanderViewer,          // existing
} from "./commander/viewer";
```

- [ ] **Step 2: Hooks + bridge** — inside `AgentPanelContent`, after `const viewer = useCommanderViewer(...)` (`:413`):
```ts
const { defaultLayout, onLayoutChanged } = useDefaultLayout({
  id: "aoa:commander:panel-sizes",
  storage: localStorage,
  panelIds: ["commander-chat", "commander-detail"],
});
const [viewerCollapsed, setViewerCollapsed] = useCommanderViewerCollapsed();

const expandViewer = useCallback(() => { setViewerCollapsed(false); viewer.expand(); }, [setViewerCollapsed, viewer]);
const collapseViewer = useCallback(() => { setViewerCollapsed(true); viewer.collapse(); }, [setViewerCollapsed, viewer]);

// Bridge: auto-open / chip-click / tab-activate set state.expanded=true → expand the
// persisted panel. Loop-free: once collapsed flips false the guard `&& viewerCollapsed`
// stops it. collapseViewer() sets state.expanded=false so the NEXT created ref re-fires.
useEffect(() => {
  if (viewer.state.expanded && viewerCollapsed) setViewerCollapsed(false);
}, [viewer.state.expanded, viewerCollapsed, setViewerCollapsed]);
```
(`useCallback`/`useEffect` are already imported in this file — confirm.)

- [ ] **Step 3: Replace the flex-row return** (`:1354-1366`). Three branches: no-viewer (docked, unchanged), mobile (unchanged), desktop (new Group).

```tsx
// No viewer panel (docked usage) — unchanged single column.
if (!enableViewerPanel || !companyId) {
  return <div className="flex h-full min-h-0 flex-row overflow-hidden">{chatColumn}</div>;
}

// Mobile — unchanged: chat + floating pill/Sheet (no Group).
if (useDrawerSessions) {
  return (
    <div className="flex h-full min-h-0 flex-row overflow-hidden">
      {chatColumn}
      <CommanderViewerPanel companyId={companyId} viewer={viewer} conversationRefs={conversationRefs} isMobile />
    </div>
  );
}

// Desktop — resizable Group (chat | detail), or chat + rail when collapsed.
const tabModels = buildViewerTabModels(viewer.state);
const activeTab = viewer.state.tabs.find((t) => t.id === viewer.state.activeId);
return (
  <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden gap-2">
    <Group
      orientation="horizontal"
      className="flex h-full min-w-0 flex-1 overflow-hidden"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      data-testid="commander-center-group"
    >
      <Panel id="commander-chat" minSize="40%" className="flex h-full min-w-0 flex-col overflow-hidden">
        {chatColumn}
      </Panel>
      {!viewerCollapsed && (
        <>
          <Separator
            id="commander-sep"
            className="w-2 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-brand/30 active:bg-brand/50"
            data-testid="commander-resizable-handle"
          />
          <Panel
            id="commander-detail"
            defaultSize="40%"
            minSize="24%"
            maxSize="60%"
            className="flex h-full min-w-0 overflow-hidden"
          >
            <CommanderViewerDetail
              viewer={viewer}
              companyId={companyId}
              conversationRefs={conversationRefs}
              activeTab={activeTab}
              tabModels={tabModels}
              onCollapse={collapseViewer}
            />
          </Panel>
        </>
      )}
    </Group>
    {viewerCollapsed && (
      <CommanderViewerRail viewer={viewer} tabModels={tabModels} onExpand={expandViewer} />
    )}
  </div>
);
```

**Notes for the implementer:**
- The outer wrapper's `gap-2` spaces the Group from the collapsed rail (8px, matching the sessions↔chat gap from `COMMANDER_PANEL_ROW`). When expanded, the chat↔detail gap is the `w-2` (8px) Separator. The Separator/rail show the `bg-muted/30` backdrop from the Commander row (this wrapper is transparent). **Verify the gaps read uniform in the visual gate.**
- `chatColumn` keeps its `cardChrome` card + `flex-1`; inside `Panel(flex flex-col)` the `flex-1` fills the panel height. The `min-w-0 flex-1` on chatColumn is harmless (Panel owns width). Leave `chatColumn` as-is.
- Conditional detail Panel mirrors Workspace's conditional preview (`WorkspaceLayout.tsx:493-521`); `panelIds` lists both so `useDefaultLayout` restores correctly when the detail toggles in/out.

- [ ] **Step 4: typecheck + commit**
```bash
cd ui ; pnpm tsc -b
git add ui/src/components/InternalAgentPanel.tsx
git commit -m "feat(commander): resizable chat|detail Group + persisted geometry + collapse bridge (Phase 1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Tests — component mocks + persistence e2e

**Files:**
- Modify (if present): existing `InternalAgentPanel`/`Commander` component tests that now mount the lib.
- Create: `tests/e2e/commander-viewer-persistence.spec.ts`

- [ ] **Step 1: Guard component tests against the real lib.** Grep `ui/src/__tests__` + `ui/src/components/**/__tests__` for tests that render `AgentPanelContent`/`Commander`. If any mount the desktop viewer, add the mock (copy `WorkspaceMobile.test.tsx:43-48`):
```ts
vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: any) => <div data-testid="resizable-group">{children}</div>,
  Panel: ({ children, ...p }: any) => <div data-testid={p["data-testid"]}>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: () => {} }),
}));
```
Run the existing unit suite to confirm green:
`cd ui ; pnpm vitest run src/components/commander/ src/components/InternalAgentPanel.outputRefs.test.tsx`

- [ ] **Step 2: New e2e — geometry survives reload.** Reuse the harness + helpers from `commander-viewer.spec.ts`.
```ts
import { test, expect } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

test.describe("Commander viewer geometry persistence", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdGeom-/);
  });

  test("collapse + width persist across reload (global, per-user)", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-CmdGeom-${Date.now()}`);
    await page.goto(`/${company.issuePrefix}/commander`);

    // Default = collapsed rail.
    await expect(page.getByTestId("commander-viewer-rail")).toBeVisible({ timeout: 20_000 });

    // Expand via the rail; the detail card appears and the resize handle is present.
    await page.getByRole("button", { name: "Viewer home" }).click();
    await expect(page.getByTestId("commander-viewer-panel")).toBeVisible();
    await expect(page.getByTestId("commander-resizable-handle")).toBeVisible();

    // Drag the handle to widen the detail panel.
    const handle = page.getByTestId("commander-resizable-handle");
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 160, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
    }
    const widthBefore = await page.getByTestId("commander-viewer-panel").evaluate((el) => el.clientWidth);

    // Reload: expanded state + width restored from localStorage.
    await page.reload();
    await expect(page.getByTestId("commander-viewer-panel")).toBeVisible({ timeout: 20_000 });
    const widthAfter = await page.getByTestId("commander-viewer-panel").evaluate((el) => el.clientWidth);
    expect(Math.abs(widthAfter - widthBefore)).toBeLessThanOrEqual(8); // within a px or two

    // Collapse persists too.
    await page.getByRole("button", { name: "Close viewer" }).click();
    await expect(page.getByTestId("commander-viewer-rail")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("commander-viewer-rail")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0);
  });
});
```

- [ ] **Step 3: Commit**
```bash
git add ui tests/e2e/commander-viewer-persistence.spec.ts
git commit -m "test(commander): persistence e2e + lib mocks for Phase 1 composition

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full verification (the gate)

- [ ] **Step 1: Static** — from repo root: `cd ui ; pnpm tsc -b` (clean for touched files) and `cd ui ; pnpm vitest run src/components/commander/` (green).

- [ ] **Step 2: e2e regression + new** — start pgvector (Windows: external `DATABASE_URL`, an unreserved port e.g. 5433) and run BOTH the existing viewer e2e and the new persistence e2e against it. They are the real safety net for the collapse bridge (auto-open, chips, history, close/expand) + persistence:
```bash
# pgvector up on 127.0.0.1:5433 (db aoa, vector extension created)
cd <AoA-commander>
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5433/aoa"
export AOA_E2E_PORT=3221
pnpm exec playwright test tests/e2e/commander-viewer.spec.ts tests/e2e/commander-viewer-persistence.spec.ts --config=tests/e2e/playwright.config.ts --reporter=list
```
Expected: existing 3 tests still pass (no behavioral regression) + the new persistence test passes.

- [ ] **Step 2b: Live screenshots** (visual gate, mirroring Phase 0) — capture: desktop default (sessions + chat + rail), expanded (chat | drag-handle | detail), after a real handle drag (width changed), reload (geometry restored), mobile (pill+Sheet still works). Read the PNGs and confirm: uniform 8px gaps; the resize handle lives in the gap and drags; chat never starved (respects `minSize 40%`); collapsed rail is the slim `w-9` card; mobile unchanged.

- [ ] **Step 3:** Tear down the throwaway DB/screenshots. Confirm a clean tree (only the Phase 1 commits). Do NOT run `finishing-a-development-branch` (Phases 2-3 remain on this branch).

---

## Self-review (run after drafting; fix inline)

- **Spec coverage (§3):** library adoption ✅ (Task 3); viewer divider migration ✅ (Task 2 removes hand-rolled, Task 3 adds Separator); global persistence ✅ (Tasks 1+3); mobile unchanged ✅ (locked decision); responsive cap → deferred to Phase 3 with a generous `minSize` ✅; auto-expand arbitration → the `state.expanded → setViewerCollapsed(false)` bridge ✅.
- **Testid/label contract preserved:** `commander-viewer-rail`, `commander-viewer-panel`, `commander-viewer-pill`, `commander-viewer-tabs`, "Expand viewer"/"Close viewer"/"Viewer home" — all retained. New: `commander-center-group`, `commander-resizable-handle`.
- **No model change:** `commanderViewerModel.ts` untouched (`expanded` stays the per-conversation signal); only geometry is lifted to global hooks. Tab CONTENT stays page-lifetime (P1 §2#4 honored).
- **Loop-free bridge:** the `&& viewerCollapsed` guard + `collapseViewer()` resetting `state.expanded` prevent an expand/collapse ping-pong (re-checked).
- **Type consistency:** `buildViewerTabModels` defined in Task 2, used in Tasks 2+3; `CommanderViewerRail`/`CommanderViewerDetail` props match call sites; `useDefaultLayout` `panelIds` match the two `Panel id`s.
- **Risk note for reviewers:** Tasks 2+3 are one interlocking refactor — build them together; the e2e in Task 5 (existing + new) is the correctness gate, the visual check confirms the gaps/handle.
