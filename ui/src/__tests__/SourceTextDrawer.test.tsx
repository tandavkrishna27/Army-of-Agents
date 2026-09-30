import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: {
    list: vi.fn(async () => [
      { id: "a-1", fileName: "rfc.pdf", mimeType: "application/pdf", fileSize: 12_345, importJobId: "j-1" },
    ]),
  },
}));

vi.mock("../api/memory", () => ({ memoryApi: {} }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "co1" } }),
}));

import { SourceTextDrawer } from "../components/memory/SourceTextDrawer";

function renderDrawer(open = true, importJobId = "j-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SourceTextDrawer
          open={open}
          onOpenChange={vi.fn()}
          companyId="co-1"
          importJobId={importJobId}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SourceTextDrawer", () => {
  it("renders the matching asset's filename + size", async () => {
    renderDrawer();
    await waitFor(() => expect(screen.getByText("rfc.pdf")).toBeInTheDocument());
    expect(screen.getByText(/application\/pdf/i)).toBeInTheDocument();
  });

  it("shows a fallback when no asset matches the importJobId", async () => {
    renderDrawer(true, "j-99-not-found");
    await waitFor(() =>
      expect(screen.getByText(/source file for this item is no longer available/i)).toBeInTheDocument(),
    );
  });

  it("has an Open source in viewer button", async () => {
    renderDrawer();
    await waitFor(() => expect(screen.getByText("rfc.pdf")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /open source in viewer/i })).toBeInTheDocument();
  });
});
