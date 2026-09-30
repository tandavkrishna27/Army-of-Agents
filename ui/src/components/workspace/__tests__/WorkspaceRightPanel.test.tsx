import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentsApiMock: { list: vi.fn().mockResolvedValue([]) },
  activityApiMock: { runsForIssue: vi.fn().mockResolvedValue([]) },
  artifactsApiMock: { getByIssueId: vi.fn().mockResolvedValue(null) },
  dependenciesApiMock: { list: vi.fn().mockResolvedValue({ upstream: [], downstream: [] }) },
  executionWorkspacesApiMock: {
    getGitStatus: vi.fn().mockResolvedValue({
      gitAvailable: true,
      clean: true,
      files: [],
      ahead: 0,
      behind: 0,
      remote: null,
      detachedHead: false,
    }),
    runtimeServices: vi.fn().mockResolvedValue([]),
  },
  heartbeatsApiMock: {
    activeRunForIssue: vi.fn().mockResolvedValue(null),
  },
  issuesApiMock: {
    get: vi.fn().mockResolvedValue({
      id: "issue-1",
      status: "in_progress",
      assigneeAgentId: null,
    }),
  },
  memoryRetrievalsApiMock: { listForIssue: vi.fn().mockResolvedValue([]) },
  outputDetectionApiMock: { listForIssue: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../../../api/agents", () => ({ agentsApi: mocks.agentsApiMock }));
vi.mock("../../../api/activity", () => ({ activityApi: mocks.activityApiMock }));
vi.mock("../../../api/artifacts", () => ({ artifactsApi: mocks.artifactsApiMock }));
vi.mock("../../../api/dependencies", () => ({ dependenciesApi: mocks.dependenciesApiMock }));
vi.mock("../../../api/execution-workspaces", () => ({ executionWorkspacesApi: mocks.executionWorkspacesApiMock }));
vi.mock("../../../api/heartbeats", () => ({ heartbeatsApi: mocks.heartbeatsApiMock }));
vi.mock("../../../api/issues", () => ({ issuesApi: mocks.issuesApiMock }));
vi.mock("../../../api/memoryRetrievals", () => ({ memoryRetrievalsApi: mocks.memoryRetrievalsApiMock }));
vi.mock("../../../api/output-detection", () => ({ outputDetectionApi: mocks.outputDetectionApiMock }));

vi.mock("../sections/ProcessSection", () => ({
  ProcessSection: () => <div data-testid="section-content-process">Process content</div>,
}));
vi.mock("../sections/ArtifactsSection", () => ({
  ArtifactsSection: () => <div data-testid="section-content-artifacts">Artifacts content</div>,
}));
vi.mock("../sections/MemorySection", () => ({
  MemorySection: () => <div data-testid="section-content-memory">Memory content</div>,
}));
vi.mock("../sections/ServicesSection", () => ({
  ServicesSection: () => <div data-testid="section-content-services">Services content</div>,
}));
vi.mock("../tools/GitPanel", () => ({
  GitPanel: () => <div data-testid="section-content-git">Git content</div>,
}));

import { WorkspaceRightPanel } from "../WorkspaceRightPanel";

const workspace = {
  id: "ws-1",
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

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceRightPanel
        issueId="issue-1"
        companyId="comp-1"
        companyPrefix="ENG"
        workspace={workspace as any}
        functionType="software_development"
        previewMode={null}
        selectedIssueIdentifier="ENG-42"
      />
    </QueryClientProvider>,
  );
}

describe("WorkspaceRightPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("limits saved expanded sections on first render", async () => {
    for (const section of ["process", "git", "services", "artifacts", "memory"]) {
      localStorage.setItem(`aoa:workspace:cockpit:section:${section}`, "true");
    }

    renderPanel();

    expect(screen.queryByTestId("section-content-process")).not.toBeInTheDocument();
    expect(screen.queryByTestId("section-content-git")).not.toBeInTheDocument();
    expect(screen.getByTestId("section-content-services")).toBeInTheDocument();
    expect(screen.getByTestId("section-content-artifacts")).toBeInTheDocument();
    expect(screen.getByTestId("section-content-memory")).toBeInTheDocument();
  });

  it("keeps only the latest three cockpit sections expanded", async () => {
    renderPanel();

    fireEvent.click(screen.getByTestId("cockpit-section-trigger-process"));
    fireEvent.click(screen.getByTestId("cockpit-section-trigger-git"));
    fireEvent.click(screen.getByTestId("cockpit-section-trigger-services"));

    expect(screen.getByTestId("section-content-process")).toBeInTheDocument();
    expect(screen.getByTestId("section-content-git")).toBeInTheDocument();
    expect(screen.getByTestId("section-content-services")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("cockpit-section-trigger-artifacts"));

    expect(screen.queryByTestId("section-content-process")).not.toBeInTheDocument();
    expect(screen.getByTestId("section-content-git")).toBeInTheDocument();
    expect(screen.getByTestId("section-content-services")).toBeInTheDocument();
    expect(screen.getByTestId("section-content-artifacts")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("cockpit-section-trigger-services"));

    expect(screen.queryByTestId("section-content-services")).not.toBeInTheDocument();
    expect(screen.getByTestId("section-content-git")).toBeInTheDocument();
    expect(screen.getByTestId("section-content-artifacts")).toBeInTheDocument();
  });

  it("keeps a newly opened early-order section instead of immediately closing it", async () => {
    renderPanel();

    fireEvent.click(screen.getByTestId("cockpit-section-trigger-services"));
    fireEvent.click(screen.getByTestId("cockpit-section-trigger-artifacts"));
    fireEvent.click(screen.getByTestId("cockpit-section-trigger-memory"));

    expect(screen.getByTestId("section-content-services")).toBeInTheDocument();
    expect(screen.getByTestId("section-content-artifacts")).toBeInTheDocument();
    expect(screen.getByTestId("section-content-memory")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("cockpit-section-trigger-process"));

    expect(screen.queryByTestId("section-content-services")).not.toBeInTheDocument();
    expect(screen.getByTestId("section-content-artifacts")).toBeInTheDocument();
    expect(screen.getByTestId("section-content-memory")).toBeInTheDocument();
    expect(screen.getByTestId("section-content-process")).toBeInTheDocument();
  });
});
