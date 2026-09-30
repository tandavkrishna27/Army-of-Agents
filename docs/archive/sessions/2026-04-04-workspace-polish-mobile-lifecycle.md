# Workspace Polish — Mobile, Lifecycle, Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mobile-responsive tab layout, workspace archive lifecycle, loading/error/empty polish, and CLAUDE.md docs to the workspace system.

**Architecture:** WorkspaceLayout detects mobile via `useSidebar().isMobile` and swaps resizable panels for tab-based navigation using CSS `hidden` (not conditional rendering) to preserve state. ProjectDetail's Workspaces tab gains archive action + collapsed archived section. All workspace components get Skeleton loading states and toast error handling. CLAUDE.md gets a Workspace System section.

**Tech Stack:** React, TailwindCSS, @tanstack/react-query, react-resizable-panels, vitest, @testing-library/react

---

### Task 1: Mobile Tab Layout in WorkspaceLayout

**Files:**
- Modify: `ui/src/components/workspace/WorkspaceLayout.tsx`

- [ ] **Step 1: Add mobile imports and tab state**

At the top of `WorkspaceLayout.tsx`, add the `useSidebar` import and tab type/state inside the component:

```tsx
import { useSidebar } from "../../context/SidebarContext";
import { ListTodo, MessageSquare, Eye, Layers } from "lucide-react";
```

Inside the component function, before `useDefaultLayout`:

```tsx
const { isMobile } = useSidebar();
const [mobileTab, setMobileTab] = useState<"tasks" | "timeline" | "preview" | "context">("timeline");
```

- [ ] **Step 2: Add archived banner**

Right after the opening `<div>` of the return, add the archived banner (renders for both mobile and desktop):

```tsx
{workspace.status === "archived" && (
  <div className="flex items-center gap-2 px-4 py-2 text-sm bg-amber-50 border-b border-amber-200 text-amber-800 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300 shrink-0" data-testid="workspace-archived-banner">
    <AlertTriangle className="h-4 w-4 shrink-0" />
    This workspace is archived
  </div>
)}
```

Also add `AlertTriangle` to the lucide-react import.

- [ ] **Step 3: Extract mobile tab bar component**

Before the `WorkspaceLayout` function, add:

```tsx
const MOBILE_TABS = [
  { key: "tasks" as const, label: "Tasks", icon: ListTodo },
  { key: "timeline" as const, label: "Timeline", icon: MessageSquare },
  { key: "preview" as const, label: "Preview", icon: Eye },
  { key: "context" as const, label: "Context", icon: Layers },
];
```

- [ ] **Step 4: Add mobile layout branch**

Wrap the existing return in a conditional. Replace the return body with:

```tsx
return (
  <div className="flex flex-col h-full overflow-hidden" data-testid="workspace-layout">
    {/* Archived banner */}
    {workspace.status === "archived" && (
      <div className="flex items-center gap-2 px-4 py-2 text-sm bg-amber-50 border-b border-amber-200 text-amber-800 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300 shrink-0" data-testid="workspace-archived-banner">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        This workspace is archived
      </div>
    )}

    {isMobile ? (
      <>
        {/* Mobile tab bar */}
        <div className="flex border-b border-border shrink-0" data-testid="workspace-mobile-tabs">
          {MOBILE_TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setMobileTab(key)}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition-colors",
                mobileTab === key
                  ? "text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
              data-testid={`mobile-tab-${key}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Mobile panels — all rendered, only active visible via CSS */}
        <div className="flex-1 min-h-0 relative">
          <div className={cn("absolute inset-0 overflow-auto", mobileTab !== "tasks" && "hidden")} data-testid="mobile-panel-tasks">
            <WorkspaceTaskNav
              companyId={companyId}
              companyPrefix={companyPrefix}
              projectId={workspace.projectId}
              selectedIssueId={selectedIssueId}
              onSelectIssue={onSelectIssue}
              onBack={onBack}
              departmentName={project?.name ?? "Department"}
            />
          </div>

          <div className={cn("absolute inset-0 overflow-hidden flex flex-col", mobileTab !== "timeline" && "hidden")} data-testid="mobile-panel-timeline">
            {selectedIssueId ? (
              <>
                <div className="shrink-0 border-b border-border">
                  <DependencyChain
                    issueId={selectedIssueId}
                    companyId={companyId}
                    selectedIssueId={selectedIssueId}
                    onSelectIssue={onSelectIssue}
                  />
                </div>
                <div className="flex-1 min-h-0">
                  <WorkspaceTimeline issueId={selectedIssueId} />
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                Select a task to view its timeline
              </div>
            )}
          </div>

          <div className={cn("absolute inset-0 overflow-hidden", mobileTab !== "preview" && "hidden")} data-testid="mobile-panel-preview">
            {selectedIssueId ? (
              <WorkspacePreviewPanel
                issueId={selectedIssueId}
                companyId={companyId}
                activeMode={previewMode ?? "changes"}
                onModeChange={handleModeChange}
                previewArtifact={previewArtifact}
                functionType={project?.functionType ?? null}
                workspaceId={workspace.id}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                Select a task to preview
              </div>
            )}
          </div>

          <div className={cn("absolute inset-0 overflow-auto", mobileTab !== "context" && "hidden")} data-testid="mobile-panel-context">
            {selectedIssueId ? (
              <WorkspaceRightPanel
                issueId={selectedIssueId}
                companyId={companyId}
                companyPrefix={companyPrefix}
                workspace={workspace}
                functionType={project?.functionType ?? null}
                onPreviewArtifact={handlePreviewArtifact}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-4 text-center">
                Select a task to view context
              </div>
            )}
          </div>
        </div>
      </>
    ) : (
      /* Desktop layout — existing code */
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left panel */}
        <div className="w-[250px] shrink-0 h-full overflow-hidden border-r border-border" data-testid="workspace-left-panel">
          <WorkspaceTaskNav
            companyId={companyId}
            companyPrefix={companyPrefix}
            projectId={workspace.projectId}
            selectedIssueId={selectedIssueId}
            onSelectIssue={onSelectIssue}
            onBack={onBack}
            departmentName={project?.name ?? "Department"}
          />
        </div>

        {/* Center */}
        <Group
          orientation="horizontal"
          className="flex-1 min-w-0 h-full"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          data-testid="workspace-center-group"
        >
          <Panel
            id="center-left"
            minSize="20%"
            className="min-w-0 h-full overflow-hidden flex flex-col"
            data-testid="workspace-center-panel"
          >
            {selectedIssueId && (
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
                <DependencyChain
                  issueId={selectedIssueId}
                  companyId={companyId}
                  selectedIssueId={selectedIssueId}
                  onSelectIssue={onSelectIssue}
                />
                <PreviewModeToolbar activeMode={previewMode} onModeChange={handleModeChange} />
              </div>
            )}

            {selectedIssueId ? (
              <WorkspaceTimeline issueId={selectedIssueId} />
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                Select a task to view its timeline
              </div>
            )}
          </Panel>

          {previewMode && (
            <>
              <Separator
                id="center-separator"
                className="w-1 bg-transparent hover:bg-brand/50 transition-colors cursor-col-resize"
                data-testid="workspace-resizable-handle"
              />
              <Panel
                id="center-right"
                minSize="20%"
                className="min-w-0 h-full overflow-hidden"
                data-testid="workspace-preview-panel"
              >
                {selectedIssueId && (
                  <WorkspacePreviewPanel
                    issueId={selectedIssueId}
                    companyId={companyId}
                    activeMode={previewMode}
                    onModeChange={handleModeChange}
                    previewArtifact={previewArtifact}
                    functionType={project?.functionType ?? null}
                    workspaceId={workspace.id}
                  />
                )}
              </Panel>
            </>
          )}
        </Group>

        {/* Right panel */}
        <div className="w-[280px] shrink-0 h-full overflow-hidden border-l border-border" data-testid="workspace-right-panel">
          {selectedIssueId ? (
            <WorkspaceRightPanel
              issueId={selectedIssueId}
              companyId={companyId}
              companyPrefix={companyPrefix}
              workspace={workspace}
              functionType={project?.functionType ?? null}
              onPreviewArtifact={handlePreviewArtifact}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-4 text-center">
              Select a task to view context
            </div>
          )}
        </div>
      </div>
    )}
  </div>
);
```

Also add `cn` import if not already present (it should be via `@/lib/utils`):

```tsx
import { cn } from "@/lib/utils";
```

- [ ] **Step 5: Run the build to verify no TypeScript errors**

Run: `cd ui && npx tsc --noEmit 2>&1 | head -30`
Expected: No errors related to WorkspaceLayout

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/workspace/WorkspaceLayout.tsx
git commit -m "feat: add mobile tab layout and archived banner to WorkspaceLayout"
```

---

### Task 2: Workspace Lifecycle (Archive) in ProjectDetail

**Files:**
- Modify: `ui/src/pages/ProjectDetail.tsx`

- [ ] **Step 1: Add archive mutation to WorkspaceRow**

Replace the `WorkspaceRow` component (lines 485-521) with a version that includes an Archive button and a mutation:

```tsx
function WorkspaceRow({
  workspace,
  onArchive,
}: {
  workspace: ExecutionWorkspace;
  onArchive?: (id: string) => void;
}) {
  const navigate = useNavigate();
  const displayName = workspace.branchName ?? workspace.name;
  const statusClass = STATUS_BADGE_CLASSES[workspace.status] ?? "bg-muted text-muted-foreground";
  const isIsolated = workspace.mode === "isolated_workspace";

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent/30 transition-colors cursor-pointer"
      data-testid={`workspace-row-${workspace.id}`}
      onClick={() => navigate(`/workspaces/${workspace.id}`)}
    >
      <span className="font-mono text-xs font-medium truncate flex-1">{displayName}</span>
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize shrink-0",
          statusClass,
        )}
      >
        {workspace.status}
      </span>
      <span className="text-xs text-muted-foreground shrink-0">
        {formatRelativeTime(workspace.lastUsedAt)}
      </span>
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0",
          isIsolated
            ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
            : "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
        )}
      >
        {isIsolated ? "Isolated" : "Shared"}
      </span>
      {onArchive && workspace.status !== "archived" && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          data-testid={`archive-workspace-${workspace.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onArchive(workspace.id);
          }}
        >
          Archive
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update ProjectWorkspaces to separate active/archived and add archive mutation**

Replace the `ProjectWorkspaces` component with:

```tsx
function ProjectWorkspaces({
  projectId,
  companyId,
}: {
  projectId: string;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [archivedOpen, setArchivedOpen] = useState(false);

  const { data: workspaces, isLoading } = useQuery({
    queryKey: queryKeys.executionWorkspaces.listForProject(companyId, projectId),
    queryFn: () => executionWorkspacesApi.list(companyId, { projectId }),
    enabled: !!companyId && !!projectId,
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => executionWorkspacesApi.update(id, { status: "archived" }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.executionWorkspaces.listForProject(companyId, projectId),
      });
      pushToast({ tone: "success", title: "Workspace archived" });
    },
    onError: () => {
      pushToast({ tone: "error", title: "Failed to archive workspace" });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="workspaces-loading">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!workspaces || workspaces.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        message="No workspaces yet"
        description="Workspaces are automatically created when agents start working on tasks."
        entityColor="var(--entity-agent)"
      />
    );
  }

  const activeWorkspaces = workspaces.filter((w) => w.status !== "archived");
  const archivedWorkspaces = workspaces.filter((w) => w.status === "archived");

  return (
    <div className="space-y-4">
      {activeWorkspaces.length > 0 ? (
        <div className="border border-border divide-y divide-border rounded-md overflow-hidden">
          <div
            className="grid px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide bg-muted/30"
            style={{ gridTemplateColumns: "1fr auto auto auto auto" }}
          >
            <span>Name</span>
            <span>Status</span>
            <span>Last used</span>
            <span>Mode</span>
            <span />
          </div>
          {activeWorkspaces.map((ws) => (
            <WorkspaceRow
              key={ws.id}
              workspace={ws}
              onArchive={(id) => archiveMutation.mutate(id)}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">All workspaces are archived.</p>
      )}

      {archivedWorkspaces.length > 0 && (
        <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="archived-workspaces-trigger">
            {archivedOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Archived ({archivedWorkspaces.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 border border-border divide-y divide-border rounded-md overflow-hidden" data-testid="archived-workspaces-list">
              {archivedWorkspaces.map((ws) => (
                <WorkspaceRow key={ws.id} workspace={ws} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add necessary imports to ProjectDetail.tsx**

Add these imports at the top of the file (merge with existing imports where applicable):

```tsx
import { useToast } from "../context/ToastContext";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
```

Note: `useQueryClient` should already be imported from `@tanstack/react-query`. Check and add if missing.

- [ ] **Step 4: Run the build to verify no TypeScript errors**

Run: `cd ui && npx tsc --noEmit 2>&1 | head -30`
Expected: No errors related to ProjectDetail

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/ProjectDetail.tsx
git commit -m "feat: add workspace archive action with collapsed archived section"
```

---

### Task 3: Loading Skeletons & Error Toasts in Workspace Components

**Files:**
- Modify: `ui/src/components/workspace/WorkspaceTaskNav.tsx`
- Modify: `ui/src/components/workspace/WorkspaceTimeline.tsx`
- Modify: `ui/src/components/workspace/DependencyChain.tsx`
- Modify: `ui/src/components/workspace/WorkspacePreviewPanel.tsx`
- Modify: `ui/src/components/workspace/sections/ArtifactsSection.tsx`
- Modify: `ui/src/components/workspace/sections/ProcessSection.tsx`
- Modify: `ui/src/components/workspace/sections/ContextSection.tsx`

- [ ] **Step 1: Add skeleton loading to WorkspaceTaskNav**

In `WorkspaceTaskNav.tsx`, add imports:

```tsx
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "../../context/ToastContext";
```

Change the `useQuery` destructure to include `isLoading` and `error`:

```tsx
const { data: allIssues = [], isLoading, error } = useQuery({
```

Add error toast effect after the query:

```tsx
const { pushToast } = useToast();

useEffect(() => {
  if (error) {
    pushToast({ tone: "error", title: "Failed to load tasks", body: (error as Error).message });
  }
}, [error, pushToast]);
```

Add `useEffect` to the React imports at the top.

In the return, right after the search `<div>` and before the task groups `<div>`, add a loading guard:

```tsx
{/* Task groups */}
{isLoading ? (
  <div className="p-3 space-y-2" data-testid="task-nav-skeleton">
    {Array.from({ length: 6 }).map((_, i) => (
      <Skeleton key={i} className="h-8 w-full" />
    ))}
  </div>
) : (
  <div className="flex-1 overflow-y-auto" data-testid="workspace-task-list">
    {/* ... existing task group content ... */}
  </div>
)}
```

- [ ] **Step 2: Add skeleton loading to WorkspaceTimeline**

In `WorkspaceTimeline.tsx`, add imports:

```tsx
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "../../context/ToastContext";
```

After the data fetching queries, add error handling:

```tsx
const { pushToast } = useToast();
const isLoading = !comments && !linkedRuns;

useEffect(() => {
  if (commentsError) {
    pushToast({ tone: "error", title: "Failed to load comments", body: (commentsError as Error).message });
  }
}, [commentsError, pushToast]);
```

Rename the `comments` query to capture error: `const { data: comments, error: commentsError } = useQuery({...})`.

In the scrollable timeline area, add a loading skeleton before the timeline items:

```tsx
{!comments && !linkedRuns && (
  <div className="space-y-3" data-testid="timeline-skeleton">
    {Array.from({ length: 3 }).map((_, i) => (
      <Skeleton key={i} className="h-20 w-full" />
    ))}
  </div>
)}
```

- [ ] **Step 3: Add skeleton loading to DependencyChain**

In `DependencyChain.tsx`, add import:

```tsx
import { Skeleton } from "@/components/ui/skeleton";
```

Change the query destructure to include `isLoading`:

```tsx
const { data: deps, isLoading } = useQuery({
```

Before the `if (upstream.length === 0 && downstream.length === 0) return null;` line, add:

```tsx
if (isLoading) {
  return (
    <div className="flex items-center gap-2 px-4 py-2" data-testid="dependency-chain-skeleton">
      <Skeleton className="h-8 w-24" />
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      <Skeleton className="h-8 w-24" />
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      <Skeleton className="h-8 w-24" />
    </div>
  );
}
```

- [ ] **Step 4: Add skeleton to ArtifactsSection**

In `ArtifactsSection.tsx`, replace the existing loading state (line 36-37):

```tsx
if (isLoading) {
  return <div className="px-3 py-2 text-xs text-muted-foreground">Loading...</div>;
}
```

With:

```tsx
if (isLoading) {
  return (
    <div className="px-3 space-y-2" data-testid="artifacts-skeleton">
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
```

Add import:

```tsx
import { Skeleton } from "@/components/ui/skeleton";
```

- [ ] **Step 5: Add skeleton to ProcessSection**

In `ProcessSection.tsx`, add imports:

```tsx
import { Skeleton } from "@/components/ui/skeleton";
```

Destructure `isLoading` from the first query:

```tsx
const { data: issue, isLoading: issueLoading } = useQuery({
```

At the top of the return, add loading guard:

```tsx
if (issueLoading) {
  return (
    <div className="px-3 space-y-2" data-testid="process-skeleton">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-4 w-32" />
    </div>
  );
}
```

- [ ] **Step 6: Add skeleton to ContextSection**

Read `ContextSection.tsx` first, then add a `Skeleton` import and loading state. In the query destructure, add `isLoading`:

```tsx
const { data: deps, isLoading } = useQuery({
```

Add before the existing return:

```tsx
if (isLoading) {
  return (
    <div className="px-3 space-y-2" data-testid="context-skeleton">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}
```

Add import:

```tsx
import { Skeleton } from "@/components/ui/skeleton";
```

- [ ] **Step 7: Run the build to verify no TypeScript errors**

Run: `cd ui && npx tsc --noEmit 2>&1 | head -30`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/workspace/
git commit -m "feat: add skeleton loading states and error toasts to workspace components"
```

---

### Task 4: CLAUDE.md Update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Workspace System section**

After the `## V2.5 Modified Tables` section (around line 137, before `## V3 Architecture`), insert:

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

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add Workspace System section to CLAUDE.md"
```

---

### Task 5: Test — Mobile Layout

**Files:**
- Create: `ui/src/__tests__/WorkspaceMobile.test.tsx`

- [ ] **Step 1: Write the test file**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// --- Mock sidebar context to control isMobile ---
const mockSidebarValue = {
  sidebarOpen: true,
  setSidebarOpen: vi.fn(),
  toggleSidebar: vi.fn(),
  isMobile: true,
  collapsed: false,
  setCollapsed: vi.fn(),
  toggleCollapse: vi.fn(),
};

vi.mock("../../context/SidebarContext", () => ({
  useSidebar: () => mockSidebarValue,
}));

// --- Mock child components to isolate layout logic ---
vi.mock("../components/workspace/WorkspaceTaskNav", () => ({
  WorkspaceTaskNav: () => <div data-testid="mock-task-nav">TaskNav</div>,
}));

vi.mock("../components/workspace/WorkspaceTimeline", () => ({
  WorkspaceTimeline: () => <div data-testid="mock-timeline">Timeline</div>,
}));

vi.mock("../components/workspace/WorkspacePreviewPanel", () => ({
  WorkspacePreviewPanel: () => <div data-testid="mock-preview">Preview</div>,
  PreviewModeToolbar: () => null,
}));

vi.mock("../components/workspace/WorkspaceRightPanel", () => ({
  WorkspaceRightPanel: () => <div data-testid="mock-right-panel">RightPanel</div>,
}));

vi.mock("../components/workspace/DependencyChain", () => ({
  DependencyChain: () => null,
}));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: any) => <div data-testid="resizable-group">{children}</div>,
  Panel: ({ children }: any) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}));

import { WorkspaceLayout } from "../components/workspace/WorkspaceLayout";

const mockWorkspace = {
  id: "ws-1",
  companyId: "comp-1",
  projectId: "proj-1",
  projectWorkspaceId: null,
  sourceIssueId: "issue-1",
  mode: "isolated_workspace",
  strategyType: "git_worktree",
  name: "test-workspace",
  status: "active",
  cwd: "/tmp/ws",
  repoUrl: null,
  baseRef: "main",
  branchName: "feat-1",
  providerType: "git_worktree",
  providerRef: null,
  derivedFromExecutionWorkspaceId: null,
  lastUsedAt: new Date(),
  openedAt: new Date(),
  closedAt: null,
  cleanupEligibleAt: null,
  cleanupReason: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function renderLayout(overrides: Record<string, any> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkspaceLayout
          workspace={{ ...mockWorkspace, ...overrides.workspace } as any}
          project={overrides.project ?? null}
          selectedIssueId={overrides.selectedIssueId ?? "issue-1"}
          onSelectIssue={vi.fn()}
          companyId="comp-1"
          companyPrefix="tc"
          onBack={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("WorkspaceLayout — Mobile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSidebarValue.isMobile = true;
  });

  it("renders tab bar with four tabs on mobile", () => {
    renderLayout();

    expect(screen.getByTestId("workspace-mobile-tabs")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-tab-tasks")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-tab-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-tab-preview")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-tab-context")).toBeInTheDocument();
  });

  it("does NOT render resizable panels on mobile", () => {
    renderLayout();

    expect(screen.queryByTestId("workspace-left-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-right-panel")).not.toBeInTheDocument();
  });

  it("defaults to timeline tab", () => {
    renderLayout();

    const timelinePanel = screen.getByTestId("mobile-panel-timeline");
    expect(timelinePanel).not.toHaveClass("hidden");

    const tasksPanel = screen.getByTestId("mobile-panel-tasks");
    expect(tasksPanel).toHaveClass("hidden");
  });

  it("switches visible panel when clicking tabs", () => {
    renderLayout();

    fireEvent.click(screen.getByTestId("mobile-tab-tasks"));
    expect(screen.getByTestId("mobile-panel-tasks")).not.toHaveClass("hidden");
    expect(screen.getByTestId("mobile-panel-timeline")).toHaveClass("hidden");

    fireEvent.click(screen.getByTestId("mobile-tab-context"));
    expect(screen.getByTestId("mobile-panel-context")).not.toHaveClass("hidden");
    expect(screen.getByTestId("mobile-panel-tasks")).toHaveClass("hidden");
  });

  it("preserves all panels in DOM (CSS hidden, not unmounted)", () => {
    renderLayout();

    // All four panels are in the DOM regardless of active tab
    expect(screen.getByTestId("mobile-panel-tasks")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-panel-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-panel-preview")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-panel-context")).toBeInTheDocument();
  });

  it("shows archived banner when workspace is archived", () => {
    renderLayout({ workspace: { status: "archived" } });

    expect(screen.getByTestId("workspace-archived-banner")).toBeInTheDocument();
    expect(screen.getByText("This workspace is archived")).toBeInTheDocument();
  });
});

describe("WorkspaceLayout — Desktop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSidebarValue.isMobile = false;
  });

  it("renders resizable panels on desktop (no tab bar)", () => {
    renderLayout();

    expect(screen.getByTestId("workspace-left-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-mobile-tabs")).not.toBeInTheDocument();
  });

  it("shows archived banner on desktop too", () => {
    renderLayout({ workspace: { status: "archived" } });

    expect(screen.getByTestId("workspace-archived-banner")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd ui && npx vitest run src/__tests__/WorkspaceMobile.test.tsx 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add ui/src/__tests__/WorkspaceMobile.test.tsx
git commit -m "test: add mobile workspace layout tests"
```

---

### Task 6: Test — Workspace Lifecycle (Archive)

**Files:**
- Modify: `ui/src/__tests__/ProjectDetailWorkspaces.test.tsx`

- [ ] **Step 1: Add archive and collapsed section tests**

Add to the existing test file, inside the `describe("ProjectDetail — Workspaces tab", ...)` block, adding `executionWorkspacesApiMock.update` to the mock and the following tests:

First, add the `update` mock to `executionWorkspacesApiMock`:

```tsx
const executionWorkspacesApiMock = {
  list: vi.fn().mockResolvedValue(mockWorkspaces),
  update: vi.fn().mockResolvedValue({}),
};
```

Then add tests:

```tsx
it("shows Archive button on active workspace rows", async () => {
  renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

  await waitFor(() => {
    expect(screen.getByText("ENG-99-fix-auth")).toBeInTheDocument();
  });

  expect(screen.getByTestId("archive-workspace-ws-1")).toBeInTheDocument();
  expect(screen.getByTestId("archive-workspace-ws-2")).toBeInTheDocument();
});

it("calls update with archived status when Archive is clicked", async () => {
  renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

  await waitFor(() => {
    expect(screen.getByText("ENG-99-fix-auth")).toBeInTheDocument();
  });

  fireEvent.click(screen.getByTestId("archive-workspace-ws-1"));

  await waitFor(() => {
    expect(executionWorkspacesApiMock.update).toHaveBeenCalledWith("ws-1", { status: "archived" });
  });
});

it("shows archived workspaces in a collapsed section", async () => {
  executionWorkspacesApiMock.list.mockResolvedValue([
    makeWorkspace({ id: "ws-active", status: "active" }),
    makeWorkspace({ id: "ws-archived-1", status: "archived", name: "old-branch", branchName: "old-branch" }),
    makeWorkspace({ id: "ws-archived-2", status: "archived", name: "older-branch", branchName: "older-branch" }),
  ]);

  renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

  await waitFor(() => {
    expect(screen.getByTestId("archived-workspaces-trigger")).toBeInTheDocument();
  });

  // The trigger shows count
  expect(screen.getByText("Archived (2)")).toBeInTheDocument();

  // Archived workspaces are NOT visible by default (collapsed)
  expect(screen.queryByTestId("archived-workspaces-list")).not.toBeInTheDocument();

  // Click to expand
  fireEvent.click(screen.getByTestId("archived-workspaces-trigger"));

  await waitFor(() => {
    expect(screen.getByTestId("archived-workspaces-list")).toBeInTheDocument();
  });
});

it("shows loading skeletons while fetching workspaces", async () => {
  // Make the query hang by returning a never-resolving promise
  executionWorkspacesApiMock.list.mockReturnValue(new Promise(() => {}));

  renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

  await waitFor(() => {
    expect(screen.getByTestId("workspaces-loading")).toBeInTheDocument();
  });

  // Should have skeleton elements
  const skeletons = screen.getByTestId("workspaces-loading").querySelectorAll("[data-slot='skeleton']");
  expect(skeletons.length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Add missing imports if needed**

The existing test file already imports `fireEvent` and `waitFor`. No new imports should be needed. Add the `useToast` mock if not present:

```tsx
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn(), toasts: [], dismissToast: vi.fn(), clearToasts: vi.fn() }),
}));
```

Also add the `Skeleton` and `Collapsible` to acceptable modules — these should work as-is since they're real components imported by the updated `ProjectDetail`.

- [ ] **Step 3: Run the tests**

Run: `cd ui && npx vitest run src/__tests__/ProjectDetailWorkspaces.test.tsx 2>&1 | tail -30`
Expected: All tests pass (existing + new)

- [ ] **Step 4: Commit**

```bash
git add ui/src/__tests__/ProjectDetailWorkspaces.test.tsx
git commit -m "test: add workspace archive and lifecycle tests"
```

---

### Task 7: Run All Tests & Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all workspace-related tests**

Run: `cd ui && npx vitest run src/__tests__/WorkspaceMobile.test.tsx src/__tests__/ProjectDetailWorkspaces.test.tsx src/__tests__/WorkspacePreviewPanel.test.tsx 2>&1 | tail -30`
Expected: All pass

- [ ] **Step 2: Run full test suite to check for regressions**

Run: `cd ui && npx vitest run 2>&1 | tail -30`
Expected: No new failures

- [ ] **Step 3: Run TypeScript check**

Run: `cd ui && npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 4: Final commit with all session work**

If any files weren't committed in earlier tasks, stage and commit them:

```bash
git add -A
git commit -m "feat: mobile workspace view, lifecycle management, and polish"
```
