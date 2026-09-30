import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../api/memory", () => ({
  memoryApi: {
    list: vi.fn(async () => ({
      items: [
        { id: "i-1", title: "Item one", status: "pending", departmentId: "d-eng", layer: "domain", updatedAt: "2026-05-01T00:00:00Z" },
        { id: "i-2", title: "Item two", status: "approved", departmentId: "d-eng", layer: "domain", updatedAt: "2026-05-02T00:00:00Z" },
      ],
      semanticAvailable: true,
    })),
  },
}));
vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: { list: vi.fn(async () => []) },
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "co-1", selectedCompany: { issuePrefix: "co1" } }),
}));

import { MemoryHomeDashboard } from "../components/memory/MemoryHomeDashboard";
import { MemoryViewerHome } from "../components/memory/MemoryViewerHome";

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemoryHomeDashboard companyId="co-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderViewerHome(onOpenTab?: (tab: { id: string; kind: "home" | "memory_item" | "asset" | "graph"; title: string }) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemoryViewerHome companyId="co-1" onOpenTab={onOpenTab} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemoryHomeDashboard (Phase 6.2a)", () => {
  beforeEach(() => vi.clearAllMocks());

  // Pending banner was removed in Phase 1 of the UI overhaul (the "PendingReviewPill"
  // now lives in the page-level MemoryToolbar, which is rendered by MemoryExplorer
  // — outside this component's surface). The pending UI is covered by
  // PendingReviewPill.test.tsx and MemoryToolbar.test.tsx.

  it("renders 4 layer tiles", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("Identity")).toBeInTheDocument());
    expect(screen.getByText("Domain")).toBeInTheDocument();
    expect(screen.getByText("Active context")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("renders recents", async () => {
    renderHome();
    // The 2 items mock above sorted by updatedAt — Item two newer, Item one older
    await waitFor(() => expect(screen.getByText("Item two")).toBeInTheDocument());
    expect(screen.getByText("Item one")).toBeInTheDocument();
  });

  it("renders viewer home content with a graph tab launcher", async () => {
    renderViewerHome();

    expect(screen.getByTestId("memory-viewer-home")).toBeInTheDocument();
    expect(screen.getByText(/Quick-jump to a memory item or file/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Identity")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Item two")).toBeInTheDocument());
    expect(screen.getByTestId("memory-home-graph-launcher")).toHaveTextContent(/Map/i);
  });

  it("opens the company graph as a viewer tab", async () => {
    const onOpenTab = vi.fn();
    renderViewerHome(onOpenTab);

    fireEvent.click(screen.getByRole("button", { name: /open company graph/i }));

    expect(onOpenTab).toHaveBeenCalledWith({
      id: "company-graph",
      kind: "graph",
      title: "Map",
    });
  });

  it("opens viewer home recents as tabs when a tab opener is provided", async () => {
    const onOpenTab = vi.fn();
    renderViewerHome(onOpenTab);

    await waitFor(() => expect(screen.getByText("Item two")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Item two"));

    expect(onOpenTab).toHaveBeenCalledWith({
      id: "i-2",
      kind: "memory_item",
      title: "Item two",
    });
  });
});
