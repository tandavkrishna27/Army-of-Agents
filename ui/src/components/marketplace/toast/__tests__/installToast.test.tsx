import { describe, it, expect, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { marketplaceApi } from "@/api/marketplace";

// ToastViewport's Link comes from @/lib/router which calls useCompany(); swap it
// out for the plain react-router-dom Link so no CompanyProvider is needed.
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, Link: actual.Link };
});
import { ToastProvider } from "../../../../context/ToastContext";
import { ToastViewport } from "../../../ToastViewport";
import { InstallToastProvider } from "../ToastProvider";
import { useInstallToast } from "../useInstallToast";

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>("@/api/marketplace");
  return {
    ...actual,
    marketplaceApi: { ...actual.marketplaceApi, getOperation: vi.fn() },
  };
});

let api: ReturnType<typeof useInstallToast>;
function Capture() {
  api = useInstallToast();
  return null;
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>
          <InstallToastProvider>
            <Capture />
            <ToastViewport />
          </InstallToastProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("install toast adapter", () => {
  it("show(installing) renders a sticky loading toast through the unified viewport", () => {
    setup();
    act(() => { api.show({ status: "installing", message: "Installing Slack" }); });
    expect(screen.getByText("Installing Slack")).toBeInTheDocument();
    expect(screen.getByTestId("toast-loading-rail")).toBeInTheDocument();
  });

  it("update flips the loading toast to success with an action link", () => {
    setup();
    let id = "";
    act(() => { id = api.show({ status: "installing", message: "Installing Slack" }); });
    act(() => {
      api.update(id, { status: "success", message: "Installed Slack", actionLabel: "View", actionTo: "/marketplace" });
    });
    expect(screen.getByText("Installed Slack")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View/ })).toBeInTheDocument();
  });

  it("update flips to a failure toast with detail", () => {
    setup();
    let id = "";
    act(() => { id = api.show({ status: "installing", message: "Installing Slack" }); });
    act(() => { api.update(id, { status: "failure", message: "Install failed", detail: "HTTP 500" }); });
    expect(screen.getByText("Install failed")).toBeInTheDocument();
    expect(screen.getByText("HTTP 500")).toBeInTheDocument();
  });

  it("trackOperation resolves the loading toast and invalidates queries on success", async () => {
    vi.mocked(marketplaceApi.getOperation).mockResolvedValue({ status: "success" } as any);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ToastProvider>
            <InstallToastProvider>
              <Capture />
              <ToastViewport />
            </InstallToastProvider>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    let id = "";
    act(() => { id = api.show({ status: "installing", message: "Installing Slack" }); });
    act(() => {
      api.trackOperation({
        toastId: id,
        companyId: "c1",
        operationId: "op-1",
        itemName: "Slack",
        invalidate: "plugins",
      });
    });
    await waitFor(() => expect(screen.getByText("Installed Slack")).toBeInTheDocument());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.plugins.all });
  });

  it("renders a truthful blocked toast with the policy link", async () => {
    vi.mocked(marketplaceApi.getOperation).mockResolvedValue({
      status: "failure",
      errorCode: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
      errorMessage:
        "Plugin execution is blocked on AoA Cloud until isolated workers are available",
      errorDocs: "/docs/guides/cloud-plugin-execution",
    } as any);
    setup();
    let id = "";
    act(() => {
      id = api.show({ status: "installing", message: "Installing Slack" });
    });
    act(() => {
      api.trackOperation({
        toastId: id,
        companyId: "c1",
        operationId: "op-blocked",
        itemName: "Slack",
        invalidate: "plugins",
      });
    });

    await waitFor(() =>
      expect(screen.getByText("Slack is blocked on AoA Cloud")).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /Read policy/ })).toHaveAttribute(
      "href",
      "/docs/guides/cloud-plugin-execution",
    );
  });

  it("useInstallToast no-ops outside the provider", () => {
    function NoopConsumer() {
      const { show, update, dismiss } = useInstallToast();
      const id = show({ status: "installing", message: "test" });
      update(id, { message: "x" });
      dismiss();
      return null;
    }
    expect(() => render(<NoopConsumer />)).not.toThrow();
  });
});
