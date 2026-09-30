# Persistent lobby shell (layout route) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Hoist `LobbyShell` into one persistent `LobbyLayout` route so the lobby sidebar mounts once and survives navigation, eliminating the remount/flash.

**Architecture:** New `LobbyLayout` renders `<LobbyShell><Outlet/></LobbyShell>`; the 6 lobby routes become its children. `activeItem` derives from the route; the Settings secondary sidebar is handed up via Outlet context; primary auto-collapse becomes reactive to secondary-sidebar presence.

**Tech Stack:** React, react-router-dom (via `@/lib/router`), TailwindCSS v4, vitest + @testing-library/react, Playwright (e2e).

**Design doc:** `docs/aoa/plans/2026-07-01-lobby-persistent-shell-layout-design.md`

**Commands:**
- Unit (one file): `pnpm --filter @armyofagents/ui exec vitest run <path>`
- Unit (all): `pnpm --filter @armyofagents/ui test:run`
- Typecheck: `pnpm --filter @armyofagents/ui typecheck`
- e2e (Windows local): `AOA_E2E_FORCE_WINDOWS=1 AOA_E2E_PORT=3298 pnpm test:e2e <filter>` — **first back up `.aoa/config.json`** (see Task 9).

---

## Task 1: `lobbyActiveItem` route→activeItem helper

**Files:**
- Create: `ui/src/lib/lobbyActiveItem.ts`
- Test: `ui/src/lib/__tests__/lobbyActiveItem.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { lobbyActiveItem } from "../lobbyActiveItem";

describe("lobbyActiveItem", () => {
  it("maps the index route to organizations", () => {
    expect(lobbyActiveItem("/")).toBe("organizations");
  });
  it("maps marketplace routes to marketplace", () => {
    expect(lobbyActiveItem("/marketplace")).toBe("marketplace");
    expect(lobbyActiveItem("/marketplace/search")).toBe("marketplace");
    expect(lobbyActiveItem("/marketplace/package/abc")).toBe("marketplace");
    expect(lobbyActiveItem("/marketplace/skill/foo")).toBe("marketplace");
  });
  it("maps instance settings to settings", () => {
    expect(lobbyActiveItem("/instance/settings")).toBe("settings");
    expect(lobbyActiveItem("/instance/settings?tab=backups")).toBe("settings");
  });
  it("defaults unknown paths to organizations", () => {
    expect(lobbyActiveItem("/whatever")).toBe("organizations");
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/lobbyActiveItem.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Implement**

Create `ui/src/lib/lobbyActiveItem.ts`:

```ts
import type { LobbySidebarItem } from "@/components/LobbySidebar";

/** Derive which lobby sidebar row is active from the current route path. */
export function lobbyActiveItem(pathname: string): LobbySidebarItem {
  const path = pathname.split("?")[0];
  if (path.startsWith("/marketplace")) return "marketplace";
  if (path.startsWith("/instance/settings")) return "settings";
  // "/" and everything else default to the organizations list.
  return "organizations";
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/lobbyActiveItem.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/lobbyActiveItem.ts ui/src/lib/__tests__/lobbyActiveItem.test.ts
git commit -m "feat(lobby): route->activeItem helper for the layout route"
```

---

## Task 2: Reactive primary-collapse in LobbySidebar + LobbyShell

Replace the mount-time `defaultCollapsed` override with a reactive `hasSecondarySidebar` prop, preserving §8.1.1 UX under a persistent shell.

**Files:**
- Modify: `ui/src/components/LobbySidebar.tsx`
- Modify: `ui/src/components/LobbyShell.tsx`
- Test: `ui/src/__tests__/LobbySidebar.test.tsx`

- [ ] **Step 1: Update LobbySidebar props + collapse logic**

In `ui/src/components/LobbySidebar.tsx`:
- In `LobbySidebarProps`, replace `defaultCollapsed?: boolean` with:
  ```tsx
  /**
   * Reactive: when true (a secondary sidebar is present on this page), the
   * primary force-collapses; the user may still peek-expand it transiently.
   * When false, the primary reflects the persisted preference.
   */
  hasSecondarySidebar?: boolean;
  ```
- Replace the `collapsed` state block + the localStorage write effect with:
  ```tsx
  const [pref, setPref] = useState<boolean>(() => {
    if (drawer) return false;
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    drawer ? false : hasSecondarySidebar ? true : pref,
  );

  useEffect(() => {
    if (drawer) return;
    setCollapsed(hasSecondarySidebar ? true : pref);
  }, [drawer, hasSecondarySidebar, pref]);

  const handleToggle = () => {
    if (hasSecondarySidebar) {
      // Transient peek on a secondary-sidebar page — do not persist.
      setCollapsed((c) => !c);
      return;
    }
    const next = !collapsed;
    setCollapsed(next);
    setPref(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, String(next));
    } catch {
      // noop — storage may be disabled
    }
  };
  ```
- Change the `SidebarCollapseToggle` `onToggle` from `() => setCollapsed((c) => !c)` to `handleToggle`.
- Remove `defaultCollapsed` from the destructured props.

- [ ] **Step 2: Pass `hasSecondarySidebar` from LobbyShell**

In `ui/src/components/LobbyShell.tsx`:
- Remove `defaultCollapsed` from `LobbyShellProps` and the function signature.
- The desktop `<LobbySidebar>` gets `hasSecondarySidebar={secondarySidebar != null}` (drop `defaultCollapsed`). The drawer `<LobbySidebar>` is unchanged.

- [ ] **Step 3: Update the LobbySidebar tests for reactive collapse**

In `ui/src/__tests__/LobbySidebar.test.tsx`, replace the `defaultCollapsed` test with:

```tsx
it("force-collapses when a secondary sidebar is present", () => {
  localStorage.setItem("aoa.lobby.sidebar-collapsed", "false");
  const { container } = renderWithProviders(
    <LobbySidebar onCreateCompany={onCreateCompany} hasSecondarySidebar activeItem="settings" />,
  );
  expect(container.querySelector("aside")?.getAttribute("data-collapsed")).toBe("true");
});

it("reflects the stored preference when no secondary sidebar", () => {
  localStorage.setItem("aoa.lobby.sidebar-collapsed", "true");
  const { container } = renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
  expect(container.querySelector("aside")?.getAttribute("data-collapsed")).toBe("true");
});

it("peek-expanding on a secondary-sidebar page does not persist the preference", async () => {
  const user = userEvent.setup();
  localStorage.setItem("aoa.lobby.sidebar-collapsed", "false");
  const { container } = renderWithProviders(
    <LobbySidebar onCreateCompany={onCreateCompany} hasSecondarySidebar activeItem="settings" />,
  );
  await user.click(screen.getByRole("button", { name: /expand sidebar/i }));
  expect(container.querySelector("aside")?.getAttribute("data-collapsed")).toBe("false");
  expect(localStorage.getItem("aoa.lobby.sidebar-collapsed")).toBe("false"); // unchanged
});
```

- [ ] **Step 4: Run LobbySidebar tests — expect PASS**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/LobbySidebar.test.tsx`
Expected: PASS (all, including the reactive-collapse tests).

- [ ] **Step 5: Typecheck (LobbyShell callers still pass — they change in Task 5)**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: errors ONLY in the 6 pages still passing `defaultCollapsed`/rendering LobbyShell — those are fixed in Task 5. If any OTHER file errors, address it. (If you prefer a clean typecheck between tasks, do Tasks 2→5 before typechecking.)

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/LobbySidebar.tsx ui/src/components/LobbyShell.tsx ui/src/__tests__/LobbySidebar.test.tsx
git commit -m "feat(lobby): reactive primary-collapse via hasSecondarySidebar"
```

---

## Task 3: `LobbyLayout` component + Outlet context

**Files:**
- Create: `ui/src/components/LobbyLayout.tsx`
- Test: `ui/src/components/__tests__/LobbyLayout.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useOutletContext } from "react-router-dom";
import { renderWithProviders } from "@/__tests__/test-utils";
import { LobbyLayout, type LobbyOutletContext } from "../LobbyLayout";

vi.mock("@/components/LobbySidebar", () => ({
  LobbySidebar: ({ activeItem }: any) => <aside data-testid="lobby-sidebar" data-active={activeItem} />,
}));
vi.mock("@/context/DialogContext", () => ({ useDialog: () => ({ openOnboarding: vi.fn() }) }));

function Child() {
  const { setSecondarySidebar } = useOutletContext<LobbyOutletContext>();
  return <button onClick={() => setSecondarySidebar(<div data-testid="secondary" />)}>set</button>;
}

function renderAt(path: string, child = <div>content</div>) {
  return renderWithProviders(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<LobbyLayout />}>
          <Route path="*" element={child} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("LobbyLayout", () => {
  it("renders one LobbySidebar with activeItem derived from the route", () => {
    renderAt("/marketplace");
    const bars = screen.getAllByTestId("lobby-sidebar");
    expect(bars.some((b) => b.getAttribute("data-active") === "marketplace")).toBe(true);
  });

  it("a child can fill the secondary-sidebar slot via outlet context", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    renderAt("/instance/settings", <Child />);
    expect(screen.queryByTestId("secondary")).toBeNull();
    await user.click(screen.getByRole("button", { name: "set" }));
    expect(screen.getByTestId("secondary")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/components/__tests__/LobbyLayout.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `LobbyLayout`**

Create `ui/src/components/LobbyLayout.tsx`:

```tsx
import { useState, type ReactNode } from "react";
import { Outlet, useLocation } from "@/lib/router";
import { useDialog } from "@/context/DialogContext";
import { LobbyShell } from "@/components/LobbyShell";
import { lobbyActiveItem } from "@/lib/lobbyActiveItem";

/** Context handed to lobby child routes so a page can fill the shell's
 *  secondary-sidebar slot (only Settings uses it today). */
export interface LobbyOutletContext {
  setSecondarySidebar: (node: ReactNode | null) => void;
}

/**
 * Persistent layout route for the lobby-tier pages (Lobby, Marketplace*,
 * Settings). Renders {@link LobbyShell} ONCE and swaps page content via
 * <Outlet/>, so the sidebar no longer remounts (and re-animates) on every
 * navigation. `activeItem` is derived from the route.
 */
export function LobbyLayout() {
  const { openOnboarding } = useDialog();
  const location = useLocation();
  const [secondarySidebar, setSecondarySidebar] = useState<ReactNode | null>(null);

  return (
    <LobbyShell
      activeItem={lobbyActiveItem(location.pathname)}
      onCreateCompany={() => openOnboarding()}
      secondarySidebar={secondarySidebar}
    >
      <Outlet context={{ setSecondarySidebar } satisfies LobbyOutletContext} />
    </LobbyShell>
  );
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/components/__tests__/LobbyLayout.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/LobbyLayout.tsx ui/src/components/__tests__/LobbyLayout.test.tsx
git commit -m "feat(lobby): LobbyLayout persistent shell route + outlet context"
```

---

## Task 4: Router restructure (App.tsx)

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Wrap the 6 lobby routes in the layout route**

Add the import near the other page imports:
```tsx
import { LobbyLayout } from "./components/LobbyLayout";
```

Replace the current sibling routes (App.tsx ~322-337) so the lobby-shell pages nest under one `LobbyLayout`. Keep `me`/`export`/`import`/`instance/access`/plugin-settings exactly where they are (outside the layout):

```tsx
<Route element={<CloudAccessGate />}>
  <Route element={<LobbyLayout />}>
    <Route index element={<Lobby />} />
    <Route path="instance/settings" element={<InstanceSettingsPage />} />
    <Route path="marketplace" element={<Marketplace />} />
    <Route path="marketplace/search" element={<MarketplaceSearch />} />
    <Route path="marketplace/package/:id/*" element={<MarketplacePackageDetail />} />
    <Route path="marketplace/:type" element={<MarketplaceTypeRedirect />} />
    <Route path="marketplace/:type/:slug/*" element={<MarketplaceDetail />} />
  </Route>

  <Route path="me" element={<Me />} />
  <Route path="export" element={<Layout />}>
    <Route index element={<CompanyExport />} />
  </Route>
  <Route path="import" element={<Layout />}>
    <Route index element={<CompanyImport />} />
  </Route>
  <Route path="instance/settings/plugins/:pluginId" element={<PluginSettings />} />
  <Route path="instance/access" element={<InstanceAccessPage />} />
  {/* ...existing company-prefix redirects unchanged... */}
</Route>
```

Note: `MarketplaceTypeRedirect` renders a `<Navigate>`, harmless inside the layout (it just redirects to `/marketplace?type=`).

- [ ] **Step 2: Typecheck (pages still render LobbyShell — fixed in Task 5)**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: the only remaining errors are the pages still using the removed `defaultCollapsed`/their own `LobbyShell` — fixed next. Do not commit until Task 5 makes typecheck clean.

---

## Task 5: Convert the 6 pages to render content only

**Files (modify):** `ui/src/pages/Lobby.tsx`, `Marketplace.tsx`, `MarketplaceDetail.tsx`, `MarketplaceSearch.tsx`, `MarketplacePackageDetail.tsx`, `InstanceSettingsPage.tsx`

- [ ] **Step 1: Lobby + 4 Marketplace pages — drop the `<LobbyShell>` wrapper**

For each of `Lobby.tsx`, `Marketplace.tsx`, `MarketplaceDetail.tsx`, `MarketplaceSearch.tsx`, `MarketplacePackageDetail.tsx`:
- Remove the `<LobbyShell activeItem=... onCreateCompany=...>` opening and its closing tag; return the inner content directly (wrap multiple children in a `<>…</>` fragment if needed).
- Remove the now-unused `LobbyShell` import (keep `LobbyShellMobileMenuButton` — still used and still works, since the page renders inside the shell).
- Remove now-unused `useDialog`/`openOnboarding` **only if** they were used solely for `onCreateCompany`. (Lobby also uses `openOnboarding` for its empty-state Create button — KEEP it there.)

Example — `Lobby.tsx` return becomes:
```tsx
  return isEmpty ? (
    <LobbyEmptyState onCreate={() => openOnboarding()} onImport={() => navigate("/import")} />
  ) : (
    <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6 sm:py-7 md:px-10 md:py-9">
      <LobbyShellMobileMenuButton className="mb-4" />
      {/* ...unchanged welcome + cards... */}
    </div>
  );
```
(`Lobby` no longer imports `LobbyShell`; keeps `LobbyShellMobileMenuButton`, `useDialog`, `useNavigate`.)

- [ ] **Step 2: InstanceSettingsPage — push its secondary sidebar via outlet context**

In `ui/src/pages/InstanceSettingsPage.tsx`:
- Remove the `<LobbyShell ...>` wrapper (and its `activeItem`/`defaultCollapsed`/`onCreateCompany`/`secondarySidebar` props); return the page content directly, keeping `<LobbyShellMobileMenuButton/>`.
- Add imports:
  ```tsx
  import { useLayoutEffect } from "react";
  import { useOutletContext } from "@/lib/router";
  import type { LobbyOutletContext } from "@/components/LobbyLayout";
  ```
- Before the return, register the secondary sidebar:
  ```tsx
  const { setSecondarySidebar } = useOutletContext<LobbyOutletContext>();
  useLayoutEffect(() => {
    setSecondarySidebar(
      <SecondarySidebar
        sections={settingsSections}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        floating
      />,
    );
    return () => setSecondarySidebar(null);
  }, [setSecondarySidebar, settingsSections, sidebarCollapsed]);
  ```
- Keep `settingsSections` (useMemo), `sidebarCollapsed` state, and `handleTabChange` exactly as-is. Remove the now-unused `LobbyShell` import; keep `SecondarySidebar`, `LobbyShellMobileMenuButton`, `useDialog` (if still used elsewhere; the create button in the shell is gone, so drop `openOnboarding` if unused).

- [ ] **Step 3: Typecheck — expect CLEAN**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/App.tsx ui/src/pages/Lobby.tsx ui/src/pages/Marketplace.tsx ui/src/pages/MarketplaceDetail.tsx ui/src/pages/MarketplaceSearch.tsx ui/src/pages/MarketplacePackageDetail.tsx ui/src/pages/InstanceSettingsPage.tsx
git commit -m "feat(lobby): render pages under persistent LobbyLayout route"
```

---

## Task 6: Update page tests

**Files (modify):** `ui/src/__tests__/Lobby.test.tsx`, `Marketplace.test.tsx`, `MarketplaceDetail.test.tsx`, `MarketplaceSearch.test.tsx`, `MarketplacePackageDetail.test.tsx`, `InstanceSettingsPage-signout.test.tsx`

- [ ] **Step 1: Adjust each page test that asserted the page renders its own shell**

The pages no longer render `LobbyShell`/`LobbySidebar` themselves. For each test file:
- Remove the `vi.mock("@/components/LobbySidebar", …)` + `Sheet` mocks that existed only to satisfy the shell, and remove assertions like `expect(screen.getAllByTestId("lobby-sidebar").length).toBeGreaterThanOrEqual(1)`.
- If a test rendered the page bare and now needs router/outlet context (e.g. `InstanceSettingsPage` calls `useOutletContext`), wrap the render in a `MemoryRouter` + a `LobbyLayout`-like `Route` providing the outlet context. Minimal wrapper for Settings:
  ```tsx
  import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
  function withLobbyOutlet(ui: React.ReactNode) {
    return (
      <MemoryRouter initialEntries={["/instance/settings"]}>
        <Routes>
          <Route element={<Outlet context={{ setSecondarySidebar: () => {} }} />}>
            <Route path="instance/settings" element={ui as any} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
  }
  ```
  Keep the SecondarySidebar/settings-sections assertions by asserting on what the page renders directly (the section buttons still render inside the page? NO — the sidebar is now provided to the layout). If the signout test asserted the 7 settings items via the sidebar, move that assertion to `LobbyLayout.test.tsx` OR assert by driving the `setSecondarySidebar` spy received the node. Simplest: spy on `setSecondarySidebar`, assert it was called with a node, and keep the sign-out button assertions (which are page content).

- [ ] **Step 2: Run the affected test files — expect PASS**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/Lobby.test.tsx src/__tests__/Marketplace.test.tsx src/__tests__/MarketplaceDetail.test.tsx src/__tests__/MarketplaceSearch.test.tsx src/__tests__/MarketplacePackageDetail.test.tsx src/__tests__/InstanceSettingsPage-signout.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/__tests__/Lobby.test.tsx ui/src/__tests__/Marketplace.test.tsx ui/src/__tests__/MarketplaceDetail.test.tsx ui/src/__tests__/MarketplaceSearch.test.tsx ui/src/__tests__/MarketplacePackageDetail.test.tsx ui/src/__tests__/InstanceSettingsPage-signout.test.tsx
git commit -m "test(lobby): update page tests for persistent LobbyLayout"
```

---

## Task 7: Docs — design-system §8.1.1

**Files:** Modify `docs/architecture/design-system.md`

- [ ] **Step 1: Update the auto-collapse rule for the persistent shell**

In §8.1.1, add a note that under the persistent `LobbyLayout` (2026-07) the primary
auto-collapse is **reactive**: the primary collapses whenever the current page
provides a secondary sidebar (via the `LobbyLayout` outlet-context slot) and
restores the persisted preference otherwise; a manual expand on a secondary-sidebar
page is transient (not persisted). The mount-time `defaultCollapsed` prop is
removed. Cross-reference §8.1.2.

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/design-system.md
git commit -m "docs(design-system): reactive primary-collapse under persistent lobby shell"
```

---

## Task 8: Full unit verification + live browse

- [ ] **Step 1: Typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck` → expect clean.

- [ ] **Step 2: Full UI suite**

Run: `pnpm --filter @armyofagents/ui test:run` → expect all green.

- [ ] **Step 3: Live-verify on :3280 (dev instance HMRs)**

Using `~/.claude/skills/gstack/browse/dist/browse`:
- `goto http://127.0.0.1:3280/` → screenshot; `console --errors` clean.
- Click Marketplace nav row → screenshot; then Settings → screenshot; then Organizations. Confirm the sidebar does NOT slide/flash between navigations (the entrance animation should not replay). Confirm active-row dot follows the route.
- On `/instance/settings`: confirm the secondary sidebar renders (rounded island, top-right toggle) and the primary is collapsed; click a settings item → `?tab=` updates.
- Confirm no console errors on each.

Expected: persistent sidebar (no flash), all surfaces correct, zero console errors.

---

## Task 9: e2e verification (Windows local + CI)

**Files:** none (verification); create a spec only if Step 3 finds a broken selector.

- [ ] **Step 1: Back up the dev instance config (e2e onboard clobbers it)**

```bash
cp "C:/Users/TK/.aoa/wt/lobby-ui/.aoa/config.json" "C:/Users/TK/.aoa/wt/lobby-ui/.aoa/config.json.bak"
```

- [ ] **Step 2: Run the lobby-relevant e2e specs on Windows**

Run (dedicated port so it never touches the :3280 dev server):
```bash
AOA_E2E_FORCE_WINDOWS=1 AOA_E2E_PORT=3298 pnpm test:e2e backups-tab sign-out-flow onboarding marketplace
```
Expected: all pass. These exercise the Settings secondary-sidebar navigation (`?tab=`), the create-org flow, and marketplace pages under the new layout.

- [ ] **Step 3: Restore the dev config**

```bash
mv "C:/Users/TK/.aoa/wt/lobby-ui/.aoa/config.json.bak" "C:/Users/TK/.aoa/wt/lobby-ui/.aoa/config.json"
```
Then confirm the dev instance still serves: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3280/` → `200` (restart the dev server if it was cycled).

- [ ] **Step 4: (Optional) Add a lobby-nav persistence e2e**

If cheap and stable, add `tests/e2e/lobby-nav.spec.ts`: from `/`, click through Organizations → Marketplace → Settings and assert content changes without a full document reload (e.g. capture a reference to a stable sidebar element and assert it persists, or assert no `lobby-sidebar-enter` re-trigger). Keep it minimal to avoid flake. Run it via the same force-flag command.

- [ ] **Step 5: CI is the authoritative e2e gate**

Note in the PR that Linux CI runs the full e2e suite as the required gate; the Windows local run above is a convenience confirmation.

---

## Self-review notes

- **Spec coverage:** D1→Tasks 3+4; D2→Task 1; D3→Tasks 3+5; D4→Task 2; D5→Task 4; D6→Tasks 1/3/6 (unit) + Task 9 (e2e). Docs→Task 7. Verification→Tasks 8+9.
- **Placeholder scan:** none — all steps have concrete code/commands.
- **Type consistency:** `LobbyOutletContext.setSecondarySidebar`, `hasSecondarySidebar`, and `lobbyActiveItem` names are used identically across tasks. `defaultCollapsed` is fully removed (LobbyShell + LobbySidebar + all callers) — no dangling references.
- **Ordering caveat:** typecheck only goes fully clean after Task 5 (Tasks 2 + 4 intentionally leave the 6 pages temporarily inconsistent). Execute Tasks 2→5 before relying on a clean typecheck.
