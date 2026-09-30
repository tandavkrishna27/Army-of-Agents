import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

// These tests render a multi-query page; give enough headroom for slow CI runs.
vi.setConfig({ testTimeout: 15000 });
import { MemoryRouter, Route, Routes } from "react-router-dom";
import userEvent from "@testing-library/user-event";
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
};

function makeDiscussion(overrides: Record<string, unknown> = {}) {
  return {
    id: "disc-1",
    title: "Sprint Planning Notes",
    status: "active",
    scopeType: "department",
    scopeId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    scopeName: "Engineering",
    tags: ["planning"],
    entryCount: 3,
    pendingItemCount: 2,
    lastEntryAt: "2026-03-20T10:00:00Z",
    lastEntryInputType: "paste",
    createdBy: "user-1",
    createdAt: "2026-03-20T08:00:00Z",
    ...overrides,
  };
}

const scopedDiscussions = [
  makeDiscussion(),
  makeDiscussion({
    id: "disc-2",
    title: "Architecture Review",
    pendingItemCount: 0,
    entryCount: 1,
    lastEntryInputType: "voice",
    tags: [],
  }),
];

const mockListResponse = {
  discussions: scopedDiscussions,
  total: scopedDiscussions.length,
  limit: 20,
  offset: 0,
};

// --- Mocks ---

const discussionsApiMock = {
  list: vi.fn().mockResolvedValue(mockListResponse),
};

const projectsApiMock = {
  get: vi.fn().mockResolvedValue(mockProject),
  update: vi.fn().mockResolvedValue(mockProject),
  listAgents: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([mockProject]),
  budget: vi.fn().mockResolvedValue({ agents: [], totalSpendCents: 0 }),
  assignAgent: vi.fn(),
  unassignAgent: vi.fn(),
};

vi.mock("../components/TaskSlideOver", () => ({
  TaskSlideOver: () => null,
}));

vi.mock("../api/discussions", () => ({
  discussionsApi: new Proxy(
    {},
    { get: (_t, prop) => (discussionsApiMock as any)[prop] },
  ),
}));

vi.mock("../api/projects", () => ({
  projectsApi: new Proxy(
    {},
    { get: (_t, prop) => (projectsApiMock as any)[prop] },
  ),
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
  vi.clearAllMocks();
  projectsApiMock.get.mockResolvedValue(mockProject);
  discussionsApiMock.list.mockResolvedValue(mockListResponse);
});

afterEach(() => {
  cleanup();
});

// --- Tests ---

describe("ProjectDetail — Discussions tab", () => {
  it("renders a Discussions tab button", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/discussions");

    await screen.findByText("Sprint Planning Notes", {}, { timeout: 5000 });

    // Tab buttons are plain <button> elements, not role="button" accessible
    const tabButtons = await screen.findAllByText("Discussions");
    expect(tabButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("shows discussions list when Discussions tab is active", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/discussions");

    await screen.findByText("Sprint Planning Notes", {}, { timeout: 5000 });
    await screen.findByText("Architecture Review");
  });

  it("fetches discussions filtered by project scope", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/discussions");

    await waitFor(() => {
      expect(discussionsApiMock.list).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({ scopeId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" }),
      );
    }, { timeout: 5000 });
  });

  it("shows New Discussion button that opens capture modal pre-scoped", async () => {
    const user = userEvent.setup();
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/discussions");

    await screen.findByText("Sprint Planning Notes", {}, { timeout: 5000 });

    await user.click(await screen.findByRole("button", { name: /new discussion/i }, { timeout: 5000 }));
    await waitFor(() => {
      expect(mockDialogContext.openDiscussionCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeType: "department",
          scopeId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        }),
      );
    });
  });

  it("shows pending badge count on discussions", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/discussions");

    await screen.findByText("2 pending", {}, { timeout: 5000 });
  });

  it("shows discussion count header", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/discussions");

    await screen.findByText("2 discussions", {}, { timeout: 5000 });
  });

  it("shows empty state when no discussions for this project", async () => {
    discussionsApiMock.list.mockResolvedValue({
      discussions: [],
      total: 0,
      limit: 20,
      offset: 0,
    });

    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/discussions");

    await screen.findByText(/No discussions/, {}, { timeout: 5000 });
  });

  it("shows the Discussions tab alongside other tabs", async () => {
    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/discussions");

    await screen.findByText("Sprint Planning Notes", {}, { timeout: 5000 });

    // All tabs should be visible
    await screen.findByText("Overview");
    await screen.findByText("Board");
    await screen.findByText("Goals");
    await screen.findByText("Team");
    await screen.findByText("Budget");
    await screen.findByText("Discussions");
  });

  it("uses correct scope type based on project type", async () => {
    // For a project (not department)
    projectsApiMock.get.mockResolvedValue({
      ...mockProject,
      type: "project",
    });

    renderProjectDetail("/projects/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/discussions");

    await waitFor(() => {
      expect(discussionsApiMock.list).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({ scopeType: "project" }),
      );
    }, { timeout: 5000 });
  });
});
