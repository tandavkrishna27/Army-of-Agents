import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import { PackageInstallModal } from "../PackageInstallModal";
import { marketplaceApi } from "@/api/marketplace";
import { useCompany } from "@/context/CompanyContext";
import { ToastProvider } from "@/context/ToastContext";
import { InstallToastProvider } from "@/components/marketplace/toast/ToastProvider";
import { ToastViewport } from "@/components/ToastViewport";

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>("@/api/marketplace");
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
  useCompany: vi.fn(),
}));

const defaultCompanyCtx = {
  selectedCompanyId: "c1",
  companies: [{ id: "c1", name: "Acme", status: "active" }],
};

const pkg = {
  id: "anthropic/skills",
  name: "skills",
  sourceUrl: "https://github.com/anthropic/skills",
  memberItemIds: ["skill:a", "skill:b"],
  count: 2,
  verified: true,
  explicit: false,
  provider: {
    id: "anthropic",
    name: "Anthropic",
    fallbackInitials: "A",
    logoUrl: "https://github.com/anthropics.png",
  },
};

const memberItems = [
  { id: "skill:a", name: "A", type: "skill", description: "A skill", version: "1.0.0" },
  { id: "skill:b", name: "B", type: "skill", description: "B skill", version: "1.0.0" },
] as any;

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>
          <InstallToastProvider>
            {ui}
            <ToastViewport />
          </InstallToastProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PackageInstallModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCompany).mockReturnValue(defaultCompanyCtx as any);
  });

  it("posts packageId and catalogItemIds", async () => {
    vi.mocked(marketplaceApi.install).mockResolvedValueOnce({ operationId: "op-1", status: "pending" });
    vi.mocked(marketplaceApi.getOperation).mockResolvedValue({ status: "success" } as any);

    wrap(<PackageInstallModal pkg={pkg as any} memberItems={memberItems} open onOpenChange={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Install all 2 skills" }));

    await waitFor(() => {
      expect(marketplaceApi.install).toHaveBeenCalledWith("c1", {
        packageId: "anthropic/skills",
        catalogItemIds: ["skill:a", "skill:b"],
      });
    });
  });

  it("shows the provider logo in the modal", () => {
    wrap(<PackageInstallModal pkg={pkg as any} memberItems={memberItems} open onOpenChange={() => {}} />);
    expect(screen.getByRole("img", { name: "Anthropic logo" })).toBeInTheDocument();
  });

  it("resolves the install toast even after the modal unmounts", async () => {
    vi.mocked(marketplaceApi.install).mockResolvedValueOnce({ operationId: "op-1", status: "pending" });
    vi.mocked(marketplaceApi.getOperation).mockResolvedValue({
      id: "op-1",
      status: "success",
      createdAt: new Date().toISOString(),
      errorMessage: null,
    } as any);

    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <PackageInstallModal
          pkg={pkg as any}
          memberItems={memberItems}
          open
          onOpenChange={setOpen}
        />
      ) : (
        <div>Company Skills</div>
      );
    }

    wrap(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Install all 2 skills" }));

    await waitFor(() => expect(screen.getByText("Company Skills")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Installed skills")).toBeInTheDocument());
  });

  it("disables Install and shows no-company hint when there are no active companies", () => {
    vi.mocked(useCompany).mockReturnValue({ selectedCompanyId: null, companies: [] } as any);

    wrap(<PackageInstallModal pkg={pkg as any} memberItems={memberItems} open onOpenChange={() => {}} />);

    expect(
      screen.getByText(/No organization available — create or join a company to install skills\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Install all/ })).toBeDisabled();
  });

  it("enables Install when selectedCompanyId is null but 2+ active companies exist (defaults to first active)", async () => {
    vi.mocked(useCompany).mockReturnValue({
      selectedCompanyId: null,
      companies: [
        { id: "c1", name: "Acme", status: "active" },
        { id: "c2", name: "Beta", status: "active" },
      ],
    } as any);

    wrap(<PackageInstallModal pkg={pkg as any} memberItems={memberItems} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Install all/i })).not.toBeDisabled();
    });
  });
});
