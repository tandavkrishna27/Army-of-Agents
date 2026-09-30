# Git Panel + Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace placeholder Git and Terminal tools in the workspace right panel with functional components showing branch/repo/PR info and run output.

**Architecture:** GitPanel displays static workspace data (branch, base ref, repo URL, PR status) from the already-fetched ExecutionWorkspace record. TerminalPanel renders run stdout/stderr into an xterm.js instance in read-only mode, fetching via heartbeatsApi. Both are rendered as collapsible sub-sections within the existing ToolsSection.

**Tech Stack:** React, @xterm/xterm, React Query, existing heartbeatsApi/activityApi, Vitest + Testing Library

---

### Task 1: Install @xterm/xterm dependency

**Files:**
- Modify: `ui/package.json`

- [ ] **Step 1: Install the package**

```bash
cd ui && pnpm add @xterm/xterm
```

- [ ] **Step 2: Verify installation**

```bash
cd ui && node -e "require.resolve('@xterm/xterm')" && echo "OK"
```

Expected: prints resolved path and "OK"

- [ ] **Step 3: Commit**

```bash
git add ui/package.json ui/pnpm-lock.yaml
git commit -m "chore: add @xterm/xterm dependency"
```

---

### Task 2: GitPanel component + tests

**Files:**
- Create: `ui/src/components/workspace/tools/GitPanel.tsx`
- Create: `ui/src/__tests__/GitPanel.test.tsx`

- [ ] **Step 1: Write GitPanel tests**

Create `ui/src/__tests__/GitPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitPanel } from "../components/workspace/tools/GitPanel";

// Mock clipboard API
const writeText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText } });

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    companyId: "comp-1",
    projectId: "proj-1",
    projectWorkspaceId: null,
    sourceIssueId: "issue-1",
    mode: "isolated_workspace" as const,
    strategyType: "git_worktree" as const,
    name: "ENG-99-fix-auth",
    status: "active" as const,
    cwd: "/tmp/ws/ENG-99",
    repoUrl: "https://github.com/acme/repo",
    baseRef: "main",
    branchName: "ENG-99-fix-auth",
    providerType: "git_worktree" as const,
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
    ...overrides,
  };
}

describe("GitPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders branch name, base ref, and repo URL", () => {
    render(<GitPanel workspace={makeWorkspace() as any} />);

    expect(screen.getByText("ENG-99-fix-auth")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /github\.com/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/repo",
    );
  });

  it("copy button copies branch name to clipboard", async () => {
    const user = userEvent.setup();
    render(<GitPanel workspace={makeWorkspace() as any} />);

    const copyBtn = screen.getByTestId("copy-branch-btn");
    await user.click(copyBtn);

    expect(writeText).toHaveBeenCalledWith("ENG-99-fix-auth");
  });

  it("shows 'No PR created' when metadata.pr is absent", () => {
    render(<GitPanel workspace={makeWorkspace() as any} />);
    expect(screen.getByText("No PR created")).toBeInTheDocument();
  });

  it("renders PR badge and link when metadata.pr is present", () => {
    const ws = makeWorkspace({
      metadata: {
        pr: { url: "https://github.com/acme/repo/pull/42", status: "open", number: 42 },
      },
    });
    render(<GitPanel workspace={ws as any} />);

    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /#42/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/repo/pull/42",
    );
  });

  it("hides repo URL row when repoUrl is null", () => {
    render(<GitPanel workspace={makeWorkspace({ repoUrl: null }) as any} />);
    expect(screen.queryByTestId("repo-url-row")).not.toBeInTheDocument();
  });

  it("hides branch row when branchName is null", () => {
    render(<GitPanel workspace={makeWorkspace({ branchName: null }) as any} />);
    expect(screen.queryByTestId("branch-row")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ui && npx vitest run src/__tests__/GitPanel.test.tsx
```

Expected: FAIL — cannot resolve `../components/workspace/tools/GitPanel`

- [ ] **Step 3: Implement GitPanel**

Create `ui/src/components/workspace/tools/GitPanel.tsx`:

```tsx
import { useState } from "react";
import { GitBranch, Copy, Check, ExternalLink, GitPullRequest } from "lucide-react";
import type { ExecutionWorkspace } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

interface GitPanelProps {
  workspace: ExecutionWorkspace;
}

interface PrMetadata {
  url: string;
  status: string;
  number: number;
}

const prStatusColor: Record<string, string> = {
  open: "bg-green-500/15 text-green-400",
  merged: "bg-purple-500/15 text-purple-400",
  closed: "bg-red-500/15 text-red-400",
};

export function GitPanel({ workspace }: GitPanelProps) {
  const [copied, setCopied] = useState(false);
  const pr = (workspace.metadata as Record<string, unknown> | null)?.pr as PrMetadata | undefined;

  const handleCopy = async () => {
    if (!workspace.branchName) return;
    await navigator.clipboard.writeText(workspace.branchName);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-2 text-sm" data-testid="git-panel">
      {/* Branch */}
      {workspace.branchName && (
        <div className="flex items-center gap-2" data-testid="branch-row">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="font-mono text-xs truncate">{workspace.branchName}</span>
          <button
            onClick={handleCopy}
            className="ml-auto shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
            data-testid="copy-branch-btn"
            title={copied ? "Copied!" : "Copy branch name"}
          >
            {copied ? (
              <Check className="h-3 w-3 text-green-400" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
        </div>
      )}

      {/* Base ref */}
      {workspace.baseRef && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="base-ref-row">
          <span className="ml-5.5">from</span>
          <span className="font-mono">{workspace.baseRef}</span>
        </div>
      )}

      {/* Repo URL */}
      {workspace.repoUrl && (
        <div className="flex items-center gap-2" data-testid="repo-url-row">
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          {workspace.repoUrl.startsWith("http") ? (
            <a
              href={workspace.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:underline truncate"
            >
              {workspace.repoUrl.replace(/^https?:\/\//, "")}
            </a>
          ) : (
            <span className="text-xs text-muted-foreground truncate">{workspace.repoUrl}</span>
          )}
        </div>
      )}

      {/* PR status */}
      <div className="flex items-center gap-2" data-testid="pr-row">
        <GitPullRequest className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {pr ? (
          <div className="flex items-center gap-1.5">
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:underline"
            >
              #{pr.number}
            </a>
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                prStatusColor[pr.status] ?? "bg-muted text-muted-foreground",
              )}
            >
              {pr.status}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">No PR created</span>
        )}
      </div>

      {/* Create PR — placeholder */}
      <button
        disabled
        className="w-full mt-1 text-xs py-1.5 rounded-md border border-dashed border-muted-foreground/30 text-muted-foreground cursor-not-allowed"
        title="Coming soon"
      >
        Create PR
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ui && npx vitest run src/__tests__/GitPanel.test.tsx
```

Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/workspace/tools/GitPanel.tsx ui/src/__tests__/GitPanel.test.tsx
git commit -m "feat: git panel component with branch, repo, and PR info"
```

---

### Task 3: TerminalPanel component + tests

**Files:**
- Create: `ui/src/components/workspace/tools/TerminalPanel.tsx`
- Create: `ui/src/__tests__/TerminalPanel.test.tsx`

- [ ] **Step 1: Write TerminalPanel tests**

Create `ui/src/__tests__/TerminalPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock xterm BEFORE importing TerminalPanel
const mockTerminal = {
  open: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
  loadAddon: vi.fn(),
  onData: vi.fn(),
};

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(() => mockTerminal),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(() => ({
    fit: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// Mock CSS import
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const mockLiveRuns = vi.fn().mockResolvedValue([]);
const mockLog = vi.fn().mockResolvedValue({ runId: "r1", store: "memory", logRef: "", content: "", nextOffset: undefined });
const mockEvents = vi.fn().mockResolvedValue([]);
const mockRunsForIssue = vi.fn().mockResolvedValue([]);

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForIssue: (...args: unknown[]) => mockLiveRuns(...args),
    log: (...args: unknown[]) => mockLog(...args),
    events: (...args: unknown[]) => mockEvents(...args),
  },
}));

vi.mock("@/api/activity", () => ({
  activityApi: {
    runsForIssue: (...args: unknown[]) => mockRunsForIssue(...args),
  },
}));

import { TerminalPanel } from "../components/workspace/tools/TerminalPanel";

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("TerminalPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveRuns.mockResolvedValue([]);
    mockRunsForIssue.mockResolvedValue([]);
  });

  it("shows placeholder when no runs exist", async () => {
    renderWithQuery(<TerminalPanel issueId="issue-1" companyId="comp-1" />);

    await waitFor(() => {
      expect(screen.getByText("No run output yet")).toBeInTheDocument();
    });
  });

  it("creates xterm and writes log content for a completed run", async () => {
    mockLiveRuns.mockResolvedValue([]);
    mockRunsForIssue.mockResolvedValue([
      { runId: "run-1", status: "completed", agentId: "a1", startedAt: null, finishedAt: "2026-04-01T10:00:00Z", createdAt: "2026-04-01T09:00:00Z", invocationSource: "comment", usageJson: null, resultJson: null },
    ]);
    mockLog.mockResolvedValue({ runId: "run-1", store: "memory", logRef: "", content: "Hello world\nDone.", nextOffset: undefined });

    renderWithQuery(<TerminalPanel issueId="issue-1" companyId="comp-1" />);

    await waitFor(() => {
      expect(mockTerminal.open).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockTerminal.write).toHaveBeenCalledWith("Hello world\nDone.");
    });
  });

  it("disposes terminal on unmount", async () => {
    mockRunsForIssue.mockResolvedValue([
      { runId: "run-1", status: "completed", agentId: "a1", startedAt: null, finishedAt: "2026-04-01T10:00:00Z", createdAt: "2026-04-01T09:00:00Z", invocationSource: "comment", usageJson: null, resultJson: null },
    ]);
    mockLog.mockResolvedValue({ runId: "run-1", store: "memory", logRef: "", content: "x", nextOffset: undefined });

    const { unmount } = renderWithQuery(<TerminalPanel issueId="issue-1" companyId="comp-1" />);

    await waitFor(() => {
      expect(mockTerminal.open).toHaveBeenCalled();
    });

    unmount();
    expect(mockTerminal.dispose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ui && npx vitest run src/__tests__/TerminalPanel.test.tsx
```

Expected: FAIL — cannot resolve `../components/workspace/tools/TerminalPanel`

- [ ] **Step 3: Implement TerminalPanel**

Create `ui/src/components/workspace/tools/TerminalPanel.tsx`:

```tsx
import { useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { heartbeatsApi } from "@/api/heartbeats";
import { activityApi } from "@/api/activity";
import { queryKeys } from "@/lib/queryKeys";

interface TerminalPanelProps {
  issueId: string;
  companyId: string;
}

export function TerminalPanel({ issueId, companyId }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const afterSeqRef = useRef(0);
  const activeRunIdRef = useRef<string | null>(null);

  // Fetch live runs (reuses existing query key so no duplicate polling)
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    refetchInterval: 3000,
  });

  // Fetch historical runs as fallback
  const { data: historicalRuns } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    enabled: !liveRuns?.length,
  });

  // Determine which run to show
  const latestLiveRun = liveRuns?.[0] ?? null;
  const latestHistoricalRun = historicalRuns?.[0] ?? null;
  const currentRunId = latestLiveRun?.id ?? latestHistoricalRun?.runId ?? null;
  const isRunning = latestLiveRun?.status === "running" || latestLiveRun?.status === "starting";

  // Init xterm
  const initTerminal = useCallback(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({
      disableStdin: true,
      fontSize: 12,
      fontFamily: "monospace",
      convertEol: true,
      scrollback: 5000,
      theme: { background: "#00000000" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
  }, []);

  // Cleanup xterm
  useEffect(() => {
    return () => {
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => fitRef.current?.fit());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Fetch and write output when run changes or is active
  useEffect(() => {
    if (!currentRunId) return;

    // If run changed, clear terminal and reset seq
    if (activeRunIdRef.current !== currentRunId) {
      activeRunIdRef.current = currentRunId;
      afterSeqRef.current = 0;
      termRef.current?.clear();
      initTerminal();
    }

    if (!termRef.current) {
      initTerminal();
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    if (isRunning) {
      // Stream events for active runs
      const fetchEvents = async () => {
        if (cancelled) return;
        try {
          const events = await heartbeatsApi.events(currentRunId, afterSeqRef.current);
          if (cancelled || !termRef.current) return;
          for (const evt of events) {
            if (evt.stream === "stdout" || evt.stream === "stderr") {
              termRef.current.write(evt.message ?? "");
            }
            afterSeqRef.current = evt.seq + 1;
          }
        } catch {
          // ignore fetch errors during polling
        }
      };
      fetchEvents();
      intervalId = setInterval(fetchEvents, 2000);
    } else {
      // Fetch full log for completed runs
      const fetchLog = async () => {
        if (cancelled || !termRef.current) return;
        try {
          let offset = 0;
          let hasMore = true;
          while (hasMore && !cancelled) {
            const result = await heartbeatsApi.log(currentRunId, offset);
            if (cancelled || !termRef.current) return;
            if (result.content) {
              termRef.current.write(result.content);
            }
            hasMore = result.nextOffset !== undefined;
            offset = result.nextOffset ?? 0;
          }
        } catch {
          // ignore
        }
      };
      fetchLog();
    }

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [currentRunId, isRunning, initTerminal]);

  if (!currentRunId) {
    return (
      <div className="flex items-center justify-center h-[200px] text-xs text-muted-foreground" data-testid="terminal-empty">
        No run output yet
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-[200px] overflow-hidden rounded-md"
      data-testid="terminal-container"
    />
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ui && npx vitest run src/__tests__/TerminalPanel.test.tsx
```

Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/workspace/tools/TerminalPanel.tsx ui/src/__tests__/TerminalPanel.test.tsx
git commit -m "feat: terminal panel component with xterm run output display"
```

---

### Task 4: Wire GitPanel + TerminalPanel into ToolsSection and data flow

**Files:**
- Modify: `ui/src/components/workspace/sections/ToolsSection.tsx`
- Modify: `ui/src/components/workspace/WorkspaceRightPanel.tsx`
- Modify: `ui/src/components/workspace/WorkspaceLayout.tsx`

- [ ] **Step 1: Update ToolsSection to render real panels**

Replace the full content of `ui/src/components/workspace/sections/ToolsSection.tsx`:

```tsx
import { useState } from "react";
import { GitBranch, Terminal, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExecutionWorkspace } from "@armyofagents/shared";
import { GitPanel } from "../tools/GitPanel";
import { TerminalPanel } from "../tools/TerminalPanel";

interface ToolsSectionProps {
  functionType: string | null;
  workspace?: ExecutionWorkspace;
  issueId?: string;
  companyId?: string;
}

export function ToolsSection({ functionType, workspace, issueId, companyId }: ToolsSectionProps) {
  const [gitOpen, setGitOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(true);

  if (functionType !== "software_development") {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground" data-testid="tools-empty">
        No tools configured for this department type
      </div>
    );
  }

  return (
    <div className="space-y-1 px-3" data-testid="tools-dev">
      {/* Git sub-section */}
      <div>
        <button
          onClick={() => setGitOpen(!gitOpen)}
          className="flex items-center gap-1.5 w-full py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          data-testid="git-toggle"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", gitOpen && "rotate-90")} />
          <GitBranch className="h-3.5 w-3.5" />
          Git
        </button>
        {gitOpen && workspace && (
          <div className="ml-5 pb-2">
            <GitPanel workspace={workspace} />
          </div>
        )}
      </div>

      {/* Terminal sub-section */}
      <div>
        <button
          onClick={() => setTerminalOpen(!terminalOpen)}
          className="flex items-center gap-1.5 w-full py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          data-testid="terminal-toggle"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", terminalOpen && "rotate-90")} />
          <Terminal className="h-3.5 w-3.5" />
          Terminal
        </button>
        {terminalOpen && issueId && companyId && (
          <div className="pb-2">
            <TerminalPanel issueId={issueId} companyId={companyId} />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update WorkspaceRightPanel to pass workspace data to ToolsSection**

In `ui/src/components/workspace/WorkspaceRightPanel.tsx`, make these changes:

1. Add `ExecutionWorkspace` import and `workspace` prop:

```tsx
// Add to imports
import type { ExecutionWorkspace } from "@armyofagents/shared";

// Update interface — replace workspaceId with workspace
interface WorkspaceRightPanelProps {
  issueId: string;
  companyId: string;
  companyPrefix: string;
  workspace: ExecutionWorkspace;
  functionType: string | null;
  onPreviewArtifact?: (artifact: ArtifactWithVersions, version: ArtifactVersion) => void;
}
```

2. Update the function signature to destructure `workspace` instead of `workspaceId`:

```tsx
export function WorkspaceRightPanel({
  issueId,
  companyId,
  companyPrefix,
  workspace,
  functionType,
  onPreviewArtifact,
}: WorkspaceRightPanelProps) {
```

3. Update ToolsSection usage (around line 111-112):

```tsx
{section.name === "tools" && (
  <ToolsSection
    functionType={functionType}
    workspace={workspace}
    issueId={issueId}
    companyId={companyId}
  />
)}
```

4. Update NotesSection usage to use `workspace.id`:

```tsx
{section.name === "notes" && (
  <NotesSection workspaceId={workspace.id} />
)}
```

- [ ] **Step 3: Update WorkspaceLayout to pass workspace object to WorkspaceRightPanel**

In `ui/src/components/workspace/WorkspaceLayout.tsx`, change the WorkspaceRightPanel render (around line 138-145):

```tsx
<WorkspaceRightPanel
  issueId={selectedIssueId}
  companyId={companyId}
  companyPrefix={companyPrefix}
  workspace={workspace}
  functionType={project?.functionType ?? null}
  onPreviewArtifact={handlePreviewArtifact}
/>
```

This replaces the old `workspaceId={workspace.id}` prop.

- [ ] **Step 4: Run existing tests to check for regressions**

```bash
cd ui && npx vitest run --reporter=verbose 2>&1 | tail -30
```

Expected: all existing tests pass (the WorkspaceRightPanel tests may need updating if they mock the `workspaceId` prop — change to `workspace` with a full mock object)

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/workspace/sections/ToolsSection.tsx ui/src/components/workspace/WorkspaceRightPanel.tsx ui/src/components/workspace/WorkspaceLayout.tsx
git commit -m "feat: wire git panel and terminal into workspace tools section"
```

---

### Task 5: Manual verification

- [ ] **Step 1: Start the dev server**

```bash
cd ui && pnpm dev
```

- [ ] **Step 2: Verify in browser**

1. Navigate to a Software Development department workspace
2. Expand the "Tools" section in the right panel
3. Verify Git sub-section shows branch name, base ref, repo URL (if set)
4. Verify Terminal sub-section shows run output or "No run output yet"
5. Click copy button on branch name — verify clipboard copy works
6. Collapse/expand Git and Terminal sub-sections
7. Navigate to a non-software-development workspace — verify "No tools configured" message

- [ ] **Step 3: Run the full test suite**

```bash
cd ui && npx vitest run
```

Expected: all tests pass

- [ ] **Step 4: Final commit (if any fixes were needed)**

```bash
git add -A && git commit -m "fix: address issues found during manual verification"
```
