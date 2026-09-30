import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// --- Mock sidebar context (desktop mode for header visibility) ---
const mockSidebarValue = {
  sidebarOpen: true,
  setSidebarOpen: vi.fn(),
  toggleSidebar: vi.fn(),
  isMobile: false,
  collapsed: false,
  setCollapsed: vi.fn(),
  toggleCollapse: vi.fn(),
};

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => mockSidebarValue,
}));

// --- Mock heavy child components so we only exercise the header ---
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
  WorkspaceRightPanel: (props: any) => (
    <div data-testid="mock-right-panel">
      <span data-testid="mock-ticket">{props.selectedIssueIdentifier}</span>
      <button type="button" data-testid="mock-settings" onClick={props.onOpenSettings}>Settings</button>
      <button type="button" data-testid="mock-archive" onClick={props.onOpenArchive}>Archive</button>
    </div>
  ),
}));

vi.mock("../components/workspace/DependencyChain", () => ({
  DependencyChain: () => null,
}));

vi.mock("../components/workspace/WorkspaceSettingsSheet", () => ({
  WorkspaceSettingsSheet: () => <div data-testid="workspace-settings-sheet" />,
}));

vi.mock("../components/workspace/ExecutionWorkspaceCloseDialog", () => ({
  ExecutionWorkspaceCloseDialog: () => <div data-testid="workspace-close-dialog" />,
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
  name: "feature-login",
  status: "active",
  cwd: "/repo/.aoa/worktrees/feature-login",
  repoUrl: null,
  baseRef: "main",
  branchName: "feature-login",
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

function renderLayout(selectedIssueIdentifier?: string | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkspaceLayout
          workspace={mockWorkspace as any}
          project={null}
          selectedIssueId={"issue-1"}
          selectedIssueIdentifier={selectedIssueIdentifier}
          onSelectIssue={vi.fn()}
          companyId="comp-1"
          companyPrefix="tc"
          onBack={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("WorkspaceLayout header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSidebarValue.isMobile = false;
  });

  it("removes the old top workspace strip", () => {
    renderLayout();
    expect(screen.queryByTestId("workspace-header")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-header-name")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-header-branch")).not.toBeInTheDocument();
  });

  it("delegates workspace actions to the right cockpit panel", async () => {
    const user = userEvent.setup();
    renderLayout();

    expect(screen.getByTestId("mock-ticket")).toBeEmptyDOMElement();
    await user.click(screen.getByTestId("mock-settings"));
    expect(await screen.findByTestId("workspace-settings-sheet")).toBeInTheDocument();
  });

  it("passes the selected ticket identifier to the cockpit header", () => {
    renderLayout("ENG-42");
    expect(screen.getByTestId("mock-ticket")).toHaveTextContent("ENG-42");
  });

  it("opens archive flow through the cockpit panel callback", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <WorkspaceLayout
            workspace={{ ...mockWorkspace, status: "archived" } as any}
            project={null}
            selectedIssueId={"issue-1"}
            selectedIssueIdentifier="ENG-42"
            onSelectIssue={vi.fn()}
            companyId="comp-1"
            companyPrefix="tc"
            onBack={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.click(screen.getByTestId("mock-archive"));

    expect(await screen.findByTestId("workspace-close-dialog")).toBeInTheDocument();
  });
});
