# Diff Viewer & Dev Server Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 4 placeholder in the workspace Changes view with a file-level change summary, and enhance Preview mode to display an iframe for running dev servers.

**Architecture:** Changes view fetches runs with `detectedOutputs` from the existing activity API (extended with one column), renders a file list per run. Preview mode queries a new runtime-services endpoint; if a running service exists, shows an iframe; otherwise falls through to existing artifact preview.

**Tech Stack:** React, TanStack Query, Drizzle ORM, Express, Vitest + Testing Library

**Spec:** `docs/superpowers/specs/2026-04-04-diff-viewer-dev-server-preview-design.md`

---

### Task 1: Extend Backend — Add detectedOutputs to runs-for-issue query

**Files:**
- Modify: `server/src/services/activity.ts:63-76` (add column to SELECT)
- Modify: `ui/src/api/activity.ts:4-14` (add field to RunForIssue type)

- [ ] **Step 1: Add detectedOutputs to the activity service SELECT**

In `server/src/services/activity.ts`, the `runsForIssue` method selects columns from `heartbeatRuns`. Add `detectedOutputs` to the select object:

```typescript
// server/src/services/activity.ts — inside runsForIssue method's .select({})
// After line: resultJson: heartbeatRuns.resultJson,
// Add:
      detectedOutputs: heartbeatRuns.detectedOutputs,
```

The full select block becomes:
```typescript
runsForIssue: (companyId: string, issueId: string) =>
  db
    .select({
      runId: heartbeatRuns.id,
      status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      invocationSource: heartbeatRuns.invocationSource,
      usageJson: heartbeatRuns.usageJson,
      resultJson: heartbeatRuns.resultJson,
      detectedOutputs: heartbeatRuns.detectedOutputs,
    })
```

- [ ] **Step 2: Update the RunForIssue frontend type**

In `ui/src/api/activity.ts`, add the `detectedOutputs` field to `RunForIssue`:

```typescript
import type { DetectedOutput } from "@armyofagents/shared";

export interface RunForIssue {
  runId: string;
  status: string;
  agentId: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  invocationSource: string;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  detectedOutputs: DetectedOutput[] | null;
}
```

- [ ] **Step 3: Commit**

```bash
git add server/src/services/activity.ts ui/src/api/activity.ts
git commit -m "feat: add detectedOutputs to runs-for-issue query and type"
```

---

### Task 2: Add Runtime Services Backend Endpoint

**Files:**
- Modify: `server/src/routes/execution-workspaces.ts:1-13` (add import) and append new route before `return router`

- [ ] **Step 1: Add workspaceRuntimeServices import**

In `server/src/routes/execution-workspaces.ts`, add `workspaceRuntimeServices` to the `@armyofagents/db` import on line 4:

```typescript
import { issues, projects, projectWorkspaces, workspaceRuntimeServices } from "@armyofagents/db";
```

- [ ] **Step 2: Add the GET runtime-services route**

In `server/src/routes/execution-workspaces.ts`, add this route before the `return router;` statement (before line 193):

```typescript
  router.get("/execution-workspaces/:id/runtime-services", async (req, res) => {
    if (!(await assertIsolatedWorkspacesEnabled(res))) return;
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, workspace.companyId);
    const services = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(
        and(
          eq(workspaceRuntimeServices.companyId, workspace.companyId),
          eq(workspaceRuntimeServices.executionWorkspaceId, id),
        ),
      );
    res.json(services);
  });
```

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/execution-workspaces.ts
git commit -m "feat: add GET runtime-services endpoint for execution workspaces"
```

---

### Task 3: Add Runtime Services Frontend API Client

**Files:**
- Modify: `ui/src/api/execution-workspaces.ts`

- [ ] **Step 1: Add the WorkspaceRuntimeService type and API method**

In `ui/src/api/execution-workspaces.ts`, add the type and method:

```typescript
import type { ExecutionWorkspace } from "@armyofagents/shared";
import { api } from "./client";

export interface WorkspaceRuntimeService {
  id: string;
  serviceName: string;
  status: string;
  port: number | null;
  url: string | null;
  command: string | null;
  cwd: string | null;
  provider: string;
  lifecycle: string;
  startedAt: string | null;
  stoppedAt: string | null;
}

export const executionWorkspacesApi = {
  list: (
    companyId: string,
    filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.projectWorkspaceId) params.set("projectWorkspaceId", filters.projectWorkspaceId);
    if (filters?.issueId) params.set("issueId", filters.issueId);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.reuseEligible) params.set("reuseEligible", "true");
    const qs = params.toString();
    return api.get<ExecutionWorkspace[]>(`/companies/${companyId}/execution-workspaces${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => api.get<ExecutionWorkspace>(`/execution-workspaces/${id}`),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch<ExecutionWorkspace>(`/execution-workspaces/${id}`, data),
  runtimeServices: (workspaceId: string) =>
    api.get<WorkspaceRuntimeService[]>(`/execution-workspaces/${workspaceId}/runtime-services`),
};
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/api/execution-workspaces.ts
git commit -m "feat: add runtimeServices API client method"
```

---

### Task 4: Thread New Props Through WorkspaceLayout

**Files:**
- Modify: `ui/src/components/workspace/WorkspaceLayout.tsx:122-128`
- Modify: `ui/src/components/workspace/WorkspacePreviewPanel.tsx:14-22`

- [ ] **Step 1: Add functionType and workspaceId props to WorkspacePreviewPanel interface**

In `ui/src/components/workspace/WorkspacePreviewPanel.tsx`, update the props interface:

```typescript
interface WorkspacePreviewPanelProps {
  issueId: string;
  companyId: string;
  activeMode: PreviewMode | null;
  onModeChange: (mode: PreviewMode | null) => void;
  /** Artifact version to preview (set by ArtifactsSection click) */
  previewArtifact?: { artifact: ArtifactWithVersions; version: ArtifactVersion } | null;
  /** Department function type — gates software-dev-only features */
  functionType?: string | null;
  /** Execution workspace ID — used for dev server preview */
  workspaceId?: string | null;
}
```

Update the destructuring in the component function to accept the new props:

```typescript
export function WorkspacePreviewPanel({
  issueId,
  companyId,
  activeMode,
  onModeChange,
  previewArtifact,
  functionType,
  workspaceId,
}: WorkspacePreviewPanelProps) {
```

- [ ] **Step 2: Pass props from WorkspaceLayout**

In `ui/src/components/workspace/WorkspaceLayout.tsx`, update the `WorkspacePreviewPanel` usage (around line 122):

```typescript
              <WorkspacePreviewPanel
                issueId={selectedIssueId}
                companyId={companyId}
                activeMode={previewMode}
                onModeChange={handleModeChange}
                previewArtifact={previewArtifact}
                functionType={project?.functionType ?? null}
                workspaceId={workspace.id}
              />
```

- [ ] **Step 3: Pass new props to sub-views**

In `WorkspacePreviewPanel.tsx`, update how the sub-views are rendered in the return JSX. Pass `functionType` and `issueId` to `ChangesView`, and `functionType` and `workspaceId` to `PreviewView`:

Replace:
```typescript
        {activeMode === "changes" && <ChangesView />}
```
With:
```typescript
        {activeMode === "changes" && <ChangesView issueId={issueId} functionType={functionType ?? null} />}
```

Replace:
```typescript
        {activeMode === "preview" && (
          <PreviewView
            artifact={previewArtifact?.artifact ?? artifact ?? null}
            version={previewArtifact?.version ?? null}
          />
        )}
```
With:
```typescript
        {activeMode === "preview" && (
          <PreviewView
            artifact={previewArtifact?.artifact ?? artifact ?? null}
            version={previewArtifact?.version ?? null}
            functionType={functionType ?? null}
            workspaceId={workspaceId ?? null}
          />
        )}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/workspace/WorkspaceLayout.tsx ui/src/components/workspace/WorkspacePreviewPanel.tsx
git commit -m "feat: thread functionType and workspaceId props to preview panel"
```

---

### Task 5: Implement ChangesView Component

**Files:**
- Modify: `ui/src/components/workspace/WorkspacePreviewPanel.tsx:134-140` (replace ChangesView)

- [ ] **Step 1: Add imports at the top of WorkspacePreviewPanel.tsx**

Add these imports to the top of the file:

```typescript
import { FileText, FileCode, FileImage, File } from "lucide-react";
import type { DetectedOutput } from "@armyofagents/shared";
```

Also add `activityApi` and `RunForIssue` — these are already imported (line 5), so no change needed there.

- [ ] **Step 2: Add helper functions before ChangesView**

Add these helpers above the `ChangesView` component:

```typescript
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceLabel(source: string): { text: string; className: string } {
  switch (source) {
    case "git_diff":
      return { text: "Modified", className: "bg-green-500/10 text-green-600" };
    case "workspace_scan":
      return { text: "Detected", className: "bg-blue-500/10 text-blue-600" };
    case "adapter_provided":
      return { text: "Provided", className: "bg-purple-500/10 text-purple-600" };
    default:
      return { text: source, className: "bg-muted text-muted-foreground" };
  }
}

function fileIcon(contentType: string): typeof FileText {
  if (contentType.startsWith("image/")) return FileImage;
  if (contentType.includes("javascript") || contentType.includes("typescript") || contentType.includes("json"))
    return FileCode;
  if (contentType.startsWith("text/")) return FileText;
  return File;
}
```

- [ ] **Step 3: Replace the ChangesView placeholder**

Replace the entire `ChangesView` function (lines 134-140) with:

```typescript
function ChangesView({ issueId, functionType }: { issueId: string; functionType: string | null }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });

  if (functionType !== "software_development") {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground" data-testid="changes-no-code">
        No code changes to display
      </div>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground" data-testid="changes-no-runs">
        No runs yet
      </div>
    );
  }

  const activeRunId = selectedRunId ?? runs[0].runId;
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const outputs: DetectedOutput[] = activeRun?.detectedOutputs ?? [];

  return (
    <div className="flex flex-col h-full" data-testid="changes-view">
      {runs.length > 1 && (
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border overflow-x-auto">
          {runs.slice(0, 10).map((r) => (
            <Button
              key={r.runId}
              variant={activeRunId === r.runId ? "secondary" : "ghost"}
              size="sm"
              className="h-6 px-2 text-xs shrink-0"
              onClick={() => setSelectedRunId(r.runId)}
            >
              Run {r.runId.slice(0, 6)}
            </Button>
          ))}
        </div>
      )}

      {outputs.length === 0 ? (
        <div className="flex items-center justify-center h-48 text-sm text-muted-foreground" data-testid="changes-empty-run">
          No changes detected in this run
        </div>
      ) : (
        <div className="flex flex-col">
          {outputs.map((output, idx) => {
            const Icon = fileIcon(output.contentType);
            const badge = sourceLabel(output.source);
            return (
              <div
                key={`${output.path}-${idx}`}
                className="flex items-center gap-2 px-3 py-2 border-b border-border last:border-b-0 hover:bg-muted/50"
                data-testid="changes-file-row"
              >
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="flex-1 text-xs font-mono truncate" title={output.path}>
                  {output.path}
                </span>
                <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", badge.className)}>
                  {badge.text}
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {formatBytes(output.byteSize)}
                </span>
              </div>
            );
          })}
          <div className="px-3 py-2 text-[10px] text-muted-foreground">
            {outputs.length} file{outputs.length !== 1 ? "s" : ""} changed in this run
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify build compiles**

Run: `cd ui && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/workspace/WorkspacePreviewPanel.tsx
git commit -m "feat: implement ChangesView with file-level change summary"
```

---

### Task 6: Enhance PreviewView with Dev Server Iframe

**Files:**
- Modify: `ui/src/components/workspace/WorkspacePreviewPanel.tsx:142-207` (enhance PreviewView)

- [ ] **Step 1: Add executionWorkspacesApi import**

Add to the imports at the top of `WorkspacePreviewPanel.tsx`:

```typescript
import { executionWorkspacesApi } from "../../api/execution-workspaces";
import { RefreshCw, Globe } from "lucide-react";
```

Note: `RefreshCw` and `Globe` are added to the existing lucide-react import. Merge them into the existing import line:

```typescript
import { GitCompareArrows, Eye, Terminal, X, FileText, FileCode, FileImage, File, RefreshCw, Globe } from "lucide-react";
```

- [ ] **Step 2: Replace the PreviewView function**

Replace the entire `PreviewView` function with this version that adds dev server iframe support:

```typescript
function PreviewView({
  artifact,
  version: versionOverride,
  functionType,
  workspaceId,
}: {
  artifact: ArtifactWithVersions | null;
  version: ArtifactVersion | null;
  functionType: string | null;
  workspaceId: string | null;
}) {
  const [iframeKey, setIframeKey] = useState(0);

  const { data: runtimeServices } = useQuery({
    queryKey: ["runtime-services", workspaceId],
    queryFn: () => executionWorkspacesApi.runtimeServices(workspaceId!),
    enabled: functionType === "software_development" && !!workspaceId,
    refetchInterval: 10000,
  });

  const runningService = runtimeServices?.find((s) => s.status === "running" && s.url);

  // Dev server iframe for software departments
  if (functionType === "software_development" && workspaceId) {
    if (runningService?.url) {
      return (
        <div className="flex flex-col h-full" data-testid="preview-devserver">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1 text-xs font-mono text-muted-foreground truncate">
              {runningService.url}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setIframeKey((k) => k + 1)}
              title="Refresh preview"
              data-testid="preview-refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <iframe
            key={iframeKey}
            src={runningService.url}
            className="flex-1 w-full border-0"
            title="Dev server preview"
            data-testid="preview-iframe"
          />
        </div>
      );
    }

    // No running dev server — show message, then fall through to artifact preview below
    if (!artifact) {
      return (
        <div className="flex flex-col items-center justify-center h-48 gap-2 text-sm text-muted-foreground" data-testid="preview-no-devserver">
          <Globe className="h-5 w-5" />
          <p>No dev server running</p>
          <p className="text-xs">Dev servers start automatically during agent runs.</p>
        </div>
      );
    }
  }

  // Existing artifact preview (unchanged)
  if (!artifact) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground" data-testid="preview-empty">
        No artifacts linked to this task
      </div>
    );
  }

  const version = versionOverride ?? (artifact.versions.length > 0 ? artifact.versions[0] : null);

  if (!version) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
        No versions available
      </div>
    );
  }

  const isImage = artifact.type === "design" || (version.fileUrl && /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(version.fileUrl));

  if (isImage && version.fileUrl) {
    return (
      <div className="p-4" data-testid="preview-image">
        <img src={version.fileUrl} alt={artifact.title} className="max-w-full rounded border border-border" />
      </div>
    );
  }

  if (version.content) {
    return (
      <div className="p-4" data-testid="preview-text">
        <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-mono bg-muted/50 rounded p-3 border border-border">
          {version.content}
        </pre>
      </div>
    );
  }

  if (version.fileUrl) {
    return (
      <div className="flex items-center justify-center h-48" data-testid="preview-download">
        <a
          href={version.fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-500 hover:underline"
        >
          Download {artifact.title} (v{version.versionNumber})
        </a>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
      No content to preview
    </div>
  );
}
```

- [ ] **Step 3: Verify build compiles**

Run: `cd ui && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/workspace/WorkspacePreviewPanel.tsx
git commit -m "feat: add dev server iframe preview for running runtime services"
```

---

### Task 7: Write Tests

**Files:**
- Create: `ui/src/__tests__/WorkspacePreviewPanel.test.tsx`

- [ ] **Step 1: Create the test file**

Create `ui/src/__tests__/WorkspacePreviewPanel.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ─── Mock data ────────────────────────────────────────────────────────────────

const mockRunsWithOutputs = [
  {
    runId: "run-1",
    status: "completed",
    agentId: "agent-1",
    startedAt: "2026-04-04T10:00:00Z",
    finishedAt: "2026-04-04T10:05:00Z",
    createdAt: "2026-04-04T10:00:00Z",
    invocationSource: "heartbeat",
    usageJson: null,
    resultJson: null,
    detectedOutputs: [
      {
        path: "src/components/Button.tsx",
        filename: "Button.tsx",
        byteSize: 2048,
        contentType: "text/typescript",
        assetId: null,
        sha256: null,
        source: "git_diff",
        status: "pending",
      },
      {
        path: "src/styles/theme.css",
        filename: "theme.css",
        byteSize: 1200,
        contentType: "text/css",
        assetId: null,
        sha256: null,
        source: "workspace_scan",
        status: "pending",
      },
      {
        path: "package.json",
        filename: "package.json",
        byteSize: 800,
        contentType: "application/json",
        assetId: null,
        sha256: null,
        source: "git_diff",
        status: "confirmed",
      },
    ],
  },
];

const mockRunsEmpty = [
  {
    runId: "run-2",
    status: "completed",
    agentId: "agent-1",
    startedAt: "2026-04-04T10:00:00Z",
    finishedAt: "2026-04-04T10:05:00Z",
    createdAt: "2026-04-04T10:00:00Z",
    invocationSource: "heartbeat",
    usageJson: null,
    resultJson: null,
    detectedOutputs: null,
  },
];

const mockRunningService = [
  {
    id: "svc-1",
    serviceName: "npm_dev_server",
    status: "running",
    port: 3000,
    url: "http://localhost:3000",
    command: "npm run dev",
    cwd: "/tmp/workspace",
    provider: "local_process",
    lifecycle: "shared",
    startedAt: "2026-04-04T10:00:00Z",
    stoppedAt: null,
  },
];

// ─── API Mocks ────────────────────────────────────────────────────────────────

const activityApiMock = {
  runsForIssue: vi.fn().mockResolvedValue([]),
};

const artifactsApiMock = {
  getByIssueId: vi.fn().mockResolvedValue(null),
};

const executionWorkspacesApiMock = {
  runtimeServices: vi.fn().mockResolvedValue([]),
};

vi.mock("../api/activity", () => ({
  activityApi: new Proxy(
    {},
    { get: (_t: unknown, prop: string) => (activityApiMock as Record<string, unknown>)[prop] },
  ),
}));

vi.mock("../api/artifacts", () => ({
  artifactsApi: new Proxy(
    {},
    { get: (_t: unknown, prop: string) => (artifactsApiMock as Record<string, unknown>)[prop] },
  ),
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: new Proxy(
    {},
    { get: (_t: unknown, prop: string) => (executionWorkspacesApiMock as Record<string, unknown>)[prop] },
  ),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// ─── Import after mocks ──────────────────────────────────────────────────────

import { WorkspacePreviewPanel } from "../components/workspace/WorkspacePreviewPanel";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkspacePreviewPanel — Changes mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders file list for software_development workspaces", async () => {
    activityApiMock.runsForIssue.mockResolvedValue(mockRunsWithOutputs);

    render(
      <WorkspacePreviewPanel
        issueId="issue-1"
        companyId="comp-1"
        activeMode="changes"
        onModeChange={() => {}}
        functionType="software_development"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId("changes-view")).toBeInTheDocument();
    });

    const rows = screen.getAllByTestId("changes-file-row");
    expect(rows).toHaveLength(3);
    expect(screen.getByText("src/components/Button.tsx")).toBeInTheDocument();
    expect(screen.getByText("src/styles/theme.css")).toBeInTheDocument();
    expect(screen.getByText("package.json")).toBeInTheDocument();
    expect(screen.getByText("3 files changed in this run")).toBeInTheDocument();
  });

  it("shows 'no code changes' for non-software departments", async () => {
    render(
      <WorkspacePreviewPanel
        issueId="issue-1"
        companyId="comp-1"
        activeMode="changes"
        onModeChange={() => {}}
        functionType="marketing"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId("changes-no-code")).toBeInTheDocument();
    });

    expect(screen.getByText("No code changes to display")).toBeInTheDocument();
  });
});

describe("WorkspacePreviewPanel — Preview mode (dev server)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows iframe when dev server URL is available", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue(mockRunningService);

    render(
      <WorkspacePreviewPanel
        issueId="issue-1"
        companyId="comp-1"
        activeMode="preview"
        onModeChange={() => {}}
        functionType="software_development"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-devserver")).toBeInTheDocument();
    });

    const iframe = screen.getByTestId("preview-iframe") as HTMLIFrameElement;
    expect(iframe.src).toBe("http://localhost:3000/");
    expect(screen.getByText("http://localhost:3000")).toBeInTheDocument();
    expect(screen.getByTestId("preview-refresh")).toBeInTheDocument();
  });

  it("shows 'no dev server' when none running", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([]);

    render(
      <WorkspacePreviewPanel
        issueId="issue-1"
        companyId="comp-1"
        activeMode="preview"
        onModeChange={() => {}}
        functionType="software_development"
        workspaceId="ws-1"
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-no-devserver")).toBeInTheDocument();
    });

    expect(screen.getByText("No dev server running")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd ui && npx vitest run src/__tests__/WorkspacePreviewPanel.test.tsx`
Expected: All 4 tests pass

- [ ] **Step 3: Commit**

```bash
git add ui/src/__tests__/WorkspacePreviewPanel.test.tsx
git commit -m "test: add tests for ChangesView and dev server preview"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run full type check**

Run: `cd ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run all workspace-related tests**

Run: `cd ui && npx vitest run src/__tests__/WorkspacePreviewPanel.test.tsx src/__tests__/WorkspaceView.test.tsx src/__tests__/WorkspaceRightPanel.test.tsx`
Expected: All tests pass

- [ ] **Step 3: Run full test suite to check for regressions**

Run: `cd ui && npx vitest run`
Expected: All existing tests still pass

- [ ] **Step 4: Final commit (if any fixes needed)**

Only if earlier steps required fixes:
```bash
git add -A
git commit -m "fix: address test/type regressions from preview panel changes"
```
