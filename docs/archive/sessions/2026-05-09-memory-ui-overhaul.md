# Memory UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the Memory tab UI to match the Phase E sidebar visual language, add a tabbed right pane with collapsed icon strips on both sides, and three center-pane list modes (List / Table / Cards).

**Architecture:** Modify the existing `MemoryExplorer` 3-pane layout in place. Replace the single-item viewer with a tabbed viewer driven by URL search params (`?tabs=…&active=…`). Add a `view` URL param + `localStorage["aoa:memory:view-mode"]` for the center-pane mode. Replace emoji iconography with Lucide. Replace rainbow status pills with a single `MemoryChip` atom. Active state moves from `bg-primary/10 text-primary` to `bg-brand/[0.08] text-[hsl(15_60%_75%)]` + brand glow dot, mirroring `SidebarNavItem`. Phase 2 (graph + link graph + embedding surfaces) is explicitly out of scope.

**Tech Stack:** React 19, TypeScript, TailwindCSS v4 (CSS variables, OKLCH), shadcn/ui, Radix UI, Lucide React, react-resizable-panels, @tanstack/react-query 5, Vitest + @testing-library/react.

**Mockup reference:** [`mockups/memory-redesign.html`](../../../mockups/memory-redesign.html) (4 layout states) and [`mockups/memory-row-options.html`](../../../mockups/memory-row-options.html) (4 view-mode variants). Decision log at [`mockups/memory-redesign-notes.md`](../../../mockups/memory-redesign-notes.md).

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `ui/src/components/memory/MemoryChip.tsx` | Single quiet-chip atom (border + 1px tinted dot). Replaces 5 hard-coded color maps. |
| `ui/src/components/memory/MemoryViewToggle.tsx` | Three-icon button group (List/Table/Cards) shown in center-pane breadcrumb. |
| `ui/src/components/memory/MemoryItemRow.tsx` | Comfortable list row (title + chips + indexed-text snippet + meta). Replaces inline render in `MemoryFileList`. |
| `ui/src/components/memory/MemoryItemTable.tsx` | Sortable table (Name / Layer / Status / Modified / Used / Tokens). |
| `ui/src/components/memory/MemoryItemCard.tsx` | Adaptive card. Markdown variant = title + snippet + chips. File variant = thumbnail + title + meta. PDF variant = first-page text in thumb. |
| `ui/src/components/memory/MemoryItemCardGrid.tsx` | Container that emits `MemoryItemCard` per row. |
| `ui/src/components/memory/MemoryViewerTabs.tsx` | Horizontal tab bar at the top of the right pane. |
| `ui/src/components/memory/MemoryCollapsedTabStrip.tsx` | Vertical icon strip when right pane is collapsed. |
| `ui/src/components/memory/MemoryFolderRail.tsx` | Icon-only vertical rail when left pane is collapsed (5 shortcuts + 4 layer icons). |
| `ui/src/components/memory/PendingReviewPill.tsx` | Toolbar pill replacing `PendingReviewBanner`. |
| `ui/src/components/memory/MemoryToolbar.tsx` | Page-level header (title + count + pending pill + search + Upload + + New). |
| `ui/src/hooks/useMemoryTabs.ts` | URL-backed tab state. `{ tabs: MemoryTab[], activeId: string \| null, openOrActivate, close }`. |
| `ui/src/hooks/useMemoryViewMode.ts` | localStorage-backed `'list' \| 'table' \| 'cards'`, with URL override. |
| `ui/src/lib/memoryItemView.ts` | Pure helpers: `pickIconKind(row)`, `pickSnippet(row)`, `formatRelative(iso)`. |
| `ui/src/lib/__tests__/memoryItemView.test.ts` | Unit tests for the helpers. |
| `ui/src/hooks/__tests__/useMemoryTabs.test.tsx` | renderHook tests for tabs reducer. |
| `ui/src/hooks/__tests__/useMemoryViewMode.test.tsx` | renderHook tests for view-mode persistence. |
| `ui/src/components/memory/__tests__/MemoryChip.test.tsx` | Render + variant tests. |
| `ui/src/components/memory/__tests__/MemoryViewToggle.test.tsx` | Click → onChange. |
| `ui/src/components/memory/__tests__/MemoryItemRow.test.tsx` | Renders title + snippet, click handler fires. |
| `ui/src/components/memory/__tests__/MemoryViewerTabs.test.tsx` | Tab activation + close behavior. |
| `ui/src/components/memory/__tests__/MemoryFolderRail.test.tsx` | Renders 5 shortcuts + 4 layer icons. |

### Modified files

| Path | Change |
|---|---|
| `ui/src/pages/MemoryExplorer.tsx` | Add toolbar + view-mode + tabs state. Replace single-pane Viewer with tabbed Viewer. Wire collapse rails to new components. Drop the "graph view coming soon" placeholder on Home. |
| `ui/src/components/memory/MemoryTree.tsx` | Add Pending Review + Archived shortcuts. Replace emoji `LAYER_META` icons with Lucide. |
| `ui/src/components/memory/FolderTreeNode.tsx` | Replace `bg-primary/10 text-primary` active state with brand wash + glow dot. Replace emoji folder icon with Lucide. |
| `ui/src/components/memory/MemoryFileList.tsx` | Render via view-mode switch (`MemoryItemRow` / `MemoryItemTable` / `MemoryItemCardGrid`). Replace inline emoji `folderLabel` map with Lucide icons. Drop hard-coded `STATUS_COLORS`. |
| `ui/src/components/memory/MemoryViewer.tsx` | Accept `tabs` + `activeId` props instead of single `selectedItemId`. Render `MemoryViewerTabs` at top. |
| `ui/src/components/memory/MemoryHomeDashboard.tsx` | Drop `PendingReviewBanner` (now in toolbar). Polish quick-jump button. |
| `ui/src/components/memory/MemoryRecentsStrip.tsx` | Switch to `MemoryItemRow` style with snippet line. |
| `ui/src/components/memory/MemoryEmptyViewer.tsx` | Body copy `text-xs` → `text-sm`. |
| `ui/src/components/memory/LayerTilesPanel.tsx` | Drop `hover:shadow-md`. Replace emoji glyphs with Lucide. |
| `ui/src/components/memory/CollapsedRail.tsx` | Keep but route only the right-pane case (left pane uses `MemoryFolderRail`). |
| `ui/src/components/memory/viewers/MarkdownItemViewer.tsx` | Replace inline `STATUS_PILL` and `LAYER_PILL` rainbow maps with `MemoryChip`. |

### Deleted

| Path | Reason |
|---|---|
| `ui/src/components/memory/PendingReviewBanner.tsx` | Replaced by `PendingReviewPill` in the toolbar. |

---

## Phase 1 — Visual atoms (no layout change)

Pure visual refresh. After Phase 1 the Memory page looks correct in still frames but still has the old single-pane viewer and no view modes.

### Task 1: MemoryChip atom

**Files:**
- Create: `ui/src/components/memory/MemoryChip.tsx`
- Test: `ui/src/components/memory/__tests__/MemoryChip.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/components/memory/__tests__/MemoryChip.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryChip } from "../MemoryChip";

describe("MemoryChip", () => {
  it("renders label", () => {
    const { container } = render(<MemoryChip label="Decision" />);
    expect(container.textContent).toContain("Decision");
  });

  it("renders a tinted dot when tone is provided", () => {
    const { container } = render(<MemoryChip label="Decision" tone="indigo" />);
    expect(container.querySelector('[data-slot="dot"]')).toBeInTheDocument();
  });

  it("omits the dot when tone is undefined", () => {
    const { container } = render(<MemoryChip label="image · 142 kB" />);
    expect(container.querySelector('[data-slot="dot"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui test -- MemoryChip`
Expected: FAIL — "Cannot find module '../MemoryChip'".

- [ ] **Step 3: Write minimal implementation**

```tsx
// ui/src/components/memory/MemoryChip.tsx
import { cn } from "@/lib/utils";

type Tone =
  | "indigo" | "teal" | "amber" | "magenta" | "green" | "slate";

const TONE_VAR: Record<Tone, string> = {
  indigo: "var(--data-indigo)",
  teal: "var(--data-teal)",
  amber: "var(--data-amber)",
  magenta: "var(--data-magenta)",
  green: "var(--data-green)",
  slate: "var(--data-slate)",
};

export interface MemoryChipProps {
  label: string;
  tone?: Tone;
  className?: string;
}

export function MemoryChip({ label, tone, className }: MemoryChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
        "border border-border bg-white/[0.04]",
        "text-[10px] leading-[14px] font-medium text-muted-foreground whitespace-nowrap",
        className,
      )}
    >
      {tone && (
        <span
          data-slot="dot"
          className="size-1.5 rounded-full"
          style={{ background: TONE_VAR[tone] }}
        />
      )}
      <span>{label}</span>
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui test -- MemoryChip`
Expected: PASS — 3/3.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/memory/MemoryChip.tsx ui/src/components/memory/__tests__/MemoryChip.test.tsx
git commit -m "feat(memory): MemoryChip atom replaces rainbow status pills"
```

---

### Task 2: Brand-red active state on FolderTreeNode

**Files:**
- Modify: `ui/src/components/memory/FolderTreeNode.tsx:39-83`

- [ ] **Step 1: Replace active class + add glow dot**

In `FolderTreeNode.tsx`, replace the existing active styling (`selected && "bg-primary/10 text-primary"`) with the brand wash, and append a brand glow dot at the right edge when `selected` is true.

```tsx
// FolderTreeNode.tsx — diff
- selected && "bg-primary/10 text-primary",
+ selected && "bg-brand/[0.08] text-[hsl(15_60%_75%)]",
```

Add inside the row, after `{actions}`:

```tsx
{selected && (
  <span
    aria-hidden
    className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
  />
)}
```

The wrapping `<div>` needs `relative` added to its className. Update the ChevronDown / ChevronRight color from inherit to `text-muted-foreground` so the chevrons stay subtle on the active row.

- [ ] **Step 2: Visual check via dev server**

Run the UI dev server (`pnpm --filter ui dev`) and confirm a selected tree node shows brand-red wash + glow dot, identical to `SidebarNavItem`'s active state at [`SidebarNavItem.tsx:101-145`](../../../ui/src/components/SidebarNavItem.tsx).

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/memory/FolderTreeNode.tsx
git commit -m "refactor(memory): brand-red active state on folder tree rows"
```

---

### Task 3: Replace emoji LAYER_META with Lucide in MemoryTree

**Files:**
- Modify: `ui/src/components/memory/MemoryTree.tsx:50-56` and the layer header render

- [ ] **Step 1: Update the LAYER_META map**

```tsx
// MemoryTree.tsx — diff
import {
  PanelLeftClose,
  IdCard,        // Identity
  Building2,     // Domain
  Target,        // Active context
  Zap,           // Working
  Pin,           // Pinned
  Inbox,         // Pending Review (matches Sidebar.tsx Inbox)
  Clock,         // Recent
  Archive,       // Archived
  Home,          // Home
} from "lucide-react";

- const LAYER_META: Record<LayerKey, { label: string; icon: string }> = {
-   identity: { label: "Identity", icon: "🪪" },
-   domain: { label: "Domain", icon: "🏢" },
-   active_context: { label: "Active Context", icon: "🎯" },
-   working: { label: "Working", icon: "⚡" },
- };
+ import type { LucideIcon } from "lucide-react";
+ const LAYER_META: Record<LayerKey, { label: string; Icon: LucideIcon; tone: string }> = {
+   identity: { label: "Identity", Icon: IdCard, tone: "var(--data-indigo)" },
+   domain: { label: "Domain", Icon: Building2, tone: "var(--data-teal)" },
+   active_context: { label: "Active Context", Icon: Target, tone: "var(--data-amber)" },
+   working: { label: "Working", Icon: Zap, tone: "var(--data-magenta)" },
+ };
```

- [ ] **Step 2: Update buildTree() to emit the LucideIcon as the node's icon**

Find the layer header construction inside `buildTree()` (the part that emits `__layer-<key>` nodes) and pass `Icon` instead of an emoji string. `FolderTreeNode` already accepts `LucideIcon | string` for `icon`, so no change to `FolderTreeNode` needed.

- [ ] **Step 3: Visual check**

Run the dev server and confirm the four layer headers in the left pane render Lucide icons at `size-3.5`, with the layer's data-color tone applied via inline style.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/memory/MemoryTree.tsx
git commit -m "refactor(memory): Lucide icons replace emoji on layer headers"
```

---

### Task 4: Add Pending Review + Archived shortcuts to MemoryTree

**Files:**
- Modify: `ui/src/components/memory/MemoryTree.tsx` (the cross-cutting shortcuts section in `buildTree()`)

- [ ] **Step 1: Locate the shortcuts segment**

The existing tree builder emits `__home`, `__pinned`, `__recent` shortcut nodes. Insert `__pending` between `__pinned` and `__recent`, and `__archived` after `__recent`.

- [ ] **Step 2: Add the two nodes with counts driven by `counts` from the items query**

```tsx
// inside buildTree — after the __pinned node, before __recent
nodes.push({
  key: "__pending",
  label: "Pending Review",
  Icon: Inbox,
  iconTone: "var(--data-amber)",
  count: counts.pending,
  depth: 0,
  hasChildren: false,
  target: { folder: "__pending", dept: null },
  // brand-tinted badge — only this shortcut surfaces founder action
  countTone: "brand",
});

// after __recent
nodes.push({
  key: "__archived",
  label: "Archived",
  Icon: Archive,
  count: counts.archived,
  depth: 0,
  hasChildren: false,
  target: { folder: "__archived", dept: null },
});
```

- [ ] **Step 3: FolderTreeNode count badge — add brand tone**

In `FolderTreeNode.tsx`, accept a new optional prop `countTone?: "default" | "brand"` and render the count differently:

```tsx
{count !== undefined && (
  <span
    className={cn(
      "rounded px-1.5 py-0.5 text-[10px] tabular-nums",
      countTone === "brand"
        ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
        : "text-muted-foreground",
    )}
  >
    {count}
  </span>
)}
```

- [ ] **Step 4: Wire the routing target**

`__pending` and `__archived` flow through the existing `selectNode → useNavigate(?folder=…)` path. The list pane already filters via `folderPath === "__pending" / "__archived"` (see [`MemoryFileList.tsx:177-183`](../../../ui/src/components/memory/MemoryFileList.tsx)). No backend change required.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/memory/MemoryTree.tsx ui/src/components/memory/FolderTreeNode.tsx
git commit -m "feat(memory): Pending Review + Archived shortcuts in folder tree"
```

---

### Task 5: PendingReviewPill replaces banner

**Files:**
- Create: `ui/src/components/memory/PendingReviewPill.tsx`
- Delete: `ui/src/components/memory/PendingReviewBanner.tsx`
- Modify: `ui/src/components/memory/MemoryHomeDashboard.tsx:21-50` (drop banner import)

- [ ] **Step 1: Write the pill component**

```tsx
// ui/src/components/memory/PendingReviewPill.tsx
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Clock } from "lucide-react";
import type { MemoryItem } from "@armyofagents/shared";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";

interface Props { companyId: string; className?: string; }

export function PendingReviewPill({ companyId, className }: Props) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const prefix = selectedCompany?.issuePrefix ?? "";

  const { data: items } = useQuery({
    queryKey: queryKeys.memory.list(companyId),
    queryFn: () => memoryApi.list(companyId, {}),
    enabled: Boolean(companyId),
  });

  const pending = (items ?? []).filter((it: MemoryItem) => it.status === "pending");
  if (pending.length === 0) return null;

  return (
    <button
      type="button"
      onClick={() => navigate(`/${prefix}/memory/explore?folder=__pending`)}
      className={cn(
        "flex items-center gap-2 rounded-md border border-border-strong px-2.5 py-1 text-xs",
        "text-muted-foreground hover:bg-white/[0.04] transition-colors",
        className,
      )}
    >
      <span
        className="size-1.5 rounded-full"
        style={{ background: "var(--data-amber)" }}
      />
      <span>{pending.length} pending</span>
      <span className="text-very-dim">·</span>
      <span className="font-medium text-foreground">Review</span>
    </button>
  );
}
```

- [ ] **Step 2: Drop the banner import + render from MemoryHomeDashboard**

```tsx
// MemoryHomeDashboard.tsx — diff
- import { PendingReviewBanner } from "./PendingReviewBanner";
- ...
-   <PendingReviewBanner companyId={companyId} />
```

- [ ] **Step 3: Delete the banner file**

```bash
rm ui/src/components/memory/PendingReviewBanner.tsx
```

- [ ] **Step 4: Confirm no dangling imports**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/memory/PendingReviewPill.tsx ui/src/components/memory/MemoryHomeDashboard.tsx
git rm ui/src/components/memory/PendingReviewBanner.tsx
git commit -m "refactor(memory): replace amber pending banner with toolbar pill"
```

---

### Task 6: MemoryToolbar at the top of the page

**Files:**
- Create: `ui/src/components/memory/MemoryToolbar.tsx`
- Modify: `ui/src/pages/MemoryExplorer.tsx:67-186` (mount toolbar; drop the in-line search row)

- [ ] **Step 1: Write the toolbar**

```tsx
// ui/src/components/memory/MemoryToolbar.tsx
import { useQuery } from "@tanstack/react-query";
import { Plus, Upload, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { PendingReviewPill } from "./PendingReviewPill";
import { MemoryUploadButton } from "./MemoryUploadButton";

interface Props {
  companyId: string;
  searchValue: string;
  onSearchChange: (v: string) => void;
  onNewItem: () => void;
  uploadProps?: { departmentId: string | null; folderPath: string };
}

export function MemoryToolbar({
  companyId,
  searchValue,
  onSearchChange,
  onNewItem,
  uploadProps,
}: Props) {
  const { data: items } = useQuery({
    queryKey: queryKeys.memory.list(companyId),
    queryFn: () => memoryApi.list(companyId, {}),
  });
  const total = items?.length ?? 0;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <h1 className="text-sm font-semibold">Memory</h1>
      <span className="text-xs text-very-dim">
        · {total} {total === 1 ? "item" : "items"} · 4 layers
      </span>
      <span className="flex-1" />
      <PendingReviewPill companyId={companyId} />
      <div className="relative w-56">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-very-dim" />
        <Input
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Quick-jump…  ⌘K"
          className="h-7 pl-8 pr-2 text-xs"
        />
      </div>
      {uploadProps && (
        <MemoryUploadButton companyId={companyId} {...uploadProps} />
      )}
      <Button size="sm" className="h-7 gap-1.5 px-3 text-xs" onClick={onNewItem}>
        <Plus className="size-3.5" />
        New item
      </Button>
    </header>
  );
}
```

- [ ] **Step 2: Mount in MemoryExplorer above the Group**

```tsx
// MemoryExplorer.tsx — diff
+ <MemoryToolbar
+   companyId={selectedCompanyId}
+   searchValue={searchQuery}
+   onSearchChange={setSearchQuery}
+   onNewItem={() => { /* stub — wired in Task 7 */ }}
+   uploadProps={canUpload ? { departmentId, folderPath } : undefined}
+ />
- {!isHomeSelected && (
-   <div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-border bg-card/30">
-     <MemoryScopedSearch ... />
-     <span className="flex-1" />
-     {canUpload && <MemoryUploadButton ... />}
-   </div>
- )}
```

- [ ] **Step 3: Visual check**

Confirm the toolbar appears on every Memory state (Home + folder + item). Pending pill self-hides at 0 (re-uses the existing query).

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/memory/MemoryToolbar.tsx ui/src/pages/MemoryExplorer.tsx
git commit -m "feat(memory): page-level toolbar with title, pending pill, search, +New"
```

---

### Task 7: New item flow

**Files:**
- Modify: `ui/src/pages/MemoryExplorer.tsx` (wire onNewItem)
- Reuse: `ui/src/pages/Memory.tsx` already has a `createOpen` Dialog. Lift its trigger contents into a tiny `NewMemoryItemDialog` shared component if needed, or replicate.

- [ ] **Step 1: Extract NewMemoryItemDialog**

If `Memory.tsx`'s create dialog is well-encapsulated, extract it to `ui/src/components/memory/NewMemoryItemDialog.tsx` with props `{ open, onOpenChange, companyId, defaultFolderPath?, defaultDepartmentId? }`. Otherwise inline the same Dialog inside `MemoryExplorer.tsx`.

- [ ] **Step 2: Wire from MemoryExplorer**

```tsx
// MemoryExplorer.tsx
const [newItemOpen, setNewItemOpen] = useState(false);
// ... in MemoryToolbar onNewItem={() => setNewItemOpen(true)}
<NewMemoryItemDialog
  open={newItemOpen}
  onOpenChange={setNewItemOpen}
  companyId={selectedCompanyId}
  defaultFolderPath={folderPath}
  defaultDepartmentId={departmentId}
/>
```

- [ ] **Step 3: Manual verification**

Click + New item, fill the form, save, confirm new item appears in the center pane.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/memory/NewMemoryItemDialog.tsx ui/src/pages/MemoryExplorer.tsx
git commit -m "feat(memory): wire +New item button to create dialog"
```

---

### Task 8: Quiet chips + Lucide replace MarkdownItemViewer rainbow pills

**Files:**
- Modify: `ui/src/components/memory/viewers/MarkdownItemViewer.tsx:22-35`

- [ ] **Step 1: Replace STATUS_PILL + LAYER_PILL maps with MemoryChip**

Drop the `STATUS_PILL` and `LAYER_PILL` rainbow maps. Replace the chips render with `MemoryChip`:

```tsx
// MarkdownItemViewer.tsx — diff
- {i.status && <span className={cn(...STATUS_PILL[i.status]...)}>{i.status}</span>}
- {i.layer && <span className={cn(...LAYER_PILL[i.layer]...)}>{i.layer}</span>}
+ {i.status && <MemoryChip label={i.status} tone={STATUS_TONE[i.status]} />}
+ {i.layer && <MemoryChip label={i.layer} tone={LAYER_TONE[i.layer]} />}
```

Move tone maps into a tiny shared module:

```tsx
// ui/src/lib/memoryItemView.ts
export const STATUS_TONE = {
  approved: "green",
  pending: "amber",
  archived: "slate",
  rejected: "magenta",
  draft: "slate",
} as const;
export const LAYER_TONE = {
  identity: "indigo",
  domain: "teal",
  active_context: "amber",
  working: "magenta",
} as const;
```

- [ ] **Step 2: tsc + visual check**

`pnpm --filter ui exec tsc --noEmit`. Open a memory item — confirm chips render with single tinted dot, no rainbow.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/memory/viewers/MarkdownItemViewer.tsx ui/src/lib/memoryItemView.ts
git commit -m "refactor(memory): MemoryChip replaces rainbow pills in markdown viewer"
```

---

### Task 9: LayerTilesPanel polish (no shadow, Lucide already there)

**Files:**
- Modify: `ui/src/components/memory/LayerTilesPanel.tsx:88-128`

- [ ] **Step 1: Drop hover:shadow-md and the emoji glyph**

```tsx
// LayerTilesPanel.tsx — diff
- "hover:border-primary/50 hover:shadow-md transition-all duration-150",
+ "hover:border-border-strong hover:bg-card-2 transition-colors",
- <span className="text-base leading-none">{layer.emoji}</span>
+ <span className="size-7 rounded-lg flex items-center justify-center bg-white/[0.04]">
+   <layer.icon className="size-4" style={{ color: TONE[layer.key] }} />
+ </span>
```

Remove the `emoji` field from the `LayerSpec`. Add a `TONE` const mapping each layer key to a `var(--data-*)` color matching `LAYER_TONE`.

- [ ] **Step 2: Visual check**

Open Memory home — confirm tiles are flat with subtle hover, icons are Lucide tinted by layer.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/memory/LayerTilesPanel.tsx
git commit -m "refactor(memory): flat layer tiles with Lucide + brand-tinted squares"
```

---

### Task 10: Phase 1 verification + ship checkpoint

- [ ] **Step 1: Run all UI tests**

```bash
pnpm --filter ui test
```
Expected: all pass.

- [ ] **Step 2: Manual smoke**

In the dev server, walk through:
1. Sidebar Memory link with brand glow dot at right ✓
2. Folder tree shortcuts: Home / Pinned / Pending Review (brand badge) / Recent / Archived ✓
3. Lucide icons on all 4 layer headers ✓
4. Brand-red wash + glow dot on the selected tree row ✓
5. Toolbar with title, pending pill, search, Upload, + New ✓
6. + New opens the dialog ✓

- [ ] **Step 3: Stop and review**

Phase 1 is shippable on its own. Open a PR for these atoms before starting Phase 2.

---

## Phase 2 — Center-pane view modes (List / Table / Cards)

### Task 11: useMemoryViewMode hook

**Files:**
- Create: `ui/src/hooks/useMemoryViewMode.ts`
- Test: `ui/src/hooks/__tests__/useMemoryViewMode.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/hooks/__tests__/useMemoryViewMode.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMemoryViewMode } from "../useMemoryViewMode";

describe("useMemoryViewMode", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to list", () => {
    const { result } = renderHook(() => useMemoryViewMode());
    expect(result.current.mode).toBe("list");
  });

  it("persists across mounts", () => {
    const { result, unmount } = renderHook(() => useMemoryViewMode());
    act(() => result.current.setMode("table"));
    unmount();
    const { result: r2 } = renderHook(() => useMemoryViewMode());
    expect(r2.current.mode).toBe("table");
  });

  it("ignores invalid stored values", () => {
    localStorage.setItem("aoa:memory:view-mode", "treeview");
    const { result } = renderHook(() => useMemoryViewMode());
    expect(result.current.mode).toBe("list");
  });
});
```

- [ ] **Step 2: Run + fail**

```bash
pnpm --filter ui test -- useMemoryViewMode
```
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```tsx
// ui/src/hooks/useMemoryViewMode.ts
import { useCallback, useEffect, useState } from "react";

export type MemoryViewMode = "list" | "table" | "cards";
const KEY = "aoa:memory:view-mode";
const VALID: MemoryViewMode[] = ["list", "table", "cards"];

function read(): MemoryViewMode {
  try {
    const v = localStorage.getItem(KEY);
    return VALID.includes(v as MemoryViewMode) ? (v as MemoryViewMode) : "list";
  } catch {
    return "list";
  }
}

export function useMemoryViewMode() {
  const [mode, setModeState] = useState<MemoryViewMode>(() => read());

  const setMode = useCallback((next: MemoryViewMode) => {
    setModeState(next);
    try { localStorage.setItem(KEY, next); } catch {}
  }, []);

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === KEY) setModeState(read());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { mode, setMode };
}
```

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter ui test -- useMemoryViewMode
```
Expected: PASS — 3/3.

- [ ] **Step 5: Commit**

```bash
git add ui/src/hooks/useMemoryViewMode.ts ui/src/hooks/__tests__/useMemoryViewMode.test.tsx
git commit -m "feat(memory): useMemoryViewMode hook with localStorage persistence"
```

---

### Task 12: MemoryViewToggle component

**Files:**
- Create: `ui/src/components/memory/MemoryViewToggle.tsx`
- Test: `ui/src/components/memory/__tests__/MemoryViewToggle.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryViewToggle } from "../MemoryViewToggle";

describe("MemoryViewToggle", () => {
  it("highlights the active mode", () => {
    const { getByTitle } = render(<MemoryViewToggle mode="table" onChange={() => {}} />);
    expect(getByTitle("Table view")).toHaveAttribute("aria-pressed", "true");
    expect(getByTitle("List view")).toHaveAttribute("aria-pressed", "false");
  });

  it("fires onChange on click", () => {
    const onChange = vi.fn();
    const { getByTitle } = render(<MemoryViewToggle mode="list" onChange={onChange} />);
    fireEvent.click(getByTitle("Cards view"));
    expect(onChange).toHaveBeenCalledWith("cards");
  });
});
```

- [ ] **Step 2: Implement**

```tsx
// ui/src/components/memory/MemoryViewToggle.tsx
import { List, Table2, LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MemoryViewMode } from "../../hooks/useMemoryViewMode";

interface Props {
  mode: MemoryViewMode;
  onChange: (mode: MemoryViewMode) => void;
}

const ITEMS: { mode: MemoryViewMode; Icon: typeof List; title: string }[] = [
  { mode: "list", Icon: List, title: "List view" },
  { mode: "table", Icon: Table2, title: "Table view" },
  { mode: "cards", Icon: LayoutGrid, title: "Cards view" },
];

export function MemoryViewToggle({ mode, onChange }: Props) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border-strong">
      {ITEMS.map(({ mode: m, Icon, title }, i) => (
        <button
          key={m}
          type="button"
          title={title}
          aria-pressed={mode === m}
          onClick={() => onChange(m)}
          className={cn(
            "flex h-[22px] w-[26px] items-center justify-center transition-colors",
            i > 0 && "border-l border-border",
            mode === m
              ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
              : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Tests pass + commit**

```bash
pnpm --filter ui test -- MemoryViewToggle
git add ui/src/components/memory/MemoryViewToggle.tsx ui/src/components/memory/__tests__/MemoryViewToggle.test.tsx
git commit -m "feat(memory): MemoryViewToggle three-icon view switcher"
```

---

### Task 13: Pure helpers (icon-kind, snippet, format)

**Files:**
- Modify: `ui/src/lib/memoryItemView.ts` (add to existing file from Task 8)
- Test: `ui/src/lib/__tests__/memoryItemView.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { pickIconKind, pickSnippet, formatRelative } from "../memoryItemView";

describe("memoryItemView", () => {
  it("pickIconKind handles markdown items", () => {
    expect(pickIconKind({ kind: "memory_item" } as any)).toBe("markdown");
  });
  it("pickIconKind handles image asset", () => {
    expect(pickIconKind({ kind: "asset", mimeType: "image/png" } as any)).toBe("image");
  });
  it("pickIconKind handles pdf asset", () => {
    expect(pickIconKind({ kind: "asset", mimeType: "application/pdf" } as any)).toBe("pdf");
  });
  it("pickSnippet truncates body to ~200 chars", () => {
    const long = "a".repeat(500);
    const out = pickSnippet({ kind: "memory_item", content: long } as any);
    expect(out.length).toBeLessThanOrEqual(200);
  });
  it("formatRelative returns d/w/mo", () => {
    const now = Date.now();
    expect(formatRelative(new Date(now - 2 * 86400_000).toISOString())).toBe("2d");
    expect(formatRelative(new Date(now - 14 * 86400_000).toISOString())).toBe("2w");
  });
});
```

- [ ] **Step 2: Implement**

```ts
// ui/src/lib/memoryItemView.ts (add to existing module)
import type { MemoryItem, MemoryAssetRecord } from "@armyofagents/shared";

type Row =
  | { kind: "memory_item"; content?: string | null }
  | { kind: "asset"; mimeType?: string | null; extractedText?: string | null };

export type IconKind = "markdown" | "image" | "pdf" | "video" | "docx" | "generic";

export function pickIconKind(row: Row): IconKind {
  if (row.kind === "memory_item") return "markdown";
  const mt = row.mimeType ?? "";
  if (mt.startsWith("image/")) return "image";
  if (mt.startsWith("video/")) return "video";
  if (mt === "application/pdf") return "pdf";
  if (mt.includes("wordprocessingml")) return "docx";
  return "generic";
}

export function pickSnippet(row: Row): string {
  const raw =
    row.kind === "memory_item"
      ? row.content ?? ""
      : (row.extractedText ?? "");
  // strip markdown emphasis + headings; keep readable
  const flat = raw.replace(/[#*_`>~]+/g, "").replace(/\s+/g, " ").trim();
  return flat.length > 200 ? flat.slice(0, 197).trimEnd() + "…" : flat;
}

export function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const d = Math.floor(ms / 86400_000);
  if (d < 1) return "today";
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}
```

- [ ] **Step 3: Tests pass + commit**

```bash
pnpm --filter ui test -- memoryItemView
git add ui/src/lib/memoryItemView.ts ui/src/lib/__tests__/memoryItemView.test.ts
git commit -m "feat(memory): pickIconKind + pickSnippet + formatRelative helpers"
```

---

### Task 14: MemoryItemRow (comfortable list)

**Files:**
- Create: `ui/src/components/memory/MemoryItemRow.tsx`
- Test: `ui/src/components/memory/__tests__/MemoryItemRow.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryItemRow } from "../MemoryItemRow";

const item = {
  kind: "memory_item" as const,
  id: "i1",
  title: "README.md",
  category: "decision",
  status: "approved",
  modifiedAt: new Date().toISOString(),
  content: "Always pair a new agent with an existing trusted agent.",
};

describe("MemoryItemRow", () => {
  it("renders title and snippet", () => {
    const { getByText } = render(<MemoryItemRow row={item as any} active={false} onSelect={() => {}} />);
    expect(getByText("README.md")).toBeInTheDocument();
    expect(getByText(/Always pair a new agent/)).toBeInTheDocument();
  });

  it("calls onSelect when clicked", () => {
    const onSelect = vi.fn();
    const { getByRole } = render(<MemoryItemRow row={item as any} active={false} onSelect={onSelect} />);
    fireEvent.click(getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("i1", "memory_item");
  });

  it("applies brand-active styling when active", () => {
    const { getByRole } = render(<MemoryItemRow row={item as any} active={true} onSelect={() => {}} />);
    expect(getByRole("button").className).toContain("bg-brand/[0.08]");
  });
});
```

- [ ] **Step 2: Implement**

Wire the component to: 28×28 icon-square + body (head row with title+chips+meta, snippet row), brand-active styling, glow dot at top-right when active. Use Lucide via a small `IconForKind` switch (`FileText`, `Image`, `FileText` for PDF with extra path, `Film`, etc.).

```tsx
// ui/src/components/memory/MemoryItemRow.tsx
import { FileText, Image as ImageIcon, Film } from "lucide-react";
import { cn } from "@/lib/utils";
import { MemoryChip } from "./MemoryChip";
import { pickIconKind, pickSnippet, formatRelative, STATUS_TONE } from "../../lib/memoryItemView";

export interface MemoryItemRowData {
  kind: "memory_item" | "asset";
  id: string;
  title: string;
  category?: string | null;
  status?: string | null;
  mimeType?: string | null;
  modifiedAt: string;
  content?: string | null;
  extractedText?: string | null;
}

interface Props {
  row: MemoryItemRowData;
  active: boolean;
  onSelect: (id: string, kind: "memory_item" | "asset") => void;
}

function IconForKind({ kind }: { kind: ReturnType<typeof pickIconKind> }) {
  if (kind === "image") return <ImageIcon className="size-4" />;
  if (kind === "video") return <Film className="size-4" />;
  return <FileText className="size-4" />;
}

export function MemoryItemRow({ row, active, onSelect }: Props) {
  const kind = pickIconKind(row);
  const snippet = pickSnippet(row);
  return (
    <button
      type="button"
      onClick={() => onSelect(row.id, row.kind)}
      className={cn(
        "relative flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors",
        active
          ? "bg-brand/[0.08]"
          : "hover:bg-white/[0.04]",
      )}
    >
      <span
        className={cn(
          "size-7 shrink-0 rounded-md flex items-center justify-center",
          active ? "bg-brand/[0.14] text-[hsl(15_60%_75%)]" : "bg-white/[0.04] text-muted-foreground",
        )}
      >
        <IconForKind kind={kind} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("flex-1 truncate text-[13px] font-medium", active && "text-[hsl(15_60%_75%)]")}>
            {row.title}
          </span>
          {row.category && <MemoryChip label={row.category} tone="indigo" />}
          {row.status && <MemoryChip label={row.status} tone={STATUS_TONE[row.status as keyof typeof STATUS_TONE] ?? "slate"} />}
          <span className="text-[10px] tabular-nums text-very-dim">
            {formatRelative(row.modifiedAt)}
          </span>
        </div>
        {snippet && (
          <div className={cn(
            "mt-1 text-[11.5px] leading-snug line-clamp-2",
            active ? "text-muted-foreground" : "text-very-dim",
          )}>
            {snippet}
          </div>
        )}
      </div>
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-3 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
        />
      )}
    </button>
  );
}
```

- [ ] **Step 3: Tests pass + commit**

```bash
pnpm --filter ui test -- MemoryItemRow
git add ui/src/components/memory/MemoryItemRow.tsx ui/src/components/memory/__tests__/MemoryItemRow.test.tsx
git commit -m "feat(memory): MemoryItemRow with title + indexed-text snippet"
```

---

### Task 15: MemoryItemTable

**Files:**
- Create: `ui/src/components/memory/MemoryItemTable.tsx`

- [ ] **Step 1: Implement**

Sortable columns: `Name | Layer | Status | Modified ▾ | Used | Tokens`. Reuse `MemoryChip` for Layer + Status. `Used` field comes from the item's denormalized `runUsageCount` if present, else `0×` (a TODO note can flag the data dependency — it ships zero-filled until the run-summary aggregate lands). Active row uses brand wash + brand-tint text.

```tsx
// ui/src/components/memory/MemoryItemTable.tsx
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { MemoryChip } from "./MemoryChip";
import { formatRelative, STATUS_TONE, LAYER_TONE } from "../../lib/memoryItemView";
import type { MemoryItemRowData } from "./MemoryItemRow";

interface Props {
  rows: MemoryItemRowData[];
  activeId: string | null;
  onSelect: (id: string, kind: "memory_item" | "asset") => void;
  sortBy: "modifiedAt" | "title" | "used";
  sortDir: "asc" | "desc";
  onSortChange: (col: "modifiedAt" | "title" | "used") => void;
}

const Th = ({ label, col, sort, dir, onClick }: { label: string; col?: any; sort?: any; dir?: any; onClick?: () => void; }) => (
  <th
    onClick={onClick}
    className={cn(
      "px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-very-dim",
      "border-b border-border bg-card",
      onClick && "cursor-pointer hover:text-foreground",
    )}
  >
    {label}
    {col && sort === col && <ChevronDown className={cn("inline ml-1 size-3", dir === "asc" && "rotate-180")} />}
  </th>
);

export function MemoryItemTable({ rows, activeId, onSelect, sortBy, sortDir, onSortChange }: Props) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr>
          <Th label="Name" col="title" sort={sortBy} dir={sortDir} onClick={() => onSortChange("title")} />
          <Th label="Layer" />
          <Th label="Status" />
          <Th label="Modified" col="modifiedAt" sort={sortBy} dir={sortDir} onClick={() => onSortChange("modifiedAt")} />
          <Th label="Used" col="used" sort={sortBy} dir={sortDir} onClick={() => onSortChange("used")} />
          <Th label="Tokens" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const active = r.id === activeId;
          return (
            <tr
              key={r.id}
              onClick={() => onSelect(r.id, r.kind)}
              className={cn(
                "cursor-pointer border-b border-border-soft",
                active ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]" : "hover:bg-white/[0.04]",
              )}
            >
              <td className={cn("max-w-[280px] truncate px-4 py-2", active && "font-medium")}>{r.title}</td>
              <td className="px-4 py-2">
                {(r as any).layer && <MemoryChip label={(r as any).layer} tone={LAYER_TONE[(r as any).layer as keyof typeof LAYER_TONE] ?? "slate"} />}
              </td>
              <td className="px-4 py-2">
                {r.status && <MemoryChip label={r.status} tone={STATUS_TONE[r.status as keyof typeof STATUS_TONE] ?? "slate"} />}
              </td>
              <td className="px-4 py-2">{formatRelative(r.modifiedAt)}</td>
              <td className="px-4 py-2 tabular-nums">{(r as any).usedCount ?? 0}×</td>
              <td className="px-4 py-2 text-right font-mono">{(r as any).tokenEstimate ?? "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/memory/MemoryItemTable.tsx
git commit -m "feat(memory): MemoryItemTable with sortable columns"
```

---

### Task 16: MemoryItemCard (adaptive)

**Files:**
- Create: `ui/src/components/memory/MemoryItemCard.tsx`

- [ ] **Step 1: Implement**

Switch on `pickIconKind`:
- markdown → no thumbnail; body shows icon+title head, 4-line snippet, chip foot.
- image → 100px gradient thumbnail, info block below.
- pdf → 100px field-bg "thumb" with `page 1 of N` header + 3-line `pickSnippet(extractedText)`.
- video / docx / generic → small generic icon thumbnail.

```tsx
// ui/src/components/memory/MemoryItemCard.tsx
import { FileText, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MemoryChip } from "./MemoryChip";
import { pickIconKind, pickSnippet, formatRelative, STATUS_TONE } from "../../lib/memoryItemView";
import type { MemoryItemRowData } from "./MemoryItemRow";

interface Props {
  row: MemoryItemRowData & { chunkCount?: number; pageCount?: number };
  active: boolean;
  onSelect: (id: string, kind: "memory_item" | "asset") => void;
}

export function MemoryItemCard({ row, active, onSelect }: Props) {
  const kind = pickIconKind(row);
  const snippet = pickSnippet(row);
  return (
    <button
      type="button"
      onClick={() => onSelect(row.id, row.kind)}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors",
        active ? "border-brand bg-brand/[0.08]" : "border-border hover:border-border-strong hover:bg-card-2",
      )}
    >
      {active && (
        <span className="pointer-events-none absolute right-2.5 top-2.5 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]" />
      )}

      {kind === "markdown" ? (
        <div className="flex min-h-[168px] flex-col p-3.5">
          <div className="mb-2.5 flex items-center gap-2">
            <span className={cn(
              "size-6 rounded-md flex items-center justify-center",
              active ? "bg-brand/[0.14] text-[hsl(15_60%_75%)]" : "bg-white/[0.04] text-muted-foreground",
            )}>
              <FileText className="size-3.5" />
            </span>
            <span className={cn("flex-1 truncate text-[12.5px] font-medium", active && "text-[hsl(15_60%_75%)]")}>
              {row.title}
            </span>
          </div>
          {snippet && (
            <div className={cn("mb-2.5 flex-1 line-clamp-4 text-[11.5px] leading-relaxed", active ? "text-muted-foreground" : "text-very-dim")}>
              {snippet}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {row.category && <MemoryChip label={row.category} tone="indigo" />}
            {row.status && <MemoryChip label={row.status} tone={STATUS_TONE[row.status as keyof typeof STATUS_TONE] ?? "slate"} />}
            <span className="text-[10px] tabular-nums text-very-dim">{formatRelative(row.modifiedAt)}</span>
          </div>
        </div>
      ) : kind === "pdf" ? (
        <>
          <div className="flex h-[100px] flex-col gap-1.5 border-b border-border bg-field p-3">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <FileText className="size-2.5" />
              <span>page 1 of {row.pageCount ?? "?"}</span>
            </div>
            <div className="line-clamp-3 text-[10px] leading-relaxed text-very-dim">{snippet}</div>
          </div>
          <div className="p-3">
            <div className={cn("truncate text-[12.5px] font-medium", active && "text-[hsl(15_60%_75%)]")}>{row.title}</div>
            <div className="mt-1 flex items-center gap-1.5">
              <MemoryChip label={`pdf · ${row.chunkCount ?? 0} chunks`} />
              <span className="text-[10px] tabular-nums text-very-dim">{formatRelative(row.modifiedAt)}</span>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className={cn(
            "flex h-[100px] items-center justify-center border-b border-border",
            kind === "image" ? "bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a]" : "bg-field",
          )}>
            <ImageIcon className="size-8 opacity-50" />
          </div>
          <div className="p-3">
            <div className={cn("truncate text-[12.5px] font-medium", active && "text-[hsl(15_60%_75%)]")}>{row.title}</div>
            <div className="mt-1 flex items-center gap-1.5">
              {row.mimeType && <MemoryChip label={row.mimeType.split("/").join(" / ")} />}
              <span className="text-[10px] tabular-nums text-very-dim">{formatRelative(row.modifiedAt)}</span>
            </div>
          </div>
        </>
      )}
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/memory/MemoryItemCard.tsx
git commit -m "feat(memory): adaptive MemoryItemCard (markdown/pdf/file variants)"
```

---

### Task 17: MemoryItemCardGrid container

**Files:**
- Create: `ui/src/components/memory/MemoryItemCardGrid.tsx`

- [ ] **Step 1: Implement**

```tsx
// ui/src/components/memory/MemoryItemCardGrid.tsx
import { MemoryItemCard } from "./MemoryItemCard";
import type { MemoryItemRowData } from "./MemoryItemRow";

interface Props {
  rows: (MemoryItemRowData & { chunkCount?: number; pageCount?: number })[];
  activeId: string | null;
  onSelect: (id: string, kind: "memory_item" | "asset") => void;
}

export function MemoryItemCardGrid({ rows, activeId, onSelect }: Props) {
  return (
    <div
      className="grid gap-2.5 p-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
    >
      {rows.map((r) => (
        <MemoryItemCard key={`${r.kind}-${r.id}`} row={r} active={activeId === r.id} onSelect={onSelect} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/memory/MemoryItemCardGrid.tsx
git commit -m "feat(memory): MemoryItemCardGrid container"
```

---

### Task 18: Wire view modes into MemoryFileList

**Files:**
- Modify: `ui/src/components/memory/MemoryFileList.tsx:91-300`

- [ ] **Step 1: Replace single render block with view-mode switch**

```tsx
// MemoryFileList.tsx — diff (high level)
+ import { useMemoryViewMode } from "../../hooks/useMemoryViewMode";
+ import { MemoryViewToggle } from "./MemoryViewToggle";
+ import { MemoryItemRow } from "./MemoryItemRow";
+ import { MemoryItemTable } from "./MemoryItemTable";
+ import { MemoryItemCardGrid } from "./MemoryItemCardGrid";

  export function MemoryFileList(props: MemoryFileListProps) {
+   const { mode, setMode } = useMemoryViewMode();
+   const [sortBy, setSortBy] = useState<"modifiedAt"|"title"|"used">("modifiedAt");
+   const [sortDir, setSortDir] = useState<"asc"|"desc">("desc");
    // ... existing data fetching unchanged ...

    // Sort rows for table mode
+   const sortedRows = useMemo(() => {
+     const copy = [...filteredRows];
+     copy.sort((a, b) => {
+       if (sortBy === "title") return a.name.localeCompare(b.name);
+       if (sortBy === "used") return ((a as any).usedCount ?? 0) - ((b as any).usedCount ?? 0);
+       return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
+     });
+     if (sortDir === "asc") copy.reverse();
+     return copy;
+   }, [filteredRows, sortBy, sortDir]);

    return (
      <div className="h-full flex flex-col bg-background">
        <div className="flex h-9 ... border-b ...">
          {/* breadcrumb (existing) */}
          <span className="flex-1" />
+         <MemoryViewToggle mode={mode} onChange={setMode} />
          {/* keep existing count label: e.g. "2 folders · 12 items" */}
          <span className="text-[10px] text-muted-foreground">
            {subfolders.length > 0 && `${subfolders.length} ${subfolders.length === 1 ? "folder" : "folders"} · `}
            {filteredRows.length} {filteredRows.length === 1 ? "item" : "items"}
          </span>
        </div>

        <div className="flex-1 overflow-auto">
+         {mode === "list" && (
+           sortedRows.map((r) => (
+             <MemoryItemRow key={`${r.kind}-${r.id}`} row={r as any} active={r.id === selectedItemId} onSelect={selectRow} />
+           ))
+         )}
+         {mode === "table" && (
+           <MemoryItemTable rows={sortedRows as any} activeId={selectedItemId} onSelect={selectRow} sortBy={sortBy} sortDir={sortDir} onSortChange={(c) => { if (c === sortBy) setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy(c); setSortDir("desc"); } }} />
+         )}
+         {mode === "cards" && (
+           <MemoryItemCardGrid rows={sortedRows as any} activeId={selectedItemId} onSelect={selectRow} />
+         )}
        </div>
      </div>
    );
  }
```

The Folders-strip section above the items remains in List + Cards modes but is hidden in Table mode (table can't easily mix folder rows + item rows — folders show as a separate strip above the table).

- [ ] **Step 2: Manual verification**

For each of the three view modes:
1. Click each toggle icon — content switches without losing the active selection ✓
2. View mode persists across reloads ✓
3. Table sort by Modified / Title / Used works ✓
4. Cards: markdown shows snippet, image shows gradient thumb, PDF shows page 1 preview ✓

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/memory/MemoryFileList.tsx
git commit -m "feat(memory): three center-pane view modes (List/Table/Cards)"
```

---

### Task 19: MemoryRecentsStrip switches to MemoryItemRow style

**Files:**
- Modify: `ui/src/components/memory/MemoryRecentsStrip.tsx:43-122`

- [ ] **Step 1: Replace internal `iconFor` + button render with the comfortable row**

Reuse `MemoryItemRow` directly. Pass an `active={false}` (Recents on Home doesn't track active). Width auto-fills the panel.

- [ ] **Step 2: Manual verification**

On Home, the recents list now shows snippets under each title.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/memory/MemoryRecentsStrip.tsx
git commit -m "refactor(memory): recents strip uses comfortable item rows"
```

---

### Task 20: Phase 2 verification + ship checkpoint

- [ ] **Step 1: Run all UI tests**

```bash
pnpm --filter ui test
pnpm --filter ui exec tsc --noEmit
```

- [ ] **Step 2: Manual smoke**

In dev server:
1. View toggle visible in center-pane breadcrumb ✓
2. List default; switch to Table; switch to Cards; reload — last mode persists ✓
3. Cards adapt: markdown shows snippet, image shows gradient, PDF shows extracted preview ✓
4. Recents on Home shows snippets ✓

- [ ] **Step 3: Stop and review**

Phase 2 is shippable. Open a PR.

---

## Phase 3 — Tabbed right pane

### Task 21: MemoryTab type + reducer

**Files:**
- Create: `ui/src/lib/memoryTabs.ts`
- Test: `ui/src/lib/__tests__/memoryTabs.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { reduce, type TabsState, openOrActivate, closeTab } from "../memoryTabs";

const tab = (id: string): any => ({ id, kind: "memory_item", title: id });

describe("memoryTabs reducer", () => {
  const empty: TabsState = { tabs: [], activeId: null };

  it("openOrActivate appends a new tab", () => {
    const s = openOrActivate(empty, tab("a"));
    expect(s).toEqual({ tabs: [tab("a")], activeId: "a" });
  });

  it("openOrActivate activates an existing tab without dup", () => {
    const s1 = openOrActivate(empty, tab("a"));
    const s2 = openOrActivate(s1, tab("b"));
    const s3 = openOrActivate(s2, tab("a"));
    expect(s3.tabs.length).toBe(2);
    expect(s3.activeId).toBe("a");
  });

  it("closeTab activates previous tab", () => {
    const s = { tabs: [tab("a"), tab("b"), tab("c")], activeId: "b" };
    expect(closeTab(s, "b")).toEqual({ tabs: [tab("a"), tab("c")], activeId: "a" });
  });

  it("closeTab on last tab resets to empty", () => {
    const s = { tabs: [tab("a")], activeId: "a" };
    expect(closeTab(s, "a")).toEqual({ tabs: [], activeId: null });
  });

  it("closeTab inactive does not change activeId", () => {
    const s = { tabs: [tab("a"), tab("b")], activeId: "a" };
    expect(closeTab(s, "b")).toEqual({ tabs: [tab("a")], activeId: "a" });
  });
});
```

- [ ] **Step 2: Implement**

```ts
// ui/src/lib/memoryTabs.ts
export interface MemoryTab {
  id: string;
  kind: "memory_item" | "asset";
  title: string;
}
export interface TabsState { tabs: MemoryTab[]; activeId: string | null; }

export function openOrActivate(state: TabsState, tab: MemoryTab): TabsState {
  if (state.tabs.some(t => t.id === tab.id)) return { ...state, activeId: tab.id };
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

export function closeTab(state: TabsState, id: string): TabsState {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return state;
  const tabs = state.tabs.filter(t => t.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  if (tabs.length === 0) return { tabs, activeId: null };
  // activate previous (left) tab; if closing first, activate the new first
  const newActive = idx > 0 ? state.tabs[idx - 1].id : tabs[0].id;
  return { tabs, activeId: newActive };
}
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter ui test -- memoryTabs
git add ui/src/lib/memoryTabs.ts ui/src/lib/__tests__/memoryTabs.test.ts
git commit -m "feat(memory): tabs reducer with open-or-activate semantics"
```

---

### Task 22: useMemoryTabs hook with URL sync

**Files:**
- Create: `ui/src/hooks/useMemoryTabs.ts`
- Test: `ui/src/hooks/__tests__/useMemoryTabs.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useMemoryTabs } from "../useMemoryTabs";

const wrapper = ({ children }: any) => <MemoryRouter initialEntries={["/x"]}>{children}</MemoryRouter>;

describe("useMemoryTabs", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useMemoryTabs(), { wrapper });
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeId).toBeNull();
  });

  it("openOrActivate updates URL search param", () => {
    const { result } = renderHook(() => useMemoryTabs(), { wrapper });
    act(() => result.current.openOrActivate({ id: "i1", kind: "memory_item", title: "README" }));
    expect(result.current.activeId).toBe("i1");
    expect(result.current.tabs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement**

```tsx
// ui/src/hooks/useMemoryTabs.ts
import { useCallback } from "react";
import { useSearchParams } from "@/lib/router";
import {
  openOrActivate as openOrActivateReducer,
  closeTab as closeTabReducer,
  type MemoryTab,
  type TabsState,
} from "../lib/memoryTabs";

const TABS_PARAM = "tabs";  // comma-separated "kind:id:title"
const ACTIVE_PARAM = "active";

function encode(tab: MemoryTab): string {
  return `${tab.kind}:${tab.id}:${encodeURIComponent(tab.title)}`;
}
function decode(s: string): MemoryTab | null {
  const [kind, id, ...titleParts] = s.split(":");
  if (!kind || !id) return null;
  if (kind !== "memory_item" && kind !== "asset") return null;
  return { kind, id, title: decodeURIComponent(titleParts.join(":")) };
}

function read(params: URLSearchParams): TabsState {
  const raw = params.get(TABS_PARAM) ?? "";
  const tabs = raw ? raw.split(",").map(decode).filter(Boolean) as MemoryTab[] : [];
  const activeId = params.get(ACTIVE_PARAM);
  return {
    tabs,
    activeId: activeId && tabs.some(t => t.id === activeId) ? activeId : tabs[0]?.id ?? null,
  };
}

function write(params: URLSearchParams, state: TabsState) {
  if (state.tabs.length === 0) {
    params.delete(TABS_PARAM); params.delete(ACTIVE_PARAM);
  } else {
    params.set(TABS_PARAM, state.tabs.map(encode).join(","));
    if (state.activeId) params.set(ACTIVE_PARAM, state.activeId);
    else params.delete(ACTIVE_PARAM);
  }
}

export function useMemoryTabs() {
  const [params, setParams] = useSearchParams();
  const state = read(params);

  const openOrActivate = useCallback((tab: MemoryTab) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      const cur = read(next);
      const updated = openOrActivateReducer(cur, tab);
      write(next, updated);
      return next;
    });
  }, [setParams]);

  const close = useCallback((id: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      const cur = read(next);
      const updated = closeTabReducer(cur, id);
      write(next, updated);
      return next;
    });
  }, [setParams]);

  const setActive = useCallback((id: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(ACTIVE_PARAM, id);
      return next;
    });
  }, [setParams]);

  return { tabs: state.tabs, activeId: state.activeId, openOrActivate, close, setActive };
}
```

- [ ] **Step 3: Tests pass + commit**

```bash
pnpm --filter ui test -- useMemoryTabs
git add ui/src/hooks/useMemoryTabs.ts ui/src/hooks/__tests__/useMemoryTabs.test.tsx
git commit -m "feat(memory): useMemoryTabs URL-backed tab state"
```

---

### Task 23: MemoryViewerTabs

**Files:**
- Create: `ui/src/components/memory/MemoryViewerTabs.tsx`
- Test: `ui/src/components/memory/__tests__/MemoryViewerTabs.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryViewerTabs } from "../MemoryViewerTabs";

const tabs = [
  { id: "a", kind: "memory_item" as const, title: "README.md" },
  { id: "b", kind: "asset" as const, title: "logo.png" },
];

describe("MemoryViewerTabs", () => {
  it("renders all tabs and marks active", () => {
    const { getByText, container } = render(
      <MemoryViewerTabs tabs={tabs} activeId="a" onActivate={() => {}} onClose={() => {}} onCollapse={() => {}} />,
    );
    expect(getByText("README.md")).toBeInTheDocument();
    expect(container.querySelector("[data-active='true']")).toHaveTextContent("README.md");
  });

  it("fires onClose with id when close pressed", () => {
    const onClose = vi.fn();
    const { container } = render(
      <MemoryViewerTabs tabs={tabs} activeId="a" onActivate={() => {}} onClose={onClose} onCollapse={() => {}} />,
    );
    const closeBtn = container.querySelector("[data-tab-id='b'] [data-slot='close']") as HTMLButtonElement;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledWith("b");
  });
});
```

- [ ] **Step 2: Implement**

```tsx
// ui/src/components/memory/MemoryViewerTabs.tsx
import { FileText, Image as ImageIcon, X, PanelRightClose } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MemoryTab } from "../../lib/memoryTabs";

interface Props {
  tabs: MemoryTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCollapse: () => void;
}

function IconForTab({ tab }: { tab: MemoryTab }) {
  if (tab.kind === "asset") return <ImageIcon className="size-3.5 shrink-0" />;
  return <FileText className="size-3.5 shrink-0" />;
}

export function MemoryViewerTabs({ tabs, activeId, onActivate, onClose, onCollapse }: Props) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-card">
      <div className="flex flex-1 overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              data-tab-id={t.id}
              data-active={active}
              role="tab"
              tabIndex={0}
              onClick={() => onActivate(t.id)}
              className={cn(
                "group relative inline-flex h-[30px] cursor-pointer items-center gap-1.5 border-r border-border pl-2.5 pr-2 text-xs",
                "max-w-[220px]",
                active
                  ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
            >
              <IconForTab tab={t} />
              <span className="truncate">{t.title}</span>
              <button
                data-slot="close"
                onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
                className={cn(
                  "ml-1 rounded p-0.5 transition-opacity",
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  "hover:bg-white/[0.08]",
                )}
              >
                <X className="size-3" />
              </button>
              {active && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
                />
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onCollapse}
        title="Collapse pane"
        className="flex h-9 w-9 shrink-0 items-center justify-center border-l border-border text-very-dim hover:text-foreground"
      >
        <PanelRightClose className="size-3.5" />
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Tests pass + commit**

```bash
pnpm --filter ui test -- MemoryViewerTabs
git add ui/src/components/memory/MemoryViewerTabs.tsx ui/src/components/memory/__tests__/MemoryViewerTabs.test.tsx
git commit -m "feat(memory): MemoryViewerTabs horizontal tab bar"
```

---

### Task 24: MemoryCollapsedTabStrip (vertical tabs)

**Files:**
- Create: `ui/src/components/memory/MemoryCollapsedTabStrip.tsx`

- [ ] **Step 1: Implement**

```tsx
// ui/src/components/memory/MemoryCollapsedTabStrip.tsx
import { FileText, Image as ImageIcon, PanelRightOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MemoryTab } from "../../lib/memoryTabs";

interface Props {
  tabs: MemoryTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onExpand: () => void;
}

export function MemoryCollapsedTabStrip({ tabs, activeId, onActivate, onExpand }: Props) {
  return (
    <aside className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-l border-border bg-card py-2">
      <button
        type="button"
        onClick={onExpand}
        title="Expand pane"
        className="flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
      >
        <PanelRightOpen className="size-4" />
      </button>
      <div className="my-1 h-px w-6 bg-border-soft" />
      {tabs.map((t) => {
        const active = t.id === activeId;
        const Icon = t.kind === "asset" ? ImageIcon : FileText;
        return (
          <button
            key={t.id}
            type="button"
            title={t.title}
            onClick={() => onActivate(t.id)}
            className={cn(
              "relative flex size-10 items-center justify-center rounded-md",
              active ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {active && (
              <span
                aria-hidden
                className="pointer-events-none absolute -left-[3px] top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-r bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
              />
            )}
          </button>
        );
      })}
    </aside>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/memory/MemoryCollapsedTabStrip.tsx
git commit -m "feat(memory): MemoryCollapsedTabStrip vertical icon strip"
```

---

### Task 25: Wire tabs through MemoryViewer

**Files:**
- Modify: `ui/src/components/memory/MemoryViewer.tsx:13-97`

- [ ] **Step 1: Update viewer to render the active tab**

```tsx
// MemoryViewer.tsx — diff (high-level)
- interface MemoryViewerProps {
-   companyId: string; selectedItemId: string | null; selectedItemType: "memory_item"|"asset"|null; folderPath: string; onCollapse?: () => void;
- }
+ interface MemoryViewerProps {
+   companyId: string;
+   tabs: MemoryTab[];
+   activeId: string | null;
+   onActivate: (id: string) => void;
+   onClose: (id: string) => void;
+   onCollapse: () => void;
+ }

  export function MemoryViewer(props: MemoryViewerProps) {
+   const active = props.tabs.find(t => t.id === props.activeId) ?? null;
+   let inner: React.ReactNode;
+   if (active && active.kind === "memory_item") inner = <MarkdownItemViewer companyId={props.companyId} itemId={active.id} />;
+   else if (active && active.kind === "asset") inner = <AssetViewerSlot companyId={props.companyId} assetId={active.id} />;
+   else inner = <MemoryEmptyViewer />;

    return (
      <div className="h-full flex flex-col">
+       <MemoryViewerTabs tabs={props.tabs} activeId={props.activeId} onActivate={props.onActivate} onClose={props.onClose} onCollapse={props.onCollapse} />
        <div className="flex-1 min-h-0 overflow-auto">{inner}</div>
      </div>
    );
  }
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/memory/MemoryViewer.tsx
git commit -m "refactor(memory): MemoryViewer renders active tab from tab list"
```

---

### Task 26: Wire tabs into MemoryExplorer + list-row click

**Files:**
- Modify: `ui/src/pages/MemoryExplorer.tsx`
- Modify: `ui/src/components/memory/MemoryFileList.tsx` (selectRow)

- [ ] **Step 1: Hook into MemoryExplorer**

```tsx
// MemoryExplorer.tsx — diff
+ const { tabs, activeId, openOrActivate, close, setActive } = useMemoryTabs();

  // Replace selectedItemId/Type props down through MemoryFileList:
- selectedItemId={selectedItemId} selectedItemType={selectedItemType}
+ selectedItemId={activeId} selectedItemType={tabs.find(t => t.id === activeId)?.kind ?? null}
+ onSelectRow={(id, kind, title) => openOrActivate({ id, kind, title })}

  // Right pane:
- {viewerCollapsed ? <CollapsedRail ... /> : <MemoryViewer ... />}
+ {viewerCollapsed ? (
+   <MemoryCollapsedTabStrip tabs={tabs} activeId={activeId} onActivate={(id) => { setActive(id); viewerPanelRef.current?.expand(); }} onExpand={() => viewerPanelRef.current?.expand()} />
+ ) : (
+   <MemoryViewer companyId={selectedCompanyId} tabs={tabs} activeId={activeId} onActivate={setActive} onClose={close} onCollapse={() => viewerPanelRef.current?.collapse()} />
+ )}
```

- [ ] **Step 2: Update MemoryFileList.selectRow signature**

Add `onSelectRow` to `MemoryFileListProps`:

```tsx
// MemoryFileList.tsx — diff
  interface MemoryFileListProps {
    companyId: string;
    folderPath: string;
    departmentId: string | null;
    layer?: string | null;
    selectedItemId: string | null;
    selectedItemType: "memory_item" | "asset" | null;
    searchQuery?: string;
+   onSelectRow: (id: string, kind: "memory_item" | "asset", title: string) => void;
  }

  // Inside the component, replace the URL-mutating selectRow with the prop callback:
- function selectRow(row: ListRow) {
-   const params = new URLSearchParams(window.location.search);
-   params.set("item", row.id);
-   params.set("type", row.kind);
-   navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
- }
+ const selectRow = (row: ListRow) => onSelectRow(row.id, row.kind, row.name);
```

- [ ] **Step 3: Manual verification**

1. Click an item in the list → opens as a tab on the right ✓
2. Click another item → second tab opens, becomes active ✓
3. Click the first item again → first tab activates (no dup) ✓
4. Close active tab → previous tab activates ✓
5. Close last tab → empty viewer state ✓
6. Reload page → tabs survive (URL-backed) ✓

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/MemoryExplorer.tsx ui/src/components/memory/MemoryFileList.tsx
git commit -m "feat(memory): list rows open as tabs in the right pane"
```

---

### Task 27: Phase 3 verification + ship checkpoint

- [ ] **Step 1: Tests + tsc**

```bash
pnpm --filter ui test
pnpm --filter ui exec tsc --noEmit
```

- [ ] **Step 2: Manual smoke** — full tab flow end-to-end as in Task 26 step 3.

- [ ] **Step 3: Stop and review.** Open a PR for Phase 3.

---

## Phase 4 — Left pane icon rail

### Task 28: MemoryFolderRail

**Files:**
- Create: `ui/src/components/memory/MemoryFolderRail.tsx`
- Test: `ui/src/components/memory/__tests__/MemoryFolderRail.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryFolderRail } from "../MemoryFolderRail";

describe("MemoryFolderRail", () => {
  it("renders 5 shortcuts and 4 layer icons", () => {
    const { container } = render(
      <MemoryFolderRail
        counts={{ pinned: 7, pending: 3, recent: 22, archived: 36, identity: 12, domain: 24, active_context: 8, working: 2 }}
        activeKind={null}
        onSelect={() => {}}
        onExpand={() => {}}
      />
    );
    // 1 expand button + 5 shortcuts + 4 layers = 10 buttons total
    expect(container.querySelectorAll("button")).toHaveLength(10);
  });

  it("renders pending badge with brand tone", () => {
    const { container } = render(
      <MemoryFolderRail
        counts={{ pinned: 0, pending: 3, recent: 0, archived: 0, identity: 0, domain: 0, active_context: 0, working: 0 }}
        activeKind={null}
        onSelect={() => {}}
        onExpand={() => {}}
      />
    );
    expect(container.querySelector("[data-badge='pending']")).toHaveTextContent("3");
  });
});
```

- [ ] **Step 2: Implement**

Render: expand button (PanelLeftOpen), divider, 5 shortcuts (Home/Pin/Inbox/Clock/Archive), divider, 4 layers (IdCard/Building2/Target/Zap). Active state uses brand wash. Pending shortcut shows a small brand-red badge with the count.

```tsx
// ui/src/components/memory/MemoryFolderRail.tsx
import {
  PanelLeftOpen, Home, Pin, Inbox, Clock, Archive,
  IdCard, Building2, Target, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

type ActiveKind =
  | "home" | "pinned" | "pending" | "recent" | "archived"
  | "identity" | "domain" | "active_context" | "working"
  | null;

interface Props {
  counts: {
    pinned: number; pending: number; recent: number; archived: number;
    identity: number; domain: number; active_context: number; working: number;
  };
  activeKind: ActiveKind;
  onSelect: (kind: Exclude<ActiveKind, null>) => void;
  onExpand: () => void;
}

const SHORTCUTS = [
  { kind: "home", title: "Home", Icon: Home, countKey: null },
  { kind: "pinned", title: "Pinned", Icon: Pin, countKey: "pinned" },
  { kind: "pending", title: "Pending Review", Icon: Inbox, countKey: "pending", brand: true },
  { kind: "recent", title: "Recent", Icon: Clock, countKey: "recent" },
  { kind: "archived", title: "Archived", Icon: Archive, countKey: "archived" },
] as const;

const LAYERS = [
  { kind: "identity", title: "Identity", Icon: IdCard, tone: "var(--data-indigo)" },
  { kind: "domain", title: "Domain", Icon: Building2, tone: "var(--data-teal)" },
  { kind: "active_context", title: "Active context", Icon: Target, tone: "var(--data-amber)" },
  { kind: "working", title: "Working", Icon: Zap, tone: "var(--data-magenta)" },
] as const;

function RailBtn({ active, title, onClick, children }: any) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "relative flex size-10 items-center justify-center rounded-md",
        active ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function MemoryFolderRail({ counts, activeKind, onSelect, onExpand }: Props) {
  return (
    <aside className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2">
      <RailBtn active={false} title="Expand folders" onClick={onExpand}>
        <PanelLeftOpen className="size-4" />
      </RailBtn>
      <div className="my-1 h-px w-6 bg-border-soft" />
      {SHORTCUTS.map(({ kind, title, Icon, countKey, brand }) => {
        const count = countKey ? counts[countKey] : 0;
        return (
          <RailBtn key={kind} active={activeKind === kind} title={`${title}${count ? ` (${count})` : ""}`} onClick={() => onSelect(kind)}>
            <Icon className="size-4" />
            {countKey && count > 0 && (
              <span
                data-badge={kind}
                className={cn(
                  "absolute -right-0.5 -top-0.5 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-1 text-[9px] font-semibold",
                  "shadow-[0_0_0_2px_var(--bg)]",
                  brand ? "bg-brand text-white" : "bg-muted text-foreground",
                )}
              >
                {count}
              </span>
            )}
          </RailBtn>
        );
      })}
      <div className="my-1 h-px w-6 bg-border-soft" />
      {LAYERS.map(({ kind, title, Icon }) => (
        <RailBtn key={kind} active={activeKind === kind} title={title} onClick={() => onSelect(kind)}>
          <Icon className="size-4" />
        </RailBtn>
      ))}
    </aside>
  );
}
```

- [ ] **Step 3: Tests pass + commit**

```bash
pnpm --filter ui test -- MemoryFolderRail
git add ui/src/components/memory/MemoryFolderRail.tsx ui/src/components/memory/__tests__/MemoryFolderRail.test.tsx
git commit -m "feat(memory): MemoryFolderRail icon-only collapsed left pane"
```

---

### Task 29: Wire MemoryFolderRail in MemoryExplorer

**Files:**
- Modify: `ui/src/pages/MemoryExplorer.tsx` (replace `treeCollapsed ? <CollapsedRail …/>` with `<MemoryFolderRail …/>`)

- [ ] **Step 1: Compute counts from items query (already loaded by MemoryTree)**

Lift the `counts` computation out of `MemoryTree` into a small shared hook `useMemoryCounts(companyId)`, or just duplicate the small derivation inside `MemoryExplorer`. It's a small `useMemo` over the items query.

```tsx
// MemoryExplorer.tsx — diff
+ const { data: items } = useQuery({ queryKey: queryKeys.memory.list(selectedCompanyId), queryFn: () => memoryApi.list(selectedCompanyId, {}) });
+ const counts = useMemo(() => deriveMemoryCounts(items ?? []), [items]);
+ const activeRailKind = activeRailKindFromUrl({ folderPath, departmentId, layer });

  {treeCollapsed ? (
-   <CollapsedRail onExpand={() => treePanelRef.current?.expand()} direction="right" />
+   <MemoryFolderRail
+     counts={counts}
+     activeKind={activeRailKind}
+     onSelect={(kind) => { navigateRail(kind); treePanelRef.current?.expand(); }}
+     onExpand={() => treePanelRef.current?.expand()}
+   />
  ) : (
    <MemoryTree ... />
  )}
```

`navigateRail` resolves `kind → URL` (`__pinned`, `__pending`, layer key, etc.). Keep this resolver in `ui/src/lib/memoryRail.ts` so it's testable.

- [ ] **Step 2: Manual verification**

Drag the left pane to collapsed (or click `PanelLeftClose`) → icon rail appears with 5 shortcuts + 4 layers. Click any icon → navigates + auto-expands.

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/MemoryExplorer.tsx ui/src/lib/memoryRail.ts
git commit -m "feat(memory): collapsed left pane shows MemoryFolderRail"
```

---

### Task 30: Phase 4 verification + ship

- [ ] **Step 1: Tests + tsc**

```bash
pnpm --filter ui test
pnpm --filter ui exec tsc --noEmit
```

- [ ] **Step 2: Manual smoke**

1. Collapse left → icons rail shows ✓
2. Click `Pinned` → navigates to `?folder=__pinned`, pane auto-expands ✓
3. Pending badge appears with brand-red color when `counts.pending > 0` ✓
4. All 4 layer icons clickable + navigate correctly ✓

- [ ] **Step 3: Open PR for Phase 4.**

---

## Phase 5 — Cleanup + ship

### Task 31: Delete obsolete code paths

**Files:**
- Modify: `ui/src/components/memory/MemoryHomeDashboard.tsx` — drop the "Memory graph view — Coming soon" placeholder (this lived in `MemoryExplorer.tsx:158-172`, already removed when the right pane became hidden on Home in Task 25; double-check no stale text remains).
- Verify: `ui/src/pages/Memory.tsx` (legacy) still renders at `/memory/legacy`. Leave it — out of scope to delete.

- [ ] **Step 1: Grep for dangling**

```bash
grep -rn "graph view" ui/src/
grep -rn "PendingReviewBanner" ui/src/
grep -rn "STATUS_COLORS" ui/src/components/memory/
```
Expected: zero or only intended hits.

- [ ] **Step 2: Commit if anything found**

---

### Task 32: Update CLAUDE.md memory section

**Files:**
- Modify: `CLAUDE.md` — bump the memory description to mention tabbed viewer + view modes.

- [ ] **Step 1: Add a one-line note in the Memory subsection**

Find the V2 Memory bullet in CLAUDE.md and add one line:

```
- **Memory tab UI (May 2026):** 3-pane explorer with tabbed right pane (URL-backed), three center-pane view modes (List default / Table / Cards adaptive, persisted via localStorage), Lucide-only iconography, brand-red active state matching SidebarNavItem. Phase 2 (semantic + link graph + embedding surfaces) deferred.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note Memory UI overhaul in CLAUDE.md"
```

---

### Task 33: Final verification + ship

- [ ] **Step 1: Full test suite**

```bash
pnpm --filter ui test
pnpm --filter ui exec tsc --noEmit
pnpm --filter ui build
```

- [ ] **Step 2: Lighthouse / visual sweep against the mockup**

Open the dev server and walk every state from [`mockups/memory-redesign.html`](../../../mockups/memory-redesign.html):
- State 1 (default) → matches
- State 2 (right collapsed) → matches
- State 3 (left collapsed) → matches
- State 4 (Home) → matches
- State 5 (any view mode) → toggle works, persists, snippets render

- [ ] **Step 3: Open the final PR.**

```bash
git push origin feat/memory-ui-overhaul
# then `gh pr create` against main
```

---

## Out of Scope (Phase 2 — separate plan)

These are intentionally deferred. A separate plan will cover them once Phase 1 ships:

- Semantic Home graph (UMAP from existing 1536-dim embeddings)
- Link-graph layer (existing relations: goal, dept, discussion, artifact, version) + new `memory_item_links` table for explicit cross-references
- "Connections" tab inside the viewer (backlinks, outgoing, semantically near, provenance)
- Indexing status badge (`Indexed` / `Queued` / `Failed`) in viewer header
- "Related items" panel (top 5 cosine neighbours)
- `[[wiki-link]]` autocomplete in the markdown editor
- Per-item / per-PDF chunk visualization
- "Used" column real data wiring (currently zero-filled until run-summary aggregation lands)

These are listed in [`mockups/memory-redesign-notes.md`](../../../mockups/memory-redesign-notes.md) under "Phase 2".
