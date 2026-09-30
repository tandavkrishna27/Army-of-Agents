import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CatalogItem, PluginRecord } from "@armyofagents/shared";
import { CatalogCard } from "../CatalogCard";
import { queryKeys } from "@/lib/queryKeys";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "c1",
    selectedCompany: {
      id: "c1",
      name: "Acme",
      issuePrefix: "TC",
      status: "active",
    },
    companies: [{ id: "c1", name: "Acme", status: "active" }],
  }),
}));

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>(
    "@/api/marketplace"
  );
  return {
    ...actual,
    marketplaceApi: {
      ...actual.marketplaceApi,
      install: vi.fn(),
      getOperation: vi.fn(),
    },
  };
});

function makeItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: "skill:office-hours",
    type: "skill",
    name: "/office-hours",
    description: "YC-style product interrogation.",
    version: "1.4.0",
    source: {
      adapter: "github",
      url: "https://github.com/garrytan/gstack",
      locator: "office-hours",
    },
    trust: { tier: "verified", source: "anthropic" },
    status: "active",
    addedAt: "2026-04-01T00:00:00Z",
    category: "engineering",
    tags: ["featured"],
    ...overrides,
  };
}

function renderCard(
  item: CatalogItem,
  installed?: Map<string, PluginRecord>,
  state?: {
    ready?: boolean;
    error?: boolean;
    retry?: () => void;
    deploymentMode?: "local_trusted" | "cloud_auth";
  }
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(queryKeys.health, {
    status: "ok",
    deploymentMode: state?.deploymentMode ?? "local_trusted",
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CatalogCard
          item={item}
          installedByPackageName={installed}
          installedStateReady={state?.ready}
          installedStateError={state?.error}
          onRetryInstalledState={state?.retry}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("CatalogCard (v3 chrome)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the item name and description", () => {
    renderCard(makeItem());
    expect(screen.getByText("/office-hours")).toBeInTheDocument();
    expect(
      screen.getByText(/YC-style product interrogation/)
    ).toBeInTheDocument();
  });

  it("renders TypeChip in the corner with the uppercase type label", () => {
    renderCard(makeItem({ type: "skill" }));
    expect(screen.getByText("SKILL")).toBeInTheDocument();
  });

  it("shows the verified-blue checkmark when trust.tier='verified'", () => {
    const { container } = renderCard(
      makeItem({ trust: { tier: "verified", source: "x" } })
    );
    expect(
      container.querySelector('[data-testid="verified-check"]')
    ).toBeTruthy();
  });

  it("does NOT show the verified checkmark for community items", () => {
    const { container } = renderCard(
      makeItem({ trust: { tier: "community", source: "x" } })
    );
    expect(
      container.querySelector('[data-testid="verified-check"]')
    ).toBeNull();
  });

  it("does NOT show the verified checkmark for unverified items", () => {
    const { container } = renderCard(
      makeItem({ trust: { tier: "unverified", source: "x" } })
    );
    expect(
      container.querySelector('[data-testid="verified-check"]')
    ).toBeNull();
  });

  it("renders the github source as 'owner/repo'", () => {
    renderCard(makeItem());
    expect(screen.getByText("garrytan/gstack")).toBeInTheDocument();
  });

  it("shows the provider logo instead of the large type icon when provider metadata exists", () => {
    renderCard(
      makeItem({
        provider: {
          id: "gstack",
          name: "Garry Tan",
          logoUrl: "https://github.com/garrytan.png",
          fallbackInitials: "GT",
        },
      })
    );

    expect(screen.getByRole("img", { name: "Garry Tan logo" })).toHaveClass(
      "size-12"
    );
    expect(screen.queryByTestId("catalog-type-avatar")).not.toBeInTheDocument();
    expect(screen.getByText(/by Garry Tan/)).toBeInTheDocument();
  });

  it("renders an Install button when not yet installed", () => {
    renderCard(
      makeItem({
        type: "plugin",
        npm: { packageName: "@a/b", version: "1.0.0" },
      })
    );
    expect(
      screen.getByRole("button", { name: /install/i })
    ).toBeInTheDocument();
  });

  it("does not offer plugin installation in cloud mode", () => {
    renderCard(
      makeItem({
        type: "plugin",
        npm: { packageName: "@a/b", version: "1.0.0" },
      }),
      undefined,
      { deploymentMode: "cloud_auth" }
    );
    expect(screen.getByText("Unavailable on AoA Cloud")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^install$/i })
    ).not.toBeInTheDocument();
  });

  it("blocks plugin installation while company install state is unresolved", () => {
    renderCard(
      makeItem({
        type: "plugin",
        npm: { packageName: "@a/b", version: "1.0.0" },
      }),
      undefined,
      { ready: false }
    );
    expect(
      screen.getByRole("button", { name: /checking installation/i })
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /^install$/i })
    ).not.toBeInTheDocument();
  });

  it("surfaces install-state failure and offers a retry", async () => {
    const retry = vi.fn();
    renderCard(
      makeItem({
        type: "plugin",
        npm: { packageName: "@a/b", version: "1.0.0" },
      }),
      undefined,
      { ready: false, error: true, retry }
    );
    await userEvent.click(
      screen.getByRole("button", { name: /retry install check/i })
    );
    expect(retry).toHaveBeenCalledOnce();
  });

  it("renders an Installed badge when the plugin is ready", () => {
    const item = makeItem({
      type: "plugin",
      npm: { packageName: "@a/b", version: "1.0.0" },
    });
    const installed = new Map<string, PluginRecord>([
      [
        "@a/b",
        {
          id: "p1",
          packageName: "@a/b",
          status: "ready",
        } as unknown as PluginRecord,
      ],
    ]);
    renderCard(item, installed);
    expect(screen.getByText("Installed")).toBeInTheDocument();
  });

  it("renders a Pending badge when the plugin is loading", () => {
    const item = makeItem({
      type: "plugin",
      npm: { packageName: "@a/b", version: "1.0.0" },
    });
    const installed = new Map<string, PluginRecord>([
      [
        "@a/b",
        {
          id: "p1",
          packageName: "@a/b",
          status: "loading",
        } as unknown as PluginRecord,
      ],
    ]);
    renderCard(item, installed);
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("renders the accessible cloud-blocked badge instead of Pending", () => {
    const item = makeItem({
      type: "plugin",
      npm: { packageName: "@a/b", version: "1.0.0" },
    });
    const installed = new Map<string, PluginRecord>([
      [
        "@a/b",
        {
          id: "p1",
          packageName: "@a/b",
          status: "error",
          statusReasonCode: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
        } as unknown as PluginRecord,
      ],
    ]);
    renderCard(item, installed);
    expect(screen.getByText("Blocked on AoA Cloud")).toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
  });

  it("preserves slashes in the detail-page link (splat route)", () => {
    const item = makeItem({
      id: "plugin:aoa-curated/slack",
      type: "plugin",
      name: "slack",
    });
    renderCard(item);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(
      "/marketplace/plugin/aoa-curated/slack"
    );
  });

  it("clicking Install does not navigate to the detail page (preventDefault)", async () => {
    const user = userEvent.setup();
    const { container } = renderCard(makeItem({ type: "skill" }));
    const link = container.querySelector("a") as HTMLAnchorElement;
    const linkClickSpy = vi.fn();
    link.addEventListener("click", linkClickSpy);
    const btn = screen.getByRole("button", { name: /install/i });
    await user.click(btn);
    // The link receives the click but the install button preventDefault'd it,
    // so the SPA navigation never fires. We assert by checking the click
    // event's defaultPrevented flag.
    const lastCall = linkClickSpy.mock.calls.at(-1);
    expect(lastCall?.[0]?.defaultPrevented).toBe(true);
  });

  it("uses StackedIcon for type='team'", () => {
    const { container } = renderCard(
      makeItem({ id: "team:x", type: "team", name: "team-x" })
    );
    expect(container.querySelectorAll("[data-stacked-layer]").length).toBe(3);
  });

  it("routes Default Crew through the company-resolving redirect and does not offer installation", () => {
    renderCard(
      makeItem({
        id: "team:aoa-curated/default-crew",
        type: "team",
        name: "AoA Default Crew",
      })
    );

    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/marketplace/team/aoa-curated/default-crew"
    );
    expect(screen.getByText("View crew")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /install/i })
    ).not.toBeInTheDocument();
  });
});
