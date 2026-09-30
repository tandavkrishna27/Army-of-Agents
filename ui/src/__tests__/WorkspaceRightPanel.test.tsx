import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { WorkspaceRightPanel } from "../components/workspace/WorkspaceRightPanel";
import { mockCompanyContext } from "./test-utils";

const mockWorkspace = {
  id: "ws-1",
  companyId: "comp-1",
  projectId: "proj-1",
  projectWorkspaceId: null,
  sourceIssueId: "issue-1",
  mode: "local_checkout" as const,
  strategyType: "git_branch" as const,
  name: "workspace-1",
  status: "active" as const,
  cwd: "/home/agent/workspace",
  repoUrl: "https://github.com/org/repo",
  branchName: "feat/fix-auth",
  baseRef: "main",
  providerType: "local" as const,
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

const mockArtifact = {
  id: "art-1",
  companyId: "comp-1",
  title: "API Specification",
  description: null,
  type: "document" as const,
  status: "active" as const,
  currentVersionId: "v-1",
  createdById: "user-1",
  createdAt: new Date(),
  updatedAt: new Date(),
  versions: [
    {
      id: "v-1",
      artifactId: "art-1",
      versionNumber: 3,
      source: "agent" as const,
      sourceDetail: "Claude",
      changelog: "Updated endpoints",
      parentVersionId: null,
      content: "openapi: 3.0.0\npaths: ...",
      fileUrl: null,
      createdAt: new Date(),
    },
  ],
};

const mockAgent = {
  id: "agent-1",
  companyId: "comp-1",
  name: "Claude Agent",
  urlKey: "claude-agent",
  role: "engineer",
  title: "Senior Engineer",
  icon: null,
  status: "active",
  reportsTo: null,
  parentType: null,
  parentId: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  lastHeartbeatAt: new Date().toISOString(),
  projectId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
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
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  checkoutRunId: null,
  executionRunId: null,
  executionAgentNameKey: null,
  executionLockedAt: null,
  executionWorkspaceId: "ws-1",
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

const artifactsApiMock = {
  getByIssueId: vi.fn().mockResolvedValue(mockArtifact),
  get: vi.fn().mockResolvedValue(mockArtifact),
};

const dependenciesApiMock = {
  list: vi.fn().mockResolvedValue({ upstream: [], downstream: [] }),
};

const agentsApiMock = {
  list: vi.fn().mockResolvedValue([mockAgent]),
  wakeup: vi.fn().mockResolvedValue({ id: "run-wake-1", status: "queued" }),
};

const activityApiMock = {
  runsForIssue: vi.fn().mockResolvedValue([
    {
      runId: "run-1",
      status: "completed",
      agentId: "agent-1",
      startedAt: "2026-04-01T10:00:00Z",
      finishedAt: "2026-04-01T10:05:00Z",
      createdAt: "2026-04-01T10:00:00Z",
      invocationSource: "heartbeat",
    },
  ]),
};

const heartbeatsApiMock = {
  activeRunForIssue: vi.fn().mockResolvedValue(null),
  liveRunsForIssue: vi.fn().mockResolvedValue([]),
  events: vi.fn().mockResolvedValue([]),
  log: vi.fn().mockResolvedValue({ content: "", nextOffset: undefined }),
};

const issuesApiMock = {
  get: vi.fn().mockResolvedValue(mockIssue),
};

const executionWorkspacesApiMock = {
  runtimeServices: vi.fn().mockResolvedValue([]),
  getGitStatus: vi.fn().mockResolvedValue({
    gitAvailable: true,
    branch: "feat/fix-auth",
    detachedHead: false,
    remote: null,
    ahead: null,
    behind: null,
    files: [],
    clean: true,
  }),
  getGitLog: vi.fn().mockResolvedValue({ gitAvailable: true, entries: [] }),
  gitCommit: vi.fn(),
  gitPush: vi.fn(),
};

const outputDetectionApiMock = {
  listForIssue: vi.fn().mockResolvedValue([]),
  confirm: vi.fn().mockResolvedValue({
    artifactId: "art-confirmed",
    versionId: "version-confirmed",
    status: "confirmed",
  }),
  dismiss: vi.fn(),
};

const memoryRetrievalsApiMock = {
  listForIssue: vi.fn().mockResolvedValue([]),
};

vi.mock("../api/artifacts", () => ({
  artifactsApi: new Proxy({}, { get: (_t, prop) => (artifactsApiMock as any)[prop] }),
}));

vi.mock("../api/dependencies", () => ({
  dependenciesApi: new Proxy({}, { get: (_t, prop) => (dependenciesApiMock as any)[prop] }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: new Proxy({}, { get: (_t, prop) => (agentsApiMock as any)[prop] }),
}));

vi.mock("../api/activity", () => ({
  activityApi: new Proxy({}, { get: (_t, prop) => (activityApiMock as any)[prop] }),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: new Proxy({}, { get: (_t, prop) => (heartbeatsApiMock as any)[prop] }),
}));

vi.mock("../api/issues", () => ({
  issuesApi: new Proxy({}, { get: (_t, prop) => (issuesApiMock as any)[prop] }),
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: new Proxy({}, { get: (_t, prop) => (executionWorkspacesApiMock as any)[prop] }),
}));

vi.mock("../api/output-detection", () => ({
  outputDetectionApi: new Proxy({}, { get: (_t, prop) => (outputDetectionApiMock as any)[prop] }),
}));

vi.mock("../api/memoryRetrievals", () => ({
  memoryRetrievalsApi: new Proxy({}, { get: (_t, prop) => (memoryRetrievalsApiMock as any)[prop] }),
}));

vi.mock("../components/workspace/sections/MemorySection", () => ({
  MemorySection: () => <div data-testid="memory-placeholder" />,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    ...mockCompanyContext,
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", issuePrefix: "TC", name: "Test Corp" },
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    toasts: [],
    pushToast: vi.fn(),
    dismissToast: vi.fn(),
    clearToasts: vi.fn(),
  }),
}));

function renderRightPanel(props: Partial<React.ComponentProps<typeof WorkspaceRightPanel>> = {}) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WorkspaceRightPanel
          issueId="issue-1"
          companyId="comp-1"
          companyPrefix="TC"
          workspace={mockWorkspace}
          functionType="software_development"
          previewMode={null}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("WorkspaceRightPanel cockpit contract", () => {
  it("renders the software cockpit sections in the final order", async () => {
    renderRightPanel({ functionType: "software_development" });

    const expected = [
      "cockpit-section-process",
      "cockpit-section-git",
      "cockpit-section-services",
      "cockpit-section-outputs",
      "cockpit-section-artifacts",
      "cockpit-section-memory",
      "cockpit-section-context",
      "cockpit-section-access",
    ];

    for (const testId of expected) {
      expect(await screen.findByTestId(testId)).toBeInTheDocument();
    }

    const sectionIds = screen
      .getAllByTestId(/^cockpit-section-/)
      .map((node) => node.getAttribute("data-testid"))
      .filter((testId) => testId && !testId.includes("trigger") && !testId.includes("summary"));
    expect(sectionIds).toEqual(expected);
    expect(screen.queryByTestId("cockpit-section-engineering")).not.toBeInTheDocument();
  });

  it("replaces static card subtitles with live summaries and hides empty summaries", async () => {
    executionWorkspacesApiMock.getGitStatus.mockResolvedValueOnce({
      gitAvailable: true,
      branch: "feat/fix-auth",
      detachedHead: false,
      remote: { name: "origin", branch: "feat/fix-auth" },
      ahead: 2,
      behind: 0,
      files: [{ path: "src/app.ts", status: "modified" }],
      clean: false,
    });
    executionWorkspacesApiMock.runtimeServices.mockResolvedValueOnce([
      {
        id: "svc-1",
        serviceName: "web",
        status: "running",
        port: 3100,
        url: "http://localhost:3100",
        command: "pnpm dev",
        cwd: "/tmp/ws",
        provider: "local_process",
        lifecycle: "shared",
        startedAt: "2026-05-16T10:00:00Z",
        stoppedAt: null,
      },
    ]);
    outputDetectionApiMock.listForIssue.mockResolvedValueOnce([
      {
        runId: "run-1",
        runFinishedAt: "2026-04-01T10:05:00Z",
        outputIndex: 0,
        path: "session-debug-report.html",
        filename: "session-debug-report.html",
        byteSize: 128,
        contentType: "text/html",
        assetId: "asset-1",
        sha256: "sha256-session-debug-report",
        source: "diff",
        label: "Session debug report",
        artifactType: "document",
        status: "pending",
      },
    ]);
    memoryRetrievalsApiMock.listForIssue.mockResolvedValueOnce([
      {
        id: "mem-1",
        companyId: "comp-1",
        agentId: "agent-1",
        runId: "run-1",
        taskId: "issue-1",
        triggeredBy: "agent_search",
        query: "testing",
        itemId: "item-1",
        similarityScore: "0.91",
        rank: 1,
        shownToAgent: true,
        createdAt: "2026-05-16T10:00:00Z",
        itemTitle: "Testing standards",
        itemContent: "Use real product tests",
        itemCategory: "engineering",
        itemLayer: "department",
        itemStatus: "active",
        itemPinnedToSkill: false,
      },
    ]);

    renderRightPanel({ functionType: "software_development" });

    expect(await screen.findByText("Idle · 1 run")).toBeInTheDocument();
    expect(await screen.findByText("1 changed file · 2 ahead")).toBeInTheDocument();
    expect(await screen.findByText("1 running · web")).toBeInTheDocument();
    expect(await screen.findByText("1 artifact · 1 candidate")).toBeInTheDocument();
    expect(await screen.findByText("1 retrieval")).toBeInTheDocument();
    expect(await screen.findByText("Repo connected")).toBeInTheDocument();

    expect(screen.queryByText("Agent, run, blockers")).not.toBeInTheDocument();
    expect(screen.queryByText("Branch, changes, PR")).not.toBeInTheDocument();
    expect(screen.queryByText("Task scope and inputs")).not.toBeInTheDocument();
    expect(screen.getByTestId("cockpit-section-summary-context")).toBeEmptyDOMElement();
  });

  it("summarizes only stopped detected previews as no running services", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValueOnce([
      {
        id: "svc-preview-stopped",
        serviceName: "localhost:50163",
        status: "stopped",
        port: 50163,
        url: "http://127.0.0.1:50163/",
        previewUrl: null,
        localTargetUrl: "http://127.0.0.1:50163/",
        healthStatus: "unhealthy",
        command: null,
        cwd: "/tmp/ws",
        provider: "adapter_managed",
        providerRef: null,
        lifecycle: "ephemeral",
        startedAt: "2026-05-16T10:00:00Z",
        stoppedAt: "2026-05-16T10:05:00Z",
      },
    ]);

    renderRightPanel({ functionType: "software_development" });

    expect(await screen.findByText("No running services")).toBeInTheDocument();
    expect(screen.queryByText("1 stopped service")).not.toBeInTheDocument();
  });

  it("renders the cockpit header with ticket identifier, actions, and collapse", async () => {
    const user = userEvent.setup();
    const onToggleCollapse = vi.fn();
    const onOpenSettings = vi.fn();
    const onOpenArchive = vi.fn();
    renderRightPanel({
      functionType: "software_development",
      selectedIssueIdentifier: "ENG-42",
      onToggleCollapse,
      onOpenSettings,
      onOpenArchive,
    });

    const header = await screen.findByTestId("workspace-cockpit-header");
    const collapseButton = screen.getByTestId("workspace-right-panel-collapse");
    const menuButton = screen.getByTestId("workspace-cockpit-menu-trigger");
    const title = screen.getByTestId("workspace-cockpit-title");

    expect(title).toHaveTextContent("Cockpit · ENG-42");
    expect(title.className).toContain("truncate");
    expect(header.compareDocumentPosition(collapseButton)).toBeTruthy();
    expect(collapseButton.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(menuButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(menuButton.querySelector("svg")?.className.baseVal).toContain("lucide-ellipsis-vertical");
    await user.click(screen.getByTestId("workspace-cockpit-menu-trigger"));
    await user.click(await screen.findByTestId("workspace-cockpit-menu-settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("workspace-cockpit-menu-trigger"));
    await user.click(await screen.findByTestId("workspace-cockpit-menu-archive"));
    expect(onOpenArchive).toHaveBeenCalledTimes(1);

    expect(screen.getByTestId("workspace-right-panel-collapse").className).toContain("h-7");
    expect(screen.getByTestId("workspace-right-panel-collapse").className).toContain("w-7");
    fireEvent.click(screen.getByTestId("workspace-right-panel-collapse"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("keeps long cockpit ticket identifiers truncated in one header row", async () => {
    renderRightPanel({
      functionType: "software_development",
      selectedIssueIdentifier: "ENG-1234567890-very-long-ticket-reference",
      onToggleCollapse: vi.fn(),
      onOpenSettings: vi.fn(),
    });

    const header = await screen.findByTestId("workspace-cockpit-header");
    const title = screen.getByTestId("workspace-cockpit-title");
    expect(header.className).toContain("overflow-hidden");
    expect(title).toHaveTextContent("Cockpit · ENG-1234567890-very-long-ticket-reference");
    expect(title.className).toContain("min-w-0");
    expect(title.className).toContain("truncate");
    expect(screen.queryByTestId("workspace-cockpit-ticket")).not.toBeInTheDocument();
  });

  it("keeps workspace actions reachable from the collapsed cockpit rail", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const onOpenArchive = vi.fn();
    renderRightPanel({
      collapsed: true,
      selectedIssueIdentifier: "ENG-42",
      onOpenSettings,
      onOpenArchive,
    });

    expect(screen.getByTestId("workspace-right-panel-collapsed")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-right-panel-collapsed").className).toContain("items-center");
    expect(screen.getByTestId("workspace-right-panel-collapsed").className).not.toContain("items-end");
    await user.click(screen.getByTestId("workspace-cockpit-menu-trigger"));
    await user.click(await screen.findByTestId("workspace-cockpit-menu-settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("does not render Engineering for non-software departments", async () => {
    renderRightPanel({ functionType: "marketing" });

    expect(await screen.findByTestId("cockpit-section-process")).toBeInTheDocument();
    expect(screen.queryByTestId("cockpit-section-engineering")).not.toBeInTheDocument();
  });

  it("applies containment classes to every cockpit section", async () => {
    renderRightPanel({ functionType: "software_development" });

    for (const id of ["process", "git", "services", "artifacts", "memory", "context", "access"]) {
      const section = await screen.findByTestId(`cockpit-section-${id}`);
      expect(section.className).toContain("min-w-0");
      expect(section.className).toContain("max-w-full");
      expect(section.className).toContain("overflow-hidden");
    }
  });

  it("keeps collapsed cockpit rows status-only with actions hidden", async () => {
    renderRightPanel({ functionType: "software_development" });

    expect(await screen.findByTestId("cockpit-section-process")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Wake agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create PR" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
  });

  it("shows Wake agent only after Process is expanded and never shows pause or cancel controls", async () => {
    heartbeatsApiMock.activeRunForIssue.mockResolvedValueOnce(null);
    renderRightPanel({ functionType: "software_development" });

    fireEvent.click(await screen.findByTestId("cockpit-section-trigger-process"));

    const wakeButton = await screen.findByRole("button", { name: "Wake agent" });
    expect(wakeButton).toBeEnabled();
    expect(wakeButton.className).toContain("bg-brand");
    expect(screen.queryByRole("button", { name: "Open latest logs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open latest run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume agent" })).not.toBeInTheDocument();
  });

  it("wakes the assigned agent with the current issue payload", async () => {
    renderRightPanel();

    fireEvent.click(await screen.findByTestId("cockpit-section-trigger-process"));
    fireEvent.click(await screen.findByRole("button", { name: "Wake agent" }));

    await waitFor(() => {
      expect(agentsApiMock.wakeup).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({
          source: "on_demand",
          payload: { issueId: "issue-1" },
        }),
        "comp-1",
      );
    });
  });

  it("renders services under Services and git under Git", async () => {
    executionWorkspacesApiMock.runtimeServices.mockResolvedValueOnce([
      {
        id: "svc-1",
        serviceName: "web",
        status: "running",
        port: 3100,
        url: "http://localhost:3100",
        command: "pnpm dev",
        cwd: "/tmp/ws",
        provider: "local_process",
        lifecycle: "shared",
        startedAt: "2026-05-16T10:00:00Z",
        stoppedAt: null,
      },
    ]);

    renderRightPanel();

    fireEvent.click(await screen.findByTestId("cockpit-section-trigger-services"));
    expect(await screen.findByTestId("section-services-body")).toBeInTheDocument();
    expect(await screen.findByText("web")).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId("cockpit-section-trigger-git"));
    expect(await screen.findByTestId("git-panel")).toBeInTheDocument();
  });

  it("shows artifact details only after Artifacts is expanded", async () => {
    renderRightPanel();

    expect(screen.queryByText("API Specification")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByTestId("cockpit-section-trigger-artifacts"));

    expect(await screen.findByText("API Specification")).toBeInTheDocument();
    expect(screen.getByText("v3")).toBeInTheDocument();
    expect(screen.queryByText("agent")).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-row").className).toContain("py-1.5");
    expect(screen.getByText("API Specification").className).toContain("text-xs");
  });

  it("opens captured pending detected outputs from the sidebar artifacts section", async () => {
    const user = userEvent.setup();
    const onPreviewOutput = vi.fn();
    artifactsApiMock.getByIssueId.mockResolvedValueOnce(null);
    outputDetectionApiMock.listForIssue.mockResolvedValueOnce([
      {
        runId: "run-1",
        runFinishedAt: "2026-04-01T10:05:00Z",
        outputIndex: 0,
        path: "session-debug-report.html",
        filename: "session-debug-report.html",
        byteSize: 128,
        contentType: "text/html",
        assetId: "asset-1",
        sha256: "sha256-session-debug-report",
        source: "diff",
        label: "Session debug report",
        artifactType: "document",
        status: "pending",
      },
      {
        runId: "run-1",
        runFinishedAt: "2026-04-01T10:05:00Z",
        outputIndex: 1,
        path: "src/app.ts",
        filename: "app.ts",
        byteSize: 256,
        contentType: "text/typescript",
        assetId: null,
        sha256: null,
        source: "git_diff",
        label: null,
        artifactType: "code",
        status: "pending",
      },
    ]);

    renderRightPanel({ onPreviewOutput });
    fireEvent.click(await screen.findByTestId("cockpit-section-trigger-artifacts"));

    expect(await screen.findByText("session-debug-report.html")).toBeInTheDocument();
    expect(await screen.findByText("app.ts")).toBeInTheDocument();
    expect(screen.queryByText("candidate")).not.toBeInTheDocument();
    expect(screen.queryByText("captured")).not.toBeInTheDocument();
    expect(screen.queryByText("live")).not.toBeInTheDocument();
    expect(screen.queryByText("text/html")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("artifact-candidate-row")[0].className).toContain("hover:bg-white/[0.06]");
    expect(screen.getAllByTestId("artifact-candidate-row")[0].className).toContain("w-full");
    expect(screen.getAllByTestId("artifact-candidate-row")[0].className).toContain("py-1.5");
    expect(screen.getByText("session-debug-report.html").className).toContain("text-xs");
    expect(screen.getByText("session-debug-report.html").className).toContain("font-mono");
    expect(screen.getAllByTestId("artifact-candidate-row")[1].className).not.toContain("hover:bg-accent/50");
    fireEvent.click(screen.getAllByTestId("artifact-candidate-row")[0]);
    expect(onPreviewOutput).toHaveBeenCalledWith(expect.objectContaining({ filename: "session-debug-report.html", assetId: "asset-1" }));
    expect(screen.queryByRole("button", { name: /^Publish$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm artifact" })).not.toBeInTheDocument();
    expect(outputDetectionApiMock.confirm).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: "Artifact actions" })[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Save as artifact" }));
    await waitFor(() => {
      expect(outputDetectionApiMock.confirm).toHaveBeenCalledWith("run-1", 0, {
        title: "session-debug-report.html",
        type: "document",
        changelog: "Agent output: session-debug-report.html",
      });
    });
  });

  it("dismisses pending detected outputs from the sidebar artifact actions menu", async () => {
    const user = userEvent.setup();
    artifactsApiMock.getByIssueId.mockResolvedValueOnce(null);
    outputDetectionApiMock.listForIssue.mockResolvedValueOnce([
      {
        runId: "run-dismiss",
        runFinishedAt: "2026-04-01T10:05:00Z",
        outputIndex: 2,
        path: "scratch.txt",
        filename: "scratch.txt",
        byteSize: 128,
        contentType: "text/plain",
        assetId: "asset-dismiss",
        sha256: "sha256-dismiss",
        source: "diff",
        label: null,
        artifactType: "document",
        status: "pending",
      },
    ]);

    renderRightPanel();
    fireEvent.click(await screen.findByTestId("cockpit-section-trigger-artifacts"));

    await user.click(await screen.findByRole("button", { name: "Artifact actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Dismiss" }));
    await waitFor(() => {
      expect(outputDetectionApiMock.dismiss).toHaveBeenCalledWith("run-dismiss", 2);
    });
  });

  it("opens Memory from the collapsed rail and force-expands it", async () => {
    const onExpandAndShowSection = vi.fn();
    renderRightPanel({ collapsed: true, onExpandAndShowSection });

    fireEvent.click(screen.getByTestId("workspace-rail-section-memory"));
    expect(onExpandAndShowSection).toHaveBeenCalledWith("memory");

    renderRightPanel({
      collapsed: false,
      openSection: { section: "memory", nonce: 1 },
    });

    expect(await screen.findByTestId("memory-placeholder")).toBeInTheDocument();
  });

  it("renders Access without leaking secret values", async () => {
    renderRightPanel();

    fireEvent.click(await screen.findByTestId("cockpit-section-trigger-access"));

    expect(await screen.findByTestId("access-cockpit-section")).toBeInTheDocument();
    expect(screen.getByText("names only")).toBeInTheDocument();
    expect(screen.queryByText(/sk-/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ghp_/)).not.toBeInTheDocument();
  });
});
