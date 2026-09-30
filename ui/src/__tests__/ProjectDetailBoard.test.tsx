import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

// These tests render a multi-query page; give enough headroom for slow CI runs.
vi.setConfig({ testTimeout: 15000 });
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  mockCompanyContext,
  mockBreadcrumbContext,
  mockDialogContext,
} from "./test-utils";
import { ProjectDetail } from "../pages/ProjectDetail";

// --- Mock TaskSlideOver ---

vi.mock("../components/TaskSlideOver", () => ({
  TaskSlideOver: ({
    issueId,
    open,
    onClose,
  }: {
    issueId: string | null;
    open: boolean;
    onClose: () => void;
  }) =>
    open ? (
      <div data-testid="task-slide-over" data-issue-id={issueId ?? ""}>
        <button onClick={onClose}>Close Panel</button>
      </div>
    ) : null,
}));

// --- Mock KanbanBoard (avoids dnd-kit in jsdom) ---
// Capture the cardVariant prop so we can assert the project board renders the
// STANDARD (un-enriched) card — IssuesList must not pass cardVariant, so the
// board inherits the "standard" default.
const lastKanbanProps: { cardVariant?: string } = {};

vi.mock("../components/KanbanBoard", () => ({
  KanbanBoard: ({
    issues,
    cardVariant,
    onSelectIssue,
  }: {
    issues: Array<{ id: string; identifier?: string; title: string }>;
    cardVariant?: string;
    onSelectIssue?: (id: string) => void;
  }) => {
    lastKanbanProps.cardVariant = cardVariant;
    return (
      <div data-testid="kanban-board" data-card-variant={cardVariant ?? "(default)"}>
        {issues.map((issue) => (
          <button
            key={issue.id}
            data-testid={`task-card-${issue.identifier ?? issue.id}`}
            onClick={() => onSelectIssue?.(issue.identifier ?? issue.id)}
          >
            {issue.title}
          </button>
        ))}
      </div>
    );
  },
}));

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
};

const mockIssue = {
  id: "issue-uuid-1",
  identifier: "TC-1",
  title: "Fix the bug",
  status: "todo",
  priority: "medium",
  projectId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  companyId: "comp-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  labelIds: [],
  labels: [],
  assigneeAgentId: null,
  assigneeUserId: null,
  description: null,
  goalId: null,
  parentId: null,
  simpleId: 1,
};

// --- API mocks ---

const projectsApiMock = {
  get: vi.fn().mockResolvedValue(mockProject),
  update: vi.fn().mockResolvedValue(mockProject),
  listAgents: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([mockProject]),
  budget: vi.fn().mockResolvedValue({ agents: [], totalSpendCents: 0 }),
  assignAgent: vi.fn(),
  unassignAgent: vi.fn(),
};

const issuesApiMock = {
  list: vi.fn().mockResolvedValue([mockIssue]),
  update: vi.fn().mockResolvedValue(mockIssue),
};

vi.mock("../api/projects", () => ({
  projectsApi: new Proxy(
    {},
    { get: (_t, prop) => (projectsApiMock as any)[prop] },
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: new Proxy(
    {},
    { get: (_t, prop) => (issuesApiMock as any)[prop] },
  ),
}));

vi.mock("../api/discussions", () => ({
  discussionsApi: {
    list: vi.fn().mockResolvedValue({ discussions: [], total: 0, limit: 20, offset: 0 }),
  },
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

vi.mock("../lib/utils", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    projectRouteRef: (p: any) => p.simpleId ?? p.id,
  };
});

// --- Render helper ---

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
          <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
          <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
          <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
          <Route path="projects/:projectId/goals" element={<ProjectDetail />} />
          <Route path="projects/:projectId/team" element={<ProjectDetail />} />
          <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
          <Route path="projects/:projectId/discussions" element={<ProjectDetail />} />
          <Route path="projects/:projectId" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  projectsApiMock.get.mockResolvedValue(mockProject);
  issuesApiMock.list.mockResolvedValue([mockIssue]);
});

afterEach(() => {
  cleanup();
});

// --- Tests ---

describe("ProjectDetail — Board tab task scope", () => {
  it("loads the project board with the org default (no taskScope) so crew tasks stay off the project board", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/issues");

    await screen.findByTestId("kanban-board", {}, { timeout: 5000 });

    // The project board's issue list is scoped by projectId and inherits the
    // fail-safe 'org' default — it must NOT opt into taskScope:'crew'|'all'.
    const projectListCall = issuesApiMock.list.mock.calls.find(
      ([, filters]) => (filters as { projectId?: string } | undefined)?.projectId,
    );
    expect(projectListCall).toBeTruthy();
    const filters = projectListCall![1] as { projectId?: string; taskScope?: string };
    expect(filters.projectId).toBe("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");
    expect(filters.taskScope).toBeUndefined();

    // IssuesList does not pass cardVariant → the board renders the STANDARD
    // (un-enriched) card, not the crew variant.
    expect(lastKanbanProps.cardVariant).toBeUndefined();
  });
});

describe("ProjectDetail — Board tab TaskSlideOver", () => {
  it("TaskSlideOver is not visible before any task is clicked", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/issues");

    await screen.findByTestId("kanban-board", {}, { timeout: 5000 });

    expect(screen.queryByTestId("task-slide-over")).not.toBeInTheDocument();
  });

  it("clicking a task in the Board tab opens the TaskSlideOver", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/issues");

    fireEvent.click(await screen.findByTestId("task-card-TC-1", {}, { timeout: 5000 }));

    await screen.findByTestId("task-slide-over", {}, { timeout: 5000 });
  });

  it("TaskSlideOver receives the clicked task identifier as issueId", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/issues");

    fireEvent.click(await screen.findByTestId("task-card-TC-1", {}, { timeout: 5000 }));

    const slideOver = await screen.findByTestId("task-slide-over", {}, { timeout: 5000 });
    expect(slideOver).toHaveAttribute("data-issue-id", "TC-1");
  });

  it("closing the TaskSlideOver hides it", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/issues");

    // Open the slide-over
    fireEvent.click(await screen.findByTestId("task-card-TC-1", {}, { timeout: 5000 }));
    await screen.findByTestId("task-slide-over", {}, { timeout: 5000 });

    // Close it
    fireEvent.click(await screen.findByText("Close Panel", {}, { timeout: 5000 }));
    await waitFor(() => {
      expect(screen.queryByTestId("task-slide-over")).not.toBeInTheDocument();
    });
  });
});
