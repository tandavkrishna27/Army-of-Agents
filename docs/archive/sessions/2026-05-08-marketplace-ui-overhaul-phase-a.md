# Marketplace UI Overhaul — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all marketplace pages from the custom `MarketplaceLayout` chrome to the shared `LobbyShell` layout, and redesign `CatalogCard` to match the locked v3 mockup (top-right type chip, verified checkmark, aligned footer, Bot/Sparkles/Puzzle icons, stacked-Bot for teams).

**Architecture:** UI-only migration. No schema, no API, no routing changes. Reuses the existing `LobbyShell` (already extracted at `ui/src/components/LobbyShell.tsx`). Adds two new presentational components (`TypeChip`, `StackedIcon`) and two filter-chip components (`MarketplaceFilterChips`, `MarketplaceSubfilterChips`). Migrates 4 pages (`Marketplace`, `MarketplaceSearch`, `MarketplaceDetail`, `MarketplaceUpdates`) to wrap in `LobbyShell` with `defaultCollapsed`. Deletes `MarketplaceLayout` + `TypeTile` + `CategoryTile` (no longer used).

**Scope deferred to later phases:**
- **Phase B (backend)**: skill packages model — `packageId` field + ingest grouping + API.
- **Phase C (UI for packages)**: package cards (stacked-Sparkles + amber rule), package detail page (2-col skill grid), "Part of X" badge.
- **Phase D**: Instance Settings → LobbyShell + secondary sidebar.

**Tech Stack:** React, TailwindCSS, lucide-react (`Bot`, `Sparkles`, `Puzzle`, `BadgeCheck`, `Star`, `Download`, `Github`, `ChevronLeft`), shadcn/ui primitives, existing query hooks (`useCatalog`, `useQuery`/`pluginsApi`, `usePendingUpdates`), `LobbyShell` + `LobbyShellMobileMenuButton`.

**Spec:** `.superpowers/marketplace-v3.html` (locked mockup — 4 views).

---

## Files

| Action | Path | What changes |
|--------|------|--------------|
| Create | `ui/src/components/marketplace/TypeChip.tsx` | Top-right type label chip (uppercase 10px, monochrome) |
| Create | `ui/src/components/marketplace/StackedIcon.tsx` | 3-layer receding icon stack (used for teams in Phase A; packages in Phase C) |
| Create | `ui/src/components/marketplace/MarketplaceFilterChips.tsx` | All / Skills / Plugins / Agents / Teams type-filter row |
| Create | `ui/src/components/marketplace/MarketplaceSubfilterChips.tsx` | Sort/discover sub-chip row (All / Featured / Recently added / A–Z) |
| Modify | `ui/src/lib/marketplace-constants.ts` | Change icons: skill → `Sparkles`, plugin → `Puzzle` (keep agent → `Bot`, team handled by StackedIcon) |
| Modify | `ui/src/components/marketplace/CatalogCard.tsx` | Redesign: type chip in corner, verified-blue checkmark next to name, aligned footer (github · install), stacked-Bot for teams |
| Modify | `ui/src/pages/Marketplace.tsx` | Wrap in `LobbyShell`, replace 4-grid type pills + category tiles with `MarketplaceFilterChips` + `MarketplaceSubfilterChips` |
| Modify | `ui/src/pages/MarketplaceSearch.tsx` | Wrap in `LobbyShell` (keep existing search/group logic) |
| Modify | `ui/src/pages/MarketplaceDetail.tsx` | Wrap in `LobbyShell`, replace breadcrumb with chevron-back link, swap TrustBadge pill for verified-blue checkmark in hero |
| Modify | `ui/src/pages/MarketplaceUpdates.tsx` | Wrap in `LobbyShell` (keep existing update logic) |
| Delete | `ui/src/components/marketplace/MarketplaceLayout.tsx` | No longer used after migration |
| Delete | `ui/src/__tests__/MarketplaceLayout.test.tsx` | Tests the deleted component |
| Delete | `ui/src/components/marketplace/TypeTile.tsx` | Replaced by `MarketplaceFilterChips` |
| Delete | `ui/src/components/marketplace/CategoryTile.tsx` | Categories deferred to a future search-page refinement |
| Modify | `ui/src/__tests__/Marketplace.test.tsx` | Update to assert `LobbyShell` + filter chips |
| Modify | `ui/src/__tests__/MarketplaceSearch.test.tsx` | Update to assert `LobbyShell` |
| Modify | `ui/src/__tests__/MarketplaceDetail.test.tsx` | Update to assert `LobbyShell` + verified checkmark |
| Modify | `ui/src/components/marketplace/__tests__/CatalogCard.test.tsx` | Update structural assertions for new chrome |
| Create | `ui/src/components/marketplace/__tests__/TypeChip.test.tsx` | Unit tests for new component |
| Create | `ui/src/components/marketplace/__tests__/StackedIcon.test.tsx` | Unit tests for new component |
| Create | `ui/src/components/marketplace/__tests__/MarketplaceFilterChips.test.tsx` | Unit tests for new component |
| Create | `ui/src/components/marketplace/__tests__/MarketplaceSubfilterChips.test.tsx` | Unit tests for new component |

---

## Verification rules (apply to every task)

1. **TDD order** — write the failing test first, run it to see it fail, then implement, then run to see it pass.
2. **Run scoped tests at the end of each task**, not just the new test.
3. **Commit after each task** — small commits, conventional-commit prefix (`feat(ui):`, `refactor(ui):`, `test(ui):`, `chore(ui):`).
4. **Don't break the typecheck.** Run `pnpm exec tsc --noEmit` from `ui/` after major structural changes (Tasks 4, 7, 9, 11).
5. **Don't break the visual** — Lobby is currently green. Touching `LobbySidebar` or `LobbyShell` is out of scope.

---

## Task 1: Add `TypeChip` component

**Files:**
- Create: `ui/src/components/marketplace/TypeChip.tsx`
- Create: `ui/src/components/marketplace/__tests__/TypeChip.test.tsx`

The chip is a single static label (`SKILL` / `PLUGIN` / `AGENT` / `TEAM`) — no interactivity, no color (monochrome by design), 10px uppercase tracking-wide. It uses the project's `--very-dim` token via Tailwind class `text-very-dim`.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/components/marketplace/__tests__/TypeChip.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TypeChip } from "../TypeChip";

describe("TypeChip", () => {
  it("renders SKILL for type='skill'", () => {
    render(<TypeChip type="skill" />);
    expect(screen.getByText("SKILL")).toBeInTheDocument();
  });

  it("renders PLUGIN for type='plugin'", () => {
    render(<TypeChip type="plugin" />);
    expect(screen.getByText("PLUGIN")).toBeInTheDocument();
  });

  it("renders AGENT for type='agent'", () => {
    render(<TypeChip type="agent" />);
    expect(screen.getByText("AGENT")).toBeInTheDocument();
  });

  it("renders TEAM for type='team'", () => {
    render(<TypeChip type="team" />);
    expect(screen.getByText("TEAM")).toBeInTheDocument();
  });

  it("applies the type-chip styles (uppercase / 10px / very-dim)", () => {
    const { container } = render(<TypeChip type="skill" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("uppercase");
    expect(el.className).toContain("text-[10px]");
    expect(el.className).toContain("text-very-dim");
  });

  it("merges a className override", () => {
    const { container } = render(<TypeChip type="skill" className="absolute right-3 top-3" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("absolute");
    expect(el.className).toContain("right-3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ui/src/components/marketplace/__tests__/TypeChip.test.tsx`
Expected: FAIL — `Cannot find module '../TypeChip'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// ui/src/components/marketplace/TypeChip.tsx
import type { MarketplaceItemType } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

const LABELS: Record<MarketplaceItemType, string> = {
  skill: "SKILL",
  plugin: "PLUGIN",
  agent: "AGENT",
  team: "TEAM",
};

export interface TypeChipProps {
  type: MarketplaceItemType;
  className?: string;
}

/**
 * Small uppercase type chip rendered in the top-right corner of every
 * marketplace card. Monochrome by design — the colored hero icon already
 * carries the type signal; the chip is just a textual confirmation.
 */
export function TypeChip({ type, className }: TypeChipProps) {
  return (
    <span
      className={cn(
        "uppercase text-[10px] tracking-[0.1em] font-semibold text-very-dim leading-none",
        className,
      )}
    >
      {LABELS[type]}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ui/src/components/marketplace/__tests__/TypeChip.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/marketplace/TypeChip.tsx ui/src/components/marketplace/__tests__/TypeChip.test.tsx
git commit -m "feat(ui): add TypeChip for marketplace card top-right corner"
```

---

## Task 2: Add `StackedIcon` component

**Files:**
- Create: `ui/src/components/marketplace/StackedIcon.tsx`
- Create: `ui/src/components/marketplace/__tests__/StackedIcon.test.tsx`

A 3-layer receding icon stack used for **teams** in Phase A (a `Bot` × 3 representing a multi-agent group), and reused for **skill packages** in Phase C (a `Sparkles` × 3 representing a bundle). Layers are absolutely positioned with offsets and reduced opacity on the back/mid layers.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/components/marketplace/__tests__/StackedIcon.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Bot, Sparkles } from "lucide-react";
import { StackedIcon } from "../StackedIcon";

describe("StackedIcon", () => {
  it("renders 3 layers", () => {
    const { container } = render(<StackedIcon icon={Bot} tone="teal" />);
    const layers = container.querySelectorAll('[data-stacked-layer]');
    expect(layers).toHaveLength(3);
  });

  it("marks layers as back / mid / front", () => {
    const { container } = render(<StackedIcon icon={Bot} tone="teal" />);
    expect(container.querySelector('[data-stacked-layer="back"]')).toBeTruthy();
    expect(container.querySelector('[data-stacked-layer="mid"]')).toBeTruthy();
    expect(container.querySelector('[data-stacked-layer="front"]')).toBeTruthy();
  });

  it("renders the lucide icon in each layer", () => {
    const { container } = render(<StackedIcon icon={Sparkles} tone="amber" />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBe(3);
  });

  it("uses tone='teal' classes for teams", () => {
    const { container } = render(<StackedIcon icon={Bot} tone="teal" />);
    const front = container.querySelector('[data-stacked-layer="front"]') as HTMLElement;
    expect(front.className).toContain("border-teal");
  });

  it("uses tone='amber' classes for packages", () => {
    const { container } = render(<StackedIcon icon={Sparkles} tone="amber" />);
    const front = container.querySelector('[data-stacked-layer="front"]') as HTMLElement;
    expect(front.className).toContain("border-amber");
  });

  it("merges a className override on the wrapper", () => {
    const { container } = render(<StackedIcon icon={Bot} tone="teal" className="size-20" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("size-20");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ui/src/components/marketplace/__tests__/StackedIcon.test.tsx`
Expected: FAIL — `Cannot find module '../StackedIcon'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// ui/src/components/marketplace/StackedIcon.tsx
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type StackedIconTone = "teal" | "amber";

interface StackedIconProps {
  icon: LucideIcon;
  tone: StackedIconTone;
  /** Wrapper sizing class (Tailwind size-* or h-*/w-*). Defaults to size-12. */
  className?: string;
}

const TONE_CLASSES: Record<StackedIconTone, { back: string; mid: string; front: string; iconBack: string; iconMid: string; iconFront: string }> = {
  teal: {
    back: "bg-teal-500/10 border-teal-500/15",
    mid: "bg-teal-500/15 border-teal-500/25",
    front: "bg-teal-500/20 border-teal-500/40",
    iconBack: "text-teal-500/70",
    iconMid: "text-teal-500/85",
    iconFront: "text-teal-500",
  },
  amber: {
    back: "bg-amber-500/10 border-amber-500/15",
    mid: "bg-amber-500/15 border-amber-500/25",
    front: "bg-amber-500/20 border-amber-500/40",
    iconBack: "text-amber-500/70",
    iconMid: "text-amber-500/85",
    iconFront: "text-amber-500",
  },
};

/**
 * 3-layer receding icon stack. Used for marketplace cards that represent a
 * collection — `tone="teal"` for teams (multi-agent), `tone="amber"` for skill
 * packages (Phase C). Each layer is an absolutely-positioned rounded square
 * with reduced opacity on the back/mid layers and an offset transform.
 */
export function StackedIcon({ icon: Icon, tone, className }: StackedIconProps) {
  const t = TONE_CLASSES[tone];
  return (
    <div className={cn("relative size-12 shrink-0", className)}>
      <div
        data-stacked-layer="back"
        className={cn(
          "absolute inset-0 flex items-center justify-center rounded-[14px] border",
          t.back,
        )}
        style={{ transform: "translate(8px, -6px) scale(0.86)", opacity: 0.30 }}
      >
        <Icon className={cn("size-1/2", t.iconBack)} />
      </div>
      <div
        data-stacked-layer="mid"
        className={cn(
          "absolute inset-0 flex items-center justify-center rounded-[14px] border",
          t.mid,
        )}
        style={{ transform: "translate(4px, -3px) scale(0.93)", opacity: 0.55 }}
      >
        <Icon className={cn("size-1/2", t.iconMid)} />
      </div>
      <div
        data-stacked-layer="front"
        className={cn(
          "absolute inset-0 flex items-center justify-center rounded-[14px] border",
          t.front,
        )}
      >
        <Icon className={cn("size-1/2", t.iconFront)} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ui/src/components/marketplace/__tests__/StackedIcon.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/marketplace/StackedIcon.tsx ui/src/components/marketplace/__tests__/StackedIcon.test.tsx
git commit -m "feat(ui): add StackedIcon for team + future package cards"
```

---

## Task 3: Update marketplace icons (skill → Sparkles, plugin → Puzzle)

**Files:**
- Modify: `ui/src/lib/marketplace-constants.ts`

The current constants use `BookOpen` for skills and `Plug` for plugins. The locked v3 spec is `Sparkles` and `Puzzle`. Agents stay as `Bot`. Teams stay mapped to `Users` in the constants file (used as a fallback) but `CatalogCard` will switch to `StackedIcon` for teams in Task 4.

- [ ] **Step 1: Read the current constants**

Run: `cat ui/src/lib/marketplace-constants.ts | head -40`

Confirm the existing `TYPE_ICONS` import block and exported map.

- [ ] **Step 2: Update the `TYPE_ICONS` map**

```tsx
// ui/src/lib/marketplace-constants.ts (top-of-file imports — UPDATE)
// Replace the existing import line:
//   import { Bot, BookOpen, Plug, Users } from "lucide-react";
// with:
import { Bot, Puzzle, Sparkles, Users } from "lucide-react";

// Then update TYPE_ICONS to:
export const TYPE_ICONS: Record<MarketplaceItemType, LucideIcon> = {
  skill: Sparkles,
  plugin: Puzzle,
  agent: Bot,
  team: Users,
};
```

- [ ] **Step 3: Verify type-check still passes**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: no output (no errors).

- [ ] **Step 4: Run the full marketplace test suite to confirm nothing broke**

Run: `pnpm vitest run src/__tests__/Marketplace*.test.tsx src/components/marketplace/__tests__ --reporter=basic`
Expected: 35 tests pass (baseline preserved — icons swap is test-invisible).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/marketplace-constants.ts
git commit -m "refactor(ui): switch marketplace skill/plugin icons to Sparkles/Puzzle"
```

---

## Task 4: Redesign `CatalogCard`

**Files:**
- Modify: `ui/src/components/marketplace/CatalogCard.tsx`
- Modify: `ui/src/components/marketplace/__tests__/CatalogCard.test.tsx`

The card structure changes substantially. New layout (matching v3 mock View 1):
- **Top-right corner**: `<TypeChip type={item.type} />` (absolute positioned).
- **Hero icon (left of header)**:
  - Teams → `<StackedIcon icon={Bot} tone="teal" className="size-12" />`.
  - Skills → single `Sparkles` in `bg-amber-500/15 border-amber-500/30 text-amber-500` rounded square.
  - Plugins → single `Puzzle` in `bg-blue-500/15 border-blue-500/30 text-blue-500` rounded square.
  - Agents → single `Bot` in `bg-purple-500/15 border-purple-500/30 text-purple-500` rounded square.
- **Title row**: Name + `BadgeCheck` icon (verified-blue) only when `item.trust.tier === "verified"`. No badge for community/unverified.
- **Subtitle**: `by {sourceOwner}` (extracted from `item.source.url`).
- **Description**: `line-clamp-2`, same as today.
- **Footer row** (replaces today's version-pill + tags + install row):
  - **Left side**: `<Github>` icon + `{ownerSlashRepo}` (extracted from `source.url`). If a future schema adds rating/downloads, they go here too.
  - **Right side**: install button — same logic as today (Installed / Pending / Install + modal).
- The whole card stays a `<Link>` to the detail page; the install button still `e.preventDefault()`s and opens the modal.

The existing test file has 7 tests; some assertions stay (clickable link, install button opens modal, plugin shows "Installed" when in installedByPackageName), some need updating for the new chrome (TypeChip in DOM, no TrustBadge pill, verified checkmark when applicable).

- [ ] **Step 1: Read the existing CatalogCard test file**

Run: `cat ui/src/components/marketplace/__tests__/CatalogCard.test.tsx`

Note which assertions reference TrustBadge or version pill — these need to change.

- [ ] **Step 2: Write the failing test (replace the existing test file)**

```tsx
// ui/src/components/marketplace/__tests__/CatalogCard.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CatalogItem, PluginRecord } from "@armyofagents/shared";
import { CatalogCard } from "../CatalogCard";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "c1",
    companies: [{ id: "c1", name: "Acme", status: "active" }],
  }),
}));

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>("@/api/marketplace");
  return {
    ...actual,
    marketplaceApi: { ...actual.marketplaceApi, install: vi.fn(), getOperation: vi.fn() },
  };
});

function makeItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: "skill:office-hours",
    type: "skill",
    name: "/office-hours",
    description: "YC-style product interrogation.",
    version: "1.4.0",
    source: { adapter: "github", url: "https://github.com/garrytan/gstack", locator: "office-hours" },
    trust: { tier: "verified", source: "anthropic" },
    status: "active",
    addedAt: "2026-04-01T00:00:00Z",
    category: "engineering",
    tags: ["featured"],
    ...overrides,
  };
}

function renderCard(item: CatalogItem, installed?: Map<string, PluginRecord>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CatalogCard item={item} installedByPackageName={installed} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("CatalogCard (v3 chrome)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the item name and description", () => {
    renderCard(makeItem());
    expect(screen.getByText("/office-hours")).toBeInTheDocument();
    expect(screen.getByText(/YC-style product interrogation/)).toBeInTheDocument();
  });

  it("renders TypeChip in the corner with the uppercase type label", () => {
    renderCard(makeItem({ type: "skill" }));
    expect(screen.getByText("SKILL")).toBeInTheDocument();
  });

  it("shows the verified-blue checkmark when trust.tier='verified'", () => {
    const { container } = renderCard(makeItem({ trust: { tier: "verified", source: "x" } }));
    expect(container.querySelector('[data-testid="verified-check"]')).toBeTruthy();
  });

  it("does NOT show the verified checkmark for community items", () => {
    const { container } = renderCard(makeItem({ trust: { tier: "community", source: "x" } }));
    expect(container.querySelector('[data-testid="verified-check"]')).toBeNull();
  });

  it("does NOT show the verified checkmark for unverified items", () => {
    const { container } = renderCard(makeItem({ trust: { tier: "unverified", source: "x" } }));
    expect(container.querySelector('[data-testid="verified-check"]')).toBeNull();
  });

  it("renders the github source as 'owner/repo'", () => {
    renderCard(makeItem());
    expect(screen.getByText("garrytan/gstack")).toBeInTheDocument();
  });

  it("renders an Install button when not yet installed", () => {
    renderCard(makeItem({ type: "plugin", npm: { packageName: "@a/b", version: "1.0.0" } }));
    expect(screen.getByRole("button", { name: /install/i })).toBeInTheDocument();
  });

  it("renders an Installed badge when the plugin is ready", () => {
    const item = makeItem({ type: "plugin", npm: { packageName: "@a/b", version: "1.0.0" } });
    const installed = new Map<string, PluginRecord>([
      ["@a/b", { id: "p1", packageName: "@a/b", status: "ready" } as unknown as PluginRecord],
    ]);
    renderCard(item, installed);
    expect(screen.getByText(/installed/i)).toBeInTheDocument();
  });

  it("renders a Pending badge when the plugin is loading", () => {
    const item = makeItem({ type: "plugin", npm: { packageName: "@a/b", version: "1.0.0" } });
    const installed = new Map<string, PluginRecord>([
      ["@a/b", { id: "p1", packageName: "@a/b", status: "loading" } as unknown as PluginRecord],
    ]);
    renderCard(item, installed);
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it("preserves slashes in the detail-page link (splat route)", () => {
    const item = makeItem({ id: "plugin:aoa-curated/slack", type: "plugin", name: "slack" });
    renderCard(item);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/marketplace/plugin/aoa-curated/slack");
  });

  it("clicking Install does not navigate to the detail page (preventDefault)", async () => {
    const user = userEvent.setup();
    const { container } = renderCard(makeItem({ type: "skill" }));
    const link = container.querySelector("a") as HTMLAnchorElement;
    const linkClickSpy = vi.fn();
    link.addEventListener("click", linkClickSpy);
    const btn = screen.getByRole("button", { name: /install/i });
    await user.click(btn);
    // The link receives the click but the install button preventDefault'd it,
    // so the SPA navigation never fires. We assert by checking the click
    // event's defaultPrevented flag.
    const lastCall = linkClickSpy.mock.calls.at(-1);
    expect(lastCall?.[0]?.defaultPrevented).toBe(true);
  });

  it("uses StackedIcon for type='team'", () => {
    const { container } = renderCard(makeItem({ id: "team:x", type: "team", name: "team-x" }));
    expect(container.querySelectorAll('[data-stacked-layer]').length).toBe(3);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run ui/src/components/marketplace/__tests__/CatalogCard.test.tsx`
Expected: multiple failures — TypeChip missing, verified-check missing, owner/repo text not rendered, etc.

- [ ] **Step 4: Implement the redesigned `CatalogCard`**

```tsx
// ui/src/components/marketplace/CatalogCard.tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { BadgeCheck, Bot, Github } from "lucide-react";
import type { CatalogItem, PluginRecord, MarketplaceItemType } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TYPE_ICONS } from "@/lib/marketplace-constants";
import { PluginInstallModal } from "@/components/marketplace/install/PluginInstallModal";
import { SnapshotInstallModal } from "@/components/marketplace/install/SnapshotInstallModal";
import { TypeChip } from "./TypeChip";
import { StackedIcon } from "./StackedIcon";
import { cn } from "@/lib/utils";

export interface CatalogCardProps {
  item: CatalogItem;
  installedByPackageName?: Map<string, PluginRecord>;
}

export function detailUrl(item: CatalogItem): string {
  const colonIdx = item.id.indexOf(":");
  const slug = item.id.slice(colonIdx + 1);
  return `/marketplace/${item.type}/${slug}`;
}

/** Extract "owner/repo" from a github URL. Falls back to the locator if non-github. */
function shortSource(url: string, locator: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (m) return `${m[1]}/${m[2]!.replace(/\.git$/, "")}`;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/^\/+|\/+$/g, "");
  } catch {
    return locator;
  }
}

/** Extract "owner" portion of "owner/repo". Used as the by-line. */
function authorFromSource(url: string): string {
  const m = url.match(/github\.com\/([^/]+)/i);
  if (m) return m[1] ?? "community";
  return "community";
}

const SINGLE_ICON_TONES: Record<Exclude<MarketplaceItemType, "team">, string> = {
  skill: "bg-amber-500/15 border-amber-500/30 text-amber-500",
  plugin: "bg-blue-500/15 border-blue-500/30 text-blue-500",
  agent: "bg-purple-500/15 border-purple-500/30 text-purple-500",
};

export function CatalogCard({ item, installedByPackageName }: CatalogCardProps) {
  const [installOpen, setInstallOpen] = useState(false);
  const installedPlugin = item.npm?.packageName
    ? installedByPackageName?.get(item.npm.packageName)
    : undefined;

  const isVerified = item.trust.tier === "verified";
  const Icon = TYPE_ICONS[item.type];
  const author = authorFromSource(item.source.url);
  const repoShort = shortSource(item.source.url, item.source.locator);

  return (
    <div className="relative">
      <Link
        to={detailUrl(item)}
        className="block hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
      >
        <div className="relative card-hover rounded-xl border border-border-strong bg-card overflow-hidden p-4">
          {/* Type chip — top-right */}
          <TypeChip type={item.type} className="absolute right-3 top-3" />

          {/* Header: hero icon + name + author */}
          <div className="flex items-start gap-3 pr-16 sm:pr-20">
            {item.type === "team" ? (
              <StackedIcon icon={Bot} tone="teal" className="size-12 shrink-0" />
            ) : (
              <div
                className={cn(
                  "size-12 shrink-0 rounded-2xl border flex items-center justify-center",
                  SINGLE_ICON_TONES[item.type as Exclude<MarketplaceItemType, "team">],
                )}
              >
                <Icon className="size-5" />
              </div>
            )}
            <div className="min-w-0 flex-1 mt-0.5">
              <div className="flex items-center gap-1.5">
                <h3 className="text-[1.05rem] font-semibold tracking-tight truncate">{item.name}</h3>
                {isVerified && (
                  <BadgeCheck
                    data-testid="verified-check"
                    className="size-4 shrink-0 text-[hsl(208_80%_60%)]"
                    aria-label="Verified"
                  />
                )}
              </div>
              <div className="mt-0.5 text-[12px] text-very-dim truncate">by {author}</div>
            </div>
          </div>

          {/* Description */}
          <p className="mt-3 text-[12.5px] text-dim leading-relaxed line-clamp-2">
            {item.description}
          </p>

          {/* Footer row: github source on left, install on right */}
          <div className="mt-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0 text-[11.5px] text-very-dim">
              <Github className="size-3 shrink-0" />
              <span className="truncate">{repoShort}</span>
            </div>
            {installedPlugin ? (
              installedPlugin.status === "ready" ? (
                <Badge className="text-[11px] h-7 px-2.5 shrink-0 bg-green-600 hover:bg-green-600 cursor-default">
                  Installed
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[11px] h-7 px-2.5 shrink-0 cursor-default">
                  Pending
                </Badge>
              )
            ) : (
              <Button
                size="sm"
                className="text-[11.5px] h-7 px-3 shrink-0"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setInstallOpen(true);
                }}
              >
                Install
              </Button>
            )}
          </div>
        </div>
      </Link>

      {item.type === "plugin" && (
        <PluginInstallModal item={item} open={installOpen} onOpenChange={setInstallOpen} />
      )}
      {item.type !== "plugin" && (
        <SnapshotInstallModal item={item} open={installOpen} onOpenChange={setInstallOpen} />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run ui/src/components/marketplace/__tests__/CatalogCard.test.tsx`
Expected: PASS — 11 tests.

- [ ] **Step 6: Run all marketplace tests to confirm no regressions**

Run: `pnpm vitest run src/__tests__/Marketplace*.test.tsx src/components/marketplace/__tests__ --reporter=basic`
Expected: all pass except possibly `Marketplace.test.tsx` page tests (those will be touched in Task 7).

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/marketplace/CatalogCard.tsx ui/src/components/marketplace/__tests__/CatalogCard.test.tsx
git commit -m "feat(ui): redesign CatalogCard per v3 (corner type chip, verified check, aligned footer)"
```

---

## Task 5: Add `MarketplaceFilterChips` component

**Files:**
- Create: `ui/src/components/marketplace/MarketplaceFilterChips.tsx`
- Create: `ui/src/components/marketplace/__tests__/MarketplaceFilterChips.test.tsx`

A 5-chip horizontal row: `All` (null) / `Skills` / `Plugins` / `Agents` / `Teams`. Single-select. Chips are pill-shaped buttons with active state (`bg-foreground text-bg`) vs idle state (`bg-card border border-border`). Each non-`All` chip optionally shows a small count next to the label.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/components/marketplace/__tests__/MarketplaceFilterChips.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarketplaceFilterChips } from "../MarketplaceFilterChips";

const counts = { skill: 250, plugin: 45, agent: 38, team: 12 };

describe("MarketplaceFilterChips", () => {
  it("renders 5 chips", () => {
    render(<MarketplaceFilterChips value={null} onChange={vi.fn()} counts={counts} />);
    expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skills/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /plugins/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /agents/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /teams/i })).toBeInTheDocument();
  });

  it("highlights All when value=null", () => {
    render(<MarketplaceFilterChips value={null} onChange={vi.fn()} counts={counts} />);
    expect(screen.getByRole("button", { name: /^all$/i }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("button", { name: /skills/i }).getAttribute("data-active")).toBeNull();
  });

  it("highlights the matching type chip when value is set", () => {
    render(<MarketplaceFilterChips value="skill" onChange={vi.fn()} counts={counts} />);
    expect(screen.getByRole("button", { name: /skills/i }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("button", { name: /^all$/i }).getAttribute("data-active")).toBeNull();
  });

  it("renders the count next to each non-All chip", () => {
    render(<MarketplaceFilterChips value={null} onChange={vi.fn()} counts={counts} />);
    expect(screen.getByRole("button", { name: /skills/i }).textContent).toMatch(/250/);
    expect(screen.getByRole("button", { name: /plugins/i }).textContent).toMatch(/45/);
    expect(screen.getByRole("button", { name: /agents/i }).textContent).toMatch(/38/);
    expect(screen.getByRole("button", { name: /teams/i }).textContent).toMatch(/12/);
  });

  it("calls onChange with the type when a chip is clicked", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<MarketplaceFilterChips value={null} onChange={onChange} counts={counts} />);
    await user.click(screen.getByRole("button", { name: /skills/i }));
    expect(onChange).toHaveBeenCalledWith("skill");
  });

  it("calls onChange(null) when All is clicked", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<MarketplaceFilterChips value="skill" onChange={onChange} counts={counts} />);
    await user.click(screen.getByRole("button", { name: /^all$/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ui/src/components/marketplace/__tests__/MarketplaceFilterChips.test.tsx`
Expected: FAIL — `Cannot find module '../MarketplaceFilterChips'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// ui/src/components/marketplace/MarketplaceFilterChips.tsx
import { Bot, Puzzle, Sparkles } from "lucide-react";
import type { MarketplaceItemType } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

export interface MarketplaceFilterChipsProps {
  /** Currently selected type filter. `null` means "All". */
  value: MarketplaceItemType | null;
  /** Called when the user picks a type. `null` for the "All" chip. */
  onChange: (next: MarketplaceItemType | null) => void;
  /** Per-type counts shown inline as a dim suffix. */
  counts: Partial<Record<MarketplaceItemType, number>>;
}

const CHIPS: Array<{
  key: MarketplaceItemType | "all";
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
}> = [
  { key: "all", label: "All" },
  { key: "skill", label: "Skills", icon: Sparkles },
  { key: "plugin", label: "Plugins", icon: Puzzle },
  { key: "agent", label: "Agents", icon: Bot },
  { key: "team", label: "Teams", icon: Bot },
];

/**
 * Top-level type-filter pill row for the marketplace browse page.
 * Single-select; the `All` chip resets to `value=null`. The counts prop is
 * optional per-key — chips render their count if present.
 */
export function MarketplaceFilterChips({ value, onChange, counts }: MarketplaceFilterChipsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {CHIPS.map((chip) => {
        const isActive = chip.key === "all" ? value === null : value === chip.key;
        const count = chip.key === "all" ? undefined : counts[chip.key as MarketplaceItemType];
        return (
          <button
            key={chip.key}
            type="button"
            data-active={isActive ? "true" : undefined}
            onClick={() => onChange(chip.key === "all" ? null : (chip.key as MarketplaceItemType))}
            className={cn(
              "inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-medium transition-colors border",
              isActive
                ? "bg-foreground text-bg border-foreground"
                : "bg-card border-border text-foreground/[0.78] hover:bg-card-2 hover:text-foreground hover:border-border-strong",
            )}
          >
            {chip.icon && <chip.icon className="size-3.5" />}
            <span>{chip.label}</span>
            {count !== undefined && (
              <span className={cn("text-[11px]", isActive ? "opacity-60" : "text-very-dim")}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ui/src/components/marketplace/__tests__/MarketplaceFilterChips.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/marketplace/MarketplaceFilterChips.tsx ui/src/components/marketplace/__tests__/MarketplaceFilterChips.test.tsx
git commit -m "feat(ui): add MarketplaceFilterChips for type filter row"
```

---

## Task 6: Add `MarketplaceSubfilterChips` component

**Files:**
- Create: `ui/src/components/marketplace/MarketplaceSubfilterChips.tsx`
- Create: `ui/src/components/marketplace/__tests__/MarketplaceSubfilterChips.test.tsx`

A smaller horizontal sub-chip row used for sort/discover modes. The hub uses values `"all" | "featured" | "recent" | "az"`. Single-select. Visual style is ghost (no border, just text + bg on active).

The component is **generic over the option set** — caller passes options. This lets us reuse it later for the package-detail page (gstack flow stages).

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/components/marketplace/__tests__/MarketplaceSubfilterChips.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarketplaceSubfilterChips } from "../MarketplaceSubfilterChips";

const SORT_OPTIONS = [
  { key: "all", label: "All" },
  { key: "featured", label: "Featured" },
  { key: "recent", label: "Recently added" },
  { key: "az", label: "A–Z" },
] as const;

describe("MarketplaceSubfilterChips", () => {
  it("renders all options", () => {
    render(<MarketplaceSubfilterChips value="all" onChange={vi.fn()} options={SORT_OPTIONS} />);
    expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /featured/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /recently added/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /a–z/i })).toBeInTheDocument();
  });

  it("highlights the selected option", () => {
    render(<MarketplaceSubfilterChips value="featured" onChange={vi.fn()} options={SORT_OPTIONS} />);
    expect(screen.getByRole("button", { name: /featured/i }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("button", { name: /^all$/i }).getAttribute("data-active")).toBeNull();
  });

  it("calls onChange with the option key when clicked", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<MarketplaceSubfilterChips value="all" onChange={onChange} options={SORT_OPTIONS} />);
    await user.click(screen.getByRole("button", { name: /featured/i }));
    expect(onChange).toHaveBeenCalledWith("featured");
  });

  it("renders an optional count next to a label", () => {
    const opts = [
      { key: "all", label: "All", count: 50 },
      { key: "x", label: "X", count: 6 },
    ] as const;
    render(<MarketplaceSubfilterChips value="all" onChange={vi.fn()} options={opts} />);
    expect(screen.getByRole("button", { name: /^all/i }).textContent).toMatch(/50/);
    expect(screen.getByRole("button", { name: /^x/i }).textContent).toMatch(/6/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ui/src/components/marketplace/__tests__/MarketplaceSubfilterChips.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```tsx
// ui/src/components/marketplace/MarketplaceSubfilterChips.tsx
import { cn } from "@/lib/utils";

export interface MarketplaceSubfilterOption {
  key: string;
  label: string;
  /** Optional count rendered as a dim suffix. */
  count?: number;
}

export interface MarketplaceSubfilterChipsProps {
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<MarketplaceSubfilterOption>;
  className?: string;
}

/**
 * Smaller "ghost" sub-filter chip row. Used on the marketplace hub for sort
 * mode (All / Featured / Recently added / A–Z) and reused on the package
 * detail page (Phase C) for flow stages (Think / Plan / Build / …).
 */
export function MarketplaceSubfilterChips({ value, onChange, options, className }: MarketplaceSubfilterChipsProps) {
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {options.map((opt) => {
        const isActive = value === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            data-active={isActive ? "true" : undefined}
            onClick={() => onChange(opt.key)}
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-colors",
              isActive
                ? "text-foreground bg-card-2"
                : "text-dim hover:text-foreground hover:bg-card",
            )}
          >
            <span>{opt.label}</span>
            {opt.count !== undefined && (
              <span className="opacity-60 text-[10.5px]">{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ui/src/components/marketplace/__tests__/MarketplaceSubfilterChips.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/marketplace/MarketplaceSubfilterChips.tsx ui/src/components/marketplace/__tests__/MarketplaceSubfilterChips.test.tsx
git commit -m "feat(ui): add MarketplaceSubfilterChips for sort/group sub-row"
```

---

## Task 7: Migrate `Marketplace.tsx` (hub) to LobbyShell

**Files:**
- Modify: `ui/src/pages/Marketplace.tsx`
- Modify: `ui/src/__tests__/Marketplace.test.tsx`

Wraps the page in `<LobbyShell activeItem="marketplace" defaultCollapsed={true} onCreateCompany={...}>`. Removes the `<MarketplaceLayout>` wrapper. Replaces the 4-grid of type pills + scrollable category chips with `<MarketplaceFilterChips>` + `<MarketplaceSubfilterChips>`. Keeps existing data flow (`useCatalog`, sort, search). Drops categories from the hub UI (deferred to a future phase — `MarketplaceSearch.tsx` already accepts `?category=` and continues to work).

The new sort modes mapped from existing logic:
- `"all"` → no filter, no specific sort (use existing `popular` ordering: trust tier desc, then name asc).
- `"featured"` → filter `item.featured === true`.
- `"recent"` → sort by `addedAt` desc.
- `"az"` → sort by `name` asc.

Uses the dialog context (`useDialog`) to wire the LobbyShell `onCreateCompany` to `openOnboarding()`.

The mobile hamburger sits in the top-left of the page content via `<LobbyShellMobileMenuButton />`.

- [ ] **Step 1: Write the failing test (replace existing test file)**

```tsx
// ui/src/__tests__/Marketplace.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext, mockDialogContext } from "./test-utils";
import Marketplace from "../pages/Marketplace";
import type { CatalogItem, MarketplaceCatalogFile } from "@armyofagents/shared";

const mockCatalog: MarketplaceCatalogFile = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-05-01T00:00:00Z",
  itemCount: 4,
  items: [
    {
      id: "skill:office-hours", type: "skill", name: "/office-hours",
      description: "YC product interrogation", version: "1.0.0",
      source: { adapter: "github", url: "https://github.com/garrytan/gstack", locator: "office-hours" },
      trust: { tier: "verified", source: "x" }, status: "active", addedAt: "2026-05-01T00:00:00Z",
      category: "engineering", tags: ["featured"], featured: true,
    } as CatalogItem,
    {
      id: "plugin:gh", type: "plugin", name: "github-issues",
      description: "GH sync", version: "1.0.0",
      source: { adapter: "github", url: "https://github.com/anthropic/plugin-gh", locator: "github-issues" },
      npm: { packageName: "@aoa/gh", version: "1.0.0" },
      trust: { tier: "verified", source: "x" }, status: "active", addedAt: "2026-05-02T00:00:00Z",
      category: "integrations", tags: [],
    } as CatalogItem,
    {
      id: "agent:claude-eng", type: "agent", name: "claude-engineer",
      description: "Engineer agent", version: "1.0.0",
      source: { adapter: "github", url: "https://github.com/anthropic/agents", locator: "claude-engineer" },
      trust: { tier: "community", source: "x" }, status: "active", addedAt: "2026-04-01T00:00:00Z",
      category: "engineering", tags: [],
    } as CatalogItem,
    {
      id: "team:product", type: "team", name: "product-team",
      description: "Multi-agent product team", version: "1.0.0",
      source: { adapter: "github", url: "https://github.com/aoa/teams", locator: "product-team" },
      trust: { tier: "community", source: "x" }, status: "active", addedAt: "2026-03-01T00:00:00Z",
      category: "engineering", tags: [],
    } as CatalogItem,
  ],
};

vi.mock("@/hooks/useCatalog", () => ({
  useCatalog: () => ({ data: mockCatalog, isLoading: false, error: null }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn().mockReturnValue({ data: [], isLoading: false }),
  };
});

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("@/context/DialogContext", () => ({ useDialog: () => mockDialogContext }));

vi.mock("@/components/LobbySidebar", () => ({
  LobbySidebar: () => <aside data-testid="lobby-sidebar" />,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: any) => <>{children}</>,
  SheetContent: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/components/UserMenu", () => ({ UserMenu: () => <div /> }));

describe("Marketplace (hub)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders inside LobbyShell with marketplace active", () => {
    renderWithProviders(<Marketplace />);
    expect(screen.getAllByTestId("lobby-sidebar").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the filter chip row with all 5 chips", () => {
    renderWithProviders(<Marketplace />);
    expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skills/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /plugins/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /agents/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /teams/i })).toBeInTheDocument();
  });

  it("clicking the Skills chip filters the grid to skill items", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Marketplace />);
    await user.click(screen.getByRole("button", { name: /skills/i }));
    // Skill is shown, plugin name is not.
    expect(screen.getByText("/office-hours")).toBeInTheDocument();
    expect(screen.queryByText("github-issues")).not.toBeInTheDocument();
  });

  it("renders the sub-filter chip row with sort modes", () => {
    renderWithProviders(<Marketplace />);
    expect(screen.getByRole("button", { name: /featured$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /recently added/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /a–z/i })).toBeInTheDocument();
  });

  it("clicking Featured filters to items with featured=true", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Marketplace />);
    await user.click(screen.getByRole("button", { name: /featured$/i }));
    expect(screen.getByText("/office-hours")).toBeInTheDocument();
    expect(screen.queryByText("github-issues")).not.toBeInTheDocument();
  });

  it("renders a mobile hamburger button (md:hidden)", () => {
    renderWithProviders(<Marketplace />);
    expect(screen.getByRole("button", { name: /open menu/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run ui/src/__tests__/Marketplace.test.tsx`
Expected: FAIL — Marketplace still uses MarketplaceLayout, no filter chips, no LobbyShell.

- [ ] **Step 3: Rewrite `Marketplace.tsx`**

```tsx
// ui/src/pages/Marketplace.tsx
import { useState, useMemo, useRef, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompany } from "@/context/CompanyContext";
import { useDialog } from "@/context/DialogContext";
import { useCatalog } from "@/hooks/useCatalog";
import { CatalogCard } from "@/components/marketplace/CatalogCard";
import { MarketplaceFilterChips } from "@/components/marketplace/MarketplaceFilterChips";
import { MarketplaceSubfilterChips } from "@/components/marketplace/MarketplaceSubfilterChips";
import { LobbyShell, LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { filterByType } from "@/api/marketplace";
import type {
  MarketplaceItemType,
  MarketplaceCatalogItem,
  PluginRecord,
} from "@armyofagents/shared";

type SortMode = "all" | "featured" | "recent" | "az";
const SORT_OPTIONS = [
  { key: "all", label: "All" },
  { key: "featured", label: "Featured" },
  { key: "recent", label: "Recently added" },
  { key: "az", label: "A–Z" },
] as const;

const TRUST_RANK: Record<string, number> = { verified: 2, community: 1, unverified: 0 };

function applySort(items: MarketplaceCatalogItem[], mode: SortMode): MarketplaceCatalogItem[] {
  if (mode === "featured") {
    return items.filter((it) => it.featured === true);
  }
  if (mode === "recent") {
    return [...items].sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""));
  }
  if (mode === "az") {
    return [...items].sort((a, b) => a.name.localeCompare(b.name));
  }
  // "all" — default rank: trust desc, then name asc
  return [...items].sort((a, b) => {
    const ta = TRUST_RANK[a.trust.tier] ?? 0;
    const tb = TRUST_RANK[b.trust.tier] ?? 0;
    if (tb !== ta) return tb - ta;
    return a.name.localeCompare(b.name);
  });
}

export default function Marketplace() {
  const { data: catalog, isLoading, error } = useCatalog();
  const { openOnboarding } = useDialog();
  useCompany();

  const { data: installedPlugins } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });
  const installedByPackageName = useMemo(
    () => new Map((installedPlugins ?? []).map((p: PluginRecord) => [p.packageName, p])),
    [installedPlugins],
  );

  const [searchParams] = useSearchParams();
  const [selectedType, setSelectedType] = useState<MarketplaceItemType | null>(() => {
    const t = searchParams.get("type");
    return t === "plugin" || t === "skill" || t === "agent" || t === "team" ? t : null;
  });
  const [sortMode, setSortMode] = useState<SortMode>("all");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl+K to focus search.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const items = useMemo(() => catalog?.items ?? [], [catalog]);

  const typeCounts = useMemo<Partial<Record<MarketplaceItemType, number>>>(
    () => ({
      skill: filterByType(items, "skill").length,
      plugin: filterByType(items, "plugin").length,
      agent: filterByType(items, "agent").length,
      team: filterByType(items, "team").length,
    }),
    [items],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = items;
    if (selectedType) list = list.filter((it) => it.type === selectedType);
    if (q) {
      list = list.filter(
        (it) =>
          it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q),
      );
    }
    return applySort(list, sortMode);
  }, [items, selectedType, search, sortMode]);

  return (
    <LobbyShell activeItem="marketplace" defaultCollapsed onCreateCompany={() => openOnboarding()}>
      <div className="mx-auto w-full max-w-[1080px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
        <LobbyShellMobileMenuButton className="mb-4" />

        {/* Heading */}
        <div className="mb-5">
          <h1 className="text-[1.55rem] font-bold tracking-tight">
            Marketplace<span className="text-brand">.</span>
          </h1>
          <p className="mt-1 text-[0.86rem] text-dim">
            Skills, plugins, agents, and teams — installable from any GitHub repo.
          </p>
        </div>

        {/* Search */}
        <div className="mb-3 relative">
          <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-very-dim pointer-events-none" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search marketplace…"
            className="w-full h-9 pl-9 pr-3 rounded-md bg-card border border-border text-sm placeholder:text-very-dim focus:outline-none focus:border-border-strong"
          />
        </div>

        {/* Filter chips (type) */}
        <div className="mb-4">
          <MarketplaceFilterChips value={selectedType} onChange={setSelectedType} counts={typeCounts} />
        </div>

        {/* Sub-filter chips (sort/discover) */}
        <div className="mb-5">
          <MarketplaceSubfilterChips
            value={sortMode}
            onChange={(v) => setSortMode(v as SortMode)}
            options={SORT_OPTIONS}
          />
        </div>

        {/* Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-xl border border-border bg-card p-6 text-sm text-dim">
            Failed to load catalog.
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-6 text-sm text-dim text-center">
            No matches.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {visible.map((item) => (
              <CatalogCard
                key={item.id}
                item={item}
                installedByPackageName={installedByPackageName}
              />
            ))}
          </div>
        )}
      </div>
    </LobbyShell>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run ui/src/__tests__/Marketplace.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/Marketplace.tsx ui/src/__tests__/Marketplace.test.tsx
git commit -m "feat(ui): migrate Marketplace hub to LobbyShell + filter chip nav"
```

---

## Task 8: Migrate `MarketplaceSearch.tsx` to LobbyShell

**Files:**
- Modify: `ui/src/pages/MarketplaceSearch.tsx`
- Modify: `ui/src/__tests__/MarketplaceSearch.test.tsx`

Smaller change — just swap the chrome wrapper. Existing search/group logic is preserved verbatim.

- [ ] **Step 1: Read the existing test to see what it asserts**

Run: `cat ui/src/__tests__/MarketplaceSearch.test.tsx`
Note: existing 3 tests assert (1) renders typeahead, (2) renders groups, (3) renders empty state. They reference `MarketplaceLayout` → need updating to `LobbyShell`.

- [ ] **Step 2: Rewrite the test header to mock LobbyShell deps and assert sidebar present**

Open `ui/src/__tests__/MarketplaceSearch.test.tsx` and replace the existing top-of-file mocks block with:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext, mockDialogContext } from "./test-utils";
import MarketplaceSearch from "../pages/MarketplaceSearch";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("@/context/DialogContext", () => ({ useDialog: () => mockDialogContext }));

vi.mock("@/components/LobbySidebar", () => ({
  LobbySidebar: () => <aside data-testid="lobby-sidebar" />,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: any) => <>{children}</>,
  SheetContent: ({ children }: any) => <>{children}</>,
}));
vi.mock("@/components/UserMenu", () => ({ UserMenu: () => <div /> }));
```

(The other existing mocks for `useCatalog`, `pluginsApi`, etc. stay as-is.)

- [ ] **Step 3: Add a new test that asserts LobbyShell is present**

Append to the describe block:

```tsx
it("renders inside LobbyShell with marketplace active", () => {
  renderWithProviders(<MarketplaceSearch />);
  expect(screen.getAllByTestId("lobby-sidebar").length).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run ui/src/__tests__/MarketplaceSearch.test.tsx`
Expected: FAIL — `lobby-sidebar` testid not found (page still renders MarketplaceLayout).

- [ ] **Step 5: Update `MarketplaceSearch.tsx` chrome**

Open `ui/src/pages/MarketplaceSearch.tsx`. Change:
- Replace import line `import { MarketplaceLayout } from "@/components/marketplace/MarketplaceLayout";` with:

```tsx
import { LobbyShell, LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { useDialog } from "@/context/DialogContext";
```

- Inside the component, after destructuring `useSearchParams`, add:

```tsx
const { openOnboarding } = useDialog();
```

- Replace the outer `<MarketplaceLayout breadcrumbs={[{ label: "Search" }]} actions={undefined}> ... </MarketplaceLayout>` with:

```tsx
<LobbyShell activeItem="marketplace" defaultCollapsed onCreateCompany={() => openOnboarding()}>
  <div className="mx-auto w-full max-w-[1080px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
    <LobbyShellMobileMenuButton className="mb-4" />
    {/* … existing search/group body … */}
  </div>
</LobbyShell>
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run ui/src/__tests__/MarketplaceSearch.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/MarketplaceSearch.tsx ui/src/__tests__/MarketplaceSearch.test.tsx
git commit -m "refactor(ui): migrate MarketplaceSearch to LobbyShell"
```

---

## Task 9: Migrate `MarketplaceDetail.tsx` to LobbyShell + verified-checkmark hero

**Files:**
- Modify: `ui/src/pages/MarketplaceDetail.tsx`
- Modify: `ui/src/__tests__/MarketplaceDetail.test.tsx`

Two changes:
1. Wrap the page in `LobbyShell` with `defaultCollapsed`.
2. Replace the `<TrustBadge tier={...} />` pill in the hero with a `<BadgeCheck>` icon next to the item name (only when `trust.tier === "verified"`). The TrustBadge component itself **stays in the codebase** (it's not deleted — it might still be used elsewhere or in future detail-page copy). For Phase A we just stop calling it from this hero.

The existing breadcrumb-style back link from `MarketplaceLayout` is replaced by an inline chevron-back link inside the page content (matches v3 mock View 4 — "Marketplace · Skills" with `<ChevronLeft />`).

- [ ] **Step 1: Read the existing detail-page hero block**

Run: `grep -n "TrustBadge" ui/src/pages/MarketplaceDetail.tsx | head -5`
Note the line where `<TrustBadge>` is rendered in the hero.

- [ ] **Step 2: Update the existing test mocks (chrome stubs)**

Open `ui/src/__tests__/MarketplaceDetail.test.tsx` and add (after existing mocks):

```tsx
vi.mock("@/components/LobbySidebar", () => ({
  LobbySidebar: () => <aside data-testid="lobby-sidebar" />,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: any) => <>{children}</>,
  SheetContent: ({ children }: any) => <>{children}</>,
}));
vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: vi.fn() }),
}));
vi.mock("@/components/UserMenu", () => ({ UserMenu: () => <div /> }));
```

- [ ] **Step 3: Add a new assertion to the test file**

Add inside the existing describe block:

```tsx
it("renders inside LobbyShell with marketplace active", () => {
  // ... use existing setup that renders MarketplaceDetail with a verified item ...
  // (Reuse the existing test's render helper.)
  expect(screen.getAllByTestId("lobby-sidebar").length).toBeGreaterThanOrEqual(1);
});

it("renders a verified-blue checkmark for verified items in the hero", () => {
  // Render with a verified item.
  const { container } = renderDetail({ trust: { tier: "verified", source: "x" } });
  expect(container.querySelector('[data-testid="hero-verified"]')).toBeTruthy();
});

it("does NOT render the verified checkmark for community items", () => {
  const { container } = renderDetail({ trust: { tier: "community", source: "x" } });
  expect(container.querySelector('[data-testid="hero-verified"]')).toBeNull();
});
```

(If `renderDetail` does not exist as a helper, add a small helper at the top of the test file that wraps the existing setup — same pattern as the other tests.)

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run ui/src/__tests__/MarketplaceDetail.test.tsx`
Expected: FAIL — `lobby-sidebar` testid missing, `hero-verified` testid missing.

- [ ] **Step 5: Update `MarketplaceDetail.tsx`**

Edits to make in this file:

1. **Imports** — replace:

```tsx
import { MarketplaceLayout } from "@/components/marketplace/MarketplaceLayout";
import { TrustBadge } from "@/components/marketplace/TrustBadge";
```

with:

```tsx
import { LobbyShell, LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { useDialog } from "@/context/DialogContext";
import { BadgeCheck, ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";
```

2. **Inside the component**, after existing hooks, add:

```tsx
const { openOnboarding } = useDialog();
```

3. **Replace the `<MarketplaceLayout ...>` wrapper** with:

```tsx
<LobbyShell activeItem="marketplace" defaultCollapsed onCreateCompany={() => openOnboarding()}>
  <div className="mx-auto w-full max-w-[920px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
    <LobbyShellMobileMenuButton className="mb-4" />
    <Link
      to="/marketplace"
      className="mb-4 inline-flex items-center gap-1 text-[12px] text-very-dim hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" /> Marketplace · {TYPE_LABELS_PLURAL[itemType!]}
    </Link>
    {/* … existing hero + body content … */}
  </div>
</LobbyShell>
```

4. **In the hero block** — find the line that renders `<TrustBadge tier={item.trust.tier} ... />` and replace with:

```tsx
{item.trust.tier === "verified" && (
  <BadgeCheck
    data-testid="hero-verified"
    className="size-5 shrink-0 text-[hsl(208_80%_60%)]"
    aria-label="Verified"
  />
)}
```

(Place this `<BadgeCheck>` immediately after the `<h1>{item.name}</h1>` element, inside the same flex row.)

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run ui/src/__tests__/MarketplaceDetail.test.tsx`
Expected: PASS — all existing 7 tests + 3 new = 10 tests.

- [ ] **Step 7: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add ui/src/pages/MarketplaceDetail.tsx ui/src/__tests__/MarketplaceDetail.test.tsx
git commit -m "feat(ui): migrate MarketplaceDetail to LobbyShell + verified-check hero"
```

---

## Task 10: Migrate `MarketplaceUpdates.tsx` to LobbyShell

**Files:**
- Modify: `ui/src/pages/MarketplaceUpdates.tsx`

Smallest change — chrome swap only. No new tests added (no test file currently for this page; deferred). Run typecheck after.

- [ ] **Step 1: Update `MarketplaceUpdates.tsx`**

Edits:

1. **Imports** — replace:

```tsx
import { MarketplaceLayout } from "@/components/marketplace/MarketplaceLayout";
```

with:

```tsx
import { LobbyShell, LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { useDialog } from "@/context/DialogContext";
```

2. **Inside the component**, after existing hooks, add:

```tsx
const { openOnboarding } = useDialog();
```

3. **Replace** every `<MarketplaceLayout breadcrumbs={[{ label: "Updates" }]} actions={undefined}>...</MarketplaceLayout>` (there are 2 — one in the loading state, one in the main render) with:

```tsx
<LobbyShell activeItem="marketplace" defaultCollapsed onCreateCompany={() => openOnboarding()}>
  <div className="mx-auto w-full max-w-[1080px] px-4 py-6 sm:px-6 sm:py-7 md:px-10 md:py-9">
    <LobbyShellMobileMenuButton className="mb-4" />
    {/* … existing body content … */}
  </div>
</LobbyShell>
```

- [ ] **Step 2: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Run the full marketplace test suite to ensure no regression**

Run: `pnpm vitest run src/__tests__/Marketplace*.test.tsx src/components/marketplace/__tests__ --reporter=basic`
Expected: all pass (the existing MarketplaceLayout test will fail — it gets removed in Task 11).

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/MarketplaceUpdates.tsx
git commit -m "refactor(ui): migrate MarketplaceUpdates to LobbyShell"
```

---

## Task 11: Delete `MarketplaceLayout`, `TypeTile`, `CategoryTile`

**Files:**
- Delete: `ui/src/components/marketplace/MarketplaceLayout.tsx`
- Delete: `ui/src/__tests__/MarketplaceLayout.test.tsx`
- Delete: `ui/src/components/marketplace/TypeTile.tsx`
- Delete: `ui/src/components/marketplace/CategoryTile.tsx`

Drop the now-unused components. Verify no consumers remain before deleting.

- [ ] **Step 1: Confirm no consumers remain**

Run from repo root:

```bash
grep -rln "MarketplaceLayout\b" ui/src --include="*.ts" --include="*.tsx" | grep -v "__tests__/MarketplaceLayout.test.tsx"
grep -rln "TypeTile\|CategoryTile" ui/src --include="*.ts" --include="*.tsx"
```

Expected: both commands print nothing (no remaining consumers).

If either prints anything, **stop and investigate** — there's a stale reference that needs updating before deletion.

- [ ] **Step 2: Delete the files**

```bash
rm ui/src/components/marketplace/MarketplaceLayout.tsx
rm ui/src/__tests__/MarketplaceLayout.test.tsx
rm ui/src/components/marketplace/TypeTile.tsx
rm ui/src/components/marketplace/CategoryTile.tsx
```

- [ ] **Step 3: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: no output.

- [ ] **Step 4: Run the full UI test suite to confirm nothing broke**

Run from `ui/`: `pnpm vitest run --reporter=basic`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(ui): remove unused MarketplaceLayout, TypeTile, CategoryTile"
```

---

## Task 12: Final verification + browser smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full UI test suite**

Run from `ui/`: `pnpm vitest run --reporter=basic`
Expected: all tests pass. Compare test count to baseline (before plan: 1055 passing). Should be: 1055 - 2 (removed MarketplaceLayout tests) + 6 (TypeChip) + 6 (StackedIcon) + 6 (MarketplaceFilterChips) + 4 (MarketplaceSubfilterChips) + 4 (CatalogCard new tests added beyond existing 7) + 1 (Marketplace LobbyShell test) + 1 (MarketplaceSearch LobbyShell) + 3 (MarketplaceDetail new tests) = **1084 passing**. (Approximate; the exact delta depends on whether existing CatalogCard tests survive intact.)

- [ ] **Step 2: Run typecheck**

Run from `ui/`: `pnpm exec tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Browser smoke — start the dev server (already running from prior Lobby work)**

Verify both servers are still running via the preview MCP. If not:

```bash
# From repo root, in two separate background processes:
pnpm --filter ui dev
# and:
cd server && AOA_MIGRATION_AUTO_APPLY=true pnpm exec tsx src/index.ts
```

- [ ] **Step 4: Browser smoke — visit `/marketplace` and verify visual parity to v3 mock**

In the preview browser:
1. Navigate to `http://localhost:5175/marketplace`.
2. Verify primary sidebar is auto-collapsed to 56px.
3. Verify filter chip row renders (All / Skills / Plugins / Agents / Teams) with counts.
4. Verify sub-chip row renders (All / Featured / Recently added / A–Z).
5. Verify cards render with: top-right type chip, verified-blue checkmark for verified items, owner/repo on left of footer, install button on right.
6. Click "Skills" filter → grid filters to skill items.
7. Click "Featured" sub-chip → grid filters to featured items.
8. Click any card → navigates to `/marketplace/:type/:slug`.
9. On detail page: verify LobbyShell chrome, verified checkmark in hero (if verified), chevron-back link.
10. Click chevron-back → returns to `/marketplace`.

Capture a screenshot of the hub page for the PR.

- [ ] **Step 5: Browser smoke — mobile viewport**

Resize preview to 375×812. Verify:
- Hamburger button visible at top-left of content.
- Click hamburger → drawer opens with full sidebar (Organizations / Marketplace active / Learn / Docs / Settings).
- Cards stack to 1 column.
- Filter + sub-filter chips wrap to multiple lines.

- [ ] **Step 6: Final commit (if any uncommitted polish)**

If the smoke surfaced any small fix-ups (e.g., padding tweak, broken filter), commit them as a small `polish(ui):` commit. Otherwise nothing to do.

---

## Out-of-scope (explicit deferrals)

- **Skill packages model** — `packageId` field, `packages` ingest grouping rule, package-list API endpoint. **Phase B.**
- **Skill package detail page** + 2-col compact skill grid + "Part of X" badge above name. **Phase C.**
- **Star rating + download counts** — schema fields don't exist. Footer renders only the GitHub source URL until backend metrics land.
- **Categories chip row** on hub — dropped from Phase A (matches v3 mock). Categories continue to work as a `/marketplace/search?category=` URL refinement; the visible category UI returns later as a search-page facet.
- **"Most installed" / "Trending" sub-chips** — not in Phase A; no analytics data backing them.
- **Instance Settings → LobbyShell** — **Phase D.** Settings remains as-is until Phase A ships and reviews well.
- **`MarketplaceType.tsx`** — already a redirect-only `MarketplaceTypeRedirect` component in `App.tsx`. No change needed.
