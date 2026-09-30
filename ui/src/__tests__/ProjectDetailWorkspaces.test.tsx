// NOTE: under heavy parallel-suite CPU contention these ProjectDetail* test
// files occasionally flake at synchronous `expect(screen.getByText(...))`
// assertions placed after a single `waitFor`. The project query resolves
// before the executionWorkspaces query, so the tab shell renders but the
// row content is still loading when the sync assertion fires. Prefer
// `await screen.findByText(...)` for every row-level assertion here so
// the retry loop handles that gap. Each suite (Board, Discussions,
// Workspaces) needs the same treatment as rows are added.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// These tests render a multi-query page; give enough headroom for slow CI runs.
vi.setConfig({ testTimeout: 15000 });
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  mockCompanyContext,
  mockBreadcrumbContext,
  mockDialogContext,
} from "./test-utils";
import { ProjectDetail } from "../pages/ProjectDetail";

// --- Mock data ---

const mockProject = {
  id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  name: "Engineering",
  type: "department",
  status: "active",
  color: "#6366f1",
  description: "Engineering department",
  targetDate: null,
  companyId: "comp-1",
  issuePrefix: "TC",
  simpleId: "ENG",
  // Intentionally NOT "software_development" here: the workspace-list tests
  // (ENG-99-fix-auth, archive, etc.) rely on ProjectWorkspaces rendering.
  // For software_development the Workspaces tab renders GitCommandCentre instead.
  // Individual tests that need software_development override via mockResolvedValue.
  functionType: null as string | null,
  goalIds: [],
  goalId: null,
  goals: [],
  workspaces: [],
  leadAgentId: null,
  createdAt: "2026-04-01T09:00:00Z",
  updatedAt: "2026-04-01T10:00:00Z",
  executionWorkspacePolicy: {
    enabled: true,
    defaultMode: "isolated_workspace",
    allowIssueOverride: true,
    workspaceStrategy: { type: "git_worktree", baseRef: "main" },
  },
};

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    companyId: "comp-1",
    projectId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    projectWorkspaceId: null,
    sourceIssueId: "issue-99",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "ENG-99-fix-auth",
    status: "active",
    cwd: "/tmp/workspaces/ENG-99",
    repoUrl: null,
    baseRef: "main",
    branchName: "ENG-99-fix-auth",
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
    ...overrides,
  };
}

const mockWorkspaces = [
  makeWorkspace(),
  makeWorkspace({
    id: "ws-2",
    name: "ENG-100-new-feature",
    branchName: "ENG-100-new-feature",
    sourceIssueId: "issue-100",
    status: "idle",
    mode: "shared_workspace",
    lastUsedAt: new Date("2026-03-30T15:00:00Z"),
  }),
];

// --- Mocks ---

const executionWorkspacesApiMock = {
  list: vi.fn().mockResolvedValue(mockWorkspaces),
  update: vi.fn().mockResolvedValue({}),
  getCloseReadiness: vi.fn().mockResolvedValue({
    workspaceId: "ws-1",
    state: "ready",
    blockingReasons: [],
    warnings: [],
    linkedIssues: [],
    plannedActions: [
      {
        kind: "archive_record",
        label: "Archive workspace record",
        description: "Keep the execution workspace history.",
        command: null,
      },
    ],
    isDestructiveCloseAllowed: true,
    isSharedWorkspace: false,
    isProjectPrimaryWorkspace: false,
    git: null,
    runtimeServices: [],
  }),
};

const projectsApiMock = {
  get: vi.fn().mockResolvedValue(mockProject),
  update: vi.fn().mockResolvedValue(mockProject),
  listAgents: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([mockProject]),
  budget: vi.fn().mockResolvedValue({ agents: [], totalSpendCents: 0 }),
  assignAgent: vi.fn(),
  unassignAgent: vi.fn(),
  createWorkspace: vi.fn().mockResolvedValue({}),
  updateWorkspace: vi.fn().mockResolvedValue({}),
  removeWorkspace: vi.fn().mockResolvedValue({}),
  getEnvironment: vi.fn().mockResolvedValue({ env: null }),
  updateEnvironment: vi.fn().mockResolvedValue({ env: null }),
};

vi.mock("../components/TaskSlideOver", () => ({
  TaskSlideOver: () => null,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: new Proxy(
    {},
    { get: (_t, prop) => (executionWorkspacesApiMock as any)[prop] },
  ),
}));

vi.mock("../api/projects", () => ({
  projectsApi: new Proxy(
    {},
    { get: (_t, prop) => (projectsApiMock as any)[prop] },
  ),
}));

vi.mock("../api/filesystem", () => ({
  filesystemApi: {
    home: vi.fn().mockResolvedValue({ homePath: "C:\\Work", platform: "win32" }),
    drives: vi.fn().mockResolvedValue({ drives: [{ name: "C:", path: "C:\\" }], platform: "win32" }),
    browse: vi.fn().mockResolvedValue({
      currentPath: "C:\\Work",
      parentPath: "C:\\",
      homePath: "C:\\Work",
      platform: "win32",
      entries: [{ name: "Repo", path: "C:\\Work\\Repo", type: "directory", isGitRepo: true }],
    }),
    mkdir: vi.fn().mockResolvedValue({ path: "C:\\Work\\New" }),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/goals", () => ({
  goalsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

vi.mock("../api/discussions", () => ({
  discussionsApi: {
    list: vi.fn().mockResolvedValue({ discussions: [], total: 0, limit: 20, offset: 0 }),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    ...mockCompanyContext,
    selectedCompanyId: "comp-1",
    companies: [{ id: "comp-1", issuePrefix: "TC" }],
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbContext,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => mockDialogContext,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn(), toasts: [], dismissToast: vi.fn(), clearToasts: vi.fn() }),
}));

vi.mock("../lib/utils", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    projectRouteRef: (p: any) => p.simpleId ?? p.id,
  };
});

function renderProjectDetail(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="projects/:projectId/workspaces" element={<ProjectDetail />} />
          <Route path="projects/:projectId/settings" element={<ProjectDetail />} />
          <Route path="projects/:projectId/discussions" element={<ProjectDetail />} />
          <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
          <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
          <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
          <Route path="projects/:projectId/goals" element={<ProjectDetail />} />
          <Route path="projects/:projectId/team" element={<ProjectDetail />} />
          <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
          <Route path="projects/:projectId" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // clearAllMocks resets call history without wiping implementations set in
  // vi.mock() factories (goalsApi, agentsApi, issuesApi, etc.).  Any mock
  // whose implementation varies per-test is explicitly re-established below.
  vi.clearAllMocks();
  // Re-establish implementations that individual tests may override.
  executionWorkspacesApiMock.list.mockResolvedValue(mockWorkspaces);
  executionWorkspacesApiMock.update.mockResolvedValue({});
  executionWorkspacesApiMock.getCloseReadiness.mockResolvedValue({
    workspaceId: "ws-1",
    state: "ready",
    blockingReasons: [],
    warnings: [],
    linkedIssues: [],
    plannedActions: [
      {
        kind: "archive_record",
        label: "Archive workspace record",
        description: "Keep the execution workspace history.",
        command: null,
      },
    ],
    isDestructiveCloseAllowed: true,
    isSharedWorkspace: false,
    isProjectPrimaryWorkspace: false,
    git: null,
    runtimeServices: [],
  });
  projectsApiMock.get.mockResolvedValue(mockProject);
  projectsApiMock.update.mockResolvedValue(mockProject);
  projectsApiMock.listAgents.mockResolvedValue([]);
  projectsApiMock.list.mockResolvedValue([mockProject]);
  projectsApiMock.budget.mockResolvedValue({ agents: [], totalSpendCents: 0 });
  projectsApiMock.createWorkspace.mockResolvedValue({});
  projectsApiMock.updateWorkspace.mockResolvedValue({});
  projectsApiMock.removeWorkspace.mockResolvedValue({});
  projectsApiMock.getEnvironment.mockResolvedValue({ env: null });
  projectsApiMock.updateEnvironment.mockResolvedValue({ env: null });
  // Archive now uses a Dialog instead of window.confirm
});

afterEach(() => {
  cleanup();
});

// --- Tests ---

describe("ProjectDetail — Workspaces tab", () => {
  it("renders a Workspaces tab button alongside other tabs", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

    await screen.findByText("ENG-99-fix-auth", {}, { timeout: 5000 });

    await screen.findByText("Overview");
    await screen.findByText("Board");
    await screen.findByText("Goals");
    await screen.findByText("Team");
    await screen.findByText("Budget");
    await screen.findByText("Discussions");
    await screen.findByText("Workspaces");
    await screen.findByRole("button", { name: "Settings" });
  });

  it("renders the Settings tab with Workspace & Runtime content", async () => {
    projectsApiMock.get.mockResolvedValue({ ...mockProject, functionType: "software_development" });
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/settings");

    const settingsTab = await screen.findByRole("button", { name: "Settings" }, { timeout: 5000 });
    expect(settingsTab.className).toContain("border-foreground");

    // Anchor on the WHOLE settings tree committing together rather than a
    // sequential findByText chain. Under max parallel-suite CPU starvation the
    // per-assertion 5 s budgets could trip mid-render (e.g. "Status" observed but
    // "Created" not yet), failing nondeterministically at whichever assertion the
    // poll happened to land on. One waitFor that requires every section at once —
    // polled up to 10 s, well within the 30 s testTimeout — only passes once the
    // full ProjectSettings + ProjectProperties tree has rendered, so it can never
    // observe a partial commit.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Department details" })).toBeInTheDocument();
      expect(screen.getByText("Status")).toBeInTheDocument();
      expect(screen.getByText("Created")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Workspace & Runtime" })).toBeInTheDocument();
      expect(screen.getByText(/Defaults for new tasks and future agent runs/i)).toBeInTheDocument();
      expect(screen.getByText("Environment Variables")).toBeInTheDocument();
    }, { timeout: 10000 });
    expect(screen.queryByTestId("project-workspaces-list")).not.toBeInTheDocument();
  });

  it("opens workspace source modals from Settings", async () => {
    projectsApiMock.get.mockResolvedValue({ ...mockProject, functionType: "software_development" });
    const user = userEvent.setup();
    renderProjectDetail("/projects/ENG/settings");

    await user.click(await screen.findByRole("button", { name: /add local folder/i }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Add local folder");
    expect(await screen.findByRole("button", { name: /select path/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await user.click(await screen.findByRole("button", { name: /add github repo/i }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Add GitHub repo");
    await user.type(screen.getByPlaceholderText("https://github.com/org/repo"), "https://github.com/acme/app");
    await user.click(screen.getByRole("button", { name: /save repo/i }));

    await waitFor(() => {
      expect(projectsApiMock.createWorkspace).toHaveBeenCalledWith(
        mockProject.id,
        { cwd: "/__paperclip_repo_only__", repoUrl: "https://github.com/acme/app" },
      );
    });
  });

  it("removes only the selected workspace source when a row has both local folder and repo", async () => {
    const user = userEvent.setup();
    projectsApiMock.get.mockResolvedValue({
      ...mockProject,
      functionType: "software_development",
      workspaces: [
        {
          id: "source-1",
          name: "Primary",
          cwd: "C:\\Work\\Repo",
          repoUrl: "https://github.com/acme/app.git",
          repoRef: null,
          metadata: null,
          isPrimary: true,
          createdAt: "2026-04-01T09:00:00Z",
          updatedAt: "2026-04-01T10:00:00Z",
        },
      ],
    });

    renderProjectDetail("/projects/ENG/settings");

    await user.click(await screen.findByRole("button", { name: "Delete workspace repo" }));

    await waitFor(() => {
      expect(projectsApiMock.updateWorkspace).toHaveBeenCalledWith(
        mockProject.id,
        "source-1",
        { repoUrl: null },
      );
    });
    expect(projectsApiMock.removeWorkspace).not.toHaveBeenCalled();
  });

  it("keeps department overview simple and moves controls out of the profile", async () => {
    projectsApiMock.get.mockResolvedValue({ ...mockProject, functionType: "software_development" });
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/overview");

    expect(await screen.findByPlaceholderText("Add a department description...")).toHaveValue("Engineering department");
    expect(await screen.findByTestId("project-function-type-badge")).toHaveTextContent(/Software department/i);
    expect(screen.queryByText("Properties")).not.toBeInTheDocument();
    expect(screen.queryByText("Environment Variables")).not.toBeInTheDocument();
    expect(await screen.findByText("Workspaces", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText("Add workspace local folder")).not.toBeInTheDocument();
    expect(await screen.findByText("Goals", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("shows workspace list when workspaces tab is active", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

    await screen.findByText("ENG-99-fix-auth", {}, { timeout: 5000 });
    await screen.findByText("ENG-100-new-feature");
  });

  it("fetches workspaces filtered by project ID", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

    await waitFor(() => {
      expect(executionWorkspacesApiMock.list).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({ projectId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" }),
      );
    }, { timeout: 5000 });
  });

  it("shows status badges for workspaces", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

    await screen.findByText("ENG-99-fix-auth", {}, { timeout: 5000 });
    await screen.findByText("active");
    await screen.findByText("idle");
  });

  it("shows mode badges for workspaces", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

    await screen.findByText("ENG-99-fix-auth", {}, { timeout: 5000 });
    await screen.findByText("Isolated");
    await screen.findByText("Shared");
  });

  it("shows empty state when no workspaces for this project", async () => {
    executionWorkspacesApiMock.list.mockResolvedValue([]);

    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

    await screen.findByText(/No workspaces yet/, {}, { timeout: 5000 });
  });

  it("shows Workspaces tab for departments without explicit policy", async () => {
    projectsApiMock.get.mockResolvedValue({ ...mockProject, executionWorkspacePolicy: null });
    executionWorkspacesApiMock.list.mockResolvedValue([]);

    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

    await screen.findByText(/No workspaces yet/, {}, { timeout: 5000 });
    await screen.findByText("Workspaces");
  });

  it("workspace row navigates to workspace view on click", async () => {
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
        <MemoryRouter initialEntries={["/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces"]}>
          <Routes>
            <Route path="projects/:projectId/workspaces" element={<ProjectDetail />} />
            <Route path=":companyPrefix/workspaces/:workspaceId" element={<div data-testid="workspace-page" />} />
          </Routes>
          <LocationDisplay />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText("ENG-99-fix-auth", {}, { timeout: 5000 });

    // Use findByTestId instead of getByTestId — under parallel-suite load
    // the row query can resolve after the project header but before the
    // row's own DOM node has rendered. findBy retries until the node exists.
    fireEvent.click(await screen.findByTestId("workspace-row-ws-1"));

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/TC/workspaces/ws-1");
    });
  });

  it("shows Archive button on active workspace rows", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

    await screen.findByText("ENG-99-fix-auth", {}, { timeout: 5000 });
    await screen.findByTestId("archive-workspace-ws-1");
    await screen.findByTestId("archive-workspace-ws-2");
  });

  it("calls update with archived status when Archive is confirmed via dialog", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

    // Settle the executionWorkspaces list query BEFORE interacting: wait for
    // BOTH archive buttons so the list's resolving re-render has fully flushed.
    // Clicking ws-1 while the query is still resolving races a re-render that
    // detaches the just-found node — the click then lands on a stale element,
    // the AlertDialog never opens, and confirm-archive-workspace never appears
    // (the 5 s "unable to find confirm-archive-workspace" flake seen only under
    // parallel-suite CPU contention; same stale-node race already mitigated for
    // workspace-row-ws-1 above). Re-query fresh and click in one sync tick.
    await screen.findByTestId("archive-workspace-ws-1", {}, { timeout: 15000 });
    await screen.findByTestId("archive-workspace-ws-2", {}, { timeout: 15000 });
    fireEvent.click(screen.getByTestId("archive-workspace-ws-1"));

    // Readiness loads via getCloseReadiness mock; the AlertDialog action starts
    // disabled while readiness is loading. Wait for the dialog to open, THEN for
    // the action to enable. Re-query each waitFor tick so a React re-render
    // between query and assertion can't leave us holding a stale DOM node.
    await screen.findByTestId("confirm-archive-workspace", {}, { timeout: 15000 });
    await waitFor(() => {
      expect(screen.getByTestId("confirm-archive-workspace")).not.toBeDisabled();
    }, { timeout: 15000 });

    fireEvent.click(screen.getByTestId("confirm-archive-workspace"));

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

    // Wait for both the trigger AND its count label to render — under
    // parallel-suite CPU contention, React sometimes flushes the tab
    // shell before the executionWorkspaces query resolves. Use a generous
    // timeout to handle slow CI / parallel-suite runs.
    const archivedTrigger = await screen.findByTestId("archived-workspaces-trigger", {}, { timeout: 5000 });
    expect(archivedTrigger).toHaveTextContent("Archived (2)");

    // Archived workspaces are NOT visible by default (collapsed)
    expect(screen.queryByTestId("archived-workspaces-list")).not.toBeInTheDocument();

    // Click to expand. Under parallel-suite load the workspace query can
    // briefly re-render the skeleton between the first trigger assertion and
    // the click. Retry the whole interaction and only click while still closed
    // so repeated waitFor ticks cannot toggle the section shut again.
    await waitFor(() => {
      const openList = screen.queryByTestId("archived-workspaces-list");
      if (!openList) {
        const trigger = screen.getByTestId("archived-workspaces-trigger");
        expect(trigger).toHaveTextContent("Archived (2)");
        fireEvent.click(trigger);
      }
      expect(screen.getByTestId("archived-workspaces-list")).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it("shows loading skeletons while fetching workspaces", async () => {
    executionWorkspacesApiMock.list.mockReturnValue(new Promise(() => {}));

    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/workspaces");

    // Wait for project to load first (tab bar appears), then workspace loading
    // shows. Replace `waitFor + getByX` with `findByX` — single retry loop
    // instead of nested waitFor wrapping a sync getByX, which can blow the
    // test budget under parallel-suite load when each waitFor consumes its
    // 5s ceiling sequentially.
    await screen.findByText("Workspaces", {}, { timeout: 5000 });
    const loading = await screen.findByTestId("workspaces-loading", {}, { timeout: 5000 });

    const skeletons = loading.querySelectorAll("[data-slot='skeleton']");
    expect(skeletons.length).toBeGreaterThanOrEqual(2);
  });
});
