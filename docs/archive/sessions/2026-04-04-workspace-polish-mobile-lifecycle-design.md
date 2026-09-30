# Session 13: Workspace Polish — Mobile, Lifecycle, Cleanup

## Overview

Polish pass across the workspace system: mobile-responsive layout, workspace archival lifecycle, loading/error/empty states, and CLAUDE.md documentation update.

## 1. Mobile Workspace View

### File: `ui/src/components/workspace/WorkspaceLayout.tsx`

**Detection:** Use `useSidebar().isMobile` from `SidebarContext` (768px breakpoint via `window.matchMedia`).

**Layout:** On mobile, replace `ResizablePanelGroup` with a horizontal tab bar and full-width panels.

**Tabs:** `[Tasks] [Timeline] [Preview] [Context]`

- Tasks = `WorkspaceTaskNav` content
- Timeline = dependency chain + timeline + chat input
- Preview = `WorkspacePreviewPanel` (changes/preview/logs)
- Context = `WorkspaceRightPanel` (artifacts, context, process, tools, notes)

**State preservation:** All four tab panels render simultaneously. CSS `hidden` class toggles visibility — NOT conditional rendering. This preserves scroll position, WebSocket connections (live run polling), and component state across tab switches.

**Tab state:** `useState<"tasks" | "timeline" | "preview" | "context">("timeline")` — default to Timeline since that's the primary workspace view.

**Tab bar styling:** Fixed at top, horizontally scrollable if needed. Active tab uses primary color underline. Each tab gets a small icon + label.

### Mobile layout structure

```
<div className="flex flex-col h-full">
  {/* Archived banner if applicable */}
  {workspace.status === "archived" && <ArchivedBanner />}

  {/* Tab bar */}
  <div className="flex border-b shrink-0">
    <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")}>Tasks</TabButton>
    <TabButton active={tab === "timeline"} onClick={() => setTab("timeline")}>Timeline</TabButton>
    <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>Preview</TabButton>
    <TabButton active={tab === "context"} onClick={() => setTab("context")}>Context</TabButton>
  </div>

  {/* Panels — all rendered, only active visible */}
  <div className="flex-1 min-h-0 relative">
    <div className={tab === "tasks" ? "" : "hidden"}>
      <WorkspaceTaskNav ... />
    </div>
    <div className={tab === "timeline" ? "" : "hidden"}>
      {/* dependency chain + timeline */}
    </div>
    <div className={tab === "preview" ? "" : "hidden"}>
      <WorkspacePreviewPanel ... />
    </div>
    <div className={tab === "context" ? "" : "hidden"}>
      <WorkspaceRightPanel ... />
    </div>
  </div>
</div>
```

## 2. Workspace Lifecycle (Archive)

### File: `ui/src/pages/ProjectDetail.tsx` — Workspaces tab

**Archive action:** Each workspace row gets an "Archive" button (or dropdown menu item if a dropdown already exists). Calls:
```ts
executionWorkspacesApi.update(workspace.id, { status: "archived" })
```
Then invalidates the workspaces query.

**List separation:** Filter workspaces into two groups:
- `activeWorkspaces = workspaces.filter(w => w.status !== "archived")`
- `archivedWorkspaces = workspaces.filter(w => w.status === "archived")`

Active workspaces render as before. Archived workspaces render in a `<Collapsible>` section at the bottom, default collapsed, with header "Archived ({count})".

**Toast feedback:** On archive success: `pushToast({ tone: "success", title: "Workspace archived" })`. On failure: `pushToast({ tone: "error", title: "Failed to archive workspace" })`.

### File: `ui/src/components/workspace/WorkspaceLayout.tsx`

**Archived banner:** If `workspace.status === "archived"`, show a yellow/amber banner at the very top of the layout:
```
⚠ This workspace is archived
```
Banner uses `bg-amber-50 border-amber-200 text-amber-800` (light) / dark mode equivalents. Renders above both mobile tabs and desktop panels.

## 3. General Polish

### Loading States (Skeleton)

Add `<Skeleton>` placeholders to these components while their primary queries are loading:

| Component | Skeleton pattern |
|-----------|-----------------|
| `WorkspaceTaskNav` | 6 rows of `<Skeleton className="h-8 w-full" />` |
| `WorkspaceTimeline` | 3 blocks of `<Skeleton className="h-20 w-full" />` |
| `WorkspaceRightPanel` sections | Per-section: 2-3 `<Skeleton>` lines |
| `DependencyChain` | 3 inline `<Skeleton className="h-8 w-24" />` with arrow gaps |
| `WorkspacePreviewPanel` | Single large `<Skeleton className="h-full w-full" />` |

Check each component's `useQuery` for `isLoading` / `isPending` state and conditionally render skeletons.

### Error Handling

For failed API calls in workspace components, use `useToast().pushToast` with `tone: "error"`. Pattern:
```ts
const { data, isLoading, error } = useQuery({ ... });

useEffect(() => {
  if (error) {
    pushToast({ tone: "error", title: "Failed to load [resource]", body: error.message });
  }
}, [error]);
```

Apply to: WorkspaceTaskNav, WorkspaceTimeline, DependencyChain, all right-panel sections, WorkspacePreviewPanel.

### Empty States

Each panel/section gets a centered empty state message when data loads successfully but is empty:

| Component | Empty condition | Message |
|-----------|----------------|---------|
| `WorkspaceTaskNav` | No tasks match filter | "No tasks in this workspace" |
| `WorkspaceTimeline` | No runs and no comments | "No activity yet. Send a message to get started." |
| `DependencyChain` | No upstream/downstream | (Already returns null — no change needed) |
| `ArtifactsSection` | No artifacts | "No artifacts yet" |
| `ContextSection` | No upstream deps completed | "No upstream context available" |
| `ProcessSection` | No agent assigned | "No agent assigned" |

### Keyboard

`Sheet` from shadcn/ui already handles Escape via `onOpenChange`. Verify this works in `TaskSlideOver` — the existing `onOpenChange={(o) => { if (!o) onClose(); }}` should suffice. No code change needed unless testing reveals an issue.

### Transitions

- Tab switching on mobile: use `transition-opacity duration-150` on panel wrappers for smooth feel
- Panel resize: already handled by `react-resizable-panels` library
- No additional animation needed

## 4. CLAUDE.md Update

Add a "Workspace System" section after "V2.5 Modified Tables":

```markdown
## Workspace System

- **Route:** `/:companyPrefix/workspace/:workspaceId` renders `WorkspaceView` page
- **Layout:** `WorkspaceLayout` with 3-panel resizable layout (task nav | timeline+preview | context)
- **Mobile:** Tab-based navigation [Tasks][Timeline][Preview][Context] using CSS hidden (not conditional render)
- **functionType:** Project field (`software_development` | `design` | `marketing` | etc.) controls workspace tool visibility
- **executionWorkspacePolicy:** Project field (`per_task` | `shared` | `none`) controls workspace creation
- **TaskSlideOver:** Right-side Sheet with two modes — standard (task detail) and workspace (embedded timeline)
- **Lifecycle:** Workspaces can be archived via status update. Archived workspaces shown in collapsed section.
- **Key files:** `ui/src/components/workspace/`, `server/src/services/workspace-runtime.ts`, `packages/db/src/schema/execution_workspaces.ts`
```

## 5. Tests

### File: `ui/src/__tests__/WorkspaceMobile.test.tsx`

**Test: mobile layout renders tabs instead of panels**
- Mock `useSidebar` to return `isMobile: true`
- Render `WorkspaceLayout` with mock props
- Assert: tab buttons [Tasks, Timeline, Preview, Context] are present
- Assert: `ResizablePanelGroup` is NOT rendered
- Assert: clicking each tab shows corresponding panel content

**Test: loading skeletons render while fetching**
- Mock queries to return `isLoading: true`
- Assert: `[data-slot="skeleton"]` elements are present in rendered output

### File: `ui/src/__tests__/WorkspaceLifecycle.test.tsx`

**Test: archive workspace updates status**
- Mock `executionWorkspacesApi.update`
- Render Workspaces tab with a workspace
- Click Archive button
- Assert: `update(id, { status: "archived" })` was called

**Test: archived workspaces shown in collapsed section**
- Render with mix of active and archived workspaces
- Assert: archived section exists with correct count
- Assert: archived section is collapsed by default
- Click to expand — archived workspaces visible
