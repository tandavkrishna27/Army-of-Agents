import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ExecutionWorkspace, Project } from "@armyofagents/shared";

import { mockBreadcrumbContext, mockCompanyContext } from "./test-utils";

const mockWorkspacesList = vi.fn();
const mockProjectsList = vi.fn();
const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockListOps = vi.fn();
const mockIssuesList = vi.fn();
const mockGetCloseReadiness = vi.fn();

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    list: (...args: unknown[]) => mockWorkspacesList(...args),
    get: (...args: unknown[]) => mockGet(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    listWorkspaceOperations: (...args: unknown[]) => mockListOps(...args),
    getCloseReadiness: (...args: unknown[]) => mockGetCloseReadiness(...args),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: (...args: unknown[]) => mockProjectsList(...args),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: { list: (...args: unknown[]) => mockIssuesList(...args) },
}));

const mockNavigate = vi.fn();
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

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

import { WorkspacesList } from "../pages/WorkspacesList";

function makeWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "ws-1",
    companyId: "comp-1",
    projectId: "proj-eng",
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "ws-1",
    status: "active",
    cwd: "/tmp/ws-1",
    repoUrl: null,
    baseRef: "main",
    branchName: "feat/one",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-04-10T10:00:00Z"),
    openedAt: new Date("2026-04-10T09:00:00Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date("2026-04-10T09:00:00Z"),
    updatedAt: new Date("2026-04-10T10:00:00Z"),
    ...overrides,
  } as ExecutionWorkspace;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-eng",
    companyId: "comp-1",
    name: "Engineering",
    type: "department",
    status: "active",
    color: "#6366f1",
    description: null,
    targetDate: null,
    issuePrefix: "ENG",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Project;
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/TC/workspaces"]}>
        <Routes>
          <Route path=":companyPrefix/workspaces" element={<WorkspacesList />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIssuesList.mockResolvedValue([]);
  mockGet.mockResolvedValue(makeWorkspace());
  mockListOps.mockResolvedValue([]);
  mockGetCloseReadiness.mockResolvedValue({
    workspaceId: "ws-1",
    state: "ready",
    blockingReasons: [],
    warnings: [],
    linkedIssues: [],
    plannedActions: [],
    isDestructiveCloseAllowed: true,
    isSharedWorkspace: false,
    isProjectPrimaryWorkspace: false,
    git: null,
    runtimeServices: [],
  });
});

describe("WorkspacesList", () => {
  it("renders loading state", () => {
    mockWorkspacesList.mockReturnValue(new Promise(() => {}));
    mockProjectsList.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByTestId("workspaces-list-loading")).toBeInTheDocument();
  });

  it("groups workspaces by project (N groups for N projects)", async () => {
    mockProjectsList.mockResolvedValue([
      makeProject({ id: "proj-eng", name: "Engineering" }),
      makeProject({ id: "proj-mkt", name: "Marketing" }),
    ]);
    mockWorkspacesList.mockResolvedValue([
      makeWorkspace({ id: "ws-1", projectId: "proj-eng" }),
      makeWorkspace({ id: "ws-2", projectId: "proj-eng" }),
      makeWorkspace({ id: "ws-3", projectId: "proj-mkt" }),
    ]);

    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("workspaces-group-proj-eng")).toBeInTheDocument();
    });
    expect(screen.getByTestId("workspaces-group-proj-mkt")).toBeInTheDocument();
  });

  it("shows per-group count (e.g., Engineering (2))", async () => {
    mockProjectsList.mockResolvedValue([makeProject({ id: "proj-eng", name: "Engineering" })]);
    mockWorkspacesList.mockResolvedValue([
      makeWorkspace({ id: "ws-1" }),
      makeWorkspace({ id: "ws-2" }),
    ]);

    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Engineering/)).toBeInTheDocument();
    });
    expect(screen.getByText(/\(2\)/)).toBeInTheDocument();
  });

  it("within-group rows are sorted by lastUsedAt desc", async () => {
    mockProjectsList.mockResolvedValue([makeProject({ id: "proj-eng" })]);
    mockWorkspacesList.mockResolvedValue([
      makeWorkspace({ id: "ws-old", lastUsedAt: new Date("2026-01-01T00:00:00Z") }),
      makeWorkspace({ id: "ws-new", lastUsedAt: new Date("2026-04-15T00:00:00Z") }),
    ]);

    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("workspaces-row-ws-new")).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId(/^workspaces-row-/);
    expect(rows[0].getAttribute("data-testid")).toBe("workspaces-row-ws-new");
    expect(rows[1].getAttribute("data-testid")).toBe("workspaces-row-ws-old");
  });

  it("Open button navigates to /prefix/workspaces/:id", async () => {
    const user = userEvent.setup();
    mockProjectsList.mockResolvedValue([makeProject()]);
    mockWorkspacesList.mockResolvedValue([makeWorkspace({ id: "ws-1" })]);

    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("workspaces-open-ws-1")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("workspaces-open-ws-1"));

    expect(mockNavigate).toHaveBeenCalledWith("/TC/workspaces/ws-1");
  });

  it("Settings button opens settings Sheet", async () => {
    const user = userEvent.setup();
    mockProjectsList.mockResolvedValue([makeProject()]);
    mockWorkspacesList.mockResolvedValue([makeWorkspace({ id: "ws-1" })]);

    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("workspaces-settings-ws-1")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("workspaces-settings-ws-1"));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-settings-sheet")).toBeInTheDocument();
    });
  });

  it("Archive button hidden for archived rows and shown otherwise", async () => {
    mockProjectsList.mockResolvedValue([makeProject()]);
    mockWorkspacesList.mockResolvedValue([
      makeWorkspace({ id: "ws-active", status: "active" }),
      makeWorkspace({ id: "ws-archived", status: "archived" }),
    ]);

    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("workspaces-row-ws-active")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("workspaces-archive-ws-archived")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspaces-archive-ws-active")).toBeInTheDocument();
  });

  it("shows empty state when there are no workspaces", async () => {
    mockProjectsList.mockResolvedValue([]);
    mockWorkspacesList.mockResolvedValue([]);

    renderPage();
    await waitFor(() => {
      expect(screen.getByText("No workspaces yet")).toBeInTheDocument();
    });
  });

  it("archived filter chip hides active workspaces", async () => {
    const user = userEvent.setup();
    mockProjectsList.mockResolvedValue([makeProject()]);
    mockWorkspacesList.mockResolvedValue([
      makeWorkspace({ id: "ws-active", status: "active" }),
      makeWorkspace({ id: "ws-archived", status: "archived" }),
    ]);

    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("workspaces-row-ws-active")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("workspaces-filter-status-archived"));

    await waitFor(() => {
      expect(screen.queryByTestId("workspaces-row-ws-active")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("workspaces-row-ws-archived")).toBeInTheDocument();
  });
});
