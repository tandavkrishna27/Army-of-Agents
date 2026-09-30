import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
        { id: "i-1", title: "Auth strategy", category: "decision", folderPath: "Engineering/Decisions", departmentId: "d-eng" },
        { id: "i-2", title: "Brand voice", category: "reference", folderPath: "Marketing/Brand", departmentId: "d-mkt" },
      ],
      semanticAvailable: true,
    })),
  },
}));
vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: {
    list: vi.fn(async () => []),
  },
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "co-1", selectedCompany: { issuePrefix: "co1" } }),
}));

import { MemoryQuickSwitcher } from "../components/memory/MemoryQuickSwitcher";

function renderSwitcher() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemoryQuickSwitcher />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemoryQuickSwitcher", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens via the custom event from MemoryHome and shows results", async () => {
    renderSwitcher();
    window.dispatchEvent(new CustomEvent("memory:open-quick-switcher"));
    await waitFor(() => expect(screen.getByPlaceholderText(/Search memory items/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Auth strategy")).toBeInTheDocument());
    expect(screen.getByText("Brand voice")).toBeInTheDocument();
  });

  it("filters results as you type", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    window.dispatchEvent(new CustomEvent("memory:open-quick-switcher"));
    const input = await screen.findByPlaceholderText(/Search memory items/i);
    await user.type(input, "auth");
    await waitFor(() => expect(screen.getByText("Auth strategy")).toBeInTheDocument());
    expect(screen.queryByText("Brand voice")).not.toBeInTheDocument();
  });

  it("does not open on Cmd+K (that key belongs to the global CommandPalette)", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.queryByPlaceholderText(/Search memory items/i)).not.toBeInTheDocument();
  });
});
