import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const navigateMock = vi.fn();
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("../api/memory", () => ({
  memoryApi: {
    list: vi.fn(async () => ({
      items: [
        { id: "i-id1", title: "Vision", layer: "identity", status: "approved" },
        { id: "i-d1", title: "Auth strategy", layer: "domain", status: "approved" },
        { id: "i-d2", title: "API standards", layer: "domain", status: "pending" },
        { id: "i-a1", title: "Q3 context", layer: "active_context", status: "approved" },
        { id: "i-w1", title: "Working note", layer: "working", status: "approved" },
      ],
      semanticAvailable: true,
    })),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "co-1",
    selectedCompany: { issuePrefix: "co1" },
  }),
}));

import { LayerTilesPanel } from "../components/memory/LayerTilesPanel";

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LayerTilesPanel companyId="co-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("LayerTilesPanel", () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  it("renders all 4 layer tiles", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Identity")).toBeInTheDocument());
    expect(screen.getByText("Domain")).toBeInTheDocument();
    expect(screen.getByText("Active context")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("shows correct item count per layer", async () => {
    renderPanel();
    // Identity: 1 item, Domain: 2, Active: 1, Working: 1
    await waitFor(() => {
      const identityTile = screen.getByText("Identity").closest("button");
      expect(identityTile?.textContent).toContain("1 item");
    });
    const domainTile = screen.getByText("Domain").closest("button");
    expect(domainTile?.textContent).toContain("2 items");
  });

  it("shows pending count when > 0", async () => {
    renderPanel();
    await waitFor(() => {
      const domainTile = screen.getByText("Domain").closest("button");
      expect(domainTile?.textContent).toMatch(/1 pending/i);
    });
  });

  it("does not show pending when 0", async () => {
    renderPanel();
    await waitFor(() => {
      const identityTile = screen.getByText("Identity").closest("button");
      expect(identityTile?.textContent).not.toMatch(/pending/i);
    });
  });

  it("navigates to /memory/explore?layer=<layer> on click", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => screen.getByText("Domain"));
    const domainTile = screen.getByText("Domain").closest("button");
    expect(domainTile).not.toBeNull();
    await user.click(domainTile!);
    expect(navigateMock).toHaveBeenCalledWith("/co1/memory/explore?layer=domain");
  });
});
