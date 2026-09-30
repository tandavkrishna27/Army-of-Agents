import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, Outlet } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MarketplacePackage } from "@armyofagents/shared";

import MarketplaceSearch from "@/pages/MarketplaceSearch";
import { marketplaceApi } from "@/api/marketplace";
import { FULL_CATALOG } from "@/__tests__/__fixtures__/marketplace-catalog";
import { renderWithProviders, mockCompanyContext, mockDialogContext } from "@/__tests__/test-utils";

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>(
    "@/api/marketplace",
  );
  return {
    ...actual,
    marketplaceApi: { getCatalog: vi.fn(), getPackages: vi.fn() },
  };
});

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("@/context/DialogContext", () => ({ useDialog: () => mockDialogContext }));

// Page renders inside the persistent LobbyLayout shell; stub only the mobile
// hamburger it renders (shell chrome is covered by LobbyLayout.test.tsx).
vi.mock("@/components/LobbyShell", () => ({
  LobbyShellMobileMenuButton: ({ className }: { className?: string }) => (
    <button aria-label="Open menu" className={className} />
  ),
}));
vi.mock("@/components/UserMenu", () => ({ UserMenu: () => <div /> }));

function wrap(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<Outlet context={{ setSecondarySidebar: () => {} }} />}>
            <Route path="/marketplace/search" element={<MarketplaceSearch />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MarketplaceSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(marketplaceApi.getPackages).mockResolvedValue([]);
  });

  it("groups results by type", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    wrap("/marketplace/search?q=engineering");

    await waitFor(() =>
      expect(screen.getByText(/Search: "engineering"/)).toBeInTheDocument(),
    );
    expect(screen.getByText("Engineering Team")).toBeInTheDocument();
  });

  it("shows no-results state for unmatched query", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    wrap("/marketplace/search?q=zzzznonexistent");

    await waitFor(() =>
      expect(screen.getByText(/No items match/)).toBeInTheDocument(),
    );
  });

  it("filters by category param when present", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    wrap("/marketplace/search?q=&category=engineering");

    await waitFor(() =>
      expect(screen.getByText(/category: engineering/)).toBeInTheDocument(),
    );
  });

  it("waits for package placement without exposing an AoA package member", async () => {
    let resolvePackages!: (packages: MarketplacePackage[]) => void;
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    vi.mocked(marketplaceApi.getPackages).mockReturnValueOnce(
      new Promise<MarketplacePackage[]>((resolve) => {
        resolvePackages = resolve;
      })
    );

    wrap("/marketplace/search?q=Code");

    await waitFor(() => expect(marketplaceApi.getCatalog).toHaveBeenCalled());
    expect(screen.queryByText("Code Review")).not.toBeInTheDocument();

    await act(async () => {
      resolvePackages([
        {
          id: "MeteoriteLabs/aoa-marketplace",
          name: "AoA skills package",
          sourceUrl: "https://github.com/MeteoriteLabs/aoa-marketplace",
          memberItemIds: ["skill:aoa-curated/code-review"],
          count: 1,
          verified: true,
          explicit: false,
        },
      ]);
    });

    await waitFor(() =>
      expect(screen.getByText(/No items match/)).toBeInTheDocument()
    );
    expect(screen.queryByText("Code Review")).not.toBeInTheDocument();
  });

  it("surfaces package placement errors without rendering raw catalog results", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    vi.mocked(marketplaceApi.getPackages).mockRejectedValueOnce(
      new Error("Package placement unavailable")
    );

    wrap("/marketplace/search?q=Code");

    await waitFor(() =>
      expect(
        screen.getByText("Could not load search results")
      ).toBeInTheDocument()
    );
    expect(
      screen.getByText("Package placement unavailable")
    ).toBeInTheDocument();
    expect(screen.queryByText("Code Review")).not.toBeInTheDocument();
  });
});
