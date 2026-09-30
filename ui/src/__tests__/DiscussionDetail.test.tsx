import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  renderWithProviders,
  mockCompanyContext,
  mockBreadcrumbContext,
  mockDialogContext,
} from "./test-utils";
import { DiscussionDetail } from "../pages/DiscussionDetail";

// --- Mock data ---

function makeExtractedItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    type: "task",
    title: "Set up CI pipeline",
    description: "Configure GitHub Actions for the monorepo",
    suggestedPriority: "high",
    suggestedDepartmentId: null,
    suggestedLayer: null,
    layer: null,
    priority: null,
    dedupAction: null,
    status: "pending",
    resultTaskId: null,
    resultMemoryId: null,
    conflictsWith: null,
    createdAt: "2026-03-20T10:05:00Z",
    ...overrides,
  };
}

const mockDiscussion = {
  id: "disc-1",
  title: "Sprint Planning Notes",
  status: "active" as const,
  scopeType: "department",
  scopeId: "dept-1",
  scopeName: "Engineering",
  tags: ["sprint"],
  entryCount: 2,
  pendingItemCount: 3,
  createdBy: "user-1",
  createdAt: "2026-03-20T08:00:00Z",
  updatedAt: "2026-03-20T10:00:00Z",
  entries: [
    {
      id: "entry-1",
      inputType: "paste",
      rawContent: "We need to set up CI pipeline and write unit tests for the auth module.",
      title: null,
      sourceInfo: null,
      departmentId: null,
      projectId: null,
      goalId: null,
      extractionStatus: "completed" as const,
      createdBy: "user-1",
      createdAt: "2026-03-20T09:00:00Z",
      extractedItems: [
        makeExtractedItem(),
        makeExtractedItem({
          id: "item-2",
          type: "task",
          title: "Write unit tests for auth module",
          description: null,
          suggestedPriority: "medium",
        }),
      ],
      annotations: [],
    },
    {
      id: "entry-2",
      inputType: "voice",
      rawContent: "We decided to use PostgreSQL for the new service. This is a key architectural decision.",
      title: null,
      sourceInfo: { transcriptionModel: "whisper-1" },
      departmentId: null,
      projectId: null,
      goalId: null,
      extractionStatus: "completed" as const,
      createdBy: "user-1",
      createdAt: "2026-03-20T10:00:00Z",
      extractedItems: [
        makeExtractedItem({
          id: "item-3",
          type: "decision",
          title: "Use PostgreSQL for new service",
          description: "Key architectural decision for data persistence",
          suggestedPriority: null,
          suggestedLayer: "domain",
          status: "approved",
          resultMemoryId: "mem-1",
        }),
      ],
      annotations: [],
    },
  ],
};

// --- Mocks ---

const discussionsApiMock = {
  get: vi.fn().mockResolvedValue(mockDiscussion),
  approveItems: vi.fn().mockResolvedValue({
    approved: 1,
    rejected: 0,
    tasksCreated: ["task-1"],
    memoryItemsCreated: [],
  }),
  rejectItems: vi.fn().mockResolvedValue({ approved: 0, rejected: 1, tasksCreated: [], memoryItemsCreated: [] }),
  reprocessEntry: vi.fn().mockResolvedValue({ entryId: "entry-1", extractionStatus: "processing", runId: "run-1" }),
  updateItem: vi.fn().mockResolvedValue(makeExtractedItem({ status: "edited" })),
  addEntry: vi.fn().mockResolvedValue({ id: "entry-3", extractionStatus: "processing" }),
};

vi.mock("../api/discussions", () => ({
  discussionsApi: new Proxy(
    {},
    { get: (_t, prop) => (discussionsApiMock as any)[prop] },
  ),
}));

// transcribe is deprecated server-side (Decision #91 — returns 501 in real
// deployments pending the Commander sub-agent migration). DiscussionDetail
// does not exercise the voice-input path, so the mocked 200 shape is fine
// here; the 501 contract is asserted in DiscussionCaptureModal.test.tsx.
vi.mock("../api/transcription", () => ({
  transcriptionApi: {
    transcribe: vi.fn().mockResolvedValue({ text: "Transcribed text here." }),
  },
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => mockDialogContext,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ ...mockCompanyContext, selectedCompanyId: "comp-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbContext,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual("react-router-dom") as any;
  return {
    ...actual,
    useParams: () => ({ discussionId: "disc-1" }),
    Link: actual.Link,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  discussionsApiMock.get.mockResolvedValue(mockDiscussion);
});

// --- Tests ---

describe("DiscussionDetail page", () => {
  it("renders discussion title and metadata", async () => {
    renderWithProviders(<DiscussionDetail />);

    await waitFor(() => {
      expect(screen.getByText("Sprint Planning Notes")).toBeInTheDocument();
    });

    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("sprint")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("renders entry raw content when expanded", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscussionDetail />);

    // Entries are collapsed by default — expand the first one
    await waitFor(() => {
      expect(screen.getAllByRole("button", { expanded: false }).length).toBeGreaterThanOrEqual(1);
    });

    const entryHeaders = screen.getAllByRole("button", { expanded: false });
    await user.click(entryHeaders[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/We need to set up CI pipeline and write unit tests/),
      ).toBeInTheDocument();
    });
  });

  it("renders pending extracted items with checkboxes", async () => {
    renderWithProviders(<DiscussionDetail />);

    await waitFor(() => {
      expect(screen.getByText("Set up CI pipeline")).toBeInTheDocument();
    });

    expect(screen.getByText("Write unit tests for auth module")).toBeInTheDocument();
  });

  it("renders approved items with check icon", async () => {
    renderWithProviders(<DiscussionDetail />);

    await waitFor(() => {
      expect(screen.getByText("Use PostgreSQL for new service")).toBeInTheDocument();
    });
  });

  it("shows Items to Review section header", async () => {
    renderWithProviders(<DiscussionDetail />);

    await waitFor(() => {
      expect(screen.getByText("Items to Review")).toBeInTheDocument();
    });
  });

  it("shows source labels on entries", async () => {
    renderWithProviders(<DiscussionDetail />);

    await waitFor(() => {
      // Source labels appear in entry headers
      expect(screen.getAllByText("Paste").length).toBeGreaterThanOrEqual(1);
    });

    // Voice entry source label (may also appear in tab trigger)
    expect(screen.getAllByText("Voice").length).toBeGreaterThanOrEqual(1);
  });

  it("shows extraction status badges", async () => {
    renderWithProviders(<DiscussionDetail />);

    await waitFor(() => {
      const badges = screen.getAllByText("completed");
      expect(badges.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("renders Reprocess button when entry is expanded", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscussionDetail />);

    // Wait for entries to render (collapsed by default)
    await waitFor(() => {
      expect(screen.getAllByRole("button", { expanded: false }).length).toBeGreaterThanOrEqual(1);
    });

    // Expand the first entry to reveal the Reprocess button
    const entryHeaders = screen.getAllByRole("button", { expanded: false });
    await user.click(entryHeaders[0]);

    await waitFor(() => {
      expect(screen.getByText("Reprocess")).toBeInTheDocument();
    });
  });

  it("shows type badges on extracted items", async () => {
    renderWithProviders(<DiscussionDetail />);

    await waitFor(() => {
      // There are task items and a decision item
      const taskBadges = screen.getAllByText("task");
      expect(taskBadges.length).toBeGreaterThanOrEqual(2);
    });

    expect(screen.getByText("decision")).toBeInTheDocument();
  });

  it("shows priority badges on task items", async () => {
    renderWithProviders(<DiscussionDetail />);

    await waitFor(() => {
      expect(screen.getByText("high")).toBeInTheDocument();
    });

    expect(screen.getByText("medium")).toBeInTheDocument();
  });

  it("renders the Add Entry button", async () => {
    renderWithProviders(<DiscussionDetail />);

    await waitFor(() => {
      expect(screen.getByText("Add Entry")).toBeInTheDocument();
    });
  });

  it("sets breadcrumbs with Discussions parent", async () => {
    renderWithProviders(<DiscussionDetail />);

    await waitFor(() => {
      expect(mockBreadcrumbContext.setBreadcrumbs).toHaveBeenCalledWith([
        { label: "Discussions", href: "/discussions" },
        { label: "Sprint Planning Notes" },
      ]);
    });
  });

  it("shows entry count in metadata", async () => {
    renderWithProviders(<DiscussionDetail />);

    await waitFor(() => {
      expect(screen.getByText("2 entries")).toBeInTheDocument();
    });
  });
});
