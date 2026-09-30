import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  renderWithProviders,
  mockCompanyContext,
  mockBreadcrumbContext,
} from "./test-utils";
import { Memory } from "../pages/Memory";

// Mock useToast — Memory page consumes it via useToast() but the shared
// test wrapper deliberately doesn't include ToastProvider (other tests in
// this directory mock ToastContext at the file level instead).
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// --- Mock data ---

function makeMemoryItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem-1",
    companyId: "comp-1",
    title: "API standards",
    content: "Use RESTful conventions for all endpoints.",
    category: "reference",
    source: "founder",
    status: "approved",
    tags: ["api"],
    departmentId: null,
    projectId: null,
    createdBy: "founder",
    layer: "domain",
    priority: 0,
    visibility: "scoped",
    expiresAt: null,
    goalId: null,
    taskId: null,
    sourceArtifactId: null,
    sourceContext: null,
    accessedAt: new Date().toISOString(),
    currentVersionId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const identityItem = makeMemoryItem({
  id: "mem-identity",
  title: "Company Vision",
  content: "Be the best.",
  layer: "identity",
  category: "context",
});

const domainItem = makeMemoryItem({
  id: "mem-domain",
  title: "API Standards",
  content: "Use REST.",
  layer: "domain",
  category: "reference",
});

const activeContextItem = makeMemoryItem({
  id: "mem-ac",
  title: "Q1 Focus",
  content: "Growth metrics.",
  layer: "active_context",
  category: "decision",
  expiresAt: "2026-06-01T00:00:00Z",
});

const workingItem = makeMemoryItem({
  id: "mem-working",
  title: "Current task context",
  content: "Working on auth.",
  layer: "working",
  category: "context",
});

const staleItem = makeMemoryItem({
  id: "mem-stale",
  title: "Old Reference",
  content: "Outdated info.",
  layer: "domain",
  status: "approved",
  accessedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(), // 100 days ago
  updatedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
});

const agentPendingItem = makeMemoryItem({
  id: "mem-agent",
  title: "Agent suggestion",
  content: "Agents should use markdown.",
  layer: "domain",
  source: "agent",
  status: "pending",
  createdBy: "agent-1",
  sourceContext: "Detected repeated formatting issues.",
});

const allItems = [identityItem, domainItem, activeContextItem, workingItem, staleItem, agentPendingItem];
const pendingQueue = {
  items: [agentPendingItem],
  versions: [],
  archives: [],
  totalCount: 1,
};

// --- Mocks ---

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbContext,
}));

vi.mock("../hooks/useTeamAccess", () => ({
  useTeamAccess: () => ({
    permissions: {
      canAssignTasks: true,
      canInviteUsers: true,
      canManageRoles: true,
      canEditIdentityMemory: true,
    },
  }),
}));

let mockQueryFn: (opts: { queryKey: unknown[] }) => unknown;

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: vi.fn((opts: any) => {
      if (mockQueryFn) {
        return mockQueryFn(opts);
      }
      // Default: memory list
      if (opts.queryKey?.[0] === "memory") {
        if (opts.queryKey?.[2] === "pending") {
          return { data: pendingQueue, isLoading: false };
        }
        if (opts.queryKey?.[2] === "starter-templates") {
          return { data: [], isLoading: false };
        }
        return { data: { items: allItems, semanticAvailable: true }, isLoading: false };
      }
      if (opts.queryKey?.[0] === "projects") {
        return { data: [], isLoading: false };
      }
      if (opts.queryKey?.[0] === "goals") {
        return { data: [], isLoading: false };
      }
      if (opts.queryKey?.[0] === "issues") {
        return { data: [], isLoading: false };
      }
      return { data: null, isLoading: false };
    }),
    useMutation: vi.fn(() => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
    })),
    useQueryClient: vi.fn(() => ({
      invalidateQueries: vi.fn(),
    })),
  };
});

vi.mock("../api/memory", () => ({
  memoryApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    listPending: vi.fn().mockResolvedValue({ items: [], versions: [], archives: [], totalCount: 0 }),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({}),
    approve: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    getVersions: vi.fn().mockResolvedValue([]),
    suggestUpdate: vi.fn().mockResolvedValue({}),
    suggestArchive: vi.fn().mockResolvedValue({}),
    saveDraft: vi.fn().mockResolvedValue({}),
    publishDraft: vi.fn().mockResolvedValue({}),
    approveVersion: vi.fn().mockResolvedValue({}),
    rejectVersion: vi.fn().mockResolvedValue({}),
    restore: vi.fn().mockResolvedValue({}),
    touchAccessedAt: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/goals", () => ({
  goalsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/issues", () => ({
  issuesApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    memory: {
      list: (companyId: string) => ["memory", companyId],
      pending: (companyId: string) => ["memory", companyId, "pending"],
      detail: (companyId: string, id: string) => ["memory", companyId, id],
      versions: (companyId: string, id: string) => ["memory", companyId, id, "versions"],
      semanticSearch: (companyId: string, q: string) => ["memory", companyId, "semantic-search", q],
      retrievalsForIssue: (companyId: string, issueId: string) => ["memory", companyId, "retrievals", "issue", issueId],
      starterTemplates: (companyId: string) => ["memory", companyId, "starter-templates"],
      importJob: (companyId: string, jobId: string) => ["memory", companyId, "import-job", jobId],
      folders: {
        list: (companyId: string, departmentId?: string) => ["memory", "folders", companyId, departmentId ?? "_all"],
      },
      assets: {
        list: (companyId: string) => ["memory", "assets", companyId],
        detail: (companyId: string, id: string) => ["memory", "assets", companyId, "detail", id],
      },
    },
    projects: {
      list: (companyId: string) => ["projects", companyId],
    },
    goals: {
      list: (companyId: string) => ["goals", companyId],
    },
    issues: {
      list: (companyId: string) => ["issues", companyId],
    },
  },
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message, onAction }: any) => (
    <div data-testid="empty-state">
      {message}
      {onAction && <button onClick={onAction}>Action</button>}
    </div>
  ),
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="skeleton">Loading...</div>,
}));

// --- Tests ---

describe("Memory Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockQueryFn = null as any;
  });

  describe("Layer View", () => {
    it("renders layer sections with correct items grouped", () => {
      renderWithProviders(<Memory />);

      // Should show layer section headings
      expect(screen.getByText("Identity")).toBeInTheDocument();
      expect(screen.getByText("Domain")).toBeInTheDocument();
      expect(screen.getByText("Active Context")).toBeInTheDocument();
      expect(screen.getByText("Working")).toBeInTheDocument();

      // Items should be present
      expect(screen.getByText("Company Vision")).toBeInTheDocument();
      expect(screen.getByText("API Standards")).toBeInTheDocument();
      expect(screen.getByText("Q1 Focus")).toBeInTheDocument();
      expect(screen.getByText("Current task context")).toBeInTheDocument();
    });

    it("shows empty placeholder when a layer has no items", () => {
      mockQueryFn = (opts: any) => {
        if (opts.queryKey?.[0] === "memory") {
          if (opts.queryKey?.[2] === "starter-templates") {
            return { data: [], isLoading: false };
          }
          if (opts.queryKey?.[2] === "pending") {
            return { data: { items: [], versions: [], archives: [], totalCount: 0 }, isLoading: false };
          }
          return { data: { items: [identityItem], semanticAvailable: true }, isLoading: false };
        }
        return { data: [], isLoading: false };
      };
      renderWithProviders(<Memory />);

      // Domain, Active Context, Working should show "No items"
      const noItemMessages = screen.getAllByText("No items in this layer");
      expect(noItemMessages.length).toBe(3);
    });

    it("shows token estimates per section", () => {
      renderWithProviders(<Memory />);

      // Token estimates are calculated as characters / 4
      // Each layer section has its own token count
      const tokenElements = screen.getAllByText(/tokens/);
      expect(tokenElements.length).toBeGreaterThanOrEqual(4); // 4 layers
    });
  });

  describe("Flat View", () => {
    it("switches to flat view and shows all items", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Memory />);

      // Click "Flat" toggle
      await user.click(screen.getByText("Flat"));

      // All items should still be present
      expect(screen.getByText("Company Vision")).toBeInTheDocument();
      expect(screen.getByText("API Standards")).toBeInTheDocument();
      expect(screen.getByText("Q1 Focus")).toBeInTheDocument();
    });

    it("shows layer badges in flat view", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Memory />);

      await user.click(screen.getByText("Flat"));

      // Layer badges should be visible in flat view
      // There should be Identity badge for the identity item
      const identityBadges = screen.getAllByText("Identity");
      expect(identityBadges.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Filters", () => {
    it("renders layer filter dropdown", () => {
      renderWithProviders(<Memory />);

      // Layer filter is present in the filter bar
      expect(screen.getByText("All layers")).toBeInTheDocument();
    });

    it("renders all standard filters", () => {
      renderWithProviders(<Memory />);

      expect(screen.getByText("All categories")).toBeInTheDocument();
      expect(screen.getByText("All statuses")).toBeInTheDocument();
      expect(screen.getByText("All departments")).toBeInTheDocument();
      expect(screen.getByText("All layers")).toBeInTheDocument();
    });

    it("shows pending button when pending items exist", () => {
      renderWithProviders(<Memory />);

      expect(screen.getByText(/Pending/)).toBeInTheDocument();
    });
  });

  describe("Staleness Indicator", () => {
    it("shows stale badge for items not accessed in 90+ days", () => {
      renderWithProviders(<Memory />);

      // The stale item should have a stale badge
      expect(screen.getByText("stale")).toBeInTheDocument();
    });
  });

  describe("Agent Suggestions Tab", () => {
    it("renders Agent Suggestions tab with count badge", () => {
      renderWithProviders(<Memory />);

      expect(screen.getByText("Agent Suggestions")).toBeInTheDocument();
      // Count badge for agent pending items
      expect(screen.getByText("1")).toBeInTheDocument();
    });

    it("shows agent suggestion items with approve/reject actions", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Memory />);

      await user.click(screen.getByText("Agent Suggestions"));

      expect(screen.getByText("Agent suggestion")).toBeInTheDocument();
      expect(screen.getByText("Approve")).toBeInTheDocument();
      expect(screen.getByText("Reject")).toBeInTheDocument();
      expect(screen.getByText("Edit & Approve")).toBeInTheDocument();
    });

    it("shows agent reasoning when sourceContext is present", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Memory />);

      await user.click(screen.getByText("Agent Suggestions"));

      expect(screen.getByText(/Detected repeated formatting issues/)).toBeInTheDocument();
    });

    it("shows empty state when no suggestions exist", async () => {
      mockQueryFn = (opts: any) => {
        if (opts.queryKey?.[0] === "memory") {
          if (opts.queryKey?.[2] === "pending") {
            return { data: { items: [], versions: [], archives: [], totalCount: 0 }, isLoading: false };
          }
          if (opts.queryKey?.[2] === "starter-templates") {
            return { data: [], isLoading: false };
          }
          return { data: { items: [domainItem], semanticAvailable: true }, isLoading: false };
        }
        return { data: [], isLoading: false };
      };
      const user = userEvent.setup();
      renderWithProviders(<Memory />);

      await user.click(screen.getByText("Agent Suggestions"));

      expect(screen.getByText("No agent suggestions")).toBeInTheDocument();
    });
  });

  describe("Create Dialog", () => {
    it("opens creation dialog", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Memory />);

      // Click the "Add to Memory" button (first one, in the toolbar)
      const addButtons = screen.getAllByText("Add to Memory");
      await user.click(addButtons[0]);

      // Dialog should have opened with the title and form fields
      expect(screen.getByLabelText("Title")).toBeInTheDocument();
      expect(screen.getByLabelText("Content")).toBeInTheDocument();
    });

    it("shows layer selector in creation dialog", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Memory />);

      await user.click(screen.getByText("Add to Memory"));

      // Layer selector should be present
      expect(screen.getByText("Layer")).toBeInTheDocument();
      // Priority and Visibility labels should be present
      expect(screen.getByText("Priority")).toBeInTheDocument();
      expect(screen.getByText("Visibility")).toBeInTheDocument();
    });
  });

  describe("View Mode Toggle", () => {
    it("defaults to layer view", () => {
      renderWithProviders(<Memory />);

      // Layer sections should be visible by default
      expect(screen.getByText("Identity")).toBeInTheDocument();
      expect(screen.getByText("Domain")).toBeInTheDocument();
    });

    it("toggles between layer and flat view", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Memory />);

      // Default is layer view
      expect(screen.getByText("By Layer")).toBeInTheDocument();
      expect(screen.getByText("Flat")).toBeInTheDocument();

      // Click flat
      await user.click(screen.getByText("Flat"));

      // Should still show items (in flat layout)
      expect(screen.getByText("Company Vision")).toBeInTheDocument();
    });
  });

  describe("No Company Selected", () => {
    it("shows empty state when no company is selected", () => {
      mockCompanyContext.selectedCompanyId = null;
      renderWithProviders(<Memory />);

      expect(screen.getByText("Select a company to view memory.")).toBeInTheDocument();
    });
  });

  describe("URL Selection", () => {
    it("opens the selected memory item from the query string", async () => {
      mockQueryFn = (opts: any) => {
        if (
          opts.queryKey?.[0] === "memory" &&
          opts.queryKey?.length === 3 &&
          opts.queryKey?.[2] === "mem-domain"
        ) {
          return { data: domainItem, isLoading: false };
        }
        if (
          opts.queryKey?.[0] === "memory" &&
          opts.queryKey?.[3] === "versions"
        ) {
          return { data: [], isLoading: false };
        }
        if (opts.queryKey?.[0] === "memory") {
          if (opts.queryKey?.[2] === "starter-templates") {
            return { data: [], isLoading: false };
          }
          return { data: { items: allItems, semanticAvailable: true }, isLoading: false };
        }
        return { data: [], isLoading: false };
      };

      renderWithProviders(<Memory />, {
        initialEntries: ["/memory?selected=mem-domain"],
      });

      await waitFor(() => {
        expect(screen.getAllByText("API Standards").length).toBeGreaterThan(1);
      });
    });
  });
});
