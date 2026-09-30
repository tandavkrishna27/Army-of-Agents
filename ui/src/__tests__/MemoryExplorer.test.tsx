import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../context/ToastContext";

const memoryApiMock = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  companyGraph: vi.fn(async () => ({
    nodes: [
      {
        type: "memory_item",
        id: "mem-graph-1",
        companyId: "co-1",
        label: "Company strategy",
        status: "approved",
        href: "/memory/explore?item=mem-graph-1",
      },
      {
        type: "department",
        id: "dept-eng",
        companyId: "co-1",
        label: "Engineering",
        status: "active",
        href: "/memory/explore?dept=dept-eng",
      },
    ],
    edges: [
      {
        id: "edge-company-strategy",
        companyId: "co-1",
        from: { type: "memory_item", id: "mem-graph-1" },
        to: { type: "department", id: "dept-eng" },
        kind: "belongs_to",
        sourceClass: "derived",
        editability: "source_row_only",
      },
    ],
    limit: 100,
    truncated: false,
  })),
  get: vi.fn(async () => ({
    id: "mem-1",
    companyId: "co-1",
    title: "Deep linked memory",
    content: "Opened from URL.",
    category: "workflow",
    source: "manual",
    status: "approved",
    tags: [],
    departmentId: null,
    projectId: null,
    createdBy: "test",
    layer: "domain",
    priority: 0,
    visibility: "scoped",
    expiresAt: null,
    goalId: null,
    taskId: null,
    sourceArtifactId: null,
    sourceContext: null,
    accessedAt: null,
    currentVersionId: null,
    embeddingRetries: 0,
    agentId: null,
    validationCount: 1,
    lastValidatedAt: null,
    pinnedToSkill: false,
    importJobId: null,
    folderPath: "",
    lastAccessedByUserId: null,
    founderPinnedToTop: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  })),
  neighbors: vi.fn(async () => ({
    center: { id: "mem-1", label: "Deep linked memory" },
    nodes: [],
    edges: [],
  })),
  usage: vi.fn(async () => ({ agents: [] })),
  moveItem: vi.fn(),
  setPinnedToTop: vi.fn(),
}));

const sigmaKillMock = vi.hoisted(() => vi.fn());
const sigmaOnMock = vi.hoisted(() => vi.fn());

vi.mock("sigma", () => ({
  default: vi.fn().mockImplementation(() => ({
    kill: sigmaKillMock,
    on: sigmaOnMock,
  })),
}));

// Mock react-pdf and pdfjs-dist to avoid DOMMatrix/canvas issues in jsdom
vi.mock("react-pdf", () => ({
  Document: ({ children }: any) => <div data-testid="pdf-document">{children}</div>,
  Page: () => <div data-testid="pdf-page" />,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {} }));

// Mock react-resizable-panels with simple divs
vi.mock("react-resizable-panels", () => ({
  Group: ({ children, ...props }: any) => (
    <div data-testid="panel-group" {...props}>
      {children}
    </div>
  ),
  Panel: ({
    children,
    id,
    defaultSize,
    minSize,
    maxSize,
    collapsedSize,
    collapsible,
    panelRef: _panelRef,
    onResize: _onResize,
    ...props
  }: any) => (
    <div
      data-testid={`panel-${id}`}
      data-default-size={defaultSize}
      data-min-size={minSize}
      data-max-size={maxSize}
      data-collapsed-size={collapsedSize}
      data-collapsible={collapsible ? "true" : "false"}
      id={id}
      {...props}
    >
      {children}
    </div>
  ),
  Separator: ({ id, ...props }: any) => (
    <div data-testid={`separator-${id}`} id={id} role="separator" {...props} />
  ),
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: vi.fn(),
    onLayoutChange: vi.fn(),
  }),
}));

vi.mock("../api/memoryFolders", () => ({
  memoryFoldersApi: {
    list: vi.fn(async () => [
      {
        id: "f-company",
        companyId: "co-1",
        departmentId: null,
        path: "Company",
        displayName: "Company",
        icon: "🏛️",
        sortOrder: 0,
        seedKey: "company.root",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "f-eng-decisions",
        companyId: "co-1",
        departmentId: "dept-eng",
        path: "engineering/Decisions",
        displayName: "Decisions",
        icon: null,
        sortOrder: 0,
        seedKey: "software_development.decisions",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]),
  },
}));

vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: {
    list: vi.fn(async () => []),
    contentUrl: () => "/test/content/url",
  },
}));

vi.mock("../api/memory", () => ({
  memoryApi: memoryApiMock,
}));

vi.mock("../api/filesystem", () => ({
  filesystemApi: {
    home: vi.fn(async () => ({
      homePath: "C:\\Users\\TK",
      platform: "win32",
    })),
    browse: vi.fn(async () => ({
      currentPath: "C:\\Users\\TK\\AoA Company",
      parentPath: "C:\\Users\\TK",
      homePath: "C:\\Users\\TK",
      platform: "win32",
      entries: [
        {
          name: "Company",
          path: "C:\\Users\\TK\\AoA Company\\Company",
          isDirectory: true,
          isGitRepo: false,
        },
        {
          name: "brand.md",
          path: "C:\\Users\\TK\\AoA Company\\brand.md",
          isDirectory: false,
          isGitRepo: false,
        },
      ],
    })),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(async () => [
      {
        id: "dept-eng",
        type: "department",
        name: "Engineering",
        urlKey: "engineering",
        archivedAt: null,
        functionType: "software_development",
      },
    ]),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "co-1",
    selectedCompany: {
      id: "co-1",
      issuePrefix: "co1",
      name: "Test Co",
      rootFolder: "C:\\Users\\TK\\AoA\\Test Co",
    },
    companyPrefix: "co1",
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: vi.fn(),
    setSubtitle: vi.fn(),
    setEntityColor: vi.fn(),
  }),
}));

import { MemoryExplorer } from "../pages/MemoryExplorer";

function renderPage(initialEntry = "/co1/memory/explore") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <MemoryExplorer />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("MemoryExplorer (Phase 6.1a smoke test)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders 3 panes and shows company + dept folders in the tree", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Folders/i)).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText("Company")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getAllByText("Engineering").length).toBeGreaterThan(0),
    );
  });

  it("renders Map in the viewer on Home instead of a blank right pane", async () => {
    renderPage();
    // Center pane should still render the home dashboard.
    await waitFor(() =>
      expect(screen.getByText(/Identity/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: /Map/i })).toBeInTheDocument();
    expect(await screen.findByTestId("company-graph-sigma-canvas")).toBeInTheDocument();
    expect(screen.queryByText(/Pick a memory item or upload a file to start/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Coming soon/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Memory graph view/i)).not.toBeInTheDocument();
  });

  it("uses rounded panel shells for the folder, list, and viewer panes", async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Folders/i)).toBeInTheDocument(),
    );

    for (const id of ["memory-tree-shell", "memory-list-shell", "memory-viewer-shell"]) {
      const shell = screen.getByTestId(id);
      expect(shell.className).toContain("rounded-xl");
      expect(shell.className).toContain("border");
      expect(shell.className).toContain("bg-background");
    }
  });

  it("uses 42px panel headers with collapse controls inside memory chrome", async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Folders/i)).toBeInTheDocument(),
    );

    for (const id of ["memory-tree-header", "memory-list-header", "memory-viewer-header"]) {
      expect(screen.getByTestId(id).className).toContain("h-[42px]");
    }

    expect(screen.getByTestId("memory-tree-header")).toContainElement(
      screen.getByLabelText("Collapse folders"),
    );
    expect(screen.getByTestId("memory-viewer-header")).toContainElement(
      screen.getByLabelText("Hide preview"),
    );
  });

  it("does not render floating separator collapse buttons for memory panes", async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Folders/i)).toBeInTheDocument(),
    );

    for (const id of ["separator-memory-explorer-sep-1", "separator-memory-explorer-sep-2"]) {
      expect(screen.getByTestId(id).querySelector("button")).toBeNull();
    }
  });

  it("uses the selected company root folder as the default Local root", async () => {
    const { filesystemApi } = await import("../api/filesystem");

    renderPage();

    await waitFor(() =>
      expect(filesystemApi.browse).toHaveBeenCalledWith(
        "C:\\Users\\TK\\AoA\\Test Co",
        {
          gitAware: true,
          includeFiles: false,
        },
      ),
    );
  });

  it("opens memory item deep links even when the URL omits legacy type=memory_item", async () => {
    renderPage("/co1/memory/explore?item=mem-1");

    await waitFor(() =>
      expect(memoryApiMock.get).toHaveBeenCalledWith("co-1", "mem-1"),
    );
  });

  it("defaults the Memory Home viewer to Map", async () => {
    renderPage();

    await waitFor(() =>
      expect(memoryApiMock.companyGraph).toHaveBeenCalledWith("co-1", {
        includeStructural: true,
        limit: 100,
      }),
    );

    expect(screen.getByRole("tab", { name: /Map/i })).toBeInTheDocument();
    expect(await screen.findByTestId("company-graph-sigma-canvas")).toBeInTheDocument();
    expect(screen.queryByText("Pick a memory item or upload a file to start")).not.toBeInTheDocument();
  });

  it("gives the Memory Home viewer a wide default pane for the map", async () => {
    renderPage();

    await screen.findByRole("tab", { name: /Map/i });

    expect(screen.getByTestId("panel-memory-explorer-tree")).toHaveAttribute("data-default-size", "18%");
    expect(screen.getByTestId("panel-memory-explorer-list")).toHaveAttribute("data-default-size", "32%");
    expect(screen.getByTestId("panel-memory-explorer-viewer")).toHaveAttribute("data-default-size", "50%");
    expect(screen.getByTestId("panel-memory-explorer-viewer")).toHaveAttribute("data-min-size", "30%");
  });

  it("opens one closeable Open tab from the viewer add button", async () => {
    renderPage();

    await screen.findByRole("tab", { name: /Map/i });

    fireEvent.click(screen.getByRole("button", { name: "New memory viewer tab" }));
    expect(screen.getByRole("tab", { name: /Open/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Map" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Recent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Unlinked" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Review Queue" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New memory viewer tab" }));
    expect(screen.getAllByRole("tab", { name: /Open/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Close Open" }));
    expect(screen.queryByRole("tab", { name: /Open/i })).not.toBeInTheDocument();
  });

  it("activates Map from the Open tab in the shared viewer", async () => {
    renderPage();

    await screen.findByRole("tab", { name: /Map/i });

    fireEvent.click(screen.getByRole("button", { name: "New memory viewer tab" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Map" }));

    await waitFor(() =>
      expect(memoryApiMock.companyGraph).toHaveBeenCalledWith("co-1", {
        includeStructural: true,
        limit: 100,
      }),
    );
    expect(await screen.findByTestId("company-graph-sigma-canvas")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show graph details" }));
    expect(screen.getByRole("button", { name: "Select Company strategy" })).toBeInTheDocument();
  });

  it("shows local folders and files when a local path is selected", async () => {
    renderPage("/co1/memory/explore?localPath=C%3A%5CUsers%5CTK%5CAoA%20Company");

    await waitFor(() =>
      expect(screen.getByText("Local")).toBeInTheDocument(),
    );
    expect(await screen.findByTestId("memory-local-list")).toBeInTheDocument();
    expect(screen.getAllByText("AoA Company").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Company").length).toBeGreaterThan(0);
    expect(screen.getByText("brand.md")).toBeInTheDocument();
  });
});
