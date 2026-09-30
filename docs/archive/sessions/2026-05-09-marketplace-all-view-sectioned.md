# Marketplace Sectioned All-View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the marketplace "All" view into four type-grouped sections (Skills, Plugins, Agents, Teams) with the Packages strip nested inside Skills, and fix `derivePackages` so synthesis is skill-only while explicit `packageId` overrides remain type-permissive.

**Architecture:** Two surface changes — a one-function backend tweak and a render-branch refactor on the marketplace hub. Reuses the existing `CatalogCard`, `PackageCard`, `MarketplaceFilterChips`, `MarketplaceSubfilterChips` components. No new components, schema, routes, or shared types.

**Tech Stack:** React 18 + Vite + TailwindCSS, Vitest, lucide-react. Backend in TypeScript / Node. Tests use `@testing-library/react` and `@testing-library/user-event`.

---

## File Structure

Files touched:

| File | Change |
|------|--------|
| `server/src/services/derivePackages.ts` | Add `type === "skill"` guard inside the synthesis branch only |
| `server/src/services/__tests__/derivePackages.test.ts` | Add coverage for non-skill suppression + loose explicit policy |
| `ui/src/pages/Marketplace.tsx` | Inline `SectionHeader` + four-section render branch + single-section render branch |
| `ui/src/__tests__/Marketplace.test.tsx` | Update one existing assertion + add coverage for the new sections |

No new files.

**Reference spec:** `docs/superpowers/specs/2026-05-09-marketplace-all-view-sectioned-design.md`

---

## Task 1: Backend — failing tests for skill-only synthesis

**Files:**
- Modify: `server/src/services/__tests__/derivePackages.test.ts` (append cases at end of `describe`)

- [ ] **Step 1: Write the failing tests**

Append these `it()` blocks before the closing `});` of the `describe("derivePackages", ...)` block in `server/src/services/__tests__/derivePackages.test.ts`:

```ts
  it("does NOT synthesize a package from two plugins in the same github repo", () => {
    const items = [
      makeItem({ id: "plugin:a", type: "plugin", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "plugin:b", type: "plugin", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
    ];
    expect(derivePackages(items)).toEqual([]);
  });

  it("does NOT synthesize a package from two agents in the same github repo", () => {
    const items = [
      makeItem({ id: "agent:a", type: "agent", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "agent:b", type: "agent", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
    ];
    expect(derivePackages(items)).toEqual([]);
  });

  it("does NOT synthesize a package from two teams in the same github repo", () => {
    const items = [
      makeItem({ id: "team:a", type: "team", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "team:b", type: "team", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
    ];
    expect(derivePackages(items)).toEqual([]);
  });

  it("excludes non-skill items from synthesis even when mixed with skills below threshold", () => {
    const items = [
      makeItem({ id: "skill:a", type: "skill", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "plugin:b", type: "plugin", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
    ];
    // Only the skill survives the type guard, but the threshold is 2 skills → no package emitted.
    expect(derivePackages(items)).toEqual([]);
  });

  it("synthesizes a skill-only package even when mixed with non-skill items in the same repo", () => {
    const items = [
      makeItem({ id: "skill:a", type: "skill", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
      makeItem({ id: "skill:b", type: "skill", source: { adapter: "g", url: "https://github.com/o/r/tree/main/b", locator: "b" } }),
      makeItem({ id: "plugin:c", type: "plugin", source: { adapter: "g", url: "https://github.com/o/r/tree/main/c", locator: "c" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]!.id).toBe("o/r");
    expect(packages[0]!.memberItemIds).toEqual(["skill:a", "skill:b"]);
  });

  it("loose policy: explicit packageId on a single plugin still emits a package", () => {
    const items = [
      makeItem({ id: "plugin:lone", type: "plugin", packageId: "curated-plugin-bundle", source: { adapter: "g", url: "https://github.com/anywhere/x", locator: "x" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      id: "curated-plugin-bundle",
      explicit: true,
      count: 1,
      memberItemIds: ["plugin:lone"],
    });
  });

  it("loose policy: explicit packageId pulls a plugin and an agent into one mixed-type package", () => {
    const items = [
      makeItem({ id: "plugin:p", type: "plugin", packageId: "joint", source: { adapter: "g", url: "https://github.com/o/r/tree/main/p", locator: "p" } }),
      makeItem({ id: "agent:a", type: "agent", packageId: "joint", source: { adapter: "g", url: "https://github.com/o/r/tree/main/a", locator: "a" } }),
    ];
    const packages = derivePackages(items);
    expect(packages).toHaveLength(1);
    expect(packages[0]!.id).toBe("joint");
    expect(packages[0]!.memberItemIds.sort()).toEqual(["agent:a", "plugin:p"]);
    expect(packages[0]!.explicit).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @armyofagents/server test:run -- derivePackages`

Expected: 7 new tests fail (all assert that non-skill synthesis is suppressed; the current code synthesizes them). The 13 pre-existing tests should still pass because they all default to `type: "skill"` via `makeItem`.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/__tests__/derivePackages.test.ts
git commit -m "$(cat <<'EOF'
test(server): cover skill-only synthesis + loose explicit packageId

Adds failing tests for the upcoming derivePackages refactor: non-skill
catalog items must not synthesize into packages, while explicit
packageId on any type still produces a package.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Backend — implement skill-only synthesis filter

**Files:**
- Modify: `server/src/services/derivePackages.ts:37-50`

- [ ] **Step 1: Add the type guard inside the synthesis branch**

Replace the `for (const item of items)` loop body in `server/src/services/derivePackages.ts:37-50` with:

```ts
  for (const item of items) {
    const explicitId = item.packageId?.trim();
    if (explicitId) {
      // Explicit packageId is loose-typed: catalog authors can opt in to
      // mixed-type or non-skill packages by setting this field.
      const list = explicitGroups.get(explicitId);
      if (list) list.push(item);
      else explicitGroups.set(explicitId, [item]);
      continue;
    }
    // Synthesis is skill-only. A plugin/agent/team is its own atomic catalog
    // entry — bundling them by repo would mis-render them with the
    // skill-themed PackageCard.
    if (item.type !== "skill") continue;
    const root = repoRootFromUrl(item.source.url);
    if (!root) continue;
    const list = synthesizedGroups.get(root);
    if (list) list.push(item);
    else synthesizedGroups.set(root, [item]);
  }
```

- [ ] **Step 2: Run tests to verify they all pass**

Run: `pnpm --filter @armyofagents/server test:run -- derivePackages`

Expected: 20 tests pass (13 pre-existing + 7 new).

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @armyofagents/server typecheck`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/derivePackages.ts
git commit -m "$(cat <<'EOF'
fix(server): restrict package synthesis to skill items

The PackageCard's amber + Sparkles visual language was always intended
for skills only. Synthesizing a package from plugins, agents, or teams
that happened to share a github repo mis-rendered them as skill
packages.

Synthesis now requires every member to be a skill. Explicit packageId
overrides remain loose-typed — catalog authors who deliberately ship
a non-skill or mixed-type package can still do so.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Frontend — define section constants + inline `SectionHeader`

**Files:**
- Modify: `ui/src/pages/Marketplace.tsx`

This task only adds code; no behavior change yet. We wire the new component into the render in Task 4.

- [ ] **Step 1: Add the constants and the `SectionHeader` component**

Insert this block in `ui/src/pages/Marketplace.tsx` after the `applySort` function (around line 51, before `export default function Marketplace()`):

```tsx
const SECTION_CAP = 6;

const SECTION_ICONS: Record<MarketplaceItemType, ComponentType<{ className?: string }>> = {
  skill: Sparkles,
  plugin: Puzzle,
  agent: Bot,
  team: Bot, // matches MarketplaceFilterChips — StackedIcon is card-only
};

const SECTION_TONES: Record<MarketplaceItemType, string> = {
  skill: "bg-amber-500/15 border-amber-500/30 text-amber-500",
  plugin: "bg-blue-500/15 border-blue-500/30 text-blue-500",
  agent: "bg-purple-500/15 border-purple-500/30 text-purple-500",
  team: "bg-teal-500/15 border-teal-500/30 text-teal-500",
};

const SECTION_LABELS: Record<MarketplaceItemType, string> = {
  skill: "Skills",
  plugin: "Plugins",
  agent: "Agents",
  team: "Teams",
};

const SECTION_ORDER: ReadonlyArray<MarketplaceItemType> = ["skill", "plugin", "agent", "team"];

interface SectionHeaderProps {
  type: MarketplaceItemType;
  total: number;
  showSeeAll: boolean;
  onSeeAll: () => void;
}

function SectionHeader({ type, total, showSeeAll, onSeeAll }: SectionHeaderProps) {
  const Icon = SECTION_ICONS[type];
  const tone = SECTION_TONES[type];
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-dim">
        <span className={cn("inline-flex size-5 items-center justify-center rounded-md border", tone)}>
          <Icon className="size-3" />
        </span>
        {SECTION_LABELS[type]}
        <span className="text-very-dim font-normal normal-case tracking-normal">· {total}</span>
      </h2>
      {showSeeAll && (
        <button
          type="button"
          onClick={onSeeAll}
          className="text-[12px] text-dim hover:text-foreground"
        >
          See all →
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update imports at the top of `ui/src/pages/Marketplace.tsx`**

Replace the existing imports section (lines 1–22) with:

```tsx
import { useState, useMemo, useRef, useEffect, type ComponentType } from "react";
import { useSearchParams } from "react-router-dom";
import { Bot, Puzzle, Search, Sparkles } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompany } from "@/context/CompanyContext";
import { useDialog } from "@/context/DialogContext";
import { useCatalog } from "@/hooks/useCatalog";
import { usePackages } from "@/hooks/usePackages";
import { CatalogCard } from "@/components/marketplace/CatalogCard";
import { PackageCard } from "@/components/marketplace/PackageCard";
import { MarketplaceFilterChips } from "@/components/marketplace/MarketplaceFilterChips";
import { MarketplaceSubfilterChips } from "@/components/marketplace/MarketplaceSubfilterChips";
import { LobbyShell, LobbyShellMobileMenuButton } from "@/components/LobbyShell";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { filterByType } from "@/api/marketplace";
import { cn } from "@/lib/utils";
import type {
  MarketplaceItemType,
  MarketplaceCatalogItem,
  PluginRecord,
} from "@armyofagents/shared";
```

- [ ] **Step 3: Run typecheck — should still pass even though `SectionHeader` is unused**

Run: `pnpm --filter @armyofagents/ui typecheck`

Expected: no errors. (TypeScript permits unused local symbols inside a module.)

- [ ] **Step 4: Run existing tests — should still pass**

Run: `pnpm --filter @armyofagents/ui test:run -- Marketplace.test`

Expected: 9 tests pass. No commit yet — the next task is the meaningful change.

---

## Task 4: Frontend — refactor render branch to four sections

**Files:**
- Modify: `ui/src/pages/Marketplace.tsx:114-200` (the JSX returned by `Marketplace`)

- [ ] **Step 1: Replace the render block**

Replace the entire JSX returned from `Marketplace()` (the `return ( … )` block, lines 114–200) with this:

```tsx
  // Group visible (post-search, post-sort) items by type.
  const grouped = useMemo<Record<MarketplaceItemType, MarketplaceCatalogItem[]>>(() => {
    const out: Record<MarketplaceItemType, MarketplaceCatalogItem[]> = {
      skill: [], plugin: [], agent: [], team: [],
    };
    for (const it of visible) out[it.type].push(it);
    return out;
  }, [visible]);

  // Render a single section block. `capped` is the visible-after-cap slice;
  // `total` is the full count used in the header + cap decision.
  function renderSection(type: MarketplaceItemType, capped: MarketplaceCatalogItem[], total: number) {
    if (total === 0) return null;
    const isPackagesHost = type === "skill" && (packages?.length ?? 0) > 0;
    return (
      <section key={type} className="mb-7">
        <SectionHeader
          type={type}
          total={total}
          showSeeAll={selectedType === null && total > SECTION_CAP}
          onSeeAll={() => setSelectedType(type)}
        />
        {isPackagesHost && (
          <div className="mb-4">
            <h3 className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-dim">
              Packages <span className="text-very-dim font-normal">· {packages!.length}</span>
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {packages!.map((pkg) => (
                <PackageCard key={pkg.id} pkg={pkg} />
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {capped.map((item) => (
            <CatalogCard
              key={item.id}
              item={item}
              installedByPackageName={installedByPackageName}
            />
          ))}
        </div>
      </section>
    );
  }

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

        {/* Body */}
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
        ) : selectedType !== null ? (
          // Single-section view: cap removed, "See all" hidden.
          renderSection(selectedType, grouped[selectedType], grouped[selectedType].length)
        ) : (
          // All-view: four sections, capped, with "See all" when overflowing.
          SECTION_ORDER.map((type) => {
            const items = grouped[type];
            return renderSection(type, items.slice(0, SECTION_CAP), items.length);
          })
        )}
      </div>
    </LobbyShell>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck`

Expected: no errors.

- [ ] **Step 3: Run existing tests, expect a partial failure**

Run: `pnpm --filter @armyofagents/ui test:run -- Marketplace.test`

Expected: **1 failure** — the test `"hides the Packages section when a specific type filter is active"` now fails because clicking the *Skills* chip keeps the Packages strip visible (Packages live inside Skills section). Other 8 tests pass. We fix this in Task 5.

- [ ] **Step 4: No commit yet — proceed to Task 5**

---

## Task 5: Frontend — update existing test to match new behavior

**Files:**
- Modify: `ui/src/__tests__/Marketplace.test.tsx:159-165`

When the new design renders, packages live *inside* the Skills section. So clicking the Skills chip *keeps* packages visible. Clicking any *non-Skills* chip (Plugins, Agents, Teams) hides the entire Skills section, and with it, the Packages strip. Update the test to assert this.

- [ ] **Step 1: Replace the failing test**

Replace lines 159–165 of `ui/src/__tests__/Marketplace.test.tsx` (the `it("hides the Packages section when a specific type filter is active", …)` block) with:

```ts
  it("hides the Packages strip when a non-Skills chip is active", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Marketplace />);
    await user.click(screen.getByRole("button", { name: /plugins/i }));
    expect(screen.queryByText(/^packages$/i)).not.toBeInTheDocument();
    expect(screen.queryByText("gstack")).not.toBeInTheDocument();
  });

  it("keeps the Packages strip visible when the Skills chip is active", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Marketplace />);
    await user.click(screen.getByRole("button", { name: /^skills$/i }));
    expect(screen.getByText(/^packages$/i)).toBeInTheDocument();
    expect(screen.getByText("gstack")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @armyofagents/ui test:run -- Marketplace.test`

Expected: 10 tests pass.

- [ ] **Step 3: No commit yet — bundle with new tests in Task 6**

---

## Task 6: Frontend — add tests for the new section behavior

**Files:**
- Modify: `ui/src/__tests__/Marketplace.test.tsx` (add a second `describe` block at the bottom)

The default fixture has exactly one item per type (skill, plugin, agent, team) and one package — too small to exercise the cap. We add a small fixture-builder for the new tests and override `useCatalog` per-test where needed.

- [ ] **Step 1: Add a fixture helper inside the test file**

Append above the existing `describe(...)` (around line 84) — it will be in scope for both `describe` blocks:

```ts
function makeFixtureItem(overrides: Partial<CatalogItem> & Pick<CatalogItem, "id" | "type" | "name">): CatalogItem {
  return {
    description: "fixture item",
    version: "1.0.0",
    source: { adapter: "github", url: "https://github.com/x/y", locator: overrides.id },
    trust: { tier: "community", source: "x" },
    status: "active",
    addedAt: "2026-05-01T00:00:00Z",
    category: "engineering",
    tags: [],
    ...overrides,
  } as CatalogItem;
}
```

- [ ] **Step 2: Append the new `describe` block at the bottom of the file**

Append after the closing `});` of the existing `describe("Marketplace (hub)", …)` block:

```ts
describe("Marketplace (hub) — sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePackages).mockReturnValue({
      data: [], isLoading: false, error: null,
    } as any);
  });

  it("renders all four section headers in order Skills → Plugins → Agents → Teams", () => {
    renderWithProviders(<Marketplace />);
    const headers = screen.getAllByRole("heading", { level: 2 });
    const labels = headers.map((h) => h.textContent?.toLowerCase() ?? "");
    const idxSkill = labels.findIndex((l) => l.includes("skills"));
    const idxPlug = labels.findIndex((l) => l.includes("plugins"));
    const idxAgent = labels.findIndex((l) => l.includes("agents"));
    const idxTeam = labels.findIndex((l) => l.includes("teams"));
    expect(idxSkill).toBeGreaterThanOrEqual(0);
    expect(idxPlug).toBeGreaterThan(idxSkill);
    expect(idxAgent).toBeGreaterThan(idxPlug);
    expect(idxTeam).toBeGreaterThan(idxAgent);
  });

  it("hides a section whose post-filter item count is zero", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Marketplace />);
    // Sort = "Featured" — only office-hours is featured (a skill). Plugins/Agents/Teams sections must hide.
    await user.click(screen.getByRole("button", { name: /featured$/i }));
    const headers = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.toLowerCase() ?? "");
    const has = (label: string) => headers.some((h) => h.includes(label));
    expect(has("skills")).toBe(true);
    expect(has("plugins")).toBe(false);
    expect(has("agents")).toBe(false);
    expect(has("teams")).toBe(false);
  });

  it("clicking 'See all →' on a section sets the type chip to that type", async () => {
    // Override the default catalog so Skills overflows the cap (need > 6 skills)
    const overflow = Array.from({ length: 8 }).map((_, i) =>
      makeFixtureItem({ id: `skill:s${i}`, type: "skill", name: `skill-${i}` }),
    );
    const { useCatalog } = await import("@/hooks/useCatalog");
    vi.mocked(useCatalog).mockReturnValueOnce({
      data: { schemaVersion: "1.0.0", generatedAt: "2026-05-01T00:00:00Z", itemCount: 8, items: overflow },
      isLoading: false, error: null,
    } as any);
    const user = userEvent.setup();
    renderWithProviders(<Marketplace />);
    const seeAll = screen.getByRole("button", { name: /see all/i });
    await user.click(seeAll);
    // After clicking "See all", the Skills chip should be in the active state.
    const skillsChip = screen.getByRole("button", { name: /^skills$/i });
    expect(skillsChip).toHaveAttribute("data-active", "true");
  });

  it("caps each section at SECTION_CAP items in the all-view", async () => {
    const overflow = Array.from({ length: 8 }).map((_, i) =>
      makeFixtureItem({ id: `skill:s${i}`, type: "skill", name: `skill-${i}` }),
    );
    const { useCatalog } = await import("@/hooks/useCatalog");
    vi.mocked(useCatalog).mockReturnValueOnce({
      data: { schemaVersion: "1.0.0", generatedAt: "2026-05-01T00:00:00Z", itemCount: 8, items: overflow },
      isLoading: false, error: null,
    } as any);
    renderWithProviders(<Marketplace />);
    // Only first 6 skill names should render; the 7th and 8th are clipped.
    expect(screen.getByText("skill-0")).toBeInTheDocument();
    expect(screen.getByText("skill-5")).toBeInTheDocument();
    expect(screen.queryByText("skill-6")).not.toBeInTheDocument();
    expect(screen.queryByText("skill-7")).not.toBeInTheDocument();
  });

  it("removes the cap when a single type chip is active (single-section view)", async () => {
    const overflow = Array.from({ length: 8 }).map((_, i) =>
      makeFixtureItem({ id: `skill:s${i}`, type: "skill", name: `skill-${i}` }),
    );
    const { useCatalog } = await import("@/hooks/useCatalog");
    vi.mocked(useCatalog).mockReturnValueOnce({
      data: { schemaVersion: "1.0.0", generatedAt: "2026-05-01T00:00:00Z", itemCount: 8, items: overflow },
      isLoading: false, error: null,
    } as any);
    const user = userEvent.setup();
    renderWithProviders(<Marketplace />);
    await user.click(screen.getByRole("button", { name: /^skills$/i }));
    // All 8 should render now.
    expect(screen.getByText("skill-0")).toBeInTheDocument();
    expect(screen.getByText("skill-7")).toBeInTheDocument();
  });

  it("hides 'See all →' when a section's total fits inside the cap", () => {
    // Default fixture has 1 of each type — far below SECTION_CAP=6.
    renderWithProviders(<Marketplace />);
    expect(screen.queryByRole("button", { name: /see all/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run all marketplace tests**

Run: `pnpm --filter @armyofagents/ui test:run -- Marketplace.test`

Expected: 16 tests pass (10 from original `describe` after Task 5 update + 6 new).

- [ ] **Step 4: Commit (frontend changes + tests bundled)**

```bash
git add ui/src/pages/Marketplace.tsx ui/src/__tests__/Marketplace.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): sectioned 'All' view for marketplace hub

Replaces the flat catalog grid with four type-grouped sections
(Skills, Plugins, Agents, Teams). Each section has an icon + count
header, a 6-item cap, and a 'See all →' link that sets the type chip
to the corresponding type (cap removed in single-section view).

The Packages strip now lives inside the Skills section. Clicking the
Skills chip keeps it visible; clicking any non-Skills chip hides it
along with the rest of the Skills section.

Empty sections (zero items after the active sort/search filter) are
omitted entirely so the page only shows what's actually there.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Smoke verification

Final verification that the full suite passes and the page renders correctly.

- [ ] **Step 1: Run full typecheck**

Run: `pnpm typecheck`

Expected: no errors across all packages.

- [ ] **Step 2: Run full UI test suite**

Run: `pnpm --filter @armyofagents/ui test:run`

Expected: all tests pass.

- [ ] **Step 3: Run full server test suite**

Run: `pnpm --filter @armyofagents/server test:run`

Expected: all tests pass.

- [ ] **Step 4: Manual browser smoke**

Run: `pnpm dev:ui` (in one terminal) + `pnpm dev:server` (in another), or `pnpm dev` to start both.

Visit `http://localhost:5173/marketplace` and verify:
- The "All" view shows distinct **Skills / Plugins / Agents / Teams** sections in that order.
- The Packages strip appears inside Skills (assuming the cached catalog has at least one synthesizable skill package — gstack or anthropic/superpowers if those are in the bundled snapshot).
- No PackageCard appears for plugin-only or agent-only repos.
- Clicking a non-`All` chip collapses to a single section (no cap, "See all →" hidden).
- Clicking "See all →" on a chip-overflowing section activates that chip.
- Sort = "Featured" hides sections with no featured items.

If anything looks off, fix and re-run Task 7 from Step 1.

- [ ] **Step 5: No final commit needed** — Task 1, 2, and 6 are the three commits this plan produces.

---

## Self-review notes

**Spec coverage check:**
- §1 backend filter → Tasks 1, 2 ✓
- §2 section structure (`SectionHeader`, four sections, packages-in-skills, cap) → Tasks 3, 4 ✓
- §3 interactions (chip, "See all →", sort, search, URL) — all preserved by reusing existing state hooks; new behavior covered by Task 6 tests ✓
- §4 edge cases (mixed-type explicit package, empty types, packaged-skill double listing) — implicit in the render logic; mixed-type explicit is asserted in Task 1 backend tests ✓
- §5 tests → Tasks 1 (backend), 5 + 6 (frontend) ✓
- §6 out of scope items not implemented ✓
- §7 risk mitigations: cap is in place (Task 4), loose-policy footgun is documented in Task 2 commit message ✓

**Type consistency check:** `SectionHeader` props (`type`, `total`, `showSeeAll`, `onSeeAll`) match between Task 3 definition and Task 4 call site. `SECTION_CAP`, `SECTION_ICONS`, `SECTION_TONES`, `SECTION_LABELS`, `SECTION_ORDER` all defined in Task 3 and consumed in Task 4. `MarketplaceItemType` imported from `@armyofagents/shared`. `MarketplaceCatalogItem` imported. `cn` imported. No naming drift.

**Placeholder scan:** No "TBD", "TODO", "implement later", or "similar to Task N" placeholders. Every code step contains the actual content.
