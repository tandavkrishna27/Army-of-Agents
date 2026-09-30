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

vi.mock("../context/SidebarContext", () => ({
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
  Panel: ({ children, ...props }: any) => <div data-testid={props["data-testid"]}>{children}</div>,
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

  it("does NOT render desktop panels on mobile", () => {
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

  it("renders desktop panels (no tab bar)", () => {
    renderLayout();

    expect(screen.getByTestId("workspace-left-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-mobile-tabs")).not.toBeInTheDocument();
  });

  it("shows archived banner on desktop too", () => {
    renderLayout({ workspace: { status: "archived" } });

    expect(screen.getByTestId("workspace-archived-banner")).toBeInTheDocument();
  });
});
