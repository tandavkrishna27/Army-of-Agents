import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON } from "@armyofagents/shared";
import type { ReactNode } from "react";

import { PluginDetailSlideOver } from "../PluginDetailSlideOver";
import type { InstalledPlugin } from "@/api/plugins";
import * as pluginsApi from "@/api/plugins";
import { ApiError } from "@/api/client";
import { ToastProvider } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

// Hoist spy so it can be referenced both inside vi.mock and in test bodies.
const { retryActivationSpy } = vi.hoisted(() => ({
  retryActivationSpy: vi.fn(),
}));

// Mock all named exports from plugins API.
vi.mock("@/api/plugins", async () => {
  const actual = await vi.importActual<typeof import("@/api/plugins")>(
    "@/api/plugins"
  );
  return {
    ...actual,
    patchPluginSettings: vi.fn(),
    getPluginConfig: vi.fn().mockResolvedValue({ configJson: {} }),
    upgradePlugin: vi.fn(),
    pluginsApi: {
      ...(actual.pluginsApi ?? {}),
      retryActivation: retryActivationSpy,
    },
  };
});

// CapabilityDeltaModal owns its API mutations; these controls model its completed
// approve/cancel callbacks so this component's cache handling can be exercised.
vi.mock("../CapabilityDeltaModal", () => ({
  CapabilityDeltaModal: ({
    onApproved,
    onCancelled,
  }: {
    onApproved: () => void;
    onCancelled: () => void;
  }) => (
    <>
      <button type="button" onClick={onApproved}>
        Complete capability approval
      </button>
      <button type="button" onClick={onCancelled}>
        Complete capability cancellation
      </button>
    </>
  ),
}));

// PluginConfigForm may import things needing extra mocks — stub it too.
vi.mock("../PluginConfigForm", () => ({
  PluginConfigForm: () => <div data-testid="plugin-config-form" />,
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: "plugin-123",
    companyId: "company-1",
    catalogItemId: null,
    pluginKey: "test-plugin",
    packageName: "@test/plugin",
    version: "1.0.0",
    status: "ready",
    categories: [],
    manifest: {
      displayName: "Test Plugin",
      description: "A test plugin",
      capabilities: [],
    },
    lastError: null,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    enabled: true,
    configJson: {},
    ...overrides,
  };
}

function wrap(
  node: ReactNode,
  deploymentMode: "local_trusted" | "cloud_auth" = "local_trusted"
) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  qc.setQueryData(queryKeys.health, { status: "ok", deploymentMode });
  return {
    queryClient: qc,
    ...render(
      <QueryClientProvider client={qc}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    ),
  };
}

function expectCompanyPluginStateInvalidated(
  invalidateQueries: ReturnType<typeof vi.spyOn>
) {
  expect(invalidateQueries).toHaveBeenCalledWith({
    queryKey: ["company-plugins", "company-1"],
  });
  expect(invalidateQueries).toHaveBeenCalledWith({
    queryKey: queryKeys.plugins.companyList("company-1"),
  });
  expect(invalidateQueries).toHaveBeenCalledWith({
    queryKey: queryKeys.plugins.uiContributions("company-1"),
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("PluginDetailSlideOver — Retry activation button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Retry activation" button when plugin.status === "error"', () => {
    const plugin = makePlugin({ status: "error" });
    wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={plugin}
        pendingUpdate={undefined}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: /retry activation/i })
    ).toBeInTheDocument();
  });

  it('does NOT show "Retry activation" button when plugin.status === "ready"', () => {
    const plugin = makePlugin({ status: "ready" });
    wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={plugin}
        pendingUpdate={undefined}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.queryByRole("button", { name: /retry activation/i })
    ).not.toBeInTheDocument();
  });

  it("shows the cloud policy state and hides futile lifecycle actions", () => {
    const plugin = makePlugin({
      status: "error",
      statusReasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON,
      lastError:
        "Plugin execution is blocked on AoA Cloud until isolated workers are available",
    });
    wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={plugin}
        pendingUpdate={undefined}
        onClose={vi.fn()}
      />
    );

    expect(screen.getAllByText("Blocked on AoA Cloud").length).toBeGreaterThan(
      0
    );
    expect(
      screen.getByRole("link", {
        name: /read the cloud plugin execution policy/i,
      })
    ).toHaveAttribute("href", "/docs/guides/cloud-plugin-execution");
    expect(
      screen.queryByRole("button", { name: /retry activation/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /enable for this company/i })
    ).not.toBeInTheDocument();
  });

  it("uses deployment mode to hide futile lifecycle actions before durable state is reconciled", () => {
    const plugin = makePlugin({
      status: "error",
      statusReasonCode: null,
      lastError: "Previous worker failure",
    });
    wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={plugin}
        pendingUpdate={undefined}
        onClose={vi.fn()}
      />,
      "cloud_auth"
    );

    expect(screen.getAllByText("Blocked on AoA Cloud").length).toBeGreaterThan(
      0
    );
    expect(
      screen.queryByRole("button", { name: /retry activation/i })
    ).not.toBeInTheDocument();
  });

  it("shows lastError message when plugin has status error and a lastError", () => {
    const plugin = makePlugin({
      status: "error",
      lastError: "Worker crashed: ECONNREFUSED",
    });
    wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={plugin}
        pendingUpdate={undefined}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByText("Worker crashed: ECONNREFUSED")
    ).toBeInTheDocument();
  });

  it('calls retryActivation with the plugin id when "Retry activation" is clicked', async () => {
    retryActivationSpy.mockResolvedValue({ ok: true });

    const plugin = makePlugin({ status: "error" });
    wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={plugin}
        pendingUpdate={undefined}
        onClose={vi.fn()}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: /retry activation/i })
    );

    await waitFor(() =>
      expect(retryActivationSpy).toHaveBeenCalledWith("plugin-123")
    );
  });

  it("shows retry error message when plugin is in error state and retryActivation rejects", async () => {
    retryActivationSpy.mockRejectedValue(new Error("Network error"));

    const plugin = makePlugin({ status: "error" });
    wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={plugin}
        pendingUpdate={undefined}
        onClose={vi.fn()}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: /retry activation/i })
    );

    await waitFor(() =>
      expect(screen.getByText("Network error")).toBeInTheDocument()
    );
  });

  it("renders a normal member view-only without settings or lifecycle actions", () => {
    wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={makePlugin({ status: "error" })}
        pendingUpdate={undefined}
        onClose={vi.fn()}
        canManage={false}
      />
    );

    expect(
      screen.queryByRole("button", { name: "settings" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /retry activation/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /disable for this company/i })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/require an instance administrator/i)
    ).toBeInTheDocument();
  });

  it("surfaces a configuration fetch failure instead of an empty editable form", async () => {
    vi.mocked(pluginsApi.getPluginConfig).mockRejectedValueOnce(
      new Error("Configuration access denied")
    );
    wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={makePlugin()}
        pendingUpdate={undefined}
        onClose={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Configuration access denied"
    );
    expect(screen.queryByTestId("plugin-config-form")).not.toBeInTheDocument();
  });
});

describe("PluginDetailSlideOver lifecycle cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates all company plugin state after enabling or disabling", async () => {
    vi.mocked(pluginsApi.patchPluginSettings).mockResolvedValue({});
    const { queryClient } = wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={makePlugin({ enabled: false })}
        pendingUpdate={undefined}
        onClose={vi.fn()}
      />
    );
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", { name: /enable for this company/i })
    );

    await waitFor(() =>
      expectCompanyPluginStateInvalidated(invalidateQueries)
    );
  });

  it("invalidates all company plugin state after retry activation succeeds", async () => {
    retryActivationSpy.mockResolvedValue({});
    const { queryClient } = wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={makePlugin({ status: "error" })}
        pendingUpdate={undefined}
        onClose={vi.fn()}
      />
    );
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", { name: /retry activation/i })
    );

    await waitFor(() =>
      expectCompanyPluginStateInvalidated(invalidateQueries)
    );
  });

  it("invalidates all company plugin state after a ready upgrade succeeds", async () => {
    vi.mocked(pluginsApi.upgradePlugin).mockResolvedValue({
      status: "ready",
      version: "2.0.0",
    });
    const { queryClient } = wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={makePlugin()}
        pendingUpdate={{ latestVersion: "2.0.0" } as any}
        onClose={vi.fn()}
      />
    );
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.click(screen.getByRole("button", { name: /upgrade to/i }));

    await waitFor(() =>
      expectCompanyPluginStateInvalidated(invalidateQueries)
    );
  });

  it("invalidates all company plugin state when a lifecycle error is cloud-blocked", async () => {
    vi.mocked(pluginsApi.patchPluginSettings).mockRejectedValue(
      new ApiError("blocked", 503, { code: "PLUGIN_WORKER_BLOCKED_IN_CLOUD" })
    );
    const { queryClient } = wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={makePlugin()}
        pendingUpdate={undefined}
        onClose={vi.fn()}
      />
    );
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", { name: /disable for this company/i })
    );

    await waitFor(() =>
      expectCompanyPluginStateInvalidated(invalidateQueries)
    );
  });

  it("invalidates all company plugin state after capability upgrade approval", async () => {
    vi.mocked(pluginsApi.upgradePlugin).mockResolvedValue({
      status: "upgrade_pending",
      version: "2.0.0",
      delta: ["storage.write"],
    });
    const { queryClient } = wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={makePlugin()}
        pendingUpdate={{ latestVersion: "2.0.0" } as any}
        onClose={vi.fn()}
      />
    );
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.click(screen.getByRole("button", { name: /upgrade to/i }));
    await userEvent.click(
      await screen.findByRole("button", { name: /complete capability approval/i })
    );

    await waitFor(() =>
      expectCompanyPluginStateInvalidated(invalidateQueries)
    );
  });

  it("invalidates all company plugin state after capability upgrade cancellation", async () => {
    vi.mocked(pluginsApi.upgradePlugin).mockResolvedValue({
      status: "upgrade_pending",
      version: "2.0.0",
      delta: ["storage.write"],
    });
    const { queryClient } = wrap(
      <PluginDetailSlideOver
        companyId="company-1"
        plugin={makePlugin()}
        pendingUpdate={{ latestVersion: "2.0.0" } as any}
        onClose={vi.fn()}
      />
    );
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.click(screen.getByRole("button", { name: /upgrade to/i }));
    await userEvent.click(
      await screen.findByRole("button", {
        name: /complete capability cancellation/i,
      })
    );

    await waitFor(() =>
      expectCompanyPluginStateInvalidated(invalidateQueries)
    );
  });
});
