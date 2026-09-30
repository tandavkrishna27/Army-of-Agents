import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Default the view mode to "list" so the list-mode assertions work across tests.
vi.mock("../hooks/useMemoryViewMode", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../hooks/useMemoryViewMode");
  return {
    ...actual,
    useMemoryViewMode: () => ({ mode: "list", setMode: vi.fn() }),
  };
});

const navigateMock = vi.fn();
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("../api/memory", () => ({
  memoryApi: {
    list: vi.fn(async () => ({
      items: [
        {
          id: "i-pinned",
          title: "Pinned item",
          category: "decision",
          status: "approved",
          updatedAt: "2026-05-01T00:00:00Z",
          folderPath: "engineering/Decisions",
          founderPinnedToTop: true,
        },
        {
          id: "i-pending",
          title: "Pending item",
          category: "reference",
          status: "pending",
          updatedAt: "2026-05-02T00:00:00Z",
          folderPath: "marketing/Brand",
          founderPinnedToTop: false,
        },
        {
          id: "i-other",
          title: "Other item",
          category: "context",
          status: "approved",
          updatedAt: "2026-04-29T00:00:00Z",
          folderPath: "engineering/Decisions",
          founderPinnedToTop: false,
        },
      ],
      semanticAvailable: true,
    })),
  },
}));
vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: { list: vi.fn(async () => []) },
}));
vi.mock("../api/memoryFolders", () => ({
  memoryFoldersApi: {
    list: vi.fn(async () => [
      {
        id: "f-eng-decisions",
        companyId: "co-1",
        departmentId: "d-eng",
        path: "engineering/Decisions",
        displayName: "Decisions",
        icon: null,
        sortOrder: 0,
        seedKey: "decisions",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "f-eng-q3",
        companyId: "co-1",
        departmentId: "d-eng",
        path: "engineering/Q3 Planning",
        displayName: "Q3 Planning",
        icon: "📂",
        sortOrder: 100,
        seedKey: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]),
  },
}));
vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(async () => [
      { id: "d-eng", type: "department", name: "Engineering", archivedAt: null, urlKey: "engineering" },
      { id: "d-mkt", type: "department", name: "Marketing", archivedAt: null, urlKey: "marketing" },
    ]),
  },
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "co-1",
    selectedCompany: { issuePrefix: "co1" },
  }),
}));

import { MemoryFileList } from "../components/memory/MemoryFileList";

function renderList(props: {
  folderPath: string;
  departmentId: string | null;
  layer?: string | null;
  onSelectRow?: (id: string, kind: "memory_item" | "asset", title: string) => void;
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemoryFileList
          companyId="co-1"
          folderPath={props.folderPath}
          departmentId={props.departmentId}
          layer={props.layer}
          selectedItemId={null}
          selectedItemType={null}
          onSelectRow={props.onSelectRow ?? vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemoryFileList — virtual folders (Phase 6.1e)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateMock.mockClear();
  });

  it("__pinned shows only items with founderPinnedToTop=true", async () => {
    renderList({ folderPath: "__pinned", departmentId: null });
    await waitFor(() =>
      expect(screen.getByText("Pinned item")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Pending item")).not.toBeInTheDocument();
    expect(screen.queryByText("Other item")).not.toBeInTheDocument();
  });

  it("__pending shows only items with status=pending", async () => {
    renderList({ folderPath: "__pending", departmentId: null });
    await waitFor(() =>
      expect(screen.getByText("Pending item")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Pinned item")).not.toBeInTheDocument();
    expect(screen.queryByText("Other item")).not.toBeInTheDocument();
  });

  it("regular folder shows items with matching folderPath", async () => {
    renderList({
      folderPath: "engineering/Decisions",
      departmentId: "d-eng",
    });
    await waitFor(() =>
      expect(screen.getByText("Pinned item")).toBeInTheDocument(),
    );
    expect(screen.getByText("Other item")).toBeInTheDocument();
    expect(screen.queryByText("Pending item")).not.toBeInTheDocument();
  });
});

describe("MemoryFileList — Phase 6.2a virtual folders + layer-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateMock.mockClear();
  });

  it("renders active_context items with expiresAt in the list", async () => {
    // ExpiresAtChip is no longer rendered inline by MemoryItemRow — expiry
    // metadata is displayed in the item detail panel on selection. This test
    // verifies the item itself appears in list mode.
    const { memoryApi } = await import("../api/memory");
    (memoryApi.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [
        {
          id: "i-active",
          title: "Active item",
          category: "context",
          status: "approved",
          layer: "active_context",
          updatedAt: "2026-05-01T00:00:00Z",
          folderPath: "engineering/Decisions",
          founderPinnedToTop: false,
          expiresAt: "2026-05-08T12:00:00Z",
        },
      ],
      semanticAvailable: true,
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-05-03T12:00:00Z"));
    renderList({
      folderPath: "engineering/Decisions",
      departmentId: "d-eng",
    });
    await waitFor(() => expect(screen.getByText("Active item")).toBeInTheDocument(), { timeout: 10000 });
    vi.useRealTimers();
  });

  it("__recent shows items updated in last 14 days, excludes archived", async () => {
    const { memoryApi } = await import("../api/memory");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-05-03T00:00:00Z"));
    (memoryApi.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [
        {
          id: "i-recent",
          title: "Recent item",
          category: "decision",
          status: "approved",
          updatedAt: "2026-05-01T00:00:00Z",
          folderPath: "any",
          founderPinnedToTop: false,
        },
        {
          id: "i-archived",
          title: "Archived item",
          category: "decision",
          status: "archived",
          updatedAt: "2026-05-02T00:00:00Z",
          folderPath: "any",
          founderPinnedToTop: false,
        },
        {
          id: "i-old",
          title: "Old item",
          category: "context",
          status: "approved",
          updatedAt: "2026-03-01T00:00:00Z",
          folderPath: "any",
          founderPinnedToTop: false,
        },
      ],
      semanticAvailable: true,
    });
    renderList({ folderPath: "__recent", departmentId: null });
    await waitFor(() =>
      expect(screen.getByText("Recent item")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Archived item")).not.toBeInTheDocument();
    expect(screen.queryByText("Old item")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("__archived shows only items with status=archived", async () => {
    const { memoryApi } = await import("../api/memory");
    (memoryApi.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [
        {
          id: "i-archived",
          title: "Archived item",
          category: "decision",
          status: "archived",
          updatedAt: "2026-04-10T00:00:00Z",
          folderPath: "any",
          founderPinnedToTop: false,
        },
        {
          id: "i-approved",
          title: "Approved item",
          category: "reference",
          status: "approved",
          updatedAt: "2026-05-01T00:00:00Z",
          folderPath: "any",
          founderPinnedToTop: false,
        },
      ],
      semanticAvailable: true,
    });
    renderList({ folderPath: "__archived", departmentId: null });
    await waitFor(() =>
      expect(screen.getByText("Archived item")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Approved item")).not.toBeInTheDocument();
  });

  it("layer-only URL (no folder, no dept) filters by layer", async () => {
    const { memoryApi } = await import("../api/memory");
    (memoryApi.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [
        {
          id: "i-domain",
          title: "Domain item",
          category: "reference",
          status: "approved",
          layer: "domain",
          updatedAt: "2026-05-01T00:00:00Z",
          folderPath: "",
          founderPinnedToTop: false,
        },
        {
          id: "i-identity",
          title: "Identity item",
          category: "decision",
          status: "approved",
          layer: "identity",
          updatedAt: "2026-05-01T00:00:00Z",
          folderPath: "",
          founderPinnedToTop: false,
        },
      ],
      semanticAvailable: true,
    });
    renderList({ folderPath: "", departmentId: null, layer: "domain" });
    await waitFor(() =>
      expect(screen.getByText("Domain item")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Identity item")).not.toBeInTheDocument();
  });
});

describe("MemoryFileList — Phase 6.2f folder-first", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateMock.mockClear();
  });

  it("dept-only URL shows subfolders + items at dept root", async () => {
    const { memoryApi } = await import("../api/memory");
    (memoryApi.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [
        {
          id: "i-root",
          title: "Engineering charter",
          category: "decision",
          status: "approved",
          layer: "domain",
          departmentId: "d-eng",
          folderPath: "engineering", // root-level item
          founderPinnedToTop: false,
          updatedAt: "2026-05-01T00:00:00Z",
        },
        {
          id: "i-nested",
          title: "Auth strategy",
          category: "decision",
          status: "approved",
          layer: "domain",
          departmentId: "d-eng",
          folderPath: "engineering/Decisions", // nested
          founderPinnedToTop: false,
          updatedAt: "2026-05-02T00:00:00Z",
        },
      ],
      semanticAvailable: true,
    });
    renderList({ folderPath: "", departmentId: "d-eng" });
    await waitFor(() =>
      expect(screen.getByText("Engineering charter")).toBeInTheDocument(),
    );
    // Subfolder tiles shown
    expect(screen.getByText("Decisions")).toBeInTheDocument();
    expect(screen.getByText("Q3 Planning")).toBeInTheDocument();
    // Nested item NOT shown at this level
    expect(screen.queryByText("Auth strategy")).not.toBeInTheDocument();
  });

  it("clicking a subfolder navigates to that folder", async () => {
    renderList({ folderPath: "", departmentId: "d-eng" });
    const user = userEvent.setup();
    await waitFor(() => screen.getByText("Decisions"));
    await user.click(screen.getByText("Decisions"));
    expect(navigateMock).toHaveBeenCalled();
    const lastCall = navigateMock.mock.calls[navigateMock.mock.calls.length - 1][0] as string;
    expect(lastCall).toContain("folder=engineering%2FDecisions");
    expect(lastCall).toContain("dept=d-eng");
  });

  it("subfolder shows aggregated item count (descendants too)", async () => {
    const { memoryApi } = await import("../api/memory");
    (memoryApi.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [
        {
          id: "i-1",
          title: "X",
          category: "decision",
          status: "approved",
          layer: "domain",
          departmentId: "d-eng",
          folderPath: "engineering/Decisions",
          founderPinnedToTop: false,
          updatedAt: "2026-05-01T00:00:00Z",
        },
      ],
      semanticAvailable: true,
    });
    renderList({ folderPath: "", departmentId: "d-eng" });
    await waitFor(() => screen.getByText("Decisions"));
    // The Decisions folder tile should show "1 item"
    const decisionsRow = screen.getByText("Decisions").closest("button");
    expect(decisionsRow?.textContent).toContain("1 item");
  });
});
