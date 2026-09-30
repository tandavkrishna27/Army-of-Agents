import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { ThreadDetail } from "../../../pages/ThreadDetail";

const pushToastMock = vi.hoisted(() => vi.fn());

// Mock API modules
vi.mock("../../../api/threads", () => ({
  threadsApi: {
    detail: vi.fn(),
    list: vi.fn().mockResolvedValue({ discussions: [], total: 0, limit: 50, offset: 0 }),
    advancePhase: vi.fn(),
    claim: vi.fn(),
    setStatus: vi.fn(),
    setAutonomyLevel: vi.fn(),
    pauseCrew: vi.fn(),
    resumeCrew: vi.fn(),
    listScopeVersions: vi.fn().mockResolvedValue({ versions: [], total: 0 }),
    getScopeVersion: vi.fn(),
    createScopeDraft: vi.fn(),
    acceptScopeVersion: vi.fn(),
    reviewScopeItems: vi.fn(),
    updateScopeItem: vi.fn(),
    createScopeOutputItem: vi.fn(),
    applyScopeVersion: vi.fn(),
    rejectScopeVersion: vi.fn(),
    completeScopeVersion: vi.fn(),
    listLinks: vi.fn().mockResolvedValue({ links: [] }),
  },
}));

vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", name: "Test Corp", issuePrefix: "TC" },
  }),
}));

vi.mock("../../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: vi.fn(),
    setSubtitle: vi.fn(),
    setEntityColor: vi.fn(),
  }),
}));

vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("../../../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown-body">{children}</div>
  ),
}));

vi.mock("../../../api/issues", () => ({
  issuesApi: {
    get: vi.fn().mockResolvedValue({
      id: "task-1",
      identifier: "TC-1",
      title: "Build scoped onboarding cleanup",
      description: "Created from accepted scope.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      projectId: null,
      goalId: null,
      parentId: null,
      labels: [],
      workMode: "standard",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }),
    update: vi.fn().mockResolvedValue({}),
    listComments: vi.fn().mockResolvedValue([]),
    listApprovals: vi.fn().mockResolvedValue([]),
    listAttachments: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    listLabels: vi.fn().mockResolvedValue([
      { id: "label-frontend", name: "Frontend", color: "#2563eb" },
      { id: "label-polish", name: "Polish", color: "#059669" },
    ]),
    createLabel: vi.fn().mockResolvedValue({ id: "label-new", name: "New", color: "#6366f1" }),
    deleteLabel: vi.fn().mockResolvedValue({ ok: true }),
    uploadAttachment: vi.fn().mockResolvedValue({ contentPath: "/asset.png" }),
    deleteAttachment: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("../../../api/agents", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([
      { id: "agent-1", name: "E2E Engineer", status: "active", icon: null },
    ]),
  },
}));

vi.mock("../../../api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([
      { id: "dept-product", name: "Product", type: "department", color: "#2563eb" },
      { id: "project-1", name: "Product Engineering", type: "project", color: "#2563eb" },
    ]),
  },
}));

vi.mock("../../../api/goals", () => ({
  goalsApi: {
    list: vi.fn().mockResolvedValue([
      { id: "goal-1", title: "Improve scope handoff", projectId: "project-1" },
    ]),
  },
}));

vi.mock("../../../api/memoryFolders", () => ({
  memoryFoldersApi: {
    list: vi.fn().mockResolvedValue([
      {
        id: "folder-1",
        companyId: "comp-1",
        departmentId: "dept-product",
        path: "software-test/Overview",
        displayName: "Overview",
        icon: null,
        sortOrder: 0,
        seedKey: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]),
  },
}));

vi.mock("../../../api/auth", () => ({
  authApi: {
    getSession: vi.fn().mockResolvedValue({ user: { id: "local-board" } }),
  },
}));

vi.mock("../../../hooks/useTeamAccess", () => ({
  useTeamAccess: () => ({
    permissions: { canAssignTasks: true },
  }),
}));

vi.mock("../../../api/memory", () => ({
  memoryApi: {
    get: vi.fn().mockResolvedValue({
      id: "memory-1",
      title: "Founder scope preference",
      content: "Accepted scope is the handoff source of truth.",
      status: "pending",
      layer: "domain",
      category: "decision",
      departmentId: "dept-product",
      sourceArtifactId: "artifact-1",
      taskId: "task-1",
      updatedAt: "2026-01-02T00:00:00Z",
    }),
    update: vi.fn().mockResolvedValue({}),
    approve: vi.fn().mockResolvedValue({ id: "memory-1", status: "approved" }),
    reject: vi.fn().mockResolvedValue({ id: "memory-1", status: "rejected" }),
    moveItem: vi.fn().mockResolvedValue({ id: "memory-1", folderPath: "software-test/Overview" }),
    changeLayer: vi.fn().mockResolvedValue({ id: "memory-1", layer: "domain" }),
  },
}));

vi.mock("../../../api/artifacts", () => ({
  artifactsApi: {
    get: vi.fn().mockResolvedValue({
      id: "artifact-1",
      title: "Scope mockup",
      type: "document",
      versions: [],
    }),
    getByIssueId: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ threadId: "thread-1", companyPrefix: "TC" }),
  };
});

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/router")>("../../../lib/router");
  return {
    ...actual,
    useParams: () => ({ threadId: "thread-1", companyPrefix: "TC" }),
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
      <a href={to}>{children}</a>
    ),
  };
});

import { threadsApi } from "../../../api/threads";
import { artifactsApi } from "../../../api/artifacts";
import { memoryApi } from "../../../api/memory";
import type { ThreadDetail as ThreadDetailType } from "../../../api/threads";
import React from "react";

const mockThread: ThreadDetailType = {
  id: "thread-1",
  title: "Refactor auth module",
  status: "active",
  scopeType: null,
  scopeId: null,
  scopeName: null,
  tags: [],
  entryCount: 2,
  pendingItemCount: 1,
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  entries: [],
  phase: "discuss",
  visibility: "company",
  ownerUserId: null,
  originSource: null,
  intent: ["improve security"],
  goalId: null,
  autonomyLevel: 1,
  summaryText: null,
  summaryNext: null,
  crewPaused: false,
  subtype: "normal",
  shareToken: null,
  participants: [],
};

function setupDraftMemoryCandidate() {
  vi.mocked(threadsApi.detail).mockResolvedValue({
    ...mockThread,
    derivedStage: {
      stage: "scoping",
      label: "Scoping v1",
      versionNumber: 1,
      scopeVersionId: "scope-1",
      hasNewEntries: false,
      newEntryCount: 0,
    },
  } as ThreadDetailType);
  vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
    total: 1,
    versions: [
      {
        id: "scope-1",
        threadId: "thread-1",
        versionNumber: 1,
        status: "draft",
        sourceStartSeq: 1,
        sourceEndSeq: 2,
        summary: "Draft scope summary.",
        assumptions: [],
        decisions: [],
        openQuestions: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  });
  vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
    id: "scope-1",
    threadId: "thread-1",
    versionNumber: 1,
    status: "draft",
    sourceStartSeq: 1,
    sourceEndSeq: 2,
    summary: "Draft scope summary.",
    assumptions: [],
    decisions: [],
    openQuestions: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    items: [
      {
        id: "scope-item-memory",
        kind: "memory_candidate",
        status: "draft",
        title: "Accepted scope versions are handoff source of truth",
        description: "Store accepted scope versions as durable context for future agent work.",
        payload: { category: "decision", layer: "domain", confidence: "high" },
        sourceEntryIds: ["entry-2"],
        resultIssueId: null,
        resultMemoryId: null,
        artifactId: null,
        artifactVersionId: null,
      },
    ],
  });
}

function setupAppliedMemoryCandidate(memory: Record<string, unknown> = {}) {
  vi.mocked(threadsApi.detail).mockResolvedValue({
    ...mockThread,
    derivedStage: {
      stage: "assigned",
      label: "Assigned v1",
      versionNumber: 1,
      scopeVersionId: "scope-1",
      hasNewEntries: false,
      newEntryCount: 0,
    },
  } as ThreadDetailType);
  vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
    total: 1,
    versions: [
      {
        id: "scope-1",
        threadId: "thread-1",
        versionNumber: 1,
        status: "accepted",
        sourceStartSeq: 1,
        sourceEndSeq: 2,
        summary: "Accepted scope summary.",
        assumptions: [],
        decisions: [],
        openQuestions: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  });
  vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
    id: "scope-1",
    threadId: "thread-1",
    versionNumber: 1,
    status: "accepted",
    sourceStartSeq: 1,
    sourceEndSeq: 2,
    summary: "Accepted scope summary.",
    assumptions: [],
    decisions: [],
    openQuestions: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    items: [
      {
        id: "scope-item-memory",
        kind: "memory_candidate",
        status: "applied",
        title: "Founder scope preference",
        description: "Persisted as memory.",
        payload: { category: "decision", layer: "domain" },
        sourceEntryIds: ["entry-2"],
        resultIssueId: null,
        resultMemoryId: "memory-1",
        artifactId: null,
        artifactVersionId: null,
      },
    ],
  });
  vi.mocked(memoryApi.get).mockResolvedValue({
    id: "memory-1",
    title: "Founder scope preference",
    content: "Accepted scope is the handoff source of truth.",
    status: "pending",
    layer: "domain",
    category: "decision",
    departmentId: "dept-product",
    sourceArtifactId: "artifact-1",
    taskId: "task-1",
    updatedAt: "2026-01-02T00:00:00Z",
    ...memory,
  } as any);
}

describe("ThreadDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading skeleton while fetching", () => {
    vi.mocked(threadsApi.detail).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/threads/thread-1"],
    });
    expect(screen.getByTestId("thread-detail-skeleton")).toBeInTheDocument();
  });

  it("renders title when thread loads successfully", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue(mockThread);
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/threads/thread-1"],
    });
    await waitFor(() => {
      // The title appears at least once (may appear in multiple places: left rail, heading)
      const titleElements = screen.getAllByText("Refactor auth module");
      expect(titleElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders Thread and Scope tabs", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue(mockThread);
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/threads/thread-1"],
    });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /thread/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /scope/i })).toBeInTheDocument();
    });
  });

  it("shows error state when fetch fails", async () => {
    vi.mocked(threadsApi.detail).mockRejectedValue(new Error("Network error"));
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/threads/thread-1"],
    });
    await waitFor(() => {
      expect(screen.getByTestId("thread-error-state")).toBeInTheDocument();
    });
  });

  it("renders tab list with correct ARIA roles", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue(mockThread);
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/threads/thread-1"],
    });
    await waitFor(() => {
      expect(screen.getByRole("tablist", { name: "Thread sections" })).toBeInTheDocument();
    });
  });

  it("switches to Scope tab when clicked", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue(mockThread);
    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/threads/thread-1"],
    });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /scope/i })).toBeInTheDocument();
    });
    const scopeTab = screen.getByRole("tab", { name: /scope/i });
    await user.click(scopeTab);
    expect(scopeTab).toHaveAttribute("aria-selected", "true");
  });

  it("renders embedded detail with rounded center and viewer panes", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue(mockThread);

    renderWithProviders(<ThreadDetail embedded />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await waitFor(() => {
      expect(screen.getByTestId("thread-center-panel")).toHaveAttribute("data-pane", "center");
      expect(screen.getByTestId("thread-right-viewer")).toHaveAttribute("data-pane", "viewer");
    });
  });

  it("renders the redesigned header controls without archive or participant-count clutter", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      ownerUserId: "local-board",
      entries: [
        {
          id: "entry-1",
          discussionId: "thread-1",
          inputType: "write",
          rawContent: "Initial thought",
          title: null,
          departmentId: null,
          projectId: null,
          goalId: null,
          sourceInfo: null,
          parentEntryId: null,
          authorAgentId: null,
          extractionStatus: "completed",
          seq: 1,
          createdBy: "local-board",
          createdAt: "2026-01-01T00:00:00Z",
          extractedItems: [],
          annotations: [],
          attachments: [],
        } as any,
      ],
    });

    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    const header = await screen.findByTestId("thread-center-header");

    expect(within(header).getByRole("button", { name: /change autonomy/i })).toHaveTextContent("Assist");
    expect(within(header).getByRole("button", { name: /actions/i })).toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: /archive thread/i })).not.toBeInTheDocument();
    expect(within(header).queryByText(/participant/i)).not.toBeInTheDocument();
  });

  it("shows the backend-derived thread stage in the compact header status", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      phase: "done",
      derivedStage: {
        stage: "discussing",
        label: "Discussing v2",
        versionNumber: 2,
        scopeVersionId: "scope-v1",
        hasNewEntries: true,
        newEntryCount: 3,
      },
    } as ThreadDetailType);

    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    const header = await screen.findByTestId("thread-center-header");

    expect(within(header).getByTestId("thread-derived-stage")).toHaveTextContent("Discussing v2");
    expect(within(header).getByText("3 new messages")).toBeInTheDocument();
  });

  it("loads and passes the current scope version when the Scope tab opens", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      entries: [
        {
          id: "entry-1",
          discussionId: "thread-1",
          inputType: "write",
          rawContent: "We need the checkout task to include the generated architecture document.",
          title: null,
          departmentId: null,
          projectId: null,
          goalId: null,
          sourceInfo: null,
          parentEntryId: null,
          authorAgentId: null,
          authorAgentName: null,
          authorAgentAvatar: null,
          extractionStatus: "completed",
          seq: 1,
          createdBy: "local-board",
          createdAt: "2026-01-01T00:00:00Z",
          extractedItems: [],
          annotations: [],
          attachments: [],
        } as any,
      ],
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Refactor auth into a smaller task package.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Refactor auth into a smaller task package.",
      assumptions: [],
      decisions: [{ text: "Engineer owns the implementation." }],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-1",
          kind: "task_proposal",
          status: "draft",
          title: "Split auth service",
          description: "Create the first implementation task.",
          payload: {},
          sourceEntryIds: [],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: "artifact-version-2",
        },
      ],
    });

    const user = userEvent.setup();
    vi.mocked(artifactsApi.get).mockResolvedValueOnce({
      id: "artifact-1",
      title: "Scope mockup",
      type: "document",
      status: "active",
      description: "Visual source for the scope cards.",
      currentVersionId: "artifact-version-2",
      versions: [
        {
          id: "artifact-version-1",
          versionNumber: 1,
          title: "Scope mockup v1",
          content: "Older mockup content",
          contentType: "text/plain",
          changelog: "Initial pass",
          fileUrl: null,
          assetId: null,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "artifact-version-2",
          versionNumber: 2,
          title: "Scope mockup v2",
          content: "Selected artifact version content",
          contentType: "text/plain",
          changelog: "Added task cards",
          fileUrl: null,
          assetId: null,
          createdAt: "2026-01-02T00:00:00Z",
        },
      ],
    } as any);
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));

    const scopePackage = await screen.findByTestId("scope-version-package");
    expect(scopePackage).toHaveTextContent("Scope v1");
    expect(scopePackage).toHaveTextContent("Refactor auth into a smaller task package.");
    expect(scopePackage).toHaveTextContent("Split auth service");
    expect(threadsApi.listScopeVersions).toHaveBeenCalledWith("comp-1", "thread-1");
    expect(threadsApi.getScopeVersion).toHaveBeenCalledWith("comp-1", "thread-1", "scope-1");
  });

  it("loads an older scope version from the rail as read-only history", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "scoping",
        label: "Scoping v2",
        versionNumber: 2,
        scopeVersionId: "scope-v2",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 2,
      versions: [
        {
          id: "scope-v2",
          threadId: "thread-1",
          versionNumber: 2,
          status: "draft",
          sourceStartSeq: 9,
          sourceEndSeq: 12,
          summary: "Current v2 draft summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
        {
          id: "scope-v1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "accepted",
          sourceStartSeq: 1,
          sourceEndSeq: 8,
          summary: "Accepted handoff summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockImplementation((_companyId, _threadId, scopeVersionId) =>
      Promise.resolve(
        scopeVersionId === "scope-v1"
          ? {
              id: "scope-v1",
              threadId: "thread-1",
              versionNumber: 1,
              status: "accepted",
              sourceStartSeq: 1,
              sourceEndSeq: 8,
              summary: "Accepted handoff summary.",
              assumptions: [],
              decisions: [{ text: "V1 was the first accepted handoff." }],
              openQuestions: [],
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              items: [
                {
                  id: "scope-item-v1",
                  kind: "task_proposal",
                  status: "applied",
                  title: "Accepted historical task",
                  description: "This came from the accepted first scope.",
                  payload: {},
                  sourceEntryIds: ["entry-1"],
                  resultIssueId: "task-1",
                  resultMemoryId: null,
                  artifactId: null,
                  artifactVersionId: null,
                },
              ],
            }
          : {
              id: "scope-v2",
              threadId: "thread-1",
              versionNumber: 2,
              status: "draft",
              sourceStartSeq: 9,
              sourceEndSeq: 12,
              summary: "Current v2 draft summary.",
              assumptions: [],
              decisions: [],
              openQuestions: [],
              createdAt: "2026-01-02T00:00:00Z",
              updatedAt: "2026-01-02T00:00:00Z",
              items: [
                {
                  id: "scope-item-v2",
                  kind: "task_proposal",
                  status: "draft",
                  title: "Current draft task",
                  description: "This is still editable in the current scope.",
                  payload: {},
                  sourceEntryIds: ["entry-9"],
                  resultIssueId: null,
                  resultMemoryId: null,
                  artifactId: null,
                  artifactVersionId: null,
                },
              ],
            },
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    expect(await screen.findByTestId("scope-version-package")).toHaveTextContent("Scope v2");
    expect(screen.getByTestId("scope-version-package")).toHaveTextContent("Current v2 draft summary.");

    await user.click(await screen.findByTestId("scope-version-tab-scope-v1"));

    await waitFor(() => {
      expect(threadsApi.getScopeVersion).toHaveBeenCalledWith("comp-1", "thread-1", "scope-v1");
    });
    expect(await screen.findByTestId("scope-version-package")).toHaveTextContent("Scope v1");
    expect(screen.getByTestId("scope-version-package")).toHaveTextContent("Accepted handoff summary.");
    expect(screen.getByTestId("scope-version-package")).toHaveTextContent("Accepted historical task");
    expect(screen.queryByRole("button", { name: /mark complete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply accepted/i })).not.toBeInTheDocument();
  });

  it("asks the backend to generate a scope draft from the Scope tab", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      summaryText: "Refactor auth into a traceable implementation package.",
    });
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({ versions: [], total: 0 });
    vi.mocked(threadsApi.createScopeDraft).mockResolvedValue({
      status: "created",
      version: {
        id: "scope-new",
        threadId: "thread-1",
        versionNumber: 1,
        status: "draft",
        sourceStartSeq: 1,
        sourceEndSeq: 2,
        summary: "Refactor auth into a traceable implementation package.",
        assumptions: [],
        decisions: [],
        openQuestions: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });

    const user = userEvent.setup();
    vi.mocked(artifactsApi.get).mockResolvedValueOnce({
      id: "artifact-1",
      title: "Scope mockup",
      type: "document",
      status: "active",
      description: "Visual source for the scope cards.",
      currentVersionId: "artifact-version-2",
      versions: [
        {
          id: "artifact-version-1",
          versionNumber: 1,
          title: "Scope mockup v1",
          content: "Older mockup content",
          contentType: "text/plain",
          changelog: "Initial pass",
          fileUrl: null,
          assetId: null,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "artifact-version-2",
          versionNumber: 2,
          title: "Scope mockup v2",
          content: "Selected artifact version content",
          contentType: "text/plain",
          changelog: "Added task cards",
          fileUrl: null,
          assetId: null,
          createdAt: "2026-01-02T00:00:00Z",
        },
      ],
    } as any);
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByRole("button", { name: /create scope draft/i }));

    expect(threadsApi.createScopeDraft).toHaveBeenCalledWith("comp-1", "thread-1", {
      mode: "generate",
    });
  });

  it("opens a linked task viewer when a versioned scope task card is clicked", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "assigned",
        label: "Assigned v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "accepted",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Accepted scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "accepted",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Accepted scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-task",
          kind: "task_proposal",
          status: "applied",
          title: "Build scoped onboarding cleanup",
          description: "Created from accepted scope.",
          payload: {},
          sourceEntryIds: ["entry-1"],
          resultIssueId: "task-1",
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
      ],
    });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-task"));

    const taskPanel = await screen.findByTestId("task-detail-panel");
    expect(taskPanel).toHaveTextContent("Build scoped onboarding cleanup");
    expect(within(taskPanel).getByRole("tab", { name: /overview/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(taskPanel).getByRole("tab", { name: /work/i })).toBeInTheDocument();
    expect(within(taskPanel).getByRole("tab", { name: /comments/i })).toBeInTheDocument();
    expect(within(taskPanel).getByRole("tab", { name: /sub-tasks/i })).toBeInTheDocument();
    expect(within(taskPanel).queryByRole("tab", { name: /artifacts/i })).not.toBeInTheDocument();
    expect(within(taskPanel).getByRole("tab", { name: /activity/i })).toBeInTheDocument();

    await user.click(within(taskPanel).getByRole("tab", { name: /work/i }));
    expect(within(taskPanel).getByText("Workspace")).toBeInTheDocument();
  });

  it("opens a draft task proposal as a task workbench without real task tabs", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Draft scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Draft scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-task",
          kind: "task_proposal",
          status: "draft",
          title: "Implement checkout scope",
          description: "Create the first implementation task.",
          payload: {
            priority: "medium",
            assigneeAgentId: null,
            departmentId: null,
            projectId: null,
            labelIds: ["label-frontend"],
          },
          sourceEntryIds: ["entry-1"],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
      ],
    });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-task"));
    const workbench = await screen.findByTestId("thread-draft-task-workbench");

    expect(workbench).toHaveTextContent("Task draft");
    expect(workbench).toHaveTextContent("Draft");
    expect(within(workbench).getByRole("textbox", { name: /task title/i })).toHaveValue(
      "Implement checkout scope",
    );
    expect(within(workbench).getByRole("textbox", { name: /task description/i })).toHaveValue(
      "Create the first implementation task.",
    );
    expect(workbench).toHaveTextContent("Task setup");
    expect(workbench).toHaveTextContent("Scope handoff");
    expect(workbench).toHaveTextContent("Documents");
    expect(workbench).toHaveTextContent("Documents can be attached after the task is created.");
    expect(workbench).toHaveTextContent("Workspace");
    expect(workbench).toHaveTextContent("Workspace will be created when agent work starts.");
    expect(workbench).toHaveTextContent("Priority");
    expect(workbench).toHaveTextContent("Labels");
    expect(workbench).toHaveTextContent("Assignee");
    expect(workbench).toHaveTextContent("Project");
    expect(workbench).toHaveTextContent("Frontend");
    expect(within(workbench).getByRole("button", { name: /create task/i })).toBeInTheDocument();
    expect(within(workbench).getByRole("button", { name: /save draft/i })).toBeInTheDocument();
    expect(within(workbench).getByRole("button", { name: /^reject$/i })).toBeInTheDocument();
    expect(within(workbench).getByRole("button", { name: /open scope panel/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /comments/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /subtasks/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /activity/i })).not.toBeInTheDocument();
  });

  it("lets a draft task choose its scope handoff context before saving", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      entries: [
        {
          id: "entry-1",
          discussionId: "thread-1",
          inputType: "write",
          rawContent: "We need the checkout task to include the generated architecture document.",
          title: null,
          departmentId: null,
          projectId: null,
          goalId: null,
          sourceInfo: null,
          parentEntryId: null,
          authorAgentId: null,
          authorAgentName: null,
          authorAgentAvatar: null,
          extractionStatus: "completed",
          seq: 1,
          createdBy: "local-board",
          createdAt: "2026-01-01T00:00:00Z",
          extractedItems: [],
          annotations: [],
          attachments: [],
        } as any,
      ],
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 4,
          summary: "Draft scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 4,
      summary: "Draft scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-task",
          kind: "task_proposal",
          status: "draft",
          title: "Implement checkout scope",
          description: "Create the first implementation task.",
          payload: { priority: "medium", assigneeAgentId: null, departmentId: null },
          sourceEntryIds: ["entry-1"],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
        {
          id: "scope-item-doc",
          kind: "artifact_link",
          status: "accepted",
          title: "Document reference",
          description: "Architecture note generated from the thread.",
          payload: { artifactType: "document" },
          sourceEntryIds: ["entry-1"],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: "artifact-document",
          artifactVersionId: "version-document",
        },
        {
          id: "scope-item-asset",
          kind: "source_signal",
          status: "accepted",
          title: "interview-notes.pdf",
          description: "Uploaded research notes.",
          payload: { assetId: "asset-1", contentType: "application/pdf" },
          sourceEntryIds: ["entry-2"],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
        {
          id: "scope-item-url",
          kind: "source_signal",
          status: "accepted",
          title: "Reference URL",
          description: "External source linked in the discussion.",
          payload: { url: "https://example.com/scope-reference" },
          sourceEntryIds: ["entry-3"],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
      ],
    });
    vi.mocked(threadsApi.updateScopeItem).mockResolvedValue({ ok: true, item: {} as any });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-task"));
    const workbench = await screen.findByTestId("thread-draft-task-workbench");

    expect(workbench).toHaveTextContent("Scope handoff");
    expect(within(workbench).getByRole("checkbox", { name: /message 1 - you/i })).toBeChecked();
    expect(workbench).toHaveTextContent("generated architecture document");
    expect(within(workbench).getByRole("checkbox", { name: /document reference/i })).toBeChecked();
    expect(within(workbench).getByRole("checkbox", { name: /interview-notes\.pdf/i })).toBeChecked();
    expect(within(workbench).getByRole("checkbox", { name: /reference url/i })).toBeChecked();

    await user.click(within(workbench).getByRole("checkbox", { name: /reference url/i }));
    await user.click(within(workbench).getByRole("button", { name: /save draft/i }));

    const updateCall = vi.mocked(threadsApi.updateScopeItem).mock.calls.at(-1);
    expect(updateCall?.[0]).toBe("comp-1");
    expect(updateCall?.[2]).toBe("scope-1");
    expect(updateCall?.[3]).toBe("scope-item-task");
    const patch = updateCall?.[4];
    const handoffRefs = patch?.payload?.handoffRefs;
    expect(handoffRefs).toEqual([
      expect.objectContaining({ type: "discussion_entry", id: "entry-1" }),
      expect.objectContaining({ type: "artifact", id: "artifact-document" }),
      expect.objectContaining({ type: "asset", id: "asset-1" }),
    ]);
    expect(handoffRefs).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "url" })]),
    );

    await user.click(within(workbench).getByRole("button", { name: /^open$/i }));
    expect(artifactsApi.get).toHaveBeenCalledWith("artifact-document");
  });

  it.each(["document", "presentation", "code", "design", "report", "other"])(
    "shows %s artifact refs in draft task handoff context",
    async (artifactType) => {
      vi.mocked(threadsApi.detail).mockResolvedValue({
        ...mockThread,
        derivedStage: {
          stage: "scoping",
          label: "Scoping v1",
          versionNumber: 1,
          scopeVersionId: "scope-1",
          hasNewEntries: false,
          newEntryCount: 0,
        },
      } as ThreadDetailType);
      vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
        total: 1,
        versions: [
          {
            id: "scope-1",
            threadId: "thread-1",
            versionNumber: 1,
            status: "draft",
            sourceStartSeq: 1,
            sourceEndSeq: 2,
            summary: "Draft scope summary.",
            assumptions: [],
            decisions: [],
            openQuestions: [],
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
      vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
        id: "scope-1",
        threadId: "thread-1",
        versionNumber: 1,
        status: "draft",
        sourceStartSeq: 1,
        sourceEndSeq: 2,
        summary: "Draft scope summary.",
        assumptions: [],
        decisions: [],
        openQuestions: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        items: [
          {
            id: "scope-item-task",
            kind: "task_proposal",
            status: "draft",
            title: "Implement checkout scope",
            description: "Create the first implementation task.",
            payload: { priority: "medium" },
            sourceEntryIds: ["entry-1"],
            resultIssueId: null,
            resultMemoryId: null,
            artifactId: null,
            artifactVersionId: null,
          },
          {
            id: `scope-item-${artifactType}`,
            kind: "artifact_link",
            status: "accepted",
            title: `${artifactType} reference`,
            description: `${artifactType} source artifact.`,
            payload: { artifactType },
            sourceEntryIds: ["entry-1"],
            resultIssueId: null,
            resultMemoryId: null,
            artifactId: `artifact-${artifactType}`,
            artifactVersionId: `version-${artifactType}`,
          },
        ],
      });

      const user = userEvent.setup();
      renderWithProviders(<ThreadDetail />, {
        initialEntries: ["/TC/discussions/thread-1"],
      });

      await user.click(await screen.findByRole("tab", { name: /scope/i }));
      await user.click(await screen.findByTestId("scope-version-card-scope-item-task"));
      const workbench = await screen.findByTestId("thread-draft-task-workbench");

      expect(within(workbench).getByRole("checkbox", { name: new RegExp(`${artifactType} reference`, "i") })).toBeChecked();
      expect(workbench).toHaveTextContent(artifactType);
    },
  );

  it("edits a draft task proposal from the thread viewer without creating a task", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Draft scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Draft scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-task",
          kind: "task_proposal",
          status: "draft",
          title: "Implement checkout scope",
          description: "Create the first implementation task.",
          payload: { priority: "medium", assigneeAgentId: null, departmentId: null },
          sourceEntryIds: ["entry-1"],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
      ],
    });
    vi.mocked(threadsApi.updateScopeItem).mockResolvedValue({ ok: true, item: {} as any });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-task"));
    const taskActions = await screen.findByTestId("thread-viewer-draft-task-actions");
    expect(taskActions).toHaveClass("flex");
    expect(taskActions).toHaveClass("flex-wrap");
    expect(within(taskActions).getByRole("button", { name: /create task/i })).toBeVisible();
    expect(within(taskActions).getByRole("button", { name: /open scope panel/i })).toBeVisible();
    await user.clear(await screen.findByRole("textbox", { name: /task title/i }));
    await user.type(screen.getByRole("textbox", { name: /task title/i }), "Edited viewer task");
    await user.clear(screen.getByRole("textbox", { name: /task description/i }));
    await user.type(screen.getByRole("textbox", { name: /task description/i }), "Viewer edits stay in the scope draft.");
    await user.click(screen.getByRole("button", { name: /save draft/i }));

    expect(threadsApi.updateScopeItem).toHaveBeenCalledWith(
      "comp-1",
      "thread-1",
      "scope-1",
      "scope-item-task",
      {
        title: "Edited viewer task",
        description: "Viewer edits stay in the scope draft.",
        payload: { priority: "medium", assigneeAgentId: null, departmentId: null },
      },
    );
  });

  it("edits a draft memory candidate from the thread viewer without creating memory", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Draft scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Draft scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-memory",
          kind: "memory_candidate",
          status: "draft",
          title: "Accepted scope versions are handoff source of truth",
          description: "Store accepted scope versions as durable context for future agent work.",
          payload: { category: "decision", layer: "domain", confidence: "high" },
          sourceEntryIds: ["entry-2"],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
      ],
    });
    vi.mocked(threadsApi.updateScopeItem).mockResolvedValue({ ok: true, item: {} as any });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-memory"));

    expect(await screen.findByTestId("thread-draft-memory-viewer")).toHaveTextContent("Draft memory candidate");
    const memoryActions = await screen.findByTestId("thread-viewer-draft-memory-actions");
    expect(memoryActions).toHaveClass("grid");
    expect(within(memoryActions).getByRole("button", { name: /save approved/i })).toBeVisible();
    expect(within(memoryActions).getByRole("button", { name: /save pending/i })).toBeVisible();
    expect(within(memoryActions).getByRole("button", { name: /save changes/i })).toBeVisible();
    expect(within(memoryActions).getByRole("button", { name: /^reject$/i })).toBeVisible();
    expect(within(memoryActions).getByRole("button", { name: /open scope panel/i })).toBeVisible();
    expect(screen.getByLabelText("Layer")).toBeInTheDocument();
    expect(screen.getByLabelText("Department")).toBeInTheDocument();
    expect(screen.getByLabelText("Folder")).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: /draft memory title/i }));
    await user.type(screen.getByRole("textbox", { name: /draft memory title/i }), "Edited memory handoff rule");
    await user.clear(screen.getByRole("textbox", { name: /draft memory content/i }));
    await user.type(screen.getByRole("textbox", { name: /draft memory content/i }), "Agents should retrieve accepted scope before execution.");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(threadsApi.updateScopeItem).toHaveBeenCalledWith(
      "comp-1",
      "thread-1",
      "scope-1",
      "scope-item-memory",
      {
        title: "Edited memory handoff rule",
        description: "Agents should retrieve accepted scope before execution.",
        payload: {
          category: "decision",
          layer: "domain",
          confidence: "high",
          departmentId: null,
          projectId: null,
          goalId: null,
          taskId: null,
          folderPath: "",
          visibility: "scoped",
          priority: 0,
          tags: [],
        },
      },
    );
    expect(memoryApi.create).toBeUndefined();
  });

  it("saves a draft memory candidate as approved by default", async () => {
    setupDraftMemoryCandidate();
    vi.mocked(threadsApi.updateScopeItem).mockResolvedValue({ ok: true, item: {} as any });
    vi.mocked(threadsApi.createScopeOutputItem).mockResolvedValue({
      ok: true,
      item: {
        id: "scope-item-memory",
        kind: "memory_candidate",
        status: "applied",
        title: "Accepted scope versions are handoff source of truth",
        description: "Store accepted scope versions as durable context for future agent work.",
        payload: {},
        sourceEntryIds: [],
        resultIssueId: null,
        resultMemoryId: "memory-1",
        artifactId: null,
        artifactVersionId: null,
      },
      createdMemoryId: "memory-1",
    });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-memory"));
    await user.click(await screen.findByRole("button", { name: /save approved/i }));

    expect(threadsApi.createScopeOutputItem).toHaveBeenCalledWith(
      "comp-1",
      "thread-1",
      "scope-1",
      "scope-item-memory",
      { memoryStatus: "approved" },
    );
  });

  it("can save a draft memory candidate as pending", async () => {
    setupDraftMemoryCandidate();
    vi.mocked(threadsApi.updateScopeItem).mockResolvedValue({ ok: true, item: {} as any });
    vi.mocked(threadsApi.createScopeOutputItem).mockResolvedValue({
      ok: true,
      item: {
        id: "scope-item-memory",
        kind: "memory_candidate",
        status: "applied",
        title: "Accepted scope versions are handoff source of truth",
        description: "Store accepted scope versions as durable context for future agent work.",
        payload: {},
        sourceEntryIds: [],
        resultIssueId: null,
        resultMemoryId: "memory-1",
        artifactId: null,
        artifactVersionId: null,
      },
      createdMemoryId: "memory-1",
    });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-memory"));
    await user.click(await screen.findByRole("button", { name: /save pending/i }));

    expect(threadsApi.createScopeOutputItem).toHaveBeenCalledWith(
      "comp-1",
      "thread-1",
      "scope-1",
      "scope-item-memory",
      { memoryStatus: "pending" },
    );
  });

  it("opens applied memory cards as persisted memory details in the thread viewer", async () => {
    setupAppliedMemoryCandidate();

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-memory"));

    const viewer = await screen.findByTestId("thread-viewer-memory");
    expect(viewer).toHaveTextContent("Founder scope preference");
    const linkedMemoryActions = await screen.findByTestId("thread-viewer-linked-memory-actions");
    expect(linkedMemoryActions).toHaveClass("grid");
    expect(within(linkedMemoryActions).getByRole("button", { name: /edit memory/i })).toBeVisible();
    expect(viewer).toHaveTextContent("Accepted scope is the handoff source of truth.");
    expect(viewer).toHaveTextContent("domain");
    expect(viewer).toHaveTextContent("Product");
    expect(viewer).toHaveTextContent("artifact-1");
    expect(viewer).toHaveTextContent("task-1");
    expect(viewer).toHaveTextContent("scope-item-memory");
  });

  it("allows pending saved memory to be approved from the thread viewer", async () => {
    setupAppliedMemoryCandidate({ status: "pending" });
    vi.mocked(memoryApi.approve).mockResolvedValue({ id: "memory-1", status: "approved" } as any);

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-memory"));
    await user.click(await screen.findByRole("button", { name: /^approve$/i }));

    expect(memoryApi.approve).toHaveBeenCalledWith("comp-1", "memory-1");
  });

  it("edits saved memory content from the thread viewer", async () => {
    setupAppliedMemoryCandidate({ status: "approved" });
    vi.mocked(memoryApi.update).mockResolvedValue({ id: "memory-1", title: "Edited memory rule", status: "approved" } as any);

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-memory"));
    await user.click(await screen.findByRole("button", { name: /edit memory/i }));
    await user.clear(screen.getByRole("textbox", { name: /memory title/i }));
    await user.type(screen.getByRole("textbox", { name: /memory title/i }), "Edited memory rule");
    await user.clear(screen.getByRole("textbox", { name: /memory content/i }));
    await user.type(screen.getByRole("textbox", { name: /memory content/i }), "Use accepted scope as the execution handoff.");
    await user.click(screen.getByRole("button", { name: /save memory/i }));

    expect(memoryApi.update).toHaveBeenCalledWith(
      "comp-1",
      "memory-1",
      expect.objectContaining({
        title: "Edited memory rule",
        content: "Use accepted scope as the execution handoff.",
      }),
    );
  });

  it("shows placement controls while editing saved memory from the thread viewer", async () => {
    setupAppliedMemoryCandidate({
      status: "approved",
      folderPath: "software-test/Overview",
      projectId: "project-1",
      goalId: "goal-1",
      taskId: "task-1",
      priority: 2,
      tags: ["scope", "handoff"],
    });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-memory"));
    await user.click(await screen.findByRole("button", { name: /edit memory/i }));

    expect(await screen.findByLabelText(/memory title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/memory content/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Category")).toBeInTheDocument();
    expect(screen.getByLabelText("Layer")).toBeInTheDocument();
    expect(screen.getByLabelText("Department")).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toBeInTheDocument();
    expect(screen.getByLabelText("Goal")).toBeInTheDocument();
    expect(screen.getByLabelText("Task")).toBeInTheDocument();
    expect(screen.getByLabelText("Folder")).toBeInTheDocument();
    expect(screen.getByLabelText("Priority")).toBeInTheDocument();
    expect(screen.getByLabelText("Tags")).toBeInTheDocument();
  });

  it("moves and re-scopes saved memory from the thread viewer", async () => {
    setupAppliedMemoryCandidate({
      status: "approved",
      layer: "active_context",
      departmentId: null,
      projectId: "project-1",
      goalId: "goal-1",
      taskId: null,
      folderPath: null,
    });
    vi.mocked(memoryApi.update).mockResolvedValue({ id: "memory-1", status: "approved" } as any);
    vi.mocked(memoryApi.moveItem).mockResolvedValue({ id: "memory-1", folderPath: "software-test/Overview" } as any);
    vi.mocked(memoryApi.changeLayer).mockResolvedValue({ id: "memory-1", layer: "domain" } as any);

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-memory"));
    await user.click(await screen.findByRole("button", { name: /edit memory/i }));
    await user.selectOptions(await screen.findByLabelText("Layer"), "domain");
    await user.selectOptions(screen.getByLabelText("Department"), "dept-product");
    await user.selectOptions(screen.getByLabelText("Folder"), "software-test/Overview");
    await user.click(screen.getByRole("button", { name: /save memory/i }));

    await waitFor(() => {
      expect(memoryApi.update).toHaveBeenCalledWith(
        "comp-1",
        "memory-1",
        expect.objectContaining({
          title: "Founder scope preference",
          content: "Accepted scope is the handoff source of truth.",
          category: "decision",
        }),
      );
    });
    expect(memoryApi.moveItem).toHaveBeenCalledWith("comp-1", "memory-1", "software-test/Overview");
    expect(memoryApi.changeLayer).toHaveBeenCalledWith(
      "comp-1",
      "memory-1",
      expect.objectContaining({
        newLayer: "domain",
        departmentId: "dept-product",
      }),
    );
  });

  it("creates a draft task scope output through the thread API", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Draft scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Draft scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-task",
          kind: "task_proposal",
          status: "draft",
          title: "Implement checkout scope",
          description: "Create the first implementation task.",
          payload: {},
          sourceEntryIds: [],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
      ],
    });
    vi.mocked(threadsApi.createScopeOutputItem).mockResolvedValue({
      ok: true,
      item: {
        id: "scope-item-task",
        kind: "task_proposal",
        status: "applied",
        title: "Implement checkout scope",
        description: "Create the first implementation task.",
        payload: {},
        sourceEntryIds: [],
        resultIssueId: "task-1",
        resultMemoryId: null,
        artifactId: null,
        artifactVersionId: null,
      },
      createdTask: {
        id: "task-1",
        assigneeAgentId: null,
        workMode: "standard",
      },
    });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(
      within(await screen.findByTestId("scope-version-card-scope-item-task")).getByRole("button", {
        name: /^review task$/i,
      }),
    );
    await user.click(await screen.findByRole("button", { name: /^create task$/i }));

    expect(threadsApi.createScopeOutputItem).toHaveBeenCalledWith(
      "comp-1",
      "thread-1",
      "scope-1",
      "scope-item-task",
    );
    expect(await screen.findByTestId("task-detail-panel")).toBeInTheDocument();
  });

  it("shows backend stale scope message when creating a scope output fails", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Draft scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Draft scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-task",
          kind: "task_proposal",
          status: "draft",
          title: "Implement checkout scope",
          description: "Create the first implementation task.",
          payload: {},
          sourceEntryIds: [],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
      ],
    });
    vi.mocked(threadsApi.updateScopeItem).mockResolvedValue({ ok: true, item: {} as any });
    vi.mocked(threadsApi.createScopeOutputItem).mockRejectedValue({
      response: { data: { error: "Scope draft is stale because the thread has newer human entries" } },
      message: "Request failed with status code 409",
    });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(
      within(await screen.findByTestId("scope-version-card-scope-item-task")).getByRole("button", {
        name: /^review task$/i,
      }),
    );
    await user.click(await screen.findByRole("button", { name: /^create task$/i }));

    await waitFor(() => {
      expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "Scope draft is stale because the thread has newer human entries",
        tone: "warn",
      }));
    });
  });

  it("applies accepted scope cards through the thread API", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Draft scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Draft scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-task",
          kind: "task_proposal",
          status: "accepted",
          title: "Implement checkout scope",
          description: "Create the first implementation task.",
          payload: {},
          sourceEntryIds: [],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
      ],
    });
    vi.mocked(threadsApi.applyScopeVersion).mockResolvedValue({ ok: true, appliedItems: [] });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    // Wait until the scope version has loaded so the baseline refetch count is stable.
    await screen.findByRole("button", { name: /apply accepted/i });
    const scopeFetchesBeforeApply = vi.mocked(threadsApi.getScopeVersion).mock.calls.length;

    await user.click(screen.getByRole("button", { name: /apply accepted/i }));

    expect(threadsApi.applyScopeVersion).toHaveBeenCalledWith("comp-1", "thread-1", "scope-1");
    // On success the component invalidates the scope-versions cache, which must
    // refetch the active scope version (applyScopeMutation.onSuccess →
    // invalidateScopeVersionsOnly + invalidateThread).
    await waitFor(() => {
      expect(vi.mocked(threadsApi.getScopeVersion).mock.calls.length).toBeGreaterThan(
        scopeFetchesBeforeApply,
      );
    });
  });

  it("refetches the scope-versions cache after accepting scope cards", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Draft scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Draft scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-task",
          kind: "task_proposal",
          status: "draft",
          title: "Implement checkout scope",
          description: "Create the first implementation task.",
          payload: {},
          sourceEntryIds: [],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
      ],
    });
    vi.mocked(threadsApi.reviewScopeItems).mockResolvedValue({ ok: true, items: [] } as any);

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    const acceptAll = await screen.findByRole("button", { name: /accept all/i });
    const scopeFetchesBeforeReview = vi.mocked(threadsApi.getScopeVersion).mock.calls.length;

    await user.click(acceptAll);

    expect(threadsApi.reviewScopeItems).toHaveBeenCalledWith("comp-1", "thread-1", "scope-1", {
      items: [{ itemId: "scope-item-task", status: "accepted" }],
    });
    // reviewScopeItemsMutation.onSuccess → invalidateScopeVersionsOnly, so the
    // active scope version must refetch after the review succeeds.
    await waitFor(() => {
      expect(vi.mocked(threadsApi.getScopeVersion).mock.calls.length).toBeGreaterThan(
        scopeFetchesBeforeReview,
      );
    });
  });

  it("updates an edited draft scope card from the right viewer", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Draft scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Draft scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-task",
          kind: "task_proposal",
          status: "draft",
          title: "Implement checkout scope",
          description: "Create the first implementation task.",
          payload: {},
          sourceEntryIds: [],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
      ],
    });
    vi.mocked(threadsApi.updateScopeItem).mockResolvedValue({ ok: true, item: {} as any });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(
      within(await screen.findByTestId("scope-version-card-scope-item-task")).getByRole("button", {
        name: /edit in viewer/i,
      }),
    );
    await user.clear(await screen.findByRole("textbox", { name: /task title/i }));
    await user.type(screen.getByRole("textbox", { name: /task title/i }), "Edited checkout scope");
    await user.click(screen.getByRole("button", { name: /save draft/i }));

    expect(threadsApi.updateScopeItem).toHaveBeenCalledWith(
      "comp-1",
      "thread-1",
      "scope-1",
      "scope-item-task",
      {
        title: "Edited checkout scope",
        description: "Create the first implementation task.",
        payload: {},
      },
    );
  });

  it("opens artifact and source signal cards in the right viewer", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Draft scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Draft scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-artifact",
          kind: "artifact_link",
          status: "draft",
          title: "Scope mockup",
          description: "Attached mockup used as the requirement source.",
          payload: { role: "reference" },
          sourceEntryIds: ["entry-2"],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: "artifact-1",
          artifactVersionId: "artifact-version-2",
        },
        {
          id: "scope-item-source",
          kind: "source_signal",
          status: "draft",
          title: "Checkout notes attachment",
          description: "Use this file as evidence for the draft scope.",
          payload: {
            assetId: "asset-1",
            contentType: "text/markdown",
            filename: "checkout-notes.md",
            role: "evidence",
          },
          sourceEntryIds: ["entry-3"],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: null,
          artifactVersionId: null,
        },
      ],
    });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));
    await user.click(await screen.findByTestId("scope-version-card-scope-item-artifact"));

    await waitFor(() => {
      expect(screen.getByTestId("thread-artifact-viewer")).toHaveTextContent("v2");
    });
    expect(screen.getByTestId("thread-artifact-viewer")).toHaveTextContent("Selected artifact version content");
    expect(screen.getByTestId("thread-artifact-viewer")).toHaveTextContent("document");
    expect(screen.getByTestId("thread-artifact-viewer")).toHaveTextContent("active");
    expect(screen.getByTestId("thread-artifact-viewer")).toHaveTextContent("Added task cards");
    expect(screen.getByTestId("thread-artifact-viewer")).toHaveTextContent("scope-item-artifact");

    await user.click(screen.getByTestId("scope-version-accordion-source-notes"));
    await user.click(screen.getByTestId("scope-version-card-scope-item-source"));

    const viewer = await screen.findByTestId("thread-asset-viewer");
    expect(viewer).toHaveTextContent("checkout-notes.md");
  });

  it("uses Create scope draft for a first scope even when the thread has messages", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "discussing",
        label: "Discussing v1",
        versionNumber: 1,
        scopeVersionId: null,
        hasNewEntries: true,
        newEntryCount: 1,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({ versions: [], total: 0 });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await user.click(await screen.findByRole("tab", { name: /scope/i }));

    expect(await screen.findByRole("button", { name: /create scope draft/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^re-scope$/i })).not.toBeInTheDocument();
  });

  it("closes the autonomy dropdown on outside click and Escape", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      ownerUserId: "local-board",
      autonomyLevel: 0,
    });
    const user = userEvent.setup();

    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    const header = await screen.findByTestId("thread-center-header");
    const autonomyButton = within(header).getByRole("button", { name: /change autonomy/i });
    await user.click(autonomyButton);

    expect(await screen.findByText("Autonomy")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("Drive")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(screen.queryByText("Drive")).not.toBeInTheDocument();
    });

    await user.click(autonomyButton);
    expect(await screen.findByText("Drive")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByText("Drive")).not.toBeInTheDocument();
    });
  });

  it("shows the next line only when summaryNext is available", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      ownerUserId: "local-board",
      summaryNext: null,
    });

    const { unmount } = renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });
    await screen.findByTestId("thread-center-header");
    expect(screen.queryByText(/^Next:/i)).not.toBeInTheDocument();
    unmount();

    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      ownerUserId: "local-board",
      summaryNext: "Refine the candidate scope before assigning work.",
    });

    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });
    expect(await screen.findByText(/^Next:/i)).toBeInTheDocument();
    expect(screen.getByText(/Refine the candidate scope/i)).toBeInTheDocument();
  });

  it("does not report viewer-wide auto-collapse while resizing the viewer", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue(mockThread);
    const onViewerWideChange = vi.fn();

    renderWithProviders(<ThreadDetail embedded onViewerWideChange={onViewerWideChange} />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    const viewer = await screen.findByTestId("thread-right-viewer");
    const resizeHandle = screen.getByRole("separator", { name: /resize viewer/i });

    fireEvent.pointerDown(resizeHandle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(resizeHandle, { clientX: -140, pointerId: 1 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 1 });

    await waitFor(() => {
      expect(viewer).toHaveAttribute("data-width", "580");
    });
    expect(onViewerWideChange).not.toHaveBeenCalled();
  });

  it("continues resizing when the pointer leaves the thin separator", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue(mockThread);

    renderWithProviders(<ThreadDetail embedded />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    const viewer = await screen.findByTestId("thread-right-viewer");
    const resizeHandle = screen.getByRole("separator", { name: /resize viewer/i });

    fireEvent.pointerDown(resizeHandle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: -160, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });

    await waitFor(() => {
      expect(viewer).toHaveAttribute("data-width", "600");
    });
  });

  it("allows the discussion viewer to grow wider on desktop without collapsing the thread", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue(mockThread);
    vi.stubGlobal("innerWidth", 1440);

    renderWithProviders(<ThreadDetail embedded />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    const viewer = await screen.findByTestId("thread-right-viewer");
    const resizeHandle = screen.getByRole("separator", { name: /resize viewer/i });

    fireEvent.pointerDown(resizeHandle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: -700, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });

    await waitFor(() => {
      const width = Number(viewer.getAttribute("data-width"));
      expect(width).toBeGreaterThan(680);
      expect(width).toBeLessThanOrEqual(920);
    });
  });

  it("allows closing the Open tab and reopening it from the add button", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue(mockThread);
    const user = userEvent.setup();

    renderWithProviders(<ThreadDetail embedded />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await screen.findByTestId("thread-open-viewer");
    await user.click(screen.getByRole("button", { name: /close open/i }));

    expect(screen.getByTestId("thread-viewer-empty")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open viewer tab/i }));

    expect(screen.getByTestId("thread-open-viewer")).toBeInTheDocument();
  });

  it("shows open viewer tabs as icons while the right viewer is collapsed", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue(mockThread);
    const user = userEvent.setup();

    renderWithProviders(<ThreadDetail embedded />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await screen.findByTestId("thread-open-viewer");
    await user.click(screen.getByRole("button", { name: /hide preview/i }));

    const strip = screen.getByTestId("thread-viewer-collapsed-strip");
    expect(strip).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: /^open$/i })).toBeInTheDocument();
  });

  it("opens localhost browser previews with the same http default as Workspace", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue(mockThread);
    const user = userEvent.setup();

    renderWithProviders(<ThreadDetail embedded />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await screen.findByTestId("thread-open-viewer");
    await user.click(screen.getByText("New browser"));

    const input = screen.getByTestId("thread-browser-url-input");
    await user.clear(input);
    await user.type(input, "localhost:3100/api/health");
    await user.click(screen.getByRole("button", { name: /^open$/i }));

    expect(screen.getByTestId("thread-browser-iframe")).toHaveAttribute(
      "src",
      "http://localhost:3100/api/health",
    );
  });

  it("shows scope-linked artifacts in the Open viewer even when entries have no attachments", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      derivedStage: {
        stage: "scoping",
        label: "Scoping v1",
        versionNumber: 1,
        scopeVersionId: "scope-1",
        hasNewEntries: false,
        newEntryCount: 0,
      },
    } as ThreadDetailType);
    vi.mocked(threadsApi.listScopeVersions).mockResolvedValue({
      total: 1,
      versions: [
        {
          id: "scope-1",
          threadId: "thread-1",
          versionNumber: 1,
          status: "draft",
          sourceStartSeq: 1,
          sourceEndSeq: 2,
          summary: "Draft scope summary.",
          assumptions: [],
          decisions: [],
          openQuestions: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    vi.mocked(threadsApi.getScopeVersion).mockResolvedValue({
      id: "scope-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
      summary: "Draft scope summary.",
      assumptions: [],
      decisions: [],
      openQuestions: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "scope-item-artifact",
          kind: "artifact_link",
          status: "draft",
          title: "discussion-scope-notes.md",
          description: "Artifact candidate created by Planner.",
          payload: { content: "# Decisions\nUse accepted scope as the handoff." },
          sourceEntryIds: [],
          resultIssueId: null,
          resultMemoryId: null,
          artifactId: "artifact-1",
          artifactVersionId: "artifact-version-1",
        },
      ],
    });

    const user = userEvent.setup();
    renderWithProviders(<ThreadDetail embedded />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    const openViewer = await screen.findByTestId("thread-open-viewer");
    await waitFor(() => expect(openViewer).toHaveTextContent("discussion-scope-notes.md"));
    expect(openViewer).toHaveTextContent("Scope");

    await user.click(screen.getAllByRole("button", { name: /discussion-scope-notes\.md/i }).at(-1)!);
    expect(artifactsApi.get).toHaveBeenCalledWith("artifact-1");
  });

  it("keeps browser viewer URL state isolated when switching link tabs", async () => {
    vi.mocked(threadsApi.detail).mockResolvedValue({
      ...mockThread,
      entries: [
        {
          id: "entry-1",
          discussionId: "thread-1",
          inputType: "paste",
          rawContent: "Compare https://example.com and https://openai.com for this thread.",
          title: null,
          departmentId: null,
          projectId: null,
          goalId: null,
          sourceInfo: null,
          parentEntryId: null,
          authorAgentId: null,
          extractionStatus: "skipped",
          seq: 1,
          createdBy: "user-1",
          createdAt: "2026-01-01T00:00:00Z",
          extractedItems: [],
          annotations: [],
          attachments: [],
        } as any,
      ],
    });
    const user = userEvent.setup();

    renderWithProviders(<ThreadDetail embedded />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await screen.findByTestId("thread-open-viewer");
    await user.click(screen.getByRole("button", { name: "https://example.com/" }));
    expect(screen.getByTestId("thread-browser-iframe")).toHaveAttribute("src", "https://example.com/");

    await user.click(screen.getByRole("tab", { name: /^open$/i }));
    await user.click(screen.getByRole("button", { name: "https://openai.com/" }));
    expect(screen.getByTestId("thread-browser-iframe")).toHaveAttribute("src", "https://openai.com/");

    await user.click(screen.getByRole("tab", { name: /example\.com/i }));
    expect(screen.getByTestId("thread-browser-iframe")).toHaveAttribute("src", "https://example.com/");
  });
});
