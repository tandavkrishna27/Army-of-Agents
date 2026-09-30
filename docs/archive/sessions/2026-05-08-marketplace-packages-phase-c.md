# Marketplace Packages UI — Phase C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Phase B package data layer into the AoA Marketplace UI. Add a `PackageCard` component, a `MarketplacePackageDetail` page at `/marketplace/package/:id/*`, a "Packages" section on the marketplace hub when no type filter is active, and a "Part of {pkg}" badge above the item name on individual item detail pages.

**Architecture:** UI-only — Phase B's `usePackages()` hook and `useCatalog()` hook supply all data. No new API endpoints, no schema changes. Reuses Phase A's `LobbyShell`, `StackedIcon` (with `tone="amber"` for packages), and the locked v3 visual language. Splat route `/marketplace/package/:id/*` mirrors the existing `MarketplaceDetail` pattern for IDs that contain slashes (`garrytan/gstack`).

**Tech Stack:** React, react-router-dom (`useParams`, `Link`, splat routes), `@tanstack/react-query` (`useCatalog`, `usePackages`), TailwindCSS, lucide-react (`Sparkles`, `BadgeCheck`, `ChevronLeft`, `ChevronRight`, `Github`, `Layers`), Phase A primitives (`LobbyShell`, `StackedIcon`, `MarketplaceFilterChips`, `MarketplaceSubfilterChips`).

**Spec:** Locked v3 mockup at `.superpowers/marketplace-v3.html` (Views 2 + 3 + 4) — package card visual treatment, package detail page layout (hero + 2-col skill grid), "Part of X" pill placement on individual skill detail.

---

## Files

| Action | Path | What changes |
|--------|------|--------------|
| Create | `ui/src/components/marketplace/PackageCard.tsx` | Card component for marketplace packages: stacked-Sparkles + amber left-edge accent rule + "N items" pill + verified check + github URL + "Install all" button |
| Create | `ui/src/components/marketplace/__tests__/PackageCard.test.tsx` | Unit tests |
| Create | `ui/src/pages/MarketplacePackageDetail.tsx` | Package detail page at `/marketplace/package/:id/*` — hero (large stacked-Sparkles + name + verified + "N items" + github) + 2-col compact member-items grid |
| Create | `ui/src/__tests__/MarketplacePackageDetail.test.tsx` | Page-level tests (loading / error / not-found / populated branches + LobbyShell wiring) |
| Modify | `ui/src/App.tsx` | Add `<Route path="marketplace/package/:id/*" element={<MarketplacePackageDetail />} />` registration |
| Modify | `ui/src/pages/Marketplace.tsx` | Inject "Packages" section above the item grid when `selectedType === null`; hide when a specific type filter is active |
| Modify | `ui/src/__tests__/Marketplace.test.tsx` | Add tests for the new packages section |
| Modify | `ui/src/pages/MarketplaceDetail.tsx` | Add "Part of {pkg}" pill above the `<h1>{item.name}</h1>` when the item belongs to a package |
| Modify | `ui/src/__tests__/MarketplaceDetail.test.tsx` | Add tests for the "Part of X" badge — present when item belongs to a package, absent when it doesn't |

**Total:** 4 files modified, 4 files created. No backend changes. No schema changes.

---

## Verification rules (apply to every task)

1. **TDD order** — failing test first, see it fail with the right error, implement, see it pass, commit.
2. **Per-task scoped tests** before commit; **broader UI suite** at end of each task.
3. **Conventional commits**: `feat(ui):`, `refactor(ui):`, `test(ui):`, `chore(ui):`.
4. **Typecheck after every task that touches multi-file integration** — run `pnpm exec tsc --noEmit` from `ui/`.
5. **Reuse Phase A primitives.** Don't recreate `StackedIcon`, `TypeChip`, `MarketplaceFilterChips`, etc. Don't introduce new layout patterns.
6. **No backend or API client changes.** All data flows through the existing `useCatalog()` + `usePackages()` hooks.

---

## Task 1: Add `PackageCard` component (TDD)

**Files:**
- Create: `ui/src/components/marketplace/PackageCard.tsx`
- Create: `ui/src/components/marketplace/__tests__/PackageCard.test.tsx`

A card component for `MarketplacePackage`. Visual treatment from v3 mockup View 1's package card:
- Wrapped in a `<Link to={packageDetailUrl(pkg)}>` so the whole card navigates to the detail page.
- 3px brand-amber left-edge accent rule (absolute, top-3 to bottom-3).
- Top-right corner: small `Layers` icon + `PACKAGE` text chip (uppercase 10px monochrome).
- Hero icon: `<StackedIcon icon={Sparkles} tone="amber" className="size-12 shrink-0" />`.
- Title row: `pkg.name` + verified-blue `<BadgeCheck>` (only when `pkg.verified === true`) + amber-tinted "N items" inline pill.
- Subtitle: `by {ownerFromSourceUrl}`.
- Footer row: `<Github>` icon + repo URL on left; `<Button>` "Install all" on right.

The footer button mirrors `CatalogCard`'s install button pattern but reads "Install all" and (for Phase C MVP) is a no-op placeholder (`onClick={(e) => e.preventDefault()}`). Phase D or future will wire it to a bulk-install flow.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/components/marketplace/__tests__/PackageCard.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { MarketplacePackage } from "@armyofagents/shared";
import { PackageCard } from "../PackageCard";

function makePkg(overrides: Partial<MarketplacePackage> = {}): MarketplacePackage {
  return {
    id: "garrytan/gstack",
    name: "gstack",
    sourceUrl: "https://github.com/garrytan/gstack",
    memberItemIds: [
      "skill:github-skills/garrytan/gstack/office-hours",
      "skill:github-skills/garrytan/gstack/qa",
    ],
    count: 2,
    verified: true,
    explicit: false,
    ...overrides,
  };
}

function renderCard(pkg: MarketplacePackage) {
  return render(
    <MemoryRouter>
      <PackageCard pkg={pkg} />
    </MemoryRouter>
  );
}

describe("PackageCard", () => {
  it("renders the package name and item count pill", () => {
    renderCard(makePkg({ name: "gstack", count: 50 }));
    expect(screen.getByText("gstack")).toBeInTheDocument();
    expect(screen.getByText(/50 items/i)).toBeInTheDocument();
  });

  it("renders the PACKAGE type chip in the corner", () => {
    renderCard(makePkg());
    expect(screen.getByText("PACKAGE")).toBeInTheDocument();
  });

  it("uses StackedIcon with amber tone (3 layers)", () => {
    const { container } = renderCard(makePkg());
    expect(container.querySelectorAll('[data-stacked-layer]').length).toBe(3);
  });

  it("shows the verified-blue checkmark when pkg.verified is true", () => {
    const { container } = renderCard(makePkg({ verified: true }));
    expect(container.querySelector('[data-testid="package-verified"]')).toBeTruthy();
  });

  it("does NOT show the verified checkmark when pkg.verified is false", () => {
    const { container } = renderCard(makePkg({ verified: false }));
    expect(container.querySelector('[data-testid="package-verified"]')).toBeNull();
  });

  it("renders the github source as 'owner/repo'", () => {
    renderCard(makePkg({ sourceUrl: "https://github.com/garrytan/gstack" }));
    expect(screen.getByText("garrytan/gstack")).toBeInTheDocument();
  });

  it("renders the by-line with the owner extracted from sourceUrl", () => {
    renderCard(makePkg({ sourceUrl: "https://github.com/garrytan/gstack" }));
    expect(screen.getByText(/by garrytan/)).toBeInTheDocument();
  });

  it("links the whole card to /marketplace/package/{id}", () => {
    renderCard(makePkg({ id: "garrytan/gstack" }));
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/marketplace/package/garrytan/gstack");
  });

  it("renders an 'Install all' button on the footer", () => {
    renderCard(makePkg());
    expect(screen.getByRole("button", { name: /install all/i })).toBeInTheDocument();
  });

  it("clicking 'Install all' does not navigate (preventDefault)", async () => {
    const user = userEvent.setup();
    const { container } = renderCard(makePkg());
    const link = container.querySelector("a") as HTMLAnchorElement;
    const linkClickSpy = vi.fn();
    link.addEventListener("click", linkClickSpy);
    await user.click(screen.getByRole("button", { name: /install all/i }));
    const lastCall = linkClickSpy.mock.calls.at(-1);
    expect(lastCall?.[0]?.defaultPrevented).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `ui/`: `pnpm vitest run src/components/marketplace/__tests__/PackageCard.test.tsx`
Expected: FAIL — `Cannot find module '../PackageCard'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// ui/src/components/marketplace/PackageCard.tsx
import { Link } from "react-router-dom";
import { BadgeCheck, Github, Layers, Sparkles } from "lucide-react";
import type { MarketplacePackage } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { StackedIcon } from "./StackedIcon";
import { cn } from "@/lib/utils";

export interface PackageCardProps {
  pkg: MarketplacePackage;
}

/**
 * Stable URL for a package detail page. Package IDs may contain a slash
 * (e.g. `garrytan/gstack` for synthesized packages), and the route
 * `/marketplace/package/:id/*` uses a splat to capture the trailing segment.
 */
export function packageDetailUrl(pkg: MarketplacePackage): string {
  return `/marketplace/package/${pkg.id}`;
}

/** Extract "owner/repo" short label from a github URL. Falls back to id. */
function shortSource(url: string, fallback: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (m) return `${m[1]}/${m[2]!.replace(/\.git$/, "")}`;
  return fallback;
}

/** Extract owner portion of a github URL for the by-line. */
function authorFromSource(url: string): string {
  const m = url.match(/github\.com\/([^/]+)/i);
  return m?.[1] ?? "community";
}

export function PackageCard({ pkg }: PackageCardProps) {
  const repoShort = shortSource(pkg.sourceUrl, pkg.id);
  const author = authorFromSource(pkg.sourceUrl);

  return (
    <div className="relative">
      <Link
        to={packageDetailUrl(pkg)}
        className="block hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
      >
        <div className="relative card-hover rounded-xl border border-border-strong bg-card overflow-hidden p-4 pl-5">
          {/* Left-edge amber accent rule */}
          <span aria-hidden className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r bg-amber-500" />

          {/* Type chip — top-right, with Layers icon */}
          <span className="absolute right-3 top-3 inline-flex items-center gap-1 uppercase text-[10px] tracking-[0.1em] font-semibold text-very-dim leading-none">
            <Layers className="size-3" />
            PACKAGE
          </span>

          {/* Header: stacked icon + name + author */}
          <div className="flex items-start gap-3 pr-20 sm:pr-24">
            <StackedIcon icon={Sparkles} tone="amber" className="size-12 shrink-0" />
            <div className="min-w-0 flex-1 mt-0.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h3 className="text-[1.05rem] font-semibold tracking-tight truncate">{pkg.name}</h3>
                {pkg.verified && (
                  <BadgeCheck
                    data-testid="package-verified"
                    className="size-4 shrink-0 text-[hsl(208_80%_60%)]"
                    aria-label="Verified"
                  />
                )}
                <span
                  className={cn(
                    "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold",
                    "bg-amber-500/10 border border-amber-500/25 text-amber-400",
                  )}
                >
                  {pkg.count} items
                </span>
              </div>
              <div className="mt-0.5 text-[12px] text-very-dim truncate">by {author}</div>
            </div>
          </div>

          {/* Footer: github source + install all */}
          <div className="mt-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0 text-[11.5px] text-very-dim">
              <Github className="size-3 shrink-0" />
              <span className="truncate">{repoShort}</span>
            </div>
            <Button
              size="sm"
              className="text-[11.5px] h-7 px-3 shrink-0"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Phase C MVP: "Install all" is a placeholder. Bulk install
                // wiring is deferred to Phase D / future iteration.
              }}
            >
              Install all
            </Button>
          </div>
        </div>
      </Link>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `ui/`: `pnpm vitest run src/components/marketplace/__tests__/PackageCard.test.tsx`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/marketplace/PackageCard.tsx ui/src/components/marketplace/__tests__/PackageCard.test.tsx
git commit -m "feat(ui): add PackageCard for marketplace package grid"
```

---

## Task 2: Inject "Packages" section into the marketplace hub

**Files:**
- Modify: `ui/src/pages/Marketplace.tsx`
- Modify: `ui/src/__tests__/Marketplace.test.tsx`

When `selectedType === null` (the "All" filter), render a "Packages" section above the existing items grid. When a specific type is selected, hide the packages section (Phase C MVP doesn't filter packages by member-type — that's a future enhancement).

The section uses the same 2-col grid as items, with a section heading "Packages" + count.

- [ ] **Step 1: Add the failing test (append to existing describe block)**

In `ui/src/__tests__/Marketplace.test.tsx`, locate the existing `describe("Marketplace (hub)", ...)` block. Add three new tests at the end:

```tsx
import { usePackages } from "../hooks/usePackages"; // ADD this import at the top of the file

vi.mock("@/hooks/usePackages", () => ({
  usePackages: vi.fn(),
}));
```

Place the `vi.mock` call near the existing `vi.mock("@/hooks/useCatalog", ...)`. Then near the top of the describe block, before the existing tests, add a `beforeEach` augmentation that defaults `usePackages` to returning a small fixture:

```tsx
import { vi } from "vitest";
import { usePackages } from "@/hooks/usePackages";

// In beforeEach (combine with existing vi.clearAllMocks):
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(usePackages).mockReturnValue({
    data: [
      {
        id: "garrytan/gstack",
        name: "gstack",
        sourceUrl: "https://github.com/garrytan/gstack",
        memberItemIds: ["skill:office-hours", "skill:qa"],
        count: 2,
        verified: true,
        explicit: false,
      },
    ],
    isLoading: false,
    error: null,
  } as any);
});
```

Append three new test cases to the end of the describe block:

```tsx
  it("renders the Packages section heading when type filter is null", () => {
    renderWithProviders(<Marketplace />);
    expect(screen.getByText(/^packages$/i)).toBeInTheDocument();
  });

  it("renders package cards when packages are available", () => {
    renderWithProviders(<Marketplace />);
    // gstack is the only package fixture
    expect(screen.getByText("gstack")).toBeInTheDocument();
  });

  it("hides the Packages section when a specific type filter is active", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Marketplace />);
    await user.click(screen.getByRole("button", { name: /skills/i }));
    expect(screen.queryByText(/^packages$/i)).not.toBeInTheDocument();
    expect(screen.queryByText("gstack")).not.toBeInTheDocument();
  });
```

(If the existing `beforeEach` block already exists, merge the `usePackages` mock setup into it — don't duplicate.)

- [ ] **Step 2: Run test to verify it fails**

Run from `ui/`: `pnpm vitest run src/__tests__/Marketplace.test.tsx`
Expected: 3 new tests FAIL — `getByText("Packages")` not found.

- [ ] **Step 3: Modify `Marketplace.tsx`**

Edit `ui/src/pages/Marketplace.tsx`:

1. **Add imports** at the top:

```tsx
import { usePackages } from "@/hooks/usePackages";
import { PackageCard } from "@/components/marketplace/PackageCard";
```

2. **Inside the `Marketplace` function**, after the existing `useDialog()` line, add:

```tsx
  const { data: packages } = usePackages();
```

3. **In the JSX**, immediately before the `{/* Grid */}` comment (line ~152), inject the new section:

```tsx
        {/* Packages — only shown when no specific type filter is active */}
        {selectedType === null && packages && packages.length > 0 && (
          <div className="mb-7">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-dim">
                Packages <span className="text-very-dim font-normal">· {packages.length}</span>
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {packages.map((pkg) => (
                <PackageCard key={pkg.id} pkg={pkg} />
              ))}
            </div>
          </div>
        )}
```

The check `selectedType === null` ensures packages are hidden when a specific type chip is active. The check `packages && packages.length > 0` prevents an empty section heading when the API is loading or returns zero packages.

- [ ] **Step 4: Run test to verify it passes**

Run from `ui/`: `pnpm vitest run src/__tests__/Marketplace.test.tsx`
Expected: all tests pass (existing + 3 new).

- [ ] **Step 5: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Run the broader marketplace suite**

Run from `ui/`: `pnpm vitest run src/__tests__/Marketplace src/components/marketplace/__tests__ --reporter=basic 2>&1 | tail -10`
Expected: all green (PackageCard from Task 1 + Marketplace tests + everything else).

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/Marketplace.tsx ui/src/__tests__/Marketplace.test.tsx
git commit -m "feat(ui): inject Packages section above item grid on marketplace hub"
```

---

## Task 3: Create `MarketplacePackageDetail` page (TDD)

**Files:**
- Create: `ui/src/pages/MarketplacePackageDetail.tsx`
- Create: `ui/src/__tests__/MarketplacePackageDetail.test.tsx`

A new top-level page at route `/marketplace/package/:id/*`. Mirrors `MarketplaceDetail`'s layered approach: `LobbyShell` chrome + chevron-back link + hero block + content. Hero is the package's stacked-Sparkles + name + verified + "N items" pill + by-line + github URL. Below the hero: a 2-col compact grid of member items (each row = small icon + name + 1-line desc, link to that item's detail page).

ID handling: the splat-route pattern — `useParams<{ id: string; "*": string }>()` and reconstruct the full id as `params.id + "/" + params["*"]` when the rest is non-empty (matches existing `MarketplaceDetail` slug handling at lines 36–42 of that file).

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/__tests__/MarketplacePackageDetail.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext, mockDialogContext } from "./test-utils";
import MarketplacePackageDetail from "../pages/MarketplacePackageDetail";
import type {
  CatalogItem,
  MarketplaceCatalogFile,
  MarketplacePackage,
} from "@armyofagents/shared";

function makeItem(overrides: Partial<CatalogItem> & { id: string }): CatalogItem {
  return {
    id: overrides.id,
    type: "skill",
    name: overrides.id.split(":").pop() ?? overrides.id,
    description: "test item",
    version: "1.0.0",
    source: { adapter: "g", url: "https://github.com/garrytan/gstack", locator: "x" },
    trust: { tier: "verified", source: "x" },
    status: "active",
    addedAt: "2026-05-01T00:00:00Z",
    category: "engineering",
    tags: [],
    ...overrides,
  } as CatalogItem;
}

const SAMPLE_PACKAGE: MarketplacePackage = {
  id: "garrytan/gstack",
  name: "gstack",
  sourceUrl: "https://github.com/garrytan/gstack",
  memberItemIds: ["skill:gstack/office-hours", "skill:gstack/qa"],
  count: 2,
  verified: true,
  explicit: false,
};

const SAMPLE_CATALOG: MarketplaceCatalogFile = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-05-01T00:00:00Z",
  itemCount: 2,
  items: [
    makeItem({ id: "skill:gstack/office-hours", name: "office-hours", description: "YC interrogation" }),
    makeItem({ id: "skill:gstack/qa", name: "qa", description: "QA the site" }),
  ],
};

vi.mock("@/hooks/useCatalog", () => ({
  useCatalog: vi.fn(),
}));

vi.mock("@/hooks/usePackages", () => ({
  usePackages: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("@/context/DialogContext", () => ({ useDialog: () => mockDialogContext }));

vi.mock("@/components/LobbySidebar", () => ({
  LobbySidebar: () => <aside data-testid="lobby-sidebar" />,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/UserMenu", () => ({ UserMenu: () => <div /> }));

import { useCatalog } from "@/hooks/useCatalog";
import { usePackages } from "@/hooks/usePackages";

function setupHooks(opts: {
  catalog?: MarketplaceCatalogFile | undefined;
  packages?: MarketplacePackage[] | undefined;
  catalogLoading?: boolean;
  packagesLoading?: boolean;
} = {}) {
  vi.mocked(useCatalog).mockReturnValue({
    data: opts.catalog,
    isLoading: opts.catalogLoading ?? false,
    error: null,
  } as any);
  vi.mocked(usePackages).mockReturnValue({
    data: opts.packages,
    isLoading: opts.packagesLoading ?? false,
    error: null,
  } as any);
}

describe("MarketplacePackageDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders inside LobbyShell with marketplace active", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: [SAMPLE_PACKAGE] });
    renderWithProviders(<MarketplacePackageDetail />, {
      initialEntries: ["/marketplace/package/garrytan/gstack"],
    });
    expect(screen.getAllByTestId("lobby-sidebar").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the package name + verified check + N items pill", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: [SAMPLE_PACKAGE] });
    const { container } = renderWithProviders(<MarketplacePackageDetail />, {
      initialEntries: ["/marketplace/package/garrytan/gstack"],
    });
    expect(screen.getByRole("heading", { level: 1, name: /gstack/i })).toBeInTheDocument();
    expect(container.querySelector('[data-testid="package-hero-verified"]')).toBeTruthy();
    expect(screen.getByText(/2 items/i)).toBeInTheDocument();
  });

  it("renders the chevron-back link to /marketplace", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: [SAMPLE_PACKAGE] });
    renderWithProviders(<MarketplacePackageDetail />, {
      initialEntries: ["/marketplace/package/garrytan/gstack"],
    });
    const back = screen.getByRole("link", { name: /marketplace/i });
    expect(back.getAttribute("href")).toBe("/marketplace");
  });

  it("renders each member item as a row in the grid with a link to its detail page", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: [SAMPLE_PACKAGE] });
    renderWithProviders(<MarketplacePackageDetail />, {
      initialEntries: ["/marketplace/package/garrytan/gstack"],
    });
    expect(screen.getByText("office-hours")).toBeInTheDocument();
    expect(screen.getByText("qa")).toBeInTheDocument();
    // The link should be /marketplace/skill/gstack/office-hours (catalog id "skill:gstack/office-hours" → /marketplace/skill/gstack/office-hours)
    const officeLink = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href") === "/marketplace/skill/gstack/office-hours");
    expect(officeLink).toBeTruthy();
  });

  it("shows a not-found state when the package id does not exist", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: [] });
    renderWithProviders(<MarketplacePackageDetail />, {
      initialEntries: ["/marketplace/package/does-not-exist"],
    });
    expect(screen.getByText(/package not found/i)).toBeInTheDocument();
  });

  it("shows a loading state while packages are loading", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: undefined, packagesLoading: true });
    renderWithProviders(<MarketplacePackageDetail />, {
      initialEntries: ["/marketplace/package/garrytan/gstack"],
    });
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `ui/`: `pnpm vitest run src/__tests__/MarketplacePackageDetail.test.tsx`
Expected: FAIL — `Cannot find module '../pages/MarketplacePackageDetail'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// ui/src/pages/MarketplacePackageDetail.tsx
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import {
  BadgeCheck,
  ChevronLeft,
  Github,
  Layers,
  Plus,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LobbyShell, LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { StackedIcon } from "@/components/marketplace/StackedIcon";
import { TYPE_ICONS } from "@/lib/marketplace-constants";
import { useCatalog } from "@/hooks/useCatalog";
import { usePackages } from "@/hooks/usePackages";
import { useDialog } from "@/context/DialogContext";
import { detailUrl } from "@/components/marketplace/CatalogCard";
import { cn } from "@/lib/utils";
import type { MarketplaceCatalogItem, MarketplaceItemType } from "@armyofagents/shared";

const SINGLE_ICON_TONES: Record<Exclude<MarketplaceItemType, "team">, string> = {
  skill: "bg-amber-500/15 border-amber-500/30 text-amber-500",
  plugin: "bg-blue-500/15 border-blue-500/30 text-blue-500",
  agent: "bg-purple-500/15 border-purple-500/30 text-purple-500",
};

function shortSource(url: string, fallback: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (m) return `${m[1]}/${m[2]!.replace(/\.git$/, "")}`;
  return fallback;
}

function authorFromSource(url: string): string {
  const m = url.match(/github\.com\/([^/]+)/i);
  return m?.[1] ?? "community";
}

export default function MarketplacePackageDetail() {
  const params = useParams<{ id: string; "*": string }>();
  const restPath = params["*"] ?? "";
  const fullPackageId = restPath ? `${params.id}/${restPath}` : (params.id ?? "");

  const { openOnboarding } = useDialog();
  const { data: catalog, isLoading: catalogLoading } = useCatalog();
  const { data: packages, isLoading: packagesLoading } = usePackages();

  const pkg = useMemo(
    () => packages?.find((p) => p.id === fullPackageId) ?? null,
    [packages, fullPackageId],
  );

  const memberItems = useMemo<MarketplaceCatalogItem[]>(() => {
    if (!pkg || !catalog) return [];
    const idSet = new Set(pkg.memberItemIds);
    return catalog.items.filter((it) => idSet.has(it.id));
  }, [pkg, catalog]);

  const isLoading = catalogLoading || packagesLoading;

  return (
    <LobbyShell activeItem="marketplace" defaultCollapsed onCreateCompany={() => openOnboarding()}>
      <div className="mx-auto w-full max-w-[920px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
        <LobbyShellMobileMenuButton className="mb-4" />
        <Link
          to="/marketplace"
          className="mb-4 inline-flex items-center gap-1 text-[12px] text-very-dim hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" /> Marketplace
        </Link>

        {isLoading && (
          <div className="text-sm text-dim">Loading…</div>
        )}

        {!isLoading && !pkg && (
          <div className="rounded-xl border border-border bg-card p-6 text-sm text-dim text-center">
            Package not found.
          </div>
        )}

        {!isLoading && pkg && (
          <div className="space-y-7">
            {/* Hero */}
            <div className="rounded-2xl border border-border-strong bg-card p-6 relative overflow-hidden">
              <span aria-hidden className="absolute left-0 top-6 bottom-6 w-[3px] rounded-r bg-amber-500" />
              <span className="absolute right-5 top-5 inline-flex items-center gap-1 uppercase text-[10px] tracking-[0.1em] font-semibold text-very-dim leading-none">
                <Layers className="size-3" /> PACKAGE
              </span>
              <div className="flex flex-col sm:flex-row items-start gap-5 pl-2">
                <StackedIcon icon={Sparkles} tone="amber" className="size-20 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="text-2xl font-bold tracking-tight">{pkg.name}</h1>
                    {pkg.verified && (
                      <BadgeCheck
                        data-testid="package-hero-verified"
                        className="size-5 shrink-0 text-[hsl(208_80%_60%)]"
                        aria-label="Verified"
                      />
                    )}
                    <span
                      className={cn(
                        "inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-semibold",
                        "bg-amber-500/10 border border-amber-500/25 text-amber-400",
                      )}
                    >
                      {pkg.count} items
                    </span>
                  </div>
                  <div className="mt-1 text-[12.5px] text-dim">by {authorFromSource(pkg.sourceUrl)}</div>
                  <div className="mt-3 flex items-center gap-3 text-[12px] text-very-dim flex-wrap">
                    <a
                      href={pkg.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1.5 hover:text-foreground"
                    >
                      <Github className="size-3.5" /> {shortSource(pkg.sourceUrl, pkg.id)}
                    </a>
                  </div>
                </div>
                <div className="flex flex-col gap-2 shrink-0 w-full sm:w-auto">
                  <Button
                    size="default"
                    className="text-[13px] font-semibold inline-flex items-center gap-1.5"
                    onClick={(e) => {
                      e.preventDefault();
                      // Phase C MVP: Install all is a placeholder.
                    }}
                  >
                    <Plus className="size-4" /> Install all {pkg.count} items
                  </Button>
                </div>
              </div>
            </div>

            {/* Included items grid */}
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[0.95rem] font-semibold tracking-tight">
                  Included items <span className="text-very-dim font-normal text-[0.85rem]">· {pkg.count}</span>
                </h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5">
                {memberItems.map((item) => {
                  const Icon = TYPE_ICONS[item.type];
                  const tone =
                    item.type === "team"
                      ? "bg-teal-500/10 border-teal-500/20 text-teal-500"
                      : SINGLE_ICON_TONES[item.type as Exclude<MarketplaceItemType, "team">];
                  return (
                    <Link
                      key={item.id}
                      to={detailUrl(item)}
                      className="group flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 hover:bg-card hover:border-border-strong transition-colors"
                    >
                      <div
                        className={cn(
                          "size-7 shrink-0 rounded-md border flex items-center justify-center",
                          tone,
                        )}
                      >
                        <Icon className="size-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium truncate">{item.name}</div>
                        <div className="text-[11px] text-very-dim truncate">{item.description}</div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </LobbyShell>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `ui/`: `pnpm vitest run src/__tests__/MarketplacePackageDetail.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/MarketplacePackageDetail.tsx ui/src/__tests__/MarketplacePackageDetail.test.tsx
git commit -m "feat(ui): add MarketplacePackageDetail page with 2-col member grid"
```

---

## Task 4: Wire route in `App.tsx`

**Files:**
- Modify: `ui/src/App.tsx`

Add `/marketplace/package/:id/*` to the route table. Place it BEFORE the `/marketplace/:type` redirect so the literal `package` segment wins. (React Router v6 prefers literal over param at the same depth, so order is technically fine either way, but placing literals first is the convention used elsewhere in this file.)

- [ ] **Step 1: Read current marketplace route block**

Run: `grep -n 'path="marketplace' ui/src/App.tsx | head -10`
Confirm the four existing routes are at the expected line numbers.

- [ ] **Step 2: Add the import**

In `ui/src/App.tsx`, find the existing imports for the marketplace pages (`Marketplace`, `MarketplaceSearch`, `MarketplaceDetail`). Add:

```tsx
import MarketplacePackageDetail from "./pages/MarketplacePackageDetail";
```

Match the existing import style (default vs named). The new file uses `export default function MarketplacePackageDetail`, so this is a default import.

- [ ] **Step 3: Add the route**

In the marketplace route block, insert the new route immediately before `<Route path="marketplace/:type" element={<MarketplaceTypeRedirect />} />`:

```tsx
<Route path="marketplace/package/:id/*" element={<MarketplacePackageDetail />} />
```

The block should now look like:

```tsx
<Route path="marketplace" element={<Marketplace />} />
<Route path="marketplace/search" element={<MarketplaceSearch />} />
<Route path="marketplace/package/:id/*" element={<MarketplacePackageDetail />} />
<Route path="marketplace/:type" element={<MarketplaceTypeRedirect />} />
<Route path="marketplace/:type/:slug/*" element={<MarketplaceDetail />} />
```

- [ ] **Step 4: Verify routes don't conflict**

Run from `ui/`: `pnpm vitest run src/__tests__/MarketplacePackageDetail.test.tsx src/__tests__/Marketplace.test.tsx src/__tests__/MarketplaceDetail.test.tsx --reporter=basic`
Expected: all green. The MarketplacePackageDetail tests use `initialEntries: ["/marketplace/package/garrytan/gstack"]`; if the route conflict caused a redirect or wrong page mount, the test "renders the package name" would fail.

- [ ] **Step 5: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): register /marketplace/package/:id route"
```

---

## Task 5: Add "Part of {pkg}" badge to item detail page

**Files:**
- Modify: `ui/src/pages/MarketplaceDetail.tsx`
- Modify: `ui/src/__tests__/MarketplaceDetail.test.tsx`

When the current item belongs to a package, render a clickable pill above the item's `<h1>`. The pill shows `Part of {pkg.name}` and a `<ChevronRight>`, links to the package detail page, and uses amber-tinted styling consistent with other package treatments.

- [ ] **Step 1: Add the failing tests (append to existing describe block)**

In `ui/src/__tests__/MarketplaceDetail.test.tsx`, find the existing test setup. Locate the `vi.mock("@/hooks/useCatalog", ...)` block. Add a parallel mock for `usePackages`:

```tsx
vi.mock("@/hooks/usePackages", () => ({
  usePackages: vi.fn(),
}));
```

Place near the other hook mocks. Then add an import + a `beforeEach` setup line:

```tsx
import { usePackages } from "@/hooks/usePackages";

// In beforeEach:
vi.mocked(usePackages).mockReturnValue({
  data: [],
  isLoading: false,
  error: null,
} as any);
```

(Default to empty packages list for existing tests so the badge doesn't appear.)

Append two new tests inside the existing describe block:

```tsx
  it("renders 'Part of X' pill above the name when the item belongs to a package", () => {
    vi.mocked(usePackages).mockReturnValue({
      data: [
        {
          id: "garrytan/gstack",
          name: "gstack",
          sourceUrl: "https://github.com/garrytan/gstack",
          memberItemIds: [SLACK_PLUGIN.id],  // or whatever fixture id matches the rendered item
          count: 1,
          verified: true,
          explicit: false,
        },
      ],
      isLoading: false,
      error: null,
    } as any);
    // (assumes SLACK_PLUGIN or equivalent fixture is rendered by the test setup)
    renderDetail();  // existing helper that mounts MarketplaceDetail
    const pill = screen.getByRole("link", { name: /part of gstack/i });
    expect(pill).toBeInTheDocument();
    expect(pill.getAttribute("href")).toBe("/marketplace/package/garrytan/gstack");
  });

  it("does NOT render the 'Part of X' pill when the item is not in any package", () => {
    // usePackages defaults to empty in beforeEach
    renderDetail();
    expect(screen.queryByText(/part of/i)).not.toBeInTheDocument();
  });
```

(If the existing test file uses a different fixture import or render helper, adapt the IDs accordingly. The key behavior: when `usePackages().data` includes a package whose `memberItemIds` contains the rendered item's id, the pill appears with text "Part of {pkg.name}" and links to `/marketplace/package/{pkg.id}`.)

- [ ] **Step 2: Run test to verify the new tests fail**

Run from `ui/`: `pnpm vitest run src/__tests__/MarketplaceDetail.test.tsx`
Expected: 2 new tests FAIL — `getByRole("link", { name: /part of gstack/i })` not found.

- [ ] **Step 3: Modify `MarketplaceDetail.tsx`**

Edit `ui/src/pages/MarketplaceDetail.tsx`:

1. **Add the imports** at the top:

```tsx
import { ChevronRight, Layers } from "lucide-react";
import { usePackages } from "@/hooks/usePackages";
import { packageDetailUrl } from "@/components/marketplace/PackageCard";
```

(Merge `ChevronRight` and `Layers` with existing lucide-react imports if they're already grouped.)

2. **Inside the component**, after the existing `useCatalog()` hook call, add:

```tsx
  const { data: packages } = usePackages();
```

3. **Compute the parent package** with `useMemo` after the `item` lookup is available:

```tsx
  const parentPackage = useMemo(() => {
    if (!item || !packages) return null;
    return packages.find((p) => p.memberItemIds.includes(item.id)) ?? null;
  }, [item, packages]);
```

(Place this near the other `useMemo` hooks in the component. Add `useMemo` to the React import if it's not already there.)

4. **In the JSX hero block**, find the row that renders the version badge (the `<div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">` block at lines ~172-177). **Immediately after that closing `</div>`** and before the next `<div className="flex items-center gap-2">` that holds the `<h1>` + `<BadgeCheck>`, insert:

```tsx
                {parentPackage && (
                  <Link
                    to={packageDetailUrl(parentPackage)}
                    className="inline-flex items-center gap-1.5 mb-2 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-[11px] font-medium text-amber-400 hover:bg-amber-500/20 transition-colors w-fit"
                  >
                    <Layers className="size-3" />
                    Part of {parentPackage.name}
                    <ChevronRight className="size-3" />
                  </Link>
                )}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `ui/`: `pnpm vitest run src/__tests__/MarketplaceDetail.test.tsx`
Expected: all tests pass (existing + 2 new).

- [ ] **Step 5: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Run the broader marketplace suite**

Run from `ui/`: `pnpm vitest run src/__tests__/Marketplace src/components/marketplace/__tests__ --reporter=basic 2>&1 | tail -10`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/MarketplaceDetail.tsx ui/src/__tests__/MarketplaceDetail.test.tsx
git commit -m "feat(ui): add 'Part of {pkg}' badge above name on item detail"
```

---

## Task 6: Final verification + browser smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full UI test suite**

Run from `ui/`: `pnpm vitest run --reporter=basic 2>&1 | tail -10`
Expected: all tests pass. Count breakdown:
- Phase A end: 1083
- Phase B usePackages tests: +3 = 1086
- Phase C Task 1 PackageCard: +10 = 1096
- Phase C Task 2 Marketplace hub: +3 = 1099
- Phase C Task 3 MarketplacePackageDetail: +6 = 1105
- Phase C Task 5 MarketplaceDetail badge: +2 = 1107

Approximate target: **1107 passing** (numbers may shift slightly if existing tests are rewritten to share the new `usePackages` mock).

- [ ] **Step 2: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Confirm dev server is running and live-fetch packages**

Verify `app` (server) and `ui` (Vite) are running via the preview MCP. If not, start them.

In the running browser preview's DevTools console, hit the API to confirm packages are still synthesized correctly:

```js
await fetch("/api/marketplace/packages", { credentials: "include" }).then(r => r.json())
```

Expected: `{ packages: [...] }` with 3 packages (gstack, MeteoriteLabs/aoa-marketplace, obra/superpowers) — same as Phase B end.

- [ ] **Step 4: Browser smoke — marketplace hub**

Navigate to `http://localhost:<port>/marketplace` in the preview browser. Verify:
1. Primary sidebar auto-collapsed (Phase A behavior preserved).
2. **New Packages section** above the items grid, with 3 package cards:
   - Each card has the stacked-Sparkles + amber accent rule + "PACKAGE" type chip + "N items" pill + verified blue check + github URL + Install all button.
   - Cards arrange in a 2-col grid (or 1-col on narrow viewports).
3. Items grid below packages section is unchanged from Phase A.
4. Clicking the "Skills" filter chip hides the packages section and shows only items.
5. Clicking back to "All" restores the packages section.

- [ ] **Step 5: Browser smoke — package detail page**

Click the "gstack" package card. Verify:
1. URL becomes `/marketplace/package/garrytan/gstack`.
2. Page renders with:
   - Chevron-back link "Marketplace" at top.
   - Hero: large stacked-Sparkles, "gstack" name, verified-blue check, "49 items" pill, "by garrytan", github URL link.
   - "Install all 49 items" button (clicking it: no-op for Phase C).
   - "Included items · 49" heading.
   - 2-column grid of items: small icon + name + 1-line description per row.
3. Clicking any item row navigates to that item's detail page (`/marketplace/skill/.../...`).

- [ ] **Step 6: Browser smoke — "Part of gstack" badge on item detail**

From the package detail page, click any item (e.g., "office-hours"). Verify:
1. URL becomes the item's detail URL.
2. Above the `<h1>` item name, an amber-tinted "Part of gstack →" pill is visible.
3. Clicking the pill navigates back to `/marketplace/package/garrytan/gstack`.

Items NOT in any package (if any — synthesized loners with single source.url, or items with non-github sources) should NOT show the pill.

- [ ] **Step 7: Mobile viewport smoke**

Resize the preview to mobile (375x812). Verify:
1. Hub: hamburger button visible, packages section + items grid stack vertically (1-col cards).
2. Package detail: hero stacks vertically (icon above text on narrow viewports), 2-col items grid collapses to 1-col.
3. Item detail: "Part of X" pill visible above the name.

- [ ] **Step 8: No commit needed** — verification only.

---

## Out-of-scope (explicit deferrals)

- **Bulk install of a package** — the "Install all" buttons are placeholders. A real implementation would iterate `pkg.memberItemIds`, dispatch install operations, and show batch progress UI. **Phase D or future iteration.**
- **Sub-filter chips on package detail** (the gstack flow stages from v3 mock View 3 — Think / Plan / Build / etc.) — requires per-item categorization data not present in `MarketplaceCatalogItem`. **Future iteration with an enriched catalog.**
- **Hover-reveal "+ Install" mini-button** on each row of the package detail's item grid (per v3 mock) — Phase C ships the row layout without the install affordance. **Future iteration once bulk install lands.**
- **Curated package metadata** (description, cover image, author profile picture) — the synthesized `MarketplacePackage` shape doesn't carry these. Catalog repo can populate via the explicit `packageId` path with a parallel metadata block. **Future iteration.**
- **Filtering packages by member type** (e.g., "Plugins" filter shows packages that contain plugins) — requires server-side filtering or per-type lookups. **Future iteration.**
- **Settings → LobbyShell** (the original Phase D from the Phase A summary) — separate work item. Not blocked by Phase C.
