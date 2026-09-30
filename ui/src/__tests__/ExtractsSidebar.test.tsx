import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
        { id: "i-1", title: "Extract one", status: "approved", importJobId: "j-1", folderPath: "Engineering/Decisions" },
        { id: "i-2", title: "Extract two", status: "pending", importJobId: "j-1" },
        { id: "i-3", title: "Other item", status: "approved", importJobId: "j-99" },
      ],
      semanticAvailable: true,
    })),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "co1" } }),
}));

import { ExtractsSidebar } from "../components/memory/ExtractsSidebar";

describe("ExtractsSidebar", () => {
  it("filters items by importJobId and renders them", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ExtractsSidebar companyId="co-1" importJobId="j-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Extract one")).toBeInTheDocument());
    expect(screen.getByText("Extract two")).toBeInTheDocument();
    expect(screen.queryByText("Other item")).toBeNull();
  });
});
