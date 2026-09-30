import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { MemoryAssetRecord } from "@armyofagents/shared";
import { MemoryViewer } from "../MemoryViewer";
import { memoryApi } from "../../../api/memory";
import { memoryAssetsApi } from "../../../api/memoryAssets";
import type { MemoryTab } from "../../../lib/memoryTabs";

vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { issuePrefix: "THR" },
  }),
}));

vi.mock("../../../api/memory", () => ({
  memoryApi: {
    list: vi.fn(),
  },
}));

vi.mock("../../../api/memoryAssets", () => ({
  memoryAssetsApi: {
    get: vi.fn(),
    contentUrl: vi.fn((companyId: string, id: string) => `/api/companies/${companyId}/memory/assets/${id}/content`),
    list: vi.fn(),
  },
}));

vi.mock("../../viewers/SharedContentViewer", () => ({
  SharedContentViewer: ({
    viewer,
    filename,
  }: {
    viewer: { kind: string; assetUrl: string | null; url: string | null };
    filename: string;
  }) => (
    <div data-testid="shared-content-viewer">
      {viewer.kind}:{filename}:{viewer.assetUrl ?? viewer.url}
    </div>
  ),
}));

vi.mock("../viewers/DocxFileViewer", () => ({
  DocxFileViewer: ({ companyId, assetId }: { companyId: string; assetId: string }) => (
    <div data-testid="docx-file-viewer">{companyId}:{assetId}</div>
  ),
}));

vi.mock("../viewers/XlsxFileViewer", () => ({
  XlsxFileViewer: ({ companyId, assetId }: { companyId: string; assetId: string }) => (
    <div data-testid="xlsx-file-viewer">{companyId}:{assetId}</div>
  ),
}));

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function asset(overrides: Partial<MemoryAssetRecord>): MemoryAssetRecord {
  return {
    id: "asset-1",
    companyId: "co-1",
    departmentId: null,
    folderPath: "/",
    fileName: "file.bin",
    mimeType: "application/octet-stream",
    fileSize: 123,
    storageKey: "memory/asset-1",
    importJobId: null,
    extractedItemCount: 0,
    metadata: null,
    uploadedByUserId: null,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

function renderAssetViewer(record: MemoryAssetRecord) {
  vi.mocked(memoryAssetsApi.get).mockResolvedValue(record);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tabs: MemoryTab[] = [{ id: record.id, kind: "asset", title: record.fileName }];

  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <MemoryViewer
          companyId="co-1"
          tabs={tabs}
          activeKey={{ id: record.id, kind: "asset" }}
          onActivate={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("MemoryViewer asset routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(memoryApi.list).mockResolvedValue({ items: [], semanticAvailable: true });
    vi.mocked(memoryAssetsApi.list).mockResolvedValue([]);
  });

  it.each([
    ["application/pdf", "report.pdf", "pdf"],
    ["image/png", "diagram.png", "image"],
    ["video/mp4", "demo.mp4", "video"],
    ["application/x-zip-compressed", "bundle.zip", "download"],
  ])("routes %s assets through the shared %s viewer path", async (mimeType, fileName, viewerKind) => {
    renderAssetViewer(asset({ mimeType, fileName }));

    await waitFor(() => expect(screen.getByTestId("shared-content-viewer")).toBeInTheDocument());
    expect(screen.getByTestId("shared-content-viewer")).toHaveTextContent(
      `${viewerKind}:${fileName}:/api/companies/co-1/memory/assets/asset-1/content`,
    );
    expect(screen.queryByTestId("docx-file-viewer")).not.toBeInTheDocument();
  });

  it("keeps DOCX assets on the Memory-specific DOCX viewer", async () => {
    renderAssetViewer(asset({ mimeType: DOCX_MIME, fileName: "brief.docx" }));

    await waitFor(() => expect(screen.getByTestId("docx-file-viewer")).toBeInTheDocument());
    expect(screen.getByTestId("docx-file-viewer")).toHaveTextContent("co-1:asset-1");
    expect(screen.queryByTestId("shared-content-viewer")).not.toBeInTheDocument();
  });

  it("routes XLSX assets to the Memory-specific XLSX viewer (not a download card)", async () => {
    renderAssetViewer(asset({ mimeType: XLSX_MIME, fileName: "budget.xlsx" }));

    await waitFor(() => expect(screen.getByTestId("xlsx-file-viewer")).toBeInTheDocument());
    expect(screen.getByTestId("xlsx-file-viewer")).toHaveTextContent("co-1:asset-1");
    // Not the generic shared viewer / download fallback.
    expect(screen.queryByTestId("shared-content-viewer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("docx-file-viewer")).not.toBeInTheDocument();
  });
});

describe("MemoryViewer collection tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(memoryAssetsApi.list).mockResolvedValue([]);
  });

  it("renders recent memories with real recents data", async () => {
    vi.mocked(memoryApi.list).mockResolvedValue({
      items: [
        {
          id: "mem-1",
          companyId: "co-1",
          title: "Pricing memo",
          content: "Seat pricing notes",
          status: "approved",
          category: "decision",
          layer: "domain",
          visibility: "shared",
          departmentId: null,
          projectId: null,
          goalId: null,
          taskId: null,
          sourceArtifactId: null,
          agentId: null,
          folderPath: "Company/Decisions",
          tags: [],
          embedding: null,
          createdBy: "founder@example.com",
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-06-02T10:00:00.000Z",
        },
      ],
      semanticAvailable: true,
    } as never);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tabs: MemoryTab[] = [{ id: "recent", kind: "collection", title: "Recent" }];

    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <MemoryViewer
            companyId="co-1"
            tabs={tabs}
            activeKey={{ id: "recent", kind: "collection" }}
            onActivate={vi.fn()}
            onClose={vi.fn()}
            onOpenTab={vi.fn()}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Pricing memo")).toBeInTheDocument();
    expect(screen.queryByText("Recent memory activity will appear here.")).not.toBeInTheDocument();
  });
});
