import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithProviders } from "../../__tests__/test-utils";
import { ThreadsWorkspace } from "../ThreadsWorkspace";
import { threadsApi, type ThreadListItem } from "../../api/threads";
import { api } from "../../api/client";
import { ThreadsGlobalViewer } from "../../components/threads/ThreadsGlobalViewer";
import { browserTab } from "../../components/threads/threadViewerModel";

const testState = vi.hoisted(() => ({
  teamAccessRole: "founder",
}));

let mockParams: { discussionId?: string; threadId?: string; companyPrefix?: string } = {
  discussionId: "thread-1",
  companyPrefix: "TC",
};

vi.mock("../../api/threads", () => ({
  threadsApi: {
    list: vi.fn(),
    setStatus: vi.fn(),
  },
}));

vi.mock("../../api/client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  },
}));

vi.mock("../../hooks/useTeamAccess", () => ({
  useTeamAccess: () => ({ role: testState.teamAccessRole }),
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", name: "Test Corp", issuePrefix: "TC" },
  }),
}));

vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({ openNewThread: vi.fn() }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: vi.fn(),
    setSubtitle: vi.fn(),
    setEntityColor: vi.fn(),
  }),
}));

vi.mock("../../components/threads/RoutingDialControl", () => ({
  RoutingDialControl: ({
    canEdit,
    variant,
  }: {
    companyId: string;
    canEdit?: boolean;
    variant?: string;
  }) => (
    <button type="button" data-testid="routing-dial" data-can-edit={String(canEdit)} data-variant={variant ?? "inline"}>
      Routing
    </button>
  ),
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("../../lib/router")>("../../lib/router");
  return {
    ...actual,
    useParams: () => mockParams,
  };
});

vi.mock("../ThreadDetail", () => ({
  ThreadDetail: ({ embedded, onViewerWideChange }: { embedded?: boolean; onViewerWideChange?: (wide: boolean) => void }) => (
    <div data-testid="mock-thread-detail" data-embedded={String(embedded)}>
      <button type="button" onClick={() => onViewerWideChange?.(true)}>
        Simulate wide viewer
      </button>
      Active thread
    </div>
  ),
}));

const makeThread = (overrides: Partial<ThreadListItem> = {}): ThreadListItem => ({
  id: "thread-1",
  title: "Thread one",
  status: "active",
  scopeType: null,
  scopeId: null,
  scopeName: null,
  tags: [],
  entryCount: 1,
  pendingItemCount: 0,
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00Z",
  lastEntryAt: "2026-01-01T00:00:00Z",
  lastEntryInputType: "paste",
  phase: "discuss",
  visibility: "company",
  ownerUserId: null,
  originSource: null,
  intent: null,
  goalId: null,
  autonomyLevel: null,
  summaryText: null,
  summaryNext: null,
  subtype: "normal",
  shareToken: null,
  participants: [],
  allowMemoryExtraction: true,
  ...overrides,
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

describe("ThreadsWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.teamAccessRole = "founder";
    mockParams = { discussionId: "thread-1", companyPrefix: "TC" };
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("min-width: 768px"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    vi.mocked(threadsApi.list).mockImplementation(async (_companyId, options?: { status?: string }) => {
      if (options?.status === "archived") {
        return {
          discussions: [],
          total: 0,
          limit: 50,
          offset: 0,
        };
      }
      return {
        discussions: [
          makeThread({ id: "thread-1", title: "Thread one" }),
          makeThread({ id: "thread-2", title: "Thread two", phase: "scope" }),
          makeThread({ id: "thread-3", title: "Thread three", phase: "assign", lastEntryAt: "2026-01-01T01:00:00Z" }),
          makeThread({ id: "thread-4", title: "Thread four", phase: "done", lastEntryAt: "2026-01-01T02:00:00Z" }),
        ],
        total: 4,
        limit: 50,
        offset: 0,
      };
    });
    vi.mocked(threadsApi.setStatus).mockResolvedValue(makeThread({ status: "archived" }) as any);
    vi.mocked(api.get).mockResolvedValue({ items: [], total: 0 });
  });

  it("renders Home as a three-pane workspace with the global map viewer", async () => {
    mockParams = { companyPrefix: "TC" };
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const index = await screen.findByTestId("threads-index");

    expect(within(index).getByRole("link", { name: /^home$/i })).toHaveAttribute("aria-current", "page");
    expect(within(index).getByRole("button", { name: /^unlisted$/i })).toBeInTheDocument();
    expect(within(index).getByTestId("thread-rail-home")).toBeInTheDocument();
    expect(screen.getByTestId("threads-home-overview")).toBeInTheDocument();
    expect(screen.getByTestId("threads-global-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("thread-viewer-header")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /global map/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: /open viewer tab/i })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: /resize thread browser/i })).not.toHaveAttribute("tabindex");
    expect(screen.getByRole("separator", { name: /resize global viewer/i })).not.toHaveAttribute("tabindex");
    expect(screen.getByTestId("thread-map-placeholder")).toHaveTextContent("Global map");
    expect(screen.queryByTestId("mock-thread-detail")).not.toBeInTheDocument();
    expect(screen.getAllByText(/needs attention/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/recently active/i).length).toBeGreaterThan(0);
  });

  it("opens the Home viewer Open tab from the add button", async () => {
    mockParams = { companyPrefix: "TC" };
    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    await screen.findByTestId("threads-global-viewer");
    await user.click(screen.getByRole("button", { name: /open viewer tab/i }));

    expect(screen.getByRole("tab", { name: /open/i })).toHaveAttribute("aria-selected", "true");
    const openViewer = screen.getByTestId("threads-home-open-viewer");
    expect(openViewer).toBeInTheDocument();
    expect(within(openViewer).getByText("Global map")).toBeInTheDocument();
    expect(within(openViewer).getByText("All discussion relationships")).toBeInTheDocument();
    expect(within(openViewer).getByText("New browser")).toBeInTheDocument();
    expect(within(openViewer).getByText("Open a URL in this viewer")).toBeInTheDocument();
  });

  it("opens the real browser viewer from the Home viewer Open tab", async () => {
    mockParams = { companyPrefix: "TC" };
    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    await screen.findByTestId("threads-global-viewer");
    await user.click(screen.getByRole("button", { name: /open viewer tab/i }));
    await user.click(screen.getByRole("button", { name: /new browser/i }));

    expect(screen.getByRole("tab", { name: /browser/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("thread-browser-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("thread-browser-url-input")).toBeInTheDocument();
    expect(screen.getByTestId("thread-browser-reload")).toBeDisabled();
    expect(screen.queryByTestId("thread-browser-placeholder")).not.toBeInTheDocument();
  });

  it("keeps Home browser viewer URL state isolated when switching browser tabs", async () => {
    const firstTab = browserTab("https://example.com/");
    const secondTab = browserTab("https://openai.com/");
    const user = userEvent.setup();

    function Harness() {
      const [activeKey, setActiveKey] = React.useState(firstTab.key);
      return (
        <ThreadsGlobalViewer
          tabs={[firstTab, secondTab]}
          activeKey={activeKey}
          onActivate={setActiveKey}
          onClose={vi.fn()}
          onOpenTab={vi.fn()}
          onToggleCollapse={vi.fn()}
          width={360}
        />
      );
    }

    renderWithProviders(<Harness />);

    expect(screen.getByTestId("thread-browser-iframe")).toHaveAttribute("src", "https://example.com/");

    await user.click(screen.getByRole("tab", { name: /openai\.com/i }));
    expect(screen.getByTestId("thread-browser-iframe")).toHaveAttribute("src", "https://openai.com/");

    await user.click(screen.getByRole("tab", { name: /example\.com/i }));
    expect(screen.getByTestId("thread-browser-iframe")).toHaveAttribute("src", "https://example.com/");
  });

  it("keeps the create action in the sidebar instead of duplicating it in Home", async () => {
    mockParams = { companyPrefix: "TC" };
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const index = await screen.findByTestId("threads-index");
    const home = screen.getByTestId("threads-home-overview");

    expect(within(index).getByRole("button", { name: /new thread/i })).toBeInTheDocument();
    expect(within(home).queryByRole("button", { name: /new thread/i })).not.toBeInTheDocument();
  });

  it("uses a quiet Discussions header without active-thread count copy", async () => {
    mockParams = { companyPrefix: "TC" };
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const home = await screen.findByTestId("threads-home-overview");
    const header = within(home).getByTestId("threads-home-header");

    expect(within(header).getByRole("heading", { name: "Discussions" })).toBeInTheDocument();
    expect(within(header).queryByText(/discussions home/i)).not.toBeInTheDocument();
    expect(within(header).queryByText(/active threads/i)).not.toBeInTheDocument();
  });

  it("moves auto-routing from the sidebar footer into the Discussions header", async () => {
    mockParams = { companyPrefix: "TC" };
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const home = await screen.findByTestId("threads-home-overview");
    const header = within(home).getByTestId("threads-home-header");
    const index = screen.getByTestId("threads-index");
    const footer = within(index).getByTestId("thread-rail-footer");

    expect(within(header).getByTestId("routing-dial")).toHaveAttribute("data-variant", "icon");
    expect(within(footer).queryByTestId("routing-dial")).not.toBeInTheDocument();
  });

  it("keeps Home center and viewer mounted across category accordion clicks", async () => {
    mockParams = { companyPrefix: "TC" };
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ThreadsWorkspace />
        <LocationProbe />
      </>,
      { initialEntries: ["/TC/discussions"] },
    );

    const index = await screen.findByTestId("threads-index");

    for (const label of ["Discuss", "Scope", "Unlisted"]) {
      await user.click(within(index).getByRole("button", { name: new RegExp(`^${label}$`, "i") }));
      expect(screen.getByTestId("threads-home-overview")).toBeInTheDocument();
      expect(screen.getByTestId("threads-global-viewer")).toBeInTheDocument();
      expect(screen.getByTestId("location")).toHaveTextContent("/TC/discussions");
    }
  });

  it("renders thread detail without also rendering the Home global viewer", async () => {
    mockParams = { companyPrefix: "TC", discussionId: "thread-1" };
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    expect(await screen.findByTestId("mock-thread-detail")).toBeInTheDocument();
    expect(screen.queryByTestId("threads-global-viewer")).not.toBeInTheDocument();
  });

  it("thread links on Home navigate to the thread route", async () => {
    mockParams = { companyPrefix: "TC" };
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ThreadsWorkspace />
        <LocationProbe />
      </>,
      { initialEntries: ["/TC/discussions"] },
    );

    const index = await screen.findByTestId("threads-index");
    await user.click(await within(index).findByRole("link", { name: /thread one/i }));

    expect(screen.getByTestId("location")).toHaveTextContent("/TC/discussions/thread-1");
  });

  it("can select a thread after the Home viewer has been collapsed", async () => {
    mockParams = { companyPrefix: "TC" };
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ThreadsWorkspace />
        <LocationProbe />
      </>,
      { initialEntries: ["/TC/discussions"] },
    );

    await screen.findByTestId("threads-global-viewer");
    await user.click(screen.getByRole("button", { name: /hide preview/i }));
    expect(screen.getByTestId("thread-viewer-collapsed-strip")).toBeInTheDocument();

    const index = screen.getByTestId("threads-index");
    await user.click(await within(index).findByRole("link", { name: /thread one/i }));

    expect(screen.getByTestId("location")).toHaveTextContent("/TC/discussions/thread-1");
  });

  it("lets the Home global viewer be resized from the center divider", async () => {
    mockParams = { companyPrefix: "TC" };
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const viewer = await screen.findByTestId("threads-global-viewer");
    const resizeHandle = screen.getByRole("separator", { name: /resize global viewer/i });

    fireEvent.pointerDown(resizeHandle, { clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(resizeHandle, { clientX: 760, pointerId: 1 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 1 });

    await waitFor(() => {
      expect(viewer).toHaveAttribute("data-width", "480");
    });
  });

  it("collapses the Home global viewer into tab icons and expands it again", async () => {
    mockParams = { companyPrefix: "TC" };
    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    await screen.findByTestId("threads-global-viewer");
    await user.click(screen.getByRole("button", { name: /hide preview/i }));

    const strip = screen.getByTestId("thread-viewer-collapsed-strip");
    expect(strip).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: /global map/i })).toBeInTheDocument();
    expect(screen.queryByTestId("threads-global-viewer")).not.toBeInTheDocument();

    await user.click(within(strip).getByRole("button", { name: /open viewer/i }));

    expect(screen.getByTestId("threads-global-viewer")).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByRole("tab", { name: /global map/i })).toHaveAttribute("aria-selected", "true");
  });

  it("does not render board, list, or map switching buttons in the sidebar", async () => {
    mockParams = { companyPrefix: "TC" };
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    await screen.findByTestId("threads-index");

    expect(screen.queryByRole("button", { name: /board view/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /list view/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /map view/i })).not.toBeInTheDocument();
  });

  it("treats legacy board and list query params as Home", async () => {
    mockParams = { companyPrefix: "TC" };
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions?view=board"] });

    await screen.findByTestId("threads-home-overview");

    expect(screen.getByTestId("threads-index")).toHaveAttribute("data-mode", "home");
    expect(screen.queryByTestId("threads-board-browser")).not.toBeInTheDocument();
    expect(screen.queryByTestId("threads-list-browser")).not.toBeInTheDocument();
  });

  it("keeps Home and the viewer visible when Unlisted is clicked", async () => {
    mockParams = { companyPrefix: "TC" };
    vi.mocked(api.get).mockResolvedValue({
      items: [
        {
          id: "inbox-1",
          rawContent: "Customer wants pricing proof before approving scope.",
          originSource: "paste",
          createdAt: "2026-01-01T00:00:00Z",
          routerDecision: "suggest",
          suggestedThreadId: "thread-2",
        },
      ],
      total: 1,
    });
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const index = await screen.findByTestId("threads-index");
    await userEvent.setup().click(within(index).getByRole("button", { name: /^unlisted$/i }));

    expect(screen.getByTestId("threads-home-overview")).toBeInTheDocument();
    expect(screen.getByTestId("threads-global-viewer")).toBeInTheDocument();
    expect(screen.queryByTestId("threads-unlisted-panel")).not.toBeInTheDocument();
  });

  it("shows real Unlisted inbox items on the Home overview", async () => {
    mockParams = { companyPrefix: "TC" };
    vi.mocked(api.get).mockResolvedValue({
      items: [
        {
          id: "inbox-1",
          rawContent: "Customer pasted renewal notes that need routing.",
          originSource: "paste",
          createdAt: "2026-01-01T00:00:00Z",
          routerDecision: "suggest_new",
          suggestedThreadTitle: "Renewal notes",
        },
      ],
      total: 1,
    });

    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const home = await screen.findByTestId("threads-home-overview");

    expect(api.get).toHaveBeenCalledWith("/companies/comp-1/discussions/inbox");
    expect(within(home).getByTestId("threads-home-unlisted-section")).toHaveTextContent("Unlisted");
    await waitFor(() => {
      expect(within(home).getByTestId("threads-home-unlisted-count")).toHaveTextContent("1");
    });
    expect(within(home).getByText(/customer pasted renewal notes/i)).toBeInTheDocument();
    expect(within(home).getByText("Renewal notes")).toBeInTheDocument();
  });

  it("does not render a separate Phase snapshot section on Home", async () => {
    mockParams = { companyPrefix: "TC" };
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    await screen.findByTestId("threads-home-overview");

    expect(screen.queryByText(/phase snapshot/i)).not.toBeInTheDocument();
  });

  it("keeps Home thread rows free of left phase dots and uses only right-side attention markers", async () => {
    mockParams = { companyPrefix: "TC" };
    vi.mocked(threadsApi.list).mockImplementation(async (_companyId, options?: { status?: string }) => {
      if (options?.status === "archived") {
        return { discussions: [], total: 0, limit: 50, offset: 0 };
      }
      return {
        discussions: [
          makeThread({ id: "thread-1", title: "Thread one" }),
          makeThread({
            id: "thread-2",
            title: "Thread two",
            phase: "scope",
            pendingItemCount: 2,
            lastEntryAt: "2026-01-01T01:00:00Z",
          }),
        ],
        total: 2,
        limit: 50,
        offset: 0,
      };
    });

    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const home = await screen.findByTestId("threads-home-overview");

    expect((await within(home).findAllByRole("link", { name: /thread two/i })).length).toBeGreaterThan(0);
    expect(home.querySelector("[data-home-phase-dot='true']")).not.toBeInTheDocument();
    expect(within(home).getAllByTestId("home-thread-attention-marker").length).toBeGreaterThan(0);
  });

  it("shows thread card metadata as source, department, and participant avatars", async () => {
    mockParams = { companyPrefix: "TC" };
    vi.mocked(threadsApi.list).mockImplementation(async (_companyId, options?: { status?: string }) => {
      if (options?.status === "archived") {
        return { discussions: [], total: 0, limit: 50, offset: 0 };
      }
      return {
        discussions: [
          makeThread({
            id: "thread-rich",
            title: "Clarify launch owner",
            phase: "scope",
            scopeType: "department",
            scopeName: "Growth",
            lastEntryInputType: "transcript",
            participantPreview: [
              { principalType: "user", principalId: "user-1", name: "TK", role: "owner" },
              { principalType: "agent", principalId: "agent-1", name: "Revenue Agent", role: "worker" },
              { principalType: "agent", principalId: "agent-2", name: "Ops Agent", role: "worker" },
              { principalType: "user", principalId: "user-2", name: "Priya", role: "collaborator" },
            ],
            participantCount: 4,
          } as Partial<ThreadListItem>),
        ],
        total: 1,
        limit: 50,
        offset: 0,
      };
    });

    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const home = await screen.findByTestId("threads-home-overview");
    const row = (await within(home).findAllByRole("link", { name: /clarify launch owner/i }))[0];

    expect(within(row).getByText("Department: Growth")).toBeInTheDocument();
    expect(within(row).getByText("Transcript")).toBeInTheDocument();
    expect(within(row).getByTestId("home-participant-stack-thread-rich")).toBeInTheDocument();
    expect(within(row).getByText("+1")).toBeInTheDocument();
    expect(within(row).queryByText(/4 participants/i)).not.toBeInTheDocument();
  });

  it("keeps Home visible and lists archived threads in the sidebar", async () => {
    mockParams = { companyPrefix: "TC" };
    vi.mocked(threadsApi.list).mockImplementation(async (_companyId, options?: { status?: string }) => {
      if (options?.status === "archived") {
        return {
          discussions: [makeThread({ id: "archived-1", title: "Archived thread", status: "archived" })],
          total: 1,
          limit: 50,
          offset: 0,
        };
      }
      return {
        discussions: [makeThread({ id: "thread-1", title: "Thread one" })],
        total: 1,
        limit: 50,
        offset: 0,
      };
    });

    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });
    const index = await screen.findByTestId("threads-index");

    await within(index).findByRole("link", { name: /archived thread/i });

    expect(screen.getByTestId("threads-home-overview")).toBeInTheDocument();
    expect(screen.getByTestId("threads-global-viewer")).toBeInTheDocument();
    expect(screen.queryByTestId("threads-archived-panel")).not.toBeInTheDocument();
    expect(within(index).getByRole("link", { name: /archived thread/i })).toBeInTheDocument();
  });

  it("opens archived thread detail from the archived sidebar group", async () => {
    mockParams = { companyPrefix: "TC" };
    vi.mocked(threadsApi.list).mockImplementation(async (_companyId, options?: { status?: string }) => {
      if (options?.status === "archived") {
        return {
          discussions: [makeThread({ id: "archived-1", title: "Archived thread", status: "archived" })],
          total: 1,
          limit: 50,
          offset: 0,
        };
      }
      return {
        discussions: [makeThread({ id: "thread-1", title: "Thread one" })],
        total: 1,
        limit: 50,
        offset: 0,
      };
    });

    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ThreadsWorkspace />
        <LocationProbe />
      </>,
      { initialEntries: ["/TC/discussions"] },
    );
    const index = await screen.findByTestId("threads-index");

    await user.click(await within(index).findByRole("link", { name: /archived thread/i }));

    expect(screen.getByTestId("location")).toHaveTextContent("/TC/discussions/archived-1");
  });

  it("keeps archived threads out of active rail sections when the list response includes them", async () => {
    mockParams = { companyPrefix: "TC" };
    vi.mocked(threadsApi.list).mockImplementation(async (_companyId, options?: { status?: string }) => {
      if (options?.status === "archived") {
        return {
          discussions: [makeThread({ id: "archived-1", title: "Archived thread", phase: "scope", status: "archived" })],
          total: 1,
          limit: 50,
          offset: 0,
        };
      }
      if (options?.status === "active") {
        return {
          discussions: [makeThread({ id: "thread-1", title: "Thread one", phase: "discuss" })],
          total: 1,
          limit: 50,
          offset: 0,
        };
      }
      return {
        discussions: [
          makeThread({ id: "thread-1", title: "Thread one", phase: "discuss" }),
          makeThread({ id: "archived-1", title: "Archived thread", phase: "scope", status: "archived" }),
        ],
        total: 2,
        limit: 50,
        offset: 0,
      };
    });

    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });
    const index = await screen.findByTestId("threads-index");

    expect(await within(index).findByRole("link", { name: /thread one/i })).toBeInTheDocument();
    expect(within(index).getAllByRole("link", { name: /archived thread/i })).toHaveLength(1);
  });

  it("does not reuse a cached unfiltered list for the active workspace query", async () => {
    mockParams = { companyPrefix: "TC" };
    const cachedActive = makeThread({ id: "thread-1", title: "Thread one", phase: "discuss" });
    const cachedArchived = makeThread({
      id: "archived-1",
      title: "Archived thread",
      phase: "scope",
      status: "archived",
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["threads", "comp-1", "list"], {
      discussions: [cachedActive, cachedArchived],
      total: 2,
      limit: 50,
      offset: 0,
    });
    vi.mocked(threadsApi.list).mockImplementation(async (_companyId, options?: { status?: string }) => {
      if (options?.status === "archived") {
        return {
          discussions: [cachedArchived],
          total: 1,
          limit: 50,
          offset: 0,
        };
      }
      if (options?.status === "active") {
        return new Promise(() => {});
      }
      return {
        discussions: [cachedActive, cachedArchived],
        total: 2,
        limit: 50,
        offset: 0,
      };
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/TC/discussions"]}>
          <ThreadsWorkspace />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const index = await screen.findByTestId("threads-index");

    expect(await within(index).findByRole("link", { name: /archived thread/i })).toBeInTheDocument();
    expect(within(index).getAllByRole("link", { name: /archived thread/i })).toHaveLength(1);
  });

  it("keeps phase categories as sidebar accordions instead of center card panels", async () => {
    mockParams = { companyPrefix: "TC" };
    vi.mocked(threadsApi.list).mockImplementation(async (_companyId, options?: { status?: string }) => {
      if (options?.status === "archived") {
        return { discussions: [], total: 0, limit: 50, offset: 0 };
      }
      return {
        discussions: [
          makeThread({
            id: "thread-rich",
            title: "Clarify pricing page objections",
            phase: "scope",
            scopeType: "department",
            scopeName: "Growth",
            visibility: "company",
            lastEntryInputType: "transcript",
            pendingItemCount: 2,
            summaryText: "Customer call surfaced confusion around pricing proof.",
            summaryNext: "Approve extracted objections before creating pricing tasks.",
            participantPreview: [
              { principalType: "user", principalId: "user-1", name: "TK", role: "owner" },
              { principalType: "agent", principalId: "agent-1", name: "Revenue Agent", role: "worker" },
            ],
            participantCount: 2,
          } as Partial<ThreadListItem>),
        ],
        total: 1,
        limit: 50,
        offset: 0,
      };
    });

    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });
    const index = await screen.findByTestId("threads-index");
    await userEvent.setup().click(within(index).getByRole("button", { name: /^scope$/i }));

    expect(screen.getByTestId("threads-home-overview")).toBeInTheDocument();
    expect(screen.getByTestId("threads-global-viewer")).toBeInTheDocument();
    expect(screen.queryByTestId("threads-phase-panel-scope")).not.toBeInTheDocument();
    expect(within(index).queryByRole("link", { name: /clarify pricing page objections/i })).not.toBeInTheDocument();

    await userEvent.setup().click(within(index).getByRole("button", { name: /toggle scope/i }));
    expect(within(index).getByRole("link", { name: /clarify pricing page objections/i })).toBeInTheDocument();
  });

  it("renders auto-routing in the Discussions header with founder edit access", async () => {
    mockParams = { companyPrefix: "TC" };
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const index = await screen.findByTestId("threads-index");
    const footer = within(index).getByTestId("thread-rail-footer");

    expect(within(footer).queryByTestId("routing-dial")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("threads-home-header")).getByTestId("routing-dial")).toHaveAttribute("data-can-edit", "true");
  });

  it("renders routing read-only for non-founders in the Discussions header", async () => {
    testState.teamAccessRole = "team_lead";
    mockParams = { companyPrefix: "TC" };
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const index = await screen.findByTestId("threads-index");
    const footer = within(index).getByTestId("thread-rail-footer");

    expect(within(footer).queryByTestId("routing-dial")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("threads-home-header")).getByTestId("routing-dial")).toHaveAttribute("data-can-edit", "false");
  });

  it("renders selected discussion as a three-pane workspace", async () => {
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    await waitFor(() => {
      expect(screen.getByTestId("threads-workspace")).toBeInTheDocument();
      expect(screen.getByTestId("threads-index")).toBeInTheDocument();
      expect(screen.getByTestId("threads-detail")).toBeInTheDocument();
      expect(screen.getByTestId("mock-thread-detail")).toHaveAttribute("data-embedded", "true");
    });
  });

  it("starts selected detail with the left pane in Threads mode", async () => {
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    await waitFor(() => {
      expect(screen.getByTestId("threads-index")).toHaveAttribute("data-mode", "threads");
      expect(screen.getByTestId("threads-index")).toHaveAttribute("data-expanded", "false");
      expect(screen.getByText("Thread one")).toBeInTheDocument();
    });
  });

  it("shows icon-led collapsible thread groups without header counts", async () => {
    mockParams = { companyPrefix: "TC" };
    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions"] });

    const index = await screen.findByTestId("threads-index");

    await waitFor(() => {
      expect(within(index).getByRole("button", { name: /^unlisted$/i })).toBeInTheDocument();
      expect(within(index).getByRole("button", { name: /^discuss$/i })).toBeInTheDocument();
      expect(within(index).getByRole("button", { name: /^scope$/i })).toBeInTheDocument();
      expect(within(index).getByRole("button", { name: /^assign$/i })).toBeInTheDocument();
      expect(within(index).getByRole("button", { name: /^done$/i })).toBeInTheDocument();
      expect(within(index).getByRole("button", { name: /^archived$/i })).toBeInTheDocument();
      expect(within(index).getByRole("link", { name: /thread one/i })).toBeInTheDocument();
      expect(within(index).getByRole("link", { name: /thread two/i })).toBeInTheDocument();
    });

    expect(index.querySelector("[data-phase-dot='true']")).not.toBeInTheDocument();
    expect(index.querySelector("[data-section-count='true']")).not.toBeInTheDocument();
    expect(index.querySelectorAll("[data-section-icon='true']")).toHaveLength(6);
    expect(index.querySelectorAll("[data-section-chevron='true']")).toHaveLength(6);
    expect(index.querySelector("[data-section-icon='true']")).toHaveClass("size-3.5");
    expect(index.querySelector("[data-section-chevron='true']")).toHaveClass("opacity-0");

    await user.click(within(index).getByRole("button", { name: /^scope$/i }));
    expect(screen.getByTestId("threads-home-overview")).toBeInTheDocument();
    expect(screen.getByTestId("threads-global-viewer")).toBeInTheDocument();
    expect(screen.queryByTestId("threads-phase-panel-scope")).not.toBeInTheDocument();
    expect(within(index).queryByRole("link", { name: /thread two/i })).not.toBeInTheDocument();

    await user.click(within(index).getByRole("button", { name: /toggle scope/i }));
    expect(within(index).getByRole("link", { name: /thread two/i })).toBeInTheDocument();
  });

  it("indents thread rows under their category", async () => {
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    const index = await screen.findByTestId("threads-index");

    await waitFor(() => {
      expect(within(index).getByRole("link", { name: /thread one/i })).toBeInTheDocument();
    });

    expect(within(index).getByTestId("thread-rail-row-thread-1")).toHaveClass("pl-7");
  });

  it("renders active thread rows as plain nested nav items without a background card", async () => {
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    const index = await screen.findByTestId("threads-index");

    const activeThread = await within(index).findByRole("link", { name: /thread one/i });

    expect(activeThread).toHaveAttribute("aria-current", "page");
    expect(activeThread).not.toHaveClass("bg-accent");
    expect(activeThread).not.toHaveClass("text-accent-foreground");
    expect(activeThread).toHaveClass("text-foreground");
  });

  it("gives thread rows a subtle hover background for row actions", async () => {
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    const index = await screen.findByTestId("threads-index");
    const threadRow = await within(index).findByTestId("thread-rail-row-thread-1");

    expect(threadRow).toHaveClass("hover:bg-white/[0.04]");
  });

  it("fades thread row metadata behind the hover action button", async () => {
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    const index = await screen.findByTestId("threads-index");

    expect(await within(index).findByTestId("thread-row-meta-thread-1")).toHaveClass(
      "group-hover:opacity-0",
    );
    expect(
      within(index).getByRole("button", { name: /thread one actions/i }),
    ).toHaveClass("z-10");
  });

  it("pins thread row metadata to the right edge", async () => {
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    const index = await screen.findByTestId("threads-index");

    await waitFor(() => {
      expect(within(index).getByRole("link", { name: /thread one/i })).toBeInTheDocument();
    });

    expect(within(index).getByTestId("thread-row-meta-thread-1")).toHaveClass("right-2");
    expect(within(index).getByTestId("thread-row-time-thread-1")).toBeInTheDocument();
  });

  it("does not render auto-routing controls in the detail sidebar footer", async () => {
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    await screen.findByTestId("threads-index");
    const footer = screen.getByTestId("thread-rail-footer");

    expect(within(footer).queryByTestId("routing-dial")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: /discussion views/i })).not.toBeInTheDocument();
  });

  it("uses brand styling for the full-width new thread action", async () => {
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    await screen.findByTestId("threads-index");
    expect(screen.getByRole("button", { name: /new thread/i })).toHaveClass("bg-brand");
    expect(screen.getByRole("button", { name: /new thread/i })).toHaveClass("text-white");
  });

  it("shows pending sidebar threads as an amber dot instead of a count or time", async () => {
    vi.mocked(threadsApi.list).mockImplementation(async (_companyId, options?: { status?: string }) => {
      if (options?.status === "archived") {
        return { discussions: [], total: 0, limit: 50, offset: 0 };
      }
      return {
        discussions: [
          makeThread({ id: "thread-1", title: "Thread one" }),
          makeThread({
            id: "thread-2",
            title: "Thread two",
            phase: "scope",
            pendingItemCount: 10,
            lastEntryAt: "2026-01-01T01:00:00Z",
          }),
        ],
        total: 2,
        limit: 50,
        offset: 0,
      };
    });

    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    const index = await screen.findByTestId("threads-index");

    await waitFor(() => {
      expect(within(index).getByRole("link", { name: /thread two/i })).toBeInTheDocument();
    });

    expect(within(index).getByTestId("thread-row-pending-thread-2")).toHaveClass("bg-amber-400");
    expect(within(index).queryByLabelText(/10 pending/i)).not.toBeInTheDocument();
    expect(within(index).queryByTestId("thread-row-time-thread-2")).not.toBeInTheDocument();
  });

  it("keeps search and collapse controls in the detail sidebar header", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    const index = await screen.findByTestId("threads-index");
    const header = within(index).getByTestId("thread-rail-header");
    const controls = within(header).getAllByRole("button");

    expect(controls[0]).toHaveAccessibleName(/search threads/i);
    expect(controls[1]).toHaveAccessibleName(/collapse thread browser/i);
    expect(within(index).queryByRole("searchbox", { name: /search threads/i })).not.toBeInTheDocument();

    await user.click(within(header).getByRole("button", { name: /search threads/i }));

    const search = within(index).getByRole("searchbox", { name: /search threads/i });
    await user.type(search, "two");

    expect(within(index).queryByRole("link", { name: /thread one/i })).not.toBeInTheDocument();
    expect(within(index).getByRole("link", { name: /thread two/i })).toBeInTheDocument();
  });

  it("archives a thread from the sidebar row action menu", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    await screen.findByTestId("threads-index");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /thread one actions/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /thread one actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /archive thread/i }));

    expect(threadsApi.setStatus).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: /archive thread/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^archive$/i }));

    expect(threadsApi.setStatus).toHaveBeenCalledWith("comp-1", "thread-1", "archived");
  });

  it("collapses the left pane to an icon rail", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    await screen.findByTestId("threads-index");
    await user.click(screen.getByRole("button", { name: /collapse thread browser/i }));

    expect(screen.getByTestId("threads-index")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByLabelText("Collapsed thread categories")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new thread/i })).toHaveClass("bg-brand");
    expect(screen.getByRole("button", { name: /^discuss$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^scope$/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /thread one/i })).not.toBeInTheDocument();
  });

  it("keeps the sidebar footer visible at the bottom when collapsed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    await screen.findByTestId("threads-index");
    await user.click(screen.getByRole("button", { name: /collapse thread browser/i }));

    expect(screen.getByTestId("thread-rail-footer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /board view/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /list view/i })).not.toBeInTheDocument();
  });

  it("expands the collapsed rail into the selected category", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    await screen.findByTestId("threads-index");
    await user.click(screen.getByRole("button", { name: /collapse thread browser/i }));
    await user.click(screen.getByRole("button", { name: /^scope$/i }));

    const index = screen.getByTestId("threads-index");
    expect(index).toHaveAttribute("data-collapsed", "false");
    expect(within(index).getByRole("button", { name: /^scope$/i })).toHaveAttribute("aria-expanded", "true");
    expect(within(index).getByRole("link", { name: /thread two/i })).toBeInTheDocument();
  });

  it("marks collapsed categories with pending human attention", async () => {
    vi.mocked(threadsApi.list).mockImplementation(async (_companyId, options?: { status?: string }) => {
      if (options?.status === "archived") {
        return { discussions: [], total: 0, limit: 50, offset: 0 };
      }
      return {
        discussions: [
          makeThread({ id: "thread-1", title: "Thread one" }),
          makeThread({
            id: "thread-2",
            title: "Thread two",
            phase: "scope",
            pendingItemCount: 2,
          }),
        ],
        total: 2,
        limit: 50,
        offset: 0,
      };
    });

    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    await screen.findByTestId("threads-index");
    await user.click(screen.getByRole("button", { name: /collapse thread browser/i }));

    expect(screen.getByTestId("collapsed-section-pending-scope")).toHaveClass("bg-amber-400");
  });

  it("dragging the left pane past the browser threshold navigates to the discussions home page", async () => {
    renderWithProviders(
      <>
        <ThreadsWorkspace />
        <LocationProbe />
      </>,
      { initialEntries: ["/TC/discussions/thread-1"] },
    );

    await screen.findByTestId("threads-index");
    const resizeHandle = screen.getByRole("separator", { name: /resize thread browser/i });

    fireEvent.pointerDown(resizeHandle, { clientX: 264, pointerId: 1 });
    fireEvent.pointerMove(resizeHandle, { clientX: 760, pointerId: 1 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 1 });

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/TC/discussions");
    });
  });

  it("keeps the left browser open when the viewer reports wide mode", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    await screen.findByTestId("threads-index");
    await user.click(screen.getByRole("button", { name: /simulate wide viewer/i }));

    expect(screen.getByTestId("threads-index")).toHaveAttribute("data-collapsed", "false");
  });

  it("still lets the left browser collapse explicitly after viewer wide mode", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThreadsWorkspace />, { initialEntries: ["/TC/discussions/thread-1"] });

    await screen.findByTestId("threads-index");
    await user.click(screen.getByRole("button", { name: /simulate wide viewer/i }));
    expect(screen.getByTestId("threads-index")).toHaveAttribute("data-collapsed", "false");

    await user.click(screen.getByRole("button", { name: /collapse thread browser/i }));
    expect(screen.getByTestId("threads-index")).toHaveAttribute("data-collapsed", "true");
  });
});
