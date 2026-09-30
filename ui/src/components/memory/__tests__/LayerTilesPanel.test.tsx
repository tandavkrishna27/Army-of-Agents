import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACME" } }),
}));

vi.mock("../../../api/memory", () => ({
  memoryApi: { list: (...a: unknown[]) => listMock(...a) },
}));

import { LayerTilesPanel } from "../LayerTilesPanel";

function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("LayerTilesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({
      items: [
        { id: "1", layer: "identity", status: "approved" },
        { id: "2", layer: "domain", status: "approved" },
        { id: "3", layer: "domain", status: "pending" },
        { id: "4", layer: "domain", status: "pending" },
        { id: "5", layer: "active_context", status: "approved" },
      ],
      semanticAvailable: true,
    });
  });

  it("renders all four layer tiles with correct labels", async () => {
    const { findByText } = renderWithProviders(<LayerTilesPanel companyId="co-1" />);
    expect(await findByText("Identity")).toBeInTheDocument();
    expect(await findByText("Domain")).toBeInTheDocument();
    expect(await findByText("Active context")).toBeInTheDocument();
    expect(await findByText("Working")).toBeInTheDocument();
  });

  it("renders pending count chip when a layer has pending items", async () => {
    const { findByText } = renderWithProviders(<LayerTilesPanel companyId="co-1" />);
    expect(await findByText("2 pending")).toBeInTheDocument();
  });

  it("does NOT use hover:shadow-md on tiles", async () => {
    const { container, findByText } = renderWithProviders(<LayerTilesPanel companyId="co-1" />);
    await findByText("Identity");
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    const tiles = container.querySelectorAll("button");
    for (const tile of tiles) {
      expect(tile.className).not.toContain("hover:shadow-md");
    }
  });
});
