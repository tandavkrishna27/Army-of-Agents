# Memory Page Redesign — Phase 6.1b (Edit + Approve + Nav) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only Phase 6.1a explorer into a working write surface — founder can edit memory items, approve pending suggestions, move items between folders, pin items to top, and reach the explorer from the sidebar without typing the URL. Asset upload + file viewers (PDF/image/video) ship in Slice C.

**Architecture:** Extend the existing `MarkdownItemViewer` with a preview/edit toggle and a kebab menu. The editor uses `@uiw/react-md-editor` (popular, maintained, ~150KB) — trade-off vs. Monaco (heavier, IDE-grade) and a hand-rolled textarea (lighter, no preview-while-editing). Edit creates a new draft via existing `memoryApi.update`; "Submit for approval" flips status to pending; approve/reject use existing `memoryApi.approve` / `memoryApi.reject`. Move + pin-to-top wire to the new endpoints we shipped in Phase 6.0 (`memoryApi.moveItem`, `memoryApi.setPinnedToTop`). Sidebar nav entry adds a single line under the existing "Memory" link.

**Tech Stack:** Existing AoA UI stack. New dep: `@uiw/react-md-editor` (markdown editor with split-view + live preview). Already-present deps: TanStack Query, react-markdown, lucide-react, shadcn primitives (DropdownMenu, AlertDialog, Button).

**Spec reference:** `docs/superpowers/specs/2026-05-02-memory-page-redesign-design.md` § "File-type viewers / `.md` memory item" + § "Pinned-to-skill" + § "Lifecycle: upload → extract → approve → route".

**Branch + worktree:** `memory-phase-6-0` in `.claude/worktrees/memory-phase-6-0/`. Most recent commit at plan-write time: `7dea6de`.

**Out of scope (later slices):**
- Asset upload through new `/assets/upload` endpoint → Slice C (with file viewers)
- PDF / DOCX / image / video / PPTX viewers + extracts sidebar + source drawer → Slice C
- ⌘K quick switcher + global search → Slice D
- Home page (pending banner + dept tiles + recents) → Slice D
- Drag-and-drop folder rearrangement → polish slice (move-to-folder is via kebab menu in this slice)
- Version history drawer (`📜 Versions (N)` button) → Slice C polish
- Backlinks panel (`🔗 Backlinks (N)` button) → Slice C polish

---

## File Structure

### New files

```
ui/src/components/memory/viewers/MarkdownEditorView.tsx        ← editor mode for the viewer
ui/src/components/memory/MemoryItemActions.tsx                  ← kebab menu (move, pin, archive)
ui/src/components/memory/MemoryApprovalActions.tsx              ← Approve / Edit & Approve / Reject buttons
ui/src/components/memory/MoveToFolderDialog.tsx                 ← folder picker for move action
ui/src/__tests__/MarkdownItemViewer.test.tsx                    ← edit toggle + actions
ui/src/__tests__/MoveToFolderDialog.test.tsx                    ← folder-tree dropdown
```

### Modified files

```
ui/src/components/memory/viewers/MarkdownItemViewer.tsx   ← add Preview/Edit toggle + actions row
ui/src/api/memory.ts                                       ← confirm update/approve/reject signatures
ui/src/components/Sidebar.tsx (or wherever the COMPANY block lives) ← add "Explorer" link under Memory
ui/package.json                                            ← add @uiw/react-md-editor
ui/src/__tests__/MemoryExplorer.test.tsx                   ← updated mocks (only if needed)
```

### Why this split

`MarkdownEditorView` is a separate component because the editor library has different prop surface, dependencies, and styling needs than the read-only `ReactMarkdown` we already use. `MemoryItemActions` and `MemoryApprovalActions` are split out because they're independently testable and have different visibility rules (approval actions only show for pending items; kebab actions show for everything). `MoveToFolderDialog` lives separately so its folder-tree picker can be reused later (e.g. in a context menu, in batch-move flows).

---

## Task 1: Add sidebar nav entry for the explorer

**Files:**
- Modify: `ui/src/components/Sidebar.tsx` (or wherever the existing "Memory" link is registered)

- [ ] **Step 1: Branch safety**

```bash
cd "C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.claude/worktrees/memory-phase-6-0"
git rev-parse --abbrev-ref HEAD
```

Expected: `memory-phase-6-0`. STOP if not.

- [ ] **Step 2: Find the existing Memory nav entry**

Run from the worktree:
```bash
grep -rn 'memory["'"'"']\|/memory' ui/src/components/Sidebar.tsx ui/src/components/layout/ 2>&1 | head -10
```

Expand the search if needed. The goal: locate the existing nav structure with the `🧠 Memory` link under the COMPANY block.

- [ ] **Step 3: Add the Explorer link**

Just below the existing Memory entry, add a sibling entry for the explorer. Mirror the existing entry's component / props pattern. Suggested label: `Explorer (β)` or `Memory Explorer`. Suggested path: `/memory/explore` (will be auto-prefixed with `:companyPrefix`).

If the sidebar uses a list of `{ label, path, icon }` objects, just add one more entry. If it uses raw JSX with `<NavLink>` components, copy the existing Memory `<NavLink>` and adapt.

For the icon, use Lucide `FolderTree` to differentiate from the brain icon on Memory.

If you can't find a clean place to add the entry without breaking the existing structure, STOP and report — placing the link in the wrong section is worse than not placing it at all.

- [ ] **Step 4: Run UI typecheck**

```bash
pnpm --filter ui typecheck
```

Expected: 0 errors.

- [ ] **Step 5: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD
git add ui/src/components/Sidebar.tsx
git commit -m "feat(ui): add Memory Explorer entry to sidebar"
```

Adjust the path if the sidebar component lives elsewhere.

---

## Task 2: Add @uiw/react-md-editor dependency + create MarkdownEditorView

**Files:**
- Modify: `ui/package.json` (add dep)
- Create: `ui/src/components/memory/viewers/MarkdownEditorView.tsx`

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

Expected: `memory-phase-6-0`.

- [ ] **Step 2: Add the editor library**

```bash
pnpm --filter ui add @uiw/react-md-editor
```

This will install `@uiw/react-md-editor` and update `ui/package.json` + `pnpm-lock.yaml`.

If pnpm install fails for environmental reasons (network, ESM cycle, etc.), STOP and report — a different editor library may be needed. Acceptable alternatives: `@mdxeditor/editor` (heavier but already a dep — check first via `grep mdxeditor ui/package.json`), or a hand-rolled `<textarea>` with no syntax highlighting. Default: stick with `@uiw/react-md-editor`.

- [ ] **Step 3: Create the editor component**

Create `ui/src/components/memory/viewers/MarkdownEditorView.tsx`:

```typescript
import { useEffect, useState } from "react";
import MDEditor from "@uiw/react-md-editor";
import { Save, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MarkdownEditorViewProps {
  initialContent: string;
  onSave: (content: string) => void | Promise<void>;
  onCancel?: () => void;
  /** Auto-save debounce in ms. 0 disables auto-save. */
  autoSaveMs?: number;
  /** Saving in progress (mutation pending). */
  saving?: boolean;
  /** Save failed message; falsy = no error. */
  saveError?: string | null;
  /** Optional banner above the editor (e.g. "⏳ Editing draft (unpublished)"). */
  statusBanner?: string;
}

/**
 * Phase 6.1b: markdown editor for memory items.
 *
 * Wraps @uiw/react-md-editor with auto-save + dirty tracking. Calls onSave
 * with the latest content when the user clicks Save (manual) or after the
 * autoSaveMs debounce elapses (auto). Cancel restores initialContent.
 */
export function MarkdownEditorView({
  initialContent,
  onSave,
  onCancel,
  autoSaveMs = 1500,
  saving = false,
  saveError = null,
  statusBanner,
}: MarkdownEditorViewProps) {
  const [value, setValue] = useState(initialContent);
  const [dirty, setDirty] = useState(false);

  // Reset when the parent gives us a new item.
  useEffect(() => {
    setValue(initialContent);
    setDirty(false);
  }, [initialContent]);

  // Auto-save debounce.
  useEffect(() => {
    if (!dirty || autoSaveMs <= 0) return;
    const id = window.setTimeout(() => {
      void onSave(value);
    }, autoSaveMs);
    return () => window.clearTimeout(id);
  }, [value, dirty, autoSaveMs, onSave]);

  function handleChange(next?: string) {
    const v = next ?? "";
    setValue(v);
    setDirty(v !== initialContent);
  }

  return (
    <div className="h-full flex flex-col">
      {statusBanner && (
        <div className="px-4 py-2 bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 text-xs flex items-center gap-2">
          <AlertCircle className="h-3 w-3" />
          {statusBanner}
        </div>
      )}
      <div className="flex-1 overflow-hidden" data-color-mode="dark">
        <MDEditor
          value={value}
          onChange={handleChange}
          height="100%"
          preview="edit"
          textareaProps={{
            placeholder: "Write your memory item in markdown…",
          }}
        />
      </div>
      <div className="flex items-center gap-2 px-4 py-2 border-t border-border bg-card/40">
        <span
          className={cn(
            "text-[10px]",
            dirty ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
          )}
        >
          {saving
            ? "Saving…"
            : saveError
              ? `Save failed: ${saveError}`
              : dirty
                ? "Unsaved changes (auto-save in 1.5s)"
                : "Saved"}
        </span>
        <span className="flex-1" />
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void onSave(value)}
          className="gap-1"
        >
          <Save className="h-3 w-3" />
          Save
        </Button>
      </div>
    </div>
  );
}
```

If `@uiw/react-md-editor` isn't compatible with the project's Vite setup (ESM/CJS issue), the symptom will be an import-time crash. In that case, fall back to a `<textarea>` with the same props (drop the live preview, keep the same outer shape).

- [ ] **Step 4: Run UI typecheck**

```bash
pnpm --filter ui typecheck
```

Expected: 0 errors.

- [ ] **Step 5: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD
git add ui/package.json pnpm-lock.yaml ui/src/components/memory/viewers/MarkdownEditorView.tsx
git commit -m "feat(ui): add MarkdownEditorView with @uiw/react-md-editor + auto-save"
```

---

## Task 3: Wire Preview ⇆ Edit toggle into MarkdownItemViewer

**Files:**
- Modify: `ui/src/components/memory/viewers/MarkdownItemViewer.tsx`
- Create: `ui/src/__tests__/MarkdownItemViewer.test.tsx`

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

- [ ] **Step 2: Read the existing MarkdownItemViewer**

```bash
cat ui/src/components/memory/viewers/MarkdownItemViewer.tsx
```

Note the existing structure: header band, body with `<ReactMarkdown>`, status pills.

- [ ] **Step 3: Add edit-mode state + toggle**

Modify `ui/src/components/memory/viewers/MarkdownItemViewer.tsx` to:
1. Add a `mode` state: `"preview" | "edit"`. Default depends on `item.status`:
   - `pending` / `draft` / `rejected` → `"edit"` (matches the spec's adaptive default)
   - everything else → `"preview"`
2. Add a Preview/Edit toggle row above the body (inside the existing header).
3. When `mode === "preview"`, render `<ReactMarkdown>` as today.
4. When `mode === "edit"`, render `<MarkdownEditorView>` from Task 2.
5. The save handler calls `memoryApi.update(companyId, itemId, { content })` from the existing API client. Wrap in `useMutation` with `onSuccess` that invalidates the item's detail query.
6. The status banner for edit mode is `"⏳ Editing — changes will create a new version pending approval"` if the original status was approved, or `"⏳ Editing draft"` otherwise.

Concrete inline code (replace the existing body section after the header):

```typescript
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Eye, Pencil } from "lucide-react";
import { MarkdownEditorView } from "./MarkdownEditorView";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ... existing imports ...

const EDIT_DEFAULT_STATUSES = new Set(["pending", "draft", "rejected"]);

export function MarkdownItemViewer({ companyId, itemId }: MarkdownItemViewerProps) {
  const queryClient = useQueryClient();
  const { data: item, isLoading, isError } = useQuery({
    queryKey: queryKeys.memory.detail(companyId, itemId),
    queryFn: () => memoryApi.get(companyId, itemId),
    enabled: Boolean(companyId && itemId),
  });

  const [mode, setMode] = useState<"preview" | "edit">("preview");

  // Reset mode when the item changes; default per status.
  // useEffect resets when item.id flips.
  useEffect(() => {
    if (item) {
      setMode(EDIT_DEFAULT_STATUSES.has(item.status as string) ? "edit" : "preview");
    }
  }, [item?.id, item?.status]);

  const updateMutation = useMutation({
    mutationFn: (content: string) =>
      memoryApi.update(companyId, itemId, { content }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memory.detail(companyId, itemId),
      });
    },
  });

  // ... existing isLoading / isError / item-null guards ...

  // ... existing header render (status pills + title) ...
  // Add a toggle row right after the title:
  // <div className="flex items-center gap-2 mt-3 text-xs">
  //   <Button size="sm" variant={mode === "preview" ? "default" : "ghost"} ...>
  //     <Eye className="h-3 w-3 mr-1" /> Preview
  //   </Button>
  //   <Button size="sm" variant={mode === "edit" ? "default" : "ghost"} ...>
  //     <Pencil className="h-3 w-3 mr-1" /> Edit
  //   </Button>
  // </div>

  // Body: branch on mode
  return (
    <div className="h-full flex flex-col">
      {/* header band — keep existing chips + title; add toggle row */}
      <div className="px-6 pt-6 pb-3 border-b border-border">
        {/* ... existing chips ... */}
        <h1 className="text-xl font-semibold">{i.title}</h1>
        <div className="flex items-center gap-2 mt-3">
          <Button
            size="sm"
            variant={mode === "preview" ? "default" : "ghost"}
            onClick={() => setMode("preview")}
            className="h-7 gap-1 text-xs"
          >
            <Eye className="h-3 w-3" />
            Preview
          </Button>
          <Button
            size="sm"
            variant={mode === "edit" ? "default" : "ghost"}
            onClick={() => setMode("edit")}
            className="h-7 gap-1 text-xs"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Button>
        </div>
      </div>
      {mode === "preview" ? (
        <div className="flex-1 overflow-auto px-6 py-5 prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{i.content}</ReactMarkdown>
        </div>
      ) : (
        <MarkdownEditorView
          initialContent={i.content}
          onSave={(content) => updateMutation.mutateAsync(content)}
          saving={updateMutation.isPending}
          saveError={updateMutation.error instanceof Error ? updateMutation.error.message : null}
          statusBanner={
            i.status === "approved"
              ? "Editing — saving will create a new version pending approval"
              : "Editing draft"
          }
        />
      )}
    </div>
  );
}
```

Replace the previous entire return block accordingly. Don't forget the `useEffect` import.

- [ ] **Step 4: Write the test**

Create `ui/src/__tests__/MarkdownItemViewer.test.tsx` (or extend if it already exists):

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const updateMock = vi.fn(async (_companyId: string, _id: string, patch: { content: string }) => ({ content: patch.content }));

vi.mock("../api/memory", () => ({
  memoryApi: {
    get: vi.fn(async () => ({
      id: "i-1",
      title: "Auth strategy",
      content: "# Hi\n\nReal content here.",
      status: "approved",
      category: "decision",
      layer: "domain",
      pinnedToSkill: false,
    })),
    update: updateMock,
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

import { MarkdownItemViewer } from "../components/memory/viewers/MarkdownItemViewer";

function renderViewer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MarkdownItemViewer companyId="co-1" itemId="i-1" />
    </QueryClientProvider>,
  );
}

describe("MarkdownItemViewer (Phase 6.1b)", () => {
  beforeEach(() => updateMock.mockClear());

  it("approved items default to preview mode and show rendered markdown", async () => {
    renderViewer();
    await waitFor(() => expect(screen.getByText("Auth strategy")).toBeInTheDocument());
    // Heading from the markdown body should render.
    await waitFor(() => expect(screen.getByText("Hi")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
  });

  it("clicking Edit toggles to editor mode", async () => {
    const user = userEvent.setup();
    renderViewer();
    await waitFor(() => expect(screen.getByText("Auth strategy")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /edit/i }));
    // Editor surfaces a Save button.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument(),
    );
  });
});
```

If `@testing-library/user-event` isn't installed in the UI package, check before running tests with `grep user-event ui/package.json`. If missing, add it: `pnpm --filter ui add -D @testing-library/user-event`.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter ui test MarkdownItemViewer
```

Expected: PASS — both cases.

- [ ] **Step 6: Run UI typecheck**

```bash
pnpm --filter ui typecheck
```

Expected: 0 errors.

- [ ] **Step 7: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD
git add ui/src/components/memory/viewers/MarkdownItemViewer.tsx ui/src/__tests__/MarkdownItemViewer.test.tsx ui/package.json pnpm-lock.yaml
git commit -m "feat(ui): add Preview/Edit toggle + auto-save to MarkdownItemViewer"
```

The package.json + lockfile changes if `@testing-library/user-event` was added.

---

## Task 4: Add MemoryApprovalActions for pending items

**Files:**
- Create: `ui/src/components/memory/MemoryApprovalActions.tsx`
- Modify: `ui/src/components/memory/viewers/MarkdownItemViewer.tsx` (add the actions row when status === "pending")

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

- [ ] **Step 2: Verify the existing API**

The existing `memoryApi.approve` and `memoryApi.reject` should accept `(companyId, itemId)`. Verify with:

```bash
grep -n "approve:\|reject:" ui/src/api/memory.ts | head -5
```

If the signatures differ, adapt the component's mutation accordingly.

- [ ] **Step 3: Create MemoryApprovalActions**

Create `ui/src/components/memory/MemoryApprovalActions.tsx`:

```typescript
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";

interface MemoryApprovalActionsProps {
  companyId: string;
  itemId: string;
}

/**
 * Phase 6.1b: Approve / Reject buttons for pending memory items.
 *
 * Renders inside MarkdownItemViewer when item.status === "pending". On
 * approve/reject, invalidates the item detail query (so status flips) plus
 * the parent list/folder queries so the item moves out of Pending Review.
 */
export function MemoryApprovalActions({ companyId, itemId }: MemoryApprovalActionsProps) {
  const qc = useQueryClient();
  const { pushToast } = useToast();

  function invalidateAll() {
    void qc.invalidateQueries({ queryKey: queryKeys.memory.detail(companyId, itemId) });
    void qc.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
    void qc.invalidateQueries({ queryKey: queryKeys.memory.pending(companyId) });
  }

  const approve = useMutation({
    mutationFn: () => memoryApi.approve(companyId, itemId),
    onSuccess: () => {
      pushToast({ title: "Approved", tone: "success" });
      invalidateAll();
    },
    onError: (err) => {
      pushToast({
        title: err instanceof Error ? err.message : "Approve failed",
        tone: "error",
      });
    },
  });

  const reject = useMutation({
    mutationFn: () => memoryApi.reject(companyId, itemId),
    onSuccess: () => {
      pushToast({ title: "Rejected", tone: "success" });
      invalidateAll();
    },
    onError: (err) => {
      pushToast({
        title: err instanceof Error ? err.message : "Reject failed",
        tone: "error",
      });
    },
  });

  const busy = approve.isPending || reject.isPending;

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        onClick={() => approve.mutate()}
        disabled={busy}
        className="h-7 gap-1 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
      >
        {approve.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => reject.mutate()}
        disabled={busy}
        className="h-7 gap-1 text-xs"
      >
        {reject.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
        Reject
      </Button>
    </div>
  );
}
```

Verify the `pushToast` API matches the existing pattern. Look at `ui/src/context/ToastContext.tsx`.

If `queryKeys.memory.pending` doesn't exist, drop that invalidate call.

- [ ] **Step 4: Wire into MarkdownItemViewer**

In `MarkdownItemViewer.tsx`, after the Preview/Edit toggle row and only when `item.status === "pending"`, render the `MemoryApprovalActions`:

```typescript
import { MemoryApprovalActions } from "../MemoryApprovalActions";

// inside the header band, after the toggle row:
{i.status === "pending" && (
  <div className="mt-2">
    <MemoryApprovalActions companyId={companyId} itemId={itemId} />
  </div>
)}
```

- [ ] **Step 5: Add to the existing test**

Extend `ui/src/__tests__/MarkdownItemViewer.test.tsx` with:

```typescript
it("pending items show Approve and Reject buttons", async () => {
  // Override the get mock for this case.
  // Easiest: re-import after vi.resetModules + new mock factory, or use vi.mocked.
  const { memoryApi } = await import("../api/memory");
  vi.mocked(memoryApi.get).mockResolvedValueOnce({
    id: "i-1",
    title: "Pending item",
    content: "Pending content",
    status: "pending",
    category: "decision",
    layer: "domain",
    pinnedToSkill: false,
  } as never);

  renderViewer();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
});
```

Add a mock for ToastContext at the top of the test file:

```typescript
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter ui test MarkdownItemViewer
```

Expected: 3/3 PASS.

- [ ] **Step 7: Run UI typecheck**

```bash
pnpm --filter ui typecheck
```

- [ ] **Step 8: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD
git add ui/src/components/memory/MemoryApprovalActions.tsx ui/src/components/memory/viewers/MarkdownItemViewer.tsx ui/src/__tests__/MarkdownItemViewer.test.tsx
git commit -m "feat(ui): add MemoryApprovalActions (Approve / Reject) for pending items"
```

---

## Task 5: Add MemoryItemActions kebab menu (move + pin) + MoveToFolderDialog

**Files:**
- Create: `ui/src/components/memory/MemoryItemActions.tsx`
- Create: `ui/src/components/memory/MoveToFolderDialog.tsx`
- Create: `ui/src/__tests__/MoveToFolderDialog.test.tsx`
- Modify: `ui/src/components/memory/viewers/MarkdownItemViewer.tsx` (add `<MemoryItemActions>` to header)

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

- [ ] **Step 2: Inspect existing dropdown + dialog primitives**

```bash
ls ui/src/components/ui/dropdown-menu.tsx ui/src/components/ui/dialog.tsx
```

Confirm both exist (shadcn primitives). If they don't, the components need adapted imports.

- [ ] **Step 3: Create MemoryItemActions (kebab menu)**

Create `ui/src/components/memory/MemoryItemActions.tsx`:

```typescript
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, FolderInput, Pin, PinOff } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";
import { MoveToFolderDialog } from "./MoveToFolderDialog";

interface MemoryItemActionsProps {
  companyId: string;
  itemId: string;
  currentFolderPath: string;
  currentDepartmentId: string | null;
  founderPinnedToTop: boolean;
}

export function MemoryItemActions({
  companyId,
  itemId,
  currentFolderPath,
  currentDepartmentId,
  founderPinnedToTop,
}: MemoryItemActionsProps) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [moveOpen, setMoveOpen] = useState(false);

  function invalidateAll() {
    void qc.invalidateQueries({ queryKey: queryKeys.memory.detail(companyId, itemId) });
    void qc.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
  }

  const pin = useMutation({
    mutationFn: () => memoryApi.setPinnedToTop(companyId, itemId, !founderPinnedToTop),
    onSuccess: () => {
      pushToast({
        title: founderPinnedToTop ? "Unpinned" : "Pinned to top",
        tone: "success",
      });
      invalidateAll();
    },
    onError: (err) =>
      pushToast({
        title: err instanceof Error ? err.message : "Pin failed",
        tone: "error",
      }),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label="More actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setMoveOpen(true)} className="gap-2">
            <FolderInput className="h-3.5 w-3.5" />
            Move to folder…
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => pin.mutate()}
            disabled={pin.isPending}
            className="gap-2"
          >
            {founderPinnedToTop ? (
              <>
                <PinOff className="h-3.5 w-3.5" /> Unpin from top
              </>
            ) : (
              <>
                <Pin className="h-3.5 w-3.5" /> Pin to top
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Archive + Delete deferred to Slice C */}
        </DropdownMenuContent>
      </DropdownMenu>
      <MoveToFolderDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        companyId={companyId}
        itemId={itemId}
        currentFolderPath={currentFolderPath}
        currentDepartmentId={currentDepartmentId}
        onMoved={() => {
          setMoveOpen(false);
          invalidateAll();
        }}
      />
    </>
  );
}
```

- [ ] **Step 4: Create MoveToFolderDialog**

Create `ui/src/components/memory/MoveToFolderDialog.tsx`:

```typescript
import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Folder } from "lucide-react";
import { memoryFoldersApi } from "../../api/memoryFolders";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";
import { cn } from "@/lib/utils";

interface MoveToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  itemId: string;
  currentFolderPath: string;
  currentDepartmentId: string | null;
  onMoved?: () => void;
}

export function MoveToFolderDialog({
  open,
  onOpenChange,
  companyId,
  itemId,
  currentFolderPath,
  onMoved,
}: MoveToFolderDialogProps) {
  const { pushToast } = useToast();
  const [selected, setSelected] = useState<string>(currentFolderPath);

  useEffect(() => {
    if (open) setSelected(currentFolderPath);
  }, [open, currentFolderPath]);

  const foldersQuery = useQuery({
    queryKey: queryKeys.memory.folders.list(companyId),
    queryFn: () => memoryFoldersApi.list(companyId),
    enabled: open,
  });

  const sortedFolders = useMemo(
    () =>
      (foldersQuery.data ?? [])
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path)),
    [foldersQuery.data],
  );

  const move = useMutation({
    mutationFn: (folderPath: string) =>
      memoryApi.moveItem(companyId, itemId, folderPath),
    onSuccess: () => {
      pushToast({ title: "Moved", tone: "success" });
      onMoved?.();
    },
    onError: (err) =>
      pushToast({
        title: err instanceof Error ? err.message : "Move failed",
        tone: "error",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Move to folder</DialogTitle>
          <DialogDescription>
            Pick a destination folder. The item moves immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 overflow-auto border border-border rounded-md">
          {foldersQuery.isLoading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Loading folders…
            </div>
          ) : sortedFolders.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No folders yet.
            </div>
          ) : (
            sortedFolders.map((f) => (
              <div
                key={f.id}
                onClick={() => setSelected(f.path)}
                className={cn(
                  "px-3 py-2 text-xs cursor-pointer flex items-center gap-2 border-b border-border last:border-b-0",
                  "hover:bg-muted/40",
                  selected === f.path && "bg-primary/10 text-primary",
                )}
              >
                <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{f.displayName}</span>
                <span className="text-muted-foreground">{f.path}</span>
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={move.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={
              move.isPending || !selected || selected === currentFolderPath
            }
            onClick={() => move.mutate(selected)}
          >
            {move.isPending ? "Moving…" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Write the test**

Create `ui/src/__tests__/MoveToFolderDialog.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const moveMock = vi.fn(async () => ({ id: "i-1", folderPath: "engineering/Decisions" }));

vi.mock("../api/memoryFolders", () => ({
  memoryFoldersApi: {
    list: vi.fn(async () => [
      { id: "f1", path: "engineering/Decisions", displayName: "Decisions" },
      { id: "f2", path: "engineering/Files", displayName: "Files" },
    ]),
  },
}));

vi.mock("../api/memory", () => ({
  memoryApi: {
    moveItem: moveMock,
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

import { MoveToFolderDialog } from "../components/memory/MoveToFolderDialog";

function renderDialog(props?: Partial<React.ComponentProps<typeof MoveToFolderDialog>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MoveToFolderDialog
        open
        onOpenChange={vi.fn()}
        companyId="co-1"
        itemId="i-1"
        currentFolderPath="engineering/Files"
        currentDepartmentId="dept-eng"
        onMoved={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("MoveToFolderDialog (Phase 6.1b)", () => {
  beforeEach(() => moveMock.mockClear());

  it("lists available folders", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("Decisions")).toBeInTheDocument());
    expect(screen.getByText("Files")).toBeInTheDocument();
  });

  it("Move button is disabled while target equals current folder", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("Decisions")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^move$/i })).toBeDisabled();
  });

  it("clicking a different folder enables Move and dispatches the mutation", async () => {
    const user = userEvent.setup();
    const onMoved = vi.fn();
    renderDialog({ onMoved });
    await waitFor(() => expect(screen.getByText("Decisions")).toBeInTheDocument());
    await user.click(screen.getByText("Decisions"));
    const moveBtn = screen.getByRole("button", { name: /^move$/i });
    expect(moveBtn).not.toBeDisabled();
    await user.click(moveBtn);
    await waitFor(() => expect(moveMock).toHaveBeenCalledWith("co-1", "i-1", "engineering/Decisions"));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
  });
});
```

- [ ] **Step 6: Wire into MarkdownItemViewer**

Inside the header band of `MarkdownItemViewer.tsx`, add the kebab in the top-right corner:

```typescript
import { MemoryItemActions } from "../MemoryItemActions";

// Where the header band starts, restructure to include the actions in the right side:
<div className="px-6 pt-6 pb-3 border-b border-border">
  <div className="flex items-start justify-between gap-3">
    <div className="flex-1 min-w-0">
      {/* existing chips */}
      <h1 className="text-xl font-semibold">{i.title}</h1>
    </div>
    <MemoryItemActions
      companyId={companyId}
      itemId={itemId}
      currentFolderPath={(i as MemoryItem & { folderPath?: string }).folderPath ?? ""}
      currentDepartmentId={(i as MemoryItem & { departmentId?: string | null }).departmentId ?? null}
      founderPinnedToTop={(i as MemoryItem & { founderPinnedToTop?: boolean }).founderPinnedToTop ?? false}
    />
  </div>
  {/* toggle row + approval actions row stay below */}
</div>
```

- [ ] **Step 7: Run tests**

```bash
pnpm --filter ui test MoveToFolderDialog MarkdownItemViewer
```

Expected: 3 + 3 = 6 cases PASS.

- [ ] **Step 8: Run UI typecheck**

```bash
pnpm --filter ui typecheck
```

Expected: 0 errors.

- [ ] **Step 9: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD
git add ui/src/components/memory/MemoryItemActions.tsx ui/src/components/memory/MoveToFolderDialog.tsx ui/src/__tests__/MoveToFolderDialog.test.tsx ui/src/components/memory/viewers/MarkdownItemViewer.tsx
git commit -m "feat(ui): add MemoryItemActions kebab menu (move + pin) + MoveToFolderDialog"
```

---

## Task 6: Browser smoke verification

**No code changes — purely verification.**

Controller-driven step (the implementer reports DONE; the controller does the live verify in their own session).

Smoke checklist:
1. Restart server + UI dev server with the latest worktree code.
2. Navigate to `/<companyPrefix>/memory/explore`.
3. Confirm the new sidebar entry is visible and routes to the same page.
4. Click into a folder that has at least one approved memory item.
5. Click the item — confirm the Preview/Edit toggle appears in the header.
6. Click Edit — confirm the markdown editor opens. Type a change, wait 1.5s — the "Saving…" indicator should fire then return to "Saved".
7. Click the kebab (`⋯`) — confirm the menu shows "Move to folder…" and "Pin to top".
8. Click "Move to folder…" — confirm the dialog lists folders, selecting one and pressing Move closes the dialog and the item moves in the tree.
9. Click "Pin to top" — confirm the toast appears and the underlying state flipped.
10. (If a pending memory item exists) Open it — confirm Approve / Reject buttons render. Click Approve — confirm toast + item leaves Pending Review.

If any step fails, report which one and the symptom.

---

## Verification — exit criteria for Phase 6.1b

After Tasks 1–5 are complete:

1. ✅ `pnpm -r typecheck` returns 0 errors.
2. ✅ `pnpm --filter ui test MarkdownItemViewer MoveToFolderDialog` returns 6/6 PASS.
3. ✅ Full UI suite has no NEW regressions vs the post-Phase-6.1a baseline.
4. ✅ The new sidebar entry is visible.
5. ✅ Browser smoke checklist all pass.
6. ✅ Branch `memory-phase-6-0` has 5 new commits ahead of `7dea6de` (one per task).

---

## What's NOT in this slice (later slices)

- Asset upload through the new `/assets/upload` endpoint → Slice C (with file viewers)
- PDF / DOCX / image / video / PPTX viewers + extracts sidebar + source drawer → Slice C
- ⌘K quick switcher + global search → Slice D
- Home page (pending banner + dept tiles + recents) → Slice D
- Drag-and-drop folder rearrangement → polish slice (move-to-folder via kebab is the 6.1b version)
- Version history drawer (`📜 Versions (N)` button) → Slice C polish
- Backlinks panel (`🔗 Backlinks (N)` button) → Slice C polish
- Archive / Delete from kebab menu → Slice C polish
