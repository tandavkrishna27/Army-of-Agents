# Memory Page Redesign — Phase 6.1a (Minimum Viable Explorer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a read-only minimum-viable memory explorer — a new page that consumes the Phase 6.0 backend API and renders the 3-pane tree-list-viewer layout. No edit, no upload, no drag-drop; those slot in as later slices. The old `/memory` page stays untouched at the same route; the new explorer mounts at `/memory/explore` so we can build alongside without breaking anything.

**Architecture:** API clients (`ui/src/api/`) → TanStack Query hooks (`ui/src/lib/queryKeys.ts` + inline hooks) → 3-pane page (`ui/src/pages/MemoryExplorer.tsx`) using `react-resizable-panels` → tree / list / viewer components under `ui/src/components/memory/`. Selection state lives in URL search params (`?folder=...&item=...`) so deep-links work and back-button is sane.

**Tech Stack:** React 18, Vite, TanStack Query (existing), `react-resizable-panels` (already used in workspace), `lucide-react` icons, `react-markdown` + `remark-gfm` (already in workspace marketplace work). Design tokens from `@/lib/utils` and CSS vars (`var(--entity-memory)`, etc.) per existing AoA convention.

**Spec reference:** `docs/superpowers/specs/2026-05-02-memory-page-redesign-design.md` (sections: Tree structure, Layout, File-type viewers § `.md` memory item, Folder click → folder summary view).

**Branch + worktree:** `memory-phase-6-0` in `.claude/worktrees/memory-phase-6-0/`. Most recent commit at plan-write time: `aecce6e`.

**Out of scope for this slice (later slices):**
- Markdown editor + draft + version history flow → Slice B
- Upload + file import wiring through new endpoint → Slice B
- PDF / DOCX / image / video / PPTX viewers → Slice C
- Source-text drawer + extracts sidebar → Slice C
- ⌘K quick switcher + global search overlay → Slice D
- Home page + pending review banner → Slice D
- Drag-and-drop folder rearrangement → polish slice
- Mobile / narrow-viewport layout → polish slice
- Sidebar nav entry change → deferred until cutover

---

## File Structure

### New files

```
ui/src/api/memoryFolders.ts                              ← folder CRUD client
ui/src/api/memoryAssets.ts                               ← asset list/get client
ui/src/pages/MemoryExplorer.tsx                          ← page with 3-pane layout
ui/src/components/memory/MemoryTree.tsx                  ← left pane: folder tree
ui/src/components/memory/FolderTreeNode.tsx              ← single tree row (recursive)
ui/src/components/memory/MemoryFileList.tsx              ← middle pane: file/item list
ui/src/components/memory/MemoryViewer.tsx                ← right pane: viewer slot
ui/src/components/memory/viewers/MarkdownItemViewer.tsx  ← .md preview (read-only)
ui/src/components/memory/MemoryFolderSummary.tsx         ← folder-click summary view
ui/src/components/memory/MemoryEmptyViewer.tsx           ← right-pane empty state
ui/src/__tests__/MemoryExplorer.test.tsx                 ← smoke test for the page
```

### Modified files

```
ui/src/api/memory.ts            ← add moveItem + setPinnedToTop calls
ui/src/lib/queryKeys.ts         ← add memory.folders / memory.assets keys
ui/src/App.tsx                  ← add /memory/explore route
```

### Why this split

Tree, list, and viewer each have one clear job: tree is folder navigation, list is items-in-folder, viewer renders the selected node. They communicate through URL search params, not props or context, so each can be developed and tested in isolation. `FolderTreeNode` is split out because tree recursion is much cleaner with a dedicated row component. `MemoryFolderSummary` and `MemoryEmptyViewer` are tiny because they're swap-in alternatives the viewer slot picks based on selection state.

---

## Task 1: API client for folders + assets + memory item move/pin extensions

**Files:**
- Create: `ui/src/api/memoryFolders.ts`
- Create: `ui/src/api/memoryAssets.ts`
- Modify: `ui/src/api/memory.ts` (add `moveItem` + `setPinnedToTop` methods)

- [ ] **Step 1: Branch safety**

```bash
cd "C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.claude/worktrees/memory-phase-6-0"
git rev-parse --abbrev-ref HEAD
```

Expected: `memory-phase-6-0`. STOP if not.

- [ ] **Step 2: Inspect the existing API client convention**

Read `ui/src/api/memory.ts` (top 30 lines) to confirm the existing pattern: imports `api` from `./client`, exports a const `memoryApi = { ... }` object with methods that call `api.get` / `api.post` / `api.put` / `api.delete`. Mirror that exact shape for the new files.

Run from the worktree:
```bash
head -40 ui/src/api/memory.ts
```

- [ ] **Step 3: Create the folders API client**

Create `ui/src/api/memoryFolders.ts`:

```typescript
import { api } from "./client";
import type {
  MemoryFolderRecord,
  MemoryFolderCreateInput,
  MemoryFolderUpdateInput,
} from "@armyofagents/shared";

export const memoryFoldersApi = {
  list: async (
    companyId: string,
    params?: { departmentId?: string },
  ): Promise<MemoryFolderRecord[]> => {
    const qs = params?.departmentId
      ? `?departmentId=${encodeURIComponent(params.departmentId)}`
      : "";
    return api.get(`/companies/${companyId}/memory/folders${qs}`);
  },

  create: async (
    companyId: string,
    input: MemoryFolderCreateInput,
  ): Promise<MemoryFolderRecord> => {
    return api.post(`/companies/${companyId}/memory/folders`, input);
  },

  update: async (
    companyId: string,
    id: string,
    patch: MemoryFolderUpdateInput,
  ): Promise<MemoryFolderRecord> => {
    return api.patch(`/companies/${companyId}/memory/folders/${id}`, patch);
  },

  remove: async (companyId: string, id: string): Promise<void> => {
    return api.delete(`/companies/${companyId}/memory/folders/${id}`);
  },
};
```

If the existing `api` client uses different verb names (e.g. `request("PATCH", ...)` instead of `patch`), match the existing pattern. Run `grep -n "^  patch\|^  delete\|^  put\|^  post\|^  get" ui/src/api/client.ts | head -10` to verify.

- [ ] **Step 4: Create the assets API client**

Create `ui/src/api/memoryAssets.ts`:

```typescript
import { api } from "./client";
import type {
  MemoryAssetRecord,
  MemoryAssetUpdateInput,
} from "@armyofagents/shared";

export const memoryAssetsApi = {
  list: async (
    companyId: string,
    params?: {
      departmentId?: string;
      folderPath?: string;
      mimeType?: string;
    },
  ): Promise<MemoryAssetRecord[]> => {
    const search = new URLSearchParams();
    if (params?.departmentId) search.set("departmentId", params.departmentId);
    if (params?.folderPath) search.set("folderPath", params.folderPath);
    if (params?.mimeType) search.set("mimeType", params.mimeType);
    const qs = search.toString() ? `?${search.toString()}` : "";
    return api.get(`/companies/${companyId}/memory/assets${qs}`);
  },

  get: async (companyId: string, id: string): Promise<MemoryAssetRecord> => {
    return api.get(`/companies/${companyId}/memory/assets/${id}`);
  },

  /** Returns the URL the browser can hit directly to stream content. */
  contentUrl: (companyId: string, id: string): string => {
    return `/api/companies/${companyId}/memory/assets/${id}/content`;
  },

  update: async (
    companyId: string,
    id: string,
    patch: MemoryAssetUpdateInput,
  ): Promise<MemoryAssetRecord> => {
    return api.patch(`/companies/${companyId}/memory/assets/${id}`, patch);
  },

  remove: async (companyId: string, id: string): Promise<void> => {
    return api.delete(`/companies/${companyId}/memory/assets/${id}`);
  },
};
```

Verify the API base path. The existing `memoryApi` in `ui/src/api/memory.ts` uses `/companies/${companyId}/memory/...` — match that. The streaming URL hits the API directly so we expose `contentUrl` as a string builder, not a fetch call.

- [ ] **Step 5: Add `moveItem` and `setPinnedToTop` methods to memoryApi**

Open `ui/src/api/memory.ts`. Append two methods to the `memoryApi` object:

```typescript
  moveItem: async (
    companyId: string,
    id: string,
    folderPath: string,
  ): Promise<MemoryItem> => {
    return api.patch(
      `/companies/${companyId}/memory/items/${id}/move`,
      { folderPath },
    );
  },

  setPinnedToTop: async (
    companyId: string,
    id: string,
    pinned: boolean,
  ): Promise<MemoryItem> => {
    return api.patch(
      `/companies/${companyId}/memory/items/${id}/pin-to-top`,
      { pinned },
    );
  },
```

The existing file already imports `MemoryItem` from `@armyofagents/shared` — verify and reuse.

- [ ] **Step 6: Run UI typecheck**

Run from the worktree:
```bash
pnpm --filter ui typecheck
```

Expected: 0 errors.

If TypeScript can't resolve the new types from `@armyofagents/shared`, run `pnpm --filter @armyofagents/shared build` first (the shared package needs to be built so `dist/` has the types — verify by checking whether other ui imports of shared types work; if they do, this might not be needed).

- [ ] **Step 7: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD   # must show memory-phase-6-0
git add ui/src/api/memoryFolders.ts ui/src/api/memoryAssets.ts ui/src/api/memory.ts
git commit -m "feat(ui): add memoryFolders + memoryAssets API clients + memory item move/pin methods"
```

---

## Task 2: Add query keys for the new resources

**Files:**
- Modify: `ui/src/lib/queryKeys.ts`

- [ ] **Step 1: Inspect existing query-key shape**

Read `ui/src/lib/queryKeys.ts` (full file) to see the existing structure. Look specifically at how `memory` is keyed already — there should be entries like `memory.list`, `memory.detail`, `memory.pending`, etc.

- [ ] **Step 2: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

Expected: `memory-phase-6-0`.

- [ ] **Step 3: Add folder + asset keys**

In the existing `memory` block of `queryKeys`, add nested keys for folders and assets. Match the existing nesting convention. Pattern:

```typescript
memory: {
  // ... existing entries unchanged ...
  folders: {
    list: (companyId: string, departmentId?: string) =>
      ["memory", "folders", companyId, departmentId ?? "_all"] as const,
  },
  assets: {
    list: (companyId: string, params?: { departmentId?: string; folderPath?: string; mimeType?: string }) =>
      ["memory", "assets", companyId, params?.departmentId ?? "_all", params?.folderPath ?? "_all", params?.mimeType ?? "_all"] as const,
    detail: (companyId: string, id: string) =>
      ["memory", "assets", companyId, "detail", id] as const,
  },
},
```

Place these nested objects inside the existing `memory:` block, after the existing entries. Do not modify any existing keys.

- [ ] **Step 4: Run typecheck**

```bash
pnpm --filter ui typecheck
```

Expected: 0 errors.

- [ ] **Step 5: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD
git add ui/src/lib/queryKeys.ts
git commit -m "feat(ui): add memory.folders + memory.assets queryKeys"
```

---

## Task 3: Build the MemoryExplorer page shell with 3-pane layout

**Files:**
- Create: `ui/src/pages/MemoryExplorer.tsx`
- Modify: `ui/src/App.tsx` (add route)

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

Expected: `memory-phase-6-0`.

- [ ] **Step 2: Inspect how the existing workspace 3-pane uses react-resizable-panels**

Read `ui/src/pages/WorkspaceView.tsx` (or wherever the workspace 3-pane lives — find with `grep -rn "ResizablePanelGroup\|react-resizable-panels" ui/src/pages/ ui/src/components/workspace/`). Note how `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` are imported and used. Mirror that exact pattern.

- [ ] **Step 3: Create the page**

Create `ui/src/pages/MemoryExplorer.tsx`:

```typescript
import { useEffect } from "react";
import { useSearchParams } from "@/lib/router";
import { Brain } from "lucide-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { MemoryTree } from "../components/memory/MemoryTree";
import { MemoryFileList } from "../components/memory/MemoryFileList";
import { MemoryViewer } from "../components/memory/MemoryViewer";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";

/**
 * Phase 6.1a: minimum viable memory explorer.
 *
 * Three resizable panes:
 *   - left (240px): folder tree
 *   - middle (320px): file list for selected folder
 *   - right (flex): viewer for selected item/asset
 *
 * Selection state lives in URL search params (?folder, ?item, ?type) so deep-
 * links and back-button work. Edit + upload + advanced viewers ship in later
 * slices.
 */
export function MemoryExplorer() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs, setEntityColor, setSubtitle } = useBreadcrumbs();
  const [searchParams] = useSearchParams();

  const folderPath = searchParams.get("folder") ?? "";
  const departmentId = searchParams.get("dept") ?? null;
  const selectedItemId = searchParams.get("item");
  const selectedItemType = searchParams.get("type") as
    | "memory_item"
    | "asset"
    | null;

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }, { label: "Explorer" }]);
    setEntityColor("var(--entity-memory)");
    return () => {
      setSubtitle(null);
      setEntityColor(null);
    };
  }, [setBreadcrumbs, setEntityColor, setSubtitle]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to view memory." />;
  }

  return (
    <div className="h-full flex flex-col">
      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId="memory-explorer-panes"
        className="flex-1"
      >
        <ResizablePanel
          defaultSize={20}
          minSize={12}
          maxSize={35}
          className="border-r border-border"
        >
          <MemoryTree
            companyId={selectedCompanyId}
            selectedFolderPath={folderPath}
            selectedDepartmentId={departmentId}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel
          defaultSize={28}
          minSize={20}
          maxSize={45}
          className="border-r border-border"
        >
          <MemoryFileList
            companyId={selectedCompanyId}
            folderPath={folderPath}
            departmentId={departmentId}
            selectedItemId={selectedItemId}
            selectedItemType={selectedItemType}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={52} minSize={30}>
          <MemoryViewer
            companyId={selectedCompanyId}
            selectedItemId={selectedItemId}
            selectedItemType={selectedItemType}
            folderPath={folderPath}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
```

- [ ] **Step 4: Register the route**

Open `ui/src/App.tsx`. Find the existing memory route (search for `path="memory"` or similar). Add a new sibling route for `/memory/explore`:

```typescript
import { MemoryExplorer } from "./pages/MemoryExplorer";

// inside the router:
<Route path="memory/explore" element={<MemoryExplorer />} />
```

The exact placement depends on the existing nesting. The new route should be a sibling of the existing memory route, both inside the `:companyPrefix` parent. Verify by reading the existing memory route's wrapping route definitions.

If the App.tsx uses lazy-loading (e.g. `React.lazy(() => import("./pages/MemoryExplorer"))`), match that pattern for consistency.

- [ ] **Step 5: Run UI typecheck**

```bash
pnpm --filter ui typecheck
```

Expected: 0 errors. The tree/list/viewer imports will fail (module-not-found) at this point — that's fine, we'll create those next. Re-run typecheck after Task 7.

NOTE: if typecheck fails ONLY on the missing component imports, it's OK to proceed. If it fails on other issues, STOP and fix.

- [ ] **Step 6: Don't commit yet**

This task creates files that import components that don't exist yet. We'll commit at the end of Task 7 once the imports resolve. Skip the commit step for now and continue to Task 4.

---

## Task 4: Build the MemoryTree component (left pane)

**Files:**
- Create: `ui/src/components/memory/MemoryTree.tsx`
- Create: `ui/src/components/memory/FolderTreeNode.tsx`

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

Expected: `memory-phase-6-0`.

- [ ] **Step 2: Create the FolderTreeNode primitive**

Create `ui/src/components/memory/FolderTreeNode.tsx`:

```typescript
import { ChevronRight, ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface FolderTreeNodeProps {
  label: string;
  icon?: string | LucideIcon;
  count?: number;
  depth: number;
  expanded: boolean;
  selected: boolean;
  hasChildren: boolean;
  onToggleExpand: () => void;
  onSelect: () => void;
  /** Optional CSS class to tint the node (e.g. yellow for Pending Review). */
  tintClass?: string;
}

/**
 * One row in the memory folder tree. Renders a chevron (if hasChildren),
 * an emoji or Lucide icon, the label, an optional count chip, and reacts
 * to click on the row body (select) vs. chevron (toggle expand).
 */
export function FolderTreeNode({
  label,
  icon,
  count,
  depth,
  expanded,
  selected,
  hasChildren,
  onToggleExpand,
  onSelect,
  tintClass,
}: FolderTreeNodeProps) {
  const indent = depth * 12 + 8;
  const Icon = typeof icon === "function" ? (icon as LucideIcon) : null;

  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "group flex items-center gap-1 py-1 pr-2 cursor-pointer text-xs leading-tight select-none",
        "hover:bg-muted/40",
        selected && "bg-primary/10 text-primary",
        tintClass,
      )}
      style={{ paddingLeft: indent }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (hasChildren) onToggleExpand();
        }}
        className="flex-shrink-0 inline-flex h-3.5 w-3.5 items-center justify-center text-muted-foreground"
        aria-label={hasChildren ? (expanded ? "Collapse" : "Expand") : undefined}
        tabIndex={hasChildren ? 0 : -1}
      >
        {hasChildren ? (
          expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        ) : null}
      </button>
      <span className="flex-shrink-0 text-sm leading-none">
        {Icon ? <Icon className="h-3.5 w-3.5" /> : icon ?? "📁"}
      </span>
      <span className="truncate flex-1">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create the MemoryTree component**

Create `ui/src/components/memory/MemoryTree.tsx`:

```typescript
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Pin, Building2, ChevronLeft } from "lucide-react";
import type { MemoryFolderRecord, Project } from "@armyofagents/shared";
import { memoryFoldersApi } from "../../api/memoryFolders";
import { projectsApi } from "../../api/projects";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import { FolderTreeNode } from "./FolderTreeNode";
import { Skeleton } from "@/components/ui/skeleton";

interface MemoryTreeProps {
  companyId: string;
  selectedFolderPath: string;
  selectedDepartmentId: string | null;
}

interface TreeNode {
  key: string;          // unique id (path + dept)
  label: string;
  icon?: string;
  count?: number;
  depth: number;
  hasChildren: boolean;
  // Navigation target when clicked.
  target: { folder: string; dept: string | null };
  // Optional sort order from the DB.
  sortOrder?: number;
  // Tint for virtual folders (e.g. Pending Review).
  tintClass?: string;
  children?: TreeNode[];
}

/**
 * Phase 6.1a: read-only folder tree for the memory explorer.
 *
 * Top-level structure:
 *   - 📌 Pinned (virtual, deferred to a later slice — shown but disabled)
 *   - 🏛️ Company (root folder for identity-layer items)
 *   - 📁 [Department 1]
 *   - 📁 [Department 2]
 *   - ...
 *
 * Each department expands to show its memory_folders (Decisions, References, etc.).
 *
 * Virtual sub-folders inside a dept (Pending Review, Active Goals, Working) are
 * deferred to a later slice — shown grayed out with a "soon" affordance.
 */
export function MemoryTree({
  companyId,
  selectedFolderPath,
  selectedDepartmentId,
}: MemoryTreeProps) {
  const navigate = useNavigate();
  const { companyPrefix } = useCompany();
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(["__company"]),
  );

  const { data: folders, isLoading: foldersLoading } = useQuery({
    queryKey: queryKeys.memory.folders.list(companyId),
    queryFn: () => memoryFoldersApi.list(companyId),
  });

  const { data: projects, isLoading: projectsLoading } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const departments = useMemo<Project[]>(
    () =>
      (projects ?? []).filter(
        (p: Project) => p.type === "department" && !p.archivedAt,
      ),
    [projects],
  );

  const tree = useMemo(() => buildTree(folders ?? [], departments), [
    folders,
    departments,
  ]);

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectNode(target: TreeNode["target"]) {
    const params = new URLSearchParams();
    if (target.folder) params.set("folder", target.folder);
    if (target.dept) params.set("dept", target.dept);
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
  }

  function isSelected(target: TreeNode["target"]): boolean {
    return (
      target.folder === selectedFolderPath &&
      (target.dept ?? null) === (selectedDepartmentId ?? null)
    );
  }

  function renderNode(node: TreeNode): React.ReactNode {
    const isExpanded = expanded.has(node.key);
    return (
      <div key={node.key}>
        <FolderTreeNode
          label={node.label}
          icon={node.icon}
          count={node.count}
          depth={node.depth}
          expanded={isExpanded}
          selected={isSelected(node.target)}
          hasChildren={node.hasChildren}
          onToggleExpand={() => toggleExpand(node.key)}
          onSelect={() => selectNode(node.target)}
          tintClass={node.tintClass}
        />
        {isExpanded &&
          node.children &&
          node.children.map((child) => renderNode(child))}
      </div>
    );
  }

  const isLoading = foldersLoading || projectsLoading;

  return (
    <div className="h-full flex flex-col bg-card/50">
      <div className="flex items-center px-2 py-2 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>Folders</span>
        <span className="flex-1" />
        <ChevronLeft className="h-3 w-3 opacity-50" />
      </div>
      <div className="flex-1 overflow-auto py-1">
        {isLoading ? (
          <div className="space-y-1 px-2 py-1">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-3/5" />
          </div>
        ) : (
          tree.map((node) => renderNode(node))
        )}
      </div>
    </div>
  );
}

// ── Tree-shape helpers ──────────────────────────────────────────────

function buildTree(
  folders: MemoryFolderRecord[],
  departments: Project[],
): TreeNode[] {
  // Group folders by department + sub-path.
  const companyFolders = folders.filter((f) => f.departmentId === null);
  const deptFolderGroups = new Map<string, MemoryFolderRecord[]>();
  for (const f of folders) {
    if (f.departmentId !== null) {
      const arr = deptFolderGroups.get(f.departmentId) ?? [];
      arr.push(f);
      deptFolderGroups.set(f.departmentId, arr);
    }
  }

  const top: TreeNode[] = [];

  // 📌 Pinned (deferred, but shown so users know it's coming)
  top.push({
    key: "__pinned",
    label: "Pinned",
    icon: "📌",
    depth: 0,
    hasChildren: false,
    target: { folder: "__pinned", dept: null },
  });

  // 🏛️ Company
  const companyRoot = companyFolders.find((f) => f.path === "Company");
  if (companyRoot) {
    top.push({
      key: "__company",
      label: companyRoot.displayName,
      icon: companyRoot.icon ?? "🏛️",
      depth: 0,
      hasChildren: false,
      target: { folder: "Company", dept: null },
    });
  }

  // Departments
  for (const dept of departments) {
    const slug = dept.urlKey ?? "";
    const deptFolders = deptFolderGroups.get(dept.id) ?? [];
    // Children are direct children at depth 1: paths that look like
    // "<slug>/<segment>" with no further segments.
    const children = deptFolders
      .filter((f) => {
        const parts = f.path.split("/");
        return parts.length === 2 && parts[0] === slug;
      })
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map<TreeNode>((f) => ({
        key: `dept-${dept.id}-${f.id}`,
        label: f.displayName,
        icon: f.icon ?? undefined,
        depth: 1,
        hasChildren: false, // we don't render sub-folders past depth 1 in 6.1a
        target: { folder: f.path, dept: dept.id },
      }));

    top.push({
      key: `dept-${dept.id}`,
      label: dept.name,
      icon: "📁",
      depth: 0,
      hasChildren: children.length > 0,
      target: { folder: slug, dept: dept.id },
      children,
    });
  }

  return top;
}
```

Note: `dept.urlKey` and `dept.archivedAt` are existing AoA Project fields — verify against the `Project` type in `@armyofagents/shared`. If `urlKey` doesn't exist by that name, use whatever the `projects.url_key` column maps to in the TypeScript type (could be `urlKey`, `slug`, or similar).

- [ ] **Step 4: Run UI typecheck**

```bash
pnpm --filter ui typecheck
```

Expected: 0 errors (assuming the file list and viewer aren't yet imported). `MemoryFileList` and `MemoryViewer` will still be missing from `MemoryExplorer` — that's fine for now.

- [ ] **Step 5: Don't commit yet**

The page imports `MemoryFileList` and `MemoryViewer`, which aren't created. Continue to Task 5 + 6.

---

## Task 5: Build the MemoryFileList component (middle pane)

**Files:**
- Create: `ui/src/components/memory/MemoryFileList.tsx`

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

- [ ] **Step 2: Create the component**

Create `ui/src/components/memory/MemoryFileList.tsx`:

```typescript
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import {
  FileText,
  Image as ImageIcon,
  FileType,
  Film,
  Presentation,
  File as FileIcon,
} from "lucide-react";
import type { MemoryItem, MemoryAssetRecord } from "@armyofagents/shared";
import { memoryApi } from "../../api/memory";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface MemoryFileListProps {
  companyId: string;
  folderPath: string;
  departmentId: string | null;
  selectedItemId: string | null;
  selectedItemType: "memory_item" | "asset" | null;
}

interface ListRow {
  kind: "memory_item" | "asset";
  id: string;
  name: string;
  category?: string | null;
  status?: string | null;
  mimeType?: string | null;
  modifiedAt: string;
  raw: MemoryItem | MemoryAssetRecord;
}

const STATUS_COLORS: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  archived: "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  draft: "bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300",
};

function iconForRow(row: ListRow) {
  if (row.kind === "memory_item") return FileText;
  if (!row.mimeType) return FileIcon;
  if (row.mimeType.startsWith("image/")) return ImageIcon;
  if (row.mimeType.startsWith("video/")) return Film;
  if (row.mimeType === "application/pdf") return FileType;
  if (row.mimeType.includes("presentation")) return Presentation;
  return FileIcon;
}

function formatRelative(isoOrDate: string): string {
  const ms = Date.now() - new Date(isoOrDate).getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * Phase 6.1a: list of items + assets in the currently-selected folder.
 * Read-only — clicks navigate via URL params.
 */
export function MemoryFileList({
  companyId,
  folderPath,
  departmentId,
  selectedItemId,
  selectedItemType,
}: MemoryFileListProps) {
  const navigate = useNavigate();
  const { companyPrefix } = useCompany();

  // Memory items in this folder (filter by departmentId + folderPath via the existing list endpoint).
  const itemsQuery = useQuery({
    queryKey: [...queryKeys.memory.list(companyId), { folderPath, departmentId }],
    queryFn: () =>
      memoryApi.list(companyId, {
        ...(departmentId ? { departmentId } : {}),
        // Note: the existing list endpoint doesn't filter by folderPath yet.
        // For 6.1a we filter client-side.
      }),
    enabled: Boolean(folderPath),
  });

  const assetsQuery = useQuery({
    queryKey: queryKeys.memory.assets.list(companyId, {
      departmentId: departmentId ?? undefined,
      folderPath,
    }),
    queryFn: () =>
      memoryAssetsApi.list(companyId, {
        departmentId: departmentId ?? undefined,
        folderPath,
      }),
    enabled: Boolean(folderPath),
  });

  const rows = useMemo<ListRow[]>(() => {
    const items = (itemsQuery.data ?? [])
      .filter((it: MemoryItem) => (it as MemoryItem & { folderPath?: string }).folderPath === folderPath)
      .map<ListRow>((it: MemoryItem) => ({
        kind: "memory_item",
        id: it.id,
        name: it.title,
        category: it.category,
        status: it.status,
        modifiedAt: typeof it.updatedAt === "string" ? it.updatedAt : new Date(it.updatedAt).toISOString(),
        raw: it,
      }));

    const assets = (assetsQuery.data ?? []).map<ListRow>((a: MemoryAssetRecord) => ({
      kind: "asset",
      id: a.id,
      name: a.fileName,
      mimeType: a.mimeType,
      status: undefined,
      modifiedAt: a.updatedAt,
      raw: a,
    }));

    return [...items, ...assets].sort(
      (a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
    );
  }, [itemsQuery.data, assetsQuery.data, folderPath]);

  function selectRow(row: ListRow) {
    const params = new URLSearchParams(window.location.search);
    params.set("item", row.id);
    params.set("type", row.kind);
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
  }

  const isLoading = itemsQuery.isLoading || assetsQuery.isLoading;

  if (!folderPath) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        Select a folder to see its contents
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card/30">
      <div className="flex items-center px-3 py-2 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground gap-2">
        <span className="truncate">{folderPath}</span>
        <span className="flex-1" />
        <span className="text-[10px] text-muted-foreground">{rows.length}</span>
      </div>
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-6 text-xs text-muted-foreground text-center">
            No items in this folder
          </div>
        ) : (
          rows.map((row) => {
            const Icon = iconForRow(row);
            const isSel =
              row.id === selectedItemId && row.kind === selectedItemType;
            return (
              <div
                key={`${row.kind}-${row.id}`}
                onClick={() => selectRow(row)}
                className={cn(
                  "grid grid-cols-[24px_1fr_60px] gap-2 items-center px-3 py-2 border-b border-border cursor-pointer text-xs",
                  "hover:bg-muted/40",
                  isSel && "bg-primary/10",
                )}
              >
                <Icon className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="font-medium truncate">{row.name}</div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {row.kind === "memory_item"
                      ? row.category ?? "memory item"
                      : row.mimeType ?? "file"}
                    {" · "}
                    {formatRelative(row.modifiedAt)}
                  </div>
                </div>
                {row.status && (
                  <span
                    className={cn(
                      "text-[10px] px-2 py-0.5 rounded text-center font-medium",
                      STATUS_COLORS[row.status] ?? "bg-muted text-muted-foreground",
                    )}
                  >
                    {row.status}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run UI typecheck**

```bash
pnpm --filter ui typecheck
```

Expected: 0 errors (modulo the missing MemoryViewer that will exist after Task 6).

If TypeScript complains about `MemoryItem.folderPath` not existing, that means the type wasn't picked up from the schema additions. Run `pnpm --filter @armyofagents/db build` and `pnpm --filter @armyofagents/shared build` to refresh `dist/`. The `folderPath` column was added to memory_items in Phase 6.0 Task 1.

If the existing `memoryApi.list` signature doesn't accept the params shown, check the method's actual signature and adapt — the goal is to fetch items filtered by departmentId; the client-side filter on `folderPath` then narrows further.

---

## Task 6: Build the MemoryViewer + MarkdownItemViewer + folder summary + empty state

**Files:**
- Create: `ui/src/components/memory/MemoryViewer.tsx`
- Create: `ui/src/components/memory/viewers/MarkdownItemViewer.tsx`
- Create: `ui/src/components/memory/MemoryFolderSummary.tsx`
- Create: `ui/src/components/memory/MemoryEmptyViewer.tsx`

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

- [ ] **Step 2: Create MemoryEmptyViewer**

Create `ui/src/components/memory/MemoryEmptyViewer.tsx`:

```typescript
import { Brain } from "lucide-react";

export function MemoryEmptyViewer() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center text-xs text-muted-foreground space-y-2">
        <Brain className="h-8 w-8 mx-auto opacity-30" />
        <div>Select an item to view it here</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create MemoryFolderSummary (placeholder for 6.1a)**

Create `ui/src/components/memory/MemoryFolderSummary.tsx`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { Folder } from "lucide-react";
import { memoryApi } from "../../api/memory";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { queryKeys } from "../../lib/queryKeys";

interface MemoryFolderSummaryProps {
  companyId: string;
  folderPath: string;
  departmentId: string | null;
}

/**
 * Phase 6.1a: minimal folder summary view shown in the right pane when a
 * folder is selected but no item is open. Later slices add recent activity
 * + stats. For now: name + counts.
 */
export function MemoryFolderSummary({
  companyId,
  folderPath,
  departmentId,
}: MemoryFolderSummaryProps) {
  const itemsQuery = useQuery({
    queryKey: [...queryKeys.memory.list(companyId), { folderPath, departmentId }],
    queryFn: () =>
      memoryApi.list(companyId, departmentId ? { departmentId } : {}),
    enabled: Boolean(folderPath),
  });

  const assetsQuery = useQuery({
    queryKey: queryKeys.memory.assets.list(companyId, {
      departmentId: departmentId ?? undefined,
      folderPath,
    }),
    queryFn: () =>
      memoryAssetsApi.list(companyId, {
        departmentId: departmentId ?? undefined,
        folderPath,
      }),
    enabled: Boolean(folderPath),
  });

  const itemsInFolder = (itemsQuery.data ?? []).filter(
    (it: { folderPath?: string }) => it.folderPath === folderPath,
  );
  const assetsInFolder = assetsQuery.data ?? [];

  return (
    <div className="h-full p-8">
      <div className="flex items-center gap-3 mb-6">
        <Folder className="h-6 w-6 text-muted-foreground" />
        <div>
          <div className="text-xl font-semibold">{folderPath}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {itemsInFolder.length} memory items · {assetsInFolder.length} files
          </div>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        Pick an item from the list to view it. Folder summary with recent
        activity and stats arrives in a later slice.
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create MarkdownItemViewer**

Create `ui/src/components/memory/viewers/MarkdownItemViewer.tsx`:

```typescript
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Pin } from "lucide-react";
import type { MemoryItem } from "@armyofagents/shared";
import { memoryApi } from "../../../api/memory";
import { queryKeys } from "../../../lib/queryKeys";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface MarkdownItemViewerProps {
  companyId: string;
  itemId: string;
}

const STATUS_PILL: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  archived: "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  draft: "bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300",
};

const LAYER_PILL: Record<string, string> = {
  identity: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  domain: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300",
  active_context: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  working: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
};

/**
 * Phase 6.1a: read-only markdown preview for a memory item.
 *
 * Status header + chips (status, layer, category) + title at the top, then
 * rendered markdown body. Edit / version history / source drawer / backlinks
 * ship in Slice B.
 */
export function MarkdownItemViewer({ companyId, itemId }: MarkdownItemViewerProps) {
  const { data: item, isLoading, isError } = useQuery({
    queryKey: queryKeys.memory.detail(companyId, itemId),
    queryFn: () => memoryApi.get(companyId, itemId),
    enabled: Boolean(companyId && itemId),
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    );
  }

  if (isError || !item) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        Could not load memory item.
      </div>
    );
  }

  const i = item as MemoryItem & {
    layer?: string | null;
    pinnedToSkill?: boolean;
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header band */}
      <div className="px-6 pt-6 pb-3 border-b border-border">
        <div className="flex items-center gap-2 text-[10px] mb-2">
          {i.status && (
            <span
              className={cn(
                "px-2 py-0.5 rounded font-medium uppercase tracking-wider",
                STATUS_PILL[i.status] ?? "bg-muted text-muted-foreground",
              )}
            >
              {i.status}
            </span>
          )}
          {i.layer && (
            <span
              className={cn(
                "px-2 py-0.5 rounded font-medium uppercase tracking-wider",
                LAYER_PILL[i.layer] ?? "bg-muted text-muted-foreground",
              )}
            >
              {i.layer.replace("_", " ")}
            </span>
          )}
          {i.category && (
            <span className="px-2 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wider font-medium">
              {i.category}
            </span>
          )}
          {i.pinnedToSkill && (
            <span
              className="inline-flex items-center gap-1 text-muted-foreground"
              title="Pinned to skill"
            >
              <Pin className="h-3 w-3" />
            </span>
          )}
        </div>
        <h1 className="text-xl font-semibold">{i.title}</h1>
      </div>
      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-5 prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{i.content}</ReactMarkdown>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create MemoryViewer wrapper**

Create `ui/src/components/memory/MemoryViewer.tsx`:

```typescript
import { MarkdownItemViewer } from "./viewers/MarkdownItemViewer";
import { MemoryFolderSummary } from "./MemoryFolderSummary";
import { MemoryEmptyViewer } from "./MemoryEmptyViewer";

interface MemoryViewerProps {
  companyId: string;
  selectedItemId: string | null;
  selectedItemType: "memory_item" | "asset" | null;
  folderPath: string;
}

/**
 * Phase 6.1a: viewer slot in the right pane.
 *
 * Selection logic:
 *   - item selected (memory_item) → MarkdownItemViewer
 *   - item selected (asset) → placeholder ("File preview coming in Slice C")
 *   - folder selected, no item → MemoryFolderSummary
 *   - nothing selected → MemoryEmptyViewer
 */
export function MemoryViewer({
  companyId,
  selectedItemId,
  selectedItemType,
  folderPath,
}: MemoryViewerProps) {
  if (selectedItemId && selectedItemType === "memory_item") {
    return <MarkdownItemViewer companyId={companyId} itemId={selectedItemId} />;
  }

  if (selectedItemId && selectedItemType === "asset") {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground p-6 text-center">
        File preview (PDF / image / video / PPTX) ships in a later slice. The
        backend already serves this asset's content at{" "}
        <code className="ml-1">/api/companies/&lt;cid&gt;/memory/assets/{selectedItemId}/content</code>.
      </div>
    );
  }

  if (folderPath) {
    return (
      <MemoryFolderSummary
        companyId={companyId}
        folderPath={folderPath}
        departmentId={null}
      />
    );
  }

  return <MemoryEmptyViewer />;
}
```

- [ ] **Step 6: Run UI typecheck**

```bash
pnpm --filter ui typecheck
```

Expected: 0 errors. All imports should now resolve.

If `react-markdown` and/or `remark-gfm` are missing from `ui/package.json`, they need to be added. They are already in the workspace marketplace work (`MarketplaceDetail.tsx` uses `ReadmeRender`). Run `grep -n "react-markdown\|remark-gfm" ui/package.json` to verify. If absent, run `pnpm --filter ui add react-markdown remark-gfm` to add them.

---

## Task 7: Smoke test + commit the page

**Files:**
- Create: `ui/src/__tests__/MemoryExplorer.test.tsx`

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

- [ ] **Step 2: Write a smoke test for the page**

Create `ui/src/__tests__/MemoryExplorer.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Mock the @/lib/router useSearchParams + useNavigate (the AoA wrapper).
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    useNavigate: () => vi.fn(),
  };
});

vi.mock("../api/memoryFolders", () => ({
  memoryFoldersApi: {
    list: vi.fn(async () => [
      {
        id: "f-company",
        companyId: "co-1",
        departmentId: null,
        path: "Company",
        displayName: "Company",
        icon: "🏛️",
        sortOrder: 0,
        seedKey: "company.root",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "f-eng-decisions",
        companyId: "co-1",
        departmentId: "dept-eng",
        path: "engineering/Decisions",
        displayName: "Decisions",
        icon: null,
        sortOrder: 0,
        seedKey: "software_development.decisions",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]),
  },
}));

vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: {
    list: vi.fn(async () => []),
    contentUrl: () => "/test/content/url",
  },
}));

vi.mock("../api/memory", () => ({
  memoryApi: {
    list: vi.fn(async () => []),
    get: vi.fn(),
    moveItem: vi.fn(),
    setPinnedToTop: vi.fn(),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(async () => [
      {
        id: "dept-eng",
        type: "department",
        name: "Engineering",
        urlKey: "engineering",
        archivedAt: null,
        functionType: "software_development",
      },
    ]),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "co-1", companyPrefix: "co1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: vi.fn(),
    setSubtitle: vi.fn(),
    setEntityColor: vi.fn(),
  }),
}));

import { MemoryExplorer } from "../pages/MemoryExplorer";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemoryExplorer />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemoryExplorer (Phase 6.1a smoke test)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders 3 panes and shows company + dept folders in the tree", async () => {
    renderPage();
    // Tree pane shows the section header
    await waitFor(() =>
      expect(screen.getByText(/Folders/i)).toBeInTheDocument(),
    );
    // Tree shows Company root
    await waitFor(() =>
      expect(screen.getByText("Company")).toBeInTheDocument(),
    );
    // Tree shows the Engineering department (from projectsApi mock)
    await waitFor(() =>
      expect(screen.getByText("Engineering")).toBeInTheDocument(),
    );
  });

  it("right pane shows the empty state when nothing is selected", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Select an item to view it here/i)).toBeInTheDocument(),
    );
  });
});
```

If the AoA test setup uses a different render helper than `@testing-library/react` directly (e.g. a custom `renderWithProviders`), check `ui/src/test-utils.tsx` and use that instead.

- [ ] **Step 3: Run the smoke test**

```bash
pnpm --filter ui test MemoryExplorer
```

Expected: PASS — 2 cases.

- [ ] **Step 4: Run UI typecheck**

```bash
pnpm --filter ui typecheck
```

Expected: 0 errors.

- [ ] **Step 5: Run the full UI test suite to confirm no regressions**

```bash
pnpm --filter ui test:run 2>&1 | tail -10
```

Expected: All previous tests pass + the 2 new smoke cases. The pre-existing 3 baseline failures (`@mdxeditor/editor` ESM cycle in ProjectDetailBoard / Discussions / Workspaces) should still be present and unchanged — they are not regressions.

- [ ] **Step 6: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD   # must show memory-phase-6-0
git add ui/src/pages/MemoryExplorer.tsx ui/src/components/memory/ ui/src/__tests__/MemoryExplorer.test.tsx ui/src/App.tsx
git commit -m "feat(ui): add MemoryExplorer page (Phase 6.1a — read-only minimum viable explorer)"
```

---

## Task 8: Browser smoke verification

**No code changes — purely verification.**

- [ ] **Step 1: Branch safety**

```bash
cd "C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.claude/worktrees/memory-phase-6-0"
git rev-parse --abbrev-ref HEAD
```

Expected: `memory-phase-6-0`.

- [ ] **Step 2: Run workspace typecheck**

```bash
pnpm -r typecheck 2>&1 | tail -5
```

Expected: All packages report `Done`. 0 errors.

- [ ] **Step 3: Run the full server + ui test suite as a regression check**

```bash
pnpm --filter server test:run 2>&1 | tail -5
pnpm --filter ui test:run 2>&1 | tail -5
```

Compare results against the post-Phase-6.0 baselines:
- Server: ~29-49 failures (drizzle ESM cycle baseline) / 2100+ pass — should be unchanged
- UI: ~3 failures (mdxeditor ESM cycle baseline) / 700+ pass — should be unchanged plus +2 from the new smoke test

If any test that was passing before is now failing, STOP and report.

- [ ] **Step 4: Confirm the page is reachable**

This is a manual verification step the controller can perform after the implementer reports DONE. The implementer should report which URL the page is mounted at: typically `/<companyPrefix>/memory/explore` once a company is selected.

The implementer doesn't need to start a dev server — that's the controller's responsibility for the live verification.

- [ ] **Step 5: Report**

Report status, verification command outputs, and the URL where the page should be reachable.

---

## Verification — exit criteria for Phase 6.1a

After Tasks 1–7 are complete:

1. ✅ `pnpm -r typecheck` returns 0 errors.
2. ✅ `pnpm --filter ui test MemoryExplorer` returns 2/2 PASS.
3. ✅ Full server suite has no NEW regressions vs the post-Phase-6.0 baseline.
4. ✅ Full UI suite has no NEW regressions vs the post-Phase-6.0 baseline (3 mdxeditor baselines unchanged).
5. ✅ The new page is mounted at `/<companyPrefix>/memory/explore` and renders the 3-pane layout when a real DB has companies + departments + memory items.
6. ✅ Branch `memory-phase-6-0` has 8 new commits ahead of `aecce6e` (one per task that ships code; Tasks 3-6 commit together at end of Task 7).

---

## Self-review — coverage against the spec sections

| Spec section | Covered by tasks |
|---|---|
| Routes — `/:companyPrefix/memory/explore` | Task 3 |
| 3-pane layout | Task 3 (page shell) |
| Tree structure (Pinned, Company, Departments + seeded sub-folders) | Task 4 |
| File list (mixed memory items + assets) | Task 5 |
| Markdown item viewer (preview-only for 6.1a) | Task 6 |
| Folder summary view | Task 6 |
| Empty viewer state | Task 6 |
| Status / layer / category chips on viewer header | Task 6 |
| URL-driven selection (deep-links, back-button) | Tasks 3, 4, 5 |
| LiveEvents subscription on tree | DEFERRED to a polish slice |
| All companyId-scoped queries | All tasks |

---

## What's NOT in this slice (later slices)

- Edit mode, draft autosave, "Submit for approval" → Slice B
- Asset upload through the new endpoint → Slice B
- PDF / DOCX / image / video / PPTX viewers → Slice C
- Source-text drawer + extracts sidebar → Slice C
- ⌘K quick switcher + global / scoped search bar → Slice D
- Home page (pending banner + dept tiles + recents) → Slice D
- Drag-and-drop folder rearrangement → polish slice
- LiveEvents subscription on the tree (real-time multi-tab updates) → polish slice
- Mobile / narrow-viewport layout → polish slice
- Sidebar nav entry for the new page → cutover slice (when 6.5 ships)
