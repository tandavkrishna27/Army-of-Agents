import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../context/ToastContext";

// Mutable: lets each test control the memory-list semanticAvailable flag.
let mockSemanticAvailable = true;

const memoryApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  companyGraph: vi.fn(async () => ({ nodes: [], edges: [], limit: 100, truncated: false })),
  get: vi.fn(async () => null),
  neighbors: vi.fn(async () => ({ center: null, nodes: [], edges: [] })),
  usage: vi.fn(async () => ({ agents: [] })),
  moveItem: vi.fn(),
  setPinnedToTop: vi.fn(),
}));

vi.mock("sigma", () => ({
  default: vi.fn().mockImplementation(() => ({ kill: vi.fn(), on: vi.fn() })),
}));

vi.mock("react-pdf", () => ({
  Document: ({ children }: any) => <div>{children}</div>,
  Page: () => <div />,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {} }));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Panel: ({ children, id, panelRef: _r, onResize: _o, ...props }: any) => (
    <div data-testid={`panel-${id}`} id={id} {...props}>
      {children}
    </div>
  ),
  Separator: ({ id, ...props }: any) => <div id={id} role="separator" {...props} />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn(), onLayoutChange: vi.fn() }),
}));

vi.mock("../api/memoryFolders", () => ({
  memoryFoldersApi: { list: vi.fn(async () => []) },
}));
vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: { list: vi.fn(async () => []), contentUrl: () => "/x" },
}));
vi.mock("../api/memory", () => ({ memoryApi: memoryApiMock }));
vi.mock("../api/filesystem", () => ({
  filesystemApi: {
    home: vi.fn(async () => ({ homePath: "/h", platform: "linux" })),
    browse: vi.fn(async () => ({ currentPath: "/h", parentPath: null, homePath: "/h", platform: "linux", entries: [] })),
  },
}));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn(async () => []) } }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "co-1",
    selectedCompany: { id: "co-1", issuePrefix: "co1", name: "Test Co", rootFolder: null },
    companyPrefix: "co1",
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn(), setSubtitle: vi.fn(), setEntityColor: vi.fn() }),
}));

import { MemoryExplorer } from "../pages/MemoryExplorer";

function renderPage(initialEntry = "/co1/memory/explore") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe("MemoryExplorer semantic-off banner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSemanticAvailable = true;
    memoryApiMock.list.mockImplementation(async () => ({
      items: [],
      semanticAvailable: mockSemanticAvailable,
    }));
  });

  it("shows 'add key in Settings → Memory' banner when semantic off", async () => {
    mockSemanticAvailable = false;
    renderPage();
    const banner = await screen.findByTestId("no-llm-key-banner");
    expect(banner).toHaveTextContent(/Settings.*Memory/);
  });

  it("does not show the banner when semantic available", async () => {
    mockSemanticAvailable = true;
    renderPage();
    // Wait for the list query to resolve so the banner has had a chance to render.
    await waitFor(() => expect(memoryApiMock.list).toHaveBeenCalled());
    expect(screen.queryByTestId("no-llm-key-banner")).toBeNull();
  });
});
