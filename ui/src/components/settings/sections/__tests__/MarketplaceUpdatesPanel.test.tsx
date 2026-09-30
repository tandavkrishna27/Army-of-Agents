import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { marketplaceApi, type PendingUpdate } from "@/api/marketplace";
import { MarketplaceUpdatesPanel } from "../MarketplaceUpdatesPanel";
import { queryKeys } from "@/lib/queryKeys";
import { healthApi } from "@/api/health";

const mutateAsync = vi.fn();
let pendingUpdates: PendingUpdate[] = [];

const toastMocks = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Company" },
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: toastMocks.pushToast }),
}));

vi.mock("@/hooks/usePendingUpdates", () => ({
  usePendingUpdates: () => ({ data: pendingUpdates, isLoading: false }),
  useDismissUpdate: () => ({ mutateAsync }),
}));

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>(
    "@/api/marketplace"
  );
  return {
    ...actual,
    marketplaceApi: {
      ...actual.marketplaceApi,
      applyUpdate: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("@/api/health", () => ({
  healthApi: { get: vi.fn() },
}));

vi.mock("@/components/marketplace/SnapshotUpdateModal", () => ({
  SnapshotUpdateModal: ({ itemName }: { itemName: string }) => (
    <div role="dialog">Reviewing {itemName}</div>
  ),
}));

vi.mock("@/components/settings/CapabilityDeltaModal", () => ({
  CapabilityDeltaModal: ({
    pluginName,
    delta,
  }: {
    pluginName: string;
    delta: string[];
  }) => (
    <div role="dialog">
      New permissions required for {pluginName}: {delta.join(", ")}
    </div>
  ),
}));

function update(overrides: Partial<PendingUpdate>): PendingUpdate {
  return {
    id: "update-1",
    companyId: "company-1",
    catalogItemId: "plugin:test/github",
    catalogItemName: "GitHub Issues",
    itemType: "plugin",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    status: "pending",
    detectedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function renderPanel(
  options: {
    deploymentMode?: "local_trusted" | "cloud_auth";
    seedHealth?: boolean;
  } = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  if (options.seedHealth !== false) {
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: options.deploymentMode ?? "local_trusted",
    });
  }
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MarketplaceUpdatesPanel />
    </QueryClientProvider>
  );
  return { ...view, queryClient };
}

describe("MarketplaceUpdatesPanel", () => {
  beforeEach(() => {
    pendingUpdates = [];
    mutateAsync.mockReset();
    toastMocks.pushToast.mockReset();
    vi.mocked(marketplaceApi.applyUpdate).mockClear();
    vi.mocked(healthApi.get).mockReset();
    vi.mocked(healthApi.get).mockResolvedValue({
      status: "ok",
      deploymentMode: "local_trusted",
    });
  });

  it("renders the empty state when no updates are pending", () => {
    renderPanel();

    expect(
      screen.getByText("All marketplace items are up to date")
    ).toBeInTheDocument();
  });

  it("applies plugin updates directly", async () => {
    pendingUpdates = [update({})];

    renderPanel();

    expect(screen.getByText("GitHub Issues")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Update GitHub Issues" })
    );

    await waitFor(() =>
      expect(marketplaceApi.applyUpdate).toHaveBeenCalledWith(
        "company-1",
        "update-1"
      )
    );
  });

  it("hides plugin apply in cloud mode while leaving non-plugin apply available", async () => {
    pendingUpdates = [
      update({}),
      update({
        id: "agent-update",
        itemType: "agent",
        catalogItemName: "Senior Engineer",
      }),
    ];
    renderPanel({ deploymentMode: "cloud_auth" });

    expect(
      screen.queryByRole("button", { name: "Update GitHub Issues" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Plugin updates are unavailable on AoA Cloud.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update Senior Engineer" })
    ).toBeInTheDocument();
  });

  it("fails closed while deployment policy is unresolved", () => {
    pendingUpdates = [update({})];
    vi.mocked(healthApi.get).mockReturnValue(new Promise(() => {}));
    renderPanel({ seedHealth: false });

    expect(
      screen.queryByRole("button", { name: "Update GitHub Issues" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/unavailable until deployment policy is verified/i)
    ).toBeInTheDocument();
  });

  it("stays fail-closed when deployment policy lookup errors", async () => {
    pendingUpdates = [update({})];
    vi.mocked(healthApi.get).mockRejectedValue(new Error("health unavailable"));
    renderPanel({ seedHealth: false });

    expect(
      await screen.findByText(
        /unavailable until deployment policy is verified/i
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update GitHub Issues" })
    ).not.toBeInTheDocument();
  });

  it("opens snapshot review for non-plugin updates", async () => {
    pendingUpdates = [
      update({
        id: "agent-update-1",
        catalogItemId: "agent:test/senior-engineer",
        catalogItemName: "Senior Engineer",
        itemType: "agent",
      }),
    ];

    renderPanel();

    await userEvent.click(
      screen.getByRole("button", { name: "Review Senior Engineer" })
    );

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Reviewing Senior Engineer"
    );
  });

  // ── F3: `/apply` handles agents and skills now; the button must reach it ──
  //
  // `UpdateCard` used to render "Update" only for plugins, so the agent branch
  // of `/apply` was unreachable from the UI: an agent with nothing to review
  // still had to go through the merge modal.

  const agentUpdate = (overrides: Partial<PendingUpdate> = {}) =>
    update({
      id: "agent-update-1",
      catalogItemId: "agent:test/senior-engineer",
      catalogItemName: "Senior Engineer",
      itemType: "agent",
      ...overrides,
    });

  it("offers one-click apply for a PENDING agent update", async () => {
    pendingUpdates = [agentUpdate()];
    renderPanel();

    await userEvent.click(
      screen.getByRole("button", { name: "Update Senior Engineer" })
    );

    await waitFor(() =>
      expect(marketplaceApi.applyUpdate).toHaveBeenCalledWith(
        "company-1",
        "agent-update-1"
      )
    );
  });

  // THE DISCRIMINATOR: a `conflict` row is one whose local copy diverges. Its
  // `/apply` answers 409 by design, so offering the button would be a dead end.
  it("offers ONLY review for a CONFLICT agent update", async () => {
    pendingUpdates = [agentUpdate({ status: "conflict" })];
    renderPanel();

    expect(
      screen.queryByRole("button", { name: "Update Senior Engineer" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Review Senior Engineer" })
    ).toBeInTheDocument();
  });

  it("falls through to review when apply reports the agent is customized", async () => {
    pendingUpdates = [agentUpdate()];
    vi.mocked(marketplaceApi.applyUpdate).mockRejectedValueOnce(
      new ApiError(
        "Agent instructions are customized. Manual merge required.",
        409,
        {
          code: "AGENT_INSTRUCTIONS_CUSTOMIZED",
        }
      )
    );

    renderPanel();

    await userEvent.click(
      screen.getByRole("button", { name: "Update Senior Engineer" })
    );

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Reviewing Senior Engineer"
    );
  });

  // The discriminator: `/apply` also answers 409 for a row that is simply no
  // longer pending. That is not a merge situation and has no diff to show, so
  // it must surface as an error rather than opening an empty review.
  it("does NOT open review for a bare stale-status 409", async () => {
    pendingUpdates = [agentUpdate()];
    vi.mocked(marketplaceApi.applyUpdate).mockRejectedValueOnce(
      new ApiError("Update is not pending (current: applied)", 409, {
        error: "Update is not pending (current: applied)",
      })
    );

    renderPanel();

    await userEvent.click(
      screen.getByRole("button", { name: "Update Senior Engineer" })
    );

    await waitFor(() =>
      expect(toastMocks.pushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Failed to apply update",
          tone: "error",
        })
      )
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows capability approval when a plugin update introduces new permissions", async () => {
    pendingUpdates = [update({})];
    vi.mocked(marketplaceApi.applyUpdate).mockResolvedValueOnce({
      ok: true,
      pluginId: "plugin-1",
      version: "1.1.0",
      status: "upgrade_pending",
      delta: ["storage.write"],
    } as any);

    renderPanel();

    await userEvent.click(
      screen.getByRole("button", { name: "Update GitHub Issues" })
    );

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "New permissions required for GitHub Issues: storage.write"
    );
  });

  it("shows instance-admin requirement copy when applying a plugin update returns 403", async () => {
    pendingUpdates = [update({})];
    vi.mocked(marketplaceApi.applyUpdate).mockRejectedValueOnce(
      new ApiError("Instance admin access required", 403, {
        error: "Instance admin access required",
      })
    );

    renderPanel();

    await userEvent.click(
      screen.getByRole("button", { name: "Update GitHub Issues" })
    );

    await waitFor(() =>
      expect(toastMocks.pushToast).toHaveBeenCalledWith({
        title: "Only instance admins can update plugins",
        body: "Ask an instance admin to apply the GitHub Issues plugin update.",
        tone: "error",
      })
    );
  });

  it("invalidates the plugin update cache after dismissing an update", async () => {
    pendingUpdates = [update({})];
    mutateAsync.mockResolvedValueOnce(undefined);
    const { queryClient } = renderPanel();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss GitHub Issues update" })
    );

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["marketplace-updates", "company-1"],
      })
    );
  });
});
