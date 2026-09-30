import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Hoist mocks so they are available before module imports are resolved.
const { navigateMock, listPendingMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  listPendingMock: vi.fn(),
}));

// Stub useNavigate so it doesn't call useCompany internally.
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return { ...actual, useNavigate: () => navigateMock };
});

// Mock the company context so the hook resolves.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "ACME" } }),
}));

// Mock the API — pill uses the dedicated pending-queue endpoint, not the full list.
vi.mock("../../../api/memory", () => ({
  memoryApi: { listPending: (...args: unknown[]) => listPendingMock(...args) },
}));

import { PendingReviewPill } from "../PendingReviewPill";

function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        {ui}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PendingReviewPill", () => {
  beforeEach(() => {
    // Reset call history + mockResolvedValueOnce queue between tests.
    vi.clearAllMocks();
  });

  it("renders nothing when totalCount is zero", async () => {
    listPendingMock.mockResolvedValueOnce({ totalCount: 0, items: [] });
    const { container } = renderWithProviders(<PendingReviewPill companyId="co-1" />);
    await waitFor(() => expect(listPendingMock).toHaveBeenCalled());
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders pill with totalCount when pending items exist", async () => {
    listPendingMock.mockResolvedValueOnce({ totalCount: 3, items: [] });
    const { findByText } = renderWithProviders(<PendingReviewPill companyId="co-1" />);
    expect(await findByText("3 pending")).toBeInTheDocument();
    expect(await findByText("Review")).toBeInTheDocument();
  });

  it("navigates to /:prefix/memory/explore?folder=__pending on click", async () => {
    listPendingMock.mockResolvedValueOnce({ totalCount: 1, items: [] });
    const { findByText } = renderWithProviders(<PendingReviewPill companyId="co-1" />);
    const reviewBtn = await findByText("Review");
    fireEvent.click(reviewBtn.closest("button")!);
    expect(navigateMock).toHaveBeenCalledWith("/ACME/memory/explore?folder=__pending");
  });
});
