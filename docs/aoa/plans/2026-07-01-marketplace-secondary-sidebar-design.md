# Marketplace secondary sidebar + AoA section — Design

**Date:** 2026-07-01
**Branch:** `feat/lobby-empty-state` (bundled with the crew hero; one PR)
**Status:** Approved (scope), pending implementation plan
**Author:** TK + Claude

---

## Problem

The marketplace browse page filters by type via a **horizontal chip row** (All /
Skills / Plugins / Agents / Teams). It has no secondary sidebar, unlike Settings.
AoA's own first-party items (crew, teams, skills) are mixed into the general
type sections, so there's no dedicated place for "AoA's own stuff," and the general
sections are diluted by first-party items.

## Goal

Give the marketplace a **floating secondary sidebar** (same pattern as Settings —
which we just shipped) with entries **Home · Skills · Plugins · Agents · Teams · AoA**.
Move type filtering from the horizontal chips into the sidebar, and add a dedicated
**AoA** section that shows AoA's own crew/teams/skills — which are **excluded from the
main type sections**.

## Confirmed facts (investigation)

- Marketplace pages render under the persistent `LobbyLayout`; the secondary-sidebar
  slot is fed via the Outlet context (`setSecondarySidebar`) exactly like
  `InstanceSettingsPage`.
- Catalog item types: `skill | plugin | agent | team`. Filtering today: `?type=` →
  `selectedType`; `list.filter(it => it.type === selectedType)` (Marketplace.tsx:291).
- AoA first-party items exist in the catalog under owners `aoa-curated` (34),
  `MeteoriteLabs` (55), `armyofagents` (25) — incl. an "AoA Default Crew" item. Owner
  is derived from `source.url` (github `owner/repo`).
- No explicit "first-party" flag exists → we define one predicate (below).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| M1 | Floating `SecondarySidebar` on marketplace, fed via `LobbyLayout` outlet context (mirror `InstanceSettingsPage`). | Reuses the shipped pattern; consistent with Settings. |
| M2 | Sidebar entries: **Home, Skills, Plugins, Agents, Teams, AoA**. | User-specified. |
| M3 | **Home = the current All grid** (no type filter). Skills/Plugins/Agents/Teams = today's `?type=` filters, moved to the sidebar. | User-specified; keep deep-linkable `?type=`. |
| M4 | **AoA** = AoA's own items (all types) via `isAoaItem`. Selected via `?view=aoa`. | Dedicated first-party shelf. |
| M5 | **`isAoaItem(item)`** = github owner of `item.source.url` ∈ {`aoa-curated`, `meteoritelabs`, `armyofagents`} (case-insensitive). | Matches catalog reality; pure function, unit-testable. |
| M6 | **Exclusion:** Home + the 4 type views filter OUT AoA items; the AoA view shows ONLY AoA items. | User's core requirement — no first-party leakage into main sections. |
| M7 | Remove the horizontal `MarketplaceFilterChips` from content; keep search + sub-filters (Featured / Recently / A–Z). | Filtering moves to the sidebar. |
| M8 | Sidebar shows on **all marketplace pages** (browse, detail, search, package) via a shared `useMarketplaceSecondarySidebar` hook, so chrome doesn't vanish when drilling in. Active item derived from route/type. | Consistent chrome; avoids jarring appear/disappear. |
| M9 | Mobile → horizontal pill row (design-system §8.6), like Settings. | Established mobile pattern for secondary-sidebar pages. |

## Selection model (URL)

Single source of truth in the URL, all deep-linkable:
- **Home:** `/marketplace` (no `type`, no `view`)
- **Type:** `/marketplace?type=skill|plugin|agent|team`
- **AoA:** `/marketplace?view=aoa`

The active sidebar key derives from these params: `view=aoa` → "aoa"; else
`type` → that type; else "home".

## Data / filtering

New pure helpers (in `ui/src/lib/marketplace-aoa.ts`):
```ts
// owner from a github source.url, lowercased; null if not parseable.
export function marketplaceItemOwner(item: MarketplaceCatalogItem): string | null
const AOA_OWNERS = new Set(["aoa-curated", "meteoritelabs", "armyofagents"]);
export function isAoaItem(item: MarketplaceCatalogItem): boolean
```

In `Marketplace.tsx`:
- Split the catalog once: `aoaItems = items.filter(isAoaItem)`, `mainItems = items.filter(i => !isAoaItem(i))`.
- Home / type views operate on `mainItems` (existing logic, just on the filtered base).
- AoA view renders `aoaItems` grouped by type (reuse `renderSection` per type).
- **Counts:** sidebar type counts come from `mainItems`; AoA count = `aoaItems.length`.
- **Packages:** `derivePackages` is server-side (skill packages). AoA skill packages
  should surface under AoA, not Home. v1: keep packages under Home/Skills as today
  BUT exclude AoA-owned packages from the main packages row (filter by owner). If
  that's fiddly, fall back to: packages stay as-is under Home (documented caveat).
  Decide during implementation; the item-level exclusion (M6) is the hard requirement.

## Components / files

- **New:** `ui/src/lib/marketplace-aoa.ts` (+ test) — `isAoaItem`, `marketplaceItemOwner`.
- **New:** `ui/src/components/marketplace/useMarketplaceSecondarySidebar.ts` — builds the
  `SecondarySidebarSection[]` (Home/types/AoA with counts + active state) and pushes it
  via `useOutletContext<LobbyOutletContext>().setSecondarySidebar` in a `useLayoutEffect`.
  Also returns the mobile pill data (one source of truth, §8.6).
- **Modify:** `ui/src/pages/Marketplace.tsx` — consume the hook; split items via
  `isAoaItem`; add the AoA view; drop `<MarketplaceFilterChips>`; add the mobile pill row.
- **Modify:** `MarketplaceDetail.tsx`, `MarketplaceSearch.tsx`, `MarketplacePackageDetail.tsx`
  — call the hook so the sidebar persists (active item derived from context/route).
- **Delete/retire:** `MarketplaceFilterChips.tsx` if no longer used anywhere (check first).

## Accessibility / mobile

- Sidebar items are buttons (SecondarySidebar already accessible); active via `?type`/`?view`.
- Mobile pill row mirrors Settings (§8.6): horizontal scrollable pills, active
  auto-scrolled into view.

## Testing

- **`marketplace-aoa.test.ts`:** `isAoaItem` true for aoa-curated/MeteoriteLabs/armyofagents
  owners (case-insensitive), false for others; `marketplaceItemOwner` parses github urls.
- **`useMarketplaceSecondarySidebar` / Marketplace test:** Home excludes AoA items;
  AoA view shows only AoA items; type views exclude AoA; counts correct; sidebar entries
  render (Home/Skills/Plugins/Agents/Teams/AoA); clicking sets the right `?type`/`?view`.
- Existing `Marketplace*.test.tsx` updated for the sidebar (they mock LobbyShell already);
  the removed chip row's tests move to sidebar assertions.
- e2e: extend `marketplace.spec.ts` — clicking the AoA sidebar item shows AoA items and
  the main sections exclude them (guarded; run locally via `AOA_E2E_FORCE_WINDOWS=1`).

## Risks / edge cases

- **Owner predicate drift:** if AoA publishes under a new github org, add it to `AOA_OWNERS`.
  Keep the set in one place (`marketplace-aoa.ts`) and unit-tested.
- **Packages vs AoA exclusion:** package derivation is server-side; the clean fix is to
  exclude AoA-owned packages from the main packages row (see Data section). Hard
  requirement is item-level; package handling documented if deferred.
- **Detail-page active state:** derive from the viewed item's type (or Home) so the
  sidebar highlight is sensible on drill-downs.
- **Empty AoA / empty type:** show the existing empty-state treatment per view.

## Non-goals

- No change to catalog schema / server catalog (predicate is client-side on `source.url`).
- No "curated collection" editorial flag (M5 owner-based predicate only).
- No changes to install flows, package detail internals, or the crew hero.
