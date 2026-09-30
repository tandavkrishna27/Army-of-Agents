import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { PluginInstallModal } from "../PluginInstallModal";
import { ToastProvider } from "@/context/ToastContext";
import { InstallToastProvider } from "@/components/marketplace/toast/ToastProvider";
import { ToastViewport } from "@/components/ToastViewport";
import { SLACK_PLUGIN } from "@/__tests__/__fixtures__/marketplace-catalog";
import { marketplaceApi } from "@/api/marketplace";
import { queryKeys } from "@/lib/queryKeys";

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

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "c1",
    companies: [{ id: "c1", name: "Acme", status: "active" }],
  }),
}));

function wrap(
  node: ReactNode,
  deploymentMode: "local_trusted" | "cloud_auth" = "local_trusted"
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(queryKeys.health, { status: "ok", deploymentMode });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>
          <InstallToastProvider>
            {node}
            <ToastViewport />
          </InstallToastProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("PluginInstallModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders capabilities + version + trust badge", () => {
    wrap(
      <PluginInstallModal item={SLACK_PLUGIN} open onOpenChange={() => {}} />
    );
    expect(screen.getByText("Install Slack")).toBeInTheDocument();
    expect(screen.getByText("companies.read")).toBeInTheDocument();
    expect(screen.getByText("issues.read")).toBeInTheDocument();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("Company-scoped")).toBeInTheDocument();
  });

  it("on Install click: closes modal + shows installing toast + POSTs install", async () => {
    vi.mocked(marketplaceApi.install).mockResolvedValueOnce({
      operationId: "op-1",
      status: "pending",
    });
    const onOpenChange = vi.fn();
    wrap(
      <PluginInstallModal
        item={SLACK_PLUGIN}
        open
        onOpenChange={onOpenChange}
      />
    );

    // Check consent checkbox first — required before Install is enabled
    await userEvent.click(screen.getByRole("checkbox"));

    // The Cancel button is variant=outline; the Install button is the primary one
    const installBtn = screen.getByRole("button", { name: "Install" });
    await userEvent.click(installBtn);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(marketplaceApi.install).toHaveBeenCalledWith("c1", {
      catalogItemId: SLACK_PLUGIN.id,
    });
    await waitFor(() =>
      expect(screen.getByText(/Installing Slack/)).toBeInTheDocument()
    );
  });

  it("on install API failure: shows failure toast", async () => {
    vi.mocked(marketplaceApi.install).mockRejectedValueOnce(
      new Error("503 Service Unavailable")
    );
    wrap(
      <PluginInstallModal item={SLACK_PLUGIN} open onOpenChange={() => {}} />
    );

    // Check consent checkbox first — required before Install is enabled
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() =>
      expect(screen.getByText(/Failed to start install/)).toBeInTheDocument()
    );
    expect(screen.getByText("503 Service Unavailable")).toBeInTheDocument();
  });

  it("fails closed and does not call install in cloud mode", async () => {
    wrap(
      <PluginInstallModal item={SLACK_PLUGIN} open onOpenChange={() => {}} />,
      "cloud_auth"
    );

    const installButton = screen.getByRole("button", {
      name: "Unavailable on AoA Cloud",
    });
    expect(installButton).toBeDisabled();
    await userEvent.click(installButton);
    expect(marketplaceApi.install).not.toHaveBeenCalled();
  });

  describe("capability consent gate", () => {
    it("Install button is disabled until consent checkbox is checked (SLACK_PLUGIN has capabilities)", async () => {
      wrap(
        <PluginInstallModal item={SLACK_PLUGIN} open onOpenChange={() => {}} />
      );
      const installBtn = screen.getByRole("button", { name: "Install" });
      expect(installBtn).toBeDisabled();
    });

    it("Install button is enabled after checking the consent checkbox", async () => {
      wrap(
        <PluginInstallModal item={SLACK_PLUGIN} open onOpenChange={() => {}} />
      );
      const installBtn = screen.getByRole("button", { name: "Install" });
      expect(installBtn).toBeDisabled();

      // The consent checkbox — find it by its label text fragment
      const checkbox = screen.getByRole("checkbox");
      await userEvent.click(checkbox);

      expect(installBtn).not.toBeDisabled();
    });

    it("Install button is NOT disabled when item has no capabilities", () => {
      const noCapItem = { ...SLACK_PLUGIN, capabilities: [] };
      wrap(
        <PluginInstallModal item={noCapItem} open onOpenChange={() => {}} />
      );
      const installBtn = screen.getByRole("button", { name: "Install" });
      expect(installBtn).not.toBeDisabled();
    });
  });

  it("resolves toast to success when component stays mounted after modal closes", async () => {
    vi.mocked(marketplaceApi.install).mockResolvedValueOnce({
      operationId: "op-success",
      status: "pending",
    });
    vi.mocked(marketplaceApi.getOperation).mockResolvedValueOnce({
      id: "op-success",
      status: "success",
      // createdAt is set 10 s in the future relative to test execution time so
      // that `new Date(data.createdAt) > openedAt.current` (the component's
      // mount timestamp captured in useOperationStatus's stale-guard) always
      // holds true.  The +10_000 ms offset is intentional: it exceeds any
      // realistic gap between component mount and mock resolution, making the
      // stale-operation guard deterministic across slow CI machines.
      // Note: vi.useFakeTimers() would make this exact, but conflicts with
      // userEvent's internal timer usage in this test suite; the offset
      // approach is the accepted trade-off here.
      createdAt: new Date(Date.now() + 10_000).toISOString(),
      errorMessage: null,
    });

    const onOpenChange = vi.fn();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    qc.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "local_trusted",
    });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ToastProvider>
            <InstallToastProvider>
              <PluginInstallModal
                item={SLACK_PLUGIN}
                open
                onOpenChange={onOpenChange}
              />
              <ToastViewport />
            </InstallToastProvider>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Check consent checkbox first — required before Install is enabled
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    // Simulate parent keeping component mounted with open=false (the correct parent behavior)
    rerender(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ToastProvider>
            <InstallToastProvider>
              <PluginInstallModal
                item={SLACK_PLUGIN}
                open={false}
                onOpenChange={onOpenChange}
              />
              <ToastViewport />
            </InstallToastProvider>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(
      () => expect(screen.getByText(/Installed Slack/)).toBeInTheDocument(),
      { timeout: 4000 }
    );
  });
});
