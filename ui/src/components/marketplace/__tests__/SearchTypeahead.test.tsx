import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { SearchTypeahead } from "../SearchTypeahead";
import { marketplaceApi } from "@/api/marketplace";
import { FULL_CATALOG } from "@/__tests__/__fixtures__/marketplace-catalog";
import { mockCompanyContext } from "@/__tests__/test-utils";

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>(
    "@/api/marketplace",
  );
  return { ...actual, marketplaceApi: { getCatalog: vi.fn() } };
});

// SearchTypeahead navigates via the custom useNavigate which requires CompanyContext.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SearchTypeahead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValue(FULL_CATALOG);
  });

  it("shows dropdown with matches after typing", async () => {
    wrap(<SearchTypeahead />);
    const input = screen.getByLabelText("Search marketplace");
    await userEvent.type(input, "slack");

    await waitFor(() => expect(screen.getByText("Slack")).toBeInTheDocument(), {
      timeout: 1000,
    });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("hides dropdown when input is empty", async () => {
    wrap(<SearchTypeahead />);
    const input = screen.getByLabelText("Search marketplace");
    await userEvent.click(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
