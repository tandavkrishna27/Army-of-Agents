import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, Outlet } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import MarketplaceDetail from "@/pages/MarketplaceDetail";
import { marketplaceApi } from "@/api/marketplace";
import { listCompanyPlugins } from "@/api/plugins";
import { FULL_CATALOG } from "@/__tests__/__fixtures__/marketplace-catalog";
import { ToastProvider } from "@/context/ToastContext";
import { InstallToastProvider } from "@/components/marketplace/toast/ToastProvider";
import { ToastViewport } from "@/components/ToastViewport";

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>("@/api/marketplace");
  return { ...actual, marketplaceApi: { getCatalog: vi.fn(), getPackages: vi.fn() } };
});

vi.mock("@/api/plugins", async () => {
  const actual = await vi.importActual<typeof import("@/api/plugins")>("@/api/plugins");
  return {
    ...actual,
    listCompanyPlugins: vi.fn(),
  };
});

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "c1",
    companies: [{ id: "c1", name: "Acme", status: "active" }],
  }),
}));

// Page renders inside the persistent LobbyLayout shell; stub only the mobile
// hamburger it renders (shell chrome is covered by LobbyLayout.test.tsx).
vi.mock("@/components/LobbyShell", () => ({
  LobbyShellMobileMenuButton: ({ className }: { className?: string }) => (
    <button aria-label="Open menu" className={className} />
  ),
}));
vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: vi.fn() }),
}));
vi.mock("@/components/UserMenu", () => ({ UserMenu: () => <div /> }));

function wrap(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <ToastProvider>
          <InstallToastProvider>
            <Routes>
              <Route element={<Outlet context={{ setSecondarySidebar: () => {} }} />}>
                <Route path="/marketplace/:type/:slug/*" element={<MarketplaceDetail />} />
              </Route>
            </Routes>
            <ToastViewport />
          </InstallToastProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MarketplaceDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listCompanyPlugins).mockResolvedValue([]);
    vi.mocked(marketplaceApi.getPackages).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders skill detail with inline README", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    // CODE_REVIEW_SKILL.id = "skill:aoa-curated/code-review"
    wrap("/marketplace/skill/aoa-curated/code-review");

    // Wait for the page to load — fixture has both a page-title h1 and a README
    // h1 from inline `# Code Review`, so multiple heading-1 matches indicate the
    // README rendered too. (Breadcrumb adds a third "Code Review" plain text.)
    await waitFor(() => {
      const headings = screen.getAllByRole("heading", { level: 1, name: "Code Review" });
      expect(headings.length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText(/Systematic code review/)).toBeInTheDocument();
    // MarketplaceDetail renders the version twice — once as a header badge and
    // once in the right-side metadata Version field — so we assert presence
    // rather than uniqueness.
    expect(screen.getAllByText("v1.0.0").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Verified")).toBeInTheDocument();
    // Breadcrumb + page title + README heading → 3 matches.
    expect(screen.getAllByText("Code Review").length).toBeGreaterThan(1);
  });

  it("renders provider logo and provider byline in the hero", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce({
      ...FULL_CATALOG,
      items: FULL_CATALOG.items.map((item) =>
        item.id === "skill:aoa-curated/code-review"
          ? {
              ...item,
              provider: {
                id: "armyofagents",
                name: "Army of Agents",
                logoUrl: "https://example.com/aoa-logo.png",
                fallbackInitials: "AoA",
              },
            }
          : item,
      ),
    });
    wrap("/marketplace/skill/aoa-curated/code-review");

    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Army of Agents logo" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("img", { name: "Army of Agents logo" })).toHaveClass("size-16");
    expect(screen.getByText("by Army of Agents")).toBeInTheDocument();
  });

  it("organizes the top section as a detail card with badge, metadata, package, and install action", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    vi.mocked(marketplaceApi.getPackages).mockResolvedValue([
      {
        id: "garrytan/gstack",
        name: "gstack",
        sourceUrl: "https://github.com/garrytan/gstack",
        memberItemIds: ["skill:aoa-curated/code-review"],
        count: 1,
        verified: true,
        explicit: false,
      },
    ]);
    wrap("/marketplace/skill/aoa-curated/code-review");

    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 1, name: "Code Review" }).length).toBeGreaterThanOrEqual(1),
    );

    const hero = screen.getByTestId("marketplace-detail-hero-card");
    expect(within(hero).getByTestId("marketplace-detail-type-badge")).toHaveTextContent("SKILL");
    expect(within(hero).getAllByText(/^skill$/i)).toHaveLength(1);
    const badges = within(hero).getByTestId("marketplace-detail-badges");
    expect(within(badges).getByRole("link", { name: /part of gstack/i })).toBeInTheDocument();
    expect(within(badges).getByText("Verified")).toBeInTheDocument();
    expect(within(hero).getByTestId("marketplace-detail-metadata")).toHaveTextContent("Version");
    expect(within(hero).getByTestId("marketplace-detail-metadata")).toHaveTextContent("v1.0.0");
    expect(within(hero).getByRole("button", { name: /^install$/i })).toBeInTheDocument();
  });

  it("renders plugin detail with capabilities list", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    wrap("/marketplace/plugin/aoa-curated/aoa-plugin-slack");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Slack" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("companies.read")).toBeInTheDocument();
    expect(screen.getByText("issues.read")).toBeInTheDocument();
  });

  it("aborts pending README fetches when the detail page unmounts", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = wrap("/marketplace/agent/aoa-curated/engineer");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);

    unmount();

    expect(init?.signal?.aborted).toBe(true);
  });

  it("Install button opens install modal", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    wrap("/marketplace/plugin/aoa-curated/aoa-plugin-slack");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Slack" }),
      ).toBeInTheDocument(),
    );
    // Before opening, the only "Install" button is the page-level CTA.
    const installBtn = screen.getByRole("button", { name: /install/i });
    await userEvent.click(installBtn);
    // Modal title appears once dialog mounts.
    await waitFor(() => expect(screen.getByText("Install Slack")).toBeInTheDocument());
  });

  it("primary breadcrumb links back to the AoA view for an AoA package member", async () => {
    // isAoaItem() keys off the github owner in source.url (not the id), so give
    // code-review an aoa-curated source → AoA first-party. Opened from ?view=aoa,
    // the breadcrumb must return to the AoA view, not Home (where it's hidden).
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce({
      ...FULL_CATALOG,
      items: FULL_CATALOG.items.map((item) =>
        item.id === "skill:aoa-curated/code-review"
          ? { ...item, source: { ...item.source, url: "https://github.com/aoa-curated/skills" } }
          : item,
      ),
    });
    vi.mocked(marketplaceApi.getPackages).mockResolvedValueOnce([
      {
        id: "MeteoriteLabs/aoa-marketplace",
        name: "AoA skills",
        sourceUrl: "https://github.com/MeteoriteLabs/aoa-marketplace",
        memberItemIds: ["skill:aoa-curated/code-review"],
        count: 1,
        verified: true,
        explicit: false,
      },
    ]);
    const { container } = wrap("/marketplace/skill/aoa-curated/code-review");
    await waitFor(() =>
      expect(
        screen.getAllByRole("heading", { level: 1, name: "Code Review" }).length,
      ).toBeGreaterThanOrEqual(1),
    );
    const crumb = container.querySelector('a[href="/marketplace?view=aoa"]');
    expect(crumb).toBeInTheDocument();
    expect(crumb?.textContent).toMatch(/marketplace/i);
    expect(crumb?.textContent).toMatch(/aoa/i);
  });

  it("primary breadcrumb links back to the type view for a non-AoA item", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    const { container } = wrap("/marketplace/skill/community/example-author/quick-tip");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Quick Tip" }),
      ).toBeInTheDocument(),
    );
    const crumb = container.querySelector('a[href="/marketplace?type=skill"]');
    expect(crumb).toBeInTheDocument();
    expect(crumb?.textContent).toMatch(/marketplace/i);
    expect(crumb?.textContent).toMatch(/skills/i);
  });

  it("surfaces a package-placement failure instead of silently mislabeling navigation", async () => {
    // The item itself loads from the catalog, but the packages query — which drives
    // AoA classification (back-link + sidebar + "Part of X") — fails. The page must
    // treat that as an error rather than deriving navigation from empty packages.
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce({
      ...FULL_CATALOG,
      items: FULL_CATALOG.items.map((item) =>
        item.id === "skill:aoa-curated/code-review"
          ? { ...item, source: { ...item.source, url: "https://github.com/aoa-curated/skills" } }
          : item,
      ),
    });
    vi.mocked(marketplaceApi.getPackages).mockRejectedValueOnce(
      new Error("Package placement unavailable"),
    );

    wrap("/marketplace/skill/aoa-curated/code-review");

    await waitFor(() =>
      expect(screen.getByText(/could not load this item/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/package placement unavailable/i),
    ).toBeInTheDocument();
    // The item hero must NOT render against a wrongly-derived navigation state.
    expect(
      screen.queryByTestId("marketplace-detail-hero-card"),
    ).not.toBeInTheDocument();
    // P3: with placement unresolved (packages failed), the back-link is neutralized
    // to the generic marketplace target — not a wrong "Skills"/"AoA" target derived
    // from the empty packages fallback.
    expect(
      screen.getByRole("link", { name: /back to marketplace/i }),
    ).toHaveAttribute("href", "/marketplace");
  });

  it("renders 404 for unknown item id", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    wrap("/marketplace/skill/nonexistent/item");
    await waitFor(() => expect(screen.getByText(/Item not found/)).toBeInTheDocument());
  });

  it("renders dependencies section for items with requires", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    wrap("/marketplace/team/aoa-curated/engineering");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Engineering Team" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Dependencies")).toBeInTheDocument();
    expect(screen.getByText(/agent:aoa-curated\/engineer/)).toBeInTheDocument();
    expect(screen.getByText(/skill:aoa-curated\/code-review/)).toBeInTheDocument();
  });

  it("shows Installed badge instead of Install button when plugin is already installed", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    // aoa-plugin-slack's packageName from the fixture
    vi.mocked(listCompanyPlugins).mockResolvedValueOnce([
      {
        id: "plugin-1",
        companyId: "c1",
        catalogItemId: null,
        packageName: "aoa-plugin-slack",
        pluginKey: "aoa.plugin-slack",
        version: "1.0.0",
        status: "ready",
        categories: [],
        manifest: {
          displayName: "Slack",
          description: "Slack plugin",
          capabilities: [],
        },
        lastError: null,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        enabled: true,
        configJson: {},
      },
    ]);

    wrap("/marketplace/plugin/aoa-curated/aoa-plugin-slack");

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "Slack" })).toBeInTheDocument(),
    );

    // Should NOT show Install button
    expect(screen.queryByRole("button", { name: /^install$/i })).not.toBeInTheDocument();
    // Should show Installed badge
    expect(screen.getByText(/installed/i)).toBeInTheDocument();
  });

  it("shows Install button when plugin is not installed", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    vi.mocked(listCompanyPlugins).mockResolvedValueOnce([]);

    wrap("/marketplace/plugin/aoa-curated/aoa-plugin-slack");

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "Slack" })).toBeInTheDocument(),
    );

    expect(screen.getByRole("button", { name: /^install$/i })).toBeInTheDocument();
  });


  it("renders a verified-blue checkmark for verified items in the hero", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    // CODE_REVIEW_SKILL has trust.tier === "verified"
    wrap("/marketplace/skill/aoa-curated/code-review");

    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 1, name: "Code Review" }).length).toBeGreaterThanOrEqual(1),
    );
    expect(screen.getByTestId("hero-verified")).toBeInTheDocument();
  });

  it("does NOT render the verified checkmark for community items", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    // COMMUNITY_SKILL has trust.tier === "community"
    wrap("/marketplace/skill/community/example-author/quick-tip");

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "Quick Tip" })).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("hero-verified")).not.toBeInTheDocument();
  });

  it("renders 'Part of X' pill above the name when the item belongs to a package", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    // CODE_REVIEW_SKILL.id = "skill:aoa-curated/code-review"
    vi.mocked(marketplaceApi.getPackages).mockResolvedValue([
      {
        id: "garrytan/gstack",
        name: "gstack",
        sourceUrl: "https://github.com/garrytan/gstack",
        memberItemIds: ["skill:aoa-curated/code-review"],
        count: 1,
        verified: true,
        explicit: false,
      },
    ]);
    wrap("/marketplace/skill/aoa-curated/code-review");

    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 1, name: "Code Review" }).length).toBeGreaterThanOrEqual(1),
    );
    const pill = screen.getByRole("link", { name: /part of gstack/i });
    expect(pill).toBeInTheDocument();
    expect(pill.getAttribute("href")).toBe("/marketplace/package/garrytan/gstack");
  });

  it("does NOT render the 'Part of X' pill when the item is not in any package", async () => {
    vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
    // getPackages defaults to [] in beforeEach — no packages at all
    wrap("/marketplace/skill/aoa-curated/code-review");

    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 1, name: "Code Review" }).length).toBeGreaterThanOrEqual(1),
    );
    expect(screen.queryByText(/part of/i)).not.toBeInTheDocument();
  });
});
