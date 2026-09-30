# Memory Page Redesign — Phase 6.1d (Home + Search + ⌘K) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the landing experience the original spec called for — a memory home page (pending review banner + dept tiles + recents) at `/memory`, the explorer accessible at `/memory/explore`, plus a ⌘K global quick-switcher overlay and a top-bar scoped search input inside the explorer. This closes the last big gap from Slice C / Q6 of brainstorming.

**Architecture:** No new server routes — all search uses the existing `memoryApi.list` (returns all company memory items, then client-side filter for ⌘K and scoped search). Three new UI components (`MemoryHome`, `MemoryQuickSwitcher`, `MemoryScopedSearch`) plus a route swap so `/memory` lands on Home, `/memory/explore` is the explorer, `/memory/legacy` keeps the old filter-list. ⌘K is mounted globally inside the layout so it's reachable from any page (parity with the existing global cmd-K search if any — verify first).

**Tech Stack:** Existing AoA UI patterns. Use `cmdk` library (Radix's keyboard-driven command palette) if it's already a dep — otherwise hand-roll with shadcn `Dialog` + simple keyboard bindings. Verify before adding deps.

**Out of scope (later):**
- Semantic ⌘K (would need an HTTP wrapper around `searchMultiPath` from Phase 0 — currently MCP-only). v1 ⌘K does substring + fuzzy on title/content client-side, which is still useful.
- Pending Review virtual folder in tree (polish slice).
- Drag-and-drop folder rearrange (polish slice).
- Mobile/narrow-viewport layout.

**Branch + worktree:** `memory-phase-6-0` in `.claude/worktrees/memory-phase-6-0/`. Most recent commit: `cf94e73`.

---

## File Structure

### New files

```
ui/src/pages/MemoryHome.tsx                                    ← landing page at /memory
ui/src/components/memory/PendingReviewBanner.tsx               ← top banner on home (self-hides when 0)
ui/src/components/memory/DepartmentTile.tsx                    ← per-dept card with counts
ui/src/components/memory/MemoryRecentsStrip.tsx                ← recent items list
ui/src/components/memory/MemoryQuickSwitcher.tsx               ← ⌘K overlay
ui/src/components/memory/MemoryScopedSearch.tsx                ← top-bar input in explorer
ui/src/__tests__/MemoryHome.test.tsx
ui/src/__tests__/MemoryQuickSwitcher.test.tsx
```

### Modified files

```
ui/src/App.tsx                                                 ← route swap: home at /memory, explorer at /memory/explore
ui/src/pages/MemoryExplorer.tsx                                ← consume MemoryScopedSearch in toolbar
ui/src/components/Layout.tsx (or wherever the global cmd-K hook lives) ← mount MemoryQuickSwitcher
```

### Why this split

`MemoryHome` is the page; the three composing components (`PendingReviewBanner`, `DepartmentTile`, `MemoryRecentsStrip`) are split out because each has distinct data fetching + render logic and makes the page file readable. `MemoryQuickSwitcher` lives in `components/memory/` not in a global `components/` because it specifically searches memory; if/when other ⌘K palettes are added (tasks, agents) they'd be siblings. `MemoryScopedSearch` is small and explorer-specific.

---

## Task 1: MemoryHome page + composing components

**Files:**
- Create: `ui/src/pages/MemoryHome.tsx`
- Create: `ui/src/components/memory/PendingReviewBanner.tsx`
- Create: `ui/src/components/memory/DepartmentTile.tsx`
- Create: `ui/src/components/memory/MemoryRecentsStrip.tsx`
- Create: `ui/src/__tests__/MemoryHome.test.tsx`

- [ ] Step 1: Branch safety check.

- [ ] Step 2: Read existing patterns. Check the existing `Memory.tsx` (legacy page) for how it queries memory + projects. Check `Lobby.tsx` or similar for the existing tile-grid pattern. Confirm `useNavigate` from `@/lib/router`.

- [ ] Step 3: Write `PendingReviewBanner.tsx`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import type { MemoryItem } from "@armyofagents/shared";

interface PendingReviewBannerProps {
  companyId: string;
}

/**
 * Top banner on MemoryHome. Self-hides when zero pending across all
 * departments — no naggy empty state.
 *
 * Shows aggregate count + per-dept breakdown + a "Review" button that jumps
 * to the explorer scoped to whichever dept has the most pending.
 */
export function PendingReviewBanner({ companyId }: PendingReviewBannerProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = (selectedCompany as { issuePrefix?: string } | null)?.issuePrefix ?? "";

  const { data: items } = useQuery({
    queryKey: queryKeys.memory.list(companyId),
    queryFn: () => memoryApi.list(companyId, {}),
  });

  const pending = (items ?? []).filter((it: MemoryItem) => it.status === "pending");
  if (pending.length === 0) return null;

  // Group by departmentId so we can show breakdown like "Eng 14 · Mkt 2 · Support 1"
  const byDept = new Map<string | null, number>();
  for (const it of pending) {
    const k = (it as MemoryItem & { departmentId?: string | null }).departmentId ?? null;
    byDept.set(k, (byDept.get(k) ?? 0) + 1);
  }

  // Pick dept with most pending for the "Review" jump target
  let topDept: string | null = null;
  let topCount = 0;
  for (const [k, v] of byDept.entries()) {
    if (v > topCount) {
      topCount = v;
      topDept = k;
    }
  }

  function jumpToReview() {
    const params = new URLSearchParams();
    if (topDept) params.set("dept", topDept);
    // The explorer's pending review folder will surface in a future polish slice;
    // for now scope to the dept with most pending and the founder can scan.
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
  }

  return (
    <div className="px-4 py-3 bg-amber-100 dark:bg-amber-900/40 border border-amber-200 dark:border-amber-900 rounded-md flex items-center gap-3">
      <Clock className="h-5 w-5 text-amber-700 dark:text-amber-300 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
          {pending.length} {pending.length === 1 ? "item" : "items"} waiting for your review
        </div>
        <div className="text-[11px] text-amber-700 dark:text-amber-300 mt-0.5 truncate">
          across {byDept.size} {byDept.size === 1 ? "scope" : "scopes"}
        </div>
      </div>
      <Button
        size="sm"
        onClick={jumpToReview}
        className="bg-amber-700 hover:bg-amber-800 text-white text-xs"
      >
        Review
      </Button>
    </div>
  );
}
```

- [ ] Step 4: Write `DepartmentTile.tsx`:

```typescript
import { useNavigate } from "@/lib/router";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCompany } from "../../context/CompanyContext";

interface DepartmentTileProps {
  label: string;
  icon?: string | LucideIcon;
  itemCount: number;
  pendingCount: number;
  /** Path to navigate to when the tile is clicked. Auto-prefixed with companyPrefix. */
  to: string;
}

export function DepartmentTile({ label, icon, itemCount, pendingCount, to }: DepartmentTileProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = (selectedCompany as { issuePrefix?: string } | null)?.issuePrefix ?? "";
  const Icon = typeof icon === "function" ? (icon as LucideIcon) : null;

  return (
    <button
      onClick={() => navigate(`/${companyPrefix}${to}`)}
      className={cn(
        "text-left p-4 rounded-md border border-border bg-card",
        "hover:border-primary/50 hover:shadow-md transition-all duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        {Icon ? (
          <Icon className="h-4 w-4 text-muted-foreground" />
        ) : (
          <span className="text-base leading-none">{icon ?? "📁"}</span>
        )}
        <div className="font-medium text-sm">{label}</div>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {itemCount} {itemCount === 1 ? "item" : "items"}
      </div>
      {pendingCount > 0 && (
        <div className="text-[11px] text-amber-700 dark:text-amber-300 mt-1">
          ⏳ {pendingCount} pending
        </div>
      )}
    </button>
  );
}
```

- [ ] Step 5: Write `MemoryRecentsStrip.tsx`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { FileText, File as FileIcon, Image as ImageIcon, FileType } from "lucide-react";
import { memoryApi } from "../../api/memory";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import type { MemoryItem, MemoryAssetRecord } from "@armyofagents/shared";

interface MemoryRecentsStripProps {
  companyId: string;
}

interface RecentRow {
  kind: "memory_item" | "asset";
  id: string;
  name: string;
  modifiedAt: string;
  mimeType?: string;
  folderPath?: string;
  departmentId?: string | null;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function MemoryRecentsStrip({ companyId }: MemoryRecentsStripProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = (selectedCompany as { issuePrefix?: string } | null)?.issuePrefix ?? "";

  const itemsQuery = useQuery({
    queryKey: queryKeys.memory.list(companyId),
    queryFn: () => memoryApi.list(companyId, {}),
  });
  const assetsQuery = useQuery({
    queryKey: queryKeys.memory.assets.list(companyId),
    queryFn: () => memoryAssetsApi.list(companyId),
  });

  const rows: RecentRow[] = [
    ...((itemsQuery.data ?? []) as MemoryItem[]).map<RecentRow>((it) => ({
      kind: "memory_item",
      id: it.id,
      name: it.title,
      modifiedAt: typeof it.updatedAt === "string" ? it.updatedAt : new Date(it.updatedAt).toISOString(),
      folderPath: (it as MemoryItem & { folderPath?: string }).folderPath,
      departmentId: (it as MemoryItem & { departmentId?: string | null }).departmentId,
    })),
    ...((assetsQuery.data ?? []) as MemoryAssetRecord[]).map<RecentRow>((a) => ({
      kind: "asset",
      id: a.id,
      name: a.fileName,
      modifiedAt: a.updatedAt,
      mimeType: a.mimeType,
      folderPath: a.folderPath,
      departmentId: a.departmentId,
    })),
  ]
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
    .slice(0, 10);

  function iconFor(row: RecentRow) {
    if (row.kind === "memory_item") return FileText;
    if (!row.mimeType) return FileIcon;
    if (row.mimeType.startsWith("image/")) return ImageIcon;
    if (row.mimeType === "application/pdf") return FileType;
    return FileIcon;
  }

  function openRow(row: RecentRow) {
    const params = new URLSearchParams();
    if (row.folderPath) params.set("folder", row.folderPath);
    if (row.departmentId) params.set("dept", row.departmentId);
    params.set("item", row.id);
    params.set("type", row.kind);
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
  }

  if (itemsQuery.isLoading || assetsQuery.isLoading) {
    return <div className="text-xs text-muted-foreground">Loading recents…</div>;
  }
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground">No recent activity yet.</div>;
  }

  return (
    <div className="space-y-1">
      {rows.map((row) => {
        const Icon = iconFor(row);
        return (
          <button
            key={`${row.kind}-${row.id}`}
            onClick={() => openRow(row)}
            className="w-full text-left flex items-center gap-2 px-3 py-2 rounded hover:bg-muted/40 text-xs transition-colors duration-100"
          >
            <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span className="flex-1 truncate font-medium">{row.name}</span>
            <span className="text-muted-foreground tabular-nums">{formatRelative(row.modifiedAt)}</span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] Step 6: Write `MemoryHome.tsx`:

```typescript
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Pin, Building2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { memoryApi } from "../api/memory";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PendingReviewBanner } from "../components/memory/PendingReviewBanner";
import { DepartmentTile } from "../components/memory/DepartmentTile";
import { MemoryRecentsStrip } from "../components/memory/MemoryRecentsStrip";
import type { MemoryItem, Project } from "@armyofagents/shared";

export function MemoryHome() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs, setEntityColor, setSubtitle } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }]);
    setEntityColor("var(--entity-memory)");
    return () => {
      setSubtitle(null);
      setEntityColor(null);
    };
  }, [setBreadcrumbs, setEntityColor, setSubtitle]);

  const itemsQuery = useQuery({
    queryKey: queryKeys.memory.list(selectedCompanyId ?? ""),
    queryFn: () => memoryApi.list(selectedCompanyId!, {}),
    enabled: Boolean(selectedCompanyId),
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? ""),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const departments = useMemo(
    () =>
      (projectsQuery.data ?? []).filter(
        (p: Project) => p.type === "department" && !p.archivedAt,
      ),
    [projectsQuery.data],
  );

  const tilesData = useMemo(() => {
    const items = (itemsQuery.data ?? []) as Array<MemoryItem & { founderPinnedToTop?: boolean; departmentId?: string | null; layer?: string | null }>;

    // Pinned + Company virtual tiles
    const pinnedCount = items.filter((it) => it.founderPinnedToTop).length;
    const companyCount = items.filter((it) => it.departmentId === null && it.layer === "identity").length;

    const tiles: Array<{ key: string; label: string; icon?: typeof Pin | string; itemCount: number; pendingCount: number; to: string }> = [
      {
        key: "pinned",
        label: "Pinned",
        icon: Pin,
        itemCount: pinnedCount,
        pendingCount: 0,
        to: "/memory/explore?folder=__pinned",
      },
      {
        key: "company",
        label: "Company",
        icon: Building2,
        itemCount: companyCount,
        pendingCount: items.filter((it) => it.departmentId === null && it.layer === "identity" && it.status === "pending").length,
        to: "/memory/explore?folder=Company",
      },
    ];

    for (const dept of departments) {
      const deptItems = items.filter((it) => it.departmentId === dept.id);
      tiles.push({
        key: `dept-${dept.id}`,
        label: dept.name,
        icon: "📁",
        itemCount: deptItems.length,
        pendingCount: deptItems.filter((it) => it.status === "pending").length,
        to: `/memory/explore?dept=${encodeURIComponent(dept.id)}`,
      });
    }

    return tiles;
  }, [itemsQuery.data, departments]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to view memory." />;
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      {/* Pending review banner — self-hides when zero */}
      <PendingReviewBanner companyId={selectedCompanyId} />

      {/* Search input — placeholder for ⌘K hint */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search across all memory… (or press ⌘K)"
          className="pl-9 h-10"
          onFocus={(e) => {
            // Trigger ⌘K overlay instead of inline filtering on home; matches the brainstorm spec.
            e.target.blur();
            window.dispatchEvent(new CustomEvent("memory:open-quick-switcher"));
          }}
          readOnly
        />
      </div>

      {/* Department tiles */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Departments</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {tilesData.map((t) => (
            <DepartmentTile
              key={t.key}
              label={t.label}
              icon={t.icon}
              itemCount={t.itemCount}
              pendingCount={t.pendingCount}
              to={t.to}
            />
          ))}
        </div>
      </div>

      {/* Recents */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Recent</div>
        <MemoryRecentsStrip companyId={selectedCompanyId} />
      </div>
    </div>
  );
}
```

- [ ] Step 7: Smoke test:

```typescript
// ui/src/__tests__/MemoryHome.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../api/memory", () => ({
  memoryApi: {
    list: vi.fn(async () => [
      { id: "i-1", title: "Item one", status: "pending", departmentId: "d-eng", layer: "domain", updatedAt: "2026-05-01T00:00:00Z" },
      { id: "i-2", title: "Item two", status: "approved", departmentId: "d-eng", layer: "domain", updatedAt: "2026-05-02T00:00:00Z" },
    ]),
  },
}));
vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: { list: vi.fn(async () => []) },
}));
vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(async () => [
      { id: "d-eng", type: "department", name: "Engineering", archivedAt: null, urlKey: "engineering" },
      { id: "d-mkt", type: "department", name: "Marketing", archivedAt: null, urlKey: "marketing" },
    ]),
  },
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "co-1", selectedCompany: { issuePrefix: "co1" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn(), setSubtitle: vi.fn(), setEntityColor: vi.fn() }),
}));

import { MemoryHome } from "../pages/MemoryHome";

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemoryHome />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemoryHome (Phase 6.1d)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders pending banner when there are pending items", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText(/1 item waiting for your review/i)).toBeInTheDocument());
  });

  it("renders department tiles", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("Engineering")).toBeInTheDocument());
    expect(screen.getByText("Marketing")).toBeInTheDocument();
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("Company")).toBeInTheDocument();
  });

  it("renders recents", async () => {
    renderHome();
    // The 2 items mock above sorted by updatedAt — Item two newer, Item one older
    await waitFor(() => expect(screen.getByText("Item two")).toBeInTheDocument());
    expect(screen.getByText("Item one")).toBeInTheDocument();
  });
});
```

- [ ] Step 8: Run tests + typecheck. Commit:

```bash
git add ui/src/pages/MemoryHome.tsx ui/src/components/memory/PendingReviewBanner.tsx ui/src/components/memory/DepartmentTile.tsx ui/src/components/memory/MemoryRecentsStrip.tsx ui/src/__tests__/MemoryHome.test.tsx
git commit -m "feat(ui): MemoryHome page (banner + dept tiles + recents)"
```

---

## Task 2: Route swap — home at `/memory`, explorer at `/memory/explore`

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] Step 1: Branch safety.

- [ ] Step 2: Find the existing memory routes (currently at `memory` → MemoryExplorer, `memory/legacy` → Memory). Add a new `memory/explore` → MemoryExplorer and change `memory` → MemoryHome.

```typescript
// existing imports
import { MemoryHome } from "./pages/MemoryHome";

// in the route block — replace these two lines:
//   <Route path="memory" element={<MemoryExplorer />} />
//   <Route path="memory/legacy" element={<Memory />} />
// with:
<Route path="memory" element={<MemoryHome />} />
<Route path="memory/explore" element={<MemoryExplorer />} />
<Route path="memory/legacy" element={<Memory />} />
```

- [ ] Step 3: Run typecheck. Commit:

```bash
git add ui/src/App.tsx
git commit -m "refactor(ui): route swap — Home at /memory, Explorer at /memory/explore, legacy stays"
```

---

## Task 3: ⌘K Quick Switcher

**Files:**
- Create: `ui/src/components/memory/MemoryQuickSwitcher.tsx`
- Create: `ui/src/__tests__/MemoryQuickSwitcher.test.tsx`
- Modify: wherever the global Layout / app shell mounts is (likely `ui/src/components/Layout.tsx` or `ui/src/App.tsx`) — add `<MemoryQuickSwitcher />` so the keyboard binding is global.

- [ ] Step 1: Branch safety.

- [ ] Step 2: Check if `cmdk` library is already installed:

```bash
grep -n "cmdk" ui/package.json
```

If yes, use it (Radix command palette). If not, hand-roll with shadcn `Dialog` + simple keyboard bindings. **The simpler approach below uses shadcn Dialog + a basic input — no new dep needed.**

- [ ] Step 3: Implement:

```typescript
// ui/src/components/memory/MemoryQuickSwitcher.tsx
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Search, FileText, File as FileIcon, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { memoryApi } from "../../api/memory";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import type { MemoryItem, MemoryAssetRecord } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

interface ResultRow {
  kind: "memory_item" | "asset";
  id: string;
  title: string;
  subtitle: string;
  folderPath: string;
  departmentId: string | null;
}

const MAX_RESULTS = 12;

export function MemoryQuickSwitcher() {
  const navigate = useNavigate();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const companyPrefix = (selectedCompany as { issuePrefix?: string } | null)?.issuePrefix ?? "";

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  // Global ⌘K binding
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Cmd-K on macOS, Ctrl-K elsewhere
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Listen for the home-page input dispatching a custom event to open us
  useEffect(() => {
    function onOpen() { setOpen(true); }
    window.addEventListener("memory:open-quick-switcher", onOpen);
    return () => window.removeEventListener("memory:open-quick-switcher", onOpen);
  }, []);

  // Reset state when reopened
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
    }
  }, [open]);

  const itemsQuery = useQuery({
    queryKey: queryKeys.memory.list(selectedCompanyId ?? ""),
    queryFn: () => memoryApi.list(selectedCompanyId!, {}),
    enabled: open && Boolean(selectedCompanyId),
  });
  const assetsQuery = useQuery({
    queryKey: queryKeys.memory.assets.list(selectedCompanyId ?? ""),
    queryFn: () => memoryAssetsApi.list(selectedCompanyId!),
    enabled: open && Boolean(selectedCompanyId),
  });

  const allRows: ResultRow[] = useMemo(() => {
    const items = (itemsQuery.data ?? []).map<ResultRow>((it: MemoryItem) => ({
      kind: "memory_item",
      id: it.id,
      title: it.title,
      subtitle: it.category ?? "memory item",
      folderPath: (it as MemoryItem & { folderPath?: string }).folderPath ?? "",
      departmentId: (it as MemoryItem & { departmentId?: string | null }).departmentId ?? null,
    }));
    const assets = (assetsQuery.data ?? []).map<ResultRow>((a: MemoryAssetRecord) => ({
      kind: "asset",
      id: a.id,
      title: a.fileName,
      subtitle: a.mimeType,
      folderPath: a.folderPath ?? "",
      departmentId: a.departmentId,
    }));
    return [...items, ...assets];
  }, [itemsQuery.data, assetsQuery.data]);

  const results = useMemo(() => {
    if (!query.trim()) {
      return allRows.slice(0, MAX_RESULTS);
    }
    const q = query.toLowerCase();
    return allRows
      .filter((r) => r.title.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }, [allRows, query]);

  // Reset activeIdx when results change
  useEffect(() => { setActiveIdx(0); }, [query]);

  function selectRow(row: ResultRow) {
    const params = new URLSearchParams();
    if (row.folderPath) params.set("folder", row.folderPath);
    if (row.departmentId) params.set("dept", row.departmentId);
    params.set("item", row.id);
    params.set("type", row.kind);
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
    setOpen(false);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = results[activeIdx];
      if (row) selectRow(row);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl gap-0 p-0 overflow-hidden" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Quick Switcher</DialogTitle>
        <div className="flex items-center px-3 py-2 border-b border-border gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search memory items + files…"
            className="border-0 focus-visible:ring-0 px-0 h-8 text-sm"
            aria-label="Quick switcher search"
          />
          <span className="text-[10px] text-muted-foreground font-mono">⌘K</span>
        </div>
        <div className="max-h-80 overflow-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-xs text-muted-foreground text-center">
              {query.trim() ? "No matches" : "Start typing to search"}
            </div>
          ) : (
            results.map((row, i) => {
              const Icon = row.kind === "memory_item" ? FileText : FileIcon;
              return (
                <button
                  key={`${row.kind}-${row.id}`}
                  onClick={() => selectRow(row)}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={cn(
                    "w-full text-left flex items-center gap-3 px-3 py-2 text-xs",
                    "transition-colors duration-100",
                    i === activeIdx ? "bg-primary/10 text-primary" : "hover:bg-muted/40",
                  )}
                >
                  <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{row.title}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {row.subtitle}
                      {row.folderPath && ` · 📁 ${row.folderPath}`}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] Step 4: Mount globally. Find the layout/shell where the global app header lives (`grep -rln "import.*Layout" ui/src/App.tsx`). Add `<MemoryQuickSwitcher />` inside the shell so the keyboard binding is global. The simplest place: `ui/src/App.tsx`, inside the authenticated route shell wrapper, OR wherever existing modals like `<DiscussionCaptureModal />` are mounted (find with `grep -n "DiscussionCaptureModal\|ToastProvider" ui/src/App.tsx`). Same place.

- [ ] Step 5: Smoke test:

```typescript
// ui/src/__tests__/MemoryQuickSwitcher.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../api/memory", () => ({
  memoryApi: {
    list: vi.fn(async () => [
      { id: "i-1", title: "Auth strategy", category: "decision", folderPath: "Engineering/Decisions", departmentId: "d-eng" },
      { id: "i-2", title: "Brand voice", category: "reference", folderPath: "Marketing/Brand", departmentId: "d-mkt" },
    ]),
  },
}));
vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: {
    list: vi.fn(async () => []),
  },
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "co-1", selectedCompany: { issuePrefix: "co1" } }),
}));

import { MemoryQuickSwitcher } from "../components/memory/MemoryQuickSwitcher";

function renderSwitcher() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemoryQuickSwitcher />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemoryQuickSwitcher", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens on Cmd+K and shows results", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    // Fire Cmd+K
    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() => expect(screen.getByPlaceholderText(/Search memory items/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Auth strategy")).toBeInTheDocument());
    expect(screen.getByText("Brand voice")).toBeInTheDocument();
  });

  it("filters results as you type", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByPlaceholderText(/Search memory items/i);
    await user.type(input, "auth");
    await waitFor(() => expect(screen.getByText("Auth strategy")).toBeInTheDocument());
    expect(screen.queryByText("Brand voice")).not.toBeInTheDocument();
  });

  it("opens via the custom event from MemoryHome", async () => {
    renderSwitcher();
    window.dispatchEvent(new CustomEvent("memory:open-quick-switcher"));
    await waitFor(() => expect(screen.getByPlaceholderText(/Search memory items/i)).toBeInTheDocument());
  });
});
```

- [ ] Step 6: Run tests + typecheck. Commit:

```bash
git add ui/src/components/memory/MemoryQuickSwitcher.tsx ui/src/__tests__/MemoryQuickSwitcher.test.tsx ui/src/App.tsx
git commit -m "feat(ui): MemoryQuickSwitcher (⌘K global overlay) + mount in app shell"
```

---

## Task 4: Top-bar scoped search in MemoryExplorer

**Files:**
- Create: `ui/src/components/memory/MemoryScopedSearch.tsx`
- Modify: `ui/src/pages/MemoryExplorer.tsx` (consume in toolbar; lift search state up; pass down to file list)
- Modify: `ui/src/components/memory/MemoryFileList.tsx` (accept optional `searchQuery` prop and filter rows when set)

- [ ] Step 1: Branch safety.

- [ ] Step 2: Create `MemoryScopedSearch.tsx`:

```typescript
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface MemoryScopedSearchProps {
  value: string;
  onChange: (v: string) => void;
}

/**
 * Top-bar search input in the explorer. Scoped to the current folder —
 * filters the file list incrementally. Use ⌘K for global search instead.
 */
export function MemoryScopedSearch({ value, onChange }: MemoryScopedSearchProps) {
  return (
    <div className="relative w-72">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search this folder…"
        className="pl-8 pr-8 h-7 text-xs"
      />
      {value && (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onChange("")}
          className="absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6"
          aria-label="Clear search"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
```

- [ ] Step 3: Wire into `MemoryExplorer.tsx`. Add state at the top of the component:

```typescript
import { MemoryScopedSearch } from "../components/memory/MemoryScopedSearch";

const [searchQuery, setSearchQuery] = useState("");
```

In the toolbar (above ResizablePanelGroup), to the LEFT of the existing Upload button:

```typescript
<div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-border bg-card/30">
  <MemoryScopedSearch value={searchQuery} onChange={setSearchQuery} />
  <span className="flex-1" />
  <MemoryUploadButton ... />
</div>
```

Pass `searchQuery` to `MemoryFileList`:

```typescript
<MemoryFileList
  ...
  searchQuery={searchQuery}
/>
```

- [ ] Step 4: Update `MemoryFileList.tsx`. Add prop:

```typescript
interface MemoryFileListProps {
  ...
  searchQuery?: string;
}
```

Filter `rows` after the existing memo:

```typescript
const filteredRows = useMemo(() => {
  if (!searchQuery?.trim()) return rows;
  const q = searchQuery.toLowerCase();
  return rows.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      (r.category ?? "").toLowerCase().includes(q) ||
      (r.mimeType ?? "").toLowerCase().includes(q),
  );
}, [rows, searchQuery]);
```

Render `filteredRows` instead of `rows` in the JSX. Update the count badge to show `filteredRows.length`. Keep the rest unchanged.

- [ ] Step 5: Run typecheck + tests (existing MemoryFileList test should still pass since we only added optional behavior). Commit:

```bash
git add ui/src/components/memory/MemoryScopedSearch.tsx ui/src/pages/MemoryExplorer.tsx ui/src/components/memory/MemoryFileList.tsx
git commit -m "feat(ui): top-bar scoped search in explorer (filters current folder)"
```

---

## Task 5: Browser smoke verify

Verification only.

1. Restart server + UI. Vite proxy may need updating.
2. Navigate to `/IMP/memory`. Confirm the new home page renders: pending banner (if any), search input, dept tiles, recents.
3. Click a department tile. Confirm it navigates to `/memory/explore?dept=...` with the right scope.
4. Click anywhere on the page. Press ⌘K (or Ctrl+K on Windows). Confirm the quick switcher overlay opens.
5. Type a few characters; confirm filtering works.
6. Press Enter. Confirm it navigates to the matching item.
7. Navigate to `/IMP/memory/explore` directly. Confirm the scoped search input is visible in the toolbar. Type something; confirm the file list filters.
8. Navigate to `/IMP/memory/legacy`. Confirm the old filter-list page still works.

---

## Verification — exit criteria for Phase 6.1d

1. ✅ `pnpm -r typecheck` — 0 errors.
2. ✅ `pnpm --filter ui test MemoryHome MemoryQuickSwitcher` — 6/6 PASS.
3. ✅ Full UI suite — no NEW regressions.
4. ✅ Browser smoke checklist passes.
5. ✅ Branch `memory-phase-6-0` has 4 new commits (+ plan doc) ahead of `cf94e73`.
