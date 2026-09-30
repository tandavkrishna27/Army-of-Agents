import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, Outlet } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockCompanyContext, mockDialogContext } from "./test-utils";
import MarketplacePackageDetail from "../pages/MarketplacePackageDetail";
import type {
  CatalogItem,
  MarketplaceCatalogFile,
  MarketplacePackage,
} from "@armyofagents/shared";

function wrap(initialPath: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<Outlet context={{ setSecondarySidebar: () => {} }} />}>
            <Route path="/marketplace/package/:id/*" element={<MarketplacePackageDetail />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeItem(overrides: Partial<CatalogItem> & { id: string }): CatalogItem {
  return {
    id: overrides.id,
    type: "skill",
    name: overrides.id.split(":").pop() ?? overrides.id,
    description: "test item",
    version: "1.0.0",
    source: { adapter: "g", url: "https://github.com/garrytan/gstack", locator: "x" },
    trust: { tier: "verified", source: "x" },
    status: "active",
    addedAt: "2026-05-01T00:00:00Z",
    category: "engineering",
    tags: [],
    ...overrides,
  } as CatalogItem;
}

const SAMPLE_PACKAGE: MarketplacePackage = {
  id: "garrytan/gstack",
  name: "gstack",
  sourceUrl: "https://github.com/garrytan/gstack",
  memberItemIds: ["skill:gstack/office-hours", "skill:gstack/qa"],
  count: 2,
  verified: true,
  explicit: false,
};

const SAMPLE_CATALOG: MarketplaceCatalogFile = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-05-01T00:00:00Z",
  itemCount: 2,
  items: [
    makeItem({ id: "skill:gstack/office-hours", name: "office-hours", description: "YC interrogation" }),
    makeItem({ id: "skill:gstack/qa", name: "qa", description: "QA the site" }),
  ],
};

vi.mock("@/hooks/useCatalog", () => ({
  useCatalog: vi.fn(),
}));

vi.mock("@/hooks/usePackages", () => ({
  usePackages: vi.fn(),
}));

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

import { useCatalog } from "@/hooks/useCatalog";
import { usePackages } from "@/hooks/usePackages";

function setupHooks(opts: {
  catalog?: MarketplaceCatalogFile | undefined;
  packages?: MarketplacePackage[] | undefined;
  catalogLoading?: boolean;
  packagesLoading?: boolean;
} = {}) {
  vi.mocked(useCatalog).mockReturnValue({
    data: opts.catalog,
    isLoading: opts.catalogLoading ?? false,
    error: null,
  } as any);
  vi.mocked(usePackages).mockReturnValue({
    data: opts.packages,
    isLoading: opts.packagesLoading ?? false,
    error: null,
  } as any);
}

describe("MarketplacePackageDetail", () => {
  beforeEach(() => vi.clearAllMocks());


  it("renders the package name + verified check + top-right item badge", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: [SAMPLE_PACKAGE] });
    const { container } = wrap("/marketplace/package/garrytan/gstack");
    expect(screen.getByRole("heading", { level: 1, name: /gstack/i })).toBeInTheDocument();
    expect(container.querySelector('[data-testid="package-hero-verified"]')).toBeTruthy();
    // Both the pill and the install button contain "2 items" — assert at least one occurrence
    const badge = screen.getByTestId("package-hero-badge");
    expect(badge).toHaveTextContent(/package/i);
    expect(screen.getByLabelText(/2 items/i)).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /install all 2 items/i })).toBeInTheDocument();
  });

  it("renders provider logo and provider byline in the package hero", () => {
    setupHooks({
      catalog: SAMPLE_CATALOG,
      packages: [
        {
          ...SAMPLE_PACKAGE,
          provider: {
            id: "garrytan",
            name: "Garry Tan",
            logoUrl: "https://example.com/garrytan.png",
            fallbackInitials: "GT",
          },
        },
      ],
    });
    wrap("/marketplace/package/garrytan/gstack");

    expect(screen.getByRole("img", { name: "Garry Tan logo" })).toHaveClass("size-20");
    expect(screen.getByText("by Garry Tan")).toBeInTheDocument();
  });

  it("renders the chevron-back link to /marketplace", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: [SAMPLE_PACKAGE] });
    wrap("/marketplace/package/garrytan/gstack");
    const back = screen.getByRole("link", { name: /marketplace/i });
    expect(back.getAttribute("href")).toBe("/marketplace");
  });

  it("renders each member item as a row in the grid with a link to its detail page", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: [SAMPLE_PACKAGE] });
    wrap("/marketplace/package/garrytan/gstack");
    expect(screen.getByText("office-hours")).toBeInTheDocument();
    expect(screen.getByText("qa")).toBeInTheDocument();
    // The link should be /marketplace/skill/gstack/office-hours (catalog id "skill:gstack/office-hours" → /marketplace/skill/gstack/office-hours)
    const officeLink = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href") === "/marketplace/skill/gstack/office-hours");
    expect(officeLink).toBeTruthy();
  });

  it("renders included items with marketplace skill card chrome", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: [SAMPLE_PACKAGE] });
    wrap("/marketplace/package/garrytan/gstack");

    expect(screen.getAllByText("SKILL")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^install$/i })).toHaveLength(2);
    expect(screen.getByText("YC interrogation")).toBeInTheDocument();
    expect(screen.getByText("QA the site")).toBeInTheDocument();
  });

  it("shows a not-found state when the package id does not exist", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: [] });
    wrap("/marketplace/package/does-not-exist");
    expect(screen.getByText(/package not found/i)).toBeInTheDocument();
  });

  it("shows a loading state while packages are loading", () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: undefined, packagesLoading: true });
    wrap("/marketplace/package/garrytan/gstack");
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("opens package install modal from detail Install all", async () => {
    setupHooks({ catalog: SAMPLE_CATALOG, packages: [SAMPLE_PACKAGE] });
    wrap("/marketplace/package/garrytan/gstack");

    await userEvent.click(screen.getByRole("button", { name: /install all 2 items/i }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("Install skills");
  });
});
