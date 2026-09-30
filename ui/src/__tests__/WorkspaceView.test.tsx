import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, Outlet, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect as reactUseEffect } from "react";
import {
  mockCompanyContext,
  mockBreadcrumbContext,
} from "./test-utils";
import { WorkspaceView } from "../pages/WorkspaceView";
import { useSidebar } from "../context/SidebarContext";

const workspaceTimelineMockState = vi.hoisted(() => ({
  shouldThrow: false,
}));

vi.mock("../components/workspace/WorkspaceTimeline", () => ({
  WorkspaceTimeline: ({ issueId }: { issueId: string }) => {
    if (workspaceTimelineMockState.shouldThrow) {
      throw new Error("Synthetic workspace timeline render failure");
    }
    return <div data-testid="workspace-timeline">Timeline for {issueId}</div>;
  },
}));

// ─── Mock data ────────────────────────────────────────────────────────────────

const mockWorkspace = {
  id: "ws-abc",
  companyId: "comp-1",
  projectId: "proj-1",
  projectWorkspaceId: null,
  sourceIssueId: "issue-1",
  mode: "isolated_workspace",
  strategyType: "git_worktree",
  name: "ENG-42-fix-auth",
  status: "active",
  cwd: "/tmp/workspaces/ENG-42",
  repoUrl: null,
  baseRef: "main",
  branchName: "ENG-42-fix-auth",
  providerType: "git_worktree",
  providerRef: null,
  derivedFromExecutionWorkspaceId: null,
  lastUsedAt: new Date("2026-04-01T10:00:00Z"),
  openedAt: new Date("2026-04-01T09:00:00Z"),
  closedAt: null,
  cleanupEligibleAt: null,
  cleanupReason: null,
  metadata: null,
  createdAt: new Date("2026-04-01T09:00:00Z"),
  updatedAt: new Date("2026-04-01T10:00:00Z"),
};

const mockProject = {
  id: "proj-1",
  name: "Engineering",
  type: "department",
  functionType: "software_development",
  status: "active",
  color: "#6366f1",
  description: "Engineering department",
  companyId: "comp-1",
  simpleId: "ENG",
  issuePrefix: "TC",
};

const mockIssue = {
  id: "issue-1",
  companyId: "comp-1",
  projectId: "proj-1",
  goalId: null,
  parentId: null,
  title: "Fix auth bug",
  description: null,
  status: "in_progress",
  priority: "high",
  assigneeAgentId: null,
  assigneeUserId: null,
  checkoutRunId: null,
  executionRunId: null,
  executionAgentNameKey: null,
  executionLockedAt: null,
  executionWorkspaceId: "ws-abc",
  executionWorkspacePreference: null,
  executionWorkspaceSettings: null,
  createdByAgentId: null,
  createdByUserId: null,
  issueNumber: 42,
  identifier: "ENG-42",
  requestDepth: 0,
  billingCode: null,
  assigneeAdapterOverrides: null,
  source: null,
  reviewerUserId: null,
  dueDate: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  hiddenAt: null,
  artifactId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockIssues = [
  mockIssue,
  {
    ...mockIssue,
    id: "issue-2",
    title: "Add new feature",
    identifier: "ENG-43",
    status: "todo",
    executionWorkspaceId: "ws-def",
  },
  {
    ...mockIssue,
    id: "issue-3",
    title: "No workspace task",
    identifier: "ENG-44",
    status: "backlog",
    executionWorkspaceId: null,
  },
  {
    ...mockIssue,
    id: "issue-4",
    title: "Done task with workspace",
    identifier: "ENG-45",
    status: "done",
    executionWorkspaceId: "ws-ghi",
  },
];

// ─── API Mocks ────────────────────────────────────────────────────────────────

const executionWorkspacesApiMock = {
  get: vi.fn().mockResolvedValue(mockWorkspace),
  list: vi.fn().mockResolvedValue([mockWorkspace]),
  runtimeServices: vi.fn().mockResolvedValue([]),
};

const mockArtifact = {
  id: "art-1",
  companyId: "comp-1",
  title: "Workspace summary",
  description: null,
  type: "document" as const,
  status: "active" as const,
  currentVersionId: "v-1",
  createdById: "agent-1",
  createdAt: new Date("2026-04-01T10:00:00Z"),
  updatedAt: new Date("2026-04-01T10:00:00Z"),
  versions: [
    {
      id: "v-1",
      artifactId: "art-1",
      versionNumber: 1,
      source: "agent" as const,
      sourceDetail: "Codex",
      changelog: null,
      parentVersionId: null,
      content: "# Workspace summary\n\nArtifact body",
      fileUrl: null,
      createdAt: new Date("2026-04-01T10:00:00Z"),
    },
  ],
};

const issuesApiMock = {
  get: vi.fn().mockResolvedValue(mockIssue),
  list: vi.fn().mockResolvedValue(mockIssues),
  listComments: vi.fn().mockResolvedValue([]),
  addComment: vi.fn().mockResolvedValue({ id: "c-1" }),
};

const projectsApiMock = {
  get: vi.fn().mockResolvedValue(mockProject),
};

const dependenciesApiMock = {
  list: vi.fn().mockResolvedValue({ upstream: [], downstream: [] }),
};

const activityApiMock = {
  runsForIssue: vi.fn().mockResolvedValue([]),
};

const heartbeatsApiMock = {
  liveRunsForIssue: vi.fn().mockResolvedValue([]),
  activeRunForIssue: vi.fn().mockResolvedValue(null),
  log: vi.fn().mockResolvedValue({ runId: "", store: "file", logRef: "", content: "" }),
};

const agentsApiMock = {
  list: vi.fn().mockResolvedValue([]),
  wakeup: vi.fn().mockResolvedValue(undefined),
};

const artifactsApiMock = {
  getByIssueId: vi.fn().mockResolvedValue(null),
  get: vi.fn().mockResolvedValue(null),
};

vi.mock("../api/dependencies", () => ({
  dependenciesApi: new Proxy(
    {},
    { get: (_t, prop) => (dependenciesApiMock as any)[prop] },
  ),
}));

vi.mock("../api/activity", () => ({
  activityApi: new Proxy(
    {},
    { get: (_t, prop) => (activityApiMock as any)[prop] },
  ),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: new Proxy(
    {},
    { get: (_t, prop) => (heartbeatsApiMock as any)[prop] },
  ),
}));

vi.mock("../api/agents", () => ({
  agentsApi: new Proxy(
    {},
    { get: (_t, prop) => (agentsApiMock as any)[prop] },
  ),
}));

vi.mock("../api/artifacts", () => ({
  artifactsApi: new Proxy(
    {},
    { get: (_t, prop) => (artifactsApiMock as any)[prop] },
  ),
}));

// Mock LiveRunWidget to avoid WebSocket dependencies
vi.mock("../components/LiveRunWidget", () => ({
  LiveRunWidget: ({ issueId }: { issueId: string }) => (
    <div data-testid="live-run-widget">Live runs for {issueId}</div>
  ),
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: new Proxy(
    {},
    { get: (_t, prop) => (executionWorkspacesApiMock as any)[prop] },
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: new Proxy(
    {},
    { get: (_t, prop) => (issuesApiMock as any)[prop] },
  ),
}));

vi.mock("../api/projects", () => ({
  projectsApi: new Proxy(
    {},
    { get: (_t, prop) => (projectsApiMock as any)[prop] },
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    ...mockCompanyContext,
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", issuePrefix: "TC", name: "Test Corp" },
    companies: [{ id: "comp-1", issuePrefix: "TC" }],
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn(), toasts: [], dismissToast: vi.fn(), clearToasts: vi.fn() }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbContext,
}));

function stripPanelProps(props: Record<string, unknown>) {
  const {
    defaultLayout,
    onLayoutChanged,
    onLayoutChange,
    defaultSize,
    minSize,
    maxSize,
    collapsible,
    collapsedSize,
    panelRef,
    ...domProps
  } = props;
  return domProps;
}

// Mock react-resizable-panels with simple divs
vi.mock("react-resizable-panels", () => ({
  Group: ({ children, ...props }: any) => {
    const domProps = stripPanelProps(props);
    return (
      <div data-testid={domProps["data-testid"] ?? "panel-group"} {...domProps}>
        {children}
      </div>
    );
  },
  Panel: ({ children, id, ...props }: any) => {
    const domProps = stripPanelProps(props);
    return (
      <div data-testid={domProps["data-testid"] ?? `panel-${id}`} id={id} {...domProps}>
        {children}
      </div>
    );
  },
  Separator: ({ id, ...props }: any) => {
    const domProps = stripPanelProps(props);
    return (
      <div
        data-testid={domProps["data-testid"] ?? `separator-${id}`}
        id={id}
        role="separator"
        {...domProps}
      />
    );
  },
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: vi.fn(),
    onLayoutChange: vi.fn(),
  }),
}));

// ─── Sidebar context mock ─────────────────────────────────────────────────────

const setCollapsedMock = vi.fn();

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    toggleSidebar: vi.fn(),
    isMobile: false,
    collapsed: false,
    setCollapsed: setCollapsedMock,
    toggleCollapse: vi.fn(),
  }),
}));

// ─── Layout stub with auto-collapse detection ─────────────────────────────────

function LayoutStub() {
  const location = useLocation();
  const { setCollapsed } = useSidebar();

  // Mirrors Layout.tsx behaviour
  reactUseEffect(() => {
    if (location.pathname.includes("/workspaces/")) {
      setCollapsed(true);
    }
  }, [location.pathname, setCollapsed]);

  return (
    <div data-testid="layout">
      <Outlet />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderWorkspaceView(workspaceId = "ws-abc", search = "") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/TC/workspaces/${workspaceId}${search}`]}>
        <Routes>
          <Route path=":companyPrefix" element={<LayoutStub />}>
            <Route path="workspaces/:workspaceId" element={<WorkspaceView />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  workspaceTimelineMockState.shouldThrow = false;
  executionWorkspacesApiMock.get.mockResolvedValue(mockWorkspace);
  issuesApiMock.get.mockResolvedValue(mockIssue);
  issuesApiMock.list.mockResolvedValue(mockIssues);
  projectsApiMock.get.mockResolvedValue(mockProject);
});

describe("WorkspaceView — route and page renders", () => {
  it("renders the workspace layout when data loads", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-layout")).toBeInTheDocument();
    });
  });

  it("fetches workspace by ID from route param", async () => {
    renderWorkspaceView("ws-abc");

    await waitFor(() => {
      expect(executionWorkspacesApiMock.get).toHaveBeenCalledWith("ws-abc");
    });
  });
});

describe("WorkspaceView — sidebar auto-collapse", () => {
  it("calls setCollapsed(true) when on workspace route", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      expect(setCollapsedMock).toHaveBeenCalledWith(true);
    });
  });
});

describe("WorkspaceView — three-panel layout", () => {
  it("shows a workspace error fallback when a panel render fails", async () => {
    workspaceTimelineMockState.shouldThrow = true;

    renderWorkspaceView();

    expect(await screen.findByTestId("workspace-render-error")).toBeInTheDocument();
    expect(screen.getByText("Workspace view hit a rendering issue")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy diagnostics/i })).toBeInTheDocument();
    expect(screen.getByTestId("workspace-layout")).toBeInTheDocument();
  });

  it("renders three panels: left nav, center, and right context", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-layout")).toBeInTheDocument();
    });

    expect(screen.getByTestId("workspace-left-panel")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-center-group")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-right-panel")).toBeInTheDocument();
  });

  it("renders resizable handle only when preview mode is active", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-layout")).toBeInTheDocument();
    });

    // Handle not present by default (preview mode is off)
    expect(screen.queryByTestId("workspace-resizable-handle")).not.toBeInTheDocument();
  });

  it("opens a browser preview tab from a running workspace service", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValue([
      {
        id: "svc-1",
        serviceName: "web",
        status: "running",
        port: 3100,
        url: "http://localhost:3100",
        previewUrl: "/preview/services/svc-1/",
        previewAccess: "local",
        localTargetUrl: "http://localhost:3100/",
        healthStatus: "healthy",
        command: "pnpm dev",
        cwd: "/tmp/workspaces/ENG-42",
        provider: "local_process",
        lifecycle: "shared",
        startedAt: "2026-04-04T10:00:00Z",
        stoppedAt: null,
      },
    ]);

    renderWorkspaceView();

    fireEvent.click(await screen.findByTestId("cockpit-section-trigger-services"));
    fireEvent.click(await screen.findByTestId("service-open-svc-1"));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-resizable-handle")).toBeInTheDocument();
      expect(screen.getByTestId("workspace-preview-tabs")).toBeInTheDocument();
    });

    expect(screen.getByTestId("workspace-left-panel")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("workspace-right-panel")).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByRole("tab", { name: /web/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("preview-browser-iframe")).toHaveAttribute("src", "/preview/services/svc-1/");
  });

  it("uses the center header control to show and hide the preview panel without clearing tabs", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-preview-toggle")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-preview-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-resizable-handle")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /viewer/i })).toHaveAttribute("aria-selected", "true");
    });

    expect(screen.getByTestId("workspace-left-panel")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("workspace-right-panel")).toHaveAttribute("data-collapsed", "true");

    fireEvent.click(screen.getByTestId("workspace-preview-toggle"));

    await waitFor(() => {
      expect(screen.queryByTestId("workspace-resizable-handle")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-preview-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-resizable-handle")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /viewer/i })).toHaveAttribute("aria-selected", "true");
    });

    expect(screen.getByTestId("workspace-left-panel")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("workspace-right-panel")).toHaveAttribute("data-collapsed", "true");
  });

  it("uses a consistent 42px chrome height across workspace panel headers", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-preview-toggle")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-preview-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-preview-tabs")).toBeInTheDocument();
    });

    const headerIds = [
      "workspace-task-nav-header",
      "workspace-center-header",
      "workspace-preview-tabs",
      "workspace-cockpit-header",
    ];

    for (const id of headerIds) {
      expect(screen.getByTestId(id).className).toContain("h-[42px]");
    }
  });

  it("opens an artifact preview tab from the artifacts section", async () => {
    artifactsApiMock.getByIssueId.mockResolvedValue(mockArtifact);

    renderWorkspaceView();

    fireEvent.click(await screen.findByTestId("cockpit-section-trigger-artifacts"));
    fireEvent.click(await screen.findByTestId("artifact-row"));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-resizable-handle")).toBeInTheDocument();
      expect(screen.getByTestId("workspace-preview-tabs")).toBeInTheDocument();
    });

    expect(screen.getByTestId("workspace-left-panel")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("workspace-right-panel")).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByRole("tab", { name: /workspace summary/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("preview-artifact-tab")).toBeInTheDocument();
    expect(screen.getByTestId("work-product-markdown")).toHaveTextContent("Artifact body");
  });

  it("renders timeline in center panel and right panel sections", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-timeline")).toBeInTheDocument();
    });

    // Right panel now has real sections instead of placeholder
    expect(screen.getByTestId("workspace-right-panel")).toBeInTheDocument();
  });
});

describe("WorkspaceView — left panel task navigator", () => {
  it("renders the task navigator", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-task-nav")).toBeInTheDocument();
    });
  });

  it("shows tasks grouped by status (only tasks with workspaces)", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      // ENG-42 is in_progress (Running group)
      expect(screen.getByText("Fix auth bug")).toBeInTheDocument();
      // ENG-43 is todo (Idle group)
      expect(screen.getByText("Add new feature")).toBeInTheDocument();
    });

    // ENG-44 has no workspace → should NOT appear
    expect(screen.queryByText("No workspace task")).not.toBeInTheDocument();
  });

  it("shows group labels for non-empty groups", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      const nav = screen.getByTestId("workspace-task-nav");
      expect(within(nav).getByText("Running")).toBeInTheDocument();
      expect(within(nav).getByText("Idle")).toBeInTheDocument();
    });
  });

  it("shows Completed group collapsed by default (with a done workspace task)", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      // Completed group header should be present but tasks collapsed
      expect(screen.getByTestId("workspace-group-completed")).toBeInTheDocument();
    });

    // The done task's title should not be visible (group is collapsed)
    expect(screen.queryByText("Done task with workspace")).not.toBeInTheDocument();
  });

  it("highlights the selected task", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      expect(screen.getByTestId(`workspace-task-row-issue-1`)).toBeInTheDocument();
    });

    const row = screen.getByTestId("workspace-task-row-issue-1");
    // The selected task (sourceIssueId = issue-1) should have accent styling
    expect(row.className).toMatch(/bg-accent/);
  });

  it("clicking a task updates selected task", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-task-row-issue-2")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-task-row-issue-2"));

    await waitFor(() => {
      const row2 = screen.getByTestId("workspace-task-row-issue-2");
      expect(row2.className).toMatch(/bg-accent/);
    });
  });

  it("navigates to a task's workspace when selecting a task from another workspace", async () => {
    function LocationDisplay() {
      const location = useLocation();
      return <div data-testid="location">{location.pathname}{location.search}</div>;
    }

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/TC/workspaces/ws-abc"]}>
          <Routes>
            <Route path=":companyPrefix" element={<LayoutStub />}>
              <Route path="workspaces/:workspaceId" element={<WorkspaceView />} />
            </Route>
          </Routes>
          <LocationDisplay />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("workspace-task-row-issue-2")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-task-row-issue-2"));

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/TC/workspaces/ws-def?issue=issue-2");
    });
  });

  it("honors the selected issue query param on workspace load", async () => {
    renderWorkspaceView("ws-abc", "?issue=issue-2");

    await waitFor(() => {
      const row2 = screen.getByTestId("workspace-task-row-issue-2");
      expect(row2.className).toMatch(/bg-accent/);
    });
  });

  it("filters tasks by search input", async () => {
    renderWorkspaceView();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-task-search")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("workspace-task-search"), {
      target: { value: "auth" },
    });

    await waitFor(() => {
      expect(screen.getByText("Fix auth bug")).toBeInTheDocument();
      expect(screen.queryByText("Add new feature")).not.toBeInTheDocument();
    });
  });
});

describe("WorkspaceView — navigation", () => {
  it("sets breadcrumbs with correct department and task links", async () => {
    renderWorkspaceView();

    // Wait for data to load and breadcrumbs to be set with full info
    await waitFor(() => {
      const calls = mockBreadcrumbContext.setBreadcrumbs.mock.calls;
      const hasFullBreadcrumbs = calls.some(
        (call: any) => call[0].length === 3 && call[0][0].label === "Engineering",
      );
      expect(hasFullBreadcrumbs).toBe(true);
    });

    const calls = mockBreadcrumbContext.setBreadcrumbs.mock.calls;
    const fullCall = calls.find(
      (call: any) => call[0].length === 3 && call[0][0].label === "Engineering",
    )![0];
    // Department breadcrumb links to project page (prefix-free; auto-applied by router)
    expect(fullCall[0]).toEqual({
      label: "Engineering",
      href: "/projects/proj-1",
    });
    // Task breadcrumb links to issues page with selected param
    expect(fullCall[1]).toEqual({
      label: "ENG-42",
      href: "/issues?selected=issue-1",
    });
    // Workspace label (no link)
    expect(fullCall[2]).toEqual({
      label: "ENG-42-fix-auth",
    });
  });

  it("uses the department name as the back label and navigates to project page", async () => {
    // We'll render with a LocationDisplay helper to verify the navigate call
    function LocationDisplay() {
      const location = useLocation();
      return <div data-testid="location">{location.pathname}</div>;
    }

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/TC/workspaces/ws-abc"]}>
          <Routes>
            <Route path=":companyPrefix" element={<LayoutStub />}>
              <Route path="workspaces/:workspaceId" element={<WorkspaceView />} />
              <Route path="projects/:projectId" element={<div data-testid="project-page">Project</div>} />
            </Route>
          </Routes>
          <LocationDisplay />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("workspace-layout")).toBeInTheDocument();
    });

    const backButton = screen.getByTestId("workspace-back-btn");
    expect(backButton).toHaveTextContent("Engineering");
    expect(screen.queryByText("Back to Department")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-department-label")).not.toBeInTheDocument();
    fireEvent.click(backButton);

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/TC/projects/proj-1");
    });
  });

  it("centers icons in the collapsed left task rail", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/TC/workspaces/ws-abc"]}>
          <Routes>
            <Route path=":companyPrefix" element={<LayoutStub />}>
              <Route path="workspaces/:workspaceId" element={<WorkspaceView />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("workspace-layout")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-task-nav-collapse"));
    const collapsedRail = screen.getByTestId("workspace-task-nav-collapsed");
    expect(collapsedRail.className).toContain("items-center");
    expect(collapsedRail.className).not.toContain("items-start");
  });
});
