# Memory Page Redesign — Phase 6.1e (Polish + Route Fallout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten three loose ends from the Phase 6 memory redesign before declaring it shippable: (1) fix three production code paths that hardcoded `/memory?item=…` and now land on the new MemoryHome instead of the explorer; (2) fix the "0 KB" sub-1KB display in `SourceTextDrawer` by lifting the existing `formatBytes` formatter to a shared util; (3) make the `__pinned` virtual folder actually filter to pinned items (it ships dead today) and add a sibling `__pending` virtual folder so the founder can review pending items without dept-hopping.

**Architecture:** All UI-only. The route swap fix is a string-replace in three files. `formatBytes` lifts from `viewers/GenericFileViewer.tsx` to `ui/src/lib/format.ts` and gets imported by both viewers + the drawer. The virtual-folder branch lives entirely in `MemoryFileList` (special-cases `folderPath === "__pinned"` / `"__pending"` to swap the row source), plus a new `__pending` tree node in `MemoryTree`, plus a small label-mapping helper for the file-list toolbar.

**Tech Stack:** Existing AoA UI patterns. No new deps.

**Out of scope (later):**
- Drag-and-drop folder rearrange (separate slice).
- Unifying the THREE existing `formatBytes` copies (`workspace-utils.tsx`, `pages/CompanyExport.tsx`, viewers/GenericFileViewer) into one. We touch the viewers copy (lift) but leave the other two — workspace and export are different feature areas with their own conventions.
- Server-side search ranking changes.

**Branch + worktree:** `memory-polish-6.1e` in `.claude/worktrees/memory-polish-6.1e/`. Most recent commit: `33dbef5` (the merge tip of `memory`).

---

## File Structure

### New files

```
ui/src/lib/format.ts                          ← formatBytes lifted from GenericFileViewer
ui/src/lib/__tests__/format.test.ts           ← unit test for formatBytes
```

### Modified files (T1 — route fallout)

```
ui/src/components/memory/SourceTextDrawer.tsx       ← line 49 path fix
ui/src/components/workspace/sections/MemorySection.tsx  ← line 198 + jsdoc line 25
server/src/services/search.ts                       ← line 582 path fix
ui/src/__tests__/CommandPalette.test.tsx            ← line 71 expected href
ui/src/components/workspace/__tests__/MemorySection.test.tsx  ← lines 140 + 150 expected href
```

### Modified files (T2 — formatBytes)

```
ui/src/components/memory/SourceTextDrawer.tsx       ← line 93 use formatBytes
ui/src/components/memory/viewers/GenericFileViewer.tsx  ← drop local copy, import shared
ui/src/__tests__/SourceTextDrawer.test.tsx          ← assertion update if it asserts the byte string
```

### Modified files (T3 — virtual folders)

```
ui/src/components/memory/MemoryTree.tsx             ← add __pending node + pending count
ui/src/components/memory/MemoryFileList.tsx         ← branch on __pinned/__pending + folder label map
ui/src/__tests__/MemoryFileList.test.tsx            ← NEW (verify branches; no test exists today)
```

### Why this split

T1 / T2 / T3 are independent — T1 is a navigation bug, T2 is a display bug, T3 is a feature. Doing them in three sequential commits gives clean git bisect bandwidth if anything regresses.

`format.ts` lives at `ui/src/lib/` (already populated with `timeAgo`, `groupBy`, `utils`, etc.) — that's where small cross-cutting formatters belong. Don't touch the workspace `formatBytes` copy in this slice — it serves the workspace timeline (different fileSize semantics; bytes always present and large).

---

## Task 1: Fix route-swap fallout (broken `/memory?item=...` links)

**Problem:** Phase 6.1d swapped `/memory` from the legacy filter-list to MemoryHome. Three production code paths still hardcode `/memory?item=...`:

- `ui/src/components/memory/SourceTextDrawer.tsx:49` — drawer's "Open source in viewer" button
- `ui/src/components/workspace/sections/MemorySection.tsx:198` — workspace memory section item link
- `server/src/services/search.ts:582` — global-search response href for memory results (consumed by `CommandPalette`)

All three need to point at `/memory/explore?item=...` (the explorer route).

**Files:**
- Modify: `ui/src/components/memory/SourceTextDrawer.tsx`
- Modify: `ui/src/components/workspace/sections/MemorySection.tsx`
- Modify: `server/src/services/search.ts`
- Modify: `ui/src/__tests__/CommandPalette.test.tsx`
- Modify: `ui/src/components/workspace/__tests__/MemorySection.test.tsx`

- [ ] **Step 1: Branch safety check.**

```bash
git status --short
git branch --show-current
```

Expected: branch `memory-polish-6.1e`, no unrelated modifications.

- [ ] **Step 2: Fix `SourceTextDrawer.tsx` line 49.**

Open `ui/src/components/memory/SourceTextDrawer.tsx`. Replace:

```typescript
    navigate(`/${companyPrefix}/memory?${params.toString()}`);
```

with:

```typescript
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
```

- [ ] **Step 3: Fix `MemorySection.tsx`.**

Open `ui/src/components/workspace/sections/MemorySection.tsx`. The file has the URL hardcoded in two places: a jsdoc on line ~25 and the actual link on line ~198. Replace:

```typescript
 * Click any item → navigate to /<companyPrefix>/memory?item=<id> (the
```

with:

```typescript
 * Click any item → navigate to /<companyPrefix>/memory/explore?item=<id> (the
```

And:

```typescript
  const href = row.itemId ? `/${companyPrefix}/memory?item=${row.itemId}` : null;
```

with:

```typescript
  const href = row.itemId ? `/${companyPrefix}/memory/explore?item=${row.itemId}` : null;
```

- [ ] **Step 4: Fix `server/src/services/search.ts` line 582.**

Open the file and find the memory result row builder. Replace:

```typescript
          href: `/memory?item=${encodeURIComponent(row.id)}`,
```

with:

```typescript
          href: `/memory/explore?item=${encodeURIComponent(row.id)}`,
```

- [ ] **Step 5: Update `CommandPalette.test.tsx` line 71.**

The test asserts the search-result href shape. Open `ui/src/__tests__/CommandPalette.test.tsx`. Replace:

```typescript
          href: "/memory?item=memory-1",
```

with:

```typescript
          href: "/memory/explore?item=memory-1",
```

- [ ] **Step 6: Update `MemorySection.test.tsx` lines 140 + 150.**

Open `ui/src/components/workspace/__tests__/MemorySection.test.tsx`. Replace:

```typescript
  it("links each row to /<companyPrefix>/memory?item=<id> when itemId present", async () => {
```

with:

```typescript
  it("links each row to /<companyPrefix>/memory/explore?item=<id> when itemId present", async () => {
```

And on line ~150:

```typescript
    const link = container.querySelector('a[href="/acme/memory?item=item-77"]');
```

with:

```typescript
    const link = container.querySelector('a[href="/acme/memory/explore?item=item-77"]');
```

- [ ] **Step 7: Note about `Memory.test.tsx:478`.**

A grep of the codebase will turn up `ui/src/__tests__/Memory.test.tsx:478` with `initialEntries: ["/memory?selected=mem-domain"]`. **Do not change this.** That test renders the legacy `<Memory />` component directly and uses the URL only to set router-state for `?selected=` parsing — the path portion isn't asserted. Leaving it alone keeps the legacy-page behavior covered.

- [ ] **Step 8: Run typecheck.**

```bash
pnpm -r typecheck 2>&1 | tail -20
```

Expected: clean. The string changes don't alter any types.

- [ ] **Step 9: Run the affected tests.**

```bash
pnpm --filter ui test CommandPalette MemorySection 2>&1 | tail -30
```

Expected: PASS. The two assertion updates align with the production code.

- [ ] **Step 10: Commit.**

```bash
git add ui/src/components/memory/SourceTextDrawer.tsx \
        ui/src/components/workspace/sections/MemorySection.tsx \
        server/src/services/search.ts \
        ui/src/__tests__/CommandPalette.test.tsx \
        ui/src/components/workspace/__tests__/MemorySection.test.tsx
git commit -m "fix(memory): route fallout — point /memory?item=... links at /memory/explore"
```

---

## Task 2: Lift `formatBytes` to `ui/src/lib/format.ts` and fix sub-1KB display

**Problem:** `SourceTextDrawer.tsx:93` displays asset size as `Math.round(asset.fileSize / 1024) KB` — files under 1KB render as "0 KB". `GenericFileViewer.tsx:13` already has a correct local `formatBytes` (handles B / KB / MB / GB). Lift it to a shared util and use it in both places.

**Files:**
- Create: `ui/src/lib/format.ts`
- Create: `ui/src/lib/__tests__/format.test.ts`
- Modify: `ui/src/components/memory/viewers/GenericFileViewer.tsx`
- Modify: `ui/src/components/memory/SourceTextDrawer.tsx`

- [ ] **Step 1: Branch safety check.**

```bash
git status --short
```

Expected: clean (T1 already committed).

- [ ] **Step 2: Write the failing test first (TDD).**

Create `ui/src/lib/__tests__/format.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatBytes } from "../format";

describe("formatBytes", () => {
  it("renders bytes under 1024 in B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(412)).toBe("412 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("renders KB with one decimal up to 1 MB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1023)).toBe("1023.0 KB");
  });

  it("renders MB with one decimal up to 1 GB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 5)).toBe("5.0 MB");
  });

  it("renders GB with two decimals beyond 1 GB", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.50 GB");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails (file not yet created).**

```bash
pnpm --filter ui test format 2>&1 | tail -15
```

Expected: FAIL with `Cannot find module '../format'`.

- [ ] **Step 4: Create `ui/src/lib/format.ts`.**

```typescript
/**
 * Render a byte count as a human-readable size string.
 *
 * Lifted from `components/memory/viewers/GenericFileViewer.tsx` so multiple
 * memory components can share it (drawer + viewers).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
```

- [ ] **Step 5: Run the test to verify it passes.**

```bash
pnpm --filter ui test format 2>&1 | tail -15
```

Expected: PASS, 4/4.

- [ ] **Step 6: Migrate `GenericFileViewer.tsx` to import the shared util.**

Open `ui/src/components/memory/viewers/GenericFileViewer.tsx`. Replace the local function (lines 13-18):

```typescript
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
```

with an import (place near the other imports at the top):

```typescript
import { formatBytes } from "../../../lib/format";
```

(Adjust relative path if the file's location differs — `viewers/` is two levels under `components/`, so `../../../lib/format` reaches `ui/src/lib/format.ts`. Verify with `node -e` or just check the existing import depth in this file: the existing `import { memoryAssetsApi } from "../../../api/memoryAssets";` confirms the depth.)

- [ ] **Step 7: Fix `SourceTextDrawer.tsx` line 93.**

Open `ui/src/components/memory/SourceTextDrawer.tsx`. Add an import near the top:

```typescript
import { formatBytes } from "../../lib/format";
```

(`components/memory/` is two levels under `src/`, so `../../lib/format`.)

Replace line 93:

```typescript
                {asset.mimeType} · {Math.round(asset.fileSize / 1024)} KB
```

with:

```typescript
                {asset.mimeType} · {formatBytes(asset.fileSize)}
```

- [ ] **Step 8: Check the SourceTextDrawer test for byte-string assertions.**

Open `ui/src/__tests__/SourceTextDrawer.test.tsx` and search for any assertion that checks the rendered KB text. If there's a `expect(...).toContain("KB")` or similar, update the expected string to match the new output (likely "B" or "1.5 KB" depending on the fixture's `fileSize`). If no such assertion exists, no change needed.

```bash
grep -n "KB\|fileSize\|formatBytes" ui/src/__tests__/SourceTextDrawer.test.tsx
```

If the test asserts a specific format, update it. If not, skip this step.

- [ ] **Step 9: Run typecheck + all touched tests.**

```bash
pnpm -r typecheck 2>&1 | tail -10
pnpm --filter ui test format SourceTextDrawer GenericFileViewer 2>&1 | tail -30
```

Expected: typecheck clean, all tests PASS.

- [ ] **Step 10: Commit.**

```bash
git add ui/src/lib/format.ts \
        ui/src/lib/__tests__/format.test.ts \
        ui/src/components/memory/viewers/GenericFileViewer.tsx \
        ui/src/components/memory/SourceTextDrawer.tsx
# Only stage the SourceTextDrawer test if you actually modified it in step 8.
git commit -m "fix(memory): lift formatBytes to ui/lib + fix sub-1KB display in SourceTextDrawer"
```

---

## Task 3: Virtual folders — `__pinned` filter logic + `__pending` tree node

**Problem:** The `__pinned` virtual folder ships in `MemoryTree.tsx` (line 154) but `MemoryFileList` has no branch for it — clicking "Pinned" today shows an empty file list. There's also no "Pending Review" affordance — founders have to scroll department folders looking for pending items.

**Solution:**
- `MemoryFileList`: when `folderPath === "__pinned"`, fetch all items (no folder restriction) and filter to `founderPinnedToTop === true`. When `folderPath === "__pending"`, fetch all items and filter to `status === "pending"`. In both cases, skip the assets query (assets don't have approval status or pin state in this slice).
- `MemoryTree`: add a `__pending` node alongside `__pinned`, sourced from a `useQuery(memoryApi.list)` that counts pending items.
- File-list toolbar: map virtual folder paths to display labels ("Pinned", "Pending Review").

**Files:**
- Modify: `ui/src/components/memory/MemoryFileList.tsx`
- Modify: `ui/src/components/memory/MemoryTree.tsx`
- Create: `ui/src/__tests__/MemoryFileList.test.tsx`

- [ ] **Step 1: Branch safety check.**

```bash
git status --short
```

Expected: clean (T1 + T2 already committed).

- [ ] **Step 2: Write the failing test first (TDD).**

Create `ui/src/__tests__/MemoryFileList.test.tsx`. The test verifies that `__pinned` and `__pending` virtual folders show the correct subset of items.

```typescript
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
      {
        id: "i-pinned",
        title: "Pinned item",
        category: "decision",
        status: "approved",
        updatedAt: "2026-05-01T00:00:00Z",
        folderPath: "engineering/Decisions",
        founderPinnedToTop: true,
      },
      {
        id: "i-pending",
        title: "Pending item",
        category: "reference",
        status: "pending",
        updatedAt: "2026-05-02T00:00:00Z",
        folderPath: "marketing/Brand",
        founderPinnedToTop: false,
      },
      {
        id: "i-other",
        title: "Other item",
        category: "context",
        status: "approved",
        updatedAt: "2026-04-29T00:00:00Z",
        folderPath: "engineering/Decisions",
        founderPinnedToTop: false,
      },
    ]),
  },
}));
vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: { list: vi.fn(async () => []) },
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "co-1",
    selectedCompany: { issuePrefix: "co1" },
  }),
}));

import { MemoryFileList } from "../components/memory/MemoryFileList";

function renderList(props: {
  folderPath: string;
  departmentId: string | null;
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemoryFileList
          companyId="co-1"
          folderPath={props.folderPath}
          departmentId={props.departmentId}
          selectedItemId={null}
          selectedItemType={null}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemoryFileList — virtual folders (Phase 6.1e)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("__pinned shows only items with founderPinnedToTop=true", async () => {
    renderList({ folderPath: "__pinned", departmentId: null });
    await waitFor(() =>
      expect(screen.getByText("Pinned item")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Pending item")).not.toBeInTheDocument();
    expect(screen.queryByText("Other item")).not.toBeInTheDocument();
  });

  it("__pending shows only items with status=pending", async () => {
    renderList({ folderPath: "__pending", departmentId: null });
    await waitFor(() =>
      expect(screen.getByText("Pending item")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Pinned item")).not.toBeInTheDocument();
    expect(screen.queryByText("Other item")).not.toBeInTheDocument();
  });

  it("regular folder shows items with matching folderPath", async () => {
    renderList({
      folderPath: "engineering/Decisions",
      departmentId: "d-eng",
    });
    await waitFor(() =>
      expect(screen.getByText("Pinned item")).toBeInTheDocument(),
    );
    expect(screen.getByText("Other item")).toBeInTheDocument();
    expect(screen.queryByText("Pending item")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails.**

```bash
pnpm --filter ui test MemoryFileList 2>&1 | tail -30
```

Expected: FAIL — `__pinned` and `__pending` cases show nothing because there's no branching logic yet.

- [ ] **Step 4: Update `MemoryFileList.tsx` rows memo with virtual-folder branches.**

Open `ui/src/components/memory/MemoryFileList.tsx`. Replace the existing `rows` `useMemo` (around lines 100-126) with a branching version:

```typescript
  const isVirtualFolder =
    folderPath === "__pinned" || folderPath === "__pending";

  const rows = useMemo<ListRow[]>(() => {
    const allItems = (itemsQuery.data ?? []) as Array<
      MemoryItem & {
        folderPath?: string;
        founderPinnedToTop?: boolean;
      }
    >;

    const items = allItems
      .filter((it) => {
        if (folderPath === "__pinned") return it.founderPinnedToTop === true;
        if (folderPath === "__pending") return it.status === "pending";
        return it.folderPath === folderPath;
      })
      .map<ListRow>((it) => ({
        kind: "memory_item",
        id: it.id,
        name: it.title,
        category: it.category,
        status: it.status,
        modifiedAt:
          typeof it.updatedAt === "string"
            ? it.updatedAt
            : new Date(it.updatedAt).toISOString(),
        raw: it,
      }));

    // Virtual folders show items only — assets don't have pin/approval state.
    const assets = isVirtualFolder
      ? []
      : (assetsQuery.data ?? []).map<ListRow>((a: MemoryAssetRecord) => ({
          kind: "asset",
          id: a.id,
          name: a.fileName,
          mimeType: a.mimeType,
          status: undefined,
          modifiedAt: a.updatedAt,
          raw: a,
        }));

    return [...items, ...assets].sort(
      (a, b) =>
        new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
    );
  }, [itemsQuery.data, assetsQuery.data, folderPath, isVirtualFolder]);
```

- [ ] **Step 5: Update the queries to fetch broadly enough for virtual folders.**

Still in `MemoryFileList.tsx`, the items query currently passes `departmentId ? { departmentId } : {}` — that's correct: when departmentId is null (which is the case for `__pinned` / `__pending` since `MemoryTree` sets `dept: null` for them), it fetches ALL company items. So no change needed for the items query.

The assets query, however, has `enabled: Boolean(folderPath)` — this fires for `__pinned` / `__pending` too. Wasteful but not buggy. Tighten it to skip assets entirely on virtual folders:

```typescript
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
    enabled: Boolean(folderPath) && !isVirtualFolder,
  });
```

(The `isVirtualFolder` constant was added in step 4; this references it. Make sure step 4's `const isVirtualFolder` is declared before the assets query, OR move the const above both queries.)

To keep the file readable, place `isVirtualFolder` right after the prop destructure:

```typescript
export function MemoryFileList({
  companyId,
  folderPath,
  departmentId,
  selectedItemId,
  selectedItemType,
  searchQuery,
}: MemoryFileListProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = selectedCompany?.issuePrefix ?? "";

  const isVirtualFolder =
    folderPath === "__pinned" || folderPath === "__pending";

  const itemsQuery = useQuery({
```

(So both queries can reference it.)

- [ ] **Step 6: Update the toolbar header label.**

In the same file, find the header span around line 159:

```typescript
        <span className="truncate">{folderPath}</span>
```

Replace with a small label-mapping helper. At the top of the file (below the `formatRelative` helper), add:

```typescript
function folderLabel(folderPath: string): string {
  if (folderPath === "__pinned") return "📌 Pinned";
  if (folderPath === "__pending") return "📋 Pending Review";
  return folderPath;
}
```

Then in JSX:

```typescript
        <span className="truncate">{folderLabel(folderPath)}</span>
```

- [ ] **Step 7: Run the failing tests again to confirm they pass.**

```bash
pnpm --filter ui test MemoryFileList 2>&1 | tail -20
```

Expected: 3/3 PASS.

- [ ] **Step 8: Update `MemoryTree.tsx` to add the `__pending` node + counts.**

Open `ui/src/components/memory/MemoryTree.tsx`. The current tree fetches folders + projects but not items. Add an items query:

After the existing `useQuery` calls (around line 53), add:

```typescript
  const { data: items } = useQuery({
    queryKey: queryKeys.memory.list(companyId),
    queryFn: () => memoryApi.list(companyId, {}),
    enabled: Boolean(companyId),
  });
```

You'll need to add the import at the top:

```typescript
import { memoryApi } from "../../api/memory";
import type { MemoryItem } from "@armyofagents/shared";
```

- [ ] **Step 9: Compute pinned + pending counts.**

After the `departments` memo (around line 61), add:

```typescript
  const counts = useMemo(() => {
    const all = (items ?? []) as Array<
      MemoryItem & { founderPinnedToTop?: boolean }
    >;
    return {
      pinned: all.filter((it) => it.founderPinnedToTop === true).length,
      pending: all.filter((it) => it.status === "pending").length,
    };
  }, [items]);
```

- [ ] **Step 10: Pass counts to `buildTree` and add the `__pending` node.**

The current `buildTree` signature is `buildTree(folders, departments)`. Extend it:

Change the call site (around line 63):

```typescript
  const tree = useMemo(
    () => buildTree(folders ?? [], departments, counts),
    [folders, departments, counts],
  );
```

Update the `buildTree` declaration at the bottom of the file (around line 138):

```typescript
function buildTree(
  folders: MemoryFolderRecord[],
  departments: Project[],
  counts: { pinned: number; pending: number },
): TreeNode[] {
```

Inside the function, the existing `__pinned` block (around line 154) — give it a count:

```typescript
  top.push({
    key: "__pinned",
    label: "Pinned",
    icon: "📌",
    count: counts.pinned > 0 ? counts.pinned : undefined,
    depth: 0,
    hasChildren: false,
    target: { folder: "__pinned", dept: null },
  });
```

Add a new `__pending` block immediately after, before the `companyRoot` block:

```typescript
  top.push({
    key: "__pending",
    label: "Pending Review",
    icon: "📋",
    count: counts.pending > 0 ? counts.pending : undefined,
    depth: 0,
    hasChildren: false,
    target: { folder: "__pending", dept: null },
  });
```

- [ ] **Step 11: Run typecheck.**

```bash
pnpm -r typecheck 2>&1 | tail -15
```

Expected: clean.

- [ ] **Step 12: Run all the relevant tests.**

```bash
pnpm --filter ui test MemoryFileList MemoryHome MemoryQuickSwitcher 2>&1 | tail -30
```

Expected: all PASS. The MemoryHome test mock for `memoryApi.list` already returns items with `status: "pending"` and `status: "approved"` — that's compatible with the new MemoryTree query (cache hit, no extra mock surface needed). MemoryFileList's 3 new tests pass per step 7.

- [ ] **Step 13: Commit.**

```bash
git add ui/src/components/memory/MemoryFileList.tsx \
        ui/src/components/memory/MemoryTree.tsx \
        ui/src/__tests__/MemoryFileList.test.tsx
git commit -m "feat(memory): __pinned filter + __pending virtual folder (Phase 6.1e)"
```

---

## Task 4: Browser smoke verify

Verification only — no code changes.

1. Restart server-worktree + ui-worktree if not running. Update vite proxy port if the server-worktree got a new port from `autoPort`.
2. Navigate to `/IMP/memory` (MemoryHome). Confirm the page renders and the pending banner reflects current state.
3. **T1 verification — route fallout:**
   - Click any memory item from the home recents strip → confirm URL is `/memory/explore?...&item=...`. (Already correct from Slice D — sanity check.)
   - Open the global ⌘K palette, type a memory item name (e.g., "Decision"), Enter → confirm URL is `/memory/explore?item=...`, NOT `/memory?item=...`.
   - Open a workspace (`/workspaces/...`) that has linked memory items. The Memory section should render. Click an item → confirm URL is `/memory/explore?item=...`.
   - In MemoryExplorer, open a memory item that was extracted from a file (the recents include several `.txt`-derived items). Click "Show source" in the markdown viewer footer — drawer opens. Click "Open source in viewer" → confirm URL is `/memory/explore?item=...&type=asset`, not `/memory?...`.
4. **T2 verification — file size:**
   - Upload a sub-1KB file (e.g., a 100-byte text file) into a folder via the Upload button.
   - Open the resulting asset. Bottom of the markdown viewer / source drawer should show e.g. "100 B" (or "0.4 KB" range), NOT "0 KB".
5. **T3 verification — virtual folders:**
   - In the explorer tree, observe `📌 Pinned` and `📋 Pending Review` near the top.
   - The Pending Review badge should show the count of pending items (matches the home banner count).
   - Click `📋 Pending Review` → file list should show ONLY pending items, label in the toolbar should say "📋 Pending Review", count badge matches.
   - Click `📌 Pinned` → file list shows only items with founderPinnedToTop=true. If there are none, file list is empty (that's fine — no fixtures pin items by default).
   - Click a regular dept folder (e.g., engineering/Files) → behavior unchanged: shows the 3 .txt files (or whatever's in that folder).

---

## Verification — exit criteria for Phase 6.1e

1. ✅ `pnpm -r typecheck` — 0 errors.
2. ✅ `pnpm --filter ui test format MemoryFileList CommandPalette MemorySection SourceTextDrawer GenericFileViewer` — 0 NEW failures (existing failures fine, but all touched files' tests must pass).
3. ✅ Browser smoke checklist passes.
4. ✅ Branch `memory-polish-6.1e` has 3 new commits ahead of `33dbef5`.
