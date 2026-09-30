# Marketplace secondary sidebar + AoA section — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the marketplace's horizontal type-chip row with a floating secondary sidebar (Home / Skills / Plugins / Agents / Teams / AoA), and segregate AoA first-party items **and packages** into the AoA entry (fully excluded from the main sections, search, and install-from-Home paths).

**Architecture:** A shared `useMarketplaceSidebar(activeKey)` hook computes counts from `useCatalog` (AoA-excluded) and pushes the `SecondarySidebar` to the persistent `LobbyLayout` Outlet context (the `InstanceSettingsPage` pattern). Filtering is driven by the **URL** (`?type=` / `?view=aoa`) as the single source of truth — no local `selectedType` state. AoA membership is a pure predicate (`isAoaItem` / `isAoaPackage`, github owner ∈ AoA orgs). All 4 marketplace pages call the hook.

**Tech Stack:** React + react-router-dom (`@/lib/router`), TailwindCSS v4, `SecondarySidebar`, `useCatalog`, vitest + @testing-library/react.

**Design doc:** `docs/aoa/plans/2026-07-01-marketplace-secondary-sidebar-design.md`

**Incorporates Codex plan review (2026-07-01):** URL-as-source-of-truth (no stale `selectedType`), convert `setSelectedType` callers to nav, exclude AoA from **search** and **packages** (not just item lists), AoA-aware detail pages, strict github-owner parsing, provider-**id**-only matching, and CompanyContext-mocked hook tests.

**Commands:** unit `pnpm --filter @armyofagents/ui exec vitest run <path>`; typecheck `pnpm --filter @armyofagents/ui typecheck`; full `pnpm --filter @armyofagents/ui test:run`.

**File-location note:** the AoA predicates live in `ui/src/lib/marketplace-constants.ts` (next to `authorFromSource`).

---

## Task 1: AoA predicates (`isAoaItem`, `isAoaPackage`)

**Files:**
- Modify: `ui/src/lib/marketplace-constants.ts`
- Test: `ui/src/lib/__tests__/marketplace-aoa.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/__tests__/marketplace-aoa.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isAoaItem, isAoaPackage, isAoaOwner, AOA_OWNERS } from "../marketplace-constants";
import type { MarketplaceCatalogItem, MarketplacePackage } from "@armyofagents/shared";

const item = (url: string, provider?: { id?: string; name?: string }) =>
  ({ source: { url }, provider }) as unknown as MarketplaceCatalogItem;
const pkg = (id: string, provider?: { id?: string }) =>
  ({ id, provider }) as unknown as MarketplacePackage;

describe("AoA predicates", () => {
  it("isAoaItem matches AoA github owners (case-insensitive)", () => {
    expect(isAoaItem(item("https://github.com/aoa-curated/x"))).toBe(true);
    expect(isAoaItem(item("https://github.com/MeteoriteLabs/x"))).toBe(true);
    expect(isAoaItem(item("https://github.com/ArmyOfAgents/x"))).toBe(true);
  });
  it("isAoaItem rejects third-party + non-github hosts", () => {
    expect(isAoaItem(item("https://github.com/garrytan/x"))).toBe(false);
    expect(isAoaItem(item("https://notgithub.com/aoa-curated/x"))).toBe(false);
  });
  it("isAoaItem matches by provider.id (not by display name)", () => {
    expect(isAoaItem(item("https://skills.sh/x", { id: "aoa-curated" }))).toBe(true);
    expect(isAoaItem(item("https://skills.sh/x", { name: "Army of Agents" }))).toBe(false);
  });
  it("isAoaPackage matches owner/repo id + provider.id", () => {
    expect(isAoaPackage(pkg("aoa-curated/crew"))).toBe(true);
    expect(isAoaPackage(pkg("garrytan/gstack"))).toBe(false);
    expect(isAoaPackage(pkg("x", { id: "armyofagents" }))).toBe(true);
  });
  it("AOA_OWNERS entries are lowercase", () => {
    for (const o of AOA_OWNERS) expect(o).toBe(o.toLowerCase());
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/marketplace-aoa.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement in `marketplace-constants.ts`**

Add near `authorFromSource` (import the shared types at the top of the file):

```ts
import type { MarketplaceCatalogItem, MarketplacePackage } from "@armyofagents/shared";

/** GitHub orgs (lowercased) whose marketplace items/packages are AoA first-party. */
export const AOA_OWNERS = new Set(["aoa-curated", "meteoritelabs", "armyofagents"]);

export function isAoaOwner(owner: string | null | undefined): boolean {
  return owner != null && AOA_OWNERS.has(owner.toLowerCase());
}

/** Strict github owner from a source URL; null if not a github.com URL. */
function githubOwner(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    return u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** AoA's own catalog item (segregated into the "AoA" section). Owner or provider.id
 *  only — NOT provider display name ("Army of Agents" is not a slug). */
export function isAoaItem(item: MarketplaceCatalogItem): boolean {
  return isAoaOwner(githubOwner(item.source.url)) || isAoaOwner(item.provider?.id);
}

/** AoA's own derived package. `id` is `owner/repo` for synthesized packages. */
export function isAoaPackage(pkg: MarketplacePackage): boolean {
  return isAoaOwner(pkg.id.split("/")[0]) || isAoaOwner(pkg.provider?.id);
}
```

- [ ] **Step 4: Run — expect PASS** → `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/marketplace-aoa.test.ts`

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/marketplace-constants.ts ui/src/lib/__tests__/marketplace-aoa.test.ts
git commit -m "feat(marketplace): AoA item/package predicates (strict github owner + provider.id)"
```

---

## Task 2: `useMarketplaceSidebar` hook

**Files:**
- Create: `ui/src/components/marketplace/useMarketplaceSidebar.tsx`
- Test: `ui/src/components/marketplace/__tests__/useMarketplaceSidebar.test.tsx`

- [ ] **Step 1: Write the failing test (mock CompanyContext so `@/lib/router` useNavigate works)**

Create `ui/src/components/marketplace/__tests__/useMarketplaceSidebar.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import type { ReactNode } from "react";
import { useMarketplaceSidebar } from "../useMarketplaceSidebar";

const CATALOG = { items: [
  { id: "1", type: "skill", name: "a", description: "", source: { url: "https://github.com/garrytan/x" } },
  { id: "2", type: "skill", name: "b", description: "", source: { url: "https://github.com/aoa-curated/y" } },
  { id: "3", type: "agent", name: "c", description: "", source: { url: "https://github.com/openai/z" } },
] };
vi.mock("@/hooks/useCatalog", () => ({ useCatalog: () => ({ data: CATALOG }) }));
// @/lib/router useNavigate calls useCompany — stub CompanyContext.
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));

function Harness({ activeKey }: { activeKey: any }) {
  const { pillItems } = useMarketplaceSidebar(activeKey);
  return <div data-testid="pills">{pillItems.map((p) => `${p.id}:${p.count}:${p.active ? 1 : 0}`).join(",")}</div>;
}

function renderHook(activeKey: any) {
  let captured: ReactNode = null;
  render(
    <MemoryRouter initialEntries={["/marketplace"]}>
      <Routes>
        <Route element={<Outlet context={{ setSecondarySidebar: (n: ReactNode) => { captured = n; } }} />}>
          <Route path="/marketplace" element={<Harness activeKey={activeKey} />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return { getCaptured: () => captured };
}

describe("useMarketplaceSidebar", () => {
  it("type counts exclude AoA; home is the non-AoA total; aoa counts AoA items", () => {
    renderHook("home");
    const t = screen.getByTestId("pills").textContent!;
    expect(t).toContain("home:2"); // garrytan skill + openai agent (aoa-curated excluded)
    expect(t).toContain("skill:1");
    expect(t).toContain("agent:1");
    expect(t).toContain("aoa:1");
  });
  it("marks the active key", () => {
    renderHook("skill");
    expect(screen.getByTestId("pills").textContent).toContain("skill:1:1");
  });
  it("pushes a SecondarySidebar node to the outlet context", () => {
    const { getCaptured } = renderHook("aoa");
    expect(getCaptured()).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)** → `pnpm --filter @armyofagents/ui exec vitest run src/components/marketplace/__tests__/useMarketplaceSidebar.test.tsx`

- [ ] **Step 3: Implement the hook**

Create `ui/src/components/marketplace/useMarketplaceSidebar.tsx`:

```tsx
import { useLayoutEffect, useMemo, useState } from "react";
import { Bot, Home, Puzzle, Sparkles, Users } from "lucide-react";
import type { MarketplaceItemType } from "@armyofagents/shared";
import { useNavigate, useOutletContext } from "@/lib/router";
import { useCatalog } from "@/hooks/useCatalog";
import { isAoaItem } from "@/lib/marketplace-constants";
import {
  SecondarySidebar,
  type SecondarySidebarItem,
  type SecondarySidebarSection,
} from "@/components/SecondarySidebar";
import type { LobbyOutletContext } from "@/components/LobbyLayout";

export type MarketplaceSidebarKey = "home" | MarketplaceItemType | "aoa";

/**
 * Builds the marketplace floating secondary sidebar (Home / Skills / Plugins /
 * Agents / Teams | AoA), pushes it to the persistent LobbyLayout via the outlet
 * context, and returns `pillItems` for the mobile sub-nav (§8.6). Type counts
 * exclude AoA items; the AoA entry counts AoA-first-party items. Called by every
 * marketplace page so the sidebar chrome is consistent.
 */
export function useMarketplaceSidebar(activeKey: MarketplaceSidebarKey): {
  pillItems: SecondarySidebarItem[];
} {
  const { setSecondarySidebar } = useOutletContext<LobbyOutletContext>();
  const navigate = useNavigate();
  const { data: catalog } = useCatalog();
  const [collapsed, setCollapsed] = useState(false);

  const counts = useMemo(() => {
    const items = catalog?.items ?? [];
    const main = items.filter((i) => !isAoaItem(i));
    return {
      home: main.length,
      skill: main.filter((i) => i.type === "skill").length,
      plugin: main.filter((i) => i.type === "plugin").length,
      agent: main.filter((i) => i.type === "agent").length,
      team: main.filter((i) => i.type === "team").length,
      aoa: items.filter(isAoaItem).length,
    };
  }, [catalog]);

  const pillItems = useMemo<SecondarySidebarItem[]>(() => {
    const go = (key: MarketplaceSidebarKey) => {
      if (key === "home") navigate("/marketplace");
      else if (key === "aoa") navigate("/marketplace?view=aoa");
      else navigate(`/marketplace?type=${key}`);
    };
    const mk = (
      id: MarketplaceSidebarKey,
      label: string,
      icon: SecondarySidebarItem["icon"],
    ): SecondarySidebarItem => ({
      id,
      label,
      icon,
      count: counts[id as keyof typeof counts],
      active: activeKey === id,
      onClick: () => go(id),
    });
    return [
      mk("home", "Home", <Home />),
      mk("skill", "Skills", <Sparkles />),
      mk("plugin", "Plugins", <Puzzle />),
      mk("agent", "Agents", <Bot />),
      mk("team", "Teams", <Users />),
      mk("aoa", "AoA", <Sparkles className="text-brand" />),
    ];
  }, [counts, activeKey, navigate]);

  const sections = useMemo<SecondarySidebarSection[]>(
    () => [{ items: pillItems.slice(0, 5) }, { items: pillItems.slice(5) }],
    [pillItems],
  );

  useLayoutEffect(() => {
    setSecondarySidebar(
      <SecondarySidebar
        sections={sections}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        floating
      />,
    );
    return () => setSecondarySidebar(null);
  }, [setSecondarySidebar, sections, collapsed]);

  return { pillItems };
}
```

- [ ] **Step 4: Run — expect PASS** → same path as Step 2.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/marketplace/useMarketplaceSidebar.tsx ui/src/components/marketplace/__tests__/useMarketplaceSidebar.test.tsx
git commit -m "feat(marketplace): useMarketplaceSidebar hook (AoA-excluded counts + outlet handoff)"
```

---

## Task 3: `Marketplace.tsx` — URL-driven filtering + AoA view + packages/exclusion

**Files:**
- Modify: `ui/src/pages/Marketplace.tsx`
- Test: `ui/src/__tests__/Marketplace.test.tsx`

- [ ] **Step 1: URL as source of truth (remove `selectedType` state)**

Replace the `selectedType` `useState` (Marketplace.tsx:249) with derived values, and
add the AoA view + active key:

```tsx
const isAoaView = searchParams.get("view") === "aoa";
const typeParam = searchParams.get("type");
const selectedType: MarketplaceItemType | null =
  typeParam === "plugin" || typeParam === "skill" || typeParam === "agent" || typeParam === "team"
    ? typeParam
    : null;
const activeKey: MarketplaceSidebarKey = isAoaView ? "aoa" : (selectedType ?? "home");
const { pillItems } = useMarketplaceSidebar(activeKey);
const goType = (t: MarketplaceItemType | null) => navigate(t ? `/marketplace?type=${t}` : "/marketplace");
```

Add `const navigate = useNavigate();` (from `@/lib/router`) if not present.

- [ ] **Step 2: Split items + packages; exclude AoA from main; base per view**

```tsx
const aoaItems = useMemo(() => items.filter(isAoaItem), [items]);
const mainItems = useMemo(() => items.filter((i) => !isAoaItem(i)), [items]);
const base = isAoaView ? aoaItems : mainItems;
const mainPackages = useMemo(() => (packages ?? []).filter((p) => !isAoaPackage(p)), [packages]);
```
- In `typeCounts`, compute from `mainItems` (not `items`).
- In the `visible` memo, start from `base` (not `items`); when `isAoaView`, ignore
  `selectedType` (show all AoA types).
- Everywhere the render used `packages`, use `mainPackages`, and **guard package rows
  with `!isAoaView`** (AoA view shows AoA items as individual cards, no package rows in
  v1). This closes the install-from-Home leak for AoA packages.
- `packageInstallMembers` already resolves by member id; since AoA packages no longer
  render, they can't open the modal from main rows — no extra change needed.

- [ ] **Step 3: Convert `setSelectedType` callers to navigation; drop the chips**

- Line ~314 `PackagesHeader onSeeAll={() => setSelectedType("skill")}` → `onSeeAll={() => goType("skill")}`.
- Line ~377 section `onSeeAll={() => setSelectedType(type)}` → `onSeeAll={() => goType(type)}`.
- Remove `<MarketplaceFilterChips value={selectedType} onChange={setSelectedType} counts={typeCounts} />`
  (line ~433) and its import.

- [ ] **Step 4: Add the mobile pill row (with active auto-scroll, mirroring Settings)**

Add near the top of the content (md:hidden), using `pillItems`:

```tsx
const activePillRef = useRef<HTMLButtonElement>(null);
useEffect(() => {
  activePillRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
}, [activeKey]);
```
```tsx
<div className="md:hidden mb-5 -mx-4 overflow-x-auto px-4 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
  <div className="flex gap-1.5 w-max">
    {pillItems.map((p) => (
      <button
        key={p.id}
        ref={p.active ? activePillRef : undefined}
        type="button"
        data-active={p.active ? "true" : undefined}
        onClick={p.onClick}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-[12.5px] font-medium border whitespace-nowrap shrink-0 transition-colors",
          p.active
            ? "bg-brand/[0.08] text-[hsl(15_60%_75%)] border-brand/[0.25]"
            : "bg-card border-border text-foreground/[0.78] hover:bg-card-2 hover:text-foreground",
        )}
      >
        {p.icon}
        {p.label}
      </button>
    ))}
  </div>
</div>
```
Imports to add: `useMarketplaceSidebar` + `type MarketplaceSidebarKey`, `isAoaItem`,
`isAoaPackage`, `useNavigate` (from `@/lib/router`), `useRef`/`useEffect` (react), `cn`.

- [ ] **Step 5: Update `Marketplace.test.tsx`**

- Wrap renders in a minimal Outlet-context + LobbyShell-mock wrapper (the file already
  mocks `@/components/LobbyShell` from PR #255 — keep that mock):
  ```tsx
  import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
  function renderMarketplace(path = "/marketplace") {
    return renderWithProviders(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Outlet context={{ setSecondarySidebar: () => {} }} />}>
            <Route path="/marketplace" element={<Marketplace />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }
  ```
- Replace chip-row tests with: home grid EXCLUDES a known aoa-curated item; `?view=aoa`
  grid shows ONLY AoA items; `?type=skill` excludes AoA. Ensure the test catalog mock
  has ≥1 aoa-curated item (add inline if missing).
- Keep hero/error/count tests.

- [ ] **Step 6: Typecheck + run** → `pnpm --filter @armyofagents/ui typecheck` then `... vitest run src/__tests__/Marketplace.test.tsx`. Expected: clean + pass.

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/Marketplace.tsx ui/src/__tests__/Marketplace.test.tsx
git commit -m "feat(marketplace): URL-driven sidebar filtering + AoA view (items + packages excluded from main)"
```

---

## Task 4: Persist the sidebar on Detail / Search / Package pages (AoA-aware)

**Files:**
- Modify: `MarketplaceDetail.tsx`, `MarketplaceSearch.tsx`, `MarketplacePackageDetail.tsx`
- Tests: the three `Marketplace*.test.tsx`

- [ ] **Step 1: `MarketplaceSearch` — call hook + EXCLUDE AoA from results**

In `MarketplaceSearch.tsx`:
```tsx
useMarketplaceSidebar("home");
```
And in the `grouped` memo, start from non-AoA items:
```tsx
let items = catalog.items.filter((i) => !isAoaItem(i));
```
(import `useMarketplaceSidebar`, `isAoaItem`.)

- [ ] **Step 2: `MarketplaceDetail` — AoA-aware active key + back link**

After the item is resolved from the catalog, derive:
```tsx
const key: MarketplaceSidebarKey = item && isAoaItem(item)
  ? "aoa"
  : (["skill","plugin","agent","team"] as const).includes(params.type as any)
    ? (params.type as MarketplaceSidebarKey)
    : "home";
useMarketplaceSidebar(key);
```
Point the existing "Back to marketplace/Skills" link at the AoA view when the item is
AoA: `to={item && isAoaItem(item) ? "/marketplace?view=aoa" : "/marketplace"}` (adjust
to the actual back-link JSX; keep its label logic sensible). (import `useMarketplaceSidebar`, `isAoaItem`.)

- [ ] **Step 3: `MarketplacePackageDetail` — AoA-aware key**

```tsx
useMarketplaceSidebar(pkg && isAoaPackage(pkg) ? "aoa" : "skill");
```
(import `useMarketplaceSidebar`, `isAoaPackage`.) If `pkg` isn't loaded yet, pass `"skill"` until it resolves (the hook re-runs on change).

- [ ] **Step 4: Update the three page tests**

Wrap each render in the same Outlet-context wrapper (Task 3 Step 5); keep their existing
`@/components/LobbyShell` mocks. Keep existing assertions. Add to Search: a known
aoa-curated item does NOT appear in results.

- [ ] **Step 5: Typecheck + run the three tests** → `pnpm --filter @armyofagents/ui typecheck` then `... vitest run src/__tests__/MarketplaceDetail.test.tsx src/__tests__/MarketplaceSearch.test.tsx src/__tests__/MarketplacePackageDetail.test.tsx`.

- [ ] **Step 6: Retire `MarketplaceFilterChips` if unused**

`grep -rn "MarketplaceFilterChips" ui/src --include=*.tsx | grep -v __tests__` → if empty,
delete the component + its test; else leave it.

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/MarketplaceDetail.tsx ui/src/pages/MarketplaceSearch.tsx ui/src/pages/MarketplacePackageDetail.tsx ui/src/__tests__/MarketplaceDetail.test.tsx ui/src/__tests__/MarketplaceSearch.test.tsx ui/src/__tests__/MarketplacePackageDetail.test.tsx
git commit -m "feat(marketplace): persist AoA-aware sidebar across detail/search/package pages"
```

---

## Task 5: Full verification + live check

- [ ] **Step 1: Typecheck** → `pnpm --filter @armyofagents/ui typecheck` (clean).
- [ ] **Step 2: Full suite** → `pnpm --filter @armyofagents/ui test:run` (all green).
- [ ] **Step 3: Live-verify on :3281** (gstack browse):
  - `/marketplace` → sidebar renders (Home/Skills/Plugins/Agents/Teams | AoA), chips gone, primary auto-collapsed. Console clean.
  - Click **AoA** (`?view=aoa`) → only AoA items; **Skills** (`?type=skill`) → AoA absent; **Home** → AoA absent. "See all" on a section still navigates correctly.
  - Search (`/marketplace/search?q=...`) → no AoA items in results.
  - Drill into an AoA item → sidebar highlights **AoA**, back link returns to AoA view.
  - Narrow viewport → mobile pill row with active pill scrolled into view.
- [ ] **Step 4: Screenshot proof** — save + share the browse page + the AoA view.

---

## Self-review notes

- **Codex P1 coverage:** #1 URL-derived (no useState) → Task 3 Step 1; #2 setSelectedType→nav → Step 3; #3 search excludes AoA → Task 4 Step 1; #4 detail AoA active/back → Task 4 Step 2; #5 packages excluded + no install-from-Home → Task 3 Step 2; #6 CompanyContext mock → Task 2 Step 1; #7 provider.id-only + strict github host → Task 1 Step 3.
- **Codex P2 coverage:** strict URL parse (Task 1), mobile auto-scroll (Task 3 Step 4), memoized counts/sections deps (Task 2 hook), stronger hook-test assertions (Task 2 Step 1), keep LobbyShell mock (Task 3/4 tests).
- **Placeholders:** none. **Type consistency:** `MarketplaceSidebarKey`, `isAoaItem`/`isAoaPackage`/`isAoaOwner`, `SecondarySidebarItem/Section` consistent across tasks.
