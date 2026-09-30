import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  renderWithProviders,
  mockCompanyContext,
  mockBreadcrumbContext,
  mockDialogContext,
} from "./test-utils";
import { Discussions } from "../pages/Discussions";

// --- Mock data ---

function makeDiscussion(overrides: Record<string, unknown> = {}) {
  return {
    id: "disc-1",
    title: "Q1 Planning Session",
    status: "active",
    scopeType: "department",
    scopeId: "dept-1",
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

const discussions = [
  makeDiscussion(),
  makeDiscussion({
    id: "disc-2",
    title: "Design Review Notes",
    scopeName: "Design",
    pendingItemCount: 0,
    entryCount: 1,
    lastEntryAt: "2026-03-19T15:00:00Z",
    lastEntryInputType: "voice",
    tags: [],
  }),
  makeDiscussion({
    id: "disc-3",
    title: "MCP Integration Debrief",
    scopeName: null,
    pendingItemCount: 5,
    entryCount: 2,
    lastEntryAt: "2026-03-21T09:00:00Z",
    lastEntryInputType: "mcp",
    tags: ["integration"],
  }),
];

const mockListResponse = {
  discussions,
  total: discussions.length,
  limit: 20,
  offset: 0,
};

// --- Mocks ---

const discussionsApiMock = {
  list: vi.fn().mockResolvedValue(mockListResponse),
};

vi.mock("../api/discussions", () => ({
  discussionsApi: new Proxy(
    {},
    { get: (_t, prop) => (discussionsApiMock as any)[prop] },
  ),
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ ...mockCompanyContext, selectedCompanyId: "comp-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbContext,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => mockDialogContext,
}));

beforeEach(() => {
  vi.clearAllMocks();
  discussionsApiMock.list.mockResolvedValue(mockListResponse);
});

// --- Tests ---

describe("Discussions list page", () => {
  it("renders discussion rows with title and metadata", async () => {
    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(screen.getByText("Q1 Planning Session")).toBeInTheDocument();
    });

    expect(screen.getByText("Design Review Notes")).toBeInTheDocument();
    expect(screen.getByText("MCP Integration Debrief")).toBeInTheDocument();
  });

  it("shows pending badge count on discussions with pending items", async () => {
    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(screen.getByText("2 pending")).toBeInTheDocument();
    });

    expect(screen.getByText("5 pending")).toBeInTheDocument();
  });

  it("shows scope name badges", async () => {
    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(screen.getByText("Engineering")).toBeInTheDocument();
    });

    expect(screen.getByText("Design")).toBeInTheDocument();
  });

  it("shows entry count for each discussion", async () => {
    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(screen.getByText("3 entries")).toBeInTheDocument();
    });

    expect(screen.getByText("1 entry")).toBeInTheDocument();
    expect(screen.getByText("2 entries")).toBeInTheDocument();
  });

  it("shows tag badges", async () => {
    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(screen.getByText("planning")).toBeInTheDocument();
    });

    expect(screen.getByText("integration")).toBeInTheDocument();
  });

  it("renders status filter chips with correct counts", async () => {
    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(screen.getByText(`All (${discussions.length})`)).toBeInTheDocument();
    });

    // 2 discussions have pending items
    expect(screen.getByText("Needs Review (2)")).toBeInTheDocument();
    // 1 discussion has 0 pending items
    expect(screen.getByText("All Reviewed (1)")).toBeInTheDocument();
  });

  it("filters to discussions with pending items when Needs Review is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(screen.getByText("Q1 Planning Session")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Needs Review (2)"));

    // Design Review Notes has 0 pending → should be hidden
    expect(screen.queryByText("Design Review Notes")).not.toBeInTheDocument();
    // Other two should still be visible
    expect(screen.getByText("Q1 Planning Session")).toBeInTheDocument();
    expect(screen.getByText("MCP Integration Debrief")).toBeInTheDocument();
  });

  it("renders New Discussion button", async () => {
    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(screen.getByText("New Discussion")).toBeInTheDocument();
    });
  });

  it("calls openDiscussionCapture when New Discussion is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(screen.getByText("New Discussion")).toBeInTheDocument();
    });

    await user.click(screen.getByText("New Discussion"));
    expect(mockDialogContext.openDiscussionCapture).toHaveBeenCalled();
  });

  it("shows empty state when no discussions", async () => {
    discussionsApiMock.list.mockResolvedValue({
      discussions: [],
      total: 0,
      limit: 20,
      offset: 0,
    });

    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(screen.getByText("No discussions yet")).toBeInTheDocument();
    });
  });

  it("sets breadcrumbs on mount", async () => {
    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(mockBreadcrumbContext.setBreadcrumbs).toHaveBeenCalledWith([
        { label: "Discussions" },
      ]);
    });
  });

  it("shows source badges", async () => {
    renderWithProviders(<Discussions />);

    await waitFor(() => {
      expect(screen.getByText("Paste")).toBeInTheDocument();
    });

    expect(screen.getByText("Voice")).toBeInTheDocument();
    expect(screen.getByText("MCP")).toBeInTheDocument();
  });
});
