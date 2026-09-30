# Marketplace "All" View — Sectioned Layout + Package Synthesis Fix

> **Status:** awaiting user approval before implementation plan is written.
> **Branch context:** `feat/ui-overhaul`. This builds directly on the marketplace hub work in commits `0587519`–`d14d9be`. Frontend-only restructure plus a one-function backend fix.

## Goal

Two related fixes for the marketplace browse page:

1. **Stop synthesizing non-skill packages.** `derivePackages` currently groups any catalog items (skills / plugins / agents / teams) sharing a GitHub `owner/repo` into a "Package" card. The PackageCard's visual language (amber accent, Sparkles icon) was designed for skills only — plugins-as-packages is a bug. Fix: synthesis becomes skill-only. Explicit `packageId` on a catalog item still works for any type (loose policy — a rare escape hatch for catalog authors who deliberately opt in).
2. **Replace the flat "All" grid with type-grouped sections.** Today, picking "All" shows a flat mixed-type grid below the Packages strip. Replace it with four sectioned bands — Skills, Plugins, Agents, Teams — each with a header, count, capped grid, and "See all →" jump to the type-filtered view. Packages live *inside* the Skills section.

## Architecture

```
ui/src/pages/Marketplace.tsx          — restructure render, no new components
server/src/services/derivePackages.ts — add type guard to synthesis branch only
```

Reuses existing `CatalogCard`, `PackageCard`, `MarketplaceFilterChips`, `MarketplaceSubfilterChips`. No new components, no schema changes, no new routes, no new shared types.

## Tech stack

- React + Vite + Tailwind (existing UI stack)
- `lucide-react` icons (Sparkles / Puzzle / Bot — already used by `MarketplaceFilterChips`)
- No new deps

---

## §1 — Backend: package synthesis becomes skill-only

**File:** `server/src/services/derivePackages.ts`

The synthesis branch (the path that does not have an explicit `packageId`) gains a type guard. The explicit branch is unchanged.

```ts
for (const item of items) {
  const explicitId = item.packageId?.trim();
  if (explicitId) {
    // Explicit packageId still accepted on any type (loose policy).
    // Catalog authors can opt in to mixed-type or non-skill packages.
    const list = explicitGroups.get(explicitId);
    if (list) list.push(item);
    else explicitGroups.set(explicitId, [item]);
    continue;
  }
  // Synthesis path: only skills are eligible. A plugin/agent/team is its
  // own atomic catalog entry — bundling them by repo would mis-render
  // them with the skill-themed PackageCard.
  if (item.type !== "skill") continue;
  const root = repoRootFromUrl(item.source.url);
  if (!root) continue;
  const list = synthesizedGroups.get(root);
  if (list) list.push(item);
  else synthesizedGroups.set(root, [item]);
}
```

That's the entire backend change. The id-collision rule (explicit wins over synthesized) and the threshold (`SYNTHESIS_THRESHOLD = 2`) stay as-is.

**Tests** (`server/src/services/__tests__/derivePackages.test.ts`):

Add cases:
- Two plugins in same github repo → no package (synthesis suppressed).
- Two agents in same github repo → no package.
- Two teams in same github repo → no package.
- Mix of one skill + one plugin in same repo → no package (the lone skill fails the threshold).
- Mix of two skills + one plugin in same repo → 1 package containing only the two skills.
- Explicit `packageId` on a plugin (single item) → 1 explicit package containing the plugin (loose policy preserved).
- Explicit `packageId` shared across a plugin + an agent → 1 mixed-type explicit package (loose policy preserved).

Existing skill-only synthesis tests still pass.

---

## §2 — Frontend: section structure for the "All" view

**File:** `ui/src/pages/Marketplace.tsx`

Today the render branch when `selectedType === null` is:

```
[Packages strip]
[Flat mixed-type CatalogCard grid]
```

The new render is four type sections in fixed order — **Skills → Plugins → Agents → Teams** (matches chip order; Skills first because it nests Packages):

```
─── ✦  SKILLS ──────────────────── 84  · See all →
   Packages · 4
   [PackageCard] [PackageCard]
   [PackageCard] [PackageCard]
   [skill] [skill] [skill] [skill]
   [skill] [skill]                          (showing 6 of 78)

─── ▣  PLUGINS ──────────────────── 12  · See all →
   [plugin] [plugin] [plugin] [plugin]
   [plugin] [plugin]                        (showing 6 of 12)

─── ◉  AGENTS ─────────────────────  9  · See all →
   [agent] [agent] [agent] [agent]
   [agent] [agent]                          (showing 6 of 9)

─── ❒  TEAMS ──────────────────────  3
   [team] [team] [team]
```

### Section header

A small reusable inline component (defined inside `Marketplace.tsx`, no new file):

```tsx
function SectionHeader({
  type, label, total, onSeeAll,
}: {
  type: MarketplaceItemType;
  label: string;
  total: number;
  onSeeAll?: () => void;
}) { /* icon + label + count + "See all →" right-aligned */ }
```

- Icon: same icon used in the chip row (`Sparkles` / `Puzzle` / `Bot`). Tone matches the existing per-type accent (`SINGLE_ICON_TONES`).
- Label: uppercase, `text-[0.7rem] font-semibold tracking-[0.1em] text-dim` (matches the existing "Packages" sub-heading style at `Marketplace.tsx:159`).
- Count: dim suffix `· N`. The count is the section's item total (skills count, plugins count, etc.). Packages are a meta-grouping over skills — they do not contribute to the Skills count. So a catalog with 78 standalone skills + 4 packages summarizing 6 more skills shows `Skills · 84`.
- "See all →": right-aligned, `text-[12px] text-dim hover:text-foreground`. Hidden in two cases: (a) the section's total is `≤ SECTION_CAP` so the cap doesn't actually clip anything, or (b) `selectedType` is set (single-section view, cap already removed — there's nothing further to "see all" of).

### Per-section cap

Constant: `SECTION_CAP = 6` (matches the 2-col grid × 3 rows). Capped at the section level, *not* at the package strip level — packages typical scale is small (2–6) and they read better uncapped.

### Skills section internals

```
SectionHeader (Skills · N · See all if N > CAP)
  ├ Packages strip (only if packages.length > 0)
  │    "Packages · M" sub-heading
  │    2-col PackageCard grid (uncapped)
  └ Standalone skill grid
       2-col CatalogCard grid, capped at SECTION_CAP
```

A skill that is *also* a member of a package still appears in the standalone grid (item-level view + package-level view are different organizing axes; double-listing is intentional and matches today's behavior on the catalog hub). The detail page already shows a "Part of {pkg}" badge for skills that belong to a package.

### Empty sections

A section is hidden entirely when its post-filter item count is zero. Examples:
- The catalog has no agents at all → Agents section omitted.
- Sort = "Featured" and no plugins are flagged featured → Plugins section omitted.
- Search = "slack" matches only one skill → Skills section renders, others are hidden.

---

## §3 — Interactions

| Trigger                          | Behavior                                                                                                                                  |
|----------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| Type chip click (e.g. "Plugins") | `selectedType = "plugin"`. Layout collapses to a *single* section (its header still renders for consistency). The cap is removed — the full type list shows. |
| "All" chip click                 | `selectedType = null`. Four-section view returns.                                                                                         |
| "See all →" in section header    | Equivalent to clicking that section's type chip. URL syncs to `?type=plugin` (existing behavior — `Marketplace.tsx:69`).                 |
| Sort sub-chip (All / Featured / Recent / A-Z) | Sort applies within each section. Sections that empty out post-sort hide. The current global sort logic (`applySort` in `Marketplace.tsx:34`) is reused per-section, no change to its signature. |
| Search                           | Filter applies across all sections. Empty sections hide. Section header counts reflect post-filter totals.                                |
| URL `?type=…`                    | Already wired (Marketplace.tsx:70). When set, single-section view; section header still renders.                                          |

---

## §4 — Edge cases

- **Loose-policy mixed-type explicit package.** A catalog author sets `packageId: "my-bundle"` on two plugins. With the new policy this still produces an explicit package. The PackageCard renders inside the **Skills** section's Packages strip — that's where packages live. The two plugins also appear in the Plugins section's standalone grid. This is the documented escape hatch; the visual mismatch (skill-themed package containing plugins) is acceptable because the catalog author opted in.
- **Catalog with no skills** but other items present. Skills section omitted (including its Packages strip). Other sections render normally.
- **Catalog with only skills.** Plugins / Agents / Teams sections all hidden; Skills section renders.
- **Skill is in a package.** Appears in both the Packages strip (via `PackageCard` summarizing the package) and the standalone skills grid (as itself). Existing detail-page "Part of {pkg}" badge confirms membership.
- **Section count when search is active.** Header shows post-filter count (`6 of 78` becomes e.g. `2 of 5` if search narrows the matches).

---

## §5 — Tests

**Frontend** (`ui/src/__tests__/Marketplace.test.tsx`):

Extend with:
- Renders four section headers in order Skills → Plugins → Agents → Teams when fixture has all four types.
- Hides Agents section when fixture has 0 agents.
- Each non-Skills section renders at most `SECTION_CAP` items; "See all →" link visible when total exceeds cap.
- Skills section renders Packages strip above standalone skill grid when packages exist.
- Skills section omits Packages strip when packages array is empty.
- Clicking "See all →" on Plugins section sets the active chip to Plugins (single-section view).
- When `selectedType === "plugin"`, only the Plugins section renders, with no cap, and Skills/Agents/Teams headers absent.
- Search "slack" hides sections with 0 matches.
- Sort "Featured" applied with no featured agents hides Agents section.

**Backend:** extension to `derivePackages.test.ts` listed in §1.

---

## §6 — Out of scope / future polish

- Sticky / scroll-spy section headers (defer unless pages start scrolling unbearably).
- Per-section sort overrides (one global sort is enough for v1).
- Per-section "Show more / Show less" inline expansion (the chip-driven "See all →" route already exists).
- Reorder / show-hide section preferences.
- Visual changes to `PackageCard` or `CatalogCard` (both already correct).
- `MarketplaceSearch` page (`/marketplace/search`) — out of scope for this spec; it can adopt the same section structure later.

## §7 — Risk

- **Long page on large catalogs.** A future catalog with 200+ skills would still scroll a lot post-cap because the cap only hides extra *standalone* skills, not packages. Mitigation: cap is conservative (6 per section), and "See all →" exists. Acceptable for v1.
- **Loose policy footgun.** A catalog author can technically ship a non-skill `packageId` and it'll render inside Skills. Mitigation: this is documented behavior, the PackageCard visual is consistent, and the catalog author chose it explicitly. No silent bug.
- **Backend test fallout.** `derivePackages.test.ts` has 13 cases today; some currently asserting plugin/agent synthesis should be updated or removed. The change is localized — no other server module depends on the previous behavior.
