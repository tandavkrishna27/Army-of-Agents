import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { renderWithProviders, mockCompanyContext, mockDialogContext } from "./test-utils";
import Marketplace from "../pages/Marketplace";
import type { CatalogItem, MarketplaceCatalogFile, MarketplacePackage } from "@armyofagents/shared";
import { usePackages } from "@/hooks/usePackages";
import { useCatalog } from "@/hooks/useCatalog";

const mockCatalog: MarketplaceCatalogFile = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-05-01T00:00:00Z",
  itemCount: 5,
  items: [
    {
      id: "skill:office-hours", type: "skill", name: "/office-hours",
      description: "YC product interrogation", version: "1.0.0",
      source: { adapter: "github", url: "https://github.com/garrytan/gstack", locator: "office-hours" },
      trust: { tier: "verified", source: "x" }, status: "active", addedAt: "2026-05-01T00:00:00Z",
      category: "engineering", tags: ["featured"], featured: true,
    } as CatalogItem,
    {
      id: "plugin:gh", type: "plugin", name: "github-issues",
      description: "GH sync", version: "1.0.0",
      source: { adapter: "github", url: "https://github.com/anthropic/plugin-gh", locator: "github-issues" },
      npm: { packageName: "@aoa/gh", version: "1.0.0" },
      trust: { tier: "verified", source: "x" }, status: "active", addedAt: "2026-05-02T00:00:00Z",
      category: "integrations", tags: [],
    } as CatalogItem,
    {
      id: "agent:claude-eng", type: "agent", name: "claude-engineer",
      description: "Engineer agent", version: "1.0.0",
      source: { adapter: "github", url: "https://github.com/anthropic/agents", locator: "claude-engineer" },
      trust: { tier: "community", source: "x" }, status: "active", addedAt: "2026-04-01T00:00:00Z",
      category: "engineering", tags: [],
    } as CatalogItem,
    {
      id: "team:product", type: "team", name: "product-team",
      description: "Multi-agent product team", version: "1.0.0",
      source: { adapter: "github", url: "https://github.com/anthropic/teams", locator: "product-team" },
      trust: { tier: "community", source: "x" }, status: "active", addedAt: "2026-03-01T00:00:00Z",
      category: "engineering", tags: [],
    } as CatalogItem,
    {
      // AoA first-party (aoa-curated owner) — must be segregated into the AoA view.
      id: "skill:aoa-thread-extract",
      type: "skill",
      name: "aoa-thread-extract",
      description: "AoA's own packaged skill",
      version: "1.0.0",
      source: {
        adapter: "github",
        url: "https://github.com/aoa-curated/crew",
        locator: "crew",
      },
      trust: { tier: "verified", source: "x" },
      status: "active",
      addedAt: "2026-05-01T00:00:00Z",
      category: "engineering",
      tags: [],
    } as CatalogItem,
  ],
};

vi.mock("@/hooks/useCatalog", () => ({ useCatalog: vi.fn() }));
vi.mock("@/hooks/usePackages", () => ({ usePackages: vi.fn() }));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return { ...actual, useQuery: vi.fn().mockReturnValue({ data: [], isLoading: false }) };
});

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("@/context/DialogContext", () => ({ useDialog: () => mockDialogContext }));

// Page renders inside the persistent LobbyLayout shell; stub the mobile hamburger.
vi.mock("@/components/LobbyShell", () => ({
  LobbyShellMobileMenuButton: ({ className }: any) => (
    <button aria-label="Open menu" className={className} />
  ),
}));
vi.mock("@/components/UserMenu", () => ({ UserMenu: () => <div /> }));
vi.mock("@/components/marketplace/install/SnapshotInstallModal", () => ({ SnapshotInstallModal: () => null }));
vi.mock("@/components/marketplace/install/PluginInstallModal", () => ({ PluginInstallModal: () => null }));

// Marketplace now pushes its SecondarySidebar to the LobbyLayout outlet context;
// render it under a minimal Outlet so useOutletContext resolves. The mobile pill
// row is what's asserted in-DOM for type nav.
function renderMarketplace(path = "/marketplace") {
  return renderWithProviders(
    <Routes>
      <Route element={<Outlet context={{ setSecondarySidebar: () => {} }} />}>
        <Route path="/marketplace" element={<Marketplace />} />
      </Route>
    </Routes>,
    { initialEntries: [path] },
  );
}

function makeFixtureItem(overrides: Partial<CatalogItem> & Pick<CatalogItem, "id" | "type" | "name">): CatalogItem {
  return {
    description: "fixture item",
    version: "1.0.0",
    source: { adapter: "github", url: "https://github.com/x/y", locator: overrides.id },
    trust: { tier: "community", source: "x" },
    status: "active",
    addedAt: "2026-05-01T00:00:00Z",
    category: "engineering",
    tags: [],
    ...overrides,
  } as CatalogItem;
}

describe("Marketplace (hub)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCatalog).mockReturnValue({ data: mockCatalog, isLoading: false, error: null } as any);
    vi.mocked(usePackages).mockReturnValue({
      data: [
        {
          id: "garrytan/gstack", name: "gstack",
          sourceUrl: "https://github.com/garrytan/gstack",
          memberItemIds: ["skill:office-hours", "skill:qa"],
          count: 2, verified: true, explicit: false,
        },
        {
          id: "MeteoriteLabs/aoa-marketplace",
          name: "aoa-marketplace",
          sourceUrl: "https://github.com/MeteoriteLabs/aoa-marketplace",
          memberItemIds: ["skill:aoa-thread-extract"],
          count: 1,
          verified: true,
          explicit: false,
        },
      ],
      isLoading: false, error: null,
    } as any);
  });

  it("renders the mobile type nav pills including AoA", () => {
    renderMarketplace();
    expect(screen.getByRole("button", { name: /^home$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^skills$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^plugins$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^agents$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^teams$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^aoa$/i })).toBeInTheDocument();
  });

  it("?type=skill shows skills and hides plugins", () => {
    renderMarketplace("/marketplace?type=skill");
    expect(screen.getByText("/office-hours")).toBeInTheDocument();
    expect(screen.queryByText("github-issues")).not.toBeInTheDocument();
  });

  it("Home excludes raw AoA package members", () => {
    renderMarketplace("/marketplace");
    expect(screen.getByText("/office-hours")).toBeInTheDocument();
    expect(screen.queryByText("aoa-thread-extract")).not.toBeInTheDocument();
  });

  it("?type=skill excludes raw AoA package members", () => {
    renderMarketplace("/marketplace?type=skill");
    expect(screen.getByText("/office-hours")).toBeInTheDocument();
    expect(screen.queryByText("aoa-thread-extract")).not.toBeInTheDocument();
  });

  it("?view=aoa shows the AoA package instead of its raw skill members", () => {
    renderMarketplace("/marketplace?view=aoa");
    expect(screen.getByText("aoa-marketplace")).toBeInTheDocument();
    expect(screen.queryByText("aoa-thread-extract")).not.toBeInTheDocument();
    expect(screen.queryByText("/office-hours")).not.toBeInTheDocument();
    expect(screen.queryByText("github-issues")).not.toBeInTheDocument();
  });

  it("waits for package placement instead of leaking AoA package members", () => {
    vi.mocked(usePackages).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as any);

    renderMarketplace();

    expect(screen.queryByText("aoa-thread-extract")).not.toBeInTheDocument();
    expect(screen.queryByText("/office-hours")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Failed to load marketplace.")
    ).not.toBeInTheDocument();
  });

  it("surfaces an initial package-query failure without rendering catalog cards", () => {
    vi.mocked(usePackages).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Package placement unavailable"),
    } as any);

    renderMarketplace();

    expect(screen.getByText("Failed to load marketplace.")).toBeInTheDocument();
    expect(
      screen.getByText("Package placement unavailable")
    ).toBeInTheDocument();
    expect(screen.queryByText("aoa-thread-extract")).not.toBeInTheDocument();
  });

  it("renders the sub-filter chip row with sort modes", () => {
    renderMarketplace();
    expect(
      screen.getByRole("button", { name: /featured$/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /recently added/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /a–z/i })).toBeInTheDocument();
  });

  it("clicking Featured filters to items with featured=true", async () => {
    const user = userEvent.setup();
    renderMarketplace();
    await user.click(screen.getByRole("button", { name: /featured$/i }));
    expect(screen.getByText("/office-hours")).toBeInTheDocument();
    expect(screen.queryByText("github-issues")).not.toBeInTheDocument();
  });

  it("renders a mobile hamburger button (md:hidden)", () => {
    renderMarketplace();
    expect(screen.getByRole("button", { name: /open menu/i })).toBeInTheDocument();
  });

  it("renders the Packages section heading on Home", () => {
    renderMarketplace();
    expect(screen.getByText(/^packages$/i)).toBeInTheDocument();
  });

  it("renders package cards when packages are available", () => {
    renderMarketplace();
    expect(screen.getByText("gstack")).toBeInTheDocument();
  });

  it("shows Packages as the first top-level overview section on Home", () => {
    renderMarketplace();
    const headers = screen.getAllByRole("heading", { level: 2 });
    expect(headers[0]).toHaveTextContent(/packages/i);
    expect(headers[1]).toHaveTextContent(/skills/i);
  });

  it("renders packages in the overview shelf on Home", () => {
    renderMarketplace();
    const shelf = screen.getByTestId("marketplace-packages-overview");
    expect(shelf).toHaveTextContent("gstack");
    expect(shelf).toHaveClass("auto-cols-[calc(100vw-2rem)]");
    expect(shelf).toHaveClass("sm:auto-cols-[minmax(20rem,32rem)]");
  });

  it("hides the native overview shelf scrollbar and renders chevron controls", () => {
    renderMarketplace();
    const shelf = screen.getByTestId("marketplace-packages-overview-scroll");
    expect(shelf).toHaveClass("[&::-webkit-scrollbar]:hidden");
    expect(shelf).toHaveClass("[scrollbar-width:none]");
    expect(screen.getByRole("button", { name: /scroll packages left/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /scroll packages right/i })).toBeInTheDocument();
  });

  it("hides the Packages strip on a non-Skills type view", () => {
    renderMarketplace("/marketplace?type=plugin");
    expect(screen.queryByText(/^packages$/i)).not.toBeInTheDocument();
    expect(screen.queryByText("gstack")).not.toBeInTheDocument();
  });

  it("shows skill packages as an expandable grid before the skills grid on ?type=skill", async () => {
    const user = userEvent.setup();
    const manyPackages: MarketplacePackage[] = Array.from({ length: 7 }, (_, index) => ({
      id: `owner/package-${index + 1}`, name: `package-${index + 1}`,
      sourceUrl: `https://github.com/owner/package-${index + 1}`,
      memberItemIds: ["skill:office-hours"], count: index + 1, verified: true, explicit: false,
    }));
    vi.mocked(usePackages).mockReturnValue({ data: manyPackages, isLoading: false, error: null } as any);
    renderMarketplace("/marketplace?type=skill");
    const headers = screen.getAllByRole("heading", { level: 2 });
    expect(headers[0]).toHaveTextContent(/skill packages/i);
    expect(headers[1]).toHaveTextContent(/^skills/i);
    const section = screen.getByTestId("marketplace-skills-packages-grid");
    expect(section).toHaveTextContent("package-1");
    expect(section).not.toHaveTextContent("package-7");
    await user.click(screen.getByRole("button", { name: /view more/i }));
    expect(section).toHaveTextContent("package-7");
    expect(screen.getByRole("button", { name: /show less/i })).toBeInTheDocument();
  });
});

describe("Marketplace (hub) — sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCatalog).mockReturnValue({ data: mockCatalog, isLoading: false, error: null } as any);
    vi.mocked(usePackages).mockReturnValue({ data: [], isLoading: false, error: null } as any);
  });

  it("renders all four section headers in order Skills → Plugins → Agents → Teams", () => {
    renderMarketplace();
    const headers = screen.getAllByRole("heading", { level: 2 });
    const labels = headers.map((h) => h.textContent?.toLowerCase() ?? "");
    const idxSkill = labels.findIndex((l) => l.includes("skills"));
    const idxPlug = labels.findIndex((l) => l.includes("plugins"));
    const idxAgent = labels.findIndex((l) => l.includes("agents"));
    const idxTeam = labels.findIndex((l) => l.includes("teams"));
    expect(idxSkill).toBeGreaterThanOrEqual(0);
    expect(idxPlug).toBeGreaterThan(idxSkill);
    expect(idxAgent).toBeGreaterThan(idxPlug);
    expect(idxTeam).toBeGreaterThan(idxAgent);
  });

  it("hides a section whose post-filter item count is zero", async () => {
    const user = userEvent.setup();
    renderMarketplace();
    await user.click(screen.getByRole("button", { name: /featured$/i }));
    const headers = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.toLowerCase() ?? "");
    const has = (label: string) => headers.some((h) => h.includes(label));
    expect(has("skills")).toBe(true);
    expect(has("plugins")).toBe(false);
    expect(has("agents")).toBe(false);
    expect(has("teams")).toBe(false);
  });

  it("caps each section at SECTION_CAP items on Home", () => {
    const overflow = Array.from({ length: 8 }).map((_, i) =>
      makeFixtureItem({ id: `skill:s${i}`, type: "skill", name: `skill-${i}` }),
    );
    vi.mocked(useCatalog).mockReturnValue({
      data: { schemaVersion: "1.0.0", generatedAt: "2026-05-01T00:00:00Z", itemCount: 8, items: overflow },
      isLoading: false, error: null,
    } as any);
    renderMarketplace();
    expect(screen.getByText("skill-0")).toBeInTheDocument();
    expect(screen.getByText("skill-5")).toBeInTheDocument();
    expect(screen.queryByText("skill-6")).not.toBeInTheDocument();
    expect(screen.queryByText("skill-7")).not.toBeInTheDocument();
  });

  it("removes the cap on a single type view (?type=skill)", () => {
    const overflow = Array.from({ length: 8 }).map((_, i) =>
      makeFixtureItem({ id: `skill:s${i}`, type: "skill", name: `skill-${i}` }),
    );
    vi.mocked(useCatalog).mockReturnValue({
      data: { schemaVersion: "1.0.0", generatedAt: "2026-05-01T00:00:00Z", itemCount: 8, items: overflow },
      isLoading: false, error: null,
    } as any);
    renderMarketplace("/marketplace?type=skill");
    expect(screen.getByText("skill-0")).toBeInTheDocument();
    expect(screen.getByText("skill-7")).toBeInTheDocument();
  });

  it("hides 'See all →' when a section's total fits inside the cap", () => {
    renderMarketplace();
    expect(screen.queryByRole("button", { name: /see all/i })).not.toBeInTheDocument();
  });

  it("keeps first-party plugins in the Plugins shelf", () => {
    vi.mocked(useCatalog).mockReturnValue({
      data: {
        schemaVersion: "1.0.0",
        generatedAt: "2026-05-01T00:00:00Z",
        itemCount: 2,
        items: [
          makeFixtureItem({ id: "skill:s1", type: "skill", name: "real-skill" }),
          makeFixtureItem({
            id: "plugin:aoa",
            type: "plugin",
            name: "aoa-plugin",
            source: { adapter: "github", url: "https://github.com/aoa-curated/p", locator: "p" },
          }),
        ],
      },
      isLoading: false,
      error: null,
    } as any);
    renderMarketplace("/marketplace?type=plugin");
    expect(screen.getByText("aoa-plugin")).toBeInTheDocument();
    expect(
      screen.queryByTestId("marketplace-empty-plugin")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No matches.")).not.toBeInTheDocument();
  });

  it("places the exact AoA catalog matrix without duplication", () => {
    const crewSlugs = [
      "adjutant",
      "scout",
      "engineer",
      "navigator",
      "planner",
      "memory-keeper",
      "chronicler",
      "reviewer",
      "librarian",
      "steward",
    ];
    const crewAgents = crewSlugs.map((slug) =>
      makeFixtureItem({
        id: `agent:aoa-curated/aoa-${slug}`,
        type: "agent",
        name: `crew-${slug}`,
        source: {
          adapter: "github",
          url: "https://github.com/aoa-curated/agents",
          locator: slug,
        },
      })
    );
    const items = [
      makeFixtureItem({
        id: "skill:community/x",
        type: "skill",
        name: "community-skill",
      }),
      ...crewAgents,
      makeFixtureItem({
        id: "team:aoa-curated/default-crew",
        type: "team",
        name: "AoA Default Crew",
        source: {
          adapter: "github",
          url: "https://github.com/aoa-curated/teams",
          locator: "default-crew",
        },
        requires: crewAgents.map((agent) => ({
          type: "agent" as const,
          id: agent.id,
        })),
      }),
      ...["senior-engineer", "github-issue-triager"].map((slug) =>
        makeFixtureItem({
          id: `agent:aoa-curated/${slug}`,
          type: "agent",
          name: `standalone-${slug}`,
          source: {
            adapter: "github",
            url: "https://github.com/aoa-curated/agents",
            locator: slug,
          },
        })
      ),
      ...["discord", "github-issues", "slack", "telegram"].map((slug) =>
        makeFixtureItem({
          id: `plugin:aoa-curated/${slug}`,
          type: "plugin",
          name: `plugin-${slug}`,
          source: {
            adapter: "github",
            url: "https://github.com/aoa-curated/plugins",
            locator: slug,
          },
        })
      ),
      ...["design-shotgun", "thread-extract"].map((slug) =>
        makeFixtureItem({
          id: `skill:aoa-curated/${slug}`,
          type: "skill",
          name: `raw-${slug}`,
          source: {
            adapter: "github",
            url: "https://github.com/MeteoriteLabs/aoa-marketplace",
            locator: slug,
          },
        })
      ),
    ];
    vi.mocked(useCatalog).mockReturnValue({
      data: {
        schemaVersion: "1.0.0",
        generatedAt: "2026-07-29T00:00:00Z",
        itemCount: items.length,
        items,
      },
      isLoading: false,
      error: null,
    } as any);
    vi.mocked(usePackages).mockReturnValue({
      data: [
        {
          id: "MeteoriteLabs/aoa-marketplace",
          name: "AoA skills package",
          sourceUrl: "https://github.com/MeteoriteLabs/aoa-marketplace",
          memberItemIds: [
            "skill:aoa-curated/design-shotgun",
            "skill:aoa-curated/thread-extract",
          ],
          count: 2,
          verified: true,
          explicit: false,
        },
      ],
      isLoading: false,
      error: null,
    } as any);

    const aoa = renderMarketplace("/marketplace?view=aoa");
    expect(screen.getByText("AoA skills package")).toBeInTheDocument();
    expect(screen.getByText("AoA Default Crew")).toBeInTheDocument();
    for (const slug of crewSlugs) {
      expect(screen.getByText(`crew-${slug}`)).toBeInTheDocument();
    }
    expect(
      screen.queryByText("standalone-senior-engineer")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("plugin-slack")).not.toBeInTheDocument();
    expect(screen.queryByText("raw-thread-extract")).not.toBeInTheDocument();
    aoa.unmount();

    const agents = renderMarketplace("/marketplace?type=agent");
    expect(screen.getByText("standalone-senior-engineer")).toBeInTheDocument();
    expect(
      screen.getByText("standalone-github-issue-triager")
    ).toBeInTheDocument();
    expect(screen.queryByText("crew-reviewer")).not.toBeInTheDocument();
    agents.unmount();

    const plugins = renderMarketplace("/marketplace?type=plugin");
    for (const slug of ["discord", "github-issues", "slack", "telegram"]) {
      expect(screen.getByText(`plugin-${slug}`)).toBeInTheDocument();
    }
    plugins.unmount();

    renderMarketplace("/marketplace?type=team");
    expect(screen.queryByText("AoA Default Crew")).not.toBeInTheDocument();
  });

  it("keeps the generic 'No matches.' state for a search that returns nothing", async () => {
    const user = userEvent.setup();
    renderMarketplace("/marketplace?type=plugin");
    await user.type(
      screen.getByPlaceholderText(/search marketplace/i),
      "zzz-nonexistent",
    );
    expect(screen.getByText("No matches.")).toBeInTheDocument();
    expect(screen.queryByTestId("marketplace-empty-plugin")).not.toBeInTheDocument();
  });

  it("keeps 'No matches.' (not the empty hero) when a sub-filter empties a non-empty type", async () => {
    const user = userEvent.setup();
    // mockCatalog's plugin (github-issues) is a real third-party item but is not
    // featured — the Featured sub-filter reduces the plugin list to zero.
    renderMarketplace("/marketplace?type=plugin");
    expect(screen.getByText("github-issues")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /featured$/i }));
    expect(screen.getByText("No matches.")).toBeInTheDocument();
    expect(screen.queryByTestId("marketplace-empty-plugin")).not.toBeInTheDocument();
  });
});
