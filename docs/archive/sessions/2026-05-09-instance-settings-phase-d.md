# Instance Settings → LobbyShell — Phase D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `InstanceSettingsPage` from its custom chrome (back-arrow header + Settings icon + horizontal `PageTabBar`) to the shared `LobbyShell` (auto-collapsed primary sidebar) with the existing `SecondarySidebar` composite replacing the tab bar. Each of the 7 settings sections becomes a sidebar item; click handlers continue to update the existing `?tab=` URL query param so deep links keep working.

**Architecture:** UI-only chrome migration. No schema, no API, no routing changes (the `/instance/settings?tab=X` URL contract is preserved verbatim — `?tab=` is still the source of truth). Reuses the existing `SecondarySidebar` (`ui/src/components/SecondarySidebar.tsx`, 107 LOC, already at 200px expanded / 48px collapsed) and the Phase A `LobbyShell` chrome (`defaultCollapsed` prop already designed for this exact use case). The 7 tab content components (PrivacyTab, BackupsTab, HeartbeatsTab, plus the inline General/Experimental/Plugins panels) are preserved unchanged. The `Access` section continues to navigate to its standalone page at `/instance/access` — same as today.

**Tech Stack:** React, react-router-dom (`useSearchParams`, `useNavigate`), TailwindCSS, lucide-react (`Settings`, `Shield`, `Activity`, `Database`, `Lock`, `Puzzle`, `FlaskConical`), Phase A primitives (`LobbyShell`, `LobbyShellMobileMenuButton`), the existing `SecondarySidebar` (`SecondarySidebarSection[]` items API).

**Spec:** Phase A discussion thread on 2026-05-08 — "auto-collapse primary lobby sidebar when entering Settings; show secondary sidebar prominently. Secondary at 200px with heading at top:36px (aligned with main content padding). 7 tabs become sidebar items." Out-of-scope deferrals from prior summaries: per-tab nested routes (e.g. `/instance/settings/privacy`) and embedding the Access page as a tab panel — both intentionally deferred.

---

## Files

| Action | Path | What changes |
|--------|------|--------------|
| Modify | `ui/src/pages/InstanceSettingsPage.tsx` | Wrap in `LobbyShell` with `defaultCollapsed={true}`; remove the custom header; replace `<PageTabBar>` with `<SecondarySidebar>` inside a 2-column flex layout (sidebar + main content) |
| Modify | `ui/src/__tests__/InstanceSettingsPage-signout.test.tsx` | Update mocks (drop the `PageTabBar` mock, add `LobbySidebar` + `Sheet` + `SecondarySidebar` stubs); existing 3 sign-out tests still pass |

**Total:** 2 modified, 0 created, 0 deleted. The `SecondarySidebar` component already exists. `PageTabBar` stays in the codebase (used in 10 other pages — only `InstanceSettingsPage` migrates).

---

## Verification rules (apply to every task)

1. **TDD order** — failing test first, see it fail with the right error, implement, see it pass, commit.
2. **Per-task scoped tests** before commit (`pnpm vitest run src/__tests__/InstanceSettingsPage-signout.test.tsx`); **broader UI suite** at end of each task.
3. **Conventional commits**: `feat(ui):`, `refactor(ui):`, `test(ui):`, `chore(ui):`.
4. **Typecheck after each task** — `pnpm exec tsc --noEmit` from `ui/`.
5. **Reuse existing primitives**: `LobbyShell`, `LobbyShellMobileMenuButton`, `SecondarySidebar`. Don't recreate or fork.
6. **Preserve URL contract.** `?tab=privacy` continues to load the Privacy tab. The `Access` sidebar item navigates to `/instance/access` (same behavior as today's Access tab click).
7. **No backend or API client changes.** Every existing tab component (`PrivacyTab`, `BackupsTab`, `HeartbeatsTab`, plus the inline `General`/`Experimental`/`Plugins` content) is preserved verbatim.

---

## Task 1: Wrap `InstanceSettingsPage` in LobbyShell (chrome swap)

**Files:**
- Modify: `ui/src/pages/InstanceSettingsPage.tsx`
- Modify: `ui/src/__tests__/InstanceSettingsPage-signout.test.tsx`

This task does **only** the chrome swap. `PageTabBar` stays for now (Task 2 replaces it). The custom header (back arrow + Settings icon + "Instance Settings" title row, lines ~118–145 of the current file) is removed because `LobbyShell`'s sidebar already gives the user navigation context.

- [ ] **Step 1: Add the failing test in `InstanceSettingsPage-signout.test.tsx`**

In `ui/src/__tests__/InstanceSettingsPage-signout.test.tsx`, locate the existing `vi.mock` block. Add three new mocks for the LobbyShell chrome (place near the other `vi.mock` calls, before the `describe` block):

```tsx
vi.mock("@/components/LobbySidebar", () => ({
  LobbySidebar: () => <aside data-testid="lobby-sidebar" />,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/UserMenu", () => ({ UserMenu: () => <div /> }));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: vi.fn() }),
}));
```

Append a single new test inside the existing `describe("InstanceSettingsPage sign-out", ...)` block (or whatever the existing describe block is named — adapt to the exact name in the current file):

```tsx
  it("renders inside LobbyShell with settings active", () => {
    // Use whatever render helper the existing tests use (probably renderWithProviders).
    // Mount the page and assert the sidebar testid appears at least once.
    renderWithProviders(<InstanceSettingsPage />);
    expect(screen.getAllByTestId("lobby-sidebar").length).toBeGreaterThanOrEqual(1);
  });
```

If the existing test file uses a custom render helper (e.g., a local `renderPage()` function instead of `renderWithProviders`), follow that convention.

- [ ] **Step 2: Run test to verify it fails**

Run from `ui/`: `pnpm vitest run src/__tests__/InstanceSettingsPage-signout.test.tsx`
Expected: the new "renders inside LobbyShell" test FAILS — `lobby-sidebar` testid not found (the page still renders its custom header).

- [ ] **Step 3: Modify `InstanceSettingsPage.tsx` chrome**

Edit `ui/src/pages/InstanceSettingsPage.tsx`:

1. **Add imports** at the top (alongside the existing imports):

```tsx
import { LobbyShell, LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { useDialog } from "@/context/DialogContext";
```

(Remove the `ArrowLeft` lucide-react import if it's no longer used after the custom header is dropped — re-grep to confirm.)

2. **Inside the `InstanceSettingsPage` function**, after the existing hook calls (`useSearchParams`, `useQuery` for general/experimental settings, etc.), add:

```tsx
  const { openOnboarding } = useDialog();
```

3. **Replace the outermost wrapper `<div>` and the custom header** (currently lines ~118–145) with `LobbyShell`. The page's existing return statement opens with something like:

```tsx
return (
  <div className="flex h-dvh flex-col">
    <header className="border-b ...">
      <button onClick={() => navigate(-1)}> <ArrowLeft /> </button>
      <Settings className="..." /> <h1>Instance Settings</h1>
      ...
    </header>
    <main className="flex-1 overflow-auto ...">
      <PageTabBar items={...} value={activeTab} onValueChange={...} />
      <Tabs value={activeTab} ...>
        <TabsContent value="general"> ... </TabsContent>
        ...
      </Tabs>
    </main>
  </div>
);
```

Replace the outer wrapper with:

```tsx
return (
  <LobbyShell activeItem="settings" defaultCollapsed onCreateCompany={() => openOnboarding()}>
    <div className="mx-auto w-full max-w-[1080px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
      <LobbyShellMobileMenuButton className="mb-4" />

      {/* Page heading — short, no back button (sidebar handles navigation) */}
      <div className="mb-5">
        <h1 className="text-[1.55rem] font-bold tracking-tight">
          Instance settings<span className="text-brand">.</span>
        </h1>
      </div>

      {/* Tab nav (Task 2 replaces PageTabBar with SecondarySidebar) */}
      <PageTabBar items={TABS} value={activeTab} onValueChange={handleTabChange} />

      {/* Tab content (preserved verbatim) */}
      <Tabs value={activeTab} className="mt-5">
        <TabsContent value="general"> ... </TabsContent>
        <TabsContent value="privacy"> ... </TabsContent>
        ...
      </Tabs>
    </div>
  </LobbyShell>
);
```

Specific edits:
- Drop the `<header>` block entirely (back button + Settings icon + h1 row). The `<h1>` becomes a smaller heading inside the main content area (matches the lobby/marketplace heading pattern).
- Keep `TABS`, `activeTab`, `handleTabChange`, all `<TabsContent>` blocks, all internal state. **Only the chrome wrapper changes** in this task.
- The `useNavigate` hook still gets used inside `handleTabChange` (for the Access tab redirect). Don't remove it.

- [ ] **Step 4: Run test to verify it passes**

Run from `ui/`: `pnpm vitest run src/__tests__/InstanceSettingsPage-signout.test.tsx`
Expected: all tests pass (existing sign-out tests + the new "renders inside LobbyShell" test).

- [ ] **Step 5: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Run the broader UI suite to confirm no regression**

Run from `ui/`: `pnpm vitest run --reporter=basic 2>&1 | tail -10`
Expected: all 1107 tests pass (Phase C end count) plus 1 new = 1108.

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/InstanceSettingsPage.tsx ui/src/__tests__/InstanceSettingsPage-signout.test.tsx
git commit -m "feat(ui): wrap InstanceSettingsPage in LobbyShell (chrome swap)"
```

---

## Task 2: Replace `PageTabBar` with `SecondarySidebar`

**Files:**
- Modify: `ui/src/pages/InstanceSettingsPage.tsx`
- Modify: `ui/src/__tests__/InstanceSettingsPage-signout.test.tsx`

Replace the horizontal `<PageTabBar>` with the existing `<SecondarySidebar>` placed in a 2-column flex layout: sidebar on the left (200px expanded), tab content on the right.

The 7 settings sections map to one `SecondarySidebarSection` with seven items:

| Tab | Sidebar item | Icon |
|-----|--------------|------|
| general | General | `Settings` (lucide) |
| privacy | Privacy | `Shield` |
| backups | Backups | `Database` |
| heartbeats | Heartbeats | `Activity` |
| experimental | Experimental | `FlaskConical` |
| plugins | Plugins | `Puzzle` |
| access | Access | `Lock` |

`Access`'s click handler does the same thing the existing `handleTabChange("access")` does today — navigate to `/instance/access`. Preserved verbatim, just moved from the tab-bar handler into the sidebar item's `onClick`.

- [ ] **Step 1: Add the failing test (append to existing describe block)**

In `ui/src/__tests__/InstanceSettingsPage-signout.test.tsx`, add a mock for `SecondarySidebar` near the other `vi.mock` calls:

```tsx
vi.mock("@/components/SecondarySidebar", () => ({
  SecondarySidebar: ({ sections }: { sections: Array<{ items: Array<{ id: string; label: string; onClick?: () => void }> }> }) => (
    <aside data-testid="secondary-sidebar">
      {sections.flatMap((s) => s.items).map((item) => (
        <button key={item.id} data-testid={`sidebar-item-${item.id}`} onClick={item.onClick}>
          {item.label}
        </button>
      ))}
    </aside>
  ),
}));
```

Append two new tests to the existing `describe` block:

```tsx
  it("renders SecondarySidebar with all 7 settings sections", () => {
    renderWithProviders(<InstanceSettingsPage />);
    expect(screen.getByTestId("secondary-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-general")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-privacy")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-backups")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-heartbeats")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-experimental")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-plugins")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-access")).toBeInTheDocument();
  });

  it("clicking a non-Access sidebar item updates the ?tab= query param", async () => {
    const user = userEvent.setup();
    renderWithProviders(<InstanceSettingsPage />, { initialEntries: ["/instance/settings"] });
    await user.click(screen.getByTestId("sidebar-item-privacy"));
    // The page should now have ?tab=privacy in its URL or active state.
    // Assert by checking that the Privacy tab content is visible (or the URL search has tab=privacy).
    // The exact assertion depends on how the existing tests verify active tab — match the pattern.
    expect(window.location.search.includes("tab=privacy") || screen.queryByText(/privacy/i)).toBeTruthy();
  });
```

(The second test is intentionally lenient — different existing test setups verify active tab differently. Adapt the assertion to whatever pattern the file already uses for tab-state verification, or skip the URL-checking part if `MemoryRouter` doesn't update `window.location`.)

- [ ] **Step 2: Run test to verify it fails**

Run from `ui/`: `pnpm vitest run src/__tests__/InstanceSettingsPage-signout.test.tsx`
Expected: 2 new tests FAIL — `secondary-sidebar` testid not found.

- [ ] **Step 3: Replace `PageTabBar` with `SecondarySidebar` in `InstanceSettingsPage.tsx`**

Edits to make:

1. **Add imports** at the top:

```tsx
import {
  Activity,
  Database,
  FlaskConical,
  Lock,
  Puzzle,
  Settings as SettingsIcon,
  Shield,
} from "lucide-react";
import { SecondarySidebar, type SecondarySidebarSection } from "@/components/SecondarySidebar";
```

(`SettingsIcon` aliased to avoid collision with the existing `Settings` import at the top of the file. If `Settings` from lucide-react is imported elsewhere in the file already, adapt — alias it consistently.)

2. **Remove** the `PageTabBar` import. Remove the existing `TABS` constant if it's only consumed by `PageTabBar` — replace with the inline sidebar `sections` array below.

3. **Inside the component**, immediately above the `return` statement, construct the sidebar sections:

```tsx
  const settingsSections: SecondarySidebarSection[] = useMemo(() => {
    const items = [
      { key: "general", label: "General", icon: <SettingsIcon className="size-4" /> },
      { key: "privacy", label: "Privacy", icon: <Shield className="size-4" /> },
      { key: "backups", label: "Backups", icon: <Database className="size-4" /> },
      { key: "heartbeats", label: "Heartbeats", icon: <Activity className="size-4" /> },
      { key: "experimental", label: "Experimental", icon: <FlaskConical className="size-4" /> },
      { key: "plugins", label: "Plugins", icon: <Puzzle className="size-4" /> },
      { key: "access", label: "Access", icon: <Lock className="size-4" /> },
    ];
    return [
      {
        title: "Settings",
        items: items.map((item) => ({
          id: item.key,
          label: item.label,
          icon: item.icon,
          active: activeTab === item.key,
          onClick: () => handleTabChange(item.key),
        })),
      },
    ];
  }, [activeTab, handleTabChange]);
```

(If `useMemo` isn't already imported, add `import { useMemo } from "react";`.)

4. **In the JSX**, replace the `<PageTabBar items={TABS} ... />` line with the new layout:

```tsx
      {/* Tab nav: secondary sidebar + main content in a 2-column layout */}
      <div className="flex gap-6 mt-5">
        <SecondarySidebar sections={settingsSections} className="shrink-0" />
        <div className="flex-1 min-w-0">
          <Tabs value={activeTab}>
            <TabsContent value="general"> ... </TabsContent>
            ...all existing TabsContent blocks unchanged...
          </Tabs>
        </div>
      </div>
```

The outer `<div className="mx-auto w-full max-w-[1080px] ...">` (added in Task 1) stays as the page-padding container. Replace its inner `<PageTabBar>` + `<Tabs>` block with the 2-column flex above.

5. **Verify `handleTabChange` still works correctly** — the existing function (lines ~38–51 of the pre-Task-1 file) updates `?tab=` for non-Access tabs and navigates to `/instance/access` for the Access tab. No code change needed in that handler — the sidebar item's `onClick` calls it the same way `PageTabBar`'s `onValueChange` did.

- [ ] **Step 4: Run test to verify it passes**

Run from `ui/`: `pnpm vitest run src/__tests__/InstanceSettingsPage-signout.test.tsx`
Expected: all tests pass (existing + the 2 new sidebar tests + the Task 1 LobbyShell test).

- [ ] **Step 5: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Run the broader UI suite to confirm no regression**

Run from `ui/`: `pnpm vitest run --reporter=basic 2>&1 | tail -10`
Expected: all 1110 tests pass (1107 Phase C + 1 LobbyShell + 2 sidebar = 1110).

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/InstanceSettingsPage.tsx ui/src/__tests__/InstanceSettingsPage-signout.test.tsx
git commit -m "feat(ui): replace PageTabBar with SecondarySidebar on InstanceSettingsPage"
```

---

## Task 3: Final verification + browser smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full UI test suite**

Run from `ui/`: `pnpm vitest run --reporter=basic 2>&1 | tail -10`
Expected: 1110 passing.

- [ ] **Step 2: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Browser smoke — settings page visual + navigation**

Confirm the dev server (`ui` on port 5173 / `app` on port 3101) is running. Navigate the preview browser to `/instance/settings`. Verify:

1. Primary sidebar is **auto-collapsed to 56px** (icons-only). Settings icon is highlighted (active state).
2. Secondary sidebar at **200px** to the right of the primary, with a "Settings" heading at the top + 7 items (General, Privacy, Backups, Heartbeats, Experimental, Plugins, Access). Each item has its lucide icon + label.
3. The default-active item is **General**.
4. The main content area to the right shows the General tab's existing content (deployment mode, instance name, etc.).
5. Click "Privacy" → URL becomes `/instance/settings?tab=privacy`. Privacy tab content loads. Sidebar Privacy item shows the active state.
6. Click "Backups" → URL becomes `/instance/settings?tab=backups`. Backup retention controls load.
7. Click "Access" → navigates to `/instance/access` (separate page).
8. Use the browser back button → returns to `/instance/settings?tab=backups`.

- [ ] **Step 4: Mobile viewport smoke**

Resize the preview to mobile (375x812). Verify:

1. Primary sidebar is hidden; hamburger button visible at top-left of the content area.
2. Secondary sidebar collapses to icons-only (per `SecondarySidebar`'s built-in collapse behavior at narrow widths) OR stacks vertically — whichever the existing component does.
3. Tab content fills the available width.
4. Clicking a sidebar item still updates the URL.

- [ ] **Step 5: No commit needed** — verification only.

---

## Out-of-scope (explicit deferrals)

- **Per-tab nested routes** (e.g., `/instance/settings/privacy` instead of `/instance/settings?tab=privacy`) — would be a cleaner deep-link contract but breaks existing URLs. Phase D MVP keeps the `?tab=` param verbatim for backward compatibility. Future iteration can migrate without disrupting users.
- **Embedding the Access page as a tab panel** — the current Access tab redirects to a standalone `/instance/access` page (`InstanceAccessPage`). Restructuring it to render inline would be a meaningful refactor of `InstanceAccessPage` (which has its own complex user-search + admin-grant state). Phase D keeps the redirect behavior; future iteration can embed if desired.
- **Settings sub-routes shared across other Settings pages** (e.g., per-company settings, agent settings, plugin-detail settings) — those use different layouts and have their own pages. Phase D only migrates `InstanceSettingsPage`.
- **Replacing `PageTabBar` everywhere** — it stays in the codebase, used by 10 other pages. Phase D only swaps it on the one page.
- **Mobile-specific sidebar behavior tuning** — beyond the existing collapsed-to-icons behavior, no Phase D MVP work. Future polish if mobile UX feedback surfaces.
