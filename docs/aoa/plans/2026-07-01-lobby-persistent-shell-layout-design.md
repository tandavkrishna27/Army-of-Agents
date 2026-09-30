# Persistent lobby shell (layout route) — Design

**Date:** 2026-07-01
**Branch:** `feat/lobby-ui`
**Status:** Approved (design), pending implementation plan
**Author:** TK + Claude

---

## Problem

Navigating between lobby-tier pages (Organizations → Marketplace → Settings) makes
the whole sidebar **flash / slide in** on every click. Root cause: each of the 6
lobby-tier pages renders its **own** `<LobbyShell>` (there is no shared layout).
Navigation unmounts one shell and mounts a fresh one, so `LobbySidebar` is
destroyed + recreated every time and its `lobby-sidebar-enter` entrance animation
(`opacity 0→1`, `translateX(-32px)→0`, 200ms — `ui/src/index.css:547`) replays on
every navigation.

Best practice: persistent chrome belongs in a **layout route** that renders once
and wraps an `<Outlet/>`; only page content swaps. The company-scoped area already
does this (`ui/src/components/Layout.tsx` → `<Outlet/>`), so we mirror that.

## Goal

Hoist `LobbyShell` into a single persistent `LobbyLayout` route so the sidebar
mounts once and survives lobby-tier navigation — eliminating the remount, the
flash, and redundant re-renders. No user-visible behavior changes except the flash
going away.

## Current state (from investigation)

- 6 pages render `<LobbyShell>`: `Lobby` (`organizations`), `Marketplace`,
  `MarketplaceDetail`, `MarketplaceSearch`, `MarketplacePackageDetail` (all
  `marketplace`), and `InstanceSettingsPage` (`settings`).
- **All** pass identical `onCreateCompany={() => openOnboarding()}`.
- **Only** `InstanceSettingsPage` passes `defaultCollapsed` (true) and
  `secondarySidebar` (built from its own `activeTab` / `sidebarCollapsed` state and
  `handleTabChange`).
- All 6 render `<LobbyShellMobileMenuButton/>` inside their content (uses
  `useLobbyShell().openMobileMenu`).
- `activeItem` is fully derivable from the route path.
- Routes live under `<Route element={<CloudAccessGate/>}>` in `App.tsx:320-337`.
  `/me`, `/export`, `/import` use a different layout (`<Layout>`), not `LobbyShell`.

## Design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | New `LobbyLayout` component renders `<LobbyShell …><Outlet/></LobbyShell>`; the 6 lobby routes become its children. | Standard React Router persistent-chrome pattern; mirrors `Layout.tsx`. |
| D2 | `activeItem` is derived from the route via a pure `lobbyActiveItem(pathname)` helper (unit-tested). Pages stop passing it. | One source of truth; no per-page duplication. |
| D3 | The secondary sidebar is handed **up** from a page to the layout via **Outlet context**: the layout owns `secondarySidebar` state and exposes `setSecondarySidebar` through `<Outlet context>`. `InstanceSettingsPage` sets it in a `useLayoutEffect` (deps: its sections/collapse state) and clears it (`null`) on unmount. | `useLayoutEffect` fills the slot before paint (no blank-frame). Cleaner than a portal; React Router's idiomatic child→parent slot. |
| D4 | Primary auto-collapse becomes **reactive** to "is a secondary sidebar present", replacing the old mount-time `defaultCollapsed`. | The shell no longer remounts, so a mount-time override can't fire on navigation. See "Reactive collapse" below. |
| D5 | Only the 6 current `LobbyShell` pages move under `LobbyLayout`. `/me`, `/export`, `/import`, `/instance/access`, `/instance/settings/plugins/:pluginId` stay as-is (they don't use `LobbyShell`). | Minimal blast radius; those pages are out of scope. |
| D6 | Full test pyramid: unit (`LobbyLayout` + `lobbyActiveItem` + updated page tests) **and** e2e (existing specs as behavior-preserving regression guards; run on Linux CI + attempted locally on Windows via a new force-flag). | The refactor must not change URLs, roles, or `?tab=` behavior; e2e proves it. |

## Components / files

### New

- `ui/src/components/LobbyLayout.tsx` — the layout route component.
- `ui/src/lib/lobbyActiveItem.ts` — `lobbyActiveItem(pathname): LobbySidebarItem`.
- `ui/src/components/__tests__/LobbyLayout.test.tsx`
- `ui/src/lib/__tests__/lobbyActiveItem.test.ts`

### Modified

- `ui/src/App.tsx` — wrap the 6 lobby routes in `<Route element={<LobbyLayout/>}>`.
- `ui/src/pages/Lobby.tsx`, `Marketplace.tsx`, `MarketplaceDetail.tsx`,
  `MarketplaceSearch.tsx`, `MarketplacePackageDetail.tsx` — remove `<LobbyShell>`
  wrapper; return page content directly. Keep `<LobbyShellMobileMenuButton/>`
  (still works — page is a shell descendant).
- `ui/src/pages/InstanceSettingsPage.tsx` — remove `<LobbyShell>` wrapper; push its
  `<SecondarySidebar>` via `setSecondarySidebar` from `useOutletContext` in a
  `useLayoutEffect`.
- `ui/src/components/LobbyShell.tsx` — accept `hasSecondarySidebar` reactively for
  D4; keep providing `useLobbyShell` context + mobile drawer.
- `ui/src/components/LobbySidebar.tsx` — reactive collapse (D4) instead of
  mount-only `defaultCollapsed`.
- Page test files (6) — drop the "page renders its own shell" assertions/mocks.
- `docs/architecture/design-system.md` §8.1.1 — document the reactive-collapse
  mechanism under the persistent shell.
- `tests/e2e/playwright.config.ts` — `AOA_E2E_FORCE_WINDOWS` escape hatch (done).

## Data flow

```
LobbyLayout
  ├─ derives activeItem = lobbyActiveItem(useLocation().pathname)
  ├─ owns secondarySidebar state (default null)
  ├─ renders <LobbyShell activeItem hasSecondarySidebar={!!secondarySidebar}
  │                      secondarySidebar onCreateCompany>
  │     └─ <Outlet context={{ setSecondarySidebar }} />
  └─ child route pages:
        Lobby / Marketplace* → render content only (no secondary sidebar)
        InstanceSettingsPage → useLayoutEffect(() => {
              setSecondarySidebar(<SecondarySidebar … floating />);
              return () => setSecondarySidebar(null);
           }, [sections, sidebarCollapsed]);
```

Type for the outlet context:
```ts
export interface LobbyOutletContext {
  setSecondarySidebar: (node: React.ReactNode | null) => void;
}
```
Pages read it with `useOutletContext<LobbyOutletContext>()`.

## Reactive collapse (D4)

Replace the mount-time `defaultCollapsed` override with reactive behavior in
`LobbySidebar`, preserving the §8.1.1 UX intent:

- Persisted **global preference** in `localStorage["aoa.lobby.sidebar-collapsed"]`.
- When a secondary sidebar is **present**, the primary is force-collapsed. The user
  may still manually expand it for that visit (transient — not written to the
  global preference).
- When the secondary sidebar is **absent**, the primary reflects the global
  preference, and manual toggles update that preference.

Sketch:
```tsx
// hasSecondarySidebar comes from LobbyShell
const [pref, setPref] = useState(readPref);              // global, persisted
const [collapsed, setCollapsed] = useState(hasSecondarySidebar || pref);
useEffect(() => {                                        // react to nav in/out of settings
  setCollapsed(hasSecondarySidebar ? true : pref);
}, [hasSecondarySidebar, pref]);
const toggle = () => {
  if (hasSecondarySidebar) setCollapsed((c) => !c);      // transient peek
  else { const next = !collapsed; setCollapsed(next); setPref(next); writePref(next); }
};
```
Drawer mode is unaffected (always expanded).

## Testing

### Unit (vitest — local + CI)
- `lobbyActiveItem.test.ts`: path → activeItem for `/`, `/marketplace`,
  `/marketplace/search`, `/marketplace/package/x`, `/marketplace/skill/y`,
  `/instance/settings`, and an unknown path (defaults to `organizations`).
- `LobbyLayout.test.tsx`: renders one `LobbySidebar`; derives `activeItem` from a
  `MemoryRouter` initial path; a child that calls `setSecondarySidebar` makes the
  secondary sidebar appear; unmounting the child clears it.
- Updated page tests (`Lobby`, `Marketplace`, `MarketplaceDetail`,
  `MarketplaceSearch`, `MarketplacePackageDetail`, `InstanceSettingsPage-signout`):
  render the page inside a minimal `LobbyLayout`/`MemoryRouter` wrapper (or drop the
  shell-presence assertion, which is now the layout's responsibility). Keep the
  Settings sections assertion by rendering Settings within the layout so its
  `setSecondarySidebar` runs.
- `LobbySidebar` reactive-collapse tests: collapses when `hasSecondarySidebar`,
  restores preference when not, transient peek does not persist.

### e2e (Playwright — Linux CI required gate; local Windows via force-flag)
Behavior-preserving guards — should pass **unchanged**:
- `sign-out-flow.spec.ts` + `backups-tab.spec.ts`: `/instance/settings` →
  SecondarySidebar item click → `?tab=` URL update + section heading. Directly
  validates the D3 handoff.
- `onboarding.spec.ts`: create-org flow from the lobby.
- `marketplace.spec.ts` / `marketplace-install-flow.spec.ts`: marketplace pages
  under the new layout.
- Audit task: run the suite; touch a spec **only** if a selector genuinely moved.
- **New (optional) lobby-nav e2e**: assert that clicking Organizations →
  Marketplace → Settings updates content without the sidebar unmounting (e.g. the
  same sidebar node persists / no full reload). Added if cheap and stable.

### Windows e2e — PROVEN working (Issue #114 is CI-runner-only)
`tests/e2e/playwright.config.ts` gained `AOA_E2E_FORCE_WINDOWS=1` (done). Verified
on 2026-07-01: `AOA_E2E_FORCE_WINDOWS=1 AOA_E2E_PORT=3298 pnpm test:e2e backups-tab`
booted embedded-postgres and passed **7/7 in 24.7s** on this real Windows machine.
So the full suite can be run locally on Windows as part of verification — CI leaves
the flag unset, so CI behavior is unchanged.

**Gotcha (must handle in the plan):** the e2e `webServer` runs
`pnpm aoa onboard --yes --run`, and config resolution ancestor-walks from cwd —
so it **overwrites the worktree's `.aoa/config.json`** (our dev instance's config)
instead of writing only to its temp `AOA_HOME`. Mitigation for local runs: stop the
dev instance and/or back up + restore `.aoa/config.json` around the e2e run (or run
e2e from a checkout without a local `.aoa/config.json`). CI is unaffected (no
pre-existing `.aoa/config.json`).

## Risks / edge cases

- **Blank-frame on entering Settings:** mitigated by `useLayoutEffect` (fills the
  slot before paint).
- **Effect dep churn:** `setSecondarySidebar` re-runs when Settings' section data or
  collapse state changes — acceptable (cheap) and required for the active-tab dot.
- **`activeItem` for unmatched paths:** helper defaults to `organizations`.
- **Test remount assumptions:** existing page tests expect the page to own the
  shell; those assertions move to `LobbyLayout.test.tsx`.
- **Out-of-layout routes** (`/instance/access`, plugin settings): if a future page
  should share the shell, it joins the layout route — tracked as follow-up.

## Non-goals

- No app-wide (company-scoped) sidebar changes.
- No redesign of the sidebar visuals (that shipped earlier on this branch).
- No change to `/me`, `/export`, `/import` layouts.
