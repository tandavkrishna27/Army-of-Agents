import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { marketplaceApi, type PendingUpdate } from "@/api/marketplace";
import type { InstalledPlugin } from "@/api/plugins";
import { PluginsSection } from "../PluginsSection";
import * as pluginsApi from "@/api/plugins";
import { profileApi } from "@/api/profile";
import { queryKeys } from "@/lib/queryKeys";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/components/settings/PluginDetailSlideOver", () => ({
  PluginDetailSlideOver: () => <div data-testid="plugin-detail" />,
}));

vi.mock("@/api/plugins", async () => {
  const actual = await vi.importActual<typeof import("@/api/plugins")>(
    "@/api/plugins"
  );
  return {
    ...actual,
    listCompanyPlugins: vi.fn(),
  };
});

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>(
    "@/api/marketplace"
  );
  return {
    ...actual,
    marketplaceApi: {
      ...actual.marketplaceApi,
      getUpdates: vi.fn(),
      applyUpdate: vi.fn(),
    },
  };
});

vi.mock("@/api/profile", () => ({
  profileApi: { get: vi.fn() },
}));

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: "plugin-1",
    companyId: "company-1",
    catalogItemId: "plugin:aoa/github-issues",
    pluginKey: "github-issues",
    packageName: "@aoa/github-issues",
    version: "1.0.0",
    status: "ready",
    statusReasonCode: null,
    categories: ["issues"],
    manifest: {
      displayName: "GitHub Issues Sync",
      description: "Sync GitHub issues.",
      capabilities: ["issues.read"],
    },
    lastError: null,
    installedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    enabled: true,
    configJson: {},
    ...overrides,
  };
}

function update(overrides: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    id: "update-1",
    companyId: "company-1",
    catalogItemId: "plugin:aoa/github-issues",
    catalogItemName: "GitHub Issues Sync",
    itemType: "plugin",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    status: "pending",
    detectedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function renderSection(
  deploymentMode: "local_trusted" | "cloud_auth" = "local_trusted"
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(queryKeys.health, { status: "ok", deploymentMode });
  return render(
    <QueryClientProvider client={queryClient}>
      <PluginsSection />
    </QueryClientProvider>
  );
}

describe("PluginsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pluginsApi.listCompanyPlugins).mockResolvedValue([plugin()]);
    vi.mocked(marketplaceApi.getUpdates).mockResolvedValue([update()]);
    vi.mocked(marketplaceApi.applyUpdate).mockResolvedValue(undefined);
    vi.mocked(profileApi.get).mockResolvedValue({
      id: "admin-1",
      email: "admin@example.com",
      displayName: "Admin",
      avatarUrl: null,
      isInstanceAdmin: true,
      canManageInstanceSettings: true,
    });
  });

  it("lets users apply a pending plugin update directly from the plugin card", async () => {
    renderSection();

    const updateButton = await screen.findByRole("button", {
      name: "Update GitHub Issues Sync",
    });
    await userEvent.click(updateButton);

    await waitFor(() =>
      expect(marketplaceApi.applyUpdate).toHaveBeenCalledWith(
        "company-1",
        "update-1"
      )
    );
  });

  it("does not open the plugin detail when keyboard-applying a card update", async () => {
    renderSection();

    const updateButton = await screen.findByRole("button", {
      name: "Update GitHub Issues Sync",
    });
    updateButton.focus();
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(marketplaceApi.applyUpdate).toHaveBeenCalledWith(
        "company-1",
        "update-1"
      )
    );
    expect(screen.queryByTestId("plugin-detail")).not.toBeInTheDocument();
  });

  it("gives a normal member a view-only plugin card", async () => {
    vi.mocked(profileApi.get).mockResolvedValue({
      id: "member-1",
      email: "member@example.com",
      displayName: "Member",
      avatarUrl: null,
      isInstanceAdmin: false,
      canManageInstanceSettings: false,
    });
    renderSection();

    expect(
      await screen.findByRole("button", { name: "View GitHub Issues Sync" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update GitHub Issues Sync" })
    ).not.toBeInTheDocument();
  });

  it("shows the cloud block with guidance and no futile update action", async () => {
    vi.mocked(pluginsApi.listCompanyPlugins).mockResolvedValue([
      plugin({
        status: "error",
        statusReasonCode: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
        lastError:
          "Plugin execution is blocked on AoA Cloud until isolated workers are available",
      }),
    ]);
    renderSection();

    expect(await screen.findByText("Blocked on AoA Cloud")).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "Read the cloud plugin execution policy",
      })
    ).toHaveAttribute("href", "/docs/guides/cloud-plugin-execution");
    expect(
      screen.queryByRole("button", { name: "Update GitHub Issues Sync" })
    ).not.toBeInTheDocument();
  });

  it("hides update actions in cloud mode before durable state is reconciled", async () => {
    renderSection("cloud_auth");

    expect(await screen.findByText("Blocked on AoA Cloud")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update GitHub Issues Sync" })
    ).not.toBeInTheDocument();
  });
});
